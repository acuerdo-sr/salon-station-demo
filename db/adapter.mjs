// データベース接続。業務ロジックは all / get / run / transaction だけを使い、SQLite と MySQL の違いをここで吸収する。
// どちらも「?」プレースホルダー。日時は ISO 文字列、真偽値は 0/1 で保存する。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaStatements = dialect => readFileSync(path.join(here, `schema.${dialect}.sql`), 'utf8')
  .split('\n').filter(line => !line.trim().startsWith('--')).join('\n')
  .split(';').map(sql => sql.trim()).filter(Boolean);
// 表の定義（CREATE TABLE 文）を1つだけ取り出す（表の作り直しに使う）
export const schemaTable = (dialect, table) => schemaStatements(dialect).find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`)) || (() => { throw Error(`schema: ${table} がありません`); })();

// SQLite（node:sqlite）。接続は1本なので、トランザクションと単発の問い合わせを直列化する。
export async function createSqliteAdapter(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  // secure_delete：削除・更新で空いた領域を0で上書きし、古い個人情報がファイルに残らないようにする
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  let queue = Promise.resolve();
  const exclusive = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const statements = new Map();
  const prepare = sql => { let s = statements.get(sql); if (!s) { s = db.prepare(sql); statements.set(sql, s); } return s; };
  const direct = {
    dialect: 'sqlite',
    async all(sql, params = []) { return prepare(sql).all(...params); },
    async get(sql, params = []) { return prepare(sql).get(...params) ?? null; },
    async run(sql, params = []) { const r = prepare(sql).run(...params); return { changes: Number(r.changes), insertId: Number(r.lastInsertRowid) }; },
    async exec(sql) { db.exec(sql); },
  };
  const adapter = {
    dialect: 'sqlite',
    all: (sql, params) => exclusive(() => direct.all(sql, params)),
    get: (sql, params) => exclusive(() => direct.get(sql, params)),
    run: (sql, params) => exclusive(() => direct.run(sql, params)),
    exec: sql => exclusive(() => direct.exec(sql)),
    // fn には同じ接続の direct を渡す（中で adapter を呼ぶと待ち合わせで止まるため）。
    transaction: fn => exclusive(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(direct); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    async migrate() { for (const sql of schemaStatements('sqlite')) db.exec(sql); },
    async tableColumns(table) { return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(c => c.name); },
    async tableExists(table) { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)); },
    async close() { await queue; db.close(); },
    isUniqueViolation: error => /UNIQUE constraint failed|PRIMARY KEY/.test(String(error?.message)),
  };
  return adapter;
}

// MySQL 8.0（mysql2）。DATABASE_URL=mysql://user:pass@host:3306/dbname
export async function createMysqlAdapter(url) {
  let mysql;
  try { mysql = await import('mysql2/promise'); }
  catch { throw Error('MySQL を使うには `npm install mysql2` を実行してください。'); }
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, charset: 'utf8mb4', decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false, timezone: 'Z' });
  const wrap = conn => ({
    dialect: 'mysql',
    async all(sql, params = []) { const [rows] = await conn.query(sql, params); return rows; },
    async get(sql, params = []) { const [rows] = await conn.query(sql, params); return rows[0] ?? null; },
    async run(sql, params = []) { const [r] = await conn.query(sql, params); return { changes: Number(r.affectedRows), insertId: Number(r.insertId) }; },
    async exec(sql) { await conn.query(sql); },
  });
  const base = wrap(pool);
  return {
    ...base,
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(wrap(conn));
        await conn.commit();
        return result;
      } catch (error) { await conn.rollback().catch(() => {}); throw error; }
      finally { conn.release(); }
    },
    async migrate() { for (const sql of schemaStatements('mysql')) await pool.query(sql); },
    async tableColumns(table) { const [rows] = await pool.query('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]); return rows.map(r => r.name); },
    async tableExists(table) { const [rows] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]); return rows.length > 0; },
    async close() { await pool.end(); },
    isUniqueViolation: error => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062,
  };
}

// DATABASE_URL が mysql:// なら MySQL、それ以外は SQLite ファイル（既定は data/shop.sqlite）。
export async function openDatabase({ url = process.env.DATABASE_URL, sqliteFile } = {}) {
  if (url && /^mysql:\/\//.test(url)) return createMysqlAdapter(url);
  return createSqliteAdapter(sqliteFile);
}
