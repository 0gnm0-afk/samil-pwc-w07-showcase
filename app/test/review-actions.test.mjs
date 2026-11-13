import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {source,openStore} from '../store.mjs';
import {initialState,command,actorFor,publicState} from '../domain.mjs';
import {previewIntake} from '../batch-intake.mjs';
import {processOne,promptFor,validateDecision} from '../ai.mjs';
import {approvalFormHTML,reconciliationFormHTML} from '../public/review-ui.js';
import {settlementDifferences,proceedEvidenceGaps} from '../review-summary.mjs';
const act=(s,u,t,p)=>command(s,actorFor(u),t,p);
test('대사 차이는 실제 비교값으로 설명하고 입력한 전표는 접어 두며 근거 이름으로 선택한다',()=>{
 const i={id:'I',paymentId:'P',amount:100,date:'2026-07-10',accountKey:'one',accountLabel:'은행 ****1111',receiptId:'R',reconciliation:'difference',vouchers:[{id:'V',amount:101}]};
 const r={id:'R',amount:101,date:'2026-08-10',accountKey:'two',accountLabel:'은행 ****1111'};
 i.differences=settlementDifferences({receipts:{R:r}},i);assert.deepEqual(i.differences.map(d=>d.code),['amount','account','month']);assert(!JSON.stringify(i.differences).includes('accountKey'));
 const html=reconciliationFormHTML(i,r,[{id:'PRIVATE-DOC-ID',title:'이번 지급의 원본 내역',kind:'source',paymentIds:['P']}],true);
 assert.match(html,/<details class="supporting-form"><summary>전표 금액을 수정해야 하는 경우<\/summary><form id="reconcile"/);assert.match(html,/value="PRIVATE-DOC-ID">이번 지급의 원본 내역<\/option>/);assert(!html.includes('reasonChoice'));assert.match(html,/확인한 지급 결과 기록/);
 assert.deepEqual(settlementDifferences({receipts:{R:{...r,amount:100,date:'2026-07-15',accountKey:'one'}}},{...i,vouchers:[{id:'V',amount:100}]}),[]);
});
function setup(){const s=initialState(source);act(s,'intake','batchIntake',{...previewIntake(s,actorFor('intake'),{paymentIds:Object.values(s.plans).filter(p=>p.status==='planned').map(p=>p.id),plannedMonth:'2026-07'}),requestId:randomUUID()});return s;}
const request=(c,action,extra={})=>({caseId:c.id,revision:c.revision,requestId:randomUUID(),action,...extra});
function decision(job,action='request_review',unknowns=['입금계좌와 정산계좌가 다른 이유를 확인했습니까?']){
 const p=promptFor(job);return validateDecision({caseId:job.caseId,inputRevision:job.revision,action,unknowns,scope:job.basis.members,reason:'원본 두 표의 계좌가 서로 다릅니다. 입금과 지급의 목적 및 차이가 발생한 사유를 확인해야 합니다.',facts:p.citationChoices.map(q=>({ref:q.ref,text:'현재 원본에서 확인한 항목'}))},job);
}
test('정상 건 한 번의 결재 요청·임원 승인·지급·대사, AI 0회와 권한·재시도 보존',()=>{
 const s=initialState(source);act(s,'intake','registerRequests',{rows:[{id:'TASK041-NORMAL',agencyId:'D-001',amount:2100000,period:'2026-07'}]});
 act(s,'intake','batchIntake',{...previewIntake(s,actorFor('intake'),{paymentIds:Object.values(s.plans).filter(p=>p.status==='planned').map(p=>p.id),plannedMonth:'2026-07'}),requestId:randomUUID()});
 const c=Object.values(s.cases).find(c=>c.canSubmit&&c.currentBasis.required[0].userId==='executive');assert(c);
 const p=request(c,'submit'),before=JSON.stringify(s);assert.throws(()=>act(s,'intake','reviewAction',p),{code:'FORBIDDEN'});assert.equal(JSON.stringify(s),before);
 act(s,'reviewer','reviewAction',p);assert.equal(act(s,'reviewer','reviewAction',p).duplicate,true);assert.equal(s.cases[c.id].approvals.length,1);
 assert(!Object.values(s.jobs).some(j=>j.caseId===c.id));act(s,'executive','decide',{caseId:c.id,version:1,decision:'approve',reason:'사업상 지급 근거 확인'});
 for(const paymentId of c.paymentIds){const i=act(s,'treasury','pay',{caseId:c.id,version:1,paymentId,date:'2026-07-10'}).instruction;act(s,'treasury','bank',{instructionId:i.id,receiptId:randomUUID(),outcome:'success',date:i.date,amount:i.amount});act(s,'reviewer','reconcile',{instructionId:i.id,voucherId:randomUUID(),amount:i.amount});}
 assert.equal(s.cases[c.id].status,'completed');assert.equal(Object.values(s.cases[c.id].confirmations).every(v=>v.actor==='rules'),true);
});
test('중복 계좌 차이를 한 쟁점으로 묶고 AI 확인 질문은 사람의 근거 기록 후 한 번에 결재 요청',()=>{
 const s=setup(),c=Object.values(s.cases).find(c=>c.paymentIds.includes('RB-00120')),job=Object.values(s.jobs).find(j=>j.caseId===c.id);
 job.decision=decision(job);job.status='applied';
 const r=publicState(s,actorFor('reviewer')).cases.find(x=>x.id===c.id).reviewSummary;assert.equal(r.issues.length,1);assert.equal(r.issues[0].paymentIds.length,3);assert.equal(r.issues[0].docIds.length,2);assert.equal(r.canAccept,false);
 assert.throws(()=>act(s,'reviewer','reviewAction',request(c,'accept',{jobId:job.id})),{code:'AI_NOT_READY'});
 assert.throws(()=>act(s,'reviewer','reviewAction',request(c,'confirm',{jobId:job.id,reason:''})),{code:'INPUT'});
 act(s,'reviewer','reviewAction',request(c,'confirm',{jobId:job.id,reason:'모의 확인: 회수계좌는 채권 수금용이고 장려금은 등록 정산계좌로 지급함을 거래처 담당자에게 확인했습니다.'}));
 assert.equal(s.cases[c.id].needsResubmit,false);assert.equal(s.cases[c.id].approvals.length,1);assert.equal(s.cases[c.id].reviewRecord.jobId,job.id);assert.equal(Object.values(s.jobs).filter(j=>j.caseId===c.id).length,1);
});
test('AI 진행 권고는 검증된 근거 수용 후에만 상신하며 미확인 사항·필수값 누락은 우회 불가',()=>{
 const s=setup(),c=Object.values(s.cases).find(c=>c.paymentIds.includes('RB-00120')),job=Object.values(s.jobs).find(j=>j.caseId===c.id);
 assert.throws(()=>decision(job,'recommend_proceed',['추가 사실 확인 필요']),{code:'AI_ACTION'});
 assert.throws(()=>decision(job,'recommend_proceed',[]),{code:'AI_ACTION'});
 assert.equal(promptFor(job).missingProceedEvidence.length,1);
 // Previously stored, schema-valid hallucinations must also lose the accept action.
 job.decision={...decision(job),action:'recommend_proceed',unknowns:[],reason:'입금계좌와 등록계좌가 일치합니다.'};job.status='applied';
 const blockedSummary=publicState(s,actorFor('reviewer')).cases.find(x=>x.id===c.id).reviewSummary;
 assert.equal(blockedSummary.canAccept,false);assert.equal(blockedSummary.canRetry,true);assert.equal(blockedSummary.opinion,null);assert.match(blockedSummary.failureReason,/보완 근거가 없습니다/);
 assert.throws(()=>act(s,'reviewer','reviewAction',request(c,'accept',{jobId:job.id})),{code:'AI_NOT_READY'});
 act(s,'reviewer','reviewAction',request(c,'supplement',{reason:'입금계좌와 정산계좌가 다른 사유를 회신해 주세요.'}));
 const replyTask=Object.values(s.tasks).find(t=>t.caseId===c.id&&t.owner==='intake'&&t.status==='open');
 act(s,'intake','documents',{caseId:c.id,taskId:replyTask.id,docs:[{id:'REPLY-ACCEPT',kind:'supplement',text:'모의 회신: 채권 수금은 공동 운영계좌로 하고 장려금은 각 거래처 등록 정산계좌로 수취합니다.'}]});
 const revised=s.cases[c.id],newJob=Object.values(s.jobs).find(j=>j.caseId===c.id&&j.revision===revised.revision);
 newJob.decision=decision(newJob,'recommend_proceed',[]);newJob.status='applied';
 const p=request(revised,'accept',{jobId:newJob.id});act(s,'reviewer','reviewAction',p);assert.equal(s.cases[c.id].version,1);assert.equal(act(s,'reviewer','reviewAction',p).duplicate,true);
 const other=setup(),blocked=Object.values(other.cases).find(c=>c.canSubmit);other.plans[blocked.paymentIds[0]].accountKey=null;
 const old=JSON.stringify(other);assert.throws(()=>act(other,'reviewer','reviewAction',request(blocked,'confirm',{reason:'계좌 없이 임의로 확인하려는 시도입니다.'})),{code:'REVIEW_BLOCKED'});assert.equal(JSON.stringify(other),old);
});

test('계좌 차이 진행 권고는 해당 지급의 최신 담당자 회신을 인용해야 한다',()=>{
 const s=setup(),c=Object.values(s.cases).find(c=>c.paymentIds.includes('RB-00120')),job=Object.values(s.jobs).find(j=>j.caseId===c.id);
 const reply={id:'EXPLANATION',kind:'supplement',by:'intake',revision:1,paymentIds:c.paymentIds,text:'수금용 계좌와 정산용 계좌를 별도 운영한다는 모의 확인 회신'};
 const docs=[...job.docs,reply],facts=[{docId:reply.id}];
 assert.equal(proceedEvidenceGaps(job.progress.evidenceAssessment,docs,facts).length,0);
 for(const altered of [{...reply,paymentIds:[c.paymentIds[0]]},{...reply,revision:0},{...reply,by:'nim'},{...reply,sourceRecord:true}])assert.equal(proceedEvidenceGaps(job.progress.evidenceAssessment,[...job.docs,altered],facts).length,1);
 assert.equal(proceedEvidenceGaps(job.progress.evidenceAssessment,docs,[]).length,1);
});
test('통합 처리 도중 상신 실패는 확인·작업·승인 변경 전체를 되돌리며 오래된 요청을 거부',()=>{
 const s=setup(),c=Object.values(s.cases).find(c=>c.paymentIds.includes('RB-00120')),job=Object.values(s.jobs).find(j=>j.caseId===c.id);job.status='failed';
 const p=request(c,'confirm',{jobId:job.id,reason:'계좌 차이의 근거를 확인한 것으로 기록합니다.'});
 c.holds.unresolvable={key:'unresolvable',owner:'intake',reason:'영업직원의 회신 필요'};const before=JSON.stringify(s);
 assert.throws(()=>act(s,'reviewer','reviewAction',p),{code:'SUBMIT_BLOCKED'});assert.equal(JSON.stringify(s),before);
 assert.throws(()=>act(s,'reviewer','reviewAction',{...p,revision:-1}),{code:'REVIEW_CHANGED'});
});
test('예외 사전 알림은 두 임원에게 열람 작업이며 회계 상신 뒤 독립 결재로 바뀜',()=>{
 const s=setup(),c=Object.values(s.cases).find(c=>c.canSubmit);
 act(s,'reviewer','flag',{caseId:c.id,reason:'모의 검증: 계약 외 예외 지급의 사업상 근거 확인 필요',policy:true});
 assert(publicState(s,actorFor('reviewer')).cases.find(x=>x.id===c.id).reviewSummary.holds.every(h=>!h.reason.includes('CONCERN-')));
 for(const who of ['executive','finance']){const state=publicState(s,actorFor(who));assert(state.workItems.some(w=>w.caseId===c.id&&w.kind==='notice'));assert(!state.workItems.some(w=>w.caseId===c.id&&w.kind==='approval'));}
 const job=Object.values(s.jobs).find(j=>j.caseId===c.id);job.status='failed';
 act(s,'reviewer','reviewAction',request(s.cases[c.id],'confirm',{jobId:job.id,reason:'예외 지급 요청의 계약 및 사업상 사유를 확인하고 독립된 두 임원에게 결재를 요청합니다.'}));
 for(const who of ['executive','finance'])assert(publicState(s,actorFor(who)).workItems.some(w=>w.caseId===c.id&&w.kind==='approval'));
 assert.match(approvalFormHTML(publicState(s,actorFor('finance')).cases.find(x=>x.id===c.id),actorFor('finance')),/예외 지급 요청의 계약 및 사업상 사유를 확인하고 독립된 두 임원에게 결재를 요청합니다/);
 act(s,'executive','decide',{caseId:c.id,version:1,decision:'approve',reason:'사업상 사유 확인'});assert.equal(s.cases[c.id].canPay,false);
 assert.match(approvalFormHTML(publicState(s,actorFor('finance')).cases.find(x=>x.id===c.id),actorFor('finance')),/승인하면 두 임원의 결재가 모두 완료/);
 act(s,'finance','decide',{caseId:c.id,version:1,decision:'approve',reason:'독립된 지급 조건 확인'});assert.equal(s.cases[c.id].canPay,true);
});
test('보완 회신 저장 뒤 새 자료만으로 AI를 다시 판단하고 화면 조회는 추가 호출하지 않음',async()=>{
 const store=await openStore({url:'',local:'memory'});try{
  await store.create('qa-review-actions');let caseId,taskId;
  await store.tx('qa-review-actions',s=>{Object.assign(s,setup());caseId=Object.values(s.cases).find(c=>c.paymentIds.includes('RB-00120')).id;});
  let calls=0;await processOne(store,'qa-review-actions',{call:async j=>{calls++;return {decision:decision(j,'request_supplement',['계좌 차이의 사업상 사유를 알려주세요.'])};}});
  await store.tx('qa-review-actions',s=>{taskId=Object.values(s.tasks).find(t=>t.caseId===caseId&&t.owner==='intake'&&t.status==='open').id;act(s,'intake','documents',{caseId,taskId,docs:[{id:'REPLY-TEST',kind:'supplement',text:'모의 회신: 수금 전용 계좌와 정산 계좌를 구분해서 사용하며 요청의 장려금은 등록된 정산 계좌로 받습니다.'}]});});
  await processOne(store,'qa-review-actions',{call:async j=>{calls++;return {decision:decision(j,'recommend_proceed',[])};}});
  const s=await store.read('qa-review-actions');for(let i=0;i<3;i++)publicState(s,actorFor('reviewer'));assert.equal(calls,2);assert.equal(publicState(s,actorFor('reviewer')).cases.find(c=>c.id===caseId).reviewSummary.canAccept,true);
 }finally{await store.close();}
});
