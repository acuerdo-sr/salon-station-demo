// LINE連携（仕様書 2.2.7 ② / 2.4）のテスト。LINEのAPIは同一プロセス内のモックサーバーで代替する。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLineAuth} from '../line.mjs';

async function startServer(port,dir,env){const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),DATA_DIR:dir,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{if(d.toString().includes('local demo:'))resolve();});child.on('error',reject);child.on('exit',code=>reject(Error('server exited '+code)));});return child;}
async function stopServer(child){if(!child||child.exitCode!==null)return;const done=once(child,'exit');child.kill();await done;}
const until=(check,timeout=3000)=>new Promise((resolve,reject)=>{const started=Date.now();(function tick(){if(check())return resolve();if(Date.now()-started>timeout)return reject(Error('timeout'));setTimeout(tick,50);})();});

test('LINE login: OAuth callback, LIFF token, account linking and Messaging API notifications',async()=>{
  const pushes=[];
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const form=Object.fromEntries(new URLSearchParams(raw));
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.url==='/oauth2/v2.1/token')return form.code==='good-code'&&form.client_secret==='secret'&&form.client_id==='1234'?send(200,{access_token:'at',id_token:'idtoken-oauth'}):send(400,{error:'invalid_grant',error_description:'bad code'});
    if(req.url==='/oauth2/v2.1/verify'){if(!String(form.id_token).startsWith('idtoken-')||form.client_id!=='1234')return send(400,{error:'invalid_token'});return send(200,{iss:'https://access.line.me',sub:'U-'+form.id_token.slice(8),aud:form.client_id,name:'ライン 太郎',nonce:form.nonce});}
    if(req.url==='/v2/bot/message/push'){pushes.push({auth:req.headers.authorization,body:JSON.parse(raw)});return send(200,{});}
    send(404,{error:'not found'});
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const mockBase=`http://127.0.0.1:${mock.address().port}`;
  const env={LINE_CHANNEL_ID:'1234',LINE_CHANNEL_SECRET:'secret',LIFF_ID:'liff-1',LINE_MESSAGING_TOKEN:'bot-token',LINE_API_BASE:mockBase,LINE_AUTH_BASE:mockBase,PUBLIC_ORIGIN:''};
  const dir=await mkdtemp(path.join(os.tmpdir(),'salon-line-test-')),port=14823,base=`http://127.0.0.1:${port}`;
  const call=async(route,method='GET',body,cookie='')=>{const r=await fetch(base+'/api'+route,{method,headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};};
  const cookieOf=(raw,name)=>(raw||'').split(/,(?=\s*\w+=)/).map(c=>c.trim().split(';')[0]).find(c=>c.startsWith(name+'='))||'';
  // 開始：認可URLと、ブラウザに保存される state Cookie を返す
  const begin=async(cookie='',query='')=>{const r=await fetch(base+'/api/auth/line/start'+query,{redirect:'manual',headers:{Cookie:cookie}});assert.equal(r.status,302);const raw=r.headers.get('set-cookie');assert.match(raw,/salon_line_state=[0-9a-f]{32}; HttpOnly; SameSite=Lax; Path=\/api\/auth\/line/);const location=new URL(r.headers.get('location'));return {location,state:location.searchParams.get('state'),stateCookie:cookieOf(raw,'salon_line_state')};};
  // コールバック：LINEから戻ったブラウザが送る Cookie（state Cookie と、あればセッション）を付ける
  const finish=async(state,stateCookie='',session='')=>{const r=await fetch(base+`/api/auth/line/callback?code=good-code&state=${state}`,{headers:{Cookie:[stateCookie,session].filter(Boolean).join('; ')}});const raw=r.headers.get('set-cookie');return {status:r.status,html:await r.text(),cookie:cookieOf(raw,'salon_session'),raw};};
  const orderInput=()=>({salonId:'lumiere',items:[{id:'shampoo-moist',price:2860,quantity:1}],customer:{name:'ライン 太郎',postal:'0000000',address:'架空県 1-2-3'},requestKey:crypto.randomUUID()});
  let child;
  try{
    child=await startServer(port,dir,env);
    assert.deepEqual((await call('/auth/line/config')).body,{enabled:true,liffId:'liff-1',orderLiffId:'',notifications:true});
    // 認可URL：state / nonce / コールバックURL / スコープ
    const first=await begin('','?salon=lumiere&staff=haruka');
    assert.equal(first.location.origin,mockBase);assert.equal(first.location.pathname,'/oauth2/v2.1/authorize');
    assert.equal(first.location.searchParams.get('client_id'),'1234');assert.equal(first.location.searchParams.get('redirect_uri'),base+'/api/auth/line/callback');
    assert.equal(first.location.searchParams.get('scope'),'profile openid');assert.ok(first.location.searchParams.get('nonce'));
    assert.equal(first.stateCookie,'salon_line_state='+first.state);
    // 不正な state、または開始したブラウザの Cookie がない場合はセッションを作らない（ログインCSRF対策）
    const wrong=await finish('wrong-state',first.stateCookie);assert.equal(wrong.status,200);assert.ok(wrong.html.includes('line=error&amp;reason=expired'));assert.equal(wrong.cookie,'');
    const foreign=await finish(first.state);assert.ok(foreign.html.includes('reason=expired'));assert.equal(foreign.cookie,'');
    // 正常：Cookie 付与、QRの店舗・スタッフ付きでストアへ戻る、簡略登録、state Cookie は消す
    const ok=await finish(first.state,first.stateCookie);
    assert.ok(ok.html.includes('shop_id=lumiere')&&ok.html.includes('staff=haruka')&&ok.html.includes('line=ok'));assert.match(ok.raw,/salon_session=[0-9a-f]{64}; HttpOnly/);assert.match(ok.raw,/salon_line_state=; [^,]*Max-Age=0/);
    const me=(await call('/auth/me','GET',undefined,ok.cookie)).body.member;
    assert.equal(me.lineId,'U-oauth');assert.equal(me.name,'ライン 太郎');assert.match(me.email,/^line-[0-9a-f]{10}@example\.test$/);assert.equal(me.hash,undefined);
    // state の再利用は拒否、同じLINEユーザーの再ログインは同じ会員
    assert.ok((await finish(first.state,first.stateCookie)).html.includes('reason=expired'));
    const second=await begin();const again=await finish(second.state,second.stateCookie);
    assert.equal((await call('/auth/me','GET',undefined,again.cookie)).body.member.id,me.id);
    assert.equal((await call('/auth/login','POST',{email:me.email,password:'Demo-Member-2026'})).status,400);
    // 連携の乗っ取り防止：攻撃者が開始した連携URLを別のブラウザ（被害者）が完了しても、攻撃者の会員にLINEは連携されない
    const mail=await call('/auth/register','POST',{name:'メール会員',kana:'メール カイイン',salon:'LUMIÈRE',email:'mail@example.test',password:'Demo-Member-2026',agreePrivacy:true});
    assert.equal((await call('/platform/profile','PATCH',{salonId:'lumiere',staffId:''},mail.cookie)).status,200);
    const attackerFlow=await begin(mail.cookie);
    const hijack=await finish(attackerFlow.state,'');
    assert.ok(hijack.html.includes('reason=expired'));assert.equal(hijack.cookie,'');
    assert.equal((await call('/auth/me','GET',undefined,mail.cookie)).body.member.lineId,undefined);
    // 本人のブラウザでの連携：別会員に連携済みのLINEは拒否（理由コードだけを返す）
    const conflict=await finish(attackerFlow.state,attackerFlow.stateCookie,mail.cookie);
    assert.ok(conflict.html.includes('reason=conflict'));assert.ok(!conflict.html.includes('message='));
    assert.equal((await call('/auth/me','GET',undefined,mail.cookie)).body.member.lineId,undefined);
    const linked=await call('/auth/line/liff','POST',{idToken:'idtoken-link'},mail.cookie);
    assert.equal(linked.status,200,JSON.stringify(linked.body));assert.equal(linked.body.member.lineId,'U-link');assert.equal(linked.body.member.id,mail.body.member.id);
    // LIFFログインでセッションは更新される。以後は新しいCookieを使う
    assert.equal((await call('/auth/me','GET',undefined,mail.cookie)).body.member,null);
    assert.equal((await call('/auth/profile','PATCH',{name:'メール会員 改','salon':'LUMIÈRE'},linked.cookie)).body.member.lineId,'U-link');
    // 紐付け後にLINE連携した会員も、管理画面では「連携済み」と表示される
    const admin=await call('/platform/operator/login','POST',{email:'admin@example.test',password:'Demo-Admin-2026'});
    const salonStaff=await call('/platform/operator/login','POST',{email:'salon@example.test',password:'Demo-Admin-2026'});
    assert.equal((await call('/platform/admin/snapshot','GET',undefined,salonStaff.cookie)).body.profiles.find(p=>p.id===mail.body.member.id).lineLinked,true);
    assert.ok((await call('/platform/admin/snapshot','GET',undefined,admin.cookie)).body.customerStats.find(s=>s.salonId==='lumiere').lineLinked>=1);
    // LIFF：不正トークンは拒否、正しいトークンで会員作成
    assert.equal((await call('/auth/line/liff','POST',{idToken:'not-a-token'})).status,502);
    assert.equal((await call('/auth/line/liff','POST',{})).status,400);
    const liff=await call('/auth/line/liff','POST',{idToken:'idtoken-liff'});
    assert.equal(liff.status,200);assert.equal(liff.body.member.lineId,'U-liff');assert.notEqual(liff.body.member.id,me.id);
    assert.equal((await call('/platform/profile','PATCH',{salonId:'lumiere',staffId:'haruka'},liff.cookie)).body.lineLinked,true);
    // 同じLINEユーザーの初回ログインが同時に届いても、1人の会員になる
    const race=await Promise.all([1,2,3].map(()=>call('/auth/line/liff','POST',{idToken:'idtoken-race'})));
    assert.deepEqual(race.map(r=>r.status),[200,200,200],JSON.stringify(race.map(r=>r.body)));assert.equal(new Set(race.map(r=>r.body.member.id)).size,1);
    // 通知：注文受付と出荷。再送や二度押しでは重複して送らない
    const input=orderInput();
    // LINEで簡略登録した会員は、フリガナを登録するまで注文できない（仕様書 2.6.2 フリガナ必須）
    assert.equal((await call('/platform/orders','POST',input,liff.cookie)).status,409);
    assert.equal((await call('/auth/profile','PATCH',{name:'LINE会員',kana:'ライン カイイン',salon:'LUMIÈRE'},liff.cookie)).status,200);
    const order=await call('/platform/orders','POST',input,liff.cookie);
    assert.equal(order.status,200);
    await until(()=>pushes.length>=1);
    assert.equal(pushes[0].auth,'Bearer bot-token');assert.equal(pushes[0].body.to,'U-liff');assert.ok(pushes[0].body.messages[0].text.includes(order.body.id));
    assert.equal((await call('/platform/orders','POST',input,liff.cookie)).body.id,order.body.id);
    const po=(await call('/platform/admin/snapshot','GET',undefined,admin.cookie)).body.purchaseOrders.find(p=>p.orderId===order.body.id);
    await call('/platform/admin/purchase-orders/'+po.id,'PATCH',{status:'accepted'},admin.cookie);
    assert.equal((await call('/platform/admin/purchase-orders/'+po.id,'PATCH',{status:'shipped',carrier:'デモ配送',tracking:'LINE-123'},admin.cookie)).status,200);
    await until(()=>pushes.length>=2);
    assert.equal(pushes[1].body.to,'U-liff');assert.ok(pushes[1].body.messages[0].text.includes('LINE-123'));
    assert.equal((await call('/platform/admin/purchase-orders/'+po.id,'PATCH',{status:'shipped',carrier:'デモ配送',tracking:'LINE-123'},admin.cookie)).status,200);
    // 未連携会員の注文は通知しない
    const plain=await call('/auth/register','POST',{name:'未連携',kana:'ミレンケイ',salon:'LUMIÈRE',email:'plain@example.test',password:'Demo-Member-2026',agreePrivacy:true});
    await call('/platform/profile','PATCH',{salonId:'lumiere',staffId:''},plain.cookie);
    assert.equal((await call('/platform/orders','POST',orderInput(),plain.cookie)).status,200);
    await new Promise(resolve=>setTimeout(resolve,300));assert.equal(pushes.length,2,JSON.stringify(pushes.map(p=>p.body.messages[0].text)));
    // 再起動後も LINE ID による会員特定が保たれる
    await stopServer(child);child=await startServer(port,dir,env);
    assert.equal((await call('/auth/line/liff','POST',{idToken:'idtoken-liff'})).body.member.id,liff.body.member.id);
    assert.equal((await call('/auth/me','GET',undefined,ok.cookie)).body.member.id,me.id);
  }finally{await stopServer(child);mock.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'salon-line-test-'));await rm(dir,{recursive:true,force:true});}
});

test('pending LINE login states stay bounded when the start URL is spammed',()=>{
  const line=createLineAuth({},{enabled:true,channelId:'1',channelSecret:'s',authBase:'https://access.line.me',callbackUrl:'https://shop.example.test/api/auth/line/callback',scope:'profile openid',publicOrigin:'https://shop.example.test'});
  for(let i=0;i<6000;i++)line.start(new URLSearchParams(),null);
  assert.ok(line.pendingStates()<=5000);
  assert.match(line.errorRedirect('anything'),/reason=failed/);assert.match(line.errorRedirect('conflict'),/reason=conflict/);
});

test('LINE login stays closed when the channel is not configured',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'salon-line-off-')),port=14824,base=`http://127.0.0.1:${port}`;
  const child=await startServer(port,dir,{LINE_CHANNEL_ID:'',LINE_CHANNEL_SECRET:'',LIFF_ID:'',LINE_MESSAGING_TOKEN:'',PUBLIC_ORIGIN:''});
  try{
    assert.deepEqual(await (await fetch(base+'/api/auth/line/config')).json(),{enabled:false,liffId:'',orderLiffId:'',notifications:false});
    assert.equal((await fetch(base+'/api/auth/line/start',{redirect:'manual'})).status,404);
    const liff=await fetch(base+'/api/auth/line/liff',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{"idToken":"x"}'});
    assert.equal(liff.status,404);
    assert.ok((await (await fetch(base+'/api/auth/line/callback?code=x&state=y')).text()).includes('line=error'));
    assert.match((await fetch(base+'/')).headers.get('content-security-policy'),/script-src 'self';/);
  }finally{await stopServer(child);await rm(dir,{recursive:true,force:true});}
});
