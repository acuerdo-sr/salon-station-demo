// 加盟店スタッフの LINE 連携：発注画面を LINE から開いたときのログイン、管理アカウントへの連携、発注・出荷の LINE 通知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function startServer(port, dir, env) { const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); await new Promise((resolve, reject) => { child.stdout.on('data', d => { if (d.toString().includes('local demo:')) resolve(); }); child.on('error', reject); child.on('exit', code => reject(Error('server exited ' + code))); }); return child; }
async function stopServer(child) { if (!child || child.exitCode !== null) return; const done = once(child, 'exit'); child.kill(); await done; }
const until = (check, timeout = 3000) => new Promise((resolve, reject) => { const started = Date.now(); (function tick() { if (check()) return resolve(); if (Date.now() - started > timeout) return reject(Error('timeout')); setTimeout(tick, 50); })(); });

test('salon staff link LINE, log in from the LINE mini app and get order and shipment notices once', async () => {
  const pushes = [];
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; const form = Object.fromEntries(new URLSearchParams(raw));
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/oauth2/v2.1/verify') return String(form.id_token).startsWith('idtoken-') ? send(200, { sub: 'U-' + form.id_token.slice(8), name: 'スタッフ' }) : send(400, { error: 'invalid_token' });
    if (req.url === '/v2/bot/message/push') { pushes.push(JSON.parse(raw)); return send(200, {}); }
    send(404, {});
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  const env = { LINE_CHANNEL_ID: '1234', LINE_CHANNEL_SECRET: 'secret', LIFF_ID: '', LIFF_ID_ORDER: 'liff-order', LINE_MESSAGING_TOKEN: 'bot-token', LINE_API_BASE: mockBase, LINE_AUTH_BASE: mockBase, PUBLIC_ORIGIN: '' };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'salon-line-op-')), port = 14826, base = `http://127.0.0.1:${port}`;
  const call = async (route, method = 'GET', body, cookie = '') => { const r = await fetch(base + '/api' + route, { method, headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] || '' }; };
  let child;
  try {
    child = await startServer(port, dir, env);
    assert.equal((await call('/auth/line/config')).body.orderLiffId, 'liff-order');
    assert.match((await fetch(base + '/order.html')).headers.get('content-security-policy'), /static\.line-scdn\.net/);
    // 未連携の LINE ではログインできない
    assert.equal((await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' })).status, 404);
    assert.equal((await call('/platform/operator/line', 'POST', { idToken: 'bad' })).status, 502);
    // メールでログインしてから連携する
    const login = await call('/platform/operator/login', 'POST', { email: 'salon@example.test', password: 'Demo-Admin-2026' });
    assert.equal(login.body.operator.lineLinked, false);
    const link = await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' }, login.cookie);
    assert.equal(link.status, 200); assert.equal(link.body.linked, true); assert.equal(link.body.operator.lineLinked, true);
    // 別の管理アカウントには同じ LINE を連携できない
    const adminLogin = await call('/platform/operator/login', 'POST', { email: 'admin@example.test', password: 'Demo-Admin-2026' });
    assert.equal((await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' }, adminLogin.cookie)).status, 409);
    // 次回からは LINE だけでログイン
    const viaLine = await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' });
    assert.equal(viaLine.status, 200); assert.ok(viaLine.cookie);
    assert.equal((await call('/platform/operator/me', 'GET', undefined, viaLine.cookie)).body.operator.id, 'salon-a');
    // 発注 → 受付の通知、出荷 → 出荷の通知（再送や二度押しでは増えない）
    const ws = (await call('/platform/supply', 'GET', undefined, viaLine.cookie)).body, p = ws.products.find(x => x.id === 'treatment-repair');
    const input = { requestKey: crypto.randomUUID(), items: [{ id: p.id, quantity: 2, price: p.wholesalePrice }] };
    const order = await call('/platform/supply/orders', 'POST', input, viaLine.cookie);
    assert.equal(order.status, 200);
    await until(() => pushes.length >= 1);
    assert.equal(pushes[0].to, 'U-staff'); assert.match(pushes[0].messages[0].text, /発注を受け付けました/); assert.ok(pushes[0].messages[0].text.includes(order.body.id));
    assert.equal((await call('/platform/supply/orders', 'POST', input, viaLine.cookie)).body.id, order.body.id);
    await call('/platform/admin/supply-orders/' + order.body.id, 'PATCH', { status: 'accepted' }, adminLogin.cookie);
    await call('/platform/admin/supply-orders/' + order.body.id, 'PATCH', { status: 'shipped', carrier: 'デモ配送', tracking: 'W-777' }, adminLogin.cookie);
    await call('/platform/admin/supply-orders/' + order.body.id, 'PATCH', { status: 'shipped', carrier: 'デモ配送', tracking: 'W-777' }, adminLogin.cookie);
    await until(() => pushes.length >= 2);
    assert.match(pushes[1].messages[0].text, /出荷しました/); assert.match(pushes[1].messages[0].text, /W-777/);
    // 定期発注が作成されたときも知らせる
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    assert.equal((await call('/platform/supply/subscriptions', 'POST', { interval: 'weekly', startOn: today, items: [{ id: 'shampoo-air', quantity: 1 }] }, viaLine.cookie)).status, 200);
    const runResult = await call('/platform/admin/supply/run', 'POST', {}, adminLogin.cookie);
    assert.equal(runResult.body.created.length, 1);
    await until(() => pushes.length >= 3);
    assert.match(pushes[2].messages[0].text, /定期発注を作成しました/);
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(pushes.length, 3);
    // 再起動後も連携は残り、起動時の定期発注チェックで同じ発注を重複作成しない
    await stopServer(child); child = await startServer(port, dir, env);
    assert.equal((await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' })).status, 200);
    assert.equal((await call('/platform/supply', 'GET', undefined, (await call('/platform/operator/line', 'POST', { idToken: 'idtoken-staff' })).cookie)).body.orders.filter(o => o.source === 'subscription').length, 1);
  } finally { await stopServer(child); mock.close(); await rm(dir, { recursive: true, force: true }); }
});
