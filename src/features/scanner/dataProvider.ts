import type { Candle, Interval } from './ohlcv';

const RANGE_BY_INTERVAL: Record<Interval, string> = {
  '1m': '1d',
  '5m': '2d',
  '15m': '5d',
  '1h': '1mo',
  '1d': '60d',
};

const cache = new Map<string, { ts: number; candles: Candle[] }>();
const TTL_BY_INTERVAL: Record<Interval, number> = {
  '1m': 15_000,
  '5m': 45_000,
  '15m': 120_000,
  '1h': 600_000,
  '1d': 3_600_000,
};

export async function fetchYahooCandles(symbol: string, interval: Interval, now = Date.now()): Promise<Candle[]> {
  const key = `${symbol}:${interval}`;
  const cached = cache.get(key);
  if (cached && now - cached.ts < TTL_BY_INTERVAL[interval]) return cached.candles;

  const range = RANGE_BY_INTERVAL[interval];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Yahoo fetch failed ${response.status}`);
  const json = await response.json();
  const result = json?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const candles = timestamps.map((ts, index) => ({
    time: new Date(ts * 1000).toISOString(),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index] || 0),
  })).filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close));

  cache.set(key, { ts: now, candles });
  return candles;
}

export async function fetchScannerCandleSet(symbol: string) {
  const entries = await Promise.all((['1m', '5m', '15m', '1h', '1d'] as Interval[]).map(async (interval) => [interval, await fetchYahooCandles(symbol, interval)] as const));
  return Object.fromEntries(entries);
}
