// Demonstration membership. Pages storage is not a security boundary.
import { privacyConsent } from './privacy.js';
// セッションは最後の操作から30分で切れる（仕様書 3.1.2）。操作のたびに期限を延ばす。
export const SESSION_IDLE = 30 * 60 * 1000;
// Cookie の寿命（ブラウザ側の上限）。実際の有効期限はサーバーが最後の操作から30分で判定する。
export const SESSION_COOKIE_AGE = 12 * 60 * 60 * 1000;
export const RESET_AGE = 30 * 60 * 1000;
const ITERATIONS = 600000;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));

// 会員のプロフィール（氏名・フリガナ・電話番号・性別・生年月日）。仕様書 2.6.2 でフリガナは必須。
// LINEでの簡略登録だけはフリガナなしで作成し、注文の前にマイページで登録してもらう（kanaRequired: false）。
export function validateProfile(input, { kanaRequired = true } = {}) {
  const profile = {};
  if (typeof input?.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw Error('お名前を80文字以内で入力してください。');
  profile.name = input.name.trim();
  const optional = { kana: [50, /^[ぁ-んァ-ヶー・\s　]*$/, 'フリガナはかな・カナで50文字以内で入力してください。'], phone: [15, /^[0-9-]*$/, '電話番号は半角数字・ハイフンで15文字以内で入力してください。'], birthday: [10, /^(\d{4}-\d{2}-\d{2})?$/, '生年月日は YYYY-MM-DD 形式で入力してください。'] };
  for (const [field, [max, pattern, message]] of Object.entries(optional)) {
    const value = input?.[field] == null ? '' : String(input[field]).trim();
    if (value.length > max || !pattern.test(value) || (field === 'birthday' && value && Number.isNaN(Date.parse(value)))) throw Error(message);
    profile[field] = value;
  }
  if (kanaRequired && !profile.kana.trim()) throw Error('フリガナを入力してください。');
  const gender = input?.gender == null ? '' : String(input.gender).trim();
  if (!['', '1', '2', '9'].includes(gender)) throw Error('性別の指定を確認してください。');
  profile.gender = gender;
  return profile;
}
export function validateMember(input, options) {
  if (typeof input?.salon !== 'string' || !input.salon.trim() || input.salon.trim().length > 80) throw Error('サロン名・ご担当者名を80文字以内で入力してください。');
  const profile = { salon: input.salon.trim(), ...validateProfile(input, options) };
  if (typeof input?.email !== 'string') throw Error('デモ用メールアドレスを入力してください。');
  profile.email = input.email.trim().toLowerCase();
  if (profile.email.length > 150 || !/^[a-z0-9._+-]+@example\.test$/.test(profile.email)) throw Error('デモ用として「salon-a@example.test」のような @example.test のアドレスを使用してください。');
  return profile;
}
export const genderNames = { '': '未回答', 1: '男性', 2: '女性', 9: 'その他' };

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw Error('デモ用パスワードは12〜128文字で入力してください。');
}

export async function passwordDigest(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return { salt, hash: hex(new Uint8Array(digest)) };
}

export function publicMember(member) {
  if (!member) return null;
  const { id, salon, name, email, createdAt, kana = '', phone = '', gender = '', birthday = '', lineId = '', privacyVersion = '', privacyAgreedAt = '' } = member;
  return { id, salon, name, email, createdAt, kana, phone, gender, birthday, lineId, privacyVersion, privacyAgreedAt };
}

export function createMemberStore(storage, sessions, key, now = Date.now) {
  const sessionKey = key + ':session';
  function read() {
    const raw = storage.getItem(key);
    if (!raw) return [];
    let value;
    try { value = JSON.parse(raw); } catch { throw Error('デモ会員の保存データを読み込めません。'); }
    if (!Array.isArray(value)) throw Error('デモ会員の保存データが不正です。');
    return value;
  }
  function write(members) {
    try { storage.setItem(key, JSON.stringify(members)); }
    catch { throw Error('会員情報を保存できません。ブラウザの保存設定を確認してください。'); }
  }
  function startSession(member) {
    sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_IDLE }));
  }
  // 最後の操作から30分で切れる。使うたびに期限を延ばす
  function current() {
    let session;
    try { session = JSON.parse(sessions.getItem(sessionKey) || 'null'); } catch { return null; }
    if (!session || session.expiresAt <= now()) { sessions.removeItem(sessionKey); return null; }
    const member = publicMember(read().find(m => m.id === session.id));
    if (member) sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_IDLE }));
    return member;
  }
  const resetKey = key + ':resets';
  const sha256 = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
  const readResets = () => { try { return JSON.parse(storage.getItem(resetKey) || '[]'); } catch { return []; } };
  return {
    current,
    async request(route, method = 'GET', input) {
      if (route === '/auth/me' && method === 'GET') return { member: current() };
      if (route === '/auth/register' && method === 'POST') {
        const profile = validateMember(input, { kanaRequired: true });
        validatePassword(input.password);
        const consent = privacyConsent(input);
        if (read().some(m => m.email === profile.email)) throw Error('このデモ用メールアドレスは登録済みです。ログインしてください。');
        const digest = await passwordDigest(input.password);
        // Re-read after hashing so registrations from another tab are retained.
        const members = read();
        if (members.some(m => m.email === profile.email)) throw Error('このデモ用メールアドレスは登録済みです。');
        const member = { id: crypto.randomUUID(), ...profile, ...digest, privacyVersion: consent.version, privacyAgreedAt: new Date(now()).toISOString(), createdAt: new Date(now()).toISOString() };
        // Check session storage availability before persisting the registration.
        sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_IDLE }));
        try { write([...members, member]); } catch (error) { sessions.removeItem(sessionKey); throw error; }
        return { member: publicMember(member) };
      }
      if (route === '/auth/login' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
        const member = read().find(m => m.email === email);
        if (typeof input?.password !== 'string' || input.password.length > 128) throw Error('メールアドレスまたはパスワードが違います。');
        const digest = await passwordDigest(input.password, member?.salt || '00000000000000000000000000000000');
        if (!member || member.hash !== digest.hash) throw Error('メールアドレスまたはパスワードが違います。');
        startSession(member);
        return { member: publicMember(member) };
      }
      if (route === '/auth/line/demo' && method === 'POST') {
        // 公開デモ専用：LINEログインの体験。LINEとは通信せず、架空のLINE IDで会員を作成する。
        const lineId = 'Udemo' + crypto.randomUUID().replace(/-/g, '').slice(0, 27);
        const salon = typeof input?.salon === 'string' && input.salon.trim() ? input.salon.trim().slice(0, 80) : 'LINE登録';
        const consent = privacyConsent(input);
        const member = { id: crypto.randomUUID(), salon, name: 'LINE デモ会員', email: `line-${lineId.slice(5, 15).toLowerCase()}@example.test`, salt: '', hash: '', kana: '', phone: '', gender: '', birthday: '', lineId, privacyVersion: consent.version, privacyAgreedAt: new Date(now()).toISOString(), createdAt: new Date(now()).toISOString() };
        const members = read();
        sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_IDLE }));
        try { write([...members, member]); } catch (error) { sessions.removeItem(sessionKey); throw error; }
        return { member: publicMember(member) };
      }
      // パスワード再設定（仕様書 2.1.3）。公開デモはメールを送れないため、再設定用のリンクを画面に返す。
      // サーバー版（auth.mjs）はリンクをメールで送り、応答には含めない。
      if (route === '/auth/password/forgot' && method === 'POST') {
        const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
        const member = read().find(m => m.email === email);
        if (!member) return { sent: true };
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        const resets = readResets().filter(r => r.expiresAt > now() && r.memberId !== member.id);
        storage.setItem(resetKey, JSON.stringify([...resets, { tokenHash: await sha256(token), memberId: member.id, expiresAt: now() + RESET_AGE }]));
        return { sent: true, demoLink: `#reset/${token}` };
      }
      if (route === '/auth/password/reset' && method === 'POST') {
        const token = typeof input?.token === 'string' ? input.token : '';
        validatePassword(input?.password);
        const tokenHash = /^[a-f0-9]{64}$/.test(token) ? await sha256(token) : '';
        const entry = readResets().find(r => r.tokenHash === tokenHash && r.expiresAt > now());
        if (!entry) throw Error('再設定用のリンクが無効か、有効期限（30分）が切れています。もう一度お手続きください。');
        const digest = await passwordDigest(input.password);
        const members = read(), index = members.findIndex(m => m.id === entry.memberId);
        if (index < 0) throw Error('再設定用のリンクが無効です。');
        members[index] = { ...members[index], ...digest };
        write(members);
        storage.setItem(resetKey, JSON.stringify(readResets().filter(r => r.memberId !== entry.memberId)));
        sessions.removeItem(sessionKey);
        return { reset: true };
      }
      // 公開デモ専用：美容室の画面で会員情報を編集したときに、会員の登録情報へ反映する（platform-client.js から呼ぶ）
      if (route === '/auth/admin-profile' && method === 'PATCH') {
        const members = read(), index = members.findIndex(m => m.id === input?.id);
        if (index < 0) throw Error('会員が見つかりません。');
        members[index] = { ...members[index], ...validateProfile(input) };
        write(members);
        return { member: publicMember(members[index]) };
      }
      if (route === '/auth/logout' && method === 'POST') {
        sessions.removeItem(sessionKey);
        return { member: null };
      }
      if (route === '/auth/profile' && method === 'PATCH') {
        const active = current();
        if (!active) throw Error('ログインし直してください。');
        const members = read();
        // 送られなかった項目は今の値のまま（部分更新）。メールアドレス（ログインID）は変えない
        const profile = validateMember({ ...members.find(m => m.id === active.id), ...input, email: active.email }, { kanaRequired: true });
        const index = members.findIndex(m => m.id === active.id);
        members[index] = { ...members[index], ...profile };
        write(members);
        return { member: publicMember(members[index]) };
      }
      throw Error('会員機能の操作が正しくありません。');
    },
  };
}
