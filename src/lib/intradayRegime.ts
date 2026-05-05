import { fetchBars } from './alpacaClient';

export type IntradayRegimeType = 'TRENDING' | 'NORMAL' | 'CHOPPY';

export interface IntradayRegime {
  regime: IntradayRegimeType;
  spyRangePct: number;  // today's range / SPY ADR (0–1+)
  spyRange: number;
  spyAdr: number;
}

// Module-level cache — 5 min TTL, resets on page reload
let _cached: { result: IntradayRegime; expiresAt: number } | null = null;

function toETDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function fetchIntradayRegime(): Promise<IntradayRegime> {
  if (_cached && Date.now() < _cached.expiresAt) return _cached.result;

  try {
    const [fiveMap, dailyMap] = await Promise.all([
      fetchBars(['SPY'], '5m'),
      fetchBars(['SPY'], '1d'),
    ]);

    const spyFive = fiveMap['SPY'] ?? [];
    const spyDaily = dailyMap['SPY'] ?? [];

    // Today's intraday range: filter 5m bars to ET today
    const todayET = toETDate(new Date());
    const todayBars = spyFive.filter(
      (b) => toETDate(new Date(b.time)) === todayET,
    );
    const spyRange = todayBars.length >= 2
      ? Math.max(...todayBars.map((b) => b.high)) - Math.min(...todayBars.map((b) => b.low))
      : 0;

    // ADR: average daily range over last 20 completed sessions (exclude today's live bar)
    const completedDays = spyDaily.length > 1 ? spyDaily.slice(-21, -1) : [];
    const spyAdr = completedDays.length > 0
      ? completedDays.reduce((s, b) => s + (b.high - b.low), 0) / completedDays.length
      : 0;

    const spyRangePct = spyAdr > 0 ? spyRange / spyAdr : 0;
    const regime: IntradayRegimeType =
      spyRangePct < 0.40 ? 'CHOPPY' : spyRangePct > 0.65 ? 'TRENDING' : 'NORMAL';

    const result: IntradayRegime = { regime, spyRangePct, spyRange: Math.round(spyRange * 100) / 100, spyAdr: Math.round(spyAdr * 100) / 100 };
    _cached = { result, expiresAt: Date.now() + 5 * 60_000 };
    return result;
  } catch {
    const fallback: IntradayRegime = { regime: 'NORMAL', spyRangePct: 0.5, spyRange: 0, spyAdr: 0 };
    _cached = { result: fallback, expiresAt: Date.now() + 60_000 };
    return fallback;
  }
}

export const REGIME_SIZE_MULT: Record<IntradayRegimeType, number> = {
  TRENDING: 1.0,
  NORMAL: 1.0,
  CHOPPY: 0.5,
};

export const REGIME_COLOR: Record<IntradayRegimeType, string> = {
  TRENDING: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  NORMAL: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
  CHOPPY: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
};
