import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initialState,actorFor,command,publicState,users,businessRoles} from '../domain.mjs';
import {source,openStore} from '../store.mjs';
import {previewIntake} from '../batch-intake.mjs';
import {startServer} from '../server.mjs';
import {passwordHash} from '../auth.mjs';
import {processOne} from '../ai.mjs';
const act=(s,u,t,p)=>command(s,actorFor(u),t,p);
const payload=(s,ids=Object.values(s.plans).filter(p=>p.status==='planned').map(p=>p.id))=>({...previewIntake(s,actorFor('intake'),{paymentIds:ids,plannedMonth:'2026-07'}),requestId:randomUUID()});
test('40건 일괄 접수는 38개 검토 건·월 지정만 저장하고 중복 재시도와 원자성을 지킨다',()=>{
 const s=initialState(source),p=payload(s),before=JSON.stringify(s);assert.equal(p.groups.length,38);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>act(s,'intake','batchIntake',{...p,previewHash:'old'}),{code:'INTAKE_CHANGED'});assert.equal(JSON.stringify(s),before);
 const r=act(s,'intake','batchIntake',p);assert.equal(r.groups,38);assert.equal(r.count,40);assert.equal(Object.keys(s.cases).length,38);
 assert.equal(act(s,'intake','batchIntake',p).duplicate,true);assert.equal(Object.keys(s.cases).length,38);
 assert(Object.values(s.plans).filter(p=>p.caseId).every(p=>p.plannedMonth==='2026-07'&&p.plannedDate===null));
 assert.throws(()=>act(s,'intake','batchIntake',{...p,plannedMonth:'2026-08'}),{code:'REQUEST_CONFLICT'});
 const good=Object.values(s.cases).find(c=>c.canSubmit),pid=good.paymentIds[0];act(s,'reviewer','submit',{caseId:good.id});
 act(s,good.currentBasis.required[0].userId,'decide',{caseId:good.id,version:1,decision:'approve',reason:'원본 검토'});
 assert.throws(()=>act(s,'treasury','pay',{caseId:good.id,paymentId:pid,version:1,date:'2026-08-01'}),{code:'PAYMENT_MONTH'});
 const i=act(s,'treasury','pay',{caseId:good.id,paymentId:pid,version:1,date:'2026-07-10'}).instruction;
 act(s,'treasury','bank',{instructionId:i.id,receiptId:'BATCH-BANK',date:i.date,amount:i.amount,outcome:'success'});act(s,'reviewer','reconcile',{instructionId:i.id,voucherId:'BATCH-V',amount:i.amount});assert.equal(good.status,'completed');
});
test('부분 선택도 D-024 소명 단서를 전달하고 미정월·미확인 소명은 상신 전에 확인한다',()=>{
 const s=initialState(source);for(const id of ['RB-00120','RB-00180'])s.plans[id].plannedMonth='2026-07';
 const {caseIds:[id]}=act(s,'intake','batchIntake',payload(s,['RB-00054'])),c=s.cases[id];
 assert.equal(c.currentBasis.total,3888097);assert.equal(c.currentBasis.selectedTotal,1373515);assert.equal(c.canSubmit,false);
 assert(c.sourceReview.payments[0].checks.some(k=>k.code==='collection_account'&&k.message.includes('D-024')));assert(Object.values(s.jobs).length>0);
 const docs=c.sourceReview.records.map(d=>d.id);act(s,'reviewer','review',{caseId:id,docIds:docs,confirmPaymentIds:c.paymentIds,reason:'관련 거래처 입금 차이의 사업상 사유를 확인'});assert.equal(c.canSubmit,true);
 const fresh=initialState(source),r=act(fresh,'intake','batchIntake',payload(fresh,['RB-00054']));assert.equal(fresh.cases[r.caseIds[0]].currentBasis.missing.length,2);assert.equal(fresh.cases[r.caseIds[0]].canSubmit,false);
});
test('지급월 변경은 기존 승인을 무효화하고 재검토·재승인 전 지급을 막는다',()=>{
 const s=initialState(source);act(s,'intake','batchIntake',payload(s));const c=Object.values(s.cases).find(c=>c.canSubmit),pid=c.paymentIds[0];
 act(s,'reviewer','submit',{caseId:c.id});act(s,c.currentBasis.required[0].userId,'decide',{caseId:c.id,version:1,decision:'approve',reason:'원본 확인'});
 act(s,'intake','changeMonth',{caseId:c.id,plannedMonth:'2026-08',reason:'지급월 변경 요청'});
 assert.equal(c.currentBasis.month,'2026-08');assert.equal(c.needsResubmit,true);assert.equal(c.canSubmit,false);assert.equal(c.status,'held');
 act(s,'treasury','pay',{caseId:c.id,paymentId:pid,version:1,date:'2026-08-10'});assert.equal(s.instructions[pid],undefined);
 const docs=c.sourceReview.records.map(d=>d.id);act(s,'reviewer','review',{caseId:c.id,docIds:docs,resolveKeys:['schedule'],reason:'변경 지급월 확인'});assert.equal(c.canSubmit,true);
 act(s,'reviewer','submit',{caseId:c.id});assert.equal(c.version,2);
 act(s,c.currentBasis.required[0].userId,'decide',{caseId:c.id,version:2,decision:'approve',reason:'변경월 승인'});
 assert.equal(act(s,'treasury','pay',{caseId:c.id,paymentId:pid,version:2,date:'2026-08-10'}).instruction.date,'2026-08-10');
});
test('개인 시연 초기화는 다른 공간·원본·세션을 보존하고 실패·오래된 명령·지연 AI를 차단한다',async()=>{
 const store=await openStore({local:'memory'}),pw='local-test';const hashes=Object.fromEntries([...users.map(u=>u.id),...businessRoles.map(r=>'role:'+r.id)].map(id=>[id,passwordHash(pw)]));
 const app=await startServer({store,hashes,port:0,worker:false,secure:false});const base=`http://127.0.0.1:${app.port}`;
 const client=()=>({jar:new Map()});const a=client(),b=client();
 async function req(who,path,p,expected=200){const r=await fetch(base+path,{method:p===undefined?'GET':'POST',headers:{'content-type':'application/json',cookie:[...who.jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:p===undefined?undefined:JSON.stringify(p)});const body=await r.json();assert.equal(r.status,expected,JSON.stringify(body));for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0].split('=');who.jar.set(k,v.join('='));}return body;}
 try{
  await req(a,'/api/demo/reset',{confirm:'RESET_MY_DEMO'},401);
  const wa=(await req(a,'/api/login',{roleId:'sales',member:'intake',password:pw})).workspace,wb=(await req(b,'/api/login',{roleId:'sales',member:'intake',password:pw})).workspace;
  const s=(await req(a,'/api/state')).state,preview=await req(a,'/api/intake/preview',{paymentIds:['RB-00006','RB-00054','RB-00120','RB-00180'],plannedMonth:'2026-07'});
  await req(a,'/api/command',{type:'batchIntake',epoch:s.epoch,payload:{...preview,requestId:randomUUID()}});
  await store.tx(wa,state=>{const c=Object.values(state.cases).find(c=>c.canSubmit);act(state,'reviewer','submit',{caseId:c.id});act(state,c.currentBasis.required[0].userId,'decide',{caseId:c.id,version:1,decision:'approve',reason:'원본 확인'});const i=act(state,'treasury','pay',{caseId:c.id,paymentId:c.paymentIds[0],version:1,date:'2026-07-10'}).instruction;act(state,'treasury','bank',{instructionId:i.id,receiptId:'RESET-BANK',date:i.date,amount:i.amount,outcome:'success'});act(state,'reviewer','reconcile',{instructionId:i.id,voucherId:'RESET-V',amount:i.amount});});
  const expiry=(await store.read(wa)).publicDemo.expiresAt;
  let release,started;const ready=new Promise(r=>started=r);const job=processOne(store,wa,{call:async()=>{started();await new Promise(r=>release=r);throw Error('late response');}});await ready;
  await req(a,`/api/demo/reset?workspace=${wb}`,{confirm:'RESET_MY_DEMO',epoch:s.epoch},403);
  const changed=JSON.stringify(await store.read(wa));await req(a,'/api/demo/reset',{confirm:'RESET_MY_DEMO',epoch:'old'},409);assert.equal(JSON.stringify(await store.read(wa)),changed);
  await store.query(`ALTER TABLE w07_workspaces ADD CONSTRAINT test_reset_failure CHECK(id <> '${wa}' OR state->>'epoch'='${s.epoch}')`);
  await req(a,'/api/demo/reset',{confirm:'RESET_MY_DEMO',epoch:s.epoch},500);assert.equal(JSON.stringify(await store.read(wa)),changed);
  for(const table of ['w07_instructions','w07_approvals','w07_receipts'])assert((await store.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[wa])).rows[0].n>0);
  await store.query('ALTER TABLE w07_workspaces DROP CONSTRAINT test_reset_failure');
  const reset=await req(a,'/api/demo/reset',{confirm:'RESET_MY_DEMO',epoch:s.epoch});assert.notEqual(reset.epoch,s.epoch);release();await job;
  const current=(await req(a,'/api/state')).state;assert.equal(current.cases.length,0);assert.equal(current.events.length,0);assert.equal(current.jobs.length,0);assert.equal(current.plans.filter(p=>p.status==='planned').length,40);assert.equal(current.publicDemo.expiresAt,expiry);assert.deepEqual(current.sourceRows,publicState(initialState(source),actorFor('intake')).sourceRows);
  assert.equal((await req(b,'/api/state')).state.epoch,(await store.read(wb)).epoch);
  await req(a,'/api/command',{type:'schedule',epoch:s.epoch,payload:{items:[{id:'RB-00054',date:'2026-07-10'}]}},409);
  await req(a,'/api/command',{type:'schedule',payload:{items:[{id:'RB-00054',date:'2026-07-10'}]}},409);
  assert.equal((await req(a,'/api/login',{roleId:'accounting',member:'reviewer',password:pw})).workspace,wa);
  for(const table of ['w07_instructions','w07_approvals','w07_receipts'])assert.equal((await store.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[wa])).rows[0].n,0);
 }finally{await app.close();}
});
