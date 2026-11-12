import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendDate,koreaToday} from '../public/schedule.js';
import {initialState,command,actorFor,publicState,previewSchedule} from '../domain.mjs';
import {source,openStore} from '../store.mjs';
import {withNimSlot,checkNimResponse} from '../provider.mjs';
import {processOne} from '../ai.mjs';
import {guidanceContext,createGuidanceService,validateGuidance} from '../guidance.mjs';
const act=(s,user,type,p)=>command(s,actorFor(user),type,p);

test('추천일은 접속 날짜와 무관하게 정산 다음 달 평일·윤년·연말을 처리',()=>{
  assert.equal(koreaToday('2026-11-12T15:00:00Z'),'2026-11-13');
  for(const [period,today,want] of [
    ['2026-06','2026-11-12','2026-07-03'],['2026-06','2026-11-13','2026-07-03'],
    ['2026-11','2026-11-12','2026-12-03'],['2026-12','2026-11-12','2027-01-05'],
    ['2028-02','2028-02-01','2028-03-03'],['2026-02','2026-02-01','2026-03-04']
  ]){const r=recommendDate(period,today);assert.equal(r.date,want);assert.equal(r.source,'rules');assert.match(r.reason,/공휴일/);}
  assert.equal(recommendDate('2026-13').date,null);
});

test('예정일 미리보기는 저장 없이 월별 재그룹·200만원 경계·기존 합산을 계산하고 권한을 검사',()=>{
  const s=initialState(source,'boundary');
  s.plans['S-BOUNDARY'].plannedDate=null;
  s.plans.EXTRA={...s.plans['S-BOUNDARY'],id:'EXTRA',amount:1};
  const actor=actorFor('intake'),before=JSON.stringify(s);
  const same=previewSchedule(s,actor,[{id:'S-BOUNDARY',date:'2026-11-17'},{id:'EXTRA',date:'2026-11-18'}]);
  assert.equal(same.groups.length,1);assert.equal(same.groups[0].total,2000001);assert.equal(same.groups[0].required[0].role,'executive');
  const split=previewSchedule(s,actor,[{id:'S-BOUNDARY',date:'2026-11-17'},{id:'EXTRA',date:'2026-12-03'}]);
  assert.equal(split.groups.length,2);assert(split.groups.every(g=>g.required[0].role==='sales'));
  assert.equal(JSON.stringify(s),before);
  assert.throws(()=>previewSchedule(s,actorFor('sales'),same.items),{code:'FORBIDDEN'});
  assert.throws(()=>previewSchedule(s,actor,[{id:'S-BOUNDARY',date:'2026-02-30'}]),{code:'DATE'});
  assert.throws(()=>act(s,'intake','schedule',{items:same.items,stateEventId:'old'}),{code:'SCHEDULE_CHANGED'});
  act(s,'intake','schedule',{items:split.items,unassignedOnly:true,stateEventId:null});
  const view=publicState(s,actor);assert.equal(view.intakeGroups.length,2);
  assert.equal(view.plans[0].plannedDate,'2026-11-17');assert.equal(view.plans[0].scheduleRecommendation.date,'2026-07-03');
});

test('공통 NIM 속도 예약은 동시 요청·시간 경계·업무 판단 우선순위·공급자 대기를 공유',async()=>{
  const store=await openStore({local:'memory'}),at=1800000000000;
  try{
    const slots=await Promise.all(Array.from({length:45},(_,i)=>store.nimSlot({key:`g${i}`,priority:'guidance',rpm:40,at})));
    assert.equal(slots.filter(s=>s.allowed).length,40);
    const queued=await store.nimSlot({key:'job',priority:'business',rpm:40,at});assert(!queued.allowed);
    assert(!(await store.nimSlot({key:'new-guide',priority:'guidance',rpm:40,at:at+60001})).allowed);
    assert((await store.nimSlot({key:'job',priority:'business',rpm:40,at:at+60001})).allowed);
    assert((await store.nimSlot({key:'new-guide',priority:'guidance',rpm:40,at:at+60001})).allowed);
    await store.nimCooldown(120000,at+60001);
    const delayed=await store.nimSlot({key:'later',priority:'business',rpm:40,at:at+60002});
    assert.equal(Date.parse(delayed.retryAt),at+180001);
    assert.throws(()=>checkNimResponse({ok:false,status:429,headers:new Headers({'Retry-After':'7'})}),e=>e.code==='AI_RATE_LIMIT'&&e.retryAfterMs===7000);
  }finally{await store.close();}
});

test('NIM 429는 안내 자동 대기와 업무 재시도로 이어지고 보완 작업을 중복 생성하지 않음',async()=>{
  const store=await openStore({local:'memory'});
  try{
    await store.create('qa-retry','boundary');let cid;
    await store.tx('qa-retry',s=>{cid=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[{id:'MISSING',kind:'narrative',text:'예금주 확인서가 누락되어 제출이 필요합니다.'}]}).caseId;});
    let calls=0;
    const rateLimited=async()=>{calls++;checkNimResponse({ok:false,status:429,headers:new Headers({'retry-after':'60'})});};
    await processOne(store,'qa-retry',{call:rateLimited});
    let saved=await store.read('qa-retry');const job=Object.values(saved.jobs)[0];
    assert.equal(job.status,'pending');assert(job.retryAt);assert(!Object.values(saved.tasks).some(t=>t.errorCode));
    await processOne(store,'qa-retry',{call:rateLimited});assert.equal(calls,1);
    const guide=createGuidanceService(store,{call:async()=>{throw Error('provider wait must precede transport');}});
    const waiting=await guide('qa-retry',actorFor('reviewer'),{moduleId:'evidence',caseId:cid});assert.equal(waiting.status,'waiting');
    assert.equal((await guide('qa-retry',actorFor('reviewer'),{moduleId:'evidence',caseId:cid})).cached,true);
    await store.query("UPDATE w07_nim_provider SET state='{}'");
    await store.tx('qa-retry',s=>{s.jobs[job.id].retryAt='2000-01-01T00:00:00Z';});
    const ok=async()=>({decision:{action:'request_supplement',owner:'intake',reason:'명의 증빙이 부족합니다. 예금주 확인서를 보완하세요.',facts:[],unknowns:[],beforeAction:['현재 계좌 확인'],howTo:['보완 자료 제출'],effect:'회계 재검토'}});
    await Promise.all([processOne(store,'qa-retry',{call:ok}),processOne(store,'qa-retry',{call:ok})]);
    saved=await store.read('qa-retry');assert.equal(saved.jobs[job.id].status,'applied');
    assert.equal(Object.values(saved.tasks).filter(t=>t.jobId===job.id).length,1);
    assert.equal(saved.cases[cid].canPay,false);
  }finally{await store.close();}
});

test('예정일 미정 모듈은 API에서도 AI를 호출하지 않음',async()=>{
  const store=await openStore({local:'memory'});let calls=0;
  try{
    await store.create('qa-date-only','boundary');await store.tx('qa-date-only',s=>{s.plans['S-BOUNDARY'].plannedDate=null;});
    const actor=actorFor('intake'),s=await store.read('qa-date-only'),group=publicState(s,actor).intakeGroups[0];
    const guide=createGuidanceService(store,{call:async()=>{calls++;return {};}});
    assert.equal((await guide('qa-date-only',actor,{moduleId:'intake',groupId:group.id})).status,'rules');assert.equal(calls,0);
  }finally{await store.close();}
});

test('보완 회신 문맥은 원 요청·증빙 시점·미확인 상태를 연결하고 설명 필드를 강제',()=>{
  const s=initialState(source,'boundary');
  const cid=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[{id:'OLD',kind:'account',text:'모의 이전 계좌 확인서'}]}).caseId;
  act(s,'intake','change',{caseId:cid,paymentId:'S-BOUNDARY',account:'SIM-NEW',owner:'검증상사',docs:[]});
  const task=Object.values(s.tasks).find(t=>t.owner==='intake'&&t.status==='open');
  act(s,'intake','documents',{caseId:cid,taskId:task.id,docs:[{id:'REPLY',kind:'supplement',text:'변경된 수취계좌와 명의에 대한 은행 발급 확인서를 제출합니다.'}]});
  const {context}=guidanceContext(s,actorFor('reviewer'),{moduleId:'evidence',caseId:cid});
  assert.equal(context.request.documents.find(d=>d.id==='OLD').withinCurrentEvidencePeriodFor.length,0);
  const reply=context.request.documents.find(d=>d.id==='REPLY');assert.equal(reply.responseLinks[0].responseTo,task.id);
  assert.equal(context.progressFacts.accountingReviewComplete,false);
  assert(context.explanationContext.actionConsequences.some(a=>a.id==='review'));
  const raw={summary:context.outputContract.statusText,nextStep:context.outputContract.nextText,workflowState:context.outputContract.workflowState,
    recommendations:[{actionId:'review',reason:'변경 후 확인서가 제출되었습니다. 현재 지급 조건과 대조해야 하므로 근거를 확인한 뒤 저장하세요.',beforeAction:['현재 계좌와 제출된 자료의 명의를 비교하세요.'],howTo:['제출 증빙과 확인한 지급 건을 선택하고 검토 저장을 누르세요.'],refs:['DOC:REPLY','CURRENT']}],checks:[]};
  const answer=validateGuidance(raw,context);assert.equal(answer.recommendations[0].source,'ai');assert.equal(answer.recommendations[0].effectSource,'rules');
  const fabricated=validateGuidance({...raw,recommendations:[{...raw.recommendations[0],howTo:['없는 확인 다이얼로그에서 즉시 지급하세요.']}]},context);
  assert(!fabricated.recommendations[0].howTo.join(' ').includes('다이얼로그'));assert.equal(fabricated.recommendations[0].instructionsSource,'rules');
  assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],refs:['DOC:OTHER-CASE']}]},context),{code:'AI_SCOPE'});
});
