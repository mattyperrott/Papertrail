import type { EdgeSummary, ScannerSettings, TraderCandidate, VerificationEvidence } from '../shared/types.js';
import { clamp, round } from './lib/math.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const VERIFICATION_MAX_AGE_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 60_000;


/** Lower endpoint of the two-sided 95% Wilson interval, in [0, 1].
 * This measures uncertainty in the observed outcome frequency, NOT profitability
 * or forecasting skill. Correlated markets violate its independent-trial premise.
 */
export function wilsonLowerBound(wins: number, losses: number, z = 1.959963984540054): number {
  const n = wins + losses;
  if (!count(wins) || !count(losses) || !Number.isSafeInteger(n) || n === 0 || !finite(z) || z <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  return clamp((p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n), 0, 1);
}

function settledCounts(evidence: VerificationEvidence): { wins: number; losses: number } | null {
  return count(evidence.wins) && count(evidence.losses)
    && Number.isSafeInteger(evidence.wins + evidence.losses) && evidence.wins + evidence.losses > 0
    ? { wins: evidence.wins, losses: evidence.losses }
    : null;
}

/**
 * @param edge Optional measured expectancy. When supplied it replaces the
 * win-rate bound as the ranking key, because a win-rate bound says how often a
 * trader is right and not whether being right pays: buying 0.95 favourites
 * yields a superb win rate at negative expectancy, and ranking on it selects
 * for exactly that. Supplying this does not relax any eligibility gate below —
 * a wallet that fails verification still scores zero.
 */
export function scoreTrader(
  candidate: TraderCandidate,
  verification: VerificationEvidence,
  edge?: EdgeSummary,
): TraderCandidate {
  const counts = settledCounts(verification);
  const roi = finite(verification.roi) ? verification.roi : null;
  const winRate = counts ? counts.wins / (counts.wins + counts.losses) * 100 : null;
  // Do not manufacture settled outcomes from fill count, leaderboard token count,
  // absolute P&L, turnover, or a percentage without its denominator. P&L and ROI
  // remain descriptive/gating evidence; their magnitude receives no score boost.
  const qualified = Boolean(counts) && verification.status === 'verified' && finite(verification.pnl)
    && verification.pnl > 0 && roi !== null && roi > 0;
  // Wilson remains visible as `winRate`; methodology v3 never treats it as a
  // skill score. Challenger ranking is the explicit lower-edge/CVaR ratio.
  const score = !qualified || !edge ? 0 : round(finite(edge.rankingRatio) ? edge.rankingRatio : 0, 4);
  return {
    ...candidate,
    roi,
    winRate,
    trades: counts ? counts.wins + counts.losses : null,
    // Preserve the leaderboard's P&L and volume together: the verifier is all-time
    // whereas discovery figures may describe a day/week/month. Never mix periods.
    score,
    // Only this scan's measurement. Carrying a previous one forward let a stale
    // expectancy summary sit on a trader after the ranking model was switched
    // off, so the dashboard kept showing an edge score the screen was not using.
    edge,
    verification,
  };
}

export function selectTraders(candidates: TraderCandidate[], settings: ScannerSettings, now = Date.now()): TraderCandidate[] {
  const ranked = candidates.map((candidate) => {
    const reasons: string[] = [];
    const counts = settledCounts(candidate.verification);
    const edgeRanking = settings.edgeRanking === true;
    if (!counts) reasons.push('Settled outcome counts unavailable');
    if (!finite(candidate.roi) || !finite(candidate.verification.pnl)) reasons.push('Complete P&L and ROI evidence unavailable');
    if (!counts || counts.wins + counts.losses < settings.minTrades) reasons.push('Insufficient settled sample');
    if (edgeRanking && !candidate.edge) {
      reasons.push('Expectancy not measured in this scan');
    } else if (edgeRanking && candidate.edge) {
      if ((candidate.edge.effectiveSampleSize ?? 0) < (settings.minEffectiveEventClusters ?? 40)) reasons.push('Fewer than 40 effective event clusters');
      if ((candidate.edge.edgeLowerBound ?? -Infinity) <= 0) reasons.push('Conservative net edge is not positive');
      if ((candidate.edge.falseDiscoveryRate ?? 100) > (settings.maxFalseDiscoveryRatePct ?? 10)) reasons.push('False-discovery rate exceeds 10%');
      if ((candidate.edge.positiveFoldPct ?? 0) < (settings.minPositiveFoldPct ?? 70)) reasons.push('Edge is unstable across validation folds');
      if ((candidate.edge.maxProfitContributionPct ?? 100) > (settings.maxProfitConcentrationPct ?? 20)) reasons.push('Profit is too concentrated');
    }
    if (candidate.verification.status !== 'verified') reasons.push('Cross-check is not internally consistent');
    const checkedAt = Date.parse(candidate.verification.checkedAt);
    if (!finite(checkedAt) || checkedAt > now + CLOCK_SKEW_MS || now - checkedAt > VERIFICATION_MAX_AGE_MS) {
      reasons.push('Cross-check is stale or has an invalid timestamp');
    }
    const activityAt = Date.parse(candidate.lastActivityAt ?? '');
    const inactiveHours = finite(activityAt) && activityAt <= now + CLOCK_SKEW_MS
      ? Math.max(0, (now - activityAt) / 3_600_000) : Infinity;
    if (inactiveHours > settings.maxInactiveHours) reasons.push('Trader is not recently active');
    return { ...candidate, reasons, inactiveHours };
  }).sort((a, b) => {
    const aQualified = a.reasons.length === 0 ? 1 : 0;
    const bQualified = b.reasons.length === 0 ? 1 : 0;
    const aRank = settings.edgeRanking ? a.edge?.rankingRatio ?? -Infinity : a.trades ?? -Infinity;
    const bRank = settings.edgeRanking ? b.edge?.rankingRatio ?? -Infinity : b.trades ?? -Infinity;
    // Capacity limits allocation; it never boosts a wallet above stronger evidence.
    return bQualified - aQualified || bRank - aRank || a.address.localeCompare(b.address);
  });

  let watched = 0;
  let selected = 0;
  return ranked.map((candidate) => {
    const watchBlockingReasons = candidate.reasons.filter((reason) => reason !== 'Insufficient settled sample');
    const watchEligible = watchBlockingReasons.length === 0 && watched < settings.maxWatchedTraders;
    if (watchEligible) watched += 1;
    const copyEligible = watchEligible && candidate.reasons.length === 0 && selected < settings.maxTrackedTraders;
    if (copyEligible) selected += 1;
    const { inactiveHours: _inactiveHours, ...result } = candidate;
    return { ...result, watched: watchEligible, selected: copyEligible };
  });
}

export function preserveSelectionOverrides(
  automaticallySelected: TraderCandidate[],
  previousTraders: TraderCandidate[],
  maxTrackedTraders: number,
  maxWatchedTraders = Number.POSITIVE_INFINITY,
): TraderCandidate[] {
  const key = (address: string) => address.toLowerCase();
  const previousByAddress = new Map(previousTraders.map((trader) => [key(trader.address), trader]));
  const withOverrides: TraderCandidate[] = automaticallySelected.map((trader) => ({
    ...trader,
    selectionOverride: previousByAddress.get(key(trader.address))?.selectionOverride,
  }));
  const incoming = new Set(withOverrides.map((trader) => key(trader.address)));
  for (const previous of previousTraders) {
    if (previous.selectionOverride === 'include' && !incoming.has(key(previous.address))) {
      withOverrides.push({
        ...previous, watched: false, selected: false,
        reasons: [...new Set([...previous.reasons, 'Not evaluated in the current scan'])],
      });
    }
  }

  // A pin is a monitoring preference, never a waiver of data quality, sample,
  // recency, or configured thresholds. Qualified automatic candidates keep priority.
  const hardFailure = (trader:TraderCandidate) => trader.verification.status !== 'verified'
    || trader.reasons.some((reason) => /unavailable|stale|invalid timestamp|not recently active/i.test(reason));
  const copyOrder = [...withOverrides].sort((a, b) =>
    Number(b.selectionOverride === 'include') - Number(a.selectionOverride === 'include')
    || Number(b.selected) - Number(a.selected)
    || (finite(b.score) ? b.score : -Infinity) - (finite(a.score) ? a.score : -Infinity)
    || a.address.localeCompare(b.address));
  const selectedAddresses = new Set(copyOrder
    .filter((trader) => {
      if (trader.selectionOverride === 'exclude') return false;
      // Pins control ranking displacement, not evidence integrity. A missing or
      // stale cross-check must halt new entries for every wallet.
      if (trader.selectionOverride === 'include') return !hardFailure(trader);
      return trader.reasons.length === 0 && trader.verification.status === 'verified'
        && (trader.selected || trader.watched);
    })
    .slice(0, Math.max(0, Math.floor(maxTrackedTraders)))
    .map((trader) => key(trader.address)));
  const watchOrder = [...withOverrides].sort((a, b) =>
    Number(selectedAddresses.has(key(b.address))) - Number(selectedAddresses.has(key(a.address)))
    || Number(b.selectionOverride === 'include') - Number(a.selectionOverride === 'include')
    || (finite(b.score) ? b.score : -Infinity) - (finite(a.score) ? a.score : -Infinity)
    || a.address.localeCompare(b.address));
  const watchedAddresses = new Set(watchOrder
    .filter((trader) => selectedAddresses.has(key(trader.address)) || trader.watched || trader.selectionOverride === 'include')
    .slice(0, Math.max(0, Math.floor(maxWatchedTraders)))
    .map((trader) => key(trader.address)));
  return withOverrides.map((trader) => ({
    ...trader,
    watched: watchedAddresses.has(key(trader.address)),
    selected: watchedAddresses.has(key(trader.address)) && selectedAddresses.has(key(trader.address)),
  }));
}
