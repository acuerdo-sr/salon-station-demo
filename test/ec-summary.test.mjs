// 発注画面の「店販EC」：その店舗で売れたEC注文の今月・前月の集計。
// 売上集計・精算と同じ数字になること、キャンセル・他店舗の注文を含めないこと、担当店舗の付け替え後も売れた店舗の実績のままであること、
// お客様の情報を含めないことを、ブラウザ版と DB版で確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators, jst } from '../dist/platform-core.js';
import { memberRef } from '../dist/privacy.js';
import { formatAddress } from '../dist/person.js';
import { ecSummary, monthBefore } from '../dist/supply-core.js';
import { engines } from './helpers/engines.mjs';

const now = '2026-10-20T03:00:00.000Z', lastMonth = '2026-09-15T03:00:00.000Z';
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };
const atelierOp = { operator: { id: 'salon-atelier', role: 'salon', salonId: 'atelier', name: 'atelier 凪 店舗担当' } };
const customer = { name: '個人 太郎', postal: '1234567', prefecture: '東京都', city: '秘密市', street: '9-8-7', phone: '09012345678' };
customer.address = formatAddress(customer);
const line = (id, quantity, price) => ({ id, quantity, price });
const order = (e, actor, items, salonId = 'lumiere', at = now) => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId, items, customer }, actor, at);
async function linked(e, id, salonId) { const actor = await e.member(id, customer.name); await e.call('/profile', 'PATCH', { salonId, staffId: '' }, actor); return actor; }
const ecOf = async (e, actor = salonOp) => (await e.call('/supply', 'GET', undefined, actor)).ec;

test('month helpers: the previous month wraps the year; no change rate without last month', () => {
  assert.equal(monthBefore('2026-10'), '2026-09'); assert.equal(monthBefore('2026-01'), '2025-12');
  const empty = ecSummary({ month: '2026-10', orders: [], items: [], products: [], members: { total: 0, newThisMonth: 0, lineLinked: 0 } });
  assert.equal(empty.change, null); assert.deepEqual(empty.current, { sales: 0, orders: 0, customers: 0, proceeds: 0 }); assert.deepEqual(empty.topProducts, []);
});

async function scenario(e) {
  const before = await ecOf(e);
  const taro = await linked(e, 'kojin-taro', 'lumiere'), hanako = await linked(e, 'kojin-hanako', 'atelier');
  await order(e, taro, [line('shampoo-moist', 2, 2860)], 'lumiere', lastMonth);
  await order(e, taro, [line('oil-smooth', 1, 2640), line('shampoo-moist', 1, 2860)]);
  const cancelled = await order(e, taro, [line('treatment-repair', 3, 3520)]);
  await e.call(`/orders/${cancelled.id}/cancel`, 'POST', {}, taro);
  await order(e, hanako, [line('oil-smooth', 4, 2640)], 'atelier');
  return { before, after: await ecOf(e), taro };
}

for (const [name, create] of engines(now)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });

  run('the order screen shows this salon\'s EC sales, take and best sellers, matching the sales report and settlements', async e => {
    const { before, after } = await scenario(e);
    assert.equal(after.month, '2026-10'); assert.equal(after.previousMonth, '2026-09');
    // 今月：シャンプー＋オイル（5,500円）だけが増える。キャンセルと他店舗の注文は含めない
    assert.equal(after.current.sales, before.current.sales + 5500);
    assert.equal(after.current.orders, before.current.orders + 1);
    assert.equal(after.current.customers, before.current.customers + 1);
    assert.equal(after.previous.sales, before.previous.sales + 5720);
    assert.equal(after.change, Math.round((after.current.sales - after.previous.sales) / after.previous.sales * 1000) / 10);
    // 売上集計（美容室）と同じ数字
    const report = await e.call('/admin/sales', 'POST', { unit: 'range', from: '2026-10-01', to: '2026-10-31' }, salonOp, now);
    assert.deepEqual({ sales: report.total.sales, orders: report.total.orders, customers: report.total.customers }, { sales: after.current.sales, orders: after.current.orders, customers: after.current.customers });
    // 取り分は精算（売価 − 卸価格）と同じ
    const settlements = (await e.call('/admin/snapshot', 'GET', undefined, salonOp, now)).settlements;
    const proceeds = month => settlements.filter(s => s.salonId === 'lumiere' && jst(s.at).slice(0, 7) === month).reduce((sum, s) => sum + s.proceeds, 0);
    assert.equal(after.current.proceeds, proceeds('2026-10')); assert.equal(after.previous.proceeds, proceeds('2026-09'));
    // よく売れている商品：点数の多い順に3つまで。キャンセルした商品は数えない
    const top = after.topProducts;
    assert.ok(top.length >= 2 && top.length <= 3);
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].quantity > top[i].quantity || (top[i - 1].quantity === top[i].quantity && top[i - 1].sales >= top[i].sales));
    assert.ok(!top.some(t => t.productId === 'treatment-repair' && t.quantity >= 3));
    assert.ok(top.find(t => t.productId === 'shampoo-moist').quantity >= 1);
    // 会員：今月この店舗に紐付いた2人目以降も数える（太郎）。他店舗の花子は含めない
    assert.equal(after.members.total, before.members.total + 1); assert.equal(after.members.newThisMonth, before.members.newThisMonth + 1);
  });

  run('no customer details reach the order screen; past sales stay with the salon that sold them after a re-link', async e => {
    const { after, taro } = await scenario(e);
    const text = JSON.stringify(after);
    for (const value of ['kojin-taro', memberRef(taro.member.id), customer.name, customer.address, customer.city, customer.postal, customer.phone, '@example.test']) assert.ok(!text.includes(value), value);
    const atelierBefore = await ecOf(e, atelierOp);
    await e.call(`/admin/members/${memberRef(taro.member.id)}`, 'PATCH', { salonId: 'atelier', staffId: '' }, admin, now);
    const lumiere = await ecOf(e), atelier = await ecOf(e, atelierOp);
    assert.deepEqual([lumiere.current, lumiere.previous], [after.current, after.previous], '売れたときの店舗の実績のまま');
    assert.deepEqual([atelier.current, atelier.previous], [atelierBefore.current, atelierBefore.previous]);
    assert.equal(lumiere.members.total, after.members.total - 1); assert.equal(atelier.members.total, atelierBefore.members.total + 1);
    // 発注画面は加盟店（美容室）だけ
    await assert.rejects(e.call('/supply', 'GET', undefined, admin), /権限/);
    await assert.rejects(e.call('/supply', 'GET', undefined, sena), /権限/);
  });
}

test('the browser demo and the database give the same EC summary', async () => {
  const results = [];
  for (const [name, create] of engines(now)) {
    const e = await create();
    try { await scenario(e); results.push([name, await ecOf(e)]); } finally { await e.close(); }
  }
  for (const [name, ec] of results.slice(1)) assert.deepEqual(ec, results[0][1], name);
});
