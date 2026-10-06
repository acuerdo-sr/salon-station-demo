// 加盟店からの仕入発注・発注提案・再注文・定期発注・月次請求・店販の取り分。ブラウザ版と DB版で同じ結果になることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators, includedTax } from '../dist/platform-core.js';
import { marginFor, nextRunOn, invoiceDueOn, supplySuggestions, addDays } from '../dist/supply-core.js';
import { engines } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z'; // 2026-10-06 12:00 JST
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };
const otherSalon = { operator: { id: 'salon-b', role: 'salon', salonId: 'atelier', name: 'atelier 担当' } };
const later = days => new Date(Date.parse(now) + days * 86400000).toISOString();
const stockOf = async (e, id) => (await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(p => p.id === id).stock;
const supplyOrder = (e, items, extra = {}, at = now, effects = []) => e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items, ...extra }, salonOp, at, effects);

test('pure rules: margins, schedule dates, invoice due dates and suggestions', () => {
  assert.deepEqual(marginFor({ id: 'x', name: 'x', price: 2860, cost: 1716, wholesalePrice: 1859 }, 5), { productId: 'x', name: 'x', price: 2860, cost: 1716, wholesalePrice: 1859, fee: 143, ecTake: 1001, storeTake: 1001, difference: 0 });
  assert.equal(marginFor({ id: 'x', name: 'x', price: 3000, cost: 1800, wholesalePrice: 2100 }, 10).difference, 1200 - 300 - 900);
  assert.equal(nextRunOn('2026-01-31', 'monthly'), '2026-02-28'); assert.equal(nextRunOn('2026-10-06', 'weekly'), '2026-10-13'); assert.equal(nextRunOn('2026-12-20', 'biweekly'), '2027-01-03');
  assert.equal(invoiceDueOn('2026-09'), '2026-10-31'); assert.equal(invoiceDueOn('2026-12'), '2027-01-31');
  const p = [{ id: 'a', name: 'A', enabled: true, stock: 3, wholesalePrice: 100 }];
  const history = [{ productId: 'a', orderedOn: '2026-09-01', quantity: 5 }, { productId: 'a', orderedOn: '2026-09-11', quantity: 4 }];
  assert.deepEqual(supplySuggestions(history, p, '2026-09-18'), []);
  assert.deepEqual(supplySuggestions(history, p, '2026-09-19').map(s => [s.quantity, s.averageDays, s.daysSince]), [[3, 10, 8]]);
  assert.deepEqual(supplySuggestions([history[0]], p, addDays('2026-09-01', 60)), []);
});

for (const [name, create] of engines(now)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });

  run('franchisee orders: wholesale prices stay internal, orders are idempotent, stock and fulfilment follow the rules', async e => {
    const customer = await e.member('c1');
    assert.ok((await e.call('/bootstrap', 'GET', undefined, customer)).products.every(p => p.wholesalePrice === undefined && p.cost === undefined));
    const ws = await e.call('/supply', 'GET', undefined, salonOp);
    assert.equal(ws.salon.id, 'lumiere'); assert.equal(ws.orders.length, 4); assert.equal(ws.subscriptions.length, 1); assert.ok(ws.issuer.registrationNumber.startsWith('T'));
    const repair = ws.products.find(p => p.id === 'treatment-repair');
    assert.equal(repair.wholesalePrice, 2288); assert.equal(repair.price, 3520);
    assert.deepEqual(ws.suggestions.map(s => [s.productId, s.quantity, s.averageDays]), [['shampoo-moist', 6, 14]]);
    await assert.rejects(e.call('/supply', 'GET', undefined, admin), /権限/); await assert.rejects(e.call('/supply', 'GET', undefined, sena), /権限/);
    const before = await stockOf(e, 'treatment-repair'), input = { requestKey: crypto.randomUUID(), items: [{ id: 'treatment-repair', quantity: 4, price: 2288 }], note: '講習会用' };
    const placed = [], o = await e.call('/supply/orders', 'POST', input, salonOp, now, placed);
    assert.equal(o.total, 2288 * 4 + 660); assert.equal(o.taxTotal, includedTax(o.total)); assert.equal(o.status, 'ordered'); assert.equal(o.billingMonth, '2026-10'); assert.equal(o.note, '講習会用'); assert.equal(o.shipTo.name, 'LUMIÈRE 表参道');
    assert.deepEqual(placed, [{ type: 'supply_placed', supplyOrderId: o.id, salonId: 'lumiere' }]);
    const replay = []; assert.equal((await e.call('/supply/orders', 'POST', input, salonOp, now, replay)).id, o.id); assert.deepEqual(replay, []);
    assert.equal(await stockOf(e, 'treatment-repair'), before - 4);
    await assert.rejects(supplyOrder(e, [{ id: 'treatment-repair', quantity: 1, price: 3520 }]), /卸価格/);
    await assert.rejects(supplyOrder(e, [{ id: 'oil-rich', quantity: 1, price: 2145 }]), /在庫/);
    await assert.rejects(supplyOrder(e, [{ id: 'treatment-repair', quantity: 1000, price: 2288 }]), /1〜999/);
    await assert.rejects(e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items: [{ id: 'treatment-repair', quantity: 1, price: 2288 }] }, sena), /権限/);
    const snap = await e.call('/admin/snapshot', 'GET', undefined, admin);
    assert.equal(snap.supplyOrders[0].id, o.id); assert.equal(snap.products.find(p => p.id === 'treatment-repair').wholesalePrice, 2288);
    assert.deepEqual((await e.call('/admin/snapshot', 'GET', undefined, sena)).supplyOrders, []);
    assert.ok((await e.call('/admin/snapshot', 'GET', undefined, otherSalon)).supplyOrders.every(x => x.salonId === 'atelier'));
    await assert.rejects(e.call('/supply/orders/' + o.id + '/cancel', 'POST', {}, otherSalon), /他店舗/);
    const move = async (status, effects = []) => { await e.call('/admin/supply-orders/' + o.id, 'PATCH', { status, carrier: 'デモ配送', tracking: 'W-1' }, admin, now, effects); return effects; };
    await assert.rejects(move('shipped'), /順に/); await assert.rejects(e.call('/admin/supply-orders/' + o.id, 'PATCH', { status: 'accepted' }, salonOp), /権限/);
    await move('accepted');
    await assert.rejects(e.call('/supply/orders/' + o.id + '/cancel', 'POST', {}, salonOp), /受け付けた後/);
    assert.deepEqual(await move('shipped'), [{ type: 'supply_shipped', supplyOrderId: o.id, salonId: 'lumiere' }]);
    assert.deepEqual(await move('shipped'), []);
    await move('delivered');
    const done = (await e.call('/supply', 'GET', undefined, salonOp)).orders.find(x => x.id === o.id);
    assert.equal(done.status, 'delivered'); assert.equal(done.tracking, 'W-1'); assert.ok(done.deliveredAt);
    const c = await supplyOrder(e, [{ id: 'oil-smooth', quantity: 3, price: 1716 }]), oilBefore = await stockOf(e, 'oil-smooth');
    assert.equal((await e.call('/supply/orders/' + c.id + '/cancel', 'POST', {}, salonOp)).status, 'cancelled');
    await e.call('/supply/orders/' + c.id + '/cancel', 'POST', {}, salonOp);
    assert.equal(await stockOf(e, 'oil-smooth'), oilBefore + 3);
    await assert.rejects(e.call('/admin/supply-orders/' + c.id, 'PATCH', { status: 'accepted' }, admin), /キャンセル済み/);
  });

  run('reorder and suggestion orders keep their source; a fresh order clears the suggestion', async e => {
    const r = await supplyOrder(e, [{ id: 'shampoo-moist', quantity: 6, price: 1859 }], { source: 'suggestion' });
    assert.equal(r.source, 'suggestion');
    assert.equal((await supplyOrder(e, [{ id: 'oil-smooth', quantity: 1, price: 1716 }], { source: 'reorder' })).source, 'reorder');
    assert.equal((await supplyOrder(e, [{ id: 'oil-smooth', quantity: 1, price: 1716 }], { source: 'subscription' })).source, 'manual');
    assert.deepEqual((await e.call('/supply', 'GET', undefined, salonOp)).suggestions, []);
    // 14日後：2週間ごとのシャンプーと、4週間ごとのトリートメント（前回 9/22）が提案される
    assert.deepEqual((await e.call('/supply', 'GET', undefined, salonOp, later(14))).suggestions.map(s => s.productId).sort(), ['shampoo-moist', 'treatment-repair']);
  });

  run('recurring orders: validated, created once per due date, catch up, record failures, pause and resume', async e => {
    const today = '2026-10-06';
    await assert.rejects(e.call('/supply/subscriptions', 'POST', { interval: 'daily', startOn: today, items: [{ id: 'shampoo-air', quantity: 2 }] }, salonOp), /間隔/);
    await assert.rejects(e.call('/supply/subscriptions', 'POST', { interval: 'weekly', startOn: '2026-10-01', items: [{ id: 'shampoo-air', quantity: 2 }] }, salonOp), /今日以降/);
    await assert.rejects(e.call('/supply/subscriptions', 'POST', { interval: 'weekly', startOn: today, items: [] }, salonOp), /商品/);
    const sub = await e.call('/supply/subscriptions', 'POST', { interval: 'biweekly', startOn: today, items: [{ id: 'shampoo-air', quantity: 2 }] }, salonOp);
    assert.equal(sub.nextRunOn, today); assert.equal(sub.active, true);
    await assert.rejects(e.call('/admin/supply/run', 'POST', {}, salonOp), /権限/);
    const effects = [], first = await e.call('/admin/supply/run', 'POST', {}, admin, now, effects);
    assert.equal(first.created.length, 1); assert.equal(effects[0].type, 'supply_placed');
    let ws = await e.call('/supply', 'GET', undefined, salonOp);
    const created = ws.orders.find(o => o.id === first.created[0]);
    assert.equal(created.source, 'subscription'); assert.equal(created.items[0].quantity, 2); assert.equal(created.subscriptionId, sub.id);
    assert.equal(ws.subscriptions.find(s => s.id === sub.id).nextRunOn, '2026-10-20');
    assert.deepEqual((await e.call('/admin/supply/run', 'POST', {}, admin)).created, []);
    // 30日後：期日を過ぎた分は1件だけ作り、次回は未来の日付へ進める（サンプルの毎週の定期発注も実行される）
    const caught = await e.call('/admin/supply/run', 'POST', {}, admin, later(30));
    assert.equal(caught.created.length, 2);
    ws = await e.call('/supply', 'GET', undefined, salonOp, later(30));
    assert.equal(ws.subscriptions.find(s => s.id === sub.id).nextRunOn, '2026-11-17');
    // 在庫が足りないと作成せず、結果を残して次回へ進める
    await e.call('/admin/products/shampoo-air', 'PATCH', { stock: 1, price: 2640, cost: 1584, enabled: true }, admin);
    const failed = await e.call('/admin/supply/run', 'POST', {}, admin, later(42));
    assert.equal(failed.failed.length, 1); assert.match(failed.failed[0].message, /在庫/);
    const after = (await e.call('/supply', 'GET', undefined, salonOp, later(42))).subscriptions.find(s => s.id === sub.id);
    assert.match(after.lastResult, /作成できませんでした/); assert.equal(after.nextRunOn, '2026-12-01');
    // 停止中は作成しない。再開すると次回は今日から
    assert.equal((await e.call('/supply/subscriptions/' + sub.id, 'PATCH', { active: false }, salonOp)).active, false);
    await assert.rejects(e.call('/supply/subscriptions/' + sub.id, 'PATCH', { active: true }, otherSalon), /他店舗/);
    assert.deepEqual((await e.call('/admin/supply/run', 'POST', {}, admin, later(70))).created.filter(id => (ws.orders.find(o => o.id === id)?.subscriptionId) === sub.id), []);
    const resumed = await e.call('/supply/subscriptions/' + sub.id, 'PATCH', { active: true }, salonOp, later(70));
    assert.equal(resumed.nextRunOn, '2026-12-15');
  });

  run('monthly invoices: only finished months, one per salon, qualified-invoice totals, paid status, invoiced orders locked', async e => {
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-10' }, admin), /月が終わってから/);
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-13' }, admin), /YYYY-MM/);
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, salonOp), /権限/);
    const september = (await e.call('/supply', 'GET', undefined, salonOp)).orders.filter(o => o.billingMonth === '2026-09');
    assert.equal(september.length, 3);
    const closed = await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, admin);
    assert.equal(closed.created.length, 1);
    const inv = closed.created[0], total = september.reduce((s, o) => s + o.total, 0);
    assert.equal(inv.id, 'INV-202609-lumiere'); assert.equal(inv.orderCount, 3); assert.equal(inv.total, total); assert.equal(inv.taxTotal, includedTax(total)); assert.equal(inv.dueOn, '2026-10-31'); assert.equal(inv.status, 'issued');
    assert.deepEqual((await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, admin)).created, []);
    const detail = await e.call('/supply/invoices/' + inv.id, 'GET', undefined, salonOp);
    assert.equal(detail.orders.length, 3); assert.equal(detail.billTo.name, 'ルミエール株式会社（架空）'); assert.ok(detail.issuer.registrationNumber); assert.equal(typeof detail.ecProceeds, 'number');
    assert.equal(detail.orders.reduce((s, o) => s + o.total, 0), total);
    await assert.rejects(e.call('/supply/invoices/' + inv.id, 'GET', undefined, otherSalon), /他店舗/);
    await assert.rejects(e.call('/supply/invoices/' + inv.id, 'GET', undefined, sena), /権限/);
    assert.ok((await e.call('/supply', 'GET', undefined, salonOp)).orders.filter(o => o.billingMonth === '2026-09').every(o => o.invoiceId === inv.id));
    await assert.rejects(e.call('/admin/invoices/' + inv.id, 'PATCH', { status: 'paid' }, salonOp), /権限/);
    const paid = await e.call('/admin/invoices/' + inv.id, 'PATCH', { status: 'paid' }, admin, later(3));
    assert.equal(paid.status, 'paid'); assert.ok(paid.paidAt);
    // 10月の発注は11月に締める。請求済みの発注はキャンセルできない
    const october = await supplyOrder(e, [{ id: 'shampoo-air', quantity: 2, price: 1716 }], {}, '2026-10-20T03:00:00.000Z');
    const nov = await e.call('/admin/invoices/close', 'POST', { month: '2026-10' }, admin, '2026-11-02T03:00:00.000Z');
    assert.equal(nov.created[0].orderCount, 1); assert.equal(nov.created[0].total, october.total);
    await assert.rejects(e.call('/supply/orders/' + october.id + '/cancel', 'POST', {}, salonOp), /請求書を発行済み/);
    const listed = (await e.call('/admin/snapshot', 'GET', undefined, admin)).invoices.map(i => i.id).sort();
    assert.deepEqual(listed, ['INV-202609-lumiere', 'INV-202610-lumiere']);
  });

  run('admin sets the wholesale price; dealers cannot', async e => {
    assert.equal((await e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, price: 2860, cost: 1716, wholesalePrice: 2000, enabled: true }, admin)).wholesalePrice, 2000);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, price: 2860, cost: 1716, wholesalePrice: 3000, enabled: true }, admin), /卸価格は売価以下/);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, wholesalePrice: 1 }, sena), /在庫数のみ/);
    assert.equal((await e.call('/supply', 'GET', undefined, salonOp)).products.find(p => p.id === 'shampoo-moist').wholesalePrice, 2000);
    await assert.rejects(supplyOrder(e, [{ id: 'shampoo-moist', quantity: 1, price: 1859 }]), /卸価格/);
  });
}
