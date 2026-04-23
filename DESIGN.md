# Design Notes

The visual design comes from the AI Studio export `nexus-trading-terminal.zip`.

## Preserved Design Choices

- Dark terminal-style interface.
- Left navigation.
- Top broker/scanner status bar.
- Dense scanner table.
- Right-side signal detail panel.
- Separate screens for scanner, orders, positions, performance, and settings.
- Status colors:
  - Green: confirmed/profit/healthy
  - Amber: forming/waiting
  - Red: loss/risk/failure
  - Indigo: selected/connected/open
  - Slate: inactive/cold

## App Screens

- Live Scanner
- Orders Lifecycle
- Broker Positions
- Performance Analytics
- System Settings

## Design Adjustments Already Made

- Branding changed to Sutra.
- AI Studio-specific Gemini/Cloud Run configuration removed.
- Tailwind converted to 3.4-compatible setup.
- Export text encoding issues cleaned where visible.
