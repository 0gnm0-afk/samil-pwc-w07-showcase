import { modules } from './catalog.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let generation=0;
let observer;
const cache=new Map();
const area=node=>node.querySelector(':scope > .module-guidance');
export function moduleHTML(id,content,{open=true}={}) {
  const module=modules[id];
  return `<details class="work-module" data-module="${id}" ${open?'open':''}>
    <summary><span>${esc(module.title)}</span><span class="module-toggle">설명·처리</span></summary>
    <p class="module-purpose">${esc(module.purpose)}</p><div class="module-content">${content}</div>
    <section class="module-guidance" aria-label="${esc(module.title)} AI 안내">
      <h3>AI 업무 안내</h3><p class="guidance-status" role="status">현재 업무를 확인하면 AI 안내를 불러옵니다.</p>
      <div class="guidance-body"><p>${esc(module.purpose)}</p></div>
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
  area(node).querySelector('.guidance-body').innerHTML=fallback?`<p>${esc(fallback.summary)}</p>
    <ul>${fallback.actions.map(a=>`<li><strong>${esc(a.label)}</strong> — ${esc(a.effect)}${!a.enabled?' · 현재 실행 조건 확인 필요':''}</li>`).join('')}</ul><p>다음 업무 · ${esc(fallback.nextStep)}</p>`:`<p>${esc(modules[node.dataset.module].purpose)}</p>`;
}
export function mountGuidance({api,getContext,onStale}) {
  generation++;const epoch=generation;
  observer?.disconnect();
  const nodes=[...document.querySelectorAll('[data-module]')];
  const timers=new Map();
  const requests=new Map();
  const visible=new Set();
  async function load(node,force=false) {
    if(epoch!==generation||!node.open||!visible.has(node)||!node.getClientRects().length)return;
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
        timers.set(node,setTimeout(()=>load(node,true),2500));return;
      }
      if(result.status==='stale') {
        basic(node,result,'업무 상태가 변경되어 최신 안내를 확인하고 있습니다.');
        await onStale();requests.delete(node);load(node);return;
      }
      if(result.status!=='ready') {
        basic(node,result,result.message||'기본 업무 안내로 계속 처리할 수 있습니다.');
        const retry=document.createElement('button');retry.type='button';retry.textContent='AI 안내 다시 보기';
        retry.onclick=()=>{cache.delete(signature);load(node,true);};
        area(node).querySelector('.guidance-body').append(retry);return;
      }
      cache.set(signature,result);if(cache.size>80)cache.delete(cache.keys().next().value);
      const answer=result.answer;
      status.textContent='NVIDIA NIM · 현재 모듈과 업무 근거를 반영한 안내';
      area(node).querySelector('.guidance-body').innerHTML=`<p class="guidance-summary">${esc(answer.summary)}</p>
        ${answer.recommendations.map((r,i)=>`<div class="recommendation"><strong>권장 · ${esc(r.label)}</strong><p>${esc(r.reason)}</p><p class="meta">선택 후 · ${esc(r.effect)}</p>
          <button type="button" data-recommendation="${i}">해당 선택으로 이동</button>
          <details><summary>권장 근거 보기</summary>${r.evidence.map(e=>`<p>${esc(e.ref==='CURRENT'?'현재 서버의 작업 상태와 실행 조건을 확인했습니다.':e.text)}</p>`).join('')}</details></div>`).join('')}
        <p><strong>다음 업무</strong> · ${esc(answer.nextStep)}</p>
        ${answer.checks.length?`<ul>${answer.checks.map(text=>`<li>${esc(text)}</li>`).join('')}</ul>`:''}`;
      for(const button of area(node).querySelectorAll('[data-recommendation]'))button.onclick=()=>{
        const r=answer.recommendations[Number(button.dataset.recommendation)];
        const target=r.field?node.querySelector(`[name="${r.field}"]`):node.querySelector(`[data-action="${r.actionId}"]`);
        const fallbackTarget=target||document.querySelector(r.field?`main [name="${r.field}"]`:`main [data-action="${r.actionId}"]`)||(!r.field&&document.querySelector(`[data-action="${r.actionId}"]`));
        if(fallbackTarget){fallbackTarget.closest('details')?.setAttribute('open','');fallbackTarget.focus();fallbackTarget.scrollIntoView({block:'center',behavior:'smooth'});fallbackTarget.classList.add('recommended-input');setTimeout(()=>fallbackTarget.classList.remove('recommended-input'),3500);}
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
    for(const node of nodes){clearTimeout(timers.get(node));requests.delete(node);area(node).querySelector('.guidance-status').textContent='선택 중인 입력입니다. 입력을 마치면 안내를 갱신합니다.';area(node).querySelector('.guidance-body').innerHTML=`<p>${esc(modules[node.dataset.module].purpose)}</p>`;}
  });
  main?.addEventListener('change',()=>{
    for(const node of nodes){clearTimeout(timers.get(node));timers.set(node,setTimeout(()=>load(node,true),900));}
  });
}
