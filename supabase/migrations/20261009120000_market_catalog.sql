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
--     店家只能讀、建、改,不能刪(刪掉再重建就能洗掉管理員的停用);轉帳資訊、商品可以刪(沒有管理員的決定可洗)
--   管理員(is_admin()):全部;核准 / 退回 / 下架(= 退回並填原因)/ 停用店家零售(要填原因)
--   資料表權限先 REVOKE ALL(含 PG17 的 MAINTAIN)再 GRANT 真正需要的,細分交給 RLS
--
-- 審核規則(guard trigger 在伺服器端決定,前端只是顯示):
--   - 供應商只能把商品設成 draft / pending;approved / rejected 只有管理員能設
--   - 已核准(approved)的商品改了內容欄位(品名、分類、規格、溫層、產地、保存方式、保存期限、說明、照片)→ 自動回到 pending;
--     改價格、庫存、上架開關(is_listed)、對應的 B2B 商品不用重審
--   - 退回一定要填原因(會顯示給供應商);核准時清掉原因;reviewed_by / reviewed_at / submitted_at 由伺服器填
--   - created_at 一律由伺服器填(新增 = now()、修改保留原值):首頁照 created_at 排序,自己帶未來時間就能永遠置頂
--   - 管理員核准(含直接建成已核准)前,photos 每張照片與它的 _t 縮圖都要已經在 Storage(market-images),
--     缺檔 → 22023 photos_not_uploaded(Storage 物件只能寫一次,核准後才第一次上傳就會繞過審核)
--   - 文字欄位去頭尾空白時連全形空白、零寬字元一起去(market_trim);去完看不到字(market_visible:只剩格式 /
--     控制 / 看起來空白的字元)就當成空的 —— 品名、規格被 CHECK 擋,選填欄位當成沒填
--   - guard 先擋擁有權(新增別家的商品 → 42501)與亂塞的超長輸入(文字 10000 字、照片 50 張 → 23514),
--     才做正規化,超長輸入不用跑正規式
--
-- 圖片路徑(Storage bucket 在下一支 migration 20261009120100):<supplier_id>/<商品 id 或 store>/<uuid>.<jpg|jpeg|png|webp>;
-- 商品照片(photos)只收 .jpg(縮圖才會跟前端 thumbPathOf 的 _t.jpg 是同一張),store 資料夾的 logo / 封面不限
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

-- 去掉頭尾的空白與看不見的字元。btrim 只去半形空白:全形空白(U+3000)、不換行空白(U+00A0)、
-- 零寬字元(U+200B–U+200D、U+2060、U+FEFF)都會留下來,只有這些字元的品名看起來是空的卻存得進去。
-- 字元集合:\s(ASCII 空白)+ Unicode 的 White_Space + 零寬 / BOM。中間的字元不動。
CREATE OR REPLACE FUNCTION public.market_trim(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT regexp_replace(p_text, '^' || v.c || '+|' || v.c || '+$', '', 'g')
    FROM (VALUES ('[\s\u0085\u00a0\u1680\u180e\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]')) AS v(c)
$$;

-- 「看得到的字」至少一個:只要有一個字不在下面這組「看不見」的字元裡就算(用 ~ '[^…]' 找到第一個看得見的字
-- 就停,不整串取代;1e6 個看不見的字也只要幾十毫秒)。看不見的字元:空白、控制字元(Cc)、格式字元(Cf)、
-- Unicode 的 Default_Ignorable_Code_Point(含保留碼位,區段合併成 U+205F–U+206F、U+FFF0–U+FFFB、U+E0000–U+E0FFF),
-- 與看起來空白的字元(韓文填充字 U+115F、U+1160、U+3164、U+FFA0,點字空白 U+2800,異體字選擇符 U+FE00–U+FE0F,
-- 組合字形連接符 U+034F,高棉文 U+17B4、U+17B5,蒙古文 U+180B–U+180F)。
-- 只用來判斷「是不是空的」,不改內容:emoji 的 U+FE0F、ZWJ 組合都原樣保留。
-- (U+FE0F 不能放進 market_trim:emoji 常以 U+FE0F 結尾,trim 掉會截斷品名。)
CREATE OR REPLACE FUNCTION public.market_visible(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(p_text ~ '[^\s\u0001-\u001f\u007f-\u00a0\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u1680\u17b4\u17b5\u180b-\u180f\u2000-\u200f\u2028-\u202f\u205f-\u206f\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', false)
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
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- 先確認是自家的店。這支 SECURITY DEFINER 的 guard 比 RLS 的 WITH CHECK 先跑:不先擋,替別家建店時
  -- 下面查轉帳資訊(繞過 RLS)回 22023、RLS 回 42501,就能判斷別家有沒有存轉帳資訊。錯誤碼跟 RLS 一樣是 42501。
  -- 只有 INSERT 要擋:UPDATE 時 RLS 的 USING 已經只留自家的列,supplier_id 又改不了。
  -- 例外只看 auth.role():NULL(資料庫擁有者直接寫,沒有 JWT)與 service_role 本來就不受 RLS 管,不擋;
  -- 其他身分一律檢查 —— 用 auth.uid() 判斷的話,沒有 sub 的 authenticated JWT 會被當成擁有者放過。
  IF TG_OP = 'INSERT' AND NOT v_admin
     AND auth.role() IS NOT NULL AND auth.role() <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.current_supplier_ids() AS c(id) WHERE c.id = NEW.supplier_id) THEN
    RAISE EXCEPTION '只能設定自家的零售店家' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    RAISE EXCEPTION '不能更改店家所屬的供應商' USING ERRCODE = '42501', HINT = 'supplier_immutable';
  END IF;

  NEW.intro           := NULLIF(btrim(COALESCE(NEW.intro, '')), '');
  NEW.return_policy   := NULLIF(btrim(COALESCE(NEW.return_policy, '')), '');
  NEW.disabled_reason := NULLIF(btrim(COALESCE(NEW.disabled_reason, '')), '');

  -- 零售啟用 / 停用原因只有管理員能改
  IF NOT v_admin THEN
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

  -- created_at 由伺服器決定:新增 = 現在,修改保留原值(自己帶的值一律蓋掉)
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
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

-- 供應商對自家店家只有 SELECT / INSERT / UPDATE,沒有 DELETE:guard 在 INSERT 時一律設成啟用,
-- 能刪的話,被管理員停用的店家刪掉再重建就變回啟用、停用原因也不見了。
-- (店家設定頁的儲存是 upsert = INSERT … ON CONFLICT DO UPDATE,用到的是 INSERT + UPDATE + SELECT,不受影響。)
DROP POLICY IF EXISTS "market stores supplier read" ON public.market_stores;
CREATE POLICY "market stores supplier read" ON public.market_stores
  FOR SELECT TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market stores supplier insert" ON public.market_stores;
CREATE POLICY "market stores supplier insert" ON public.market_stores
  FOR INSERT TO authenticated
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market stores supplier update" ON public.market_stores;
CREATE POLICY "market stores supplier update" ON public.market_stores
  FOR UPDATE TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market stores admin" ON public.market_stores;
CREATE POLICY "market stores admin" ON public.market_stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 轉帳資訊可以刪(FOR ALL):這張表沒有管理員設的欄位,刪掉再重建洗不掉任何東西
DROP POLICY IF EXISTS "market store transfer supplier manage" ON public.market_store_transfer;
CREATE POLICY "market store transfer supplier manage" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market store transfer admin" ON public.market_store_transfer;
CREATE POLICY "market store transfer admin" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 這個專案的 public schema 預設把新表的全部權限(PG17 還有 MAINTAIN)給 anon / authenticated:
-- 先全部收回,再給真正需要的,RLS 之外再收一層。authenticated 的 DELETE 在店家表只有管理員的 policy 用得到。
REVOKE ALL ON TABLE public.market_stores, public.market_store_transfer FROM anon, authenticated;
GRANT SELECT ON TABLE public.market_stores TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_stores, public.market_store_transfer TO authenticated;

REVOKE ALL ON FUNCTION public.market_stores_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_transfer_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_image_path_matches(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_trim(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_visible(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_is_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_store_is_open(uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. 零售商品
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES public.market_stores(supplier_id) ON DELETE CASCADE,
  supply_id      uuid REFERENCES public.supplies(id) ON DELETE SET NULL,
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN (
    -- @market-categories-begin
    'vegetable', 'fruit', 'seafood', 'meat', 'egg', 'grain',
    'grocery', 'processed', 'hotpot', 'condiment', 'drink', 'packaging'
    -- @market-categories-end
  )),
  spec           text NOT NULL,
  price          integer NOT NULL,
  stock          integer,
  temperature    text NOT NULL DEFAULT 'ambient' CHECK (temperature IN (
    -- @market-temperatures-begin
    'ambient', 'chilled', 'frozen'
    -- @market-temperatures-end
  )),
  origin         text,
  storage_method text,
  shelf_life     text,
  description    text,
  photos         text[] NOT NULL DEFAULT '{}'::text[],
  review_status  text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'pending', 'approved', 'rejected')),
  reject_reason  text,
  is_listed      boolean NOT NULL DEFAULT true,
  submitted_at   timestamptz,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_products_text_lengths CHECK (
    char_length(name) BETWEEN 1 AND 60
    AND char_length(spec) BETWEEN 1 AND 40
    AND (origin IS NULL OR char_length(origin) <= 40)
    AND (storage_method IS NULL OR char_length(storage_method) <= 100)
    AND (shelf_life IS NULL OR char_length(shelf_life) <= 40)
    AND (description IS NULL OR char_length(description) <= 2000)
    AND (reject_reason IS NULL OR char_length(reject_reason) <= 300)
  ),
  CONSTRAINT market_products_price CHECK (price BETWEEN 1 AND 1000000),
  CONSTRAINT market_products_stock CHECK (stock IS NULL OR stock BETWEEN 0 AND 100000),
  -- 一維陣列(空陣列的 array_ndims 是 NULL);只限張數的話,二維陣列也存得進去
  CONSTRAINT market_products_photos CHECK (cardinality(photos) <= 5 AND COALESCE(array_ndims(photos), 1) = 1)
);

CREATE INDEX IF NOT EXISTS market_products_supplier_idx ON public.market_products (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_products_public_idx ON public.market_products (review_status, is_listed, created_at DESC);

COMMENT ON TABLE public.market_products IS
  '零售商品。價格為整數新台幣;stock NULL = 不限。review_status 由 market_products_guard 把關(供應商只能 draft / pending)。';
COMMENT ON COLUMN public.market_products.supply_id IS '對應的 B2B 商品(supplies.id),只供參考,不影響價格與庫存';
COMMENT ON COLUMN public.market_products.is_listed IS '供應商自己的上架開關(已核准的商品暫停販售用,不用重審)';

CREATE OR REPLACE FUNCTION public.market_products_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   boolean := public.is_admin();
  v_content boolean;
  v_bad     text;
  v_missing text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.id IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION '不能更改商品所屬的店家' USING ERRCODE = '42501', HINT = 'supplier_immutable';
  END IF;

  -- 先擋擁有權與超長輸入,再做比較花時間的正規化(market_visible、market_trim、照片路徑)。
  -- 這支 SECURITY DEFINER 的 guard 比 RLS 的 WITH CHECK 先跑:不先擋,不是供應商的登入者替別家塞超長欄位,
  -- 要等正規化跑完才拿到 RLS 的 42501。擁有權的例外跟 market_stores_guard 一樣只看 auth.role()(NULL、service_role 不擋);
  -- 只有 INSERT 要擋(UPDATE 時 RLS 的 USING 已經只留自家的列,supplier_id 又改不了)。
  IF TG_OP = 'INSERT' AND NOT v_admin
     AND auth.role() IS NOT NULL AND auth.role() <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.current_supplier_ids() AS c(id) WHERE c.id = NEW.supplier_id) THEN
    RAISE EXCEPTION '只能設定自家的零售商品' USING ERRCODE = '42501';
  END IF;
  -- 粗擋長度:比 CHECK 的上限寬很多(文字欄位 10000 字、照片 50 張),只為了讓亂塞的超長輸入不用跑後面的正規式;
  -- 精確上限仍由 market_products_text_lengths / market_products_photos 在正規化之後檢查。錯誤碼跟 CHECK 一樣是 23514。
  IF char_length(NEW.name) > 10000 OR char_length(NEW.spec) > 10000 OR char_length(NEW.origin) > 10000
     OR char_length(NEW.storage_method) > 10000 OR char_length(NEW.shelf_life) > 10000
     OR char_length(NEW.description) > 10000 OR char_length(NEW.reject_reason) > 10000
     OR cardinality(NEW.photos) > 50 THEN
    RAISE EXCEPTION '欄位內容太長或照片太多' USING ERRCODE = '23514';
  END IF;

  -- 文字欄位:去頭尾空白(連全形空白、零寬字元一起去,見 market_trim);去完看不到任何字
  -- (只剩空白 / 格式 / 控制 / 看起來空白的字元,見 market_visible)就當成空的 ——
  -- 品名、規格變成空字串、被 market_products_text_lengths 擋(23514),選填欄位當成沒填(NULL)。
  NEW.name           := CASE WHEN public.market_visible(NEW.name) THEN public.market_trim(NEW.name) ELSE '' END;
  NEW.spec           := CASE WHEN public.market_visible(NEW.spec) THEN public.market_trim(NEW.spec) ELSE '' END;
  NEW.origin         := CASE WHEN public.market_visible(NEW.origin) THEN public.market_trim(NEW.origin) END;
  NEW.storage_method := CASE WHEN public.market_visible(NEW.storage_method) THEN public.market_trim(NEW.storage_method) END;
  NEW.shelf_life     := CASE WHEN public.market_visible(NEW.shelf_life) THEN public.market_trim(NEW.shelf_life) END;
  NEW.description    := CASE WHEN public.market_visible(NEW.description) THEN public.market_trim(NEW.description) END;
  NEW.reject_reason  := CASE WHEN public.market_visible(NEW.reject_reason) THEN public.market_trim(NEW.reject_reason) END;
  NEW.photos         := COALESCE(NEW.photos, '{}'::text[]);

  -- 照片一定在自己的資料夾:<supplier_id>/<商品 id>/<uuid>.jpg
  -- 商品照片只收小寫 .jpg(.JPG 跟 120100 的路徑規則一樣不收):前端一律壓成 JPEG 上傳(主圖 .jpg、縮圖 _t.jpg),
  -- 限定之後下面核准時推出的縮圖 <uuid>_t.<同副檔名> 一定是 _t.jpg,跟前端 thumbPathOf 顯示的是同一張。
  -- 店家 logo / 封面(store 資料夾)不在 photos 裡,仍照 market_image_path_matches 收 jpg / jpeg / png / webp。
  -- (陣列裡的 NULL 也算錯:market_image_path_matches 對 NULL 回 false,COALESCE 讓 v_bad 不是 NULL 才擋得到)
  SELECT COALESCE(p, '(空值)') INTO v_bad
    FROM unnest(NEW.photos) AS p
   WHERE NOT public.market_image_path_matches(p, NEW.supplier_id, NEW.id::text)
      OR p !~ '[.]jpg$'
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '商品照片的路徑不正確:%', v_bad USING ERRCODE = '22023', HINT = 'invalid_photo_path';
  END IF;

  -- 對應的 B2B 商品必須是自家的
  IF NEW.supply_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.supplies s WHERE s.id = NEW.supply_id AND s.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '對應的批發商品不是你家的' USING ERRCODE = '22023', HINT = 'supply_not_owned';
  END IF;

  IF v_admin THEN
    IF NEW.review_status = 'rejected' AND NEW.reject_reason IS NULL THEN
      RAISE EXCEPTION '退回或下架要填寫原因(會顯示給供應商)' USING ERRCODE = '22023', HINT = 'reject_reason_required';
    END IF;
    -- 核准前確認每張照片和它的縮圖(<uuid>_t.<副檔名>,照 120100 的路徑格式;商品照片只收 .jpg,所以就是 _t.jpg)
    -- 都已經上傳到 market-images。
    -- Storage 的物件只能寫一次:核准時已經在的檔之後換不掉;還沒上傳的路徑若放行,核准後才第一次上傳就繞過了審核。
    -- 只在「變成已核准」與「已核准時改了照片」檢查:之後改價格、庫存(包括第 2 階段下單扣庫存)不受影響。
    IF NEW.review_status = 'approved'
       AND (TG_OP = 'INSERT' OR OLD.review_status IS DISTINCT FROM 'approved' OR NEW.photos IS DISTINCT FROM OLD.photos) THEN
      -- 每張照片展開成「主圖、縮圖」兩個檔名,回第一個真的缺的(錯誤訊息帶的是缺的那張,不一定是主圖)
      SELECT f.path INTO v_missing
        FROM unnest(NEW.photos) AS p,
             LATERAL (VALUES (p), (regexp_replace(p, '[.][a-z]+$', '') || '_t.' || substring(p FROM '[.]([a-z]+)$'))) AS f(path)
       WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'market-images' AND o.name = f.path)
       LIMIT 1;
      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION '照片還沒上傳完成(主圖或縮圖缺檔),不能核准:%', v_missing
          USING ERRCODE = '22023', HINT = 'photos_not_uploaded';
      END IF;
    END IF;
    IF NEW.review_status IN ('approved', 'rejected')
       AND (TG_OP = 'INSERT' OR NEW.review_status IS DISTINCT FROM OLD.review_status) THEN
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    END IF;
    IF NEW.review_status = 'approved' THEN
      NEW.reject_reason := NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.review_status NOT IN ('draft', 'pending') THEN
      RAISE EXCEPTION '商品要經過管理員審核才能上架' USING ERRCODE = '42501', HINT = 'review_status_forbidden';
    END IF;
    NEW.reviewed_by   := NULL;
    NEW.reviewed_at   := NULL;
    NEW.reject_reason := NULL;
  ELSE
    -- 審核欄位只有管理員能動
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status
       AND NOT (NEW.review_status IN ('draft', 'pending') AND OLD.review_status IN ('draft', 'pending', 'rejected')) THEN
      RAISE EXCEPTION '商品要經過管理員審核才能上架' USING ERRCODE = '42501', HINT = 'review_status_forbidden';
    END IF;
    -- 已核准的商品改了內容 → 回到待審(改價格、庫存、上架開關不用重審)
    v_content := NEW.name IS DISTINCT FROM OLD.name
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.spec IS DISTINCT FROM OLD.spec
      OR NEW.temperature IS DISTINCT FROM OLD.temperature
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.storage_method IS DISTINCT FROM OLD.storage_method
      OR NEW.shelf_life IS DISTINCT FROM OLD.shelf_life
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.photos IS DISTINCT FROM OLD.photos;
    IF OLD.review_status = 'approved' AND v_content THEN
      NEW.review_status := 'pending';
    END IF;
    -- 退回原因留給供應商看;重新送審就清掉
    NEW.reject_reason := CASE WHEN NEW.review_status = 'rejected' THEN OLD.reject_reason ELSE NULL END;
  END IF;

  IF NEW.review_status = 'pending' AND (TG_OP = 'INSERT' OR OLD.review_status IS DISTINCT FROM 'pending') THEN
    NEW.submitted_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.submitted_at := OLD.submitted_at;
  ELSE
    -- 新增但沒有送審(草稿;或管理員直接建成已核准 / 退回):自己帶的送審時間不算
    NEW.submitted_at := NULL;
  END IF;

  -- created_at 由伺服器決定:新增 = 現在,修改保留原值(自己帶的值一律蓋掉)
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_products_guard ON public.market_products;
CREATE TRIGGER trg_market_products_guard
BEFORE INSERT OR UPDATE ON public.market_products
FOR EACH ROW EXECUTE FUNCTION public.market_products_guard();

ALTER TABLE public.market_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market products public read" ON public.market_products;
CREATE POLICY "market products public read" ON public.market_products
  FOR SELECT TO anon, authenticated
  USING (review_status = 'approved' AND is_listed AND public.market_store_is_open(supplier_id));

-- 商品可以刪(FOR ALL):刪掉再重建只會得到草稿,還是要送審、管理員核准才上架,洗不掉任何管理員的決定
DROP POLICY IF EXISTS "market products supplier manage" ON public.market_products;
CREATE POLICY "market products supplier manage" ON public.market_products
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market products admin" ON public.market_products;
CREATE POLICY "market products admin" ON public.market_products
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 跟店家表一樣:先全部收回(含 MAINTAIN),再給真正需要的
REVOKE ALL ON TABLE public.market_products FROM anon, authenticated;
GRANT SELECT ON TABLE public.market_products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_products TO authenticated;
REVOKE ALL ON FUNCTION public.market_products_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
