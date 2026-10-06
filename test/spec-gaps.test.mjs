// 仕様書（Rev01）にあって未実装だった機能：住所管理、多彩な決済方法・支払方法管理、会員情報の編集（美容室）、
// 出荷指示CSV（佐川急便連携）、商品の新規登録・カテゴリ管理（画像を含む）。ブラウザ版と DB版で同じ規則になることを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { memberRef } from '../dist/privacy.js';
import { formatAddress } from '../dist/person.js';
import { demoTokenize } from '../dist/payment-core.js';
import { SHIPPING_COLUMNS } from '../dist/shipping-csv.js';
import { engines } from './helpers/engines.mjs';

const now = '2026-10-06T03:00:00.000Z', later = minutes => new Date(Date.parse(now) + minutes * 60000).toISOString();
const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] }, botanica = { operator: demoOperators[3] };
const atelierOp = { operator: { id: 'salon-atelier', role: 'salon', salonId: 'atelier', name: 'atelier 凪 店舗担当' } };
const home = { name: '自宅 太郎', postal: '1234567', prefecture: '東京都', city: '秘密市', street: '9-8-7', building: 'サンプルマンション101号室', phone: '090-1234-5678' };
home.address = formatAddress(home);
const office = { name: '会社 太郎', postal: '765-4321', prefecture: '神奈川県', city: '架空市', street: '1-1-1', phone: '03-0000-0000' };
const shampoo = [{ id: 'shampoo-moist', quantity: 1, price: 2860 }], twoDealers = [...shampoo, { id: 'oil-smooth', quantity: 1, price: 2640 }];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const card = number => demoTokenize({ number, expMonth: 12, expYear: 2030 });

for (const [name, create] of engines(now)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => { const e = await create(); try { await body(e); } finally { await e.close(); } });
  const linked = async (e, id, salonId = 'lumiere') => { const actor = await e.member(id, '個人 太郎'); await e.call('/profile', 'PATCH', { salonId, staffId: '' }, actor); return actor; };
  const order = (e, actor, extra = {}, items = shampoo, at = now) => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items, customer: home, ...extra }, actor, at);
  const stockOf = async (e, id) => (await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(p => p.id === id).stock;

  run('address book: up to 10 delivery addresses, one default, chosen at checkout; the first order saves its address', async e => {
    const taro = await linked(e, 'kojin-taro');
    assert.deepEqual(await e.call('/addresses', 'GET', undefined, taro), []);
    const first = await order(e, taro);
    assert.equal(first.customer.phone, '09012345678', '電話番号は数字だけにそろえる');
    let book = await e.call('/addresses', 'GET', undefined, taro);
    assert.equal(book.length, 1); assert.equal(book[0].isDefault, true); assert.equal(book[0].address, home.address);
    book = await e.call('/addresses', 'POST', { ...office, isDefault: true }, taro, later(1));
    assert.deepEqual(book.map(a => [a.name, a.isDefault]), [['会社 太郎', true], ['自宅 太郎', false]]);
    assert.equal((await e.call('/profile', 'GET', undefined, taro)).address.name, '会社 太郎');
    // 住所録から選んだお届け先で注文する（入力したお届け先より優先）
    const second = await order(e, taro, { addressId: book[0].id, customer: undefined });
    assert.deepEqual([second.customer.name, second.customer.postal, second.customer.prefecture, second.customer.phone], ['会社 太郎', '7654321', '神奈川県', '0300000000']);
    // 他の会員の住所は使えない
    const hanako = await linked(e, 'kojin-hanako');
    await assert.rejects(order(e, hanako, { addressId: book[0].id }), /お届け先が見つかりません/);
    await assert.rejects(e.call(`/addresses/${book[0].id}`, 'PATCH', { name: 'x' }, hanako), /お届け先が見つかりません/);
    // 編集・削除（既定を消したら、残りの1件が既定になる）
    book = await e.call(`/addresses/${book[1].id}`, 'PATCH', { phone: '080-9999-0000' }, taro, later(2));
    assert.equal(book.find(a => a.name === '自宅 太郎').phone, '08099990000');
    book = await e.call(`/addresses/${book.find(a => a.isDefault).id}`, 'DELETE', undefined, taro, later(3));
    assert.deepEqual(book.map(a => [a.name, a.isDefault]), [['自宅 太郎', true]]);
    await assert.rejects(e.call('/addresses', 'POST', { ...office, postal: '12' }, taro), /郵便番号/);
    await assert.rejects(e.call('/addresses', 'POST', { ...office, phone: '12-34' }, taro), /電話番号/);
    for (let i = 0; i < 9; i++) await e.call('/addresses', 'POST', { ...office, name: `住所 ${'イロハニホヘトチリヌ'[i]}` }, taro, later(10 + i));
    await assert.rejects(e.call('/addresses', 'POST', office, taro), /10件まで/);
    await assert.rejects(e.call('/addresses', 'GET', undefined, {}), /ログイン/);
    if (e.sql) for (const row of await e.db.all('SELECT name, address, phone FROM member_addresses')) for (const value of Object.values(row)) assert.match(value, /^enc:v1:/);
  });

  run('payment methods: saved cards keep only the token and last 4 digits; declined cards create no order; defaults can be changed', async e => {
    const taro = await linked(e, 'kojin-taro'), before = await stockOf(e, 'shampoo-moist');
    let wallet = await e.call('/payment-methods/cards', 'POST', { card: card('4242424242424242') }, taro);
    wallet = await e.call('/payment-methods/cards', 'POST', { card: card('5555555555554444'), makeDefault: true }, taro, later(1));
    assert.deepEqual(wallet.cards.map(c => [c.brand, c.last4, c.isDefault]), [['visa', '4242', false], ['mastercard', '4444', true]]);
    assert.ok(!JSON.stringify(wallet).includes('tok_test_'), '画面にはトークンを返さない');
    const paid = await order(e, taro, { payment: { method: 'card', cardId: wallet.cards[1].id } });
    assert.deepEqual([paid.paymentMethod, paid.paymentStatus, paid.total], ['card', 'captured', 2860 + 660]);
    assert.equal(paid.payment, 'クレジットカード・決済完了');
    // 承認されないカードでは注文を作らず、在庫も減らさない
    await assert.rejects(order(e, taro, { payment: { method: 'card', card: card('4000000000000002') } }), /承認されませんでした/);
    assert.equal(await stockOf(e, 'shampoo-moist'), before - 1);
    // 新しいカードで払って、そのまま登録する
    await order(e, taro, { payment: { method: 'card', card: card('3530111333300000'), saveCard: true } });
    wallet = await e.call('/payment-methods', 'GET', undefined, taro);
    assert.deepEqual(wallet.cards.map(c => c.last4).sort(), ['0000', '4242', '4444']);
    await assert.rejects(e.call('/payment-methods/cards', 'POST', { card: { ...card('4242424242424242'), expYear: 2020 } }, taro), /有効期限/);
    await assert.rejects(e.call('/payment-methods/cards', 'POST', { card: { token: '4242424242424242', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030 } }, taro), /カード情報/);
    wallet = await e.call('/payment-methods', 'PATCH', { defaultCardId: wallet.cards.find(c => c.last4 === '4242').id }, taro);
    assert.equal(wallet.cards.find(c => c.isDefault).last4, '4242');
    await assert.rejects(e.call('/payment-methods', 'PATCH', { defaultCardId: 'cd-none' }, taro), /カードが見つかりません/);
    wallet = await e.call(`/payment-methods/cards/${wallet.cards.find(c => c.isDefault).id}`, 'DELETE', undefined, taro);
    assert.equal(wallet.cards.length, 2); assert.equal(wallet.cards.filter(c => c.isDefault).length, 1);
    const other = await linked(e, 'kojin-hanako');
    await assert.rejects(order(e, other, { payment: { method: 'card', cardId: wallet.cards[0].id } }), /カードが見つかりません/);
    if (e.sql) assert.ok((await e.db.all('SELECT token FROM member_cards')).every(r => r.token.startsWith('enc:v1:')));
  });

  run('payment is by credit card only: other methods are rejected and cancellations refund the card', async e => {
    const taro = await linked(e, 'kojin-taro'), before = await stockOf(e, 'shampoo-moist');
    for (const method of ['cod', 'bank', 'konbini', 'amazon_pay']) await assert.rejects(order(e, taro, { payment: { method } }), /クレジットカードのみ/, method);
    assert.equal(await stockOf(e, 'shampoo-moist'), before, '断った注文は在庫を確保しない');
    const paid = await order(e, taro, { payment: { method: 'card', card: card('4242424242424242') } });
    assert.deepEqual([paid.paymentMethod, paid.paymentStatus, paid.total], ['card', 'captured', 2860 + 660]);
    assert.ok(paid.timeline.some(t => t.label === 'ご注文・カード決済完了（テスト）'));
    const cancelled = await e.call(`/orders/${paid.id}/cancel`, 'POST', {}, taro);
    assert.deepEqual([cancelled.paymentStatus, cancelled.payment], ['refunded', 'クレジットカード・返金済み']);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, admin)).settlements.find(x => x.orderId === paid.id).refunded, paid.total);
  });

  run('the salon edits its own customers (not the e-mail); other salons and headquarters cannot', async e => {
    const taro = await linked(e, 'kojin-taro');
    const edited = await e.call('/admin/customers/kojin-taro', 'PATCH', { name: '個人 二郎', kana: 'コジン タロウ', phone: '090-1111-2222', gender: '1', birthday: '1990-04-01', email: 'forged@example.test' }, salonOp);
    assert.deepEqual([edited.name, edited.kana, edited.phone, edited.gender, edited.ref], ['個人 二郎', 'コジン タロウ', '09011112222', '1', memberRef('kojin-taro')]);
    assert.equal(edited.email, taro.member.email);
    await assert.rejects(e.call('/admin/customers/kojin-taro', 'PATCH', { name: 'x', kana: 'エックス' }, atelierOp), /会員が見つかりません/);
    await assert.rejects(e.call('/admin/customers/kojin-taro', 'PATCH', { name: 'x', kana: 'エックス' }, admin), /権限/);
    await assert.rejects(e.call('/admin/customers/kojin-taro', 'PATCH', { name: '個人 太郎', kana: '' }, salonOp), /フリガナ/);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, salonOp)).profiles.find(p => p.id === 'kojin-taro').name, '個人 二郎');
    const events = (await e.call('/admin/snapshot', 'GET', undefined, admin)).events;
    assert.ok(events.some(ev => ev.action === '会員情報を編集' && ev.reference === memberRef('kojin-taro')));
    if (e.sql) assert.equal(e.fieldCrypto.decrypt((await e.db.get("SELECT name FROM members WHERE id='kojin-taro'")).name), '個人 二郎');
  });

  run('shipping instruction CSV: dealers export unshipped orders with phone and split address; access is recorded; headquarters exports franchisee orders', async e => {
    const taro = await linked(e, 'kojin-taro');
    const paid = await order(e, taro);
    const po = paid.shipments[0].id;
    const csv = await e.call('/admin/shipping-csv', 'POST', { kind: 'purchaseOrders', ids: [po] }, { ...sena, ip: '192.0.2.8' });
    assert.deepEqual(csv.columns, SHIPPING_COLUMNS); assert.match(csv.filename, /^出荷指示_EC注文_20261006\.csv$/);
    const row = Object.fromEntries(csv.columns.map((c, i) => [c, csv.rows[0][i]]));
    assert.equal(row['お客様管理番号'], po); assert.equal(row['お届け先電話番号'], '09012345678'); assert.equal(row['お届け先郵便番号'], '1234567');
    assert.deepEqual([row['お届け先住所1'], row['お届け先住所2'], row['お届け先住所3']], ['東京都秘密市', '9-8-7', 'サンプルマンション101号室']);
    assert.equal(row['お届け先名称1'], home.name); assert.equal(row['ご依頼主名称1'], 'LUMIÈRE 表参道'); assert.equal(row['品名1'], 'モイストリペア シャンプー ×1');
    assert.ok(!csv.columns.includes('代引金額'), 'カード決済のみなので代引きの列はない'); assert.equal(row['便種'], '飛脚宅配便'); assert.equal(row['記事'], `注文 ${paid.id}`);
    const logs = (await e.call('/admin/snapshot', 'GET', undefined, salonOp, later(1))).accessLogs;
    assert.ok(logs.some(l => l.role === 'ディーラー' && l.action === 'CSV出力' && l.target === '出荷指示（お名前・住所・電話番号）' && l.count === 1));
    await assert.rejects(e.call('/admin/shipping-csv', 'POST', { kind: 'purchaseOrders', ids: [po] }, botanica), /出力できない/);
    await assert.rejects(e.call('/admin/shipping-csv', 'POST', { kind: 'purchaseOrders', ids: [po] }, admin), /権限/);
    await assert.rejects(e.call('/admin/shipping-csv', 'POST', { kind: 'purchaseOrders', ids: [] }, sena), /選んでください/);
    await e.call(`/admin/purchase-orders/${po}`, 'PATCH', { status: 'accepted' }, sena);
    await e.call(`/admin/purchase-orders/${po}`, 'PATCH', { status: 'shipped', carrier: '佐川急便', tracking: 'SG-2' }, sena);
    await assert.rejects(e.call('/admin/shipping-csv', 'POST', { kind: 'purchaseOrders', ids: [po] }, sena), /出荷前/);
    // 本部：加盟店からの発注（お届け先は店舗）
    const supply = await e.call('/supply/orders', 'POST', { requestKey: crypto.randomUUID(), items: [{ id: 'shampoo-moist', quantity: 2, price: 1859 }] }, salonOp);
    const hq = await e.call('/admin/shipping-csv', 'POST', { kind: 'supplyOrders', ids: [supply.id] }, admin);
    const s = Object.fromEntries(hq.columns.map((c, i) => [c, hq.rows[0][i]]));
    assert.equal(s['お届け先名称1'], 'LUMIÈRE 表参道'); assert.equal(s['お届け先電話番号'], '03-0000-0000'); assert.equal(s['ご依頼主名称1'], 'SALON STATION 本部（架空）'); assert.equal(s['品名1'], 'モイストリペア シャンプー ×2');
    await assert.rejects(e.call('/admin/shipping-csv', 'POST', { kind: 'supplyOrders', ids: [supply.id] }, salonOp), /権限/);
  });

  run('products and categories: headquarters registers products with images and edits every field; categories in use cannot be deleted; dealers change stock only', async e => {
    let cats = await e.call('/admin/categories', 'POST', { name: 'スタイリング' }, admin);
    const styling = cats.find(c => c.name === 'スタイリング');
    assert.equal(styling.productCount, 0);
    await assert.rejects(e.call('/admin/categories', 'POST', { name: 'シャンプー' }, admin), /同じ名前/);
    await assert.rejects(e.call('/admin/categories', 'POST', { name: '新カテゴリ' }, salonOp), /権限/);
    const input = { brand: 'SENA', name: 'ナチュラル ヘアワックス', categoryId: styling.id, concerns: ['ボリュームアップ'], size: '80 g', description: '軽い仕上がり。', tag: 'NEW', price: 2420, cost: 1400, wholesalePrice: 1573, dealerId: 'sena', stock: 30, enabled: true, imageData: PNG };
    const p = await e.call('/admin/products', 'POST', input, admin);
    assert.deepEqual([p.sku, p.category, p.concerns, p.stock, p.dealerId, p.wholesalePrice], ['P-00001', 'スタイリング', ['ボリュームアップ'], 30, 'sena', 1573], '商品コードは自動で付ける');
    assert.ok(e.sql ? /^uploads\/products\/test-1\.png$/.test(p.image) : p.image.startsWith('data:image/png;base64,'));
    assert.equal((await e.call('/admin/products', 'POST', { ...input, sku: 'MY-CODE' }, admin)).sku, 'P-00002', '入力した商品コードは使わない');
    await assert.rejects(e.call('/admin/products', 'POST', input, sena), /権限/);
    await assert.rejects(e.call('/admin/products', 'POST', { ...input, imageData: 'data:image/png;base64,' + btoa('this is not a png') }, admin), /画像の形式/);
    await assert.rejects(e.call('/admin/products', 'POST', { ...input, concerns: ['寝ぐせ'] }, admin), /お悩み/);
    await assert.rejects(e.call('/admin/products', 'POST', { ...input, cost: 9999 }, admin), /仕入単価は売価以下/);
    // 会員のストアに、カテゴリと一緒に出る
    const member = await e.member('kojin-taro');
    const boot = await e.call('/bootstrap', 'GET', undefined, member);
    assert.ok(boot.products.some(x => x.id === p.id)); assert.ok(boot.categories.some(c => c.id === styling.id && c.name === 'スタイリング'));
    assert.deepEqual((await e.call('/bootstrap', 'GET', undefined, {})).categories, []);
    // 本部は全項目を編集、ディーラーは在庫だけ
    const edited = await e.call(`/admin/products/${p.id}`, 'PATCH', { sku: 'CHANGED', name: 'ナチュラル ヘアワックス（ソフト）', concerns: [], price: 2640, stock: 25 }, admin);
    assert.deepEqual([edited.sku, edited.name, edited.concerns, edited.price, edited.stock, edited.category], ['P-00001', 'ナチュラル ヘアワックス（ソフト）', [], 2640, 25, 'スタイリング']);
    await assert.rejects(e.call(`/admin/products/${p.id}`, 'PATCH', { name: 'x' }, sena), /在庫数のみ/);
    assert.equal((await e.call(`/admin/products/${p.id}`, 'PATCH', { stock: 40 }, sena)).stock, 40);
    // カテゴリの名前を変えると商品の表示も変わる。商品があるカテゴリは削除できない
    cats = await e.call(`/admin/categories/${styling.id}`, 'PATCH', { name: 'スタイリング剤', sortOrder: 0 }, admin);
    assert.equal(cats[0].name, 'スタイリング剤'); assert.equal(cats[0].productCount, 2);
    assert.equal((await e.call('/admin/snapshot', 'GET', undefined, admin)).products.find(x => x.id === p.id).category, 'スタイリング剤');
    await assert.rejects(e.call(`/admin/categories/${styling.id}`, 'DELETE', undefined, admin), /削除できません/);
    const empty = (await e.call('/admin/categories', 'POST', { name: '空のカテゴリ' }, admin)).find(c => c.name === '空のカテゴリ');
    cats = await e.call(`/admin/categories/${empty.id}`, 'DELETE', undefined, admin);
    assert.ok(!cats.some(c => c.id === empty.id));
    const snap = await e.call('/admin/snapshot', 'GET', undefined, admin);
    assert.ok(snap.categories.length >= 4); assert.ok(snap.concernNames.includes('ボリュームアップ'));
  });
}

test('the same scenario gives the same orders and card payments in the browser demo and the database', async () => {
  const results = [];
  for (const [name, create] of engines(now)) {
    const e = await create();
    try {
      const taro = await e.member('kojin-taro', '個人 太郎'); await e.call('/profile', 'PATCH', { salonId: 'lumiere', staffId: '' }, taro);
      const place = extra => e.call('/orders', 'POST', { requestKey: crypto.randomUUID(), salonId: 'lumiere', items: shampoo, customer: home, ...extra }, taro);
      const wallet = await e.call('/payment-methods/cards', 'POST', { card: card('5555555555554444') }, taro);
      const list = [await place({ payment: { method: 'card' } }), await place({ payment: { method: 'card', cardId: wallet.cards[0].id } }), await place({ payment: { method: 'card', card: card('3530111333300000'), saveCard: true } })];
      await assert.rejects(place({ payment: { method: 'card', card: card('4000000000000002') } }), /承認されませんでした/);
      const cancelled = await e.call(`/orders/${list[0].id}/cancel`, 'POST', {}, taro);
      results.push([name, [...list, cancelled].map(o => ({ method: o.paymentMethod, status: o.paymentStatus, total: o.total, payment: o.payment, phone: o.customer.phone, timeline: o.timeline.map(t => t.label) })), (await e.call('/payment-methods', 'GET', undefined, taro)).cards.map(c => [c.brand, c.last4, c.isDefault])]);
    } finally { await e.close(); }
  }
  for (const [name, list, cards] of results.slice(1)) { assert.deepEqual(list, results[0][1], name); assert.deepEqual(cards, results[0][2], name); }
});
