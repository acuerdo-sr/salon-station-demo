// 初期の品ぞろえ（30点・7カテゴリ・7ブランド）：イラストがそろっていること、以前のデータにも新しい商品が足されること
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { products, concernCategories } from '../catalog.mjs';
import { createPlatform, migrate, platformRequest } from '../dist/platform-core.js';
import { CATALOG_VERSION, productInput } from '../dist/catalog-core.js';
import { brandInfo, FEATURES } from '../dist/brands.js';

test('the sample catalogue covers several categories and brands; every illustration exists and every brand has an introduction', () => {
  assert.ok(products.length >= 30);
  assert.ok(new Set(products.map(p => p.category)).size >= 7);
  assert.ok(new Set(products.map(p => p.brand)).size >= 7);
  assert.equal(new Set(products.map(p => p.id)).size, products.length); assert.equal(new Set(products.map(p => p.sku)).size, products.length);
  for (const p of products) {
    assert.ok(existsSync(new URL(`../dist/assets/${p.image}`, import.meta.url)), p.image);
    assert.ok(p.concerns.every(c => concernCategories.includes(c)), p.id);
    assert.ok(brandInfo(p.brand).lead, p.brand);
    assert.ok(p.summary && p.summary.length <= 60, `一覧の説明：${p.id}`);
  }
  assert.ok(products.some(p => !p.stock), '入荷待ちの表示を確かめる商品がある');
  for (const name of new Set(products.map(p => p.brand))) for (const key of ['image', 'hero']) assert.ok(existsSync(new URL(`../dist/assets/${brandInfo(name)[key]}`, import.meta.url)), `ブランドの絵（${key}）：${name}`);
  assert.ok(FEATURES.length >= 1 && FEATURES.length <= 3, 'おすすめは3つまで');
  for (const f of FEATURES) { assert.ok(products.some(p => p.id === f.product), f.product); assert.ok(existsSync(new URL(`../dist/assets/${f.image}`, import.meta.url)), f.image); }
});

test('older browser data gains the new sample products and categories once, without touching edited products', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  delete state.catalogVersion;
  state.products[0].price = 2970; // 管理画面で変えた価格
  // 版2までのデータ：一覧の説明がなく、写真は以前の既定のもの（1点は管理画面で替えた写真）
  for (const p of state.products) delete p.summary;
  state.products[0].image = 'shampoo.png'; state.products[2].image = 'oil.png'; state.products[1].image = 'data:image/webp;base64,AAAA';
  assert.equal(migrate(state, products), true);
  assert.equal(state.products.length, products.length);
  assert.equal(state.products[0].price, 2970, '登録済みの商品は変えない');
  assert.equal(state.products[0].summary, products[0].summary);
  assert.equal(state.products[0].image, 'products/shampoo-moist.webp');
  assert.equal(state.products[2].image, 'products/oil-smooth.webp');
  assert.equal(state.products[1].image, 'data:image/webp;base64,AAAA', '替えた写真はそのまま');
  assert.ok(['ヘアマスク', 'ヘアミルク・ミスト', 'スカルプケア', 'ヘアスタイリング'].every(n => state.categories.some(c => c.name === n)));
  assert.equal(state.catalogVersion, CATALOG_VERSION);
  assert.equal(migrate(state, products), false, '2回目は何もしない');
  const member = { id: 'm1', name: 'デモ 花子', email: 'm1@example.test', kana: 'デモ ハナコ', phone: '', gender: '', birthday: '', salon: 'LUMIÈRE 表参道' };
  const boot = platformRequest(state, '/bootstrap', 'GET', undefined, { member });
  assert.equal(boot.products.length, products.length);
  assert.ok(boot.categories.some(c => c.name === 'スカルプケア'));
  assert.equal(state.products.find(p => p.id === 'calme-scalp-serum').dealerId, 'bicma', '仕入先（出荷元）は BICMA');
});

test('the short description for product lists is optional and limited to 60 characters', () => {
  const ctx = { categories: [{ id: 'shampoo', name: 'シャンプー' }], dealers: [{ id: 'sena' }], concernNames: [] };
  const base = { brand: 'B', name: 'N', categoryId: 'shampoo', dealerId: 'sena', price: 1000, cost: 500, wholesalePrice: 700, agencyPrice: 600, stock: 1, enabled: true };
  assert.equal(productInput(base, ctx).summary, '');
  assert.equal(productInput({ ...base, summary: '  椿のオイルで、毛先までつややかに。 ' }, ctx).summary, '椿のオイルで、毛先までつややかに。');
  assert.throws(() => productInput({ ...base, summary: 'あ'.repeat(61) }, ctx), /一覧の説明/);
});

test('browser data from catalogue version 3 picks up the rewritten short descriptions of the sample products', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  state.catalogVersion = 3; state.products[0].summary = '以前の短い説明';
  assert.equal(migrate(state, products), true);
  assert.equal(state.products[0].summary, products[0].summary);
  assert.equal(state.catalogVersion, CATALOG_VERSION);
});

test('older browser data with the SENA and BOTANICA dealers is moved to BICMA, the only dealer', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  state.dealers = [{ id: 'sena', name: 'SENA' }, { id: 'botanica', name: 'BOTANICA' }];
  state.products[0].dealerId = 'sena'; state.products[2].dealerId = 'botanica';
  state.purchaseOrders = [{ id: 'PO-1', dealerId: 'botanica', items: [] }];
  state.orders = [{ id: 'O-1', items: [{ id: 'oil-smooth', dealerId: 'botanica' }] }];
  assert.equal(migrate(state, products), true);
  assert.deepEqual(state.dealers.map(d => d.id), ['bicma']);
  assert.ok(state.products.every(p => p.dealerId === 'bicma'));
  assert.equal(state.purchaseOrders[0].dealerId, 'bicma'); assert.equal(state.orders[0].items[0].dealerId, 'bicma');
  assert.equal(migrate(state, products), false, '2回目は何もしない');
});

test('older browser data gains the wholesale price on order lines and the referral rate on franchisee orders', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  const order = state.orders[0]; for (const i of order.items) delete i.wholesalePrice;
  state.supplyOrders = [{ id: 'WO-1', salonId: 'lumiere', status: 'delivered', subtotal: 10000, items: [] }];
  assert.equal(migrate(state, products), true);
  assert.ok(order.items.every(i => i.wholesalePrice === state.products.find(p => p.id === i.id).wholesalePrice), '美容室の取り分（売価−卸価格）の計算に使う');
  assert.equal(state.supplyOrders[0].feeRate, state.salons.find(s => s.id === 'lumiere').feeRate, '紹介料率');
  assert.equal(migrate(state, products), false);
});

test('older browser data moves the demo purchase cost from 60% to 50% of the price, so F.I.T keeps a margin', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  state.catalogVersion = 4;
  for (const p of state.products) p.cost = Math.round(p.price * 0.6);
  state.products[1].cost = 1234; // 管理画面で変えた原価
  const sample = state.orders.find(o => o.sample); for (const i of sample.items) i.cost = Math.round(i.price * 0.6);
  assert.equal(migrate(state, products), true);
  assert.equal(state.products[0].cost, Math.round(state.products[0].price * 0.5));
  assert.equal(state.products[1].cost, 1234, '変えた原価はそのまま');
  assert.ok(sample.items.every(i => i.cost === Math.round(i.price * 0.5)), '初期サンプルの注文も直す');
  const po = state.purchaseOrders.find(p => p.orderId === sample.id);
  assert.equal(po.total, po.items.reduce((n, i) => n + i.cost * i.quantity, 0) + po.shipping);
});

test('older browser data gains the billing party per salon, separate EC and purchase rates, and sample purchases billed by 藤井企画', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  state.catalogVersion = 5;
  for (const s of state.salons) { delete s.supplyBiller; delete s.supplyFeeRate; s.feeRate = 5; }
  state.supplyOrders = state.supplyOrders.filter(o => o.salonId === 'lumiere');
  for (const o of state.supplyOrders) { delete o.biller; delete o.feeRate; delete o.agencyTotal; }
  assert.equal(migrate(state, products), true);
  const atelier = state.salons.find(s => s.id === 'atelier');
  assert.deepEqual([atelier.supplyBiller, atelier.feeRate, atelier.supplyFeeRate], ['fujii', 10, 15]);
  assert.ok(state.supplyOrders.filter(o => o.salonId === 'lumiere').every(o => o.biller === 'fit' && o.feeRate === 15 && o.agencyTotal === 0));
  const samples = state.supplyOrders.filter(o => o.salonId === 'atelier');
  assert.ok(samples.length > 0 && samples.every(o => o.biller === 'fujii' && o.feeRate === 0 && o.agencyTotal > 0), '藤井企画が請求元の仕入れの例を足す');
  assert.deepEqual(state.supplyOrders.map(o => o.createdAt), [...state.supplyOrders.map(o => o.createdAt)].sort().reverse(), '新しい順');
  assert.equal(migrate(state, products), false, '2回目は何もしない');
});
