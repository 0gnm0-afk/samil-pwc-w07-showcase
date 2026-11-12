export const scheduleVersion = 'schedule-1';
export const scheduleRule = '오늘과 정산월 말일 중 늦은 날부터 3영업일 후 · 월~금, 공휴일 미적용';
export function koreaToday(at = new Date()) {
  return new Date(new Date(at).getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
export function recommendDate(period, today = koreaToday()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '') || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return {version:scheduleVersion, date:null, reason:'정산월을 올바르게 입력하면 지급예정일을 추천합니다.', source:'rules'};
  }
  const end = new Date(`${period}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth()+1, 0);
  const monthEnd = end.toISOString().slice(0,10), baseDate = today > monthEnd ? today : monthEnd;
  const cursor = new Date(`${baseDate}T00:00:00Z`);
  for (let days=0; days<3;) { cursor.setUTCDate(cursor.getUTCDate()+1); if (![0,6].includes(cursor.getUTCDay())) days++; }
  return {version:scheduleVersion, source:'rules', date:cursor.toISOString().slice(0,10), baseDate, today, monthEnd,
    reason:`오늘(${today})과 정산월 말일(${monthEnd}) 중 늦은 ${baseDate}부터 3영업일을 계산했습니다. 검토·승인 시간을 확보하는 시연용 기준이며, 주말은 제외하고 공휴일은 별도로 반영하지 않습니다.`};
}
