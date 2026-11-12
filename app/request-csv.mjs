const headers = ['request_id', 'agency_id', 'amount_krw', 'period_ym', 'planned_date'];
const evidenceHeaders=['evidence_id','evidence_type','evidence_date','evidence_account_holder','evidence_account_no','evidence_amount_krw','evidence_period_ym','evidence_text'];

function splitRow(line, number) {
  const values = [];
  let rest = line;
  do {
    const field = rest.match(/^(?:"((?:[^"]|"")*)"|([^",]*))(,|$)/);
    if (!field) throw new Error(`CSV ${number}행: 따옴표 또는 구분자를 확인하세요.`);
    values.push((field[1]?.replaceAll('""', '"') ?? field[2]).trim());
    rest = rest.slice(field[0].length);
    if (!field[3]) break;
  } while (true);
  return values;
}

export function readRequestCsv(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('CSV 파일을 선택하세요.');
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  const names = splitRow(lines[0], 1);
  if (new Set(names).size!==names.length || headers.some(name => !names.includes(name)) || names.some(name=>![...headers,...evidenceHeaders].includes(name))) {
    throw new Error(`CSV 1행: ${headers.join(',')} 항목이 필요합니다.`);
  }
  return lines.flatMap((line, i) => {
    if (i === 0 || !line.trim()) return [];
    const number = i + 1;
    const cells = splitRow(line, number);
    if (cells.length !== names.length) throw new Error(`CSV ${number}행: 열 수가 맞지 않습니다.`);
    const row = Object.fromEntries(names.map((name, index) => [name, cells[index]]));
    if (!/^\d+$/.test(row.amount_krw)) throw new Error(`CSV ${number}행: 원 단위 정수 금액이 필요합니다.`);
    const evidence=evidenceHeaders.some(key=>row[key])?{id:row.evidence_id,kind:row.evidence_type||'account',text:row.evidence_text||'CSV에서 제출한 증빙 항목',fields:{requestId:row.request_id,holder:row.evidence_account_holder,account:row.evidence_account_no,date:row.evidence_date,amount:row.evidence_amount_krw,period:row.evidence_period_ym}}:undefined;
    return [{id:row.request_id,agencyId:row.agency_id,amount:Number(row.amount_krw),period:row.period_ym,plannedDate:row.planned_date,row:number,evidence}];
  });
}
