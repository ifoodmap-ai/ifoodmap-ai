-- =====================================================================
-- migration 20261009120000_market_catalog 的資料庫層測試
-- 執行(還沒套用時要帶 --with-migration;套用之後拿掉再跑一次):
--   SUPABASE_ACCESS_TOKEN=… node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql
-- 本檔不含 BEGIN / ROLLBACK(runner 會包起來);fixture 慣例見 _market_helpers.sql。
-- =====================================================================

-- 身分:A 店員工、B 店員工、管理員、一般登入者(不是供應商)、D 店員工(還沒建零售店家)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'shopper@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-d@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());

INSERT INTO public.suppliers (id, name, contact_email, is_active) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid', true),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid', true),
  ('a9200000-0000-4000-8000-00000000000c', '市集測試 C 店(供應商停用中)', 'store-c@market-test.invalid', false),
  ('a9200000-0000-4000-8000-00000000000d', '市集測試 D 店(還沒建零售店家)', 'store-d@market-test.invalid', true);

INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b'),
  ('a9100000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000d');

INSERT INTO public.supplies (id, supplier_id, name, currency) VALUES
  ('a9500000-0000-4000-8000-0000000000b1', 'a9200000-0000-4000-8000-00000000000b', 'B 店的批發高麗菜', 'TWD');

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
CREATE FUNCTION pg_temp.uadmin() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true) $f$;
CREATE FUNCTION pg_temp.ushop() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000004') $f$;
CREATE FUNCTION pg_temp.ud() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000005') $f$;

-- ---------------------------------------------------------------------
-- 0. 物件與權限
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('anon 對轉帳資訊沒有任何權限',
  has_table_privilege('anon', 'public.market_store_transfer', 'SELECT,INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('anon 不能新增、修改、刪除店家',
  has_table_privilege('anon', 'public.market_stores', 'INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('guard 函式不開給 API 角色',
  (has_function_privilege('authenticated', 'public.market_stores_guard()', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_stores_guard()', 'EXECUTE'))::text, 'false');
SELECT pg_temp.expect('market_store_is_open 開給 anon(公開讀取的 RLS 要用)',
  has_function_privilege('anon', 'public.market_store_is_open(uuid)', 'EXECUTE')::text, 'true');

-- ---------------------------------------------------------------------
-- 1. 零售店家
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('A 建自己的店家(自己填 is_enabled=false)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, ship_days, payment_methods, is_enabled)
    VALUES ('a9200000-0000-4000-8000-00000000000a', ARRAY['新北市', '臺北市', '臺北市'], 120, 1000, 300, 2, ARRAY['cod'], false)$q$),
  'OK');
SELECT pg_temp.expect('供應商不能自己停用:建店時被改回 true',
  (SELECT is_enabled::text FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'), 'true');
SELECT pg_temp.expect('配送縣市去重複、照官方順序存',
  (SELECT array_to_string(delivery_cities, ',') FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'),
  '臺北市,新北市');
SELECT pg_temp.expect('A 不能幫 B 建店家',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'])$q$),
  'ERR 42501');
SELECT pg_temp.expect('B 建自己的店家',
  pg_temp.as_exec('authenticated', pg_temp.ub(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, min_order_amount, ship_days, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, 0, 1, ARRAY['cod'])$q$),
  'OK');
SELECT pg_temp.expect('縣市要用官方寫法(「台北市」被擋)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET delivery_cities = ARRAY['台北市'] WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 23514');
SELECT pg_temp.expect('運費超過 10000 被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET shipping_fee = 10001 WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 23514');
SELECT pg_temp.expect('A 自己改 is_enabled 沒有作用',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_stores SET is_enabled = false
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING is_enabled)
    SELECT is_enabled::text FROM u$q$),
  'true');
SELECT pg_temp.expect('勾銀行轉帳但還沒填轉帳資訊被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET payment_methods = ARRAY['cod', 'transfer'] WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 22023:transfer_info_required');
SELECT pg_temp.expect('A 存轉帳資訊',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
    VALUES ('a9200000-0000-4000-8000-00000000000a', '  台灣銀行(004) 帳號 0123-456-789 戶名 市集測試  ')$q$),
  'OK');
SELECT pg_temp.expect('轉帳資訊去頭尾空白',
  (SELECT transfer_info FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'),
  '台灣銀行(004) 帳號 0123-456-789 戶名 市集測試');
SELECT pg_temp.expect('填好轉帳資訊就能接受轉帳,付款方式排序存',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_stores SET payment_methods = ARRAY['transfer', 'cod']
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING payment_methods)
    SELECT array_to_string(payment_methods, ',') FROM u$q$),
  'cod,transfer');
SELECT pg_temp.expect('logo 放在別家的資料夾被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores
       SET logo_path = 'a9200000-0000-4000-8000-00000000000b/store/a9900000-0000-4000-8000-000000000001.jpg'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 22023:invalid_image_path');
SELECT pg_temp.expect('logo 放在自己的 store 資料夾可以',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores
       SET logo_path = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000001.jpg'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'OK');
SELECT pg_temp.expect('anon 讀不到轉帳資訊',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_store_transfer$q$), 'ERR 42501');
SELECT pg_temp.expect('B 讀不到 A 的轉帳資訊',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '0');
SELECT pg_temp.expect('A 讀得到自己的轉帳資訊',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '1');
SELECT pg_temp.expect('anon 看得到兩家啟用中的店家',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_stores
     WHERE supplier_id IN ('a9200000-0000-4000-8000-00000000000a', 'a9200000-0000-4000-8000-00000000000b')$q$),
  '2');
SELECT pg_temp.expect('管理員停用店家不填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$),
  'ERR 22023:disabled_reason_required');
