# W07 지급 검토 앱 v1.2

단일 Node 24 HTTP 서버와 PostgreSQL로 지급 접수·회계 검토·결재·모의 지급·대사를 처리한다. 실제 송금 및 ERP 연동은 없다. 업무 기준은 프로젝트의 `작업/구현지시서.md` v1.2다.

## 실행

```powershell
cd app
npm ci --ignore-scripts
npm run build
npm test
```

운영에서는 AXHub가 주입한 `DATABASE_URL`, 서버 비밀 `NVIDIA_API_KEY`, `W07_ACCOUNT_HASHES`가 필요하다. `PORT`를 읽고 `0.0.0.0`에서 HTTP로 수신한다. `/healthz`는 로그인과 외부 호출 없이 응답한다. Dockerfile은 잠금파일로 런타임 의존성만 설치한다.

로컬에서는 `W07_LOCAL_DB=memory` 또는 로컬 개발 전용 PGlite 경로를 명시한다. `NODE_ENV=production`에서 로컬 DB 대체는 금지한다. 동일 PGlite 폴더는 여러 프로세스가 동시에 열면 안 된다. 로컬 DB는 AXHub 영속성 증거가 아니다.

```powershell
node scripts/credentials.mjs
pwsh -NoProfile -File scripts/provision-secrets.ps1
$env:W07_LOCAL_DB='memory'
npm run dev
```

계정 비밀번호는 `.local/credentials.json`에만 저장하며 Git·Docker에서 제외한다. 서버는 scrypt 해시만 저장하고, 만료되는 HttpOnly/SameSite 세션을 사용한다. `provision-secrets.ps1 -Register`는 명시 승인된 기존 앱 서버에 NIM 키와 계정 해시를 표준입력으로 등록하며 값을 출력하지 않는다.

## 공개 체험

첫 화면의 **내 체험 공간 시작**은 비밀번호 없이 고유한 `trial-*` 공간과 2시간 서버 세션을 발급한다. 세션에 결합된 공간 외 접근은 거부한다. 화면의 시연 역할 선택으로 업무 역할을 바꿀 수 있지만 관리자 역할·관리 초기화·실패 주입은 허용하지 않는다. 실제 독립 사용자 검증은 별도 계정으로 실행한다.

공간당 NIM 3회, 전체 공개 NIM 하루 60회, 체험 공간 생성 하루 100개를 SQL 트랜잭션으로 제한한다. 한도 초과는 보류를 유지하고 수동 검토 작업을 만든다. 일반 시연·`qa-*` 검증과 공개 체험 한도는 구분된다. 생성 24시간이 지난 `trial-*` 자료만 서버 시작 및 시간당 정리한다. 이 정책은 첫 화면에 고지한다.

## 저장·경합

- `w07_workspaces`: 검토·근거·증빙·작업·알림·AI·이력의 일관된 JSONB 집합. 모든 변경은 해당 행의 `SELECT … FOR UPDATE`와 같은 트랜잭션에서 처리한다.
- `w07_instructions`, `w07_approvals`, `w07_receipts`: 지급 ID, 건·버전·역할, 회신 ID 및 지시 ID에 각각 PK/UNIQUE 제약을 둔다. 업무 집합과 같은 트랜잭션에서 반영한다.
- `w07_users`, `w07_sessions`: 서버 해시와 만료 세션. 클라이언트가 보낸 역할 값으로 권한을 주지 않는다.
- 공개 세션의 역할 전환은 서버가 허용된 시연 역할을 확인한 뒤 세션에 저장한다. 세션 `public_workspace`로 다른 공간 접근을 막고 `w07_public_limits`로 공개 사용 한도를 집계한다.
- `CREATE TABLE IF NOT EXISTS`는 신규 전용 테이블만 준비한다. 재시작 때 업무 상태를 재초기화하지 않는다. 기존 제공 마스터의 월중 관계 변경은 범위 밖이다.
- 검증용 초기화는 `demo` 또는 `qa-*` 작업공간 한 곳에만 적용한다. 원본 파생 시드와 다른 공간은 유지한다.

## NIM

`ai.mjs`는 보류·AI 작업을 먼저 커밋한 다음 NVIDIA 호스팅 API를 호출한다. 결과는 건·입력 변경 번호·허용 조치·담당 역할·인용·범위 검사를 통과해야 작업으로 적용된다. 승인·보류 해제·지급은 NIM이 수행하지 않는다. 이전 입력 응답은 `stale`, 실패는 회계 수동 검토로 남는다. 동일 입력은 재호출하지 않는다. 서버 재시작 중 중단된 호출은 중복 실행하지 않고 수동 확인으로 넘긴다.

## 원본과 검증

`npm run seed`는 프로젝트 제공 CSV 세 개를 읽는다. 필수 헤더·유일 ID·거래처 참조·날짜·원 단위 정수를 검증한다. `data/source.json`은 50/240/32행을 출처·행·원본 해시와 함께 보존한 최소 파생 시드다. 전체 계좌는 비교용 해시와 마스킹 표시로 변환하고 사업자번호는 제외한다.

```powershell
$env:W07_BASE_URL='http://127.0.0.1:8081'
npm run acceptance
node scripts/privacy-check.mjs
```

수용 검증은 매 실행 별도 `qa-*` 공간에서 역할별 새 로그인으로 AC-01~08을 처리한다. 정상·명의 부족·미등록 충돌에는 실제 NIM을 사용한다. 인증/한도/시간초과와 지연은 관리자 전용 검증 공간에서 재현한다. 실패 주입은 일반 `demo`와 일반 계정에서 허용하지 않는다. 결과는 `작업/실행결과/`의 입력·기대·관찰 표와 스냅샷에 저장하며, 실패한 실행도 보존한다.

운영 주소는 `https://app-q1zb.axhub.app`이다. 같은 `W07_BASE_URL`을 운영 주소로 지정하면 `node scripts/remote-check.mjs public`으로 개인 공간 격리·역할·모의 지급을, `reset`으로 검증 공간 초기화와 정상 재실행을 확인한다. `capture`는 `W07_WORKSPACE`로 지정한 완료 qa 공간의 상태 해시를 저장하고, 서버 교체 뒤 `verify`는 새 로그인·인스턴스 변경·동일 해시를 확인한다. 이 검증은 관리 비밀번호가 있는 로컬 환경에서만 실행한다.

매니페스트의 `database.engine: postgres`가 DB 주소를 생성하고 `network.egress`가 NVIDIA HTTPS 호출을 선언한다. NIM은 JSON 응답 모드를 사용하되 인용·범위·담당자·입력 버전 검사를 별도로 수행한다. 실패는 수동 확인으로 넘기며 승인·지급을 자동 실행하지 않는다.

## 주요 파일

| 파일 | 책임 |
| --- | --- |
| `domain.mjs` | DR-01~10, 상태·버전·결재·지급·대사 |
| `store.mjs` | PostgreSQL 트랜잭션·유일성·영속화 |
| `auth.mjs`, `server.mjs` | 로그인·서버 권한·HTTP·작업 실행 |
| `ai.mjs` | NIM 호출·출력 검증·작업 적용 |
| `public/` | 공통 목록·상세·역할별 입력 |
| `test/`, `scripts/acceptance.mjs` | 규칙·SQL·HTTP·실연동 증거 |
