import { modules } from './catalog.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let generation=0;
let observer;
const activeTimers=new Set();
export function clearGuidance() {
  generation++;observer?.disconnect();
  for(const timer of activeTimers)clearTimeout(timer);
  activeTimers.clear();
}
const later=(fn,ms)=>{const timer=setTimeout(()=>{activeTimers.delete(timer);fn();},ms);activeTimers.add(timer);return timer;};
const cache=new Map();
const area=node=>node.querySelector(':scope > .module-guidance');
export function moduleHTML(id,content,{open=true,ruleOnly=false}={}) {
  const module=modules[id];
  return `<details class="work-module" data-module="${id}" ${ruleOnly?'data-rule-only="true"':''} ${open?'open':''}>
    <summary><span>${esc(module.title)}</span><span class="module-toggle">설명·처리</span></summary>
    <div class="module-purpose source-box source-rules"><span class="source-label">기본 안내</span><p>${esc(module.purpose)}</p></div><div class="module-content">${content}</div>
    <section class="module-guidance" aria-label="${esc(module.title)} AI 안내">
      <h3>${ruleOnly?'지급예정일 안내':'업무 안내'}</h3><p class="guidance-status" role="status">${ruleOnly?'기본 규칙으로 계산하며 AI를 호출하지 않습니다.':'현재 업무를 확인하면 AI 안내를 불러옵니다.'}</p>
      <div class="guidance-body"><div class="source-box source-rules"><span class="source-label">기본 안내</span><p>${esc(module.purpose)}</p></div></div>
    </section></details>`;
}
export function formDraft(node) {
  const result={};
  const closest=node.closest('form');
  const forms=closest?[closest]:[...node.querySelectorAll('form')];
  const focused=forms.find(form=>form.contains(document.activeElement));
  for(const form of focused?[focused]:forms.slice(0,1))for(const [key,value] of new FormData(form)) {
    if(typeof value!=='string'){if(key==='csv')result.csvSelected=value.size>0;continue;}
    if(['paymentIds','confirmPaymentIds','docIds','resolveKeys'].includes(key)){(result[key]??=[]).push(value);}
    else result[key]=value;
  }
  for(const key of ['paymentIds','confirmPaymentIds','docIds','resolveKeys'])if(node.querySelector(`[name="${key}"]`))result[key]??=[];
  return result;
}
function basic(node,result,message) {
  area(node).querySelector('.guidance-status').textContent=message;
  const fallback=result?.fallback;
  area(node).querySelector('.guidance-body').innerHTML=`<div class="source-box source-rules"><span class="source-label">기본 안내 · 업무 규칙</span>`+(fallback?`<p>${esc(fallback.summary)}</p>
    <ul>${fallback.actions.map(a=>`<li><strong>${esc(a.label)}</strong> — ${esc(a.effect)}${!a.enabled?' · 현재 실행 조건 확인 필요':''}</li>`).join('')}</ul><p>다음 업무 · ${esc(fallback.nextStep)}</p>`:`<p>${esc(modules[node.dataset.module].purpose)}</p>`)+`</div>`;
}
export function mountGuidance({api,getContext,onStale,onNavigate}) {
  clearGuidance();const epoch=generation;
  const nodes=[...document.querySelectorAll('[data-module]')];
  const timers=new Map();
  const requests=new Map();
  const visible=new Set();
  async function load(node,force=false) {
    if(epoch!==generation||!node.open||!visible.has(node)||!node.getClientRects().length)return;
    if(node.dataset.ruleOnly){basic(node,{fallback:{summary:'요청별 추천일을 확인하고 저장할 요청을 선택하세요. 저장 전 예상 결과에서 지급월·합산액·승인 담당자를 함께 확인할 수 있습니다.',actions:[{label:'예정일 저장',enabled:true,effect:'날짜가 확정되고 지급월 묶음이 다시 계산됩니다. 이어서 해당 묶음에서 증빙과 함께 접수하세요.'}],nextStep:'일반 영업지원 직원 · 지급 요청과 증빙 접수'}},'기본 규칙으로 날짜를 계산했습니다. AI 호출은 사용하지 않습니다.');return;}
    const input={...getContext(),moduleId:node.dataset.module,draft:formDraft(node)};
    const signature=JSON.stringify(input);
    if(!force&&requests.get(node)===signature)return;
    requests.set(node,signature);
    const status=area(node).querySelector('.guidance-status');
    status.textContent='BPMN과 현재 업무 상태를 확인해 안내를 작성하고 있습니다.';
    try {
      const result=cache.get(signature)||await api('/api/guidance',input);
      if(epoch!==generation||requests.get(node)!==signature)return;
      if(result.status==='pending') {
        timers.set(node,later(()=>load(node,true),2500));return;
      }
      if(result.status==='stale') {
        basic(node,result,'업무 상태가 변경되어 최신 안내를 확인하고 있습니다.');
        await onStale();requests.delete(node);load(node);return;
      }
      if(result.status!=='ready') {
        basic(node,result,result.message||'기본 업무 안내로 계속 처리할 수 있습니다.');
        if(result.status==='rules')return;
        if(result.status==='waiting'){
          timers.set(node,later(()=>load(node,true),Math.min(60000,Math.max(1500,Date.parse(result.retryAt)-Date.now()))));return;
        }
        const retry=document.createElement('button');retry.type='button';retry.textContent='AI 안내 다시 보기';
        retry.onclick=()=>{cache.delete(signature);load(node,true);};
        area(node).querySelector('.guidance-body').append(retry);return;
      }
      cache.set(signature,result);if(cache.size>80)cache.delete(cache.keys().next().value);
      const answer=result.answer;
      status.textContent='NVIDIA NIM · 현재 모듈과 업무 근거를 반영한 안내';
      area(node).querySelector('.guidance-body').innerHTML=`<div class="source-box source-rules"><span class="source-label">기본 안내 · 현재 업무</span><p class="guidance-summary">${esc(answer.summary)}</p></div>
        ${answer.recommendations.map((r,i)=>`<div class="recommendation source-box source-ai"><span class="source-label">AI 안내 · 추천</span><strong>권장 · ${esc(r.label)}</strong><h4>왜 추천하나요?</h4><p>${esc(r.reason)}</p>
          <div class="source-box source-rules"><span class="source-label">기본 안내 · 실제 화면 조작 순서</span>
          ${r.beforeAction?.length?`<h4>먼저 확인하세요</h4><ul>${r.beforeAction.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}
          ${r.howTo?.length?`<h4>이렇게 진행하세요</h4><ol>${r.howTo.map(t=>`<li>${esc(t)}</li>`).join('')}</ol>`:''}
          </div>
          <div class="source-box source-rules"><span class="source-label">기본 안내 · 실행 결과</span><p>${esc(r.effect)}</p></div>
          <button type="button" data-recommendation="${i}">${r.destination==='inbox'?'내 작업으로 돌아가기':r.interaction==='navigate'?'작업 화면 열기':'해당 입력·버튼 확인'}</button>
          <details><summary>권장 근거 보기</summary>${r.evidence.map(e=>`<div class="source-box source-rules"><span class="source-label">${e.source==='document'?'제출 자료':'업무 규칙·현재 사실'}</span><p>${esc(e.displayText||e.text)}</p></div>`).join('')}</details></div>`).join('')}
        <div class="source-box source-rules"><span class="source-label">기본 안내 · 다음 담당자</span><p>${esc(answer.nextStep)}</p></div>
        ${answer.checks.length?`<div class="source-box source-ai"><span class="source-label">AI 안내 · 추가 확인</span><ul>${answer.checks.map(text=>`<li>${esc(text)}</li>`).join('')}</ul></div>`:''}`;
      for(const button of area(node).querySelectorAll('[data-recommendation]'))button.onclick=()=>{
        const r=answer.recommendations[Number(button.dataset.recommendation)];
        if(r.destination==='inbox'){onNavigate?.('inbox');return;}
        const target=r.field?node.querySelector(`[name="${r.field}"]`):node.querySelector(`[data-action="${r.actionId}"]`);
        const fallbackTarget=target||document.querySelector(r.field?`main [name="${r.field}"]`:`main [data-action="${r.actionId}"]`)||(!r.field&&document.querySelector(`[data-action="${r.actionId}"]`));
        if(fallbackTarget){
          if(r.interaction==='navigate'){fallbackTarget.click();return;}
          for(let parent=fallbackTarget.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
          fallbackTarget.focus();fallbackTarget.scrollIntoView({block:'center',behavior:'smooth'});fallbackTarget.classList.add('recommended-input');later(()=>fallbackTarget.classList.remove('recommended-input'),3500);
        }
      };
    } catch(error) {
      if(epoch===generation&&requests.get(node)===signature)basic(node,null,error.message||'기본 기능 설명을 확인하세요.');
    }
  }
  observer=new IntersectionObserver(entries=>{
    for(const entry of entries){if(entry.isIntersecting){visible.add(entry.target);load(entry.target);}else visible.delete(entry.target);}
  },{rootMargin:'80px'});
  for(const node of nodes){observer.observe(node);node.addEventListener('toggle',()=>load(node));}
  const main=document.querySelector('main');
  main?.addEventListener('input',()=>{
    for(const node of nodes){clearTimeout(timers.get(node));requests.delete(node);basic(node,null,'선택 중인 입력입니다. 입력을 마치면 안내를 갱신합니다.');}
  });
  main?.addEventListener('change',()=>{
    for(const node of nodes){clearTimeout(timers.get(node));timers.set(node,later(()=>load(node,true),900));}
  });
}
