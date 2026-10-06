// DB版の業務ロジック（ローカル版・本番用）。画面とのやり取りの形はブラウザ版（dist/platform-core.js）と同じで、
// 入力検証・送料・状態遷移・精算などの規則は platform-core.js の関数を共有する。
import { randomBytes } from 'node:crypto';
import {
  fail, required, int, salonInput, staffList, salesUnits, salesRange, jst, includedTax, shippingFor, orderFingerprint, requestKeyOf,
  orderCustomer, newOrderId, purchaseOrderId, feeOf, PO_TRANSITIONS, orderStatusFrom, validateTracking, cartInput, favoritesInput,
  settlement, requireOperator, allowedOrder, statuses, poStatuses, createPlatform, migrate, demoOperators, DEMO_OPERATOR_PASSWORD,
} from '../dist/platform-core.js';
import { passwordDigest } from '../dist/member-store.js';
import { importState } from './import-state.mjs';

const bool = value => Boolean(Number(value));
const num = value => Number(value || 0);
const marks = list => list.map(() => '?').join(',');
const paymentLabels = { captured: 'テスト決済完了', refunded: 'テスト返金完了' };
// 変更を伴わない処理と、全画面の再読み込みを促さない処理（カート・お気に入り）
const READ_ONLY = new Set(['/quote', '/admin/sales']);
const QUIET = new Set(['/cart', '/favorites']);
const SNAPSHOT_LIMIT = 1000;

export function createPlatformStore(db, { catalog, concernNames = [] }) {
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
    return rows.map(r => ({ id: r.id, brand: r.brand, name: r.name, category: r.category_name, concerns: concerns.filter(c => c.product_id === r.id).map(c => c.name), size: r.size, price: num(r.price), stock: num(r.stock), image: r.image, tag: r.tag, description: r.description, sku: r.sku, enabled: bool(r.enabled), dealerId: r.dealer_id, ...(withCost ? { cost: num(r.cost) } : {}) }));
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
    const r = o.row;
    const view = {
      id: r.id, createdAt: r.created_at, memberId: r.member_id, salonId: r.salon_id, salonName: r.salon_name, seller: r.seller, staffId: r.staff_id, staffName: r.staff_name,
      customer: { name: r.ship_name, address: r.ship_address, postal: r.ship_postal, email: r.ship_email },
      items: o.items.map(i => itemFrom(i, admin)), subtotal: num(r.subtotal), shipping: num(r.shipping), total: num(r.total), taxTotal: num(r.tax_total),
      status: r.status, payment: paymentLabels[r.payment_status] || r.payment_status, timeline: o.events.map(e => ({ at: e.occurred_at, label: e.label })),
      shipments: o.pos.map(p => ({ id: p.id, dealerId: p.dealer_id, dealerName: dealers.find(d => d.id === p.dealer_id)?.name, status: p.status, carrier: p.carrier, tracking: p.tracking, shippedAt: p.shipped_at || undefined, items: o.items.filter(i => i.purchase_order_id === p.id).map(i => ({ id: i.product_id, name: i.name, quantity: num(i.quantity) })) })),
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
  const actorName = actor => actor?.name || '会員';
  const audit = (q, actor, action, reference, now) => q.run('INSERT INTO audit_logs (occurred_at, actor, action, reference) VALUES (?, ?, ?, ?)', [now, actorName(actor), action, reference]);
  const event = (q, orderId, label, now) => q.run('INSERT INTO order_events (order_id, occurred_at, label) VALUES (?, ?, ?)', [orderId, now, label]);
  const memberRow = (q, id) => q.get('SELECT * FROM members WHERE id=?', [id]);

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
    const key = requestKeyOf(input), fingerprint = orderFingerprint(input);
    const old = await q.get('SELECT id, member_id, fingerprint FROM orders WHERE request_key=?', [key]);
    if (old) { if (old.member_id !== member.id) fail('この注文は取得できません。', 403); if (old.fingerprint !== fingerprint) fail('同じ注文番号で内容を変更できません。カートを確認してください。', 409); return old.id; }
    const m = await memberRow(q, member.id);
    if (!m?.salon_id || m.salon_id !== input.salonId) fail('マイページでご利用サロンを確認してください。', 409);
    const customer = orderCustomer(input, m);
    const qt = await quote(q, input), salon = await salonById(q, input.salonId);
    const staff = m.staff_id ? salon.staff.find(s => s.id === m.staff_id) : null;
    let id = newOrderId(now);
    while (await q.get('SELECT id FROM orders WHERE id=?', [id])) id = newOrderId(now);
    // 在庫は「足りる場合だけ減らす」条件付き更新で確保する（同時注文でも売り越さない）。
    // 商品IDの順に更新し、MySQL で複数商品の同時注文がデッドロックしないようにする。
    for (const item of [...qt.items].sort((a, b) => a.id.localeCompare(b.id))) {
      const r = await q.run('UPDATE products SET stock=stock-?, updated_at=? WHERE id=? AND enabled=1 AND stock>=?', [item.quantity, now, item.id, item.quantity]);
      if (r.changes !== 1) fail(`${item.name}の在庫が不足しています。`, 409);
      await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'order', ?, ?, ?)", [item.id, -item.quantity, id, member.name, now]);
    }
    await q.run(`INSERT INTO orders (id, request_key, fingerprint, member_id, salon_id, salon_name, seller, staff_id, staff_name, fee_rate, fee, subtotal, shipping, total, tax_total,
      status, payment_status, ship_name, ship_postal, ship_address, ship_email, return_reason, stock_restored, is_sample, ordered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', 'captured', ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?)`,
    [id, key, fingerprint, m.id, salon.id, salon.name, salon.owner, staff?.id || '', staff?.name || '指名なし', salon.feeRate, feeOf(qt.subtotal, salon.feeRate), qt.subtotal, qt.shipping, qt.total, includedTax(qt.total),
      customer.name, customer.postal, customer.address, customer.email, jst(now).slice(0, 10), now, now]);
    const dealers = [...new Set(qt.items.map(i => i.dealerId))];
    for (const [index, dealerId] of dealers.entries()) {
      const items = qt.items.filter(i => i.dealerId === dealerId), shipping = index === 0 ? qt.shipping : 0, poId = purchaseOrderId(id, index);
      await q.run("INSERT INTO purchase_orders (id, order_id, dealer_id, salon_id, seq, status, shipping, total, carrier, tracking, shipped_at, delivered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, '', '', NULL, NULL, ?, ?)",
        [poId, id, dealerId, salon.id, index + 1, shipping, items.reduce((s, i) => s + i.cost * i.quantity, 0) + shipping, now, now]);
      for (const item of items) await q.run('INSERT INTO order_items (order_id, purchase_order_id, line_no, product_id, sku, name, size, image, unit_price, unit_cost, quantity, tax_rate, dealer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10, ?)',
        [id, poId, qt.items.indexOf(item) + 1, item.id, item.sku, item.name, item.size, item.image, item.price, item.cost, item.quantity, dealerId]);
    }
    await event(q, id, 'ご注文・テスト決済完了', now);
    await event(q, id, 'ディーラーへ自動発注しました', now);
    await q.run("INSERT INTO payments (order_id, provider, provider_payment_id, amount, status, created_at, updated_at) VALUES (?, 'test', ?, ?, 'captured', ?, ?)", [id, `test_${id}`, qt.total, now, now]);
    await q.run('DELETE FROM cart_items WHERE member_id=?', [m.id]);
    // 次回の注文画面に出すお届け先（住所管理）
    const address = await q.get('SELECT id FROM member_addresses WHERE member_id=? AND is_default=1', [m.id]);
    if (address) await q.run('UPDATE member_addresses SET name=?, postal=?, address=?, updated_at=? WHERE id=?', [customer.name, customer.postal, customer.address, now, address.id]);
    else await q.run('INSERT INTO member_addresses (member_id, name, postal, address, is_default, updated_at) VALUES (?, ?, ?, ?, 1, ?)', [m.id, customer.name, customer.postal, customer.address, now]);
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
  async function refundPayment(q, order, reason, now) {
    await q.run("UPDATE payments SET status='refunded', updated_at=? WHERE order_id=?", [now, order.id]);
    await q.run('INSERT INTO refunds (order_id, amount, reason, created_at) VALUES (?, ?, ?, ?)', [order.id, order.total, reason, now]);
  }

  // ---- 管理画面
  async function snapshot(q, actor) {
    const op = requireOperator(actor);
    const scope = op.role === 'admin' ? ['', []] : op.role === 'salon' ? ['salon_id=?', [op.salonId]] : ['1=0', []];
    const dealers = await loadDealers(q, op.role === 'dealer' ? op.dealerId : null), allDealers = await loadDealers(q);
    const orders = await loadOrders(q, scope[0], scope[1], SNAPSHOT_LIMIT);
    const poScope = op.role === 'admin' ? ['', []] : op.role === 'salon' ? ['WHERE po.salon_id=?', [op.salonId]] : ['WHERE po.dealer_id=?', [op.dealerId]];
    const poRows = await q.all(`SELECT po.*, o.salon_name, o.ship_name, o.ship_postal, o.ship_address, o.ship_email FROM purchase_orders po JOIN orders o ON o.id=po.order_id ${poScope[0]} ORDER BY po.created_at DESC, po.id DESC LIMIT ${SNAPSHOT_LIMIT}`, poScope[1]);
    const poItems = poRows.length ? await q.all(`SELECT * FROM order_items WHERE purchase_order_id IN (${marks(poRows)}) ORDER BY line_no`, poRows.map(p => p.id)) : [];
    const salonIds = op.role === 'admin' ? undefined : op.role === 'salon' ? [op.salonId] : [...new Set(poRows.map(p => p.salon_id))];
    const memberScope = op.role === 'admin' ? ['salon_id IS NOT NULL', []] : op.role === 'salon' ? ['salon_id=?', [op.salonId]] : null;
    const members = memberScope ? await q.all(`SELECT * FROM members WHERE ${memberScope[0]} ORDER BY salon_linked_at, id`, memberScope[1]) : [];
    const views = orders.map(o => orderView(o, allDealers, true));
    return {
      operator: op, revision: await revision(q),
      products: await loadProducts(q, { dealerId: op.role === 'dealer' ? op.dealerId : undefined, withCost: true }),
      salons: await loadSalons(q, { ids: salonIds }), dealers,
      orders: views,
      purchaseOrders: poRows.map(p => ({ ...poView(p, poItems.filter(i => i.purchase_order_id === p.id)), salonName: p.salon_name, customer: { name: p.ship_name, address: p.ship_address, postal: p.ship_postal, email: p.ship_email } })),
      profiles: members.map(profileFrom),
      settlements: views.map(o => settlement(o)),
      events: op.role === 'admin' ? (await q.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 400')).map(e => ({ id: String(e.id), at: e.occurred_at, actor: e.actor, action: e.action, reference: e.reference })) : [],
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
    if (route === '/bootstrap' && method === 'GET') return { closed: true, products: actor.member || actor.operator ? await loadProducts(q, { enabledOnly: true }) : [], salons: (await loadSalons(q, { enabledOnly: true })).map(({ feeRate, notes, ...s }) => s), dealers: await loadDealers(q), revision: await revision(q) };
    if (route === '/profile' && method === 'GET') {
      if (!actor.member) return null;
      const m = await memberRow(q, actor.member.id); if (!m?.salon_id) return null;
      const salon = await q.get('SELECT name, enabled FROM salons WHERE id=?', [m.salon_id]);
      const address = await q.get('SELECT name, postal, address FROM member_addresses WHERE member_id=? AND is_default=1', [m.id]);
      return { ...profileFrom(m), salonName: salon?.name || '', salonEnabled: bool(salon?.enabled), address: address || null };
    }
    if (route === '/profile' && method === 'PATCH') {
      if (!actor.member) fail('会員ログインが必要です。', 401);
      const salon = await salonById(q, input?.salonId), m = await memberRow(q, actor.member.id);
      if (!m) fail('会員ログインが必要です。', 401);
      if (m.salon_id && m.salon_id !== salon.id) fail('担当サロンの変更は、ご利用のサロンまたは運営本部にご依頼ください。', 403);
      if (!m.salon_id && !salon.enabled) fail('このサロンは現在ご利用いただけません。');
      if (input.staffId && !salon.staff.some(s => s.id === input.staffId)) fail('担当スタッフを確認してください。');
      await q.run('UPDATE members SET salon_id=?, staff_id=?, salon_linked_at=?, updated_at=? WHERE id=?', [salon.id, input.staffId || null, m.salon_linked_at || now, now, m.id]);
      await audit(q, actor.member, '会員サロン情報を保存', m.id, now);
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
        await q.run("UPDATE orders SET status='cancelled', payment_status='refunded', updated_at=? WHERE id=?", [now, order.id]);
        await restoreStock(q, order.id, 'cancel', by, now);
        await q.run("UPDATE purchase_orders SET status='cancelled', updated_at=? WHERE order_id=?", [now, order.id]);
        await refundPayment(q, order, 'キャンセル', now);
        await event(q, order.id, '注文キャンセル・テスト返金完了', now);
        await audit(q, by, '注文をキャンセル', order.id, now);
      } else {
        if (order.status === 'return_requested') return orderById(q, order.id);
        if (!['shipped', 'delivered'].includes(order.status)) fail('全商品の出荷後に返品を申請できます。', 409);
        const reason = required(input?.reason, 300);
        await q.run("UPDATE orders SET status='return_requested', return_reason=?, updated_at=? WHERE id=?", [reason, now, order.id]);
        await event(q, order.id, '返品を受け付けました', now);
        await audit(q, by, '返品申請', order.id, now);
      }
      return orderById(q, order.id);
    }
    if (route === '/admin/snapshot' && method === 'GET') return snapshot(q, actor);
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
      const all = await q.all('SELECT status FROM purchase_orders WHERE order_id=?', [order.id]);
      await q.run('UPDATE orders SET status=?, updated_at=? WHERE id=?', [orderStatusFrom(all.map(p => p.status)), now, order.id]);
      const dealer = await q.get('SELECT short_name FROM dealers WHERE id=?', [po.dealer_id]);
      await event(q, order.id, `${dealer.short_name}：${poStatuses[input.status]}`, now);
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
      await q.run("UPDATE orders SET status='returned', payment_status='refunded', updated_at=? WHERE id=?", [now, order.id]);
      await restoreStock(q, order.id, 'return', op, now);
      await q.run("UPDATE purchase_orders SET status='returned', updated_at=? WHERE order_id=?", [now, order.id]);
      await refundPayment(q, order, order.return_reason || '返品', now);
      await event(q, order.id, '返品検品・テスト返金が完了しました', now);
      await audit(q, op, '返品検品・返金完了', order.id, now);
      return orderById(q, order.id);
    }
    const productAction = route.match(/^\/admin\/products\/([^/]+)$/);
    if (productAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin', 'dealer']);
      const [p] = await loadProducts(q, { ids: [productAction[1]], withCost: true }); if (!p) fail('商品が見つかりません。', 404);
      if (op.role === 'dealer' && p.dealerId !== op.dealerId) fail('他社の商品は操作できません。', 403);
      const update = { stock: int(input?.stock, 0, 99999), price: p.price, cost: p.cost, enabled: p.enabled };
      if (op.role === 'admin') { update.price = int(input.price, 1, 1000000); update.cost = int(input.cost, 0, 1000000); if (update.cost > update.price) fail('このデモでは仕入単価を売価以下に設定してください。'); if (typeof input.enabled !== 'boolean') fail('公開設定を確認してください。'); update.enabled = input.enabled; }
      else if (['price', 'cost', 'enabled'].some(k => input[k] !== undefined)) fail('ディーラーは在庫数のみ更新できます。', 403);
      await q.run('UPDATE products SET stock=?, price=?, cost=?, enabled=?, updated_at=? WHERE id=?', [update.stock, update.price, update.cost, update.enabled ? 1 : 0, now, p.id]);
      if (update.stock !== p.stock) await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'adjust', '', ?, ?)", [p.id, update.stock - p.stock, op.name, now]);
      await audit(q, op, '商品・在庫を更新', p.sku, now);
      return (await loadProducts(q, { ids: [p.id], withCost: true }))[0];
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
      await q.run('DELETE FROM salons WHERE id=?', [salon.id]);
      await audit(q, op, '店舗を削除', salon.id, now);
      return { deleted: salon.id };
    }
    const memberAction = route.match(/^\/admin\/members\/([^/]+)$/);
    if (memberAction && method === 'PATCH') {
      const op = requireOperator(actor, ['admin']);
      const m = await memberRow(q, memberAction[1]); if (!m?.salon_id) fail('会員が見つかりません。', 404);
      const salon = await salonById(q, input?.salonId);
      if (!salon.enabled && salon.id !== m.salon_id) fail('受付を停止しているサロンには紐付けできません。', 409);
      if (input?.staffId && !salon.staff.some(s => s.id === input.staffId)) fail('担当スタッフを確認してください。');
      await q.run('UPDATE members SET salon_id=?, staff_id=?, updated_at=? WHERE id=?', [salon.id, input?.staffId || null, now, m.id]);
      await audit(q, op, '会員の担当店舗を変更', m.id, now);
      return profileFrom(await memberRow(q, m.id));
    }
    fail('この操作は利用できません。', 404);
  }

  return {
    // テーブル作成・旧データの移行・初期データ投入
    async init({ now = new Date().toISOString() } = {}) {
      let legacyState = null, legacyMembers = [], legacySessions = [];
      if (db.dialect === 'sqlite') {
        const rename = async (from, to, test) => { if (await db.tableExists(from) && test(await db.tableColumns(from)) && !(await db.tableExists(to))) await db.exec(`ALTER TABLE ${from} RENAME TO ${to}`); };
        await rename('members', 'legacy_members', cols => cols.includes('profile'));
        await rename('sessions', 'legacy_sessions', () => true);
        await rename('products', 'legacy_products', cols => !cols.includes('sku'));
        await rename('orders', 'legacy_orders', cols => cols.includes('payload'));
        await rename('platform_state', 'legacy_platform_state', () => true);
      }
      await db.migrate();
      if (await db.get('SELECT id FROM salons LIMIT 1')) return { imported: false };
      if (db.dialect === 'sqlite' && await db.tableExists('legacy_platform_state')) {
        const row = await db.get('SELECT payload FROM legacy_platform_state WHERE id=1');
        if (row) { legacyState = JSON.parse(row.payload); migrate(legacyState, catalog); }
        if (await db.tableExists('legacy_members')) legacyMembers = await db.all('SELECT * FROM legacy_members');
        if (await db.tableExists('legacy_sessions')) legacySessions = await db.all('SELECT * FROM legacy_sessions WHERE expires_at>?', [Date.now()]);
      }
      const state = legacyState || createPlatform(catalog, now);
      const operatorPassword = await passwordDigest(DEMO_OPERATOR_PASSWORD);
      const result = await db.transaction(async tx => {
        const counts = await importState(tx, state, { catalog, concernNames, legacyMembers, legacySessions, now });
        // デモ用の管理アカウント（本番では管理画面から個別のパスワードで作成する）
        for (const op of demoOperators) await tx.run('INSERT INTO operators (id, email, name, role, salon_id, dealer_id, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [op.id, op.email, op.name, op.role, op.salonId || null, op.dealerId || null, operatorPassword.salt, operatorPassword.hash, now]);
        await tx.run("INSERT INTO app_meta (meta_key, meta_value) VALUES ('schema_version', '1')");
        return counts;
      });
      return { imported: Boolean(legacyState), ...result };
    },
    // 変更を伴う処理は1つのトランザクションで行い、確定した場合だけ effects（通知の種類）を返す
    async request(route, method, input, actor = {}, now = new Date().toISOString(), effects = []) {
      if (method === 'GET' || READ_ONLY.has(route)) return handle(db, route, method, input, actor, now, []);
      const run = async () => {
        const local = [];
        const result = await db.transaction(async tx => { const r = await handle(tx, route, method, input, actor, now, local); if (!QUIET.has(route)) await tx.run("UPDATE counters SET value=value+1 WHERE name='revision'"); return r; });
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
