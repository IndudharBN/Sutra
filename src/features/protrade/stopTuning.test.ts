import { afterEach, describe, expect, it } from 'vitest';
import { enforceMinStop, getStrategyTuning, intradayCappedStop, setStrategyTuning } from './strategyEngine';

afterEach(() => setStrategyTuning(null));

describe('stop-width tuning', () => {
  it('defaults equal the live constants (floor 0.5 x ATR15 / 0.5% price, ceiling mult 4)', () => {
    expect(getStrategyTuning()).toEqual({ intradayAtrMult: 4, minStopAtr: 0.5, minStopPct: 0.005 });
  });

  it('default floor: a 0.1 stop on a $100 BULL entry is pulled out to max(0.5*ATR15, 0.5%)', () => {
    // atr15 = 0.4 -> 0.5*0.4 = 0.2 ; 0.5% of 100 = 0.5 -> floor 0.5
    expect(enforceMinStop('BULL', 100, 99.9, 0.4)).toBeCloseTo(99.5, 6);
    expect(enforceMinStop('BEAR', 100, 100.1, 0.4)).toBeCloseTo(100.5, 6);
  });

  it('a wider floor widens tight stops and leaves already-wide stops alone', () => {
    setStrategyTuning({ minStopAtr: 2, minStopPct: 0.001 });
    expect(enforceMinStop('BULL', 100, 99.9, 0.4)).toBeCloseTo(99.2, 6); // 2 * 0.4 = 0.8
    expect(enforceMinStop('BULL', 100, 97, 0.4)).toBeCloseTo(97, 6);
  });

  it('ceiling: structural stop wider than the cap is pulled in; a larger multiplier relaxes the cap', () => {
    // no vix -> noiseFloor 0.75 ; cap = atr15 * 0.75 * mult
    expect(intradayCappedStop('BULL', 100, 90, 1)).toBeCloseTo(97, 6);   // 1 * 0.75 * 4 = 3
    setStrategyTuning({ intradayAtrMult: 8 });
    expect(intradayCappedStop('BULL', 100, 90, 1)).toBeCloseTo(94, 6);   // 1 * 0.75 * 8 = 6
  });

  it('setStrategyTuning(null) restores defaults', () => {
    setStrategyTuning({ minStopAtr: 3 });
    setStrategyTuning(null);
    expect(getStrategyTuning().minStopAtr).toBe(0.5);
  });
});
