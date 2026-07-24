import { runFullScan, runHotSetScan, getCurrentSnapshot } from './scanLoop';
import { clearUniverseCache } from './engine/proTradeScannerApi';
import { isUniverseFallback, clearUniverseCache as clearUniverseCacheClient, fetchSnapshots } from './alpacaClient';
import { alpacaBarStream } from './alpacaBarStream';
import { getState, setState, saveState, applyDayRoll } from './stateStore';
import { monitorPaperTrades } from './engine/monitorTrades';
import { buildPaperTrade, canPaperTradeRow } from './engine/buildPaperTrade';
import { isTideBlocked } from './engine/isTideBlocked';
import { checkGroupCircuitBreaker, checkStrategyCircuitBreaker, checkDailyLossLimit, recordGroupTradeResult, recordTradeResult } from './riskManager';
import { checkSectorConcentration, checkPortfolioBeta } from './portfolioRisk';
import { getPaperAccount, getPaperPositions, placePaperBracketOrder, closePaperPosition, closeAllPaperPositions, syncPartialAndBreakeven, awaitEntryFill, getRecentFilledOrders } from './alpacaBroker';
import { env } from './env';
import { emit } from './httpServer';
import { loadTrades, saveTrades, appendLedger } from './tradeStore';
import type { PaperTrade } from './types';

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function etMinutes(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function isMarketHours(): boolean {
  const mins = etMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Scan window starts pre-market so the dashboard builds the tape before the open.
// This is display only — trading (executor + monitor) stays gated to isMarketHours,
// so no entries fire before 9:30 ET.
const PREMARKET_SCAN_START_MIN = 8 * 60; // 08:00 ET — pre-market scan begins
function isScanWindow(): boolean {
  const mins = etMinutes();
  return mins >= PREMARKET_SCAN_START_MIN && mins < 16 * 60;
}

function isEODWindow(): boolean {
  const mins = etMinutes();
  return mins >= 15 * 60 + 50; // no upper bound — eodFiredDate guard prevents double-fire
}

// Milliseconds until 8:30 AM ET. Returns 0 if already past 8:30.
function msUntil830ET(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  const s = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', second: '2-digit' }), 10);
  const nowSecs = h * 3600 + m * 60 + s;
  const targetSecs = 8 * 3600 + 30 * 60;
  if (nowSecs >= targetSecs) return 0;
  return (targetSecs - nowSecs) * 1000;
}

let fullScanRunning = false;
let hotScanRunning = false;
let monitorRunning = false;
let accountBalance = 100_000;

async function syncAccount(): Promise<void> {
  try {
    const account = await getPaperAccount();
    accountBalance = parseFloat(account.equity);
  } catch (err) {
    console.warn('[scheduler] account sync failed:', (err as Error).message);
  }
}

async function monitorLoop(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const snapshot = getCurrentSnapshot();
    if (!snapshot) return;

    const trades = loadTrades();
    const openTrades = trades.filter((t: { status: string }) => t.status === 'Open');
    if (!openTrades.length) return;

    const { trades: updated, changed } = monitorPaperTrades(trades, snapshot.rows);
    if (!changed) return;

    // Record closed trades to risk state
    for (let i = 0; i < trades.length; i++) {
      const before = trades[i];
      const after = updated[i];
      // 1R partial fired: mirror it at the broker — bank half, move the stop to
      // breakeven on the runner. Async best-effort; internal ledger is the truth.
      if (before.status === 'Open' && after.status === 'Open' && !before.partialExitAt && after.partialExitAt) {
        emit('trade_partial', after);
        appendLedger('trade_partial', after);
        console.log(`[monitor] ${after.symbol} 1R partial — banked $${after.realizedPnl?.toFixed(2)} (${after.partialQty} sh), stop → BE`);
        if (after.direction !== 'NEUTRAL') {
          syncPartialAndBreakeven({
            symbol: after.symbol,
            direction: after.direction as 'BULL' | 'BEAR',
            entry: after.entry,
            target2: after.target2 || after.target,
          }).catch((err: Error) =>
            console.warn(`[alpaca] 1R partial sync failed ${after.symbol}:`, err.message),
          );
        }
      }
      if (before.status === 'Open' && after.status === 'Closed' && after.pnl !== undefined) {
        emit('trade_closed', after);
        console.log(`[monitor] ${after.symbol} closing — ${after.outcome} (planned pnl=$${after.pnl?.toFixed(2)}), reconciling actual fill…`);
        // Close at the broker and reconcile: re-book this trade's exit at Alpaca's
        // ACTUAL fill price, then record P&L to risk state from the real number.
        // Risk-state recording is deferred into the callback so the daily P&L that
        // circuit breakers see is the real one, not the monitor's planned estimate.
        void (async () => {
          const fill = await closePaperPosition(after.symbol).catch(() => null);
          const ts = loadTrades();
          const idx = ts.findIndex((t) => t.id === after.id);
          let finalPnl = after.pnl ?? 0;
          if (fill && fill.filled && fill.avgPrice > 0 && idx !== -1) {
            const t = ts[idx];
            const remainingQty = t.quantity - (t.partialQty ?? 0);
            const move = t.direction === 'BEAR' ? (t.entry - fill.avgPrice) : (fill.avgPrice - t.entry);
            finalPnl = Number((move * remainingQty + (t.realizedPnl ?? 0)).toFixed(2));
            ts[idx] = {
              ...t,
              exitPrice: Number(fill.avgPrice.toFixed(4)),
              pnl: finalPnl,
              pnlPercent: Number((finalPnl / t.notional * 100).toFixed(2)),
            };
            saveTrades(ts);
            emit('trade_closed', ts[idx]);
            if (Math.abs(finalPnl - (after.pnl ?? 0)) > 0.01) {
              console.log(`[monitor] ${after.symbol} RECONCILED — real exit ${fill.avgPrice} pnl=$${finalPnl} (planned was $${after.pnl?.toFixed(2)})`);
            }
          } else {
            console.warn(`[monitor] ${after.symbol} exit fill unavailable — ledger keeps planned pnl=$${after.pnl?.toFixed(2)}`);
          }
          recordGroupTradeResult((after.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup, finalPnl);
          recordTradeResult(after.strategyId ?? 'unknown', finalPnl, accountBalance);
          emit('risk_update', { dailyPnl: getState().riskState.dailyRealizedPnl });
        })();
      }
    }

    saveTrades(updated);
  } finally {
    monitorRunning = false;
  }
}

function tryFireTrades(): void {
  if (!env.AUTO_EXECUTE) return;
  const snapshot = getCurrentSnapshot();
  if (!snapshot) return;

  const etMins = etMinutes();
  if (etMins < 9 * 60 + 30 || etMins >= 15 * 60 + 45) return;

  // Snapshot of current trades for gate checks (open-position count, sector/beta caps).
  // Note: newly-fired trades are booked asynchronously after Alpaca confirms the fill,
  // so they are NOT pushed into this local array — the executor's own firedToday guard
  // prevents re-firing the same symbol before the async booking completes.
  const trades = loadTrades();
  const state = getState();

  for (const row of snapshot.rows) {
    if (!row.qualified || !row.tradePlan) continue;
    if (state.firedToday.includes(row.symbol)) continue;

    const sig = row.primaryStrategy;
    if (!sig) continue;

    if (isTideBlocked(row, snapshot.spyTrend5m, snapshot.spyTrend15m, sig)) {
      console.log(`[executor] ${row.symbol} tide blocked`);
      continue;
    }

    const dailyCheck = checkDailyLossLimit(accountBalance);
    if (!dailyCheck.ok) {
      console.log(`[executor] daily loss limit hit: ${dailyCheck.reason}`);
      break;
    }

    const groupCheck = checkGroupCircuitBreaker((sig.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup);
    if (!groupCheck.ok) {
      console.log(`[executor] ${row.symbol} group CB: ${groupCheck.reason}`);
      continue;
    }

    const stratCheck = checkStrategyCircuitBreaker(sig.strategyId ?? 'unknown');
    if (!stratCheck.ok) {
      console.log(`[executor] ${row.symbol} strategy CB: ${stratCheck.reason}`);
      continue;
    }

    const sectorCheck = checkSectorConcentration(trades, row.symbol);
    if (!sectorCheck.ok) {
      console.log(`[executor] ${row.symbol} sector cap: ${sectorCheck.reason}`);
      continue;
    }

    if (!canPaperTradeRow(row, trades, accountBalance)) continue;

    const newTrade = buildPaperTrade(row, trades, new Date().toISOString(), accountBalance, snapshot.spyTrend5m, snapshot.spyTrend15m);
    if (!newTrade) continue;

    const betaCheck = checkPortfolioBeta(
      trades.filter((t: { status: string }) => t.status === 'Open'),
      row.beta,
      newTrade.notional,
      accountBalance,
    );
    if (!betaCheck.ok) {
      console.log(`[executor] ${row.symbol} beta cap: ${betaCheck.reason}`);
      continue;
    }

    // Mark fired immediately so a slow fill-confirm can't double-fire this symbol.
    setState((s) => ({ ...s, firedToday: [...s.firedToday, row.symbol] }));
    saveState();

    // FILL-FIRST BOOKING: the ledger must record what Alpaca ACTUALLY did, not what
    // we planned. Previously the trade was pushed to the ledger before Alpaca was
    // even called, so a rejected order (fractional-bracket error, insufficient BP)
    // left a phantom trade with fictional entry/qty/pnl — the root cause of the
    // ledger-vs-broker divergence. Now we place, wait for the real fill, and only
    // book the trade if Alpaca confirms it — using the real fill qty and price.
    if (newTrade.direction === 'NEUTRAL') continue;
    // Reconcile asynchronously so one slow fill doesn't stall the executor loop.
    void (async () => {
      try {
        const order = await placePaperBracketOrder({
          symbol: newTrade.symbol,
          direction: newTrade.direction as 'BULL' | 'BEAR',
          entry: newTrade.entry,
          stop: newTrade.stop,
          target: newTrade.target2 || newTrade.target,
          notional: newTrade.notional,
        });
        const fill = await awaitEntryFill(order.id);
        if (!fill.filled || fill.qty <= 0) {
          console.warn(`[alpaca] ${newTrade.symbol} NOT booked — order ${fill.status} (no fill). Ledger stays clean.`);
          return;
        }
        // Rebuild the trade from the REAL fill: actual entry price, whole-share qty,
        // notional recomputed. Stop/target keep their planned distances relative to
        // the real entry so the R:R stays intact.
        const realEntry = fill.avgPrice;
        const realQty = fill.qty;
        const drift = realEntry - newTrade.entry; // slippage vs plan
        const booked: PaperTrade = {
          ...newTrade,
          entry: Number(realEntry.toFixed(4)),
          stop: Number((newTrade.stop + drift).toFixed(4)),
          target: Number((newTrade.target + drift).toFixed(4)),
          target1: Number((newTrade.target1 + drift).toFixed(4)),
          target2: Number((newTrade.target2 + drift).toFixed(4)),
          trailingStop: Number((newTrade.stop + drift).toFixed(4)),
          quantity: realQty,
          notional: Number((realQty * realEntry).toFixed(2)),
          alpacaOrderId: order.id,
        };
        const ts = loadTrades();
        ts.push(booked);
        saveTrades(ts);
        emit('trade_opened', booked);
        console.log(`[executor] BOOKED ${newTrade.symbol} ${sig.strategyId} ${newTrade.direction} realEntry=${realEntry} qty=${realQty} (plan entry ${newTrade.entry}, slip ${drift.toFixed(3)})`);
      } catch (err) {
        console.warn(`[alpaca] order failed ${newTrade.symbol} — not booked:`, (err as Error).message);
      }
    })();
  }
}

// Pull a usable last price out of an Alpaca snapshot, preferring the most
// recent print, then quote midpoint, then the latest bar close.
function snapshotPrice(s?: {
  latestTrade?: { p: number };
  latestQuote?: { ap: number; bp: number };
  minuteBar?: { c: number };
  dailyBar?: { c: number };
}): number | null {
  if (!s) return null;
  if (s.latestTrade?.p) return s.latestTrade.p;
  if (s.latestQuote?.ap && s.latestQuote?.bp) return (s.latestQuote.ap + s.latestQuote.bp) / 2;
  if (s.minuteBar?.c) return s.minuteBar.c;
  if (s.dailyBar?.c) return s.dailyBar.c;
  return null;
}

async function eodClose(): Promise<void> {
  const state = getState();
  const today = toETDate();
  if (state.eodFiredDate === today) return;

  const trades = loadTrades();
  const openTrades = trades.filter((t: { status: string }) => t.status === 'Open');
  if (openTrades.length === 0) {
    state.eodFiredDate = today;
    saveState();
    return;
  }

  const snapshot = getCurrentSnapshot();
  const priceBySymbol = new Map<string, number>(
    (snapshot?.rows ?? []).map((r: { symbol: string; price: number }) => [r.symbol, r.price]),
  );

  // Any held symbol missing from the live snapshot would otherwise default to
  // entry → a fabricated $0 P&L. This happens routinely when the daemon
  // restarts post-close and runs a "missed EOD close" before the scan has
  // repopulated rows (a held name may also simply have dropped out of the
  // scanner's top-N). Fetch a real last price straight from Alpaca for those.
  const missing = [...new Set(openTrades.map((t: { symbol: string }) => t.symbol))]
    .filter((s) => !priceBySymbol.has(s));
  if (missing.length) {
    try {
      const snaps = await fetchSnapshots(missing);
      for (const sym of missing) {
        const p = snapshotPrice(snaps[sym]);
        if (p != null) priceBySymbol.set(sym, p);
      }
    } catch (err) {
      console.warn('[eod] snapshot price backfill failed:', (err as Error).message);
    }
  }

  let changed = false;
  const unresolved: string[] = [];
  const updated = trades.map((t: { status: string; symbol: string; direction: string; entry: number; quantity: number; notional: number; partialQty?: number; realizedPnl?: number; mfe?: number; mae?: number }) => {
    if (t.status !== 'Open') return t;
    const live = priceBySymbol.get(t.symbol);
    if (live == null) unresolved.push(t.symbol);
    const price = live ?? t.entry;
    // Final excursion update — eodClose bypasses monitorPaperTrades, so without
    // this the closing move would be missing from the trade's MFE/MAE record.
    const favorable = t.direction === 'BEAR' ? t.entry - price : price - t.entry;
    const mfe = Number(Math.max(t.mfe ?? 0, favorable, 0).toFixed(4));
    const mae = Number(Math.max(t.mae ?? 0, -favorable, 0).toFixed(4));
    // After a 1R partial only the runner half is still open; add the banked realizedPnl.
    const remainingQty = t.quantity - (t.partialQty ?? 0);
    const move = t.direction === 'BEAR' ? (t.entry - price) : (price - t.entry);
    const gross = move * remainingQty + (t.realizedPnl ?? 0);
    changed = true;
    const closed = {
      ...t,
      mfe,
      mae,
      status: 'Closed',
      outcome: 'EOD',
      exitPrice: Number(price.toFixed(2)),
      pnl: Number(gross.toFixed(2)),
      pnlPercent: Number((gross / t.notional * 100).toFixed(2)),
      closedAt: new Date().toISOString(),
    };
    // eodClose does not go through emit(), so record the close in the ledger here.
    appendLedger('trade_closed', closed);
    return closed;
  });

  if (changed) {
    saveTrades(updated as PaperTrade[]);
    console.log('[eod] all open trades closed at market (planned prices) — reconciling actual fills…');
    if (unresolved.length) {
      console.warn(`[eod] no live price for ${unresolved.join(', ')} — booked at entry (P&L $0); rerun backfill once data is available`);
    }
    // Bulk-close at the broker, then reconcile each EOD trade's exit to the ACTUAL
    // fill price Alpaca produced. Without this, EOD trades keep the snapshot/last-
    // price estimate, which is a primary source of the ledger-vs-broker divergence.
    void (async () => {
      await closeAllPaperPositions().catch((err: Error) => console.warn('[alpaca] EOD closeAll failed:', err.message));
      // Give fills a moment to settle, then read the day's closing fills per symbol.
      await new Promise((r) => setTimeout(r, 4000));
      const justClosed = (updated as PaperTrade[]).filter((t) => t.outcome === 'EOD' && t.closedAt?.slice(0, 10) === today);
      const ts = loadTrades();
      let reconciled = 0;
      for (const t of justClosed) {
        try {
          const fills = await getRecentFilledOrders(t.symbol);
          // The closing fill is the opposite side of the trade, filled today.
          const exitSide = t.direction === 'BEAR' ? 'buy' : 'sell';
          const todayFill = fills.find((f) => f.side === exitSide && (f.filled_at ?? '').slice(0, 10) === today && f.filled_avg_price);
          if (!todayFill?.filled_avg_price) continue;
          const px = Number(todayFill.filled_avg_price);
          const idx = ts.findIndex((x) => x.id === t.id);
          if (idx === -1) continue;
          const cur = ts[idx];
          const remainingQty = cur.quantity - (cur.partialQty ?? 0);
          const move = cur.direction === 'BEAR' ? (cur.entry - px) : (px - cur.entry);
          const pnl = Number((move * remainingQty + (cur.realizedPnl ?? 0)).toFixed(2));
          ts[idx] = { ...cur, exitPrice: Number(px.toFixed(4)), pnl, pnlPercent: Number((pnl / cur.notional * 100).toFixed(2)) };
          reconciled++;
        } catch { /* leave planned price */ }
      }
      if (reconciled) { saveTrades(ts); console.log(`[eod] reconciled ${reconciled}/${justClosed.length} EOD exits to actual fills`); }
    })();
  }

  state.eodFiredDate = today;
  saveState();
}

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Connect bar stream — hot-set symbols will be subscribed after first full scan.
  // Note: we do NOT hook onFiveMinClose to runHotSetScan here because it fires
  // once per symbol (120 calls/5m = Alpaca 429). The 20s timer below is sufficient.
  alpacaBarStream.connect();

  // Initial sync + scan. If the universe lands on fallback, retry after 5 min.
  syncAccount().then(() => runFullScan()).then(() => {
    if (isUniverseFallback()) {
      console.warn('[scheduler] startup scan used fallback universe — retrying screener in 5 min');
      setTimeout(() => {
        clearUniverseCacheClient();
        runFullScan().catch((err) => console.error('[scheduler] fallback-retry scan error:', err));
      }, 5 * 60 * 1000);
    }
  }).catch((err) => console.error('[init] startup scan error:', err));

  // If daemon starts after market close and missed the EOD window, close open trades now
  if (isEODWindow()) {
    console.log('[scheduler] post-market startup — running missed EOD close');
    eodClose().catch((err) => console.error('[eod] missed-close error:', (err as Error).message));
  }

  // Full scan every 60s across the scan window (pre-market 8:00 ET → close).
  // Pre-market scanning keeps the dashboard live before the open; no trades fire
  // because the executor below stays gated to isMarketHours.
  setInterval(() => {
    if (!isScanWindow()) return;
    if (fullScanRunning) return;
    fullScanRunning = true;
    runFullScan()
      .catch((err) => console.error('[scan] full scan failed (will retry next cycle):', (err as Error).message))
      .finally(() => { fullScanRunning = false; });
  }, 60_000);

  // Hot-set scan every 20s (backup to bar-stream boundary trigger).
  // Runs across the scan window so forming setups stay fresh pre-market too.
  setInterval(() => {
    if (!isScanWindow()) return;
    if (hotScanRunning) return;
    hotScanRunning = true;
    runHotSetScan()
      .catch((err) => console.error('[scan] hot-set scan failed (will retry next cycle):', (err as Error).message))
      .finally(() => { hotScanRunning = false; });
  }, 20_000);

  // Trade monitor every 10s
  setInterval(() => {
    if (!isMarketHours()) return;
    monitorLoop().catch((err) => console.warn('[monitor] error:', err));
  }, 10_000);

  // Account sync every 30s
  setInterval(() => {
    syncAccount().catch(() => {/* silent */});
  }, 30_000);

  // Executor: try fire trades every 5s
  setInterval(() => {
    if (!isMarketHours()) return;
    tryFireTrades();
  }, 5_000);

  // EOD close check every 30s
  setInterval(() => {
    if (isEODWindow()) eodClose().catch((err) => console.error('[eod] close error:', (err as Error).message));
  }, 30_000);

  // State save every 30s
  setInterval(() => {
    saveState();
  }, 30_000);

  // Day-roll check every 60s (handles midnight ET without restart)
  setInterval(() => {
    const rolled = applyDayRoll(getState());
    if (rolled !== getState()) {
      // Day rolled — update in-memory state by using setState
      // applyDayRoll is pure; we need setState to push it back
      setState((_) => rolled);
    }
    saveState();
  }, 60_000);

  // Universe rebuild at 8:30 AM ET — gap and RVOL data is reliable by then. This is
  // the authoritative daily rebuild; the pre-market 60s loop (8:00→8:30) scans the
  // existing/startup universe so the dashboard is live, then this refreshes it.
  // If daemon started before 8:30: schedule a one-shot clear+rebuild at exactly 8:30.
  // If daemon started after 8:30: the startup scan already builds today's universe (no action needed).
  const msToRebuild = msUntil830ET();
  if (msToRebuild > 0) {
    console.log(`[scheduler] universe rebuild scheduled in ${Math.round(msToRebuild / 60_000)}m (8:30 ET)`);
    setTimeout(() => {
      console.log('[scheduler] 8:30 ET — clearing universe cache and rebuilding');
      clearUniverseCache();
      runFullScan().catch((err) => console.error('[universe] 8:30 rebuild error:', err));
    }, msToRebuild);
  } else {
    console.log('[scheduler] past 8:30 ET — universe builds on startup scan');
  }

  console.log('[scheduler] started — intervals armed');
}
