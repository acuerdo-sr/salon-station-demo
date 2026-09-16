import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createPlatform, platformRequest, migrate, demoOperators, DEMO_OPERATOR_PASSWORD } from './dist/platform-core.js';
import { passwordDigest, SESSION_AGE } from './dist/member-store.js';

export function createPlatformServer(db,catalog,auth,options={}){
  db.exec(`CREATE TABLE IF NOT EXISTS platform_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_sessions (token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  if(!db.prepare('SELECT id FROM platform_state WHERE id=1').get())db.prepare('INSERT INTO platform_state VALUES (1,?)').run(JSON.stringify(createPlatform(catalog)));
  else{const stored=JSON.parse(db.prepare('SELECT payload FROM platform_state WHERE id=1').get().payload);if(migrate(stored,catalog)){stored.revision++;db.prepare('UPDATE platform_state SET payload=? WHERE id=1').run(JSON.stringify(stored));}}
  const credentials=passwordDigest(DEMO_OPERATOR_PASSWORD),attempts=new Map();
  const tokenHash=value=>createHash('sha256').update(value).digest('hex');
  const token=req=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('salon_operator='))?.slice(15)||'';
  const cookie=(res,value,age)=>res.setHeader('Set-Cookie',`salon_operator=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`);
  function operator(req){const value=token(req);if(!/^[a-f0-9]{64}$/.test(value))return null;const row=db.prepare('SELECT operator_id FROM operator_sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(value),Date.now());return row?demoOperators.find(op=>op.id===row.operator_id)||null:null;}
  return {operator,async request(route,method,input,req,res){
    if(route==='/operator/me'&&method==='GET')return {operator:operator(req)};
    if(route==='/operator/logout'&&method==='POST'){db.prepare('DELETE FROM operator_sessions WHERE token_hash=?').run(tokenHash(token(req)));cookie(res,'',0);return {operator:null};}
    if(route==='/operator/login'&&method==='POST'){
      const key=req.socket.remoteAddress,old=attempts.get(key),attempt=old?.until>Date.now()?old:{count:0,until:Date.now()+600000};
      if(attempt.count>=10){const e=Error('試行回数が多いため10分後にお試しください。');e.status=429;throw e;}
      const op=demoOperators.find(o=>o.email===String(input?.email||'').trim().toLowerCase()),saved=await credentials;
      const password=typeof input?.password==='string'&&input.password.length<=128?input.password:'';
      const digest=await passwordDigest(password,saved.salt);
      if(!op||!timingSafeEqual(Buffer.from(digest.hash,'hex'),Buffer.from(saved.hash,'hex'))){attempt.count++;attempts.set(key,attempt);const e=Error('メールアドレスまたはパスワードが違います。');e.status=401;throw e;}
      attempts.delete(key);db.prepare('DELETE FROM operator_sessions WHERE token_hash=? OR expires_at<=?').run(tokenHash(token(req)),Date.now());
      const value=randomBytes(32).toString('hex');db.prepare('INSERT INTO operator_sessions VALUES (?,?,?)').run(tokenHash(value),op.id,Date.now()+SESSION_AGE);cookie(res,value,SESSION_AGE/1000);return {operator:op};
    }
    const actor={operator:operator(req),member:auth.member(req)},mutates=method!=='GET'&&!['/quote','/admin/sales'].includes(route);
    if(mutates)db.exec('BEGIN IMMEDIATE');
    try{
      const state=JSON.parse(db.prepare('SELECT payload FROM platform_state WHERE id=1').get().payload);
      const result=platformRequest(state,route,method,input,actor);
      if(mutates){state.revision++;db.prepare('UPDATE platform_state SET payload=? WHERE id=1').run(JSON.stringify(state));db.exec('COMMIT');
        // 確定後の通知など（LINE通知）。失敗しても応答には影響させない。
        try{options.onChange?.({route,method,input,result,state});}catch(error){console.error('onChange:',error.message);}}
      return result;
    }catch(error){if(mutates)db.exec('ROLLBACK');throw error;}
  }};
}
