-- =====================================================================
-- 批發商品(supplies)可以上傳圖片(2026-10-28 業主需求)
--
-- 做法:跟零售市集商品照片同一套 —— 圖片放在既有的 Storage bucket market-images
-- (公開讀取、每張 ≤ 2 MB、只收 jpg / png / webp、只有該供應商能寫自己的資料夾;見 20261009120100),
-- 資料表只存「路徑」,不存網址。縮圖在同一個資料夾:主圖 <uuid>.jpg 的縮圖是 <uuid>_t.jpg(480px,列表用)。
--
-- 這支只加一個欄位與一條 CHECK:
--   supplies.image_path  <supplier_id>/<supplies.id>/<uuid>.<jpg|jpeg|png|webp>,沒有圖片就是 NULL
--   CHECK:路徑一定要在「自己供應商」的「自己這個商品」資料夾底下 —— 不能指到別人的圖、別的商品的圖、
--         縮圖(_t)或外部網址,所以餐廳端 / 公開頁顯示時不會被導到不明來源的圖片。
-- 既有商品都是 NULL(沒有圖片),照舊顯示色塊 / 文字。寫入權限沿用既有的 "Suppliers manage own supplies" policy,不動。
--
-- 還原:supabase/rollbacks/20261028100000_supplies_image.down.sql(只拆欄位;Storage 裡已上傳的檔案留著,物件只能寫一次、不能由 SQL 刪)
-- 測試:supabase/tests/supplies_image.test.ts(PGlite 真的跑這份 SQL)
-- =====================================================================

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.supplies ADD COLUMN IF NOT EXISTS image_path TEXT;

ALTER TABLE public.supplies DROP CONSTRAINT IF EXISTS supplies_image_path_check;
ALTER TABLE public.supplies ADD CONSTRAINT supplies_image_path_check CHECK (
  image_path IS NULL
  OR image_path ~ ('^' || supplier_id::text || '/' || id::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')
);

COMMENT ON COLUMN public.supplies.image_path IS
  '商品圖片路徑(Storage bucket market-images,<supplier_id>/<supplies.id>/<uuid>.jpg);縮圖是同資料夾的 <uuid>_t.jpg。沒有圖片為 NULL。';

NOTIFY pgrst, 'reload schema';
