import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const TRADES_FILE = join(DATA_DIR, 'trades.json');
const PORT = 3009;

await mkdir(DATA_DIR, { recursive: true });

// Serialise writes — prevents concurrent write corruption
let writeQueue = Promise.resolve();

// ── VIX — server-side fetch avoids browser CORS ──────────────────────────────
let vixCache = { value: null, expiresAt: 0 };

async function fetchVixFromYahoo() {
  if (Date.now() < vixCache.expiresAt) return vixCache.value;
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
    );
    if (!res.ok) throw new Error(`Yahoo VIX ${res.status}`);
    const json = await res.json();
    const value = json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    vixCache = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
    return value;
  } catch (err) {
    console.error('VIX fetch failed:', err.message);
    vixCache = { value: null, expiresAt: Date.now() + 60_000 };
    return null;
  }
}

async function readTrades() {
  try {
    return JSON.parse(await readFile(TRADES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function enqueueWrite(trades) {
  writeQueue = writeQueue.then(() =>
    writeFile(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8').catch(console.error)
  );
}

// Convert UTC ISO string → YYYY-MM-DD in Eastern Time
function dateET(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /api/vix — proxy to Yahoo Finance server-side (avoids CORS)
  if (url.pathname === '/api/vix') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    const vix = await fetchVixFromYahoo();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ vix }));
    return;
  }

  if (url.pathname !== '/api/trades') { res.writeHead(404); res.end('Not Found'); return; }

  // GET /api/trades[?date=YYYY-MM-DD]
  if (req.method === 'GET') {
    const date = url.searchParams.get('date');
    const all = await readTrades();
    const result = date ? all.filter((t) => dateET(t.openedAt) === date) : all;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/trades  — upsert a single trade by id
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const trade = JSON.parse(body);
        if (!trade || typeof trade.id !== 'string') { res.writeHead(400); res.end('Missing id'); return; }
        const all = await readTrades();
        const idx = all.findIndex((t) => t.id === trade.id);
        if (idx >= 0) all[idx] = trade; else all.push(trade);
        enqueueWrite(all);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Trade server already running on port ${PORT} — skipping.`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Trade server  →  http://localhost:${PORT}`);
  console.log(`Trades file   →  ${TRADES_FILE}`);
});
