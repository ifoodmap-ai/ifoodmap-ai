-- =====================================================================
-- 還原 20261029100000_delivery_date_and_cutoff:拆掉配送日鎖定、把直接叫貨的檢查退回 20261028110000 的版本
-- (只檢查供應商已綁定)、刪掉接單規則表與 supplier_orders.delivery_date。
-- 🔴 供應商設的接單規則與所有訂單的配送日都會消失。
-- 🔴 先把前端退回沒有配送日的版本(Vercel Instant Rollback),再跑這支,不然叫貨頁會讀寫不存在的欄位。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_guard_delivery_date_lock ON public.supplier_orders;
DROP FUNCTION IF EXISTS public.guard_delivery_date_lock();

CREATE OR REPLACE FUNCTION public.guard_restaurant_direct_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_restaurant uuid;
  v_target     uuid;
BEGIN
  IF NEW.to_status IS DISTINCT FROM 'dispatched' OR NEW.actor_role IS DISTINCT FROM 'restaurant' THEN
    RETURN NEW;
  END IF;

  SELECT o.restaurant_id INTO v_restaurant FROM public.supplier_orders o WHERE o.id = NEW.order_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_target := (NEW.payload->>'supplier_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_target := NULL;
  END;

  IF v_target IS NULL OR NOT EXISTS (
       SELECT 1
         FROM public.restaurant_suppliers rs
         JOIN public.suppliers s ON s.id = rs.supplier_id
        WHERE rs.restaurant_id = v_restaurant AND rs.supplier_id = v_target AND s.is_active) THEN
    RAISE EXCEPTION '只能向已綁定的合作供應商叫貨,請先到「我的供應商」綁定'
      USING ERRCODE = '42501', HINT = 'supplier_not_bound';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_restaurant_direct_dispatch() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_restaurant_direct_dispatch() IS
  '餐廳身分寫 → dispatched 的訂單事件:payload.supplier_id 必須是這家店已綁定、還在營業的供應商。';

DROP TABLE IF EXISTS public.supplier_order_settings;
ALTER TABLE public.supplier_orders DROP COLUMN IF EXISTS delivery_date;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029100000';

NOTIFY pgrst, 'reload schema';
