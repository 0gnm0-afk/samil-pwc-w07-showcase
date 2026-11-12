import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openStore} from '../store.mjs';
import {actorFor,command,publicState,previewSchedule} from '../domain.mjs';
import {createGuidanceService,guidanceContext} from '../guidance.mjs';
import {processOne} from '../ai.mjs';
const store=await openStore({url:'',local:'memory'}),workspace='qa-source-nim',results=[];
const guide=createGuidanceService(store),act=(s,u,t,p)=>command(s,actorFor(u),t,p);
const record=(name,value)=>{results.push({name,...value});console.log(name+': PASS');};
const output=resolve('../작업/실행결과/원본세표_'+new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(output,{recursive:true});
try{
 await store.create(workspace);let normal,exception,pid;
 await store.tx(workspace,s=>{const p=previewSchedule(s,actorFor('intake'),{mode:'all-recommended'});act(s,'intake','schedule',{...p,mode:'all-recommended'});const gs=publicState(s,actorFor('intake')).intakeGroups;const good=gs.find(g=>g.sourceReview.status==='pass'),bad=gs.find(g=>g.sourceReview.status!=='pass');normal=act(s,'intake','intake',{paymentIds:good.paymentIds,docs:[]}).caseId;exception=act(s,'intake','intake',{paymentIds:bad.paymentIds,docs:[]}).caseId;pid=good.paymentIds[0];record('40건 38묶음 데이터 지급일',{count:p.items.length,groups:p.groups.length,date:p.items[0].date});});
 const rule=await guide(workspace,actorFor('reviewer'),{caseId:normal,moduleId:'submit'});assert.equal(rule.status,'rules');record('정상 원본 규칙 검토 NIM 미호출',{status:rule.status,review:rule.review,basicGuidance:rule.basicGuidance});
 const advice=await guide(workspace,actorFor('reviewer'),{caseId:exception,moduleId:'evidence'});assert.equal(advice.status,'ready',JSON.stringify(advice));assert(advice.review.recommendations.length);record('입금계좌 차이 실제 NIM 판단',{status:advice.status,model:advice.answer.model,providerCallId:advice.answer.providerCallId,review:advice.review,basicGuidance:advice.basicGuidance});
 await processOne(store,workspace);let s=await store.read(workspace),job=Object.values(s.jobs).find(j=>j.caseId===exception&&j.revision===s.cases[exception].revision);assert.equal(job.status,'applied',JSON.stringify({status:job.status,error:job.error}));record('NIM 원본 근거 후속 작업',{status:job.status,providerCallId:job.providerCallId,tasks:Object.values(s.tasks).filter(t=>t.jobId===job.id)});
 await store.tx(workspace,s=>{act(s,'reviewer','review',{caseId:exception,docIds:s.cases[exception].evidenceAssessment.records.map(d=>d.id),confirmPaymentIds:s.cases[exception].paymentIds,reason:'입금계좌는 과거 채권 회수용 계좌이며 현재 지급계좌와 다른 용도임을 원본 거래 종류로 확인했습니다.',resolveKeys:Object.values(s.cases[exception].holds).filter(h=>!h.closedAt&&!h.key.startsWith('evidence:')&&h.key!=='assignee').map(h=>h.key),special:true});act(s,'reviewer','submit',{caseId:exception});act(s,'executive','decide',{caseId:exception,version:s.cases[exception].version,decision:'approve',reason:'입금과 지급의 용도가 다른 점과 사업상 근거 확인'});});
 const parallel=await guide(workspace,actorFor('finance'),{caseId:exception,moduleId:'approval'});assert.equal(parallel.status,'ready',JSON.stringify(parallel));assert.equal((await store.read(workspace)).cases[exception].canPay,false);record('한쪽 승인 이후 재무 임원 NIM 판단',{providerCallId:parallel.answer.providerCallId,review:parallel.review,basicGuidance:parallel.basicGuidance});
 await store.tx(workspace,s=>{act(s,'reviewer','submit',{caseId:normal});for(const a of s.cases[normal].approvals)act(s,a.userId,'decide',{caseId:normal,version:1,decision:'approve',reason:'정상 원본 검토'});const i=act(s,'treasury','pay',{caseId:normal,version:1,paymentId:pid}).instruction;act(s,'treasury','bank',{instructionId:i.id,receiptId:'NIM-BANK',date:i.date,amount:i.amount+1,outcome:'success'});act(s,'reviewer','reconcile',{instructionId:i.id,voucherId:'NIM-V',amount:i.amount});});
 const diff=await guide(workspace,actorFor('reviewer'),{caseId:normal,moduleId:'reconcile',paymentId:pid});assert.equal(diff.status,'ready',JSON.stringify(diff));record('대사 차이 NIM 판단',{providerCallId:diff.answer.providerCallId,review:diff.review,basicGuidance:diff.basicGuidance});
 s=await store.read(workspace);const context=guidanceContext(s,actorFor('finance'),{caseId:exception,moduleId:'approval'}).context;assert(context.sourceRevision!==undefined&&context.reviewMode==='source-1');assert(!JSON.stringify(context).includes('"accountKey":'));
 writeFileSync(resolve(output,'state.json'),JSON.stringify(publicState(s,actorFor('reviewer')),null,2));
 writeFileSync(resolve(output,'results.json'),JSON.stringify({at:new Date().toISOString(),result:'PASS',results},null,2));console.log('기록: '+output);
}catch(error){writeFileSync(resolve(output,'failure.json'),JSON.stringify({message:error.message,results},null,2));throw error;}finally{await store.close();}
