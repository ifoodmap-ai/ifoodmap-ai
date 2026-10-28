-- =====================================================================
-- 餐廳與「合作供應商」綁定,綁定後可以直接叫貨(2026-10-28 業主需求)
--
-- 背景:媒合平台(找供應商)與採購系統(例行叫貨)的介面是分開的。採購系統裡,餐廳是向「既定的合作供應商」叫貨,
--   供應商本來就確定了 —— 訂單不該再經過「待派發 → 管理員派單」。
--
-- 做法:
--   1. restaurant_suppliers:餐廳與供應商的綁定(一對一筆)。老闆 / 店長可以新增與解除,綁定立刻生效、不需要供應商接受;
--      餐廳的所有成員(含採購員)與該供應商、管理員都看得到。既有往來(已經收過貨的餐廳 × 供應商)自動補成已綁定。
--   2. 轉移表 102 → 105 條:老闆 / 店長 / 採購員都可以 draft → dispatched(草稿直接進供應商的「待接單」)。
--      業主拍板(B):對綁定的合作供應商叫貨不需要簽核,採購員也直接送出。
--   3. guard_order_submission:放行「餐廳成員把草稿直接推到待接單」(原本草稿送出只限老闆 / 店長)。
--   4. guard_restaurant_direct_dispatch(新):餐廳身分寫 → dispatched 的事件,payload.supplier_id 一定要是
--      「這家店已綁定、而且還在營業」的供應商 —— 前端傳什麼都不採信,資料庫擋。管理員 / 系統派單不受影響。
--   原本的流程完全保留:草稿送出(→ submitted,老闆 / 店長簽核)與管理員派單(submitted → dispatched)照舊,
--   那是媒合平台的流程(例如形象站 AI 對話帶進來的草稿)。
--
-- 派單時 supplier_id 怎麼寫到訂單上:沿用 apply_order_event_details(dispatched 事件的 payload.supplier_id),不動。
-- 通知:沿用 notify_order_event → notify(dispatched → 供應商「有新訂單等你接單」),不動。
--
-- 還原:supabase/rollbacks/20261028110000_restaurant_supplier_binding.down.sql
-- 測試:supabase/tests/restaurant_supplier_binding.test.ts(PGlite 重放真正的訂單狀態機 migration,再套這一支)
--       supabase/tests/database/order_transition_rules.test.sql / order_cancel_requote.test.sql 的條數已同步成 105
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 綁定表
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_suppliers (
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  created_by    UUID DEFAULT auth.uid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_suppliers_supplier ON public.restaurant_suppliers (supplier_id);

ALTER TABLE public.restaurant_suppliers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.restaurant_suppliers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.restaurant_suppliers TO authenticated;

-- 看:這家餐廳的所有成員、被綁定的供應商自己、管理員
DROP POLICY IF EXISTS "restaurant suppliers read" ON public.restaurant_suppliers;
CREATE POLICY "restaurant suppliers read" ON public.restaurant_suppliers FOR SELECT TO authenticated
  USING (
    restaurant_id IN (SELECT public.current_restaurant_ids())
    OR supplier_id IN (SELECT public.current_supplier_ids())
    OR public.is_admin()
  );

-- 新增 / 解除:這家餐廳的老闆或店長(採購員只能叫貨、不能管綁定);新增只能綁還在營業的供應商
DROP POLICY IF EXISTS "restaurant suppliers bind" ON public.restaurant_suppliers;
CREATE POLICY "restaurant suppliers bind" ON public.restaurant_suppliers FOR INSERT TO authenticated
  WITH CHECK (
    public.restaurant_role(restaurant_id) IN ('owner', 'manager')
    AND created_by IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = supplier_id AND s.is_active)
  );

DROP POLICY IF EXISTS "restaurant suppliers unbind" ON public.restaurant_suppliers;
CREATE POLICY "restaurant suppliers unbind" ON public.restaurant_suppliers FOR DELETE TO authenticated
  USING (public.restaurant_role(restaurant_id) IN ('owner', 'manager'));

-- 既有往來:已經收過貨的餐廳 × 供應商補成已綁定(「收過貨」的定義同 src/lib/metrics.ts:
-- received / reviewed / completed,或有進過 received / reviewed 事件的 closed)
INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id, created_by)
SELECT DISTINCT o.restaurant_id, o.supplier_id, NULL::uuid
  FROM public.supplier_orders o
  JOIN public.suppliers s ON s.id = o.supplier_id AND s.is_active
 WHERE o.restaurant_id IS NOT NULL
   AND o.supplier_id IS NOT NULL
   AND (
     o.status IN ('received', 'reviewed', 'completed')
     OR (o.status = 'closed' AND EXISTS (
           SELECT 1 FROM public.order_events e
            WHERE e.order_id = o.id AND e.to_status IN ('received', 'reviewed')))
   )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. 轉移表(105 條;前端 TRANSITIONS 由 src/lib/orders.test.ts 解析這一段比對)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_transition_rules()
RETURNS TABLE (actor text, from_status text, to_status text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT t.actor, t.from_status, t.to_status FROM (VALUES
    -- @transitions-begin
    -- 餐廳(老闆 / 店長 / 採購員)向「已綁定的合作供應商」叫貨:草稿直接進「待接單」,不經管理員派發、不需簽核
    -- (20261028110000;供應商一定要是已綁定的,由 guard_restaurant_direct_dispatch 檢查)
    ('owner', 'draft', 'dispatched'),
    ('manager', 'draft', 'dispatched'),
    ('purchaser', 'draft', 'dispatched'),
    -- 餐廳老闆(報價後可以「退回重新報價」quoted→accepted,要填原因)
    ('owner', 'draft', 'submitted'),
    ('owner', 'draft', 'cancelled'),
    ('owner', 'quoted', 'confirmed'),
    ('owner', 'quoted', 'cancelled'),
    ('owner', 'delivered', 'received'),
    ('owner', 'delivered', 'discrepancy'),
    ('owner', 'received', 'reviewed'),
    ('owner', 'discrepancy', 'disputed'),
    ('owner', 'quoted', 'accepted'),
    -- 餐廳店長(同老闆)
    ('manager', 'draft', 'submitted'),
    ('manager', 'draft', 'cancelled'),
    ('manager', 'quoted', 'confirmed'),
    ('manager', 'quoted', 'cancelled'),
    ('manager', 'delivered', 'received'),
    ('manager', 'delivered', 'discrepancy'),
    ('manager', 'received', 'reviewed'),
    ('manager', 'discrepancy', 'disputed'),
    ('manager', 'quoted', 'accepted'),
    -- 餐廳採購員:不能送出(要老闆/店長簽核)、不能退回重新報價,其餘同老闆
    ('purchaser', 'draft', 'cancelled'),
    ('purchaser', 'quoted', 'confirmed'),
    ('purchaser', 'quoted', 'cancelled'),
    ('purchaser', 'delivered', 'received'),
    ('purchaser', 'delivered', 'discrepancy'),
    ('purchaser', 'received', 'reviewed'),
    ('purchaser', 'discrepancy', 'disputed'),
    -- 這張單的供應商:最多推到 delivered(received 只有餐廳能觸發 —— GMV 可信度的來源)
    ('supplier', 'dispatched', 'accepted'),
    ('supplier', 'dispatched', 'rejected'),
    ('supplier', 'sent', 'accepted'),
    ('supplier', 'sent', 'rejected'),
    ('supplier', 'accepted', 'quoted'),
    ('supplier', 'confirmed', 'shipped'),
    ('supplier', 'shipped', 'in_transit'),
    ('supplier', 'shipped', 'delivered'),
    ('supplier', 'in_transit', 'delivered'),
    -- 平台管理員:派單、取消(進行中的單也可以取消,要填原因)、仲裁、結案
    ('admin', 'submitted', 'dispatched'),
    ('admin', 'submitted', 'cancelled'),
    ('admin', 'pending', 'dispatched'),
    ('admin', 'pending', 'cancelled'),
    ('admin', 'draft', 'dispatched'),
    ('admin', 'draft', 'cancelled'),
    ('admin', 'rejected', 'dispatched'),
    ('admin', 'rejected', 'cancelled'),
    ('admin', 'expired', 'dispatched'),
    ('admin', 'expired', 'cancelled'),
    ('admin', 'discrepancy', 'disputed'),
    ('admin', 'discrepancy', 'received'),
    ('admin', 'discrepancy', 'closed'),
    ('admin', 'disputed', 'closed'),
    ('admin', 'disputed', 'received'),
    ('admin', 'reviewed', 'closed'),
    ('admin', 'received', 'closed'),
    ('admin', 'dispatched', 'cancelled'),
    ('admin', 'sent', 'cancelled'),
    ('admin', 'accepted', 'cancelled'),
    ('admin', 'quoted', 'cancelled'),
    ('admin', 'confirmed', 'cancelled'),
    ('admin', 'shipped', 'cancelled'),
    ('admin', 'in_transit', 'cancelled'),
    -- 系統(service_role、資料庫直連、排程):上面所有轉移的聯集 + 等待中的單逾時(dispatched/sent/accepted/quoted/confirmed → expired)
    ('system', 'draft', 'submitted'),
    ('system', 'draft', 'cancelled'),
    ('system', 'draft', 'dispatched'),
    ('system', 'submitted', 'dispatched'),
    ('system', 'submitted', 'cancelled'),
    ('system', 'pending', 'dispatched'),
    ('system', 'pending', 'cancelled'),
    ('system', 'dispatched', 'accepted'),
    ('system', 'dispatched', 'rejected'),
    ('system', 'dispatched', 'expired'),
    ('system', 'sent', 'accepted'),
    ('system', 'sent', 'rejected'),
    ('system', 'sent', 'expired'),
    ('system', 'accepted', 'quoted'),
    ('system', 'accepted', 'expired'),
    ('system', 'quoted', 'confirmed'),
    ('system', 'quoted', 'cancelled'),
    ('system', 'quoted', 'expired'),
    ('system', 'confirmed', 'shipped'),
    ('system', 'shipped', 'in_transit'),
    ('system', 'shipped', 'delivered'),
    ('system', 'in_transit', 'delivered'),
    ('system', 'delivered', 'received'),
    ('system', 'delivered', 'discrepancy'),
    ('system', 'received', 'reviewed'),
    ('system', 'received', 'closed'),
    ('system', 'reviewed', 'closed'),
    ('system', 'discrepancy', 'disputed'),
    ('system', 'discrepancy', 'received'),
    ('system', 'discrepancy', 'closed'),
    ('system', 'disputed', 'closed'),
    ('system', 'disputed', 'received'),
    ('system', 'rejected', 'dispatched'),
    ('system', 'rejected', 'cancelled'),
    ('system', 'expired', 'dispatched'),
    ('system', 'expired', 'cancelled'),
    ('system', 'dispatched', 'cancelled'),
    ('system', 'sent', 'cancelled'),
    ('system', 'accepted', 'cancelled'),
    ('system', 'quoted', 'accepted'),
    ('system', 'confirmed', 'cancelled'),
    ('system', 'confirmed', 'expired'),
    ('system', 'shipped', 'cancelled'),
    ('system', 'in_transit', 'cancelled')
    -- @transitions-end
  ) AS t(actor, from_status, to_status)
$$;

COMMENT ON FUNCTION public.order_transition_rules() IS
  '訂單狀態轉移表(身分, 從, 到)。身分:owner/manager/purchaser/supplier/admin/system。與 src/lib/orders.ts TRANSITIONS 對齊。20261028110000 起 105 條。';

-- ---------------------------------------------------------------------
-- 3. 草稿送出的簽核規則:現行版本(20260928190100)+「直接叫貨給合作供應商」這個例外
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_order_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_status        text;
  v_restaurant_id uuid;
BEGIN
  -- 唯讀,不加鎖
  SELECT o.status, o.restaurant_id
    INTO v_status, v_restaurant_id
    FROM public.supplier_orders o
   WHERE o.id = NEW.order_id;

  -- 訂單不存在:交給外鍵去報錯
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 不是送出類事件就放行
  IF NEW.to_status IS DISTINCT FROM 'submitted'
     AND NOT (v_status IN ('draft', 'cancelled') AND NEW.to_status NOT IN ('draft', 'cancelled')) THEN
    RETURN NEW;
  END IF;

  -- 平台管理員;系統身分(沒有登入者,且 JWT role 是 service_role 或沒有 JWT)
  IF public.is_admin()
     OR (auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role') THEN
    RETURN NEW;
  END IF;

  -- 這家店已接受、啟用中的老闆或店長
  IF public.restaurant_role(v_restaurant_id) IN ('owner', 'manager') THEN
    RETURN NEW;
  END IF;

  -- 向合作供應商直接叫貨(草稿 → 待接單):這家店已接受、啟用中的任何成員都可以(採購員也不用簽核);
  -- 供應商一定要是這家店已綁定的,由 guard_restaurant_direct_dispatch 檢查
  IF NEW.to_status = 'dispatched' AND v_status = 'draft'
     AND public.restaurant_role(v_restaurant_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 對已取消的單做送出以外的動作(多半是停在舊畫面):說清楚是單已取消
  IF v_status = 'cancelled' AND NEW.to_status IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION '這張訂單已經取消,不能再進行其他動作(請重新整理頁面)'
      USING ERRCODE = '42501',
            HINT = 'order_cancelled';
  END IF;

  RAISE EXCEPTION '採購單要由這家餐廳的老闆或店長簽核後才能送出'
    USING ERRCODE = '42501',
          HINT = 'needs_owner_or_manager_approval';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_order_submission() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_order_submission() FROM anon;
REVOKE ALL ON FUNCTION public.guard_order_submission() FROM authenticated;

COMMENT ON FUNCTION public.guard_order_submission() IS
  '送出類訂單事件(→submitted,或把 draft/cancelled 推往其他狀態)只限該店老闆/店長、平台管理員或系統;例外:餐廳成員把草稿直接推到待接單(向合作供應商叫貨,供應商由 guard_restaurant_direct_dispatch 檢查)。';

-- ---------------------------------------------------------------------
-- 4. 餐廳直接叫貨:供應商一定要是這家店已綁定、還在營業的
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
BEGIN
  -- 只管「餐廳身分」寫的 → dispatched(管理員 / 系統派單走自己的規則)。
  -- actor_role 的真假由 trg_guard_order_transition 檢查(名字排在這支前面,先跑)
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

-- 名字要排在 trg_guard_order_transition 之後(同一時機的 trigger 依名稱字母序執行)
DROP TRIGGER IF EXISTS trg_guard_restaurant_dispatch ON public.order_events;
CREATE TRIGGER trg_guard_restaurant_dispatch
BEFORE INSERT ON public.order_events
FOR EACH ROW EXECUTE FUNCTION public.guard_restaurant_direct_dispatch();

NOTIFY pgrst, 'reload schema';
