// ============================================================================
//  monthly-scorecard.mjs — did the Aug 27 fixes work?
//
//  Compares trading months on the metrics that reveal whether the structural
//  fixes (15m-ATR stops + full-exit-at-T1, both shipped 2026-08-27) are moving
//  the book. August 2026 is the BASELINE (old wide stops + T2 runner); every
//  month after is the test.
//
//  The thesis being tested:
//   - Tighter 15m stops  -> stop LOSSES get smaller (cut at ~1.2%, not ~4%).
//   - Full-exit-at-T1    -> more winners reach T1 & bank before EOD, so the
//                           EOD-negative rate FALLS and T1-hit rate RISES.
//   - Net effect         -> realized payoff climbs from ~0.89 toward ~1.8-2.0,
//                           and the book moves toward breakeven / positive.
//
//  USAGE:
//    node scripts/monthly-scorecard.mjs                 # all months, newest last
//    node scripts/monthly-scorecard.mjs 2026-08 2026-09 # compare two months
//    node scripts/monthly-scorecard.mjs --weeks         # ISO-week granularity
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, '..', 'data', 'trades.json');

const args = process.argv.slice(2);
const byWeek = args.includes('--weeks');
const monthFilter = args.filter((a) => /^\d{4}-\d{2}$/.test(a));

const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const trades = (Array.isArray(raw) ? raw : raw.trades || []).filter(
  (t) => !t.phantom && t.id !== '__ALPACA_ANCHOR__' && t.pnl != null && t.status === 'Closed',
);

// bucket key: month (YYYY-MM) or ISO week
function isoWeek(d) {
  const date = new Date(d);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
const keyOf = (t) => {
  const d = (t.closedAt || t.openedAt || '').slice(0, 10);
  if (!d) return null;
  return byWeek ? isoWeek(d) : d.slice(0, 7);
};

// group
const groups = {};
for (const t of trades) {
  const k = keyOf(t);
  if (!k) continue;
  if (monthFilter.length && !byWeek && !monthFilter.includes(k)) continue;
  (groups[k] = groups[k] || []).push(t);
}

function scorecard(list) {
  const n = list.length;
  const wins = list.filter((t) => +t.pnl > 0);
  const pnl = list.reduce((s, t) => s + +t.pnl, 0);
  const wr = n ? (100 * wins.length) / n : 0;

  // outcome mix
  const oc = (name) => list.filter((t) => t.outcome === name);
  const eod = oc('EOD');
  const stops = oc('Stop');
  const t1 = list.filter((t) => t.outcome === 'T1 Profit' || t.outcome === 'Target');

  // EOD-negative rate (the soft-stop rot metric)
  const eodNeg = eod.filter((t) => +t.pnl < 0);
  const eodNegRate = n ? (100 * eodNeg.length) / n : 0;

  // T1-hit rate (did trades reach target)
  const t1Rate = n ? (100 * t1.length) / n : 0;

  // realized payoff: avg win R / avg loss R (R = pnl / dollar-risk)
  const Rs = list
    .map((t) => {
      const riskD = Math.abs(t.entry - t.stop) * (t.quantity || 1);
      return riskD > 0 ? +t.pnl / riskD : null;
    })
    .filter((r) => r != null);
  const winR = Rs.filter((r) => r > 0);
  const lossR = Rs.filter((r) => r < 0);
  const avgWinR = winR.length ? winR.reduce((s, r) => s + r, 0) / winR.length : 0;
  const avgLossR = lossR.length ? lossR.reduce((s, r) => s + r, 0) / lossR.length : 0;
  const payoff = avgLossR ? Math.abs(avgWinR / avgLossR) : 0;
  const beWR = payoff ? (100 * 1) / (1 + payoff) : 0;

  // avg stop distance (% of entry) — should shrink after the 15m-ATR fix
  const stopDists = list
    .map((t) => (t.entry > 0 ? (Math.abs(t.entry - t.stop) / t.entry) * 100 : null))
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const medStopPct = stopDists.length ? stopDists[Math.floor(stopDists.length / 2)] : 0;

  // avg stop-loss size $ (should shrink)
  const avgStopLoss = stops.length ? stops.reduce((s, t) => s + +t.pnl, 0) / stops.length : 0;

  return {
    n, wr, pnl, expectancy: n ? pnl / n : 0,
    eodNegRate, t1Rate, payoff, beWR, medStopPct,
    stopCount: stops.length, avgStopLoss,
  };
}

const keys = Object.keys(groups).sort();
if (!keys.length) {
  console.log('No trades found for the requested period.');
  process.exit(0);
}

console.log(`\n${byWeek ? 'WEEKLY' : 'MONTHLY'} SCORECARD  —  baseline: Aug 2026 (pre-fix) vs post-fix months`);
console.log('Fixes shipped 2026-08-27: 15m-ATR stops + full-exit-at-T1\n');

const H = ['period', 'n', 'P&L', 'exp$', 'WR%', 'EODneg%', 'T1hit%', 'payoff', 'beWR%', 'medStop%', 'stops', 'avgSL$'];
const w = [9, 4, 8, 6, 5, 8, 7, 7, 6, 9, 6, 8];
const fmt = (row) => row.map((c, i) => String(c).padStart(w[i])).join(' ');
console.log(fmt(H));
console.log('─'.repeat(w.reduce((s, x) => s + x + 1, 0)));
for (const k of keys) {
  const s = scorecard(groups[k]);
  console.log(fmt([
    k, s.n, s.pnl.toFixed(0), s.expectancy.toFixed(1), s.wr.toFixed(0),
    s.eodNegRate.toFixed(0), s.t1Rate.toFixed(0), s.payoff.toFixed(2),
    s.beWR.toFixed(0), s.medStopPct.toFixed(2), s.stopCount, s.avgStopLoss.toFixed(0),
  ]));
}

// verdict: compare last two periods if we have them
if (keys.length >= 2) {
  const base = scorecard(groups[keys[keys.length - 2]]);
  const test = scorecard(groups[keys[keys.length - 1]]);
  const arrow = (now, was, goodUp) => {
    const better = goodUp ? now > was : now < was;
    return `${now.toFixed(2)} vs ${was.toFixed(2)} ${better ? '✓ better' : '✗ worse'}`;
  };
  console.log(`\nVERDICT  ${keys[keys.length - 2]} -> ${keys[keys.length - 1]}:`);
  console.log(`  EOD-negative rate:  ${arrow(test.eodNegRate, base.eodNegRate, false)}  (want DOWN — fewer trades rotting to a losing close)`);
  console.log(`  T1-hit rate:        ${arrow(test.t1Rate, base.t1Rate, true)}  (want UP — more trades reaching target)`);
  console.log(`  Realized payoff:    ${arrow(test.payoff, base.payoff, true)}  (want UP toward ~1.8-2.0 — the R:R fix)`);
  console.log(`  Median stop %:      ${arrow(test.medStopPct, base.medStopPct, false)}  (want DOWN ~3.8% -> ~1.2% — the 15m-ATR fix)`);
  console.log(`  Expectancy $/trade: ${arrow(test.expectancy, base.expectancy, true)}  (want UP toward 0+ — the bottom line)`);
  const wr = test.wr, be = test.beWR;
  console.log(`\n  Bottom line: WR ${wr.toFixed(0)}% vs breakeven-WR ${be.toFixed(0)}% -> ${wr >= be ? 'MATH WINS ✓' : 'still below breakeven'}`);
}
console.log('');
