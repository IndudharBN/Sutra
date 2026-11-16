// "Dead trade" exit rule — pure logic, used by the backtest to test time-stops.
//
// Motivation (real fills since 2026-08-27, 429 trades): 70% of trades reach neither target nor
// stop and are flattened at the close (median hold 274 min, avg -0.36%, net -$8.5k). 77% of
// those never got +0.5R in their favour and none reached +1R: the move simply isn't there, and
// nothing exits them. This rule exits a trade that has not made progress by a given time.
//
// It is an EXPERIMENT hook: nothing in the live daemon uses it.

export interface DeadTradeRule {
  /** Check once, at the first bar close at/after this ET minute-of-day (e.g. 750 = 12:30). */
  atEtMin?: number;
  /** ...or once this many minutes after entry (used when atEtMin is omitted). */
  afterHoldMin?: number;
  /** Dead if the best favourable excursion so far is below this many R (R = entry-to-stop distance). */
  minProgressR?: number;
  /** Dead only if currently flat or losing (unrealized <= 0), regardless of past excursion. */
  requireLosing?: boolean;
}

export interface DeadTradeCtx {
  /** ET minute-of-day at the CLOSE of the bar being evaluated. */
  etMinClose: number;
  /** Minutes since entry at that bar close. */
  heldMin: number;
  /** Best favourable excursion since entry, in R. */
  mfeR: number;
  /** Current open P&L in R (negative = losing). */
  unrealizedR: number;
}

/** Is the time condition for the check satisfied yet? */
export function deadCheckDue(rule: DeadTradeRule, ctx: DeadTradeCtx): boolean {
  if (rule.atEtMin !== undefined) return ctx.etMinClose >= rule.atEtMin;
  if (rule.afterHoldMin !== undefined) return ctx.heldMin >= rule.afterHoldMin;
  return false;
}

/** Evaluate the rule at a due check point: true => exit the trade at market. */
export function isDeadTrade(rule: DeadTradeRule, ctx: DeadTradeCtx): boolean {
  if (!deadCheckDue(rule, ctx)) return false;
  if (rule.requireLosing) return ctx.unrealizedR <= 0;
  return ctx.mfeR < (rule.minProgressR ?? 0);
}
