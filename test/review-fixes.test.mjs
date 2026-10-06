// コードレビュー指摘の修正確認（業務ロジック）：通知の重複防止、店舗IDの再利用防止、担当サロンの付け替え制限、
// 受付停止中サロンの扱い、ログイン試行制限の単位。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {products} from '../catalog.mjs';
import {createPlatform,platformRequest,demoOperators,migrate} from '../dist/platform-core.js';
import {createLimiter,clientIp} from '../rate-limit.mjs';
const now='2026-10-06T03:00:00.000Z';
const admin={operator:demoOperators[0]},dealer={operator:demoOperators[2]};
const member={id:'buyer-a',name:'デモ 花子',kana:'デモ ハナコ',email:'a@example.test'},actor={member};
const customer={name:'デモ 花子',postal:'0000000',prefecture:'東京都',city:'架空市',street:'1-2-3',phone:'0300000000'};
function fixture(){const s=createPlatform(products,now);s.orders=[];s.purchaseOrders=[];s.profiles=[];s.events=[];s.products.forEach(p=>p.stock=products.find(x=>x.id===p.id).stock);platformRequest(s,'/profile','PATCH',{salonId:'lumiere',staffId:'haruka'},actor,now);return s;}
const salonInput={name:'デモ店',owner:'デモ株式会社（架空）',prefecture:'山口県',city:'萩市',street:'椿東1-1-1',phone:'0838-11-1111'};

test('effects are reported only for real changes, never for idempotent replays',()=>{
  const s=fixture(),input={requestKey:crypto.randomUUID(),salonId:'lumiere',items:[{id:'shampoo-moist',quantity:1,price:2860}],customer};
  const first=[];const o=platformRequest(s,'/orders','POST',input,actor,now,first);
  assert.deepEqual(first,[{type:'order_placed',orderId:o.id,memberId:'buyer-a'}]);
  const replay=[];assert.equal(platformRequest(s,'/orders','POST',input,actor,now,replay).id,o.id);assert.deepEqual(replay,[]);
  const po=s.purchaseOrders.find(p=>p.orderId===o.id),update=(status,effects=[])=>{platformRequest(s,'/admin/purchase-orders/'+po.id,'PATCH',{status,carrier:'デモ配送',tracking:'DEMO-1'},dealer,now,effects);return effects;};
  assert.deepEqual(update('accepted'),[]);
  assert.deepEqual(update('shipped'),[{type:'shipped',purchaseOrderId:po.id,orderId:o.id,memberId:'buyer-a'}]);
  assert.deepEqual(update('shipped'),[]);
  assert.deepEqual(update('delivered'),[]);
});

test('salon IDs are never reused after a delete, including after migration',()=>{
  const s=fixture();
  const first=platformRequest(s,'/admin/salons','POST',salonInput,admin,now);assert.equal(first.id,'S004');
  platformRequest(s,'/admin/salons/S004','DELETE',{},admin,now);
  assert.equal(platformRequest(s,'/admin/salons','POST',salonInput,admin,now).id,'S005');
  const legacy=createPlatform(products,now);delete legacy.salonSeq;legacy.salons.push({...legacy.salons[0],id:'S007'});
  assert.equal(migrate(legacy,products),true);assert.equal(legacy.salonSeq,7);
  assert.equal(platformRequest(legacy,'/admin/salons','POST',salonInput,admin,now).id,'S008');
});

test('members keep their salon: only staff can be changed by the member, salon changes go through the admin',()=>{
  const s=fixture();
  assert.throws(()=>platformRequest(s,'/profile','PATCH',{salonId:'atelier',staffId:''},actor,now),/運営本部/);
  assert.equal(platformRequest(s,'/profile','PATCH',{salonId:'lumiere',staffId:'yui'},actor,now).staffId,'yui');
  const p=platformRequest(s,'/profile','GET',undefined,actor,now);
  assert.equal(p.salonName,'LUMIÈRE 表参道');assert.equal(p.salonEnabled,true);
  platformRequest(s,'/admin/members/buyer-a','PATCH',{salonId:'atelier',staffId:'mio'},admin,now);
  assert.equal(platformRequest(s,'/profile','GET',undefined,actor,now).salonId,'atelier');
});

test('paused salons: the member still sees their own salon as paused, and the admin cannot link members to it',()=>{
  const s=fixture();
  platformRequest(s,'/admin/salons/lumiere','PATCH',{enabled:false},admin,now);
  const p=platformRequest(s,'/profile','GET',undefined,actor,now);
  assert.equal(p.salonId,'lumiere');assert.equal(p.salonEnabled,false);
  assert.ok(!platformRequest(s,'/bootstrap','GET',undefined,actor,now).salons.some(x=>x.id==='lumiere'));
  assert.equal(platformRequest(s,'/profile','PATCH',{salonId:'lumiere',staffId:'yui'},actor,now).staffId,'yui');
  const other={member:{id:'buyer-b',name:'別 会員',kana:'ベツ カイイン',email:'b@example.test'}};
  assert.throws(()=>platformRequest(s,'/profile','PATCH',{salonId:'lumiere',staffId:''},other,now),/ご利用いただけません/);
  platformRequest(s,'/profile','PATCH',{salonId:'atelier',staffId:''},other,now);
  assert.throws(()=>platformRequest(s,'/admin/members/buyer-b','PATCH',{salonId:'lumiere'},admin,now),/受付を停止/);
  assert.throws(()=>platformRequest(s,'/orders','POST',{requestKey:crypto.randomUUID(),salonId:'lumiere',items:[{id:'shampoo-moist',quantity:1,price:2860}],customer},actor,now),/停止/);
});

test('login limiter counts per address and e-mail, expires, and stays bounded',()=>{
  let time=0;const limiter=createLimiter({max:3,windowMs:1000,maxEntries:10,now:()=>time});
  for(let i=0;i<3;i++)limiter.fail('1.1.1.1|a');
  assert.equal(limiter.blocked('1.1.1.1|a'),true);assert.equal(limiter.blocked('1.1.1.1|b'),false);assert.equal(limiter.blocked('2.2.2.2|a'),false);
  time=1001;assert.equal(limiter.blocked('1.1.1.1|a'),false);
  for(let i=0;i<50;i++)limiter.fail('ip|'+i);
  assert.ok(limiter.size()<=10);
  const req={headers:{'x-forwarded-for':'203.0.113.9, 10.0.0.1'},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(clientIp(req,false),'127.0.0.1');assert.equal(clientIp(req,true),'203.0.113.9');
});
