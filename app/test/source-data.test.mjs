import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,command,actorFor,publicState,previewSource,previewSchedule,openHolds} from '../domain.mjs';
import {source,openStore} from '../store.mjs';
import {sourceTables} from '../public/source-schema.js';
import {guidanceContext,createGuidanceService,validateGuidance} from '../guidance.mjs';
const act=(s,u,t,p)=>command(s,actorFor(u),t,p);
const schedule=s=>{const p=previewSchedule(s,actorFor('intake'),{items:Object.values(s.plans).filter(p=>p.status==='planned'&&!p.caseId).map(p=>({id:p.id,date:'2026-07-06'}))});act(s,'intake','schedule',{...p,mode:undefined});return p;};
const intake=(s,ids)=>act(s,'intake','intake',{paymentIds:ids,docs:[]}).caseId;
const apply=(s,files,reason='검증용 원본 정정')=>{const input={files},p=previewSource(s,actorFor('intake'),input);assert.deepEqual(p.errors,[]);return act(s,'intake','applySourceRows',{...input,previewHash:p.previewHash,reason});};
const payment=(id,agency='D-001')=>({rebate_id:id,agency_id:agency,period_ym:'2026-07',sales_performance_krw:'1000000',rebate_amount_krw:'10000',approval_status:'미지급',approver:'NONE',payment_date:'NONE'});
const agency={agency_id:'NEW-AGENCY',agency_name:'신규 검증상사',representative_name:'신규 대표',address:'신규 주소',bank_account_no:'DEMO-NEW-ACCOUNT',rebate_eligible:'True',registered_date:'2026-07-01'};

test('원본 세 표만으로 접수·규칙 검토·독립 승인·모의 지급·대사를 완주하며 정상 건의 NIM 호출은 0회',async()=>{
 const store=await openStore({local:'memory'});let calls=0;
 try{await store.create('qa-source-happy');let id,pid;await store.tx('qa-source-happy',s=>{schedule(s);const g=publicState(s,actorFor('intake')).intakeGroups.find(g=>g.sourceReview.status==='pass');pid=g.paymentIds[0];id=intake(s,g.paymentIds);assert.equal(s.cases[id].canSubmit,true);assert.equal(Object.keys(s.jobs).length,0);});
 const guide=createGuidanceService(store,{call:async()=>{calls++;throw Error('정상 건에서는 호출하지 않아야 함');}});
 const r=await guide('qa-source-happy',actorFor('reviewer'),{caseId:id,moduleId:'submit'});assert.equal(r.status,'rules');assert.equal(r.review.source,'rules');assert(r.basicGuidance.actions.length);
 await store.tx('qa-source-happy',s=>{act(s,'reviewer','submit',{caseId:id});const c=s.cases[id];assert.equal(c.canPay,false);for(const a of c.approvals.filter(a=>a.version===c.version))act(s,a.userId,'decide',{caseId:id,version:c.version,decision:'approve',reason:'원본 근거 확인'});const i=act(s,'treasury','pay',{caseId:id,version:c.version,paymentId:pid}).instruction;act(s,'treasury','bank',{instructionId:i.id,receiptId:'SOURCE-BANK',date:i.date,amount:i.amount,outcome:'success'});act(s,'reviewer','reconcile',{instructionId:i.id,voucherId:'SOURCE-VOUCHER',amount:i.amount});assert.equal(c.status,'completed');assert.equal(c.docs.filter(d=>d.source==='source_table').length>0,true);});assert.equal(calls,0);
 }finally{await store.close();}
});

test('세 표 CSV·직접 입력은 신규·동일·정정 비교와 출처 이력을 보존하고 전체 검증·역할·오래된 미리보기를 검사',()=>{
 const s=initialState(source),rows={agencies:agency,payments:payment('NEW-ROW','NEW-AGENCY'),collections:{deposit_id:'NEW-DEPOSIT',agency_id:'NEW-AGENCY',deposit_date:'2026-07-02',amount_krw:'100',bank_account_no:'DEMO-NEW-ACCOUNT',matched_ar_id:'AR-NEW'}};
 const files=Object.entries(rows).map(([table,row])=>({table,text:sourceTables[table].fields.map(([key])=>key).join('|')+'\n'+sourceTables[table].fields.map(([key])=>row[key]).join('|')}));
 const p=previewSource(s,actorFor('intake'),{files});assert.equal(p.counts.new,3);assert(!JSON.stringify(p).includes('DEMO-NEW-ACCOUNT'));assert.throws(()=>previewSource(s,actorFor('sales'),{files}),{code:'FORBIDDEN'});
 act(s,'intake','applySourceRows',{files,previewHash:p.previewHash});assert.equal(s.sourceHistory.length,3);assert.equal(s.plans['NEW-ROW'].plannedDate,null);assert.equal(previewSource(s,actorFor('intake'),{files}).counts.same,3);
 const next={files:[{table:'payments',rows:[{...rows.payments,rebate_amount_krw:'20000'}]}]},before=JSON.stringify(s),edit=previewSource(s,actorFor('intake'),next);
 assert.throws(()=>act(s,'intake','applySourceRows',{...next,previewHash:edit.previewHash}),{code:'INPUT'});assert.equal(JSON.stringify(s),before);
 apply(s,next.files);assert.equal(s.plans['NEW-ROW'].amount,20000);assert.equal(s.sourceHistory.at(-1).before.rebate_amount_krw,'10000');
 assert.throws(()=>act(s,'intake','applySourceRows',{...next,previewHash:edit.previewHash,reason:'정정'}),{code:'SOURCE_CHANGED'});
 const bad={files:[{table:'payments',rows:[payment('VALID'),payment('INVALID','UNKNOWN')]}]},invalid=previewSource(s,actorFor('intake'),bad),snapshot=JSON.stringify(s);assert(invalid.errors.length);assert.throws(()=>act(s,'intake','applySourceRows',{...bad,previewHash:invalid.previewHash}),{code:'SOURCE_INPUT'});assert.equal(JSON.stringify(s),snapshot);
 const duplicate=previewSource(s,actorFor('intake'),{files:[{table:'payments',rows:[payment('DUP'),payment('DUP')]}]});assert(duplicate.errors.length);
});

test('회수 이력 부재는 통과, 다른 입금계좌는 지급 오류로 단정하지 않고 원본 행과 실제 미확인 값을 NIM 문맥에 제공',()=>{
 const s=initialState(source);schedule(s);const groups=publicState(s,actorFor('intake')).intakeGroups;
 const g=groups.find(g=>g.sourceReview.payments.some(p=>p.checks.some(k=>k.code==='collection_account')));assert(g);
 const id=intake(s,g.paymentIds),c=s.cases[id];assert.equal(c.canSubmit,false);assert(Object.values(s.jobs).some(j=>j.mode==='source'));
 const {context}=guidanceContext(s,actorFor('reviewer'),{caseId:id,moduleId:'evidence'});assert.equal(context.reviewMode,'source-1');assert(context.request.documents.some(d=>d.table==='collections'&&d.sourceFields.accountLabel));assert(!JSON.stringify(context).includes('"accountKey":'));
 const noHistory=groups.find(g=>g.sourceReview.status==='pass'&&g.sourceReview.payments.some(p=>p.checks.some(k=>k.code==='collection_info')));assert(noHistory);
 const normal=intake(s,noHistory.paymentIds);assert.equal(s.cases[normal].canSubmit,true);
});

test('원본 수취계좌 정정은 기존 승인 무효·특별승인·지급보류, 집행한 원본 지급 행의 정정은 거절',()=>{
 const s=initialState(source);schedule(s);const g=publicState(s,actorFor('intake')).intakeGroups.find(g=>g.sourceReview.status==='pass'),id=intake(s,g.paymentIds),c=s.cases[id];
 act(s,'reviewer','submit',{caseId:id});for(const a of c.approvals)act(s,a.userId,'decide',{caseId:id,version:c.version,decision:'approve',reason:'현재 근거 승인'});assert(c.canPay);
 const original=s.source.agencies.find(a=>a.agency_id===s.plans[c.paymentIds[0]].agencyId),row=Object.fromEntries(sourceTables.agencies.fields.filter(([key])=>key!=='bank_account_no').map(([key])=>[key,original[key]]));
 apply(s,[{table:'agencies',rows:[{...row,bank_account_no:'DEMO-CHANGED-ACCOUNT'}]}]);const updated=s.cases[id];assert.equal(updated.canPay,false);assert(updated.needsResubmit);assert.deepEqual(updated.currentBasis.required.map(a=>a.role),['executive','finance']);assert(openHolds(updated).some(h=>h.key==='changed'));assert(updated.approvals.length);assert(s.sourceHistory.length);
 assert.throws(()=>act(s,'intake','applySourceRows',{files:[],previewHash:'bad'}),{code:'SOURCE_INPUT'});
 const paid=s.source.payments.find(p=>p.approval_status==='승인');const historic=Object.fromEntries(sourceTables.payments.fields.map(([key])=>[key,paid[key]]));
 const pv=previewSource(s,actorFor('intake'),{files:[{table:'payments',rows:[{...historic,rebate_amount_krw:'999'}]}]});assert(pv.errors.length);
});

test('빈 등록계좌는 수동 확인으로 우회하지 못하고 원본을 정정해야 한다',()=>{
 const s=initialState(source);apply(s,[{table:'agencies',rows:[{...agency,bank_account_no:'NONE'}]},{table:'payments',rows:[payment('NO-ACCOUNT','NEW-AGENCY')]}]);
 act(s,'intake','schedule',{items:[{id:'NO-ACCOUNT',date:'2026-08-05'}]});const id=intake(s,['NO-ACCOUNT']);
 assert.equal(s.cases[id].canSubmit,false);
 assert.throws(()=>act(s,'reviewer','review',{caseId:id,confirmPaymentIds:['NO-ACCOUNT'],docIds:s.cases[id].evidenceAssessment.records.map(d=>d.id),reason:'계좌 없이 확인 시도'}),{code:'ACCOUNT_REQUIRED'});
});

test('정정 이후 NIM에는 최신 원본만 제공하며 마스킹 오인과 사용 방법 혼입을 거부한다',()=>{
 const s=initialState(source);apply(s,[{table:'agencies',rows:[{...agency,bank_account_no:'NONE'}]},{table:'payments',rows:[payment('CORRECTED','NEW-AGENCY')]}]);
 act(s,'intake','schedule',{items:[{id:'CORRECTED',date:'2026-08-05'}]});const id=intake(s,['CORRECTED']);
 const old=s.cases[id].evidenceAssessment.records.find(d=>d.table==='agencies').id;
 apply(s,[{table:'agencies',rows:[agency]}]);
 const {context}=guidanceContext(s,actorFor('reviewer'),{caseId:id,moduleId:'holds'});
 assert.equal(context.evidenceAssessment.status,'pass');assert(!context.request.documents.some(d=>d.id===old));
 const raw={summary:context.outputContract.statusText,nextStep:context.outputContract.nextText,workflowState:context.outputContract.workflowState,recommendations:[{actionId:'review',reason:'수취계좌가 현재 등록계좌와 일치합니다. 원본 보완에 따른 보류 해소 검토를 권고합니다.',refs:['CURRENT']}],checks:[]};
 assert.equal(validateGuidance(raw,context).recommendations.length,1);
 for(const [reason,code] of [['계좌가 마스킹되어 확인이 필요합니다.','AI_STATE'],['자료는 통과했고 검토 저장하면 재상신 요건을 검사합니다.','AI_LANGUAGE']])assert.throws(()=>validateGuidance({...raw,recommendations:[{...raw.recommendations[0],reason}]},context),{code});
});
