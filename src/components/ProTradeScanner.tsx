import React from 'react';
import { BarChart3, CheckCircle2, ChevronDown, Eye, RefreshCcw, Settings, ShieldCheck, TrendingUp, X } from 'lucide-react';
import { placePaperBracketOrder, closeAllPaperPositions, closePaperPosition, getPaperAccount, getPaperPositions, getRecentFilledOrders } from '../lib/alpacaBroker';
import { computeNotional, computePositionSize, checkDailyLossLimit, checkStrategyCircuitBreaker, checkGroupCircuitBreaker, recordTradeResult, recordGroupTradeResult, initDailyBalance, getRiskSummary, getPausedStrategies, getGroupCbSummary, migrateCbKeys, unpauseCbStrategy, unpauseGroupCb } from '../lib/riskManager';
import { betaAdjustedSizingMult, checkSectorConcentration, checkPortfolioBeta } from '../lib/portfolioRisk';
import { alpacaBarStream } from '../lib/alpacaBarStream';
import { clearBarCache } from '../lib/alpacaClient';
import { fetchProTradeScannerSnapshot, fetchHotSetSnapshot, clearUniverseCache, type ProTradeRow, type ProTradeSnapshot } from '../features/protrade/proTradeScannerApi';
import {
  STRATEGY_CODES,
  STRATEGY_LABELS,
  WORKFLOW_STAGE_LABELS,
  WORKFLOW_STAGE_ORDER,
  type SignalGroup,
  type StrategyId,
  type WorkflowStage,
} from '../features/protrade/workflowTypes';
import { stampGroupClassification } from '../features/protrade/confluenceClassifier';
import { baseSymbol } from '../lib/symbols';
import { clearAllTrades, loadAllTrades, persistTrade, syncPendingTrades, todayET, tradeDateET } from '../lib/tradeStore';
import { fetchBars } from '../lib/alpacaClient';
import { ProTradeCandlePreview } from './ProTradeCandlePreview';
import { TradingViewChartModal, type TradingViewInterval } from './TradingViewChart';
import type { Signal } from '../types';

type StageFilter = WorkflowStage;

const PAPER_TRADES_STORAGE_KEY = 'sutra.protrade.paperTrades.v1';
const PROTRADE_SETTINGS_STORAGE_KEY = 'sutra.protrade.settings.v1';
const WATCHLIST_KEY = 'sutra.dayWatchlist.v1';
const WATCHLIST_ARCHIVE_KEY = 'sutra.watchlistArchive.v1';
const WATCHLIST_NEXT_KEY = 'sutra.nextDayWatchlist.v1';
interface DayWatchlist { date: string; symbols: string[]; }

function loadWatchlist(): DayWatchlist {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '{}') as Partial<DayWatchlist>;
    return { date: raw.date || '', symbols: raw.symbols || [] };
  } catch { return { date: '', symbols: [] }; }
}

function saveWatchlist(w: DayWatchlist) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(w));
}

function loadNextDayQueue(): string[] {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_NEXT_KEY) || '[]') as string[]; }
  catch { return []; }
}

function saveNextDayQueue(symbols: string[]) {
  localStorage.setItem(WATCHLIST_NEXT_KEY, JSON.stringify([...new Set(symbols)]));
}

interface WatchlistStockResult {
  symbol: string;
  closingPrice: number;
  pnl: number;
  outcome: string;
}

interface WatchlistDayRecord {
  date: string;
  archivedAt: string;
  symbols: string[];
  results: WatchlistStockResult[];
}

function loadArchive(): WatchlistDayRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WATCHLIST_ARCHIVE_KEY) || '[]') as WatchlistDayRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveArchive(records: WatchlistDayRecord[]) {
  localStorage.setItem(WATCHLIST_ARCHIVE_KEY, JSON.stringify(records.slice(0, 30)));
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ProTradeSettings {}

const DEFAULT_PROTRADE_SETTINGS: ProTradeSettings = {};

interface PaperTrade {
  id: string;
  symbol: string;
  company: string;
  strategyId: StrategyId | null;
  strategyCode: string;
  strategyName: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'T1 Profit' | 'Stop' | 'Manual' | 'EOD';
  entry: number;
  stop: number;
  target: number;
  target1: number;
  target2: number;
  trailingStop: number;
  t1HitAt?: string;
  rr: number;
  rr1: number;
  quantity: number;
  notional: number;
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  reason: string;
  signalGroup?: SignalGroup;
  beta?: number;
}

const STAGE_TONES: Record<WorkflowStage, string> = {
  screened_universe: 'border-slate-600/40 bg-slate-800/30 text-slate-300',
  pro_watchlist: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300',
  forming: 'border-amber-500/25 bg-amber-500/5 text-amber-300',
  confirmed: 'border-cyan-500/25 bg-cyan-500/5 text-cyan-300',
  locked: 'border-indigo-500/25 bg-indigo-500/5 text-indigo-300',
  trade_ready: 'border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-300',
  ordered: 'border-green-500/30 bg-green-500/5 text-green-300',
};

function loadPaperTrades() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PAPER_TRADES_STORAGE_KEY) || '[]') as PaperTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePaperTrades(trades: PaperTrade[]) {
  window.localStorage.setItem(PAPER_TRADES_STORAGE_KEY, JSON.stringify(trades));
}

function loadProTradeSettings(): ProTradeSettings {
  return DEFAULT_PROTRADE_SETTINGS;
}

function saveProTradeSettings(_settings: ProTradeSettings) {
  window.localStorage.removeItem(PROTRADE_SETTINGS_STORAGE_KEY);
}

function fmtMoney(value?: number | null) {
  return value && Number.isFinite(value) ? `$${value.toFixed(2)}` : '--';
}

function toETTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

function fmtPct(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function stageBadge(stage: WorkflowStage) {
  return (
    <span className={`px-2 py-1 rounded-md border text-[10px] uppercase tracking-widest font-black ${STAGE_TONES[stage]}`}>
      {WORKFLOW_STAGE_LABELS[stage]}
    </span>
  );
}

const GROUP_COLORS: Record<SignalGroup, string> = {
  GOLD:         'border-amber-400/50 bg-amber-400/15 text-amber-300',
  BLUE:         'border-blue-400/50 bg-blue-400/15 text-blue-300',
  TREND:        'border-emerald-400/50 bg-emerald-400/15 text-emerald-300',
  FVG:          'border-violet-400/50 bg-violet-400/15 text-violet-300',
  BREAKOUT:     'border-orange-400/50 bg-orange-400/15 text-orange-300',
  PULLBACK:     'border-cyan-400/50 bg-cyan-400/15 text-cyan-300',
  MOMENTUM:     'border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-300',
  SIDEWAYS:     'border-slate-500/40 bg-slate-500/15 text-slate-400',
  UNCLASSIFIED: 'border-slate-600/30 bg-slate-800/20 text-slate-500',
};

function groupBadge(group: SignalGroup | undefined, sizeMult?: number) {
  if (!group || group === 'UNCLASSIFIED') return <span className="text-slate-600">--</span>;
  const dim = sizeMult !== undefined && sizeMult < 0.99;
  return (
    <span className={`px-2 py-0.5 rounded border text-[9px] uppercase tracking-widest font-black ${GROUP_COLORS[group]} ${dim ? 'opacity-60' : ''}`}>
      {group}{dim ? ` ${(sizeMult! * 100).toFixed(0)}%` : ''}
    </span>
  );
}

function activeStrategySignals(row: ProTradeRow) {
  return row.strategySignals.filter((signal) => signal.stage !== 'pro_watchlist');
}

function strategyCodeBadge(strategy: StrategyId, tone = 'slate') {
  const color = tone === 'primary'
    ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200'
    : 'border-white/10 bg-white/5 text-slate-300';
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border ${color}`}>
      {STRATEGY_CODES[strategy]}
    </span>
  );
}

function StrategyCodeList({ row }: { row: ProTradeRow }) {
  const signals = activeStrategySignals(row);
  if (!signals.length) return <span className="text-slate-600">--</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {signals.map((signal) => (
        <span
          key={signal.strategyId}
          title={`${STRATEGY_CODES[signal.strategyId]} - ${signal.strategyName}: ${WORKFLOW_STAGE_LABELS[signal.stage]}`}
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border ${signal.strategyId === row.primaryStrategy?.strategyId ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200' : STAGE_TONES[signal.stage]
            }`}
        >
          {STRATEGY_CODES[signal.strategyId]}
        </span>
      ))}
    </div>
  );
}

function rowToSignal(row: ProTradeRow): Signal {
  return {
    id: `protrade-${row.symbol}`,
    dateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
    symbol: row.symbol,
    company: row.company,
    signal: row.direction === 'BEAR' ? 'SELL' : 'BUY',
    direction: row.direction === 'BEAR' ? 'BEAR' : 'BULL',
    group: row.primaryStrategy?.strategyName || 'PRO',
    engines: row.primaryStrategy ? [row.primaryStrategy.strategyName] : [],
    price: row.price,
    adr: `${row.atrPct.toFixed(2)}%`,
    entry: row.tradePlan?.entry || 0,
    sl: row.tradePlan?.stop || 0,
    t1: row.tradePlan?.target1 || row.tradePlan?.target || 0,
    rr: row.tradePlan ? row.tradePlan.rr.toFixed(2) : '-',
    dist: '-',
    age: `${row.dataStatus.ageSeconds}s`,
    status: row.workflowStage === 'locked' ? 'Locked' : row.workflowStage === 'confirmed' ? 'Confirmed' : 'Forming',
    broker: '',
    orderStatus: row.workflowStage === 'ordered' ? 'Open Position' : '-',
    reason: row.primaryStrategy?.reason || row.reason,
    riskSize: row.tradePlan?.riskSize,
  };
}

function withOrderedStage(rows: ProTradeRow[], paperTrades: PaperTrade[] = []) {
  const paperSymbols = new Set(paperTrades.filter((trade) => trade.status === 'Open').map((trade) => baseSymbol(trade.symbol)));
  return rows.map((row) => (
    paperSymbols.has(baseSymbol(row.symbol))
      ? { ...row, workflowStage: 'ordered' as WorkflowStage }
      : row
  ));
}

function countRows(rows: ProTradeRow[], stage: WorkflowStage, rawRows: ProTradeRow[]) {
  if (stage === 'screened_universe') return rawRows.length;
  if (stage === 'pro_watchlist') return rows.filter((row) => row.basePass).length;
  return rows.filter((row) => row.workflowStage === stage).length;
}

function paperPnl(trade: PaperTrade, exitPrice: number) {
  const gross = trade.direction === 'BEAR'
    ? (trade.entry - exitPrice) * trade.quantity
    : (exitPrice - trade.entry) * trade.quantity;
  return {
    pnl: Number(gross.toFixed(2)),
    pnlPercent: Number((gross / trade.notional * 100).toFixed(2)),
  };
}

function closePaperTrade(trade: PaperTrade, exitPrice: number, outcome: PaperTrade['outcome'], closedAt = new Date().toISOString()): PaperTrade {
  const result = paperPnl(trade, exitPrice);
  // 'Stop' implies a losing exit. If the exit is profitable (e.g. VWAP re-cross structural
  // exit while price is still above entry), relabel as 'Manual' — a discretionary/structural
  // close rather than a hard stop hit. Prevents Stop + pnl>0 mismatch in analytics.
  const correctedOutcome: PaperTrade['outcome'] = outcome === 'Stop' && result.pnl > 0 ? 'Manual' : outcome;
  return {
    ...trade,
    status: 'Closed',
    outcome: correctedOutcome,
    exitPrice: Number(exitPrice.toFixed(2)),
    pnl: result.pnl,
    pnlPercent: result.pnlPercent,
    closedAt,
  };
}

function paperTarget1(trade: PaperTrade) {
  return Number(trade.target1 || trade.target || 0);
}

function paperTarget2(trade: PaperTrade) {
  return Number(trade.target2 || trade.target || paperTarget1(trade));
}

function paperTrailingStop(trade: PaperTrade) {
  return Number(trade.trailingStop || trade.stop || 0);
}

function monitorPaperTrades(trades: PaperTrade[], rows: ProTradeRow[]) {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const vwapBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.vwap]));
  let changed = false;
  const now = Date.now();
  const next = trades.map((trade) => {
    if (trade.status !== 'Open') return trade;
    // Grace period: don't evaluate stop/target within 60s of opening (prevents same-tick closure)
    if (now - new Date(trade.openedAt).getTime() < 60_000) return trade;
    const current = priceBySymbol.get(baseSymbol(trade.symbol));
    if (!current) return trade;
    const target1 = paperTarget1(trade);
    const target2 = paperTarget2(trade);
    const trailingStop = paperTrailingStop(trade);
    const hitTarget2 = trade.direction === 'BEAR' ? current <= target2 : current >= target2;
    const hitT1 = trade.direction === 'BEAR' ? current <= target1 : current >= target1;
    const hitStop = trade.direction === 'BEAR' ? current >= trailingStop : current <= trailingStop;
    if (hitTarget2) {
      changed = true;
      return closePaperTrade(trade, target2, 'Target');
    }
    // Phase 1: T1 hit → scale out 50%, SL moves to entry (breakeven)
    if (!trade.t1HitAt && hitT1) {
      changed = true;
      return {
        ...trade,
        t1HitAt: new Date().toISOString(),
        trailingStop: trade.entry,
      };
    }
    // Phase 2: After T1 hit, price pulls back to T1 zone → advance SL from entry to T1 (locks T1 profit)
    if (trade.t1HitAt) {
      const t1Level = target1;
      const slAtEntry = Math.abs(trailingStop - trade.entry) < 0.01;
      if (slAtEntry) {
        const pulledBackToT1 = trade.direction === 'BULL'
          ? current >= t1Level * 0.997 && current > trade.entry
          : current <= t1Level * 1.003 && current < trade.entry;
        if (pulledBackToT1) {
          changed = true;
          return { ...trade, trailingStop: t1Level };
        }
      }
    }
    if (hitStop) {
      changed = true;
      // For T1 Profit: floor exit at the trailing stop level — prevents negative P&L from scan lag.
      // For Stop: exit at current (realistic fill, may be slightly worse than stop level).
      const exitPrice = trade.t1HitAt
        ? (trade.direction === 'BEAR' ? Math.min(trailingStop, current) : Math.max(trailingStop, current))
        : current;
      return closePaperTrade(trade, exitPrice, trade.t1HitAt ? 'T1 Profit' : 'Stop');
    }
    // S2/S3 structural exit: thesis died when price crosses back through VWAP pre-T1.
    // S2 (VWAP reclaim): VWAP re-cross = reclaim failed. S3 (RS continuation): VWAP re-cross = RS edge gone.
    // After T1, trailing stop is at breakeven — position is protected, this exit no longer needed.
    if ((trade.strategyId === 'vwap_pullback' || trade.strategyId === 'rs_continuation') && !trade.t1HitAt) {
      const vwap = vwapBySymbol.get(baseSymbol(trade.symbol));
      if (vwap && (trade.direction === 'BULL' ? current < vwap : current > vwap)) {
        changed = true;
        return closePaperTrade(trade, current, 'Stop');
      }
    }
    return trade;
  });
  return { trades: next, changed };
}

function effectiveTradePlan(row: ProTradeRow, _settings: ProTradeSettings) {
  if (!row.tradePlan || row.tradePlan.entry <= 0 || row.direction === 'NEUTRAL') return null;
  const risk = Math.abs(row.tradePlan.entry - row.tradePlan.stop);
  if (risk <= 0) return null;
  return row.tradePlan;
}

function availablePaperNotional(_settings: ProTradeSettings, trades: PaperTrade[], accountBalance: number) {
  const cap = accountBalance * 0.65;
  const openNotional = trades
    .filter((trade) => trade.status === 'Open')
    .reduce((total, trade) => {
      // After T1 hit: trailing stop at BE, risk = $0. Count 50% so new entries aren't blocked.
      return total + (trade.t1HitAt ? trade.notional * 0.5 : trade.notional);
    }, 0);
  return Math.max(0, cap - openNotional);
}

function etMinutesNow(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

function playTradeReadyAlert() {
  try {
    const ACtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ACtx) return;
    const ctx = new ACtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    gain.connect(ctx.destination);
    [523, 659, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.13);
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.13);
      osc.stop(ctx.currentTime + i * 0.13 + 0.2);
    });
    setTimeout(() => void ctx.close().catch(() => { }), 800);
  } catch { /* browser may block audio before interaction */ }
}

function canPaperTradeRow(row: ProTradeRow, settings: ProTradeSettings = DEFAULT_PROTRADE_SETTINGS, trades: PaperTrade[] = [], accountBalance = 100_000) {
  const plan = effectiveTradePlan(row, settings);
  return Boolean(plan && plan.rr >= 1.5 && availablePaperNotional(settings, trades, accountBalance) > 0);
}

function buildPaperTrade(row: ProTradeRow, settings: ProTradeSettings, currentTrades: PaperTrade[] = [], openedAt = new Date().toISOString(), accountBalance = 100_000, spyTrend5m?: 'UP' | 'DOWN' | 'FLAT', spyTrend15m?: 'UP' | 'DOWN' | 'FLAT', cbSizeMult = 1.0): PaperTrade | null {
  const plan = effectiveTradePlan(row, settings);
  if (!plan || plan.rr < 1.5) return null;

  // Tide-based sizing — two-tide model:
  //   Both aligned        → 1.0× (max conviction)
  //   5m counter, 15m ok  → S2/S3: 1.0× (5m divergence = RS proof); others: 0.75×
  //   15m counter, 5m ok  → 0.75× (session structure is the dominant force)
  //   Both counter        → 0.75× (S2/S3 already blocked upstream by isTideBlocked)
  // Reversal strategies (S4/S5/S6) are fully exempt — counter-tide is their setup.
  const strategyId = row.primaryStrategy?.strategyId ?? null;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest' || strategyId === 'mss_breakout';
  let tideMult = 1.0;
  let heatNote = '';

  if (!isReversal) {
    const tradeDir = row.primaryStrategy?.direction ?? row.direction;
    const t5 = spyTrend5m;
    const t15 = spyTrend15m;
    const ok5m  = !t5  || t5  === 'FLAT' || (tradeDir === 'BULL' && t5  === 'UP') || (tradeDir === 'BEAR' && t5  === 'DOWN');
    const ok15m = !t15 || t15 === 'FLAT' || (tradeDir === 'BULL' && t15 === 'UP') || (tradeDir === 'BEAR' && t15 === 'DOWN');

    if (ok5m && ok15m) {
      tideMult = 1.0; // both aligned — full size
    } else if (!ok5m && ok15m) {
      // 5m counter, 15m aligned: immediate tape fights entry — steeper cut than session headwind
      tideMult = 0.5;
      heatNote = ` [5m counter-tide → 50% size]`;
    } else {
      // 15m counter (5m aligned), or both counter (S2/S3 already blocked upstream):
      // tape supports the entry moment but session structure is the headwind
      tideMult = 0.75;
      const which = !ok5m ? '5m+15m' : '15m';
      heatNote = ` [${which} counter-tide → 75% size]`;
    }
  }

  const betaMult = betaAdjustedSizingMult(row.beta);
  if (betaMult < 0.99) heatNote += ` [β${row.beta.toFixed(1)} → ${(betaMult * 100).toFixed(0)}% size]`;
  const effectiveMult = tideMult * betaMult;
  const signalGroup = row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED';
  const sigGroupSizeMult = row.primaryStrategy?.groupSizeMult ?? 1.0;
  // Notional-first: min(risk-proportional $, group cap $), then tide/beta/CB adjustments
  const baseNotional = computeNotional(accountBalance, plan.entry, plan.stop, signalGroup, sigGroupSizeMult);
  const adjustedNotional = baseNotional * effectiveMult * cbSizeMult;
  const budgetCap = availablePaperNotional(settings, currentTrades, accountBalance);
  const notional = Math.min(budgetCap, adjustedNotional);
  if (notional <= 0) return null;
  // Fractional shares — 4 decimal places, no floor to 1
  const quantity = Math.round((notional / plan.entry) * 10000) / 10000;
  if (quantity <= 0) return null; // fp epsilon: budgetCap near-zero passes notional guard but rounds qty to 0
  return {
    id: `paper-${row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: row.symbol,
    company: row.company,
    strategyId,
    strategyCode: strategyId ? STRATEGY_CODES[strategyId] : 'NA',
    strategyName: row.primaryStrategy?.strategyName || 'Manual Paper',
    direction: (row.primaryStrategy?.direction ?? row.direction) as 'BULL' | 'BEAR' | 'NEUTRAL',
    status: 'Open',
    outcome: 'Open',
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    target1: plan.target1,
    target2: plan.target2,
    trailingStop: plan.stop,
    rr: plan.rr,
    rr1: plan.rr1,
    quantity,
    notional,
    openedAt,
    reason: (row.primaryStrategy?.reason || row.reason) + heatNote,
    signalGroup: row.primaryStrategy?.signalGroup,
    beta: row.beta,
  };
}

function StageTile({
  stage,
  count,
  active,
  onClick,
}: {
  stage: WorkflowStage;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-[155px] rounded-xl border p-3 text-left transition-colors ${STAGE_TONES[stage]} ${active ? 'ring-2 ring-indigo-400/80' : 'hover:bg-white/10'}`}
    >
      <p className="text-2xl font-black text-white">{count}</p>
      <p className="mt-1 text-[10px] uppercase tracking-widest font-black text-slate-400">{WORKFLOW_STAGE_LABELS[stage]}</p>
    </button>
  );
}

function StrategyCard({
  strategy,
  count,
  active,
  onClick,
}: {
  strategy: StrategyId;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border border-white/10 bg-white/5 p-3 text-left transition-colors ${active ? 'ring-2 ring-emerald-400/70' : 'hover:bg-white/10'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {strategyCodeBadge(strategy, 'primary')}
          <p className="text-[11px] uppercase tracking-widest text-slate-400 font-black">{STRATEGY_LABELS[strategy]}</p>
        </div>
        <span className="text-lg font-black text-white">{count}</span>
      </div>
      <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
        {strategy === 'orb_retest' && 'Opening range breakout, retest, RVOL, VWAP.'}
        {strategy === 'vwap_pullback' && 'VWAP/EMA pullback and reclaim.'}
        {strategy === 'rs_continuation' && 'Leadership while SPY/QQQ pauses.'}
        {strategy === 'liquidity_sweep' && 'Sweep and reclaim, manual review.'}
        {strategy === 'ob_fvg_retest' && 'OB/FVG confluence, manual review.'}
        {strategy === 'mss_breakout' && 'Market structure shift, structural break.'}
      </p>
    </button>
  );
}

function DetailPanel({ row }: { row: ProTradeRow }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <section>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black mb-2">Scanner Metrics</p>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-2 gap-2">
            {[
              ['RVOL', row.rvol > 0 ? `${row.rvol.toFixed(2)}x` : '--'],
              ['Gap', row.gapPct ? fmtPct(row.gapPct) : '--'],
              ['ATR20', fmtMoney(row.atr20)],
              ['ADR%', row.atrPct ? `${row.atrPct.toFixed(2)}%` : '--'],
              ['$ Vol', row.dollarVolM ? `$${row.dollarVolM.toFixed(1)}M` : '--'],
              ['RS vs SPY', row.rsVsBenchmark ? row.rsVsBenchmark.toFixed(3) : '--'],
              ['Prev D Hi', row.prevDayHigh > 0 ? fmtMoney(row.prevDayHigh) : '--'],
              ['Prev D Lo', row.prevDayLow > 0 ? fmtMoney(row.prevDayLow) : '--'],
              ['PM High', row.premarketHigh > 0 ? fmtMoney(row.premarketHigh) : '--'],
              ['PM Low', row.premarketLow > 0 ? fmtMoney(row.premarketLow) : '--'],
              ['PM Vol', row.premarketVolume > 0 ? `${(row.premarketVolume / 1000).toFixed(1)}K` : '--'],
              ['Float', row.sharesOutstanding > 0 ? `${(row.sharesOutstanding / 1e6).toFixed(1)}M` : '--'],
              ['Catalyst', row.catalyst === 'hard' ? '🔥 Hard' : row.catalyst === 'soft' ? 'Soft' : '--'],
              ['Earnings', row.earningsChecked ? row.earningsStatus : 'Not checked'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-white/5 p-2">
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{label}</p>
                <p className="mt-1 text-xs text-slate-200 font-mono">{value}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black mb-2">Trend / Data</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['VWAP', fmtMoney(row.vwap)],
              ['VWAP Align', row.vwapAligned ? 'YES' : 'NO'],
              ['5m Trend', row.trend5m],
              ['Trend Align', row.trendAligned ? 'YES' : 'NO'],
              ['15m Trend', row.trend15m],
              ['15m Align', row.trend15mAligned ? 'YES' : 'NO'],
              ['Provider', row.dataStatus.provider.toUpperCase()],
              ['Mode', row.dataStatus.mode.toUpperCase()],
              ['Updated', `${row.dataStatus.ageSeconds}s ago`],
              ['Stale', row.dataStatus.stale ? 'YES' : 'NO'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-white/5 p-2">
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{label}</p>
                <p className="mt-1 text-xs text-slate-200 font-mono">{value}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black mb-2">Strategy Checks</p>
          {activeStrategySignals(row).length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {activeStrategySignals(row).map((signal) => (
                <span key={signal.strategyId} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[9px] uppercase tracking-widest font-black border ${STAGE_TONES[signal.stage]}`}>
                  {STRATEGY_CODES[signal.strategyId]} {signal.strategyName}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-2 max-h-[220px] overflow-auto pr-1">
            {(row.primaryStrategy?.checklist || []).map((item) => (
              <div key={item.label} className="rounded-lg border border-white/10 bg-white/5 p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-200 font-black">{item.label}</p>
                  <span className={`text-[9px] uppercase tracking-widest font-black ${item.passed ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {item.passed ? 'Pass' : 'Wait'}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{item.detail}</p>
              </div>
            ))}
            {!row.primaryStrategy?.checklist.length && (
              <p className="text-xs text-slate-500">No strategy checklist available for this raw/filtered row.</p>
            )}
          </div>
        </section>

        <section>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black mb-2">Trade Plan</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ['Entry', fmtMoney(row.tradePlan?.entry)],
              ['Stop', fmtMoney(row.tradePlan?.stop)],
              ['T1', fmtMoney(row.tradePlan?.target1 || row.tradePlan?.target)],
              ['T2', fmtMoney(row.tradePlan?.target2 || row.tradePlan?.target)],
              ['R:R', row.tradePlan ? row.tradePlan.rr.toFixed(2) : '--'],
              ['Risk/Share', fmtMoney(row.tradePlan?.riskPerShare)],
              ['Confidence', row.confidence ? row.confidence.toString() : '--'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-white/5 p-2">
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{label}</p>
                <p className="mt-1 text-xs text-slate-200 font-mono">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400 leading-relaxed">
            {row.tradePlan?.invalidation || row.primaryStrategy?.orderBlockReason || row.baseReason}
          </p>
        </section>
      </div>
    </div>
  );
}

function WorkflowTable({
  rows,
  selected,
  onSelect,
  reasonMode = 'strategy',
  orderedTrades = [],
  watchlistSet = new Set<string>(),
  accountBalance = 0,
}: {
  rows: ProTradeRow[];
  selected: ProTradeRow | null;
  onSelect: (row: ProTradeRow) => void;
  reasonMode?: 'strategy' | 'base';
  orderedTrades?: PaperTrade[];
  watchlistSet?: Set<string>;
  accountBalance?: number;
}) {
  const PAGE = 25;
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [minimized, setMinimized] = React.useState(false);
  const displayRows = showAll ? rows : rows.slice(0, PAGE);
  const orderedTradeBySymbol = new Map(orderedTrades.map((trade) => [baseSymbol(trade.symbol), trade]));
  const orderedMode = orderedTrades.length > 0;
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="p-3 border-b border-white/5 bg-white/5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-emerald-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Workflow Results</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
            {minimized ? rows.length : Math.min(displayRows.length, rows.length)}/{rows.length} tickers
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMinimized((m) => !m)}
          className="h-7 px-3 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5"
        >
          {minimized ? <ChevronDown size={11} /> : <ChevronDown size={11} className="rotate-180" />}
          {minimized ? 'Expand' : 'Minimize'}
        </button>
      </div>
      {!minimized && <div className="overflow-auto max-h-[60vh]">
        <table className="w-full min-w-[1400px] text-left border-collapse">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50 sticky top-0 z-10">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5">Ticker / Company</th>
              <th className="py-2.5 px-3 border-r border-white/5">Group</th>
              <th className="py-2.5 px-3 border-r border-white/5">Stage</th>
              <th className="py-2.5 px-3 border-r border-white/5">Primary Strategy</th>
              <th className="py-2.5 px-3 border-r border-white/5">Strategies Passed</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">RVOL</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">Beta</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">Entry</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">Stop</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">T1</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">T2</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">R:R</th>
              <th className="py-2 px-3 border-r border-white/5 text-right">Notional</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Confidence</th>
              {orderedMode && (
                <>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Qty</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Current</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Notional</th>
                  <th className="py-2.5 px-3 border-r border-white/5">Order Time</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Exit Price</th>
                  <th className="py-2.5 px-3 border-r border-white/5">Exit Time</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Profit / Loss</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">P&L %</th>
                </>
              )}
              <th className="py-2.5 px-3 border-r border-white/5">Reason</th>
              <th className="py-2.5 px-3">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {displayRows.map((row) => {
              const rowKey = `${row.sourceBucket}-${row.symbol}-${row.workflowStage}`;
              const expanded = expandedSymbol === rowKey;
              const orderedTrade = orderedTradeBySymbol.get(baseSymbol(row.symbol));
              const currentPrice = row.price || orderedTrade?.exitPrice || orderedTrade?.entry || 0;
              const livePnl = orderedTrade ? (orderedTrade.status === 'Open' ? paperPnl(orderedTrade, currentPrice) : { pnl: orderedTrade.pnl || 0, pnlPercent: orderedTrade.pnlPercent || 0 }) : null;
              return (
                <React.Fragment key={rowKey}>
                  <tr className={`border-b border-white/5 hover:bg-white/5 ${selected?.symbol === row.symbol ? 'bg-indigo-500/10' : ''}`}>
                    <td className="py-3 px-3 border-r border-white/5 min-w-[230px]">
                      <div className="flex items-center gap-1.5">
                        {watchlistSet.has(row.symbol) && (
                          <span title="Day Watchlist" className="text-amber-400 text-[11px] font-black">★</span>
                        )}
                        <span className="font-black text-white text-[13px]">{row.symbol}</span>
                        {row.catalyst === 'hard' && (
                          <span title="Hard catalyst today" className="text-orange-400 text-[10px] font-black">🔥</span>
                        )}
                        {row.earningsDays !== null && Math.abs(row.earningsDays) <= 1 && (
                          <span title={row.earningsStatus} className="text-amber-400 text-[11px] font-black">⚠</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-tight truncate max-w-[210px]">{row.company}</div>
                      <button
                        type="button"
                        onClick={() => setExpandedSymbol(expanded ? null : rowKey)}
                        className="mt-2 text-[10px] uppercase tracking-widest text-slate-400 hover:text-white flex items-center gap-1"
                      >
                        <ChevronDown size={12} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
                        Details
                      </button>
                    </td>
                    <td className="py-3 px-3 border-r border-white/5">{groupBadge(row.primaryStrategy?.signalGroup, row.primaryStrategy?.groupSizeMult)}</td>
                    <td className="py-3 px-3 border-r border-white/5">{stageBadge(row.workflowStage)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-slate-300">
                      {row.primaryStrategy ? (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            {strategyCodeBadge(row.primaryStrategy.strategyId, 'primary')}
                            <span>{row.primaryStrategy.strategyName}</span>
                          </div>
                          <span className="text-[10px] text-slate-500">{WORKFLOW_STAGE_LABELS[row.primaryStrategy.stage]}</span>
                        </div>
                      ) : '--'}
                    </td>
                    <td className="py-3 px-3 border-r border-white/5 min-w-[120px]"><StrategyCodeList row={row} /></td>
                    <td className={`py-3 px-3 border-r border-white/5 font-black ${row.direction === 'BULL' ? 'text-emerald-400' : row.direction === 'BEAR' ? 'text-rose-400' : 'text-slate-500'}`}>{row.direction}</td>
                    <td className={`py-3 px-3 border-r border-white/5 text-right font-mono ${row.rvol >= 1.5 ? 'text-emerald-300 font-black' : row.rvol >= 1.0 ? 'text-slate-200' : 'text-slate-500'}`}>
                      {row.rvol > 0 ? `${row.rvol.toFixed(1)}x` : '--'}
                    </td>
                    <td className={`py-3 px-3 border-r border-white/5 text-right font-mono ${(row.beta ?? 0) > 2.0 ? 'text-rose-300' : (row.beta ?? 0) > 1.3 ? 'text-amber-300' : 'text-slate-400'}`}>
                      {(row.beta ?? 0) > 0 ? (row.beta ?? 0).toFixed(2) : '--'}
                    </td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(row.tradePlan?.entry)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-rose-300">{fmtMoney(row.tradePlan?.stop)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-cyan-300">{fmtMoney(row.tradePlan?.target1 || row.tradePlan?.target)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-emerald-300">{fmtMoney(row.tradePlan?.target2 || row.tradePlan?.target)}</td>
                    <td className={`py-3 px-3 border-r border-white/5 text-right font-mono font-black ${(row.tradePlan?.rr ?? 0) >= 2.5 ? 'text-emerald-300' : (row.tradePlan?.rr ?? 0) >= 1.5 ? 'text-slate-200' : 'text-slate-500'}`}>
                      {row.tradePlan ? row.tradePlan.rr.toFixed(1) : '--'}
                    </td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-indigo-200 font-mono font-black">
                      {accountBalance > 0 && row.tradePlan ? (
                        (() => {
                          const n = computeNotional(accountBalance, row.tradePlan.entry, row.tradePlan.stop, row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED', row.primaryStrategy?.groupSizeMult ?? 1.0);
                          return n > 0 ? `$${n.toFixed(0)}` : '--';
                        })()
                      ) : '--'}
                    </td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-indigo-300 font-black">{row.confidence || '--'}</td>
                    {orderedMode && (
                      <>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade ? orderedTrade.quantity.toFixed(4) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-white">{orderedTrade ? fmtMoney(currentPrice) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade ? fmtMoney(orderedTrade.notional) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-slate-400">{orderedTrade ? toETTime(orderedTrade.openedAt) + ' ET' : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade?.exitPrice ? fmtMoney(orderedTrade.exitPrice) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-slate-400">{orderedTrade?.closedAt ? toETTime(orderedTrade.closedAt) + ' ET' : '--'}</td>
                        <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${(livePnl?.pnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {livePnl ? `${livePnl.pnl >= 0 ? '+' : ''}$${livePnl.pnl.toFixed(2)}` : '--'}
                        </td>
                        <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${(livePnl?.pnlPercent || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {livePnl ? `${livePnl.pnlPercent >= 0 ? '+' : ''}${livePnl.pnlPercent.toFixed(2)}%` : '--'}
                        </td>
                      </>
                    )}
                    <td className="py-3 px-3 border-r border-white/5 text-slate-400 min-w-[280px]">
                      {reasonMode === 'base' ? row.baseReason : row.primaryStrategy?.reason || row.reason}
                    </td>
                    <td className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => onSelect(row)}
                        className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 flex items-center gap-2"
                      >
                        <Eye size={13} />
                        <span className="text-[10px] uppercase tracking-widest font-black">Review</span>
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b border-white/5 bg-slate-950/70">
                      <td colSpan={orderedMode ? 25 : 17} className="p-4">
                        <DetailPanel row={row} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="p-8 text-center text-sm text-slate-500">No tickers in this workflow stage.</div>
        )}
        {rows.length > PAGE && (
          <div className="p-3 border-t border-white/5 flex items-center justify-between">
            <span className="text-[10px] text-slate-500">
              Showing {displayRows.length} of {rows.length} · Top by confidence
            </span>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="h-7 px-3 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white text-[10px] font-black uppercase tracking-widest"
            >
              {showAll ? 'Show Top 25' : `Show All ${rows.length}`}
            </button>
          </div>
        )}
      </div>}
    </div>
  );
}

function DecisionPanel({
  row,
  busy,
  message,
  onClose,
  onApprove,
  onPaperTrade,
  onChart,
}: {
  row: ProTradeRow | null;
  busy: boolean;
  message: string;
  onClose: () => void;
  onApprove: (row: ProTradeRow) => void;
  onPaperTrade: (row: ProTradeRow) => void;
  onChart: (row: ProTradeRow) => void;
}) {
  if (!row) return null;
  const signal = row.primaryStrategy;
  const canApprove = row.workflowStage === 'trade_ready' && Boolean(row.tradePlan);
  const canPaperTrade = Boolean(row.tradePlan && row.tradePlan.rr >= 1.5);
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-end">
      <section className="h-full w-full max-w-[720px] bg-[#080b12] border-l border-white/10 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-[#080b12]/95 border-b border-white/10 p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Trade Decision</p>
            <h2 className="text-xl font-black text-white">{row.symbol} <span className="text-slate-500 text-sm">{row.company}</span></h2>
          </div>
          <button type="button" onClick={onClose} className="w-9 h-9 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white">
            <X size={16} className="mx-auto" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">{stageBadge(row.workflowStage)}</div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Primary Strategy</p>
              <p className="mt-1 text-xs text-white font-black">
                {signal ? `${STRATEGY_CODES[signal.strategyId]} - ${signal.strategyName}` : '--'}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Confidence</p>
              <p className="mt-1 text-xs text-indigo-300 font-black">{row.confidence || '--'}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Data</p>
              <p className={`mt-1 text-xs font-black ${row.dataStatus.mode === 'live' && !row.dataStatus.stale ? 'text-emerald-300' : 'text-amber-300'}`}>{row.dataStatus.mode.toUpperCase()}</p>
            </div>
          </div>

          <ProTradeCandlePreview row={row} />

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Trade Plan</p>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2">
              {[
                ['Entry', fmtMoney(row.tradePlan?.entry)],
                ['Stop', fmtMoney(row.tradePlan?.stop)],
                ['T1', fmtMoney(row.tradePlan?.target1 || row.tradePlan?.target)],
                ['T2', fmtMoney(row.tradePlan?.target2 || row.tradePlan?.target)],
                ['R:R', row.tradePlan ? row.tradePlan.rr.toFixed(2) : '--'],
                ['Risk/Share', fmtMoney(row.tradePlan?.riskPerShare)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-black/20 p-2">
                  <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">{label}</p>
                  <p className="mt-1 text-xs text-white font-mono font-black">{value}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">{row.tradePlan?.invalidation || 'No trade plan calculated yet.'}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">All Active Strategies</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {activeStrategySignals(row).map((item) => (
                <span key={item.strategyId} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[10px] uppercase tracking-widest font-black border ${STAGE_TONES[item.stage]}`}>
                  {STRATEGY_CODES[item.strategyId]} {item.strategyName}
                  <span className="text-slate-500">{WORKFLOW_STAGE_LABELS[item.stage]}</span>
                </span>
              ))}
              {!activeStrategySignals(row).length && <span className="text-xs text-slate-500">No active strategy signal yet.</span>}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Strategy Checklist</p>
            <div className="mt-3 space-y-2">
              {(signal?.checklist || []).map((item) => (
                <div key={item.label} className="flex items-start gap-2 rounded-lg border border-white/10 bg-black/20 p-2">
                  <CheckCircle2 size={14} className={item.passed ? 'text-emerald-400 mt-0.5' : 'text-slate-600 mt-0.5'} />
                  <div>
                    <p className={`text-xs font-black ${item.passed ? 'text-slate-200' : 'text-slate-500'}`}>{item.label}</p>
                    <p className="text-[11px] text-slate-500">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            {signal?.missing.length ? (
              <p className="mt-3 text-xs text-amber-300">Missing: {signal.missing.join(' | ')}</p>
            ) : null}
          </div>

          {message && (
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-3 text-xs text-indigo-200">{message}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => onChart(row)}
              className="h-11 rounded-xl border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 flex items-center justify-center gap-2"
            >
              <BarChart3 size={15} />
              <span className="text-[10px] uppercase tracking-widest font-black">TradingView</span>
            </button>
            <button
              type="button"
              disabled={!canApprove || busy}
              onClick={() => onApprove(row)}
              className="h-11 rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              title={canApprove ? 'Approve demo bracket order' : row.primaryStrategy?.orderBlockReason || 'Trade is not ready'}
            >
              <ShieldCheck size={15} />
              <span className="text-[10px] uppercase tracking-widest font-black">{busy ? 'Sending' : 'Approve'}</span>
            </button>
            <button
              type="button"
              disabled={!canPaperTrade || busy}
              onClick={() => onPaperTrade(row)}
              className="h-11 rounded-xl border border-cyan-500/30 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              title={canPaperTrade ? 'Create simulated paper bracket' : 'Paper trade needs a valid trade plan and R:R >= 1.5'}
            >
              <ShieldCheck size={15} />
              <span className="text-[10px] uppercase tracking-widest font-black">Paper</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10"
            >
              <span className="text-[10px] uppercase tracking-widest font-black">Watch</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function estimatedExitPrice(trade: PaperTrade): number {
  if (trade.exitPrice && trade.exitPrice !== trade.entry) return trade.exitPrice;
  if (trade.outcome === 'Target') return trade.target;
  if (trade.outcome === 'T1 Profit') return trade.target1 ?? trade.target;
  return trade.stop; // Stop or Manual — worst case: exited at stop level
}

function PaperTradeMonitor({
  trades,
  rows,
  monitorDate,
  onMonitorDateChange,
  onCloseTrade,
  onClearClosed,
  onFixZeroPnl,
  eodMessage,
}: {
  trades: PaperTrade[];
  rows: ProTradeRow[];
  monitorDate: string;
  onMonitorDateChange: (date: string) => void;
  onCloseTrade: (trade: PaperTrade, price: number) => void;
  onClearClosed: () => void;
  onFixZeroPnl: () => void;
  eodMessage?: string;
}) {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const filteredTrades = trades.filter((t) => tradeDateET(t) === monitorDate);
  const sortedTrades = [...filteredTrades].sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
  const open = filteredTrades.filter((trade) => trade.status === 'Open');
  const closed = filteredTrades.filter((trade) => trade.status === 'Closed');
  const isToday = monitorDate === todayET();
  // Sum stored trade.pnl — same source as Performance screen so the two always agree.
  // The HUD "Today P&L" widget separately shows the Alpaca equity delta.
  const totalPnl = filteredTrades.reduce((total, trade) => {
    if (trade.status === 'Open') return total;
    const pnl = (!trade.pnl || trade.pnl === 0)
      ? paperPnl(trade, estimatedExitPrice(trade)).pnl
      : trade.pnl;
    return total + pnl;
  }, 0);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="p-3 border-b border-white/5 bg-white/5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-cyan-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Paper Trade Monitor</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{open.length} open / {closed.length} closed</span>
          <input
            type="date"
            value={monitorDate}
            onChange={(e) => onMonitorDateChange(e.target.value)}
            className="ml-2 h-6 px-2 rounded text-[10px] font-bold bg-slate-800 border border-white/10 text-slate-300 focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-black ${totalPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            Total P&L {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
          {closed.some((t) => !t.pnl || t.pnl === 0 || (t.outcome === 'T1 Profit' && (t.pnl ?? 0) < 0)) && (
            <button onClick={onFixZeroPnl} className="text-[10px] uppercase font-black tracking-widest px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors">
              Fix P&amp;L
            </button>
          )}
          {closed.length > 0 && (
            <button onClick={onClearClosed} className="text-[10px] uppercase font-black tracking-widest px-2 py-1 rounded border border-slate-600/40 bg-slate-800/30 text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors">
              Clear History
            </button>
          )}
        </div>
      </div>
      {eodMessage && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-amber-400 border border-amber-500/40 px-1.5 py-0.5 rounded">EOD</span>
          <span className="text-[11px] text-amber-300/80">{eodMessage}</span>
        </div>
      )}
      <div className="overflow-auto max-h-[480px]">
        <table className="w-full min-w-[1320px] text-left border-collapse">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50 sticky top-0 z-10">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5">Opened</th>
              <th className="py-2.5 px-3 border-r border-white/5">Symbol</th>
              <th className="py-2.5 px-3 border-r border-white/5">Strategy</th>
              <th className="py-2.5 px-3 border-r border-white/5">Group</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Entry</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Current/Exit</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Stop / Trail</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T1</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T2</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Qty</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Notional</th>
              <th className="py-2.5 px-3 border-r border-white/5">Status</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">P&L</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">R-mult</th>
              <th className="py-2.5 px-3">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {sortedTrades.map((trade) => {
              const livePrice = priceBySymbol.get(baseSymbol(trade.symbol)) || trade.entry;
              // For closed trades: use exit price; fall back to estimated stop/target price (fixes $0.00 display)
              const closedExitPrice = trade.exitPrice && trade.exitPrice !== trade.entry
                ? trade.exitPrice
                : estimatedExitPrice(trade);
              const current = trade.status === 'Open' ? livePrice : closedExitPrice;
              const currentColor = trade.status === 'Open'
                ? ((trade.direction === 'BULL' ? current > trade.entry : current < trade.entry) ? 'text-emerald-300' : 'text-rose-300')
                : 'text-white';
              const livePnl = trade.status === 'Open'
                ? paperPnl(trade, livePrice)
                : {
                  pnl: trade.pnl && trade.pnl !== 0 ? trade.pnl : paperPnl(trade, closedExitPrice).pnl,
                  pnlPercent: trade.pnlPercent && trade.pnlPercent !== 0 ? trade.pnlPercent : paperPnl(trade, closedExitPrice).pnlPercent
                };
              return (
                <tr key={trade.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3 px-3 border-r border-white/5 text-slate-400">{toETTime(trade.openedAt)} ET</td>
                  <td className="py-3 px-3 border-r border-white/5">
                    <div className="font-black text-white">{trade.symbol}</div>
                    <div className="text-[10px] text-slate-500 uppercase truncate max-w-[160px]">{trade.company}</div>
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-slate-300">{trade.strategyCode} {trade.strategyName}</td>
                  <td className="py-3 px-3 border-r border-white/5">{groupBadge(trade.signalGroup, undefined)}</td>
                  <td className={`py-3 px-3 border-r border-white/5 font-black ${trade.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{trade.direction}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(trade.entry)}</td>
                  <td className={`py-3 px-3 border-r border-white/5 text-right font-bold ${currentColor}`}>{fmtMoney(current)}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right">
                    {trade.status === 'Open' ? (
                      <span className="text-rose-300">{fmtMoney(trade.stop)}</span>
                    ) : (
                      <span className="text-amber-300">{fmtMoney(trade.exitPrice ?? trade.stop)}</span>
                    )}
                    {trade.status === 'Open' && trade.t1HitAt && (
                      <div className="text-[9px] text-amber-300 font-black">Trail {fmtMoney(paperTrailingStop(trade))}</div>
                    )}
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-cyan-300">{fmtMoney(paperTarget1(trade))}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-emerald-300">{fmtMoney(paperTarget2(trade))}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300 font-mono">
                    {trade.quantity >= 1 ? trade.quantity.toFixed(2) : trade.quantity.toFixed(4)} sh
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-indigo-200 font-mono font-black">
                    {fmtMoney(trade.notional)}
                  </td>
                  <td className="py-3 px-3 border-r border-white/5">
                    <span className={`px-2 py-1 rounded border text-[10px] uppercase tracking-widest font-black ${trade.status === 'Open'
                        ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                        : trade.outcome === 'Target' || trade.outcome === 'T1 Profit'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : trade.outcome === 'Stop'
                            ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                            : trade.outcome === 'EOD'
                              ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                              : 'border-slate-600/40 bg-slate-800/30 text-slate-400'
                      }`}>
                      {trade.status === 'Open' ? (trade.t1HitAt ? 'T1 Hit' : 'Open') : (trade.outcome === 'T1 Profit' ? 'T1 HIT / TRAILED' : trade.outcome)}
                    </span>
                  </td>
                  <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${livePnl.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    <div>{livePnl.pnl >= 0 ? '+' : ''}${livePnl.pnl.toFixed(2)}</div>
                    <div className="text-[10px] opacity-70">{livePnl.pnlPercent >= 0 ? '+' : ''}{livePnl.pnlPercent.toFixed(2)}%</div>
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-right font-mono">
                    {(() => {
                      const rRisk = trade.quantity * Math.abs(trade.entry - trade.stop);
                      if (rRisk <= 0) return <span className="text-slate-600">--</span>;
                      const rMult = livePnl.pnl / rRisk;
                      return (
                        <span className={`font-black ${rMult >= 1 ? 'text-emerald-300' : rMult >= 0 ? 'text-slate-300' : 'text-rose-300'}`}>
                          {rMult >= 0 ? '+' : ''}{rMult.toFixed(1)}R
                        </span>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-3">
                    {trade.status === 'Open' ? (
                      <button
                        type="button"
                        onClick={() => onCloseTrade(trade, current)}
                        className="h-8 px-3 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10"
                      >
                        <span className="text-[10px] uppercase tracking-widest font-black">Close</span>
                      </button>
                    ) : (
                      <span className="text-slate-600">{trade.closedAt ? toETTime(trade.closedAt) + ' ET' : '--'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filteredTrades.length && (
          <div className="p-6 text-sm text-slate-500 text-center">{isToday ? 'No paper trades today. Open a ticker review panel and click Paper.' : `No paper trades on ${monitorDate}.`}</div>
        )}
      </div>
    </div>
  );
}

function ProTradeSettingsPanel({
  onClose,
}: {
  settings: ProTradeSettings;
  onChange: (settings: ProTradeSettings) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-end">
      <section className="h-full w-full max-w-[460px] bg-[#080b12] border-l border-white/10 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-[#080b12]/95 border-b border-white/10 p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-cyan-300 font-black">ProTrade Settings</p>
            <h3 className="text-lg font-black text-white">Paper Order Controls</h3>
          </div>
          <button type="button" onClick={onClose} className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white">
            <X size={16} className="mx-auto" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-xs text-cyan-100 leading-relaxed">
            Notional-first fractional sizing: dollars deployed = min(risk-proportional $, group cap $). Fractional shares to 4dp — no whole-share floor. Adjustments: beta, tide, group quality tier, CB layer 3.
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Effective Rules</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-slate-500">Risk per trade</p>
                <p className="font-mono text-white">3% of equity (risk-proportional)</p>
              </div>
              <div>
                <p className="text-slate-500">Group notional cap</p>
                <p className="font-mono text-white">GOLD 15% · BLUE/TREND/FVG 10%</p>
              </div>
              <div>
                <p className="text-slate-500">Max utilization</p>
                <p className="font-mono text-white">65% of account balance</p>
              </div>
              <div>
                <p className="text-slate-500">Beta adjustment</p>
                <p className="font-mono text-white">1.5÷β (clamped 0.4–1.5×)</p>
              </div>
              <div>
                <p className="text-slate-500">Stop loss</p>
                <p className="font-mono text-white">Strategy engine (structural ATR)</p>
              </div>
              <div>
                <p className="text-slate-500">Target</p>
                <p className="font-mono text-white">Strategy engine (PDH/PDL)</p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="h-11 w-full rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
          >
            <span className="text-[10px] uppercase tracking-widest font-black">Close</span>
          </button>
        </div>
      </section>
    </div>
  );
}

// ── Watchlist History (P9) ────────────────────────────────────────────────────

function WatchlistHistoryPanel() {
  const [open, setOpen] = React.useState(false);
  const archive = React.useMemo(() => loadArchive(), []);
  if (!archive.length) return null;
  return (
    <div className="glass rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full p-3 border-b border-white/5 bg-white/5 flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-amber-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Watchlist History</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{archive.length} day{archive.length !== 1 ? 's' : ''}</span>
        </div>
        <ChevronDown size={14} className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="overflow-auto max-h-[340px]">
          <table className="w-full min-w-[640px] text-left border-collapse">
            <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50 sticky top-0 z-10">
              <tr>
                <th className="py-2 px-3 border-r border-white/5">Date</th>
                <th className="py-2 px-3 border-r border-white/5">Symbol</th>
                <th className="py-2 px-3 border-r border-white/5 text-right">Closing Price</th>
                <th className="py-2 px-3 border-r border-white/5">Outcome</th>
                <th className="py-2 px-3 text-right">Paper P&amp;L</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[11px]">
              {archive.map((record) =>
                record.results.map((r, i) => (
                  <tr key={`${record.date}-${r.symbol}`} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3 border-r border-white/5 text-slate-500">{i === 0 ? record.date : ''}</td>
                    <td className="py-2 px-3 border-r border-white/5 font-black text-white">{r.symbol}</td>
                    <td className="py-2 px-3 border-r border-white/5 text-right text-slate-300">{r.closingPrice > 0 ? `$${r.closingPrice.toFixed(2)}` : '--'}</td>
                    <td className={`py-2 px-3 border-r border-white/5 font-black ${r.outcome === 'Target' || r.outcome === 'T1 Profit' ? 'text-emerald-300' : r.outcome === 'Stop' ? 'text-rose-300' : 'text-slate-500'}`}>{r.outcome}</td>
                    <td className={`py-2 px-3 text-right font-black ${r.pnl > 0 ? 'text-emerald-300' : r.pnl < 0 ? 'text-rose-300' : 'text-slate-500'}`}>
                      {r.pnl !== 0 ? `${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}` : '--'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Premarket Gap Scan ────────────────────────────────────────────────────────

// S4: Premarket strategy pre-score — which setups are likely at open
function pmSetups(row: ProTradeRow): StrategyId[] {
  const setups: StrategyId[] = [];
  const bull = row.direction === 'BULL';
  const bear = row.direction === 'BEAR';
  const gap = Math.abs(row.gapPct);

  // S1 ORB: large gap + strong RVOL → primed for opening range breakout
  if (gap >= 2 && row.rvol >= 1.5) setups.push('orb_retest');

  // S2 VWAP pullback: moderate gap on high-ATR liquid name
  if (gap >= 1 && row.atrPct >= 3 && row.rvol >= 1.2 && !setups.includes('orb_retest')) setups.push('vwap_pullback');

  // S3 RS continuation: outpacing SPY premarket in the right direction
  if (bull && row.rsVsBenchmark >= 1.01 && row.gapPct >= 0.5) setups.push('rs_continuation');
  if (bear && row.rsVsBenchmark <= 0.99 && row.gapPct <= -0.5) setups.push('rs_continuation');

  // S4 Liquidity sweep: premarket already breaking above/below prev day hi/lo
  if (bull && row.prevDayHigh > 0 && row.premarketHigh > row.prevDayHigh) setups.push('liquidity_sweep');
  if (bear && row.prevDayLow > 0 && row.premarketLow < row.prevDayLow) setups.push('liquidity_sweep');

  // S5 OB/FVG: clean gap leaves FVG below (bull) or above (bear) current PM range
  if (bull && row.prevDayHigh > 0 && row.premarketLow > row.prevDayHigh * 1.003) setups.push('ob_fvg_retest');
  if (bear && row.prevDayLow > 0 && row.premarketHigh < row.prevDayLow * 0.997) setups.push('ob_fvg_retest');

  return setups.slice(0, 3); // cap at 3 badges
}

function isPremarketWindow(): boolean {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  const mins = h * 60 + m;
  return mins >= 7 * 60 + 30 && mins < 9 * 60 + 45;
}

type GapRow = ProTradeRow & { pmScore: number };

function PremarketGapPanel({
  rows,
  watchlistSet,
  onSelect,
  onLockWatchlist,
}: {
  rows: ProTradeRow[];
  watchlistSet: Set<string>;
  onSelect: (row: ProTradeRow) => void;
  onLockWatchlist: (symbols: string[]) => void;
}) {
  const gapRows: GapRow[] = React.useMemo(
    () =>
      rows
        .filter((r) => Math.abs(r.gapPct) >= 0.5)
        .map((r) => ({ ...r, pmScore: Math.abs(r.gapPct) * Math.max(0.5, r.rvol) }))
        .sort((a, b) => b.pmScore - a.pmScore)
        .slice(0, 15),
    [rows],
  );
  const top10 = gapRows.slice(0, 10).map((r) => r.symbol);
  const inWindow = isPremarketWindow();
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });

  return (
    <div className="glass rounded-xl overflow-hidden flex-1">
      <div className="p-3 border-b border-white/5 bg-white/5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <TrendingUp size={14} className="text-amber-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Premarket Gap Scan</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{gapRows.length} gappers · gap% × RVOL</span>
          <span className={`text-[10px] px-2 py-0.5 rounded border font-bold uppercase tracking-widest ${inWindow ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-slate-600/40 bg-slate-800/30 text-slate-400'}`}>
            {inWindow ? `⏰ Premarket ${etStr}` : `Market open · ${etStr}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onLockWatchlist(top10)}
          disabled={!top10.length}
          className="h-7 px-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest"
        >
          ★ Lock Top 10 as Day Watchlist
        </button>
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[1060px] text-left border-collapse">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50 sticky top-0 z-10">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5"># Symbol</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Gap%</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Price</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Prev Hi</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Prev Lo</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">PM High</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">PM Low</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">PM Vol</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">RVOL</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">ATR%</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Score</th>
              <th className="py-2.5 px-3 border-r border-white/5">Setups</th>
              <th className="py-2.5 px-3">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {gapRows.map((row, i) => {
              const hasEarnings = row.earningsDays !== null && Math.abs(row.earningsDays) <= 1;
              const isWatchlisted = watchlistSet.has(row.symbol);
              const isBull = row.gapPct > 0;
              const isTop10 = i < 10;
              return (
                <tr
                  key={row.symbol}
                  onClick={() => onSelect(row)}
                  className={`border-b border-white/5 hover:bg-white/5 cursor-pointer ${!isTop10 ? 'opacity-50' : ''}`}
                >
                  <td className="py-3 px-3 border-r border-white/5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] text-slate-600 font-black w-4 shrink-0">{i + 1}</span>
                      {isWatchlisted && <span className="text-amber-400 text-[11px] font-black">★</span>}
                      <span className="font-black text-white text-[12px]">{row.symbol}</span>
                      {row.catalyst === 'hard' && <span title="Hard catalyst" className="text-orange-400 text-[10px]">🔥</span>}
                      {hasEarnings && <span title={row.earningsStatus} className="text-amber-400 text-[10px]">⚠</span>}
                      {row.earningsChecked && !hasEarnings && <span className="text-slate-700 text-[8px]">E✓</span>}
                    </div>
                  </td>
                  <td className={`py-3 px-3 border-r border-white/5 text-right font-black text-[13px] ${isBull ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isBull ? '+' : ''}{row.gapPct.toFixed(2)}%
                  </td>
                  <td className={`py-3 px-3 border-r border-white/5 font-black ${row.direction === 'BULL' ? 'text-emerald-400' : row.direction === 'BEAR' ? 'text-rose-400' : 'text-slate-500'}`}>
                    {row.direction}
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(row.price)}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-400">{row.prevDayHigh > 0 ? fmtMoney(row.prevDayHigh) : '--'}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-400">{row.prevDayLow > 0 ? fmtMoney(row.prevDayLow) : '--'}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-emerald-300">{row.premarketHigh > 0 ? fmtMoney(row.premarketHigh) : '--'}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-rose-300">{row.premarketLow > 0 ? fmtMoney(row.premarketLow) : '--'}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">
                    {row.premarketVolume > 0 ? `${(row.premarketVolume / 1000).toFixed(0)}K` : '--'}
                  </td>
                  <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${row.rvol >= 1.5 ? 'text-emerald-300' : row.rvol >= 1 ? 'text-slate-200' : 'text-slate-500'}`}>
                    {row.rvol.toFixed(2)}x
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{row.atrPct.toFixed(1)}%</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-indigo-300 font-black">{row.pmScore.toFixed(1)}</td>
                  <td className="py-3 px-3 border-r border-white/5">
                    {(() => {
                      const setups = pmSetups(row); return (
                        <div className="flex flex-wrap gap-1">
                          {setups.map((id) => (
                            <span
                              key={id}
                              title={STRATEGY_LABELS[id]}
                              className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border border-indigo-400/40 bg-indigo-500/15 text-indigo-200"
                            >
                              {STRATEGY_CODES[id]}
                            </span>
                          ))}
                          {!setups.length && <span className="text-slate-700 text-[9px]">—</span>}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="py-3 px-3">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onSelect(row); }}
                      className="h-7 px-2.5 rounded border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[10px] uppercase tracking-widest font-black"
                    >
                      Review
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!gapRows.length && (
          <div className="p-8 text-center text-sm text-slate-500">
            No gappers detected (gap ≥ 0.5%). Waiting for premarket data — 7:30–9:30 AM ET.
          </div>
        )}
      </div>
    </div>
  );
}

export function ProTradeScannerScreen() {
  const [snapshot, setSnapshot] = React.useState<ProTradeSnapshot | null>(null);
  const snapshotRef = React.useRef<ProTradeSnapshot | null>(null);
  React.useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const [loading, setLoading] = React.useState(true);
  const [manualLoading, setManualLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [activeStage, setActiveStage] = React.useState<StageFilter>('forming');
  const [activeStrategy, setActiveStrategy] = React.useState<StrategyId | 'all'>('all');
  const [selectedRow, setSelectedRow] = React.useState<ProTradeRow | null>(null);
  const [approvalBusy, setApprovalBusy] = React.useState(false);
  const [approvalMessage, setApprovalMessage] = React.useState('');
  const [chartRow, setChartRow] = React.useState<ProTradeRow | null>(null);
  const [chartInterval, setChartInterval] = React.useState<TradingViewInterval>('5');
  const [paperTrades, setPaperTrades] = React.useState<PaperTrade[]>(() => loadPaperTrades());
  const paperTradesRef = React.useRef<PaperTrade[]>(paperTrades);
  React.useEffect(() => { paperTradesRef.current = paperTrades; }, [paperTrades]);
  const eodFiredRef = React.useRef<string>(localStorage.getItem('sutra.eodFiredDate') ?? '');
  const [eodMessage, setEodMessage] = React.useState<string>(() => {
    const storedDate = localStorage.getItem('sutra.eodFiredDate') ?? '';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return storedDate === today ? (localStorage.getItem('sutra.eodMessage') ?? '') : '';
  });
  const [monitorDate, setMonitorDate] = React.useState<string>(() => todayET());
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<ProTradeSettings>(() => loadProTradeSettings());
  const [accountBalance, setAccountBalance] = React.useState(100_000);
  const [watchlist, setWatchlist] = React.useState<DayWatchlist>(() => loadWatchlist());
  const [watchlistOnly, setWatchlistOnly] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<'premarket' | 'workflow'>(() => isPremarketWindow() ? 'premarket' : 'workflow');
  const [cbTick, setCbTick] = React.useState(0);

  async function load(forceRefresh = false) {
    try {
      if (forceRefresh) {
        setManualLoading(true);
        clearUniverseCache();
      } else {
        setLoading(true);
      }
      setError('');
      const [nextSnapshot, acct] = await Promise.all([
        fetchProTradeScannerSnapshot(watchlist.symbols),
        getPaperAccount().catch(() => null),
      ]);
      setSnapshot(nextSnapshot);
      if (acct) {
        const bal = parseFloat(acct.equity);
        if (bal > 0) { setAccountBalance(bal); initDailyBalance(bal); }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setManualLoading(false);
    }
  }

  React.useEffect(() => {
    migrateCbKeys();
    alpacaBarStream.connect();
    void load();
    return () => alpacaBarStream.destroy();
  }, []);

  // Full universe scan every 60s
  React.useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Hot-set refresh every 20s — only re-evaluates forming/confirmed/locked stocks
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const cur = snapshotRef.current;
      if (!cur) return;
      const hotFromStage = cur.rows
        .filter((r) => r.workflowStage === 'forming' || r.workflowStage === 'confirmed' || r.workflowStage === 'locked' || r.workflowStage === 'trade_ready')
        .map((r) => r.symbol);
      // Always keep watchlist symbols in the hot set so they're never dropped from monitoring
      const hotSymbols = [...new Set([...hotFromStage, ...watchlist.symbols])];
      if (!hotSymbols.length) return;
      void fetchHotSetSnapshot(hotSymbols).then((fresh) => {
        if (!fresh.length) return;
        setSnapshot((prev) => {
          if (!prev) return prev;
          const freshMap = new Map(fresh.map((r) => [r.symbol, r]));
          return { ...prev, rows: prev.rows.map((r) => freshMap.get(r.symbol) ?? r), fetchedAt: new Date().toISOString() };
        });
      }).catch(() => { /* best-effort */ });
    }, 20_000);
    return () => window.clearInterval(id);
  }, []);

  // WebSocket: subscribe ALL hot-set symbols so every 5m bar close fires instantly for all 9 strategies.
  // Previously limited to S3/S4/S6/S7 — now covers forming/confirmed/locked/trade_ready regardless of strategy.
  React.useEffect(() => {
    const wsSymbols = (snapshot?.rows ?? [])
      .filter((r) =>
        r.workflowStage === 'forming' ||
        r.workflowStage === 'confirmed' ||
        r.workflowStage === 'locked' ||
        r.workflowStage === 'trade_ready'
      )
      .map((r) => r.symbol);
    if (wsSymbols.length) alpacaBarStream.subscribe(wsSymbols);
  }, [snapshot?.rows]);

  // WebSocket 5m bar close → evict cache + re-evaluate that symbol immediately
  React.useEffect(() => {
    return alpacaBarStream.onFiveMinClose((symbol) => {
      clearBarCache(symbol);
      void fetchHotSetSnapshot([symbol]).then((fresh) => {
        if (!fresh.length) return;
        setSnapshot((prev) => {
          if (!prev) return prev;
          const freshMap = new Map(fresh.map((r) => [r.symbol, r]));
          return { ...prev, rows: prev.rows.map((r) => freshMap.get(r.symbol) ?? r), fetchedAt: new Date().toISOString() };
        });
      }).catch(() => { /* best-effort */ });
    });
  }, []);

  // Refresh account equity every 15s for live HUD updates
  React.useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const acct = await getPaperAccount();
        const bal = parseFloat(acct.equity);
        if (bal > 0) { setAccountBalance(bal); initDailyBalance(bal); }
      } catch { /* best-effort */ }
    }, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const alertedTradeReadyRef = React.useRef<Set<string>>(new Set());
  const firedInstantRef = React.useRef<Set<string>>(new Set());

  // Confirmation queue: symbols that hit trade_ready but haven't fired yet.
  // Keyed by base symbol; value holds context needed to fire after confirmation.
  interface ConfirmationEntry {
    row: ProTradeRow;
    level: number;           // structural breakout price to confirm above/below
    direction: 'BULL' | 'BEAR';
    addedAt: number;
  }
  const awaitingConfirmRef = React.useRef<Map<string, ConfirmationEntry>>(new Map());
  const [pendingConfirmCount, setPendingConfirmCount] = React.useState(0);

  const rows = React.useMemo(() => withOrderedStage(snapshot?.rows || [], paperTrades), [snapshot?.rows, paperTrades]);
  // Symbols blocked from re-entry today because they stopped out.
  // Key = "SYMBOL|STRATEGY|DIRECTION" — only the exact same strategy+direction is blocked.
  // Opposite direction is allowed (failed BULL sweep → BEAR sweep may be the correct read).
  // Persists across refresh because it is derived from paperTrades (already persisted to server).
  const stoppedTodaySet = React.useMemo(() => {
    const today = todayET();
    return new Set(
      paperTrades
        .filter((t) => tradeDateET(t) === today && t.status === 'Closed' && t.outcome === 'Stop' && t.strategyId)
        .map((t) => `${baseSymbol(t.symbol)}|${t.strategyId}|${t.direction}`)
    );
  }, [paperTrades]);
  const rawRows = snapshot?.rawRows || [];
  const proWatchlistRows = rows.filter((row) => row.basePass);
  const stageRows = activeStage === 'screened_universe'
    ? rawRows
    : activeStage === 'pro_watchlist'
      ? proWatchlistRows
      : rows.filter((row) => row.workflowStage === activeStage);
  const strategyFilteredRows = activeStrategy === 'all'
    ? stageRows
    : rows.filter((row) => row.strategySignals.some((signal) => signal.strategyId === activeStrategy && signal.stage !== 'screened_universe'));
  const watchlistSet = React.useMemo(() => new Set(watchlist.symbols), [watchlist.symbols]);
  // When watchlist filter is active, show ALL stages for watchlist stocks (ignore stage filter)
  const filteredRows = watchlistOnly && watchlist.symbols.length > 0
    ? rows.filter((row) => watchlistSet.has(row.symbol))
    : strategyFilteredRows;
  const orderedPaperTrades = paperTrades.filter((trade) => baseSymbol(trade.symbol) && (trade.status === 'Open' || trade.status === 'Closed'));
  const selected = selectedRow ? withOrderedStage([selectedRow], paperTrades)[0] : null;
  const strategyIds = Object.keys(STRATEGY_LABELS) as StrategyId[];
  const lastUpdated = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
  const stale = rows.some((row) => row.dataStatus.stale);

  // Sound alert when a new stock reaches trade_ready
  React.useEffect(() => {
    const newOnes = rows.filter((r) => r.workflowStage === 'trade_ready' && !alertedTradeReadyRef.current.has(r.symbol));
    if (!newOnes.length) return;
    newOnes.forEach((r) => alertedTradeReadyRef.current.add(r.symbol));
    playTradeReadyAlert();
  }, [rows]);

  function lockWatchlist(symbols: string[]) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const next: DayWatchlist = { date: today, symbols };
    setWatchlist(next);
    saveWatchlist(next);
    setWatchlistOnly(true);
    setViewMode('workflow');
  }

  // 8:30 AM ET universe refresh — clears the 6h screener cache once per day at pre-market open
  // so the universe reflects current RVOL/gap data before the watchlist locks at 8:30 AM.
  // firedDate is persisted in sessionStorage so remounting the component (navigation, HMR)
  // does not re-trigger the cache clear and re-scan after 8:30 AM.
  React.useEffect(() => {
    const FIRED_KEY = 'sutra.universe830FiredDate';
    const id = setInterval(() => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (sessionStorage.getItem(FIRED_KEY) === today) return;
      const mins = etMinutesNow();
      if (mins < 8 * 60 + 30) return;
      sessionStorage.setItem(FIRED_KEY, today);
      clearUniverseCache();
      void load();
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // P5: Auto-lock Day Watchlist at 8:30 AM ET on first scan of the day
  React.useEffect(() => {
    if (!rows.length) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (watchlist.date === today) return;
    const etH = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
    const etM = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
    if (etH < 8 || (etH === 8 && etM < 30)) return;
    const top10 = [...rows].sort((a, b) => b.confidence - a.confidence).slice(0, 10).map((r) => r.symbol);
    const nextDayQueue = loadNextDayQueue();
    const merged = [...new Set([...top10, ...nextDayQueue])];
    saveNextDayQueue([]);
    const next: DayWatchlist = { date: today, symbols: merged };
    setWatchlist(next);
    saveWatchlist(next);
  }, [rows, watchlist.date]);

  // P9: EOD archive — record watchlist outcome after 4 PM ET
  React.useEffect(() => {
    if (!rows.length || !watchlist.symbols.length) return;
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (watchlist.date !== todayET) return;
    const etH = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
    const etM = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
    if (etH * 60 + etM < 16 * 60) return; // Before 4 PM ET
    const archive = loadArchive();
    if (archive.some((r) => r.date === todayET)) return; // Already archived
    const priceBySymbol = new Map(rows.map((r) => [r.symbol, r.price]));
    const results: WatchlistStockResult[] = watchlist.symbols.map((sym) => {
      const pt = paperTrades.find((t) => baseSymbol(t.symbol) === sym && t.status !== 'Open');
      return {
        symbol: sym,
        closingPrice: priceBySymbol.get(sym) ?? 0,
        pnl: pt?.pnl ?? 0,
        outcome: pt?.outcome ?? '--',
      };
    });
    saveArchive([{ date: todayET, archivedAt: new Date().toISOString(), symbols: watchlist.symbols, results }, ...archive]);
  }, [rows, watchlist, paperTrades]);

  // Auto-advance Monitor date when the page is left open overnight.
  // Only advances if the user was already on today's date and the day rolls over.
  // Does NOT reset a past date the user manually selected.
  React.useEffect(() => {
    const id = setInterval(() => {
      setMonitorDate((current) => {
        const today = todayET();
        return current === today ? today : current;
      });
    }, 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Load all trades from server on mount (server is source of truth).
  const serverLoadDone = React.useRef(false);
  React.useEffect(() => {
    // Fetch the raw server response first so we know if it was intentionally cleared.
    // loadAllTrades() merges LS data in, hiding a server [] behind stale LS trades.
    fetch('/api/trades', { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(async (raw: PaperTrade[]) => {
        serverLoadDone.current = true;
        if (raw.length === 0) {
          // Server is empty — atomically wipe LS too so the merge loop can't repopulate it
          await clearAllTrades();
          setPaperTrades([]);
        } else {
          // Server has trades — normal merge (picks up any LS-only drafts)
          const merged = await loadAllTrades<PaperTrade>();
          // Startup auto-close: EOD only fires when the browser is running at 3:57 PM ET.
          // On refresh/reopen, close any stale open trades: prior-day trades always,
          // today's trades if it's now past 4:00 PM ET.
          const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const pastEod = etMinutesNow() >= 16 * 60;
          const S15M_IDS = new Set(['orb15m_retest', 'vwap15m_pullback', 'ema20_bounce_15m']);
          const closedAt = new Date().toISOString();
          let staleCount = 0;
          const autoClosedMsg = (() => {
            const cleaned = merged.map((t) => {
              if (t.status !== 'Open') return t;
              if (S15M_IDS.has(t.strategyId ?? '')) return t;
              const tradeDay = tradeDateET(t);
              const isStale = tradeDay < today || (tradeDay === today && pastEod);
              if (!isStale) return t;
              staleCount++;
              return closePaperTrade(t, t.entry, 'EOD', closedAt);
            });
            return { trades: cleaned, count: staleCount };
          })();
          setPaperTrades(autoClosedMsg.trades);
          if (autoClosedMsg.count > 0) {
            const msg = `EOD auto-close on startup: ${autoClosedMsg.count} stale position(s) closed at last known price.`;
            localStorage.setItem('sutra.eodFiredDate', today);
            localStorage.setItem('sutra.eodMessage', msg);
            setEodMessage(msg);
            eodFiredRef.current = today;
          }
        }
      })
      .catch(() => {
        // Server unreachable — fall back to whatever LS has
        serverLoadDone.current = true;
      });
  }, []);

  // Periodic sync: push any LS-only trades to server every 2 minutes (recovers from server-down sessions).
  React.useEffect(() => {
    const id = setInterval(() => { void syncPendingTrades(); }, 2 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Persist to localStorage + server on every change (skip very first render to avoid writing stale localStorage to server)
  const isFirstRender = React.useRef(true);
  const prevTradesRef = React.useRef<PaperTrade[]>(paperTrades);
  React.useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; prevTradesRef.current = paperTrades; return; }
    savePaperTrades(paperTrades);
    const prev = prevTradesRef.current;
    paperTrades.forEach((t) => {
      const old = prev.find((p) => p.id === t.id);
      if (!old || old.status !== t.status || old.outcome !== t.outcome || old.pnl !== t.pnl || old.exitPrice !== t.exitPrice) {
        persistTrade(t);
      }
      // S7 fires instantly and locks the symbol in firedInstantRef for the session.
      // Clear it on trade close so a genuine second setup can execute.
      if (old?.status === 'Open' && t.status === 'Closed') {
        firedInstantRef.current.delete(baseSymbol(t.symbol));
      }
    });
    prevTradesRef.current = paperTrades;
  }, [paperTrades]);

  React.useEffect(() => {
    saveProTradeSettings(settings);
  }, [settings]);

  React.useEffect(() => {
    if (!rows.length || !paperTrades.some((trade) => trade.status === 'Open')) return;
    const monitored = monitorPaperTrades(paperTrades, rows);
    if (monitored.changed) setPaperTrades(monitored.trades);
  }, [rows, paperTrades]);

  // Sync open localStorage trades with Alpaca paper positions.
  // If a trade is no longer in Alpaca (bracket leg filled), close it with the real fill price.
  React.useEffect(() => {
    const openTrades = paperTrades.filter((t) => t.status === 'Open');
    if (!openTrades.length) return;

    void (async () => {
      try {
        const alpacaPositions = await getPaperPositions();
        const alpacaSymbols = new Set(alpacaPositions.map((p) => p.symbol.toUpperCase()));

        // Grace: ignore trades opened in the last 2 minutes — Alpaca position may not be registered yet
        const SYNC_GRACE_MS = 120_000;
        const closedInAlpaca = openTrades.filter((t) =>
          !alpacaSymbols.has(t.symbol.toUpperCase()) &&
          Date.now() - new Date(t.openedAt).getTime() >= SYNC_GRACE_MS
        );
        if (!closedInAlpaca.length) return;

        const closedUpdates = await Promise.all(
          closedInAlpaca.map(async (trade): Promise<PaperTrade | null> => {
            // Try to get the real Alpaca fill price from closed orders
            let exitPrice: number | null = null;
            let closedAt: string | undefined;
            try {
              const filled = (await getRecentFilledOrders(trade.symbol))
                // Only fills that happened AFTER this trade opened — avoids stale fills from prior sessions
                .filter((o) => o.filled_at && o.filled_at > trade.openedAt);
              // Pick the most recent exit leg (stop_loss or take_profit — skip the entry fill)
              const leg = filled.find((o) => o.side !== (trade.direction === 'BULL' ? 'buy' : 'sell')) ?? filled[0];
              if (leg?.filled_avg_price) {
                exitPrice = parseFloat(leg.filled_avg_price);
                closedAt = leg.filled_at ?? undefined;
              }
            } catch {
              // fall through to row price fallback
            }

            // No real Alpaca fill found — don't fabricate a price; keep trade Open
            // The price-based monitor will close it when it detects stop/target breach
            if (!exitPrice) return null;

            // Determine outcome from exit vs stop/target
            const toStop = Math.abs(exitPrice - trade.stop);
            const toTarget = Math.abs(exitPrice - trade.target);
            const outcome: PaperTrade['outcome'] = toStop <= toTarget
              ? (trade.t1HitAt ? 'T1 Profit' : 'Stop')
              : 'Target';
            // T1 Profit: floor exit at trailing stop — Alpaca fill slippage can't produce negative P&L on protected trade
            const ts = trade.trailingStop ?? trade.stop;
            const safeExit = outcome === 'T1 Profit'
              ? (trade.direction === 'BULL' ? Math.max(exitPrice, ts) : Math.min(exitPrice, ts))
              : exitPrice;
            return closePaperTrade(trade, safeExit, outcome, closedAt);
          })
        );

        const validUpdates = closedUpdates.filter(Boolean) as PaperTrade[];
        if (!validUpdates.length) return;

        const updateMap = new Map(validUpdates.map((t) => [t.id, t]));
        setPaperTrades((current) => current.map((t) => updateMap.get(t.id) ?? t));

        // Record results in risk manager (circuit breaker + daily loss)
        // Use strategyId (not strategyName) — must match the key used in checkStrategyCircuitBreaker
        validUpdates.forEach((t) => {
          if (t.pnl !== undefined) {
            recordTradeResult(t.strategyId ?? t.strategyName, t.pnl, accountBalance);
            recordGroupTradeResult(t.signalGroup ?? 'UNCLASSIFIED', t.pnl);
          }
        });
      } catch {
        // Sync is best-effort — never block the UI
      }
    })();
  }, [snapshot?.rows]); // scan data only — must NOT depend on rows/paperTrades or sync fires on every trade open

  // Auto-execute with 1m confirmation bar gate.
  // Phase 1 (sync): enqueue newly trade_ready rows; prune stale entries.
  // Phase 2 (async): fetch 1m bars, check last closed bar for price + volume confirmation, then fire.
  React.useEffect(() => {
    if (!snapshot?.rows.length) return;
    if (etMinutesNow() >= 15 * 60 + 50) return;
    if (!checkDailyLossLimit(accountBalance).ok) return;

    const pending = awaitingConfirmRef.current;
    const tradedSymbols = new Set(paperTrades.filter((t) => t.status === 'Open').map((t) => baseSymbol(t.symbol)));
    const CONFIRM_WINDOW_MS = 5 * 60_000; // abandon if no confirmation within 5 minutes
    const now = Date.now();

    // Phase 1a — enqueue eligible rows not yet queued or traded
    snapshot.rows.forEach((row) => {
      const sym = baseSymbol(row.symbol);
      if (row.workflowStage !== 'trade_ready') return;
      if (!canPaperTradeRow(row, settings, paperTrades, accountBalance)) return;
      if (tradedSymbols.has(sym) || pending.has(sym) || firedInstantRef.current.has(sym)) return;
      if (row.earningsDays !== null && Math.abs(row.earningsDays) <= 1) return;
      if (!checkStrategyCircuitBreaker(row.primaryStrategy?.strategyId || row.symbol).ok) return;
      if (isTideBlocked(row, snapshot.spyTrend5m, snapshot.spyTrend15m, row.primaryStrategy ?? undefined)) return;
      const stoppedStratId = row.primaryStrategy?.strategyId ?? '';
      const stoppedStratDir = row.primaryStrategy?.direction ?? row.direction;
      if (stoppedTodaySet.has(`${sym}|${stoppedStratId}|${stoppedStratDir}`)) return;

      const level = row.tradePlan?.entry;
      if (!level) return;

      // All strategies use 1m bar confirmation — S7 alone is blocked at forming (capScoutSignals),
      // S7+S8 together uses S8 structural entry which doesn't expire like a raw volume spike.
      pending.set(sym, { row, level, direction: row.direction === 'BEAR' ? 'BEAR' : 'BULL', addedAt: now });
    });

    // Phase 1b — prune: window expired, symbol gone, or setup fundamentally failed.
    // Keep 'locked' (transient: stale data / blackout) and 'confirmed' (minor R:R dip) — they recover.
    // Only drop 'screened_universe' or 'forming' — those mean the setup checklist regressed.
    for (const [sym, entry] of pending) {
      const currentRow = snapshot.rows.find((r) => baseSymbol(r.symbol) === sym);
      const stage = currentRow?.workflowStage;
      const setupRegressed = !currentRow || stage === 'screened_universe' || stage === 'forming';
      if (now - entry.addedAt > CONFIRM_WINDOW_MS || setupRegressed) {
        pending.delete(sym);
      }
    }

    setPendingConfirmCount(pending.size);
    if (!pending.size) return;

    // Phase 2 — async: 1m bar confirmation check
    const snap = snapshot; // capture before async
    void (async () => {
      let barMap: Record<string, { time: string; open: number; high: number; low: number; close: number; volume: number }[]>;
      try {
        barMap = await fetchBars([...pending.keys()], '1m');
      } catch {
        return; // data unavailable — wait for next cycle
      }

      const confirmedTrades: PaperTrade[] = [];
      const openedAt = new Date().toISOString();

      for (const [sym, entry] of pending) {
        const allOpen = [...paperTrades, ...confirmedTrades];
        const usedNotional = allOpen.filter(t => t.status === 'Open').reduce((s, t) => s + (t.t1HitAt ? t.notional * 0.5 : t.notional), 0);
        if (usedNotional >= accountBalance * 0.65) break;

        const candles = barMap[sym];
        if (!candles || candles.length < 5) continue;

        // candles[length-1] = current in-progress bar (not closed yet)
        // candles[length-2] = last CONFIRMED closed 1m bar
        const closedBar = candles[candles.length - 2];
        const priorBars = candles.slice(-22, -2); // 20 bars before the closed bar
        const avgVol = priorBars.length > 0
          ? priorBars.reduce((s, b) => s + b.volume, 0) / priorBars.length
          : 0;

        // 0.5% tolerance: current price at detection is typically 0.3–0.7% above the
        // structural level (ORB high, OB zone, micro-range). The last CLOSED 1m bar sits
        // at that structural level, not at the extended current price. 0.2% wasn't enough.
        const priceConfirmed = entry.direction === 'BULL'
          ? closedBar.close >= entry.level * 0.995
          : closedBar.close <= entry.level * 1.005;

        // Retest strategies (S1, S5) expect quiet absorption on the retest bar — low volume
        // is correct. Only breakout strategies (S3, S6) need an elevated-volume confirmation.
        const retestStrats = new Set(['orb_retest', 'ob_fvg_retest', 'vwap_pullback', 'ema20_bounce']);
        const needsVolSpike = !retestStrats.has(entry.row.primaryStrategy?.strategyId ?? '');
        const volConfirmed = !needsVolSpike || avgVol <= 0 || closedBar.volume >= avgVol * 1.1;

        if (!priceConfirmed || !volConfirmed) {
          // Wait zone: 0.5–1.5% below detection price → keep pending, check next bar.
          // Hard fail: >1.5% below detection price → genuine reversal, delete.
          const setupFailed = entry.direction === 'BULL'
            ? closedBar.close < entry.level * 0.985
            : closedBar.close > entry.level * 1.015;
          if (setupFailed) pending.delete(sym);
          continue;
        }

        const row = snap.rows.find((r) => baseSymbol(r.symbol) === sym);
        if (!row || row.workflowStage !== 'trade_ready') { pending.delete(sym); continue; }

        const trade = buildPaperTrade(row, settings, [...paperTrades, ...confirmedTrades], openedAt, accountBalance, snap.spyTrend5m, snap.spyTrend15m);
        if (!trade) { pending.delete(sym); continue; }

        confirmedTrades.push(trade);
        pending.delete(sym);
        firedInstantRef.current.add(sym); // block re-entry until trade closes (guards stale-state race)
      }

      setPendingConfirmCount(pending.size);
      if (!confirmedTrades.length) return;

      setPaperTrades((current) => [...confirmedTrades, ...current]);
      setMonitorDate(todayET()); // snap Monitor to today — page may have been open since a previous session
      setApprovalMessage(`1m confirmed: ${confirmedTrades.map((t) => t.symbol).join(', ')} — entry after close above level.`);

      confirmedTrades.forEach((trade) => {
        placePaperBracketOrder({
          symbol: trade.symbol,
          direction: trade.direction === 'BEAR' ? 'BEAR' : 'BULL',
          entry: trade.entry, stop: trade.stop, target: trade.target, notional: trade.notional,
        }).catch((err: unknown) => console.warn(`Alpaca order skipped for ${trade.symbol}:`, err instanceof Error ? err.message : err));
      });
    })();
  }, [snapshot?.rows, paperTrades, settings, stoppedTodaySet]);

  // EOD flat: at 3:57 PM ET close all open positions before 4:00 PM market close.
  // Stable deps [] so the interval is never reset by hot-set refreshes or paperTrades changes.
  // Uses refs to read latest state; eodFiredRef prevents double-fire within the window.
  React.useEffect(() => {
    const interval = setInterval(() => {
      const mins = etMinutesNow();
      if (mins < 15 * 60 + 57 || mins > 16 * 60) return;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (eodFiredRef.current === today) return;
      // 15m strategies (S10/S11/S12) are exempt from EOD force-close — their wider
      // stops and R:R≥2.0 mean cutting at 3:57 PM systematically kills the T2 leg.
      // They run to their natural exit (T2 hit or trailing stop) before 4:00 PM.
      const S15M_IDS = new Set(['orb15m_retest', 'vwap15m_pullback', 'ema20_bounce_15m']);
      const openTrades = paperTradesRef.current.filter((t) => t.status === 'Open' && !S15M_IDS.has(t.strategyId ?? ''));
      eodFiredRef.current = today;
      localStorage.setItem('sutra.eodFiredDate', today);
      if (!openTrades.length) return;
      const closedAt = new Date().toISOString();
      setPaperTrades((current) => current.map((t) => {
        if (t.status !== 'Open') return t;
        if (S15M_IDS.has(t.strategyId ?? '')) return t;
        const row = snapshotRef.current?.rows.find((r) => baseSymbol(r.symbol) === baseSymbol(t.symbol));
        const exitPrice = row?.price ?? t.entry;
        return closePaperTrade(t, exitPrice, 'EOD', closedAt);
      }));
      closeAllPaperPositions().catch(() => { });
      const msg = `EOD 3:57 PM — closed ${openTrades.length} position(s) flat. 15m strategies (S10/S11/S12) run to natural exit.`;
      localStorage.setItem('sutra.eodMessage', msg);
      setEodMessage(msg);
      setApprovalMessage(msg);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function approve(row: ProTradeRow) {
    const plan = effectiveTradePlan(row, settings);
    if (!plan) return;
    const strategyName = row.primaryStrategy?.strategyId || row.symbol;
    const lossCheck = checkDailyLossLimit(accountBalance);
    if (!lossCheck.ok) { setApprovalMessage(lossCheck.reason!); return; }
    // Legacy per-strategy CB (kept for backward compat) + new group-level CB
    const cbCheck = checkStrategyCircuitBreaker(strategyName);
    if (!cbCheck.ok) { setApprovalMessage(cbCheck.reason!); return; }
    const groupCbCheck = checkGroupCircuitBreaker(row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED');
    if (!groupCbCheck.ok) { setApprovalMessage(groupCbCheck.reason!); return; }
    const sectorCheck = checkSectorConcentration(paperTrades, row.symbol);
    if (!sectorCheck.ok) { setApprovalMessage(sectorCheck.reason!); return; }
    const approxNotional = computeNotional(accountBalance, plan.entry, plan.stop, row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED', row.primaryStrategy?.groupSizeMult ?? 1.0);
    const betaPortCheck = checkPortfolioBeta(paperTrades, row.beta ?? 1.0, approxNotional, accountBalance);
    if (!betaPortCheck.ok) { setApprovalMessage(betaPortCheck.reason!); return; }
    // Stale entry filter: skip if price drifted >50% of risk past entry — no chasing
    const tradeDir = row.primaryStrategy?.direction ?? row.direction;
    const risk = Math.abs(plan.entry - plan.stop);
    const currentPrice = row.price;
    if (tradeDir === 'BULL' && currentPrice > plan.entry + risk * 0.5) {
      setApprovalMessage(`Stale entry: price moved $${(currentPrice - plan.entry).toFixed(2)} past entry — skipped to avoid chasing.`);
      return;
    }
    if (tradeDir === 'BEAR' && currentPrice < plan.entry - risk * 0.5) {
      setApprovalMessage(`Stale entry: price moved $${(plan.entry - currentPrice).toFixed(2)} past entry — skipped to avoid chasing.`);
      return;
    }
    const usedNotional = paperTrades.filter(t => t.status === 'Open').reduce((s, t) => s + (t.t1HitAt ? t.notional * 0.5 : t.notional), 0);
    if (usedNotional >= accountBalance * 0.65) { setApprovalMessage(`Balance utilization at ${((usedNotional / accountBalance) * 100).toFixed(0)}% — 65% cap reached. Wait for a position to close.`); return; }
    // P3: Earnings warning (manual override allowed, but alert the trader)
    if (row.earningsDays !== null && Math.abs(row.earningsDays) <= 1) {
      setApprovalMessage(`⚠ Earnings ${row.earningsStatus} — elevated gap risk. Submitting with caution.`);
    }
    try {
      setApprovalBusy(true);
      setApprovalMessage('');
      const approveGroup = row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED';
      const approveGroupMult = (row.primaryStrategy?.groupSizeMult ?? 1.0) * groupCbCheck.sizeMult;
      const orderNotional = computeNotional(accountBalance, plan.entry, plan.stop, approveGroup, approveGroupMult);
      const order = await placePaperBracketOrder({
        symbol: row.symbol,
        direction: row.direction === 'BEAR' ? 'BEAR' : 'BULL',
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        notional: orderNotional,
      });
      setApprovalMessage(`Alpaca paper bracket submitted: ${order.id.slice(0, 8)} · ${row.symbol} ${order.side.toUpperCase()} ${order.qty} shares`);
      await load(true);
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovalBusy(false);
    }
  }

  function createPaperTrade(row: ProTradeRow) {
    const strategyName = row.primaryStrategy?.strategyId || row.symbol;
    const lossCheck = checkDailyLossLimit(accountBalance);
    if (!lossCheck.ok) { setApprovalMessage(lossCheck.reason!); return; }
    const cbCheck = checkStrategyCircuitBreaker(strategyName);
    if (!cbCheck.ok) { setApprovalMessage(cbCheck.reason!); return; }
    const groupCbCheck = checkGroupCircuitBreaker(row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED');
    if (!groupCbCheck.ok) { setApprovalMessage(groupCbCheck.reason!); return; }
    const sectorCheck = checkSectorConcentration(paperTrades, row.symbol);
    if (!sectorCheck.ok) { setApprovalMessage(sectorCheck.reason!); return; }
    // Stale entry filter
    const plan = effectiveTradePlan(row, settings);
    if (plan) {
      const tradeDir = row.primaryStrategy?.direction ?? row.direction;
      const risk = Math.abs(plan.entry - plan.stop);
      if (tradeDir === 'BULL' && row.price > plan.entry + risk * 0.5) {
        setApprovalMessage(`Stale entry: price moved $${(row.price - plan.entry).toFixed(2)} past entry — skipped.`);
        return;
      }
      if (tradeDir === 'BEAR' && row.price < plan.entry - risk * 0.5) {
        setApprovalMessage(`Stale entry: price moved $${(plan.entry - row.price).toFixed(2)} past entry — skipped.`);
        return;
      }
      const approxNotional = computeNotional(accountBalance, plan.entry, plan.stop, row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED', row.primaryStrategy?.groupSizeMult ?? 1.0);
      const betaPortCheck = checkPortfolioBeta(paperTrades, row.beta ?? 1.0, approxNotional, accountBalance);
      if (!betaPortCheck.ok) { setApprovalMessage(betaPortCheck.reason!); return; }
    }
    const trade = buildPaperTrade(row, settings, paperTrades, new Date().toISOString(), accountBalance, snapshot?.spyTrend5m, snapshot?.spyTrend15m, groupCbCheck.sizeMult);
    if (!trade) {
      const plan = effectiveTradePlan(row, settings);
      if (!plan) {
        setApprovalMessage('Paper trade blocked: entry, stop, or target is not valid.');
      } else if (plan.rr < 1.5) {
        setApprovalMessage(`Paper trade blocked: R:R is ${plan.rr.toFixed(2)}, minimum is 1.50.`);
      } else {
        setApprovalMessage('Paper trade blocked: trading amount limit has been reached.');
      }
      return;
    }
    const symbolKey = baseSymbol(row.symbol);
    if (paperTrades.some((item) => item.status === 'Open' && baseSymbol(item.symbol) === symbolKey)) {
      setApprovalMessage(`Paper trade already open for ${row.symbol}.`);
      return;
    }
    const manualStratId = row.primaryStrategy?.strategyId ?? '';
    const manualStratDir = row.primaryStrategy?.direction ?? row.direction;
    if (manualStratId && stoppedTodaySet.has(`${symbolKey}|${manualStratId}|${manualStratDir}`)) {
      setApprovalMessage(`${row.symbol} ${manualStratId.toUpperCase()} ${manualStratDir} stopped out today — same strategy re-entry blocked till EOD.`);
      return;
    }
    const earningsNote = row.earningsDays !== null && Math.abs(row.earningsDays) <= 1
      ? ` ⚠ ${row.earningsStatus}` : '';
    setPaperTrades((current) => [trade, ...current]);
    setApprovalMessage(`Paper trade opened for ${row.symbol}: entry ${fmtMoney(trade.entry)}, stop ${fmtMoney(trade.stop)}, T1 ${fmtMoney(trade.target1)}, T2 ${fmtMoney(trade.target2)}.${earningsNote}`);
    // Mirror to Alpaca paper account for realistic fill tracking (fire-and-forget)
    placePaperBracketOrder({ symbol: row.symbol, direction: row.direction === 'BEAR' ? 'BEAR' : 'BULL', entry: trade.entry, stop: trade.stop, target: trade.target, notional: trade.notional })
      .catch((err: unknown) => console.warn('Alpaca paper order skipped:', err instanceof Error ? err.message : err));
  }

  function clearClosedTrades() {
    setPaperTrades((current) => current.filter((t) => t.status === 'Open'));
  }

  function fixZeroPnlTrades() {
    setPaperTrades((current) => current.map((trade) => {
      if (trade.status !== 'Closed') return trade;
      // Fix $0 pnl
      if (!trade.pnl || trade.pnl === 0) {
        const exitPrice = estimatedExitPrice(trade);
        const { pnl, pnlPercent } = paperPnl(trade, exitPrice);
        return { ...trade, exitPrice, pnl, pnlPercent };
      }
      // Fix negative T1 Profit — floor exit at trailing stop (stored before the floor fix)
      if (trade.outcome === 'T1 Profit' && trade.pnl < 0) {
        const ts = trade.trailingStop || trade.target1 || trade.stop;
        const exitPrice = trade.direction === 'BULL'
          ? Math.max(trade.exitPrice ?? ts, ts)
          : Math.min(trade.exitPrice ?? ts, ts);
        const { pnl, pnlPercent } = paperPnl(trade, exitPrice);
        return { ...trade, exitPrice, pnl, pnlPercent };
      }
      return trade;
    }));
  }

  function manualClosePaperTrade(trade: PaperTrade, price: number) {
    const closed = closePaperTrade(trade, price, 'Manual');
    setPaperTrades((current) => current.map((item) => item.id === trade.id ? closed : item));
    if (closed.pnl !== undefined) {
      recordTradeResult(trade.strategyName, closed.pnl, accountBalance);
      recordGroupTradeResult(trade.signalGroup ?? 'UNCLASSIFIED', closed.pnl);
    }
    closePaperPosition(trade.symbol).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setApprovalMessage(`Alpaca close failed for ${trade.symbol}: ${msg}`);
    });
  }

  return (
    <div className="flex-1 flex flex-col gap-5 min-h-0">
      {/* === Trading HUD — critical session metrics === */}
      {(() => {
        const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const todayClosed = paperTrades.filter((t) => t.status === 'Closed' && new Date(t.openedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET);
        const todayWins = todayClosed.filter((t) =>
          t.outcome === 'Target' || t.outcome === 'T1 Profit' ||
          ((t.outcome === 'Manual' || t.outcome === 'EOD') && (t.pnl ?? 0) > 0)
        ).length;
        const todayLosses = todayClosed.filter((t) =>
          t.outcome === 'Stop' ||
          ((t.outcome === 'Manual' || t.outcome === 'EOD') && (t.pnl ?? 0) <= 0)
        ).length;
        const priceMap = new Map(rows.map((r) => [baseSymbol(r.symbol), r.price]));
        const openTrades = paperTrades.filter((t) => t.status === 'Open');
        const openPnl = openTrades.reduce((sum, t) => {
          const px = priceMap.get(baseSymbol(t.symbol)) ?? t.entry;
          return sum + paperPnl(t, px).pnl;
        }, 0);
        const closedPnl = todayClosed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
        const hudPnl = closedPnl + openPnl;
        const totalClosed = todayWins + todayLosses;
        const wr = totalClosed > 0 ? Math.round((todayWins / totalClosed) * 100) : 0;
        const riskSummary = getRiskSummary();
        const usedRisk = Math.max(0, -riskSummary.dailyPnl);
        const riskPct = riskSummary.dailyLossLimit > 0 ? Math.min(100, (usedRisk / riskSummary.dailyLossLimit) * 100) : 0;
        const pausedStrats = cbTick >= 0 ? getPausedStrategies() : [];
        const etMins = etMinutesNow();
        const cutoffMins = 15 * 60 + 50;
        const minsLeft = cutoffMins - etMins;
        const scanAge = snapshot?.fetchedAt ? Math.floor((Date.now() - new Date(snapshot.fetchedAt).getTime()) / 1000) : 0;
        const tradeReadyCount = rows.filter((r) => r.workflowStage === 'trade_ready').length;
        const formingCount = rows.filter((r) => r.workflowStage === 'forming').length;
        const openNotional = openTrades.reduce((s, t) => s + (t.t1HitAt ? t.notional * 0.5 : t.notional), 0);
        const deployedPct = accountBalance > 0 ? Math.min(100, (openNotional / (accountBalance * 0.65)) * 100) : 0;
        const groupCbList = cbTick >= 0 ? getGroupCbSummary() : [];
        const vixLevel = snapshot?.regime?.vixLevel;
        return (
          <div className="shrink-0 rounded-xl border border-white/5 bg-white/[0.025] px-4 py-3 space-y-3">
            {/* Row 1: P&L · Record · Equity · SPY tide · VIX · Scan health */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Today P&L</p>
                <p className={`text-xl font-black font-mono tabular-nums leading-none ${hudPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {hudPnl >= 0 ? '+' : ''}{hudPnl.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Record</p>
                <p className="text-sm font-mono leading-none">
                  <span className="text-emerald-400 font-black">{todayWins}W</span>
                  <span className="text-slate-600 mx-1">/</span>
                  <span className="text-rose-400 font-black">{todayLosses}L</span>
                  {totalClosed > 0 && <span className="text-slate-400 text-xs ml-2">{wr}% WR</span>}
                </p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Equity</p>
                <p className="text-sm font-mono font-bold text-white leading-none">${accountBalance.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">SPY Tide</p>
                <p className="text-sm font-mono font-black leading-none">
                  <span className={snapshot?.spyTrend5m === 'UP' ? 'text-emerald-400' : snapshot?.spyTrend5m === 'DOWN' ? 'text-rose-400' : 'text-slate-400'}>
                    5m {snapshot?.spyTrend5m ?? '--'}
                  </span>
                  <span className="text-slate-600 mx-1">·</span>
                  <span className={snapshot?.spyTrend15m === 'UP' ? 'text-emerald-400' : snapshot?.spyTrend15m === 'DOWN' ? 'text-rose-400' : 'text-slate-400'}>
                    15m {snapshot?.spyTrend15m ?? '--'}
                  </span>
                </p>
              </div>
              {vixLevel != null && (
                <div>
                  <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">VIX</p>
                  <p className={`text-sm font-mono font-black leading-none ${vixLevel > 28 ? 'text-rose-400' : vixLevel > 22 ? 'text-amber-400' : 'text-emerald-400'}`}>
                    {vixLevel.toFixed(1)}
                  </p>
                </div>
              )}
              <div className="ml-auto text-right">
                <p className="text-[9px] uppercase tracking-widest text-slate-500 font-black">Scan Health</p>
                <p className="text-xs font-mono text-slate-300 leading-none">
                  {formingCount} forming ·{' '}
                  <span className={tradeReadyCount > 0 ? 'text-emerald-400 font-black' : 'text-slate-400'}>
                    {tradeReadyCount} ready
                  </span>
                  {pendingConfirmCount > 0 && (
                    <span className="text-amber-400 font-black"> · {pendingConfirmCount} confirming</span>
                  )}
                  {' '}· {scanAge}s ago
                </p>
              </div>
            </div>

            {/* Row 2: Daily risk · Capital deployed · Group CB · Entry cutoff */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="min-w-[140px] max-w-[180px]">
                <div className="flex justify-between text-[9px] uppercase tracking-widest font-black mb-1">
                  <span className="text-slate-500">Daily Risk</span>
                  <span className={riskPct > 80 ? 'text-rose-400' : riskPct > 50 ? 'text-amber-400' : 'text-slate-400'}>
                    ${usedRisk.toFixed(0)} / ${riskSummary.dailyLossLimit.toFixed(0)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${riskPct > 80 ? 'bg-rose-500' : riskPct > 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${riskPct}%` }} />
                </div>
              </div>
              <div className="min-w-[140px] max-w-[180px]">
                <div className="flex justify-between text-[9px] uppercase tracking-widest font-black mb-1">
                  <span className="text-slate-500">Capital Deployed</span>
                  <span className={deployedPct > 80 ? 'text-amber-400' : 'text-slate-400'}>
                    ${openNotional.toFixed(0)} / ${(accountBalance * 0.65).toFixed(0)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${deployedPct > 80 ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${deployedPct}%` }} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {groupCbList.length > 0 ? (
                  <>
                    <span className="text-[9px] uppercase tracking-widest text-rose-400 font-black">Group CB:</span>
                    {groupCbList.map((g) => (
                      <span key={g.group} className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-black uppercase ${g.layer === 1 ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : g.layer === 2 ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                        {g.group} L{g.layer} · {g.detail}
                        {(g.layer === 1 || g.layer === 2) && (
                          <button onClick={() => { unpauseGroupCb(g.group); setCbTick((t) => t + 1); }} className="ml-0.5 hover:text-white leading-none" title="Reset group CB">✕</button>
                        )}
                      </span>
                    ))}
                  </>
                ) : pausedStrats.length > 0 ? (
                  <>
                    <span className="text-[9px] uppercase tracking-widest text-rose-400 font-black">CB:</span>
                    {pausedStrats.map((s) => (
                      <span key={s.name} className="flex items-center gap-1 px-2 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 text-rose-300 text-[9px] font-black uppercase">
                        {STRATEGY_LABELS[s.name as StrategyId] ?? s.name} {s.minsLeft}m
                        <button onClick={() => { unpauseCbStrategy(s.name); setCbTick((t) => t + 1); }} className="ml-0.5 hover:text-white leading-none">✕</button>
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="text-[9px] uppercase tracking-widest text-emerald-400 font-black">● All groups active</span>
                )}
              </div>
              {!stale && etMins >= 15 * 60 && minsLeft > 0 && (
                <span className="ml-auto px-3 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[10px] font-black uppercase tracking-widest">
                  Entry closes in {minsLeft}m
                </span>
              )}
              {!stale && etMins >= cutoffMins && etMins < 16 * 60 + 35 && (
                <span className="ml-auto px-3 py-1 rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-300 text-[10px] font-black uppercase tracking-widest">
                  Entry cutoff — EOD in {Math.max(0, 15 * 60 + 57 - etMins)}m
                </span>
              )}
            </div>

            {/* Row 3: Live positions strip — group · symbol · notional · P&L */}
            {openTrades.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 border-t border-white/5">
                <span className="text-[9px] uppercase tracking-widest text-slate-500 font-black shrink-0">Live:</span>
                {openTrades.map((t) => {
                  const px = priceMap.get(baseSymbol(t.symbol)) ?? t.entry;
                  const { pnl } = paperPnl(t, px);
                  const up = pnl >= 0;
                  return (
                    <span key={t.id} className="flex items-center gap-1.5">
                      {t.signalGroup && t.signalGroup !== 'UNCLASSIFIED' && (
                        <span className={`px-1.5 py-0.5 rounded border text-[8px] font-black uppercase ${GROUP_COLORS[t.signalGroup]}`}>{t.signalGroup}</span>
                      )}
                      <span className={`text-[11px] font-mono font-black tabular-nums ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {baseSymbol(t.symbol)} {up ? '▲' : '▼'} {pnl >= 0 ? '+' : ''}${Math.abs(pnl).toFixed(2)}
                      </span>
                      <span className="text-[9px] text-slate-500 font-mono">${t.notional.toFixed(0)} · {t.quantity.toFixed(2)}sh</span>
                      {t.t1HitAt && <span className="text-[8px] font-black text-cyan-400 uppercase">T1✓</span>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      <div className="flex flex-wrap items-start justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">ProTrade Workflow</h2>
          <p className="mt-2 text-xs text-slate-300 max-w-4xl leading-relaxed">
            Tickers move from screened universe → forming → confirmed → trade ready → ordered. Data from Alpaca IEX (live). Paper trades auto-open when a setup reaches Trade Ready and are mirrored to your Alpaca paper account.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-widest font-black">
            <span className={`px-3 py-1 rounded-full border ${stale ? 'border-amber-500/30 text-amber-300 bg-amber-500/10' : 'border-emerald-500/20 text-emerald-300 bg-emerald-500/10'}`}>
              {snapshot ? `Last refreshed ${lastUpdated?.toLocaleTimeString()}` : 'Loading'}
            </span>
            <span className="px-3 py-1 rounded-full border border-cyan-500/20 text-cyan-300 bg-cyan-500/10">
              Provider: Alpaca IEX
            </span>
            <span className="px-3 py-1 rounded-full border border-violet-500/20 text-violet-300 bg-violet-500/10">
              Screened Universe: {snapshot?.universeBuiltAt ? `locked ${toETTime(snapshot.universeBuiltAt)} ET` : 'pending 8:30 AM ET'}
            </span>
            {watchlist.symbols.length > 0 && (
              <span className="px-3 py-1 rounded-full border border-amber-500/30 text-amber-300 bg-amber-500/10">
                ★ Watchlist: {watchlist.symbols.length} stocks locked
              </span>
            )}
            <span className="px-3 py-1 rounded-full border border-slate-600/40 text-slate-400 bg-slate-800/30">
              Auto refresh: {activeStage === 'forming' || activeStage === 'confirmed' || activeStage === 'locked' || activeStage === 'trade_ready' ? '15s hot set' : '60s'}
            </span>
            <span className="px-3 py-1 rounded-full border border-slate-600/40 text-slate-400 bg-slate-800/30">
              SPY Tide: <span className={`font-black ${snapshot?.spyTrend5m === 'UP' ? 'text-emerald-400' : snapshot?.spyTrend5m === 'DOWN' ? 'text-rose-400' : 'text-slate-300'}`}>{snapshot?.spyTrend5m || 'FLAT'}</span>
            </span>
            {snapshot?.regime && (
              <span className={`px-3 py-1 rounded-full border text-xs font-semibold ${snapshot.regime.regime === 'BULL' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : snapshot.regime.regime === 'BEAR' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}>
                Regime: {snapshot.regime.regime}
                {snapshot.regime.spyEma200 ? ` · SPY ${snapshot.regime.spyPrice?.toFixed(0)} / EMA200 ${snapshot.regime.spyEma200.toFixed(0)}` : ''}
                {snapshot.regime.vixLevel ? ` · VIX ${snapshot.regime.vixLevel.toFixed(1)}` : ''}
              </span>
            )}
            {(() => {
              const mins = etMinutesNow();
              const cutoff = mins >= 15 * 60 + 50;
              const lossLimitHit = !checkDailyLossLimit(accountBalance).ok;
              if (stale) return <span className="px-3 py-1 rounded-full border border-slate-600/40 text-slate-400 bg-slate-800/30">Auto-order: Market Closed</span>;
              if (lossLimitHit) return <span className="px-3 py-1 rounded-full border border-rose-500/30 text-rose-300 bg-rose-500/10">Auto-order: Daily Limit Hit</span>;
              if (cutoff) return <span className="px-3 py-1 rounded-full border border-amber-500/30 text-amber-300 bg-amber-500/10">Auto-order: Entry Cutoff 3:50 PM</span>;
              return <span className="px-3 py-1 rounded-full border border-emerald-500/20 text-emerald-300 bg-emerald-500/10">Auto-order: Active</span>;
            })()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (watchlist.symbols.length > 0) {
                setWatchlistOnly((v) => !v);
                if (!watchlistOnly) setViewMode('workflow');
              } else {
                lockWatchlist([...rows].sort((a, b) => b.confidence - a.confidence).slice(0, 10).map((r) => r.symbol));
              }
            }}
            disabled={!rows.length}
            className={`h-9 px-4 rounded-full border flex items-center gap-2 transition-colors disabled:opacity-40 ${watchlistOnly ? 'border-amber-500/60 bg-amber-500/25 text-amber-200' : watchlist.symbols.length > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20' : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'}`}
            title={watchlist.symbols.length > 0 ? (watchlistOnly ? 'Showing watchlist only — click to show all' : `Filter to ${watchlist.symbols.length} locked stocks`) : "Lock top 10 as today's watchlist"}
          >
            <span className="text-[11px]">★</span>
            <span className="text-[10px] font-black uppercase tracking-widest">
              {watchlist.symbols.length > 0 ? `Watchlist (${watchlist.symbols.length})${watchlistOnly ? ' ✓' : ''}` : 'Lock Watchlist'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="h-9 px-4 rounded-full border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 flex items-center gap-2 transition-colors"
          >
            <Settings size={14} />
            <span className="text-[10px] font-black uppercase tracking-widest">Settings</span>
          </button>
          <button
            onClick={() => void load(true)}
            disabled={manualLoading || loading}
            className="h-9 px-4 rounded-full border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-wait flex items-center gap-2 transition-colors"
          >
            <RefreshCcw size={14} className={manualLoading || loading ? 'animate-spin' : ''} />
            <span className="text-[10px] font-black uppercase tracking-widest">{manualLoading || loading ? 'Scanning' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      <div className="flex gap-1 shrink-0">
        <button
          type="button"
          onClick={() => setViewMode('premarket')}
          className={`h-8 px-4 rounded-lg border text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-colors ${viewMode === 'premarket' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-white/10 bg-white/5 text-slate-400 hover:text-white'}`}
        >
          <TrendingUp size={12} />
          Gap Scan
        </button>
        <button
          type="button"
          onClick={() => setViewMode('workflow')}
          className={`h-8 px-4 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-colors ${viewMode === 'workflow' ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' : 'border-white/10 bg-white/5 text-slate-400 hover:text-white'}`}
        >
          Workflow
        </button>
      </div>

      {viewMode === 'premarket' ? (
        <PremarketGapPanel
          rows={rows}
          watchlistSet={watchlistSet}
          onSelect={(row) => { setSelectedRow(row); setApprovalMessage(''); }}
          onLockWatchlist={lockWatchlist}
        />
      ) : (
        <>
          <div className="flex items-center gap-3 overflow-x-auto pb-1 scrollbar-none shrink-0">
            {WORKFLOW_STAGE_ORDER.map((stage) => (
              <StageTile
                key={stage}
                stage={stage}
                count={countRows(rows, stage, rawRows)}
                active={!watchlistOnly && activeStage === stage}
                onClick={() => {
                  setWatchlistOnly(false);
                  setActiveStage(stage);
                  setActiveStrategy('all');
                }}
              />
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 shrink-0">
            {strategyIds.map((strategy) => (
              <StrategyCard
                key={strategy}
                strategy={strategy}
                count={rows.filter((row) => row.strategySignals.some((signal) => signal.strategyId === strategy && signal.stage !== 'screened_universe')).length}
                active={activeStrategy === strategy}
                onClick={() => setActiveStrategy((current) => current === strategy ? 'all' : strategy)}
              />
            ))}
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-300 px-4 py-3 text-xs font-bold">
              {error}
            </div>
          )}

          <WorkflowTable
            rows={filteredRows}
            selected={selected}
            reasonMode={activeStage === 'pro_watchlist' && activeStrategy === 'all' ? 'base' : 'strategy'}
            orderedTrades={activeStage === 'ordered' && activeStrategy === 'all' ? orderedPaperTrades : []}
            watchlistSet={watchlistSet}
            accountBalance={accountBalance}
            onSelect={(row) => { setSelectedRow(row); setApprovalMessage(''); }}
          />
        </>
      )}

      <PaperTradeMonitor
        trades={paperTrades}
        rows={rows}
        monitorDate={monitorDate}
        onMonitorDateChange={setMonitorDate}
        onCloseTrade={manualClosePaperTrade}
        onClearClosed={clearClosedTrades}
        onFixZeroPnl={fixZeroPnlTrades}
        eodMessage={eodMessage}
      />

      <WatchlistHistoryPanel />

      <DecisionPanel
        row={selected}
        busy={approvalBusy}
        message={approvalMessage}
        onClose={() => setSelectedRow(null)}
        onApprove={(row) => void approve(row)}
        onPaperTrade={createPaperTrade}
        onChart={(row) => {
          setChartInterval('5');
          setChartRow(row);
        }}
      />

      {chartRow && (
        <TradingViewChartModal
          signal={rowToSignal(chartRow)}
          interval={chartInterval}
          onIntervalChange={setChartInterval}
          onClose={() => setChartRow(null)}
        />
      )}

      {settingsOpen && (
        <ProTradeSettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
function isTideBlocked(
  row: ProTradeRow,
  spyTrend5m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  spyTrend15m: 'UP' | 'DOWN' | 'FLAT' | undefined,
  sig?: ProTradeRow['primaryStrategy'],
): boolean {
  if (!sig) return false;

  const strategyId = sig.strategyId;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest' || strategyId === 'mss_breakout';
  if (isReversal) return false;

  // S1 ORB: flat 5m tape → no directional context for a breakout
  if (spyTrend5m === 'FLAT' && strategyId === 'orb_retest') return true;

  // S2/S3: block only when BOTH tides oppose self-direction.
  // One tide opposing → reduce size (handled in buildPaperTrade).
  // 5m counter + 15m aligned for S2/S3 is an RS signal → full size, never blocked.
  const BOTH_TIDE_BLOCK = new Set(['vwap_pullback', 'rs_continuation']);
  if (BOTH_TIDE_BLOCK.has(strategyId)) {
    const tradeDir = sig.direction;
    if (tradeDir === 'NEUTRAL') return false;
    // If either tide is absent or flat, one-tide rule applies — don't block
    if (!spyTrend5m || spyTrend5m === 'FLAT' || !spyTrend15m || spyTrend15m === 'FLAT') return false;
    const counter5m = (tradeDir === 'BULL' && spyTrend5m === 'DOWN') || (tradeDir === 'BEAR' && spyTrend5m === 'UP');
    const counter15m = (tradeDir === 'BULL' && spyTrend15m === 'DOWN') || (tradeDir === 'BEAR' && spyTrend15m === 'UP');
    return counter5m && counter15m;
  }

  return false;
}
