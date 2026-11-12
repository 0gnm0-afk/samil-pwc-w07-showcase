import {assessSource} from './source-data.mjs';
import {createHash} from 'node:crypto';
export const evidenceVersion='evidence-1';
const digest=value=>createHash('sha256').update(value).digest('hex');
const aliases={requestId:['request_id','요청 ID','요청ID'],holder:['account_holder','수취 명의','예금주','명의'],account:['account_no','계좌','계좌번호','수취계좌'],date:['document_date','증빙작성일','작성일','발급일'],amount:['amount_krw','금액'],period:['period_ym','정산월'],outcome:['outcome','처리결과']};
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
export function normalizeEvidence(input,{redact,paymentIds,revision,at,by}){
  const fields={},locations={},issues=[];
  const lines=input.text.split(/\r?\n/);
  for(const [key,names] of Object.entries(aliases)){
    const matches=[];
    if(input.fields?.[key]!==undefined&&String(input.fields[key]).trim())matches.push({value:String(input.fields[key]).trim(),location:`필드 ${key}`});
    lines.forEach((line,i)=>{const m=line.match(/^\s*([^:=：]+)\s*[:=：]\s*(.*?)\s*$/);if(m&&names.includes(m[1].trim())&&m[2])matches.push({value:m[2].trim(),location:`본문 ${i+1}행`});});
    const values=[...new Set(matches.map(m=>m.value))];
    if(values.length>1)issues.push(`${key}: 같은 항목에 서로 다른 값이 있습니다.`);
    if(values.length){fields[key]=values[0];locations[key]=matches.map(m=>m.location);}
  }
  if(fields.date&&!validDate(fields.date))issues.push('date: 작성일 형식을 확인하세요.');
  if(fields.amount){const number=fields.amount.replaceAll(',','').replace(/원$/,'').trim();if(!/^\d+$/.test(number)||!Number.isSafeInteger(Number(number)))issues.push('amount: 원 단위 금액을 확인하세요.');else fields.amount=Number(number);}
  let text=lines.map(line=>{const m=line.match(/^(\s*[^:=：]+\s*[:=：]\s*)(.*?)\s*$/);return m&&aliases.account.includes(m[1].replace(/[:=：].*$/,'').trim())?m[1]+`****${m[2].slice(-4)}`:line;}).join('\n');
  if(fields.account){
    const original=fields.account;fields.accountKey=digest(original);fields.accountLabel=`****${original.slice(-4)}`;
    text=text.replaceAll(original,fields.accountLabel);delete fields.account;
  }
  for(const key of ['holder','requestId','period','outcome'])if(fields[key])fields[key]=redact(fields[key]);
  return {id:input.id,kind:input.kind,title:redact(input.title||input.filename||'제출 증빙'),text:redact(text),
    source:input.filename?'text_upload':'submitted',filename:input.filename?redact(input.filename):undefined,
    paymentIds:[...paymentIds],at,by,revision,extraction:{version:evidenceVersion,fields,locations,issues}};
}
export function assessEvidence(s,c){
  if(c.reviewMode==='source-1')return assessSource(s,c);
  const plans=c.paymentIds.map(id=>s.plans[id]).filter(p=>!s.instructions[p.id]);
  const payments=plans.map(p=>{
    const proof=c.docs.filter(d=>['account','supplement'].includes(d.kind)&&(!d.paymentIds||d.paymentIds.includes(p.id)));
    const current=proof.filter(d=>d.revision>=(p.evidenceAfterRevision||0));
    const latest=Math.max(-1,...current.filter(d=>d.extraction).map(d=>d.revision));
    const candidates=current.filter(d=>d.extraction&&d.revision===latest);
    const checks=[];
    const add=(code,status,message,docId,field)=>checks.push({code,status,message,docId,field});
    if(!candidates.length)add(proof.length&&!current.length?'stale':'missing','unknown',proof.length&&!current.length?'계좌 변경 이후에 유효한 증빙이 필요합니다.':'대상 요청의 계좌·명의·작성일을 추출할 수 있는 증빙이 필요합니다.');
    for(const d of candidates){
      const f=d.extraction.fields;
      if(d.extraction.issues.length)add('extract','unknown',d.extraction.issues.join(' '),d.id);
      for(const [key,label] of [['holder','수취 명의'],['accountKey','수취계좌'],['date','작성일']]){
        if(!f[key])add(`missing_${key==='accountKey'?'account':key}`,'unknown',`${label} 항목을 확인할 수 없습니다.`,d.id,key==='accountKey'?'accountLabel':key);
      }
      if(f.requestId)add('target',f.requestId===p.id?'pass':'fail','증빙의 요청 ID와 대상 지급 요청을 대조합니다.',d.id,'requestId');
      if(f.holder)add('holder',f.holder===p.owner&&p.owner===s.source.agencies.find(a=>a.agency_id===p.agencyId)?.agency_name?'pass':'fail','증빙 명의·지급 수취 명의·거래처 명의를 대조합니다.',d.id,'holder');
      if(f.accountKey)add('account',f.accountKey===p.accountKey?'pass':'fail','전체 계좌 식별값을 등록 수취계좌와 대조합니다.',d.id,'accountLabel');
      if(f.date)add('date',validDate(f.date)&&f.date<=today()&&(!p.evidenceAfterDate||f.date>=p.evidenceAfterDate)?'pass':'fail','작성일과 계좌 변경 이후의 적용 시점을 확인합니다.',d.id,'date');
      if(f.amount!==undefined)add('amount',f.amount===p.amount?'pass':'fail','증빙에 기재된 금액과 요청 금액을 대조합니다.',d.id,'amount');
      if(f.period)add('period',f.period===p.period?'pass':'fail','증빙 정산월과 요청 정산월을 대조합니다.',d.id,'period');
    }
    const status=checks.some(k=>k.status==='fail')?'conflict':checks.some(k=>k.status==='unknown')?'unknown':'pass';
    const prior=c.confirmations[p.id];
    const manual=!!prior&&prior.actor!=='rules'&&prior.accountKey===p.accountKey&&candidates.every(d=>prior.docIds.includes(d.id))&&status!=='conflict';
    return {paymentId:p.id,status:manual?'manual':status,docIds:candidates.map(d=>d.id),checks,expected:{holder:p.owner,accountLabel:p.accountLabel,amount:p.amount,period:p.period},manual};
  });
  return {version:evidenceVersion,revision:c.revision,status:payments.every(p=>['pass','manual'].includes(p.status))?'pass':'exception',payments,
    explanation:'원문에서 추출한 항목을 현재 지급 조건과 비교한 결과입니다. 마스터 정보만으로 증빙을 생성하거나, 빈 항목을 추정해 채우지 않습니다.'};
}
export function assessSettlement(s,c,paymentId,kind){
  const i=Object.values(s.instructions).find(i=>i.caseId===c.id&&(!paymentId||i.paymentId===paymentId));
  if(!i)return null;
  const receipt=s.receipts[i.receiptId],expected=kind==='bank'?i:receipt;
  const docs=c.docs.filter(d=>d.kind===kind&&(!d.paymentIds||d.paymentIds.includes(i.paymentId)));
  const doc=docs.at(-1),f=doc?.extraction?.fields||{},checks=[];
  if(c.reviewMode==='source-1'&&!doc){
    const values=kind==='bank'?{amount:i.amount,date:i.date,outcome:'success'}:{amount:receipt?.amount};
    const difference=kind==='voucher'&&(i.actualUnresolved||i.conflict||i.vouchers?.at(-1)?.amount!==undefined&&i.vouchers.at(-1).amount!==receipt?.amount);
    return {kind,paymentId:i.paymentId,source:'simulation',fields:values,checks:[{status:difference?'fail':'pass',message:difference?'지급 지시·은행 회신·전표 사이의 실제 차이를 확인해야 합니다.':'현재 지급 지시·은행 회신의 값으로 모의 초안을 구성했습니다. 실제 처리 결과는 담당자가 입력하고 저장합니다.'}],status:difference?'exception':'pass'};
  }
  if(!doc)checks.push({status:'unknown',message:kind==='bank'?'은행 회신 원자료가 아직 없습니다.':'전표 원자료가 아직 없습니다.'});
  for(const field of kind==='bank'?['amount','date','outcome']:['amount']){
    if(f[field]===undefined)checks.push({status:'unknown',field,message:`${field} 항목을 확인할 수 없습니다.`});
    else checks.push({status:(field==='outcome'?f[field]==='success':f[field]===expected?.[field])?'pass':'fail',field,message:`제출 ${field} 항목과 ${kind==='bank'?'지급 지시':'은행 회신'}를 대조합니다.`,docId:doc.id});
  }
  if(f.accountKey)checks.push({status:f.accountKey===expected?.accountKey?'pass':'fail',field:'accountLabel',message:'제출 계좌와 지급 지시 계좌를 대조합니다.',docId:doc.id});
  if(doc?.extraction?.issues.length)checks.push({status:'unknown',message:doc.extraction.issues.join(' '),docId:doc.id});
  return {kind,paymentId:i.paymentId,docId:doc?.id,fields:Object.fromEntries(Object.entries(f).filter(([k])=>k!=='accountKey')),checks,status:checks.every(c=>c.status==='pass')?'pass':'exception'};
}
