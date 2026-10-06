// HTTPサーバーの結合テスト：会員限定（旧APIの撤去）、会員セッション、Origin検査、本文の文字コード、
// ログイン試行制限、静的ファイル配信、再起動後の保持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const port = 14821, base = `http://127.0.0.1:${port}`;
async function start(dir, env = {}) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DATA_DIR: dir, LINE_CHANNEL_ID: '', LINE_CHANNEL_SECRET: '', PUBLIC_ORIGIN: '', TRUST_PROXY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => { child.stdout.on('data', d => { if (d.toString().includes('local demo:')) resolve(); }); child.on('error', reject); child.on('exit', code => reject(Error('server exited: ' + code))); });
  return child;
}
async function stop(child) { if (!child || child.exitCode !== null) return; const ended = once(child, 'exit'); child.kill(); await ended; }
const call = async (route, method = 'GET', body, cookie = '', headers = {}) => {
  const res = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
};
// 本文を2回に分けて送り、UTF-8の1文字（3バイト）を境界で分断する。
function splitBodyRequest(route, json, cookie) {
  const bytes = Buffer.from(JSON.stringify(json), 'utf8');
  const cut = bytes.indexOf(Buffer.from('花', 'utf8')) + 1;
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/api' + route, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Origin: base, Cookie: cookie } }, res => { let raw = ''; res.setEncoding('utf8'); res.on('data', c => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject);
    req.write(bytes.subarray(0, cut));
    setTimeout(() => req.end(bytes.subarray(cut)), 80);
  });
}

test('server: closed store, member sessions, origin checks, UTF-8 bodies, login throttling and persistence', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-server-test-'));
  let child;
  const details = email => ({ salon: 'テスト会員サロン', name: '会員担当', email, password: 'Demo-Member-2026' });
  const order = (items = [{ id: 'shampoo-moist', price: 2860, quantity: 1 }]) => ({ salonId: 'lumiere', items, customer: { name: 'デモ 花子', postal: '0000000', address: '架空県 1-2-3' }, requestKey: randomUUID() });
  try {
    child = await start(dir);
    await t.test('guests cannot read prices; legacy endpoints are gone', async () => {
      assert.equal((await call('/products')).status, 404);
      assert.equal((await call('/quote', 'POST', { items: [] })).status, 404);
      assert.equal((await call('/products/shampoo-moist', 'PATCH', { price: 1, stock: 1 })).status, 404);
      assert.equal((await call('/orders')).status, 404);
      const boot = (await call('/platform/bootstrap')).body;
      assert.deepEqual(boot.products, []); assert.ok(boot.salons.length >= 3);
      assert.equal((await call('/platform/quote', 'POST', { salonId: 'lumiere', items: [{ id: 'shampoo-moist', price: 2860, quantity: 1 }] })).status, 401);
    });
    let cookieA, memberA, orderA;
    await t.test('member sessions isolate orders, reject forged identity and invalidate logout', async () => {
      const a = await call('/auth/register', 'POST', details('a@example.test'));
      assert.equal(a.status, 200); assert.match(a.cookie, /HttpOnly/); assert.match(a.cookie, /SameSite=Strict/); assert.doesNotMatch(a.cookie, /Secure/);
      cookieA = a.cookie.split(';')[0]; memberA = a.body.member;
      assert.equal(memberA.hash, undefined);
      assert.equal((await call('/auth/register', 'POST', details('A@example.test'))).status, 400);
      assert.equal((await call('/platform/bootstrap', 'GET', undefined, cookieA)).body.products.length, 6);
      assert.equal((await call('/platform/profile', 'PATCH', { salonId: 'lumiere', staffId: 'haruka' }, cookieA)).status, 200);
      const input = order(); const placed = await call('/platform/orders', 'POST', input, cookieA);
      assert.equal(placed.status, 200); orderA = placed.body;
      assert.equal((await call('/platform/orders', 'GET', undefined, cookieA)).body.length, 1);
      const b = await call('/auth/register', 'POST', details('b@example.test')), cookieB = b.cookie.split(';')[0];
      assert.equal((await call('/platform/orders', 'GET', undefined, cookieB)).body.length, 0);
      assert.equal((await call('/platform/profile', 'PATCH', { salonId: 'lumiere', staffId: '' }, cookieB)).status, 200);
      assert.equal((await call('/platform/orders', 'POST', input, cookieB)).status, 403);
      const edit = await call('/auth/profile', 'PATCH', { salon: '変更サロン', name: '変更担当', email: 'forged@example.test' }, cookieA);
      assert.equal(edit.body.member.email, memberA.email);
      await call('/auth/logout', 'POST', {}, cookieA);
      assert.equal((await call('/auth/me', 'GET', undefined, cookieA)).body.member, null);
      assert.equal((await call('/platform/orders', 'POST', order(), cookieA)).status, 401);
      assert.equal((await call('/auth/login', 'POST', { ...details('a@example.test'), password: 'Incorrect-password' })).status, 400);
      const login = await call('/auth/login', 'POST', details('a@example.test'));
      assert.equal(login.status, 200); assert.notEqual(login.cookie.split(';')[0], cookieA); cookieA = login.cookie.split(';')[0];
    });
    await t.test('foreign origins cannot change data', async () => {
      assert.equal((await call('/auth/profile', 'PATCH', { salon: 'x', name: 'x' }, cookieA, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await call('/platform/orders', 'POST', order(), cookieA, { Origin: 'https://evil.example' })).status, 403);
    });
    await t.test('Japanese text split across request chunks is stored intact', async () => {
      const result = await splitBodyRequest('/auth/profile', { salon: '表参道サロン', name: 'デモ 花子さん' }, cookieA);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.member.name, 'デモ 花子さん');
      assert.equal((await call('/auth/me', 'GET', undefined, cookieA)).body.member.name, 'デモ 花子さん');
    });
    await t.test('failed logins lock only that address and e-mail, not everyone', async () => {
      await call('/auth/register', 'POST', details('victim@example.test'));
      for (let i = 0; i < 10; i++) assert.equal((await call('/auth/login', 'POST', { email: 'victim@example.test', password: 'Wrong-password-' + i })).status, 400);
      assert.equal((await call('/auth/login', 'POST', details('victim@example.test'))).status, 429);
      assert.equal((await call('/auth/login', 'POST', details('a@example.test'))).status, 200);
      for (let i = 0; i < 10; i++) await call('/platform/operator/login', 'POST', { email: 'admin@example.test', password: 'bad-' + i });
      assert.equal((await call('/platform/operator/login', 'POST', { email: 'admin@example.test', password: 'Demo-Admin-2026' })).status, 429);
      assert.equal((await call('/platform/operator/login', 'POST', { email: 'salon@example.test', password: 'Demo-Admin-2026' })).status, 200);
    });
    await t.test('static pages: storefront at root, legacy UI removed, malformed URLs rejected', async () => {
      const root = await fetch(base + '/'); assert.equal(root.status, 200); assert.match(await root.text(), /storefront\.js/);
      assert.match(await (await fetch(base + '/index.html')).text(), /storefront\.js/);
      assert.equal((await fetch(base + '/app.js')).status, 404);
      assert.equal((await fetch(base + '/%E0%A4')).status, 400);
      assert.equal((await fetch(base + '/..%2fserver.mjs')).status, 403);
    });
    await stop(child); child = await start(dir);
    await t.test('members, sessions and orders survive a restart', async () => {
      assert.equal((await call('/auth/me', 'GET', undefined, cookieA)).body.member.id, memberA.id);
      const mine = (await call('/platform/orders', 'GET', undefined, cookieA)).body;
      assert.equal(mine.length, 1); assert.equal(mine[0].id, orderA.id); assert.equal(mine[0].items[0].price, 2860);
    });
  } finally { await stop(child); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'salon-server-test-')); await rm(dir, { recursive: true, force: true }); }
});

test('server: behind a trusted proxy the client address comes from X-Forwarded-For; https origin sets Secure cookies', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-server-proxy-'));
  const child = await start(dir, { TRUST_PROXY: '1', PUBLIC_ORIGIN: 'https://shop.example.test' });
  try {
    const register = await call('/auth/register', 'POST', { salon: 'x', name: 'x', email: 'p@example.test', password: 'Demo-Member-2026' });
    assert.match(register.cookie, /Secure/);
    const from = ip => ({ 'X-Forwarded-For': ip });
    for (let i = 0; i < 10; i++) await call('/auth/login', 'POST', { email: 'p@example.test', password: 'bad-password-' + i }, '', from('203.0.113.1'));
    assert.equal((await call('/auth/login', 'POST', { email: 'p@example.test', password: 'Demo-Member-2026' }, '', from('203.0.113.1'))).status, 429);
    assert.equal((await call('/auth/login', 'POST', { email: 'p@example.test', password: 'Demo-Member-2026' }, '', from('198.51.100.7'))).status, 200);
  } finally { await stop(child); await rm(dir, { recursive: true, force: true }); }
});
