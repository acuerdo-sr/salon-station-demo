// お客様の個人情報を、DBに保存する前にアプリ側で暗号化する（AES-256-GCM）。
// DBを直接見られる人や、DBのバックアップを持つ人は暗号文しか読めない。鍵はDBとは別に保管する。
// メールアドレスでの検索・重複確認には、鍵付きハッシュ（ブラインドインデックス）を使う。
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
export const isEncrypted = value => typeof value === 'string' && value.startsWith(PREFIX);

function parseKey(text) {
  const value = String(text || '').trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw Error('DATA_ENCRYPTION_KEY は32バイトの鍵（base64 または16進数64文字）を指定してください。');
  return key;
}

// 鍵の読み込み：環境変数 DATA_ENCRYPTION_KEY を優先。未設定のローカル版はデータフォルダに鍵ファイルを作る（create: false なら作らない）。
export function loadDataKey({ env = process.env, dataDir, create = true } = {}) {
  if (env.DATA_ENCRYPTION_KEY) return { key: parseKey(env.DATA_ENCRYPTION_KEY), source: 'env' };
  if (!dataDir) throw Error('DATA_ENCRYPTION_KEY が未設定です。');
  const file = path.join(dataDir, 'encryption.key');
  if (!existsSync(file)) {
    if (!create) throw Error(`暗号鍵がありません。DATA_ENCRYPTION_KEY を設定するか、${file} を置いてください。`);
    writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  }
  return { key: parseKey(readFileSync(file, 'utf8')), source: file };
}

// 暗号化して保存する列。メールアドレスの検索には members.email_index（鍵付きハッシュ）を使う。
export const SEALED_COLUMNS = {
  members: ['email', 'name', 'kana', 'phone', 'gender', 'birthday'],
  member_addresses: ['name', 'postal', 'address'],
  orders: ['ship_name', 'ship_postal', 'ship_address', 'ship_email', 'return_reason'],
};
// 空の値は個人情報ではないので、暗号化済みとみなす
export const isSealed = value => value == null || value === '' || isEncrypted(value);
export const sealRow = (c, table, row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, SEALED_COLUMNS[table].includes(k) ? c.encrypt(v) : v]));
export const openRow = (c, table, row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, SEALED_COLUMNS[table].includes(k) ? c.decrypt(v) : v]));
const normalized = value => String(value ?? '').trim().toLowerCase();

// key が無い場合は暗号化しない（平文のまま保存）。検索用の値は鍵なしのハッシュにする。
export function createFieldCrypto(key) {
  if (!key) return { enabled: false, encrypt: v => v, decrypt: v => v, blindIndex: v => createHash('sha256').update(normalized(v)).digest('hex'), digest: v => createHash('sha256').update(String(v ?? '')).digest('hex') };
  const encKey = createHmac('sha256', key).update('salon-station:field-encryption').digest();
  const indexKey = createHmac('sha256', key).update('salon-station:blind-index').digest();
  const digestKey = createHmac('sha256', key).update('salon-station:digest').digest();
  return {
    enabled: true,
    encrypt(value) {
      if (value === null || value === undefined || isEncrypted(value)) return value;
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    // 暗号化前の値（移行前のデータ）はそのまま返す
    decrypt(value) {
      if (!isEncrypted(value)) return value;
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
    blindIndex: value => createHmac('sha256', indexKey).update(normalized(value)).digest('hex'),
    // 注文内容の照合用（同じ注文番号の再送で内容が同じか）。お届け先を含むため、平文ではなく鍵付きハッシュで保存する
    digest: value => createHmac('sha256', digestKey).update(String(value ?? '')).digest('hex'),
  };
}
