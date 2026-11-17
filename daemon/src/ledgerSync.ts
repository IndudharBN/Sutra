// Ledger <-> broker synchronisation — PURE planning logic (no I/O), unit-tested.
//
// Why this exists: Alpaca is the source of truth for what we hold. The ledger (trades.json) drifted
// from it whenever a position was closed at the broker without the daemon booking it — the EOD
// flatten skipped (PC asleep), or the flatten queued after the close and filled at the next open.
// Result: "ghost" Open rows that (a) consumed the 65% notional budget and the sector/beta caps, so
// real entries were refused or undersized, and (b) were later booked at the monitor's PLANNED price
// instead of the real fill. Oct 15->16 and Nov 5->6 carried positions cost -$8.5k that never showed up
// in any trade row.
//
// Safety rules baked into the planner:
//   * a row is closed ONLY when a real closing fill (opposite side, after the entry) is found —
//     never on "position missing" alone, so an empty/failed positions response cannot fabricate P&L;
//   * rows younger than minAgeMs are left alone (fill booking races);
//   * symbols with a pending order or a live position are left alone.

import { etDateKey } from './engine/entryGate';

export interface SyncTrade {
  id: string;
  symbol: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  entry: number;
  stop: number;
  target?: number;
  target1?: number;
  quantity: number;
  partialQty?: number;
  realizedPnl?: number;
  notional: number;
  openedAt: string;
}

export interface SyncFill {
  side: string; // Alpaca order side: 'buy' | 'sell' (| 'sell_short' on some activity types)
  filled_avg_price: string | null;
  filled_at: string | null;
}

export type SyncOutcome = 'Target' | 'Stop' | 'EOD' | 'Manual';

export interface SyncClose {
  id: string;
  symbol: string;
  exitPrice: number;
  closedAt: string;
  outcome: SyncOutcome;
  pnl: number;
  pnlPercent: number;
  /** Closed on a different ET day than it was opened: an overnight carry, not a strategy exit. */
  carry: boolean;
}

export interface SyncPlan { closes: SyncClose[]; unresolved: string[] }

/** The order side that CLOSES this trade: sells close longs, buys cover shorts. */
export function exitSide(direction: SyncTrade['direction']): 'sell' | 'buy' | null {
  if (direction === 'BULL') return 'sell';
  if (direction === 'BEAR') return 'buy';
  return null;
}

/** Earliest exit-side fill after entry that has not already been claimed. */
export function findClosingFill(trade: SyncTrade, fills: SyncFill[], claimed: Set<SyncFill> = new Set()): SyncFill | null {
  const want = exitSide(trade.direction);
  if (!want) return null;
  const opened = Date.parse(trade.openedAt);
  const candidates = fills
    .filter((f) => !claimed.has(f)
      && f.filled_at && f.filled_avg_price !== null
      && f.side === want
      && Date.parse(f.filled_at) > opened
      && Number(f.filled_avg_price) > 0)
    .sort((a, b) => Date.parse(a.filled_at as string) - Date.parse(b.filled_at as string));
  return candidates[0] ?? null;
}

/** P&L the same way the monitor books it: remaining shares' move plus any banked partial. */
export function closePnl(trade: SyncTrade, exitPrice: number): { pnl: number; pnlPercent: number } {
  const remaining = trade.quantity - (trade.partialQty ?? 0);
  const move = trade.direction === 'BEAR' ? trade.entry - exitPrice : exitPrice - trade.entry;
  const pnl = Number((move * remaining + (trade.realizedPnl ?? 0)).toFixed(2));
  return { pnl, pnlPercent: trade.notional > 0 ? Number(((pnl / trade.notional) * 100).toFixed(2)) : 0 };
}

export function classifyExit(trade: SyncTrade, exitPrice: number, carry: boolean): SyncOutcome {
  const tol = trade.entry * 0.001;
  const tgt = trade.target1 || trade.target || 0;
  if (trade.direction === 'BULL') {
    if (tgt > 0 && exitPrice >= tgt - tol) return 'Target';
    if (exitPrice <= trade.stop + tol) return 'Stop';
  } else if (trade.direction === 'BEAR') {
    if (tgt > 0 && exitPrice <= tgt + tol) return 'Target';
    if (exitPrice >= trade.stop - tol) return 'Stop';
  }
  return carry ? 'EOD' : 'Manual';
}

export function planLedgerSync(input: {
  openTrades: SyncTrade[];
  /** Upper-case symbols currently held at the broker. */
  positionSymbols: Set<string>;
  /** Upper-case symbols with any open/pending order at the broker. */
  pendingOrderSymbols: Set<string>;
  /** Recent filled orders per upper-case symbol (any order of any age; the planner filters by time). */
  fillsBySymbol: Record<string, SyncFill[]>;
  nowMs: number;
  minAgeMs?: number;
}): SyncPlan {
  const minAge = input.minAgeMs ?? 3 * 60_000;
  const closes: SyncClose[] = [];
  const unresolved: string[] = [];
  const claimed = new Set<SyncFill>();

  const ordered = [...input.openTrades].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  for (const t of ordered) {
    const sym = t.symbol.toUpperCase();
    if (input.nowMs - Date.parse(t.openedAt) < minAge) continue;
    if (input.positionSymbols.has(sym) || input.pendingOrderSymbols.has(sym)) continue;
    const fill = findClosingFill(t, input.fillsBySymbol[sym] ?? [], claimed);
    if (!fill) { unresolved.push(sym); continue; }
    claimed.add(fill);
    const exitPrice = Number(fill.filled_avg_price);
    const closedAt = fill.filled_at as string;
    const carry = etDateKey(closedAt) !== etDateKey(t.openedAt);
    const { pnl, pnlPercent } = closePnl(t, exitPrice);
    closes.push({ id: t.id, symbol: sym, exitPrice, closedAt, outcome: classifyExit(t, exitPrice, carry), pnl, pnlPercent, carry });
  }
  return { closes, unresolved };
}

/**
 * After the close, orders can only queue for the next open. Queue a close ONCE per position that has no
 * order at all; never cancel-and-resubmit (the old 30 s retry loop did, all night, and risked leaving a
 * position with no order at the open).
 */
export function planCarryClose(positionSymbols: string[], pendingOrderSymbols: Set<string>, alreadyQueued: Set<string>): string[] {
  return positionSymbols
    .map((s) => s.toUpperCase())
    .filter((s) => !pendingOrderSymbols.has(s) && !alreadyQueued.has(s));
}
