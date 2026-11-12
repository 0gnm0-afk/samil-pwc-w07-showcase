import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {openStore} from '../store.mjs';
import {command,actorFor,previewSource,publicState} from '../domain.mjs';
import {processOne} from '../ai.mjs';
import {createGuidanceService,callGuidance} from '../guidance.mjs';
const store=await openStore({url:'',local:'memory'}),ws='qa-source-supplement';let id;
const act=(s,u,t,p)=>command(s,actorFor(u),t,p);
const agency={agency_id:'MISSING-AGENCY',agency_name:'원본 보완 검증상사',representative_name:'검증 대표',address:'가상 검증 주소',bank_account_no:'NONE',rebate_eligible:'True',registered_date:'2026-07-01'};
const apply=(s,files)=>{const p=previewSource(s,actorFor('intake'),{files});return act(s,'intake','applySourceRows',{files,previewHash:p.previewHash,reason:'원본 등록계좌 정정 확인'});};
const result={at:new Date().toISOString()};
try{
 await store.create(ws);await store.tx(ws,s=>{apply(s,[{table:'agencies',rows:[agency]},{table:'payments',rows:[{rebate_id:'MISSING-PAYMENT',agency_id:agency.agency_id,period_ym:'2026-07',sales_performance_krw:'100000',rebate_amount_krw:'10000',approval_status:'미지급',approver:'NONE',payment_date:'NONE'}]}]);act(s,'intake','schedule',{items:[{id:'MISSING-PAYMENT',date:'2026-08-05'}]});id=act(s,'intake','intake',{paymentIds:['MISSING-PAYMENT'],docs:[]}).caseId;assert(!s.cases[id].canSubmit);});
 await processOne(store,ws);let s=await store.read(ws),job=Object.values(s.jobs).find(j=>j.caseId===id);assert.equal(job.status,'applied',JSON.stringify(job.error));assert.equal(job.decision.owner,'intake');assert(!/확인서/.test(job.decision.reason));result.missing={providerCallId:job.providerCallId,decision:job.decision};
 await store.tx(ws,s=>apply(s,[{table:'agencies',rows:[{...agency,bank_account_no:'DEMO-CONFIRMED-ACCOUNT'}]}]));s=await store.read(ws);const response=Object.values(s.tasks).find(t=>t.caseId===id&&t.responseTo&&t.status==='open');assert(response);assert.equal(s.tasks[response.responseTo].status,'responded');assert.equal(s.cases[id].evidenceAssessment.status,'pass');
 const answer=await createGuidanceService(store,{call:async context=>{try{return await callGuidance(context);}catch(error){console.error(JSON.stringify({code:error.code,reason:error.message,recommendations:error.diagnostic?.recommendations}));throw error;}}})(ws,actorFor('reviewer'),{caseId:id,moduleId:'holds',workItemId:publicState(s,actorFor('reviewer')).workItems.find(w=>w.taskId===response.id).id});assert.equal(answer.status,'ready',answer.errorCode);result.reply={providerCallId:answer.answer.providerCallId,review:answer.review,basicGuidance:answer.basicGuidance};
 mkdirSync('../작업/실행결과',{recursive:true});writeFileSync('../작업/실행결과/원본세표_보완_NIM.json',JSON.stringify(result,null,2));console.log('등록계좌 누락 → NIM 원본 정정 작업 → 정정 회신 연결 → 회계 재검토: PASS');
}finally{await store.close();}
