import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('..');const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const credentials=JSON.parse(readFileSync('.local/credentials.json','utf8'));
const env=readFileSync('.env.local','utf8');const key=env.match(/^NVIDIA_API_KEY=(.*)$/m)?.[1];
const accounts=readFileSync(resolve(root,'01_참가자_배포용/04_원본데이터/01_corevia/master/m_agency_cv.csv'),'utf8').trim().split(/\r?\n/).slice(1).map(r=>r.split('|')[5]);
const violations=[];let scanned=0;
for(const path of paths){if(!existsSync(resolve(root,path)))continue;if(/^\.agents\/|^\.codex\/|^\.claude\/|^\.axhub\//.test(path)||/\.env(?:\.|$)|credentials\.json|\.dpapi$|node_modules\//.test(path))violations.push({path,kind:'private-path'});
 if(/\.(png|jpg|pdf|zip)$/.test(path))continue;
 const contents=readFileSync(resolve(root,path),'utf8');scanned++;
 if([key,...Object.values(credentials)].filter(Boolean).some(v=>contents.includes(v)))violations.push({path,kind:'secret-value'});
 if(accounts.some(a=>a&&a!=='NONE'&&contents.includes(a)))violations.push({path,kind:'full-account'});
}
const result={at:new Date().toISOString(),scope:'Git tracked + nonignored candidate files',scanned,violations,secretValuesPrinted:false,passed:violations.length===0};
writeFileSync(resolve(root,'작업/실행결과/비밀정보_검사.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(violations.length)process.exitCode=1;
