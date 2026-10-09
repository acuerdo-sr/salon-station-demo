// 会員・管理者のセッション（最後の操作から30分）、パスワード再設定（メール・30分・1回限り）、
// 版4→版5のDB更新（SQLite の注文の表の作り直し）を確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { products, concernCategories } from '../catalog.mjs';
import { createSqliteAdapter, schemaTable } from '../db/adapter.mjs';
import { createPlatformStore } from '../db/platform-store.mjs';
import { createFieldCrypto } from '../db/crypto.mjs';
import { createAuth } from '../auth.mjs';
import { createPlatformServer } from '../platform-server.mjs';
import { createMailer } from '../mailer.mjs';
import { createMemberStore, SESSION_IDLE, RESET_AGE } from '../dist/member-store.js';

const now = '2026-10-06T03:00:00.000Z';
const minute = 60 * 1000;
const fakeReq = (cookie = '', ip = '127.0.0.1') => ({ headers: { cookie }, socket: { remoteAddress: ip } });
const fakeRes = () => { const headers = {}; return { headers, setHeader: (k, v) => { headers[k] = v; } }; };
const cookieOf = res => String(res.headers['Set-Cookie']).split(';')[0];
const member = { salon: 'LUMIÈRE', name: '個人 太郎', kana: 'コジン タロウ', email: 'kojin@example.test', password: 'Demo-Member-2026', agreePrivacy: true };

async function setup(options = {}) {
  const db = await createSqliteAdapter(':memory:'), fieldCrypto = createFieldCrypto(randomBytes(32));
  const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories, fieldCrypto });
  await store.init({ now });
  let clock = Date.parse(now);
  const mails = [];
  const auth = createAuth(db, { fieldCrypto, now: () => clock, mailer: { send: async m => { mails.push(m); } }, publicOrigin: 'https://shop.example.test', ...options });
  return { db, fieldCrypto, auth, mails, tick: ms => { clock += ms; }, get clock() { return clock; } };
}

test('member sessions end 30 minutes after the last request and are extended by use', async () => {
  const s = await setup();
  try {
    const res = fakeRes();
    await s.auth.request('/api/auth/register', 'POST', member, fakeReq(), res);
    const cookie = cookieOf(res);
    assert.match(String(res.headers['Set-Cookie']), /Max-Age=43200/);
    s.tick(SESSION_IDLE - 2 * minute); assert.equal((await s.auth.member(fakeReq(cookie))).email, member.email);
    s.tick(SESSION_IDLE - 2 * minute); assert.equal((await s.auth.member(fakeReq(cookie))).email, member.email, '操作のたびに30分延びる');
    s.tick(SESSION_IDLE + minute); assert.equal(await s.auth.member(fakeReq(cookie)), null);
  } finally { await s.db.close(); }
});

test('operator sessions also end 30 minutes after the last request', async () => {
  const s = await setup();
  let clock = Date.parse(now);
  const server = await createPlatformServer(s.db, products, s.auth, { fieldCrypto: s.fieldCrypto, concernNames: concernCategories, now: () => clock });
  try {
    const res = fakeRes();
    await server.request('/operator/login', 'POST', { email: 'admin@example.test', password: 'Demo-Admin-2026' }, fakeReq(), res);
    const cookie = String(res.headers['Set-Cookie']).split(';')[0];
    clock += SESSION_IDLE - minute; assert.equal((await server.operator(fakeReq(cookie))).id, 'admin');
    clock += SESSION_IDLE - minute; assert.equal((await server.operator(fakeReq(cookie))).id, 'admin');
    clock += SESSION_IDLE + minute; assert.equal(await server.operator(fakeReq(cookie)), null);
  } finally { await s.db.close(); }
});

test('password reset: a one-time link valid for 30 minutes is e-mailed; unknown addresses get the same answer; old sessions end', async () => {
  const s = await setup();
  try {
    const res = fakeRes();
    await s.auth.request('/api/auth/register', 'POST', member, fakeReq(), res);
    const oldCookie = cookieOf(res);
    assert.deepEqual(await s.auth.request('/api/auth/password/forgot', 'POST', { email: 'nobody@example.test' }, fakeReq(), fakeRes()), { sent: true });
    assert.equal(s.mails.length, 0);
    assert.deepEqual(await s.auth.request('/api/auth/password/forgot', 'POST', { email: ' KOJIN@example.test ' }, fakeReq(), fakeRes()), { sent: true });
    assert.equal(s.mails.length, 1); assert.equal(s.mails[0].to, member.email); assert.match(s.mails[0].subject, /パスワード再設定/);
    const token = /https:\/\/shop\.example\.test\/#reset\/([a-f0-9]{64})/.exec(s.mails[0].text)[1];
    assert.ok(!(await s.db.all('SELECT token_hash FROM password_resets')).some(r => r.token_hash === token), 'トークンはハッシュで保存する');
    await assert.rejects(s.auth.request('/api/auth/password/reset', 'POST', { token: 'f'.repeat(64), password: 'New-Password-2026' }, fakeReq(), fakeRes()), /無効/);
    await assert.rejects(s.auth.request('/api/auth/password/reset', 'POST', { token, password: 'short' }, fakeReq(), fakeRes()), /12/);
    assert.deepEqual(await s.auth.request('/api/auth/password/reset', 'POST', { token, password: 'New-Password-2026' }, fakeReq(), fakeRes()), { reset: true });
    assert.equal(await s.auth.member(fakeReq(oldCookie)), null, '再設定したら、ほかのログインは切れる');
    await assert.rejects(s.auth.request('/api/auth/login', 'POST', { email: member.email, password: member.password }, fakeReq(), fakeRes()), /違います/);
    assert.equal((await s.auth.request('/api/auth/login', 'POST', { email: member.email, password: 'New-Password-2026' }, fakeReq(), fakeRes())).member.email, member.email);
    await assert.rejects(s.auth.request('/api/auth/password/reset', 'POST', { token, password: 'Another-Password-2026' }, fakeReq(), fakeRes()), /無効/, '1回限り');
    // 30分を過ぎたリンクは使えない
    await s.auth.request('/api/auth/password/forgot', 'POST', { email: member.email }, fakeReq('', '10.0.0.2'), fakeRes());
    const second = /#reset\/([a-f0-9]{64})/.exec(s.mails[1].text)[1];
    s.tick(RESET_AGE + minute);
    await assert.rejects(s.auth.request('/api/auth/password/reset', 'POST', { token: second, password: 'Another-Password-2026' }, fakeReq(), fakeRes()), /有効期限/);
    // 同じ接続元・同じアドレスからは1時間に5回まで
    for (let i = 0; i < 5; i++) await s.auth.request('/api/auth/password/forgot', 'POST', { email: 'x@example.test' }, fakeReq('', '10.0.0.9'), fakeRes());
    await assert.rejects(s.auth.request('/api/auth/password/forgot', 'POST', { email: 'x@example.test' }, fakeReq('', '10.0.0.9'), fakeRes()), /回数が多い/);
  } finally { await s.db.close(); }
});

test('local mail is saved to the outbox with the address and body encrypted, not sent', async () => {
  const s = await setup(), lines = [];
  try {
    const mailer = createMailer(s.db, { fieldCrypto: s.fieldCrypto, env: {}, log: line => lines.push(line) });
    assert.equal(mailer.mode, 'outbox');
    await mailer.send({ to: 'kojin@example.test', subject: '件名', text: '本文 https://shop.example.test/#reset/abc' });
    const row = await s.db.get('SELECT * FROM mail_outbox');
    assert.equal(row.transport, 'outbox'); assert.equal(row.status, 'saved'); assert.equal(row.subject, '件名');
    assert.match(row.to_address, /^enc:v1:/); assert.match(row.body, /^enc:v1:/);
    assert.equal(s.fieldCrypto.decrypt(row.body), '本文 https://shop.example.test/#reset/abc');
    assert.equal(lines.length, 1);
  } finally { await s.db.close(); }
});

test('browser demo: password reset shows the link on screen instead of sending mail; the session slides', async () => {
  const memory = () => { const d = new Map(); return { getItem: k => d.get(k) ?? null, setItem: (k, v) => d.set(k, v), removeItem: k => d.delete(k) }; };
  let clock = Date.parse(now);
  const members = createMemberStore(memory(), memory(), 'm', () => clock);
  await members.request('/auth/register', 'POST', member);
  const { demoLink } = await members.request('/auth/password/forgot', 'POST', { email: member.email });
  const token = demoLink.split('/')[1];
  assert.deepEqual(await members.request('/auth/password/reset', 'POST', { token, password: 'New-Password-2026' }), { reset: true });
  assert.equal(members.current(), null);
  await members.request('/auth/login', 'POST', { email: member.email, password: 'New-Password-2026' });
  await assert.rejects(members.request('/auth/password/reset', 'POST', { token, password: 'New-Password-2027' }), /無効/);
  assert.deepEqual(await members.request('/auth/password/forgot', 'POST', { email: 'nobody@example.test' }), { sent: true });
  clock += SESSION_IDLE - minute; assert.ok(members.current());
  clock += SESSION_IDLE + minute; assert.equal(members.current(), null);
});

test('a version-4 database is upgraded: the orders table is rebuilt to allow pending payments, keeping data, indexes and foreign keys', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    await createPlatformStore(db, { catalog: products, concernNames: concernCategories }).init({ now });
    const before = Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n);
    // 版4の注文の表（支払方法・電話番号の列がなく、支払状態は決済済み・返金済みだけ）
    const v4 = schemaTable('sqlite', 'orders').replace('CREATE TABLE IF NOT EXISTS orders', 'CREATE TABLE orders_v4')
      .replace(/\s*payment_method TEXT[^\n]*\n/, '\n').replace("('pending','captured','refunded','voided')", "('captured','refunded')").replace(" ship_phone TEXT NOT NULL DEFAULT '',", '');
    assert.ok(!v4.includes('payment_method') && !v4.includes('ship_phone') && v4.includes("('captured','refunded')"));
    const keep = (await db.tableColumns('orders')).filter(c => !['payment_method', 'ship_phone'].includes(c)).join(', ');
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.exec(`${v4}; INSERT INTO orders_v4 (${keep}) SELECT ${keep} FROM orders; DROP TABLE orders; ALTER TABLE orders_v4 RENAME TO orders;`);
    await db.exec('PRAGMA foreign_keys=ON');
    await db.exec("ALTER TABLE member_addresses DROP COLUMN phone; DROP TABLE member_cards; DROP TABLE password_resets; DROP TABLE mail_outbox; UPDATE app_meta SET meta_value='4' WHERE meta_key='schema_version'");
    const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories });
    await store.init({ now });
    assert.equal((await db.get("SELECT meta_value FROM app_meta WHERE meta_key='schema_version'")).meta_value, '6');
    for (const column of ['payment_method', 'ship_phone']) assert.ok((await db.tableColumns('orders')).includes(column), column);
    assert.ok((await db.tableColumns('member_addresses')).includes('phone'));
    for (const table of ['member_cards', 'password_resets', 'mail_outbox']) assert.ok(await db.tableExists(table), table);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n), before);
    const indexes = (await db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'")).map(r => r.name);
    for (const name of ['orders_salon_date', 'orders_member', 'orders_created']) assert.ok(indexes.includes(name), name);
    assert.equal(Number((await db.get('PRAGMA foreign_keys')).foreign_keys), 1);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    const id = (await db.get('SELECT id FROM orders LIMIT 1')).id;
    await db.run("UPDATE orders SET payment_status='pending' WHERE id=?", [id]);
    await assert.rejects(db.run("UPDATE orders SET payment_status='unknown' WHERE id=?", [id]), /CHECK/);
    const snap = await store.request('/admin/snapshot', 'GET', undefined, { operator: { id: 'admin', role: 'admin', name: '運営管理者' } }, now);
    assert.equal(snap.orders.length, before); assert.ok(snap.orders.every(o => o.paymentMethod === 'card'));
  } finally { await db.close(); }
});
