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

server.listen(PORT, () => {
  console.log(`Trade server  →  http://localhost:${PORT}`);
  console.log(`Trades file   →  ${TRADES_FILE}`);
});
