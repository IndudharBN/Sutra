import { describe, expect, it } from 'vitest';
import type { EngineScanResult } from './engineTypes';
import { computeTickerState, shouldBlockForEntryDrift } from './scannerLogic';

const baseResult: EngineScanResult = {
  ticker: 'AMD',
  htf: { direction: 'BULL' },
  e1: { fired: false, direction: 'BULL', label: 'E1' },
  e2: { fired: false, direction: 'BULL', label: 'E2' },
  e3: { fired: false, direction: 'BULL', label: 'E3' },
  e4: { fired: false, direction: 'BULL', label: 'E4' },
  e5: { fired: false, direction: 'BULL', label: 'E5' },
  enginesFired: 0,
  side: 'LONG',
  activeSignals: [],
};

describe('scanner state logic', () => {
  it('marks locked tickers first', () => {
    expect(computeTickerState(baseResult, new Set(['AMD']))).toBe('Locked');
  });

  it('marks broker ticker aliases as locked', () => {
    expect(computeTickerState(baseResult, new Set(['AMD_US_EQ']))).toBe('Locked');
    expect(computeTickerState({ ...baseResult, ticker: 'BRK-B' }, new Set(['BRK.B_US_EQ']))).toBe('Locked');
  });

  it('does not confirm E4 alone', () => {
    expect(computeTickerState({ ...baseResult, e4: { ...baseResult.e4, fired: true } })).toBe('Cold');
  });

  it('confirms standalone E1, E2, E3, and E5', () => {
    expect(computeTickerState({ ...baseResult, e1: { ...baseResult.e1, fired: true } })).toBe('Confirmed');
    expect(computeTickerState({ ...baseResult, e2: { ...baseResult.e2, fired: true } })).toBe('Confirmed');
    expect(computeTickerState({ ...baseResult, e3: { ...baseResult.e3, fired: true } })).toBe('Confirmed');
    expect(computeTickerState({ ...baseResult, e5: { ...baseResult.e5, fired: true } })).toBe('Confirmed');
  });

  it('detects forming state', () => {
    expect(computeTickerState({ ...baseResult, forming: { e1: false, e2: true, e3: false, e4: false, e5: false } })).toBe('Forming');
  });

  it('blocks entry chasing using risk-distance threshold', () => {
    expect(shouldBlockForEntryDrift({ side: 'LONG', currentPrice: 106, entry: 100, stop: 90 })).toBe(true);
    expect(shouldBlockForEntryDrift({ side: 'SHORT', currentPrice: 94, entry: 100, stop: 110 })).toBe(true);
    expect(shouldBlockForEntryDrift({ side: 'LONG', currentPrice: 103, entry: 100, stop: 90 })).toBe(false);
  });
});
