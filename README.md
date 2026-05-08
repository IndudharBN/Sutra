# Sutra Trading Terminal

An intraday day-trading terminal built in React + TypeScript. Combines a live multi-strategy scanner with automated paper trading execution on Alpaca's paper account, risk management, and performance analytics.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS 3.4, Vite 6 |
| Market Data | Alpaca IEX feed (bars, snapshots, news, WebSocket stream) |
| Paper Execution | Alpaca Paper Trading API (bracket orders) |
| Trade Persistence | Local Node.js JSON file server (`trade-server.mjs`) |
| Charting | TradingView widget + lightweight-charts (equity curve) |

---

## Running Locally

```bash
npm install
cp .env.example .env.local   # fill in Alpaca keys
npm run dev                   # starts Vite (port 3006) + trade server (port 3009) together
```

The Vite dev server starts `trade-server.mjs` automatically as a child process. No second terminal needed.

Open: `http://localhost:3006`

### Running the trade server standalone (optional)

```bash
npm run trade-server
```

Trade history is written to `data/trades.json` and survives browser refreshes.

---

## Environment Variables

Copy `.env.example` to `.env.local`:

```text
VITE_ALPACA_KEY          # Alpaca API key ID  (paper account)
VITE_ALPACA_SECRET       # Alpaca API secret key
VITE_ALPACA_DATA_URL     # optional — defaults to https://data.alpaca.markets
VITE_APP_NAME            # display name (default: Sutra)
```

Get free paper trading API keys at [alpaca.markets](https://alpaca.markets).

---

## ProTrade — Seven Intraday Strategies

The core of Sutra is the ProTrade scanner, which evaluates a live universe of ~100 stocks against seven intraday strategies. Full scan runs every 60 seconds; a hot-set refresh (forming/confirmed/locked stocks only) runs every 20 seconds.

| Code | Strategy | Signal Type | Hard Gates |
|---|---|---|---|
| S1 | ORB Retest | Opening range breakout + controlled retest | direction, confirmedBreak, retest |
| S2 | VWAP Pullback | Trend continuation after VWAP reclaim | direction, touchedValue, reclaimed |
| S3 | RS Continuation | Relative strength vs SPY on micro range break | direction, breakout, rvol ≥ 1.0 |
| S4 | Liquidity Sweep | Stop-hunt reversal after OR sweep + reclaim | direction, swept, sweepWick, reclaimed, nearLevel |
| S5 | OB/FVG Retest | Order block or fair value gap retest with rejection | direction, hasStructure, fvgQuality, entryConfirmation |
| S6 | MSS Breakout | Market structure shift with clear path ahead | direction, mssOk, !zoneBlocked |
| S7 | Volume Surge | Institutional 2× volume spike on 15m range break | direction, volSpike ≥ 2×, isBreakout |

All other checks (VWAP context, RVOL, trend alignment, RSI, ADR room) are **informational** — visible in the checklist UI but never block execution.

### Gate Philosophy

Each strategy uses **2–3 hard gates maximum**. Hard gates represent the irreducible structural conditions for the setup. Everything else is context shown in the UI for human review.

### Workflow Stages

Stocks progress through: `raw_candidates → forming → confirmed → locked → trade_ready → ordered`

Only `trade_ready` rows trigger the auto-execute gate.

---

## Direction Logic

Per-stock direction is derived from the **15m EMA trend** (institutional timeframe, stable across the session):

```
trend15m = UP   → direction = BULL
trend15m = DOWN → direction = BEAR
gap% > +0.5%    → direction = BULL  (early session fallback)
gap% < -0.5%    → direction = BEAR  (early session fallback)
otherwise       → direction = NEUTRAL (no trade)
```

The 15m EMA is computed on the last 80 bars of 15m candle data, which includes yesterday's close. Direction is available from the first scan of the day.

---

## Macro Regime

The scanner classifies a daily macro regime from SPY's closing price vs its 200-day EMA and VIX level. This scales position size — not trade frequency.

| Regime | Condition | Size Multiplier |
|---|---|---|
| BULL | SPY > EMA200 and VIX < 20 | 1.0× |
| SIDEWAYS | SPY > EMA200 but VIX 20–30 | 0.75× |
| BEAR | SPY < EMA200 or VIX > 30 | 0.5× |

SPY daily bars (250 bars) are fetched once per session and cached for 1 hour. VIX is attempted via Alpaca IEX but not available on the free feed — regime falls back gracefully to SPY-only classification.

---

## Auto-Execute Gate

**S1 and S7 fire instantly** when `trade_ready` is detected — no 1m bar confirmation. These are momentum/gap strategies where delay means missing the move.

**S2–S6** wait for a 1-minute confirmation bar to close above (BULL) or below (BEAR) the structural entry level before placing a bracket order:

```
trade_ready detected (S2–S6)
    ↓
Enqueue symbol (level + direction recorded)
    ↓  (next scan cycle)
Fetch last closed 1m bar
    ↓
BULL: close > level AND volume ≥ 1.1× 20-bar avg → FIRE
BEAR: close < level AND volume ≥ 1.1× 20-bar avg → FIRE
    ↓
Unconfirmed setups expire after 5 minutes
```

---

## Stop Loss Architecture

Stops are computed per strategy using two constants:

| Constant | Value | Purpose |
|---|---|---|
| `STOP_BUFFER_ATR` | 0.5× ATR20 | Structural buffer below/above anchor candle extreme |
| `NOISE_FLOOR_ATR` | 0.75× ATR20 | Minimum stop distance from entry — no stop tighter than this |

All strategies use `noiseFlooredStop()` to enforce the floor. Stops are always at least 0.75× the daily ATR away from entry.

### Two-Phase Trailing Stop (T1/T2)

| Event | Action |
|---|---|
| T1 hit (1.5R) | Scale out 50%, move stop to breakeven (entry) |
| Price pulls back to T1 zone (±0.3%) | Advance stop to T1 level |
| T2 hit (2.5R or structural PDH/PDL) | Close remaining position |

T2 is anchored to the previous day's high (BULL) or low (BEAR), capped at 3R and floored at 2.5R to prevent collapse.

---

## Session Gates

| Window | Behaviour |
|---|---|
| Pre-market | All strategies locked |
| 9:30–9:45 AM ET (blackout) | All locked except S7 on gap ≥ 3% days |
| 9:45 AM–3:50 PM ET | Normal execution window |
| After 3:50 PM ET | No new entries |
| 3:57 PM ET | EOD flat-close — all open positions closed |

---

## Risk Management

- **Position sizing**: `(account × 2% risk) / |entry − stop|` shares, scaled by macro regime multiplier
- **Daily loss limit**: configurable (default 8% of starting equity) — blocks new entries if breached
- **Strategy circuit breaker**: 3 consecutive losses pause a strategy for 2 hours
- **Max concurrent positions**: configurable (default 5)
- **basePass filter**: price $1–$1500, ATR% 1.5–12%, dollar volume ≥ $3M — stocks failing this are not scanned

---

## WebSocket Bar Stream

Stocks at `forming`, `confirmed`, `locked`, or `trade_ready` stage are subscribed to Alpaca's real-time WebSocket bar stream. On each 5m bar close:

1. Bar cache for that symbol is evicted (snapshot cache preserved to avoid 429s)
2. Strategy signals are re-evaluated immediately
3. S7 (volume surge) is detected within seconds of the triggering bar closing

---

## Trade Persistence

Trades are stored in `data/trades.json` via the local trade server. On every state change, changed trades are POSTed to the server. localStorage is kept in sync as an immediate fallback.

On browser startup, the app loads all server trades and merges them with any localStorage-only trades.

---

## Performance Analytics

The Performance tab tracks:

- **Win rate**: `Target` and `T1 Profit` are wins; `Stop` is a loss; `EOD` and `Manual` are excluded
- **Equity curve**: cumulative daily P&L as an SVG line chart
- **Daily P&L calendar**: heatmap grid by trading date
- **Strategy breakdown**: per-strategy trade count, W/L, and P&L
- **Intraday analytics**: profit factor, average R:R, average hold time, hour-of-day P&L

---

## Outcomes

| Outcome | Meaning |
|---|---|
| `Target` | T2 hit — full position closed at target |
| `T1 Profit` | T1 hit — partial scale-out; remaining held to T2 or stopped at T1 |
| `Stop` | Structural stop hit — counts as loss |
| `Manual` | User closed from the monitor UI |
| `EOD` | System flat-closed at 3:57 PM ET — not counted as win or loss |

---

## Key Files

```
src/
  components/
    ProTradeScanner.tsx      # Main scanner UI, auto-execute, paper trade monitor
    Execution.tsx            # Orders tab (Alpaca positions, filled orders)
    Configuration.tsx        # Performance analytics, risk settings
  features/protrade/
    strategyEngine.ts        # All 7 strategy evaluations, stop/target logic
    proTradeScannerApi.ts    # Scanner snapshot fetch, direction logic, workflow stages
    workflowTypes.ts         # Shared types: WorkflowStage, StrategyId, TradePlan
  features/marketRegime/
    marketRegimeLogic.ts     # SPY EMA200 + VIX regime classification
  lib/
    alpacaBroker.ts          # Paper bracket orders, positions, fills
    alpacaClient.ts          # Market data: bars, snapshots, news, WebSocket
    alpacaBarStream.ts       # WebSocket real-time bar subscriptions
    riskManager.ts           # Daily loss limit, circuit breaker, position sizing
    tradeStore.ts            # Server-side trade persistence client
trade-server.mjs             # Local Node.js HTTP server — reads/writes data/trades.json
data/trades.json             # Trade history (auto-created, gitignored)
```

---

## API Rate Limit Notes (Alpaca IEX Free Tier)

- Snapshot endpoint (`/v2/stocks/snapshots`) has the strictest rate limit
- Snapshot TTL is 30s — hot-set (20s cycle) reuses cached data on alternate cycles
- Bar cache is evicted on WebSocket bar close; snapshot cache is preserved
- Run only **one browser tab** at a time — each tab runs an independent scan cycle
- Stop any running `bt_run.mjs` or `diag_run.mjs` processes during live scanning
