// ============================================================================
//  calibrate-costs.mjs — measure REAL slippage from the Alpaca-reconciled ledger so
//  the backtest cost model (src/features/protrade/costs.ts) is not a guess.
//
//  What is measurable:
//   - STOP exits: ledger has the planned stop AND the real exit fill  -> exact adverse bps.
//   - TARGET exits: resting limit; expect ~0 (or small price improvement).
//   - ENTRY: ledger stores the real fill only; planned price is not stored. Proxy = fill vs
//     the close of the last completed 1-min bar before openedAt (includes noise + spread,
//     so it is an UPPER-ish bound on pure half-spread).
//
//  Only trades since the full-T1 bracket era (2026-08-27) with a reconciled fill.
//  USAGE: node scripts/calibrate-costs.mjs [--no-entry]
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const envFile = path.join(ROOT, 'daemon', '.env.daemon');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*(ALPACA_[A-Z_]+)\s*=\s*(.+?)\s*$/); if (m) env[m[1]] = m[2];
}
const H = { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
const SKIP_ENTRY = process.argv.includes('--no-entry');
const ERA_START = '2026-08-27';

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trades.json'), 'utf8'));
const all = (Array.isArray(raw) ? raw : raw.trades || []).filter((t) => !t.phantom && t.id !== '__ALPACA_ANCHOR__' && t.status === 'Closed'
  && t.openedAt >= ERA_START && t.exitPrice > 0 && t.entry > 0);

const stat = (a) => {
  if (!a.length) return 'n=0';
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return `n=${a.length} mean=${mean.toFixed(1)}bps median=${q(0.5).toFixed(1)} p25=${q(0.25).toFixed(1)} p75=${q(0.75).toFixed(1)} p90=${q(0.9).toFixed(1)}`;
};

// adverse bps: positive = worse for us
const stops = [], targets = [], eods = [];
for (const t of all) {
  const bull = t.direction === 'BULL';
  const exitSide = (ref) => (bull ? (ref - t.exitPrice) : (t.exitPrice - ref)) / ref * 1e4;
  const o = String(t.outcome || '').toLowerCase();
  if (o === 'stop') stops.push(exitSide(t.stop));
  else if (o === 'target') targets.push(exitSide(t.target1 || t.target));
}
console.log(`Trades in era: ${all.length}  (outcomes: ${[...new Set(all.map((t) => t.outcome))].join(', ')})`);
console.log('STOP exit  vs planned stop  :', stat(stops));
console.log('TARGET exit vs planned T1   :', stat(targets), ' (limit: ~0 or negative = improvement)');

if (!SKIP_ENTRY) {
  const entries = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let done = 0;
  for (const t of all) {
    const opened = new Date(t.openedAt).getTime();
    const start = new Date(opened - 4 * 60_000).toISOString();
    const end = new Date(opened).toISOString();
    const url = `https://data.alpaca.markets/v2/stocks/${t.symbol}/bars?timeframe=1Min&start=${start}&end=${end}&limit=10&adjustment=raw&feed=iex`;
    try {
      const r = await fetch(url, { headers: H });
      if (r.ok) {
        const bars = ((await r.json()).bars || []).filter((b) => new Date(b.t).getTime() + 60_000 <= opened + 1000);
        const ref = bars.length ? bars[bars.length - 1].c : 0;
        if (ref > 0) {
          const bull = t.direction === 'BULL';
          entries.push((bull ? (t.entry - ref) : (ref - t.entry)) / ref * 1e4);
        }
      }
    } catch { /* skip */ }
    if (++done % 50 === 0) await sleep(15_000); else await sleep(350);
  }
  console.log('ENTRY fill vs prior 1m close:', stat(entries), ' (proxy: noise + half-spread)');
}
console.log('\nModel defaults today: halfSpreadBps 5, stopSlipBps 5 (stop total 10bps). Compare medians above.');
