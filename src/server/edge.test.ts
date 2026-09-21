import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateEdge, impliedProbability, kellyFraction, sizingFactor, tQuantile95, type ResolvedTrade } from './edge.js';

const trades = (count: number, price: number, wins: number, eventKey?: (i: number) => string): ResolvedTrade[] =>
  Array.from({ length: count }, (_, i) => ({ price, outcome: (i < wins ? 1 : 0) as 0 | 1, eventKey: eventKey?.(i) }));
const distributed = (count:number,price:number,wins:number):ResolvedTrade[] => Array.from({length:count},(_,i)=>({price,outcome:((i*37)%count<wins?1:0) as 0|1,eventKey:`event-${i}`,occurredAt:Date.UTC(2026,0,i+1)}));

test('a high win rate at short odds is scored as the negative expectancy it is', () => {
  // 80 of 100 correct, but every entry paid 0.90: -0.10 per share on average.
  const favourites = estimateEdge(trades(100, 0.9, 80));
  assert.ok(favourites.meanEdge < 0, `expected negative edge, got ${favourites.meanEdge}`);
  assert.equal(favourites.score, 0);

  // 40 of 100 correct at 0.30: right far less often, but +0.10 per share.
  const longshots = estimateEdge(distributed(100, 0.3, 40),{now:Date.UTC(2026,4,1)});
  assert.ok(longshots.meanEdge > 0);
  assert.ok(longshots.score > 0);
  // The ranking the previous win-rate objective got backwards.
  assert.ok(longshots.score > favourites.score);
});

test('a fair-priced record shows no edge and earns no score', () => {
  const fair = estimateEdge(trades(200, 0.5, 100));
  assert.ok(Math.abs(fair.meanEdge) < 1e-12);
  assert.ok(fair.edgeLowerBound! < 0, 'a zero-mean sample must not clear the bound');
  assert.equal(fair.score, 0);
});

test('correlated legs count once, so one event cannot manufacture significance', () => {
  // Same 120 winning legs: as 120 independent bets, then as 10 events of 12 legs.
  const independent = estimateEdge(trades(120, 0.3, 48));
  const clustered = estimateEdge(trades(120, 0.3, 48, (i) => `event-${Math.floor(i / 12)}`));
  assert.equal(independent.independentGroups, 120);
  assert.equal(clustered.independentGroups, 10);
  assert.ok(Math.abs(clustered.meanEdge - independent.meanEdge) < 1e-12, 'the point estimate is unchanged');
  assert.ok(clustered.edgeLowerBound! < independent.edgeLowerBound!, 'the bound must widen once correlation is admitted');
});

test('an unanimous short run cannot out-rank a long record', () => {
  assert.equal(estimateEdge(trades(1, 0.2, 1)).score, 0);
  // Both samples are 100% winners at 0.20. Zero sample variance must not hand the
  // three-trade streak a tighter bound than the sixty-trade record.
  const streak = estimateEdge(trades(3, 0.2, 3));
  const record = estimateEdge(trades(60, 0.2, 60));
  assert.ok(streak.edgeLowerBound! < record.edgeLowerBound!, `${streak.edgeLowerBound} should be below ${record.edgeLowerBound}`);
  assert.equal(streak.score, 0, 'below the independent-observation minimum');
  assert.ok(record.score > 0);
});

test('malformed trades are excluded rather than defaulted', () => {
  const estimate = estimateEdge([
    { price: 0.5, outcome: 1 }, { price: 0, outcome: 1 }, { price: 1, outcome: 0 },
    { price: Number.NaN, outcome: 1 }, { price: 0.5, outcome: 2 as unknown as 0 },
  ]);
  assert.equal(estimate.trades, 1);
});

test('t quantiles match published one-sided 95% values and converge to the normal', () => {
  assert.equal(tQuantile95(1), 6.314);
  assert.equal(tQuantile95(10), 1.812);
  assert.ok(Math.abs(tQuantile95(1000) - 1.6449) < 0.002);
  assert.ok(tQuantile95(30) > tQuantile95(120));
});

test('Kelly refuses a non-positive edge and is capped', () => {
  assert.ok(Math.abs(kellyFraction(0.6, 0.5) - 0.2) < 1e-12);
  assert.equal(kellyFraction(0.4, 0.5), 0);
  assert.equal(kellyFraction(0.6, 0), 0);
  assert.equal(kellyFraction(0.6, 1), 0);
  // Challenger sizing is one-tenth Kelly; the cap still trims it.
  assert.equal(sizingFactor(1, 0.5), 0.1);
  assert.equal(sizingFactor(1, 0.5, 0.25, 0.1), 0.1, 'the cap binds');
});

test('short odds amplify estimation error, which is why they are capped elsewhere', () => {
  // For a fixed absolute edge, Kelly RISES as price approaches 1: five points at
  // 0.95 is a far larger relative mispricing than five points at 0.50.
  const sizes = [0.5, 0.7, 0.9, 0.95].map((price) => sizingFactor(price + 0.05, price));
  for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i] > sizes[i - 1], `Kelly rises with price: ${sizes}`);
  // The same denominator amplifies a misestimate of q, so the swing from a
  // two-point error is far larger at short odds. That sensitivity, not Kelly, is
  // what maxEntryPrice exists to bound.
  const swing = (price: number) => sizingFactor(price + 0.07, price) - sizingFactor(price + 0.03, price);
  assert.ok(swing(0.95) > swing(0.5) * 5, `error sensitivity must blow up at short odds: ${swing(0.95)} vs ${swing(0.5)}`);
});

test('implied probability stays a probability', () => {
  assert.ok(Math.abs(impliedProbability(0.5, 0.1) - 0.6) < 1e-12);
  assert.equal(impliedProbability(0.95, 0.4), 1);
  assert.equal(impliedProbability(0.05, -0.4), 0);
});

test('an estimate never carries a non-finite number into persisted state', () => {
  // The whole dashboard state is walked by an integrity check that rejects any
  // non-finite number, so an unbounded estimate would block every save.
  for (const sample of [[], trades(1, 0.5, 1), trades(2, 0.5, 2), trades(40, 0.5, 20)]) {
    const estimate = estimateEdge(sample);
    for (const [key, value] of Object.entries(estimate)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must be finite, got ${value}`);
    }
    assert.ok(estimate.edgeLowerBound === null || Number.isFinite(estimate.edgeLowerBound));
    assert.ok(JSON.stringify(estimate).indexOf('null') === -1 || estimate.edgeLowerBound === null);
  }
});
