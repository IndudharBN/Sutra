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

  const next = trades.map((trade) => {
    if (trade.status !== 'Open') return trade;
    if (now - new Date(trade.openedAt).getTime() < 60_000) return trade;
    const current = priceBySymbol.get(baseSymbol(trade.symbol));
    if (!current) return trade;

    const target1 = paperTarget1(trade);
    const target2 = paperTarget2(trade);
    const trailingStop = paperTrailingStop(trade);
    const hitTarget2 = trade.direction === 'BEAR' ? current <= target2 : current >= target2;
    // 1R trigger (was T1 = 1.5R): 448-trade sample showed the median winner never
    // travelled 1.5R before EOD — winners round-tripped into losses. At +1R we bank
    // half the position (realizedPnl), move the stop to breakeven on the runner,
    // and let it work toward T2. Worst case after the partial is +0.5R.
    const initialRisk = Math.abs(trade.entry - Number(trade.stop || 0));
    const oneR = trade.direction === 'BEAR' ? trade.entry - initialRisk : trade.entry + initialRisk;
    const hit1R = initialRisk > 0 && (trade.direction === 'BEAR' ? current <= oneR : current >= oneR);
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
      if (vwap && (trade.direction === 'BULL' ? current < vwap : current > vwap)) {
        changed = true;
        return closePaperTrade(trade, current, 'Stop');
      }
    }
    return trade;
  });

  return { trades: next, changed };
}
