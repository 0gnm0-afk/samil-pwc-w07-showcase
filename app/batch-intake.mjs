import {actorFor,basis,command,groups,hash,must,publicState} from './domain.mjs';
export function previewIntake(s,actor,p){
  must(actor.id==='intake','FORBIDDEN','영업지원 직원만 접수할 수 있습니다.',403);
  must(Array.isArray(p.paymentIds)&&p.paymentIds.length>0&&p.paymentIds.length<=500&&new Set(p.paymentIds).size===p.paymentIds.length,'INPUT','중복 없는 검토 요청을 선택하세요.',400);
  must(/^\d{4}-(0[1-9]|1[0-2])$/.test(p.plannedMonth||''),'MONTH','지급예정월을 선택하세요.',400);
  const projected=structuredClone(s),graph=groups(s.source.agencies),batches=new Map();
  for(const id of p.paymentIds){
    const plan=projected.plans[id];must(plan&&plan.status==='planned'&&!plan.caseId&&!s.instructions[id],'CLOSED_ID','이미 접수되었거나 종료된 요청입니다. 목록을 갱신하세요.');
    must(!plan.plannedDate||plan.plannedDate.slice(0,7)===p.plannedMonth,'MONTH_CONFLICT',`${id}의 기존 지급일과 선택한 월이 다릅니다. 기존 일정을 먼저 확인하세요.`);
    plan.plannedMonth=p.plannedMonth;
    const key=graph.components[plan.agencyId][0];if(!batches.has(key))batches.set(key,[]);batches.get(key).push(id);
  }
  const projectedGroups=publicState(projected,actorFor('intake')).intakeGroups;
  const rows=[...batches.values()].map(ids=>{const b=basis(projected,{paymentIds:ids,exceptions:{}}),g=projectedGroups.find(g=>g.month===p.plannedMonth&&g.members.includes(projected.plans[ids[0]].agencyId));return {paymentIds:ids,members:b.members,month:b.month,selectedTotal:b.selectedTotal,total:b.total,missing:b.missing,required:b.required,reviewStatus:g.sourceReview.status};});
  return {paymentIds:p.paymentIds,plannedMonth:p.plannedMonth,groups:rows,total:rows.reduce((n,r)=>n+r.selectedTotal,0),epoch:s.epoch,previewHash:hash({epoch:s.epoch,event:s.events.at(-1)?.id,source:s.sourceRevision,ids:p.paymentIds,month:p.plannedMonth})};
}
export function batchIntake(s,actor,p){
  must(actor.id==='intake','FORBIDDEN','영업지원 직원만 접수할 수 있습니다.',403);
  must(typeof p.requestId==='string'&&/^[a-z0-9-]{10,80}$/i.test(p.requestId),'INPUT','접수 식별값을 확인하세요.',400);
  const signature=hash({ids:p.paymentIds,month:p.plannedMonth});
  const old=s.intakeBatches?.[p.requestId];
  if(old){must(old.signature===signature,'REQUEST_CONFLICT','같은 접수 번호에 다른 입력을 사용할 수 없습니다.');return {...old.result,duplicate:true};}
  const preview=previewIntake(s,actor,p);must(preview.previewHash===p.previewHash,'INTAKE_CHANGED','원본이나 작업 상태가 변경되었습니다. 접수 내용을 다시 확인하세요.');
  must(!s.publicDemo||Object.keys(s.cases).length+preview.groups.length<=100,'DEMO_LIMIT','개인 시연에서는 검토 건을 최대 100개까지 접수할 수 있습니다. 새 시연을 시작하려면 전체 초기화하세요.');
  const draft=structuredClone(s),caseIds=[];
  for(const id of p.paymentIds)draft.plans[id].plannedMonth=p.plannedMonth;
  for(const group of preview.groups){
    const result=command(draft,actor,'intake',{paymentIds:group.paymentIds,title:`${group.members.join(' · ')} / ${p.plannedMonth} 지급 검토`,docs:[],batch:true});caseIds.push(result.caseId);
  }
  const result={caseIds,count:p.paymentIds.length,groups:caseIds.length};
  draft.intakeBatches??={};draft.intakeBatches[p.requestId]={signature,result};Object.assign(s,draft);return result;
}
