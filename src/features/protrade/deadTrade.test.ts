import { describe, expect, it } from 'vitest';
import { deadCheckDue, isDeadTrade } from './deadTrade';

const ctx = (o: Partial<{ etMinClose: number; heldMin: number; mfeR: number; unrealizedR: number }> = {}) => ({
  etMinClose: 12 * 60 + 30, heldMin: 90, mfeR: 0.1, unrealizedR: -0.2, ...o,
});

describe('dead-trade rule', () => {
  it('is not due before the clock time', () => {
    expect(deadCheckDue({ atEtMin: 750 }, ctx({ etMinClose: 749 }))).toBe(false);
    expect(deadCheckDue({ atEtMin: 750 }, ctx({ etMinClose: 750 }))).toBe(true);
  });

  it('hold-time variant uses minutes since entry', () => {
    expect(deadCheckDue({ afterHoldMin: 90 }, ctx({ heldMin: 89 }))).toBe(false);
    expect(deadCheckDue({ afterHoldMin: 90 }, ctx({ heldMin: 90 }))).toBe(true);
  });

  it('a rule with no time condition never fires', () => {
    expect(isDeadTrade({ minProgressR: 0.3 }, ctx())).toBe(false);
  });

  it('exits a trade that never made progress, keeps one that did', () => {
    const rule = { atEtMin: 750, minProgressR: 0.3 };
    expect(isDeadTrade(rule, ctx({ mfeR: 0.1 }))).toBe(true);
    expect(isDeadTrade(rule, ctx({ mfeR: 0.3 }))).toBe(false);   // exactly at the bar -> survives
    expect(isDeadTrade(rule, ctx({ mfeR: 0.8 }))).toBe(false);
  });

  it('requireLosing exits only flat/losing trades even if they once had progress', () => {
    const rule = { atEtMin: 750, requireLosing: true };
    expect(isDeadTrade(rule, ctx({ mfeR: 0.9, unrealizedR: -0.1 }))).toBe(true);
    expect(isDeadTrade(rule, ctx({ mfeR: 0.0, unrealizedR: 0 }))).toBe(true);
    expect(isDeadTrade(rule, ctx({ mfeR: 0.0, unrealizedR: 0.2 }))).toBe(false);
  });

  it('does nothing before the check is due, whatever the trade looks like', () => {
    expect(isDeadTrade({ atEtMin: 750, minProgressR: 0.3 }, ctx({ etMinClose: 700, mfeR: 0 }))).toBe(false);
  });
});
