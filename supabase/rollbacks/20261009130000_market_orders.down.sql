-- =====================================================================
-- 還原 20261009130000_market_orders
-- 🔴 會刪掉所有零售訂單、明細、狀態紀錄 —— 先匯出再跑;要先還原 20261009130200 → 20261009130100。
-- 狀態紀錄有「只能新增」的 trigger(刪訂單會連帶刪紀錄而被擋),所以先拆 trigger 再刪表。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_market_events_immutable ON public.market_order_events;
DROP TABLE IF EXISTS public.market_order_events;
DROP TABLE IF EXISTS public.market_order_items;
DROP TABLE IF EXISTS public.market_orders;

DROP FUNCTION IF EXISTS public.market_apply_event();
DROP FUNCTION IF EXISTS public.market_guard_event();
DROP FUNCTION IF EXISTS public.market_events_immutable();
DROP FUNCTION IF EXISTS public.market_events_one_per_order();
DROP FUNCTION IF EXISTS public.market_order_status_label(text);
DROP FUNCTION IF EXISTS public.market_transition_rules();
DROP FUNCTION IF EXISTS public.market_email_ok(text);
DROP FUNCTION IF EXISTS public.market_phone_ok(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130000';

NOTIFY pgrst, 'reload schema';
