// ============================================================================
//  backtest-deadtrade.mjs — do time-stops / dead-trade exits help?
//
//  Real fills since 2026-08-27 (429 trades): 70% of trades hit neither target nor stop and are
//  flattened at the close (median hold 274 min, avg -0.36%, net -$8.5k). 77% of them never got
//  +0.5R in their favour; none reached +1R. This replays the SAME bars through the live-gated
//  backtest with different "exit if it hasn't made progress" rules and judges each variant on a
//  held-out period (latest 40% of days), plus shows what happened to every trade the rule cut.
//
//  R = entry-to-stop distance. Rules are evaluated once, at a bar close (decision time).
//  USAGE: npx tsx scripts/backtest-deadtrade.mjs [days=35] [--max=40]
//  Run OUTSIDE market hours (heavy; runs at low OS priority).
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
  ['base (live exits)', {}],
  ['A: 12:30 ET if <0.3R', { deadTrade: { atEtMin: 750, minProgressR: 0.3 } }],
  ['B: 13:30 ET if <0.3R', { deadTrade: { atEtMin: 810, minProgressR: 0.3 } }],
  ['C: 12:30 ET if flat/down', { deadTrade: { atEtMin: 750, requireLosing: true } }],
  ['D: A + no entry after 12:00', { deadTrade: { atEtMin: 750, minProgressR: 0.3 }, noEntryAfterMin: 720 }],
  ['E: 90m held if <0.3R', { deadTrade: { afterHoldMin: 90, minProgressR: 0.3 } }],
  ['F: 120m held if <0.5R', { deadTrade: { afterHoldMin: 120, minProgressR: 0.5 } }],
  ['G: no entry after 12:00', { noEntryAfterMin: 720 }],
];

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trades.json'), 'utf8'));
const real = (Array.isArray(raw) ? raw : raw.trades || []).filter((t) => !t.phantom && t.id !== '__ALPACA_ANCHOR__' && t.status === 'Closed');
const cut = new Date(Date.now() - DAYS * 864e5).toISOString();
const cnt = {};
real.filter((t) => t.openedAt >= cut).forEach((t) => { cnt[t.symbol] = (cnt[t.symbol] || 0) + 1; });
const universe = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, MAX).map(([s]) => s);
console.log(`Dead-trade experiment — ${universe.length} symbols, ${DAYS}d, ${VARIANTS.length} variants, full_t1 exits, default costs, live gates`);

const trades = VARIANTS.map(() => []);
let done = 0;
for (const sym of universe) {
  const [b5, b1d] = await Promise.all([bars(sym, '5Min', DAYS), bars(sym, '1Day', 90)]);
  done++;
  if (b5.length < 50) { console.log(`  ${sym}: insufficient bars — skip`); continue; }
  VARIANTS.forEach(([, opts], i) => {
    try { trades[i].push(...(runBacktest(sym, b5, b1d, 100_000, opts).trades || [])); } catch (e) { console.log(`  ${sym}/${VARIANTS[i][0]}: ${e.message}`); }
  });
  if (done % 5 === 0) console.log(`  ... ${done}/${universe.length} symbols`);
}

const days = [...new Set(trades.flat().map((t) => t.date))].sort();
const splitDay = days[Math.floor(days.length * 0.6)];
console.log(`\nDays ${days[0]} .. ${days[days.length - 1]} (${days.length}); train < ${splitDay} <= test (held-out)`);

function summarize(ts) {
  const n = ts.length;
  if (!n) return { n: 0, wr: 0, pf: 0, net: 0, mean: 0, tgt: 0, stp: 0, eod: 0, dead: 0 };
  const w = ts.filter((t) => t.dollarPnl > 0);
  const gw = w.reduce((a, t) => a + t.dollarPnl, 0);
  const gl = Math.abs(ts.filter((t) => t.dollarPnl < 0).reduce((a, t) => a + t.dollarPnl, 0));
  const pc = (f) => Math.round((100 * ts.filter(f).length) / n);
  return {
    n, wr: Math.round((100 * w.length) / n), pf: gl ? gw / gl : 9,
    net: Math.round(ts.reduce((a, t) => a + t.dollarPnl, 0)),
    mean: ts.reduce((a, t) => a + Number(t.pnlPct), 0) / n,
    tgt: pc((t) => t.outcome === 'target1' || t.outcome === 'target2'), stp: pc((t) => t.outcome === 'stop' || t.outcome === 'breakeven'),
    eod: pc((t) => t.outcome === 'eod'), dead: pc((t) => t.outcome === 'dead'),
  };
}
const fmt = (s) => `n=${String(s.n).padStart(4)} WR ${String(s.wr).padStart(3)}% PF ${s.pf.toFixed(2)} net $${String(s.net).padStart(6)} mean ${s.mean.toFixed(3).padStart(6)}% | tgt ${String(s.tgt).padStart(2)}% stop ${String(s.stp).padStart(2)}% eod ${String(s.eod).padStart(2)}% dead ${String(s.dead).padStart(2)}%`;

const key = (t) => `${t.symbol}|${t.date}|${t.entryTime}`;
const baseByKey = new Map(trades[0].map((t) => [key(t), t]));
const out = [];
console.log('\nVARIANT                      | ALL');
VARIANTS.forEach(([name], i) => out.push({ name, all: summarize(trades[i]), train: summarize(trades[i].filter((t) => t.date < splitDay)), test: summarize(trades[i].filter((t) => t.date >= splitDay)) }));
out.forEach((o) => console.log(o.name.padEnd(28), '|', fmt(o.all)));
console.log('\nVARIANT                      | HELD-OUT TEST (latest 40% of days)');
out.forEach((o) => console.log(o.name.padEnd(28), '|', fmt(o.test)));

console.log('\nWHAT THE RULE CUT (per variant, vs the same trade under live exits):');
VARIANTS.forEach(([name], i) => {
  const dead = trades[i].filter((t) => t.outcome === 'dead');
  if (!dead.length) return;
  let saved = 0, killedWin = 0, killedWinUsd = 0, stoppedAnyway = 0;
  const baseOut = {};
  for (const t of dead) {
    const b = baseByKey.get(key(t));
    if (!b) continue;
    saved += t.dollarPnl - b.dollarPnl;           // + means the early exit beat what live exits would have produced
    baseOut[b.outcome] = (baseOut[b.outcome] || 0) + 1;
    if (b.outcome === 'target1' || b.outcome === 'target2') { killedWin++; killedWinUsd += b.dollarPnl - t.dollarPnl; }
    if (b.outcome === 'stop') stoppedAnyway++;
  }
  console.log(` ${name.padEnd(28)} cut ${String(dead.length).padStart(3)} trades | net effect vs base on those: $${saved.toFixed(0)} | would have hit target: ${killedWin} (cost $${killedWinUsd.toFixed(0)}) | would have stopped: ${stoppedAnyway} | base outcomes: ${JSON.stringify(baseOut)}`);
});

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'logs', 'deadtrade-results.json'), JSON.stringify({ at: new Date().toISOString(), days: DAYS, universe, splitDay, out }, null, 1));
console.log('\nSaved logs/deadtrade-results.json');
