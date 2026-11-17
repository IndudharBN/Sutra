import { describe, expect, it } from 'vitest';
import { planShadowDead } from './shadow';
import type { PaperTrade } from './types';

// 2026-11-17 is EST (UTC-5): 17:35Z = 12:35 ET, 18:35Z = 13:35 ET, 15:00Z = 10:00 ET
const at = (iso: string) => Date.parse(iso);
const trade = (o: Partial<PaperTrade> = {}): PaperTrade => ({
  id: 't1', symbol: 'VIR', direction: 'BULL', status: 'Open', entry: 100, stop: 98, quantity: 10, notional: 1000,
  openedAt: '2026-11-17T15:00:00Z', mfe: 0.2, ...o,
} as unknown as PaperTrade);
const px = (v: number) => new Map([['VIR', v]]);

describe('shadow dead-trade planner', () => {
  it('does nothing before 12:30 ET', () => {
    expect(planShadowDead([trade()], px(100), at('2026-11-17T17:25:00Z'))).toEqual([]);
  });

  it('flags a trade with no progress at 12:30 (rule A only), recording price and R values', () => {
    const u = planShadowDead([trade()], px(99), at('2026-11-17T17:35:00Z'));
    expect(u.map((x) => x.rule)).toEqual(['A']);
    expect(u[0].check).toMatchObject({ dead: true, price: 99, unrealizedR: -0.5, mfeR: 0.1 });
  });

  it('marks a trade that DID progress as checked-but-not-dead (so it is not re-judged)', () => {
    const u = planShadowDead([trade({ mfe: 1.2 })], px(101), at('2026-11-17T17:35:00Z'));
    expect(u[0].check.dead).toBe(false);
    const again = planShadowDead([trade({ mfe: 1.2, shadow: { A: u[0].check } })], px(101), at('2026-11-17T17:36:00Z'));
    expect(again).toEqual([]);
  });

  it('rule B joins at 13:30 ET', () => {
    const u = planShadowDead([trade({ shadow: { A: { dead: false, at: 'x', price: 1, unrealizedR: 0, mfeR: 0 } } })], px(100), at('2026-11-17T18:35:00Z'));
    expect(u.map((x) => x.rule)).toEqual(['B']);
  });

  it('a trade entered AFTER the check time is not judged by it (the 1pm case)', () => {
    const late = trade({ openedAt: '2026-11-17T18:00:00Z' }); // 13:00 ET
    expect(planShadowDead([late], px(100), at('2026-11-17T18:10:00Z'))).toEqual([]);   // past 12:30, but not open then
  });

  it('shorts: unrealized R has the right sign', () => {
    const u = planShadowDead([trade({ direction: 'BEAR', entry: 100, stop: 102, mfe: 0 })], px(99), at('2026-11-17T17:35:00Z'));
    expect(u[0].check.unrealizedR).toBe(0.5);
  });

  it('skips closed rows, missing prices and degenerate stops', () => {
    expect(planShadowDead([trade({ status: 'Closed' })], px(99), at('2026-11-17T17:35:00Z'))).toEqual([]);
    expect(planShadowDead([trade()], new Map(), at('2026-11-17T17:35:00Z'))).toEqual([]);
    expect(planShadowDead([trade({ stop: 100 })], px(99), at('2026-11-17T17:35:00Z'))).toEqual([]);
  });
});
