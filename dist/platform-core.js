// Shared business rules for the local server and the browser-only public demo.
import { supplyRequest, supplySnapshot, seedSupply, addFujiiSamples, wholesaleOf, issuerFor, shipperOf, ISSUER, salonAddress, referralSummary, monthBefore, billerInput, agencyPriceOf } from './supply-core.js';
import { paymentInput, paymentLabel, testCharge, cardInput, paymentAfterCancel, ORDER_PLACED_LABEL, MAX_CARDS } from './payment-core.js';
import { validateProfile, profileComplete } from './member-store.js';
import { nameInput, phoneInput, postalInput, addressPartsInput, formatAddress, decodeAddress } from './person.js';
import { productInput, categoryInput, nextSku, priceRowsInput, applyPriceRow, priceInput, ownPrices, dealerPriceCheck, decodeImage, newProductId, newCategoryId, seedCategories, CONCERN_NAMES, MAX_DEMO_IMAGE_BYTES, CATEGORY_IDS, CATALOG_VERSION, legacyImages } from './catalog-core.js';
import { shippingRow, shippingInput, shippingFileName, SHIPPING_COLUMNS, SHIPPABLE, SUPPLY_SHIPPABLE } from './shipping-csv.js';
import { memberRef, actorLabel, customerFor, orderForRole, summarizeCustomers, productFor, hideCosts, withoutAgency } from './privacy.js';
import { viewEntries, shouldRecordView, exportInput, accessLogVisible, accessLogView, accessActions, accessRoles, accessChannels, accessTargets, ACCESS_LOG_LIMIT } from './access-log.js';
export const demoOperators = [
  // 管理会社は藤井企画（運営管理の画面 admin.html）。ディーラーは F.I.Tソリューション（BICMA）だけで、すべての仕入れ・出荷を受け持つ（ディーラーの画面 dealer.html）
  {id:'admin',role:'admin',name:'藤井企画 運営担当',email:'admin@example.test'},
  {id:'salon-a',role:'salon',salonId:'lumiere',name:'LUMIÈRE 店舗担当',email:'salon@example.test'},
  {id:'dealer-a',role:'dealer',dealerId:'bicma',name:'F.I.Tソリューション 出荷担当',email:'dealer@example.test'},
];
export const DEMO_OPERATOR_PASSWORD = 'Demo-Admin-2026';
export const statuses = {ordered:'発注済み',processing:'出荷準備中',partially_shipped:'一部出荷済み',shipped:'出荷済み',delivered:'お届け済み',cancelled:'キャンセル',return_requested:'返品受付',returned:'返品・返金済み'};
export const poStatuses = {pending:'受付待ち',accepted:'出荷準備中',shipped:'出荷済み',delivered:'お届け済み',cancelled:'キャンセル',returned:'返品済み'};
const clone = value => structuredClone(value);
// 以下の検証・計算は、ブラウザ版（このファイルの state）と DB版（db/platform-store.mjs）で共有する。
export function fail(message,status=400){ const error=new Error(message);error.status=status;throw error; }
export const required=(value,max=120)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail('入力内容を確認してください。');return value.trim();};
export const int=(value,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)fail(`${min}〜${max}の整数で入力してください。`);return value;};
export const optional=(value,max)=>{if(value==null)return '';if(typeof value!=='string'||value.trim().length>max)fail(`${max}文字以内で入力してください。`);return value.trim();};
// 店舗マスタ項目（仕様書 2.6.1）。salon ロールは自店舗の基本情報のみ、admin は全項目を編集できる。
export const salonBasicFields=['name','prefecture','city','street','building','phone','hours','holiday','notes','description','area'];
// 管理会社（藤井企画）だけが決める取引の条件：ECの紹介料率（feeRate）・仕入れの紹介料率・仕入れの請求元（加盟店は選ばない）
export function salonTerms(input,current={}){return {feeRate:int(input?.feeRate??current.feeRate??10,0,30),supplyFeeRate:int(input?.supplyFeeRate??current.supplyFeeRate??15,0,30),supplyBiller:billerInput(input?.supplyBiller??current.supplyBiller??'fujii')};}
export function salonInput(input){
  const s={name:required(input?.name,80),prefecture:required(input?.prefecture,10),city:required(input?.city,50),street:required(input?.street,100),building:optional(input?.building,100),phone:required(input?.phone,15),hours:optional(input?.hours,50),holiday:optional(input?.holiday,50),notes:optional(input?.notes,500),description:optional(input?.description,120),area:optional(input?.area,60)};
  if(!/^[0-9-]+$/.test(s.phone))fail('電話番号は半角数字・ハイフンで入力してください。');
  return s;
}
// 担当スタッフの管理（美容室は自店、本部は全店舗）。名前は店舗の中で重ならないように、40文字・30名まで
export const MAX_STAFF=30;
// スタッフごとの担当のお客様の人数（staffId が空なら指名なし）。お客様一人ひとりの情報は含めない
export const staffStatsOf=members=>Object.values(members.reduce((a,m)=>{if(!m.salonId)return a;const k=m.salonId+'\n'+(m.staffId||'');(a[k]||=({salonId:m.salonId,staffId:m.staffId||'',members:0})).members++;return a;},{}));
export const newStaffId=()=>'st-'+crypto.randomUUID().replace(/-/g,'').slice(0,8);
export function staffNameInput(value,staff,exceptId=''){const name=String(value??'').trim();if(!name||name.length>40)fail('スタッフ名を入力し、40文字以内にしてください。');if(staff.some(s=>s.name===name&&s.id!==exceptId))fail('同じ名前のスタッフが登録されています。',409);return name;}
export const staffMoveInput=v=>v===-1||v===1?v:fail('並び順を確認してください。');
export function staffSummary(staff,memberStaffIds){const list=staff.map(s=>({id:s.id,name:s.name,members:memberStaffIds.filter(id=>id===s.id).length}));return {staff:list,unassigned:memberStaffIds.length-list.reduce((n,s)=>n+s.members,0)};}
export const staffRoute=route=>route.match(/^\/admin\/salons\/([^/]+)\/staff(?:\/([^/]+))?$/);
export function staffList(value,existing=[]){
  const names=Array.isArray(value)?value:String(value??'').split(/[\n,、，]/);
  const list=[];for(const raw of names){const name=String(raw).trim();if(!name)continue;if(name.length>40)fail('スタッフ名は40文字以内で入力してください。');if(list.some(s=>s.name===name))continue;list.push(existing.find(s=>s.name===name)||{id:'st-'+crypto.randomUUID().slice(0,6),name});}
  if(list.length>30)fail('スタッフは30名以内で登録してください。');
  return list;
}
// 店舗IDは削除後も再利用しない（印刷済みQRが別店舗を指さないよう、採番済みの最大値を保持する）。
const salonSeqFrom=salons=>Math.max(salons.length,...salons.map(s=>/^S(\d+)$/.exec(s.id)?.[1]).filter(Boolean).map(Number));
function nextSalonId(state){let n=Math.max(state.salonSeq??0,salonSeqFrom(state.salons))+1,id;while(state.salons.some(s=>s.id===(id='S'+String(n).padStart(3,'0'))))n++;state.salonSeq=n;return id;}
export const jst=iso=>new Date(new Date(iso).getTime()+9*3600000).toISOString();
// 販売実績集計（仕様書 2.2.5）：期間（日次・月次・年次・任意）× 店舗別／全店舗で 販売金額（税込・送料除く）・受注件数・顧客数を集計する。
export const salesUnits={day:'日次',month:'月次',year:'年次',range:'任意期間'};
export function salesRange(input,now=new Date().toISOString()){
  const unit=Object.hasOwn(salesUnits,String(input?.unit))?input.unit:'month';
  const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v)))fail('集計期間は YYYY-MM-DD 形式で指定してください。');return v;};
  const to=input?.to?day(input.to):jst(now).slice(0,10);
  const from=input?.from?day(input.from):new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10);
  if(from>to)fail('開始日は終了日以前の日付にしてください。');
  if(Date.parse(to)-Date.parse(from)>366*3*86400000)fail('集計期間は3年以内で指定してください。');
  return {unit,from,to};
}
export function salesReport(state,input,actor,now=new Date().toISOString()){
  const op=requireOperator(actor,['admin','salon']);
  const {unit,from,to}=salesRange(input,now);
  const salons=state.salons.filter(s=>op.role==='admin'||s.id===op.salonId);
  const orders=state.orders.filter(o=>!['cancelled','returned'].includes(o.status)&&salons.some(s=>s.id===o.salonId)&&jst(o.createdAt).slice(0,10)>=from&&jst(o.createdAt).slice(0,10)<=to);
  const bucket=o=>unit==='day'?jst(o.createdAt).slice(0,10):unit==='month'?jst(o.createdAt).slice(0,7):unit==='year'?jst(o.createdAt).slice(0,4):`${from}〜${to}`;
  const summarize=rows=>({sales:rows.reduce((s,o)=>s+o.subtotal,0),orders:rows.length,customers:new Set(rows.map(o=>o.memberId)).size});
  const periods=[...new Set(orders.map(bucket))].sort();
  const rows=periods.map(period=>{const inPeriod=orders.filter(o=>bucket(o)===period);return {period,salons:salons.map(s=>({salonId:s.id,salonName:s.name,...summarize(inPeriod.filter(o=>o.salonId===s.id))})),total:summarize(inPeriod)};});
  return {from,to,unit,unitName:salesUnits[unit],rows,salons:salons.map(s=>({salonId:s.id,salonName:s.name,...summarize(orders.filter(o=>o.salonId===s.id))})),total:summarize(orders)};
}
function log(state,actor,action,reference,now){state.events.unshift({id:crypto.randomUUID(),at:now,actor:actorLabel(actor),action,reference});state.events=state.events.slice(0,400);}
const catalogContext=state=>({categories:state.categories,dealers:state.dealers,concernNames:CONCERN_NAMES});
const categoryList=state=>[...state.categories].sort((a,b)=>a.sortOrder-b.sortOrder||a.id.localeCompare(b.id)).map(c=>({id:c.id,name:c.name,sortOrder:c.sortOrder,productCount:state.products.filter(p=>p.category===c.name).length}));
// 公開デモの商品画像はブラウザ内に保存するため、小さめの画像だけを受け付ける（画面側で縮小してから送る）
const demoImage=dataUrl=>{decodeImage(dataUrl,MAX_DEMO_IMAGE_BYTES);return dataUrl;};
// お客様の個人情報へのアクセス記録（access-log.js）。DB版の data_access_logs と同じ項目を新しい順に持つ。
function recordAccess(state,e,now){state.accessLogs.unshift({id:crypto.randomUUID(),at:now,actorId:e.actorId,actorName:e.actorName,role:e.role,salonId:e.salonId||'',action:e.action,target:e.target,count:e.count,refs:e.refs||'',purpose:e.purpose||'',channel:e.channel||accessChannels.console,ip:String(e.ip||'').slice(0,60)});state.accessLogs=state.accessLogs.slice(0,1000);}
function recordViews(state,op,ip,entries,now){for(const entry of entries){const last=state.accessLogs.find(l=>l.actorId===(op.id||'')&&l.action===accessActions.view&&l.target===entry.target&&l.salonId===entry.salonId);if(shouldRecordView(last,entry,now))recordAccess(state,{actorId:op.id||'',actorName:op.name,role:accessRoles[op.role],salonId:entry.salonId,action:accessActions.view,target:entry.target,count:entry.count,ip},now);}}

// 店舗マスタ（仕様書 2.6.1）：住所・電話番号・営業時間・定休日・備考を保持する。すべて架空。
export const seedSalons=()=>[
  {id:'lumiere',name:'LUMIÈRE 表参道',area:'TOKYO / OMOTESANDO',description:'髪と暮らしに、やさしい余白を。',owner:'ルミエール株式会社（架空）',prefecture:'東京都',city:'渋谷区',street:'神宮前0-0-0',building:'デモビル 2F',phone:'03-0000-0000',hours:'10:00〜20:00',holiday:'毎週火曜日',notes:'',feeRate:10,supplyFeeRate:15,supplyBiller:'fit',enabled:true,staff:[{id:'haruka',name:'HARUKA'},{id:'yui',name:'YUI'}]},
  {id:'atelier',name:'atelier 凪',area:'FUKUOKA / YAKUIN',description:'あなたらしい美しさを、毎日のケアから。',owner:'アトリエ凪（架空）',prefecture:'福岡県',city:'福岡市中央区',street:'薬院0-0-0',building:'',phone:'092-000-0000',hours:'9:30〜19:00',holiday:'毎週月曜日',notes:'',feeRate:10,supplyFeeRate:15,supplyBiller:'fujii',enabled:true,staff:[{id:'mio',name:'MIO'},{id:'ren',name:'REN'}]},
  {id:'mori',name:'mori hair & care',area:'YAMAGUCHI / HAGI',description:'自然体の髪に、ちょうどいいケアを。',owner:'株式会社モリ（架空）',prefecture:'山口県',city:'萩市',street:'椿東0-0-0',building:'',phone:'0838-00-0000',hours:'9:00〜18:00',holiday:'毎週月曜日・第3日曜日',notes:'',feeRate:10,supplyFeeRate:15,supplyBiller:'fujii',enabled:true,staff:[{id:'aoi',name:'AOI'}]},
];
// 保存済みの状態（SQLite / ブラウザ）に、後から追加した項目（お悩みカテゴリ・店舗住所・会員任意項目）を補う。
// 初期の商品：仕入原価（F.I.Tソリューション の仕入れ値）は売価の5割、卸価格は6.5割、仕入先（出荷元）はディーラーの BICMA。
// お客様のEC注文1点あたり：美容室の取り分 35%、紹介料 5%、F.I.Tソリューション の利益 10%（送料は別に F.I.Tソリューション が受け取る）
export const DEMO_COST_RATE=.5,OLD_DEMO_COST_RATE=.6;
const seedProduct=p=>({...p,enabled:true,cost:Math.round(p.price*DEMO_COST_RATE),wholesalePrice:wholesaleOf(p.price),agencyPrice:agencyPriceOf(p.price),dealerId:p.dealerId||'bicma',stock:p.stock});
export function migrate(state,catalog){
  let changed=false;
  for(const p of state.products||[]){const src=catalog.find(c=>c.id===p.id);if(!Array.isArray(p.concerns)){p.concerns=[...(src?.concerns||[])];changed=true;}}
  for(const s of state.salons||[]){if(s.prefecture===undefined){const d=seedSalons().find(x=>x.id===s.id)||{};Object.assign(s,{prefecture:d.prefecture||'',city:d.city||'',street:d.street||'',building:d.building||'',phone:d.phone||'',hours:d.hours||'',holiday:d.holiday||'',notes:d.notes||''});changed=true;}}
  for(const p of state.profiles||[]){for(const k of ['kana','phone','gender','birthday'])if(p[k]===undefined){p[k]='';changed=true;}if(p.lineLinked===undefined){p.lineLinked=false;changed=true;}}
  if(state.salonSeq===undefined&&Array.isArray(state.salons)){state.salonSeq=salonSeqFrom(state.salons);changed=true;}
  if(!state.carts){state.carts={};changed=true;}if(!state.favorites){state.favorites={};changed=true;}
  for(const p of state.products||[])if(p.wholesalePrice===undefined){p.wholesalePrice=wholesaleOf(p.price);changed=true;}
  for(const k of ['supplyOrders','supplySubscriptions','invoices','accessLogs'])if(!Array.isArray(state[k])){state[k]=[];changed=true;}
  // 住所録・登録カード・既定の支払方法・カテゴリ（版5）。以前の注文はテスト決済（カード）として扱う
  for(const k of ['addresses','cards'])if(!state[k]||typeof state[k]!=='object'||Array.isArray(state[k])){state[k]={};changed=true;}
  if(!Array.isArray(state.categories)){state.categories=seedCategories(state.products||[]);changed=true;}
  for(const o of state.orders||[])if(!o.paymentMethod){o.paymentMethod='card';o.paymentStatus=/返金/.test(o.payment||'')?'refunded':'captured';delete o.payment;changed=true;}
  // 以前の注文の明細に卸価格（美容室の取り分の計算に使う）、加盟店の発注に紹介料率を補う
  for(const o of state.orders||[])for(const i of o.items||[])if(i.wholesalePrice===undefined){i.wholesalePrice=(state.products||[]).find(p=>p.id===i.id)?.wholesalePrice??wholesaleOf(i.price);changed=true;}
  for(const o of state.supplyOrders||[])if(o.feeRate===undefined){o.feeRate=(state.salons||[]).find(s=>s.id===o.salonId)?.feeRate??0;changed=true;}
  // ディーラーを BICMA だけにする（以前の SENA・BOTANICA の商品・発注・注文明細は BICMA が出荷する）
  if(Array.isArray(state.dealers)&&(state.dealers.length!==1||state.dealers[0].id!=='bicma')){
    state.dealers=seedDealers();
    for(const p of state.products||[])p.dealerId='bicma';
    for(const p of state.purchaseOrders||[])p.dealerId='bicma';
    for(const o of state.orders||[])for(const i of o.items||[])if(i.dealerId)i.dealerId='bicma';
    changed=true;
  }
  // 品ぞろえの版2：以前のデータに、まだない初期商品と、そのカテゴリを足す（登録済みの商品・価格は変えない）
  // 版3：一覧の短い説明（summary）と、作り直した初期商品の写真（以前の既定の写真のままの商品だけ）
  // 版4：初期商品の短い説明を書き直した。版3は公開から間もなく書き直したため、版3のデータは初期商品の説明を新しいものに替える
  if((state.catalogVersion||1)<CATALOG_VERSION&&Array.isArray(state.products)&&Array.isArray(state.categories)){
    const from=state.catalogVersion||1;
    // 版6：紹介料率を EC と仕入れで分け、仕入れの請求元を加盟店ごとに。以前の既定（5%）のままなら EC 10%・仕入れ 15%。以前の仕入れ・請求書は、いまの請求元で補う
    if(from<6){
      const seeds=seedSalons();
      for(const s of state.salons||[]){if(s.supplyBiller===undefined){s.supplyBiller=seeds.find(x=>x.id===s.id)?.supplyBiller||'fujii';s.supplyFeeRate=15;if(s.feeRate===5)s.feeRate=10;}}
      for(const o of state.supplyOrders||[])if(o.biller===undefined){const s=(state.salons||[]).find(x=>x.id===o.salonId);o.biller=s?.supplyBiller||'fit';o.feeRate=o.biller==='fit'?(s?.supplyFeeRate??15):0;o.agencyTotal=o.biller==='fujii'?o.items.reduce((n,l)=>n+agencyPriceOf((state.products||[]).find(p=>p.id===l.id)?.price??Math.round(l.unitPrice/.65))*l.quantity,0):0;}
      for(const i of state.invoices||[])if(i.biller===undefined)i.biller=(state.supplyOrders||[]).find(o=>o.invoiceId===i.id)?.biller||'fit';
      addFujiiSamples(state,new Date().toISOString());
    }
    // 版5：デモの仕入原価を売価の6割から5割に（F.I.Tソリューション に利益が残るように）。以前の既定のままの商品と、初期サンプルの注文・出荷指示だけ直す
    if(from<5){
      const oldCost=price=>Math.round(price*OLD_DEMO_COST_RATE),newCost=price=>Math.round(price*DEMO_COST_RATE);
      for(const p of state.products)if((catalog||[]).some(c=>c.id===p.id)&&p.cost===oldCost(p.price))p.cost=newCost(p.price);
      for(const o of state.orders||[])if(o.sample){for(const i of o.items)if(i.cost===oldCost(i.price))i.cost=newCost(i.price);for(const po of (state.purchaseOrders||[]).filter(p=>p.orderId===o.id)){for(const i of po.items)if(i.cost===oldCost(i.price))i.cost=newCost(i.price);po.total=po.items.reduce((s,i)=>s+i.cost*i.quantity,0)+(po.shipping||0);}}
    }
    for(const p of state.products){const src=(catalog||[]).find(c=>c.id===p.id);if(p.summary===undefined||(from===3&&src))p.summary=src?.summary||p.summary||'';if(src&&legacyImages(p.id).includes(p.image))p.image=src.image;}
    // 版7：代理店価格（F.I.T が設定する藤井企画への卸値）。まだない商品は売価の55%
    for(const p of state.products)if(p.agencyPrice===undefined)p.agencyPrice=agencyPriceOf(p.price);
    for(const c of catalog||[])if(!state.products.some(p=>p.id===c.id))state.products.push(seedProduct(c));
    for(const name of new Set((catalog||[]).map(c=>c.category)))if(!state.categories.some(x=>x.name===name))state.categories.push({id:CATEGORY_IDS[name]||newCategoryId(),name,sortOrder:state.categories.length});
    state.catalogVersion=CATALOG_VERSION;changed=true;
  }
  return changed;
}

export const seedDealers=()=>[{id:'bicma',name:'F.I.Tソリューション（BICMA）',short:'BICMA',area:'BICMA 物流センター',lead:'通常1〜3営業日'}];
export function createPlatform(catalog,now=new Date().toISOString()){
  const state={version:1,revision:0,catalogVersion:CATALOG_VERSION,products:catalog.map(seedProduct),
    salonSeq:3,salons:seedSalons(),dealers:seedDealers(),profiles:[],carts:{},favorites:{},orders:[],purchaseOrders:[],events:[],accessLogs:[],addresses:{},cards:{}};
  state.categories=seedCategories(state.products);
  // Clearly fictional examples make the management screens useful on first visit.
  for(let i=0;i<8;i++){
    const salon=state.salons[i%3],product=state.products[i%5];
    const member={id:'sample-member-'+i,name:['デモ 花子','デモ 美咲','デモ 葵'][i%3],kana:['デモ ハナコ','デモ ミサキ','デモ アオイ'][i%3],email:`sample-${i}@example.test`};
    const when=new Date(new Date(now).getTime()-i*86400000-3600000).toISOString();
    state.profiles.push({...member,phone:'',gender:'',birthday:'',lineLinked:false,salonId:salon.id,staffId:salon.staff[0].id,createdAt:when});
    const order=placeOrder(state,{salonId:salon.id,items:[{id:product.id,quantity:1,price:product.price}],customer:{name:member.name,postal:'1000001',prefecture:'東京都',city:'サンプル市',street:'1-2-3',phone:'0300000000'},requestKey:crypto.randomUUID()},{member},when);
    order.sample=true;order.createdAt=when;
    if(i>0){state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>{p.status=i<3?'accepted':i<5?'shipped':'delivered';if(i>=3){p.tracking='DEMO-'+String(100000+i);p.carrier='デモ配送';p.shippedAt=when;}});refreshOrder(state,order);}
  }
  seedSupply(state,now);
  return state;
}
function safeProducts(state){return state.products.filter(p=>p.enabled).map(({cost,wholesalePrice,...p})=>clone(p));}
function salonFor(state,id){const salon=state.salons.find(s=>s.id===id);if(!salon)fail('サロンが見つかりません。',404);return salon;}
function quote(state,input){
  const salon=salonFor(state,input?.salonId);if(!salon.enabled)fail('このサロンは現在受注を停止しています。',409);
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>50)fail('商品をカートに追加してください。');
  const seen=new Set();const items=input.items.map(line=>{
    if(seen.has(line.id))fail('同じ商品が重複しています。');seen.add(line.id);
    const p=state.products.find(p=>p.id===line.id&&p.enabled);if(!p)fail('販売していない商品が含まれています。',409);
    int(line.quantity,1,99);if(p.stock<line.quantity)fail(`${p.name}の在庫が不足しています（残り${p.stock}点）。`,409);
    if(p.price!==line.price)fail(`${p.name}の価格が変更されました。カートを更新してください。`,409);
    return {id:p.id,name:p.name,image:p.image,size:p.size,price:p.price,cost:p.cost,wholesalePrice:p.wholesalePrice,quantity:line.quantity,dealerId:p.dealerId};
  });
  const subtotal=items.reduce((s,p)=>s+p.price*p.quantity,0),shipping=shippingFor(subtotal);
  return {items,subtotal,shipping,total:subtotal+shipping};
}
// 送料：注文1件660円、商品合計11,000円以上で無料（税込）。
export const shippingFor=subtotal=>subtotal===0||subtotal>=11000?0:660;
// 税込金額に含まれる消費税額（10%）。インボイスの税額表示に使う。
export const includedTax=(amount,rate=10)=>Math.floor(amount*rate/(100+rate));
// 同じ注文番号の再送を見分けるための注文内容（お届け先・支払方法を含む。カードのトークンは含めない）
export const orderFingerprint=input=>JSON.stringify({salonId:input?.salonId,items:input?.items,customer:input?.customer,addressId:input?.addressId??null,payment:{method:input?.payment?.method||'card',cardId:input?.payment?.cardId||null}});
export function requestKeyOf(input){const key=required(input?.requestKey,80);if(!/^[a-f0-9-]{36}$/i.test(key))fail('注文番号の形式が正しくありません。');return key;}
// お届け先（住所録・注文で共通）。電話番号は配送伝票（出荷指示CSV）に使う
export const MAX_ADDRESSES=10;
// 項目の形式は person.js（お名前は姓・名、郵便番号7桁、都道府県・市区町村・番地・建物名、電話番号は数字だけ）
export function addressInput(input){return {name:nameInput(input?.name,'お届け先のお名前'),postal:postalInput(input?.postal),...addressPartsInput(input),phone:phoneInput(input?.phone,{required:true})};}
// 注文のお届け先：住所録から選んだもの（saved）か、入力したもの。address は表示用につないだ住所
export function orderCustomer(input,member,saved){const a=saved?addressView(saved):addressInput(input?.customer);return {name:a.name,postal:a.postal,prefecture:a.prefecture,city:a.city,street:a.street,building:a.building||'',address:formatAddress(a)||a.address,phone:a.phone,email:member.email};}
export const sortAddresses=list=>[...list].sort((a,b)=>Number(Boolean(b.isDefault))-Number(Boolean(a.isDefault))||String(b.updatedAt).localeCompare(String(a.updatedAt))||String(a.id).localeCompare(String(b.id)));
// 以前の版の住所（1つの文字列）は decodeAddress で読む
export const addressView=a=>{const parts=a.prefecture!==undefined?{prefecture:a.prefecture,city:a.city,street:a.street,building:a.building||'',address:formatAddress(a)}:decodeAddress(a.address);return {id:String(a.id),name:a.name,postal:a.postal,...parts,phone:a.phone||'',isDefault:Boolean(a.isDefault),updatedAt:a.updatedAt};};
// 登録カードの並び：登録した順（同じ時刻なら下4桁の順）。ブラウザ版と DB版で同じ並びにする
export const sortCards=list=>[...list].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.last4).localeCompare(String(b.last4))||String(a.id).localeCompare(String(b.id)));
export const cardView=c=>({id:c.id,brand:c.brand,last4:c.last4,expMonth:Number(c.expMonth),expYear:Number(c.expYear),isDefault:Boolean(c.isDefault)});

export const newOrderId=now=>'SS-'+now.slice(2,10).replaceAll('-','')+'-'+crypto.randomUUID().slice(0,5).toUpperCase();
export const purchaseOrderId=(orderId,index)=>'PO-'+orderId.slice(3)+'-'+(index+1);
// 1件の注文のお届け（発注）を、お届け1・2…の順に並べる（DB版の seq と同じ順）
const orderPos=(state,orderId)=>state.purchaseOrders.filter(p=>p.orderId===orderId).sort((a,b)=>Number(a.id.split('-').pop())-Number(b.id.split('-').pop()));
export const feeOf=(subtotal,feeRate)=>Math.round(subtotal*feeRate/100);
export const PO_TRANSITIONS={pending:'accepted',accepted:'shipped',shipped:'delivered'};
// 注文の履歴に残す言葉（お客様にも見える）。2回以上に分けてお届けする場合は「お届け1/2：」を付ける
export const shipmentLabel=(status,seq,count)=>`${count>1?`お届け${seq}/${count}：`:''}${{accepted:'発送の準備を始めました',shipped:'商品を発送しました',delivered:'お届けしました'}[status]}`;
// 注文の状態は、仕入先別の発注の状態から決まる（キャンセル・返品系は別管理）。
export function orderStatusFrom(poStatusList){const all=s=>poStatusList.every(p=>s.includes(p)),some=s=>poStatusList.some(p=>s.includes(p));return all(['delivered'])?'delivered':all(['shipped','delivered'])?'shipped':some(['shipped','delivered'])?'partially_shipped':some(['accepted'])?'processing':'ordered';}
export function validateTracking(input){const tracking=required(input?.tracking,60);if(!/^[A-Za-z0-9-]+$/.test(tracking))fail('追跡番号は半角英数字・ハイフンで入力してください。');return {tracking,carrier:required(input?.carrier,40)};}
// カート・お気に入りの入力検証（会員ごとにサーバーへ保存する）。
export function cartInput(input,isSellable){const entries=Object.entries(input?.items&&typeof input.items==='object'&&!Array.isArray(input.items)?input.items:{});if(entries.length>50)fail('カートに入れられる商品は50種類までです。');const items={};for(const [id,quantity] of entries){if(!isSellable(id))continue;items[id]=int(quantity,1,99);}return items;}
export function favoritesInput(input,exists){const ids=Array.isArray(input?.ids)?input.ids:[];if(ids.length>200)fail('お気に入りは200件までです。');return [...new Set(ids.filter(id=>typeof id==='string'&&exists(id)))];}
function cleanQuote(value){return {...value,items:value.items.map(({cost,...p})=>p)};}
function currentProfile(state,member){return member&&state.profiles.find(p=>p.id===member.id);}
const addressBook=(state,memberId)=>{state.addresses??={};return state.addresses[memberId]??=[];};
const cardList=(state,memberId)=>{state.cards??={};return state.cards[memberId]??=[];};
function saveCard(state,memberId,card,now,makeDefault=false){const cards=cardList(state,memberId);if(cards.length>=MAX_CARDS)fail(`カードは${MAX_CARDS}枚まで登録できます。`,409);const entry={id:'cd-'+crypto.randomUUID().slice(0,8),provider:'test',token:card.token,brand:card.brand,last4:card.last4,expMonth:card.expMonth,expYear:card.expYear,isDefault:makeDefault||!cards.length,createdAt:now};if(entry.isDefault)cards.forEach(c=>{c.isDefault=false;});cards.push(entry);return entry;}
function placeOrder(state,input,actor,now,effects=[]){
  const member=actor.member;if(!member)fail('会員ログインが必要です。',401);
  const key=requestKeyOf(input),fingerprint=orderFingerprint(input);
  const old=state.orders.find(o=>o.requestKey===key);
  if(old){if(old.memberId!==member.id)fail('この注文は取得できません。',403);if(old.fingerprint!==fingerprint)fail('同じ注文番号で内容を変更できません。カートを確認してください。',409);return old;}
  const profile=currentProfile(state,member);if(!profile||profile.salonId!==input.salonId)fail('マイページでご利用サロンを確認してください。',409);
  // 会員マスタのフリガナは必須（LINEで簡略登録した会員は、注文の前にマイページで登録する）
  if(!profileComplete(member))fail('マイページでお名前（姓・名）とフリガナを登録してから、ご注文ください。',409);
  const book=addressBook(state,member.id),saved=input?.addressId!=null?book.find(a=>a.id===String(input.addressId))||fail('お届け先が見つかりません。',404):null;
  const customer=orderCustomer(input,member,saved),pay=paymentInput(input);
  const q=quote(state,input),salon=salonFor(state,input.salonId),staff=salon.staff.find(s=>s.id===profile.staffId);
  if(pay.saveCard&&cardList(state,member.id).length>=MAX_CARDS)fail(`カードは${MAX_CARDS}枚まで登録できます。`,409);
  const id=newOrderId(now);
  // カード決済：登録済みカード・新しいカード（トークン）・トークンなし（テスト決済）のどれか。承認されなければ注文は作らない
  const card=pay.cardId?cardList(state,member.id).find(c=>c.id===pay.cardId)||fail('登録済みのカードが見つかりません。',404):pay.card;
  testCharge(card?.token||'tok_test_'+crypto.randomUUID().replace(/-/g,'').slice(0,20),q.total);if(pay.saveCard)saveCard(state,member.id,pay.card,now);
  const order={id,requestKey:key,fingerprint,createdAt:now,memberId:member.id,salonId:salon.id,salonName:salon.name,seller:state.dealers[0]?.name||salon.owner,staffId:staff?.id||'',staffName:staff?.name||'指名なし',customer,...q,paymentMethod:'card',paymentStatus:'captured',status:'ordered',feeRate:salon.feeRate,fee:feeOf(q.subtotal,salon.feeRate),timeline:[{at:now,label:ORDER_PLACED_LABEL}]};
  state.orders.unshift(order);
  // お届け先：住所録が空なら今回のお届け先を登録する。「保存する」を選んだ場合も追加する（10件まで）
  if(!saved&&(!book.length||input?.saveAddress===true)&&book.length<MAX_ADDRESSES){if(!book.length||input?.saveAsDefault===true)book.forEach(a=>{a.isDefault=false;});book.push({id:'ad-'+crypto.randomUUID().slice(0,8),name:customer.name,postal:customer.postal,prefecture:customer.prefecture,city:customer.city,street:customer.street,building:customer.building,phone:customer.phone,isDefault:!book.length||input?.saveAsDefault===true,updatedAt:now});}
  const groups=[...new Set(q.items.map(p=>p.dealerId))];
  groups.forEach((dealerId,index)=>{const items=q.items.filter(p=>p.dealerId===dealerId);state.purchaseOrders.unshift({id:purchaseOrderId(id,index),orderId:id,dealerId,salonId:salon.id,createdAt:now,status:'pending',items:clone(items),shipping:index===0?q.shipping:0,total:items.reduce((s,p)=>s+p.cost*p.quantity,0)+(index===0?q.shipping:0),tracking:'',carrier:''});});
  q.items.forEach(line=>{state.products.find(p=>p.id===line.id).stock-=line.quantity;});
  if(state.carts)delete state.carts[member.id];
  log(state,member,'受注・仕入先への自動発注',id,now);effects.push({type:'order_placed',orderId:id,memberId:member.id});return order;
}
function refreshOrder(state,order){
  if(['cancelled','returned','return_requested'].includes(order.status))return;
  const pos=state.purchaseOrders.filter(p=>p.orderId===order.id);
  order.status=orderStatusFrom(pos.map(p=>p.status));
}
// internal：管理画面向け（お届けごとの仕入先を含める）。お客様向けには仕入先を出さない
function customerOrder(state,order,internal=false){
  const {fingerprint,requestKey,fee,feeRate,...safe}=order;
  return {...clone(safe),payment:paymentLabel(order.paymentMethod,order.paymentStatus),items:safe.items.map(({cost,wholesalePrice,...p})=>p),shipments:orderPos(state,order.id).map(p=>({id:p.id,...(internal?{dealerId:p.dealerId,dealerName:state.dealers.find(d=>d.id===p.dealerId)?.name}:{}),status:p.status,carrier:p.carrier,tracking:p.tracking,shippedAt:p.shippedAt,items:p.items.map(({id,name,quantity})=>({id,name,quantity}))}))};
}
export function requireOperator(actor,roles=['admin','salon','dealer']){if(!actor.operator)fail('管理ログインが必要です。',401);if(!roles.includes(actor.operator.role))fail('この操作の権限がありません。',403);return actor.operator;}
export function allowedOrder(actor,order){const op=actor.operator;return op&&(op.role==='admin'||op.role==='salon'&&op.salonId===order.salonId);}
function restore(state,order){if(order.stockRestored)return;order.items.forEach(p=>{state.products.find(item=>item.id===p.id).stock+=p.quantity;});order.stockRestored=true;}
// 注文ごとの精算：お客様の代金（商品代）は F.I.Tソリューション が受け取る。
// proceeds：美容室の取り分（売価−卸価格。F.I.Tソリューション から支払う／仕入れの請求と相殺）、fee：藤井企画への紹介料、dealerNet：F.I.Tソリューション に残る額（参考）
export const shareOf=items=>items.reduce((s,p)=>s+(p.price-(p.wholesalePrice??wholesaleOf(p.price)))*p.quantity,0);
export function settlement(order){const purchase=order.items.reduce((s,p)=>s+p.cost*p.quantity,0),share=shareOf(order.items),voided=['cancelled','returned'].includes(order.status);return {orderId:order.id,salonId:order.salonId,salonName:order.salonName,at:order.createdAt,status:order.status,sales:voided?0:order.subtotal,purchase:voided?0:purchase,fee:voided?0:order.fee,proceeds:voided?0:share,shipping:voided?0:order.shipping,dealerNet:voided?0:order.subtotal-purchase-share-order.fee,refunded:order.paymentStatus==='refunded'?order.total:0,pending:order.status==='return_requested'};}

// effects には、実際に状態が変わったときだけ通知などの副作用の種類を積む（再送・同一状態への更新では積まない）。
export function platformRequest(state,route,method='GET',input,actor={},now=new Date().toISOString(),effects=[]){
  // クローズドサイト（仕様書 2.2.6）：未ログインには商品・価格を返さない。サロン一覧は会員登録時の選択用に返す。
  if(route==='/bootstrap'&&method==='GET'){const products=actor.member||actor.operator?safeProducts(state):[];return {closed:true,products,categories:[...state.categories].sort((a,b)=>a.sortOrder-b.sortOrder).filter(c=>products.some(p=>p.category===c.name)).map(({id,name})=>({id,name})),salons:clone(state.salons.filter(s=>s.enabled)).map(({feeRate,supplyFeeRate,supplyBiller,notes,...s})=>s),dealers:clone(state.dealers),revision:state.revision};}
  if(route==='/profile'&&method==='GET'){const p=currentProfile(state,actor.member);if(!p)return null;const s=state.salons.find(x=>x.id===p.salonId);const address=sortAddresses(addressBook(state,p.id)).find(a=>a.isDefault);return {...clone(p),salonName:s?.name||'',salonEnabled:Boolean(s?.enabled),address:address?addressView(address):null};}
  // 住所管理（仕様書 2.1.3）：お届け先を10件まで登録・編集・削除し、いつものお届け先を選ぶ
  if(route==='/addresses'||route.startsWith('/addresses/')){
    if(!actor.member)fail('会員ログインが必要です。',401);
    const book=addressBook(state,actor.member.id),list=()=>sortAddresses(book).map(addressView);
    if(route==='/addresses'&&method==='GET')return list();
    if(route==='/addresses'&&method==='POST'){if(book.length>=MAX_ADDRESSES)fail(`お届け先は${MAX_ADDRESSES}件まで登録できます。`,409);const isDefault=!book.length||input?.isDefault===true;if(isDefault)book.forEach(a=>{a.isDefault=false;});book.push({id:'ad-'+crypto.randomUUID().slice(0,8),...addressInput(input),isDefault,updatedAt:now});return list();}
    const a=book.find(x=>x.id===route.split('/')[2]);if(!a)fail('お届け先が見つかりません。',404);
    if(method==='PATCH'){const fields=addressInput({...addressView(a),...input});delete a.address;Object.assign(a,fields,{updatedAt:now});if(input?.isDefault===true){book.forEach(x=>{x.isDefault=false;});a.isDefault=true;}return list();}
    if(method==='DELETE'){book.splice(book.indexOf(a),1);if(a.isDefault&&book.length)sortAddresses(book)[0].isDefault=true;return list();}
  }
  // 支払方法管理（仕様書 2.1.3）：登録カード（トークンと下4桁だけ）と、いつものカード
  if(route==='/payment-methods'||route.startsWith('/payment-methods/')){
    if(!actor.member)fail('会員ログインが必要です。',401);
    const id=actor.member.id,cards=cardList(state,id),view=()=>({cards:sortCards(cards).map(cardView)});
    if(route==='/payment-methods'&&method==='GET')return view();
    if(route==='/payment-methods'&&method==='PATCH'){const card=cards.find(c=>c.id===input?.defaultCardId)||fail('カードが見つかりません。',404);cards.forEach(c=>{c.isDefault=c===card;});return view();}
    if(route==='/payment-methods/cards'&&method==='POST'){saveCard(state,id,cardInput(input?.card,new Date(now)),now,input?.makeDefault===true);return view();}
    const del=route.match(/^\/payment-methods\/cards\/([^/]+)$/);
    if(del&&method==='DELETE'){const i=cards.findIndex(c=>c.id===del[1]);if(i<0)fail('カードが見つかりません。',404);const [removed]=cards.splice(i,1);if(removed.isDefault&&cards.length)sortCards(cards)[0].isDefault=true;return view();}
  }
  if(route==='/profile'&&method==='PATCH'){
    if(!actor.member)fail('会員ログインが必要です。',401);const salon=salonFor(state,input?.salonId);
    const m=actor.member,previous=currentProfile(state,m);
    // 担当店舗は初回の紐付け（サロンのQRコード）で決まり、以後の変更は本部の「担当店舗の紐付け変更」で行う（仕様書 2.2.4）。
    // 担当スタッフはお客様は選ばない。サロンが管理画面の「会員管理」で設定する（/admin/members/:id/staff）。
    if(previous&&previous.salonId!==salon.id)fail('担当サロンの変更は、ご利用のサロンまたは運営本部にご依頼ください。',403);
    if(!previous&&!salon.enabled)fail('このサロンは現在ご利用いただけません。');
    if(input?.staffId&&input.staffId!==(previous?.staffId||''))fail('担当スタッフは、ご利用のサロンで設定します。',403);
    const profile={id:m.id,name:m.name,email:m.email,kana:m.kana||'',phone:m.phone||'',gender:m.gender||'',birthday:m.birthday||'',lineLinked:Boolean(m.lineId),salonId:salon.id,staffId:previous?.staffId||'',createdAt:previous?.createdAt||now};
    state.profiles=state.profiles.filter(p=>p.id!==profile.id);state.profiles.push(profile);log(state,actor.member,'会員サロン情報を保存',memberRef(profile.id),now);return clone(profile);
  }
  if(route==='/cart'||route==='/favorites'){
    if(!actor.member)fail('会員ログインが必要です。',401);
    const sellable=id=>state.products.some(p=>p.id===id&&p.enabled),key=actor.member.id;
    if(route==='/cart'&&method==='GET')return {items:Object.fromEntries(Object.entries(state.carts?.[key]||{}).filter(([id])=>sellable(id)))};
    if(route==='/cart'&&method==='PUT'){state.carts??={};const items=cartInput(input,sellable);if(Object.keys(items).length)state.carts[key]=items;else delete state.carts[key];return {items:clone(items)};}
    if(route==='/favorites'&&method==='GET')return {ids:(state.favorites?.[key]||[]).filter(id=>state.products.some(p=>p.id===id))};
    if(route==='/favorites'&&method==='PUT'){state.favorites??={};const ids=favoritesInput(input,id=>state.products.some(p=>p.id===id));state.favorites[key]=ids;return {ids:[...ids]};}
  }
  if(route==='/quote'&&method==='POST'){if(!actor.member)fail('会員ログインが必要です。',401);return cleanQuote(quote(state,input));}
  if(route==='/admin/sales'&&method==='POST')return salesReport(state,input,actor,now);
  if(route==='/orders'&&method==='POST')return customerOrder(state,placeOrder(state,input,actor,now,effects));
  if(route==='/orders'&&method==='GET'){if(!actor.member)fail('会員ログインが必要です。',401);return state.orders.filter(o=>o.memberId===actor.member.id).map(o=>customerOrder(state,o));}
  const customerAction=route.match(/^\/orders\/([^/]+)\/(cancel|return)$/);
  if(customerAction&&method==='POST'){
    const order=state.orders.find(o=>o.id===customerAction[1]);if(!order)fail('注文が見つかりません。',404);
    // お客様本人のほかは、ディーラー（F.I.Tソリューション）だけがキャンセルできる。返品の申請はお客様本人だけ
    const own=order.memberId===actor.member?.id,dealerOwns=actor.operator?.role==='dealer'&&state.purchaseOrders.some(p=>p.orderId===order.id&&p.dealerId===actor.operator.dealerId);
    if(!own&&!(dealerOwns&&customerAction[2]==='cancel'))fail('この注文を操作できません。',403);
    const action=customerAction[2];
    if(action==='cancel'){
      if(order.status==='cancelled')return customerOrder(state,order);
      if(!['ordered','processing'].includes(order.status))fail('出荷後はキャンセルできません。返品をご利用ください。',409);
      const refund=order.paymentStatus==='captured';order.status='cancelled';order.paymentStatus=paymentAfterCancel(order.paymentStatus);restore(state,order);state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>p.status='cancelled');order.timeline.push({at:now,label:refund?'注文キャンセル・テスト返金完了':'注文キャンセル（お支払いは発生していません）'});
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
    // 個人情報を渡す場合（美容室・ディーラー）は、渡す前にアクセス記録を残す
    const members=op.role==='salon'?state.profiles.filter(p=>p.salonId===op.salonId):[];
    recordViews(state,op,actor.ip,viewEntries(op,{members:members.map(p=>p.id),orders:orders.map(o=>({salonId:o.salonId,memberId:o.memberId})),shipments:pos.map(p=>({salonId:p.salonId,memberId:state.orders.find(o=>o.id===p.orderId)?.memberId}))}),now);
    return hideCosts(op.role,{operator:clone(op),revision:state.revision,products:clone(state.products.filter(p=>op.role!=='dealer'||p.dealerId===op.dealerId)),salons:clone(state.salons.filter(s=>op.role==='admin'||op.role==='salon'&&s.id===op.salonId||op.role==='dealer'&&pos.some(p=>p.salonId===s.id))),dealers:clone(state.dealers.filter(d=>op.role!=='dealer'||d.id===op.dealerId)),
      // 顧客データ：サロンは自店のお客様の全項目、本部は会員番号と集計値だけ、ディーラーは発送に必要な項目だけ（privacy.js）
      orders:orders.map(o=>orderForRole(op.role,{...customerOrder(state,o,true),fee:o.fee,items:clone(o.items)})),
      purchaseOrders:pos.map(p=>{const o=state.orders.find(o=>o.id===p.orderId);return {...clone(p),salonName:o.salonName,customer:customerFor(op.role,clone(o.customer),o.memberId),orderStatus:o.status,orderTotal:o.total,returnReason:o.returnReason||'',payment:paymentLabel(o.paymentMethod,o.paymentStatus)};}),categories:op.role==='admin'?categoryList(state):[],concernNames:CONCERN_NAMES,
      profiles:clone(members).map(p=>({...p,ref:memberRef(p.id)})),accessLogs:state.accessLogs.filter(row=>accessLogVisible(op,row)).slice(0,ACCESS_LOG_LIMIT).map(row=>accessLogView(op,clone(row))),
      staffStats:op.role==='dealer'?[]:staffStatsOf(state.profiles.filter(p=>op.role==='admin'||p.salonId===op.salonId)),
      customerStats:op.role==='dealer'?[]:summarizeCustomers(state.salons.filter(s=>op.role==='admin'||s.id===op.salonId),state.profiles.map(p=>({salonId:p.salonId,lineLinked:p.lineLinked,joinedMonth:jst(p.createdAt).slice(0,7)})),state.orders,jst(now).slice(0,7)),settlements:orders.map(settlement),
      // 紹介料（F.I.Tソリューション → 藤井企画）と美容室の取り分：管理会社とディーラーに今月・前月の分を渡す
      referrals:op.role==='salon'?null:Object.fromEntries([['current',jst(now).slice(0,7)],['previous',monthBefore(jst(now).slice(0,7))]].map(([k,month])=>[k,referralSummary({month,salons:state.salons,orders:state.orders,supplyOrders:state.supplyOrders||[]})])),events:op.role==='admin'?clone(state.events).sort((a,b)=>b.at.localeCompare(a.at)):[],...supplySnapshot(state,op)});
  }
  const poAction=route.match(/^\/admin\/purchase-orders\/([^/]+)$/);
  if(poAction&&method==='PATCH'){
    // 注文の確認・出荷は、すべてディーラー（F.I.Tソリューション）が行う。管理会社（藤井企画）は状況を見るだけ
    const op=requireOperator(actor,['dealer']),po=state.purchaseOrders.find(p=>p.id===poAction[1]);if(!po)fail('発注が見つかりません。',404);if(op.role==='dealer'&&po.dealerId!==op.dealerId)fail('他社の発注は操作できません。',403);
    const order=state.orders.find(o=>o.id===po.orderId);if(['return_requested','returned','cancelled'].includes(order.status))fail('この注文の出荷状態は変更できません。',409);
    if(input?.status===po.status)return clone(po);
    if(PO_TRANSITIONS[po.status]!==input?.status)fail('受付 → 出荷 → 配達完了の順に操作してください。',409);
    if(input.status==='shipped'){const {tracking,carrier}=validateTracking(input);po.tracking=tracking;po.carrier=carrier;po.shippedAt=now;}
    po.status=input.status;if(po.status==='shipped')effects.push({type:'shipped',purchaseOrderId:po.id,orderId:order.id,memberId:order.memberId});refreshOrder(state,order);const pos=orderPos(state,order.id);order.timeline.push({at:now,label:shipmentLabel(po.status,pos.indexOf(po)+1,pos.length)});
    log(state,op,poStatuses[po.status],po.id,now);return clone(po);
  }
  const returnAction=route.match(/^\/admin\/orders\/([^/]+)\/refund$/);
  if(returnAction&&method==='POST'){
    // 返品の検品・返金はディーラー（F.I.Tソリューション）が行う
    const op=requireOperator(actor,['dealer']),order=state.orders.find(o=>o.id===returnAction[1]);if(!order)fail('注文が見つかりません。',404);if(!state.purchaseOrders.some(p=>p.orderId===order.id&&p.dealerId===op.dealerId))fail('他社の注文は操作できません。',403);if(order.status==='returned')return customerOrder(state,order);if(order.status!=='return_requested')fail('返品申請済みの注文を選んでください。',409);
    order.status='returned';order.paymentStatus=paymentAfterCancel(order.paymentStatus);restore(state,order);state.purchaseOrders.filter(p=>p.orderId===order.id).forEach(p=>p.status='returned');order.timeline.push({at:now,label:'返品検品・テスト返金が完了しました'});log(state,op,'返品検品・返金完了',order.id,now);return customerOrder(state,order);
  }
  // 商品登録・編集（仕様書 2.1.1）。藤井企画は仕入単価・代理店価格以外の全項目と画像、F.I.T は在庫数・仕入単価・代理店価格
  // 新しい商品の仕入単価・代理店価格は、F.I.T が設定するまで売価の50%・55%（仮）
  if(route==='/admin/products'&&method==='POST'){
    const op=requireOperator(actor,['admin']);ownPrices('admin',input);const price=Number(input?.price),fields=productInput({...input,cost:Math.round(price*DEMO_COST_RATE),agencyPrice:agencyPriceOf(price)},catalogContext(state)),{sku,seq}=nextSku(state.productSeq,state.products.map(p=>p.sku));state.productSeq=seq;
    const {categoryId,...rest}=fields,p={id:newProductId(),sku,...rest,image:input?.imageData?demoImage(input.imageData):''};
    state.products.push(p);log(state,op,'商品を登録',p.sku,now);return productFor(op.role,clone(p));
  }
  const productAction=route.match(/^\/admin\/products\/([^/]+)$/);
  if(productAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin','dealer']),p=state.products.find(p=>p.id===productAction[1]);if(!p)fail('商品が見つかりません。',404);if(op.role==='dealer'&&p.dealerId!==op.dealerId)fail('他社の商品は操作できません。',403);
    if(op.role==='admin'){
      ownPrices('admin',input);const current={...p,categoryId:state.categories.find(c=>c.name===p.category)?.id};
      const {categoryId,...fields}=productInput({...current,...input},catalogContext(state));
      Object.assign(p,fields);if(input?.imageData)p.image=demoImage(input.imageData);
    }else{if(['price','enabled','wholesalePrice','sku','name','brand','categoryId','concerns','size','summary','description','tag','dealerId','imageData'].some(k=>input?.[k]!==undefined))fail('ディーラーが変えられるのは在庫数・仕入単価・代理店価格です。',403);
      const next=priceInput({...p,...(input?.cost!==undefined?{cost:input.cost}:{}),...(input?.agencyPrice!==undefined?{agencyPrice:input.agencyPrice}:{})});dealerPriceCheck(next);p.cost=next.cost;p.agencyPrice=next.agencyPrice;if(input?.stock!==undefined)p.stock=int(input.stock,0,99999);}
    log(state,op,'商品・在庫を更新',p.sku,now);return productFor(op.role,clone(p));
  }
  // 価格の一括更新（管理画面の価格一括編集）。すべての行を確かめてから保存する
  if(route==='/admin/product-prices'&&method==='PATCH'){
    // 藤井企画は売価・卸価格、F.I.T は仕入単価・代理店価格
    const op=requireOperator(actor,['admin','dealer']),updates=priceRowsInput(input,op.role).map(r=>{const p=state.products.find(x=>x.id===r.id)||fail('商品が見つかりません。画面を読み込み直してください。',404);if(op.role==='dealer'&&p.dealerId!==op.dealerId)fail('他社の商品は操作できません。',403);return [p,applyPriceRow(r,p,op.role)];});
    let updated=0;for(const [p,u] of updates){if(!u.changed.length)continue;for(const k of u.changed)p[k]=u[k];log(state,op,`価格を一括更新（${u.summary}）`,p.sku,now);updated++;}
    return {updated};
  }
  // カテゴリ管理（仕様書 2.1.1）。商品が登録されているカテゴリは削除できない
  if(route==='/admin/categories'&&method==='POST'){const op=requireOperator(actor,['admin']),{name}=categoryInput(input);if(state.categories.some(c=>c.name===name))fail('同じ名前のカテゴリがあります。',409);state.categories.push({id:newCategoryId(),name,sortOrder:Math.max(-1,...state.categories.map(c=>c.sortOrder))+1});log(state,op,'カテゴリを登録',name,now);return categoryList(state);}
  const categoryAction=route.match(/^\/admin\/categories\/([^/]+)$/);
  if(categoryAction){
    const op=requireOperator(actor,['admin']),c=state.categories.find(x=>x.id===categoryAction[1]);if(!c)fail('カテゴリが見つかりません。',404);
    if(method==='PATCH'){
      if(input?.name!==undefined){const {name}=categoryInput(input);if(state.categories.some(x=>x.name===name&&x.id!==c.id))fail('同じ名前のカテゴリがあります。',409);state.products.filter(p=>p.category===c.name).forEach(p=>{p.category=name;});c.name=name;}
      if(input?.sortOrder!==undefined)c.sortOrder=int(input.sortOrder,0,9999);
      log(state,op,'カテゴリを変更',c.name,now);return categoryList(state);
    }
    if(method==='DELETE'){if(state.products.some(p=>p.category===c.name))fail('商品が登録されているカテゴリは削除できません。商品のカテゴリを変えてから削除してください。',409);state.categories=state.categories.filter(x=>x!==c);log(state,op,'カテゴリを削除',c.name,now);return categoryList(state);}
  }
  // 会員情報の編集（仕様書 AD-005）：お客様の情報は担当サロンのものなので、編集できるのは担当サロンだけ。メールアドレス（ログインID）は変えない
  const customerEdit=route.match(/^\/admin\/customers\/([^/]+)$/);
  if(customerEdit&&method==='PATCH'){
    const op=requireOperator(actor,['salon']),p=state.profiles.find(x=>x.id===customerEdit[1]&&x.salonId===op.salonId);if(!p)fail('会員が見つかりません。',404);
    Object.assign(p,validateProfile(input));log(state,op,'会員情報を編集',memberRef(p.id),now);return {...clone(p),ref:memberRef(p.id)};
  }
  // 出荷指示CSV（仕様書 RP-004：佐川急便連携）。ディーラーはEC注文の発注、本部は加盟店発注を出力する
  if(route==='/admin/shipping-csv'&&method==='POST'){
    const {kind,ids}=shippingInput(input),filename=shippingFileName(kind,jst(now).slice(0,10));
    if(kind==='purchaseOrders'){
      const op=requireOperator(actor,['dealer']);
      const rows=ids.map(id=>{const po=state.purchaseOrders.find(p=>p.id===id&&p.dealerId===op.dealerId);if(!po)fail('出力できない発注が含まれています。',403);const order=state.orders.find(o=>o.id===po.orderId);if(!SHIPPABLE.includes(po.status)||['cancelled','returned','return_requested'].includes(order.status))fail('出荷前の発注だけを選んでください。',409);return {po,order,salon:salonFor(state,po.salonId)};});
      // お客様の個人情報を含むので、店舗ごとにアクセス記録を残す
      for(const salonId of [...new Set(rows.map(r=>r.po.salonId))].sort())recordAccess(state,{actorId:op.id||'',actorName:op.name,role:accessRoles.dealer,salonId,action:accessActions.export,target:accessTargets.shippingCsv,count:new Set(rows.filter(r=>r.po.salonId===salonId).map(r=>r.order.memberId)).size,ip:actor.ip},now);
      return {filename,columns:SHIPPING_COLUMNS,rows:rows.map(({po,order,salon})=>shippingRow({reference:po.id,to:order.customer,from:{name:salon.name,postal:'',address:salonAddress(salon),phone:salon.phone},items:po.items,note:`注文 ${order.id}`}))};
    }
    // 加盟店発注：F.I.T は藤井企画が受け持つ発注を除いて、藤井企画は自社で受け付けた発注だけ（ご依頼主は出荷する会社）
    const op=requireOperator(actor,['dealer','admin']),from=op.role==='admin'?issuerFor('fujii'):ISSUER;
    const rows=ids.map(id=>{const o=state.supplyOrders.find(x=>x.id===id);if(!o)fail('発注が見つかりません。',404);if(op.role==='admin'?shipperOf(o)!=='fujii':shipperOf(o)==='fujii')fail('出力できない発注が含まれています。',403);if(!SUPPLY_SHIPPABLE.includes(o.status))fail('出荷前の発注だけを選んでください。',409);return o;});
    return {filename,columns:SHIPPING_COLUMNS,rows:rows.map(o=>{const salon=salonFor(state,o.salonId);return shippingRow({reference:o.id,to:{name:o.shipTo?.name||salon.name,postal:'',address:o.shipTo?.address||salonAddress(salon),phone:salon.phone},from:{name:from.name,postal:'',address:from.address,phone:from.phone},items:o.items,note:'加盟店発注'});})};
  }
  // 店舗登録（仕様書 2.1.1 / AD-002）：店舗IDは自動採番。QRコードは店舗IDから都度生成する。
  if(route==='/admin/salons'&&method==='POST'){
    const op=requireOperator(actor,['admin']);
    // 入力をすべて検証してから店舗IDを採番する（検証エラーで番号を消費しない）
    const fields={...salonInput(input),owner:required(input?.owner,100),...salonTerms(input),enabled:input?.enabled!==false,staff:staffList(input?.staff)};
    const salon={id:nextSalonId(state),...fields};
    state.salons.push(salon);log(state,op,'店舗を登録',salon.id,now);return clone(salon);
  }
  // 担当スタッフの追加・名前の変更・並び替え・削除。削除するスタッフの担当のお客様は transferTo のスタッフ（空なら指名なし）へ引き継ぐ。
  // 過去の注文には注文時の担当者名が残る
  const staffAction=staffRoute(route);
  if(staffAction&&['GET','POST','PATCH','DELETE'].includes(method)){
    const op=requireOperator(actor,['admin','salon']),salon=salonFor(state,staffAction[1]);
    if(op.role==='salon'&&op.salonId!==salon.id)fail('他店舗のスタッフは編集できません。',403);
    // 一覧：スタッフごとの担当のお客様の人数だけを返す（お客様の情報は含めない）。いないスタッフを指していた会員は指名なしに数える
    if(method==='GET'){if(staffAction[2])fail('この操作は利用できません。',404);return staffSummary(salon.staff,state.profiles.filter(p=>p.salonId===salon.id).map(p=>p.staffId||''));}
    if(method==='POST'){if(staffAction[2])fail('この操作は利用できません。',404);if(salon.staff.length>=MAX_STAFF)fail(`スタッフは${MAX_STAFF}名まで登録できます。`,409);const s={id:newStaffId(),name:staffNameInput(input?.name,salon.staff)};salon.staff.push(s);log(state,op,`スタッフを追加（${s.name}）`,salon.id,now);return clone(salon.staff);}
    const s=salon.staff.find(x=>x.id===staffAction[2]);if(!s)fail('スタッフが見つかりません。',404);
    if(method==='PATCH'){
      if(input?.name!==undefined){const name=staffNameInput(input.name,salon.staff,s.id);if(name!==s.name){log(state,op,`スタッフ名を変更（${s.name}→${name}）`,salon.id,now);s.name=name;}}
      if(input?.move!==undefined){const i=salon.staff.indexOf(s),j=i+staffMoveInput(input.move);if(j>=0&&j<salon.staff.length){[salon.staff[i],salon.staff[j]]=[salon.staff[j],salon.staff[i]];log(state,op,'スタッフの並び順を変更',salon.id,now);}}
      return clone(salon.staff);
    }
    const to=input?.transferTo?salon.staff.find(x=>x.id===input.transferTo&&x.id!==s.id):null;if(input?.transferTo&&!to)fail('引き継ぎ先のスタッフを確認してください。');
    const moved=state.profiles.filter(p=>p.salonId===salon.id&&p.staffId===s.id);moved.forEach(p=>{p.staffId=to?.id||'';});
    salon.staff=salon.staff.filter(x=>x!==s);log(state,op,`スタッフを削除（${s.name}・担当${moved.length}人は${to?to.name:'指名なし'}へ）`,salon.id,now);return clone(salon.staff);
  }
  const salonAction=route.match(/^\/admin\/salons\/([^/]+)$/);
  if(salonAction&&method==='PATCH'){
    const op=requireOperator(actor,['admin','salon']),salon=salonFor(state,salonAction[1]);
    if(op.role==='salon'&&op.salonId!==salon.id)fail('他店舗の情報は編集できません。',403);
    const update=salonInput({...salon,...input});
    if(op.role==='admin'){update.owner=required(input?.owner??salon.owner,100);Object.assign(update,salonTerms(input,salon));if(input?.enabled!==undefined&&typeof input.enabled!=='boolean')fail('受付設定を確認してください。');update.enabled=input?.enabled??salon.enabled;if(input?.staff!==undefined)update.staff=staffList(input.staff,salon.staff);}
    else if(['owner','feeRate','supplyFeeRate','supplyBiller','enabled','staff'].some(k=>input?.[k]!==undefined))fail('サロン担当者は紹介料率・仕入れの請求元・受付設定・販売事業者名を変更できません。',403);
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
    const op=requireOperator(actor,['admin']),key=decodeURIComponent(memberAction[1]).trim().toUpperCase(),matches=state.profiles.filter(p=>p.id===memberAction[1]||memberRef(p.id)===key);if(matches.length!==1)fail('会員番号に該当する会員が見つかりません。',404);const profile=matches[0];
    const salon=salonFor(state,input?.salonId);if(!salon.enabled&&salon.id!==profile.salonId)fail('受付を停止しているサロンには紐付けできません。',409);if(input?.staffId&&!salon.staff.some(s=>s.id===input.staffId))fail('担当スタッフを確認してください。');
    profile.salonId=salon.id;profile.staffId=input?.staffId||'';log(state,op,'会員の担当店舗を変更',memberRef(profile.id),now);return {ref:memberRef(profile.id),salonId:profile.salonId,staffId:profile.staffId};
  }
  // 担当スタッフの設定：お客様は選ばず、サロンが自店の会員に設定する（本部も設定できる）
  const memberStaff=route.match(/^\/admin\/members\/([^/]+)\/staff$/);
  if(memberStaff&&method==='PATCH'){
    const op=requireOperator(actor,['admin','salon']),key=decodeURIComponent(memberStaff[1]).trim().toUpperCase(),profile=state.profiles.find(p=>p.id===memberStaff[1]||memberRef(p.id)===key);
    if(!profile||op.role==='salon'&&profile.salonId!==op.salonId)fail('会員が見つかりません。',404);
    const salon=state.salons.find(s=>s.id===profile.salonId),staffId=String(input?.staffId||'');
    if(staffId&&!salon?.staff.some(s=>s.id===staffId))fail('担当スタッフを確認してください。');
    profile.staffId=staffId;log(state,op,'会員の担当スタッフを設定',memberRef(profile.id),now);
    return {ref:memberRef(profile.id),staffId,staffName:salon?.staff.find(s=>s.id===staffId)?.name||''};
  }
  // CSV出力の記録（美容室が自店のお客様の情報を含む一覧を出力するとき）。出力する行が自店の範囲内か確かめてから記録する。
  if(route==='/admin/exports'&&method==='POST'){
    const op=requireOperator(actor,['salon']),{kind,target,ids}=exportInput(input);if(!ids.length)return {logged:0};
    const inScope=kind==='orders'?id=>state.orders.some(o=>o.id===id&&o.salonId===op.salonId):id=>state.profiles.some(p=>p.id===id&&p.salonId===op.salonId);
    if(!ids.every(inScope))fail('出力する対象を確認してください。',403);
    recordAccess(state,{actorId:op.id||'',actorName:op.name,role:accessRoles.salon,salonId:op.salonId,action:accessActions.export,target,count:ids.length,ip:actor.ip},now);return {logged:1};
  }
  // 加盟店からの仕入発注・定期発注・月次請求（supply-core.js）
  const supply=supplyRequest(state,route,method,input,actor,now,effects);if(supply!==undefined)return actor.operator?.role==='salon'?withoutAgency(supply):supply;
  fail('この操作は利用できません。',404);
}
