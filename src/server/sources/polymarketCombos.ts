import type { PaperPosition } from '../../shared/types.js';
import { asArray, asRecord, fetchJson, numberFrom, stringFrom } from '../lib/http.js';

const DATA_API = 'https://data-api.polymarket.com';
export const COMBO_RECHECK_MS = 5 * 60_000;

type ComboSide = 'YES' | 'NO';

export interface ComboResolution {
  side?: ComboSide;
  result?: 'won' | 'lost';
  expectedEndAt?: string;
  resolvedAt?: string;
}

function normalizedDate(value: unknown, endOfDayForDate = false) {
  const raw = stringFrom(value).trim();
  if (!raw) return undefined;
  const normalized = endOfDayForDate && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T23:59:59Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function latestDate(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function conditionMatches(row: Record<string, unknown>, position: PaperPosition) {
  return stringFrom(row.combo_condition_id).toLowerCase() === position.conditionId.toLowerCase();
}

function legsFrom(row?: Record<string, unknown>) {
  return asArray(row?.legs).map(asRecord);
}

function timingFromLegs(legs: Record<string, unknown>[]) {
  const expectedEndAt = latestDate(legs.map((leg) => {
    const market = asRecord(leg.market);
    return normalizedDate(market.end_date, true);
  }));
  const resolvedAt = latestDate(legs.map((leg) => normalizedDate(leg.leg_resolved_at)));
  return { expectedEndAt, resolvedAt };
}

export function resolveComboPosition(
  position: PaperPosition,
  positionRows: Record<string, unknown>[],
  activityRows: Record<string, unknown>[],
): ComboResolution {
  const officialPosition = positionRows.find((row) =>
    conditionMatches(row, position)
      && stringFrom(row.combo_position_id) === position.asset,
  );
  const matchingActivity = activityRows.filter((row) => conditionMatches(row, position));
  const redeem = matchingActivity.find((row) =>
    stringFrom(row.type).toUpperCase() === 'REDEEM'
      && stringFrom(row.combo_position_id) === position.asset
      && numberFrom(row.payout_usdc) > 0,
  );
  const lifecycle = officialPosition ?? redeem ?? matchingActivity[0];
  const legs = legsFrom(lifecycle);
  const timing = timingFromLegs(legs);

  if (officialPosition) {
    const rawSide = stringFrom(officialPosition.side).toUpperCase();
    const side = rawSide === 'YES' || rawSide === 'NO' ? rawSide : undefined;
    const status = stringFrom(officialPosition.status).toUpperCase();
    const result = status === 'RESOLVED_WIN'
      ? 'won' as const
      : status === 'RESOLVED_LOSS'
        ? 'lost' as const
        : undefined;
    return {
      side,
      result,
      expectedEndAt: timing.expectedEndAt,
      resolvedAt: normalizedDate(officialPosition.resolved_at) ?? timing.resolvedAt,
    };
  }

  // A positive redemption amount does not prove a $1 payout per copied share.
  // Leg statuses alone do not cover void/refund contracts or token denomination.
  // Keep legacy positions pending until the matching token has an explicit result.
  return { ...timing, side: position.comboSide };
}

function isCombo(position: PaperPosition) {
  return position.isCombo || /\bcombo\b/i.test(position.outcome);
}

function applyResolution(position: PaperPosition, resolution: ComboResolution, checkedAt: number) {
  position.isCombo = true;
  position.timingSource = 'polymarket-combo';
  position.lastVerifiedAt = new Date(checkedAt).toISOString();
  if (resolution.side) {
    position.comboSide = resolution.side;
    position.outcome = `${resolution.side} Combo`;
  }
  if (resolution.expectedEndAt) position.expectedEndAt = resolution.expectedEndAt;
  if (resolution.resolvedAt) position.resolvedAt = resolution.resolvedAt;

  if (resolution.result) {
    position.result = resolution.result;
    position.resolutionStatus = 'resolved';
    position.nextVerificationAt = undefined;
    position.currentPrice = resolution.result === 'won' ? 1 : 0;
    position.currentValue = position.shares * position.currentPrice;
    position.unrealizedPnl = position.currentValue - position.costBasis;
    position.updatedAt = new Date(checkedAt).toISOString();
    return;
  }

  const expectedEnd = Date.parse(position.expectedEndAt ?? '');
  position.resolutionStatus = Number.isFinite(expectedEnd)
    ? expectedEnd <= checkedAt ? 'awaiting-result' : 'scheduled'
    : 'unknown';
  position.nextVerificationAt = expectedEnd <= checkedAt
    ? new Date(checkedAt + COMBO_RECHECK_MS).toISOString()
    : undefined;
}

async function fetchPages(
  path: '/v1/positions/combos' | '/v1/activity/combos',
  key: 'combos' | 'activity',
  user: string,
  conditionIds: string[],
) {
  const rows: Record<string, unknown>[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({
      user,
      market_id: conditionIds.join(','),
      limit: '500',
    });
    if (cursor) params.set('cursor', cursor);
    const payload = asRecord(await fetchJson<unknown>(`${DATA_API}${path}?${params}`));
    rows.push(...asArray(payload[key]).map(asRecord));
    const pagination = asRecord(payload.pagination);
    if (!pagination.has_more) break;
    cursor = stringFrom(pagination.next_cursor);
    if (!cursor || page === 9) throw new Error('Incomplete combo lifecycle pagination');
  }
  return rows;
}

export class PolymarketComboResolver {
  async enrich(positions: PaperPosition[], force = false) {
    const checkedAt = Date.now();
    const due = positions.filter(isCombo).filter((position) => {
      if (force || !position.lastVerifiedAt) return true;
      return checkedAt - Date.parse(position.lastVerifiedAt) >= COMBO_RECHECK_MS;
    });
    const grouped = new Map<string, PaperPosition[]>();
    for (const position of due) {
      const wallet = position.traderAddress.toLowerCase();
      grouped.set(wallet, [...(grouped.get(wallet) ?? []), position]);
    }

    await Promise.all([...grouped.entries()].map(async ([wallet, walletPositions]) => {
      const conditionIds = [...new Set(walletPositions.map((position) => position.conditionId))];
      try {
        const [positionRows, activityRows] = await Promise.all([
          fetchPages('/v1/positions/combos', 'combos', wallet, conditionIds),
          fetchPages('/v1/activity/combos', 'activity', wallet, conditionIds),
        ]);
        for (const position of walletPositions) {
          applyResolution(position, resolveComboPosition(position, positionRows, activityRows), checkedAt);
        }
      } catch {
        for (const position of walletPositions) {
          position.nextVerificationAt = new Date(checkedAt + COMBO_RECHECK_MS).toISOString();
        }
      }
    }));

    return due.length;
  }
}
