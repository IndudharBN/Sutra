import { evaluateStrategies, setStrategyClock } from './strategyEngine';
import { RETIRED_STRATEGIES, baseFailures, computeAtr, isQualified, liveDirection, scoreRow } from './entryGate';
import { DEFAULT_COSTS, commission, fillPrice } from './costs';
import type { FillKind, TradingCosts } from './costs';
import { computePositionSize, getRiskSettings } from '../../lib/riskManager';
import { ema, vwapLatest } from '../scanner/indicators';
import { closes, last, round } from '../scanner/ohlcv';
import type { Candle } from '../scanner/ohlcv';
import type { MarketDataProviderStatus, StrategyId, StrategyInput } from './workflowTypes';

export interface BacktestTrade {
  symbol: string;
  strategyId: StrategyId;
  direction: 'BULL' | 'BEAR';
  date: string;
  entryTime: string;
  entryPrice: number;
  stopPrice: number;
  t1Price: number;
  t2Price: number;
  targetPrice: number;
  exitTime: string;
  exitPrice: number;
  outcome: 'target2' | 'target1' | 'breakeven' | 'stop' | 'eod';
  t1Hit: boolean;
  shares: number;
  dollarPnl: number;   // NET of costs
  grossPnl: number;    // before spread/slippage/commission
  costs: number;       // grossPnl - dollarPnl
  pnlPct: number;
  rrActual: number;
  win: boolean;
  rvolAtEntry: number;      // RVOL at entry — for offline filter A/B
  tape15mAligned: boolean;  // 15m tape aligned at entry — for offline filter A/B
}

export interface BacktestSummary {
  strategy: StrategyId;
  trades: number;
  wins: number;
  winRate: number;
  longs: number;
  shorts: number;
  longWinRate: number;
  shortWinRate: number;
  t1HitCount: number;
  t1HitRate: number;
  avgRR: number;
  totalPnlPct: number;
  totalDollarPnl: number;
  totalGrossPnl: number;
  totalCosts: number;
}

export interface BacktestResult {
  symbol: string;
  startDate: string;
  endDate: string;
  accountBalance: number;
  riskPerTradePct: number;
  trades: BacktestTrade[];
  byStrategy: BacktestSummary[];
  totalTrades: number;
  totalWins: number;
  winRate: number;
  avgRR: number;
  totalPnlPct: number;
  totalDollarPnl: number;
  totalGrossPnl: number;
  totalCosts: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function etMins(iso: string): number {
  const d = new Date(iso);
  const h = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(d.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isRegularSession(iso: string): boolean {
  const m = etMins(iso);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function groupByDate(bars: Candle[]): Map<string, Candle[]> {
  const map = new Map<string, Candle[]>();
  for (const bar of bars) {
    const d = etDate(bar.time);
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(bar);
  }
  return map;
}

function candleTrend(candles: Candle[]): 'UP' | 'DOWN' | 'FLAT' {
  if (candles.length < 25) return 'FLAT';
  const e9 = last(ema(closes(candles), 9));
  const e21 = last(ema(closes(candles), 21));
  return e9 > e21 ? 'UP' : e9 < e21 ? 'DOWN' : 'FLAT';
}

function computeDirection(candles: Candle[]): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (candles.length < 22) return 'NEUTRAL';
  const e9 = last(ema(closes(candles), 9));
  const e21 = last(ema(closes(candles), 21));
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return 'NEUTRAL';
  if (e9 > e21 * 1.001) return 'BULL';
  if (e9 < e21 * 0.999) return 'BEAR';
  return 'NEUTRAL';
}

function aggregate15m(bars5m: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + 2 < bars5m.length; i += 3) {
    const s = bars5m.slice(i, i + 3);
    result.push({
      time: s[0].time,
      open: s[0].open,
      high: Math.max(...s.map((c) => c.high)),
      low: Math.min(...s.map((c) => c.low)),
      close: s[s.length - 1].close,
      volume: s.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}

function computeAtr20(daily: Candle[]): number {
  if (daily.length < 2) return 0;
  const recent = daily.slice(-21);
  let total = 0, count = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i], p = recent[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    count++;
  }
  return count > 0 ? total / count : 0;
}

export interface BacktestOptions {
  /** Spread/slippage/commission model. Pass ZERO_COSTS for the old free-fill behaviour. */
  costs?: TradingCosts;
  /**
   * 'full_t1' mirrors the live daemon (full exit at T1 as a resting limit, since 2026-08-27).
   * 'partial_runner' is the legacy model: half off at T1, stop to breakeven, runner to T2.
   */
  exitMode?: 'full_t1' | 'partial_runner';
  /**
   * true (default): apply the live scanner/executor gates — retired-strategy filter, primary-signal
   * selection, `qualified` (score/RVOL/VWAP/5m/15m), live direction rule, 15m-ATR stops, one entry per
   * symbol per day, bar-time clock for time-of-day gates. false: legacy permissive replay.
   */
  liveGates?: boolean;
}

interface SettleInput {
  direction: 'BULL' | 'BEAR';
  entry: number;
  stop: number;
  t1: number;
  t1Hit: boolean;
  shares: number;
  adv: number;
  sigmaDaily: number;
}

// One place that turns an exit into P&L. Gross uses the idealised prices; net walks
// every leg through the cost model (entry is a market fill; targets are resting limits;
// stops and the EOD flatten are market fills).
function settle(
  p: SettleInput,
  exitPrice: number,
  exitKind: FillKind,
  mode: 'full_t1' | 'partial_runner',
  costs: TradingCosts,
): { gross: number; net: number } {
  const dir = p.direction === 'BULL' ? 1 : -1;
  const entrySide = dir === 1 ? 'buy' : 'sell';
  const exitSide = dir === 1 ? 'sell' : 'buy';
  const ctx = { shares: p.shares, adv: p.adv, sigmaDaily: p.sigmaDaily };
  const entryFill = fillPrice(entrySide, p.entry, 'market', ctx, costs);

  // Legs: [qty, idealPrice, kind]
  const legs: Array<[number, number, FillKind]> = [];
  if (mode === 'partial_runner' && p.t1Hit) {
    const half = Math.floor(p.shares / 2);
    legs.push([half, p.t1, 'limit'], [p.shares - half, exitPrice, exitKind]);
  } else {
    legs.push([p.shares, exitPrice, exitKind]);
  }

  let gross = 0;
  let net = 0;
  for (const [qty, px, kind] of legs) {
    gross += dir * (px - p.entry) * qty;
    net += dir * (fillPrice(exitSide, px, kind, { ...ctx, shares: qty }, costs) - entryFill) * qty;
  }
  net -= commission(p.shares, costs) * 2;
  return { gross: round(gross, 2), net: round(net, 2) };
}

const BACKTEST_STATUS: MarketDataProviderStatus = {
  provider: 'alpaca',
  mode: 'live',
  lastUpdated: new Date().toISOString(),
  stale: false,
  ageSeconds: 0,
  message: 'backtest replay',
};

// ── Main replay engine ────────────────────────────────────────────────────────

export function runBacktest(
  symbol: string,
  bars5m: Candle[],
  dailyBars: Candle[],
  accountBalance = 100_000,
  opts: BacktestOptions = {},
): BacktestResult {
  const costs = opts.costs ?? DEFAULT_COSTS;
  const mode = opts.exitMode ?? 'full_t1';
  const liveGates = opts.liveGates ?? true;
  const { riskPerTradePct } = getRiskSettings();
  const trades: BacktestTrade[] = [];
  const regular5m = bars5m.filter((b) => b.time && isRegularSession(b.time));
  const byDate = groupByDate(regular5m);
  const sortedDates = [...byDate.keys()].sort();

  for (let dayIdx = 0; dayIdx < sortedDates.length; dayIdx++) {
    const date = sortedDates[dayIdx];
    const dayBars = byDate.get(date)!;
    if (dayBars.length < 10) continue;

    const dailyUpToDate = dailyBars.filter((d) => etDate(d.time) <= date);
    const prevDailyBar = dailyUpToDate.length >= 2 ? dailyUpToDate[dailyUpToDate.length - 2] : null;
    const atr20 = computeAtr20(dailyUpToDate);
    const prevDayVolume = prevDailyBar?.volume ?? 0;
    const prevDayBars5m = dayIdx > 0 ? (byDate.get(sortedDates[dayIdx - 1]) ?? []) : [];

    // Lock direction at first eligible bar (10:00 AM) — prevents intraday direction flipping
    let lockedDirection: 'BULL' | 'BEAR' | 'NEUTRAL' | null = null;
    let firedToday = false; // live executor fires a symbol at most once per day
    let openPos: {
      strategyId: StrategyId;
      direction: 'BULL' | 'BEAR';
      entry: number;
      stop: number;
      effectiveStop: number; // moves to breakeven after T1
      t1: number;
      t2: number;
      target: number;
      entryTime: string;
      t1Hit: boolean;
      rvolAtEntry: number;
      tape15mAligned: boolean;
      adv: number;
      sigmaDaily: number;
    } | null = null;

    for (let i = 0; i < dayBars.length; i++) {
      const bar = dayBars[i];
      const barMins = etMins(bar.time);

      // ── Manage open position ───────────────────────────────────────────────
      if (openPos) {
        const { direction, effectiveStop, t1, t2, target, entry, stop, strategyId, entryTime, t1Hit, rvolAtEntry, tape15mAligned } = openPos;

        // Partial-runner model only: T1 moves the stop to breakeven and lets T2 run.
        if (mode === 'partial_runner' && !t1Hit) {
          const hitT1 = direction === 'BULL' ? bar.high >= t1 : bar.low <= t1;
          if (hitT1) openPos = { ...openPos, t1Hit: true, effectiveStop: entry };
        }

        const { t1Hit: t1HitNow, effectiveStop: effStop } = openPos;
        const hitStop = direction === 'BULL' ? bar.low <= effStop : bar.high >= effStop;
        // Full-exit model: T1 is the take-profit. Conservative tie-break: stop wins a same-bar tie.
        const hitFinal = mode === 'full_t1'
          ? (direction === 'BULL' ? bar.high >= t1 : bar.low <= t1)
          : (direction === 'BULL' ? bar.high >= t2 : bar.low <= t2);
        // Partial-runner T1-hit positions run to the close (free trade); everything else flattens ~EOD.
        const eod = mode === 'partial_runner' && t1HitNow ? false : barMins >= 15 * 60 + 55;

        let outcome: 'target2' | 'target1' | 'breakeven' | 'stop' | 'eod' | null = null;
        let exitPrice = bar.close;
        let kind: FillKind = 'market';

        if (hitFinal && !hitStop) {
          outcome = mode === 'full_t1' ? 'target1' : 'target2';
          exitPrice = mode === 'full_t1' ? t1 : t2;
          kind = 'limit';
        } else if (hitStop) {
          outcome = t1HitNow ? 'breakeven' : 'stop';
          // A bar that opens through the stop fills at the open, not at the stop.
          exitPrice = direction === 'BULL' ? Math.min(effStop, bar.open) : Math.max(effStop, bar.open);
          kind = 'stop';
        } else if (eod) {
          outcome = 'eod';
          exitPrice = bar.close;
        }

        if (outcome) {
          const shares = computePositionSize(accountBalance, entry, stop);
          const risk = Math.abs(entry - stop);
          const { gross, net } = settle({ direction, entry, stop, t1, t1Hit: t1HitNow, shares, adv: openPos.adv, sigmaDaily: openPos.sigmaDaily }, exitPrice, kind, mode, costs);
          const reward = Math.abs(exitPrice - entry);
          trades.push({
            symbol, strategyId, direction, date,
            entryTime, entryPrice: entry, stopPrice: stop,
            t1Price: t1, t2Price: t2, targetPrice: target,
            exitTime: bar.time, exitPrice, outcome,
            t1Hit: t1HitNow || outcome === 'target1',
            shares, dollarPnl: net, grossPnl: gross, costs: round(gross - net, 2),
            pnlPct: shares > 0 ? round(net / (entry * shares) * 100, 2) : 0,
            rrActual: risk > 0 ? round(reward / risk, 2) : 0,
            win: net > 0,
            rvolAtEntry, tape15mAligned,
          });
          openPos = null;
        }
        continue;
      }

      // ── Entry evaluation ───────────────────────────────────────────────────
      if (liveGates && firedToday) continue;
      // Legacy: skip first 15 min and last 30. Live: the decision is made when the bar CLOSES
      // (bar start + 5m) and the executor trades 09:30-15:45 ET.
      if (liveGates ? (barMins + 5 < 9 * 60 + 30 || barMins + 5 >= 15 * 60 + 45) : (barMins < 9 * 60 + 45 || barMins >= 15 * 60 + 30)) continue;
      // Need at least 3 bars (OR formation); prevDayBars5m already provides EMA context
      if (i < 3) continue;

      // Build candle context: yesterday's 5m bars + today's bars up to now
      const allFive = [...prevDayBars5m.slice(-60), ...dayBars.slice(0, i + 1)];
      const fifteen = aggregate15m(allFive).slice(-40);

      const price = bar.close;
      // Lock direction once at the first eligible bar — no intraday flipping
      if (!lockedDirection) {
        lockedDirection = computeDirection(allFive.slice(-60));
      }
      const trend5m = candleTrend(allFive.slice(-30));
      const trend15m = candleTrend(fifteen);
      const vwap = vwapLatest(dayBars.slice(0, i + 1));
      const prevCloseGap = prevDailyBar?.close ?? 0;
      const gapPctLive = prevCloseGap > 0 ? (dayBars[0].open - prevCloseGap) / prevCloseGap * 100 : 0;
      const direction = liveGates
        ? liveDirection({ price, vwap, trend5m, trend15m, gapPct: gapPctLive, etMinutes: barMins + 5 })
        : lockedDirection;
      if (direction === 'NEUTRAL') continue;
      const vwapAligned = direction === 'BULL' ? price > vwap : price < vwap;
      const trendAligned = direction === 'BULL' ? trend5m === 'UP' : trend5m === 'DOWN';
      const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : trend15m === 'DOWN';
      const atrPct = atr20 > 0 && price > 0 ? (atr20 / price) * 100 : 2;
      // 15m ATR anchors intraday stops live (falls back to 30% of daily ATR on thin data).
      const atr15raw = computeAtr(fifteen, 14);
      const atr15 = atr15raw > 0 ? atr15raw : atr20 * 0.3;

      const todayVol = dayBars.slice(0, i + 1).reduce((s, c) => s + c.volume, 0);
      const progress = Math.min(1, Math.max(0.05, (barMins - 9 * 60 - 30) / 390));
      const rvol = prevDayVolume > 0 ? todayVol / (prevDayVolume * progress) : 1;
      const prevClose = prevDailyBar?.close ?? 0;
      const gapPct = prevClose > 0 ? (dayBars[0].open - prevClose) / prevClose * 100 : 0;

      const input: StrategyInput = {
        symbol,
        company: symbol,
        direction,
        price,
        score: 70,
        rvol,
        gapPct,
        atr20,
        atrPct,
        rsVsBenchmark: 1,
        vwap,
        vwapAligned,
        trend5m,
        trend15m,
        trendAligned,
        trend15mAligned,
        earningsDays: null,
        dataStatus: BACKTEST_STATUS,
        candles: {
          one: [],
          five: allFive.slice(-120),
          fifteen: fifteen,
          daily: dailyUpToDate.slice(-60),
        },
      };

      let best: ReturnType<typeof evaluateStrategies>[number] | undefined;
      if (liveGates) {
        // Bar-time clock so time-of-day gates and bar-age volume projection see the replay time.
        const decisionMs = new Date(bar.time).getTime() + 5 * 60_000;
        let signals: ReturnType<typeof evaluateStrategies>;
        setStrategyClock(() => decisionMs);
        try { signals = evaluateStrategies({ ...input, atr15, vixLevel: undefined }); } finally { setStrategyClock(null); }
        // Live: primary = first non-retired signal; the row only trades if THAT signal has a plan.
        const primary = signals.filter((s) => !RETIRED_STRATEGIES.includes(s.strategyId))[0];
        if (!primary?.tradePlan) continue;
        const dollarVolM = (price * todayVol) / 1_000_000;
        const failures = baseFailures(price, atrPct, dollarVolM);
        const score = scoreRow({
          rvol, gapPct, atrPct, dollarVolM, vwapAligned, trendAligned, trend15mAligned,
          smallFloat: todayVol > 0 && todayVol < 50_000_000,
        });
        if (!isQualified({
          basePass: failures.length === 0, score, rvol, vwapAligned, trendAligned, trend15mAligned,
          primaryStrategyId: primary.strategyId,
        })) continue;
        best = primary;
      } else {
        const signals = evaluateStrategies(input);
        best = signals.find((s) => s.tradePlan && s.tradePlan.rr >= 1.5);
      }
      if (!best?.tradePlan) continue;

      // Enter at next bar open to avoid lookahead bias
      const nextBar = dayBars[i + 1];
      if (!nextBar) continue;
      const entryPrice = nextBar.open;
      const riskPerShare = Math.abs(best.tradePlan.entry - best.tradePlan.stop);
      if (riskPerShare <= 0) continue;
      const stop = direction === 'BULL' ? entryPrice - riskPerShare : entryPrice + riskPerShare;
      // Shift T1/T2 by the same slippage offset as entry
      const slip = entryPrice - best.tradePlan.entry;
      const t1 = best.tradePlan.target1 + slip;
      const t2 = best.tradePlan.target2 + slip;
      // Primary target = T2 (used for display)
      const target = direction === 'BULL'
        ? entryPrice + riskPerShare * best.tradePlan.rr
        : entryPrice - riskPerShare * best.tradePlan.rr;

      openPos = {
        strategyId: best.strategyId,
        direction,
        entry: entryPrice,
        stop: round(stop, 2),
        effectiveStop: round(stop, 2),
        t1: round(t1, 2),
        t2: round(t2, 2),
        target: round(target, 2),
        entryTime: nextBar.time,
        t1Hit: false,
        rvolAtEntry: round(rvol, 2),          // for offline filter A/B (RVOL floor)
        tape15mAligned: trend15mAligned,       // for offline filter A/B (tape gate)
        adv: prevDayVolume,
        sigmaDaily: entryPrice > 0 ? atr20 / entryPrice : 0,
      };
      firedToday = true;
    }

    // Force-close any position still open at EOD
    if (openPos) {
      const lastBar = dayBars[dayBars.length - 1];
      const { direction, entry, stop, t1, t2, target, strategyId, entryTime, t1Hit, rvolAtEntry, tape15mAligned, adv, sigmaDaily } = openPos;
      const exitPrice = lastBar.close;
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(exitPrice - entry);
      const shares = computePositionSize(accountBalance, entry, stop);
      const { gross, net } = settle({ direction, entry, stop, t1, t1Hit, shares, adv, sigmaDaily }, exitPrice, 'market', mode, costs);
      trades.push({
        symbol, strategyId, direction, date,
        entryTime, entryPrice: entry, stopPrice: stop,
        t1Price: t1, t2Price: t2, targetPrice: target,
        exitTime: lastBar.time, exitPrice, outcome: 'eod',
        t1Hit,
        shares, dollarPnl: net, grossPnl: gross, costs: round(gross - net, 2),
        pnlPct: shares > 0 ? round(net / (entry * shares) * 100, 2) : 0,
        rrActual: risk > 0 ? round(reward / risk, 2) : 0,
        win: net > 0,
        rvolAtEntry, tape15mAligned,
      });
    }
  }

  // ── Aggregate results ─────────────────────────────────────────────────────
  const strategyIds = [...new Set(trades.map((t) => t.strategyId))];
  const byStrategy: BacktestSummary[] = strategyIds.map((sid) => {
    const st = trades.filter((t) => t.strategyId === sid);
    const longs = st.filter((t) => t.direction === 'BULL');
    const shorts = st.filter((t) => t.direction === 'BEAR');
    const wins = st.filter((t) => t.win).length;
    const t1Hits = st.filter((t) => t.t1Hit).length;
    const avgRR = st.length ? st.reduce((s, t) => s + t.rrActual, 0) / st.length : 0;
    return {
      strategy: sid,
      trades: st.length,
      wins,
      winRate: st.length ? round(wins / st.length * 100, 1) : 0,
      longs: longs.length,
      shorts: shorts.length,
      longWinRate: longs.length ? round(longs.filter((t) => t.win).length / longs.length * 100, 1) : 0,
      shortWinRate: shorts.length ? round(shorts.filter((t) => t.win).length / shorts.length * 100, 1) : 0,
      t1HitCount: t1Hits,
      t1HitRate: st.length ? round(t1Hits / st.length * 100, 1) : 0,
      avgRR: round(avgRR, 2),
      totalPnlPct: round(st.reduce((s, t) => s + t.pnlPct, 0), 2),
      totalDollarPnl: round(st.reduce((s, t) => s + t.dollarPnl, 0), 2),
      totalGrossPnl: round(st.reduce((s, t) => s + t.grossPnl, 0), 2),
      totalCosts: round(st.reduce((s, t) => s + t.costs, 0), 2),
    };
  });

  const totalWins = trades.filter((t) => t.win).length;
  const avgRR = trades.length ? trades.reduce((s, t) => s + t.rrActual, 0) / trades.length : 0;
  return {
    symbol,
    startDate: sortedDates[0] ?? '',
    endDate: sortedDates[sortedDates.length - 1] ?? '',
    accountBalance,
    riskPerTradePct,
    trades,
    byStrategy,
    totalTrades: trades.length,
    totalWins,
    winRate: trades.length ? round(totalWins / trades.length * 100, 1) : 0,
    avgRR: round(avgRR, 2),
    totalPnlPct: round(trades.reduce((s, t) => s + t.pnlPct, 0), 2),
    totalDollarPnl: round(trades.reduce((s, t) => s + t.dollarPnl, 0), 2),
    totalGrossPnl: round(trades.reduce((s, t) => s + t.grossPnl, 0), 2),
    totalCosts: round(trades.reduce((s, t) => s + t.costs, 0), 2),
  };
}
