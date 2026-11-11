import {source} from '../store.mjs';
import {initialState,command,actorFor} from '../domain.mjs';
import {nimCall} from '../ai.mjs';
const s=initialState(source);
command(s,actorFor('intake'),'intake',{paymentIds:['RB-00054','RB-00120','RB-00180'],docs:[{id:'E-MISSING-OWNER',kind:'narrative',text:'모의 증빙: 기존 거래처 이름으로 처리해 달라는 구두 설명만 있습니다. 변경 계좌의 예금주 확인서와 은행 명의 증빙은 첨부하지 못했습니다. 계좌 소유자를 확인할 수 없습니다.'}]});
try{const result=await nimCall(Object.values(s.jobs)[0]);console.log(JSON.stringify(result,null,2));}catch(e){console.log(JSON.stringify({error:e.code,...e.metadata},null,2));process.exitCode=1;}
