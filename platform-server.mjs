// /api/platform/* の受け口。管理者のログイン・セッション（operators / operator_sessions）を扱い、
// 業務処理は db/platform-store.mjs に任せる。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { passwordDigest, SESSION_AGE } from './dist/member-store.js';
import { createPlatformStore } from './db/platform-store.mjs';
import { clientIp, createLimiter } from './rate-limit.mjs';

const DUMMY_SALT = '00000000000000000000000000000000';
const operatorFrom = row => row && ({ id: row.id, role: row.role, ...(row.salon_id ? { salonId: row.salon_id } : {}), ...(row.dealer_id ? { dealerId: row.dealer_id } : {}), name: row.name, email: row.email, lineLinked: Boolean(row.line_id) });
function failWith(message, status) { const e = new Error(message); e.status = status; throw e; }

export async function createPlatformServer(db, catalog, auth, options = {}) {
  const store = createPlatformStore(db, { catalog, concernNames: options.concernNames, fieldCrypto: options.fieldCrypto });
  const initialized = await store.init();
  if (initialized.imported) console.log(`旧形式のデータを移行しました（店舗${initialized.salons}・会員${initialized.members}・注文${initialized.orders}）。`);
  const limiter = createLimiter(), secure = options.secure ? '; Secure' : '', trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const tokenHash = value => createHash('sha256').update(value).digest('hex');
  const token = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('salon_operator='))?.slice(15) || '';
  const cookie = (res, value, age) => res.setHeader('Set-Cookie', `salon_operator=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure}`);
  async function operator(req) {
    const value = token(req);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return operatorFrom(await db.get('SELECT o.* FROM operator_sessions s JOIN operators o ON o.id=s.operator_id WHERE s.token_hash=? AND s.expires_at>?', [tokenHash(value), Date.now()]));
  }
  return {
    store, operator,
    async request(route, method, input, req, res) {
      if (route === '/operator/me' && method === 'GET') return { operator: await operator(req) };
      if (route === '/operator/logout' && method === 'POST') { await db.run('DELETE FROM operator_sessions WHERE token_hash=?', [tokenHash(token(req))]); cookie(res, '', 0); return { operator: null }; }
      if (route === '/operator/login' && method === 'POST') {
        const email = String(input?.email || '').trim().toLowerCase(), key = `${clientIp(req, trustProxy)}|${email}`;
        if (limiter.blocked(key)) { const e = Error('試行回数が多いため10分後にお試しください。'); e.status = 429; throw e; }
        const row = await db.get('SELECT * FROM operators WHERE email=?', [email]);
        const password = typeof input?.password === 'string' && input.password.length <= 128 ? input.password : '';
        const digest = await passwordDigest(password, /^[0-9a-f]{32}$/.test(row?.password_salt || '') ? row.password_salt : DUMMY_SALT);
        const expected = Buffer.from(row?.password_hash || '', 'hex'), actual = Buffer.from(digest.hash, 'hex');
        if (!row || expected.length !== actual.length || !timingSafeEqual(expected, actual)) { limiter.fail(key); const e = Error('メールアドレスまたはパスワードが違います。'); e.status = 401; throw e; }
        limiter.reset(key);
        await db.run('DELETE FROM operator_sessions WHERE token_hash=? OR expires_at<=?', [tokenHash(token(req)), Date.now()]);
        const value = randomBytes(32).toString('hex');
        await db.run('INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES (?, ?, ?)', [tokenHash(value), row.id, Date.now() + SESSION_AGE]);
        cookie(res, value, SESSION_AGE / 1000);
        return { operator: operatorFrom(row) };
      }
      // 加盟店スタッフの LINE ログイン（発注画面を LINE から開く）。ログイン中に呼ぶとその管理アカウントに連携する。
      if (route === '/operator/line' && method === 'POST') {
        if (!options.verifyLineToken) failWith('LINEログインは未設定です。', 404);
        const payload = await options.verifyLineToken(input?.idToken), current = await operator(req);
        const owner = await db.get('SELECT * FROM operators WHERE line_id=?', [payload.sub]);
        if (current) {
          if (owner && owner.id !== current.id) failWith('このLINEアカウントは別の管理アカウントに連携済みです。', 409);
          if (!owner) {
            try { await db.run('UPDATE operators SET line_id=? WHERE id=?', [payload.sub, current.id]); }
            catch (error) { if (db.isUniqueViolation(error)) failWith('このLINEアカウントは別の管理アカウントに連携済みです。', 409); throw error; }
          }
          return { operator: operatorFrom(await db.get('SELECT * FROM operators WHERE id=?', [current.id])), linked: true };
        }
        if (!owner) failWith('このLINEアカウントはまだ連携されていません。メールアドレスでログインしてから「LINEと連携」を押してください。', 404);
        await db.run('DELETE FROM operator_sessions WHERE token_hash=? OR expires_at<=?', [tokenHash(token(req)), Date.now()]);
        const value = randomBytes(32).toString('hex');
        await db.run('INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES (?, ?, ?)', [tokenHash(value), owner.id, Date.now() + SESSION_AGE]);
        cookie(res, value, SESSION_AGE / 1000);
        return { operator: operatorFrom(owner) };
      }
      // ip はアクセス記録（個人情報を含む画面を開いた記録）に残す接続元
      const actor = { operator: await operator(req), member: await auth.member(req), ip: clientIp(req, trustProxy) }, effects = [];
      const result = await store.request(route, method, input, actor, new Date().toISOString(), effects);
      // 確定後の通知など（LINE通知）。実際に状態が変わったとき（effects）だけ渡し、失敗しても応答には影響させない。
      if (effects.length) Promise.resolve().then(() => options.onChange?.({ effects, store })).catch(error => console.error('onChange:', error.message));
      return result;
    },
  };
}
