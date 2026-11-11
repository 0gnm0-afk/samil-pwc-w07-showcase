import { createHash, randomUUID } from 'node:crypto';
export class RuleError extends Error { constructor(code, message, status=409) { super(message); this.code=code; this.status=status; } }
export const must = (condition, code, message, status) => { if(!condition) throw new RuleError(code,message,status); };
const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const hash = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');
export const now = () => new Date().toISOString();
export const uid = prefix => `${prefix}-${randomUUID()}`;
export const users = [
  {id:'intake',name:'영업지원 접수',role:'intake'},
  {id:'reviewer',name:'회계 검토',role:'reviewer'},
  {id:'sales',name:'영업지원 전결',role:'sales'},
  {id:'executive',name:'영업임원',role:'executive'},
  {id:'alternate',name:'위임 영업 대체 승인',role:'alternate'},
  {id:'finance',name:'독립 재무 승인',role:'finance'},
  {id:'treasury',name:'자금팀',role:'treasury'},
  {id:'reconciler',name:'회계 대사',role:'reconciler'},
  {id:'admin',name:'시연 관리자',role:'admin'}
];
export const actorFor = id => {const u=users.find(u=>u.id===id);must(u,'AUTH','로그인이 필요합니다.',401);return u;};
const role = (actor,...roles)=>must(roles.includes(actor.role),'FORBIDDEN','이 역할에는 처리 권한이 없습니다.',403);
const money = n => must(Number.isSafeInteger(n)&&n>=0,'AMOUNT','금액은 0 이상의 원 단위 정수여야 합니다.',400);
const date = d => must(typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d,'DATE','유효한 지급 날짜가 필요합니다.',400);
const text = (s,min=1,max=12000)=>must(typeof s==='string'&&s.trim().length>=min&&s.length<=max,'INPUT','필수 설명 또는 입력 길이를 확인하세요.',400);
export function redact(s) {return String(s).replace(/nvapi-[\w-]+/gi,'[비밀 삭제]').replace(/Bearer\s+\S+/gi,'Bearer [삭제]').replace(/(password|api[_ -]?key|secret|비밀번호|시크릿)\s*[:=]\s*[^\s,;]+/gi,'$1=[비밀 삭제]').replace(/\b\d{2,6}[- ]\d{2,6}[- ]\d{2,10}\b/g,v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:'[계좌 마스킹]').replace(/\b\d{10,}\b/g,'[번호 마스킹]');}
function event(s,c,actor,type,detail={}) { const e={id:uid('EV'),caseId:c?.id??null,revision:c?.revision??0,version:c?.version??0,actor:actor.id,mode:actor.publicDemo?'public_demo':'assigned_account',type,at:now(),detail};s.events.push(e);return e; }
function task(s,c,key,owner,reason,extra={}) { const id=`${c.id}:${key}`; if(!s.tasks[id])s.tasks[id]={id,caseId:c.id,key,owner,reason:redact(reason),status:'open',at:now(),...extra};return id; }
function hold(s,c,key,reason,owner='reviewer',extra={}) { if(!c.holds[key]||c.holds[key].closedAt)c.holds[key]={key,reason,owner,at:now(),...extra};const tid=task(s,c,`hold:${key}`,owner,reason);if(s.tasks[tid].status==='closed'){s.tasks[tid].status='open';s.tasks[tid].reopenedAt=now();} }
function closeHold(s,c,key,actor,reason,docIds) { const h=Object.hasOwn(c.holds,key)?c.holds[key]:null;must(h&&!h.closedAt,'HOLD','열린 보류 사유가 없습니다.');h.closedAt=now();h.resolution={actor:actor.id,reason:redact(reason),docIds};c.holdHistory??=[];c.holdHistory.push(structuredClone(h));const t=s.tasks[`${c.id}:hold:${key}`];if(t)t.status='closed'; }
function exception(s,c,key,reason) { if(!c.exceptions[key])c.exceptions[key]={reason,at:now()}; for(const owner of ['sales','finance']) {const id=`${c.id}:${owner}`;s.notifications[id]??={id,caseId:c.id,owner,at:now(),readOnly:true};} }
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
  const s={schema:1,epoch:uid('DATA'),fixture,fixtureVersion:'v1.2.0',createdAt:now(),source,plans:{},cases:{},instructions:{},receipts:{},conflicts:[],actuals:{},tasks:{},notifications:{},jobs:{},events:[]};
  for(const p of source.payments){ const a=source.agencies.find(a=>a.agency_id===p.agency_id);const paid=p.approval_status==='승인'&&p.payment_date!=='NONE';
    s.plans[p.rebate_id]={id:p.rebate_id,agencyId:p.agency_id,amount:Number(p.rebate_amount_krw),period:p.period_ym,
      plannedDate:['RB-00054','RB-00120','RB-00180'].includes(p.rebate_id)?'2026-07-10':null,
      paidDate:paid?p.payment_date:null,status:paid?'historical':p.approval_status==='미지급'?'planned':'rejected',
      accountKey:a.accountKey,accountLabel:a.accountLabel,owner:a.agency_name,source:p.source,simulation:{kind:'simulation',version:'demo-v1.2',effectiveDate:'2026-07-10'}};
  }
  if(fixture!=='demo') {
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
    const d=p.status==='historical'?p.paidDate:p.plannedDate;
    if(!d){missing.push(p.id);continue;}
    if(d.slice(0,7)===month)rows.push({id:p.id,amount:p.amount,date:d,kind:p.status==='historical'?'original-payment-date':'planned',source:p.source});
  }
  return {members,edges:g.edges.filter(e=>members.includes(e.from)),month,rows:rows.sort((a,b)=>a.id.localeCompare(b.id)),missing,total:rows.reduce((a,r)=>a+r.amount,0)};
}
export function basis(s,c) {
  const selected=c.paymentIds.map(id=>s.plans[id]),first=selected[0],month=first.plannedDate?.slice(0,7);
  must(month,'MONTH','지급예정월이 없습니다.');
  const l=ledger(s,first.agencyId,month);
  const validScope=selected.every(p=>l.members.includes(p.agencyId)&&p.plannedDate?.slice(0,7)===month);
  const salesRole=l.total<=2000000?'sales':'executive';
  const required=[{role:salesRole,userId:c.conflicts.includes(salesRole)||c.creator===salesRole?'alternate':salesRole}];
  if(Object.keys(c.exceptions).length)required.push({role:'finance',userId:'finance'});
  const material={members:l.members,month,total:l.total,rows:l.rows.map(r=>({id:r.id,amount:r.amount})),
    selected:selected.map(p=>({id:p.id,amount:p.amount,accountKey:p.accountKey,owner:p.owner,date:p.plannedDate})),exceptions:Object.keys(c.exceptions).sort(),required};
  return {...l,selected:selected.map(p=>({id:p.id,amount:p.amount,accountLabel:p.accountLabel,date:p.plannedDate,owner:p.owner})),selectedTotal:selected.reduce((v,p)=>v+p.amount,0),required,validScope,signature:hash(material)};
}
function invalidate(s,c,reason) {c.needsResubmit=true;for(const a of c.approvals)if(a.version===c.version&&a.decision==='pending')a.decision='closed';task(s,c,`revision:${c.revision}`,'reviewer',reason);}
function reevaluate(s,c) {
  if(['rejected','cancelled'].includes(c.status))return;
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
  const allIssued=c.paymentIds.every(id=>s.instructions[id]);
  if(allIssued){const ins=c.paymentIds.map(id=>s.instructions[id]);c.status=ins.every(i=>['matched','confirmed_difference','failed'].includes(i.reconciliation))?'completed':ins.some(i=>i.reconciliation==='difference'||i.conflict)?'reconciliation_hold':'awaiting_bank';}
  else c.status=openHolds(c).length?'held':c.canPay?'payable':!c.needsResubmit&&c.version?'approval_pending':'review';
}
function refresh(s){for(const c of Object.values(s.cases))reevaluate(s,c);}
function addDocuments(s,c,actor,docs) {
  must(Array.isArray(docs)&&docs.length<=20,'DOCS','증빙 목록을 확인하세요.',400);
  for(const d of docs){text(d.id,1,80);text(d.text);must(!c.docs.some(x=>x.id===d.id),'DOC_ID','증빙 ID가 중복됩니다.');must(['account','narrative','supplement','bank','voucher'].includes(d.kind),'DOC_KIND','증빙 유형을 확인하세요.',400);
    const doc={id:d.id,kind:d.kind,text:redact(d.text),source:'simulation',at:now(),by:actor.id,revision:c.revision};c.docs.push(doc);
    if(d.kind!=='account'&&d.kind!=='bank'&&d.kind!=='voucher')hold(s,c,`document:${doc.id}`,`${doc.id} 서술 증빙의 사실·충돌 확인 필요`);
  }
}
function queueAI(s,c,e) {
  const uncertain=openHolds(c).filter(h=>h.key.startsWith('document:'));
  if(!uncertain.length)return;
  const id=`${c.id}:${c.revision}`;
  if(!s.jobs[id])s.jobs[id]={id,caseId:c.id,epoch:s.epoch,revision:c.revision,version:c.version,eventId:e.id,status:'pending',createdAt:now(),docs:structuredClone(c.docs),reasons:uncertain.map(h=>({key:h.key,reason:h.reason})),basis:{month:c.currentBasis.month,total:c.currentBasis.total,members:c.currentBasis.members}};
}
function requireCase(s,id){const c=Object.hasOwn(s.cases,id)?s.cases[id]:null;must(c,'CASE','검토 건이 없습니다.',404);return c;}
function version(c,p){must(p.version===c.version,'STALE_VERSION','현재 검토 버전으로 다시 확인하세요.');}
function mutable(c){must(!['rejected','cancelled','completed'].includes(c.status),'CLOSED','종료된 검토 건입니다.');}
function confirmRefs(c,ids){must(Array.isArray(ids)&&ids.length>0&&ids.every(id=>c.docs.some(d=>d.id===id)),'EVIDENCE','실제 증빙 ID를 한 개 이상 연결하세요.',400);}
function affectedHold(s,ins,key,reason,months) {
  const p=s.plans[ins.paymentId],members=groups(s.source.agencies).components[p.agencyId];
  for(const c of Object.values(s.cases))if(c.paymentIds.some(id=>members.includes(s.plans[id].agencyId)&&months.includes(s.plans[id].plannedDate?.slice(0,7))&&!s.instructions[id]))hold(s,c,key,reason,'reconciler',{instructionId:ins.id});
  const own=s.cases[ins.caseId];hold(s,own,key,reason,'reconciler',{instructionId:ins.id});
}
export function command(s,actor,type,p={}) {
  must(actor&&users.some(u=>u.id===actor.id&&u.role===actor.role),'AUTH','인증된 사용자가 아닙니다.',401);
  let c=p.caseId?requireCase(s,p.caseId):null,result={},audit={};
  if(type==='schedule') {
    role(actor,'intake');must(Array.isArray(p.items)&&p.items.length>0&&p.items.length<=50,'INPUT','지급 계획을 확인하세요.',400);
    audit.changes=[];for(const item of p.items){date(item.date);const plan=s.plans[item.id];must(plan&&plan.status==='planned'&&!s.instructions[item.id],'CLOSED','미집행 원본만 지급 계획을 입력할 수 있습니다.');audit.changes.push({paymentId:plan.id,before:plan.plannedDate,after:item.date});plan.plannedDate=item.date;
      if(plan.caseId){const other=s.cases[plan.caseId];other.revision++;hold(s,other,'schedule','지급예정일 변경에 대한 회계 확인 필요');invalidate(s,other,'지급예정일 변경');}}
  } else if(type==='intake') {
    role(actor,'intake');must(Array.isArray(p.paymentIds)&&p.paymentIds.length>0&&p.paymentIds.length<=30&&new Set(p.paymentIds).size===p.paymentIds.length,'INPUT','중복 없는 지급 ID를 선택하세요.',400);
    for(const id of p.paymentIds){const plan=s.plans[id];must(plan&&plan.status==='planned'&&!plan.caseId&&!s.instructions[id],'CLOSED_ID','종료되었거나 이미 접수된 지급 ID입니다.');must(plan.plannedDate,'MONTH','지급예정일을 먼저 입력하세요.');}
    c={id:uid('CASE'),title:redact(p.title||'판매장려금 지급 검토'),creator:actor.id,paymentIds:p.paymentIds,revision:1,version:0,status:'review',docs:[],holds:{},exceptions:{},conflicts:[],confirmations:{},snapshots:[],approvals:[],needsResubmit:true};
    s.cases[c.id]=c;for(const id of c.paymentIds)s.plans[id].caseId=c.id;
    addDocuments(s,c,actor,p.docs??[]);
    const b=basis(s,c);must(b.validScope,'MIXED_SCOPE','같은 관련자 그룹·지급예정월로 분리해 접수하세요.');
    if(p.declaredTotal!==undefined){money(p.declaredTotal);if(p.declaredTotal!==b.total)exception(s,c,'aggregation','제출 합산액과 서버 재계산 불일치');}
    if(p.exception){text(p.exception.reason);must(['conflict','policy','aggregation'].includes(p.exception.kind),'EXCEPTION','예외 종류를 확인하세요.');exception(s,c,p.exception.kind,redact(p.exception.reason));c.conflicts=p.exception.users??[];}
    task(s,c,'initial','reviewer','원본·합산·수취계좌와 명의 증빙 검토');result={caseId:c.id};
  } else if(type==='documents') {
    role(actor,'intake','reviewer','reconciler');mutable(c);c.revision++;addDocuments(s,c,actor,p.docs);
    for(const t of Object.values(s.tasks))if(t.caseId===c.id&&t.owner===actor.role&&t.status==='open'&&!t.key?.startsWith('hold:')){t.status='responded';t.response={docIds:p.docs.map(d=>d.id),actor:actor.id,at:now()};}
  } else if(type==='change') {
    role(actor,'intake');mutable(c);const plan=s.plans[p.paymentId];must(plan&&c.paymentIds.includes(plan.id)&&!s.instructions[plan.id],'ISSUED','이미 지시한 지급 조건은 변경할 수 없습니다.');
    text(p.account,4,100);text(p.owner,1,100);if(p.date)date(p.date);
    const newKey=hash(p.account);must(newKey!==plan.accountKey||p.owner!==plan.owner||p.date&&p.date!==plan.plannedDate,'UNCHANGED','변경된 값이 없습니다.');
    audit.before={accountLabel:plan.accountLabel,owner:plan.owner,date:plan.plannedDate};audit.after={accountLabel:`모의 ****${p.account.slice(-4)}`,owner:p.owner,date:p.date||plan.plannedDate};
    c.revision++;plan.accountKey=newKey;plan.accountLabel=`모의 ****${p.account.slice(-4)}`;plan.owner=p.owner;plan.evidenceAfterRevision=c.revision;if(p.date)plan.plannedDate=p.date;
    delete c.confirmations[plan.id];exception(s,c,'account_change','수취계좌 변경 확인');hold(s,c,'changed','지급 조건 변경에 대한 회계 재검토 필요');invalidate(s,c,'수취계좌 변경으로 기존 승인 무효');
    task(s,c,`supplement:${c.revision}`,'intake','새 수취계좌와 명의 확인 증빙 접수');addDocuments(s,c,actor,p.docs??[]);
  } else if(type==='review') {
    role(actor,'reviewer');mutable(c);text(p.reason);confirmRefs(c,p.docIds);
    audit={docIds:p.docIds,confirmPaymentIds:p.confirmPaymentIds??[],resolveKeys:p.resolveKeys??[]};
    for(const id of p.confirmPaymentIds??[]){must(c.paymentIds.includes(id)&&!s.instructions[id],'PAYMENT','미집행 승인 대상을 확인하세요.');const plan=s.plans[id],a=s.source.agencies.find(a=>a.agency_id===plan.agencyId);
      must(p.docIds.some(docId=>c.docs.some(d=>d.id===docId&&['account','supplement'].includes(d.kind)&&d.revision>=(plan.evidenceAfterRevision||0))),'STALE_EVIDENCE','현재 지급 조건에 적용되는 계좌·명의 증빙 또는 보완 회신을 연결하세요.');
      must(plan.owner===a.agency_name,'OWNER','명의가 다른 지급은 별도 허용 정책 확정 전 보류합니다.');c.confirmations[id]={at:now(),actor:actor.id,accountKey:plan.accountKey,docIds:p.docIds,reason:redact(p.reason)};
      if(c.holds[`evidence:${id}`]&&!c.holds[`evidence:${id}`].closedAt)closeHold(s,c,`evidence:${id}`,actor,p.reason,p.docIds);
    }
    for(const key of p.resolveKeys??[]){must(!key.startsWith('recon:')&&!key.startsWith('conflict:'),'RECON_ROLE','은행 실적 차이는 회계 대사 담당자가 확인해야 합니다.');must(!key.startsWith('evidence:'),'EVIDENCE','지급별 증빙 확인으로 해제하세요.');closeHold(s,c,key,actor,p.reason,p.docIds);}
    c.revision++;for(const t of Object.values(s.tasks))if(t.caseId===c.id&&['open','responded'].includes(t.status)&&!t.key?.startsWith('hold:')&&(t.owner==='reviewer'||!openHolds(c).length))t.status='closed';
  } else if(type==='submit') {
    role(actor,'reviewer');mutable(c);reevaluate(s,c);must(c.canSubmit,'SUBMIT_BLOCKED','미해결 사유·증빙·합산 범위·결재자 배정을 확인하세요.');must(c.needsResubmit,'ALREADY_SUBMITTED','현재 버전은 이미 상신됐습니다.');
    c.version++;c.needsResubmit=false;const b=basis(s,c);c.snapshots.push({version:c.version,revision:c.revision,at:now(),by:actor.id,basis:b,docs:structuredClone(c.docs),confirmations:structuredClone(c.confirmations)});
    for(const r of b.required)c.approvals.push({id:`${c.id}:${c.version}:${r.role}`,version:c.version,role:r.role,userId:r.userId,decision:'pending',createdAt:now()});
  } else if(type==='decide') {
    role(actor,'sales','executive','alternate','finance');mutable(c);version(c,p);reevaluate(s,c);must(!c.needsResubmit&&c.canSubmit,'STALE_BASIS','상신 근거가 유효하지 않습니다.');
    const a=c.approvals.find(a=>a.version===c.version&&a.userId===actor.id);must(a&&actor.id!==c.creator&&!c.conflicts.includes(actor.id),'ASSIGNEE','배정된 독립 승인권자만 결재할 수 있습니다.',403);
    must(['approve','supplement','reject'].includes(p.decision),'DECISION','결재 결정을 확인하세요.',400);text(p.reason);
    if(a.decision!=='pending'){must(a.decision===p.decision,'DECIDED','이미 종료된 결재입니다.');return {caseId:c.id,duplicate:true};}
    a.decision=p.decision;a.reason=redact(p.reason);a.at=now();
    if(p.decision!=='approve'){invalidate(s,c,'결재자가 보완 또는 반려했습니다.');if(p.decision==='reject'){c.status='rejected';for(const id of c.paymentIds)if(!s.instructions[id])s.plans[id].status='rejected';}else hold(s,c,'approval_supplement','결재자 보완 요청에 대한 회계 확인 필요');}
  } else if(type==='cancel') {
    role(actor,'intake');mutable(c);must(c.creator===actor.id&&!c.paymentIds.some(id=>s.instructions[id]),'CANCEL','지급 지시 후 취소할 수 없습니다.');text(p.reason);c.status='cancelled';for(const id of c.paymentIds)s.plans[id].status='cancelled';invalidate(s,c,p.reason);
  } else if(type==='pay') {
    role(actor,'treasury');version(c,p);must(c.paymentIds.includes(p.paymentId),'PAYMENT','이번 승인 대상이 아닙니다.');
    const existing=s.instructions[p.paymentId];if(existing){must(existing.version===p.version,'STALE_VERSION','이미 다른 버전의 지시가 있습니다.');return {instruction:existing,duplicate:true};}
    mutable(c);reevaluate(s,c);
    if(!c.canPay){event(s,c,actor,'pay_blocked',{paymentId:p.paymentId,checks:c.checks});return {denied:true,code:'PAYMENT_BLOCKED',message:'현재 승인 근거·보류 사유를 확인하세요.'};}
    const plan=s.plans[p.paymentId];must(plan.status==='planned','CLOSED_ID','종료된 지급 ID입니다.');
    const ins={id:uid('PAY'),paymentId:plan.id,caseId:c.id,version:c.version,amount:plan.amount,accountKey:plan.accountKey,accountLabel:plan.accountLabel,date:plan.plannedDate,by:actor.id,at:now(),receiptId:null,reconciliation:'awaiting_bank'};
    s.instructions[plan.id]=ins;plan.status='issued';result={instruction:ins};
  } else if(type==='bank') {
    role(actor,'treasury');const ins=Object.values(s.instructions).find(i=>i.id===p.instructionId);must(ins,'INSTRUCTION','지급 지시가 없습니다.');c=s.cases[ins.caseId];
    text(p.receiptId,1,80);date(p.date);money(p.amount);must(['success','failed'].includes(p.outcome),'BANK','성공 또는 확정 실패를 선택하세요.',400);
    must(!['__proto__','constructor','prototype'].includes(p.receiptId),'RECEIPT_ID','사용할 수 없는 회신 ID입니다.',400);
    const accountKey=p.account?hash(p.account):ins.accountKey;
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
  refresh(s);const e=event(s,c,actor,type,{...audit,docIds:p.docs?.map(d=>d.id)??audit.docIds,paymentId:p.paymentId??null,result:result.denied?'denied':'saved',reason:p.reason?redact(p.reason):undefined});
  if(c)queueAI(s,c,e);return {...result,caseId:c?.id??null,eventId:e.id};
}
export function publicState(s,actor) {
  const visible=Object.values(s.cases).filter(c=>actor.role!=='intake'||c.creator===actor.id);
  const ids=new Set(visible.map(c=>c.id));
  const result={epoch:s.epoch,fixture:s.fixture,fixtureVersion:s.fixtureVersion,createdAt:s.createdAt,publicDemo:s.publicDemo??null,source:s.source.sources,
    agencies:s.source.agencies,plans:Object.values(s.plans),cases:visible,tasks:Object.values(s.tasks).filter(t=>ids.has(t.caseId)),notifications:Object.values(s.notifications).filter(n=>ids.has(n.caseId)),
    instructions:Object.values(s.instructions).filter(i=>ids.has(i.caseId)),receipts:Object.values(s.receipts).filter(r=>Object.values(s.instructions).some(i=>ids.has(i.caseId)&&i.id===r.instructionId)),
    jobs:Object.values(s.jobs).filter(j=>ids.has(j.caseId)).map(({docs,...j})=>j),events:s.events.filter(e=>!e.caseId||ids.has(e.caseId)),conflicts:s.conflicts};
  // Account comparison tokens are server-only; values, attachments and diagnostics are masked.
  return JSON.parse(JSON.stringify(result,(key,value)=>key==='accountKey'||key==='passwordHash'?undefined:value));
}
export { refresh, event, task, hold, queueAI };
