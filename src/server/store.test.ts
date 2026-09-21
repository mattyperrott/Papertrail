import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StateStore,StateIntegrityError} from './store.js';
async function setup(){const directory=await mkdtemp(path.join(tmpdir(),'papertrail-store-'));return {directory,file:path.join(directory,'state.json')};}
test('persisted account round trips, concurrent saves serialize, restart pauses and single-writer lock excludes a second process',async()=>{
  const {directory,file}=await setup();const store=new StateStore(file);let reopened:StateStore|undefined;
  try {
    await store.load();store.state.settings.paused=false;
    await Promise.all([store.save(),store.save()]);const db=new DatabaseSync(store.databasePath,{readOnly:true});const saved=JSON.parse((db.prepare('SELECT payload FROM state_snapshot WHERE id=1').get() as {payload:string}).payload);db.close();assert.equal(saved.settings.paused,false);
    await assert.rejects(new StateStore(file).load(),/locked/);
    await store.close();reopened=new StateStore(file);await reopened.load();assert.equal(reopened.state.settings.paused,true);assert.equal(reopened.state.account.cash,50000);
  } finally {await reopened?.close();await store.close();await rm(directory,{recursive:true,force:true});}
});
test('corrupt account never silently resets or overwrites original file',async()=>{
  const {directory,file}=await setup();const original='{bad json';await writeFile(file,original);const store=new StateStore(file);
  try {await assert.rejects(store.load(),StateIntegrityError);await assert.rejects(store.save(),StateIntegrityError);assert.equal(await readFile(file,'utf8'),original);}
  finally {await store.close();await rm(directory,{recursive:true,force:true});}
});
test('malformed account marks and nonfinite state cannot be committed',async()=>{
  const {directory,file}=await setup();const store=new StateStore(file);
  try {await store.load();await store.save();store.state.account.cash=NaN;await assert.rejects(store.save(),StateIntegrityError);const db=new DatabaseSync(store.databasePath,{readOnly:true});const saved=JSON.parse((db.prepare('SELECT payload FROM state_snapshot WHERE id=1').get() as {payload:string}).payload);db.close();assert.equal(saved.account.cash,50000);}
  finally {await store.close();await rm(directory,{recursive:true,force:true});}
});
