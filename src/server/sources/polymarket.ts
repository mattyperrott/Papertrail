import type { SourcePosition, SourceTrade, TraderCandidate } from '../../shared/types.js';
import { asRecord, fetchJson, numberFrom, stringFrom } from '../lib/http.js';
import { finiteNumber, informationalPrice, sourceBoolean, uniqueTrades, validateTrade, walletAddress } from './normalization.js';

const DATA_API = 'https://data-api.polymarket.com';
const LEADERBOARD_PAGE_SIZE = 50;
const DISCOVERY_PERIODS = ['DAY', 'WEEK', 'MONTH'] as const;

type DiscoveryPeriod = typeof DISCOVERY_PERIODS[number];

export class PolymarketSource {
  private async leaderboardPage(
    category: string,
    period: DiscoveryPeriod,
    offset: number,
  ): Promise<TraderCandidate[]> {
    const params = new URLSearchParams({
      category,
      timePeriod: period,
      orderBy: 'PNL',
      limit: String(LEADERBOARD_PAGE_SIZE),
      offset: String(offset),
    });
    const rows = await fetchJson<unknown[]>(`${DATA_API}/v1/leaderboard?${params}`);

    if (!Array.isArray(rows)) throw new Error('Invalid Polymarket leaderboard payload');
    return rows.filter((raw) => walletAddress(asRecord(raw).proxyWallet)).map((raw) => {
      const row = asRecord(raw);
      return {
        address: stringFrom(row.proxyWallet).toLowerCase(),
        name: stringFrom(row.userName).trim() || 'Anonymous trader',
        avatar: stringFrom(row.profileImage) || undefined,
        provider: 'polymarket' as const,
        rank: numberFrom(row.rank),
        pnl: numberFrom(row.pnl),
        volume: numberFrom(row.vol),
        roi: null,
        winRate: null,
        trades: null,
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
        leaderboardPeriods: [period],
      };
    });
  }

  async leaderboard(category: string, _period: string, limit: number): Promise<TraderCandidate[]> {
    const target = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 500, 500));
    const discovered = new Map<string, TraderCandidate>();
    const exhausted = new Set<DiscoveryPeriod>();

    // Pull equal pages from each horizon so short-term activity is not buried by
    // a monthly-only P&L ranking. The map preserves the earliest (shortest-period)
    // appearance while recording every leaderboard on which a wallet appears.
    for (let offset = 0; offset <= 1000 && discovered.size < target && exhausted.size < DISCOVERY_PERIODS.length; offset += LEADERBOARD_PAGE_SIZE) {
      const periods = DISCOVERY_PERIODS.filter((period) => !exhausted.has(period));
      const pages = await Promise.allSettled(
        periods.map((period) => this.leaderboardPage(category, period, offset)),
      );
      let anyPageSucceeded = false;
      const beforeCount = discovered.size;
      const fulfilled = pages.filter((page) => page.status === 'fulfilled');
      if (!fulfilled.length && discovered.size === 0) throw new Error('All Polymarket leaderboard requests failed');
      pages.forEach((result, index) => {
        const period = periods[index];
        if (result.status === 'rejected') {
          exhausted.add(period);
          return;
        }
        anyPageSucceeded = true;
        if (result.value.length < LEADERBOARD_PAGE_SIZE) exhausted.add(period);
        for (const candidate of result.value) {
          const existing = discovered.get(candidate.address);
          if (existing) {
            existing.leaderboardPeriods = Array.from(new Set([
              ...(existing.leaderboardPeriods ?? []),
              period,
            ]));
            existing.rank = Math.min(existing.rank, candidate.rank);
            // Prefer the broader-period figures when the wallet appears on more
            // than one list; Polymarket's period P&L values must not be summed.
            if (period === 'MONTH') {
              existing.pnl = candidate.pnl;
              existing.volume = candidate.volume;
            }
          } else if (discovered.size < target) {
            discovered.set(candidate.address, candidate);
          }
        }
      });
      if (!anyPageSucceeded || (offset > 0 && discovered.size === beforeCount)) break;
    }

    return [...discovered.values()].slice(0, target);
  }

  /** Rows dropped by the most recent lenient normalization. */
  lastSkippedRows = 0;

  /**
   * @param mode `strict` rejects the whole payload if any row is malformed, and
   * is required for anything that can cause a trade: acting on a tape we cannot
   * fully parse is how a bad fill happens. `lenient` skips the offending rows and
   * is for read-only statistics, where one unparseable historical row should not
   * discard a wallet's entire record. A wallet mismatch always throws in both
   * modes, because that means the API answered about somebody else.
   */
  private normalizeActivity(rows: unknown, address: string, mode: 'strict' | 'lenient' = 'strict'): SourceTrade[] {
    if (!Array.isArray(rows)) throw new Error('Invalid Polymarket activity payload');
    if (mode === 'lenient') this.lastSkippedRows = 0;
    const reject = (message: string): null => {
      if (mode === 'strict') throw new Error(message);
      this.lastSkippedRows += 1;
      return null;
    };
    return uniqueTrades(rows.map((raw): SourceTrade | null => {
      const row = asRecord(raw);
      const type = stringFrom(row.type).toUpperCase();
      const side = stringFrom(row.side).toUpperCase();
      if (type !== 'TRADE') return null;
      if (side !== 'BUY' && side !== 'SELL') return reject('Invalid Polymarket trade side');
      const suppliedWallet = walletAddress(row.proxyWallet);
      if (row.proxyWallet !== undefined && suppliedWallet !== address.toLowerCase()) throw new Error('Polymarket activity wallet mismatch');
      const shares = finiteNumber(row.size) ?? NaN;
      const price = finiteNumber(row.price) ?? NaN;
      const suppliedNotional = finiteNumber(row.usdcSize);
      const trade = validateTrade({
        traderAddress: address.toLowerCase(),
        traderName: stringFrom(row.name, stringFrom(row.pseudonym, 'Anonymous trader')),
        timestamp: finiteNumber(row.timestamp) ?? NaN,
        side,
        asset: stringFrom(row.asset),
        conditionId: stringFrom(row.conditionId),
        title: stringFrom(row.title, 'Unknown market'),
        outcome: stringFrom(row.outcome).trim() || (sourceBoolean(row.isCombo) ? 'Combo' : 'Unknown'),
        eventSlug: stringFrom(row.eventSlug) || undefined,
        price,
        shares,
        notional: row.usdcSize === undefined ? shares * price : suppliedNotional ?? NaN,
        transactionHash: stringFrom(row.transactionHash).toLowerCase() || undefined,
        provider: 'polymarket',
        isCombo: sourceBoolean(row.isCombo),
      });
      if (!trade) return reject('Invalid or inconsistent Polymarket trade economics');
      return trade;
    }).filter((trade): trade is SourceTrade => trade !== null));
  }

  async activity(address: string, limit = 100): Promise<SourceTrade[]> {
    if (!walletAddress(address)) throw new Error('Invalid trader wallet');
    const params = new URLSearchParams({ user: address, limit: String(Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, 500))),
      type: 'TRADE', sortBy: 'TIMESTAMP', sortDirection: 'DESC' });
    // Skip a malformed row rather than aborting the page. Failing closed on the
    // whole response was strictly worse than failing closed on the row: the bad
    // row is still never acted on, but discarding the good ones with it stopped
    // live copying entirely and, after three such failures, force-paused the
    // engine. Rows that fail validation never reach the paper engine either way.
    return this.normalizeActivity(await fetchJson<unknown>(`${DATA_API}/activity?${params}`), address, 'lenient')
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  }

  /** Read-only history for expectancy statistics. Never feeds the signal path. */
  async activityForAnalysis(address: string, limit = 500): Promise<{ trades: SourceTrade[]; skipped: number }> {
    if (!walletAddress(address)) throw new Error('Invalid trader wallet');
    const params = new URLSearchParams({ user: address, limit: String(Math.max(1, Math.min(Math.floor(limit), 500))),
      type: 'TRADE', sortBy: 'TIMESTAMP', sortDirection: 'DESC' });
    const trades = this.normalizeActivity(await fetchJson<unknown>(`${DATA_API}/activity?${params}`), address, 'lenient');
    return { trades, skipped: this.lastSkippedRows };
  }

  /** Fully drain a fixed time window before the caller advances its watermark.
   * A saturated API offset budget or malformed page is a failure, never a partial
   * success. The caller can retain its cursor and alert/retry with smaller windows.
   */
  async activitySince(address: string, sinceSeconds: number, mode: 'strict' | 'lenient' = 'strict', untilSeconds?: number): Promise<SourceTrade[]> {
    if (!walletAddress(address) || !Number.isFinite(sinceSeconds) || sinceSeconds < 0) throw new Error('Invalid activity cursor');
    const start = Math.max(1, Math.floor(sinceSeconds));
    // A bounded end lets a caller walk a long history in chunks that each stay
    // inside the endpoint's row budget, instead of failing the whole window.
    const end = Math.min(Math.floor(Date.now() / 1000), Math.floor(untilSeconds ?? Number.POSITIVE_INFINITY));
    if (start > end) return [];
    const found = new Map<string, SourceTrade>();
    for (let offset = 0; offset <= 5000; offset += 500) {
      const params = new URLSearchParams({ user: address, limit: '500', offset: String(offset),
        type: 'TRADE', start: String(start), end: String(end), sortBy: 'TIMESTAMP', sortDirection: 'ASC' });
      const rows = await fetchJson<unknown>(`${DATA_API}/activity?${params}`);
      if (!Array.isArray(rows)) throw new Error('Invalid Polymarket activity payload');
      const trades = this.normalizeActivity(rows, address, mode);
      const beforeCount = found.size;
      for (const trade of trades) {
        if (trade.timestamp < start || trade.timestamp > end) throw new Error('Activity endpoint returned a row outside the requested window');
        found.set(trade.id, trade);
      }
      if (rows.length < 500) return [...found.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
      if (found.size === beforeCount) throw new Error('Activity pagination repeated a full page; cursor retained');
    }
    throw new Error('Activity window exceeds the 5500-row API budget; cursor retained');
  }

  async positions(address: string, limit = 500): Promise<SourcePosition[]> {
    if (!walletAddress(address)) throw new Error('Invalid trader wallet');
    const pageSize = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 500, 500));
    const found = new Map<string, SourcePosition>();
    for (let offset = 0; offset <= 10000; offset += pageSize) {
      const params = new URLSearchParams({ user: address, limit: String(pageSize), offset: String(offset),
        // Dust below one share cannot be mirrored and is what pushes a prolific
        // wallet past the offset budget; the Polymarket UI hides it at this threshold too.
        sizeThreshold: '1', includeArchived: 'true', sortBy: 'TITLE', sortDirection: 'ASC' });
      const rows = await fetchJson<unknown>(`${DATA_API}/positions?${params}`);
      if (!Array.isArray(rows)) throw new Error('Invalid Polymarket positions payload');
      const beforeCount = found.size;
      for (const raw of rows) {
        const row = asRecord(raw);
        const asset = stringFrom(row.asset);
        const conditionId = stringFrom(row.conditionId);
        const size = finiteNumber(row.size);
        const price = finiteNumber(row.curPrice);
        if (!asset || !conditionId || size === undefined || size < 0
          || price === undefined || price < 0 || price > 1 || !Number.isFinite(size * price)) {
          throw new Error('Invalid Polymarket position economics');
        }
        // The engine values, marks and exits on size x curPrice alone; avgPrice and
        // cashPnl are informational (entry-drift guard, display). The upstream
        // emits negative averages on some short-lived crypto markets, and because
        // one bad row aborted the whole fetch that silenced every signal from the
        // wallet. Consumers already treat a non-finite basis as unknown.
        const avgPrice = informationalPrice(row.avgPrice);
        const pnl = finiteNumber(row.cashPnl) ?? NaN;
        if (row.proxyWallet !== undefined && walletAddress(row.proxyWallet) !== address.toLowerCase()) throw new Error('Polymarket position wallet mismatch');
        const suppliedValue = finiteNumber(row.currentValue);
        // A cross-check on a third-party derived figure, not a source of truth: the
        // engine values every position as size x price itself. A part-per-million
        // bound was tight enough to trip on the upstream's own rounding and float
        // representation, and because one bad row aborts the whole fetch that took
        // out marking and risk exits for the entire wallet. One cent or a tenth of
        // a percent still catches genuinely wrong data.
        if (row.currentValue !== undefined && (suppliedValue === undefined || Math.abs(suppliedValue - size * price) > Math.max(0.01, size * price * 0.001))) {
          throw new Error('Inconsistent Polymarket position valuation');
        }
        found.set(asset, {
          traderAddress: address.toLowerCase(), asset, conditionId,
          title: stringFrom(row.title, 'Unknown market'),
          outcome: stringFrom(row.outcome).trim() || (sourceBoolean(row.isCombo) ? 'Combo' : 'Unknown'),
          size, avgPrice, currentPrice: price, currentValue: size * price, pnl,
          redeemable: sourceBoolean(row.redeemable),
          eventSlug: stringFrom(row.eventSlug) || undefined, endDate: stringFrom(row.endDate) || undefined,
          isCombo: sourceBoolean(row.isCombo),
        });
      }
      if (rows.length < pageSize) return [...found.values()];
      if (found.size === beforeCount) throw new Error('Positions pagination repeated a full page');
    }
    throw new Error('Positions exceed the API offset budget; incomplete snapshot rejected');
  }
}
