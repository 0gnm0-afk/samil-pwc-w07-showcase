import {batchIntake} from './batch-intake.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readRequestCsv } from './request-csv.mjs';
import { projectWorkflow } from './workflow.mjs';
import { koreaToday, scheduleVersion, scheduleRule, dataPeriod } from './public/schedule.js';
import {normalizeEvidence,assessEvidence,assessSettlement} from './evidence.mjs';
import {prepareSource,sourcePreview,sourceRecords,assessSource} from './source-data.mjs';
import {sourceTables} from './public/source-schema.js';
import {reviewSummary,reviewIssues,latestReviewJob} from './review-summary.mjs';
export class RuleError extends Error { constructor(code, message, status=409) { super(message); this.code=code; this.status=status; } }
export const must = (condition, code, message, status) => { if(!condition) throw new RuleError(code,message,status); };
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const hash = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
export const now = () => new Date().toISOString();
export const uid = prefix => `${prefix}-${randomUUID()}`;
export const users = [
  {id:'intake',name:'일반 영업지원 직원',role:'sales',capabilities:['intake']},
  {id:'reviewer',name:'회계팀',role:'accounting',capabilities:['reviewer','reconciler']},
  {id:'sales',name:'영업지원팀장(전결)',role:'sales',capabilities:['sales']},
  {id:'executive',name:'영업 임원',role:'executive',capabilities:['executive']},
  {id:'alternate',name:'영업 임원 · 위임 대체자',role:'executive',capabilities:['alternate']},
  {id:'finance',name:'재무 임원',role:'finance',capabilities:['finance']},
  {id:'treasury',name:'자금팀',role:'treasury',capabilities:['treasury']},
  {id:'reconciler',name:'회계팀',role:'accounting',capabilities:['reviewer','reconciler']},
  {id:'admin',name:'시연 관리자',role:'admin',capabilities:['admin']}
];
export const businessRoles = [
  {id:'sales',name:'영업지원',description:'직원은 요청 접수·보완, 팀장은 200만 원 이하 일반 건의 전결을 담당합니다.',members:[{id:'intake',name:'일반 영업지원 직원'},{id:'sales',name:'영업지원팀장(전결)'}]},
  {id:'accounting',name:'회계팀',description:'증빙 검토 · 결재 상신 · 전표 대사',members:[{id:'reviewer',name:'회계 담당'}]},
  {id:'executive',name:'영업 임원',description:'일반 임원 결재 · 특별승인 사업상 타당성 검토',members:[{id:'executive',name:'영업 임원'}]},
  {id:'finance',name:'재무 임원',description:'예외 지급 조건 · 독립 승인',members:[{id:'finance',name:'재무 임원'}]},
  {id:'treasury',name:'자금팀',description:'승인 조건 확인 · 모의 지급 · 회신',members:[{id:'treasury',name:'자금 담당'}]}
];
export const actorFor = id => {const u=users.find(u=>u.id===id);must(u,'AUTH','로그인이 필요합니다.',401);return u;};
export const can = (actor,capability)=>users.find(u=>u.id===actor.id)?.capabilities.includes(capability)??false;
const role = (actor,...roles)=>must(roles.some(r=>can(actor,r)),'FORBIDDEN','이 역할에는 처리 권한이 없습니다.',403);
const money = n => must(Number.isSafeInteger(n)&&n>=0,'AMOUNT','금액은 0 이상의 원 단위 정수여야 합니다.',400);
export const paymentMonth = p => p.plannedDate?.slice(0,7)||p.plannedMonth||null;
const date = d => must(typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d,'DATE','유효한 지급 날짜가 필요합니다.',400);
const text = (s,min=1,max=12000)=>must(typeof s==='string'&&s.trim().length>=min&&s.length<=max,'INPUT','필수 설명 또는 입력 길이를 확인하세요.',400);
export function redact(s) {return String(s).replace(/nvapi-[\w-]+/gi,'[비밀 삭제]').replace(/Bearer\s+\S+/gi,'Bearer [삭제]').replace(/(password|api[_ -]?key|secret|비밀번호|시크릿)\s*[:=]\s*[^\s,;]+/gi,'$1=[비밀 삭제]').replace(/\b\d{2,6}[- ]\d{2,6}[- ]\d{2,10}\b/g,v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:'[계좌 마스킹]').replace(/\b\d{10,}\b/g,'[번호 마스킹]');}
function event(s,c,actor,type,detail={}) { const e={id:uid('EV'),caseId:c?.id??null,revision:c?.revision??0,version:c?.version??0,actor:actor.id,mode:actor.publicDemo?'public_demo':'assigned_account',type,at:now(),detail};s.events.push(e);return e; }
function task(s,c,key,owner,reason,extra={}) { const id=`${c.id}:${key}`; if(!s.tasks[id])s.tasks[id]={id,caseId:c.id,key,owner,reason:redact(reason),status:'open',at:now(),...extra};return id; }
function hold(s,c,key,reason,owner='reviewer',extra={}) { if(!c.holds[key]||c.holds[key].closedAt)c.holds[key]={key,reason,owner,at:now(),...extra};const tid=task(s,c,`hold:${key}`,owner,reason);if(s.tasks[tid].status==='closed'){s.tasks[tid].status='open';s.tasks[tid].reopenedAt=now();} }
function closeHold(s,c,key,actor,reason,docIds) { const h=Object.hasOwn(c.holds,key)?c.holds[key]:null;must(h&&!h.closedAt,'HOLD','열린 보류 사유가 없습니다.');h.closedAt=now();h.resolution={actor:actor.id,reason:redact(reason),docIds};c.holdHistory??=[];c.holdHistory.push(structuredClone(h));const t=s.tasks[`${c.id}:hold:${key}`];if(t)t.status='closed'; }
function exception(s,c,key,reason) { if(!c.exceptions[key])c.exceptions[key]={reason,at:now()}; for(const owner of ['executive','finance']) {const id=`${c.id}:${owner}`;s.notifications[id]??={id,caseId:c.id,owner,at:now(),readOnly:true};} }
export const openHolds = c => Object.values(c.holds).filter(h=>!h.closedAt);
export function groups(agencies) {
  const fields=['representative_name','address','accountKey'], edges=[];
  const adjacent=Object.fromEntries(agencies.map(a=>[a.agency_id,[]]));
  for(let i=0;i<agencies.length;i++)for(let j=i+1;j<agencies.length;j++){
    const a=agencies[i],b=agencies[j],same=fields.filter(f=>a[f]&&a[f]!=='NONE'&&a[f].trim()===b[f]?.trim());
    if(same.length>=2){edges.push({from:a.agency_id,to:b.agency_id,fields:same});adjacent[a.agency_id].push(b.agency_id);adjacent[b.agency_id].push(a.agency_id);}
  }
  const components={};
  for(const a of agencies){const visited=new Set([a.agency_id]),queue=[a.agency_id];for(const id of queue)for(const next of adjacent[id])if(!visited.has(next)){visited.add(next);queue.push(next);}components[a.agency_id]=[...visited].sort();}
  return {components,edges};
}
export function initialState(source,fixture='demo') {
  const s={schema:1,workflowVersion:2,epoch:uid('DATA'),fixture,fixtureVersion:'v1.2.0',createdAt:now(),source:structuredClone(source),sourceRevision:0,sourceHistory:[],plans:{},cases:{},instructions:{},receipts:{},conflicts:[],actuals:{},tasks:{},notifications:{},jobs:{},events:[]};
  for(const p of source.payments){ const a=source.agencies.find(a=>a.agency_id===p.agency_id);const paid=p.approval_status==='승인'&&p.payment_date!=='NONE';
    s.plans[p.rebate_id]={id:p.rebate_id,agencyId:p.agency_id,amount:Number(p.rebate_amount_krw),period:p.period_ym,
      plannedDate:null,
      paidDate:paid?p.payment_date:null,status:paid?'historical':p.approval_status==='미지급'?'planned':'rejected',
      accountKey:a.accountKey,accountLabel:a.accountLabel,owner:a.agency_name,source:p.source,simulation:{kind:'simulation',version:'demo-v1.2',effectiveDate:'2026-07-10'}};
  }
  // Only the admin AC rehearsal preserves the previous attachment-based scenario.
  // Ordinary workspaces start with all forty pending dates unassigned.
  if(fixture==='legacy') {
    for(const id of ['RB-00054','RB-00120','RB-00180'])s.plans[id].plannedDate='2026-07-10';
  } else if(fixture!=='demo') {
    must(['difference','boundary','closed'].includes(fixture),'FIXTURE','알 수 없는 검증 전용 시드입니다.',400);
    s.source={...source,agencies:[{agency_id:'S-001',agency_name:'검증상사',representative_name:'합성 대표',address:'합성 주소',accountKey:hash('S-ACCOUNT'),accountLabel:'모의 ****9000'}],payments:[],collections:[],sources:[{kind:'synthetic',version:'ac-v1.2',reason:'AC-04·05·08 경계·차이·종료 상태 검증',month:'2026-07'}]};
    s.plans={};
    const add=(id,amount,status='planned')=>s.plans[id]={id,agencyId:'S-001',amount,status,period:'2026-06',plannedDate:'2026-07-10',paidDate:status==='historical'?'2026-07-01':null,accountKey:hash('S-ACCOUNT'),accountLabel:'모의 ****9000',owner:'검증상사',source:{kind:'synthetic',id,version:'ac-v1.2'}};
    if(fixture==='difference'){add('S-PAID',900000,'historical');add('S-MAIN',1000000);add('S-NEXT',50000);}
    if(fixture==='boundary')add('S-BOUNDARY',2000000);
    if(fixture==='closed'){add('S-REJECT',10,'rejected');add('S-CANCEL',10,'cancelled');add('S-FAIL',10,'failed');add('S-PAID',10,'historical');}
  }
  return s;
}
export function ledger(s,agencyId,month) {
  const g=groups(s.source.agencies),members=g.components[agencyId];must(members,'AGENCY','거래처를 찾을 수 없습니다.',400);
  const rows=[],missing=[];
  for(const p of Object.values(s.plans)){
    if(!members.includes(p.agencyId)||['rejected','cancelled','failed'].includes(p.status))continue;
    const actual=s.actuals[p.id];
    if(actual){if(actual.date.slice(0,7)===month)rows.push({id:p.id,amount:actual.amount,date:actual.date,kind:'confirmed',source:actual.source});continue;}
    const d=p.status==='historical'?p.paidDate:(p.plannedDate||p.plannedMonth);
    if(!d){missing.push(p.id);continue;}
    if(d.slice(0,7)===month)rows.push({id:p.id,amount:p.amount,date:d,kind:p.status==='historical'?'original-payment-date':'planned',source:p.source});
  }
  return {members,edges:g.edges.filter(e=>members.includes(e.from)),month,rows:rows.sort((a,b)=>a.id.localeCompare(b.id)),missing,total:rows.reduce((a,r)=>a+r.amount,0)};
}
export function basis(s,c) {
  const selected=c.paymentIds.map(id=>s.plans[id]),first=selected[0],month=paymentMonth(first);
  must(month,'MONTH','지급예정월이 없습니다.');
  const l=ledger(s,first.agencyId,month);
  const validScope=selected.every(p=>l.members.includes(p.agencyId)&&paymentMonth(p)===month);
  const special=Object.keys(c.exceptions).length>0;
  const approvalRoles=special?['executive','finance']:[l.total<=2000000?'sales':'executive'];
  const required=approvalRoles.map(role=>({role,userId:role}));
  const material={members:l.members,month,total:l.total,rows:l.rows.map(r=>({id:r.id,amount:r.amount})),
    selected:selected.map(p=>({id:p.id,amount:p.amount,accountKey:p.accountKey,owner:p.owner,date:p.plannedDate})),exceptions:Object.keys(c.exceptions).sort(),required};
  return {...l,selected:selected.map(p=>({id:p.id,amount:p.amount,accountLabel:p.accountLabel,date:p.plannedDate,owner:p.owner})),selectedTotal:selected.reduce((v,p)=>v+p.amount,0),required,validScope,signature:hash(material)};
}
function invalidate(s,c,reason) {c.needsResubmit=true;for(const a of c.approvals)if(a.version===c.version&&a.decision==='pending')a.decision='closed';task(s,c,`revision:${c.revision}`,'reviewer',reason);}
function reevaluate(s,c) {
  if(['rejected','cancelled'].includes(c.status))return;
  if(c.paymentIds.every(id=>s.instructions[id])){
    const instructions=c.paymentIds.map(id=>s.instructions[id]);
    c.status=instructions.every(i=>['matched','confirmed_difference','failed'].includes(i.reconciliation))?'completed'
      :instructions.some(i=>i.reconciliation==='difference'||i.conflict)?'reconciliation_hold':'awaiting_bank';
    c.canPay=false;
    c.canSubmit=false;
    return;
  }
  syncEvidence(s,c);
  const b=basis(s,c);c.currentBasis=b;
  // DR-07 applies even to cases received after the discrepant bank response.
  for(const i of Object.values(s.instructions))if(i.actualUnresolved){const plan=s.plans[i.paymentId],r=s.receipts[i.receiptId];
    const months=[i.date.slice(0,7),r?.date.slice(0,7),...s.conflicts.filter(x=>x.receipt.instructionId===i.id).map(x=>x.receipt.date.slice(0,7))];
    if(b.members.includes(plan.agencyId)&&months.includes(b.month)&&c.paymentIds.some(id=>!s.instructions[id]))hold(s,c,`${i.conflict?'conflict':'recon'}:${i.id}`,'관련자 그룹의 미확인 은행 실적 차이 확인 필요','reconciler',{instructionId:i.id});
  }
  const previous=c.snapshots.at(-1);
  if(previous&&previous.basis.signature!==b.signature)invalidate(s,c,'승인 근거가 달라져 새 버전 상신이 필요합니다.');
  for(const p of c.paymentIds.map(id=>s.plans[id])) if(!s.instructions[p.id]&&!c.confirmations[p.id])hold(s,c,`evidence:${p.id}`,`${p.id} 수취계좌·명의 증빙 확인 필요`);
  for(const id of b.missing)hold(s,c,`month:${id}`,`${id} 지급예정월 확인 필요`);
  for(const h of openHolds(c))if(h.key.startsWith('month:')&&!b.missing.includes(h.key.slice(6)))closeHold(s,c,h.key,{id:'rules'},'지급예정월 입력 확인',[]);
  const scopeOk=b.validScope&&b.missing.length===0;
  const eligible=b.required.every(a=>!c.conflicts.includes(a.userId)&&a.userId!==c.creator)&&new Set(b.required.map(a=>a.userId)).size===b.required.length;
  if(!eligible)hold(s,c,'assignee','독립된 적격 결재자 배정 확인 필요');
  c.checks={scope:scopeOk,evidence:c.paymentIds.every(id=>!!s.instructions[id]||!!c.confirmations[id]),noHolds:openHolds(c).length===0,eligible};
  c.canSubmit=Object.values(c.checks).every(Boolean);
  const approved=previous&&!c.needsResubmit&&b.required.every(r=>c.approvals.some(a=>a.version===c.version&&a.role===r.role&&a.userId===r.userId&&a.decision==='approve'));
  c.canPay=!!approved&&c.canSubmit;
  c.status=openHolds(c).length?'held':c.canPay?'payable':!c.needsResubmit&&c.version?'approval_pending':'review';
}
function refresh(s){for(const c of Object.values(s.cases))reevaluate(s,c);}
function syncEvidence(s,c){
  const assessment=assessEvidence(s,c);c.evidenceAssessment=assessment;
  if(c.reviewMode==='source-1')for(const record of assessment.records){if(!c.docs.some(d=>d.id===record.id))c.docs.push({...record,revision:c.revision,at:now(),by:'source',sourceRecord:true});}
  c.sourceReview=c.reviewMode==='source-1'?assessment:null;
  for(const p of assessment.payments){
    const key=`auto-evidence:${p.paymentId}`,prior=c.confirmations[p.paymentId];
    if(p.status==='pass'){
      if(!prior||prior.actor==='rules'&&(hash(prior.docIds)!==hash(p.docIds)||prior.sourceSignature!==p.sourceSignature)){
        c.confirmations[p.paymentId]={at:now(),actor:'rules',method:assessment.version,sourceSignature:p.sourceSignature,accountKey:s.plans[p.paymentId].accountKey,docIds:p.docIds,reason:c.reviewMode==='source-1'?'연결된 원본 데이터와 지급 조건의 규칙 검토 통과':'필수 항목·대상·명의·계좌·작성 시점의 규칙 대조 통과'};
        event(s,c,{id:'rules'},'evidence_auto_pass',{paymentId:p.paymentId,docIds:p.docIds,ruleVersion:assessment.version});
      }
      for(const h of [key,`evidence:${p.paymentId}`])if(c.holds[h]&&!c.holds[h].closedAt)closeHold(s,c,h,{id:'rules'},'현재 증빙의 규칙 대조 통과',p.docIds);
      for(const d of c.docs.filter(d=>p.docIds.includes(d.id)))if(c.holds[`document:${d.id}`]&&!c.holds[`document:${d.id}`].closedAt)closeHold(s,c,`document:${d.id}`,{id:'rules'},'해당 제출 자료의 항목 대조 통과',p.docIds);
    }else if(p.status==='conflict'){
      delete c.confirmations[p.paymentId];hold(s,c,key,'증빙 항목과 현재 지급 조건이 일치하지 않습니다. 자료를 보완하세요.');
    }else if(prior&&p.status!=='manual'){
      delete c.confirmations[p.paymentId];hold(s,c,key,'증빙이 변경되어 자동 검토 결과를 다시 확인해야 합니다.');
    }
  }
}
function addDocuments(s,c,actor,docs) {
  must(Array.isArray(docs)&&docs.length<=20,'DOCS','증빙 목록을 확인하세요.',400);
  for(const d of docs){text(d.id,1,80);text(d.text);must(!c.docs.some(x=>x.id===d.id),'DOC_ID','증빙 ID가 중복됩니다.');must(['account','narrative','supplement','bank','voucher','uncertain'].includes(d.kind),'DOC_KIND','증빙 유형을 확인하세요.',400);
    must(!d.fields||typeof d.fields==='object'&&!Array.isArray(d.fields)&&Object.values(d.fields).every(v=>['string','number'].includes(typeof v)&&String(v).length<=500),'DOC_FIELDS','증빙 항목 형식을 확인하세요.',400);
    const ids=d.paymentIds||c.paymentIds;must(Array.isArray(ids)&&ids.length>0&&ids.every(id=>c.paymentIds.includes(id)),'DOC_SCOPE','이 요청에 연결할 증빙 대상을 확인하세요.',400);
    const doc=normalizeEvidence(d,{redact,paymentIds:ids,at:now(),by:actor.id,revision:c.revision});c.docs.push(doc);
    if(d.kind!=='account'&&d.kind!=='bank'&&d.kind!=='voucher')hold(s,c,`document:${doc.id}`,`${doc.id} 서술 증빙의 사실·충돌 확인 필요`);
  }
}
function checkSettlementSource(c,ins,input,kind){
  const doc=c.docs.filter(d=>d.kind===kind&&(!d.paymentIds||d.paymentIds.includes(ins.paymentId))).at(-1);
  if(!doc?.extraction)return;
  must(!doc.extraction.issues.length,'SOURCE_CONFLICT','원자료 안의 상충하는 항목을 먼저 보완하세요.');
  for(const key of kind==='bank'?['amount','date','outcome','accountKey']:['amount'])if(doc.extraction.fields[key]!==undefined)must(doc.extraction.fields[key]===input[key],'SOURCE_MISMATCH','입력한 값이 제출 원자료와 다릅니다. 추출 항목과 입력을 확인하거나 정정 원자료를 연결하세요.');
}
function queueAI(s,c,e) {
  if(['completed','rejected','cancelled'].includes(c.status))return;
  for(const prior of Object.values(s.jobs))if(prior.caseId===c.id&&prior.status==='pending'&&prior.revision!==c.revision){prior.status='stale';prior.applied=false;prior.finishedAt=now();}
  const uncertain=openHolds(c).filter(h=>h.key.startsWith('document:')||h.key.startsWith('auto-evidence:')||h.key==='assignee');
  const assessment=c.evidenceAssessment||assessEvidence(s,c);
  const missingProof=c.reviewMode==='source-1'?[]:c.paymentIds.filter(id=>!s.instructions[id]&&!c.confirmations[id]&&
    !c.docs.some(d=>['account','supplement'].includes(d.kind)&&d.revision>=(s.plans[id].evidenceAfterRevision||0)));
  if(!uncertain.length&&!missingProof.length&&assessment.status==='pass')return;
  const id=`${c.id}:${c.revision}`;
  if(s.jobs[id])return;
  const docs=structuredClone(c.docs);
  const assigneeBlocked=uncertain.some(h=>h.key==='assignee');
  const focus=uncertain.filter(h=>h.key.startsWith('document:')).map(h=>h.key.slice('document:'.length));
  if(c.reviewMode==='source-1'&&assessment.status!=='pass')for(const row of assessment.payments.filter(r=>!['pass','manual'].includes(r.status))){
    for(const check of row.checks.filter(k=>k.status!=='pass')){
      const referenced=assessment.records.find(d=>d.id===check.docId);
      if(referenced&&!focus.includes(referenced.id))focus.push(referenced.id);
      const agencyId=referenced?.fields.agency_id||s.plans[row.paymentId].agencyId;
      const agencyDoc=assessment.records.find(d=>d.table==='agencies'&&d.fields.agency_id===agencyId);
      if(agencyDoc&&!focus.includes(agencyDoc.id))focus.push(agencyDoc.id);
    }
  }
  if(assigneeBlocked){
    let factId='RULE-ASSIGNEE';
    while(docs.some(d=>d.id===factId))factId+='-RULE';
    docs.push({id:factId,kind:'rule',text:'필수 승인자 중 이해상충 또는 자기 승인에 해당하는 사람이 있어 적격 승인 경로가 없습니다. 지급을 보류하고 상위 판단이 필요합니다.'});
    focus.push(factId);
  }
  const novel=uncertain.some(h=>c.docs.some(d=>`document:${d.id}`===h.key&&d.kind==='uncertain'));
  if(missingProof.length){
    let factId='RULE-EVIDENCE';
    while(docs.some(d=>d.id===factId))factId+='-RULE';
    docs.push({id:factId,kind:'rule',text:`${missingProof.join(' · ')}의 유효한 수취계좌·명의 확인 증빙이 등록되지 않았습니다.`});
    if(!focus.length)focus.push(factId);
  }
  if(assessment.status!=='pass')docs.push({id:'RULE-EXTRACTION',kind:'rule',text:assessment.payments.flatMap(p=>p.checks.filter(k=>k.status!=='pass').map(k=>`${p.paymentId}: ${k.message}`)).join('\n')});
  const mode=assigneeBlocked?'assignee':novel?'uncertain':c.reviewMode==='source-1'?'source':'documents';
  const progress={status:c.status,version:c.version,revision:c.revision,evidenceAssessment:JSON.parse(JSON.stringify(assessment)),requiredApprovers:c.currentBasis.required,
    approvals:c.approvals.filter(a=>a.version===c.version),confirmations:c.confirmations,
    paymentEvidence:c.paymentIds.map(id=>({paymentId:id,evidenceAfterRevision:s.plans[id].evidenceAfterRevision||0,confirmed:!!c.confirmations[id]})),
    responseLinks:Object.values(s.tasks).filter(t=>t.caseId===c.id&&t.responseTo).map(t=>({id:t.id,responseTo:t.responseTo,docIds:s.tasks[t.responseTo]?.response?.docIds||[],status:t.status})),
    issues:reviewIssues(assessment),history:s.events.filter(e=>e.caseId===c.id).slice(-12).map(e=>({type:e.type,at:e.at,revision:e.revision})),
    effects:{request_supplement:'영업지원 직원에게 보완 작업이 도착합니다. 회신하면 회계팀이 다시 검토하며 지급보류는 자동 해제되지 않습니다.',request_review:'회계팀이 근거와 영향 범위를 확인합니다. 확인 결과를 저장한 뒤 상신 요건을 다시 검사합니다.',hold_for_review:'지급보류를 유지하고 회계팀이 예외 사유와 상위 판단을 확인합니다.',recheck:'새 근거를 회계팀이 현재 지급 조건과 다시 대조합니다.'}};
  s.jobs[id]={id,caseId:c.id,epoch:s.epoch,revision:c.revision,version:c.version,eventId:e.id,status:'pending',createdAt:now(),docs,mode,focus,progress,reasons:uncertain.map(h=>({key:h.key,reason:h.reason})),basis:{month:c.currentBasis.month,total:c.currentBasis.total,members:c.currentBasis.members}};
}

export function upgradeWorkflow(s) {
  if(s.workflowVersion===2)return;
  s.workflowVersion=2;
  for(const c of Object.values(s.cases)){
    if(!c.paymentIds.some(id=>!s.instructions[id])||['rejected','cancelled','completed'].includes(c.status))continue;
    const previous=c.snapshots.at(-1);
    reevaluate(s,c);
    if(previous&&previous.basis.signature!==c.currentBasis.signature){
      const e=event(s,c,{id:'rules'},'approval_route_updated');
      queueAI(s,c,e);
    }
  }
}

function registerRequests(s,actor,payload) {
  let rows=payload.rows;
  const isCsv=Object.hasOwn(payload,'csv');
  if(isCsv){
    must(rows===undefined,'REQUEST_ROWS','직접 입력 또는 CSV 중 하나를 보내세요.',400);
    try { rows=readRequestCsv(payload.csv?.text); }
    catch(error){ throw new RuleError('REQUEST_CSV',error.message,400); }
  }
  must(Array.isArray(rows)&&rows.length>0&&rows.length<=50,'REQUEST_ROWS','한 번에 1~50건을 등록하세요.',400);
  const added=[],existing=[],seen=new Set();
  for(const input of rows){
    try{
      const {id,agencyId,amount,period,plannedDate}=input??{};
      must(typeof id==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)&&!['constructor','prototype'].includes(id),'REQUEST_ID','요청 ID는 영문·숫자·하이픈·밑줄로 입력하세요.',400);
      must(!seen.has(id),'REQUEST_ID','파일 안에 동일한 요청 ID가 있습니다.',400);
      seen.add(id);
      const agency=s.source.agencies.find(a=>a.agency_id===agencyId);
      must(agency,'AGENCY','등록된 거래처를 선택하세요.',400);
      money(amount);
      must(amount>0,'AMOUNT','금액은 0원보다 커야 합니다.',400);
      if(plannedDate)date(plannedDate);
      must(typeof period==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(period),'PERIOD','정산월은 YYYY-MM 형식으로 입력하세요.',400);
      const fingerprint=hash({id,agencyId,amount,period,plannedDate,...(input.evidence?{evidence:input.evidence}:{})});
      const prior=Object.hasOwn(s.plans,id)?s.plans[id]:null;
      if(prior){
        must(prior.registrationFingerprint===fingerprint,'REQUEST_ID_CONFLICT','이미 다른 내용으로 등록된 요청 ID입니다.',409);
        existing.push(id);
        continue;
      }
      const source={kind:'registered',channel:isCsv?'csv':'direct',id,at:now(),by:actor.id};
      if(isCsv)source.row=input.row;
      let pendingEvidence;
      if(input.evidence){
        const d={...input.evidence,id:input.evidence.id||uid('DOC')};text(d.id,1,80);text(d.text);must(['account','narrative','supplement','bank','voucher','uncertain'].includes(d.kind),'DOC_KIND','증빙 종류를 확인하세요.',400);
        must(!d.fields||typeof d.fields==='object'&&!Array.isArray(d.fields)&&Object.values(d.fields).every(v=>v===undefined||['string','number'].includes(typeof v)&&String(v).length<=500),'DOC_FIELDS','증빙 항목 형식을 확인하세요.',400);
        pendingEvidence=[normalizeEvidence(d,{redact,paymentIds:[id],revision:0,at:now(),by:actor.id})];
        pendingEvidence[0].origin={...source};
      }
      added.push({id,agencyId,amount,period,plannedDate:plannedDate||null,paidDate:null,status:'planned',accountKey:agency.accountKey,accountLabel:agency.accountLabel,owner:agency.agency_name,source,registrationFingerprint:fingerprint,...(pendingEvidence?{pendingEvidence}:{})});
    }catch(error){
      if(isCsv&&error instanceof RuleError)throw new RuleError(error.code,`CSV ${input.row}행: ${error.message}`,error.status);
      throw error;
    }
  }
  for(const request of added){s.plans[request.id]=request;s.source.payments.push({rebate_id:request.id,agency_id:request.agencyId,period_ym:request.period,sales_performance_krw:'NONE',rebate_amount_krw:String(request.amount),approval_status:'미지급',approver:'NONE',payment_date:'NONE',source:request.source,revision:1});}if(added.length)s.sourceRevision=(s.sourceRevision||0)+1;
  return {registered:added.map(r=>r.id),existing};
}
function requireCase(s,id){const c=Object.hasOwn(s.cases,id)?s.cases[id]:null;must(c,'CASE','검토 건이 없습니다.',404);return c;}
function version(c,p){must(p.version===c.version,'STALE_VERSION','현재 검토 버전으로 다시 확인하세요.');}
function mutable(c){must(!['rejected','cancelled','completed'].includes(c.status),'CLOSED','종료된 검토 건입니다.');}
function confirmRefs(c,ids){must(Array.isArray(ids)&&ids.length>0&&ids.every(id=>c.docs.some(d=>d.id===id)),'EVIDENCE','실제 증빙 ID를 한 개 이상 연결하세요.',400);}
function affectedHold(s,ins,key,reason,months) {
  const p=s.plans[ins.paymentId],members=groups(s.source.agencies).components[p.agencyId];
  for(const c of Object.values(s.cases))if(c.paymentIds.some(id=>members.includes(s.plans[id].agencyId)&&months.includes(paymentMonth(s.plans[id]))&&!s.instructions[id]))hold(s,c,key,reason,'reconciler',{instructionId:ins.id});
  const own=s.cases[ins.caseId];hold(s,own,key,reason,'reconciler',{instructionId:ins.id});
}
export function previewSource(s,actor,input){
  role(actor,'intake');try{return sourcePreview(s,input);}catch(error){throw new RuleError('SOURCE_INPUT',error.message,400);}
}
function applySourceRows(s,actor,input){
  let preview;try{preview=prepareSource(s,input);}catch(error){throw new RuleError('SOURCE_INPUT',error.message,400);}
  must(!preview.errors.length,'SOURCE_INPUT',preview.errors[0]?.message||'입력 오류를 확인하세요.',400);
  must(input.previewHash===preview.previewHash,'SOURCE_CHANGED','원본 또는 업무 상태가 변경되었습니다. 미리보기를 다시 확인하세요.');
  const changed=preview.rows.filter(r=>r.kind!=='same');if(changed.some(r=>r.kind==='changed'))text(input.reason);
  if(!changed.length)return {applied:[],existing:preview.rows.map(r=>r.id)};
  const draft=structuredClone(s),revision=(s.sourceRevision||0)+1;
  draft.sourceRevision=revision;draft.sourceHistory??=[];
  for(const row of changed){
    const key=sourceTables[row.table].id,record={...row.after,revision:(row.before?.revision||1)+1,source:{kind:row.before?'corrected':'registered',file:redact(row.filename),row:row.row,id:row.id,at:now(),by:actor.id}};
    const index=draft.source[row.table].findIndex(r=>r[key]===row.id);if(index<0)draft.source[row.table].push(record);else draft.source[row.table][index]=record;
    draft.sourceHistory.push({table:row.table,id:row.id,before:row.before,after:record,revision,at:now(),by:actor.id,reason:redact(input.reason||'새 원본 행 등록')});
  }
  for(const row of changed.filter(r=>r.table==='payments')){
    const r=draft.source.payments.find(p=>p.rebate_id===row.id),a=draft.source.agencies.find(a=>a.agency_id===r.agency_id),prior=draft.plans[row.id];
    const historical=r.approval_status==='승인'&&r.payment_date!=='NONE';
    draft.plans[row.id]={...(prior||{}),id:row.id,agencyId:r.agency_id,amount:Number(r.rebate_amount_krw),period:r.period_ym,plannedDate:prior?.plannedDate||null,
      status:prior?.caseId?prior.status:historical?'historical':r.approval_status==='반려'?'rejected':'planned',paidDate:historical?r.payment_date:null,
      accountKey:prior?.accountKey||a.accountKey,accountLabel:prior?.accountLabel||a.accountLabel,owner:prior?.owner||a.agency_name,source:r.source};
  }
  for(const row of changed.filter(r=>r.table==='agencies'))for(const plan of Object.values(draft.plans).filter(p=>p.agencyId===row.id&&p.status==='planned'&&!draft.instructions[p.id])){
    const a=draft.source.agencies.find(a=>a.agency_id===row.id),accountChanged=plan.accountKey!==a.accountKey||plan.owner!==a.agency_name;
    plan.accountKey=a.accountKey;plan.accountLabel=a.accountLabel;plan.owner=a.agency_name;
    const c=draft.cases[plan.caseId];if(c&&accountChanged){delete c.confirmations[plan.id];exception(draft,c,'account_change','대리점 마스터의 수취계좌 또는 명의 정정');hold(draft,c,'changed','수취계좌·명의 정정에 대한 회계 확인이 필요합니다.');invalidate(draft,c,'수취계좌·명의 변경');}
  }
  for(const c of Object.values(draft.cases).filter(c=>!['completed','rejected','cancelled'].includes(c.status))){
    if(!preview.affectedCases.includes(c.id)&&basis(draft,c).signature===basis(s,s.cases[c.id]).signature)continue;
    must(basis(draft,c).validScope,'SOURCE_SCOPE','정정으로 기존 결재 묶음이 여러 그룹·월로 나뉩니다. 해당 미집행 요청을 취소한 뒤 정정하고 다시 접수하세요.');
    const replies=Object.values(draft.tasks).filter(t=>t.caseId===c.id&&t.owner==='intake'&&t.status==='open'&&(!t.jobId||draft.jobs[t.jobId]?.revision===c.revision));
    c.revision++;
    for(const job of Object.values(draft.jobs).filter(j=>j.caseId===c.id&&j.status==='pending')){job.status='stale';job.applied=false;}
    refresh(draft);
    const taskIds=[];
    for(const original of replies){original.status='responded';original.response={sourceRevision:revision,docIds:sourceRecords(draft,c.paymentIds).map(d=>d.id),actor:actor.id,at:now()};taskIds.push(task(draft,c,`source-response:${revision}:${original.id}`,'reviewer','영업지원의 원본 정정 내용을 확인하고 지급 근거를 다시 검토하세요.',{responseTo:original.id}));}
    const e=event(draft,c,actor,'source_updated',{sourceRevision:revision,rows:changed.map(r=>({table:r.table,id:r.id})),taskIds});queueAI(draft,c,e);
  }
  Object.assign(s,draft);return {applied:changed.map(r=>({table:r.table,id:r.id,kind:r.kind})),sourceRevision:revision};
}
function reviewAction(s,actor,p){
  role(actor,'reviewer');
  const original=requireCase(s,p.caseId);
  text(p.requestId,8,100);
  const fingerprint=hash({actor:actor.id,...p});
  const previous=original.reviewActions?.[p.requestId];
  if(previous){must(previous.fingerprint===fingerprint,'REQUEST_CHANGED','동일한 요청의 내용이 바뀌었습니다.');return {...previous.result,duplicate:true};}
  must(original.revision===p.revision,'REVIEW_CHANGED','자료나 검토 내용이 바뀌었습니다. 최신 결과를 확인하세요.');
  // Memory callers and SQL callers get the same all-or-nothing behavior.
  const draft=structuredClone(s),c=requireCase(draft,p.caseId);mutable(c);reevaluate(draft,c);
  const summary=reviewSummary(draft,c),job=latestReviewJob(draft,c);
  let result={caseId:c.id,action:p.action};
  if(p.action==='retry'){
    must(summary.canRetry&&p.jobId===job.id,'AI_CHANGED','다시 시도할 AI 작업이 없습니다.');
    job.status='pending';job.error=null;job.finishedAt=null;delete job.retryAt;
  }else if(p.action==='supplement'||p.action==='hold'){
    text(p.reason,4,4000);must(c.needsResubmit,'REVIEW_CHANGED','이미 결재를 요청했습니다. 최신 상태를 확인하세요.');
    hold(draft,c,'accounting_review',redact(p.reason));
    if(p.action==='supplement'){
      must(!summary.requestedSupplement,'ALREADY_REQUESTED','영업직원에게 이미 자료를 요청했습니다.');
      task(draft,c,`accounting-supplement:${c.revision}`,'intake',p.reason,{action:'request_supplement'});
    }
  }else{
    must(['submit','accept','confirm'].includes(p.action),'REVIEW_ACTION','처리할 행동을 확인하세요.',400);
    if(p.action==='submit')must(summary.canSubmit,'SUBMIT_BLOCKED','아직 확인할 사항이 남아 있습니다.');
    else{
      must(summary.canConfirm,'REVIEW_BLOCKED','원본 정정 또는 별도 확인이 필요한 항목을 먼저 해결하세요.');
      must(!['pending','running'].includes(job?.status),'AI_PENDING','AI가 자료를 검토하고 있습니다. 결과가 나온 뒤 확인하세요.');
      must(!job||p.jobId===job.id,'AI_CHANGED','현재 자료의 AI 의견을 다시 확인하세요.');
      let reason=p.reason;
      if(p.action==='accept'){
        must(summary.canAccept,'AI_NOT_READY','추가 확인이 필요한 AI 의견은 그대로 수용할 수 없습니다.');
        reason=`AI가 인용한 근거와 진행 권고를 회계 담당자가 확인해 수용했습니다. ${job.decision.reason}`;
      }else text(reason,8,4000);
      const pending=c.paymentIds.filter(id=>!draft.instructions[id]);
      const docIds=[...new Set([...(c.evidenceAssessment?.payments||[]).filter(r=>pending.includes(r.paymentId)).flatMap(r=>r.docIds||[]),...c.docs.filter(d=>['supplement','narrative','account'].includes(d.kind)).map(d=>d.id)])];
      const resolveKeys=openHolds(c).filter(h=>h.owner==='reviewer'&&!h.key.startsWith('evidence:')&&h.key!=='assignee'&&!/^(recon:|conflict:|voucher:|month:)/.test(h.key)).map(h=>h.key);
      command(draft,actor,'review',{caseId:c.id,reason,docIds,confirmPaymentIds:pending.filter(id=>!['pass','manual'].includes(c.evidenceAssessment?.payments.find(r=>r.paymentId===id)?.status)),resolveKeys});
      c.reviewRecord={jobId:job?.id,reason:redact(reason),actor:actor.id,at:now()};
    }
    command(draft,actor,'submit',{caseId:c.id});
    // Submission completes any remaining review/response task for this version.
    for(const t of Object.values(draft.tasks))if(t.caseId===c.id&&['open','responded'].includes(t.status)&&t.owner==='reviewer')t.status='closed';
    result.version=c.version;
  }
  refresh(draft);
  event(draft,c,actor,'review_action',{action:p.action,jobId:p.jobId,reason:p.reason?redact(p.reason):undefined});
  c.reviewActions??={};c.reviewActions[p.requestId]={fingerprint,result};
  Object.assign(s,draft);return result;
}

export function command(s,actor,type,p={}) {
  must(actor&&users.some(u=>u.id===actor.id&&u.role===actor.role),'AUTH','인증된 사용자가 아닙니다.',401);
  upgradeWorkflow(s);
  if(type==='reviewAction')return reviewAction(s,actor,p);
  let c=p.caseId?requireCase(s,p.caseId):null,result={},audit={};
  if(type==='batchIntake'){return batchIntake(s,actor,p);
  } else if(type==='applySourceRows'){
    role(actor,'intake');result=applySourceRows(s,actor,p);audit={sourceRevision:s.sourceRevision,rows:result.applied};
  } else if(type==='recheckSource'){
    role(actor,'intake','reviewer');mutable(c);must(c.paymentIds.some(id=>!s.instructions[id]),'CLOSED','미집행 건만 원본 기준으로 재검토할 수 있습니다.');c.reviewMode='source-1';c.revision++;c.confirmations={};audit={reviewMode:c.reviewMode};
  } else if(type==='registerRequests') {
    role(actor,'intake');
    result=registerRequests(s,actor,p);
    audit={registered:result.registered,existing:result.existing};
  } else if(type==='schedule') {
    role(actor,'intake');
    must(!p.mode,'SCHEDULE_RETIRED','검토 접수에서 지급예정월을 선택하세요.',410);
    must(Array.isArray(p.items)&&p.items.length>0&&new Set(p.items.map(i=>i?.id)).size===p.items.length,'INPUT','중복 없는 지급 계획을 확인하세요.',400);
    if(p.asOfDate)must(p.asOfDate===dataPeriod(s.source.payments),'SCHEDULE_CHANGED','데이터 기준월이 바뀌었습니다. 추천을 다시 확인하세요.');
    if(p.sourceRevision!==undefined)must(p.sourceRevision===(s.sourceRevision||0),'SCHEDULE_CHANGED','원본 데이터가 바뀌었습니다. 추천을 다시 확인하세요.');
    if(Object.hasOwn(p,'stateEventId'))must(p.stateEventId===(s.events.at(-1)?.id||null),'SCHEDULE_CHANGED','업무 상태가 바뀌었습니다. 예상 합산과 승인 담당자를 다시 확인하세요.');
    for(const item of p.items){date(item.date);const plan=s.plans[item.id];must(plan&&plan.status==='planned'&&!s.instructions[item.id],'CLOSED','미집행 요청만 지급 계획을 입력할 수 있습니다.');if(p.unassignedOnly)must(!plan.caseId&&(p.includeAssigned||!plan.plannedDate),'SCHEDULE_CHANGED','이미 예정일이 정해졌습니다. 새로고침하세요.');}
    audit.changes=[];for(const item of p.items){date(item.date);const plan=s.plans[item.id];must(plan&&plan.status==='planned'&&!s.instructions[item.id],'CLOSED','미집행 요청만 지급 계획을 입력할 수 있습니다.');if(p.unassignedOnly)must(!plan.caseId&&(p.includeAssigned||!plan.plannedDate),'SCHEDULE_CHANGED','이미 예정일이 정해졌습니다. 새로고침하세요.');audit.changes.push({paymentId:plan.id,before:plan.plannedDate,after:item.date});plan.plannedDate=item.date;
      if(plan.caseId){const other=s.cases[plan.caseId];other.revision++;hold(s,other,'schedule','지급예정일 변경에 대한 회계 확인 필요');invalidate(s,other,'지급예정일 변경');}}
  } else if(type==='intake') {
    role(actor,'intake');must(Array.isArray(p.paymentIds)&&p.paymentIds.length>0&&p.paymentIds.length<=(p.batch?500:30)&&new Set(p.paymentIds).size===p.paymentIds.length,'INPUT','중복 없는 지급 ID를 선택하세요.',400);
    if(p.plannedDate!==undefined)date(p.plannedDate);
    for(const id of p.paymentIds){const plan=s.plans[id];must(plan&&plan.status==='planned'&&!plan.caseId&&!s.instructions[id],'CLOSED_ID','종료되었거나 이미 접수된 지급 ID입니다.');must(paymentMonth(plan)||p.plannedDate,'MONTH','지급예정월을 먼저 입력하세요.');}
    if(p.plannedDate)for(const id of p.paymentIds)s.plans[id].plannedDate??=p.plannedDate;
    c={id:uid('CASE'),title:redact(p.title||'판매장려금 지급 검토'),creator:actor.id,paymentIds:p.paymentIds,revision:1,version:0,status:'review',reviewMode:s.fixture==='demo'?'source-1':'legacy',docs:[],holds:{},exceptions:{},conflicts:[],confirmations:{},snapshots:[],approvals:[],needsResubmit:true};
    s.cases[c.id]=c;for(const id of c.paymentIds)s.plans[id].caseId=c.id;
    for(const id of c.paymentIds)for(const d of s.plans[id].pendingEvidence||[]){must(!c.docs.some(doc=>doc.id===d.id),'DOC_ID','CSV 증빙 ID가 중복됩니다.',400);c.docs.push({...structuredClone(d),revision:c.revision});}
    addDocuments(s,c,actor,p.docs??[]);
    const b=basis(s,c);must(b.validScope,'MIXED_SCOPE','같은 관련자 그룹·지급예정월로 분리해 접수하세요.');
    if(p.declaredTotal!==undefined){money(p.declaredTotal);if(p.declaredTotal!==b.total)exception(s,c,'aggregation','제출 합산액과 서버 재계산 불일치');}
    if(p.exception){
      text(p.exception.reason);
      must(['conflict','policy','aggregation','uncertain'].includes(p.exception.kind),'EXCEPTION','예외 종류를 확인하세요.');
      if(p.exception.kind==='uncertain')addDocuments(s,c,actor,[{id:uid('CONCERN'),kind:'uncertain',text:p.exception.reason}]);
      else {
        exception(s,c,p.exception.kind,redact(p.exception.reason));
        if(p.exception.kind==='conflict')c.conflicts=p.exception.users??['executive'];
      }
    }
    task(s,c,'initial','reviewer','원본·합산·수취계좌와 명의 증빙 검토');result={caseId:c.id};
  } else if(type==='flag') {
    role(actor,'reviewer');mutable(c);text(p.reason);
    c.revision++;
    if(p.policy===true)exception(s,c,'policy',redact(p.reason));
    if(p.conflict){
      exception(s,c,'conflict',redact(p.reason));
      if(!c.conflicts.includes('executive'))c.conflicts.push('executive');
    }
    addDocuments(s,c,actor,[{id:uid('CONCERN'),kind:'uncertain',text:p.reason}]);
    invalidate(s,c,'새로운 판단 사항 확인 필요');
  } else if(type==='documents') {
    role(actor,'intake','reviewer','reconciler','treasury');mutable(c);
    if(can(actor,'treasury'))must(Array.isArray(p.docs)&&p.docs.every(d=>d.kind==='bank')&&assignedWork(s,actor,[c]).some(w=>w.kind==='bank'),'FORBIDDEN','자금팀의 은행 회신 작업에서 은행 원자료만 연결할 수 있습니다.',403);
    const target=p.taskId&&s.tasks[p.taskId];
    if(p.taskId)must(target?.caseId===c.id&&can(actor,target.owner)&&target.status==='open'&&(!target.jobId||s.jobs[target.jobId]?.revision===c.revision),'TASK_CHANGED','현재 담당 작업을 새로고침하세요.');
    c.revision++;addDocuments(s,c,actor,p.docs);
    if(c.version&&p.docs.some(d=>['account','supplement'].includes(d.kind))&&c.paymentIds.some(id=>!s.instructions[id]))invalidate(s,c,'새 계좌·명의 증빙이 제출되어 현재 근거로 재상신이 필요합니다.');
    for(const t of Object.values(s.tasks))if((!target||t===target)&&t.caseId===c.id&&can(actor,t.owner)&&t.status==='open'&&!t.key?.startsWith('hold:')){t.status='responded';t.response={docIds:p.docs.map(d=>d.id),actor:actor.id,at:now()};}
    if(target){audit.taskId=target.id;task(s,c,`response:${c.revision}`,'reviewer','보완 회신을 확인하고 지급 근거를 다시 검토하세요.',{responseTo:target.id});}
  } else if(type==='changeMonth') {
    role(actor,'intake');mutable(c);text(p.reason);must(/^\d{4}-(0[1-9]|1[0-2])$/.test(p.plannedMonth||''),'MONTH','지급예정월을 입력하세요.',400);
    must(c.paymentIds.every(id=>!s.instructions[id]),'ISSUED','지급 지시 전의 검토 건만 지급월을 변경할 수 있습니다.');
    must(c.currentBasis.month!==p.plannedMonth,'UNCHANGED','변경된 지급월이 없습니다.');
    audit={before:c.currentBasis.month,after:p.plannedMonth};for(const id of c.paymentIds){s.plans[id].plannedDate=null;s.plans[id].plannedMonth=p.plannedMonth;}
    c.revision++;hold(s,c,'schedule','지급예정월 변경에 대한 회계 확인 필요');invalidate(s,c,'지급월 변경으로 새 합산·승인 필요');
  } else if(type==='change') {
    role(actor,'intake');mutable(c);const plan=s.plans[p.paymentId];must(plan&&c.paymentIds.includes(plan.id)&&!s.instructions[plan.id],'ISSUED','이미 지시한 지급 조건은 변경할 수 없습니다.');
    text(p.account,4,100);text(p.owner,1,100);if(p.date)date(p.date);
    const newKey=hash(p.account);must(newKey!==plan.accountKey||p.owner!==plan.owner||p.date&&p.date!==plan.plannedDate,'UNCHANGED','변경된 값이 없습니다.');
    audit.before={accountLabel:plan.accountLabel,owner:plan.owner,date:plan.plannedDate};audit.after={accountLabel:`모의 ****${p.account.slice(-4)}`,owner:p.owner,date:p.date||plan.plannedDate};
    c.revision++;plan.accountKey=newKey;plan.accountLabel=`모의 ****${p.account.slice(-4)}`;plan.owner=p.owner;plan.evidenceAfterRevision=c.revision;plan.evidenceAfterDate=koreaToday();if(p.date)plan.plannedDate=p.date;
    delete c.confirmations[plan.id];exception(s,c,'account_change','수취계좌 변경 확인');hold(s,c,'changed','지급 조건 변경에 대한 회계 재검토 필요');invalidate(s,c,'수취계좌 변경으로 기존 승인 무효');
    task(s,c,`supplement:${c.revision}`,'intake','새 수취계좌와 명의 확인 증빙 접수');addDocuments(s,c,actor,p.docs??[]);
  } else if(type==='review') {
    role(actor,'reviewer');mutable(c);text(p.reason);confirmRefs(c,p.docIds);
    if(p.taskId){const target=s.tasks[p.taskId];must(target?.caseId===c.id&&target.owner==='reviewer'&&target.status==='open'&&(!target.jobId||s.jobs[target.jobId]?.revision===c.revision),'TASK_CHANGED','현재 회계 확인 작업을 새로고침하세요.');}
    audit={docIds:p.docIds,confirmPaymentIds:p.confirmPaymentIds??[],resolveKeys:p.resolveKeys??[],taskId:p.taskId};
    if(p.special)exception(s,c,'policy',redact(p.reason));
    for(const id of p.confirmPaymentIds??[]){must(c.paymentIds.includes(id)&&!s.instructions[id],'PAYMENT','미집행 승인 대상을 확인하세요.');must(assessEvidence(s,c).payments.find(r=>r.paymentId===id)?.status!=='conflict','EVIDENCE_CONFLICT','확인된 증빙 불일치를 자료 보완 없이 해제할 수 없습니다.');const plan=s.plans[id],a=s.source.agencies.find(a=>a.agency_id===plan.agencyId);
      if(c.reviewMode==='source-1')must(plan.accountKey&&a?.accountKey,'ACCOUNT_REQUIRED','등록계좌가 비어 있습니다. 원본 마스터를 정정한 뒤 확인하세요.');
      must(c.reviewMode==='source-1'?p.docIds.some(id=>assessSource(s,c).records.some(d=>d.id===id&&d.paymentIds.includes(plan.id))):p.docIds.some(docId=>c.docs.some(d=>d.id===docId&&['account','supplement'].includes(d.kind)&&d.revision>=(plan.evidenceAfterRevision||0))),'STALE_EVIDENCE','현재 지급 조건에 적용되는 계좌·명의 증빙 또는 보완 회신을 연결하세요.');
      must(plan.owner===a.agency_name,'OWNER','명의가 다른 지급은 별도 허용 정책 확정 전 보류합니다.');c.confirmations[id]={at:now(),actor:actor.id,sourceSignature:c.reviewMode==='source-1'?assessSource(s,c).payments.find(r=>r.paymentId===id)?.sourceSignature:undefined,accountKey:plan.accountKey,docIds:p.docIds,reason:redact(p.reason)};
      if(c.holds[`evidence:${id}`]&&!c.holds[`evidence:${id}`].closedAt)closeHold(s,c,`evidence:${id}`,actor,p.reason,p.docIds);
    }
    for(const key of p.resolveKeys??[]){must(!key.startsWith('recon:')&&!key.startsWith('conflict:'),'RECON_ROLE','은행 실적 차이는 회계 대사 담당자가 확인해야 합니다.');must(!key.startsWith('evidence:'),'EVIDENCE','지급별 증빙 확인으로 해제하세요.');must(key!=='assignee','ASSIGNEE','적격 승인 경로가 확인될 때까지 지급을 보류합니다.');closeHold(s,c,key,actor,p.reason,p.docIds);}
    c.revision++;for(const t of Object.values(s.tasks))if(t.caseId===c.id&&['open','responded'].includes(t.status)&&!t.key?.startsWith('hold:')&&(t.owner==='reviewer'||!openHolds(c).length))t.status='closed';
  } else if(type==='submit') {
    role(actor,'reviewer');mutable(c);reevaluate(s,c);must(c.canSubmit,'SUBMIT_BLOCKED','미해결 사유·증빙·합산 범위·결재자 배정을 확인하세요.');must(c.needsResubmit,'ALREADY_SUBMITTED','현재 버전은 이미 상신됐습니다.');
    c.version++;c.needsResubmit=false;const b=basis(s,c);c.snapshots.push({version:c.version,revision:c.revision,at:now(),by:actor.id,basis:b,docs:structuredClone(c.docs),confirmations:structuredClone(c.confirmations)});
    for(const r of b.required)c.approvals.push({id:`${c.id}:${c.version}:${r.role}`,version:c.version,role:r.role,userId:r.userId,decision:'pending',createdAt:now()});
  } else if(type==='decide') {
    role(actor,'sales','executive','finance');mutable(c);version(c,p);
    must(actor.id!==c.creator&&!c.conflicts.includes(actor.id),'ASSIGNEE','배정된 독립 승인권자만 결재할 수 있습니다.',403);
    reevaluate(s,c);must(!c.needsResubmit&&c.canSubmit,'STALE_BASIS','상신 근거가 유효하지 않습니다.');
    const a=c.approvals.find(a=>a.version===c.version&&a.userId===actor.id);must(a&&actor.id!==c.creator&&!c.conflicts.includes(actor.id),'ASSIGNEE','배정된 독립 승인권자만 결재할 수 있습니다.',403);
    must(['approve','supplement','reject'].includes(p.decision),'DECISION','결재 결정을 확인하세요.',400);text(p.reason);
    if(a.decision!=='pending'){must(a.decision===p.decision,'DECIDED','이미 종료된 결재입니다.');return {caseId:c.id,duplicate:true};}
    a.decision=p.decision;a.reason=redact(p.reason);a.at=now();
    audit.decision=p.decision;
    if(p.decision!=='approve'){invalidate(s,c,'결재자가 보완 또는 반려했습니다.');if(p.decision==='reject'){c.status='rejected';for(const id of c.paymentIds)if(!s.instructions[id])s.plans[id].status='rejected';}else hold(s,c,'approval_supplement','결재자 보완 요청에 대한 회계 확인 필요');}
  } else if(type==='cancel') {
    role(actor,'intake');mutable(c);must(c.creator===actor.id&&!c.paymentIds.some(id=>s.instructions[id]),'CANCEL','지급 지시 후 취소할 수 없습니다.');text(p.reason);c.status='cancelled';for(const id of c.paymentIds)s.plans[id].status='cancelled';invalidate(s,c,p.reason);
  } else if(type==='pay') {
    role(actor,'treasury');version(c,p);must(c.paymentIds.includes(p.paymentId),'PAYMENT','이번 승인 대상이 아닙니다.');
    const existing=s.instructions[p.paymentId];if(existing){must(existing.version===p.version,'STALE_VERSION','이미 다른 버전의 지시가 있습니다.');return {instruction:existing,duplicate:true};}
    mutable(c);reevaluate(s,c);
    if(!c.canPay){event(s,c,actor,'pay_blocked',{paymentId:p.paymentId,checks:c.checks});return {denied:true,code:'PAYMENT_BLOCKED',message:'현재 승인 근거·보류 사유를 확인하세요.'};}
    const plan=s.plans[p.paymentId];must(plan.status==='planned','CLOSED_ID','종료된 지급 ID입니다.');
    const executionDate=plan.plannedDate||p.date;date(executionDate);must(executionDate.slice(0,7)===paymentMonth(plan),'PAYMENT_MONTH','승인된 지급예정월 안의 지급일을 입력하세요. 다른 월은 조건 변경 후 재상신해야 합니다.');
    const ins={id:uid('PAY'),paymentId:plan.id,caseId:c.id,version:c.version,amount:plan.amount,accountKey:plan.accountKey,accountLabel:plan.accountLabel,date:executionDate,by:actor.id,at:now(),receiptId:null,reconciliation:'awaiting_bank'};
    s.instructions[plan.id]=ins;plan.status='issued';result={instruction:ins};
  } else if(type==='bank') {
    role(actor,'treasury');const ins=Object.values(s.instructions).find(i=>i.id===p.instructionId);must(ins,'INSTRUCTION','지급 지시가 없습니다.');c=s.cases[ins.caseId];
    text(p.receiptId,1,80);date(p.date);money(p.amount);must(['success','failed'].includes(p.outcome),'BANK','성공 또는 확정 실패를 선택하세요.',400);
    must(!['__proto__','constructor','prototype'].includes(p.receiptId),'RECEIPT_ID','사용할 수 없는 회신 ID입니다.',400);
    const accountKey=p.account?hash(p.account.trim()):ins.accountKey;
    checkSettlementSource(c,ins,{...p,accountKey},'bank');
    const receipt={id:p.receiptId,instructionId:ins.id,date:p.date,amount:p.amount,outcome:p.outcome,accountKey,accountLabel:p.account?`모의 ****${p.account.slice(-4)}`:ins.accountLabel,source:'simulation'};
    const prior=s.receipts[p.receiptId];
    if(prior&&hash(prior)===hash(receipt))return {receipt:prior,duplicate:true};
    if(prior||ins.receiptId){const conflictId=hash(receipt);if(s.conflicts.some(x=>x.id===conflictId))return {conflict:true,duplicate:true};s.conflicts.push({id:conflictId,receipt,at:now()});ins.conflict=true;ins.actualUnresolved=true;ins.reconciliation='difference';
      affectedHold(s,ins,`conflict:${ins.id}`,'동일 지시의 모의 은행 회신 충돌 확인 필요',[ins.date.slice(0,7),p.date.slice(0,7),s.receipts[ins.receiptId]?.date.slice(0,7)].filter(Boolean));result={conflict:true};
    }else {s.receipts[receipt.id]=receipt;ins.receiptId=receipt.id;
      if(receipt.outcome==='failed'){s.plans[ins.paymentId].status='failed';ins.reconciliation='failed';}
      else if(receipt.amount!==ins.amount||receipt.accountKey!==ins.accountKey||receipt.date.slice(0,7)!==ins.date.slice(0,7)){
        ins.reconciliation='difference';ins.actualUnresolved=true;affectedHold(s,ins,`recon:${ins.id}`,'승인과 은행 회신의 금액·계좌·처리월 차이 확인 필요',[ins.date.slice(0,7),receipt.date.slice(0,7)]);
      }else {s.actuals[ins.paymentId]={amount:receipt.amount,date:receipt.date,source:receipt.id};s.plans[ins.paymentId].status='paid';ins.reconciliation='awaiting_voucher';task(s,c,`voucher:${ins.id}`,'reconciler','모의 전표 접수 후 대사 필요');}
    }
  } else if(type==='reconcile') {
    role(actor,'reconciler');const ins=Object.values(s.instructions).find(i=>i.id===p.instructionId);must(ins,'INSTRUCTION','지급 지시가 없습니다.');c=s.cases[ins.caseId];const receipt=s.receipts[ins.receiptId];must(receipt?.outcome==='success'||ins.conflict,'BANK_PENDING','성공 회신 또는 확인할 회신 충돌이 있어야 대사할 수 있습니다.');
    checkSettlementSource(c,ins,p,'voucher');
    text(p.voucherId,1,80);money(p.amount);ins.vouchers??=[];const old=ins.vouchers.find(v=>v.id===p.voucherId);must(!old||old.amount===p.amount,'VOUCHER_CONFLICT','전표 ID의 내용이 충돌합니다.');if(!old)ins.vouchers.push({id:p.voucherId,amount:p.amount,at:now(),by:actor.id,source:'simulation'});
    const match=receipt.amount===ins.amount&&receipt.accountKey===ins.accountKey&&receipt.date.slice(0,7)===ins.date.slice(0,7)&&p.amount===receipt.amount&&!ins.conflict;
    ins.reconciliation=match?'matched':'difference';if(!match)hold(s,c,`voucher:${ins.id}`,'모의 전표·지시·회신 대사 차이 확인 필요','reconciler');
    else {const t=s.tasks[`${c.id}:voucher:${ins.id}`];if(t)t.status='closed';}
  } else if(type==='confirmActual') {
    role(actor,'reconciler');const ins=Object.values(s.instructions).find(i=>i.id===p.instructionId);must(ins,'INSTRUCTION','지급 지시가 없습니다.');c=s.cases[ins.caseId];text(p.reason);confirmRefs(c,p.docIds);money(p.amount);date(p.date);
    must(ins.receiptId,'BANK_PENDING','은행 회신을 먼저 접수하세요.');must(ins.vouchers?.some(v=>v.amount===p.amount),'VOUCHER','확인 금액과 일치하는 모의 전표가 필요합니다.');
    audit={instructionId:ins.id,previousActual:s.actuals[ins.paymentId]??null,confirmedActual:{amount:p.amount,date:p.date,docIds:p.docIds}};
    s.actuals[ins.paymentId]={amount:p.amount,date:p.date,source:p.docIds,actor:actor.id,reason:redact(p.reason),confirmedAt:now()};s.plans[ins.paymentId].status='paid';ins.reconciliation='confirmed_difference';ins.actualUnresolved=false;ins.confirmation=structuredClone(s.actuals[ins.paymentId]);
    ins.confirmationHistory??=[];ins.confirmationHistory.push(structuredClone(ins.confirmation));
    for(const other of Object.values(s.cases))for(const key of [`recon:${ins.id}`,`conflict:${ins.id}`,`voucher:${ins.id}`])if(other.holds[key]&&!other.holds[key].closedAt)closeHold(s,other,key,actor,p.reason,p.docIds);
  } else throw new RuleError('COMMAND','지원하지 않는 요청입니다.',400);
  if(['pay','bank','reconcile'].includes(type)) {
    const instruction=result.instruction||Object.values(s.instructions).find(i=>i.id===p.instructionId);
    audit={...audit,instructionId:instruction?.id,paymentId:instruction?.paymentId,amount:p.amount??instruction?.amount,
      outcome:p.outcome,reconciliation:instruction?.reconciliation,receiptId:p.receiptId,voucherId:p.voucherId};
  }
  refresh(s);const e=event(s,c,actor,type,{...audit,docIds:p.docs?.map(d=>d.id)??audit.docIds,paymentId:p.paymentId??audit.paymentId??null,result:result.denied?'denied':'saved',reason:p.reason?redact(p.reason):undefined});
  if(c)queueAI(s,c,e);return {...result,caseId:c?.id??null,eventId:e.id};
}
export function previewSchedule(s,actor,input) {
  role(actor,'intake');const options=Array.isArray(input)?{items:input}:input||{},all=options.mode==='all-recommended',again=options.mode==='re-recommend';
  let items=options.items;
  must(!options.mode,'SCHEDULE_RETIRED','검토 접수에서 지급예정월을 선택하세요.',410);
  must(Array.isArray(items)&&items.length>0&&new Set(items.map(i=>i?.id)).size===items.length,'INPUT','예정일을 적용할 요청을 선택하세요.',400);
  const includeAssigned=again||options.includeAssigned===true,projected=structuredClone(s);
  for(const item of items){date(item.date);const p=projected.plans[item.id];must(p&&p.status==='planned'&&!p.caseId&&!projected.instructions[item.id]&&(includeAssigned||!p.plannedDate),'SCHEDULE_CHANGED','미접수 요청만 날짜를 적용할 수 있습니다. 기존 날짜 변경은 재추천을 선택하세요.');p.plannedDate=item.date;}
  const selected=new Set(items.map(i=>i.id)),asOfDate=dataPeriod(s.source.payments),sourceRevision=s.sourceRevision||0;
  return {source:'rules',saved:false,mode:all?'all-recommended':again?'re-recommend':'selected',includeAssigned,asOfDate,sourceRevision,previewHash:hash({items,asOfDate,sourceRevision,scheduleVersion}),stateEventId:s.events.at(-1)?.id||null,items,
    groups:intakeGroups(projected).filter(g=>g.paymentIds.some(id=>selected.has(id))).map(g=>{const ids=g.paymentIds.filter(id=>selected.has(id)),b=basis(projected,{paymentIds:ids,exceptions:{}});return {id:g.id,month:g.month,members:g.members,paymentIds:ids,selectedTotal:b.selectedTotal,total:b.total,missing:b.missing,required:b.required};})};
}

function intakeGroups(s) {
  const graph=groups(s.source.agencies);
  const batches=new Map();
  for(const p of Object.values(s.plans)){
    if(p.status!=='planned'||p.caseId)continue;
    const members=graph.components[p.agencyId],month=paymentMonth(p);
    const id=`${members[0]}:${month??'unplanned'}`;
    if(!batches.has(id)){
      const summary=month?ledger(s,p.agencyId,month):null;
      batches.set(id,{id,members,month,total:summary?.total??null,missing:summary?.missing??[],paymentIds:[]});
    }
    batches.get(id).paymentIds.push(p.id);
  }
  return [...batches.values()].map(group=>({...group,sourceReview:assessSource(s,{paymentIds:group.paymentIds,confirmations:{},revision:0}),selectedTotal:group.paymentIds.reduce((sum,id)=>sum+s.plans[id].amount,0),required:group.month?basis(s,{paymentIds:group.paymentIds,exceptions:{}}).required:[],workflow:{history:[],
    current:{id:'W07I_Receive',title:'검토 요청 접수',owner:'intake',ownerName:'일반 영업지원 직원',mine:true},
    next:group.month?{id:'W07I_Review',title:'지급 근거 검토',owner:'reviewer',ownerName:'회계팀',condition:'요청과 증빙을 접수한 후'}:
      {id:'W07I_Receive',title:'묶음에서 지급 요청 접수',owner:'intake',ownerName:'일반 영업지원 직원',condition:'지급예정월과 검토 대상을 함께 선택한 후'}
  }})).sort((a,b)=>Number(!a.month)-Number(!b.month)||a.id.localeCompare(b.id));
}

function assignedWork(s,actor,cases) {
  const work=[];
  for(const c of cases){
    if(['completed','rejected','cancelled'].includes(c.status))continue;
    const activeTasks=Object.values(s.tasks).filter(t=>t.caseId===c.id&&t.status==='open'&&(!t.jobId||s.jobs[t.jobId]?.revision===c.revision));
    const add=(kind,suffix,fields={})=>work.push({id:`${c.id}:${kind}:${suffix}`,caseId:c.id,kind,...fields});
    if(can(actor,'intake')){
      for(const t of activeTasks.filter(t=>t.owner==='intake'))add('supplement',t.id,{taskId:t.id});
    }
    if(can(actor,'reviewer')){
      const aiTasks=activeTasks.filter(t=>t.owner==='reviewer'&&(t.jobId||t.responseTo));
      if(aiTasks.length)add('review','case',{taskId:aiTasks[0].id});
      if(!aiTasks.length&&c.needsResubmit&&c.paymentIds.some(id=>!s.instructions[id]))add('review','case');
    }
    const approval=c.approvals.find(a=>a.version===c.version&&a.userId===actor.id&&a.decision==='pending');
    if(approval&&c.canSubmit&&!c.needsResubmit&&c.currentBasis.required.some(r=>r.userId===actor.id))add('approval',approval.id);
    else if(['executive','finance'].includes(actor.id)&&s.notifications[`${c.id}:${actor.id}`]&&(c.needsResubmit||!c.canSubmit))add('notice','exception');
    for(const paymentId of c.paymentIds){
      const instruction=s.instructions[paymentId];
      if(can(actor,'treasury')){
        if(!instruction&&c.canPay)add('pay',paymentId,{paymentId});
        if(instruction&&!instruction.receiptId)add('bank',paymentId,{paymentId,instructionId:instruction.id});
      }
      if(can(actor,'reconciler')&&instruction&&['awaiting_voucher','difference'].includes(instruction.reconciliation)){
        add('reconcile',paymentId,{paymentId,instructionId:instruction.id});
      }
    }
  }
  return work;
}

export function publicState(s,actor) {
  const visible=Object.values(s.cases).filter(c=>!can(actor,'intake')||c.creator===actor.id);
  const ids=new Set(visible.map(c=>c.id));
  const today=koreaToday();
  const result={canReset:!!(s.events.length||s.sourceHistory?.length||Object.keys(s.guidance||{}).length),epoch:s.epoch,fixture:s.fixture,fixtureVersion:s.fixtureVersion,createdAt:s.createdAt,
    publicDemo:s.publicDemo?{...s.publicDemo,aiLimit:null,guidanceLimit:null}:null,source:s.source.sources,
    sourceRevision:s.sourceRevision||0,sourceRows:s.source,sourceHistory:s.sourceHistory||[],schedulePolicy:{version:scheduleVersion,today,period:dataPeriod(s.source.payments),rule:scheduleRule},
    agencies:s.source.agencies,plans:Object.values(s.plans).map(p=>({...p,plannedMonth:paymentMonth(p)})),cases:visible,tasks:Object.values(s.tasks).filter(t=>ids.has(t.caseId)),notifications:Object.values(s.notifications).filter(n=>ids.has(n.caseId)),
    instructions:Object.values(s.instructions).filter(i=>ids.has(i.caseId)),receipts:Object.values(s.receipts).filter(r=>Object.values(s.instructions).some(i=>ids.has(i.caseId)&&i.id===r.instructionId)),
    jobs:Object.values(s.jobs).filter(j=>ids.has(j.caseId)).map(({docs,...j})=>j),events:s.events.filter(e=>!e.caseId||ids.has(e.caseId)),conflicts:s.conflicts,
    workItems:assignedWork(s,actor,visible),intakeGroups:can(actor,'intake')?intakeGroups(s):[]};
  result.cases = visible.map(c=>{
    const assigned=result.workItems.filter(item=>item.caseId===c.id);
    if(can(actor,'intake')&&!['completed','rejected','cancelled'].includes(c.status)&&c.paymentIds.some(id=>!s.instructions[id]))assigned.push({id:'change',kind:'change'});
    const workflowByWork=Object.fromEntries(assigned.map(item=>{
      const {current,next}=projectWorkflow(result,c,actor,item);
      return [item.id,{current,next}];
    }));
    return {...c,reviewSummary:reviewSummary(s,c),evidenceAssessment:c.evidenceAssessment||assessEvidence(s,c),settlementAssessments:c.paymentIds.flatMap(id=>['bank','voucher'].map(kind=>assessSettlement(s,c,id,kind)).filter(Boolean)),workflow:projectWorkflow(result,c,actor),workflowByWork};
  });
  // Account comparison tokens are server-only; values, attachments and diagnostics are masked.
  return JSON.parse(JSON.stringify(result,(key,value)=>['accountKey','passwordHash','registrationFingerprint'].includes(key)?undefined:value));
}
export { refresh, event, task, hold, queueAI };
