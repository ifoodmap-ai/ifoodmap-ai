-- =====================================================================
-- 還原 20261009120000_market_catalog
-- 🔴 會刪掉零售店家、轉帳資訊、零售商品的資料 —— 先匯出再跑。
-- 🔴 順序:第 2 階段的 migration(20261009130200 → 130100 → 130000)與 20261009120100(Storage)要先還原;
--    前端也要先退回不碰 market_* 的版本(Vercel Instant Rollback),否則供應商後台的商品目錄頁會壞。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案(Management API 一個請求就是一個交易)。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS public.market_products;
DROP TABLE IF EXISTS public.market_store_transfer;
DROP TABLE IF EXISTS public.market_stores;

DROP FUNCTION IF EXISTS public.market_products_guard();
DROP FUNCTION IF EXISTS public.market_stores_guard();
DROP FUNCTION IF EXISTS public.market_store_transfer_touch();
DROP FUNCTION IF EXISTS public.market_store_is_open(uuid);
DROP FUNCTION IF EXISTS public.market_image_path_matches(text, uuid, text);
DROP FUNCTION IF EXISTS public.market_trim(text);
DROP FUNCTION IF EXISTS public.market_visible(text);
DROP FUNCTION IF EXISTS public.market_tw_cities();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009120000';

NOTIFY pgrst, 'reload schema';
