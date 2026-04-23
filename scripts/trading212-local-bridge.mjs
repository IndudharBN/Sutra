import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 8787);
const CREDS_PATHS = [
  'C:/Users/vinod/Documents/stock-analyzer-indu-new-version/.ls_broker_creds.json',
  'C:/Users/vinod/Documents/stock-analyzer-indu-new-version/.app_broker_creds.json',
  'C:/Users/vinod/Documents/stock-analyzer/broker_prefs.json',
];

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function loadCreds() {
  for (const path of CREDS_PATHS) {
    const data = readJson(path);
    if (!data) continue;
    const apiKey = data.api_key || data.t212_key;
    if (apiKey && (data.type === 'Trading212' || data.broker === 'Trading212' || data.type === undefined)) {
      return {
        apiKey: String(apiKey).trim(),
        apiSecret: String(data.api_secret || data.t212_secret || '').trim(),
        demo: data.demo !== false,
      };
    }
  }
  throw new Error('Trading212 credentials not found in previous app folders.');
}

function authVariants(apiKey, apiSecret) {
  const variants = [];
  if (apiSecret) variants.push(`Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`);
  variants.push(`Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`);
  variants.push(apiKey);
  return variants;
}

let authCache = null;
let lastRequestAt = 0;

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  const wait = Math.max(0, 2600 - elapsed);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function t212Fetch(path, options = {}) {
  const creds = loadCreds();
  const baseUrl = creds.demo ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const variants = authCache ? [authCache] : authVariants(creds.apiKey, creds.apiSecret);
  let lastError = null;
  for (const auth of variants) {
    await throttle();
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'user-agent': 'SutraLocalBridge/1.0',
        ...(options.headers || {}),
      },
    });
    if (response.ok) {
      authCache = auth;
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
    lastError = new Error(`Trading212 ${path} failed: ${response.status} ${await response.text()}`);
    if (response.status !== 401 && response.status !== 403) break;
  }
  throw lastError || new Error(`Trading212 ${path} failed`);
}

function normalizeAccount(data) {
  const cash = data.cash || {};
  const available = Number(cash.availableToTrade ?? cash.free ?? data.free ?? 0);
  const total = Number(data.totalValue ?? cash.total ?? available);
  return {
    id: data.id || '',
    currency: data.currency || cash.currencyCode || 'GBP',
    equity: total,
    cash: available,
    buyingPower: available,
    raw: data,
  };
}

function normalizePositions(data) {
  const items = Array.isArray(data) ? data : data.items || [];
  return items.map((p) => {
    const qty = Number(p.quantity || 0);
    const current = Number(p.currentPrice || 0);
    const avg = Number(p.averagePrice || 0);
    const pnl = Number(p.ppl || 0);
    const invested = Math.max(Math.abs(qty * avg), 1);
    return {
      id: String(p.ticker || p.instrumentCode || crypto.randomUUID()),
      broker: 'Trading212',
      symbol: String(p.ticker || ''),
      company: String(p.name || p.ticker || ''),
      size: qty,
      avgPrice: avg,
      currentPrice: current,
      pnl,
      pnlPercent: (pnl / invested) * 100,
      raw: p,
    };
  });
}

function normalizeOrders(data) {
  const items = Array.isArray(data) ? data : data.items || [];
  return items.map((o) => {
    const qty = Number(o.quantity || 0);
    return {
      id: String(o.id || ''),
      brokerOrderId: String(o.id || ''),
      buyDateTime: String(o.dateCreated || o.created || '').slice(0, 19).replace('T', ' '),
      symbol: String(o.ticker || ''),
      company: String(o.ticker || ''),
      side: qty >= 0 ? 'Buy' : 'Sell',
      entry: Number(o.limitPrice || o.stopPrice || 0),
      sl: Number(o.stopPrice || 0),
      t1: Number(o.limitPrice || 0),
      status: 'Open',
      type: String(o.type || ''),
      raw: o,
    };
  });
}

async function snapshot() {
  const accountRaw = await t212Fetch('/equity/account/summary');
  const positionsRaw = await t212Fetch('/equity/portfolio');
  const ordersRaw = await t212Fetch('/equity/orders');
  return {
    ok: true,
    mode: 'demo',
    account: normalizeAccount(accountRaw),
    positions: normalizePositions(positionsRaw),
    orders: normalizeOrders(ordersRaw),
    fetchedAt: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/trading212/snapshot') {
      res.end(JSON.stringify(await snapshot()));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Sutra Trading212 local bridge listening on http://localhost:${PORT}`);
});
