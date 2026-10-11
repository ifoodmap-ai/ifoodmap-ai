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
SELECT pg_temp.expect('轉移表 33 條(供應商、管理員、系統各 11 條;含已收款 → 取消)',
  (SELECT count(*)::text FROM public.market_transition_rules()), '33');
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

-- ---------------------------------------------------------------------
-- 3. 套用狀態(apply)
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('A 接單(貨到付款)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed')$q$),
  'OK');
SELECT pg_temp.expect('狀態與接單時間套上去;紀錄的身分是供應商、actor_id 是 A',
  (SELECT o.status || '|' || (o.confirmed_at IS NOT NULL)::text || '|' || e.actor_role || '|' || e.actor_id::text
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'confirmed'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000001'),
  'confirmed|true|supplier|a9100000-0000-4000-8000-000000000001');
SELECT pg_temp.expect('出貨沒填物流被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"tracking_no":"9001"}')$q$),
  'ERR 22023:carrier_required');
SELECT pg_temp.expect('A 出貨(物流、單號)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped',
            '{"carrier":" 黑貓宅急便 ","tracking_no":"9001","extra":"不該存"}')$q$),
  'OK');
SELECT pg_temp.expect('物流與單號寫進訂單;紀錄只留 carrier / tracking_no',
  (SELECT o.shipped_carrier || '|' || o.shipped_tracking_no || '|' || e.payload::text
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'shipped'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000001'),
  '黑貓宅急便|9001|{"carrier": "黑貓宅急便", "tracking_no": "9001"}');
SELECT pg_temp.expect('A 完成訂單',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'shipped', 'completed')$q$),
  'OK');
SELECT pg_temp.expect('轉帳訂單接單 → 自動待匯款(三筆紀錄)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000002', 'pending', 'confirmed') RETURNING 1)
    SELECT count(*)::text FROM e$q$),
  '1');
SELECT pg_temp.expect('……訂單停在待匯款,紀錄 pending → confirmed → awaiting_payment',
  (SELECT o.status || '|' || (SELECT string_agg(e.to_status, '>' ORDER BY e.created_at, e.to_status = 'awaiting_payment')
                                FROM public.market_order_events e WHERE e.order_id = o.id)
     FROM public.market_orders o WHERE o.id = 'a9600000-0000-4000-8000-000000000002'),
  'awaiting_payment|pending>confirmed>awaiting_payment');
SELECT pg_temp.expect('待匯款不能直接出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'awaiting_payment', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('標記已收款',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'awaiting_payment', 'paid')$q$),
  'OK');
SELECT pg_temp.expect('已收款後出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'paid', 'shipped', '{"carrier":"自行配送"}')$q$),
  'OK');
SELECT pg_temp.expect('……狀態已出貨、收款時間有填',
  (SELECT status || '|' || (paid_at IS NOT NULL)::text FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000002'),
  'shipped|true');
SELECT pg_temp.expect('取消(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000004', 'pending', 'cancelled', '缺貨')$q$),
  'OK');
SELECT pg_temp.expect('……庫存加回去(8 + 2 = 10)、原因與結束時間寫進訂單',
  (SELECT p.stock::text || '|' || o.status_note || '|' || (o.closed_at IS NOT NULL)::text
     FROM public.market_products p, public.market_orders o
    WHERE p.id = 'a9300000-0000-4000-8000-0000000000a1' AND o.id = 'a9600000-0000-4000-8000-000000000004'),
  '10|缺貨|true');
SELECT pg_temp.expect('已取消的單不能再接',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000004', 'cancelled', 'confirmed')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('管理員取消 B 的單,紀錄的身分是管理員',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
               VALUES ('a9600000-0000-4000-8000-000000000003', 'pending', 'cancelled', '客訴:重複下單') RETURNING actor_role)
    SELECT actor_role FROM e$q$),
  'admin');
SELECT pg_temp.expect('前端送的 actor_role 不算(A 冒充管理員 → 記成 supplier)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status, actor_role)
               VALUES ('a9600000-0000-4000-8000-000000000005', 'pending', 'confirmed', 'admin') RETURNING actor_role)
    SELECT actor_role FROM e$q$),
  'supplier');

-- ---------------------------------------------------------------------
-- 4. 自查修正(2026-10-11)
-- ---------------------------------------------------------------------
-- 4-1 轉帳訂單接單後自動補的「待匯款」一律記成 system、沒有 actor_id(不是接單的人;跟 Task 42 notify 測試的 fixture 一致)
SELECT pg_temp.expect('A 接轉帳單:接單那筆是 A(supplier),自動補的待匯款記成 system、沒有 actor_id',
  (SELECT string_agg(e.to_status || '=' || e.actor_role || '/' || COALESCE(e.actor_id::text, '-'), ',' ORDER BY e.to_status)
     FROM public.market_order_events e
    WHERE e.order_id = 'a9600000-0000-4000-8000-000000000002' AND e.to_status IN ('confirmed', 'awaiting_payment')),
  'awaiting_payment=system/-,confirmed=supplier/a9100000-0000-4000-8000-000000000001');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000006', 'a9200000-0000-4000-8000-00000000000a', 'transfer');
SELECT pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status)
  VALUES ('a9600000-0000-4000-8000-000000000006', 'pending', 'confirmed')$q$);
SELECT pg_temp.expect('管理員接轉帳單:接單那筆是管理員,自動補的待匯款一樣記成 system',
  (SELECT o.status || '|' || string_agg(e.to_status || '=' || e.actor_role || '/' || COALESCE(e.actor_id::text, '-'), ',' ORDER BY e.to_status)
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.from_status IS NOT NULL
    WHERE o.id = 'a9600000-0000-4000-8000-000000000006'
    GROUP BY o.status),
  'awaiting_payment|awaiting_payment=system/-,confirmed=admin/a9100000-0000-4000-8000-000000000003');
-- 4-2 同一張單裡同一個商品有好幾列時,取消要把每一列的數量都加回去
--     (下單 RPC 會先合併同一個商品,正常不會有;直接寫明細時 UPDATE … FROM 一個商品只會配到其中一列)
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000007', 'a9200000-0000-4000-8000-00000000000a', 'cod');
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total) VALUES
  ('a9600000-0000-4000-8000-000000000007', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'ambient', 100, 1, 100),
  ('a9600000-0000-4000-8000-000000000007', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'ambient', 100, 2, 200);
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
  VALUES ('a9600000-0000-4000-8000-000000000007', 'pending', 'cancelled', '測試:同一個商品兩列')$q$);
SELECT pg_temp.expect('同一個商品兩列(1 + 2)的單取消:兩列都加回去(10 → 13)',
  (SELECT o.status || '|' || p.stock::text
     FROM public.market_orders o, public.market_products p
    WHERE o.id = 'a9600000-0000-4000-8000-000000000007' AND p.id = 'a9300000-0000-4000-8000-0000000000a1'),
  'cancelled|13');
-- 4-3 拒單 / 取消原因:用第 1 階段的 market_visible 判斷有沒有填、market_trim 去頭尾(全形空白、零寬字元也算空白)
--     chr(12288) = U+3000 全形空白、chr(8203) = U+200B 零寬空白(不寫跳脫序列,避免工具把它換成看不見的字元本身)
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000008', 'a9200000-0000-4000-8000-00000000000a', 'cod');
SELECT pg_temp.expect('拒單原因只有全形空白與零寬字元:算沒填',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000008', 'pending', 'rejected', chr(12288) || chr(8203) || chr(12288))$q$),
  'ERR 22023:reason_required');
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
  VALUES ('a9600000-0000-4000-8000-000000000008', 'pending', 'rejected', chr(12288) || '今日停止接單' || chr(8203))$q$);
SELECT pg_temp.expect('原因頭尾的全形空白、零寬字元會去掉(紀錄與訂單都存去掉後的字)',
  (SELECT o.status || '|' || o.status_note || '|' || e.note
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'rejected'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000008'),
  'rejected|今日停止接單|今日停止接單');
-- 4-4 身分:沒有 sub 的 authenticated JWT 不能操作(第 1 階段第 2 輪複審的同類問題:用 auth.uid() 判斷會被當成 system);
--     service_role 與資料庫擁有者直接寫(沒有 JWT)= system
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000009', 'a9200000-0000-4000-8000-00000000000a', 'transfer');
SELECT pg_temp.expect('沒有 sub 的 authenticated JWT 不能操作(不會被當成 system)',
  pg_temp.as_exec('authenticated', '{"role":"authenticated"}', $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000009', 'pending', 'confirmed')$q$),
  'ERR 42501:not_order_party');
SELECT pg_temp.expect('service_role(沒有登入者)接單:身分 system、沒有 actor_id',
  pg_temp.as_val('service_role', '{"role":"service_role"}', $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000009', 'pending', 'confirmed')
               RETURNING actor_role || '/' || COALESCE(actor_id::text, '-') AS r)
    SELECT r FROM e$q$),
  'system/-');
SELECT pg_temp.expect('資料庫擁有者直接寫(沒有 JWT)也是 system:待匯款 → 已收款',
  pg_temp.as_val('postgres', '', $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000009', 'awaiting_payment', 'paid') RETURNING actor_role)
    SELECT actor_role FROM e$q$),
  'system');
-- 4-5 已收款的轉帳單也能取消(店家收了錢卻出不了貨,不然這張單會卡死);原因必填、庫存照補,跟其他取消一樣
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000010', 'a9200000-0000-4000-8000-00000000000a', 'transfer');
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total) VALUES
  ('a9600000-0000-4000-8000-000000000010', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'ambient', 100, 2, 200);
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status)
  VALUES ('a9600000-0000-4000-8000-000000000010', 'pending', 'confirmed')$q$);
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status)
  VALUES ('a9600000-0000-4000-8000-000000000010', 'awaiting_payment', 'paid')$q$);
SELECT pg_temp.expect('已收款的轉帳單取消:沒填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000010', 'paid', 'cancelled')$q$),
  'ERR 22023:reason_required');
SELECT pg_temp.expect('已收款的轉帳單可以取消(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000010', 'paid', 'cancelled', '缺貨,已全額退款')$q$),
  'OK');
SELECT pg_temp.expect('……庫存加回去(13 + 2 = 15)、原因與結束時間寫進訂單',
  (SELECT o.status || '|' || p.stock::text || '|' || o.status_note || '|' || (o.closed_at IS NOT NULL)::text
     FROM public.market_orders o, public.market_products p
    WHERE o.id = 'a9600000-0000-4000-8000-000000000010' AND p.id = 'a9300000-0000-4000-8000-0000000000a1'),
  'cancelled|15|缺貨,已全額退款|true');

-- ---------------------------------------------------------------------
-- 5. 第 2 階段審查修正(2026-10-11)
-- ---------------------------------------------------------------------
-- 5-1 紀錄時間由伺服器用 clock_timestamp() 決定,同一個交易裡後寫的一定比較晚
--     (原本 now() 是交易開始的時間:轉帳單的「已接單」和自動補的「待匯款」時間完全相同,依隨機 id 排序先後就亂了)
SELECT pg_temp.expect('轉帳單接單:自動補的待匯款時間嚴格晚於已接單',
  (SELECT (aw.created_at > cf.created_at)::text
     FROM public.market_order_events aw, public.market_order_events cf
    WHERE aw.order_id = 'a9600000-0000-4000-8000-000000000002' AND aw.to_status = 'awaiting_payment'
      AND cf.order_id = 'a9600000-0000-4000-8000-000000000002' AND cf.to_status = 'confirmed'),
  'true');
SELECT pg_temp.expect('……整張單依時間排序就是寫入順序,而且每筆時間都不一樣',
  (SELECT string_agg(e.to_status, '>' ORDER BY e.created_at, e.id) || '|' || (count(DISTINCT e.created_at) = count(*))::text
     FROM public.market_order_events e WHERE e.order_id = 'a9600000-0000-4000-8000-000000000002'),
  'pending>confirmed>awaiting_payment>paid>shipped|true');
SELECT pg_temp.expect('system 自己帶的時間也不算(資料庫擁有者帶 2000-01-01 出貨):記成伺服器時間、比上一筆晚',
  pg_temp.as_val('postgres', '', $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status, payload, created_at)
               VALUES ('a9600000-0000-4000-8000-000000000009', 'paid', 'shipped', '{"carrier":"自行配送"}', '2000-01-01')
               RETURNING actor_role, created_at)
    SELECT actor_role || '|' || (created_at > (SELECT max(x.created_at) FROM public.market_order_events x
                                               WHERE x.order_id = 'a9600000-0000-4000-8000-000000000009' AND x.to_status = 'paid'))::text
      FROM e$q$),
  'system|true');
