import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { passwordDigest, validateMember, validatePassword, SESSION_AGE } from './dist/member-store.js';

export function createAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, profile TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL);`);
  // 会員マスタの LINE ID（仕様書 2.6.2）。既存DBには列を追加する。
  if (!db.prepare('PRAGMA table_info(members)').all().some(column => column.name === 'line_id')) db.exec('ALTER TABLE members ADD COLUMN line_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_line_id ON members(line_id)');
  const tokenHash = token => createHash('sha256').update(token).digest('hex');
  const parse = row => (row ? JSON.parse(row.profile) : null);
  const findById = id => parse(db.prepare('SELECT profile FROM members WHERE id=?').get(id));
  const findByLineId = lineId => parse(db.prepare('SELECT profile FROM members WHERE line_id=?').get(lineId));
  function linkLine(id, lineId) {
    const profile = findById(id);
    if (!profile) throw Error('会員が見つかりません。');
    profile.lineId = lineId;
    db.prepare('UPDATE members SET line_id=?, profile=? WHERE id=?').run(lineId, JSON.stringify(profile), id);
    return profile;
  }
  // LINE経由の簡略登録（仕様書 2.2.7 ②）。メールアドレスが既存会員と一致すればそのアカウントに連携する。
  async function createFromLine({ lineId, name, email }) {
    const fields = validateMember({ salon: 'LINE登録', name, email });
    const existing = db.prepare('SELECT id FROM members WHERE email=?').get(fields.email);
    if (existing) return linkLine(existing.id, lineId);
    const digest = await passwordDigest(randomBytes(24).toString('hex'));
    const profile = { id: crypto.randomUUID(), ...fields, lineId, createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO members (id, email, salt, hash, profile, line_id) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, profile.email, digest.salt, digest.hash, JSON.stringify(profile), lineId);
    return profile;
  }
  const readToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('salon_session='))?.slice('salon_session='.length) || '';
  const attempts = new Map();
  function member(req) {
    const token = readToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const record = db.prepare('SELECT m.profile FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), Date.now());
    return record ? JSON.parse(record.profile) : null;
  }
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `salon_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`);
  }
  function session(req, res, profile) {
    const old = readToken(req);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(old));
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), profile.id, Date.now() + SESSION_AGE);
    cookie(res, token, Math.floor(SESSION_AGE / 1000));
  }
  return {
    member, findById, findByLineId, linkLine, createFromLine, startSession: session,
    async request(route, method, input, req, res) {
      if (route === '/api/auth/me' && method === 'GET') return { member: member(req) };
      if (route === '/api/auth/register' && method === 'POST') {
        const fields = validateMember(input);
        validatePassword(input.password);
        if (db.prepare('SELECT id FROM members WHERE email=?').get(fields.email)) throw Error('このデモ用メールアドレスは登録済みです。');
        const digest = await passwordDigest(input.password);
        const profile = { id: crypto.randomUUID(), ...fields, createdAt: new Date().toISOString() };
        try { db.prepare('INSERT INTO members (id, email, salt, hash, profile) VALUES (?, ?, ?, ?, ?)').run(profile.id, profile.email, digest.salt, digest.hash, JSON.stringify(profile)); }
        catch (error) { if (db.prepare('SELECT id FROM members WHERE email=?').get(fields.email)) throw Error('このデモ用メールアドレスは登録済みです。'); throw error; }
        session(req, res, profile);
        return { member: profile };
      }
      if (route === '/api/auth/login' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
        const rateKey = req.socket.remoteAddress;
        const previous = attempts.get(rateKey);
        if (previous?.until > Date.now() && previous.count >= 10) throw Error('試行回数が多いため、10分後にお試しください。');
        const attempt = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 600000 };
        const record = db.prepare('SELECT * FROM members WHERE email=?').get(email);
        if (typeof input?.password !== 'string' || input.password.length > 128) throw Error('メールアドレスまたはパスワードが違います。');
        const digest = await passwordDigest(input.password, record?.salt || '00000000000000000000000000000000');
        if (!record || !timingSafeEqual(Buffer.from(record.hash, 'hex'), Buffer.from(digest.hash, 'hex'))) {
          attempt.count++; attempts.set(rateKey, attempt);
          throw Error('メールアドレスまたはパスワードが違います。');
        }
        attempts.delete(rateKey);
        const profile = JSON.parse(record.profile);
        session(req, res, profile);
        return { member: profile };
      }
      if (route === '/api/auth/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(readToken(req)));
        cookie(res, '', 0);
        return { member: null };
      }
      if (route === '/api/auth/profile' && method === 'PATCH') {
        const active = member(req);
        if (!active) throw Error('ログインし直してください。');
        const profile = { ...active, ...validateMember({ ...input, email: active.email }) };
        const stored = findById(active.id);
        if (stored?.lineId) profile.lineId = stored.lineId;
        db.prepare('UPDATE members SET profile=? WHERE id=?').run(JSON.stringify(profile), profile.id);
        return { member: profile };
      }
      throw Error('会員機能の操作が正しくありません。');
    },
  };
}
