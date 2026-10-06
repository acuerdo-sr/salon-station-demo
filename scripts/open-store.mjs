// 保守用スクリプトの共通処理：サーバーと同じ接続先（DATABASE_URL または data/shop.sqlite）と暗号鍵でDBを開く。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { products, concernCategories } from '../catalog.mjs';
import { openDatabase } from '../db/adapter.mjs';
import { loadDataKey, createFieldCrypto } from '../db/crypto.mjs';
import { createPlatformStore } from '../db/platform-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// mustExist：SQLite のファイルがなければ新しく作らずに止める（参照だけのスクリプト用）
export async function openStore({ mustExist = false, createKey = true } = {}) {
  const dataDir = process.env.DATA_DIR || path.join(root, 'data'), sqliteFile = path.join(dataDir, 'shop.sqlite');
  if (mustExist && !/^mysql:\/\//.test(process.env.DATABASE_URL || '') && !existsSync(sqliteFile)) throw Error(`データベースが見つかりません：${sqliteFile}`);
  const { key } = loadDataKey({ dataDir, create: createKey });
  const db = await openDatabase({ sqliteFile });
  const store = createPlatformStore(db, { catalog: products, concernNames: concernCategories, fieldCrypto: createFieldCrypto(key) });
  return { db, store };
}
