// Shared by the browser and server so displayed choices and guidance use the same contract.
export const catalogVersion = 'modules-2';
export const roleNames = {
  intake:'일반 영업지원 직원', sales:'영업지원팀장(전결)', reviewer:'회계팀', reconciler:'회계팀',
  executive:'영업 임원', finance:'재무 임원', treasury:'자금팀', nim:'AI 검토', rules:'서버 검사', admin:'시연 관리자'
};
export const evidencePresets = [
  {id:'verified',label:'명의·계좌 확인 완료',kind:'account',text:'모의 계좌·명의 확인서에서 지급 요청의 등록 수취계좌와 거래처 명의가 일치함을 확인했습니다.'},
  {id:'missing',label:'예금주 확인서 누락',kind:'narrative',text:'모의 지급 요청입니다. 예금주 확인서가 누락되었습니다. 은행에서 발급받은 예금주 확인서를 제출할 수 있습니다.'},
  {id:'changed',label:'계좌 변경 후 새 증빙 부족',kind:'narrative',text:'승인 후 모의 수취계좌가 변경되었습니다. 변경된 계좌의 예금주 확인서가 누락되었습니다. 새 계좌와 명의를 확인할 은행 발급 자료를 제출할 수 있습니다.'},
  {id:'conflicting',label:'자료 간 명의·계좌 불일치',kind:'narrative',text:'모의 요청서의 수취 명의와 계좌가 예금주 확인서의 명의 및 계좌와 서로 일치하지 않습니다. 어느 자료가 현재 유효한지 회계 확인이 필요합니다.'},
  {id:'reply',label:'요청받은 계좌·명의 자료 보완',kind:'supplement',text:'모의 은행 발급 예금주 확인서를 제출했습니다. 현재 지급 요청의 수취계좌와 거래처 명의가 일치하는 자료이며 회계팀의 재검토를 요청합니다.'},
  {id:'bankProof',label:'은행 처리 결과 확인 자료',kind:'bank',text:'모의 은행 회신의 거래 식별자·실제 처리일·금액·수취계좌를 대조한 확인 자료입니다.'},
  {id:'voucherProof',label:'전표와 은행 실적 대조 자료',kind:'voucher',text:'모의 전표와 은행의 최종 처리 결과를 대조했습니다. 지급별 실제 금액과 처리일에 대한 회계 확인 근거입니다.'}
];
export const evidenceOptions=kind=>evidencePresets.filter(p=>!['bank','voucher'].includes(p.kind)||p.kind===kind);
// Describes the controls shown in each module, including unsaved choices.
export const moduleFields={
  register:{agencyId:'거래처 선택',amount:'새 요청의 원 단위 금액',period:'정산월',plannedDate:'지급예정일',csv:'UTF-8 CSV 파일, 최대 50건'},
  intake:{paymentIds:'이번 결재 대상 선택',preset:'시연 증빙 선택',text:'선택한 증빙 본문 또는 기타 직접 작성',exception:'신고·확인 사항',exceptionReason:'신고 사유',plannedDate:'미정 요청의 예정일 지정'},
  evidence:{docIds:'대조할 제출 증빙 선택',confirmPaymentIds:'증빙으로 실제 대조한 지급 건',reasonChoice:'검토 사유 선택',reason:'기타 직접 작성'},
  holds:{resolveKeys:'근거로 해소를 확인한 보류 항목',special:'정책 예외 특별승인',conflict:'영업 임원 이해상충',reasonChoice:'추가 판단 사유 선택',preset:'추가 증빙 선택',text:'추가 증빙 본문'},
  approval:{decision:'승인·보완 요청·반려',reasonChoice:'결정 사유 선택',reason:'기타 직접 작성'},
  supplement:{preset:'보완 자료 선택',text:'보완 회신 본문'},
  change:{paymentId:'변경할 미집행 지급 요청',account:'새 수취계좌 입력, NIM에는 입력 여부만 전달',owner:'새 수취 명의',date:'변경 지급예정일',preset:'변경 후 증빙 선택',text:'변경 근거 본문'},
  bank:{outcome:'성공 또는 확정 실패',bankScenario:'지시와 같은 금액·1원 차이·기타 금액',amount:'회신 금액',date:'실제 회신 처리일',account:'다른 수취계좌가 있는 경우 입력'},
  reconcile:{voucherScenario:'회신과 같은 금액·1원 차이·기타 금액',amount:'전표 금액',preset:'대사 근거 추가',text:'은행·전표 확인 자료'},
  actual:{amount:'확정 실제 지급액',date:'실제 처리일',docId:'확인 근거 선택',reasonChoice:'확인 사유 선택',reason:'기타 직접 작성'}
};
export function approvalFocus(actor,special){
  if(actor==='sales')return {node:'W07I_Delegated',purpose:'월 합산 200만 원 이하 일반 건의 지급 근거와 직원의 접수 내용을 독립적으로 검토합니다.'};
  if(actor==='finance')return {node:'W07I_FinanceVote',purpose:'특별승인의 월 합산·명의 증빙·지급 조건과 예외 근거를 검토합니다. 같은 버전의 영업 임원 승인도 있어야 지급됩니다.'};
  return special?{node:'W07I_Business',purpose:'특별승인 요청의 사업상 타당성과 예외 사유를 검토합니다. 같은 버전의 재무 임원 승인도 있어야 지급됩니다.'}:{node:'W07I_Regular',purpose:'월 합산 200만 원 초과 일반 건의 사업상 타당성과 지급 근거를 검토합니다.'};
}
export const reasonChoices = {
  review:[['matched','선택한 증빙으로 계좌·명의 대조 완료','선택한 현재 증빙을 지급 요청의 수취계좌 및 거래처 명의와 대조했습니다.'],['resolved','보완 회신과 보류 사유 확인 완료','연결된 보완 회신을 확인하고 선택한 보류 사유의 해소 근거를 검토했습니다.'],['policy','정책 예외에 대한 특별승인 필요','지급 근거를 검토했으며 정책 예외로 영업 임원과 재무 임원의 같은 버전 승인이 필요합니다.']],
  flag:[['missing','필요한 자료가 부족함','예금주 확인서가 누락되어 은행 발급 자료의 보완과 회계 재검토가 필요합니다.'],['conflicting','자료 내용이 서로 다름','요청서와 증빙의 지급 조건이 서로 달라 현재 유효한 자료를 확인해야 합니다.'],['uncertain','정책 적용에 추가 판단 필요','기존 지급 정책으로 처리 가능 여부를 확정하기 어려워 회계팀의 추가 판단과 상위 보고 검토가 필요합니다.']],
  approve:[['supported','현재 근거와 담당 검토 항목 확인','현재 검토 버전의 지급 근거와 담당 승인 요건을 확인하여 승인합니다.']],
  supplement:[['proof','계좌·명의 증빙 보완 필요','현재 수취계좌와 명의를 확인할 증빙을 보완하고 회계팀의 재검토를 요청합니다.'],['basis','사업상 근거·예외 사유 보완 필요','지급의 사업상 근거 또는 예외 사유에 대한 자료를 보완하고 재검토를 요청합니다.']],
  reject:[['unsupported','지급 근거 충족 어려움','검토 자료로 지급 근거를 충족하기 어렵다고 판단하여 이번 요청을 반려합니다.']],
  actual:[['bankFinal','은행 최종 실적과 전표 확인 완료','선택한 은행 최종 실적 자료와 전표를 대조하여 실제 지급 금액과 처리일을 확인했습니다.']],
  exception:[['policy','정책 예외 지급 검토','일반 지급 조건을 벗어난 모의 요청으로 양쪽 임원의 특별승인을 요청합니다.'],['aggregation','월 합산 범위 추가 확인','관련 거래처 및 지급예정월의 합산 범위에 추가 확인이 필요합니다.'],['conflict','영업 임원 이해상충','영업 임원의 이해상충이 확인되어 적격 승인 경로와 상위 판단이 필요합니다.'],['uncertain','기존 정책에 없는 상황','기존 지급 정책에 명시되지 않은 상황으로 회계팀의 추가 판단이 필요합니다.']]
};
const define = (title,purpose,node,capabilities,actions) => ({title,purpose,node,capabilities,actions});
export const modules = {
  inbox:define('내 작업 안내','배정된 작업의 목적과 다음 담당자를 확인하고 처리할 작업을 선택합니다.','W07I_Start',[],[['open','작업 열기','선택한 업무의 자료와 처리 화면을 엽니다.']]),
  register:define('신규 지급 요청 등록','거래처·금액·정산월·지급예정일을 등록하면 같은 관련자·지급월 묶음에 포함됩니다.','W07I_Receive',['intake'],[['registerRequests','요청 등록','미접수 목록에 등록합니다. 묶음에서 결재 대상을 선택해 접수하세요.']]),
  intake:define('묶음에서 지급 요청 접수','이번에 결재할 요청과 증빙을 선택합니다. 월 합산에는 선택하지 않은 유효 지급도 포함됩니다.','W07I_Receive',['intake'],[['intake','선택한 요청 접수','회계팀에 지급 근거 검토 작업을 보냅니다.'],['schedule','예정일 저장','선택 요청의 지급예정월 묶음을 다시 계산합니다.']]),
  basis:define('지급 대상·월 합산 확인','이번 결재 대상과 월 합산의 차이, 연결된 거래처, 적용 승인권자를 확인합니다.','W07I_Review',['reviewer'],[['inspect','합산 근거 확인','같은 월 유효 지급과 관련 거래처 연결 근거를 확인합니다.']]),
  evidence:define('계좌·명의와 증빙 확인','현재 지급 조건에 적용되는 증빙을 고르고 대조한 지급 건을 확인합니다.','W07I_Review',['reviewer'],[['review','검토 저장','선택 증빙으로 확인한 지급 건과 사유를 기록하고 상신 요건을 재검사합니다.']]),
  holds:define('보류·예외 처리','남은 보류 사유별 근거를 확인하거나 자료 보완·추가 판단을 요청합니다.','W07I_Rework',['reviewer'],[['review','확인 결과 저장','선택한 보류 사유의 확인 근거를 기록합니다.'],['flag','지급보류 · AI 검토 의뢰','NIM이 근거를 검토해 영업지원 보완 또는 회계 확인 작업을 만듭니다.'],['documents','증빙 추가','새 자료를 현재 검토 건에 연결합니다.']]),
  submit:define('검토 결과·결재 상신','검토 결과와 남은 요건을 확인하고 현재 근거를 승인권자에게 상신합니다.','W07I_Route',['reviewer'],[['submit','현재 검토 버전 상신','현재 근거를 확정해 필요한 승인권자에게 결재를 배정합니다. 특별승인은 양쪽에 동시에 배정합니다.']]),
  approval:define('결재 판단','담당 검토 항목과 현재 버전의 근거를 확인한 뒤 승인·보완 요청·반려를 결정합니다.','W07I_Outcome',['sales','executive','finance'],[['approve','승인','담당자의 승인을 기록합니다. 필수 승인이 모두 완료되어야 지급할 수 있습니다.'],['supplement','보완 요청','지급을 보류하고 회계팀에 재검토를 보냅니다. 다른 미결 결재도 닫힙니다.'],['reject','반려','이번 요청을 종료하고 미집행 지급을 차단합니다.']]),
  supplement:define('증빙 보완 회신','요청받은 자료와 이유를 읽고 해당 작업에 보완 자료를 연결합니다.','W07I_Supplement',['intake'],[['documents','보완 회신 보내기','회계팀에 이 보완 작업과 연결된 재검토 작업을 보냅니다.']]),
  change:define('지급조건 변경','변경할 미집행 요청과 새 계좌·명의·예정일, 증빙을 확인합니다.','W07I_Prepay',['intake'],[['change','변경 저장 · 지급보류','기존 승인 근거를 무효화하고 새 지급 조건에 대한 회계 재검토와 증빙 보완으로 연결합니다.']]),
  pay:define('지급 준비 확인·모의 지급','현재 버전의 필수 승인과 수취계좌·금액·예정일을 확인합니다.','W07I_Pay',['treasury'],[['pay','현재 승인 버전으로 지급 지시','모의 지급 지시를 기록합니다. 이어서 은행 회신을 등록하세요.']]),
  bank:define('은행 회신 등록','모의 은행 처리 결과를 지급 지시와 연결합니다. 금액·계좌·일자 차이는 후속 확인 대상입니다.','W07I_Pay',['treasury'],[['bank','은행 회신 저장','성공 회신은 회계팀 전표 대사로, 차이는 회계 확인으로 이어집니다.']]),
  reconcile:define('지급 결과 대사','지급 지시·은행 회신·전표의 금액과 수취계좌·처리일을 대조합니다.','W07I_Reconcile',['reconciler'],[['reconcile','전표 입력·대사','일치하면 지급 건의 대사를 완료하고 차이가 있으면 확인 작업을 유지합니다.']]),
  actual:define('차이 확인·실제 지급액 기록','은행 최종 실적과 전표를 확인해 실제 금액·처리월을 확정합니다.','W07I_Reconcile',['reconciler'],[['confirmActual','차이 확인 저장','확정 실적을 월 합산에 반영합니다. 영향받은 미집행 건은 재검토·재상신합니다.']]),
  result:define('처리 결과와 다음 담당자','저장된 결과와 실제 진행 위치, 이어서 처리할 담당자를 확인합니다.','W07I_Outcome',[],[['open','내 작업 보기','현재 역할에 배정된 남은 작업을 확인합니다.']])
};
