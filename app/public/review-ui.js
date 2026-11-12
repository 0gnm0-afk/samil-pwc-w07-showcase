import {documentCards} from './evidence-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won=v=>Number(v||0).toLocaleString('ko-KR')+'원';
const names={sales:'영업지원팀장',executive:'영업 임원',finance:'재무 임원'};
const agencyName=(s,id)=>s.agencies.find(a=>a.agency_id===id)?.agency_name||id;
const recipient=c=>c.reviewSummary.recipients.join('·');
export function caseOverview(c,s,paymentId){
 const b=c.currentBasis,plans=(paymentId?[paymentId]:c.paymentIds).map(id=>s.plans.find(p=>p.id===id));
 const selectedAmount=plans.reduce((sum,p)=>sum+p.amount,0),approved=!c.needsResubmit&&c.currentBasis.required.every(r=>c.approvals.some(a=>a.version===c.version&&a.userId===r.userId&&a.decision==='approve'));
 return `<section class="case-overview"><p class="eyebrow">${esc(b.month)} 지급 예정 · ${esc([...new Set(plans.map(p=>p.period))].join('·'))} 정산분</p><h2>${esc([...new Set(plans.map(p=>agencyName(s,p.agencyId)))].join(' · '))} 판매장려금</h2><div class="amount-grid"><div><span>${paymentId?'지금 처리할 지급 요청':'이번 결재 요청'} · ${plans.length}건</span><strong>${won(selectedAmount)}</strong></div><div><span>관련 거래처의 같은 달 합산액</span><strong>${won(b.total)}</strong></div></div><p>승인권한은 이번 요청뿐 아니라 관련 거래처의 같은 달 지급 완료·지급 예정 금액을 합쳐 정합니다. ${approved?esc(recipient(c))+'의 승인이 완료되었습니다.':'이번 건은 '+esc(recipient(c))+'의 결재가 필요합니다.'}${paymentId?' 지금은 결재 묶음 중 '+esc(paymentId)+' 한 건을 처리합니다.':''}</p><details><summary>지급 대상과 합산 내역 보기</summary><div class="table-wrap"><table><thead><tr><th>거래처</th><th>요청</th><th>이번 지급액</th><th>수취계좌</th></tr></thead><tbody>${plans.map(p=>`<tr><td>${esc(agencyName(s,p.agencyId))}</td><td>${esc(p.id)}</td><td>${won(p.amount)}</td><td>${esc(p.accountLabel)}</td></tr>`).join('')}</tbody></table></div><p>관련 거래처: ${esc(b.members.map(id=>agencyName(s,id)).join(' · '))}</p><ul>${b.rows.map(r=>`<li>${esc(r.id)} · ${won(r.amount)} · ${esc(r.date||b.month)}${c.paymentIds.includes(r.id)?' · 이번 지급 대상':''}</li>`).join('')}</ul>${b.edges.map(e=>`<p>${esc(agencyName(s,e.from))} ↔ ${esc(agencyName(s,e.to))}: ${esc(e.fields.map(f=>({representative_name:'대표자',address:'주소',accountKey:'정산계좌'})[f]).join('·'))} 일치</p>`).join('')}</details></section>`;
}
export function judgmentHTML(c){
 const r=c.reviewSummary,opinion=r.opinion||r.acceptedOpinion;
 let body='';
 if(r.status==='analyzing')body='<section class="judgment waiting" role="status"><h3>자동 대조로 결론을 내리기 어려운 내용을 AI가 검토하고 있습니다</h3><p>아래 확인 사항과 연결된 원본을 전달했습니다. 결과가 도착하면 이 화면에 표시됩니다.</p></section>';
 else if(r.status==='failed')body='<section class="judgment waiting"><h3>AI 검토 결과를 받지 못했습니다</h3><p>자동으로 통과시키지 않았습니다. 다시 검토를 요청하거나 회계 담당자가 원본을 확인하고 판단 근거를 기록할 수 있습니다.</p></section>';
 if(r.status==='ready')body+=`<section class="judgment checked"><span class="eyebrow">${r.source==='person'?'회계 담당자 확인':'자료 자동 대조'}</span><h3>${r.source==='person'?'담당자의 확인 결과가 기록되어 결재를 요청할 수 있습니다':'자동으로 대조한 항목에서 차이가 발견되지 않았습니다'}</h3><p>${esc(r.comparison)}</p><p class="meta">${esc(r.limitation)}</p></section>`;
 if(opinion)body+=`<section class="judgment ai"><span class="eyebrow">${r.opinion?'AI 검토 의견':'회계 담당자가 확인한 AI 의견'}</span><h3>${({recommend_proceed:'근거를 확인하고 다음 결재로 진행할 것을 권고합니다',request_supplement:'자료를 보완한 뒤 다시 검토할 것을 권고합니다',hold_for_review:'지급을 보류하고 추가 판단할 것을 권고합니다',request_review:'회계 담당자의 사실 확인이 필요합니다',recheck:'새로 받은 근거를 확인해야 합니다'})[opinion.action]||'AI가 확인한 내용'}</h3><p>${esc(opinion.reason)}</p>${opinion.unknowns?.length?'<h4>아직 확인할 내용</h4><ul>'+[...new Set(opinion.unknowns)].map(t=>`<li>${esc(t)}</li>`).join('')+'</ul>':''}<details><summary>AI가 판단에 사용한 근거</summary>${(opinion.facts||[]).map(f=>`<blockquote><p>${esc(f.text)}</p><details><summary>원본 인용 보기</summary><p>${esc(f.quote)}</p></details></blockquote>`).join('')}</details></section>`;
 if(r.issues.length)body+=`<section class="judgment"><h3>확인할 사항 ${r.issues.length}개</h3>${r.issues.map(i=>`<article class="review-issue"><p>${esc(i.message)}</p><details><summary>관련 자료 ${i.docIds.length}개 · 영향을 받는 지급 ${i.paymentIds.length}건</summary><p>${esc(i.paymentIds.join(' · '))}</p></details></article>`).join('')}</section>`;
 if(r.holds.length)body+=`<section class="judgment"><h3>다음 단계로 가기 전에 필요한 확인</h3><ul>${[...new Set(r.holds.map(h=>h.reason))].map(t=>`<li>${esc(t)}</li>`).join('')}</ul></section>`;
 const ids=new Set([...(c.evidenceAssessment?.payments||[]).flatMap(p=>p.docIds||[]),...(opinion?.facts||[]).map(f=>f.docId)]);
 body+=documentCards(c.docs.filter(d=>ids.has(d.id)||['supplement','narrative','account'].includes(d.kind)));
 return body;
}
export function reviewFormHTML(c){
 const r=c.reviewSummary,to=recipient(c);let actions='';
 if(r.canSubmit)actions=`<button class="primary" data-review="submit">확인 후 ${esc(to)}에게 결재 요청</button><p>검토한 자료와 합산 결과를 함께 보냅니다. 결재권자의 승인이 완료되면 자금팀이 지급합니다.</p>`;
 else if(r.status==='analyzing')actions='<p>검토 결과를 기다리고 있습니다. 입력이나 검토 의뢰를 반복할 필요가 없습니다.</p>';
 else{
  if(r.canAccept)actions+=`<button class="primary" data-review="accept">AI 권고 수용 후 ${esc(to)}에게 결재 요청</button><p>AI가 인용한 근거를 확인하고 권고를 수용한 사실을 함께 기록합니다.</p>`;
  else if(r.canConfirm)actions+=`<form id="reviewConfirm" class="stack"><label>확인한 사실과 판단 근거<textarea name="reason" required minlength="8" maxlength="4000" placeholder="위 질문에 대해 확인한 내용과 그 근거를 적어주세요."></textarea></label><button class="primary" type="submit">확인한 내용으로 ${esc(to)}에게 결재 요청</button></form>`;
  if(r.canRetry)actions+='<button data-review="retry">AI 검토 다시 요청</button>';
  if(r.requestedSupplement)actions+=`<p class="action-note">영업직원에게 자료를 요청했습니다. ${esc(r.requestedSupplement.reason)} 회신을 받으면 다시 검토합니다.</p>`;
 }
 if(r.status!=='analyzing')actions+=`<details class="supporting-form"><summary>추가 자료가 필요하거나 진행할 수 없는 경우</summary><form id="reviewFollowup" class="stack"><label>필요한 자료 또는 진행할 수 없는 이유<textarea name="reason" required minlength="4" maxlength="4000"></textarea></label><div class="row">${!r.requestedSupplement?'<button name="action" value="supplement" type="submit">영업직원에게 자료 요청</button>':''}<button name="action" value="hold" type="submit">사유 기록 후 지급 보류</button></div></form></details>`;
 return judgmentHTML(c)+`<section class="decision-panel"><h3>회계 담당자 결정</h3>${actions}</section><details class="supporting-details"><summary>자료에 없는 새로운 문제를 발견한 경우</summary><form id="flag" class="stack"><label>새로 확인한 내용과 근거<textarea name="reason" required maxlength="4000"></textarea></label><label class="checkbox"><input type="checkbox" name="conflict">영업 임원에게 이해상충이 있음</label><label class="checkbox"><input type="checkbox" name="policy">일반 정책을 벗어나는 예외 지급 요청임</label><button type="submit">새 확인사항 등록</button></form></details>`;
}
export function approvalFormHTML(c,user){
 const special=c.currentBasis.required.length===2;
 const othersApproved=c.currentBasis.required.filter(r=>r.userId!==user.id).every(r=>c.approvals.some(a=>a.version===c.version&&a.userId===r.userId&&a.decision==='approve'));
 const focus=user.id==='finance'?'관련 거래처의 월 합산액, 수취계좌와 증빙, 예외 지급 조건을 확인해 주세요.':user.id==='sales'?'관련 거래처의 월 합산액이 200만 원 이하인 일반 요청입니다. 회계 검토 결과를 확인하고 지급 여부를 결정해 주세요.':special?'이번 예외 지급의 사업상 사유와 필요성을 확인해 주세요. 재무 임원은 합산·증빙·지급 조건을 별도로 검토합니다.':'관련 거래처의 월 합산액이 200만 원을 초과해 영업 임원 결재가 필요한 요청입니다. 지급 근거와 사업상 사유를 확인해 주세요.';
 const statuses=c.currentBasis.required.map(r=>{const a=c.approvals.find(a=>a.version===c.version&&a.userId===r.userId);return `${names[r.userId]}: ${{approve:'승인 완료',pending:'결재 대기',supplement:'보완 요청',reject:'반려',closed:'종료'}[a?.decision]||'결재 요청 전'}`;});
 return `<section class="decision-panel"><h3>${user.id==='finance'?'지급 조건에 대한 재무 판단':user.id==='executive'?'지급 사유에 대한 영업 판단':'팀장 결재'}</h3><p>${esc(focus)}</p><p>${esc(statuses.join(' · '))}</p><p>${special?'두 임원이 모두 같은 내용에 승인해야 자금팀이 지급할 수 있습니다.':'승인하면 자금팀의 지급 작업으로 넘어갑니다.'}</p><form id="decide" class="stack"><label>결재 결정<select name="decision" id="decisionChoice"><option value="approve">승인</option><option value="supplement">보완 요청</option><option value="reject">반려</option></select></label><label id="decisionReasonLabel">결정에 남길 의견 (선택)<textarea name="reason" maxlength="4000"></textarea></label><p id="decisionEffect">${special?(othersApproved?'승인하면 두 임원의 결재가 모두 완료되어 자금팀에 지급 작업이 열립니다.':'다른 임원의 결재도 완료되면 자금팀에 지급 작업이 열립니다.'):'자금팀에 승인된 지급 작업을 보냅니다.'}</p><button type="submit" class="primary">승인 기록</button></form></section>${Object.values(c.exceptions).length?'<section class="judgment"><h3>특별승인이 필요한 이유</h3><ul>'+Object.values(c.exceptions).map(e=>`<li>${esc(e.reason)}</li>`).join('')+'</ul></section>':''}${judgmentHTML(c)}`;
}
export function noticeHTML(c){return `<section class="judgment waiting"><h3>예외 사항을 먼저 알려드립니다</h3><p>영업 임원과 재무 임원에게 같은 건을 공개했습니다. 회계팀이 자료와 지급 근거를 확인 중이므로 아직 결재할 수 없습니다. 회계 검토가 끝나면 결재 요청으로 표시됩니다.</p>${Object.values(c.exceptions).map(e=>`<p>${esc(e.reason)}</p>`).join('')}</section>${judgmentHTML(c)}`;}

export function reconciliationFormHTML(instruction,receipt,docs,sourceMode){
 const voucher=instruction.vouchers?.at(-1),actual=instruction.reconciliation==='difference'&&voucher;
 const voucherForm=`<form id="reconcile" class="stack"><input type="hidden" name="voucherId" value="VOUCHER-${crypto.randomUUID().slice(0,8)}"><label>전표에 기록된 지급액 (모의)<input name="amount" type="number" min="0" step="1" value="${voucher?.amount??(sourceMode?receipt.amount:'')}" required></label><button class="primary" type="submit">${actual?'수정한 전표로 다시 비교':'전표 기록하고 지급 결과 비교'}</button></form>`;
 const comparison=`<p>승인·지시 금액 ${won(instruction.amount)} · 은행에서 처리한 금액 ${won(receipt.amount)} · ${esc(receipt.date)} · ${esc(receipt.accountLabel)}</p>`;
 if(!actual)return comparison+voucherForm;
 const relevant=docs.filter(d=>!d.paymentIds?.length||d.paymentIds.includes(instruction.paymentId));
 return comparison+`<section class="judgment"><h3>지급 결과와 전표를 비교했습니다. 차이를 확인해 주세요.</h3><ul>${(instruction.differences||[]).map(d=>`<li>${esc(d.message)}</li>`).join('')}</ul><p>전표에는 ${won(voucher.amount)}이 기록되어 있습니다. 확인한 실제 지급액·처리일과 차이의 근거를 남기면 관련 미지급 요청의 월 합산에도 반영합니다.</p><form id="confirmActual" class="stack"><div class="field-grid"><label>확인한 실제 지급액<input type="number" min="0" step="1" name="amount" value="${receipt.amount}" required></label><label>확인한 실제 처리일<input name="date" type="date" value="${esc(receipt.date)}" required></label><label>대사에 참고한 자료<select name="docId">${(relevant.length?relevant:docs).map(d=>`<option value="${esc(d.id)}">${esc(d.title||({bank:'은행 처리결과 자료',voucher:'회계 전표 자료',account:'수취계좌 확인 자료',supplement:'보완 회신',narrative:'추가 설명자료',source:'연결된 원본 자료'})[d.kind]||'제출 자료')}</option>`).join('')}</select></label></div><label>차이를 확인한 근거와 최종 판단<textarea name="reason" required maxlength="4000" placeholder="어떤 자료와 확인을 통해 실제 지급액·처리일을 확정했는지 적어주세요."></textarea></label><button type="submit" class="primary">확인한 지급 결과 기록</button></form></section><details class="supporting-form"><summary>전표 금액을 수정해야 하는 경우</summary>${voucherForm}</details>${documentCards(relevant.length?relevant:docs)}`;
}

export function resultHTML(c,s,item,action,reviewAction){
 const instruction=s.instructions.find(i=>i.paymentId===item.paymentId||i.id===item.instructionId);
 const outputs={
  reviewAction:reviewAction==='supplement'?['영업직원에게 보완 자료를 요청했습니다','회신이 도착하면 다시 검토합니다. 그동안 지급할 수 없습니다.']:reviewAction==='hold'?['지급을 보류했습니다','보류 사유를 기록했습니다. 확인이 끝날 때까지 결재와 지급을 진행할 수 없습니다.']:[`${recipient(c)}에게 결재를 요청했습니다`,'회계에서 확인한 자료와 합산 결과를 함께 보냈습니다. 필요한 결재가 모두 완료되면 자금팀이 지급합니다.'],
  decide:c.status==='rejected'?['이 지급 요청을 반려했습니다','현재 요청은 종료됐으며 지급할 수 없습니다.']:c.needsResubmit?['회계팀에 보완 확인을 요청했습니다','자료와 근거를 다시 확인할 때까지 지급을 멈춥니다.']:c.canPay?['필요한 결재가 모두 완료됐습니다','다음 담당자는 자금팀입니다. 승인된 금액·계좌·지급월에 따라 모의 지급을 지시할 수 있습니다.']:['담당자의 승인을 기록했습니다','다른 결재권자의 승인이 남아 있습니다. 모든 승인이 완료될 때까지 지급할 수 없습니다.'],
  pay:['모의 지급 지시를 기록했습니다','이어서 자금팀에서 은행 처리결과를 기록합니다. 실제 은행으로 송금하지 않았습니다.'],
  bank:['은행 처리결과를 기록했습니다',instruction?.reconciliation==='failed'?'은행 확정 실패로 이 지급 건을 종료했습니다.': '다음 담당자는 회계팀입니다. 승인·지급 지시·은행 결과와 전표를 비교합니다.'],
  reconcile:instruction?.reconciliation==='matched'?['지급 결과와 전표가 일치합니다',c.status==='completed'?'이 요청의 지급과 대사가 모두 완료됐습니다.':'이 지급 건의 대사를 완료했습니다. 같은 묶음의 남은 지급 건은 계속 처리합니다.']:['지급 결과와 전표에 차이가 있습니다','회계팀이 실제 지급액과 처리일, 확인 근거를 기록해야 합니다.'],
  confirmActual:['실제 지급액과 처리일을 기록했습니다','확인된 실적을 합산에 반영했습니다. 영향을 받는 미지급 요청은 다시 검토합니다.'],
  documents:['보완 자료를 전달했습니다','새 자료를 반영해 자동 대조하고, 추가 판단이 필요하면 AI 검토 후 회계팀이 확인합니다.'],
  changeMonth:['지급예정월을 변경했습니다','회계팀이 변경된 월 합산과 지급 근거를 확인하고 결재를 다시 요청합니다.'],
  change:['지급 조건 변경을 기록했습니다','기존 승인으로 지급할 수 없습니다. 회계 재검토 후 필요한 결재를 다시 받아야 합니다.']
 };
 const [title,description]=outputs[action]||['처리 내용을 기록했습니다','내 작업에서 남은 업무를 확인할 수 있습니다.'];
 return `<section class="judgment checked"><h2>${esc(title)}</h2><p>${esc(description)}</p></section><button type="button" id="backToInbox">내 작업으로 돌아가기</button>`;
}
