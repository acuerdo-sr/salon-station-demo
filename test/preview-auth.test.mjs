// 確認用サイト（Cloudflare Pages）の ID・パスワード（functions/_middleware.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, credentials } from '../functions/_middleware.js';

const env = { SITE_USER: 'review', SITE_PASSWORD: 'パス-2026' };
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
const call = (headers = {}, e = env) => onRequest({ request: new Request('https://preview.example/shop.html', { headers }), env: e, next: async () => new Response('<h1>ok</h1>', { headers: { 'Content-Type': 'text/html' } }) });

test('preview site: shown only with the right ID and password; nothing is shown until both are set', async () => {
  let r = await call({}, {});
  assert.equal(r.status, 503, '未設定なら誰にも見せない');
  r = await call();
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /^Basic realm="SALON STATION preview"/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  for (const wrong of [basic('review', 'パス-2025'), basic('reviewer', 'パス-2026'), basic('review', ''), 'Basic !!!', 'Bearer abc', basic('', '')]) assert.equal((await call({ Authorization: wrong })).status, 401, wrong);
  r = await call({ Authorization: basic('review', 'パス-2026') });
  assert.equal(r.status, 200); assert.equal(await r.text(), '<h1>ok</h1>');
  assert.equal(r.headers.get('content-type'), 'text/html'); assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow', '検索エンジンに載せない');
  assert.deepEqual(credentials(basic('a', 'b:c')), { user: 'a', pass: 'b:c' }, 'パスワードにコロンを含められる');
});
