-- migration 20260929110000_order_cancel_requote_rules 的資料庫層測試
-- (管理員可以取消進行中的單、要填原因;老闆/店長可以退回重新報價、要填原因,舊報價作廢;
--  報價後品項鎖住,只有管理員/系統能改;被拒/逾時改派時前一家的報價作廢;notify 多帶 from_status/actor_role/event_id)
--
-- 整段包在 BEGIN … ROLLBACK:fixture 與事件都不會留下來,pg_net 的通知佇列也跟著回滾(不會寄信)。
-- 帳號一律 @example.com。每個探針都先 SET LOCAL ROLE + set_config('request.jwt.claims', …, true)。
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(51);

-- ---------------------------------------------------------------------
-- fixture:R1 = O 老闆、M 店長、P 採購員;S1 = SU;S2 = SU2;AD = 管理員
-- ---------------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('a1100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-owner@example.com', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a1100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-manager@example.com', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a1100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-purchaser@example.com', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a1100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-supplier@example.com', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a1100000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-admin@example.com', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now()),
  ('a1100000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'requote-supplier2@example.com', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());

INSERT INTO public.restaurants (id, name) VALUES ('a1200000-0000-4000-8000-000000000001', '重新報價驗收餐廳');
INSERT INTO public.restaurant_accounts (user_id, restaurant_id, role, is_active, accepted_at) VALUES
  ('a1100000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000001', 'owner', true, now()),
  ('a1100000-0000-4000-8000-000000000002', 'a1200000-0000-4000-8000-000000000001', 'manager', true, now()),
  ('a1100000-0000-4000-8000-000000000003', 'a1200000-0000-4000-8000-000000000001', 'purchaser', true, now());
INSERT INTO public.suppliers (id, name) VALUES
  ('a1400000-0000-4000-8000-000000000001', '重新報價驗收供應商'),
  ('a1400000-0000-4000-8000-000000000002', '重新報價驗收別家供應商');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a1100000-0000-4000-8000-000000000005', 'a1400000-0000-4000-8000-000000000001'),
  ('a1100000-0000-4000-8000-000000000008', 'a1400000-0000-4000-8000-000000000002');

-- 取消用:c1–c7 = 管理員可以取消的七種進行中狀態;c8 = 沒填原因;c9 = 派發前(不用原因);c10、c11 = 別人不能取消
INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status, total_amount, ingredient_list) VALUES
  ('a1600000-0000-4000-8000-0000000000c1', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'dispatched', NULL, '[]'),
  ('a1600000-0000-4000-8000-0000000000c2', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'sent', NULL, '[]'),
  ('a1600000-0000-4000-8000-0000000000c3', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'accepted', NULL, '[]'),
  ('a1600000-0000-4000-8000-0000000000c4', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 1000, '[]'),
  ('a1600000-0000-4000-8000-0000000000c5', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'confirmed', 1000, '[]'),
  ('a1600000-0000-4000-8000-0000000000c6', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'shipped', 1000, '[]'),
  ('a1600000-0000-4000-8000-0000000000c7', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'in_transit', 1000, '[]'),
  ('a1600000-0000-4000-8000-0000000000c8', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'confirmed', 1000, '[]'),
  ('a1600000-0000-4000-8000-0000000000c9', 'a1200000-0000-4000-8000-000000000001', NULL, 'submitted', NULL, '[]'),
  ('a1600000-0000-4000-8000-0000000000ca', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'dispatched', NULL, '[]'),
  ('a1600000-0000-4000-8000-0000000000cb', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'confirmed', 1000, '[]'),
-- 退回重新報價用:q1 老闆、q2 店長、q3 採購員、q4 沒填原因、q5 供應商
  ('a1600000-0000-4000-8000-0000000000d1', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000d2', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000d3', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[]'),
  ('a1600000-0000-4000-8000-0000000000d4', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[]'),
  ('a1600000-0000-4000-8000-0000000000d5', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[]'),
-- 品項鎖:e1 待確認、e2 待出貨、e3 待收貨(鎖住);e4 待報價、e5 待派發、e6 待接單(還能改);e7 管理員、e8 系統
  ('a1600000-0000-4000-8000-0000000000e1', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e2', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'confirmed', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e3', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'delivered', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e4', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'accepted', NULL, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e5', 'a1200000-0000-4000-8000-000000000001', NULL, 'submitted', NULL, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e6', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'dispatched', NULL, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e7', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'quoted', 3200, '[{"name":"高麗菜","quantity":10}]'),
  ('a1600000-0000-4000-8000-0000000000e8', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'confirmed', 3200, '[{"name":"高麗菜","quantity":10}]'),
-- 改派:f1 逾時(帶著前一家的報價)、f2 被拒
  ('a1600000-0000-4000-8000-0000000000f1', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'expired', 1500, '[]'),
  ('a1600000-0000-4000-8000-0000000000f2', 'a1200000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000001', 'rejected', NULL, '[]');
INSERT INTO public.order_quotes (order_id, supplier_id, total_amount, status) VALUES
  ('a1600000-0000-4000-8000-0000000000d1', 'a1400000-0000-4000-8000-000000000001', 3200, 'quoted'),
  ('a1600000-0000-4000-8000-0000000000f1', 'a1400000-0000-4000-8000-000000000001', 1500, 'quoted');

-- ---------------------------------------------------------------------
-- 0. migration 本身
-- ---------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.order_transition_rules()), 105, '轉移表 105 條(20261028110000 加了老闆/店長/採購員的 draft→dispatched)');
SELECT is(
  (SELECT string_agg(from_status, ',' ORDER BY from_status) FROM public.order_transition_rules() WHERE actor = 'admin' AND to_status = 'cancelled'),
  'accepted,confirmed,dispatched,draft,expired,in_transit,pending,quoted,rejected,sent,shipped,submitted',
  '管理員可以從 12 種狀態取消(含待接單、待報價、待餐廳確認、待出貨、已出貨、運送中)'
);
SELECT is(
  (SELECT string_agg(actor, ',' ORDER BY actor) FROM public.order_transition_rules() WHERE from_status = 'quoted' AND to_status = 'accepted'),
  'manager,owner,system', '退回重新報價:老闆、店長(與系統)可以,採購員與供應商不行'
);
SELECT ok(
  pg_get_functiondef('public.notify_order_event()'::regprocedure) LIKE '%''from_status'', NEW.from_status%'
  AND pg_get_functiondef('public.notify_order_event()'::regprocedure) LIKE '%''actor_role'',  NEW.actor_role%'
  AND pg_get_functiondef('public.notify_order_event()'::regprocedure) LIKE '%''event_id'',    NEW.id%',
  'notify_order_event 多帶 from_status / actor_role / event_id'
);

-- ---------------------------------------------------------------------
-- 1. 管理員取消進行中的單:要填原因;其他身分不能取消
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a1100000-0000-4000-8000-000000000006","role":"authenticated","email":"requote-admin@example.com","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  format($$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
           VALUES (%L, %L, 'cancelled', 'admin', 'admin_portal', '供應商聯絡不上,平台取消')$$, o.id, o.status),
  format('管理員可以取消「%s」的單(填了原因)', o.status))
  FROM public.supplier_orders o
 WHERE o.id IN ('a1600000-0000-4000-8000-0000000000c1', 'a1600000-0000-4000-8000-0000000000c2', 'a1600000-0000-4000-8000-0000000000c3',
                'a1600000-0000-4000-8000-0000000000c4', 'a1600000-0000-4000-8000-0000000000c5', 'a1600000-0000-4000-8000-0000000000c6',
                'a1600000-0000-4000-8000-0000000000c7')
 ORDER BY o.id;
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('a1600000-0000-4000-8000-0000000000c8', 'confirmed', 'cancelled', 'admin', 'admin_portal')$$,
  '22023', '取消進行中的訂單要填寫原因',
  '管理員取消進行中的單沒填原因被拒'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000c8', 'confirmed', 'cancelled', 'admin', 'admin_portal', '   ')$$,
  '22023', '取消進行中的訂單要填寫原因',
  '只填空白也不算原因'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('a1600000-0000-4000-8000-0000000000c9', 'submitted', 'cancelled', 'admin', 'admin_portal')$$,
  '派發前取消(submitted→cancelled)照舊不用原因'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","email":"requote-owner@example.com"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000ca', 'dispatched', 'cancelled', 'restaurant', 'restaurant_portal', '不要了')$$,
  '42501', '餐廳老闆不能把訂單從「待接單」改成「已取消」',
  '老闆不能取消已派發的單(只有管理員可以)'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated","email":"requote-supplier@example.com"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000cb', 'confirmed', 'cancelled', 'supplier', 'supplier_portal', '缺貨')$$,
  '42501', '供應商不能把訂單從「待出貨」改成「已取消」',
  '供應商不能自己取消(要拒單或請平台處理)'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.supplier_orders
    WHERE id IN ('a1600000-0000-4000-8000-0000000000c1', 'a1600000-0000-4000-8000-0000000000c2', 'a1600000-0000-4000-8000-0000000000c3',
                 'a1600000-0000-4000-8000-0000000000c4', 'a1600000-0000-4000-8000-0000000000c5', 'a1600000-0000-4000-8000-0000000000c6',
                 'a1600000-0000-4000-8000-0000000000c7') AND status = 'cancelled'),
  7, '七張進行中的單都取消了'
);
SELECT is(
  (SELECT count(*)::int FROM public.order_events
    WHERE order_id IN ('a1600000-0000-4000-8000-0000000000c1', 'a1600000-0000-4000-8000-0000000000c7')
      AND to_status = 'cancelled' AND note = '供應商聯絡不上,平台取消' AND actor_role = 'admin'
      AND actor_id = 'a1100000-0000-4000-8000-000000000006'),
  2, '取消原因寫在事件備註,履歷保留(執行者是管理員)'
);
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000c8'), 'confirmed', '沒填原因的取消沒生效');
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000ca'), 'dispatched', '老闆取消被拒的單仍是待接單');

-- ---------------------------------------------------------------------
-- 2. 退回重新報價
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","email":"requote-owner@example.com"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000d1', 'quoted', 'accepted', 'restaurant', 'restaurant_portal', '高麗菜改成 20 顆,請重新報價')$$,
  '老闆退回重新報價(填了原因)'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source)
    VALUES ('a1600000-0000-4000-8000-0000000000d4', 'quoted', 'accepted', 'restaurant', 'restaurant_portal')$$,
  '22023', '退回重新報價要填寫原因(會轉告供應商)',
  '退回重新報價沒填原因被拒'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000002","role":"authenticated","email":"requote-manager@example.com"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000d2', 'quoted', 'accepted', 'restaurant', 'restaurant_portal', '價格太高')$$,
  '店長退回重新報價'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000003","role":"authenticated","email":"requote-purchaser@example.com"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000d3', 'quoted', 'accepted', 'restaurant', 'restaurant_portal', '想改')$$,
  '42501', '餐廳採購員不能把訂單從「待確認」改成「待報價」',
  '採購員不能退回重新報價'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated","email":"requote-supplier@example.com"}', true);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000d5', 'quoted', 'accepted', 'supplier', 'supplier_portal', '我想改價')$$,
  '42501', '供應商不能把訂單從「待確認」改成「待報價」',
  '供應商不能自己把報價收回'
);
RESET ROLE;
SELECT is(
  (SELECT status || ' | ' || coalesce(total_amount::text, 'NULL') FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000d1'),
  'accepted | NULL', '退回後回到「待報價」、金額清空'
);
SELECT is(
  (SELECT string_agg(status, ',') FROM public.order_quotes WHERE order_id = 'a1600000-0000-4000-8000-0000000000d1'),
  'rejected', '舊報價標成 rejected'
);
SELECT is(
  (SELECT note FROM public.order_events WHERE order_id = 'a1600000-0000-4000-8000-0000000000d1' AND to_status = 'accepted'),
  '高麗菜改成 20 顆,請重新報價', '退回原因寫在事件備註(notify 會帶給供應商)'
);
-- 退回後老闆改品項(待報價可以改),供應商重新報價
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","email":"requote-owner@example.com"}', true);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":20}]' WHERE id = 'a1600000-0000-4000-8000-0000000000d1'$$,
  '退回重新報價之後(待報價)老闆可以改品項'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000005","role":"authenticated","email":"requote-supplier@example.com"}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('a1600000-0000-4000-8000-0000000000d1', 'accepted', 'quoted', 'supplier', 'supplier_portal', '{"total_amount":6100}')$$,
  '供應商重新報價'
);
RESET ROLE;
SELECT is(
  (SELECT status || ' | ' || total_amount::text FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000d1'),
  'quoted | 6100.00', '重新報價後是「待確認」、新金額'
);
SELECT is(
  (SELECT string_agg(status || ':' || round(total_amount)::text, ',' ORDER BY total_amount) FROM public.order_quotes WHERE order_id = 'a1600000-0000-4000-8000-0000000000d1'),
  'rejected:3200,quoted:6100', '報價紀錄:舊的 rejected、新的 quoted'
);

-- ---------------------------------------------------------------------
-- 3. 報價後品項鎖住
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","email":"requote-owner@example.com"}', true);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":100}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e1'$$,
  '42501', '供應商報價之後品項就鎖住了;要改品項,請先「退回重新報價」',
  '老闆不能在「待確認」改品項(報 ×10 的價、改成 ×100)'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[]' WHERE id = 'a1600000-0000-4000-8000-0000000000e2'$$,
  '42501', '供應商報價之後品項就鎖住了;要改品項,請先「退回重新報價」',
  '老闆不能在「待出貨」改品項'
);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[]' WHERE id = 'a1600000-0000-4000-8000-0000000000e3'$$,
  '42501', '供應商報價之後品項就鎖住了;要改品項,請先「退回重新報價」',
  '老闆不能在「待收貨」改品項'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET notes = '請早上送' WHERE id = 'a1600000-0000-4000-8000-0000000000e1'$$,
  '報價後改備註仍然可以(只鎖品項)'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":12}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e4'$$,
  '報價前(待報價)老闆可以改品項'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":12}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e5'$$,
  '待派發老闆可以改品項'
);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":12}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e6'$$,
  '待接單老闆可以改品項'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000002","role":"authenticated","email":"requote-manager@example.com"}', true);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[]' WHERE id = 'a1600000-0000-4000-8000-0000000000e1'$$,
  '42501', '供應商報價之後品項就鎖住了;要改品項,請先「退回重新報價」',
  '店長也不能在報價後改品項'
);
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000003","role":"authenticated","email":"requote-purchaser@example.com"}', true);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[]' WHERE id = 'a1600000-0000-4000-8000-0000000000e1'$$,
  '42501', '採購單送出後只有老闆或店長可以修改',
  '採購員照舊只能改草稿'
);
SELECT set_config('request.jwt.claims',
  '{"sub":"a1100000-0000-4000-8000-000000000006","role":"authenticated","email":"requote-admin@example.com","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":9}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e7'$$,
  '管理員報價後仍能改品項(代客處理)'
);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT lives_ok(
  $$UPDATE public.supplier_orders SET ingredient_list = '[{"name":"高麗菜","quantity":8}]' WHERE id = 'a1600000-0000-4000-8000-0000000000e8'$$,
  '系統身分報價後仍能改品項'
);
RESET ROLE;
SELECT is(
  (SELECT ingredient_list FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000e1'),
  '[{"name":"高麗菜","quantity":10}]'::jsonb, '被擋的單品項沒變'
);

-- ---------------------------------------------------------------------
-- 4. 被拒 / 逾時後改派:前一家的報價作廢
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"a1100000-0000-4000-8000-000000000006","role":"authenticated","email":"requote-admin@example.com","app_metadata":{"role":"admin"}}', true);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('a1600000-0000-4000-8000-0000000000f1', 'expired', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"a1400000-0000-4000-8000-000000000002"}')$$,
  '管理員把逾時的單改派給 S2'
);
SELECT lives_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload)
    VALUES ('a1600000-0000-4000-8000-0000000000f2', 'rejected', 'dispatched', 'admin', 'admin_portal', '{"supplier_id":"a1400000-0000-4000-8000-000000000002"}')$$,
  '管理員把被拒的單改派給 S2'
);
RESET ROLE;
SELECT is(
  (SELECT supplier_id::text || ' | ' || coalesce(total_amount::text, 'NULL') FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000f1'),
  'a1400000-0000-4000-8000-000000000002 | NULL', '改派後換成 S2、前一家的報價金額清空'
);
SELECT is(
  (SELECT string_agg(status, ',') FROM public.order_quotes WHERE order_id = 'a1600000-0000-4000-8000-0000000000f1'),
  'rejected', '前一家的報價紀錄標成 rejected'
);
SELECT is((SELECT status FROM public.supplier_orders WHERE id = 'a1600000-0000-4000-8000-0000000000f2'), 'dispatched', '被拒的單改派後是待接單');

-- ---------------------------------------------------------------------
-- 5. 前一輪的限制照舊(不因為新規則放寬)
-- ---------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1100000-0000-4000-8000-000000000001","role":"authenticated","email":"requote-owner@example.com"}', true);
SELECT throws_ok(
  $$UPDATE public.supplier_orders SET total_amount = 1 WHERE id = 'a1600000-0000-4000-8000-0000000000e1'$$,
  '42501', '訂單金額由供應商報價決定,送出後不能直接修改',
  '老闆仍然不能直接改報價金額'
);
SELECT throws_ok(
  $$INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, note)
    VALUES ('a1600000-0000-4000-8000-0000000000e2', 'confirmed', 'accepted', 'restaurant', 'restaurant_portal', '想重報')$$,
  '42501', '餐廳老闆不能把訂單從「待出貨」改成「待報價」',
  '確認報價之後就不能退回重新報價了(只有「待確認」可以)'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
