// ============================================================================
//  backtest-baseline.mjs — run the REAL strategy engine over historical bars
//  to establish a filter baseline, and VALIDATE it against the real Alpaca book.
//
//  Uses src/features/protrade/backtestEngine.runBacktest, which calls the same
//  evaluateStrategies() the daemon runs live — so this tests the ACTUAL filters,
//  not a Pine/TradingView reimplementation. Fetches 5m + daily bars per symbol
//  from Alpaca IEX (same feed the daemon uses, so no rosy-fill fantasy).
//
//  Step 0 of filter tuning: without a baseline that matches reality, every
//  "tighter filter" comparison is meaningless. If the backtest WR is wildly off
//  from the real ~39%, the backtest is untrustworthy and we fix THAT first.
//
//  USAGE: node scripts/backtest-baseline.mjs [days]   (default 35)
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// creds
const envFile = path.join(ROOT, 'daemon', '.env.daemon');
const env = {};
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) env[m[1]] = m[2];
}
const KEY = env.ALPACA_KEY, SEC = env.ALPACA_SECRET;
const DATA = 'https://data.alpaca.markets';
const DAYS = Number(process.argv[2] || 35);
// Cost model + exit model. Flags: --zero-costs (old free fills), --runner (legacy partial/runner exits).
const ZERO = process.argv.includes('--zero-costs');
const EXIT_MODE = process.argv.includes('--runner') ? 'partial_runner' : 'full_t1';
const LIVE_GATES = !process.argv.includes('--legacy'); // --legacy = old permissive replay
let COSTS; // undefined => engine default (DEFAULT_COSTS)
if (ZERO) COSTS = { commissionPerShare: 0, halfSpreadBps: 0, stopSlipBps: 0, impactY: 0, limitSlipBps: 0 };

// The backtest engine is TypeScript in src/. We import it via tsx-less dynamic
// import of the compiled form if present, else fail loud (we won't fake results).
let runBacktest;
try {
  ({ runBacktest } = await import(pathToFileURL(path.join(ROOT, 'src', 'features', 'protrade', 'backtestEngine.ts')).href));
} catch (e) {
  console.error('Cannot import backtestEngine.ts directly (needs a TS loader).');
  console.error('Run with:  npx tsx scripts/backtest-baseline.mjs');
  console.error('Reason:', e.message);
  process.exit(1);
}

async function bars(symbol, tf, days) {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const url = `${DATA}/v2/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=10000&adjustment=raw&feed=iex`;
  const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.bars || []).map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

// representative universe = most-traded symbols in the real book
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trades.json'), 'utf8'));
const real = (Array.isArray(raw) ? raw : raw.trades || []).filter((t) => !t.phantom && t.id !== '__ALPACA_ANCHOR__' && t.status === 'Closed');
const cnt = {};
real.forEach((t) => { cnt[t.symbol] = (cnt[t.symbol] || 0) + 1; });
// --universe=live : every symbol the live book traded in the window (closer to the live scan breadth);
// default: the 20 most-traded (fast).
const UNIV_LIVE = process.argv.includes('--universe=live');
const winCut = new Date(Date.now() - DAYS * 864e5).toISOString();
if (UNIV_LIVE) { for (const k of Object.keys(cnt)) delete cnt[k]; real.filter((t) => t.openedAt >= winCut).forEach((t) => { cnt[t.symbol] = (cnt[t.symbol] || 0) + 1; }); }
const universe = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, UNIV_LIVE ? 200 : 20).map(([s]) => s);

console.log(`[exit=${EXIT_MODE} costs=${ZERO ? 'ZERO' : 'default'}]`);
console.log(`Backtest baseline — ${universe.length} symbols, ${DAYS}d, REAL engine (evaluateStrategies)
`);

const RETIRED = new Set(['vwap_pullback', 's7_volume_surge', 'orb_retest', 'sniper_1m', 'ema20_bounce']); // keep in sync with entryGate.RETIRED_STRATEGIES

// Collect ALL active backtest trades once, then A/B candidate filters offline.
const allTrades = [];
for (const sym of universe) {
  const [b5, b1d] = await Promise.all([bars(sym, '5Min', DAYS), bars(sym, '1Day', 90)]);
  if (b5.length < 50) { console.log(`  ${sym}: insufficient bars (${b5.length}) — skip`); continue; }
  let res;
  try { res = runBacktest(sym, b5, b1d, 100_000, { costs: COSTS, exitMode: EXIT_MODE, liveGates: LIVE_GATES }); } catch (e) { console.log(`  ${sym}: backtest error ${e.message}`); continue; }
  const t = (res.trades || []).filter((tr) => !RETIRED.has(tr.strategyId));
  for (const tr of t) allTrades.push(tr);
  console.log(`  ${sym}: ${t.length} active trades`);
}

function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const pnl = trades.reduce((s, t) => s + Number(t.dollarPnl || 0), 0);
  const gw = trades.filter((t) => t.dollarPnl > 0).reduce((s, t) => s + t.dollarPnl, 0);
  const gl = Math.abs(trades.filter((t) => t.dollarPnl < 0).reduce((s, t) => s + t.dollarPnl, 0));
  const gross = trades.reduce((s, t) => s + Number(t.grossPnl ?? t.dollarPnl ?? 0), 0);
  return { n, gross: Math.round(gross), wr: n ? Math.round(100 * wins / n) : 0, pnl: Math.round(pnl), exp: n ? pnl / n : 0, pf: gl ? gw / gl : (gw > 0 ? 99 : 0) };
}
function row(label, trades) {
  const s = summarize(trades);
  console.log('  ' + label.padEnd(34), 'n=' + String(s.n).padStart(4), 'WR ' + (s.wr + '%').padStart(4), 'gross $' + String(s.gross).padStart(7), 'net $' + String(s.pnl).padStart(7), 'exp $' + s.exp.toFixed(1).padStart(6), 'PF ' + s.pf.toFixed(2).padStart(5));
  return s;
}

console.log(`\n=== FILTER A/B (${DAYS}d, active strategies, real engine) ===`);
const base = row('BASELINE (current filters)', allTrades);
console.log('  ── candidate tighter filters ──');
// A: RVOL floor variants
row('RVOL >= 1.0', allTrades.filter((t) => t.rvolAtEntry >= 1.0));
row('RVOL >= 1.2', allTrades.filter((t) => t.rvolAtEntry >= 1.2));
row('RVOL >= 1.5', allTrades.filter((t) => t.rvolAtEntry >= 1.5));
// B: mandatory 15m tape alignment
row('15m-tape aligned (mandatory)', allTrades.filter((t) => t.tape15mAligned));
// C: combined — the strict stack
row('RVOL>=1.2 AND tape aligned', allTrades.filter((t) => t.rvolAtEntry >= 1.2 && t.tape15mAligned));

// per-strategy: backtest vs REAL fills over the SAME window, in PERCENT of notional so the
// replay's risk-based sizing and live's multiplier/cap sizing don't distort the comparison.
console.log(`
=== PER STRATEGY, same ${DAYS}d window (pnl% = net P&L / notional; \$ not comparable: different sizing) ===`);
const realWin = real.filter((t) => t.openedAt >= winCut);
const ids = [...new Set([...allTrades.map((t) => t.strategyId), ...realWin.map((t) => t.strategyId)])].filter((i) => i && !RETIRED.has(i)).sort();
const meanPct = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
for (const id of ids) {
  const bt = allTrades.filter((t) => t.strategyId === id);
  const rl = realWin.filter((t) => t.strategyId === id && t.notional > 0);
  const bPct = bt.map((t) => Number(t.pnlPct));
  const rPct = rl.map((t) => (+t.pnl / t.notional) * 100);
  const rw = rl.filter((t) => +t.pnl > 0).length;
  console.log('  ' + id.padEnd(20),
    'BT n=' + String(bt.length).padStart(3), 'WR ' + ((bt.length ? Math.round(100 * bt.filter((t) => t.win).length / bt.length) : 0) + '%').padStart(4), 'mean ' + meanPct(bPct).toFixed(2).padStart(6) + '%',
    ' | REAL n=' + String(rl.length).padStart(3), 'WR ' + ((rl.length ? Math.round(100 * rw / rl.length) : 0) + '%').padStart(4), 'mean ' + meanPct(rPct).toFixed(2).padStart(6) + '%');
}
console.log('  universe: ' + universe.length + ' symbols' + (UNIV_LIVE ? ' (live-traded)' : ' (top-20)'));
fs.writeFileSync(path.join(ROOT, 'logs', 'backtest-trades-last.json'), JSON.stringify(allTrades));

// validation
const realActive = real.filter((t) => !RETIRED.has(t.strategyId));
const realWR = Math.round(100 * realActive.filter((t) => +t.pnl > 0).length / realActive.length);
console.log(`\nVALIDATION: backtest baseline WR ${base.wr}% vs real active WR ${realWR}% — gap ${Math.abs(base.wr - realWR)}pts (<=8 = usable for relative A/B).`);
console.log('NOTE: counts are backtest-relative (engine over-fires vs live scanner); read the DELTA in exp$/PF between variants, not absolute counts.');
