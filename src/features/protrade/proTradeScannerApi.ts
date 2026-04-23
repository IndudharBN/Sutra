import { supabase } from '../../lib/supabaseClient';
import { ema, vwapLatest } from '../scanner/indicators';
import type { Candle, CandleSet } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { evaluateStrategies } from './strategyEngine';
import type { MarketDataProviderStatus, StrategySignal, WorkflowStage } from './workflowTypes';

interface YahooCandleResponse {
  ok: boolean;
  status: string;
  results: Array<{ symbol: string; company?: string; candles: CandleSet }>;
  universe?: {
    count: number;
    raw_count: number;
    filtered_out: number;
    raw_candidates?: Array<{ symbol: string; mkt_cap_b?: number | null; exchange?: 'US' | 'LSE' }>;
    filtered_symbols?: string[];
    enriched?: Array<{
      symbol: string;
      long_name?: string;
      last_price?: number;
      atr20?: number;
      atr_pct?: number;
      beta?: number;
      dollar_vol_m?: number;
      mkt_cap_b?: number | null;
      rs_vs_spy?: number;
      direction?: 'BULL' | 'BEAR';
      exchange?: 'US' | 'LSE';
      universe_rules?: UniverseRules;
    }>;
  };
  elapsedMs?: number;
  fetchedAt?: string;
  error?: string;
}

interface UniverseRules {
  beta_min: number;
  beta_max: number;
  atr_min: number;
  adr_pct_min: number;
  dollar_vol_min_m: number;
  mkt_cap_min_b: number;
  target_size: number;
  earnings_min_days: number;
  earnings_checked: boolean;
}

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

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function pct(value: number, base: number) {
  return base > 0 ? (value / base - 1) * 100 : 0;
}

function sessionProgress(candle?: Candle) {
  if (!candle) return 1;
  const date = new Date(candle.time);
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes();
  const marketOpenUtc = 13 * 60 + 30;
  const marketCloseUtc = 20 * 60;
  return Math.min(1, Math.max(0.05, (minutesUtc - marketOpenUtc) / (marketCloseUtc - marketOpenUtc)));
}

function dayVolume(candles: Candle[]) {
  if (!candles.length) return 0;
  const lastDate = last(candles).time.slice(0, 10);
  return sum(candles.filter((candle) => candle.time.startsWith(lastDate)).map((candle) => candle.volume || 0));
}

function candleTrend(candles: Candle[]) {
  if (candles.length < 25) return 'FLAT' as const;
  const values = closes(candles);
  const ema9 = last(ema(values, 9));
  const ema21 = last(ema(values, 21));
  if (ema9 > ema21) return 'UP' as const;
  if (ema9 < ema21) return 'DOWN' as const;
  return 'FLAT' as const;
}

function dataProviderStatus(fetchedAt?: string): MarketDataProviderStatus {
  const lastUpdated = fetchedAt || new Date().toISOString();
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000));
  return {
    provider: 'yahoo',
    mode: 'fallback',
    lastUpdated,
    stale: ageSeconds > 90,
    ageSeconds,
    message: ageSeconds > 90 ? `Yahoo fallback data stale (${ageSeconds}s)` : `Yahoo fallback data ${ageSeconds}s old`,
  };
}

function scoreRow(input: {
  rvol: number;
  gapPct: number;
  atrPct: number;
  dollarVolM: number;
  beta: number;
  betaMax: number;
  rs: number;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
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

  if ((input.direction === 'BULL' && input.rs >= 1.02) || (input.direction === 'BEAR' && input.rs <= 0.98)) {
    score += 15;
    reasons.push('relative strength edge');
  } else if (input.rs >= 0.98 && input.rs <= 1.02) {
    score += 7;
    reasons.push('relative strength neutral');
  } else {
    reasons.push('relative strength weak');
  }

  if (input.atrPct >= 3.5) { score += 8; reasons.push('high intraday range potential'); }
  else if (input.atrPct >= 2.5) { score += 5; reasons.push('range acceptable'); }
  else reasons.push('range low');

  if (input.dollarVolM >= 25) { score += 5; reasons.push('liquid'); }
  else if (input.dollarVolM >= 3) { score += 3; reasons.push('liquidity acceptable'); }
  else reasons.push('liquidity weak');

  if (input.beta >= 1.2 && input.beta <= input.betaMax) { score += 2; reasons.push('beta tradable'); }

  return {
    score: Math.min(100, score),
    reason: reasons.join(' | '),
  };
}

function baseUniverseCheck(meta?: NonNullable<YahooCandleResponse['universe']>['enriched'][number]) {
  const rules = meta?.universe_rules;
  const exchange = meta?.exchange || 'US';
  const betaMin = rules?.beta_min ?? 1.2;
  const betaMax = rules?.beta_max ?? 2.8;
  const atrMin = exchange === 'US' ? rules?.atr_min ?? 0.8 : 0;
  const adrPctMin = exchange === 'US' ? rules?.adr_pct_min ?? 2.5 : 1.5;
  const dollarVolMinM = rules?.dollar_vol_min_m ?? (exchange === 'US' ? 3 : 2);
  const mktCapMinB = rules?.mkt_cap_min_b ?? 3;
  const earningsChecked = Boolean(rules?.earnings_checked);
  const earningsDays: number | null = null;
  const failures: string[] = [];

  const beta = Number(meta?.beta || 0);
  const atr20 = Number(meta?.atr20 || 0);
  const atrPct = Number(meta?.atr_pct || 0);
  const dollarVolM = Number(meta?.dollar_vol_m || 0);
  const mktCapB = typeof meta?.mkt_cap_b === 'number' ? meta.mkt_cap_b : null;

  if (beta < betaMin || beta > betaMax) failures.push(`Beta outside ${betaMin}-${betaMax}`);
  if (exchange === 'US' && atr20 < atrMin) failures.push(`ATR20 below $${atrMin}`);
  if (atrPct < adrPctMin) failures.push(`ADR% below ${adrPctMin}%`);
  if (dollarVolM < dollarVolMinM) failures.push(`Dollar volume below $${dollarVolMinM}M`);
  if (exchange === 'US' && mktCapB !== null && mktCapB < mktCapMinB) failures.push(`Market cap below $${mktCapMinB}B`);

  return {
    pass: failures.length === 0,
    reason: failures.length ? failures.join(' | ') : `Base pass: beta ${betaMin}-${betaMax}, mkt cap >= $${mktCapMinB}B when available, dollar vol >= $${dollarVolMinM}M, ATR/ADR OK, RS sorted`,
    betaMax,
    mktCapB,
    earningsChecked,
    earningsDays,
    earningsStatus: earningsChecked ? 'Checked' : 'Not checked',
  };
}

function buildRow(
  item: YahooCandleResponse['results'][number],
  meta: NonNullable<YahooCandleResponse['universe']>['enriched'][number] | undefined,
  providerStatus: MarketDataProviderStatus,
): ProTradeRow {
  const intraday = item.candles['1m'] || item.candles['5m'] || [];
  const five = item.candles['5m'] || [];
  const fifteen = item.candles['15m'] || [];
  const daily = item.candles['1d'] || [];
  const current = last(five)?.close || last(intraday)?.close || last(daily)?.close || Number(meta?.last_price || 0);
  const today = last(daily);
  const previous = daily.length >= 2 ? daily[daily.length - 2] : null;
  const gapPct = today && previous ? pct(today.open, previous.close) : 0;
  const dayChangePct = previous ? pct(current, previous.close) : 0;
  const avgDailyVolume = meta?.dollar_vol_m && meta?.last_price ? (meta.dollar_vol_m * 1_000_000) / Math.max(meta.last_price, 0.01) : 0;
  const currentDayVolume = dayVolume(intraday.length ? intraday : five);
  const expectedVolume = avgDailyVolume * sessionProgress(last(intraday.length ? intraday : five));
  const rvol = expectedVolume > 0 ? currentDayVolume / expectedVolume : 0;
  const vwap = five.length ? vwapLatest(five) : current;
  const direction = meta?.direction || 'NEUTRAL';
  const trend5m = candleTrend(five);
  const trend15m = candleTrend(fifteen);
  const vwapAligned = direction === 'BULL' ? current > vwap : direction === 'BEAR' ? current < vwap : false;
  const trendAligned = direction === 'BULL' ? trend5m === 'UP' : direction === 'BEAR' ? trend5m === 'DOWN' : false;
  const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : direction === 'BEAR' ? trend15m === 'DOWN' : false;
  const base = baseUniverseCheck(meta);
  const scored = scoreRow({
    rvol,
    gapPct,
    atrPct: Number(meta?.atr_pct || 0),
    dollarVolM: Number(meta?.dollar_vol_m || 0),
    beta: Number(meta?.beta || 0),
    betaMax: base.betaMax,
    rs: Number(meta?.rs_vs_spy || 1),
    direction,
    vwapAligned,
    trendAligned,
    trend15mAligned,
  });

  const candles = {
    one: (item.candles['1m'] || []).slice(-120),
    five: five.slice(-120),
    fifteen: (item.candles['15m'] || []).slice(-80),
    daily: daily.slice(-80),
  };
  const strategySignals = evaluateStrategies({
    symbol: item.symbol,
    company: item.company || meta?.long_name || item.symbol,
    direction,
    price: round(current, 2),
    score: scored.score,
    rvol,
    gapPct,
    atr20: Number(meta?.atr20 || 0),
    atrPct: Number(meta?.atr_pct || 0),
    rsVsBenchmark: Number(meta?.rs_vs_spy || 1),
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
    : base.pass
      ? 'pro_watchlist'
      : 'raw_candidates';

  const row: ProTradeRow = {
    symbol: item.symbol,
    company: item.company || meta?.long_name || item.symbol,
    exchange: meta?.exchange || 'US',
    direction,
    price: round(current, 2),
    score: scored.score,
    qualified: base.pass && scored.score >= 65 && rvol >= 0.8 && vwapAligned && trendAligned && trend15mAligned,
    reason: `${base.reason} | ${scored.reason}`,
    atr20: round(Number(meta?.atr20 || 0), 3),
    atrPct: round(Number(meta?.atr_pct || 0), 2),
    dollarVolM: round(Number(meta?.dollar_vol_m || 0), 1),
    mktCapB: base.mktCapB === null ? null : round(base.mktCapB, 2),
    beta: round(Number(meta?.beta || 0), 2),
    betaMax: base.betaMax,
    rsVsBenchmark: round(Number(meta?.rs_vs_spy || 1), 3),
    basePass: base.pass,
    baseReason: base.reason,
    earningsChecked: base.earningsChecked,
    earningsDays: base.earningsDays,
    earningsStatus: base.earningsStatus,
    gapPct: round(gapPct, 2),
    dayChangePct: round(dayChangePct, 2),
    rvol: round(rvol, 2),
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
  return row;
}

function emptyRow(input: {
  symbol: string;
  company?: string;
  exchange?: string;
  mktCapB?: number | null;
  sourceBucket: 'raw' | 'filtered';
  reason: string;
  providerStatus?: MarketDataProviderStatus;
}): ProTradeRow {
  const dataStatus = input.providerStatus || dataProviderStatus();
  return {
    symbol: input.symbol,
    company: input.company || input.symbol,
    exchange: input.exchange || 'US',
    direction: 'NEUTRAL',
    price: 0,
    score: 0,
    qualified: false,
    reason: input.reason,
    atr20: 0,
    atrPct: 0,
    dollarVolM: 0,
    mktCapB: typeof input.mktCapB === 'number' ? input.mktCapB : null,
    beta: 0,
    betaMax: 2.8,
    rsVsBenchmark: 0,
    basePass: input.sourceBucket === 'raw',
    baseReason: input.reason,
    earningsChecked: false,
    earningsDays: null,
    earningsStatus: 'Not checked',
    gapPct: 0,
    dayChangePct: 0,
    rvol: 0,
    vwap: 0,
    vwapAligned: false,
    trend5m: 'FLAT',
    trend15m: 'FLAT',
    trendAligned: false,
    trend15mAligned: false,
    sourceBucket: input.sourceBucket,
    workflowStage: 'raw_candidates',
    strategySignals: [],
    primaryStrategy: null,
    tradePlan: null,
    confidence: 0,
    dataStatus,
    candles: { one: [], five: [], fifteen: [], daily: [] },
  };
}

export async function fetchProTradeScannerSnapshot(): Promise<ProTradeSnapshot> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('scanner-run', {
    body: { action: 'screen' },
  });
  if (error) throw error;

  const payload = data as YahooCandleResponse;
  if (!payload.ok) throw new Error(payload.error || 'ProTrade scanner request failed.');
  const providerStatus = dataProviderStatus(payload.fetchedAt);
  const enriched = new Map((payload.universe?.enriched || []).map((row) => [row.symbol, row]));
  const rows = payload.results
    .map((item) => buildRow(item, enriched.get(item.symbol), providerStatus))
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score);
  const rowSymbols = new Set(rows.map((row) => row.symbol));
  const rawRows = (payload.universe?.raw_candidates || []).map((item) => {
    const existing = rows.find((row) => row.symbol === item.symbol);
    return existing || emptyRow({
      symbol: item.symbol,
      exchange: item.exchange,
      mktCapB: item.mkt_cap_b,
      sourceBucket: 'raw',
      reason: 'Raw candidate from Finviz/LSE before Yahoo enrichment and base filters.',
      providerStatus,
    });
  });
  const filteredRows = (payload.universe?.filtered_symbols || [])
    .filter((symbol) => !rowSymbols.has(symbol))
    .map((symbol) => emptyRow({
      symbol,
      sourceBucket: 'filtered',
      reason: 'Filtered out by the base universe rules before ProTrade intraday scoring.',
      providerStatus,
    }));

  return {
    rows,
    rawRows,
    filteredRows,
    qualifiedCount: rows.filter((row) => row.qualified).length,
    scannedCount: rows.length,
    rawCount: payload.universe?.raw_count || rows.length,
    filteredOut: payload.universe?.filtered_out || 0,
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    providerStatus: `${payload.status} in ${Math.round((payload.elapsedMs || 0) / 1000)}s`,
  };
}
