# Testing Plan

## Completed In This Build

- Project structure created.
- AI Studio design imported.
- Sutra branding applied.
- Supabase config scaffolded.
- Broker adapter scaffolded.
- SQL schema drafted.
- Dependency install completed.
- TypeScript check completed.
- Production build completed.
- npm audit completed with zero vulnerabilities.
- Local dev server started.

## Local Verification Commands

```bash
npm install
npm run lint
npm run build
npm run dev
```

## Latest Local Test Result

Date: 2026-04-21

```text
npm install: PASS
npm run lint: PASS
npm run test: PASS, 6 files / 19 tests
npm run build: PASS
npm audit --audit-level=moderate: PASS, 0 vulnerabilities
HTTP check http://localhost:3000: PASS, 200
Trading212 local bridge health: PASS
Trading212 demo snapshot: PASS, GBP account, 20 positions, 2 open orders
Supabase schema apply: PASS, 7 expected public tables verified
Supabase functions deploy: PASS, 5 active functions verified
Supabase Trading212 function invoke: PASS, GBP account, 20 positions, 2 open orders
Trading212 snapshot requests are sequential to respect demo rate limits.
Playwright visual check: BLOCKED by local MCP profile permission issue
```

## Migrated Logic Covered By Automated Tests

- US/Eastern session windows: pre-market, warming, regular, post-market.
- Session engine allowances and order type rules.
- Market regime classification from SPY / EMA200 / VIX.
- E1-E5 scanner state classification rules.
- E4-alone rule: E4 does not confirm by itself.
- Entry drift / chasing prevention.
- Group classification: GOLD, BLUE, TREND, FVG.
- Best-signal priority by group.
- Exposure and sector concentration limits.
- Beta-adjusted order sizing.
- Order lifecycle close detection.
- Candle-based FVG detection.
- Candle-based E1/E2 order-block engine shape.
- Candle-based E3 MSS engine shape.
- Candle-based E5 FVG engine shape.
- Full E1-E5 scan result shape.

## Not Yet Covered

- Live OHLCV data-provider network integration.
- Full E1-E5 Python-vs-TypeScript parity against recorded historical market data.
- Real Supabase deployment.
- Supabase-hosted broker API deployment.
- Supabase broker credential secrets.

## Supabase Deployment Status

Completed:

- Database schema was applied directly to the remote Supabase Postgres database.
- Edge Functions were deployed to the remote Supabase project.
- Trading212 demo secrets were set in Supabase.
- Deployed Trading212 function was invoked successfully.
- Sutra local app is configured to use the Supabase function path, not the local bridge.
- Verified tables:
  - `app_orders`
  - `broker_connections`
  - `broker_positions`
  - `performance_events`
  - `scan_runs`
  - `scanner_signals`
  - `user_settings`

Verified functions:

- `broker-trading212`
- `broker-capital`
- `broker-ig`
- `broker-ibkr`
- `scanner-run`

## Functional Tests To Run

1. App opens on the local dev URL.
2. Sidebar navigation changes screens.
3. Live Scanner table renders mock signals.
4. Selecting a scanner row updates the detail panel.
5. Orders table shows open and closed lifecycle fields.
6. Positions table shows broker positions separately from app orders.
7. Performance screen renders all cards and tables.
8. Settings screen shows broker connection area.
9. Layout remains usable at desktop and narrow widths.

## Future Parity Tests

For scanner migration, each test should compare Python output and TypeScript output for the same ticker/universe input:

- signal status
- direction
- group
- engines
- entry
- stop loss
- target
- risk state
- order eligibility
