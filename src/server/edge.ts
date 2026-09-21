/** Event-clustered, cost-aware expectancy estimation for methodology v3. */

export interface ResolvedTrade {
  price: number;
  outcome: 0 | 1;
  eventKey?: string;
  quantity?: number;
  allInEntry?: number;
  netExitOrOutcome?: number;
  occurredAt?: number | string;
  dayKey?: string;
}

export interface EdgeEstimate {
  trades: number;
  independentGroups: number;
  effectiveSampleSize: number;
  meanEdge: number;
  shrunkMeanEdge: number;
  edgeLowerBound: number | null;
  meanReturnOnRisk: number;
  meanLogGrowth: number;
  cvar95Loss: number;
  rankingRatio: number;
  pValue: number;
  falseDiscoveryRate: number;
  positiveFoldPct: number;
  maxProfitContributionPct: number;
  eligible: boolean;
  score: number;
}

export interface EdgeOptions {
  now?: number;
  halfLifeDays?: number;
  poolMean?: number;
  shrinkageK?: number;
  bootstrapIterations?: number;
  confidenceLevel?: number;
  seed?: number;
  minEffectiveGroups?: number;
  maxFalseDiscoveryRate?: number;
  minPositiveFoldPct?: number;
  maxProfitContributionPct?: number;
}

interface GroupObservation {
  key: string;
  day: string;
  at?: number;
  edge: number;
  returnOnRisk: number;
  logGrowth: number;
  profit: number;
  weight: number;
}

const REFERENCE_STAKE = 0.05;
const DAY_MS = 86_400_000;
const Z95 = 1.6448536269514722;
const T95 = [6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812];

export function tQuantile95(degreesOfFreedom: number): number {
  if (!Number.isFinite(degreesOfFreedom) || degreesOfFreedom < 1) return Number.POSITIVE_INFINITY;
  const v = Math.floor(degreesOfFreedom);
  if (v <= T95.length) return T95[v - 1];
  const z = Z95;
  return z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v * v);
}

const epoch = (value: number | string | undefined) => {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? (Math.abs(value) < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const quantile = (values: number[], probability: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(probability * sorted.length)));
  return sorted[index];
};
const weightedMean = (rows: GroupObservation[]) => {
  const denominator = rows.reduce((sum, row) => sum + row.weight, 0);
  return denominator > 0 ? rows.reduce((sum, row) => sum + row.weight * row.edge, 0) / denominator : 0;
};

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

/** Collapse every correlated event to one quantity-weighted copyable edge. */
function observations(trades: ResolvedTrade[], options: EdgeOptions): GroupObservation[] {
  const buckets = new Map<string, Array<{ q: number; edge: number; cost: number; at?: number; day: string }>>();
  let single = 0;
  for (const trade of trades) {
    const entry = trade.allInEntry ?? trade.price;
    const exit = trade.netExitOrOutcome ?? trade.outcome;
    const q = trade.quantity ?? 1;
    if (![entry, exit, q].every(Number.isFinite) || entry <= 0 || entry >= (trade.allInEntry===undefined?1:1.5) || exit < 0 || q <= 0
      || (trade.netExitOrOutcome===undefined&&trade.outcome!==0&&trade.outcome!==1)) continue;
    const at = epoch(trade.occurredAt);
    const key = trade.eventKey ?? `single:${single++}`;
    const day = trade.dayKey ?? (at === undefined ? `unknown:${key}` : new Date(at).toISOString().slice(0, 10));
    const rows = buckets.get(key) ?? [];
    rows.push({ q, edge: exit - entry, cost: entry, at, day });
    buckets.set(key, rows);
  }
  const now = options.now ?? Date.now();
  const halfLife = (options.halfLifeDays ?? 60) * DAY_MS;
  return [...buckets].map(([key, rows]) => {
    const quantity = rows.reduce((sum, row) => sum + row.q, 0);
    const edge = rows.reduce((sum, row) => sum + row.q * row.edge, 0) / quantity;
    const cost = rows.reduce((sum, row) => sum + row.q * row.cost, 0) / quantity;
    const at = Math.max(...rows.map((row) => row.at ?? -Infinity));
    const timestamp = Number.isFinite(at) ? at : undefined;
    const age = timestamp === undefined ? 0 : Math.max(0, now - timestamp);
    const returnOnRisk = edge / cost;
    return {
      key, day: rows[0].day, at: timestamp, edge, returnOnRisk,
      logGrowth: Math.log(Math.max(1e-12, 1 + REFERENCE_STAKE * returnOnRisk)),
      profit: quantity * edge,
      weight: Math.exp(-Math.LN2 * age / halfLife),
    };
  });
}

/** Resample UTC-day blocks so contemporaneous events remain dependent. */
function bootstrap(rows: GroupObservation[], options: EdgeOptions, shrinkageK: number, poolMean: number) {
  const byDay = new Map<string, GroupObservation[]>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  const blocks = [...byDay.values()];
  if (blocks.length < 2) return { lower: null as number | null, pValue: 1 };
  const random = mulberry32(options.seed ?? 0x54534e33);
  const estimates: number[] = [];
  const iterations = Math.max(200, Math.floor(options.bootstrapIterations ?? 2000));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample: GroupObservation[] = [];
    for (let index = 0; index < blocks.length; index++) sample.push(...blocks[Math.floor(random() * blocks.length)]);
    const sumWeight = sample.reduce((sum, row) => sum + row.weight, 0);
    const sumWeightSquared = sample.reduce((sum, row) => sum + row.weight ** 2, 0);
    const nEff = sumWeightSquared > 0 ? sumWeight ** 2 / sumWeightSquared : 0;
    const raw = weightedMean(sample);
    estimates.push((nEff * raw + shrinkageK * poolMean) / (nEff + shrinkageK));
  }
  const confidence = Math.max(0.8, Math.min(0.999, options.confidenceLevel ?? 0.95));
  return {
    lower: quantile(estimates, 1 - confidence),
    pValue: estimates.filter((estimate) => estimate <= 0).length / estimates.length,
  };
}

function rollingStability(rows: GroupObservation[]) {
  const ordered = [...rows].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.key.localeCompare(b.key));
  const folds = Math.min(5, ordered.length);
  if (folds < 2) return 0;
  let positive = 0;
  for (let fold = 0; fold < folds; fold++) {
    const start = Math.floor(fold * ordered.length / folds);
    const end = Math.floor((fold + 1) * ordered.length / folds);
    if (weightedMean(ordered.slice(start, end)) > 0) positive++;
  }
  return 100 * positive / folds;
}

export function estimateEdge(trades: ResolvedTrade[], optionsOrStake: EdgeOptions | number = {}): EdgeEstimate {
  const options = typeof optionsOrStake === 'number' ? {} : optionsOrStake;
  const rows = observations(trades, options);
  const sumWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const sumWeightSquared = rows.reduce((sum, row) => sum + row.weight ** 2, 0);
  const effectiveSampleSize = sumWeightSquared > 0 ? sumWeight ** 2 / sumWeightSquared : 0;
  const rawMean = weightedMean(rows);
  const poolMean = options.poolMean ?? 0;
  const shrinkageK = Math.max(0, options.shrinkageK ?? 10);
  const shrunkMeanEdge = (effectiveSampleSize * rawMean + shrinkageK * poolMean) / (effectiveSampleSize + shrinkageK || 1);
  const bootstrapResult = bootstrap(rows, options, shrinkageK, poolMean);
  const losses = rows.map((row) => Math.max(0, -row.edge)).sort((a, b) => b - a);
  const tailCount = Math.max(1, Math.ceil(losses.length * 0.05));
  const cvar95Loss = losses.length ? mean(losses.slice(0, tailCount)) : 0;
  const positiveProfit = rows.reduce((sum, row) => sum + Math.max(0, row.profit), 0);
  const maxProfitContributionPct = positiveProfit > 0
    ? 100 * Math.max(0, ...rows.map((row) => Math.max(0, row.profit))) / positiveProfit : 100;
  const positiveFoldPct = rollingStability(rows);
  const falseDiscoveryRate = 100 * bootstrapResult.pValue;
  const eligible = effectiveSampleSize >= (options.minEffectiveGroups ?? 40)
    && (bootstrapResult.lower ?? -Infinity) > 0
    && falseDiscoveryRate <= (options.maxFalseDiscoveryRate ?? 10)
    && positiveFoldPct >= (options.minPositiveFoldPct ?? 70)
    && maxProfitContributionPct <= (options.maxProfitContributionPct ?? 20);
  const rankingRatio = (bootstrapResult.lower ?? 0) / Math.max(cvar95Loss, 0.01);
  const validTrades=trades.filter(trade=>{
    const entry=trade.allInEntry??trade.price,exit=trade.netExitOrOutcome??trade.outcome,q=trade.quantity??1;
    return [entry,exit,q].every(Number.isFinite)&&entry>0&&entry<(trade.allInEntry===undefined?1:1.5)&&exit>=0&&q>0&&(trade.netExitOrOutcome!==undefined||trade.outcome===0||trade.outcome===1);
  }).length;
  return {
    trades: validTrades, independentGroups: rows.length, effectiveSampleSize,
    meanEdge: rawMean, shrunkMeanEdge, edgeLowerBound: bootstrapResult.lower,
    meanReturnOnRisk: rows.length ? mean(rows.map((row) => row.returnOnRisk)) : 0,
    meanLogGrowth: rows.length ? mean(rows.map((row) => row.logGrowth)) : 0,
    cvar95Loss, rankingRatio, pValue: bootstrapResult.pValue, falseDiscoveryRate,
    positiveFoldPct, maxProfitContributionPct, eligible,
    score: eligible ? Math.max(0, Math.min(100, 50 * rankingRatio)) : 0,
  };
}

export function benjaminiHochberg(pValues: number[]): number[] {
  const ranked = pValues.map((p, index) => ({ p: Math.max(0, Math.min(1, p)), index }))
    .sort((a, b) => a.p - b.p || a.index - b.index);
  const result = new Array<number>(pValues.length).fill(1);
  let next = 1;
  for (let rank = ranked.length; rank >= 1; rank--) {
    const row = ranked[rank - 1];
    next = Math.min(next, row.p * ranked.length / rank);
    result[row.index] = next;
  }
  return result;
}

/** Method-of-moments empirical-Bayes pool and equivalent prior sample size. */
export function estimateShrinkagePool(estimates:EdgeEstimate[]) {
  const usable=estimates.filter(row=>row.effectiveSampleSize>0&&Number.isFinite(row.meanEdge));
  if(!usable.length)return {poolMean:0,shrinkageK:10};
  const total=usable.reduce((sum,row)=>sum+row.effectiveSampleSize,0);
  const poolMean=usable.reduce((sum,row)=>sum+row.meanEdge*row.effectiveSampleSize,0)/total;
  const observedBetween=usable.length>1?usable.reduce((sum,row)=>sum+(row.meanEdge-poolMean)**2,0)/(usable.length-1):0;
  const within=mean(usable.map(row=>Math.max(.0001,row.cvar95Loss)**2));
  const sampling=mean(usable.map(row=>within/Math.max(1,row.effectiveSampleSize)));
  const between=Math.max(1e-6,observedBetween-sampling);
  return {poolMean,shrinkageK:Math.max(1,Math.min(100,within/between))};
}

export function kellyFraction(probability: number, price: number): number {
  if (![probability, price].every(Number.isFinite) || price <= 0 || price >= 1) return 0;
  return Math.max(0, (probability - price) / (1 - price));
}

export function sizingFactor(probabilityLowerBound: number, allInPrice: number, fraction = 0.10, cap = 1): number {
  return Math.max(0, Math.min(cap, fraction * kellyFraction(probabilityLowerBound, allInPrice)));
}

export function impliedProbability(price: number, meanEdge: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(meanEdge)) return 0;
  return Math.max(0, Math.min(1, price + meanEdge));
}
