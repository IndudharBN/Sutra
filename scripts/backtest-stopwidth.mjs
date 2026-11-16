// ============================================================================
//  backtest-stopwidth.mjs — does a WIDER minimum stop improve results?
//
//  Motivation (real fills since 2026-08-27, 288 active-strategy trades): trades with a stop
//  >= 2.55% of price won 57% / PF 1.34; tighter stops won 41% / PF 0.73. That is in-sample and
//  confounded, so this replays the SAME bars through the live-gated backtest with different
//  stop-width settings and judges each variant on a held-out period.
//
//  Knobs (see StrategyTuning in strategyEngine.ts; defaults = live):
//    minStopAtr  floor on stop distance, in 15m-ATR multiples   (live 0.5)
//    minStopPct  floor on stop distance, fraction of price      (live 0.005)
//    intradayAtrMult  ceiling multiplier                        (live 4  => 3 x ATR15)
//  NOTE: on high-ATR names the structural stop is already ~4% so small floors never bind; the
//  ceiling is the knob that actually moves stops on those names (smoke test, 2 symbols).
//  Targets scale with the stop (T1 >= 0.9R), so this is a stop+target width test, not stop-only.
//
//  USAGE: npx tsx scripts/backtest-stopwidth.mjs [days=35] [--max=40]
//  Run it OUTSIDE market hours: it is CPU/RAM heavy and runs at low OS priority.
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

try { os.setPriority(0, os.constants.priority.PRIORITY_LOW); } catch { /* best effort */ }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const envFile = path.join(ROOT, 'daemon', '.env.daemon');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) env[m[1]] = m[2];
}
const H = { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 35);
const MAX = Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=40').slice(6));

const { runBacktest } = await import(pathToFileURL(path.join(ROOT, 'src', 'features', 'protrade', 'backtestEngine.ts')).href);

async function bars(symbol, tf, days) {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=10000&adjustment=raw&feed=iex`;
  // Retry transient network failures (a dropped socket killed the first full run after 5 symbols).
  let r;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { r = await fetch(url, { headers: H }); break; } catch (e) {
      if (attempt === 4) { console.log(`  ${symbol}: fetch failed after 4 tries (${e.cause?.code || e.message}) — skipping`); return []; }
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
  if (!r.ok) return [];
  return ((await r.json()).bars || []).map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

const VARIANTS = [
  ['base (live: ceil x4)', {}],
  ['ceiling x3 (tighter)', { intradayAtrMult: 3 }],
  ['ceiling x6', { intradayAtrMult: 6 }],
  ['ceiling x8', { intradayAtrMult: 8 }],
  ['ceiling x12', { intradayAtrMult: 12 }],
  ['floor 3.0 ATR15', { minStopAtr: 3 }],
  ['floor 3.0 + ceil x8', { minStopAtr: 3, intradayAtrMult: 8 }],
  ['floor 1.5% price', { minStopPct: 0.015 }],
  ['floor 2.5% price', { minStopPct: 0.025 }],
];

// universe: symbols the live book traded in the window, most-traded first
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trades.json'), 'utf8'));
const real = (Array.isArray(raw) ? raw : raw.trades || []).filter((t) => !t.phantom && t.id !== '__ALPACA_ANCHOR__' && t.status === 'Closed');
const cut = new Date(Date.now() - DAYS * 864e5).toISOString();
const cnt = {};
real.filter((t) => t.openedAt >= cut).forEach((t) => { cnt[t.symbol] = (cnt[t.symbol] || 0) + 1; });
const universe = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, MAX).map(([s]) => s);
console.log(`Stop-width sweep — ${universe.length} symbols, ${DAYS}d, ${VARIANTS.length} variants, full_t1 exits, default costs, live gates`);

const trades = VARIANTS.map(() => []);
let done = 0;
for (const sym of universe) {
  const [b5, b1d] = await Promise.all([bars(sym, '5Min', DAYS), bars(sym, '1Day', 90)]);
  done++;
  if (b5.length < 50) { console.log(`  ${sym}: insufficient bars — skip`); continue; }
  VARIANTS.forEach(([, tuning], i) => {
    try { trades[i].push(...(runBacktest(sym, b5, b1d, 100_000, { tuning }).trades || [])); } catch (e) { console.log(`  ${sym}/${VARIANTS[i][0]}: ${e.message}`); }
  });
  if (done % 5 === 0) console.log(`  ... ${done}/${universe.length} symbols`);
}

// train = earlier 60% of trading days, test = latest 40% (held out)
const days = [...new Set(trades.flat().map((t) => t.date))].sort();
const splitDay = days[Math.floor(days.length * 0.6)];
console.log(`\nDays ${days[0]} .. ${days[days.length - 1]} (${days.length}); train < ${splitDay} <= test`);

function summarize(ts) {
  const n = ts.length;
  if (!n) return { n: 0, wr: 0, pf: 0, net: 0, mean: 0, stop: 0 };
  const w = ts.filter((t) => t.dollarPnl > 0);
  const gw = w.reduce((a, t) => a + t.dollarPnl, 0);
  const gl = Math.abs(ts.filter((t) => t.dollarPnl < 0).reduce((a, t) => a + t.dollarPnl, 0));
  const stops = ts.map((t) => (Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice) * 100).sort((a, b) => a - b);
  return {
    n, wr: Math.round((100 * w.length) / n), pf: gl ? gw / gl : 9,
    net: Math.round(ts.reduce((a, t) => a + t.dollarPnl, 0)),
    mean: ts.reduce((a, t) => a + Number(t.pnlPct), 0) / n,    // % of notional: sizing-neutral
    stop: stops[Math.floor(n / 2)],
  };
}
const fmt = (s) => `n=${String(s.n).padStart(4)} WR ${String(s.wr).padStart(3)}% PF ${s.pf.toFixed(2)} net $${String(s.net).padStart(6)} mean ${s.mean.toFixed(3).padStart(6)}% medStop ${s.stop.toFixed(2)}%`;
const out = [];
console.log('\nVARIANT                  | ALL                                                              | TEST (held-out)');
VARIANTS.forEach(([name], i) => {
  const all = summarize(trades[i]);
  const te = summarize(trades[i].filter((t) => t.date >= splitDay));
  const tr = summarize(trades[i].filter((t) => t.date < splitDay));
  out.push({ name, all, train: tr, test: te });
  console.log(name.padEnd(24), '|', fmt(all), '|', fmt(te));
});
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'logs', 'stopwidth-results.json'), JSON.stringify({ at: new Date().toISOString(), days: DAYS, universe, splitDay, out }, null, 1));
console.log('\nSaved logs/stopwidth-results.json');
