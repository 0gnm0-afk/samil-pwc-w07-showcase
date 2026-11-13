// One read model for people and the business AI. It never changes a payment decision.
const unique=values=>[...new Set(values)];
export function settlementDifferences(s,instruction){
  const receipt=s.receipts[instruction.receiptId],voucher=instruction.vouchers?.at(-1),differences=[];
  if(!receipt)return differences;
  const won=v=>Number(v).toLocaleString('ko-KR')+'원';
  if(receipt.amount!==instruction.amount)differences.push({code:'amount',message:`지급액: 승인·지시 ${won(instruction.amount)}, 은행 처리 ${won(receipt.amount)}`});
  if(receipt.accountKey!==instruction.accountKey)differences.push({code:'account',message:`수취계좌: 승인·지시 ${instruction.accountLabel}, 은행 처리 ${receipt.accountLabel}. 표시된 끝자리가 같더라도 전체 계좌 식별값은 다릅니다.`});
  if(receipt.date.slice(0,7)!==instruction.date.slice(0,7))differences.push({code:'month',message:`처리월: 승인·지시 ${instruction.date.slice(0,7)}, 은행 처리 ${receipt.date.slice(0,7)}`});
  if(voucher&&voucher.amount!==receipt.amount)differences.push({code:'voucher',message:`전표 금액: 전표 ${won(voucher.amount)}, 은행 처리 ${won(receipt.amount)}`});
  if(instruction.conflict)differences.push({code:'conflict',message:'같은 지급 지시에 서로 다른 은행 처리결과가 등록되었습니다. 은행 결과와 근거·이력을 확인해야 합니다.'});
  return differences;
}
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
// A model cannot explain an account difference by repeating the two source values.
// Require a current, linked human reply and its citation before one-click acceptance.
export function proceedEvidenceGaps(assessment,docs,facts){
  const cited=facts?new Set(facts.map(f=>f.docId)):null;
  return reviewIssues(assessment).filter(i=>i.code==='collection_account').filter(issue=>{
    const sourceRevision=Math.max(0,...docs.filter(d=>issue.docIds.includes(d.id)).map(d=>d.revision||0));
    const replies=docs.filter(d=>!d.sourceRecord&&['supplement','narrative'].includes(d.kind)&&['intake','reviewer'].includes(d.by)&&
      d.revision>=sourceRevision&&(!cited||cited.has(d.id)));
    return issue.paymentIds.some(id=>!replies.some(d=>d.paymentIds?.includes(id)));
  });
}
export function reviewSummary(s,c){
  const a=c.evidenceAssessment,issues=reviewIssues(a),job=latestReviewJob(s,c);
  const holds=Object.values(c.holds).filter(h=>!h.closedAt);
  const hardIssues=issues.filter(i=>i.status==='fail'||c.reviewMode==='source-1'&&i.code!=='collection_account');
  const fixedHolds=holds.filter(h=>h.key==='assignee'||/^(recon:|conflict:|month:|voucher:)/.test(h.key));
  const canConfirm=!hardIssues.length&&!fixedHolds.length;
  const storedDecision=job?.status==='applied'?job.decision:null;
  const missingReplies=proceedEvidenceGaps(a,c.docs);
  const rejectedProceed=storedDecision?.action==='recommend_proceed'&&proceedEvidenceGaps(a,c.docs,storedDecision.facts).length>0;
  const decision=rejectedProceed?null:storedDecision;
  const awaiting=job&&['pending','running'].includes(job.status);
  const supplement=Object.values(s.tasks).find(t=>t.caseId===c.id&&t.owner==='intake'&&t.status==='open'&&(!t.jobId||s.jobs[t.jobId]?.revision===c.revision));
  const recipients=c.currentBasis.required.map(r=>({sales:'영업지원팀장',executive:'영업 임원',finance:'재무 임원'})[r.userId]||r.userId);
  const reviewedJob=c.reviewRecord?.jobId?s.jobs[c.reviewRecord.jobId]:null;
  const accepted=c.reviewRecord?.action==='accept'||(!c.reviewRecord?.action&&reviewedJob&&
    s.events.some(e=>e.caseId===c.id&&e.type==='review_action'&&e.detail?.action==='accept'&&e.detail.jobId===reviewedJob.id));
  const failed=job?.status==='failed'||rejectedProceed;
  const missingReplyNotice=failed&&missingReplies.length
    ? '입금계좌와 등록 정산계좌가 다른 이유를 설명하는 보완 회신이 연결되어 있지 않습니다.'
    : null;
  const supplementQuestions=decision?.action==='request_supplement'
    ? [...new Set(decision.unknowns.map(question=>question.trim()).filter(Boolean))]
    : [];
  return {revision:c.revision,jobId:job?.id??null,jobStatus:job?.status??null,
    status:c.canSubmit?'ready':awaiting?'analyzing':job?.status==='failed'||rejectedProceed?'failed':decision?'opinion':'needs_review',
    failureReason:missingReplyNotice||(rejectedProceed?'AI가 진행을 권고했지만 현재 보완 회신을 근거로 인용하지 않았습니다.':
      job?.status==='failed'&&job.error?.code==='AI_ACTION'&&job.error?.validationDetail?.action==='recommend_proceed'
        ?'AI가 진행을 권고했지만 확인이 남았거나 진행 조건을 충족하지 않아 수용할 수 없습니다.':
      job?.status==='failed'&&job.error?.code==='AI_CITATION'?'AI가 판단에 필요한 자료를 빠뜨렸거나 근거 인용이 원본과 맞지 않습니다.':null),
    supplementQuestions,missingReplyNotice,
    confirmedReason:c.reviewRecord?.reason??null,
    source:c.canSubmit?(Object.values(c.confirmations).some(v=>v.actor!=='rules')?'person':'rules'):decision?'ai':'rules',
    recipients,issues,blockers:[...hardIssues.map(i=>i.message),...fixedHolds.map(h=>h.reason)],
    holds:holds.filter(h=>!/^evidence:|^auto-evidence:/.test(h.key)).map(h=>({key:h.key,reason:h.key.startsWith('document:')?'추가로 등록된 설명자료의 사실관계와 지급 조건을 확인해야 합니다.':h.key.startsWith('month:')?'지급예정월을 정하지 않은 관련 요청이 있어 월 합산을 확정할 수 없습니다. 영업직원이 해당 요청의 지급예정월을 정해야 합니다.':h.reason})),
    opinion:decision?{action:decision.action,reason:decision.reason,unknowns:decision.unknowns,facts:decision.facts}:null,
    acceptedOpinion:accepted&&reviewedJob?.status==='applied'?reviewedJob.decision:null,
    requestedSupplement:supplement?{id:supplement.id,reason:supplement.reason}:null,
    canConfirm,canAccept:c.needsResubmit&&canConfirm&&!supplement&&decision?.action==='recommend_proceed'&&!decision.unknowns.length,
    canRetry:job?.status==='failed'||rejectedProceed,canSubmit:c.canSubmit&&c.needsResubmit,
    comparison:`거래처 등록정보와 지급 요청의 연결, 지급 대상 여부, 수취 명의·계좌, 원본 금액·정산월을 비교했습니다. 관련 거래처의 지급액을 합산해 필요한 결재권자를 정했습니다.`,
    limitation:'제공 자료 사이의 일치 여부를 확인한 결과입니다. 계약에 따른 장려금 산식이나 실제 계좌 명의를 별도로 검증한 결과는 아닙니다.'};
}
