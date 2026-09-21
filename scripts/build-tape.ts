/**
 * Build a replay tape from real public Polymarket history.
 *
 * Usage: npx tsx scripts/build-tape.ts [days] [out.jsonl] [address...]
 *
 * Every frame carries only evidence that existed at its own timestamp:
 *   - the trader's settled record is reconstructed from trades strictly BEFORE
 *     the frame, so today's outcomes never inform a past selection decision;
 *   - open positions are netted from the same prior-only slice;
 *   - resolutions are attached only once the market has actually settled.
 *
 * The one thing public history cannot supply is the order book as it stood at
 * the moment of the trade. Fills therefore use a documented depth proxy built
 * around the observed trade price, and every frame is tagged accordingly. That
 * models entry price, sizing, fees and exits, but not queue position or the real
 * depth available at the time.
 */
import { open, readFile, writeFile } from 'node:fs/promises';
import type { SourcePosition, SourceTrade, TraderCandidate } from '../src/shared/types.js';
import type { ReplayFrame } from '../src/server/backtest.js';
import type { ExecutionContext } from '../src/server/paperExecution.js';
import { PolymarketSource } from '../src/server/sources/polymarket.js';
import { MarketResolutionCache } from '../src/server/sources/traderHistory.js';
import { resultForAsset } from '../src/server/sources/marketTiming.js';
import { wilsonLowerBound } from '../src/server/scoring.js';
import { mapLimited } from '../src/server/lib/async.js';
import { asArray, asRecord, stringFrom } from '../src/server/lib/http.js';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
/** Half-spread and displayed depth for the proxy book, in bps and share multiples. */
const PROXY_HALF_SPREAD_BPS = 50;
const PROXY_DEPTH_MULTIPLE = 25;
const PROXY_FEE_RATE = 0.02;
/** Largest held lots carried in each frame's position snapshot. */
const MAX_POSITIONS_PER_FRAME = 25;
/** Assets the paper account could still be holding, kept quotable so forced exits
 * can execute. The live orchestrator fetches a book for every open position, so a
 * tape that omits them makes exits impossible and measures the harness instead of
 * the strategy. Bounded: holdings are capped by the risk limits and the horizon. */
const QUOTABLE_ASSET_WINDOW = 150;
/** How long an asset stays quotable after it was last traded. Exits are driven
 * by a time horizon, so quotability must be time-based too: a count-based window
 * turned over within a day on a busy tape and left week-old positions with no
 * book to exit into. */
const QUOTABLE_TTL_MS = 12 * DAY;

const days = Number(process.argv[2] ?? 45);
const outPath = process.argv[3] ?? 'data/tape/frames.jsonl';
const explicit = process.argv.slice(4).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const maxWallets = Number(process.argv.slice(4).find((a) => /^\d+$/.test(a)) ?? 500);

const polymarket = new PolymarketSource();
const resolutions = new MarketResolutionCache();

const MARKET_CACHE = 'data/tape/markets.json';
interface SlimMarket { endDate?: string; umaEndDate?: string; umaResolutionStatus?: string; clobTokenIds?: string; outcomePrices?: string; tags?: string[] }
const marketCache = new Map<string, SlimMarket | null>();

async function loadMarketCache() {
  try {
    const raw = JSON.parse(await readFile(MARKET_CACHE, 'utf8')) as Record<string, SlimMarket | null>;
    for (const [k, v] of Object.entries(raw)) marketCache.set(k, v);
    console.error(`Loaded ${marketCache.size} cached markets.`);
  } catch { /* first run */ }
}
async function saveMarketCache() {
  await writeFile(MARKET_CACHE, JSON.stringify(Object.fromEntries(marketCache)));
}
/** Settled outcomes never change, so only unresolved markets are re-fetched. */
async function marketFor(conditionId: string, eventSlug?: string): Promise<SlimMarket | null> {
  const key = conditionId.toLowerCase();
  const hit = marketCache.get(key);
  // Only a settled market is a permanent fact. A null (not found) or a pending
  // market is looked up again: caching a transient miss forever meant that
  // market could never settle, and an unsettled position jams the whole replay.
  if (hit && String(hit.umaResolutionStatus).toLowerCase() === 'resolved') {
    // Entries cached before tags were recorded are backfilled once, in place.
    if (hit && hit.tags === undefined && eventSlug) {
      hit.tags = (await resolutions.tags(eventSlug).catch(() => undefined)) ?? [];
      marketCache.set(key, hit);
    }
    return hit;
  }
  const market = await resolutions.market(conditionId, eventSlug);
  const tags = eventSlug ? await resolutions.tags(eventSlug).catch(() => undefined) : undefined;
  const slim: SlimMarket | null = market ? {
    tags,
    endDate: stringFrom(market.endDate) || undefined, umaEndDate: stringFrom(market.umaEndDate) || undefined,
    umaResolutionStatus: stringFrom(market.umaResolutionStatus) || undefined,
    clobTokenIds: stringFrom(market.clobTokenIds) || undefined, outcomePrices: stringFrom(market.outcomePrices) || undefined,
  } : null;
  marketCache.set(key, slim);
  return slim;
}

async function wallets(): Promise<string[]> {
  if (explicit.length) return explicit.map((a) => a.toLowerCase());
  try {
    const db=new DatabaseSync('data/tradesnipes-v3.sqlite',{readOnly:true});
    const row=db.prepare('SELECT payload FROM state_snapshot WHERE id=1').get() as {payload:string}|undefined;
    db.close();
    const state = JSON.parse(row?.payload??'{}') as { traders?: TraderCandidate[] };
    // Deliberately unfiltered: pre-selecting on today's verification would leak
    // the outcome we are trying to test. The whole scanned pool goes in and the
    // contemporaneous screen inside each frame decides who qualifies.
    const pool = (state.traders ?? []).map((t) => t.address.toLowerCase());
    if (pool.length) return pool.slice(0, maxWallets);
  } catch { /* fall through to discovery */ }
  return (await polymarket.leaderboard('OVERALL', 'MONTH', 500)).slice(0, maxWallets).map((t) => t.address.toLowerCase());
}

/** Market end date, needed because the engine refuses an entry without one. */
async function endDateFor(trade: SourceTrade): Promise<string | undefined> {
  return (await marketFor(trade.conditionId, trade.eventSlug))?.endDate;
}

async function settledOutcome(trade: SourceTrade): Promise<{ result: 'won' | 'lost'; at: number } | null> {
  const market = await marketFor(trade.conditionId, trade.eventSlug);
  if (!market) return null;
  const outcome = resultForAsset(market as unknown as Record<string, unknown>, trade.asset);
  if (outcome === 'unknown') return null;
  const at = Date.parse(market.umaEndDate || market.endDate || '');
  return { result: outcome, at: Number.isFinite(at) ? at : Number.NaN };
}

/** Order book proxy centred on the observed trade price. */
function proxyExecution(trade: SourceTrade, at: number): ExecutionContext {
  const half = trade.price * (PROXY_HALF_SPREAD_BPS / 10_000);
  const round = (v: number) => Math.min(0.99, Math.max(0.01, Math.round(v * 100) / 100));
  const bid = round(trade.price - half);
  const ask = round(trade.price + half);
  const size = Math.max(50, trade.shares * PROXY_DEPTH_MULTIPLE);
  return {
    sourcePositionsAsOf: at,
    consumed: {},
    quotes: { [trade.asset]: {
      asset: trade.asset, capturedAt: at,
      bids: [{ price: bid, size }], asks: [{ price: ask, size }],
      tickSize: 0.01, minOrderShares: 5, feeRate: PROXY_FEE_RATE, feeExponent: 1,
    } },
  };
}

interface Lot { lastPrice?: number; endDate?: string; shares: number; cost: number; conditionId: string; eventSlug?: string; title: string; outcome: string; asset: string }

async function main() {
  await loadMarketCache();
  const addresses = await wallets();
  const since = Math.floor((Date.now() - days * DAY) / 1000);
  console.error(`Fetching ${days}d of public history for ${addresses.length} wallets…`);

  // Walk the window in chunks so a busy wallet cannot blow the endpoint's row
  // budget and lose its entire history.
  const CHUNK = 7 * 86_400;
  const nowSec = Math.floor(Date.now() / 1000);
  const tapes = await mapLimited(addresses, 3, async (address) => {
    const collected = new Map<string, SourceTrade>();
    let failures = 0;
    for (let from = since; from < nowSec; from += CHUNK) {
      try {
        for (const t of await polymarket.activitySince(address, from, 'lenient', Math.min(from + CHUNK, nowSec))) collected.set(t.id, t);
      } catch { failures += 1; }
    }
    if (failures) console.error(`  ${address.slice(0, 10)}: ${failures} chunk(s) unavailable, kept ${collected.size} trades`);
    return { address, trades: [...collected.values()].sort((a, b) => a.timestamp - b.timestamp) };
  });
  const all = tapes.flatMap((t) => t.trades).sort((a, b) => a.timestamp - b.timestamp);
  console.error(`${all.length} trades across ${tapes.filter((t) => t.trades.length).length} wallets.`);

  // Resolve every distinct market once, shared across wallets.
  const distinct = [...new Map(all.map((t) => [t.conditionId, t])).values()];
  console.error(`Resolving ${distinct.length} markets…`);
  let done = 0;
  await mapLimited(distinct, 8, async (t) => {
    await marketFor(t.conditionId, t.eventSlug);
    if (++done % 500 === 0) { console.error(`  ${done}/${distinct.length}`); await saveMarketCache(); }
    return null;
  });
  await saveMarketCache();

  const lots = new Map<string, Map<string, Lot>>();
  /** Last price any wallet traded each asset at, used to mark and to price books. */
  const lastPrice = new Map<string, number>();
  /** Insertion-ordered LRU of assets we may have bought, newest last. */
  /** Quotable until the market resolves (end date + settlement grace) or, when no
   * end date is known, for the holding horizon plus margin after last seen. */
  /** Quotable until the asset settles. Time-based expiry left any position whose
   * settlement was late or missing without a book, and one unmarkable position
   * blocks every new buy. The LRU cap is a size backstop only. */
  const quotable = new Map<string, { price: number }>();
  const QUOTABLE_CAP = 400;
  const settledByWallet = new Map<string, Array<{ price: number; won: boolean; at: number }>>();
  const settledAssetRecorded = new Set<string>();
  const frames: ReplayFrame[] = [];
  let emitted = 0;

  for (const trade of all) {
    lastPrice.set(trade.asset, trade.price);
    const owner = trade.traderAddress.toLowerCase();
    const at = trade.timestamp * 1000;
    const book = lots.get(owner) ?? new Map<string, Lot>();
    lots.set(owner, book);

    if (trade.side === 'BUY' && !trade.isCombo) {
      // Point-in-time record: only markets already settled at this instant.
      const settled = settledByWallet.get(owner) ?? [];
      const priorSettled = settled.filter((s) => Number.isFinite(s.at) && s.at < at);
      const wins = priorSettled.filter((s) => s.won).length;
      const losses = priorSettled.length - wins;
      const endDate = await endDateFor(trade);
      const end = Date.parse(endDate ?? '');

      if (wins + losses >= 25 && wilsonLowerBound(wins, losses) * 100 >= 60
        && Number.isFinite(end) && end > at && end <= at + 7 * DAY
        && trade.price > 0 && trade.price < 1) {
        const profit = priorSettled.reduce((s, x) => s + (x.won ? 1 - x.price : -x.price), 0);
        const cost = priorSettled.reduce((s, x) => s + x.price, 0);
        const roi = cost > 0 ? 100 * profit / cost : 0;
        if (roi >= 2 && profit > 0) {
          // Cap the snapshot. The replay uses positions to mark paper holdings and
          // to freshness-check the traded asset; a paper account holds only a
          // handful of assets at a time, so carrying every one of a busy wallet's
          // lots in every frame multiplies tape size for no modelling gain.
          const held = [...book.values()].filter((l) => l.shares > 1e-6)
            .sort((a, b) => b.cost - a.cost).slice(0, MAX_POSITIONS_PER_FRAME);
          const positions: SourcePosition[] = [...held, {
            shares: 0, cost: 0, conditionId: trade.conditionId, eventSlug: trade.eventSlug,
            title: trade.title, outcome: trade.outcome, asset: trade.asset,
          } as Lot].map((l) => ({
            observedAt: new Date(at).toISOString(), traderAddress: owner, asset: l.asset,
            conditionId: l.conditionId, title: l.title, outcome: l.outcome,
            size: Math.max(l.shares, l.asset === trade.asset ? trade.shares : 0),
            avgPrice: l.shares > 0 ? l.cost / l.shares : trade.price,
            currentPrice: l.asset === trade.asset ? trade.price
              : Math.min(0.99, Math.max(0.01, lastPrice.get(l.asset) ?? l.cost / Math.max(l.shares, 1e-9))),
            currentValue: 0, pnl: 0, redeemable: false,
            eventSlug: l.eventSlug, endDate: l.asset === trade.asset ? endDate : l.endDate,
          })).map((p) => ({ ...p, currentValue: p.size * p.currentPrice }));

          const trader: TraderCandidate = {
            address: owner, name: trade.traderName, provider: 'polymarket', rank: 1,
            pnl: profit, volume: cost, roi, winRate: 100 * wins / (wins + losses),
            trades: wins + losses, score: 0, watched: true, selected: true,
            verification: { provider: 'polymarketscan', checkedAt: new Date(at - 60_000).toISOString(),
              url: '', status: 'verified', pnl: profit, roi, wins, losses, notes: [] },
            reasons: [], openPositions: held.length,
            lastActivityAt: new Date(at - 60_000).toISOString(),
          };
          const execution = proxyExecution(trade, at);
          for (const p of positions) {
            if (execution.quotes![p.asset]) continue;
            const px = Math.min(0.99, Math.max(0.01, lastPrice.get(p.asset) ?? p.currentPrice));
            const half = px * (PROXY_HALF_SPREAD_BPS / 10_000);
            const r = (v: number) => Math.min(0.99, Math.max(0.01, Math.round(v * 100) / 100));
            execution.quotes![p.asset] = { asset: p.asset, capturedAt: at,
              bids: [{ price: r(px - half), size: Math.max(50, p.size * PROXY_DEPTH_MULTIPLE) }],
              asks: [{ price: r(px + half), size: Math.max(50, p.size * PROXY_DEPTH_MULTIPLE) }],
              tickSize: 0.01, minOrderShares: 5, feeRate: PROXY_FEE_RATE, feeExponent: 1 };
          }
          quotable.delete(trade.asset);
          // A book exists for as long as the market is live. Tying quotability to a
          // fixed window after last sight left positions whose markets outlived the
          // window unmarkable, and one unmarkable position blocks every new buy.
          quotable.set(trade.asset, { price: trade.price });
          while (quotable.size > QUOTABLE_CAP) quotable.delete(quotable.keys().next().value!);
          for (const [asset] of quotable) {
            if (execution.quotes![asset]) continue;
            const px = Math.min(0.99, Math.max(0.01, lastPrice.get(asset) ?? quotable.get(asset)!.price));
            const half = px * (PROXY_HALF_SPREAD_BPS / 10_000);
            const r = (v: number) => Math.min(0.99, Math.max(0.01, Math.round(v * 100) / 100));
            execution.quotes![asset] = { asset, capturedAt: at,
              bids: [{ price: r(px - half), size: 5000 }], asks: [{ price: r(px + half), size: 5000 }],
              tickSize: 0.01, minOrderShares: 5, feeRate: PROXY_FEE_RATE, feeExponent: 1 };
          }
          const stampedSource = { ...trade, marketTags: (await marketFor(trade.conditionId, trade.eventSlug))?.tags };
          frames.push({ observedAt: at, traderSnapshotObservedAt: at - 60_000, source: stampedSource, trader, positions, execution });
          emitted += 1;
        }
      }
    }

    const lot = book.get(trade.asset) ?? { shares: 0, cost: 0, conditionId: trade.conditionId,
      eventSlug: trade.eventSlug, title: trade.title, outcome: trade.outcome, asset: trade.asset };
    if (lot.endDate === undefined) lot.endDate = (await marketFor(trade.conditionId, trade.eventSlug))?.endDate;
    if (trade.side === 'BUY') { lot.shares += trade.shares; lot.cost += trade.shares * trade.price; }
    else { const f = Math.min(1, trade.shares / Math.max(lot.shares, 1e-9)); lot.cost *= 1 - f; lot.shares -= trade.shares; }
    book.set(trade.asset, lot);

    const outcome = await settledOutcome(trade);
    const settledKey=`${owner}:${trade.asset}`;
    if (outcome && trade.side === 'BUY' && !settledAssetRecorded.has(settledKey)) {
      settledAssetRecorded.add(settledKey);
      const list = settledByWallet.get(owner) ?? [];
      list.push({ price: trade.price, won: outcome.result === 'won', at: outcome.at });
      settledByWallet.set(owner, list);
    }
  }

  // Each settlement is attached to exactly ONE frame: the first observed at or
  // after it resolves. Repeating it on every later frame is redundant for the
  // replay and makes the tape grow as frames x markets, which overflows the
  // maximum string length on any realistic universe.
  // Resolve per ASSET, not per market. A market has two tokens; keying on the
  // first trade seen per market put the outcome on the YES token when the trader
  // actually held NO, so that position never settled, could not be marked once
  // its book aged out, and jammed the whole replay behind a stale-marks gate.
  const resolvedAssets = new Map<string, { result: 'won' | 'lost'; at: number }>();
  const distinctAssets = [...new Map(all.map((t) => [t.asset, t])).values()];
  for (const trade of distinctAssets) {
    const outcome = await settledOutcome(trade);
    if (outcome && Number.isFinite(outcome.at)) resolvedAssets.set(trade.asset, outcome);
  }
  frames.sort((a, b) => a.observedAt - b.observedAt);
  const pending = [...resolvedAssets.entries()].sort((a, b) => a[1].at - b[1].at);
  let cursor = 0;
  // Note: books for settled assets remain in earlier frames harmlessly; settlement
  // pays out regardless of quotes, so nothing depends on removing them.
  for (const frame of frames) {
    const due: NonNullable<ReplayFrame['resolutions']> = [];
    while (cursor < pending.length && pending[cursor][1].at <= frame.observedAt) {
      const [asset, r] = pending[cursor++];
      due.push({ asset, observedAt: r.at, result: r.result, timingSource: 'polymarket' });
    }
    if (due.length) frame.resolutions = due;
  }

  // Stream to disk; one JSON string for the whole tape would exceed the limit.
  const handle = await open(outPath, 'w');
  try { for (const frame of frames) await handle.write(JSON.stringify(frame) + '\n'); }
  finally { await handle.close(); }
  await saveMarketCache();
  console.error(`\nWrote ${emitted} frames to ${outPath}`);
  console.error(`Span: ${frames.length ? new Date(frames[0].observedAt).toISOString().slice(0, 10) : '-'} to ${frames.length ? new Date(frames.at(-1)!.observedAt).toISOString().slice(0, 10) : '-'}`);
  console.error('Fills use a documented depth proxy; no historical order book exists.');
  console.error('This tape is engineering-only: its discovery universe is current and its books are liquidity proxies.');
}

await main();
