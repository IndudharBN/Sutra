import { describe, expect, it } from 'vitest';
import type { PaperTrade } from '../types';
import { monitorPaperTrades, closePaperTrade } from './monitorTrades';
import type { ProTradeRow } from './proTradeScannerApi';

function openTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 'paper-TEST-1',
    symbol: 'TEST',
    company: 'Test Corp',
    strategyId: 'ema20_bounce',
    strategyCode: 'S8',
    strategyName: 'EMA20 Bounce',
    direction: 'BULL',
    status: 'Open',
    outcome: 'Open',
    entry: 100,
    stop: 98,        // initial risk = 2 → 1R = 102
    target: 105,
    target1: 103,    // 1.5R
    target2: 105,    // 2.5R
    trailingStop: 98,
    rr: 2.5,
    rr1: 1.5,
    quantity: 100,
    notional: 10_000,
    openedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // past the 60s grace period
    reason: 'test',
    ...overrides,
  };
}

function row(price: number, vwap = 99): ProTradeRow {
  return { symbol: 'TEST', price, vwap } as unknown as ProTradeRow;
}

describe('full-exit-at-T1 engine', () => {
  // Model (2026-08-27): the WHOLE position exits at T1 — no partial, no runner, no T2.
  // Alpaca holds a resting take-profit at T1; the monitor mirrors the full close.
  it('closes the full position at T1 (BULL)', () => {
    const { trades, changed } = monitorPaperTrades([openTrade()], [row(103)]); // T1 = 103
    const t = trades[0];
    expect(changed).toBe(true);
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('Target');
    expect(t.pnl).toBe((103 - 100) * 100);   // full 100 shares × 3 = 300
    expect(t.partialExitAt).toBeUndefined(); // no partial ever fires
    expect(t.partialQty).toBeUndefined();
  });

  it('does NOT exit before T1 — stays open between entry and T1', () => {
    const { trades } = monitorPaperTrades([openTrade()], [row(102)]); // +1R but below T1(103)
    const t = trades[0];
    expect(t.status).toBe('Open');
    expect(t.partialExitAt).toBeUndefined();
  });

  it('full stop-out loses on the whole position', () => {
    const { trades } = monitorPaperTrades([openTrade()], [row(97.9)]);
    const t = trades[0];
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('Stop');
    expect(t.pnl).toBeCloseTo((97.9 - 100) * 100, 2);
  });

  it('closes the full position at T1 (BEAR)', () => {
    const bear = openTrade({ direction: 'BEAR', entry: 100, stop: 102, target1: 97, target2: 95, trailingStop: 102 });
    const { trades } = monitorPaperTrades([bear], [row(97, 101)]); // T1 = 97
    const t = trades[0];
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('Target');
    expect(t.pnl).toBe((100 - 97) * 100);    // full 100 shares × 3 = 300
  });

  it('legacy trades without partial fields close with the original full-quantity math', () => {
    const legacy = openTrade({ trailingStop: 100 });
    const closed = closePaperTrade(legacy, 101, 'EOD');
    expect(closed.pnl).toBe((101 - 100) * 100); // full qty, no realizedPnl
  });
});

describe('MFE/MAE excursion instrumentation', () => {
  it('records favorable excursion without triggering any exit', () => {
    const { trades } = monitorPaperTrades([openTrade()], [row(101.5)]); // +0.75R, below 1R
    const t = trades[0];
    expect(t.status).toBe('Open');
    expect(t.mfe).toBeCloseTo(1.5, 4);
    expect(t.mae).toBe(0);
    expect(t.partialExitAt).toBeUndefined();
  });

  it('records adverse excursion and keeps the high-water mark across ticks', () => {
    const a = monitorPaperTrades([openTrade()], [row(101)]).trades[0];   // +1.0 favorable
    const b = monitorPaperTrades([a], [row(99)]).trades[0];              // -1.0 adverse
    expect(b.mfe).toBeCloseTo(1, 4);   // high-water mark retained
    expect(b.mae).toBeCloseTo(1, 4);
  });

  it('tracks excursion during the 60s grace period', () => {
    const fresh = openTrade({ openedAt: new Date().toISOString() });
    const { trades } = monitorPaperTrades([fresh], [row(102)]);
    const t = trades[0];
    expect(t.mfe).toBeCloseTo(2, 4);      // captured despite grace period
    expect(t.partialExitAt).toBeUndefined(); // but no exit logic ran
  });

  it('BEAR trades measure excursion in the inverted direction', () => {
    const bear = openTrade({ direction: 'BEAR', entry: 100, stop: 102, target1: 97, target2: 95, trailingStop: 102 });
    const { trades } = monitorPaperTrades([bear], [row(98.5, 101)]);
    expect(trades[0].mfe).toBeCloseTo(1.5, 4);
    expect(trades[0].mae).toBe(0);
  });
});
