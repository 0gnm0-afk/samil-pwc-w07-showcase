export const scheduleVersion='month-1';
export const scheduleRule='지급예정월은 접수자가 지정하고 지급일은 자금 담당자가 확정합니다.';
export function koreaToday(at=new Date()){return new Date(new Date(at).getTime()+9*3600000).toISOString().slice(0,10);}
export function dataPeriod(payments=[]){return payments.map(p=>p.period_ym).filter(s=>/^\d{4}-(0[1-9]|1[0-2])$/.test(s||'')).sort().at(-1)||'2026-06';}
