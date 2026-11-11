import test from 'node:test';
import assert from 'node:assert/strict';
import {redact} from '../domain.mjs';
import {nimCall} from '../ai.mjs';
test('증빙 날짜·원 단위 금액은 보존하고 계좌·비밀은 마스킹',()=>{
 const text=redact('2026-07-10 / 2024-02-29 / 3,888,097원 / 123-456-789012 / 123456789012 / nvapi-test-secret / password=sample');
 assert(text.includes('2026-07-10'));assert(text.includes('2024-02-29'));assert(text.includes('3,888,097원'));
 for(const value of ['123-456-789012','123456789012','nvapi-test-secret','sample'])assert(!text.includes(value));
 assert(!redact('2026-02-30').includes('2026-02-30'));
});
test('NIM JSON 모드에서도 잘못된 응답은 거부하고 호출 증거만 보존',async()=>{
 const job={caseId:'CASE-TEST',revision:1,basis:{members:['D-011']},docs:[{id:'D1',text:'모의 증빙'}]};
 let sent;
 await assert.rejects(nimCall(job,{apiKey:'test-only',fetcher:async(url,opts)=>{sent=JSON.parse(opts.body);return new Response(JSON.stringify({id:'provider-test-id',choices:[{finish_reason:'length',message:{content:'{"caseId":'}}],usage:{total_tokens:4096}}),{status:200});}}),error=>{
  assert.equal(error.code,'AI_SCHEMA');assert.equal(error.metadata.providerCallId,'provider-test-id');assert.equal(error.metadata.finishReason,'length');assert.equal(error.metadata.httpStatus,200);assert(!JSON.stringify(error.metadata).includes('test-only'));return true;
 });
 assert.deepEqual(sent.response_format,{type:'json_object'});assert.equal(sent.stream,false);
});
