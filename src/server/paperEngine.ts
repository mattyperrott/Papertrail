import type { PaperAccount, PaperPosition, PaperTrade, RiskSettings, SourcePosition, SourceTrade, TraderCandidate } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import { allocateSimultaneously } from './allocation.js';
import { prepareExecution, simulateExecution, consumeExecution, validQuote, type ExecutionContext, type ExecutionFill, type ExecutionPlan } from './paperExecution.js';
export { type ExecutionContext } from './paperExecution.js';

const keyOf=(owner:string,asset:string)=>`${owner.toLowerCase()}:${asset}`;
const day=86_400_000;
const utcDay=(epochMs:number)=>Math.floor(epochMs/day);
const intradayLimit=500,dailyCloseLimit=800,processedIdLimit=20_000,tradeViewLimit=5000,decisionViewLimit=5000;
const endTime=(value?:string)=>Date.parse(value && /^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T23:59:59Z`:value ?? '');
export function createPaperAccount(startingBalance:number):PaperAccount {
  if(!Number.isFinite(startingBalance)||startingBalance<=0) throw new Error('Invalid starting balance');
  const now=new Date().toISOString();
  return {accountId:`paper-v3-${randomUUID()}`,startingBalance,cash:startingBalance,realizedPnl:0,feesPaidTotal:0,turnoverTotal:0,positions:[],trades:[],processedSourceTradeIds:[],sourceWatermarks:{},highWaterEquity:startingBalance,methodologyVersion:3,strategyVersion:'3.0.0',strategySleeve:'champion',equityHistory:[{timestamp:now,equity:startingBalance,cash:startingBalance,exposure:0}],completedCycles:[],signalDecisions:[],alerts:[],reconciliations:[],reconciliationRequired:true,cleanShutdown:false,createdAt:now};
}
export const accountExposure=(account:PaperAccount)=>account.positions.reduce((s,p)=>s+p.currentValue,0);
export const accountEquity=(account:PaperAccount)=>account.cash+accountExposure(account);
export const riskExposure=(positions:PaperPosition[])=>positions.reduce((s,p)=>s+Math.max(p.costBasis,p.currentValue),0);
const eventKey=(position:{eventSlug?:string;conditionId:string})=>position.eventSlug || position.conditionId;

function decision(source:SourceTrade,reason:string,now:number):PaperTrade {
  return {id:`paper:${source.id}`,sourceTradeId:source.id,traderAddress:source.traderAddress,traderName:source.traderName,timestamp:new Date(now).toISOString(),sourceTimestamp:Number.isFinite(source.timestamp)&&Math.abs(source.timestamp)<1e11?new Date(source.timestamp*1000).toISOString():undefined,receivedAt:source.receivedAt,decisionAt:new Date(now).toISOString(),side:source.side,title:source.title,outcome:source.outcome,asset:source.asset,sourcePrice:Number.isFinite(source.price)?source.price:0,fillPrice:0,shares:0,notional:0,fees:0,realizedPnl:0,status:'skipped',reason,eventSlug:source.eventSlug};
}
function log(account:PaperAccount,trade:PaperTrade) {account.trades.unshift(trade);if(account.trades.length>tradeViewLimit) account.trades.length=tradeViewLimit;return trade;}
const processedIndexes=new WeakMap<PaperAccount,{length:number;ids:Set<string>}>();
function remember(account:PaperAccount,id:string) {
  let index=processedIndexes.get(account);
  if(!index||index.length!==account.processedSourceTradeIds.length) {index={length:account.processedSourceTradeIds.length,ids:new Set(account.processedSourceTradeIds)};processedIndexes.set(account,index);}
  if(index.ids.has(id)) return false;
  index.ids.add(id);account.processedSourceTradeIds.push(id);index.length++;
  // Bounded ledger. Per-trader watermarks already exclude anything older than the
  // current poll window, so evicting the oldest ids cannot resurrect a settled fill.
  while(account.processedSourceTradeIds.length>processedIdLimit) {
    const oldest=account.processedSourceTradeIds.shift();
    if(oldest!==undefined) index.ids.delete(oldest);
    index.length--;
  }
  return true;
}
function remembered(account:PaperAccount,id:string) {return account.processedSourceTradeIds.includes(id);}
function signalDecision(account:PaperAccount,source:SourceTrade,state:'pending_quote'|'filled'|'partial'|'rejected'|'expired',reason:string,now:number,retryable:boolean,trade?:PaperTrade,maxAgeSeconds=120) {
  account.signalDecisions ??= [];
  const prior=account.signalDecisions.find(row=>row.sourceEventId===source.id);
  const requested=prior?.requestedShares ?? trade?.requestedShares ?? source.shares;
  const filled=(prior?.filledShares??0)+(trade?.shares??0);
  const row={id:prior?.id ?? `decision:${source.id}`,sourceEventId:source.id,state,sleeve:'champion' as const,observedAt:prior?.observedAt ?? new Date(source.timestamp*1000).toISOString(),quoteAt:trade?.quoteCapturedAt,decidedAt:new Date(now).toISOString(),filledAt:filled>0?new Date(now).toISOString():undefined,requestedShares:requested,filledShares:filled,reason,retryable,expiresAt:new Date(source.timestamp*1000+maxAgeSeconds*1000).toISOString()};
  if(prior) Object.assign(prior,row); else account.signalDecisions.unshift(row);
  if(account.signalDecisions.length>decisionViewLimit) account.signalDecisions.length=decisionViewLimit;
}
/** Intraday ring for the dashboard chart, plus one retained close per completed
 * UTC day. Daily ratios, drawdown and the live-eligibility gates read the daily
 * series: a fixed-size intraday buffer spans hours, far short of the 30 and 90
 * daily observations those gates require, while an uncapped one grows forever.
 */
export function recordEquityPoint(account:PaperAccount,now=Date.now()) {
  const equity=accountEquity(account);
  const point={timestamp:new Date(now).toISOString(),equity,cash:account.cash,exposure:accountExposure(account)};
  account.equityHistory.push(point);
  while(account.equityHistory.length>intradayLimit) account.equityHistory.shift();
  account.dailyCloses ??= [];
  const last=account.dailyCloses.at(-1);
  if(last&&utcDay(Date.parse(last.timestamp))===utcDay(now)) account.dailyCloses[account.dailyCloses.length-1]=point;
  else account.dailyCloses.push(point);
  while(account.dailyCloses.length>dailyCloseLimit) account.dailyCloses.shift();
  account.highWaterEquity=Math.max(account.highWaterEquity ?? account.startingBalance,equity);
  // Recorded here because the buffers are lossy: one close per day plus a bounded
  // intraday ring means an intraday peak and trough are both gone within a day,
  // and a drawdown recomputed from what survives silently shrinks.
  const peak=account.highWaterEquity;
  if(peak>0) account.maxDrawdownPctObserved=Math.max(account.maxDrawdownPctObserved ?? 0,100*(peak-equity)/peak);
  return point;
}
function validateRisk(settings:RiskSettings) {
  const required=[settings.maxRiskPerTradePct,settings.maxPositionPct,settings.maxTotalExposurePct,settings.sourceNotionalMultiplier,settings.slippageBps,settings.defaultSellPct,settings.maxPositionDurationDays];
  return required.every(x=>Number.isFinite(x)&&x>=0) && Object.values(settings).every(x=>typeof x!=='number'||(Number.isFinite(x)&&x>=0)) && settings.maxTotalExposurePct<=100 && settings.maxRiskPerTradePct<=100;
}

export function applySourceTrade(account:PaperAccount,source:SourceTrade,trader:TraderCandidate,settings:RiskSettings,sourcePositions:SourcePosition[]=[],now=Date.now(),execution:ExecutionContext={}):PaperTrade {
  if(remembered(account,source.id)) return decision(source,'Duplicate source event',now);
  const reject=(reason:string,retryable=false)=>{
    const expired=now-source.timestamp*1000>(settings.maxSignalAgeSeconds ?? 120)*1000;
    const final=!retryable||(expired&&source.side==='BUY');
    if(final) remember(account,source.id);
    account.pendingSourceEvents ??=[];
    if(retryable&&!expired&&!account.pendingSourceEvents.some(row=>row.id===source.id)) account.pendingSourceEvents.push(source);
    if(final) account.pendingSourceEvents=account.pendingSourceEvents.filter(row=>row.id!==source.id);
    const trade=log(account,decision(source,reason,now));
    signalDecision(account,source,expired&&source.side==='BUY'?'expired':retryable?'pending_quote':'rejected',reason,now,retryable&&!(expired&&source.side==='BUY'),trade,settings.maxSignalAgeSeconds??120);
    return trade;
  };
  if(!validateRisk(settings)) return reject('Invalid risk configuration');
  if(!source.id||!source.asset||!source.conditionId||source.traderAddress.toLowerCase()!==trader.address.toLowerCase()||!['BUY','SELL'].includes(source.side)) return reject('Invalid signal identity or side');
  if(![source.price,source.shares,source.notional,source.timestamp].every(Number.isFinite)||source.price<=0||source.price>=1||source.shares<=0||source.notional<=0) return reject('Invalid source economics');
  if(Math.abs(source.notional-source.shares*source.price)>Math.max(.01,source.notional*.01)) return reject('Source shares, price and notional disagree');
  if(source.timestamp*1000>now+1000||now-source.timestamp*1000>(settings.maxSignalAgeSeconds ?? 120)*1000) return reject('Stale or future source event');
  const key=keyOf(source.traderAddress,source.asset);
  const existing=account.positions.find(p=>p.id===key);
  const live=sourcePositions.find(p=>keyOf(p.traderAddress,p.asset)===key);
  if(source.side==='BUY') {
    if(account.riskHalt) return reject(`Risk halt: ${account.riskHalt.reason}`);
    // The deploy path already honours this cooldown; the live path did not, so a
    // stop-loss or concentration exit was bought straight back on the trader's
    // next fill. One market was sold and rebuilt seven times in forty minutes.
    const lock=account.reentryLocks?.[key];
    if(lock) {
      if(!lock.zeroObservedAt) return reject('Risk exit re-entry lock: source must exit to zero before re-entry');
      if(source.timestamp*1000<=Date.parse(lock.zeroObservedAt)) return reject('Risk exit re-entry lock: waiting for a later source BUY');
      delete account.reentryLocks![key];
    }
    // A position whose market has already ended is awaiting settlement and has
    // no live book to mark against; a stale mark there is expected, not a data
    // failure. Requiring it to be fresh let one thin, ended market freeze every
    // new entry portfolio-wide until it resolved.
    // Also exempt: a market Polymarket already reports as resolved or awaiting
    // its result. Its `expectedEndAt` can sit days out (a tennis market carries
    // the tournament's end date, not the match's), and there is no live book to
    // mark against once the match is over.
    const awaitingResult=(p:PaperPosition)=>{const end=endTime(p.expectedEndAt);return (Number.isFinite(end)&&end<=now)||p.resolutionStatus==='resolved'||p.resolutionStatus==='awaiting-result';};
    if(account.positions.some(p=>!awaitingResult(p)&&(!Number.isFinite(Date.parse(p.updatedAt))||now-Date.parse(p.updatedAt)>(settings.maxSignalAgeSeconds ?? 120)*1000))) return reject('Portfolio contains stale marks; refresh before adding risk');
    if(!trader.selected||trader.verification.status!=='verified') return reject('Trader is not eligible for copying');
    // Contract-specific void and partial-payout fixtures are not certified yet.
    // Reject every combo even when its displayed YES/NO side is explicit.
    const combo=source.isCombo||live?.isCombo||/\bcombo\b/i.test(source.outcome);
    if(combo) return reject('Combo entries are disabled until payout, void, and partial-payout fixtures pass');
    // Market-level selection. Discovery ranks traders by category, but those
    // traders trade everything, so without this a sports-ranked wallet drags the
    // portfolio into politics and macro markets that resolve months out.
    const allowed=settings.allowedMarketTags ?? [];
    if(allowed.length) {
      if(source.marketTags===undefined) return reject('Market tags could not be established for this signal');
      const want=new Set(allowed.map(t=>t.toLowerCase()));
      if(!source.marketTags.some(t=>want.has(t.toLowerCase()))) {
        return reject(`Market tags [${source.marketTags.slice(0,4).join(', ')||'none'}] are outside the configured categories`);
      }
    }
    if(!live||live.redeemable||!Number.isFinite(live.size)||live.size<=0) return reject('No valid unresolved source position snapshot');
    const asOf=live.observedAt ? Date.parse(live.observedAt) : execution.sourcePositionsAsOf;
    if(asOf===undefined||!Number.isFinite(asOf)||asOf>now+1000||now-asOf>(settings.maxSignalAgeSeconds ?? 120)*1000) return reject('Stale or unstamped source position snapshot');
    const end=endTime(live.endDate);
    if(!Number.isFinite(end)) return reject('No official source result date');
    // Split deliberately: these are opposite diagnoses. "Already ended" means the
    // market closed before we acted, so a wider horizon changes nothing; "beyond
    // horizon" means the market is too slow for the configured holding limit.
    if(end<=now) return reject('Market already ended before this signal could be copied');
    if(end>now+settings.maxPositionDurationDays*day) return reject(`Result is more than ${settings.maxPositionDurationDays} days away`);
    // Payoff asymmetry: at price p a share can win 1-p and lose p. Past the ceiling
    // the trade risks many times what it can win, so any calibration error in the
    // copied edge is amplified rather than diversified away.
    if(source.price>(settings.maxEntryPrice ?? .9)) return reject(`Entry price ${source.price.toFixed(3)} is above the ${settings.maxEntryPrice ?? .9} ceiling`);
    // Copying a live position means paying today's price for an entry the trader
    // made earlier. Once the market has already moved their way, that is the worst
    // available price, not the one their track record was built on.
    if(Number.isFinite(live.avgPrice)&&live.avgPrice>0&&source.price>live.avgPrice*(1+(settings.maxEntryDriftBps ?? 300)/10_000)) return reject(`Price is ${(100*(source.price/live.avgPrice-1)).toFixed(1)}% above the source entry of ${live.avgPrice.toFixed(3)}`);
  } else if(!existing) return reject('No matching paper position to sell');
  const prepared=prepareExecution(source.asset,source.side,source.price,settings,now,execution);
  if('reason' in prepared) return reject(prepared.reason,true);
  const {plan}=prepared;
  if(source.side==='SELL') {
    const asOf=live?.observedAt?Date.parse(live.observedAt):execution.sourcePositionsAsOf;
    const usable=live&&Number.isFinite(live.size)&&live.size>=0&&asOf!==undefined&&Number.isFinite(asOf)&&asOf>=source.timestamp*1000&&asOf-source.timestamp*1000<=(settings.maxSignalAgeSeconds ?? 120)*1000;
    const fraction=usable?source.shares/(source.shares+live.size):settings.defaultSellPct/100;
    const prior=account.signalDecisions?.find(row=>row.sourceEventId===source.id);
    const requested=prior?Math.max(0,prior.requestedShares-prior.filledShares):existing!.shares*Math.min(1,Math.max(0,fraction));
    if(requested<=1e-6) {remember(account,source.id);account.pendingSourceEvents=(account.pendingSourceEvents??[]).filter(row=>row.id!==source.id);return decision(source,'Source exit already reconciled',now);}
    const fill=simulateExecution(plan,requested);
    if(fill.shares<=0) return reject('No sell liquidity available; position remains open',true);
    const trade=closeFill(account,existing!,source,plan,fill,execution,now,usable?'Mirrored contemporaneous source fraction':'Configured sell fraction; source inventory path is unavailable');
    if(fill.unfilledShares>1e-6) {
      account.pendingSourceEvents ??=[];
      if(!account.pendingSourceEvents.some(row=>row.id===source.id)) account.pendingSourceEvents.push(source);
      signalDecision(account,source,'partial',trade.reason,now,true,trade,settings.maxSignalAgeSeconds??120);
    } else { remember(account,source.id);account.pendingSourceEvents=(account.pendingSourceEvents??[]).filter(row=>row.id!==source.id);signalDecision(account,source,'filled',trade.reason,now,false,trade,settings.maxSignalAgeSeconds??120); }
    return trade;
  }
  const equity=accountEquity(account);
  if(!Number.isFinite(equity)||equity<=0) return reject('No positive equity');
  const debitCeiling=Math.min(account.cash,equity*settings.maxRiskPerTradePct/100,source.notional*settings.sourceNotionalMultiplier);
  const market=account.positions.filter(p=>p.conditionId.toLowerCase()===source.conditionId.toLowerCase());
  const owner=account.positions.filter(p=>p.traderAddress.toLowerCase()===source.traderAddress.toLowerCase());
  const event=account.positions.filter(p=>eventKey(p)===eventKey(source));
  const caps:[[PaperPosition[],number],[PaperPosition[],number],[PaperPosition[],number],[PaperPosition[],number]]=[
    [market,settings.maxPositionPct],[owner,settings.maxTraderExposurePct ?? 8],[event,settings.maxEventExposurePct ?? 8],[account.positions,settings.maxTotalExposurePct],
  ];
  const priorRisk=existing?Math.max(existing.costBasis,existing.currentValue):0;
  const fits=(fill:ExecutionFill)=>{
    const debit=fill.notional+fill.fees;
    const eqAfter=equity-debit+fill.shares*plan.mark;
    const increment=Math.max((existing?.costBasis ?? 0)+debit,(existing?.currentValue ?? 0)+fill.shares*plan.mark)-priorRisk;
    return debit<=debitCeiling+1e-8 && debit<=eqAfter*settings.maxRiskPerTradePct/100+1e-8 && caps.every(([positions,percent])=>riskExposure(positions)+increment<=eqAfter*percent/100+1e-8);
  };
  let lo=0,hi=debitCeiling/plan.levels[0].price;
  let fill=simulateExecution(plan,hi,debitCeiling);
  // Monotonic bisection enforces caps against equity AFTER fees and spread loss.
  if(!fits(fill)) {
    for(let i=0;i<48;i++) {const mid=(lo+hi)/2;const test=simulateExecution(plan,mid,debitCeiling);if(fits(test)) lo=mid;else hi=mid;}
    fill=simulateExecution(plan,lo,debitCeiling);
  }
  if(fill.notional+fill.fees<1||fill.shares<plan.minOrderShares||!fits(fill)) return reject('Risk cap, minimum size, exposure cap or liquidity blocks the copy',fill.shares<plan.minOrderShares);
  // Re-apply the entry limits to the price actually paid. Checking only the
  // source's reported price let a book whose ask sat above the ceiling fill
  // through it: a 0.900 signal became a 0.910 fill, and a 3% drift signal a 4%
  // fill. The volume-weighted fill price is what the position actually costs.
  const ceiling=settings.maxEntryPrice ?? .9;
  if(fill.fillPrice>ceiling+1e-9) return reject(`Executed price ${fill.fillPrice.toFixed(3)} is above the ${ceiling} ceiling`);
  const basis=live!.avgPrice;
  if(Number.isFinite(basis)&&basis>0&&fill.fillPrice>basis*(1+(settings.maxEntryDriftBps ?? 300)/10_000)+1e-9) {
    return reject(`Executed price ${fill.fillPrice.toFixed(3)} is ${(100*(fill.fillPrice/basis-1)).toFixed(1)}% above the source entry of ${basis.toFixed(3)}`);
  }
  consumeExecution(plan,fill,execution);
  const debit=fill.notional+fill.fees;
  account.cash-=debit;account.feesPaidTotal=(account.feesPaidTotal??0)+fill.fees;account.turnoverTotal=(account.turnoverTotal??0)+fill.notional;
  const position:PaperPosition=existing ?? {id:key,traderAddress:source.traderAddress.toLowerCase(),traderName:trader.name,asset:source.asset,conditionId:source.conditionId,title:source.title,outcome:source.outcome,shares:0,avgPrice:0,currentPrice:plan.mark,costBasis:0,currentValue:0,unrealizedPnl:0,realizedPnl:0,openedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),eventSlug:source.eventSlug,expectedEndAt:live!.endDate,timingSource:'polymarket',resolutionStatus:'scheduled',cycleId:`cycle:${randomUUID()}`,cycleCost:0,cyclePnl:0,copyEdgeLowerBound:trader.edge?.edgeLowerBound??undefined};
  position.shares+=fill.shares;position.costBasis+=debit;position.avgPrice=position.costBasis/position.shares;
  position.cycleCost=(position.cycleCost??0)+debit;
  position.currentPrice=plan.mark;position.currentValue=position.shares*plan.mark;position.unrealizedPnl=position.currentValue-position.costBasis;position.updatedAt=new Date(now).toISOString();
  if(!existing) account.positions.push(position);
  const trade=log(account,{...decision(source,'Hard max-loss and concentration caps; depth-limited paper fill',now),...fill,executionModel:plan.model,quoteCapturedAt:execution.quotes?.[source.asset]?new Date(execution.quotes[source.asset].capturedAt).toISOString():undefined,sourcePositionObservedAt:live?.observedAt,decisionAt:new Date(now).toISOString(),fillAt:new Date(now).toISOString(),strategySleeve:'champion',status:'filled'});
  remember(account,source.id);account.pendingSourceEvents=(account.pendingSourceEvents??[]).filter(row=>row.id!==source.id);
  signalDecision(account,source,fill.unfilledShares>1e-6?'partial':'filled',trade.reason,now,false,trade,settings.maxSignalAgeSeconds??120);
  return trade;
}
function closeFill(account:PaperAccount,position:PaperPosition,source:SourceTrade,plan:ExecutionPlan,fill:ExecutionFill,execution:ExecutionContext,now:number,reason:string):PaperTrade {
  consumeExecution(plan,fill,execution);
  const fraction=Math.min(1,fill.shares/position.shares);
  const releasedCost=position.costBasis*fraction;
  const proceeds=fill.notional-fill.fees;
  const realizedPnl=proceeds-releasedCost;
  account.cash+=proceeds;account.realizedPnl+=realizedPnl;account.feesPaidTotal=(account.feesPaidTotal??0)+fill.fees;account.turnoverTotal=(account.turnoverTotal??0)+fill.notional;
  position.shares=Math.max(0,position.shares-fill.shares);position.costBasis=Math.max(0,position.costBasis-releasedCost);
  position.cyclePnl=(position.cyclePnl??0)+realizedPnl;
  position.currentPrice=plan.mark;position.currentValue=position.shares*plan.mark;position.unrealizedPnl=position.currentValue-position.costBasis;position.realizedPnl+=realizedPnl;position.updatedAt=new Date(now).toISOString();
  // Float dust: a full exit of a partially trimmed line can leave ~1e-6 shares
  // behind, which then sits on the book as a phantom position forever.
  if(position.shares<=1e-6) {
    account.positions=account.positions.filter(p=>p.id!==position.id);
    account.completedCycles ??=[];
    account.completedCycles.push({id:position.cycleId??`cycle:${randomUUID()}`,positionId:position.id,traderAddress:position.traderAddress,asset:position.asset,eventKey:eventKey(position),openedAt:position.openedAt,closedAt:new Date(now).toISOString(),cost:position.cycleCost??releasedCost,pnl:position.cyclePnl??realizedPnl,fees:fill.fees,exitProceeds:proceeds,complete:true,heldToResolution:false});
  }
  return log(account,{...decision(source,reason,now),...fill,realizedPnl,executionModel:plan.model,quoteCapturedAt:execution.quotes?.[source.asset]?new Date(execution.quotes[source.asset].capturedAt).toISOString():undefined,status:'filled'});
}
export function markPositions(account:PaperAccount,sourcePositions:SourcePosition[],now=Date.now(),execution:ExecutionContext={},settings?:RiskSettings) {
  const marks=new Map(sourcePositions.map(p=>[keyOf(p.traderAddress,p.asset),p]));
  for(const [id,lock] of Object.entries(account.reentryLocks??{})) {
    const source=marks.get(id);
    if(source&&source.size<=1e-6&&!lock.zeroObservedAt&&source.observedAt) lock.zeroObservedAt=source.observedAt;
  }
  for(const position of account.positions) {
    const source=marks.get(position.id),quote=execution.quotes?.[position.asset];
    let price:number|undefined;
    if(validQuote(quote,position.asset,now,settings?.maxQuoteAgeSeconds ?? 15)&&quote.bids.length) price=Math.max(...quote.bids.map(l=>l.price));
    else {
      const observed=source?.observedAt ? Date.parse(source.observedAt) : execution.sourcePositionsAsOf;
      if(source&&observed!==undefined&&observed<=now+1000&&now-observed<=(settings?.maxSignalAgeSeconds ?? 120)*1000&&Number.isFinite(source.currentPrice)&&source.currentPrice>=0&&source.currentPrice<=1) price=source.currentPrice;
    }
    if(price!==undefined) {position.currentPrice=price;position.currentValue=position.shares*price;position.unrealizedPnl=position.currentValue-position.costBasis;position.updatedAt=new Date(now).toISOString();}
    if(source?.endDate&&Number.isFinite(endTime(source.endDate))) {position.expectedEndAt=source.endDate;position.timingSource='polymarket';}
    const lock=account.reentryLocks?.[position.id];
    if(lock&&source&&source.size<=1e-6&&!lock.zeroObservedAt&&source.observedAt) lock.zeroObservedAt=source.observedAt;
  }
}
export function settleResolvedPositions(account:PaperAccount,now=Date.now()):PaperTrade[] {
  const trades:PaperTrade[]=[];
  for(const position of [...account.positions]) {
    if(position.resolutionStatus!=='resolved'||!['polymarket','polymarket-combo'].includes(position.timingSource ?? '')||!Number.isFinite(Date.parse(position.lastVerifiedAt ?? ''))||!['won','lost','void'].includes(position.result ?? '')) continue;
    if(position.result==='void'&&!(Number.isFinite(position.resolvedPrice)&&position.resolvedPrice!>=0&&position.resolvedPrice!<=1)) continue;
    const price=position.result==='won'?1:position.result==='lost'?0:position.resolvedPrice!,proceeds=position.shares*price,realizedPnl=proceeds-position.costBasis;
    account.cash+=proceeds;account.realizedPnl+=realizedPnl;
    account.positions=account.positions.filter(p=>p.id!==position.id);
    account.completedCycles ??=[];
    account.completedCycles.push({id:position.cycleId??`cycle:${randomUUID()}`,positionId:position.id,traderAddress:position.traderAddress,asset:position.asset,eventKey:eventKey(position),openedAt:position.openedAt,closedAt:new Date(now).toISOString(),cost:position.cycleCost??position.costBasis,pnl:(position.cyclePnl??0)+realizedPnl,fees:0,exitProceeds:proceeds,complete:true,heldToResolution:true});
    const trade:PaperTrade={id:`settlement:${now}:${position.id}`,sourceTradeId:`settlement:${position.id}`,traderAddress:position.traderAddress,traderName:position.traderName,timestamp:new Date(now).toISOString(),side:'SETTLE',title:position.title,outcome:position.outcome,asset:position.asset,sourcePrice:price,fillPrice:price,shares:position.shares,notional:proceeds,fees:0,realizedPnl,status:'filled',reason:position.result==='void'?`Verified void resolution: refunded at ${price.toFixed(2)} per share`:`Verified binary payout: ${position.result}`,eventSlug:position.eventSlug,executionModel:'settlement'};
    log(account,trade);trades.push(trade);
  }
  return trades;
}
export function deployCurrentPositions(account:PaperAccount,positions:SourcePosition[],traders:TraderCandidate[],settings:RiskSettings,now=Date.now(),execution:ExecutionContext={}):PaperTrade[] {
  const byOwner=new Map(traders.filter(t=>t.selected).map(t=>[t.address.toLowerCase(),t]));
  const equity=accountEquity(account);
  const candidates=[...positions].filter(p=>byOwner.has(p.traderAddress.toLowerCase())).sort((a,b)=>a.traderAddress.localeCompare(b.traderAddress)||a.asset.localeCompare(b.asset));
  const desires=candidates.flatMap(position=>{
    const id=keyOf(position.traderAddress,position.asset);
    if(account.reentryLocks?.[id]) return [];
    const existing=account.positions.find(p=>p.id===id);
    const prepared=prepareExecution(position.asset,'BUY',position.currentPrice,settings,now,execution);
    if('reason' in prepared) return [];
    const depth=simulateExecution(prepared.plan,Number.MAX_SAFE_INTEGER,account.cash);
    const depthCap=depth.notional+depth.fees;
    const sourceCap=position.size*position.currentPrice*settings.sourceNotionalMultiplier;
    const totalTarget=Math.min(equity*settings.maxRiskPerTradePct/100,sourceCap,depthCap);
    const current=existing?Math.max(existing.costBasis,existing.currentValue):0;
    const desired=Math.max(0,totalTarget-current);
    const noTradeBand=current*(settings.noTradeBandPct??10)/100;
    const minimum=(prepared.plan.minOrderShares??0)*(prepared.plan.levels[0]?.price??position.currentPrice);
    if(desired<Math.max(noTradeBand,minimum)) return [];
    return [{id,position,desired,market:position.conditionId.toLowerCase(),trader:position.traderAddress.toLowerCase(),event:eventKey(position)}];
  });
  const bucketAvailable=(field:'market'|'trader'|'event',percent:number)=>Object.fromEntries([...new Set(desires.map(row=>row[field]))].map(key=>{
    const held=account.positions.filter(position=>field==='market'?position.conditionId.toLowerCase()===key:field==='trader'?position.traderAddress.toLowerCase()===key:eventKey(position)===key);
    return [key,Math.max(0,equity*percent/100-riskExposure(held))];
  }));
  const projected=allocateSimultaneously(desires.map(({position:_position,...row})=>row),{
    cash:account.cash,
    portfolio:Math.max(0,equity*settings.maxTotalExposurePct/100-riskExposure(account.positions)),
    market:bucketAvailable('market',settings.maxPositionPct),
    trader:bucketAvailable('trader',settings.maxTraderExposurePct??4),
    event:bucketAvailable('event',settings.maxEventExposurePct??4),
  });
  const allocation=new Map(projected.map(row=>[row.id,row.allocation]));
  const trades:PaperTrade[]=[];
  for(const row of desires) {
    const position=row.position;
    const trader=byOwner.get(position.traderAddress.toLowerCase())!;
    const notional=(allocation.get(row.id)??0)/settings.sourceNotionalMultiplier;
    if(notional<=0) continue;
    const stamped=new Date(now).toISOString();
    const source:SourceTrade={id:`deploy:${position.traderAddress}:${position.asset}:${position.observedAt ?? now}`,traderAddress:position.traderAddress,traderName:trader.name,timestamp:now/1000,receivedAt:stamped,normalizedAt:stamped,side:'BUY',asset:position.asset,conditionId:position.conditionId,title:position.title,outcome:position.outcome,eventSlug:position.eventSlug,price:position.currentPrice,shares:notional/position.currentPrice,notional,provider:trader.provider,isCombo:position.isCombo,comboSide:position.comboSide,marketTags:position.marketTags};
    trades.push(applySourceTrade(account,source,trader,settings,positions,now,execution));
  }
  return trades;
}
function forcedExit(account:PaperAccount,position:PaperPosition,settings:RiskSettings,now:number,execution:ExecutionContext,reason:string,shares=position.shares):PaperTrade {
  const source:SourceTrade={id:`risk:${now}:${position.id}`,traderAddress:position.traderAddress,traderName:position.traderName,timestamp:now/1000,side:'SELL',asset:position.asset,conditionId:position.conditionId,title:position.title,outcome:position.outcome,eventSlug:position.eventSlug,price:position.currentPrice,shares,notional:shares*position.currentPrice,provider:'polymarket'};
  const prepared=prepareExecution(position.asset,'SELL',position.currentPrice,settings,now,execution,false);
  position.exitIntent ??={targetShares:shares,reason,since:new Date(now).toISOString(),sourceEventIds:[source.id],attemptSequence:0};
  position.exitIntent.attemptSequence++;position.exitIntent.lastAttemptAt=new Date(now).toISOString();
  if('reason' in prepared) {position.exitIntent.lastError=prepared.reason;position.pendingExit={reason,since:position.exitIntent.since};return log(account,decision(source,`Exit pending (${reason}): ${prepared.reason}`,now));}
  const fill=simulateExecution(prepared.plan,shares);
  if(fill.shares<=0) {position.exitIntent.lastError='insufficient bid liquidity';position.pendingExit={reason,since:position.exitIntent.since};return log(account,decision(source,`Exit pending (${reason}): insufficient bid liquidity`,now));}
  const trade=closeFill(account,position,source,prepared.plan,fill,execution,now,reason);
  const remaining=account.positions.find(row=>row.id===position.id);
  if(remaining) {remaining.exitIntent!.targetShares=Math.max(0,remaining.exitIntent!.targetShares-fill.shares);remaining.pendingExit={reason,since:remaining.exitIntent!.since};}
  return trade;
}
export function liquidatePositionsOutsideHorizon(account:PaperAccount,maxDays:number,now=Date.now(),settings?:RiskSettings,execution:ExecutionContext={}):PaperTrade[] {
  if(!settings) return []; // Legacy callers cannot invent fee-free liquidation.
  return [...account.positions].filter(p=>!Number.isFinite(endTime(p.expectedEndAt))||endTime(p.expectedEndAt)>now+maxDays*day||now-Date.parse(p.openedAt)>maxDays*day).map(p=>forcedExit(account,p,settings,now,execution,'Maximum holding/result horizon'));
}
export function enforceRiskLimits(account:PaperAccount,settings:RiskSettings,now=Date.now(),execution:ExecutionContext={}):PaperTrade[] {
  const equity=accountEquity(account);
  account.highWaterEquity=Math.max(account.highWaterEquity ?? account.startingBalance,equity);
  const drawdown=account.highWaterEquity>0?100*(account.highWaterEquity-equity)/account.highWaterEquity:100;
  if(drawdown>=(settings.maxDrawdownPct ?? 10)&&!account.riskHalt) account.riskHalt={reason:`Drawdown ${drawdown.toFixed(2)}% reached limit`,triggeredAt:new Date(now).toISOString()};
  const today=utcDay(now);
  const start=[...(account.dailyCloses??[]),...account.equityHistory].filter(point=>utcDay(Date.parse(point.timestamp))===today).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))[0];
  const dailyLoss=start?.equity&&start.equity>0?100*(start.equity-equity)/start.equity:0;
  if(dailyLoss>=(settings.maxDailyLossPct ?? 2)&&!account.riskHalt) account.riskHalt={reason:`UTC-day loss ${dailyLoss.toFixed(2)}% reached limit`,triggeredAt:new Date(now).toISOString()};
  const trades:PaperTrade[]=[];
  for(const p of [...account.positions].sort((a,b)=>(a.copyEdgeLowerBound??-Infinity)-(b.copyEdgeLowerBound??-Infinity)||b.currentValue-a.currentValue)) {
    const eq=accountEquity(account);
    // Dollars over the cap, not a boolean: a concentration breach is answered by
    // trimming the excess, not by dumping the whole position. Closing outright
    // realised the spread on the entire line for a $1 overshoot, and a winner
    // that grew into the cap was sold flat instead of being kept at the limit.
    const over=(positions:PaperPosition[],percent:number)=>Math.max(0,riskExposure(positions)-eq*percent/100);
    let reason:string|undefined; let shares=p.shares;
    if(account.riskHalt?.liquidate) reason='Emergency halt liquidation';
    else if(p.costBasis>0&&100*(p.costBasis-p.currentValue)/p.costBasis>=(settings.stopLossPct ?? 20)) reason='Position stop loss';
    else {
      const excess=Math.max(over(account.positions,settings.maxTotalExposurePct),over(account.positions.filter(x=>x.conditionId===p.conditionId),settings.maxPositionPct),over(account.positions.filter(x=>x.traderAddress===p.traderAddress),settings.maxTraderExposurePct ?? 8),over(account.positions.filter(x=>eventKey(x)===eventKey(p)),settings.maxEventExposurePct ?? 8));
      const own=Math.max(p.costBasis,p.currentValue);
      // Below a dollar it is mark noise, not concentration.
      if(excess>=1&&own>0) {reason='Portfolio concentration limit';shares=Math.min(p.shares,p.shares*excess/own);}
    }
    if(reason) {
      const trade=forcedExit(account,p,settings,now,execution,reason,shares);
      // Only a completed full exit starts the cooldown; a trim leaves the position
      // open and a pending one still holds risk.
      if(trade.status==='filled'&&!account.positions.some(x=>x.id===p.id)) {
        account.riskClosedAt ??= {};account.riskClosedAt[p.id]=now;
        account.reentryLocks ??={};account.reentryLocks[p.id]={traderAddress:p.traderAddress,asset:p.asset,blockedAt:new Date(now).toISOString()};
      }
      trades.push(trade);
    }
  }
  return trades;
}
