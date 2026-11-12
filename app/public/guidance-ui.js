import { modules,controlInstructions } from './catalog.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let generation=0;
let observer;
let listeners;
const activeTimers=new Set();
export function clearGuidance(resetCache=false) {
  if(resetCache)cache.clear();
  generation++;observer?.disconnect();
  listeners?.abort();
  for(const timer of activeTimers)clearTimeout(timer);
  activeTimers.clear();
}
const later=(fn,ms)=>{const timer=setTimeout(()=>{activeTimers.delete(timer);fn();},ms);activeTimers.add(timer);return timer;};
const cache=new Map();
const area=node=>node.querySelector(':scope > .module-guidance');
export function moduleHTML(id,content,{open=true,ruleOnly=false}={}) {
 const module=modules[id];
 return '<details class="work-module" data-module="'+id+'" '+(ruleOnly?'data-rule-only="true" ':'')+(open?'open':'')+'><summary><span>'+esc(module.title)+'</span></summary><section class="module-guidance" aria-label="AI 검토"><p class="guidance-status" role="status"></p><div class="guidance-body"></div></section><div class="guidance-actions"></div><div class="module-content">'+content+'</div></details>';
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
 area(node).querySelector('.guidance-body').innerHTML='';
 node.querySelector(':scope > .guidance-actions').innerHTML='';
 updateBasic(node,result);
}
function updateBasic() {}
export function mountGuidance({api,getContext,onStale,onNavigate}) {
  clearGuidance();const epoch=generation;
  listeners=new AbortController();const signal=listeners.signal;
  const nodes=[...document.querySelectorAll('[data-module]')];
  const timers=new Map();
  const requests=new Map();
  const visible=new Set();
  async function load(node,force=false) {
    if(epoch!==generation||!node.open||!visible.has(node)||!node.getClientRects().length)return;
    if(node.dataset.ruleOnly){area(node).hidden=true;return;}
    const input={...getContext(),moduleId:node.dataset.module,draft:formDraft(node)};
    const signature=JSON.stringify(input);
    if(!force&&requests.get(node)===signature)return;
    requests.set(node,signature);
    area(node).hidden=false;const status=area(node).querySelector('.guidance-status');
    status.textContent='검토 중…';
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
        basic(node,result,result.message||'AI 검토를 불러오지 못했습니다.');
        if(result.status==='rules'){area(node).hidden=true;return;}
        if(result.status==='waiting'){
          timers.set(node,later(()=>load(node,true),Math.min(60000,Math.max(1500,Date.parse(result.retryAt)-Date.now()))));return;
        }
        const retry=document.createElement('button');retry.type='button';retry.textContent='AI 검토 다시 시도';
        retry.onclick=()=>{cache.delete(signature);load(node,true);};
        area(node).querySelector('.guidance-body').append(retry);return;
      }
      cache.set(signature,result);if(cache.size>80)cache.delete(cache.keys().next().value);
      const answer=result.answer;const review=result.review||answer;
      status.textContent='NVIDIA NIM · 현재 모듈과 업무 근거를 반영한 안내';
      updateBasic(node,result);
      status.textContent='NVIDIA NIM이 원본 데이터를 검토한 판단입니다. 최종 결정은 담당자가 합니다.';
      area(node).querySelector('.guidance-body').innerHTML='<div class="source-box source-ai"><h3>데이터를 검토한 AI 권고</h3>'+review.recommendations.map(r=>'<article><h4>권고하는 선택: '+esc(r.label)+'</h4><p>'+esc(r.reason)+'</p><details><summary>판단에 사용한 원본·규칙 확인</summary>'+r.evidence.map(e=>'<blockquote>'+esc(e.displayText||e.text)+'</blockquote>').join('')+'</details></article>').join('')+(review.checks.length?'<h4>현재 자료만으로는 추가 확인이 필요한 내용</h4><ul>'+review.checks.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul>':'')+'</div>';
      node.querySelector(':scope > .guidance-actions').innerHTML=answer.recommendations.length?'<div>'+answer.recommendations.map((r,i)=>'<button type="button" data-recommendation="'+i+'">'+(r.destination==='inbox'?'내 작업으로 돌아가기':['apply','applySource'].includes(r.interaction)?'권고한 선택을 입력란에 적용':'해당 선택·입력 확인')+'</button>').join('')+'</div>':'';
      for(const button of node.querySelectorAll(':scope > .guidance-actions [data-recommendation]'))button.onclick=()=>{
        const r=answer.recommendations[Number(button.dataset.recommendation)];
        if(epoch!==generation||requests.get(node)!==signature)return;
        if(r.destination==='inbox'){onNavigate?.('inbox');return;}
        if(r.interaction==='applySource'){document.getElementById('applySource')?.click();return;}
        const target=r.formId?document.getElementById(r.formId)?.querySelector(`[name="${r.field}"]`):r.field?node.querySelector(`[name="${r.field}"]`):node.querySelector(`[data-action="${r.actionId}"]`);
        const fallbackTarget=target||document.querySelector(r.field?`main [name="${r.field}"]`:`main [data-action="${r.actionId}"]`)||(!r.field&&document.querySelector(`[data-action="${r.actionId}"]`));
        if(fallbackTarget){
          if(r.interaction==='navigate'){fallbackTarget.click();return;}
          if(r.interaction==='apply'){
            if(fallbackTarget.tagName!=='SELECT'||![...fallbackTarget.options].some(o=>o.value===r.value))return;
            fallbackTarget.value=r.value;
            for(const input of document.querySelectorAll('#review [name=docIds]'))if(r.docIds?.includes(input.value))input.checked=true;
            fallbackTarget.dispatchEvent(new Event('change',{bubbles:true}));
            button.textContent='선택 적용됨 · 내용 확인 후 직접 저장하세요';
          }
          const targetModule=fallbackTarget.closest('[data-module]');if(targetModule){document.querySelector('[data-module-target="'+targetModule.dataset.module+'"]')?.click();}
          for(let parent=fallbackTarget.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
          fallbackTarget.focus();fallbackTarget.scrollIntoView({block:'center',behavior:'smooth'});fallbackTarget.classList.add('recommended-input');later(()=>fallbackTarget.classList.remove('recommended-input'),3500);
        }
      };
    } catch(error) {
      if(epoch===generation&&requests.get(node)===signature)basic(node,null,error.message||'AI 검토를 불러오지 못했습니다.');
    }
  }
  observer=new IntersectionObserver(entries=>{
    for(const entry of entries){if(entry.isIntersecting){visible.add(entry.target);load(entry.target);}else visible.delete(entry.target);}
  },{rootMargin:'80px'});
  for(const node of nodes){observer.observe(node);node.addEventListener('toggle',()=>load(node),{signal});}
  const main=document.querySelector('main');
  main?.addEventListener('input',()=>{
    for(const node of nodes){clearTimeout(timers.get(node));requests.delete(node);basic(node,null,'');}
  },{signal});
  main?.addEventListener('change',()=>{
    for(const node of nodes){clearTimeout(timers.get(node));timers.set(node,later(()=>load(node,true),900));}
  },{signal});
}
