import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, command, actorFor, publicState, upgradeWorkflow } from '../domain.mjs';
import { source } from '../store.mjs';

const act=(s,user,type,payload)=>command(s,actorFor(user),type,payload);
const view=(s,user)=>publicState(s,actorFor(user));
const docs=[{id:'OWNER-PROOF',kind:'account',text:'모의 증빙에서 등록 수취계좌와 거래처 명의를 확인했습니다.'}];
const headers='request_id,agency_id,amount_krw,period_ym,planned_date';

test('신규 직접·CSV 등록, 재시도, 파일 전체 검증, 묶음 부분 선택',()=>{
  const s=initialState(source,'boundary');
  const row={id:'DIRECT-01',agencyId:'S-001',amount:100000,period:'2026-07',plannedDate:'2026-08-03'};
  assert.throws(()=>act(s,'reviewer','registerRequests',{rows:[row]}),{code:'FORBIDDEN'});
  assert.deepEqual(act(s,'intake','registerRequests',{rows:[row]}).registered,[row.id]);
  assert.deepEqual(act(s,'intake','registerRequests',{rows:[row]}).existing,[row.id]);
  assert.throws(()=>act(s,'intake','registerRequests',{rows:[{...row,amount:1}]}),{code:'REQUEST_ID_CONFLICT'});
  assert.throws(()=>act(s,'intake','registerRequests',{csv:{text:`${headers}\nCSV-01,S-001,120000,2026-07,2026-08-04\nINVALID,D-MISSING,100,2026-07,2026-08-04`}}),/CSV 3행/);
  assert.equal(s.plans['CSV-01'],undefined);
  const csv={text:`\uFEFF${headers}\r\n"CSV-01",S-001,120000,2026-07,2026-08-04\r\n`};
  assert.deepEqual(act(s,'intake','registerRequests',{csv}).registered,['CSV-01']);
  const group=view(s,'intake').intakeGroups.find(g=>g.month==='2026-08');
  assert.deepEqual(group.paymentIds,[row.id,'CSV-01']);
  assert.equal(group.total,220000);
  const caseId=act(s,'intake','intake',{paymentIds:[row.id],docs}).caseId;
  assert.equal(s.cases[caseId].currentBasis.selectedTotal,100000);
  assert.equal(s.cases[caseId].currentBasis.total,220000);
  assert.deepEqual(view(s,'intake').intakeGroups.find(g=>g.month==='2026-08').paymentIds,['CSV-01']);
  act(s,'reviewer','review',{caseId,reason:'등록 명의 확인',docIds:[docs[0].id],confirmPaymentIds:[row.id]});
  act(s,'reviewer','submit',{caseId});
  assert.equal(view(s,'sales').workItems[0].kind,'approval');
  assert.equal(view(s,'executive').workItems.length,0);
});

test('200만원 이하 특별승인도 두 임원에게 동시에 배정하고 두 순서 모두 지급 통제',()=>{
  for(const first of ['executive','finance']){
    const s=initialState(source,'boundary');
    const paymentId='S-BOUNDARY';
    const caseId=act(s,'intake','intake',{paymentIds:[paymentId],docs,exception:{kind:'policy',reason:'특별승인 검토'}}).caseId;
    act(s,'reviewer','review',{caseId,reason:'명의·계좌 확인',docIds:[docs[0].id],confirmPaymentIds:[paymentId]});
    act(s,'reviewer','submit',{caseId});
    const c=s.cases[caseId];
    assert.deepEqual(c.approvals.map(a=>[a.userId,a.version]),[['executive',1],['finance',1]]);
    assert.equal(view(s,'sales').workItems.length,0);
    for(const user of ['executive','finance'])assert.equal(view(s,user).workItems[0].kind,'approval');
    const decision={caseId,version:1,decision:'approve',reason:'검토 v1 근거 확인'};
    act(s,first,'decide',decision);
    assert.equal(view(s,first).workItems.length,0);
    assert.equal(view(s,'treasury').workItems.length,0);
    assert.equal(act(s,'treasury','pay',{caseId,version:1,paymentId}).denied,true);
    act(s,first==='executive'?'finance':'executive','decide',decision);
    assert.equal(view(s,'treasury').workItems[0].kind,'pay');
    assert.equal(act(s,'treasury','pay',{caseId,version:1,paymentId}).instruction.version,1);
  }
});

test('구버전 승인 배정 변경 시 재상신하며 기존 스냅샷과 결재를 보존',()=>{
  const s=initialState(source,'boundary');
  const caseId=act(s,'intake','intake',{paymentIds:['S-BOUNDARY'],docs}).caseId;
  act(s,'reviewer','review',{caseId,reason:'명의 확인',docIds:[docs[0].id],confirmPaymentIds:['S-BOUNDARY']});
  act(s,'reviewer','submit',{caseId});
  const c=s.cases[caseId];
  c.exceptions.policy={reason:'기존 예외 승인',at:new Date().toISOString()};
  c.snapshots[0].basis.required.push({role:'finance',userId:'finance'});
  c.approvals.push({id:'LEGACY-FINANCE',version:1,role:'finance',userId:'finance',decision:'approve'});
  delete s.workflowVersion;
  upgradeWorkflow(s);
  assert.equal(c.needsResubmit,true);
  assert.equal(c.approvals[0].decision,'closed');
  assert.equal(c.approvals[1].decision,'approve');
  assert.equal(c.snapshots[0].basis.required[0].role,'sales');
  assert.equal(c.canPay,false);
  act(s,'reviewer','submit',{caseId});
  assert.deepEqual(c.approvals.filter(a=>a.version===2).map(a=>a.userId),['executive','finance']);
});
