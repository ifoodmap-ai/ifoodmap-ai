-- =====================================================================
-- 還原 20261009120100_market_images_storage:只拆 policy 與函式。
-- 🔴 bucket 不能用 SQL 刪(storage.protect_delete 會擋)。真的要刪 bucket:
--    1. Supabase Dashboard → Storage → market-images 把檔案清空
--    2. DELETE https://cwvpehqcvbfuynabpqop.supabase.co/storage/v1/bucket/market-images(帶 service_role key;業主在 Dashboard 操作)
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "market images supplier select" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier insert" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier update" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier delete" ON storage.objects;
DROP FUNCTION IF EXISTS public.market_image_object_ok(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009120100';
