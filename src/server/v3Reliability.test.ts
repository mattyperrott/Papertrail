import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AlertService } from './alerts.js';
import { benjaminiHochberg, estimateEdge, estimateShrinkagePool } from './edge.js';
import { applySourceTrade, createPaperAccount, enforceRiskLimits } from './paperEngine.js';
import { StateStore } from './store.js';
import { context, now, position, settings, source, trader } from './testFixtures.js';
import { MarketBookStream } from './sources/executionQuotes.js';
import { reconstructTradeCycles } from './sources/traderHistory.js';

test('transient quote failures remain pending and fill exactly once after recovery',()=>{
  const account=createPaperAccount(50_000);
  const pending=applySourceTrade(account,source('retry'),trader,settings,[position()],now,{});
  assert.equal(pending.status,'skipped');assert.equal(account.pendingSourceEvents?.length,1);
  assert.ok(!account.processedSourceTradeIds.includes('retry'));
  const filled=applySourceTrade(account,source('retry'),trader,settings,[position()],now+1000,{...context(),sourcePositionsAsOf:now+1000,quotes:{asset:{...context().quotes!.asset,capturedAt:now+1000}}});
  assert.equal(filled.status,'filled');assert.equal(account.pendingSourceEvents?.length,0);assert.ok(account.processedSourceTradeIds.includes('retry'));
  assert.match(applySourceTrade(account,source('retry'),trader,settings,[position()],now+1000,context()).reason,/Duplicate/);
});

test('combo buys are blocked even when a displayed side exists',()=>{
  const result=applySourceTrade(createPaperAccount(50_000),{...source('combo'),isCombo:true,comboSide:'YES'},trader,settings,[position({isCombo:true,comboSide:'YES'})],now,context());
  assert.equal(result.status,'skipped');assert.match(result.reason,/Combo entries are disabled/);
});

test('UTC-day loss latches a halt independently of peak drawdown setting',()=>{
  const account=createPaperAccount(50_000);account.equityHistory=[{timestamp:new Date(now).toISOString(),equity:50_000,cash:50_000,exposure:0}];account.cash=48_900;
  enforceRiskLimits(account,{...settings,maxDrawdownPct:99,maxDailyLossPct:2},now+60_000,{});
  assert.match(account.riskHalt?.reason??'',/UTC-day loss/);
});

test('position-cycle reconstruction combines scaling buys and separates a true re-entry',()=>{
  const rows=[
    source('b1','BUY',.3,10),{...source('b2','BUY',.5,10),timestamp:now/1000+1},
    {...source('s1','SELL',.6,20),timestamp:now/1000+2},{...source('b3','BUY',.4,5),timestamp:now/1000+3},
  ];
  const cycles=reconstructTradeCycles(rows);
  assert.equal(cycles.length,2);assert.equal(cycles[0].boughtShares,20);assert.equal(cycles[0].entryCost,8);assert.equal(cycles[0].remainingShares,0);assert.equal(cycles[1].remainingShares,5);
});

test('recency, shrinkage, concentration, and BH correction are explicit',()=>{
  const day=86_400_000,start=Date.UTC(2026,0,1);
  const diversified=Array.from({length:60},(_,i)=>({price:.3,outcome:(i%3===0?0:1) as 0|1,eventKey:`e${i}`,occurredAt:start+i*day,quantity:1}));
  const estimate=estimateEdge(diversified,{now:start+60*day,bootstrapIterations:400});
  assert.ok(estimate.effectiveSampleSize<60&&estimate.effectiveSampleSize>40);
  assert.ok(estimate.maxProfitContributionPct<20);
  const pool=estimateShrinkagePool([estimate,{...estimate,meanEdge:-estimate.meanEdge}]);
  assert.ok(Number.isFinite(pool.poolMean)&&pool.shrinkageK>=1);
  assert.deepEqual(benjaminiHochberg([.01,.04,.2]).map(value=>Number(value.toFixed(2))),[.03,.06,.2]);
});

test('market websocket applies deltas only after a snapshot and ignores older deltas',()=>{
  const stream=new MarketBookStream();
  const receive=(value:unknown)=>(stream as unknown as {onMessage:(text:string)=>void}).onMessage(JSON.stringify(value));
  receive({event_type:'price_change',timestamp:'20',price_changes:[{asset_id:'a',side:'BUY',price:'.4',size:'2',hash:'h2'}]});
  assert.equal(stream.book('a'),undefined);
  receive({event_type:'book',asset_id:'a',timestamp:'10',hash:'h1',bids:[{price:'.3',size:'1'}],asks:[{price:'.5',size:'1'}]});
  receive({event_type:'price_change',timestamp:'20',price_changes:[{asset_id:'a',side:'BUY',price:'.4',size:'2',hash:'h2'}]});
  receive({event_type:'price_change',timestamp:'15',price_changes:[{asset_id:'a',side:'BUY',price:'.2',size:'9',hash:'old'}]});
  assert.equal((stream.book('a') as {hash:string}).hash,'h2');
  assert.equal(((stream.book('a') as {bids:Array<{price:string}>}).bids).some(level=>level.price==='.4'),true);
  stream.close();
});

test('SQLite WAL journal persists normalized audit tables and integrity survives restart',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tradesnipes-v3-')),file=path.join(directory,'state.json');
  const store=new StateStore(file);
  try {
    await store.load();store.state.account.alerts=[new AlertService().add(store.state.account,'warning','fixture','fixture alert')];await store.save();await store.close();
    const db=new DatabaseSync(store.databasePath,{readOnly:true});
    assert.equal((db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode,'wal');
    assert.equal((db.prepare('SELECT count(*) AS n FROM alerts').get() as {n:number}).n,1);
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string,string>)[0],'ok');db.close();
  } finally {await store.close().catch(()=>undefined);await rm(directory,{recursive:true,force:true});}
});
