# Architecture

## Goal

Keep the app light while preserving the current Live Scanner trading logic.

## Deployment Model

- Netlify hosts the React frontend.
- Supabase handles auth, database, realtime state, secrets, and protected broker operations.
- Browser code never stores broker secrets directly in production.

## Main Layers

```text
src/components
  Visual UI copied from the AI Studio design.

src/features/scanner
  Scanner state, types, and the future TypeScript port of the Python scanner logic.

src/features/orders
  App-triggered order lifecycle logic.

src/features/brokers
  Broker adapter interface and broker-specific implementations.

src/lib
  Supabase client, formatting, environment helpers.

supabase
  SQL schema and future Edge Function source.
```

## Broker Adapter Rule

Every broker must implement the same contract:

```text
connect
getPositions
getOpenOrders
placeOrder
```

This prevents Trading212, Capital.com, IG Share Dealing, and IBKR logic from leaking into the scanner UI.

## Scanner Migration Rule

The scanner logic is not redesigned first. It is extracted, ported, and tested against the Python output before simplification.
