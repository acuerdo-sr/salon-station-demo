-- SALON STATION テーブル定義（SQLite）。MySQL 8.0 用は schema.mysql.sql（同じ表・列）。
-- 金額は円の整数（税込）、日時は UTC の ISO 8601 文字列、ordered_on は日本時間の注文日（集計用）。

CREATE TABLE IF NOT EXISTS app_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- 店舗・スタッフ・仕入先
CREATE TABLE IF NOT EXISTS dealers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '', lead_time TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS salons (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  prefecture TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '', building TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', holiday TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  fee_rate INTEGER NOT NULL DEFAULT 5 CHECK (fee_rate BETWEEN 0 AND 30),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY, salon_id TEXT NOT NULL REFERENCES salons(id), name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS staff_salon ON staff(salon_id, active, sort_order);

-- 商品・カテゴリ・お悩み
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS concerns (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, brand TEXT NOT NULL, name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id), size TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 1000000), cost INTEGER NOT NULL CHECK (cost >= 0), wholesale_price INTEGER NOT NULL DEFAULT 0,
  tax_rate INTEGER NOT NULL DEFAULT 10, dealer_id TEXT NOT NULL REFERENCES dealers(id),
  stock INTEGER NOT NULL CHECK (stock >= 0), enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS products_dealer ON products(dealer_id);
CREATE TABLE IF NOT EXISTS product_concerns (
  product_id TEXT NOT NULL REFERENCES products(id), concern_id TEXT NOT NULL REFERENCES concerns(id),
  PRIMARY KEY (product_id, concern_id));

-- 会員（担当店舗・担当スタッフ・LINE ID を含む）。メール・氏名・フリガナ・電話・性別・生年月日はアプリで暗号化して保存し（db/crypto.mjs）、
-- メールアドレスでの検索・重複確認は email_index（鍵付きハッシュ）で行う。
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, email_index TEXT, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, kana TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '', birthday TEXT NOT NULL DEFAULT '',
  line_id TEXT UNIQUE, salon_id TEXT REFERENCES salons(id), staff_id TEXT REFERENCES staff(id), salon_linked_at TEXT,
  privacy_version TEXT, privacy_agreed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS members_salon ON members(salon_id);
CREATE UNIQUE INDEX IF NOT EXISTS members_email_index ON members(email_index);
CREATE TABLE IF NOT EXISTS member_sessions (
  token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_sessions_member ON member_sessions(member_id);
-- お届け先の住所録（1会員10件まで。お名前・郵便番号・住所・電話番号は暗号化して保存）
CREATE TABLE IF NOT EXISTS member_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL, postal TEXT NOT NULL, address TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS member_addresses_member ON member_addresses(member_id, is_default);
-- 会員のクレジットカード。決済代行のトークン（暗号化）とブランド・下4桁・有効期限だけを保存し、カード番号は持たない
CREATE TABLE IF NOT EXISTS member_cards (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, provider TEXT NOT NULL,
  token TEXT NOT NULL, brand TEXT NOT NULL, last4 TEXT NOT NULL, exp_month INTEGER NOT NULL, exp_year INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS member_cards_member ON member_cards(member_id);
-- パスワード再設定。トークンはハッシュだけを保存し、有効期限は30分・1回限り
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS password_resets_member ON password_resets(member_id);
-- 送信したメールの記録。ローカル版は送信せずにここへ保存する（宛先と本文は暗号化）
CREATE TABLE IF NOT EXISTS mail_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_address TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  transport TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);

-- 管理者（本部・美容室・ディーラー）
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','salon','dealer')),
  salon_id TEXT REFERENCES salons(id), dealer_id TEXT REFERENCES dealers(id),
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, line_id TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS operators_line_id ON operators(line_id);
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL, expires_at INTEGER NOT NULL);

-- 購入前（端末をまたぐカートとお気に入り）
CREATE TABLE IF NOT EXISTS cart_items (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99), updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, product_id));
-- 加盟店のお気に入り（いつもの商品）
CREATE TABLE IF NOT EXISTS supply_favorites (
  salon_id TEXT NOT NULL REFERENCES salons(id), product_id TEXT NOT NULL REFERENCES products(id),
  created_at TEXT NOT NULL, PRIMARY KEY (salon_id, product_id));
CREATE TABLE IF NOT EXISTS favorites (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id),
  created_at TEXT NOT NULL, PRIMARY KEY (member_id, product_id));

-- 注文（注文時点の価格・店舗・担当者・お届け先を写して保存する）。お届け先 ship_* と返品理由は暗号化して保存し、
-- 再送の照合用 fingerprint（お届け先を含む注文内容）は鍵付きハッシュで保存する。
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id), salon_id TEXT NOT NULL REFERENCES salons(id),
  salon_name TEXT NOT NULL, seller TEXT NOT NULL, staff_id TEXT NOT NULL DEFAULT '', staff_name TEXT NOT NULL,
  fee_rate INTEGER NOT NULL, fee INTEGER NOT NULL, subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL, tax_total INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'card',
  status TEXT NOT NULL CHECK (status IN ('ordered','processing','partially_shipped','shipped','delivered','cancelled','return_requested','returned')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending','captured','refunded','voided')),
  ship_name TEXT NOT NULL, ship_postal TEXT NOT NULL, ship_address TEXT NOT NULL, ship_phone TEXT NOT NULL DEFAULT '', ship_email TEXT NOT NULL,
  return_reason TEXT, stock_restored INTEGER NOT NULL DEFAULT 0, is_sample INTEGER NOT NULL DEFAULT 0,
  ordered_on TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS orders_salon_date ON orders(salon_id, ordered_on);
CREATE INDEX IF NOT EXISTS orders_member ON orders(member_id, created_at);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), dealer_id TEXT NOT NULL REFERENCES dealers(id),
  salon_id TEXT NOT NULL REFERENCES salons(id), seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','shipped','delivered','cancelled','returned')),
  shipping INTEGER NOT NULL, total INTEGER NOT NULL, carrier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '',
  shipped_at TEXT, delivered_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS purchase_orders_order ON purchase_orders(order_id);
CREATE INDEX IF NOT EXISTS purchase_orders_dealer ON purchase_orders(dealer_id, status, created_at);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id), line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, size TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL, unit_cost INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  tax_rate INTEGER NOT NULL, dealer_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id, line_no);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), occurred_at TEXT NOT NULL, label TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id, id);

-- 決済・返金（お支払いはクレジットカードのみ。カード情報は持たず、決済代行の取引IDと状態だけを保存する）
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS payments_order ON payments(order_id);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);

-- 在庫の増減履歴・操作履歴・通知の送信記録
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL REFERENCES products(id), delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('initial','order','cancel','return','adjust')), reference TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '');
-- お客様の個人情報へのアクセス記録（誰が・いつ・どの店舗のお客様の情報を・何件・何のために）。値そのものは記録しない。
-- 役割（美容室・ディーラー・DB保守など）・操作（表示・CSV出力・保守ツールで参照）・対象・経路は日本語で保存する（dist/access-log.js）。
-- 追記のみ：SQLite では変更・削除を拒否するトリガーを起動時に作る。MySQL では db/grants.mysql.sql でアプリに追加と参照の権限だけを与える。
CREATE TABLE IF NOT EXISTS data_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, role TEXT NOT NULL,
  salon_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0, member_refs TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS data_access_logs_salon ON data_access_logs(salon_id, id);
CREATE INDEX IF NOT EXISTS data_access_logs_actor ON data_access_logs(actor_id, action, target, id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (channel, kind, reference));

-- 加盟店（サロン）からフランチャイザーへの仕入発注。卸価格・お届け先（店舗）を発注時点で保存する。
CREATE TABLE IF NOT EXISTS supply_orders (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, salon_id TEXT NOT NULL REFERENCES salons(id),
  operator_id TEXT NOT NULL, operator_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','reorder','suggestion','subscription')), subscription_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ordered','accepted','shipped','delivered','cancelled')),
  subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL, tax_total INTEGER NOT NULL,
  ship_name TEXT NOT NULL, ship_address TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  carrier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', shipped_at TEXT, delivered_at TEXT,
  billing_month TEXT NOT NULL, invoice_id TEXT, stock_restored INTEGER NOT NULL DEFAULT 0,
  ordered_on TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS supply_orders_salon ON supply_orders(salon_id, created_at);
CREATE INDEX IF NOT EXISTS supply_orders_billing ON supply_orders(billing_month, salon_id);
CREATE TABLE IF NOT EXISTS supply_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, supply_order_id TEXT NOT NULL REFERENCES supply_orders(id), line_no INTEGER NOT NULL,
  product_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, size TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  unit_price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999), tax_rate INTEGER NOT NULL DEFAULT 10);
CREATE INDEX IF NOT EXISTS supply_order_items_order ON supply_order_items(supply_order_id, line_no);
-- 定期発注（毎週・2週間ごと・毎月）
CREATE TABLE IF NOT EXISTS supply_subscriptions (
  id TEXT PRIMARY KEY, salon_id TEXT NOT NULL REFERENCES salons(id), operator_id TEXT NOT NULL,
  interval_code TEXT NOT NULL CHECK (interval_code IN ('weekly','biweekly','monthly')), next_run_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, last_run_on TEXT NOT NULL DEFAULT '', last_result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS supply_subscriptions_due ON supply_subscriptions(active, next_run_on);
CREATE TABLE IF NOT EXISTS supply_subscription_items (
  subscription_id TEXT NOT NULL REFERENCES supply_subscriptions(id) ON DELETE CASCADE, product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999), line_no INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (subscription_id, product_id));
-- 月末締めの請求書（加盟店ごと・月ごとに1通）
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, salon_id TEXT NOT NULL REFERENCES salons(id), billing_month TEXT NOT NULL,
  bill_to_name TEXT NOT NULL, bill_to_address TEXT NOT NULL, salon_name TEXT NOT NULL,
  issued_on TEXT NOT NULL, due_on TEXT NOT NULL, order_count INTEGER NOT NULL,
  subtotal INTEGER NOT NULL, tax_total INTEGER NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued','paid')), paid_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (salon_id, billing_month));
