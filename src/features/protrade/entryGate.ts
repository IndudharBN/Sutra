// Entry-gate logic that decides whether a scanner row is tradeable — as pure functions.
//
// This mirrors daemon/src/engine/proTradeScannerApi.ts (scoreRow, direction, base
// filters, the `qualified` expression, RETIRED_STRATEGIES). It exists so the backtest
// applies the SAME gates the live executor does. Before this the backtest hard-coded
// score=70, never checked RVOL/VWAP/5m/15m alignment, traded retired strategies, and
// could re-enter a symbol several times a day — so it measured a different system than
// the one trading (backtest WR 30% vs live 45%).
//
// KEEP IN SYNC with the scanner until the scanner imports this module (planned).
// Not modelled here (need data the replay lacks): news catalyst tier, sector-ETF trend,
// SPY/QQQ tide, circuit breakers, regime governor. Catalyst/sector only ADD score live,
// so omitting them makes replayed scores slightly conservative.

import type { Candle } from '../scanner/ohlcv';

export const RETIRED_STRATEGIES: string[] = ['vwap_pullback', 's7_volume_surge', 'orb_retest', 'sniper_1m'];
export const REVERSAL_STRATEGIES = new Set(['ob_fvg_retest', 'mss_breakout']);
export const QUALIFIED_RVOL_MIN = 1.2;
export const QUALIFIED_MIN_SCORE = 65;

/** True-range ATR over the last `period` bars of any timeframe; 0 if too few bars. */
export function computeAtr(bars: Candle[], period = 14): number {
  if (bars.length < 2) return 0;
  const recent = bars.slice(-(period + 1));
  let total = 0;
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i];
    const p = recent[i - 1];
    total += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    count++;
  }
  return count > 0 ? total / count : 0;
}

export type Trend = 'UP' | 'DOWN' | 'FLAT';

/** Live direction rule: after 10:15 ET VWAP+5m trend decide (gap fallback); before, 15m trend. */
export function liveDirection(i: {
  price: number; vwap: number; trend5m: Trend; trend15m: Trend; gapPct: number; etMinutes: number;
}): 'BULL' | 'BEAR' | 'NEUTRAL' {
  const { price, vwap, trend5m, trend15m, gapPct, etMinutes } = i;
  if (etMinutes >= 10 * 60 + 15) {
    return price > vwap && trend5m === 'UP' ? 'BULL'
      : price < vwap && trend5m === 'DOWN' ? 'BEAR'
      : gapPct > 0.5 ? 'BULL'
      : gapPct < -0.5 ? 'BEAR' : 'NEUTRAL';
  }
  return trend15m === 'UP' ? 'BULL'
    : trend15m === 'DOWN' ? 'BEAR'
    : gapPct > 0.5 ? 'BULL'
    : gapPct < -0.5 ? 'BEAR' : 'NEUTRAL';
}

/** Universe filter failures (empty array = pass). Same bounds as the scanner. */
export function baseFailures(price: number, atrPct: number, dollarVolM: number): string[] {
  const failures: string[] = [];
  if (price < 1 || price > 1500) failures.push('price');
  if (atrPct < 2.5 || atrPct > 12) failures.push('atrPct');
  if (dollarVolM < 3) failures.push('dollarVol');
  return failures;
}

export function scoreRow(input: {
  rvol: number; gapPct: number; atrPct: number; dollarVolM: number;
  vwapAligned: boolean; trendAligned: boolean; trend15mAligned: boolean;
  catalyst?: 'hard' | 'soft' | 'none'; sectorAligned?: boolean; smallFloat?: boolean;
}): number {
  let score = 0;
  if (input.rvol >= 1.5) score += 22; else if (input.rvol >= 1) score += 13;
  const gapAbs = Math.abs(input.gapPct);
  if (gapAbs >= 2) score += 12; else if (gapAbs >= 1) score += 6;
  if (input.vwapAligned) score += 13;
  if (input.trendAligned) score += 13;
  if (input.trend15mAligned) score += 13;
  if (input.atrPct >= 3.5) score += 7; else if (input.atrPct >= 2.5) score += 4;
  if (input.dollarVolM >= 25) score += 6; else if (input.dollarVolM >= 3) score += 3;
  if (input.catalyst === 'hard') score += 12; else if (input.catalyst === 'soft') score += 4;
  if (input.sectorAligned) score += 6;
  if (input.smallFloat) score += 5;
  return Math.min(100, score);
}

/** The scanner's `qualified` expression. */
export function isQualified(i: {
  basePass: boolean; score: number; rvol: number;
  vwapAligned: boolean; trendAligned: boolean; trend15mAligned: boolean;
  primaryStrategyId: string;
}): boolean {
  return i.basePass
    && i.score >= QUALIFIED_MIN_SCORE
    && i.rvol >= QUALIFIED_RVOL_MIN
    && i.vwapAligned
    && i.trendAligned
    && (REVERSAL_STRATEGIES.has(i.primaryStrategyId) ? true : i.trend15mAligned);
}
