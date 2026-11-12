const headers = ['request_id', 'agency_id', 'amount_krw', 'period_ym', 'planned_date'];

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
  if (names.length !== headers.length || headers.some(name => !names.includes(name))) {
    throw new Error(`CSV 1행: ${headers.join(',')} 항목이 필요합니다.`);
  }
  return lines.flatMap((line, i) => {
    if (i === 0 || !line.trim()) return [];
    const number = i + 1;
    const cells = splitRow(line, number);
    if (cells.length !== names.length) throw new Error(`CSV ${number}행: 열 수가 맞지 않습니다.`);
    const row = Object.fromEntries(names.map((name, index) => [name, cells[index]]));
    if (!/^\d+$/.test(row.amount_krw)) throw new Error(`CSV ${number}행: 원 단위 정수 금액이 필요합니다.`);
    return [{id:row.request_id,agencyId:row.agency_id,amount:Number(row.amount_krw),period:row.period_ym,plannedDate:row.planned_date,row:number}];
  });
}
