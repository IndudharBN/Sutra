// Server-side trade persistence via local Node.js trade-server.mjs.
// Always merges server + localStorage so old trades are never lost.

const API = '/api/trades';
const LS_KEY = 'sutra.protrade.paperTrades.v1';

/** Today's date in ET, as YYYY-MM-DD (used for default date filter). */
export function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Trade's open date in ET, as YYYY-MM-DD. */
export function tradeDateET(trade: { openedAt: string }): string {
  if (!trade.openedAt) return '';
  return new Date(trade.openedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function lsAll<T>(): (T & { id: string; openedAt: string })[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]') as (T & { id: string; openedAt: string })[];
  } catch {
    return [];
  }
}

/**
 * Load trades — merges server + localStorage.
 * Server wins for any trade with the same id (source of truth).
 * localStorage-only trades (not yet synced) are appended automatically.
 * Optionally filtered by ET date (YYYY-MM-DD).
 */
export async function loadTrades<T extends { id: string; openedAt: string }>(date?: string): Promise<T[]> {
  let serverTrades: T[] = [];
  let serverReachable = false;

  try {
    const url = date ? `${API}?date=${encodeURIComponent(date)}` : API;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      serverTrades = await res.json() as T[];
      serverReachable = true;
    }
  } catch { /* server not running */ }

  const ls = lsAll<T>();
  const lsFiltered = date ? ls.filter((t) => tradeDateET(t) === date) : ls;

  if (!serverReachable) return lsFiltered;

  // Merge: server wins for shared ids; append localStorage-only trades not yet on server
  const serverIds = new Set(serverTrades.map((t) => t.id));
  const lsOnly = lsFiltered.filter((t) => !serverIds.has(t.id));

  // Also migrate LS-only trades to server so they don't stay orphaned
  lsOnly.forEach((t) => {
    void fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  });

  return [...serverTrades, ...lsOnly];
}

/** Load all trades (no date filter). */
export async function loadAllTrades<T extends { id: string; openedAt: string }>(): Promise<T[]> {
  return loadTrades<T>();
}

/**
 * Upsert a single trade (by id) to the server.
 * Fire-and-forget — always updates localStorage immediately as a fallback.
 */
export function persistTrade<T extends { id: string }>(trade: T): void {
  // localStorage stays in sync immediately
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '[]') as T[];
    const idx = all.findIndex((t) => t.id === trade.id);
    if (idx >= 0) all[idx] = trade; else all.push(trade);
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch { /* storage full */ }

  // Fire-and-forget to server
  void fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trade),
    signal: AbortSignal.timeout(4000),
  }).catch(() => {});
}
