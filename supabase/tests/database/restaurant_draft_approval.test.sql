-- migration 20260928190000_restaurant_draft_approval + 20260928190100_restaurant_order_update_guard
--         + 20260928190200_order_pipeline_security_invoker + 20260928190300_order_pipeline_select_only 的資料庫層測試
-- (採購員送出的單一定要經過老闆/店長簽核:事件、直接建單、改訂單內容、跨店搬單、經由 order_pipeline 檢視都擋;
--  老闆/店長、供應商、管理員、系統的既有寫入與讀取不受影響)
--
-- 整段包在 BEGIN … ROLLBACK:fixture 與事件都不會留下來,pg_net 的通知佇列也跟著回滾(不會寄信)。
-- 帳號一律 @example.com。每個探針都先 SET LOCAL ROLE + set_config('request.jwt.claims', …, true)
-- 模擬 PostgREST 帶進來的身分,所以 RLS 與 trigger 都是真的在跑。
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(72);

-- ---------------------------------------------------------------------
-- fixture(以資料庫擁有者身分建立)
--   R1 = 驗收餐廳:O 老闆、M 店長、P 採購員(都已接受)、PM 店長邀請(待接受)
--   R2 = 別家餐廳:X 老闆;P 也是 R2 的老闆(「A 店採購員 + B 店老闆」雙重身分,測跨店搬單)
--   S1 = 驗收供應商:SU 供應商帳號
--   AD = 平台管理員(身分只看 JWT 的 app_metadata.role)
-- ---------------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('d1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-owner@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收老闆"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-manager@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收店長"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-purchaser@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收採購"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-pending@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收受邀店長"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-supplier@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收供應商"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-admin@example.com', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{"display_name":"簽核驗收管理員"}', now(), now()),
  ('d1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'draft-approval-outsider@example.com', '', '{"provider":"email","providers":["email"]}', '{"display_name":"簽核驗收別家老闆"}', now(), now());

INSERT INTO public.restaurants (id, name) VALUES
  ('d2000000-0000-4000-8000-000000000001', '簽核驗收餐廳'),
  ('d2000000-0000-4000-8000-000000000002', '簽核驗收別家餐廳');

INSERT INTO public.restaurant_accounts (id, user_id, restaurant_id, role, is_active, accepted_at) VALUES
  ('d3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'owner',     true, now()),
  ('d3000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'manager',   true, now()),
  ('d3000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'purchaser', true, now()),
  ('d3000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'manager',   true, NULL),
  ('d3000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000002', 'owner',     true, now()),
  ('d3000000-0000-4000-8000-000000000006', 'd1000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'owner',     true, now());

INSERT INTO public.suppliers (id, name) VALUES ('d4000000-0000-4000-8000-000000000001', '簽核驗收供應商');
INSERT INTO public.supplier_accounts (id, user_id, supplier_id) VALUES
  ('d5000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005', 'd4000000-0000-4000-8000-000000000001');

-- 訂單:id 尾碼 = 用途(見各探針)
INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status) VALUES
  ('d6000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'draft'),
  ('d6000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000009', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'dispatched'),
  ('d6000000-0000-4000-8000-000000000010', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'accepted'),
  ('d6000000-0000-4000-8000-000000000011', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'confirmed'),
  ('d6000000-0000-4000-8000-000000000012', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'dispatched'),
  ('d6000000-0000-4000-8000-000000000013', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000014', 'd2000000-0000-4000-8000-000000000001', NULL, 'submitted'),
  ('d6000000-0000-4000-8000-000000000015', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000016', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'quoted'),
  ('d6000000-0000-4000-8000-000000000017', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'delivered'),
  ('d6000000-0000-4000-8000-000000000018', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000019', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000020', 'd2000000-0000-4000-8000-000000000001', NULL, 'draft'),
  ('d6000000-0000-4000-8000-000000000021', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'reviewed'),
  ('d6000000-0000-4000-8000-000000000022', 'd2000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'discrepancy');

-- ---------------------------------------------------------------------
-- 0. migration 本身
-- ---------------------------------------------------------------------
SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_order_submission'
            AND tgrelid = 'public.order_events'::regclass AND tgenabled = 'O'),
  'order_events 有啟用中的 trg_guard_order_submission'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""', 'row_security=off'] FROM pg_proc WHERE oid = to_regprocedure('public.guard_order_submission()')),
  'guard_order_submission 是 SECURITY DEFINER、search_path 為空、row_security=off'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_order_update'
            AND tgrelid = 'public.supplier_orders'::regclass AND tgenabled = 'O'),
  'supplier_orders 有啟用中的 trg_guard_order_update'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""', 'row_security=off'] FROM pg_proc WHERE oid = to_regprocedure('public.guard_order_update()')),
  'guard_order_update 是 SECURITY DEFINER、search_path 為空、row_security=off'
);
-- CREATE OR REPLACE VIEW 沒帶 WITH (security_invoker = true) 會把設定悄悄清掉 —— 這裡守著
SELECT ok(
  (SELECT coalesce(reloptions @> ARRAY['security_invoker=true'], false) FROM pg_class WHERE oid = 'public.order_pipeline'::regclass),
  'order_pipeline 是 security_invoker(照呼叫者身分套 RLS)'
);
SELECT is(
  (SELECT coalesce(string_agg(a.privilege_type || '→' || r.rolname, ',' ORDER BY r.rolname, a.privilege_type), '')
     FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = 'public.order_pipeline'::regclass AND r.rolname IN ('anon', 'authenticated')),
  'SELECT→authenticated', 'order_pipeline:anon 沒有任何權限,authenticated 只有 SELECT'
);

-- ---------------------------------------------------------------------
-- 1. 採購員:送出類事件一律被拒
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000001', 'draft', 'submitted', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '採購員把自己的草稿送出(draft→submitted)被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000002', 'draft', 'dispatched', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '只能向已綁定的合作供應商叫貨,請先到「我的供應商」綁定',
  '採購員跳關(draft→dispatched,沒有帶已綁定的供應商)被拒(20261028110000 起:向合作供應商直接叫貨不用簽核,但供應商一定要是已綁定的)'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000001', 'quoted', 'submitted', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '事件的 from_status 謊報成別的狀態也一樣被拒(以訂單目前狀態為準)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, note)
    VALUES ('d6000000-0000-4000-8000-000000000003', 'draft', 'cancelled', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal', '採購員自己取消草稿')$$,
  '採購員取消草稿(draft→cancelled)仍然可以'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000003', 'cancelled', 'submitted', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '採購員把取消的單直接復活成送出(cancelled→submitted)被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000003', 'cancelled', 'dispatched', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '這張訂單已經取消,不能再進行其他動作(請重新整理頁面)',
  '採購員把取消的單復活成其他狀態(cancelled→dispatched)被拒,訊息說單已取消'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source) VALUES
    ('d6000000-0000-4000-8000-000000000004', 'draft', 'cancelled', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal'),
    ('d6000000-0000-4000-8000-000000000004', 'cancelled', 'submitted', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '一次寫兩筆事件(先取消再送出)整筆被拒'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000016', 'quoted', 'confirmed', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '採購員確認報價(quoted→confirmed)不受影響'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000017', 'delivered', 'received', 'd1000000-0000-4000-8000-000000000003', 'restaurant', 'restaurant_portal')$$,
  '採購員確認收貨(delivered→received)不受影響'
);
-- 直接建單
SELECT throws_ok(
  $$INSERT INTO public.supplier_orders (restaurant_id, status, created_by)
    VALUES ('d2000000-0000-4000-8000-000000000001', 'submitted', 'd1000000-0000-4000-8000-000000000003')$$,
  '42501', 'new row violates row-level security policy for table "supplier_orders"',
  '採購員直接建一張 submitted 的單被 RLS 拒'
);
SELECT lives_ok(
  $$INSERT INTO public.supplier_orders (id, restaurant_id, status, created_by)
    VALUES ('d6000000-0000-4000-8000-000000000031', 'd2000000-0000-4000-8000-000000000001', 'draft', 'd1000000-0000-4000-8000-000000000003')$$,
  '採購員建草稿仍然可以'
);
-- 改訂單內容(20260928190100)
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET notes = '改成明早送' WHERE id = 'd6000000-0000-4000-8000-000000000031'$$,
  '採購員改自己的草稿內容仍然可以'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders
       SET ingredient_list = '[{"name":"和牛","quantity":100}]', total_amount = 999999, supplier_id = 'd4000000-0000-4000-8000-000000000001'
     WHERE id = 'd6000000-0000-4000-8000-000000000014'$$,
  '42501', '採購單送出後只有老闆或店長可以修改',
  '採購員改已送出的單(品項/金額/供應商)被拒'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET approved_by = 'd1000000-0000-4000-8000-000000000001', approved_at = now()
     WHERE id = 'd6000000-0000-4000-8000-000000000001'$$,
  '42501', '簽核欄位只能由老闆或店長填寫',
  '採購員在草稿上自己填核准人被拒'
);
-- 跨店搬單:P 同時是 R1 採購員、R2 老闆
SELECT lives_ok(
  $$INSERT INTO public.supplier_orders (id, restaurant_id, status, created_by)
    VALUES ('d6000000-0000-4000-8000-000000000041', 'd2000000-0000-4000-8000-000000000002', 'submitted', 'd1000000-0000-4000-8000-000000000003')$$,
  '雙重身分:在自己當老闆的 R2 直接建 submitted 的單可以'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET restaurant_id = 'd2000000-0000-4000-8000-000000000001'
     WHERE id = 'd6000000-0000-4000-8000-000000000041'$$,
  '42501', '訂單不能改到別家餐廳',
  '雙重身分:把 R2 的送出單搬到 R1(借 R2 老闆的簽核權)被拒'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET restaurant_id = 'd2000000-0000-4000-8000-000000000002'
     WHERE id = 'd6000000-0000-4000-8000-000000000001'$$,
  '42501', '訂單不能改到別家餐廳',
  '雙重身分:把 R1 的草稿搬到 R2 被拒'
);

-- ---------------------------------------------------------------------
-- 2. 待接受的邀請、別家餐廳的老闆、未登入:一樣不能送出
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000007', 'draft', 'submitted', 'd1000000-0000-4000-8000-000000000004', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  '還沒接受邀請的店長不能送出'
);
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000008', 'draft', 'submitted', 'd1000000-0000-4000-8000-000000000007', 'restaurant', 'restaurant_portal')$$,
  '42501', NULL,
  '別家餐廳的老闆不能送出這家的單'
);
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000019', 'draft', 'submitted', 'restaurant', 'restaurant_portal')$$,
  '42501', NULL,
  '未登入(anon)不能送出'
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000019', 'draft', 'submitted', 'restaurant', 'restaurant_portal')$$,
  '42501', '採購單要由這家餐廳的老闆或店長簽核後才能送出',
  'JWT 是 authenticated 卻沒有 sub:不會被當成系統放行'
);

-- ---------------------------------------------------------------------
-- 3. 店長、老闆:送出成功(含直接建 submitted 的單、退回草稿、其他既有動作)
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, note)
    VALUES ('d6000000-0000-4000-8000-000000000005', 'draft', 'submitted', 'd1000000-0000-4000-8000-000000000002', 'restaurant', 'restaurant_portal', '店長核准採購單')$$,
  '店長送出草稿(draft→submitted)成功'
);
SELECT lives_ok(
  $$INSERT INTO public.supplier_orders (id, restaurant_id, status, created_by)
    VALUES ('d6000000-0000-4000-8000-000000000032', 'd2000000-0000-4000-8000-000000000001', 'submitted', 'd1000000-0000-4000-8000-000000000002')$$,
  '店長直接建 submitted 的單仍然可以'
);

SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, note)
    VALUES ('d6000000-0000-4000-8000-000000000006', 'draft', 'submitted', 'd1000000-0000-4000-8000-000000000001', 'restaurant', 'restaurant_portal', '店長核准採購單')$$,
  '老闆送出草稿(draft→submitted)成功'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, note)
    VALUES ('d6000000-0000-4000-8000-000000000020', 'draft', 'cancelled', 'd1000000-0000-4000-8000-000000000001', 'restaurant', 'restaurant_portal', '退回採購單')$$,
  '老闆退回草稿(draft→cancelled)成功'
);
SELECT lives_ok(
  $$INSERT INTO public.supplier_orders (id, restaurant_id, status, created_by)
    VALUES ('d6000000-0000-4000-8000-000000000033', 'd2000000-0000-4000-8000-000000000001', 'submitted', 'd1000000-0000-4000-8000-000000000001')$$,
  '老闆直接建 submitted 的單仍然可以'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, payload)
    VALUES ('d6000000-0000-4000-8000-000000000022', 'discrepancy', 'disputed', 'd1000000-0000-4000-8000-000000000001', 'restaurant', 'restaurant_portal', '{"kind":"shortage"}')$$,
  '老闆申請爭議(discrepancy→disputed)不受影響'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET approved_by = 'd1000000-0000-4000-8000-000000000001', approved_at = now()
     WHERE id = 'd6000000-0000-4000-8000-000000000001'$$,
  '老闆在草稿上記下核准人(前端「核准並送出」的第一步)成功'
);

-- ---------------------------------------------------------------------
-- 4. 供應商:接單、拒單、報價、出貨、送達都不受影響
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000009', 'dispatched', 'accepted', 'd1000000-0000-4000-8000-000000000005', 'supplier', 'supplier_portal')$$,
  '供應商接單(dispatched→accepted)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000012', 'dispatched', 'rejected', 'd1000000-0000-4000-8000-000000000005', 'supplier', 'supplier_portal')$$,
  '供應商拒單(dispatched→rejected)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source, payload)
    VALUES ('d6000000-0000-4000-8000-000000000010', 'accepted', 'quoted', 'd1000000-0000-4000-8000-000000000005', 'supplier', 'supplier_portal', '{"amount":1200}')$$,
  '供應商報價(accepted→quoted)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000011', 'confirmed', 'shipped', 'd1000000-0000-4000-8000-000000000005', 'supplier', 'supplier_portal')$$,
  '供應商出貨(confirmed→shipped)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000011', 'shipped', 'delivered', 'd1000000-0000-4000-8000-000000000005', 'supplier', 'supplier_portal')$$,
  '供應商送達(shipped→delivered)'
);

-- ---------------------------------------------------------------------
-- 5. 平台管理員:派單(含直接從草稿派)、取消、結案都不受影響
-- ---------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  '{"sub":"d1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000014', 'submitted', 'dispatched', 'd1000000-0000-4000-8000-000000000006', 'admin', 'admin_portal')$$,
  '管理員派單(submitted→dispatched)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000013', 'draft', 'dispatched', 'd1000000-0000-4000-8000-000000000006', 'admin', 'admin_portal')$$,
  '管理員直接從草稿派單(draft→dispatched)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000015', 'draft', 'cancelled', 'd1000000-0000-4000-8000-000000000006', 'admin', 'admin_portal')$$,
  '管理員取消草稿(draft→cancelled)'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_id, actor_role, source)
    VALUES ('d6000000-0000-4000-8000-000000000021', 'reviewed', 'closed', 'd1000000-0000-4000-8000-000000000006', 'admin', 'admin_portal')$$,
  '管理員結案(reviewed→closed)'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET total_amount = 4321 WHERE id = 'd6000000-0000-4000-8000-000000000021'$$,
  '管理員改訂單內容不受影響'
);

-- ---------------------------------------------------------------------
-- 6. 系統(service_role,沒有登入者):不受簽核限制
-- ---------------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('d6000000-0000-4000-8000-000000000018', 'draft', 'submitted', 'system', 'system', '系統代送')$$,
  'service_role 送出草稿不受簽核限制'
);

-- ---------------------------------------------------------------------
-- 6b. order_pipeline 檢視(20260928190200):照呼叫者的權限跑、不能經由它寫入
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_pipeline (restaurant_id, status) VALUES ('d2000000-0000-4000-8000-000000000001', 'submitted')$$,
  '42501', 'permission denied for view order_pipeline',
  '採購員經由 order_pipeline 直接建 submitted 的單被拒'
);
SELECT throws_ok(
  $$UPDATE public.order_pipeline SET total_amount = 1 WHERE id = 'd6000000-0000-4000-8000-000000000031'$$,
  '42501', 'permission denied for view order_pipeline',
  '經由 order_pipeline 改單被拒(連自己可以改的草稿也不行:只准直接改表,才會經過 RLS 與 guard)'
);
SELECT throws_ok(
  $$DELETE FROM public.order_pipeline WHERE id = 'd6000000-0000-4000-8000-000000000031'$$,
  '42501', 'permission denied for view order_pipeline',
  '經由 order_pipeline 刪單被拒'
);
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
SELECT is(
  (SELECT count(*)::int FROM public.order_pipeline WHERE restaurant_id = 'd2000000-0000-4000-8000-000000000001'),
  0, '別家餐廳的老闆經由 order_pipeline 看不到這家的單'
);
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SELECT ok(
  (SELECT count(*) > 0 AND count(*) FILTER (WHERE supplier_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000001') = 0
     FROM public.order_pipeline),
  '供應商經由 order_pipeline 只看得到自己的單(供應商總覽照常)'
);
SELECT set_config('request.jwt.claims', '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT ok(
  (SELECT count(*) > 0 FROM public.order_pipeline WHERE restaurant_id = 'd2000000-0000-4000-8000-000000000001'),
  '老闆經由 order_pipeline 看得到自己店的進行中訂單'
);
SELECT set_config('request.jwt.claims',
  '{"sub":"d1000000-0000-4000-8000-000000000006","role":"authenticated","app_metadata":{"role":"admin"}}', true);
SELECT ok(
  (SELECT count(*) > 0 FROM public.order_pipeline WHERE restaurant_id = 'd2000000-0000-4000-8000-000000000001'),
  '管理員經由 order_pipeline 照常看得到(交易全流程看板、總覽待辦)'
);
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok(
  $$SELECT count(*) FROM public.order_pipeline$$,
  '42501', 'permission denied for view order_pipeline',
  '未登入(anon)讀不到 order_pipeline'
);

-- ---------------------------------------------------------------------
-- 7. 結果:狀態機照常同步 status,被拒的單原封不動
-- ---------------------------------------------------------------------
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000001'), 'draft',      '採購員送出被拒的單仍是草稿');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000002'), 'draft',      '採購員跳關被拒的單仍是草稿');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000003'), 'cancelled',  '採購員取消的單是已取消(復活被拒)');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000004'), 'draft',      '兩筆一起寫被拒:連第一筆的取消都沒生效');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000005'), 'submitted',  '店長送出後狀態同步成 submitted');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000006'), 'submitted',  '老闆送出後狀態同步成 submitted');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000007'), 'draft',      '待接受邀請送出被拒的單仍是草稿');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000011'), 'delivered',  '供應商出貨→送達後是 delivered');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000013'), 'dispatched', '管理員從草稿派單後是 dispatched');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000016'), 'confirmed',  '採購員確認報價後是 confirmed');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000018'), 'submitted',  'service_role 送出後是 submitted');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000020'), 'cancelled',  '老闆退回的草稿是已取消');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000021'), 'closed',     '管理員結案後是 closed');
SELECT is(
  (SELECT ingredient_list = '[]'::jsonb AND total_amount IS NULL AND supplier_id IS NULL
     FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000014'),
  true, '已送出的單內容沒被採購員改到'
);
SELECT is((SELECT restaurant_id FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000041'),
  'd2000000-0000-4000-8000-000000000002'::uuid, '跨店搬單被擋:R2 的單還在 R2');
SELECT is((SELECT restaurant_id FROM public.supplier_orders WHERE id = 'd6000000-0000-4000-8000-000000000001'),
  'd2000000-0000-4000-8000-000000000001'::uuid, '跨店搬單被擋:R1 的草稿還在 R1');
SELECT is(
  (SELECT count(*)::int FROM public.supplier_orders
    WHERE restaurant_id = 'd2000000-0000-4000-8000-000000000001' AND created_by = 'd1000000-0000-4000-8000-000000000003' AND status <> 'draft'),
  0, '採購員沒有任何一張不是草稿的單'
);
SELECT is(
  (SELECT count(*)::int FROM public.order_events e
     JOIN public.supplier_orders o ON o.id = e.order_id
    WHERE o.restaurant_id = 'd2000000-0000-4000-8000-000000000001'
      AND e.actor_id = 'd1000000-0000-4000-8000-000000000003'),
  3, '採購員只寫進 3 筆事件(取消草稿、確認報價、確認收貨)'
);
SELECT is(
  (SELECT count(*)::int FROM public.order_events e
     JOIN public.supplier_orders o ON o.id = e.order_id
    WHERE o.restaurant_id = 'd2000000-0000-4000-8000-000000000001'),
  17, '成功的 17 筆事件都有寫進履歷'
);

SELECT * FROM finish();
ROLLBACK;
