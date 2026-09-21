import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaperPosition } from '../../shared/types.js';
import { resolveComboPosition } from './polymarketCombos.js';

const position: PaperPosition = {
  id: '0xtrader:101',
  traderAddress: '0x0000000000000000000000000000000000000001',
  traderName: 'Combo trader',
  asset: '101',
  conditionId: '0xcombo',
  title: 'Leg one AND leg two',
  outcome: 'Combo',
  shares: 10,
  avgPrice: 0.7,
  currentPrice: 0.7,
  costBasis: 7,
  currentValue: 7,
  unrealizedPnl: 0,
  realizedPnl: 0,
  openedAt: '2026-09-08T12:00:00Z',
  updatedAt: '2026-09-08T12:00:00Z',
  isCombo: true,
};

const legs = [
  {
    leg_status: 'RESOLVED_WIN',
    leg_resolved_at: '2026-09-08T18:00:00Z',
    market: { end_date: '2026-09-08', title: 'Leg one' },
  },
  {
    leg_status: 'RESOLVED_WIN',
    leg_resolved_at: '2026-09-08T21:00:00Z',
    market: { end_date: '2026-09-08T19:00:00Z', title: 'Leg two' },
  },
];

test('uses the official combo position side and resolved loss status', () => {
  const resolution = resolveComboPosition(position, [{
    combo_condition_id: '0xcombo',
    combo_position_id: '101',
    side: 'NO',
    status: 'RESOLVED_LOSS',
    resolved_at: '2026-09-08T21:00:00Z',
    legs,
  }], []);
  assert.equal(resolution.side, 'NO');
  assert.equal(resolution.result, 'lost');
  assert.equal(resolution.resolvedAt, '2026-09-08T21:00:00.000Z');
});

test('does not manufacture binary payout or side from a nonzero redemption amount', () => {
  const oneLost = [{ ...legs[0] }, { ...legs[1], leg_status: 'RESOLVED_LOSS' }];
  const resolution = resolveComboPosition(position, [], [{
    combo_condition_id: '0xcombo',
    combo_position_id: '101',
    type: 'REDEEM',
    payout_usdc: 10,
    tx_dttm: '2026-09-08T21:05:00Z',
    legs: oneLost,
  }]);
  assert.equal(resolution.side, undefined);
  assert.equal(resolution.result, undefined);
  assert.equal(resolution.expectedEndAt, '2026-09-08T23:59:59.000Z');
});

test('preserves a known combo side while its legs are still pending', () => {
  const pending = { ...position, comboSide: 'YES' as const };
  const resolution = resolveComboPosition(pending, [], [{
    combo_condition_id: '0xcombo',
    type: 'SPLIT',
    legs: [{
      leg_status: 'OPEN',
      market: { end_date: '2026-09-10T19:00:00Z', title: 'Leg one' },
    }],
  }]);
  assert.equal(resolution.side, 'YES');
  assert.equal(resolution.result, undefined);
  assert.equal(resolution.expectedEndAt, '2026-09-10T19:00:00.000Z');
});
