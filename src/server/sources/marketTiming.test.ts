import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePositionTiming, deriveTitleTiming } from './marketTiming.js';

test('derives the latest date from a multi-leg market title', () => {
  const timing = deriveTitleTiming(
    'Will Team A win on 2026-09-08? AND Will Team B win on 2026-09-09?',
    Date.parse('2026-09-08T12:00:00Z'),
  );
  assert.equal(timing.expectedEndAt, '2026-09-09T23:59:59.000Z');
  assert.equal(timing.resolutionStatus, 'scheduled');
  assert.equal(timing.timingSource, 'title-estimate');
});

test('marks title-derived dates in the past as awaiting a result', () => {
  const timing = deriveTitleTiming('Match scheduled for 2026-09-02', Date.parse('2026-09-09T00:00:00Z'));
  assert.equal(timing.resolutionStatus, 'awaiting-result');
});

test('uses a clearly labelled 24-hour activity estimate for undated sports combos', () => {
  const timing = derivePositionTiming(
    { title: 'Real Madrid vs. Inter: Both Teams to Score', openedAt: '2026-09-08T18:00:00Z' },
    Date.parse('2026-09-09T00:00:00Z'),
  );
  assert.equal(timing.expectedEndAt, '2026-09-09T18:00:00.000Z');
  assert.equal(timing.timingSource, 'activity-estimate');
  assert.equal(timing.resolutionStatus, 'scheduled');
});

test('closed market and extreme tradable prices never manufacture settlement', async () => {
  const { timingFromMarket } = await import('./marketTiming.js');
  const market = { closed: true, clobTokenIds: '["a","b"]', outcomePrices: '["0.995","0.005"]' };
  assert.notEqual(timingFromMarket(market, {}, 'a', Date.now()).resolutionStatus, 'resolved');
  assert.equal(timingFromMarket({...market, umaResolutionStatus: 'resolved'}, {}, 'a', Date.now()).result, 'unknown');
  assert.equal(timingFromMarket({...market, umaResolutionStatus: 'resolved', outcomePrices: '["1","0"]'}, {}, 'a', Date.now()).result, 'won');
});

test('an equal-split resolution is a void refund, not an unknown that never settles', async () => {
  const { timingFromMarket, resultForAsset, resolvedPriceForAsset } = await import('./marketTiming.js');
  // Live case, 2026-09-16: a retired WTA match resolved every market ["0.5","0.5"].
  const voided = { closed: true, umaResolutionStatus: 'resolved', clobTokenIds: '["a","b"]', outcomePrices: '["0.5","0.5"]' };
  const timing = timingFromMarket(voided, {}, 'b', Date.now());
  assert.equal(timing.resolutionStatus, 'resolved');
  assert.equal(timing.result, 'void');
  assert.equal(timing.resolvedPrice, 0.5);
  // A three-way market refunded at thirds is the same shape.
  assert.equal(resultForAsset({ clobTokenIds: '["a","b","c"]', outcomePrices: '["0.3333333333","0.3333333333","0.3333333334"]' }, 'c'), 'void');
  // Unequal partial prices are still tradable prices: no settlement.
  assert.equal(resultForAsset({ clobTokenIds: '["a","b"]', outcomePrices: '["0.995","0.005"]' }, 'a'), 'unknown');
  assert.equal(resolvedPriceForAsset({ clobTokenIds: '["a","b"]', outcomePrices: '["0.6","0.4"]' }, 'a'), undefined);
});
