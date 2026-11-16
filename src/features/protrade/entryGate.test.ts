import { describe, expect, it } from 'vitest';
import { RETIRED_STRATEGIES, etMinutes, isMarketClosedET, isQualified, sessionProgress } from './entryGate';

describe('DST-safe session clock', () => {
  it('9:30 ET is minute 570 in both EDT and EST', () => {
    expect(etMinutes('2026-10-12T13:30:00Z')).toBe(570); // EDT (UTC-4)
    expect(etMinutes('2026-11-16T14:30:00Z')).toBe(570); // EST (UTC-5)
  });
  it('pre-market in EST (14:00Z = 9:00 ET) is NOT regular session — the old UTC check said it was', () => {
    expect(isMarketClosedET('2026-11-16T14:00:00Z')).toBe(true);
    expect(isMarketClosedET('2026-11-16T14:35:00Z')).toBe(false);
  });
  it('closes at 16:00 ET in both regimes (21:00Z in EST, 20:00Z in EDT)', () => {
    expect(isMarketClosedET('2026-11-16T20:59:00Z')).toBe(false);
    expect(isMarketClosedET('2026-11-16T21:00:00Z')).toBe(true);
    expect(isMarketClosedET('2026-10-12T19:59:00Z')).toBe(false);
    expect(isMarketClosedET('2026-10-12T20:00:00Z')).toBe(true);
  });
  it('weekend is closed', () => {
    expect(isMarketClosedET('2026-11-14T16:00:00Z')).toBe(true); // Saturday
  });
  it('session progress is the same at the same ET time in EDT and EST', () => {
    expect(sessionProgress('2026-10-12T14:30:00Z')).toBeCloseTo(sessionProgress('2026-11-16T15:30:00Z'), 6); // both 10:30 ET
    expect(sessionProgress('2026-11-16T15:30:00Z')).toBeCloseTo(60 / 390, 6);
  });
});

describe('qualification', () => {
  const ok = { basePass: true, score: 70, rvol: 1.3, vwapAligned: true, trendAligned: true, trend15mAligned: false, primaryStrategyId: 'mss_breakout' };
  it('reversal strategies skip the 15m tape requirement; others need it', () => {
    expect(isQualified(ok)).toBe(true);
    expect(isQualified({ ...ok, primaryStrategyId: 'flag_break' })).toBe(false);
  });
  it('RVOL floor 1.2', () => {
    expect(isQualified({ ...ok, rvol: 1.19 })).toBe(false);
  });
  it('S8 ema20_bounce is retired', () => {
    expect(RETIRED_STRATEGIES).toContain('ema20_bounce');
  });
});
