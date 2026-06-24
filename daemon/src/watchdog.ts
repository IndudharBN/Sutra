import { getCurrentSnapshot } from './scanLoop';

// ── In-process liveness watchdog ────────────────────────────────────────────────
//
// The RUN_DAEMON.bat wrapper only relaunches the daemon when the process EXITS.
// It cannot see a process that is alive-but-wedged — event loop stalled, or heap
// bloated into a GC death-spiral (the ~718 MB hang that held port 3001 open while
// /api/health timed out and the dashboard rendered blank). index.ts also keeps the
// process alive through unhandled rejections by design, so nothing today turns a
// hang into the exit the wrapper needs.
//
// This watchdog closes that gap: it converts hang states into a clean process.exit(1)
// so the wrapper's restart loop recycles a fresh daemon within its 3s backoff.
//
// Honest limitation: a FULLY frozen event loop also freezes this timer, so the
// checks below only fire once the loop is scheduling callbacks again. The common,
// real-world failure here is bloat-driven slowdown (heap pressure → GC thrash →
// unresponsive but still ticking), which this catches. For a hard freeze you still
// want the external /api/health poller as belt-and-suspenders.

const TICK_MS = 15_000;

function num(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Heap ceiling: recycle BEFORE V8's --max-old-space-size=1024 cap forces a
// mid-operation OOM. ~900 MB leaves headroom to exit and restart cleanly.
const HEAP_LIMIT_MB = num('WATCHDOG_HEAP_LIMIT_MB', 900);
// RSS hard ceiling (heap + native). Backstop if native buffers bloat past the heap.
const RSS_LIMIT_MB = num('WATCHDOG_RSS_LIMIT_MB', 1280);
// Event-loop lag: a 15s tick arriving this much late means the loop was blocked.
const LAG_LIMIT_MS = num('WATCHDOG_LAG_LIMIT_MS', 90_000);
// Scan staleness: during the scan window a successful scan lands every ≤60s. If the
// newest snapshot is older than this, the scan loop has silently died.
const SCAN_STALE_MS = num('WATCHDOG_SCAN_STALE_MS', 10 * 60_000);

function etMinutes(): number {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }), 10);
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }), 10);
  return h * 60 + m;
}

// Mirror the scheduler's scan window (08:00–16:00 ET) so we only flag scan
// staleness when scans are actually expected to be running. Outside the window
// the snapshot is allowed to go stale overnight — that is not a fault.
function isScanWindow(): boolean {
  const mins = etMinutes();
  return mins >= 8 * 60 && mins < 16 * 60;
}

function die(reason: string): never {
  console.error(`[watchdog] UNHEALTHY — ${reason}. Exiting(1) so the wrapper restarts a clean daemon.`);
  process.exit(1);
}

let watchdogStarted = false;

export function startWatchdog(): void {
  if (watchdogStarted) return;
  watchdogStarted = true;

  let expectedAt = Date.now() + TICK_MS;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expectedAt;
    expectedAt = now + TICK_MS;

    // 1) Event-loop lag — the tick fired far later than scheduled (loop was blocked).
    if (lag > LAG_LIMIT_MS) {
      die(`event-loop lag ${Math.round(lag / 1000)}s > ${LAG_LIMIT_MS / 1000}s`);
    }

    // 2) Heap / RSS bloat — the wedge-by-memory class that caused the 718 MB hang.
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1048576);
    const rssMb = Math.round(mem.rss / 1048576);
    if (heapMb > HEAP_LIMIT_MB) die(`heapUsed ${heapMb}MB > ${HEAP_LIMIT_MB}MB`);
    if (rssMb > RSS_LIMIT_MB) die(`rss ${rssMb}MB > ${RSS_LIMIT_MB}MB`);

    // 3) Scan staleness — during the scan window a fresh snapshot lands every ≤60s.
    if (isScanWindow()) {
      const fetchedAt = getCurrentSnapshot()?.fetchedAt;
      if (fetchedAt) {
        const age = now - new Date(fetchedAt).getTime();
        if (age > SCAN_STALE_MS) {
          die(`scan stalled — newest snapshot is ${Math.round(age / 60_000)}m old (>${SCAN_STALE_MS / 60_000}m) during scan window`);
        }
      }
    }
  }, TICK_MS);

  // The HTTP listener already keeps the loop alive; the watchdog should not be a
  // reason to stay up on its own.
  timer.unref();

  console.log(`[watchdog] armed — heap≤${HEAP_LIMIT_MB}MB rss≤${RSS_LIMIT_MB}MB lag≤${LAG_LIMIT_MS / 1000}s scanFresh≤${SCAN_STALE_MS / 60_000}m`);
}
