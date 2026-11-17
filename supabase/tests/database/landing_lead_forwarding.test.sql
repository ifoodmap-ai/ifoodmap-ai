-- =====================================================================
-- migration 20261118100000_landing_lead_forwarding 的資料庫層測試
-- 執行:
--   SUPABASE_ACCESS_TOKEN=… node scripts/supabase-sql.mjs dry supabase/tests/database/landing_lead_forwarding.test.sql \
--     --with-migration supabase/migrations/20261118100000_landing_lead_forwarding.sql
-- 本檔不含 BEGIN / ROLLBACK(runner 會包起來);fixture 慣例見 _market_helpers.sql。
-- 食材名稱用「測試專用食材甲 / 乙 / 丙」:正式庫真實供應商不會有,轉送只會配到這裡建的 fixture 供應商。
-- =====================================================================

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sup1@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sup4@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-0000000000a9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'stranger@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());

INSERT INTO public.suppliers (id, name, is_active, service_areas) VALUES
  ('a9200000-0000-4000-8000-0000000000a1', '轉送測試 S1(台北)', true,  ARRAY['台北市']),
  ('a9200000-0000-4000-8000-0000000000a2', '轉送測試 S2(高雄)', true,  ARRAY['高雄市']),
  ('a9200000-0000-4000-8000-0000000000a3', '轉送測試 S3(停用)', false, ARRAY['台北市']),
  ('a9200000-0000-4000-8000-0000000000a4', '轉送測試 S4(不限區域)', true, '{}');

INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-0000000000a1'),
  ('a9100000-0000-4000-8000-0000000000a2', 'a9200000-0000-4000-8000-0000000000a4');

INSERT INTO public.supplies (supplier_id, name, currency) VALUES
  ('a9200000-0000-4000-8000-0000000000a1', '測試專用食材甲', 'TWD'),
  ('a9200000-0000-4000-8000-0000000000a1', '測試專用食材乙', 'TWD'),
  ('a9200000-0000-4000-8000-0000000000a2', '測試專用食材甲', 'TWD'),
  ('a9200000-0000-4000-8000-0000000000a3', '測試專用食材甲', 'TWD'),
  ('a9200000-0000-4000-8000-0000000000a4', '測試專用食材甲', 'TWD');

INSERT INTO public.analysis_records (id, source_type, ingredient_list) VALUES
  ('a9300000-0000-4000-8000-0000000000a1', 'chatbot', '[{"name":"測試專用食材甲"},{"name":"測試專用食材乙"}]'),
  ('a9300000-0000-4000-8000-0000000000a2', 'chatbot', '[{"name":"測試專用食材丙"}]');

-- ---------- 結構 ----------
SELECT pg_temp.expect('landing_leads 新增 9 個欄位',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'landing_leads'
    AND column_name IN ('contact_name','delivery_area','frequency','extra_notes','contact_time','consent_share','forward_status','forwarded_at','forwarded_count')), '9');
SELECT pg_temp.expect('supplier_leads 新增 landing_lead_id 與 contact',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'supplier_leads'
    AND column_name IN ('landing_lead_id','contact')), '2');
SELECT pg_temp.expect('forward_landing_lead 不開給 anon / authenticated',
  (SELECT (has_function_privilege('anon', 'public.forward_landing_lead(uuid)', 'EXECUTE')
        OR has_function_privilege('authenticated', 'public.forward_landing_lead(uuid)', 'EXECUTE'))::text), 'false');

-- ---------- 訪客留言(anon)→ 自動轉送 ----------
SELECT pg_temp.expect('anon 勾同意留言:寫入成功',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.landing_leads (id, company_name, contact_phone, items_text, source, analysis_id, delivery_area, consent_share, contact_name, frequency)
    VALUES ('a9400000-0000-4000-8000-0000000000a1', '轉送測試店', '0900000101', '測試專用食材甲、乙', 'ai_widget',
            'a9300000-0000-4000-8000-0000000000a1', '台北市中正區', true, '阿測', '每週 2～3 次')$q$),
  'OK');
SELECT pg_temp.expect('只轉給品項、區域都符合的 S1 與不限區域的 S4(S2 在高雄、S3 已停用)',
  (SELECT string_agg(right(supplier_id::text, 2), ',' ORDER BY supplier_id) FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1'),
  'a1,a4');
SELECT pg_temp.expect('S1 符合 2/2 項 = 99 分(上限 99,跟商機頁的媒合分數一致),S4 符合 1/2 項 = 50 分',
  (SELECT string_agg(score::text, ',' ORDER BY supplier_id) FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1'),
  '99,50');
SELECT pg_temp.expect('lead 標成 forwarded、轉給 2 家',
  (SELECT forward_status || ':' || forwarded_count FROM public.landing_leads WHERE id = 'a9400000-0000-4000-8000-0000000000a1'),
  'forwarded:2');
SELECT pg_temp.expect('商機附聯絡資料快照',
  (SELECT contact->>'company' || '|' || (contact->>'phone') || '|' || (contact->>'area') || '|' || (contact->>'frequency')
     FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1' AND supplier_id = 'a9200000-0000-4000-8000-0000000000a1'),
  '轉送測試店|0900000101|台北市中正區|每週 2～3 次');

SELECT pg_temp.expect('沒勾同意:寫入成功但不轉送、狀態維持 pending',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.landing_leads (id, company_name, contact_phone, source, analysis_id, delivery_area, consent_share)
    VALUES ('a9400000-0000-4000-8000-0000000000a2', '沒勾同意店', '0900000102', 'ai_widget', 'a9300000-0000-4000-8000-0000000000a1', '台北市', false)$q$),
  'OK');
SELECT pg_temp.expect('沒勾同意 → 0 筆商機、pending',
  (SELECT (SELECT count(*) FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a2')::text
          || ':' || forward_status FROM public.landing_leads WHERE id = 'a9400000-0000-4000-8000-0000000000a2'),
  '0:pending');

SELECT pg_temp.expect('沒有符合的供應商:寫入成功',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.landing_leads (id, company_name, contact_phone, source, analysis_id, delivery_area, consent_share)
    VALUES ('a9400000-0000-4000-8000-0000000000a3', '沒配到店', '0900000103', 'ai_widget', 'a9300000-0000-4000-8000-0000000000a2', '台北市', true)$q$),
  'OK');
SELECT pg_temp.expect('沒有符合 → no_match、0 家',
  (SELECT forward_status || ':' || forwarded_count FROM public.landing_leads WHERE id = 'a9400000-0000-4000-8000-0000000000a3'),
  'no_match:0');

SELECT pg_temp.expect('anon 偷填處理狀態:寫入成功',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.landing_leads (id, company_name, contact_phone, source, consent_share, forward_status, forwarded_count)
    VALUES ('a9400000-0000-4000-8000-0000000000a4', '偷填狀態店', '0900000104', 'ai_widget', false, 'forwarded', 99)$q$),
  'OK');
SELECT pg_temp.expect('偷填的狀態被蓋回初始值',
  (SELECT forward_status || ':' || forwarded_count FROM public.landing_leads WHERE id = 'a9400000-0000-4000-8000-0000000000a4'),
  'pending:0');

-- ---------- 權限 ----------
SELECT pg_temp.expect('anon 讀不到任何 landing_leads(RLS 沒有 SELECT policy → 0 筆)',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.landing_leads$q$), '0');
SELECT pg_temp.expect('anon 不能自己呼叫轉送函式',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$SELECT public.forward_landing_lead('a9400000-0000-4000-8000-0000000000a2')$q$), 'ERR 42501');
SELECT pg_temp.expect('S1 供應商只看得到轉給自己的那一筆聯絡資料',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-0000000000a1'),
    $q$SELECT count(*)::text || ':' || min(contact->>'phone') FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1'$q$),
  '1:0900000101');
SELECT pg_temp.expect('不相干的登入者看不到任何商機',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-0000000000a9'),
    $q$SELECT count(*)::text FROM public.supplier_leads WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1'$q$),
  '0');
SELECT pg_temp.expect('供應商可以更新商機狀態',
  pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-0000000000a1'),
    $q$UPDATE public.supplier_leads SET status = 'contacted' WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1' AND supplier_id = 'a9200000-0000-4000-8000-0000000000a1'$q$),
  'OK');
SELECT pg_temp.expect('供應商改不了聯絡資料',
  pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-0000000000a1'),
    $q$UPDATE public.supplier_leads SET contact = '{"phone":"x"}'::jsonb WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1' AND supplier_id = 'a9200000-0000-4000-8000-0000000000a1'$q$),
  'ERR 42501');
SELECT pg_temp.expect('供應商改不了來源 lead',
  pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-0000000000a1'),
    $q$UPDATE public.supplier_leads SET landing_lead_id = NULL WHERE landing_lead_id = 'a9400000-0000-4000-8000-0000000000a1' AND supplier_id = 'a9200000-0000-4000-8000-0000000000a1'$q$),
  'ERR 42501');
