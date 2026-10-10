// 加盟店（サロン）からフランチャイザーへの仕入発注・定期発注・発注提案・月次請求・店販の取り分。
// 検証・計算はブラウザ版（このファイルの supplyRequest）と DB版（db/platform-store.mjs）で共有する。
import { fail, int, optional, requireOperator, jst, includedTax, shippingFor, feeOf, settlement, shareOf, requestKeyOf, validateTracking } from './platform-core.js?v=534580f1d6';
import { summarizeCustomers } from './privacy.js?v=534580f1d6';

export const supplyStatuses = { ordered: '受付待ち', accepted: '出荷準備中', shipped: '出荷済み', delivered: 'お届け済み', cancelled: 'キャンセル' };
export const SUPPLY_TRANSITIONS = { ordered: 'accepted', accepted: 'shipped', shipped: 'delivered' };
export const supplySources = { manual: '通常', reorder: '再注文', suggestion: '発注提案', subscription: '定期発注' };
export const supplyIntervals = { weekly: '毎週', biweekly: '2週間ごと', monthly: '毎月' };
// 請求書の発行者（架空）。本番ではフランチャイザーの名称・適格請求書発行事業者の登録番号・振込先に置き換える。
// 加盟店（美容室）の仕入れの請求元は、加盟店ごとに管理会社（藤井企画）が決める（加盟店は選ばない）。
// - fit：ディーラーの F.I.Tソリューション（BICMA）が直接取引し、仕入れの紹介料を藤井企画へ支払う
// - fujii：藤井企画が卸す（いまの LINE・メールの注文と同じ取引）。出荷は F.I.T、F.I.T は藤井企画へ卸代金を請求。仕入れの紹介料はかからない
// 登録番号・住所・口座は架空
export const ISSUER = { name: 'F.I.Tソリューション（BICMA）', registrationNumber: 'T0000000000000', address: '山口県萩市椿東0-0-0（架空）', phone: '0838-00-0000', bank: 'デモ銀行 本店 普通 0000000（架空）' };
export const ISSUER_FUJII = { name: '藤井企画', registrationNumber: 'T0000000000001', address: '山口県萩市椿東0-0-1（架空）', phone: '0838-00-0001', bank: 'デモ銀行 本店 普通 0000001（架空）' };
export const BILLERS = { fujii: '藤井企画', fit: 'F.I.Tソリューション' };
export const issuerFor = biller => ({ ...(biller === 'fujii' ? ISSUER_FUJII : ISSUER) });
// 藤井企画が F.I.T から仕入れる値段（推定：売価の55%）。請求元が藤井企画の仕入れで、F.I.T が藤井企画へ請求する卸代金に使う
export const AGENCY_RATE = 0.55;
export const agencyPriceOf = price => Math.round(price * AGENCY_RATE);
// 商品の代理店価格（F.I.T が設定した藤井企画への卸値）。未設定の以前のデータは売価の55%
export const agencyOf = product => product.agencyPrice ?? agencyPriceOf(product.price);
export const billerInput = value => { const v = String(value ?? 'fujii'); if (!BILLERS[v]) fail('仕入れの請求元を選んでください。'); return v; };
// 1か月の請求書は1社から：その月にすでに仕入れがあれば、その請求元のまま（請求元の変更は次の月の仕入れから）
export const supplyBillerFor = (salon, monthOrders) => monthOrders.find(o => o.status !== 'cancelled' && o.biller)?.biller || salon.supplyBiller || 'fit';
// 請求書を締める・入金を記録するのは請求元：F.I.Tソリューション はディーラー、藤井企画は管理会社のアカウント
export const billerOfRole = role => role === 'admin' ? 'fujii' : 'fit';
// 出荷元（shipper）：受け付けた会社が出荷まで受け持つ。''＝まだ受け付けていない、'fit'＝F.I.Tソリューション、'fujii'＝藤井企画。
// 藤井企画が出荷できるのは、請求元が藤井企画の加盟店の発注だけ（藤井企画の在庫から出すので、F.I.T の在庫は戻し、代理店価格の請求もしない）
export const shipperOf = order => order.shipper || (order.status === 'ordered' ? '' : 'fit');
export function shipCheck(op, order) {
  const by = billerOfRole(op.role), now = shipperOf(order);
  if (op.role === 'admin' && order.biller !== 'fujii') fail('藤井企画が出荷できるのは、請求元が藤井企画の加盟店の発注です。', 403);
  if (now && now !== by) fail(`この発注は${BILLERS[now]}が出荷を受け持っています。`, 409);
  return by;
}
// 請求書を見られるのは：加盟店は自店の分、藤井企画はすべて、F.I.Tソリューション は自分が請求元の分（藤井企画が加盟店へ出す請求書は見せない）
export const invoiceVisible = (op, inv) => op.role === 'admin' || (op.role === 'dealer' ? (inv.biller || 'fit') === 'fit' : inv.salonId === op.salonId);
export function invoiceReader(actor, inv) {
  const op = requireOperator(actor, ['admin', 'salon', 'dealer']);
  if (!invoiceVisible(op, inv)) fail(op.role === 'salon' ? '他店舗の請求書は見られません。' : 'この請求書は藤井企画が加盟店へ発行したものです。', 403);
  return op;
}
export const wholesaleOf = price => Math.round(price * 0.65);
export const supplyOrderId = now => 'WO-' + now.slice(2, 10).replaceAll('-', '') + '-' + crypto.randomUUID().slice(0, 5).toUpperCase();
export const subscriptionId = () => 'SUB-' + crypto.randomUUID().slice(0, 8).toUpperCase();
export const invoiceId = (month, salonId) => `INV-${month.replace('-', '')}-${salonId}`;
export const salonAddress = s => [s.prefecture, s.city, s.street, s.building].filter(Boolean).join(' ');
const DAY = 86400000;
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
// 次の発注日。毎月は同じ日付（翌月にない日付は月末）。
export function nextRunOn(day, interval) {
  if (interval === 'weekly') return addDays(day, 7);
  if (interval === 'biweekly') return addDays(day, 14);
  const [y, m, d] = day.split('-').map(Number), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
// 支払期限：対象月の翌月末
export function invoiceDueOn(month) { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10); }

// 発注明細の検証。手動の発注は表示中の卸価格と一致するか確認する（定期発注は実行時の卸価格を使う）。
export function supplyLines(input, products, { checkPrice = true } = {}) {
  if (!Array.isArray(input?.items) || !input.items.length || input.items.length > 50) fail('発注する商品を選んでください。');
  const seen = new Set();
  return input.items.map(line => {
    if (!line || typeof line.id !== 'string' || seen.has(line.id)) fail('同じ商品が重複しています。');
    seen.add(line.id);
    const p = products.find(p => p.id === line.id && p.enabled); if (!p) fail('発注できない商品が含まれています。', 409);
    int(line.quantity, 1, 999); if (p.stock < line.quantity) fail(`${p.name}の在庫が不足しています（残り${p.stock}点）。`, 409);
    if (checkPrice && line.price !== p.wholesalePrice) fail(`${p.name}の卸価格が変更されました。発注内容を確認してください。`, 409);
    return { id: p.id, sku: p.sku, name: p.name, size: p.size, image: p.image, unitPrice: p.wholesalePrice, quantity: line.quantity };
  });
}
export function supplyTotals(lines) {
  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0), shipping = shippingFor(subtotal);
  return { subtotal, shipping, total: subtotal + shipping, taxTotal: includedTax(subtotal + shipping) };
}
// 在庫の表示（欠品の確認）。残り10点以下は「残りわずか」
export const stockState = stock => stock <= 0 ? { code: 'out', label: '欠品中' } : stock <= 10 ? { code: 'low', label: `残りわずか（${stock}点）` } : { code: 'ok', label: '在庫あり' };
// 出荷予定（納期の目安）：平日15時までのご注文は当日出荷、それ以降と土日は次の平日。欠品中は入荷後
export function shipEstimate(stock, nowIso = new Date().toISOString()) {
  if (stock <= 0) return { code: 'wait', label: '入荷後に出荷' };
  const jstNow = new Date(Date.parse(nowIso) + 9 * 3600000), weekday = d => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
  if (weekday(jstNow) && jstNow.getUTCHours() < 15) return { code: 'today', label: '本日出荷' };
  const d = new Date(jstNow); do d.setUTCDate(d.getUTCDate() + 1); while (!weekday(d));
  return { code: 'next', label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${'日月火水木金土'[d.getUTCDay()]}）出荷` };
}
// 加盟店のお気に入り（いつもの商品）。200件まで、登録済みの商品だけ
export function supplyFavoritesInput(input, exists) {
  const ids = Array.isArray(input?.ids) ? input.ids : fail('お気に入りの形式が正しくありません。');
  if (ids.length > 200) fail('お気に入りは200件までです。');
  return [...new Set(ids.filter(id => typeof id === 'string' && exists(id)))];
}
export const supplySource = value => Object.hasOwn(supplySources, String(value)) && value !== 'subscription' ? value : 'manual';
export function subscriptionInput(input, products, today) {
  if (!Object.hasOwn(supplyIntervals, String(input?.interval))) fail('発注の間隔を選んでください。');
  const startOn = input?.startOn;
  if (typeof startOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startOn) || Number.isNaN(Date.parse(startOn))) fail('開始日を YYYY-MM-DD 形式で指定してください。');
  if (startOn < today) fail('開始日は今日以降にしてください。');
  if (!Array.isArray(input?.items) || !input.items.length || input.items.length > 20) fail('定期発注する商品を選んでください。');
  const seen = new Set();
  const items = input.items.map(l => {
    if (!l || typeof l.id !== 'string' || seen.has(l.id)) fail('同じ商品が重複しています。');
    seen.add(l.id);
    if (!products.some(p => p.id === l.id && p.enabled)) fail('発注できない商品が含まれています。', 409);
    return { id: l.id, quantity: int(l.quantity, 1, 999) };
  });
  return { interval: input.interval, startOn, items };
}
// 締められるのは終わった月だけ（月末締め）
export function closableMonth(input, now) {
  const month = input?.month;
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('締める月を YYYY-MM 形式で指定してください。');
  if (month >= jst(now).slice(0, 7)) fail('締め処理は月が終わってから行ってください。', 409);
  return month;
}
// 発注提案：同じ商品を2回以上発注していて、前回から「いつもの間隔」の8割が過ぎたら、前回と同じ数量を提案する。
export function supplySuggestions(history, products, today) {
  const recent = history.filter(h => h.orderedOn >= addDays(today, -180)), byProduct = new Map();
  for (const h of recent) { if (!byProduct.has(h.productId)) byProduct.set(h.productId, []); byProduct.get(h.productId).push(h); }
  const out = [];
  for (const [productId, rows] of byProduct) {
    const p = products.find(p => p.id === productId && p.enabled); if (!p) continue;
    const days = [...new Set(rows.map(r => r.orderedOn))].sort(); if (days.length < 2) continue;
    const average = Math.round(days.slice(1).reduce((s, d, i) => s + daysBetween(days[i], d), 0) / (days.length - 1));
    const last = days[days.length - 1], since = daysBetween(last, today);
    if (average < 1 || since < average * 0.8) continue;
    const quantity = Math.min(rows.filter(r => r.orderedOn === last).reduce((s, r) => s + r.quantity, 0), p.stock);
    if (quantity > 0) out.push({ productId, name: p.name, quantity, wholesalePrice: p.wholesalePrice, stock: p.stock, lastOrderedOn: last, averageDays: average, daysSince: since });
  }
  return out.sort((a, b) => b.daysSince / b.averageDays - a.daysSince / a.averageDays);
}
// 紹介料：F.I.Tソリューション が藤井企画へ支払う。加盟店ごとに「お客様のEC売上 × ECの紹介料率」＋「F.I.T が請求元の仕入れ × 仕入れの紹介料率」（注文時の率）。
// 請求元が藤井企画の仕入れには紹介料はかからず、藤井企画の粗利（卸価格 − 藤井企画の仕入値）になる。F.I.T は藤井企画へ卸代金（agencyTotal）を請求する。
// EC は注文日（日本時間）の月、仕入れは請求の月で数える。キャンセル・返品済みは除く。share は同じ月の美容室の取り分（F.I.Tソリューション → 美容室）
export function referralSummary({ month, salons, orders, supplyOrders }) {
  const rows = salons.map(s => {
    const ec = orders.filter(o => o.salonId === s.id && jst(o.createdAt).slice(0, 7) === month && !['cancelled', 'returned'].includes(o.status));
    const sup = supplyOrders.filter(o => o.salonId === s.id && o.billingMonth === month && o.status !== 'cancelled');
    const viaFit = sup.filter(o => (o.biller || 'fit') === 'fit'), viaFujii = sup.filter(o => o.biller === 'fujii');
    const sum = (list, f) => list.reduce((n, o) => n + f(o), 0);
    const ecSales = sum(ec, o => o.subtotal), ecFee = sum(ec, o => o.fee), share = sum(ec, o => o.share ?? shareOf(o.items));
    const fitSales = sum(viaFit, o => o.subtotal), supplyFee = sum(viaFit, o => feeOf(o.subtotal, o.feeRate ?? s.supplyFeeRate ?? s.feeRate));
    const fujiiSales = sum(viaFujii, o => o.subtotal), agencyTotal = sum(viaFujii, o => o.agencyTotal || 0), fujiiMargin = fujiiSales - agencyTotal;
    return { salonId: s.id, salonName: s.name, biller: s.supplyBiller || 'fit', rate: s.feeRate, supplyRate: s.supplyFeeRate ?? s.feeRate, ecSales, ecOrders: ec.length, share,
      supplySales: fitSales + fujiiSales, supplyOrders: sup.length, fitSales, fujiiSales, ecFee, supplyFee, fee: ecFee + supplyFee, agencyTotal, fujiiMargin, fujiiIncome: ecFee + supplyFee + fujiiMargin };
  }).filter(r => r.ecOrders || r.supplyOrders);
  const total = k => rows.reduce((n, r) => n + r[k], 0);
  return { month, rows, total: Object.fromEntries(['ecSales', 'share', 'supplySales', 'fitSales', 'fujiiSales', 'ecFee', 'supplyFee', 'fee', 'agencyTotal', 'fujiiMargin', 'fujiiIncome'].map(k => [k, total(k)])) };
}
// 請求書の参考情報：同じ月の店販ECでサロンが受け取る見込み額
export const monthBefore = month => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
// 発注画面の「店販EC」：この店舗で売れたEC注文の今月・前月の集計。お客様の名前やIDは含めない（集計値だけ）。
// 売上は注文時の店舗で数える（会員の担当店舗を後から付け替えても、過去の売上は動かない）。キャンセル・返品済みは除く。
// 取り分は精算と同じ「売価 − 卸価格」（F.I.Tソリューション から美容室へ支払う見込み）。
// orders：今月・前月の注文 { month, memberId, subtotal, share }、items：今月の明細 { productId, name, quantity, sales }
export function ecSummary({ month, orders, items, products, members }) {
  const previousMonth = monthBefore(month);
  const totals = m => { const list = orders.filter(o => o.month === m); return { sales: list.reduce((s, o) => s + o.subtotal, 0), orders: list.length, customers: new Set(list.map(o => o.memberId)).size, proceeds: list.reduce((s, o) => s + o.share, 0) }; };
  const current = totals(month), previous = totals(previousMonth), byProduct = new Map();
  for (const i of items) {
    const row = byProduct.get(i.productId) || { productId: i.productId, name: products.find(p => p.id === i.productId)?.name || i.name, quantity: 0, sales: 0 };
    row.quantity += i.quantity; row.sales += i.sales; byProduct.set(i.productId, row);
  }
  const topProducts = [...byProduct.values()].sort((a, b) => b.quantity - a.quantity || b.sales - a.sales || a.productId.localeCompare(b.productId)).slice(0, 3);
  return { month, previousMonth, current, previous, change: previous.sales ? Math.round((current.sales - previous.sales) / previous.sales * 1000) / 10 : null, topProducts, members };
}
export const ecProceedsFor = (orders, salonId, month) => orders.filter(o => o.salonId === salonId && jst(o.createdAt).slice(0, 7) === month).map(settlement).reduce((s, x) => s + x.proceeds, 0);

// ---- ブラウザ版（state を直接扱う）
const clone = value => structuredClone(value);
const supplyView = o => { const { requestKey, ...view } = o; return clone(view); };
const invoiceSummary = i => { const { orderIds, ...summary } = i; return clone(summary); };
function log(state, actor, action, reference, now) { state.events.unshift({ id: crypto.randomUUID(), at: now, actor: actor?.name || '加盟店', action, reference }); state.events = state.events.slice(0, 400); }
function ownSupply(actor, salonId) { const op = requireOperator(actor, ['admin', 'salon']); if (op.role === 'salon' && op.salonId !== salonId) fail('他店舗の発注は操作できません。', 403); return op; }
function placeSupply(state, { key, lines, note = '', source = 'manual', subscriptionId = null }, op, salonId, now, effects) {
  const old = state.supplyOrders.find(o => o.requestKey === key);
  if (old) { if (old.salonId !== salonId) fail('この発注は取得できません。', 403); return old; }
  const salon = state.salons.find(s => s.id === salonId) || fail('サロンが見つかりません。', 404);
  const items = lines(), id = supplyOrderId(now), month = jst(now).slice(0, 7);
  const biller = supplyBillerFor(salon, state.supplyOrders.filter(o => o.salonId === salonId && o.billingMonth === month));
  const agencyTotal = biller === 'fujii' ? items.reduce((s, l) => s + agencyOf(state.products.find(p => p.id === l.id)) * l.quantity, 0) : 0;
  const order = { id, requestKey: key, salonId, salonName: salon.name, operatorId: op.id, operatorName: op.name, source, subscriptionId, status: 'ordered', items: items.map(l => ({ ...l, amount: l.unitPrice * l.quantity })), ...supplyTotals(items), shipTo: { name: salon.name, address: salonAddress(salon) }, note, carrier: '', tracking: '', shippedAt: '', deliveredAt: '', billingMonth: month, invoiceId: '', orderedOn: jst(now).slice(0, 10), createdAt: now, stockRestored: false, biller, feeRate: biller === 'fit' ? (salon.supplyFeeRate ?? salon.feeRate) : 0, agencyTotal, shipper: '' };
  for (const l of items) state.products.find(p => p.id === l.id).stock -= l.quantity;
  state.supplyOrders.unshift(order);
  log(state, op, source === 'subscription' ? '定期発注を作成' : '加盟店発注を受付', id, now);
  effects.push({ type: 'supply_placed', supplyOrderId: id, salonId });
  return order;
}
export function runSubscriptions(state, now, effects = []) {
  const today = jst(now).slice(0, 10), result = { created: [], failed: [] };
  for (const sub of (state.supplySubscriptions || []).filter(s => s.active && s.nextRunOn <= today)) {
    const runOn = sub.nextRunOn;
    try {
      const o = placeSupply(state, { key: `sub-${sub.id}-${runOn}`, lines: () => supplyLines({ items: sub.items }, state.products, { checkPrice: false }), source: 'subscription', subscriptionId: sub.id, note: `定期発注（${supplyIntervals[sub.interval]}）` }, { id: sub.operatorId, name: '定期発注' }, sub.salonId, now, effects);
      sub.lastResult = `${runOn}：${o.id} を作成しました`; result.created.push(o.id);
    } catch (error) { sub.lastResult = `${runOn}：作成できませんでした（${error.message}）`; result.failed.push({ subscriptionId: sub.id, message: error.message }); }
    let next = nextRunOn(runOn, sub.interval); while (next <= today) next = nextRunOn(next, sub.interval);
    sub.nextRunOn = next; sub.lastRunOn = today;
  }
  return result;
}
function invoiceDetail(state, inv) {
  const orders = state.supplyOrders.filter(o => inv.orderIds.includes(o.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { ...invoiceSummary(inv), issuer: issuerFor(inv.biller), orders: orders.map(o => ({ id: o.id, orderedOn: o.orderedOn, items: clone(o.items), subtotal: o.subtotal, shipping: o.shipping, total: o.total })), ecProceeds: ecProceedsFor(state.orders, inv.salonId, inv.month) };
}
export function supplySnapshot(state, op) {
  // 管理会社（藤井企画）は状況の確認、ディーラー（F.I.Tソリューション）は受付・出荷・請求、加盟店は自店の分
  const mine = x => op.role === 'admin' || op.role === 'dealer' || x.salonId === op.salonId;
  return { supplyOrders: (state.supplyOrders || []).filter(mine).slice(0, 1000).map(supplyView), subscriptions: clone((state.supplySubscriptions || []).filter(mine)), invoices: (state.invoices || []).filter(i => invoiceVisible(op, i)).map(invoiceSummary) };
}
export function supplyRequest(state, route, method, input, actor, now, effects) {
  state.supplyOrders ??= []; state.supplySubscriptions ??= []; state.invoices ??= [];
  const today = jst(now).slice(0, 10);
  if (route === '/supply' && method === 'GET') {
    const op = requireOperator(actor, ['salon']), salon = state.salons.find(s => s.id === op.salonId);
    const own = state.supplyOrders.filter(o => o.salonId === op.salonId);
    const history = own.filter(o => o.status !== 'cancelled').flatMap(o => o.items.map(i => ({ productId: i.id, orderedOn: o.orderedOn, quantity: i.quantity })));
    const products = state.products.filter(p => p.enabled).map(({ id, brand, name, category, size, image, sku, price, wholesalePrice, stock, tag, summary }) => ({ id, brand, name, category, size, image, sku, price, wholesalePrice, stock, tag: tag || '', summary: summary || '' }));
    // 店販EC（今月・前月）。お客様の情報は渡さず、集計値だけを渡す
    const month = jst(now).slice(0, 7), monthOf = o => jst(o.createdAt).slice(0, 7);
    const sold = state.orders.filter(o => o.salonId === salon.id && !['cancelled', 'returned'].includes(o.status) && [month, monthBefore(month)].includes(monthOf(o)));
    const stats = summarizeCustomers([salon], state.profiles.map(p => ({ salonId: p.salonId, lineLinked: p.lineLinked, joinedMonth: jst(p.createdAt).slice(0, 7) })), [], month)[0];
    const ec = ecSummary({ month, products, members: { total: stats.members, newThisMonth: stats.newThisMonth, lineLinked: stats.lineLinked },
      orders: sold.map(o => ({ month: monthOf(o), memberId: o.memberId, subtotal: o.subtotal, share: shareOf(o.items) })),
      items: sold.filter(o => monthOf(o) === month).flatMap(o => o.items.map(i => ({ productId: i.id, name: i.name, quantity: i.quantity, sales: i.price * i.quantity }))) });
    return {
      salon: { id: salon.id, name: salon.name, address: salonAddress(salon), feeRate: salon.feeRate, biller: salon.supplyBiller || 'fit', billerName: BILLERS[salon.supplyBiller || 'fit'] },
      products, ec, favorites: (state.supplyFavorites?.[salon.id] || []).filter(id => products.some(p => p.id === id)),
      orders: own.slice(0, 50).map(supplyView), subscriptions: clone(state.supplySubscriptions.filter(s => s.salonId === op.salonId)),
      suggestions: supplySuggestions(history, state.products, today), invoices: state.invoices.filter(i => i.salonId === op.salonId).map(invoiceSummary), issuer: issuerFor(salon.supplyBiller),
    };
  }
  if (route === '/supply/favorites' && method === 'PUT') {
    const op = requireOperator(actor, ['salon']), ids = supplyFavoritesInput(input, id => state.products.some(p => p.id === id && p.enabled));
    state.supplyFavorites ??= {}; state.supplyFavorites[op.salonId] = ids;
    return { ids: [...ids] };
  }
  if (route === '/supply/orders' && method === 'POST') {
    const op = requireOperator(actor, ['salon']), key = requestKeyOf(input);
    return supplyView(placeSupply(state, { key, lines: () => supplyLines(input, state.products), note: optional(input?.note, 200), source: supplySource(input?.source) }, op, op.salonId, now, effects));
  }
  const cancel = route.match(/^\/supply\/orders\/([^/]+)\/cancel$/);
  if (cancel && method === 'POST') {
    const order = state.supplyOrders.find(o => o.id === cancel[1]) || fail('発注が見つかりません。', 404), op = ownSupply(actor, order.salonId);
    if (order.status === 'cancelled') return supplyView(order);
    if (order.status !== 'ordered') fail('本部が受け付けた後はキャンセルできません。本部にご連絡ください。', 409);
    if (order.invoiceId) fail('請求書を発行済みの発注はキャンセルできません。', 409);
    order.status = 'cancelled';
    if (!order.stockRestored) { for (const l of order.items) { const p = state.products.find(p => p.id === l.id); if (p) p.stock += l.quantity; } order.stockRestored = true; }
    log(state, op, '加盟店発注をキャンセル', order.id, now);
    return supplyView(order);
  }
  if (route === '/supply/subscriptions' && method === 'POST') {
    const op = requireOperator(actor, ['salon']), s = subscriptionInput(input, state.products, today);
    const sub = { id: subscriptionId(), salonId: op.salonId, operatorId: op.id, interval: s.interval, items: s.items, nextRunOn: s.startOn, active: true, lastRunOn: '', lastResult: '', createdAt: now };
    state.supplySubscriptions.unshift(sub); log(state, op, '定期発注を登録', sub.id, now);
    return clone(sub);
  }
  const subAction = route.match(/^\/supply\/subscriptions\/([^/]+)$/);
  if (subAction && method === 'PATCH') {
    const sub = state.supplySubscriptions.find(s => s.id === subAction[1]) || fail('定期発注が見つかりません。', 404), op = ownSupply(actor, sub.salonId);
    if (typeof input?.active !== 'boolean') fail('定期発注の状態を確認してください。');
    sub.active = input.active; if (sub.active && sub.nextRunOn < today) sub.nextRunOn = today;
    log(state, op, sub.active ? '定期発注を再開' : '定期発注を停止', sub.id, now);
    return clone(sub);
  }
  const invoice = route.match(/^\/supply\/invoices\/([^/]+)$/);
  if (invoice && method === 'GET') { const inv = state.invoices.find(i => i.id === invoice[1]) || fail('請求書が見つかりません。', 404); invoiceReader(actor, inv); return invoiceDetail(state, inv); }
  const ship = route.match(/^\/admin\/supply-orders\/([^/]+)$/);
  if (ship && method === 'PATCH') {
    const op = requireOperator(actor, ['dealer', 'admin']), order = state.supplyOrders.find(o => o.id === ship[1]) || fail('発注が見つかりません。', 404);
    if (order.status === 'cancelled') fail('キャンセル済みの発注です。', 409);
    const by = shipCheck(op, order);
    if (input?.status === order.status) return supplyView(order);
    if (SUPPLY_TRANSITIONS[order.status] !== input?.status) fail('受付 → 出荷 → 配達完了の順に操作してください。', 409);
    if (input.status === 'accepted') {
      order.shipper = by;
      // 藤井企画の在庫から出荷する：F.I.T の在庫の引き当てを戻し、F.I.T から藤井企画への代理店価格の請求はしない
      if (by === 'fujii') { if (!order.stockRestored) { for (const l of order.items) { const p = state.products.find(p => p.id === l.id); if (p) p.stock += l.quantity; } order.stockRestored = true; } order.agencyTotal = 0; }
    }
    if (input.status === 'shipped') { const { tracking, carrier } = validateTracking(input); Object.assign(order, { tracking, carrier, shippedAt: now }); effects.push({ type: 'supply_shipped', supplyOrderId: order.id, salonId: order.salonId }); }
    if (input.status === 'delivered') order.deliveredAt = now;
    order.status = input.status; log(state, op, `加盟店発注：${supplyStatuses[order.status]}${input.status === 'accepted' ? `（出荷：${BILLERS[by]}）` : ''}`, order.id, now);
    return supplyView(order);
  }
  if (route === '/admin/supply/run' && method === 'POST') { requireOperator(actor, ['admin', 'dealer']); return runSubscriptions(state, now, effects); }
  if (route === '/admin/invoices/close' && method === 'POST') {
    const op = requireOperator(actor, ['dealer', 'admin']), biller = billerOfRole(op.role), month = closableMonth(input, now), created = [];
    for (const salon of state.salons) {
      if (state.invoices.some(i => i.salonId === salon.id && i.month === month)) continue;
      const orders = state.supplyOrders.filter(o => o.salonId === salon.id && o.billingMonth === month && o.status !== 'cancelled' && !o.invoiceId && (o.biller || 'fit') === biller);
      if (!orders.length) continue;
      const total = orders.reduce((s, o) => s + o.total, 0);
      const inv = { id: invoiceId(month, salon.id), salonId: salon.id, salonName: salon.name, billTo: { name: salon.owner, address: salonAddress(salon) }, month, issuedOn: today, dueOn: invoiceDueOn(month), orderIds: orders.map(o => o.id), orderCount: orders.length, subtotal: total, taxTotal: includedTax(total), total, status: 'issued', paidAt: '', createdAt: now, biller };
      orders.forEach(o => { o.invoiceId = inv.id; }); state.invoices.unshift(inv); created.push(invoiceSummary(inv));
    }
    log(state, op, `${month} 分を締めて請求書を発行（${BILLERS[biller]}・${created.length}件）`, month, now);
    return { month, created };
  }
  const paid = route.match(/^\/admin\/invoices\/([^/]+)$/);
  if (paid && method === 'PATCH') {
    const op = requireOperator(actor, ['dealer', 'admin']), inv = state.invoices.find(i => i.id === paid[1]) || fail('請求書が見つかりません。', 404);
    if ((inv.biller || 'fit') !== billerOfRole(op.role)) fail(`この請求書の入金は、請求元の${BILLERS[inv.biller || 'fit']}が記録します。`, 403);
    if (input?.status !== 'paid') fail('入金済みにする操作だけができます。');
    if (inv.status !== 'paid') { inv.status = 'paid'; inv.paidAt = now; log(state, op, '請求書を入金済みに更新', inv.id, now); }
    return invoiceSummary(inv);
  }
  return undefined;
}
// ブラウザ版の初期データ：LUMIÈRE の過去の仕入発注（発注提案が出るように2週間ごと）と定期発注1件
// デモの仕入れ：LUMIÈRE は請求元 F.I.Tソリューション、atelier 凪 は請求元 藤井企画（これまでのお取引）の例。[何日前, 加盟店, 明細, 状態]
const LUMIERE_SAMPLES = [[42, 'lumiere', [['shampoo-moist', 6], ['treatment-repair', 3]], 'delivered'], [35, 'lumiere', [['oil-smooth', 4]], 'delivered'], [28, 'lumiere', [['shampoo-moist', 6]], 'delivered'], [14, 'lumiere', [['shampoo-moist', 6], ['treatment-repair', 3]], 'shipped']];
const FUJII_SAMPLES = [[38, 'atelier', [['treatment-repair', 4], ['oil-smooth', 2]], 'delivered'], [21, 'atelier', [['shampoo-moist', 6]], 'delivered'], [2, 'atelier', [['shampoo-moist', 3], ['oil-smooth', 2]], 'ordered']];
function sampleSupply(state, now, [ago, salonId, lines, status]) {
  const salon = state.salons.find(s => s.id === salonId), op = salonId === 'lumiere' ? { id: 'salon-a', name: 'LUMIÈRE 店舗担当' } : { id: 'salon-' + salonId, name: salon.name + ' 店舗担当' };
  const at = new Date(Date.parse(now) - ago * DAY).toISOString(), items = lines.map(([id, quantity]) => { const p = state.products.find(p => p.id === id); return { id, sku: p.sku, name: p.name, size: p.size, image: p.image, unitPrice: p.wholesalePrice, quantity, amount: p.wholesalePrice * quantity }; });
  return { id: 'WO-' + at.slice(2, 10).replaceAll('-', '') + '-S' + String(ago).padStart(4, '0'), requestKey: `sample-${salonId}-${ago}`, salonId: salon.id, salonName: salon.name, operatorId: op.id, operatorName: op.name, source: 'manual', subscriptionId: null, status, items, ...supplyTotals(items), shipTo: { name: salon.name, address: salonAddress(salon) }, note: '', tracking: ['ordered', 'accepted'].includes(status) ? '' : 'DEMO-W' + ago, carrier: ['ordered', 'accepted'].includes(status) ? '' : 'デモ配送', shippedAt: ['ordered', 'accepted'].includes(status) ? '' : at, shipper: status === 'ordered' ? '' : 'fit', deliveredAt: status === 'delivered' ? at : '', billingMonth: jst(at).slice(0, 7), invoiceId: '', orderedOn: jst(at).slice(0, 10), createdAt: at, stockRestored: false,
      biller: salon.supplyBiller || 'fit', feeRate: (salon.supplyBiller || 'fit') === 'fit' ? salon.supplyFeeRate ?? 15 : 0, agencyTotal: salon.supplyBiller === 'fujii' ? lines.reduce((n, [id, quantity]) => n + agencyOf(state.products.find(p => p.id === id)) * quantity, 0) : 0 };
}
// 以前のデモデータ（LUMIÈRE の仕入れだけ）にも、藤井企画が請求元の仕入れの例を足す（atelier 凪 の仕入れがまだないときだけ）
export function addFujiiSamples(state, now) {
  const salon = (state.salons || []).find(s => s.id === 'atelier'), names = FUJII_SAMPLES.flatMap(r => r[2].map(l => l[0]));
  if (!salon || salon.supplyBiller !== 'fujii' || (state.supplyOrders || []).some(o => o.salonId === 'atelier') || !names.every(id => (state.products || []).some(p => p.id === id))) return false;
  state.supplyOrders = [...FUJII_SAMPLES.map(r => sampleSupply(state, now, r)), ...(state.supplyOrders || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return true;
}
export function seedSupply(state, now) {
  const today = jst(now).slice(0, 10);
  state.supplyOrders = [...LUMIERE_SAMPLES, ...FUJII_SAMPLES].map(r => sampleSupply(state, now, r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); state.supplySubscriptions = []; state.invoices = [];
  state.supplySubscriptions.push({ id: 'SUB-SAMPLE1', salonId: 'lumiere', operatorId: 'salon-a', interval: 'weekly', items: [{ id: 'oil-smooth', quantity: 2 }], nextRunOn: addDays(today, 3), active: true, lastRunOn: '', lastResult: '', createdAt: now });
}
