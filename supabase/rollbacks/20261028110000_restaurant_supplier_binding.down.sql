-- =====================================================================
-- 還原 20261028110000_restaurant_supplier_binding:
--   拆掉直接叫貨的檢查 trigger、把轉移表退回 102 條(20260929110000 的版本)、把草稿送出的簽核規則退回
--   20260928190000 的版本、刪掉合作供應商綁定表。
-- 🔴 綁定資料會一併刪除。已經直接叫貨(草稿 → 待接單)的訂單照常往下走,不受影響。
-- 🔴 先把前端退回沒有「合作供應商直接叫貨」的版本(Vercel Instant Rollback),再跑這支,不然叫貨會被資料庫擋下。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_guard_restaurant_dispatch ON public.order_events;
DROP FUNCTION IF EXISTS public.guard_restaurant_direct_dispatch();

CREATE OR REPLACE FUNCTION public.order_transition_rules()
RETURNS TABLE (actor text, from_status text, to_status text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT t.actor, t.from_status, t.to_status FROM (VALUES
    -- @transitions-begin
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
  '訂單狀態轉移表(身分, 從, 到)。身分:owner/manager/purchaser/supplier/admin/system。與 src/lib/orders.ts TRANSITIONS 對齊。20260929110000 起 102 條。';

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
  '送出類訂單事件(→submitted,或把 draft/cancelled 推往其他狀態)只限該店老闆/店長、平台管理員或系統。';

DROP TABLE IF EXISTS public.restaurant_suppliers;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261028110000';

NOTIFY pgrst, 'reload schema';
