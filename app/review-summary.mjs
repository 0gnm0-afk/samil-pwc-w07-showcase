// One read model for people and the business AI. It never changes a payment decision.
const unique=values=>[...new Set(values)];
export function reviewIssues(assessment){
  const grouped=new Map();
  for(const payment of assessment?.payments||[])for(const check of payment.checks||[]){
    if(check.status==='pass'||payment.status==='manual')continue;
    const record=assessment.records?.find(d=>d.id===check.docId);
    const agency=record?.fields?.agency_id;
    const agencyName=assessment.records?.find(d=>d.fields?.agency_id===agency&&d.fields?.agency_name)?.fields.agency_name||agency;
    const key=check.code==='collection_account'?`${check.code}:${agency}`:`${check.code}:${check.docId||payment.paymentId}`;
    if(!grouped.has(key))grouped.set(key,{id:key,code:check.code,status:check.status,
      message:check.code==='collection_account'?`${agencyName}의 과거 입금계좌가 등록된 정산계좌와 다릅니다. 입금을 받는 계좌와 장려금을 지급하는 계좌는 다를 수 있어, 이 차이만으로 잘못된 지급이라고 판단할 수 없습니다. 차이가 생긴 사유를 확인해야 합니다.`:check.message,
      docIds:[],paymentIds:[]});
    const item=grouped.get(key);if(check.docId)item.docIds.push(check.docId);item.paymentIds.push(payment.paymentId);
  }
  return [...grouped.values()].map(i=>({...i,docIds:unique(i.docIds),paymentIds:unique(i.paymentIds)}));
}
export function latestReviewJob(s,c){return Object.values(s.jobs).findLast(j=>j.caseId===c.id&&j.revision===c.revision&&j.status!=='stale');}
export function reviewSummary(s,c){
  const a=c.evidenceAssessment,issues=reviewIssues(a),job=latestReviewJob(s,c);
  const holds=Object.values(c.holds).filter(h=>!h.closedAt);
  const hardIssues=issues.filter(i=>i.status==='fail'||c.reviewMode==='source-1'&&i.code!=='collection_account');
  const fixedHolds=holds.filter(h=>h.key==='assignee'||/^(recon:|conflict:|month:|voucher:)/.test(h.key));
  const canConfirm=!hardIssues.length&&!fixedHolds.length;
  const decision=job?.status==='applied'?job.decision:null;
  const awaiting=job&&['pending','running'].includes(job.status);
  const supplement=Object.values(s.tasks).find(t=>t.caseId===c.id&&t.owner==='intake'&&t.status==='open'&&(!t.jobId||s.jobs[t.jobId]?.revision===c.revision));
  const recipients=c.currentBasis.required.map(r=>({sales:'영업지원팀장',executive:'영업 임원',finance:'재무 임원'})[r.userId]||r.userId);
  return {revision:c.revision,jobId:job?.id??null,jobStatus:job?.status??null,
    status:c.canSubmit?'ready':awaiting?'analyzing':job?.status==='failed'?'failed':decision?'opinion':'needs_review',
    source:c.canSubmit?(Object.values(c.confirmations).some(v=>v.actor!=='rules')?'person':'rules'):decision?'ai':'rules',
    recipients,issues,blockers:[...hardIssues.map(i=>i.message),...fixedHolds.map(h=>h.reason)],
    holds:holds.filter(h=>!/^evidence:|^auto-evidence:/.test(h.key)).map(h=>({key:h.key,reason:h.reason})),
    opinion:decision?{action:decision.action,reason:decision.reason,unknowns:decision.unknowns,facts:decision.facts}:null,
    acceptedOpinion:c.reviewRecord?.jobId?s.jobs[c.reviewRecord.jobId]?.decision??null:null,
    requestedSupplement:supplement?{id:supplement.id,reason:supplement.reason}:null,
    canConfirm,canAccept:canConfirm&&decision?.action==='recommend_proceed'&&!decision.unknowns.length,
    canRetry:job?.status==='failed',canSubmit:c.canSubmit&&c.needsResubmit,
    comparison:`거래처 등록정보와 지급 요청의 연결, 지급 대상 여부, 수취 명의·계좌, 원본 금액·정산월을 비교했습니다. 관련 거래처의 지급액을 합산해 필요한 결재권자를 정했습니다.`,
    limitation:'제공 자료 사이의 일치 여부를 확인한 결과입니다. 계약에 따른 장려금 산식이나 실제 계좌 명의를 별도로 검증한 결과는 아닙니다.'};
}
