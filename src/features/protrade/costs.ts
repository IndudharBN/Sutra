// Trading-cost model for the backtest (and anything else that needs a realistic fill).
//
// Pure arithmetic, no I/O. Before this existed the backtest filled every entry at
// the next open and every exit at the exact stop/target/close — free fills. On
// small intraday targets that overstates edge, because the spread + slippage paid
// on a stop-out is a large fraction of 1R.
//
// What costs what:
//   - Resting LIMIT exits (profit targets) fill at their price: no spread paid.
//   - MARKET fills (entry, stop-out, end-of-day flatten) cross the spread and slip.
//   - Stop exits pay extra: a triggered stop is a market order into a moving tape.
//   - Impact follows the square-root law: Y * sigma_daily * sqrt(shares / ADV).
//     Negligible at our sizes but kept so larger sizing can't silently look free.
//   - Alpaca is commission-free, so commissionPerShare defaults to 0.
//
// DEFAULTS CALIBRATED 2026-11-15 from 428 real Alpaca-reconciled fills since 2026-08-27
// (scripts/calibrate-costs.mjs; re-run it as more fills accumulate):
//   - ENTRY fill vs prior 1m close: median 3.8 bps, mean 7.3 bps (proxy, includes noise) -> halfSpreadBps 5.
//   - STOP exit vs planned stop (n=65): median 3.0 bps adverse, mean -3.3 bps (outliers fill BETTER),
//     p75 12 bps. The half-spread already charged on a stop covers the median, so stopSlipBps = 0
//     (the engine separately fills at the bar OPEN when a bar gaps through the stop).
//   - TARGET exits: NOT clean limit fills — 37% at/above T1, the rest below it (e.g. exits between
//     entry and T1 labelled 'Target'). Something closes winners before T1; that is an exit-logic
//     difference to investigate, not slippage, so limit fills stay free here.
// Same costs hit every strategy, so relative comparisons are meaningful regardless.

export interface TradingCosts {
  /** $ per share per side (Alpaca equities: 0). */
  commissionPerShare: number;
  /** Half the bid-ask spread, in bps of price, paid on every market fill. */
  halfSpreadBps: number;
  /** Extra adverse slippage on a triggered stop, in bps of price. */
  stopSlipBps: number;
  /** Square-root-law impact coefficient (published fits 0.5-1.0); 0 disables. */
  impactY: number;
}

export const DEFAULT_COSTS: TradingCosts = {
  commissionPerShare: 0,
  halfSpreadBps: 5,
  stopSlipBps: 0,
  impactY: 0.5,
};

export const ZERO_COSTS: TradingCosts = {
  commissionPerShare: 0,
  halfSpreadBps: 0,
  stopSlipBps: 0,
  impactY: 0,
};

export type FillKind = 'limit' | 'market' | 'stop';

export interface FillContext {
  shares: number;
  /** Average daily volume in shares (previous day's volume is a fine proxy). */
  adv?: number;
  /** Daily volatility as a fraction of price (e.g. ATR20 / price). */
  sigmaDaily?: number;
}

/**
 * Price actually received/paid. `side` is the side of THIS fill: a long entry and
 * a short cover are 'buy' (price moves up against us); a long exit and a short
 * entry are 'sell' (price moves down against us).
 */
export function fillPrice(
  side: 'buy' | 'sell',
  price: number,
  kind: FillKind,
  ctx: FillContext,
  costs: TradingCosts,
): number {
  if (kind === 'limit' || !(price > 0)) return price;
  const bps = costs.halfSpreadBps + (kind === 'stop' ? costs.stopSlipBps : 0);
  let adverse = price * (bps / 10_000);
  if (costs.impactY > 0 && ctx.adv && ctx.adv > 0 && ctx.sigmaDaily && ctx.sigmaDaily > 0 && ctx.shares > 0) {
    adverse += costs.impactY * ctx.sigmaDaily * Math.sqrt(ctx.shares / ctx.adv) * price;
  }
  return side === 'buy' ? price + adverse : price - adverse;
}

/** Commission for one side of a trade. */
export function commission(shares: number, costs: TradingCosts): number {
  return Math.max(0, shares) * costs.commissionPerShare;
}
