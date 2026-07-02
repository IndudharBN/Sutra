import type { PaperTrade } from '../types';
import type { ProTradeRow } from './proTradeScannerApi';
import { computeNotional } from '../riskManager';
import { betaAdjustedSizingMult } from '../portfolioRisk';
import { STRATEGY_CODES } from './workflowTypes';

// ─── Per-strategy conviction sizing ──────────────────────────────────────────
// Earned by realized performance over 448 paper trades (May 20–Jul 1 2026):
//   S4 liquidity_sweep  64.1% WR, PF 8.24, +$69.5/trade → 2.0×  (~6% risk/trade)
//   S6 mss_breakout     59.0% WR, PF 2.16, +$10.8/trade → 1.333× (~4% risk/trade)
//   S8 ema20_bounce     48.3% WR, PF 1.81, +$7.8/trade  → 1.333× (~4% risk/trade)
// Multipliers are relative to the base riskPerTradePct (3% default) — the %
// figures above hold only at that base. Everything else stays at 1.0× — size
// scales with proven edge only. Revisit after the tightened gates
// (S1/S2/S5/S7/S9/S11/S12/S14) have fresh forward data.
const STRATEGY_SIZE_MULT: Record<string, number> = {
  liquidity_sweep: 2.0,
  mss_breakout: 4 / 3,
  ema20_bounce: 4 / 3,
};

// Absolute per-strategy notional ceiling (USD). User directive 2026-07-02: S4 tops
// out at $15k regardless of group cap — its FVG/GOLD group caps otherwise allow
// $19k–$29k on the ~$97k paper account. Only meaningful while account size makes
// the group caps exceed it; a small live account never reaches this ceiling.
const STRATEGY_NOTIONAL_CAP_USD: Record<string, number> = {
  liquidity_sweep: 15_000,
};

// Minimum viable notional — skip the trade entirely rather than fire a token position.
// Two floors, whichever is higher:
//   1. one share's price — the Alpaca bracket path rounds qty up to 1 whole share, so an
//      internal $24 "position" would silently become a ~$300 broker position (mismatch);
//   2. 0.5% of account — dust fills pollute WR/expectancy stats and waste position slots.
// Scales with account size: at $97k the floor is ~$485; at a $1k live account it is the
// share price, i.e. only names cheap enough to honestly afford one whole share fire.
export function minViableNotional(accountBalance: number, entry: number): number {
  return Math.max(accountBalance * 0.005, entry);
}

export function etMinutesNow(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

export function effectiveTradePlan(row: ProTradeRow) {
  if (!row.tradePlan || row.tradePlan.entry <= 0 || row.direction === 'NEUTRAL') return null;
  const risk = Math.abs(row.tradePlan.entry - row.tradePlan.stop);
  if (risk <= 0) return null;
  return row.tradePlan;
}

export function availablePaperNotional(trades: PaperTrade[], accountBalance: number): number {
  const cap = accountBalance * 0.65;
  const openNotional = trades
    .filter((t) => t.status === 'Open')
    .reduce((total, t) => total + (t.t1HitAt ? t.notional * 0.5 : t.notional), 0);
  return Math.max(0, cap - openNotional);
}

export function canPaperTradeRow(
  row: ProTradeRow,
  trades: PaperTrade[] = [],
  accountBalance = 100_000,
): boolean {
  const plan = effectiveTradePlan(row);
  return Boolean(plan && plan.rr >= 1.5 && availablePaperNotional(trades, accountBalance) > 0);
}

export function buildPaperTrade(
  row: ProTradeRow,
  currentTrades: PaperTrade[] = [],
  openedAt = new Date().toISOString(),
  accountBalance = 100_000,
  spyTrend5m?: 'UP' | 'DOWN' | 'FLAT',
  spyTrend15m?: 'UP' | 'DOWN' | 'FLAT',
  cbSizeMult = 1.0,
): PaperTrade | null {
  const plan = effectiveTradePlan(row);
  if (!plan || plan.rr < 1.5) return null;

  const strategyId = row.primaryStrategy?.strategyId ?? null;
  const isReversal = strategyId === 'liquidity_sweep' || strategyId === 'ob_fvg_retest';
  let tideMult = 1.0;
  let heatNote = '';

  if (!isReversal) {
    const tradeDir = row.primaryStrategy?.direction ?? row.direction;
    const t5 = spyTrend5m;
    const t15 = spyTrend15m;
    const ok5m  = !t5  || t5  === 'FLAT' || (tradeDir === 'BULL' && t5  === 'UP') || (tradeDir === 'BEAR' && t5  === 'DOWN');
    const ok15m = !t15 || t15 === 'FLAT' || (tradeDir === 'BULL' && t15 === 'UP') || (tradeDir === 'BEAR' && t15 === 'DOWN');
    if (ok5m && ok15m) {
      tideMult = 1.0;
    } else if (!ok5m && ok15m) {
      tideMult = 0.5;
      heatNote = ` [5m counter-tide → 50% size]`;
    } else {
      tideMult = 0.75;
      const which = !ok5m ? '5m+15m' : '15m';
      heatNote = ` [${which} counter-tide → 75% size]`;
    }
  }

  const betaMult = betaAdjustedSizingMult(row.beta);
  if (betaMult < 0.99) heatNote += ` [β${row.beta.toFixed(1)} → ${(betaMult * 100).toFixed(0)}% size]`;
  const stratMult = STRATEGY_SIZE_MULT[strategyId ?? ''] ?? 1.0;
  if (stratMult > 1.0) heatNote += ` [${strategyId} conviction → ${(stratMult * 100).toFixed(0)}% size]`;
  const effectiveMult = tideMult * betaMult * stratMult;
  const signalGroup = row.primaryStrategy?.signalGroup ?? 'UNCLASSIFIED';
  const sigGroupSizeMult = row.primaryStrategy?.groupSizeMult ?? 1.0;
  const baseNotional = computeNotional(accountBalance, plan.entry, plan.stop, signalGroup, sigGroupSizeMult);
  const usdCap = STRATEGY_NOTIONAL_CAP_USD[strategyId ?? ''] ?? Infinity;
  const adjustedNotional = Math.min(baseNotional * effectiveMult * cbSizeMult, usdCap);
  const budgetCap = availablePaperNotional(currentTrades, accountBalance);
  const notional = Math.min(budgetCap, adjustedNotional);
  if (notional < minViableNotional(accountBalance, plan.entry)) return null;
  const quantity = Math.round((notional / plan.entry) * 10000) / 10000;
  if (quantity <= 0) return null;

  return {
    id: `paper-${row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: row.symbol,
    company: row.company,
    strategyId,
    strategyCode: strategyId ? (STRATEGY_CODES[strategyId] ?? 'NA') : 'NA',
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
