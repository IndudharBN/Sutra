import { fetchBars, fetchUniverseMeta, buildCandleSet, selectTopSymbols, fetchNewsFlags, fetchSectorTrends, fetchSpyDailyBars, buildDynamicUniverse, clearUniverseCache, SYMBOL_SECTOR, type CatalystTier } from '../../lib/alpacaClient';
import { classifyMarketRegime } from '../marketRegime/marketRegimeLogic';
import type { MarketRegime } from '../marketRegime/marketRegimeTypes';
import type { SymbolMeta } from '../../lib/alpacaClient';
import { ema, vwapLatest, vwapSeries, vwapSlope } from '../scanner/indicators';
import type { Candle, CandleSet } from '../scanner/ohlcv';
import { closes, last, round } from '../scanner/ohlcv';
import { evaluateStrategies } from './strategyEngine';
import type { MarketDataProviderStatus, StrategySignal, WorkflowStage } from './workflowTypes';
import { getRiskSettings } from '../../lib/riskManager';
import { fetchSharesOutstanding, getFloatFromCache } from '../../lib/alpacaBroker';
import { fetchEarningsCalendar, getEarningsDays } from '../../lib/finnhubClient';

const DEFAULT_LIVE_UNIVERSE = [
  'LITE', 'VIAV', 'CIEN', 'SNDK', 'MRVL', 'GLW', 'DOCN', 'STX', 'CAVA', 'PL', 'ON', 'GFS', 'ESI', 'RSI', 'HPE', 'ATI', 'FLEX', 'SMTC', 'CAT', 'CENX', 'AVGO', 'ADI', 'RVMD', 'ALGM', 'ANET', 'AMAT', 'BTSG', 'STT', 'HWM', 'TPR', 'NET', 'C', 'APG', 'TWLO', 'ALLY', 'MU', 'MRNA', 'ROKU', 'GTES', 'DECK', 'XYZ', 'LEVI', 'VFC', 'ABNB', 'MCHP', 'NVDA', 'MS', 'DD', 'AMD', 'NRG', 'FLR', 'DAL', 'IBKR', 'AMZN', 'GE', 'ARWR', 'ALB', 'GS', 'SYF', 'GOOGL', 'PPG', 'GOOG', 'CCL', 'META', 'NXT', 'APH', 'GAP', 'BBIO', 'COF', 'LNC', 'EQH', 'CRBG', 'CMG', 'IP', 'SARO', 'SNOW', 'KTOS', 'FLUT', 'GM', 'EXPE', 'ORCL', 'EMR', 'DDOG', 'RCL', 'IR', 'TRMB', 'ELAN', 'CRH', 'NCLH', 'BAM', 'MP', 'BKNG', 'AFRM', 'APO', 'TRU', 'VNO', 'SNPS', 'UAL', 'DASH', 'SGI', 'PYPL', 'CHWY', 'BROS', 'TECH', 'IVZ', 'AXTA', 'TEM', 'TOST', 'CG', 'PLTR', 'KKR', 'CVNA', 'RBLX', 'BRKR', 'UEC', 'GH', 'ARES', 'JEF', 'KRMN', 'RDDT', 'SOFI', 'IQV', 'BLDR', 'FOUR', 'LMND', 'TPG', 'FND', 'ASTS', 'Z', 'SAIL', 'EL', 'U', 'HL',
  'TSLA', 'AAPL', 'MSFT', 'NFLX', 'UBER', 'LYFT', 'COIN', 'SQ', 'SHOP', 'CRWD', 'ZS', 'PANW', 'OKTA', 'SPLK', 'PATH', 'AI', 'SOUN', 'BBAI', 'IONQ', 'RGTI', 'QBTS', 'DJT', 'SMCI', 'WOLF', 'LUNR', 'SPCE', 'RKT', 'HIMS', 'ACHR',
];

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
  sharesOutstanding: number;
  catalyst: CatalystTier;
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
  prevDayHigh: number;
  prevDayLow: number;
  prevDayClose: number;
  premarketHigh: number;
  premarketLow: number;
  premarketVolume: number;
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
  spyTrend5m: 'UP' | 'DOWN' | 'FLAT';
  regime: MarketRegime;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function candleTrend(candles: Candle[]) {
  if (candles.length < 25) return 'FLAT' as const;
  const values = closes(candles);
  const e9 = last(ema(values, 9));
  const e21 = last(ema(values, 21));

  // Lead Indicator Logic: Use VWAP Slope + Price Position
  const vpx = vwapLatest(candles, 20);
  const price = last(values);
  const slope = vwapSlope(candles, 3, 20);

  // Bullish Lead: EMA still bearish but price > VWAP and VWAP turning up
  if (e9 < e21 && price > vpx && slope > 0.0001) return 'UP' as const;
  // Bearish Lead: EMA still bullish but price < VWAP and VWAP turning down
  if (e9 > e21 && price < vpx && slope < -0.0001) return 'DOWN' as const;

  if (e9 > e21) return 'UP' as const;
  if (e9 < e21) return 'DOWN' as const;
  return 'FLAT' as const;
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

function computePrevDay(daily: Candle[]): { high: number; low: number; close: number } {
  const bar = daily.length >= 2 ? daily[daily.length - 2] : null;
  return { high: bar?.high ?? 0, low: bar?.low ?? 0, close: bar?.close ?? 0 };
}

function etHour(isoTime: string): number {
  return parseInt(new Date(isoTime).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
}

function etMinute(isoTime: string): number {
  return parseInt(new Date(isoTime).toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
}

function isPremarket(isoTime: string): boolean {
  const h = etHour(isoTime);
  const m = etMinute(isoTime);
  return h < 9 || (h === 9 && m < 30);
}

function computePremarket(one: Candle[]): { high: number; low: number; volume: number } {
  const bars = one.filter((c) => c.time && isPremarket(c.time));
  if (!bars.length) return { high: 0, low: 0, volume: 0 };
  return {
    high: Math.max(...bars.map((c) => c.high)),
    low: Math.min(...bars.map((c) => c.low)),
    volume: bars.reduce((sum, c) => sum + c.volume, 0),
  };
}

function computeRsVsBenchmark(h1: Candle[], spyChangePct: number): number {
  if (h1.length < 2) return 1;
  const last1 = h1[h1.length - 1].close;
  const prev1 = h1[h1.length - 2].close;
  if (prev1 <= 0) return 1;
  const stockChangePct = (last1 - prev1) / prev1;
  return 1 + (stockChangePct - spyChangePct);
}

function scoreRow(input: {
  rvol: number;
  gapPct: number;
  atrPct: number;
  dollarVolM: number;
  vwapAligned: boolean;
  trendAligned: boolean;
  trend15mAligned: boolean;
  catalyst: CatalystTier;
  sectorAligned: boolean;
  smallFloat: boolean;
}) {
  let score = 0;
  const reasons: string[] = [];

  if (input.rvol >= 1.5) { score += 22; reasons.push('RVOL strong'); }
  else if (input.rvol >= 1) { score += 13; reasons.push('RVOL acceptable'); }
  else reasons.push('RVOL weak');

  const gapAbs = Math.abs(input.gapPct);
  if (gapAbs >= 2) { score += 12; reasons.push('active gap'); }
  else if (gapAbs >= 1) { score += 6; reasons.push('small gap'); }
  else reasons.push('no meaningful gap');

  if (input.vwapAligned) { score += 13; reasons.push('VWAP aligned'); }
  else reasons.push('VWAP not aligned');

  if (input.trendAligned) { score += 13; reasons.push('5m trend aligned'); }
  else reasons.push('5m trend not aligned');

  if (input.trend15mAligned) { score += 13; reasons.push('15m directional'); }
  else reasons.push('15m not directional');

  if (input.atrPct >= 3.5) { score += 7; reasons.push('high intraday range potential'); }
  else if (input.atrPct >= 2.5) { score += 4; reasons.push('range acceptable'); }
  else reasons.push('range low');

  if (input.dollarVolM >= 25) { score += 6; reasons.push('liquid'); }
  else if (input.dollarVolM >= 3) { score += 3; reasons.push('liquidity acceptable'); }
  else reasons.push('liquidity weak');

  if (input.catalyst === 'hard') { score += 12; reasons.push('hard catalyst'); }
  else if (input.catalyst === 'soft') { score += 4; reasons.push('soft catalyst'); }
  if (input.sectorAligned) { score += 6; reasons.push('sector aligned'); }
  if (input.smallFloat) { score += 5; reasons.push('small float'); }

  return { score: Math.min(100, score), reason: reasons.join(' | ') };
}

function dataProviderStatus(fetchedAt?: string): MarketDataProviderStatus {
  const lastUpdated = fetchedAt || new Date().toISOString();
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(lastUpdated).getTime()) / 1000));
  const utcMins = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const dow = new Date().getUTCDay();
  const marketClosed = dow === 0 || dow === 6 || utcMins < 13 * 60 + 30 || utcMins >= 20 * 60;
  const stale = ageSeconds > 90 || marketClosed;
  return {
    provider: 'alpaca',
    mode: 'live',
    lastUpdated,
    stale,
    ageSeconds,
    message: marketClosed ? 'Market closed — no new trades' : ageSeconds > 90 ? `Alpaca data stale (${ageSeconds}s)` : `Alpaca IEX ${ageSeconds}s old`,
  };
}

function buildRowFromAlpaca(
  symbol: string,
  meta: SymbolMeta,
  candleSet: CandleSet,
  providerStatus: MarketDataProviderStatus,
  catalyst: CatalystTier,
  sectorTrends: Record<string, 'UP' | 'DOWN' | 'FLAT'>,
  earningsDays: number | null,
  spyChangePct: number,
  vixLevel?: number | null,
  spyTrend5m?: 'UP' | 'DOWN' | 'FLAT',
): ProTradeRow {
  const one = (candleSet['1m'] || []).slice(-120);
  const five = (candleSet['5m'] || []).slice(-120);
  const fifteen = (candleSet['15m'] || []).slice(-80);
  const h1 = (candleSet['1h'] || []).slice(-60);
  const daily = (candleSet['1d'] || []).slice(-80);

  const price = meta.price;
  const atr20 = computeAtr20(daily);
  const atrPct = price > 0 ? (atr20 / price) * 100 : 0;
  const dollarVolM = (price * meta.todayVolume) / 1_000_000;

  const vwap = five.length ? vwapLatest(five) : price;
  const trend5m = candleTrend(five);
  const trend15m = candleTrend(fifteen);
  // Direction: 15m EMA is the primary intraday bias (institutional TF, no dead zone).
  // Gap fallback handles early session before 15m EMA resolves.
  const direction: 'BULL' | 'BEAR' | 'NEUTRAL' =
    trend15m === 'UP'   ? 'BULL' :
    trend15m === 'DOWN' ? 'BEAR' :
    meta.gapPct >  0.5  ? 'BULL' :
    meta.gapPct < -0.5  ? 'BEAR' : 'NEUTRAL';
  const vwapAligned = direction === 'BULL' ? price > vwap : direction === 'BEAR' ? price < vwap : false;
  const trendAligned = direction === 'BULL' ? trend5m === 'UP' : direction === 'BEAR' ? trend5m === 'DOWN' : false;
  const trend15mAligned = direction === 'BULL' ? trend15m === 'UP' : direction === 'BEAR' ? trend15m === 'DOWN' : false;

  const smallFloat = meta.todayVolume > 0 && meta.todayVolume < 50_000_000;
  const sectorEtf = SYMBOL_SECTOR[symbol];
  const sectorTrend = sectorEtf ? sectorTrends[sectorEtf] : undefined;
  const sectorAligned = direction === 'BULL' ? sectorTrend === 'UP' : direction === 'BEAR' ? sectorTrend === 'DOWN' : false;

  const rsVsBenchmark = computeRsVsBenchmark(h1, spyChangePct);

  const prevDay = computePrevDay(daily);
  const premarket = computePremarket(one);

  // Earnings status string
  let earningsStatus = 'Not checked';
  if (earningsDays !== null) {
    if (earningsDays === 0) earningsStatus = 'Earnings TODAY';
    else if (earningsDays === 1) earningsStatus = 'Earnings tomorrow';
    else if (earningsDays === -1) earningsStatus = 'Earnings yesterday';
    else if (earningsDays > 0) earningsStatus = `Earnings in ${earningsDays}d`;
    else earningsStatus = `Earnings ${Math.abs(earningsDays)}d ago`;
  }

  const failures: string[] = [];
  if (price < 1 || price > 1500) failures.push('Price outside $1–$1500');
  if (atrPct < 2.5 || atrPct > 12) failures.push(`ATR% ${atrPct.toFixed(1)}% outside 2.5–12% range`);
  if (dollarVolM < 3) failures.push('Dollar volume below $3M');
  const basePass = failures.length === 0;
  const baseReason = failures.length ? failures.join(' | ') : 'Price OK, ATR% OK, dollar vol OK';

  const scored = scoreRow({ rvol: meta.rvolEst, gapPct: meta.gapPct, atrPct, dollarVolM, vwapAligned, trendAligned, trend15mAligned, catalyst, sectorAligned, smallFloat });

  const candles = { one, five, fifteen, daily };
  const { disabledStrategies } = getRiskSettings();
  const allSignals = evaluateStrategies({
    symbol,
    company: symbol,
    direction,
    price: round(price, 2),
    score: scored.score,
    rvol: meta.rvolEst,
    gapPct: meta.gapPct,
    atr20: round(atr20, 3),
    atrPct: round(atrPct, 2),
    rsVsBenchmark,
    vwap,
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    earningsDays,
    vixLevel,
    spyTrend5m,
    dataStatus: providerStatus,
    candles,
  });
  const strategySignals = allSignals.filter((s) => !disabledStrategies.includes(s.strategyId));

  const primaryStrategy = strategySignals[0] || null;
  const workflowStage: WorkflowStage = primaryStrategy?.stage ?? 'screened_universe';

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
    sharesOutstanding: getFloatFromCache(symbol),
    catalyst,
    beta: 0,
    betaMax: 2.8,
    rsVsBenchmark: round(rsVsBenchmark, 3),
    basePass,
    baseReason,
    earningsChecked: earningsDays !== null,
    earningsDays,
    earningsStatus,
    gapPct: round(meta.gapPct, 2),
    dayChangePct: round(meta.intradayChangePct, 2),
    rvol: round(meta.rvolEst, 2),
    vwap: round(vwap, 2),
    vwapAligned,
    trend5m,
    trend15m,
    trendAligned,
    trend15mAligned,
    prevDayHigh: round(prevDay.high, 2),
    prevDayLow: round(prevDay.low, 2),
    prevDayClose: round(prevDay.close, 2),
    premarketHigh: round(premarket.high, 2),
    premarketLow: round(premarket.low, 2),
    premarketVolume: premarket.volume,
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

// ── Hot-set refresh (20s) — re-evaluates only forming/confirmed/locked stocks ──

export { clearUniverseCache };

export async function fetchHotSetSnapshot(symbols: string[], spyChangePct: number): Promise<ProTradeRow[]> {
  if (!symbols.length) return [];
  const metas = await fetchUniverseMeta(symbols);
  const [bars1m, bars5m, bars15m, bars1h, bars1d, sectorTrends] = await Promise.all([
    fetchBars(symbols, '1m'),
    fetchBars(symbols, '5m'),
    fetchBars(symbols, '15m'),
    fetchBars(symbols, '1h'),
    fetchBars(symbols, '1d'),
    fetchSectorTrends(),
  ]);
  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));
  return symbols.flatMap((sym) => {
    const meta = metaMap.get(sym);
    if (!meta) return [];
    const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
    const earningsDays = getEarningsDays(sym);
    return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, catalyst, sectorTrends, earningsDays, spyChangePct, vixLevel, spyTrend5m)];
    });

}

// ── Main fetch ────────────────────────────────────────────────────────────────

export async function fetchProTradeScannerSnapshot(pinnedSymbols: string[] = []): Promise<ProTradeSnapshot> {
  // Pre-warm earnings calendar so the universe build can filter earnings-day stocks
  await fetchEarningsCalendar();

  // Dynamic universe: Alpaca screener → beta/ADR% gates → top 90, cached 6h.
  // Falls back to static DEFAULT_LIVE_UNIVERSE if screener is unavailable.
  const rawUniverse = await buildDynamicUniverse(pinnedSymbols, DEFAULT_LIVE_UNIVERSE);

  // Exclude stocks with earnings today, tomorrow, or yesterday — binary event risk
  const universe = rawUniverse.filter(sym => {
    const days = getEarningsDays(sym);
    return days === null || Math.abs(days) > 1;
  });

  const metas = await fetchUniverseMeta(universe);
  const scored = selectTopSymbols(metas, 90);
  // Guarantee pinned watchlist symbols are always scanned regardless of score rank
  const top = [...new Set([...scored, ...pinnedSymbols])];

  const [bars1m, bars5m, bars15m, bars1h, bars1d, newsFlags, sectorTrends, spyBars, spyRegimeData, spy5mBars] = await Promise.all([
    fetchBars(top, '1m'),
    fetchBars(top, '5m'),
    fetchBars(top, '15m'),
    fetchBars(top, '1h'),
    fetchBars(top, '1d'),
    fetchNewsFlags(top),
    fetchSectorTrends(),
    fetchBars(['SPY'], '1h'),
    fetchSpyDailyBars(),
    fetchBars(['SPY'], '5m'),
  ]);

  // Warm float cache in background — earnings already pre-warmed above
  void fetchSharesOutstanding(top);

  // Compute SPY hourly change for RS vs benchmark
  const spyH1 = (spyBars['SPY'] || []).slice(-5);
  const spyLast = spyH1.length >= 2 ? spyH1[spyH1.length - 1].close : 0;
  const spyPrev = spyH1.length >= 2 ? spyH1[spyH1.length - 2].close : spyLast;
  const spyChangePct = spyPrev > 0 ? (spyLast - spyPrev) / spyPrev : 0;

  const spy5m = (spy5mBars['SPY'] || []);
  const spyTrend5m = candleTrend(spy5m);

  // Macro regime: SPY EMA200 (daily) + VIX
  const spyDailyCloses = spyRegimeData.spyBars.map((c) => c.close);
  const spyEma200Series = ema(spyDailyCloses, 200);
  const spyEma200 = spyEma200Series.length >= 200 ? last(spyEma200Series) : null;
  const spyDailyPrice = spyRegimeData.spyBars.length ? last(spyRegimeData.spyBars).close : null;
  const vixLevel = spyRegimeData.vixBars.length ? last(spyRegimeData.vixBars).close : null;
  const regime = classifyMarketRegime({ spyPrice: spyDailyPrice, spyEma200, vixLevel });

  const fetchedAt = new Date().toISOString();
  const providerStatus = dataProviderStatus(fetchedAt);
  const metaMap = new Map(metas.map((m) => [m.symbol, m]));

  const rows = top
    .flatMap((sym) => {
      const meta = metaMap.get(sym);
      if (!meta) return [];
      const candleSet = buildCandleSet(sym, { '1m': bars1m, '5m': bars5m, '15m': bars15m, '1h': bars1h, '1d': bars1d });
      const earningsDays = getEarningsDays(sym);
      return [buildRowFromAlpaca(sym, meta, candleSet, providerStatus, newsFlags[sym] ?? 'none', sectorTrends, earningsDays, spyChangePct, vixLevel, spyTrend5m)];
    })
    .sort((a, b) => b.confidence - a.confidence || b.score - a.score);

  return {
    rows,
    rawRows: rows,
    filteredRows: [],
    qualifiedCount: rows.filter((r) => r.qualified).length,
    scannedCount: rows.length,
    rawCount: universe.length,
    filteredOut: universe.length - top.length,
    fetchedAt,
    providerStatus: `Alpaca IEX • ${top.length} symbols`,
    spyTrend5m,
    regime,
  };
}
