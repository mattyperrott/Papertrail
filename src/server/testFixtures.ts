import type {SourcePosition,SourceTrade,TraderCandidate} from '../shared/types.js';
import {defaultSettings} from './config.js';
import type {ExecutionContext} from './paperExecution.js';
export const now=Date.parse('2026-09-09T00:00:00Z');
export const settings={...defaultSettings.risk,maxParticipationPct:100};
export const trader:TraderCandidate={address:'0x0000000000000000000000000000000000000001',name:'Fixture',provider:'polymarket',rank:1,pnl:1000,volume:10000,roi:20,winRate:80,trades:100,score:70,watched:true,selected:true,verification:{provider:'polymarketscan',checkedAt:new Date(now).toISOString(),url:'',status:'verified',wins:80,losses:20,roi:20,pnl:1000,notes:[]},reasons:[],openPositions:0,lastActivityAt:new Date(now).toISOString()};
export function source(id='buy',side:'BUY'|'SELL'='BUY',price=.5,shares=1000):SourceTrade {return {id,traderAddress:trader.address,traderName:trader.name,timestamp:now/1000,side,asset:'asset',conditionId:'condition',title:'Fixture market',outcome:'Yes',price,shares,notional:price*shares,provider:'polymarket',eventSlug:'event'};}
export function position(overrides:Partial<SourcePosition>={}):SourcePosition {return {traderAddress:trader.address,asset:'asset',conditionId:'condition',title:'Fixture market',outcome:'Yes',size:1000,avgPrice:.5,currentPrice:.5,currentValue:500,pnl:0,redeemable:false,endDate:new Date(now+86_400_000).toISOString(),observedAt:new Date(now).toISOString(),eventSlug:'event',...overrides};}
export function context(bid=.49,ask=.5,size=100000,feeRate=.05):ExecutionContext {return {sourcePositionsAsOf:now,consumed:{},quotes:{asset:{asset:'asset',capturedAt:now,bids:[{price:bid,size}],asks:[{price:ask,size}],tickSize:.01,minOrderShares:1,feeRate,feeExponent:1}}};}
