// Portfolio-level protections evaluated before EVERY new entry (freqtrade "protections" /
// ai-hedge-fund control-file pattern). The existing circuit breakers in riskManager.ts are
// per-strategy / per-signal-group; these cover what they don't:
//   1. KILL SWITCH   — data/control.json {"halt":true} stops new entries immediately,
//                      no daemon restart. Optional "haltUntil" (ISO) and "sizeMult" (<=1).
//   2. LOSS STREAK   — N consecutive losing closes ACROSS all strategies today => pause
//                      new entries for a cool-down (regime-wide bad tape, not one strategy).
//   3. DRAWDOWN      — rolling window of closed P&L: halve size at -1%, halt at -2.5%.
// SHRINK-ONLY: nothing here can increase size or force a trade; worst case it blocks entries.
// Existing positions are never touched (bracket orders on Alpaca still manage them).
// Pure decision function + a thin file reader so the logic is unit-testable.

import fs from 'fs';
import path from 'path';

export interface ClosedTradeLite { closedAt?: string; pnl?: number | null; status?: string; phantom?: boolean }
export interface ControlFile { halt?: boolean; reason?: string; haltUntil?: string; sizeMult?: number }

export interface ProtectionConfig {
  streakLosses: number;       // consecutive losing closes that trigger the lockout
  streakPauseMs: number;      // lockout length, measured from the last losing close
  drawdownWindowDays: number; // calendar days in the rolling window
  halveAtPct: number;         // rolling P&L <= -this% of balance => size x0.5
  haltAtPct: number;          // rolling P&L <= -this% of balance => no new entries
}

export const DEFAULT_PROTECTIONS: ProtectionConfig = {
  streakLosses: 3,
  streakPauseMs: 45 * 60_000,
  drawdownWindowDays: 7,
  halveAtPct: 1.0,
  haltAtPct: 2.5,
};

export interface ProtectionResult { ok: boolean; sizeMult: number; reasons: string[] }

const etDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function evaluateProtections(input: {
  nowMs: number;
  trades: ClosedTradeLite[];
  accountBalance: number;
  control?: ControlFile | null;
  config?: ProtectionConfig;
}): ProtectionResult {
  const cfg = input.config ?? DEFAULT_PROTECTIONS;
  const reasons: string[] = [];
  let sizeMult = 1;

  // 1. Kill switch
  const c = input.control;
  if (c?.halt) {
    const until = c.haltUntil ? Date.parse(c.haltUntil) : NaN;
    if (!Number.isFinite(until) || until > input.nowMs) {
      return { ok: false, sizeMult: 0, reasons: [`KILL SWITCH: ${c.reason || 'halt set in data/control.json'}`] };
    }
  }
  if (c && typeof c.sizeMult === 'number' && c.sizeMult > 0 && c.sizeMult < 1) {
    sizeMult *= c.sizeMult; // shrink-only: values >= 1 are ignored
    reasons.push(`control sizeMult x${c.sizeMult}`);
  }

  const closed = input.trades
    .filter((t) => t.status === 'Closed' && !t.phantom && t.closedAt && typeof t.pnl === 'number')
    .map((t) => ({ ms: Date.parse(t.closedAt as string), pnl: t.pnl as number }))
    .filter((t) => Number.isFinite(t.ms))
    .sort((a, b) => a.ms - b.ms);

  // 2. Cross-strategy loss streak (today, ET)
  const today = etDay(input.nowMs);
  const todays = closed.filter((t) => etDay(t.ms) === today);
  if (todays.length >= cfg.streakLosses) {
    const tail = todays.slice(-cfg.streakLosses);
    if (tail.every((t) => t.pnl < 0)) {
      const resumeAt = tail[tail.length - 1].ms + cfg.streakPauseMs;
      if (resumeAt > input.nowMs) {
        const mins = Math.ceil((resumeAt - input.nowMs) / 60_000);
        return { ok: false, sizeMult: 0, reasons: [...reasons, `LOSS STREAK: ${cfg.streakLosses} straight losing closes — paused ${mins}m`] };
      }
    }
  }

  // 3. Rolling drawdown
  const from = input.nowMs - cfg.drawdownWindowDays * 864e5;
  const rolling = closed.filter((t) => t.ms >= from).reduce((s, t) => s + t.pnl, 0);
  const pct = input.accountBalance > 0 ? (rolling / input.accountBalance) * 100 : 0;
  if (pct <= -cfg.haltAtPct) {
    return { ok: false, sizeMult: 0, reasons: [...reasons, `DRAWDOWN HALT: ${cfg.drawdownWindowDays}d P&L ${pct.toFixed(2)}% (limit -${cfg.haltAtPct}%)`] };
  }
  if (pct <= -cfg.halveAtPct) {
    sizeMult *= 0.5;
    reasons.push(`DRAWDOWN: ${cfg.drawdownWindowDays}d P&L ${pct.toFixed(2)}% — size x0.5`);
  }
  return { ok: true, sizeMult, reasons };
}

const CONTROL_FILE = path.join(__dirname, '../../data/control.json');

/** Reads data/control.json; missing/corrupt file = no override (never blocks on a parse error). */
export function readControlFile(file = CONTROL_FILE): ControlFile | null {
  try {
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? (j as ControlFile) : null;
  } catch {
    return null;
  }
}
