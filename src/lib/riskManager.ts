const RISK_KEY = 'sutra.riskManager.v1';
const SETTINGS_KEY = 'sutra.riskSettings.v1';
const CB_PAUSE_MS = 2 * 60 * 60 * 1000;

// ── User-configurable risk settings ──────────────────────────────────────────

export interface RiskSettings {
  riskPerTradePct: number;       // 0.01–0.05 (1–5% of account per trade)
  dailyLossLimitPct: number;     // 0.05–0.15 (5–15% daily hard stop)
  maxPositions: number;          // 1–10 concurrent positions
  cbLossThreshold: number;       // consecutive losses before 2hr pause
  disabledStrategies: string[];  // strategy IDs to skip entirely
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskPerTradePct: 0.02,
  dailyLossLimitPct: 0.08,
  maxPositions: 5,
  cbLossThreshold: 3,
  disabledStrategies: [],
};

export function getRiskSettings(): RiskSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<RiskSettings>;
    return { ...DEFAULT_RISK_SETTINGS, ...raw };
  } catch { return { ...DEFAULT_RISK_SETTINGS }; }
}

export function saveRiskSettings(s: RiskSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Legacy exports kept for existing callers
export const MAX_POSITIONS = DEFAULT_RISK_SETTINGS.maxPositions;
export const RISK_PER_TRADE_PCT = DEFAULT_RISK_SETTINGS.riskPerTradePct;

interface CbState { count: number; pauseUntil: number; }
interface RiskState {
  dailyDate: string;
  dailyStartBalance: number;
  dailyRealizedPnl: number;
  strategyCb: Record<string, CbState>;
}

function toETDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function load(): RiskState {
  try {
    const raw = JSON.parse(localStorage.getItem(RISK_KEY) || '{}') as Partial<RiskState>;
    return {
      dailyDate: raw.dailyDate || '',
      dailyStartBalance: raw.dailyStartBalance || 0,
      dailyRealizedPnl: raw.dailyRealizedPnl || 0,
      strategyCb: raw.strategyCb || {},
    };
  } catch {
    return { dailyDate: '', dailyStartBalance: 0, dailyRealizedPnl: 0, strategyCb: {} };
  }
}

function save(state: RiskState): void {
  localStorage.setItem(RISK_KEY, JSON.stringify(state));
}

export function initDailyBalance(accountBalance: number): void {
  const state = load();
  const today = toETDate();
  if (state.dailyDate !== today) {
    save({ ...state, dailyDate: today, dailyStartBalance: accountBalance, dailyRealizedPnl: 0 });
  } else if (state.dailyStartBalance <= 0) {
    save({ ...state, dailyStartBalance: accountBalance });
  }
}

// qty = (account × riskPerTradePct) / |entry - stop|
export function computePositionSize(accountBalance: number, entry: number, stop: number): number {
  const { riskPerTradePct } = getRiskSettings();
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0 || entry <= 0) return 1;
  return Math.max(1, Math.floor((accountBalance * riskPerTradePct) / stopDist));
}

export function checkDailyLossLimit(accountBalance: number): { ok: boolean; reason?: string } {
  const { dailyLossLimitPct } = getRiskSettings();
  const state = load();
  const startBal = state.dailyStartBalance || accountBalance;
  const limit = startBal * dailyLossLimitPct;
  if (state.dailyRealizedPnl < 0 && Math.abs(state.dailyRealizedPnl) >= limit) {
    return {
      ok: false,
      reason: `Daily loss limit hit: -$${Math.abs(state.dailyRealizedPnl).toFixed(0)} of $${limit.toFixed(0)} (${(dailyLossLimitPct * 100).toFixed(0)}%) — no new trades today`,
    };
  }
  return { ok: true };
}

export function checkStrategyCircuitBreaker(strategy: string): { ok: boolean; reason?: string } {
  const { cbLossThreshold } = getRiskSettings();
  const state = load();
  const cb = state.strategyCb[strategy];
  if (cb && cb.pauseUntil > Date.now()) {
    const mins = Math.ceil((cb.pauseUntil - Date.now()) / 60000);
    return { ok: false, reason: `${strategy}: circuit breaker active — ${mins}m remaining (${cbLossThreshold} consecutive losses)` };
  }
  return { ok: true };
}

export function checkMaxPositions(openTrades: { status: string }[]): { ok: boolean; reason?: string } {
  const { maxPositions } = getRiskSettings();
  const count = openTrades.filter((t) => t.status === 'Open').length;
  if (count >= maxPositions) {
    return { ok: false, reason: `Max ${maxPositions} concurrent positions reached (${count} open)` };
  }
  return { ok: true };
}

export function recordTradeResult(strategy: string, pnl: number, accountBalance: number): void {
  const state = load();
  const today = toETDate();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyStartBalance = accountBalance;
    state.dailyRealizedPnl = 0;
  }
  state.dailyRealizedPnl += pnl;

  const { cbLossThreshold } = getRiskSettings();
  if (!state.strategyCb[strategy]) state.strategyCb[strategy] = { count: 0, pauseUntil: 0 };
  const cb = state.strategyCb[strategy];
  if (pnl < 0) {
    cb.count++;
    if (cb.count >= cbLossThreshold) {
      cb.pauseUntil = Date.now() + CB_PAUSE_MS;
      cb.count = 0;
    }
  } else {
    cb.count = 0;
  }
  save(state);
}

export function getRiskSummary() {
  const state = load();
  const startBal = state.dailyStartBalance || 0;
  return {
    dailyPnl: state.dailyRealizedPnl,
    dailyLossLimit: startBal * getRiskSettings().dailyLossLimitPct,
    openCbStrategies: Object.entries(state.strategyCb)
      .filter(([, cb]) => cb.pauseUntil > Date.now())
      .map(([name]) => name),
  };
}

export function getDailyStartBalance(): number {
  return load().dailyStartBalance || 0;
}

export function getPausedStrategies(): Array<{ name: string; minsLeft: number }> {
  const state = load();
  return Object.entries(state.strategyCb)
    .filter(([, cb]) => cb.pauseUntil > Date.now())
    .map(([name, cb]) => ({ name, minsLeft: Math.ceil((cb.pauseUntil - Date.now()) / 60_000) }));
}
