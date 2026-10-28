-- =====================================================================
-- 客戶專屬價格與數量限制(2026-10-29,參考 OrderUp B2B 的批發叫貨流程)
--
-- 1. 價格有三層,由上往下第一個有的就是這家客戶的單價:
--      客戶專屬價(supplier_customer_prices)> 群組價(supplier_group_prices)> 商品定價(supplies.price)
--    - supplier_customer_prices:供應商替「某一家客戶」對「某個商品」設專屬價格(個別例外用)。
--    - supplier_customer_groups / supplier_customer_group_members / supplier_group_prices:供應商自己建客戶群組
--      (例如「連鎖店」「小吃攤」),把客戶加進群組,替整個群組對每個商品設一個價格 —— 同一群組的客戶同一個價格。
--      有 100 家客戶也不用一家一家設價:一家客戶在同一家供應商底下最多屬於一個群組。
--    供應商管理自己的;餐廳只有老闆 / 店長讀得到自己的價格(專屬價與所屬群組的群組價),採購員看不到成本;
--    而且只有「還綁定著」這家供應商的餐廳讀得到(解除綁定就看不到了);管理員可讀。
--    價格只是「下單時自動帶入、供應商報價時預填」,真正的報價金額仍由供應商報價決定(訂單狀態流程沒有動)。
-- 2. supplier_customer_limits:供應商替「每家客戶」對「每個商品」設每日 / 每週的叫貨上限(缺貨時控管)。
--    供應商管理自己的;餐廳所有成員都看得到自己的(叫貨時要看得到剩多少)。
-- 3. guard_restaurant_direct_dispatch 再加一個檢查(20261029100000 的版本 + 數量上限):
--    餐廳直接叫貨時,這張單裡「品名對得上有設上限的商品」的數量,加上同一家店、同一家供應商、同一期(同一天 / 同一週,
--    依配送日;沒有配送日的單用建立日)其他有效訂單的數量,不能超過上限。品名比對不分大小寫、空白(全形半形空白都算)。
--    品名對不上商品目錄的品項不受限(上限只管目錄裡的商品)。同一家店向同一家供應商同時叫貨時用 advisory lock 排隊,
--    避免兩張單同時各自通過、合起來超量。管理員 / 系統派單不受影響。
--
-- 還原:supabase/rollbacks/20261029110000_customer_prices_and_limits.down.sql
-- 測試:supabase/tests/customer_prices_and_limits.test.ts(PGlite 重放真正的訂單狀態機 migration + 前兩支再套這一支)
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 品名比對 helper
-- ---------------------------------------------------------------------
-- 去掉所有空白(含全形空白 U+3000)並轉小寫:「高麗菜 」「高 麗 菜」「ＡＢ」「ab」視為同一個(前端 normalizeItemName 另外做 NFKC)
CREATE OR REPLACE FUNCTION public.norm_item_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(regexp_replace(COALESCE(p_name, ''), '[[:space:]　]+', '', 'g'))
$$;

-- 一張單的品項裡,品名(正規化後)等於 p_key 的所有數量加總;數量不是純數字的品項略過
CREATE OR REPLACE FUNCTION public.order_item_qty(p_items jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(sum((e.value->>'quantity')::numeric), 0)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) AS e(value)
   WHERE jsonb_typeof(e.value) = 'object'
     AND public.norm_item_name(e.value->>'name') = p_key
     AND (e.value->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
$$;

-- 數量顯示:整數不帶小數點(100、不是 100.00),有小數的去掉尾端的 0(3.5)
CREATE OR REPLACE FUNCTION public.fmt_qty(p_qty numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_qty = trunc(p_qty) THEN trunc(p_qty)::text ELSE rtrim(p_qty::text, '0') END
$$;

REVOKE ALL ON FUNCTION public.fmt_qty(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.norm_item_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_item_qty(jsonb, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. 客戶專屬價格
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_customer_prices (
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supply_id     UUID NOT NULL REFERENCES public.supplies(id)    ON DELETE CASCADE,
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  price         NUMERIC(12, 2) NOT NULL CHECK (price > 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, supply_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_prices_supplier ON public.supplier_customer_prices (supplier_id);

-- 商品一定要是這家供應商自己的(不然可以替別家的商品設價)
CREATE OR REPLACE FUNCTION public.guard_customer_rule_supply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.supplies s WHERE s.id = NEW.supply_id AND s.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '這個商品不是這家供應商的'
      USING ERRCODE = '42501', HINT = 'supply_not_owned';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_customer_rule_supply() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_customer_price_supply ON public.supplier_customer_prices;
CREATE TRIGGER trg_guard_customer_price_supply
BEFORE INSERT OR UPDATE ON public.supplier_customer_prices
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_rule_supply();

ALTER TABLE public.supplier_customer_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.supplier_customer_prices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_customer_prices TO authenticated;

DROP POLICY IF EXISTS "customer prices supplier manage" ON public.supplier_customer_prices;
CREATE POLICY "customer prices supplier manage" ON public.supplier_customer_prices FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

-- 餐廳:只有老闆 / 店長看得到自己的價格(採購員看不到成本)
DROP POLICY IF EXISTS "customer prices restaurant read" ON public.supplier_customer_prices;
CREATE POLICY "customer prices restaurant read" ON public.supplier_customer_prices FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      public.restaurant_role(restaurant_id) IN ('owner', 'manager')
      AND EXISTS (SELECT 1 FROM public.restaurant_suppliers rs
                   WHERE rs.restaurant_id = supplier_customer_prices.restaurant_id
                     AND rs.supplier_id = supplier_customer_prices.supplier_id)
    )
  );

-- ---------------------------------------------------------------------
-- 2b. 客戶群組與群組價格
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_customer_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, supplier_id),
  UNIQUE (supplier_id, name)
);

-- 一家客戶在同一家供應商底下最多屬於一個群組(主鍵 = 供應商 + 客戶);群組刪掉,成員跟著刪
CREATE TABLE IF NOT EXISTS public.supplier_customer_group_members (
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  group_id      UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, restaurant_id),
  FOREIGN KEY (group_id, supplier_id) REFERENCES public.supplier_customer_groups (id, supplier_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON public.supplier_customer_group_members (group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_restaurant ON public.supplier_customer_group_members (restaurant_id);

CREATE TABLE IF NOT EXISTS public.supplier_group_prices (
  group_id    UUID NOT NULL,
  supply_id   UUID NOT NULL REFERENCES public.supplies(id)  ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  price       NUMERIC(12, 2) NOT NULL CHECK (price > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, supply_id),
  FOREIGN KEY (group_id, supplier_id) REFERENCES public.supplier_customer_groups (id, supplier_id) ON DELETE CASCADE
);

-- 只能把「已經綁定你的客戶」放進群組(不能拿別人的餐廳 id 亂加)
CREATE OR REPLACE FUNCTION public.guard_group_member_bound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.restaurant_suppliers rs
                  WHERE rs.restaurant_id = NEW.restaurant_id AND rs.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '這家餐廳還沒有綁定你,不能加進群組'
      USING ERRCODE = '42501', HINT = 'customer_not_bound';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_group_member_bound() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_group_member_bound ON public.supplier_customer_group_members;
CREATE TRIGGER trg_guard_group_member_bound
BEFORE INSERT OR UPDATE ON public.supplier_customer_group_members
FOR EACH ROW EXECUTE FUNCTION public.guard_group_member_bound();

DROP TRIGGER IF EXISTS trg_guard_group_price_supply ON public.supplier_group_prices;
CREATE TRIGGER trg_guard_group_price_supply
BEFORE INSERT OR UPDATE ON public.supplier_group_prices
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_rule_supply();

ALTER TABLE public.supplier_customer_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_customer_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_group_prices           ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.supplier_customer_groups        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.supplier_customer_group_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.supplier_group_prices           FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_customer_groups        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_customer_group_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_group_prices           TO authenticated;

-- 群組:只有供應商自己(與管理員)看得到;餐廳不需要知道群組的名字
DROP POLICY IF EXISTS "customer groups supplier manage" ON public.supplier_customer_groups;
CREATE POLICY "customer groups supplier manage" ON public.supplier_customer_groups FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));
DROP POLICY IF EXISTS "customer groups admin read" ON public.supplier_customer_groups;
CREATE POLICY "customer groups admin read" ON public.supplier_customer_groups FOR SELECT TO authenticated
  USING (public.is_admin());

-- 成員:供應商管理自己的;餐廳成員看得到自己店的那一列(叫貨頁要靠它找群組價)
DROP POLICY IF EXISTS "group members supplier manage" ON public.supplier_customer_group_members;
CREATE POLICY "group members supplier manage" ON public.supplier_customer_group_members FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));
DROP POLICY IF EXISTS "group members restaurant read" ON public.supplier_customer_group_members;
CREATE POLICY "group members restaurant read" ON public.supplier_customer_group_members FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.current_restaurant_ids()) OR public.is_admin());

-- 群組價:供應商管理自己的;餐廳只有老闆 / 店長、而且自己店屬於這個群組、還綁定著這家供應商才讀得到
DROP POLICY IF EXISTS "group prices supplier manage" ON public.supplier_group_prices;
CREATE POLICY "group prices supplier manage" ON public.supplier_group_prices FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));
DROP POLICY IF EXISTS "group prices restaurant read" ON public.supplier_group_prices;
CREATE POLICY "group prices restaurant read" ON public.supplier_group_prices FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
        FROM public.supplier_customer_group_members m
        JOIN public.restaurant_suppliers rs ON rs.restaurant_id = m.restaurant_id AND rs.supplier_id = m.supplier_id
       WHERE m.group_id = supplier_group_prices.group_id
         AND public.restaurant_role(m.restaurant_id) IN ('owner', 'manager'))
  );

-- ---------------------------------------------------------------------
-- 3. 客戶數量上限
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_customer_limits (
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  supply_id     UUID NOT NULL REFERENCES public.supplies(id)    ON DELETE CASCADE,
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE CASCADE,
  period        TEXT NOT NULL CHECK (period IN ('day', 'week')),
  max_qty       NUMERIC(12, 2) NOT NULL CHECK (max_qty > 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, supply_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_limits_supplier ON public.supplier_customer_limits (supplier_id);

DROP TRIGGER IF EXISTS trg_guard_customer_limit_supply ON public.supplier_customer_limits;
CREATE TRIGGER trg_guard_customer_limit_supply
BEFORE INSERT OR UPDATE ON public.supplier_customer_limits
FOR EACH ROW EXECUTE FUNCTION public.guard_customer_rule_supply();

ALTER TABLE public.supplier_customer_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.supplier_customer_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_customer_limits TO authenticated;

DROP POLICY IF EXISTS "customer limits supplier manage" ON public.supplier_customer_limits;
CREATE POLICY "customer limits supplier manage" ON public.supplier_customer_limits FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

-- 餐廳:所有成員都看得到自己店的上限(叫貨時要知道剩多少)
DROP POLICY IF EXISTS "customer limits restaurant read" ON public.supplier_customer_limits;
CREATE POLICY "customer limits restaurant read" ON public.supplier_customer_limits FOR SELECT TO authenticated
  USING (restaurant_id IN (SELECT public.current_restaurant_ids()) OR public.is_admin());

-- ---------------------------------------------------------------------
-- 4. 直接叫貨的檢查:20261029100000 的版本 + 每日 / 每週數量上限
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
  v_items      jsonb;
  v_set        public.supplier_order_settings%ROWTYPE;
  v_lim        record;
  v_now_tw     timestamp := (now() AT TIME ZONE 'Asia/Taipei');
  v_day        date;
  v_from       date;
  v_to         date;
  v_this       numeric;
  v_used       numeric;
BEGIN
  -- 只管「餐廳身分」寫的 → dispatched(管理員 / 系統派單走自己的規則)。
  -- actor_role 的真假由 trg_guard_order_transition 檢查(名字排在這支前面,先跑)
  IF NEW.to_status IS DISTINCT FROM 'dispatched' OR NEW.actor_role IS DISTINCT FROM 'restaurant' THEN
    RETURN NEW;
  END IF;

  SELECT o.restaurant_id, o.delivery_date, o.ingredient_list INTO v_restaurant, v_delivery, v_items
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

  -- 每日 / 每週數量上限:同一家店向同一家供應商同時叫貨要排隊,不然兩張單各自通過、合起來超量
  IF EXISTS (SELECT 1 FROM public.supplier_customer_limits l WHERE l.restaurant_id = v_restaurant AND l.supplier_id = v_target) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('order-limits:' || v_restaurant::text || ':' || v_target::text, 0));
    v_day := COALESCE(v_delivery, v_now_tw::date);

    FOR v_lim IN
      SELECT l.period, l.max_qty, s.name
        FROM public.supplier_customer_limits l
        JOIN public.supplies s ON s.id = l.supply_id
       WHERE l.restaurant_id = v_restaurant AND l.supplier_id = v_target
       ORDER BY s.name
    LOOP
      v_this := public.order_item_qty(v_items, public.norm_item_name(v_lim.name));
      CONTINUE WHEN v_this = 0;

      IF v_lim.period = 'week' THEN
        v_from := date_trunc('week', v_day)::date;
        v_to   := v_from + 6;
      ELSE
        v_from := v_day;
        v_to   := v_day;
      END IF;

      SELECT COALESCE(sum(public.order_item_qty(o.ingredient_list, public.norm_item_name(v_lim.name))), 0) INTO v_used
        FROM public.supplier_orders o
       WHERE o.restaurant_id = v_restaurant
         AND o.supplier_id = v_target
         AND o.id <> NEW.order_id
         AND o.status NOT IN ('draft', 'cancelled', 'rejected', 'expired')
         AND COALESCE(o.delivery_date, (o.created_at AT TIME ZONE 'Asia/Taipei')::date) BETWEEN v_from AND v_to;

      IF v_used + v_this > v_lim.max_qty THEN
        RAISE EXCEPTION '「%」%上限 %,這段時間已經叫了 %,這張單 %,最多還能叫 %',
            v_lim.name,
            CASE v_lim.period WHEN 'week' THEN '每週' ELSE '每日' END,
            public.fmt_qty(v_lim.max_qty),
            public.fmt_qty(v_used),
            public.fmt_qty(v_this),
            public.fmt_qty(greatest(v_lim.max_qty - v_used, 0))
          USING ERRCODE = '22023', HINT = 'order_limit_exceeded';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_restaurant_direct_dispatch() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_restaurant_direct_dispatch() IS
  '餐廳身分寫 → dispatched 的訂單事件:供應商必須是這家店已綁定、還在營業的;配送日不能是過去;供應商有設接單規則時要選配送日、那天有配送、還沒過截單時間;客戶數量上限(每日 / 每週)不能超過。';

NOTIFY pgrst, 'reload schema';
