// ============================================================================
//  reconcile-daily.mjs — converge the ledger's P&L onto Alpaca's real fills.
//
//  WHY: the internal ledger can drift from the broker even after fill-first
//  booking, because partial exits and EOD closes fill across many whole-share
//  legs at slightly different prices. The ledger models one exit price; Alpaca
//  realizes the true matched round-trip. On 2026-07-27 that drift was +$95 for
//  the day (ledger +234 vs Alpaca +330) — all from partial-exit trades.
//
//  HOW: for each ET trading day, Alpaca's FILL activities give the ground-truth
//  matched round-trip P&L per symbol (buy vwap vs sell vwap on the matched qty).
//  The daemon fires exactly ONE non-phantom trade per symbol per day (verified:
//  0/352 collisions), so that per-symbol realized P&L maps 1:1 to the ledger
//  trade. We overwrite the ledger trade's pnl/exitPrice/quantity to match.
//
//  Trades with NO matching Alpaca fill that day are flagged phantom:true.
//  Alpaca symbol/days with fills but NO ledger trade are reported as ORPHANS
//  (logged; import is a follow-up — they need a synthesized row).
//
//  USAGE:
//    node scripts/reconcile-daily.mjs            # dry-run report only
//    node scripts/reconcile-daily.mjs --apply    # write changes (backs up first)
//    node scripts/reconcile-daily.mjs --day 2026-07-27 [--apply]   # single day
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'data', 'trades.json');
const ENVFILE = path.join(ROOT, 'daemon', '.env.daemon');

const APPLY = process.argv.includes('--apply');
const dayArg = (() => {
  const i = process.argv.indexOf('--day');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// --- Alpaca creds -----------------------------------------------------------
const env = {};
if (fs.existsSync(ENVFILE)) {
  for (const line of fs.readFileSync(ENVFILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const BASE = env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const H = { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
if (!env.ALPACA_KEY) { console.error('No Alpaca creds in', ENVFILE); process.exit(1); }

// --- helpers ----------------------------------------------------------------
async function fillsFor(day) {
  let all = [], token = null;
  for (let i = 0; i < 40; i++) {
    let url = `${BASE}/v2/account/activities/FILL?date=${day}&direction=asc&page_size=100`;
    if (token) url += `&page_token=${token}`;
    const r = await fetch(url, { headers: H });
    const j = await r.json();
    if (!Array.isArray(j)) { console.error('fills error', day, JSON.stringify(j).slice(0, 120)); break; }
    all = all.concat(j);
    if (j.length < 100) break;
    token = all[all.length - 1].id;
  }
  return all;
}

// Per-symbol matched round-trip realized P&L for one day's fills.
// Returns { SYM: { realized, buyQ, sellQ, buyVwap, sellVwap, matched } }
function realizedBySymbol(fills) {
  const agg = {};
  for (const f of fills) {
    const a = agg[f.symbol] = agg[f.symbol] || { buyQ: 0, buyN: 0, sellQ: 0, sellN: 0 };
    const q = Number(f.qty), n = q * Number(f.price);
    if (f.side === 'buy') { a.buyQ += q; a.buyN += n; } else { a.sellQ += q; a.sellN += n; }
  }
  const out = {};
  for (const [sym, a] of Object.entries(agg)) {
    const buyVwap = a.buyQ ? a.buyN / a.buyQ : 0;
    const sellVwap = a.sellQ ? a.sellN / a.sellQ : 0;
    const matched = Math.min(a.buyQ, a.sellQ);
    // realized on the matched round-trip; direction falls out of buy/sell vwap
    const realized = matched * (sellVwap - buyVwap);
    out[sym] = { realized, buyQ: a.buyQ, sellQ: a.sellQ, buyVwap, sellVwap, matched, net: a.buyQ - a.sellQ };
  }
  return out;
}

// --- load ledger ------------------------------------------------------------
const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const trades = Array.isArray(raw) ? raw : (raw.trades || []);
const wrap = Array.isArray(raw) ? null : raw; // preserve wrapper shape on write

const dayOf = (t) => (t.closedAt || t.openedAt || '').slice(0, 10);
const closed = trades.filter((t) => t.pnl != null || t.status === 'Closed');

// which days to process
const days = dayArg ? [dayArg]
  : [...new Set(closed.map(dayOf))].filter(Boolean).sort();

console.log(`Reconciling ${days.length} day(s) ${APPLY ? '[APPLY]' : '[dry-run]'}\n`);

let totalLedgerBefore = 0, totalAlpaca = 0, changedCount = 0, flaggedPhantom = 0;
const orphanRows = [];
const perDay = [];

for (const day of days) {
  const fills = await fillsFor(day);
  const real = realizedBySymbol(fills);
  const dayTrades = closed.filter((t) => dayOf(t) === day && !t.phantom);
  const matchedSyms = new Set();

  let ledgerDay = 0, alpacaDay = 0;
  for (const t of dayTrades) {
    ledgerDay += Number(t.pnl || 0);
    const r = real[t.symbol];
    if (!r || r.matched === 0) {
      // ledger trade with no matching Alpaca round-trip this day => phantom
      flaggedPhantom++;
      if (APPLY) t.phantom = true;
      continue;
    }
    matchedSyms.add(t.symbol);
    const truePnl = Number(r.realized.toFixed(2));
    alpacaDay += truePnl;
    if (Math.abs(truePnl - Number(t.pnl || 0)) > 0.01) {
      changedCount++;
      if (APPLY) {
        t.pnl = truePnl;
        t.pnlPercent = t.notional ? Number((truePnl / t.notional * 100).toFixed(2)) : t.pnlPercent;
        t.quantity = r.matched;                 // whole-share truth from Alpaca
        t.entry = Number(r[t.direction === 'BEAR' ? 'sellVwap' : 'buyVwap'].toFixed(4));
        t.exitPrice = Number(r[t.direction === 'BEAR' ? 'buyVwap' : 'sellVwap'].toFixed(4));
        t.reconciled = day;
      }
    }
  }

  // Alpaca symbols with a completed round-trip but no ledger trade = orphans
  for (const [sym, r] of Object.entries(real)) {
    if (r.matched > 0 && !matchedSyms.has(sym) && !dayTrades.find((t) => t.symbol === sym)) {
      orphanRows.push({ day, sym, realized: Number(r.realized.toFixed(2)), qty: r.matched });
    }
  }

  totalLedgerBefore += ledgerDay;
  totalAlpaca += alpacaDay;
  const gap = ledgerDay - alpacaDay;
  perDay.push({ day, ledger: ledgerDay, alpaca: alpacaDay, gap, trades: dayTrades.length });
  if (Math.abs(gap) > 0.5) {
    console.log(`${day}  ledger ${ledgerDay.toFixed(2).padStart(10)}  alpaca ${alpacaDay.toFixed(2).padStart(10)}  gap ${gap.toFixed(2).padStart(9)}  (${dayTrades.length} tr)`);
  }
}

console.log('\n' + '─'.repeat(70));
console.log(`Ledger (matched trades, before): ${totalLedgerBefore.toFixed(2)}`);
console.log(`Alpaca realized (matched):       ${totalAlpaca.toFixed(2)}`);
console.log(`Net drift corrected:             ${(totalLedgerBefore - totalAlpaca).toFixed(2)}`);
console.log(`Trades whose pnl changed:        ${changedCount}`);
console.log(`Trades flagged phantom (no fill):${flaggedPhantom}`);
if (orphanRows.length) {
  const oSum = orphanRows.reduce((s, o) => s + o.realized, 0);
  console.log(`\nORPHANS (Alpaca round-trips with no ledger row): ${orphanRows.length}, realized ${oSum.toFixed(2)}`);
  orphanRows.slice(0, 20).forEach((o) => console.log(`   ${o.day} ${o.sym.padEnd(6)} q${o.qty} realized ${o.realized}`));
  if (orphanRows.length > 20) console.log(`   ... +${orphanRows.length - 20} more`);
}

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(ROOT, 'data', `trades.json.pre-reconcile-${stamp}`);
  fs.copyFileSync(LEDGER, bak);
  const outObj = wrap ? { ...wrap, trades } : trades;
  fs.writeFileSync(LEDGER, JSON.stringify(outObj, null, 2));
  console.log(`\nAPPLIED. Backup: ${path.basename(bak)}`);
} else {
  console.log('\nDry-run only. Re-run with --apply to write.');
}
