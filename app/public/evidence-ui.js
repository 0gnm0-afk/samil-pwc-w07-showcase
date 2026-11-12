const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={requestId:'요청 ID',holder:'수취 명의',accountLabel:'계좌',date:'작성일',amount:'금액',period:'정산월',outcome:'처리 결과'};
export function documentCards(docs=[]){
  if(!docs.length)return '<div class="source-box source-rules"><strong>제출된 증빙 없음</strong><p>요청·마스터 데이터는 증빙을 대신하지 않습니다. 원자료를 연결하거나 자료 보완으로 진행하세요.</p></div>';
  return '<section class="document-list"><h3>원자료와 추출 항목</h3>'+docs.map(d=>`<article class="source-box source-rules document-card" id="doc-${esc(d.id)}"><span class="source-label">제출 원자료 · ${esc(d.source||'기존 자료')}</span><h4>${esc(d.title||d.id)}</h4><p>${esc(d.id)} · ${esc(d.paymentIds?.join(' · ')||'이 검토 건')} · ${esc(d.at||'')}</p>
    ${Object.entries(d.extraction?.fields||{}).filter(([key])=>names[key]).length?`<table><thead><tr><th>항목</th><th>추출값</th><th>출처</th></tr></thead><tbody>${Object.entries(d.extraction.fields).filter(([key])=>names[key]).map(([key,value])=>`<tr><th>${names[key]}</th><td>${esc(value)}</td><td>${esc(d.extraction.locations[key==='accountLabel'?'account':key]?.join(' · ')||'제출 필드')}</td></tr>`).join('')}</tbody></table>`:'<p>정형 항목을 추출하지 못한 자료입니다. 아래 본문을 확인하세요.</p>'}
    ${(d.extraction?.issues||[]).map(i=>`<p>${esc(i)}</p>`).join('')}<div class="evidence-original">${esc(d.text?.slice(0,600))}</div>${d.text?.length>600?`<details><summary>원문 전체 보기</summary><pre>${esc(d.text)}</pre></details>`:''}</article>`).join('')+'</section>';
}
export function assessmentHTML(a){
  if(!a)return '<div class="source-box source-rules"><p>기존 자료입니다. 원문과 현재 처리 조건을 확인하세요.</p></div>';
  return `<section class="source-box source-rules"><span class="source-label">기본 안내 · 규칙 검토</span><h3>${a.status==='pass'?'필수 증빙 검토 통과':'추가 확인이 필요한 증빙'}</h3><p>${esc(a.explanation)}</p>${a.payments.map(p=>`<div class="evidence-check"><strong>${esc(p.paymentId)} · ${{pass:'시스템 자동 검토 통과',manual:'담당자 검토 기록 있음',unknown:'자료·항목 확인 필요',conflict:'불일치 · 지급보류'}[p.status]}</strong><ul>${p.checks.map(k=>`<li>${k.status==='pass'?'✓':k.status==='fail'?'!':'?'} ${esc(k.message)}${k.docId?` <a href="#doc-${esc(k.docId)}">근거 보기</a>`:''}</li>`).join('')}</ul></div>`).join('')}<p>검토 통과 후에도 회계 상신·담당자 결재·지급 실행은 별도입니다.</p></section>`;
}
export function documentFields(defaultKind='account'){
  return `<fieldset data-evidence><legend>원자료 첨부·직접 입력</legend><input type="hidden" name="docId" value="DOC-${crypto.randomUUID()}"><input type="hidden" name="filename">
    <div class="field-grid"><label>자료 종류<select name="kind">${[['account','계좌·명의 확인 자료'],['narrative','설명·요청 자료'],['supplement','보완 회신'],['bank','은행 회신 원자료'],['voucher','전표 원자료'],['uncertain','정책 판단 자료']].map(([id,name])=>`<option value="${id}" ${id===defaultKind?'selected':''}>${name}</option>`).join('')}</select></label><label>자료 제목<input name="evidenceTitle" maxlength="120"></label><label>UTF-8 텍스트 파일<input type="file" name="evidenceFile" accept=".txt,text/plain"></label></div>
    <p class="source-box source-rules">자료의 내용을 입력하거나 텍스트 파일을 첨부하세요. 예금주: … / 계좌번호: … / 작성일: YYYY-MM-DD처럼 항목별로 줄을 나누면 규칙으로 대조합니다. 자료가 없으면 빈 상태로 접수해 보완할 수 있습니다.</p>
    <label>증빙 원문<textarea name="text" maxlength="12000" placeholder="실제 제출할 자료의 본문"></textarea></label>
    <details><summary>증빙의 정형 항목 입력</summary><p>원자료에서 확인한 값만 입력하세요. 빈 항목은 추정해 채우지 않습니다.</p><div class="field-grid">${[['holder','수취 명의','text'],['account','계좌 원문','text'],['date','작성일','date'],['amount','금액','number'],['period','정산월','month'],['requestId','증빙에 표시된 요청 ID','text'],['outcome','은행 처리 결과(success/failed)','text']].map(([id,label,type])=>`<label>${label}<input name="evidence:${id}" type="${type}" ${type==='number'?'min="0" step="1"':''} maxlength="500"></label>`).join('')}</div></details><p data-file-error class="error" role="alert"></p></fieldset>`;
}
export function readDocuments(fields){
  const structured=Object.fromEntries([...fields].filter(([key,value])=>key.startsWith('evidence:')&&String(value).trim()).map(([key,value])=>[key.slice(9),value]));
  const text=String(fields.get('text')||'').trim();
  if(!text&&!Object.keys(structured).length)return [];
  return [{id:fields.get('docId'),kind:fields.get('kind'),title:fields.get('evidenceTitle'),filename:fields.get('filename')||undefined,text:text||'제출자가 원자료에서 입력한 정형 항목',fields:structured}];
}
export function mountEvidenceForms(onError){
  for(const block of document.querySelectorAll('[data-evidence]')){
    block.querySelector('[name=evidenceFile]').onchange=async event=>{
      const file=event.target.files[0];if(!file)return;
      try{
        if(!/\.txt$/i.test(file.name)||file.size>48000)throw Error('UTF-8 .txt 파일을 선택하세요. 본문은 12,000자 이하여야 합니다.');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(!text.trim()||text.length>12000||text.includes('\u0000'))throw Error('비어 있거나 읽을 수 없는 본문입니다. 12,000자 이내의 텍스트를 확인하세요.');
        block.querySelector('[name=text]').value=text;block.querySelector('[name=filename]').value=file.name;block.querySelector('[name=evidenceTitle]').value=file.name;
        block.querySelector('[data-file-error]').textContent='';block.querySelector('[name=text]').dispatchEvent(new Event('input',{bubbles:true}));block.querySelector('[name=text]').dispatchEvent(new Event('change',{bubbles:true}));
      }catch(error){block.querySelector('[data-file-error]').textContent=error.message;onError?.(error.message);}
    };
  }
}
