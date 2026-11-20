// 합성 시드 생성기 — 공개 저장소에서 테스트를 실행하기 위한 가짜 데이터입니다.
// 대회 제공 원본 표(source.json)는 공개하지 않으므로, 테스트가 확인하는 "구조"만 같게 만들고
// 거래처명·대표자·주소·계좌·등록일·실적·장려금·지급일·입금 기록은 모두 새로 만든 값입니다.
//
// 테스트가 의존하는 구조
// - 행 수: 대리점 50 · 장려금 지급표 240 · 회수 이력 32
// - 5번째마다 장려금 비대상 거래처, 대상 거래처 40곳 × 6개월(2026-01~06) 지급 행
// - 2026-06 정산분 40건은 미지급, 4건은 반려, 나머지는 승인·지급 완료
// - 관련 거래처 한 묶음: D-011·D-024(대표자+주소 같음), D-011·D-037(대표자+계좌 같음)
// - D-024의 회수 입금 2건(DP-00013·14)은 D-011 계좌에서 들어와 마스터 계좌와 다름
// - 테스트 코드에 이미 적힌 금액 두 개만 그대로 맞춤:
//   RB-00054 = 1,373,515원, RB-00054 + RB-00120 + RB-00180 = 3,888,097원
//
// 실행: node scripts/make-synthetic-seed.mjs  →  data/synthetic-source.json
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const pad = (n, width) => String(n).padStart(width, '0');
// 결정적 의사난수(mulberry32): 다시 생성해도 같은 파일이 나옵니다.
function random(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function makeSyntheticSeed() {
  const rnd = random(20261120), between = (min, max) => min + Math.floor(rnd() * (max - min + 1));
  const day = (year, month, min = 1, max = 28) => `${year}-${pad(month, 2)}-${pad(between(min, max), 2)}`;
  const account = n => `모의은행 900-${pad(n, 2)}-${pad(100000 + n * 7919 % 900000, 6)}`;
  const masked = no => `${no.split(' ')[0]} ****${no.slice(-4)}`;
  const origin = (file, row, id) => ({ file, row, id, kind: 'synthetic' });

  // 대리점 마스터
  const rawAgencies = [];
  for (let n = 1; n <= 50; n++) {
    const id = `D-${pad(n, 3)}`;
    rawAgencies.push({ agency_id: id, agency_name: `합성상사${pad(n, 2)}`, representative_name: `합성대표${pad(n, 2)}`,
      address: `가상시 합성로 ${n * 10}`, bank_account_no: account(n), rebate_eligible: n % 5 === 0 ? 'False' : 'True',
      registered_date: day(2020 + n % 4, 1 + n % 12) });
  }
  const byId = Object.fromEntries(rawAgencies.map(a => [a.agency_id, a]));
  // 관련 거래처 단서: 두 항목 이상이 같으면 같은 묶음으로 봅니다(domain.mjs groups).
  Object.assign(byId['D-024'], { representative_name: byId['D-011'].representative_name, address: byId['D-011'].address });
  Object.assign(byId['D-037'], { representative_name: byId['D-011'].representative_name, bank_account_no: byId['D-011'].bank_account_no });

  // 장려금 지급표: 대상 거래처마다 2026-01~06 여섯 달
  const fixed = { 'RB-00054': 1373515, 'RB-00120': 1214582, 'RB-00180': 1300000 };
  const rejected = new Set(['RB-00083', 'RB-00159', 'RB-00221', 'RB-00236']);
  const payments = [];
  for (const agency of rawAgencies.filter(a => a.rebate_eligible === 'True')) for (let month = 1; month <= 6; month++) {
    const id = `RB-${pad(payments.length + 1, 5)}`, amount = fixed[id] ?? between(30, 160) * 10000;
    const status = month === 6 ? '미지급' : rejected.has(id) ? '반려' : '승인';
    payments.push({ rebate_id: id, agency_id: agency.agency_id, period_ym: `2026-${pad(month, 2)}`,
      sales_performance_krw: String(amount * between(7, 11)), rebate_amount_krw: String(amount), approval_status: status,
      approver: status === '승인' ? '영업지원팀' : 'NONE', payment_date: status === '승인' ? day(2026, month + 1, 2, 12) : 'NONE' });
  }

  // 회수 이력: D-024의 두 건은 관련 거래처(D-011) 계좌에서 입금
  const depositAgencies = ['D-001','D-003','D-007','D-009','D-010','D-011','D-013','D-014','D-015','D-016','D-018','D-020','D-024','D-024','D-026','D-027',
    'D-030','D-033','D-036','D-037','D-038','D-038','D-040','D-040','D-041','D-041','D-042','D-043','D-044','D-045','D-046','D-049'];
  const rawCollections = depositAgencies.map((agencyId, i) => ({ deposit_id: `DP-${pad(i + 1, 5)}`, agency_id: agencyId,
    deposit_date: day(2026, between(1, 6)), amount_krw: String(between(400, 4500) * 10000), matched_ar_id: `AR-S${pad(i + 1, 4)}`,
    bank_account_no: agencyId === 'D-024' ? byId['D-011'].bank_account_no : byId[agencyId].bank_account_no }));

  // 전체 계좌번호는 저장하지 않고 비교용 해시와 마스킹 표시만 남깁니다(import-source.mjs와 같은 방식).
  const safeAccount = ({ bank_account_no, ...rest }) => ({ ...rest, accountKey: hash(bank_account_no), accountLabel: masked(bank_account_no) });
  const table = (file, rows, idKey) => rows.map((row, i) => ({ ...row, source: origin(file, i + 2, row[idKey]) }));
  const agencies = table('synthetic/agencies', rawAgencies, 'agency_id').map(safeAccount);
  const paymentRows = table('synthetic/payments', payments, 'rebate_id');
  const collections = table('synthetic/collections', rawCollections, 'deposit_id').map(safeAccount);
  const describe = (file, rows) => ({ kind: 'synthetic', file, count: rows.length, sha256: hash(JSON.stringify(rows)) });
  return { version: 'synthetic-v1', synthetic: true,
    notice: '공개 저장소 테스트용 합성 데이터입니다. 대회 제공 원본이 아니며 거래처·계좌·금액은 실제 값이 아닙니다.',
    importedAt: '2026-11-20T00:00:00.000Z',
    sources: [describe('synthetic/agencies', agencies), describe('synthetic/payments', paymentRows), describe('synthetic/collections', collections)],
    agencies, payments: paymentRows, collections };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = makeSyntheticSeed();
  writeFileSync(new URL('../data/synthetic-source.json', import.meta.url), JSON.stringify(seed, null, 2) + '\n');
  console.log(JSON.stringify({ version: seed.version, counts: seed.sources.map(s => s.count) }));
}
