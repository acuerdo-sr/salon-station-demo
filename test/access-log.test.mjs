// DBアクセスの範囲とアクセス記録：
// ・お客様の個人情報はアプリで暗号化してDBに保存する（DBを直接見ても、バックアップを持ち出しても読めない）。
// ・個人情報を含む画面の受け取り・CSV出力・保守ツールでの参照を、誰が・いつ・何件・何のためにと日本語で記録する。
// 記録の規則はブラウザ版と DB版で同じ結果になることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { products, concernCategories } from '../catalog.mjs';
import { demoOperators } from '../dist/platform-core.js';
import { memberRef } from '../dist/privacy.js';
import { formatAddress } from '../dist/person.js';
import { ACCESS_VIEW_INTERVAL_MS } from '../dist/access-log.js';
import { createSqliteAdapter } from '../db/adapter.mjs';
import { createPlatformStore } from '../db/platform-store.mjs';
import { createFieldCrypto, loadDataKey, isEncrypted } from '../db/crypto.mjs';
import { createAuth } from '../auth.mjs';
import { engines, linkMember } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z', later = minutes => new Date(Date.parse(now) + minutes * 60000).toISOString();
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] }, botanica = { operator: demoOperators[3] };
const secret = { name: '個人 太郎', postal: '1234567', prefecture: '東京都', city: '秘密市', street: '9-8-7', building: '秘密ハイツ101', phone: '09012345678' };
secret.address = formatAddress(secret);
const pick = row => ({ actorName: row.actorName, role: row.role, salonId: row.salonId, action: row.action, target: row.target, count: row.count, channel: row.channel });
const fakeReq = cookie => ({ headers: { cookie: cookie || '' }, socket: { remoteAddress: '127.0.0.1' } });
const fakeRes = () => { const headers = {}; return { headers, setHeader: (k, v) => { headers[k] = v; } }; };
const placeOrder = (e, actor, items, at = now) => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items, customer: secret }, actor, at);

test('field encryption: AES-GCM round trip with a fresh IV, tampering is detected, the search hash depends on the key', () => {
  const c = createFieldCrypto(randomBytes(32)), other = createFieldCrypto(randomBytes(32));
  const a = c.encrypt('個人 太郎'), b = c.encrypt('個人 太郎');
  assert.ok(isEncrypted(a)); assert.notEqual(a, b); assert.equal(c.decrypt(a), '個人 太郎'); assert.equal(c.decrypt(''), '');
  assert.equal(c.encrypt(a), a, '暗号化済みの値は二重に暗号化しない');
  assert.equal(c.decrypt('移行前の平文'), '移行前の平文');
  const raw = Buffer.from(a.slice('enc:v1:'.length), 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => c.decrypt('enc:v1:' + raw.toString('base64')));
  assert.throws(() => other.decrypt(a));
  assert.equal(c.blindIndex(' Taro@Example.test '), c.blindIndex('taro@example.test'));
  assert.notEqual(c.blindIndex('taro@example.test'), other.blindIndex('taro@example.test'));
  assert.match(createFieldCrypto(null).blindIndex('taro@example.test'), /^[0-9a-f]{64}$/);
});

test('encryption key: taken from DATA_ENCRYPTION_KEY, otherwise a key file is created once in the data folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-key-'));
  try {
    const hex = randomBytes(32).toString('hex');
    assert.equal(loadDataKey({ env: { DATA_ENCRYPTION_KEY: hex }, dataDir: dir }).key.toString('hex'), hex);
    assert.throws(() => loadDataKey({ env: { DATA_ENCRYPTION_KEY: 'short' }, dataDir: dir }), /32バイト/);
    assert.equal(existsSync(path.join(dir, 'encryption.key')), false);
    const first = loadDataKey({ env: {}, dataDir: dir }), second = loadDataKey({ env: {}, dataDir: dir });
    assert.equal(first.key.length, 32); assert.deepEqual(first.key, second.key);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'encryption.key'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [name, create] of engines(now)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });

  run('screens that carry personal data are recorded per salon, once per 30 minutes unless the count changes; headquarters is not recorded', async e => {
    const taro = await e.member('kojin-taro', secret.name);
    await linkMember(e.call, taro, 'lumiere', 'haruka');
    await placeOrder(e, taro, [{ id: 'shampoo-moist', quantity: 1, price: 2860 }, { id: 'oil-smooth', quantity: 1, price: 2640 }]);
    // 本部は集計値と会員番号だけを受け取るので記録しない
    assert.deepEqual((await e.call('/admin/snapshot', 'GET', undefined, { ...admin, ip: '203.0.113.9' })).accessLogs, []);
    // 美容室：自店の会員（サンプル3人＋個人 太郎）
    const first = await e.call('/admin/snapshot', 'GET', undefined, { ...salonOp, ip: '198.51.100.2' });
    const customers = new Set([...first.profiles.map(p => p.id), ...first.orders.map(o => o.memberId)]).size;
    assert.equal(customers, 4);
    assert.deepEqual(first.accessLogs.map(pick), [{ actorName: 'LUMIÈRE 店舗担当', role: '美容室', salonId: 'lumiere', action: '表示', target: '会員一覧・注文のお客様情報', count: 4, channel: '管理画面' }]);
    assert.equal(first.accessLogs[0].ip, undefined, '接続元は本部にだけ見せる'); assert.equal(first.accessLogs[0].actorId, undefined);
    // 15秒ごとの再読み込みでは増えない。30分たつか、件数が変わると記録する
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(10))).accessLogs.length, 1);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(10 + ACCESS_VIEW_INTERVAL_MS / 60000))).accessLogs.length, 2);
    const hanako = await e.member('kojin-hanako', '個人 花子');
    await e.call('/profile', 'PATCH', { salonId: 'lumiere', staffId: '' }, hanako);
    const grown = await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(45));
    assert.deepEqual(grown.accessLogs.map(r => r.count), [5, 4, 4]);
    // ディーラー：発送先を受け取った店舗ごとに、お客様の人数を記録する
    const d = await e.call('/admin/snapshot', 'GET', undefined, { ...sena, ip: '192.0.2.44' }, later(50));
    const refs = new Map((await e.call('/admin/snapshot', 'GET', undefined, admin)).orders.map(o => [o.id, o.customerRef]));
    const expected = new Map();
    for (const p of d.purchaseOrders) { if (!expected.has(p.salonId)) expected.set(p.salonId, new Set()); expected.get(p.salonId).add(refs.get(p.orderId)); }
    assert.deepEqual(d.accessLogs.map(r => [r.salonId, r.role, r.target, r.count]).sort(), [...expected].map(([salonId, set]) => [salonId, 'ディーラー', '発送先（お名前・郵便番号・住所）', set.size]).sort());
    assert.ok(d.accessLogs.every(r => r.actorName === 'SENA ディーラー担当'));
    // 本部はすべての記録と接続元を見られる。美容室は自店のお客様に関する記録（ディーラーの分も）、ディーラーは自分の記録だけ
    const all = (await e.call('/admin/snapshot', 'GET', undefined, admin)).accessLogs;
    assert.ok(all.some(r => r.actorId === 'salon-a' && r.ip === '198.51.100.2'));
    assert.ok(all.some(r => r.role === 'ディーラー' && r.ip === '192.0.2.44'));
    const mine = (await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(51))).accessLogs;
    assert.ok(mine.every(r => r.salonId === 'lumiere')); assert.ok(mine.some(r => r.role === 'ディーラー'));
    const other = (await e.call('/admin/snapshot', 'GET', undefined, botanica, later(52))).accessLogs;
    assert.ok(other.length > 0 && other.every(r => r.actorName === 'BOTANICA ディーラー担当'));
    // 記録に個人情報の値は入らない
    const text = JSON.stringify(all);
    for (const value of [secret.name, secret.address, secret.city, secret.postal, 'kojin-taro@example.test']) assert.ok(!text.includes(value), value);
  });

  run('CSV exports with customer data are recorded after checking that every row belongs to the salon', async e => {
    const s = await e.call('/admin/snapshot', 'GET', undefined, salonOp);
    const orderIds = s.orders.map(o => o.id), memberIds = s.profiles.map(p => p.id);
    assert.deepEqual(await e.call('/admin/exports', 'POST', { kind: 'orders', ids: orderIds }, salonOp, later(1)), { logged: 1 });
    assert.deepEqual(await e.call('/admin/exports', 'POST', { kind: 'members', ids: memberIds }, salonOp, later(2)), { logged: 1 });
    assert.deepEqual(await e.call('/admin/exports', 'POST', { kind: 'members', ids: [] }, salonOp), { logged: 0 });
    const foreign = (await e.call('/admin/snapshot', 'GET', undefined, admin)).orders.find(o => o.salonId !== 'lumiere').id;
    await assert.rejects(e.call('/admin/exports', 'POST', { kind: 'orders', ids: [...orderIds, foreign] }, salonOp), /対象/);
    await assert.rejects(e.call('/admin/exports', 'POST', { kind: 'secrets', ids: orderIds }, salonOp), /一覧/);
    await assert.rejects(e.call('/admin/exports', 'POST', { kind: 'orders', ids: 'all' }, salonOp), /対象/);
    await assert.rejects(e.call('/admin/exports', 'POST', { kind: 'orders', ids: orderIds }, admin), /権限/);
    await assert.rejects(e.call('/admin/exports', 'POST', { kind: 'orders', ids: orderIds }, {}), /ログイン/);
    const logs = (await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(3))).accessLogs.filter(r => r.action === 'CSV出力');
    assert.deepEqual(logs.map(r => [r.target, r.count]), [['会員一覧（全項目）', memberIds.length], ['受注一覧（お客様名）', orderIds.length]]);
    if (e.sql) assert.equal((await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(4))).revision, s.revision, '出力の記録で他の画面を再読み込みさせない');
  });
}

async function encryptedStore(db, key = randomBytes(32)) {
  const fieldCrypto = createFieldCrypto(key);
  const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories, fieldCrypto });
  await store.init({ now });
  return { store, fieldCrypto, auth: createAuth(db, { fieldCrypto }), key };
}
async function registerCustomer({ store, auth }, email = 'Kojin-Taro@example.test') {
  const registered = await auth.request('/api/auth/register', 'POST', { salon: 'x', name: secret.name, kana: 'コジン タロウ', phone: '090-1234-5678', email, password: 'Demo-Member-2026', agreePrivacy: true }, fakeReq(), fakeRes());
  const member = { member: registered.member };
  await linkMember((r, m, i, a) => store.request(r, m, i, a, now), member, 'lumiere', 'haruka');
  await store.request('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'shampoo-moist', quantity: 1, price: 2860 }], customer: secret }, member, now);
  return registered.member;
}
const plaintextIn = (text, values = [secret.name, secret.address, secret.city, secret.building, secret.postal, 'kojin-taro@example.test', 'コジン タロウ', '09012345678']) => values.filter(v => text.includes(v));

test('sqlite: customer fields are stored encrypted, while e-mail login, duplicate checks and the screens keep working', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    const ctx = await encryptedStore(db), taro = await registerCustomer(ctx);
    const rows = { members: await db.all('SELECT * FROM members'), member_addresses: await db.all('SELECT * FROM member_addresses'), orders: await db.all('SELECT * FROM orders') };
    assert.deepEqual(plaintextIn(JSON.stringify(rows)), [], 'DBを直接見ても個人情報は読めない');
    const row = rows.members.find(m => m.id === taro.id);
    for (const k of ['email', 'name', 'kana', 'phone']) assert.ok(isEncrypted(row[k]), k);
    assert.match(row.email_index, /^[0-9a-f]{64}$/);
    // メールアドレスは大文字・小文字を区別せず検索・重複確認できる
    await assert.rejects(ctx.auth.request('/api/auth/register', 'POST', { salon: 'x', name: '個人 二郎', kana: 'コジン ジロウ', email: 'KOJIN-TARO@example.test', password: 'Demo-Member-2026', agreePrivacy: true }, fakeReq(), fakeRes()), /登録済み/);
    const login = await ctx.auth.request('/api/auth/login', 'POST', { email: 'kojin-taro@example.test', password: 'Demo-Member-2026' }, fakeReq(), fakeRes());
    assert.equal(login.member.name, secret.name); assert.equal(login.member.phone, '09012345678');
    // 画面には復号した値を渡す（担当サロン）
    const salon = await ctx.store.request('/admin/snapshot', 'GET', undefined, salonOp, now);
    assert.equal(salon.profiles.find(p => p.id === taro.id).name, secret.name);
    assert.equal(salon.orders.find(o => o.memberId === taro.id).customer.address, secret.address);
    assert.equal((await ctx.store.request('/profile', 'GET', undefined, { member: taro }, now)).address.address, secret.address);
  } finally { await db.close(); }
});

test('sqlite: the access log is append-only', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    const { store } = await encryptedStore(db);
    await store.request('/admin/snapshot', 'GET', undefined, salonOp, now);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM data_access_logs')).n), 1);
    await assert.rejects(db.run("UPDATE data_access_logs SET actor_name='書き換え'"), /変更できません/);
    await assert.rejects(db.run('DELETE FROM data_access_logs'), /削除できません/);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM data_access_logs')).n), 1);
  } finally { await db.close(); }
});

test('sqlite: the maintenance tool decrypts one member at a time and always records who looked and why', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    const ctx = await encryptedStore(db), taro = await registerCustomer(ctx), ref = memberRef(taro.id);
    await assert.rejects(ctx.store.lookupMember({ ref, by: '保守 担当', purpose: '確認' }), /目的/);
    await assert.rejects(ctx.store.lookupMember({ ref, purpose: 'お問い合わせ対応' }), /担当者名/);
    await assert.rejects(ctx.store.lookupMember({ ref: 'M-NOTFOUND', by: '保守 担当', purpose: 'お問い合わせ対応' }), /会員番号/);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM data_access_logs')).n), 0);
    const found = await ctx.store.lookupMember({ ref: ref.toLowerCase(), by: '保守 担当', purpose: 'お問い合わせ対応（配送先の確認）' }, later(1));
    assert.equal(found.ref, ref); assert.equal(found.name, secret.name); assert.equal(found.address.address, secret.address); assert.equal(found.orders, 1); assert.equal(found.id, undefined);
    const logs = (await ctx.store.request('/admin/snapshot', 'GET', undefined, admin, later(2))).accessLogs;
    assert.deepEqual(logs.map(r => ({ ...pick(r), refs: r.refs, purpose: r.purpose })), [{ actorName: '保守 担当', role: 'DB保守', salonId: 'lumiere', action: '保守ツールで参照', target: '会員情報（暗号化を解除して参照）', count: 1, channel: '保守ツール', refs: ref, purpose: 'お問い合わせ対応（配送先の確認）' }]);
    assert.ok((await ctx.store.request('/admin/snapshot', 'GET', undefined, salonOp, later(3))).accessLogs.some(r => r.role === 'DB保守'), '担当サロンにも見える');
  } finally { await db.close(); }
});

test('sqlite: a database encrypted with one key refuses to start with another key or without a key', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    const ctx = await encryptedStore(db);
    await registerCustomer(ctx);
    await assert.rejects(encryptedStore(db, randomBytes(32)), /鍵と違います/);
    await assert.rejects(createPlatformStore(db, { catalog: products, concernNames: concernCategories }).init({ now }), /DATA_ENCRYPTION_KEY を設定/);
    await encryptedStore(db, ctx.key);
  } finally { await db.close(); }
});

test('sqlite: upgrading a version-3 database encrypts existing customer data and leaves no plaintext in the file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-seal-')), file = path.join(dir, 'shop.sqlite');
  const fileText = async () => (await Promise.all([file, file + '-wal'].filter(existsSync).map(f => readFile(f)))).map(b => b.toString('utf8')).join('');
  let db;
  try {
    // 前の版（schema_version 3）：暗号化なし・email_index とアクセス記録の表がない
    db = await createSqliteAdapter(file);
    const plain = createFieldCrypto(null), store = createPlatformStore(db, { catalog: products, concernNames: concernCategories });
    await store.init({ now });
    const taro = await registerCustomer({ store, auth: createAuth(db, { fieldCrypto: plain }) });
    await db.exec("DROP INDEX members_email_index; ALTER TABLE members DROP COLUMN email_index; DROP TABLE data_access_logs; UPDATE app_meta SET meta_value='3' WHERE meta_key='schema_version'");
    await db.close(); db = null;
    assert.ok(plaintextIn(await fileText()).length > 0, '前の版のファイルには平文がある');
    // 鍵を設定して起動すると、列を追加し、既存の行を暗号化し、ファイルを詰め直す
    db = await createSqliteAdapter(file);
    const ctx = await encryptedStore(db);
    assert.ok((await db.tableColumns('members')).includes('email_index'));
    assert.equal((await db.get("SELECT meta_value FROM app_meta WHERE meta_key='schema_version'")).meta_value, '7');
    assert.ok((await db.all('SELECT email, name FROM members')).every(m => isEncrypted(m.email) && isEncrypted(m.name)));
    const login = await ctx.auth.request('/api/auth/login', 'POST', { email: 'kojin-taro@example.test', password: 'Demo-Member-2026' }, fakeReq(), fakeRes());
    assert.equal(login.member.id, taro.id); assert.equal(login.member.name, secret.name);
    assert.equal((await ctx.store.request('/orders', 'GET', undefined, { member: login.member }, now))[0].customer.address, secret.address);
    await db.close(); db = null;
    assert.deepEqual(plaintextIn(await fileText()), [], 'DBファイルに暗号化前の値が残らない');
  } finally { await db?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('maintenance commands: db:migrate brings the database up to date; customer:lookup prints one member and records it', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-cli-'));
  const script = (name, args = []) => spawnSync(process.execPath, [`scripts/${name}.mjs`, ...args], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir, DATABASE_URL: '', DATA_ENCRYPTION_KEY: '' }, encoding: 'utf8', windowsHide: true });
  try {
    // DBも鍵もない状態では、参照ツールは何も作らずに止まる
    const missing = script('customer-lookup', ['--ref', 'M-00000000', '--by', '保守 担当', '--purpose', 'お問い合わせ対応']);
    assert.equal(missing.status, 1); assert.match(missing.stderr, /見つかりません/); assert.equal(existsSync(path.join(dir, 'encryption.key')), false);
    const migrated = script('db-migrate');
    assert.equal(migrated.status, 0, migrated.stderr); assert.match(migrated.stdout, /最新の版（7）/);
    const db = await createSqliteAdapter(path.join(dir, 'shop.sqlite'));
    const ctx = await encryptedStore(db, loadDataKey({ dataDir: dir }).key), taro = await registerCustomer(ctx);
    await db.close();
    const noPurpose = script('customer-lookup', ['--ref', memberRef(taro.id), '--by', '保守 担当']);
    assert.equal(noPurpose.status, 1); assert.match(noPurpose.stderr, /目的/);
    const found = script('customer-lookup', ['--ref', memberRef(taro.id), '--by', '保守 担当', '--purpose', 'お問い合わせ対応（配送先の確認）']);
    assert.equal(found.status, 0, found.stderr);
    for (const value of [memberRef(taro.id), secret.name, secret.address, 'kojin-taro@example.test', 'アクセス記録に残りました']) assert.ok(found.stdout.includes(value), value);
    const after = await createSqliteAdapter(path.join(dir, 'shop.sqlite'));
    try { assert.deepEqual((await after.all('SELECT actor_name, role, channel, member_refs FROM data_access_logs')).map(r => ({ ...r })), [{ actor_name: '保守 担当', role: 'DB保守', channel: '保守ツール', member_refs: memberRef(taro.id) }]); }
    finally { await after.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
