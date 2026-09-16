import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { products } from './catalog.mjs';
import { createAuth } from './auth.mjs';
import { createPlatformServer } from './platform-server.mjs';
import { createLineAuth, lineConfigFromEnv } from './line.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'shop.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, price INTEGER NOT NULL CHECK(price>=0), stock INTEGER NOT NULL CHECK(stock>=0));
 CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);`);
if (!db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'member_id')) db.exec('ALTER TABLE orders ADD COLUMN member_id TEXT');
const auth = createAuth(db);
const seed = db.prepare('INSERT OR IGNORE INTO products VALUES (?, ?, ?)');
for (const p of products) seed.run(p.id, p.price, p.stock);
const catalog = () => products.map(p => ({ ...p, ...db.prepare('SELECT price, stock FROM products WHERE id=?').get(p.id) }));
const port = Number(process.env.PORT || 4175);
const origin = `http://127.0.0.1:${port}`;
// LINE連携（仕様書 2.2.7 / 2.4）。HTTPSトンネル等で外部公開する場合は PUBLIC_ORIGIN / ALLOWED_HOSTS を設定する。
const lineConfig = lineConfigFromEnv(process.env, origin);
const line = createLineAuth(auth, lineConfig);
const extraHosts = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(lineConfig.publicOrigin).host, ...extraHosts]);
const allowedOrigins = new Set([origin, `http://localhost:${port}`, lineConfig.publicOrigin, ...extraHosts.flatMap(h => [`https://${h}`, `http://${h}`])]);
const csp = `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'${lineConfig.liffId ? ' https://static.line-scdn.net' : ''}; connect-src 'self'${lineConfig.liffId ? ' https://static.line-scdn.net https://liffsdk.line-scdn.net https://api.line.me https://liff.line.me' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const platformServer = createPlatformServer(db, products, auth, { onChange: ({ route, method, input, result, state }) => {
 // LINE通知（Messaging API トークン設定時のみ）：注文受付と出荷を LINE連携済みの会員へ送る。
 const send = (memberId, text) => { const m = memberId && auth.findById(memberId); if (m?.lineId) line.notify(m.lineId, text).catch(error => console.error('LINE notify:', error.message)); };
 if (route === '/orders' && method === 'POST') send(result.memberId, `【SALON STATION】ご注文を受け付けました。\n注文番号：${result.id}\n合計：¥${Number(result.total).toLocaleString('ja-JP')}\n配送状況は購入履歴からご確認いただけます。`);
 if (/^\/admin\/purchase-orders\/[^/]+$/.test(route) && method === 'PATCH' && input?.status === 'shipped') { const order = state.orders.find(o => o.id === result.orderId); if (order) send(order.memberId, `【SALON STATION】商品を出荷しました。\n注文番号：${order.id}\n配送：${result.carrier} / 追跡番号 ${result.tracking}`); }
} });
function json(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
function fail(message, status=400) { const e=new Error(message); e.status=status; throw e; }
async function readBody(req) {
 if(!req.headers['content-type']?.startsWith('application/json')) fail('JSON形式で送信してください。',415);
 let raw=''; for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768) fail('送信内容が大きすぎます。',413);}
 try{return JSON.parse(raw);}catch{fail('送信形式が正しくありません。');}
}
function calculate(input) {
 if(!input||!Array.isArray(input.items)||!input.items.length||input.items.length>50) fail('カートに商品を追加してください。');
 const seen=new Set(), current=catalog();
 const items=input.items.map(item=>{
  if(!item||typeof item.id!=='string'||seen.has(item.id)) fail('商品指定が正しくありません。');
  seen.add(item.id);
  const p=current.find(p=>p.id===item.id);
  if(!p) fail('商品が見つかりません。');
  if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>99) fail('数量は1〜99の整数で指定してください。');
  if(item.quantity>p.stock) fail(`${p.name}の在庫が不足しています（残り${p.stock}点）。`,409);
  if(item.price!==p.price) fail(`${p.name}の価格が変更されました。カートから確認し直してください。`,409);
  return {id:p.id,name:p.name,size:p.size,image:p.image,price:p.price,quantity:item.quantity};
 });
 const subtotal=items.reduce((sum,p)=>sum+p.price*p.quantity,0), shipping=subtotal>=11000?0:660;
 return {items,subtotal,shipping,total:subtotal+shipping};
}
function customerData(value) {
 if(!value||typeof value!=='object') fail('お届け先を入力してください。');
 const result={};
 for(const [key,max] of Object.entries({salon:80,name:80,email:150,address:250,note:500})){
  if(typeof value[key]!=='string'||value[key].trim().length>max||(!value[key].trim()&&key!=='note')) fail('お届け先の入力内容を確認してください。');
  result[key]=value[key].trim();
 }
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) fail('メールアドレスの形式を確認してください。');
 return result;
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
   try { res.writeHead(302, { Location: line.start(url.searchParams, auth.member(req)), 'Cache-Control': 'no-store' }); return res.end(); }
   catch (error) { return json(res, error.status || 400, { error: error.message }); }
  }
  if (url.pathname === '/api/auth/line/callback' && req.method === 'GET') {
   let target;
   try { const { member, redirect } = await line.callback(url.searchParams); auth.startSession(req, res, member); target = redirect; }
   catch (error) { console.error('LINE login failed:', error.message); target = line.errorRedirect(error.status ? error.message : 'LINEログインに失敗しました。'); }
   // 302ではなく同一サイトからの遷移にして、SameSite=Strict のセッションCookieを確実に送る。
   const safe = target.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
   res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Refresh: `0; url=${target}` });
   return res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>LINEログイン</title></head><body><p>ストアへ移動しています…</p><p><a href="${safe}">移動しない場合はこちら</a></p></body></html>`);
  }
  if (url.pathname === '/api/auth/line/liff' && req.method === 'POST') {
   try { const member = await line.liff(await readBody(req), auth.member(req)); auth.startSession(req, res, member); return json(res, 200, { member }); }
   catch (error) { return json(res, error.status || 400, { error: error.message }); }
  }
  if(url.pathname.startsWith('/api/platform/')) {
   try {return json(res,200,await platformServer.request(url.pathname.slice('/api/platform'.length),req.method,req.method==='GET'?undefined:await readBody(req),req,res));}
   catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if (url.pathname.startsWith('/api/auth/')) {
   try { return json(res,200,await auth.request(url.pathname, req.method, req.method==='GET'?undefined:await readBody(req),req,res)); }
   catch(error){return json(res,error.status||400,{error:error.message});}
  }
  if (url.pathname === '/api/products' && req.method === 'GET') return json(res,200,catalog());
  if (url.pathname === '/api/orders' && req.method === 'GET') {
   const memberId=auth.member(req)?.id??null;
   return json(res,200,db.prepare('SELECT payload FROM orders WHERE member_id IS ? ORDER BY created_at DESC').all(memberId).map(r=>JSON.parse(r.payload)));
  }
  if (url.pathname === '/api/quote' && req.method === 'POST') return json(res,200,calculate(await readBody(req)));
  if (url.pathname === '/api/orders' && req.method === 'POST') {
   const input=await readBody(req);
   const memberId=auth.member(req)?.id??null;
   if(input?.memberId!==undefined&&input.memberId!==memberId) fail('ログイン状態が変わりました。カートから確認し直してください。',401);
   if(!input||typeof input.requestKey!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestKey)) fail('注文の識別子が不正です。');
   const existing=db.prepare('SELECT payload, member_id FROM orders WHERE request_key=?').get(input.requestKey);
   if(existing) {if(existing.member_id!==memberId) fail('この注文は取得できません。',403);return json(res,200,JSON.parse(existing.payload));}
   const customer=customerData(input.customer);
   db.exec('BEGIN IMMEDIATE');
   try {
    const quote=calculate(input);
    const order={id:'DEMO-'+randomUUID().slice(0,8).toUpperCase(),createdAt:new Date().toISOString(),status:'テスト注文受付',memberId,customer,...quote};
    for(const item of quote.items) db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(item.quantity,item.id);
    db.prepare('INSERT INTO orders (id,request_key,created_at,payload,member_id) VALUES (?, ?, ?, ?, ?)').run(order.id,input.requestKey,order.createdAt,JSON.stringify(order),memberId);
    db.exec('COMMIT'); return json(res,201,order);
   } catch(e){db.exec('ROLLBACK');throw e;}
  }
  if (url.pathname.startsWith('/api/products/') && req.method === 'PATCH') {
   const id=decodeURIComponent(url.pathname.slice('/api/products/'.length)), input=await readBody(req);
   if(!products.some(p=>p.id===id)) fail('商品が見つかりません。',404);
   if(!input||!Number.isInteger(input.price)||input.price<1||input.price>1000000||!Number.isInteger(input.stock)||input.stock<0||input.stock>99999) fail('価格は1〜1,000,000円、在庫は0〜99,999の整数を入力してください。');
   db.prepare('UPDATE products SET price=?, stock=? WHERE id=?').run(input.price,input.stock,id);
   return json(res,200,catalog().find(p=>p.id===id));
  }
  if (url.pathname.startsWith('/api/')) return json(res,404,{error:'この操作は利用できません。'});
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'Method not allowed'});
  const relative = decodeURIComponent(url.pathname === '/' || url.pathname === '/index.html' ? '/shop.html' : url.pathname);
  const staticRoot = path.join(root,'dist');
  const file = path.resolve(staticRoot, '.' + relative);
  if (!file.startsWith(staticRoot + path.sep)) return json(res,403,{error:'Forbidden'});
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
  try { const body=readFileSync(file); res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); res.end(req.method==='HEAD'?undefined:body); }
  catch { json(res,404,{error:'ページが見つかりません。'}); }
 } catch(e) { console.error(e.message); if(!res.headersSent) json(res,e.status||500,{error:e.status?e.message:'処理に失敗しました。もう一度お試しください。'}); }
});
server.listen(port, '127.0.0.1', () => console.log(`SALON STATION local demo: ${origin}`));
