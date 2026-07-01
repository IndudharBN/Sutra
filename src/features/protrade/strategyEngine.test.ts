import { describe, expect, it } from 'vitest';
import type { Candle } from '../scanner/ohlcv';
import { evaluateOrbRetest, evaluateRsContinuation, evaluateVwapPullback } from './strategyEngine';
import type { StrategyInput } from './workflowTypes';

function candle(index: number, open: number, high: number, low: number, close: number, volume = 100_000): Candle {
  return {
    time: new Date(Date.UTC(2026, 3, 22, 13, 30 + index * 5)).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function baseInput(overrides: Partial<StrategyInput> = {}): StrategyInput {
  const five = [
    candle(0, 10, 10.2, 9.8, 10.05),
    candle(1, 10.05, 10.3, 9.95, 10.2),
    candle(2, 10.2, 10.35, 10.05, 10.3),
    candle(3, 10.3, 10.75, 10.28, 10.65),
    candle(4, 10.65, 10.82, 10.34, 10.44),
    candle(5, 10.44, 10.92, 10.4, 10.86),
    candle(6, 10.86, 11.05, 10.78, 11),
    candle(7, 11, 11.14, 10.92, 11.08),
  ];
  return {
    symbol: 'TEST',
    company: 'Test Corp',
    direction: 'BULL',
    // 10.6 = a genuine retest hovering near the ORB high (10.35): breakout distance 0.25
    // clears the 0.25×ATR noise floor while stop width (0.25 + 1×ATR = 0.85) stays inside
    // the S1 asymmetry cap of 1.5×ATR (0.9). The old 11.08 was 0.73 above the level —
    // a chase, which the stop-width gate now correctly blocks.
    price: 10.6,
    rvol: 1.7,
    gapPct: 2.1,
    atr20: 0.6,
    atrPct: 4.2,
    rsVsBenchmark: 1.08,
    vwap: 10.42,
    vwapAligned: true,
    trend5m: 'UP',
    trend15m: 'UP',
    trendAligned: true,
    trend15mAligned: true,
    score: 82,
    dataStatus: {
      provider: 'alpaca',
      mode: 'live',
      lastUpdated: new Date().toISOString(),
      stale: false,
      ageSeconds: 2,
      message: 'live',
    },
    candles: {
      one: five,
      five,
      fifteen: five,
      daily: five,
    },
    ...overrides,
  };
}

describe('ProTrade strategy engine', () => {
  it('moves ORB retest to trade_ready or locked (session gate) when live data and risk checks pass', () => {
    const result = evaluateOrbRetest(baseInput());
    expect(result.strategyId).toBe('orb_retest');
    expect(['trade_ready', 'locked']).toContain(result.stage);
    expect(result.tradePlan?.rr).toBeGreaterThanOrEqual(1.8);
  });

  it('locks ORB retest instead of trade ready when using fallback data', () => {
    const result = evaluateOrbRetest(baseInput({
      dataStatus: {
        provider: 'yahoo',
        mode: 'fallback',
        lastUpdated: new Date().toISOString(),
        stale: false,
        ageSeconds: 5,
        message: 'fallback',
      },
    }));
    expect(result.stage).toBe('locked');
    expect(result.missing).toContain('Live data provider required for Trade Ready');
  });

  it('keeps VWAP pullback forming when direction cannot be established', () => {
    // Only 8 candles → EMA9 slope over 50m unavailable → selfDir null → no trade plan
    const result = evaluateVwapPullback(baseInput({
      price: 10.3,
      vwap: 10.45,
      vwapAligned: false,
    }));
    expect(result.stage).toBe('forming');
    expect(result.missing).toContain('Directional bias');
    expect(result.tradePlan).toBeNull();
  });

  it('blocks ORB retest when the stop width exceeds the 1.5×ATR asymmetry cap', () => {
    // Entry 0.73 above the ORB high + 1×ATR stop anchor = 1.33 risk > 0.9 cap (chase entry)
    const result = evaluateOrbRetest(baseInput({ price: 11.08 }));
    expect(result.tradePlan).toBeNull();
    expect(result.missing).toContain('Stop width ≤1.5×ATR');
  });

  it('confirms or locks RS continuation when setup is valid (session gate may apply)', () => {
    // Tight micro-range fixture: stop width must be ≤1.5% of entry for S3
    const tight = [
      candle(0, 11.0, 11.03, 10.96, 11.0),
      candle(1, 11.0, 11.04, 10.97, 11.02),
      candle(2, 11.02, 11.05, 10.98, 11.01),
      candle(3, 11.01, 11.04, 10.97, 11.0),
      candle(4, 11.0, 11.03, 10.96, 11.02),
      candle(5, 11.02, 11.05, 10.98, 11.03),
      candle(6, 11.03, 11.05, 10.99, 11.04),
      candle(7, 11.04, 11.09, 11.0, 11.08), // breaks micro-high 11.05
    ];
    const input = baseInput({
      atr20: 0.05,
      price: 11.08,
      candles: { one: tight, five: tight, fifteen: tight, daily: tight },
    });
    const result = evaluateRsContinuation(input);
    expect(['confirmed', 'locked', 'trade_ready']).toContain(result.stage);
    expect(result.tradePlan).not.toBeNull();
  });

  it('blocks stale live data from trade ready', () => {
    const result = evaluateOrbRetest(baseInput({
      dataStatus: {
        provider: 'alpaca',
        mode: 'live',
        lastUpdated: new Date(Date.now() - 120_000).toISOString(),
        stale: true,
        ageSeconds: 120,
        message: 'stale',
      },
    }));
    expect(result.stage).toBe('locked');
    expect(result.missing).toContain('Fresh market data required');
  });
});
