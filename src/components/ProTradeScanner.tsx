import React from 'react';
import { BarChart3, CheckCircle2, ChevronDown, Eye, RefreshCcw, Settings, ShieldCheck, X } from 'lucide-react';
import { fetchTrading212Snapshot, placeTrading212DemoBracketOrder } from '../features/brokers/trading212LiveApi';
import { fetchProTradeScannerSnapshot, type ProTradeRow, type ProTradeSnapshot } from '../features/protrade/proTradeScannerApi';
import {
  STRATEGY_CODES,
  STRATEGY_LABELS,
  WORKFLOW_STAGE_LABELS,
  WORKFLOW_STAGE_ORDER,
  type StrategyId,
  type WorkflowStage,
} from '../features/protrade/workflowTypes';
import { baseSymbol } from '../lib/symbols';
import { ProTradeCandlePreview } from './ProTradeCandlePreview';
import { TradingViewChartModal, type TradingViewInterval } from './TradingViewChart';
import type { Signal, Trading212Snapshot } from '../types';

type StageFilter = WorkflowStage;

const PAPER_TRADES_STORAGE_KEY = 'sutra.protrade.paperTrades.v1';
const PROTRADE_SETTINGS_STORAGE_KEY = 'sutra.protrade.settings.v1';
const PAPER_NOTIONAL = 100;

interface ProTradeSettings {
  maxPerOrder: number;
  tradingAmount: number;
  tradingAmountPct: number;
  targetPct: number;
  stopLossPct: number;
}

const DEFAULT_PROTRADE_SETTINGS: ProTradeSettings = {
  maxPerOrder: PAPER_NOTIONAL,
  tradingAmount: 0,
  tradingAmountPct: 100,
  targetPct: 0,
  stopLossPct: 0,
};

interface PaperTrade {
  id: string;
  symbol: string;
  company: string;
  strategyId: StrategyId | null;
  strategyCode: string;
  strategyName: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'Stop' | 'Manual';
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
}

const STAGE_TONES: Record<WorkflowStage, string> = {
  raw_candidates: 'border-slate-600/40 bg-slate-800/30 text-slate-300',
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

function loadProTradeSettings() {
  if (typeof window === 'undefined') return DEFAULT_PROTRADE_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROTRADE_SETTINGS_STORAGE_KEY) || '{}') as Partial<ProTradeSettings>;
    return {
      maxPerOrder: Number(parsed.maxPerOrder || DEFAULT_PROTRADE_SETTINGS.maxPerOrder),
      tradingAmount: Number(parsed.tradingAmount || 0),
      tradingAmountPct: Number(parsed.tradingAmountPct || DEFAULT_PROTRADE_SETTINGS.tradingAmountPct),
      targetPct: Number(parsed.targetPct || 0),
      stopLossPct: Number(parsed.stopLossPct || 0),
    };
  } catch {
    return DEFAULT_PROTRADE_SETTINGS;
  }
}

function saveProTradeSettings(settings: ProTradeSettings) {
  window.localStorage.setItem(PROTRADE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function normalizeSettingNumber(value: number, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function fmtMoney(value?: number | null) {
  return value && Number.isFinite(value) ? `$${value.toFixed(2)}` : '--';
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
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest font-black border ${
            signal.strategyId === row.primaryStrategy?.strategyId ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200' : STAGE_TONES[signal.stage]
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
    broker: 'Trading212',
    orderStatus: row.workflowStage === 'ordered' ? 'Open Position' : '-',
    reason: row.primaryStrategy?.reason || row.reason,
    riskSize: row.tradePlan?.riskSize,
  };
}

function buildOrderedSymbols(snapshot: Trading212Snapshot | null) {
  const symbols = new Set<string>();
  (snapshot?.positions || []).forEach((position) => symbols.add(baseSymbol(position.symbol)));
  (snapshot?.orders || []).forEach((order) => symbols.add(baseSymbol(order.symbol)));
  return symbols;
}

function withOrderedStage(rows: ProTradeRow[], orderedSymbols: Set<string>, paperTrades: PaperTrade[] = []) {
  const paperSymbols = new Set(paperTrades.filter((trade) => trade.status === 'Open').map((trade) => baseSymbol(trade.symbol)));
  return rows.map((row) => (
    orderedSymbols.has(baseSymbol(row.symbol)) || paperSymbols.has(baseSymbol(row.symbol))
      ? { ...row, workflowStage: 'ordered' as WorkflowStage }
      : row
  ));
}

function countRows(rows: ProTradeRow[], stage: WorkflowStage, rawRows: ProTradeRow[]) {
  if (stage === 'raw_candidates') return rawRows.length;
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
  return {
    ...trade,
    status: 'Closed',
    outcome,
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
  let changed = false;
  const next = trades.map((trade) => {
    if (trade.status !== 'Open') return trade;
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
    if (!trade.t1HitAt && hitT1) {
      changed = true;
      return {
        ...trade,
        t1HitAt: new Date().toISOString(),
        trailingStop: target1,
      };
    }
    if (hitStop) {
      changed = true;
      return closePaperTrade(trade, trailingStop, trade.t1HitAt ? 'Target' : 'Stop');
    }
    return trade;
  });
  return { trades: next, changed };
}

function effectiveTradePlan(row: ProTradeRow, settings: ProTradeSettings) {
  if (!row.tradePlan || row.tradePlan.entry <= 0 || row.direction === 'NEUTRAL') return null;
  const entry = row.tradePlan.entry;
  const stop = settings.stopLossPct > 0
    ? row.direction === 'BEAR'
      ? entry * (1 + settings.stopLossPct / 100)
      : entry * (1 - settings.stopLossPct / 100)
    : row.tradePlan.stop;
  const target = settings.targetPct > 0
    ? row.direction === 'BEAR'
      ? entry * (1 - settings.targetPct / 100)
      : entry * (1 + settings.targetPct / 100)
    : row.tradePlan.target;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const target1 = row.direction === 'BEAR' ? entry - risk * 2 : entry + risk * 2;
  const target2 = row.direction === 'BEAR' ? Math.min(target, target1) : Math.max(target, target1);
  const reward = Math.abs(target2 - entry);
  if (reward <= 0) return null;
  return {
    ...row.tradePlan,
    stop: Number(stop.toFixed(2)),
    target: Number(target2.toFixed(2)),
    target1: Number(target1.toFixed(2)),
    target2: Number(target2.toFixed(2)),
    rr: Number((reward / risk).toFixed(2)),
    rr1: 2,
    riskPerShare: Number(risk.toFixed(2)),
  };
}

function availablePaperNotional(settings: ProTradeSettings, trades: PaperTrade[]) {
  const maxPerOrder = settings.maxPerOrder > 0 ? settings.maxPerOrder : PAPER_NOTIONAL;
  if (settings.tradingAmount <= 0) return maxPerOrder;
  const usablePct = settings.tradingAmountPct > 0 ? Math.min(settings.tradingAmountPct, 100) : 100;
  const usableAmount = settings.tradingAmount * usablePct / 100;
  const openNotional = trades
    .filter((trade) => trade.status === 'Open')
    .reduce((total, trade) => total + trade.notional, 0);
  return Math.min(maxPerOrder, Math.max(0, usableAmount - openNotional));
}

function canPaperTradeRow(row: ProTradeRow, settings: ProTradeSettings = DEFAULT_PROTRADE_SETTINGS, trades: PaperTrade[] = []) {
  const plan = effectiveTradePlan(row, settings);
  return Boolean(plan && plan.rr >= 1.8 && availablePaperNotional(settings, trades) > 0);
}

function buildPaperTrade(row: ProTradeRow, settings: ProTradeSettings, currentTrades: PaperTrade[] = [], openedAt = new Date().toISOString()): PaperTrade | null {
  const plan = effectiveTradePlan(row, settings);
  if (!plan || plan.rr < 1.8) return null;
  const notional = availablePaperNotional(settings, currentTrades);
  if (notional <= 0) return null;
  const strategyId = row.primaryStrategy?.strategyId || null;
  const quantity = notional / plan.entry;
  return {
    id: `paper-${row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: row.symbol,
    company: row.company,
    strategyId,
    strategyCode: strategyId ? STRATEGY_CODES[strategyId] : 'NA',
    strategyName: row.primaryStrategy?.strategyName || 'Manual Paper',
    direction: row.direction,
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
    reason: row.primaryStrategy?.reason || row.reason,
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
              ['Beta', row.beta ? `${row.beta.toFixed(2)} / ${row.betaMax.toFixed(1)}` : '--'],
              ['Mkt Cap', row.mktCapB ? `$${row.mktCapB.toFixed(1)}B` : 'N/A'],
              ['$ Vol', row.dollarVolM ? `$${row.dollarVolM.toFixed(1)}M` : '--'],
              ['RS', row.rsVsBenchmark ? row.rsVsBenchmark.toFixed(3) : '--'],
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
}: {
  rows: ProTradeRow[];
  selected: ProTradeRow | null;
  onSelect: (row: ProTradeRow) => void;
  reasonMode?: 'strategy' | 'base';
  orderedTrades?: PaperTrade[];
}) {
  const [expandedSymbol, setExpandedSymbol] = React.useState<string | null>(null);
  const orderedTradeBySymbol = new Map(orderedTrades.map((trade) => [baseSymbol(trade.symbol), trade]));
  const orderedMode = orderedTrades.length > 0;
  return (
    <div className="glass rounded-xl overflow-hidden min-h-[420px]">
      <div className="p-3 border-b border-white/5 bg-white/5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-emerald-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Workflow Results</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{rows.length} tickers</span>
        </div>
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[1180px] text-left border-collapse">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50 sticky top-0 z-10">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5">Ticker / Company</th>
              <th className="py-2.5 px-3 border-r border-white/5">Stage</th>
              <th className="py-2.5 px-3 border-r border-white/5">Primary Strategy</th>
              <th className="py-2.5 px-3 border-r border-white/5">Strategies Passed</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Entry</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Stop</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T1</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T2</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">R:R</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Confidence</th>
              {orderedMode && (
                <>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Qty</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Current</th>
                  <th className="py-2.5 px-3 border-r border-white/5 text-right">Submitted Value</th>
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
            {rows.map((row) => {
              const rowKey = `${row.sourceBucket}-${row.symbol}-${row.workflowStage}`;
              const expanded = expandedSymbol === rowKey;
              const orderedTrade = orderedTradeBySymbol.get(baseSymbol(row.symbol));
              const currentPrice = row.price || orderedTrade?.exitPrice || orderedTrade?.entry || 0;
              const livePnl = orderedTrade ? (orderedTrade.status === 'Open' ? paperPnl(orderedTrade, currentPrice) : { pnl: orderedTrade.pnl || 0, pnlPercent: orderedTrade.pnlPercent || 0 }) : null;
              return (
                <React.Fragment key={rowKey}>
                  <tr className={`border-b border-white/5 hover:bg-white/5 ${selected?.symbol === row.symbol ? 'bg-indigo-500/10' : ''}`}>
                    <td className="py-3 px-3 border-r border-white/5 min-w-[230px]">
                      <div className="font-black text-white text-[13px]">{row.symbol}</div>
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
                    <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(row.tradePlan?.entry)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-rose-300">{fmtMoney(row.tradePlan?.stop)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-cyan-300">{fmtMoney(row.tradePlan?.target1 || row.tradePlan?.target)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-emerald-300">{fmtMoney(row.tradePlan?.target2 || row.tradePlan?.target)}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-slate-200">{row.tradePlan ? row.tradePlan.rr.toFixed(2) : '--'}</td>
                    <td className="py-3 px-3 border-r border-white/5 text-right text-indigo-300 font-black">{row.confidence || '--'}</td>
                    {orderedMode && (
                      <>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade ? orderedTrade.quantity.toFixed(4) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-white">{orderedTrade ? fmtMoney(currentPrice) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade ? fmtMoney(orderedTrade.notional) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-slate-400">{orderedTrade ? new Date(orderedTrade.openedAt).toLocaleString() : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{orderedTrade?.exitPrice ? fmtMoney(orderedTrade.exitPrice) : '--'}</td>
                        <td className="py-3 px-3 border-r border-white/5 text-slate-400">{orderedTrade?.closedAt ? new Date(orderedTrade.closedAt).toLocaleString() : '--'}</td>
                        <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${(livePnl?.pnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {livePnl ? `${livePnl.pnl >= 0 ? '+' : ''}$${livePnl.pnl.toFixed(2)}` : '--'}
                        </td>
                        <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${(livePnl?.pnlPercent || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {livePnl ? `${livePnl.pnlPercent >= 0 ? '+' : ''}${livePnl.pnlPercent.toFixed(2)}%` : '--'}
                        </td>
                      </>
                    )}
                    <td className="py-3 px-3 border-r border-white/5 text-slate-400 min-w-[280px]">{reasonMode === 'base' ? row.baseReason : row.primaryStrategy?.reason || row.reason}</td>
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
                      <td colSpan={orderedMode ? 21 : 13} className="p-4">
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
      </div>
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
  const canPaperTrade = Boolean(row.tradePlan && row.tradePlan.rr >= 1.8);
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
              title={canPaperTrade ? 'Create simulated paper bracket' : 'Paper trade needs a valid trade plan and R:R >= 1.8'}
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

function PaperTradeMonitor({
  trades,
  rows,
  onCloseTrade,
}: {
  trades: PaperTrade[];
  rows: ProTradeRow[];
  onCloseTrade: (trade: PaperTrade, price: number) => void;
}) {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const open = trades.filter((trade) => trade.status === 'Open');
  const closed = trades.filter((trade) => trade.status === 'Closed');
  const totalPnl = trades.reduce((total, trade) => total + (trade.pnl || 0), 0);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="p-3 border-b border-white/5 bg-white/5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-cyan-500 rounded-full" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Paper Trade Monitor</h2>
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{open.length} open / {closed.length} closed</span>
        </div>
        <span className={`text-xs font-black ${totalPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
          Total P&L {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
        </span>
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[1120px] text-left border-collapse">
          <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-slate-900/50">
            <tr>
              <th className="py-2.5 px-3 border-r border-white/5">Opened</th>
              <th className="py-2.5 px-3 border-r border-white/5">Symbol</th>
              <th className="py-2.5 px-3 border-r border-white/5">Strategy</th>
              <th className="py-2.5 px-3 border-r border-white/5">Dir</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Entry</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Current/Exit</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Stop</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T1</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">T2</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Trail</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">Qty</th>
              <th className="py-2.5 px-3 border-r border-white/5">Status</th>
              <th className="py-2.5 px-3 border-r border-white/5 text-right">P&L</th>
              <th className="py-2.5 px-3">Action</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {trades.map((trade) => {
              const current = priceBySymbol.get(baseSymbol(trade.symbol)) || trade.exitPrice || trade.entry;
              const livePnl = trade.status === 'Open' ? paperPnl(trade, current) : { pnl: trade.pnl || 0, pnlPercent: trade.pnlPercent || 0 };
              return (
                <tr key={trade.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3 px-3 border-r border-white/5 text-slate-400">{new Date(trade.openedAt).toLocaleTimeString()}</td>
                  <td className="py-3 px-3 border-r border-white/5">
                    <div className="font-black text-white">{trade.symbol}</div>
                    <div className="text-[10px] text-slate-500 uppercase truncate max-w-[160px]">{trade.company}</div>
                  </td>
                  <td className="py-3 px-3 border-r border-white/5 text-slate-300">{trade.strategyCode} {trade.strategyName}</td>
                  <td className={`py-3 px-3 border-r border-white/5 font-black ${trade.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{trade.direction}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(trade.entry)}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-white">{fmtMoney(current)}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-rose-300">{fmtMoney(trade.stop)}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-cyan-300">{fmtMoney(paperTarget1(trade))}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-emerald-300">{fmtMoney(paperTarget2(trade))}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-amber-300">{fmtMoney(paperTrailingStop(trade))}</td>
                  <td className="py-3 px-3 border-r border-white/5 text-right text-slate-300">{trade.quantity.toFixed(4)}</td>
                  <td className="py-3 px-3 border-r border-white/5">
                    <span className={`px-2 py-1 rounded border text-[10px] uppercase tracking-widest font-black ${trade.status === 'Open' ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300' : trade.outcome === 'Target' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>
                      {trade.status === 'Open' ? (trade.t1HitAt ? 'T1 Hit' : 'Open') : trade.outcome}
                    </span>
                  </td>
                  <td className={`py-3 px-3 border-r border-white/5 text-right font-black ${livePnl.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {livePnl.pnl >= 0 ? '+' : ''}${livePnl.pnl.toFixed(2)} ({livePnl.pnlPercent >= 0 ? '+' : ''}{livePnl.pnlPercent.toFixed(2)}%)
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
                      <span className="text-slate-600">{trade.closedAt ? new Date(trade.closedAt).toLocaleTimeString() : '--'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!trades.length && (
          <div className="p-6 text-sm text-slate-500 text-center">No paper trades yet. Open a ticker review panel and click Paper.</div>
        )}
      </div>
    </div>
  );
}

function SettingsField({
  label,
  value,
  suffix,
  placeholder,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  placeholder?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-slate-500 font-black">{label}</span>
      <div className="mt-2 flex items-center rounded-xl border border-white/10 bg-black/20 overflow-hidden">
        <input
          type="number"
          min="0"
          step="0.01"
          value={value > 0 ? value : ''}
          placeholder={placeholder || 'System'}
          onChange={(event) => onChange(normalizeSettingNumber(Number(event.target.value)))}
          className="h-11 w-full bg-transparent px-3 text-sm text-white outline-none placeholder:text-slate-600"
        />
        {suffix && <span className="px-3 text-xs text-slate-500 font-black">{suffix}</span>}
      </div>
    </label>
  );
}

function ProTradeSettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: ProTradeSettings;
  onChange: (settings: ProTradeSettings) => void;
  onClose: () => void;
}) {
  const usableBudget = settings.tradingAmount > 0
    ? settings.tradingAmount * (settings.tradingAmountPct > 0 ? settings.tradingAmountPct : 100) / 100
    : 0;

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
            Blank target/stop fields use the system-calculated strategy levels. Enter percentages only when you want to override every paper order.
          </div>

          <div className="space-y-4">
            <SettingsField
              label="Max Amount Per Order"
              value={settings.maxPerOrder}
              suffix="$"
              placeholder={`${PAPER_NOTIONAL}`}
              onChange={(value) => onChange({ ...settings, maxPerOrder: value || PAPER_NOTIONAL })}
            />
            <SettingsField
              label="Total Trading Amount"
              value={settings.tradingAmount}
              suffix="$"
              placeholder="No cap"
              onChange={(value) => onChange({ ...settings, tradingAmount: value })}
            />
            <SettingsField
              label="% Of Trading Amount To Use"
              value={settings.tradingAmountPct}
              suffix="%"
              placeholder="100"
              onChange={(value) => onChange({ ...settings, tradingAmountPct: Math.min(value || 100, 100) })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <SettingsField
              label="Target Override"
              value={settings.targetPct}
              suffix="%"
              placeholder="System"
              onChange={(value) => onChange({ ...settings, targetPct: value })}
            />
            <SettingsField
              label="Stop Loss Override"
              value={settings.stopLossPct}
              suffix="%"
              placeholder="System"
              onChange={(value) => onChange({ ...settings, stopLossPct: value })}
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-black">Effective Rules</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-slate-500">Per order cap</p>
                <p className="font-mono text-white">{fmtMoney(settings.maxPerOrder || PAPER_NOTIONAL)}</p>
              </div>
              <div>
                <p className="text-slate-500">Usable budget</p>
                <p className="font-mono text-white">{usableBudget > 0 ? fmtMoney(usableBudget) : 'No cap'}</p>
              </div>
              <div>
                <p className="text-slate-500">Target</p>
                <p className="font-mono text-white">{settings.targetPct > 0 ? `${settings.targetPct}%` : 'System'}</p>
              </div>
              <div>
                <p className="text-slate-500">Stop loss</p>
                <p className="font-mono text-white">{settings.stopLossPct > 0 ? `${settings.stopLossPct}%` : 'System'}</p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="h-11 w-full rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
          >
            <span className="text-[10px] uppercase tracking-widest font-black">Save And Close</span>
          </button>
        </div>
      </section>
    </div>
  );
}

export function ProTradeScannerScreen() {
  const [snapshot, setSnapshot] = React.useState<ProTradeSnapshot | null>(null);
  const [brokerSnapshot, setBrokerSnapshot] = React.useState<Trading212Snapshot | null>(null);
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
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<ProTradeSettings>(() => loadProTradeSettings());

  async function load(manual = false) {
    try {
      if (manual) setManualLoading(true);
      else setLoading(true);
      setError('');
      const [nextSnapshot, nextBroker] = await Promise.all([
        fetchProTradeScannerSnapshot(),
        fetchTrading212Snapshot({ fast: true }).catch(() => null),
      ]);
      setSnapshot(nextSnapshot);
      setBrokerSnapshot(nextBroker);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setManualLoading(false);
    }
  }

  React.useEffect(() => {
    void load();
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void load();
    }, activeStage === 'forming' || activeStage === 'confirmed' || activeStage === 'locked' || activeStage === 'trade_ready' ? 15_000 : 60_000);
    return () => window.clearInterval(id);
  }, [activeStage]);

  const orderedSymbols = React.useMemo(() => buildOrderedSymbols(brokerSnapshot), [brokerSnapshot]);
  const rows = React.useMemo(() => withOrderedStage(snapshot?.rows || [], orderedSymbols, paperTrades), [snapshot?.rows, orderedSymbols, paperTrades]);
  const rawRows = snapshot?.rawRows || [];
  const proWatchlistRows = rows.filter((row) => row.basePass);
  const stageRows = activeStage === 'raw_candidates'
    ? rawRows
    : activeStage === 'pro_watchlist'
      ? proWatchlistRows
      : rows.filter((row) => row.workflowStage === activeStage);
  const filteredRows = activeStrategy === 'all'
    ? stageRows
    : rows.filter((row) => row.strategySignals.some((signal) => signal.strategyId === activeStrategy && signal.stage !== 'pro_watchlist'));
  const orderedPaperTrades = paperTrades.filter((trade) => baseSymbol(trade.symbol) && (trade.status === 'Open' || trade.status === 'Closed'));
  const selected = selectedRow ? withOrderedStage([selectedRow], orderedSymbols, paperTrades)[0] : null;
  const strategyIds = Object.keys(STRATEGY_LABELS) as StrategyId[];
  const lastUpdated = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : null;
  const stale = rows.some((row) => row.dataStatus.stale);

  React.useEffect(() => {
    savePaperTrades(paperTrades);
  }, [paperTrades]);

  React.useEffect(() => {
    saveProTradeSettings(settings);
  }, [settings]);

  React.useEffect(() => {
    if (!rows.length || !paperTrades.some((trade) => trade.status === 'Open')) return;
    const monitored = monitorPaperTrades(paperTrades, rows);
    if (monitored.changed) setPaperTrades(monitored.trades);
  }, [rows, paperTrades]);

  React.useEffect(() => {
    if (!snapshot?.rows.length) return;
    const lockedRows = snapshot.rows.filter((row) => row.workflowStage === 'locked' && canPaperTradeRow(row, settings, paperTrades));
    if (!lockedRows.length) return;
    const tradedSymbols = new Set(paperTrades.map((trade) => baseSymbol(trade.symbol)));
    const openedAt = new Date().toISOString();
    const autoTrades: PaperTrade[] = [];
    lockedRows.forEach((row) => {
      const symbolKey = baseSymbol(row.symbol);
      if (orderedSymbols.has(symbolKey) || tradedSymbols.has(symbolKey)) return;
      const trade = buildPaperTrade(row, settings, [...paperTrades, ...autoTrades], openedAt);
      if (!trade) return;
      autoTrades.push(trade);
      tradedSymbols.add(symbolKey);
    });

    if (!autoTrades.length) return;
    setPaperTrades((current) => [...autoTrades, ...current]);
    setApprovalMessage(`Auto paper opened ${autoTrades.length} locked setup(s): ${autoTrades.map((trade) => trade.symbol).join(', ')}.`);
  }, [snapshot?.rows, orderedSymbols, paperTrades, settings]);

  async function approve(row: ProTradeRow) {
    const plan = effectiveTradePlan(row, settings);
    if (!plan) return;
    try {
      setApprovalBusy(true);
      setApprovalMessage('');
      const result = await placeTrading212DemoBracketOrder({
        symbol: row.symbol,
        side: row.direction === 'BEAR' ? 'SELL' : 'BUY',
        entry: plan.entry,
        stopLoss: plan.stop,
        target1: plan.target,
        notional: settings.maxPerOrder || PAPER_NOTIONAL,
        dryRun: false,
      });
      setApprovalMessage(result.ok ? `Demo bracket submitted: ${result.orderId || 'order accepted'}` : result.error || 'Order failed');
      await load(true);
    } catch (err) {
      setApprovalMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovalBusy(false);
    }
  }

  function createPaperTrade(row: ProTradeRow) {
    const trade = buildPaperTrade(row, settings, paperTrades);
    if (!trade) {
      const plan = effectiveTradePlan(row, settings);
      if (!plan) {
        setApprovalMessage('Paper trade blocked: entry, stop, or target is not valid.');
      } else if (plan.rr < 1.8) {
        setApprovalMessage(`Paper trade blocked: R:R is ${plan.rr.toFixed(2)}, minimum is 1.80.`);
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
    setPaperTrades((current) => [trade, ...current]);
    setApprovalMessage(`Paper trade opened for ${row.symbol}: entry ${fmtMoney(trade.entry)}, stop ${fmtMoney(trade.stop)}, T1 ${fmtMoney(trade.target1)}, T2 ${fmtMoney(trade.target2)}.`);
  }

  function manualClosePaperTrade(trade: PaperTrade, price: number) {
    setPaperTrades((current) => current.map((item) => (
      item.id === trade.id ? closePaperTrade(item, price, 'Manual') : item
    )));
  }

  return (
    <div className="flex-1 flex flex-col gap-5 min-h-0">
      <div className="flex flex-wrap items-start justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">ProTrade Workflow</h2>
          <p className="mt-2 text-xs text-slate-500 max-w-4xl leading-relaxed">
            Tickers move from raw candidates into strategy forming, confirmed, locked, trade ready, and ordered. Yahoo is used as fallback screening data; Trade Ready remains blocked until a live provider is configured. Paper trading auto-opens when a setup reaches Locked.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-widest font-black">
            <span className={`px-3 py-1 rounded-full border ${stale ? 'border-amber-500/30 text-amber-300 bg-amber-500/10' : 'border-emerald-500/20 text-emerald-300 bg-emerald-500/10'}`}>
              {snapshot ? `Last refreshed ${lastUpdated?.toLocaleTimeString()}` : 'Loading'}
            </span>
            <span className="px-3 py-1 rounded-full border border-amber-500/20 text-amber-300 bg-amber-500/10">
              Provider: Yahoo fallback
            </span>
            <span className="px-3 py-1 rounded-full border border-slate-600/40 text-slate-400 bg-slate-800/30">
              Auto refresh: {activeStage === 'forming' || activeStage === 'confirmed' || activeStage === 'locked' || activeStage === 'trade_ready' ? '15s hot set' : '60s'}
            </span>
            <span className="px-3 py-1 rounded-full border border-cyan-500/20 text-cyan-300 bg-cyan-500/10">
              Paper auto-order: Locked
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
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

      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none shrink-0">
        {WORKFLOW_STAGE_ORDER.map((stage) => (
          <StageTile
            key={stage}
            stage={stage}
            count={countRows(rows, stage, rawRows)}
            active={activeStage === stage}
            onClick={() => {
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
            count={rows.filter((row) => row.strategySignals.some((signal) => signal.strategyId === strategy && signal.stage !== 'pro_watchlist')).length}
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
        onSelect={(row) => { setSelectedRow(row); setApprovalMessage(''); }}
      />

      <PaperTradeMonitor trades={paperTrades} rows={rows} onCloseTrade={manualClosePaperTrade} />

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
