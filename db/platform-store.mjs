// DB版の業務ロジック（ローカル版・本番用）。画面とのやり取りの形はブラウザ版（dist/platform-core.js）と同じで、
// 入力検証・送料・状態遷移・精算などの規則は platform-core.js の関数を共有する。
import { randomBytes } from 'node:crypto';
import {
  fail, required, int, salonInput, staffList, staffSummary, staffNameInput, staffMoveInput, staffRoute, staffStatsOf, newStaffId, MAX_STAFF, salesUnits, salesRange, jst, includedTax, shippingFor, orderFingerprint, requestKeyOf,
  orderCustomer, newOrderId, purchaseOrderId, feeOf, PO_TRANSITIONS, orderStatusFrom, validateTracking, cartInput, favoritesInput,
  settlement, requireOperator, allowedOrder, statuses, poStatuses, createPlatform, migrate, demoOperators, DEMO_OPERATOR_PASSWORD,
  addressInput, sortAddresses, addressView, cardView, sortCards, shipmentLabel, MAX_ADDRESSES,
} from '../dist/platform-core.js';
import { paymentInput, paymentLabel, testCharge, cardInput, paymentAfterCancel, ORDER_PLACED_LABEL, MAX_CARDS } from '../dist/payment-core.js';
import { validateProfile, profileComplete } from '../dist/member-store.js';
import { encodeAddress, decodeAddress } from '../dist/person.js';
import { productInput, categoryInput, nextSku, priceRowsInput, applyPriceRow, decodeImage, newProductId, newCategoryId, MAX_IMAGE_BYTES, legacyImages } from '../dist/catalog-core.js';
import { shippingRow, shippingInput, shippingFileName, SHIPPING_COLUMNS, SHIPPABLE, SUPPLY_SHIPPABLE } from '../dist/shipping-csv.js';
import { ISSUER, salonAddress } from '../dist/supply-core.js';
import { schemaTable } from './adapter.mjs';
import { passwordDigest } from '../dist/member-store.js';
import { importState } from './import-state.mjs';
import { createSupplyStore } from './supply-store.mjs';
import { wholesaleOf } from '../dist/supply-core.js';
import { memberRef, actorLabel, customerFor, orderForRole } from '../dist/privacy.js';
import { viewEntries, shouldRecordView, exportInput, lookupInput, accessLogView, accessActions, accessRoles, accessChannels, accessTargets, ACCESS_LOG_LIMIT } from '../dist/access-log.js';
import { createFieldCrypto, openRow, sealRow, isSealed, SEALED_COLUMNS } from './crypto.mjs';

const bool = value => Boolean(Number(value));
const num = value => Number(value || 0);
const marks = list => list.map(() => '?').join(',');
// 変更を伴わない処理と、全画面の再読み込みを促さない処理（カート・お気に入り・住所録・支払方法・出力の記録）
const READ_ONLY = new Set(['/quote', '/admin/sales']);
const QUIET = new Set(['/cart', '/favorites', '/supply/favorites', '/admin/exports', '/admin/shipping-csv']);
const quiet = route => QUIET.has(route) || /^\/(addresses|payment-methods)(\/|$)/.test(route);
const SNAPSHOT_LIMIT = 1000;
export const SCHEMA_VERSION = '7';
const KEY_CHECK = 'salon-station:key-check';
// アクセス記録は追記のみ（SQLite）。MySQL ではアプリ用ユーザーに UPDATE / DELETE の権限を与えない（db/grants.mysql.sql）。
const APPEND_ONLY_SQLITE = `CREATE TRIGGER IF NOT EXISTS data_access_logs_no_update BEFORE UPDATE ON data_access_logs BEGIN SELECT RAISE(ABORT, 'アクセス記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS data_access_logs_no_delete BEFORE DELETE ON data_access_logs BEGIN SELECT RAISE(ABORT, 'アクセス記録は削除できません'); END;`;

// fieldCrypto：お客様の個人情報（会員・お届け先・注文のお届け先）を暗号化して保存する（db/crypto.mjs）。
// images：商品画像の保存先（images.mjs の createImageStore）。なければ画像の登録はできない
export function createPlatformStore(db, { catalog, concernNames = [], fieldCrypto, images }) {
  const c = fieldCrypto || createFieldCrypto(null);
  // ---- 読み出し（行 → 画面に渡す形）
  const salonFrom = (r, staff) => ({ id: r.id, name: r.name, area: r.area, description: r.description, owner: r.owner, prefecture: r.prefecture, city: r.city, street: r.street, building: r.building, phone: r.phone, hours: r.hours, holiday: r.holiday, notes: r.notes, feeRate: num(r.fee_rate), enabled: bool(r.enabled), staff });
  async function loadSalons(q, { enabledOnly = false, ids } = {}) {
    if (ids && !ids.length) return [];
    const where = [], params = [];
    if (enabledOnly) where.push('enabled=1');
    if (ids) { where.push(`id IN (${marks(ids)})`); params.push(...ids); }
    const rows = await q.all(`SELECT * FROM salons${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, id`, params);
    if (!rows.length) return [];
    const staff = await q.all(`SELECT id, salon_id, name FROM staff WHERE active=1 AND salon_id IN (${marks(rows)}) ORDER BY sort_order, id`, rows.map(r => r.id));
    return rows.map(r => salonFrom(r, staff.filter(s => s.salon_id === r.id).map(({ id, name }) => ({ id, name }))));
  }
  const salonById = async (q, id) => (await loadSalons(q, { ids: [String(id ?? '')] }))[0] || fail('サロンが見つかりません。', 404);
  async function loadProducts(q, { enabledOnly = false, dealerId, ids, withCost = false } = {}) {
    if (ids && !ids.length) return [];
    const where = [], params = [];
    if (enabledOnly) where.push('p.enabled=1');
    if (dealerId) { where.push('p.dealer_id=?'); params.push(dealerId); }
    if (ids) { where.push(`p.id IN (${marks(ids)})`); params.push(...ids); }
    const rows = await q.all(`SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id=p.category_id${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.sort_order, p.id`, params);
    if (!rows.length) return [];
    const concerns = await q.all(`SELECT pc.product_id, n.name FROM product_concerns pc JOIN concerns n ON n.id=pc.concern_id WHERE pc.product_id IN (${marks(rows)}) ORDER BY n.sort_order`, rows.map(r => r.id));
    return rows.map(r => ({ id: r.id, brand: r.brand, name: r.name, category: r.category_name, concerns: concerns.filter(c => c.product_id === r.id).map(c => c.name), size: r.size, price: num(r.price), stock: num(r.stock), image: r.image, tag: r.tag, summary: r.summary || '', description: r.description, sku: r.sku, enabled: bool(r.enabled), dealerId: r.dealer_id, ...(withCost ? { cost: num(r.cost), wholesalePrice: num(r.wholesale_price) } : {}) }));
  }
  const loadDealers = async (q, dealerId) => (await q.all(`SELECT * FROM dealers${dealerId ? ' WHERE id=?' : ''} ORDER BY id DESC`, dealerId ? [dealerId] : [])).map(d => ({ id: d.id, name: d.name, short: d.short_name, area: d.area, lead: d.lead_time }));
  const profileFrom = m => ({ id: m.id, name: m.name, email: m.email, kana: m.kana, phone: m.phone, gender: m.gender, birthday: m.birthday, lineLinked: Boolean(m.line_id), salonId: m.salon_id, staffId: m.staff_id || '', createdAt: m.salon_linked_at || m.created_at });
  const revision = async q => num((await q.get("SELECT value FROM counters WHERE name='revision'"))?.value);

  async function loadOrders(q, where, params, limit) {
    const rows = await q.all(`SELECT * FROM orders${where ? ' WHERE ' + where : ''} ORDER BY created_at DESC, id DESC${limit ? ` LIMIT ${Number(limit)}` : ''}`, params);
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const items = await q.all(`SELECT * FROM order_items WHERE order_id IN (${marks(ids)}) ORDER BY order_id, line_no`, ids);
    const events = await q.all(`SELECT * FROM order_events WHERE order_id IN (${marks(ids)}) ORDER BY id`, ids);
    const pos = await q.all(`SELECT * FROM purchase_orders WHERE order_id IN (${marks(ids)}) ORDER BY order_id, seq`, ids);
    return rows.map(row => ({ row, items: items.filter(i => i.order_id === row.id), events: events.filter(e => e.order_id === row.id), pos: pos.filter(p => p.order_id === row.id) }));
  }
  const itemFrom = (i, withCost) => ({ id: i.product_id, name: i.name, image: i.image, size: i.size, price: num(i.unit_price), ...(withCost ? { cost: num(i.unit_cost) } : {}), quantity: num(i.quantity), dealerId: i.dealer_id });
  function orderView(o, dealers, admin = false) {
    const r = openRow(c, 'orders', o.row);
    const view = {
      id: r.id, createdAt: r.created_at, memberId: r.member_id, salonId: r.salon_id, salonName: r.salon_name, seller: r.seller, staffId: r.staff_id, staffName: r.staff_name,
      customer: { name: r.ship_name, postal: r.ship_postal, ...decodeAddress(r.ship_address), phone: r.ship_phone || '', email: r.ship_email },
      items: o.items.map(i => itemFrom(i, admin)), subtotal: num(r.subtotal), shipping: num(r.shipping), total: num(r.total), taxTotal: num(r.tax_total),
      paymentMethod: r.payment_method, paymentStatus: r.payment_status,
      status: r.status, payment: paymentLabel(r.payment_method, r.payment_status), timeline: o.events.map(e => ({ at: e.occurred_at, label: e.label })),
      shipments: o.pos.map(p => ({ id: p.id, ...(admin ? { dealerId: p.dealer_id, dealerName: dealers.find(d => d.id === p.dealer_id)?.name } : {}), status: p.status, carrier: p.carrier, tracking: p.tracking, shippedAt: p.shipped_at || undefined, items: o.items.filter(i => i.purchase_order_id === p.id).map(i => ({ id: i.product_id, name: i.name, quantity: num(i.quantity) })) })),
    };
    if (r.return_reason) view.returnReason = r.return_reason;
    if (bool(r.is_sample)) view.sample = true;
    if (bool(r.stock_restored)) view.stockRestored = true;
    if (admin) view.fee = num(r.fee);
    return view;
  }
  async function orderById(q, id, admin = false) {
    const [o] = await loadOrders(q, 'id=?', [id]);
    return o ? orderView(o, await loadDealers(q), admin) : null;
  }
  function poView(p, items) {
    return { id: p.id, orderId: p.order_id, dealerId: p.dealer_id, salonId: p.salon_id, createdAt: p.created_at, status: p.status, items: items.map(i => itemFrom(i, true)), shipping: num(p.shipping), total: num(p.total), tracking: p.tracking, carrier: p.carrier, ...(p.shipped_at ? { shippedAt: p.shipped_at } : {}) };
  }
  // 操作履歴・在庫履歴には、お客様の氏名ではなく会員番号を残す
  const actorName = actorLabel;
  // 操作の内容は100文字まで（列の長さ）
  const audit = (q, actor, action, reference, now) => q.run('INSERT INTO audit_logs (occurred_at, actor, action, reference) VALUES (?, ?, ?, ?)', [now, actorName(actor), String(action).slice(0, 100), reference]);
  const event = (q, orderId, label, now) => q.run('INSERT INTO order_events (order_id, occurred_at, label) VALUES (?, ?, ?)', [orderId, now, label]);
  const memberRow = async (q, id) => openRow(c, 'members', await q.get('SELECT * FROM members WHERE id=?', [id]));
  // 住所録・登録カード
  // 住所の列には都道府県・市区町村・番地・建物名を JSON で保存している（dist/person.js）
  const addressFrom = r => ({ id: String(r.id), name: r.name, postal: r.postal, ...decodeAddress(r.address), phone: r.phone || '', isDefault: bool(r.is_default), updatedAt: r.updated_at });
  const addressList = async (q, memberId) => sortAddresses((await q.all('SELECT * FROM member_addresses WHERE member_id=?', [memberId])).map(r => addressFrom(openRow(c, 'member_addresses', r)))).map(addressView);
  const addressRow = async (q, memberId, id) => /^\d+$/.test(String(id)) ? openRow(c, 'member_addresses', await q.get('SELECT * FROM member_addresses WHERE id=? AND member_id=?', [Number(id), memberId])) : null;
  const cardRow = async (q, memberId, id) => { const r = await q.get('SELECT * FROM member_cards WHERE id=? AND member_id=?', [String(id), memberId]); return r && { ...r, token: c.decrypt(r.token) }; };
  async function insertCard(q, memberId, card, now, makeDefault = false) {
    const count = num((await q.get('SELECT COUNT(*) AS n FROM member_cards WHERE member_id=?', [memberId])).n);
    if (count >= MAX_CARDS) fail(`カードは${MAX_CARDS}枚まで登録できます。`, 409);
    const isDefault = makeDefault || !count;
    if (isDefault) await q.run('UPDATE member_cards SET is_default=0 WHERE member_id=?', [memberId]);
    await q.run('INSERT INTO member_cards (id, member_id, provider, token, brand, last4, exp_month, exp_year, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['cd-' + randomBytes(4).toString('hex'), memberId, 'test', c.encrypt(card.token), card.brand, card.last4, card.expMonth, card.expYear, isDefault ? 1 : 0, now]);
  }
  // 商品・カテゴリ
  const categoryRows = q => q.all('SELECT c.id, c.name, c.sort_order, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id GROUP BY c.id, c.name, c.sort_order ORDER BY c.sort_order, c.id');
  const categoryList = async q => (await categoryRows(q)).map(r => ({ id: r.id, name: r.name, sortOrder: num(r.sort_order), productCount: num(r.product_count) }));
  const concernList = async q => (await q.all('SELECT name FROM concerns ORDER BY sort_order, id')).map(r => r.name);
  const catalogContext = async q => ({ categories: (await categoryRows(q)).map(r => ({ id: r.id, name: r.name })), dealers: await loadDealers(q), concernNames: await concernList(q) });
  async function saveConcerns(q, productId, names) {
    await q.run('DELETE FROM product_concerns WHERE product_id=?', [productId]);
    const all = await q.all('SELECT id, name FROM concerns');
    for (const name of names) await q.run('INSERT INTO product_concerns (product_id, concern_id) VALUES (?, ?)', [productId, all.find(x => x.name === name).id]);
  }
  function saveImage(dataUrl) {
    if (!images) fail('商品画像の保存先が設定されていません。', 500);
    const { bytes, ext } = decodeImage(dataUrl, MAX_IMAGE_BYTES);
    return images.save(bytes, ext);
  }

  // ---- 注文
  async function quote(q, input) {
    const salon = await q.get('SELECT id, enabled FROM salons WHERE id=?', [String(input?.salonId ?? '')]);
    if (!salon) fail('サロンが見つかりません。', 404);
    if (!bool(salon.enabled)) fail('このサロンは現在受注を停止しています。', 409);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail('商品をカートに追加してください。');
    const products = await loadProducts(q, { ids: [...new Set(input.items.map(l => String(l?.id)))], withCost: true });
    const seen = new Set();
    const items = input.items.map(line => {
      if (seen.has(line.id)) fail('同じ商品が重複しています。'); seen.add(line.id);
      const p = products.find(p => p.id === line.id && p.enabled); if (!p) fail('販売していない商品が含まれています。', 409);
      int(line.quantity, 1, 99); if (p.stock < line.quantity) fail(`${p.name}の在庫が不足しています（残り${p.stock}点）。`, 409);
      if (p.price !== line.price) fail(`${p.name}の価格が変更されました。カートを更新してください。`, 409);
      return { id: p.id, sku: p.sku, name: p.name, image: p.image, size: p.size, price: p.price, cost: p.cost, quantity: line.quantity, dealerId: p.dealerId };
    });
    const subtotal = items.reduce((s, p) => s + p.price * p.quantity, 0), shipping = shippingFor(subtotal);
    return { items, subtotal, shipping, total: subtotal + shipping };
  }
  const cleanQuote = q => ({ ...q, items: q.items.map(({ cost, sku, ...p }) => p) });
  async function placeOrder(q, input, actor, now, effects) {
    const member = actor.member; if (!member) fail('会員ログインが必要です。', 401);
    const key = requestKeyOf(input), fingerprint = c.digest(orderFingerprint(input));
    const old = await q.get('SELECT id, member_id, fingerprint FROM orders WHERE request_key=?', [key]);
    if (old) { if (old.member_id !== member.id) fail('この注文は取得できません。', 403); if (old.fingerprint !== fingerprint) fail('同じ注文番号で内容を変更できません。カートを確認してください。', 409); return old.id; }
    const m = await memberRow(q, member.id);
    if (!m?.salon_id || m.salon_id !== input.salonId) fail('マイページでご利用サロンを確認してください。', 409);
    // 会員マスタのフリガナは必須（LINEで簡略登録した会員は、注文の前にマイページで登録する）
    if (!profileComplete(m)) fail('マイページでお名前（姓・名）とフリガナを登録してから、ご注文ください。', 409);
    const saved = input?.addressId != null ? (await addressRow(q, m.id, input.addressId)) || fail('お届け先が見つかりません。', 404) : null;
    const customer = orderCustomer(input, m, saved), pay = paymentInput(input);
    const qt = await quote(q, input), salon = await salonById(q, input.salonId);
    if (pay.saveCard && num((await q.get('SELECT COUNT(*) AS n FROM member_cards WHERE member_id=?', [m.id])).n) >= MAX_CARDS) fail(`カードは${MAX_CARDS}枚まで登録できます。`, 409);
    const staff = m.staff_id ? salon.staff.find(s => s.id === m.staff_id) : null;
    let id = newOrderId(now);
    while (await q.get('SELECT id FROM orders WHERE id=?', [id])) id = newOrderId(now);
    // 在庫は「足りる場合だけ減らす」条件付き更新で確保する（同時注文でも売り越さない）。
    // 商品IDの順に更新し、MySQL で複数商品の同時注文がデッドロックしないようにする。
    for (const item of [...qt.items].sort((a, b) => a.id.localeCompare(b.id))) {
      const r = await q.run('UPDATE products SET stock=stock-?, updated_at=? WHERE id=? AND enabled=1 AND stock>=?', [item.quantity, now, item.id, item.quantity]);
      if (r.changes !== 1) fail(`${item.name}の在庫が不足しています。`, 409);
      await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'order', ?, ?, ?)", [item.id, -item.quantity, id, actorName(member), now]);
    }
    // カード：登録済みカード・新しいカード（トークン）・トークンなし（テスト決済）のどれか。承認されなければ在庫の確保ごと取り消す
    const card = pay.cardId ? (await cardRow(q, m.id, pay.cardId)) || fail('登録済みのカードが見つかりません。', 404) : pay.card;
    const charge = testCharge(card?.token || 'tok_test_' + randomBytes(10).toString('hex'), qt.total);
    if (pay.saveCard) await insertCard(q, m.id, pay.card, now);
    await q.run(`INSERT INTO orders (id, request_key, fingerprint, member_id, salon_id, salon_name, seller, staff_id, staff_name, fee_rate, fee, subtotal, shipping, total, tax_total,
      payment_method, status, payment_status, ship_name, ship_postal, ship_address, ship_phone, ship_email, return_reason, stock_restored, is_sample, ordered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'card', 'ordered', 'captured', ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?)`,
    [id, key, fingerprint, m.id, salon.id, salon.name, salon.owner, staff?.id || '', staff?.name || '指名なし', salon.feeRate, feeOf(qt.subtotal, salon.feeRate), qt.subtotal, qt.shipping, qt.total, includedTax(qt.total),
      ...[customer.name, customer.postal, encodeAddress(customer), customer.phone, customer.email].map(c.encrypt), jst(now).slice(0, 10), now, now]);
    const dealers = [...new Set(qt.items.map(i => i.dealerId))];
    for (const [index, dealerId] of dealers.entries()) {
      const items = qt.items.filter(i => i.dealerId === dealerId), shipping = index === 0 ? qt.shipping : 0, poId = purchaseOrderId(id, index);
      await q.run("INSERT INTO purchase_orders (id, order_id, dealer_id, salon_id, seq, status, shipping, total, carrier, tracking, shipped_at, delivered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, '', '', NULL, NULL, ?, ?)",
        [poId, id, dealerId, salon.id, index + 1, shipping, items.reduce((s, i) => s + i.cost * i.quantity, 0) + shipping, now, now]);
      for (const item of items) await q.run('INSERT INTO order_items (order_id, purchase_order_id, line_no, product_id, sku, name, size, image, unit_price, unit_cost, quantity, tax_rate, dealer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?)',
        [id, poId, qt.items.indexOf(item) + 1, item.id, item.sku, item.name, item.size, item.image, item.price, item.cost, item.quantity, dealerId]);
    }
    await event(q, id, ORDER_PLACED_LABEL, now);
    await q.run("INSERT INTO payments (order_id, provider, provider_payment_id, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'captured', ?, ?)", [id, charge.provider, charge.id, qt.total, now, now]);
    await q.run('DELETE FROM cart_items WHERE member_id=?', [m.id]);
    // お届け先：住所録が空なら今回のお届け先を登録する。「保存する」を選んだ場合も追加する（10件まで）
    const book = await q.all('SELECT id FROM member_addresses WHERE member_id=?', [m.id]);
    if (!saved && (!book.length || input?.saveAddress === true) && book.length < MAX_ADDRESSES) {
      const makeDefault = !book.length || input?.saveAsDefault === true;
      if (makeDefault) await q.run('UPDATE member_addresses SET is_default=0 WHERE member_id=?', [m.id]);
      await q.run('INSERT INTO member_addresses (member_id, name, postal, address, phone, is_default, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [m.id, ...[customer.name, customer.postal, encodeAddress(customer), customer.phone].map(c.encrypt), makeDefault ? 1 : 0, now]);
    }
    await audit(q, member, '受注・仕入先への自動発注', id, now);
    effects.push({ type: 'order_placed', orderId: id, memberId: m.id });
    return id;
  }
  async function restoreStock(q, orderId, reason, actor, now) {
    const order = await q.get('SELECT stock_restored FROM orders WHERE id=?', [orderId]);
    if (bool(order.stock_restored)) return;
    for (const i of await q.all('SELECT product_id, quantity FROM order_items WHERE order_id=?', [orderId])) {
      await q.run('UPDATE products SET stock=stock+?, updated_at=? WHERE id=?', [i.quantity, now, i.product_id]);
      await q.run('INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, ?, ?, ?, ?)', [i.product_id, i.quantity, reason, orderId, actorName(actor), now]);
    }
    await q.run('UPDATE orders SET stock_restored=1 WHERE id=?', [orderId]);
  }
  // キャンセル・返品のときの決済：決済済みなら返金を記録し、未入金なら取り消す
  async function settlePayment(q, order, reason, now) {
    await q.run('UPDATE payments SET status=?, updated_at=? WHERE order_id=?', [paymentAfterCancel(order.payment_status), now, order.id]);
    if (order.payment_status === 'captured') await q.run('INSERT INTO refunds (order_id, amount, reason, created_at) VALUES (?, ?, ?, ?)', [order.id, order.total, reason, now]);
  }

  // ---- お客様の個人情報へのアクセス記録（dist/access-log.js）。役割・操作・対象は日本語で保存する。
  const accessFrom = r => ({ id: String(r.id), at: r.occurred_at, actorId: r.actor_id, actorName: r.actor_name, role: r.role, salonId: r.salon_id, action: r.action, target: r.target, count: num(r.record_count), refs: r.member_refs, purpose: r.purpose, channel: r.channel, ip: r.ip });
  const recordAccess = (q, e, now) => q.run('INSERT INTO data_access_logs (occurred_at, actor_id, actor_name, role, salon_id, action, target, record_count, member_refs, purpose, channel, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [now, e.actorId, e.actorName, e.role, e.salonId || '', e.action, e.target, e.count, e.refs || '', e.purpose || '', e.channel || accessChannels.console, String(e.ip || '').slice(0, 60)]);
  async function recordViews(q, op, ip, entries, now) {
    for (const entry of entries) {
      const last = await q.get('SELECT occurred_at, record_count FROM data_access_logs WHERE actor_id=? AND action=? AND target=? AND salon_id=? ORDER BY id DESC LIMIT 1', [op.id || '', accessActions.view, entry.target, entry.salonId]);
      if (shouldRecordView(last && { at: last.occurred_at, count: last.record_count }, entry, now)) await recordAccess(q, { actorId: op.id || '', actorName: op.name, role: accessRoles[op.role], salonId: entry.salonId, action: accessActions.view, target: entry.target, count: entry.count, ip }, now);
    }
  }
  async function accessLogs(q, op) {
    const [where, params] = op.role === 'admin' ? ['', []] : op.role === 'salon' ? ['WHERE salon_id=?', [op.salonId]] : ['WHERE actor_id=?', [op.id || '']];
    return (await q.all(`SELECT * FROM data_access_logs ${where} ORDER BY id DESC LIMIT ${ACCESS_LOG_LIMIT}`, params)).map(r => accessLogView(op, accessFrom(r)));
  }

  // ---- 管理画面
  // 店舗ごとの会員の集計（本部が見る値）。日本時間の当月に担当店舗へ紐付いた会員を「今月の新規」とする。
  async function customerStats(q, salons, now) {
    const month = jst(now).slice(0, 7), [y, m] = month.split('-').map(Number);
    const start = new Date(`${month}-01T00:00:00+09:00`).toISOString(), end = new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString();
    const members = await q.all('SELECT salon_id, COUNT(*) AS members, SUM(CASE WHEN line_id IS NOT NULL THEN 1 ELSE 0 END) AS line_linked, SUM(CASE WHEN COALESCE(salon_linked_at, created_at) >= ? AND COALESCE(salon_linked_at, created_at) < ? THEN 1 ELSE 0 END) AS new_this_month FROM members WHERE salon_id IS NOT NULL GROUP BY salon_id', [start, end]);
    const buyers = await q.all("SELECT salon_id, COUNT(*) AS purchasers, SUM(CASE WHEN n >= 2 THEN 1 ELSE 0 END) AS repeaters FROM (SELECT salon_id, member_id, COUNT(*) AS n FROM orders WHERE status NOT IN ('cancelled','returned') GROUP BY salon_id, member_id) t GROUP BY salon_id");
    return salons.map(s => { const a = members.find(r => r.salon_id === s.id), b = buyers.find(r => r.salon_id === s.id), purchasers = num(b?.purchasers), repeaters = num(b?.repeaters);
      return { salonId: s.id, salonName: s.name, members: num(a?.members), lineLinked: num(a?.line_linked), newThisMonth: num(a?.new_this_month), purchasers, repeaters, repeatRate: purchasers ? Math.round(repeaters / purchasers * 1000) / 10 : 0 }; });
  }
  async function snapshot(q, actor, now) {
    const op = requireOperator(actor);
    const scope = op.role === 'admin' ? ['', []] : op.role === 'salon' ? ['salon_id=?', [op.salonId]] : ['1=0', []];
    const dealers = await loadDealers(q, op.role === 'dealer' ? op.dealerId : null), allDealers = await loadDealers(q);
    const orders = await loadOrders(q, scope[0], scope[1], SNAPSHOT_LIMIT);
    const poScope = op.role === 'admin' ? ['', []] : op.role === 'salon' ? ['WHERE po.salon_id=?', [op.salonId]] : ['WHERE po.dealer_id=?', [op.dealerId]];
    const poRows = await q.all(`SELECT po.*, o.salon_name, o.member_id, o.ship_name, o.ship_postal, o.ship_address, o.ship_email, o.payment_method, o.payment_status FROM purchase_orders po JOIN orders o ON o.id=po.order_id ${poScope[0]} ORDER BY po.created_at DESC, po.id DESC LIMIT ${SNAPSHOT_LIMIT}`, poScope[1]);
    const poItems = poRows.length ? await q.all(`SELECT * FROM order_items WHERE purchase_order_id IN (${marks(poRows)}) ORDER BY line_no`, poRows.map(p => p.id)) : [];
    const salonIds = op.role === 'admin' ? undefined : op.role === 'salon' ? [op.salonId] : [...new Set(poRows.map(p => p.salon_id))];
    // 顧客データ：サロンは自店のお客様の全項目、本部は会員番号と集計値だけ、ディーラーは発送に必要な項目だけ（dist/privacy.js）
    const members = op.role === 'salon' ? (await q.all('SELECT * FROM members WHERE salon_id=? ORDER BY salon_linked_at, id', [op.salonId])).map(m => openRow(c, 'members', m)) : [];
    const views = orders.map(o => orderView(o, allDealers, true));
    const salons = await loadSalons(q, { ids: salonIds });
    // 個人情報を渡す場合（美容室・ディーラー）は、渡す前にアクセス記録を残す
    await recordViews(q, op, actor.ip, viewEntries(op, { members: members.map(m => m.id), orders: orders.map(o => ({ salonId: o.row.salon_id, memberId: o.row.member_id })), shipments: poRows.map(p => ({ salonId: p.salon_id, memberId: p.member_id })) }), now);
    return {
      operator: op, revision: await revision(q),
      products: await loadProducts(q, { dealerId: op.role === 'dealer' ? op.dealerId : undefined, withCost: true }),
      salons, dealers,
      orders: views.map(o => orderForRole(op.role, o)),
      purchaseOrders: poRows.map(p => { const o = openRow(c, 'orders', p); return { ...poView(p, poItems.filter(i => i.purchase_order_id === p.id)), salonName: p.salon_name, customer: customerFor(op.role, { name: o.ship_name, address: decodeAddress(o.ship_address).address, postal: o.ship_postal, email: o.ship_email }, p.member_id) }; }),
      categories: op.role === 'admin' ? await categoryList(q) : [], concernNames: await concernList(q),
      profiles: members.map(m => ({ ...profileFrom(m), ref: memberRef(m.id) })),
      staffStats: op.role === 'dealer' ? [] : staffStatsOf((await q.all('SELECT salon_id, staff_id FROM members WHERE salon_id IS NOT NULL')).filter(m => op.role === 'admin' || m.salon_id === op.salonId).map(m => ({ salonId: m.salon_id, staffId: m.staff_id || '' }))),
      customerStats: op.role === 'dealer' ? [] : await customerStats(q, salons, now),
      settlements: views.map(o => settlement(o)),
      events: op.role === 'admin' ? (await q.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 400')).map(e => ({ id: String(e.id), at: e.occurred_at, actor: e.actor, action: e.action, reference: e.reference })) : [],
      accessLogs: await accessLogs(q, op),
      ...(await supply.snapshot(q, op)),
    };
  }
  async function salesReport(q, input, actor, now) {
    const op = requireOperator(actor, ['admin', 'salon']);
    const { unit, from, to } = salesRange(input, now);
    const salons = await loadSalons(q, { ids: op.role === 'admin' ? undefined : [op.salonId] });
    const where = `status NOT IN ('cancelled','returned') AND ordered_on BETWEEN ? AND ?${op.role === 'admin' ? '' : ' AND salon_id=?'}`;
    const params = op.role === 'admin' ? [from, to] : [from, to, op.salonId];
    const bucket = { day: 'ordered_on', month: 'SUBSTR(ordered_on, 1, 7)', year: 'SUBSTR(ordered_on, 1, 4)' }[unit];
    const measures = 'SUM(subtotal) AS sales, COUNT(*) AS orders, COUNT(DISTINCT member_id) AS customers';
    const summary = r => ({ sales: num(r?.sales), orders: num(r?.orders), customers: num(r?.customers) });
    const perSalon = await q.all(`SELECT salon_id, ${measures} FROM orders WHERE ${where} GROUP BY salon_id`, params);
    const total = summary(await q.get(`SELECT ${measures} FROM orders WHERE ${where}`, params));
    let rows;
    if (bucket) {
      const perSalonPeriod = await q.all(`SELECT salon_id, ${bucket} AS period, ${measures} FROM orders WHERE ${where} GROUP BY salon_id, ${bucket}`, params);
      const perPeriod = await q.all(`SELECT ${bucket} AS period, ${measures} FROM orders WHERE ${where} GROUP BY ${bucket}`, params);
      rows = perPeriod.map(p => String(p.period)).sort().map(period => ({ period, salons: salons.map(s => ({ salonId: s.id, salonName: s.name, ...summary(perSalonPeriod.find(r => r.salon_id === s.id && String(r.period) === period)) })), total: summary(perPeriod.find(r => String(r.period) === period)) }));
    } else rows = total.orders ? [{ period: `${from}〜${to}`, salons: salons.map(s => ({ salonId: s.id, salonName: s.name, ...summary(perSalon.find(r => r.salon_id === s.id)) })), total }] : [];
    return { from, to, unit, unitName: salesUnits[unit], rows, salons: salons.map(s => ({ salonId: s.id, salonName: s.name, ...summary(perSalon.find(r => r.salon_id === s.id)) })), total };
  }
  // 商品コードの自動採番（P-00001 の形）。番号は counters の product_seq に残す
  async function nextProductSku(q) {
    const row = await q.get("SELECT value FROM counters WHERE name='product_seq'");
    const { sku, seq } = nextSku(num(row?.value), (await q.all("SELECT sku FROM products WHERE sku LIKE 'P-%'")).map(r => r.sku));
    await q.run(row ? "UPDATE counters SET value=? WHERE name='product_seq'" : "INSERT INTO counters (name, value) VALUES ('product_seq', ?)", [seq]);
    return sku;
  }
  async function nextSalonId(q) {
    let n = num((await q.get("SELECT value FROM counters WHERE name='salon_seq'"))?.value) + 1, id;
    while (await q.get('SELECT id FROM salons WHERE id=?', [id = 'S' + String(n).padStart(3, '0')])) n++;
    await q.run("UPDATE counters SET value=? WHERE name='salon_seq'", [n]);
    return id;
  }
  async function saveStaff(q, salonId, list) {
    const existing = await q.all('SELECT id FROM staff WHERE salon_id=?', [salonId]);
    for (const [i, s] of list.entries()) {
      if (existing.some(e => e.id === s.id)) await q.run('UPDATE staff SET name=?, sort_order=?, active=1 WHERE id=?', [s.name, i, s.id]);
      else await q.run('INSERT INTO staff (id, salon_id, name, sort_order, active) VALUES (?, ?, ?, ?, 1)', [s.id, salonId, s.name, i]);
    }
    // 外したスタッフは履歴（会員の担当・注文）のため削除せず無効にする
    const keep = list.map(s => s.id);
    for (const e of existing) if (!keep.includes(e.id)) await q.run('UPDATE staff SET active=0 WHERE id=?', [e.id]);
  }
  const SALON_COLUMNS = ['name', 'owner', 'area', 'description', 'prefecture', 'city', 'street', 'building', 'phone', 'hours', 'holiday', 'notes'];

  // ---- ルーティング（ブラウザ版の platformRequest と同じ経路・応答）
  async function handle(q, route, method, input, actor, now, effects) {
    if (route === '/bootstrap' && method === 'GET') {
      const products = actor.member || actor.operator ? await loadProducts(q, { enabledOnly: true }) : [];
      const categories = products.length ? (await categoryRows(q)).filter(r => products.some(p => p.category === r.name)).map(r => ({ id: r.id, name: r.name })) : [];
      return { closed: true, products, categories, salons: (await loadSalons(q, { enabledOnly: true })).map(({ feeRate, notes, ...s }) => s), dealers: await loadDealers(q), revision: await revision(q) };
    }
    if (route === '/profile' && method === 'GET') {
      if (!actor.member) return null;
      const m = await memberRow(q, actor.member.id); if (!m?.salon_id) return null;
      const salon = await q.get('SELECT name, enabled FROM salons WHERE id=?', [m.salon_id]);
      const address = (await addressList(q, m.id)).find(a => a.isDefault);
      return { ...profileFrom(m), salonName: salon?.name || '', salonEnabled: bool(salon?.enabled), address: address || null };
    }
    // 住所管理（仕様書 2.1.3）：お届け先を10件まで登録・編集・削除し、いつものお届け先を選ぶ
    if (route === '/addresses' || route.startsWith('/addresses/')) {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const memberId = actor.member.id;
      if (route === '/addresses' && method === 'GET') return addressList(q, memberId);
      if (route === '/addresses' && method === 'POST') {
        const count = num((await q.get('SELECT COUNT(*) AS n FROM member_addresses WHERE member_id=?', [memberId])).n);
        if (count >= MAX_ADDRESSES) fail(`お届け先は${MAX_ADDRESSES}件まで登録できます。`, 409);
        const a = addressInput(input), isDefault = !count || input?.isDefault === true;
        if (isDefault) await q.run('UPDATE member_addresses SET is_default=0 WHERE member_id=?', [memberId]);
        await q.run('INSERT INTO member_addresses (member_id, name, postal, address, phone, is_default, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [memberId, ...[a.name, a.postal, encodeAddress(a), a.phone].map(c.encrypt), isDefault ? 1 : 0, now]);
        return addressList(q, memberId);
      }
      const row = await addressRow(q, memberId, route.split('/')[2]);
      if (!row) fail('お届け先が見つかりません。', 404);
      if (method === 'PATCH') {
        const a = addressInput({ ...addressFrom(row), ...input });
        await q.run('UPDATE member_addresses SET name=?, postal=?, address=?, phone=?, updated_at=? WHERE id=?', [...[a.name, a.postal, encodeAddress(a), a.phone].map(c.encrypt), now, row.id]);
        if (input?.isDefault === true) await q.run('UPDATE member_addresses SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END WHERE member_id=?', [row.id, memberId]);
        return addressList(q, memberId);
      }
      if (method === 'DELETE') {
        await q.run('DELETE FROM member_addresses WHERE id=?', [row.id]);
        const rest = await addressList(q, memberId);
        if (bool(row.is_default) && rest.length) await q.run('UPDATE member_addresses SET is_default=1 WHERE id=?', [Number(rest[0].id)]);
        return addressList(q, memberId);
      }
    }
    // 支払方法管理（仕様書 2.1.3）：いつもの支払方法と、登録カード（トークンと下4桁だけ）
    if (route === '/payment-methods' || route.startsWith('/payment-methods/')) {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const memberId = actor.member.id;
      const view = async () => ({ cards: sortCards((await q.all('SELECT * FROM member_cards WHERE member_id=?', [memberId])).map(r => ({ id: r.id, brand: r.brand, last4: r.last4, expMonth: r.exp_month, expYear: r.exp_year, isDefault: bool(r.is_default), createdAt: r.created_at }))).map(cardView) });
      if (route === '/payment-methods' && method === 'GET') return view();
      if (route === '/payment-methods' && method === 'PATCH') {
        if (!input?.defaultCardId || !(await cardRow(q, memberId, input.defaultCardId))) fail('カードが見つかりません。', 404);
        await q.run('UPDATE member_cards SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END WHERE member_id=?', [input.defaultCardId, memberId]);
        return view();
      }
      if (route === '/payment-methods/cards' && method === 'POST') { await insertCard(q, memberId, cardInput(input?.card, new Date(now)), now, input?.makeDefault === true); return view(); }
      const del = route.match(/^\/payment-methods\/cards\/([^/]+)$/);
      if (del && method === 'DELETE') {
        const card = await cardRow(q, memberId, del[1]); if (!card) fail('カードが見つかりません。', 404);
        await q.run('DELETE FROM member_cards WHERE id=?', [card.id]);
        const [first] = sortCards((await q.all('SELECT id, last4, created_at FROM member_cards WHERE member_id=?', [memberId])).map(r => ({ ...r, createdAt: r.created_at })));
        if (bool(card.is_default) && first) await q.run('UPDATE member_cards SET is_default=1 WHERE id=?', [first.id]);
        return view();
      }
    }
    if (route === '/profile' && method === 'PATCH') {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const salon = await salonById(q, input?.salonId), m = await memberRow(q, actor.member.id);
      if (!m) fail('会員ログインが必要です。', 401);
      if (m.salon_id && m.salon_id !== salon.id) fail('担当サロンの変更は、ご利用のサロンまたは運営本部にご依頼ください。', 403);
      if (!m.salon_id && !salon.enabled) fail('このサロンは現在ご利用いただけません。');
      if (input.staffId && !salon.staff.some(s => s.id === input.staffId)) fail('担当スタッフを確認してください。');
      await q.run('UPDATE members SET salon_id=?, staff_id=?, salon_linked_at=?, updated_at=? WHERE id=?', [salon.id, input.staffId || null, m.salon_linked_at || now, now, m.id]);
      await audit(q, actor.member, '会員サロン情報を保存', memberRef(m.id), now);
      return profileFrom(await memberRow(q, m.id));
    }
    if (route === '/cart' || route === '/favorites') {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const memberId = actor.member.id;
      if (route === '/cart' && method === 'GET') return { items: Object.fromEntries((await q.all('SELECT c.product_id, c.quantity FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.member_id=? AND p.enabled=1 ORDER BY c.updated_at, c.product_id', [memberId])).map(r => [r.product_id, num(r.quantity)])) };
      if (route === '/favorites' && method === 'GET') return { ids: (await q.all('SELECT product_id FROM favorites WHERE member_id=? ORDER BY created_at, product_id', [memberId])).map(r => r.product_id) };
      const products = await q.all('SELECT id, enabled FROM products');
      if (route === '/cart' && method === 'PUT') {
        const items = cartInput(input, id => products.some(p => p.id === id && bool(p.enabled)));
        await q.run('DELETE FROM cart_items WHERE member_id=?', [memberId]);
        for (const [productId, quantity] of Object.entries(items)) await q.run('INSERT INTO cart_items (member_id, product_id, quantity, updated_at) VALUES (?, ?, ?, ?)', [memberId, productId, quantity, now]);
        return { items };
      }
      if (route === '/favorites' && method === 'PUT') {
        const ids = favoritesInput(input, id => products.some(p => p.id === id));
        await q.run('DELETE FROM favorites WHERE member_id=?', [memberId]);
        for (const productId of ids) await q.run('INSERT INTO favorites (member_id, product_id, created_at) VALUES (?, ?, ?)', [memberId, productId, now]);
        return { ids };
      }
    }
    if (route === '/quote' && method === 'POST') { if (!actor.member) fail('会員ログインが必要です。', 401); return cleanQuote(await quote(q, input)); }
    if (route === '/admin/sales' && method === 'POST') return salesReport(q, input, actor, now);
    if (route === '/orders' && method === 'POST') return orderById(q, await placeOrder(q, input, actor, now, effects));
    if (route === '/orders' && method === 'GET') {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const dealers = await loadDealers(q);
      return (await loadOrders(q, 'member_id=?', [actor.member.id])).map(o => orderView(o, dealers));
    }
    const customerAction = route.match(/^\/orders\/([^/]+)\/(cancel|return)$/);
    if (customerAction && method === 'POST') {
      const order = await q.get('SELECT * FROM orders WHERE id=?', [customerAction[1]]); if (!order) fail('注文が見つかりません。', 404);
      const own = order.member_id === actor.member?.id;
      if (!own && !allowedOrder(actor, { salonId: order.salon_id })) fail('この注文を操作できません。', 403);
      const by = own ? actor.member : actor.operator;
      if (customerAction[2] === 'cancel') {
        if (order.status === 'cancelled') return orderById(q, order.id);
        if (!['ordered', 'processing'].includes(order.status)) fail('出荷後はキャンセルできません。返品をご利用ください。', 409);
        const refund = order.payment_status === 'captured';
        await q.run("UPDATE orders SET status='cancelled', payment_status=?, updated_at=? WHERE id=?", [paymentAfterCancel(order.payment_status), now, order.id]);
        await restoreStock(q, order.id, 'cancel', by, now);
        await q.run("UPDATE purchase_orders SET status='cancelled', updated_at=? WHERE order_id=?", [now, order.id]);
        await settlePayment(q, order, 'キャンセル', now);
        await event(q, order.id, refund ? '注文キャンセル・テスト返金完了' : '注文キャンセル（お支払いは発生していません）', now);
        await audit(q, by, '注文をキャンセル', order.id, now);
      } else {
        if (order.status === 'return_requested') return orderById(q, order.id);
        if (!['shipped', 'delivered'].includes(order.status)) fail('全商品の出荷後に返品を申請できます。', 409);
        const reason = required(input?.reason, 300);
        await q.run("UPDATE orders SET status='return_requested', return_reason=?, updated_at=? WHERE id=?", [c.encrypt(reason), now, order.id]);
        await event(q, order.id, '返品を受け付けました', now);
        await audit(q, by, '返品申請', order.id, now);
      }
      return orderById(q, order.id);
    }
    if (route === '/admin/snapshot' && method === 'GET') return snapshot(q, actor, now);
    const poAction = route.match(/^\/admin\/purchase-orders\/([^/]+)$/);
    if (poAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin', 'dealer']);
      const po = await q.get('SELECT * FROM purchase_orders WHERE id=?', [poAction[1]]); if (!po) fail('発注が見つかりません。', 404);
      if (op.role === 'dealer' && po.dealer_id !== op.dealerId) fail('他社の発注は操作できません。', 403);
      const order = await q.get('SELECT * FROM orders WHERE id=?', [po.order_id]);
      if (['return_requested', 'returned', 'cancelled'].includes(order.status)) fail('この注文の出荷状態は変更できません。', 409);
      const items = () => q.all('SELECT * FROM order_items WHERE purchase_order_id=? ORDER BY line_no', [po.id]);
      if (input?.status === po.status) return poView(po, await items());
      if (PO_TRANSITIONS[po.status] !== input?.status) fail('受付 → 出荷 → 配達完了の順に操作してください。', 409);
      if (input.status === 'shipped') { const { tracking, carrier } = validateTracking(input); await q.run("UPDATE purchase_orders SET status='shipped', tracking=?, carrier=?, shipped_at=?, updated_at=? WHERE id=?", [tracking, carrier, now, now, po.id]); }
      else await q.run(`UPDATE purchase_orders SET status=?, ${input.status === 'delivered' ? 'delivered_at=?, ' : ''}updated_at=? WHERE id=?`, input.status === 'delivered' ? [input.status, now, now, po.id] : [input.status, now, po.id]);
      const all = await q.all('SELECT status FROM purchase_orders WHERE order_id=?', [order.id]), nextStatus = orderStatusFrom(all.map(p => p.status));
      await q.run('UPDATE orders SET status=?, updated_at=? WHERE id=?', [nextStatus, now, order.id]);
      await event(q, order.id, shipmentLabel(input.status, num(po.seq), all.length), now);
      await audit(q, op, poStatuses[input.status], po.id, now);
      if (input.status === 'shipped') effects.push({ type: 'shipped', purchaseOrderId: po.id, orderId: order.id, memberId: order.member_id });
      return poView(await q.get('SELECT * FROM purchase_orders WHERE id=?', [po.id]), await items());
    }
    const refundAction = route.match(/^\/admin\/orders\/([^/]+)\/refund$/);
    if (refundAction && method === 'POST') {
      const op = requireOperator(actor, ['admin']);
      const order = await q.get('SELECT * FROM orders WHERE id=?', [refundAction[1]]); if (!order) fail('注文が見つかりません。', 404);
      if (order.status === 'returned') return orderById(q, order.id);
      if (order.status !== 'return_requested') fail('返品申請済みの注文を選んでください。', 409);
      await q.run("UPDATE orders SET status='returned', payment_status=?, updated_at=? WHERE id=?", [paymentAfterCancel(order.payment_status), now, order.id]);
      await restoreStock(q, order.id, 'return', op, now);
      await q.run("UPDATE purchase_orders SET status='returned', updated_at=? WHERE order_id=?", [now, order.id]);
      await settlePayment(q, order, '返品', now);
      await event(q, order.id, '返品検品・テスト返金が完了しました', now);
      await audit(q, op, '返品検品・返金完了', order.id, now);
      return orderById(q, order.id);
    }
    // 商品登録・編集（仕様書 2.1.1）。本部は全項目と画像、ディーラーは在庫数だけ
    if (route === '/admin/products' && method === 'POST') {
      const op = requireOperator(actor, ['admin']), fields = productInput(input, await catalogContext(q));
      fields.sku = await nextProductSku(q);
      const id = newProductId(), image = input?.imageData ? saveImage(input.imageData) : '', sort = num((await q.get('SELECT MAX(sort_order) AS n FROM products'))?.n) + 1;
      await q.run('INSERT INTO products (id, sku, brand, name, category_id, size, summary, description, image, tag, price, cost, wholesale_price, tax_rate, dealer_id, stock, enabled, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?)',
        [id, fields.sku, fields.brand, fields.name, fields.categoryId, fields.size, fields.summary, fields.description, image, fields.tag, fields.price, fields.cost, fields.wholesalePrice, fields.dealerId, fields.stock, fields.enabled ? 1 : 0, sort, now]);
      await saveConcerns(q, id, fields.concerns);
      if (fields.stock) await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'initial', '', ?, ?)", [id, fields.stock, op.name, now]);
      await audit(q, op, '商品を登録', fields.sku, now);
      return (await loadProducts(q, { ids: [id], withCost: true }))[0];
    }
    const productAction = route.match(/^\/admin\/products\/([^/]+)$/);
    if (productAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin', 'dealer']);
      const [p] = await loadProducts(q, { ids: [productAction[1]], withCost: true }); if (!p) fail('商品が見つかりません。', 404);
      if (op.role === 'dealer' && p.dealerId !== op.dealerId) fail('他社の商品は操作できません。', 403);
      let stock;
      if (op.role === 'admin') {
        const ctx = await catalogContext(q), u = productInput({ ...p, categoryId: ctx.categories.find(x => x.name === p.category)?.id, ...input }, ctx);
        const image = input?.imageData ? saveImage(input.imageData) : p.image;
        await q.run('UPDATE products SET brand=?, name=?, category_id=?, size=?, summary=?, description=?, image=?, tag=?, price=?, cost=?, wholesale_price=?, dealer_id=?, stock=?, enabled=?, updated_at=? WHERE id=?',
          [u.brand, u.name, u.categoryId, u.size, u.summary, u.description, image, u.tag, u.price, u.cost, u.wholesalePrice, u.dealerId, u.stock, u.enabled ? 1 : 0, now, p.id]);
        await saveConcerns(q, p.id, u.concerns);
        stock = u.stock;
      } else {
        if (['price', 'cost', 'enabled', 'wholesalePrice', 'sku', 'name', 'brand', 'categoryId', 'concerns', 'size', 'summary', 'description', 'tag', 'dealerId', 'imageData'].some(k => input?.[k] !== undefined)) fail('ディーラーは在庫数のみ更新できます。', 403);
        stock = int(input?.stock, 0, 99999);
        await q.run('UPDATE products SET stock=?, updated_at=? WHERE id=?', [stock, now, p.id]);
      }
      if (stock !== p.stock) await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'adjust', '', ?, ?)", [p.id, stock - p.stock, op.name, now]);
      await audit(q, op, '商品・在庫を更新', p.sku, now);
      return (await loadProducts(q, { ids: [p.id], withCost: true }))[0];
    }
    // 価格の一括更新（管理画面の価格一括編集）。すべての行を確かめてから保存する（1つでも誤りがあれば何も変えない）
    if (route === '/admin/product-prices' && method === 'PATCH') {
      const op = requireOperator(actor, ['admin']), rows = priceRowsInput(input), current = await loadProducts(q, { ids: rows.map(r => r.id), withCost: true });
      const updates = rows.map(r => { const p = current.find(x => x.id === r.id) || fail('商品が見つかりません。画面を読み込み直してください。', 404); return [p, applyPriceRow(r, p)]; });
      let updated = 0;
      for (const [p, u] of updates) {
        if (!u.changed.length) continue;
        await q.run('UPDATE products SET price=?, cost=?, wholesale_price=?, updated_at=? WHERE id=?', [u.price, u.cost, u.wholesalePrice, now, p.id]);
        await audit(q, op, `価格を一括更新（${u.summary}）`, p.sku, now);
        updated++;
      }
      return { updated };
    }
    // カテゴリ管理（仕様書 2.1.1）。商品が登録されているカテゴリは削除できない
    if (route === '/admin/categories' && method === 'POST') {
      const op = requireOperator(actor, ['admin']), { name } = categoryInput(input);
      if (await q.get('SELECT id FROM categories WHERE name=?', [name])) fail('同じ名前のカテゴリがあります。', 409);
      await q.run('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)', [newCategoryId(), name, num((await q.get('SELECT MAX(sort_order) AS n FROM categories'))?.n ?? -1) + 1]);
      await audit(q, op, 'カテゴリを登録', name, now);
      return categoryList(q);
    }
    const categoryAction = route.match(/^\/admin\/categories\/([^/]+)$/);
    if (categoryAction && (method === 'PATCH' || method === 'DELETE')) {
      const op = requireOperator(actor, ['admin']), cat = await q.get('SELECT * FROM categories WHERE id=?', [categoryAction[1]]);
      if (!cat) fail('カテゴリが見つかりません。', 404);
      if (method === 'PATCH') {
        let name = cat.name;
        if (input?.name !== undefined) { name = categoryInput(input).name; if (await q.get('SELECT id FROM categories WHERE name=? AND id<>?', [name, cat.id])) fail('同じ名前のカテゴリがあります。', 409); }
        await q.run('UPDATE categories SET name=?, sort_order=? WHERE id=?', [name, input?.sortOrder !== undefined ? int(input.sortOrder, 0, 9999) : num(cat.sort_order), cat.id]);
        await audit(q, op, 'カテゴリを変更', name, now);
        return categoryList(q);
      }
      if (await q.get('SELECT id FROM products WHERE category_id=? LIMIT 1', [cat.id])) fail('商品が登録されているカテゴリは削除できません。商品のカテゴリを変えてから削除してください。', 409);
      await q.run('DELETE FROM categories WHERE id=?', [cat.id]);
      await audit(q, op, 'カテゴリを削除', cat.name, now);
      return categoryList(q);
    }
    // 会員情報の編集（仕様書 AD-005）：お客様の情報は担当サロンのものなので、編集できるのは担当サロンだけ。メールアドレス（ログインID）は変えない
    const customerEdit = route.match(/^\/admin\/customers\/([^/]+)$/);
    if (customerEdit && method === 'PATCH') {
      const op = requireOperator(actor, ['salon']), m = await memberRow(q, customerEdit[1]);
      if (!m || m.salon_id !== op.salonId) fail('会員が見つかりません。', 404);
      const f = validateProfile(input);
      await q.run('UPDATE members SET name=?, kana=?, phone=?, gender=?, birthday=?, updated_at=? WHERE id=?', [...['name', 'kana', 'phone', 'gender', 'birthday'].map(k => c.encrypt(f[k])), now, m.id]);
      await audit(q, op, '会員情報を編集', memberRef(m.id), now);
      return { ...profileFrom(await memberRow(q, m.id)), ref: memberRef(m.id) };
    }
    // 出荷指示CSV（仕様書 RP-004：佐川急便連携）。ディーラーはEC注文の発注、本部は加盟店発注を出力する
    if (route === '/admin/shipping-csv' && method === 'POST') {
      const { kind, ids } = shippingInput(input), filename = shippingFileName(kind, jst(now).slice(0, 10));
      if (kind === 'purchaseOrders') {
        const op = requireOperator(actor, ['dealer']);
        const found = await q.all(`SELECT po.*, o.member_id, o.status AS order_status, o.ship_name, o.ship_postal, o.ship_address, o.ship_phone, o.ship_email FROM purchase_orders po JOIN orders o ON o.id=po.order_id WHERE po.dealer_id=? AND po.id IN (${marks(ids)})`, [op.dealerId, ...ids]);
        if (found.length !== ids.length) fail('出力できない発注が含まれています。', 403);
        const rows = ids.map(id => found.find(p => p.id === id));
        if (rows.some(p => !SHIPPABLE.includes(p.status) || ['cancelled', 'returned', 'return_requested'].includes(p.order_status))) fail('出荷前の発注だけを選んでください。', 409);
        const salonIds = [...new Set(rows.map(p => p.salon_id))].sort(), salons = await loadSalons(q, { ids: salonIds });
        // お客様の個人情報を含むので、店舗ごとにアクセス記録を残す
        for (const salonId of salonIds) await recordAccess(q, { actorId: op.id || '', actorName: op.name, role: accessRoles.dealer, salonId, action: accessActions.export, target: accessTargets.shippingCsv, count: new Set(rows.filter(p => p.salon_id === salonId).map(p => p.member_id)).size, ip: actor.ip }, now);
        const items = await q.all(`SELECT purchase_order_id, name, quantity FROM order_items WHERE purchase_order_id IN (${marks(ids)}) ORDER BY line_no`, ids);
        return { filename, columns: SHIPPING_COLUMNS, rows: rows.map(p => { const o = openRow(c, 'orders', p), salon = salons.find(s => s.id === p.salon_id);
          return shippingRow({ reference: p.id, to: { name: o.ship_name, postal: o.ship_postal, ...decodeAddress(o.ship_address), phone: o.ship_phone }, from: { name: salon.name, postal: '', address: salonAddress(salon), phone: salon.phone }, items: items.filter(i => i.purchase_order_id === p.id).map(i => ({ name: i.name, quantity: num(i.quantity) })), note: `注文 ${p.order_id}` }); }) };
      }
      requireOperator(actor, ['admin']);
      const found = await supply.loadOrders(q, `id IN (${marks(ids)})`, ids);
      if (found.length !== ids.length) fail('発注が見つかりません。', 404);
      const rows = ids.map(id => found.find(o => o.id === id));
      if (rows.some(o => !SUPPLY_SHIPPABLE.includes(o.status))) fail('出荷前の発注だけを選んでください。', 409);
      const salons = await loadSalons(q, { ids: [...new Set(rows.map(o => o.salonId))] });
      return { filename, columns: SHIPPING_COLUMNS, rows: rows.map(o => { const salon = salons.find(s => s.id === o.salonId);
        return shippingRow({ reference: o.id, to: { name: o.shipTo?.name || salon.name, postal: '', address: o.shipTo?.address || salonAddress(salon), phone: salon.phone }, from: { name: ISSUER.name, postal: '', address: ISSUER.address, phone: ISSUER.phone }, items: o.items, note: '加盟店発注' }); }) };
    }
    if (route === '/admin/salons' && method === 'POST') {
      const op = requireOperator(actor, ['admin']);
      const s = { ...salonInput(input), owner: required(input?.owner, 100), feeRate: int(input?.feeRate ?? 5, 0, 30), enabled: input?.enabled !== false };
      const staff = staffList(input?.staff), id = await nextSalonId(q);
      await q.run(`INSERT INTO salons (id, ${SALON_COLUMNS.join(', ')}, fee_rate, enabled, created_at, updated_at) VALUES (?, ${marks(SALON_COLUMNS)}, ?, ?, ?, ?)`, [id, ...SALON_COLUMNS.map(k => s[k] ?? ''), s.feeRate, s.enabled ? 1 : 0, now, now]);
      await saveStaff(q, id, staff);
      await audit(q, op, '店舗を登録', id, now);
      return salonById(q, id);
    }
    // 担当スタッフの追加・名前の変更・並び替え・削除（ブラウザ版と同じ規則）。削除したスタッフは履歴のため無効にして残す
    const staffAction = staffRoute(route);
    if (staffAction && ['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      const op = requireOperator(actor, ['admin', 'salon']), salon = await salonById(q, staffAction[1]);
      if (op.role === 'salon' && op.salonId !== salon.id) fail('他店舗のスタッフは編集できません。', 403);
      if (method === 'GET') {
        if (staffAction[2]) fail('この操作は利用できません。', 404);
        return staffSummary(salon.staff, (await q.all('SELECT staff_id FROM members WHERE salon_id=?', [salon.id])).map(m => m.staff_id || ''));
      }
      const staffOf = async () => (await salonById(q, salon.id)).staff;
      if (method === 'POST') {
        if (staffAction[2]) fail('この操作は利用できません。', 404);
        if (salon.staff.length >= MAX_STAFF) fail(`スタッフは${MAX_STAFF}名まで登録できます。`, 409);
        const name = staffNameInput(input?.name, salon.staff), sort = num((await q.get('SELECT MAX(sort_order) AS n FROM staff WHERE salon_id=?', [salon.id]))?.n) + 1;
        await q.run('INSERT INTO staff (id, salon_id, name, sort_order, active) VALUES (?, ?, ?, ?, 1)', [newStaffId(), salon.id, name, sort]);
        await audit(q, op, `スタッフを追加（${name}）`, salon.id, now);
        return staffOf();
      }
      const s = salon.staff.find(x => x.id === staffAction[2]); if (!s) fail('スタッフが見つかりません。', 404);
      if (method === 'PATCH') {
        if (input?.name !== undefined) {
          const name = staffNameInput(input.name, salon.staff, s.id);
          if (name !== s.name) { await q.run('UPDATE staff SET name=? WHERE id=?', [name, s.id]); await audit(q, op, `スタッフ名を変更（${s.name}→${name}）`, salon.id, now); }
        }
        if (input?.move !== undefined) {
          const list = [...salon.staff], i = list.indexOf(s), j = i + staffMoveInput(input.move);
          if (j >= 0 && j < list.length) {
            [list[i], list[j]] = [list[j], list[i]];
            for (const [k, x] of list.entries()) await q.run('UPDATE staff SET sort_order=? WHERE id=?', [k, x.id]);
            await audit(q, op, 'スタッフの並び順を変更', salon.id, now);
          }
        }
        return staffOf();
      }
      const to = input?.transferTo ? salon.staff.find(x => x.id === input.transferTo && x.id !== s.id) : null;
      if (input?.transferTo && !to) fail('引き継ぎ先のスタッフを確認してください。');
      const moved = num((await q.get('SELECT COUNT(*) AS n FROM members WHERE salon_id=? AND staff_id=?', [salon.id, s.id]))?.n);
      await q.run('UPDATE members SET staff_id=?, updated_at=? WHERE salon_id=? AND staff_id=?', [to?.id || null, now, salon.id, s.id]);
      await q.run('UPDATE staff SET active=0 WHERE id=?', [s.id]);
      await audit(q, op, `スタッフを削除（${s.name}・担当${moved}人は${to ? to.name : '指名なし'}へ）`, salon.id, now);
      return staffOf();
    }
    const salonAction = route.match(/^\/admin\/salons\/([^/]+)$/);
    if (salonAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin', 'salon']), salon = await salonById(q, salonAction[1]);
      if (op.role === 'salon' && op.salonId !== salon.id) fail('他店舗の情報は編集できません。', 403);
      const update = { ...salonInput({ ...salon, ...input }), owner: salon.owner, feeRate: salon.feeRate, enabled: salon.enabled };
      if (op.role === 'admin') { update.owner = required(input?.owner ?? salon.owner, 100); update.feeRate = int(input?.feeRate ?? salon.feeRate, 0, 30); if (input?.enabled !== undefined && typeof input.enabled !== 'boolean') fail('受付設定を確認してください。'); update.enabled = input?.enabled ?? salon.enabled; }
      else if (['owner', 'feeRate', 'enabled', 'staff'].some(k => input?.[k] !== undefined)) fail('サロン担当者は運用料率・受付設定・販売事業者名を変更できません。', 403);
      await q.run(`UPDATE salons SET ${SALON_COLUMNS.map(k => `${k}=?`).join(', ')}, fee_rate=?, enabled=?, updated_at=? WHERE id=?`, [...SALON_COLUMNS.map(k => update[k] ?? ''), update.feeRate, update.enabled ? 1 : 0, now, salon.id]);
      if (op.role === 'admin' && input?.staff !== undefined) await saveStaff(q, salon.id, staffList(input.staff, salon.staff));
      await audit(q, op, op.role === 'admin' ? '店舗設定を更新' : 'サロン情報を編集', salon.id, now);
      return salonById(q, salon.id);
    }
    if (salonAction && method === 'DELETE') {
      const op = requireOperator(actor, ['admin']), salon = await salonById(q, salonAction[1]);
      const used = await q.get('SELECT (SELECT COUNT(*) FROM orders WHERE salon_id=?) AS orders, (SELECT COUNT(*) FROM members WHERE salon_id=?) AS members, (SELECT COUNT(*) FROM operators WHERE salon_id=?) AS operators', [salon.id, salon.id, salon.id]);
      if (num(used.orders) || num(used.members)) fail('受注または会員が紐付いている店舗は削除できません。「新しい注文を受け付ける」を外して休止してください。', 409);
      if (num(used.operators)) fail('管理アカウントが紐付いている店舗は削除できません。', 409);
      await q.run('DELETE FROM staff WHERE salon_id=?', [salon.id]);
      await q.run('DELETE FROM supply_favorites WHERE salon_id=?', [salon.id]);
      await q.run('DELETE FROM salons WHERE id=?', [salon.id]);
      await audit(q, op, '店舗を削除', salon.id, now);
      return { deleted: salon.id };
    }
    const memberAction = route.match(/^\/admin\/members\/([^/]+)$/);
    if (memberAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin']);
      const key = decodeURIComponent(memberAction[1]).trim().toUpperCase();
      const found = (await memberRow(q, memberAction[1])) ? [await memberRow(q, memberAction[1])] : (await q.all('SELECT id, salon_id FROM members WHERE salon_id IS NOT NULL')).filter(r => memberRef(r.id) === key);
      const m = found.length === 1 ? found[0] : null; if (!m?.salon_id) fail('会員番号に該当する会員が見つかりません。', 404);
      const salon = await salonById(q, input?.salonId);
      if (!salon.enabled && salon.id !== m.salon_id) fail('受付を停止しているサロンには紐付けできません。', 409);
      if (input?.staffId && !salon.staff.some(s => s.id === input.staffId)) fail('担当スタッフを確認してください。');
      await q.run('UPDATE members SET salon_id=?, staff_id=?, updated_at=? WHERE id=?', [salon.id, input?.staffId || null, now, m.id]);
      await audit(q, op, '会員の担当店舗を変更', memberRef(m.id), now);
      const updated = await memberRow(q, m.id);
      return { ref: memberRef(m.id), salonId: updated.salon_id, staffId: updated.staff_id || '' };
    }
    // CSV出力の記録（美容室が自店のお客様の情報を含む一覧を出力するとき）。出力する行が自店の範囲内か確かめてから記録する。
    if (route === '/admin/exports' && method === 'POST') {
      const op = requireOperator(actor, ['salon']), { kind, target, ids } = exportInput(input);
      if (!ids.length) return { logged: 0 };
      const table = kind === 'orders' ? 'orders' : 'members';
      const found = await q.all(`SELECT id FROM ${table} WHERE salon_id=? AND id IN (${marks(ids)})`, [op.salonId, ...ids]);
      if (found.length !== ids.length) fail('出力する対象を確認してください。', 403);
      await recordAccess(q, { actorId: op.id || '', actorName: op.name, role: accessRoles.salon, salonId: op.salonId, action: accessActions.export, target, count: ids.length, ip: actor.ip }, now);
      return { logged: 1 };
    }
    // 加盟店からの仕入発注・定期発注・月次請求（db/supply-store.mjs）
    const supplyResult = await supply.handle(q, route, method, input, actor, now, effects);
    if (supplyResult !== undefined) return supplyResult;
    fail('この操作は利用できません。', 404);
  }
  const supply = createSupplyStore({ db, loadProducts, audit, customerStats });

  // ---- 個人情報の暗号化（版の更新時・鍵を設定したとき）
  // 暗号化に合わせた列の追加・拡張（schema_version 3 → 4）。SQLite は列の型の長さを問わない。
  async function widenForEncryption() {
    if (db.dialect === 'sqlite') return db.exec('ALTER TABLE members ADD COLUMN email_index TEXT');
    await db.exec("ALTER TABLE members DROP INDEX email, ADD COLUMN email_index VARCHAR(64) NULL AFTER email, ADD UNIQUE KEY members_email_index (email_index), MODIFY email VARCHAR(512) NOT NULL, MODIFY name VARCHAR(512) NOT NULL, MODIFY kana VARCHAR(512) NOT NULL DEFAULT '', MODIFY phone VARCHAR(128) NOT NULL DEFAULT '', MODIFY gender VARCHAR(128) NOT NULL DEFAULT '', MODIFY birthday VARCHAR(128) NOT NULL DEFAULT ''");
    await db.exec('ALTER TABLE member_addresses MODIFY name VARCHAR(512) NOT NULL, MODIFY postal VARCHAR(128) NOT NULL, MODIFY address VARCHAR(1500) NOT NULL');
    await db.exec('ALTER TABLE orders MODIFY ship_name VARCHAR(512) NOT NULL, MODIFY ship_postal VARCHAR(128) NOT NULL, MODIFY ship_address VARCHAR(1500) NOT NULL, MODIFY ship_email VARCHAR(512) NOT NULL, MODIFY return_reason VARCHAR(1700) NULL');
  }
  // 版5の注文の表：支払方法・お届け先の電話番号を追加し、支払状態に「入金待ち」「取消」を加える。
  // SQLite は CHECK 制約を変えられないため、公式の手順（新しい表を作って写し、入れ替える）で作り直す。
  async function upgradeOrdersV5() {
    if (db.dialect === 'mysql') return db.exec("ALTER TABLE orders ADD COLUMN payment_method VARCHAR(20) NOT NULL DEFAULT 'card' AFTER tax_total, ADD COLUMN ship_phone VARCHAR(256) NOT NULL DEFAULT '' AFTER ship_address");
    const old = await db.tableColumns('orders');
    await db.exec('PRAGMA foreign_keys=OFF');
    try {
      await db.transaction(async tx => {
        await tx.exec(schemaTable('sqlite', 'orders').replace('CREATE TABLE IF NOT EXISTS orders', 'CREATE TABLE orders_v5'));
        const columns = (await tx.all("SELECT name FROM pragma_table_info('orders_v5')")).map(r => r.name).filter(name => old.includes(name)).join(', ');
        await tx.exec(`INSERT INTO orders_v5 (${columns}) SELECT ${columns} FROM orders`);
        await tx.exec('DROP TABLE orders');
        await tx.exec('ALTER TABLE orders_v5 RENAME TO orders');
      });
    } finally { await db.exec('PRAGMA foreign_keys=ON'); }
    if ((await db.all('PRAGMA foreign_key_check')).length) throw Error('注文の表の作り直しで、参照の整合性が崩れました。');
  }
  // 暗号化していない行（前の版のDB・鍵なしで作ったDB）を暗号化し、メールアドレスの検索用の値を作る。
  // 暗号化した鍵の確認値を app_meta に残し、違う鍵・鍵なしで起動したら止める（読めない値を書き足さないため）。
  async function sealExisting() {
    const check = c.enabled ? c.blindIndex(KEY_CHECK) : '';
    const saved = (await db.get("SELECT meta_value FROM app_meta WHERE meta_key='encryption_check'"))?.meta_value;
    if (saved && saved !== check) throw Error(c.enabled ? 'DATA_ENCRYPTION_KEY が、このデータベースを暗号化した鍵と違います。' : 'このデータベースは暗号化されています。DATA_ENCRYPTION_KEY を設定してください。');
    if (saved) return;
    const sealedAll = (table, row) => SEALED_COLUMNS[table].every(k => isSealed(row[k]));
    const hashed = value => /^[0-9a-f]{64}$/.test(value || '');
    const changed = await db.transaction(async tx => {
      let n = 0;
      for (const m of await tx.all('SELECT id, email, email_index, name, kana, phone, gender, birthday FROM members')) {
        if (m.email_index && (!c.enabled || sealedAll('members', m))) continue;
        const plain = openRow(c, 'members', m), sealed = sealRow(c, 'members', plain);
        await tx.run('UPDATE members SET email=?, email_index=?, name=?, kana=?, phone=?, gender=?, birthday=? WHERE id=?', [sealed.email, c.blindIndex(plain.email), sealed.name, sealed.kana, sealed.phone, sealed.gender, sealed.birthday, m.id]);
        n++;
      }
      if (!c.enabled) return n;
      for (const a of await tx.all('SELECT id, name, postal, address, phone FROM member_addresses')) {
        if (sealedAll('member_addresses', a)) continue;
        const sealed = sealRow(c, 'member_addresses', a);
        await tx.run('UPDATE member_addresses SET name=?, postal=?, address=?, phone=? WHERE id=?', [sealed.name, sealed.postal, sealed.address, sealed.phone, a.id]); n++;
      }
      for (const o of await tx.all('SELECT id, fingerprint, ship_name, ship_postal, ship_address, ship_phone, ship_email, return_reason FROM orders')) {
        if (sealedAll('orders', o) && hashed(o.fingerprint)) continue;
        const sealed = sealRow(c, 'orders', o);
        await tx.run('UPDATE orders SET fingerprint=?, ship_name=?, ship_postal=?, ship_address=?, ship_phone=?, ship_email=?, return_reason=? WHERE id=?', [hashed(o.fingerprint) ? o.fingerprint : c.digest(o.fingerprint), sealed.ship_name, sealed.ship_postal, sealed.ship_address, sealed.ship_phone, sealed.ship_email, sealed.return_reason, o.id]); n++;
      }
      await tx.run("INSERT INTO app_meta (meta_key, meta_value) VALUES ('encryption_check', ?)", [check]);
      return n;
    });
    // 暗号化前の値がファイルの空き領域に残らないよう、SQLite のファイルを詰め直す
    if (changed && c.enabled && db.dialect === 'sqlite') { await db.exec('VACUUM'); await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  }

  return {
    // テーブル作成・旧データの移行・初期データ投入。
    // 版が最新なら表の作成・変更（DDL）を行わない。本番ではアプリ用のDBユーザーにDDLの権限を与えず、
    // 版の更新は表を変更できるユーザーで `npm run db:migrate` を実行して行う（db/grants.mysql.sql）。
    async init({ now = new Date().toISOString() } = {}) {
      if (await db.tableExists('app_meta') && (await db.get("SELECT meta_value FROM app_meta WHERE meta_key='schema_version'"))?.meta_value === SCHEMA_VERSION) {
        await sealExisting();
        return { imported: false };
      }
      let legacyState = null, legacyMembers = [], legacySessions = [];
      if (db.dialect === 'sqlite') {
        const rename = async (from, to, test) => { if (await db.tableExists(from) && test(await db.tableColumns(from)) && !(await db.tableExists(to))) await db.exec(`ALTER TABLE ${from} RENAME TO ${to}`); };
        await rename('members', 'legacy_members', cols => cols.includes('profile'));
        await rename('sessions', 'legacy_sessions', () => true);
        await rename('products', 'legacy_products', cols => !cols.includes('sku'));
        await rename('orders', 'legacy_orders', cols => cols.includes('payload'));
        await rename('platform_state', 'legacy_platform_state', () => true);
      }
      // 前の版で作ったテーブルへの列追加（卸価格・管理者のLINE ID・同意の記録・個人情報の暗号化）
      let addedWholesale = false;
      if (await db.tableExists('products') && !(await db.tableColumns('products')).includes('wholesale_price')) { await db.exec('ALTER TABLE products ADD COLUMN wholesale_price INT NOT NULL DEFAULT 0'); addedWholesale = true; }
      if (await db.tableExists('members') && (await db.tableColumns('members')).includes('email') && !(await db.tableColumns('members')).includes('privacy_version')) { await db.exec(`ALTER TABLE members ADD COLUMN privacy_version ${db.dialect === 'mysql' ? 'VARCHAR(20)' : 'TEXT'} NULL`); await db.exec(`ALTER TABLE members ADD COLUMN privacy_agreed_at ${db.dialect === 'mysql' ? 'VARCHAR(30)' : 'TEXT'} NULL`); }
      if (await db.tableExists('operators') && !(await db.tableColumns('operators')).includes('line_id')) await db.exec(db.dialect === 'mysql' ? 'ALTER TABLE operators ADD COLUMN line_id VARCHAR(100) NULL, ADD UNIQUE KEY operators_line_id (line_id)' : 'ALTER TABLE operators ADD COLUMN line_id TEXT');
      if (await db.tableExists('members') && (await db.tableColumns('members')).includes('email') && !(await db.tableColumns('members')).includes('email_index')) await widenForEncryption();
      // 版5：支払方法・お届け先の電話番号
      if (await db.tableExists('orders') && (await db.tableColumns('orders')).includes('ship_name') && !(await db.tableColumns('orders')).includes('payment_method')) await upgradeOrdersV5();
      const addColumn = async (table, column, sqliteType, mysqlType) => { if (await db.tableExists(table) && !(await db.tableColumns(table)).includes(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${db.dialect === 'mysql' ? mysqlType : sqliteType}`); };
      await addColumn('member_addresses', 'phone', "TEXT NOT NULL DEFAULT ''", "VARCHAR(256) NOT NULL DEFAULT '' AFTER address");
      // 版7：一覧の短い説明。初期商品には説明を入れ、以前の既定の写真のままなら作り直した写真に替える
      const addedSummary = await db.tableExists('products') && !(await db.tableColumns('products')).includes('summary');
      await addColumn('products', 'summary', "TEXT NOT NULL DEFAULT ''", "VARCHAR(200) NOT NULL DEFAULT '' AFTER size");
      if (addedSummary) for (const p of catalog) {
        await db.run("UPDATE products SET summary=? WHERE id=? AND summary=''", [p.summary || '', p.id]);
        const old = legacyImages(p.id); await db.run(`UPDATE products SET image=? WHERE id=? AND image IN (${old.map(() => '?').join(', ')})`, [p.image, p.id, ...old]);
      }
      await db.migrate();
      if (db.dialect === 'sqlite') await db.exec(APPEND_ONLY_SQLITE);
      if (addedWholesale) for (const p of await db.all('SELECT id, price FROM products')) await db.run('UPDATE products SET wholesale_price=? WHERE id=?', [wholesaleOf(num(p.price)), p.id]);
      await db.run("UPDATE app_meta SET meta_value=? WHERE meta_key='schema_version'", [SCHEMA_VERSION]);
      if (await db.get('SELECT id FROM salons LIMIT 1')) { await sealExisting(); return { imported: false }; }
      if (db.dialect === 'sqlite' && await db.tableExists('legacy_platform_state')) {
        const row = await db.get('SELECT payload FROM legacy_platform_state WHERE id=1');
        if (row) { legacyState = JSON.parse(row.payload); migrate(legacyState, catalog); }
        if (await db.tableExists('legacy_members')) legacyMembers = await db.all('SELECT * FROM legacy_members');
        if (await db.tableExists('legacy_sessions')) legacySessions = await db.all('SELECT * FROM legacy_sessions WHERE expires_at>?', [Date.now()]);
      }
      const state = legacyState || createPlatform(catalog, now);
      const operatorPassword = await passwordDigest(DEMO_OPERATOR_PASSWORD);
      const result = await db.transaction(async tx => {
        const counts = await importState(tx, state, { catalog, concernNames, legacyMembers, legacySessions, now, fieldCrypto: c });
        // デモ用の管理アカウント（本番では管理画面から個別のパスワードで作成する）
        for (const op of demoOperators) await tx.run('INSERT INTO operators (id, email, name, role, salon_id, dealer_id, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [op.id, op.email, op.name, op.role, op.salonId || null, op.dealerId || null, operatorPassword.salt, operatorPassword.hash, now]);
        await tx.run("INSERT INTO app_meta (meta_key, meta_value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
        return counts;
      });
      await sealExisting();
      return { imported: Boolean(legacyState), ...result };
    },
    // 保守ツール（scripts/customer-lookup.mjs）：会員番号で1件だけ復号して参照する。担当者名と目的を記録してから返す。
    async lookupMember(input, now = new Date().toISOString()) {
      const { ref, by, purpose } = lookupInput(input);
      const matches = (await db.all('SELECT id FROM members')).filter(r => memberRef(r.id) === ref);
      if (matches.length !== 1) fail('会員番号に該当する会員が見つかりません。', 404);
      const m = await memberRow(db, matches[0].id);
      await recordAccess(db, { actorId: `maintenance:${by}`, actorName: by, role: accessRoles.maintenance, salonId: m.salon_id || '', action: accessActions.lookup, target: accessTargets.member, count: 1, refs: ref, purpose, channel: accessChannels.maintenance }, now);
      const row = openRow(c, 'member_addresses', await db.get('SELECT name, postal, address FROM member_addresses WHERE member_id=? AND is_default=1', [m.id]));
      const address = row && { name: row.name, postal: row.postal, ...decodeAddress(row.address) };
      const { id, ...profile } = profileFrom(m);
      return { ref, ...profile, address: address || null, orders: num((await db.get('SELECT COUNT(*) AS n FROM orders WHERE member_id=?', [m.id])).n) };
    },
    fieldCrypto: c,
    // 変更を伴う処理は1つのトランザクションで行い、確定した場合だけ effects（通知の種類）を返す
    async request(route, method, input, actor = {}, now = new Date().toISOString(), effects = []) {
      if (method === 'GET' || READ_ONLY.has(route)) return handle(db, route, method, input, actor, now, []);
      if (route === '/admin/supply/run' && method === 'POST') { requireOperator(actor, ['admin']); return this.runDueSubscriptions(now, effects); }
      const run = async () => {
        const local = [];
        const result = await db.transaction(async tx => { const r = await handle(tx, route, method, input, actor, now, local); if (!quiet(route)) await tx.run("UPDATE counters SET value=value+1 WHERE name='revision'"); return r; });
        effects.push(...local);
        return result;
      };
      try { return await run(); }
      catch (error) {
        // 同じ注文番号の注文が同時に届いた場合（MySQL）：先に確定した注文を返す
        if (route === '/orders' && method === 'POST' && db.isUniqueViolation(error)) return run();
        throw error;
      }
    },
    // 期日を迎えた定期発注の作成（サーバーが一定間隔で呼ぶ）。作成した発注は effects に積む。
    async runDueSubscriptions(now = new Date().toISOString(), effects = []) {
      const local = [], result = await supply.runDue(now, local);
      if (local.length || result.failed.length) await db.run("UPDATE counters SET value=value+1 WHERE name='revision'");
      effects.push(...local);
      return result;
    },
    operatorsWithLine: salonId => supply.operatorsWithLine(salonId),
    async supplyForNotice(id) {
      const o = await db.get('SELECT id, salon_id, total, carrier, tracking, source FROM supply_orders WHERE id=?', [id]);
      return o && { id: o.id, salonId: o.salon_id, total: num(o.total), carrier: o.carrier, tracking: o.tracking, source: o.source };
    },
    async orderForNotice(orderId, purchaseOrderId) {
      const order = await db.get('SELECT id, member_id, total FROM orders WHERE id=?', [orderId]);
      const po = purchaseOrderId ? await db.get('SELECT carrier, tracking FROM purchase_orders WHERE id=?', [purchaseOrderId]) : null;
      return order && { id: order.id, memberId: order.member_id, total: num(order.total), carrier: po?.carrier, tracking: po?.tracking };
    },
    // 通知は (経路, 種類, 対象) ごとに1回だけ送る。既に記録があれば false
    async claimNotification(memberId, channel, kind, reference, now = new Date().toISOString()) {
      try { await db.run("INSERT INTO notifications (member_id, channel, kind, reference, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', '', ?, ?)", [memberId, channel, kind, reference, now, now]); return true; }
      catch (error) { if (db.isUniqueViolation(error)) return false; throw error; }
    },
    finishNotification: (channel, kind, reference, status, error = '', now = new Date().toISOString()) => db.run('UPDATE notifications SET status=?, error=?, updated_at=? WHERE channel=? AND kind=? AND reference=?', [status, String(error).slice(0, 300), now, channel, kind, reference]),
    newId: () => randomBytes(16).toString('hex'),
  };
}
