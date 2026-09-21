import type { SourceTrade } from '../../shared/types.js';
import type { ResolvedTrade } from '../edge.js';
import { asArray, asRecord, fetchJson, stringFrom } from '../lib/http.js';
import { mapLimited } from '../lib/async.js';
import { resultForAsset } from './marketTiming.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
/** A settled market's outcome is immutable, so it is cached for the process
 * lifetime. Only markets still pending are re-checked. */
const PENDING_TTL_MS = 60 * 60_000;
const RESOLUTION_CACHE_LIMIT = 5000;
/** Most recent distinct assets examined per trader, bounding first-run cost. */
const MAX_ASSETS_PER_TRADER = 150;
const DUST_SHARES = 1e-6;

export interface TraderHistory {
  address: string;
  fetchedAt: string;
  resolvedTrades: ResolvedTrade[];
  earlyExitTrades: ResolvedTrade[];
  assetsSeen: number;
  assetsHeldToResolution: number;
  assetsExitedBeforeResolution: number;
  assetsUnresolved: number;
  notes: string[];
}

interface AssetLot {
  asset: string;
  conditionId: string;
  eventSlug?: string;
  buyShares: number;
  buyCost: number;
  sellShares: number;
  lastTimestamp: number;
}

export interface ReconstructedCycle {
  id:string;
  asset:string;
  conditionId:string;
  eventSlug?:string;
  openedAt:number;
  closedAt?:number;
  boughtShares:number;
  entryCost:number;
  remainingShares:number;
  remainingCost:number;
  exitShares:number;
  exitProceeds:number;
}

/** Event-sourced inventory cycles. Scaling buys stay in one cycle; a full exit
 * closes it, and a later buy starts a distinct re-entry cycle. */
export function reconstructTradeCycles(trades:SourceTrade[]):ReconstructedCycle[] {
  const active=new Map<string,ReconstructedCycle>();
  const cycles:ReconstructedCycle[]=[];
  for(const {trade} of trades.map((trade,index)=>({trade,index})).sort((a,b)=>a.trade.timestamp-b.trade.timestamp||a.index-b.index)) {
    if(!trade.asset||!Number.isFinite(trade.shares)||trade.shares<=0||!Number.isFinite(trade.price)||trade.price<=0)continue;
    let cycle=active.get(trade.asset);
    if(trade.side==='BUY') {
      if(!cycle){cycle={id:`${trade.asset}:${trade.id}`,asset:trade.asset,conditionId:trade.conditionId,eventSlug:trade.eventSlug,openedAt:trade.timestamp,boughtShares:0,entryCost:0,remainingShares:0,remainingCost:0,exitShares:0,exitProceeds:0};active.set(trade.asset,cycle);cycles.push(cycle);}
      const cost=trade.shares*trade.price;
      cycle.boughtShares+=trade.shares;cycle.entryCost+=cost;cycle.remainingShares+=trade.shares;cycle.remainingCost+=cost;
    } else if(cycle&&cycle.remainingShares>DUST_SHARES) {
      const sold=Math.min(cycle.remainingShares,trade.shares),fraction=sold/cycle.remainingShares;
      cycle.exitShares+=sold;cycle.exitProceeds+=sold*trade.price;cycle.remainingCost-=cycle.remainingCost*fraction;cycle.remainingShares-=sold;
      if(cycle.remainingShares<=DUST_SHARES){cycle.remainingShares=0;cycle.remainingCost=0;cycle.closedAt=trade.timestamp;active.delete(trade.asset);}
    }
  }
  return cycles;
}

/**
 * Net each asset from a trade tape into a single lot.
 *
 * Entry price is the volume-weighted average of the buys, not the last fill: a
 * trader who scaled in at 0.30 and 0.55 did not enter at 0.55.
 */
export function netAssetLots(trades: SourceTrade[]): AssetLot[] {
  const lots = new Map<string, AssetLot>();
  for (const trade of trades) {
    if (!trade.asset || !Number.isFinite(trade.price) || !Number.isFinite(trade.shares)) continue;
    const lot = lots.get(trade.asset) ?? {
      asset: trade.asset, conditionId: trade.conditionId, eventSlug: trade.eventSlug,
      buyShares: 0, buyCost: 0, sellShares: 0, lastTimestamp: 0,
    };
    if (trade.side === 'BUY') { lot.buyShares += trade.shares; lot.buyCost += trade.shares * trade.price; }
    else lot.sellShares += trade.shares;
    lot.lastTimestamp = Math.max(lot.lastTimestamp, trade.timestamp);
    lots.set(trade.asset, lot);
  }
  // Oldest first. Only settled markets carry an outcome, and an active trader's
  // most recent positions are precisely the ones still open, so taking the newest
  // assets returns a window with almost nothing to measure.
  return [...lots.values()].sort((left, right) => left.lastTimestamp - right.lastTimestamp);
}

/** Shared across traders: popular markets are held by many wallets at once, so
 * resolutions are looked up once rather than once per wallet. */
export class MarketResolutionCache {
  private readonly byCondition = new Map<string, { expiresAt: number; market: Record<string, unknown> | null }>();
  private readonly eventFetchedUntil = new Map<string, number>();
  private readonly eventTags = new Map<string, string[]>();
  fetched = 0;
  served = 0;

  /**
   * @param eventSlug Preferred lookup path when known.
   *
   * Sports markets are routinely absent from the `condition_ids` index — that
   * query returns zero rows for them — while the event endpoint resolves them
   * reliably. One event fetch also settles every leg it contains, so a trader's
   * many legs of one fixture cost a single request.
   */
  async market(conditionId: string, eventSlug?: string, now = Date.now()): Promise<Record<string, unknown> | null> {
    const key = conditionId.toLowerCase();
    const cached = this.byCondition.get(key);
    if (cached && cached.expiresAt > now) { this.served += 1; return cached.market; }

    if (eventSlug && (this.eventFetchedUntil.get(eventSlug) ?? 0) <= now) {
      await this.loadEvent(eventSlug, now);
      const viaEvent = this.byCondition.get(key);
      if (viaEvent && viaEvent.expiresAt > now) return viaEvent.market;
    }

    let market: Record<string, unknown> | null = null;
    try {
      this.fetched += 1;
      const rows = asArray(await fetchJson<unknown>(
        `${GAMMA_API}/markets?${new URLSearchParams({ condition_ids: conditionId })}`,
      )).map(asRecord);
      market = rows.find((row) => stringFrom(row.conditionId).toLowerCase() === key) ?? null;
    } catch {
      market = null;
    }
    this.remember(key, market, now);
    return market;
  }

  /** Event tag slugs, or undefined when they could not be established. Tags live
   * on the event rather than the market, so one lookup covers every leg. */
  async tags(eventSlug: string, now = Date.now()): Promise<string[] | undefined> {
    if (!this.eventTags.has(eventSlug) && (this.eventFetchedUntil.get(eventSlug) ?? 0) <= now) {
      await this.loadEvent(eventSlug, now);
    }
    return this.eventTags.get(eventSlug);
  }

  private async loadEvent(slug: string, now: number) {
    this.eventFetchedUntil.set(slug, now + PENDING_TTL_MS);
    try {
      this.fetched += 1;
      const event = asRecord(await fetchJson<unknown>(`${GAMMA_API}/events/slug/${encodeURIComponent(slug)}`));
      this.eventTags.set(slug, asArray(event.tags).map(asRecord)
        .map((tag) => stringFrom(tag.slug) || stringFrom(tag.label))
        .filter((tag) => tag.length > 0).map((tag) => tag.toLowerCase()));
      for (const market of asArray(event.markets).map(asRecord)) {
        const id = stringFrom(market.conditionId).toLowerCase();
        if (id) this.remember(id, market, now);
      }
    } catch { /* the condition_ids fallback still runs */ }
  }

  /** A settled outcome never changes; anything else is retried within the hour. */
  private remember(key: string, market: Record<string, unknown> | null, now: number) {
    const settled = market !== null && stringFrom(market.umaResolutionStatus).toLowerCase() === 'resolved';
    if (this.byCondition.size >= RESOLUTION_CACHE_LIMIT) {
      for (const [entry, value] of this.byCondition) if (value.expiresAt <= now) this.byCondition.delete(entry);
      if (this.byCondition.size >= RESOLUTION_CACHE_LIMIT) this.byCondition.delete(this.byCondition.keys().next().value!);
    }
    this.byCondition.set(key, { market, expiresAt: settled ? Number.POSITIVE_INFINITY : now + PENDING_TTL_MS });
  }
}

/**
 * Reconstruct a trader's settled record as entry price against binary outcome.
 *
 * Only positions **held to resolution** are counted. A position exited before
 * the market settled has no binary outcome to attribute, and scoring it against
 * the eventual result would credit or blame the trader for a move they were not
 * exposed to. This conditions the estimate on held-to-resolution behaviour,
 * which is the relevant population here because the copy engine itself exits
 * only at settlement or a risk rule.
 */
export async function reconstructTraderHistory(
  trades: SourceTrade[],
  resolutions: MarketResolutionCache,
  address: string,
  now = Date.now(),
): Promise<TraderHistory> {
  const notes: string[] = [];
  const cycles = reconstructTradeCycles(trades);
  const considered = cycles.slice(0, MAX_ASSETS_PER_TRADER);
  if (cycles.length > considered.length) notes.push(`Examined the ${considered.length} earliest position cycles of ${cycles.length} in the fetched window.`);

  let heldToResolution = 0;
  let exitedEarly = 0;
  let unresolved = 0;
  const resolvedTrades: ResolvedTrade[] = [];
  const earlyExitTrades: ResolvedTrade[] = [];

  const outcomes = await mapLimited(considered, 4, async (lot) => {
    if (lot.boughtShares <= DUST_SHARES) return null;
    if (lot.remainingShares <= DUST_SHARES) return 'exited' as const;
    const market = await resolutions.market(lot.conditionId, lot.eventSlug, now);
    if (!market) return 'unresolved' as const;
    const result = resultForAsset(market, lot.asset);
    // A voided market refunds everyone; it carries no information about skill.
    return result === 'unknown' || result === 'void' ? ('unresolved' as const) : result;
  });

  for (const [index, outcome] of outcomes.entries()) {
    const lot = considered[index];
    if (outcome === null) continue;
    if (outcome === 'exited') {
      exitedEarly += 1;
      const price=lot.entryCost/lot.boughtShares,exit=lot.exitProceeds/lot.exitShares;
      if(price>0&&price<1&&Number.isFinite(exit))earlyExitTrades.push({price,outcome:exit>=price?1:0,allInEntry:price+.0025,netExitOrOutcome:Math.max(0,exit-.0025),quantity:lot.exitShares,eventKey:lot.eventSlug??lot.conditionId,occurredAt:lot.closedAt});
      continue;
    }
    if (outcome === 'unresolved') { unresolved += 1; continue; }
    const price = lot.remainingCost / lot.remainingShares;
    if (!(price > 0 && price < 1)) continue;
    heldToResolution += 1;
    resolvedTrades.push({
      price,
      outcome: outcome === 'won' ? 1 : 0,
      // Legs of one event are one correlated opinion, collapsed by the estimator.
      eventKey: lot.eventSlug ?? lot.conditionId,
      quantity: lot.remainingShares,
      allInEntry: price+.0025,
      occurredAt: now,
    });
  }

  if (exitedEarly) notes.push(`${exitedEarly} positions were exited before resolution and carry no binary outcome.`);
  if (unresolved) notes.push(`${unresolved} markets are still pending or could not be read.`);
  notes.push('Reconstructed from public activity; entry is the volume-weighted average of buys.');
  return {
    address: address.toLowerCase(),
    fetchedAt: new Date(now).toISOString(),
    resolvedTrades,
    earlyExitTrades,
    assetsSeen: considered.length,
    assetsHeldToResolution: heldToResolution,
    assetsExitedBeforeResolution: exitedEarly,
    assetsUnresolved: unresolved,
    notes,
  };
}
