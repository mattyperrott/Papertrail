import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateSimultaneously } from './allocation.js';

test('simultaneous allocation is order-independent and shares scarce buckets', () => {
  const input = [
    { id: 'a', market: 'm', trader: 't1', event: 'e', desired: 100 },
    { id: 'b', market: 'm', trader: 't2', event: 'e', desired: 100 },
  ];
  const limits = { cash: 100, portfolio: 100, market: { m: 100 }, trader: { t1: 100, t2: 100 }, event: { e: 100 } };
  const forward = allocateSimultaneously(input, limits);
  const reverse = allocateSimultaneously([...input].reverse(), limits);
  assert.equal(forward[0].allocation, 50);
  assert.deepEqual(Object.fromEntries(forward.map((row) => [row.id, row.allocation])), Object.fromEntries(reverse.map((row) => [row.id, row.allocation])));
});

test('simultaneous allocation enforces overlapping trader and event ceilings', () => {
  const result = allocateSimultaneously([
    { id: 'a', market: 'm1', trader: 't', event: 'e1', desired: 80 },
    { id: 'b', market: 'm2', trader: 't', event: 'e2', desired: 80 },
    { id: 'c', market: 'm3', trader: 'u', event: 'e1', desired: 80 },
  ], { cash: 200, portfolio: 200, market: { m1: 100, m2: 100, m3: 100 }, trader: { t: 80, u: 100 }, event: { e1: 90, e2: 100 } });
  const by = (field: 'trader'|'event', key: string) => result.filter((row) => row[field] === key).reduce((sum, row) => sum + row.allocation, 0);
  assert.ok(by('trader', 't') <= 80 + 1e-8);
  assert.ok(by('event', 'e1') <= 90 + 1e-8);
});
