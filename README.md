# Sutra Trading Terminal

Sutra is the new lightweight React/TypeScript version of the Live Scanner workflow from the existing Streamlit stock analyzer.

Current build status:

- AI Studio frontend design imported and preserved.
- App renamed to Sutra.
- Vite + React + TypeScript project stabilized.
- Tailwind locked to 3.4.
- Supabase client configuration added.
- Broker adapter structure added for Trading212, Capital.com, IG Share Dealing, and IBKR.
- Database schema draft added in `supabase/schema.sql`.
- UI currently runs with mock data while scanner parity work is completed.

## Local Setup

```bash
npm install
npm run dev
```

The dev server defaults to:

```text
http://localhost:3000
```

## Environment

Copy `.env.example` to `.env.local` and fill:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_APP_NAME
```

The local `.env.local` is intentionally ignored by git.

## Source Of Truth

The existing Python app remains the source of truth for trading behavior until parity tests prove the TypeScript implementation matches it.

Important Python files:

- `pages/3_Live_Scanner.py`
- `analyzer/engines.py`
- `analyzer/execution_risk.py`
- broker modules under `analyzer/`
