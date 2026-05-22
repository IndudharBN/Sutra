# Sutra Daemon Architecture

## Overview

Sutra's current architecture requires a browser tab open at `localhost:3006` for scans, EOD
closes, and trade monitoring to run. The daemon architecture moves all execution logic to a
persistent Node.js process (the **daemon**) so the browser becomes a pure display layer.

```
┌─────────────────────────────────────────────────────────────────┐
│                         VPS / Local Machine                     │
│                                                                 │
│   ┌──────────────────────┐     ┌───────────────────────────┐   │
│   │   Sutra Daemon       │     │   Trade Server            │   │
│   │   (daemon/index.mjs) │────▶│   (trade-server.mjs)      │   │
│   │                      │     │   POST/GET/DELETE trades  │   │
│   │  • Market schedule   │     └───────────────────────────┘   │
│   │  • Full-universe scan│              │                       │
│   │  • Signal evaluation │              ▼                       │
│   │  • Paper trade exec  │     ┌───────────────────────────┐   │
│   │  • EOD close         │     │   data/trades.json        │   │
│   │  • SSE push to UI    │     └───────────────────────────┘   │
│   └──────────┬───────────┘                                      │
│              │ SSE / REST                                        │
└──────────────┼──────────────────────────────────────────────────┘
               │
        ┌──────▼──────┐
        │  Browser    │
        │  Display    │
        │  (React UI) │
        │  read-only  │
        └─────────────┘
```

---

## Market Schedule (ET)

| Time       | Event                                                    |
|------------|----------------------------------------------------------|
| 04:00 AM   | Daemon warmup — load SPY candles, compute VWAP baseline  |
| 08:00 AM   | Pre-market scan begins — start building hot-set          |
| 09:30 AM   | Market open — trading gate opens                        |
| 09:30–10:15| ORB window active — S1, S10 eligible                    |
| 03:50 PM   | Gate close — no new entries                             |
| 03:57 PM   | EOD close — all open positions closed at market          |
| 04:00 PM   | Market close                                             |
| 04:05 PM   | Hard-close — any remaining open trades force-closed      |
| 04:05 PM+  | Daemon idles until next session                         |

**S10/S11/S12 exemption:** 15-minute strategies (`orb15m_retest`, `vwap15m_pullback`,
`ema20_bounce_15m`) are exempt from the 3:57 PM EOD close but are still hard-closed at 4:05 PM.

---

## Directory Structure

```
sutra/
├── daemon/
│   ├── index.mjs              # Main daemon entry point (PM2 target)
│   ├── scheduler.mjs          # Market-hours cron / schedule logic
│   ├── scanner.mjs            # Wraps src/features scanner for Node.js
│   ├── tradeExecutor.mjs      # Paper + live order routing
│   ├── eodManager.mjs         # EOD / hard-close / startup stale-close
│   ├── sseServer.mjs          # Server-Sent Events push to browser
│   └── ecosystem.config.cjs   # PM2 process config
├── src/                       # React UI (display-only in daemon mode)
│   ├── components/
│   │   └── ProTradeScanner.tsx
│   └── features/protrade/
│       └── confluenceClassifier.ts
├── trade-server.mjs           # REST API for trades.json
├── data/
│   └── trades.json
└── docs/
    └── SUTRA-DAEMON-ARCHITECTURE.md   ← this file
```

---

## API Endpoints

### Trade Server (`trade-server.mjs` — port 3007)

| Method   | Path                  | Description                        |
|----------|-----------------------|------------------------------------|
| GET      | `/api/trades`         | Load all trades (optional `?date=`)  |
| POST     | `/api/trades`         | Upsert a single trade (by `id`)    |
| DELETE   | `/api/trades`         | Clear all trades                   |
| PATCH    | `/api/trades/:id`     | Partial update (close, outcome)    |

### Daemon API (`daemon/index.mjs` — port 3008)

| Method   | Path                     | Description                                  |
|----------|--------------------------|----------------------------------------------|
| GET      | `/api/signals`           | Latest signal snapshot for all tickers       |
| GET      | `/api/events`            | SSE stream — push signal/trade updates       |
| POST     | `/api/execute/:symbol`   | Manually trigger entry for a signal          |
| GET      | `/api/status`            | Daemon heartbeat, last-scan timestamp        |
| POST     | `/api/eod`               | Trigger EOD close manually                   |

---

## Data Flow

```
Yahoo Finance / Alpaca
        │
        ▼
daemon/scanner.mjs
  • fetchCandles()
  • computeVWAP(), computeORBLevels()
  • evaluateStrategies()
  • classifySignalGroup()
        │
        ▼
daemon/tradeExecutor.mjs
  • apply hard gates (obReject, marketCap, RVOL)
  • apply session gate (9:30–3:50 PM ET)
  • apply tide multiplier
  • call riskManager → notional / share count
  • persistTrade() → trade-server POST
        │
        ▼
daemon/sseServer.mjs
  • broadcast signal snapshot
  • broadcast trade events (open, close, SL hit, T1 hit)
        │
        ▼
Browser (React UI)
  • read-only subscription via EventSource
  • renders ProTradeScanner display
  • sends manual entry intent → POST /api/execute/:symbol
```

---

## State Management

The daemon keeps two layers of state:

### In-memory (fast path)
```js
daemonState = {
  lastScanAt: Date,
  signals: Map<symbol, StrategySignal[]>,
  openTrades: PaperTradeRecord[],
  hotSet: Set<string>,
  spyTrend: 'BULL' | 'BEAR' | 'FLAT',
  orbHigh: number, orbLow: number,
  vwap: number,
}
```

### Persisted (crash recovery)
`data/daemon-state.json` — written on every scan cycle and after every trade event.
On startup the daemon reads this file to restore `openTrades` and skip stale-open detection
if the shutdown was clean.

---

## PM2 Configuration

`daemon/ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'sutra-trade-server',
      script: './trade-server.mjs',
      watch: false,
      autorestart: true,
      env: { PORT: 3007, NODE_ENV: 'production' },
    },
    {
      name: 'sutra-daemon',
      script: './daemon/index.mjs',
      watch: false,
      autorestart: true,
      cron_restart: '0 4 * * 1-5',   // restart at 4 AM ET Mon-Fri
      env: { PORT: 3008, NODE_ENV: 'production' },
    },
  ],
};
```

**Start everything:**
```bash
pm2 start daemon/ecosystem.config.cjs
pm2 save          # persist across reboots
pm2 startup       # install OS service (systemd / launchd / Windows SCM)
```

**System sleep / shutdown:**
- PM2 restores all apps on system wake or reboot via the OS service.
- On daemon startup, `eodManager.mjs` checks `data/daemon-state.json` for any open trades
  from a prior session and auto-closes them if the date has changed or it is past 4:05 PM ET.

---

## VPS Specifications (AWS)

| Resource | Spec                                   |
|----------|----------------------------------------|
| Instance | EC2 t3.micro                           |
| Region   | us-east-1 (closest to NYSE low-latency)|
| vCPU     | 2                                      |
| RAM      | 2 GB                                   |
| Storage  | 40 GB SSD (gp3)                        |
| OS       | Ubuntu 24.04 LTS                       |
| Cost     | ~$8/month (on-demand) or ~$5 reserved  |
| Runtime  | Node.js 22 LTS + PM2                   |

**Why t3.micro:** The scanner runs every 60 s and the hot-set refresh every 20 s. Peak RSS
for the Node.js process is ~180 MB. Two processes (daemon + trade-server) fit comfortably in
2 GB with headroom for OS + PM2 overhead.

---

## Migration Path (5 Phases)

### Phase 1 — Extract scanner to Node.js (no UI change)
- Copy `src/features/protrade/` strategy engine to `daemon/scanner.mjs`
- Run full-universe scan on a 60 s cron
- Write results to `data/daemon-signals.json`
- UI reads the JSON file — no SSE yet

### Phase 2 — SSE push
- `daemon/sseServer.mjs` broadcasts signal snapshots on each scan
- `ProTradeScanner.tsx` subscribes via `EventSource` instead of polling
- Browser tab can now be closed without losing signal delivery

### Phase 3 — Daemon-side trade execution
- `daemon/tradeExecutor.mjs` handles paper trade open/close logic
- EOD close, startup stale-close, and hard-close all live in the daemon
- Browser sends **intent** (POST `/api/execute/:symbol`); daemon executes
- Re-entry block persisted in `data/daemon-state.json` (not localStorage)

### Phase 4 — Live Alpaca order routing
- Daemon calls Alpaca REST API for bracket orders (SL + T1 server-side)
- T2 trailing stop submitted as a separate order after T1 fills (via Alpaca order webhook)
- Positions survive browser close completely; daemon is the sole order manager

### Phase 5 — Cloud VPS deploy
- Push daemon to EC2 t3.micro via SSH / GitHub Actions CD
- PM2 ecosystem on VPS — auto-start on boot, restart on crash
- Browser UI served from Vercel / Netlify (static build)
- Browser connects to VPS SSE endpoint and trade-server REST API over HTTPS

---

## Re-entry Block (Daemon-side persistence)

Currently stored in `localStorage` (browser). In daemon mode, this moves to
`data/daemon-state.json` under `stoppedToday`:

```json
{
  "stoppedToday": [
    { "key": "AAPL|orb_retest|LONG", "stoppedAt": "2026-05-21T14:32:00Z" }
  ]
}
```

Block key: `SYMBOL|STRATEGY|DIRECTION` — blocks the same strategy+direction after a stop-loss,
allows the opposite direction (e.g., LONG stop → SHORT still eligible).
Clears at midnight ET (daemon daily restart via PM2 cron).

---

## S10 / S11 / S12 EOD Exemption

Strategies on the 15-minute timeframe have later natural exits:

| Strategy ID        | Name                | EOD exempt | Hard-close |
|--------------------|---------------------|------------|------------|
| `orb15m_retest`    | S10 — 15m OB retest | ✓ (3:57 PM)| 4:05 PM    |
| `vwap15m_pullback` | S11 — 15m VWAP pull | ✓ (3:57 PM)| 4:05 PM    |
| `ema20_bounce_15m` | S12 — 15m EMA bounce| ✓ (3:57 PM)| 4:05 PM    |

All other strategies close at 3:57 PM ET.

---

## Current Port Map

| Port | Service                      |
|------|------------------------------|
| 3006 | Vite dev server (React UI)   |
| 3007 | Trade server (`trades.json`) |
| 3008 | Daemon API + SSE *(planned)* |

---

*Last updated: 2026-05-21 — designed during architecture session.*
