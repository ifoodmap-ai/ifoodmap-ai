-- =====================================================================
-- migration 20261009130000_market_orders 的資料庫層測試(訂單表、RLS、狀態紀錄 guard / apply)
-- 執行(第 1 階段的 120000 / 120100 已套用正式庫,不要再帶;130000 還沒套用時要帶,套用之後拿掉 --with-migration 再跑一次):
--   … dry supabase/tests/database/market_orders.test.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql
-- 訂單 fixture 直接用資料庫擁有者身分建(正式流程只能經 market_place_order,那支在 market_checkout.test.sql 測)。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'shopper@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '台灣銀行(004) 帳號 0123-456-789 戶名 市集測試');
INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, payment_methods) VALUES
  ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市', '新北市'], 120, 1000, 300, ARRAY['cod', 'transfer']),
  ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, NULL, 0, ARRAY['cod']);
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, review_status)
  VALUES ('a9300000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-00000000000a', '有機高麗菜', 'vegetable', '1 顆', 100, 8, 'approved')$q$);

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
CREATE FUNCTION pg_temp.uadmin() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true) $f$;
CREATE FUNCTION pg_temp.ushop() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000004') $f$;

-- 建一張訂單 + 第一筆紀錄(資料庫擁有者身分,= 下單 RPC 在做的事)
CREATE FUNCTION pg_temp.mk_order(p_id uuid, p_supplier uuid, p_payment text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.market_orders (id, checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                    subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
  VALUES (p_id, 'a9700000-0000-4000-8000-000000000001', p_supplier, '測試買家', '0912345678', 'shopper@market-test.invalid',
          '臺北市', '測試路 1 號 2 樓', 200, 120, 320, p_payment, repeat('a', 64), '2026-10-draft');
  INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (p_id, NULL, 'pending');
$f$;

SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', 'transfer');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000003', 'a9200000-0000-4000-8000-00000000000b', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000004', 'a9200000-0000-4000-8000-00000000000a', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000a', 'cod');
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total) VALUES
  ('a9600000-0000-4000-8000-000000000004', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'ambient', 100, 2, 200);

-- ---------------------------------------------------------------------
-- 1. 物件與權限
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('RLS:三張表都開了',
  (SELECT string_agg(relname || '=' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname IN ('market_orders', 'market_order_items', 'market_order_events')),
  'market_order_events=true,market_order_items=true,market_orders=true');
-- 權限清單含 PG17 的 MAINTAIN 與 TRUNCATE / REFERENCES / TRIGGER(第 1 階段審查的教訓:這個專案的 public schema
-- 預設把新表的全部權限給 anon / authenticated;TRUNCATE 不觸發逐列 trigger,漏收就能整張清掉「只能新增」的紀錄)
SELECT pg_temp.expect('anon 對訂單三張表沒有任何權限',
  (has_table_privilege('anon', 'public.market_orders', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR has_table_privilege('anon', 'public.market_order_items', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR has_table_privilege('anon', 'public.market_order_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  'false');
SELECT pg_temp.expect('登入者:訂單、明細只能讀;紀錄只能讀和新增',
  has_table_privilege('authenticated', 'public.market_orders', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_items', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_events', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_events', 'INSERT')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_orders', 'SELECT')::text,
  'false|false|false|true|true');
SELECT pg_temp.expect('轉移表 30 條(供應商、管理員、系統各 10 條)',
  (SELECT count(*)::text FROM public.market_transition_rules()), '30');
SELECT pg_temp.expect('電話:09 開頭 10 碼或市話 9 碼,只收數字',
  (public.market_phone_ok('0912345678') AND public.market_phone_ok('023456789')
   AND NOT public.market_phone_ok('12345') AND NOT public.market_phone_ok('0912-345-678'))::text, 'true');
SELECT pg_temp.expect('Email 格式',
  (public.market_email_ok('a.b+c@ex-ample.com.tw') AND NOT public.market_email_ok('a@b')
   AND NOT public.market_email_ok('a b@c.com') AND NOT public.market_email_ok('x@y.com,z@w.com'))::text, 'true');
SELECT pg_temp.expect('總額一定要等於小計 + 運費',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '買家', '0912345678', 'a@market-test.invalid', '臺北市',
            '測試路 1 號', 100, 60, 999, 'cod', repeat('b', 64), 'v1')$q$),
  'ERR 23514');
SELECT pg_temp.expect('收件縣市要在 22 縣市內',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '買家', '0912345678', 'a@market-test.invalid', '台北市',
            '測試路 1 號', 100, 60, 160, 'cod', repeat('b', 64), 'v1')$q$),
  'ERR 23514');
SELECT pg_temp.expect('anon 讀不到訂單',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_orders$q$), 'ERR 42501');
SELECT pg_temp.expect('一般登入者(不是供應商)讀不到任何訂單',
  pg_temp.as_val('authenticated', pg_temp.ushop(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '0');
SELECT pg_temp.expect('A 只讀得到自己的 4 張單',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '4');
SELECT pg_temp.expect('B 只讀得到自己的 1 張單',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '1');
SELECT pg_temp.expect('管理員讀得到全部 5 張',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '5');
SELECT pg_temp.expect('A 讀得到自己訂單的明細',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_order_items WHERE order_id = 'a9600000-0000-4000-8000-000000000004'$q$), '1');
SELECT pg_temp.expect('B 讀不到 A 訂單的明細與紀錄',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT ((SELECT count(*) FROM public.market_order_items WHERE order_id = 'a9600000-0000-4000-8000-000000000004')
          + (SELECT count(*) FROM public.market_order_events WHERE order_id = 'a9600000-0000-4000-8000-000000000004'))::text$q$),
  '0');
SELECT pg_temp.expect('A 不能直接改訂單狀態(沒有 UPDATE 權限)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_orders SET status = 'completed' WHERE id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 不能自己建訂單',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '假單', '0912345678', 'a@market-test.invalid', '臺北市',
            '測試路 1 號', 100, 0, 100, 'cod', repeat('c', 64), 'v1')$q$),
  'ERR 42501');

-- ---------------------------------------------------------------------
-- 2. 狀態紀錄的 guard
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('第一筆紀錄的身分是消費者',
  (SELECT actor_role FROM public.market_order_events WHERE order_id = 'a9600000-0000-4000-8000-000000000001'), 'consumer');
SELECT pg_temp.expect('已經有紀錄的單不能再寫「待接單」',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_order_events (order_id, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', 'pending')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('B 不能操作 A 的單',
  pg_temp.as_exec('authenticated', pg_temp.ub(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed')$q$),
  'ERR 42501:not_order_party');
SELECT pg_temp.expect('anon 不能寫紀錄',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.market_order_events (order_id, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed')$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 不能從待接單直接出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('畫面過期(前端以為已經接單)被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR P0001:stale_order_status');
SELECT pg_temp.expect('拒單沒填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'rejected', '   ')$q$),
  'ERR 22023:reason_required');
SELECT pg_temp.expect('同一個 INSERT 對同一張單寫兩筆被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note) VALUES
      ('a9600000-0000-4000-8000-000000000005', 'pending', 'confirmed', NULL),
      ('a9600000-0000-4000-8000-000000000005', 'pending', 'rejected', '重複')$q$),
  'ERR P0001:one_event_per_order');
SELECT pg_temp.expect('紀錄不能修改',
  pg_temp.as_exec('postgres', '', $q$
    UPDATE public.market_order_events SET note = '竄改' WHERE order_id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:events_append_only');
SELECT pg_temp.expect('紀錄不能刪除(所以訂單也刪不掉)',
  pg_temp.as_exec('postgres', '', $q$
    DELETE FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:events_append_only');
SELECT pg_temp.expect('供應商連 UPDATE 紀錄的權限都沒有',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_order_events SET note = '竄改' WHERE order_id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501');
