import test from 'node:test';
import assert from 'node:assert/strict';
import {source,openStore} from '../store.mjs';
import {initialState,groups,ledger,basis,command,actorFor,openHolds,publicState} from '../domain.mjs';
import {processOne,validateDecision} from '../ai.mjs';
import {parseCSV} from '../scripts/import-source.mjs';
const ids=['RB-00054','RB-00120','RB-00180'];
const act=(s,user,type,p)=>command(s,actorFor(user),type,p);
const docs=[{id:'D-ACCOUNT',kind:'account',text:'모의 증빙: 세 지급의 등록 계좌 및 거래처 명의 일치. D-024 회수계좌 차이는 과거 회수 건이며 이번 수취계좌와 구분하여 확인.'}];
function intake(s,paymentIds=ids){return act(s,'intake','intake',{paymentIds,docs}).caseId;}
function review(s,id,extra={}){return act(s,'reviewer','review',{caseId:id,docIds:['D-ACCOUNT'],confirmPaymentIds:s.cases[id].paymentIds.filter(p=>!s.instructions[p]),resolveKeys:openHolds(s.cases[id]).filter(h=>!h.key.startsWith('evidence:')).map(h=>h.key),reason:'원본 금액과 모의 명의·수취계좌 증빙 대조 확인',...extra});}
function submitApprove(s,id){act(s,'reviewer','submit',{caseId:id});const c=s.cases[id];for(const a of c.approvals.filter(a=>a.version===c.version))act(s,a.userId,'decide',{caseId:id,version:c.version,decision:'approve',reason:'현재 버전 지급 근거 확인'});}
test('원본 검증, 전이 연결, AC-01a의 결재 대상과 월 합산 분리',()=>{
 assert.deepEqual(source.sources.map(x=>x.count),[50,240,32]);const g=groups(source.agencies);assert.deepEqual(g.components['D-024'],['D-011','D-024','D-037']);
 const s=initialState(source),id=intake(s,[ids[0]]),b=basis(s,s.cases[id]);assert.equal(b.total,3888097);assert.equal(b.selectedTotal,1373515);assert.deepEqual(b.rows.map(r=>r.id),ids);assert.equal(b.required[0].role,'executive');
 assert.throws(()=>parseCSV('id|amount_krw\na|1\na|2',['id','amount_krw'],'id','test'),/ID 중복/);
 assert.throws(()=>parseCSV('id|amount_krw\na|1.1',['id','amount_krw'],'id','test'),/정수/);
 const blank=groups([{agency_id:'a',representative_name:'NONE',address:'',accountKey:null},{agency_id:'b',representative_name:'NONE',address:'',accountKey:null}]);assert.deepEqual(blank.components.a,['a']);
});
test('AC-01 정상 접수부터 3건 대사까지, 중복 없는 합산',()=>{
 const s=initialState(source),id=intake(s);review(s,id);submitApprove(s,id);assert.equal(s.cases[id].canPay,true);
 for(const paymentId of ids){const {instruction:i}=act(s,'treasury','pay',{caseId:id,version:1,paymentId});const payload={instructionId:i.id,receiptId:`BANK-${paymentId}`,date:'2026-07-10',amount:i.amount,outcome:'success'};act(s,'treasury','bank',payload);assert.equal(act(s,'treasury','bank',payload).duplicate,true);act(s,'reconciler','reconcile',{instructionId:i.id,voucherId:`V-${paymentId}`,amount:i.amount});}
 assert.equal(s.cases[id].status,'completed');assert.equal(ledger(s,'D-011','2026-07').total,3888097);assert.equal(Object.keys(s.instructions).length,3);
});
test('AC-02·03 변경 보류, 같은 새 버전 이중승인, 접수자·이해상충 권한',()=>{
 const s=initialState(source),id=intake(s);review(s,id);submitApprove(s,id);
 act(s,'intake','change',{caseId:id,paymentId:ids[1],account:'DEMO-NEW-0120',owner:s.plans[ids[1]].owner,docs:[{id:'N-1',kind:'narrative',text:'명의 증빙이 없습니다. 임시 정산계좌로 바꾸었다는 주장만 있습니다.'}]});
 assert.equal(s.cases[id].canPay,false);assert.equal(Object.keys(s.notifications).length,2);assert.equal(Object.keys(s.jobs).length,1);assert.equal(act(s,'treasury','pay',{caseId:id,version:1,paymentId:ids[0]}).denied,true);
 assert.throws(()=>act(s,'intake','decide',{caseId:id,version:1,decision:'approve',reason:'본인 결재'}),{code:'FORBIDDEN'});
 assert.throws(()=>review(s,id),{code:'STALE_EVIDENCE'});
 act(s,'intake','documents',{caseId:id,docs:[{id:'D-NEW',kind:'supplement',text:'모의 새 수취계좌 명의 확인서를 첨부합니다.'}]});
 review(s,id,{docIds:['D-NEW']});act(s,'reviewer','submit',{caseId:id});act(s,'executive','decide',{caseId:id,version:2,decision:'approve',reason:'재확인'});assert.equal(s.cases[id].canPay,false);act(s,'finance','decide',{caseId:id,version:2,decision:'approve',reason:'독립 확인'});assert.equal(s.cases[id].canPay,true);
 assert.throws(()=>act(s,'treasury','pay',{caseId:id,version:1,paymentId:ids[0]}),{code:'STALE_VERSION'});
 const t=initialState(source),cid=act(t,'intake','intake',{paymentIds:ids,docs,exception:{kind:'conflict',reason:'영업임원 이해상충 신고',users:['executive']}}).caseId;review(t,cid);act(t,'reviewer','submit',{caseId:cid});assert.equal(t.cases[cid].approvals[0].userId,'alternate');assert.throws(()=>act(t,'executive','decide',{caseId:cid,version:1,decision:'approve',reason:'이해상충'}),{code:'ASSIGNEE'});
});
test('AC-04 확인 전 연관 미집행 보류; 215만원 재상신 및 다음 달 변형',()=>{
 for(const date of ['2026-07-10','2026-08-10']){const s=initialState(source,'difference'),main=intake(s,['S-MAIN']),next=intake(s,['S-NEXT']);for(const id of [main,next]){review(s,id);submitApprove(s,id);assert.equal(s.cases[id].currentBasis.total,1950000);}
 const {instruction:i}=act(s,'treasury','pay',{caseId:main,version:1,paymentId:'S-MAIN'});act(s,'treasury','bank',{instructionId:i.id,receiptId:'B',date,amount:1200000,outcome:'success'});
 assert.equal(s.cases[next].canPay,false);assert.equal(act(s,'treasury','pay',{caseId:next,version:1,paymentId:'S-NEXT'}).denied,true);assert.equal(s.instructions['S-NEXT'],undefined);
 act(s,'reconciler','reconcile',{instructionId:i.id,voucherId:'V',amount:1200000});act(s,'reconciler','confirmActual',{instructionId:i.id,amount:1200000,date,docIds:['D-ACCOUNT'],reason:'모의 회신·전표로 금액과 실제 처리월 확인'});
 assert.equal(ledger(s,'S-001','2026-07').total,date.startsWith('2026-07')?2150000:950000);assert.equal(ledger(s,'S-001','2026-08').total,date.startsWith('2026-08')?1200000:0);assert.equal(s.cases[next].needsResubmit,true);assert.equal(s.cases[next].currentBasis.required[0].role,date.startsWith('2026-07')?'executive':'sales');}
});
test('AC-05 SQL 원자성·동시 지시·변경 선저장·종료 ID',async()=>{
 const store=await openStore({local:'memory'});try{await store.create('qa-lock');const id=await store.tx('qa-lock',s=>{const id=intake(s);review(s,id);submitApprove(s,id);return id;});
 const results=await Promise.all(Array.from({length:8},()=>store.tx('qa-lock',s=>act(s,'treasury','pay',{caseId:id,version:1,paymentId:ids[0]}))));assert.equal(new Set(results.map(r=>r.instruction.id)).size,1);assert.equal((await store.query('SELECT count(*)::int as n FROM w07_instructions')).rows[0].n,1);
 const i=results[0].instruction,receipt={instructionId:i.id,receiptId:'SQL-BANK',date:i.date,amount:i.amount,outcome:'success'};
 await store.tx('qa-lock',s=>act(s,'treasury','bank',receipt));assert.equal((await store.tx('qa-lock',s=>act(s,'treasury','bank',receipt))).duplicate,true);
 await store.create('qa-race');const cid=await store.tx('qa-race',s=>{const id=intake(s);review(s,id);submitApprove(s,id);return id;});const old=await store.read('qa-race');assert.equal(old.cases[cid].canPay,true);
 await store.tx('qa-race',s=>act(s,'intake','change',{caseId:cid,paymentId:ids[1],account:'CHANGED-ACCOUNT',owner:s.plans[ids[1]].owner,docs:[]}));const blocked=await store.tx('qa-race',s=>act(s,'treasury','pay',{caseId:cid,version:1,paymentId:ids[0]}));assert.equal(blocked.denied,true);assert.equal(Object.keys((await store.read('qa-race')).instructions).length,0);
 }finally{await store.close();}
 const closed=initialState(source,'closed');for(const id of Object.keys(closed.plans))assert.throws(()=>intake(closed,[id]),{code:'CLOSED_ID'});
});
test('200만원 경계, 한쪽 보완/반려가 다른 미결 결재·지급을 닫음',()=>{
 for(const decision of ['supplement','reject']){const s=initialState(source,'boundary');s.plans['S-BOUNDARY'].amount=2000000;const id=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs,exception:{kind:'policy',reason:'정책 예외 검토'}}).caseId;assert.equal(s.cases[id].currentBasis.required[0].role,'sales');review(s,id);act(s,'reviewer','submit',{caseId:id});act(s,'finance','decide',{caseId:id,version:1,decision,reason:'확인 필요'});assert.equal(s.cases[id].approvals.find(a=>a.role==='sales').decision,'closed');assert.equal(s.cases[id].canPay,false);}
 const s=initialState(source,'boundary');s.plans['S-BOUNDARY'].amount=2000001;const id=intake(s,['S-BOUNDARY']);assert.equal(s.cases[id].currentBasis.required[0].role,'executive');
});
test('AC-06 회신 대기·실패·+1원·충돌과 전표 누락',()=>{
 for(const mode of ['waiting','failure','plus1','conflict','noVoucher']){const s=initialState(source),id=intake(s);review(s,id);submitApprove(s,id);const {instruction:i}=act(s,'treasury','pay',{caseId:id,version:1,paymentId:ids[0]});assert.equal(i.reconciliation,'awaiting_bank');if(mode==='waiting')continue;
 const receipt={instructionId:i.id,receiptId:'B',date:i.date,amount:i.amount+(mode==='plus1'?1:0),outcome:mode==='failure'?'failed':'success'};act(s,'treasury','bank',receipt);
 if(mode==='failure'){assert.equal(s.plans[ids[0]].status,'failed');assert.throws(()=>intake(s,[ids[0]]),{code:'CLOSED_ID'});}
 if(mode==='plus1')assert.equal(s.instructions[ids[0]].reconciliation,'difference');
 if(mode==='noVoucher')assert.equal(s.instructions[ids[0]].reconciliation,'awaiting_voucher');
 if(mode==='conflict'){act(s,'treasury','bank',{...receipt,receiptId:'B2',outcome:'failed'});assert.equal(s.receipts.B.outcome,'success');assert.equal(s.receipts.B2,undefined);assert.equal(s.conflicts.length,1);assert.equal(s.cases[id].canPay,false);}
 }
});
test('은행 차이 이후 새로 접수한 동일 범위도 보류하며 프로토타입 키 조작은 거부',()=>{
 const s=initialState(source,'difference'),main=intake(s,['S-MAIN']);review(s,main);submitApprove(s,main);
 const {instruction:i}=act(s,'treasury','pay',{caseId:main,version:1,paymentId:'S-MAIN'});act(s,'treasury','bank',{instructionId:i.id,receiptId:'LATE',date:i.date,amount:1200000,outcome:'success'});
 const next=intake(s,['S-NEXT']);assert(openHolds(s.cases[next]).some(h=>h.key.startsWith('recon:')));assert(!s.cases[next].canSubmit);
 assert.throws(()=>act(s,'reviewer','review',{caseId:next,docIds:['D-ACCOUNT'],reason:'악성 키 검사',resolveKeys:['__proto__']}),{code:'HOLD'});assert.equal(Object.prototype.closedAt,undefined);
});
test('AC-07·08 AI 인용 검증·실패·지연 응답과 개별 보류',async()=>{
 const store=await openStore({local:'memory'});try{await store.create('qa-ai');const cid=await store.tx('qa-ai',s=>{const id=intake(s);act(s,'intake','documents',{caseId:id,docs:[{id:'DOC-A',kind:'narrative',text:'확인서에는 수취 명의가 가상영업 A로 기록돼 있습니다.'},{id:'DOC-B',kind:'narrative',text:'회신에는 수취 명의가 가상영업 B로 기록돼 있습니다.'}]});return id;});
 assert.deepEqual(await store.pending(),['qa-ai']);await store.recover();
 const state=await store.read('qa-ai'),job=Object.values(state.jobs)[0];const decision={caseId:cid,inputRevision:job.revision,facts:job.docs.filter(d=>d.id.startsWith('DOC')).map(d=>({docId:d.id,quote:d.text,text:d.text})),unknowns:['수취 명의 충돌 확인'],scope:job.basis.members,action:'request_review',owner:'reviewer',reason:'두 증빙의 명의 충돌 확인'};
 assert.throws(()=>validateDecision({...decision,action:'pay'},job),{code:'AI_ACTION'});assert.throws(()=>validateDecision({...decision,facts:[{docId:'DOC-A',quote:'존재하지 않는 인용',text:'오류'}]},job),{code:'AI_CITATION'});
 let release;const waiting=new Promise(r=>release=r);const running=processOne(store,'qa-ai',{call:async()=>{await waiting;return {decision:validateDecision(decision,job),model:'test-adapter'};}});
 await new Promise(r=>setTimeout(r,20));await store.tx('qa-ai',s=>act(s,'reviewer','review',{caseId:cid,docIds:['DOC-A'],reason:'한 사유만 확인',confirmPaymentIds:[],resolveKeys:['document:DOC-A']}));release();await running;
 const after=await store.read('qa-ai');assert.equal(after.jobs[job.id].status,'stale');assert.equal(after.jobs[job.id].taskIds,undefined);assert(openHolds(after.cases[cid]).some(h=>h.key==='document:DOC-B'));
 await processOne(store,'qa-ai',{call:async()=>{throw Object.assign(Error('시험 시간 초과'),{code:'AI_TIMEOUT'});}});const failed=await store.read('qa-ai');assert(Object.values(failed.jobs).some(j=>j.status==='failed'));assert(Object.values(failed.tasks).some(t=>t.errorCode==='AI_TIMEOUT'));assert.equal(failed.cases[cid].canPay,false);
 assert(!JSON.stringify(publicState(failed,actorFor('reviewer'))).includes('"accountKey":'));
 }finally{await store.close();}
});
