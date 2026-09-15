// Shared business rules for the local server and the browser-only public demo.
export const demoOperators = [
  {id:'admin',role:'admin',name:'運営管理者',email:'admin@example.test'},
  {id:'salon-a',role:'salon',salonId:'lumiere',name:'LUMIÈRE 店舗担当',email:'salon@example.test'},
  {id:'dealer-a',role:'dealer',dealerId:'sena',name:'SENA ディーラー担当',email:'dealer@example.test'},
  {id:'dealer-b',role:'dealer',dealerId:'botanica',name:'BOTANICA ディーラー担当',email:'dealer-b@example.test'},
];
export const DEMO_OPERATOR_PASSWORD = 'Demo-Admin-2026';
export const statuses = {ordered:'発注済み',processing:'出荷準備中',partially_shipped:'一部出荷済み',shipped:'出荷済み',delivered:'お届け済み',cancelled:'キャンセル',return_requested:'返品受付',returned:'返品・返金済み'};
export const poStatuses = {pending:'受付待ち',accepted:'出荷準備中',shipped:'出荷済み',delivered:'お届け済み',cancelled:'キャンセル',returned:'返品済み'};
const clone = value => structuredClone(value);
function fail(message,status=400){ const error=new Error(message);error.status=status;throw error; }
const required=(value,max=120)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail('入力内容を確認してください。');return value.trim();};
const int=(value,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)fail(`${min}〜${max}の整数で入力してください。`);return value;};
const optional=(value,max)=>{if(value==null)return '';if(typeof value!=='string'||value.trim().length>max)fail(`${max}文字以内で入力してください。`);return value.trim();};
// 店舗マスタ項目（仕様書 2.6.1）。salon ロールは自店舗の基本情報のみ、admin は全項目を編集できる。
export const salonBasicFields=['name','prefecture','city','street','building','phone','hours','holiday','notes','description','area'];
function salonInput(input){
  const s={name:required(input?.name,80),prefecture:required(input?.prefecture,10),city:required(input?.city,50),street:required(input?.street,100),building:optional(input?.building,100),phone:required(input?.phone,15),hours:optional(input?.hours,50),holiday:optional(input?.holiday,50),notes:optional(input?.notes,500),description:optional(input?.description,120),area:optional(input?.area,60)};
  if(!/^[0-9-]+$/.test(s.phone))fail('電話番号は半角数字・ハイフンで入力してください。');
  return s;
}
function staffList(value,existing=[]){
  const names=Array.isArray(value)?value:String(value??'').split(/[\n,、，]/);
  const list=[];for(const raw of names){const name=String(raw).trim();if(!name)continue;if(name.length>40)fail('スタッフ名は40文字以内で入力してください。');if(list.some(s=>s.name===name))continue;list.push(existing.find(s=>s.name===name)||{id:'st-'+crypto.randomUUID().slice(0,6),name});}
  if(list.length>30)fail('スタッフは30名以内で登録してください。');
  return list;
}
function nextSalonId(state){let n=state.salons.length+1,id;do{id='S'+String(n++).padStart(3,'0');}while(state.salons.some(s=>s.id===id));return id;}
const jst=iso=>new Date(new Date(iso).getTime()+9*3600000).toISOString();
// 販売実績集計（仕様書 2.2.5）：期間（日次・月次・年次・任意）× 店舗別／全店舗で 販売金額（税込・送料除く）・受注件数・顧客数を集計する。
export const salesUnits={day:'日次',month:'月次',year:'年次',range:'任意期間'};
export function salesReport(state,input,actor,now=new Date().toISOString()){
  const op=requireOperator(actor,['admin','salon']);
  const unit=Object.hasOwn(salesUnits,String(input?.unit))?input.unit:'month';
  const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v)))fail('集計期間は YYYY-MM-DD 形式で指定してください。');return v;};
  const to=input?.to?day(input.to):jst(now).slice(0,10);
  const from=input?.from?day(input.from):new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10);
  if(from>to)fail('開始日は終了日以前の日付にしてください。');
  if(Date.parse(to)-Date.parse(from)>366*3*86400000)fail('集計期間は3年以内で指定してください。');
  const salons=state.salons.filter(s=>op.role==='admin'||s.id===op.salonId);
  const orders=state.orders.filter(o=>!['cancelled','returned'].includes(o.status)&&salons.some(s=>s.id===o.salonId)&&jst(o.createdAt).slice(0,10)>=from&&jst(o.createdAt).slice(0,10)<=to);
  const bucket=o=>unit==='day'?jst(o.createdAt).slice(0,10):unit==='month'?jst(o.createdAt).slice(0,7):unit==='year'?jst(o.createdAt).slice(0,4):`${from}〜${to}`;
  const summarize=rows=>({sales:rows.reduce((s,o)=>s+o.subtotal,0),orders:rows.length,customers:new Set(rows.map(o=>o.memberId)).size});
  const periods=[...new Set(orders.map(bucket))].sort();
  const rows=periods.map(period=>{const inPeriod=orders.filter(o=>bucket(o)===period);return {period,salons:salons.map(s=>({salonId:s.id,salonName:s.name,...summarize(inPeriod.filter(o=>o.salonId===s.id))})),total:summarize(inPeriod)};});
  return {from,to,unit,unitName:salesUnits[unit],rows,salons:salons.map(s=>({salonId:s.id,salonName:s.name,...summarize(orders.filter(o=>o.salonId===s.id))})),total:summarize(orders)};
}
function log(state,actor,action,reference,now){state.events.unshift({id:crypto.randomUUID(),at:now,actor:actor?.name||'会員',action,reference});state.events=state.events.slice(0,400);}

// 店舗マスタ（仕様書 2.6.1）：住所・電話番号・営業時間・定休日・備考を保持する。すべて架空。
const seedSalons=()=>[
  {id:'lumiere',name:'LUMIÈRE 表参道',area:'TOKYO / OMOTESANDO',description:'髪と暮らしに、やさしい余白を。',owner:'ルミエール株式会社（架空）',prefecture:'東京都',city:'渋谷区',street:'神宮前0-0-0',building:'デモビル 2F',phone:'03-0000-0000',hours:'10:00〜20:00',holiday:'毎週火曜日',notes:'',feeRate:5,enabled:true,staff:[{id:'haruka',name:'HARUKA'},{id:'yui',name:'YUI'}]},
  {id:'atelier',name:'atelier 凪',area:'FUKUOKA / YAKUIN',description:'あなたらしい美しさを、毎日のケアから。',owner:'アトリエ凪（架空）',prefecture:'福岡県',city:'福岡市中央区',street:'薬院0-0-0',building:'',phone:'092-000-0000',hours:'9:30〜19:00',holiday:'毎週月曜日',notes:'',feeRate:5,enabled:true,staff:[{id:'mio',name:'MIO'},{id:'ren',name:'REN'}]},
  {id:'mori',name:'mori hair & care',area:'YAMAGUCHI / HAGI',description:'自然体の髪に、ちょうどいいケアを。',owner:'株式会社モリ（架空）',prefecture:'山口県',city:'萩市',street:'椿東0-0-0',building:'',phone:'0838-00-0000',hours:'9:00〜18:00',holiday:'毎週月曜日・第3日曜日',notes:'',feeRate:5,enabled:true,staff:[{id:'aoi',name:'AOI'}]},
];
// 保存済みの状態（SQLite / ブラウザ）に、後から追加した項目（お悩みカテゴリ・店舗住所・会員任意項目）を補う。
export function migrate(state,catalog){
  let changed=false;
  for(const p of state.products||[]){const src=catalog.find(c=>c.id===p.id);if(!Array.isArray(p.concerns)){p.concerns=[...(src?.concerns||[])];changed=true;}}
  for(const s of state.salons||[]){if(s.prefecture===undefined){const d=seedSalons().find(x=>x.id===s.id)||{};Object.assign(s,{prefecture:d.prefecture||'',city:d.city||'',street:d.street||'',building:d.building||'',phone:d.phone||'',hours:d.hours||'',holiday:d.holiday||'',notes:d.notes||''});changed=true;}}
  for(const p of state.profiles||[])for(const k of ['kana','phone','gender','birthday'])if(p[k]===undefined){p[k]='';changed=true;}
  return changed;
}

export function createPlatform(catalog,now=new Date().toISOString()){
  const state={version:1,revision:0,products:catalog.map((p,i)=>({...p,enabled:true,cost:Math.round(p.price*.6),dealerId:p.category==='ヘアオイル'?'botanica':'sena',stock:p.stock})),
    salons:seedSalons(),dealers:[{id:'sena',name:'SENA ビューティーサプライ',short:'SENA',area:'東京配送センター',lead:'通常1〜3営業日'},{id:'botanica',name:'BOTANICA ディストリビューション',short:'BOTANICA',area:'福岡配送センター',lead:'通常2〜4営業日'}],profiles:[],orders:[],purchaseOrders:[],events:[]};
  // Clearly fictional examples make the management screens useful on first visit.
  for(let i=0;i<8;i++){
    const salon=state.salons[i%3],product=state.products[i%5];
    const member={id:'sample-member-'+i,name:['デモ 花子','デモ 美咲','デモ 葵'][i%3],email:`sample-${i}@example.test`};
    const when=new Date(new Date(now).getTime()-i*86400000-3600000).toISOString();
    state.profiles.push({...member,salonId:salon.id,staffId:salon.staff[0].id,createdAt:when});
    const order=placeOrder(state,{salonId:salon.id,items:[{id:product.id,quantity:1,price:product.price}],customer:{name:member.name,address:'デモ県サンプル市 1-2-3',postal:'0000000'},requestKey:crypto.randomUUID()},{member},when);
    order.sample=true;order.createdAt=when;
    if(i>0){state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>{p.status=i<3?'accepted':i<5?'shipped':'delivered';if(i>=3){p.tracking='DEMO-'+String(100000+i);p.carrier='デモ配送';p.shippedAt=when;}});refreshOrder(state,order);}
  }
  return state;
}
function safeProducts(state){return state.products.filter(p=>p.enabled).map(({cost,...p})=>clone(p));}
function salonFor(state,id){const salon=state.salons.find(s=>s.id===id);if(!salon)fail('サロンが見つかりません。',404);return salon;}
function quote(state,input){
  const salon=salonFor(state,input?.salonId);if(!salon.enabled)fail('このサロンは現在受注を停止しています。',409);
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>50)fail('商品をカートに追加してください。');
  const seen=new Set();const items=input.items.map(line=>{
    if(seen.has(line.id))fail('同じ商品が重複しています。');seen.add(line.id);
    const p=state.products.find(p=>p.id===line.id&&p.enabled);if(!p)fail('販売していない商品が含まれています。',409);
    int(line.quantity,1,99);if(p.stock<line.quantity)fail(`${p.name}の在庫が不足しています（残り${p.stock}点）。`,409);
    if(p.price!==line.price)fail(`${p.name}の価格が変更されました。カートを更新してください。`,409);
    return {id:p.id,name:p.name,image:p.image,size:p.size,price:p.price,cost:p.cost,quantity:line.quantity,dealerId:p.dealerId};
  });
  const subtotal=items.reduce((s,p)=>s+p.price*p.quantity,0),shipping=subtotal>=11000?0:660;
  return {items,subtotal,shipping,total:subtotal+shipping};
}
function cleanQuote(value){return {...value,items:value.items.map(({cost,...p})=>p)};}
function currentProfile(state,member){return member&&state.profiles.find(p=>p.id===member.id);}
function placeOrder(state,input,actor,now){
  const member=actor.member;if(!member)fail('会員ログインが必要です。',401);
  const key=required(input?.requestKey,80);if(!/^[a-f0-9-]{36}$/i.test(key))fail('注文番号の形式が正しくありません。');
  const fingerprint=JSON.stringify({salonId:input.salonId,items:input.items,customer:input.customer});
  const old=state.orders.find(o=>o.requestKey===key);
  if(old){if(old.memberId!==member.id)fail('この注文は取得できません。',403);if(old.fingerprint!==fingerprint)fail('同じ注文番号で内容を変更できません。カートを確認してください。',409);return old;}
  const profile=currentProfile(state,member);if(!profile||profile.salonId!==input.salonId)fail('マイページでご利用サロンを確認してください。',409);
  const customer={name:required(input.customer?.name,80),address:required(input.customer?.address,250),postal:required(input.customer?.postal,8),email:member.email};
  if(!/^\d{3}-?\d{4}$/.test(customer.postal))fail('郵便番号を7桁で入力してください。');
  const q=quote(state,input),salon=salonFor(state,input.salonId),staff=salon.staff.find(s=>s.id===profile.staffId);
  const id='SS-'+now.slice(2,10).replaceAll('-','')+'-'+crypto.randomUUID().slice(0,5).toUpperCase();
  const order={id,requestKey:key,fingerprint,createdAt:now,memberId:member.id,salonId:salon.id,salonName:salon.name,seller:salon.owner,staffId:staff?.id||'',staffName:staff?.name||'指名なし',customer,...q,status:'ordered',payment:'テスト決済完了',feeRate:salon.feeRate,fee:Math.round(q.subtotal*salon.feeRate/100),timeline:[{at:now,label:'ご注文・テスト決済完了'},{at:now,label:'ディーラーへ自動発注しました'}]};
  state.orders.unshift(order);
  const groups=[...new Set(q.items.map(p=>p.dealerId))];
  groups.forEach((dealerId,index)=>{const items=q.items.filter(p=>p.dealerId===dealerId);state.purchaseOrders.unshift({id:'PO-'+id.slice(3)+'-'+(index+1),orderId:id,dealerId,salonId:salon.id,createdAt:now,status:'pending',items:clone(items),shipping:index===0?q.shipping:0,total:items.reduce((s,p)=>s+p.cost*p.quantity,0)+(index===0?q.shipping:0),tracking:'',carrier:''});});
  q.items.forEach(line=>{state.products.find(p=>p.id===line.id).stock-=line.quantity;});
  log(state,member,'受注・仕入先への自動発注',id,now);return order;
}
function refreshOrder(state,order){
  if(['cancelled','returned','return_requested'].includes(order.status))return;
  const pos=state.purchaseOrders.filter(p=>p.orderId===order.id);
  order.status=pos.every(p=>p.status==='delivered')?'delivered':pos.every(p=>['shipped','delivered'].includes(p.status))?'shipped':pos.some(p=>['shipped','delivered'].includes(p.status))?'partially_shipped':pos.some(p=>p.status==='accepted')?'processing':'ordered';
}
function customerOrder(state,order){
  const {fingerprint,requestKey,fee,feeRate,...safe}=order;
  return {...clone(safe),items:safe.items.map(({cost,...p})=>p),shipments:state.purchaseOrders.filter(p=>p.orderId===order.id).map(p=>({id:p.id,dealerId:p.dealerId,dealerName:state.dealers.find(d=>d.id===p.dealerId)?.name,status:p.status,carrier:p.carrier,tracking:p.tracking,shippedAt:p.shippedAt,items:p.items.map(({id,name,quantity})=>({id,name,quantity}))}))};
}
function requireOperator(actor,roles=['admin','salon','dealer']){if(!actor.operator)fail('管理ログインが必要です。',401);if(!roles.includes(actor.operator.role))fail('この操作の権限がありません。',403);return actor.operator;}
function allowedOrder(actor,order){const op=actor.operator;return op&&(op.role==='admin'||op.role==='salon'&&op.salonId===order.salonId);}
function restore(state,order){if(order.stockRestored)return;order.items.forEach(p=>{state.products.find(item=>item.id===p.id).stock+=p.quantity;});order.stockRestored=true;}
function settlement(order){const purchase=order.items.reduce((s,p)=>s+p.cost*p.quantity,0),voided=['cancelled','returned'].includes(order.status);return {orderId:order.id,salonId:order.salonId,salonName:order.salonName,at:order.createdAt,status:order.status,sales:voided?0:order.subtotal,purchase:voided?0:purchase,fee:voided?0:order.fee,proceeds:voided?0:order.subtotal-purchase-order.fee,refunded:voided?order.total:0,pending:order.status==='return_requested'};}

export function platformRequest(state,route,method='GET',input,actor={},now=new Date().toISOString()){
  // クローズドサイト（仕様書 2.2.6）：未ログインには商品・価格を返さない。サロン一覧は会員登録時の選択用に返す。
  if(route==='/bootstrap'&&method==='GET')return {closed:true,products:actor.member||actor.operator?safeProducts(state):[],salons:clone(state.salons.filter(s=>s.enabled)).map(({feeRate,notes,...s})=>s),dealers:clone(state.dealers),revision:state.revision};
  if(route==='/profile'&&method==='GET')return clone(currentProfile(state,actor.member)||null);
  if(route==='/profile'&&method==='PATCH'){
    if(!actor.member)fail('会員ログインが必要です。',401);const salon=salonFor(state,input?.salonId);if(!salon.enabled)fail('このサロンは現在ご利用いただけません。');
    if(input.staffId&&!salon.staff.some(s=>s.id===input.staffId))fail('担当スタッフを確認してください。');
    const m=actor.member,previous=currentProfile(state,m),profile={id:m.id,name:m.name,email:m.email,kana:m.kana||'',phone:m.phone||'',gender:m.gender||'',birthday:m.birthday||'',salonId:salon.id,staffId:input.staffId||'',createdAt:previous?.createdAt||now};
    state.profiles=state.profiles.filter(p=>p.id!==profile.id);state.profiles.push(profile);log(state,actor.member,'会員サロン情報を保存',profile.id,now);return clone(profile);
  }
  if(route==='/quote'&&method==='POST'){if(!actor.member)fail('会員ログインが必要です。',401);return cleanQuote(quote(state,input));}
  if(route==='/admin/sales'&&method==='POST')return salesReport(state,input,actor,now);
  if(route==='/orders'&&method==='POST')return customerOrder(state,placeOrder(state,input,actor,now));
  if(route==='/orders'&&method==='GET'){if(!actor.member)fail('会員ログインが必要です。',401);return state.orders.filter(o=>o.memberId===actor.member.id).map(o=>customerOrder(state,o));}
  const customerAction=route.match(/^\/orders\/([^/]+)\/(cancel|return)$/);
  if(customerAction&&method==='POST'){
    const order=state.orders.find(o=>o.id===customerAction[1]);if(!order)fail('注文が見つかりません。',404);
    if(order.memberId!==actor.member?.id&&!allowedOrder(actor,order))fail('この注文を操作できません。',403);
    const action=customerAction[2];
    if(action==='cancel'){
      if(order.status==='cancelled')return customerOrder(state,order);
      if(!['ordered','processing'].includes(order.status))fail('出荷後はキャンセルできません。返品をご利用ください。',409);
      order.status='cancelled';order.payment='テスト返金完了';restore(state,order);state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>p.status='cancelled');order.timeline.push({at:now,label:'注文キャンセル・テスト返金完了'});
    }else{
      if(order.status==='return_requested')return customerOrder(state,order);
      if(!['shipped','delivered'].includes(order.status))fail('全商品の出荷後に返品を申請できます。',409);
      order.returnReason=required(input?.reason,300);order.status='return_requested';order.timeline.push({at:now,label:'返品を受け付けました'});
    }
    log(state,order.memberId===actor.member?.id?actor.member:actor.operator,action==='cancel'?'注文をキャンセル':'返品申請',order.id,now);return customerOrder(state,order);
  }
  if(route==='/admin/snapshot'&&method==='GET'){
    const op=requireOperator(actor);
    const pos=state.purchaseOrders.filter(p=>op.role==='admin'||op.role==='dealer'&&p.dealerId===op.dealerId||op.role==='salon'&&p.salonId===op.salonId);
    const orders=state.orders.filter(o=>allowedOrder(actor,o)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    pos.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {operator:clone(op),revision:state.revision,products:clone(state.products.filter(p=>op.role!=='dealer'||p.dealerId===op.dealerId)),salons:clone(state.salons.filter(s=>op.role==='admin'||op.role==='salon'&&s.id===op.salonId||op.role==='dealer'&&pos.some(p=>p.salonId===s.id))),dealers:clone(state.dealers.filter(d=>op.role!=='dealer'||d.id===op.dealerId)),
      orders:orders.map(o=>({...customerOrder(state,o),fee:o.fee,items:clone(o.items)})),
      purchaseOrders:pos.map(p=>{const o=state.orders.find(o=>o.id===p.orderId);return {...clone(p),salonName:o.salonName,customer:clone(o.customer)};}),
      profiles:op.role==='dealer'?[]:clone(state.profiles.filter(p=>op.role==='admin'||p.salonId===op.salonId)),settlements:orders.map(settlement),events:op.role==='admin'?clone(state.events).sort((a,b)=>b.at.localeCompare(a.at)):[]};
  }
  const poAction=route.match(/^\/admin\/purchase-orders\/([^/]+)$/);
  if(poAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin','dealer']),po=state.purchaseOrders.find(p=>p.id===poAction[1]);if(!po)fail('発注が見つかりません。',404);if(op.role==='dealer'&&po.dealerId!==op.dealerId)fail('他社の発注は操作できません。',403);
    const order=state.orders.find(o=>o.id===po.orderId);if(['return_requested','returned','cancelled'].includes(order.status))fail('この注文の出荷状態は変更できません。',409);
    const transitions={pending:'accepted',accepted:'shipped',shipped:'delivered'};
    if(input?.status===po.status)return clone(po);
    if(transitions[po.status]!==input?.status)fail('受付 → 出荷 → 配達完了の順に操作してください。',409);
    if(input.status==='shipped'){const tracking=required(input.tracking,60);if(!/^[A-Za-z0-9-]+$/.test(tracking))fail('追跡番号は半角英数字・ハイフンで入力してください。');const carrier=required(input.carrier,40);po.tracking=tracking;po.carrier=carrier;po.shippedAt=now;}
    po.status=input.status;refreshOrder(state,order);order.timeline.push({at:now,label:`${state.dealers.find(d=>d.id===po.dealerId).short}：${poStatuses[po.status]}`});log(state,op,poStatuses[po.status],po.id,now);return clone(po);
  }
  const returnAction=route.match(/^\/admin\/orders\/([^/]+)\/refund$/);
  if(returnAction&&method==='POST'){
    const op=requireOperator(actor,['admin']),order=state.orders.find(o=>o.id===returnAction[1]);if(!order)fail('注文が見つかりません。',404);if(order.status==='returned')return customerOrder(state,order);if(order.status!=='return_requested')fail('返品申請済みの注文を選んでください。',409);
    order.status='returned';order.payment='テスト返金完了';restore(state,order);state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>p.status='returned');order.timeline.push({at:now,label:'返品検品・テスト返金が完了しました'});log(state,op,'返品検品・返金完了',order.id,now);return customerOrder(state,order);
  }
  const productAction=route.match(/^\/admin\/products\/([^/]+)$/);
  if(productAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin','dealer']),p=state.products.find(p=>p.id===productAction[1]);if(!p)fail('商品が見つかりません。',404);if(op.role==='dealer'&&p.dealerId!==op.dealerId)fail('他社の商品は操作できません。',403);
    const update={stock:int(input?.stock,0,99999)};
    if(op.role==='admin'){update.price=int(input.price,1,1000000);update.cost=int(input.cost,0,1000000);if(update.cost>update.price)fail('このデモでは仕入単価を売価以下に設定してください。');if(typeof input.enabled!=='boolean')fail('公開設定を確認してください。');update.enabled=input.enabled;}
    else if(['price','cost','enabled'].some(k=>input[k]!==undefined))fail('ディーラーは在庫数のみ更新できます。',403);
    Object.assign(p,update);log(state,op,'商品・在庫を更新',p.sku,now);return clone(p);
  }
  // 店舗登録（仕様書 2.1.1 / AD-002）：店舗IDは自動採番。QRコードは店舗IDから都度生成する。
  if(route==='/admin/salons'&&method==='POST'){
    const op=requireOperator(actor,['admin']);
    const salon={id:nextSalonId(state),...salonInput(input),owner:required(input?.owner,100),feeRate:int(input?.feeRate??5,0,30),enabled:input?.enabled!==false,staff:staffList(input?.staff)};
    state.salons.push(salon);log(state,op,'店舗を登録',salon.id,now);return clone(salon);
  }
  const salonAction=route.match(/^\/admin\/salons\/([^/]+)$/);
  if(salonAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin','salon']),salon=salonFor(state,salonAction[1]);
    if(op.role==='salon'&&op.salonId!==salon.id)fail('他店舗の情報は編集できません。',403);
    const update=salonInput({...salon,...input});
    if(op.role==='admin'){update.owner=required(input?.owner??salon.owner,100);update.feeRate=int(input?.feeRate??salon.feeRate,0,30);if(input?.enabled!==undefined&&typeof input.enabled!=='boolean')fail('受付設定を確認してください。');update.enabled=input?.enabled??salon.enabled;if(input?.staff!==undefined)update.staff=staffList(input.staff,salon.staff);}
    else if(['owner','feeRate','enabled','staff'].some(k=>input?.[k]!==undefined))fail('サロン担当者は運用料率・受付設定・販売事業者名を変更できません。',403);
    Object.assign(salon,update);log(state,op,op.role==='admin'?'店舗設定を更新':'サロン情報を編集',salon.id,now);return clone(salon);
  }
  if(salonAction&&method==='DELETE'){
    const op=requireOperator(actor,['admin']),salon=salonFor(state,salonAction[1]);
    if(state.orders.some(o=>o.salonId===salon.id)||state.profiles.some(p=>p.salonId===salon.id))fail('受注または会員が紐付いている店舗は削除できません。「新しい注文を受け付ける」を外して休止してください。',409);
    state.salons=state.salons.filter(s=>s.id!==salon.id);log(state,op,'店舗を削除',salon.id,now);return {deleted:salon.id};
  }
  // 担当店舗紐付けの変更（仕様書 2.2.4 / AD-005）
  const memberAction=route.match(/^\/admin\/members\/([^/]+)$/);
  if(memberAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin']),profile=state.profiles.find(p=>p.id===memberAction[1]);if(!profile)fail('会員が見つかりません。',404);
    const salon=salonFor(state,input?.salonId);if(input?.staffId&&!salon.staff.some(s=>s.id===input.staffId))fail('担当スタッフを確認してください。');
    profile.salonId=salon.id;profile.staffId=input?.staffId||'';log(state,op,'会員の担当店舗を変更',profile.id,now);return clone(profile);
  }
  fail('この操作は利用できません。',404);
}
