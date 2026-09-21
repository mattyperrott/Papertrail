import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DashboardState, PaperAccount, ProviderStatus, ReconciliationReport, TraderCandidate } from '../shared/types.js';
import { calculatePerformance } from './performance.js';
import { defaultSettings, parseSettings } from './config.js';
import { accountEquity, accountExposure, createPaperAccount } from './paperEngine.js';
import { SqliteJournal } from './journal.js';

const defaultDatabasePath=path.join(process.cwd(),'data','tradesnipes-v3.sqlite');
const finite=z.number().finite();
const nonnegative=finite.min(-1e-7);
const timestamp=z.string().refine(value=>Number.isFinite(Date.parse(value)),'Invalid timestamp');
const positionSchema=z.object({id:z.string().min(1),traderAddress:z.string().min(1),asset:z.string().min(1),shares:finite.positive(),avgPrice:nonnegative,currentPrice:finite.min(0).max(1),costBasis:nonnegative,currentValue:nonnegative,unrealizedPnl:finite,realizedPnl:finite,openedAt:timestamp,updatedAt:timestamp}).passthrough();
const accountSchema=z.object({startingBalance:finite.positive(),cash:nonnegative,realizedPnl:finite,positions:z.array(positionSchema),trades:z.array(z.object({id:z.string().min(1),sourceTradeId:z.string(),side:z.enum(['BUY','SELL','SETTLE']),status:z.enum(['filled','skipped']),shares:nonnegative,notional:nonnegative,realizedPnl:finite,timestamp}).passthrough()),equityHistory:z.array(z.object({timestamp,equity:finite,cash:finite,exposure:nonnegative}).passthrough()),processedSourceTradeIds:z.array(z.string()),createdAt:timestamp,highWaterEquity:nonnegative.optional()}).passthrough();

export class StateIntegrityError extends Error {
  constructor(){super('Persisted state failed integrity validation; startup stopped without replacing account history');this.name='StateIntegrityError';}
}

function assertFiniteTree(value:unknown):void {
  if(typeof value==='number'&&!Number.isFinite(value)) throw new StateIntegrityError();
  if(value&&typeof value==='object') for(const child of Object.values(value)) assertFiniteTree(child);
}
function validateAccount(value:unknown):asserts value is PaperAccount {
  if(!accountSchema.safeParse(value).success) throw new StateIntegrityError();
  const account=value as PaperAccount;
  if(new Set(account.positions.map(position=>position.id)).size!==account.positions.length) throw new StateIntegrityError();
  for(const position of account.positions) {
    const expected=position.shares*position.currentPrice;
    if(Math.abs(expected-position.currentValue)>Math.max(.01,Math.abs(expected)*1e-6)) throw new StateIntegrityError();
  }
  assertFiniteTree(account);
}
const canonical=(value:unknown):string=>value&&typeof value==='object'&&!Array.isArray(value)
  ?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>`${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  :Array.isArray(value)?`[${value.map(canonical).join(',')}]`:JSON.stringify(value);
export const configurationHash=(settings:DashboardState['settings'])=>createHash('sha256').update(canonical({risk:settings.risk,scanner:settings.scanner})).digest('hex');

const defaultProviderStatus=():ProviderStatus=>({primary:'polymarket',arkhamConfigured:Boolean(process.env.ARKHAM_API_KEY?.trim()),arkhamConnected:false,polymarketConnected:false,polymarketScanConnected:false,scanning:false,polling:false,verifying:false,autoDeploying:false,message:'Starting data services…'});

export function summarize(account:PaperAccount) {
  const equity=accountEquity(account),exposure=accountExposure(account);
  const cycles=(account.completedCycles??[]).filter(cycle=>cycle.complete),settledTrades=account.trades.filter(trade=>(trade.side==='SELL'||trade.side==='SETTLE')&&trade.status==='filled');
  const wins=cycles.length?cycles.filter(cycle=>cycle.pnl>0).length:settledTrades.filter(trade=>trade.realizedPnl>0).length;
  const observations=cycles.length||settledTrades.length;
  return {equity,totalPnl:equity-account.startingBalance,totalReturnPct:account.startingBalance?100*(equity-account.startingBalance)/account.startingBalance:0,exposure,exposurePct:equity?100*exposure/equity:0,openPositions:account.positions.length,filledTrades:account.trades.filter(trade=>trade.status==='filled').length,skippedTrades:account.trades.filter(trade=>trade.status==='skipped').length,winRate:observations?100*wins/observations:0,...calculatePerformance(account)};
}

export function createInitialState():DashboardState {
  const account=createPaperAccount(defaultSettings.risk.startingBalance);
  return {settings:structuredClone(defaultSettings),providerStatus:defaultProviderStatus(),traders:[],sourceTrades:[],scanFunnel:{scanned:0,active:0,verified:0,rejected:0,watched:0,copied:0,periods:['DAY','WEEK','MONTH']},account,summary:summarize(account),assessments:[],validationRuns:[]};
}

export class StateStore {
  state:DashboardState=createInitialState();
  private writeQueue=Promise.resolve();
  private lastWriteError?:Error;
  private loadFailed=false;
  private closed=false;
  private loaded=false;
  private ownsLock=false;
  private readonly lockToken=randomUUID();
  private readonly legacyPath?:string;
  readonly databasePath:string;
  private readonly journal:SqliteJournal;

  constructor(filePath=defaultDatabasePath) {
    this.legacyPath=filePath.endsWith('.json')?filePath:undefined;
    this.databasePath=filePath.endsWith('.json')?filePath.replace(/\.json$/,'.sqlite'):filePath;
    this.journal=new SqliteJournal(this.databasePath);
  }
  get healthy(){return !this.loadFailed&&!this.lastWriteError&&(!this.loaded||this.journal.integrityCheck());}
  integrityCheck(){return this.journal.integrityCheck();}

  private async acquireLock() {
    if(this.ownsLock)return;
    const lockPath=`${this.databasePath}.lock`;
    await mkdir(path.dirname(this.databasePath),{recursive:true,mode:0o700});
    try{await mkdir(lockPath,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('State is locked by another or interrupted process; verify its owner has stopped before removing the SQLite lock directory');throw error;}
    try{const handle=await open(path.join(lockPath,'owner.json'),'wx',0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,token:this.lockToken,openedAt:new Date().toISOString()}));await handle.sync();}finally{await handle.close();}this.ownsLock=true;}catch(error){await rmdir(lockPath).catch(()=>undefined);throw error;}
  }

  async load() {
    this.closed=false;
    await this.acquireLock();
    try {
      this.journal.open();
      if(!this.journal.integrityCheck()) throw new StateIntegrityError();
      let parsed=this.journal.readSnapshot();
      // One-time, read-only compatibility import. JSON is never written again.
      if(!parsed&&this.legacyPath&&existsSync(this.legacyPath)) parsed=JSON.parse(await readFile(this.legacyPath,'utf8')) as DashboardState;
      if(parsed) {
        if(!parsed.settings||!Array.isArray(parsed.traders)||!Array.isArray(parsed.sourceTrades)) throw new StateIntegrityError();
        validateAccount(parsed.account);assertFiniteTree(parsed);
        const scanner={...this.state.settings.scanner,...parsed.settings.scanner};
        this.state={...this.state,...parsed,settings:parseSettings({...this.state.settings,...parsed.settings,risk:{...this.state.settings.risk,...parsed.settings.risk},scanner,paused:true}),account:parsed.account,traders:(parsed.traders as TraderCandidate[]).map(trader=>({...trader,watched:trader.watched??trader.selected??false})),scanFunnel:{...this.state.scanFunnel,...parsed.scanFunnel},providerStatus:{...parsed.providerStatus,...defaultProviderStatus(),message:'Restarted paused; reconciliation and release gates must pass before paper resume'},summary:summarize(parsed.account),assessments:parsed.assessments??[],validationRuns:parsed.validationRuns??[]};
      }
      const hash=configurationHash(this.state.settings);
      this.state.account.configHash=hash;
      this.state.account.cleanShutdown=this.journal.metadata('clean_shutdown')==='true';
      this.state.account.reconciliationRequired=true;
      await this.save();
      this.loaded=true;
    } catch(error) {
      this.loadFailed=true;this.state.settings.paused=true;await this.releaseLock();this.journal.close(false);
      throw error instanceof StateIntegrityError?error:new StateIntegrityError();
    }
  }

  async save() {
    if(this.loadFailed||this.closed)throw new StateIntegrityError();
    validateAccount(this.state.account);parseSettings(this.state.settings);assertFiniteTree(this.state);
    this.state.summary=summarize(this.state.account);
    const hash=configurationHash(this.state.settings);this.state.account.configHash=hash;
    const snapshot=structuredClone(this.state);
    const write=async()=>{try{await this.acquireLock();this.journal.persist(snapshot,hash);this.lastWriteError=undefined;}catch{this.lastWriteError=new Error('SQLite persistence failed; paper copying has been paused');this.state.settings.paused=true;this.state.providerStatus.message=this.lastWriteError.message;throw this.lastWriteError;}};
    const pending=this.writeQueue.then(write,write);this.writeQueue=pending.catch(()=>undefined);await pending;
  }

  async archive() {
    await this.flush();
    const archivePath=path.join(path.dirname(this.databasePath),'archives',`state-v3-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.json`);
    await mkdir(path.dirname(archivePath),{recursive:true,mode:0o700});
    const handle=await open(archivePath,'wx',0o600);try{await handle.writeFile(JSON.stringify(this.state,null,2));await handle.sync();}finally{await handle.close();}
    return archivePath;
  }

  reconcile():ReconciliationReport {
    const ids=this.state.account.processedSourceTradeIds;
    const duplicates=[...new Set(ids.filter((id,index)=>ids.indexOf(id)!==index))];
    const positionDifferences=this.state.account.positions.flatMap(position=>Math.abs(position.currentValue-position.shares*position.currentPrice)>.01?[position.id]:[]);
    const report:ReconciliationReport={id:`reconcile:${randomUUID()}`,checkedAt:new Date().toISOString(),passed:duplicates.length===0&&positionDifferences.length===0&&this.state.account.cash>=-1e-7,cashDifference:Math.min(0,this.state.account.cash),positionDifferences,duplicateEventIds:duplicates,pendingExits:this.state.account.positions.filter(position=>position.exitIntent).length,notes:[]};
    this.state.account.reconciliations??=[];this.state.account.reconciliations.unshift(report);this.state.account.reconciliationRequired=!report.passed;return report;
  }

  async flush(){await this.writeQueue;if(this.lastWriteError)throw this.lastWriteError;}
  private async releaseLock(){if(!this.ownsLock)return;const lockPath=`${this.databasePath}.lock`;const owner=JSON.parse(await readFile(path.join(lockPath,'owner.json'),'utf8')) as {token:string};if(owner.token!==this.lockToken)throw new Error('State lock ownership changed; refusing to release another writer lock');await unlink(path.join(lockPath,'owner.json'));await rmdir(lockPath);this.ownsLock=false;}
  async close(){if(this.closed)return;try{await this.flush();if(this.loaded&&!this.loadFailed){this.state.account.cleanShutdown=true;this.journal.persist(this.state,configurationHash(this.state.settings));this.journal.close(true);}}finally{await this.releaseLock();this.closed=true;}}
}
