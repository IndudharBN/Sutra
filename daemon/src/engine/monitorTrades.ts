import type { PaperTrade } from '../types';
import type { ProTradeRow } from './proTradeScannerApi';

function baseSymbol(symbol: string): string {
  return symbol.replace(/\s+\d+\/\d+.*$/, '').trim().toUpperCase();
}

function paperPnl(trade: PaperTrade, exitPrice: number) {
  // After a 1R partial, only the runner half is still open — final P&L is the
  // remainder's move plus the already-banked realizedPnl from the partial.
  const remainingQty = trade.quantity - (trade.partialQty ?? 0);
  const move = trade.direction === 'BEAR'
    ? (trade.entry - exitPrice)
    : (exitPrice - trade.entry);
  const gross = move * remainingQty + (trade.realizedPnl ?? 0);
  return {
    pnl: Number(gross.toFixed(2)),
    pnlPercent: Number((gross / trade.notional * 100).toFixed(2)),
  };
}

export function closePaperTrade(
  trade: PaperTrade,
  exitPrice: number,
  outcome: PaperTrade['outcome'],
  closedAt = new Date().toISOString(),
): PaperTrade {
  const result = paperPnl(trade, exitPrice);
  const correctedOutcome: PaperTrade['outcome'] = outcome === 'Stop' && result.pnl > 0 ? 'Manual' : outcome;
  return {
    ...trade,
    status: 'Closed',
    outcome: correctedOutcome,
    exitPrice: Number(exitPrice.toFixed(2)),
    pnl: result.pnl,
    pnlPercent: result.pnlPercent,
    closedAt,
  };
}

function paperTarget1(trade: PaperTrade) {
  return Number(trade.target1 || trade.target || 0);
}

function paperTrailingStop(trade: PaperTrade) {
  return Number(trade.trailingStop || trade.stop || 0);
}

export function monitorPaperTrades(
  trades: PaperTrade[],
  rows: ProTradeRow[],
): { trades: PaperTrade[]; changed: boolean } {
  const priceBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.price]));
  const vwapBySymbol = new Map(rows.map((row) => [baseSymbol(row.symbol), row.vwap]));
  let changed = false;
  const now = Date.now();

  const next = trades.map((trade0) => {
    if (trade0.status !== 'Open') return trade0;
    const current = priceBySymbol.get(baseSymbol(trade0.symbol));
    if (!current) return trade0;

    // Excursion tracking runs BEFORE the 60s grace period and before any exit
    // branch, so the first minute's move is captured and every trade carries a
    // complete MFE/MAE by the time it closes. Instrumentation only: these fields
    // are never read by exit logic, sizing, or gating.
    const favorable = trade0.direction === 'BEAR' ? trade0.entry - current : current - trade0.entry;
    const adverse = -favorable;
    const mfe = Math.max(trade0.mfe ?? 0, favorable, 0);
    const mae = Math.max(trade0.mae ?? 0, adverse, 0);
    const trade = (mfe !== (trade0.mfe ?? 0) || mae !== (trade0.mae ?? 0))
      ? { ...trade0, mfe: Number(mfe.toFixed(4)), mae: Number(mae.toFixed(4)) }
      : trade0;
    if (trade !== trade0) changed = true;

    if (now - new Date(trade.openedAt).getTime() < 60_000) return trade;

    const target1 = paperTarget1(trade);
    const trailingStop = paperTrailingStop(trade);
    // FULL EXIT AT T1 (user directive 2026-08-27): the whole position exits at T1 —
    // no partial, no runner, no T2. Alpaca holds a resting take-profit limit at T1
    // (set in scheduler's placePaperBracketOrder), and this monitor mirrors the same
    // full close. Rationale: T1-reachers were 98% WR while runners rarely reached T2,
    // so banking the whole position at T1 captures the edge without round-tripping.
    const hitTarget1 = trade.direction === 'BEAR' ? current <= target1 : current >= target1;
    const hitStop = trade.direction === 'BEAR' ? current >= trailingStop : current <= trailingStop;

    if (hitTarget1) {
      changed = true;
      return closePaperTrade(trade, target1, 'Target');
    }
    // Full-exit-at-T1 model: no partial/runner, so a trade is only ever Open until it
    // hits T1 (win) or the stop (loss). The stop is the ORIGINAL stop the whole time.
    if (hitStop) {
      changed = true;
      return closePaperTrade(trade, current, 'Stop');
    }
    if (trade.strategyId === 'vwap_pullback' || trade.strategyId === 'rs_continuation') {
      const vwap = vwapBySymbol.get(baseSymbol(trade.symbol));
      // Buffered re-cross (was one tick through VWAP): S2 enters just above VWAP by
      // construction, so a zero-tolerance re-cross executed 23/25 trades at avg -0.12R
      // before the thesis could express — every reclaim retest was instant death.
      // Require price to be through VWAP by 25% of the trade's initial risk before
      // conceding: cuts genuine failures at ~-0.3R, survives the normal retest wiggle.
      const rescueBuffer = Math.abs(trade.entry - Number(trade.stop || 0)) * 0.25;
      if (vwap && (trade.direction === 'BULL'
        ? current < vwap - rescueBuffer
        : current > vwap + rescueBuffer)) {
        changed = true;
        return closePaperTrade(trade, current, 'Stop');
      }
    }
    return trade;
  });

  return { trades: next, changed };
}
