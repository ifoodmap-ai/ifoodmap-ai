-- =====================================================================
-- migration 20261012100000_market_hardening 的資料庫層測試:IP 退路、被擋的請求非同步 commit、逾時自動取消。
--   … dry supabase/tests/database/market_hardening.test.sql \
--     --with-migration supabase/migrations/20261012100000_market_hardening.sql \
--     --with-migration supabase/migrations/20261012110000_market_compliance.sql
--   (120000 / 120100 / 130000 / 130100 / 130200 已套用正式庫,不要再帶;兩支套用之後拿掉 --with-migration 再跑一次;
--    fixture 的店家帶了 110000 的法定資訊欄位,所以 110000 也要帶)
-- 下單開關、通知網址只在這個交易裡改;fixture 用的 guard 只在這個交易裡換掉又換回來;全部跟著 ROLLBACK 消失。
-- 時數:73 / 71 小時 = 自動取消時數的前後各一小時(時數只定義在 migration 的常數);時數改了,這裡跟著改。
-- 並發(兩個連線同時操作同一張單)乾跑是單一連線測不到:market_expire_orders 靠 FOR UPDATE SKIP LOCKED 跳過別人鎖住的單。
-- 店家、商品 fixture 跟 market_checkout 測試同一組:A 店只收貨到付款、B 店收貨到付款與轉帳;高麗菜(a1)庫存 10。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email, phone) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid', '02-2345-6789'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid', '02-2345-6789');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info) VALUES
  ('a9200000-0000-4000-8000-00000000000b', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');
INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, payment_methods, legal_name, representative, business_address, service_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市', '新北市'], 120, 1000, 300, ARRAY['cod'], '市集測試商行', '測試負責人', '臺北市測試路 1 號', 'service@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, NULL, 0, ARRAY['cod', 'transfer'], '市集測試商行', '測試負責人', '臺北市測試路 1 號', 'service@market-test.invalid');
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, review_status, is_listed) VALUES
    ('a9300000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-00000000000a', '有機高麗菜', 'vegetable', '1 顆', 100, 10, 'chilled', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a2', 'a9200000-0000-4000-8000-00000000000a', '牛肉片', 'meat', '300g/盒', 450, NULL, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a3', 'a9200000-0000-4000-8000-00000000000a', '待審商品', 'fruit', '1 盒', 100, NULL, 'ambient', 'pending', true),
    ('a9300000-0000-4000-8000-0000000000b1', 'a9200000-0000-4000-8000-00000000000b', '挪威鮭魚', 'seafood', '200g/片', 200, 3, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000b2', 'a9200000-0000-4000-8000-00000000000b', '暫停販售的蝦', 'seafood', '1 盒', 300, NULL, 'frozen', 'approved', false)$q$);

CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

-- 以 anon(或帶 JWT 的登入者)身分呼叫下單 RPC,請求標頭自己給(p_headers NULL = 沒有任何標頭)
CREATE FUNCTION pg_temp.place_h(p_claims text, p_headers jsonb, p_checkout jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb;
  v_state text;
BEGIN
  PERFORM set_config('request.headers', COALESCE(p_headers::text, ''), true);
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

-- p_ip = 這次請求的 cf-connecting-ip(正式請求一定有)
CREATE FUNCTION pg_temp.place(p_claims text, p_ip text, p_checkout jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.place_h(p_claims, jsonb_build_object('cf-connecting-ip', p_ip), p_checkout)
$f$;

-- 結帳內容(跟 market_checkout 測試同一個寫法):電話由 Email 算出,token 每次都是新的
CREATE FUNCTION pg_temp.co(p_email text, p_items jsonb, p_payments jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'buyer', jsonb_build_object('name', '測試買家', 'phone', '09' || lpad((abs(hashtext(p_email)) % 100000000)::text, 8, '0'),
                                'email', p_email, 'city', '臺北市', 'address', '測試路 1 號 2 樓'),
    'items', p_items, 'payments', p_payments, 'terms_version', '2026-10-draft',
    'token', rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '='))
$f$;

CREATE FUNCTION pg_temp.item(p_product text, p_qty integer) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('product_id', 'a9300000-0000-4000-8000-0000000000' || p_product, 'qty', p_qty)
$f$;

CREATE FUNCTION pg_temp.salt() RETURNS text LANGUAGE sql AS $f$
  SELECT value FROM public.app_config WHERE key = 'market_rate_salt'
$f$;

-- 某個 bucket 所有窗格的計數總和(線上可能已經有別的窗格;這裡一律比前後差)
CREATE FUNCTION pg_temp.hits(p_bucket text) RETURNS integer LANGUAGE sql AS $f$
  SELECT COALESCE(sum(hits), 0)::integer FROM public.market_rate_counters WHERE bucket = p_bucket
$f$;

CREATE FUNCTION pg_temp.blocks(p_rule text) RETURNS integer LANGUAGE sql AS $f$
  SELECT COALESCE((SELECT hits FROM public.market_rate_blocks_daily
                    WHERE day = (now() AT TIME ZONE 'Asia/Taipei')::date AND rule = p_rule), 0)
$f$;

UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
UPDATE public.app_config SET value = 'true' WHERE key = 'market_checkout_open';
-- 這個連線本來的 synchronous_commit(PostgREST 的連線也是預設值);第 2 節比對「維持原值」用
INSERT INTO _ctx VALUES ('sc0', to_jsonb(current_setting('synchronous_commit')));

-- ---------------------------------------------------------------------
-- 1. 呼叫者 IP:cf-connecting-ip → x-real-ip → NULL(不再退回 x-forwarded-for);Cloudflare 的 Pseudo IPv4 改用 cf-connecting-ipv6
-- ---------------------------------------------------------------------
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2"}', true);
SELECT pg_temp.expect('只有 x-forwarded-for → NULL(不再退回第一段)', COALESCE(public.market_client_ip(), '∅'), '∅');
SELECT set_config('request.headers', '{"x-real-ip":"3.3.3.3"}', true);
SELECT pg_temp.expect('只有 x-real-ip → 用它', COALESCE(public.market_client_ip(), '∅'), '3.3.3.3');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1","x-real-ip":"3.3.3.3"}', true);
SELECT pg_temp.expect('x-real-ip 跟 x-forwarded-for 都有 → 用 x-real-ip', COALESCE(public.market_client_ip(), '∅'), '3.3.3.3');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1","x-real-ip":"3.3.3.3","cf-connecting-ip":"4.4.4.4"}', true);
SELECT pg_temp.expect('三個都有 → 用 cf-connecting-ip', COALESCE(public.market_client_ip(), '∅'), '4.4.4.4');
SELECT set_config('request.headers', '{"cf-connecting-ip":"2001:db8:1:2:3:4:5:6","x-forwarded-for":"1.1.1.1"}', true);
SELECT pg_temp.expect('cf-connecting-ip 是 IPv6 → 照舊取 /64', COALESCE(public.market_client_ip(), '∅'), '2001:db8:1:2::');
-- Cloudflare 的 Pseudo IPv4:cf-connecting-ip 落在 240.0.0.0/4(Class E,真的用戶端不會是這個位址)、而且 cf-connecting-ipv6
-- 是合法的 IPv6 位址 → 用 cf-connecting-ipv6(照 /64 正規化);其他情況照 cf-connecting-ip → x-real-ip → NULL
SELECT set_config('request.headers', '{"cf-connecting-ip":"240.1.2.3","cf-connecting-ipv6":"2001:db8:1:2::5","x-real-ip":"3.3.3.3"}', true);
INSERT INTO _ctx VALUES ('ps0a', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT set_config('request.headers', '{"cf-connecting-ip":"255.255.255.254","cf-connecting-ipv6":"2001:db8:1:2::5"}', true);
INSERT INTO _ctx VALUES ('ps0b', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT pg_temp.expect('Pseudo IPv4:cf-connecting-ip 在 240.0.0.0/4(240.1.2.3、255.255.255.254)、cf-connecting-ipv6 合法 → 用 IPv6 的 /64 網段位址(不看 x-real-ip)',
  (SELECT string_agg(v #>> '{}', ',' ORDER BY k) FROM _ctx WHERE k IN ('ps0a', 'ps0b')),
  '2001:db8:1:2::,2001:db8:1:2::');
SELECT set_config('request.headers', '{"cf-connecting-ip":"240.1.2.3"}', true);
INSERT INTO _ctx VALUES ('ps1', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT set_config('request.headers', '{"cf-connecting-ip":"240.1.2.3","cf-connecting-ipv6":"not-an-ip"}', true);
INSERT INTO _ctx VALUES ('ps2', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT set_config('request.headers', '{"cf-connecting-ip":"240.1.2.3","cf-connecting-ipv6":"1.2.3.4"}', true);
INSERT INTO _ctx VALUES ('ps3', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT set_config('request.headers', '{"cf-connecting-ip":"240.1.2.3","cf-connecting-ipv6":"2001:db8::/32"}', true);
INSERT INTO _ctx VALUES ('ps4', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT pg_temp.expect('240.x 但沒有 cf-connecting-ipv6、或它不是合法的 IPv6 位址(亂填、IPv4、網段)→ 用 240.x 本身',
  (SELECT string_agg(v #>> '{}', ',' ORDER BY k) FROM _ctx WHERE k IN ('ps1', 'ps2', 'ps3', 'ps4')),
  '240.1.2.3,240.1.2.3,240.1.2.3,240.1.2.3');
SELECT set_config('request.headers', '{"cf-connecting-ip":"203.0.113.5","cf-connecting-ipv6":"2001:db8:1:2::5"}', true);
INSERT INTO _ctx VALUES ('ps5', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT set_config('request.headers', '{"cf-connecting-ip":"239.255.255.255","cf-connecting-ipv6":"2001:db8:1:2::5"}', true);
INSERT INTO _ctx VALUES ('ps6', to_jsonb(COALESCE(public.market_client_ip(), '∅')));
SELECT pg_temp.expect('一般 IPv4(203.0.113.5;240.0.0.0/4 外面緊鄰的 239.255.255.255)帶了偽造的 cf-connecting-ipv6 → 一律不理,用 cf-connecting-ip',
  (SELECT string_agg(v #>> '{}', ',' ORDER BY k) FROM _ctx WHERE k IN ('ps5', 'ps6')),
  '203.0.113.5,239.255.255.255');
SELECT set_config('request.headers', '{"cf-connecting-ipv6":"2001:db8:1:2::5","x-real-ip":"3.3.3.3"}', true);
SELECT pg_temp.expect('只有 cf-connecting-ipv6、沒有 cf-connecting-ip → 不理它,照 x-real-ip → NULL 的順序',
  COALESCE(public.market_client_ip(), '∅'), '3.3.3.3');
SELECT set_config('request.headers', '', true);
SELECT pg_temp.expect('market_client_ip 簽章與屬性不變(沒有參數、回 text、STABLE),API 角色照樣不能執行',
  (SELECT pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.provolatile::text || '|' ||
          (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text
     FROM pg_proc p WHERE p.oid = 'public.market_client_ip()'::regprocedure),
  '|text|s|false');

-- 只帶 x-forwarded-for 的下單:IP 當成拿不到,算進全站共用的 noip(A 段),B 段也不算 ipo
INSERT INTO _ctx SELECT 'noip0', jsonb_build_object('h', pg_temp.hits('noip|1h'), 'd', pg_temp.hits('noip|day'));
INSERT INTO _ctx VALUES ('xff', pg_temp.place_h(pg_temp.anon(), '{"x-forwarded-for":"203.0.113.50"}'::jsonb,
  pg_temp.co('xff-only@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('只帶 x-forwarded-for 的下單:照常成單,計數算在 noip(每小時、每天各 +1),沒有那個 XFF 位址的 ip / ipo 列',
  concat_ws('|',
    (SELECT v ->> 'ok' FROM _ctx WHERE k = 'xff'),
    pg_temp.hits('noip|1h') - (SELECT (v ->> 'h')::integer FROM _ctx WHERE k = 'noip0'),
    pg_temp.hits('noip|day') - (SELECT (v ->> 'd')::integer FROM _ctx WHERE k = 'noip0'),
    (SELECT count(*) FROM public.market_rate_counters
      WHERE split_part(bucket, '|', 1) IN (public.market_rate_key('ip', '203.0.113.50', pg_temp.salt()),
                                           public.market_rate_key('ipo', '203.0.113.50', pg_temp.salt())))),
  'true|1|1|0');

-- Pseudo IPv4 的下單:A 段算真正 IPv6 的 /64(ip)與 /48(ip48),B 段算 /48 的成單(ip48o);240.x 那個位址不算
INSERT INTO _ctx VALUES ('pseudo', pg_temp.place_h(pg_temp.anon(), '{"cf-connecting-ip":"240.9.9.9","cf-connecting-ipv6":"2001:db8:77:1::5"}'::jsonb,
  pg_temp.co('pseudo@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('Pseudo IPv4 的下單:照常成單;計數算在真正的 IPv6(/64 的 ip、/48 的 ip48 與 ip48o 各 1),240.x 的 ip / ipo 沒有任何列',
  concat_ws('|',
    (SELECT v ->> 'ok' FROM _ctx WHERE k = 'pseudo'),
    pg_temp.hits(public.market_rate_key('ip', '2001:db8:77:1::', pg_temp.salt()) || '|1h'),
    pg_temp.hits(public.market_rate_key('ip48', '2001:db8:77::', pg_temp.salt()) || '|1h'),
    pg_temp.hits(public.market_rate_key('ip48o', '2001:db8:77::', pg_temp.salt()) || '|day'),
    (SELECT count(*) FROM public.market_rate_counters
      WHERE split_part(bucket, '|', 1) IN (public.market_rate_key('ip', '240.9.9.9', pg_temp.salt()),
                                           public.market_rate_key('ipo', '240.9.9.9', pg_temp.salt())))),
  'true|1|1|1|0');

-- ---------------------------------------------------------------------
-- 2. 被擋的請求改成非同步 commit;沒被擋的路不動
-- ---------------------------------------------------------------------
-- 乾跑是同一個交易:一旦被擋,這個交易接下來都是 off。所以先測「沒被擋」,每測完一次被擋就改回原值
SELECT pg_temp.expect('同一個 Email 先下 3 單都成功(每小時上限 3;A、B 段的 market_rate_take 都跑過、都沒擋)',
  (SELECT string_agg(COALESCE(pg_temp.place(pg_temp.anon(), '203.0.113.' || (20 + n), pg_temp.co('sync@market-test.invalid',
            jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code', 'ok'), ',' ORDER BY n)
     FROM generate_series(1, 3) AS n),
  'ok,ok,ok');
SELECT pg_temp.expect('成功下單之後(再加一次沒被擋的 market_rate_take),這個交易的 synchronous_commit 維持原值(原值不是 off)',
  concat_ws('|',
    public.market_rate_take('[{"bucket":"synctest:ok","window":"1h","limit":5}]'::jsonb) ->> 'ok',
    (current_setting('synchronous_commit') = (SELECT v #>> '{}' FROM _ctx WHERE k = 'sc0'))::text,
    ((SELECT v #>> '{}' FROM _ctx WHERE k = 'sc0') <> 'off')::text),
  'true|true|true');
INSERT INTO _ctx VALUES ('blk_email0', to_jsonb(pg_temp.blocks('email')));
INSERT INTO _ctx VALUES ('sync4', pg_temp.place(pg_temp.anon(), '203.0.113.24', pg_temp.co('sync@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('第 4 單被擋(經過下單 RPC 的層層呼叫,跟 PostgREST 一樣)之後,同一個交易的 synchronous_commit 是 off;擋下紀錄照寫',
  concat_ws('|', (SELECT v ->> 'code' FROM _ctx WHERE k = 'sync4'), current_setting('synchronous_commit'),
    pg_temp.blocks('email') - (SELECT (v #>> '{}')::integer FROM _ctx WHERE k = 'blk_email0')),
  'RATE_LIMITED|off|1');
SELECT set_config('synchronous_commit', (SELECT v #>> '{}' FROM _ctx WHERE k = 'sc0'), true);
INSERT INTO _ctx VALUES ('blk_direct', public.market_rate_take('[{"bucket":"synctest:no","window":"1h","limit":0}]'::jsonb));
SELECT pg_temp.expect('直接呼叫 market_rate_take 被擋:回 RATE_LIMITED,同一個交易的 synchronous_commit 是 off',
  (SELECT v ->> 'code' FROM _ctx WHERE k = 'blk_direct') || '|' || current_setting('synchronous_commit'),
  'RATE_LIMITED|off');
SELECT set_config('synchronous_commit', (SELECT v #>> '{}' FROM _ctx WHERE k = 'sc0'), true);

-- ---------------------------------------------------------------------
-- 3. 逾時自動取消(market_expire_orders)
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('market_expire_orders:沒有參數、回 integer、SECURITY DEFINER、search_path 固定、lock_timeout 5 秒(等不到鎖的那張跳過)',
  (SELECT pg_get_function_identity_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' ||
          array_to_string(p.proconfig, ',')
     FROM pg_proc p WHERE p.oid = 'public.market_expire_orders()'::regprocedure),
  '|integer|true|search_path="",lock_timeout=5s');
SELECT pg_temp.expect('anon、登入者(連平台管理員)都不能執行;PUBLIC 也收回了',
  concat_ws('|',
    pg_temp.as_exec('anon', pg_temp.anon(), 'SELECT public.market_expire_orders()'),
    pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), 'SELECT public.market_expire_orders()'),
    (has_function_privilege('anon', 'public.market_expire_orders()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.market_expire_orders()', 'EXECUTE'))::text,
    (SELECT (p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))::text
       FROM pg_proc p WHERE p.oid = 'public.market_expire_orders()'::regprocedure)),
  'ERR 42501|ERR 42501|false|true');
SELECT pg_temp.expect('排程 ifoodmap-market-expire-orders:每 10 分鐘、呼叫 market_expire_orders、啟用中',
  (SELECT string_agg(schedule || '|' || command || '|' || active::text, ';') FROM cron.job WHERE jobname = 'ifoodmap-market-expire-orders'),
  '*/10 * * * *|SELECT public.market_expire_orders()|true');

-- 線上本來就該取消的單先清掉(只在這個交易裡),下面的張數才會剛好
DO $$ BEGIN FOR i IN 1..100 LOOP EXIT WHEN public.market_expire_orders() = 0; END LOOP; END $$;

-- fixture:很久以前的訂單與紀錄。真的 guard 一律把紀錄時間改成伺服器時間,寫不出「73 小時前進入待匯款」;
-- 這個帳號也不能設 session_replication_role。所以只在這個交易裡把 guard 換成「照送來的值寫」的版本,
-- 建完再用換掉前的定義換回來(下一項比對逐字相同)。換函式不鎖表:其他連線照樣用已 commit 的版本。
INSERT INTO _ctx SELECT 'guard_def', to_jsonb(pg_get_functiondef('public.market_guard_event()'::regprocedure));
INSERT INTO _ctx SELECT 'guard_md5', to_jsonb(md5(pg_get_functiondef('public.market_guard_event()'::regprocedure)));
CREATE OR REPLACE FUNCTION public.market_guard_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $f$
BEGIN
  -- market_apply_event 自動補的「待匯款」(trigger 裡的 INSERT):跟真的 guard 一樣,緊接在上一筆後面、記成 system
  IF pg_trigger_depth() > 1 THEN
    NEW.created_at := (SELECT max(e.created_at) FROM public.market_order_events e WHERE e.order_id = NEW.order_id)
                      + interval '1 microsecond';
    NEW.actor_role := 'system';
    NEW.actor_id := NULL;
  END IF;
  RETURN NEW;
END
$f$;

-- 直接建訂單(資料庫擁有者身分,= 下單 RPC 寫的那幾欄),下單時間往前推 p_age
CREATE FUNCTION pg_temp.mk(p_id uuid, p_supplier uuid, p_payment text, p_age interval) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.market_orders (id, checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                    subtotal, shipping_fee, total, payment_method, lookup_token_hash, request_fingerprint, terms_version,
                                    created_at, updated_at)
  VALUES (p_id, 'a9700000-0000-4000-8000-000000000001', p_supplier, '測試買家', '0912345678', 'expire@market-test.invalid',
          '臺北市', '測試路 1 號 2 樓', 200, 120, 320, p_payment,
          encode(sha256(convert_to(p_id::text, 'UTF8')), 'hex'), repeat('f', 64), '2026-10-draft', now() - p_age, now() - p_age);
$f$;
-- 寫一筆紀錄,時間往前推 p_age(fixture 用的 guard 照送來的值寫;套用狀態、補庫存、通知照常由後面的 trigger 做)
CREATE FUNCTION pg_temp.ev(p_id uuid, p_from text, p_to text, p_actor text, p_age interval, p_payload jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, actor_role, created_at, payload)
  VALUES (p_id, p_from, p_to, p_actor, now() - p_age, p_payload);
$f$;

-- 01 待接單 73 小時(明細扣過 2 個高麗菜)    02 待接單 71 小時
-- 03 轉帳:下單 100 小時前、1 小時前才接單進待匯款   04 轉帳:下單 80 小時前、73 小時前接單進待匯款
-- 05 已接單(貨到付款)500 小時   06 已收款(499 小時前進待匯款)   07 已出貨   08 壞資料:待接單 80 小時但沒有任何紀錄
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '73 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '71 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000003', 'a9200000-0000-4000-8000-00000000000b', 'transfer', interval '100 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000004', 'a9200000-0000-4000-8000-00000000000b', 'transfer', interval '80 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '500 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000006', 'a9200000-0000-4000-8000-00000000000b', 'transfer', interval '500 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000007', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '500 hours');
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000008', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '80 hours');
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total, stock_deducted) VALUES
  ('a9600000-0000-4000-8000-000000000001', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'chilled', 100, 2, 200, 2);
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000001', NULL, 'pending', 'consumer', interval '73 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000002', NULL, 'pending', 'consumer', interval '71 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000003', NULL, 'pending', 'consumer', interval '100 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000003', 'pending', 'confirmed', 'supplier', interval '1 hour');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000004', NULL, 'pending', 'consumer', interval '80 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000004', 'pending', 'confirmed', 'supplier', interval '73 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000005', NULL, 'pending', 'consumer', interval '500 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000005', 'pending', 'confirmed', 'supplier', interval '499 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000006', NULL, 'pending', 'consumer', interval '500 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000006', 'pending', 'confirmed', 'supplier', interval '499 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000006', 'awaiting_payment', 'paid', 'supplier', interval '498 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000007', NULL, 'pending', 'consumer', interval '500 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000007', 'pending', 'confirmed', 'supplier', interval '499 hours');
SELECT pg_temp.ev('a9600000-0000-4000-8000-000000000007', 'confirmed', 'shipped', 'supplier', interval '498 hours', '{"carrier":"黑貓宅急便"}');
-- 49 張「取消不了」的單(…0000000050xx):有紀錄,但那筆紀錄的時間是 timestamptz 的最大值,真的 guard 算「上一筆 + 1 微秒」
-- 會溢位,每次取消都失敗。下單時間是 72 小時又 n 秒前(n = 1…49):逾時了,但比上面各張新,排在它們後面
SELECT pg_temp.mk(('a9600000-0000-4000-8000-' || lpad(to_hex(20480 + n), 12, '0'))::uuid,
                  'a9200000-0000-4000-8000-00000000000a', 'cod', interval '72 hours' + n * interval '1 second')
  FROM generate_series(1, 49) AS n;
INSERT INTO public.market_order_events (order_id, from_status, to_status, actor_role, created_at)
SELECT ('a9600000-0000-4000-8000-' || lpad(to_hex(20480 + n), 12, '0'))::uuid, NULL, 'pending', 'consumer',
       '294276-12-31 23:59:59.999999+00'::timestamptz
  FROM generate_series(1, 49) AS n;

DO $$ BEGIN EXECUTE (SELECT v #>> '{}' FROM _ctx WHERE k = 'guard_def'); END $$;
SELECT pg_temp.expect('fixture 建好了(各張單的狀態;轉帳單的待匯款時間:1 小時前、73 小時前、499 小時前),guard 換回原本的定義(逐字相同)',
  concat_ws('|',
    (SELECT string_agg(right(o.id::text, 2) || '=' || o.status, ',' ORDER BY o.id) FROM public.market_orders o
      WHERE o.id::text LIKE 'a9600000-0000-4000-8000-00000000000%'),
    (SELECT string_agg(right(e.order_id::text, 2) || '=' || round(extract(epoch FROM now() - e.created_at) / 3600)::text, ',' ORDER BY e.order_id)
       FROM public.market_order_events e WHERE e.to_status = 'awaiting_payment' AND e.order_id::text LIKE 'a9600000-0000-4000-8000-00000000000%'),
    (md5(pg_get_functiondef('public.market_guard_event()'::regprocedure)) = (SELECT v #>> '{}' FROM _ctx WHERE k = 'guard_md5'))::text),
  '01=pending,02=pending,03=awaiting_payment,04=awaiting_payment,05=confirmed,06=paid,07=shipped,08=pending|03=1,04=73,06=499|true');

INSERT INTO _ctx SELECT 'q0', to_jsonb((SELECT count(*) FROM net.http_request_queue WHERE url = 'http://127.0.0.1:9/market-test'));
INSERT INTO _ctx VALUES ('run1', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('第一次跑取消 2 張(待接單 73 小時、進入待匯款 73 小時)', (SELECT v #>> '{}' FROM _ctx WHERE k = 'run1'), '2');
SELECT pg_temp.expect('待接單 73 小時:取消;紀錄是 system(沒有 actor_id)、從 pending、原因寫明、payload 只有 auto_expire = pending;訂單的取消原因與時間跟紀錄一致',
  (SELECT concat_ws('|', o.status, e.actor_role, COALESCE(e.actor_id::text, '∅'), e.from_status, e.note, e.payload::text,
                    (o.status_note = e.note)::text, (o.closed_at = e.created_at)::text)
     FROM public.market_orders o JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'cancelled'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000001'),
  'cancelled|system|∅|pending|店家超過 72 小時沒有接單,系統自動取消|{"auto_expire": "pending"}|true|true');
SELECT pg_temp.expect('……庫存補回(高麗菜 10 → 12:這張單下單時扣了 2)',
  (SELECT stock::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a1'), '12');
SELECT pg_temp.expect('……通知佇列多一筆(就是這筆取消紀錄);這次一共多兩筆(兩張單各一)',
  concat_ws('|',
    (SELECT count(*) FROM net.http_request_queue q
      WHERE q.url = 'http://127.0.0.1:9/market-test'
        AND convert_from(q.body, 'UTF8')::jsonb ->> 'event_id' =
            (SELECT e.id::text FROM public.market_order_events e
              WHERE e.order_id = 'a9600000-0000-4000-8000-000000000001' AND e.to_status = 'cancelled')),
    (SELECT count(*) FROM net.http_request_queue WHERE url = 'http://127.0.0.1:9/market-test')
      - (SELECT (v #>> '{}')::bigint FROM _ctx WHERE k = 'q0')),
  '1|2');
SELECT pg_temp.expect('進入待匯款 73 小時:取消;system、從 awaiting_payment、原因寫明、auto_expire = awaiting_payment',
  (SELECT concat_ws('|', o.status, e.actor_role, e.from_status, e.note, e.payload::text)
     FROM public.market_orders o JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'cancelled'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000004'),
  'cancelled|system|awaiting_payment|超過 72 小時店家未確認收到款項,系統自動取消|{"auto_expire": "awaiting_payment"}');
SELECT pg_temp.expect('待接單 71 小時:不動', (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000002'), 'pending');
SELECT pg_temp.expect('轉帳單下單 100 小時前、1 小時前才進待匯款:不動(看進入待匯款的時間,不是下單時間)',
  (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000003'), 'awaiting_payment');
SELECT pg_temp.expect('已接單(貨到付款)、已收款(499 小時前進過待匯款)、已出貨:不論多舊都不動,也都沒有取消紀錄',
  (SELECT string_agg(o.status, ',' ORDER BY o.id) FROM public.market_orders o
    WHERE o.id IN ('a9600000-0000-4000-8000-000000000005', 'a9600000-0000-4000-8000-000000000006', 'a9600000-0000-4000-8000-000000000007'))
  || '|' ||
  (SELECT count(*) FROM public.market_order_events e
    WHERE e.to_status = 'cancelled' AND e.order_id IN ('a9600000-0000-4000-8000-000000000002', 'a9600000-0000-4000-8000-000000000003',
          'a9600000-0000-4000-8000-000000000005', 'a9600000-0000-4000-8000-000000000006', 'a9600000-0000-4000-8000-000000000007')),
  'confirmed,paid,shipped|0');
SELECT pg_temp.expect('沒有任何狀態紀錄的單不當候選(guard 一定擋,排在前面只會卡住後面的單),照樣是 pending',
  (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000008'), 'pending');
INSERT INTO _ctx SELECT 'ev1', to_jsonb((SELECT count(*) FROM public.market_order_events));
INSERT INTO _ctx VALUES ('run2', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('再跑一次回 0(冪等),也沒有多寫任何紀錄',
  (SELECT v #>> '{}' FROM _ctx WHERE k = 'run2') || '|' ||
  ((SELECT count(*) FROM public.market_order_events) - (SELECT (v #>> '{}')::bigint FROM _ctx WHERE k = 'ev1')),
  '0|0');

-- 每次最多取消 3 張(配合寄信的限速):7 張「80 小時又 n 秒前」的待接單(n 越大越舊),第一筆紀錄由真的 guard 寫
SELECT pg_temp.mk(('a9600000-0000-4000-8000-' || lpad(to_hex(4096 + n), 12, '0'))::uuid,
                  'a9200000-0000-4000-8000-00000000000a', 'cod', interval '80 hours' + n * interval '1 second')
  FROM generate_series(1, 7) AS n;
INSERT INTO public.market_order_events (order_id, from_status, to_status)
SELECT ('a9600000-0000-4000-8000-' || lpad(to_hex(4096 + n), 12, '0'))::uuid, NULL, 'pending' FROM generate_series(1, 7) AS n;
INSERT INTO _ctx VALUES ('cap1', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('每次最多取消 3 張:7 張逾時的待接單第一次只取消最舊的 3 張(剩下最晚下單的 4 張)',
  (SELECT v #>> '{}' FROM _ctx WHERE k = 'cap1') || '|' ||
  (SELECT string_agg(n::text, ',' ORDER BY n) FROM generate_series(1, 7) AS n
     JOIN public.market_orders o ON o.id = ('a9600000-0000-4000-8000-' || lpad(to_hex(4096 + n), 12, '0'))::uuid
    WHERE o.status = 'pending'),
  '3|1,2,3,4');
INSERT INTO _ctx VALUES ('cap2', to_jsonb(public.market_expire_orders()));
INSERT INTO _ctx VALUES ('cap3', to_jsonb(public.market_expire_orders()));
INSERT INTO _ctx VALUES ('cap4', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('……第二次 3 張、第三次剩下的 1 張(排在後面那 49 張取消不了的照樣失敗、不算)、第四次 0',
  concat_ws('|', (SELECT v #>> '{}' FROM _ctx WHERE k = 'cap2'), (SELECT v #>> '{}' FROM _ctx WHERE k = 'cap3'),
                 (SELECT v #>> '{}' FROM _ctx WHERE k = 'cap4')),
  '3|1|0');

-- 飢餓(審查 E4):60 張沒有任何紀錄的舊單(500 小時又 n 秒前)排在最前面,後面一張真的逾時的單照樣被取消
SELECT pg_temp.mk(('a9600000-0000-4000-8000-' || lpad(to_hex(8192 + n), 12, '0'))::uuid,
                  'a9200000-0000-4000-8000-00000000000a', 'cod', interval '500 hours' + n * interval '1 second')
  FROM generate_series(1, 60) AS n;
SELECT pg_temp.mk('a9600000-0000-4000-8000-00000000000b', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '75 hours');
INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES ('a9600000-0000-4000-8000-00000000000b', NULL, 'pending');
INSERT INTO _ctx VALUES ('starve', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('飢餓(審查 E4):前面有 60 張沒有任何紀錄的舊單時,後面那張逾時 75 小時的單照樣被取消',
  (SELECT v #>> '{}' FROM _ctx WHERE k = 'starve') || '|' ||
  (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-00000000000b'),
  '1|cancelled');

-- 每次最多看 50 張候選:那 49 張取消不了的單排在前面,第 50 張(…0c,72 小時又 0.6 秒)照樣取消、第 51 張(…0d)等下一輪
SELECT pg_temp.mk('a9600000-0000-4000-8000-00000000000c', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '72 hours 600 milliseconds');
SELECT pg_temp.mk('a9600000-0000-4000-8000-00000000000d', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '72 hours 300 milliseconds');
INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES
  ('a9600000-0000-4000-8000-00000000000c', NULL, 'pending'), ('a9600000-0000-4000-8000-00000000000d', NULL, 'pending');
INSERT INTO _ctx VALUES ('scan1', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('每次最多看 50 張候選、一張失敗不讓整批失敗:前面 49 張取消不了(每張都失敗、只記 WARNING),第 50 張照樣取消,第 51 張等下一輪',
  concat_ws('|', (SELECT v #>> '{}' FROM _ctx WHERE k = 'scan1'),
    (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-00000000000c'),
    (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-00000000000d'),
    (SELECT count(*) FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-0000000050%' AND status = 'pending')),
  '1|cancelled|pending|49');
INSERT INTO _ctx VALUES ('scan2', to_jsonb(public.market_expire_orders()));
INSERT INTO _ctx VALUES ('scan3', to_jsonb(public.market_expire_orders()));
SELECT pg_temp.expect('……下一輪取消第 51 張,再下一輪 0(那 49 張照樣失敗)',
  concat_ws('|', (SELECT v #>> '{}' FROM _ctx WHERE k = 'scan2'), (SELECT v #>> '{}' FROM _ctx WHERE k = 'scan3'),
    (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-00000000000d')),
  '1|0|cancelled');

-- auto_expire 只能用在系統的取消:兩張新的待接單(真的 guard 寫第一筆紀錄)
SELECT pg_temp.mk('a9600000-0000-4000-8000-000000000009', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '1 hour');
SELECT pg_temp.mk('a9600000-0000-4000-8000-00000000000a', 'a9200000-0000-4000-8000-00000000000a', 'cod', interval '1 hour');
INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES
  ('a9600000-0000-4000-8000-000000000009', NULL, 'pending'), ('a9600000-0000-4000-8000-00000000000a', NULL, 'pending');
SELECT pg_temp.expect('系統寫的紀錄:改成已接單帶 auto_expire、取消帶 shipped、帶的值跟取消前的狀態不同、值不是字串 → 都擋下(22023)',
  concat_ws('|',
    pg_temp.as_exec('postgres', '', $q$INSERT INTO public.market_order_events (order_id, to_status, payload)
      VALUES ('a9600000-0000-4000-8000-000000000009', 'confirmed', '{"auto_expire":"pending"}')$q$),
    pg_temp.as_exec('postgres', '', $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
      VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":"shipped"}')$q$),
    pg_temp.as_exec('postgres', '', $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
      VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":"awaiting_payment"}')$q$),
    pg_temp.as_exec('postgres', '', $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
      VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":true}')$q$)),
  'ERR 22023:auto_expire_invalid|ERR 22023:auto_expire_invalid|ERR 22023:auto_expire_invalid|ERR 22023:auto_expire_invalid');
SELECT pg_temp.expect('供應商、平台管理員取消時帶 auto_expire 也擋下(冒充不了「系統自動取消」的通知)',
  pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'),
    $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
       VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":"pending"}')$q$) || '|' ||
  pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true),
    $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
       VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":"pending"}')$q$),
  'ERR 22023:auto_expire_invalid|ERR 22023:auto_expire_invalid');
INSERT INTO _ctx VALUES ('g_sys', to_jsonb(pg_temp.as_exec('postgres', '', $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
  VALUES ('a9600000-0000-4000-8000-000000000009', 'cancelled', '測試', '{"auto_expire":"pending","x":1}')$q$)));
SELECT pg_temp.expect('系統的取消帶 auto_expire = 取消前的狀態:寫得進去,payload 只留 auto_expire(其他鍵照舊清掉)',
  (SELECT v #>> '{}' FROM _ctx WHERE k = 'g_sys') || '|' ||
  (SELECT e.payload::text || '|' || e.actor_role FROM public.market_order_events e
    WHERE e.order_id = 'a9600000-0000-4000-8000-000000000009' AND e.to_status = 'cancelled'),
  'OK|{"auto_expire": "pending"}|system');
INSERT INTO _ctx VALUES ('g_sup', to_jsonb(pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'),
  $q$INSERT INTO public.market_order_events (order_id, to_status, note, payload)
     VALUES ('a9600000-0000-4000-8000-00000000000a', 'cancelled', '缺貨', '{"foo":"bar"}')$q$)));
SELECT pg_temp.expect('一般的取消(供應商,payload 帶別的鍵)照舊:寫得進去、payload 清成 {}',
  (SELECT v #>> '{}' FROM _ctx WHERE k = 'g_sup') || '|' ||
  (SELECT e.payload::text || '|' || e.actor_role FROM public.market_order_events e
    WHERE e.order_id = 'a9600000-0000-4000-8000-00000000000a' AND e.to_status = 'cancelled'),
  'OK|{}|supplier');

-- ---------------------------------------------------------------------
-- 4. pg_cron 執行紀錄的清理(沿用每天的 ifoodmap-market-rate-cleanup)
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('每天的清理排程 ifoodmap-market-rate-cleanup:時間不變,指令多了清 cron.job_run_details(只限 ifoodmap-market- 的工作、14 天)',
  (SELECT concat_ws('|', schedule,
            (command LIKE '%DELETE FROM public.market_rate_counters%' AND command LIKE '%DELETE FROM public.market_rate_blocks_daily%'
             AND command LIKE '%DELETE FROM cron.job_run_details%' AND command LIKE '%ifoodmap-market-%' AND command LIKE '%14 days%')::text)
     FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup'),
  '50 19 * * *|true');
-- 放幾筆假的執行紀錄(runid 用負數,不動 cron.runid_seq),在交易裡實際跑一次清理指令
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT j.jobid, v.runid, 0, current_database(), 'postgres', 'test', 'succeeded', 'test', now() - v.age - interval '1 second', now() - v.age
  FROM (VALUES ('ifoodmap-market-expire-orders', -990001::bigint, interval '15 days'),
               ('ifoodmap-market-expire-orders', -990002::bigint, interval '13 days'),
               ('ifoodmap-market-rate-cleanup',  -990003::bigint, interval '15 days'),
               ('ifoodmap-ai-guard-cleanup',     -990004::bigint, interval '15 days')) AS v(jobname, runid, age)
  JOIN cron.job j ON j.jobname = v.jobname;
DO $$ BEGIN EXECUTE (SELECT command FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup'); END $$;
SELECT pg_temp.expect('……清理指令實際跑一次:我們的工作超過 14 天的紀錄刪掉、13 天的留著;別的工作(ifoodmap-ai-guard-cleanup)的紀錄不碰',
  (SELECT string_agg((-v.runid)::text || '=' || (SELECT count(*) FROM cron.job_run_details d WHERE d.runid = v.runid)::text, ',' ORDER BY -v.runid)
     FROM (VALUES (-990001::bigint), (-990002::bigint), (-990003::bigint), (-990004::bigint)) AS v(runid)),
  '990001=0,990002=1,990003=0,990004=1');
