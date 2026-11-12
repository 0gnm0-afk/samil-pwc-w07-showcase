import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initialState,command,actorFor,publicState} from '../domain.mjs';
import {source,openStore} from '../store.mjs';
import {guidanceContext,validateGuidance,createGuidanceService,callGuidance} from '../guidance.mjs';
import {extractWorkflow} from '../scripts/workflow-model.mjs';
import {workflowModel} from '../workflow.mjs';
import {startServer} from '../server.mjs';
import {passwordHash} from '../auth.mjs';
import {users,businessRoles} from '../domain.mjs';
const act=(s,user,type,payload)=>command(s,actorFor(user),type,payload);
const doc={id:'PROOF',kind:'account',text:'모의 명의·수취계좌 확인 자료'};
function pending(s,special=true){
  const {caseId}=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[doc],...(special?{exception:{kind:'policy',reason:'모의 특별승인 검토'}}:{})});
  act(s,'reviewer','review',{caseId,docIds:[doc.id],confirmPaymentIds:['S-BOUNDARY'],reason:'모의 계좌·명의 확인'});
  act(s,'reviewer','submit',{caseId});return caseId;
}
test('BPMN 레인 분리와 모든 연결·생성 문맥의 일치',()=>{
  assert.deepEqual(extractWorkflow(readFileSync(new URL('../../작업/W07_개선.bpmn',import.meta.url),'utf8')),workflowModel);
  assert.equal(workflowModel.nodes.find(n=>n.id==='W07I_Delegated').lane,'영업지원팀장(전결)');
  assert.equal(workflowModel.nodes.find(n=>n.id==='W07I_Receive').lane,'일반 영업지원 직원');
  assert.equal(workflowModel.flows.length,33);
});
test('NIM 권고는 전체 BPMN 문맥으로 생성하고 확정 사실은 서버 상태를 사용',async()=>{
  const s=initialState(source,'boundary'),caseId=pending(s),{context}=guidanceContext(s,actorFor('finance'),{moduleId:'approval',caseId});
  const answer=await callGuidance(context,{apiKey:'test-only',fetcher:async(url,options)=>{
    const body=JSON.parse(options.body),sent=JSON.parse(body.messages[1].content);
    assert.equal(sent.process.flows.length,33);assert.equal(sent.module.node,'W07I_FinanceVote');
    assert(!body.messages[1].content.includes('accountKey'));
    return {ok:true,status:200,json:async()=>({id:'mock-transport',choices:[{message:{content:JSON.stringify({summary:'양쪽 승인이 완료되었습니다.',nextStep:'곧 지급하세요.',recommendations:[{actionId:'approve',reason:'제출된 근거와 담당 지급 조건을 검토한 뒤 승인 여부를 결정하세요.',refs:['R-APPROVAL']}],checks:[]})}}]})};
  }});
  assert.match(answer.summary,/재무 임원: 대기/);
  assert.match(answer.nextStep,/필수 승인 모두 완료/);
  assert.equal(answer.workflowState.nextStageId,'W07I_Pay');
});
test('병렬 승인·역할 권한·저장 전 입력·실행 조건과 안내 버전 일치',()=>{
  const s=initialState(source,'boundary'),caseId=pending(s);
  const input={moduleId:'approval',caseId,draft:{decision:'approve',reason:'비밀번호=숨김'}};
  const before=guidanceContext(s,actorFor('finance'),input);
  assert.equal(before.context.draft.saved,false);
  assert(!JSON.stringify(before).includes('숨김'));
  assert.equal(before.context.process.flows.length,33);
  const raw={workflowState:before.context.outputContract.workflowState,summary:before.context.outputContract.statusText,nextStep:'자금팀 지급 준비',checks:[],recommendations:[{actionId:'approve',reason:'현재 버전의 필수 결재입니다.',refs:['R-APPROVAL']}]};
  assert.equal(validateGuidance(raw,before.context).recommendations[0].label,'승인');
  assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],actionId:'pay'}]},before.context),{code:'AI_SCOPE'});
  assert.throws(()=>validateGuidance({...raw,workflowState:{currentStageId:'W07I_Finish',nextStageId:null}},before.context),{code:'AI_STATE'});
  assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],reason:'모든 결재가 승인된 상태입니다.'}]},before.context),{code:'AI_STATE'});
  assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],reason:'재무 임원에게 승인 요청을 진행하세요.'}]},before.context),{code:'AI_STATE'});
  assert.equal(before.context.progressFacts.actorApproval.assignedToCurrentUser,true);
  assert.equal(before.context.progressFacts.accountingReviewComplete,true);
  assert.match(before.context.progressFacts.interpretation,/대조가 완료되어/);
  assert.throws(()=>validateGuidance({...raw,checks:['회계 대조가 완료되지 않았습니다.']},before.context),{code:'AI_STATE'});
  assert.throws(()=>guidanceContext(s,actorFor('intake'),input),{code:'FORBIDDEN'});
  act(s,'executive','decide',{caseId,version:1,decision:'approve',reason:'근거 확인'});
  const after=guidanceContext(s,actorFor('finance'),input);
  assert.notEqual(after.key,before.key);
  const flow=publicState(s,actorFor('finance')).cases[0].workflow;
  assert.equal(flow.current.parallel[0].status,'승인');assert.equal(flow.current.parallel[1].status,'대기');
  assert.equal(flow.next.id,'W07I_Pay');assert.equal(flow.current.mine,true);
  const forbidden=guidanceContext(s,actorFor('treasury'),{moduleId:'pay',caseId});
  assert.equal(forbidden.context.module.actions.length,0);
  assert.equal(forbidden.context.module.blockedActions[0].label,'현재 승인 버전으로 지급 지시');
  act(s,'finance','decide',{caseId,version:1,decision:'approve',reason:'독립 근거 확인'});
  const approved=publicState(s,actorFor('treasury')).cases[0].workflow;
  assert.equal(approved.history.at(-1).result,'양쪽 승인 완료');
  assert.equal(approved.history.at(-1).parallel.length,2);
});
test('가로 흐름의 보완·재검토·대사·종료와 시간순 이력',()=>{
  const s=initialState(source,'boundary'),caseId=pending(s,false);
  act(s,'sales','decide',{caseId,version:1,decision:'approve',reason:'명의 확인'});
  const {instruction}=act(s,'treasury','pay',{caseId,version:1,paymentId:'S-BOUNDARY'});
  assert.equal(publicState(s,actorFor('treasury')).cases[0].workflow.current.title,'은행 회신 등록');
  act(s,'treasury','bank',{instructionId:instruction.id,receiptId:'B',date:instruction.date,amount:instruction.amount,outcome:'success'});
  assert.equal(publicState(s,actorFor('reviewer')).cases[0].workflow.current.id,'W07I_Reconcile');
  act(s,'reviewer','reconcile',{instructionId:instruction.id,voucherId:'V',amount:instruction.amount});
  const flow=publicState(s,actorFor('reviewer')).cases[0].workflow;
  assert(flow.current.terminal);assert.equal(flow.next,null);assert.equal(flow.history[0].title,'요청 접수');
  assert.equal(flow.history.at(-1).result,'대사 일치');
  const completed=guidanceContext(s,actorFor('reviewer'),{moduleId:'result',caseId}).context;
  assert.throws(()=>validateGuidance({workflowState:completed.outputContract.workflowState,summary:'처리 완료',nextStep:'지급 전 확인으로 이동합니다.',recommendations:[],checks:[]},completed),{code:'AI_STATE'});
  const t=initialState(source,'boundary'),changed=pending(t,false);
  act(t,'intake','change',{caseId:changed,paymentId:'S-BOUNDARY',account:'SIM-NEW',owner:'검증상사',docs:[]});
  const waiting=publicState(t,actorFor('intake')).cases[0].workflow;
  assert.equal(waiting.current.id,'W07I_Supplement');assert.equal(waiting.next.id,'W07I_Review');
});
test('차이 확정 후에는 최신 전표·확정 실적을 문맥에 제공하고 과거 금액 안내를 거부',()=>{
  const s=initialState(source,'boundary'),caseId=pending(s,false);
  act(s,'sales','decide',{caseId,version:1,decision:'approve',reason:'명의 확인'});
  const {instruction}=act(s,'treasury','pay',{caseId,version:1,paymentId:'S-BOUNDARY'});
  act(s,'treasury','bank',{instructionId:instruction.id,receiptId:'B',date:instruction.date,amount:instruction.amount+1,outcome:'success'});
  act(s,'reviewer','reconcile',{instructionId:instruction.id,voucherId:'OLD',amount:instruction.amount});
  act(s,'reviewer','reconcile',{instructionId:instruction.id,voucherId:'FINAL',amount:instruction.amount+1});
  act(s,'reviewer','confirmActual',{instructionId:instruction.id,amount:instruction.amount+1,date:instruction.date,docIds:[doc.id],reason:'은행·전표 최종 대조'});
  const {context}=guidanceContext(s,actorFor('reviewer'),{moduleId:'result',caseId});
  const facts=context.progressFacts.accountingFacts[0];
  assert.equal(facts.currentVoucher.id,'FINAL');assert.equal(facts.confirmedActual.amount,2000001);assert.equal(facts.unresolved,false);
  const raw={summary:context.outputContract.statusText,nextStep:context.outputContract.nextText,workflowState:context.outputContract.workflowState,
    recommendations:[{actionId:'open',reason:'최종 처리 이력을 확인하세요.',refs:['CURRENT']}],checks:[]};
  assert.equal(validateGuidance(raw,context).recommendations.length,1);
  for(const checks of [['전표(2,000,000원)의 1원 차이를 확인하세요.'],['전표 2000000원과 회신 차이 확인']]){
    assert.throws(()=>validateGuidance({...raw,checks},context),{code:'AI_STATE'});
  }
});
test('같은 요청 안의 회신·대사 작업은 선택한 지급 건과 담당자에 맞는 흐름을 제공',()=>{
  const s=initialState(source,'demo'),ids=['RB-00054','RB-00120'];
  const caseId=act(s,'intake','intake',{paymentIds:ids,docs:[doc]}).caseId;
  act(s,'reviewer','review',{caseId,docIds:[doc.id],confirmPaymentIds:ids,reason:'모의 증빙 확인'});
  act(s,'reviewer','submit',{caseId});act(s,'executive','decide',{caseId,version:1,decision:'approve',reason:'근거 확인'});
  const instructions=ids.map(paymentId=>act(s,'treasury','pay',{caseId,version:1,paymentId}).instruction);
  act(s,'treasury','bank',{instructionId:instructions[0].id,receiptId:'MULTI',date:instructions[0].date,amount:instructions[0].amount,outcome:'success'});
  for(const [actor,kind,title] of [['reviewer','reconcile','은행 회신·전표 대사'],['treasury','bank','은행 회신 등록']]){
    const state=publicState(s,actorFor(actor)),item=state.workItems.find(w=>w.kind===kind);
    const context=guidanceContext(s,actorFor(actor),{moduleId:kind,caseId,workItemId:item.id,paymentId:item.paymentId}).context;
    assert.equal(context.request.workflow.current.title,title);
    assert.equal(context.request.workflow.current.paymentId,item.paymentId);
    assert.equal(context.request.workflow.current.mine,true);
  }
});
test('안내 API는 인증·공간·역할·입력 형식과 화면 상태 식별값을 검사',async()=>{
  const store=await openStore({local:'memory'}),password='showcase-test-only';
  const hashes=Object.fromEntries([...users.map(u=>u.id),...businessRoles.map(r=>`role:${r.id}`)].map(id=>[id,passwordHash(password)]));
  let calls=0;
  const app=await startServer({store,hashes,port:0,worker:false,secure:false,guidanceOptions:{call:async()=>{calls++;return {summary:'업무 선택',nextStep:'요청 접수',recommendations:[],checks:[]};}}});
  const base=`http://127.0.0.1:${app.port}`;let cookie='';
  const post=async(path,body,expected)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(body)});assert.equal(r.status,expected);return {r,body:await r.json()};};
  try{
    await post('/api/guidance',{moduleId:'inbox'},401);
    const {r}=await post('/api/login',{roleId:'sales',member:'intake',password},200);
    cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    await post('/api/guidance?workspace=demo',{moduleId:'inbox'},403);
    await post('/api/guidance',{moduleId:'approval',caseId:'inaccessible'},403);
    await post('/api/guidance',null,400);
    const stale=await post('/api/guidance',{moduleId:'inbox',stateEventId:'outdated'},200);
    assert.equal(stale.body.status,'stale');assert.equal(calls,0);
    const ready=await post('/api/guidance',{moduleId:'inbox'},200);assert.equal(ready.body.status,'ready');
    const cached=await post('/api/guidance',{moduleId:'inbox'},200);assert.equal(cached.body.cached,true);assert.equal(calls,1);
  }finally{await app.close();}
});
test('안내 캐시·동시 요청·공간 격리·실패 대체·한도와 오래된 응답',async()=>{
  const store=await openStore({local:'memory'});
  try{
    await store.create('qa-guidance','boundary',{validation:true});
    let caseId;await store.tx('qa-guidance',s=>{caseId=pending(s);s.publicDemo={expiresAt:new Date(Date.now()+3600000).toISOString(),aiUsed:0,aiLimit:3};});
    let count=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    const call=async()=>{count++;await gate;return {summary:'근거 확인',nextStep:'지급',recommendations:[],checks:[]};};
    const guide=createGuidanceService(store,{call,spaceLimit:2});
    const input={moduleId:'approval',caseId},actor=actorFor('finance');
    const a=guide('qa-guidance',actor,input),b=guide('qa-guidance',actor,input);
    // Wait for the independent database claim without assuming Promise scheduling order.
    while(!count)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(count,1);
    const anotherProcess=createGuidanceService(store,{call,spaceLimit:2});
    assert.equal((await anotherProcess('qa-guidance',actor,input)).status,'pending');
    assert.equal(count,1);release();
    const results=await Promise.all([a,b]);assert(results.every(r=>r.status==='ready'));
    assert.equal((await guide('qa-guidance',actor,input)).cached,true);
    const saved=await store.read('qa-guidance');assert.equal(saved.publicDemo.guidanceUsed,1);assert.equal(saved.publicDemo.aiUsed,0);
    const failed=createGuidanceService(store,{call:async()=>{throw Error('timeout');},spaceLimit:2});
    assert.equal((await failed('qa-guidance',actor,{...input,draft:{decision:'reject'}})).status,'fallback');
    const limited=await guide('qa-guidance',actor,{...input,draft:{decision:'supplement'}});assert.equal(limited.status,'fallback');assert.match(limited.message,/한도/);
    await store.create('qa-daily','boundary',{validation:true});
    await store.tx('qa-daily',s=>{s.publicDemo={expiresAt:new Date(Date.now()+3600000).toISOString(),aiUsed:0,aiLimit:3};});
    const daily=createGuidanceService(store,{call,dailyLimit:2});
    const dayLimit=await daily('qa-daily',actorFor('intake'),{moduleId:'inbox'});
    assert.equal(dayLimit.status,'fallback');assert.match(dayLimit.message,/일일 한도/);
    assert.equal((await store.read('qa-daily')).publicDemo.guidanceUsed,undefined);
    await store.create('qa-stale','boundary',{validation:true});let second;await store.tx('qa-stale',s=>{second=pending(s);});
    const stale=createGuidanceService(store,{call:async()=>{await store.tx('qa-stale',s=>act(s,'executive','decide',{caseId:second,version:1,decision:'approve',reason:'독립 승인'}));return {};}});
    assert.equal((await stale('qa-stale',actor,{...input,caseId:second})).status,'stale');
  }finally{await store.close();}
});
