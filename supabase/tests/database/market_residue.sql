-- 乾跑之後查殘留(scripts/supabase-sql.mjs ro,唯讀端點)。每個數字都必須是 0。
-- fixture 的特徵:Email 結尾 @market-test.invalid、UUID 開頭 a9?00000-0000-4000-8000-、測試用通知網址 http://127.0.0.1:9/
-- (零售店家、商品、訂單都有外鍵連到 suppliers,fixture 供應商不在 = 它們的資料也不在)
SELECT json_build_object(
  'fixture_users',     (SELECT count(*) FROM auth.users WHERE email LIKE '%@market-test.invalid'),
  'fixture_suppliers', (SELECT count(*) FROM public.suppliers WHERE id::text LIKE 'a9200000-0000-4000-8000-%'),
  'fixture_objects',   (SELECT count(*) FROM storage.objects WHERE name LIKE 'a9200000-0000-4000-8000-%'),
  'test_queue_rows',   (SELECT count(*) FROM net.http_request_queue WHERE url LIKE 'http://127.0.0.1:9/%'),
  'test_config_rows',  (SELECT count(*) FROM public.app_config WHERE value LIKE 'http://127.0.0.1:9/%')
) AS residue;
