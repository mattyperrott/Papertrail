import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceTrade } from '../../shared/types.js';
import { estimateEdge } from '../edge.js';
import { netAssetLots, reconstructTraderHistory, type MarketResolutionCache } from './traderHistory.js';

const trade = (over: Partial<SourceTrade>): SourceTrade => ({
  id: Math.random().toString(36), traderAddress: '0x1', traderName: 'T', timestamp: 1_700_000_000,
  side: 'BUY', asset: 'a', conditionId: 'c', title: 'M', outcome: 'Yes', price: 0.5, shares: 100,
  notional: 50, provider: 'polymarket', ...over,
});

/** Stands in for the gamma lookup. The held asset must appear in clobTokenIds at
 * the index its payout occupies in outcomePrices, exactly as gamma reports it. */
type Settled = { asset: string; result: 'won' | 'lost' };
const stubResolutions = (byCondition: Record<string, Settled | 'pending'>): MarketResolutionCache => ({
  fetched: 0, served: 0,
  async market(conditionId: string, _eventSlug?: string) {
    const state = byCondition[conditionId];
    if (!state || state === 'pending') return null;
    return {
      conditionId, umaResolutionStatus: 'resolved',
      clobTokenIds: JSON.stringify([state.asset, `${state.asset}-other`]),
      outcomePrices: JSON.stringify(state.result === 'won' ? ['1', '0'] : ['0', '1']),
    };
  },
} as unknown as MarketResolutionCache);

test('entry is the volume-weighted average of buys, not the last fill', () => {
  const lots = netAssetLots([
    trade({ side: 'BUY', price: 0.3, shares: 100 }),
    trade({ side: 'BUY', price: 0.55, shares: 100 }),
  ]);
  assert.equal(lots.length, 1);
  assert.ok(Math.abs(lots[0].buyCost / lots[0].buyShares - 0.425) < 1e-12);
});

test('positions exited before resolution carry no binary outcome', async () => {
  const history = await reconstructTraderHistory([
    // Held to resolution.
    trade({ asset: 'a', conditionId: 'held', price: 0.4, shares: 100 }),
    // Fully sold out before the market settled.
    trade({ asset: 'b', conditionId: 'exited', price: 0.4, shares: 100 }),
    trade({ asset: 'b', conditionId: 'exited', side: 'SELL', price: 0.6, shares: 100 }),
  ], stubResolutions({ held: { asset: 'a', result: 'won' }, exited: { asset: 'b', result: 'won' } }), '0x1');
  assert.equal(history.assetsHeldToResolution, 1);
  assert.equal(history.assetsExitedBeforeResolution, 1);
  assert.equal(history.resolvedTrades.length, 1);
  assert.equal(history.resolvedTrades[0].outcome, 1);
  assert.ok(Math.abs(history.resolvedTrades[0].price - 0.4) < 1e-12);
});

test('pending or unreadable markets are counted, not guessed', async () => {
  const history = await reconstructTraderHistory(
    [trade({ asset: 'a', conditionId: 'open', price: 0.4 })],
    stubResolutions({ open: 'pending' }), '0x1',
  );
  assert.equal(history.resolvedTrades.length, 0);
  assert.equal(history.assetsUnresolved, 1);
});

test('a favourite-buying record reconstructs to negative expectancy end to end', async () => {
  // 8 of 10 correct, every entry at 0.90: the shape the old screen rewarded.
  const trades = Array.from({ length: 10 }, (_, i) =>
    trade({ asset: `a${i}`, conditionId: `c${i}`, price: 0.9, shares: 100, eventSlug: `e${i}` }));
  const outcomes = Object.fromEntries(trades.map((_, i) =>
    [`c${i}`, { asset: `a${i}`, result: i < 8 ? 'won' as const : 'lost' as const }]));
  const history = await reconstructTraderHistory(trades, stubResolutions(outcomes), '0x1');
  assert.equal(history.resolvedTrades.length, 10);
  const estimate = estimateEdge(history.resolvedTrades);
  assert.ok(estimate.meanEdge < 0, `80% win rate at 0.90 must price out negative, got ${estimate.meanEdge}`);
  assert.equal(estimate.score, 0);
});
