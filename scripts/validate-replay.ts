import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chronologicalValidation,stressReplay,walkForwardValidation,type ReplayFrame} from '../src/server/backtest.js';
import {context,position,source,trader} from '../src/server/testFixtures.js';
import {defaultSettings} from '../src/server/config.js';

const input=process.argv[2];
let frames:ReplayFrame[];
const synthetic=!input;
if(input) frames=(await readFile(input,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
else {
  let seed=9382;
  const start=Date.UTC(2025,0,1);
  frames=Array.from({length:1200},(_,i)=>{
    seed=(Math.imul(1664525,seed)+1013904223)>>>0;
    const time=start+i*3*3600_000;
    const price=(35+seed%30)/100;
    const event=`synthetic-event-${Math.floor(i/2)}`,asset=`synthetic-asset-${Math.floor(i/2)}`;
    const signal={...source(`synthetic-${i}`,i%2?'SELL':'BUY',price,100),asset,conditionId:event,eventSlug:event,timestamp:time/1000};
    const snapshot={...structuredClone(trader),lastActivityAt:new Date(time).toISOString(),verification:{...trader.verification,checkedAt:new Date(time).toISOString()}};
    const ctx=context(price,price+.01,200,.05),quote=ctx.quotes!.asset;ctx.sourcePositionsAsOf=time;ctx.quotes={[asset]:{...quote,asset,capturedAt:time}};
    return {observedAt:time,traderSnapshotObservedAt:time,source:signal,trader:snapshot,positions:[position({asset,conditionId:event,eventSlug:event,size:i%2?0:100,observedAt:new Date(time).toISOString(),endDate:new Date(time+86400000).toISOString(),currentPrice:price})],execution:ctx};
  });
}
if(frames.length<2) throw new Error('At least two observations required');
const splitAt=frames[Math.floor(frames.length*.7)].observedAt;
const risk={...defaultSettings.risk,maxParticipationPct:10};
const chronological=chronologicalValidation(frames,splitAt,risk);
const walkForward=walkForwardValidation(frames,risk);
const stress=stressReplay(frames,risk);
const positiveFoldPct=walkForward.positiveHoldoutPct;
// Engineering-only synthetic/proxy tapes can test the replay machinery but can
// never validate a strategy. A real point-in-time tape must also remain positive
// after costs in both chronological segments, at least 70% of purged folds, and
// every declared cost/liquidity/latency stress scenario.
const passed=!synthetic
  && chronological.training.returnPct>0
  && chronological.holdout.returnPct>0
  && positiveFoldPct>=70
  && stress.every(scenario=>scenario.returnPct>0)
  && chronological.holdout.maxDrawdownPct<=risk.maxDrawdownPct;
const report={methodologyVersion:3,dataset:synthetic?'Seeded synthetic scenarios; NOT historical market evidence':input,generatedAt:new Date().toISOString(),splitAt:new Date(splitAt).toISOString(),...chronological,walkForward:{...walkForward,positiveFoldPct},stress,passed,liveEnabled:false,eligibleForLive:false,limitations:['No profitability claim','Cold-start holdout; prior-segment holdings not carried','Current-leaderboard tapes have survivorship bias','Historical books are liquidity proxies unless point-in-time snapshots are supplied','Live execution absent; 90-day forward-paper validation outstanding']};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/quant-validation.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
