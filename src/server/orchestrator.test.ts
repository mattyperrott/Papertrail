import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StateStore} from './store.js';
import {PapertrailOrchestrator} from './orchestrator.js';
import {trader} from './testFixtures.js';
async function setup() {
  const directory=await mkdtemp(path.join(tmpdir(),'papertrail-orchestrator-'));
  const store=new StateStore(path.join(directory,'state.json'));await store.load();
  const engine=new PapertrailOrchestrator(store);
  // Hermetic regardless of the operator's environment: with ARKHAM_API_KEY in the
  // shell or in .env the constructor wires a live Arkham source, and the scan
  // would then bypass the mocked Polymarket leaderboard and hit the network.
  Object.assign(engine,{arkham:null});
  return {store,engine,directory,cleanup:async()=>{await store.close();await rm(directory,{recursive:true,force:true});}};
}
test('mutations serialise through a queue rather than being refused, and pause takes effect immediately',async()=>{
  const {engine,store,cleanup}=await setup();
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  Object.assign(engine,{polymarket:{leaderboard:async()=>{await gate;return [];}}});
  store.state.settings.paused=false;
  const scan=engine.runScan();const rejected=assert.rejects(scan,/no candidates/);
  // A second mutation is queued behind the in-flight scan, never refused and
  // never interleaved: it must not have run while the scan is still gated.
  let resetRan=false;const reset=engine.resetSimulation().then(()=>{resetRan=true;});
  assert.ok(engine.state.providerStatus.queueDepth!>=1,'the reset is waiting its turn');
  assert.equal(resetRan,false,'nothing runs while the scan holds the engine');
  // Pause is honoured immediately even so; it does not wait for the queue.
  const pause=engine.updateSettings({paused:true});assert.equal(engine.state.settings.paused,true);
  release();await rejected;await reset;await pause;
  assert.equal(resetRan,true);assert.equal(store.state.settings.paused,true);assert.equal(engine.state.providerStatus.queueDepth,0);await cleanup();
});
test('failed persistence never publishes a simulated fill and restores prior account',async()=>{
  const {engine,store,cleanup}=await setup();
  const originalSave=store.save.bind(store);let calls=0;
  store.save=async()=>{calls++;if(calls===1)throw Error('disk unavailable');await originalSave();};
  const before=structuredClone(store.state.account);
  await assert.rejects(engine.resetSimulation(),/disk unavailable/);
  assert.equal(store.state.account.createdAt,before.createdAt);assert.equal(store.state.account.cash,before.cash);
  await cleanup();
});
test('resume refuses a financial risk latch and paper reset does not replay source history',async()=>{
  const {engine,store,cleanup}=await setup();store.state.account.riskHalt={reason:'Drawdown',triggeredAt:new Date().toISOString()};
  await assert.rejects(engine.updateSettings({paused:false}),/Latched risk halt/);
  await engine.resetSimulation();assert.equal(store.state.settings.paused,true);assert.equal(store.state.account.trades.length,0);assert.equal(store.state.account.methodologyVersion,3);await cleanup();
});
test('a pin cannot bypass hard verification evidence',async()=>{
  const {engine,store,cleanup}=await setup();const time=Date.now();
  store.state.traders=[{...structuredClone(trader),lastActivityAt:new Date(time).toISOString(),verification:{...trader.verification,checkedAt:new Date(time).toISOString(),status:'warning'}}];
  await engine.toggleTrader(trader.address,true);assert.equal(store.state.traders[0].selected,false);
  assert.ok(store.state.account.sourceStartedAt![trader.address]>=Math.floor(time/1000));await cleanup();
});

test('full paper polling copies once, persists watermark, and keeps exit monitoring after trader removal',async()=>{
  const {engine,store,cleanup}=await setup();
  const {source,position,context}=await import('./testFixtures.js');
  const time=Date.now();const iso=new Date(time).toISOString();
  store.state.settings.paused=false;
  store.state.settings.risk.maxParticipationPct=100;
  store.state.traders=[{...structuredClone(trader),lastActivityAt:iso,verification:{...trader.verification,checkedAt:iso}}];
  store.state.account.sourceWatermarks={[trader.address]:Math.floor(time/1000)-30};
  let selling=false;
  Object.assign(engine,{
    polymarket:{activitySince:async()=>[{...source(selling?'sell':'buy',selling?'SELL':'BUY',selling?.7:.5),timestamp:Date.now()/1000}],positions:async()=>[position({size:selling?0:1000,currentPrice:selling?.7:.5,observedAt:new Date().toISOString(),endDate:new Date(Date.now()+86400000).toISOString()})]},
    timing:{enrich:async()=>undefined},combos:{enrich:async()=>undefined},
    quotes:{lastUnavailableCount:0,fetch:async()=>{const ctx=context(selling?.7:.49,selling?.71:.5);ctx.sourcePositionsAsOf=Date.now();ctx.quotes!.asset.capturedAt=Date.now();return ctx;}},
  });
  try {
    await engine.poll();assert.equal(store.state.account.positions.length,1);assert.equal(store.state.account.trades.filter(t=>t.status==='filled').length,1);
    await engine.poll();assert.equal(store.state.account.trades.filter(t=>t.status==='filled').length,1);
    assert.ok(store.state.account.sourceWatermarks![trader.address]>=Math.floor(time/1000));
    store.state.traders=[];selling=true;
    await engine.poll();assert.equal(store.state.account.positions.length,0);assert.ok(store.state.account.realizedPnl>0);
  } finally {await cleanup();}
});

test('operator actions queue behind a running job instead of being refused, and duplicates coalesce',async()=>{
  const {engine,store,cleanup}=await setup();
  const ex=(name:string,work:()=>Promise<unknown>,coalesce=false)=>(engine as any).exclusive(name,work,coalesce) as Promise<unknown>;
  // Hold the engine busy, then fire more requests while it runs: none may be
  // refused, order is preserved, and two identical idempotent jobs share one run.
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const order:string[]=[];
  const slow=ex('Slow',async()=>{await gate;order.push('slow');});
  // Record inside each job: a .then() on the returned promise observes completion
  // several microtasks later and would misreport the order.
  const a=ex('Settings-like',async()=>{order.push('settings');store.state.settings.risk.slippageBps=26;});
  let runs=0;
  const b=ex('Idempotent',async()=>{runs++;order.push('idem');},true);
  const c=ex('Idempotent',async()=>{runs++;order.push('idem');},true);
  assert.ok(engine.state.providerStatus.queueDepth!>=2,'requests are waiting, not refused');
  assert.strictEqual(b,c,'a second identical job joins the waiting one');
  release();
  await Promise.all([slow,a,b,c]);
  assert.deepEqual(order,['slow','settings','idem'],'FIFO order, one coalesced run');
  assert.equal(runs,1);
  assert.equal(store.state.settings.risk.slippageBps,26,'the queued settings change was applied');
  assert.equal(engine.state.providerStatus.queueDepth,0);
  await cleanup();
});

test('a wallet can be pinned by address without being on the leaderboard, and is verified on the spot',async()=>{
  const {engine,store,cleanup}=await setup();
  const address='0x00000000000000000000000000000000000000aa';
  let verified=0;
  Object.assign(engine,{
    verifier:{verify:async()=>{verified++;return {...trader.verification,checkedAt:new Date().toISOString(),status:'verified' as const};}},
    polymarket:{activity:async()=>[{...(await import('./testFixtures.js')).source(),timestamp:Date.now()/1000}]},
  });
  assert.equal(store.state.traders.length,0);
  await engine.toggleTrader(address,true,'theowalcott');
  const pinned=store.state.traders.find(t=>t.address===address);
  assert.ok(pinned);assert.equal(verified,1);assert.equal(pinned.name,'theowalcott');
  assert.equal(pinned.selectionOverride,'include');assert.equal(pinned.selected,true,'a verified pin copies immediately');
  // Unpinning an unknown address is still an error: there is nothing to mute.
  await assert.rejects(engine.toggleTrader('0x00000000000000000000000000000000000000bb',false),/not found/);
  await cleanup();
});

test('pins survive the eligibility streak logic and are re-verified even when the leaderboard drops them',async()=>{
  const {engine,store,cleanup}=await setup();
  const iso=()=>new Date().toISOString();
  const pin={...structuredClone(trader),address:'0x00000000000000000000000000000000000000cc',name:'pin',selected:true,watched:true,selectionOverride:'include' as const,lastActivityAt:iso(),verification:{...trader.verification,checkedAt:iso()}};
  const other={...structuredClone(trader),address:'0x00000000000000000000000000000000000000dd',name:'other',lastActivityAt:iso(),verification:{...trader.verification,checkedAt:iso()}};
  store.state.traders=[pin];
  const verifiedAddresses:string[]=[];
  Object.assign(engine,{
    arkham:null,
    polymarket:{leaderboard:async()=>[structuredClone(other)],activity:async()=>[{...(await import('./testFixtures.js')).source(),timestamp:Date.now()/1000}]},
    verifier:{verify:async(address:string)=>{verifiedAddresses.push(address);return {...trader.verification,checkedAt:iso(),status:'verified' as const};}},
  });
  for(let scan=0;scan<4;scan++) await engine.runScan();
  assert.ok(verifiedAddresses.filter(a=>a===pin.address).length>=4,'the off-board pin was re-verified on every scan');
  const after=store.state.traders.find(t=>t.address===pin.address);
  assert.ok(after);assert.equal(after.selected,true,'four scans later the pin is still copied');
  assert.equal(after.selectionOverride,'include');
  // Muting is equally durable: an excluded wallet never comes back through the streak path.
  await engine.toggleTrader(other.address,false);
  for(let scan=0;scan<3;scan++) await engine.runScan();
  assert.equal(store.state.traders.find(t=>t.address===other.address)?.selected,false);
  await cleanup();
});

test('paper resume is blocked only by safety gates; release ceremony is advisory unless a code hash is pinned',async()=>{
  const {engine,store,cleanup}=await setup();
  // A fresh paper account: not cleanly shut down, never reconciled, no approved
  // hashes, no webhook. None of that is a reason to keep a paper bot idle.
  const first=await engine.conditionalResume();
  assert.equal(first.resumed,true);assert.equal(store.state.settings.paused,false);
  assert.ok(first.warnings.includes('Approved code hash matches'));
  assert.ok(first.warnings.includes('Webhook test is recent'));
  await engine.updateSettings({paused:true});
  // A latched halt is a safety gate and still refuses.
  store.state.account.riskHalt={reason:'Drawdown',triggeredAt:new Date().toISOString()};
  const halted=await engine.conditionalResume();
  assert.equal(halted.resumed,false);assert.equal(store.state.settings.paused,true);
  assert.ok(halted.checks.some(c=>c.name==='No risk halt'&&!c.passed&&c.blocking));
  // The refusal's own alert must not block the next attempt once the halt is cleared.
  store.state.account.riskHalt=undefined;
  assert.equal((await engine.conditionalResume()).resumed,true);
  // Resume arms a scan-and-deploy one second out; pausing disarms it so the
  // test never reaches the network after its store is closed.
  await engine.updateSettings({paused:true});
  await cleanup();
});

test('a pending event from a trader no longer monitored is dropped, not requoted forever',async()=>{
  const {engine,store,cleanup}=await setup();
  const {source,position,context}=await import('./testFixtures.js');
  const iso=new Date().toISOString();
  store.state.settings.paused=false;
  store.state.traders=[{...structuredClone(trader),lastActivityAt:iso,verification:{...trader.verification,checkedAt:iso}}];
  const orphan={...source('orphan'),asset:'orphan-asset',traderAddress:'0x000000000000000000000000000000000000dead',traderName:'gone'};
  store.state.account.pendingSourceEvents=[orphan];
  const quoted:string[]=[];
  Object.assign(engine,{
    polymarket:{activitySince:async()=>[],positions:async()=>[position({observedAt:iso,endDate:new Date(Date.now()+86400000).toISOString()})]},
    timing:{enrich:async()=>undefined},combos:{enrich:async()=>undefined},
    quotes:{lastUnavailableCount:0,fetch:async(assets:Array<{asset:string}>)=>{quoted.push(...assets.map(a=>a.asset));return context();}},
  });
  try {
    await engine.poll();
    assert.deepEqual(store.state.account.pendingSourceEvents,[],'the orphaned event no longer carries over');
    assert.ok(!quoted.includes(orphan.asset),'and its quote is no longer fetched');
  } finally {await cleanup();}
});

test('a job past its deadline is failed, state reverts to the last commit, and the engine asks to exit',async()=>{
  const {engine,store,cleanup}=await setup();
  const ex=(name:string,work:()=>Promise<unknown>)=>(engine as any).exclusive(name,work) as Promise<unknown>;
  const {PapertrailOrchestrator}=await import('./orchestrator.js');
  const original=(PapertrailOrchestrator as any).deadlineFor;
  (PapertrailOrchestrator as any).deadlineFor=()=>50;
  const cashBefore=store.state.account.cash;
  let hung:unknown;engine.once('hung',error=>{hung=error;});
  // Never released: an abandoned job stays abandoned, exactly as in production.
  const never=new Promise<void>(()=>undefined);
  try {
    await assert.rejects(ex('Poll',async()=>{store.state.account.cash=1;await never;}),/Poll exceeded its 0s deadline/);
    assert.equal(store.state.account.cash,cashBefore,'partial mutation discarded');
    assert.equal(store.state.settings.paused,true);
    assert.ok(hung instanceof Error,'index.ts is told to exit');
    assert.equal(engine.isHung,true);
    assert.ok(store.state.account.alerts?.some(a=>a.code==='worker-hung'&&a.level==='critical'),'critical alert blocks resume until acknowledged');
    await assert.rejects(ex('Poll',async()=>undefined),/Engine is stopping/,'nothing runs beside the abandoned job');
  } finally {(PapertrailOrchestrator as any).deadlineFor=original;await cleanup();}
});

test('shutdown abandons a job that does not drain in time and still releases the lock',async()=>{
  const {engine,store,directory,cleanup}=await setup();
  const ex=(name:string,work:()=>Promise<unknown>)=>(engine as any).exclusive(name,work) as Promise<unknown>;
  const cashBefore=store.state.account.cash;
  const never=new Promise<void>(()=>undefined);
  let started=false;
  void ex('Poll',async()=>{started=true;store.state.account.cash=1;await never;}).catch(()=>undefined);
  await new Promise(r=>setTimeout(r,0));
  assert.equal(started,true,'the job is in flight when SIGTERM arrives');
  await engine.stop(50);
  assert.equal(store.state.account.cash,cashBefore,'the abandoned job\'s mutation is not persisted');
  assert.equal(engine.isHung,true);
  const {existsSync}=await import('node:fs');
  assert.equal(existsSync(path.join(directory,'state.json.lock'))||existsSync(path.join(directory,'tradesnipes-v3.sqlite.lock')),false,'lock released');
  await cleanup();
});
