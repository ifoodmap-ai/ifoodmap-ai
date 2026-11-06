-- =====================================================================
-- 約定價成交(例行叫貨略過報價)
--
-- 一般流程:供應商接單 → 報價 → 餐廳確認價格 → 出貨。老客戶每天叫一樣的貨、價格早就談好時,
-- 報價與確認只是多兩道手續。這支 migration 讓「供應商與餐廳老闆 / 店長雙方同意」的客戶可以略過:
--
--   1. supplier_standing_agreements:供應商「提議」→ 餐廳老闆 / 店長「同意」才生效(status proposed → active)。
--      任一方隨時可以刪掉(停用),停用後回到一般流程。供應商不能自己把提議改成生效。
--   2. standing_order_total(order_id):用「客戶專屬價 > 群組價 > 商品定價」算出整張單的金額;
--      只要有一個品項對不到(或對到好幾個)上架中的商品、沒有價格、數量不是大於 0 的純數字,就回 NULL = 不能走約定價。
--   3. standing_accept_order(order_id):供應商按「接單並依約定價成交」時,同一個交易裡寫三筆事件:
--      接單(供應商本人)→ 報價(系統,金額由資料庫算)→ 成交(系統)。訂單直接進「待出貨」。
--      報價與成交事件用「系統」身分、來源 system,payload 帶 standing_price = true,履歷看得出是約定價成交。
--   4. guard_order_transition():20260929110000 的版本 + 一個交易內的旗標 ifm.standing_auto(值 = 訂單 id),
--      只讓「系統」身分的 quoted / confirmed 事件在這個旗標下通過;其他規則(轉移表、狀態過期檢查…)原封不動。
--      轉移表 order_transition_rules() 沒有改(仍是 105 條):系統的轉移本來就涵蓋 accepted→quoted、quoted→confirmed。
--   5. trg_guard_standing_auto_event:任何帶 standing_price 的事件,都要重新驗:系統身分、旗標對得上、協議生效且仍綁定、
--      金額 = standing_order_total 現算的結果 —— 就算有人繞過 standing_accept_order 也寫不進亂報的金額。
--   6. notify_order_event():20260929110000 的版本 + 約定價的「報價」事件不寄「請確認報價」信給餐廳。
--
-- 不動:訂單狀態、轉移表、RLS 之外的既有表。價格只是成本資訊,協議表不含價格。
-- 還原:supabase/rollbacks/20261107100000_standing_price_orders.down.sql
-- 測試:supabase/tests/standing_price_orders.test.ts
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 約定價協議
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_standing_agreements (
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active')),
  proposed_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agreed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  agreed_at     TIMESTAMPTZ,
  PRIMARY KEY (supplier_id, restaurant_id),
  CHECK ((status = 'active') = (agreed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_standing_agreements_restaurant ON public.supplier_standing_agreements (restaurant_id);

-- 提議只能是 proposed、而且對象是已經綁定你的客戶;同意只能是 proposed → active,同意人與時間由伺服器填
CREATE OR REPLACE FUNCTION public.guard_standing_agreement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.agreed_by IS NOT NULL OR NEW.agreed_at IS NOT NULL THEN
      RAISE EXCEPTION '新的約定價只能先「提議」,要餐廳老闆或店長同意才會生效'
        USING ERRCODE = '42501', HINT = 'standing_must_be_proposed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.restaurant_suppliers rs
                    WHERE rs.restaurant_id = NEW.restaurant_id AND rs.supplier_id = NEW.supplier_id) THEN
      RAISE EXCEPTION '這家餐廳還沒有綁定你,不能提議約定價成交'
        USING ERRCODE = '42501', HINT = 'customer_not_bound';
    END IF;
    NEW.proposed_by := auth.uid();
    RETURN NEW;
  END IF;

  IF OLD.supplier_id <> NEW.supplier_id OR OLD.restaurant_id <> NEW.restaurant_id
     OR OLD.status <> 'proposed' OR NEW.status <> 'active' THEN
    RAISE EXCEPTION '約定價只能從「提議」改成「同意」'
      USING ERRCODE = '42501', HINT = 'standing_transition_not_allowed';
  END IF;
  NEW.proposed_by := OLD.proposed_by;
  NEW.created_at := OLD.created_at;
  NEW.agreed_by := auth.uid();
  NEW.agreed_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_standing_agreement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_standing_agreement ON public.supplier_standing_agreements;
CREATE TRIGGER trg_guard_standing_agreement
BEFORE INSERT OR UPDATE ON public.supplier_standing_agreements
FOR EACH ROW EXECUTE FUNCTION public.guard_standing_agreement();

ALTER TABLE public.supplier_standing_agreements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.supplier_standing_agreements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.supplier_standing_agreements TO authenticated;
GRANT UPDATE (status) ON TABLE public.supplier_standing_agreements TO authenticated;

DROP POLICY IF EXISTS "standing supplier read" ON public.supplier_standing_agreements;
CREATE POLICY "standing supplier read" ON public.supplier_standing_agreements FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()));
DROP POLICY IF EXISTS "standing supplier propose" ON public.supplier_standing_agreements;
CREATE POLICY "standing supplier propose" ON public.supplier_standing_agreements FOR INSERT TO authenticated
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()) AND status = 'proposed');
DROP POLICY IF EXISTS "standing supplier revoke" ON public.supplier_standing_agreements;
CREATE POLICY "standing supplier revoke" ON public.supplier_standing_agreements FOR DELETE TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()));

-- 餐廳:所有成員看得到「有沒有約定價」(不含價格);只有老闆 / 店長能同意、停用
DROP POLICY IF EXISTS "standing restaurant read" ON public.supplier_standing_agreements;
CREATE POLICY "standing restaurant read" ON public.supplier_standing_agreements FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.current_restaurant_ids()) OR public.is_admin());
DROP POLICY IF EXISTS "standing restaurant agree" ON public.supplier_standing_agreements;
CREATE POLICY "standing restaurant agree" ON public.supplier_standing_agreements FOR UPDATE TO authenticated
  USING (public.restaurant_role(restaurant_id) IN ('owner', 'manager') AND status = 'proposed')
  WITH CHECK (public.restaurant_role(restaurant_id) IN ('owner', 'manager') AND status = 'active');
DROP POLICY IF EXISTS "standing restaurant revoke" ON public.supplier_standing_agreements;
CREATE POLICY "standing restaurant revoke" ON public.supplier_standing_agreements FOR DELETE TO authenticated
  USING (public.restaurant_role(restaurant_id) IN ('owner', 'manager'));

-- ---------------------------------------------------------------------
-- 2. 約定價是否有效、整張單的約定價金額
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.standing_active(p_supplier uuid, p_restaurant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.supplier_standing_agreements a
      JOIN public.restaurant_suppliers rs ON rs.supplier_id = a.supplier_id AND rs.restaurant_id = a.restaurant_id
      JOIN public.suppliers s ON s.id = a.supplier_id AND s.is_active
     WHERE a.supplier_id = p_supplier AND a.restaurant_id = p_restaurant AND a.status = 'active')
$$;

CREATE OR REPLACE FUNCTION public.standing_order_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_restaurant uuid;
  v_supplier   uuid;
  v_items      jsonb;
  v_group      uuid;
  v_item       jsonb;
  v_qty        numeric;
  v_matches    int;
  v_supply     uuid;
  v_list       numeric;
  v_price      numeric;
  v_total      numeric := 0;
BEGIN
  SELECT o.restaurant_id, o.supplier_id, o.ingredient_list INTO v_restaurant, v_supplier, v_items
    FROM public.supplier_orders o WHERE o.id = p_order_id;
  IF NOT FOUND OR v_restaurant IS NULL OR v_supplier IS NULL
     OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT m.group_id INTO v_group FROM public.supplier_customer_group_members m
   WHERE m.supplier_id = v_supplier AND m.restaurant_id = v_restaurant;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_items) AS e(value) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR (v_item->>'quantity') IS NULL
       OR (v_item->>'quantity') !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN NULL;
    END IF;
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 OR public.norm_item_name(v_item->>'name') = '' THEN
      RETURN NULL;
    END IF;

    -- 品名要剛好對到一個上架中的商品(對到好幾個 = 不知道是哪一個,不自動成交)
    SELECT count(*), (array_agg(s.id))[1], (array_agg(s.price))[1]
      INTO v_matches, v_supply, v_list
      FROM public.supplies s
     WHERE s.supplier_id = v_supplier AND s.is_available
       AND public.norm_item_name(s.name) = public.norm_item_name(v_item->>'name');
    IF v_matches <> 1 THEN
      RETURN NULL;
    END IF;

    v_price := NULL;
    SELECT p.price INTO v_price FROM public.supplier_customer_prices p
     WHERE p.restaurant_id = v_restaurant AND p.supply_id = v_supply;
    IF v_price IS NULL AND v_group IS NOT NULL THEN
      SELECT gp.price INTO v_price FROM public.supplier_group_prices gp
       WHERE gp.group_id = v_group AND gp.supply_id = v_supply;
    END IF;
    IF v_price IS NULL AND v_list IS NOT NULL AND v_list > 0 THEN
      v_price := v_list;
    END IF;
    IF v_price IS NULL THEN
      RETURN NULL;
    END IF;
    v_total := v_total + v_price * v_qty;
  END LOOP;

  v_total := round(v_total, 2);
  IF v_total <= 0 OR v_total > 99999999 THEN
    RETURN NULL;
  END IF;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.standing_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.standing_order_total(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. 事件守門:20260929110000 的 guard_order_transition + 約定價旗標
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_order_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
DECLARE
  v_status        text;
  v_restaurant    uuid;
  v_supplier      uuid;
  v_uid           uuid := auth.uid();
  v_is_system     boolean;
  v_actor         text;
  v_actor_label   text;
  v_target        uuid;
  v_amount        numeric;
  v_lock_supplier uuid;
  -- 約定價成交(standing_accept_order)暫時設的旗標:值 = 這張訂單的 id,只讓「系統」身分的報價 / 成交事件通過
  v_standing      boolean := COALESCE(current_setting('ifm.standing_auto', true), '') = NEW.order_id::text;
BEGIN
  -- 會用到 suppliers 外鍵的轉移(派單寫 supplier_id、出貨新增 supplier_shipments):先鎖供應商、再鎖訂單,
  -- 跟「刪供應商 → ON DELETE SET NULL 改訂單」同一個順序,兩邊不會互等
  IF NEW.to_status = 'dispatched' AND NULLIF(NEW.payload->>'supplier_id', '') IS NOT NULL THEN
    BEGIN
      v_lock_supplier := (NEW.payload->>'supplier_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lock_supplier := NULL;  -- 格式錯誤:下面會回「找不到要派單的供應商」
    END;
  ELSIF NEW.to_status = 'shipped' THEN
    SELECT o.supplier_id INTO v_lock_supplier FROM public.supplier_orders o WHERE o.id = NEW.order_id;
  END IF;
  IF v_lock_supplier IS NOT NULL THEN
    PERFORM 1 FROM public.suppliers s WHERE s.id = v_lock_supplier FOR KEY SHARE;
  END IF;

  -- 鎖住訂單這一列(apply_order_event 稍後的 UPDATE 本來就要拿同一種鎖),同一張單的並發事件在這裡排隊
  SELECT o.status, o.restaurant_id, o.supplier_id
    INTO v_status, v_restaurant, v_supplier
    FROM public.supplier_orders o
   WHERE o.id = NEW.order_id
     FOR NO KEY UPDATE;

  -- 訂單不存在:交給外鍵去報錯
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_is_system := (v_uid IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role')
              OR (v_standing AND NEW.actor_role = 'system' AND NEW.to_status IN ('quoted', 'confirmed'));

  -- 執行者由伺服器決定,前端送來的 actor_id 不採信;事件時間也一樣(系統身分可以補登歷史時間)
  NEW.actor_id := v_uid;
  IF NOT v_is_system THEN
    NEW.created_at := now();
  END IF;

  -- 身分必須名副其實
  IF NEW.actor_role = 'system' THEN
    IF NOT v_is_system THEN
      RAISE EXCEPTION '只有系統排程可以用「系統」身分寫訂單事件'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'system';
  ELSIF NEW.actor_role = 'admin' THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION '只有平台管理員可以用「管理員」身分操作訂單'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'admin';
  ELSIF NEW.actor_role = 'restaurant' THEN
    v_actor := CASE WHEN v_uid IS NULL THEN NULL ELSE public.restaurant_role(v_restaurant) END;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION '你不是這家餐廳的成員(或邀請還沒接受),不能操作這張訂單'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
  ELSIF NEW.actor_role = 'supplier' THEN
    IF v_uid IS NULL OR v_supplier IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.supplier_accounts a
          WHERE a.user_id = v_uid AND a.is_active AND a.supplier_id = v_supplier) THEN
      RAISE EXCEPTION '這張訂單不是派給你的供應商,不能操作'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'supplier';
  ELSE
    -- actor_role 的 CHECK 會擋,這裡只是保險
    RAISE EXCEPTION '不認得的身分:%', NEW.actor_role USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
  END IF;

  -- 履歷上顯示的「誰」與「從哪個介面」也由伺服器決定(系統身分照填,給排程/串接標示來源)
  IF NOT v_is_system THEN
    NEW.actor_label := NULLIF(auth.jwt()->>'email', '');
    NEW.source := CASE v_actor
      WHEN 'supplier' THEN 'supplier_portal'
      WHEN 'admin' THEN 'admin_portal'
      ELSE 'restaurant_portal' END;
  END IF;

  -- 畫面過期:前端以為的狀態跟資料庫不一樣
  IF NEW.from_status IS NOT NULL AND NEW.from_status IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION '這張訂單的狀態已經變成「%」,畫面上的資料過期了,請重新整理後再操作',
        public.order_status_label(v_status)
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;
  NEW.from_status := v_status;

  IF NOT EXISTS (
       SELECT 1 FROM public.order_transition_rules() r
        WHERE r.actor = v_actor AND r.from_status = v_status AND r.to_status = NEW.to_status) THEN
    v_actor_label := CASE v_actor
      WHEN 'owner' THEN '餐廳老闆' WHEN 'manager' THEN '餐廳店長' WHEN 'purchaser' THEN '餐廳採購員'
      WHEN 'supplier' THEN '供應商' WHEN 'admin' THEN '平台管理員' ELSE '系統' END;
    RAISE EXCEPTION '%不能把訂單從「%」改成「%」',
        v_actor_label, public.order_status_label(v_status), public.order_status_label(NEW.to_status)
      USING ERRCODE = '42501', HINT = 'transition_not_allowed';
  END IF;

  -- 管理員取消進行中的單、餐廳退回重新報價:一定要寫原因(記在事件備註,履歷保留;通知信會帶給對方)
  IF v_actor = 'admin' AND NEW.to_status = 'cancelled'
     AND v_status IN ('dispatched', 'sent', 'accepted', 'quoted', 'confirmed', 'shipped', 'in_transit')
     AND NULLIF(btrim(COALESCE(NEW.note, '')), '') IS NULL THEN
    RAISE EXCEPTION '取消進行中的訂單要填寫原因' USING ERRCODE = '22023', HINT = 'cancel_reason_required';
  END IF;
  IF v_actor IN ('owner', 'manager') AND v_status = 'quoted' AND NEW.to_status = 'accepted'
     AND NULLIF(btrim(COALESCE(NEW.note, '')), '') IS NULL THEN
    RAISE EXCEPTION '退回重新報價要填寫原因(會轉告供應商)' USING ERRCODE = '22023', HINT = 'requote_reason_required';
  END IF;

  -- 出貨:先鎖的是訂單「當時」的供應商;鎖完訂單發現已經換了(管理員剛改過),當成畫面過期
  IF NEW.to_status = 'shipped' AND v_supplier IS DISTINCT FROM v_lock_supplier THEN
    RAISE EXCEPTION '這張訂單的供應商剛剛變更,畫面上的資料過期了,請重新整理後再操作'
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;

  -- 派單:指定的供應商必須存在(是否啟用由派單畫面篩選)
  IF NEW.to_status = 'dispatched' AND NEW.payload ? 'supplier_id' THEN
    BEGIN
      v_target := (NEW.payload->>'supplier_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_target := NULL;
    END;
    IF v_target IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = v_target) THEN
      RAISE EXCEPTION '找不到要派單的供應商' USING ERRCODE = '22023', HINT = 'invalid_supplier';
    END IF;
  END IF;

  -- 報價:一定要有大於 0 的金額;統一存成 payload.total_amount(20260929100100 會同步到訂單)
  IF NEW.to_status = 'quoted' THEN
    BEGIN
      v_amount := COALESCE(NEW.payload->>'total_amount', NEW.payload->>'amount')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_amount := NULL;
    END;
    IF v_amount IS NULL OR NOT (v_amount > 0 AND v_amount <= 99999999) THEN
      RAISE EXCEPTION '報價金額要是大於 0 的數字' USING ERRCODE = '22023', HINT = 'invalid_quote_amount';
    END IF;
    NEW.payload := NEW.payload || jsonb_build_object('total_amount', round(v_amount, 2));

    IF NULLIF(NEW.payload->>'valid_until', '') IS NOT NULL THEN
      BEGIN
        PERFORM (NEW.payload->>'valid_until')::date;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION '報價有效日期格式不對(要是 YYYY-MM-DD)'
          USING ERRCODE = '22023', HINT = 'invalid_valid_until';
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 帶 standing_price 的事件一律重驗(不信呼叫者):系統身分、旗標對得上、協議生效且仍綁定、金額 = 現算的約定價金額。
-- 名字排在 trg_guard_order_transition 之後(同一時機的 trigger 依名稱字母序執行,先讓它改好 payload)
CREATE OR REPLACE FUNCTION public.guard_standing_auto_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_supplier   uuid;
  v_restaurant uuid;
  v_total      numeric;
BEGIN
  IF COALESCE(NEW.payload->>'standing_price', '') <> 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.actor_role <> 'system' OR NEW.to_status NOT IN ('quoted', 'confirmed')
     OR COALESCE(current_setting('ifm.standing_auto', true), '') <> NEW.order_id::text THEN
    RAISE EXCEPTION '約定價成交只能由系統在「接單並依約定價成交」時寫入'
      USING ERRCODE = '42501', HINT = 'standing_event_not_allowed';
  END IF;

  SELECT o.supplier_id, o.restaurant_id INTO v_supplier, v_restaurant
    FROM public.supplier_orders o WHERE o.id = NEW.order_id;
  IF NOT public.standing_active(v_supplier, v_restaurant) THEN
    RAISE EXCEPTION '這家客戶沒有生效的約定價,不能依約定價成交'
      USING ERRCODE = '42501', HINT = 'standing_not_active';
  END IF;

  v_total := public.standing_order_total(NEW.order_id);
  IF v_total IS NULL THEN
    RAISE EXCEPTION '這張單有品項算不出約定價,請照一般流程報價'
      USING ERRCODE = '22023', HINT = 'standing_price_unavailable';
  END IF;
  IF NEW.to_status = 'quoted' AND (NEW.payload->>'total_amount')::numeric IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION '約定價成交的金額必須是依約定價算出來的 %', v_total
      USING ERRCODE = '22023', HINT = 'standing_amount_mismatch';
  END IF;
  IF NEW.to_status = 'confirmed' AND NOT EXISTS (
       SELECT 1 FROM public.supplier_orders o WHERE o.id = NEW.order_id AND o.total_amount = v_total) THEN
    RAISE EXCEPTION '訂單金額跟約定價算出來的不一致,不能成交'
      USING ERRCODE = '22023', HINT = 'standing_amount_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_standing_auto_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_standing_auto_event ON public.order_events;
CREATE TRIGGER trg_guard_standing_auto_event
BEFORE INSERT ON public.order_events
FOR EACH ROW EXECUTE FUNCTION public.guard_standing_auto_event();

-- ---------------------------------------------------------------------
-- 4. 供應商「接單並依約定價成交」:同一個交易裡接單 → 報價 → 成交
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.standing_accept_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_status     text;
  v_supplier   uuid;
  v_restaurant uuid;
  v_total      numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '請先登入' USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
  END IF;

  SELECT o.status, o.supplier_id, o.restaurant_id INTO v_status, v_supplier, v_restaurant
    FROM public.supplier_orders o WHERE o.id = p_order_id
     FOR NO KEY UPDATE;
  IF NOT FOUND OR v_supplier IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.supplier_accounts a
        WHERE a.user_id = v_uid AND a.is_active AND a.supplier_id = v_supplier) THEN
    RAISE EXCEPTION '這張訂單不是派給你的供應商,不能操作'
      USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
  END IF;
  IF v_status <> 'dispatched' THEN
    RAISE EXCEPTION '這張訂單的狀態已經變成「%」,畫面上的資料過期了,請重新整理後再操作', public.order_status_label(v_status)
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;
  IF v_restaurant IS NULL OR NOT public.standing_active(v_supplier, v_restaurant) THEN
    RAISE EXCEPTION '這家客戶沒有生效的約定價,請照一般流程接單報價'
      USING ERRCODE = '42501', HINT = 'standing_not_active';
  END IF;
  v_total := public.standing_order_total(p_order_id);
  IF v_total IS NULL THEN
    RAISE EXCEPTION '這張單有品項沒有可用的價格(或數量不是純數字、商品對不到),請照一般流程報價'
      USING ERRCODE = '22023', HINT = 'standing_price_unavailable';
  END IF;

  INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note)
  VALUES (p_order_id, 'dispatched', 'accepted', 'supplier', 'supplier_portal', '{}'::jsonb, '接單(依約定價成交)');

  PERFORM set_config('ifm.standing_auto', p_order_id::text, true);
  -- created_at 用 clock_timestamp():同一個交易裡的三筆事件在履歷上要有先後(now() 在交易內是同一個時間)
  INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, actor_label, source, payload, note, created_at)
  VALUES (p_order_id, 'accepted', 'quoted', 'system', '約定價成交', 'system',
          jsonb_build_object('standing_price', true, 'total_amount', v_total), '依約定價自動報價', clock_timestamp());
  INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, actor_label, source, payload, note, created_at)
  VALUES (p_order_id, 'quoted', 'confirmed', 'system', '約定價成交', 'system',
          jsonb_build_object('standing_price', true), '依約定價成交(餐廳已同意約定價)', clock_timestamp());
  PERFORM set_config('ifm.standing_auto', '', true);

  RETURN jsonb_build_object('status', 'confirmed', 'total_amount', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.standing_accept_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.standing_accept_order(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. 通知:約定價的「報價」不寄「請確認報價」
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_order_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'extensions'
AS $function$
DECLARE
  v_url  TEXT;
  v_key  TEXT;
BEGIN
  SELECT value INTO v_url FROM public.app_config WHERE key = 'notify_function_url';
  SELECT value INTO v_key FROM public.app_config WHERE key = 'notify_service_key';

  -- 沒設定就安靜跳過 —— 不要因為通知沒接好就讓下單失敗
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- 約定價成交:報價與成交是同一個交易裡系統代為完成的,不寄「請確認報價」給餐廳
  IF NEW.to_status = 'quoted' AND NEW.payload->>'standing_price' = 'true' THEN
    RETURN NEW;
  END IF;

  -- pg_net 不管 WITH SCHEMA 寫什麼,函式一律建在 net schema
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object(
                 'order_id',    NEW.order_id,
                 'to_status',   NEW.to_status,
                 -- 20260929110000 起多帶這三個:notify 分辨「退回重新報價」「誰取消的」,並用 event_id 讀原因
                 'from_status', NEW.from_status,
                 'actor_role',  NEW.actor_role,
                 'event_id',    NEW.id
               ),
    timeout_milliseconds := 8000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 通知出任何問題都不能影響訂單流程
  RAISE WARNING 'notify_order_event failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_order_transition() FROM PUBLIC, anon, authenticated;
