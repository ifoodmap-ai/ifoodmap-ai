-- =====================================================================
-- 消費者食材市集第 2 階段:零售訂單(每家店一張)、明細快照、只能新增的狀態紀錄
-- 比照餐廳訂單的「事件流 + guard trigger + apply trigger + notify trigger」(20260726100000 / 20260929100000 / 20260929110000),
-- 但完全另開新表,不動 supplier_orders / order_events。
--
-- 狀態:
--   pending → confirmed → shipped → completed                                  ← 貨到付款(cod)
--   pending → confirmed →(自動)awaiting_payment → paid → shipped → completed     ← 銀行轉帳(transfer)
--   pending → rejected(要原因)
--   pending / confirmed / awaiting_payment → cancelled(要原因;供應商或管理員)
--
-- 寫入規則(全部在伺服器端):
--   - market_orders / market_order_items 只能由 market_place_order()(SECURITY DEFINER,20261009130200)建立;
--     API 角色對這兩張表沒有任何寫入權限,也沒有寫入 policy
--   - 狀態只能經由 INSERT market_order_events 改變:
--       trg_market_guard_event(BEFORE):鎖訂單列;身分由伺服器決定(這家店的啟用中帳號 = supplier、is_admin() = admin、
--         沒有登入者且是 service_role / 資料庫直連 = system);from_status 必須等於目前狀態(畫面過期 → P0001 stale_order_status);
--         (身分, 目前狀態, 目標狀態, 付款方式) 必須在 market_transition_rules() 裡;拒單 / 取消要原因;出貨要物流。
--         第一筆紀錄(pending)只會出現在建單的交易裡
--       trg_market_apply_event(AFTER):套用狀態與時間;拒單 / 取消把庫存加回去;轉帳訂單接單後自動再寫一筆 confirmed → awaiting_payment
--   - 紀錄只能新增:UPDATE / DELETE 一律擋(所以訂單也刪不掉 —— 那是交易紀錄);同一個 INSERT 同一張單只能一筆
--
-- 讀取:供應商讀自家的訂單、明細、紀錄;管理員全部;anon 什麼都讀不到(消費者只能經 market_get_orders(token))
--
-- 前端 src/lib/market/orders.ts 的 MARKET_TRANSITIONS / 狀態清單,由 vitest 解析本檔 @market-transitions / @market-statuses 標記比對。
-- 還原:supabase/rollbacks/20261009130000_market_orders.down.sql
-- 測試:supabase/tests/database/market_orders.test.sql
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 0. 共用檢查(收件電話、Email;下單 RPC 也用同一支 —— 前端 src/lib/market/checkout.ts 的 regex 由 vitest 比對)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_phone_ok(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p IS NOT NULL AND p ~ '^0[0-9]{8,9}$'  -- @market-phone-regex
$$;

CREATE OR REPLACE FUNCTION public.market_email_ok(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p IS NOT NULL AND char_length(p) <= 254
     AND p ~ '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$'  -- @market-email-regex
$$;

-- ---------------------------------------------------------------------
-- 1. 訂單、明細、狀態紀錄
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id         uuid NOT NULL,
  supplier_id         uuid NOT NULL REFERENCES public.market_stores(supplier_id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'pending',
  buyer_name          text NOT NULL,
  buyer_phone         text NOT NULL,
  buyer_email         text NOT NULL,
  ship_city           text NOT NULL,
  ship_address        text NOT NULL,
  buyer_note          text,
  subtotal            integer NOT NULL,
  shipping_fee        integer NOT NULL,
  total               integer NOT NULL,
  payment_method      text NOT NULL,
  payment_status      text NOT NULL DEFAULT 'unpaid',
  payment_ref         text,
  lookup_token_hash   text NOT NULL,
  terms_version       text NOT NULL,
  status_note         text,
  shipped_carrier     text,
  shipped_tracking_no text,
  confirmed_at        timestamptz,
  paid_at             timestamptz,
  shipped_at          timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_orders_status CHECK (status IN (
    -- @market-statuses-begin
    'pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled'
    -- @market-statuses-end
  )),
  CONSTRAINT market_orders_buyer CHECK (
    char_length(buyer_name) BETWEEN 1 AND 50
    AND public.market_phone_ok(buyer_phone)
    AND public.market_email_ok(buyer_email)
    AND ship_city = ANY (public.market_tw_cities())
    AND char_length(ship_address) BETWEEN 5 AND 200
    AND (buyer_note IS NULL OR char_length(buyer_note) <= 300)
  ),
  CONSTRAINT market_orders_money CHECK (subtotal > 0 AND shipping_fee >= 0 AND total = subtotal + shipping_fee),
  -- payment_status / payment_ref 預留給之後的線上付款,目前不用
  CONSTRAINT market_orders_payment CHECK (
    payment_method IN ('cod', 'transfer')
    AND payment_status IN ('unpaid', 'paid', 'refunded')
    AND (payment_ref IS NULL OR char_length(payment_ref) <= 100)
  ),
  CONSTRAINT market_orders_token CHECK (lookup_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT market_orders_misc_lengths CHECK (
    char_length(terms_version) BETWEEN 1 AND 20
    AND (status_note IS NULL OR char_length(status_note) <= 300)
    AND (shipped_carrier IS NULL OR char_length(shipped_carrier) <= 50)
    AND (shipped_tracking_no IS NULL OR char_length(shipped_tracking_no) <= 100)
  )
);

CREATE INDEX IF NOT EXISTS market_orders_supplier_idx ON public.market_orders (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_orders_token_idx ON public.market_orders (lookup_token_hash);
CREATE INDEX IF NOT EXISTS market_orders_checkout_idx ON public.market_orders (checkout_id);
CREATE INDEX IF NOT EXISTS market_orders_status_idx ON public.market_orders (status, created_at DESC);

COMMENT ON TABLE public.market_orders IS
  '零售訂單(一次結帳按店家拆成多張,checkout_id 相同、共用一組查詢 token)。只由 market_place_order 建立;狀態只經 market_order_events 改變。';
COMMENT ON COLUMN public.market_orders.lookup_token_hash IS '查詢 token 的 sha256 hex(token 本身只在下單回傳與確認信裡出現)';

CREATE TABLE IF NOT EXISTS public.market_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES public.market_orders(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES public.market_products(id) ON DELETE SET NULL,
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 60),
  spec         text NOT NULL CHECK (char_length(spec) BETWEEN 1 AND 40),
  temperature  text NOT NULL CHECK (temperature IN ('ambient', 'chilled', 'frozen')),
  unit_price   integer NOT NULL CHECK (unit_price BETWEEN 1 AND 1000000),
  qty          integer NOT NULL CHECK (qty BETWEEN 1 AND 99),
  line_total   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_order_items_line_total CHECK (line_total = unit_price * qty)
);

CREATE INDEX IF NOT EXISTS market_order_items_order_idx ON public.market_order_items (order_id);

COMMENT ON TABLE public.market_order_items IS '零售訂單明細(下單當下的品名、規格、單價快照;商品之後改價不影響舊訂單)';

CREATE TABLE IF NOT EXISTS public.market_order_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES public.market_orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_role  text NOT NULL DEFAULT 'supplier' CHECK (actor_role IN ('consumer', 'supplier', 'admin', 'system')),
  actor_id    uuid,
  note        text CHECK (note IS NULL OR char_length(note) <= 300),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_order_events_statuses CHECK (
    to_status IN ('pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled')
    AND (from_status IS NULL
         OR from_status IN ('pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled'))
  ),
  CONSTRAINT market_order_events_payload CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1000)
);

CREATE INDEX IF NOT EXISTS market_order_events_order_idx ON public.market_order_events (order_id, created_at);

COMMENT ON TABLE public.market_order_events IS
  '零售訂單狀態紀錄(只能新增)。actor_role / actor_id / from_status 由 market_guard_event 依登入身分與目前狀態改寫,前端送什麼都不算。';

-- ---------------------------------------------------------------------
-- 2. 轉移表(唯一來源;前端 MARKET_TRANSITIONS 由 vitest 對照)、狀態中文
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_transition_rules()
RETURNS TABLE (actor text, from_status text, to_status text, payment text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT t.actor, t.from_status, t.to_status, t.payment FROM (VALUES
    -- @market-transitions-begin
    -- 這家店的供應商
    ('supplier', 'pending', 'confirmed', 'any'),
    ('supplier', 'pending', 'rejected', 'any'),
    ('supplier', 'pending', 'cancelled', 'any'),
    ('supplier', 'confirmed', 'awaiting_payment', 'transfer'),
    ('supplier', 'confirmed', 'shipped', 'cod'),
    ('supplier', 'confirmed', 'cancelled', 'any'),
    ('supplier', 'awaiting_payment', 'paid', 'transfer'),
    ('supplier', 'awaiting_payment', 'cancelled', 'transfer'),
    ('supplier', 'paid', 'shipped', 'transfer'),
    ('supplier', 'shipped', 'completed', 'any'),
    -- 平台管理員(處理客訴):同供應商
    ('admin', 'pending', 'confirmed', 'any'),
    ('admin', 'pending', 'rejected', 'any'),
    ('admin', 'pending', 'cancelled', 'any'),
    ('admin', 'confirmed', 'awaiting_payment', 'transfer'),
    ('admin', 'confirmed', 'shipped', 'cod'),
    ('admin', 'confirmed', 'cancelled', 'any'),
    ('admin', 'awaiting_payment', 'paid', 'transfer'),
    ('admin', 'awaiting_payment', 'cancelled', 'transfer'),
    ('admin', 'paid', 'shipped', 'transfer'),
    ('admin', 'shipped', 'completed', 'any'),
    -- 系統(service_role、資料庫直連;緊急處理用):同供應商
    ('system', 'pending', 'confirmed', 'any'),
    ('system', 'pending', 'rejected', 'any'),
    ('system', 'pending', 'cancelled', 'any'),
    ('system', 'confirmed', 'awaiting_payment', 'transfer'),
    ('system', 'confirmed', 'shipped', 'cod'),
    ('system', 'confirmed', 'cancelled', 'any'),
    ('system', 'awaiting_payment', 'paid', 'transfer'),
    ('system', 'awaiting_payment', 'cancelled', 'transfer'),
    ('system', 'paid', 'shipped', 'transfer'),
    ('system', 'shipped', 'completed', 'any')
    -- @market-transitions-end
  ) AS t(actor, from_status, to_status, payment)
$$;

CREATE OR REPLACE FUNCTION public.market_order_status_label(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_status
    WHEN 'pending' THEN '待接單'   WHEN 'confirmed' THEN '已接單'  WHEN 'awaiting_payment' THEN '待匯款'
    WHEN 'paid' THEN '已收款'      WHEN 'shipped' THEN '已出貨'    WHEN 'completed' THEN '已完成'
    WHEN 'rejected' THEN '已拒單'  WHEN 'cancelled' THEN '已取消'
    ELSE COALESCE(p_status, '(無)')
  END
$$;

-- ---------------------------------------------------------------------
-- 3. 權限:供應商讀自家、管理員全部;只有狀態紀錄開放 INSERT(guard 再檢查)
-- ---------------------------------------------------------------------
ALTER TABLE public.market_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_order_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.market_orders, public.market_order_items, public.market_order_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.market_orders, public.market_order_items, public.market_order_events TO authenticated;
GRANT INSERT ON TABLE public.market_order_events TO authenticated;

DROP POLICY IF EXISTS "market orders party read" ON public.market_orders;
CREATE POLICY "market orders party read" ON public.market_orders
  FOR SELECT TO authenticated
  USING (public.is_admin() OR supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market order items party read" ON public.market_order_items;
CREATE POLICY "market order items party read" ON public.market_order_items
  FOR SELECT TO authenticated
  USING (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

DROP POLICY IF EXISTS "market order events party read" ON public.market_order_events;
CREATE POLICY "market order events party read" ON public.market_order_events
  FOR SELECT TO authenticated
  USING (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

DROP POLICY IF EXISTS "market order events party insert" ON public.market_order_events;
CREATE POLICY "market order events party insert" ON public.market_order_events
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

REVOKE ALL ON FUNCTION public.market_transition_rules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_order_status_label(text) FROM PUBLIC, anon, authenticated;
