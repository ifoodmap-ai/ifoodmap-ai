-- =====================================================================
-- 消費者食材市集:商品照片與店家 logo / 封面的 Storage bucket(這個專案第一次用 Storage)
--
-- bucket market-images:
--   - 公開讀取(圖片網址 /storage/v1/object/public/market-images/<路徑>,不經過 RLS);沒有給 anon 的 SELECT policy → 不能列目錄
--   - 每個檔案 ≤ 2 MB、只收 image/jpeg、image/png、image/webp(Storage 伺服器端檢查,前端繞不過)
-- 路徑:<supplier_id>/<商品 id 或 store>/<uuid>[_t].<jpg|jpeg|png|webp>(_t = 列表用的 480px 縮圖)
-- 上傳只限路徑第一段 ∈ current_supplier_ids() 的登入者(該供應商的啟用中帳號)。
--
-- 🔴 物件只能寫一次:只有 SELECT + INSERT 兩條 policy,沒有 UPDATE / DELETE(2026-10-10 審查後拿掉)。
--    有的話,已核准商品的照片可以用 x-upsert 覆寫、或刪掉再同名重傳 —— 內容換了,商品卻不會回到待審。
--    前端一律 upsert:false、換照片不刪舊檔(src/lib/market/images.ts),不受影響;換掉的舊檔留在 bucket(孤兒檔)。
--    違規圖:管理員也沒有 storage policy,要從 Supabase Dashboard → Storage 或用 service role 刪(runbook 在 docs/DEPLOY.md)。
-- 🔴 storage.objects / storage.buckets 不能用 SQL 刪資料(protect_delete trigger 會擋,42501)。
--    還原只拆 policy 與函式;bucket 本身要清空後用 Storage API 刪(見 supabase/rollbacks/20261009120100_market_images_storage.down.sql)。
-- 測試:supabase/tests/database/market_images_storage.test.sql
-- =====================================================================

SET LOCAL lock_timeout = '3s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('market-images', 'market-images', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
   SET public = EXCLUDED.public,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 物件路徑合不合規、是不是自家的資料夾(CASE 保證格式不對時不會去轉 uuid)
CREATE OR REPLACE FUNCTION public.market_image_object_ok(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_name ~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                   || '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|store)/'
                   || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_t)?\.(jpg|jpeg|png|webp)$')
      THEN split_part(p_name, '/', 1)::uuid IN (SELECT public.current_supplier_ids())
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION public.market_image_object_ok(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_image_object_ok(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "market images supplier select" ON storage.objects;
CREATE POLICY "market images supplier select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'market-images' AND public.market_image_object_ok(name));

DROP POLICY IF EXISTS "market images supplier insert" ON storage.objects;
CREATE POLICY "market images supplier insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'market-images' AND public.market_image_object_ok(name));

-- 刻意沒有 UPDATE / DELETE policy(見檔頭「物件只能寫一次」)。
