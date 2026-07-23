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

function paperTarget2(trade: PaperTrade) {
  return Number(trade.target2 || trade.target || paperTarget1(trade));
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
    const target2 = paperTarget2(trade);
    const trailingStop = paperTrailingStop(trade);
    const hitTarget2 = trade.direction === 'BEAR' ? current <= target2 : current >= target2;
    // 1R trigger (was T1 = 1.5R): 448-trade sample showed the median winner never
    // travelled 1.5R before EOD — winners round-tripped into losses. At +1R we bank
    // half the position (realizedPnl), move the stop to breakeven on the runner,
    // and let it work toward T2. Worst case after the partial is +0.5R.
    const initialRisk = Math.abs(trade.entry - Number(trade.stop || 0));
    // Partial distance is capped the same way the take-profit is: a full 1R sits
    // ~5% away (stops are daily-ATR denominated) and fired on only 8% of trades.
    // Half of the capped T2 distance keeps the ladder proportional — bank at the
    // midpoint of a reachable target — lifting partial fires to ~35% in replay.
    const t2Dist = Math.abs(paperTarget2(trade) - trade.entry);
    const partialDist = t2Dist > 0 ? Math.min(initialRisk, t2Dist / 2) : initialRisk;
    const oneR = trade.direction === 'BEAR' ? trade.entry - partialDist : trade.entry + partialDist;
    const hit1R = partialDist > 0 && (trade.direction === 'BEAR' ? current <= oneR : current >= oneR);
    const hitStop = trade.direction === 'BEAR' ? current >= trailingStop : current <= trailingStop;

    if (hitTarget2) {
      changed = true;
      return closePaperTrade(trade, target2, 'Target');
    }
    if (!trade.t1HitAt && hit1R) {
      changed = true;
      const partialQty = Number((trade.quantity / 2).toFixed(4));
      const banked = trade.direction === 'BEAR'
        ? (trade.entry - current) * partialQty
        : (current - trade.entry) * partialQty;
      const nowIso = new Date().toISOString();
      return {
        ...trade,
        t1HitAt: nowIso,
        partialExitAt: nowIso,
        partialExitPrice: Number(current.toFixed(2)),
        partialQty,
        realizedPnl: Number(banked.toFixed(2)),
        trailingStop: trade.entry,
      };
    }
    if (trade.t1HitAt) {
      const t1Level = target1;
      const slAtEntry = Math.abs(trailingStop - trade.entry) < 0.01;
      if (slAtEntry) {
        const pulledBackToT1 = trade.direction === 'BULL'
          ? current >= t1Level * 0.997 && current > trade.entry
          : current <= t1Level * 1.003 && current < trade.entry;
        if (pulledBackToT1) {
          changed = true;
          return { ...trade, trailingStop: t1Level };
        }
      }
    }
    if (hitStop) {
      changed = true;
      const exitPrice = trade.t1HitAt
        ? (trade.direction === 'BEAR' ? Math.min(trailingStop, current) : Math.max(trailingStop, current))
        : current;
      return closePaperTrade(trade, exitPrice, trade.t1HitAt ? 'T1 Profit' : 'Stop');
    }
    if ((trade.strategyId === 'vwap_pullback' || trade.strategyId === 'rs_continuation') && !trade.t1HitAt) {
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
