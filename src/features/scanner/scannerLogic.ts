import type { EngineScanResult } from './engineTypes';
import type { ScannerState } from './scannerTypes';
import { symbolsMatch } from '../../lib/symbols';

export function computeTickerState(result: EngineScanResult, lockedTickers: Set<string> = new Set()): ScannerState {
  if ([...lockedTickers].some((locked) => symbolsMatch(result.ticker, locked))) return 'Locked';

  const e1 = Boolean(result.e1?.fired);
  const e2 = Boolean(result.e2?.fired);
  const e3 = Boolean(result.e3?.fired);
  const e5 = Boolean(result.e5?.fired);

  if (e1 || e2 || e3 || e5) return 'Confirmed';
  if (result.htf?.direction === 'NEUTRAL') return 'Cold';

  const forming = result.forming;
  if (forming && Object.values(forming).some(Boolean)) return 'Forming';
  return 'Cold';
}

export function getFormingDetail(result: EngineScanResult) {
  const forming = result.forming || { e1: false, e2: false, e3: false, e4: false, e5: false };
  return {
    e1Forming: forming.e1,
    e2Forming: forming.e2,
    e3Forming: forming.e3,
    e4Forming: forming.e4,
    e5Forming: forming.e5,
    e1Fired: Boolean(result.e1?.fired),
    e2Fired: Boolean(result.e2?.fired),
    e3Fired: Boolean(result.e3?.fired),
    e4Fired: Boolean(result.e4?.fired),
    e5Fired: Boolean(result.e5?.fired),
  };
}

export function activeEngineSet(result: EngineScanResult) {
  return new Set(result.activeSignals.map((signal) => signal.engine));
}

export function sideFromDirection(direction: 'BULL' | 'BEAR' | 'NEUTRAL') {
  if (direction === 'BULL') return 'LONG';
  if (direction === 'BEAR') return 'SHORT';
  return 'NEUTRAL';
}

export function shouldBlockForEntryDrift(input: {
  side: 'LONG' | 'SHORT' | 'NEUTRAL';
  currentPrice?: number | null;
  entry?: number | null;
  stop?: number | null;
  maxEntryDriftRisk?: number;
}) {
  const { side, currentPrice, entry, stop } = input;
  if (!currentPrice || !entry || !stop || side === 'NEUTRAL') return false;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return false;
  const threshold = risk * (input.maxEntryDriftRisk ?? 0.5);
  return (side === 'LONG' && currentPrice > entry + threshold) || (side === 'SHORT' && currentPrice < entry - threshold);
}
