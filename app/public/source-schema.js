export const sourceTables={
 agencies:{label:'대리점 마스터',id:'agency_id',fields:[['agency_id','거래처 ID'],['agency_name','거래처명'],['representative_name','대표자'],['address','주소'],['bank_account_no','등록계좌'],['rebate_eligible','장려금 지급 대상(True/False)'],['registered_date','등록일']]},
 payments:{label:'장려금 지급표',id:'rebate_id',fields:[['rebate_id','지급 요청 ID'],['agency_id','거래처 ID'],['period_ym','정산월'],['sales_performance_krw','매출 실적(원)'],['rebate_amount_krw','장려금(원)'],['approval_status','원본 상태(미지급/승인/반려)'],['approver','원본 승인 담당자'],['payment_date','원본 실제 지급일(없으면 NONE)']]},
 collections:{label:'채권 회수 이력',id:'deposit_id',fields:[['deposit_id','입금 ID'],['agency_id','거래처 ID'],['deposit_date','입금일'],['amount_krw','입금액(원)'],['bank_account_no','입금계좌'],['matched_ar_id','연결 채권 ID']]}
};
