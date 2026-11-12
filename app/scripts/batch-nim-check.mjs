import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openStore} from '../store.mjs';
import {actorFor,command} from '../domain.mjs';
import {previewIntake} from '../batch-intake.mjs';
import {processOne} from '../ai.mjs';
const store=await openStore({url:'',local:'memory'}),space='qa-batch-nim';
try{await store.create(space);await store.tx(space,s=>{const actor=actorFor('intake'),p=previewIntake(s,actor,{paymentIds:Object.values(s.plans).filter(p=>p.status==='planned').map(p=>p.id),plannedMonth:'2026-07'});command(s,actor,'batchIntake',{...p,requestId:randomUUID()});});
 await processOne(store,space);const s=await store.read(space),j=Object.values(s.jobs)[0];const result={at:new Date().toISOString(),status:j.status,error:j.error,providerCallId:j.providerCallId,decision:j.decision,tasks:Object.values(s.tasks).filter(t=>t.jobId===j.id)};
 if(process.env.W07_CHECK_OUTPUT)writeFileSync(process.env.W07_CHECK_OUTPUT,JSON.stringify(result,null,2));assert.equal(j.status,'applied',JSON.stringify(j.error));assert.equal(j.decision.owner,j.decision.action==='request_supplement'?'intake':'reviewer');assert.equal(j.decision.scope.length,3);console.log(JSON.stringify(result));
}finally{await store.close();}
