// テスト用：ブラウザ版と DB版（SQLite、TEST_MYSQL_URL があれば MySQL）を同じ呼び出し方で作る。
// DB版は本番と同じく、お客様の個人情報を暗号化して保存する（テストごとに新しい鍵）。
import { randomBytes } from 'node:crypto';
import { products, concernCategories } from '../../catalog.mjs';
import { createPlatform, platformRequest, demoOperators } from '../../dist/platform-core.js';
import { createSqliteAdapter, createMysqlAdapter } from '../../db/adapter.mjs';
import { createPlatformStore } from '../../db/platform-store.mjs';
import { createFieldCrypto } from '../../db/crypto.mjs';

export const TABLES = ['mail_outbox', 'password_resets', 'member_cards', 'data_access_logs', 'supply_subscription_items', 'supply_subscriptions', 'supply_order_items', 'invoices', 'supply_orders', 'notifications', 'audit_logs', 'stock_movements', 'refunds', 'payments', 'order_events', 'order_items', 'purchase_orders', 'orders', 'favorites', 'supply_favorites', 'cart_items', 'operator_sessions', 'operators', 'member_addresses', 'member_sessions', 'members', 'product_concerns', 'products', 'concerns', 'categories', 'staff', 'salons', 'dealers', 'counters', 'app_meta'];

// お客様の紐付け：会員はQRコードのサロンを保存するだけ。担当スタッフはサロン側（ここでは本部の操作）で設定する
export async function linkMember(call, actor, salonId = 'lumiere', staffId = '') {
  await call('/profile', 'PATCH', { salonId }, actor);
  if (staffId) await call(`/admin/members/${actor.member.id}/staff`, 'PATCH', { staffId }, { operator: demoOperators[0] });
}
// 会員マスタのフリガナは必須（注文時に確認する）
export const KANA = 'デモ ハナコ';
async function sqlEngine(db, now) {
  const fieldCrypto = createFieldCrypto(randomBytes(32));
  // 商品画像はメモリに保存する（本番は images.mjs でファイルに保存）
  const saved = new Map(), images = { save: (bytes, ext) => { const name = `uploads/products/test-${saved.size + 1}.${ext}`; saved.set(name, bytes); return name; } };
  const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories, fieldCrypto, images });
  await store.init({ now });
  return {
    sql: true, db, store, fieldCrypto, images: saved,
    call: (route, method, input, actor = {}, at = now, effects = []) => store.request(route, method, input, actor, at, effects),
    async member(id, name = 'デモ 花子') {
      const email = `${id}@example.test`;
      await db.run('INSERT INTO members (id, email, email_index, password_salt, password_hash, name, kana, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, fieldCrypto.encrypt(email), fieldCrypto.blindIndex(email), '00', '00', fieldCrypto.encrypt(name), fieldCrypto.encrypt(KANA), now, now]);
      return { member: { id, name, email, kana: KANA } };
    },
    close: () => db.close(),
  };
}
let mysqlSeq = 0;
export function engines(now) {
  const list = [
    ['browser', async () => { const state = createPlatform(products, now); return { state, call: async (route, method, input, actor = {}, at = now, effects = []) => platformRequest(state, route, method, input, actor, at, effects), member: async (id, name = 'デモ 花子') => ({ member: { id, name, email: `${id}@example.test`, kana: KANA } }), close: async () => {} }; }],
    ['sqlite', async () => sqlEngine(await createSqliteAdapter(':memory:'), now)],
  ];
  // テストファイルは並行して動くため、エンジンごとに専用のデータベースを作り、終わったら消す
  // （TEST_MYSQL_URL のユーザーにはデータベースの作成・削除の権限が要る）
  if (process.env.TEST_MYSQL_URL) list.push(['mysql', async () => {
    const base = new URL(process.env.TEST_MYSQL_URL), name = `${base.pathname.slice(1) || 'salon_test'}_${process.pid}_${++mysqlSeq}`;
    const server = new URL(base); server.pathname = '/';
    const admin = await createMysqlAdapter(server.href);
    await admin.exec(`CREATE DATABASE \`${name}\``);
    const url = new URL(base); url.pathname = '/' + name;
    const db = await createMysqlAdapter(url.href);
    const engine = await sqlEngine(db, now);
    return { ...engine, close: async () => { await db.close(); await admin.exec(`DROP DATABASE \`${name}\``); await admin.close(); } };
  }]);
  return list;
}
