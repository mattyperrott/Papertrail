import assert from 'node:assert/strict';
import test from 'node:test';
import { PolymarketSource } from './polymarket.js';
import { ArkhamSource } from './arkham.js';
import { finiteNumber } from './normalization.js';

const wallet = `0x${'1'.repeat(40)}`;
const otherWallet = `0x${'2'.repeat(40)}`;
const end = Math.floor(Date.now() / 1000);
const baseRow = {
  proxyWallet: wallet, type: 'TRADE', side: 'BUY', timestamp: end - 10,
  transactionHash: '0xabc', asset: '123', conditionId: '0xcondition',
  size: 10, price: 0.5, usdcSize: 5, outcome: 'Yes', isCombo: false,
};
const positionRow = { proxyWallet: wallet, asset: '123', conditionId: '0xcondition', size: 10,
  avgPrice: 0.5, curPrice: 0.6, currentValue: 6, cashPnl: 1, redeemable: false };

async function withFetch(handler: (url: URL) => unknown, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return new Response(JSON.stringify(handler(url)), { status: 200 });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = originalFetch; }
}

test('missing numeric values cannot silently normalize to zero', () => {
  for (const value of [null, undefined, '', ' ', true, NaN, Infinity]) assert.equal(finiteNumber(value), undefined);
  assert.equal(finiteNumber('0'), 0);
});

test('trade queries filter at source, reject duplicates and bind fingerprint to wallet and price', async () => {
  let query: URL | undefined;
  await withFetch((url) => { query = url; return [baseRow, baseRow, { ...baseRow, price: 0.6, usdcSize: 6 }]; }, async () => {
    const rows = await new PolymarketSource().activity(wallet, 1);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.equal(query?.searchParams.get('type'), 'TRADE');
    assert.equal(query?.searchParams.get('sortDirection'), 'DESC');
  });
  let firstId = '';
  await withFetch(() => [baseRow], async () => { firstId = (await new PolymarketSource().activity(wallet))[0].id; });
  await withFetch(() => [{ ...baseRow, proxyWallet: otherWallet }], async () => {
    assert.notEqual((await new PolymarketSource().activity(otherWallet))[0].id, firstId);
  });
});

test('invalid source economics, mismatched wallets, malformed payloads fail closed', async () => {
  // A row whose economics do not reconcile is dropped, never acted on. Rejecting
  // the whole page instead discarded the valid rows with it, which stopped live
  // copying and force-paused the engine after three consecutive poll failures.
  for (const invalid of [{ ...baseRow, price: null }, { ...baseRow, size: 0 }, { ...baseRow, timestamp: null },
    { ...baseRow, usdcSize: 1000 }, { ...baseRow, price: 1 }]) {
    await withFetch(() => [invalid], async () => {
      assert.deepEqual(await new PolymarketSource().activity(wallet), [], 'the bad row is excluded');
    });
    await withFetch(() => [invalid, baseRow], async () => {
      const rows = await new PolymarketSource().activity(wallet);
      assert.equal(rows.length, 1, 'a valid row alongside it still survives');
    });
  }
  // A response about a different wallet is not a data-quality problem: it means
  // the upstream answered the wrong question, so the whole page fails closed.
  await withFetch(() => [{ ...baseRow, proxyWallet: otherWallet }], async () => {
    await assert.rejects(new PolymarketSource().activity(wallet));
  });
  await withFetch(() => ({ error: 'upstream unavailable' }), async () => {
    await assert.rejects(new PolymarketSource().activity(wallet), /payload/);
  });
});

test('activity window fully paginates a fixed start and end and sorts oldest first', async () => {
  const requests: URL[] = [];
  const start = end - 1000;
  await withFetch((url) => {
    requests.push(url);
    const offset = Number(url.searchParams.get('offset'));
    return Array.from({ length: offset === 0 ? 500 : 3 }, (_, i) => ({
      ...baseRow, asset: String(offset + i), timestamp: start + offset + i,
    }));
  }, async () => {
    const rows = await new PolymarketSource().activitySince(wallet, start);
    assert.equal(rows.length, 503);
    assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['0', '500']);
    assert.equal(new Set(requests.map((url) => url.searchParams.get('end'))).size, 1);
    assert.equal(rows[0].timestamp, start);
    assert.equal(rows[502].timestamp, start + 502);
  });
});

test('repeated full pages and exhausted activity offset budgets fail without partial success', async () => {
  const repeated = Array.from({ length: 500 }, (_, i) => ({ ...baseRow, asset: String(i) }));
  await withFetch(() => repeated, async () => {
    await assert.rejects(new PolymarketSource().activitySince(wallet, end - 1000), /repeated/);
  });
  let requests = 0;
  await withFetch((url) => {
    requests += 1;
    const offset = Number(url.searchParams.get('offset'));
    return Array.from({ length: 500 }, (_, i) => ({ ...baseRow, asset: String(offset + i) }));
  }, async () => {
    await assert.rejects(new PolymarketSource().activitySince(wallet, end - 1000), /API budget/);
    assert.equal(requests, 11);
  });
});

test('positions paginate fully, include archived, exclude dust, and preserve real zero marks', async () => {
  const requests: URL[] = [];
  await withFetch((url) => {
    requests.push(url);
    return url.searchParams.get('offset') === '0'
      ? [positionRow, { ...positionRow, asset: '124', curPrice: 0, currentValue: 0, redeemable: 'false' }]
      : [{ ...positionRow, asset: '125' }];
  }, async () => {
    const positions = await new PolymarketSource().positions(wallet, 2);
    assert.equal(positions.length, 3);
    assert.equal(positions[1].currentPrice, 0);
    assert.equal(positions[1].redeemable, false);
    assert.deepEqual(requests.map((url) => url.searchParams.get('offset')), ['0', '2']);
    // Dust below one share is excluded: it cannot be mirrored (the book minimum is
    // five shares) and it is what pushes prolific wallets past the offset budget.
    // Zero-PRICE positions are unaffected — that filter is on share count — so the
    // lost-market mark above still survives.
    assert.equal(requests[0].searchParams.get('sizeThreshold'), '1');
    assert.equal(requests[0].searchParams.get('includeArchived'), 'true');
  });
});

test('invalid position marks and saturated repeated position pages fail closed', async () => {
  await withFetch(() => [{ ...positionRow, curPrice: null }], async () => {
    await assert.rejects(new PolymarketSource().positions(wallet), /position economics/);
  });
  await withFetch(() => [{ ...positionRow, size: 'abc' }], async () => {
    await assert.rejects(new PolymarketSource().positions(wallet), /position economics/);
  });
  await withFetch(() => [{ ...positionRow, currentValue: 60 }], async () => {
    await assert.rejects(new PolymarketSource().positions(wallet), /valuation/);
  });
  await withFetch(() => [positionRow], async () => {
    await assert.rejects(new PolymarketSource().positions(wallet, 1), /repeated/);
  });
});

test('an out-of-range average entry or missing cash P&L is informational and never discards the wallet snapshot', async () => {
  // Observed live: the data-api returned avgPrice -0.0308 on a 15-minute crypto
  // market for one wallet. Rejecting that row aborted the whole snapshot, so the
  // orchestrator skipped the trader on every poll and none of its signals ran.
  const rows = [
    { ...positionRow, asset: '123' },
    { ...positionRow, asset: '124', title: 'XRP Up or Down - May 4, 4:00PM-4:15PM ET', size: 19.2307, avgPrice: -0.0308, curPrice: 0, currentValue: 0, cashPnl: 0.5941 },
    { ...positionRow, asset: '125', avgPrice: 1.5 },
    { ...positionRow, asset: '126', avgPrice: null, cashPnl: undefined },
  ];
  await withFetch(() => rows, async () => {
    const positions = await new PolymarketSource().positions(wallet);
    assert.deepEqual(positions.map((position) => position.asset), ['123', '124', '125', '126']);
    assert.equal(positions[0].avgPrice, 0.5);
    assert.equal(positions[0].pnl, 1);
    // NaN (null over JSON) rather than 0: a fabricated zero basis would read as a
    // free entry, and the engine's drift guards treat a non-finite basis as unknown.
    for (const position of positions.slice(1)) assert.ok(Number.isNaN(position.avgPrice), `${position.asset} basis`);
    assert.equal(positions[1].size, 19.2307);
    assert.equal(positions[1].currentPrice, 0);
    assert.equal(positions[1].currentValue, 0);
    assert.equal(positions[1].pnl, 0.5941);
    assert.ok(Number.isNaN(positions[3].pnl));
  });
  await withFetch(() => ({ positions: [
    { tokenAddress: '0xa', conditionId: '0xc', netPosition: 10, lastPrice: 0.4, averagePrice: 0.3 },
    { tokenAddress: '0xb', conditionId: '0xc', netPosition: 10, lastPrice: 0.4, averagePrice: -0.02 },
  ] }), async () => {
    const positions = await new ArkhamSource('test').positions(wallet);
    assert.equal(positions.length, 2);
    assert.equal(positions[0].avgPrice, 0.3);
    assert.ok(Number.isNaN(positions[1].avgPrice));
    assert.equal(positions[1].currentValue, 4);
  });
});

test('Arkham token totals, fill counts and reward income are not trading-performance evidence', async () => {
  await withFetch(() => ({ entries: [{ userAddress: wallet, rank: 1, tokensWon: 999, tokensTotal: 1000,
    tradeCount: 100000, periodPnl: -100, periodRewards: 1000 }] }), async () => {
    const row = (await new ArkhamSource('test').leaderboard('MONTH', 5))[0];
    assert.equal(row.pnl, -100);
    assert.equal(row.winRate, null);
    assert.equal(row.trades, null);
  });
});
