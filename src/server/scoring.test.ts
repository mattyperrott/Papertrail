import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScannerSettings, TraderCandidate } from '../shared/types.js';
import { preserveSelectionOverrides, scoreTrader, selectTraders, wilsonLowerBound } from './scoring.js';

const now = Date.parse('2026-09-09T00:00:00Z');
const settings: ScannerSettings = {
  category: 'OVERALL', period: 'MONTH', minWinRate: 55, minRoi: 2, minTrades: 25,
  minScore: 60, maxWatchedTraders: 3, maxTrackedTraders: 1, candidatePoolSize: 500,
  replayHours: 24, maxInactiveHours: 24,
};
const trader = (address: string, wins = 80, losses = 20): TraderCandidate => {
  const candidate: TraderCandidate = {
    address, name: address, provider: 'polymarket', rank: 1,
    pnl: 1000, volume: 10000, roi: null, winRate: null, trades: null, score: 0,
    watched: false, selected: false,
    verification: { provider: 'polymarketscan', checkedAt: new Date(now).toISOString(), url: '',
      status: 'verified', notes: [], pnl: 1000, roi: 10, wins, losses },
    reasons: [], openPositions: 0, lastActivityAt: new Date(now - 1000).toISOString(),
  };
  return scoreTrader(candidate, candidate.verification);
};

test('Wilson bound matches independently tabulated 60/100 lower endpoint', () => {
  assert.ok(Math.abs(wilsonLowerBound(60, 40) - 0.5020025868) < 1e-9);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(-1, 4), 0);
  assert.equal(wilsonLowerBound(NaN, 4), 0);
  assert.equal(wilsonLowerBound(1.5, 4), 0);
  assert.equal(wilsonLowerBound(Infinity, 4), 0);
});

test('Wilson outcome frequency stays descriptive rather than becoming a skill score', () => {
  assert.equal(trader('large', 80, 20).score,0);
  assert.equal(trader('lucky', 5, 0).score,0);
  assert.ok(trader('large',80,20).winRate!<trader('lucky',5,0).winRate!);
});

test('bankroll, turnover, large ROI, and losses do not inflate score', () => {
  const base = trader('base');
  const whale = scoreTrader({ ...base, pnl: 1e12, volume: 1e12 }, { ...base.verification, pnl: 1e12, roi: 10000 });
  assert.equal(whale.score, base.score);
  const loser = scoreTrader({ ...base, pnl: -1e12 }, { ...base.verification, pnl: -1e12 });
  assert.equal(loser.score, 0);
  assert.equal(scoreTrader(base, { ...base.verification, status: 'warning' }).score, 0);
});

test('fill counts or token totals never substitute for settled counts', () => {
  const base = trader('fills');
  const result = scoreTrader({ ...base, winRate: 99, trades: 1_000_000 }, {
    ...base.verification, winRate: 99, wins: undefined, losses: undefined,
  });
  assert.equal(result.trades, null);
  assert.equal(result.winRate, null);
  assert.equal(result.score, 0);
});

test('score always uses exact counts and preserves discovery metric periods', () => {
  const base = trader('period');
  const result = scoreTrader(base, { ...base.verification, winRate: 99.9, volume: 1e9, pnl: 1e6 });
  assert.equal(result.winRate, 80);
  assert.equal(result.volume, 10000);
  assert.equal(result.pnl, 1000);
});

test('champion selection prioritizes complete evidence and sample size, not win rate', () => {
  const result = selectTraders([trader('best', 190, 10), trader('also-watched', 80, 20), trader('raw-only', 60, 40)], settings, now);
  assert.deepEqual(result.filter((item) => item.selected).map((item) => item.address), ['best']);
  assert.deepEqual(result.filter((item) => item.watched).map((item) => item.address), ['best', 'also-watched', 'raw-only']);
  assert.ok(result.find((item) => item.address === 'raw-only')?.reasons.every(reason=>!reason.includes('win-rate floor')));
});

test('invalid or future activity and stale verification fail closed while unused legacy score is ignored', () => {
  const base = trader('base');
  const bad = [
    { ...base, address: 'date', lastActivityAt: 'not-a-date' },
    { ...base, address: 'future', lastActivityAt: new Date(now + 3_600_000).toISOString() },
    { ...base, address: 'stale', verification: { ...base.verification, checkedAt: new Date(0).toISOString() } },
    { ...base, address: 'nan', score: NaN },
    { ...base, address: 'warning', verification: { ...base.verification, status: 'warning' as const } },
  ];
  const result=selectTraders(bad, settings, now);
  assert.deepEqual(result.filter((item)=>item.selected||item.watched).map(item=>item.address),['nan']);
});

test('manual include copies the wallet regardless of screen outcome, keeping the reasons on record', () => {
  const selected = { ...trader('automatic'), selected: true, watched: true };
  const rejected = { ...trader('manual'), reasons: ['Below ROI floor'] };
  const pinned = { ...trader('gone'), selected: true, selectionOverride: 'include' as const };
  const result = preserveSelectionOverrides([selected, rejected], [
    { ...rejected, selectionOverride: 'include' }, pinned,
  ], 3, 3);
  assert.equal(result.find((item) => item.address === 'automatic')?.selected, true);
  // A pin is a deliberate human call on trader quality, so a configured threshold
  // such as the ROI floor gives way to it. Per-trade risk controls still apply.
  assert.equal(result.find((item) => item.address === 'manual')?.selected, true);
  // Even a wallet absent from the current scan stays copied while pinned: its
  // activity and positions are fetched by address, not from the leaderboard. The
  // reason remains on the record so the dashboard can still explain the gap.
  assert.equal(result.find((item) => item.address === 'gone')?.selected, true);
  assert.equal(result.find((item) => item.address === 'gone')?.watched, true);
  assert.ok(result.find((item) => item.address === 'gone')?.reasons.includes('Not evaluated in the current scan'));
});

test('manual include can use remaining copy slots only for currently qualified candidates', () => {
  const automatic = { ...trader('automatic'), selected: true, watched: true };
  const manual = trader('manual');
  const excluded = { ...trader('excluded'), selected: true, watched: true };
  const result = preserveSelectionOverrides([automatic, manual, excluded], [
    { ...manual, selectionOverride: 'include' }, { ...excluded, selectionOverride: 'exclude' },
  ], 2, 3);
  assert.deepEqual(result.filter((item) => item.selected).map((item) => item.address), ['automatic', 'manual']);
});

test('pins take copy slots first and hard limits still bound the total', () => {
  const automatic = { ...trader('automatic'), selected: true, watched: true };
  const pins = ['one', 'two', 'three'].map((address) => ({ ...trader(address), reasons: ['Insufficient settled sample'], selectionOverride: 'include' as const }));
  const result = preserveSelectionOverrides([automatic], pins, 2, 2);
  // Two slots, three pins and one automatic pick: the pins win the slots, and the
  // hard limit is never exceeded. Raising maxTrackedTraders is the operator's lever.
  assert.equal(result.filter((item) => item.watched).length, 2);
  assert.equal(result.filter((item) => item.selected).length, 2);
  assert.ok(result.filter((item) => item.selected).every((item) => item.selectionOverride === 'include'));
  assert.equal(result.find((item) => item.address === 'automatic')?.selected, false);
});

test('edge ranking replaces the win-rate key and suspends the win-rate floor with it', () => {
  const edgeSettings = { ...settings, edgeRanking: true, minEdgeScore: 10, maxTrackedTraders: 2, maxWatchedTraders: 3 };
  const summary = (score: number) => ({ trades: 40, independentGroups: 40, meanEdge: score / 1000,
    edgeLowerBound: score / 1000, meanReturnOnRisk: 0, meanLogGrowth: 0, score, effectiveSampleSize:40,
    cvar95Loss:.05,rankingRatio:score/50,falseDiscoveryRate:0,positiveFoldPct:100,maxProfitContributionPct:10,eligible:score>0 });

  // A textbook favourite-buyer: excellent win rate, measured expectancy of zero.
  const favourite = scoreTrader(trader('favourite', 95, 5), trader('favourite', 95, 5).verification, summary(0));
  // Weaker win rate, but expectancy that clears the floor.
  const edged = scoreTrader(trader('edged', 60, 40), trader('edged', 60, 40).verification, summary(45));
  assert.equal(favourite.score, 0);
  assert.equal(edged.score, .9);

  const result = selectTraders([favourite, edged], edgeSettings, now);
  assert.deepEqual(result.filter((t) => t.selected).map((t) => t.address), ['edged']);
  assert.ok(result.find((t) => t.address === 'favourite')?.reasons.includes('Conservative net edge is not positive'));
  // `edged` has a 50.2% Wilson bound, below the 55% floor. That floor must not
  // apply here: it is the same favourite-buying bias expressed as a filter, so
  // leaving it on would change the ranking key and preserve the old selection.
  assert.ok(!result.find((t) => t.address === 'edged')?.reasons.includes('Below confidence-adjusted win-rate floor'));
  assert.ok(selectTraders([edged], { ...edgeSettings, edgeRanking: false }, now)[0]
    .reasons.every(reason=>!reason.includes('win-rate floor')));
});

test('an unmeasured wallet is never judged against a floor it was not evaluated for', () => {
  const edgeSettings = { ...settings, edgeRanking: true, minEdgeScore: 10 };
  const unmeasured = trader('unmeasured', 95, 5);
  const result = selectTraders([unmeasured], edgeSettings, now);
  assert.equal(result[0].selected, false);
  assert.ok(result[0].reasons.includes('Expectancy not measured in this scan'));
  assert.ok(!result[0].reasons.includes('Measured expectancy too low'));
});

test('a strong edge cannot rescue a wallet that fails verification', () => {
  const strong = { trades: 99, independentGroups: 99, meanEdge: .2, edgeLowerBound: .2,
    meanReturnOnRisk: 0, meanLogGrowth: 0, score: 100,rankingRatio:2 };
  const base = trader('unverified');
  assert.equal(scoreTrader(base, { ...base.verification, status: 'warning' }, strong).score, 0);
  assert.equal(scoreTrader(base, { ...base.verification, pnl: -1 }, strong).score, 0);
});

test('the win-rate key is unchanged when edge ranking is off', () => {
  const base = trader('legacy', 80, 20);
  assert.equal(scoreTrader(base, base.verification).score, trader('legacy', 80, 20).score);
  assert.ok(selectTraders([base], settings, now)[0].reasons.every((r) => !r.includes('expectancy')));
});

test('a previous scan\'s expectancy summary is never carried forward', () => {
  const measured = scoreTrader(trader('carry'), trader('carry').verification,
    { trades: 40, independentGroups: 40, meanEdge: 0, edgeLowerBound: 0, meanReturnOnRisk: 0, meanLogGrowth: 0, score: 0 });
  assert.equal(measured.score, 0, 'the measured score applies while it is supplied');
  assert.ok(measured.edge);
  // Re-scored without a measurement: no stale expectancy may survive and the
  // descriptive Wilson statistic must not become a replacement score.
  const rescored = scoreTrader(measured, measured.verification);
  assert.equal(rescored.edge, undefined);
  assert.equal(rescored.score, 0);
});
