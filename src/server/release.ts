import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function files(root:string):string[] {
  return readdirSync(root).flatMap(name=>{const file=path.join(root,name);return statSync(file).isDirectory()?files(file):[file];});
}

export function currentCodeHash(root=process.cwd()) {
  const hash=createHash('sha256');
  const selected=[path.join(root,'package-lock.json'),...files(path.join(root,'src','server')),...files(path.join(root,'src','shared'))].sort();
  for(const file of selected){hash.update(path.relative(root,file));hash.update('\0');hash.update(readFileSync(file));hash.update('\0');}
  return hash.digest('hex');
}
