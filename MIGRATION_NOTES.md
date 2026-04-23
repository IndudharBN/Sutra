# Migration Notes

## Current Python Logic To Preserve

The following areas must remain behaviorally equivalent:

- Watchlist/universe selection.
- Ticker lock handling.
- E1, E2, E3, E4, E5 engine behavior.
- Forming and confirmed signal classification.
- Entry, stop loss, target, distance, R:R, and signal age calculations.
- Risk sizing and kill-switch behavior.
- Broker connection and order placement gates.
- Position reconciliation.
- Open/closed order lifecycle.
- Realized and unrealized P&L.

## Known Simplification Targets

These can be simplified only after parity tests are available:

- Split the current large Live Scanner page into scanner, broker, order, and performance modules.
- Remove repeated forming-detail calculations.
- Centralize broker credential/connection state.
- Normalize scanner table rows into one typed object.
- Keep manual broker positions separate from app-triggered orders.

## First Migration Phase

The first phase is UI plus data model parity:

1. Keep mock data visible.
2. Add Supabase tables.
3. Add broker adapter contracts.
4. Port scanner logic in small pieces.
5. Compare Python output to TypeScript output for the same ticker inputs.

## Current Migration Status

Completed:

- Session logic has been ported.
- Market regime classification has been ported.
- OHLCV data-provider scaffold has been added.
- Indicator helpers have been ported: EMA, RSI, MACD histogram, ATR, VWAP, volume ratio.
- FVG detection has been ported.
- Order-block and rejection-candle helpers have been ported.
- HTF context has been ported into a candle-based TypeScript module.
- E1-E5 candle-based engine internals have been ported into TypeScript.
- Scanner state classification has been ported.
- Group classification has been ported.
- Best signal selection has been ported.
- Exposure limits have been ported.
- Sector concentration checks have been ported.
- Beta-adjusted sizing has been ported.
- Order lifecycle close marking has been ported.
- Supabase schema has been expanded for scan runs, signals, orders, positions, and performance events.
- Supabase Edge Function scaffolds exist for scanner-run and all requested broker families.
- Trading212 read-only local bridge is implemented for immediate demo testing.
- Trading212 demo account snapshot is verified locally.
- Sutra frontend is wired to live Trading212 demo positions and open orders through the local bridge.
- Supabase database schema has been applied to the remote project and verified.
- Supabase Edge Functions have been deployed.
- Trading212 secrets have been set in Supabase.
- The deployed Trading212 function returns live demo account, positions, and open orders.
- Trading212 snapshot requests are sequential to avoid demo API rate-limit bursts.

Remaining:

- Add Python-versus-TypeScript parity fixtures.
- Harden live Yahoo data fetching inside Supabase Edge Functions.
- Add more real historical ticker fixtures for edge cases.
- Add demo order placement flow after read-only testing is accepted.
