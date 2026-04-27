import React from 'react';
import { Activity, AlertTriangle, BarChart, CheckCircle2, Shield, Wallet, Globe, Bell, Plus, TrendingUp } from 'lucide-react';
import { STRATEGY_CODES, STRATEGY_LABELS, type StrategyId } from '../features/protrade/workflowTypes';

const PAPER_TRADES_KEY = 'sutra.protrade.paperTrades.v1';

interface PaperTradeRecord {
  id: string;
  symbol: string;
  strategyId: StrategyId | null;
  strategyCode: string;
  strategyName: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  status: 'Open' | 'Closed';
  outcome: 'Open' | 'Target' | 'Stop' | 'Manual';
  entry: number;
  stop: number;
  target: number;
  quantity: number;
  notional: number;
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  pnl?: number;
}

interface DayStats {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  bestTrade: number;
  worstTrade: number;
  tradeList: PaperTradeRecord[];
}

interface EquityPoint {
  date: string;
  label: string;
  dailyPnl: number;
  cumulativePnl: number;
  peak: number;
  drawdown: number;
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function usePaperStats() {
  const [trades, setTrades] = React.useState<PaperTradeRecord[]>([]);
  React.useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(PAPER_TRADES_KEY) || '[]') as PaperTradeRecord[];
      setTrades(Array.isArray(raw) ? raw : []);
    } catch {
      setTrades([]);
    }
  }, []);

  const closed = trades.filter((t) => t.status === 'Closed');
  const open = trades.filter((t) => t.status === 'Open');
  const today = todayET();
  const todayClosed = closed.filter((t) => t.closedAt && t.closedAt.startsWith(today));
  const todayPnl = todayClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;

  const byStrategy = Object.keys(STRATEGY_LABELS).map((id) => {
    const sid = id as StrategyId;
    const sc = closed.filter((t) => t.strategyId === sid);
    const sp = sc.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const sw = sc.filter((t) => (t.pnl ?? 0) > 0).length;
    return { id: sid, code: STRATEGY_CODES[sid], name: STRATEGY_LABELS[sid], trades: sc.length, wins: sw, losses: sc.length - sw, pnl: sp };
  }).filter((s) => s.trades > 0);

  const recentTrades = [...closed].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, 10);

  // ── Calendar data ───────────────────────────────────────────────────────────
  const dayMap = new Map<string, PaperTradeRecord[]>();
  for (const t of closed) {
    if (!t.closedAt) continue;
    const date = toETDate(t.closedAt);
    if (!dayMap.has(date)) dayMap.set(date, []);
    dayMap.get(date)!.push(t);
  }

  const dayStatsArray: DayStats[] = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayTrades]) => {
      const pnl = dayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const w = dayTrades.filter((t) => (t.pnl ?? 0) > 0).length;
      const pnls = dayTrades.map((t) => t.pnl ?? 0);
      return { date, pnl, trades: dayTrades.length, wins: w, losses: dayTrades.length - w, bestTrade: pnls.length ? Math.max(...pnls) : 0, worstTrade: pnls.length ? Math.min(...pnls) : 0, tradeList: dayTrades };
    });

  const dayStatsMap = new Map(dayStatsArray.map((d) => [d.date, d]));

  // ── Equity points ───────────────────────────────────────────────────────────
  const equityPoints: EquityPoint[] = [];
  let cum = 0;
  let peak = 0;
  for (const day of dayStatsArray) {
    cum += day.pnl;
    peak = Math.max(peak, cum);
    const [, mm, dd] = day.date.split('-');
    equityPoints.push({ date: day.date, label: `${mm}/${dd}`, dailyPnl: day.pnl, cumulativePnl: cum, peak, drawdown: cum - peak });
  }

  const maxDrawdown = equityPoints.length > 0 ? Math.min(0, ...equityPoints.map((p) => p.drawdown)) : 0;
  const bestDay = dayStatsArray.length > 0 ? dayStatsArray.reduce((a, b) => (a.pnl >= b.pnl ? a : b)) : null;
  const worstDay = dayStatsArray.length > 0 ? dayStatsArray.reduce((a, b) => (a.pnl <= b.pnl ? a : b)) : null;

  let streak = 0;
  let streakType: 'green' | 'red' | 'none' = 'none';
  if (dayStatsArray.length > 0) {
    const last = dayStatsArray[dayStatsArray.length - 1];
    streakType = last.pnl > 0 ? 'green' : last.pnl < 0 ? 'red' : 'none';
    if (streakType !== 'none') {
      for (let i = dayStatsArray.length - 1; i >= 0; i--) {
        if ((streakType === 'green') === (dayStatsArray[i].pnl > 0)) streak++;
        else break;
      }
    }
  }

  return { todayPnl, totalPnl, winRate, wins, losses, closed, open, todayClosed, byStrategy, recentTrades, totalTrades: closed.length, dayStatsMap, equityPoints, maxDrawdown, bestDay, worstDay, streak, streakType };
}

function pnlColor(v: number) { return v >= 0 ? 'text-emerald-400' : 'text-rose-400'; }
function fmtPnl(v: number) { return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`; }

// ── Equity Curve ──────────────────────────────────────────────────────────────

function EquityCurve({ points }: { points: EquityPoint[] }) {
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div className="glass p-5 rounded-xl">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-3">
          <TrendingUp size={14} className="text-emerald-400" />Equity Curve
        </h3>
        <div className="flex items-center justify-center py-8 text-slate-500 text-xs">Need 2+ trading days to draw curve</div>
      </div>
    );
  }

  const W = 800; const H = 140;
  const PAD = { l: 54, r: 12, t: 12, b: 28 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const allV = [...points.map((p) => p.cumulativePnl), 0];
  const minV = Math.min(...allV);
  const maxV = Math.max(...allV);
  const range = maxV - minV || 1;

  const toX = (i: number) => PAD.l + (i / Math.max(points.length - 1, 1)) * plotW;
  const toY = (v: number) => PAD.t + plotH - ((v - minV) / range) * plotH;
  const zeroY = toY(0);

  const linePoints = points.map((p, i) => `${toX(i).toFixed(1)},${toY(p.cumulativePnl).toFixed(1)}`).join(' ');

  // Drawdown fill: forward along peak, back along cumulative
  const ddPath = [
    ...points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)},${toY(p.peak).toFixed(1)}`),
    ...[...points].reverse().map((p, ri) => `L ${toX(points.length - 1 - ri).toFixed(1)},${toY(p.cumulativePnl).toFixed(1)}`),
    'Z',
  ].join(' ');

  const yTicks = [...new Set([Math.round(maxV), 0, ...(minV < -1 ? [Math.round(minV)] : [])])];
  const xStep = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points.map((p, i) => ({ p, i })).filter(({ i }) => i % xStep === 0 || i === points.length - 1);

  const lineColor = points[points.length - 1].cumulativePnl >= 0 ? '#10b981' : '#f43f5e';
  const hp = hoverIdx !== null ? points[hoverIdx] : null;

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(Math.max(0, Math.min(points.length - 1, ((svgX - PAD.l) / plotW) * (points.length - 1))));
    setHoverIdx(idx);
  };

  return (
    <div className="glass p-4 rounded-xl">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <TrendingUp size={14} className="text-emerald-400" />Equity Curve
        </h3>
        {hp && (
          <div className="flex gap-4 text-[10px]">
            <span className="text-slate-500">{hp.date}</span>
            <span className={pnlColor(hp.dailyPnl)}>Day {fmtPnl(hp.dailyPnl)}</span>
            <span className={pnlColor(hp.cumulativePnl)}>Total {fmtPnl(hp.cumulativePnl)}</span>
            {hp.drawdown < -0.01 && <span className="text-rose-400">DD ${hp.drawdown.toFixed(2)}</span>}
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} onMouseMove={onMouseMove} onMouseLeave={() => setHoverIdx(null)}>
        {/* Zero baseline */}
        <line x1={PAD.l} y1={zeroY} x2={W - PAD.r} y2={zeroY} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" strokeWidth={1} />

        {/* Drawdown fill */}
        <path d={ddPath} fill="rgba(244,63,94,0.14)" />

        {/* Equity line */}
        <polyline points={linePoints} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />

        {/* Y labels */}
        {yTicks.map((v) => (
          <text key={v} x={PAD.l - 4} y={toY(v) + 4} textAnchor="end" fontSize={9} fill="rgba(148,163,184,0.55)">
            {v >= 0 ? '+' : ''}${Math.abs(v)}
          </text>
        ))}

        {/* X labels */}
        {xLabels.map(({ p, i }) => (
          <text key={p.date} x={toX(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="rgba(148,163,184,0.45)">{p.label}</text>
        ))}

        {/* Crosshair */}
        {hoverIdx !== null && (
          <>
            <line x1={toX(hoverIdx)} y1={PAD.t} x2={toX(hoverIdx)} y2={H - PAD.b} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
            <circle cx={toX(hoverIdx)} cy={toY(points[hoverIdx].cumulativePnl)} r={3.5} fill={lineColor} stroke="white" strokeWidth={1} />
          </>
        )}
      </svg>
    </div>
  );
}

// ── Key Stats strip ───────────────────────────────────────────────────────────

function KeyStats({ maxDrawdown, bestDay, worstDay, streak, streakType }: {
  maxDrawdown: number; bestDay: DayStats | null; worstDay: DayStats | null; streak: number; streakType: 'green' | 'red' | 'none';
}) {
  const streakVal = streakType === 'none' ? '--' : streakType === 'green' ? `${streak} green` : `${streak} red`;
  const streakColor = streakType === 'green' ? 'text-emerald-400' : streakType === 'red' ? 'text-rose-400' : 'text-slate-500';

  const items = [
    { label: 'Max Drawdown', value: maxDrawdown < -0.01 ? `-$${Math.abs(maxDrawdown).toFixed(2)}` : '$0.00', color: maxDrawdown < -0.01 ? 'text-rose-400' : 'text-slate-400', sub: 'peak-to-trough' },
    { label: 'Best Day', value: bestDay ? fmtPnl(bestDay.pnl) : '--', color: bestDay ? pnlColor(bestDay.pnl) : 'text-slate-500', sub: bestDay?.date ?? '' },
    { label: 'Worst Day', value: worstDay ? fmtPnl(worstDay.pnl) : '--', color: worstDay ? pnlColor(worstDay.pnl) : 'text-slate-500', sub: worstDay?.date ?? '' },
    { label: 'Streak', value: streakVal, color: streakColor, sub: streakType === 'none' ? 'no data' : 'consecutive days' },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {items.map((item) => (
        <div key={item.label} className="glass p-3 rounded-xl">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">{item.label}</p>
          <p className={`text-sm font-black ${item.color}`}>{item.value}</p>
          <p className="text-[9px] text-slate-600 mt-0.5">{item.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ── PnL Calendar ──────────────────────────────────────────────────────────────

function PnlCalendar({ dayStatsMap }: { dayStatsMap: Map<string, DayStats> }) {
  const today = todayET();
  const [yearMonth, setYearMonth] = React.useState(() => today.slice(0, 7));
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null);

  const [year, month] = yearMonth.split('-').map(Number);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const startOffset = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  const nav = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYearMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    setSelectedDay(null);
  };

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthPnl = [...dayStatsMap.entries()].filter(([d]) => d.startsWith(yearMonth)).reduce((s, [, ds]) => s + ds.pnl, 0);

  const cells: (number | null)[] = [...Array<null>(startOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  const cellBg = (pnl: number) => {
    const a = Math.abs(pnl);
    if (pnl > 0) return a >= 100 ? 'bg-emerald-500/55 border-emerald-400/40' : a >= 25 ? 'bg-emerald-700/35 border-emerald-600/25' : 'bg-emerald-900/30 border-emerald-800/20';
    if (pnl < 0) return a >= 100 ? 'bg-rose-500/55 border-rose-400/40' : a >= 25 ? 'bg-rose-700/35 border-rose-600/25' : 'bg-rose-900/30 border-rose-800/20';
    return 'bg-white/5 border-white/8';
  };

  const selected = selectedDay ? dayStatsMap.get(selectedDay) ?? null : null;

  return (
    <div className="glass p-5 rounded-xl space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
          <BarChart size={14} className="text-indigo-400" />Daily P&L Calendar
        </h3>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${pnlColor(monthPnl)}`}>{fmtPnl(monthPnl)}</span>
          <button onClick={() => nav(-1)} className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-white/10 text-base">‹</button>
          <span className="text-xs font-bold text-white w-32 text-center">{monthLabel}</span>
          <button onClick={() => nav(1)} className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-white/10 text-base">›</button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-[9px] font-bold text-slate-500 uppercase text-center pb-0.5">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d}>{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} />;
          const dateStr = `${yearMonth}-${String(day).padStart(2, '0')}`;
          const ds = dayStatsMap.get(dateStr);
          const isToday = dateStr === today;
          const isFuture = dateStr > today;
          const isSel = dateStr === selectedDay;
          return (
            <button
              key={dateStr}
              onClick={() => ds && setSelectedDay(isSel ? null : dateStr)}
              disabled={!ds}
              className={[
                'rounded-lg border min-h-[52px] p-1.5 flex flex-col text-left transition-all',
                ds ? `${cellBg(ds.pnl)} cursor-pointer hover:brightness-125` : 'bg-white/3 border-white/5 cursor-default',
                isFuture ? 'opacity-25' : '',
                isToday ? 'ring-1 ring-white/30' : '',
                isSel ? 'ring-2 ring-indigo-400/80' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="text-[9px] font-bold text-slate-400 self-end leading-none">{day}</span>
              {ds && (
                <>
                  <span className={`text-[10px] font-black mt-auto leading-none ${pnlColor(ds.pnl)}`}>{fmtPnl(ds.pnl)}</span>
                  <span className="text-[8px] text-slate-500 mt-0.5 leading-none">{ds.trades}T {ds.wins}W</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {selected && selectedDay && (
        <div className="border-t border-white/10 pt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-bold text-white">
              {new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
            <div className="flex items-center gap-4 text-[10px]">
              <span className="text-slate-500">{selected.trades} trades · {selected.wins}W {selected.losses}L</span>
              <span className={`font-black text-sm ${pnlColor(selected.pnl)}`}>{fmtPnl(selected.pnl)}</span>
            </div>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-white/5">
                <th className="py-1.5 px-2">Symbol</th><th className="py-1.5 px-2">Strat</th><th className="py-1.5 px-2">Dir</th>
                <th className="py-1.5 px-2 text-right">Entry</th><th className="py-1.5 px-2 text-right">Exit</th>
                <th className="py-1.5 px-2">Outcome</th><th className="py-1.5 px-2 text-right">P&L</th>
              </tr>
            </thead>
            <tbody className="text-[11px] font-mono">
              {selected.tradeList.map((t) => (
                <tr key={t.id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="py-1.5 px-2 font-bold text-white">{t.symbol}</td>
                  <td className="py-1.5 px-2 text-indigo-400">{t.strategyCode || '--'}</td>
                  <td className="py-1.5 px-2"><span className={`text-[9px] font-black ${t.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</span></td>
                  <td className="py-1.5 px-2 text-right text-slate-300">${t.entry.toFixed(2)}</td>
                  <td className="py-1.5 px-2 text-right text-slate-300">{t.exitPrice ? `$${t.exitPrice.toFixed(2)}` : '--'}</td>
                  <td className="py-1.5 px-2 text-slate-400">{t.outcome}</td>
                  <td className={`py-1.5 px-2 text-right font-black ${pnlColor(t.pnl ?? 0)}`}>{fmtPnl(t.pnl ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── PerformanceScreen ─────────────────────────────────────────────────────────

export function PerformanceScreen() {
  const stats = usePaperStats();

  const summaryCards = [
    { label: "Today's P&L", value: fmtPnl(stats.todayPnl), sub: `${stats.todayClosed.length} trades today`, color: pnlColor(stats.todayPnl) },
    { label: 'Total Paper P&L', value: fmtPnl(stats.totalPnl), sub: `${stats.totalTrades} closed trades`, color: pnlColor(stats.totalPnl) },
    { label: 'Win Rate', value: `${stats.winRate}%`, sub: `${stats.wins}W / ${stats.losses}L`, color: 'text-indigo-400' },
    { label: 'Open Positions', value: String(stats.open.length), sub: 'Paper trades active', color: 'text-amber-400' },
  ];

  return (
    <div className="flex flex-col gap-5 pb-12">
      <div className="grid grid-cols-4 gap-4">
        {summaryCards.map((card) => (
          <div key={card.label} className="glass p-4 rounded-xl">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{card.label}</p>
            <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
            <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-tight">{card.sub}</p>
          </div>
        ))}
      </div>

      {stats.totalTrades === 0 ? (
        <div className="glass p-8 rounded-xl flex flex-col items-center justify-center gap-3">
          <AlertTriangle size={24} className="text-amber-500/60" />
          <p className="text-sm font-bold text-slate-400">No paper trades yet</p>
          <p className="text-xs text-slate-500">Go to Pro Tab → find a Trade Ready signal → click Paper Trade</p>
        </div>
      ) : (
        <>
          <KeyStats maxDrawdown={stats.maxDrawdown} bestDay={stats.bestDay} worstDay={stats.worstDay} streak={stats.streak} streakType={stats.streakType} />
          <EquityCurve points={stats.equityPoints} />
          <PnlCalendar dayStatsMap={stats.dayStatsMap} />
        </>
      )}

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-5">
          {stats.byStrategy.length > 0 && (
            <div className="glass p-5 rounded-xl">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
                <BarChart size={14} className="text-indigo-400" />Strategy P&L (Paper)
              </h3>
              <table className="w-full text-left border-collapse">
                <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-white/5">
                  <tr>
                    <th className="py-2 px-3">Strategy</th>
                    <th className="py-2 px-3 text-right">Trades</th>
                    <th className="py-2 px-3 text-right">W</th>
                    <th className="py-2 px-3 text-right">L</th>
                    <th className="py-2 px-3 text-right">Win %</th>
                    <th className="py-2 px-3 text-right">Net P&L</th>
                  </tr>
                </thead>
                <tbody className="text-[11px] font-mono">
                  {stats.byStrategy.map((s) => (
                    <tr key={s.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center gap-2">
                          <span className="text-[9px] font-black text-indigo-400 border border-indigo-400/40 bg-indigo-500/10 px-1.5 py-0.5 rounded">{s.code}</span>
                          <span className="text-slate-300">{s.name}</span>
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right text-slate-300">{s.trades}</td>
                      <td className="py-3 px-3 text-right text-emerald-400 font-bold">{s.wins}</td>
                      <td className="py-3 px-3 text-right text-rose-400 font-bold">{s.losses}</td>
                      <td className="py-3 px-3 text-right text-white">{s.trades > 0 ? `${Math.round((s.wins / s.trades) * 100)}%` : '--'}</td>
                      <td className={`py-3 px-3 text-right font-black ${pnlColor(s.pnl)}`}>{fmtPnl(s.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {stats.recentTrades.length > 0 && (
            <div className="glass p-5 rounded-xl">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
                <Activity size={14} className="text-emerald-400" />Recent Closed Trades
              </h3>
              <table className="w-full text-left border-collapse">
                <thead className="text-[9px] uppercase text-slate-500 font-bold tracking-widest bg-white/5">
                  <tr>
                    <th className="py-2 px-3">Symbol</th><th className="py-2 px-3">Strategy</th><th className="py-2 px-3">Dir</th>
                    <th className="py-2 px-3 text-right">Entry</th><th className="py-2 px-3 text-right">Exit</th>
                    <th className="py-2 px-3">Outcome</th><th className="py-2 px-3 text-right">P&L</th>
                  </tr>
                </thead>
                <tbody className="text-[11px] font-mono">
                  {stats.recentTrades.map((t) => (
                    <tr key={t.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-2 px-3 font-bold text-white">{t.symbol}</td>
                      <td className="py-2 px-3 text-slate-400">{t.strategyCode || '--'}</td>
                      <td className="py-2 px-3"><span className={`text-[9px] font-black ${t.direction === 'BULL' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</span></td>
                      <td className="py-2 px-3 text-right text-slate-300">${t.entry.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-300">{t.exitPrice ? `$${t.exitPrice.toFixed(2)}` : '--'}</td>
                      <td className="py-2 px-3 text-slate-400">{t.outcome}</td>
                      <td className={`py-2 px-3 text-right font-black ${pnlColor(t.pnl ?? 0)}`}>{fmtPnl(t.pnl ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="glass p-5 rounded-xl">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
              <TrendingUp size={14} className="text-emerald-400" />Session Rules
            </h3>
            <div className="space-y-2 text-[11px] text-slate-400">
              {['Trade window: 10:00 AM – 4:00 PM ET', 'Opening blackout: 9:30 – 10:00 AM ET', 'Strategies auto-lock outside session', 'Min R:R 1.8 for Trade Ready', 'Min RVOL: 1.0 (S2/S4/S5) / 1.2 (S1/S3)'].map((r) => (
                <div key={r} className="flex items-start gap-2"><CheckCircle2 size={11} className="text-emerald-500 mt-0.5 shrink-0" /><span>{r}</span></div>
              ))}
            </div>
          </div>
          <div className="glass p-5 rounded-xl">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
              <AlertTriangle size={14} className="text-amber-400" />Day Trader Rules
            </h3>
            <div className="space-y-2 text-[11px] text-slate-400">
              {['No trades in first 30 min (blackout)', 'Check 15m trend before entry', 'VWAP must align with direction', '1m EMA must confirm entry timing', 'S3 breakout: must have 1.2x RVOL', 'Stop below structure — not arbitrary'].map((r) => (
                <div key={r} className="flex items-start gap-2"><AlertTriangle size={11} className="text-amber-500 mt-0.5 shrink-0" /><span>{r}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SettingsScreen ────────────────────────────────────────────────────────────

interface SettingsScreenProps {
  brokerConnected: boolean;
  brokerLoading: boolean;
  brokerError?: string;
  onConnectBroker: () => void;
  onDisconnectBroker: () => void;
}

export function SettingsScreen({ brokerConnected, brokerLoading, brokerError = '', onConnectBroker, onDisconnectBroker }: SettingsScreenProps) {
  const statusText = brokerLoading ? 'Loading' : brokerConnected ? 'Connected (Demo)' : brokerError ? 'Disconnected' : 'Disconnected';

  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="col-span-2 space-y-6">
        <section className="glass p-6 rounded-xl">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
            <Wallet size={14} className="text-indigo-400" />Broker Connections
          </h3>
          <div className="space-y-3">
            <div className="p-4 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-indigo-600/20 border border-indigo-500/20 rounded-lg flex items-center justify-center font-black text-indigo-400">T2</div>
                <div>
                  <p className="text-xs font-bold text-white tracking-widest">Trading212</p>
                  <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 ${brokerConnected ? 'text-emerald-400' : brokerLoading ? 'text-amber-400' : 'text-slate-500'}`}>{statusText}</p>
                  {brokerError && !brokerConnected && <p className="mt-1 text-[10px] text-rose-400 max-w-xl">{brokerError}</p>}
                </div>
              </div>
              {brokerConnected || brokerLoading ? (
                <button onClick={onDisconnectBroker} className="text-[10px] font-bold text-rose-400 uppercase tracking-widest hover:underline">Disconnect</button>
              ) : (
                <button onClick={onConnectBroker} className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest hover:underline">Connect</button>
              )}
            </div>
            <div className="p-8 border border-white/5 border-dashed rounded-xl flex items-center justify-center gap-3 text-slate-500 hover:text-slate-300 hover:bg-white/5 cursor-pointer transition-all">
              <Plus size={16} /><span className="text-xs font-bold uppercase tracking-widest">Connect New Broker</span>
            </div>
          </div>
        </section>

        <section className="glass p-6 rounded-xl">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-6">
            <Shield size={14} className="text-emerald-400" />Execution Rules
          </h3>
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Risk per Trade (%)</label>
              <input type="number" defaultValue="1.0" className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-white" />
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10">
                <p className="text-[10px] font-bold text-slate-200 uppercase tracking-widest">Auto-execute</p>
                <div className="w-10 h-5 bg-indigo-600 rounded-full relative p-1">
                  <div className="absolute right-1 w-3 h-3 bg-white rounded-full" />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="space-y-6">
        <section className="glass p-6 rounded-xl">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
            <Bell size={14} className="text-amber-400" />Alerts
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-indigo-500/10 border border-indigo-500/20 rounded-lg flex items-center justify-center text-indigo-400"><Globe size={14} /></div>
              <div className="flex-1"><p className="text-[10px] font-bold text-white tracking-widest uppercase">Telegram</p></div>
              <button className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">On</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
