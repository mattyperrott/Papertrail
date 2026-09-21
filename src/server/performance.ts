import type { PaperAccount } from '../shared/types.js';

/** 24/7 markets. Ratios use completed, adjacent UTC day closes; never polling intervals. */
export function calculatePerformance(account: PaperAccount, now = Date.now()) {
  const equity = account.cash + account.positions.reduce((sum, p) => sum + p.currentValue, 0);
  // Daily closes carry the long history; the intraday ring adds recent detail and
  // is bounded. Merging is safe because points are bucketed to one close per day
  // below, so an intraday sample can only refine the day it belongs to.
  const points = [...(account.dailyCloses ?? []), ...account.equityHistory, { timestamp: new Date(now).toISOString(), equity }]
    .filter((p) => Number.isFinite(p.equity) && p.equity >= 0 && Number.isFinite(Date.parse(p.timestamp)) && Date.parse(p.timestamp) <= now)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let peak = account.startingBalance;
  let maxDrawdownPct = 0;
  const closes = new Map<number, number>();
  const today = Math.floor(now / 86_400_000);
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? 100 * (peak - point.equity) / peak : 0);
    const day = Math.floor(Date.parse(point.timestamp) / 86_400_000);
    if (day < today) closes.set(day, point.equity);
  }
  const returns: number[] = [];
  for (const [day, value] of closes) {
    const previous = closes.get(day - 1);
    if (previous !== undefined && previous > 0) returns.push(value / previous - 1);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
  // Target return and risk-free rate are explicitly zero; missing history is not zero volatility.
  // The n-1 divisor matches the Sharpe denominator above. Textbook Sortino divides
  // by n, which would make the two ratios differ by sqrt((n-1)/n) purely from the
  // estimator and inflate Sortino against the Sharpe shown beside it.
  const downsideVariance = returns.length > 1
    ? returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / (returns.length - 1) : 0;
  const cyclePnl=(account.completedCycles??[]).filter(cycle=>cycle.complete).map(cycle=>cycle.pnl);
  const realized = cyclePnl.length?cyclePnl:account.trades.filter((t) => t.status === 'filled' && (t.side === 'SELL' || t.side === 'SETTLE')).map(trade=>trade.realizedPnl);
  const grossProfit = realized.reduce((s, pnl) => s + Math.max(0, pnl), 0);
  const grossLoss = realized.reduce((s, pnl) => s + Math.max(0, -pnl), 0);
  const highWater = Math.max(peak, account.highWaterEquity ?? peak);
  return {
    // Never below what was actually observed; see recordEquityPoint.
    maxDrawdownPct: Math.max(maxDrawdownPct, account.maxDrawdownPctObserved ?? 0),
    currentDrawdownPct: highWater > 0 ? Math.max(0, 100 * (highWater - equity) / highWater) : 0,
    dailySharpe: returns.length >= 30 && variance > 1e-20 ? Math.sqrt(365) * mean / Math.sqrt(variance) : null,
    dailySortino: returns.length >= 30 && downsideVariance > 1e-20 ? Math.sqrt(365) * mean / Math.sqrt(downsideVariance) : null,
    dailyObservations: returns.length,
    feesPaid: account.feesPaidTotal??account.trades.reduce((s, t) => s + (t.fees ?? 0), 0),
    realizedProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}

export function validationGates(account: PaperAccount) {
  const metrics = calculatePerformance(account);
  const independentEvents=new Set((account.completedCycles??[]).filter(cycle=>cycle.complete).map(cycle=>cycle.eventKey??cycle.id)).size;
  const reconciliation=account.reconciliations?.[0];
  return {
    mode: 'paper' as const,
    liveEnabled: false,
    eligibleForLive: false,
    gates: [
      { name: 'Live execution intentionally absent', passed: false },
      { name: 'Version 3 forward-only account', passed: account.methodologyVersion === 3 },
      { name: 'At least 90 complete daily returns', passed: metrics.dailyObservations >= 90 },
      { name: 'At least 200 independent completed event clusters', passed: independentEvents >= 200 },
      { name: 'Base maximum drawdown no greater than 7.5%', passed: metrics.maxDrawdownPct <= 7.5 },
      { name: 'No latched risk halt', passed: !account.riskHalt },
      { name: 'No accounting or reconciliation discrepancy', passed: Boolean(reconciliation?.passed) && !account.reconciliationRequired },
      { name: 'Multiple-testing-adjusted challenger superiority over champion', passed: false },
      { name: 'Stress, backup, restore, crash, watchdog and alert drills certified', passed: false },
      { name: 'Explicit human live authorization', passed: false },
    ],
    metrics,
  };
}
