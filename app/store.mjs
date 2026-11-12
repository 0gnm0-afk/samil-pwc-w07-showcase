import pg from 'pg';
import { readFileSync } from 'node:fs';
import { initialState, must, now, uid } from './domain.mjs';
export const source=JSON.parse(readFileSync(new URL('./data/source.json',import.meta.url),'utf8'));
const schema=`
CREATE TABLE IF NOT EXISTS w07_workspaces (id text PRIMARY KEY, state jsonb NOT NULL, validation boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS w07_users (id text PRIMARY KEY, password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS w07_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES w07_users(id), expires_at timestamptz NOT NULL);
ALTER TABLE w07_sessions ADD COLUMN IF NOT EXISTS public_workspace text;
CREATE TABLE IF NOT EXISTS w07_public_limits (bucket text PRIMARY KEY, used integer NOT NULL CHECK(used>=0));
CREATE TABLE IF NOT EXISTS w07_instructions (workspace_id text NOT NULL REFERENCES w07_workspaces(id), payment_id text NOT NULL, instruction_id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(workspace_id,payment_id), UNIQUE(workspace_id,instruction_id));
CREATE TABLE IF NOT EXISTS w07_approvals (workspace_id text NOT NULL REFERENCES w07_workspaces(id), case_id text NOT NULL, version integer NOT NULL, role text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(workspace_id,case_id,version,role));
CREATE TABLE IF NOT EXISTS w07_receipts (workspace_id text NOT NULL REFERENCES w07_workspaces(id), receipt_id text NOT NULL, instruction_id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(workspace_id,receipt_id), UNIQUE(workspace_id,instruction_id));
`;
export async function openStore({url=process.env.DATABASE_URL,local=process.env.W07_LOCAL_DB}={}) {
  let pool, embedded, gate=Promise.resolve();
  if(url)pool=new pg.Pool({connectionString:url,max:6,connectionTimeoutMillis:10000});
  else {must(process.env.NODE_ENV!=='production'&&local,'DB_CONFIG','운영에는 AXHub DATABASE_URL이 필요합니다.');const {PGlite}=await import('@electric-sql/pglite');embedded=new PGlite(local==='memory'?undefined:local);await embedded.waitReady;}
  const query=(sql,params)=>pool?pool.query(sql,params):embedded.query(sql,params);
  if(pool)await pool.query(schema);else await embedded.exec(schema);
  const exclusive=async fn=>{const before=gate;let done;gate=new Promise(r=>done=r);await before;try{return await fn();}finally{done();}};
  async function transaction(fn){
    if(embedded)return exclusive(()=>embedded.transaction(tx=>fn(tx)));
    const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async function tx(id,fn){return transaction(async client=>{
    const {rows}=await client.query('SELECT state, validation FROM w07_workspaces WHERE id=$1 FOR UPDATE',[id]);must(rows[0],'WORKSPACE','작업공간이 없습니다.',404);
    const s=rows[0].state;const result=await fn(s,{validation:rows[0].validation});
    // Business preconditions and uniqueness projections commit under the same workspace row lock.
    for(const i of Object.values(s.instructions))await client.query('INSERT INTO w07_instructions(workspace_id,payment_id,instruction_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,payment_id) DO UPDATE SET body=EXCLUDED.body',[id,i.paymentId,i.id,JSON.stringify(i)]);
    for(const c of Object.values(s.cases))for(const a of c.approvals)await client.query('INSERT INTO w07_approvals(workspace_id,case_id,version,role,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,case_id,version,role) DO UPDATE SET body=EXCLUDED.body',[id,c.id,a.version,a.role,JSON.stringify(a)]);
    for(const r of Object.values(s.receipts))await client.query('INSERT INTO w07_receipts(workspace_id,receipt_id,instruction_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,receipt_id) DO NOTHING',[id,r.id,r.instructionId,JSON.stringify(r)]);
    await client.query('UPDATE w07_workspaces SET state=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(s)]);return result;
  });}
  async function create(id,fixture='demo',{reset=false,validation=false}={}) {
    must(/^(demo|qa-[a-z0-9-]{1,70})$/.test(id),'WORKSPACE','작업공간 ID 형식 오류',400);
    must(id!=='demo'||fixture==='demo','FIXTURE','합성 자료는 검증 공간에서만 사용합니다.',400);
    return transaction(async client=>{
      await client.query('INSERT INTO w07_workspaces(id,state,validation) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[id,JSON.stringify(initialState(source,fixture)),validation]);
      if(reset){await client.query('SELECT id FROM w07_workspaces WHERE id=$1 FOR UPDATE',[id]);for(const table of ['w07_instructions','w07_approvals','w07_receipts'])await client.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[id]);await client.query('UPDATE w07_workspaces SET state=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(initialState(source,fixture))]);}
    });
  }
  async function spend(client,bucket,limit,code){const r=await client.query('INSERT INTO w07_public_limits(bucket,used) VALUES($1,1) ON CONFLICT(bucket) DO UPDATE SET used=w07_public_limits.used+1 WHERE w07_public_limits.used<$2 RETURNING used',[bucket,limit]);must(r.rows.length,code,'공개 체험의 일일 한도에 도달했습니다. 다음 날 다시 이용하세요.',429);}
  async function createTrial(tokenHash,userId='intake',anchorHash){return transaction(async client=>{
    await spend(client,`start:${now().slice(0,10)}`,100,'DEMO_LIMIT');
    const id=uid('trial'),s=initialState(source);s.publicDemo={authVersion:2,createdAt:now(),expiresAt:new Date(Date.now()+2*60*60*1000).toISOString(),aiUsed:0,aiLimit:3};
    await client.query('INSERT INTO w07_workspaces(id,state,validation) VALUES($1,$2,false)',[id,JSON.stringify(s)]);
    await client.query('INSERT INTO w07_sessions(token_hash,user_id,expires_at,public_workspace) VALUES($1,$2,$3,$4)',[tokenHash,userId,s.publicDemo.expiresAt,id]);
    if(anchorHash)await client.query('INSERT INTO w07_sessions(token_hash,user_id,expires_at,public_workspace) VALUES($1,$2,$3,$4)',[anchorHash,userId,s.publicDemo.expiresAt,id]);return {workspace:id,expiresAt:s.publicDemo.expiresAt};
  });}
  async function reserveNim(workspace){return transaction(async client=>{
    const r=await client.query('SELECT state FROM w07_workspaces WHERE id=$1 FOR UPDATE',[workspace]);const s=r.rows[0]?.state;if(!s?.publicDemo)return;
    must(Date.parse(s.publicDemo.expiresAt)>Date.now()&&s.publicDemo.aiUsed<s.publicDemo.aiLimit,'AI_DEMO_LIMIT','체험 공간의 AI 호출 한도 또는 이용 시간이 끝났습니다. 회계 수동 검토로 이어가세요.',429);
    await spend(client,`nim:${now().slice(0,10)}`,60,'AI_DEMO_LIMIT');s.publicDemo.aiUsed++;
    await client.query('UPDATE w07_workspaces SET state=$2 WHERE id=$1',[workspace,JSON.stringify(s)]);
  });}
  async function cleanupTrials(){return transaction(async client=>{
    const r=await client.query("SELECT id FROM w07_workspaces WHERE id LIKE 'trial-%' AND state ? 'publicDemo' AND (state->'publicDemo'->>'createdAt')::timestamptz < now()-interval '24 hours' FOR UPDATE");
    for(const {id} of r.rows){await client.query('DELETE FROM w07_sessions WHERE public_workspace=$1',[id]);for(const table of ['w07_instructions','w07_approvals','w07_receipts'])await client.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[id]);await client.query('DELETE FROM w07_workspaces WHERE id=$1',[id]);}
    return r.rows.length;
  });}
  async function claimGuidance(workspace,key,token,{spaceLimit=30,dailyLimit=300}={}) {
    return transaction(async client=>{
      const r=await client.query('SELECT state FROM w07_workspaces WHERE id=$1 FOR UPDATE',[workspace]);
      const s=r.rows[0]?.state;must(s,'WORKSPACE','작업공간이 없습니다.',404);
      s.guidance??={};
      const prior=s.guidance[key];
      if(prior?.status==='ready'||prior?.status==='pending'&&Date.now()-Date.parse(prior.at)<75000||prior?.status==='fallback'&&Date.now()-Date.parse(prior.at)<15000)return {claimed:false,entry:prior};
      if(s.publicDemo){
        must(Date.parse(s.publicDemo.expiresAt)>Date.now(),'AUTH','체험 시간이 끝났습니다.',401);
        must((s.publicDemo.guidanceUsed||0)<spaceLimit,'GUIDANCE_LIMIT','이 공간의 AI 안내 한도에 도달했습니다. 기본 안내로 계속 처리할 수 있습니다.',429);
        await spend(client,`guidance:${now().slice(0,10)}`,dailyLimit,'GUIDANCE_LIMIT');
        s.publicDemo.guidanceUsed=(s.publicDemo.guidanceUsed||0)+1;s.publicDemo.guidanceLimit=spaceLimit;
      }
      const old=Object.entries(s.guidance).filter(([,entry])=>entry.status!=='pending').sort((a,b)=>a[1].at.localeCompare(b[1].at));
      while(Object.keys(s.guidance).length>=60&&old.length)delete s.guidance[old.shift()[0]];
      s.guidance[key]={status:'pending',at:now(),token};
      await client.query('UPDATE w07_workspaces SET state=$2 WHERE id=$1',[workspace,JSON.stringify(s)]);
      return {claimed:true};
    });
  }
  async function finishGuidance(workspace,key,token,entry){
    return tx(workspace,s=>{if(s.guidance?.[key]?.token===token)s.guidance[key]={...entry,at:now()};});
  }
  return {query,tx,create,createTrial,reserveNim,claimGuidance,finishGuidance,cleanupTrials,async read(id){const r=await query('SELECT state FROM w07_workspaces WHERE id=$1',[id]);must(r.rows[0],'WORKSPACE','작업공간이 없습니다.',404);return r.rows[0].state;},
    async pending(){const r=await query("SELECT id FROM w07_workspaces WHERE EXISTS (SELECT 1 FROM jsonb_each(state->'jobs') j WHERE j.value->>'status'='pending')");return r.rows.map(r=>r.id);},
    async recover(){const r=await query("SELECT id FROM w07_workspaces WHERE EXISTS (SELECT 1 FROM jsonb_each(state->'jobs') j WHERE j.value->>'status'='running' AND (j.value->>'startedAt')::timestamptz < now()-interval '90 seconds')");for(const {id} of r.rows)await tx(id,s=>{for(const j of Object.values(s.jobs))if(j.status==='running'&&Date.now()-Date.parse(j.startedAt)>90000){j.status='failed';j.error={code:'AI_INTERRUPTED',message:'서버 재시작으로 호출 확인이 필요합니다.'};const c=s.cases[j.caseId];if(c)s.tasks[`${j.id}:interrupted`]={id:`${j.id}:interrupted`,caseId:c.id,owner:'reviewer',reason:'중단된 NIM 호출 수동 확인',status:'open',at:now()};}});},
    async close(){if(pool)await pool.end();else await embedded.close();}};
}
