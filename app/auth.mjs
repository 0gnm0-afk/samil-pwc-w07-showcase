import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hash, must, users, actorFor, businessRoles } from './domain.mjs';
export function passwordHash(password,salt=randomBytes(16).toString('hex')) {return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}
export function verifyPassword(password,stored){if(typeof password!=='string'||password.length>300||!stored)return false;const [salt,h]=stored.split(':');if(!salt||!h)return false;const actual=scryptSync(password,salt,64);const expected=Buffer.from(h,'hex');return expected.length===actual.length&&timingSafeEqual(actual,expected);}
export async function initAccounts(store,hashes){const ids=[...users.map(u=>u.id),...businessRoles.map(r=>`role:${r.id}`)];must(hashes&&ids.every(id=>typeof hashes[id]==='string'),'AUTH_CONFIG','역할별 서버 비밀번호 해시가 필요합니다.');for(const id of ids)await store.query('INSERT INTO w07_users(id,password_hash) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET password_hash=EXCLUDED.password_hash',[id,hashes[id]]);}
export async function login(store,userId,password){actorFor(userId);const r=await store.query('SELECT password_hash FROM w07_users WHERE id=$1',[userId]);must(verifyPassword(password,r.rows[0]?.password_hash),'LOGIN','계정 또는 비밀번호를 확인하세요.',401);const token=randomBytes(32).toString('hex');await store.query('INSERT INTO w07_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'8 hours\')',[hash(token),userId]);return {token,user:actorFor(userId)};}
export function sessionToken(req){const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('w07_session='));return cookie?.slice(12);}
export async function authenticate(store,req){const token=sessionToken(req);must(token,'AUTH','역할을 선택하고 로그인하세요.',401);const r=await store.query('SELECT user_id,public_workspace FROM w07_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(token)]);must(r.rows[0],'AUTH','세션이 만료됐습니다. 다시 로그인하세요.',401);if(r.rows[0].public_workspace){const s=await store.read(r.rows[0].public_workspace);must(s.publicDemo?.authVersion===2,'AUTH','역할 비밀번호로 다시 로그인하세요.',401);}return {...actorFor(r.rows[0].user_id),...(r.rows[0].public_workspace?{publicDemo:true,workspace:r.rows[0].public_workspace}:{})};}
export function workspaceToken(req){return req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('w07_space='))?.slice(10);}
export async function loginRole(store,{roleId,member,password},spaceToken){
 const selected=businessRoles.find(r=>r.id===roleId);must(selected&&selected.members.some(m=>m.id===member),'LOGIN','역할과 담당자를 확인하세요.',401);
 const r=await store.query('SELECT password_hash FROM w07_users WHERE id=$1',[`role:${roleId}`]);must(verifyPassword(password,r.rows[0]?.password_hash),'LOGIN','역할 또는 비밀번호를 확인하세요.',401);
 const token=randomBytes(32).toString('hex');let space;
 if(spaceToken){const r=await store.query('SELECT public_workspace,expires_at FROM w07_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(`space:${spaceToken}`)]);if(r.rows[0])space={workspace:r.rows[0].public_workspace,expiresAt:r.rows[0].expires_at};}
 if(space){await store.query('INSERT INTO w07_sessions(token_hash,user_id,expires_at,public_workspace) VALUES($1,$2,$3,$4)',[hash(token),member,space.expiresAt,space.workspace]);}
 else{spaceToken=randomBytes(32).toString('hex');space=await store.createTrial(hash(token),member,hash(`space:${spaceToken}`));}
 return {token,spaceToken,...space,user:{...actorFor(member),publicDemo:true,workspace:space.workspace}};
}
