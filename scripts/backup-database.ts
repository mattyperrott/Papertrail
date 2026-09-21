import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const source=path.resolve(process.argv[2]??'data/tradesnipes-v3.sqlite');
const target=path.resolve(process.argv[3]??`data/backups/tradesnipes-v3-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
if(!existsSync(source))throw new Error(`Source database does not exist: ${source}`);
if(existsSync(target))throw new Error(`Refusing to overwrite backup: ${target}`);
mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
const database=new DatabaseSync(source,{readOnly:true});
const check=Object.values(database.prepare('PRAGMA integrity_check').get() as Record<string,string>)[0];
if(check!=='ok'){database.close();throw new Error(`Source integrity check failed: ${check}`);}
database.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);database.close();
chmodSync(target,0o600);
const verify=new DatabaseSync(target,{readOnly:true});
const restored=Object.values(verify.prepare('PRAGMA integrity_check').get() as Record<string,string>)[0];verify.close();
if(restored!=='ok')throw new Error(`Backup verification failed: ${restored}`);
console.log(JSON.stringify({source,target,integrity:'ok',createdAt:new Date().toISOString()}));
