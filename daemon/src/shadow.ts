// Shadow mode for the dead-trade exit rules — PURE planning logic, no orders, no exits.
//
// Backtest (40 symbols, 25 days, 558 trades): exiting trades that have shown no progress by 12:30 / 13:30 ET
// improved profit factor both overall and on held-out days (A: 0.95 -> 1.01 / 1.07 held-out; B: 1.02 / 1.08), mainly by
// avoiding later stop-outs and end-of-day drift, at the cost of a few winners. The effect (~$2-3/trade) is
// below the noise of a 25-day sample, so it is NOT enforced. Instead the daemon records, per open trade, what each
// rule WOULD have done; after ~2 weeks scripts/shadow-deadtrade-report.mjs compares that with what really happened.
//
// Nothing here changes behaviour: the result is written to an optional `shadow` field on the ledger row.

import { deadCheckDue, isDeadTrade } from './engine/deadTrade';
import type { DeadTradeRule } from './engine/deadTrade';
import { etMinutes } from './engine/entryGate';
import type { PaperTrade, ShadowDeadCheck } from './types';

export const SHADOW_RULES: Record<string, DeadTradeRule> = {
  A: { atEtMin: 12 * 60 + 30, minProgressR: 0.3 }, // 12:30 ET: exit if best move so far < +0.3R
  B: { atEtMin: 13 * 60 + 30, minProgressR: 0.3 }, // 13:30 ET: same rule, later
};

export interface ShadowUpdate { id: string; rule: string; check: ShadowDeadCheck }

export function planShadowDead(
  trades: PaperTrade[],
  priceBySymbol: Map<string, number>,
  nowMs: number,
  rules: Record<string, DeadTradeRule> = SHADOW_RULES,
): ShadowUpdate[] {
  const out: ShadowUpdate[] = [];
  for (const t of trades) {
    if (t.status !== 'Open' || t.direction === 'NEUTRAL') continue;
    const R = Math.abs(t.entry - t.stop);
    const price = priceBySymbol.get(t.symbol);
    if (!(R > 0) || !(price && price > 0)) continue;
    const openedMs = Date.parse(t.openedAt);
    const ctx = {
      etMinClose: etMinutes(nowMs),
      entryEtMin: etMinutes(openedMs),
      heldMin: (nowMs - openedMs) / 60_000,
      mfeR: (t.mfe ?? 0) / R,
      unrealizedR: (t.direction === 'BULL' ? price - t.entry : t.entry - price) / R,
    };
    for (const [key, rule] of Object.entries(rules)) {
      if (t.shadow && t.shadow[key]) continue; // each rule is judged once per trade
      if (!deadCheckDue(rule, ctx)) continue;
      out.push({
        id: t.id,
        rule: key,
        check: {
          dead: isDeadTrade(rule, ctx),
          at: new Date(nowMs).toISOString(),
          price,
          unrealizedR: Number(ctx.unrealizedR.toFixed(3)),
          mfeR: Number(ctx.mfeR.toFixed(3)),
        },
      });
    }
  }
  return out;
}
