import { describe, it, expect } from 'vitest';
import { fetchBars } from '../lib/alpacaClient';
import { 
  evaluateVwapPullback, 
  evaluateRsContinuation, 
  evaluateLiquiditySweep, 
  evaluateMssBreakout, 
  checkS7VolumeSurge 
} from '../features/protrade/strategyEngine';
import { vwap } from '../features/protrade/indicators';

describe('Strategy Audit: Looser Thresholds Cross-Check', () => {
  it('should generate signals on high-volume tickers (NVDA)', async () => {
    const symbol = 'NVDA';
    const bars5m = await fetchBars(symbol, '5Min', 400); // ~5 days of data
    
    console.log(`\n>>> Auditing ${symbol} (${bars5m.length} bars)`);
    
    let totals = { S2: 0, S3: 0, S4: 0, S6: 0, S7: 0 };

    for (let i = 50; i < bars5m.length; i++) {
      const window = bars5m.slice(0, i + 1);
      const lastBar = window[window.length - 1];
      const vwapVal = vwap(window);
      
      const input: any = {
        symbol,
        price: lastBar.close,
        vwap: vwapVal,
        vwapAligned: lastBar.close > vwapVal,
        trend5m: 'BULL',
        trendAligned: true,
        atr20: 2.5,
        rvol: 1.3,
        rsVsBenchmark: 1.005,
        direction: 'BULL',
        candles: { five: window.slice(-20) },
        dataStatus: { mode: 'live', stale: false }
      };

      if (evaluateVwapPullback(input).stage === 'trade_ready') totals.S2++;
      if (evaluateRsContinuation(input).stage === 'trade_ready') totals.S3++;
      if (evaluateLiquiditySweep(input).stage === 'trade_ready') totals.S4++;
      if (evaluateMssBreakout(input).stage === 'trade_ready') totals.S6++;
      const s7 = checkS7VolumeSurge(input, { avgVolume5m: 50000 });
      if (s7 && s7.stage === 'trade_ready') totals.S7++;
    }

    console.table(totals);
    expect(Object.values(totals).some(count => count > 0)).toBe(true);
  });
});
