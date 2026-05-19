import { detectFvg } from '../scanner/fvg';
import { ema, sessionCandles } from '../scanner/indicators';
import type { Candle } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { findOrderBlockZone, rejectionCandle } from '../scanner/smc';
import type { StrategyChecklistItem, StrategyId, StrategyInput, StrategySignal, TradePlan, WorkflowStage } from './workflowTypes';
import { STRATEGY_LABELS, workflowStageRank } from './workflowTypes';

const MIN_RR = 1.5;
const PREFERRED_RR = 2.5;
const T1_RR = 1.5;           // scale out 50% at T1, SL → entry (BE), then → T1 on pullback confirm
const STOP_BUFFER_ATR = 0.5; // breathing room beyond anchor extreme
const MIN_STOP_ATR = 0.5;    // stop must be ≥ 50% of daily ATR from entry
const MIN_STOP_PCT = 0.005;  // stop must be ≥ 0.5% of price — catches atr20=0 (no daily data)

function noiseFloor(vixLevel?: number | null) {
  if (!vixLevel) return 0.75;
  if (vixLevel > 28) return 1.5;
  if (vixLevel > 22) return 1.0;
  if (vixLevel < 14) return 0.5;
  return 0.75;
}

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
function noiseFlooredStop(direction: 'BULL' | 'BEAR', entry: number, rawStop: number, atr20: number, vixLevel?: number | null): number {
  const nf = noiseFloor(vixLevel);
  const floor = direction === 'BULL' ? entry - atr20 * nf : entry + atr20 * nf;
  return direction === 'BULL' ? Math.min(rawStop, floor) : Math.max(rawStop, floor);
}

// Hard minimum stop distance — prevents $0.01-$0.07 stops when atr20 is near-zero
// or structural zone (OB/FVG/sweep) sits too close to entry.
// Takes the looser of: structural stop vs. min-distance floor (more room wins).
function enforceMinStop(direction: 'BULL' | 'BEAR', entry: number, stop: number, atr20: number): number {
  const minDist = Math.max(atr20 * MIN_STOP_ATR, entry * MIN_STOP_PCT);
  if (direction === 'BULL') {
    const enforced = Math.min(stop, entry - minDist);
    // Reject zero/negative/NaN stops (bad OB zone data where ob.low = 0 or NaN)
    return Number.isFinite(enforced) && enforced > 0 ? enforced : entry - minDist;
  }
  const enforced = Math.max(stop, entry + minDist);
  return Number.isFinite(enforced) ? enforced : entry + minDist;
}

// SPY 5m tape check — for BREAKOUT strategies (S1, S3, S6, S7, S9).
// Counter-tape breakout: fails checklist → stays 'forming', not auto-traded.
function spyTapeCheck(input: StrategyInput): StrategyChecklistItem {
  const spy5m = input.spyTrend5m;
  if (!spy5m || spy5m === 'FLAT') return pass('SPY tape', 'Tape flat — no directional filter');
  if (input.direction === 'NEUTRAL') return pass('SPY tape', 'Direction undetermined — no filter');
  const aligned = input.direction === 'BULL' ? spy5m === 'UP' : spy5m === 'DOWN';
  return aligned
    ? pass('SPY tape', `SPY 5m ${spy5m} ✓ tape aligned with ${input.direction}`)
    : fail('SPY tape', `SPY 5m ${spy5m} — counter-tape: environment opposes ${input.direction} breakout`);
}

// SPY 15m session check — for PULLBACK strategies (S2, S8) and zone strategies (S4, S5).
// Pullback setups need the session to be going their way even though the 5m may dip (that's the pullback).
function spySessionCheck(input: StrategyInput): StrategyChecklistItem {
  const spy15m = input.spyTrend15m;
  if (!spy15m || spy15m === 'FLAT') return pass('SPY session', 'Session neutral — no directional filter');
  if (input.direction === 'NEUTRAL') return pass('SPY session', 'Direction undetermined — no filter');
  const aligned = input.direction === 'BULL' ? spy15m === 'UP' : spy15m === 'DOWN';
  return aligned
    ? pass('SPY session', `SPY 15m ${spy15m} ✓ session supports ${input.direction}`)
    : fail('SPY session', `SPY 15m ${spy15m} — counter-session: hostile environment for ${input.direction} pullback`);
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
  if (passed < 2) return 'screened_universe';
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
  const recent = input.candles.five.slice(-6); // 30-min window — institutional retests can take 25-30m
  if (!recent.length) return false;
  const tolerance = Math.max(input.atr20 * 0.08, input.price * 0.0015); // 8% ATR — genuine touch required, not just proximity
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

  // S1 self-determines direction from the ORB breakout side — no external Option C direction needed.
  // price > ORB high → BULL (retesting breakout from above); price < ORB low → BEAR.
  const selfDir: 'BULL' | 'BEAR' | null = range
    ? (input.price > range.high ? 'BULL' : input.price < range.low ? 'BEAR' : null)
    : null;
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;

  const retest = range ? recentRetest(selfInput, dir === 'BULL' ? range.high : range.low) : false;
  const entry = input.price;
  // Anchor stop to the structural ORB level, not the trigger bar's low/high.
  // 1×ATR behind ORB high/low survives the liquidity sweep before the real move.
  const rawStop = dir === 'BULL'
    ? (range?.high ?? entry) - input.atr20 * 1.0
    : (range?.low ?? entry) + input.atr20 * 1.0;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  // 9:45–10:00 AM ET: first 15 min after blackout — ORB barely formed, higher noise; require stronger RVOL
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();
  const earlySession = etMins >= 9 * 60 + 45 && etMins < 10 * 60;
  const rvolMin = earlySession ? 1.5 : 1.0;
  const risk = Math.abs(entry - stop);
  const orRange = range ? range.high - range.low : 0;
  const orbWidthPct = range ? orRange / entry : 0;
  const orbWidthOk = orbWidthPct >= 0.005; // ≥0.5% of price — tighter ranges have no institutional positioning
  const breakoutLevel = range ? (dir === 'BULL' ? range.high : range.low) : entry;
  const breakoutDistance = dir === 'BULL' ? (input.price - breakoutLevel) : (breakoutLevel - input.price);
  const minBreakout = input.atr20 * 0.25;
  const confirmedBreak = breakoutDistance >= minBreakout;
  const measuredMove = dir === 'BULL' ? breakoutLevel + orRange : breakoutLevel - orRange;
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const preferredTarget = dir === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = dir === 'BULL' ? Math.max(measuredMove, preferredTarget) : Math.min(measuredMove, preferredTarget);
  const tradePlan = selfDir && range && confirmedBreak && retest && orbWidthOk ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from ORB break`) : fail('Directional bias', 'Price inside ORB — no breakout yet'),
    htfTrendCheck(selfInput),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    orbWidthOk ? pass('ORB width ≥0.5%', `${round(orbWidthPct * 100, 2)}% ✓`) : fail('ORB width ≥0.5%', `${round(orbWidthPct * 100, 2)}% — degenerate range: no institutional positioning`),
    confirmedBreak ? pass('ORB Breakout', `Clear of noise (+${round(breakoutDistance, 2)})`) : fail('ORB Breakout', `Inside noise floor (${round(minBreakout, 2)})`),
    retest ? pass('Retest hold', 'Breakout level retested and held') : fail('Retest hold', 'Waiting for controlled retest'),
    input.rvol >= rvolMin ? pass(`RVOL ≥${rvolMin}×`, `${round(input.rvol, 2)}× ✓`) : fail(`RVOL ≥${rvolMin}×`, `${round(input.rvol, 2)}× — ${earlySession ? 'early session (9:45–10:00) requires ≥1.5×' : 'ORB breakout requires RTH volume confirmation'}`),
    pass('ADR room', `${adrExhausted(input.candles.five, input.atr20) ? '>80% ATR used — watch' : '< 80% ATR used ✓'} — informational`),
    pass('VWAP context', `${selfInput.vwapAligned ? 'VWAP ✓' : 'early session'} — informational`),
    ema1mCheck(input),
    spyTapeCheck(selfInput),
  ];
  return signal('orb_retest', selfInput, checklist, tradePlan, 'S1 ORB retest: self-determined direction from ORB break + retest + ORB width ≥0.5% + stop 1×ATR behind structural level. Hard gates: selfDir, confirmedBreak, retest, orbWidthOk, rvol.', false, range ? [{
    label: 'Opening Range',
    startTime: range.startTime,
    endTime: range.endTime,
    high: range.high,
    low: range.low,
  }] : []);
}

export function evaluateVwapPullback(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-6); // 30-min window — 60-min was catching stale retests from an hour ago
  const tolerance = Math.max(input.atr20 * 0.2, input.price * 0.002);
  const ema9Series = ema(closes(input.candles.five), 9);
  const ema9 = last(ema9Series) || input.vwap; // full history for valid 9-period EMA
  const ema9Prev = ema9Series.length >= 11 ? ema9Series[ema9Series.length - 11] : null;
  const vwapSlope = ema9Prev && Number.isFinite(ema9Prev) && Number.isFinite(ema9)
    ? (ema9 - ema9Prev) / ema9Prev
    : null;

  // S2 self-determines direction from VWAP slope — immune to Option C's 5m dip mismatch at entry.
  // During the pullback the 5m trend is temporarily DOWN (that IS the setup), so VWAP+5m Option C
  // reads NEUTRAL/BEAR and blocks the entry. Slope over ~50 bars captures the session trend through the dip.
  const selfDir: 'BULL' | 'BEAR' | null = vwapSlope !== null
    ? (vwapSlope >= 0.0005 ? 'BULL' : vwapSlope <= -0.0005 ? 'BEAR' : null)
    : null;
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;

  const vwapSlopeOk = Boolean(selfDir); // flat VWAP = range session: pullback reclaims are 50/50
  const touchedValue = recent.some((c) => dir === 'BULL'
    ? (c.low <= input.vwap + tolerance || c.low <= ema9 + tolerance)
    : (c.high >= input.vwap - tolerance || c.high >= ema9 - tolerance)
  );
  const reclaimed = trigger
    ? (dir === 'BULL' ? trigger.close > Math.min(input.vwap, ema9) : trigger.close < Math.min(input.vwap, ema9))
    : false;
  const rvolOk = input.rvol >= 0.8; // dead-volume reclaims almost never hold
  const rsOk = input.rsVsBenchmark >= 1.0; // stock must lead or match SPY — laggards VWAP reclaim on a strong SPY day, then fail
  const rsLabel = `RS ${round(input.rsVsBenchmark, 4)} vs SPY${rsOk ? ' ✓' : ' — lagging'}`;
  const entry = input.price;
  const swing = dir === 'BULL' ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
  const rawStop = dir === 'BULL' ? swing - input.atr20 * STOP_BUFFER_ATR : swing + input.atr20 * STOP_BUFFER_ATR;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const tradePlan = selfDir && touchedValue && reclaimed && rvolOk && rsOk ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from VWAP slope`) : fail('Directional bias', 'VWAP flat — range session, no pullback direction'),
    htfTrendCheck(selfInput),
    touchedValue ? pass('Pullback into value', 'Recent 30m tested VWAP/EMA zone') : fail('Pullback into value', 'No fresh test in last 30m'),
    reclaimed ? pass('Reclaim candle', 'Latest candle reclaimed direction') : fail('Reclaim candle', 'Waiting for reclaim'),
    selfInput.trendAligned
      ? pass('5m trend aligned', `${selfInput.trend5m} ✓ — Phase 3 reclaim confirmed`)
      : pass('5m trend aligned', `${selfInput.trend5m} — pullback phase, reclaim pending — informational`),
    rvolOk ? pass('RVOL ≥0.8×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥0.8×', `${round(input.rvol, 2)}× — dead-volume reclaims fail`),
    pass('VWAP context', `${selfInput.vwapAligned ? 'Above VWAP ✓' : 'Near VWAP'} — informational`),
    rsOk ? pass('RS vs SPY ≥1.0×', rsLabel) : fail('RS vs SPY ≥1.0×', `${rsLabel} — laggard VWAP reclaims fail on strong SPY days`),
    vwapSlopeOk
      ? pass('VWAP slope', `${round((vwapSlope ?? 0) * 100, 3)}% over 50m — directional session ✓`)
      : fail('VWAP slope', `VWAP flat (${round((vwapSlope ?? 0) * 100, 3)}%) — range session: pullback 50/50`),
    ema1mCheck(input),
    spySessionCheck(selfInput),
  ];
  return signal('vwap_pullback', selfInput, checklist, tradePlan, 'S2 VWAP pullback: self-determined direction from VWAP slope + fresh 30m test + reclaim + RVOL≥0.8 + RS≥1.0. Hard gates: selfDir (slope ≥0.05%), touchedValue, reclaimed, rvolOk, rsOk.');
}

export function evaluateRsContinuation(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-12);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const microHigh = highs.length ? Math.max(...highs.slice(0, -1)) : 0;
  const microLow = lows.length ? Math.min(...lows.slice(0, -1)) : 0;
  // S3 self-determines direction: which side of the micro-range the trigger bar closes through
  const selfDir: 'BULL' | 'BEAR' | null = trigger
    ? (trigger.close > microHigh ? 'BULL' : trigger.close < microLow ? 'BEAR' : null)
    : null;
  const breakout = selfDir !== null; // breakout IS the direction signal — no external direction needed
  const rsEdge = selfDir === 'BULL' ? input.rsVsBenchmark >= 1.005 : selfDir === 'BEAR' ? input.rsVsBenchmark <= 0.995 : false; // 0.5% RS edge
  const rsLabel = `${round(input.rsVsBenchmark, 4)} vs SPY`;
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;
  const entry = input.price;
  const rawStop = dir === 'BULL' ? microLow - input.atr20 * STOP_BUFFER_ATR : microHigh + input.atr20 * STOP_BUFFER_ATR;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  // Guard: stop must be on the correct side of entry. Bad price data (wrong API tick) can invert this.
  const stopSide = dir === 'BULL' ? stop < entry : stop > entry;
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const tradePlan = recent.length >= 6 && rsEdge && breakout && stopSide ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger) : null;
  const fifteen = input.candles.fifteen;
  const trend1h: 'UP' | 'DOWN' | 'FLAT' = fifteen.length >= 5
    ? (fifteen[fifteen.length - 1].close > fifteen[fifteen.length - 5].close * 1.001 ? 'UP'
      : fifteen[fifteen.length - 1].close < fifteen[fifteen.length - 5].close * 0.999 ? 'DOWN' : 'FLAT')
    : 'FLAT';
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from micro-range break`) : fail('Directional bias', 'No micro-range break — price inside range'),
    pass('15m trend', `${input.trend15m}${input.trend15mAligned ? ' ✓ aligned' : ' — context'} — informational`),
    pass('1H directional', `${trend1h} — macro bias`),
    rsEdge ? pass('RS vs SPY ≥0.5%', `${rsLabel} ✓ leading edge`) : fail('RS vs SPY ≥0.5%', `${rsLabel} — need ≥0.5% RS edge vs SPY`),
    pass('5m trend', `${selfInput.trend5m}${selfInput.trendAligned ? ' aligned ✓' : ' — pullback entry phase'} — informational`),
    breakout ? pass('Micro range break', 'Latest candle broke the local range') : fail('Micro range break', 'Waiting for micro breakout'),
    input.rvol >= 1.0 ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — breakout needs ≥1.0×`),
    stopSide ? pass('Stop geometry', `Stop ${round(stop, 2)} ${dir === 'BULL' ? 'below' : 'above'} entry ✓`) : fail('Stop geometry', `Stop ${round(stop, 2)} on wrong side of entry ${round(entry, 2)} — bad price data, skip`),
    pass('VWAP context', `${selfInput.vwapAligned ? 'VWAP ✓' : 'VWAP (below — watch for reclaim)'} — informational`),
    ema1mCheck(input),
    spyTapeCheck(selfInput),
  ];
  return signal('rs_continuation', selfInput, checklist, tradePlan, 'S3 RS continuation: micro range break + RS≥0.5% + RVOL≥1.0. Hard gates: breakout (self-determines direction), rsEdge, rvol, stopSide.');
}

export function evaluateLiquiditySweep(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const range = todayOpeningRange(five);
  const recent = five.slice(-20);
  const trigger = last(recent);

  // S4 self-determines direction from the sweep pattern (no external direction needed)
  // Swept ORB lows + reclaim → BULL reversal; swept ORB highs + reclaim → BEAR reversal
  let selfDir: 'BULL' | 'BEAR' | null = null;
  let sweptLevel: number | null = null;
  let sweepCandle: Candle | null = null;
  let sweepSource: 'ORB' | 'Swing' | null = null;

  if (range) {
    const bullSweep = recent.find((c) => c.low < range.low) ?? null;
    const bearSweep = recent.find((c) => c.high > range.high) ?? null;
    if (bullSweep && !bearSweep) {
      selfDir = 'BULL'; sweptLevel = range.low; sweepCandle = bullSweep; sweepSource = 'ORB';
    } else if (bearSweep && !bullSweep) {
      selfDir = 'BEAR'; sweptLevel = range.high; sweepCandle = bearSweep; sweepSource = 'ORB';
    } else if (bullSweep && bearSweep) {
      // Both ORB levels swept: pick the one price is closest to (active retest side)
      const closerLow = Math.abs(input.price - range.low) <= Math.abs(input.price - range.high);
      selfDir = closerLow ? 'BULL' : 'BEAR';
      sweptLevel = closerLow ? range.low : range.high;
      sweepCandle = closerLow ? bullSweep : bearSweep;
      sweepSource = 'ORB';
    }
  }

  if (!sweepCandle) {
    // Intraday pivot fallback: try BULL pivot low sweep first, then BEAR pivot high
    const anchorBars = five.slice(-25, -4);
    const swingLast8 = five.slice(-8);
    for (let i = anchorBars.length - 2; i >= 1; i--) {
      if (anchorBars[i].low < anchorBars[i - 1].low && anchorBars[i].low < anchorBars[i + 1].low) {
        const pivotLevel = anchorBars[i].low;
        const swingSweep = swingLast8.find((c) => c.low < pivotLevel) ?? null;
        if (swingSweep) { selfDir = 'BULL'; sweptLevel = pivotLevel; sweepCandle = swingSweep; sweepSource = 'Swing'; break; }
      }
    }
    if (!sweepCandle) {
      for (let i = anchorBars.length - 2; i >= 1; i--) {
        if (anchorBars[i].high > anchorBars[i - 1].high && anchorBars[i].high > anchorBars[i + 1].high) {
          const pivotLevel = anchorBars[i].high;
          const swingSweep = swingLast8.find((c) => c.high > pivotLevel) ?? null;
          if (swingSweep) { selfDir = 'BEAR'; sweptLevel = pivotLevel; sweepCandle = swingSweep; sweepSource = 'Swing'; break; }
        }
      }
    }
  }

  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const swept = Boolean(sweepCandle);
  const reclaimed = Boolean(sweptLevel !== null && trigger && (
    dir === 'BULL' ? trigger.close > sweptLevel : trigger.close < sweptLevel
  ));
  const entry = sweptLevel ?? input.price;
  const nearLevel = sweptLevel !== null
    ? (dir === 'BULL'
        ? input.price <= sweptLevel + input.atr20 * 1.5
        : input.price >= sweptLevel - input.atr20 * 1.5)
    : false;
  const sweepRef = dir === 'BULL' ? (sweepCandle ? sweepCandle.low : entry) : (sweepCandle ? sweepCandle.high : entry);
  const rawStop = dir === 'BULL' ? sweepRef - input.atr20 * STOP_BUFFER_ATR : sweepRef + input.atr20 * STOP_BUFFER_ATR;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const orOpposite = range ? (dir === 'BULL' ? range.high : range.low) : null;
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2Raw = orOpposite ?? (dir === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR);
  const preferredTarget = dir === 'BULL' ? entry + risk * PREFERRED_RR : entry - risk * PREFERRED_RR;
  const t2 = dir === 'BULL' ? Math.max(t2Raw, preferredTarget) : Math.min(t2Raw, preferredTarget);
  const sweepWickOk = sweepCandle ? (() => {
    const cRange = sweepCandle.high - sweepCandle.low;
    if (cRange < 1e-8) return false;
    return dir === 'BULL'
      ? (sweepCandle.close - sweepCandle.low) / cRange >= 0.35 // 35% wick — genuine stop-run rejection
      : (sweepCandle.high - sweepCandle.close) / cRange >= 0.35;
  })() : false;
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;
  const tradePlan = swept && reclaimed && nearLevel && sweepWickOk
    ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger)
    : null;
  const sweepDetail = sweptLevel !== null
    ? (sweepSource === 'ORB'
        ? `ORB ${dir === 'BULL' ? 'low' : 'high'} ${round(sweptLevel, 2)}`
        : `Intraday pivot ${dir === 'BULL' ? 'low' : 'high'} ${round(sweptLevel, 2)}`)
    : 'No sweep level found';
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from sweep pattern`) : fail('Directional bias', 'No sweep detected — direction unknown'),
    range
      ? pass('Opening range', `${round(range.low, 2)}–${round(range.high, 2)}${sweepSource === 'Swing' ? ' (not swept — using intraday pivot)' : ''}`)
      : pass('Opening range', 'Not formed — using intraday pivot fallback'),
    swept ? pass('Liquidity swept', sweepDetail) : fail('Liquidity swept', 'No sweep below/above ORB or intraday pivot'),
    sweepWickOk ? pass('Sweep rejection wick', 'Candle closed back inside level') : fail('Sweep rejection wick', 'No rejection — likely continuation'),
    reclaimed ? pass('Level reclaimed', `Close back ${dir === 'BULL' ? 'above' : 'below'} ${sweptLevel ? round(sweptLevel, 2) : '--'}`) : fail('Level reclaimed', 'Waiting for close back through swept level'),
    nearLevel ? pass('Entry proximity', 'Price within 1.5×ATR of level ✓') : fail('Entry proximity', 'Price too far from swept level — do not chase'),
    pass('Volume confirmation', `${round(input.rvol, 2)}x${input.rvol >= 0.8 ? ' — confirmed' : ' — low, sweep structure is primary signal'}`),
    ema1mCheck(input),
    spySessionCheck(selfInput),
  ];
  return signal('liquidity_sweep', selfInput, checklist, tradePlan, `S4 Sweep (${sweepSource ?? 'no level'}): T1=${orOpposite ? 'OR opposite' : '2R'} T2=${orOpposite ? round(orOpposite, 2) : '2.5R'}`);
}

export function evaluateObFvgRetest(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const trigger = last(five);

  // S5 self-determines direction from which OB/FVG zone price is currently retesting
  const bullOb = findOrderBlockZone(five, 'BULL', 1.1, 20);
  const bearOb = findOrderBlockZone(five, 'BEAR', 1.1, 20);
  const fvgResult = detectFvg(five, 20);
  const gap = fvgResult.latestGap;

  const atBullOb = bullOb
    ? (input.price <= bullOb.high + input.atr20 * 0.2 && input.price >= bullOb.low - input.atr20 * 0.2)
    : false;
  const atBearOb = bearOb
    ? (input.price >= bearOb.low - input.atr20 * 0.2 && input.price <= bearOb.high + input.atr20 * 0.2)
    : false;
  const atBullFvg = gap && !gap.filled && gap.direction === 'BULLISH'
    ? (input.price >= gap.gapLow - input.atr20 * 0.2 && input.price <= gap.gapHigh + input.atr20 * 0.2)
    : false;
  const atBearFvg = gap && !gap.filled && gap.direction === 'BEARISH'
    ? (input.price <= gap.gapHigh + input.atr20 * 0.2 && input.price >= gap.gapLow - input.atr20 * 0.2)
    : false;

  const hasBullStructure = atBullOb || atBullFvg;
  const hasBearStructure = atBearOb || atBearFvg;
  // VWAP is the tiebreaker when price is simultaneously at both a bull and bear zone
  let selfDir: 'BULL' | 'BEAR' | null = null;
  if (hasBullStructure && !hasBearStructure) selfDir = 'BULL';
  else if (hasBearStructure && !hasBullStructure) selfDir = 'BEAR';
  else if (hasBullStructure && hasBearStructure) selfDir = input.price >= input.vwap ? 'BULL' : 'BEAR';

  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;

  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when no structure
  const ob = dir === 'BULL' ? bullOb : bearOb;
  const atOb = dir === 'BULL' ? atBullOb : atBearOb;
  const obReject = ob ? rejectionCandle(five, dir, ob) : false;
  const fvgAligned = gap && !gap.filled
    ? ((dir === 'BULL' && gap.direction === 'BULLISH') || (dir === 'BEAR' && gap.direction === 'BEARISH'))
    : false;
  const atFvg = dir === 'BULL' ? atBullFvg : atBearFvg;
  const hasStructure = atOb || atFvg;
  const structureLow = ob && atOb ? ob.low : gap && atFvg ? gap.gapLow : null;
  const structureHigh = ob && atOb ? ob.high : gap && atFvg ? gap.gapHigh : null;
  const entry = input.price;
  const rawStop = structureLow !== null && structureHigh !== null
    ? (dir === 'BULL' ? structureLow - input.atr20 * STOP_BUFFER_ATR : structureHigh + input.atr20 * STOP_BUFFER_ATR)
    : entry;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const rvolOk = input.rvol >= 1.0;
  const fvgSizeOk = atFvg && gap ? (gap.gapHigh - gap.gapLow) >= input.atr20 * 0.25 : true;
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMins = etNow.getHours() * 60 + etNow.getMinutes();
  const lateSession = etMins >= 15 * 60;
  // OB entries require a rejection candle — price slicing through an OB without a wick/reversal
  // bar means the zone is breaking, not holding. FVG entries don't need it (the gap is the magnet).
  const entryConfirmed = atOb ? obReject : atFvg;
  const tradePlan = entryConfirmed && rvolOk && fvgSizeOk && !lateSession ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger) : null;
  const structureLabel = atOb && atFvg
    ? `OB+FVG confluence`
    : atOb ? `OB entry`
    : atFvg && gap ? `FVG entry` : '';
  const rthBars = rthBarCount(input.candles.five);
  const rsiVal = rsi14(closes(input.candles.five));
  const rsiOk = dir === 'BULL' ? rsiVal < 65 : rsiVal > 35;
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from ${atOb ? 'OB' : 'FVG'} at price`) : fail('Directional bias', 'No OB or FVG at current price — direction unknown'),
    htfTrendCheck(selfInput),
    hasStructure
      ? pass('Structure zone', structureLabel)
      : fail('Structure zone', 'No active OB or unfilled FVG at current price'),
    atFvg && !fvgSizeOk
      ? fail('FVG quality', `Gap too small (< 0.25×ATR) — entry blocked`)
      : atFvg ? pass('FVG quality', `Gap size ok`) : pass('FVG quality', 'OB entry — no FVG required'),
    lateSession ? fail('Session time', 'After 15:00 ET — no new S5 entries (close-of-day noise)') : pass('Session time', 'Before 15:00 ET ✓'),
    pass('5m trend aligned', `${selfInput.trend5m}${selfInput.trendAligned ? ' ✓' : ' — pullback entry phase'} — informational`),
    atOb
      ? (obReject ? pass('OB rejection candle', 'Wick/reversal bar at OB ✓') : fail('OB rejection candle', 'Price through OB without rejection — zone likely breaking, not bouncing'))
      : pass('OB rejection candle', 'FVG entry — no rejection candle required'),
    pass('VWAP context', `${selfInput.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP (below — watch for reclaim)'} — informational`),
    rvolOk ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — no institutional flow at zone`),
    pass('RSI context', `RSI ${round(rsiVal, 1)}${rsiOk ? ' — not extended ✓' : ' — extended, watch'} — informational`),
    pass('RTH bars', `${rthBars} bars${rthBars >= 5 ? ' ✓' : ' — early session'} — informational`),
    pass('ADR room', `${adrExhausted(input.candles.five, input.atr20) ? '>80% ATR used — watch' : '< 80% ATR used ✓'} — informational`),
    ema1mCheck(input),
    spyTapeCheck(selfInput),
  ];
  return signal('ob_fvg_retest', selfInput, checklist, tradePlan, 'S5: OB or FVG retest. Hard gates: OB needs rejection candle; FVG needs gap ≥ 0.25×ATR; both need RVOL≥1.0× and entry before 15:00 ET.');
}

export function evaluateMssBreakout(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 22) {
    return signal('mss_breakout', input, [fail('Data', 'Need 22+ bars')], null, 'Insufficient candle data.');
  }
  const refBars = five.slice(-22, -6);
  const protectedHigh = Math.max(...refBars.map((c) => c.high));
  const protectedLow = Math.min(...refBars.map((c) => c.low));
  const recentSix = five.slice(-6);
  // S6 self-determines direction: which structural level the last 6 bars broke through
  const bullMss = recentSix.some((c) => c.close > protectedHigh);
  const bearMss = recentSix.some((c) => c.close < protectedLow);
  let selfDir: 'BULL' | 'BEAR' | null = null;
  if (bullMss && !bearMss) selfDir = 'BULL';
  else if (bearMss && !bullMss) selfDir = 'BEAR';
  else if (bullMss && bearMss) selfDir = input.price > (protectedHigh + protectedLow) / 2 ? 'BULL' : 'BEAR';
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;
  const mssOk = Boolean(selfDir);
  const bar2Ok = mssOk && (
    dir === 'BULL'
      ? input.price > protectedHigh - input.atr20 * 0.8 // 0.8×ATR — was 0.4, too tight; genuine MSS runs fast
      : input.price < protectedLow + input.atr20 * 0.8
  );
  const aheadOb = findOrderBlockZone(five, dir === 'BULL' ? 'BEAR' : 'BULL', 1.1, 60);
  const zoneBlocked = aheadOb
    ? (dir === 'BULL'
        ? input.price < aheadOb.low && aheadOb.low <= input.price + input.atr20 * 1.0
        : input.price > aheadOb.high && aheadOb.high >= input.price - input.atr20 * 1.0)
    : false;
  const volOk = input.rvol >= 0.8;
  const entry = input.price;
  const swingStop = dir === 'BULL'
    ? Math.min(...five.slice(-5).map((c) => c.low)) - input.atr20 * STOP_BUFFER_ATR
    : Math.max(...five.slice(-5).map((c) => c.high)) + input.atr20 * STOP_BUFFER_ATR;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, swingStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const tradePlan = mssOk && bar2Ok && !zoneBlocked && volOk ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger) : null;
  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from structural break`) : fail('Directional bias', 'No structural break in last 30m — direction unknown'),
    htfTrendCheck(selfInput),
    mssOk ? pass('MSS detected', 'Structural high/low broken') : fail('MSS detected', 'Waiting for break'),
    bar2Ok ? pass('Bar-2 hold', 'MSS level maintained ✓') : fail('Bar-2 hold', 'Price extended too far from break — do not chase'),
    !zoneBlocked ? pass('Zone clearance', 'Clear path ahead ✓') : fail('Zone clearance', 'Opposing OB within 1×ATR — insufficient clearance'),
    pass('VWAP context', `${selfInput.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP side mismatch — watch'} — informational`),
    volOk ? pass('RVOL', `${round(input.rvol, 2)}× ✓`) : fail('RVOL', `${round(input.rvol, 2)}× — below 0.8 minimum for structural break`),
    ema1mCheck(input),
    spyTapeCheck(selfInput),
  ];
  return signal('mss_breakout', selfInput, checklist, tradePlan, 'S6 MSS: structural break + clear path. Hard gates: mssOk (self-determines direction), bar2Ok (0.8×ATR), zoneBlocked (1×ATR), RVOL≥0.8.');
}

function checkS7VolumeSurge(input: StrategyInput): StrategySignal | null {
  const { candles, atr20, price } = input;
  const bar = last(candles.five);
  if (!bar || candles.five.length < 13) return null;

  // Mid-session volume baseline: exclude the first 6 RTH bars (9:30–10:00 AM open period).
  // Opening bars carry 3–5× normal volume and inflate the average, making 2× impossible to hit mid-session.
  // Fallback to rolling 20 bars when not enough mid-session history exists.
  const todayET = new Date(bar.time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayRTH = candles.five.filter((c) => {
    const d = new Date(c.time);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET
      && d.getUTCHours() * 60 + d.getUTCMinutes() >= 13 * 60 + 30;
  });
  const midSessionBars = todayRTH.length > 7 ? todayRTH.slice(6, -1) : [];
  const volSample = midSessionBars.length >= 4 ? midSessionBars : candles.five.slice(-21, -1);
  const avgVol = volSample.length ? volSample.reduce((s, c) => s + c.volume, 0) / volSample.length : 0;
  if (avgVol <= 0) return null;

  // Project bar to full 5m volume to compensate for mid-bar polling (scanner runs every ~60s).
  // A bar 90s in shows ~30% of its final volume — comparing raw to completed-bar average
  // requires 6–7× mid-session rate to pass, which never happens without a catalyst.
  const barAgeMs = Date.now() - new Date(bar.time).getTime();
  const barProgress = Math.min(Math.max(barAgeMs / (5 * 60 * 1000), 0.1), 1.0);
  const projectedVol = bar.volume / barProgress;
  const volSpike = projectedVol > avgVol * 2.0;

  const prev6 = candles.five.slice(-7, -1);
  if (prev6.length < 6) return null;
  const high30m = Math.max(...prev6.map((b) => b.high));
  const low30m = Math.min(...prev6.map((b) => b.low));
  const selfDir: 'BULL' | 'BEAR' | null = price > high30m ? 'BULL' : price < low30m ? 'BEAR' : null;

  // Always return a signal (forming/screened) — not null — so S7 is visible in the UI
  // and the user can see exactly which gate is missing. Only null for no data (above).
  const dir: 'BULL' | 'BEAR' = selfDir ?? (price >= input.vwap ? 'BULL' : 'BEAR');
  const selfInput = {
    ...input,
    direction: dir,
    vwapAligned: dir === 'BULL' ? price > input.vwap : price < input.vwap,
    trendAligned: dir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
  };
  const rvolOk = input.rvol >= 0.8;
  const rawStop = dir === 'BULL' ? bar.low : bar.high;
  const stop = enforceMinStop(dir, price, noiseFlooredStop(dir, price, rawStop, atr20, input.vixLevel), atr20);
  const risk = Math.abs(price - stop);
  const t1 = dir === 'BULL' ? price + risk * T1_RR : price - risk * T1_RR;
  const t2 = dir === 'BULL' ? price + risk * PREFERRED_RR : price - risk * PREFERRED_RR;
  const tradePlan = volSpike && selfDir && rvolOk ? planFromLevelsT1T2(selfInput, price, stop, t1, t2, bar) : null;
  const checklist = [
    selfDir
      ? pass('Directional bias', `${selfDir} — self-determined from 30m range break`)
      : fail('Directional bias', `Price inside 30m range (${round(low30m, 2)}–${round(high30m, 2)}) — awaiting breakout`),
    volSpike
      ? pass('Volume surge ≥2×', `${round(projectedVol / avgVol, 1)}× projected (${round(barProgress * 100, 0)}% bar complete)`)
      : fail('Volume surge ≥2×', `${round(projectedVol / avgVol, 1)}× projected — need institutional 2× surge`),
    selfDir
      ? pass('30m range break', `${selfDir === 'BULL' ? 'Above' : 'Below'} 30m range ✓`)
      : fail('30m range break', `Inside range — no break yet`),
    rvolOk ? pass('RVOL ≥0.8×', `${round(input.rvol, 2)}× ✓ session active`) : fail('RVOL ≥0.8×', `${round(input.rvol, 2)}× — below session minimum; vol spike may be isolated`),
    selfInput.vwapAligned ? pass('VWAP aligned', `${dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓'}`) : fail('VWAP aligned', `${dir === 'BULL' ? 'Below VWAP' : 'Above VWAP'} — surge against session anchor`),
    pass('ADR room', `${!adrExhausted(input.candles.five, input.atr20) ? '< 80% ATR used ✓' : '>80% ATR used — watch sizing'} — informational`),
    spyTapeCheck(selfInput),
  ];
  const sig = signal('s7_volume_surge', selfInput, checklist, tradePlan, 'S7: Institutional 2× volume surge on 30m range break + RVOL≥0.8×. Hard gates: volSpike (2× projected), selfDir (range break), rvolOk (0.8×), vwapAligned, spyTape.');
  // Pre-blackout gap fire: allow S7 to fire at 9:30–9:45 AM on strong gap days (>3% gap + live data)
  if (
    sig.stage === 'locked' &&
    sessionGate() === 'blackout' &&
    input.dataStatus.mode === 'live' && !input.dataStatus.stale &&
    ((dir === 'BULL' && input.gapPct >= 3) || (dir === 'BEAR' && input.gapPct <= -3))
  ) {
    return { ...sig, stage: 'trade_ready' as const };
  }
  return sig;
}

// ─── S8: EMA20 Bounce ────────────────────────────────────────────────────────
// Trend-continuation entry when price pulls back to the 5m EMA20, holds, and a
// recovery candle closes back above it. EMA slope self-determines direction —
// rising slope → BULL bounce, falling slope → BEAR bounce.
// Hard gates: selfDir (EMA slope), emaRising, touchedEma, reclaimed, rvol.
export function evaluateEma20Bounce(input: StrategyInput): StrategySignal {
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

  // S8 self-determines direction: EMA20 slope defines the bounce direction
  const selfDir: 'BULL' | 'BEAR' | null = ema20Now > ema20Prev3 ? 'BULL' : ema20Now < ema20Prev3 ? 'BEAR' : null;
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;

  const emaRising = Boolean(selfDir); // true when EMA has a clear slope in either direction
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
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, swingStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const tradePlan = emaRising && touchedEma && reclaimed && input.rvol >= 0.8
    ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from EMA20 slope`) : fail('Directional bias', 'EMA20 flat — no slope to define bounce direction'),
    emaRising
      ? pass('EMA slope', `EMA20 ${dir === 'BULL' ? 'rising' : 'falling'} ✓`)
      : fail('EMA slope', 'EMA20 flat — mean-reversion risk without slope'),
    touchedEma
      ? pass('EMA touch', `Recent bar tested EMA20 (${round(ema20Now, 2)})`)
      : fail('EMA touch', `No touch of EMA20 (${round(ema20Now, 2)}) in last 3 bars`),
    reclaimed
      ? pass('Recovery candle', `Close ${dir === 'BULL' ? 'above' : 'below'} EMA20 ✓`)
      : fail('Recovery candle', 'Waiting for bar to close back through EMA20'),
    htfTrendCheck(selfInput),
    pass('VWAP context', `${selfInput.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP misaligned — watch'} — informational`),
    input.rvol >= 0.8 ? pass('RVOL ≥0.8×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥0.8×', `${round(input.rvol, 2)}× — EMA bounce in low volume is chop, not trend`),
    ema1mCheck(input),
    spySessionCheck(selfInput),
  ];

  return signal('ema20_bounce', selfInput, checklist, tradePlan,
    'S8 EMA20 bounce: EMA slope self-determines direction. Rising/falling EMA20 touched + recovery close + RVOL≥0.8. Hard gates: selfDir (slope), emaRising, touchedEma, reclaimed, rvol.');
}

// ─── S9: Flag Break ───────────────────────────────────────────────────────────
// Tight consolidation (< 0.5×ATR range over 7 bars) followed by a 5m bar that
// closes above the flag high (BULL) or below the flag low (BEAR) with RVOL ≥ 1.0.
// Break side self-determines direction — no external bias required.
// Hard gates: selfDir (flag break), flagFormed, rvolOk, volExpansion.
export function evaluateFlagBreak(input: StrategyInput): StrategySignal {
  const five = input.candles.five;
  const trigger = last(five);
  if (five.length < 12 || !trigger) {
    return signal('flag_break', input, [fail('Data', 'Need 12+ 5m bars')], null, 'Insufficient candle data.');
  }

  const flagBars = five.slice(-8, -1); // 7 closed bars before trigger
  const flagHigh = Math.max(...flagBars.map((c) => c.high));
  const flagLow = Math.min(...flagBars.map((c) => c.low));
  const flagRange = flagHigh - flagLow;

  // S9 self-determines direction: which side of the flag the trigger bar closes through
  const selfDir: 'BULL' | 'BEAR' | null = trigger.close > flagHigh ? 'BULL' : trigger.close < flagLow ? 'BEAR' : null;
  const dir: 'BULL' | 'BEAR' = selfDir ?? 'BULL'; // geometry fallback; tradePlan is null when selfDir=null
  const selfInput = selfDir
    ? {
        ...input,
        direction: selfDir,
        vwapAligned: selfDir === 'BULL' ? input.price > input.vwap : input.price < input.vwap,
        trendAligned: selfDir === 'BULL' ? input.trend5m === 'UP' : input.trend5m === 'DOWN',
      }
    : input;

  const flagFormed = flagRange < input.atr20 * 0.5; // 0.5×ATR — true compression; 1×ATR was just sideways
  const breakout = selfDir !== null; // flag break IS the direction signal
  const rvolOk = input.rvol >= 1.0;
  const flagMaxVol = Math.max(...flagBars.map((c) => c.volume));
  // Break bar must show more urgency than any consolidation bar — filters lunch drifts
  const volExpansion = trigger.volume > flagMaxVol;

  const entry = input.price;
  const rawStop = dir === 'BULL'
    ? flagLow - input.atr20 * STOP_BUFFER_ATR
    : flagHigh + input.atr20 * STOP_BUFFER_ATR;
  const stop = enforceMinStop(dir, entry, noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel), input.atr20);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(selfInput, entry, risk, t1);
  const tradePlan = flagFormed && breakout && rvolOk && volExpansion
    ? planFromLevelsT1T2(selfInput, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    selfDir ? pass('Directional bias', `${selfDir} — self-determined from flag break side`) : fail('Directional bias', `Waiting for close above ${round(flagHigh, 2)} or below ${round(flagLow, 2)}`),
    flagFormed
      ? pass('Flag formed', `Range ${round(flagRange, 2)} < 0.5×ATR (${round(input.atr20 * 0.5, 2)}) ✓`)
      : fail('Flag formed', `Range ${round(flagRange, 2)} too wide — needs < ${round(input.atr20 * 0.5, 2)} (0.5×ATR)`),
    breakout
      ? pass('Flag break', `Close ${selfDir === 'BULL' ? 'above flag high' : 'below flag low'} (${round(selfDir === 'BULL' ? flagHigh : flagLow, 2)}) ✓`)
      : fail('Flag break', 'No break yet — price inside flag'),
    rvolOk
      ? pass('RVOL', `${round(input.rvol, 2)}× ✓`)
      : fail('RVOL', `${round(input.rvol, 2)}× — needs ≥1.0×`),
    volExpansion
      ? pass('Volume expansion', `Break bar ${round(trigger.volume / Math.max(flagMaxVol, 1), 1)}× flag max vol ✓`)
      : fail('Volume expansion', `Break bar vol below flag max (${flagMaxVol.toLocaleString()}) — drift break, not institutional`),
    htfTrendCheck(selfInput),
    pass('VWAP context', `${selfInput.vwapAligned ? (dir === 'BULL' ? 'Above VWAP ✓' : 'Below VWAP ✓') : 'VWAP misaligned — watch'} — informational`),
    ema1mCheck(input),
    spyTapeCheck(selfInput),
  ];

  return signal('flag_break', selfInput, checklist, tradePlan,
    'S9 Flag Break: break side self-determines direction. 7-bar compression < 0.5×ATR + close through flag + RVOL≥1.0 + vol expansion. Hard gates: selfDir (break), flagFormed, rvolOk, volExpansion.');
}

// ─── 15m Strategy constants ───────────────────────────────────────────────────
// Wider stop buffer and higher minimum R:R vs 5m strategies.
// 15m bars carry more ATR per bar so 0.5× is too tight; 1.0× gives real room.
// R:R minimum 2.0 compensates for the wider stop with a higher reward requirement.
const STOP_BUFFER_15M = 1.0;
const MIN_RR_15M = 2.0;

// ─── S10: 15m ORB Retest ─────────────────────────────────────────────────────
// ORB defined by first 2 session 15m bars (9:30-10:00 AM ET = 30 min).
// Price breaks the ORB, pulls back to retest the level, then continues.
// Hard gates: direction, orbFormed, breakout, retest, adrOk, rvolOk, rrOk.
export function evaluateOrb15mRetest(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('orb15m_retest', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const fifteen = input.candles.fifteen;
  if (fifteen.length < 6) {
    return signal('orb15m_retest', input, [fail('Data', 'Need 6+ 15m bars')], null, 'Insufficient candle data.');
  }
  const sessionBars = sessionCandles(fifteen);
  if (sessionBars.length < 2) {
    return signal('orb15m_retest', input, [fail('ORB forming', 'Wait for 10:00 AM ET (2nd session 15m bar)')], null, 'ORB not yet formed.');
  }
  const orbBars = sessionBars.slice(0, 2);
  const orbHigh = Math.max(...orbBars.map(c => c.high));
  const orbLow = Math.min(...orbBars.map(c => c.low));
  const postOrb = sessionBars.slice(2);
  const breakout = dir === 'BULL'
    ? postOrb.some(c => c.close > orbHigh)
    : postOrb.some(c => c.close < orbLow);
  const tolerance = Math.max(input.atr20 * 0.2, input.price * 0.002);
  const recent3 = fifteen.slice(-3);
  const retest = dir === 'BULL'
    ? recent3.some(c => c.low <= orbHigh + tolerance && c.close > orbHigh - tolerance)
    : recent3.some(c => c.high >= orbLow - tolerance && c.close < orbLow + tolerance);
  const adrOk = input.atrPct >= 3.0;
  const rvolOk = input.rvol >= 1.0;
  const entry = input.price;
  const swing = dir === 'BULL' ? Math.min(...recent3.map(c => c.low)) : Math.max(...recent3.map(c => c.high));
  const rawStop = dir === 'BULL' ? swing - input.atr20 * STOP_BUFFER_15M : swing + input.atr20 * STOP_BUFFER_15M;
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const rrOk = rr(entry, stop, t2, dir) >= MIN_RR_15M;
  const tradePlan = breakout && retest && adrOk && rvolOk && rrOk
    ? planFromLevelsT1T2(input, entry, stop, t1, t2)
    : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    sessionBars.length >= 2 ? pass('ORB formed', `H ${round(orbHigh, 2)} / L ${round(orbLow, 2)} (30m)`) : fail('ORB formed', 'Waiting for 10:00 AM ET'),
    breakout ? pass('ORB breakout', `${dir === 'BULL' ? 'Above' : 'Below'} ORB confirmed`) : fail('ORB breakout', 'No ORB breakout yet'),
    retest ? pass('ORB retest', `${dir === 'BULL' ? 'Retested ORB high' : 'Retested ORB low'} ✓`) : fail('ORB retest', 'Waiting for pullback to ORB level'),
    adrOk ? pass('ADR ≥3%', `${round(input.atrPct, 1)}% ✓`) : fail('ADR ≥3%', `${round(input.atrPct, 1)}% — 15m needs ≥3% range`),
    rvolOk ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — breakout retest needs participation`),
    rrOk ? pass('R:R ≥2.0', '✓') : fail('R:R ≥2.0', 'Reward insufficient vs 1×ATR stop'),
    pass('VWAP', `${input.vwapAligned ? (dir === 'BULL' ? 'Above ✓' : 'Below ✓') : 'misaligned'} — informational`),
  ];
  return signal('orb15m_retest', input, checklist, tradePlan, 'S10 15m ORB: breakout + retest + ADR≥3% + RVOL≥1.0 + R:R≥2.0. Hard gates: direction, breakout, retest, adrOk, rvolOk, rrOk.');
}

// ─── S11: 15m VWAP Pullback ───────────────────────────────────────────────────
// Higher-timeframe version of S2: VWAP test on 15m chart with RS edge required.
// RS gate is hard (was soft in S2) — 15m VWAP reclaims on lagging stocks fail.
// Hard gates: direction, touchedVwap, reclaimed, rsOk, rvolOk, rrOk.
export function evaluateVwap15mPullback(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('vwap15m_pullback', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const fifteen = input.candles.fifteen;
  const trigger = last(fifteen);
  if (fifteen.length < 5 || !trigger) {
    return signal('vwap15m_pullback', input, [fail('Data', 'Need 5+ 15m bars')], null, 'Insufficient candle data.');
  }
  const recent4 = fifteen.slice(-4); // 60-min window on 15m
  const tolerance = Math.max(input.atr20 * 0.25, input.price * 0.002);
  const touchedVwap = recent4.some(c => dir === 'BULL'
    ? c.low <= input.vwap + tolerance
    : c.high >= input.vwap - tolerance
  );
  const reclaimed = dir === 'BULL' ? trigger.close > input.vwap : trigger.close < input.vwap;
  const rsOk = dir === 'BULL' ? input.rsVsBenchmark >= 1.005 : input.rsVsBenchmark <= 0.995;
  const rvolOk = input.rvol >= 1.0;
  const adrOk = input.atrPct >= 3.0;
  const entry = input.price;
  const swing = dir === 'BULL' ? Math.min(...recent4.map(c => c.low)) : Math.max(...recent4.map(c => c.high));
  const rawStop = dir === 'BULL' ? swing - input.atr20 * STOP_BUFFER_15M : swing + input.atr20 * STOP_BUFFER_15M;
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const rrOk = rr(entry, stop, t2, dir) >= MIN_RR_15M;
  const tradePlan = touchedVwap && reclaimed && rsOk && rvolOk && rrOk
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    touchedVwap ? pass('15m VWAP test', 'Within 60m on 15m chart') : fail('15m VWAP test', 'No 15m VWAP test in last 60m'),
    reclaimed ? pass('VWAP reclaim', `15m close ${dir === 'BULL' ? 'above' : 'below'} VWAP ✓`) : fail('VWAP reclaim', 'Waiting for 15m close back through VWAP'),
    rsOk ? pass('RS vs SPY ≥0.5%', `${round(input.rsVsBenchmark, 4)} ✓`) : fail('RS vs SPY ≥0.5%', `${round(input.rsVsBenchmark, 4)} — 15m reclaim requires RS edge`),
    rvolOk ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — low-volume 15m reclaim unreliable`),
    adrOk ? pass('ADR ≥3%', `${round(input.atrPct, 1)}% ✓`) : fail('ADR ≥3%', `${round(input.atrPct, 1)}% — 15m needs ≥3% range`),
    rrOk ? pass('R:R ≥2.0', '✓') : fail('R:R ≥2.0', 'Reward insufficient vs 1×ATR stop'),
    pass('5m trend', `${input.trend5m}${input.trendAligned ? ' aligned ✓' : ''} — informational`),
  ];
  return signal('vwap15m_pullback', input, checklist, tradePlan, 'S11 15m VWAP pullback: 60m VWAP test + reclaim + RS≥0.5% + RVOL≥1.0 + R:R≥2.0. Hard gates: direction, touchedVwap, reclaimed, rsOk, rvolOk, rrOk.');
}

// ─── S12: 15m EMA20 Bounce ───────────────────────────────────────────────────
// Higher-timeframe version of S8: rising EMA20 on 15m candles touched and reclaimed.
// Slope lookback 4 bars = 1h on 15m (was 3 bars = 15m on 5m) — genuine trend.
// Hard gates: direction, emaRising, touchedEma, reclaimed, rvolOk, rrOk.
export function evaluateEma20Bounce15m(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('ema20_bounce_15m', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const fifteen = input.candles.fifteen;
  const trigger = last(fifteen);
  if (fifteen.length < 12 || !trigger) {
    return signal('ema20_bounce_15m', input, [fail('Data', 'Need 12+ 15m bars (3h of data — fires from ~12:30 PM ET)')], null, 'Insufficient 15m data.');
  }
  const ema20Series = ema(closes(fifteen), 20);
  const ema20Now = last(ema20Series);
  const ema20Prev = ema20Series[ema20Series.length - 5]; // 4-bar slope = 1h on 15m
  if (!Number.isFinite(ema20Now) || !Number.isFinite(ema20Prev)) {
    return signal('ema20_bounce_15m', input, [fail('Data', 'EMA20 unavailable')], null, 'EMA20 computation failed.');
  }
  const emaRising = dir === 'BULL' ? ema20Now > ema20Prev * 1.001 : ema20Now < ema20Prev * 0.999; // 0.1% slope per 1h — filters flat EMAs
  const recent3 = fifteen.slice(-3); // last 45 min
  const emaTolerance = input.atr20 * 0.3; // 0.3×ATR — 15m bars have more range per bar
  const touchedEma = recent3.some(c => dir === 'BULL'
    ? c.low <= ema20Now + emaTolerance
    : c.high >= ema20Now - emaTolerance
  );
  const reclaimed = dir === 'BULL' ? trigger.close > ema20Now : trigger.close < ema20Now;
  const rvolOk = input.rvol >= 1.0;
  const adrOk = input.atrPct >= 3.0;
  const entry = input.price;
  const rawStop = dir === 'BULL'
    ? ema20Now - input.atr20 * STOP_BUFFER_15M
    : ema20Now + input.atr20 * STOP_BUFFER_15M;
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel);
  const risk = Math.abs(entry - stop);
  const t1 = dir === 'BULL' ? entry + risk * T1_RR : entry - risk * T1_RR;
  const t2 = structuralT2(input, entry, risk, t1);
  const rrOk = rr(entry, stop, t2, dir) >= MIN_RR_15M;
  const tradePlan = emaRising && touchedEma && reclaimed && rvolOk && rrOk
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    emaRising
      ? pass('15m EMA20 slope', `${dir === 'BULL' ? 'Rising' : 'Falling'} over 1h ✓`)
      : fail('15m EMA20 slope', `Flat/${dir === 'BULL' ? 'falling' : 'rising'} — mean-reversion risk`),
    touchedEma
      ? pass('15m EMA20 touch', `Tested EMA20 (${round(ema20Now, 2)}) within 45m`)
      : fail('15m EMA20 touch', `No 15m touch of EMA20 (${round(ema20Now, 2)}) in last 45m`),
    reclaimed
      ? pass('Recovery candle', `15m close ${dir === 'BULL' ? 'above' : 'below'} EMA20 ✓`)
      : fail('Recovery candle', 'Waiting for 15m close back through EMA20'),
    rvolOk ? pass('RVOL ≥1.0×', `${round(input.rvol, 2)}× ✓`) : fail('RVOL ≥1.0×', `${round(input.rvol, 2)}× — 15m bounce needs volume`),
    adrOk ? pass('ADR ≥3%', `${round(input.atrPct, 1)}% ✓`) : fail('ADR ≥3%', `${round(input.atrPct, 1)}% — 15m needs ≥3% range`),
    rrOk ? pass('R:R ≥2.0', '✓') : fail('R:R ≥2.0', 'Reward insufficient vs 1×ATR stop'),
    htfTrendCheck(input),
    pass('VWAP', `${input.vwapAligned ? (dir === 'BULL' ? 'Above ✓' : 'Below ✓') : 'misaligned'} — informational`),
  ];
  return signal('ema20_bounce_15m', input, checklist, tradePlan, 'S12 15m EMA20 bounce: 1h rising slope + 45m touch + reclaim + RVOL≥1.0 + R:R≥2.0. Hard gates: direction, emaRising, touchedEma, reclaimed, rvolOk, rrOk.');
}

// ─── S13: Range-Bound Mean Reversion ─────────────────────────────────────────
// SIDEWAYS-optimised strategy: price tests the 30-min session range extreme,
// shows a 30%+ rejection wick, and the R:R to VWAP (mean-reversion target) is ≥1.5.
// Direction is driven by WHERE price is — BULL at range low, BEAR at range high.
// SPY FLAT context is informational; the geometry itself self-selects SIDEWAYS days.
// Hard gates: directionOk, rangeOk, atExtreme, wickOk, rvolOk, rrOk.
export function evaluateRangeBoundReversion(input: StrategyInput): StrategySignal {
  if (!directionOk(input)) {
    return signal('range_reversion', input, [fail('Directional bias', 'No BULL/BEAR bias')], null, 'No directional bias.');
  }
  const dir = input.direction as 'BULL' | 'BEAR';
  const five = input.candles.five;
  const trigger = last(five);
  const session = sessionCandles(five);
  if (session.length < 6 || !trigger) {
    return signal('range_reversion', input, [fail('Session range', 'Need 6+ session bars (30 min of RTH data)')], null, 'Session range not yet formed.');
  }

  // 30-min session range — same ORB window as S1
  const rangeBars = session.slice(0, 6);
  const rangeHigh = Math.max(...rangeBars.map(c => c.high));
  const rangeLow = Math.min(...rangeBars.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  const rangeOk = rangeSize >= input.atr20 * 0.5; // range must be meaningful, not noise

  // BULL: price at/near range LOW (buy support); BEAR: at/near range HIGH (sell resistance)
  const proximity = input.atr20 * 0.15;
  const atExtreme = dir === 'BULL'
    ? input.price <= rangeLow + proximity
    : input.price >= rangeHigh - proximity;

  // Rejection wick ≥30% — physical evidence of institutional defence of the level
  const cRange = trigger.high - trigger.low;
  const wickOk = cRange > 1e-8 && (
    dir === 'BULL'
      ? (trigger.close - trigger.low) / cRange >= 0.30
      : (trigger.high - trigger.close) / cRange >= 0.30
  );

  const rvolOk = input.rvol >= 0.8; // lower than breakout strategies — reversals don't need surge volume

  // Target: VWAP (session anchor = natural mean-reversion destination in SIDEWAYS)
  const entry = input.price;
  const rawStop = dir === 'BULL'
    ? rangeLow - input.atr20 * 0.3
    : rangeHigh + input.atr20 * 0.3;
  const stop = noiseFlooredStop(dir, entry, rawStop, input.atr20, input.vixLevel);
  const risk = Math.abs(entry - stop);
  const t1 = input.vwap; // scale out 50% at VWAP (mean reversion achieved)
  const t2 = dir === 'BULL' ? entry + risk * 2.0 : entry - risk * 2.0; // hold 50% for potential trend continuation
  const rrToVwap = rr(entry, stop, t1, dir);
  const rrOk = rrToVwap >= MIN_RR; // need ≥1.5R to VWAP — validates the mean-reversion gap exists

  const tradePlan = rangeOk && atExtreme && wickOk && rvolOk && rrOk
    ? planFromLevelsT1T2(input, entry, stop, t1, t2, trigger)
    : null;

  const checklist = [
    directionOk(input) ? pass('Directional bias', dir) : fail('Directional bias', 'No BULL/BEAR bias'),
    rangeOk
      ? pass('Session range', `H ${round(rangeHigh, 2)} / L ${round(rangeLow, 2)} (≥0.5×ATR ✓)`)
      : fail('Session range', `Range ${round(rangeSize, 2)} < 0.5×ATR — too thin for mean-reversion`),
    atExtreme
      ? pass('At range extreme', `${dir === 'BULL' ? 'Near range LOW' : 'Near range HIGH'} (within 0.15×ATR)`)
      : fail('At range extreme', `Price mid-range — ${dir === 'BULL' ? 'range low' : 'range high'} not being tested`),
    wickOk
      ? pass('Rejection wick ≥30%', 'Candle closed back inside range — institutional defence ✓')
      : fail('Rejection wick ≥30%', 'No rejection wick — possible breakdown, not reversal'),
    rvolOk
      ? pass('RVOL ≥0.8×', `${round(input.rvol, 2)}× ✓`)
      : fail('RVOL ≥0.8×', `${round(input.rvol, 2)}× — need participation at range extreme`),
    rrOk
      ? pass('R:R ≥1.5 to VWAP', `${round(rrToVwap, 2)} ✓ — VWAP ${round(input.vwap, 2)}`)
      : fail('R:R ≥1.5 to VWAP', `${round(rrToVwap, 2)} — VWAP too close, no edge`),
    input.spyTrend5m === 'FLAT'
      ? pass('SPY FLAT context', 'Range-bound session ✓ — ideal for S13')
      : pass('SPY tide', `${input.spyTrend5m ?? 'unknown'} — S13 works best on FLAT SPY days`),
    pass('VWAP target', `${round(input.vwap, 2)} — T1 scale-out; hold 50% to 2R if trend continues`),
  ];

  return signal('range_reversion', input, checklist, tradePlan,
    'S13 Range Reversion: 30m session range extreme + 30% rejection wick + R:R≥1.5 to VWAP. SIDEWAYS-optimised — self-selects via range geometry.',
    false, rangeOk ? [{
      label: 'Session Range',
      startTime: rangeBars[0].time,
      endTime: rangeBars[rangeBars.length - 1].time,
      high: rangeHigh,
      low: rangeLow,
    }] : []);
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
    // 15m timeframe variants — independent gates, wider stops, R:R≥2.0
    evaluateOrb15mRetest(input),
    evaluateVwap15mPullback(input),
    evaluateEma20Bounce15m(input),
    // SIDEWAYS-optimised — range extreme + rejection wick + R:R to VWAP
    evaluateRangeBoundReversion(input),
  ].filter((s): s is StrategySignal => s !== null);

  return signals
    .filter((sig) => !excluded.includes(sig.strategyId))
    .sort((a, b) => workflowStageRank(b.stage) - workflowStageRank(a.stage) || b.confidence - a.confidence);
}
