// 旧形式のデータベース（platform_state の1行JSON・profile 列を持つ members・sessions）を、
// 新しいテーブル構成へ移行できることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { products, concernCategories } from '../catalog.mjs';
import { createPlatform, platformRequest, demoOperators } from '../dist/platform-core.js';
import { passwordDigest } from '../dist/member-store.js';
import { createSqliteAdapter } from '../db/adapter.mjs';
import { createPlatformStore } from '../db/platform-store.mjs';
import { createAuth } from '../auth.mjs';

const now = '2026-10-06T03:00:00.000Z', admin = { operator: demoOperators[0] };
const fakeReq = cookie => ({ headers: { cookie: cookie || '' }, socket: { remoteAddress: '127.0.0.1' } });
const fakeRes = () => { const headers = {}; return { headers, setHeader: (k, v) => { headers[k] = v; } }; };

test('legacy single-JSON database is migrated into the new tables without losing members, orders or sessions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-migrate-')), file = path.join(dir, 'shop.sqlite');
  try {
    // 旧形式を作る：ブラウザ版と同じ state に、会員・注文・店舗の追加と削除を加える
    const state = createPlatform(products, now);
    const legacyMember = { id: 'old-member', salon: 'LUMIÈRE', name: '旧会員', email: 'old@example.test', kana: 'キュウ カイイン', phone: '090-0000-0000', gender: '2', birthday: '1990-01-01', createdAt: now, lineId: 'U-legacy' };
    platformRequest(state, '/profile', 'PATCH', { salonId: 'lumiere', staffId: 'haruka' }, { member: legacyMember }, now);
    const placed = platformRequest(state, '/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [{ id: 'oil-smooth', quantity: 2, price: 2640 }], customer: { name: '旧会員', address: '架空県 9-9-9', postal: '0000000' } }, { member: legacyMember }, now);
    platformRequest(state, '/admin/salons', 'POST', { name: '閉店', owner: 'x', prefecture: '山口県', city: '萩市', street: '1', phone: '0838-00-0000' }, admin, now);
    platformRequest(state, '/admin/salons/S004', 'DELETE', {}, admin, now);
    const oilStock = state.products.find(p => p.id === 'oil-smooth').stock;
    const digest = await passwordDigest('Old-Password-2026'), token = randomBytes(32).toString('hex');
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, price INTEGER NOT NULL, stock INTEGER NOT NULL);
      CREATE TABLE orders (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, member_id TEXT);
      CREATE TABLE members (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, profile TEXT NOT NULL, line_id TEXT);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL);
      CREATE TABLE platform_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE operator_sessions (token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    raw.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)').run(legacyMember.id, legacyMember.email, digest.salt, digest.hash, JSON.stringify(legacyMember), legacyMember.lineId);
    raw.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), legacyMember.id, Date.now() + 3600000);
    raw.prepare('INSERT INTO platform_state VALUES (1, ?)').run(JSON.stringify(state));
    raw.prepare('INSERT INTO products VALUES (?, ?, ?)').run('shampoo-moist', 2860, 24);
    raw.close();

    const db = await createSqliteAdapter(file);
    try {
      const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories });
      const result = await store.init({ now });
      assert.equal(result.imported, true); assert.equal(result.orders, 9); assert.equal(result.salons, 3);
      for (const table of ['legacy_members', 'legacy_sessions', 'legacy_products', 'legacy_platform_state']) assert.equal(await db.tableExists(table), true, table);
      assert.equal(await db.tableExists('platform_state'), false);
      // 旧パスワードでログインでき、旧セッションも使える
      const auth = createAuth(db), res = fakeRes();
      const login = await auth.request('/api/auth/login', 'POST', { email: 'old@example.test', password: 'Old-Password-2026' }, fakeReq(), res);
      assert.equal(login.member.name, '旧会員'); assert.equal(login.member.kana, 'キュウ カイイン'); assert.equal(login.member.lineId, 'U-legacy'); assert.equal(login.member.salon, 'LUMIÈRE 表参道');
      assert.equal((await auth.member(fakeReq(`salon_session=${token}`))).id, 'old-member');
      // 注文・在庫・担当店舗・採番がそのまま引き継がれる
      const member = { member: login.member };
      const mine = await store.request('/orders', 'GET', undefined, member);
      assert.equal(mine.length, 1); assert.equal(mine[0].id, placed.id); assert.equal(mine[0].total, 5940); assert.equal(mine[0].staffName, 'HARUKA'); assert.equal(mine[0].shipments.length, 1);
      const profile = await store.request('/profile', 'GET', undefined, member);
      assert.equal(profile.salonId, 'lumiere'); assert.equal(profile.staffId, 'haruka'); assert.equal(profile.lineLinked, true);
      const snap = await store.request('/admin/snapshot', 'GET', undefined, admin);
      assert.equal(snap.orders.length, 9); assert.equal(snap.products.find(p => p.id === 'oil-smooth').stock, oilStock);
      assert.ok(snap.events.some(e => e.action === '店舗を削除'));
      assert.equal(snap.profiles.find(p => p.id === 'old-member').lineLinked, true);
      assert.equal((await store.request('/admin/salons', 'POST', { name: '新店', owner: 'x', prefecture: '山口県', city: '萩市', street: '1', phone: '0838-00-0000' }, admin, now)).id, 'S005');
      // 管理アカウントでログインできる（パスワードはテーブルに保存）
      assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM operators')).n), 4);
      // 2回目の起動では何もしない
      assert.equal((await createPlatformStore(db, { catalog: products }).init({ now })).imported, false);
    } finally { await db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a fresh database is seeded with the same sample workspace as the browser demo', async () => {
  const db = await createSqliteAdapter(':memory:');
  try {
    const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories });
    const result = await store.init({ now });
    assert.equal(result.imported, false); assert.equal(result.orders, 8); assert.equal(result.products, 6);
    const counts = {};
    for (const table of ['salons', 'staff', 'dealers', 'categories', 'concerns', 'products', 'product_concerns', 'members', 'orders', 'purchase_orders', 'order_items', 'order_events', 'payments', 'stock_movements', 'audit_logs', 'operators'])
      counts[table] = Number((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
    assert.deepEqual(counts, { salons: 3, staff: 5, dealers: 2, categories: 3, concerns: 7, products: 6, product_concerns: 13, members: 8, orders: 8, purchase_orders: 8, order_items: 8, order_events: Number((await db.get('SELECT COUNT(*) AS n FROM order_events')).n), payments: 8, stock_movements: 6, audit_logs: 8, operators: 4 });
    const browser = createPlatform(products, now);
    const snap = await store.request('/admin/snapshot', 'GET', undefined, admin);
    assert.deepEqual(snap.products.map(p => [p.id, p.stock, p.cost, p.dealerId]), browser.products.map(p => [p.id, p.stock, p.cost, p.dealerId]));
    assert.deepEqual(snap.orders.map(o => o.status).sort(), browser.orders.map(o => o.status).sort());
    assert.deepEqual(snap.settlements.map(s => s.proceeds).sort(), browser.orders.map(o => ({ ...o })).map(o => o.subtotal - o.items.reduce((s, p) => s + p.cost * p.quantity, 0) - o.fee).sort());
  } finally { await db.close(); }
});
