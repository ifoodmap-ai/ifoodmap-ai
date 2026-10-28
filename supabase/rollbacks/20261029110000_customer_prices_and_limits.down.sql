-- =====================================================================
-- 還原 20261029110000_customer_prices_and_limits:把直接叫貨的檢查退回 20261029100000 的版本(配送日 / 截單,
-- 沒有數量上限),刪掉客戶專屬價格、客戶群組與群組價格、數量上限的資料表與相關函式。
-- 🔴 供應商設的客戶價格、群組與群組價格、數量上限會消失(叫貨頁與報價預填不再有價格;要保留的話先匯出)。
-- 🔴 先把前端退回沒有客戶價格 / 上限的版本(Vercel Instant Rollback),再跑這支。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

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

  IF v_delivery IS NOT NULL AND v_delivery < v_now_tw::date THEN
    RAISE EXCEPTION '配送日不能早於今天,請重新選擇'
      USING ERRCODE = '22023', HINT = 'delivery_date_in_past';
  END IF;

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

DROP TABLE IF EXISTS public.supplier_group_prices;
DROP TABLE IF EXISTS public.supplier_customer_group_members;
DROP TABLE IF EXISTS public.supplier_customer_groups;
DROP TABLE IF EXISTS public.supplier_customer_limits;
DROP TABLE IF EXISTS public.supplier_customer_prices;
DROP FUNCTION IF EXISTS public.guard_group_member_bound();
DROP FUNCTION IF EXISTS public.guard_customer_rule_supply();
DROP FUNCTION IF EXISTS public.order_item_qty(jsonb, text);
DROP FUNCTION IF EXISTS public.fmt_qty(numeric);
DROP FUNCTION IF EXISTS public.norm_item_name(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261029110000';

NOTIFY pgrst, 'reload schema';
