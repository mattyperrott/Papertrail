import assert from 'node:assert/strict';
import test from 'node:test';
import { PolymarketSource } from './polymarket.js';

test('discovers and deduplicates wallets across daily, weekly, and monthly pages', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    requests.push(url);
    const period = url.searchParams.get('timePeriod') ?? 'DAY';
    const offset = Number(url.searchParams.get('offset'));
    const rows = Array.from({ length: 50 }, (_, index) => {
      const identity = offset === 0 ? index : offset + index + (period === 'DAY' ? 0 : period === 'WEEK' ? 1_000 : 2_000);
      return {
        rank: offset + index + 1,
        proxyWallet: `0x${identity.toString(16).padStart(40, '0')}`,
        userName: `${period}-${identity}`,
        pnl: 1_000 - identity,
        vol: 10_000,
      };
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;

  try {
    const traders = await new PolymarketSource().leaderboard('OVERALL', 'MONTH', 120);
    assert.equal(traders.length, 120);
    assert.deepEqual(traders[0].leaderboardPeriods, ['DAY', 'WEEK', 'MONTH']);
    assert.deepEqual(new Set(requests.map((url) => url.searchParams.get('timePeriod'))), new Set(['DAY', 'WEEK', 'MONTH']));
    assert.ok(requests.some((url) => url.searchParams.get('offset') === '50'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
