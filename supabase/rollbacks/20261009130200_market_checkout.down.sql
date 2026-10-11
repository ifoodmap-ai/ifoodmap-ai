-- =====================================================================
-- 還原 20261009130200_market_checkout:拆掉下單 / 查單 RPC、限流(計數表與擋下紀錄)、清理排程與兩個 app_config 設定。
-- 清理排程是這支 migration 建的,整個拆掉(沒有更早的版本要改回)。
-- 🔴 先把前端退回不會呼叫 market_place_order / market_get_orders 的版本(Vercel Instant Rollback),再跑這支。
-- 已成立的訂單保留(在 market_orders,20261009130000 才會拆)。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup';

DROP FUNCTION IF EXISTS public.market_checkout_status();
DROP FUNCTION IF EXISTS public.market_get_orders(text);
DROP FUNCTION IF EXISTS public.market_place_order(jsonb);
DROP FUNCTION IF EXISTS public.market_mask_email(text);
DROP FUNCTION IF EXISTS public.market_mask_phone(text);
DROP FUNCTION IF EXISTS public.market_client_ip();
DROP FUNCTION IF EXISTS public.market_normalize_ip(text);
DROP FUNCTION IF EXISTS public.market_rate_key(text, text, text);
DROP FUNCTION IF EXISTS public.market_rate_take(jsonb);
DROP TABLE IF EXISTS public.market_rate_counters;
DROP TABLE IF EXISTS public.market_rate_blocks_daily;

DELETE FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt');
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130200';

NOTIFY pgrst, 'reload schema';
