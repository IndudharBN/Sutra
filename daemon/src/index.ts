import './env'; // must be first — loads .env.daemon before any other import reads process.env
import { env } from './env';
import { loadState, saveState, getState } from './stateStore';
import { startScheduler } from './scheduler';
import { startHttpServer } from './httpServer';
import { startWatchdog } from './watchdog';

// Safety net: a transient network timeout (AbortSignal.timeout) or any stray async
// rejection must never hard-kill the trading daemon. Node 24 crashes the process on
// unhandled rejections by default — log loudly and stay alive so the next scan/monitor
// cycle recovers. (Note: real crash recovery still wants a supervisor like pm2.)
process.on('unhandledRejection', (reason) => {
  console.error('[sutra-daemon] unhandledRejection (kept alive):', reason instanceof Error ? `${reason.name}: ${reason.message}` : reason);
});
process.on('uncaughtException', (err) => {
  // A port conflict is fatal, not transient: if we "keep alive" through it we end
  // up a server-less zombie whose scan loop still hammers Alpaca (double-scan ->
  // 429s) while pm2 tracks us as healthy. Exit so the supervisor restarts cleanly.
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error('[sutra-daemon] FATAL: port already in use — exiting so pm2 restarts cleanly');
    process.exit(1);
  }
  console.error('[sutra-daemon] uncaughtException (kept alive):', err.message);
});

function toETTime(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

async function main() {
  console.log(`[sutra-daemon] starting — ${new Date().toISOString()}`);
  console.log(`[sutra-daemon] Alpaca base: ${env.ALPACA_BASE_URL}`);
  console.log(`[sutra-daemon] port: ${env.DAEMON_PORT}`);
  console.log(`[sutra-daemon] auto-execute: ${env.AUTO_EXECUTE}`);

  const state = loadState();
  console.log(`[sutra-daemon] state loaded — dailyDate=${state.riskState.dailyDate}, firedToday=${state.firedToday.length} symbols`);

  saveState();
  console.log(`[sutra-daemon] state saved to disk ✓`);

  const s = getState();
  console.log(`[sutra-daemon] ready at ${toETTime()} ET`);
  console.log(`[sutra-daemon] watchlist: ${s.dayWatchlist.symbols.length} symbols`);
  console.log(`[sutra-daemon] daily P&L: $${s.riskState.dailyRealizedPnl.toFixed(2)}`);

  startHttpServer();
  startScheduler();
  startWatchdog();
}

main().catch((err) => {
  console.error('[sutra-daemon] fatal startup error:', err);
  process.exit(1);
});
