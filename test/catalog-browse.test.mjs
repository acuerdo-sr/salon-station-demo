// 初期の品ぞろえ（30点・7カテゴリ・7ブランド）：イラストがそろっていること、以前のデータにも新しい商品が足されること
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { products, concernCategories } from '../catalog.mjs';
import { createPlatform, migrate, platformRequest } from '../dist/platform-core.js';
import { CATALOG_VERSION } from '../dist/catalog-core.js';
import { brandInfo } from '../dist/brands.js';

test('the sample catalogue covers several categories and brands; every illustration exists and every brand has an introduction', () => {
  assert.ok(products.length >= 30);
  assert.ok(new Set(products.map(p => p.category)).size >= 7);
  assert.ok(new Set(products.map(p => p.brand)).size >= 7);
  assert.equal(new Set(products.map(p => p.id)).size, products.length); assert.equal(new Set(products.map(p => p.sku)).size, products.length);
  for (const p of products) {
    assert.ok(existsSync(new URL(`../dist/assets/${p.image}`, import.meta.url)), p.image);
    assert.ok(p.concerns.every(c => concernCategories.includes(c)), p.id);
    assert.ok(brandInfo(p.brand).lead, p.brand);
  }
  assert.ok(products.some(p => !p.stock), '入荷待ちの表示を確かめる商品がある');
});

test('older browser data gains the new sample products and categories once, without touching edited products', () => {
  const state = createPlatform(products.slice(0, 6), '2026-10-09T03:00:00.000Z');
  delete state.catalogVersion;
  state.products[0].price = 2970; // 管理画面で変えた価格
  assert.equal(migrate(state, products), true);
  assert.equal(state.products.length, products.length);
  assert.equal(state.products[0].price, 2970, '登録済みの商品は変えない');
  assert.ok(['ヘアマスク', 'ヘアミルク・ミスト', 'スカルプケア', 'ヘアスタイリング'].every(n => state.categories.some(c => c.name === n)));
  assert.equal(state.catalogVersion, CATALOG_VERSION);
  assert.equal(migrate(state, products), false, '2回目は何もしない');
  const member = { id: 'm1', name: 'デモ 花子', email: 'm1@example.test', kana: 'デモ ハナコ', phone: '', gender: '', birthday: '', salon: 'LUMIÈRE 表参道' };
  const boot = platformRequest(state, '/bootstrap', 'GET', undefined, { member });
  assert.equal(boot.products.length, products.length);
  assert.ok(boot.categories.some(c => c.name === 'スカルプケア'));
  assert.equal(state.products.find(p => p.id === 'calme-scalp-serum').dealerId, 'botanica', '仕入先は商品の指定どおり');
});
