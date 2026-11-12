import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generateWorkflow } from './workflow-model.mjs';
generateWorkflow();
function scan(dir) { for(const entry of readdirSync(dir,{withFileTypes:true})) {
  if(['node_modules','.local'].includes(entry.name)) continue;
  const path=`${dir}/${entry.name}`;
  if(entry.isDirectory()) scan(path);
  else if(/\.(mjs|js)$/.test(path)) {const r=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(r.status)process.exit(r.status);}
}}
scan('.'); console.log('소스 구문 검사 통과');
