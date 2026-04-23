import { supabase } from '../../lib/supabaseClient';
import type { Signal } from '../../types';
import { classifyMarketRegime } from '../marketRegime/marketRegimeLogic';
import type { MarketRegime } from '../marketRegime/marketRegimeTypes';
import { getTradingSession } from '../session/sessionLogic';
import type { TradingSession } from '../session/sessionTypes';
import { runEnginesFromCandles } from './engineCore';
import type { EngineScanResult } from './engineTypes';
import type { CandleSet } from './ohlcv';
import { computeTickerState } from './scannerLogic';
import type { ScannerSummary } from './scannerTypes';
import { baseSymbol, symbolAliases } from '../../lib/symbols';

export const DEFAULT_LIVE_UNIVERSE = [
  'LITE', 'VIAV', 'CIEN', 'SNDK', 'MRVL', 'GLW', 'DOCN', 'STX', 'CAVA', 'PL', 'ON', 'GFS', 'ESI', 'RSI', 'HPE', 'ATI', 'FLEX', 'SMTC', 'CAT', 'CENX', 'AVGO', 'ADI', 'RVMD', 'ALGM', 'ANET', 'AMAT', 'BTSG', 'STT', 'HWM', 'TPR', 'NET', 'C', 'APG', 'TWLO', 'ALLY', 'MU', 'MRNA', 'ROKU', 'GTES', 'DECK', 'XYZ', 'LEVI', 'VFC', 'ABNB', 'MCHP', 'NVDA', 'MS', 'DD', 'AMD', 'NRG', 'FLR', 'DAL', 'IBKR', 'AMZN', 'GE', 'ARWR', 'ALB', 'GS', 'SYF', 'GOOGL', 'PPG', 'GOOG', 'CCL', 'META', 'NXT', 'APH', 'GAP', 'BBIO', 'COF', 'LNC', 'EQH', 'CRBG', 'CMG', 'IP', 'SARO', 'SNOW', 'KTOS', 'FLUT', 'RIO.L', 'BARC.L', 'HSBA.L', 'LLOY.L', 'PRU.L', 'JD.L', 'LGEN.L', 'STAN.L', 'IAG.L', 'RR.L', 'SKG.L', 'GM', 'EXPE', 'ORCL', 'EMR', 'DDOG', 'RCL', 'IR', 'TRMB', 'ELAN', 'CRH', 'NCLH', 'BAM', 'MP', 'BKNG', 'AFRM', 'APO', 'TRU', 'VNO', 'SNPS', 'UAL', 'DASH', 'SGI', 'PYPL', 'CHWY', 'BROS', 'TECH', 'IVZ', 'AXTA', 'TEM', 'TOST', 'CG', 'PLTR', 'KKR', 'CVNA', 'RBLX', 'BRKR', 'UEC', 'GH', 'ARES', 'JEF', 'KRMN', 'RDDT', 'SOFI', 'IQV', 'BLDR', 'FOUR', 'LMND', 'TPG', 'FND', 'ASTS', 'Z', 'SAIL', 'EL', 'U', 'HL', 'MNG.L', 'LAND.L', 'PSN.L',
];

interface YahooCandleResponse {
  ok: boolean;
  status: string;
  requestedTickers: number;
  returnedTickers: number;
  results: Array<{ symbol: string; company?: string; candles: CandleSet }>;
  universe?: {
    tickers: string[];
    count: number;
    raw_count: number;
    filtered_out: number;
    built_at: string;
    elapsed_s: number;
    enriched?: Array<{ symbol: string; long_name?: string; beta?: number; exchange?: string }>;
  };
  marketRegime?: {
    spyPrice: number | null;
    spyEma200: number | null;
    vixLevel: number | null;
    errors?: Record<string, string>;
  };
  errors?: Record<string, string>;
  elapsedMs?: number;
  fetchedAt?: string;
  error?: string;
}

export interface LiveScannerSnapshot {
  signals: Signal[];
  summary: ScannerSummary;
  session: TradingSession;
  regime: MarketRegime;
  scanLabel: string;
  providerStatus: string;
  errors: Record<string, string>;
  fetchedAt: string;
}

function classifyGroup(fired: Set<string>) {
  if (fired.has('E1') && fired.has('E2') && fired.has('E3')) return 'GOLD';
  if (fired.has('E1') || fired.has('E2')) return 'BLUE';
  if (fired.has('E3')) return 'TREND';
  if (fired.has('E5')) return 'FVG';
  return '-';
}

function bestSignal(result: EngineScanResult, group: string) {
  const preferred = group === 'GOLD' ? ['E1', 'E2', 'E3']
    : group === 'BLUE' ? ['E1', 'E2']
      : group === 'TREND' ? ['E3']
        : group === 'FVG' ? ['E5']
          : ['E1', 'E2', 'E3', 'E5'];
  return preferred
    .map((engine) => result.activeSignals.find((signal) => signal.engine === engine && signal.entry && signal.stop && signal.t1))
    .find(Boolean) || result.activeSignals.find((signal) => signal.entry && signal.stop && signal.t1) || null;
}

function rr(entry?: number | null, stop?: number | null, target?: number | null) {
  if (!entry || !stop || !target) return '-';
  const risk = Math.abs(entry - stop);
  if (!risk) return '-';
  return (Math.abs(target - entry) / risk).toFixed(1);
}

function dist(price?: number, entry?: number | null) {
  if (!price || !entry) return '-';
  return `${((Math.abs(price - entry) / price) * 100).toFixed(1)}%`;
}

function formingReason(result: EngineScanResult) {
  const forming = result.forming || { e1: false, e2: false, e3: false, e4: false, e5: false };
  const reasons = [
    forming.e1 ? 'E1 forming: price is near the 15m order-block zone.' : '',
    forming.e2 ? 'E2 forming: price is near the 5m order-block zone.' : '',
    forming.e3 ? 'E3 forming: 5m EMA9/EMA21 are converging within 0.15% of price.' : '',
    forming.e4 ? 'E4 forming: 1m EMA9/EMA21 are converging within 0.15% of price.' : '',
    forming.e5 ? 'E5 forming: price is near or inside an unfilled fair-value gap.' : '',
  ].filter(Boolean);
  return reasons.join(' ');
}

function confirmedReason(result: EngineScanResult) {
  return result.activeSignals
    .map((signal) => `${signal.engine}: ${signal.note || 'engine fired'}`)
    .join(' ');
}

function isLockedTicker(symbol: string, lockedTickers: Set<string>) {
  return [...symbolAliases(symbol)].some((alias) => lockedTickers.has(alias));
}

function engineResultToSignal(result: EngineScanResult, lockedTickers: Set<string>, now: Date): Signal {
  const state = computeTickerState(result, lockedTickers);
  const fired = new Set(result.activeSignals.map((signal) => signal.engine));
  const group = classifyGroup(fired);
  const selected = bestSignal(result, group);
  const engines = (['E1', 'E2', 'E3', 'E4', 'E5'] as const).filter((engine) => {
    if (fired.has(engine)) return true;
    const key = engine.toLowerCase() as 'e1' | 'e2' | 'e3' | 'e4' | 'e5';
    return Boolean(result.forming?.[key]);
  });
  const price = Number(result.htf.h1Price || selected?.entry || 0);

  return {
    id: `${result.ticker}-${now.getTime()}`,
    dateTime: now.toISOString().slice(0, 19).replace('T', ' '),
    symbol: result.ticker,
    company: result.htf.longName || result.ticker,
    signal: result.side === 'LONG' ? 'BUY' : result.side === 'SHORT' ? 'SELL' : '-',
    direction: result.htf.direction === 'BEAR' ? 'BEAR' : result.htf.direction === 'BULL' ? 'BULL' : 'BULL',
    group,
    engines,
    price,
    adr: result.htf.adrPct ? `${result.htf.adrPct.toFixed(0)}%` : '-',
    entry: Number(selected?.entry || 0),
    sl: Number(selected?.stop || 0),
    t1: Number(selected?.t1 || 0),
    rr: rr(selected?.entry, selected?.stop, selected?.t1),
    dist: dist(price, selected?.entry),
    age: 'live',
    status: state,
    broker: 'Trading212',
    orderStatus: isLockedTicker(result.ticker, lockedTickers) ? 'Open Position' : '-',
    reason: state === 'Forming'
      ? formingReason(result)
      : state === 'Confirmed'
        ? confirmedReason(result)
        : selected?.note || result.e1.note || result.e2.note || result.e3.note || result.e5.note || '',
    riskSize: '-',
  };
}

function buildRegime(marketRegime?: YahooCandleResponse['marketRegime']) {
  return classifyMarketRegime({
    spyPrice: marketRegime?.spyPrice,
    spyEma200: marketRegime?.spyEma200,
    vixLevel: marketRegime?.vixLevel,
    ts: Date.now(),
  });
}

export async function fetchLiveScannerSnapshot(input?: { tickers?: string[]; lockedSymbols?: string[]; maxTickers?: number }): Promise<LiveScannerSnapshot> {
  if (!supabase) throw new Error('Supabase is not configured.');

  const requestedTickers = input?.tickers
    ? [...new Set([...input.tickers, ...(input.lockedSymbols || []).map(baseSymbol)])]
    : null;
  const { data, error } = await supabase.functions.invoke('scanner-run', {
    body: {
      action: requestedTickers ? 'candles' : 'screen',
      ...(requestedTickers ? { tickers: requestedTickers } : {}),
      ...(!requestedTickers && input?.lockedSymbols?.length ? { includeTickers: input.lockedSymbols.map(baseSymbol) } : {}),
      ...(input?.maxTickers ? { maxTickers: input.maxTickers } : {}),
    },
  });
  if (error) throw error;

  const payload = data as YahooCandleResponse;
  if (!payload.ok) throw new Error(payload.error || 'Yahoo scanner request failed.');

  const now = new Date();
  const lockedBaseSymbols = [...new Set((input?.lockedSymbols || []).map(baseSymbol))];
  const lockedTickers = new Set(lockedBaseSymbols.flatMap((symbol) => [...symbolAliases(symbol)]));
  const enriched = new Map((payload.universe?.enriched || []).map((row) => [row.symbol, row]));
  const engineResults = payload.results.map((item) => {
    const result = runEnginesFromCandles(item.symbol, item.candles);
    const meta = enriched.get(item.symbol);
    if (meta || item.company) {
      result.htf.longName = item.company || meta?.long_name || item.symbol;
      result.htf.beta = meta?.beta ?? null;
    }
    return result;
  });
  const signals = engineResults.map((result) => engineResultToSignal(result, lockedTickers, now));
  const watchlistCount = payload.universe?.count || requestedTickers?.length || DEFAULT_LIVE_UNIVERSE.length;
  const summary: ScannerSummary = {
    watchlist: watchlistCount,
    scanned: signals.length,
    forming: signals.filter((signal) => signal.status === 'Forming').length,
    confirmed: signals.filter((signal) => signal.status === 'Confirmed').length,
    locked: lockedBaseSymbols.length,
    openPositions: lockedBaseSymbols.length,
    todaysPnl: 0,
  };

  return {
    signals,
    summary,
    session: getTradingSession(now),
    regime: buildRegime(payload.marketRegime),
    scanLabel: `Yahoo screened ${signals.length}/${watchlistCount} tickers`,
    providerStatus: `${payload.status} in ${Math.round((payload.elapsedMs || 0) / 1000)}s`,
    errors: payload.errors || {},
    fetchedAt: payload.fetchedAt || now.toISOString(),
  };
}
