const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won=v=>Number(v||0).toLocaleString('ko-KR')+'원';
const roles={sales:'영업지원팀장(전결)',executive:'영업 임원',finance:'재무 임원'};
export function dateBoard(plans,agencies){
  if(!plans.length)return '';
  return `<section class="panel" id="dateBoard"><h2>1. 미접수 요청 지급예정일 확인 · ${plans.length}건</h2><p class="source-box source-rules">권장일은 정산월과 원본 지급 이력을 기준으로 계산했습니다. 표에서 날짜를 수정하거나 전체 권장일을 적용하세요. 날짜 저장만으로 접수되지 않습니다.</p><form id="dateForm"><div class="row"><button type="submit" class="primary" id="applySelectedDates" disabled>선택한 요청 날짜 적용</button><button type="button" id="rerecommendDates">선택 요청 권장일 다시 계산</button><button type="button" id="previewAllDates">미정 요청 전체 권장일 적용 확인</button></div><div id="datePreview" class="source-box source-rules" aria-live="polite"></div><div class="table-wrap"><table><thead><tr><th><label><input type="checkbox" id="selectDates" checked> 전체 선택</label></th><th>거래처</th><th>정산월</th><th>금액</th><th>현재 지급일</th><th>권장 지급일</th><th>적용할 날짜</th></tr></thead><tbody>${plans.map(p=>`<tr><td><label><input type="checkbox" name="selectedDate" value="${esc(p.id)}" ${!p.plannedDate?'checked':''}>${esc(p.id)}</label></td><td>${esc(agencies.find(a=>a.agency_id===p.agencyId)?.agency_name||p.agencyId)}</td><td>${esc(p.period)}</td><td>${won(p.amount)}</td><td>${esc(p.plannedDate||'미정')}</td><td>${esc(p.scheduleRecommendation?.date)}<details class="date-reason"><summary>${esc(p.scheduleRecommendation?.level==='agency'?'거래처 이력':p.scheduleRecommendation?.level==='company'?'회사 이력':'기본 규칙')} · ${p.scheduleRecommendation?.weekdayOrdinal}번째 평일</summary>${esc(p.scheduleRecommendation?.reason)}</details></td><td><input aria-label="${esc(p.id)} 적용할 날짜" type="date" data-date-id="${esc(p.id)}" value="${esc(p.plannedDate||p.scheduleRecommendation?.date)}"></td></tr>`).join('')}</tbody></table></div></form></section>`;
}
export function mountDates({api,run,onSaved,onError}){
  const form=document.getElementById('dateForm');if(!form)return;
  const output=document.getElementById('datePreview'),apply=document.getElementById('applySelectedDates');let generation=0,preview,mode='selected',timer;
  const items=()=>[...form.querySelectorAll('[name=selectedDate]:checked')].map(el=>({id:el.value,date:[...form.querySelectorAll('[data-date-id]')].find(d=>d.dataset.dateId===el.value).value}));
  async function update(nextMode='selected'){
    const epoch=++generation;mode=nextMode;preview=null;apply.disabled=true;
    const selected=items();if(mode==='selected'&&!selected.length){output.textContent='적용할 요청을 선택하세요.';return;}
    output.textContent='저장 전 묶음과 승인 경로를 계산하고 있습니다.';
    try{
      const result=await api('/api/schedule/preview',mode==='all-recommended'?{mode}:mode==='re-recommend'?{mode,paymentIds:selected.map(i=>i.id)}:{items:selected,includeAssigned:true});
      if(epoch!==generation||!form.isConnected)return;
      preview=result;
      output.innerHTML=`<h3>${mode==='all-recommended'?'전체 권장일':'선택 날짜'} 적용 전 미리보기 · ${result.items.length}건</h3><p>선택한 요청에만 아래 결과를 적용합니다. 접수된 요청은 이 화면에서 바꾸지 않습니다.</p><div class="table-wrap"><table><thead><tr><th>관련자 그룹</th><th>지급예정월</th><th>요청 수</th><th>선택 금액</th><th>월 합산액</th><th>예상 승인 경로</th></tr></thead><tbody>${result.groups.map(g=>`<tr><td>${esc(g.members.join(' · '))}</td><td>${esc(g.month)}</td><td>${g.paymentIds.length}</td><td>${won(g.selectedTotal)}</td><td>${won(g.total)}</td><td>${g.required.map(r=>esc(roles[r.userId]||r.role)).join(' + ')}</td></tr>`).join('')}</tbody></table></div><p>예외가 있으면 영업 임원·재무 임원 특별승인이 필요합니다. 저장 후 아래 묶음에서 증빙을 확인하고 별도로 접수하세요.</p>${mode!=='selected'?'<button type="button" class="primary" id="confirmAllDates">미리 본 권장일로 변경 확정</button>':''}`;
      if(mode==='selected')apply.disabled=false;
      const confirm=document.getElementById('confirmAllDates');if(confirm)confirm.onclick=save;
    }catch(error){if(epoch===generation&&form.isConnected)output.textContent=error.message;}
  }
  function save(){
    if(!preview)return onError('최신 미리보기를 확인하세요.');
    const p=preview;
    if(mode==='selected'&&JSON.stringify(items())!==JSON.stringify(p.items))return update();
    return run('schedule',{...(mode!=='selected'?{mode,paymentIds:p.items.map(i=>i.id),previewHash:p.previewHash}: {items:p.items}),asOfDate:p.asOfDate,sourceRevision:p.sourceRevision,stateEventId:p.stateEventId,unassignedOnly:true,includeAssigned:mode!=='all-recommended'},()=>onSaved(p.items.map(i=>i.id)));
  }
  form.onsubmit=e=>{e.preventDefault();void save();};
  form.addEventListener('input',()=>{generation++;preview=null;apply.disabled=true;clearTimeout(timer);timer=setTimeout(()=>{if(form.isConnected)void update();},250);});
  document.getElementById('selectDates').onchange=e=>{for(const input of form.querySelectorAll('[name=selectedDate]'))input.checked=e.target.checked;void update();};
  document.getElementById('rerecommendDates').onclick=()=>{if(!items().length)return onError('다시 추천할 요청을 선택하세요.');void update('re-recommend');};
  document.getElementById('previewAllDates').onclick=()=>update('all-recommended');
  void update();
}
