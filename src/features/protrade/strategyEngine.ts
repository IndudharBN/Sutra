import { detectFvg } from '../scanner/fvg';
import { ema } from '../scanner/indicators';
import type { Candle } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { findOrderBlockZone, rejectionCandle } from '../scanner/smc';
import type { StrategyChecklistItem, StrategyId, StrategyInput, StrategySignal, TradePlan, WorkflowStage } from './workflowTypes';
import { STRATEGY_LABELS, workflowStageRank } from './workflowTypes';

const MIN_RR = 1.8;
const PREFERRED_RR = 2;

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
  if (passed < 2) return 'pro_watchlist';
  if (passed < checklist.length) return 'forming';
  if (!tradePlan) return 'confirmed';
  if (tradePlan.rr < MIN_RR) return 'confirmed';
  if (manualOnly) return 'confirmed';
  // locked = data/session not ready; setup quality is confirmed but execution is blocked.
  if (input.dataStatus.mode !== 'live' || input.dataStatus.stale) return 'locked';
  if (sessionGate() !== 'open') return 'locked';
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
  const gate = sessionGate();
  if (gate === 'closed') output.push('Market closed — trade window 10:00 AM–4:00 PM ET');
  if (gate === 'blackout') output.push('Opening blackout — wait until 10:00 AM ET');
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
  return input.trend15mAligned
    ? pass('15m directional context', `${input.trend15m} supports ${input.direction}`)
    : fail('15m directional context', `15m is ${input.trend15m}; waiting for directional ${input.direction} context`);
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
  const recent = input.candles.five.slice(-4);
  if (!recent.length) return false;
  const tolerance = Math.max(input.atr20 * 0.08, input.price * 0.0015);
  return input.direction === 'BULL'
    ? recent.some((c) => c.low <= level + tolerance && c.close >= level)
    : recent.some((c) => c.high >= level - tolerance && c.close <= level);
}

// 1m EMA alignment — soft refinement check. Passes when data is unavailable so it never blocks on missing feeds.
function ema1mCheck(input: StrategyInput): StrategyChecklistItem {
  const one = input.candles.one;
  if (one.length < 25) return pass('1m entry timing', '1m feed not available — using 5m structure');
  const e9 = last(ema(closes(one), 9));
  const e21 = last(ema(closes(one), 21));
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return pass('1m entry timing', '1m EMA unavailable — using 5m structure');
  return (input.direction === 'BULL' ? e9 > e21 : e9 < e21)
    ? pass('1m entry timing', '1m EMA9/21 aligned — entry window open')
    : fail('1m entry timing', '1m micro-structure not aligned yet — wait');
}

export function evaluateOrbRetest(input: StrategyInput): StrategySignal {
  const range = openingRange(input.candles.five, 3);
  const trigger = last(input.candles.five);
  const rangeBreak = range ? directionalBreak(input, input.price, range.high, range.low) : false;
  const retest = range ? recentRetest(input, input.direction === 'BULL' ? range.high : range.low) : false;
  const entry = input.price;
  const stop = input.direction === 'BULL'
    ? Math.min(range?.high ?? entry, trigger?.low ?? entry) - input.atr20 * 0.12
    : Math.max(range?.low ?? entry, trigger?.high ?? entry) + input.atr20 * 0.12;
  const target = input.direction === 'BULL'
    ? entry + Math.max(input.atr20, Math.abs(entry - stop) * PREFERRED_RR)
    : entry - Math.max(input.atr20, Math.abs(stop - entry) * PREFERRED_RR);
  const tradePlan = directionOk(input) && range ? planFromLevels(input, entry, stop, target, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    range ? pass('Opening range formed', `${round(range.low, 2)}–${round(range.high, 2)}`) : fail('Opening range formed', 'Need first 15 min of 5m candles'),
    rangeBreak ? pass('Opening range break', 'Price broke the range in direction') : fail('Opening range break', 'Waiting for breakout'),
    retest ? pass('Retest hold', 'Breakout level retested and held') : fail('Retest hold', 'Waiting for controlled retest'),
    input.rvol >= 1.2 ? pass('RVOL confirmation', `${round(input.rvol, 2)}x`) : fail('RVOL confirmation', 'Need 1.2x RVOL for ORB'),
    input.vwapAligned ? pass('VWAP alignment', 'Price is on correct VWAP side') : fail('VWAP alignment', 'VWAP does not support direction'),
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
  const recent = input.candles.five.slice(-6);
  const tolerance = Math.max(input.atr20 * 0.12, input.price * 0.0015);
  const touchedVwap = recent.some((c) => input.direction === 'BULL' ? c.low <= input.vwap + tolerance : c.high >= input.vwap - tolerance);
  const reclaimed = trigger ? directionalAbove(input, trigger.close, input.vwap) : false;
  const entry = input.price;
  const swing = input.direction === 'BULL' ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
  const stop = input.direction === 'BULL' ? Math.min(swing, input.vwap) - input.atr20 * 0.1 : Math.max(swing, input.vwap) + input.atr20 * 0.1;
  const target = input.direction === 'BULL'
    ? entry + Math.max(input.atr20 * 0.9, Math.abs(entry - stop) * PREFERRED_RR)
    : entry - Math.max(input.atr20 * 0.9, Math.abs(stop - entry) * PREFERRED_RR);
  const tradePlan = directionOk(input) && recent.length >= 4 ? planFromLevels(input, entry, stop, target, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    input.vwapAligned ? pass('VWAP side', 'Price is on correct VWAP side') : fail('VWAP side', 'Price not aligned with VWAP'),
    input.trendAligned ? pass('5m trend aligned', input.trend5m) : fail('5m trend aligned', 'EMA9/EMA21 not aligned'),
    touchedVwap ? pass('Pullback into value', 'Recent candles tested VWAP/EMA zone') : fail('Pullback into value', 'Waiting for pullback'),
    reclaimed ? pass('Reclaim candle', 'Latest candle reclaimed direction') : fail('Reclaim candle', 'Waiting for reclaim'),
    input.rvol >= 1.0 ? pass('Volume confirmation', `${round(input.rvol, 2)}x`) : fail('Volume confirmation', 'Need 1x RVOL — below average is a trap'),
    ema1mCheck(input),
  ];
  return signal('vwap_pullback', input, checklist, tradePlan, 'VWAP pullback continuation with trend alignment, reclaim, and 1m entry timing.');
}

export function evaluateRsContinuation(input: StrategyInput): StrategySignal {
  const trigger = last(input.candles.five);
  const recent = input.candles.five.slice(-8);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const microHigh = highs.length ? Math.max(...highs.slice(0, -1)) : 0;
  const microLow = lows.length ? Math.min(...lows.slice(0, -1)) : 0;
  const breakout = trigger ? directionalBreak(input, trigger.close, microHigh, microLow) : false;
  const rsEdge = input.direction === 'BULL' ? input.rsVsBenchmark >= 1.02 : input.rsVsBenchmark <= 0.98;
  const entry = input.price;
  const stop = input.direction === 'BULL' ? microLow - input.atr20 * 0.1 : microHigh + input.atr20 * 0.1;
  const target = input.direction === 'BULL'
    ? entry + Math.max(input.atr20, Math.abs(entry - stop) * PREFERRED_RR)
    : entry - Math.max(input.atr20, Math.abs(stop - entry) * PREFERRED_RR);
  const tradePlan = directionOk(input) && recent.length >= 6 ? planFromLevels(input, entry, stop, target, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    rsEdge ? pass('Relative strength edge', `${round(input.rsVsBenchmark, 3)} vs SPY`) : fail('Relative strength edge', 'No clear RS edge vs SPY'),
    input.vwapAligned ? pass('VWAP hold', 'Stock holds VWAP direction') : fail('VWAP hold', 'Stock not holding VWAP'),
    input.trendAligned ? pass('Trend alignment', input.trend5m) : fail('Trend alignment', '5m trend not aligned'),
    breakout ? pass('Micro range break', 'Latest candle broke the local range') : fail('Micro range break', 'Waiting for micro breakout'),
    input.rvol >= 1.2 ? pass('RVOL on breakout', `${round(input.rvol, 2)}x — volume confirmed`) : fail('RVOL on breakout', 'Breakout without volume is a trap — need 1.2x'),
    ema1mCheck(input),
  ];
  return signal('rs_continuation', input, checklist, tradePlan, 'Relative strength continuation after local range break with RVOL confirmation.');
}

export function evaluateLiquiditySweep(input: StrategyInput): StrategySignal {
  const range = openingRange(input.candles.five, 3);
  const recent = input.candles.five.slice(-5);
  const trigger = last(recent);
  const swept = Boolean(range && recent.some((c) => input.direction === 'BULL' ? c.low < range.low : c.high > range.high));
  const reclaimed = Boolean(range && trigger && (input.direction === 'BULL' ? trigger.close > range.low : trigger.close < range.high));
  const entry = input.price;
  // Stop below/above the specific sweep candle, not arbitrary min of all recent candles.
  const sweepCandle = range ? recent.find((c) => input.direction === 'BULL' ? c.low < range.low : c.high > range.high) || null : null;
  const stop = input.direction === 'BULL'
    ? (sweepCandle ? sweepCandle.low : Math.min(...recent.map((c) => c.low))) - input.atr20 * 0.08
    : (sweepCandle ? sweepCandle.high : Math.max(...recent.map((c) => c.high))) + input.atr20 * 0.08;
  const target = input.direction === 'BULL'
    ? entry + Math.abs(entry - stop) * PREFERRED_RR
    : entry - Math.abs(stop - entry) * PREFERRED_RR;
  const tradePlan = directionOk(input) && range ? planFromLevels(input, entry, stop, target, trigger) : null;
  const checklist = [
    directionOk(input) ? pass('Directional bias', input.direction) : fail('Directional bias', 'No BULL/BEAR bias'),
    htfTrendCheck(input),
    range ? pass('Reference liquidity level', 'Opening range available') : fail('Reference liquidity level', 'Need opening range'),
    swept ? pass('Liquidity swept', 'Price swept the reference level') : fail('Liquidity swept', 'No sweep yet'),
    reclaimed ? pass('Reclaim', 'Price reclaimed the swept level') : fail('Reclaim', 'Waiting for reclaim'),
    input.rvol >= 1.0 ? pass('Volume confirmation', `${round(input.rvol, 2)}x`) : fail('Volume confirmation', 'Need 1x RVOL on sweep'),
    ema1mCheck(input),
  ];
  return signal('liquidity_sweep', input, checklist, tradePlan, 'Liquidity sweep and reclaim with structure-based stop and 1m timing.');
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
  const stop = structureLow !== null && structureHigh !== null
    ? (dir === 'BULL' ? structureLow - input.atr20 * 0.1 : structureHigh + input.atr20 * 0.1)
    : (dir === 'BULL' ? entry - input.atr20 * 0.45 : entry + input.atr20 * 0.45);
  const target = dir === 'BULL'
    ? entry + Math.abs(entry - stop) * PREFERRED_RR
    : entry - Math.abs(stop - entry) * PREFERRED_RR;
  const tradePlan = hasStructure ? planFromLevels(input, entry, stop, target, trigger) : null;

  const checklist = [
    pass('Directional bias', dir),
    htfTrendCheck(input),
    atOb
      ? pass('Order block', ob ? `OB ${ob.low.toFixed(2)}–${ob.high.toFixed(2)}` : 'OB at price')
      : fail('Order block', 'No active unmitigated OB at current price'),
    obReject
      ? pass('OB rejection candle', 'Rejection confirmed at order block')
      : fail('OB rejection candle', 'No rejection candle — wait for confirmation'),
    atFvg
      ? pass('FVG confluence', gap ? `Gap ${gap.gapLow.toFixed(2)}–${gap.gapHigh.toFixed(2)}` : 'FVG present')
      : fail('FVG confluence', 'No aligned unfilled FVG near price'),
    input.vwapAligned ? pass('VWAP confluence', 'VWAP supports direction') : fail('VWAP confluence', 'VWAP does not support direction'),
    input.rvol >= 1.0 ? pass('Volume', `${round(input.rvol, 2)}x`) : fail('Volume', 'Need 1x RVOL at structure'),
    ema1mCheck(input),
  ];
  return signal('ob_fvg_retest', input, checklist, tradePlan, 'OB/FVG retest with real structure detection, VWAP, RVOL, 1m timing.');
}

export function evaluateStrategies(input: StrategyInput): StrategySignal[] {
  return [
    evaluateOrbRetest(input),
    evaluateVwapPullback(input),
    evaluateRsContinuation(input),
    evaluateLiquiditySweep(input),
    evaluateObFvgRetest(input),
  ].sort((a, b) => workflowStageRank(b.stage) - workflowStageRank(a.stage) || b.confidence - a.confidence);
}
