// 業務ルールの共通テスト。ブラウザ版（dist/platform-core.js の state）と DB版（db/platform-store.mjs）に同じシナリオを流し、
// 同じ結果になることを確認する。TEST_MYSQL_URL=mysql://… を指定すると MySQL 8.0 でも実行する（データベースは空にして使う）。
import { products as catalogProducts } from '../catalog.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { formatAddress } from '../dist/person.js';
import { engines as createEngines, linkMember } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z';
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] }, botanica = { operator: demoOperators[3] };
const customer = { name: 'デモ 花子', postal: '0000000', prefecture: '東京都', city: '架空市', street: '1-2-3', phone: '0300000000' };
customer.address = formatAddress(customer);
// ブラウザ版・SQLite（・MySQL）の作り方は helpers/engines.mjs に共通化（DB版は個人情報を暗号化して保存）
const engines = createEngines(now);
const line = (id, quantity, price) => ({ id, quantity, price });
const order = (e, actor, items, at = now, salonId = 'lumiere', effects = []) => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId, items, customer }, actor, at, effects);
const stockOf = async (e, id) => (await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(p => p.id === id).stock;
async function linked(e, id, salonId = 'lumiere', staffId = 'haruka') { const actor = await e.member(id); await linkMember(e.call, actor, salonId, staffId); return actor; }

for (const [name, create] of engines) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });

  run('closed store: guests see no products; members and operators see the catalogue with concerns', async e => {
    const guest = await e.call('/bootstrap', 'GET', undefined, {});
    assert.equal(guest.closed, true); assert.deepEqual(guest.products, []); assert.ok(guest.salons.length >= 3); assert.equal(guest.salons[0].feeRate, undefined); assert.equal(guest.salons[0].notes, undefined);
    assert.deepEqual(guest.salons.map(s => s.id), ['lumiere', 'atelier', 'mori']);
    const a = await linked(e, 'a');
    const boot = await e.call('/bootstrap', 'GET', undefined, a);
    assert.equal(boot.products.length, catalogProducts.length); assert.equal(boot.products[0].cost, undefined);
    assert.deepEqual(boot.products.find(p => p.id === 'shampoo-moist').concerns, ['ダメージヘア対策', 'カラーケア']);
    assert.equal(boot.salons.find(s => s.id === 'lumiere').staff.map(s => s.name).join(), 'HARUKA,YUI');
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(p => p.id === 'shampoo-moist').cost, 1716);
    await assert.rejects(e.call('/quote', 'POST', { salonId: 'lumiere', items: [line('shampoo-moist', 1, 2860)] }, {}), /ログイン/);
  });

  run('salon link: first link sets the salon; members cannot choose staff, their salon sets it; the admin re-links and cannot use paused salons', async e => {
    const a = await linked(e, 'a');
    const p = await e.call('/profile', 'GET', undefined, a);
    assert.equal(p.salonId, 'lumiere'); assert.equal(p.staffId, 'haruka'); assert.equal(p.salonName, 'LUMIÈRE 表参道'); assert.equal(p.salonEnabled, true);
    await assert.rejects(e.call('/profile', 'PATCH', { salonId: 'atelier', staffId: '' }, a), /運営本部/);
    await assert.rejects(e.call('/profile', 'PATCH', { salonId: 'lumiere', staffId: 'yui' }, a), /サロンで設定/);
    assert.equal((await e.call('/profile', 'PATCH', { salonId: 'lumiere' }, a)).staffId, 'haruka', '保存し直しても担当はそのまま');
    assert.deepEqual(await e.call('/admin/members/a/staff', 'PATCH', { staffId: 'yui' }, salonOp), { ref: (await e.call('/admin/snapshot', 'GET', undefined, salonOp)).profiles.find(p => p.id === 'a').ref, staffId: 'yui', staffName: 'YUI' });
    await assert.rejects(e.call('/admin/members/a/staff', 'PATCH', { staffId: 'mio' }, salonOp), /担当スタッフ/, '他店のスタッフは選べない');
    await assert.rejects(e.call('/admin/members/a/staff', 'PATCH', { staffId: 'yui' }, sena), /権限/);
    assert.equal((await e.call('/admin/members/a', 'PATCH', { salonId: 'atelier', staffId: 'mio' }, admin)).salonId, 'atelier');
    await assert.rejects(e.call('/admin/members/a/staff', 'PATCH', { staffId: '' }, salonOp), /見つかりません/, '他店の会員は操作できない');
    await assert.rejects(e.call('/admin/members/a', 'PATCH', { salonId: 'atelier' }, salonOp), /権限/);
    await e.call('/admin/salons/mori', 'PATCH', { enabled: false }, admin);
    await assert.rejects(e.call('/admin/members/a', 'PATCH', { salonId: 'mori' }, admin), /受付を停止/);
    const b = await e.member('b');
    await assert.rejects(e.call('/profile', 'PATCH', { salonId: 'mori', staffId: '' }, b), /ご利用いただけません/);
  });

  run('order lifecycle: split purchase orders, idempotent replay, shipment effects, return and refund', async e => {
    const a = await linked(e, 'a'), b = await linked(e, 'b'), before = await stockOf(e, 'shampoo-moist');
    const input = { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: [line('shampoo-moist', 2, 2860), line('oil-smooth', 1, 2640)], customer };
    const placed = [], o = await e.call('/orders', 'POST', input, a, now, placed);
    assert.equal(o.total, 9020); assert.equal(o.subtotal, 8360); assert.equal(o.shipping, 660); assert.equal(o.staffName, 'HARUKA'); assert.equal(o.items[0].cost, undefined);
    assert.deepEqual(placed, [{ type: 'order_placed', orderId: o.id, memberId: 'a' }]);
    const replay = []; assert.equal((await e.call('/orders', 'POST', input, a, now, replay)).id, o.id); assert.deepEqual(replay, []);
    await assert.rejects(e.call('/orders', 'POST', { ...input, customer: { ...customer, name: '別名' } }, a), /内容を変更/);
    await assert.rejects(e.call('/orders', 'POST', input, b), /取得できません/);
    assert.equal(await stockOf(e, 'shampoo-moist'), before - 2);
    const snap = await e.call('/admin/snapshot', 'GET', undefined, admin), pos = snap.purchaseOrders.filter(p => p.orderId === o.id);
    assert.equal(pos.length, 2); assert.equal(snap.orders.find(x => x.id === o.id).fee, 418);
    const senaPo = pos.find(p => p.dealerId === 'sena'), botanicaPo = pos.find(p => p.dealerId === 'botanica');
    assert.equal(senaPo.total, 1716 * 2 + 660); assert.equal(botanicaPo.total, 1584);
    const move = async (actor, po, status, effects = []) => { await e.call('/admin/purchase-orders/' + po.id, 'PATCH', { status, carrier: 'デモ配送', tracking: 'DEMO-1' }, actor, now, effects); return effects; };
    await assert.rejects(move(sena, senaPo, 'shipped'), /順に/);
    await move(sena, senaPo, 'accepted');
    assert.deepEqual(await move(sena, senaPo, 'shipped'), [{ type: 'shipped', purchaseOrderId: senaPo.id, orderId: o.id, memberId: 'a' }]);
    assert.deepEqual(await move(sena, senaPo, 'shipped'), []);
    assert.equal((await e.call('/orders', 'GET', undefined, a))[0].status, 'partially_shipped');
    await assert.rejects(e.call('/orders/' + o.id + '/cancel', 'POST', {}, a), /出荷後/);
    await assert.rejects(move(sena, botanicaPo, 'accepted'), /他社/);
    await move(botanica, botanicaPo, 'accepted'); await move(botanica, botanicaPo, 'shipped');
    await move(sena, senaPo, 'delivered'); await move(botanica, botanicaPo, 'delivered');
    const mine = (await e.call('/orders', 'GET', undefined, a))[0];
    assert.equal(mine.status, 'delivered'); assert.ok(mine.shipments.every(s => s.tracking === 'DEMO-1')); assert.equal(mine.timeline.length, 7); assert.ok(mine.timeline.every(t => !/SENA|BOTANICA|ディーラー/.test(t.label)), 'お客様の履歴に仕入先を出さない'); assert.ok(mine.shipments.every(s => s.dealerId === undefined && s.dealerName === undefined));
    await assert.rejects(e.call('/orders/' + o.id + '/return', 'POST', { reason: '' }, a), /入力内容/);
    assert.equal((await e.call('/orders/' + o.id + '/return', 'POST', { reason: 'デモ：返品テスト' }, a)).status, 'return_requested');
    await assert.rejects(e.call('/admin/orders/' + o.id + '/refund', 'POST', {}, sena), /権限/);
    const refunded = await e.call('/admin/orders/' + o.id + '/refund', 'POST', {}, admin);
    assert.equal(refunded.status, 'returned'); assert.equal(refunded.payment, 'クレジットカード・返金済み'); assert.equal(refunded.paymentStatus, 'refunded');
    assert.equal((await e.call('/admin/orders/' + o.id + '/refund', 'POST', {}, admin)).status, 'returned');
    assert.equal(await stockOf(e, 'shampoo-moist'), before);
    const settlement = (await e.call('/admin/snapshot', 'GET', undefined, admin)).settlements.find(s => s.orderId === o.id);
    assert.equal(settlement.refunded, 9020); assert.equal(settlement.proceeds, 0);
  });

  run('cancellation restores stock once and blocks shipment', async e => {
    const a = await linked(e, 'a'), before = await stockOf(e, 'oil-smooth');
    const o = await order(e, a, [line('oil-smooth', 3, 2640)]);
    const cancelled = await e.call('/orders/' + o.id + '/cancel', 'POST', {}, a);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.payment, 'クレジットカード・返金済み'); assert.equal(cancelled.paymentStatus, 'refunded');
    await e.call('/orders/' + o.id + '/cancel', 'POST', {}, a);
    assert.equal(await stockOf(e, 'oil-smooth'), before);
    const po = (await e.call('/admin/snapshot', 'GET', undefined, admin)).purchaseOrders.find(p => p.orderId === o.id);
    assert.equal(po.status, 'cancelled');
    await assert.rejects(e.call('/admin/purchase-orders/' + po.id, 'PATCH', { status: 'accepted' }, admin), /変更できません/);
  });

  run('validation: bad quantities, stale prices, short stock and paused salons create nothing', async e => {
    const a = await linked(e, 'a');
    for (const quantity of [0, -1, 1.5, 100, '1']) await assert.rejects(order(e, a, [line('shampoo-moist', quantity, 2860)]));
    await assert.rejects(order(e, a, [line('shampoo-moist', 1, 1)]), /価格/);
    await assert.rejects(order(e, a, [line('shampoo-moist', 1, 2860), line('shampoo-moist', 1, 2860)]), /重複/);
    await assert.rejects(order(e, a, [line('oil-rich', 1, 3300)]), /在庫/);
    await assert.rejects(order(e, a, [line('shampoo-moist', 1, 2860)], now, 'atelier'), /ご利用サロン/);
    await e.call('/admin/salons/lumiere', 'PATCH', { enabled: false }, admin);
    await assert.rejects(order(e, a, [line('shampoo-moist', 1, 2860)]), /停止/);
    assert.deepEqual(await e.call('/orders', 'GET', undefined, a), []);
  });

  run('authorization: dealers and salons see only their own data', async e => {
    const a = await linked(e, 'a');
    await order(e, a, [line('shampoo-moist', 1, 2860), line('oil-smooth', 1, 2640)]);
    const d = await e.call('/admin/snapshot', 'GET', undefined, sena);
    assert.equal(d.orders.length, 0); assert.equal(d.profiles.length, 0); assert.deepEqual(d.events, []);
    assert.ok(d.purchaseOrders.length > 0 && d.purchaseOrders.every(p => p.dealerId === 'sena'));
    assert.ok(d.products.every(p => p.dealerId === 'sena')); assert.deepEqual(d.dealers.map(x => x.id), ['sena']);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 5, price: 1 }, sena), /在庫数のみ/);
    assert.equal((await e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 5 }, sena)).stock, 5);
    await assert.rejects(e.call('/admin/products/oil-smooth', 'PATCH', { stock: 5 }, sena), /他社/);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 5, price: 1, cost: 1, enabled: true }, salonOp), /権限/);
    const s = await e.call('/admin/snapshot', 'GET', undefined, salonOp);
    assert.ok(s.orders.every(o => o.salonId === 'lumiere')); assert.ok(s.profiles.every(p => p.salonId === 'lumiere')); assert.deepEqual(s.salons.map(x => x.id), ['lumiere']);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, { operator: { role: 'salon', salonId: 'atelier', name: 'x' } })).orders.filter(o => o.memberId === 'a').length, 0);
    await assert.rejects(e.call('/admin/snapshot', 'GET', undefined, {}), /ログイン/);
  });

  run('sales report: period buckets in Japan time, cancelled orders excluded, salon scope', async e => {
    const a = await linked(e, 'a'), b = await linked(e, 'b', 'atelier', 'mio');
    await order(e, a, [line('shampoo-moist', 2, 2860)], '2027-01-31T15:30:00.000Z'); // 2/1 0:30 JST
    await order(e, a, [line('oil-smooth', 1, 2640)], '2027-01-10T02:00:00.000Z');
    const c = await order(e, a, [line('oil-smooth', 1, 2640)], '2027-01-11T02:00:00.000Z'); await e.call('/orders/' + c.id + '/cancel', 'POST', {}, a);
    await order(e, b, [line('treatment-repair', 1, 3520)], '2027-01-20T02:00:00.000Z', 'atelier');
    const r = await e.call('/admin/sales', 'POST', { unit: 'month', from: '2027-01-01', to: '2027-02-28' }, admin);
    assert.deepEqual(r.rows.map(x => x.period), ['2027-01', '2027-02']);
    assert.deepEqual(r.total, { sales: 5720 + 2640 + 3520, orders: 3, customers: 2 });
    assert.equal(r.rows[0].salons.find(x => x.salonId === 'lumiere').sales, 2640);
    assert.equal(r.rows[1].total.sales, 5720);
    assert.deepEqual((await e.call('/admin/sales', 'POST', { unit: 'day', from: '2027-02-01', to: '2027-02-01' }, admin)).rows.map(x => x.period), ['2027-02-01']);
    const scoped = await e.call('/admin/sales', 'POST', { unit: 'range', from: '2027-01-01', to: '2027-02-28' }, salonOp);
    assert.deepEqual(scoped.salons.map(x => x.salonId), ['lumiere']); assert.equal(scoped.total.sales, 8360); assert.equal(scoped.rows[0].period, '2027-01-01〜2027-02-28');
    assert.deepEqual((await e.call('/admin/sales', 'POST', { unit: 'year', from: '2030-01-01', to: '2030-12-31' }, admin)).rows, []);
    await assert.rejects(e.call('/admin/sales', 'POST', {}, sena), /権限/);
  });

  run('salon master: auto-numbered IDs are never reused; salon staff edit only basic info; staff ids are kept', async e => {
    const input = { name: 'デモ店', owner: 'デモ株式会社（架空）', prefecture: '山口県', city: '萩市', street: '椿東1-1-1', phone: '0838-11-1111', staff: 'AKI, RIN', feeRate: 6 };
    await assert.rejects(e.call('/admin/salons', 'POST', input, salonOp), /権限/);
    await assert.rejects(e.call('/admin/salons', 'POST', { ...input, phone: '０８３８' }, admin), /電話番号/);
    const created = await e.call('/admin/salons', 'POST', input, admin);
    assert.equal(created.id, 'S004'); assert.deepEqual(created.staff.map(s => s.name), ['AKI', 'RIN']); assert.equal(created.feeRate, 6);
    assert.ok((await e.call('/bootstrap', 'GET', undefined, {})).salons.some(s => s.id === 'S004'));
    const edited = await e.call('/admin/salons/lumiere', 'PATCH', { name: 'LUMIÈRE 本店', hours: '11:00〜21:00' }, salonOp);
    assert.equal(edited.name, 'LUMIÈRE 本店'); assert.equal(edited.feeRate, 5);
    await assert.rejects(e.call('/admin/salons/lumiere', 'PATCH', { feeRate: 0 }, salonOp), /変更できません/);
    await assert.rejects(e.call('/admin/salons/atelier', 'PATCH', { name: 'x' }, salonOp), /他店舗/);
    const staffed = await e.call('/admin/salons/lumiere', 'PATCH', { staff: 'HARUKA, NEW' }, admin);
    assert.equal(staffed.staff.find(s => s.name === 'HARUKA').id, 'haruka'); assert.deepEqual(staffed.staff.map(s => s.name), ['HARUKA', 'NEW']);
    await assert.rejects(e.call('/admin/salons/lumiere', 'DELETE', {}, admin), /削除できません/);
    assert.deepEqual(await e.call('/admin/salons/S004', 'DELETE', {}, admin), { deleted: 'S004' });
    assert.equal((await e.call('/admin/salons', 'POST', input, admin)).id, 'S005');
    const events = (await e.call('/admin/snapshot', 'GET', undefined, admin)).events.map(x => x.action);
    assert.ok(events.includes('店舗を登録') && events.includes('店舗を削除'));
  });

  run('cart and favourites are kept per member and the cart empties after an order', async e => {
    const a = await linked(e, 'a');
    await assert.rejects(e.call('/cart', 'GET', undefined, {}), /ログイン/);
    assert.deepEqual((await e.call('/cart', 'PUT', { items: { 'shampoo-moist': 2, unknown: 1 } }, a)).items, { 'shampoo-moist': 2 });
    await assert.rejects(e.call('/cart', 'PUT', { items: { 'shampoo-moist': 100 } }, a), /1〜99/);
    assert.deepEqual((await e.call('/cart', 'GET', undefined, a)).items, { 'shampoo-moist': 2 });
    assert.deepEqual((await e.call('/favorites', 'PUT', { ids: ['oil-smooth', 'oil-smooth', 'nope'] }, a)).ids, ['oil-smooth']);
    assert.deepEqual((await e.call('/favorites', 'GET', undefined, a)).ids, ['oil-smooth']);
    const b = await linked(e, 'b');
    assert.deepEqual((await e.call('/cart', 'GET', undefined, b)).items, {});
    await order(e, a, [line('shampoo-moist', 2, 2860)]);
    assert.deepEqual((await e.call('/cart', 'GET', undefined, a)).items, {});
    assert.deepEqual((await e.call('/favorites', 'GET', undefined, a)).ids, ['oil-smooth']);
  });

  if (name !== 'browser') {
    run('database: concurrent orders for the last item sell it once; history tables record every change', async e => {
      const a = await linked(e, 'a'), b = await linked(e, 'b'), before = await stockOf(e, 'shampoo-moist');
      await e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 1, price: 2860, cost: 1716, enabled: true }, admin);
      const results = await Promise.allSettled([order(e, a, [line('shampoo-moist', 1, 2860)]), order(e, b, [line('shampoo-moist', 1, 2860)])]);
      assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(await stockOf(e, 'shampoo-moist'), 0);
      const moves = await e.db.all("SELECT delta, reason FROM stock_movements WHERE product_id='shampoo-moist' ORDER BY id");
      assert.deepEqual(moves.slice(-2).map(m => [Number(m.delta), m.reason]), [[1 - before, 'adjust'], [-1, 'order']]);
      const placed = results.find(r => r.status === 'fulfilled').value;
      assert.equal(Number((await e.db.get('SELECT tax_total FROM orders WHERE id=?', [placed.id])).tax_total), Math.floor(3520 * 10 / 110));
      assert.equal((await e.db.get('SELECT status FROM payments WHERE order_id=?', [placed.id])).status, 'captured');
      // お届け先は暗号化して保存される
      const stored = (await e.db.get("SELECT address FROM member_addresses WHERE member_id=?", [placed.memberId])).address;
      assert.match(stored, /^enc:v1:/); assert.deepEqual(JSON.parse(e.fieldCrypto.decrypt(stored)), { prefecture: '東京都', city: '架空市', street: '1-2-3', building: '' });
      assert.equal((await e.call('/profile', 'GET', undefined, placed.memberId === 'a' ? a : b)).address.postal, '0000000');
      assert.equal(await e.store.claimNotification('a', 'line', 'order_placed', placed.id), true);
      assert.equal(await e.store.claimNotification('a', 'line', 'order_placed', placed.id), false);
      const revision = (await e.call('/bootstrap', 'GET', undefined, {})).revision;
      await e.call('/cart', 'PUT', { items: {} }, a);
      assert.equal((await e.call('/bootstrap', 'GET', undefined, {})).revision, revision);
    });
  }
}
