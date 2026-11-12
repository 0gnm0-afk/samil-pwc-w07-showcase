const $ = selector => document.querySelector(selector);
const root = $('#app');
const money = new Intl.NumberFormat('ko-KR');
const won = value => `${money.format(value ?? 0)}원`;
const date = value => new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'});
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul'}).format(new Date());
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles = {
  intake:'영업지원', sales:'영업지원 전결', reviewer:'회계팀', reconciler:'회계팀',
  executive:'영업 임원', alternate:'영업 임원 · 이전 위임', finance:'재무 임원', treasury:'자금팀',
  rules:'서버 검사', nim:'AI 검토 에이전트', admin:'시연 관리자'
};
const labels = {
  review:'증빙 검토·상신', supplement:'보완 회신', approval:'결재', pay:'모의 지급 지시',
  bank:'은행 회신 입력', reconcile:'전표 대사', change:'지급조건 변경',
  held:'지급보류', approval_pending:'결재 대기', payable:'지급 가능', completed:'처리 완료',
  rejected:'반려', cancelled:'취소', awaiting_bank:'회신·대사 대기', reconciliation_hold:'대사 확인',
  pending:'승인 대기', approve:'승인', reject:'반려', closed:'종료', difference:'차이 확인',
  request_supplement:'자료 보완 요청', request_review:'회계 확인', hold_for_review:'지급보류 · 회계 확인',
  recheck:'새 근거 재검사', ai_result:'AI 검토 결과', ai_stale:'이전 입력의 AI 응답', flag:'추가 판단 의뢰',
  approval_route_updated:'승인 경로 재검토', intake:'접수', documents:'증빙 접수', submit:'결재 상신',
  decide:'결재 결정', pay_blocked:'지급 차단', confirmActual:'지급 실적 확인'
};

let user, state, roleCatalog, preferredRole = 'sales';
let view = {kind:'inbox'};
let busy = false, loading = false, dirty = false;
let workspace = new URL(location.href).searchParams.get('workspace') || '';
const has = permission => user.capabilities.includes(permission);
const caseFor = id => state.cases.find(c => c.id === id);
const planFor = id => state.plans.find(p => p.id === id);
const workFor = id => state.workItems.find(item => item.id === id);
const taskFor = id => state.tasks.find(task => task.id === id);
const badge = key => `<span class="pill ${esc(key)}">${esc(labels[key] || key)}</span>`;

async function api(path, payload) {
  const url = new URL(path, location.origin);
  if (workspace) url.searchParams.set('workspace', workspace);
  const options = payload === undefined ? {} : {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)
  };
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(Error(body.message || '요청을 처리할 수 없습니다.'), {status:response.status});
  return body;
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.style.display = 'none', 5500);
}

function listen(id, action) {
  const element = $(`#${id}`);
  if (element) element.onclick = action;
}

function form(id, action) {
  const element = $(`#${id}`);
  if (element) element.onsubmit = event => {
    event.preventDefault();
    Promise.resolve(action(new FormData(element))).catch(error => toast(error.message));
  };
}

function show(next = {kind:'inbox'}) {
  view = next;
  dirty = false;
  render();
  window.scrollTo(0, 0);
}

async function load() {
  if (loading) return;
  loading = true;
  try {
    const result = await api('/api/state');
    user = result.user;
    workspace = result.workspace;
    state = result.state;
    dirty = false;
    render();
  } catch (error) {
    if (error.status === 401) {
      user = null;
      await loginView();
    } else {
      root.innerHTML = `<div class="loading"><p>${esc(error.message)}</p><button id="reload">다시 불러오기</button></div>`;
      listen('reload', load);
    }
  } finally {
    loading = false;
  }
}

async function run(type, payload, onSaved) {
  if (busy) return;
  busy = true;
  const enabled = [...document.querySelectorAll('main button:not(:disabled)')];
  for (const button of enabled) button.disabled = true;
  try {
    const result = await api('/api/command', {type,payload});
    const updated = await api('/api/state');
    state = updated.state;
    if (onSaved) view = onSaved(result);
    else if (view.kind === 'task' && !workFor(view.item.id)) {
      const next = ['review','reconcile','confirmActual','documents'].includes(type)
        ? state.workItems.find(w => w.caseId === result.caseId && w.kind === view.item.kind && w.paymentId === view.item.paymentId)
        : null;
      view = next ? {kind:'task',item:next} : {kind:'done',item:view.item,action:type};
    }
    dirty = false;
    render();
    toast(type === 'registerRequests'
      ? `신규 ${result.registered.length}건 등록 · 기존 ${result.existing.length}건 확인`
      : '저장했습니다.');
  } catch (error) {
    for (const button of enabled) button.disabled = false;
    toast(error.message);
  } finally {
    busy = false;
  }
}

async function loginView() {
  try { roleCatalog ??= await api('/api/roles'); }
  catch (error) {
    root.innerHTML = `<div class="loading"><p>${esc(error.message)}</p><button id="reload">다시 불러오기</button></div>`;
    listen('reload', loginView);
    return;
  }
  const codes = roleCatalog.filter(role => role.demoPassword);
  root.innerHTML = `
    <header class="global-bar"><div class="brand">COREVIA<span>판매장려금 지급 관리</span></div><span class="environment">모의 업무 환경</span></header>
    <div class="product-rail"><div class="breadcrumb">Corevia / 재무 업무 / 판매장려금</div><div class="tabs"><span class="active">역할별 로그인</span></div></div>
    <main class="login-shell">
      <section class="login-story">
        <h1>판매장려금 지급 관리</h1>
        <p>요청 접수부터 검토, 승인, 모의 지급과 대사까지 역할별로 체험합니다.</p>
        ${codes.length ? `<section class="demo-codes"><h2>시연용 비밀번호</h2><dl>${codes.map(r => `<div><dt>${esc(r.name)}</dt><dd>${esc(r.demoPassword)}</dd></div>`).join('')}</dl></section>` : ''}
      </section>
      <section class="login-form"><div class="entry"><h2>업무 로그인</h2>
        <form id="login" class="stack">
          <label>담당 역할<select name="roleId" id="loginRole">${roleCatalog.map(r => `<option value="${esc(r.id)}" ${r.id === preferredRole ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
          <p id="roleDescription" class="role-description"></p>
          <label id="memberLabel">담당자<select id="loginMember" name="member"></select></label>
          <label>역할 비밀번호<input name="password" type="password" autocomplete="current-password" inputmode="numeric" required></label>
          <p id="loginError" class="error" role="alert"></p><button class="primary" type="submit">로그인</button>
        </form>
        <p class="meta">같은 브라우저에서 다른 역할로 로그인하면 작업을 이어갈 수 있습니다.</p>
      </div></section>
    </main><footer class="site-footer">가상기업 자료 · 모의 지급 · 개인 작업공간 2시간</footer>`;
  function updateMember() {
    preferredRole = $('#loginRole').value;
    const role = roleCatalog.find(r => r.id === preferredRole);
    $('#roleDescription').textContent = role.description;
    $('#loginMember').innerHTML = role.members.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('#memberLabel').hidden = role.members.length === 1;
  }
  $('#loginRole').onchange = updateMember;
  updateMember();
  form('login', async fields => {
    const button = $('#login button');
    button.disabled = true;
    $('#loginError').textContent = '';
    try {
      const result = await api('/api/login', Object.fromEntries(fields));
      workspace = result.workspace;
      view = {kind:'inbox'};
      history.replaceState(null, '', '/');
      await load();
    } catch (error) {
      $('#loginError').textContent = error.message;
      button.disabled = false;
    }
  });
}

function shell(title, content, toolbar = '') {
  root.innerHTML = `<div class="layout">
    <header class="global-bar"><div class="brand">COREVIA<span>판매장려금 지급 관리</span></div>
      <div class="user"><strong>${esc(user.name)}</strong><button id="logout">로그아웃</button></div>
    </header>
    <div class="product-rail"><div class="breadcrumb">Corevia / 재무 업무 / 판매장려금</div>
      <nav class="tabs" aria-label="업무 탐색"><button id="inboxTab" class="${view.kind === 'inbox' ? 'active' : ''}">내 작업</button>
      ${view.kind !== 'inbox' ? `<span class="active">${esc(title)}</span>` : ''}<span class="rail-note">모의 업무 환경</span></nav>
    </div>
    <main class="main"><div class="headline"><h1>${esc(title)}</h1><div class="row">${toolbar}<button id="refresh">새로고침</button></div></div>${content}</main>
    <footer class="site-footer"><span>가상기업 자료 · 모의 은행 회신과 전표</span>
      ${state.publicDemo ? `<span>AI 사용 ${state.publicDemo.aiUsed}/${state.publicDemo.aiLimit} · ${date(state.publicDemo.expiresAt)}까지</span>` : ''}</footer>
  </div>`;
  listen('inboxTab', () => show());
  listen('refresh', load);
  listen('logout', async () => {
    try {
      await api('/api/logout', {});
      preferredRole = user.role;
      user = state = null;
      workspace = '';
      history.replaceState(null, '', '/');
      await loginView();
    } catch (error) { toast(error.message); }
  });
}

function itemName(item) {
  const task = taskFor(item.taskId);
  if (task?.jobId) return labels[task.action] || 'AI 후속 확인';
  if (task?.responseTo) return '보완 회신 검토';
  if (item.kind === 'approval' && caseFor(item.caseId).currentBasis.required.length === 2) return '특별승인';
  return labels[item.kind];
}

function inbox() {
  const rows = state.workItems.map(item => {
    const c = caseFor(item.caseId);
    return `<tr><td><button class="link-button" data-work="${esc(item.id)}">${esc(itemName(item))}</button></td>
      <td>${esc(c.title)}${item.paymentId ? `<small>${esc(item.paymentId)}</small>` : ''}</td>
      <td>${badge(c.status)}</td></tr>`;
  }).join('');
  const list = rows ? `<section class="panel"><h2>처리할 작업</h2><div class="table-wrap"><table><thead><tr><th>내 작업</th><th>요청</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
    : `<p class="empty">현재 배정된 후속 작업이 없습니다.</p>`;
  shell('내 작업', list + (has('intake') ? intakeQueue() : ''), has('intake')
    ? '<button id="direct" class="primary">새 요청 직접 입력</button><button id="csv">CSV 등록</button>' : '');
  for (const button of document.querySelectorAll('[data-work]')) button.onclick = () => show({kind:'task',item:workFor(button.dataset.work)});
  for (const button of document.querySelectorAll('[data-group]')) button.onclick = () => show({kind:'intake',id:button.dataset.group});
  for (const button of document.querySelectorAll('[data-change]')) button.onclick = () => show({kind:'task',item:{kind:'change',caseId:button.dataset.change}});
  listen('direct', () => show({kind:'direct'}));
  listen('csv', () => show({kind:'csv'}));
}

function intakeQueue() {
  const batches = state.intakeGroups;
  const batchRows = values => values.map(g => `<tr><td><button class="link-button" data-group="${esc(g.id)}">${esc(g.members.join(' · '))}</button></td>
    <td>${esc(g.month || '미정')}</td><td>${g.paymentIds.length}건</td><td>${g.month ? won(g.total) : '예정일 지정 필요'}</td></tr>`).join('');
  const table = values => `<div class="table-wrap"><table><thead><tr><th>관련자 그룹</th><th>지급예정월</th><th>미접수</th><th>월 합산액</th></tr></thead><tbody>${batchRows(values)}</tbody></table></div>`;
  const scheduled = batches.filter(g => g.month), unscheduled = batches.filter(g => !g.month);
  const amendable = state.cases.filter(c => !['completed','rejected','cancelled'].includes(c.status)
    && c.paymentIds.some(id => !state.instructions.some(i => i.paymentId === id)));
  return `<section class="panel"><h2>접수할 지급 요청</h2>
    ${scheduled.length ? table(scheduled) : '<p class="empty">지급예정일이 지정된 미접수 요청이 없습니다.</p>'}
    ${unscheduled.length ? `<details><summary>지급예정일 미정 묶음 ${unscheduled.length}개</summary>${table(unscheduled)}</details>` : ''}
  </section>${amendable.length ? `<details><summary>접수한 요청의 지급조건 변경</summary>
    <ul class="compact-list">${amendable.map(c => `<li><button class="link-button" data-change="${esc(c.id)}">${esc(c.title)}</button></li>`).join('')}</ul></details>` : ''}`;
}

function registerView(channel) {
  const currentDate = today();
  const options = state.agencies.map(a => `<option value="${esc(a.agency_id)}">${esc(a.agency_id)} · ${esc(a.agency_name)}</option>`).join('');
  const example = 'request_id,agency_id,amount_krw,period_ym,planned_date\n'
    + `NEW-001,${state.agencies[0].agency_id},100000,${currentDate.slice(0,7)},${currentDate}\n`;
  const content = channel === 'direct' ? `<form id="registration" class="panel stack">
    <div class="field-grid"><label>요청 ID<input name="id" value="REQ-${crypto.randomUUID()}" required maxlength="80"></label>
    <label>거래처<select name="agencyId" required><option value="">선택하세요</option>${options}</select></label>
    <label>원 단위 금액<input name="amount" type="number" min="1" step="1" required></label>
    <label>정산월<input name="period" type="month" value="${currentDate.slice(0,7)}" required></label>
    <label>지급예정일<input name="plannedDate" type="date" value="${currentDate}" required></label></div>
    <button class="primary" type="submit">요청 등록</button></form>`
    : `<form id="registration" class="panel stack"><p>UTF-8 CSV 파일로 최대 50건을 등록합니다.</p>
      <a download="w07-requests.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF'+example)}">CSV 양식 내려받기</a>
      <label>요청 파일<input name="csv" type="file" accept=".csv,text/csv" required></label>
      <button class="primary" type="submit">CSV 요청 등록</button></form>`;
  shell(channel === 'direct' ? '새 지급 요청 등록' : 'CSV 지급 요청 등록', content);
  form('registration', async fields => {
    const payload = channel === 'direct'
      ? {rows:[{...Object.fromEntries(fields),amount:Number(fields.get('amount'))}]}
      : {csv:{text:await fields.get('csv').text()}};
    return run('registerRequests', payload, () => ({kind:'inbox'}));
  });
}

function docFields(defaultKind = 'account') {
  return `<div class="field-grid"><label>증빙 ID<input name="docId" value="DOC-${crypto.randomUUID().slice(0,8)}" required maxlength="80"></label>
    <label>증빙 유형<select name="kind">${[['account','수취계좌·명의 근거'],['narrative','서술형 증빙'],['supplement','보완 회신'],['bank','은행 회신 근거'],['voucher','전표 근거']]
      .map(([value,label]) => `<option value="${value}" ${value === defaultKind ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <label>증빙 본문<textarea name="text" required maxlength="12000" placeholder="확인한 내용과 자료의 근거를 입력하세요."></textarea></label>`;
}
const docsFrom = fields => [{id:fields.get('docId'),kind:fields.get('kind'),text:fields.get('text')}];

function intakeView() {
  const group = state.intakeGroups.find(g => g.id === view.id);
  if (!group) return show();
  const selected = view.paymentIds || [];
  const rows = group.paymentIds.map(planFor).map(p => `<tr><td><label class="checkbox"><input type="checkbox" name="paymentIds" value="${esc(p.id)}" ${selected.includes(p.id) ? 'checked' : ''}>${esc(p.id)}</label></td>
    <td>${esc(p.agencyId)}</td><td>${esc(p.period)}</td><td>${esc(p.plannedDate || '미정')}</td><td>${won(p.amount)}</td></tr>`).join('');
  const fields = group.month ? `<label>요청 제목<input name="title" required value="${esc(group.month)} 판매장려금 지급 검토"></label>${docFields()}
    <div class="field-grid"><label>신고·확인 사항<select name="exception"><option value="">없음</option><option value="conflict">영업 임원 이해상충</option>
    <option value="policy">정책 예외</option><option value="aggregation">합산 예외</option><option value="uncertain">기타 판단 필요</option></select></label>
    <label>사유<input name="exceptionReason" maxlength="4000"></label></div>`
    : `<label>선택한 요청의 지급예정일<input name="plannedDate" type="date" required value="${today()}"></label>`;
  shell('묶음에서 지급 요청 선택', `<section class="panel"><h2>${esc(group.members.join(' · '))} · ${esc(group.month || '지급예정일 미정')}</h2>
    <form id="intake" class="stack"><div class="table-wrap"><table><thead><tr><th>이번 결재 대상</th><th>거래처</th><th>정산월</th><th>지급예정일</th><th>금액</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="decision-band"><strong>선택 금액 <output id="selectionTotal">0원</output></strong><strong>관련자 월 합산액 ${group.month ? won(group.total) : '예정일 지정 후 계산'}</strong></div>
      ${group.missing.length ? `<p class="meta">같은 그룹에 예정일 미정 ${group.missing.length}건이 있습니다. 상신 전에 해당 요청의 예정일을 확인하세요.</p>` : ''}
      ${fields}<button class="primary" type="submit">${group.month ? '선택한 요청 접수' : '예정일 저장'}</button></form></section>`);
  const update = () => {
    const ids = new FormData($('#intake')).getAll('paymentIds');
    $('#selectionTotal').textContent = won(ids.reduce((total,id) => total + planFor(id).amount, 0));
  };
  $('#intake').onchange = update;
  update();
  form('intake', fields => {
    const paymentIds = fields.getAll('paymentIds');
    if (!paymentIds.length) return toast('묶음에서 요청을 선택하세요.');
    if (!group.month) {
      const items = paymentIds.map(id => ({id,date:fields.get('plannedDate')}));
      return run('schedule',{items,unassignedOnly:true},() => ({
        kind:'intake',id:state.intakeGroups.find(g => g.paymentIds.includes(paymentIds[0]))?.id,paymentIds
      }));
    }
    const kind = fields.get('exception');
    const exception = kind ? {kind,reason:fields.get('exceptionReason')} : undefined;
    return run('intake',{paymentIds,title:fields.get('title'),docs:docsFrom(fields),exception},result => ({
      kind:'done',item:{kind:'intake',caseId:result.caseId}
    }));
  });
}

function aiCard(task) {
  if (!task) return '';
  const heading = task.jobId ? 'AI 검토 에이전트 · NVIDIA NIM' : '연결된 작업';
  return `<section class="decision-band ai-card"><h3>${heading}</h3><p>${esc(task.reason)}</p>
    ${task.escalation ? '<p><strong>상위 판단 필요 · 지급보류</strong></p>' : ''}
    ${(task.citations || []).map(f => `<blockquote>${esc(f.quote)} <cite>${esc(f.docId)}</cite></blockquote>`).join('')}
    ${task.unknowns?.length ? `<ul>${task.unknowns.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</section>`;
}

function approvalSummary(c) {
  const required = c.currentBasis.required;
  const label = required.length === 2 ? '같은 버전의 영업 임원·재무 임원 승인 모두 필요' : '현재 승인 경로';
  const records = c.needsResubmit ? [] : c.approvals.filter(a => a.version === c.version);
  return `<div class="decision-band"><strong>${label}</strong><ul class="compact-list">
    ${required.map(r => `<li>${esc(roles[r.userId])} · ${badge(records.find(a => a.userId === r.userId)?.decision || 'pending')}</li>`).join('')}</ul></div>`;
}

function caseFacts(c) {
  const b = c.currentBasis;
  return `<p class="meta">${esc(b.month)} · 검토 v${c.version} · ${badge(c.status)}</p>
    <div class="decision-band"><strong>이번 결재 ${won(b.selectedTotal)}</strong><strong>관련자 월 합산 ${won(b.total)}</strong></div>
    <p>관련 거래처 ${esc(b.members.join(' · '))}</p>
    <details><summary>지급 요청과 합산 근거</summary>
      <ul class="compact-list">${b.rows.map(r => `<li>${esc(r.id)} · ${won(r.amount)} · ${esc(r.date)}${c.paymentIds.includes(r.id) ? ' · 이번 결재 대상' : ''}</li>`).join('')}</ul>
      ${b.edges.map(e => `<p class="meta">${esc(e.from)} ↔ ${esc(e.to)} · ${esc(e.fields.map(f => ({representative_name:'대표자',address:'주소',accountKey:'정산계좌'}[f])).join('·'))} 일치</p>`).join('')}
    </details>`;
}

function reviewForm(c) {
  const holds = Object.values(c.holds).filter(h => !h.closedAt);
  const pending = c.paymentIds.map(planFor).filter(p => !state.instructions.some(i => i.paymentId === p.id));
  const openChecks = holds.filter(h => h.owner === 'reviewer' && h.key !== 'assignee' && !h.key.startsWith('evidence:'));
  const docs = c.docs.map(d => `<label class="checkbox"><input type="checkbox" name="docIds" value="${esc(d.id)}">${esc(d.id)} · ${esc(d.kind)}</label>
    <details><summary>증빙 보기</summary><p class="doc">${esc(d.text)}</p></details>`).join('');
  return `${c.canSubmit && c.needsResubmit ? '<button id="submit" class="primary">현재 검토 버전 상신</button>' : ''}
    <form id="review" class="stack">
      <fieldset><legend>확인한 수취계좌와 명의</legend>${pending.map(p => `<label class="checkbox"><input type="checkbox" name="confirmPaymentIds" value="${esc(p.id)}">
        ${esc(p.id)} · ${esc(p.accountLabel)} · ${esc(p.owner)}${c.confirmations[p.id] ? ' (확인 기록 있음)' : ''}</label>`).join('')}</fieldset>
      ${holds.length ? `<fieldset><legend>남은 보류 사유</legend>
        ${holds.filter(h => !openChecks.includes(h)).map(h => `<p class="meta">${esc(h.reason)}</p>`).join('')}
        ${openChecks.map(h => `<label class="checkbox"><input type="checkbox" name="resolveKeys" value="${esc(h.key)}">${esc(h.reason)} 확인 완료</label>`).join('')}</fieldset>` : ''}
      <fieldset><legend>확인에 사용한 증빙</legend>${docs || '<p>증빙 추가가 필요합니다.</p>'}</fieldset>
      <label>확인 사실과 사유<textarea name="reason" required></textarea></label>
      <label class="checkbox"><input type="checkbox" name="special">정책 예외로 확인하여 특별승인 적용</label>
      <button class="primary" type="submit">검토 저장</button>
    </form>
    <details><summary>추가 판단이 필요한 사유 등록</summary><form id="flag" class="stack">
      <label>확인이 필요한 사유<textarea name="reason" required></textarea></label>
      <label class="checkbox"><input type="checkbox" name="conflict">영업 임원의 이해상충 확인</label>
      <button type="submit">지급보류 · AI 검토 의뢰</button></form></details>
    <details><summary>증빙 추가</summary><form id="documents" class="stack">${docFields()}<button type="submit">증빙 저장</button></form></details>`;
}

function approvalForm(c) {
  return `${approvalSummary(c)}<form id="decide" class="stack">
    <div class="field-grid"><label>결재 결정<select name="decision"><option value="approve">승인</option><option value="supplement">보완 요청</option><option value="reject">반려</option></select></label>
    <label>판단 사유<textarea name="reason" required></textarea></label></div>
    <button class="primary" type="submit">결재 저장</button></form>
    ${caseFacts(c)}
    ${Object.values(c.exceptions).map(e => `<p>특별승인 사유 · ${esc(e.reason)}</p>`).join('')}
    <details><summary>상신 증빙</summary>${(c.snapshots.at(-1)?.docs || []).map(d => `<p class="doc"><strong>${esc(d.id)}</strong> · ${esc(d.text)}</p>`).join('')}</details>`;
}

function changeForm(c) {
  const pending = c.paymentIds.map(planFor).filter(p => !state.instructions.some(i => i.paymentId === p.id));
  return `<form id="change" class="stack"><div class="field-grid">
    <label>지급 요청<select name="paymentId">${pending.map(p => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.owner)}</option>`).join('')}</select></label>
    <label>변경 수취계좌<input name="account" minlength="4" maxlength="100" required></label>
    <label>수취 명의<input name="owner" value="${esc(pending[0]?.owner)}" required></label>
    <label>변경 지급예정일 (선택)<input name="date" type="date"></label></div>
    ${docFields('narrative')}<button type="submit" class="primary">변경 저장 · 지급보류</button></form>`;
}

function paymentForm(item, c) {
  const p = planFor(item.paymentId);
  const instruction = state.instructions.find(i => i.id === item.instructionId);
  const details = `<p class="decision-band"><strong>${esc(p.id)} · ${won(instruction?.amount ?? p.amount)}</strong>
    <span>${esc(instruction?.accountLabel ?? p.accountLabel)} · ${esc(instruction?.date ?? p.plannedDate)}</span></p>`;
  if (item.kind === 'pay') return `${details}<button id="pay" class="primary">현재 승인 버전으로 지급 지시</button>${approvalSummary(c)}`;
  if (item.kind === 'bank') return `${details}<form id="bank" class="stack"><div class="field-grid">
    <label>모의 회신 ID<input name="receiptId" value="BANK-${crypto.randomUUID().slice(0,8)}" required></label>
    <label>은행 결과<select name="outcome"><option value="success">성공</option><option value="failed">확정 실패</option></select></label>
    <label>회신 처리일<input name="date" type="date" value="${esc(instruction.date)}" required></label>
    <label>회신 금액<input name="amount" type="number" min="0" step="1" value="${instruction.amount}" required></label>
    <label>다른 수취계좌 (차이 있을 때)<input name="account"></label></div>
    <button class="primary" type="submit">은행 회신 저장</button></form>`;
  const receipt = state.receipts.find(r => r.id === instruction.receiptId);
  const actual = instruction.reconciliation === 'difference' && instruction.vouchers?.length;
  return `${details}<p>은행 회신 ${won(receipt.amount)} · ${esc(receipt.date)} · ${esc(receipt.accountLabel)}</p>
    <form id="reconcile" class="stack"><div class="field-grid"><label>모의 전표 ID<input name="voucherId" value="VOUCHER-${crypto.randomUUID().slice(0,8)}" required></label>
    <label>전표 금액<input name="amount" type="number" min="0" step="1" value="${receipt.amount}" required></label></div><button class="primary" type="submit">전표 입력·대사</button></form>
    ${actual ? `<details open><summary>차이 확인 및 실제 지급액 기록</summary><form id="confirmActual" class="stack"><div class="field-grid">
      <label>확인 금액<input type="number" min="0" step="1" name="amount" value="${receipt.amount}" required></label>
      <label>실제 처리일<input name="date" type="date" value="${esc(receipt.date)}" required></label>
      <label>확인 근거<select name="docId">${c.docs.map(d => `<option value="${esc(d.id)}">${esc(d.id)}</option>`).join('')}</select></label>
      <label>확인 사유<textarea name="reason" required></textarea></label></div><button type="submit">차이 확인 저장</button></form></details>` : ''}
    <details><summary>대사 근거 추가</summary><form id="documents" class="stack">${docFields('voucher')}<button type="submit">증빙 저장</button></form></details>`;
}

function immediateStep(c, item, done) {
  if (c.status === 'rejected') return '반려 · 종료';
  if (c.status === 'completed') return '처리 완료';
  const related = state.tasks.filter(t => t.caseId === c.id && t.status === 'open'
    && (!t.jobId || state.jobs.some(j => j.id === t.jobId && j.revision === c.revision)));
  if (item.kind === 'supplement') return '회계팀 · 보완 회신 검토';
  if (c.checks?.eligible === false) return '회계팀 · 지급보류와 상위 판단 확인';
  if (item.kind === 'review' || item.kind === 'intake' || item.kind === 'change') {
    if (c.canSubmit) return c.currentBasis.required.length === 2
      ? '특별승인 · 영업 임원과 재무 임원에게 동시에 인계'
      : `${roles[c.currentBasis.required[0]?.userId]} · 일반 결재`;
    if (related.some(t => t.owner === 'intake' && t.action === 'request_supplement')) return '영업지원 · 자료 보완';
    return '회계팀 · 증빙과 보류 사유 확인';
  }
  if (item.kind === 'approval') {
    if (c.status === 'held') return '회계팀 · 결재 보완 사유 확인';
    if (done && c.status === 'approval_pending') {
      const remaining = c.approvals.find(a => a.version === c.version && a.decision === 'pending');
      if (remaining) return `${roles[remaining.userId]} · 같은 버전 결재 대기`;
    }
    return '자금팀 · 같은 버전의 필수 승인이 모두 완료되면 지급';
  }
  if (item.kind === 'pay') return '자금팀 · 은행 회신 입력';
  if (item.kind === 'bank') {
    const instruction = state.instructions.find(i => i.id === item.instructionId);
    return instruction?.reconciliation === 'failed' ? '확정 지급 실패 기록' : '회계팀 · 은행 회신과 전표 대사';
  }
  if (!done) return '회계팀 · 대사 결과 기록';
  return '대사 기록 저장 · 남은 요청 확인';
}

function historyPanel(c, item, done) {
  const events = state.events.filter(e => e.caseId === c.id).reverse();
  const row = e => `<li><strong>${esc(labels[e.type] || e.type)}</strong> · ${esc(roles[e.actor] || e.actor)}
    ${e.detail?.decision ? `· ${esc(labels[e.detail.decision])}` : ''} · v${e.version}
    <small>${date(e.at)}${e.detail?.reason ? ` · ${esc(e.detail.reason)}` : ''}</small></li>`;
  const linked = state.tasks.filter(t => t.caseId === c.id && t.jobId && t.id !== item.taskId
    && (t.response || state.jobs.some(j => j.id === t.jobId && j.revision === c.revision)));
  const pending = state.jobs.find(j => j.caseId === c.id && j.revision === c.revision && ['pending','running'].includes(j.status));
  return `<section class="panel history-panel"><h2>처리 기록</h2><ol class="compact-list">${events.slice(0,6).map(row).join('')}</ol>
    ${events.length > 6 ? `<details><summary>이전 기록 ${events.length - 6}건</summary><ol class="compact-list">${events.slice(6).map(row).join('')}</ol></details>` : ''}
    <div class="decision-band"><strong>다음 단계</strong><span>${esc(immediateStep(c,item,done))}</span></div>
    ${pending ? '<p class="meta">AI 검토 에이전트가 현재 입력을 확인 중입니다.</p>' : ''}
    ${linked.map(t => `<div class="linked-task"><p><strong>${esc(roles[t.owner])} · ${esc(t.status === 'responded' ? '회신 접수' : 'AI 후속 작업')}</strong></p>${aiCard(t)}</div>`).join('')}</section>`;
}

function workDetail(item, done) {
  const c = caseFor(item.caseId);
  if (!c) return show();
  const task = taskFor(item.taskId);
  let content = '';
  if (done) content = `<p class="decision-band">${badge(c.status)} <strong>처리 결과가 저장되었습니다.</strong></p>`;
  else if (item.kind === 'review') content = aiCard(task) + reviewForm(c) + approvalSummary(c) + caseFacts(c);
  else if (item.kind === 'approval') content = approvalForm(c);
  else if (item.kind === 'supplement') content = aiCard(task) + `<form id="supplement" class="stack">${docFields('supplement')}<button type="submit" class="primary">보완 회신 보내기</button></form>`;
  else if (item.kind === 'change') content = changeForm(c);
  else content = paymentForm(item,c);

  shell(done ? '처리 결과' : itemName(item), `<section class="panel work-panel"><h2>${esc(c.title)}</h2>${content}</section>${historyPanel(c,item,done)}`);
  if (done) return;
  form('review', f => run('review',{caseId:c.id,taskId:item.taskId,reason:f.get('reason'),docIds:f.getAll('docIds'),
    confirmPaymentIds:f.getAll('confirmPaymentIds'),resolveKeys:f.getAll('resolveKeys'),special:f.has('special')}));
  form('flag', f => run('flag',{caseId:c.id,reason:f.get('reason'),conflict:f.has('conflict')}));
  form('documents', f => run('documents',{caseId:c.id,docs:docsFrom(f)}));
  form('supplement', f => run('documents',{caseId:c.id,taskId:item.taskId,docs:docsFrom(f)}));
  form('decide', f => run('decide',{caseId:c.id,version:c.version,decision:f.get('decision'),reason:f.get('reason')}));
  form('change', f => run('change',{caseId:c.id,paymentId:f.get('paymentId'),account:f.get('account'),owner:f.get('owner'),date:f.get('date') || undefined,docs:docsFrom(f)}));
  listen('submit', () => run('submit',{caseId:c.id}));
  listen('pay', () => run('pay',{caseId:c.id,paymentId:item.paymentId,version:c.version}));
  form('bank', f => run('bank',{...Object.fromEntries(f),amount:Number(f.get('amount')),instructionId:item.instructionId}));
  form('reconcile', f => run('reconcile',{instructionId:item.instructionId,voucherId:f.get('voucherId'),amount:Number(f.get('amount'))}));
  form('confirmActual', f => run('confirmActual',{instructionId:item.instructionId,amount:Number(f.get('amount')),date:f.get('date'),reason:f.get('reason'),docIds:[f.get('docId')]}));
  const target = $('#change select[name=paymentId]');
  if (target) target.onchange = () => $('#change input[name=owner]').value = planFor(target.value).owner;
}

function render() {
  if (view.kind === 'intake') return intakeView();
  if (['direct','csv'].includes(view.kind)) return registerView(view.kind);
  if (view.kind === 'done') return workDetail(view.item,true);
  if (view.kind === 'task') {
    if (view.item.kind === 'change') return workDetail(view.item,false);
    const item = workFor(view.item.id);
    if (item) return workDetail(item,false);
    return workDetail(view.item,true);
  }
  inbox();
}

for (const type of ['input','change']) root.addEventListener(type,event => {
  if (event.target.closest('main form')) dirty = true;
});
await load();
setInterval(() => {
  if (!user || dirty || busy || document.querySelector('main form :focus')) return;
  if (state.jobs.some(j => ['pending','running'].includes(j.status))) void load();
}, 3000);
