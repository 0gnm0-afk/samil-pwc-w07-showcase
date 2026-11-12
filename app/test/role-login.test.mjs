import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../server.mjs';
import {openStore} from '../store.mjs';
import {users,businessRoles,hash,actorFor,can} from '../domain.mjs';
import {passwordHash} from '../auth.mjs';
import {processOne} from '../ai.mjs';

test('5개 역할 비밀번호 로그인: 우회 차단·작업 유지·회계 검토/대사 통합·격리·한도·만료',async()=>{
 const store=await openStore({local:'memory'}),password='showcase-test-only';
 const hashes=Object.fromEntries([...users.map(u=>u.id),...businessRoles.map(r=>`role:${r.id}`)].map(id=>[id,passwordHash(password)]));
 const app=await startServer({store,hashes,port:0,worker:false,secure:false}),base=`http://127.0.0.1:${app.port}`;
 const client=()=>({jar:new Map()});const a=client(),b=client();
 async function req(who,path,payload,expected=200){const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers:{...(payload===undefined?{}:{'content-type':'application/json'}),cookie:[...who.jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:payload===undefined?undefined:JSON.stringify(payload)});const body=await r.json();assert.equal(r.status,expected,JSON.stringify(body));for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0].split('=');who.jar.set(k,v.join('='));}return body;}
 const login=(who,roleId,member=businessRoles.find(r=>r.id===roleId).members[0].id)=>req(who,'/api/login',{roleId,member,password});
 const cmd=(type,payload,expected=200)=>req(a,'/api/command',{type,payload},expected);
 const state=async()=> (await req(a,'/api/state')).state;
 try{
  assert.deepEqual((await req(a,'/api/roles')).map(r=>r.name),['영업지원','회계팀','영업 임원','재무 임원','자금팀']);
  assert.equal(new Set(users.filter(u=>u.role!=='admin').map(u=>u.role)).size,5);
  assert(can(actorFor('reviewer'),'reconciler'));assert(!can(actorFor('intake'),'sales'));
  await req(a,'/api/state',undefined,401);await req(a,'/api/demo/start',{},410);await req(a,'/api/demo/role',{userId:'finance'},410);
  await req(a,'/api/login',{roleId:'sales',member:'intake',password:'wrong'},401);
  await req(a,'/api/login',{roleId:'sales',member:'admin',password},401);
  assert.equal((await store.query("SELECT count(*)::int AS n FROM w07_workspaces WHERE id LIKE 'trial-%'")).rows[0].n,0);
  const wa=(await login(a,'sales')).workspace,wb=(await login(b,'sales')).workspace;assert.notEqual(wa,wb);
  await req(a,`/api/state?workspace=${wb}`,undefined,403);await req(a,'/api/state?workspace=demo',undefined,403);
  await req(a,'/api/admin/workspace',{confirm:'RESET_DEMO'},403);
  const ids=['RB-00054','RB-00120','RB-00180'];
  await cmd('schedule',{items:ids.map(id=>({id,date:'2026-07-10'}))});
  const cid=(await cmd('intake',{paymentIds:ids,docs:[{id:'ROLE-DOC',kind:'account',text:'모의 계좌·명의 확인서'}]})).caseId;
  await cmd('submit',{caseId:cid},403);await cmd('decide',{caseId:cid,version:1,decision:'approve',reason:'자기 승인 시도'},403);
  const oldSession=a.jar.get('w07_session');await req(a,'/api/logout',{});await req(a,'/api/state',undefined,401);
  await req(a,'/api/login',{roleId:'accounting',member:'reviewer',password:'wrong'},401);await req(a,'/api/state',undefined,401);
  assert.equal((await login(a,'accounting')).workspace,wa);assert.notEqual(a.jar.get('w07_session'),oldSession);
  await cmd('review',{caseId:cid,docIds:(await state()).cases.find(c=>c.id===cid).evidenceAssessment.records.map(d=>d.id),confirmPaymentIds:ids,reason:'모의 증빙 대조'});await cmd('submit',{caseId:cid});
  await cmd('pay',{caseId:cid,version:1,paymentId:ids[0]},403);
  await login(a,'executive');await cmd('decide',{caseId:cid,version:1,decision:'approve',reason:'사업상 타당성 확인'});
  await login(a,'treasury');const instructions=[];
  for(const paymentId of ids){const {instruction:i}=await cmd('pay',{caseId:cid,version:1,paymentId});instructions.push(i);await cmd('bank',{instructionId:i.id,receiptId:`ROLE-${paymentId}`,date:i.date,amount:i.amount,outcome:'success'});}
  await cmd('reconcile',{instructionId:instructions[0].id,voucherId:'WRONG',amount:instructions[0].amount},403);
  await login(a,'accounting');for(const i of instructions)await cmd('reconcile',{instructionId:i.id,voucherId:`V-${i.paymentId}`,amount:i.amount});
  const completed=await state();assert.equal(completed.cases[0].status,'completed');assert.equal(completed.instructions.length,3);assert(completed.events.some(e=>e.type==='reconcile'&&e.actor==='reviewer'));
  assert.equal((await req(b,'/api/state')).state.cases.length,0);
  for(const r of businessRoles)assert.equal((await login(a,r.id)).user.role,r.id);
  // Legacy anonymous sessions are not accepted after the login rollout.
  await store.tx(wb,s=>{delete s.publicDemo.authVersion;});await req(b,'/api/state',undefined,401);
  await store.tx(wb,s=>{s.publicDemo.authVersion=2;});
  await Promise.all([store.reserveNim(wb),store.reserveNim(wb),store.reserveNim(wb)]);await store.reserveNim(wb);assert.equal((await store.read(wb)).publicDemo.aiUsed,4);
  await req(b,'/api/command',{type:'schedule',payload:{items:ids.map(id=>({id,date:'2026-07-10'}))}});
  const bid=(await req(b,'/api/command',{type:'intake',payload:{paymentIds:ids,docs:[{id:'LIMIT-DOC',kind:'narrative',text:'모의 서술 증빙의 명의가 불명확하여 확인이 필요합니다.'}]}})).caseId;
  let called=false;await processOne(store,wb,{call:async()=>{called=true;throw Error('검증용 응답 실패');}});assert.equal(called,true);assert.equal((await store.read(wb)).cases[bid].canPay,false);
  // Workspace anchor is not an authenticated session token.
  const forged=client();forged.jar.set('w07_session',a.jar.get('w07_space'));await req(forged,'/api/state',undefined,401);
  await store.query("UPDATE w07_sessions SET expires_at=now()-interval '1 second' WHERE public_workspace=$1",[wa]);await req(a,'/api/state',undefined,401);
  const next=await login(a,'sales');assert.notEqual(next.workspace,wa);
  await store.create('qa-protected');await store.tx(wa,s=>{s.publicDemo.createdAt='2020-01-01T00:00:00Z';});assert.equal(await store.cleanupTrials(),1);assert((await store.read('qa-protected')).epoch);assert((await store.read(wb)).epoch);await assert.rejects(store.read(wa),{code:'WORKSPACE'});
 }finally{await app.close();}
});
