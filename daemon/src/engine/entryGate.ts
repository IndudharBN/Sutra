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

import type { Candle } from './ohlcv';

// ema20_bounce (S8) retired 2026-11-16: 141 real fills since 2026-08-27, PF 0.68, -$2,411 (more than
// the whole book's net loss), WR 40%, and PF 0.50 / WR 38% since the S4 fix; the replay agrees
// (negative). Remove it from this list to re-trial it.
export const RETIRED_STRATEGIES: string[] = ['vwap_pullback', 's7_volume_surge', 'orb_retest', 'sniper_1m', 'ema20_bounce'];
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

// ── DST-safe US-equity session clock ─────────────────────────────────────────
// The session boundaries used to be hard-coded in UTC (13:30-20:00), which is only right
// during daylight time. Since the Nov 2 change to EST the market is 14:30-21:00 UTC, so
// RVOL's session-progress was overstated (RVOL deflated ~20-35% in the morning), pre-market
// bars counted as "regular session" for opening ranges, and the "market closed" flag fired
// at 15:00 ET. Everything session-related must be computed in America/New_York.
export const RTH_OPEN_MIN = 9 * 60 + 30;
export const RTH_CLOSE_MIN = 16 * 60;

// Pure-arithmetic US Eastern time (2007+ rules: DST from 2nd Sunday of March 02:00 EST to 1st Sunday
// of November 02:00 EDT). The scanner converts thousands of candle timestamps per cycle; going through
// Intl / toLocaleString for each one (it builds a formatter every call) was ~60% of a full scan's CPU
// and starved the event loop. This is ~100x cheaper and is verified against Intl in entryGate.test.ts.
const DST_CACHE = new Map<number, [number, number]>();
function dstWindowUtc(year: number): [number, number] {
  let w = DST_CACHE.get(year);
  if (!w) {
    const firstSun = (month: number) => 1 + ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7);
    w = [
      Date.UTC(year, 2, firstSun(2) + 7, 7, 0),  // 02:00 EST = 07:00 UTC
      Date.UTC(year, 10, firstSun(10), 6, 0),    // 02:00 EDT = 06:00 UTC
    ];
    DST_CACHE.set(year, w);
  }
  return w;
}
function etShifted(t: Date | string | number): number {
  const ms = typeof t === 'number' ? t : new Date(t).getTime();
  const [start, end] = dstWindowUtc(new Date(ms).getUTCFullYear());
  return ms + (ms >= start && ms < end ? -4 : -5) * 3_600_000;
}

/** Minutes since midnight, America/New_York. */
export function etMinutes(t: Date | string | number): number {
  const sh = etShifted(t);
  return Math.floor((((sh % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
}

/** 'YYYY-MM-DD' calendar date in America/New_York. */
export function etDateKey(t: Date | string | number): string {
  return new Date(etShifted(t)).toISOString().slice(0, 10);
}

/** True outside Mon-Fri 09:30-16:00 ET (holidays not modelled). */
export function isMarketClosedET(t: Date | string | number): boolean {
  const sh = etShifted(t);
  const dow = new Date(sh).getUTCDay();
  const minutes = Math.floor((((sh % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  return dow === 0 || dow === 6 || minutes < RTH_OPEN_MIN || minutes >= RTH_CLOSE_MIN;
}

/** Fraction of the regular session elapsed, clamped to [0.05, 1] (for RVOL projection). */
export function sessionProgress(t: Date | string | number): number {
  return Math.min(1, Math.max(0.05, (etMinutes(t) - RTH_OPEN_MIN) / (RTH_CLOSE_MIN - RTH_OPEN_MIN)));
}
