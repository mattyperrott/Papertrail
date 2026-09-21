import type { RiskSettings, TradeSide } from '../shared/types.js';

export interface BookLevel { price: number; size: number }

/** Public order book and fee parameters; timestamps are milliseconds since epoch. */
export interface ExecutableQuote {
  asset: string;
  /** When this snapshot was obtained (REST response, or a live stream's clock). */
  capturedAt: number;
  /** The book's own last-change time. An unchanged book keeps this across polls,
   * which is what lets consumed depth carry over instead of being re-sold. */
  bookUpdatedAt?: number;
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize?: number;
  minOrderShares?: number;
  feeRate?: number;
  feeExponent?: number;
  /** Optional synthetic stress surcharge, in addition to the protocol fee. */
  feeBps?: number;
}

export interface ExecutionContext {
  quotes?: Record<string, ExecutableQuote>;
  sourcePositionsAsOf?: number;
  /** Reuse the context for a batch so the same displayed depth is not spent twice. */
  consumed?: Record<string, { bids: number[]; asks: number[] }>;
}

interface ExecutionLevel extends BookLevel { index: number }

export interface ExecutionPlan {
  asset: string;
  side: TradeSide;
  key: string;
  levels: ExecutionLevel[];
  mark: number;
  minOrderShares: number;
  feeRate: number;
  feeExponent: number;
  feeBps: number;
  model: 'order-book' | 'synthetic';
}

export interface ExecutionFill {
  shares: number;
  notional: number;
  fees: number;
  fillPrice: number;
  requestedShares: number;
  unfilledShares: number;
  consumed: Array<{ index: number; shares: number }>;
}

const finite = (value: number) => Number.isFinite(value);
const roundFee = (fee: number) => Math.round((fee + Number.EPSILON) * 100_000) / 100_000;
const floorShares = (shares: number) => Math.floor(shares * 1_000_000) / 1_000_000;

/** Dollar fee per share. The optional bps amount is a paper stress cost. */
export function feePerShare(price: number, feeRate: number, exponent = 1, feeBps = 0) {
  return feeRate * (price * (1 - price)) ** exponent + price * feeBps / 10_000;
}

export function validQuote(quote: ExecutableQuote | undefined, asset: string, now: number, maxAgeSeconds: number): quote is ExecutableQuote {
  if (!quote || quote.asset !== asset || !finite(quote.capturedAt)
    || quote.capturedAt > now + 1000 || now - quote.capturedAt > maxAgeSeconds * 1000) return false;
  if (!Array.isArray(quote.bids) || !Array.isArray(quote.asks)) return false;
  if (quote.tickSize !== undefined && (!finite(quote.tickSize) || quote.tickSize <= 0 || quote.tickSize >= 1)) return false;
  if (quote.minOrderShares !== undefined && (!finite(quote.minOrderShares) || quote.minOrderShares < 0)) return false;
  if (quote.feeRate === undefined || !finite(quote.feeRate) || quote.feeRate < 0 || quote.feeRate > 1) return false;
  if (quote.feeExponent !== undefined && (!finite(quote.feeExponent) || quote.feeExponent < 0 || quote.feeExponent > 10)) return false;
  if (quote.feeBps !== undefined && (!finite(quote.feeBps) || quote.feeBps < 0 || quote.feeBps > 1000)) return false;
  for (const level of [...quote.bids, ...quote.asks]) {
    if (!finite(level.price) || level.price <= 0 || level.price >= 1 || !finite(level.size) || level.size <= 0) return false;
    if (quote.tickSize && Math.abs(level.price / quote.tickSize - Math.round(level.price / quote.tickSize)) > 1e-7) return false;
  }
  const bid = Math.max(0, ...quote.bids.map((level) => level.price));
  const ask = Math.min(1, ...quote.asks.map((level) => level.price));
  return bid <= ask;
}

export function prepareExecution(
  asset: string,
  side: TradeSide,
  referencePrice: number,
  settings: RiskSettings,
  now: number,
  context: ExecutionContext,
  enforceSourceDrift = true,
): { plan: ExecutionPlan } | { reason: string } {
  const quote = context.quotes?.[asset];
  const maxAge = settings.maxQuoteAgeSeconds ?? 15;
  const strict = settings.requireExecutableQuotes ?? true;
  if (!validQuote(quote, asset, now, maxAge)) {
    // A malformed or stale supplied quote never authorizes a synthetic fallback.
    if (quote || strict) return { reason: 'Missing, stale, malformed, or unpriced-fee executable order book' };
    const price = referencePrice * (1 + (side === 'BUY' ? 1 : -1) * settings.slippageBps / 10_000);
    if (!finite(price) || price <= 0 || price >= 1) return { reason: 'Synthetic stress price is outside the tradable range' };
    return { plan: {
      asset, side, key: `synthetic:${asset}:${now}`, levels: [{ price, size: Number.MAX_SAFE_INTEGER, index: 0 }],
      mark: referencePrice, minOrderShares: 0, feeRate: 0, feeExponent: 1,
      feeBps: settings.feeBps ?? 0, model: 'synthetic',
    } };
  }

  const bookSide = side === 'BUY' ? 'asks' : 'bids';
  const key = `${asset}:${quote.bookUpdatedAt ?? quote.capturedAt}`;
  const used = context.consumed?.[key]?.[bookSide] ?? [];
  const participation = (settings.maxParticipationPct ?? 10) / 100;
  const levels = quote[bookSide]
    .map((level, index) => ({ ...level, size: Math.max(0, level.size * participation - (used[index] ?? 0)), index }))
    .sort((left, right) => side === 'BUY' ? left.price - right.price : right.price - left.price);
  const best = levels[0]?.price;
  if (best === undefined) return { reason: `No executable ${bookSide} liquidity` };
  const drift = (settings.maxPriceDriftBps ?? 200) / 10_000;
  if (enforceSourceDrift && (side === 'BUY' ? best > referencePrice * (1 + drift) : best < referencePrice * (1 - drift))) {
    return { reason: 'Executable price moved beyond the allowed adverse source-price drift' };
  }
  // An IOC-style limit bounds depth slippage as well as drift from the source event.
  const slippage = settings.slippageBps / 10_000;
  const limit = side === 'BUY'
    ? Math.min(best * (1 + slippage), enforceSourceDrift ? referencePrice * (1 + drift) : 1)
    : Math.max(best * (1 - slippage), enforceSourceDrift ? referencePrice * (1 - drift) : 0);
  const eligible = levels.filter((level) => level.size > 0 && (side === 'BUY' ? level.price <= limit + 1e-12 : level.price >= limit - 1e-12));
  if (!eligible.length) return { reason: 'Available depth or participation limit blocks the fill' };
  const bid = Math.max(0, ...quote.bids.map((level) => level.price));
  if (side === 'BUY' && bid <= 0) return { reason: 'No bid available to value and potentially exit the position' };
  return { plan: {
    asset, side, key, levels: eligible, mark: bid,
    minOrderShares: quote.minOrderShares ?? 0,
    feeRate: quote.feeRate!, feeExponent: quote.feeExponent ?? 1,
    feeBps: quote.feeBps ?? settings.feeBps ?? 0, model: 'order-book',
  } };
}

/** Preview a depth-limited fill without consuming any book state. */
export function simulateExecution(plan: ExecutionPlan, requestedShares: number, cashBudget = Number.MAX_VALUE): ExecutionFill {
  let remainingShares = Math.max(0, requestedShares);
  let remainingCash = cashBudget;
  let shares = 0;
  let notional = 0;
  let fees = 0;
  const consumed: ExecutionFill['consumed'] = [];
  for (const level of plan.levels) {
    const perShareFee = feePerShare(level.price, plan.feeRate, plan.feeExponent, plan.feeBps);
    const unitCost = level.price + perShareFee;
    let quantity = floorShares(Math.min(remainingShares, level.size, plan.side === 'BUY' ? remainingCash / unitCost : Number.MAX_VALUE));
    let fee = roundFee(quantity * perShareFee);
    if (plan.side === 'BUY' && quantity * level.price + fee > remainingCash) {
      quantity = floorShares(Math.max(0, quantity - (quantity * level.price + fee - remainingCash + 0.00001) / unitCost));
      fee = roundFee(quantity * perShareFee);
    }
    if (quantity <= 0 || (plan.side === 'SELL' && fee > quantity * level.price)) continue;
    shares += quantity;
    notional += quantity * level.price;
    fees += fee;
    remainingShares -= quantity;
    remainingCash -= quantity * level.price + fee;
    consumed.push({ index: level.index, shares: quantity });
    if (remainingShares < 0.000001 || (plan.side === 'BUY' && remainingCash < 0.000001)) break;
  }
  return { shares, notional, fees, fillPrice: shares > 0 ? notional / shares : 0,
    requestedShares, unfilledShares: Math.max(0, requestedShares - shares), consumed };
}

export function consumeExecution(plan: ExecutionPlan, fill: ExecutionFill, context: ExecutionContext) {
  if (plan.model !== 'order-book') return;
  context.consumed ??= {};
  const consumed = context.consumed[plan.key] ??= { bids: [], asks: [] };
  const side = plan.side === 'BUY' ? consumed.asks : consumed.bids;
  for (const level of fill.consumed) side[level.index] = (side[level.index] ?? 0) + level.shares;
}
