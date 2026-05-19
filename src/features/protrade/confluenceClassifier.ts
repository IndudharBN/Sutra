import type { SignalGroup, StrategyId, StrategySignal } from './workflowTypes';

export interface GroupClassification {
  group: SignalGroup;
  sizingMultiplier: number;  // applied on top of base group notional cap
  bestSignal: StrategySignal;
}

// Notional cap per group as fraction of account (used in riskManager sizing).
export const GROUP_NOTIONAL_CAP: Record<SignalGroup, number> = {
  GOLD:         0.15,
  BLUE:         0.10,
  TREND:        0.10,
  FVG:          0.10,
  BREAKOUT:     0.08,
  PULLBACK:     0.08,
  MOMENTUM:     0.08,
  SIDEWAYS:     0.06,
  UNCLASSIFIED: 0.03,
};

const BREAKOUT_IDS   = new Set<StrategyId>(['orb_retest', 'flag_break']);
const PULLBACK_IDS   = new Set<StrategyId>(['vwap_pullback', 'liquidity_sweep', 'vwap15m_pullback', 'ema20_bounce_15m']);
const MOMENTUM_IDS   = new Set<StrategyId>(['s7_volume_surge', 'ema20_bounce']);
const TREND_IDS      = new Set<StrategyId>(['rs_continuation', 'mss_breakout']);

// Prefers tighter-stop entries: E1 (15m OB) > E2 (5m OB) > E3 (MSS) for GOLD/BLUE.
function bestForGroup(signals: StrategySignal[], preferred: StrategyId[]): StrategySignal {
  for (const id of preferred) {
    const s = signals.find((x) => x.strategyId === id);
    if (s) return s;
  }
  return signals[0];
}

/**
 * Given ALL fired signals for a single ticker (tradePlan !== null),
 * return the group classification, sizing multiplier, and the best signal to trade.
 * Returns null when no signals have a trade plan.
 */
export function classifySignalGroup(allSignals: StrategySignal[]): GroupClassification | null {
  const fired = allSignals.filter((s) => s.tradePlan !== null);
  if (!fired.length) return null;

  const ids = new Set(fired.map((s) => s.strategyId));

  const s5 = fired.find((s) => s.strategyId === 'ob_fvg_retest');
  const hasE1  = ids.has('orb15m_retest');          // S10 = 15m OB
  const hasE2  = s5?.enginePath === 'ob';            // S5 OB-path = 5m OB
  const hasE3  = ids.has('rs_continuation');         // S3 = MSS/RS
  const hasE5a = s5?.enginePath === 'fvg';           // S5 FVG-path

  // ── Stock-analyzer parity groups ──────────────────────────────────────────

  // GOLD: E1 + E2 + E3 all confirmed on same ticker
  if (hasE1 && hasE2 && hasE3) {
    return {
      group: 'GOLD',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['orb15m_retest', 'ob_fvg_retest', 'rs_continuation']),
    };
  }

  // BLUE: E1+E2, E1 alone (full size), or E2 alone (0.75× penalty — anticipatory only)
  if (hasE1 && hasE2) {
    return {
      group: 'BLUE',
      sizingMultiplier: 1.0,
      bestSignal: bestForGroup(fired, ['orb15m_retest', 'ob_fvg_retest']),
    };
  }
  if (hasE1) {
    return { group: 'BLUE', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'orb15m_retest')! };
  }
  if (hasE2) {
    return { group: 'BLUE', sizingMultiplier: 0.75, bestSignal: s5! }; // E2 alone = forming context
  }

  // TREND: E3 alone (no OB zone backing)
  if (hasE3) {
    return { group: 'TREND', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'rs_continuation')! };
  }

  // FVG: S5 FVG-path only
  if (hasE5a) {
    return { group: 'FVG', sizingMultiplier: 1.0, bestSignal: s5! };
  }

  // ── Sutra-native groups ───────────────────────────────────────────────────

  // BREAKOUT: S1 and/or S9 — both together get +25% boost
  const breakoutFired = fired.filter((s) => BREAKOUT_IDS.has(s.strategyId));
  if (breakoutFired.length) {
    const bothBreakout = ids.has('orb_retest') && ids.has('flag_break');
    return {
      group: 'BREAKOUT',
      sizingMultiplier: bothBreakout ? 1.25 : 1.0,
      bestSignal: bestForGroup(breakoutFired, ['orb_retest', 'flag_break']),
    };
  }

  // PULLBACK: S2, S4, S11, S12 — S2+S11 dual-timeframe gets +20%; S4-alone gets 0.75×
  const pullbackFired = fired.filter((s) => PULLBACK_IDS.has(s.strategyId));
  if (pullbackFired.length) {
    const dualVwap = ids.has('vwap_pullback') && ids.has('vwap15m_pullback');
    const sweepAlone = ids.has('liquidity_sweep') && pullbackFired.length === 1;
    const mult = dualVwap ? 1.2 : sweepAlone ? 0.75 : 1.0;
    return {
      group: 'PULLBACK',
      sizingMultiplier: mult,
      bestSignal: bestForGroup(pullbackFired, ['vwap_pullback', 'vwap15m_pullback', 'liquidity_sweep', 'ema20_bounce_15m']),
    };
  }

  // MOMENTUM: S7, S8 — S7+S8 or S8+S12 gets +20%
  const momentumFired = fired.filter((s) => MOMENTUM_IDS.has(s.strategyId));
  if (momentumFired.length) {
    const dualMomentum = (ids.has('s7_volume_surge') && ids.has('ema20_bounce'));
    return {
      group: 'MOMENTUM',
      sizingMultiplier: dualMomentum ? 1.2 : 1.0,
      bestSignal: bestForGroup(momentumFired, ['s7_volume_surge', 'ema20_bounce']),
    };
  }

  // TREND (MSS Breakout S6 alone — treated at TREND tier)
  if (ids.has('mss_breakout')) {
    return { group: 'TREND', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'mss_breakout')! };
  }

  // SIDEWAYS: S13 alone
  if (ids.has('range_reversion')) {
    return { group: 'SIDEWAYS', sizingMultiplier: 1.0, bestSignal: fired.find((s) => s.strategyId === 'range_reversion')! };
  }

  return { group: 'UNCLASSIFIED', sizingMultiplier: 1.0, bestSignal: fired[0] };
}

/**
 * Stamp group classification onto each signal in the array (mutates a copy).
 * Call this after evaluateStrategies() returns the full signal set for a ticker.
 */
export function stampGroupClassification(signals: StrategySignal[]): StrategySignal[] {
  const classification = classifySignalGroup(signals);
  if (!classification) return signals;
  return signals.map((s) => ({
    ...s,
    signalGroup: classification.group,
    groupSizeMult: s.strategyId === classification.bestSignal.strategyId
      ? classification.sizingMultiplier
      : 1.0,
  }));
}
