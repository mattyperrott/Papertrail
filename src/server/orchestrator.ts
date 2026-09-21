import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DashboardState, DeployReport, EdgeSummary, RiskSettings, ScannerSettings, ServerEvent, SourcePosition, SourceTrade, TraderCandidate } from '../shared/types.js';
import { parseSettings, runtimeConfig } from './config.js';
import { benjaminiHochberg, estimateEdge, estimateShrinkagePool, type ResolvedTrade } from './edge.js';
import { accountEquity, accountExposure, applySourceTrade, createPaperAccount, deployCurrentPositions, enforceRiskLimits, liquidatePositionsOutsideHorizon, markPositions, recordEquityPoint, settleResolvedPositions } from './paperEngine.js';
import type { ExecutionContext } from './paperExecution.js';
import { preserveSelectionOverrides, scoreTrader, selectTraders } from './scoring.js';
import { ArkhamSource } from './sources/arkham.js';
import { MarketTimingResolver } from './sources/marketTiming.js';
import { PolymarketSource } from './sources/polymarket.js';
import { PolymarketComboResolver } from './sources/polymarketCombos.js';
import { PolymarketScanVerifier } from './sources/polymarketScan.js';
import { MarketResolutionCache, reconstructTraderHistory } from './sources/traderHistory.js';
import { ExecutionQuoteSource, stampSourcePositions, summarizeUnavailable } from './sources/executionQuotes.js';
import { StateStore, summarize } from './store.js';
import { AlertService } from './alerts.js';
import { currentCodeHash } from './release.js';

async function mapLimited<T,R>(items:T[],limit:number,task:(item:T)=>Promise<R>):Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor=0;
  // Wait for every worker even after one fails; no orphan work can mutate the next cycle.
  const done = await Promise.allSettled(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(cursor<items.length) { const index=cursor++; results[index]=await task(items[index]); }
  }));
  const error = done.find(result=>result.status==='rejected');
  if(error?.status==='rejected') throw error.reason;
  return results;
}

export class JobTimeoutError extends Error {
  constructor(name:string,deadlineMs:number) {super(`${name} exceeded its ${Math.round(deadlineMs/1000)}s deadline and was abandoned; restarting so risk monitoring resumes`);this.name='JobTimeoutError';}
}

export class PapertrailOrchestrator extends EventEmitter {
  private readonly polymarket = new PolymarketSource();
  private readonly arkham = runtimeConfig.arkhamApiKey ? new ArkhamSource(runtimeConfig.arkhamApiKey,runtimeConfig.arkhamApiBase) : null;
  private readonly verifier = new PolymarketScanVerifier();
  /** Shared across wallets: one settled market is held by many of them. */
  private readonly resolutions = new MarketResolutionCache();
  private readonly timing = new MarketTimingResolver();
  private readonly combos = new PolymarketComboResolver();
  private readonly quotes = new ExecutionQuoteSource();
  private readonly alertService = new AlertService(runtimeConfig.webhookUrl,runtimeConfig.webhookToken);
  private pollTimer?:NodeJS.Timeout;
  private autoDeployTimer?:NodeJS.Timeout;
  private verificationTimer?:NodeJS.Timeout;
  private alertTimer?:NodeJS.Timeout;
  private activeJob?:Promise<unknown>;
  private stopping=false;
  private pauseRequested=false;
  private events:ServerEvent[]=[];
  private consecutiveFailures=0;
  private committedDuringWork?:DashboardState;

  constructor(readonly store:StateStore) { super(); }
  get state():DashboardState {
    const visible=this.committedDuringWork ?? this.store.state;
    visible.summary=summarize(visible.account);
    visible.providerStatus.queueDepth=this.waitingCount;
    visible.providerStatus.activeJob=this.activeJobName;
    visible.providerStatus.queuedJobs=[...this.waitingNames];
    if(this.pauseRequested) visible.settings.paused=true;
    return visible;
  }
  private publish(event:ServerEvent) { this.emit('event',event); }
  private tradeEvents(trades:DashboardState['account']['trades']) {
    for(const trade of trades) this.events.push({type:'paper-trade',payload:trade});
  }
  private publishState() { this.publish({type:'state',payload:this.state}); }

  private queueTail:Promise<unknown>=Promise.resolve();
  private waitingByName=new Map<string,Promise<unknown>>();
  /** Jobs running or waiting. Exposed as providerStatus.queueDepth (waiting only). */
  private queuedCount=0;
  private activeJobName?:string;
  private waitingNames:string[]=[];

  /** One mutation transaction at a time. Publish fills only after durable save.
   *
   * A request that arrives while another job runs now waits its turn instead of
   * being refused. Refusing turned every button press during a long poll into an
   * "operation failed" for the operator, with nothing actually wrong. Idempotent
   * operations coalesce: a press while the same operation is already waiting
   * joins that job rather than queueing a duplicate behind it. */
  private exclusive<T>(name:string,work:()=>Promise<T>,coalesce=false):Promise<T> {
    if(this.stopping) return Promise.reject(new Error('Engine is stopping'));
    const waiting=coalesce?this.waitingByName.get(name):undefined;
    if(waiting) return waiting as Promise<T>;
    this.queuedCount++;
    this.waitingNames.push(name);
    const start=()=>{
      if(coalesce) this.waitingByName.delete(name);
      const at=this.waitingNames.indexOf(name);if(at>=0) this.waitingNames.splice(at,1);
      return this.runExclusive(name,work);
    };
    const job=this.queueTail.then(start,start);
    this.queueTail=job.catch(()=>undefined);
    if(coalesce) this.waitingByName.set(name,job);
    void job.catch(()=>undefined).finally(()=>{ this.queuedCount--; });
    return job;
  }
  private get waitingCount() { return Math.max(0,this.queuedCount-(this.activeJob?1:0)); }
  /** A Poll once sat unfinished for nineteen hours: every later job queued
   * behind it, exits and marks stopped, and SIGTERM waited on the same queue
   * until launchd killed the process and left a stale lock. Nothing in the
   * queue can cancel in-flight work, so a job past its deadline is failed like
   * any other (state restored to the last commit), and the process then exits
   * so no orphaned continuation can touch state beside the next job. */
  private static deadlineFor(name:string) {return /^Scan/.test(name)?runtimeConfig.scanDeadlineMs:runtimeConfig.jobDeadlineMs;}
  private hung=false;
  private runExclusive<T>(name:string,work:()=>Promise<T>):Promise<T> {
    if(this.stopping) return Promise.reject(new Error('Engine is stopping'));
    const snapshot=structuredClone(this.store.state);
    this.committedDuringWork=structuredClone(snapshot);
    const startedAt=Date.now();
    const jobLog=(status:string,detail?:string)=>console.info(JSON.stringify({event:'job',name,status,durationMs:Date.now()-startedAt,detail,at:new Date().toISOString()}));
    this.activeJobName=name;
    jobLog('started');
    const deadlineMs=PapertrailOrchestrator.deadlineFor(name);
    let watchdog:NodeJS.Timeout|undefined;
    const expired=new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(new JobTimeoutError(name,deadlineMs)),deadlineMs);watchdog.unref();});
    const job=(async()=>{
      try {
        const health=this.store.state.account.workerHealth??={};
        health[name]={...health[name],startedAt:new Date().toISOString(),consecutiveFailures:health[name]?.consecutiveFailures??0,running:true,error:undefined};
        const result=await Promise.race([work(),expired]);
        // A completed operation supersedes any failure banner. Leaving the last
        // error in place meant a single upstream timeout stayed on the dashboard
        // through every successful poll that followed it.
        if(/ failed: /.test(this.store.state.providerStatus.message)) {
          this.store.state.providerStatus.message=`${name} recovered; ${this.store.state.traders.filter(t=>t.watched).length} watched · ${this.store.state.traders.filter(t=>t.selected).length} copied`;
        }
        this.logOperation(name,'completed',this.store.state.providerStatus.message);
        const row=(this.store.state.account.workerHealth??={})[name]??={consecutiveFailures:0,running:false};
        Object.assign(row,{completedAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),consecutiveFailures:0,running:false,error:undefined});
        await this.store.save();
        this.consecutiveFailures=0;
        this.committedDuringWork=undefined;
        for(const event of this.events) this.publish(event);
        this.events=[];
        this.publishState();
        jobLog('completed');
        return result;
      } catch(error) {
        jobLog('failed',messageOf(error));
        const timedOut=error instanceof JobTimeoutError;
        if(timedOut) {this.hung=true;this.stopping=true;this.pauseRequested=true;}
        this.store.state=snapshot;
        this.committedDuringWork=undefined;
        this.events=[];
        this.consecutiveFailures++;
        if(this.pauseRequested || this.stopping || this.consecutiveFailures>=3) this.store.state.settings.paused=true;
        this.store.state.providerStatus.message=`${name} failed: ${messageOf(error)}`;
        const health=this.store.state.account.workerHealth??={};
        const row=health[name]??={consecutiveFailures:0,running:false};
        Object.assign(row,{completedAt:new Date().toISOString(),consecutiveFailures:row.consecutiveFailures+1,running:false,error:messageOf(error)});
        const alert=this.alertService.add(this.store.state.account,timedOut||this.consecutiveFailures>=3?'critical':'warning',timedOut?'worker-hung':'worker-failure',this.store.state.providerStatus.message);
        this.events.push({type:'alert',payload:{level:alert.level,code:alert.code,message:alert.message,at:alert.createdAt}});
        this.logOperation(name,'failed',this.store.state.providerStatus.message);
        this.publish({type:'error',payload:{message:this.store.state.providerStatus.message}});
        // Failure to persist the account/control state blocks further entries.
        try { await this.store.save(); } catch { this.pauseRequested=true; this.store.state.settings.paused=true; }
        this.publishState();
        if(timedOut) this.emit('hung',error);
        throw error;
      } finally { clearTimeout(watchdog);this.activeJob=undefined;this.activeJobName=undefined;this.committedDuringWork=undefined; }
    })();
    this.activeJob=job;
    return job;
  }
  private logOperation(operation:string,status:string,message:string) {
    const events=this.store.state.account.operationalEvents ??= [];
    events.push({at:new Date().toISOString(),operation,status,message});
    if(events.length>1000) events.splice(0,events.length-1000);
  }
  private safely(work:()=>Promise<unknown>) { void work().catch(()=>{ /* exclusive records and publishes failures */ }); }

  async start() {
    await this.store.load();
    this.stopping=false;
    this.pauseRequested=false;
    // Always start paused while recovery gates are evaluated.
    this.store.state.settings.paused=true;
    const account=this.store.state.account;
    if(!account.sourceWatermarks) {
      account.sourceWatermarks=Object.fromEntries(this.store.state.traders.map(t=>[t.address.toLowerCase(),Math.ceil(Date.now()/1000)]));
      // Earlier paper figures used a different execution methodology; never relabel them.
      account.methodologyVersion=account.trades.length ? 1 : 2;
    }
    account.sourceStartedAt ??= {...account.sourceWatermarks};
    const report=this.store.reconcile();
    if(!report.passed)this.alertService.add(account,'critical','startup-reconciliation','Startup reconciliation failed; paper copying remains paused');
    await this.store.save();
    if(runtimeConfig.conditionalAutoResume) await this.conditionalResume().catch(()=>undefined);
    this.publishState();
    // Background cycles only run when nothing is running or waiting: a queued
    // operator action always goes first.
    this.pollTimer=setInterval(()=>{if(this.queuedCount===0) this.safely(()=>this.poll());},runtimeConfig.pollIntervalMs);
    this.verificationTimer=setInterval(()=>{if(this.queuedCount===0) this.safely(()=>this.refreshMarks());},runtimeConfig.resultVerificationIntervalMs);
    this.alertTimer=setInterval(()=>this.safely(()=>this.deliverAlerts()),30_000);
    // Startup is always paused, so the scan/deploy cycle stays idle until the
    // operator resumes. Result verification and risk exits above keep running
    // regardless, so open positions are never left unmanaged while paused.
    this.scheduleAutoDeploy();
  }
  /** True once a job overran its deadline; the process is expected to exit. */
  get isHung() {return this.hung;}
  async stop(drainMs=runtimeConfig.shutdownDrainMs) {
    this.stopping=true;
    this.pauseRequested=true;
    this.store.state.settings.paused=true;
    if(this.pollTimer) clearInterval(this.pollTimer);
    if(this.verificationTimer) clearInterval(this.verificationTimer);
    if(this.alertTimer) clearInterval(this.alertTimer);
    if(this.autoDeployTimer) clearTimeout(this.autoDeployTimer);
    // Bounded: a shutdown that waits on a hung queue never releases the lock.
    // Past the deadline the in-flight job's partial mutations are discarded in
    // favour of the last committed state, exactly as a failed job would be.
    let timer:NodeJS.Timeout|undefined;
    const drained=await Promise.race([this.queueTail.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),drainMs);})]);
    clearTimeout(timer);
    if(!drained) {
      console.error(JSON.stringify({event:'shutdown-abandoned-job',name:this.activeJobName,at:new Date().toISOString()}));
      if(this.committedDuringWork) this.store.state=this.committedDuringWork;
      this.hung=true;
      this.store.state.settings.paused=true;
    }
    this.quotes.close();
    await this.store.save();
    await this.store.close();
  }
  private async deliverAlerts(){return this.exclusive('Alerts',async()=>{await this.alertService.deliverPending(this.store.state.account);},true);}
  private scheduleAutoDeploy(delay=runtimeConfig.autoDeployIntervalMs) {
    if(this.autoDeployTimer) clearTimeout(this.autoDeployTimer);
    this.autoDeployTimer=undefined;
    // No cycle while stopping or paused: the recurring scan exists to open
    // positions, so it starts on Resume and stops on Pause rather than running
    // in the background against an engine the operator has switched off.
    if(this.stopping||this.pauseRequested||this.store.state.settings.paused) {
      this.store.state.providerStatus.nextAutoDeployAt=undefined;
      return;
    }
    this.store.state.providerStatus.nextAutoDeployAt=new Date(Date.now()+delay).toISOString();
    this.autoDeployTimer=setTimeout(()=>{
      // Enqueue and wait its turn. The queue gives it priority over the next poll,
      // so it can no longer be starved by polls that outrun their own interval.
      this.safely(async()=>{
        try { if(!this.store.state.settings.paused) await this.scanAndDeploy(true); }
        finally { this.scheduleAutoDeploy(); }
      });
    },delay);
  }
  private async fetchExecution(assets:Array<{asset:string;conditionId:string}>) {
    const context=await this.quotes.fetch(assets);
    this.store.state.providerStatus.polymarketConnected=this.store.state.providerStatus.polymarketConnected||this.quotes.streamConnected;
    const consumed=this.store.state.account.quoteConsumption ??= {};
    for(const key of Object.keys(consumed)) {
      const capturedAt=Number(key.slice(key.lastIndexOf(':')+1));
      if(!Number.isFinite(capturedAt)||Date.now()-capturedAt>120_000) delete consumed[key];
    }
    context.consumed=consumed;
    return context;
  }
  private async fetchLeaderboard() {
    const settings=this.store.state.settings.scanner;
    if(this.arkham) {
      try {
        const candidates=await this.arkham.leaderboard(settings.period,settings.candidatePoolSize);
        Object.assign(this.store.state.providerStatus,{primary:'arkham',arkhamConnected:true});
        return candidates;
      } catch {this.store.state.providerStatus.arkhamConnected=false;}
    }
    const candidates=await this.polymarket.leaderboard(settings.category,settings.period,settings.candidatePoolSize);
    Object.assign(this.store.state.providerStatus,{primary:'polymarket',polymarketConnected:true});
    return candidates;
  }
  private refreshSelection() {
    const state=this.store.state;
    state.traders=preserveSelectionOverrides(selectTraders(state.traders,state.settings.scanner),state.traders,state.settings.scanner.maxTrackedTraders,state.settings.scanner.maxWatchedTraders);
    state.scanFunnel.watched=state.traders.filter(t=>t.watched).length;
    state.scanFunnel.copied=state.traders.filter(t=>t.selected).length;
  }
  /** Keep following exits for removed/muted owners until the last copied lot is closed. */
  private monitoredTraders():TraderCandidate[] {
    const map=new Map(this.store.state.traders.filter(t=>t.selected).map(t=>[t.address.toLowerCase(),t]));
    for(const position of this.store.state.account.positions) {
      const key=position.traderAddress.toLowerCase();
      if(!map.has(key)) {
        const existing=this.store.state.traders.find(t=>t.address.toLowerCase()===key);
        map.set(key,existing ?? {address:key,name:position.traderName,provider:'polymarket',rank:0,pnl:0,volume:0,roi:null,winRate:null,trades:null,score:0,watched:false,selected:false,verification:{provider:'polymarketscan',checkedAt:new Date(0).toISOString(),url:'',status:'unavailable',notes:[]},reasons:['Exit-only monitoring'],openPositions:1});
      }
    }
    return [...map.values()];
  }
  /** Wallets whose snapshot could not be fetched this cycle. Their signals are
   * skipped rather than acted on: an absent snapshot must never read as an empty
   * one, because the sell path would then mirror a full-size exit. */
  private snapshotUnavailable=new Set<string>();
  /** Wallets whose snapshot recently exceeded the paging budget, with the time
   * the attempt may be retried. A wallet that just failed 20 paginated requests
   * will fail them again 15 seconds later; re-trying every poll made each poll
   * take twice its own interval, so the engine was busy around the clock and
   * every manual request bounced off the guard. */
  private snapshotBackoff=new Map<string,number>();
  private static readonly SNAPSHOT_BACKOFF_MS=60*60_000;
  private async fetchAllPositions(traders:TraderCandidate[]):Promise<SourcePosition[]> {
    // Public canonical positions also avoid provider failover semantics. One
    // wallet's failure (typically an oversized snapshot) is isolated to that
    // wallet; failing the whole poll took every trader offline for one bad fetch.
    this.snapshotUnavailable=new Set();
    const now=Date.now();
    const groups=await mapLimited(traders,4,async trader=>{
      const key=trader.address.toLowerCase();
      const retryAt=this.snapshotBackoff.get(key);
      if(retryAt!==undefined&&retryAt>now) { this.snapshotUnavailable.add(key); return [] as SourcePosition[]; }
      try {
        const positions=stampSourcePositions(await this.polymarket.positions(trader.address));
        this.snapshotBackoff.delete(key);
        return positions;
      } catch(error) {
        this.snapshotUnavailable.add(key);
        const budget=/offset budget/.test(messageOf(error));
        if(budget) this.snapshotBackoff.set(key,now+PapertrailOrchestrator.SNAPSHOT_BACKOFF_MS);
        this.logOperation('Positions','skipped',`${trader.name}: ${messageOf(error)}${budget?' (retry in 1h)':''}`);
        return [] as SourcePosition[];
      }
    });
    return groups.flat();
  }
  private async fetchActivity(traders:TraderCandidate[]):Promise<SourceTrade[]> {
    const account=this.store.state.account;
    const now=Date.now()/1000;
    const maxAge=this.store.state.settings.risk.maxSignalAgeSeconds ?? 120;
    account.sourceWatermarks ??= {};
    account.sourceStartedAt ??= {};
    return (await mapLimited(traders,4,async trader=>{
      const key=trader.address.toLowerCase();
      if(account.sourceWatermarks![key]===undefined) {account.sourceWatermarks![key]=Math.ceil(now);account.sourceStartedAt![key]=Math.ceil(now);return [];}
      const since=Math.max(account.sourceWatermarks![key]-5,account.sourceStartedAt![key] ?? 0,now-maxAge);
      // Lenient for the same reason as the single-page fetch: a malformed row is
      // skipped and never acted on, but aborting the whole window discarded every
      // valid signal with it and, after three failures, force-paused the engine.
      const receivedAt=new Date().toISOString();
      return (await this.polymarket.activitySince(key,since,'lenient')).map(t=>({...t,traderName:trader.name,receivedAt,normalizedAt:receivedAt}));
    })).flat();
  }
  async runScan(_bootstrapIfEmpty=false) {return this.exclusive('Scan',()=>this.scanCore(),true);}
  private async scanCore() {
    const state=this.store.state;
    state.providerStatus.scanning=true;
    try {
      const previous=state.traders;
      const priorSelected=new Set(previous.filter(t=>t.selected).map(t=>t.address.toLowerCase()));
      const candidates=await this.fetchLeaderboard();
      if(!candidates.length) throw new Error('Discovery returned no candidates');
      // A pinned wallet is copied by address, not by leaderboard rank, so it must
      // be re-verified every scan whether or not today's board lists it. Without
      // this an off-board pin was never re-checked, its cross-check aged into a
      // hard failure within a day, and the pin went dark with no operator action.
      const listed=new Set(candidates.map(c=>c.address.toLowerCase()));
      for(const pin of previous) {
        if(pin.selectionOverride==='include'&&!listed.has(pin.address.toLowerCase())) candidates.push({...pin,rank:candidates.length+1,leaderboardPeriods:undefined});
      }
      const activityChecked=await mapLimited(candidates,8,async candidate=>{
        const latest=await this.polymarket.activity(candidate.address,1).catch(()=>[]);
        return {...candidate,lastActivityAt:latest[0]?new Date(latest[0].timestamp*1000).toISOString():undefined};
      });
      const cutoff=Date.now()-state.settings.scanner.maxInactiveHours*3_600_000;
      const recentlyActive=(t:TraderCandidate)=>Date.parse(t.lastActivityAt ?? '')>=cutoff && Date.parse(t.lastActivityAt!)<=Date.now()+60_000;
      // Pinned wallets are always re-verified. Verifying only active wallets left a
      // dormant pin with day-old evidence, and "stale cross-check" is a reason a
      // pin cannot waive — so inactivity blocked the pin through a side door.
      const pinned=new Set(previous.filter(t=>t.selectionOverride==='include').map(t=>t.address.toLowerCase()));
      const active=activityChecked.filter(t=>recentlyActive(t) || pinned.has(t.address.toLowerCase()));
      const scored=await mapLimited(active,4,async candidate=>scoreTrader(candidate,await this.verifier.verify(candidate.address)));
      const scores=new Map(scored.map(t=>[t.address,t]));
      // Tier 1 always runs the win-rate screen, never the expectancy floor: no
      // wallet has been measured yet at this point, so applying the edge floor
      // here would reject the entire pool as unmeasured and leave tier 2 an empty
      // shortlist to work from.
      const screen={...state.settings.scanner,edgeRanking:false};
      const screened=preserveSelectionOverrides(selectTraders(activityChecked.map(t=>scores.get(t.address) ?? scoreTrader(t,t.verification)),screen),previous,screen.maxTrackedTraders,screen.maxWatchedTraders);
      // Tier 1 above is the cheap screen over the whole pool. Tier 2 measures
      // expectancy, and only for the shortlist it produced: reconstructing a
      // settled record costs a request per wallet plus its markets.
      // Display-only measurement runs after the scan, off the engine lock: a cold
      // pass over a hundred wallets takes minutes, and holding the lock for it
      // would stall live copying for exactly that long.
      state.traders=state.settings.scanner.edgeRanking===true
        ? await this.rankByMeasuredEdge(screened,previous)
        : screened.map(t=>{const edge=this.lastMeasured.get(t.address.toLowerCase());return edge?{...t,edge}:t;});
      if(state.settings.scanner.edgeRanking!==true) this.measureInBackground(screened.filter(t=>t.watched));
      state.traders=this.applySelectionLifecycle(state.traders,previous);
      const assessedAt=new Date().toISOString();
      state.assessments=state.traders.flatMap(trader=>[
        {id:`assessment:${randomUUID()}`,traderAddress:trader.address,assessedAt,sleeve:'champion' as const,eligible:Boolean(trader.selected),reasons:trader.reasons,label:'insufficient-evidence' as const,capacityUsd:trader.volume*.05},
        {id:`assessment:${randomUUID()}`,traderAddress:trader.address,assessedAt,sleeve:'challenger' as const,eligible:Boolean(trader.edge?.eligible),reasons:trader.edge?.eligible?[]:trader.reasons,effectiveSampleSize:trader.edge?.effectiveSampleSize,meanEdge:trader.edge?.meanEdge,edgeLowerBound:trader.edge?.edgeLowerBound,cvar95Loss:trader.edge?.cvar95Loss,rankingRatio:trader.edge?.rankingRatio,capacityUsd:trader.volume*.05,label:trader.edge?'experimental' as const:'insufficient-evidence' as const},
      ]).slice(0,2000);
      state.account.sourceWatermarks ??= {};
      state.account.sourceStartedAt ??= {};
      for(const trader of state.traders.filter(t=>t.selected && !priorSelected.has(t.address.toLowerCase()))) {
        state.account.sourceWatermarks[trader.address.toLowerCase()]=Math.ceil(Date.now()/1000);
        state.account.sourceStartedAt[trader.address.toLowerCase()]=Math.ceil(Date.now()/1000);
      }
      const watched=state.traders.filter(t=>t.watched).length, copied=state.traders.filter(t=>t.selected).length;
      const checkedAt=new Date().toISOString();
      state.scanFunnel={scanned:candidates.length,active:active.length,verified:scored.filter(t=>t.verification.status==='verified').length,rejected:candidates.length-watched,watched,copied,checkedAt,periods:['DAY','WEEK','MONTH']};
      state.providerStatus.lastScanAt=checkedAt;
      state.providerStatus.polymarketScanConnected=scored.some(t=>t.verification.status==='verified');
      state.providerStatus.message=`${candidates.length} scanned · ${watched} watched · ${copied} copied; forward paper signals only`;
      return true;
    } finally {state.providerStatus.scanning=false;}
  }
  private applySelectionLifecycle(current:TraderCandidate[],previous:TraderCandidate[]) {
    const prior=new Map(previous.map(trader=>[trader.address.toLowerCase(),trader]));
    return current.map(trader=>{
      const old=prior.get(trader.address.toLowerCase());
      // Overrides are decided in preserveSelectionOverrides (a pin still yields
      // to a hard evidence failure there). Running the streak logic on top of
      // that deselected every pin after three scans, because a pin carries a
      // reason by definition and so never counts as "automatically eligible".
      if(trader.selectionOverride==='include') return {...trader,eligibilityStreak:0,softFailureStreak:0,entryEligible:trader.selected,watched:trader.watched||trader.selected};
      if(trader.selectionOverride==='exclude') return {...trader,eligibilityStreak:0,softFailureStreak:0,entryEligible:false,selected:false};
      const hardFailure=trader.verification.status!=='verified'||trader.reasons.some(reason=>/unavailable|stale|invalid timestamp|not recently active/i.test(reason));
      const automaticallyEligible=trader.selected&&trader.reasons.length===0;
      const eligibilityStreak=automaticallyEligible?(old?.eligibilityStreak??0)+1:0;
      const softFailureStreak=!hardFailure&&!automaticallyEligible?(old?.softFailureStreak??0)+1:0;
      const selected=hardFailure?false:automaticallyEligible?eligibilityStreak>=2:Boolean(old?.selected&&softFailureStreak<3);
      return {...trader,eligibilityStreak,softFailureStreak,entryEligible:selected,selected,watched:trader.watched||selected};
    });
  }
  /** Deep tier: rank the screened shortlist on measured expectancy.
   * A wallet whose record cannot be reconstructed is scored zero rather than
   * keeping its win-rate score, so a failed lookup can never leave two different
   * ranking scales mixed in one ordering. */
  /** Reconstructed settled records per wallet, kept for a few hours. Measurement
   * needs a wallet's activity plus a market lookup per lot; refetching that for
   * a hundred wallets every five-minute scan would be most of the API budget,
   * and a record only changes when another market of theirs resolves. */
  private static readonly EDGE_HISTORY_TTL_MS=6*60*60_000;
  private edgeHistories=new Map<string,{expiresAt:number;records:ResolvedTrade[];notes:string[]}>();
  /** Measure expectancy for the shortlist. Shared by ranking (edgeRanking on)
   * and by display-only measurement (edgeRanking off), so the Trader Intel edge
   * column is populated either way rather than reading "Insufficient" for
   * every wallet because nothing ever measured it. */
  private async measureEdges(shortlist:TraderCandidate[]):Promise<Map<string,EdgeSummary>> {
    const measured=new Map<string,EdgeSummary>();
    const histories=new Map<string,{records:ResolvedTrade[];notes:string[]}>();
    const now=Date.now();
    await mapLimited(shortlist,3,async trader=>{
      const key=trader.address.toLowerCase();
      const cached=this.edgeHistories.get(key);
      if(cached&&cached.expiresAt>now) {histories.set(key,{records:cached.records,notes:cached.notes});return null;}
      try {
        const tape=await this.polymarket.activityForAnalysis(trader.address,500);
        const history=await reconstructTraderHistory(tape.trades,this.resolutions,trader.address);
        const notes=tape.skipped?[...history.notes,`${tape.skipped} unparseable history rows were skipped.`]:history.notes;
        const row={records:[...history.resolvedTrades,...history.earlyExitTrades],notes:[...notes,`${history.resolvedTrades.length} held-to-resolution cycles; ${history.earlyExitTrades.length} early-exit cycles.`]};
        histories.set(key,row);
        this.edgeHistories.set(key,{...row,expiresAt:now+PapertrailOrchestrator.EDGE_HISTORY_TTL_MS});
      } catch(error) {
        measured.set(key,{trades:0,independentGroups:0,meanEdge:0,edgeLowerBound:0,
          meanReturnOnRisk:0,meanLogGrowth:0,score:0,notes:[`Record could not be reconstructed: ${messageOf(error)}`]});
      }
      return null;
    });
    for(const [key,row] of this.edgeHistories) if(row.expiresAt<=now) this.edgeHistories.delete(key);
    const scanner=this.store.state.settings.scanner;
    const parameters={confidenceLevel:(scanner.confidenceLevelPct??95)/100,minEffectiveGroups:scanner.minEffectiveEventClusters??40,maxFalseDiscoveryRate:scanner.maxFalseDiscoveryRatePct??10,minPositiveFoldPct:scanner.minPositiveFoldPct??70,maxProfitContributionPct:scanner.maxProfitConcentrationPct??20};
    const preliminary=[...histories.values()].map(row=>estimateEdge(row.records,{...parameters,shrinkageK:0,bootstrapIterations:500}));
    const pool=estimateShrinkagePool(preliminary);
    for(const [key,history] of histories) measured.set(key,{...estimateEdge(history.records,{...parameters,...pool}),notes:history.notes,label:'experimental'});
    const entries=[...measured.entries()];
    const qValues=benjaminiHochberg(entries.map(([,edge])=>edge.pValue??1));
    entries.forEach(([key,edge],index)=>{
      edge.falseDiscoveryRate=100*qValues[index];
      edge.eligible=Boolean(edge.eligible&&edge.falseDiscoveryRate<=(this.store.state.settings.scanner.maxFalseDiscoveryRatePct??10));
      if(!edge.eligible) edge.score=0;
      measured.set(key,edge);
    });
    return measured;
  }
  /** Display-only measurement. Network work happens outside the engine lock;
   * only the attach step takes it, briefly. At most a handful of uncached
   * wallets per pass, so a cold shortlist fills in over a few scans instead of
   * competing with the poll for the data API all at once. */
  private lastMeasured=new Map<string,EdgeSummary>();
  private measuring=false;
  private static readonly EDGE_UNCACHED_PER_PASS=25;
  private measureInBackground(shortlist:TraderCandidate[]) {
    if(this.measuring||this.stopping||!shortlist.length) return;
    const now=Date.now();
    const cached=shortlist.filter(t=>(this.edgeHistories.get(t.address.toLowerCase())?.expiresAt ?? 0)>now);
    const uncached=shortlist.filter(t=>!cached.includes(t)).slice(0,PapertrailOrchestrator.EDGE_UNCACHED_PER_PASS);
    this.measuring=true;
    void (async()=>{
      try {
        const measured=await this.measureEdges([...cached,...uncached]);
        for(const [key,edge] of measured) this.lastMeasured.set(key,edge);
        if(this.stopping) return;
        await this.exclusive('Edge measurement',async()=>{
          const state=this.store.state;
          state.traders=state.traders.map(t=>{const edge=measured.get(t.address.toLowerCase());return edge?{...t,edge}:t;});
        },true);
      } catch { /* exclusive records and publishes failures; the next scan retries */ }
      finally { this.measuring=false; }
    })();
  }
  private async rankByMeasuredEdge(screened:TraderCandidate[],previous:TraderCandidate[]):Promise<TraderCandidate[]> {
    const shortlist=screened.filter(t=>t.watched);
    if(!shortlist.length) return screened;
    const measured=await this.measureEdges(shortlist);
    const scanner=this.store.state.settings.scanner;
    const rescored=screened.map(t=>{
      const edge=measured.get(t.address.toLowerCase());
      return edge?scoreTrader(t,t.verification,edge):t;
    });
    return preserveSelectionOverrides(selectTraders(rescored,scanner),previous,scanner.maxTrackedTraders,scanner.maxWatchedTraders);
  }
  async poll() {
    if(this.store.state.settings.paused) return;
    return this.exclusive('Poll',async()=>{
      const state=this.store.state;
      state.providerStatus.polling=true;
      try {
        const traders=this.monitoredTraders();
        if(!traders.length) return;
        const pollWindowEnd=Math.floor(Date.now()/1000);
        const [activity,positions]=await Promise.all([this.fetchActivity(traders),this.fetchAllPositions(traders)]);
        const processed=new Set(state.account.processedSourceTradeIds);
        // A retryable event outlives its trader's selection only as dead weight:
        // the loop below skips traders it no longer monitors, so the event was
        // never decided, never expired, and had its quote fetched every poll.
        const monitored=new Set(traders.map(t=>t.address.toLowerCase()));
        const pending=(state.account.pendingSourceEvents??[]).filter(t=>monitored.has(t.traderAddress.toLowerCase()));
        state.account.pendingSourceEvents=pending;
        const fresh=[...pending,...activity.filter(t=>!processed.has(t.id))].filter((t,i,rows)=>rows.findIndex(row=>row.id===t.id)===i).sort((a,b)=>a.timestamp-b.timestamp || a.id.localeCompare(b.id));
        await this.stampMarketTags(fresh);
        const execution=await this.fetchExecution([...state.account.positions,...fresh]);
        await this.markAndEnrichPositions(positions,false,execution);
        const byAddress=new Map(traders.map(t=>[t.address.toLowerCase(),t]));
        for(const source of fresh) {
          const trader=byAddress.get(source.traderAddress.toLowerCase());
          if(!trader) continue;
          if(this.snapshotUnavailable.has(source.traderAddress.toLowerCase())) {
            // Leave the event unprocessed so the next cycle can act on it.
            continue;
          }
          // Pause is immediate even while network requests were in flight; exit checks continue.
          const allowEntry=!state.settings.paused && !this.pauseRequested && !this.stopping && trader.selected;
          // A current post-batch wallet snapshot cannot reconstruct each intermediate sell fraction.
          const ownerAssetEvents=fresh.filter(t=>t.traderAddress===source.traderAddress && t.asset===source.asset).length;
          const sourceExecution=ownerAssetEvents===1 ? execution : {...execution,sourcePositionsAsOf:undefined};
          const trade=applySourceTrade(state.account,source,{...trader,selected:allowEntry},state.settings.risk,positions,Date.now(),sourceExecution);
          this.tradeEvents([trade]);
        }
        state.account.sourceWatermarks ??= {};
        for(const trader of traders) state.account.sourceWatermarks[trader.address.toLowerCase()]=pollWindowEnd;
        state.sourceTrades=[...fresh,...state.sourceTrades].filter((t,i,rows)=>rows.findIndex(x=>x.id===t.id)===i).sort((a,b)=>b.timestamp-a.timestamp).slice(0,250);
        this.tradeEvents(enforceRiskLimits(state.account,state.settings.risk,Date.now(),execution));
        this.recordEquity();
        state.providerStatus.lastPollAt=new Date().toISOString();
      } finally {state.providerStatus.polling=false;}
    });
  }
  /** Resolve event tags once per event and stamp them on each signal, so the
   * engine can decide on the market itself rather than only on who traded it.
   * A signal whose tags cannot be established keeps `undefined` and is refused
   * by the engine whenever a tag filter is configured. */
  private async stampMarketTags<T extends {eventSlug?:string;marketTags?:string[]}>(items:T[]):Promise<T[]> {
    if(!(this.store.state.settings.risk.allowedMarketTags ?? []).length) return items;
    const slugs=[...new Set(items.map(i=>i.eventSlug).filter((s):s is string=>Boolean(s)))];
    const bySlug=new Map<string,string[]|undefined>();
    await mapLimited(slugs,6,async slug=>{
      bySlug.set(slug,await this.resolutions.tags(slug).catch(()=>undefined));
      return null;
    });
    for(const item of items) item.marketTags=item.eventSlug?bySlug.get(item.eventSlug):undefined;
    return items;
  }
  private recordEquity() {
    recordEquityPoint(this.store.state.account);
  }
  private async markAndEnrichPositions(positions:SourcePosition[],force=false,execution:ExecutionContext={}) {
    const state=this.store.state;
    markPositions(state.account,positions,Date.now(),execution,state.settings.risk);
    await this.timing.enrich(state.account.positions,force);
    await this.combos.enrich(state.account.positions,force);
    this.tradeEvents(settleResolvedPositions(state.account));
    this.tradeEvents(liquidatePositionsOutsideHorizon(state.account,state.settings.risk.maxPositionDurationDays,Date.now(),state.settings.risk,execution));
    this.tradeEvents(enforceRiskLimits(state.account,state.settings.risk,Date.now(),execution));
    this.recordEquity();
    if(state.account.riskHalt) state.settings.paused=true;
    if(force) state.providerStatus.lastVerificationAt=new Date().toISOString();
    if(this.quotes.lastUnavailableCount) {
      const why=summarizeUnavailable(this.quotes.lastUnavailable ?? []);
      state.providerStatus.message=`${this.quotes.lastUnavailableCount} executable quotes unavailable${why?` (${why})`:''}; affected fills blocked`;
    }
  }
  async refreshMarks() {
    return this.exclusive('Verification',async()=>{
      const state=this.store.state;
      state.providerStatus.verifying=true;
      try {
        const positions=await this.fetchAllPositions(this.monitoredTraders());
        const execution=await this.fetchExecution(state.account.positions);
        await this.markAndEnrichPositions(positions,true,execution);
      } finally {state.providerStatus.verifying=false;}
    });
  }
  async scanAndDeploy(automatic=false):Promise<DeployReport> {
    return this.exclusive('Scan and deploy',async()=>{
      const state=this.store.state;
      if(state.settings.paused || state.account.riskHalt) throw new Error('Paper copying is paused or risk halted');
      state.providerStatus.autoDeploying=automatic;
      try {
        // The operator's button always rescans. An automatic cycle reuses a
        // recent discovery pass: the deploy itself takes seconds, the scan
        // minutes, and the whole time it holds the lock no signal is copied.
        const lastScan=Date.parse(state.providerStatus.lastScanAt??'');
        if(!automatic||!Number.isFinite(lastScan)||Date.now()-lastScan>=runtimeConfig.discoveryIntervalMs) await this.scanCore();
        const traders=state.traders.filter(t=>t.selected);
        const positions=await this.fetchAllPositions(this.monitoredTraders());
        const eligible=new Set(traders.map(t=>t.address.toLowerCase()));
        const entries=positions.filter(p=>eligible.has(p.traderAddress.toLowerCase()) && !p.redeemable && p.size>0).slice(0,100);
        await this.stampMarketTags(entries);
        const execution=await this.fetchExecution([...state.account.positions,...entries]);
        await this.markAndEnrichPositions(positions,true,execution);
        if(state.settings.paused || this.pauseRequested || this.stopping || state.account.riskHalt) return {attempted:0,filled:0,positionsAffected:0,skipped:0,deployed:0,exposurePct:accountEquity(state.account)>0?100*accountExposure(state.account)/accountEquity(state.account):0,message:'Paper deployment stopped by pause or risk control; risk actions preserved'};
        const trades=deployCurrentPositions(state.account,entries,traders,state.settings.risk,Date.now(),execution);
        this.tradeEvents(trades);
        this.recordEquity();
        const filled=trades.filter(t=>t.status==='filled');
        const positionsAffected=new Set(filled.map(t=>`${t.traderAddress}:${t.asset}`)).size;
        const deployed=filled.reduce((sum,t)=>sum+t.notional+(t.fees ?? 0),0);
        const equity=accountEquity(state.account);
        const report={attempted:trades.length,filled:filled.length,positionsAffected,skipped:trades.length-filled.length,deployed,exposurePct:equity>0?100*accountExposure(state.account)/equity:0,message:`${filled.length} paper fills; ${trades.length-filled.length} rejected; ${deployed.toFixed(2)} capital including fees`};
        state.providerStatus.lastAutoDeployAt=new Date().toISOString();
        state.providerStatus.lastAutoDeployMessage=report.message;
        return report;
      } finally {state.providerStatus.autoDeploying=false;}
    },true);
  }
  async updateSettings(patch:{paused?:boolean;risk?:Partial<RiskSettings>;scanner?:Partial<ScannerSettings>}) {
    if(patch.paused===true) {
      this.pauseRequested=true;
      this.store.state.settings.paused=true;
      this.scheduleAutoDeploy();
      this.publishState();
      await this.activeJob?.catch(()=>undefined);
    }
    return this.exclusive('Settings',async()=>{
      const state=this.store.state;
      if(patch.paused===false && state.account.riskHalt) throw new Error(`Latched risk halt: ${state.account.riskHalt.reason}. Export and investigate this account before an explicit paper reset.`);
      state.settings=parseSettings({...state.settings,...patch,risk:{...state.settings.risk,...patch.risk},scanner:{...state.settings.scanner,...patch.scanner}});
      if(patch.paused===false) {
        this.pauseRequested=false;
        // Resumption starts forward from now. Paused/migrated historical trades are never replayed.
        state.account.sourceWatermarks=Object.fromEntries(this.monitoredTraders().map(t=>[t.address.toLowerCase(),Math.ceil(Date.now()/1000)]));
      }
      state.account.sourceStartedAt={...state.account.sourceWatermarks,...state.account.sourceStartedAt};
      if(patch.paused===false) state.account.sourceStartedAt={...state.account.sourceWatermarks};
      this.refreshSelection();
      if(patch.paused!==undefined) this.scheduleAutoDeploy();
      if(patch.risk && state.account.positions.length) {
        const execution=await this.fetchExecution(state.account.positions);
        await this.markAndEnrichPositions([],false,execution);
      }
    });
  }
  async reconcile() {
    return this.exclusive('Reconciliation',async()=>{
      const report=this.store.reconcile();
      if(!report.passed)this.alertService.add(this.store.state.account,'critical','reconciliation-failed','Account reconciliation found a cash, position, or duplicate-event discrepancy');
      return report;
    },true);
  }
  async testWebhook() {
    return this.exclusive('Webhook test',async()=>{
      const eventId=await this.alertService.test();
      this.store.state.account.webhookTestedAt=new Date().toISOString();
      return {eventId,testedAt:this.store.state.account.webhookTestedAt};
    },true);
  }
  async acknowledgeAlert(id:string) {
    return this.exclusive('Alert acknowledgement',async()=>{
      const alert=(this.store.state.account.alerts??[]).find(row=>row.id===id);
      if(!alert)throw new Error('Alert not found');
      alert.acknowledgedAt=new Date().toISOString();
      return alert;
    });
  }
  async approvePaperRelease(note:string) {
    return this.exclusive('Paper release approval',async()=>{
      const state=this.store.state;
      state.account.approvedCodeHash=currentCodeHash();
      state.account.approvedConfigHash=state.account.configHash;
      state.settings.paused=true;this.pauseRequested=true;
      this.logOperation('Paper release approval','completed',`Approved current code/config hashes; note: ${note||'none'}`);
      return {codeHash:state.account.approvedCodeHash,configHash:state.account.approvedConfigHash};
    });
  }
  async conditionalResume() {
    return this.exclusive('Conditional resume',async()=>{
      const state=this.store.state,account=state.account,now=Date.now();
      const latest=account.reconciliations?.[0];
      // A refused resume must not lock the next attempt out: its own alert is
      // informational and is not counted here.
      const critical=(account.alerts??[]).filter(alert=>alert.level==='critical'&&!alert.acknowledgedAt&&alert.code!=='conditional-resume-blocked');
      const freshness=Math.max((state.settings.risk.maxSignalAgeSeconds??120)*1000,runtimeConfig.resultVerificationIntervalMs*2);
      const feedTimes=[state.providerStatus.lastScanAt,state.providerStatus.lastVerificationAt].map(value=>Date.parse(value??''));
      // Two tiers. Safety gates always block. Release-ceremony gates (clean
      // shutdown, reconciliation, approved hashes, webhook drill) block only when
      // the operator has opted into release control by pinning APPROVED_CODE_HASH;
      // otherwise they are reported as advisories. Every build changes the code
      // hash and every settings change the config hash, so for a paper account
      // with nothing pinned the strict form made Resume a dead button.
      const strict=Boolean(runtimeConfig.approvedCodeHash);
      const checks=[
        {name:'No risk halt',passed:!account.riskHalt,blocking:true},
        {name:'SQLite integrity check',passed:this.store.integrityCheck(),blocking:true},
        {name:'No unacknowledged critical alert',passed:critical.length===0,blocking:true},
        {name:'Previous shutdown was clean',passed:account.cleanShutdown===true,blocking:strict},
        {name:'Ledgers reconcile',passed:Boolean(latest?.passed)&&!account.reconciliationRequired,blocking:strict},
        {name:'Critical feeds are fresh',passed:feedTimes.every(value=>Number.isFinite(value)&&now-value<=freshness),blocking:strict},
        {name:'Approved code hash matches',passed:Boolean(account.approvedCodeHash)&&account.approvedCodeHash===currentCodeHash()&&(!runtimeConfig.approvedCodeHash||runtimeConfig.approvedCodeHash===account.approvedCodeHash),blocking:strict},
        {name:'Approved configuration hash matches',passed:Boolean(account.approvedConfigHash)&&account.approvedConfigHash===account.configHash,blocking:strict},
        {name:'Webhook test is recent',passed:Boolean(runtimeConfig.webhookUrl)&&Number.isFinite(Date.parse(account.webhookTestedAt??''))&&now-Date.parse(account.webhookTestedAt!)<24*60*60_000,blocking:strict||Boolean(runtimeConfig.webhookUrl)},
      ];
      const failed=checks.filter(check=>!check.passed&&check.blocking);
      const warnings=checks.filter(check=>!check.passed&&!check.blocking).map(check=>check.name);
      if(failed.length) {
        state.settings.paused=true;this.pauseRequested=true;
        const alert=this.alertService.add(account,'warning','conditional-resume-blocked',`Paper resume blocked: ${failed.map(check=>check.name).join(', ')}`);
        this.events.push({type:'alert',payload:{level:alert.level,code:alert.code,message:alert.message,at:alert.createdAt}});
        return {resumed:false,checks,warnings};
      }
      state.settings.paused=false;this.pauseRequested=false;
      account.sourceWatermarks=Object.fromEntries(this.monitoredTraders().map(trader=>[trader.address.toLowerCase(),Math.ceil(now/1000)]));
      account.sourceStartedAt={...account.sourceWatermarks};this.scheduleAutoDeploy(1000);
      // Replace the restart banner: it otherwise outlives the pause it describes.
      state.providerStatus.message=warnings.length?`Paper copying resumed · advisories: ${warnings.join(', ')}`:'Paper copying resumed; all release gates passed';
      this.logOperation('Conditional resume','completed',warnings.length?`advisories: ${warnings.join(', ')}`:'all release gates passed');
      return {resumed:true,checks,warnings};
    },true);
  }
  async emergencyHalt(reason:string) {
    this.pauseRequested=true;this.store.state.settings.paused=true;this.publishState();
    return this.exclusive('Emergency halt',async()=>{
      const state=this.store.state;
      state.account.riskHalt={reason:`Emergency halt: ${reason||'operator requested'}`,triggeredAt:new Date().toISOString(),liquidate:true};
      const execution=await this.fetchExecution(state.account.positions);
      const trades=enforceRiskLimits(state.account,state.settings.risk,Date.now(),execution);
      this.tradeEvents(trades);
      this.alertService.add(state.account,'critical','emergency-halt',state.account.riskHalt.reason);
      return {halted:true,exits:trades.length};
    });
  }
  async toggleTrader(address:string,selected:boolean,name?:string) {
    return this.exclusive('Trader selection',async()=>{
      const state=this.store.state;
      let trader=state.traders.find(t=>t.address.toLowerCase()===address.toLowerCase());
      if(!trader) {
        if(!selected) throw new Error('Trader not found');
        // Pin by address: a wallet does not have to be on today's leaderboard to
        // be copied. It is verified now and re-verified on every scan like any pin.
        trader=await this.candidateByAddress(address,name);
        state.traders.push(trader);
      }
      trader.selectionOverride=selected?'include':'exclude';
      this.refreshSelection();
      state.account.sourceWatermarks ??= {};
      if(selected) {state.account.sourceWatermarks[address.toLowerCase()]=Math.ceil(Date.now()/1000);(state.account.sourceStartedAt ??= {})[address.toLowerCase()]=Math.ceil(Date.now()/1000);}
    });
  }
  private async candidateByAddress(address:string,name?:string):Promise<TraderCandidate> {
    const key=address.toLowerCase();
    const [verification,latest]=await Promise.all([this.verifier.verify(key),this.polymarket.activity(key,1).catch(()=>[] as SourceTrade[])]);
    const candidate:TraderCandidate={
      address:key,name:name?.trim()||`${key.slice(0,6)}…${key.slice(-4)}`,provider:'polymarket',rank:this.store.state.traders.length+1,
      pnl:verification.pnl ?? 0,volume:verification.volume ?? 0,roi:verification.roi ?? null,winRate:null,trades:null,score:0,
      watched:true,selected:false,verification,reasons:[],openPositions:0,
      lastActivityAt:latest[0]?new Date(latest[0].timestamp*1000).toISOString():undefined,
    };
    return scoreTrader(candidate,verification);
  }
  /** Clear a latched drawdown halt without discarding the account.
   * The halt exists to force a human look, not to erase the evidence; the only
   * previous way out was a full paper reset, which threw away the whole forward
   * run. The high-water mark is re-based to current equity so the same drawdown
   * cannot re-trip immediately, the acknowledgement is written to the audit log,
   * and the engine stays paused: resuming is a separate, explicit decision. */
  async acknowledgeHalt(note:string) {
    return this.exclusive('Halt acknowledged',async()=>{
      const state=this.store.state;
      if(!state.account.riskHalt) throw new Error('No risk halt is latched');
      const equity=accountEquity(state.account);
      const cleared=state.account.riskHalt;
      state.account.riskHalt=undefined;
      state.account.highWaterEquity=equity;
      state.settings.paused=true;
      this.logOperation('Halt acknowledged','completed',`${cleared.reason} (latched ${cleared.triggeredAt}); re-based at ${equity.toFixed(2)}; note: ${note||'none'}`);
      state.providerStatus.message=`Risk halt acknowledged; re-based at ${equity.toFixed(2)}. Review positions, then resume deliberately.`;
    });
  }
  async resetSimulation() {
    return this.exclusive('Paper reset',async()=>{
      await this.store.archive();
      this.store.state.account=createPaperAccount(this.store.state.settings.risk.startingBalance);
      this.store.state.account.methodologyVersion=3;
      this.store.state.account.sourceWatermarks=Object.fromEntries(this.monitoredTraders().map(t=>[t.address.toLowerCase(),Math.ceil(Date.now()/1000)]));
      this.store.state.account.sourceStartedAt={...this.store.state.account.sourceWatermarks};
      this.store.state.sourceTrades=[];
      this.store.state.settings.paused=true;
      this.pauseRequested=true;
    });
  }
}
function messageOf(error:unknown) {return error instanceof Error?error.message:String(error);}
