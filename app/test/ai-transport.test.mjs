import test from 'node:test';
import assert from 'node:assert/strict';
import {redact} from '../domain.mjs';
import {nimCall,promptFor,validateDecision} from '../ai.mjs';
test('증빙 날짜·원 단위 금액은 보존하고 계좌·비밀은 마스킹',()=>{
 const text=redact('2026-07-10 / 2024-02-29 / 3,888,097원 / 123-456-789012 / 123456789012 / nvapi-test-secret / password=sample');
 assert(text.includes('2026-07-10'));assert(text.includes('2024-02-29'));assert(text.includes('3,888,097원'));
 for(const value of ['123-456-789012','123456789012','nvapi-test-secret','sample'])assert(!text.includes(value));
 assert(!redact('2026-02-30').includes('2026-02-30'));
});

test('AI 인용 번호를 원문과 위치로 복원하고 없는 번호는 거부',()=>{
 const text='예금주 확인서가 누락되었습니다. 은행에서 발급받을 수 있습니다.';
 const job={caseId:'CASE-Q',revision:1,basis:{members:['D-011']},docs:[{id:'D1',text}]};
 const citation=promptFor(job).citationChoices[1];
 const raw={caseId:job.caseId,inputRevision:1,facts:[{ref:citation.ref,text:'추가 발급 가능'}],unknowns:[],scope:['D-011'],action:'request_supplement',owner:'intake',reason:'예금주 확인서 요청'};
 const fact=validateDecision(raw,job).facts[0];
 assert.equal(fact.docId,'D1');assert.equal(text.slice(fact.start,fact.end),citation.quote);
 assert.throws(()=>validateDecision({...raw,facts:[{ref:'Q999',text:'존재하지 않는 인용'}]},job),{code:'AI_CITATION'});
});
test('NIM JSON 모드에서도 잘못된 응답은 거부하고 호출 증거만 보존',async()=>{
 const job={caseId:'CASE-TEST',revision:1,basis:{members:['D-011']},docs:[{id:'D1',text:'모의 증빙'}]};
 let sent;
 await assert.rejects(nimCall(job,{apiKey:'test-only',fetcher:async(url,opts)=>{sent=JSON.parse(opts.body);return new Response(JSON.stringify({id:'provider-test-id',choices:[{finish_reason:'length',message:{content:'{"caseId":'}}],usage:{total_tokens:4096}}),{status:200});}}),error=>{
  assert.equal(error.code,'AI_SCHEMA');assert.equal(error.metadata.providerCallId,'provider-test-id');assert.equal(error.metadata.finishReason,'length');assert.equal(error.metadata.httpStatus,200);assert(!JSON.stringify(error.metadata).includes('test-only'));return true;
 });
 assert.deepEqual(sent.response_format,{type:'json_object'});assert.equal(sent.stream,false);
});
test('새 충돌 문서만 인용 후보로 제공하고 양쪽 근거 누락을 거부한다',()=>{
 const job={caseId:'CASE-FOCUS',revision:3,basis:{members:['D-011']},focus:['A','B'],progress:{confirmations:{P:{docIds:['OLD'],actor:'reviewer'}}},docs:[{id:'OLD',text:'이미 수동 확인한 계좌 자료.'},{id:'A',text:'공동 정산 명의는 동림입니다.'},{id:'B',text:'공동 정산 명의는 서림입니다.'}]};
 const input=promptFor(job);assert.deepEqual(input.citationChoices.map(q=>q.docId),['A','B']);assert.deepEqual(input.documents[0].confirmedPaymentIds,['P']);assert.equal(input.documents[0].currentReviewTarget,false);
 const raw={caseId:job.caseId,inputRevision:3,facts:[{ref:'Q1',text:'동림'},{ref:'Q2',text:'서림'}],unknowns:['명의 충돌'],scope:['D-011'],action:'request_review',owner:'reviewer',reason:'두 현재 자료의 명의 충돌을 확인합니다.'};assert.equal(validateDecision(raw,job).facts.length,2);assert.throws(()=>validateDecision({...raw,facts:raw.facts.slice(0,1)},job),{code:'AI_CITATION'});
});
