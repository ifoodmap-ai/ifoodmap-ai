-- migration 20260929100000_order_transition_rules + 20260929100100_order_event_side_effects 的資料庫層測試
-- (伺服器端的訂單狀態轉移表:每一條允許的轉移各角色各跑一次、不允許的轉移與冒用身分都被擋、
--  actor_id 由伺服器決定、派單/報價/出貨的附帶資料跟狀態一起寫進去)
--
-- 整段包在 BEGIN … ROLLBACK:fixture 與事件都不會留下來,pg_net 的通知佇列也跟著回滾(不會寄信)。
-- 帳號一律 @example.com。每個探針都先 SET LOCAL ROLE + set_config('request.jwt.claims', …, true)
-- 模擬 PostgREST 帶進來的身分,所以 RLS 與 trigger 都是真的在跑。
-- 20260928190000 的 restaurant_draft_approval.test.sql(72 項)在套用這兩支之後也要全過(既有流程不能被擋)。
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(192);

-- ---------------------------------------------------------------------
-- fixture(以資料庫擁有者身分建立)
--   R1 = 驗收餐廳:O 老闆、M 店長、P 採購員(都已接受)、PM 店長邀請(待接受);R2 = 別家餐廳:X 老闆
--   S1 = 驗收供應商(SU 啟用中帳號、SUX 停用的帳號);S2 = 別家供應商(SU2);S3 = 停用的供應商(沒有帳號)
--   AD = 平台管理員(身分只看 JWT 的 app_metadata.role)
-- ---------------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('e1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-owner@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收老闆"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-manager@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收店長"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-purchaser@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收採購"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-pending@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收受邀店長"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-supplier@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收供應商"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-admin@example.com', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{"display_name":"轉移驗收管理員"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-outsider@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收別家老闆"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-supplier2@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收別家供應商"}', now(), now()),
  ('e1000000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'transition-supplier-off@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"轉移驗收停用帳號"}', now(), now());

INSERT INTO public.restaurants (id, name) VALUES
  ('e2000000-0000-4000-8000-000000000001', '轉移驗收餐廳'),
  ('e2000000-0000-4000-8000-000000000002', '轉移驗收別家餐廳');

INSERT INTO public.restaurant_accounts (id, user_id, restaurant_id, role, is_active, accepted_at) VALUES
  ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'owner',     true, now()),
  ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'manager',   true, now()),
  ('e3000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'purchaser', true, now()),
  ('e3000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'manager',   true, NULL),
  ('e3000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000002', 'owner',     true, now());

INSERT INTO public.suppliers (id, name, is_active) VALUES
  ('e4000000-0000-4000-8000-000000000001', '轉移驗收供應商', true),
  ('e4000000-0000-4000-8000-000000000002', '轉移驗收別家供應商', true),
  ('e4000000-0000-4000-8000-000000000003', '轉移驗收停用供應商', false);
-- 20261028110000:餐廳直接叫貨(draft→dispatched)的供應商要是這家店已綁定的
INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001');
INSERT INTO public.supplier_accounts (id, user_id, supplier_id, is_active) VALUES
  ('e5000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000005', 'e4000000-0000-4000-8000-000000000001', true),
  ('e5000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000008', 'e4000000-0000-4000-8000-000000000002', true),
  ('e5000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000009', 'e4000000-0000-4000-8000-000000000001', false);

-- 單筆探針用的訂單:id 尾碼 = 用途(見各探針)
INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status, ingredient_list) VALUES
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', NULL, 'submitted', '[{"name":"高麗菜","quantity":10,"unit":"kg"}]'),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', NULL, 'submitted', '[]'),
  ('e6000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'submitted', '[]'),
  ('e6000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'dispatched', '[]'),
  ('e6000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'delivered', '[]'),
  ('e6000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'confirmed', '[]'),
  ('e6000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'cancelled', '[]'),
  ('e6000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'reviewed', '[]'),
  ('e6000000-0000-4000-8000-000000000009', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'closed', '[]'),
  ('e6000000-0000-4000-8000-000000000010', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'quoted', '[]'),
  ('e6000000-0000-4000-8000-000000000011', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'accepted', '[]'),
  ('e6000000-0000-4000-8000-000000000012', 'e2000000-0000-4000-8000-000000000001', NULL, 'submitted', '[]'),
  ('e6000000-0000-4000-8000-000000000013', 'e2000000-0000-4000-8000-000000000001', NULL, 'draft', '[]'),
  ('e6000000-0000-4000-8000-000000000014', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'dispatched', '[]'),
  ('e6000000-0000-4000-8000-000000000015', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'dispatched', '[]'),
  ('e6000000-0000-4000-8000-000000000016', 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'rejected', '[]');

-- 每一條允許的轉移各開一張單(狀態 = 起點),A 段逐條跑
CREATE TEMP TABLE _cases ON COMMIT DROP AS
SELECT r.actor, r.from_status, r.to_status,
       row_number() OVER (ORDER BY r.actor, r.from_status, r.to_status) AS n,
       gen_random_uuid() AS order_id
  FROM public.order_transition_rules() r;
GRANT SELECT ON _cases TO PUBLIC;
INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status, ingredient_list)
SELECT c.order_id, 'e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', c.from_status, '[]'
  FROM _cases c;

-- ---------------------------------------------------------------------
-- 0. migration 本身與轉移表的完整性
-- ---------------------------------------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_order_transition'
            AND tgrelid = 'public.order_events'::regclass AND tgenabled = 'O'),
  'order_events 有啟用中的 trg_guard_order_transition'
);
SELECT is(
  (SELECT string_agg(tgname::text, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.order_events'::regclass AND NOT tgisinternal
      AND tgname IN ('trg_guard_order_submission', 'trg_guard_order_transition')),
  'trg_guard_order_submission,trg_guard_order_transition',
  '同為 BEFORE INSERT:依名稱順序 guard_order_submission 先跑(送出類的訊息不變),轉移檢查後跑'
);
SELECT is(
  (SELECT string_agg(tgname::text, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.order_events'::regclass AND NOT tgisinternal
      AND tgname IN ('trg_apply_order_event', 'trg_apply_order_event_details', 'trg_notify_order_event')),
  'trg_apply_order_event,trg_apply_order_event_details,trg_notify_order_event',
  '同為 AFTER INSERT:先同步狀態、再寫附帶資料、最後排通知'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_order_events_one_per_order'
            AND tgrelid = 'public.order_events'::regclass AND tgenabled = 'O' AND (tgtype & 1) = 0),
  'order_events 有 statement 層級的 trg_order_events_one_per_order'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""', 'row_security=off'] FROM pg_proc WHERE oid = to_regprocedure('public.guard_order_transition()')),
  'guard_order_transition 是 SECURITY DEFINER、search_path 為空、row_security=off'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""', 'row_security=off'] FROM pg_proc WHERE oid = to_regprocedure('public.apply_order_event_details()')),
  'apply_order_event_details 是 SECURITY DEFINER、search_path 為空、row_security=off'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.order_transition_rules()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.order_transition_rules()', 'EXECUTE'),
  'anon / authenticated 不能直接呼叫 order_transition_rules()'
);
-- 20260929110000 起 102 條(管理員取消進行中的單 7 條、老闆/店長退回重新報價 2 條、系統的聯集 8 條);
-- 20261028110000 起 105 條(老闆/店長/採購員向合作供應商直接叫貨 draft→dispatched,3 條)
SELECT is((SELECT count(*)::int FROM public.order_transition_rules()), 105, '轉移表共 105 條');
SELECT is((SELECT count(*)::int FROM (SELECT DISTINCT actor, from_status, to_status FROM public.order_transition_rules()) d), 105, '轉移表沒有重複列');
SELECT is(
  (SELECT count(*)::int FROM public.order_transition_rules() r
    WHERE r.actor NOT IN ('owner', 'manager', 'purchaser', 'supplier', 'admin', 'system')
       OR r.from_status NOT IN ('draft','submitted','dispatched','accepted','quoted','confirmed','shipped','in_transit','delivered',
                                'received','reviewed','closed','rejected','discrepancy','disputed','cancelled','expired','pending','sent','completed')
       OR r.to_status NOT IN ('draft','submitted','dispatched','accepted','quoted','confirmed','shipped','in_transit','delivered',
                              'received','reviewed','closed','rejected','discrepancy','disputed','cancelled','expired','pending','sent','completed')
       OR r.from_status = r.to_status),
  0, '轉移表只用合法的身分與狀態,而且沒有原地轉移'
);
SELECT is(
  (SELECT count(*)::int FROM public.order_transition_rules() WHERE actor = 'supplier' AND to_status IN ('received', 'reviewed', 'closed')),
  0, '供應商最多推到 delivered:received 只有餐廳(與管理員仲裁、系統)能觸發'
);
SELECT is(
  (SELECT count(*)::int FROM public.order_transition_rules() WHERE actor = 'purchaser' AND to_status = 'submitted'),
  0, '採購員不能送出(要老闆/店長簽核)'
);
SELECT is(
  (SELECT count(*)::int FROM (
     SELECT from_status, to_status FROM public.order_transition_rules() WHERE actor <> 'system'
     EXCEPT SELECT from_status, to_status FROM public.order_transition_rules() WHERE actor = 'system') x),
  0, '系統的轉移涵蓋其他所有角色的轉移'
);

-- ---------------------------------------------------------------------
-- A. 每一條允許的轉移:各角色各跑一次(105 條;一律帶 note —— 管理員取消進行中的單、退回重新報價要填原因)
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'restaurant', 'restaurant_portal', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'dispatched' THEN '{"supplier_id":"e4000000-0000-4000-8000-000000000001"}' ELSE '{}' END),
  format('老闆 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'owner' ORDER BY c.n;

SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'restaurant', 'restaurant_portal', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'dispatched' THEN '{"supplier_id":"e4000000-0000-4000-8000-000000000001"}' ELSE '{}' END),
  format('店長 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'manager' ORDER BY c.n;

SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'restaurant', 'restaurant_portal', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'dispatched' THEN '{"supplier_id":"e4000000-0000-4000-8000-000000000001"}' ELSE '{}' END),
  format('採購員 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'purchaser' ORDER BY c.n;

SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'supplier', 'supplier_portal', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'quoted' THEN '{"total_amount":1234}' WHEN 'shipped' THEN '{"tracking":{"carrier":"黑貓"}}' ELSE '{}' END),
  format('供應商 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'supplier' ORDER BY c.n;

SELECT set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'admin', 'admin_portal', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'dispatched' THEN '{"supplier_id":"e4000000-0000-4000-8000-000000000001"}' ELSE '{}' END),
  format('管理員 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'admin' ORDER BY c.n;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES (%L, %L, %L, 'system', 'system', %L::jsonb, 'A 段探針')$$,
         c.order_id, c.from_status, c.to_status,
         CASE c.to_status WHEN 'quoted' THEN '{"total_amount":1234}'
                          WHEN 'dispatched' THEN '{"supplier_id":"e4000000-0000-4000-8000-000000000001"}' ELSE '{}' END),
  format('系統 %s→%s', c.from_status, c.to_status))
  FROM _cases c WHERE c.actor = 'system' ORDER BY c.n;

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM _cases c JOIN public.supplier_orders o ON o.id = c.order_id WHERE o.status = c.to_status),
  105, 'A 段 105 條轉移全部生效(訂單狀態都同步成目標狀態)'
);
SELECT is(
  (SELECT count(*)::int FROM _cases c JOIN public.order_events e ON e.order_id = c.order_id
    WHERE e.from_status = c.from_status AND e.to_status = c.to_status),
  105, 'A 段每張單剛好一筆事件,from_status 是轉移前的狀態'
);

-- ---------------------------------------------------------------------
-- B. 派單 → 接單 → 報價 → 確認 → 出貨 → 送達 → 收貨(附帶資料跟狀態一起寫)
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'submitted', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"e4000000-0000-4000-8000-000000000002","score":88}')$$,
  '管理員派單給 S2(payload.supplier_id)'
);
SELECT is((SELECT supplier_id FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000001'),
  'e4000000-0000-4000-8000-000000000002'::uuid, '派單把 supplier_id 寫到訂單上');

SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '被派到的 S2 接單'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note, payload)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'accepted', 'quoted', 'supplier', 'supplier_portal', '含運費',
            '{"total_amount":"1500.5","valid_until":"2026-10-31"}')$$,
  'S2 報價 1500.5(字串金額也收)'
);
RESET ROLE;
SELECT is((SELECT total_amount FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000001'),
  1500.50::numeric, '報價金額寫到 supplier_orders.total_amount');
SELECT is(
  (SELECT count(*)::int FROM public.order_quotes
    WHERE order_id = 'e6000000-0000-4000-8000-000000000001' AND supplier_id = 'e4000000-0000-4000-8000-000000000002'
      AND total_amount = 1500.50 AND note = '含運費' AND valid_until = '2026-10-31' AND status = 'quoted'),
  1, '報價同時留一筆 order_quotes(金額、備註、有效日期)');
SELECT is(
  (SELECT payload->>'total_amount' FROM public.order_events
    WHERE order_id = 'e6000000-0000-4000-8000-000000000001' AND to_status = 'quoted'),
  '1500.50', '事件 payload 的金額被統一成數字 total_amount');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'quoted', 'confirmed', 'restaurant', 'restaurant_portal')$$,
  '老闆確認報價'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note, payload)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'confirmed', 'shipped', 'supplier', 'supplier_portal', '早上 10 點前送到',
            '{"tracking":{"carrier":"自有車隊","tracking_number":"T-001"}}')$$,
  'S2 出貨(物流資訊)'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.supplier_shipments
    WHERE order_id = 'e6000000-0000-4000-8000-000000000001' AND supplier_id = 'e4000000-0000-4000-8000-000000000002'
      AND tracking_info = '{"carrier":"自有車隊","tracking_number":"T-001"}'::jsonb
      AND notes = '早上 10 點前送到' AND confirmed_by = 'e1000000-0000-4000-8000-000000000008'),
  1, '出貨同時新增一筆 supplier_shipments(物流、備註、confirmed_by = 寫事件的人)');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'shipped', 'delivered', 'supplier', 'supplier_portal')$$,
  'S2 送達'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000001', 'delivered', 'received', 'restaurant', 'restaurant_portal')$$,
  '採購員確認收貨'
);
RESET ROLE;
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000001'),
  'received', '整張單走完是 received');
SELECT is(
  (SELECT count(*)::int FROM public.order_events WHERE order_id = 'e6000000-0000-4000-8000-000000000001'),
  7, '這張單的履歷剛好 7 筆事件');

-- 被拒的單改派給別家:原供應商就碰不到了
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000016', 'rejected', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"e4000000-0000-4000-8000-000000000002"}')$$,
  '管理員把被拒的單改派給 S2'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000016', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  '改派之後,原本的 S1 不能再接這張單'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000016', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '改派後的 S2 可以接單'
);

-- 派給停用的供應商:資料庫不擋(派單畫面只列啟用中的供應商)
SELECT set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000012', 'submitted', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"e4000000-0000-4000-8000-0000000000ff"}')$$,
  '22023', '找不到要派單的供應商',
  '派給不存在的供應商被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000012', 'submitted', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"not-a-uuid"}')$$,
  '22023', '找不到要派單的供應商',
  'supplier_id 不是 uuid 被拒'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000012', 'submitted', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"e4000000-0000-4000-8000-000000000003"}')$$,
  '派給存在但停用的供應商,資料庫放行(由畫面篩選)'
);
RESET ROLE;
SELECT is((SELECT supplier_id FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000012'),
  'e4000000-0000-4000-8000-000000000003'::uuid, '派單寫入 supplier_id(停用的也照寫)');

-- ---------------------------------------------------------------------
-- C. 不允許的轉移、冒用身分、畫面過期
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
-- 採購員
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000003', 'submitted', 'received', 'restaurant', 'restaurant_portal')$$,
  '42501', '餐廳採購員不能把訂單從「待派發」改成「待評價」',
  '採購員 submitted→received 被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000013', 'draft', 'submitted', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '採購員 draft→submitted 仍由簽核規則擋下(訊息不變)'
);
-- 供應商
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000008","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  '供應商 S2 不能接 S1 的單'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000009","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  'S1 的停用帳號不能接單'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000002', 'submitted', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  '還沒派發(沒有供應商)的單,供應商碰不到'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'dispatched', 'admin', 'admin_portal')$$,
  '42501', '只有平台管理員可以用「管理員」身分操作訂單',
  '供應商冒用管理員身分(actor_role=admin)被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000005', 'delivered', 'received', 'supplier', 'supplier_portal')$$,
  '42501', '供應商不能把訂單從「待收貨」改成「待評價」',
  '供應商不能自己確認收貨(GMV 只認餐廳收貨)'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000005', 'delivered', 'received', 'restaurant', 'restaurant_portal')$$,
  '42501', '你不是這家餐廳的成員(或邀請還沒接受),不能操作這張訂單',
  '供應商冒用餐廳身分確認收貨被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000006', 'confirmed', 'delivered', 'supplier', 'supplier_portal')$$,
  '42501', '供應商不能把訂單從「待出貨」改成「待收貨」',
  '供應商跳關(confirmed→delivered)被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'accepted', 'quoted', 'supplier', 'supplier_portal')$$,
  'P0001', '這張訂單的狀態已經變成「待接單」,畫面上的資料過期了,請重新整理後再操作',
  '畫面過期:from_status 跟目前狀態不一樣就擋下'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source) VALUES
    ('e6000000-0000-4000-8000-000000000004', NULL, 'accepted', 'supplier', 'supplier_portal'),
    ('e6000000-0000-4000-8000-000000000004', NULL, 'rejected', 'supplier', 'supplier_portal')$$,
  'P0001', '同一張訂單一次只能寫一筆事件,請一步一步來',
  '同一個 INSERT 寫兩筆同一張單的事件,整筆被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source) VALUES
    ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'accepted', 'supplier', 'supplier_portal'),
    ('e6000000-0000-4000-8000-000000000004', 'accepted', 'quoted', 'supplier', 'supplier_portal')$$,
  'P0001', '這張訂單的狀態已經變成「待接單」,畫面上的資料過期了,請重新整理後再操作',
  '一次寫「接單+報價」:第二筆看到的還是接單前的狀態,被擋'
);
-- 報價內容
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal')$$,
  '22023', '報價金額要是大於 0 的數字',
  '報價沒帶金額被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"total_amount":0}')$$,
  '22023', '報價金額要是大於 0 的數字',
  '報價金額 0 被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"total_amount":-5}')$$,
  '22023', '報價金額要是大於 0 的數字',
  '報價金額負數被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"total_amount":"一千"}')$$,
  '22023', '報價金額要是大於 0 的數字',
  '報價金額不是數字被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"total_amount":100,"valid_until":"下週五"}')$$,
  '22023', '報價有效日期格式不對(要是 YYYY-MM-DD)',
  '報價有效日期格式不對被拒'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('e6000000-0000-4000-8000-000000000011', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"amount":800}')$$,
  '舊寫法 payload.amount 仍然可以報價'
);
-- 冒用 actor_id / created_at、不填 from_status
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, created_at)
    VALUES ('e6000000-0000-4000-8000-000000000014', NULL, 'accepted', 'e1000000-0000-4000-8000-000000000006', 'supplier', 'supplier_portal', '2020-01-01')$$,
  '供應商寫事件時偽造 actor_id(填管理員)與 created_at:寫得進去,但兩個值都被伺服器改掉'
);
-- 餐廳
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'accepted', 'restaurant', 'restaurant_portal')$$,
  '42501', '餐廳老闆不能把訂單從「待接單」改成「待報價」',
  '老闆不能替供應商接單'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000007', 'cancelled', 'submitted', 'restaurant', 'restaurant_portal')$$,
  '42501', '餐廳老闆不能把訂單從「已取消」改成「待派發」',
  '老闆不能把已取消的單復活'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000004', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  '老闆冒用供應商身分被拒'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000008', 'reviewed', 'closed', 'restaurant', 'restaurant_portal')$$,
  '42501', '餐廳店長不能把訂單從「已評價」改成「已結案」',
  '店長不能結案(管理員專屬)'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000010', 'quoted', 'confirmed', 'restaurant', 'restaurant_portal')$$,
  '42501', '你不是這家餐廳的成員(或邀請還沒接受),不能操作這張訂單',
  '還沒接受邀請的店長不能確認報價'
);
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000010', 'quoted', 'confirmed', 'restaurant', 'restaurant_portal')$$,
  '42501', '你不是這家餐廳的成員(或邀請還沒接受),不能操作這張訂單',
  '別家餐廳的老闆不能確認這家的報價'
);
-- 管理員
SELECT set_config('request.jwt.claims',
  '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000009', 'closed', 'dispatched', 'admin', 'admin_portal')$$,
  '42501', '平台管理員不能把訂單從「已結案」改成「待接單」',
  '管理員不能把已結案的單改回進行中'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000005', 'delivered', 'received', 'admin', 'admin_portal')$$,
  '42501', '平台管理員不能把訂單從「待收貨」改成「待評價」',
  '管理員不能替餐廳在「待收貨」直接收貨(只能在收貨有差異/爭議時仲裁)'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000015', 'dispatched', 'expired', 'system', 'cron')$$,
  '42501', '只有系統排程可以用「系統」身分寫訂單事件',
  '管理員冒用系統身分被拒'
);
-- 沒有 sub 的 authenticated、anon
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000015', 'dispatched', 'expired', 'system', 'cron')$$,
  '42501', '只有系統排程可以用「系統」身分寫訂單事件',
  'JWT 是 authenticated 卻沒有 sub:不會被當成系統'
);
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000010', 'quoted', 'confirmed', 'restaurant', 'restaurant_portal')$$,
  '42501', NULL,
  '未登入(anon)不能寫事件'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000015', 'dispatched', 'expired', 'system', 'cron')$$,
  '42501', NULL,
  '未登入(anon)冒用系統身分被拒'
);
-- 系統也不能亂跳
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000009', 'closed', 'dispatched', 'system', 'system')$$,
  '42501', '系統不能把訂單從「已結案」改成「待接單」',
  '系統也不能把已結案的單改回進行中'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('e6000000-0000-4000-8000-000000000015', 'dispatched', 'accepted', 'supplier', 'supplier_portal')$$,
  '42501', '這張訂單不是派給你的供應商,不能操作',
  '系統身分不能冒充供應商'
);

-- ---------------------------------------------------------------------
-- D. 結果:被拒的單原封不動,成功的事件內容由伺服器決定
-- ---------------------------------------------------------------------
RESET ROLE;
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000002'), 'submitted',  '沒有供應商的單仍是待派發');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000003'), 'submitted',  '採購員亂跳被拒的單仍是待派發');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000004'), 'dispatched', '被別家、冒用、過期、一次多筆擋下的單仍是待接單');
SELECT is((SELECT count(*)::int FROM public.order_events WHERE order_id = 'e6000000-0000-4000-8000-000000000004'), 0, '那張單一筆事件都沒寫進去');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000005'), 'delivered',  '供應商自己收貨被拒的單仍是待收貨');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000006'), 'confirmed',  '跳關被拒的單仍是待出貨');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000007'), 'cancelled',  '復活被拒的單仍是已取消');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000008'), 'reviewed',   '店長結案被拒的單仍是已評價');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000009'), 'closed',     '已結案的單仍是已結案');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000010'), 'quoted',     '外人確認被拒的單仍是待確認');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000011'), 'quoted',     '舊寫法報價成功後是待確認');
SELECT is((SELECT total_amount FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000011'), 800::numeric, '舊寫法的金額也同步到訂單');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000013'), 'draft',      '採購員送出被拒的草稿仍是草稿');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'e6000000-0000-4000-8000-000000000015'), 'dispatched', '冒用系統身分被拒的單仍是待接單');
SELECT is(
  (SELECT e.actor_id FROM public.order_events e WHERE e.order_id = 'e6000000-0000-4000-8000-000000000014'),
  'e1000000-0000-4000-8000-000000000005'::uuid, '偽造的 actor_id 沒生效:存的是真正寫事件的供應商');
SELECT ok(
  (SELECT e.created_at = now() AND e.from_status = 'dispatched'
     FROM public.order_events e WHERE e.order_id = 'e6000000-0000-4000-8000-000000000014'),
  '偽造的 created_at 沒生效(= 交易時間),沒填的 from_status 由伺服器補成目前狀態');
SELECT is(
  (SELECT count(*)::int FROM public.order_events e JOIN _cases c ON c.order_id = e.order_id
    WHERE c.actor IN ('owner', 'manager', 'purchaser', 'supplier', 'admin') AND e.actor_id IS NULL),
  0, 'A 段所有登入者寫的事件都有 actor_id');
SELECT is(
  (SELECT count(*)::int FROM public.order_events e JOIN _cases c ON c.order_id = e.order_id
    WHERE c.actor = 'system' AND e.actor_id IS NOT NULL),
  0, '系統寫的事件 actor_id 是 NULL');

SELECT * FROM finish();
ROLLBACK;
