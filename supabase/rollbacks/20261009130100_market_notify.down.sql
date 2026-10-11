-- =====================================================================
-- 還原 20261009130100_market_notify:拆掉狀態紀錄的通知 trigger 與排程函式、通知網址設定。
-- 🔴 要先還原 20261009130200(market_place_order 會呼叫 market_enqueue_notify)。
-- Edge Function market-notify 本身不用動(沒人呼叫就不會寄信);要停用可在 Dashboard 刪除那支函式。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_market_notify_event ON public.market_order_events;
DROP FUNCTION IF EXISTS public.market_notify_event();
DROP FUNCTION IF EXISTS public.market_enqueue_notify(jsonb);
DELETE FROM public.app_config WHERE key = 'market_notify_function_url';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130100';
