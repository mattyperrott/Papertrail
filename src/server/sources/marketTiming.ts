import type { PaperPosition, ResolutionStatus, TimingSource } from '../../shared/types.js';
import { asArray, asRecord, fetchJson, stringFrom } from '../lib/http.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const SCHEDULE_CACHE_MS = 5 * 60_000;
const RESOLVED_CACHE_MS = 24 * 60 * 60_000;
const RESULT_RECHECK_MS = 5 * 60_000;

export interface MarketTiming {
  expectedEndAt?: string;
  gameStartAt?: string;
  resolvedAt?: string;
  resolutionStatus: ResolutionStatus;
  timingSource: TimingSource;
  result?: 'won' | 'lost' | 'void' | 'unknown';
  resolvedPrice?: number;
}

interface CachedTiming {
  expiresAt: number;
  value: MarketTiming;
}

function normalizeTimestamp(value: unknown, endOfDayForDate = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDayForDate ? `${raw}T23:59:59Z` : raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function jsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function deriveTitleTiming(title: string, now = Date.now()): MarketTiming {
  const dates = [...title.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)]
    .map((match) => normalizeTimestamp(match[1], true))
    .filter((value): value is string => Boolean(value));
  const expectedEndAt = dates.sort().at(-1);
  if (!expectedEndAt) {
    return { resolutionStatus: 'unknown', timingSource: 'unavailable' };
  }
  return {
    expectedEndAt,
    resolutionStatus: Date.parse(expectedEndAt) <= now ? 'awaiting-result' : 'scheduled',
    timingSource: 'title-estimate',
  };
}

export function derivePositionTiming(
  position: Pick<PaperPosition, 'title' | 'openedAt'>,
  now = Date.now(),
): MarketTiming {
  const fromTitle = deriveTitleTiming(position.title, now);
  if (fromTitle.resolutionStatus !== 'unknown') return fromTitle;
  const looksLikeSport = /\bvs\.?\b|both teams to score|\bo\/u\b|\bwin on\b/i.test(position.title);
  const openedAt = Date.parse(position.openedAt);
  if (!looksLikeSport || !Number.isFinite(openedAt)) return fromTitle;
  const expectedEndAt = new Date(openedAt + 24 * 60 * 60_000).toISOString();
  return {
    expectedEndAt,
    resolutionStatus: Date.parse(expectedEndAt) <= now ? 'awaiting-result' : 'scheduled',
    timingSource: 'activity-estimate',
  };
}

export function resultForAsset(market: Record<string, unknown>, asset: string): 'won' | 'lost' | 'void' | 'unknown' {
  const price = resolvedPriceForAsset(market, asset);
  if (price === undefined) return 'unknown';
  if (price === 1) return 'won';
  if (price === 0) return 'lost';
  // A resolved market whose token redeems strictly between 0 and 1 was voided
  // (a retired tennis match resolves every market 50/50). Polymarket pays the
  // resolved price per share; nobody won or lost. Left as 'unknown' such a
  // position never settled, its mark could never refresh, and the stale-mark
  // gate then blocked every new entry portfolio-wide for two days.
  return 'void';
}

/** The token's redemption price once the market is resolved, else undefined.
 * Only two shapes count as a resolution: a binary 1/0, or an equal split across
 * every outcome summing to 1 (the void/refund case). Anything else — 0.995 on a
 * market whose status flipped before its prices did — is still a tradable
 * price, and settling on it would manufacture a payout that never happened. */
export function resolvedPriceForAsset(market: Record<string, unknown>, asset: string): number | undefined {
  const tokenIds = jsonStrings(market.clobTokenIds);
  const prices = jsonStrings(market.outcomePrices).map(Number);
  const index = tokenIds.indexOf(asset);
  if (index < 0 || !prices.every((price) => Number.isFinite(price) && price >= 0 && price <= 1)) return undefined;
  const price = prices[index];
  if (price === 1 || price === 0) return price;
  const equalSplit = prices.length > 1
    && prices.every((other) => Math.abs(other - price) < 1e-9)
    && Math.abs(prices.reduce((sum, other) => sum + other, 0) - 1) < 1e-6;
  return equalSplit ? price : undefined;
}

export function timingFromMarket(
  market: Record<string, unknown>,
  event: Record<string, unknown>,
  asset: string,
  now: number,
): MarketTiming {
  const expectedEndAt = normalizeTimestamp(market.endDate, true)
    ?? normalizeTimestamp(event.endDate, true);
  const gameStartAt = normalizeTimestamp(market.gameStartTime);
  const resolvedAt = normalizeTimestamp(market.umaEndDate);
  const resolutionText = stringFrom(market.umaResolutionStatus).toLowerCase();
  const resolved = resolutionText === 'resolved';
  const resolutionStatus: ResolutionStatus = resolved
    ? 'resolved'
    : expectedEndAt && Date.parse(expectedEndAt) <= now
      ? 'awaiting-result'
      : expectedEndAt
        ? 'scheduled'
        : 'unknown';
  return {
    expectedEndAt,
    gameStartAt,
    resolvedAt,
    resolutionStatus,
    timingSource: 'polymarket',
    result: resolved ? resultForAsset(market, asset) : undefined,
    resolvedPrice: resolved ? resolvedPriceForAsset(market, asset) : undefined,
  };
}

function applyTiming(position: PaperPosition, timing: MarketTiming, checkedAt?: number) {
  if (timing.timingSource !== 'polymarket' && position.timingSource === 'polymarket') {
    if (checkedAt !== undefined) position.nextVerificationAt = new Date(checkedAt + RESULT_RECHECK_MS).toISOString();
    return;
  }
  Object.assign(position, timing);
  if (checkedAt !== undefined && timing.timingSource === 'polymarket') {
    position.lastVerifiedAt = new Date(checkedAt).toISOString();
    const expectedEnd = Date.parse(timing.expectedEndAt ?? '');
    position.nextVerificationAt = timing.resolutionStatus !== 'resolved'
      && Number.isFinite(expectedEnd)
      && expectedEnd <= checkedAt
      ? new Date(checkedAt + RESULT_RECHECK_MS).toISOString()
      : undefined;
  }
  if (timing.resolutionStatus === 'resolved' && (timing.result === 'won' || timing.result === 'lost' || timing.result === 'void')) {
    position.nextVerificationAt = undefined;
    position.currentPrice = timing.result === 'won' ? 1 : timing.result === 'lost' ? 0 : timing.resolvedPrice ?? position.currentPrice;
    position.currentValue = position.shares * position.currentPrice;
    position.unrealizedPnl = position.currentValue - position.costBasis;
    position.updatedAt = new Date().toISOString();
  }
}

async function mapLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await task(items[cursor++]);
  });
  await Promise.all(workers);
}

export class MarketTimingResolver {
  private readonly cache = new Map<string, CachedTiming>();

  async enrich(positions: PaperPosition[], force = false) {
    const groups = new Map<string, PaperPosition[]>();
    for (const position of positions) {
      if (position.isCombo || /\bcombo\b/i.test(position.outcome)) continue;
      const key = position.eventSlug ? `event:${position.eventSlug}` : `condition:${position.conditionId}`;
      groups.set(key, [...(groups.get(key) ?? []), position]);
    }

    await mapLimited([...groups.entries()], 4, async ([key, grouped]) => {
      if (!force && grouped.every((position) => {
        const cached = this.cache.get(`${key}:${position.conditionId}:${position.asset}`);
        return cached && cached.expiresAt > Date.now();
      })) {
        for (const position of grouped) applyTiming(position, this.cache.get(`${key}:${position.conditionId}:${position.asset}`)!.value);
        return;
      }
      if (key.startsWith('event:')) {
        const slug = grouped[0].eventSlug;
        if (!slug) return;
        let event: Record<string, unknown> | undefined;
        try {
          event = asRecord(await fetchJson<unknown>(
            `${GAMMA_API}/events/slug/${encodeURIComponent(slug)}`,
          ));
        } catch {
          event = undefined;
        }
        const markets = asArray(event?.markets).map(asRecord);
        for (const position of grouped) {
          const cacheKey = `${key}:${position.conditionId}:${position.asset}`;
          const cached = this.cache.get(cacheKey);
          if (!force && cached && cached.expiresAt > Date.now()) {
            applyTiming(position, cached.value);
            continue;
          }
          const market = markets.find((candidate) =>
            stringFrom(candidate.conditionId).toLowerCase() === position.conditionId.toLowerCase(),
          );
          const expectedEndAt = normalizeTimestamp(event?.endDate, true);
          const timing = market && event
            ? timingFromMarket(market, event, position.asset, Date.now())
            : expectedEndAt && event
              ? {
                  expectedEndAt,
                  resolutionStatus: Date.parse(expectedEndAt) <= Date.now() ? 'awaiting-result' as const : 'scheduled' as const,
                  timingSource: 'polymarket' as const,
                  result: 'unknown' as const,
                }
              : derivePositionTiming(position);
          this.setCached(cacheKey, timing);
          applyTiming(position, timing, Date.now());
        }
        return;
      }
      for (const position of grouped) {
        const cacheKey = `${key}:${position.conditionId}:${position.asset}`;
        const cached = this.cache.get(cacheKey);
        if (!force && cached && cached.expiresAt > Date.now()) {
          applyTiming(position, cached.value);
          continue;
        }
        const timing = await this.resolveCondition(position).catch(() => derivePositionTiming(position));
        this.setCached(cacheKey, timing);
        applyTiming(position, timing, Date.now());
      }
    });
  }

  private async resolveCondition(position: PaperPosition): Promise<MarketTiming> {
    const params = new URLSearchParams({ condition_ids: position.conditionId });
    const rows = asArray(await fetchJson<unknown>(`${GAMMA_API}/markets?${params}`)).map(asRecord);
    const market = rows.find((candidate) =>
      stringFrom(candidate.conditionId).toLowerCase() === position.conditionId.toLowerCase(),
    );
    return market
      ? timingFromMarket(market, {}, position.asset, Date.now())
      : derivePositionTiming(position);
  }

  private setCached(key: string, timing: MarketTiming) {
    if (this.cache.size > 2000) {
      for (const [entry, cached] of this.cache) if (cached.expiresAt <= Date.now()) this.cache.delete(entry);
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, {
      value: timing,
      expiresAt: Date.now() + (timing.resolutionStatus === 'resolved' ? RESOLVED_CACHE_MS : SCHEDULE_CACHE_MS),
    });
  }
}
