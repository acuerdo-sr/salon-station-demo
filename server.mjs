import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { products, concernCategories } from './catalog.mjs';
import { openDatabase } from './db/adapter.mjs';
import { loadDataKey, createFieldCrypto } from './db/crypto.mjs';
import { createMailer } from './mailer.mjs';
import { createImageStore, UPLOAD_PATH } from './images.mjs';
import { createAuth } from './auth.mjs';
import { createPlatformServer } from './platform-server.mjs';
import { createLineAuth, lineConfigFromEnv, LINE_STATE_COOKIE } from './line.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
// DATABASE_URL=mysql://… なら MySQL 8.0、未設定なら data/shop.sqlite（SQLite）。テーブル定義は db/schema.*.sql。
const db = await openDatabase({ sqliteFile: path.join(dataDir, 'shop.sqlite') });
// お客様の個人情報はアプリで暗号化してDBに保存する。鍵は DATA_ENCRYPTION_KEY（未設定のローカル版は data/encryption.key）。
const dataKey = loadDataKey({ dataDir });
const fieldCrypto = createFieldCrypto(dataKey.key);
const port = Number(process.env.PORT || 4175);
const origin = `http://127.0.0.1:${port}`;
// LINE連携（仕様書 2.2.7 / 2.4）。HTTPSトンネル等で外部公開する場合は PUBLIC_ORIGIN / ALLOWED_HOSTS / TRUST_PROXY を設定する。
const lineConfig = lineConfigFromEnv(process.env, origin);
const secure = lineConfig.publicOrigin.startsWith('https://');
// パスワード再設定のメール（SMTP_URL があれば送信、なければ mail_outbox に保存してこの画面に表示）
const mailer = createMailer(db, { fieldCrypto });
const auth = createAuth(db, { secure, fieldCrypto, mailer, publicOrigin: lineConfig.publicOrigin });
// 管理画面から登録した商品画像（data/uploads/products）
const images = createImageStore(path.join(dataDir, 'uploads'));
const line = createLineAuth(auth, lineConfig);
const extraHosts = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(lineConfig.publicOrigin).host, ...extraHosts]);
const allowedOrigins = new Set([origin, `http://localhost:${port}`, lineConfig.publicOrigin, ...extraHosts.flatMap(h => [`https://${h}`, `http://${h}`])]);
const usesLiff = Boolean(lineConfig.liffId || lineConfig.orderLiffId);
const csp = `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'${usesLiff ? ' https://static.line-scdn.net' : ''}; connect-src 'self'${usesLiff ? ' https://static.line-scdn.net https://liffsdk.line-scdn.net https://api.line.me https://liff.line.me' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
// LINE通知（Messaging API トークン設定時のみ）：新規注文と出荷を LINE連携済みの会員へ送る。
// 業務ロジックが「実際に起きた変化」だけを effects として返し、さらに notifications テーブルで1件につき1回に限定する。
const notifyLine = async (recipient, lineId, kind, reference, text, store) => {
 if (!(await store.claimNotification(recipient, 'line', kind, reference))) return;
 line.notify(lineId, text)
  .then(() => store.finishNotification('line', kind, reference, 'sent'))
  .catch(error => { console.error('LINE notify:', error.message); return store.finishNotification('line', kind, reference, 'failed', error.message); })
  .catch(error => console.error('LINE notify record:', error.message));
};
// 業務ロジックが「実際に起きた変化」だけを effects として返し、さらに notifications テーブルで1件につき1回に限定する。
async function onChange({ effects, store }) {
 if (!line.config.notifications) return;
 for (const effect of effects) {
  if (effect.type === 'order_placed' || effect.type === 'shipped') {
   // お客様への通知：新規注文と出荷
   const reference = effect.type === 'shipped' ? effect.purchaseOrderId : effect.orderId;
   const order = await store.orderForNotice(effect.orderId, effect.purchaseOrderId);
   const member = order && await auth.findById(order.memberId);
   if (!member?.lineId) continue;
   await notifyLine(member.id, member.lineId, effect.type, reference, effect.type === 'order_placed'
    ? `【SALON STATION】ご注文を受け付けました。\n注文番号：${order.id}\n合計：¥${order.total.toLocaleString('ja-JP')}\n配送状況は購入履歴からご確認いただけます。`
    : `【SALON STATION】商品を出荷しました。\n注文番号：${order.id}\n配送：${order.carrier} / 追跡番号 ${order.tracking}`, store);
  }
  if (effect.type === 'supply_placed' || effect.type === 'supply_shipped') {
   // 加盟店スタッフへの通知：仕入発注の受付（定期発注を含む）と出荷
   const order = await store.supplyForNotice(effect.supplyOrderId);
   if (!order) continue;
   const text = effect.type === 'supply_placed'
    ? `【SALON STATION 本部】${order.source === 'subscription' ? '定期発注を作成しました' : '発注を受け付けました'}。\n発注番号：${order.id}\n合計：¥${order.total.toLocaleString('ja-JP')}`
    : `【SALON STATION 本部】ご発注の商品を出荷しました。\n発注番号：${order.id}\n配送：${order.carrier} / 追跡番号 ${order.tracking}`;
   for (const op of await store.operatorsWithLine(order.salonId)) await notifyLine(`op:${op.id}`, op.line_id, effect.type, `${order.id}:${op.id}`, text, store);
  }
 }
}
const platformServer = await createPlatformServer(db, products, auth, { secure, concernNames: concernCategories, onChange, fieldCrypto, images, verifyLineToken: idToken => line.verify(idToken) });
if (dataKey.source !== 'env') console.log(`個人情報の暗号鍵：${dataKey.source}（本番では DATA_ENCRYPTION_KEY を設定し、DBとは別の場所に保管してください）`);
if (db.dialect === 'sqlite' && await db.tableExists('legacy_members')) console.warn('旧形式の表（legacy_*）に暗号化前の個人情報が残っています。移行を確認したら削除してください（README「DBへのアクセス」）。');
// 期日を迎えた定期発注を起動時と10分ごとに作成する
async function runDueSubscriptions() {
 try { const effects = [], result = await platformServer.store.runDueSubscriptions(new Date().toISOString(), effects); if (result.created.length || result.failed.length) console.log(`定期発注：作成${result.created.length}件・失敗${result.failed.length}件`); if (effects.length) await onChange({ effects, store: platformServer.store }); }
 catch (error) { console.error('定期発注の実行に失敗しました:', error.message); }
}
await runDueSubscriptions();
setInterval(runDueSubscriptions, 10 * 60 * 1000).unref();
function json(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
function fail(message, status=400) { const e=new Error(message); e.status=status; throw e; }
function appendCookie(res, value) { const previous = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(previous ? [].concat(previous) : []), value]); }
const readCookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
// 本文はバイト列のまま集めてから一度だけ UTF-8 に変換する（チャンク境界で日本語が分断されても文字化けしない）。
// 商品の登録・編集だけは画像（data URL）を含むため上限を大きくする
async function readBody(req, limit = 32768) {
 if(!req.headers['content-type']?.startsWith('application/json')) fail('JSON形式で送信してください。',415);
 const chunks=[]; let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>limit) fail('送信内容が大きすぎます。',413);chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('送信形式が正しくありません。');}
}

const server = http.createServer(async (req, res) => {
 try {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', csp);
  if (!allowedHosts.has(req.headers.host)) return json(res,403,{error:'ローカルホストからアクセスしてください。'});
  const url = new URL(req.url, origin);
  if(!['GET','HEAD'].includes(req.method) && !allowedOrigins.has(req.headers.origin)) return json(res,403,{error:'同じローカルサイトから操作してください。'});
  if (url.pathname === '/api/auth/line/config' && req.method === 'GET') return json(res, 200, line.config);
  if (url.pathname === '/api/auth/line/start' && req.method === 'GET') {
   try {
    const { url: authorizeUrl, state } = line.start(url.searchParams, await auth.member(req));
    // LINEからのコールバックはサイト外からの遷移なので SameSite=Lax（Strict だと送られない）。
    res.setHeader('Set-Cookie', `${LINE_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/line; Max-Age=600${secure ? '; Secure' : ''}`);
    res.writeHead(302, { Location: authorizeUrl, 'Cache-Control': 'no-store' }); return res.end();
   }
   catch (error) { return json(res, error.status || 400, { error: error.message }); }
  }
  if (url.pathname === '/api/auth/line/callback' && req.method === 'GET') {
   let target;
   try { const { member, redirect } = await line.callback(url.searchParams, readCookie(req, LINE_STATE_COOKIE)); await auth.startSession(req, res, member); target = redirect; }
   catch (error) { console.error('LINE login failed:', error.message); target = line.errorRedirect(error.code); }
   appendCookie(res, `${LINE_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/line; Max-Age=0${secure ? '; Secure' : ''}`);
   // 302ではなく同一サイトからの遷移にして、SameSite=Strict のセッションCookieを確実に送る。
   const safe = target.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
   res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Refresh: `0; url=${target}` });
   return res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>LINEログイン</title></head><body><p>ストアへ移動しています…</p><p><a href="${safe}">移動しない場合はこちら</a></p></body></html>`);
  }
  if (url.pathname === '/api/auth/line/liff' && req.method === 'POST') {
   try { const member = await line.liff(await readBody(req), await auth.member(req)); await auth.startSession(req, res, member); return json(res, 200, { member }); }
   catch (error) { return json(res, error.status || 400, { error: error.message }); }
  }
  if(url.pathname.startsWith('/api/platform/')) {
   const limit = /^\/api\/platform\/admin\/products(\/|$)/.test(url.pathname) ? 3 * 1024 * 1024 : 32768;
   try {return json(res,200,await platformServer.request(url.pathname.slice('/api/platform'.length),req.method,req.method==='GET'?undefined:await readBody(req, limit),req,res));}
   catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if (url.pathname.startsWith('/api/auth/')) {
   try { return json(res,200,await auth.request(url.pathname, req.method, req.method==='GET'?undefined:await readBody(req),req,res)); }
   catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if (url.pathname.startsWith('/api/')) return json(res,404,{error:'この操作は利用できません。'});
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not allowed'});
  // 管理画面から登録した商品画像。ファイル名は乱数（images.mjs）で、それ以外のパスは配信しない
  if (UPLOAD_PATH.test(url.pathname)) {
   const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[url.pathname.split('.').pop()];
   try { const body = readFileSync(path.join(images.dir, path.basename(url.pathname))); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' }); return res.end(req.method === 'HEAD' ? undefined : body); }
   catch { return json(res, 404, { error: '画像が見つかりません。' }); }
  }
  let relative;
  try { relative = decodeURIComponent(url.pathname === '/' || url.pathname === '/index.html' ? '/shop.html' : url.pathname); }
  catch { return json(res,400,{error:'URLの形式が正しくありません。'}); }
  const staticRoot = path.join(root,'dist');
  const file = path.resolve(staticRoot, '.' + relative);
  if (!file.startsWith(staticRoot + path.sep)) return json(res,403,{error:'Forbidden'});
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
  try { const body=readFileSync(file); res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); res.end(req.method==='HEAD'?undefined:body); }
  catch { json(res,404,{error:'ページが見つかりません。'}); }
 } catch(e) { console.error(e.message); if(!res.headersSent) json(res,e.status||500,{error:e.status?e.message:'処理に失敗しました。もう一度お試しください。'}); }
});
server.listen(port, '127.0.0.1', () => console.log(`SALON STATION local demo: ${origin}`));
