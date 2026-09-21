import type {PaperAccount,PaperPosition,RiskSettings,SourcePosition,SourceTrade,TraderCandidate} from '../shared/types.js';
import type {ExecutionContext} from './paperExecution.js';
import {accountEquity,applySourceTrade,createPaperAccount,enforceRiskLimits,liquidatePositionsOutsideHorizon,markPositions,recordEquityPoint,settleResolvedPositions} from './paperEngine.js';
import {calculatePerformance} from './performance.js';
import {scoreTrader,selectTraders} from './scoring.js';
import {defaultSettings} from './config.js';

export interface ReplayFrame {
  observedAt:number;
  traderSnapshotObservedAt:number;
  source:SourceTrade;
  trader:TraderCandidate;
  positions:SourcePosition[];
  execution:ExecutionContext;
  resolutions?:Array<{asset:string;observedAt:number;result:'won'|'lost';timingSource:'polymarket'}>;
}
export function replay(frames:ReplayFrame[],risk:RiskSettings=defaultSettings.risk) {
  const account=createPaperAccount(risk.startingBalance);
  if(frames.length) {account.createdAt=new Date(frames[0].observedAt).toISOString();account.equityHistory=[{timestamp:account.createdAt,equity:account.cash,cash:account.cash,exposure:0}];}
  let prior=-Infinity;
  const depthBySnapshot:NonNullable<ExecutionContext['consumed']>={};
  for(const frame of frames) {
    const now=frame.observedAt;
    if(!Number.isFinite(now)||now<prior||frame.traderSnapshotObservedAt>now||!Number.isFinite(frame.traderSnapshotObservedAt)||Date.parse(frame.trader.verification.checkedAt)>now||frame.source.timestamp*1000>now) throw new Error('Nonchronological or future information in replay');
    prior=now;
    const execution=structuredClone(frame.execution);execution.consumed=depthBySnapshot;
    if(Object.values(execution.quotes ?? {}).some(q=>q.capturedAt>now)||frame.positions.some(p=>Date.parse(p.observedAt ?? '')>now)) throw new Error('Future execution or position snapshot');
    markPositions(account,frame.positions,now,execution,risk);
    for(const resolution of frame.resolutions ?? []) {
      if(!Number.isFinite(resolution.observedAt)||resolution.observedAt>now) throw new Error('Future settlement');
      for(const p of account.positions.filter(p=>p.asset===resolution.asset)) Object.assign(p,{result:resolution.result,timingSource:resolution.timingSource,resolutionStatus:'resolved',lastVerifiedAt:new Date(resolution.observedAt).toISOString()});
    }
    settleResolvedPositions(account,now);
    // Mirror the live mark cycle. Without this the maximum-holding rule is absent
    // from replay, so positions the running engine would have closed at their
    // horizon instead sit and decay on marks for the rest of the tape.
    liquidatePositionsOutsideHorizon(account,risk.maxPositionDurationDays,now,risk,execution);
    enforceRiskLimits(account,risk,now,execution);
    // Recalculate eligibility only from the supplied contemporaneous evidence.
    const trader=selectTraders([scoreTrader(frame.trader,frame.trader.verification)],defaultSettings.scanner,now)[0];
    applySourceTrade(account,frame.source,trader,risk,frame.positions,now,execution);
    assertAccountInvariant(account);
    recordEquityPoint(account,now);
  }
  const now=frames.at(-1)?.observedAt ?? Date.now();
  return {account,report:{frames:frames.length,endingEquity:accountEquity(account),returnPct:100*(accountEquity(account)/account.startingBalance-1),fills:account.trades.filter(t=>t.status==='filled').length,skips:account.trades.filter(t=>t.status==='skipped').length,...calculatePerformance(account,now),halt:account.riskHalt ?? null}};
}
export function assertAccountInvariant(account:PaperAccount) {
  const values=[account.cash,account.realizedPnl,...account.positions.flatMap(p=>[p.shares,p.costBasis,p.currentValue,p.unrealizedPnl])];
  const error=accountEquity(account)-account.startingBalance-account.realizedPnl-account.positions.reduce((s,p)=>s+p.unrealizedPnl,0);
  if(values.some(v=>!Number.isFinite(v))||account.cash < -1e-7||Math.abs(error)>1e-5||account.positions.some(p=>p.shares<=0||p.costBasis<0||Math.abs(p.currentValue-p.shares*p.currentPrice)>1e-6)) throw new Error('Account conservation invariant failed');
}
/** Frozen settings; independent cold-start portfolios. No optimization on held-out frames. */
export function chronologicalValidation(frames:ReplayFrame[],splitAt:number,risk:RiskSettings=defaultSettings.risk) {
  if(frames.some((f,i)=>i>0&&f.observedAt<frames[i-1].observedAt)) throw new Error('Input must be chronological');
  const train=frames.filter(f=>f.observedAt<splitAt),test=frames.filter(f=>f.observedAt>=splitAt);
  if(!train.length||!test.length) throw new Error('Both chronological segments need observations');
  return {method:'Frozen settings; chronological split; separate cold-start portfolios',training:replay(train,risk).report,holdout:replay(test,risk).report,liveEnabled:false};
}

/** Purged event-grouped walk-forward evaluation. Parameters are supplied once
 * and frozen; this function does not search the validation folds it reports. */
export function walkForwardValidation(frames:ReplayFrame[],risk:RiskSettings=defaultSettings.risk,folds=5,purgeDays=7) {
  if(frames.length<folds*2)throw new Error('Insufficient frames for walk-forward validation');
  const ordered=[...frames].sort((a,b)=>a.observedAt-b.observedAt);
  const first=Math.floor(ordered.length*.4),remaining=ordered.length-first;
  const reports=[];
  for(let fold=0;fold<folds;fold++) {
    const testStart=first+Math.floor(fold*remaining/folds),testEnd=first+Math.floor((fold+1)*remaining/folds);
    const startAt=ordered[testStart].observedAt,endAt=ordered[Math.max(testStart,testEnd-1)].observedAt;
    const testEvents=new Set(ordered.slice(testStart,testEnd).map(frame=>frame.source.eventSlug??frame.source.conditionId));
    const embargo=purgeDays*86_400_000;
    const training=ordered.slice(0,testStart).filter(frame=>frame.observedAt<startAt-embargo&&!testEvents.has(frame.source.eventSlug??frame.source.conditionId));
    const holdout=ordered.slice(testStart,testEnd);
    reports.push({fold:fold+1,trainingFrames:training.length,holdoutFrames:holdout.length,startAt:new Date(startAt).toISOString(),endAt:new Date(endAt).toISOString(),training:training.length?replay(training,risk).report:null,holdout:replay(holdout,risk).report});
  }
  return {method:`${folds}-fold event-grouped walk-forward; ${purgeDays}-day purge/embargo; frozen parameters`,folds:reports,positiveHoldoutPct:100*reports.filter(row=>row.holdout.returnPct>0).length/reports.length,cashBaselineReturnPct:0,liveEnabled:false};
}

export function stressReplay(frames:ReplayFrame[],risk:RiskSettings=defaultSettings.risk) {
  const scenarios=[
    {name:'fees-2x',risk:{...risk,feeBps:(risk.feeBps??0)*2}},
    {name:'spread-1.5x',risk:{...risk,slippageBps:risk.slippageBps*1.5}},
    {name:'spread-2x',risk:{...risk,slippageBps:risk.slippageBps*2}},
    {name:'depth-50pct',risk:{...risk,maxParticipationPct:(risk.maxParticipationPct??5)*.5}},
    {name:'depth-20pct',risk:{...risk,maxParticipationPct:(risk.maxParticipationPct??5)*.2}},
  ];
  const costs=scenarios.map(scenario=>({name:scenario.name,...replay(frames,scenario.risk).report}));
  const delays=[1,5,15,30,120].map(seconds=>{
    const delayed=frames.map(frame=>({...frame,observedAt:frame.observedAt+seconds*1000,traderSnapshotObservedAt:frame.traderSnapshotObservedAt,execution:structuredClone(frame.execution)}));
    return {name:`delay-${seconds}s`,...replay(delayed,risk).report};
  });
  return [...costs,...delays];
}
