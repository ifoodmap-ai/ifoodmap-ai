-- =====================================================================
-- migration 20261009130100_market_notify 的資料庫層測試(第 1 階段的 120000 / 120100 已套用正式庫,不要再帶):
--   … dry supabase/tests/database/market_notify.test.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql \
--     --with-migration supabase/migrations/20261009130100_market_notify.sql
-- 通知網址在交易裡換成 http://127.0.0.1:9/market-test:排進 pg_net 佇列的請求跟著 ROLLBACK 消失,不會真的送出。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a');
INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市']);
INSERT INTO public.market_orders (id, checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                  subtotal, shipping_fee, total, payment_method, lookup_token_hash, request_fingerprint, terms_version)
VALUES ('a9600000-0000-4000-8000-000000000001', 'a9700000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a',
        '測試買家', '0912345678', 'shopper@market-test.invalid', '臺北市', '測試路 1 號', 200, 0, 200, 'cod', repeat('a', 64), repeat('f', 64), 'v1');

CREATE FUNCTION pg_temp.queued() RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM net.http_request_queue WHERE url = 'http://127.0.0.1:9/market-test'
$f$;

SELECT pg_temp.expect('通知函式不開給 API 角色',
  (has_function_privilege('anon', 'public.market_enqueue_notify(jsonb)', 'EXECUTE')
   OR has_function_privilege('authenticated', 'public.market_enqueue_notify(jsonb)', 'EXECUTE'))::text, 'false');
SELECT pg_temp.expect('通知網址指向 market-notify(套用前沒有這一列時由 migration 新增)',
  (SELECT value FROM public.app_config WHERE key = 'market_notify_function_url'),
  'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify');
SELECT pg_temp.expect('共用的 notify_service_key 存在(值不印出來)',
  (SELECT (count(*) = 1)::text FROM public.app_config WHERE key = 'notify_service_key'), 'true');
SELECT pg_temp.expect('AFTER trigger 依名稱字母序執行:先套用狀態(apply)、再排通知(notify)',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.market_order_events'::regclass AND NOT tgisinternal AND tgname LIKE 'trg_market_%'
      AND tgtype & 2 = 0),  -- tgtype 第 2 個位元 = BEFORE;0 = AFTER
  'trg_market_apply_event,trg_market_events_one_per_order,trg_market_notify_event');

UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', NULL, 'pending');

SELECT pg_temp.expect('每筆狀態紀錄排一個通知請求',
  pg_temp.queued()::text, '1');
SELECT pg_temp.expect('……內容只有 kind 與 event_id,帶 Authorization',
  (SELECT (convert_from(q.body, 'UTF8')::jsonb ->> 'kind') || '|' ||
          ((convert_from(q.body, 'UTF8')::jsonb ->> 'event_id') = (SELECT e.id::text FROM public.market_order_events e
                                                                     WHERE e.order_id = 'a9600000-0000-4000-8000-000000000001'))::text || '|' ||
          (q.headers ? 'Authorization')::text || '|' ||
          (SELECT count(*) FROM jsonb_object_keys(convert_from(q.body, 'UTF8')::jsonb))::text
     FROM net.http_request_queue q WHERE q.url = 'http://127.0.0.1:9/market-test'),
  'event|true|true|2');
SELECT pg_temp.expect('供應商操作也會排通知(接單)',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed') RETURNING 1)
    SELECT count(*)::text FROM e$q$),
  '1');
SELECT pg_temp.expect('……佇列變 2 筆', pg_temp.queued()::text, '2');

DELETE FROM public.app_config WHERE key = 'market_notify_function_url';
SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
  VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"carrier":"黑貓"}')$q$);
SELECT pg_temp.expect('沒設通知網址:照樣出貨、不排通知',
  (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000001') || '|' || pg_temp.queued()::text,
  'shipped|2');
