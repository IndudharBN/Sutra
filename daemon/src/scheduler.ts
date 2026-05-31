import { runFullScan, runHotSetScan, getCurrentSnapshot } from './scanLoop';
import { alpacaBarStream } from './alpacaBarStream';
import { getState, setState, saveState, applyDayRoll } from './stateStore';
import { monitorPaperTrades } from './engine/monitorTrades';
import { buildPaperTrade, canPaperTradeRow } from './engine/buildPaperTrade';
import { isTideBlocked } from './engine/isTideBlocked';
import { checkGroupCircuitBreaker, checkStrategyCircuitBreaker, checkDailyLossLimit, recordGroupTradeResult, recordTradeResult } from './riskManager';
import { checkSectorConcentration, checkPortfolioBeta } from './portfolioRisk';
import { getPaperAccount, getPaperPositions } from './alpacaBroker';
import { env } from './env';
import { emit } from './httpServer';
import * as fs from 'fs';
import * as path from 'path';

const TRADES_FILE = path.join(__dirname, '../../data/trades.json');

function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTrades(trades: unknown[]) {
  const tmp = TRADES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, TRADES_FILE);
}

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

function isEODWindow(): boolean {
  const mins = etMinutes();
  return mins >= 15 * 60 + 50 && mins < 16 * 60;
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
      if (before.status === 'Open' && after.status === 'Closed' && after.pnl !== undefined) {
        recordGroupTradeResult((after.signalGroup ?? 'UNCLASSIFIED') as import('./types').SignalGroup, after.pnl);
        recordTradeResult(after.strategyId ?? 'unknown', after.pnl, accountBalance);
        emit('trade_closed', after);
        emit('risk_update', { dailyPnl: getState().riskState.dailyRealizedPnl });
        console.log(`[monitor] ${after.symbol} closed — ${after.outcome} pnl=$${after.pnl?.toFixed(2)}`);
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

  const trades = loadTrades();
  const state = getState();
  let tradesFired = false;

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

    trades.push(newTrade);
    tradesFired = true;
    emit('trade_opened', newTrade);
    console.log(`[executor] FIRE ${row.symbol} ${sig.strategyId} ${row.direction} entry=${newTrade.entry} stop=${newTrade.stop} target=${newTrade.target} qty=${newTrade.quantity} notional=$${newTrade.notional.toFixed(0)}`);

    // Mark fired so we don't double-fire this session
    setState((s) => ({ ...s, firedToday: [...s.firedToday, row.symbol] }));
    saveState();
  }

  if (tradesFired) saveTrades(trades);
}

function eodClose(): void {
  const state = getState();
  const today = toETDate();
  if (state.eodFiredDate === today) return;

  const trades = loadTrades();
  const snapshot = getCurrentSnapshot();
  const priceBySymbol = new Map(
    (snapshot?.rows ?? []).map((r: { symbol: string; price: number }) => [r.symbol, r.price]),
  );

  let changed = false;
  const updated = trades.map((t: { status: string; symbol: string; direction: string; entry: number; quantity: number; notional: number }) => {
    if (t.status !== 'Open') return t;
    const price = priceBySymbol.get(t.symbol) ?? t.entry;
    const gross = t.direction === 'BEAR' ? (t.entry - price) * t.quantity : (price - t.entry) * t.quantity;
    changed = true;
    return {
      ...t,
      status: 'Closed',
      outcome: 'EOD',
      exitPrice: Number(price.toFixed(2)),
      pnl: Number(gross.toFixed(2)),
      pnlPercent: Number((gross / t.notional * 100).toFixed(2)),
      closedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    saveTrades(updated);
    console.log('[eod] all open trades closed at market');
  }

  state.eodFiredDate = today;
  saveState();
}

let schedulerStarted = false;

export function startScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Connect bar stream — hot-set symbols will be subscribed after first full scan
  alpacaBarStream.connect();

  // Bar-stream 5m callback: trigger hot-set scan on any 5m boundary
  alpacaBarStream.onFiveMinClose((_sym) => {
    runHotSetScan().catch((err) => console.warn('[barstream] hot scan error:', err));
  });

  // Initial sync + scan (non-blocking)
  syncAccount().then(() => runFullScan()).catch((err) => console.error('[init] startup scan error:', err));

  // Full scan every 60s during market hours
  setInterval(() => {
    if (!isMarketHours()) return;
    if (fullScanRunning) return;
    fullScanRunning = true;
    runFullScan().finally(() => { fullScanRunning = false; });
  }, 60_000);

  // Hot-set scan every 20s (backup to bar-stream boundary trigger)
  setInterval(() => {
    if (!isMarketHours()) return;
    if (hotScanRunning) return;
    hotScanRunning = true;
    runHotSetScan().finally(() => { hotScanRunning = false; });
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
    if (isEODWindow()) eodClose();
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

  console.log('[scheduler] started — intervals armed');
}
