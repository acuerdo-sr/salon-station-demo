// 仕様書（Rev01 クリエル システム開発仕様書）との整合に関するテスト：
// クローズドサイト、会員項目、販売実績集計、店舗マスタ、担当店舗紐付け、保存データの移行。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {products,concernCategories} from '../catalog.mjs';
import {createPlatform,platformRequest,demoOperators,salesReport,migrate} from '../dist/platform-core.js';
import {validateMember} from '../dist/member-store.js';
const now='2026-09-15T03:00:00.000Z'; // 12:00 JST
const admin={operator:demoOperators[0]},salon={operator:demoOperators[1]},dealer={operator:demoOperators[2]};
const member={id:'buyer-a',name:'デモ 花子',email:'a@example.test',kana:'デモ ハナコ',phone:'090-0000-0000',gender:'2',birthday:'1990-01-01'};
const customer={name:'デモ 花子',postal:'0000000',prefecture:'東京都',city:'架空市',street:'1-2-3',phone:'0300000000'};
function fixture(){const s=createPlatform(products,now);s.orders=[];s.purchaseOrders=[];s.profiles=[];s.events=[];s.products.forEach(p=>p.stock=products.find(x=>x.id===p.id).stock);platformRequest(s,'/profile','PATCH',{salonId:'lumiere',staffId:'haruka'},{member},now);return s;}
const order=(s,salonId='lumiere',items=[{id:'shampoo-moist',quantity:1,price:2860}],at=now,actor={member})=>platformRequest(s,'/orders','POST',{requestKey:crypto.randomUUID(),salonId,items,customer},actor,at);

test('closed site: guests get no products or quotes, members and operators do',()=>{
  const s=fixture();
  const guest=platformRequest(s,'/bootstrap','GET',undefined,{});
  assert.equal(guest.closed,true);assert.deepEqual(guest.products,[]);assert.ok(guest.salons.length>=3);assert.equal(guest.salons[0].feeRate,undefined);
  assert.throws(()=>platformRequest(s,'/quote','POST',{salonId:'lumiere',items:[{id:'shampoo-moist',quantity:1,price:2860}]},{}),/ログイン/);
  assert.equal(platformRequest(s,'/bootstrap','GET',undefined,{member}).products.length,6);
  assert.equal(platformRequest(s,'/bootstrap','GET',undefined,admin).products.length,6);
  assert.ok(platformRequest(s,'/bootstrap','GET',undefined,{member}).products.every(p=>Array.isArray(p.concerns)&&p.concerns.every(c=>concernCategories.includes(c))));
  assert.deepEqual([...new Set(products.flatMap(p=>p.concerns))].sort(),[...concernCategories].sort());
});

test('member profile carries the spec member fields and validation',()=>{
  const s=fixture();const p=platformRequest(s,'/profile','GET',undefined,{member});
  assert.equal(p.kana,'デモ ハナコ');assert.equal(p.phone,'090-0000-0000');assert.equal(p.gender,'2');assert.equal(p.birthday,'1990-01-01');
  // フリガナは必須（仕様書 2.6.2）。LINEで簡略登録した会員は、注文の前に登録してもらう
  const base={salon:'デモ',name:'デモ 花子',email:'x@example.test'};
  assert.throws(()=>validateMember(base),/フリガナ/);
  assert.deepEqual(validateMember(base,{complete:false}),{...base,kana:'',phone:'',birthday:'',gender:''});
  assert.deepEqual(validateMember({...base,kana:'デモ ハナコ'}),{...base,kana:'デモ ハナコ',phone:'',birthday:'',gender:''});
  assert.throws(()=>validateMember({...base,kana:'デモ',phone:'０９０'}),/フリガナ/);
  assert.throws(()=>validateMember({...base,kana:'デモ ハナコ',phone:'０９０'}),/電話番号/);
  assert.throws(()=>validateMember({...base,kana:'hanako'}),/フリガナ/);
  assert.throws(()=>validateMember({...base,kana:'デモ ハナコ',birthday:'1990-13-45'}),/生年月日/);
  assert.throws(()=>validateMember({...base,kana:'デモ ハナコ',gender:'3'}),/性別/);
  assert.equal(validateMember({...base,kana:'デモ ハナコ',gender:9}).gender,'9');
});

test('sales report aggregates by period and salon, excludes cancelled orders, scopes salon role',()=>{
  const s=fixture();
  const other={id:'buyer-b',name:'別 会員',kana:'ベツ カイイン',email:'b@example.test'};platformRequest(s,'/profile','PATCH',{salonId:'atelier',staffId:''},{member:other},now);
  order(s,'lumiere',[{id:'shampoo-moist',quantity:2,price:2860}],'2026-09-14T15:30:00.000Z'); // 9/15 00:30 JST
  order(s,'lumiere',[{id:'oil-smooth',quantity:1,price:2640}],'2026-09-01T02:00:00.000Z');
  const c=order(s,'lumiere',[{id:'oil-smooth',quantity:1,price:2640}],'2026-09-02T02:00:00.000Z');platformRequest(s,'/orders/'+c.id+'/cancel','POST',{},{member},now);
  order(s,'atelier',[{id:'treatment-repair',quantity:1,price:3520}],'2026-08-20T02:00:00.000Z',{member:other});
  const r=salesReport(s,{unit:'month',from:'2026-08-01',to:'2026-09-30'},admin,now);
  assert.equal(r.total.sales,5720+2640+3520);assert.equal(r.total.orders,3);assert.equal(r.total.customers,2);
  assert.deepEqual(r.rows.map(x=>x.period),['2026-08','2026-09']);
  assert.equal(r.rows[1].salons.find(x=>x.salonId==='lumiere').sales,8360);
  assert.equal(r.salons.find(x=>x.salonId==='atelier').orders,1);
  const daily=salesReport(s,{unit:'day',from:'2026-09-15',to:'2026-09-15'},admin,now);
  assert.equal(daily.total.sales,5720);
  const scoped=salesReport(s,{unit:'range',from:'2026-08-01',to:'2026-09-30'},salon,now);
  assert.deepEqual(scoped.salons.map(x=>x.salonId),['lumiere']);assert.equal(scoped.total.sales,8360);assert.equal(scoped.rows[0].period,'2026-08-01〜2026-09-30');
  assert.throws(()=>salesReport(s,{unit:'day',from:'2026-09-30',to:'2026-09-01'},admin,now),/開始日/);
  assert.throws(()=>salesReport(s,{from:'2026/09/01'},admin,now),/YYYY-MM-DD/);
  assert.throws(()=>salesReport(s,{},dealer,now),/権限/);
  assert.throws(()=>platformRequest(s,'/admin/sales','POST',{},{}),/ログイン/);
  const defaults=platformRequest(s,'/admin/sales','POST',{unit:'constructor'},admin,now);assert.equal(defaults.unit,'month');assert.equal(defaults.to,'2026-09-15');assert.equal(defaults.from,'2026-08-17');
});

test('salon master: admin registers, salon edits own basic info only, delete is guarded',()=>{
  const s=fixture();
  const input={name:'デモ店 新規',owner:'新規株式会社（架空）',prefecture:'山口県',city:'萩市',street:'椿東1-1-1',building:'',phone:'0838-11-1111',hours:'10:00〜19:00',holiday:'水曜日',notes:'テスト',staff:'AKI, RIN',feeRate:6,enabled:true};
  assert.throws(()=>platformRequest(s,'/admin/salons','POST',input,salon),/権限/);
  const created=platformRequest(s,'/admin/salons','POST',input,admin,now);
  assert.equal(created.id,'S004');assert.equal(created.staff.length,2);assert.equal(created.feeRate,6);assert.equal(created.phone,'0838-11-1111');
  assert.throws(()=>platformRequest(s,'/admin/salons','POST',{...input,phone:'０８３８'},admin),/電話番号/);
  assert.throws(()=>platformRequest(s,'/admin/salons','POST',{...input,prefecture:''},admin),/入力内容/);
  assert.ok(platformRequest(s,'/bootstrap','GET',undefined,{member}).salons.some(x=>x.id==='S004'));
  const edited=platformRequest(s,'/admin/salons/lumiere','PATCH',{name:'LUMIÈRE 表参道 本店',phone:'03-1111-1111',hours:'11:00〜21:00'},salon,now);
  assert.equal(edited.name,'LUMIÈRE 表参道 本店');assert.equal(edited.phone,'03-1111-1111');assert.equal(edited.feeRate,5);assert.equal(edited.owner,'ルミエール株式会社（架空）');
  assert.throws(()=>platformRequest(s,'/admin/salons/lumiere','PATCH',{feeRate:0},salon),/変更できません/);
  assert.throws(()=>platformRequest(s,'/admin/salons/atelier','PATCH',{name:'x'},salon),/他店舗/);
  const staffKept=platformRequest(s,'/admin/salons/lumiere','PATCH',{staff:'HARUKA, NEW',feeRate:8,enabled:true},admin,now);
  assert.equal(staffKept.staff.find(x=>x.name==='HARUKA').id,'haruka');assert.equal(staffKept.staff.length,2);assert.equal(staffKept.feeRate,8);
  assert.throws(()=>platformRequest(s,'/admin/salons/lumiere','DELETE',{},admin),/削除できません/);
  assert.throws(()=>platformRequest(s,'/admin/salons/S004','DELETE',{},salon),/権限/);
  assert.deepEqual(platformRequest(s,'/admin/salons/S004','DELETE',{},admin,now),{deleted:'S004'});
  assert.ok(!s.salons.some(x=>x.id==='S004'));
  assert.ok(s.events.some(e=>e.action==='店舗を登録')&&s.events.some(e=>e.action==='店舗を削除'));
});

test('admin re-links a member to another salon and staff',()=>{
  const s=fixture();
  assert.throws(()=>platformRequest(s,'/admin/members/buyer-a','PATCH',{salonId:'atelier'},salon),/権限/);
  assert.throws(()=>platformRequest(s,'/admin/members/nobody','PATCH',{salonId:'atelier'},admin),/見つかりません/);
  assert.throws(()=>platformRequest(s,'/admin/members/buyer-a','PATCH',{salonId:'atelier',staffId:'haruka'},admin),/担当スタッフ/);
  const p=platformRequest(s,'/admin/members/buyer-a','PATCH',{salonId:'atelier',staffId:'mio'},admin,now);
  assert.equal(p.salonId,'atelier');assert.equal(p.staffId,'mio');
  assert.equal(platformRequest(s,'/profile','GET',undefined,{member}).salonId,'atelier');
  const o=order(s,'atelier');assert.equal(o.salonId,'atelier');assert.equal(o.staffName,'MIO');
  assert.throws(()=>order(s,'lumiere'),/ご利用サロン/);
});

test('stored state from the previous version is migrated in place',()=>{
  const s=createPlatform(products,now);
  s.products.forEach(p=>{delete p.concerns;});s.salons.forEach(x=>{for(const k of ['prefecture','city','street','building','phone','hours','holiday','notes'])delete x[k];});s.profiles.forEach(p=>{delete p.kana;});
  assert.equal(migrate(s,products),true);
  assert.deepEqual(s.products[0].concerns,products[0].concerns);assert.equal(s.salons[0].prefecture,'東京都');assert.equal(s.profiles[0].kana,'');
  assert.equal(migrate(s,products),false);
  assert.equal(platformRequest(s,'/admin/salons/lumiere','PATCH',{hours:'10:00〜19:00'},salon,now).hours,'10:00〜19:00');
});
