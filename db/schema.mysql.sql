-- SALON STATION テーブル定義（MySQL 8.4 LTS。8.0 の構文の範囲で書いている）。SQLite 用 schema.sqlite.sql と同じ表・列。
-- 文字コードは utf8mb4。金額は円の整数（税込）、日時は UTC の ISO 8601 文字列、ordered_on は日本時間の注文日。

CREATE TABLE IF NOT EXISTS app_meta (meta_key VARCHAR(64) PRIMARY KEY, meta_value VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS counters (name VARCHAR(64) PRIMARY KEY, value BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dealers (
  id VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, short_name VARCHAR(40) NOT NULL,
  area VARCHAR(100) NOT NULL DEFAULT '', lead_time VARCHAR(100) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS salons (
  id VARCHAR(20) PRIMARY KEY, name VARCHAR(100) NOT NULL, owner VARCHAR(100) NOT NULL,
  area VARCHAR(60) NOT NULL DEFAULT '', description VARCHAR(200) NOT NULL DEFAULT '',
  prefecture VARCHAR(10) NOT NULL DEFAULT '', city VARCHAR(50) NOT NULL DEFAULT '', street VARCHAR(100) NOT NULL DEFAULT '', building VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(15) NOT NULL DEFAULT '', hours VARCHAR(50) NOT NULL DEFAULT '', holiday VARCHAR(50) NOT NULL DEFAULT '', notes VARCHAR(500) NOT NULL DEFAULT '',
  fee_rate INT NOT NULL DEFAULT 5, enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  CONSTRAINT salons_fee_rate CHECK (fee_rate BETWEEN 0 AND 30)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS staff (
  id VARCHAR(40) PRIMARY KEY, salon_id VARCHAR(20) NOT NULL, name VARCHAR(40) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1,
  KEY staff_salon (salon_id, active, sort_order), FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS categories (id VARCHAR(40) PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE, sort_order INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS concerns (id VARCHAR(40) PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE, sort_order INT NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(40) PRIMARY KEY, sku VARCHAR(40) NOT NULL UNIQUE, brand VARCHAR(100) NOT NULL, name VARCHAR(100) NOT NULL,
  category_id VARCHAR(40) NOT NULL, size VARCHAR(40) NOT NULL DEFAULT '', summary VARCHAR(200) NOT NULL DEFAULT '', description TEXT NOT NULL,
  image VARCHAR(255) NOT NULL DEFAULT '', tag VARCHAR(40) NOT NULL DEFAULT '',
  price INT NOT NULL, cost INT NOT NULL, wholesale_price INT NOT NULL DEFAULT 0, tax_rate INT NOT NULL DEFAULT 10, dealer_id VARCHAR(40) NOT NULL,
  stock INT NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, updated_at VARCHAR(30) NOT NULL,
  KEY products_dealer (dealer_id),
  CONSTRAINT products_price CHECK (price BETWEEN 1 AND 1000000), CONSTRAINT products_cost CHECK (cost >= 0), CONSTRAINT products_stock CHECK (stock >= 0),
  FOREIGN KEY (category_id) REFERENCES categories(id), FOREIGN KEY (dealer_id) REFERENCES dealers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS product_concerns (
  product_id VARCHAR(40) NOT NULL, concern_id VARCHAR(40) NOT NULL, PRIMARY KEY (product_id, concern_id),
  FOREIGN KEY (product_id) REFERENCES products(id), FOREIGN KEY (concern_id) REFERENCES concerns(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 会員。メール・氏名・フリガナ・電話・性別・生年月日は暗号化した値（enc:v1:…）を保存するため列を広く取る。検索は email_index。
CREATE TABLE IF NOT EXISTS members (
  id VARCHAR(40) PRIMARY KEY, email VARCHAR(512) NOT NULL, email_index VARCHAR(64) NULL, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL,
  name VARCHAR(512) NOT NULL, kana VARCHAR(512) NOT NULL DEFAULT '', phone VARCHAR(128) NOT NULL DEFAULT '', gender VARCHAR(128) NOT NULL DEFAULT '', birthday VARCHAR(128) NOT NULL DEFAULT '',
  line_id VARCHAR(100) NULL UNIQUE, salon_id VARCHAR(20) NULL, staff_id VARCHAR(40) NULL, salon_linked_at VARCHAR(30) NULL,
  privacy_version VARCHAR(20) NULL, privacy_agreed_at VARCHAR(30) NULL,
  created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  UNIQUE KEY members_email_index (email_index), KEY members_salon (salon_id), FOREIGN KEY (salon_id) REFERENCES salons(id), FOREIGN KEY (staff_id) REFERENCES staff(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS member_sessions (
  token_hash CHAR(64) PRIMARY KEY, member_id VARCHAR(40) NOT NULL, expires_at BIGINT NOT NULL,
  KEY member_sessions_member (member_id), FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS member_addresses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, member_id VARCHAR(40) NOT NULL,
  name VARCHAR(512) NOT NULL, postal VARCHAR(128) NOT NULL, address VARCHAR(1500) NOT NULL, phone VARCHAR(256) NOT NULL DEFAULT '', is_default TINYINT(1) NOT NULL DEFAULT 1, updated_at VARCHAR(30) NOT NULL,
  KEY member_addresses_member (member_id, is_default), FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- 会員のクレジットカード（決済代行のトークンは暗号化。カード番号は持たない）
CREATE TABLE IF NOT EXISTS member_cards (
  id VARCHAR(40) PRIMARY KEY, member_id VARCHAR(40) NOT NULL, provider VARCHAR(40) NOT NULL,
  token VARCHAR(512) NOT NULL, brand VARCHAR(20) NOT NULL, last4 CHAR(4) NOT NULL, exp_month INT NOT NULL, exp_year INT NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0, created_at VARCHAR(30) NOT NULL,
  KEY member_cards_member (member_id), FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- パスワード再設定（トークンはハッシュだけ。30分・1回限り）
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash CHAR(64) PRIMARY KEY, member_id VARCHAR(40) NOT NULL, expires_at BIGINT NOT NULL, used_at VARCHAR(30) NULL, created_at VARCHAR(30) NOT NULL,
  KEY password_resets_member (member_id), FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- 送信したメールの記録（宛先と本文は暗号化）
CREATE TABLE IF NOT EXISTS mail_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, to_address VARCHAR(600) NOT NULL, subject VARCHAR(200) NOT NULL, body TEXT NOT NULL,
  transport VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, error VARCHAR(300) NOT NULL DEFAULT '', created_at VARCHAR(30) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS operators (
  id VARCHAR(40) PRIMARY KEY, email VARCHAR(150) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL,
  role VARCHAR(10) NOT NULL, salon_id VARCHAR(20) NULL, dealer_id VARCHAR(40) NULL,
  password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, line_id VARCHAR(100) NULL UNIQUE, created_at VARCHAR(30) NOT NULL,
  CONSTRAINT operators_role CHECK (role IN ('admin','salon','dealer')),
  FOREIGN KEY (salon_id) REFERENCES salons(id), FOREIGN KEY (dealer_id) REFERENCES dealers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash CHAR(64) PRIMARY KEY, operator_id VARCHAR(40) NOT NULL, expires_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS cart_items (
  member_id VARCHAR(40) NOT NULL, product_id VARCHAR(40) NOT NULL, quantity INT NOT NULL, updated_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (member_id, product_id), CONSTRAINT cart_items_quantity CHECK (quantity BETWEEN 1 AND 99),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE, FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- 加盟店のお気に入り（いつもの商品）
CREATE TABLE IF NOT EXISTS supply_favorites (
  salon_id VARCHAR(20) NOT NULL, product_id VARCHAR(40) NOT NULL, created_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (salon_id, product_id),
  FOREIGN KEY (salon_id) REFERENCES salons(id), FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS favorites (
  member_id VARCHAR(40) NOT NULL, product_id VARCHAR(40) NOT NULL, created_at VARCHAR(30) NOT NULL,
  PRIMARY KEY (member_id, product_id),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE, FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(40) PRIMARY KEY, request_key VARCHAR(80) NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  member_id VARCHAR(40) NOT NULL, salon_id VARCHAR(20) NOT NULL,
  salon_name VARCHAR(100) NOT NULL, seller VARCHAR(100) NOT NULL, staff_id VARCHAR(40) NOT NULL DEFAULT '', staff_name VARCHAR(40) NOT NULL,
  fee_rate INT NOT NULL, fee INT NOT NULL, subtotal INT NOT NULL, shipping INT NOT NULL, total INT NOT NULL, tax_total INT NOT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'card',
  status VARCHAR(20) NOT NULL, payment_status VARCHAR(20) NOT NULL,
  ship_name VARCHAR(512) NOT NULL, ship_postal VARCHAR(128) NOT NULL, ship_address VARCHAR(1500) NOT NULL, ship_phone VARCHAR(256) NOT NULL DEFAULT '', ship_email VARCHAR(512) NOT NULL,
  return_reason VARCHAR(1700) NULL, stock_restored TINYINT(1) NOT NULL DEFAULT 0, is_sample TINYINT(1) NOT NULL DEFAULT 0,
  ordered_on CHAR(10) NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  KEY orders_salon_date (salon_id, ordered_on), KEY orders_member (member_id, created_at), KEY orders_created (created_at),
  CONSTRAINT orders_status CHECK (status IN ('ordered','processing','partially_shipped','shipped','delivered','cancelled','return_requested','returned')),
  CONSTRAINT orders_payment CHECK (payment_status IN ('captured','refunded')),
  FOREIGN KEY (member_id) REFERENCES members(id), FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS purchase_orders (
  id VARCHAR(50) PRIMARY KEY, order_id VARCHAR(40) NOT NULL, dealer_id VARCHAR(40) NOT NULL, salon_id VARCHAR(20) NOT NULL, seq INT NOT NULL,
  status VARCHAR(20) NOT NULL, shipping INT NOT NULL, total INT NOT NULL, carrier VARCHAR(40) NOT NULL DEFAULT '', tracking VARCHAR(60) NOT NULL DEFAULT '',
  shipped_at VARCHAR(30) NULL, delivered_at VARCHAR(30) NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  KEY purchase_orders_order (order_id), KEY purchase_orders_dealer (dealer_id, status, created_at),
  CONSTRAINT purchase_orders_status CHECK (status IN ('pending','accepted','shipped','delivered','cancelled','returned')),
  FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (dealer_id) REFERENCES dealers(id), FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(40) NOT NULL, purchase_order_id VARCHAR(50) NOT NULL, line_no INT NOT NULL,
  product_id VARCHAR(40) NOT NULL, sku VARCHAR(40) NOT NULL, name VARCHAR(100) NOT NULL, size VARCHAR(40) NOT NULL DEFAULT '', image VARCHAR(255) NOT NULL DEFAULT '',
  unit_price INT NOT NULL, unit_cost INT NOT NULL, quantity INT NOT NULL, tax_rate INT NOT NULL, dealer_id VARCHAR(40) NOT NULL,
  KEY order_items_order (order_id, line_no), CONSTRAINT order_items_quantity CHECK (quantity BETWEEN 1 AND 99),
  FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS order_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(40) NOT NULL, occurred_at VARCHAR(30) NOT NULL, label VARCHAR(200) NOT NULL,
  KEY order_events_order (order_id, id), FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(40) NOT NULL, provider VARCHAR(40) NOT NULL, provider_payment_id VARCHAR(100) NOT NULL,
  amount INT NOT NULL, status VARCHAR(20) NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  KEY payments_order (order_id), FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS refunds (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(40) NOT NULL, amount INT NOT NULL, reason VARCHAR(300) NOT NULL, created_at VARCHAR(30) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, product_id VARCHAR(40) NOT NULL, delta INT NOT NULL, reason VARCHAR(10) NOT NULL,
  reference VARCHAR(60) NOT NULL DEFAULT '', actor VARCHAR(80) NOT NULL DEFAULT '', occurred_at VARCHAR(30) NOT NULL,
  KEY stock_movements_product (product_id, id),
  CONSTRAINT stock_movements_reason CHECK (reason IN ('initial','order','cancel','return','adjust')),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, occurred_at VARCHAR(30) NOT NULL, actor VARCHAR(80) NOT NULL, action VARCHAR(100) NOT NULL, reference VARCHAR(60) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- お客様の個人情報へのアクセス記録（値そのものは記録しない）。役割・操作・対象・経路は日本語で保存する。
-- 追記のみ：アプリ用ユーザーには追加と参照の権限だけを与える（db/grants.mysql.sql）。
CREATE TABLE IF NOT EXISTS data_access_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, occurred_at VARCHAR(30) NOT NULL,
  actor_id VARCHAR(80) NOT NULL, actor_name VARCHAR(80) NOT NULL, role VARCHAR(20) NOT NULL,
  salon_id VARCHAR(20) NOT NULL DEFAULT '', action VARCHAR(20) NOT NULL, target VARCHAR(40) NOT NULL,
  record_count INT NOT NULL DEFAULT 0, member_refs VARCHAR(200) NOT NULL DEFAULT '', purpose VARCHAR(200) NOT NULL DEFAULT '',
  channel VARCHAR(20) NOT NULL, ip VARCHAR(60) NOT NULL DEFAULT '',
  KEY data_access_logs_salon (salon_id, id), KEY data_access_logs_actor (actor_id, action, target, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, member_id VARCHAR(40) NOT NULL, channel VARCHAR(20) NOT NULL, kind VARCHAR(40) NOT NULL, reference VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL, error VARCHAR(300) NOT NULL DEFAULT '', created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  UNIQUE KEY notifications_once (channel, kind, reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS supply_orders (
  id VARCHAR(40) PRIMARY KEY, request_key VARCHAR(80) NOT NULL UNIQUE, salon_id VARCHAR(20) NOT NULL,
  operator_id VARCHAR(40) NOT NULL, operator_name VARCHAR(80) NOT NULL, source VARCHAR(20) NOT NULL, subscription_id VARCHAR(40) NULL,
  status VARCHAR(20) NOT NULL, subtotal INT NOT NULL, shipping INT NOT NULL, total INT NOT NULL, tax_total INT NOT NULL,
  ship_name VARCHAR(100) NOT NULL, ship_address VARCHAR(300) NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '',
  carrier VARCHAR(40) NOT NULL DEFAULT '', tracking VARCHAR(60) NOT NULL DEFAULT '', shipped_at VARCHAR(30) NULL, delivered_at VARCHAR(30) NULL,
  billing_month CHAR(7) NOT NULL, invoice_id VARCHAR(40) NULL, stock_restored TINYINT(1) NOT NULL DEFAULT 0,
  ordered_on CHAR(10) NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  KEY supply_orders_salon (salon_id, created_at), KEY supply_orders_billing (billing_month, salon_id),
  CONSTRAINT supply_orders_source CHECK (source IN ('manual','reorder','suggestion','subscription')),
  CONSTRAINT supply_orders_status CHECK (status IN ('ordered','accepted','shipped','delivered','cancelled')),
  FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS supply_order_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, supply_order_id VARCHAR(40) NOT NULL, line_no INT NOT NULL,
  product_id VARCHAR(40) NOT NULL, sku VARCHAR(40) NOT NULL, name VARCHAR(100) NOT NULL, size VARCHAR(40) NOT NULL DEFAULT '', image VARCHAR(255) NOT NULL DEFAULT '',
  unit_price INT NOT NULL, quantity INT NOT NULL, tax_rate INT NOT NULL DEFAULT 10,
  KEY supply_order_items_order (supply_order_id, line_no), CONSTRAINT supply_order_items_quantity CHECK (quantity BETWEEN 1 AND 999),
  FOREIGN KEY (supply_order_id) REFERENCES supply_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS supply_subscriptions (
  id VARCHAR(40) PRIMARY KEY, salon_id VARCHAR(20) NOT NULL, operator_id VARCHAR(40) NOT NULL, interval_code VARCHAR(10) NOT NULL,
  next_run_on CHAR(10) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, last_run_on VARCHAR(10) NOT NULL DEFAULT '', last_result VARCHAR(300) NOT NULL DEFAULT '',
  created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  KEY supply_subscriptions_due (active, next_run_on), CONSTRAINT supply_subscriptions_interval CHECK (interval_code IN ('weekly','biweekly','monthly')),
  FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS supply_subscription_items (
  subscription_id VARCHAR(40) NOT NULL, product_id VARCHAR(40) NOT NULL, quantity INT NOT NULL, line_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (subscription_id, product_id), CONSTRAINT supply_subscription_items_quantity CHECK (quantity BETWEEN 1 AND 999),
  FOREIGN KEY (subscription_id) REFERENCES supply_subscriptions(id) ON DELETE CASCADE, FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS invoices (
  id VARCHAR(40) PRIMARY KEY, salon_id VARCHAR(20) NOT NULL, billing_month CHAR(7) NOT NULL,
  bill_to_name VARCHAR(100) NOT NULL, bill_to_address VARCHAR(300) NOT NULL, salon_name VARCHAR(100) NOT NULL,
  issued_on CHAR(10) NOT NULL, due_on CHAR(10) NOT NULL, order_count INT NOT NULL,
  subtotal INT NOT NULL, tax_total INT NOT NULL, total INT NOT NULL, status VARCHAR(10) NOT NULL, paid_at VARCHAR(30) NULL,
  created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
  UNIQUE KEY invoices_salon_month (salon_id, billing_month), CONSTRAINT invoices_status CHECK (status IN ('issued','paid')),
  FOREIGN KEY (salon_id) REFERENCES salons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
