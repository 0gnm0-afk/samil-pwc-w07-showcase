import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {initialState,actorFor,command,publicState} from '../domain.mjs';
import {source,openStore} from '../store.mjs';
import {guidanceContext,callGuidance} from '../guidance.mjs';
import {processOne} from '../ai.mjs';
const act=(s,user,type,payload)=>command(s,actorFor(user),type,payload);
const proof={id:'GUIDE-PROOF',kind:'account',text:'모의 명의 및 등록 수취계좌 확인서'};
const results=[];
const agentCalls=[];
const output=new URL(process.argv[2]||process.env.W07_GUIDANCE_REPORT||'../../작업/실행결과/업무모듈_NIM안내.json',import.meta.url);
const persist=(extra={})=>writeFileSync(output,JSON.stringify({at:new Date().toISOString(),passed:false,results,agentCalls,...extra},null,2)+'\n');
async function check(s,actor,moduleId,caseId,scenario){
  const {context,key}=guidanceContext(s,actorFor(actor),{moduleId,caseId});
  let answer;const attempts=[];
  for(let attempt=1;attempt<=3;attempt++){
    try{answer=await callGuidance(context);attempts.push({attempt,status:'passed',providerCallId:answer.providerCallId});break;}
    catch(error){
      const code=error.name==='TimeoutError'?'AI_TIMEOUT':error.code||error.name;
      attempts.push({attempt,status:'rejected',code,providerCallId:error.diagnostic?.providerCallId||null});
      console.log(`${scenario}: ${code==='AI_TIMEOUT'?'공급자 응답 시간 초과':'안내 검증 거부'} (${code})`);
      if(attempt===3){persist({failedScenario:scenario,attempts});throw error;}
    }
  }
  assert.equal(answer.httpStatus,200);assert.ok(answer.providerCallId);
  assert(answer.recommendations.every(r=>r.howTo.length>=1&&Array.isArray(r.beforeAction)&&r.source==='ai'&&r.effectSource==='rules'));
  const prose=[answer.summary,answer.nextStep,...answer.checks,...answer.recommendations.map(r=>r.reason)].join(' ');
  assert(!/draft\.saved|enabled\s*[=:]|module\.actions|EarlyAlert|CURRENT|inputRevision/.test(prose),'업무 안내에 개발자 용어가 노출됨');
  results.push({scenario,contextKey:key,moduleId,role:actor,processVersion:context.process.version,processNodes:context.process.nodes.length,processFlows:context.process.flows.length,
    caseId,workflow:context.request.workflow,attempts,answer});
  persist();
  console.log(`${scenario} 통과`);
}
const normal=initialState(source,'boundary');
const caseId=act(normal,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[proof],exception:{kind:'policy',reason:'모의 특별승인'}}).caseId;
await check(normal,'reviewer','evidence',caseId,'정상 회계 검토');
act(normal,'reviewer','review',{caseId,docIds:[proof.id],confirmPaymentIds:['S-BOUNDARY'],reason:'모의 증빙 확인'});
act(normal,'reviewer','submit',{caseId});
act(normal,'executive','decide',{caseId,version:1,decision:'approve',reason:'사업상 근거 확인'});
await check(normal,'finance','approval',caseId,'영업 임원 승인 후 재무 결재');
act(normal,'finance','decide',{caseId,version:1,decision:'approve',reason:'독립 근거 확인'});
const {instruction}=act(normal,'treasury','pay',{caseId,version:1,paymentId:'S-BOUNDARY'});
act(normal,'treasury','bank',{instructionId:instruction.id,receiptId:'GUIDE-BANK',amount:instruction.amount+1,date:instruction.date,outcome:'success'});
act(normal,'reviewer','reconcile',{instructionId:instruction.id,voucherId:'GUIDE-VOUCHER',amount:instruction.amount});
await check(normal,'reviewer','actual',caseId,'은행 실적·전표 대사 차이');
act(normal,'reviewer','reconcile',{instructionId:instruction.id,voucherId:'GUIDE-FINAL-VOUCHER',amount:instruction.amount+1});
act(normal,'reviewer','documents',{caseId,docs:[{id:'GUIDE-FINAL-PROOF',kind:'bank',text:'모의 은행의 최종 실적은 지급 지시보다 1원 많으며 해당 금액의 전표와 대조했습니다.'}]});
act(normal,'reviewer','confirmActual',{instructionId:instruction.id,amount:instruction.amount+1,date:instruction.date,docIds:['GUIDE-FINAL-PROOF'],reason:'모의 최종 은행 실적 및 전표 대조 완료'});
assert.equal(normal.cases[caseId].status,'completed');
await check(normal,'reviewer','result',caseId,'대사 완료·다음 단계 없음');
const store=await openStore({url:'',local:'memory'});
try{
  await store.create('qa-guidance-live','boundary',{validation:true});let missing;
  await store.tx('qa-guidance-live',s=>{missing=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[{id:'GUIDE-MISSING',kind:'narrative',text:'예금주 확인서가 누락되었습니다. 은행에서 발급받은 예금주 확인서를 제출할 수 있습니다.'}]}).caseId;});
  await processOne(store,'qa-guidance-live');
  let saved=await store.read('qa-guidance-live');
  const job=Object.values(saved.jobs).find(j=>j.caseId===missing);
  assert.equal(job.status,'applied');assert.equal(job.decision.action,'request_supplement');
  assert(job.providerCallId);assert.equal(job.decision.instructionsSource,'rules');assert(job.decision.howTo.length);
  agentCalls.push({model:job.model,httpStatus:job.httpStatus,providerCallId:job.providerCallId,action:job.decision.action,reason:job.decision.reason,howTo:job.decision.howTo,effect:job.decision.effect});
  await check(saved,'intake','supplement',missing,'증빙 누락·NIM 보완 요청');
  await store.tx('qa-guidance-live',s=>act(s,'intake','documents',{caseId:missing,taskId:job.taskIds[0],docs:[{id:'GUIDE-REPLY',kind:'supplement',text:'모의 은행 발급 예금주 확인서를 제출했습니다. 현재 수취계좌와 거래처 명의가 일치하는 자료입니다.'}]}));
  saved=await store.read('qa-guidance-live');
  assert(publicState(saved,actorFor('reviewer')).workItems.some(w=>w.kind==='review'&&w.taskId));
  await check(saved,'reviewer','evidence',missing,'보완 회신 후 회계 재검토');
  const changed=initialState(source,'boundary');
  const changedId=act(changed,'intake','intake',{paymentIds:['S-BOUNDARY'],docs:[proof]}).caseId;
  act(changed,'reviewer','review',{caseId:changedId,docIds:[proof.id],confirmPaymentIds:['S-BOUNDARY'],reason:'기존 증빙 대조'});
  act(changed,'reviewer','submit',{caseId:changedId});
  act(changed,'sales','decide',{caseId:changedId,version:1,decision:'approve',reason:'전결 승인'});
  act(changed,'intake','change',{caseId:changedId,paymentId:'S-BOUNDARY',account:'SIM-AFTER-APPROVAL',owner:'검증상사',docs:[]});
  assert.equal(changed.cases[changedId].canPay,false);
  await check(changed,'reviewer','evidence',changedId,'승인 후 계좌 변경·이전 증빙 구분');
}finally{await store.close();}
persist({passed:true});
