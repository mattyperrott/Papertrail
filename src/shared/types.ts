export type DataProvider = 'arkham' | 'polymarket';
export type VerificationStatus = 'verified' | 'warning' | 'unavailable';
export type TradeSide = 'BUY' | 'SELL';

export interface RiskSettings {
  startingBalance: number;
  maxRiskPerTradePct: number;
  maxPositionPct: number;
  maxTotalExposurePct: number;
  sourceNotionalMultiplier: number;
  slippageBps: number;
  defaultSellPct: number;
  maxPositionDurationDays: number;
  /** Optional fields are filled and validated by the configuration migration. */
  feeBps?: number;
  maxSignalAgeSeconds?: number;
  maxPriceDriftBps?: number;
  /** Maximum adverse move from the source trader's own average entry before a copy
   * is refused. Without it, copying a live position buys whatever the market has
   * already repriced to, which is systematically the worst available entry. */
  maxEntryDriftBps?: number;
  /** Hard ceiling on entry price. At price p a share can gain 1-p and lose p, so
   * high-probability entries carry a payoff asymmetry that amplifies any
   * calibration error. */
  maxEntryPrice?: number;
  /** Event tag slugs a signal must carry to be copied, e.g. ['sports','crypto'].
   * Empty or absent means no restriction. Discovery only ranks *traders* by
   * category; those traders still trade everything, so without this there is no
   * control over which markets we actually follow them into. */
  allowedMarketTags?: string[];
  maxTraderExposurePct?: number;
  maxEventExposurePct?: number;
  maxDrawdownPct?: number;
  stopLossPct?: number;
  maxQuoteAgeSeconds?: number;
  maxParticipationPct?: number;
  requireExecutableQuotes?: boolean;
  /** UTC-day equity loss which latches the same halt as the drawdown guard. */
  maxDailyLossPct?: number;
  /** Ignore target changes smaller than this fraction of the existing position. */
  noTradeBandPct?: number;
}

export interface ScannerSettings {
  category: 'OVERALL' | 'POLITICS' | 'SPORTS' | 'CRYPTO' | 'CULTURE' | 'WEATHER' | 'ECONOMICS' | 'TECH' | 'FINANCE';
  period: 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
  /** @deprecated Accepted on old API payloads but ignored by methodology v3. */
  minWinRate?: number;
  minRoi: number;
  minTrades: number;
  /** @deprecated Accepted on old API payloads but ignored by methodology v3. */
  minScore?: number;
  /** Maximum wallets retained for broad monitoring after activity/verification checks. */
  maxWatchedTraders: number;
  /** Maximum watched wallets whose signals are allowed into the paper engine. */
  maxTrackedTraders: number;
  /** Unique wallets discovered across the daily, weekly, and monthly leaderboards. */
  candidatePoolSize: number;
  replayHours: number;
  maxInactiveHours: number;
  /** Rank the watched set on measured expectancy instead of the win-rate screen.
   * Experimental and default off: it changes which wallets are copied, so it is
   * enabled only after an out-of-sample comparison against the screen. */
  edgeRanking?: boolean;
  /** Score floor applied in place of `minScore` while `edgeRanking` is on. The
   * two are not on the same scale: `minScore` bounds a win-rate percentage,
   * this bounds a per-share expectancy where 100 equals $0.10 per share. */
  minEdgeScore?: number;
  /** Single compatibility-migrated statistical confidence control. Wilson is
   * shown descriptively; challenger inference uses this one-sided confidence. */
  confidenceLevelPct?: number;
  minEffectiveEventClusters?: number;
  maxFalseDiscoveryRatePct?: number;
  minPositiveFoldPct?: number;
  maxProfitConcentrationPct?: number;
}

/** Realized-expectancy summary for one trader; see `edge.ts`. */
export interface EdgeSummary {
  trades: number;
  independentGroups: number;
  meanEdge: number;
  edgeLowerBound: number | null;
  meanReturnOnRisk: number;
  meanLogGrowth: number;
  score: number;
  notes?: string[];
  effectiveSampleSize?: number;
  shrunkMeanEdge?: number;
  cvar95Loss?: number;
  rankingRatio?: number;
  falseDiscoveryRate?: number;
  pValue?: number;
  positiveFoldPct?: number;
  maxProfitContributionPct?: number;
  eligible?: boolean;
  label?: 'confirmed' | 'experimental' | 'insufficient-evidence';
}

export interface AppSettings {
  risk: RiskSettings;
  scanner: ScannerSettings;
  paused: boolean;
}

export interface VerificationEvidence {
  provider: 'polymarketscan';
  checkedAt: string;
  url: string;
  status: VerificationStatus;
  pnl?: number;
  roi?: number;
  winRate?: number;
  wins?: number;
  losses?: number;
  volume?: number;
  sharpe?: number;
  activeDays?: number;
  notes: string[];
}

export interface TraderCandidate {
  address: string;
  name: string;
  avatar?: string;
  provider: DataProvider;
  rank: number;
  pnl: number;
  volume: number;
  roi: number | null;
  winRate: number | null;
  trades: number | null;
  marketsWon?: number;
  marketsTotal?: number;
  score: number;
  watched: boolean;
  selected: boolean;
  selectionOverride?: 'include' | 'exclude';
  verification: VerificationEvidence;
  reasons: string[];
  openPositions: number;
  lastActivityAt?: string;
  leaderboardPeriods?: Array<'DAY' | 'WEEK' | 'MONTH'>;
  /** Present only for wallets that reached the deep tier of the scan. */
  edge?: EdgeSummary;
  eligibilityStreak?: number;
  softFailureStreak?: number;
  entryEligible?: boolean;
}

export type StrategySleeve = 'champion' | 'challenger';
export type EvidenceLabel = 'confirmed' | 'experimental' | 'insufficient-evidence';

export interface TraderAssessment {
  id: string;
  traderAddress: string;
  assessedAt: string;
  sleeve: StrategySleeve;
  eligible: boolean;
  reasons: string[];
  effectiveSampleSize?: number;
  meanEdge?: number;
  edgeLowerBound?: number | null;
  cvar95Loss?: number;
  rankingRatio?: number;
  capacityUsd?: number;
  label: EvidenceLabel;
}

export interface SourceEvent {
  id: string;
  sourceAt: string;
  receivedAt: string;
  normalizedAt: string;
  trade: SourceTrade;
}

export type SignalState = 'observed' | 'validated' | 'pending_quote' | 'filled' | 'partial' | 'rejected' | 'expired';
export interface SignalDecision {
  id: string;
  sourceEventId: string;
  state: SignalState;
  sleeve: StrategySleeve;
  observedAt: string;
  quoteAt?: string;
  decidedAt: string;
  filledAt?: string;
  requestedShares: number;
  filledShares: number;
  reason: string;
  retryable: boolean;
  expiresAt: string;
}

export interface ScanFunnel {
  scanned: number;
  active: number;
  verified: number;
  rejected: number;
  watched: number;
  copied: number;
  checkedAt?: string;
  periods: Array<'DAY' | 'WEEK' | 'MONTH'>;
}

export interface SourceTrade {
  id: string;
  traderAddress: string;
  traderName: string;
  timestamp: number;
  side: TradeSide;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  eventSlug?: string;
  price: number;
  shares: number;
  notional: number;
  transactionHash?: string;
  provider: DataProvider;
  isCombo?: boolean;
  comboSide?: 'YES' | 'NO';
  /** The source trader's own average cost in this asset, when known. Compared
   * against `price` to reject entries that chase a position already in profit. */
  sourceAvgPrice?: number;
  /** Event tag slugs, stamped by the orchestrator before the engine decides.
   * Undefined means "not looked up"; an empty array means "looked up, none". */
  marketTags?: string[];
  receivedAt?: string;
  normalizedAt?: string;
}

export interface SourcePosition {
  observedAt?: string;
  traderAddress: string;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
  redeemable: boolean;
  eventSlug?: string;
  endDate?: string;
  isCombo?: boolean;
  comboSide?: 'YES' | 'NO';
  /** Event tag slugs, stamped by the orchestrator. See SourceTrade.marketTags. */
  marketTags?: string[];
}

/** A full wallet response; absent or failed pages must never imply zero inventory. */
export interface SourceInventorySnapshot {
  traderAddress: string;
  requestStartedAt: number;
  completedAt: number;
  complete: boolean;
  positions: SourcePosition[];
  error?: string;
}

export interface ExitIntent {
  targetShares: number;
  reason: string;
  since: string;
  sourceEventIds: string[];
  attemptSequence: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface ReentryLock {
  traderAddress: string;
  asset: string;
  blockedAt: string;
  zeroObservedAt?: string;
  rearmEventId?: string;
}

export interface PositionCycle {
  id: string;
  positionId: string;
  traderAddress: string;
  asset: string;
  openedAt: string;
  closedAt: string;
  cost: number;
  pnl: number;
  complete: boolean;
  eventKey?: string;
  fees?: number;
  exitProceeds?: number;
  heldToResolution?: boolean;
}

export interface WorkerHealth {
  startedAt?: string;
  completedAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  running: boolean;
  error?: string;
}

export interface ValidationRun {
  id: string;
  startedAt: string;
  codeHash: string;
  configurationHash: string;
  datasetHash?: string;
  inheritedHistory: boolean;
  completedAt?: string;
  passed?: boolean;
  report?: Record<string, unknown>;
}

export interface Alert {
  id: string;
  level: AlertLevel;
  code: string;
  message: string;
  createdAt: string;
  acknowledgedAt?: string;
  deliveryAttempts: number;
  deliveredAt?: string;
  deadLetteredAt?: string;
  nextDeliveryAt?: string;
  lastDeliveryError?: string;
}

export interface ReconciliationReport {
  id: string;
  checkedAt: string;
  passed: boolean;
  cashDifference: number;
  positionDifferences: string[];
  duplicateEventIds: string[];
  pendingExits: number;
  notes: string[];
}

export type ResolutionStatus = 'scheduled' | 'awaiting-result' | 'resolved' | 'unknown';
export type TimingSource = 'polymarket' | 'polymarket-combo' | 'title-estimate' | 'activity-estimate' | 'unavailable';

export interface PaperPosition {
  id: string;
  traderAddress: string;
  traderName: string;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  costBasis: number;
  currentValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: string;
  updatedAt: string;
  eventSlug?: string;
  isCombo?: boolean;
  comboSide?: 'YES' | 'NO';
  expectedEndAt?: string;
  gameStartAt?: string;
  resolvedAt?: string;
  resolutionStatus?: ResolutionStatus;
  timingSource?: TimingSource;
  /** `void`: the market resolved to a partial price (a 50/50 refund on an
   * abandoned match, for instance). Shares redeem at `resolvedPrice`. */
  result?: 'won' | 'lost' | 'void' | 'unknown';
  resolvedPrice?: number;
  lastVerifiedAt?: string;
  nextVerificationAt?: string;
  /** Set when a risk rule or trader removal has scheduled this position to be
   * closed. The close still executes through the normal fill path, so it is
   * subject to depth and fees like any other exit. */
  pendingExit?: { reason: string; since: string };
  exitIntent?: ExitIntent;
  cycleId?: string;
  cycleCost?: number;
  cyclePnl?: number;
  copyEdgeLowerBound?: number;
}

export interface PaperTrade {
  fees?: number;
  requestedShares?: number;
  unfilledShares?: number;
  executionModel?: 'order-book' | 'synthetic' | 'settlement';
  sourceTimestamp?: string;
  quoteCapturedAt?: string;
  sourcePositionObservedAt?: string;
  id: string;
  sourceTradeId: string;
  traderAddress: string;
  traderName: string;
  timestamp: string;
  side: TradeSide | 'SETTLE';
  title: string;
  outcome: string;
  asset: string;
  sourcePrice: number;
  fillPrice: number;
  shares: number;
  notional: number;
  realizedPnl: number;
  status: 'filled' | 'skipped';
  reason: string;
  eventSlug?: string;
  receivedAt?: string;
  decisionAt?: string;
  fillAt?: string;
  strategySleeve?: StrategySleeve;
}

export interface DeployReport {
  attempted: number;
  filled: number;
  positionsAffected: number;
  skipped: number;
  deployed: number;
  exposurePct: number;
  message: string;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
  cash: number;
  exposure: number;
}

export interface PaperAccount {
  accountId?: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  feesPaidTotal?: number;
  turnoverTotal?: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
  equityHistory: EquityPoint[];
  /** One close per completed UTC day, retained far longer than the intraday
   * ring in `equityHistory`. Daily ratios and drawdown are computed from this;
   * a 500-point intraday buffer cannot span the required window. */
  dailyCloses?: EquityPoint[];
  processedSourceTradeIds: string[];
  sourceWatermarks?: Record<string, number>;
  sourceStartedAt?: Record<string, number>;
  quoteConsumption?: Record<string,{bids:number[];asks:number[]}>;
  operationalEvents?: Array<{at:string;operation:string;status:string;message:string}>;
  highWaterEquity?: number;
  /** Peak-to-trough drawdown ever observed, in percent. Path-dependent, so it
   * cannot be recovered from a downsampled equity series and is carried here. */
  maxDrawdownPctObserved?: number;
  /** owner:asset -> when a risk rule closed it. Blocks immediate re-entry so a
   * stop-loss cannot be undone by the next deployment cycle. */
  riskClosedAt?: Record<string, number>;
  /** `liquidate` is set only by an operator's explicit emergency halt. The
   * automatic drawdown latch blocks new entries and lets open lines run to
   * settlement: on binary markets the loss is already bounded by the entry, and
   * dumping inventory into thin in-play books realised losses on positions that
   * went on to win (42 of 49, Sept 2026). */
  riskHalt?: { reason: string; triggeredAt: string; liquidate?: boolean };
  methodologyVersion?: number;
  strategyVersion?: string;
  strategySleeve?: StrategySleeve;
  configHash?: string;
  validationRunId?: string;
  entryEligibleSince?: Record<string, number>;
  sourceSnapshots?: Record<string, SourceInventorySnapshot>;
  pendingSourceEvents?: SourceTrade[];
  inventoryUncertain?: string[];
  reentryLocks?: Record<string, ReentryLock>;
  maxDrawdownPct?: number;
  drawdownHistoryComplete?: boolean;
  performanceSince?: string;
  completedCycles?: PositionCycle[];
  validationRun?: ValidationRun;
  workerHealth?: Record<string, WorkerHealth>;
  reconciliationRequired?: boolean;
  signalDecisions?: SignalDecision[];
  alerts?: Alert[];
  reconciliations?: ReconciliationReport[];
  cleanShutdown?: boolean;
  approvedCodeHash?: string;
  approvedConfigHash?: string;
  webhookTestedAt?: string;
  createdAt: string;
}

export interface ProviderStatus {
  primary: DataProvider;
  arkhamConfigured: boolean;
  arkhamConnected: boolean;
  polymarketConnected: boolean;
  polymarketScanConnected: boolean;
  lastScanAt?: string;
  lastPollAt?: string;
  lastVerificationAt?: string;
  lastAutoDeployAt?: string;
  nextAutoDeployAt?: string;
  lastAutoDeployMessage?: string;
  scanning: boolean;
  polling: boolean;
  verifying: boolean;
  autoDeploying: boolean;
  /** Operator actions waiting behind the running job. */
  queueDepth?: number;
  /** Name of the mutation currently holding the engine, and the ones behind it. */
  activeJob?: string;
  queuedJobs?: string[];
  message: string;
}

export interface DashboardState {
  settings: AppSettings;
  providerStatus: ProviderStatus;
  traders: TraderCandidate[];
  sourceTrades: SourceTrade[];
  scanFunnel: ScanFunnel;
  account: PaperAccount;
  summary: {
    equity: number;
    totalPnl: number;
    totalReturnPct: number;
    exposure: number;
    exposurePct: number;
    openPositions: number;
    filledTrades: number;
    skippedTrades: number;
    winRate: number;
    maxDrawdownPct?: number;
    currentDrawdownPct?: number;
    dailySharpe?: number | null;
    dailySortino?: number | null;
    dailyObservations?: number;
    feesPaid?: number;
    realizedProfitFactor?: number | null;
    halted?: boolean;
    haltReason?: string;
  };
  assessments?: TraderAssessment[];
  validationRuns?: ValidationRun[];
}

export type AlertLevel = 'info' | 'warning' | 'critical';

export type ServerEvent =
  | { type: 'state'; payload: DashboardState }
  | { type: 'scan'; payload: { message: string } }
  | { type: 'paper-trade'; payload: PaperTrade }
  | { type: 'alert'; payload: { level: AlertLevel; code: string; message: string; at: string } }
  | { type: 'error'; payload: { message: string } };
