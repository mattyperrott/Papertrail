import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source=path.resolve(process.argv[2]??'');
const target=path.resolve(process.argv[3]??'data/restore-verification/tradesnipes-v3.sqlite');
if(!process.argv[2]||!existsSync(source))throw new Error('Usage: npm run restore:verify -- BACKUP.sqlite [NEW_TARGET.sqlite]');
if(existsSync(target))throw new Error(`Refusing to overwrite restore target: ${target}`);
mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
const backup=new DatabaseSync(source,{readOnly:true});
const sourceCheck=Object.values(backup.prepare('PRAGMA integrity_check').get() as Record<string,string>)[0];
if(sourceCheck!=='ok'){backup.close();throw new Error(`Backup integrity check failed: ${sourceCheck}`);}
backup.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);backup.close();
chmodSync(target,0o600);
const restored=new DatabaseSync(target,{readOnly:true});
const targetCheck=Object.values(restored.prepare('PRAGMA integrity_check').get() as Record<string,string>)[0];
const snapshot=(restored.prepare('SELECT payload FROM state_snapshot WHERE id=1').get() as {payload:string}|undefined)?.payload;restored.close();
if(targetCheck!=='ok'||!snapshot)throw new Error('Restored database is missing a valid snapshot');
const state=JSON.parse(snapshot) as {account?:{accountId?:string};settings?:{paused?:boolean}};
console.log(JSON.stringify({source,target,integrity:'ok',accountId:state.account?.accountId,storedPaused:state.settings?.paused,warning:'Verification target only; do not replace an active database'}));
