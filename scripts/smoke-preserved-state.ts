import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {StateStore} from '../src/server/store.js';
const original=await readFile('data/state.json');
const directory=await mkdtemp(path.join(tmpdir(),'papertrail-migration-smoke-'));
const file=path.join(directory,'state.json');await writeFile(file,original);
const store=new StateStore(file);
try {
  await store.load();await store.save();
  const source=JSON.parse(original.toString());
  if(store.state.account.cash!==source.account.cash||store.state.account.trades.length!==source.account.trades.length||store.state.account.positions.length!==source.account.positions.length) throw new Error('Legacy account changed during migration');
  console.log(JSON.stringify({legacyLoad:'passed',paused:store.state.settings.paused,strictQuotes:store.state.settings.risk.requireExecutableQuotes,positions:store.state.account.positions.length,decisions:store.state.account.trades.length,originalUnchanged:createHash('sha256').update(original).digest('hex')===createHash('sha256').update(await readFile('data/state.json')).digest('hex')},null,2));
} finally {await store.close();await rm(directory,{recursive:true,force:true});}
