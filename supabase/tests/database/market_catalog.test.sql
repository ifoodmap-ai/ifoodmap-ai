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
