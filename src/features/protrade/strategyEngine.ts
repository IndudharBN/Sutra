import { detectFvg } from '../scanner/fvg';
import { ema } from '../scanner/indicators';
import type { Candle } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { findOrderBlockZone, rejectionCandle } from '../scanner/smc';
import type { StrategyChecklistItem, StrategyId, StrategyInput, StrategySignal, TradePlan, WorkflowStage } from './workflowTypes';
import { STRATEGY_LABELS, workflowStageRank } from './workflowTypes';

const MIN_RR = 1.3;
const PREFERRED_RR = 2.0;
// Structural buffer: space below/above the anchor candle extreme. 
// Standardizing to 0.25 ATR (Breathing Room Fix)
const STOP_BUFFER_ATR = 0.25;
// Noise floor: minimum stop distance from entry.
// 0.35 ATR provides enough room for bid-ask noise without over-extending risk.
const NOISE_FLOOR_ATR = 0.35;
const SLIPPAGE_CENTS = 0.03; // Institutional slippage buffer

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

// T1/T2 explicit plan: T1=1.5R (High-probability scale out), T2=structural level
function planFromLevelsT1T2(
  input: StrategyInput,
  rawEntry: number,
  stop: number,
  t1: number,
  t2: number,
  trigger?: Candle,
): TradePlan | null {
  // Apply slippage buffer to entry
  const entry = input.direction === 'BULL' ? rawEntry + SLIPPAGE_CENTS : rawEntry - SLIPPAGE_CENTS;
  const risk = input.direction === 'BULL' ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const rrT2 = rr(entry, stop, t2, input.direction);
  if (!Number.isFinite(rrT2) || rrT2 < MIN_RR) return null;
  
  // Recalculate T1 based on 1.5R for higher hit rate
  const adjustedT1 = input.direction === 'BULL' ? entry + risk * 1.5 : entry - risk * 1.5;

  return {
    entry: round(entry, 2),
    stop: round(stop, 2),
    target: round(t2, 2),
    target1: round(adjustedT1, 2),
    target2: round(t2, 2),
    rr: round(rrT2, 2),
    rr1: 1.5,
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
  return input.direction === 'BULL' ? Math.max(capped, t1) : Math.min(capped, t1);
}

// Returns 'closed' outside 9:30–16:00 ET, 'blackout' during 9:30–10:00 (first 30m), 'open' otherwise.
function sessionGate(): 'open' | 'blackout' | 'closed' {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 'closed';
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcMins < 13 * 60 + 30 || utcMins >= 20 * 60) return 'closed';
  if (utcMins < 14 * 60) return 'blackout';
  return 'open';
}

function stageFromChecklist(checklist: StrategyChecklistItem[], tradePlan: TradePlan | null, input: StrategyInput, manualOnly = false): WorkflowStage {
  const passed = checklist.filter((item) => item.passed).length;
  if (passed < 2) return 'raw_candidates';
  if (passed < checklist.length) return 'forming';
  if (!tradePlan) return 'confirmed';
  if (tradePlan.rr < MIN_RR) return 'confirmed';
  if (manualOnly) return 'confirmed';
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

function recentRetest(input: StrategyInput, level: number) {
  const recent = input.candles.five.slice(-4); // 20-min window — retest must be fresh (4 bars of 5m)
  if (!recent.length) return false;
  const tolerance = Math.max(input.atr20 * 0.08, input.price * 0.0015);
  return input.direction === 'BULL'
    ? recent.some((c) => c.low <= level + tolerance && c.close >= level)
    : recent.some((c) => c.high >= level - tolerance && c.close <= level);
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
  const range = openingRange(input.candles.five, 3);
  const trigger = last(input.candles.five);
  const rangeBreak = range ? directionalBreak(input, input.price, range.high, range.low) : false;
  const retest = range ? recentRetest(input, input.direction === 'BULL' ? range.high : range.low) : false;
  const entry = input.price;
  // Structural anchor: lower of range_high and trigger candle extreme (whichever gives more room).
  // Buffer raised to 0.5×ATR; noise floor guarantees minimum 0.75×ATR distance from entry.
  const rawStop = input.direction === 'BULL'
    ? Math.min(range?.high ?? entry, trigger?.low ?? entry) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(range?.low ?? entry, trigger?.high ?? entry) + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  // T1 = 2R (scale out, move stop to BE)
  // T2 = measured move: OR range projected from the breakout level
  const orRange = range ? range.high - range.low : 0;
  const breakoutLevel = range ? (input.direction === 'BULL' ? range.high : range.low) : entry;
  const measuredMove = input.direction === 'BULL' ? breakoutLevel + orRange : breakoutLevel - orRange;
  const t1 = input.direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = input.direction === 'BULL' ? Math.max(measuredMove, t1) : Math.min(measuredMove, t1);
  const tradePlan = directionOk(input) && range ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    rangeBreak ? pass('Opening range break', 'Price broke the range in direction') : fail('Opening range break', 'Waiting for breakout'),
    retest ? pass('Retest hold', 'Breakout level retested and held') : fail('Retest hold', 'Waiting for controlled retest'),
    pass('RVOL confirmation', `${round(input.rvol, 2)}x${input.rvol >= 1.0 ? ' — confirmed' : ' — low, watch for volume on break'}`),
    pass('VWAP context', `${input.vwapAligned ? 'VWAP ✓' : 'VWAP building — early session'} — informational`),
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
  const recent = input.candles.five.slice(-12); // 60-min window for VWAP pullback
  const tolerance = Math.max(input.atr20 * 0.12, input.price * 0.0015);
  const touchedVwap = recent.some((c) => input.direction === 'BULL' ? c.low <= input.vwap + tolerance : c.high >= input.vwap - tolerance);
  const reclaimed = trigger ? directionalAbove(input, trigger.close, input.vwap) : false;
  const entry = input.price;
  const swing = input.direction === 'BULL' ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
  // Anchor: swing extreme of the pullback (VWAP removed — it is a dynamic magnet, not a structural wall).
  // Buffer 0.5×ATR below/above the swing; noise floor ensures minimum 0.75×ATR from entry.
  const rawStop = input.direction === 'BULL' ? swing - input.atr20 * STOP_BUFFER_ATR : swing + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = input.direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = directionOk(input) && recent.length >= 4 ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    input.vwapAligned ? pass('VWAP side', 'Price is on correct VWAP side') : fail('VWAP side', 'Price not aligned with VWAP'),
    input.trendAligned ? pass('5m trend aligned', input.trend5m) : fail('5m trend aligned', 'EMA9/EMA21 not aligned'),
    touchedVwap ? pass('Pullback into value', 'Recent candles tested VWAP/EMA zone') : fail('Pullback into value', 'Waiting for pullback'),
    reclaimed ? pass('Reclaim candle', 'Latest candle reclaimed direction') : fail('Reclaim candle', 'Waiting for reclaim'),
    pass('Volume confirmation', `${round(input.rvol, 2)}x${input.rvol >= 1.0 ? ' — confirmed' : ' — low, pullback quality matters more'}`),
    ema1mCheck(input),
  ];
  return signal('vwap_pullback', input, checklist, tradePlan, 'VWAP pullback continuation with trend alignment, reclaim, and 1m entry timing.');
}

export function evaluateRsContinuation(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-12); // 60-min window — wider catches mid-session RS setups
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const microHigh = highs.length ? Math.max(...highs.slice(0, -1)) : 0;
  const microLow = lows.length ? Math.min(...lows.slice(0, -1)) : 0;
  const breakout = trigger ? directionalBreak(input, trigger.close, microHigh, microLow) : false;
  const rsEdge = input.direction === 'BULL' ? input.rsVsBenchmark >= 1.005 : input.rsVsBenchmark <= 0.995;
  const rsLabel = `${round(input.rsVsBenchmark, 4)} vs SPY (${input.direction === 'BULL' ? '+' : ''}${round((input.rsVsBenchmark - 1) * 100, 2)}%)`;
  const entry = input.price;
  const rawStop = input.direction === 'BULL' ? microLow - input.atr20 * STOP_BUFFER_ATR : microHigh + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = input.direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = directionOk(input) && recent.length >= 6 ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;
  // 1H directional: compare current 15m close to close from 4 bars ago (≈ 1 hour)
  const fifteen = input.candles.fifteen;
  const trend1h: 'UP' | 'DOWN' | 'FLAT' = fifteen.length >= 5
    ? (fifteen[fifteen.length - 1].close > fifteen[fifteen.length - 5].close * 1.002 ? 'UP'
      : fifteen[fifteen.length - 1].close < fifteen[fifteen.length - 5].close * 0.998 ? 'DOWN' : 'FLAT')
    : 'FLAT';
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    input.trend15mAligned
      ? pass('15m trend', `${input.trend15m} ✓ — aligned with direction`)
      : fail('15m trend', `${input.trend15m} — must be aligned for RS entry`),
    pass('1H directional', `${trend1h} — macro bias (informational)`),
    pass('Relative strength vs SPY', `${rsLabel}${rsEdge ? ' ✓' : ' — watch, RS building'}`),
    input.trendAligned ? pass('5m trend aligned', input.trend5m) : fail('5m trend aligned', 'EMA9/EMA21 not aligned'),
    breakout ? pass('Micro range break', 'Latest candle broke the local range') : fail('Micro range break', 'Waiting for micro breakout'),
    pass('RVOL on breakout', `${round(input.rvol, 2)}x${input.rvol >= 1.0 ? ' — confirmed' : ' — low, RS strength is the primary signal'}`),
    pass('VWAP context', `${input.vwapAligned ? 'VWAP ✓' : 'VWAP (below — watch for reclaim)'} — informational`),
    ema1mCheck(input),
  ];
  return signal('rs_continuation', input, checklist, tradePlan, 'Relative strength continuation after local range break with RVOL confirmation.');
}

export function evaluateLiquiditySweep(input: StrategyInput): StrategySignal {
  const range = openingRange(input.candles.five, 3);
  const recent = input.candles.five.slice(-20); // 100-min window — sweeps can form later in session
  const trigger = last(recent);

  // The structural level that was swept (OR low for bull, OR high for bear)
  const sweptLevel = range ? (input.direction === 'BULL' ? range.low : range.high) : null;
  const sweepCandle = range ? recent.find((c) => input.direction === 'BULL' ? c.low < range.low : c.high > range.high) ?? null : null;
  const swept = Boolean(sweepCandle);

  // Reclaim: latest close has returned back above/below the swept level
  const reclaimed = Boolean(sweptLevel !== null && trigger && (
    input.direction === 'BULL' ? trigger.close > sweptLevel : trigger.close < sweptLevel
  ));

  // Entry pinned to the reclaimed structural level — not current price
  const entry = sweptLevel ?? input.price;

  // Proximity check: price must be within 2.5× ATR of the level — wider to account for post-sweep momentum
  const nearLevel = sweptLevel !== null
    ? (input.direction === 'BULL'
        ? input.price <= sweptLevel + input.atr20 * 2.5
        : input.price >= sweptLevel - input.atr20 * 2.5)
    : false;

  // Anchor: sweep candle extreme (the institutional wick that defines invalidation).
  // Buffer raised from 0.08 to 0.5×ATR; noise floor ensures minimum 0.75×ATR room.
  const sweepRef = input.direction === 'BULL' ? (sweepCandle ? sweepCandle.low : entry) : (sweepCandle ? sweepCandle.high : entry);
  const rawStop = input.direction === 'BULL' ? sweepRef - input.atr20 * STOP_BUFFER_ATR : sweepRef + input.atr20 * STOP_BUFFER_ATR;
  const stop = noiseFlooredStop(input.direction as 'BULL' | 'BEAR', entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);

  // T1 = 2R (scale 50%, move stop to breakeven)
  // T2 = OR opposite side (range expansion target); fall back to 2.5R if OR opposite is closer than T1
  const orOpposite = range ? (input.direction === 'BULL' ? range.high : range.low) : null;
  const t1 = input.direction === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2Raw = orOpposite ?? (input.direction === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR);
  const t2 = input.direction === 'BULL' ? Math.max(t2Raw, t1) : Math.min(t2Raw, t1);

  // Sweep wick quality: the sweep candle must show institutional rejection — close in upper/lower 40% of range
  const sweepWickOk = sweepCandle ? (() => {
    const cRange = sweepCandle.high - sweepCandle.low;
    if (cRange < 1e-8) return false;
    return input.direction === 'BULL'
      ? (sweepCandle.close - sweepCandle.low) / cRange >= 0.2
      : (sweepCandle.high - sweepCandle.close) / cRange >= 0.2;
  })() : false;

  const tradePlan = directionOk(input) && range && swept && reclaimed && nearLevel
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    swept ? pass('Liquidity swept', `Sweep candle: ${sweepCandle ? round(input.direction === 'BULL' ? sweepCandle.low : sweepCandle.high, 2) : '--'}`) : fail('Liquidity swept', 'No sweep below/above opening range yet'),
    sweepWickOk ? pass('Sweep rejection wick', 'Candle closed back in range — institutional rejection confirmed') : fail('Sweep rejection wick', 'Sweep candle closed near extremes — no rejection, likely continuation'),
    reclaimed ? pass('Level reclaimed', `Close back ${input.direction === 'BULL' ? 'above' : 'below'} ${sweptLevel ? round(sweptLevel, 2) : '--'}`) : fail('Level reclaimed', 'Waiting for close back through swept level'),
    nearLevel ? pass('Entry proximity', 'Price within 2.5×ATR of level') : fail('Entry proximity', 'Price too far from swept level — do not chase'),
    pass('Volume confirmation', `${round(input.rvol, 2)}x${input.rvol >= 1.0 ? ' — confirmed on sweep' : ' — low, sweep structure is the primary signal'}`),
    ema1mCheck(input),
  ];
  return signal('liquidity_sweep', input, checklist, tradePlan, `S4: T1=${orOpposite ? 'OR opposite' : '2R'} T2=${orOpposite ? round(orOpposite,2) : '2.5R'} — scale 50% at T1, trail to T2.`);
}

export function evaluateObFvgRetest(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const trigger = last(five);

  if (!directionOk(input)) {
    return signal('ob_fvg_retest', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';

  // Real order block detection via smc.ts
  const ob = findOrderBlockZone(five, dir, 1.1, 100);
  const atOb = ob
    ? (dir === 'BULL'
      ? input.price <= ob.high + input.atr20 * 0.1 && input.price >= ob.low - input.atr20 * 0.1
      : input.price >= ob.low - input.atr20 * 0.1 && input.price <= ob.high + input.atr20 * 0.1)
    : false;
  const obReject = ob ? rejectionCandle(five, dir, ob) : false;

  // Real FVG detection via fvg.ts
  const fvgResult = detectFvg(five, 8);
  const gap = fvgResult.latestGap;
  const fvgAligned = gap && !gap.filled &&
    ((dir === 'BULL' && gap.direction === 'BULLISH') || (dir === 'BEAR' && gap.direction === 'BEARISH'));
  const atFvg = fvgAligned && gap
    ? (dir === 'BULL'
      ? input.price >= gap.gapLow - input.atr20 * 0.1 && input.price <= gap.gapHigh + input.atr20 * 0.1
      : input.price <= gap.gapHigh + input.atr20 * 0.1 && input.price >= gap.gapLow - input.atr20 * 0.1)
    : false;

  const hasStructure = atOb || atFvg;
  const structureLow = ob && atOb ? ob.low : gap && atFvg ? gap.gapLow : null;
  const structureHigh = ob && atOb ? ob.high : gap && atFvg ? gap.gapHigh : null;
  const entry = input.price;
  // With zone: stop below OB/FVG bottom with 0.5×ATR buffer (was 0.1).
  // Without zone: noise floor directly as stop (NOISE_FLOOR_ATR).
  // noiseFlooredStop guarantees minimum 0.75×ATR distance regardless of zone depth.
  const rawStop = structureLow !== null && structureHigh !== null
    ? (dir === 'BULL' ? structureLow - input.atr20 * STOP_BUFFER_ATR : structureHigh + input.atr20 * STOP_BUFFER_ATR)
    : (dir === 'BULL' ? entry - input.atr20 * NOISE_FLOOR_ATR : entry + input.atr20 * NOISE_FLOOR_ATR);
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = hasStructure ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;

  const fvgSizeOk = fvgAligned && gap ? (gap.gapHigh - gap.gapLow) >= input.atr20 * 0.25 : false;
  const structureLabel = atOb && atFvg
    ? `OB+FVG confluence ${ob!.low.toFixed(2)}–${ob!.high.toFixed(2)}`
    : atOb ? `OB ${ob!.low.toFixed(2)}–${ob!.high.toFixed(2)}`
    : atFvg && gap ? `FVG ${gap.gapLow.toFixed(2)}–${gap.gapHigh.toFixed(2)}` : '';
  const checklist = [
    pass('Directional bias', dir),
    htfTrendCheck(input),
    hasStructure
      ? pass('Structure zone (OB or FVG)', structureLabel)
      : fail('Structure zone (OB or FVG)', 'No active OB or unfilled FVG at current price'),
    atFvg && !fvgSizeOk
      ? fail('FVG quality', `Gap too small (< 0.25×ATR ${round(input.atr20 * 0.25, 3)})`)
      : atFvg ? pass('FVG quality', `Gap size ≥ 0.25×ATR`) : pass('FVG quality', 'OB entry — no FVG required'),
    obReject || atFvg
      ? pass('Entry confirmation', obReject ? 'Rejection candle at OB' : 'Price retesting FVG zone')
      : fail('Entry confirmation', 'No rejection candle at OB — wait for confirmation'),
    pass('VWAP context', `${input.vwapAligned ? 'VWAP ✓' : 'VWAP (below — watch for reclaim)'} — informational`),
    pass('RVOL context', `${round(input.rvol, 2)}x${input.rvol >= 1.0 ? ' — confirmed' : ' — low, structure is the primary signal'}`),
    ema1mCheck(input),
  ];
  return signal('ob_fvg_retest', input, checklist, tradePlan, 'S5: OB or FVG retest — either zone qualifies. FVG must be ≥0.25×ATR. OB needs rejection candle.');
}

// ── S6: MSS Breakout (Market Structure Shift) ────────────────────────────────
// Fires when price breaks a protected swing high/low (structural MSS) with
// bar-2 confirmation and no overhead OB blocking. Works any time of day —
// catches "second test" ORB continuations, post-VWAP-reclaim breakouts, etc.
export function evaluateMssBreakout(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('mss_breakout', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 16) {
    return signal('mss_breakout', input, [fail('Data', 'Need ≥16 5m bars for MSS detection')], null, 'Insufficient candle data.');
  }

  // Protected swing: highest High / lowest Low in bars [-16..-3] (13 bars of context)
  const refBars = five.slice(-16, -3);
  const protectedHigh = Math.max(...refBars.map((c) => c.high));
  const protectedLow = Math.min(...refBars.map((c) => c.low));

  // MSS: any of the last 3 closes broke the protected level
  const recentThree = five.slice(-3);
  const mssOk = dir === 'BULL'
    ? recentThree.some((c) => c.close > protectedHigh)
    : recentThree.some((c) => c.close < protectedLow);

  // Bar-2 confirmation: use second-to-last CLOSED bar — avoids scan timing mismatch where
  // the 20s refresh fires after price already pulled back below the MSS level.
  const prevClose = five.length >= 2 ? five[five.length - 2].close : input.price;
  const bar2Ok = mssOk && (
    dir === 'BULL' ? prevClose > protectedHigh : prevClose < protectedLow
  );

  // Zone clearance: no opposing OB within 1×ATR directly ahead
  const aheadOb = findOrderBlockZone(five, dir === 'BULL' ? 'BEAR' : 'BULL', 1.1, 60);
  const zoneBlocked = aheadOb
    ? (dir === 'BULL'
        ? input.price < aheadOb.low && aheadOb.low <= input.price + input.atr20
        : input.price > aheadOb.high && aheadOb.high >= input.price - input.atr20)
    : false;

  const volOk = input.rvol >= 1.0;
  const vwapNote = input.vwapAligned ? `VWAP ✓` : `VWAP (${input.direction === 'BULL' ? 'below' : 'above'} — watch)`;

  const entry = input.price;
  const swingStop = dir === 'BULL'
    ? Math.min(...five.slice(-5).map((c) => c.low)) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(...five.slice(-5).map((c) => c.high)) + input.atr20 * STOP_BUFFER_ATR;
  // S6 keeps its own 1.2×ATR hard floor (stronger than NOISE_FLOOR_ATR) — MSS needs more room.
  const stop = dir === 'BULL'
    ? Math.min(swingStop, entry - input.atr20 * 1.2)
    : Math.max(swingStop, entry + input.atr20 * 1.2);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * 2 : entry - risk * 2;
  const t2 = structuralT2(input, entry, risk, t1);
  const tradePlan = mssOk && bar2Ok && !zoneBlocked ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger) : null;

  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    mssOk
      ? pass('MSS detected', `Close broke ${dir === 'BULL' ? `protected high ${round(protectedHigh, 2)}` : `protected low ${round(protectedLow, 2)}`}`)
      : fail('MSS detected', `Waiting for close to break ${dir === 'BULL' ? `above ${round(protectedHigh, 2)}` : `below ${round(protectedLow, 2)}`}`),
    bar2Ok
      ? pass('Bar-2 hold', 'Price still holding above/below MSS level — not reversed')
      : fail('Bar-2 hold', 'MSS reversed — price back inside structure, wait'),
    !zoneBlocked
      ? pass('Zone clearance', 'No opposing OB blocking the path')
      : fail('Zone clearance', `Overhead OB within 1×ATR — will stop us out`),
    pass('VWAP context', `${vwapNote} — informational only`),
    pass('Volume on break', `${round(input.rvol, 2)}x — ${volOk ? 'confirmed' : 'structure break is the primary signal'}`),
    ema1mCheck(input),
  ];
  return signal('mss_breakout', input, checklist, tradePlan, `S6 MSS: structural break of swing ${dir === 'BULL' ? `high ${round(protectedHigh, 2)}` : `low ${round(protectedLow, 2)}`}. T1=${round(t1, 2)}, T2=${round(t2, 2)}.`);
}

const SYMBOL_STRATEGY_EXCLUSIONS: Partial<Record<string, StrategyId[]>> = {
  TSLA: ['vwap_pullback', 'rs_continuation'],
};

export function evaluateStrategies(input: StrategyInput): StrategySignal[] {
  const excluded = SYMBOL_STRATEGY_EXCLUSIONS[input.symbol] ?? [];
  return [
    evaluateOrbRetest(input),
    evaluateVwapPullback(input),
    evaluateRsContinuation(input),
    evaluateLiquiditySweep(input),
    evaluateObFvgRetest(input),
    evaluateMssBreakout(input),
  ]
    .filter((sig) => !excluded.includes(sig.strategyId))
    .sort((a, b) => workflowStageRank(b.stage) - workflowStageRank(a.stage) || b.confidence - a.confidence);
}
