// Demonstration membership. Pages storage is not a security boundary.
export const SESSION_AGE = 24 * 60 * 60 * 1000;
const ITERATIONS = 600000;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));

export function validateMember(input) {
  const profile = {};
  for (const field of ['salon', 'name']) {
    if (typeof input?.[field] !== 'string' || !input[field].trim() || input[field].trim().length > 80) throw Error('サロン名・ご担当者名を80文字以内で入力してください。');
    profile[field] = input[field].trim();
  }
  if (typeof input?.email !== 'string') throw Error('デモ用メールアドレスを入力してください。');
  profile.email = input.email.trim().toLowerCase();
  if (profile.email.length > 150 || !/^[a-z0-9._+-]+@example\.test$/.test(profile.email)) throw Error('デモ用として「salon-a@example.test」のような @example.test のアドレスを使用してください。');
  // 仕様書 2.6.2 会員マスタの任意項目（フリガナ・電話番号・性別・生年月日）。未入力は空文字で保存する。
  const optional = { kana: [50, /^[ぁ-んァ-ヶー・\s　]*$/, 'フリガナはかな・カナで50文字以内で入力してください。'], phone: [15, /^[0-9-]*$/, '電話番号は半角数字・ハイフンで15文字以内で入力してください。'], birthday: [10, /^(\d{4}-\d{2}-\d{2})?$/, '生年月日は YYYY-MM-DD 形式で入力してください。'] };
  for (const [field, [max, pattern, message]] of Object.entries(optional)) {
    const value = input?.[field] == null ? '' : String(input[field]).trim();
    if (value.length > max || !pattern.test(value) || (field === 'birthday' && value && Number.isNaN(Date.parse(value)))) throw Error(message);
    profile[field] = value;
  }
  const gender = input?.gender == null ? '' : String(input.gender).trim();
  if (!['', '1', '2', '9'].includes(gender)) throw Error('性別の指定を確認してください。');
  profile.gender = gender;
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
  const { id, salon, name, email, createdAt, kana = '', phone = '', gender = '', birthday = '' } = member;
  return { id, salon, name, email, createdAt, kana, phone, gender, birthday };
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
    sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_AGE }));
  }
  function current() {
    let session;
    try { session = JSON.parse(sessions.getItem(sessionKey) || 'null'); } catch { return null; }
    if (!session || session.expiresAt <= now()) return null;
    return publicMember(read().find(m => m.id === session.id));
  }
  return {
    current,
    async request(route, method = 'GET', input) {
      if (route === '/auth/me' && method === 'GET') return { member: current() };
      if (route === '/auth/register' && method === 'POST') {
        const profile = validateMember(input);
        validatePassword(input.password);
        if (read().some(m => m.email === profile.email)) throw Error('このデモ用メールアドレスは登録済みです。ログインしてください。');
        const digest = await passwordDigest(input.password);
        // Re-read after hashing so registrations from another tab are retained.
        const members = read();
        if (members.some(m => m.email === profile.email)) throw Error('このデモ用メールアドレスは登録済みです。');
        const member = { id: crypto.randomUUID(), ...profile, ...digest, createdAt: new Date(now()).toISOString() };
        // Check session storage availability before persisting the registration.
        sessions.setItem(sessionKey, JSON.stringify({ id: member.id, expiresAt: now() + SESSION_AGE }));
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
      if (route === '/auth/logout' && method === 'POST') {
        sessions.removeItem(sessionKey);
        return { member: null };
      }
      if (route === '/auth/profile' && method === 'PATCH') {
        const active = current();
        if (!active) throw Error('ログインし直してください。');
        const members = read();
        const profile = validateMember({ ...input, email: active.email });
        const index = members.findIndex(m => m.id === active.id);
        members[index] = { ...members[index], ...profile };
        write(members);
        return { member: publicMember(members[index]) };
      }
      throw Error('会員機能の操作が正しくありません。');
    },
  };
}
