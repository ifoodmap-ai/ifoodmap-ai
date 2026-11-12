-- =====================================================================
-- 餐廳端:依分店與身分決定看得到哪些訂單(同一張訂單,不同身分看到不同內容)
--
-- 以前:同一家餐廳的所有成員(老闆 / 店長 / 採購員),不管屬於哪家分店,都看得到全部訂單。
-- 現在:
--   老闆(owner)        → 所有分店的訂單
--   店長 / 採購員        → 自己被指派的那家分店的訂單;還沒指派分店的帳號,維持看全部(舊帳號不會突然看不到)
--   沒有分店的訂單(branch_id IS NULL,舊單或沒分店的店家)→ 所有成員都看得到
--   管理員 / 供應商      → 不受影響
-- 價格仍然只有老闆 / 店長看得到(採購員看不到單價與金額,是原本就有的規則,前端與 RLS 都沒動)。
--
-- 做法:只收緊 supplier_orders 的餐廳端 SELECT / UPDATE / INSERT policy。order_events、order_quotes、
--       supplier_shipments、delivery_receipts、invoices、order_payments 這些表的 policy 都是
--       「訂單 id IN (SELECT … FROM supplier_orders …)」的子查詢,子查詢照呼叫者的 RLS 跑,所以自動跟著收緊。
--       請款單(supplier_invoices)是整家餐廳層級、沒有 branch_id:改成老闆、或「沒有指派分店的店長」才看得到,
--       有指派分店的店長不看(避免從請款單看到別家分店的訂單明細)。
--
-- 另外給供應商:能讀到「派給自己的訂單」所屬分店的名稱 / 地址 / 收貨時段(出貨要知道送去哪一家分店)。
--
-- 不動:訂單狀態機、轉移表、order_events 的寫入規則、前面幾支 migration 的任何函式。
-- 還原:supabase/rollbacks/20261110100000_restaurant_branch_scope.down.sql
-- 測試:supabase/tests/restaurant_branch_scope.test.ts
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 判斷函式
-- ---------------------------------------------------------------------
-- 目前使用者能不能看(動)這家餐廳、這個分店的訂單。成員資格沿用 current_restaurant_ids()(啟用且已接受邀請)。
CREATE OR REPLACE FUNCTION public.can_see_branch_order(p_restaurant uuid, p_branch uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT p_restaurant IN (SELECT public.current_restaurant_ids())
     AND EXISTS (
       SELECT 1 FROM public.restaurant_accounts ra
        WHERE ra.user_id = auth.uid()
          AND ra.restaurant_id = p_restaurant
          AND ra.is_active
          AND (ra.role = 'owner' OR ra.branch_id IS NULL OR p_branch IS NULL OR ra.branch_id = p_branch))
$$;

-- 目前使用者能不能看這家餐廳「所有分店」層級的資料(老闆,或沒有指派分店的帳號)
CREATE OR REPLACE FUNCTION public.can_see_all_branches(p_restaurant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT p_restaurant IN (SELECT public.current_restaurant_ids())
     AND EXISTS (
       SELECT 1 FROM public.restaurant_accounts ra
        WHERE ra.user_id = auth.uid()
          AND ra.restaurant_id = p_restaurant
          AND ra.is_active
          AND (ra.role = 'owner' OR ra.branch_id IS NULL))
$$;

REVOKE ALL ON FUNCTION public.can_see_branch_order(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_see_all_branches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_see_branch_order(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_see_all_branches(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. supplier_orders 的餐廳端 policy
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "restaurant_read_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_read_own_orders" ON public.supplier_orders
  FOR SELECT TO authenticated
  USING (public.can_see_branch_order(restaurant_id, branch_id));

DROP POLICY IF EXISTS "restaurant_update_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_update_own_orders" ON public.supplier_orders
  FOR UPDATE TO authenticated
  USING (public.can_see_branch_order(restaurant_id, branch_id))
  WITH CHECK (public.can_see_branch_order(restaurant_id, branch_id));

-- 建單:20260929100200 的版本 + 只能建自己分店(或沒有分店)的單
DROP POLICY IF EXISTS "restaurant_create_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_create_own_orders" ON public.supplier_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    restaurant_id IN (SELECT public.current_restaurant_ids())
    AND public.can_see_branch_order(restaurant_id, branch_id)
    AND supplier_id IS NULL
    AND (
      status = 'draft'
      OR (status = 'submitted' AND public.restaurant_role(restaurant_id) IN ('owner', 'manager'))
    )
  );

-- ---------------------------------------------------------------------
-- 3. 請款單(整家餐廳層級):老闆,或沒有指派分店的店長
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "invoices restaurant read" ON public.supplier_invoices;
CREATE POLICY "invoices restaurant read" ON public.supplier_invoices FOR SELECT TO authenticated
  USING (
    public.restaurant_role(restaurant_id) IN ('owner', 'manager')
    AND public.can_see_all_branches(restaurant_id)
  );

-- ---------------------------------------------------------------------
-- 4. 供應商讀得到「派給自己的訂單」所屬分店(送貨地點)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "branches supplier read" ON public.restaurant_branches;
CREATE POLICY "branches supplier read" ON public.restaurant_branches FOR SELECT TO authenticated
  USING (
    id IN (SELECT o.branch_id FROM public.supplier_orders o
            WHERE o.branch_id IS NOT NULL AND o.supplier_id IN (SELECT public.current_supplier_ids()))
  );
