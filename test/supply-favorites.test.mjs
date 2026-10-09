// 加盟店の発注画面：お気に入り（いつもの商品）、欠品の表示、出荷予定（納期の目安）。ブラウザ版と DB版で同じ規則。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoOperators } from '../dist/platform-core.js';
import { stockState, shipEstimate } from '../dist/supply-core.js';
import { engines } from './helpers/engines.mjs';

const admin = { operator: demoOperators[0] }, salonOp = { operator: demoOperators[1] }, sena = { operator: demoOperators[2] };

test('stock state and ship estimate: out of stock, low stock, same-day shipping before 15:00 on weekdays', () => {
  assert.deepEqual([stockState(0).code, stockState(5).label, stockState(30).label], ['out', '残りわずか（5点）', '在庫あり']);
  // 2026-10-09 は金曜日（日本時間）
  assert.equal(shipEstimate(10, '2026-10-09T05:59:00.000Z').label, '本日出荷', '14:59 の注文');
  assert.equal(shipEstimate(10, '2026-10-09T06:00:00.000Z').label, '10/12（月）出荷', '15:00 以降は次の平日');
  assert.equal(shipEstimate(10, '2026-10-10T01:00:00.000Z').label, '10/12（月）出荷', '土曜日');
  assert.equal(shipEstimate(0, '2026-10-09T01:00:00.000Z').label, '入荷後に出荷');
});

for (const [name, create] of engines('2026-10-09T03:00:00.000Z')) {
  test(`${name}: salons keep their own favorites; products carry their label for the new-arrivals row`, async () => {
    const e = await create();
    try {
      let ws = await e.call('/supply', 'GET', undefined, salonOp);
      assert.deepEqual(ws.favorites, []);
      assert.ok(ws.products.every(p => typeof p.tag === 'string'));
      const saved = await e.call('/supply/favorites', 'PUT', { ids: ['oil-smooth', 'shampoo-moist', 'oil-smooth', 'no-such-product'] }, salonOp);
      assert.deepEqual(saved.ids, ['oil-smooth', 'shampoo-moist'], '重複と知らない商品は除く・登録した順');
      ws = await e.call('/supply', 'GET', undefined, salonOp);
      assert.deepEqual(ws.favorites, ['oil-smooth', 'shampoo-moist']);
      await assert.rejects(e.call('/supply/favorites', 'PUT', { ids: 'shampoo-moist' }, salonOp), /形式/);
      await assert.rejects(e.call('/supply/favorites', 'PUT', { ids: Array.from({ length: 201 }, (_, i) => `p${i}`) }, salonOp), /200件/);
      await assert.rejects(e.call('/supply/favorites', 'PUT', { ids: [] }, sena), /権限/);
      await assert.rejects(e.call('/supply/favorites', 'PUT', { ids: [] }, admin), /権限/);
      // 非公開にした商品はお気に入りの一覧に出さない
      await e.call('/admin/products/oil-smooth', 'PATCH', { enabled: false }, admin);
      assert.deepEqual((await e.call('/supply', 'GET', undefined, salonOp)).favorites, ['shampoo-moist']);
      assert.deepEqual((await e.call('/supply/favorites', 'PUT', { ids: [] }, salonOp)).ids, []);
    } finally { await e.close(); }
  });
}
