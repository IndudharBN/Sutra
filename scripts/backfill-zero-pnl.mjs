// Backfill real P&L for closed paper trades that were booked at their entry
// price (P&L $0). These come from eodClose() defaulting a held symbol's exit to
// `entry` whenever it was missing from the live snapshot — most often when the
// daemon restarted post-close and ran a "missed EOD close" before the scanner
// repopulated. We re-mark each such trade at the regular-session CLOSE for its
// ET trade date (the conventional EOD flat price), pulled from Yahoo daily bars.
//
// Usage:
//   node scripts/backfill-zero-pnl.mjs            # dry run — prints what would change
//   node scripts/backfill-zero-pnl.mjs --apply    # writes trades.json (after a backup)
//
// Only trades where exitPrice === entry (the fabricated $0) are touched. Genuine
// flat exits (real exit that happened to equal entry) are rare and indistinguish-
// able; the risk is negligible and far smaller than leaving the books wrong.

import { readFileSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRADES = join(ROOT, 'data', 'trades.json');
const LEDGER = join(ROOT, 'data', 'trade-ledger.jsonl');
const APPLY = process.argv.includes('--apply');

const etDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function fetchDailyCloses(symbol) {
  // 6mo covers the full paper history; returns { 'YYYY-MM-DD': close }.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const map = {};
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    map[new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })] = c;
  }
  return map;
}

const trades = JSON.parse(readFileSync(TRADES, 'utf8'));
const targets = trades.filter(
  (t) => t.status === 'Closed' && typeof t.exitPrice === 'number' && t.exitPrice === t.entry && t.entry > 0,
);

if (targets.length === 0) {
  console.log('No fabricated-$0 trades found. Nothing to backfill.');
  process.exit(0);
}

const symbols = [...new Set(targets.map((t) => t.symbol))];
console.log(`Found ${targets.length} trades (exit==entry) across ${symbols.length} symbols. Fetching daily closes...\n`);

const closesBySymbol = {};
for (const sym of symbols) {
  try {
    closesBySymbol[sym] = await fetchDailyCloses(sym);
  } catch (err) {
    console.warn(`  ! ${sym}: fetch failed (${err.message}) — leaving its trades unchanged`);
    closesBySymbol[sym] = null;
  }
}

let fixed = 0;
let totalDelta = 0;
const corrections = [];
for (const t of trades) {
  if (!(t.status === 'Closed' && typeof t.exitPrice === 'number' && t.exitPrice === t.entry && t.entry > 0)) continue;
  const map = closesBySymbol[t.symbol];
  if (!map) continue;
  const date = etDate(t.closedAt ?? t.openedAt);
  const close = map[date];
  if (close == null) {
    console.warn(`  ? ${t.symbol} ${date}: no daily close — skipped`);
    continue;
  }
  const exitPrice = Number(close.toFixed(2));
  const gross = t.direction === 'BEAR' ? (t.entry - exitPrice) * t.quantity : (exitPrice - t.entry) * t.quantity;
  const pnl = Number(gross.toFixed(2));
  const pnlPercent = t.notional ? Number(((gross / t.notional) * 100).toFixed(2)) : 0;
  console.log(
    `  ${t.symbol.padEnd(6)} ${t.direction.padEnd(4)} ${date}  entry ${t.entry} -> exit ${exitPrice}  P&L $0 -> ${pnl >= 0 ? '+' : ''}${pnl}`,
  );
  totalDelta += pnl;
  fixed++;
  if (APPLY) {
    t.exitPrice = exitPrice;
    t.pnl = pnl;
    t.pnlPercent = pnlPercent;
    corrections.push({ ts: new Date().toISOString(), type: 'trade_corrected', trade: { ...t } });
  }
}

console.log(`\n${fixed} trades ${APPLY ? 'updated' : 'would be updated'}. Net P&L delta: ${totalDelta >= 0 ? '+' : ''}$${totalDelta.toFixed(2)}`);

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write changes.');
  process.exit(0);
}

const backup = `${TRADES}.bak-${Date.now()}`;
copyFileSync(TRADES, backup);
writeFileSync(TRADES, JSON.stringify(trades, null, 2));
for (const c of corrections) appendFileSync(LEDGER, JSON.stringify(c) + '\n');
console.log(`\nWrote ${TRADES} (backup: ${backup}) and appended ${corrections.length} ledger corrections.`);
