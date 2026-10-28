-- =====================================================================
-- 配送日與截單時間(2026-10-29,參考 OrderUp B2B 的批發叫貨流程:晚上下單、隔天一早備貨送貨)
--
-- 1. supplier_orders.delivery_date:餐廳叫貨時選的配送日(DATE,可以沒有 —— 舊單與管理員派單的單沒有)。
-- 2. supplier_order_settings:供應商自己設定的接單規則(沒有這一列 = 沒有限制):
--      cutoff_time        截單時間(台灣時間),預設 22:00
--      lead_days          要提前幾天截單,預設 1(= 配送日前一天的截單時間之前要下單);0 = 當天截單
--      delivery_weekdays  哪幾天有配送(0 = 週日 … 6 = 週六),預設每天
--    供應商可以讀寫自己的;已綁定這家供應商的餐廳成員、管理員可以讀(叫貨頁要顯示截單提示)。
-- 3. guard_restaurant_direct_dispatch(20261028110000 的那支)加檢查,餐廳直接叫貨(draft → dispatched)時:
--      - 配送日不能早於今天(台灣時間);
--      - 供應商有設定接單規則的話:一定要選配送日、那天要有配送、而且還沒超過截單時間。
--    沒有設定規則的供應商照舊(配送日可有可無)。管理員 / 系統派單不受影響。
-- 4. trg_guard_delivery_date:送出之後(不是草稿)配送日不能再被餐廳直接改 —— 否則可以先趕在截單前叫貨、
--    再把配送日改掉。草稿隨便改;管理員 / 系統不受限。
--
-- 還原:supabase/rollbacks/20261029100000_delivery_date_and_cutoff.down.sql
-- 測試:supabase/tests/delivery_date_and_cutoff.test.ts(PGlite 重放真正的訂單狀態機 migration 再套這一支)
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 配送日
-- ---------------------------------------------------------------------
ALTER TABLE public.supplier_orders ADD COLUMN IF NOT EXISTS delivery_date DATE;

COMMENT ON COLUMN public.supplier_orders.delivery_date IS
  '餐廳叫貨時選的配送日(台灣日期);舊單與管理員派單的單沒有。向設了接單規則的供應商叫貨時一定要有。';

-- ---------------------------------------------------------------------
-- 2. 供應商的接單規則
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_order_settings (
  supplier_id       UUID PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  cutoff_time       TIME NOT NULL DEFAULT '22:00',
  lead_days         INTEGER NOT NULL DEFAULT 1 CHECK (lead_days BETWEEN 0 AND 14),
  delivery_weekdays SMALLINT[] NOT NULL DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[],
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_order_settings_weekdays_valid
    CHECK (cardinality(delivery_weekdays) BETWEEN 1 AND 7 AND delivery_weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

ALTER TABLE public.supplier_order_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.supplier_order_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_order_settings TO authenticated;

DROP POLICY IF EXISTS "order settings supplier manage" ON public.supplier_order_settings;
CREATE POLICY "order settings supplier manage" ON public.supplier_order_settings FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

-- 已綁定這家供應商的餐廳成員、管理員:只能讀
DROP POLICY IF EXISTS "order settings partner read" ON public.supplier_order_settings;
CREATE POLICY "order settings partner read" ON public.supplier_order_settings FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.restaurant_suppliers rs
       WHERE rs.supplier_id = supplier_order_settings.supplier_id
         AND rs.restaurant_id IN (SELECT public.current_restaurant_ids()))
  );

-- ---------------------------------------------------------------------
-- 3. 直接叫貨的檢查:20261028110000 的版本 + 配送日 / 截單時間
-- ---------------------------------------------------------------------
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
  v_delivery   date;
  v_set        public.supplier_order_settings%ROWTYPE;
  v_now_tw     timestamp := (now() AT TIME ZONE 'Asia/Taipei');
BEGIN
  -- 只管「餐廳身分」寫的 → dispatched(管理員 / 系統派單走自己的規則)。
  -- actor_role 的真假由 trg_guard_order_transition 檢查(名字排在這支前面,先跑)
  IF NEW.to_status IS DISTINCT FROM 'dispatched' OR NEW.actor_role IS DISTINCT FROM 'restaurant' THEN
    RETURN NEW;
  END IF;

  SELECT o.restaurant_id, o.delivery_date INTO v_restaurant, v_delivery
    FROM public.supplier_orders o WHERE o.id = NEW.order_id;
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

  -- 配送日:不能是過去的日子
  IF v_delivery IS NOT NULL AND v_delivery < v_now_tw::date THEN
    RAISE EXCEPTION '配送日不能早於今天,請重新選擇'
      USING ERRCODE = '22023', HINT = 'delivery_date_in_past';
  END IF;

  -- 這家供應商有設定接單規則:要選配送日、那天有配送、還沒超過截單時間
  SELECT * INTO v_set FROM public.supplier_order_settings s WHERE s.supplier_id = v_target;
  IF FOUND THEN
    IF v_delivery IS NULL THEN
      RAISE EXCEPTION '請先選擇配送日期'
        USING ERRCODE = '22023', HINT = 'delivery_date_required';
    END IF;
    IF NOT (extract(dow FROM v_delivery)::smallint = ANY (v_set.delivery_weekdays)) THEN
      RAISE EXCEPTION '這家供應商這一天不配送,請改選其他日期'
        USING ERRCODE = '22023', HINT = 'delivery_weekday_not_served';
    END IF;
    IF v_now_tw > ((v_delivery - v_set.lead_days)::timestamp + v_set.cutoff_time) THEN
      RAISE EXCEPTION '已經超過這個配送日的截單時間,請改選之後的日期'
        USING ERRCODE = '22023', HINT = 'order_cutoff_passed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_restaurant_direct_dispatch() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_restaurant_direct_dispatch() IS
  '餐廳身分寫 → dispatched 的訂單事件:供應商必須是這家店已綁定、還在營業的;配送日不能是過去;供應商有設接單規則時要選配送日、那天有配送、還沒過截單時間。';

-- ---------------------------------------------------------------------
-- 4. 送出之後配送日不能再被餐廳改
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_delivery_date_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
BEGIN
  IF NEW.delivery_date IS NOT DISTINCT FROM OLD.delivery_date OR OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- 管理員;系統身分(沒有登入者,且 JWT role 是 service_role 或沒有 JWT)
  IF public.is_admin()
     OR (auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '訂單送出之後配送日不能直接修改,要改請聯絡供應商或客服'
    USING ERRCODE = '42501', HINT = 'delivery_date_locked';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_delivery_date_lock() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_delivery_date_lock() IS
  '訂單送出(不是草稿)之後,配送日只有管理員 / 系統能改。';

DROP TRIGGER IF EXISTS trg_guard_delivery_date_lock ON public.supplier_orders;
CREATE TRIGGER trg_guard_delivery_date_lock
BEFORE UPDATE OF delivery_date ON public.supplier_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_date_lock();

NOTIFY pgrst, 'reload schema';
