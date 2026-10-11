-- =====================================================================
-- migration 20261009130200_market_checkout 的資料庫層測試(限流、下單 RPC、token 查單)(第 1 階段的 120000 / 120100 已套用正式庫,不要再帶):
--   … dry supabase/tests/database/market_checkout.test.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql \
--     --with-migration supabase/migrations/20261009130100_market_notify.sql \
--     --with-migration supabase/migrations/20261009130200_market_checkout.sql
-- 通知網址換成 http://127.0.0.1:9/market-test;下單開關在交易裡切換;全部跟著 ROLLBACK 消失。
-- 金額跟前端測試同一組:A 店運費 120、滿 1000 免運、最低 300;B 店運費 60、沒有免運、沒有最低金額。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info) VALUES
  ('a9200000-0000-4000-8000-00000000000b', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');
INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, payment_methods) VALUES
  ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市', '新北市'], 120, 1000, 300, ARRAY['cod']),
  ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, NULL, 0, ARRAY['cod', 'transfer']);
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, review_status, is_listed) VALUES
    ('a9300000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-00000000000a', '有機高麗菜', 'vegetable', '1 顆', 100, 10, 'chilled', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a2', 'a9200000-0000-4000-8000-00000000000a', '牛肉片', 'meat', '300g/盒', 450, NULL, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a3', 'a9200000-0000-4000-8000-00000000000a', '待審商品', 'fruit', '1 盒', 100, NULL, 'ambient', 'pending', true),
    ('a9300000-0000-4000-8000-0000000000b1', 'a9200000-0000-4000-8000-00000000000b', '挪威鮭魚', 'seafood', '200g/片', 200, 3, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000b2', 'a9200000-0000-4000-8000-00000000000b', '暫停販售的蝦', 'seafood', '1 盒', 300, NULL, 'frozen', 'approved', false)$q$);

-- ---------------------------------------------------------------------
-- 1. 限流
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('限流相關函式不開給 API 角色',
  (has_function_privilege('anon', 'public.market_rate_take(jsonb)', 'EXECUTE')
   OR has_function_privilege('authenticated', 'public.market_rate_take(jsonb)', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_client_ip()', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_rate_key(text,text,text)', 'EXECUTE'))::text,
  'false');
-- 權限清單含 TRUNCATE / REFERENCES / TRIGGER / MAINTAIN:anon 能 TRUNCATE 計數表就能把限流歸零
SELECT pg_temp.expect('計數表 anon / 登入者都碰不到',
  (has_table_privilege('anon', 'public.market_rate_counters', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR has_table_privilege('authenticated', 'public.market_rate_counters', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  'false');
SELECT pg_temp.expect('上限 3:前 3 次通過',
  (SELECT string_agg(public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'ok', ',')
     FROM generate_series(1, 3)),
  'true,true,true');
SELECT pg_temp.expect('第 4 次被擋(RATE_LIMITED)',
  public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'code', 'RATE_LIMITED');
SELECT pg_temp.expect('被擋的那次不吃額度(計數停在 3)',
  (SELECT hits::text FROM public.market_rate_counters WHERE bucket = 'test:a|1h'), '3');
SELECT pg_temp.expect('任何一條超過就整批退回:另一條也不加',
  (public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3},{"bucket":"test:b","window":"1h","limit":100}]'::jsonb) ->> 'code')
  || '|' || (SELECT count(*)::text FROM public.market_rate_counters WHERE bucket = 'test:b|1h'),
  'RATE_LIMITED|0');
SELECT pg_temp.expect('每日上限回 DAILY_CAP,而且優先於 RATE_LIMITED',
  public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3},{"bucket":"test:c","window":"day","limit":0,"code":"DAILY_CAP"}]'::jsonb) ->> 'code',
  'DAILY_CAP');
SELECT pg_temp.expect('retry_after 是正的秒數',
  ((public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'retry_after')::integer > 0)::text, 'true');
SELECT pg_temp.expect('規則格式不對直接報錯(沒有 10m 窗格)',
  pg_temp.as_exec('postgres', '', $q$SELECT public.market_rate_take('[{"bucket":"x","window":"10m","limit":1}]'::jsonb)$q$),
  'ERR 22023');
SELECT pg_temp.expect('IP 正規化:IPv4 原樣、IPv6 取 /64、亂填回 NULL',
  public.market_normalize_ip('203.0.113.7') || '|' || public.market_normalize_ip('2001:db8:1:2:3:4:5:6') || '|'
  || COALESCE(public.market_normalize_ip('不是 IP'), '∅'),
  '203.0.113.7|2001:db8:1:2::|∅');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2","x-real-ip":"3.3.3.3","cf-connecting-ip":"4.4.4.4"}', true);
SELECT pg_temp.expect('呼叫者 IP:cf-connecting-ip 優先', public.market_client_ip(), '4.4.4.4');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2","x-real-ip":"3.3.3.3"}', true);
SELECT pg_temp.expect('……沒有就用 x-real-ip', public.market_client_ip(), '3.3.3.3');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2"}', true);
SELECT pg_temp.expect('……再沒有才用 x-forwarded-for 第一段', public.market_client_ip(), '1.1.1.1');
SELECT set_config('request.headers', '', true);
SELECT pg_temp.expect('……都沒有回 NULL(不算 IP 額度)', COALESCE(public.market_client_ip(), '∅'), '∅');
SELECT pg_temp.expect('bucket 只存加鹽雜湊',
  (public.market_rate_key('email', 'a@b.c', 'salt') ~ '^email:[0-9a-f]{16}$')::text, 'true');
SELECT pg_temp.expect('清理排程每天 19:50 UTC',
  (SELECT schedule FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup'), '50 19 * * *');
SELECT pg_temp.expect('下單開關與限流的鹽都在 app_config(值不印出來)',
  (SELECT count(*)::text FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt')), '2');
