# Sutra Trading Terminal

An intraday day-trading terminal built in React + TypeScript. Combines a live multi-strategy scanner with automated paper trading execution on Alpaca's paper account, risk management, and performance analytics.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS 3.4, Vite 6 |
| Market Data | Alpaca IEX feed (real-time bars, snapshots, news) |
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

## ProTrade — Six Intraday Strategies

The core of Sutra is the ProTrade scanner, which evaluates a live universe of stocks against six intraday momentum strategies every 15 seconds during market hours.

| Code | Strategy | Signal |
|---|---|---|
| S1 | ORB Retest | Opening range breakout with controlled retest within 20 min |
| S2 | VWAP Pullback | Trend continuation after VWAP reclaim |
| S3 | RS Continuation | Relative strength edge vs benchmark |
| S4 | Liquidity Sweep | Stop-hunt reversal after sweep of prior high/low |
| S5 | OB/FVG Retest | Order block or fair value gap retest with rejection |
| S6 | MSS Breakout | Market structure shift with swing confirmation |

### Workflow Stages

Stocks progress through: `raw_candidates → forming → confirmed → locked → trade_ready → ordered`

Only `trade_ready` rows trigger the auto-execute gate.

---

## Auto-Execute: 1-Minute Confirmation Bar Gate

When a symbol reaches `trade_ready`, the engine does **not** fire immediately. It waits for a 1-minute bar to **close** above (BULL) or below (BEAR) the structural entry level with above-average volume before placing a bracket order on Alpaca.

```
trade_ready detected
    ↓
Enqueue symbol (structural level + direction recorded)
    ↓  (next 15s scan cycle)
Fetch last closed 1m bar
    ↓
BULL: close > level AND volume ≥ 1.1× 20-bar avg → FIRE
BEAR: close < level AND volume ≥ 1.1× 20-bar avg → FIRE
    ↓
Pending count shown in HUD as "N confirming" (amber)
Unconfirmed setups expire after 5 minutes
```

This eliminates entries on the breakout bar itself and low-volume fakes.

---

## Stop Loss / Take Profit Architecture

Stops and targets are computed per strategy using these constants (`strategyEngine.ts`):

| Constant | Value | Purpose |
|---|---|---|
| `STOP_BUFFER_ATR` | 0.25× ATR20 | Buffer beyond structural anchor — clears institutional stop-hunt probes (0.10–0.20×ATR) |
| `NOISE_FLOOR_ATR` | 0.35× ATR20 | Minimum stop distance from entry — covers 1m wick + bid-ask noise |
| `T1_RR` | 1.5R | Scale-out at T1 — easier intraday hit; stop moves to breakeven after T1 |
| T2 | Structural (PDH/PDL) | Previous day's high (BULL) or low (BEAR) — real price level, not a mechanical multiplier |

All six strategies use `noiseFlooredStop()` which picks the wider of (structural anchor − buffer) and (entry − noise floor), ensuring stops sit just outside the institutional probe zone without excessive swing-trader room.

---

## Risk Management

- **Position sizing**: `(account × 2% risk) / |entry − stop|` shares, capped at available notional budget
- **Daily loss limit**: configurable (default 8% of starting equity) — blocks new entries if breached
- **Strategy circuit breaker**: 3 consecutive losses pause a strategy for 2 hours
- **Max concurrent positions**: configurable (default 5)
- **Entry cutoff**: no new entries after 3:50 PM ET
- **EOD flat close**: all open positions closed at 3:57 PM ET (before 4:00 PM market close so Alpaca executes at real market prices)

---

## Trade Persistence

Trades are stored in `data/trades.json` via the local trade server. On every state change, changed trades are fire-and-forget POSTed to the server. localStorage is kept in sync as an immediate fallback.

On browser startup, the app loads all server trades and merges them with any localStorage-only trades (auto-migrating orphaned entries to the server).

The Performance tab, Paper Trade Monitor, and Orders tab all read from the server with date filtering (ET timezone).

---

## Performance Analytics

The Performance tab tracks:

- **Win rate**: structural exits only — `Target` and `T1 Profit` are wins; `Stop` is a loss; `EOD` and `Manual` closes are excluded from the W/L record
- **Equity curve**: cumulative daily P&L plotted as an SVG line chart
- **Daily P&L calendar**: heatmap grid by trading date
- **Strategy breakdown**: per-strategy trade count, W/L, and P&L
- **Intraday analytics**: profit factor, average R:R, average hold time, hour-of-day P&L

---

## Outcomes

| Outcome | Meaning |
|---|---|
| `Target` | T2 hit — full position closed at target |
| `T1 Profit` | T1 hit — partial scale-out; remaining stopped at T1 (breakeven+) |
| `Stop` | Structural stop hit — counts as loss |
| `Manual` | User closed from the monitor UI |
| `EOD` | System flat-closed at 3:57 PM ET — not counted as win or loss |

---

## Key Files

```
src/
  components/
    ProTradeScanner.tsx     # Main scanner UI, auto-execute, paper trade monitor
    Execution.tsx           # Orders tab (date picker, Alpaca positions)
    Configuration.tsx       # Performance analytics, risk settings
  features/protrade/
    strategyEngine.ts       # All 6 strategy evaluations, stop/target logic
    proTradeScannerApi.ts   # Scanner snapshot fetch + workflow stage logic
  lib/
    alpacaBroker.ts         # Paper bracket orders, positions, fills
    alpacaClient.ts         # Market data bars, snapshots, news (TTL cache + dedup)
    alpacaBarStream.ts      # WebSocket 5m bar stream (IEX real-time)
    riskManager.ts          # Daily loss limit, circuit breaker, position sizing
    intradayRegime.ts       # Intraday regime detection (SPY range vs ADR)
    tradeStore.ts           # Server-side trade persistence client
trade-server.mjs            # Local Node.js HTTP server — reads/writes data/trades.json
data/trades.json            # Trade history (auto-created, gitignored)
docs/
  hard-gates-stop-loss-plan.md   # Pending: hard gate restoration plan
```

---

## Branch History

### `Stoplossadjusymay5` — 2026-05-05
Tightened SL/TP from swing-trader to intraday parameters:
- `STOP_BUFFER_ATR` 0.50 → 0.25 (avoids institutional stop-hunt zone)
- `NOISE_FLOOR_ATR` 0.75 → 0.35 (covers 1m wick + spread noise)
- T1 2R → 1.5R (faster hit, move to breakeven sooner)
- T2 mechanical 2.5R → structural PDH/PDL (real level, no cap)
- Fixed 429 on `/v2/stocks/snapshots`: clearBarCache scoped to bars/hist only; snapshot TTL 15s→45s; in-flight deduplication on fetchBars + fetchSnapshots
- Fixed CB unpause: added `cbTick` + `accountBalance` to auto-execute effect deps
- Fixed CB daily reset: consecutive loss count resets each new trading day

### `MARKETREGIMEDETECTION` — 2026-05-05
Added intraday session intelligence — system now adapts to market character:

**1. Intraday Regime Detection** (`src/lib/intradayRegime.ts`)
- Fetches SPY 5m bars (today's range) + SPY daily bars (20-day ADR)
- CHOPPY: range < 40% ADR → 50% position size
- NORMAL: 40–65% ADR → 100% size
- TRENDING: > 65% ADR → 100% size
- HUD badge shows live regime + % ADR used (e.g. `CHOPPY 32% ADR · ½ size`)
- Pre-market defaults to NORMAL (no today bars yet)

**2. MAE Tracking** (Maximum Adverse Excursion)
- `mae` field added to every paper trade
- Updated each Alpaca position sync using live `current_price`
- Shown as `MAE $` column in trade table (amber)
- Tells you over time whether stops are tight enough or too wide

**3. Regime-Adjusted Position Sizing**
- Applied consistently: auto-execute, manual paper trade, and Alpaca approve
- CHOPPY day → 50% notional → halves dollar loss before circuit breaker fires

### `WINRATE55` — open
Experimental win-rate filters for S1 (RVOL ≥ 1.2, ADR gate) and S5 (VWAP, RVOL, RSI14, RTH bars, ADR). Under observation.

---

## Pending Work

- **WINRATE55 validation**: need 30–50 trade sample to confirm edge vs noise
- **MAE analysis**: watch MAE vs stop floor over 2–3 weeks to confirm 0.25×/0.35× ATR parameters
- **Date P&L calendar click-to-filter**: clicking a calendar day sets the monitor date
- **Entry confirmation for manual trades**: currently only auto-execute has the 1m confirmation bar gate
