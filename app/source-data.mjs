import {createHash} from 'node:crypto';
import {sourceTables} from './public/source-schema.js';
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const safe=value=>JSON.parse(JSON.stringify(value,(key,v)=>['accountKey','passwordHash','registrationFingerprint'].includes(key)?undefined:v));
const fail=(ok,message)=>{if(!ok)throw Error(message);};
const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const missing=v=>v===undefined||v===null||v===''||v==='NONE';
const rowValue=row=>Object.fromEntries(Object.entries(row||{}).filter(([key])=>!['source','revision'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
function split(line,delimiter){const cells=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){cells.push(value.trim());value='';}else value+=c;}fail(!quoted,'닫히지 않은 따옴표가 있습니다.');cells.push(value.trim());return cells;}
function parseFile(file){
 const def=sourceTables[file.table];fail(def,'자료 종류를 선택하세요.');
 if(file.rows){fail(Array.isArray(file.rows)&&file.rows.length>0&&file.rows.length<=500,'직접 입력은 1~500행이어야 합니다.');return file.rows.map((row,index)=>({row,index:index+1}));}
 fail(typeof file.text==='string'&&file.text.trim(),'CSV 파일을 선택하세요.');
 const lines=file.text.replace(/^\uFEFF/,'').split(/\r?\n/),delimiter=lines[0].includes('|')?'|':',';
 const headers=split(lines.shift(),delimiter),allowed=[...def.fields.map(([key])=>key),...(file.table==='agencies'?['business_reg_no']:[])];
 fail(new Set(headers).size===headers.length&&def.fields.every(([key])=>headers.includes(key))&&headers.every(k=>allowed.includes(k)),`${def.label}의 원본 열 이름을 확인하세요.`);
 const rows=lines.flatMap((line,index)=>{if(!line.trim())return [];const cells=split(line,delimiter);fail(cells.length===headers.length,`${index+2}행의 열 수가 맞지 않습니다.`);return [{row:Object.fromEntries(headers.map((key,i)=>[key,cells[i]])),index:index+2}];});
 fail(rows.length>0&&rows.length<=500,'CSV 파일은 1~500행이어야 합니다.');return rows;
}
function normalize(table,input,prior){
 const def=sourceTables[table],allowed=def.fields.map(([key])=>key);
 fail(input&&typeof input==='object'&&!Array.isArray(input),'행 형식을 확인하세요.');
 fail(Object.keys(input).every(k=>allowed.includes(k)||table==='agencies'&&k==='business_reg_no'),'지원하지 않는 열이 있습니다.');
 const row={};for(const key of allowed){const raw=input[key];fail(raw===undefined||['string','number'].includes(typeof raw),'문자 또는 숫자로 입력하세요.');row[key]=String(raw??'NONE').trim()||'NONE';fail(row[key].length<=500,`${key}는 500자 이하여야 합니다.`);}
 const id=row[def.id];fail(/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id)&&!['NONE','constructor','prototype','__proto__'].includes(id),'ID는 영문·숫자·하이픈·밑줄로 입력하세요.');
 for(const [key,value] of Object.entries(row)){
  if(key.endsWith('_krw')&&!missing(value))fail(/^\d+$/.test(value)&&Number.isSafeInteger(Number(value)),`${key}는 0 이상의 원 단위 정수여야 합니다.`);
  if(key.endsWith('_date')&&!missing(value))fail(validDate(value),`${key} 날짜를 YYYY-MM-DD로 입력하세요.`);
 }
 if(table==='agencies'){fail(!missing(row.agency_name),'거래처명을 입력하세요.');fail(['True','False'].includes(row.rebate_eligible),'지급 대상은 True 또는 False를 선택하세요.');}
 if(table==='payments'){fail(/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period_ym),'정산월을 YYYY-MM로 입력하세요.');fail(!missing(row.rebate_amount_krw)&&Number(row.rebate_amount_krw)>0,'장려금은 0원보다 큰 정수여야 합니다.');fail(['미지급','승인','반려'].includes(row.approval_status),'원본 상태를 확인하세요.');fail(row.approval_status==='승인'||missing(row.payment_date),'미지급·반려 행에 실제 지급일을 넣을 수 없습니다.');}
 if(table==='collections')fail(!missing(row.deposit_date)&&!missing(row.amount_krw),'입금일과 입금액을 입력하세요.');
 if(allowed.includes('bank_account_no')){
  if(!Object.hasOwn(input,'bank_account_no')&&prior){row.accountKey=prior.accountKey;row.accountLabel=prior.accountLabel;}
  else {row.accountKey=missing(row.bank_account_no)?null:digest(row.bank_account_no);row.accountLabel=missing(row.bank_account_no)?'미등록':`****${row.bank_account_no.slice(-4)}`;}
  delete row.bank_account_no;
 }
 return row;
}
export function prepareSource(s,input){
 fail(input&&Array.isArray(input.files)&&input.files.length>0&&input.files.length<=3,'세 표 중 등록할 자료를 선택하세요.');
 fail(Buffer.byteLength(JSON.stringify(input))<=1024*1024,'입력 전체는 1MB 이하여야 합니다.');
 const rows=[],errors=[],seen=new Set(),projected=structuredClone(s.source);
 for(const file of input.files){try{for(const entry of parseFile(file)){try{
  const key=sourceTables[file.table].id,id=String(entry.row[key]||'').trim(),prior=projected[file.table].find(r=>r[key]===id);
  fail(!seen.has(`${file.table}:${id}`),'같은 요청 안에 동일한 행 ID가 있습니다.');seen.add(`${file.table}:${id}`);
  const after=normalize(file.table,entry.row,prior),kind=!prior?'new':digest({...rowValue(prior),accountLabel:undefined})===digest({...rowValue(after),accountLabel:undefined})?'same':'changed';
  if(file.table==='payments'&&kind==='changed'){
   const p=s.plans[id];fail(!p||!s.instructions[id]&&!['historical','paid','issued','failed','cancelled','rejected'].includes(p.status),'집행·종료된 지급 건의 원본을 덮어쓸 수 없습니다.');
   fail(after.approval_status===prior.approval_status,'기존 지급 행의 결재·지급 상태는 원본 정정으로 변경할 수 없습니다.');
  }
  if(file.table==='payments'&&kind==='new')fail(!Object.hasOwn(s.plans,id),'이미 등록된 지급 요청 ID입니다.');
  rows.push({table:file.table,id,row:entry.index,filename:file.filename||'화면 직접 입력',kind,before:prior||null,after});
  const index=projected[file.table].findIndex(r=>r[key]===id);if(index<0)projected[file.table].push(after);else projected[file.table][index]=after;
 }catch(e){errors.push({table:file.table,row:entry.index,message:e.message});}}}catch(e){errors.push({table:file.table,row:1,message:e.message});}}
 for(const item of rows.filter(r=>r.table!=='agencies'))if(!projected.agencies.some(a=>a.agency_id===item.after.agency_id))errors.push({table:item.table,row:item.row,message:'대리점 마스터에 없는 거래처입니다. 마스터를 함께 등록하세요.'});
 const changed=rows.filter(r=>r.kind!=='same'),agencies=new Set(changed.map(r=>r.table==='agencies'?r.id:r.after.agency_id));
 const affectedCases=Object.values(s.cases).filter(c=>!['completed','rejected','cancelled'].includes(c.status)&&c.paymentIds.some(id=>agencies.has(s.plans[id].agencyId))).map(c=>c.id);
 const revision=s.sourceRevision||0,previewHash=digest({epoch:s.epoch,revision,event:s.events.at(-1)?.id,rows:rows.map(r=>({table:r.table,id:r.id,kind:r.kind,after:r.after}))});
 return {rows,projected,errors,affectedCases,sourceRevision:revision,previewHash};
}
export function sourcePreview(s,input){const result=prepareSource(s,input);return safe({...result,projected:undefined,canApply:!result.errors.length,counts:{new:result.rows.filter(r=>r.kind==='new').length,same:result.rows.filter(r=>r.kind==='same').length,changed:result.rows.filter(r=>r.kind==='changed').length}});}
export function sourceRecords(s,paymentIds){
 const ids=new Set(paymentIds),plans=paymentIds.map(id=>s.plans[id]).filter(Boolean),agencyIds=new Set(plans.map(p=>p.agencyId));
 const records=[];
 for(const [table,rows] of Object.entries({agencies:s.source.agencies.filter(a=>agencyIds.has(a.agency_id)),payments:s.source.payments.filter(p=>ids.has(p.rebate_id)),collections:s.source.collections.filter(r=>agencyIds.has(r.agency_id))}))for(const row of rows){
  const id=row[sourceTables[table].id],fields=safe(rowValue(row)),version=row.revision||1,ref=`SRC-${table}-${id}-${version}`;
  records.push({id:ref,kind:'source',source:'source_table',title:`${sourceTables[table].label} · ${id}`,table,rowId:id,fields,version,origin:row.source||{kind:'original',id},
   paymentIds:plans.filter(p=>p.agencyId===row.agency_id&&(table!=='payments'||p.id===id)).map(p=>p.id),
   text:Object.entries(fields).map(([key,value])=>`${sourceTables[table].fields.find(([f])=>f===key)?.[1]||({accountLabel:'계좌(마스킹)'})[key]||key}: ${value}`).join('\n')});
 }
 return records;
}
export function assessSource(s,c){
 const records=sourceRecords(s,c.paymentIds),payments=c.paymentIds.filter(id=>!s.instructions[id]).map(id=>{
  const p=s.plans[id],agency=s.source.agencies.find(a=>a.agency_id===p.agencyId),row=s.source.payments.find(r=>r.rebate_id===id),docs=records.filter(r=>r.paymentIds.includes(id)),checks=[];
  const ref=table=>docs.find(r=>r.table===table)?.id;
  const add=(code,status,message,docId,field)=>checks.push({code,status,message,docId,field});
  add('agency',agency?'pass':'fail',agency?'지급 요청과 대리점 마스터의 거래처 ID가 연결되었습니다.':'연결할 대리점 등록정보가 없습니다.',ref('agencies'),'agency_id');
  if(agency){
   add('eligible',agency.rebate_eligible==='True'?'pass':'fail',agency.rebate_eligible==='True'?'장려금 지급 대상 거래처로 등록되어 있습니다.':'장려금 지급 대상이 아닌 거래처입니다. 등록정보와 지급 근거를 확인해야 합니다.',ref('agencies'),'rebate_eligible');
   add('owner',p.owner===agency.agency_name?'pass':'fail','요청 수취 명의와 등록된 거래처명을 비교했습니다.',ref('agencies'),'agency_name');
   add('account',!agency.accountKey?'unknown':p.accountKey===agency.accountKey?'pass':'fail',!agency.accountKey?'등록계좌가 비어 있어 지급에 사용할 계좌를 확인할 수 없습니다.':p.accountKey===agency.accountKey?'요청 수취계좌가 현재 마스터 등록계좌와 일치합니다.':'요청 수취계좌와 현재 마스터 등록계좌가 다릅니다. 변경 내역을 확인하세요.',ref('agencies'),'accountLabel');
   if(missing(agency.representative_name)||missing(agency.address))add('group_data','unknown','대표자 또는 주소가 비어 있어 관련자 연결을 충분히 확인할 수 없습니다.',ref('agencies'));
  }
  add('request',row?'pass':'unknown',row?'요청 ID로 장려금 지급표의 원본 행을 연결했습니다.':'연결된 지급표 행이 없습니다. 요청 데이터를 등록해야 합니다.',ref('payments'),'rebate_id');
  if(row){add('amount',Number(row.rebate_amount_krw)===p.amount?'pass':'fail','원본 장려금과 이번 요청 금액을 비교했습니다. 지급률 산식은 제공되지 않아 별도 추정하지 않습니다.',ref('payments'),'rebate_amount_krw');add('period',row.period_ym===p.period?'pass':'fail','원본 정산월과 이번 요청의 정산월을 비교했습니다.',ref('payments'),'period_ym');}
  const collections=s.source.collections.filter(r=>r.agency_id===p.agencyId),different=collections.filter(r=>r.accountKey&&agency?.accountKey&&r.accountKey!==agency.accountKey);
  if(!collections.length)add('collection_info','pass','연결된 회수 이력은 없습니다. 회수 이력은 참고자료이므로 이 사유만으로 접수를 막지 않습니다.');
  for(const r of different)add('collection_account','unknown',`입금 기록 ${r.deposit_id}의 계좌와 마스터 등록계좌가 다릅니다. 입금과 지급은 다른 거래이므로 오류로 단정하지 않고 차이의 사유를 확인합니다.`,docs.find(d=>d.table==='collections'&&d.rowId===r.deposit_id)?.id,'accountLabel');
  const signature=digest({plan:{id:p.id,amount:p.amount,period:p.period,account:p.accountKey,owner:p.owner},rows:docs.map(d=>({id:d.id,fields:d.fields}))});
  const status=checks.some(k=>k.status==='fail')?'conflict':checks.some(k=>k.status==='unknown')?'unknown':'pass',prior=c.confirmations[id];
  const manual=!!prior&&prior.actor!=='rules'&&prior.sourceSignature===signature&&status==='unknown';
  return {paymentId:id,status:manual?'manual':status,manual,sourceSignature:signature,docIds:docs.map(d=>d.id),checks,expected:{holder:p.owner,accountLabel:p.accountLabel,amount:p.amount,period:p.period}};
 });
 return {version:'source-review-1',revision:c.revision,sourceRevision:s.sourceRevision||0,status:payments.every(p=>['pass','manual'].includes(p.status))?'pass':'exception',payments,records,
  explanation:'대리점 마스터·장려금 지급표·회수 이력에서 연결한 값을 검토했습니다. 회수 이력은 입금 참고자료이며 별도 확인서 제출은 필요하지 않습니다. 원본 금액과 규정에 따른 검토 범위만 확인합니다.'};
}
