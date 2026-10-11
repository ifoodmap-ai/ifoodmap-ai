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
-- 「做」跟「讀」要分兩句:同一句裡的子查詢用的是句子開始時的快照,看不到函式在句子中途寫進去的列(會永遠讀到 0)
SELECT pg_temp.expect('任何一條超過就整批退回:回 RATE_LIMITED',
  public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3},{"bucket":"test:b","window":"1h","limit":100}]'::jsonb) ->> 'code',
  'RATE_LIMITED');
SELECT pg_temp.expect('……另一條也不加(另一句重讀)',
  (SELECT count(*)::text FROM public.market_rate_counters WHERE bucket = 'test:b|1h'), '0');
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
-- 開關預設關閉(migration 新增的是 'false';第 2 節之後測試才在交易裡切換)。業主核准對外開放之後再跑這支,這一項會是 2|true,屬預期
SELECT pg_temp.expect('下單開關與限流的鹽都在 app_config(鹽的值不印出來);開關預設關閉',
  (SELECT count(*)::text FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt')) || '|' ||
  (SELECT value FROM public.app_config WHERE key = 'market_checkout_open'),
  '2|false');

-- ---------------------------------------------------------------------
-- 2. 下單 RPC
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

-- 以 anon(或帶 JWT 的登入者)身分呼叫下單 RPC;p_ip = 這次請求的 cf-connecting-ip(NULL = 沒有 IP 標頭)
CREATE FUNCTION pg_temp.place(p_claims text, p_ip text, p_checkout jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb;
  v_state text;
BEGIN
  PERFORM set_config('request.headers', CASE WHEN p_ip IS NULL THEN '' ELSE json_build_object('cf-connecting-ip', p_ip)::text END, true);
  PERFORM set_config('request.jwt.claims', p_claims, true);
  PERFORM set_config('role', CASE WHEN p_claims LIKE '%"authenticated"%' THEN 'authenticated' ELSE 'anon' END, true);
  BEGIN
    r := public.market_place_order(p_checkout);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    r := jsonb_build_object('ok', false, 'code', 'ERR ' || v_state, 'message', SQLERRM);
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.headers', '', true);
  RETURN r;
END
$f$;

-- 結帳內容。電話預設由 Email 算出一支不重複的(同一支電話每天只能下 10 單,測試會超過);
-- 要測正規化時自己帶(例如 '0912-345-678')。Email 可以帶大寫:伺服器會轉小寫
CREATE FUNCTION pg_temp.co(p_email text, p_items jsonb, p_payments jsonb, p_city text DEFAULT '臺北市',
                           p_expected jsonb DEFAULT NULL, p_phone text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'buyer', jsonb_build_object('name', '測試買家',
                                'phone', COALESCE(p_phone, '09' || lpad((abs(hashtext(p_email)) % 100000000)::text, 8, '0')),
                                'email', p_email, 'city', p_city, 'address', '測試路 1 號 2 樓', 'note', '請放管理室'),
    'items', p_items, 'payments', p_payments, 'expected_totals', p_expected, 'terms_version', '2026-10-draft'))
$f$;

CREATE FUNCTION pg_temp.item(p_product text, p_qty integer) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('product_id', 'a9300000-0000-4000-8000-0000000000' || p_product, 'qty', p_qty)
$f$;

CREATE FUNCTION pg_temp.queued(p_kind text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM net.http_request_queue q
   WHERE q.url = 'http://127.0.0.1:9/market-test' AND convert_from(q.body, 'UTF8')::jsonb ->> 'kind' = p_kind
$f$;

UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
UPDATE public.app_config SET value = 'false' WHERE key = 'market_checkout_open';

SELECT pg_temp.expect('開關關閉:anon 拿到 MARKET_CLOSED',
  pg_temp.place(pg_temp.anon(), '198.51.100.1',
    pg_temp.co('closed@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code',
  'MARKET_CLOSED');
SELECT pg_temp.expect('開關關閉:平台管理員可以下單(業主實測用)',
  pg_temp.place(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), '198.51.100.1',
    pg_temp.co('owner-test@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok',
  'true');
-- 開關檢查在限流之前:開關關著時被擋的嘗試不寫任何計數(管理員本來就不限流;第 1 節的單元測試只寫 test: 開頭的 bucket)
SELECT pg_temp.expect('開關關閉被擋的嘗試不寫任何計數(沒有 IP / Email / 電話 / 全站的列)',
  (SELECT count(*)::text FROM public.market_rate_counters WHERE bucket NOT LIKE 'test:%'), '0');

SELECT pg_temp.expect('開關狀態:關閉時 anon 不能下單、管理員可以',
  pg_temp.as_val('anon', pg_temp.anon(), 'SELECT public.market_checkout_status()::text') || '|' ||
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), 'SELECT public.market_checkout_status()::text'),
  '{"open": false, "can_order": false}|{"open": false, "can_order": true}');

UPDATE public.app_config SET value = 'true' WHERE key = 'market_checkout_open';

SELECT pg_temp.expect('開關狀態:打開後 anon 也能下單',
  pg_temp.as_val('anon', pg_temp.anon(), 'SELECT public.market_checkout_status()::text'),
  '{"open": true, "can_order": true}');

INSERT INTO _ctx VALUES ('happy', pg_temp.place(pg_temp.anon(), '198.51.100.2', pg_temp.co('Happy@Market-Test.invalid',
  jsonb_build_array(pg_temp.item('a1', 2) || '{"price": 1}', pg_temp.item('a2', 1), pg_temp.item('b1', 1)),
  '{"a9200000-0000-4000-8000-00000000000a":"cod","a9200000-0000-4000-8000-00000000000b":"transfer"}',
  '臺北市', NULL, '0912-345-678')));
SELECT pg_temp.expect('anon 一次結帳兩家店成功', (SELECT v ->> 'ok' FROM _ctx WHERE k = 'happy'), 'true');
SELECT pg_temp.expect('金額是伺服器算的(送來的 price 不算):A 200+450+運費 120 = 770;B 200+運費 60 = 260',
  (SELECT string_agg(o ->> 'total', ',' ORDER BY o ->> 'supplier_id') FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy'),
  '770,260');
SELECT pg_temp.expect('token 43 字;兩張單共用、DB 只存它的 sha256',
  (SELECT (char_length(v ->> 'token') = 43)::text || '|' ||
          (SELECT count(*) FROM public.market_orders o
            WHERE o.lookup_token_hash = encode(sha256(convert_to(v ->> 'token', 'UTF8')), 'hex'))::text
     FROM _ctx WHERE k = 'happy'),
  'true|2');
SELECT pg_temp.expect('明細是下單當下的快照',
  (SELECT string_agg(i.product_name || '×' || i.qty || '=' || i.line_total, ',' ORDER BY i.unit_price)
     FROM public.market_order_items i
    WHERE i.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '有機高麗菜×2=200,挪威鮭魚×1=200,牛肉片×1=450');
SELECT pg_temp.expect('庫存扣掉(高麗菜 10→8、鮭魚 3→2;不限庫存的牛肉片不動)',
  (SELECT string_agg(COALESCE(stock::text, '∅'), '|' ORDER BY id) FROM public.market_products
    WHERE id IN ('a9300000-0000-4000-8000-0000000000a1', 'a9300000-0000-4000-8000-0000000000a2', 'a9300000-0000-4000-8000-0000000000b1')),
  '8|∅|2');
SELECT pg_temp.expect('每張單第一筆紀錄是 pending、身分是消費者',
  (SELECT count(*)::text FROM public.market_order_events e
    WHERE e.to_status = 'pending' AND e.actor_role = 'consumer'
      AND e.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '2');
SELECT pg_temp.expect('收件資料正規化:電話去掉 -、Email 轉小寫',
  (SELECT string_agg(DISTINCT o.buyer_phone || '|' || o.buyer_email, ',') FROM public.market_orders o
    WHERE o.id IN (SELECT (x ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') x WHERE k = 'happy')),
  '0912345678|happy@market-test.invalid');
SELECT pg_temp.expect('排了 1 封下單確認(帶 token)+ 2 封新訂單通知',
  (SELECT count(*)::text FROM net.http_request_queue q, _ctx c
    WHERE c.k = 'happy' AND q.url = 'http://127.0.0.1:9/market-test'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'kind' = 'placed'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'checkout_id' = c.v ->> 'checkout_id'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'token' = c.v ->> 'token')
  || '|' ||
  (SELECT count(*)::text FROM net.http_request_queue q
     JOIN public.market_order_events e ON e.id::text = convert_from(q.body, 'UTF8')::jsonb ->> 'event_id'
    WHERE q.url = 'http://127.0.0.1:9/market-test'
      AND e.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '1|2');

INSERT INTO _ctx VALUES ('price', pg_temp.place(pg_temp.anon(), '198.51.100.3', pg_temp.co('price@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}', '臺北市',
  '{"a9200000-0000-4000-8000-00000000000a": 1}')));
SELECT pg_temp.expect('畫面上的總額對不上 → PRICE_CHANGED,回伺服器算的 570,不建單',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'total') FROM _ctx WHERE k = 'price') || '|' ||
  (SELECT count(*)::text FROM public.market_orders WHERE buyer_email = 'price@market-test.invalid'),
  'PRICE_CHANGED|570|0');
SELECT pg_temp.expect('總額對得上就成功',
  pg_temp.place(pg_temp.anon(), '198.51.100.3', pg_temp.co('price@market-test.invalid',
    jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}', '臺北市',
    '{"a9200000-0000-4000-8000-00000000000a": 570}')) ->> 'ok',
  'true');

INSERT INTO _ctx VALUES ('stock', pg_temp.place(pg_temp.anon(), '198.51.100.4', pg_temp.co('stock@market-test.invalid',
  jsonb_build_array(pg_temp.item('b1', 5)), '{"a9200000-0000-4000-8000-00000000000b":"cod"}')));
SELECT pg_temp.expect('庫存不足 → OUT_OF_STOCK(剩 2),庫存不變',
  (SELECT (v ->> 'code') || '|' || (v -> 'products' -> 0 ->> 'available') FROM _ctx WHERE k = 'stock') || '|' ||
  (SELECT stock::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000b1'),
  'OUT_OF_STOCK|2|2');
SELECT pg_temp.expect('待審、暫停販售、不存在的商品都 PRODUCT_UNAVAILABLE',
  (pg_temp.place(pg_temp.anon(), '198.51.100.5', pg_temp.co('u1@market-test.invalid', jsonb_build_array(pg_temp.item('a3', 1)),
     '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.6', pg_temp.co('u2@market-test.invalid', jsonb_build_array(pg_temp.item('b2', 1)),
     '{"a9200000-0000-4000-8000-00000000000b":"cod"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.7', pg_temp.co('u3@market-test.invalid',
     '[{"product_id":"a9300000-0000-4000-8000-0000000000ff","qty":1}]', '{}')) ->> 'code'),
  'PRODUCT_UNAVAILABLE|PRODUCT_UNAVAILABLE|PRODUCT_UNAVAILABLE');
INSERT INTO _ctx VALUES ('city', pg_temp.place(pg_temp.anon(), '198.51.100.8', pg_temp.co('city@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 3), pg_temp.item('b1', 1)),
  '{"a9200000-0000-4000-8000-00000000000a":"cod","a9200000-0000-4000-8000-00000000000b":"cod"}', '新北市')));
SELECT pg_temp.expect('收件縣市不在配送範圍 → NOT_DELIVERABLE,只列不送新北市的 B 店',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores')::text FROM _ctx WHERE k = 'city'),
  'NOT_DELIVERABLE|["a9200000-0000-4000-8000-00000000000b"]');
INSERT INTO _ctx VALUES ('min', pg_temp.place(pg_temp.anon(), '198.51.100.9', pg_temp.co('min@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 2)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('A 店最低 300、小計 200 → BELOW_MINIMUM',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'subtotal') || '|' || (v -> 'stores' -> 0 ->> 'min_order_amount') FROM _ctx WHERE k = 'min'),
  'BELOW_MINIMUM|200|300');
SELECT pg_temp.expect('剛好 300 就可以(運費 120 → 420)',
  (SELECT (r ->> 'ok') || '|' || (r -> 'orders' -> 0 ->> 'total')
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.100.10', pg_temp.co('min300@market-test.invalid',
             jsonb_build_array(pg_temp.item('a1', 3)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true|420');
SELECT pg_temp.expect('滿 1000 免運:牛肉片 ×2 + 高麗菜 ×1 = 1000 → 總額 1000',
  (SELECT (r ->> 'ok') || '|' || (r -> 'orders' -> 0 ->> 'total')
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.100.11', pg_temp.co('free@market-test.invalid',
             jsonb_build_array(pg_temp.item('a2', 2), pg_temp.item('a1', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true|1000');
SELECT pg_temp.expect('付款方式不在店家接受的裡面、或沒選 → PAYMENT_NOT_ACCEPTED',
  (pg_temp.place(pg_temp.anon(), '198.51.100.12', pg_temp.co('pay1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
     '{"a9200000-0000-4000-8000-00000000000a":"transfer"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.13', pg_temp.co('pay2@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}')) ->> 'code'),
  'PAYMENT_NOT_ACCEPTED|PAYMENT_NOT_ACCEPTED');
DELETE FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b';
SELECT pg_temp.expect('轉帳資訊被刪掉的店不能選轉帳',
  pg_temp.place(pg_temp.anon(), '198.51.100.14', pg_temp.co('pay3@market-test.invalid', jsonb_build_array(pg_temp.item('b1', 1)),
    '{"a9200000-0000-4000-8000-00000000000b":"transfer"}')) ->> 'code',
  'PAYMENT_NOT_ACCEPTED');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
VALUES ('a9200000-0000-4000-8000-00000000000b', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');

CREATE FUNCTION pg_temp.bad(p_n integer, p_checkout jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(pg_temp.place(pg_temp.anon(), '198.51.101.' || p_n, p_checkout) ->> 'field', '(沒有 field)')
$f$;
SELECT pg_temp.expect('欄位驗證:每個欄位都有上限與格式',
  concat_ws(',',
    pg_temp.bad(1, jsonb_set(pg_temp.co('f1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,phone}', '"12345"')),
    pg_temp.bad(2, pg_temp.co('a@b', jsonb_build_array(pg_temp.item('a2', 1)), '{}')),
    pg_temp.bad(3, jsonb_set(pg_temp.co('f3@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,name}', '"  "')),
    pg_temp.bad(4, jsonb_set(pg_temp.co('f4@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,name}', to_jsonb(repeat('名', 51)))),
    pg_temp.bad(5, pg_temp.co('f5@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}', '台北市')),
    pg_temp.bad(6, jsonb_set(pg_temp.co('f6@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,address}', '"短"')),
    pg_temp.bad(7, jsonb_set(pg_temp.co('f7@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,note}', to_jsonb(repeat('字', 301)))),
    pg_temp.bad(8, jsonb_set(pg_temp.co('f8@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{terms_version}', '""')),
    pg_temp.bad(9, pg_temp.co('f9@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 0)), '{}')),
    pg_temp.bad(10, pg_temp.co('f10@market-test.invalid', '[{"product_id":"a9300000-0000-4000-8000-0000000000a2","qty":"2"}]', '{}')),
    pg_temp.bad(11, pg_temp.co('f11@market-test.invalid', '[{"product_id":"a9300000-0000-4000-8000-0000000000a2","qty":1.5}]', '{}')),
    pg_temp.bad(12, pg_temp.co('f12@market-test.invalid', '[{"product_id":"x","qty":1}]', '{}'))),
  'buyer.phone,buyer.email,buyer.name,buyer.name,buyer.city,buyer.address,buyer.note,terms_version,items,items,items,items');
SELECT pg_temp.expect('空購物車 → EMPTY_CART;超過 50 行 → TOO_MANY_ITEMS',
  (pg_temp.place(pg_temp.anon(), '198.51.102.1', pg_temp.co('e1@market-test.invalid', '[]', '{}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.102.2', pg_temp.co('e2@market-test.invalid',
     (SELECT jsonb_agg(pg_temp.item('a2', 1)) FROM generate_series(1, 51)), '{}')) ->> 'code'),
  'EMPTY_CART|TOO_MANY_ITEMS');
SELECT pg_temp.expect('同一個 Email 一小時前 3 次可以,第 4 次 RATE_LIMITED(有 retry_after)',
  (SELECT string_agg(pg_temp.place(pg_temp.anon(), '198.51.103.' || n, pg_temp.co('rate@market-test.invalid',
            jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok', ',' ORDER BY n)
     FROM generate_series(1, 3) AS n) || '|' ||
  (SELECT (r ->> 'code') || '|' || ((r ->> 'retry_after')::integer > 0)::text
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.103.9', pg_temp.co('rate@market-test.invalid',
             jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true,true,true|RATE_LIMITED|true');
SELECT pg_temp.expect('……被擋的那次不吃額度(Email 計數停在 3)',
  (SELECT hits::text FROM public.market_rate_counters
    WHERE bucket = public.market_rate_key('email', 'rate@market-test.invalid',
                                          (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'),
  '3');
-- 手機業者的 IPv4 常是一大群人共用一個(CGNAT):同一個 IP 一小時內不同買家各下一單都照常
-- (A 段同一個 IP 每小時 30 次嘗試、B 段同一個 IPv4 每天 20 單;見第 5 節)
SELECT pg_temp.expect('同一個 IPv4 一小時內 6 個買家各下一單都照常(CGNAT 共用位址不會誤擋)',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), '198.51.104.1', pg_temp.co('ip' || n || '@market-test.invalid',
            jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(1, 6) AS n),
  'ok,ok,ok,ok,ok,ok');
SELECT pg_temp.expect('拿不到 IP 的請求不算 IP 額度(改算全站共用的保底 noip,每小時 60 次,見第 5 節)',
  pg_temp.place(pg_temp.anon(), NULL, pg_temp.co('noip@market-test.invalid',
    jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok',
  'true');
-- 每個 bucket 都必須是「種類:16 位雜湊|窗格」、global|day 或拿不到 IP 時的 noip|窗格(單元測試的 test: 除外)。
-- 原本用 bucket ~ '@|09[0-9]{8}|198\.51' 找明文,但雜湊本身是十六進位,偶爾會出現「09 + 8 位數字」(鹽每次隨機),乾跑時紅時綠
SELECT pg_temp.expect('計數表裡沒有明文 Email / 電話 / IP(bucket 都是雜湊格式)',
  (SELECT count(*)::text FROM public.market_rate_counters
    WHERE bucket NOT LIKE 'test:%' AND bucket <> 'global|day'
      AND bucket !~ '^((ip|ip48|ipo|ip48o|email|phone):[0-9a-f]{16}|noip)[|](1h|day)$'), '0');
SELECT pg_temp.expect('anon 讀不到訂單、明細、紀錄、計數',
  concat_ws('|',
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_orders$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_order_items$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_order_events$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_rate_counters$q$)),
  'ERR 42501|ERR 42501|ERR 42501|ERR 42501');
SELECT pg_temp.expect('下單 RPC 有鎖商品列(FOR UPDATE),兩張單搶最後一件不會超賣',
  (position('FOR UPDATE' IN pg_get_functiondef('public.market_place_order(jsonb)'::regprocedure)) > 0)::text, 'true');

-- ---------------------------------------------------------------------
-- 3. token 查單
-- ---------------------------------------------------------------------
CREATE FUNCTION pg_temp.lookup(p_token text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.as_val('anon', pg_temp.anon(), format('SELECT public.market_get_orders(%L)::text', p_token))::jsonb
$f$;

SELECT pg_temp.expect('anon 可以呼叫查單 RPC;遮罩函式不開放',
  has_function_privilege('anon', 'public.market_get_orders(text)', 'EXECUTE')::text || '|' ||
  has_function_privilege('anon', 'public.market_mask_phone(text)', 'EXECUTE')::text,
  'true|false');
SELECT pg_temp.expect('anon 用 token 查到這次結帳的兩張單',
  (SELECT jsonb_array_length(pg_temp.lookup(v ->> 'token') -> 'orders')::text FROM _ctx WHERE k = 'happy'), '2');
SELECT pg_temp.expect('電話、Email 遮罩',
  (SELECT (o ->> 'buyer_phone') || '|' || (o ->> 'buyer_email')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' LIMIT 1),
  '0912***678|h***@market-test.invalid');
SELECT pg_temp.expect('A 店那張:明細 2 項、紀錄 1 筆、店名',
  (SELECT jsonb_array_length(o -> 'items')::text || '|' || jsonb_array_length(o -> 'events')::text || '|' || (o -> 'store' ->> 'name')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o -> 'store' ->> 'supplier_id' = 'a9200000-0000-4000-8000-00000000000a'),
  '2|1|市集測試 A 店');
SELECT pg_temp.expect('還沒接單:不給轉帳資訊',
  (SELECT COALESCE(o ->> 'transfer_info', '∅')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o ->> 'payment_method' = 'transfer'),
  '∅');
SELECT pg_temp.expect('B 店接單(轉帳 → 自動待匯款)',
  (SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000002'), format($q$
     INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (%L, 'pending', 'confirmed')$q$, o ->> 'id'))
     FROM _ctx, jsonb_array_elements(v -> 'orders') o
    WHERE k = 'happy' AND o ->> 'supplier_id' = 'a9200000-0000-4000-8000-00000000000b'),
  'OK');
SELECT pg_temp.expect('待匯款時才看得到轉帳資訊',
  (SELECT (o ->> 'status') || '|' || (o ->> 'transfer_info')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o ->> 'payment_method' = 'transfer'),
  'awaiting_payment|郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');
SELECT pg_temp.expect('亂填、格式不對、空的 token 都是 NOT_FOUND',
  concat_ws('|', pg_temp.lookup(repeat('A', 43)) ->> 'code', pg_temp.lookup('short') ->> 'code', pg_temp.lookup('') ->> 'code'),
  'NOT_FOUND|NOT_FOUND|NOT_FOUND');

-- ---------------------------------------------------------------------
-- 4. 下單 RPC 的安全要求(2026-10-11 自查)
--   收件資料擋看不見的字元(跟第 1 階段商品欄位同一套:market_trim 去頭尾、market_visible 判斷看不看得到字);
--   釘住長度上限、只賣「已核准、上架中、店家啟用、供應商啟用」的商品
--   chr(12288) = U+3000 全形空白、chr(8203) = U+200B 零寬空白(不寫跳脫序列,避免工具把它換成看不見的字元本身)
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('姓名、地址、條款版本只有全形空白或零寬字元 → INVALID_INPUT',
  concat_ws(',',
    pg_temp.bad(21, jsonb_set(pg_temp.co('v1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'),
                              '{buyer,name}', to_jsonb(chr(12288) || chr(8203) || chr(12288)))),
    pg_temp.bad(22, jsonb_set(pg_temp.co('v2@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'),
                              '{buyer,address}', to_jsonb(repeat(chr(12288), 3) || repeat(chr(8203), 3)))),
    pg_temp.bad(23, jsonb_set(pg_temp.co('v3@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'),
                              '{terms_version}', to_jsonb(chr(8203))))),
  'buyer.name,buyer.address,terms_version');
INSERT INTO _ctx VALUES ('visible', pg_temp.place(pg_temp.anon(), '198.51.105.1',
  jsonb_set(jsonb_set(pg_temp.co('visible@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
                                 '{"a9200000-0000-4000-8000-00000000000a":"cod"}'),
                      '{buyer,note}', to_jsonb(chr(12288) || chr(8203))),
            '{buyer,name}', to_jsonb(chr(12288) || '王小明' || chr(8203)))));
SELECT pg_temp.expect('姓名頭尾的全形空白、零寬字元去掉;只有看不見字元的備註當成沒填',
  (SELECT COALESCE(v ->> 'code', 'ok') FROM _ctx WHERE k = 'visible') || '|' ||
  COALESCE((SELECT o.buyer_name || '|' || COALESCE(o.buyer_note, '∅')
              FROM _ctx, public.market_orders o
             WHERE k = 'visible' AND o.id = (v -> 'orders' -> 0 ->> 'id')::uuid), '(沒有建單)'),
  'ok|王小明|∅');
SELECT pg_temp.expect('長度上限:地址 201 字、條款版本 21 字、Email 超過 254 字都擋',
  concat_ws(',',
    pg_temp.bad(31, jsonb_set(pg_temp.co('c1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'),
                              '{buyer,address}', to_jsonb(repeat('路', 201)))),
    pg_temp.bad(32, jsonb_set(pg_temp.co('c2@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'),
                              '{terms_version}', to_jsonb(repeat('v', 21)))),
    pg_temp.bad(33, pg_temp.co(repeat('a', 250) || '@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'))),
  'buyer.address,terms_version,buyer.email');
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  UPDATE public.market_stores SET is_enabled = false, disabled_reason = '測試:管理員停用'
   WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$);
UPDATE public.suppliers SET is_active = false WHERE id = 'a9200000-0000-4000-8000-00000000000a';
SELECT pg_temp.expect('店家被管理員停用、供應商帳號停用:商品都 PRODUCT_UNAVAILABLE',
  (pg_temp.place(pg_temp.anon(), '198.51.106.1', pg_temp.co('d1@market-test.invalid', jsonb_build_array(pg_temp.item('b1', 1)),
     '{"a9200000-0000-4000-8000-00000000000b":"cod"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.106.2', pg_temp.co('d2@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
     '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code'),
  'PRODUCT_UNAVAILABLE|PRODUCT_UNAVAILABLE');
UPDATE public.suppliers SET is_active = true WHERE id = 'a9200000-0000-4000-8000-00000000000a';
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  UPDATE public.market_stores SET is_enabled = true WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$);

-- ---------------------------------------------------------------------
-- 5. 第 2 階段審查修正(2026-10-11)
-- ---------------------------------------------------------------------
-- 5-1 查單不給店家的 contact_email(新訂單通知信箱,第 1 階段已定案不送到瀏覽器);店名、電話留著
SELECT pg_temp.expect('查單回應沒有 contact_email;兩家店的店名、電話都還在',
  (SELECT (position('contact_email' IN r::text) = 0)::text || '|' ||
          (SELECT string_agg(o -> 'store' ->> 'name', ',' ORDER BY o -> 'store' ->> 'name') FROM jsonb_array_elements(r -> 'orders') o) || '|' ||
          (SELECT bool_and(o -> 'store' ? 'phone') FROM jsonb_array_elements(r -> 'orders') o)::text
     FROM (SELECT pg_temp.lookup(v ->> 'token') AS r FROM _ctx WHERE k = 'happy') x),
  'true|市集測試 A 店,市集測試 B 店|true');
-- 5-2 查單回傳的紀錄順序固定(同一個交易寫的「已接單」與自動補的「待匯款」也分得出先後)
SELECT pg_temp.expect('查單的紀錄順序:B 店轉帳單 pending → confirmed → awaiting_payment',
  (SELECT string_agg(t.ev ->> 'to_status', '>' ORDER BY t.ord)
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o,
          jsonb_array_elements(o -> 'events') WITH ORDINALITY AS t(ev, ord)
    WHERE k = 'happy' AND o ->> 'payment_method' = 'transfer'),
  'pending>confirmed>awaiting_payment');
-- 5-3 補庫存只補下單時真的扣掉的數量(審查員的情境):下單時不限量 → 店家改成庫存 10 → 取消 → 還是 10
INSERT INTO _ctx VALUES ('unlimited', pg_temp.place(pg_temp.anon(), '198.51.107.1', pg_temp.co('unlimited@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 2)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
  UPDATE public.market_products SET stock = 10 WHERE id = 'a9300000-0000-4000-8000-0000000000a2'$q$);
SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), format($q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, note) VALUES (%L, 'pending', 'cancelled', '改成限量後取消')$q$,
  (SELECT v -> 'orders' -> 0 ->> 'id' FROM _ctx WHERE k = 'unlimited')));
SELECT pg_temp.expect('下單時不限量、店家之後改成庫存 10、再取消:庫存還是 10(不會憑空多出 2)',
  (SELECT COALESCE(v ->> 'code', 'ok') FROM _ctx WHERE k = 'unlimited') || '|' ||
  (SELECT o.status FROM public.market_orders o WHERE o.id = (SELECT (v -> 'orders' -> 0 ->> 'id')::uuid FROM _ctx WHERE k = 'unlimited')) || '|' ||
  (SELECT stock::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a2'),
  'ok|cancelled|10');
-- 牛肉片改回不限量(後面的測試當它不限量)
SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
  UPDATE public.market_products SET stock = NULL WHERE id = 'a9300000-0000-4000-8000-0000000000a2'$q$);
SELECT pg_temp.expect('下單記下每一項真的扣掉的庫存:高麗菜 2、鮭魚 1、不限量的牛肉片 0',
  (SELECT string_agg(i.product_name || '=' || i.stock_deducted, ',' ORDER BY i.unit_price)
     FROM public.market_order_items i
    WHERE i.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '有機高麗菜=2,挪威鮭魚=1,牛肉片=0');
-- 5-4 金額用 bigint 算:任一家店的商品小計(不含運費)超過 1,000,000 → ORDER_TOO_LARGE(不丟例外、不建單、庫存不變);
--     只看小計:一件百萬元商品加運費照樣能買,最低訂購金額的上限 1,000,000 也一定達得到
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, review_status)
  SELECT ('a9300000-0000-4000-8000-000000d00' || lpad(n::text, 3, '0'))::uuid, 'a9200000-0000-4000-8000-00000000000a',
         '高價品 ' || n, 'meat', '1 份', 1000000, 100, 'approved'
    FROM generate_series(1, 22) AS n$q$);
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, review_status) VALUES
    ('a9300000-0000-4000-8000-000000d00b01', 'a9200000-0000-4000-8000-00000000000b', 'B 店百萬元品', 'seafood', '1 份', 1000000, 5, 'approved'),
    ('a9300000-0000-4000-8000-000000d00a01', 'a9200000-0000-4000-8000-00000000000a', '一元加購品', 'grocery', '1 份', 1, NULL, 'approved')$q$);
INSERT INTO _ctx VALUES ('too_large', pg_temp.place(pg_temp.anon(), '198.51.107.2', pg_temp.co('big@market-test.invalid',
  (SELECT jsonb_agg(jsonb_build_object('product_id', 'a9300000-0000-4000-8000-000000d00' || lpad(n::text, 3, '0'), 'qty', 99))
     FROM generate_series(1, 22) AS n),
  '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('22 件百萬元商品各 99 個 → ORDER_TOO_LARGE(帶店家)、不建單、庫存不變',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'supplier_id') FROM _ctx WHERE k = 'too_large') || '|' ||
  (SELECT count(*)::text FROM public.market_orders WHERE buyer_email = 'big@market-test.invalid') || '|' ||
  (SELECT (count(*) = 22 AND bool_and(stock = 100))::text FROM public.market_products WHERE id::text LIKE 'a9300000-0000-4000-8000-000000d000%'),
  'ORDER_TOO_LARGE|a9200000-0000-4000-8000-00000000000a|0|true');
INSERT INTO _ctx VALUES ('too_large_1', pg_temp.place(pg_temp.anon(), '198.51.107.4', pg_temp.co('big3@market-test.invalid',
  '[{"product_id":"a9300000-0000-4000-8000-000000d00001","qty":1},{"product_id":"a9300000-0000-4000-8000-000000d00a01","qty":1}]',
  '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('商品小計 1,000,001(百萬元品 + 一元加購品)→ ORDER_TOO_LARGE(帶店家與小計)、不建單',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'supplier_id') || '|' || (v -> 'stores' -> 0 ->> 'subtotal') FROM _ctx WHERE k = 'too_large_1')
  || '|' || (SELECT count(*)::text FROM public.market_orders WHERE buyer_email = 'big3@market-test.invalid'),
  'ORDER_TOO_LARGE|a9200000-0000-4000-8000-00000000000a|1000001|0');
SELECT pg_temp.expect('一件 1,000,000 元的商品加運費(B 店運費 60)可以下單:總額 1,000,060',
  (SELECT COALESCE(r ->> 'code', 'ok') || '|' || COALESCE(r -> 'orders' -> 0 ->> 'total', '')
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.107.3', pg_temp.co('big2@market-test.invalid',
             '[{"product_id":"a9300000-0000-4000-8000-000000d00b01","qty":1}]', '{"a9200000-0000-4000-8000-00000000000b":"cod"}')) AS r) x),
  'ok|1000060');
-- 5-5 限流重排:欄位檢查 → 開關 → A 段(同一個網路的嘗試次數,失敗的也算)→ 購物車、商品、店家檢查與算錢
--     → B 段(Email / 電話 / 全站,只在準備建單時扣、一次結帳算 1)→ 建單
-- (a) 失敗的嘗試不吃 Email、電話、全站額度;同一個 IP 照算
INSERT INTO _ctx VALUES ('g0', to_jsonb(COALESCE((SELECT hits FROM public.market_rate_counters WHERE bucket = 'global|day'), 0)));
SELECT pg_temp.expect('同一個 Email 先失敗 3 次(缺貨、價格變了、未達最低金額),第 4 次照樣能下單',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), '198.51.108.1', c) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM (VALUES
       (1, pg_temp.co('fails@market-test.invalid', jsonb_build_array(pg_temp.item('b1', 99)), '{"a9200000-0000-4000-8000-00000000000b":"cod"}')),
       (2, pg_temp.co('fails@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}',
                      '臺北市', '{"a9200000-0000-4000-8000-00000000000a": 1}')),
       (3, pg_temp.co('fails@market-test.invalid', jsonb_build_array(pg_temp.item('a1', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')),
       (4, pg_temp.co('fails@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}'))
     ) AS v(n, c)),
  'OUT_OF_STOCK,PRICE_CHANGED,BELOW_MINIMUM,ok');
SELECT pg_temp.expect('……計數:Email 1、電話 1、全站 +1(只有成功那次);同一個 IP 4(失敗的嘗試也算)',
  concat_ws('|',
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('email', 'fails@market-test.invalid',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'), '0'),
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('phone', '09' || lpad((abs(hashtext('fails@market-test.invalid')) % 100000000)::text, 8, '0'),
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|day'), '0'),
    ((SELECT hits FROM public.market_rate_counters WHERE bucket = 'global|day') - (SELECT v::text::integer FROM _ctx WHERE k = 'g0'))::text,
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('ip', '198.51.108.1',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'), '0')),
  '1|1|1|4');
SELECT pg_temp.expect('B 段一次結帳只算 1(happy 一次結帳兩家店:Email 計數 1)',
  COALESCE((SELECT hits::text FROM public.market_rate_counters
             WHERE bucket = public.market_rate_key('email', 'happy@market-test.invalid',
                                                   (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'), '0'),
  '1');
-- (b) B 段超額:不建單、不動庫存;A 段已經扣的照算(bcap 先成功 3 次,第 4 次買有庫存的高麗菜:商品、金額都過關,卡在 B 段)
SELECT pg_temp.place(pg_temp.anon(), '198.51.109.' || n, pg_temp.co('bcap@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}'))
  FROM generate_series(1, 3) AS n;
INSERT INTO _ctx VALUES ('bcap_stock', to_jsonb((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')));
INSERT INTO _ctx VALUES ('bcap4', pg_temp.place(pg_temp.anon(), '198.51.109.4', pg_temp.co('bcap@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 3)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('B 段超額(同一個 Email 第 4 次):RATE_LIMITED、不建單、庫存不變;這個 IP 的 A 段照算 1 次',
  concat_ws('|',
    (SELECT v ->> 'code' FROM _ctx WHERE k = 'bcap4'),
    (SELECT count(*)::text FROM public.market_orders WHERE buyer_email = 'bcap@market-test.invalid'),
    ((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')
       = (SELECT v::text::integer FROM _ctx WHERE k = 'bcap_stock'))::text,
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('ip', '198.51.109.4',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'), '0')),
  'RATE_LIMITED|3|true|1');
-- (c) IPv6 /48:很多用戶共用同一個 /48(手機、家用寬頻的 /64、/56 都是從業者的 /48 位址池切出來的),
--     所以 A 段的 /48 只防灌爆(每小時 200 次嘗試),嚴格的額度只算成單(B 段 ip48o:同一個 /48 每天 20 單)
-- (c1) 複審 R6b:同一個 /48 裡別人用 4 個 /64 各送 5 次空購物車,另一個 /64 的正常買家第一次下單照樣成功
SELECT pg_temp.expect('同一個 /48:別人 4 個 /64 各送 5 次空購物車(20 次)之後,另一個 /64 的正常買家照樣能下單',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(),
            CASE WHEN n < 20 THEN '2001:db8:48:' || to_hex(n / 5) || '::1' ELSE '2001:db8:48:ff::1' END,
            CASE WHEN n < 20 THEN pg_temp.co('v6junk-' || n || '@market-test.invalid', '[]'::jsonb, '{}'::jsonb)
                 ELSE pg_temp.co('v6-neighbor@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
                                 '{"a9200000-0000-4000-8000-00000000000a":"cod"}') END) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(0, 20) AS n),
  repeat('EMPTY_CART,', 20) || 'ok');
-- (c2) 同一個 /48 當天第 21 單 RATE_LIMITED(B 段 ip48o):不建單、不動庫存。前 20 單用 20 個不同的 /64、不同 Email
SELECT pg_temp.place(pg_temp.anon(), '2001:db8:4a:' || to_hex(n) || '::1', pg_temp.co('v6o-' || n || '@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}'))
  FROM generate_series(1, 20) AS n;
INSERT INTO _ctx VALUES ('o48_stock', to_jsonb((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')));
INSERT INTO _ctx VALUES ('o48_21', pg_temp.place(pg_temp.anon(), '2001:db8:4a:15::1', pg_temp.co('v6o-21@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 3)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('同一個 /48 當天第 21 單:RATE_LIMITED、不建單、庫存不變;這個 /48 的成單計數 20(只算成單)',
  concat_ws('|',
    (SELECT v ->> 'code' FROM _ctx WHERE k = 'o48_21'),
    (SELECT count(*)::text FROM public.market_orders WHERE buyer_email LIKE 'v6o-%@market-test.invalid'),
    ((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')
       = (SELECT v::text::integer FROM _ctx WHERE k = 'o48_stock'))::text,
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('ip48o', '2001:db8:4a::',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|day'), '0')),
  'RATE_LIMITED|20|true|20');
-- (c3) 同一個 /48 一小時內第 201 次嘗試 RATE_LIMITED(A 段 ip48 每小時 200;201 個不同的 /64,每個只送 1 次空購物車)
SELECT pg_temp.expect('同一個 /48 一小時內第 201 次嘗試 RATE_LIMITED',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), '2001:db8:4b:' || to_hex(n) || '::1',
            pg_temp.co('v6f-' || n || '@market-test.invalid', '[]'::jsonb, '{}'::jsonb)) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(1, 201) AS n),
  repeat('EMPTY_CART,', 200) || 'RATE_LIMITED');
SELECT pg_temp.expect('/48 的兩種 bucket(A 段 ip48、B 段 ip48o)都只存加鹽雜湊',
  (SELECT (count(*) FILTER (WHERE bucket LIKE 'ip48:%') > 0 AND count(*) FILTER (WHERE bucket LIKE 'ip48o:%') > 0
           AND bool_and(bucket ~ '^ip48o?:[0-9a-f]{16}[|](1h|day)$'))::text
     FROM public.market_rate_counters WHERE bucket LIKE 'ip48%'),
  'true');
-- 5-6 拿不到 IP 時的保底額度:全站共用一格 noip(每小時 60、每天 300,回 RATE_LIMITED);被擋的不吃 B 段額度
--     (先清掉第 2 節「拿不到 IP」那一筆留下的 noip 計數,從 0 開始數;Email 用新的,第 2 節那筆已經吃過 noip@ 的額度)
DELETE FROM public.market_rate_counters WHERE bucket LIKE 'noip|%';
INSERT INTO _ctx VALUES ('g1', to_jsonb(COALESCE((SELECT hits FROM public.market_rate_counters WHERE bucket = 'global|day'), 0)));
SELECT pg_temp.expect('沒有 IP 標頭:同一個 Email 連送 61 次(缺貨),前 60 次照常檢查、第 61 次 RATE_LIMITED',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), NULL, pg_temp.co('noip-flood@market-test.invalid',
            jsonb_build_array(pg_temp.item('b1', 99)), '{"a9200000-0000-4000-8000-00000000000b":"cod"}')) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(1, 61) AS n),
  repeat('OUT_OF_STOCK,', 60) || 'RATE_LIMITED');
SELECT pg_temp.expect('……noip 計數 60(被擋的那次不算);不吃 B 段額度(Email、電話沒有計數,全站沒加)',
  concat_ws('|',
    COALESCE((SELECT hits::text FROM public.market_rate_counters WHERE bucket = 'noip|1h'), '0'),
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('email', 'noip-flood@market-test.invalid',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'), '0'),
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('phone', '09' || lpad((abs(hashtext('noip-flood@market-test.invalid')) % 100000000)::text, 8, '0'),
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|day'), '0'),
    ((SELECT hits FROM public.market_rate_counters WHERE bucket = 'global|day') - (SELECT v::text::integer FROM _ctx WHERE k = 'g1'))::text),
  '60|0|0|0');
-- 5-7 IPv4 共用位址(CGNAT):A 段同一個 IP 每小時 30 次嘗試、不設每天(只防灌爆);B 段同一個 IPv4 每天 20 單(ipo,只算成單)
SELECT pg_temp.expect('同一個 IPv4:失敗嘗試 29 次之後(第 30 次)照樣能下單,第 31 次嘗試 RATE_LIMITED',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), '198.51.130.1',
            CASE WHEN n <= 29 THEN pg_temp.co('cgnat-fail-' || n || '@market-test.invalid', jsonb_build_array(pg_temp.item('b1', 99)),
                                              '{"a9200000-0000-4000-8000-00000000000b":"cod"}')
                 ELSE pg_temp.co('cgnat-' || n || '@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
                                 '{"a9200000-0000-4000-8000-00000000000a":"cod"}') END) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(1, 31) AS n),
  repeat('OUT_OF_STOCK,', 29) || 'ok,RATE_LIMITED');
SELECT pg_temp.place(pg_temp.anon(), '198.51.131.1', pg_temp.co('ipo-' || n || '@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}'))
  FROM generate_series(1, 20) AS n;
INSERT INTO _ctx VALUES ('ipo_stock', to_jsonb((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')));
INSERT INTO _ctx VALUES ('ipo_21', pg_temp.place(pg_temp.anon(), '198.51.131.1', pg_temp.co('ipo-21@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 3)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('同一個 IPv4 當天第 21 單:RATE_LIMITED、不建單、庫存不變;這個 IPv4 的成單計數 20(只算成單)',
  concat_ws('|',
    (SELECT v ->> 'code' FROM _ctx WHERE k = 'ipo_21'),
    (SELECT count(*)::text FROM public.market_orders WHERE buyer_email LIKE 'ipo-%@market-test.invalid'),
    ((SELECT stock FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1')
       = (SELECT v::text::integer FROM _ctx WHERE k = 'ipo_stock'))::text,
    COALESCE((SELECT hits::text FROM public.market_rate_counters
               WHERE bucket = public.market_rate_key('ipo', '198.51.131.1',
                                                     (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|day'), '0')),
  'RATE_LIMITED|20|true|20');
