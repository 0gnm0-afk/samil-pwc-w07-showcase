import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../01_참가자_배포용/04_원본데이터/01_corevia/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export function parseCSV(text, required, id, source) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = lines.shift().split('|');
  if (required.some(h => !headers.includes(h)) || new Set(headers).size !== headers.length) throw Error(`${source}: 필수 헤더 오류`);
  const seen = new Set();
  return lines.map((line, i) => {
    const values = line.split('|');
    if (values.length !== headers.length) throw Error(`${source}:${i + 2} 열 수 오류`);
    const row = Object.fromEntries(headers.map((h, j) => [h, values[j].trim()]));
    if (!row[id] || row[id] === 'NONE' || seen.has(row[id])) throw Error(`${source}:${i + 2} ID 중복/누락`);
    seen.add(row[id]);
    for (const [key, value] of Object.entries(row)) {
      if (key.endsWith('_krw') && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw Error(`${source}:${i + 2} ${key} 원 단위 정수 필요`);
      if (key.endsWith('_date') && value !== 'NONE' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw Error(`${source}:${i + 2} ${key} 날짜 오류`);
    }
    return {...row, source: {file: source, row: i + 2, id: row[id], kind: 'original'}};
  });
}
function read(path, required, id) {
  const text = readFileSync(root + path, 'utf8');
  return {rows: parseCSV(text, required, id, path), sha256: hash(text), file: path};
}
export function makeSeed() {
  const agency = read('master/m_agency_cv.csv', ['agency_id','agency_name','representative_name','address','bank_account_no'], 'agency_id');
  const payments = read('sales/sales_rebate_payment_cv.csv', ['rebate_id','agency_id','rebate_amount_krw','period_ym','approval_status','payment_date'], 'rebate_id');
  const collections = read('financials/fin_collection_history_cv.csv', ['deposit_id','agency_id','amount_krw','deposit_date','bank_account_no'], 'deposit_id');
  const ids = new Set(agency.rows.map(r => r.agency_id));
  for (const row of [...payments.rows, ...collections.rows]) if (!ids.has(row.agency_id)) throw Error(`${row.source.file}:${row.source.row} 거래처 참조 오류`);
  const safeAccount = r => {
    const {bank_account_no, business_reg_no, ...rest} = r;
    return {...rest, accountKey: bank_account_no && bank_account_no !== 'NONE' ? hash(bank_account_no) : null,
      accountLabel: bank_account_no === 'NONE' ? 'NONE' : `${bank_account_no.split(' ')[0]} ****${bank_account_no.slice(-4)}`};
  };
  return {version:'source-v1.2', importedAt: new Date().toISOString(), sources:[agency,payments,collections].map(({rows,...s})=>({...s,count:rows.length})),
    agencies: agency.rows.map(safeAccount), payments:payments.rows, collections:collections.rows.map(safeAccount)};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = makeSeed(); mkdirSync(new URL('../data/',import.meta.url),{recursive:true});
  writeFileSync(new URL('../data/source.json',import.meta.url), JSON.stringify(seed,null,2));
  console.log(JSON.stringify({sources:seed.sources, representative:seed.payments.filter(p=>['RB-00054','RB-00120','RB-00180'].includes(p.rebate_id))}));
}
