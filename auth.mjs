// 会員の認証（会員登録・ログイン・セッション・LINE連携）。データは members / member_sessions テーブル。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { passwordDigest, validateMember, validatePassword, SESSION_AGE } from './dist/member-store.js';
import { clientIp, createLimiter } from './rate-limit.mjs';

function failWith(message, status, code) { const error = new Error(message); error.status = status; if (code) error.code = code; throw error; }
const DUMMY_SALT = '00000000000000000000000000000000';
const MEMBER_SELECT = 'SELECT m.*, s.name AS salon_name FROM members m LEFT JOIN salons s ON s.id=m.salon_id';
// 画面に返す会員情報（パスワードのハッシュは含めない）
const memberFrom = row => row && ({ id: row.id, salon: row.salon_name || '', name: row.name, email: row.email, kana: row.kana, phone: row.phone, gender: row.gender, birthday: row.birthday, createdAt: row.created_at, ...(row.line_id ? { lineId: row.line_id } : {}) });

export function createAuth(db, options = {}) {
  const secure = options.secure ? '; Secure' : '';
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const tokenHash = token => createHash('sha256').update(token).digest('hex');
  const findById = async id => memberFrom(await db.get(`${MEMBER_SELECT} WHERE m.id=?`, [id]));
  const findByLineId = async lineId => memberFrom(await db.get(`${MEMBER_SELECT} WHERE m.line_id=?`, [lineId]));
  async function linkLine(id, lineId) {
    if (!(await db.get('SELECT id FROM members WHERE id=?', [id]))) throw Error('会員が見つかりません。');
    try { await db.run('UPDATE members SET line_id=?, updated_at=? WHERE id=?', [lineId, new Date().toISOString(), id]); }
    catch (error) {
      // 同じLINEアカウントの連携が同時に行われた場合。
      if (db.isUniqueViolation(error)) { const owner = await findByLineId(lineId); if (owner?.id === id) return owner; failWith('このLINEアカウントは別の会員に連携済みです。', 409, 'conflict'); }
      throw error;
    }
    return findById(id);
  }
  // LINE経由の簡略登録（仕様書 2.2.7 ②）。メールアドレスが既存会員と一致すればそのアカウントに連携する。
  async function createFromLine({ lineId, name, email }) {
    const fields = validateMember({ salon: 'LINE登録', name, email });
    const existing = await db.get('SELECT id FROM members WHERE email=?', [fields.email]);
    if (existing) return linkLine(existing.id, lineId);
    const digest = await passwordDigest(randomBytes(24).toString('hex'));
    const id = crypto.randomUUID(), now = new Date().toISOString();
    try {
      await db.run('INSERT INTO members (id, email, password_salt, password_hash, name, kana, phone, gender, birthday, line_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, fields.email, digest.salt, digest.hash, fields.name, fields.kana, fields.phone, fields.gender, fields.birthday, lineId, now, now]);
    } catch (error) {
      // 同じLINEユーザーの初回ログインが同時に届いた場合は、先に作られた会員を使う。
      if (!db.isUniqueViolation(error)) throw error;
      const created = await findByLineId(lineId);
      if (created) return created;
      const sameEmail = await db.get('SELECT id FROM members WHERE email=?', [fields.email]);
      if (sameEmail) return linkLine(sameEmail.id, lineId);
      throw error;
    }
    return findById(id);
  }
  const readToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('salon_session='))?.slice('salon_session='.length) || '';
  const limiter = createLimiter();
  async function member(req) {
    const token = readToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return memberFrom(await db.get('SELECT m.*, s.name AS salon_name FROM member_sessions ms JOIN members m ON m.id=ms.member_id LEFT JOIN salons s ON s.id=m.salon_id WHERE ms.token_hash=? AND ms.expires_at>?', [tokenHash(token), Date.now()]));
  }
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `salon_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure}`);
  }
  async function session(req, res, profile) {
    const old = readToken(req);
    if (old) await db.run('DELETE FROM member_sessions WHERE token_hash=?', [tokenHash(old)]);
    await db.run('DELETE FROM member_sessions WHERE expires_at<=?', [Date.now()]);
    const token = randomBytes(32).toString('hex');
    await db.run('INSERT INTO member_sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)', [tokenHash(token), profile.id, Date.now() + SESSION_AGE]);
    cookie(res, token, Math.floor(SESSION_AGE / 1000));
  }
  return {
    member, findById, findByLineId, linkLine, createFromLine, startSession: session,
    async request(route, method, input, req, res) {
      if (route === '/api/auth/me' && method === 'GET') return { member: await member(req) };
      if (route === '/api/auth/register' && method === 'POST') {
        const fields = validateMember(input);
        validatePassword(input.password);
        if (await db.get('SELECT id FROM members WHERE email=?', [fields.email])) throw Error('このデモ用メールアドレスは登録済みです。');
        const digest = await passwordDigest(input.password);
        const id = crypto.randomUUID(), now = new Date().toISOString();
        try {
          await db.run('INSERT INTO members (id, email, password_salt, password_hash, name, kana, phone, gender, birthday, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, fields.email, digest.salt, digest.hash, fields.name, fields.kana, fields.phone, fields.gender, fields.birthday, now, now]);
        } catch (error) { if (db.isUniqueViolation(error)) throw Error('このデモ用メールアドレスは登録済みです。'); throw error; }
        const profile = await findById(id);
        await session(req, res, profile);
        return { member: profile };
      }
      if (route === '/api/auth/login' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
        const rateKey = `${clientIp(req, trustProxy)}|${email}`;
        if (limiter.blocked(rateKey)) failWith('試行回数が多いため、10分後にお試しください。', 429);
        const record = await db.get('SELECT id, password_salt, password_hash FROM members WHERE email=?', [email]);
        if (typeof input?.password !== 'string' || input.password.length > 128) throw Error('メールアドレスまたはパスワードが違います。');
        const salt = /^[0-9a-f]{32}$/.test(record?.password_salt || '') ? record.password_salt : DUMMY_SALT;
        const digest = await passwordDigest(input.password, salt);
        const expected = Buffer.from(record?.password_hash || '', 'hex'), actual = Buffer.from(digest.hash, 'hex');
        if (!record || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          limiter.fail(rateKey);
          throw Error('メールアドレスまたはパスワードが違います。');
        }
        limiter.reset(rateKey);
        const profile = await findById(record.id);
        await session(req, res, profile);
        return { member: profile };
      }
      if (route === '/api/auth/logout' && method === 'POST') {
        await db.run('DELETE FROM member_sessions WHERE token_hash=?', [tokenHash(readToken(req))]);
        cookie(res, '', 0);
        return { member: null };
      }
      if (route === '/api/auth/profile' && method === 'PATCH') {
        const active = await member(req);
        if (!active) throw Error('ログインし直してください。');
        const fields = validateMember({ ...input, email: active.email });
        await db.run('UPDATE members SET name=?, kana=?, phone=?, gender=?, birthday=?, updated_at=? WHERE id=?', [fields.name, fields.kana, fields.phone, fields.gender, fields.birthday, new Date().toISOString(), active.id]);
        return { member: await findById(active.id) };
      }
      throw Error('会員機能の操作が正しくありません。');
    },
  };
}
