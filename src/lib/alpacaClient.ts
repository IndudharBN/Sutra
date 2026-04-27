import { env } from './env';
import type { Candle, CandleSet, Interval } from '../features/scanner/ohlcv';

// ── Alpaca timeframe mapping ──────────────────────────────────────────────────
const ALPACA_TF: Record<Interval, string> = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '1d': '1Day',
};

// Bar history to fetch per interval (same TTLs as Stock-analyzer data_cache.py)
const BAR_LIMIT: Record<Interval, number> = {
  '1m': 120, '5m': 200, '15m': 80, '1h': 30, '1d': 60,
};

const TTL_MS: Record<Interval, number> = {
  '1m': 15_000, '5m': 45_000, '15m': 120_000, '1h': 600_000, '1d': 3_600_000,
};

interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number; }
interface AlpacaSnapshot {
  latestTrade?: { p: number };
  latestQuote?: { ap: number; bp: number };
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
  minuteBar?: AlpacaBar;
}

// ── In-memory TTL cache (shared for the browser session) ─────────────────────
interface CacheEntry<T> { data: T; expiresAt: number; }
const _cache = new Map<string, CacheEntry<unknown>>();
function cacheGet<T>(key: string): T | null {
  const e = _cache.get(key) as CacheEntry<T> | undefined;
  return e && Date.now() < e.expiresAt ? e.data : null;
}
function cacheSet<T>(key: string, data: T, ttlMs: number) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Base fetch ────────────────────────────────────────────────────────────────
async function alpacaGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { alpacaKey, alpacaSecret, alpacaDataUrl } = env;
  if (!alpacaKey || !alpacaSecret) throw new Error('Alpaca API keys not configured. Set VITE_ALPACA_KEY and VITE_ALPACA_SECRET in .env');
  const url = new URL(path, alpacaDataUrl);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret },
  });
  if (!res.ok) throw new Error(`Alpaca ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function toCandle(bar: AlpacaBar): Candle {
  return { time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v };
}

// ── Multi-symbol bars (batch — 1 API call for all symbols) ───────────────────
export async function fetchBars(symbols: string[], interval: Interval): Promise<Record<string, Candle[]>> {
  if (!symbols.length) return {};
  const cacheKey = `bars:${interval}:${symbols.sort().join(',')}`;
  const hit = cacheGet<Record<string, Candle[]>>(cacheKey);
  if (hit) return hit;

  const data = await alpacaGet<{ bars: Record<string, AlpacaBar[]> }>('/v2/stocks/bars', {
    symbols: symbols.join(','),
    timeframe: ALPACA_TF[interval],
    limit: String(BAR_LIMIT[interval]),
    sort: 'asc',
    feed: 'iex',
  });

  const result: Record<string, Candle[]> = {};
  for (const [sym, bars] of Object.entries(data.bars || {})) {
    result[sym] = bars.map(toCandle);
  }
  cacheSet(cacheKey, result, TTL_MS[interval]);
  return result;
}

// ── Snapshots (price, RVOL estimate, gap, current minute bar) ─────────────────
export async function fetchSnapshots(symbols: string[]): Promise<Record<string, AlpacaSnapshot>> {
  if (!symbols.length) return {};
  const cacheKey = `snap:${symbols.sort().join(',')}`;
  const hit = cacheGet<Record<string, AlpacaSnapshot>>(cacheKey);
  if (hit) return hit;

  const data = await alpacaGet<Record<string, AlpacaSnapshot>>('/v2/stocks/snapshots', {
    symbols: symbols.join(','),
    feed: 'iex',
  });
  cacheSet(cacheKey, data, 15_000);
  return data;
}

// ── Build CandleSet for a single symbol from pre-fetched bar maps ─────────────
export function buildCandleSet(
  symbol: string,
  barMaps: Partial<Record<Interval, Record<string, Candle[]>>>,
): CandleSet {
  const set: CandleSet = {};
  for (const [interval, map] of Object.entries(barMaps)) {
    const candles = map?.[symbol];
    if (candles?.length) set[interval as Interval] = candles;
  }
  return set;
}

// ── Universe snapshot (gap, RVOL estimate, price) for filtering ───────────────
export interface SymbolMeta {
  symbol: string;
  price: number;
  prevClose: number;
  gapPct: number;
  todayVolume: number;
  rvolEst: number;   // rough estimate: today_vol / prev_day_vol * session_factor
  intradayChangePct: number;
}

function sessionProgressFactor(): number {
  const now = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = 13 * 60 + 30;
  const close = 20 * 60;
  return Math.min(1, Math.max(0.05, (utcMins - open) / (close - open)));
}

export async function fetchUniverseMeta(symbols: string[]): Promise<SymbolMeta[]> {
  const snaps = await fetchSnapshots(symbols);
  const factor = sessionProgressFactor();
  return symbols.flatMap((sym) => {
    const snap = snaps[sym];
    if (!snap) return [];
    const price = snap.latestTrade?.p || snap.minuteBar?.c || snap.dailyBar?.c || 0;
    if (!price) return [];
    const prevClose = snap.prevDailyBar?.c || 0;
    const todayOpen = snap.dailyBar?.o || price;
    const gapPct = prevClose > 0 ? ((todayOpen - prevClose) / prevClose) * 100 : 0;
    const intradayChangePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    const todayVol = snap.dailyBar?.v || 0;
    const prevVol = snap.prevDailyBar?.v || 0;
    const rvolEst = prevVol > 0 && factor > 0 ? todayVol / (prevVol * factor) : 0;
    return [{ symbol: sym, price, prevClose, gapPct, todayVolume: todayVol, rvolEst, intradayChangePct }];
  });
}

// ── Select top N most active symbols for the scan universe ───────────────────
export function selectTopSymbols(metas: SymbolMeta[], n = 60): string[] {
  return metas
    .map((m) => ({
      ...m,
      score: Math.abs(m.gapPct) * 3 + m.rvolEst * 20 + Math.abs(m.intradayChangePct) * 2,
    }))
    .filter((m) => m.price > 1 && m.price < 500)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.symbol);
}
