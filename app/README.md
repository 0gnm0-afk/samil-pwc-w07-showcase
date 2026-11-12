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

## 역할별 로그인

첫 화면에 **영업지원·회계팀·영업 임원·재무 임원·자금팀**의 5개 시연 역할과 서버 설정에서 확인된 시연용 비밀번호를 표시한다. `node scripts/credentials.mjs`는 역할 비밀번호를 `.local/role-credentials.json`에 생성하고 `hashes.json`에 `role:*` 해시를 추가한다. 비공개 검증·관리 계정은 별도 비밀번호를 사용한다.

비밀번호 확인 성공 후 `trial-*` 작업공간과 2시간 세션을 만든다. 로그아웃하면 인증 세션이 폐기되며 다른 역할도 비밀번호를 확인해야 한다. HttpOnly 작업공간 쿠키는 같은 브라우저의 재로그인 때 자료를 이어 주며 인증 수단으로는 사용할 수 없다. 다른 공간·관리 초기화·실패 주입은 금지한다. `/api/demo/start`, `/api/demo/role`은 410으로 닫고 이전 무로그인 세션도 거부한다. 관리자와 독립 사용자 검증의 비공개 API 로그인은 기존 강한 비밀번호로 유지한다.

회계팀은 검토·상신·대사를 같은 계정에서 처리한다. 영업지원의 접수 담당과 전결 담당은 로그인에서 구분한다. 특별승인은 영업 임원·재무 임원의 동일 버전 결재를 요구한다. 필수 승인자가 이해상충 당사자이면 지급을 보류하고 회계팀 확인에 넘긴다. 시연용 공유 비밀번호는 개인 작업공간에서 역할을 이어가기 위한 값이다.

영업지원은 신규 요청을 직접 입력하거나 UTF-8 CSV로 등록한다. CSV 헤더는 `request_id,agency_id,amount_krw,period_ym,planned_date`다. 접수 목록은 관련자 그룹·지급예정월로 묶여 있고 묶음에서 이번 결재 대상을 선택한다. 나머지 역할은 자기에게 배정된 현재 작업으로 시작한다.

AI 업무 판단과 화면 안내의 공간별·일일 누적 제한은 없다. 두 기능·모든 공간이 SQL 트랜잭션 기반 공통 속도 예약을 사용한다. `W07_NIM_RPM`은 기본 40이며 1~40으로 조정한다. 공급자 429의 Retry-After를 공유하고 업무 판단을 우선 재시도한다. 체험 공간 생성 하루 100개 제한은 유지한다. 생성 24시간이 지난 `trial-*` 자료만 서버 시작 및 시간당 정리한다. 이 정책은 첫 화면에 고지한다.

## 저장·경합

- `w07_workspaces`: 검토·근거·증빙·작업·알림·AI·이력의 일관된 JSONB 집합. 모든 변경은 해당 행의 `SELECT … FOR UPDATE`와 같은 트랜잭션에서 처리한다.
- `w07_instructions`, `w07_approvals`, `w07_receipts`: 지급 ID, 건·버전·역할, 회신 ID 및 지시 ID에 각각 PK/UNIQUE 제약을 둔다. 업무 집합과 같은 트랜잭션에서 반영한다.
- `w07_users`, `w07_sessions`: 서버 해시와 만료 세션. 클라이언트가 보낸 역할 값으로 권한을 주지 않는다.
- 역할 로그인은 서버에서 비밀번호와 담당자 소속을 확인한 뒤 새 세션을 발급한다. 세션 `public_workspace`로 다른 공간 접근을 막고 `w07_public_limits`로 사용 한도를 집계한다.
- `CREATE TABLE IF NOT EXISTS`는 신규 전용 테이블만 준비한다. 재시작 때 업무 상태를 재초기화하지 않는다. 기존 제공 마스터의 월중 관계 변경은 범위 밖이다.
- 검증용 초기화는 `demo` 또는 `qa-*` 작업공간 한 곳에만 적용한다. 원본 파생 시드와 다른 공간은 유지한다.

## NIM

`ai.mjs`는 보류·AI 작업을 먼저 커밋한 다음 NVIDIA 호스팅 API를 호출한다. 결과는 건·입력 변경 번호·허용 조치·담당 역할·인용·범위 검사를 통과해야 작업으로 적용된다. 승인·보류 해제·지급은 NIM이 수행하지 않는다. 이전 입력 응답은 `stale`, 실패는 회계 수동 검토로 남는다. 동일 입력은 재호출하지 않는다. 서버 재시작 중 중단된 호출은 중복 실행하지 않고 수동 확인으로 넘긴다.

### 기능별 업무 모듈과 화면 안내

일반 영업지원 직원과 영업지원팀장(전결)을 로그인·결재 이력·BPMN 레인에서 구분한다. 모든 역할의 작업 목록을 기능별로 묶고, 업무 모듈은 목적·자료·선택/실행·AI 안내 순서로 구성한다. 증빙·사유·은행 회신·전표 금액은 선택형으로 입력하며 기타를 선택하면 직접 작성한다. 검토 저장 후 상신이 가능해지면 상신 모듈이 맨 앞으로 온다.

`npm run build`는 `작업/W07_개선.bpmn`에서 단계·레인·설명·연결·분기 조건을 추출해 `data/workflow.json`을 만든다. Docker에는 이 생성본이 포함된다. `workflow.mjs`는 서버의 실제 상태와 선택한 작업으로 시간순 이력·현재·다음 한 단계를 계산하고 `/api/state`의 `cases[].workflow`, `workflowByWork`로 제공한다. 화면 아래 가로 흐름과 NIM이 같은 값을 사용한다. 특별승인은 같은 버전의 영업·재무 임원 상태를 나란히 표시한다.

인증된 `POST /api/guidance` 요청은 `{moduleId, caseId?, workItemId?, paymentId?, groupId?, stateEventId?, draft?}`다. 응답은 `status`, `contextKey`, `fallback`, 성공 시 `answer`를 포함한다. `answer`에는 검증된 `workflowState`, 현재 설명, 권장 선택지와 근거, 다음 업무 및 추가 확인 사항이 있다. 권장은 해당 입력으로 이동하며 승인·지급을 실행하지 않는다.

서버는 전체 BPMN·업무 규칙·역할별 모듈과 실제 입력 선택지·증빙·결재/지급/대사·AI 보완/회신·저장 전 선택을 제공한다. 원시 계좌 대신 입력 여부와 마스킹된 지급 정보를 사용한다. 현재 사실과 다음 단계 설명은 화면과 같은 서버 계산값으로 구성하며 NIM은 구체적인 권장 이유·근거 참조·추가 확인 사항을 생성한다. 선택지·근거 참조·현재 상태와 충돌하는 주장을 검증하고 업무용 문구로 표시한다. 상태가 바뀐 응답은 폐기하고 입력을 유지한 채 갱신한다.

화면 안내와 업무 판단은 `w07_nim_provider`의 공통 60초 이동 구간을 사용한다. 기존 `W07_GUIDANCE_SPACE_LIMIT`, `W07_GUIDANCE_DAILY_LIMIT`, 공간의 aiLimit/guidanceLimit은 더 이상 호출을 막지 않는다. 사용 횟수는 관측용으로 유지한다. 같은 문맥은 캐시를 재사용하고 동시 요청을 병합한다. 공급자 대기는 waiting/retryAt으로 응답하며 기본 안내를 보여주고 자동 재시도한다. 일반 실패는 기본 안내와 재시도 버튼을 제공한다. 기존 공간은 상태 초기화 없이 읽는다.

```powershell
node --env-file=.env.local scripts/guidance-check.mjs
```

실제 NIM 6개 상황과 로컬 화면 검증 결과는 `작업/실행결과/업무모듈_검증.md`, 원 응답/호출 증거는 `업무모듈_NIM안내.json`에 기록한다.

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
