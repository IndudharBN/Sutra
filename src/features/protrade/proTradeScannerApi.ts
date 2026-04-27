import { fetchBars, fetchUniverseMeta, buildCandleSet, selectTopSymbols } from '../../lib/alpacaClient';
import type { SymbolMeta } from '../../lib/alpacaClient';
import { ema, vwapLatest } from '../scanner/indicators';
import type { Candle, CandleSet } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { evaluateStrategies } from './strategyEngine';
import type { MarketDataProviderStatus, StrategySignal, WorkflowStage } from './workflowTypes';
import { DEFAULT_LIVE_UNIVERSE } from '../scanner/liveScannerApi';

export interface ProTradeRow {
  symbol: string;
  company: string;
  exchange: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  price: number;
  score: number;
  qualified: boolean;
  reason: string;
  atr20: number;
  atrPct: number;
  dollarVolM: number;
  mktCapB: number | null;
  beta: number;
  betaMax: number;
  rsVsBenchmark: number;
  basePass: boolean;
  baseReason: string;
  earningsChecked: boolean;
  earningsDays: number | null;
  earningsStatus: string;
  gapPct: number;
  dayChangePct: number;
  rvol: number;
  vwap: number;
  vwapAligned: boolean;
  trend5m: 'UP' | 'DOWN' | 'FLAT';
  trend15m: 'UP' | 'DOWN' | 'FLAT';
  trendAligned: boolean;
  trend15mAligned: boolean;
  sourceBucket: 'pro' | 'scored' | 'raw' | 'filtered';
  workflowStage: WorkflowStage;
  strategySignals: StrategySignal[];
  primaryStrategy: StrategySignal | null;
  tradePlan: StrategySignal['tradePlan'];
  confidence: number;
  dataStatus: MarketDataProviderStatus;
  candles: {
    one: Candle[];
    five: Candle[];
    fifteen: Candle[];
    daily: Candle[];
  };
}

export interface ProTradeSnapshot {
  rows: ProTradeRow[];
  rawRows: ProTradeRow[];
  filteredRows: ProTradeRow[];
  qualifiedCount: number;
  scannedCount: number;
  rawCount: number;
  filteredOut: number;
  fetchedAt: string;
  providerStatus: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function candleTrend(candles: Candle[]) {
  if (candles.length < 25) return 'FLAT' as const;
  const values = closes(candles);
  const e9 = last(ema(values, 9));
  const e21 = last(ema(values, 21));
  if (e9 > e21) return 'UP' as const;
  if (e9 < e21) return 'DOWN' as const;
  return 'FLAT' as const;
}

function computeDirection(h1: Candle[]): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (h1.length < 22) return 'NEUTRAL';
  const e9 = last(ema(closes(h1), 9));
  const e21 = last(ema(closes(h1), 21));
  if (!Number.isFinite(e9) || !Number.isFinite(e21)) return 'NEUTRAL';
  if (e9 > e21 * 1.001) return 'BULL';
  if (e9 < e21 * 0.999) return 'BEAR';
  return 'NEUTRAL';
}

function computeAtr20(daily: Candle[]): number {
  if (daily.length < 2) return 0;
  const recent = daily.slice(-21);
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

function scoreRow(input: {
  rvol: number;
  gapPct: number;
  atrPct: number;
  dollarVolM: number;
  vwapAligned: boolean;
  trendAligned: boolean;
  trend15mAligned: boolean;
}) {
  let score = 0;
  const reasons: string[] = [];

  if (input.rvol >= 1.5) { score += 25; reasons.push('RVOL strong'); }
  else if (input.rvol >= 1) { score += 15; reasons.push('RVOL acceptable'); }
  else reasons.push('RVOL weak');

  const gapAbs = Math.abs(input.gapPct);
  if (gapAbs >= 2) { score += 15; reasons.push('active gap'); }
  else if (gapAbs >= 1) { score += 8; reasons.push('small gap'); }
  else reasons.push('no meaningful gap');

  if (input.vwapAligned) { score += 15; reasons.push('VWAP aligned'); }
  else reasons.push('VWAP not aligned');

  if (input.trendAligned) { score += 15; reasons.push('5m trend aligned'); }
  else reasons.push('5m trend not aligned');

  if (input.trend15mAligned) { score += 15; reasons.push('15m directional'); }
  else reasons.push('15m not directional');

  if (input.atrPct >= 3.5) { score += 8; reasons.push('high intraday range potential'); }
  else if (input.atrPct >= 2.5) { score += 5; reasons.push('range acceptable'); }
  else reasons.push('range low');

  if (input.dollarVolM >= 25) { score += 7; reasons.push('liquid'); }
  else if (input.dollarVolM >= 3) { score += 4; reasons.push('liquidity acceptable'); }
  else reasons.push('liquidity weak');

  return { score: Math.min(100, score), reason: reasons.join(' | ') };
}

function dataProviderStatus(fetchedAt?: string): MarketDataProviderStatus {
  const lastUpdated = fetchedAt || new Date().toISOString();
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000));
  return {
    provider: 'alpaca',
    mode: 'live',
    lastUpdated,
    stale: ageSeconds > 45,
    ageSeconds,
    message: ageSeconds > 45 ? `Alpaca data stale (${ageSeconds}s)` : `Alpaca IEX ${ageSeconds}s old`,
  };
}

function buildRowFromAlpaca(
  symbol: string,
  meta: SymbolMeta,
  candleSet: CandleSet,
  providerStatus: MarketDataProviderStatus,
): ProTradeRow {
  const one = (candleSet['1m'] || []).slice(-120);
  const five = (candleSet['5m'] || []).slice(-120);
  const fifteen = (candleSet['15m'] || []).slice(-80);
  const h1 = (candleSet['1h'] || []).slice(-60);
  const daily = (candleSet['1d'] || []).slice(-80);

  const price = meta.price;
  const direction = computeDirection(h1);
  const atr20 = computeAtr20(daily);
  const atrPct = price > 0 ? (atr20 / price) * 100 : 0;
  const dollarVolM = (price * meta.todayVolume) / 1_000_000;

  const vwap = five.length ? vwapLatest(five) : price;
  const trend5m = candleTrend(five);
  const trend15m = candleTrend(fifteen);
  const vwapAligned = direction === 'BULL' ? price > vwap : direction === 'BEAR' ? price < vwap : false;
  const trendAligned = direction === 'BULL' ? trend5m === 'UP' : direction === 'BEAR' ? trend5m === 'DOWN' : false;
  const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : direction === 'BEAR' ? trend15m === 'DOWN' : false;

  const failures: string[] = [];
  if (price < 1 || price > 500) failures.push('Price outside $1–$500');
  if (atrPct < 1.5) failures.push('ADR% below 1.5%');
  if (dollarVolM < 3) failures.push('Dollar volume below $3M');
  const basePass = failures.length === 0;
  const baseReason = failures.length ? failures.join(' | ') : 'Price OK, ADR% OK, dollar vol OK';

  const scored = scoreRow({ rvol: meta.rvolEst, gapPct: meta.gapPct, atrPct, dollarVolM, vwapAligned, trendAligned, trend15mAligned });

  const candles = { one, five, fifteen, daily };
  const strategySignals = evaluateStrategies({
    symbol,
    company: symbol,
    direction,
    price: round(price, 2),
    score: scored.score,
    rvol: meta.rvolEst,
    gapPct: meta.gapPct,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    rsVsBenchmark: 1,
    vwap,
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    dataStatus: providerStatus,
    candles,
  });

  const primaryStrategy = strategySignals[0] || null;
  const workflowStage: WorkflowStage = primaryStrategy?.stage && primaryStrategy.stage !== 'pro_watchlist'
    ? primaryStrategy.stage
    : basePass
      ? 'pro_watchlist'
      : 'raw_candidates';

  return {
    symbol,
    company: symbol,
    exchange: 'US',
    direction,
    price: round(price, 2),
    score: scored.score,
    qualified: basePass && scored.score >= 65 && meta.rvolEst >= 0.8 && vwapAligned && trendAligned && trend15mAligned,
    reason: `${baseReason} | ${scored.reason}`,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    dollarVolM: round(dollarVolM, 1),
    mktCapB: null,
    beta: 0,
    betaMax: 2.8,
    rsVsBenchmark: 1,
    basePass,
    baseReason,
    earningsChecked: false,
    earningsDays: null,
    earningsStatus: 'Not checked',
    gapPct: round(meta.gapPct, 2),
    dayChangePct: round(meta.intradayChangePct, 2),
    rvol: round(meta.rvolEst, 2),
    vwap: round(vwap, 2),
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    sourceBucket: 'scored',
    workflowStage,
    strategySignals,
    primaryStrategy,
    tradePlan: primaryStrategy?.tradePlan || null,
    confidence: primaryStrategy?.confidence || scored.score,
    dataStatus: providerStatus,
    candles,
  };
}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchProTradeScannerSnapshot(): Promise<ProTradeSnapshot> {
  // US-only symbols (Alpaca IEX doesn't support LSE)
  const candidates = DEFAULT_LIVE_UNIVERSE.filter((s) => !s.endsWith('.L'));

  // Step 1: snapshot → filter to top 60 most active
  const metas = await fetchUniverseMeta(candidates);
  const top = selectTopSymbols(metas, 60);

  // Step 2: fetch all timeframes in parallel (TTL-cached)
  const [bars1m, bars5m, bars15m, bars1h, bars1d] = await Promise.all([
    fetchBars(top, '1m'),
    fetchBars(top, '5m'),
    fetchBars(top, '15m'),
    fetchBars(top, '1h'),
    fetchBars(top, '1d'),
  ]);

  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));

  const rows = top
    .flatMap((sym) => {
      const meta = metaMap.get(sym);
      if (!meta) return [];
      const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
      return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus)];
    })
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score);

  return {
    rows,
    rawRows: rows,
    filteredRows: [],
    qualifiedCount: rows.filter((r) => r.qualified).length,
    scannedCount: rows.length,
    rawCount: candidates.length,
    filteredOut: candidates.length - top.length,
    fetchedAt,
    providerStatus: `Alpaca IEX • ${top.length} symbols`,
  };
}
