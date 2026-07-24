#!/usr/bin/env node
// Attempt to RESTATE the historical ledger from Alpaca's actual fills.
// Pass --apply to write; default is a dry-run report.
// For each closed ledger trade it finds the matching Alpaca entry+exit fills
// (same symbol, same day, correct sides) and recomputes real qty / prices / pnl.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const env = {};
for (const line of fs.readFileSync(path.join(root, 'daemon', '.env.daemon'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.ALPACA_BASE_URL;
const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };

async function api(p) {
  const res = await fetch(`${BASE}${p}`, { headers });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json();
}

// Pull ALL filled orders across the account history (paginated).
async function allFills() {
  const out = [];
  const seen = new Set();
  let after = '2026-04-29T00:00:00Z';
  for (let page = 0; page < 40; page++) {
    const batch = await api(`/v2/orders?status=closed&after=${after}&limit=500&direction=asc`);
    if (!batch.length) break;
    for (const o of batch) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      if (o.filled_qty && Number(o.filled_qty) > 0 && o.filled_avg_price) {
        out.push({ symbol: o.symbol, side: o.side, qty: Number(o.filled_qty), price: Number(o.filled_avg_price), at: o.filled_at });
      }
    }
    if (batch.length < 500) break;
    after = batch[batch.length - 1].submitted_at; // advance cursor by submission time
  }
  return out;
}

const trades = JSON.parse(fs.readFileSync(path.join(root, 'data', 'trades.json'), 'utf8'));
const closed = trades.filter((t) => t.status === 'Closed' && t.pnl != null);
const fills = await allFills();

// Index fills by symbol+day
const bySymDay = {};
for (const f of fills) {
  const day = (f.at || '').slice(0, 10);
  (bySymDay[`${f.symbol}:${day}`] ??= []).push(f);
}

let matched = 0, unmatched = 0, ledPnl = 0, realPnl = 0;
const restated = new Map();
for (const t of closed) {
  const day = (t.openedAt || '').slice(0, 10);
  const key = `${t.symbol}:${day}`;
  const dayFills = bySymDay[key] || [];
  const entrySide = t.direction === 'BEAR' ? 'sell' : 'buy';
  const exitSide = t.direction === 'BEAR' ? 'buy' : 'sell';
  const entryFill = dayFills.find((f) => f.side === entrySide);
  const exitFill = dayFills.find((f) => f.side === exitSide);
  ledPnl += t.pnl;
  if (entryFill && exitFill) {
    const qty = Math.min(entryFill.qty, exitFill.qty);
    const move = t.direction === 'BEAR' ? (entryFill.price - exitFill.price) : (exitFill.price - entryFill.price);
    const pnl = Number((move * qty).toFixed(2));
    realPnl += pnl;
    matched++;
    restated.set(t.id, { entry: entryFill.price, exit: exitFill.price, qty, pnl });
  } else {
    unmatched++;
  }
}

console.log(`\n=== HISTORICAL RESTATEMENT (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`closed ledger trades:      ${closed.length}`);
console.log(`matched to Alpaca fills:   ${matched}`);
console.log(`unmatched (no fills):      ${unmatched}  <- these were never real trades or fills are gone`);
console.log(`\nledger P&L (all closed):   ${ledPnl >= 0 ? '+' : ''}$${ledPnl.toFixed(2)}`);
console.log(`restated P&L (matched):    ${realPnl >= 0 ? '+' : ''}$${realPnl.toFixed(2)}  (matched trades only)`);
const acct = await api('/v2/account');
console.log(`\nAlpaca actual equity:      $${Number(acct.equity).toLocaleString()}  (real P&L ${(Number(acct.equity)-100000).toFixed(2)})`);
console.log(`\nMatch rate ${(matched/closed.length*100).toFixed(0)}%. ${unmatched} trades cannot be restated — they have no`);
console.log(`corresponding Alpaca fill, confirming they were phantom/rejected orders.`);

if (APPLY) {
  let n = 0;
  for (const t of trades) {
    const r = restated.get(t.id);
    if (!r) continue;
    t.entry = Number(r.entry.toFixed(4));
    t.exitPrice = Number(r.exit.toFixed(4));
    t.quantity = r.qty;
    t.notional = Number((r.qty * r.entry).toFixed(2));
    t.pnl = r.pnl;
    t.pnlPercent = Number((r.pnl / (r.qty * r.entry) * 100).toFixed(2));
    t.restatedFromFills = true;
    n++;
  }
  // Mark unmatched closed trades as phantom (exclude from P&L) rather than delete — audit trail.
  let ph = 0;
  for (const t of trades) {
    if (t.status === 'Closed' && t.pnl != null && !restated.has(t.id)) { t.phantom = true; ph++; }
  }
  fs.copyFileSync(path.join(root, 'data', 'trades.json'), path.join(root, 'data', `trades.json.pre-restate-${Date.now()}`));
  fs.writeFileSync(path.join(root, 'data', 'trades.json'), JSON.stringify(trades, null, 2));
  console.log(`\nAPPLIED: restated ${n} trades, flagged ${ph} as phantom. Backup written.`);
}
