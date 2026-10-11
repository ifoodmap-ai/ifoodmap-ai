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

-- ---------------------------------------------------------------------
-- 2. 零售商品與審核
-- ---------------------------------------------------------------------
-- 核准時 guard 會檢查每張照片與它的 _t 縮圖都已經在 Storage(見第 4 節):先建 bucket(本檔只帶 120000;
-- 已經有就沿用)與 P1 會用到的照片物件。資料庫擁有者身分直接寫,交易最後 ROLLBACK,不留任何東西(也沒有真的檔案)。
INSERT INTO storage.buckets (id, name, public) VALUES ('market-images', 'market-images', true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000002.jpg'),
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000002_t.jpg'),
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004.jpg'),
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004_t.jpg');
SELECT pg_temp.expect('anon 不能新增、修改、刪除商品',
  has_table_privilege('anon', 'public.market_products', 'INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('商品 guard 不開給 API 角色',
  has_function_privilege('authenticated', 'public.market_products_guard()', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('A 新增草稿商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, photos)
    VALUES ('a9300000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a', '  有機高麗菜  ', 'vegetable',
            '1 顆(約 1.2 公斤)', 120, 10, 'chilled',
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000002.jpg'])$q$),
  'OK');
SELECT pg_temp.expect('品名去頭尾空白、預設是草稿、還沒有送審時間',
  (SELECT name || '|' || review_status || '|' || (submitted_at IS NULL)::text
     FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'),
  '有機高麗菜|draft|true');
SELECT pg_temp.expect('供應商不能直接新增成已核准',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, review_status)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '偷上架', 'fruit', '1 盒', 100, 'approved')$q$),
  'ERR 42501:review_status_forbidden');
SELECT pg_temp.expect('A 不能替 B 新增商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b', '冒名', 'fruit', '1 盒', 100)$q$),
  'ERR 42501');
SELECT pg_temp.expect('對應到別家的批發商品被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, supply_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a',
            'a9500000-0000-4000-8000-0000000000b1', '借別人的', 'vegetable', '1 顆', 100)$q$),
  'ERR 22023:supply_not_owned');
SELECT pg_temp.expect('照片放在別的商品資料夾被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '照片錯資料夾', 'fruit', '1 盒', 100,
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000003.jpg'])$q$),
  'ERR 22023:invalid_photo_path');
SELECT pg_temp.expect('縮圖(_t)不能當商品照片',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '拿縮圖', 'fruit', '1 盒', 100,
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000002/a9900000-0000-4000-8000-000000000003_t.jpg'])$q$),
  'ERR 22023:invalid_photo_path');
SELECT pg_temp.expect('照片超過 5 張被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    SELECT 'a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '六張照片', 'fruit', '1 盒', 100,
           ARRAY(SELECT 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000002/a9900000-0000-4000-8000-00000000001' || n || '.jpg'
                   FROM generate_series(0, 5) AS n)$q$),
  'ERR 23514');
SELECT pg_temp.expect('品名超過 60 字被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', repeat('菜', 61), 'vegetable', '1 顆', 100)$q$),
  'ERR 23514');
SELECT pg_temp.expect('價格 0 元被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '免費', 'vegetable', '1 顆', 0)$q$),
  'ERR 23514');
SELECT pg_temp.expect('分類不在 12 類裡被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '紅酒', 'alcohol', '1 瓶', 900)$q$),
  'ERR 23514');
SELECT pg_temp.expect('還沒建零售店家的供應商不能新增商品(外鍵)',
  pg_temp.as_exec('authenticated', pg_temp.ud(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-0000000000d1', 'a9200000-0000-4000-8000-00000000000d', '沒有店', 'fruit', '1 盒', 100)$q$),
  'ERR 23503');
SELECT pg_temp.expect('A 送出審核',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET review_status = 'pending' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('送審時間由伺服器填',
  (SELECT (submitted_at IS NOT NULL)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'), 'true');
SELECT pg_temp.expect('供應商不能自己核准',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:review_status_forbidden');
SELECT pg_temp.expect('anon 看不到待審商品',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('B 看不到 A 的待審商品',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('管理員退回不填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'rejected' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 22023:reject_reason_required');
SELECT pg_temp.expect('管理員退回(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'rejected', reject_reason = '照片太暗'
     WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('退回後 A 改內容:原因保留(還沒重新送審)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET description = '更新說明'
                WHERE id = 'a9300000-0000-4000-8000-000000000001'
                RETURNING review_status || '|' || COALESCE(reject_reason, '∅') AS v)
    SELECT v FROM u$q$),
  'rejected|照片太暗');
SELECT pg_temp.expect('A 重新送審,原因清掉',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET review_status = 'pending'
                WHERE id = 'a9300000-0000-4000-8000-000000000001'
                RETURNING review_status || '|' || COALESCE(reject_reason, '∅') AS v)
    SELECT v FROM u$q$),
  'pending|∅');
SELECT pg_temp.expect('管理員核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('核准者與時間由伺服器填',
  (SELECT reviewed_by::text || '|' || (reviewed_at IS NOT NULL)::text
     FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'),
  'a9100000-0000-4000-8000-000000000003|true');
SELECT pg_temp.expect('anon 看得到已核准、上架中、店家啟用的商品',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '1');
SELECT pg_temp.expect('一般登入者(不是供應商)也看得到',
  pg_temp.as_val('authenticated', pg_temp.ushop(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '1');
SELECT pg_temp.expect('B 看得到 A 上架中的商品,但改不了(0 列)',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH u AS (UPDATE public.market_products SET price = 1 WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '0');
SELECT pg_temp.expect('A 改價格、庫存不用重審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET price = 99, stock = 5
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'approved');
SELECT pg_temp.expect('A 改品名就回到待審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET name = '有機高麗菜(大)'
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'pending');
SELECT pg_temp.expect('回到待審後 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('管理員再核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('A 換照片也要重審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products
                  SET photos = ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004.jpg']
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'pending');
SELECT pg_temp.expect('管理員第三次核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('A 關掉上架開關:狀態仍是已核准',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET is_listed = false
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'approved');
SELECT pg_temp.expect('關掉上架開關後 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('A 重新打開上架開關',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET is_listed = true WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('管理員停用 A 的零售(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false, disabled_reason = '客訴處理中'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'OK');
SELECT pg_temp.expect('店家停用後 anon 看不到商品、也看不到店家',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT (SELECT count(*) FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001')::text || '|' ||
           (SELECT count(*) FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a')::text$q$),
  '0|0');
SELECT pg_temp.expect('A 自己看得到停用原因',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT disabled_reason FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '客訴處理中');
SELECT pg_temp.expect('管理員恢復零售,原因清掉',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    WITH u AS (UPDATE public.market_stores SET is_enabled = true
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING COALESCE(disabled_reason, '∅') AS v)
    SELECT v FROM u$q$),
  '∅');
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(), $q$
  INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000c', ARRAY['臺北市'])$q$);
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, review_status)
  VALUES ('a9300000-0000-4000-8000-0000000000c1', 'a9200000-0000-4000-8000-00000000000c', '停用供應商的商品', 'fruit', '1 盒', 100, 'approved')$q$);
SELECT pg_temp.expect('供應商停用中(suppliers.is_active = false)的商品 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000c1'$q$), '0');
SELECT pg_temp.expect('A 不能把商品搬到 B',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET supplier_id = 'a9200000-0000-4000-8000-00000000000b'
     WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:supplier_immutable');
SELECT pg_temp.expect('anon 不能新增商品',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.market_products (supplier_id, name, category, spec, price)
    VALUES ('a9200000-0000-4000-8000-00000000000a', '匿名', 'fruit', '1 盒', 100)$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 新增第二個草稿商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000003', 'a9200000-0000-4000-8000-00000000000a', '要刪的草稿', 'fruit', '1 盒', 100)$q$),
  'OK');
SELECT pg_temp.expect('A 刪掉自己的草稿商品',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH d AS (DELETE FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000003' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '1');
SELECT pg_temp.expect('B 刪不掉 A 的商品',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH d AS (DELETE FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '0');

-- ---------------------------------------------------------------------
-- 3. 審查後補強(2026-10-10,見計畫「勘誤」):刪店洗掉停用、created_at、guard 先檢查擁有權、
--    資料表權限(PG17 的 MAINTAIN)、全形空白 / 零寬字元的品名、二維 / NULL 的 photos、草稿的 submitted_at
-- ---------------------------------------------------------------------
-- D 存轉帳資訊(資料庫擁有者身分;B 沒有存):替別家建店時,別家有沒有轉帳資訊都要回一樣的錯
INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
VALUES ('a9200000-0000-4000-8000-00000000000d', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 D');
SELECT pg_temp.expect('替別家建店家並勾轉帳:別家有沒有轉帳資訊都回 42501(guard 先檢查擁有權)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$)
  || '|' ||
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000d', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$),
  'ERR 42501|ERR 42501');
SELECT pg_temp.expect('D 建自己的店家(自己帶 created_at = 2099)',
  pg_temp.as_exec('authenticated', pg_temp.ud(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, created_at)
    VALUES ('a9200000-0000-4000-8000-00000000000d', ARRAY['臺北市'], '2099-01-01 00:00+08')$q$),
  'OK');
SELECT pg_temp.expect('建店時自己帶的 created_at 被改成現在',
  (SELECT (created_at = now())::text FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000d'), 'true');
SELECT pg_temp.expect('管理員停用 D 的零售(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false, disabled_reason = '測試停用'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000d'$q$),
  'OK');
SELECT pg_temp.expect('停用後 D 刪不掉店家(0 列;刪掉再重建就能洗掉停用)',
  pg_temp.as_val('authenticated', pg_temp.ud(), $q$
    WITH d AS (DELETE FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000d' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '0');
SELECT pg_temp.expect('D 的店家還在、仍停用、原因保留',
  pg_temp.as_val('authenticated', pg_temp.ud(), $q$
    SELECT is_enabled::text || '|' || disabled_reason FROM public.market_stores
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000d'$q$),
  'false|測試停用');
SELECT pg_temp.expect('三張表:anon / authenticated 都沒有 MAINTAIN、TRUNCATE、REFERENCES、TRIGGER',
  (SELECT COALESCE(string_agg(r || ' ' || t, ',' ORDER BY r, t), '無')
     FROM unnest(ARRAY['anon', 'authenticated']) AS r,
          unnest(ARRAY['market_stores', 'market_store_transfer', 'market_products']) AS t
    WHERE has_table_privilege(r, 'public.' || t, 'MAINTAIN,TRUNCATE,REFERENCES,TRIGGER')),
  '無');
SELECT pg_temp.expect('該有的權限都在:anon 讀店家與商品;authenticated 讀寫三張表(細分靠 RLS)',
  (has_table_privilege('anon', 'public.market_stores', 'SELECT')
   AND has_table_privilege('anon', 'public.market_products', 'SELECT')
   AND (SELECT bool_and(has_table_privilege('authenticated', 'public.' || t, p))
          FROM unnest(ARRAY['market_stores', 'market_store_transfer', 'market_products']) AS t,
               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p))::text,
  'true');
SELECT pg_temp.expect('A 新增草稿商品(品名前後有全形空白、零寬字元,自己帶 created_at 與 submitted_at)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, created_at, submitted_at)
    VALUES ('a9300000-0000-4000-8000-000000000004', 'a9200000-0000-4000-8000-00000000000a',
            chr(12288) || '有機菠菜' || chr(8203) || ' ', 'vegetable', '1 把', 60, '2099-01-01 00:00+08', '2020-01-01 00:00+08')$q$),
  'OK');
SELECT pg_temp.expect('品名前後的全形空白(U+3000)、零寬字元(U+200B)會去掉',
  (SELECT name FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000004'), '有機菠菜');
SELECT pg_temp.expect('新增商品自己帶的 created_at 被改成現在',
  (SELECT (created_at = now())::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000004'), 'true');
SELECT pg_temp.expect('新增草稿自己帶的 submitted_at 被清掉',
  (SELECT (submitted_at IS NULL)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000004'), 'true');
SELECT pg_temp.expect('品名只有全形空白、或只有零寬字元被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000a', chr(12288) || chr(12288), 'fruit', '1 盒', 100)$q$)
  || '|' ||
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000006', 'a9200000-0000-4000-8000-00000000000a', chr(8203) || chr(65279), 'fruit', '1 盒', 100)$q$),
  'ERR 23514|ERR 23514');
SELECT pg_temp.expect('二維的 photos 被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000007', 'a9200000-0000-4000-8000-00000000000a', '二維照片', 'fruit', '1 盒', 100,
            ARRAY[ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000007/a9900000-0000-4000-8000-000000000021.jpg',
                        'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000007/a9900000-0000-4000-8000-000000000022.jpg']])$q$),
  'ERR 23514');
SELECT pg_temp.expect('photos 裡有 NULL 被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000008', 'a9200000-0000-4000-8000-00000000000a', '空的照片', 'fruit', '1 盒', 100,
            ARRAY[NULL]::text[])$q$),
  'ERR 22023:invalid_photo_path');

-- ---------------------------------------------------------------------
-- 4. 第 2 輪複審(2026-10-10,見計畫「勘誤」):沒有 sub 的 JWT、核准前照片與縮圖都要已上傳、看起來空白的文字
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('沒有 sub 的 authenticated JWT 替別家建店並勾轉帳:一樣回 42501(例外只看 auth.role())',
  pg_temp.as_exec('authenticated', '{"role":"authenticated"}', $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$)
  || '|' ||
  pg_temp.as_exec('authenticated', '{"role":"authenticated"}', $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000d', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$),
  'ERR 42501|ERR 42501');
-- P9 只上傳縮圖、P10 只上傳主圖(資料庫擁有者身分直接寫 storage.objects;交易最後 ROLLBACK)
SELECT pg_temp.exec_with_claims(pg_temp.ua(), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos, review_status) VALUES
    ('a9300000-0000-4000-8000-000000000009', 'a9200000-0000-4000-8000-00000000000a', '缺主圖', 'fruit', '1 盒', 100,
     ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000009/a9900000-0000-4000-8000-000000000031.jpg'], 'pending'),
    ('a9300000-0000-4000-8000-000000000010', 'a9200000-0000-4000-8000-00000000000a', '缺縮圖', 'fruit', '1 盒', 100,
     ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000010/a9900000-0000-4000-8000-000000000032.jpg'], 'pending')$q$);
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000009/a9900000-0000-4000-8000-000000000031_t.jpg'),
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000010/a9900000-0000-4000-8000-000000000032.jpg');
SELECT pg_temp.expect('缺主圖(只有縮圖):管理員核准被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000009'$q$),
  'ERR 22023:photos_not_uploaded');
SELECT pg_temp.expect('缺縮圖(只有主圖):管理員核准被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000010'$q$),
  'ERR 22023:photos_not_uploaded');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000009/a9900000-0000-4000-8000-000000000031.jpg');
SELECT pg_temp.expect('主圖與縮圖都在:管理員核准',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    WITH u AS (UPDATE public.market_products SET review_status = 'approved'
                WHERE id = 'a9300000-0000-4000-8000-000000000009' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'approved');
SELECT pg_temp.expect('管理員直接建成已核准、照片沒上傳被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos, review_status)
    VALUES ('a9300000-0000-4000-8000-000000000011', 'a9200000-0000-4000-8000-00000000000a', '直接核准', 'fruit', '1 盒', 100,
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000011/a9900000-0000-4000-8000-000000000033.jpg'], 'approved')$q$),
  'ERR 22023:photos_not_uploaded');
SELECT pg_temp.expect('已核准的商品改 photos 仍回到待審(新照片還沒上傳也存得進去,核准時才檢查)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products
                  SET photos = ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000009/a9900000-0000-4000-8000-000000000034.jpg']
                WHERE id = 'a9300000-0000-4000-8000-000000000009' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'pending');
-- 用 A 的身分新增一個只有品名不同的商品(編號 a9300000-0000-4000-8000-0000000000NN),回 as_exec 的結果
CREATE FUNCTION pg_temp.try_name(p_n integer, p_name text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), format(
    $q$INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
       VALUES (%L, 'a9200000-0000-4000-8000-00000000000a', %L, 'fruit', '1 盒', 100)$q$,
    'a9300000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'), p_name))
$f$;
SELECT pg_temp.expect('品名只有看起來空白的字元被擋:U+200E、U+00AD、U+3164、U+2800、U+FE0F、標籤字元、填充字 + 全形空白 + 點字空白',
  concat_ws('|',
    pg_temp.try_name(12, chr(8206)),
    pg_temp.try_name(13, chr(173)),
    pg_temp.try_name(14, chr(12644)),
    pg_temp.try_name(15, chr(10240)),
    pg_temp.try_name(16, chr(65039)),
    pg_temp.try_name(17, chr(917569) || chr(917631)),
    pg_temp.try_name(18, chr(12644) || chr(12288) || chr(10240))),
  'ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514');
SELECT pg_temp.expect('規格只有看起來空白的字元也被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000019', 'a9200000-0000-4000-8000-00000000000a', '規格空白', 'fruit', chr(12644), 100)$q$),
  'ERR 23514');
SELECT pg_temp.expect('選填欄位(產地、說明)只有看起來空白的字元:當成沒填(NULL)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH i AS (INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, origin, description)
               VALUES ('a9300000-0000-4000-8000-000000000020', 'a9200000-0000-4000-8000-00000000000a', '選填空白', 'fruit', '1 盒', 100,
                       chr(10240), chr(8206) || chr(65039))
               RETURNING (origin IS NULL AND description IS NULL)::text AS v)
    SELECT v FROM i$q$),
  'true');
SELECT pg_temp.expect('正常品名不誤殺:中文、全形標點、emoji、ZWJ 組合;結尾的 U+FE0F 原樣保留',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH v(id, name) AS (VALUES
           ('a9300000-0000-4000-8000-000000000021'::uuid, '有機高麗菜'),
           ('a9300000-0000-4000-8000-000000000022'::uuid, chr(12304) || '限量' || chr(12305) || '菠菜' || chr(65292) || '一把' || chr(65281)),
           ('a9300000-0000-4000-8000-000000000023'::uuid, '草莓' || chr(127827) || chr(10084) || chr(65039)),
           ('a9300000-0000-4000-8000-000000000024'::uuid, chr(128104) || chr(8205) || chr(127806) || '小農直送')),
         i AS (INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
               SELECT v.id, 'a9200000-0000-4000-8000-00000000000a', v.name, 'vegetable', '1 份', 100 FROM v
               RETURNING id, name)
    SELECT bool_and(i.name = v.name)::text || '|' || count(*)::text FROM i JOIN v USING (id)$q$),
  'true|4');

-- ---------------------------------------------------------------------
-- 5. 商品照片只收 .jpg(2026-10-10,見計畫「勘誤」):前端一律壓成 JPEG,縮圖才會跟前端 thumbPathOf 顯示的是同一張
-- ---------------------------------------------------------------------
-- 用 A 的身分新增商品 a9300000-0000-4000-8000-0000000000NN,照片放在它自己的資料夾、只有副檔名不同,回 as_exec 的結果
CREATE FUNCTION pg_temp.try_photo(p_n integer, p_ext text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), format(
    $q$INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
       VALUES (%1$L, 'a9200000-0000-4000-8000-00000000000a', '副檔名測試', 'fruit', '1 盒', 100,
               ARRAY['a9200000-0000-4000-8000-00000000000a/' || %1$L || '/a9900000-0000-4000-8000-0000000000' || %2$L || '.' || %3$L])$q$,
    'a9300000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'), lpad(p_n::text, 2, '0'), p_ext))
$f$;
SELECT pg_temp.expect('商品照片只收小寫 .jpg:.png、.webp、.jpeg、.JPG 被擋,.jpg 可以',
  concat_ws('|',
    pg_temp.try_photo(25, 'png'),
    pg_temp.try_photo(26, 'webp'),
    pg_temp.try_photo(27, 'jpeg'),
    pg_temp.try_photo(28, 'JPG'),
    pg_temp.try_photo(29, 'jpg')),
  'ERR 22023:invalid_photo_path|ERR 22023:invalid_photo_path|ERR 22023:invalid_photo_path|ERR 22023:invalid_photo_path|OK');
SELECT pg_temp.expect('store 資料夾不受這個限制:店家 logo 用 .png、封面用 .webp 照常可以',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores
       SET logo_path  = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000041.png',
           cover_path = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000042.webp'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'OK');

-- ---------------------------------------------------------------------
-- 6. 第 3 輪複審(2026-10-10,見計畫「勘誤」):market_visible 的缺口、guard 先擋擁有權與長度、
--    管理員改已核准商品的照片、只認 market-images bucket、缺檔訊息帶真正缺的那張
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('Default_Ignorable 的保留碼位當品名也被擋:U+2065、U+FFF0、U+FFF8、U+E0000、U+E0002、U+E001F、U+E0080、U+E00FF、U+E01F0、U+E0FFF',
  concat_ws('|',
    pg_temp.try_name(50, chr(8293)), pg_temp.try_name(51, chr(65520)), pg_temp.try_name(52, chr(65528)),
    pg_temp.try_name(53, chr(917504)), pg_temp.try_name(54, chr(917506)), pg_temp.try_name(55, chr(917535)),
    pg_temp.try_name(56, chr(917632)), pg_temp.try_name(57, chr(917759)), pg_temp.try_name(58, chr(918000)),
    pg_temp.try_name(59, chr(921599))),
  'ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514');
-- 換成某個身分執行,回「as_exec 的結果|有沒有在 1 秒內」(1 秒是寬鬆上限:修正前要 5 秒,修正後幾十毫秒)
CREATE FUNCTION pg_temp.within_1s(p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_t0 timestamptz := clock_timestamp();
  v_r  text;
BEGIN
  v_r := pg_temp.as_exec('authenticated', p_claims, p_sql);
  RETURN v_r || '|' || (clock_timestamp() - v_t0 < interval '1 second')::text;
END
$f$;
SELECT pg_temp.expect('不是供應商的登入者替別家塞 6 個各 1e6 字的欄位:1 秒內回 42501(擁有權在正規化之前)',
  pg_temp.within_1s(pg_temp.ushop(), $q$
    INSERT INTO public.market_products (supplier_id, name, category, spec, price, origin, storage_method, shelf_life, description)
    SELECT 'a9200000-0000-4000-8000-00000000000a', s, 'fruit', s, 100, s, s, s, s
      FROM (SELECT repeat(chr(8203), 1000000) || 'x' AS s) AS v$q$),
  'ERR 42501|true');
SELECT pg_temp.expect('A 自己的商品塞 6 個各 1e6 字的欄位:1 秒內回 23514(粗擋長度在正規化之前)',
  pg_temp.within_1s(pg_temp.ua(), $q$
    INSERT INTO public.market_products (supplier_id, name, category, spec, price, origin, storage_method, shelf_life, description)
    SELECT 'a9200000-0000-4000-8000-00000000000a', s, 'fruit', s, 100, s, s, s, s
      FROM (SELECT repeat(chr(8203), 1000000) || 'x' AS s) AS v$q$),
  'ERR 23514|true');
SELECT pg_temp.expect('管理員改已核准商品的 photos,照片也要都已上傳',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products
       SET photos = ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000005.jpg']
     WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 22023:photos_not_uploaded');
-- 同名檔放在別的 bucket:P30 的主圖、P31 的縮圖只在 market-test-other(另一張都在 market-images)
INSERT INTO storage.buckets (id, name) VALUES ('market-test-other', 'market-test-other') ON CONFLICT (id) DO NOTHING;
SELECT pg_temp.exec_with_claims(pg_temp.ua(), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos, review_status) VALUES
    ('a9300000-0000-4000-8000-000000000030', 'a9200000-0000-4000-8000-00000000000a', '主圖在別的 bucket', 'fruit', '1 盒', 100,
     ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000030/a9900000-0000-4000-8000-000000000051.jpg'], 'pending'),
    ('a9300000-0000-4000-8000-000000000031', 'a9200000-0000-4000-8000-00000000000a', '縮圖在別的 bucket', 'fruit', '1 盒', 100,
     ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000031/a9900000-0000-4000-8000-000000000052.jpg'], 'pending')$q$);
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('market-test-other', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000030/a9900000-0000-4000-8000-000000000051.jpg'),
  ('market-images',     'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000030/a9900000-0000-4000-8000-000000000051_t.jpg'),
  ('market-images',     'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000031/a9900000-0000-4000-8000-000000000052.jpg'),
  ('market-test-other', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000031/a9900000-0000-4000-8000-000000000052_t.jpg');
SELECT pg_temp.expect('只認 market-images bucket:同名檔放在別的 bucket 不算(缺主圖、缺縮圖各一)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000030'$q$)
  || '|' ||
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000031'$q$),
  'ERR 22023:photos_not_uploaded|ERR 22023:photos_not_uploaded');
-- 換成某個身分執行,回錯誤訊息本文(沒出錯回 NULL)
CREATE FUNCTION pg_temp.err_message(p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_msg;
END
$f$;
SELECT pg_temp.expect('缺檔的錯誤訊息帶真正缺的那張(P10 只缺縮圖 → 訊息結尾是縮圖路徑)',
  (SELECT (right(x.m, length(x.t)) = x.t)::text
     FROM (SELECT pg_temp.err_message(pg_temp.uadmin(), $q$
                    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000010'$q$) AS m,
                  'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000010/a9900000-0000-4000-8000-000000000032_t.jpg' AS t) AS x),
  'true');

-- ---------------------------------------------------------------------
-- 7. 管理員停用店家不能被供應商擋住(2026-10-10,見計畫「勘誤」):供應商自己刪掉轉帳資訊之後,管理員仍要
--    停用 / 啟用得了;transfer_info_required 只在供應商建店、或供應商的更新動到付款方式時檢查
-- ---------------------------------------------------------------------
-- E 店:還沒建零售店家、也還沒有轉帳資訊
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-e@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email, is_active) VALUES
  ('a9200000-0000-4000-8000-00000000000e', '市集測試 E 店', 'store-e@market-test.invalid', true);
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000006', 'a9200000-0000-4000-8000-00000000000e');
CREATE FUNCTION pg_temp.ue() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000006') $f$;
SELECT pg_temp.expect('E 建店時勾轉帳、還沒有轉帳資訊 → 擋',
  pg_temp.as_exec('authenticated', pg_temp.ue(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000e', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$),
  'ERR 22023:transfer_info_required');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
VALUES ('a9200000-0000-4000-8000-00000000000e', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 E');
SELECT pg_temp.expect('E 填好轉帳資訊再建店(勾轉帳)',
  pg_temp.as_exec('authenticated', pg_temp.ue(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000e', ARRAY['臺北市'], ARRAY['cod', 'transfer'])$q$),
  'OK');
SELECT pg_temp.expect('E 自己刪掉轉帳資訊(轉帳資訊表開放供應商刪)',
  pg_temp.as_val('authenticated', pg_temp.ue(), $q$
    WITH d AS (DELETE FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000e' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '1');
SELECT pg_temp.expect('管理員照樣停用得了 E(轉帳資訊被供應商刪掉也一樣)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false, disabled_reason = '測試停用'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000e'$q$),
  'OK');
SELECT pg_temp.expect('管理員重新啟用也不擋(付款方式含轉帳、沒有轉帳資訊;第 2 階段結帳本來就不能選轉帳)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = true WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000e'$q$),
  'OK');
SELECT pg_temp.expect('E 把付款方式改成只收轉帳(動到付款方式、含轉帳、沒有資訊) → 擋',
  pg_temp.as_exec('authenticated', pg_temp.ue(), $q$
    UPDATE public.market_stores SET payment_methods = ARRAY['transfer'] WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000e'$q$),
  'ERR 22023:transfer_info_required');
SELECT pg_temp.expect('E 只改介紹(付款方式沒動) → 不檢查轉帳資訊',
  pg_temp.as_exec('authenticated', pg_temp.ue(), $q$
    UPDATE public.market_stores SET intro = '新的介紹' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000e'$q$),
  'OK');

-- ---------------------------------------------------------------------
-- 8. 最後才跑:會暫停 guard trigger 的 created_at 測試(放在檔尾,SHARE ROW EXCLUSIVE 鎖只持有到交易結束前一下下)
-- ---------------------------------------------------------------------
-- 同一個交易裡 now() 不會變:先把 A 店家的 created_at 改成過去的時間(要暫停 guard 才改得動),
-- 才分得出「修改時保留原值」和「改成 now()」。DISABLE TRIGGER 拿 SHARE ROW EXCLUSIVE 鎖(擋寫不擋讀),交易結束就放。
ALTER TABLE public.market_stores DISABLE TRIGGER trg_market_stores_guard;
UPDATE public.market_stores SET created_at = '2020-01-01 00:00+08' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a';
ALTER TABLE public.market_stores ENABLE TRIGGER trg_market_stores_guard;
SELECT pg_temp.expect('A 改店家的 created_at 沒有作用(保留原值,不是改成現在)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_stores SET created_at = '2099-01-01 00:00+08'
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'
                RETURNING (created_at = '2020-01-01 00:00+08'::timestamptz)::text AS v)
    SELECT v FROM u$q$),
  'true');
-- 同上:先把 P4 的 created_at 改成過去的時間(暫停 guard),再驗證修改時保留原值
ALTER TABLE public.market_products DISABLE TRIGGER trg_market_products_guard;
UPDATE public.market_products SET created_at = '2020-01-01 00:00+08' WHERE id = 'a9300000-0000-4000-8000-000000000004';
ALTER TABLE public.market_products ENABLE TRIGGER trg_market_products_guard;
SELECT pg_temp.expect('A 改商品的 created_at 沒有作用(保留原值,不是改成現在)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET created_at = '2099-01-01 00:00+08'
                WHERE id = 'a9300000-0000-4000-8000-000000000004'
                RETURNING (created_at = '2020-01-01 00:00+08'::timestamptz)::text AS v)
    SELECT v FROM u$q$),
  'true');
