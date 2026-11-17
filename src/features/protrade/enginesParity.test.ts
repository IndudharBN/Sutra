import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// The daemon bundles its own copy of the engine (separate package, can't import ../src).
// The backtest runs the UI copy. If they drift, the backtest stops measuring what trades live —
// which is exactly how the backtest once reported 30% WR against a live 45%.
// Only import specifiers may differ.
const norm = (rel: string) =>
  readFileSync(resolve(__dirname, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import .*$/gm, '');

describe('daemon/UI engine parity', () => {
  it('strategyEngine.ts is identical apart from imports', () => {
    expect(norm('../../../daemon/src/engine/strategyEngine.ts')).toBe(norm('./strategyEngine.ts'));
  });
  it('deadTrade.ts is identical apart from imports', () => {
    expect(norm('../../../daemon/src/engine/deadTrade.ts')).toBe(norm('./deadTrade.ts'));
  });
  it('entryGate.ts is identical apart from imports', () => {
    expect(norm('../../../daemon/src/engine/entryGate.ts')).toBe(norm('./entryGate.ts'));
  });
});
