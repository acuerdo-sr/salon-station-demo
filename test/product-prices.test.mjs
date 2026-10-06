// 価格の一括更新（管理画面の価格一括編集）：税込売価・税込仕入単価・加盟店への卸価格を表でまとめて直す。
// 1行でも誤りがあれば何も保存しない。画面を開いた後に他の担当者が変えた商品は上書きしない。ブラウザ版と DB版で同じ規則。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { nextSku } from '../dist/catalog-core.js';
import { engines } from './helpers/engines.mjs';

const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };
const pick = p => ({ price: p.price, cost: p.cost, wholesalePrice: p.wholesalePrice });

test('product codes are numbered automatically and skip codes already in use', () => {
  assert.deepEqual(nextSku(0, ['SN-SH-050']), { sku: 'P-00001', seq: 1 });
  assert.deepEqual(nextSku(3, ['P-00001', 'P-00007']), { sku: 'P-00008', seq: 8 });
  assert.deepEqual(nextSku(12, []), { sku: 'P-00013', seq: 13 }, '削除などで減っても、使った番号は使わない');
});

for (const [name, create] of engines('2026-10-06T03:00:00.000Z')) {
  test(`${name}: headquarters edits selling price, cost and wholesale price in bulk; one bad row saves nothing`, async () => {
    const e = await create();
    try {
      const products = async () => (await e.call('/admin/snapshot', 'GET', undefined, admin)).products;
      const before = await products(), moist = before.find(p => p.id === 'shampoo-moist'), oil = before.find(p => p.id === 'oil-smooth');
      const save = (items, actor = admin) => e.call('/admin/product-prices', 'PATCH', { items }, actor);
      // 誤りのある行があれば、正しい行も含めて何も変えない（どの商品の誤りかを示す）
      await assert.rejects(save([{ id: moist.id, price: 3080, cost: 1800, wholesalePrice: 2400, before: pick(moist) }, { id: oil.id, price: 2640, cost: 9999, wholesalePrice: oil.wholesalePrice, before: pick(oil) }]),
        new RegExp(`${oil.sku}（${oil.name}）：仕入単価は売価以下`));
      await assert.rejects(save([{ id: moist.id, price: 0, before: pick(moist) }]), /販売価格は1〜1000000の整数/);
      await assert.rejects(save([{ id: moist.id, wholesalePrice: 1.5, before: pick(moist) }]), /卸価格は0〜1000000の整数/);
      assert.deepEqual(pick((await products()).find(p => p.id === moist.id)), pick(moist));
      // 権限・入力の形
      await assert.rejects(save([{ id: moist.id, price: 3080 }], sena), /権限/);
      await assert.rejects(save([{ id: moist.id, price: 3080 }], salonOp), /権限/);
      await assert.rejects(save([]), /変更した商品がありません/);
      await assert.rejects(save([{ id: moist.id, price: 3080 }, { id: moist.id, price: 3300 }]), /2回/);
      await assert.rejects(save([{ id: 'no-such-product', price: 3080 }]), /見つかりません/);
      // 保存：変わった商品だけを数え、操作履歴に変更前後の金額を残す
      const result = await save([{ id: moist.id, price: 3080, cost: 1800, wholesalePrice: 2400, before: pick(moist) }, { id: oil.id, price: oil.price, cost: oil.cost, wholesalePrice: oil.wholesalePrice, before: pick(oil) }]);
      assert.equal(result.updated, 1);
      const after = await products();
      assert.deepEqual(pick(after.find(p => p.id === moist.id)), { price: 3080, cost: 1800, wholesalePrice: 2400 });
      assert.deepEqual(pick(after.find(p => p.id === oil.id)), pick(oil));
      const events = JSON.stringify((await e.call('/admin/snapshot', 'GET', undefined, admin)).events);
      assert.ok(events.includes(`価格を一括更新（売価 ${moist.price.toLocaleString('ja-JP')}→3,080 / 仕入 ${moist.cost.toLocaleString('ja-JP')}→1,800 / 卸 ${moist.wholesalePrice.toLocaleString('ja-JP')}→2,400）`), events.slice(0, 300));
      // 新しい価格はストアと加盟店の発注に使われる
      const member = await e.member('kojin-taro');
      assert.equal((await e.call('/bootstrap', 'GET', undefined, member)).products.find(p => p.id === moist.id).price, 3080);
      // 画面を開いた後に他の担当者が変えていたら、上書きしない
      await assert.rejects(save([{ id: moist.id, price: 3300, before: pick(moist) }]), /他の担当者が価格を変更しました/);
      // 商品の編集画面からの変更とも重ならないようにする
      await e.call(`/admin/products/${oil.id}`, 'PATCH', { price: oil.price + 110 }, admin);
      await assert.rejects(save([{ id: oil.id, cost: oil.cost - 1, before: pick(oil) }]), /他の担当者/);
    } finally { await e.close(); }
  });
}
