import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperAccount, recordEquityPoint } from './paperEngine.js';
import { calculatePerformance, validationGates } from './performance.js';

test('daily closes make ratios and the 90-day gate reachable at realistic sampling rates',()=>{
  const account=createPaperAccount(100);const start=Date.UTC(2025,0,1);let equity=100;
  // 96 samples a day is the cadence a five-minute-ish verification loop produces.
  for(let d=0;d<120;d++) {
    equity*=1+(d%2?.01:-.004);
    for(let s=0;s<96;s++) {account.cash=equity;recordEquityPoint(account,start+d*86_400_000+s*900_000);}
  }
  const now=start+120*86_400_000;
  const metrics=calculatePerformance(account,now);
  assert.ok(metrics.dailyObservations>=110,`expected daily returns to accumulate, got ${metrics.dailyObservations}`);
  assert.notEqual(metrics.dailySharpe,null);
  assert.equal(validationGates(account).gates.find(g=>g.name.includes('90 complete daily returns'))?.passed,true);
  // The bounded intraday ring alone spans days, not months: it cannot support these.
  const intradayOnly={...account,dailyCloses:undefined};
  assert.ok(calculatePerformance(intradayOnly,now).dailyObservations<10);
  assert.equal(calculatePerformance(intradayOnly,now).dailySharpe,null);
});

test('peak-to-trough drawdown includes current equity and ratios stay unavailable on short samples', () => {
  const account = createPaperAccount(100);
  account.equityHistory = [100, 120, 90, 110].map((equity, i) => ({ timestamp: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), equity, cash: equity, exposure: 0 }));
  account.cash = 110;
  const m = calculatePerformance(account, Date.UTC(2025, 0, 5));
  assert.equal(m.maxDrawdownPct, 25);
  assert.equal(m.dailyObservations, 3);
  assert.equal(m.dailySharpe, null);
  assert.equal(m.realizedProfitFactor, null);
  assert.equal(validationGates(account).liveEnabled, false);
});

test('duplicating intraday samples does not inflate annualized Sharpe and gaps are excluded', () => {
  const account = createPaperAccount(100);
  let equity = 100;
  account.equityHistory = Array.from({length: 40}, (_, i) => {
    equity *= 1 + (i % 2 ? .01 : -.004);
    return { timestamp: new Date(Date.UTC(2025, 0, i + 1, 23)).toISOString(), equity, cash: equity, exposure: 0 };
  });
  account.cash = equity;
  const now = Date.UTC(2025, 1, 11);
  const baseline = calculatePerformance(account, now);
  assert.ok(baseline.dailySharpe! > 0);
  account.equityHistory = account.equityHistory.flatMap(p => [p, {...p}]);
  assert.equal(calculatePerformance(account, now).dailySharpe, baseline.dailySharpe);
  account.equityHistory = account.equityHistory.filter(p => !p.timestamp.startsWith('2025-01-10'));
  assert.equal(calculatePerformance(account, now).dailyObservations, 37);
});
