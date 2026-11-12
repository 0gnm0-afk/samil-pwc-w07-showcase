export const scheduleVersion='schedule-2';
export const scheduleRule='정산월과 이전 기지급 이력 기준 · 거래처 이력 → 회사 이력 → 익월 세 번째 평일 · 공휴일 미적용';
export function koreaToday(at=new Date()){return new Date(new Date(at).getTime()+9*3600000).toISOString().slice(0,10);}
const monthIndex=s=>Number(s.slice(0,4))*12+Number(s.slice(5,7))-1;
const monthName=n=>`${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;
const validMonth=s=>/^\d{4}-(0[1-9]|1[0-2])$/.test(s||'');
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
function ordinal(date){const d=new Date(date+'T00:00:00Z');let n=0;for(let day=1;day<=d.getUTCDate();day++){if(![0,6].includes(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),day)).getUTCDay()))n++;}return n;}
function nthWeekday(month,n){const d=new Date(month+'-01T00:00:00Z');let last;for(let i=0;d.toISOString().slice(0,7)===month;d.setUTCDate(d.getUTCDate()+1)){if(![0,6].includes(d.getUTCDay())){last=d.toISOString().slice(0,10);if(++i>=n)return last;}}return last;}
const median=items=>{const a=[...items].sort((a,b)=>a-b);return (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2;};
function pattern(rows,period){
  const valid=rows.filter(r=>r.approval_status==='승인'&&validMonth(r.period_ym)&&r.period_ym<period&&validDate(r.payment_date)&&monthIndex(r.payment_date)>monthIndex(r.period_ym));
  const months=[...new Set(valid.map(r=>r.period_ym))].sort().slice(-6);
  // Each settlement month gets one vote; large batches do not overwhelm the pattern.
  const observations=months.map(month=>{const entries=valid.filter(r=>r.period_ym===month);return {month,lag:Math.round(median(entries.map(r=>monthIndex(r.payment_date)-monthIndex(r.period_ym)))),ordinal:Math.ceil(median(entries.map(r=>ordinal(r.payment_date)))),refs:entries.map(r=>r.rebate_id)};});
  if(observations.length<3)return null;
  const counts=new Map();for(const o of observations)counts.set(o.lag,(counts.get(o.lag)||0)+1);
  const [lag,count]=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0];if(count/observations.length<2/3)return null;
  const selected=observations.filter(o=>o.lag===lag);return {lag,ordinal:Math.ceil(median(selected.map(o=>o.ordinal))),months:observations.length,refs:selected.flatMap(o=>o.refs)};
}
export function recommendDate(period,options={}){
  if(!validMonth(period))return {version:scheduleVersion,date:null,source:'rules',reason:'정산월을 YYYY-MM 형식으로 입력하면 지급일을 계산합니다.'};
  if(typeof options!=='object'||!options)options={};
  const history=options.payments||[];
  let p=options.agencyId?pattern(history.filter(r=>r.agency_id===options.agencyId),period):null,level='agency';
  if(!p){p=pattern(history,period);level='company';}if(!p){p={lag:1,ordinal:3,months:0,refs:[]};level='default';}
  const month=monthName(monthIndex(period)+p.lag),date=nthWeekday(month,p.ordinal);
  const origin=level==='agency'?'이 거래처':level==='company'?'회사 전체':'기본 시연 규칙';
  return {version:scheduleVersion,source:'rules',date,month,period,level,historyMonths:p.months,historyRefs:p.refs,monthLag:p.lag,weekdayOrdinal:p.ordinal,
    reason:level==='default'?`${period} 정산분은 일정한 기지급 이력이 부족해 다음 달 세 번째 평일인 ${date}을 추천합니다. 접속일과 관계없는 시연 기준이며 공휴일은 반영하지 않습니다.`:
    `${origin}의 이전 ${p.months}개 정산월 이력에서 ${p.lag}개월 뒤 지급하는 패턴을 확인했습니다. 월 내 평일 순번의 중앙값을 올림한 ${p.ordinal}번째 평일, ${date}을 추천합니다. 공휴일은 반영하지 않는 시연 기준입니다.`};
}
export function dataPeriod(payments=[]){return payments.map(p=>p.period_ym).filter(validMonth).sort().at(-1)||'2026-06';}
