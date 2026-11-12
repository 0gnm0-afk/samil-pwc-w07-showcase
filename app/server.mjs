import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { initAccounts, login, loginRole, authenticate, sessionToken, workspaceToken, verifyPassword } from './auth.mjs';
import { command, publicState, previewSchedule, businessRoles, can, must, hash, now, RuleError, upgradeWorkflow } from './domain.mjs';
import { processOne } from './ai.mjs';
import { createGuidanceService } from './guidance.mjs';
const instanceId=randomUUID();
export async function startServer({store,hashes,port=Number(process.env.PORT||8080),worker=true,secure=process.env.NODE_ENV==='production',guidanceOptions}={}) {
  store??=await openStore();hashes??=JSON.parse(process.env.W07_ACCOUNT_HASHES||'null');await initAccounts(store,hashes);await store.create('demo');await store.recover();
  const publicRoles=businessRoles.map((role,index)=>{
    const code='REDACTED-DEMO-' + role.id;
    return verifyPassword(code,hashes[`role:${role.id}`])?{...role,demoPassword:code}:role;
  });
  const guide=createGuidanceService(store,guidanceOptions);
  const active=new Set(),attempts=new Map();
  async function kick(workspace){if(!worker||active.has(workspace))return;active.add(workspace);try{for(let i=0;i<10;i++)if(!await processOne(store,workspace))break;}catch{console.error(JSON.stringify({type:'worker_error',at:now()}));}finally{active.delete(workspace);}}
  const interval=worker?setInterval(async()=>{try{await store.recover();for(const w of await store.pending())void kick(w);}catch{console.error(JSON.stringify({type:'db_worker_error',at:now()}));}},15000):null;
  interval?.unref();
  await store.cleanupTrials();
  const cleanup=setInterval(()=>{void store.cleanupTrials().catch(()=>{});},3600000);cleanup.unref();
  const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
  async function body(req){let data='';for await(const part of req){data+=part;must(Buffer.byteLength(data)<=150000,'SIZE','입력은 150KB 이하여야 합니다.',413);}try{return JSON.parse(data||'{}');}catch{throw new RuleError('JSON','JSON 형식 오류',400);}}
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz')return json(res,200,{ok:true,version:'1.2.0',instanceId});
      if(['GET','HEAD'].includes(req.method)&&['/','/app.js','/style.css','/catalog.js','/guidance-ui.js','/schedule.js'].includes(url.pathname)){
        const path=url.pathname==='/'?'index.html':url.pathname.slice(1);const content=await readFile(new URL(`./public/${path}`,import.meta.url));res.writeHead(200,{'content-type':path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-cache'});return res.end(req.method==='HEAD'?undefined:content);
      }
      if(url.pathname==='/api/roles'&&req.method==='GET')return json(res,200,publicRoles);
      if(['/api/demo/start','/api/demo/role'].includes(url.pathname))return json(res,410,{code:'LOGIN_REQUIRED',message:'역할별 비밀번호 로그인으로 변경되었습니다.'});
      if(req.method!=='GET'){
        must(req.headers['content-type']?.startsWith('application/json'),'CONTENT_TYPE','JSON 요청만 허용합니다.',415);
        const origin=req.headers.origin;
        if(origin){const expectedHost=req.headers['x-forwarded-host']||req.headers.host;must(new URL(origin).host===expectedHost,'ORIGIN','다른 사이트의 요청은 허용하지 않습니다.',403);}
      }
      if(url.pathname==='/api/login'&&req.method==='POST'){
        const p=await body(req);const key=req.socket.remoteAddress;const entry=attempts.get(key)??{count:0,since:Date.now()};if(Date.now()-entry.since>60000){entry.count=0;entry.since=Date.now();}entry.count++;attempts.set(key,entry);must(entry.count<=15,'RATE_LIMIT','잠시 후 다시 로그인하세요.',429);
        const result=p.roleId?await loginRole(store,p,workspaceToken(req)):await login(store,p.userId,p.password);attempts.delete(key);
        const attrs=`; HttpOnly; SameSite=Strict; Path=/; Max-Age=${p.roleId?7200:28800}${secure?'; Secure':''}`;
        const cookies=[`w07_session=${result.token}${attrs}`];if(result.spaceToken)cookies.push(`w07_space=${result.spaceToken}${attrs}`);
        if(sessionToken(req))await store.query('DELETE FROM w07_sessions WHERE token_hash=$1',[hash(sessionToken(req))]);
        res.setHeader('set-cookie',cookies);return json(res,200,{user:result.user,workspace:result.workspace||'demo',expiresAt:result.expiresAt});
      }
      const actor=await authenticate(store,req);
      if(url.pathname==='/api/me')return json(res,200,{user:actor,version:'1.2.0'});
      if(url.pathname==='/api/logout'&&req.method==='POST'){await store.query('DELETE FROM w07_sessions WHERE token_hash=$1',[hash(sessionToken(req))]);res.setHeader('set-cookie',`w07_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`);return json(res,200,{ok:true});}
      const workspace=url.searchParams.get('workspace')||actor.workspace||'demo';must(/^(demo|qa-[a-z0-9-]{1,70}|trial-[a-f0-9-]{36})$/.test(workspace),'WORKSPACE','작업공간 오류',400);
      if(actor.publicDemo)must(workspace===actor.workspace,'FORBIDDEN','내 체험 공간에만 접근할 수 있습니다.',403);
      if(url.pathname==='/api/guidance'&&req.method==='POST')return json(res,200,await guide(workspace,actor,await body(req)));
      if(url.pathname==='/api/schedule/preview'&&req.method==='POST')return json(res,200,previewSchedule(await store.read(workspace),actor,(await body(req)).items));
      if(url.pathname==='/api/state'&&req.method==='GET'){
        let s=await store.read(workspace);
        if(s.workflowVersion!==2){s=await store.tx(workspace,current=>{upgradeWorkflow(current);return current;});void kick(workspace);}
        return json(res,200,{user:actor,workspace,state:publicState(s,actor)});
      }
      if(url.pathname==='/api/admin/workspace'&&req.method==='POST'){
        must(actor.role==='admin','FORBIDDEN','시연 관리자만 초기화할 수 있습니다.',403);const p=await body(req);must(p.confirm==='RESET_DEMO','CONFIRM','전용 시연 초기화 확인이 필요합니다.',400);await store.create(workspace,p.fixture||'demo',{reset:true,validation:workspace.startsWith('qa-')});return json(res,200,{ok:true,workspace});
      }
      if(url.pathname==='/api/admin/fault'&&req.method==='POST'){
        must(actor.role==='admin'&&workspace.startsWith('qa-'),'FORBIDDEN','검증 전용 공간에서만 실패 재현이 가능합니다.',403);const p=await body(req);must(['AI_AUTH','AI_RATE_LIMIT','AI_TIMEOUT',null].includes(p.error??null)&&Number.isInteger(p.delayMs??0)&&(p.delayMs??0)>=0&&(p.delayMs??0)<=15000,'FAULT','허용된 실패 재현 범위를 확인하세요.',400);
        await store.tx(workspace,(s,meta)=>{must(meta.validation,'FORBIDDEN','검증 공간이 아닙니다.',403);s.nextFault={error:p.error??null,delayMs:p.delayMs??0};});return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/command'&&req.method==='POST'){
        const p=await body(req);const result=await store.tx(workspace,(s,meta)=>{
          if(can(actor,'intake')&&p.payload?.caseId)must(s.cases[p.payload.caseId]?.creator===actor.id,'FORBIDDEN','자기 접수 건만 처리할 수 있습니다.',403);
          if(actor.publicDemo)must(s.events.length<300&&Object.keys(s.cases).length<15&&Object.values(s.cases).reduce((n,c)=>n+c.docs.reduce((m,d)=>m+d.text.length,0),0)<80000,'DEMO_LIMIT','이 공간의 체험 입력 한도에 도달했습니다.',429);
          const prior=new Set(Object.keys(s.jobs));const result=command(s,actor,p.type,p.payload);
          if(meta.validation&&s.nextFault){for(const j of Object.values(s.jobs))if(!prior.has(j.id)){j.fault=s.nextFault;delete s.nextFault;break;}}
          return result;
        });void kick(workspace);return json(res,result.denied?409:200,result);
      }
      return json(res,404,{code:'NOT_FOUND',message:'경로를 찾을 수 없습니다.'});
    }catch(error){if(!(error instanceof RuleError))console.error(JSON.stringify({type:'request_error',code:error.code||'SERVER_ERROR',at:now()}));return json(res,error.status||500,{code:error.code||'SERVER_ERROR',message:error instanceof RuleError?error.message:'서버 처리 중 오류가 발생했습니다. 다시 확인하세요.'});}
  });
  await new Promise(resolve=>server.listen(port,'0.0.0.0',resolve));
  return {server,store,port:server.address().port,async close(){if(interval)clearInterval(interval);clearInterval(cleanup);await new Promise(r=>server.close(r));await store.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{const app=await startServer();console.log(JSON.stringify({type:'ready',port:app.port,version:'1.2.0',instanceId}));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();process.exit(0);});}
  catch(error){console.error(JSON.stringify({type:'startup_failed',code:error.code||'STARTUP',message:'서버 DB·계정 비밀 설정을 확인하세요.'}));process.exitCode=1;}
}
