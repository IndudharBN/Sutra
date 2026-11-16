import { describe, expect, it } from 'vitest';
import { RETIRED_STRATEGIES, etDateKey, etMinutes, isMarketClosedET, isQualified, sessionProgress } from './entryGate';

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

describe('arithmetic ET converter matches Intl (2024-2029, incl. every DST boundary)', () => {
  const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hour12: false });
  const ref = (ms: number) => {
    const o: Record<string, string> = {};
    for (const p of FMT.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { minutes: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10), date: `${o.year}-${o.month}-${o.day}` };
  };
  it('agrees on a dense sweep and around every transition', () => {
    const samples: number[] = [];
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2030, 0, 1); t += 41 * 60_000 + 7_000) samples.push(t);
    for (let y = 2024; y <= 2029; y++) {
      const firstSun = (m: number) => 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7);
      for (const edge of [Date.UTC(y, 2, firstSun(2) + 7, 7, 0), Date.UTC(y, 10, firstSun(10), 6, 0)]) {
        for (let d = -3; d <= 3; d++) samples.push(edge + d * 60_000);
      }
    }
    let bad = 0;
    for (const ms of samples) {
      const r = ref(ms);
      if (etMinutes(ms) !== r.minutes || etDateKey(ms) !== r.date) bad++;
    }
    expect(bad).toBe(0);
  });
  it('is fast: 200k conversions well under a second', () => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 200_000; i++) x += etMinutes(1_700_000_000_000 + i * 60_000);
    expect(x).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
