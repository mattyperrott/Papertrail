import type { AppSettings } from '../shared/types.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';

const percent = z.number().finite().min(0).max(100);
const riskSchema = z.object({
  startingBalance: z.number().finite().min(100).max(100_000_000),
  maxRiskPerTradePct: z.number().finite().min(0.05).max(10),
  maxPositionPct: z.number().finite().min(0.1).max(50),
  maxTotalExposurePct: z.number().finite().min(1).max(100),
  sourceNotionalMultiplier: z.number().finite().min(0.01).max(100),
  slippageBps: z.number().finite().min(0).max(1000),
  defaultSellPct: z.number().finite().min(1).max(100),
  maxPositionDurationDays: z.number().finite().min(0.25).max(3650),
  feeBps: z.number().finite().min(0).max(1000),
  maxSignalAgeSeconds: z.number().finite().min(1).max(3600),
  maxPriceDriftBps: z.number().finite().min(0).max(5000),
  maxEntryDriftBps: z.number().finite().min(0).max(10_000),
  maxEntryPrice: z.number().finite().min(0.05).max(0.99),
  allowedMarketTags: z.array(z.string().min(1).max(64)).max(50),
  maxTraderExposurePct: percent.positive(),
  maxEventExposurePct: percent.positive(),
  maxDrawdownPct: percent.positive(),
  stopLossPct: percent.positive(),
  maxQuoteAgeSeconds: z.number().finite().min(0.1).max(120),
  maxParticipationPct: percent.positive(),
  requireExecutableQuotes: z.boolean(),
  maxDailyLossPct: percent.positive(),
  noTradeBandPct: percent,
}).strict();

const scannerSchema = z.object({
  category: z.enum(['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE', 'WEATHER', 'ECONOMICS', 'TECH', 'FINANCE']),
  period: z.enum(['DAY', 'WEEK', 'MONTH', 'ALL']),
  minWinRate: percent.optional(),
  minRoi: z.number().finite().min(-100).max(10_000),
  minTrades: z.number().int().min(1).max(1_000_000),
  minScore: percent.optional(),
  maxWatchedTraders: z.number().int().min(25).max(100),
  maxTrackedTraders: z.number().int().min(1).max(50),
  candidatePoolSize: z.number().int().min(100).max(500),
  replayHours: z.number().finite().min(0).max(168),
  maxInactiveHours: z.number().finite().min(1).max(8760),
  edgeRanking: z.boolean(),
  minEdgeScore: percent,
  confidenceLevelPct: z.number().finite().min(80).max(99.9),
  minEffectiveEventClusters: z.number().int().min(10).max(10_000),
  maxFalseDiscoveryRatePct: percent,
  minPositiveFoldPct: percent,
  maxProfitConcentrationPct: percent.positive(),
}).strict();

export const settingsPatch = z.object({
  paused: z.boolean().optional(),
  risk: riskSchema.partial().optional(),
  scanner: scannerSchema.partial().optional(),
}).strict();

export function parseSettings(value: unknown): AppSettings {
  return z.object({ paused: z.boolean(), risk: riskSchema, scanner: scannerSchema }).strict().parse(value);
}

export const clampAutoDeployInterval = (value: number) => Math.max(
  5 * 60_000,
  Math.min(10 * 60_000, Number.isFinite(value) ? value : 5 * 60_000),
);

export const defaultSettings: AppSettings = {
  risk: {
    startingBalance: 50_000,
    maxRiskPerTradePct: 0.5,
    maxPositionPct: 2,
    maxTotalExposurePct: 25,
    sourceNotionalMultiplier: 1,
    slippageBps: 25,
    defaultSellPct: 100,
    maxPositionDurationDays: 7,
    // Actual venue fees are mandatory; this is an additional paper stress cost.
    feeBps: 25,
    maxSignalAgeSeconds: 120,
    maxPriceDriftBps: 200,
    maxEntryDriftBps: 300,
    maxEntryPrice: 0.9,
    // Empty = follow selected traders into any market.
    allowedMarketTags: [],
    maxTraderExposurePct: 4,
    maxEventExposurePct: 4,
    maxDrawdownPct: 7.5,
    stopLossPct: 20,
    maxQuoteAgeSeconds: 15,
    maxParticipationPct: 5,
    requireExecutableQuotes: true,
    maxDailyLossPct: 2,
    noTradeBandPct: 10,
  },
  scanner: {
    category: 'OVERALL',
    period: 'MONTH',
    // Retained only for backwards-compatible settings payloads. It is not a
    // skill or eligibility gate in methodology v3.
    minWinRate: 0,
    minRoi: 2,
    minTrades: 25,
    minScore: 0,
    maxWatchedTraders: 75,
    maxTrackedTraders: 15,
    candidatePoolSize: 500,
    replayHours: 24,
    maxInactiveHours: 24,
    // Experimental. Off until an out-of-sample comparison justifies the switch.
    edgeRanking: false,
    // 10 == a $0.01 per-share lower bound on expectancy.
    minEdgeScore: 10,
    confidenceLevelPct: 95,
    minEffectiveEventClusters: 40,
    maxFalseDiscoveryRatePct: 10,
    minPositiveFoldPct: 70,
    maxProfitConcentrationPct: 20,
  },
  paused: true,
};

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!raw?.trim() && raw !== undefined || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}`);
    }
    return value;
  };
  const apiBase = env.ARKHAM_API_BASE?.trim() || 'https://api.arkm.com';
  let url: URL;
  try { url = new URL(apiBase); } catch { throw new Error('Invalid ARKHAM_API_BASE: expected an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid ARKHAM_API_BASE: expected HTTPS without credentials, query, or fragment');
  }
  if (env.TRADING_MODE && env.TRADING_MODE !== 'paper') throw new Error('Only paper trading is supported');
  let webhookUrl='';
  if(env.ALERT_WEBHOOK_URL?.trim()) {
    try {const parsed=new URL(env.ALERT_WEBHOOK_URL);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error();webhookUrl=parsed.toString();}
    catch {throw new Error('Invalid ALERT_WEBHOOK_URL: expected credential-free HTTPS');}
  }
  return {
    host: '127.0.0.1',
    port: integer('PORT', 8787, 1, 65_535),
    arkhamApiKey: env.ARKHAM_API_KEY?.trim() ?? '',
    arkhamApiBase: apiBase.replace(/\/$/, ''),
    pollIntervalMs: integer('POLL_INTERVAL_MS', 15_000, 1000, 3_600_000),
    resultVerificationIntervalMs: integer('RESULT_VERIFICATION_INTERVAL_MS', 5 * 60_000, 5000, 86_400_000),
    autoDeployIntervalMs: clampAutoDeployInterval(integer(
      env.AUTO_DEPLOY_INTERVAL_MS === undefined ? 'SCAN_INTERVAL_MS' : 'AUTO_DEPLOY_INTERVAL_MS',
      5 * 60_000, 1, 86_400_000,
    )),
    // Trader discovery (leaderboard + ~900 activity/verification requests, two
    // minutes under the engine lock) runs at most this often inside automatic
    // deploy cycles. Polls cannot run while it holds the lock, and every signal
    // older than maxSignalAgeSeconds by the time it is released expires unread.
    discoveryIntervalMs: integer('DISCOVERY_INTERVAL_MS', 60 * 60_000, 60_000, 86_400_000),
    webhookUrl,
    webhookToken: env.ALERT_WEBHOOK_TOKEN?.trim()??'',
    conditionalAutoResume: env.CONDITIONAL_AUTO_RESUME==='true',
    // A job that runs past this is treated as hung: it is failed, the process
    // exits non-zero so launchd restarts it, and entries stay paused until the
    // critical alert is acknowledged. Scans walk hundreds of wallets, so they
    // get the longer budget.
    jobDeadlineMs: integer('JOB_DEADLINE_MS', 5 * 60_000, 30_000, 3_600_000),
    scanDeadlineMs: integer('SCAN_DEADLINE_MS', 15 * 60_000, 60_000, 3_600_000),
    // How long SIGTERM waits for the running job before abandoning it (state
    // reverts to the last commit) and releasing the lock. Keep it under the
    // launchd ExitTimeOut, or launchd's SIGKILL leaves a stale lock instead.
    shutdownDrainMs: integer('SHUTDOWN_DRAIN_MS', 60_000, 1000, 3_600_000),
    approvedCodeHash: env.APPROVED_CODE_HASH?.trim()??'',
  };
}

/** Load `.env` from the working directory into the process environment, without
 * overriding anything already set. Previously the file was documentation only,
 * so the operator had to pass secrets on every restart command line — which is
 * both tedious and the surest way to get a key into a shell history. Values set
 * in the real environment still win, so a launcher can override the file. */
function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!existsSync(file)) return;
  try { process.loadEnvFile(file); }
  catch { /* A malformed file must not prevent startup; the environment stays as it was. */ }
}

loadDotEnv();
export const runtimeConfig = loadRuntimeConfig();
