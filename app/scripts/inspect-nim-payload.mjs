import {source} from '../store.mjs';
import {initialState,command,actorFor} from '../domain.mjs';
import {promptFor,MODEL} from '../ai.mjs';
import {writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const s=initialState(source);
command(s,actorFor('intake'),'intake',{paymentIds:['RB-00054','RB-00120','RB-00180'],docs:[{id:'SYNTHETIC-MISSING',kind:'narrative',text:'모의 시연 증빙: 변경 계좌의 예금주 확인서와 은행 명의 증빙은 첨부하지 못했습니다. 계좌 소유자를 확인할 수 없습니다.'}]});
const payload=promptFor(Object.values(s.jobs)[0]);const serialized=JSON.stringify(payload);
for(const a of source.agencies){assert(!serialized.includes(a.accountKey));assert(!serialized.includes(a.agency_name));}
assert(!/nvapi-|password|Authorization|bank_account_no/.test(serialized));
const report={authorization:'사용자 goal: 기존 AXHub 앱에서 NIM 실연동, 구현지시서 v1.2 8절: 명시된 NVIDIA endpoint·모델·DPAPI 키 주입·마스킹한 합성 증빙으로 검증',destination:'https://integrate.api.nvidia.com/v1/chat/completions',model:MODEL,source:'제공된 가상기업 Corevia 그룹 ID·합산 결과 + 이 검증에서 작성한 모의 증빙',excluded:['원본 파일 본문','전체 계좌번호','사용자 비밀번호','NIM 인증키(본문/기록)','실제 고객 자료'],payload};
mkdirSync(new URL('../../작업/실행결과/',import.meta.url),{recursive:true});writeFileSync(new URL('../../작업/실행결과/NIM_전송범위.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
