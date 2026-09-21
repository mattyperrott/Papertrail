import assert from 'node:assert/strict';
import test from 'node:test';
import {request} from 'node:http';
import {createApplication} from './index.js';
import {StateStore} from './store.js';
import {PapertrailOrchestrator} from './orchestrator.js';
test('API denies foreign origins, non-JSON mutations and nonlocal hosts; live gate stays closed',async()=>{
  const store=new StateStore();const engine=new PapertrailOrchestrator(store);const {app,closeStreams}=createApplication(engine,store);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`,{headers:{Origin:'https://evil.example'}})).status,403);
    const foreignHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(`${base}/api/state`,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    assert.equal(foreignHost,403);
    assert.equal((await fetch(`${base}/api/simulation/reset`,{method:'POST'})).status,415);
    const gates=await (await fetch(`${base}/api/validation`)).json();assert.equal(gates.liveEnabled,false);assert.equal(gates.eligibleForLive,false);
    assert.equal((await (await fetch(`${base}/api/health`)).json()).mode,'paper');
  } finally {closeStreams();await new Promise<void>(r=>server.close(()=>r()));}
});
