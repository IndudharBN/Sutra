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

describe('1R partial exit engine', () => {
  it('banks half at +1R and moves the stop to breakeven', () => {
    const { trades, changed } = monitorPaperTrades([openTrade()], [row(102)]);
    const t = trades[0];
    expect(changed).toBe(true);
    expect(t.status).toBe('Open');
    expect(t.partialExitAt).toBeTruthy();
    expect(t.partialQty).toBe(50);
    expect(t.realizedPnl).toBe(100);        // (102-100) × 50
    expect(t.trailingStop).toBe(100);       // breakeven
    expect(t.t1HitAt).toBeTruthy();
  });

  it('runner stopped at breakeven keeps the banked partial (worst case +0.5R)', () => {
    const afterPartial = monitorPaperTrades([openTrade()], [row(102)]).trades[0];
    const { trades } = monitorPaperTrades([afterPartial], [row(100)]); // pulls back to entry
    const t = trades[0];
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('T1 Profit');
    expect(t.pnl).toBe(100);                // banked partial only; runner flat at BE
  });

  it('runner reaching T2 books remainder at target plus the banked partial', () => {
    const afterPartial = monitorPaperTrades([openTrade()], [row(102)]).trades[0];
    const { trades } = monitorPaperTrades([afterPartial], [row(105.2)]);
    const t = trades[0];
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('Target');
    expect(t.pnl).toBe(100 + (105 - 100) * 50); // 100 banked + 5×50 runner = 350
  });

  it('full stop-out before 1R loses on the whole position (no partial)', () => {
    const { trades } = monitorPaperTrades([openTrade()], [row(97.9)]);
    const t = trades[0];
    expect(t.status).toBe('Closed');
    expect(t.outcome).toBe('Stop');
    expect(t.partialExitAt).toBeUndefined();
    expect(t.pnl).toBeCloseTo((97.9 - 100) * 100, 2);
  });

  it('BEAR trade banks the partial on a downward 1R move', () => {
    const bear = openTrade({ direction: 'BEAR', entry: 100, stop: 102, target1: 97, target2: 95, trailingStop: 102 });
    const { trades } = monitorPaperTrades([bear], [row(98, 101)]); // 1R = 98
    const t = trades[0];
    expect(t.partialQty).toBe(50);
    expect(t.realizedPnl).toBe(100);        // (100-98) × 50
    expect(t.trailingStop).toBe(100);
  });

  it('legacy trades without partial fields close with the original full-quantity math', () => {
    const legacy = openTrade({ t1HitAt: new Date().toISOString(), trailingStop: 100 });
    const closed = closePaperTrade(legacy, 101, 'EOD');
    expect(closed.pnl).toBe((101 - 100) * 100); // no partialQty → full qty, no realizedPnl
  });
});
