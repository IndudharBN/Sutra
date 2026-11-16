import { describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, ZERO_COSTS, commission, fillPrice } from './costs';

describe('trading costs', () => {
  const ctx = { shares: 100 };

  it('limit fills pay only the measured limit slippage (spread/impact never)', () => {
    expect(fillPrice('sell', 50, 'limit', ctx, ZERO_COSTS)).toBe(50);
    expect(fillPrice('sell', 100, 'limit', ctx, DEFAULT_COSTS)).toBeCloseTo(99.95, 6);
    expect(fillPrice('buy', 100, 'limit', ctx, DEFAULT_COSTS)).toBeCloseTo(100.05, 6);
  });

  it('market fills move against the trader on both sides', () => {
    expect(fillPrice('buy', 100, 'market', ctx, { ...DEFAULT_COSTS, impactY: 0 })).toBeCloseTo(100.05, 6);
    expect(fillPrice('sell', 100, 'market', ctx, { ...DEFAULT_COSTS, impactY: 0 })).toBeCloseTo(99.95, 6);
  });

  it('stop fills cost more than plain market fills', () => {
    const c = { ...DEFAULT_COSTS, stopSlipBps: 5, impactY: 0 };
    expect(fillPrice('sell', 100, 'stop', ctx, c)).toBeCloseTo(99.9, 6);
    expect(fillPrice('sell', 100, 'stop', ctx, c)).toBeLessThan(fillPrice('sell', 100, 'market', ctx, c));
  });

  it('impact grows with order size relative to ADV', () => {
    const c = { ...ZERO_COSTS, impactY: 0.5 };
    const small = fillPrice('buy', 100, 'market', { shares: 100, adv: 1_000_000, sigmaDaily: 0.03 }, c);
    const big = fillPrice('buy', 100, 'market', { shares: 100_000, adv: 1_000_000, sigmaDaily: 0.03 }, c);
    expect(big - 100).toBeGreaterThan(small - 100);
    expect(small).toBeGreaterThan(100);
  });

  it('zero costs reproduce the price exactly', () => {
    expect(fillPrice('buy', 123.45, 'stop', { shares: 500, adv: 1e6, sigmaDaily: 0.04 }, ZERO_COSTS)).toBe(123.45);
    expect(commission(100, ZERO_COSTS)).toBe(0);
  });

  it('commission is per share and never negative', () => {
    expect(commission(200, { ...ZERO_COSTS, commissionPerShare: 0.005 })).toBeCloseTo(1, 6);
    expect(commission(-5, { ...ZERO_COSTS, commissionPerShare: 0.005 })).toBe(0);
  });
});
