import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../server.mjs';
import {openStore} from '../store.mjs';
import {users,hash} from '../domain.mjs';
import {passwordHash} from '../auth.mjs';
import {processOne} from '../ai.mjs';
test('공개 개인별 체험: 비밀번호 없이 입장, 격리·권한·한도·만료·전용 정리',async()=>{
 const store=await openStore({local:'memory'});const hashes=Object.fromEntries(users.map(u=>[u.id,passwordHash('test-only-password')]));const app=await startServer({store,hashes,port:0,worker:false,secure:false});
 const base=`http://127.0.0.1:${app.port}`;
 const request=async(path,payload,cookie,expected=200)=>{const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers:{...(payload===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return {body:b,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  const a=await request('/api/demo/start',{}),b=await request('/api/demo/start',{});assert.notEqual(a.body.workspace,b.body.workspace);
  const wa=a.body.workspace,wb=b.body.workspace;
  await request(`/api/state?workspace=${wb}`,undefined,a.cookie,403);await request('/api/state?workspace=demo',undefined,a.cookie,403);
  await request(`/api/admin/workspace?workspace=${wa}`,{confirm:'RESET_DEMO'},a.cookie,403);
  await request(`/api/demo/role?workspace=${wa}`,{userId:'admin'},a.cookie,403);
  const c=await request(`/api/command?workspace=${wa}`,{type:'intake',payload:{paymentIds:['RB-00054','RB-00120','RB-00180'],docs:[{id:'PUBLIC-DOC',kind:'account',text:'모의 계좌·명의 확인서'}]}},a.cookie);
  const cid=c.body.caseId;
  await request(`/api/command?workspace=${wa}`,{type:'submit',payload:{caseId:cid}},a.cookie,403);
  await request(`/api/demo/role?workspace=${wa}`,{userId:'reviewer'},a.cookie);
  await request(`/api/command?workspace=${wa}`,{type:'review',payload:{caseId:cid,docIds:['PUBLIC-DOC'],confirmPaymentIds:['RB-00054','RB-00120','RB-00180'],reason:'모의 증빙 대조'}},a.cookie);
  await request(`/api/command?workspace=${wa}`,{type:'submit',payload:{caseId:cid}},a.cookie);
  const state=(await request(`/api/state?workspace=${wa}`,undefined,a.cookie)).body.state;
  assert.equal(state.cases[0].version,1);assert(state.events.every(e=>e.mode==='public_demo'));
  assert.equal((await request(`/api/state?workspace=${wb}`,undefined,b.cookie)).body.state.cases.length,0);
  await Promise.all([store.reserveNim(wa),store.reserveNim(wa),store.reserveNim(wa)]);await assert.rejects(store.reserveNim(wa),{code:'AI_DEMO_LIMIT'});
  await request(`/api/command?workspace=${wa}`,{type:'documents',payload:{caseId:cid,docs:[{id:'LIMIT-DOC',kind:'narrative',text:'모의 서술 증빙의 명의가 불명확하여 확인이 필요합니다.'}]}},a.cookie);
  let called=false;await processOne(store,wa,{call:async()=>{called=true;throw Error('한도 차단 실패');}});assert.equal(called,false);
  const limited=await store.read(wa);assert.equal(Object.values(limited.jobs)[0].error.code,'AI_DEMO_LIMIT');assert(Object.values(limited.tasks).some(t=>t.errorCode==='AI_DEMO_LIMIT'));assert.equal(limited.cases[cid].canPay,false);
  const account=await request('/api/login',{userId:'admin',password:'showcase-test-only'});await request('/api/demo/role',{userId:'reviewer'},account.cookie,403);
  await store.query("UPDATE w07_sessions SET expires_at=now()-interval '1 second' WHERE public_workspace=$1",[wa]);await request(`/api/state?workspace=${wa}`,undefined,a.cookie,401);
  await store.create('qa-protected');await store.tx(wa,s=>{s.publicDemo.createdAt='2020-01-01T00:00:00Z';});assert.equal(await store.cleanupTrials(),1);assert((await store.read('qa-protected')).epoch);assert((await store.read(wb)).epoch);await assert.rejects(store.read(wa),{code:'WORKSPACE'});
  const day=new Date().toISOString().slice(0,10);await store.query('INSERT INTO w07_public_limits(bucket,used) VALUES($1,60) ON CONFLICT(bucket) DO UPDATE SET used=60',[`nim:${day}`]);await assert.rejects(store.reserveNim(wb),{code:'AI_DEMO_LIMIT'});
  assert.equal((await store.read(wb)).publicDemo.aiUsed,0);
 }finally{await app.close();}
});
