// ============================================================================
//  shadow-deadtrade-report.mjs — compare what the dead-trade rules WOULD have done (recorded live in
//  shadow mode on each open trade) with what actually happened to those trades.
//
//  For every CLOSED trade that carries a shadow verdict for a rule:
//    would-exit P&L = (price at the check - entry) in the trade direction x quantity, minus ~10 bps round-trip cost
//    actual P&L     = the ledger's real result
//  delta > 0 means the rule would have beaten the live exit on those trades.
//
//  Decision rule (set BEFORE looking): enforce a rule live only if, over >= 60 flagged trades, the total delta is
//  positive AND at least ~60% of the weeks are positive. Otherwise drop it.
//  USAGE: node scripts/shadow-deadtrade-report.mjs
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trades.json'), 'utf8'));
const rows = (Array.isArray(raw) ? raw : raw.trades || []).filter((t) => t.id !== '__ALPACA_ANCHOR__' && t.quantity > 0);
const closed = rows.filter((t) => t.status === 'Closed' && typeof t.pnl === 'number' && t.shadow);
const open = rows.filter((t) => t.status === 'Open' && t.shadow);
console.log(`trades carrying a shadow verdict: ${closed.length} closed, ${open.length} still open`);

const COST_BPS = 10;
const week = (iso) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };

for (const key of ['A', 'B']) {
  const judged = closed.filter((t) => t.shadow[key]);
  const flagged = judged.filter((t) => t.shadow[key].dead);
  if (!judged.length) { console.log(`\nRule ${key}: no judged trades yet`); continue; }
  let delta = 0, killedWinners = 0, avoidedStops = 0;
  const byWeek = {};
  for (const t of flagged) {
    const s = t.shadow[key];
    const dir = t.direction === 'BEAR' ? -1 : 1;
    const would = dir * (s.price - t.entry) * t.quantity - (t.notional || t.entry * t.quantity) * (COST_BPS / 1e4);
    const d = would - t.pnl;
    delta += d;
    if (t.pnl > 0 && String(t.outcome).match(/Target|T1/)) killedWinners++;
    if (t.outcome === 'Stop') avoidedStops++;
    const w = week(s.at);
    (byWeek[w] ||= { n: 0, d: 0 });
    byWeek[w].n++; byWeek[w].d += d;
  }
  const weeks = Object.entries(byWeek).sort();
  const posWeeks = weeks.filter(([, v]) => v.d > 0).length;
  console.log(`\nRule ${key}: judged ${judged.length}, flagged dead ${flagged.length} (${Math.round((100 * flagged.length) / judged.length)}%)`);
  console.log(`  total delta vs live exits on flagged trades: $${delta.toFixed(0)}  (avg $${(delta / Math.max(1, flagged.length)).toFixed(2)}/trade)`);
  console.log(`  flagged trades that went on to hit target: ${killedWinners} | that went on to stop out: ${avoidedStops}`);
  console.log(`  positive weeks: ${posWeeks}/${weeks.length}  ${weeks.map(([w, v]) => `${w}:$${v.d.toFixed(0)}(${v.n})`).join('  ')}`);
  const verdict = flagged.length < 60 ? 'TOO FEW TRADES - keep collecting' : (delta > 0 && posWeeks / weeks.length >= 0.6 ? 'PASSES the pre-set bar - candidate to enforce' : 'FAILS the pre-set bar - drop it');
  console.log(`  verdict: ${verdict}`);
}
