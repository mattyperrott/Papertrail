import type { SourcePosition, SourceTrade, TraderCandidate } from '../../shared/types.js';
import { asRecord, fetchJson, numberFrom, stringFrom } from '../lib/http.js';
import { finiteNumber, informationalPrice, sourceBoolean, uniqueTrades, validateTrade, walletAddress } from './normalization.js';

/** Largest page the Arkham leaderboard endpoint serves. */
const ARKHAM_PAGE = 200;

export class ArkhamSource {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.arkm.com',
  ) {}

  private headers() {
    return { 'API-Key': this.apiKey };
  }

  /** Discovery across the daily, weekly and monthly boards, paginated up to
   * `limit` distinct wallets. A single 200-row page of one period — the previous
   * behaviour — was less than half the universe the Polymarket path scans, so
   * switching provider silently starved selection. */
  async leaderboard(_period: string, limit: number): Promise<TraderCandidate[]> {
    const periods: Array<['DAY' | 'WEEK' | 'MONTH', string]> = [['DAY', '1d'], ['WEEK', '1w'], ['MONTH', '1m']];
    const discovered = new Map<string, TraderCandidate>();
    const target = Math.max(1, Math.floor(limit));
    for (const [label, apiPeriod] of periods) {
      for (let offset = 0; offset < target; offset += ARKHAM_PAGE) {
        const page = await this.leaderboardPage(apiPeriod, Math.min(ARKHAM_PAGE, target - offset), offset);
        for (const candidate of page) {
          const existing = discovered.get(candidate.address);
          if (existing) {
            existing.leaderboardPeriods = [...new Set([...(existing.leaderboardPeriods ?? []), label])];
            if (candidate.rank < existing.rank) existing.rank = candidate.rank;
            if (Number.isFinite(candidate.pnl) && (!Number.isFinite(existing.pnl) || candidate.pnl > existing.pnl)) existing.pnl = candidate.pnl;
          } else discovered.set(candidate.address, { ...candidate, leaderboardPeriods: [label] });
        }
        if (page.length < Math.min(ARKHAM_PAGE, target - offset)) break;
      }
    }
    return [...discovered.values()].slice(0, target);
  }

  private async leaderboardPage(apiPeriod: string, limit: number, offset: number): Promise<TraderCandidate[]> {
    const params = new URLSearchParams({ period: apiPeriod, order: 'desc', limit: String(limit), offset: String(offset) });
    const payload = asRecord(
      await fetchJson<unknown>(`${this.baseUrl}/polymarket/leaderboard?${params}`, {
        headers: this.headers(),
      }),
    );

    if (!Array.isArray(payload.entries)) throw new Error('Invalid Arkham leaderboard payload');
    return payload.entries.filter((raw) => walletAddress(asRecord(raw).userAddress)).map((raw) => {
      const row = asRecord(raw);
      const won = finiteNumber(row.tokensWon);
      const total = finiteNumber(row.tokensTotal);
      return {
        address: stringFrom(row.userAddress).toLowerCase(),
        name: stringFrom(row.displayName, 'Anonymous trader'),
        avatar: stringFrom(row.profileImageUrl) || undefined,
        provider: 'arkham' as const,
        rank: numberFrom(row.rank),
        pnl: finiteNumber(row.periodPnl) ?? NaN, // Rewards are not trading skill or copyable P&L.
        volume: 0,
        roi: null,
        winRate: null, // Token quantities are not independent settled outcomes.
        trades: null, // Fill count is not the settled sample size.
        marketsWon: won,
        marketsTotal: total,
        score: 0,
        watched: false,
        selected: false,
        verification: {
          provider: 'polymarketscan' as const,
          checkedAt: new Date(0).toISOString(),
          url: '',
          status: 'unavailable' as const,
          notes: ['Awaiting PolymarketScan cross-check'],
        },
        reasons: [],
        openPositions: 0,
      };
    });
  }

  async activity(addresses: string[], limit = 500): Promise<SourceTrade[]> {
    const params = new URLSearchParams();
    addresses.forEach((address) => params.append('userAddresses', address));
    params.set('eventType', 'trade');
    params.set('limit', String(Math.min(limit, 500)));
    params.set('sortBy', 'time');
    params.set('sortOrder', 'desc');
    const payload = asRecord(
      await fetchJson<unknown>(`${this.baseUrl}/polymarket/activity?${params}`, {
        headers: this.headers(),
      }),
    );
    if (!Array.isArray(payload.events)) throw new Error('Invalid Arkham activity payload');
    const requested = new Set(addresses.map((address) => address.toLowerCase()));
    return uniqueTrades(payload.events.map((raw): SourceTrade | null => {
      const row = asRecord(raw);
      const direction = stringFrom(row.direction).toUpperCase();
      if (direction !== 'BUY' && direction !== 'SELL') return null;
      const shares = finiteNumber(row.size) ?? NaN;
      const notional = finiteNumber(row.notional) ?? NaN;
      const traderAddress = walletAddress(row.userAddress) ?? '';
      if (!requested.has(traderAddress)) throw new Error('Arkham activity wallet mismatch');
      const trade = validateTrade({
        traderAddress, traderName: traderAddress.slice(0, 8),
        timestamp: Math.floor(Date.parse(stringFrom(row.blockTimestamp)) / 1000),
        side: direction,
        asset: stringFrom(row.tokenAddress), conditionId: stringFrom(row.conditionId),
        title: stringFrom(row.question, 'Unknown market'), outcome: stringFrom(row.outcome, 'Unknown'),
        price: notional / shares, shares, notional,
        transactionHash: stringFrom(row.transactionHash).toLowerCase() || undefined,
        provider: 'arkham',
      });
      // Skip the row, never the batch. Arkham returns every requested wallet's
      // activity in one response, so aborting here would drop every signal for
      // every trader over a single unreconcilable row. The row itself is still
      // never acted on. A wallet mismatch above still fails closed: that means the
      // upstream answered about somebody else.
      if (!trade) return null;
      return trade;
    }).filter((trade): trade is SourceTrade => trade !== null));
  }

  async positions(address: string): Promise<SourcePosition[]> {
    const params = new URLSearchParams({ sortBy: 'value', sortOrder: 'desc', limit: '1000' });
    const payload = asRecord(
      await fetchJson<unknown>(`${this.baseUrl}/polymarket/positions/${address}?${params}`, {
        headers: this.headers(),
      }),
    );
    if (!Array.isArray(payload.positions)) throw new Error('Invalid Arkham positions payload');
    if (payload.positions.length >= 1000) throw new Error('Arkham position snapshot saturated; completeness unavailable');
    return payload.positions.map((raw) => {
      const row = asRecord(raw);
      const shares = finiteNumber(row.netPosition) ?? finiteNumber(row.shares) ?? NaN;
      const price = finiteNumber(row.lastPrice) ?? finiteNumber(row.price) ?? NaN;
      if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(price) || price < 0 || price > 1
        || !Number.isFinite(shares * price)) throw new Error('Invalid Arkham position economics');
      // Informational only, same as the Polymarket source: a bad average must not
      // discard the whole wallet snapshot.
      const avgPrice = informationalPrice(finiteNumber(row.averagePrice) ?? row.avgPrice);
      const token = asRecord(row.token);
      return {
        traderAddress: address.toLowerCase(),
        asset: stringFrom(row.tokenAddress, stringFrom(token.address)),
        conditionId: stringFrom(row.conditionId),
        title: stringFrom(row.question, stringFrom(row.title, 'Unknown market')),
        outcome: stringFrom(row.outcome, stringFrom(token.outcome, 'Unknown')),
        size: shares,
        avgPrice,
        currentPrice: price,
        currentValue: shares * price,
        pnl: numberFrom(row.unrealizedPnl),
        redeemable: sourceBoolean(row.redeemable),
      };
    });
  }
}
