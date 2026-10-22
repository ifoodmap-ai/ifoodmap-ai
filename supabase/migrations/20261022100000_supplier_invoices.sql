-- =====================================================================
-- 供應商請款單(2026-10-22 業主需求):供應商可依帳期向餐廳請款,餐廳端看得到並確認
--
-- 做法:一張請款單包含 1 張或多張「已收貨」的訂單。單單結、日結、月結、自訂區間都是同一套資料,
--   差別只在供應商開單時選的區間與要放哪幾張單 —— 平台只做記錄與通知,不經手金流。
--
-- 兩張表:
--   supplier_invoices        請款單本身(單號、供應商、餐廳、帳期種類與區間、付款天數、到期日、金額、狀態)
--   supplier_invoice_orders  請款單包含哪些訂單。order_id 唯一 —— 一張訂單同一時間最多在一張請款單裡;
--                            請款單作廢時這幾筆會刪掉,訂單就能重新請款(請款單上的 lines 快照保留歷史)
--
-- 狀態:issued 待確認 → confirmed 餐廳已確認 / disputed 餐廳有異議 → paid 已收款;void 作廢。
--   「逾期」不存欄位:到期日 < 今天 且 還沒 paid / void,畫面上現算。
--
-- 寫入一律走 4 支 RPC(SECURITY DEFINER,函式裡自己檢查身分與狀態),資料表不開放直接寫入:
--   supplier_create_invoice      供應商開請款單(檢查:是這家供應商的人、單都屬於這家供應商與這家餐廳、
--                                單都已收貨且有金額、沒有被別張請款單占用;金額由資料庫從訂單加總,不信前端)
--   supplier_mark_invoice_paid   供應商標記已收款
--   supplier_void_invoice        供應商作廢(已收款不能作廢),訂單釋放
--   restaurant_respond_invoice   餐廳老闆/店長確認或提出異議(採購員看不到金額,也不能回應)
--
-- 「已收貨」的判斷與 src/lib/metrics.ts 同一套(全站成交定義):
--   received / reviewed / completed 一定算;closed 要有進過 received / reviewed 的訂單事件才算。
--
-- 讀取:供應商看自己的、餐廳老闆/店長看自己店的、admin 全看。
--
-- 還原:supabase/rollbacks/20261022100000_supplier_invoices.down.sql
-- 測試:supabase/tests/supplier_invoices.test.ts(用 PGlite 真的跑這份 SQL,含 RLS 與每支 RPC)
-- 注意:supplier_invoice_orders.order_id 對訂單是 ON DELETE RESTRICT —— 已經放進請款單的訂單不能被刪
--   (admin_delete_order 會被擋);要刪請先把請款單作廢。
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 資料表
-- ---------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.supplier_invoice_seq;

CREATE TABLE IF NOT EXISTS public.supplier_invoices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no    TEXT NOT NULL UNIQUE,
  supplier_id   UUID NOT NULL REFERENCES public.suppliers(id)   ON DELETE RESTRICT,
  restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE RESTRICT,
  -- daily 日結(區間是同一天)/ monthly 月結(整個月)/ custom 自訂區間
  period_kind   TEXT NOT NULL CHECK (period_kind IN ('daily', 'monthly', 'custom')),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  -- 付款天數:到期日 = 區間迄日 + 付款天數(0 = 當天到期,即貨到付款 / 現結)
  net_days      INTEGER NOT NULL DEFAULT 0 CHECK (net_days BETWEEN 0 AND 365),
  due_date      DATE NOT NULL,
  total_amount  NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
  status        TEXT NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued', 'confirmed', 'disputed', 'paid', 'void')),
  note          TEXT,
  -- 開單當下的訂單快照 [{order_id, order_no, ordered_at, amount}],作廢後仍保留
  lines         JSONB NOT NULL DEFAULT '[]'::jsonb,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by     UUID,
  confirmed_at  TIMESTAMPTZ,
  confirmed_by  UUID,
  disputed_at   TIMESTAMPTZ,
  dispute_note  TEXT,
  paid_at       TIMESTAMPTZ,
  paid_by       UUID,
  paid_note     TEXT,
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoices_period_order CHECK (period_end >= period_start),
  CONSTRAINT supplier_invoices_due_after_period CHECK (due_date >= period_end)
);

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier   ON public.supplier_invoices (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_restaurant ON public.supplier_invoices (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_open_due   ON public.supplier_invoices (due_date)
  WHERE status IN ('issued', 'confirmed', 'disputed');

CREATE TABLE IF NOT EXISTS public.supplier_invoice_orders (
  invoice_id UUID NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  order_id   UUID NOT NULL UNIQUE REFERENCES public.supplier_orders(id) ON DELETE RESTRICT,
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (invoice_id, order_id)
);

-- ---------------------------------------------------------------------
-- 2. RLS:只開讀取,寫入只走下面的 RPC
-- ---------------------------------------------------------------------

ALTER TABLE public.supplier_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_invoice_orders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.supplier_invoices       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.supplier_invoice_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.supplier_invoices       TO authenticated;
GRANT SELECT ON TABLE public.supplier_invoice_orders TO authenticated;

DROP POLICY IF EXISTS "invoices supplier read" ON public.supplier_invoices;
CREATE POLICY "invoices supplier read" ON public.supplier_invoices FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()));

-- 餐廳端只有老闆 / 店長看得到(有金額,採購員看不到成本)
DROP POLICY IF EXISTS "invoices restaurant read" ON public.supplier_invoices;
CREATE POLICY "invoices restaurant read" ON public.supplier_invoices FOR SELECT TO authenticated
  USING (public.restaurant_role(restaurant_id) IN ('owner', 'manager'));

DROP POLICY IF EXISTS "invoices admin read" ON public.supplier_invoices;
CREATE POLICY "invoices admin read" ON public.supplier_invoices FOR SELECT TO authenticated
  USING (public.is_admin());

-- 明細:看得到那張請款單就看得到它的明細(子查詢照呼叫者的 RLS 跑)
DROP POLICY IF EXISTS "invoice orders read" ON public.supplier_invoice_orders;
CREATE POLICY "invoice orders read" ON public.supplier_invoice_orders FOR SELECT TO authenticated
  USING (invoice_id IN (SELECT id FROM public.supplier_invoices));

-- ---------------------------------------------------------------------
-- 3. 供應商開請款單
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.supplier_create_invoice(
  p_supplier_id   uuid,
  p_restaurant_id uuid,
  p_period_kind   text,
  p_period_start  date,
  p_period_end    date,
  p_net_days      integer,
  p_order_ids     uuid[],
  p_note          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids     uuid[];
  v_n       integer;
  v_ok      integer;
  v_total   numeric(12, 2);
  v_lines   jsonb;
  v_id      uuid := gen_random_uuid();
  v_no      text;
BEGIN
  IF auth.uid() IS NULL OR NOT (p_supplier_id IN (SELECT public.current_supplier_ids())) THEN
    RAISE EXCEPTION 'not_a_member_of_this_supplier' USING ERRCODE = '42501';
  END IF;

  IF p_period_kind IS NULL OR p_period_kind NOT IN ('daily', 'monthly', 'custom') THEN
    RAISE EXCEPTION 'invalid_period_kind' USING ERRCODE = '22023';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  IF p_period_kind = 'daily' AND p_period_start <> p_period_end THEN
    RAISE EXCEPTION 'daily_period_must_be_one_day' USING ERRCODE = '22023';
  END IF;
  IF p_period_kind = 'monthly'
     AND (p_period_start <> date_trunc('month', p_period_start)::date
          OR p_period_end <> (date_trunc('month', p_period_start) + interval '1 month - 1 day')::date) THEN
    RAISE EXCEPTION 'monthly_period_must_be_a_whole_month' USING ERRCODE = '22023';
  END IF;
  IF p_net_days IS NULL OR p_net_days NOT BETWEEN 0 AND 365 THEN
    RAISE EXCEPTION 'invalid_net_days' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_ids FROM unnest(p_order_ids) AS t(x);
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invoice_needs_1_to_500_orders' USING ERRCODE = '22023';
  END IF;

  -- 先鎖訂單(固定順序,兩個人同時開單不會互等)
  PERFORM 1 FROM public.supplier_orders o WHERE o.id = ANY (v_ids) ORDER BY o.id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.supplier_invoice_orders io WHERE io.order_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'invoice_orders_already_invoiced' USING ERRCODE = '23505';
  END IF;

  -- 每一張都要:屬於這家供應商與這家餐廳、有金額、已收貨(定義同 src/lib/metrics.ts)
  SELECT count(*) INTO v_ok
    FROM public.supplier_orders o
   WHERE o.id = ANY (v_ids)
     AND o.supplier_id = p_supplier_id
     AND o.restaurant_id = p_restaurant_id
     AND COALESCE(o.total_amount, 0) > 0
     AND (
       o.status IN ('received', 'reviewed', 'completed')
       OR (o.status = 'closed' AND EXISTS (
             SELECT 1 FROM public.order_events e
              WHERE e.order_id = o.id AND e.to_status IN ('received', 'reviewed')))
     );
  IF v_ok <> v_n THEN
    RAISE EXCEPTION 'invoice_orders_not_eligible' USING ERRCODE = '22023';
  END IF;

  SELECT sum(o.total_amount),
         jsonb_agg(jsonb_build_object(
           'order_id', o.id,
           'order_no', '#' || upper(right(o.id::text, 8)),
           'ordered_at', o.created_at,
           'amount', o.total_amount) ORDER BY o.created_at, o.id)
    INTO v_total, v_lines
    FROM public.supplier_orders o
   WHERE o.id = ANY (v_ids);

  v_no := 'INV-' || to_char(timezone('Asia/Taipei', now()), 'YYYYMMDD') || '-'
          || lpad(nextval('public.supplier_invoice_seq')::text, 4, '0');

  INSERT INTO public.supplier_invoices (
    id, invoice_no, supplier_id, restaurant_id, period_kind, period_start, period_end,
    net_days, due_date, total_amount, note, lines, issued_by
  ) VALUES (
    v_id, v_no, p_supplier_id, p_restaurant_id, p_period_kind, p_period_start, p_period_end,
    p_net_days, p_period_end + p_net_days, v_total, NULLIF(btrim(p_note), ''), v_lines, auth.uid()
  );

  INSERT INTO public.supplier_invoice_orders (invoice_id, order_id, amount)
  SELECT v_id, o.id, o.total_amount FROM public.supplier_orders o WHERE o.id = ANY (v_ids);

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.supplier_create_invoice(uuid, uuid, text, date, date, integer, uuid[], text) IS
  '供應商開請款單:金額由資料庫從訂單加總;每張訂單要屬於這家供應商與餐廳、已收貨、有金額、沒被別張請款單占用。';

-- ---------------------------------------------------------------------
-- 4. 供應商標記已收款 / 作廢
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.supplier_mark_invoice_paid(
  p_invoice_id uuid,
  p_note       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.supplier_invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.supplier_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT (v_inv.supplier_id IN (SELECT public.current_supplier_ids())) THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.status NOT IN ('issued', 'confirmed', 'disputed') THEN
    RAISE EXCEPTION 'invoice_not_payable' USING ERRCODE = '22023';
  END IF;

  UPDATE public.supplier_invoices
     SET status = 'paid', paid_at = now(), paid_by = auth.uid(),
         paid_note = NULLIF(btrim(p_note), ''), updated_at = now()
   WHERE id = p_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.supplier_void_invoice(
  p_invoice_id uuid,
  p_reason     text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv    public.supplier_invoices%ROWTYPE;
  v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
  SELECT * INTO v_inv FROM public.supplier_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT (v_inv.supplier_id IN (SELECT public.current_supplier_ids())) THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.status NOT IN ('issued', 'confirmed', 'disputed') THEN
    RAISE EXCEPTION 'invoice_not_voidable' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'void_reason_required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.supplier_invoices
     SET status = 'void', voided_at = now(), void_reason = v_reason, updated_at = now()
   WHERE id = p_invoice_id;
  -- 釋放訂單,之後可以重新請款
  DELETE FROM public.supplier_invoice_orders WHERE invoice_id = p_invoice_id;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. 餐廳確認 / 提出異議
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.restaurant_respond_invoice(
  p_invoice_id uuid,
  p_action     text,
  p_note       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv  public.supplier_invoices%ROWTYPE;
  v_note text := NULLIF(btrim(p_note), '');
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('confirm', 'dispute') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inv FROM public.supplier_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR COALESCE(public.restaurant_role(v_inv.restaurant_id), '') NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_action = 'confirm' THEN
    IF v_inv.status NOT IN ('issued', 'disputed') THEN
      RAISE EXCEPTION 'invoice_not_confirmable' USING ERRCODE = '22023';
    END IF;
    UPDATE public.supplier_invoices
       SET status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(), updated_at = now()
     WHERE id = p_invoice_id;
  ELSE
    IF v_inv.status NOT IN ('issued', 'confirmed') THEN
      RAISE EXCEPTION 'invoice_not_disputable' USING ERRCODE = '22023';
    END IF;
    IF v_note IS NULL THEN
      RAISE EXCEPTION 'dispute_note_required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.supplier_invoices
       SET status = 'disputed', disputed_at = now(), dispute_note = v_note, updated_at = now()
     WHERE id = p_invoice_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. 執行權限:只有登入者能呼叫(函式裡再檢查身分)
-- ---------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.supplier_create_invoice(uuid, uuid, text, date, date, integer, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supplier_mark_invoice_paid(uuid, text)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supplier_void_invoice(uuid, text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restaurant_respond_invoice(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_create_invoice(uuid, uuid, text, date, date, integer, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.supplier_mark_invoice_paid(uuid, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.supplier_void_invoice(uuid, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_respond_invoice(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
