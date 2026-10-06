// 会員の認証（会員登録・ログイン・セッション・LINE連携）。データは members / member_sessions テーブル。
// メール・氏名などの個人情報は options.fieldCrypto で暗号化して保存し、メールアドレスでの検索は email_index で行う。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { passwordDigest, validateMember, validatePassword, SESSION_IDLE, SESSION_COOKIE_AGE, RESET_AGE } from './dist/member-store.js';
import { clientIp, createLimiter } from './rate-limit.mjs';
import { privacyConsent, PRIVACY_VERSION } from './dist/privacy.js';
import { createFieldCrypto, openRow } from './db/crypto.mjs';

function failWith(message, status, code) { const error = new Error(message); error.status = status; if (code) error.code = code; throw error; }
const DUMMY_SALT = '00000000000000000000000000000000';
const MEMBER_SELECT = 'SELECT m.*, s.name AS salon_name FROM members m LEFT JOIN salons s ON s.id=m.salon_id';
// 画面に返す会員情報（パスワードのハッシュは含めない）
const memberView = row => row && ({ id: row.id, salon: row.salon_name || '', name: row.name, email: row.email, kana: row.kana, phone: row.phone, gender: row.gender, birthday: row.birthday, createdAt: row.created_at, privacyVersion: row.privacy_version || '', privacyAgreedAt: row.privacy_agreed_at || '', ...(row.line_id ? { lineId: row.line_id } : {}) });

export function createAuth(db, options = {}) {
  const secure = options.secure ? '; Secure' : '';
  const c = options.fieldCrypto || createFieldCrypto(null);
  const clock = options.now || Date.now;
  const memberFrom = row => memberView(openRow(c, 'members', row));
  const byEmail = (columns, email) => db.get(`SELECT ${columns} FROM members WHERE email_index=?`, [c.blindIndex(email)]);
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
    // LINEでの簡略登録はフリガナなしで作り、注文の前にマイページで登録してもらう
    const fields = validateMember({ salon: 'LINE登録', name, email }, { kanaRequired: false });
    const existing = await byEmail('id', fields.email);
    if (existing) return linkLine(existing.id, lineId);
    const digest = await passwordDigest(randomBytes(24).toString('hex'));
    const id = crypto.randomUUID(), now = new Date().toISOString();
    try {
      // LINEでの登録は、画面の「同意して登録」の操作をもって同意として記録する
      await db.run('INSERT INTO members (id, email, email_index, password_salt, password_hash, name, kana, phone, gender, birthday, line_id, privacy_version, privacy_agreed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, c.encrypt(fields.email), c.blindIndex(fields.email), digest.salt, digest.hash, ...['name', 'kana', 'phone', 'gender', 'birthday'].map(k => c.encrypt(fields[k])), lineId, PRIVACY_VERSION, now, now, now]);
    } catch (error) {
      // 同じLINEユーザーの初回ログインが同時に届いた場合は、先に作られた会員を使う。
      if (!db.isUniqueViolation(error)) throw error;
      const created = await findByLineId(lineId);
      if (created) return created;
      const sameEmail = await byEmail('id', fields.email);
      if (sameEmail) return linkLine(sameEmail.id, lineId);
      throw error;
    }
    return findById(id);
  }
  const readToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('salon_session='))?.slice('salon_session='.length) || '';
  const limiter = createLimiter(), resetLimiter = createLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  // セッションは最後の操作から30分で切れる。使うたびに期限を延ばす（書き込みは1分に1回まで）
  async function member(req) {
    const token = readToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const now = clock(), hash = tokenHash(token);
    const row = await db.get('SELECT m.*, s.name AS salon_name, ms.expires_at AS session_expires_at FROM member_sessions ms JOIN members m ON m.id=ms.member_id LEFT JOIN salons s ON s.id=m.salon_id WHERE ms.token_hash=? AND ms.expires_at>?', [hash, now]);
    if (row && Number(row.session_expires_at) - now < SESSION_IDLE - 60000) await db.run('UPDATE member_sessions SET expires_at=? WHERE token_hash=?', [now + SESSION_IDLE, hash]);
    return memberFrom(row);
  }
  function cookie(res, value, age) {
    res.setHeader('Set-Cookie', `salon_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure}`);
  }
  async function session(req, res, profile) {
    const old = readToken(req);
    if (old) await db.run('DELETE FROM member_sessions WHERE token_hash=?', [tokenHash(old)]);
    await db.run('DELETE FROM member_sessions WHERE expires_at<=?', [clock()]);
    const token = randomBytes(32).toString('hex');
    await db.run('INSERT INTO member_sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)', [tokenHash(token), profile.id, clock() + SESSION_IDLE]);
    cookie(res, token, Math.floor(SESSION_COOKIE_AGE / 1000));
  }
  return {
    member, findById, findByLineId, linkLine, createFromLine, startSession: session,
    async request(route, method, input, req, res) {
      if (route === '/api/auth/me' && method === 'GET') return { member: await member(req) };
      if (route === '/api/auth/register' && method === 'POST') {
        const fields = validateMember(input, { kanaRequired: true });
        validatePassword(input.password);
        const consent = privacyConsent(input);
        if (await byEmail('id', fields.email)) throw Error('このデモ用メールアドレスは登録済みです。');
        const digest = await passwordDigest(input.password);
        const id = crypto.randomUUID(), now = new Date().toISOString();
        try {
          await db.run('INSERT INTO members (id, email, email_index, password_salt, password_hash, name, kana, phone, gender, birthday, privacy_version, privacy_agreed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, c.encrypt(fields.email), c.blindIndex(fields.email), digest.salt, digest.hash, ...['name', 'kana', 'phone', 'gender', 'birthday'].map(k => c.encrypt(fields[k])), consent.version, now, now, now]);
        } catch (error) { if (db.isUniqueViolation(error)) throw Error('このデモ用メールアドレスは登録済みです。'); throw error; }
        const profile = await findById(id);
        await session(req, res, profile);
        return { member: profile };
      }
      if (route === '/api/auth/login' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
        const rateKey = `${clientIp(req, trustProxy)}|${email}`;
        if (limiter.blocked(rateKey)) failWith('試行回数が多いため、10分後にお試しください。', 429);
        const record = await byEmail('id, password_salt, password_hash', email);
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
      // パスワード再設定（仕様書 2.1.3）：登録メールアドレスに30分・1回限りのリンクを送る。
      // 登録の有無は応答から分からないようにする（同じ応答・同じ処理時間の目安）。
      if (route === '/api/auth/password/forgot' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase().slice(0, 150) : '';
        const rateKey = `${clientIp(req, trustProxy)}|${email}`;
        if (resetLimiter.blocked(rateKey)) failWith('お手続きの回数が多いため、1時間後にお試しください。', 429);
        resetLimiter.fail(rateKey);
        const record = email ? await byEmail('id', email) : null;
        if (record) {
          const token = randomBytes(32).toString('hex'), profile = await findById(record.id);
          await db.run('DELETE FROM password_resets WHERE member_id=? OR expires_at<=?', [record.id, clock()]);
          await db.run('INSERT INTO password_resets (token_hash, member_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)', [tokenHash(token), record.id, clock() + RESET_AGE, new Date(clock()).toISOString()]);
          const link = `${(options.publicOrigin || '').replace(/\/$/, '')}/#reset/${token}`;
          try {
            await options.mailer?.send({ to: profile.email, subject: '【SALON STATION】パスワード再設定のご案内', text: `${profile.name} 様\n\nパスワード再設定のお手続きを受け付けました。\n30分以内に次のURLを開き、新しいパスワードを設定してください。\n\n${link}\n\nお心当たりがない場合は、このメールを破棄してください。パスワードは変更されません。\n\nSALON STATION` });
          } catch (error) { console.error('password reset mail:', error.message); }
        }
        return { sent: true };
      }
      if (route === '/api/auth/password/reset' && method === 'POST') {
        const token = typeof input?.token === 'string' && /^[a-f0-9]{64}$/.test(input.token) ? input.token : '';
        validatePassword(input?.password);
        const entry = token ? await db.get('SELECT member_id FROM password_resets WHERE token_hash=? AND expires_at>? AND used_at IS NULL', [tokenHash(token), clock()]) : null;
        if (!entry) failWith('再設定用のリンクが無効か、有効期限（30分）が切れています。もう一度お手続きください。', 400);
        const digest = await passwordDigest(input.password);
        await db.transaction(async tx => {
          // 同じリンクの同時使用に備え、未使用の場合だけ使用済みにする
          const used = await tx.run('UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL', [new Date(clock()).toISOString(), tokenHash(token)]);
          if (used.changes !== 1) failWith('再設定用のリンクはすでに使われています。', 400);
          await tx.run('UPDATE members SET password_salt=?, password_hash=?, updated_at=? WHERE id=?', [digest.salt, digest.hash, new Date(clock()).toISOString(), entry.member_id]);
          // 再設定したら、ほかの端末のログインもすべて切る
          await tx.run('DELETE FROM member_sessions WHERE member_id=?', [entry.member_id]);
          await tx.run('DELETE FROM password_resets WHERE member_id=? AND token_hash<>?', [entry.member_id, tokenHash(token)]);
        });
        cookie(res, '', 0);
        return { reset: true };
      }
      if (route === '/api/auth/profile' && method === 'PATCH') {
        const active = await member(req);
        if (!active) throw Error('ログインし直してください。');
        // 送られなかった項目は今の値のまま（部分更新）。メールアドレス（ログインID）は変えない
        const fields = validateMember({ ...active, ...input, email: active.email }, { kanaRequired: true });
        await db.run('UPDATE members SET name=?, kana=?, phone=?, gender=?, birthday=?, updated_at=? WHERE id=?', [...['name', 'kana', 'phone', 'gender', 'birthday'].map(k => c.encrypt(fields[k])), new Date().toISOString(), active.id]);
        return { member: await findById(active.id) };
      }
      throw Error('会員機能の操作が正しくありません。');
    },
  };
}
