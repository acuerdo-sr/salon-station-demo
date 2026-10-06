// データベースの版の更新（表の作成・列の追加・既存データの暗号化）。
// 本番では、アプリ用（データの読み書きだけ）とは別の「表を変更できるDBユーザー」で実行する（db/grants.mysql.sql）。
// サーバーは版が最新なら表の作成・変更を行わないため、アプリ用のDBユーザーに DDL の権限は要らない。
//
//   DATABASE_URL=mysql://salon_migrate:…@127.0.0.1:3306/salon_station DATA_ENCRYPTION_KEY=… npm run db:migrate
import { SCHEMA_VERSION } from '../db/platform-store.mjs';
import { openStore } from './open-store.mjs';

let db;
try {
  const opened = await openStore();
  db = opened.db;
  const result = await opened.store.init();
  console.log(`データベースは最新の版（${SCHEMA_VERSION}）です。${result.imported ? `旧形式のデータを移行しました（店舗${result.salons}・会員${result.members}・注文${result.orders}）。` : ''}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await db?.close(); }
