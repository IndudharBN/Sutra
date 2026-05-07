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

// Evict all cache entries for a specific symbol (called after WebSocket bar close).
export function clearBarCache(symbol: string): void {
  for (const key of _cache.keys()) {
    if (key.includes(symbol)) _cache.delete(key);
  }
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

// ── Single-symbol historical bars with date range (for backtesting) ──────────
export async function fetchHistoricalBars(
  symbol: string,
  start: string,
  end: string,
  interval: Interval = '5m',
): Promise<Candle[]> {
  const cacheKey = `hist:${interval}:${symbol}:${start}:${end}`;
  const hit = cacheGet<Candle[]>(cacheKey);
  if (hit) return hit;

  const all: Candle[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      timeframe: ALPACA_TF[interval],
      start: `${start}T00:00:00Z`,
      end: `${end}T23:59:59Z`,
      limit: '10000',
      sort: 'asc',
      feed: 'iex',
    };
    if (pageToken) params['page_token'] = pageToken;
    const data = await alpacaGet<{ bars: AlpacaBar[]; next_page_token?: string }>(
      `/v2/stocks/${symbol}/bars`,
      params,
    );
    all.push(...(data.bars || []).map(toCandle));
    pageToken = data.next_page_token ?? undefined;
  } while (pageToken);

  cacheSet(cacheKey, all, 3_600_000);
  return all;
}

// ── SPY daily bars (250 bars) + VIX attempt — for macro regime classification ──
export async function fetchSpyDailyBars(): Promise<{ spyBars: Candle[]; vixBars: Candle[] }> {
  const cacheKey = 'spy_regime_daily';
  const hit = cacheGet<{ spyBars: Candle[]; vixBars: Candle[] }>(cacheKey);
  if (hit) return hit;
  const [spyRes, vixRes] = await Promise.allSettled([
    alpacaGet<{ bars: Record<string, AlpacaBar[]> }>('/v2/stocks/bars', {
      symbols: 'SPY', timeframe: '1Day', limit: '250', sort: 'asc', feed: 'iex',
    }),
    alpacaGet<{ bars: Record<string, AlpacaBar[]> }>('/v2/stocks/bars', {
      symbols: 'VIX', timeframe: '1Day', limit: '5', sort: 'asc', feed: 'iex',
    }),
  ]);
  const spyBars = spyRes.status === 'fulfilled' ? (spyRes.value.bars?.['SPY'] ?? []).map(toCandle) : [];
  const vixBars = vixRes.status === 'fulfilled' ? (vixRes.value.bars?.['VIX'] ?? []).map(toCandle) : [];
  const result = { spyBars, vixBars };
  cacheSet(cacheKey, result, 3_600_000); // re-classify at most once per hour
  return result;
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
    .filter((m) => m.price > 1 && m.price < 1500)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.symbol);
}

// ── News: catalyst quality tier per symbol ────────────────────────────────────

export type CatalystTier = 'hard' | 'soft' | 'none';

const HARD_RE = /\b(earnings|beat|beats|topped|exceeded|surpassed|miss|misses|fda|approved|approval|rejected|rejection|merger|acquisition|acquires|acquired|buyout|takeover|joins s&p|added to index|deal closed|contract awarded|guidance raised|guidance lowered)\b/i;
const SOFT_RE = /\b(analyst|upgrade|downgrade|maintains|reiterates|overweight|underweight|price target|target price|sector|market report|economic|survey|outlook)\b/i;

function classifyCatalyst(headline: string): CatalystTier {
  if (HARD_RE.test(headline)) return 'hard';
  if (SOFT_RE.test(headline)) return 'soft';
  return 'none';
}

export async function fetchNewsFlags(symbols: string[]): Promise<Record<string, CatalystTier>> {
  if (!symbols.length) return {};
  const cacheKey = `news2:${symbols.slice().sort().join(',')}`;
  const hit = cacheGet<Record<string, CatalystTier>>(cacheKey);
  if (hit) return hit;

  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const data = await alpacaGet<{ news: Array<{ headline: string; symbols: string[] }> }>('/v1beta1/news', {
    symbols: symbols.join(','),
    limit: '50',
    start: `${todayET}T00:00:00Z`,
  }).catch(() => ({ news: [] as Array<{ headline: string; symbols: string[] }> }));

  const result: Record<string, CatalystTier> = {};
  for (const sym of symbols) result[sym] = 'none';
  for (const article of data.news) {
    const tier = classifyCatalyst(article.headline ?? '');
    for (const sym of article.symbols) {
      if (tier === 'hard') result[sym] = 'hard';
      else if (tier === 'soft' && result[sym] === 'none') result[sym] = 'soft';
    }
  }
  cacheSet(cacheKey, result, 300_000);
  return result;
}

// ── Sector ETF trends ─────────────────────────────────────────────────────────
const SECTOR_ETFS = ['XLF', 'XLK', 'XLY', 'XLE', 'XLV', 'XLI', 'XLB', 'XLP', 'XLU', 'XLRE', 'XLC'];

export const SYMBOL_SECTOR: Record<string, string> = {
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', INTC:'XLK', QCOM:'XLK', MU:'XLK', AMAT:'XLK', LRCX:'XLK', KLAC:'XLK',
  META:'XLC', GOOGL:'XLC', GOOG:'XLC', NFLX:'XLC', DIS:'XLC', CMCSA:'XLC', T:'XLC', VZ:'XLC',
  AMZN:'XLY', TSLA:'XLY', HD:'XLY', MCD:'XLY', NKE:'XLY', SBUX:'XLY', TGT:'XLY', LOW:'XLY',
  JPM:'XLF', BAC:'XLF', WFC:'XLF', GS:'XLF', MS:'XLF', C:'XLF', BLK:'XLF', AXP:'XLF', V:'XLF', MA:'XLF',
  XOM:'XLE', CVX:'XLE', COP:'XLE', OXY:'XLE', SLB:'XLE', HAL:'XLE', MRO:'XLE', DVN:'XLE',
  JNJ:'XLV', UNH:'XLV', PFE:'XLV', ABBV:'XLV', MRK:'XLV', LLY:'XLV', AMGN:'XLV', GILD:'XLV', BMY:'XLV',
  BA:'XLI', CAT:'XLI', GE:'XLI', HON:'XLI', RTX:'XLI', LMT:'XLI', NOC:'XLI', UPS:'XLI', FDX:'XLI',
  WMT:'XLP', PG:'XLP', KO:'XLP', PEP:'XLP', COST:'XLP', CL:'XLP', GIS:'XLP',
  NEE:'XLU', DUK:'XLU', SO:'XLU', D:'XLU', AEP:'XLU',
  AMT:'XLRE', PLD:'XLRE', CCI:'XLRE', SPG:'XLRE', EQIX:'XLRE',
  NEM:'XLB', FCX:'XLB', LIN:'XLB', APD:'XLB', DD:'XLB',
};

export async function fetchSectorTrends(): Promise<Record<string, 'UP' | 'DOWN' | 'FLAT'>> {
  const cacheKey = 'sector:trends';
  const hit = cacheGet<Record<string, 'UP' | 'DOWN' | 'FLAT'>>(cacheKey);
  if (hit) return hit;

  const snaps = await fetchSnapshots(SECTOR_ETFS).catch(() => ({} as Record<string, AlpacaSnapshot>));
  const result: Record<string, 'UP' | 'DOWN' | 'FLAT'> = {};
  for (const etf of SECTOR_ETFS) {
    const snap = snaps[etf];
    if (!snap?.dailyBar || !snap?.prevDailyBar) { result[etf] = 'FLAT'; continue; }
    const pct = (snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c;
    result[etf] = pct > 0.002 ? 'UP' : pct < -0.002 ? 'DOWN' : 'FLAT';
  }
  cacheSet(cacheKey, result, 600_000);
  return result;
}
