BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(26);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  (
    '21000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'restaurant-one@ifoodmap.invalid', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '21000000-0000-0000-0000-000000000002'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'restaurant-two@ifoodmap.invalid', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '22000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'supplier-one@ifoodmap.invalid', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '22000000-0000-0000-0000-000000000002'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'supplier-two@ifoodmap.invalid', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '23000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated', 'authenticated', 'admin@ifoodmap.invalid', '',
    '{"provider":"email","providers":["email"],"role":"admin"}'::jsonb,
    '{}'::jsonb, now(), now()
  );

INSERT INTO public.restaurants (id, name) VALUES
  ('31000000-0000-0000-0000-000000000001'::uuid, 'RLS 餐廳一'),
  ('31000000-0000-0000-0000-000000000002'::uuid, 'RLS 餐廳二');

-- accepted_at 要給值:沒接受的邀請不算成員(migration 20260928170000)
INSERT INTO public.restaurant_accounts (
  user_id, restaurant_id, role, is_active, accepted_at
) VALUES
  (
    '21000000-0000-0000-0000-000000000001'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    'owner', true, now()
  ),
  (
    '21000000-0000-0000-0000-000000000002'::uuid,
    '31000000-0000-0000-0000-000000000002'::uuid,
    'owner', true, now()
  );

INSERT INTO public.suppliers (id, name) VALUES
  ('32000000-0000-0000-0000-000000000001'::uuid, 'RLS 供應商一'),
  ('32000000-0000-0000-0000-000000000002'::uuid, 'RLS 供應商二');

INSERT INTO public.supplier_accounts (
  user_id, supplier_id, is_active
) VALUES
  (
    '22000000-0000-0000-0000-000000000001'::uuid,
    '32000000-0000-0000-0000-000000000001'::uuid,
    true
  ),
  (
    '22000000-0000-0000-0000-000000000002'::uuid,
    '32000000-0000-0000-0000-000000000002'::uuid,
    true
  );

INSERT INTO public.supplier_orders (
  id, supplier_id, restaurant_id, ingredient_list, status
) VALUES
  (
    '41000000-0000-0000-0000-000000000001'::uuid,
    '32000000-0000-0000-0000-000000000001'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    '[]'::jsonb, 'pending'
  ),
  (
    '41000000-0000-0000-0000-000000000002'::uuid,
    '32000000-0000-0000-0000-000000000002'::uuid,
    '31000000-0000-0000-0000-000000000002'::uuid,
    '[]'::jsonb, 'pending'
  );

INSERT INTO public.order_quotes (id, order_id, supplier_id, total_amount)
VALUES
  (
    '51000000-0000-0000-0000-000000000001'::uuid,
    '41000000-0000-0000-0000-000000000001'::uuid,
    '32000000-0000-0000-0000-000000000001'::uuid,
    100
  ),
  (
    '51000000-0000-0000-0000-000000000002'::uuid,
    '41000000-0000-0000-0000-000000000002'::uuid,
    '32000000-0000-0000-0000-000000000002'::uuid,
    200
  );

INSERT INTO public.order_payments (id, order_id, amount)
VALUES
  (
    '52000000-0000-0000-0000-000000000001'::uuid,
    '41000000-0000-0000-0000-000000000001'::uuid,
    100
  ),
  (
    '52000000-0000-0000-0000-000000000002'::uuid,
    '41000000-0000-0000-0000-000000000002'::uuid,
    200
  );

INSERT INTO public.invoices (id, order_id, amount)
VALUES
  (
    '53000000-0000-0000-0000-000000000001'::uuid,
    '41000000-0000-0000-0000-000000000001'::uuid,
    100
  ),
  (
    '53000000-0000-0000-0000-000000000002'::uuid,
    '41000000-0000-0000-0000-000000000002'::uuid,
    200
  );

INSERT INTO public.notifications (id, recipient, title)
VALUES
  (
    '54000000-0000-0000-0000-000000000001'::uuid,
    'restaurant-one@ifoodmap.invalid',
    'RLS 通知一'
  ),
  (
    '54000000-0000-0000-0000-000000000002'::uuid,
    'supplier-one@ifoodmap.invalid',
    'RLS 通知二'
  );

-- Restaurant one sees only order one's transaction records. The expected
-- single-row result also proves restaurant two's row is denied.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"21000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '21000000-0000-0000-0000-000000000001',
  true
);
SELECT results_eq(
  $$ SELECT id FROM public.order_quotes ORDER BY id $$,
  $$ VALUES ('51000000-0000-0000-0000-000000000001'::uuid) $$,
  'restaurant one reads only its quote'
);
SELECT results_eq(
  $$ SELECT id FROM public.order_payments ORDER BY id $$,
  $$ VALUES ('52000000-0000-0000-0000-000000000001'::uuid) $$,
  'restaurant one reads only its payment'
);
SELECT results_eq(
  $$ SELECT id FROM public.invoices ORDER BY id $$,
  $$ VALUES ('53000000-0000-0000-0000-000000000001'::uuid) $$,
  'restaurant one reads only its invoice'
);
SELECT is(
  (SELECT count(*) FROM public.notifications),
  0::bigint,
  'restaurant one cannot read free-text notifications'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"21000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '21000000-0000-0000-0000-000000000002',
  true
);
SELECT results_eq(
  $$ SELECT id FROM public.order_quotes ORDER BY id $$,
  $$ VALUES ('51000000-0000-0000-0000-000000000002'::uuid) $$,
  'restaurant two reads only its quote'
);
SELECT results_eq(
  $$ SELECT id FROM public.order_payments ORDER BY id $$,
  $$ VALUES ('52000000-0000-0000-0000-000000000002'::uuid) $$,
  'restaurant two reads only its payment'
);
SELECT results_eq(
  $$ SELECT id FROM public.invoices ORDER BY id $$,
  $$ VALUES ('53000000-0000-0000-0000-000000000002'::uuid) $$,
  'restaurant two reads only its invoice'
);
SELECT is(
  (SELECT count(*) FROM public.notifications),
  0::bigint,
  'restaurant two cannot read free-text notifications'
);
RESET ROLE;

-- Supplier sessions use the order's supplier_id, not a caller-provided label.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '22000000-0000-0000-0000-000000000001',
  true
);
SELECT results_eq(
  $$ SELECT id FROM public.order_quotes ORDER BY id $$,
  $$ VALUES ('51000000-0000-0000-0000-000000000001'::uuid) $$,
  'supplier one reads only its quote'
);
SELECT results_eq(
  $$ SELECT id FROM public.order_payments ORDER BY id $$,
  $$ VALUES ('52000000-0000-0000-0000-000000000001'::uuid) $$,
  'supplier one reads only its payment'
);
SELECT results_eq(
  $$ SELECT id FROM public.invoices ORDER BY id $$,
  $$ VALUES ('53000000-0000-0000-0000-000000000001'::uuid) $$,
  'supplier one reads only its invoice'
);
SELECT is(
  (SELECT count(*) FROM public.notifications),
  0::bigint,
  'supplier one cannot read free-text notifications'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '22000000-0000-0000-0000-000000000002',
  true
);
SELECT results_eq(
  $$ SELECT id FROM public.order_quotes ORDER BY id $$,
  $$ VALUES ('51000000-0000-0000-0000-000000000002'::uuid) $$,
  'supplier two reads only its quote'
);
SELECT results_eq(
  $$ SELECT id FROM public.order_payments ORDER BY id $$,
  $$ VALUES ('52000000-0000-0000-0000-000000000002'::uuid) $$,
  'supplier two reads only its payment'
);
SELECT results_eq(
  $$ SELECT id FROM public.invoices ORDER BY id $$,
  $$ VALUES ('53000000-0000-0000-0000-000000000002'::uuid) $$,
  'supplier two reads only its invoice'
);
SELECT is(
  (SELECT count(*) FROM public.notifications),
  0::bigint,
  'supplier two cannot read free-text notifications'
);
RESET ROLE;

-- Admin is determined from signed app_metadata in the JWT.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"23000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"admin"}}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '23000000-0000-0000-0000-000000000001',
  true
);
-- 正式庫(沒有 staging)裡有真實資料,所以只數這支測試自己建的兩列;
-- 管理員看得到兩列,加上上面各身分「只看得到自己那一列」的檢查,就證明了範圍
SELECT is(
  (SELECT count(*) FROM public.order_quotes
    WHERE id IN ('51000000-0000-0000-0000-000000000001'::uuid, '51000000-0000-0000-0000-000000000002'::uuid)),
  2::bigint,
  'admin reads all quotes'
);
SELECT is(
  (SELECT count(*) FROM public.order_payments
    WHERE id IN ('52000000-0000-0000-0000-000000000001'::uuid, '52000000-0000-0000-0000-000000000002'::uuid)),
  2::bigint,
  'admin reads all payments'
);
SELECT is(
  (SELECT count(*) FROM public.invoices
    WHERE id IN ('53000000-0000-0000-0000-000000000001'::uuid, '53000000-0000-0000-0000-000000000002'::uuid)),
  2::bigint,
  'admin reads all invoices'
);
SELECT is(
  (SELECT count(*) FROM public.notifications
    WHERE id IN ('54000000-0000-0000-0000-000000000001'::uuid, '54000000-0000-0000-0000-000000000002'::uuid)),
  2::bigint,
  'admin reads all notifications'
);
RESET ROLE;

-- anon has no table privilege, so denial is an explicit permission error.
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ SELECT id FROM public.order_quotes $$,
  '42501',
  'permission denied for table order_quotes',
  'anon cannot read quotes'
);
SELECT throws_ok(
  $$ SELECT id FROM public.order_payments $$,
  '42501',
  'permission denied for table order_payments',
  'anon cannot read payments'
);
SELECT throws_ok(
  $$ SELECT id FROM public.invoices $$,
  '42501',
  'permission denied for table invoices',
  'anon cannot read invoices'
);
SELECT throws_ok(
  $$ SELECT id FROM public.notifications $$,
  '42501',
  'permission denied for table notifications',
  'anon cannot read notifications'
);
RESET ROLE;

-- Supplier one can write a quote only against an order assigned to supplier one.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
SELECT set_config(
  'request.jwt.claim.sub',
  '22000000-0000-0000-0000-000000000001',
  true
);
SELECT lives_ok(
  $$
    INSERT INTO public.order_quotes (
      id, order_id, supplier_id, total_amount
    ) VALUES (
      '51000000-0000-0000-0000-000000000003'::uuid,
      '41000000-0000-0000-0000-000000000001'::uuid,
      '32000000-0000-0000-0000-000000000001'::uuid,
      300
    )
  $$,
  'supplier can quote its assigned order'
);
SELECT throws_ok(
  $$
    INSERT INTO public.order_quotes (
      id, order_id, supplier_id, total_amount
    ) VALUES (
      '51000000-0000-0000-0000-000000000004'::uuid,
      '41000000-0000-0000-0000-000000000002'::uuid,
      '32000000-0000-0000-0000-000000000001'::uuid,
      400
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "order_quotes"',
  'supplier cannot attach its quote to another supplier order'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
