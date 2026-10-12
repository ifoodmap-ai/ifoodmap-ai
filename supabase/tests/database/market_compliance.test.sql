-- =====================================================================
-- migration 20261012110000_market_compliance 的資料庫層測試:七日解除權逐項標示、店家法定資訊、查單 RPC 的店家資訊。
--   … dry supabase/tests/database/market_compliance.test.sql \
--     --with-migration supabase/migrations/20261012100000_market_hardening.sql \
--     --with-migration supabase/migrations/20261012110000_market_compliance.sql
--   (120000 / 120100 / 130000 / 130100 / 130200 已套用正式庫,不要再帶;100000、110000 同一次部署,套用之後拿掉再跑一次)
-- 下單開關、通知網址只在這個交易裡改,全部跟著 ROLLBACK 消失。
-- 店家、商品 fixture 跟 market_checkout 測試同一組(A 店、B 店都已填齊法定資訊、供應商有電話)。
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

-- 另外兩家:C 店(有電話、還沒建零售店家)、D 店(供應商資料沒有電話、還沒建零售店家)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-c@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-d@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email, phone) VALUES
  ('a9200000-0000-4000-8000-00000000000c', '市集測試 C 店', 'store-c@market-test.invalid', '03-345-6789'),
  ('a9200000-0000-4000-8000-00000000000d', '市集測試 D 店', 'store-d@market-test.invalid', NULL);
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000004', 'a9200000-0000-4000-8000-00000000000c'),
  ('a9100000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000d');
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, review_status, is_listed) VALUES
    ('a9300000-0000-4000-8000-0000000000a4', 'a9200000-0000-4000-8000-00000000000a', '手工豆干', 'processed', '300g/包', 80, NULL, 'chilled', 'approved', true)$q$);

CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.uc() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000004') $f$;
CREATE FUNCTION pg_temp.ud() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000005') $f$;
CREATE FUNCTION pg_temp.uadmin() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true) $f$;
-- 以 anon 呼叫下單 RPC(cf-connecting-ip = p_ip)
CREATE FUNCTION pg_temp.place(p_ip text, p_checkout jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb;
  v_state text;
BEGIN
  PERFORM set_config('request.headers', json_build_object('cf-connecting-ip', p_ip)::text, true);
  PERFORM set_config('request.jwt.claims', pg_temp.anon(), true);
  PERFORM set_config('role', 'anon', true);
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
CREATE FUNCTION pg_temp.ex(p_product text) RETURNS text LANGUAGE sql AS $f$
  SELECT withdrawal_exempt::text || '|' || review_status FROM public.market_products WHERE id = ('a9300000-0000-4000-8000-0000000000' || p_product)::uuid
$f$;

-- ---------------------------------------------------------------------
-- 1. 新欄位與 CHECK
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('新欄位:商品與明細的 withdrawal_exempt(boolean NOT NULL 預設 false = 適用七日解除權),店家的六個法定資訊(text,可以是 NULL)',
  (SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '∅'), ','
                     ORDER BY table_name, column_name)
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name IN ('market_products', 'market_order_items') AND column_name = 'withdrawal_exempt')
        OR (table_name = 'market_stores' AND column_name IN ('legal_name', 'representative', 'business_address', 'service_email',
                                                              'food_registration_no', 'liability_insurance')))),
  'market_order_items.withdrawal_exempt:boolean:NO:false,market_products.withdrawal_exempt:boolean:NO:false,'
  || 'market_stores.business_address:text:YES:∅,market_stores.food_registration_no:text:YES:∅,market_stores.legal_name:text:YES:∅,'
  || 'market_stores.liability_insurance:text:YES:∅,market_stores.representative:text:YES:∅,market_stores.service_email:text:YES:∅');
SELECT pg_temp.expect('長度 CHECK(23514):登記名稱 101 字、負責人 51 字、營業所地址 4 字與 201 字、登錄字號 41 字、產品責任險 101 字都擋;剛好在上限 / 下限的寫得進去',
  concat_ws('|',
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET legal_name = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('名', 101))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET representative = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('人', 51))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), $q$UPDATE public.market_stores SET business_address = '臺北1號' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET business_address = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('址', 201))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET food_registration_no = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('A', 41))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET liability_insurance = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('保', 101))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET legal_name = %L, representative = %L, business_address = %L,
                                                                  food_registration_no = %L, liability_insurance = %L
                                                            WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$,
                                                          repeat('名', 100), repeat('人', 50), '臺北市1號', repeat('A', 40), repeat('保', 100))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET business_address = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, repeat('址', 200)))),
  'ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|ERR 23514|OK|OK');
SELECT pg_temp.expect('客服 Email 照 market_email_ok(格式、254 字內):亂填、沒有網域、255 字都擋(23514);一般格式寫得進去(供應商自己存,不會被函式權限擋)',
  concat_ws('|',
    pg_temp.as_exec('authenticated', pg_temp.ua(), $q$UPDATE public.market_stores SET service_email = 'not-an-email' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
    pg_temp.as_exec('authenticated', pg_temp.ua(), $q$UPDATE public.market_stores SET service_email = 'a@b' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET service_email = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$,
                                                          repeat('x', 243) || '@example.com')),
    pg_temp.as_exec('authenticated', pg_temp.ua(), $q$UPDATE public.market_stores SET service_email = 'Shop.Service+1@example.com.tw' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$)),
  'ERR 23514|ERR 23514|ERR 23514|OK');
-- 去頭尾空白(含全形空白)、看不到字(只有全形空白、零寬字元)就當成沒填:跟商品欄位同一套(market_trim / market_visible)
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(), format(
  $q$UPDATE public.market_stores SET legal_name = %L, representative = %L, business_address = %L, service_email = %L,
                                     food_registration_no = %L, liability_insurance = %L
      WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$,
  chr(12288) || ' 市集測試 A 店有限公司  ', '王小明 ', ' 臺北市測試路 1 號 ', ' service-a@example.com ', chr(12288), chr(8203) || chr(8203)));
SELECT pg_temp.expect('去頭尾空白(含全形空白);只有全形空白、零寬字元的選填欄位存成 NULL',
  (SELECT concat_ws('|', legal_name, representative, business_address, service_email,
                    COALESCE(food_registration_no, '∅'), COALESCE(liability_insurance, '∅'))
     FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'),
  '市集測試 A 店有限公司|王小明|臺北市測試路 1 號|service-a@example.com|∅|∅');
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(),
  $q$UPDATE public.market_stores SET food_registration_no = 'A-123456789-00000-0', liability_insurance = '新光產險 產品責任險 2000 萬'
      WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$);

-- ---------------------------------------------------------------------
-- 2. 七日解除權逐項標示:改了要回待審(比照改品名、說明)
-- ---------------------------------------------------------------------
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(),
  $q$UPDATE public.market_products SET price = 90 WHERE id = 'a9300000-0000-4000-8000-0000000000a4'$q$);
INSERT INTO _ctx VALUES ('a4_price', to_jsonb(pg_temp.ex('a4')));
SELECT pg_temp.as_exec('authenticated', pg_temp.ua(),
  $q$UPDATE public.market_products SET withdrawal_exempt = true WHERE id = 'a9300000-0000-4000-8000-0000000000a4'$q$);
SELECT pg_temp.expect('已核准的商品:供應商改價格不用重審;改「不適用七日解除權」回待審(要由管理員確認是不是真的易腐),送審時間更新',
  concat_ws('|', (SELECT v #>> '{}' FROM _ctx WHERE k = 'a4_price'), pg_temp.ex('a4'),
    (SELECT (submitted_at = now())::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000a4')),
  'false|approved|true|pending|true');
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(),
  $q$UPDATE public.market_products SET withdrawal_exempt = true WHERE id = 'a9300000-0000-4000-8000-0000000000a1'$q$);
SELECT pg_temp.expect('管理員改「不適用七日解除權」不用重審(照舊已核准)', pg_temp.ex('a1'), 'true|approved');
SELECT pg_temp.expect('anon 讀得到公開商品的 withdrawal_exempt(消費者頁面要顯示)',
  pg_temp.as_val('anon', pg_temp.anon(),
    $q$SELECT string_agg(name || '=' || withdrawal_exempt::text, ',' ORDER BY price) FROM public.market_products
        WHERE id IN ('a9300000-0000-4000-8000-0000000000a1', 'a9300000-0000-4000-8000-0000000000a2')$q$),
  '有機高麗菜=true,牛肉片=false');

-- ---------------------------------------------------------------------
-- 3. 明細快照:下單當時商品的值,外部送來的值不算
-- ---------------------------------------------------------------------
UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
UPDATE public.app_config SET value = 'true' WHERE key = 'market_checkout_open';
INSERT INTO _ctx VALUES ('order', pg_temp.place('203.0.113.77', pg_temp.co('compliance@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 1), pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
INSERT INTO _ctx SELECT 'order_id', to_jsonb((SELECT v -> 'orders' -> 0 ->> 'id' FROM _ctx WHERE k = 'order'));
SELECT pg_temp.expect('下單成功;明細存下單當時商品的值(高麗菜 true、牛肉片 false)',
  (SELECT v ->> 'ok' FROM _ctx WHERE k = 'order') || '|' ||
  (SELECT string_agg(i.product_name || '=' || i.withdrawal_exempt::text, ',' ORDER BY i.unit_price)
     FROM public.market_order_items i WHERE i.order_id = (SELECT (v #>> '{}')::uuid FROM _ctx WHERE k = 'order_id')),
  'true|有機高麗菜=true,牛肉片=false');
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(),
  $q$UPDATE public.market_products SET withdrawal_exempt = false WHERE id = 'a9300000-0000-4000-8000-0000000000a1'$q$);
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(),
  $q$UPDATE public.market_products SET withdrawal_exempt = true WHERE id = 'a9300000-0000-4000-8000-0000000000b1'$q$);
SELECT pg_temp.expect('下單後商品改成適用:已經下的明細不變(照樣 true)',
  (SELECT i.withdrawal_exempt::text FROM public.market_order_items i
    WHERE i.order_id = (SELECT (v #>> '{}')::uuid FROM _ctx WHERE k = 'order_id') AND i.product_name = '有機高麗菜'),
  'true');
-- 偽造:直接寫明細(資料庫擁有者身分)時自己帶相反的值 —— trigger 一律以商品當下的值為準
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total, stock_deducted, withdrawal_exempt)
SELECT (SELECT (v #>> '{}')::uuid FROM _ctx WHERE k = 'order_id'), x.pid, x.name, '1 份', 'chilled', x.price, 1, x.price, 0, x.forged
  FROM (VALUES ('a9300000-0000-4000-8000-0000000000a2'::uuid, '偽造(牛肉片)', 451, true),
               ('a9300000-0000-4000-8000-0000000000b1'::uuid, '偽造(鮭魚)', 201, false)) AS x(pid, name, price, forged);
SELECT pg_temp.expect('寫明細時自己帶的值無效:牛肉片(適用)帶 true 存成 false、鮭魚(不適用)帶 false 存成 true',
  (SELECT string_agg(i.product_name || '=' || i.withdrawal_exempt::text, ',' ORDER BY i.unit_price)
     FROM public.market_order_items i
    WHERE i.order_id = (SELECT (v #>> '{}')::uuid FROM _ctx WHERE k = 'order_id') AND i.product_name LIKE '偽造%'),
  '偽造(鮭魚)=true,偽造(牛肉片)=false');
SELECT pg_temp.expect('明細照舊改不掉、刪不掉:供應商改 withdrawal_exempt、刪明細,anon 改,都是 42501',
  concat_ws('|',
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_order_items SET withdrawal_exempt = NOT withdrawal_exempt WHERE order_id = %L$q$,
                                                          (SELECT v #>> '{}' FROM _ctx WHERE k = 'order_id'))),
    pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$DELETE FROM public.market_order_items WHERE order_id = %L$q$,
                                                          (SELECT v #>> '{}' FROM _ctx WHERE k = 'order_id'))),
    pg_temp.as_exec('anon', pg_temp.anon(), format($q$UPDATE public.market_order_items SET withdrawal_exempt = true WHERE order_id = %L$q$,
                                                   (SELECT v #>> '{}' FROM _ctx WHERE k = 'order_id')))),
  'ERR 42501|ERR 42501|ERR 42501');

-- ---------------------------------------------------------------------
-- 4. 店家法定資訊:沒填齊不能開放零售
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('供應商建店(建好就是開放零售)沒填法定資訊 → 擋(22023 store_disclosure_missing)',
  pg_temp.as_exec('authenticated', pg_temp.uc(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000c', ARRAY['新竹市'])$q$),
  'ERR 22023:store_disclosure_missing');
SELECT pg_temp.expect('四項都填了、但供應商資料沒有電話 → 一樣擋',
  pg_temp.as_exec('authenticated', pg_temp.ud(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, legal_name, representative, business_address, service_email)
    VALUES ('a9200000-0000-4000-8000-00000000000d', ARRAY['臺中市'], 'D 店商行', '林大同', '臺中市測試路 4 號', 'service-d@example.com')$q$),
  'ERR 22023:store_disclosure_missing');
SELECT pg_temp.expect('四項 + 電話都有(登錄字號、產品責任險可以不填)→ 建店成功',
  pg_temp.as_exec('authenticated', pg_temp.uc(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, legal_name, representative, business_address, service_email)
    VALUES ('a9200000-0000-4000-8000-00000000000c', ARRAY['新竹市'], 'C 店商行', '陳美玲', '新竹市測試路 3 號', 'service-c@example.com')$q$),
  'OK');
SELECT pg_temp.expect('……C 店對外營業(market_store_is_open)', public.market_store_is_open('a9200000-0000-4000-8000-00000000000c')::text, 'true');
SELECT pg_temp.expect('開放中的店把必填欄位清掉(看不到字也算沒填)→ 擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), format($q$UPDATE public.market_stores SET legal_name = %L WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$, chr(12288)))
  || '|' ||
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$UPDATE public.market_stores SET representative = NULL WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 22023:store_disclosure_missing|ERR 22023:store_disclosure_missing');
-- 供應商資料的電話被清掉(店家表的 guard 管不到 suppliers):market_store_is_open 也檢查,公開頁面看不到、不能下單
UPDATE public.suppliers SET phone = chr(12288) WHERE id = 'a9200000-0000-4000-8000-00000000000b';  -- 只有全形空白
INSERT INTO _ctx VALUES ('nophone', pg_temp.place('203.0.113.78', pg_temp.co('nophone@market-test.invalid',
  jsonb_build_array(pg_temp.item('b1', 1)), '{"a9200000-0000-4000-8000-00000000000b":"cod"}')));
SELECT pg_temp.expect('供應商電話只剩空白:B 店不對外營業,anon 看不到店家也看不到商品,下單回 PRODUCT_UNAVAILABLE',
  concat_ws('|',
    public.market_store_is_open('a9200000-0000-4000-8000-00000000000b')::text,
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_products WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$),
    (SELECT v ->> 'code' FROM _ctx WHERE k = 'nophone')),
  'false|0|0|PRODUCT_UNAVAILABLE');
UPDATE public.suppliers SET phone = '02-2345-6789' WHERE id = 'a9200000-0000-4000-8000-00000000000b';
SELECT pg_temp.expect('管理員停用不擋;停用中的店供應商可以改(不檢查);重新啟用時缺欄位 → 擋,補齊後才啟用得了',
  concat_ws('|',
    pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$UPDATE public.market_stores SET is_enabled = false, disabled_reason = '資料待補'
                                                         WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000c'$q$),
    pg_temp.as_exec('authenticated', pg_temp.uc(), $q$UPDATE public.market_stores SET representative = NULL WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000c'$q$),
    pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$UPDATE public.market_stores SET is_enabled = true WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000c'$q$),
    pg_temp.as_exec('authenticated', pg_temp.uc(), $q$UPDATE public.market_stores SET representative = '陳美玲' WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000c'$q$),
    pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$UPDATE public.market_stores SET is_enabled = true WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000c'$q$)),
  'OK|OK|ERR 22023:store_disclosure_missing|OK|OK');
SELECT pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$UPDATE public.market_stores SET is_enabled = false, disabled_reason = '測試:停用中'
                                                              WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$);
SELECT pg_temp.expect('anon 只讀得到已開放的店(法定資訊也只看得到這些店;B 店停用中、D 店沒建店)',
  pg_temp.as_val('anon', pg_temp.anon(),
    $q$SELECT string_agg(right(supplier_id::text, 1) || '=' || legal_name || '/' || representative || '/' || service_email, ',' ORDER BY supplier_id)
         FROM public.market_stores
        WHERE supplier_id IN ('a9200000-0000-4000-8000-00000000000a', 'a9200000-0000-4000-8000-00000000000b',
                              'a9200000-0000-4000-8000-00000000000c', 'a9200000-0000-4000-8000-00000000000d')$q$),
  'a=市集測試 A 店有限公司/王小明/service-a@example.com,c=C 店商行/陳美玲/service-c@example.com');

-- ---------------------------------------------------------------------
-- 5. 查單 RPC:店家物件多五個法定資訊、明細多 withdrawal_exempt;照樣沒有 contact_email
-- ---------------------------------------------------------------------
INSERT INTO _ctx SELECT 'lookup', pg_temp.as_val('anon', pg_temp.anon(),
  format('SELECT public.market_get_orders(%L)::text', (SELECT v ->> 'token' FROM _ctx WHERE k = 'order')))::jsonb;
SELECT pg_temp.expect('查單:店家物件的欄位(多了登記名稱、負責人、營業所地址、客服 Email、登錄字號;產品責任險不給)與值',
  (SELECT (SELECT string_agg(key, ',' ORDER BY key) FROM jsonb_object_keys(o -> 'store') AS key) || '|' ||
          concat_ws('/', o -> 'store' ->> 'legal_name', o -> 'store' ->> 'representative', o -> 'store' ->> 'business_address',
                    o -> 'store' ->> 'service_email', o -> 'store' ->> 'food_registration_no')
     FROM _ctx, jsonb_array_elements(v -> 'orders') AS o WHERE k = 'lookup'),
  'business_address,food_registration_no,legal_name,name,phone,representative,return_policy,service_email,ship_days,supplier_id|'
  || '市集測試 A 店有限公司/王小明/臺北市測試路 1 號/service-a@example.com/A-123456789-00000-0');
SELECT pg_temp.expect('查單:每筆明細多了 withdrawal_exempt(下單當時的值)',
  (SELECT (jsonb_object_agg(i ->> 'product_name', i -> 'withdrawal_exempt')
             = '{"有機高麗菜": true, "牛肉片": false, "偽造(牛肉片)": false, "偽造(鮭魚)": true}'::jsonb)::text
          || '|' || bool_and(i ? 'withdrawal_exempt')::text
     FROM _ctx, jsonb_array_elements(v -> 'orders') AS o, jsonb_array_elements(o -> 'items') AS i WHERE k = 'lookup'),
  'true|true');
SELECT pg_temp.expect('查單照樣沒有 contact_email(鍵與值都沒有)',
  (SELECT (v::text LIKE '%contact_email%' OR v::text LIKE '%store-a@market-test.invalid%')::text FROM _ctx WHERE k = 'lookup'),
  'false');

-- ---------------------------------------------------------------------
-- 6. 權限
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('market_email_ok 開給 authenticated(店家表的 CHECK 要用,供應商自己存才不會被擋)、anon 沒有;明細快照的 trigger 函式不開給 API 角色',
  concat_ws('|',
    has_function_privilege('authenticated', 'public.market_email_ok(text)', 'EXECUTE')::text,
    has_function_privilege('anon', 'public.market_email_ok(text)', 'EXECUTE')::text,
    (has_function_privilege('anon', 'public.market_order_items_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.market_order_items_snapshot()', 'EXECUTE'))::text),
  'true|false|false');
