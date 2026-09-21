import assert from 'node:assert/strict';
import test from 'node:test';
import {createHttpClient} from './http.js';
test('read retries transient errors, respects retry-after, refuses redirects and redacts upstream body',async()=>{
  let calls=0;const client=createHttpClient({minRequestIntervalMs:0,baseDelayMs:0,fetch:async(_url,init)=>{assert.equal(init?.redirect,'error');calls++;return calls===1?new Response('secret',{status:429,headers:{'retry-after':'0'}}):new Response('{"ok":true}');}});
  assert.deepEqual(await client.fetchJson('https://example.com/?secret=value'),{ok:true});assert.equal(calls,2);
  const rejected=createHttpClient({minRequestIntervalMs:0,fetch:async()=>new Response('secret-body',{status:401})});
  await assert.rejects(rejected.fetchText('https://example.com/?secret=value'),error=>error instanceof Error&&!error.message.includes('secret')&&error.message.includes('401'));
});
test('mutation requests never retry; caller cancellation and bounded timeout are honored',async()=>{
  let calls=0;const client=createHttpClient({minRequestIntervalMs:0,fetch:async()=>{calls++;throw Error('private');}});
  await assert.rejects(client.fetchText('https://example.com',{method:'POST'}));assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(client.fetchText('https://example.com',{signal:controller.signal}),/cancelled/);
  const hanging=createHttpClient({fetch:async(_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('aborted'))))});
  await assert.rejects(hanging.fetchText('https://example.com',{},10),/timed out/);
});
