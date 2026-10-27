-- =====================================================================
-- 還原 20261028100000_supplies_image:拆掉 supplies.image_path 與它的 CHECK。
-- 🔴 已設定的商品圖片關聯會消失(Storage 裡的檔案不會刪,物件只能寫一次、SQL 刪不了)。
-- 🔴 先把前端退回沒有商品圖片的版本(Vercel Instant Rollback),再跑這支,不然目錄頁讀 image_path 會失敗。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.supplies DROP CONSTRAINT IF EXISTS supplies_image_path_check;
ALTER TABLE public.supplies DROP COLUMN IF EXISTS image_path;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261028100000';

NOTIFY pgrst, 'reload schema';
