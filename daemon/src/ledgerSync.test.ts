import { describe, expect, it } from 'vitest';
import { classifyExit, closePnl, findClosingFill, planCarryClose, planLedgerSync } from './ledgerSync';
import type { SyncFill, SyncTrade } from './ledgerSync';

const T0 = Date.parse('2026-11-16T15:00:00Z'); // 10:00 ET
const trade = (o: Partial<SyncTrade> = {}): SyncTrade => ({
  id: 't1', symbol: 'VIR', direction: 'BEAR', entry: 10, stop: 10.5, target1: 9.5, quantity: 100, notional: 1000,
  openedAt: new Date(T0).toISOString(), ...o,
});
const fill = (o: Partial<SyncFill> = {}): SyncFill => ({ side: 'buy', filled_avg_price: '9.80', filled_at: '2026-11-17T14:30:05Z', ...o });
const NOW = Date.parse('2026-11-17T15:00:00Z');
const base = { positionSymbols: new Set<string>(), pendingOrderSymbols: new Set<string>(), nowMs: NOW };

describe('ledger sync planner', () => {
  it('closes a ghost short at the REAL cover fill and flags it as an overnight carry', () => {
    const plan = planLedgerSync({ ...base, openTrades: [trade()], fillsBySymbol: { VIR: [fill()] } });
    expect(plan.closes).toHaveLength(1);
    const c = plan.closes[0];
    expect(c.exitPrice).toBe(9.8);
    expect(c.pnl).toBe(20);            // (10 - 9.8) * 100
    expect(c.carry).toBe(true);
    expect(c.outcome).toBe('EOD');
    expect(plan.unresolved).toEqual([]);
  });

  it('never closes on "position missing" alone: no closing fill => unresolved, row left open', () => {
    const plan = planLedgerSync({ ...base, openTrades: [trade()], fillsBySymbol: { VIR: [] } });
    expect(plan.closes).toEqual([]);
    expect(plan.unresolved).toEqual(['VIR']);
  });

  it('ignores same-side fills (the entry itself) and fills from before the entry', () => {
    const entryFill = fill({ side: 'sell', filled_at: new Date(T0 + 1000).toISOString() });
    const stale = fill({ side: 'buy', filled_at: new Date(T0 - 3600_000).toISOString() });
    expect(findClosingFill(trade(), [entryFill, stale])).toBeNull();
  });

  it('long trades are closed by SELL fills, shorts by BUY fills', () => {
    const long = trade({ direction: 'BULL', symbol: 'MSFT', entry: 100, stop: 98, target1: 103 });
    expect(findClosingFill(long, [fill({ side: 'buy' })])).toBeNull();
    expect(findClosingFill(long, [fill({ side: 'sell' })])).not.toBeNull();
  });

  it('leaves held positions, pending orders and brand-new rows alone', () => {
    const f = { VIR: [fill()] };
    expect(planLedgerSync({ ...base, positionSymbols: new Set(['VIR']), openTrades: [trade()], fillsBySymbol: f }).closes).toEqual([]);
    expect(planLedgerSync({ ...base, pendingOrderSymbols: new Set(['VIR']), openTrades: [trade()], fillsBySymbol: f }).closes).toEqual([]);
    expect(planLedgerSync({ ...base, nowMs: T0 + 60_000, openTrades: [trade()], fillsBySymbol: f }).closes).toEqual([]);
  });

  it('each fill closes at most one row (two same-symbol re-entries)', () => {
    const a = trade({ id: 'a' });
    const b = trade({ id: 'b', openedAt: new Date(T0 + 3600_000).toISOString() });
    const fills = [fill({ filled_at: '2026-11-16T18:00:00Z', filled_avg_price: '9.9' }), fill({ filled_at: '2026-11-16T19:00:00Z', filled_avg_price: '9.7' })];
    const plan = planLedgerSync({ ...base, openTrades: [b, a], fillsBySymbol: { VIR: fills } });
    expect(plan.closes.map((c) => [c.id, c.exitPrice])).toEqual([['a', 9.9], ['b', 9.7]]);
  });

  it('classifies target / stop / manual / carry exits', () => {
    expect(classifyExit(trade(), 9.49, false)).toBe('Target');
    expect(classifyExit(trade(), 10.52, false)).toBe('Stop');
    expect(classifyExit(trade(), 9.9, false)).toBe('Manual');
    expect(classifyExit(trade(), 9.9, true)).toBe('EOD');
    const long = trade({ direction: 'BULL', entry: 100, stop: 98, target1: 103 });
    expect(classifyExit(long, 103.2, false)).toBe('Target');
    expect(classifyExit(long, 97.9, false)).toBe('Stop');
  });

  it('P&L matches the monitor: remaining shares + banked partial', () => {
    expect(closePnl(trade({ direction: 'BULL', entry: 100, quantity: 10 }), 101).pnl).toBe(10);
    expect(closePnl(trade({ direction: 'BEAR', entry: 100, quantity: 10, partialQty: 4, realizedPnl: 5 }), 99).pnl).toBe(11); // 6 left * 1 + 5
  });
});

describe('post-close carry guard', () => {
  it('queues a close once per position with no order; never re-queues', () => {
    const queued = new Set<string>();
    expect(planCarryClose(['VIR', 'msft'], new Set(['VIR']), queued)).toEqual(['MSFT']);
    queued.add('MSFT');
    expect(planCarryClose(['VIR', 'msft'], new Set(['VIR']), queued)).toEqual([]);
  });
});
