-- 本番の MySQL 8.0 で、用途ごとにDBユーザーを分ける（DB管理者が実行する）。
-- データベース名 salon_station、接続元 10.0.0.% とパスワードは環境に合わせて置き換える。
--
--   salon_app      アプリ（npm start）。データの読み書きだけ。表の作成・変更・削除はできない。
--   salon_migrate  版の更新（npm run db:migrate）だけに使う。表の作成・変更ができる。普段はパスワードを金庫に保管する。
--   salon_report   分析用。個人情報を含まないビュー（report_*）と商品・店舗の表だけを読める。
--   salon_backup   バックアップ用。読み取りだけ。お客様の個人情報は暗号化された値のまま出力される。
--
-- 共用サーバー（Xserver の共用プランなど）では、サーバーパネルで作ったユーザーにデータベース全体の権限が付き、
-- このような分け方はできない。その場合も、お客様の個人情報はアプリで暗号化して保存しているため、
-- phpMyAdmin などでDBを直接開いても暗号化された値しか見えない（README「DBへのアクセスとアクセス記録」）。
--
-- 手順：(1) 前半を実行 → (2) salon_migrate で `npm run db:migrate` → (3) 後半を実行 → (4) アプリの DATABASE_URL を salon_app にする

-- ===== 前半：ユーザーの作成と、版の更新用の権限 =====
CREATE USER IF NOT EXISTS 'salon_app'@'10.0.0.%' IDENTIFIED BY 'change-me-app';
CREATE USER IF NOT EXISTS 'salon_migrate'@'10.0.0.%' IDENTIFIED BY 'change-me-migrate';
CREATE USER IF NOT EXISTS 'salon_report'@'10.0.0.%' IDENTIFIED BY 'change-me-report';
CREATE USER IF NOT EXISTS 'salon_backup'@'10.0.0.%' IDENTIFIED BY 'change-me-backup';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ON salon_station.* TO 'salon_migrate'@'10.0.0.%';

-- ===== 後半：npm run db:migrate の後に実行する =====
-- アプリ：データの読み書きだけ（DDL なし）。版が最新なら起動時に表の作成・変更を行わない。
GRANT SELECT, INSERT, UPDATE, DELETE ON salon_station.* TO 'salon_app'@'10.0.0.%';

-- アクセス記録と操作履歴は追記のみ。アプリを含む誰が実行しても、変更・削除は拒否する。
-- 保存期間を過ぎた記録を消すときは、DB管理者がトリガーを外して行い、その作業自体を別に記録する。
DROP TRIGGER IF EXISTS salon_station.data_access_logs_no_update;
DROP TRIGGER IF EXISTS salon_station.data_access_logs_no_delete;
DROP TRIGGER IF EXISTS salon_station.audit_logs_no_update;
DROP TRIGGER IF EXISTS salon_station.audit_logs_no_delete;
CREATE TRIGGER salon_station.data_access_logs_no_update BEFORE UPDATE ON salon_station.data_access_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'アクセス記録は変更できません';
CREATE TRIGGER salon_station.data_access_logs_no_delete BEFORE DELETE ON salon_station.data_access_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'アクセス記録は削除できません';
CREATE TRIGGER salon_station.audit_logs_no_update BEFORE UPDATE ON salon_station.audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '操作履歴は変更できません';
CREATE TRIGGER salon_station.audit_logs_no_delete BEFORE DELETE ON salon_station.audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '操作履歴は削除できません';

-- 分析用ビュー：お届け先・メールなどの列を含めず、会員は会員番号（M-＋IDの英数字の末尾8桁、dist/privacy.js と同じ）で表す。
CREATE OR REPLACE SQL SECURITY DEFINER VIEW salon_station.report_orders AS
  SELECT id, ordered_on, created_at, salon_id, salon_name, staff_id, staff_name,
    CONCAT('M-', UPPER(RIGHT(REGEXP_REPLACE(member_id, '[^0-9A-Za-z]', ''), 8))) AS member_ref,
    fee_rate, fee, subtotal, shipping, total, tax_total, status, payment_status, is_sample
  FROM salon_station.orders;
CREATE OR REPLACE SQL SECURITY DEFINER VIEW salon_station.report_order_items AS
  SELECT order_id, purchase_order_id, line_no, product_id, sku, name, unit_price, unit_cost, quantity, tax_rate, dealer_id
  FROM salon_station.order_items;
CREATE OR REPLACE SQL SECURITY DEFINER VIEW salon_station.report_members AS
  SELECT CONCAT('M-', UPPER(RIGHT(REGEXP_REPLACE(id, '[^0-9A-Za-z]', ''), 8))) AS member_ref,
    salon_id, staff_id, line_id IS NOT NULL AS line_linked, LEFT(COALESCE(salon_linked_at, created_at), 7) AS joined_month, privacy_version
  FROM salon_station.members;
CREATE OR REPLACE SQL SECURITY DEFINER VIEW salon_station.report_supply_orders AS
  SELECT id, salon_id, source, status, subtotal, shipping, total, tax_total, billing_month, invoice_id, ordered_on, created_at
  FROM salon_station.supply_orders;
GRANT SELECT ON salon_station.report_orders TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.report_order_items TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.report_members TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.report_supply_orders TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.products TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.categories TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.salons TO 'salon_report'@'10.0.0.%';
GRANT SELECT ON salon_station.dealers TO 'salon_report'@'10.0.0.%';

-- バックアップ：mysqldump --single-transaction --no-tablespaces --triggers salon_station
GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT ON salon_station.* TO 'salon_backup'@'10.0.0.%';
