#!/usr/bin/env node
// Read-only reconciliation: compare the internal ledger's realized P&L against
// Alpaca's actual account equity curve. Reports the divergence per day and the
// total. Makes NO changes — truth report only.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load env from daemon/.env.daemon
const envPath = path.join(root, 'daemon', '.env.daemon');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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

const trades = JSON.parse(fs.readFileSync(path.join(root, 'data', 'trades.json'), 'utf8'));
const closed = trades.filter((t) => t.status === 'Closed' && t.pnl != null);

// Ledger realized P&L by ET day
const byDay = {};
for (const t of closed) {
  const day = (t.closedAt || t.openedAt || '').slice(0, 10);
  byDay[day] = (byDay[day] || 0) + t.pnl;
}

// Alpaca equity curve
const hist = await api('/v2/account/portfolio/history?period=3M&timeframe=1D&extended_hours=true');
const acct = await api('/v2/account');

const alpDay = {};
for (let i = 0; i < hist.timestamp.length; i++) {
  const day = new Date(hist.timestamp[i] * 1000).toISOString().slice(0, 10);
  alpDay[day] = { equity: hist.equity[i], pl: hist.profit_loss[i] };
}

console.log('\n=== LEDGER vs ALPACA — realized P&L by day ===\n');
console.log('day         ledger$      alpaca$      divergence');
console.log('─'.repeat(52));
const days = [...new Set([...Object.keys(byDay), ...Object.keys(alpDay)])].sort();
let ledTot = 0, alpTot = 0;
for (const d of days) {
  const l = byDay[d] ?? null;
  const a = alpDay[d]?.pl ?? null;
  if (l == null && (a == null || Math.abs(a) < 0.01)) continue;
  if (l != null) ledTot += l;
  if (a != null) alpTot += a;
  const div = (l ?? 0) - (a ?? 0);
  const fmt = (x) => x == null ? '     --  ' : (x >= 0 ? '+' : '') + x.toFixed(2).padStart(9);
  const flag = Math.abs(div) > 100 ? '  <<< ' + (div > 0 ? 'ledger overstates' : 'ledger understates') : '';
  console.log(`${d}  ${fmt(l)}  ${fmt(a)}  ${fmt(div)}${flag}`);
}
console.log('─'.repeat(52));
console.log(`TOTAL      ${(ledTot>=0?'+':'')+ledTot.toFixed(2).padStart(9)}  ${(alpTot>=0?'+':'')+alpTot.toFixed(2).padStart(9)}  ${((ledTot-alpTot)>=0?'+':'')+(ledTot-alpTot).toFixed(2).padStart(9)}`);
console.log(`\nLedger claims:  $${(100000+ledTot).toLocaleString()} equity`);
console.log(`Alpaca actual:  $${Number(acct.equity).toLocaleString()} equity`);
console.log(`REAL P&L since inception: ${(Number(acct.equity)-100000>=0?'+':'')}$${(Number(acct.equity)-100000).toFixed(2)}`);
console.log(`Ledger overstatement: $${(ledTot-(Number(acct.equity)-100000)).toFixed(2)}\n`);
