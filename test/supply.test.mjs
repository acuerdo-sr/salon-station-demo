// 加盟店からの仕入発注・発注提案・再注文・定期発注・月次請求・店販の取り分。ブラウザ版と DB版で同じ結果になることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators, includedTax } from '../dist/platform-core.js';
import { referralSummary, nextRunOn, invoiceDueOn, supplySuggestions, addDays } from '../dist/supply-core.js';
import { engines } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z'; // 2026-10-06 12:00 JST
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, dealer = { operator: demoOperators[2] }; // F.I.Tソリューション：加盟店の発注の受付・出荷と請求書の発行
const otherSalon = { operator: { id: 'salon-b', role: 'salon', salonId: 'atelier', name: 'atelier 担当' } };
const later = days => new Date(Date.parse(now) + days * 86400000).toISOString();
const stockOf = async (e, id) => (await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(p => p.id === id).stock;
const supplyOrder = (e, items, extra = {}, at = now, effects = []) => e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items, ...extra }, salonOp, at, effects);

test('pure rules: referral fees, schedule dates, invoice due dates and suggestions', () => {
  // 紹介料（F.I.Tソリューション → 藤井企画）：加盟店ごとに（EC売上＋仕入れ）× 注文時の率。美容室の取り分は売価−卸価格
  const r = referralSummary({ month: '2026-10', salons: [{ id: 's1', name: 'A', feeRate: 5 }, { id: 's2', name: 'B', feeRate: 8 }],
    orders: [{ salonId: 's1', status: 'delivered', subtotal: 2860, fee: 143, createdAt: '2026-10-05T01:00:00.000Z', items: [{ price: 2860, wholesalePrice: 1859, quantity: 1 }] },
      { salonId: 's1', status: 'cancelled', subtotal: 9999, fee: 500, createdAt: '2026-10-05T01:00:00.000Z', items: [] },
      { salonId: 's1', status: 'ordered', subtotal: 1000, fee: 50, createdAt: '2026-09-30T16:00:00.000Z', items: [{ price: 1000, wholesalePrice: 650, quantity: 1 }] }],
    supplyOrders: [{ salonId: 's1', status: 'delivered', subtotal: 20000, feeRate: 5, billingMonth: '2026-10' }, { salonId: 's2', status: 'ordered', subtotal: 10001, feeRate: 8, billingMonth: '2026-10' }, { salonId: 's2', status: 'cancelled', subtotal: 5000, feeRate: 8, billingMonth: '2026-10' }] });
  assert.deepEqual(r.rows.map(x => [x.salonId, x.ecSales, x.share, x.supplySales, x.ecFee, x.supplyFee, x.fee]), [['s1', 3860, 1001 + 350, 20000, 193, 1000, 1193], ['s2', 0, 0, 10001, 0, 800, 800]], '日本時間の10月1日 1:00 の注文は10月');
  assert.equal(r.total.fee, 1993);
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
    await assert.rejects(e.call('/supply', 'GET', undefined, admin), /権限/); await assert.rejects(e.call('/supply', 'GET', undefined, dealer), /権限/);
    const before = await stockOf(e, 'treatment-repair'), input = { requestKey: crypto.randomUUID(), items: [{ id: 'treatment-repair', quantity: 4, price: 2288 }], note: '講習会用' };
    const placed = [], o = await e.call('/supply/orders', 'POST', input, salonOp, now, placed);
    assert.equal(o.total, 2288 * 4 + 660); assert.equal(o.taxTotal, includedTax(o.total)); assert.equal(o.status, 'ordered'); assert.equal(o.billingMonth, '2026-10'); assert.equal(o.note, '講習会用'); assert.equal(o.shipTo.name, 'LUMIÈRE 表参道');
    assert.deepEqual(placed, [{ type: 'supply_placed', supplyOrderId: o.id, salonId: 'lumiere' }]);
    const replay = []; assert.equal((await e.call('/supply/orders', 'POST', input, salonOp, now, replay)).id, o.id); assert.deepEqual(replay, []);
    assert.equal(await stockOf(e, 'treatment-repair'), before - 4);
    await assert.rejects(supplyOrder(e, [{ id: 'treatment-repair', quantity: 1, price: 3520 }]), /卸価格/);
    await assert.rejects(supplyOrder(e, [{ id: 'oil-rich', quantity: 1, price: 2145 }]), /在庫/);
    await assert.rejects(supplyOrder(e, [{ id: 'treatment-repair', quantity: 1000, price: 2288 }]), /1〜999/);
    await assert.rejects(e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items: [{ id: 'treatment-repair', quantity: 1, price: 2288 }] }, dealer), /権限/);
    const snap = await e.call('/admin/snapshot', 'GET', undefined, admin);
    assert.equal(snap.supplyOrders[0].id, o.id); assert.equal(snap.products.find(p => p.id === 'treatment-repair').wholesalePrice, 2288);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, dealer)).supplyOrders[0].id, o.id, 'F.I.Tソリューションは加盟店の発注を受け付ける');
    assert.ok((await e.call('/admin/snapshot', 'GET', undefined, otherSalon)).supplyOrders.every(x => x.salonId === 'atelier'));
    await assert.rejects(e.call('/supply/orders/' + o.id + '/cancel', 'POST', {}, otherSalon), /他店舗/);
    const move = async (status, effects = []) => { await e.call('/admin/supply-orders/' + o.id, 'PATCH', { status, carrier: 'デモ配送', tracking: 'W-1' }, dealer, now, effects); return effects; };
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
    await assert.rejects(e.call('/admin/supply-orders/' + c.id, 'PATCH', { status: 'accepted' }, dealer), /キャンセル済み/);
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
    assert.deepEqual((await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, admin)).created.map(i => i.salonId), ['atelier'], 'LUMIÈRE は請求元が F.I.T なので、藤井企画の締めでは atelier 凪（請求元 藤井企画）だけ'); 
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-10' }, dealer), /月が終わってから/);
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-13' }, dealer), /YYYY-MM/);
    await assert.rejects(e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, salonOp), /権限/);
    const september = (await e.call('/supply', 'GET', undefined, salonOp)).orders.filter(o => o.billingMonth === '2026-09');
    assert.equal(september.length, 3);
    const closed = await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, dealer);
    assert.equal(closed.created.length, 1);
    const inv = closed.created[0], total = september.reduce((s, o) => s + o.total, 0);
    assert.equal(inv.id, 'INV-202609-lumiere'); assert.equal(inv.orderCount, 3); assert.equal(inv.total, total); assert.equal(inv.taxTotal, includedTax(total)); assert.equal(inv.dueOn, '2026-10-31'); assert.equal(inv.status, 'issued');
    assert.deepEqual((await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, dealer)).created, []);
    const detail = await e.call('/supply/invoices/' + inv.id, 'GET', undefined, salonOp);
    assert.equal(detail.orders.length, 3); assert.equal(detail.billTo.name, 'ルミエール株式会社（架空）'); assert.ok(detail.issuer.registrationNumber); assert.equal(typeof detail.ecProceeds, 'number');
    assert.equal(detail.orders.reduce((s, o) => s + o.total, 0), total);
    await assert.rejects(e.call('/supply/invoices/' + inv.id, 'GET', undefined, otherSalon), /他店舗/);
    assert.equal((await e.call('/supply/invoices/' + inv.id, 'GET', undefined, dealer)).id, inv.id, 'F.I.T は自分が請求元の請求書を見られる');
    assert.ok((await e.call('/supply', 'GET', undefined, salonOp)).orders.filter(o => o.billingMonth === '2026-09').every(o => o.invoiceId === inv.id));
    await assert.rejects(e.call('/admin/invoices/' + inv.id, 'PATCH', { status: 'paid' }, salonOp), /権限/);
    const paid = await e.call('/admin/invoices/' + inv.id, 'PATCH', { status: 'paid' }, dealer, later(3));
    assert.equal(paid.status, 'paid'); assert.ok(paid.paidAt);
    // 10月の発注は11月に締める。請求済みの発注はキャンセルできない
    const october = await supplyOrder(e, [{ id: 'shampoo-air', quantity: 2, price: 1716 }], {}, '2026-10-20T03:00:00.000Z');
    const nov = await e.call('/admin/invoices/close', 'POST', { month: '2026-10' }, dealer, '2026-11-02T03:00:00.000Z');
    assert.equal(nov.created[0].orderCount, 1); assert.equal(nov.created[0].total, october.total);
    await assert.rejects(e.call('/supply/orders/' + october.id + '/cancel', 'POST', {}, salonOp), /請求書を発行済み/);
    const listed = (await e.call('/admin/snapshot', 'GET', undefined, admin)).invoices.map(i => i.id).sort();
    assert.deepEqual(listed, ['INV-202609-atelier', 'INV-202609-lumiere', 'INV-202610-lumiere']);
  });

  run('billing party per salon is set by the management company: Fujii-billed purchases carry no purchase referral fee, and each party closes and collects its own invoices', async e => {
    // 加盟店・ディーラーは請求元と紹介料率を変えられない。値は確かめる
    await assert.rejects(e.call('/admin/salons/lumiere', 'PATCH', { supplyBiller: 'fujii' }, salonOp), /請求元/);
    await assert.rejects(e.call('/admin/salons/lumiere', 'PATCH', { supplyBiller: 'x' }, admin), /請求元/);
    await assert.rejects(e.call('/admin/salons/atelier', 'PATCH', { supplyBiller: 'fit' }, dealer), /権限/);
    const atelier = (await e.call('/admin/snapshot', 'GET', undefined, admin)).salons.find(x => x.id === 'atelier');
    assert.deepEqual([atelier.supplyBiller, atelier.feeRate, atelier.supplyFeeRate], ['fujii', 10, 15], 'デモの atelier 凪 は藤井企画から仕入れる');
    const order = (actor, at, quantity = 2) => e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items: [{ id: 'shampoo-moist', quantity, price: 1859 }] }, actor, at);
    const sep = '2026-09-10T03:00:00.000Z', refAt = '2026-09-25T03:00:00.000Z';
    // サンプルにも atelier 凪 の9月の仕入れ（請求元 藤井企画）がある。ここで足す分との差で確かめる
    const base = (await e.call('/admin/snapshot', 'GET', undefined, admin, refAt)).referrals.current.rows.find(r => r.salonId === 'atelier');
    assert.ok(base.fujiiSales > 0 && base.supplyFee === 0);
    const viaFujii = await order(otherSalon, sep), viaFit = await order(salonOp, sep);
    const pick = async id => (await e.call('/admin/snapshot', 'GET', undefined, admin, sep)).supplyOrders.find(o => o.id === id);
    const f = await pick(viaFujii.id), t = await pick(viaFit.id);
    assert.deepEqual([f.biller, f.feeRate, f.agencyTotal], ['fujii', 0, Math.round(2860 * 0.55) * 2], '藤井企画の仕入値（推定：売価の55%）で F.I.T が藤井企画へ請求');
    assert.deepEqual([t.biller, t.feeRate, t.agencyTotal], ['fit', 15, 0], '仕入れの紹介料率');
    // 月の途中で請求元を変えても、その月は同じ請求元（変更は、まだ仕入れのない次の月から）
    await e.call('/admin/salons/atelier', 'PATCH', { supplyBiller: 'fit' }, admin, sep);
    assert.equal((await pick((await order(otherSalon, '2026-09-20T03:00:00.000Z', 1)).id)).biller, 'fujii');
    const november = await pick((await order(otherSalon, '2026-11-02T03:00:00.000Z', 1)).id);
    assert.deepEqual([november.biller, november.feeRate], ['fit', 15]);
    // 紹介料の集計：藤井企画の仕入れは紹介料なし・藤井企画の粗利、F.I.T の仕入れは紹介料
    const ref = (await e.call('/admin/snapshot', 'GET', undefined, admin, refAt)).referrals.current;
    const ra = ref.rows.find(r => r.salonId === 'atelier'), rl = ref.rows.find(r => r.salonId === 'lumiere');
    assert.deepEqual([ra.fujiiSales - base.fujiiSales, ra.agencyTotal - base.agencyTotal, ra.fujiiMargin - base.fujiiMargin, ra.supplyFee], [1859 * 3, 1573 * 3, (1859 - 1573) * 3, 0]);
    assert.equal(ra.fujiiIncome, ra.fee + ra.fujiiMargin, '藤井企画の受け取り ＝ 紹介料 ＋ 仕入れの粗利');
    const lumiereSep = (await e.call('/admin/snapshot', 'GET', undefined, admin, sep)).supplyOrders.filter(o => o.salonId === 'lumiere' && o.billingMonth === '2026-09' && o.status !== 'cancelled');
    assert.equal(rl.supplyFee, lumiereSep.reduce((n, o) => n + Math.round(o.subtotal * o.feeRate / 100), 0), 'F.I.T が請求元の仕入れには、注文時の仕入れの紹介料率');
    // 締め：F.I.T は F.I.T が請求元の加盟店、藤井企画は藤井企画が請求元の加盟店
    const byDealer = (await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, dealer, '2026-10-03T03:00:00.000Z')).created;
    assert.ok(byDealer.some(i => i.salonId === 'lumiere') && !byDealer.some(i => i.salonId === 'atelier'));
    const byFujii = (await e.call('/admin/invoices/close', 'POST', { month: '2026-09' }, admin, '2026-10-03T03:00:00.000Z')).created;
    assert.deepEqual(byFujii.map(i => [i.salonId, i.biller, i.orderCount]), [['atelier', 'fujii', base.supplyOrders + 2]]);
    const detail = await e.call('/supply/invoices/' + byFujii[0].id, 'GET', undefined, otherSalon);
    assert.equal(detail.issuer.name, '藤井企画', '請求書の発行元は藤井企画');
    await assert.rejects(e.call('/supply/invoices/' + byFujii[0].id, 'GET', undefined, dealer), /藤井企画/, '藤井企画が加盟店へ出す請求書は F.I.T に見せない');
    const dealerList = (await e.call('/admin/snapshot', 'GET', undefined, dealer)).invoices;
    assert.ok(dealerList.length && dealerList.every(i => i.biller === 'fit'));
    assert.ok((await e.call('/admin/snapshot', 'GET', undefined, admin)).invoices.some(i => i.biller === 'fit'), '藤井企画はすべて見られる');
    await assert.rejects(e.call('/admin/invoices/' + byFujii[0].id, 'PATCH', { status: 'paid' }, dealer), /藤井企画/);
    assert.equal((await e.call('/admin/invoices/' + byFujii[0].id, 'PATCH', { status: 'paid' }, admin)).status, 'paid');
    await assert.rejects(e.call('/admin/invoices/' + byDealer[0].id, 'PATCH', { status: 'paid' }, admin), /F.I.T/);
  });

  run('admin sets the wholesale price; dealers cannot', async e => {
    assert.equal((await e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, price: 2860, cost: 1716, wholesalePrice: 2000, enabled: true }, admin)).wholesalePrice, 2000);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, price: 2860, cost: 1716, wholesalePrice: 3000, enabled: true }, admin), /卸価格は売価以下/);
    await assert.rejects(e.call('/admin/products/shampoo-moist', 'PATCH', { stock: 20, wholesalePrice: 1 }, dealer), /在庫数のみ/);
    assert.equal((await e.call('/supply', 'GET', undefined, salonOp)).products.find(p => p.id === 'shampoo-moist').wholesalePrice, 2000);
    await assert.rejects(supplyOrder(e, [{ id: 'shampoo-moist', quantity: 1, price: 1859 }]), /卸価格/);
  });
}
