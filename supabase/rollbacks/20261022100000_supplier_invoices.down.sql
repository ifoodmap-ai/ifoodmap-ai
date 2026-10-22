-- =====================================================================
-- 還原 20261022100000_supplier_invoices:拆掉請款單的 4 支 RPC、兩張表與單號序列。
-- 🔴 請款單資料會一併刪除(包含已收款紀錄)。要保留的話先匯出 supplier_invoices / supplier_invoice_orders。
-- 🔴 先把前端退回沒有請款功能的版本(Vercel Instant Rollback),再跑這支,不然請款頁會呼叫不存在的 RPC。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.restaurant_respond_invoice(uuid, text, text);
DROP FUNCTION IF EXISTS public.supplier_void_invoice(uuid, text);
DROP FUNCTION IF EXISTS public.supplier_mark_invoice_paid(uuid, text);
DROP FUNCTION IF EXISTS public.supplier_create_invoice(uuid, uuid, text, date, date, integer, uuid[], text);

DROP TABLE IF EXISTS public.supplier_invoice_orders;
DROP TABLE IF EXISTS public.supplier_invoices;
DROP SEQUENCE IF EXISTS public.supplier_invoice_seq;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261022100000';

NOTIFY pgrst, 'reload schema';
