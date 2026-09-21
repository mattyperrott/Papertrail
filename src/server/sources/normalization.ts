import { createHash } from 'node:crypto';
import type { SourceTrade } from '../../shared/types.js';

/** Unlike Number(null)/Number(''), missing numeric source data is not zero. */
export function finiteNumber(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

/** A reported average entry price the engine never trades on. Out-of-range or
 * missing values become NaN (which serializes as null) instead of rejecting the
 * row, so consumers must guard with Number.isFinite before using it. */
export function informationalPrice(value: unknown): number {
  const price = finiteNumber(value);
  return price === undefined || price < 0 || price > 1 ? NaN : price;
}

export const sourceBoolean = (value: unknown): boolean => value === true || value === 'true' || value === 1;
export const walletAddress = (value: unknown): string | undefined => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
  ? value.toLowerCase() : undefined;

/** Public activity does not expose a unique fill/log ID. Conservatively collapse
 * identical economic rows. Never add row offsets: reordering would replay fills.
 * Distinct identical fills require on-chain log reconciliation before live use.
 */
export function sourceTradeId(trade: Omit<SourceTrade, 'id'>): string {
  return `v2:${createHash('sha256').update(JSON.stringify([
    trade.traderAddress.toLowerCase(), trade.transactionHash?.toLowerCase() ?? '',
    trade.timestamp, trade.asset, trade.conditionId.toLowerCase(), trade.side,
    trade.shares, trade.notional,
  ])).digest('hex')}`;
}

export function validateTrade(trade: Omit<SourceTrade, 'id'>): SourceTrade | null {
  if (!walletAddress(trade.traderAddress) || !trade.asset || !trade.conditionId
    || !Number.isSafeInteger(trade.timestamp) || trade.timestamp <= 0
    || !Number.isFinite(trade.price) || trade.price <= 0 || trade.price >= 1
    || !Number.isFinite(trade.shares) || trade.shares <= 0
    || !Number.isFinite(trade.notional) || trade.notional <= 0
    || !Number.isFinite(trade.shares * trade.price)
    // The upstream reports usdcSize rounded, so it does not reconcile with
    // shares x price to a part per million. That bound rejected roughly a third of
    // real rows, and because one rejected row aborts the whole poll it silently
    // disabled live copying. A cent or a tenth of a percent still catches a
    // genuinely wrong notional while tolerating the upstream's own rounding.
    || Math.abs(trade.notional - trade.shares * trade.price) > Math.max(0.01, trade.notional * 0.001)) return null;
  return { ...trade, id: sourceTradeId(trade) };
}

export const uniqueTrades = (trades: SourceTrade[]): SourceTrade[] => [...new Map(trades.map((trade) => [trade.id, trade])).values()];
