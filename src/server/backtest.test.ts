import assert from 'node:assert/strict';
import test from 'node:test';
import {replay,chronologicalValidation,type ReplayFrame} from './backtest.js';
import {context,position,source,trader,now} from './testFixtures.js';
const frame=():ReplayFrame=>({observedAt:now,traderSnapshotObservedAt:now,source:source(),trader,positions:[position()],execution:context()});
test('replay rejects future prices, verification, settlements and nonchronological observations',()=>{
  const f=frame();f.execution.quotes!.asset.capturedAt=now+1;assert.throws(()=>replay([f]),/Future/);
  assert.throws(()=>replay([{...frame(),traderSnapshotObservedAt:now+1}]),/future/);
  assert.throws(()=>replay([{...frame(),resolutions:[{asset:'asset',result:'won',observedAt:now+1,timingSource:'polymarket'}]}]),/Future/);
  assert.throws(()=>chronologicalValidation([{...frame(),observedAt:now+1},frame()],now),/chronological/);
});
test('replay applies the same accounting engine and both split segments are required',()=>{
  assert.equal(replay([frame()]).report.fills,1);assert.throws(()=>chronologicalValidation([frame()],now),/Both/);
});
