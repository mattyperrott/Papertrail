import assert from 'node:assert/strict';
import test from 'node:test';
import {accountEquity,applySourceTrade,createPaperAccount,deployCurrentPositions,enforceRiskLimits,liquidatePositionsOutsideHorizon,markPositions,recordEquityPoint,riskExposure,settleResolvedPositions} from './paperEngine.js';
import {context,now,position,settings,source,trader} from './testFixtures.js';
const buy=(account= createPaperAccount(50000),ctx=context())=>({account,trade:applySourceTrade(account,source(),trader,settings,[position()],now,ctx)});
function invariant(account:ReturnType<typeof createPaperAccount>) {
  assert.ok(account.cash>=-1e-8);
  for(const p of account.positions) {assert.ok(p.shares>0);assert.ok(Math.abs(p.shares*p.currentPrice-p.currentValue)<1e-7);assert.ok(Math.abs(p.costBasis+p.unrealizedPnl-p.currentValue)<1e-7);}
  const unrealized=account.positions.reduce((s,p)=>s+p.unrealizedPnl,0);
  assert.ok(Math.abs(accountEquity(account)-account.startingBalance-account.realizedPnl-unrealized)<1e-6);
}
test('fee-inclusive capped buy and profitable sell conserve the full account equation',()=>{
  const {account,trade}=buy();assert.equal(trade.status,'filled');assert.ok(trade.fees!>0);
  assert.ok(trade.notional+trade.fees!<=accountEquity(account)*.01+1e-7);
  const sell=applySourceTrade(account,source('sell','SELL',.7),trader,settings,[],now,context(.7,.71));
  assert.equal(sell.status,'filled');assert.ok(sell.realizedPnl>0);assert.equal(account.positions.length,0);invariant(account);
});
test('hard sizing does not rise with arbitrary score or absolute profits',()=>{
  const amounts=[60,100].map(score=>{const account=createPaperAccount(50000);return applySourceTrade(account,source(),{...trader,score},settings,[position()],now,context()).notional;});
  assert.equal(amounts[0],amounts[1]);
});
test('duplicates do not consume cash, depth, or audit rows twice, including after restart serialization',()=>{
  const {account}=buy();const restored=JSON.parse(JSON.stringify(account));const before=JSON.stringify(restored);
  assert.match(applySourceTrade(restored,source(),trader,settings,[position()],now,context()).reason,/Duplicate/);assert.equal(JSON.stringify(restored),before);
});
test('stale/future, NaN and inconsistent source economics fail closed',()=>{
  for(const patch of [{timestamp:now/1000-121},{timestamp:now/1000+10},{price:NaN},{notional:100},{shares:-1}]) {
    const account=createPaperAccount(50000);assert.equal(applySourceTrade(account,{...source(),...patch},trader,settings,[position()],now,context()).status,'skipped');assert.equal(account.cash,50000);
  }
});
test('fresh official position horizon and executable fee data are mandatory',()=>{
  for(const snapshot of [[],[position({endDate:undefined})],[position({endDate:'2028-01-01'})],[position({endDate:'2026-01-01'})],[position({observedAt:new Date(now-500000).toISOString()})]]) {
    assert.equal(applySourceTrade(createPaperAccount(50000),source(),trader,settings,snapshot,now,context()).status,'skipped');
  }
  assert.equal(buy(createPaperAccount(50000),{}).trade.status,'skipped');
  const stale=context();stale.quotes!.asset.capturedAt=now-16000;assert.equal(buy(createPaperAccount(50000),stale).trade.status,'skipped');
  const unknown=context();unknown.quotes!.asset.feeRate=undefined;assert.equal(buy(createPaperAccount(50000),unknown).trade.status,'skipped');
});
test('partial depth fills cannot reuse the same snapshot liquidity',()=>{
  const account=createPaperAccount(50000),ctx=context(.49,.5,10);
  const first=applySourceTrade(account,source(),trader,settings,[position()],now,ctx);assert.equal(first.shares,10);assert.ok(first.unfilledShares!>0);
  assert.equal(applySourceTrade(account,source('second'),trader,settings,[position()],now,ctx).status,'skipped');invariant(account);
});
test('no source notional is mistaken for executable market depth',()=>{
  const thin=buy(createPaperAccount(50000),context(.49,.5,1));assert.equal(thin.trade.status,'skipped');assert.equal(thin.account.cash,50000);
});
test('aggregate market, event, owner and total caps hold after fees and spread loss',()=>{
  const account=createPaperAccount(50000);const risk={...settings,maxPositionPct:1,maxTotalExposurePct:1,maxTraderExposurePct:1,maxEventExposurePct:1};
  for(let i=0;i<30;i++) applySourceTrade(account,source(String(i)),trader,risk,[position()],now,context());
  assert.ok(riskExposure(account.positions)<=accountEquity(account)*.01+1e-6);invariant(account);
});
test('scan deployment has a stable target rather than repeated ten-round pyramiding',()=>{
  const account=createPaperAccount(50000),ctx=context();
  const first=deployCurrentPositions(account,[position()],[trader],settings,now,ctx);assert.equal(first.filter(t=>t.status==='filled').length,1);
  const cost=account.positions[0].costBasis;
  deployCurrentPositions(account,[position({observedAt:new Date(now+1000).toISOString()})],[trader],settings,now+1000,context());
  assert.ok(account.positions[0].costBasis<=cost+1);invariant(account);
});
test('tiny source sells are not inflated to one percent and address matching is case insensitive',()=>{
  const {account}=buy();const before=account.positions[0].shares;
  const trade=applySourceTrade(account,{...source('tiny','SELL',.5,1),traderAddress:trader.address.toUpperCase()},trader,settings,[position({size:9999})],now,context(.5,.51));
  assert.ok(Math.abs(trade.shares-before*.0001)<1e-6);invariant(account);
});
test('settlement requires authoritative verification; exact payout occurs once',()=>{
  const {account}=buy();const p=account.positions[0];p.resolutionStatus='resolved';p.result='won';
  assert.equal(settleResolvedPositions(account,now).length,0);
  p.lastVerifiedAt=new Date(now).toISOString();assert.equal(settleResolvedPositions(account,now).length,1);assert.equal(settleResolvedPositions(account,now).length,0);invariant(account);
});
test('horizon exits remain pending with missing bids and pay fees when a bid returns',()=>{
  const {account}=buy();account.positions[0].expectedEndAt='2028-01-01';
  const pending=liquidatePositionsOutsideHorizon(account,7,now,settings);assert.equal(pending[0].status,'skipped');assert.equal(account.positions.length,1);
  const eq=accountEquity(account);const exits=liquidatePositionsOutsideHorizon(account,7,now,settings,context());assert.equal(exits[0].status,'filled');assert.ok(accountEquity(account)<eq);invariant(account);
});
test('drawdown halt latches and blocks further buys, but lets open lines run to settlement',()=>{
  const {account}=buy();account.highWaterEquity=60000;
  const shares=account.positions[0].shares;
  const exits=enforceRiskLimits(account,settings,now,context(.49,.5,10));assert.ok(account.riskHalt);
  assert.equal(exits.length,0,'no forced liquidation');assert.equal(account.positions[0].shares,shares);
  assert.match(applySourceTrade(account,source('blocked'),trader,settings,[position()],now,context()).reason,/Risk halt/);
  // The trader's own exit is still mirrored while halted: the halt stops adding risk, not managing it.
  const sell=applySourceTrade(account,source('sell','SELL',.7),trader,settings,[],now,context(.7,.71));
  assert.equal(sell.status,'filled');assert.equal(account.positions.length,0);invariant(account);
});
test('an operator emergency halt still liquidates, and only against actual available depth',()=>{
  const {account}=buy();
  account.riskHalt={reason:'Emergency halt: operator requested',triggeredAt:new Date(now).toISOString(),liquidate:true};
  const exits=enforceRiskLimits(account,settings,now,context(.49,.5,10));
  assert.equal(exits[0].reason,'Emergency halt liquidation');assert.equal(exits[0].shares,10);assert.equal(account.positions.length,1);invariant(account);
});
test('invalid and stale marks never overwrite account valuation',()=>{
  const {account}=buy();const value=account.positions[0].currentValue;
  markPositions(account,[position({currentPrice:NaN})],now,{});assert.equal(account.positions[0].currentValue,value);
  markPositions(account,[position({currentPrice:.9,observedAt:new Date(now-999999).toISOString()})],now,{});assert.equal(account.positions[0].currentValue,value);invariant(account);
});
test('entry price ceiling refuses the asymmetric payoff at short odds',()=>{
  const account=createPaperAccount(50000);
  const trade=applySourceTrade(account,source('short','BUY',.95,1000),trader,settings,[position({avgPrice:.95,currentPrice:.95})],now,context(.94,.95));
  assert.equal(trade.status,'skipped');assert.match(trade.reason,/ceiling/);assert.equal(account.cash,50000);
});
test('copying a live position refuses prices that already ran past the source entry',()=>{
  const chased=applySourceTrade(createPaperAccount(50000),source('chased','BUY',.8,1000),trader,settings,[position({avgPrice:.5,currentPrice:.8})],now,context(.79,.8));
  assert.equal(chased.status,'skipped');assert.match(chased.reason,/above the source entry/);
  // Inside the drift allowance the same shape of copy still fills.
  const fresh=applySourceTrade(createPaperAccount(50000),source('fresh','BUY',.51,1000),trader,settings,[position({avgPrice:.5,currentPrice:.51})],now,context(.5,.51));
  assert.equal(fresh.status,'filled');
});
test('equity buffers stay bounded while daily closes accumulate',()=>{
  const account=createPaperAccount(100);const start=Date.UTC(2025,0,1);
  for(let d=0;d<120;d++) for(let s=0;s<96;s++) {account.cash=100*(1+d/1000);recordEquityPoint(account,start+d*86_400_000+s*900_000);}
  assert.equal(account.equityHistory.length,500);
  assert.equal(account.dailyCloses!.length,120);
});
test('seeded repeated buy/sell simulation preserves ledger invariants through 1000 decisions',()=>{
  const account=createPaperAccount(50000);let seed=42;
  for(let i=0;i<1000;i++) {
    seed=(1664525*seed+1013904223)>>>0;const price=(20+seed%60)/100;
    const side=i%3===0?'SELL':'BUY';
    applySourceTrade(account,source(`sim-${i}`,side,price,100),trader,settings,[position({currentPrice:price,size:1000})],now,context(price,price+.01,100,.05));invariant(account);
  }
});
test('scarce deployment budget is projected simultaneously, not consumed by array order',()=>{
  const account=createPaperAccount(50000);
  // Two traders in one event, budget only large enough for roughly one. The
  // stronger trader has the alphabetically later address, so address ordering
  // would have funded the weaker one.
  const risk={...settings,maxEventExposurePct:1,maxPositionPct:1,maxRiskPerTradePct:5};
  const weak={...trader,address:'0x'+'a'.repeat(40),score:20};
  const strong={...trader,address:'0x'+'f'.repeat(40),score:95};
  const positions=[weak,strong].map(t=>position({traderAddress:t.address}));
  deployCurrentPositions(account,positions,[weak,strong],risk,now,context(.49,.5,1_000_000));
  assert.equal(account.positions.length,2);
  assert.ok(Math.abs(account.positions[0].costBasis-account.positions[1].costBasis)<.3);
  invariant(account);
});
test('market tag filter selects on the market, not only on who traded it',()=>{
  const risk={...settings,allowedMarketTags:['sports']};
  const buy=(tags?:string[])=>applySourceTrade(createPaperAccount(50000),
    {...source('tag-'+String(tags)),marketTags:tags},trader,risk,[position()],now,context());
  assert.equal(buy(['sports','nfl']).status,'filled');
  const politics=buy(['politics','macro']);
  assert.equal(politics.status,'skipped');assert.match(politics.reason,/outside the configured categories/);
  // Fail closed when tags could not be established, rather than assuming a match.
  const unknown=buy(undefined);
  assert.equal(unknown.status,'skipped');assert.match(unknown.reason,/could not be established/);
  // No configured categories means no restriction.
  assert.equal(applySourceTrade(createPaperAccount(50000),{...source('nofilter'),marketTags:['politics']},
    trader,settings,[position()],now,context()).status,'filled');
});
test('an acknowledged halt clears without discarding the account and cannot re-trip on the same drawdown',()=>{
  // Mirrors orchestrator.acknowledgeHalt at the engine level.
  const {account}=buy();account.highWaterEquity=60000;
  enforceRiskLimits(account,settings,now,context(.49,.5,10));
  assert.ok(account.riskHalt,'halt latches');
  recordEquityPoint(account,now);   // the mark cycle that follows every enforcement in production
  const equity=accountEquity(account);const fills=account.trades.filter(t=>t.status==='filled').length;
  account.riskHalt=undefined;account.highWaterEquity=equity;   // acknowledge
  enforceRiskLimits(account,settings,now+1,context(.49,.5,10));
  assert.equal(account.riskHalt,undefined,'re-based high water does not re-trip on unchanged equity');
  assert.equal(account.trades.filter(t=>t.status==='filled').length,fills,'history intact');
  assert.ok(account.maxDrawdownPctObserved!>=10,'the historical drawdown record survives acknowledgement');
});
test('a stale mark on a position whose market already ended does not freeze new entries',()=>{
  const {account}=buy();
  const p=account.positions[0];
  p.updatedAt=new Date(now-3_600_000).toISOString();          // an hour stale
  p.expectedEndAt=new Date(now-60_000).toISOString();          // market ended a minute ago
  const next=applySourceTrade(account,{...source('next'),asset:'other'},trader,settings,[position({asset:'other'})],now,context());
  assert.notEqual(next.reason,'Portfolio contains stale marks; refresh before adding risk');
  // The same staleness on a LIVE market still blocks: that is a genuine data gap.
  p.expectedEndAt=new Date(now+86_400_000).toISOString();
  const blocked=applySourceTrade(account,{...source('blocked'),asset:'third'},trader,settings,[position({asset:'third'})],now,context());
  assert.match(blocked.reason,/stale marks/);
});
test('a force-closed position is not bought straight back on the trader\'s next live fill',()=>{
  // Live run, 2026-09-13: one market was stop-lossed / cap-closed and rebuilt
  // seven times in forty minutes because only the deploy path checked the cooldown.
  const {account}=buy();
  account.positions[0].currentPrice=.35;account.positions[0].currentValue=account.positions[0].shares*.35;   // -30%: stop-loss
  const exits=enforceRiskLimits(account,settings,now,context(.34,.35,1e6));
  assert.equal(exits[0].reason,'Position stop loss');assert.equal(exits[0].status,'filled');assert.equal(account.positions.length,0);
  const rebuy=applySourceTrade(account,source('again'),trader,settings,[position({currentPrice:.35})],now+60_000,context(.34,.35));
  assert.equal(rebuy.status,'skipped');assert.match(rebuy.reason,/re-entry lock/);
  // Re-entry is allowed only after the source inventory is observed at zero and
  // a genuinely later source BUY arrives.
  const zeroAt=now+120_000;
  markPositions(account,[position({size:0,observedAt:new Date(zeroAt).toISOString()})],zeroAt,{},settings);
  const later=zeroAt+1;
  const fresh=applySourceTrade(account,{...source('later'),timestamp:later/1000},trader,settings,[position({currentPrice:.35,observedAt:new Date(later).toISOString(),endDate:new Date(later+86_400_000).toISOString()})],later,{...context(.34,.35),sourcePositionsAsOf:later,quotes:{asset:{...context(.34,.35).quotes!.asset,capturedAt:later}}});
  assert.equal(fresh.status,'filled');
  invariant(account);
});
/** Grow the fixture position to `shares` at its current price, paying from cash so
 * the account equation still balances. */
function grow(account:ReturnType<typeof createPaperAccount>,shares:number) {
  const p=account.positions[0];const extra=shares-p.shares;const cost=extra*p.currentPrice;
  p.shares=shares;p.costBasis+=cost;p.currentValue=p.shares*p.currentPrice;p.unrealizedPnl=p.currentValue-p.costBasis;account.cash-=cost;
  return p;
}
test('a concentration breach trims the excess instead of closing the whole line',()=>{
  const {account}=buy();
  // 25% over the per-market cap at an unchanged price.
  const p=grow(account,accountEquity(account)*settings.maxPositionPct/100*1.25/account.positions[0].currentPrice);
  const before=p.shares;
  const exits=enforceRiskLimits(account,settings,now,context(.49,.5,1e6));
  assert.equal(exits[0].reason,'Portfolio concentration limit');assert.equal(exits[0].status,'filled');
  assert.equal(account.positions.length,1,'the position survives');
  assert.ok(account.positions[0].shares<before&&account.positions[0].shares>before*.7,'only the excess was sold');
  assert.ok(riskExposure(account.positions)<=accountEquity(account)*settings.maxPositionPct/100+1,'and the book now sits at the cap');
  assert.equal(account.riskClosedAt?.[p.id],undefined,'a trim is not a risk close: no re-entry cooldown');
  invariant(account);
});
test('a one-dollar overshoot is mark noise, not a concentration exit',()=>{
  const {account}=buy();const p=account.positions[0];
  // Risk exposure is max(cost, value); cost carries the entry fee, so size the
  // line by cost so that it lands fifty cents over the cap.
  grow(account,p.shares+(accountEquity(account)*settings.maxPositionPct/100+.5-p.costBasis)/p.currentPrice);
  assert.ok(riskExposure(account.positions)-accountEquity(account)*settings.maxPositionPct/100<1);
  assert.equal(enforceRiskLimits(account,settings,now,context(.49,.5,1e6)).length,0);
});
test('a voided market settles at the refund price and never freezes new entries while it waits',()=>{
  const {account}=buy();
  const p=account.positions[0];
  // Polymarket reports the market resolved 50/50 with a tournament end date days out.
  Object.assign(p,{resolutionStatus:'resolved',timingSource:'polymarket',lastVerifiedAt:new Date(now).toISOString(),result:'void',resolvedPrice:.5,
    expectedEndAt:new Date(now+5*86_400_000).toISOString(),updatedAt:new Date(now-2*86_400_000).toISOString()});
  // The stale mark on a resolved market is not a data gap: another wallet's signal still copies.
  const next=applySourceTrade(account,{...source('next'),asset:'other',conditionId:'c2'},trader,settings,[position({asset:'other',conditionId:'c2'})],now,
    {...context(),quotes:{other:{...context().quotes!.asset,asset:'other'}}});
  assert.notEqual(next.reason,'Portfolio contains stale marks; refresh before adding risk');
  const cash=account.cash;
  const settled=settleResolvedPositions(account,now);
  assert.equal(settled.length,1);assert.match(settled[0].reason,/void resolution: refunded at 0.50/);
  assert.ok(Math.abs(account.cash-cash-p.shares*.5)<1e-6,'shares redeem at the resolved price');
  assert.ok(!account.positions.some(x=>x.id===p.id));
  invariant(account);
});
test('a void without a usable resolved price is left alone rather than guessed',()=>{
  const {account}=buy();
  Object.assign(account.positions[0],{resolutionStatus:'resolved',timingSource:'polymarket',lastVerifiedAt:new Date(now).toISOString(),result:'void',resolvedPrice:undefined});
  assert.equal(settleResolvedPositions(account,now).length,0);assert.equal(account.positions.length,1);
});
