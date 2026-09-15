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
const universe = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s]) => s);

console.log(`Backtest baseline — ${universe.length} symbols, ${DAYS}d, REAL engine (evaluateStrategies)\n`);

const RETIRED = new Set(['vwap_pullback', 's7_volume_surge', 'orb_retest', 'sniper_1m']);

// Collect ALL active backtest trades once, then A/B candidate filters offline.
const allTrades = [];
for (const sym of universe) {
  const [b5, b1d] = await Promise.all([bars(sym, '5Min', DAYS), bars(sym, '1Day', 90)]);
  if (b5.length < 50) { console.log(`  ${sym}: insufficient bars (${b5.length}) — skip`); continue; }
  let res;
  try { res = runBacktest(sym, b5, b1d, 100_000); } catch (e) { console.log(`  ${sym}: backtest error ${e.message}`); continue; }
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
  return { n, wr: n ? Math.round(100 * wins / n) : 0, pnl: Math.round(pnl), exp: n ? pnl / n : 0, pf: gl ? gw / gl : (gw > 0 ? 99 : 0) };
}
function row(label, trades) {
  const s = summarize(trades);
  console.log('  ' + label.padEnd(34), 'n=' + String(s.n).padStart(4), 'WR ' + (s.wr + '%').padStart(4), '$' + String(s.pnl).padStart(7), 'exp $' + s.exp.toFixed(1).padStart(6), 'PF ' + s.pf.toFixed(2).padStart(5));
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

// validation
const realActive = real.filter((t) => !RETIRED.has(t.strategyId));
const realWR = Math.round(100 * realActive.filter((t) => +t.pnl > 0).length / realActive.length);
console.log(`\nVALIDATION: backtest baseline WR ${base.wr}% vs real active WR ${realWR}% — gap ${Math.abs(base.wr - realWR)}pts (<=8 = usable for relative A/B).`);
console.log('NOTE: counts are backtest-relative (engine over-fires vs live scanner); read the DELTA in exp$/PF between variants, not absolute counts.');
