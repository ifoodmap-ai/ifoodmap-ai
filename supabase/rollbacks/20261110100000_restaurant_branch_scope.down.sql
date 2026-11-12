-- 還原 20261110100000_restaurant_branch_scope:
-- 餐廳端的訂單 policy 回到「同一家餐廳的成員都看得到全部」,請款單回到「老闆 / 店長」,拿掉供應商讀分店的 policy 與兩個判斷函式。
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "branches supplier read" ON public.restaurant_branches;

DROP POLICY IF EXISTS "invoices restaurant read" ON public.supplier_invoices;
CREATE POLICY "invoices restaurant read" ON public.supplier_invoices FOR SELECT TO authenticated
  USING (public.restaurant_role(restaurant_id) IN ('owner', 'manager'));

DROP POLICY IF EXISTS "restaurant_create_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_create_own_orders" ON public.supplier_orders
  FOR INSERT TO authenticated
  WITH CHECK (
    restaurant_id IN (SELECT public.current_restaurant_ids())
    AND supplier_id IS NULL
    AND (
      status = 'draft'
      OR (status = 'submitted' AND public.restaurant_role(restaurant_id) IN ('owner', 'manager'))
    )
  );

DROP POLICY IF EXISTS "restaurant_update_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_update_own_orders" ON public.supplier_orders
  FOR UPDATE TO authenticated
  USING (restaurant_id IN (SELECT public.current_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT public.current_restaurant_ids()));

DROP POLICY IF EXISTS "restaurant_read_own_orders" ON public.supplier_orders;
CREATE POLICY "restaurant_read_own_orders" ON public.supplier_orders
  FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.current_restaurant_ids()));

DROP FUNCTION IF EXISTS public.can_see_all_branches(uuid);
DROP FUNCTION IF EXISTS public.can_see_branch_order(uuid, uuid);
