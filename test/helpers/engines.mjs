// テスト用：ブラウザ版と DB版（SQLite、TEST_MYSQL_URL があれば MySQL）を同じ呼び出し方で作る。
// DB版は本番と同じく、お客様の個人情報を暗号化して保存する（テストごとに新しい鍵）。
import { randomBytes } from 'node:crypto';
import { products, concernCategories } from '../../catalog.mjs';
import { createPlatform, platformRequest } from '../../dist/platform-core.js';
import { createSqliteAdapter, createMysqlAdapter } from '../../db/adapter.mjs';
import { createPlatformStore } from '../../db/platform-store.mjs';
import { createFieldCrypto } from '../../db/crypto.mjs';

export const TABLES = ['data_access_logs', 'supply_subscription_items', 'supply_subscriptions', 'supply_order_items', 'invoices', 'supply_orders', 'notifications', 'audit_logs', 'stock_movements', 'refunds', 'payments', 'order_events', 'order_items', 'purchase_orders', 'orders', 'favorites', 'cart_items', 'operator_sessions', 'operators', 'member_addresses', 'member_sessions', 'members', 'product_concerns', 'products', 'concerns', 'categories', 'staff', 'salons', 'dealers', 'counters', 'app_meta'];

async function sqlEngine(db, now) {
  const fieldCrypto = createFieldCrypto(randomBytes(32));
  const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories, fieldCrypto });
  await store.init({ now });
  return {
    sql: true, db, store, fieldCrypto,
    call: (route, method, input, actor = {}, at = now, effects = []) => store.request(route, method, input, actor, at, effects),
    async member(id, name = 'デモ 花子') {
      const email = `${id}@example.test`;
      await db.run('INSERT INTO members (id, email, email_index, password_salt, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, fieldCrypto.encrypt(email), fieldCrypto.blindIndex(email), '00', '00', fieldCrypto.encrypt(name), now, now]);
      return { member: { id, name, email } };
    },
    close: () => db.close(),
  };
}
export function engines(now) {
  const list = [
    ['browser', async () => { const state = createPlatform(products, now); return { state, call: async (route, method, input, actor = {}, at = now, effects = []) => platformRequest(state, route, method, input, actor, at, effects), member: async (id, name = 'デモ 花子') => ({ member: { id, name, email: `${id}@example.test` } }), close: async () => {} }; }],
    ['sqlite', async () => sqlEngine(await createSqliteAdapter(':memory:'), now)],
  ];
  if (process.env.TEST_MYSQL_URL) list.push(['mysql', async () => {
    const db = await createMysqlAdapter(process.env.TEST_MYSQL_URL);
    await db.exec('SET FOREIGN_KEY_CHECKS=0');
    for (const table of TABLES) await db.exec(`DROP TABLE IF EXISTS ${table}`);
    await db.exec('SET FOREIGN_KEY_CHECKS=1');
    return sqlEngine(db, now);
  }]);
  return list;
}
