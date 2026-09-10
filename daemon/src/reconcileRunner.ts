import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Runs scripts/reconcile-daily.mjs --apply as a detached child, logging to
// logs/reconcile.log. Used in two places so ledger↔Alpaca parity is self-healing:
//   1. daemon startup  — catch-up for any day the 16:05 window missed.
//   2. EOD close        — fires when the account is FLAT, so the reconcile's equity
//                         anchor can lock EXACT parity (it skips while positions are
//                         open). This is the run that closes the cross-day gap.
// The 16:05 watchdog trigger stays as a third belt-and-suspenders path.
export function runReconcile(reason: string): void {
  try {
    const script = path.resolve(__dirname, '..', '..', 'scripts', 'reconcile-daily.mjs');
    if (!fs.existsSync(script)) {
      console.warn(`[reconcile] script not found — skip (${reason})`);
      return;
    }
    const logDir = path.resolve(__dirname, '..', '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'reconcile.log');
    fs.appendFileSync(logPath, `\n===== reconcile (${reason}) ${new Date().toISOString()} =====\n`);
    const out = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [script, '--apply'], { stdio: ['ignore', out, out] });
    child.on('error', (e) => console.warn(`[reconcile] spawn failed (${reason}):`, e.message));
    child.on('exit', (code) => console.log(`[reconcile] ${reason} finished (exit ${code}) — logs/reconcile.log`));
    console.log(`[reconcile] launched (${reason}) — logs/reconcile.log`);
  } catch (e) {
    console.warn(`[reconcile] error (${reason}):`, (e as Error).message);
  }
}
