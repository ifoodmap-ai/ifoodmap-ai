-- =====================================================================
-- 消費者食材市集(B2C)第 1 階段:零售店家 + 轉帳資訊 + 零售商品與審核
-- (業主 2026-10-09 核准;設計 docs/plans/2026-10-09-consumer-market-design.md、計畫 docs/plans/2026-10-09-consumer-market-plan.md)
--
-- 跟餐廳的詢價訂單(supplier_orders / order_events)完全分開,全部用 market_ 前綴:
--   market_stores          一家供應商一列(PK = supplier_id):配送縣市、運費、免運、最低金額、出貨天數、付款方式、介紹
--   market_store_transfer  轉帳資訊(只有該供應商與管理員讀得到;消費者要等店家接單後,經 token 查單 RPC 才看得到)
--   market_products        零售商品(可選對應 B2B 的 supplies.id,只供參考)與審核狀態
--
-- 權限:
--   anon / 一般登入者:只讀「零售啟用 + 供應商啟用中」的店家,與其中「已核准 + 上架中」的商品(market_store_is_open)
--   供應商:用 current_supplier_ids() 讀寫自家的店家、轉帳資訊、商品;guard trigger 擋「自己核准」「改零售啟用」「搬到別家」
--   管理員(is_admin()):全部;核准 / 退回 / 下架(= 退回並填原因)/ 停用店家零售(要填原因)
--
-- 審核規則(guard trigger 在伺服器端決定,前端只是顯示):
--   - 供應商只能把商品設成 draft / pending;approved / rejected 只有管理員能設
--   - 已核准(approved)的商品改了內容欄位(品名、分類、規格、溫層、產地、保存方式、保存期限、說明、照片)→ 自動回到 pending;
--     改價格、庫存、上架開關(is_listed)、對應的 B2B 商品不用重審
--   - 退回一定要填原因(會顯示給供應商);核准時清掉原因;reviewed_by / reviewed_at / submitted_at 由伺服器填
--
-- 圖片路徑(Storage bucket 在下一支 migration 20261009120100):<supplier_id>/<商品 id 或 store>/<uuid>.<jpg|jpeg|png|webp>
--
-- 前端 src/lib/market/constants.ts 由 vitest 解析本檔 @market-cities / @market-categories / @market-temperatures 標記之間的內容逐字比對。
-- 還原:supabase/rollbacks/20261009120000_market_catalog.down.sql
-- 測試:supabase/tests/database/market_catalog.test.sql(node scripts/supabase-sql.mjs dry,正式庫 BEGIN … ROLLBACK)
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 0. 固定清單與共用檢查
-- ---------------------------------------------------------------------
-- 臺灣 22 縣市(官方寫法「臺」;前端一律用下拉選單,不讓人手打)
CREATE OR REPLACE FUNCTION public.market_tw_cities()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    -- @market-cities-begin
    '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市',
    '基隆市', '新竹市', '嘉義市',
    '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣',
    '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
    -- @market-cities-end
  ]::text[]
$$;

COMMENT ON FUNCTION public.market_tw_cities() IS '零售市集的配送 / 收件縣市清單(22 縣市,與 src/lib/market/constants.ts TW_CITIES 一字不差)';

-- 存在資料表裡的圖片路徑:<supplier_id>/<資料夾>/<uuid>.<副檔名>(資料夾 = 商品 id 或 store;縮圖 _t 不能當正式圖片)
CREATE OR REPLACE FUNCTION public.market_image_path_matches(p_path text, p_supplier uuid, p_folder text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_path IS NOT NULL
     AND p_path ~ ('^' || p_supplier::text || '/' || p_folder
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')
$$;

-- ---------------------------------------------------------------------
-- 1. 零售店家
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_stores (
  supplier_id             uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  is_enabled              boolean NOT NULL DEFAULT true,
  disabled_reason         text,
  logo_path               text,
  cover_path              text,
  intro                   text,
  return_policy           text,
  delivery_cities         text[] NOT NULL,
  shipping_fee            integer NOT NULL DEFAULT 0,
  free_shipping_threshold integer,
  min_order_amount        integer NOT NULL DEFAULT 0,
  ship_days               integer NOT NULL DEFAULT 3,
  payment_methods         text[] NOT NULL DEFAULT ARRAY['cod']::text[],
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_stores_text_lengths CHECK (
    (disabled_reason IS NULL OR char_length(disabled_reason) <= 300)
    AND (intro IS NULL OR char_length(intro) <= 1000)
    AND (return_policy IS NULL OR char_length(return_policy) <= 1000)
    AND (logo_path IS NULL OR char_length(logo_path) <= 200)
    AND (cover_path IS NULL OR char_length(cover_path) <= 200)
  ),
  CONSTRAINT market_stores_delivery_cities CHECK (
    cardinality(delivery_cities) BETWEEN 1 AND 22 AND delivery_cities <@ public.market_tw_cities()
  ),
  CONSTRAINT market_stores_money CHECK (
    shipping_fee BETWEEN 0 AND 10000
    AND (free_shipping_threshold IS NULL OR free_shipping_threshold BETWEEN 1 AND 1000000)
    AND min_order_amount BETWEEN 0 AND 1000000
  ),
  CONSTRAINT market_stores_ship_days CHECK (ship_days BETWEEN 0 AND 30),
  CONSTRAINT market_stores_payment_methods CHECK (
    cardinality(payment_methods) BETWEEN 1 AND 2 AND payment_methods <@ ARRAY['cod', 'transfer']::text[]
  )
);

COMMENT ON TABLE public.market_stores IS
  '零售店家(一家供應商一列)。is_enabled / disabled_reason 只有管理員能改(market_stores_guard)。';

-- 轉帳資訊另一張表:market_stores 對 anon 公開,這張不公開。外鍵接 suppliers(不是 market_stores),
-- 讓店家設定頁可以「先存轉帳資訊、再存店家」(勾銀行轉帳時 guard 會檢查這裡有沒有資料)。
CREATE TABLE IF NOT EXISTS public.market_store_transfer (
  supplier_id   uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  transfer_info text NOT NULL CHECK (char_length(transfer_info) BETWEEN 5 AND 300),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.market_store_transfer IS
  '零售店家的轉帳資訊(銀行、帳號、戶名)。只有該供應商與管理員讀得到;消費者在訂單「待匯款」時經 market_get_orders 看到。';

-- 店家是否對外營業(公開讀取的 RLS 與下單都用這一支;SECURITY DEFINER 才不會被 suppliers 的 RLS 卡住)
CREATE OR REPLACE FUNCTION public.market_store_is_open(p_supplier uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.market_stores s
      JOIN public.suppliers p ON p.id = s.supplier_id
     WHERE s.supplier_id = p_supplier AND s.is_enabled AND p.is_active
  )
$$;

CREATE OR REPLACE FUNCTION public.market_stores_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    RAISE EXCEPTION '不能更改店家所屬的供應商' USING ERRCODE = '42501', HINT = 'supplier_immutable';
  END IF;

  NEW.intro           := NULLIF(btrim(COALESCE(NEW.intro, '')), '');
  NEW.return_policy   := NULLIF(btrim(COALESCE(NEW.return_policy, '')), '');
  NEW.disabled_reason := NULLIF(btrim(COALESCE(NEW.disabled_reason, '')), '');

  -- 零售啟用 / 停用原因只有管理員能改
  IF NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_enabled := true;
      NEW.disabled_reason := NULL;
    ELSE
      NEW.is_enabled := OLD.is_enabled;
      NEW.disabled_reason := OLD.disabled_reason;
    END IF;
  ELSIF NOT NEW.is_enabled AND NEW.disabled_reason IS NULL THEN
    RAISE EXCEPTION '停用店家零售要填寫原因' USING ERRCODE = '22023', HINT = 'disabled_reason_required';
  ELSIF NEW.is_enabled THEN
    NEW.disabled_reason := NULL;
  END IF;

  -- 縣市去重複、照官方順序;付款方式去重複、排序
  NEW.delivery_cities := ARRAY(
    SELECT d.c FROM (SELECT DISTINCT c FROM unnest(NEW.delivery_cities) AS c) d
     ORDER BY array_position(public.market_tw_cities(), d.c) NULLS LAST, d.c
  );
  NEW.payment_methods := ARRAY(SELECT DISTINCT m FROM unnest(NEW.payment_methods) AS m ORDER BY m);

  IF NEW.logo_path IS NOT NULL AND NOT public.market_image_path_matches(NEW.logo_path, NEW.supplier_id, 'store') THEN
    RAISE EXCEPTION '店家 logo 的圖片路徑不正確' USING ERRCODE = '22023', HINT = 'invalid_image_path';
  END IF;
  IF NEW.cover_path IS NOT NULL AND NOT public.market_image_path_matches(NEW.cover_path, NEW.supplier_id, 'store') THEN
    RAISE EXCEPTION '店家封面的圖片路徑不正確' USING ERRCODE = '22023', HINT = 'invalid_image_path';
  END IF;

  IF 'transfer' = ANY (NEW.payment_methods)
     AND NOT EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '接受銀行轉帳要先填寫轉帳資訊' USING ERRCODE = '22023', HINT = 'transfer_info_required';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_stores_guard ON public.market_stores;
CREATE TRIGGER trg_market_stores_guard
BEFORE INSERT OR UPDATE ON public.market_stores
FOR EACH ROW EXECUTE FUNCTION public.market_stores_guard();

CREATE OR REPLACE FUNCTION public.market_store_transfer_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.transfer_info := btrim(COALESCE(NEW.transfer_info, ''));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_store_transfer_touch ON public.market_store_transfer;
CREATE TRIGGER trg_market_store_transfer_touch
BEFORE INSERT OR UPDATE ON public.market_store_transfer
FOR EACH ROW EXECUTE FUNCTION public.market_store_transfer_touch();

ALTER TABLE public.market_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_store_transfer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market stores public read" ON public.market_stores;
CREATE POLICY "market stores public read" ON public.market_stores
  FOR SELECT TO anon, authenticated
  USING (public.market_store_is_open(supplier_id));

DROP POLICY IF EXISTS "market stores supplier manage" ON public.market_stores;
CREATE POLICY "market stores supplier manage" ON public.market_stores
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market stores admin" ON public.market_stores;
CREATE POLICY "market stores admin" ON public.market_stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "market store transfer supplier manage" ON public.market_store_transfer;
CREATE POLICY "market store transfer supplier manage" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market store transfer admin" ON public.market_store_transfer;
CREATE POLICY "market store transfer admin" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 這個專案的 public schema 預設把新表的全部權限給 anon / authenticated,RLS 之外再收一層
REVOKE ALL ON TABLE public.market_store_transfer FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_stores FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_stores, public.market_store_transfer FROM authenticated;

REVOKE ALL ON FUNCTION public.market_stores_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_transfer_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_image_path_matches(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_is_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_store_is_open(uuid) TO anon, authenticated, service_role;
