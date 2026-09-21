import assert from 'node:assert/strict';
import test from 'node:test';
import {applySourceTrade,createPaperAccount,deployCurrentPositions,enforceRiskLimits,recordEquityPoint} from './paperEngine.js';
import {calculatePerformance} from './performance.js';
import {context,now,position,settings,source,trader} from './testFixtures.js';

test('actual BUY levels obey the entry ceiling even when source price equals the ceiling',()=>{
  const account=createPaperAccount(50000);
  const trade=applySourceTrade(account,source('ceiling','BUY',.9),trader,settings,[position({avgPrice:.9,currentPrice:.9})],now,context(.9,.91));
  assert.equal(trade.status,'skipped');assert.equal(account.positions.length,0);
});
test('actual BUY levels obey drift from source cost basis',()=>{
  const account=createPaperAccount(50000);
  const trade=applySourceTrade(account,source('drift','BUY',.515),trader,settings,[position({avgPrice:.5,currentPrice:.515})],now,context(.51,.52));
  assert.equal(trade.status,'skipped');
});
test('stopped position cannot be repurchased by deployment',()=>{
  const account=createPaperAccount(50000);
  applySourceTrade(account,source(),trader,settings,[position()],now,context());
  account.positions[0].currentPrice=.3;account.positions[0].currentValue=account.positions[0].shares*.3;
  enforceRiskLimits(account,settings,now,context(.3,.31));
  assert.equal(account.positions.length,0);
  deployCurrentPositions(account,[position()],[trader],settings,now+1,context());
  assert.equal(account.positions.length,0);
});
test('historical drawdown survives sample eviction and serialization',()=>{
  const account=createPaperAccount(100);account.equityHistory=[];
  const start=Date.UTC(2025,0,1);
  [100,120,90,100].forEach((cash,i)=>{account.cash=cash;recordEquityPoint(account,start+i*1000);});
  for(let i=0;i<600;i++) recordEquityPoint(account,start+86_400_000+i*1000);
  const restored=JSON.parse(JSON.stringify(account));
  assert.equal(calculatePerformance(restored,start+2*86_400_000).maxDrawdownPct,25);
});
