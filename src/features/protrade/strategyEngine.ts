import { detectFvg } from '../scanner/fvg';
import { ema } from '../scanner/indicators';
import type { Candle } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { findOrderBlockZone, rejectionCandle } from '../scanner/smc';
import type { StrategyChecklistItem, StrategyId, StrategyInput, StrategySignal, TradePlan, WorkflowStage } from './workflowTypes';
import { STRATEGY_LABELS, workflowStageRank } from './workflowTypes';

const MIN_RR = 1.5;
const PREFERRED_RR = 2.5;
const T1_RR = 1.5;           // scale out 50% at T1, SL → entry (BE), then → T1 on pullback confirm
const STOP_BUFFER_ATR = 0.5; // breathing room beyond anchor extreme
const NOISE_FLOOR_ATR = 0.75; // min stop distance — covers bid-ask + 1m wick noise

function pass(label: string, detail: string): StrategyChecklistItem {
  return { label, passed: true, detail };
}

function fail(label: string, detail: string): StrategyChecklistItem {
  return { label, passed: false, detail };
}

function rr(entry: number, stop: number, target: number, direction: 'BULL' | 'BEAR' | 'NEUTRAL') {
  if (direction === 'NEUTRAL') return 0;
  const risk = direction === 'BULL' ? entry - stop : stop - entry;
  const reward = direction === 'BULL' ? target - entry : entry - target;
  return risk > 0 && reward > 0 ? reward / risk : 0;
}

function planFromLevels(input: StrategyInput, entry: number, stop: number, target: number, trigger?: Candle): TradePlan | null {
  const risk = input.direction === 'BULL' ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const target1 = input.direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const target2 = input.direction === 'BULL' ? Math.max(target, target1) : Math.min(target, target1);
  const value = rr(entry, stop, target2, input.direction);
  if (!Number.isFinite(value) || value <= 0) return null;
  const riskPerShare = Math.abs(entry - stop);
  return {
    entry: round(entry, 2),
    stop: round(stop, 2),
    target: round(target2, 2),
    target1: round(target1, 2),
    target2: round(target2, 2),
    rr: round(value, 2),
    rr1: PREFERRED_RR,
    riskPerShare: round(riskPerShare, 2),
    triggerCandleTime: trigger?.time || new Date().toISOString(),
    invalidation: input.direction === 'BULL' ? 'Price closes below stop or loses VWAP with volume.' : 'Price closes above stop or reclaims VWAP with volume.',
    riskSize: 'Use account risk setting; default review size only.',
  };
}

// T1/T2 explicit plan: T1=T1_RR scale out + move stop to BE, T2=structural level
function planFromLevelsT1T2(
  input: StrategyInput,
  entry: number,
  stop: number,
  t1: number,
  t2: number,
  trigger?: Candle,
): TradePlan | null {
  const risk = input.direction === 'BULL' ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const rrT2 = rr(entry, stop, t2, input.direction);
  if (!Number.isFinite(rrT2) || rrT2 < MIN_RR) return null;
  return {
    entry: round(entry, 2),
    stop: round(stop, 2),
    target: round(t2, 2),
    target1: round(t1, 2),
    target2: round(t2, 2),
    rr: round(rrT2, 2),
    rr1: T1_RR,
    riskPerShare: round(Math.abs(entry - stop), 2),
    triggerCandleTime: trigger?.time || new Date().toISOString(),
    invalidation: input.direction === 'BULL' ? 'Price closes below stop or loses VWAP with volume.' : 'Price closes above stop or reclaims VWAP with volume.',
    riskSize: 'Scale 50% at T1, move stop to breakeven, hold 50% to T2.',
  };
}

// Ensures stop is never tighter than NOISE_FLOOR_ATR from entry.
// For BULL: picks the lower of (structural stop, noise floor) — more room wins.
// For BEAR: picks the higher of (structural stop, noise floor) — more room wins.
function noiseFlooredStop(direction: 'BULL' | 'BEAR', entry: number, rawStop: number, atr20: number): number {
  const floor = direction === 'BULL' ? entry - atr20 * NOISE_FLOOR_ATR : entry + atr20 * NOISE_FLOOR_ATR;
  return direction === 'BULL' ? Math.min(rawStop, floor) : Math.max(rawStop, floor);
}

// Previous day's high/low for structural T2 targeting (PDH/PDL).
// Returns the most recently completed daily bar's levels, falling back to null if insufficient data.
function prevDayLevels(input: StrategyInput): { pdh: number; pdl: number } | null {
  const daily = input.candles.daily;
  if (daily.length < 2) return null;
  const prev = daily[daily.length - 2];
  return { pdh: prev.high, pdl: prev.low };
}

// Compute structural T2: PDH (bull) or PDL (bear), capped at max 3R to stay realistic.
// Falls back to PREFERRED_RR if no daily data.
function structuralT2(
  input: StrategyInput,
  entry: number,
  risk: number,
  t1: number,
): number {
  const prev = prevDayLevels(input);
  const fallback = input.direction === 'BULL'
    ? entry + risk * PREFERRED_RR
    : entry - risk * PREFERRED_RR;
  if (!prev) return fallback;
  const raw = input.direction === 'BULL' ? prev.pdh : prev.pdl;
  // Must be beyond T1 and no more than 3R away (avoids chasing distant levels)
  const cap3R = input.direction === 'BULL' ? entry + risk * 3 : entry - risk * 3;
  const capped = input.direction === 'BULL' ? Math.min(raw, cap3R) : Math.max(raw, cap3R);
  // T2 must be at least PREFERRED_RR (2.5R) — never collapse to T1 (2.0R)
  return input.direction === 'BULL' ? Math.max(capped, fallback) : Math.min(capped, fallback);
}

// Returns 'closed' outside 9:30–16:00 ET, 'blackout' during 9:30–10:00 (first 30m), 'open' otherwise.
function sessionGate(): 'open' | 'blackout' | 'closed' {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 'closed';
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcMins < 13 * 60 + 30 || utcMins >= 20 * 60) return 'closed';
  if (utcMins < 13 * 60 + 45) return 'blackout'; // 9:45 AM ET
  return 'open';
}

function stageFromChecklist(checklist: StrategyChecklistItem[], tradePlan: TradePlan | null, input: StrategyInput, manualOnly = false): WorkflowStage {
  const passed = checklist.filter((item) => item.passed).length;
  if (passed < 2) return 'raw_candidates';
  if (passed < checklist.length) return 'forming';
  if (!tradePlan) return 'confirmed';
  if (tradePlan.rr < MIN_RR) return 'confirmed';
  if (manualOnly) return 'confirmed';
  // Blackout 9:30–10:00 AM ET — setup confirmed but execution blocked until open session
  if (sessionGate() === 'blackout' || sessionGate() === 'closed') return 'locked';
  // locked = data not ready; setup quality is confirmed but execution is blocked.
  if (input.dataStatus.mode !== 'live' || input.dataStatus.stale) return 'locked';
  // S3: Earnings within ±1 day — cap at confirmed, require manual review
  if (input.earningsDays !== undefined && input.earningsDays !== null && Math.abs(input.earningsDays) <= 1) return 'confirmed';
  return 'trade_ready';
}

function confidence(checklist: StrategyChecklistItem[], tradePlan: TradePlan | null, input: StrategyInput, manualOnly = false) {
  const checkScore = checklist.length ? checklist.filter((item) => item.passed).length / checklist.length * 70 : 0;
  const rrScore = tradePlan ? Math.min(15, Math.max(0, (tradePlan.rr - 1) * 8)) : 0;
  const dataScore = input.dataStatus.mode === 'live' && !input.dataStatus.stale ? 10 : 0;
  const manualPenalty = manualOnly ? 10 : 0;
  return Math.max(0, Math.min(100, Math.round(checkScore + rrScore + dataScore + Math.min(5, input.rvol) - manualPenalty)));
}

function missing(checklist: StrategyChecklistItem[], tradePlan: TradePlan | null, input: StrategyInput, manualOnly = false) {
  const output = checklist.filter((item) => !item.passed).map((item) => item.label);
  if (tradePlan && tradePlan.rr < MIN_RR) output.push(`R:R below ${MIN_RR}`);
  if (!tradePlan) output.push('Entry/stop/target not calculated');
  if (manualOnly) output.push('Manual review required');
  if (input.dataStatus.mode !== 'live') output.push('Live data provider required for Trade Ready');
  if (input.dataStatus.stale) output.push('Fresh market data required');
  if (input.earningsDays !== undefined && input.earningsDays !== null && Math.abs(input.earningsDays) <= 1) {
    const d = Math.abs(input.earningsDays);
    output.push(`Earnings ${input.earningsDays === 0 ? 'today' : input.earningsDays > 0 ? `in ${d}d` : `${d}d ago`} — manual review only`);
  }
  return output;
}

function signal(
  strategyId: StrategyId,
  input: StrategyInput,
  checklist: StrategyChecklistItem[],
  tradePlan: TradePlan | null,
  reason: string,
  manualOnly = false,
  zones: StrategySignal['zones'] = [],
): StrategySignal {
  const stage = stageFromChecklist(checklist, tradePlan, input, manualOnly);
  return {
    strategyId,
    strategyName: STRATEGY_LABELS[strategyId],
    stage,
    direction: input.direction,
    confidence: confidence(checklist, tradePlan, input, manualOnly),
    reason,
    checklist,
    missing: missing(checklist, tradePlan, input, manualOnly),
    tradePlan,
    zones,
    canAutoReady: !manualOnly,
    orderBlockReason: stage === 'trade_ready' ? '' : missing(checklist, tradePlan, input, manualOnly).join(' | '),
  };
}

function directionOk(input: StrategyInput) {
  return input.direction === 'BULL' || input.direction === 'BEAR';
}

function htfTrendCheck(input: StrategyInput) {
  return pass('15m directional context', `${input.trend15m}${input.trend15mAligned ? ' ✓ aligned' : ' — watch'} — informational`);
}

function directionalAbove(input: StrategyInput, value: number, reference: number) {
  return input.direction === 'BULL' ? value > reference : value < reference;
}

function directionalBreak(input: StrategyInput, value: number, high: number, low: number) {
  return input.direction === 'BULL' ? value > high : value < low;
}

function openingRange(candles: Candle[], bars = 3) {
  const slice = candles.slice(0, bars);
  if (slice.length < bars) return null;
  return {
    high: Math.max(...slice.map((c) => c.high)),
    low: Math.min(...slice.map((c) => c.low)),
    startTime: slice[0].time,
    endTime: last(slice).time,
  };
}

// Extracts today's RTH opening range (first 3 bars after 9:30 AM ET).
// Needed when candles.five contains prior-day bars prepended for EMA context.
function todayOpeningRange(candles: Candle[]): ReturnType<typeof openingRange> {
  if (!candles.length) return null;
  const todayET = new Date(last(candles).time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayRTH = candles.filter((c) => {
    const d = new Date(c.time);
    const date = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return date === todayET && utcMins >= 13 * 60 + 30;
  });
  return openingRange(todayRTH, 3);
}

function recentRetest(input: StrategyInput, level: number) {
  const recent = input.candles.five.slice(-4); // 20-min window — retest must be fresh (4 bars of 5m)
  if (!recent.length) return false;
  const tolerance = Math.max(input.atr20 * 0.08, input.price * 0.0015);
  return input.direction === 'BULL'
    ? recent.some((c) => c.low <= level + tolerance && c.close >= level)
    : recent.some((c) => c.high >= level - tolerance && c.close <= level);
}


// RSI-14 from close series; returns 50 when < 15 samples.
function rsi14(cls: number[]): number {
  if (cls.length < 15) return 50;
  const slice = cls.slice(-15);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= 14; avgLoss /= 14;
  return avgLoss === 0 ? 100 : Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

// Count RTH (≥ 9:30 AM ET = ≥ 13:30 UTC) 5m bars.
function rthBarCount(candles: Candle[]): number {
  return candles.filter((c) => {
    const d = new Date(c.time);
    return d.getUTCHours() * 60 + d.getUTCMinutes() >= 13 * 60 + 30;
  }).length;
}

// True when intraday range consumed ≥ 80% of ATR20 — momentum exhausted.
function adrExhausted(candles: Candle[], atr20: number): boolean {
  if (atr20 <= 0) return false;
  const rth = candles.filter((c) => {
    const d = new Date(c.time);
    return d.getUTCHours() * 60 + d.getUTCMinutes() >= 13 * 60 + 30;
  });
  if (!rth.length) return false;
  const hi = Math.max(...rth.map((c) => c.high));
  const lo = Math.min(...rth.map((c) => c.low));
  return (hi - lo) >= atr20 * 0.8;
}

// 1m EMA alignment — informational only, never blocks execution.
function ema1mCheck(input: StrategyInput): StrategyChecklistItem {
  const one = input.candles.one;
  if (one.length < 25) return pass('1m entry timing', '1m feed not available — using 5m structure');
  const e9 = last(ema(closes(one), 9));
  const e21 = last(ema(closes(one), 21));
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return pass('1m entry timing', '1m EMA unavailable — using 5m structure');
  const aligned = input.direction === 'BULL' ? e9 > e21 : e9 < e21;
  return pass('1m entry timing', aligned ? '1m EMA9/21 aligned ✓' : '1m micro-structure counter-trend — watch entry');
}

export function evaluateOrbRetest(input: StrategyInput): StrategySignal {
  const range = todayOpeningRange(input.candles.five);
  const trigger = last(input.candles.five);
  const rangeBreak = range ? directionalBreak(input, input.price, range.high, range.low) : false;
  const retest = range ? recentRetest(input, input.direction === 'BULL' ? range.high : range.low) : false;
  const entry = input.price;
  const rawStop = input.direction === 'BULL'
    ? Math.min(range?.high ?? entry, trigger?.low ?? entry) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(range?.low ?? entry, trigger?.high ?? entry) + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const orRange = range ? range.high - range.low : 0;
  const breakoutLevel = range ? (input.direction === 'BULL' ? range.high : range.low) : entry;
  const breakoutDistance = input.direction === 'BULL' ? (input.price - breakoutLevel) : (breakoutLevel - input.price);
  const minBreakout = input.atr20 * 0.25;
  const confirmedBreak = breakoutDistance >= minBreakout;
  const measuredMove = input.direction === 'BULL' ? breakoutLevel + orRange : breakoutLevel - orRange;
  const t1 = input.direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const preferredTarget = input.direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = input.direction === 'BULL' ? Math.max(measuredMove, preferredTarget) : Math.min(measuredMove, preferredTarget);
  const tradePlan = directionOk(input) && range && confirmedBreak ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    confirmedBreak ? pass('ORB Breakout', `Clear of noise (+${round(breakoutDistance, 2)})`) : fail('ORB Breakout', `Inside noise floor (${round(minBreakout, 2)})`),
    retest ? pass('Retest hold', 'Breakout level retested and held') : fail('Retest hold', 'Waiting for controlled retest'),
    pass('RVOL confirmation', `${round(input.rvol, 2)}×${input.rvol >= 0.8 ? ' — confirmed' : ' — low'} — informational`),
    pass('ADR room', `${adrExhausted(input.candles.five, input.atr20) ? '>80% ATR used — watch' : '< 80% ATR used ✓'} — informational`),
    pass('VWAP context', `${input.vwapAligned ? 'VWAP ✓' : 'early session'} — informational`),
    ema1mCheck(input),
  ];
  return signal('orb_retest', input, checklist, tradePlan, 'Opening range breakout with controlled retest, VWAP, RVOL, and 1m timing.', false, range ? [{
    label: 'Opening Range',
    startTime: range.startTime,
    endTime: range.endTime,
    high: range.high,
    low: range.low,
  }] : []);
}

export function evaluateVwapPullback(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-12);
  const tolerance = Math.max(input.atr20 * 0.2, input.price * 0.002);
  const ema9 = last(ema(closes(recent), 9)) || input.vwap;
  const touchedValue = recent.some((c) => input.direction === 'BULL' 
    ? (c.low <= input.vwap + tolerance || c.low <= ema9 + tolerance) 
    : (c.high >= input.vwap - tolerance || c.high >= ema9 - tolerance)
  );
  const reclaimed = trigger ? directionalAbove(input, trigger.close, Math.min(input.vwap, ema9)) : false;
  const entry = input.price;
  const swing = input.direction === 'BULL' ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
  const rawStop = input.direction === 'BULL' ? swing - input.atr20 * STOP_BUFFER_ATR : swing + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = input.direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = directionOk(input) && recent.length >= 4 ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    touchedValue ? pass('Pullback into value', 'Recent candles tested VWAP/EMA zone') : fail('Pullback into value', 'Waiting for pullback'),
    reclaimed ? pass('Reclaim candle', 'Latest candle reclaimed direction') : fail('Reclaim candle', 'Waiting for reclaim'),
    input.trendAligned ? pass('5m trend aligned', `${input.trend5m} ✓ — Phase 3 reclaim confirmed`) : fail('5m trend aligned', `5m still ${input.trend5m} — pullback not complete`),
    pass('VWAP context', `${input.vwapAligned ? 'Above VWAP ✓' : 'Near VWAP'} — informational`),
    pass('RVOL', `${round(input.rvol, 2)}×${input.rvol >= 0.8 ? ' ✓' : ' — low vol pullback'} — informational`),
    ema1mCheck(input),
  ];
  return signal('vwap_pullback', input, checklist, tradePlan, 'VWAP pullback: touched value zone + reclaim + 5m re-aligned. Hard gates: direction, touchedValue, reclaimed, trendAligned.');
}

export function evaluateRsContinuation(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-12);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const microHigh = highs.length ? Math.max(...highs.slice(0, -1)) : 0;
  const microLow = lows.length ? Math.min(...lows.slice(0, -1)) : 0;
  const breakout = trigger ? directionalBreak(input, trigger.close, microHigh, microLow) : false;
  const rsEdge = input.direction === 'BULL' ? input.rsVsBenchmark >= 1.002 : input.rsVsBenchmark <= 0.998;
  const rsLabel = `${round(input.rsVsBenchmark, 4)} vs SPY`;
  const entry = input.price;
  const rawStop = input.direction === 'BULL' ? microLow - input.atr20 * STOP_BUFFER_ATR : microHigh + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = input.direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = directionOk(input) && recent.length >= 6 ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const fifteen = input.candles.fifteen;
  const trend1h: 'UP' | 'DOWN' | 'FLAT' = fifteen.length >= 5
    ? (fifteen[fifteen.length - 1].close > fifteen[fifteen.length - 5].close * 1.001 ? 'UP'
      : fifteen[fifteen.length - 1].close < fifteen[fifteen.length - 5].close * 0.999 ? 'DOWN' : 'FLAT')
    : 'FLAT';
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    pass('15m trend', `${input.trend15m}${input.trend15mAligned ? ' ✓ aligned' : ' — context'} — informational`),
    pass('1H directional', `${trend1h} — macro bias`),
    pass('RS vs SPY', `${rsLabel}${rsEdge ? ' ✓ leading' : ' — neutral'} — informational`),
    pass('5m trend', `${input.trend5m}${input.trendAligned ? ' aligned ✓' : ' — pullback entry phase'} — informational`),
    breakout ? pass('Micro range break', 'Latest candle broke the local range') : fail('Micro range break', 'Waiting for micro breakout'),
    input.rvol >= 1.0 ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — breakout needs ≥1.0×`),
    pass('VWAP context', `${input.vwapAligned ? 'VWAP ✓' : 'VWAP (below — watch for reclaim)'} — informational`),
    ema1mCheck(input),
  ];
  return signal('rs_continuation', input, checklist, tradePlan, 'RS continuation: micro range break + RVOL≥1.0. Hard gates: direction, breakout, rvol. Trend gates informational.');
}

export function evaluateLiquiditySweep(input: StrategyInput): StrategySignal {
  const range = todayOpeningRange(input.candles.five);
  const recent = input.candles.five.slice(-20);
  const trigger = last(recent);
  const sweptLevel = range ? (input.direction === 'BULL' ? range.low : range.high) : null;
  const sweepCandle = range ? recent.find((c) => input.direction === 'BULL' ? c.low < range.low : c.high > range.high) ?? null : null;
  const swept = Boolean(sweepCandle);
  const reclaimed = Boolean(sweptLevel !== null && trigger && (
    input.direction === 'BULL' ? trigger.close > sweptLevel : trigger.close < sweptLevel
  ));
  const entry = sweptLevel ?? input.price;
  const nearLevel = sweptLevel !== null
    ? (input.direction === 'BULL'
        ? input.price <= sweptLevel + input.atr20 * 3.0
        : input.price >= sweptLevel - input.atr20 * 3.0)
    : false;
  const sweepRef = input.direction === 'BULL' ? (sweepCandle ? sweepCandle.low : entry) : (sweepCandle ? sweepCandle.high : entry);
  const rawStop = input.direction === 'BULL' ? sweepRef - input.atr20 * STOP_BUFFER_ATR : sweepRef + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const orOpposite = range ? (input.direction === 'BULL' ? range.high : range.low) : null;
  const t1 = input.direction === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2Raw = orOpposite ?? (input.direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR);
  const preferredTarget = input.direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = input.direction === 'BULL' ? Math.max(t2Raw, preferredTarget) : Math.min(t2Raw, preferredTarget);
  const sweepWickOk = sweepCandle ? (() => {
    const cRange = sweepCandle.high - sweepCandle.low;
    if (cRange < 1e-8) return false;
    return input.direction === 'BULL'
      ? (sweepCandle.close - sweepCandle.low) / cRange >= 0.1
      : (sweepCandle.high - sweepCandle.close) / cRange >= 0.1;
  })() : false;
  const tradePlan = directionOk(input) && range && swept && reclaimed && nearLevel
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    swept ? pass('Liquidity swept', `Sweep candle: ${sweepCandle ? round(input.direction === 'BULL' ? sweepCandle.low : sweepCandle.high, 2) : '--'}`) : fail('Liquidity swept', 'No sweep below/above opening range yet'),
    sweepWickOk ? pass('Sweep rejection wick', 'Candle closed back in range') : fail('Sweep rejection wick', 'No rejection, likely continuation'),
    reclaimed ? pass('Level reclaimed', `Close back ${input.direction === 'BULL' ? 'above' : 'below'} ${sweptLevel ? round(sweptLevel, 2) : '--'}`) : fail('Level reclaimed', 'Waiting for close back through swept level'),
    nearLevel ? pass('Entry proximity', 'Price within 3×ATR of level') : fail('Entry proximity', 'Price too far — do not chase'),
    pass('Volume confirmation', `${round(input.rvol, 2)}x${input.rvol >= 0.8 ? ' — confirmed' : ' — low, sweep structure is the primary signal'}`),
    ema1mCheck(input),
  ];
  return signal('liquidity_sweep', input, checklist, tradePlan, `S4 Sweep: T1=${orOpposite ? 'OR opposite' : '2R'} T2=${orOpposite ? round(orOpposite,2) : '2.5R'}`);
}

export function evaluateObFvgRetest(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const trigger = last(five);
  if (!directionOk(input)) {
    return signal('ob_fvg_retest', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const ob = findOrderBlockZone(five, dir, 1.1, 40);
  const atOb = ob
    ? (dir === 'BULL'
      ? input.price <= ob.high + input.atr20 * 0.2 && input.price >= ob.low - input.atr20 * 0.2
      : input.price >= ob.low - input.atr20 * 0.2 && input.price <= ob.high + input.atr20 * 0.2)
    : false;
  const obReject = ob ? rejectionCandle(five, dir, ob) : false;
  const fvgResult = detectFvg(five, 8);
  const gap = fvgResult.latestGap;
  const fvgAligned = gap && !gap.filled &&
    ((dir === 'BULL' && gap.direction === 'BULLISH') || (dir === 'BEAR' && gap.direction === 'BEARISH'));
  const atFvg = fvgAligned && gap
    ? (dir === 'BULL'
      ? input.price >= gap.gapLow - input.atr20 * 0.2 && input.price <= gap.gapHigh + input.atr20 * 0.2
      : input.price <= gap.gapHigh + input.atr20 * 0.2 && input.price >= gap.gapLow - input.atr20 * 0.2)
    : false;
  const hasStructure = atOb || atFvg;
  const structureLow = ob && atOb ? ob.low : gap && atFvg ? gap.gapLow : null;
  const structureHigh = ob && atOb ? ob.high : gap && atFvg ? gap.gapHigh : null;
  const entry = input.price;
  const rawStop = structureLow !== null && structureHigh !== null
    ? (dir === 'BULL' ? structureLow - input.atr20 * STOP_BUFFER_ATR : structureHigh + input.atr20 * STOP_BUFFER_ATR)
    : (dir === 'BULL' ? entry - input.atr20 * NOISE_FLOOR_ATR : entry + input.atr20 * NOISE_FLOOR_ATR);
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = hasStructure ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const fvgSizeOk = fvgAligned && gap ? (gap.gapHigh - gap.gapLow) >= input.atr20 * 0.25 : false;
  const structureLabel = atOb && atFvg
    ? `OB+FVG confluence`
    : atOb ? `OB entry`
    : atFvg && gap ? `FVG entry` : '';
  const rthBars = rthBarCount(input.candles.five);
  const rsiVal = rsi14(closes(input.candles.five));
  const rsiOk = dir === 'BULL' ? rsiVal < 65 : rsiVal > 35;
  const checklist = [
    pass('Directional bias', dir),
    htfTrendCheck(input),
    hasStructure
      ? pass('Structure zone', structureLabel)
      : fail('Structure zone', 'No active OB or unfilled FVG at current price'),
    atFvg && !fvgSizeOk
      ? fail('FVG quality', `Gap too small (< 0.25×ATR)`)
      : atFvg ? pass('FVG quality', `Gap size ok`) : pass('FVG quality', 'OB entry — no FVG required'),
    obReject || atFvg
      ? pass('Entry confirmation', 'Structure zone retest')
      : fail('Entry confirmation', 'No confirmation'),
    pass('VWAP context', `${input.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP (below — watch for reclaim)'} — informational`),
    pass('RVOL context', `${round(input.rvol, 2)}×${input.rvol >= 1.0 ? ' — confirmed' : ' — low'} — informational`),
    pass('RSI context', `RSI ${round(rsiVal, 1)}${rsiOk ? ' — not extended ✓' : ' — extended, watch'} — informational`),
    pass('RTH bars', `${rthBars} bars${rthBars >= 5 ? ' ✓' : ' — early session'} — informational`),
    pass('ADR room', `${adrExhausted(input.candles.five, input.atr20) ? '>80% ATR used — watch' : '< 80% ATR used ✓'} — informational`),
    ema1mCheck(input),
  ];
  return signal('ob_fvg_retest', input, checklist, tradePlan, 'S5: OB or FVG retest — either zone qualifies. FVG must be ≥0.25×ATR. OB needs rejection candle.');
}

export function evaluateMssBreakout(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('mss_breakout', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 22) {
    return signal('mss_breakout', input, [fail('Data', 'Need 22+ bars')], null, 'Insufficient candle data.');
  }
  const refBars = five.slice(-22, -6);
  const protectedHigh = Math.max(...refBars.map((c) => c.high));
  const protectedLow = Math.min(...refBars.map((c) => c.low));
  const recentSix = five.slice(-6);
  const mssOk = dir === 'BULL'
    ? recentSix.some((c) => c.close > protectedHigh)
    : recentSix.some((c) => c.close < protectedLow);
  const bar2Ok = mssOk && (
    dir === 'BULL'
      ? input.price > protectedHigh - input.atr20 * 1.0
      : input.price < protectedLow + input.atr20 * 1.0
  );
  const aheadOb = findOrderBlockZone(five, dir === 'BULL' ? 'BEAR' : 'BULL', 1.1, 60);
  const zoneBlocked = aheadOb
    ? (dir === 'BULL'
        ? input.price < aheadOb.low && aheadOb.low <= input.price + input.atr20 * 1
        : input.price > aheadOb.high && aheadOb.high >= input.price - input.atr20 * 1)
    : false;
  const volOk = input.rvol >= 0.8;
  const entry = input.price;
  const swingStop = dir === 'BULL'
    ? Math.min(...five.slice(-5).map((c) => c.low)) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(...five.slice(-5).map((c) => c.high)) + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(dir, entry, swingStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = mssOk && !zoneBlocked ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    mssOk ? pass('MSS detected', 'Structural high/low broken') : fail('MSS detected', 'Waiting for break'),
    pass('Bar-2 hold', `${bar2Ok ? 'MSS level maintained ✓' : 'Price extended from break — watch'} — informational`),
    !zoneBlocked ? pass('Zone clearance', 'Clear path ahead') : fail('Zone clearance', 'Overhead OB blocking'),
    pass('VWAP context', `${input.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP side mismatch — watch'} — informational`),
    pass('RVOL', `${round(input.rvol, 2)}×${input.rvol >= 1.0 ? ' ✓' : ' — low vol structural break'} — informational`),
    ema1mCheck(input),
  ];
  return signal('mss_breakout', input, checklist, tradePlan, 'S6 MSS: structural break + clear path. Hard gates: direction, mssOk, zoneBlocked. bar2Ok + RVOL informational.');
}

function checkS7VolumeSurge(input: StrategyInput): StrategySignal | null {
  const { candles, direction, atr20, price } = input;
  const bar = last(candles.five);
  if (!bar || !directionOk(input) || candles.five.length < 10) return null;

  // Compute average 5m bar volume from last 20 bars (excluding current)
  const volSample = candles.five.slice(-21, -1);
  const avgVol = volSample.length ? volSample.reduce((s, c) => s + c.volume, 0) / volSample.length : 0;
  if (avgVol <= 0) return null;
  const volSpike = bar.volume > avgVol * 2.0; // 2× avg = institutional surge
  const prev3 = candles.five.slice(-4, -1); // 3 bars BEFORE current — prior range
  if (prev3.length < 3) return null;

  const high15m = Math.max(...prev3.map(b => b.high));
  const low15m = Math.min(...prev3.map(b => b.low));
  const isBreakout = direction === 'BULL' ? price > high15m : price < low15m;
  
  if (volSpike && isBreakout) {
    const rawStop = direction === 'BULL' ? bar.low : bar.high;
    const stop = noiseFlooredStop(direction as 'BULL' | 'BEAR', price, rawStop, atr20);
    const risk = Math.abs(price - stop);
    const t1 = direction === 'BULL' ? price + risk * T1_RR : price - risk * T1_RR;
    const t2 = direction === 'BULL' ? price + risk * PREFERRED_RR : price - risk * PREFERRED_RR;
    const tradePlan = planFromLevelsT1T2(input, price, stop, t1, t2, bar);
    const checklist = [
      pass('Directional bias', direction),
      volSpike ? pass('Volume surge ≥2×', `${round(bar.volume / avgVol, 1)}× avg ✓`) : fail('Volume surge ≥2×', `${round(bar.volume / avgVol, 1)}× — need ≥2×`),
      isBreakout ? pass('15m range break', `${direction === 'BULL' ? 'Above' : 'Below'} 15m range`) : fail('15m range break', 'No breakout'),
      !adrExhausted(input.candles.five, input.atr20) ? pass('ADR room', '< 80% ATR used') : fail('ADR room', '>80% ATR used'),
      pass('VWAP context', `${input.vwapAligned ? (direction === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'Near VWAP — surge is primary signal'} — informational`),
    ];
    const sig = signal('s7_volume_surge', input, checklist, tradePlan, 'S7: Institutional 2× volume surge on 15m range break.');
    // Pre-blackout gap fire: allow S7 to fire at 9:30–9:45 AM on strong gap days (>3% gap + live data)
    if (
      sig.stage === 'locked' &&
      sessionGate() === 'blackout' &&
      input.dataStatus.mode === 'live' && !input.dataStatus.stale &&
      ((direction === 'BULL' && input.gapPct >= 3) || (direction === 'BEAR' && input.gapPct <= -3))
    ) {
      return { ...sig, stage: 'trade_ready' as const };
    }
    return sig;
  }
  return null;
}

// ─── S8: EMA20 Bounce ────────────────────────────────────────────────────────
// Trend-continuation entry when price pulls back to the 5m EMA20, holds, and a
// recovery candle closes back above it. EMA must be sloping in trend direction
// so we avoid mean-reversion traps on flat/declining EMAs.
// Hard gates: direction, emaRising, touchedEma, reclaimed.
export function evaluateEma20Bounce(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('ema20_bounce', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 22 || !trigger) {
    return signal('ema20_bounce', input, [fail('Data', 'Need 22+ 5m bars')], null, 'Insufficient candle data.');
  }

  const ema20Series = ema(closes(five), 20);
  const ema20Now = last(ema20Series);
  const ema20Prev3 = ema20Series[ema20Series.length - 4];
  if (!Number.isFinite(ema20Now) || !Number.isFinite(ema20Prev3)) {
    return signal('ema20_bounce', input, [fail('Data', 'EMA20 unavailable')], null, 'EMA20 computation failed.');
  }

  const emaRising = dir === 'BULL' ? ema20Now > ema20Prev3 : ema20Now < ema20Prev3;
  const tolerance = input.atr20 * 0.3;
  const recent3 = five.slice(-4, -1);
  const touchedEma = dir === 'BULL'
    ? recent3.some((c) => c.low <= ema20Now + tolerance)
    : recent3.some((c) => c.high >= ema20Now - tolerance);
  const reclaimed = dir === 'BULL' ? trigger.close > ema20Now : trigger.close < ema20Now;

  const entry = input.price;
  const swingStop = dir === 'BULL'
    ? Math.min(...five.slice(-4).map((c) => c.low)) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(...five.slice(-4).map((c) => c.high)) + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(dir, entry, swingStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = emaRising && touchedEma && reclaimed
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    emaRising
      ? pass('EMA slope', `EMA20 ${dir === 'BULL' ? 'rising' : 'falling'} ✓`)
      : fail('EMA slope', `EMA20 ${dir === 'BULL' ? 'flat/falling — mean-reversion risk' : 'flat/rising — mean-reversion risk'}`),
    touchedEma
      ? pass('EMA touch', `Recent bar tested EMA20 (${round(ema20Now, 2)})`)
      : fail('EMA touch', `No touch of EMA20 (${round(ema20Now, 2)}) in last 3 bars`),
    reclaimed
      ? pass('Recovery candle', `Close ${dir === 'BULL' ? 'above' : 'below'} EMA20 ✓`)
      : fail('Recovery candle', 'Waiting for bar to close back through EMA20'),
    htfTrendCheck(input),
    pass('VWAP context', `${input.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP misaligned — watch'} — informational`),
    pass('RVOL', `${round(input.rvol, 2)}× ${input.rvol >= 0.8 ? '✓' : '— low vol bounce'} — informational`),
    ema1mCheck(input),
  ];

  return signal('ema20_bounce', input, checklist, tradePlan,
    'S8 EMA20 bounce: rising EMA20 touched + recovery close. Hard gates: direction, emaRising, touchedEma, reclaimed.');
}

// ─── S9: Flag Break ───────────────────────────────────────────────────────────
// Tight consolidation (< 1×ATR range over 7 bars) followed by a 5m bar that
// closes above the flag high (BULL) or below the flag low (BEAR) with RVOL ≥ 1.0.
// Fires on any timeframe flag — opening drive, mid-session coil, post-spike base.
// Hard gates: direction, flagFormed, breakout, rvolOk.
export function evaluateFlagBreak(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('flag_break', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 12 || !trigger) {
    return signal('flag_break', input, [fail('Data', 'Need 12+ 5m bars')], null, 'Insufficient candle data.');
  }

  const flagBars = five.slice(-8, -1); // 7 closed bars before trigger
  const flagHigh = Math.max(...flagBars.map((c) => c.high));
  const flagLow = Math.min(...flagBars.map((c) => c.low));
  const flagRange = flagHigh - flagLow;

  const flagFormed = flagRange < input.atr20 * 1.0;
  const breakout = dir === 'BULL' ? trigger.close > flagHigh : trigger.close < flagLow;
  const rvolOk = input.rvol >= 1.0;

  const entry = input.price;
  const rawStop = dir === 'BULL'
    ? flagLow - input.atr20 * STOP_BUFFER_ATR
    : flagHigh + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = flagFormed && breakout && rvolOk
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    flagFormed
      ? pass('Flag formed', `Range ${round(flagRange, 2)} < 1×ATR (${round(input.atr20, 2)}) ✓`)
      : fail('Flag formed', `Range ${round(flagRange, 2)} too wide — needs < ${round(input.atr20, 2)} (1×ATR)`),
    breakout
      ? pass('Flag break', `Close ${dir === 'BULL' ? 'above flag high' : 'below flag low'} (${round(dir === 'BULL' ? flagHigh : flagLow, 2)}) ✓`)
      : fail('Flag break', `Waiting for close ${dir === 'BULL' ? 'above' : 'below'} ${round(dir === 'BULL' ? flagHigh : flagLow, 2)}`),
    rvolOk
      ? pass('Volume expansion', `${round(input.rvol, 2)}× RVOL ✓`)
      : fail('Volume expansion', `${round(input.rvol, 2)}× RVOL — needs ≥1.0× on breakout`),
    htfTrendCheck(input),
    pass('VWAP context', `${input.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP misaligned — watch'} — informational`),
    ema1mCheck(input),
  ];

  return signal('flag_break', input, checklist, tradePlan,
    'S9 Flag Break: 7-bar compression < 1×ATR + close through flag + RVOL≥1.0. Hard gates: direction, flagFormed, breakout, rvolOk.');
}

const SYMBOL_STRATEGY_EXCLUSIONS: Partial<Record<string, StrategyId[]>> = {
  TSLA: ['vwap_pullback', 'rs_continuation'],
};

export function evaluateStrategies(input: StrategyInput): StrategySignal[] {
  const excluded = SYMBOL_STRATEGY_EXCLUSIONS[input.symbol] ?? [];
  const signals = [
    evaluateOrbRetest(input),
    evaluateVwapPullback(input),
    evaluateRsContinuation(input),
    evaluateLiquiditySweep(input),
    evaluateObFvgRetest(input),
    evaluateMssBreakout(input),
    checkS7VolumeSurge(input),
    evaluateEma20Bounce(input),
    evaluateFlagBreak(input),
  ].filter((s): s is StrategySignal => s !== null);

  return signals
    .filter((sig) => !excluded.includes(sig.strategyId))
    .sort((a, b) => workflowStageRank(b.stage) - workflowStageRank(a.stage) || b.confidence - a.confidence);
}
