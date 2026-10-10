// DB版：加盟店からの仕入発注・定期発注・発注提案・月次請求。応答の形はブラウザ版（dist/supply-core.js）と同じ。
import { fail, optional, requireOperator, jst, includedTax, requestKeyOf, validateTracking } from '../dist/platform-core.js';
import {
  supplyStatuses, SUPPLY_TRANSITIONS, supplyIntervals, ISSUER, supplyOrderId, subscriptionId, invoiceId, invoiceDueOn, salonAddress,
  nextRunOn, addDays, supplyLines, supplyTotals, supplySource, subscriptionInput, closableMonth, supplySuggestions, ecSummary, monthBefore, supplyFavoritesInput,
} from '../dist/supply-core.js';

const num = value => Number(value || 0);
const marks = list => list.map(() => '?').join(',');

// customerStats：店舗ごとの会員の集計（db/platform-store.mjs）。発注画面の「店販EC」で使う。
export function createSupplyStore({ db, loadProducts, audit, customerStats }) {
  const supplyView = (r, items) => ({
    id: r.id, salonId: r.salon_id, salonName: r.ship_name, operatorId: r.operator_id, operatorName: r.operator_name, source: r.source, subscriptionId: r.subscription_id || null, status: r.status,
    items: items.map(i => ({ id: i.product_id, sku: i.sku, name: i.name, size: i.size, image: i.image, unitPrice: num(i.unit_price), quantity: num(i.quantity), amount: num(i.unit_price) * num(i.quantity) })),
    subtotal: num(r.subtotal), shipping: num(r.shipping), total: num(r.total), taxTotal: num(r.tax_total), shipTo: { name: r.ship_name, address: r.ship_address }, note: r.note,
    carrier: r.carrier, tracking: r.tracking, shippedAt: r.shipped_at || '', deliveredAt: r.delivered_at || '', billingMonth: r.billing_month, invoiceId: r.invoice_id || '', orderedOn: r.ordered_on, createdAt: r.created_at, feeRate: num(r.fee_rate), stockRestored: Boolean(num(r.stock_restored)),
  });
  async function loadSupplyOrders(q, where, params, limit) {
    const rows = await q.all(`SELECT * FROM supply_orders${where ? ' WHERE ' + where : ''} ORDER BY created_at DESC, id DESC${limit ? ` LIMIT ${Number(limit)}` : ''}`, params);
    if (!rows.length) return [];
    const items = await q.all(`SELECT * FROM supply_order_items WHERE supply_order_id IN (${marks(rows)}) ORDER BY supply_order_id, line_no`, rows.map(r => r.id));
    return rows.map(r => supplyView(r, items.filter(i => i.supply_order_id === r.id)));
  }
  const supplyById = async (q, id) => (await loadSupplyOrders(q, 'id=?', [id]))[0];
  async function loadSubscriptions(q, where, params) {
    const rows = await q.all(`SELECT * FROM supply_subscriptions${where ? ' WHERE ' + where : ''} ORDER BY created_at DESC, id DESC`, params);
    if (!rows.length) return [];
    const items = await q.all(`SELECT * FROM supply_subscription_items WHERE subscription_id IN (${marks(rows)}) ORDER BY subscription_id, line_no`, rows.map(r => r.id));
    return rows.map(r => ({ id: r.id, salonId: r.salon_id, operatorId: r.operator_id, interval: r.interval_code, items: items.filter(i => i.subscription_id === r.id).map(i => ({ id: i.product_id, quantity: num(i.quantity) })), nextRunOn: r.next_run_on, active: Boolean(num(r.active)), lastRunOn: r.last_run_on, lastResult: r.last_result, createdAt: r.created_at }));
  }
  const invoiceView = r => ({ id: r.id, salonId: r.salon_id, salonName: r.salon_name, billTo: { name: r.bill_to_name, address: r.bill_to_address }, month: r.billing_month, issuedOn: r.issued_on, dueOn: r.due_on, orderCount: num(r.order_count), subtotal: num(r.subtotal), taxTotal: num(r.tax_total), total: num(r.total), status: r.status, paidAt: r.paid_at || '', createdAt: r.created_at });
  const loadInvoices = async (q, where, params) => (await q.all(`SELECT * FROM invoices${where ? ' WHERE ' + where : ''} ORDER BY billing_month DESC, salon_id`, params)).map(invoiceView);
  function ownSalon(actor, salonId) { const op = requireOperator(actor, ['admin', 'salon']); if (op.role === 'salon' && op.salonId !== salonId) fail('他店舗の発注は操作できません。', 403); return op; }
  const supplyProducts = async q => (await loadProducts(q, { withCost: true }));

  async function placeSupply(q, { key, lines, note = '', source = 'manual', subscriptionId: subId = null }, op, salonId, now, effects) {
    const old = await q.get('SELECT id, salon_id FROM supply_orders WHERE request_key=?', [key]);
    if (old) { if (old.salon_id !== salonId) fail('この発注は取得できません。', 403); return old.id; }
    const salon = await q.get('SELECT * FROM salons WHERE id=?', [salonId]) || fail('サロンが見つかりません。', 404);
    const items = lines(await supplyProducts(q));
    let id = supplyOrderId(now);
    while (await q.get('SELECT id FROM supply_orders WHERE id=?', [id])) id = supplyOrderId(now);
    for (const l of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const r = await q.run('UPDATE products SET stock=stock-?, updated_at=? WHERE id=? AND enabled=1 AND stock>=?', [l.quantity, now, l.id, l.quantity]);
      if (r.changes !== 1) fail(`${l.name}の在庫が不足しています。`, 409);
      await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'order', ?, ?, ?)", [l.id, -l.quantity, id, op.name, now]);
    }
    const t = supplyTotals(items);
    await q.run(`INSERT INTO supply_orders (id, request_key, salon_id, operator_id, operator_name, source, subscription_id, status, subtotal, shipping, total, tax_total,
      ship_name, ship_address, note, carrier, tracking, shipped_at, delivered_at, billing_month, invoice_id, stock_restored, fee_rate, ordered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ordered', ?, ?, ?, ?, ?, ?, ?, '', '', NULL, NULL, ?, NULL, 0, ?, ?, ?, ?)`,
    [id, key, salonId, op.id, op.name, source, subId, t.subtotal, t.shipping, t.total, t.taxTotal, salon.name, salonAddress(salon), note, jst(now).slice(0, 7), num(salon.fee_rate), jst(now).slice(0, 10), now, now]);
    for (const [i, l] of items.entries()) await q.run('INSERT INTO supply_order_items (supply_order_id, line_no, product_id, sku, name, size, image, unit_price, quantity, tax_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10)', [id, i + 1, l.id, l.sku, l.name, l.size, l.image, l.unitPrice, l.quantity]);
    await audit(q, op, source === 'subscription' ? '定期発注を作成' : '加盟店発注を受付', id, now);
    effects.push({ type: 'supply_placed', supplyOrderId: id, salonId });
    return id;
  }
  async function workspace(q, op, now) {
    const today = jst(now).slice(0, 10), salon = await q.get('SELECT * FROM salons WHERE id=?', [op.salonId]) || fail('サロンが見つかりません。', 404);
    const products = (await supplyProducts(q)).filter(p => p.enabled);
    const history = (await q.all("SELECT so.ordered_on, si.product_id, si.quantity FROM supply_order_items si JOIN supply_orders so ON so.id=si.supply_order_id WHERE so.salon_id=? AND so.status<>'cancelled' AND so.ordered_on>=?", [salon.id, addDays(today, -180)])).map(r => ({ productId: r.product_id, orderedOn: r.ordered_on, quantity: num(r.quantity) }));
    // 店販EC（今月・前月）。お客様の情報は渡さず、集計値だけを渡す（注文日は日本時間）
    const month = jst(now).slice(0, 7), from = `${monthBefore(month)}-01`, to = `${month}-31`, active = "o.status NOT IN ('cancelled','returned')";
    const sold = await q.all(`SELECT o.member_id, o.subtotal, o.fee, o.ordered_on, (SELECT COALESCE(SUM((i.unit_price-i.unit_wholesale)*i.quantity), 0) FROM order_items i WHERE i.order_id=o.id) AS share FROM orders o WHERE o.salon_id=? AND o.ordered_on>=? AND o.ordered_on<=? AND ${active}`, [salon.id, from, to]);
    const items = await q.all(`SELECT i.product_id, MAX(i.name) AS name, SUM(i.quantity) AS quantity, SUM(i.unit_price*i.quantity) AS sales FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.salon_id=? AND o.ordered_on>=? AND o.ordered_on<=? AND ${active} GROUP BY i.product_id`, [salon.id, `${month}-01`, to]);
    const [stats] = await customerStats(q, [{ id: salon.id, name: salon.name }], now);
    const shown = products.map(({ id, brand, name, category, size, image, sku, price, wholesalePrice, stock, tag, summary }) => ({ id, brand, name, category, size, image, sku, price, wholesalePrice, stock, tag: tag || '', summary: summary || '' }));
    const favorites = (await q.all('SELECT product_id FROM supply_favorites WHERE salon_id=? ORDER BY created_at, product_id', [salon.id])).map(r => r.product_id).filter(id => shown.some(p => p.id === id));
    const ec = ecSummary({ month, products: shown, members: { total: stats.members, newThisMonth: stats.newThisMonth, lineLinked: stats.lineLinked },
      orders: sold.map(o => ({ month: o.ordered_on.slice(0, 7), memberId: o.member_id, subtotal: num(o.subtotal), share: num(o.share) })),
      items: items.map(i => ({ productId: i.product_id, name: i.name, quantity: num(i.quantity), sales: num(i.sales) })) });
    return {
      salon: { id: salon.id, name: salon.name, address: salonAddress(salon), feeRate: num(salon.fee_rate) },
      products: shown, ec, favorites,
      orders: await loadSupplyOrders(q, 'salon_id=?', [salon.id], 50), subscriptions: await loadSubscriptions(q, 'salon_id=?', [salon.id]),
      suggestions: supplySuggestions(history, products, today), invoices: await loadInvoices(q, 'salon_id=?', [salon.id]), issuer: { ...ISSUER },
    };
  }
  async function ecProceeds(q, salonId, month) {
    const rows = await q.all("SELECT (SELECT COALESCE(SUM((i.unit_price-i.unit_wholesale)*i.quantity), 0) FROM order_items i WHERE i.order_id=o.id) AS share FROM orders o WHERE o.salon_id=? AND o.ordered_on>=? AND o.ordered_on<=? AND o.status NOT IN ('cancelled','returned')", [salonId, `${month}-01`, `${month}-31`]);
    return rows.reduce((s, r) => s + num(r.share), 0);
  }
  async function invoiceDetail(q, inv) {
    const orders = (await loadSupplyOrders(q, 'invoice_id=?', [inv.id])).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...inv, issuer: { ...ISSUER }, orders: orders.map(o => ({ id: o.id, orderedOn: o.orderedOn, items: o.items, subtotal: o.subtotal, shipping: o.shipping, total: o.total })), ecProceeds: await ecProceeds(q, inv.salonId, inv.month) };
  }
  async function runOne(sub, now, effects) {
    const today = jst(now).slice(0, 10), runOn = sub.next_run_on, local = [];
    let message;
    try {
      const id = await db.transaction(async tx => {
        const items = (await tx.all('SELECT product_id, quantity FROM supply_subscription_items WHERE subscription_id=? ORDER BY line_no', [sub.id])).map(i => ({ id: i.product_id, quantity: num(i.quantity) }));
        return placeSupply(tx, { key: `sub-${sub.id}-${runOn}`, lines: products => supplyLines({ items }, products, { checkPrice: false }), source: 'subscription', subscriptionId: sub.id, note: `定期発注（${supplyIntervals[sub.interval_code]}）` }, { id: sub.operator_id, name: '定期発注' }, sub.salon_id, now, local);
      });
      effects.push(...local); message = { ok: true, text: `${runOn}：${id} を作成しました`, id };
    } catch (error) { if (!error.status) throw error; message = { ok: false, text: `${runOn}：作成できませんでした（${error.message}）`, error: error.message }; }
    let next = nextRunOn(runOn, sub.interval_code); while (next <= today) next = nextRunOn(next, sub.interval_code);
    await db.run('UPDATE supply_subscriptions SET next_run_on=?, last_run_on=?, last_result=?, updated_at=? WHERE id=? AND next_run_on=?', [next, today, message.text, now, sub.id, runOn]);
    return message;
  }

  return {
    // 期日を迎えた定期発注を作成する。定期発注ごとに別のトランザクションで処理する（1件の在庫不足で他を止めない）。
    async runDue(now = new Date().toISOString(), effects = []) {
      const today = jst(now).slice(0, 10), result = { created: [], failed: [] };
      for (const sub of await db.all('SELECT * FROM supply_subscriptions WHERE active=1 AND next_run_on<=? ORDER BY next_run_on, id', [today])) {
        const m = await runOne(sub, now, effects);
        if (m.ok) result.created.push(m.id); else result.failed.push({ subscriptionId: sub.id, message: m.error });
      }
      return result;
    },
    loadOrders: (q, where, params, limit) => loadSupplyOrders(q, where, params, limit),
    operatorsWithLine: salonId => db.all('SELECT id, line_id FROM operators WHERE salon_id=? AND line_id IS NOT NULL', [salonId]),
    async snapshot(q, op) {
      // 管理会社（藤井企画）は状況の確認、ディーラー（F.I.Tソリューション）は受付・出荷・請求、加盟店は自店の分
      const scope = op.role === 'admin' || op.role === 'dealer' ? ['', []] : ['salon_id=?', [op.salonId]];
      return { supplyOrders: await loadSupplyOrders(q, scope[0], scope[1], 1000), subscriptions: await loadSubscriptions(q, scope[0], scope[1]), invoices: await loadInvoices(q, scope[0], scope[1]) };
    },
    // 該当しない経路では undefined を返す
    async handle(q, route, method, input, actor, now, effects) {
      const today = jst(now).slice(0, 10);
      if (route === '/supply' && method === 'GET') return workspace(q, requireOperator(actor, ['salon']), now);
      // 加盟店のお気に入り（いつもの商品）を入れ替える
      if (route === '/supply/favorites' && method === 'PUT') {
        const op = requireOperator(actor, ['salon']), enabled = (await supplyProducts(q)).filter(p => p.enabled), ids = supplyFavoritesInput(input, id => enabled.some(p => p.id === id));
        await q.run('DELETE FROM supply_favorites WHERE salon_id=?', [op.salonId]);
        for (const [i, productId] of ids.entries()) await q.run('INSERT INTO supply_favorites (salon_id, product_id, created_at) VALUES (?, ?, ?)', [op.salonId, productId, new Date(Date.parse(now) + i).toISOString()]);
        return { ids };
      }
      if (route === '/supply/orders' && method === 'POST') {
        const op = requireOperator(actor, ['salon']), key = requestKeyOf(input);
        return supplyById(q, await placeSupply(q, { key, lines: products => supplyLines(input, products), note: optional(input?.note, 200), source: supplySource(input?.source) }, op, op.salonId, now, effects));
      }
      const cancel = route.match(/^\/supply\/orders\/([^/]+)\/cancel$/);
      if (cancel && method === 'POST') {
        const order = await supplyById(q, cancel[1]) || fail('発注が見つかりません。', 404), op = ownSalon(actor, order.salonId);
        if (order.status === 'cancelled') return order;
        if (order.status !== 'ordered') fail('本部が受け付けた後はキャンセルできません。本部にご連絡ください。', 409);
        if (order.invoiceId) fail('請求書を発行済みの発注はキャンセルできません。', 409);
        await q.run("UPDATE supply_orders SET status='cancelled', stock_restored=1, updated_at=? WHERE id=?", [now, order.id]);
        if (!order.stockRestored) for (const l of order.items) {
          await q.run('UPDATE products SET stock=stock+?, updated_at=? WHERE id=?', [l.quantity, now, l.id]);
          await q.run("INSERT INTO stock_movements (product_id, delta, reason, reference, actor, occurred_at) VALUES (?, ?, 'cancel', ?, ?, ?)", [l.id, l.quantity, order.id, op.name, now]);
        }
        await audit(q, op, '加盟店発注をキャンセル', order.id, now);
        return supplyById(q, order.id);
      }
      if (route === '/supply/subscriptions' && method === 'POST') {
        const op = requireOperator(actor, ['salon']), s = subscriptionInput(input, await supplyProducts(q), today), id = subscriptionId();
        await q.run('INSERT INTO supply_subscriptions (id, salon_id, operator_id, interval_code, next_run_on, active, last_run_on, last_result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, \'\', \'\', ?, ?)', [id, op.salonId, op.id, s.interval, s.startOn, now, now]);
        for (const [i, item] of s.items.entries()) await q.run('INSERT INTO supply_subscription_items (subscription_id, product_id, quantity, line_no) VALUES (?, ?, ?, ?)', [id, item.id, item.quantity, i]);
        await audit(q, op, '定期発注を登録', id, now);
        return (await loadSubscriptions(q, 'id=?', [id]))[0];
      }
      const subAction = route.match(/^\/supply\/subscriptions\/([^/]+)$/);
      if (subAction && method === 'PATCH') {
        const [sub] = await loadSubscriptions(q, 'id=?', [subAction[1]]); if (!sub) fail('定期発注が見つかりません。', 404);
        const op = ownSalon(actor, sub.salonId);
        if (typeof input?.active !== 'boolean') fail('定期発注の状態を確認してください。');
        await q.run('UPDATE supply_subscriptions SET active=?, next_run_on=?, updated_at=? WHERE id=?', [input.active ? 1 : 0, input.active && sub.nextRunOn < today ? today : sub.nextRunOn, now, sub.id]);
        await audit(q, op, input.active ? '定期発注を再開' : '定期発注を停止', sub.id, now);
        return (await loadSubscriptions(q, 'id=?', [sub.id]))[0];
      }
      const invoice = route.match(/^\/supply\/invoices\/([^/]+)$/);
      if (invoice && method === 'GET') {
        const [inv] = await loadInvoices(q, 'id=?', [invoice[1]]); if (!inv) fail('請求書が見つかりません。', 404);
        ownSalon(actor, inv.salonId);
        return invoiceDetail(q, inv);
      }
      const ship = route.match(/^\/admin\/supply-orders\/([^/]+)$/);
      if (ship && method === 'PATCH') {
        const op = requireOperator(actor, ['dealer']), order = await supplyById(q, ship[1]) || fail('発注が見つかりません。', 404);
        if (order.status === 'cancelled') fail('キャンセル済みの発注です。', 409);
        if (input?.status === order.status) return order;
        if (SUPPLY_TRANSITIONS[order.status] !== input?.status) fail('受付 → 出荷 → 配達完了の順に操作してください。', 409);
        if (input.status === 'shipped') {
          const { tracking, carrier } = validateTracking(input);
          await q.run("UPDATE supply_orders SET status='shipped', tracking=?, carrier=?, shipped_at=?, updated_at=? WHERE id=?", [tracking, carrier, now, now, order.id]);
          effects.push({ type: 'supply_shipped', supplyOrderId: order.id, salonId: order.salonId });
        } else await q.run(`UPDATE supply_orders SET status=?, ${input.status === 'delivered' ? 'delivered_at=?, ' : ''}updated_at=? WHERE id=?`, input.status === 'delivered' ? [input.status, now, now, order.id] : [input.status, now, order.id]);
        await audit(q, op, `加盟店発注：${supplyStatuses[input.status]}`, order.id, now);
        return supplyById(q, order.id);
      }
      if (route === '/admin/invoices/close' && method === 'POST') {
        const op = requireOperator(actor, ['dealer']), month = closableMonth(input, now), created = [];
        for (const salon of await q.all('SELECT * FROM salons ORDER BY created_at, id')) {
          if (await q.get('SELECT id FROM invoices WHERE salon_id=? AND billing_month=?', [salon.id, month])) continue;
          const orders = await q.all("SELECT id, total FROM supply_orders WHERE salon_id=? AND billing_month=? AND status<>'cancelled' AND invoice_id IS NULL ORDER BY created_at", [salon.id, month]);
          if (!orders.length) continue;
          const total = orders.reduce((s, o) => s + num(o.total), 0), id = invoiceId(month, salon.id);
          await q.run(`INSERT INTO invoices (id, salon_id, billing_month, bill_to_name, bill_to_address, salon_name, issued_on, due_on, order_count, subtotal, tax_total, total, status, paid_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, ?, ?)`, [id, salon.id, month, salon.owner, salonAddress(salon), salon.name, today, invoiceDueOn(month), orders.length, total, includedTax(total), total, now, now]);
          await q.run(`UPDATE supply_orders SET invoice_id=?, updated_at=? WHERE id IN (${marks(orders)})`, [id, now, ...orders.map(o => o.id)]);
          created.push((await loadInvoices(q, 'id=?', [id]))[0]);
        }
        await audit(q, op, `${month} 分を締めて請求書を発行（${created.length}件）`, month, now);
        return { month, created };
      }
      const paid = route.match(/^\/admin\/invoices\/([^/]+)$/);
      if (paid && method === 'PATCH') {
        const op = requireOperator(actor, ['dealer']), [inv] = await loadInvoices(q, 'id=?', [paid[1]]);
        if (!inv) fail('請求書が見つかりません。', 404);
        if (input?.status !== 'paid') fail('入金済みにする操作だけができます。');
        if (inv.status !== 'paid') { await q.run("UPDATE invoices SET status='paid', paid_at=?, updated_at=? WHERE id=?", [now, now, inv.id]); await audit(q, op, '請求書を入金済みに更新', inv.id, now); }
        return (await loadInvoices(q, 'id=?', [inv.id]))[0];
      }
      return undefined;
    },
  };
}
