import {sourceHTML,mountSource} from './source-ui.js';
import {intakeBoard,mountIntake} from './schedule-ui.js';
import { moduleHTML, mountGuidance, clearGuidance } from './guidance-ui.js';
import { roleNames, modules, approvalFocus, reasonChoices } from './catalog.js';
import {documentCards,assessmentHTML,documentFields,readDocuments,mountEvidenceForms} from './evidence-ui.js';
const $ = selector => document.querySelector(selector);
const root = $('#app');
const money = new Intl.NumberFormat('ko-KR');
const won = value => `${money.format(value ?? 0)}원`;
const date = value => new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'});
const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul'}).format(new Date());
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roles = {
  ...roleNames,
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
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({...payload,...(state?{epoch:state.epoch}:{})})
  };
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(Error(body.message || '요청을 처리할 수 없습니다.'), {status:response.status,code:body.code});
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
  if(dirty&&!confirm('저장하지 않은 입력을 버리고 다른 작업으로 이동할까요?'))return;
  clearGuidance();
  view = next;
  dirty = false;
  render();
  window.scrollTo({top:0,behavior:'instant'});
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
    window.scrollTo({top:0,behavior:'instant'});
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
    const result = await api('/api/command', {type,payload,epoch:state.epoch});
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
    if(error.code==='STALE_WORKSPACE')await load();
    if(type==='schedule')document.getElementById('dateForm')?.dispatchEvent(new Event('input',{bubbles:true}));
  } finally {
    busy = false;
  }
}

async function loginView() {
  clearGuidance();
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
  window.scrollTo({top:0,behavior:'instant'});
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
  clearGuidance();
  root.innerHTML = `<div class="layout">
    <header class="global-bar"><div class="brand">COREVIA<span>판매장려금 지급 관리</span></div>
      <div class="user"><strong>${esc(user.name)}</strong><button id="logout">로그아웃</button></div>
    </header>
    <div class="product-rail"><div class="breadcrumb">Corevia / 재무 업무 / 판매장려금</div>
      <nav class="tabs" aria-label="업무 탐색"><button id="inboxTab" data-action="open" class="${view.kind === 'inbox' ? 'active' : ''}">내 작업</button>
      ${view.kind !== 'inbox' ? `<span class="active">${esc(title)}</span>` : ''}<span class="rail-note">모의 업무 환경</span></nav>
    </div>
    <main class="main"><div class="headline"><h1>${esc(title)}</h1><div class="row">${toolbar}<button id="refresh">새로고침</button></div></div>${content}</main>
    <footer class="site-footer"><span>가상기업 자료 · 모의 은행 회신과 전표</span>
      ${state.publicDemo ? `<span>AI 누적 횟수 제한 없음 · NVIDIA 속도 제한 시 자동 대기 · ${date(state.publicDemo.expiresAt)}까지</span>` : ''}</footer>
  </div>`;
  listen('inboxTab', () => show());
  listen('refresh', () => {if(!dirty||confirm('저장하지 않은 입력을 버리고 새로고침할까요?'))void load();});
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
  queueMicrotask(prepareModules);
}

function prepareModules() {
  mountModuleNavigation();
  mountEvidenceForms(toast);
  for(const block of document.querySelectorAll('[data-reason]')) {
    const select=block.querySelector('[name="reasonChoice"]');
    const textarea=block.querySelector('textarea');
    const update=()=>{const choice=(reasonChoices[block.dataset.reason]||[]).find(c=>c[0]===select.value);textarea.value=choice?.[2]||'';textarea.readOnly=!!choice;textarea.hidden=select.value!=='other';block.querySelector('.reason-preview').textContent=choice?.[2]||'';};
    select.addEventListener('change',update);update();
  }
  const decision=document.querySelector('[name="decision"]');
  if(decision)decision.addEventListener('change',()=>{
    const holder=document.querySelector('[data-decision-reason]');
    holder.innerHTML=reasonFields(decision.value);
    const block=holder.querySelector('[data-reason]'), select=block.querySelector('select'),textarea=block.querySelector('textarea');
    select.onchange=()=>{const choice=reasonChoices[decision.value].find(c=>c[0]===select.value);textarea.value=choice?.[2]||'';textarea.hidden=select.value!=='other';textarea.readOnly=!!choice;block.querySelector('.reason-preview').textContent=choice?.[2]||'';};
    document.querySelector('#decide button').dataset.action=decision.value;
    document.querySelector('[data-decision-effect]').textContent=modules.approval.actions.find(a=>a[0]===decision.value)[2];
  });
  const actionByForm={"documents":"documents","registration":"registerRequests","intake":"intake","supplement":"documents","change":"change","bank":"bank","reconcile":"reconcile","confirmActual":"confirmActual"};
  for(const [id,action] of Object.entries(actionByForm))for(const button of document.querySelectorAll('#'+id+' button[type=submit]'))button.dataset.action ||= action;
  const payButton=document.getElementById('pay');if(payButton)payButton.dataset.action='pay';
  const strip=document.querySelector('.workflow-strip');
  const current=strip?.querySelector('[data-current]');
  if(current)strip.scrollLeft=Math.max(0,current.offsetLeft-8);
  mountGuidance({api,getContext:()=>{
    const caseId=view.item?.caseId;
    const c=caseFor(caseId);
    return {caseId,groupId:view.kind==='intake'?view.id:view.inlineId,paymentId:view.item?.paymentId,workItemId:view.item?.id||(view.item?.kind==='change'?'change':undefined),stateEventId:state.events.at(-1)?.id||null,
      stateMarker:JSON.stringify({actor:user.id,workspace,lastEvent:state.events.at(-1)?.id,revision:c?.revision,status:c?.status})};
  },onStale:refreshPreservingInput,onNavigate:()=>show()});
}

async function refreshPreservingInput() {
  const currentWorkspace=workspace,currentActor=user?.id,currentView=view;
  const response=await api('/api/state');
  if(workspace!==currentWorkspace||user?.id!==currentActor||view!==currentView)return;
  state=response.state;
  const c=caseFor(view.item?.caseId);
  const history=document.querySelector('.history-panel');
  if(c&&history)history.outerHTML=historyPanel(c);
  const submit=document.getElementById('submit');
  if(submit&&c)submit.disabled=!(c.canSubmit&&c.needsResubmit);
}

function reasonFields(group) {
  return `<div data-reason="${esc(group)}"><label>사유 선택<select name="reasonChoice" required><option value="">선택하세요</option>
    ${(reasonChoices[group]||[]).map(([id,label])=>`<option value="${id}">${esc(label)}</option>`).join('')}<option value="other">기타 직접 작성</option></select></label>
    <p class="reason-preview meta"></p><label><span class="sr-only">직접 작성할 사유</span><textarea name="reason" hidden required maxlength="4000" placeholder="확인한 사실과 판단 근거를 작성하세요."></textarea></label></div>`;
}

function itemName(item) {
  const task = taskFor(item.taskId);
  if (task?.jobId) return labels[task.action] || 'AI 후속 확인';
  if (task?.responseTo) return '보완 회신 검토';
  if (item.kind === 'approval' && caseFor(item.caseId).currentBasis.required.length === 2) return '특별승인';
  return labels[item.kind];
}

function inbox() {
  const buckets=new Map();for(const item of state.workItems){const name=itemName(item);if(!buckets.has(name))buckets.set(name,[]);buckets.get(name).push(item);}
  let cards=has('intake')?'<button class="task-card" id="openIntake"><strong>검토 요청 접수</strong><span>'+state.plans.filter(p=>p.status==='planned'&&!p.caseId).length+'건</span></button><button class="task-card" id="sourceData"><strong>원본 자료 등록·정정</strong></button><button class="task-card" id="direct"><strong>새 요청 입력</strong></button><button class="task-card" id="csv"><strong>CSV 요청 등록</strong></button>':'';
  cards += [...buckets].map(([name,items])=>'<button class="task-card" data-category="'+esc(name)+'"><strong>'+esc(name)+'</strong><span>'+items.length+'건</span></button>').join('');
  const changes=has('intake')?state.cases.filter(c=>!['completed','rejected','cancelled'].includes(c.status)):[];
  if(changes.length)cards+='<button class="task-card" id="changes"><strong>지급조건 변경</strong><span>'+changes.length+'건</span></button>';
  shell('내 작업','<div class="task-cards work-launcher">'+(cards||'<p class="empty">현재 처리할 작업이 없습니다.</p>')+'</div>',state.publicDemo&&state.canReset?'<button id="resetDemo">새 시연 · 전체 초기화</button>':'');
  listen('openIntake',()=>show({kind:'batch'}));listen('sourceData',()=>show({kind:'source'}));listen('direct',()=>show({kind:'direct'}));listen('csv',()=>show({kind:'csv'}));listen('changes',()=>show({kind:'list',category:'지급조건 변경'}));
  for(const el of document.querySelectorAll('[data-category]'))el.onclick=()=>show({kind:'list',category:el.dataset.category});
  listen('resetDemo',async()=>{
    if(busy||!confirm('내 시연에서 만든 기록과 추가·정정 자료를 모두 지우고 제공 원본으로 돌아갑니다. 전체 초기화할까요?'))return;
    busy=true;document.getElementById('resetDemo').disabled=true;
    try{await api('/api/demo/reset',{epoch:state.epoch,confirm:'RESET_MY_DEMO'});clearGuidance(true);view={kind:'inbox'};dirty=false;await load();toast('새 시연을 시작할 수 있습니다.');}catch(e){toast(e.message);document.getElementById('resetDemo')?.removeAttribute('disabled');}finally{busy=false;}
  });
}
function taskList(){
  const changes=view.category==='지급조건 변경';
  const items=changes?state.cases.filter(c=>!['completed','rejected','cancelled'].includes(c.status)).map(c=>({id:c.id,caseId:c.id,kind:'change'})):state.workItems.filter(i=>itemName(i)===view.category);
  shell(view.category,'<div class="task-cards">'+items.map(i=>{const c=caseFor(i.caseId);return '<button class="task-card" data-work="'+esc(i.id)+'"><strong>'+esc(c.title)+'</strong><span>'+esc(i.paymentId||c.currentBasis.month)+'</span>'+badge(c.status)+'</button>';}).join('')+'</div>');
  for(const button of document.querySelectorAll('[data-work]'))button.onclick=()=>show({kind:'task',item:items.find(i=>i.id===button.dataset.work)});
}
function mountModuleNavigation(){
  for(const node of [...document.querySelectorAll('[data-module] [data-module]')]){const parent=node.parentElement.closest('[data-module]');parent.after(node);}
  const nodes=[...document.querySelectorAll('[data-module]')];if(!nodes.length)return;
  const active=nodes.find(n=>n.dataset.module===view.module)||nodes.find(n=>n.open)||nodes[0];
  const nav=document.createElement('nav');nav.className='module-nav';nav.setAttribute('aria-label','작업 단계');
  for(const node of nodes){const button=document.createElement('button');button.type='button';button.textContent=node.querySelector('summary span')?.textContent||node.dataset.module;button.dataset.moduleTarget=node.dataset.module;button.onclick=()=>activateModule(node.dataset.module);nav.append(button);}
  if(nodes.length>1)document.querySelector('.headline').after(nav);
  activateModule(active.dataset.module);
}
function activateModule(id){
  view.module=id;
  for(const node of document.querySelectorAll('[data-module]')){node.hidden=node.dataset.module!==id;node.open=!node.hidden;}
  for(const button of document.querySelectorAll('[data-module-target]'))button.setAttribute('aria-pressed',String(button.dataset.moduleTarget===id));
}
function batchView(){
  shell('검토 요청 접수',moduleHTML('intake',intakeBoard(state),{ruleOnly:true}));
  mountIntake({state,api,run,onSaved:result=>({kind:'batchDone',result})});
}

function registerView(channel) {
  const currentDate = state.schedulePolicy.period;
  const options = state.agencies.map(a => `<option value="${esc(a.agency_id)}">${esc(a.agency_id)} · ${esc(a.agency_name)}</option>`).join('');
  const example = 'request_id,agency_id,amount_krw,period_ym,planned_date,evidence_id,evidence_type,evidence_date,evidence_account_holder,evidence_account_no,evidence_amount_krw,evidence_period_ym,evidence_text\n'
    + `NEW-001,${state.agencies[0].agency_id},100000,${currentDate.slice(0,7)},,,,,,,,,\n`;
  const content = channel === 'direct' ? `<form id="registration" class="panel stack">
    <div class="field-grid"><label>요청 ID<input name="id" value="REQ-${crypto.randomUUID()}" required maxlength="80"></label>
    <label>거래처<select name="agencyId" required><option value="">선택하세요</option>${options}</select></label>
    <label>원 단위 금액<input name="amount" type="number" min="1" step="1" required></label>
    <label>정산월<input name="period" type="month" value="${currentDate.slice(0,7)}" required></label>
    </div>
    <button class="primary" type="submit">요청 등록</button></form>`
    : `<form id="registration" class="panel stack"><p>UTF-8 CSV 파일로 최대 50건을 등록합니다. 기존 5개 요청 열은 필수이며 evidence_로 시작하는 열은 원자료가 있을 때만 입력하세요. 계좌·명의·작성일을 원자료 그대로 입력하면 접수 후 규칙 대조합니다. planned_date 값은 비워 둘 수 있습니다.</p>
      <a download="w07-requests.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF'+example)}">CSV 양식 내려받기</a>
      <label>요청 파일<input name="csv" type="file" accept=".csv,text/csv" required></label>
      <button class="primary" type="submit">CSV 요청 등록</button></form>`;
  shell(channel === 'direct' ? '새 지급 요청 등록' : 'CSV 지급 요청 등록', moduleHTML('register',content));
  form('registration', async fields => {
    const payload = channel === 'direct'
      ? {rows:[{...Object.fromEntries(fields),amount:Number(fields.get('amount'))}]}
      : {csv:{text:await fields.get('csv').text()}};
    return run('registerRequests', payload, () => ({kind:'inbox'}));
  });
}

const docFields = documentFields;
const docsFrom = readDocuments;

function aiCard(task) {
  if(!task)return '';
  return task.reason?'<p class="decision-band">'+esc(task.reason)+'</p>':'';
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
  const holds=Object.values(c.holds).filter(h=>!h.closedAt);
  const pending=c.paymentIds.map(planFor).filter(p=>!state.instructions.some(i=>i.paymentId===p.id));
  const openChecks=holds.filter(h=>h.owner==='reviewer'&&h.key!=='assignee'&&!h.key.startsWith('evidence:'));
  const currentDocs=c.reviewMode==='source-1'?(c.evidenceAssessment?.records||[]):c.docs;
  const docs=currentDocs.map(d=>'<label class="checkbox"><input type="checkbox" name="docIds" value="'+esc(d.id)+'">'+esc(({account:'계좌·명의 근거',narrative:'서술 자료',supplement:'보완 회신',bank:'은행 자료',voucher:'전표 자료'})[d.kind]||d.kind)+' · '+esc(d.id)+'</label><details><summary>증빙 본문 보기</summary><p class="doc">'+esc(d.text)+'</p></details>').join('');
  const evidence=assessmentHTML(c.evidenceAssessment)+documentCards(currentDocs)+'<fieldset><legend>대조에 사용할 증빙</legend>'+docs+'</fieldset><fieldset><legend>선택 증빙으로 확인한 지급 건</legend>'+pending.map(p=>'<label class="checkbox"><input type="checkbox" name="confirmPaymentIds" value="'+esc(p.id)+'">'+esc(p.id)+' · '+esc(p.accountLabel)+' · '+esc(p.owner)+(c.confirmations[p.id]?' · 확인 기록 있음':'')+'</label>').join('')+'</fieldset>'+reasonFields('review')+'<button type="submit" class="primary" data-action="review">검토 저장</button><button type="button" id="openHolds" data-action="openHolds">보류·예외 처리로 이동</button>';
  const holdList=holds.length?holds.map(h=>openChecks.includes(h)?'<label class="checkbox"><input type="checkbox" name="resolveKeys" form="review" value="'+esc(h.key)+'">'+esc(h.reason)+' 확인 완료</label>':'<p class="hold-item">'+esc(h.reason)+'</p>').join(''):'<p>현재 남은 보류 사유가 없습니다.</p>';
  const holdContent=holdList+'<label class="checkbox"><input type="checkbox" name="special" form="review">정책 예외로 특별승인 적용</label><button type="submit" form="review" data-action="review">선택한 확인 결과 저장</button>';
  const canSubmit=c.canSubmit&&c.needsResubmit;
  const evidenceModule='<form id="review" class="stack">'+moduleHTML('evidence',evidence,{open:!canSubmit})+'</form>';
  const holdsModule=moduleHTML('holds',holdContent+
    '<details class="supporting-form"><summary>보완·추가 판단 의뢰</summary><form id="flag" class="stack">'+reasonFields('flag')+'<label class="checkbox"><input type="checkbox" name="conflict">영업 임원의 이해상충 확인</label><button type="submit" data-action="flag">지급보류 · AI 검토 의뢰</button></form></details>'+
    (c.reviewMode==='source-1'?'<p>원본의 정정은 일반 영업지원 직원이 원본 세 표 등록·정정 화면에서 처리합니다. 추가 설명만 필요한 경우 보완 요청에 답할 수 있습니다.</p>':'<details class="supporting-form"><summary>새 증빙 연결</summary><form id="documents" class="stack">'+docFields()+'<button type="submit" data-action="documents">증빙 저장</button></form></details>'),{open:false});
  const submitModule=moduleHTML('submit',approvalSummary(c)+(canSubmit?'<p>검토 근거가 저장되어 결재를 상신할 수 있습니다.</p>':'<p>상신 전에 계좌·명의 증빙과 남은 보류 사유를 확인하세요.</p><button type="button" id="backToEvidence">증빙 확인으로 이동</button>')+'<button id="submit" type="button" data-action="submit" class="primary" '+(canSubmit?'':'disabled')+'>현재 검토 버전 상신</button>',{open:canSubmit});
  const supporting=moduleHTML('basis',caseFacts(c),{open:false})+holdsModule;
  return canSubmit?submitModule+evidenceModule+supporting:evidenceModule+supporting+submitModule;
}

function approvalForm(c) {
  return assessmentHTML(c.evidenceAssessment)+documentCards(c.docs)+approvalSummary(c)+'<form id="decide" class="stack"><label>결재 결정<select name="decision"><option value="approve">승인</option><option value="supplement">보완 요청</option><option value="reject">반려</option></select></label><p data-decision-effect class="meta">'+esc(modules.approval.actions[0][2])+'</p><div data-decision-reason>'+reasonFields('approve')+'</div><button type="submit" class="primary" data-action="approve">선택한 결재 저장</button></form>'+caseFacts(c)+Object.values(c.exceptions).map(e=>'<p>특별승인 사유 · '+esc(e.reason)+'</p>').join('')+'<details><summary>상신 증빙</summary>'+(c.snapshots.at(-1)?.docs||[]).map(d=>'<p class="doc"><strong>'+esc(d.id)+'</strong> · '+esc(d.text)+'</p>').join('')+'</details>';
}

function changeForm(c) {
  const pending = c.paymentIds.map(planFor).filter(p => !state.instructions.some(i => i.paymentId === p.id));
  return `<form id="changeMonth" class="stack"><label>변경 지급예정월<input name="plannedMonth" type="month" value="${esc(c.currentBasis.month)}" required></label><label>변경 사유<textarea name="reason" required maxlength="4000"></textarea></label><button type="submit" class="primary" data-action="changeMonth">지급월 변경 · 재검토</button></form><details class="supporting-form"><summary>수취계좌 변경</summary><form id="change" class="stack"><div class="field-grid">
    <label>지급 요청<select name="paymentId">${pending.map(p => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.owner)}</option>`).join('')}</select></label>
    <label>변경 수취계좌<input name="account" minlength="4" maxlength="100" required></label>
    <label>수취 명의<input name="owner" value="${esc(pending[0]?.owner)}" required></label>
    </div>
    ${docFields('narrative')}<button type="submit" class="primary">변경 저장 · 지급보류</button></form></details>`;
}

function paymentForm(item, c) {
  const p = planFor(item.paymentId);
  const instruction = state.instructions.find(i => i.id === item.instructionId);
  const details = assessmentHTML(c.evidenceAssessment)+documentCards(c.docs)+`<p class="decision-band"><strong>${esc(p.id)} · ${won(instruction?.amount ?? p.amount)}</strong>
    <span>${esc(instruction?.accountLabel ?? p.accountLabel)} · ${esc(instruction?.date ?? p.plannedDate ?? p.plannedMonth)}</span></p>`;
  if (item.kind === 'pay') return `${details}<form id="payForm" class="stack"><label>지급일<input name="date" type="date" value="${esc(p.plannedDate||'')}" min="${esc(p.plannedMonth)}-01" max="${esc(p.plannedMonth)}-${new Date(Number(p.plannedMonth.slice(0,4)),Number(p.plannedMonth.slice(5,7)),0).getDate()}" ${p.plannedDate?'readonly':''} required></label><button id="pay" type="submit" class="primary">현재 승인 버전으로 지급 지시</button></form>${approvalSummary(c)}`;
  if (item.kind === 'bank') return `${details}<form id="bank" class="stack"><div class="field-grid">
    <label hidden>모의 회신 ID<input name="receiptId" value="BANK-${crypto.randomUUID().slice(0,8)}" required></label>
    <label>은행 결과<select name="outcome"><option value="success">성공</option><option value="failed">확정 실패</option></select></label>
    <label>회신 처리일<input name="date" type="date" value="${esc(instruction.date)}" required></label>
    <label>은행 원자료의 회신 금액<input name="amount" type="number" min="0" step="1" value="${c.reviewMode==='source-1'?instruction.amount:''}" required></label>
    <label>다른 수취계좌 (차이 있을 때)<input name="account"></label></div>
    <button class="primary" type="submit">은행 회신 저장</button></form>${settlementSource(c,item,"bank")}`;
  const receipt = state.receipts.find(r => r.id === instruction.receiptId);
  const actual = instruction.reconciliation === 'difference' && instruction.vouchers?.length;
  return `${details}<p>은행 회신 ${won(receipt.amount)} · ${esc(receipt.date)} · ${esc(receipt.accountLabel)}</p>
    <form id="reconcile" class="stack"><div class="field-grid"><label hidden>모의 전표 ID<input name="voucherId" value="VOUCHER-${crypto.randomUUID().slice(0,8)}" required></label>
    <label>전표 원자료의 금액<input name="amount" type="number" min="0" step="1" value="${c.reviewMode==='source-1'?receipt.amount:''}" required></label></div><button class="primary" type="submit">전표 입력·대사</button></form>
    ${actual ? moduleHTML('actual', `<form id="confirmActual" class="stack"><div class="field-grid">
      <label>확인 금액<input type="number" min="0" step="1" name="amount" value="${receipt.amount}" required></label>
      <label>실제 처리일<input name="date" type="date" value="${esc(receipt.date)}" required></label>
      <label>확인 근거<select name="docId">${c.docs.map(d => `<option value="${esc(d.id)}">${esc(d.id)}</option>`).join('')}</select></label>
      ${reasonFields('actual')}</div><button type="submit">차이 확인 저장</button></form>`) : ''}
    ${settlementSource(c,item,"voucher")}`;
}

function settlementSource(c,item,kind){
  if(c.reviewMode==='source-1')return '<small>모의 입력 · 저장 전 금액과 처리일을 확인하세요.</small>';
  const a=c.settlementAssessments?.find(a=>a.paymentId===item.paymentId&&a.kind===kind);
  return '<section class="source-box source-rules"><h3>제출 원자료 대조</h3>'+ (a?'<ul>'+a.checks.map(k=>'<li>'+esc(k.status==='pass'?'✓ 일치':k.status==='fail'?'! 차이':'? 확인 필요')+' · '+esc(k.message)+'</li>').join('')+'</ul>':'')+(a?.docId?'<button type="button" id="applySource">제출 자료의 추출값 입력</button><p>추출한 실제 값만 입력합니다. 차이가 있으면 그대로 표시하며 저장은 별도입니다.</p>':'')+'</section><details><summary>원자료 연결</summary><form id="documents" class="stack">'+docFields(kind)+'<button type="submit">증빙 저장</button></form></details>';
}

function historyPanel(c) {
  const workId=view.item?.id||(view.item?.kind==='change'?'change':undefined);
  const flow=c?{...c.workflow,...c.workflowByWork?.[workId]}:state.intakeGroups.find(g=>g.id===(view.id||view.inlineId))?.workflow;
  if(!flow)return '';
  const branches=step=>step.parallel?.length?'<div class="parallel-steps">'+step.parallel.map(p=>'<div class="parallel-step '+(p.owner===user.id?'mine':'')+'"><strong>'+esc(p.ownerName)+'</strong><span>'+esc(p.status)+'</span></div>').join('')+'</div>':'';
  const tasks=step=>(step.tasks||[]).map(t=>'<p class="flow-task">'+esc(roles[t.owner])+' · '+esc(t.reason)+(t.jobId?' · AI 후속 작업':'')+'</p>').join('');
  const past=flow.history.map(h=>'<details class="flow-step past"><summary><span class="flow-phase">✓ 진행 이력</span><strong>'+esc(h.title)+'</strong><span>'+esc(h.ownerName)+' · '+esc(h.result)+'</span><small>'+date(h.at)+'</small>'+branches(h)+'</summary><div class="flow-details">'+h.records.map(r=>'<p>'+esc(labels[r.type]||r.type)+' · '+esc(r.detail?.reason||r.detail?.decision||r.detail?.status||'처리 기록')+'</p>').join('')+(h.docs||[]).map(d=>'<p class="doc">'+esc(d.text)+'</p>').join('')+tasks(h)+'</div></details>').join('');
  const current=flow.current;
  return '<section class="history-panel"><h2>업무 진행 흐름</h2><p class="meta">초록 · 진행 이력　파랑 · 현재 작업　보라 · 다음 한 단계</p><div class="workflow-strip" tabindex="0" aria-label="왼쪽에서 오른쪽으로 이어지는 업무 흐름">'+past+'<article class="flow-step current" data-current aria-current="step"><span class="flow-phase">● '+(current.terminal?'처리 결과':'현재 작업')+'</span><strong>'+esc(current.title)+'</strong><span>'+esc(current.ownerName)+'</span><p>'+esc(current.condition)+'</p>'+branches(current)+tasks(current)+'</article>'+(flow.next?'<article class="flow-step next"><span class="flow-phase">→ 다음 단계</span><strong>'+esc(flow.next.title)+'</strong><span>'+esc(flow.next.ownerName)+'</span><p>'+esc(flow.next.condition)+'</p>'+branches(flow.next)+'</article>':'')+'</div></section>';
}

function workDetail(item, done) {
  const c = caseFor(item.caseId);
  if (!c) return show();
  const task = taskFor(item.taskId);
  let content = '';
  if (done) content = `<p class="decision-band">${badge(c.status)} <strong>처리 결과가 저장되었습니다.</strong></p><button type="button" id="backToInbox" data-action="open" class="primary">내 작업으로 돌아가기</button>`;
  else if (item.kind === 'review') content = reviewForm(c)+aiCard(task);
  else if (item.kind === 'approval') content = approvalForm(c);
  else if (item.kind === 'supplement') content = aiCard(task) + `<form id="supplement" class="stack">${c.reviewMode==='source-1'?'<p class="source-box source-rules">원본 값이 잘못되었으면 원본 세 표 화면에서 먼저 정정하세요. 이 입력란에는 확인한 차이의 이유나 정정 근거를 남깁니다.</p><button type="button" id="sourceCorrection">원본 세 표 등록·정정 열기</button><input type="hidden" name="kind" value="supplement"><input type="hidden" name="docId" value="REPLY-'+crypto.randomUUID()+'"><label>보완 확인 내용<textarea name="text" required maxlength="4000"></textarea></label>':docFields('supplement')}<button type="submit" class="primary">보완 회신 보내기</button></form>`;
  else if (item.kind === 'change') content = changeForm(c);
  else content = paymentForm(item,c);

  if (done) content = moduleHTML('result', content);
  else if (item.kind !== 'review') content = moduleHTML(item.kind === 'approval' ? 'approval' : item.kind, content);
  shell(done ? '처리 결과' : itemName(item), `<section class="panel work-panel"><h2>${esc(c.title)}</h2>${content}</section><details class="supporting-details"><summary>근거·이력 보기</summary>${historyPanel(c,item,done)}</details>`);
  if (done) {listen('backToInbox',()=>show());return;}
  listen('sourceCorrection',()=>show({kind:'source'}));
  if(c.reviewMode!=='source-1'&&['review','supplement','change'].includes(item.kind)){const b=document.createElement('button');b.textContent='원본 데이터 기준으로 재검토';b.onclick=()=>run('recheckSource',{caseId:c.id});document.querySelector('.work-panel').prepend(b);}
  form('review', f => run('review',{caseId:c.id,taskId:item.taskId,reason:f.get('reason'),docIds:f.getAll('docIds'),
    confirmPaymentIds:f.getAll('confirmPaymentIds'),resolveKeys:f.getAll('resolveKeys'),special:f.has('special')}));
  form('flag', f => run('flag',{caseId:c.id,reason:f.get('reason'),conflict:f.has('conflict')}));
  form('documents', f => run('documents',{caseId:c.id,docs:docsFrom(f).map(d=>({...d,...(item.paymentId?{paymentIds:[item.paymentId]}:{})}))}));
  listen('applySource',()=>{const kind=item.kind==='bank'?'bank':'voucher',a=c.settlementAssessments?.find(a=>a.paymentId===item.paymentId&&a.kind===kind),target=document.getElementById(item.kind);for(const key of ['amount','date','outcome']){const input=target?.querySelector('[name='+key+']');if(input&&a?.fields[key]!==undefined){input.value=a.fields[key];input.dispatchEvent(new Event('change',{bubbles:true}));}}});
  form('supplement', f => run('documents',{caseId:c.id,taskId:item.taskId,docs:docsFrom(f)}));
  form('decide', f => run('decide',{caseId:c.id,version:c.version,decision:f.get('decision'),reason:f.get('reason')}));
  form('change', f => run('change',{caseId:c.id,paymentId:f.get('paymentId'),account:f.get('account'),owner:f.get('owner'),date:f.get('date') || undefined,docs:docsFrom(f)}));
  form('changeMonth',f=>run('changeMonth',{caseId:c.id,plannedMonth:f.get('plannedMonth'),reason:f.get('reason')}));
  listen('submit', () => run('submit',{caseId:c.id}));
  listen('openHolds',()=>{activateModule('holds');});
  listen('backToEvidence',()=>{activateModule('evidence');});
  form('payForm',f=>run('pay',{caseId:c.id,paymentId:item.paymentId,version:c.version,date:f.get('date')}));
  form('bank', f => run('bank',{...Object.fromEntries(f),amount:Number(f.get('amount')),instructionId:item.instructionId}));
  form('reconcile', f => run('reconcile',{instructionId:item.instructionId,voucherId:f.get('voucherId'),amount:Number(f.get('amount'))}));
  form('confirmActual', f => run('confirmActual',{instructionId:item.instructionId,amount:Number(f.get('amount')),date:f.get('date'),reason:f.get('reason'),docIds:[f.get('docId')]}));
  const target = $('#change select[name=paymentId]');
  if (target) target.onchange = () => $('#change input[name=owner]').value = planFor(target.value).owner;
}

function render() {
  if(view.kind==='source'){shell('원본 자료 등록·정정',moduleHTML('register',sourceHTML(),{ruleOnly:true}));mountSource({state,api,run,onError:toast,onSaved:()=>({kind:'inbox'})});return;}
  if(view.kind==='batch')return batchView();
  if(view.kind==='list')return taskList();
  if(view.kind==='batchDone'){shell('접수 완료','<p class="decision-band">'+view.result.count+'건을 '+view.result.groups+'개 검토 건으로 접수했습니다.</p><p>다음 담당: 회계팀</p><button id="batchBack">내 작업</button>');listen('batchBack',()=>show());return;}
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
root.addEventListener('invalid',event=>{const module=event.target.closest('[data-module]');if(module?.hidden)activateModule(module.dataset.module);},true);
await load();
setInterval(() => {
  if (!user || dirty || busy || document.querySelector('main form :focus')) return;
  if (state.jobs.some(j => ['pending','running'].includes(j.status))) void load();
}, 3000);
