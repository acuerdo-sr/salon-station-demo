// 初期データの投入と、旧形式（platform_state の1行JSON・旧 members）からの移行。
// どちらも「ブラウザ版と同じ形の state」をテーブルへ展開する。
import { randomBytes } from 'node:crypto';
import { jst, includedTax } from '../dist/platform-core.js';
import { wholesaleOf, salonAddress } from '../dist/supply-core.js';
import { createFieldCrypto } from './crypto.mjs';
import { seedCategories } from '../dist/catalog-core.js';
import { encodeAddress } from '../dist/person.js';

// お悩みの ID（表示名は日本語、ID は英字で固定）。カテゴリの ID は dist/catalog-core.js の seedCategories
const CONCERN_IDS = { ダメージヘア対策: 'damage', エイジングケア: 'aging', 白髪対策: 'gray-hair', ボリュームアップ: 'volume', 頭皮ケア: 'scalp', カラーケア: 'color', パーマケア: 'perm' };
const slug = (map, name, index, prefix) => map[name] || `${prefix}-${index + 1}`;
const at = (base, offsetMs) => new Date(Date.parse(base) + offsetMs).toISOString();
// パスワードを持たない会員（サンプル・移行時に元データがない会員）は、照合できない乱数を入れておく。
const unusablePassword = () => ({ salt: randomBytes(16).toString('hex'), hash: randomBytes(32).toString('hex') });

// fieldCrypto：会員の個人情報と注文のお届け先は暗号化して入れる（db/crypto.mjs）
export async function importState(tx, state, { catalog, concernNames = [], legacyMembers = [], legacySessions = [], now = new Date().toISOString(), fieldCrypto = createFieldCrypto(null) }) {
  const c = fieldCrypto;
  const products = state.products || [];
  // 仕入先
  for (const d of state.dealers || []) await tx.run('INSERT INTO dealers (id, name, short_name, area, lead_time) VALUES (?, ?, ?, ?, ?)', [d.id, d.name, d.short || d.name, d.area || '', d.lead || '']);
  // カテゴリ・お悩み
  const categories = state.categories?.length ? state.categories : seedCategories(products);
  const categoryId = name => categories.find(c => c.name === name)?.id;
  for (const [i, cat] of categories.entries()) await tx.run('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)', [cat.id, cat.name, cat.sortOrder ?? i]);
  const concerns = [...new Set([...concernNames, ...products.flatMap(p => p.concerns || [])])];
  const concernId = name => slug(CONCERN_IDS, name, concerns.indexOf(name), 'concern');
  for (const [i, name] of concerns.entries()) await tx.run('INSERT INTO concerns (id, name, sort_order) VALUES (?, ?, ?)', [concernId(name), name, i]);
  // 店舗・スタッフ（並び順を保つため作成日時を1ミリ秒ずつずらす）
  const staffIds = new Set();
  for (const [i, s] of (state.salons || []).entries()) {
    const created = at(now, i);
    await tx.run(`INSERT INTO salons (id, name, owner, area, description, prefecture, city, street, building, phone, hours, holiday, notes, fee_rate, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.name, s.owner || s.name, s.area || '', s.description || '', s.prefecture || '', s.city || '', s.street || '', s.building || '', s.phone || '', s.hours || '', s.holiday || '', s.notes || '', s.feeRate ?? 5, s.enabled === false ? 0 : 1, created, created]);
    for (const [j, st] of (s.staff || []).entries()) { await tx.run('INSERT INTO staff (id, salon_id, name, sort_order, active) VALUES (?, ?, ?, ?, 1)', [st.id, s.id, st.name, j]); staffIds.add(st.id); }
  }
  const salonIds = new Set((state.salons || []).map(s => s.id));
  // 商品
  const skuOf = id => products.find(p => p.id === id)?.sku || catalog.find(p => p.id === id)?.sku || id;
  for (const [i, p] of products.entries()) {
    await tx.run(`INSERT INTO products (id, sku, brand, name, category_id, size, description, image, tag, price, cost, wholesale_price, tax_rate, dealer_id, stock, enabled, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?)`,
    [p.id, skuOf(p.id), p.brand || '', p.name, categoryId(p.category), p.size || '', p.description || '', p.image || '', p.tag || '', p.price, p.cost ?? 0, p.wholesalePrice ?? wholesaleOf(p.price), p.dealerId, p.stock, p.enabled === false ? 0 : 1, i, now]);
    for (const c of p.concerns || []) await tx.run('INSERT INTO product_concerns (product_id, concern_id) VALUES (?, ?)', [p.id, concernId(c)]);
    await tx.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'initial', '', 'system', ?)", [p.id, p.stock, now]);
  }
  // 会員：旧 members の行（パスワード・LINE ID）と、state.profiles（担当店舗・スタッフ）を1行にまとめる
  const profiles = new Map((state.profiles || []).map(p => [p.id, p]));
  const members = new Map();
  for (const row of legacyMembers) {
    let profile = {}; try { profile = JSON.parse(row.profile || '{}'); } catch {}
    members.set(row.id, { id: row.id, email: row.email, salt: row.salt, hash: row.hash, lineId: row.line_id || profile.lineId || null, name: profile.name || 'LINE会員', kana: profile.kana || '', phone: profile.phone || '', gender: profile.gender || '', birthday: profile.birthday || '', createdAt: profile.createdAt || now });
  }
  const ensureMember = (id, fallback = {}) => {
    if (members.has(id)) return;
    const p = profiles.get(id) || fallback;
    members.set(id, { id, email: p.email || `${id}@legacy.example.test`, ...unusablePassword(), lineId: null, name: p.name || '移行会員', kana: p.kana || '', phone: p.phone || '', gender: p.gender || '', birthday: p.birthday || '', createdAt: p.createdAt || now });
  };
  for (const id of profiles.keys()) ensureMember(id);
  for (const o of state.orders || []) ensureMember(o.memberId, { name: o.customer?.name, email: o.customer?.email });
  const usedEmails = new Set();
  for (const m of members.values()) {
    let email = String(m.email).toLowerCase();
    if (usedEmails.has(email)) email = `${m.id}@legacy.example.test`;
    usedEmails.add(email);
    const p = profiles.get(m.id), salonId = p && salonIds.has(p.salonId) ? p.salonId : null;
    const staffId = salonId && p.staffId && staffIds.has(p.staffId) ? p.staffId : null;
    await tx.run(`INSERT INTO members (id, email, email_index, password_salt, password_hash, name, kana, phone, gender, birthday, line_id, salon_id, staff_id, salon_linked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, c.encrypt(email), c.blindIndex(email), m.salt, m.hash, ...[m.name, m.kana, m.phone, m.gender, m.birthday].map(c.encrypt), m.lineId, salonId, staffId, salonId ? (p.createdAt || m.createdAt) : null, m.createdAt, now]);
  }
  for (const s of legacySessions) if (members.has(s.member_id)) await tx.run('INSERT INTO member_sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)', [s.token_hash, s.member_id, s.expires_at]);
  // 注文・発注・明細・履歴・決済（古いものから）
  const orders = [...(state.orders || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const o of orders) {
    // 支払方法がない以前の注文は、テスト決済（カード）として扱う
    const paymentStatus = o.paymentStatus || (/返金/.test(o.payment || '') ? 'refunded' : 'captured');
    await tx.run(`INSERT INTO orders (id, request_key, fingerprint, member_id, salon_id, salon_name, seller, staff_id, staff_name, fee_rate, fee, subtotal, shipping, total, tax_total,
      payment_method, status, payment_status, ship_name, ship_postal, ship_address, ship_phone, ship_email, return_reason, stock_restored, is_sample, ordered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id, o.requestKey || `legacy-${o.id}`, c.digest(o.fingerprint || ''), o.memberId, o.salonId, o.salonName, o.seller || o.salonName, o.staffId || '', o.staffName || '指名なし', o.feeRate ?? 0, o.fee ?? 0, o.subtotal, o.shipping, o.total, includedTax(o.total),
      o.status, paymentStatus, ...[o.customer?.name, o.customer?.postal, o.customer?.prefecture ? encodeAddress(o.customer) : o.customer?.address, o.customer?.phone, o.customer?.email].map(v => c.encrypt(v || '')), o.returnReason ? c.encrypt(o.returnReason) : null, o.stockRestored ? 1 : 0, o.sample ? 1 : 0,
      jst(o.createdAt).slice(0, 10), o.createdAt, now]);
    const pos = (state.purchaseOrders || []).filter(p => p.orderId === o.id).sort((a, b) => a.id.localeCompare(b.id));
    for (const [i, po] of pos.entries()) {
      await tx.run(`INSERT INTO purchase_orders (id, order_id, dealer_id, salon_id, seq, status, shipping, total, carrier, tracking, shipped_at, delivered_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [po.id, o.id, po.dealerId, po.salonId || o.salonId, i + 1, po.status, po.shipping || 0, po.total, po.carrier || '', po.tracking || '', po.shippedAt || null, po.status === 'delivered' ? (po.deliveredAt || po.shippedAt || o.createdAt) : null, po.createdAt || o.createdAt, now]);
    }
    for (const [i, item] of (o.items || []).entries()) {
      const po = pos.find(p => p.dealerId === item.dealerId) || pos[0];
      await tx.run(`INSERT INTO order_items (order_id, purchase_order_id, line_no, product_id, sku, name, size, image, unit_price, unit_cost, quantity, tax_rate, dealer_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?)`,
      [o.id, po.id, i + 1, item.id, skuOf(item.id), item.name, item.size || '', item.image || '', item.price, item.cost ?? 0, item.quantity, item.dealerId || po.dealerId]);
    }
    for (const e of o.timeline || []) await tx.run('INSERT INTO order_events (order_id, occurred_at, label) VALUES (?, ?, ?)', [o.id, e.at, e.label]);
    await tx.run("INSERT INTO payments (order_id, provider, provider_payment_id, amount, status, created_at, updated_at) VALUES (?, 'test', ?, ?, ?, ?, ?)", [o.id, `test_${o.id}`, o.total, paymentStatus, o.createdAt, now]);
    if (paymentStatus === 'refunded') await tx.run('INSERT INTO refunds (order_id, amount, reason, created_at) VALUES (?, ?, ?, ?)', [o.id, o.total, o.returnReason ? '返品' : 'キャンセル', now]);
  }
  // 操作履歴（古いものから）
  for (const e of [...(state.events || [])].sort((a, b) => a.at.localeCompare(b.at))) await tx.run('INSERT INTO audit_logs (occurred_at, actor, action, reference) VALUES (?, ?, ?, ?)', [e.at, e.actor || '', e.action, e.reference || '']);
  // カート・お気に入り（ブラウザ版の state に含まれる場合）
  for (const [memberId, items] of Object.entries(state.carts || {})) if (members.has(memberId)) for (const [productId, quantity] of Object.entries(items)) await tx.run('INSERT INTO cart_items (member_id, product_id, quantity, updated_at) VALUES (?, ?, ?, ?)', [memberId, productId, quantity, now]);
  for (const [memberId, ids] of Object.entries(state.favorites || {})) if (members.has(memberId)) for (const productId of ids) await tx.run('INSERT INTO favorites (member_id, product_id, created_at) VALUES (?, ?, ?)', [memberId, productId, now]);
  // 加盟店の仕入発注・定期発注・請求書
  const salonsById = new Map((state.salons || []).map(s => [s.id, s]));
  for (const o of [...(state.supplyOrders || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!salonIds.has(o.salonId)) continue;
    await tx.run(`INSERT INTO supply_orders (id, request_key, salon_id, operator_id, operator_name, source, subscription_id, status, subtotal, shipping, total, tax_total,
      ship_name, ship_address, note, carrier, tracking, shipped_at, delivered_at, billing_month, invoice_id, stock_restored, ordered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id, o.requestKey || `legacy-${o.id}`, o.salonId, o.operatorId || '', o.operatorName || '', o.source || 'manual', o.subscriptionId || null, o.status, o.subtotal, o.shipping, o.total, o.taxTotal ?? includedTax(o.total),
      o.shipTo?.name || o.salonName, o.shipTo?.address || salonAddress(salonsById.get(o.salonId)), o.note || '', o.carrier || '', o.tracking || '', o.shippedAt || null, o.deliveredAt || null,
      o.billingMonth || jst(o.createdAt).slice(0, 7), o.invoiceId || null, o.stockRestored ? 1 : 0, o.orderedOn || jst(o.createdAt).slice(0, 10), o.createdAt, now]);
    for (const [i, l] of (o.items || []).entries()) await tx.run('INSERT INTO supply_order_items (supply_order_id, line_no, product_id, sku, name, size, image, unit_price, quantity, tax_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10)', [o.id, i + 1, l.id, l.sku || skuOf(l.id), l.name, l.size || '', l.image || '', l.unitPrice, l.quantity]);
  }
  for (const sub of state.supplySubscriptions || []) {
    if (!salonIds.has(sub.salonId)) continue;
    await tx.run('INSERT INTO supply_subscriptions (id, salon_id, operator_id, interval_code, next_run_on, active, last_run_on, last_result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [sub.id, sub.salonId, sub.operatorId, sub.interval, sub.nextRunOn, sub.active ? 1 : 0, sub.lastRunOn || '', sub.lastResult || '', sub.createdAt || now, now]);
    for (const [i, item] of (sub.items || []).entries()) await tx.run('INSERT INTO supply_subscription_items (subscription_id, product_id, quantity, line_no) VALUES (?, ?, ?, ?)', [sub.id, item.id, item.quantity, i]);
  }
  for (const inv of state.invoices || []) {
    if (!salonIds.has(inv.salonId)) continue;
    await tx.run(`INSERT INTO invoices (id, salon_id, billing_month, bill_to_name, bill_to_address, salon_name, issued_on, due_on, order_count, subtotal, tax_total, total, status, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [inv.id, inv.salonId, inv.month, inv.billTo?.name || '', inv.billTo?.address || '', inv.salonName, inv.issuedOn, inv.dueOn, inv.orderCount, inv.subtotal, inv.taxTotal, inv.total, inv.status, inv.paidAt || null, inv.createdAt || now, now]);
  }
  // 採番・更新番号
  const seq = Math.max(state.salonSeq ?? 0, (state.salons || []).length, ...(state.salons || []).map(s => Number(/^S(\d+)$/.exec(s.id)?.[1] || 0)));
  await tx.run('INSERT INTO counters (name, value) VALUES (?, ?)', ['salon_seq', seq]);
  await tx.run('INSERT INTO counters (name, value) VALUES (?, ?)', ['product_seq', state.productSeq || 0]);
  await tx.run('INSERT INTO counters (name, value) VALUES (?, ?)', ['revision', state.revision || 0]);
  return { salons: salonIds.size, products: products.length, members: members.size, orders: orders.length };
}
