import { readFileSync } from 'node:fs';
import { roleNames } from './public/catalog.js';
export const workflowModel = JSON.parse(readFileSync(new URL('./data/workflow.json',import.meta.url),'utf8'));
const names = {
  source_updated:'원본 데이터 정정',recheckSource:'원본 기준 재검토',intake:'요청 접수',review:'지급 근거 검토',submit:'결재 상신',decide:'결재',change:'지급조건 변경',
  documents:'증빙 접수',flag:'추가 판단 의뢰',pay:'모의 지급 지시',bank:'은행 회신',reconcile:'전표 대사',
  confirmActual:'실제 지급액 확인',cancel:'요청 취소',pay_blocked:'지급 차단',ai_result:'AI 후속 작업',
  approval_route_updated:'승인 경로 재검토'
};
const decisions={approve:'승인',supplement:'보완 요청',reject:'반려',pending:'대기',closed:'종료'};
const savedResults={source_updated:'정정 근거 보존 · 재검토',recheckSource:'원본 기준 재검토 시작',intake:'접수 완료',review:'검토 저장',submit:'결재 배정',change:'조건 변경 · 재검토',documents:'증빙 연결',flag:'지급보류 · 판단 의뢰',pay:'모의 지급 지시 생성',bank:'은행 결과 등록',reconcile:'대사 결과 저장',confirmActual:'실적 차이 확인',cancel:'취소',pay_blocked:'지급 차단',ai_result:'후속 작업 생성',approval_route_updated:'승인 경로 갱신'};
const reconciliations={matched:'대사 일치',difference:'대사 차이 · 확인 필요',confirmed_difference:'차이 확인 완료',failed:'은행 확정 실패',awaiting_voucher:'은행 성공 · 전표 대기'};
const stage=(id,title,owner,condition='',extra={})=>({id,title,owner,ownerName:roleNames[owner]||owner,condition,...extra});
const review=()=>stage('W07I_Review','지급 근거 재검토','reviewer');
const payment=condition=>stage('W07I_Pay','모의 지급 지시','treasury',condition);
function approvalStage(c) {
  const votes=c.approvals.filter(a=>a.version===c.version&&!c.needsResubmit);
  return stage('W07I_Outcome',c.currentBasis.required.length===2?'병렬 특별승인':'일반 결재','',
    '현재 버전의 필수 승인과 지급 조건을 모두 충족해야 합니다.',{
      parallel:c.currentBasis.required.map(r=>({owner:r.userId,ownerName:roleNames[r.userId],status:decisions[votes.find(a=>a.userId===r.userId)?.decision||'pending']}))
    });
}
export function projectWorkflow(state,c,actor,selectedWork) {
  const history=[];
  for (const e of state.events.filter(e=>e.caseId===c.id)) {
    const taskIds=e.detail?.taskIds||[];
    const linked=state.tasks.filter(t=>taskIds.includes(t.id)||t.id===e.detail?.taskId);
    if (!names[e.type]) {
      if(history.length) history.at(-1).records.push({type:e.type,at:e.at,detail:e.detail});
      continue;
    }
    const required=c.snapshots.find(snapshot=>snapshot.version===e.version)?.basis.required||[];
    if(e.type==='decide'&&required.length===2) {
      const previous=history.at(-1);
      const card=previous?.parallel&&previous.version===e.version?previous:{id:e.id,title:'병렬 특별승인',ownerName:'영업 임원 · 재무 임원',version:e.version,records:[],tasks:[],docs:[],parallel:required.map(r=>({owner:r.userId,ownerName:roleNames[r.userId],status:'대기'}))};
      card.parallel.find(branch=>branch.owner===e.actor).status=decisions[e.detail.decision];
      card.at=e.at;card.result=card.parallel.every(branch=>branch.status==='승인')?'양쪽 승인 완료':decisions[e.detail.decision]==='승인'?'다른 임원 승인 대기':decisions[e.detail.decision];
      card.records.push({type:e.type,actor:e.actor,at:e.at,detail:e.detail});
      if(card!==previous)history.push(card);
      continue;
    }
    history.push({id:e.id,title:names[e.type],owner:e.actor,ownerName:roleNames[e.actor]||e.actor,at:e.at,
      result:decisions[e.detail?.decision]||reconciliations[e.detail?.reconciliation]||e.detail?.status||savedResults[e.type]||'처리 완료',version:e.version,
      records:[{type:e.type,at:e.at,detail:e.detail}],tasks:linked,
      docs:c.docs.filter(d=>d.at===e.at||d.revision===e.revision&&['intake','documents','change'].includes(e.type))});
  }
  let current,next=null;
  const terminal=['completed','rejected','cancelled'].includes(c.status);
  const activeTasks=state.tasks.filter(t=>t.caseId===c.id&&t.status==='open'&&(!t.jobId||state.jobs.some(j=>j.id===t.jobId&&j.revision===c.revision)));
  const instructions=state.instructions.filter(i=>i.caseId===c.id);
  const ownWork=selectedWork||state.workItems.find(w=>w.caseId===c.id);
  if(terminal) current=stage('W07I_Finish',c.status==='completed'?'처리 완료':c.status==='rejected'?'반려 · 종료':'취소 · 종료','', '',{terminal:true});
  else if(instructions.some(i=>!i.receiptId)) {
    current=stage('W07I_Pay','은행 회신 등록','treasury');
    next=stage('W07I_Reconcile','은행 회신·전표 대사','reviewer','은행 처리 결과를 확인한 뒤 대사합니다.');
  } else if(instructions.some(i=>['awaiting_voucher','difference'].includes(i.reconciliation))) {
    current=stage('W07I_Reconcile','은행 회신·전표 대사','reviewer');
    next=c.paymentIds.some(id=>!instructions.some(i=>i.paymentId===id))?review():stage('W07I_Finish','처리 완료','reviewer','모든 지급 건의 실적과 전표 확인 완료');
  } else if(c.canPay) {
    current=payment('현재 버전 승인과 수취 조건 확인');
    next=stage('W07I_Pay','은행 회신 등록','treasury','모의 지급 지시 생성 후');
  } else if(c.status==='approval_pending') {
    current=approvalStage(c);next=payment('같은 버전의 필수 승인 모두 완료');
  } else {
    const supplement=activeTasks.filter(t=>t.owner==='intake');
    if(supplement.length) {
      current=stage('W07I_Supplement','원본 정정·보완 회신','intake','요청받은 자료를 해당 작업에 연결하세요.',{tasks:supplement});
      next=review();
    } else {
      current=review();current.title=c.canSubmit?'검토 결과·결재 상신':'증빙·보류 사유 확인';
      current.tasks=activeTasks.filter(t=>['reviewer','reconciler'].includes(t.owner));
      next=c.canSubmit?approvalStage(c):stage('W07I_Rework','보류 사유 재검토','reviewer','자료와 적격 승인 경로를 확인하면 상신할 수 있습니다.');
    }
  }
  if(!terminal&&ownWork){
    if(ownWork.kind==='bank') {
      current=stage('W07I_Pay','은행 회신 등록','treasury');
      next=stage('W07I_Reconcile','은행 회신·전표 대사','reviewer','해당 지급 건의 은행 회신 등록 후');
    } else if(ownWork.kind==='reconcile') {
      current=stage('W07I_Reconcile','은행 회신·전표 대사','reviewer');
      const remaining=c.paymentIds.some(id=>id!==ownWork.paymentId&&!instructions.some(i=>i.paymentId===id&&['matched','confirmed_difference','failed'].includes(i.reconciliation)));
      next=remaining?stage('W07I_Reconcile','남은 지급 건 확인','reviewer','같은 요청의 남은 지급·회신·대사 상태를 확인합니다.'):stage('W07I_Finish','처리 완료','reviewer','해당 건의 차이 해소와 전표 확인 완료');
    } else if(ownWork.kind==='pay') {
      current=payment('현재 버전 승인과 수취 조건 확인');next=stage('W07I_Pay','은행 회신 등록','treasury','해당 지급 지시 생성 후');
    } else if(ownWork.kind==='change') {
      current=stage('W07I_Prepay','지급조건 변경','intake');next=stage('W07I_Rework','변경 조건 재검토','reviewer','변경 저장 후 기존 승인과 지급 조건을 재검사합니다.');
    } else if(ownWork.kind==='review') {
      current=stage('W07I_Review',c.canSubmit?'검토 결과·결재 상신':'증빙·보류 사유 확인','reviewer','',{tasks:activeTasks.filter(t=>t.owner==='reviewer')});
      next=c.canSubmit?approvalStage(c):activeTasks.some(t=>t.owner==='intake')?stage('W07I_Supplement','원본 정정·보완 회신','intake','요청받은 보완 자료를 제출하면 회계팀이 재검토합니다.'):stage('W07I_Rework','보류 사유 재검토','reviewer','근거와 적격 승인 경로를 확인한 후 상신합니다.');
    }
    current.paymentId=ownWork.paymentId;
  }
  current.mine=current.owner===actor.id||actor.capabilities?.includes(current.owner)||current.parallel?.some(p=>p.owner===actor.id&&p.status==='대기')||false;
  return {version:workflowModel.version,history,current,next};
}
