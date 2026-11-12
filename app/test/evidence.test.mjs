import test from 'node:test';
import assert from 'node:assert/strict';
import {source,openStore} from '../store.mjs';
import {initialState,command,actorFor,publicState,previewSchedule,hash} from '../domain.mjs';
import {assessSettlement} from '../evidence.mjs';
import {guidanceContext,createGuidanceService,validateGuidance} from '../guidance.mjs';
import {koreaToday} from '../public/schedule.js';
const act=(s,user,type,p)=>command(s,actorFor(user),type,p);
const proof=(id='PROOF',fields={})=>({id,kind:'account',text:'예금주: 검증상사\n계좌번호: S-ACCOUNT\n작성일: 2026-07-01',fields});
const receive=(s,docs=[proof()])=>act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs}).caseId;
test('필수 원자료 자동 검토는 NIM 0회이며 상신·독립 결재·지급을 대신하지 않는다',async()=>{
 const store=await openStore({local:'memory'});try{await store.create('qa-proof','boundary',{validation:true});let id;await store.tx('qa-proof',s=>{id=receive(s);});
 const s=await store.read('qa-proof'),c=s.cases[id];assert.equal(c.evidenceAssessment.status,'pass');assert.equal(c.confirmations['S-BOUNDARY'].actor,'rules');assert.equal(c.canSubmit,true);assert.equal(c.canPay,false);assert.equal(c.version,0);assert.equal(c.approvals.length,0);assert.equal(Object.keys(s.jobs).length,0);
 let calls=0;const guide=createGuidanceService(store,{call:async()=>{calls++;throw Error('must not call');}});assert.equal((await guide('qa-proof',actorFor('reviewer'),{moduleId:'evidence',caseId:id})).status,'rules');
 for(const user of ['intake','sales','reviewer','executive','finance','treasury'])assert.equal((await guide('qa-proof',actorFor(user),{moduleId:'inbox'})).status,'rules');assert.equal(calls,0);
 assert.throws(()=>act(s,'intake','submit',{caseId:id}),{code:'FORBIDDEN'});act(s,'reviewer','submit',{caseId:id});assert.equal(c.canPay,false);act(s,'sales','decide',{caseId:id,version:1,decision:'approve',reason:'독립 검토'});assert.equal(c.canPay,true);
 const safe=JSON.stringify(publicState(s,actorFor('reviewer')));assert(!safe.includes('S-ACCOUNT'));assert(!safe.includes('"accountKey"'));
 }finally{await store.close();}
});
test('누락·원문/필드 충돌·전체 계좌·대상·작성일 차이는 자동 통과하지 않는다',()=>{
 for(const [doc,status] of [[{id:'M',kind:'account',text:'예금주: 검증상사'},'unknown'],[proof('C',{holder:'다른 명의'}),'conflict'],[proof('A',{requestId:'다른 요청'}),'conflict'],[proof('D',{date:'2999-01-01'}),'conflict']]){
  const s=initialState(source,'boundary'),id=receive(s,[doc]);assert.equal(s.cases[id].evidenceAssessment.payments[0].status,status);assert.equal(s.cases[id].canSubmit,false);assert(Object.values(s.jobs).some(j=>j.revision===s.cases[id].revision));
 }
 const s=initialState(source,'boundary');s.plans['S-BOUNDARY'].accountKey=hash('DIFFERENT-ACCOUNT');const id=receive(s);assert.equal(s.cases[id].evidenceAssessment.payments[0].status,'conflict');assert.throws(()=>act(s,'reviewer','review',{caseId:id,docIds:['PROOF'],confirmPaymentIds:['S-BOUNDARY'],reason:'마스킹 뒷자리만 같음'}),{code:'EVIDENCE_CONFLICT'});
});
test('계좌 변경 후 새 날짜·새 버전 보완을 규칙 대조하고 재상신을 유지한다',()=>{
 const s=initialState(source,'boundary'),id=receive(s);act(s,'reviewer','submit',{caseId:id});act(s,'sales','decide',{caseId:id,version:1,decision:'approve',reason:'확인'});
 act(s,'intake','change',{caseId:id,paymentId:'S-BOUNDARY',account:'NEW-ACCOUNT',owner:'검증상사',docs:[]});assert.equal(s.cases[id].canPay,false);assert.equal(s.cases[id].evidenceAssessment.status,'exception');
 act(s,'intake','documents',{caseId:id,docs:[{id:'NEW',kind:'supplement',text:`예금주: 검증상사\n계좌번호: NEW-ACCOUNT\n작성일: ${koreaToday()}`} ]});
 assert.equal(s.cases[id].confirmations['S-BOUNDARY'].actor,'rules');assert.equal(s.cases[id].needsResubmit,true);assert.equal(s.cases[id].canPay,false);assert(s.cases[id].holds.changed&&!s.cases[id].holds.changed.closedAt);
});
test('CSV 증빙도 동일 파이프라인, 없는 증빙은 생성하지 않는다',()=>{
 const s=initialState(source,'boundary');
 const csv='request_id,agency_id,amount_krw,period_ym,planned_date,evidence_id,evidence_account_holder,evidence_account_no,evidence_date,evidence_amount_krw\nCSV-1,S-001,100,2026-06,2026-07-10,CSV-P,검증상사,S-ACCOUNT,2026-07-01,100\nCSV-2,S-001,200,2026-06,2026-07-10,,,,,';
 act(s,'intake','registerRequests',{csv:{text:csv}});assert.equal(s.plans['CSV-2'].pendingEvidence,undefined);
 const id=act(s,'intake','intake',{paymentIds:['CSV-1'],docs:[]}).caseId;assert.equal(s.cases[id].evidenceAssessment.status,'pass');assert.equal(s.cases[id].docs[0].origin.channel,'csv');
});
test('새 미확인 증빙은 이전 수동 확인을 재사용하지 않으며 상충 계좌 원문은 모두 마스킹한다',()=>{
 const s=initialState(source,'boundary'),id=receive(s,[{id:'OLD',kind:'account',text:'서식 없는 원자료'}]);act(s,'reviewer','review',{caseId:id,docIds:['OLD'],confirmPaymentIds:['S-BOUNDARY'],reason:'담당자 대조'});assert(s.cases[id].canSubmit);
 act(s,'intake','documents',{caseId:id,docs:[{id:'NEW',kind:'account',text:'예금주: 검증상사\n계좌번호: TEXT-ACCOUNT',fields:{account:'FIELD-ACCOUNT'}}]});assert.equal(s.cases[id].canSubmit,false);assert.equal(s.cases[id].confirmations['S-BOUNDARY'],undefined);const text=JSON.stringify(publicState(s,actorFor('reviewer')));assert(!text.includes('TEXT-ACCOUNT'));assert(!text.includes('FIELD-ACCOUNT'));
});
test('설명자료의 보류만 해소하고 지급 근거가 같으면 기존 승인을 유지한다',()=>{
 const s=initialState(source,'boundary'),id=receive(s);act(s,'reviewer','submit',{caseId:id});act(s,'sales','decide',{caseId:id,version:1,decision:'approve',reason:'독립 확인'});
 act(s,'intake','documents',{caseId:id,docs:[{id:'NOTE',kind:'narrative',text:'수취계좌 변경 없는 별도 설명 자료를 확인해 주세요.'}]});assert.equal(s.cases[id].canPay,false);
 act(s,'reviewer','review',{caseId:id,docIds:['NOTE'],resolveKeys:['document:NOTE'],reason:'지급 조건 변경 없는 설명 확인'});assert.equal(s.cases[id].canPay,true);assert.equal(s.cases[id].version,1);assert.equal(s.cases[id].needsResubmit,false);
});
test('전체 권장일은 50건 초과를 원자적으로 저장하며 기존 날짜·기준일·상태 변경을 보호한다',()=>{
 const s=initialState(source,'boundary');for(let n=0;n<65;n++)s.plans['U'+n]={...s.plans['S-BOUNDARY'],id:'U'+n,plannedDate:null};
 const old=s.plans['S-BOUNDARY'].plannedDate,preview=previewSchedule(s,actorFor('intake'),{mode:'all-recommended'});assert.equal(preview.items.length,65);assert.equal(s.plans.U0.plannedDate,null);
 const clone=structuredClone(s);assert.throws(()=>act(clone,'intake','schedule',{items:[{id:'U0',date:'2026-12-01'},{id:'U1',date:'bad'}],unassignedOnly:true}),{code:'DATE'});assert.equal(clone.plans.U0.plannedDate,null);
 assert.throws(()=>act(s,'intake','schedule',{mode:'all-recommended',...preview,asOfDate:'2000-01-01'}),{code:'SCHEDULE_CHANGED'});
 act(s,'intake','schedule',{...preview,mode:'all-recommended'});assert(s.plans.U64.plannedDate);assert.equal(s.plans['S-BOUNDARY'].plannedDate,old);assert.equal(Object.keys(s.cases).length,0);assert.equal(Object.keys(s.jobs).length,0);
 assert.throws(()=>act(s,'intake','schedule',{...preview,mode:'all-recommended'}));
});
test('예외 권고는 실제 선택·문서만 적용 대상으로 반환하며 업무 상태를 바꾸지 않는다',()=>{
 const s=initialState(source,'boundary'),id=receive(s,[{id:'M',kind:'account',text:'예금주: 검증상사'}]),before=JSON.stringify(s);
 const {context}=guidanceContext(s,actorFor('reviewer'),{moduleId:'evidence',caseId:id});assert(context.evidenceAssessment.payments[0].checks.some(c=>c.code==='missing_account'));
 const raw={workflowState:context.outputContract.workflowState,summary:context.outputContract.statusText,nextStep:context.outputContract.nextText,recommendations:[{targetId:'assessment:missing',reason:'계좌와 작성일이 없습니다. 보완 자료를 요청하면 현재 조건을 다시 확인할 수 있습니다.',refs:['DOC:M'],docIds:['M']}],checks:[]};
 const rec=validateGuidance(raw,context).recommendations[0];assert.equal(rec.formId,'flag');assert.equal(rec.interaction,'apply');assert.equal(rec.value,'missing');assert.deepEqual(rec.docIds,['M']);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],docIds:['FAKE']}]},context));
});
test('은행·전표 원자료 금액을 실제 지시/회신과 대조하고 없는 항목을 추정하지 않는다',()=>{
 const s=initialState(source,'boundary'),id=receive(s);act(s,'reviewer','submit',{caseId:id});act(s,'sales','decide',{caseId:id,version:1,decision:'approve',reason:'독립 검토'});const {instruction:i}=act(s,'treasury','pay',{caseId:id,paymentId:'S-BOUNDARY',version:1});
 act(s,'treasury','documents',{caseId:id,docs:[{id:'B',kind:'bank',text:`금액: ${i.amount+1}\n작성일: ${i.date}\n처리결과: success`}]});const a=assessSettlement(s,s.cases[id],i.paymentId,'bank');assert.equal(a.status,'exception');assert.equal(a.fields.amount,i.amount+1);assert.equal(s.receipts.B,undefined);
 assert.throws(()=>act(s,'treasury','bank',{instructionId:i.id,receiptId:'B',amount:i.amount,date:i.date,outcome:'success'}),{code:'SOURCE_MISMATCH'});
 assert.throws(()=>act(s,'treasury','documents',{caseId:id,docs:[proof()]}),{code:'FORBIDDEN'});
});
