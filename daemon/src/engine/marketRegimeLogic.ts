import type { MarketRegime, MarketRegimeName } from './marketRegimeTypes';

// Size multiplier by regime. BEAR downsizes to 0.5× to protect capital when SPY
// is below its 200 EMA or VIX > 30 — chop/downtrend days are where oversized
// losers (2-4× winners) do the damage (see 2026-07-28). Was mistakenly 1.0×,
// which left the governor toothless in exactly the conditions it exists for.
export const REGIME_MULT: Record<MarketRegimeName, number> = {
  BULL: 1.0,
  SIDEWAYS: 0.75,
  BEAR: 0.5,
};

export const REGIME_COLOR: Record<MarketRegimeName, string> = {
  BULL: '#26a69a',
  SIDEWAYS: '#ff9800',
  BEAR: '#ef5350',
};

export const REGIME_ICON: Record<MarketRegimeName, string> = {
  BULL: '*',
  SIDEWAYS: '~',
  BEAR: '!',
};

export function classifyMarketRegime(input: { spyPrice?: number | null; spyEma200?: number | null; vixLevel?: number | null; ts?: number }): MarketRegime {
  const spyPrice = input.spyPrice ?? null;
  const spyEma200 = input.spyEma200 ?? null;
  const vixLevel = input.vixLevel ?? null;
  const spyAboveEma = spyPrice !== null && spyEma200 !== null ? spyPrice > spyEma200 : null;

  let regime: MarketRegimeName = 'SIDEWAYS';
  if (spyAboveEma === true && vixLevel !== null && vixLevel < 20) regime = 'BULL';
  else if (spyAboveEma === false || (vixLevel !== null && vixLevel > 30)) regime = 'BEAR';

  return {
    regime,
    spyPrice,
    spyEma200,
    spyAboveEma,
    vixLevel,
    sizeMult: REGIME_MULT[regime],
    color: REGIME_COLOR[regime],
    icon: REGIME_ICON[regime],
    error: null,
    ts: input.ts ?? Date.now(),
  };
}
