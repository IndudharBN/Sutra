import { describe, expect, it } from 'vitest';
import { evaluateProtections } from './protections';

const NOW = Date.parse('2026-11-16T16:00:00Z'); // Monday 11:00 ET
const closed = (minsAgo: number, pnl: number, extra: object = {}) => ({
  status: 'Closed', pnl, closedAt: new Date(NOW - minsAgo * 60_000).toISOString(), ...extra,
});
const base = { nowMs: NOW, accountBalance: 100_000 };

describe('protections', () => {
  it('passes with no trades and no control file', () => {
    expect(evaluateProtections({ ...base, trades: [] })).toEqual({ ok: true, sizeMult: 1, reasons: [] });
  });

  it('kill switch halts; expired haltUntil does not; bad shape ignored', () => {
    expect(evaluateProtections({ ...base, trades: [], control: { halt: true, reason: 'manual' } }).ok).toBe(false);
    const future = new Date(NOW + 60_000).toISOString();
    const past = new Date(NOW - 60_000).toISOString();
    expect(evaluateProtections({ ...base, trades: [], control: { halt: true, haltUntil: future } }).ok).toBe(false);
    expect(evaluateProtections({ ...base, trades: [], control: { halt: true, haltUntil: past } }).ok).toBe(true);
    expect(evaluateProtections({ ...base, trades: [], control: { halt: false } }).ok).toBe(true);
  });

  it('control sizeMult is shrink-only', () => {
    expect(evaluateProtections({ ...base, trades: [], control: { sizeMult: 0.5 } }).sizeMult).toBe(0.5);
    expect(evaluateProtections({ ...base, trades: [], control: { sizeMult: 2 } }).sizeMult).toBe(1);
  });

  it('3 straight losses today pause entries, then release after the cool-down', () => {
    const trades = [closed(50, -20), closed(30, -20), closed(10, -20)];
    const r = evaluateProtections({ ...base, trades });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/LOSS STREAK/);
    const later = [closed(200, -20), closed(190, -20), closed(180, -20)]; // last loss 3h ago > 45m
    expect(evaluateProtections({ ...base, trades: later }).ok).toBe(true);
  });

  it('a win in the last 3 breaks the streak', () => {
    const trades = [closed(50, -20), closed(30, 15), closed(10, -20)];
    expect(evaluateProtections({ ...base, trades }).ok).toBe(true);
  });

  it('ignores phantom / open / unclosed rows', () => {
    const trades = [closed(5, -20, { phantom: true }), closed(4, -20, { status: 'Open' }), closed(3, -20, { closedAt: undefined })];
    expect(evaluateProtections({ ...base, trades }).ok).toBe(true);
  });

  it('rolling drawdown halves size at -1% and halts at -2.5%', () => {
    const half = evaluateProtections({ ...base, trades: [closed(60 * 24 * 3, -1200)] });
    expect(half.ok).toBe(true);
    expect(half.sizeMult).toBe(0.5);
    const halt = evaluateProtections({ ...base, trades: [closed(60 * 24 * 3, -2600)] });
    expect(halt.ok).toBe(false);
    expect(halt.reasons[0]).toMatch(/DRAWDOWN HALT/);
  });

  it('losses older than the window do not count', () => {
    expect(evaluateProtections({ ...base, trades: [closed(60 * 24 * 10, -5000)] }).sizeMult).toBe(1);
  });
});
