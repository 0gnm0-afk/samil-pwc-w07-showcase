import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {source,openStore} from '../store.mjs';
import {command,actorFor,initialState} from '../domain.mjs';
import {guidanceContext,callGuidance,createGuidanceService} from '../guidance.mjs';
import {processOne} from '../ai.mjs';
const act=(s,u,t,p)=>command(s,actorFor(u),t,p);
const proof={id:'PROOF',kind:'account',text:'예금주: 검증상사\n계좌번호: S-ACCOUNT\n작성일: 2026-07-01'};
const report={at:new Date().toISOString(),mode:'actual NVIDIA NIM; isolated synthetic fixture',checks:[],calls:[]};
const output=new URL('../../작업/실행결과/원자료검토_NIM.json',import.meta.url);
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));
const store=await openStore({url:'',local:'memory'});
async function call(name,s,role,input){
 const {context}=guidanceContext(s,actorFor(role),input);
 try{const answer=await callGuidance(context);assert(answer.providerCallId);report.calls.push({name,status:'ready',caseId:input.caseId,context:{assessment:context.evidenceAssessment,settlement:context.settlementAssessment,choices:context.choices},answer});console.log(name,answer.httpStatus,answer.providerCallId);}
 catch(error){report.calls.push({name,status:'failed',code:error.code||error.name,message:error.message,diagnostic:error.diagnostic});console.log(name,error.code||error.name);throw error;}
 finally{save();}
}
try{
 await store.create('qa-evidence','boundary',{validation:true});let id;
 await store.tx('qa-evidence',s=>{id=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[proof]}).caseId;});
 let calls=0;const guide=createGuidanceService(store,{call:async()=>{calls++;throw Error('unexpected call');}});
 assert.equal((await guide('qa-evidence',actorFor('reviewer'),{caseId:id,moduleId:'evidence'})).status,'rules');assert.equal(calls,0);report.checks.push({name:'정상 원자료 자동 검토',nimCalls:0,status:'pass'});save();
 await store.create('qa-evidence-missing','boundary',{validation:true});let missing;
 await store.tx('qa-evidence-missing',s=>{missing=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[{id:'MISSING',kind:'account',text:'예금주: 검증상사\n은행 확인서의 계좌번호와 작성일이 누락되어 재발급을 요청할 수 있습니다.'}]}).caseId;});
 let s=await store.read('qa-evidence-missing');await call('누락 항목의 선택 권고',s,'reviewer',{caseId:missing,moduleId:'evidence'});
 await processOne(store,'qa-evidence-missing');s=await store.read('qa-evidence-missing');const job=Object.values(s.jobs).find(j=>j.revision===s.cases[missing].revision);assert.equal(job.status,'applied',JSON.stringify(job.error));report.checks.push({name:'실제 NIM 보완 작업 생성',status:job.status,callId:job.providerCallId,taskIds:job.taskIds});save();
 const task=Object.values(s.tasks).find(t=>t.jobId===job.id&&t.owner==='intake');assert(task,'보완 작업의 담당자는 영업지원이어야 함');
 await store.tx('qa-evidence-missing',s=>act(s,'intake','documents',{caseId:missing,taskId:task.id,docs:[{...proof,id:'REPLY',kind:'supplement'}]}));s=await store.read('qa-evidence-missing');await call('보완 회신 접수 후 재검토 선택',s,'reviewer',{caseId:missing,moduleId:'holds'});
 const mismatch=initialState(source,'boundary'),m=act(mismatch,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[{...proof,text:'예금주: 다른업체\n계좌번호: OTHER-ACCOUNT\n작성일: 2026-07-01'}]}).caseId;await call('명의 계좌 불일치 선택',mismatch,'reviewer',{caseId:m,moduleId:'evidence'});
 const special=initialState(source,'boundary'),sp=act(special,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[proof],exception:{kind:'policy',reason:'계약상 특별 지급에 대한 독립 판단 필요'}}).caseId;act(special,'reviewer','submit',{caseId:sp});act(special,'executive','decide',{caseId:sp,version:1,decision:'approve',reason:'사업 근거 확인'});await call('영업 승인 후 재무 판단',special,'finance',{caseId:sp,moduleId:'approval'});
 const settled=initialState(source,'boundary'),sid=act(settled,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[proof]}).caseId;act(settled,'reviewer','submit',{caseId:sid});act(settled,'sales','decide',{caseId:sid,version:1,decision:'approve',reason:'근거 확인'});const {instruction:i}=act(settled,'treasury','pay',{caseId:sid,paymentId:'S-BOUNDARY',version:1});act(settled,'treasury','bank',{instructionId:i.id,receiptId:'B',amount:i.amount,date:i.date,outcome:'success'});act(settled,'reviewer','documents',{caseId:sid,docs:[{id:'V',kind:'voucher',text:'금액: 2000001\n전표 금액을 원장과 다시 확인할 수 있습니다.'}]});await call('전표 원자료 1원 차이',settled,'reviewer',{caseId:sid,paymentId:i.paymentId,moduleId:'reconcile'});
 report.status='pass';save();
}finally{await store.close();}
