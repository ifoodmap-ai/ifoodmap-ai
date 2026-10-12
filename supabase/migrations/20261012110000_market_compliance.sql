-- =====================================================================
-- 20261012110000_market_compliance:消費者食材市集的法規補強(跟 20261012100000 同一次部署)
-- 依據:2026-10-12 的法規查證(M3 七日解除權逐項標示、M6 店家資訊、M7 下單確認信、S6 自動取消的原因)與業主的決定。
-- 120000 / 130200 已經套用,不改原檔:這支用 CREATE OR REPLACE 換掉四支函式(本體照線上版本只改必要的幾行)。
--
-- 1. 七日解除權逐項標示(消保法 §19;通訊交易解除權合理例外情事適用準則 §2:例外要事先告知才成立,消保處建議標在商品旁):
--    market_products.withdrawal_exempt,預設 false = 適用;true = 不適用七日鑑賞期(生鮮易腐、保存期限短等)。
--    供應商改了要回待審(market_products_guard 的內容欄位清單多這一欄),由管理員確認是否真的屬於易腐商品;管理員改不用重審。
--    anon 讀得到(商品表本來就整表 SELECT 給 anon,照舊由 RLS 只留公開的商品),消費者頁面要顯示。
--    market_order_items.withdrawal_exempt 存下單當時的值:BEFORE INSERT trigger 一律從商品帶入(外部送來的值不算),
--    不改 market_place_order。明細對 API 角色照舊不能改、不能刪(沒有 UPDATE / DELETE 權限)。
-- 2. 店家法定資訊(消保法 §18;網路交易應記載事項第 1 點):market_stores 加 legal_name(登記名稱)、representative(負責人)、
--    business_address(營業所地址)、service_email(給消費者的客服 Email,跟 suppliers.contact_email 新訂單通知信箱是兩回事)、
--    food_registration_no(食品業者登錄字號,選填)、liability_insurance(產品責任險說明,選填)。
--    長度與 Email 格式用 CHECK(Email 照 market_email_ok);去頭尾空白、看不到字當成沒填由 guard 做(market_trim / market_visible)。
--    開放零售多一個條件:四項必填都有、供應商資料的電話(suppliers.phone)看得到字。
--      - market_store_is_open 加上這一條(公開頁面的 RLS、下單都靠它),沒填齊的店公開頁面看不到、也不能下單。
--      - market_stores_guard 在供應商建店(建好就是開放)、開放中的店被供應商改到缺欄位、管理員建成啟用或重新啟用時擋:
--        22023,HINT store_disclosure_missing(放在最後檢查,其他錯誤優先)。管理員停用一律不擋。
--        被管理員停用的店:供應商純 UPDATE 不檢查;但店家設定頁用 upsert,INSERT 那一步的 guard 會先把 is_enabled 設成 true
--        再檢查,所以停用中的店送來的那一列缺法定欄位,一樣回 store_disclosure_missing(接受現狀:店家不會因此被重新打開,
--        前端的表單本來就要求填齊)。
--      - anon 只讀得到已開放的店(RLS 照舊);這些是法定要公開的資訊。
--    CHECK 用到 market_email_ok:供應商直接寫店家表,CHECK 裡的函式要有 EXECUTE 權限,所以 market_email_ok 開給 authenticated
--    (只是正規式,不讀任何資料;anon 照舊沒有)。
-- 3. 查單 RPC(market_get_orders):店家物件多 legal_name、representative、business_address、service_email、
--    food_registration_no(產品責任險不給),明細多 withdrawal_exempt;其他完全照 130200(仍然不給 contact_email)。
--
-- 營運注意:這支會 ALTER 三張已上線的表(加欄位、加 CHECK)。乾跑時那幾秒會鎖住這三張表(交易最後 ROLLBACK);
-- 正式套用時加欄位只改 metadata(預設值是常數,不重寫整張表),CHECK 要掃一遍店家表(套用時 0 列)。
--
-- 還原:supabase/rollbacks/20261012110000_market_compliance.down.sql(四支函式恢復成線上原樣、拆掉新欄位、CHECK、trigger,收回授權)
-- 測試:supabase/tests/database/market_compliance.test.sql、market_compliance_rollback.test.sql
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 七日解除權逐項標示
-- ---------------------------------------------------------------------
ALTER TABLE public.market_products ADD COLUMN IF NOT EXISTS withdrawal_exempt boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.market_products.withdrawal_exempt IS
  '不適用七日解除權(true:生鮮易腐、保存期限短等;例外要在商品旁事先告知才成立)。預設 false = 適用。供應商改了要回待審,由管理員確認';

ALTER TABLE public.market_order_items ADD COLUMN IF NOT EXISTS withdrawal_exempt boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.market_order_items.withdrawal_exempt IS
  '下單當時商品的 withdrawal_exempt(market_order_items_snapshot 一律從商品帶入,外部送來的值不算)';

-- 商品的審核 guard:跟 120000 一字不差,只有「已核准的商品改了內容 → 回到待審」的清單多了 withdrawal_exempt
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
      OR NEW.photos IS DISTINCT FROM OLD.photos
      -- 「不適用七日解除權」的標示也算內容:要由管理員確認是不是真的屬於易腐商品(20261012110000)
      OR NEW.withdrawal_exempt IS DISTINCT FROM OLD.withdrawal_exempt;
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

-- 明細寫入前:withdrawal_exempt 一律以商品當下的值為準(下單 RPC 已經依 id 鎖住這些商品);找不到商品就當成適用(false)
CREATE OR REPLACE FUNCTION public.market_order_items_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.withdrawal_exempt := COALESCE(
    (SELECT p.withdrawal_exempt FROM public.market_products p WHERE p.id = NEW.product_id), false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_order_items_snapshot ON public.market_order_items;
CREATE TRIGGER trg_market_order_items_snapshot
BEFORE INSERT ON public.market_order_items
FOR EACH ROW EXECUTE FUNCTION public.market_order_items_snapshot();

REVOKE ALL ON FUNCTION public.market_order_items_snapshot() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. 店家法定資訊
-- ---------------------------------------------------------------------
ALTER TABLE public.market_stores
  ADD COLUMN IF NOT EXISTS legal_name           text,
  ADD COLUMN IF NOT EXISTS representative       text,
  ADD COLUMN IF NOT EXISTS business_address     text,
  ADD COLUMN IF NOT EXISTS service_email        text,
  ADD COLUMN IF NOT EXISTS food_registration_no text,
  ADD COLUMN IF NOT EXISTS liability_insurance  text;

ALTER TABLE public.market_stores
  ADD CONSTRAINT market_stores_disclosure_lengths CHECK (
    (legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 100)
    AND (representative IS NULL OR char_length(representative) BETWEEN 1 AND 50)
    AND (business_address IS NULL OR char_length(business_address) BETWEEN 5 AND 200)
    AND (food_registration_no IS NULL OR char_length(food_registration_no) BETWEEN 1 AND 40)
    AND (liability_insurance IS NULL OR char_length(liability_insurance) BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT market_stores_service_email CHECK (service_email IS NULL OR public.market_email_ok(service_email));

COMMENT ON COLUMN public.market_stores.legal_name IS '登記名稱(公司 / 商號,1–100 字;開放零售必填)';
COMMENT ON COLUMN public.market_stores.representative IS '負責人(1–50 字;開放零售必填)';
COMMENT ON COLUMN public.market_stores.business_address IS '營業所地址(5–200 字;開放零售必填)';
COMMENT ON COLUMN public.market_stores.service_email IS
  '給消費者的客服 Email(market_email_ok;開放零售必填)。跟 suppliers.contact_email(新訂單通知信箱,不公開)是兩回事';
COMMENT ON COLUMN public.market_stores.food_registration_no IS '食品業者登錄字號(選填,40 字內)';
COMMENT ON COLUMN public.market_stores.liability_insurance IS '產品責任險說明(選填,100 字內)';

-- 店家表的 CHECK 用到 market_email_ok,供應商直接寫店家表(upsert)要有執行權(只是正規式,不讀任何資料)
GRANT EXECUTE ON FUNCTION public.market_email_ok(text) TO authenticated;

-- 店家 guard:跟 120000 一字不差,多了法定資訊的正規化與「開放零售要填齊」的檢查
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
  -- 店家法定資訊(20261012110000):跟商品欄位同一套 —— 去頭尾空白(連全形空白、零寬字元,market_trim),
  -- 去完看不到字(market_visible)就當成沒填(NULL);長度、Email 格式由 CHECK 擋
  NEW.legal_name           := CASE WHEN public.market_visible(NEW.legal_name) THEN public.market_trim(NEW.legal_name) END;
  NEW.representative       := CASE WHEN public.market_visible(NEW.representative) THEN public.market_trim(NEW.representative) END;
  NEW.business_address     := CASE WHEN public.market_visible(NEW.business_address) THEN public.market_trim(NEW.business_address) END;
  NEW.service_email        := CASE WHEN public.market_visible(NEW.service_email) THEN public.market_trim(NEW.service_email) END;
  NEW.food_registration_no := CASE WHEN public.market_visible(NEW.food_registration_no) THEN public.market_trim(NEW.food_registration_no) END;
  NEW.liability_insurance  := CASE WHEN public.market_visible(NEW.liability_insurance) THEN public.market_trim(NEW.liability_insurance) END;

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

  -- 接受轉帳要先有轉帳資訊:只在供應商建店、或供應商的更新動到付款方式時檢查(付款方式已在上面去重排序,
  -- 順序不同不算有變)。管理員的更新(停用、啟用、改停用原因)一律不檢查 —— 供應商可以自己刪掉轉帳資訊,
  -- 若每次更新都檢查,管理員就停用不了這家店;付款方式含轉帳、轉帳資訊卻沒了的店,第 2 階段結帳本來就不能選轉帳。
  IF NOT v_admin
     AND 'transfer' = ANY (NEW.payment_methods)
     AND (TG_OP = 'INSERT' OR NEW.payment_methods IS DISTINCT FROM OLD.payment_methods)
     AND NOT EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '接受銀行轉帳要先填寫轉帳資訊' USING ERRCODE = '22023', HINT = 'transfer_info_required';
  END IF;

  -- 開放零售要有店家法定資訊(消保法 §18、網路交易應記載事項第 1 點;20261012110000):登記名稱、負責人、營業所地址、
  -- 客服 Email,加上供應商資料的電話(suppliers.phone)。放在最後檢查(其他錯誤優先)。
  --   供應商:建店(建好就是開放)、或開放中的店改到缺欄位 → 擋。被管理員停用的店,純 UPDATE 不檢查;
  --     但店家設定頁用的是 upsert(INSERT … ON CONFLICT DO UPDATE):INSERT 那一步的 BEFORE INSERT 會先跑這支
  --     (上面已經把 is_enabled 設成 true),所以停用中的店送來的那一列缺法定欄位,一樣回 store_disclosure_missing。
  --     店家不會因此被重新打開(衝突之後走 UPDATE,is_enabled 照舊保留),前端的表單本來就要求填齊 —— 接受現狀。
  --   管理員:只在建成啟用、或把停用的店重新啟用時檢查;停用、改停用原因一律不擋。
  -- market_store_is_open 也檢查同一組條件:電話是在供應商資料改的(這支管不到),沒填齊的店公開頁面看不到、也不能下單。
  IF NEW.is_enabled
     AND (NOT v_admin OR TG_OP = 'INSERT' OR NOT OLD.is_enabled)
     AND (NEW.legal_name IS NULL OR NEW.representative IS NULL OR NEW.business_address IS NULL OR NEW.service_email IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.suppliers p WHERE p.id = NEW.supplier_id AND public.market_visible(p.phone))) THEN
    RAISE EXCEPTION '開放零售前要填齊店家資訊:登記名稱、負責人、營業所地址、客服 Email,以及供應商資料的電話'
      USING ERRCODE = '22023', HINT = 'store_disclosure_missing';
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

-- 店家是否對外營業:跟 120000 一字不差,多了法定資訊與電話的條件
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
       -- 店家法定資訊要填齊(消保法 §18、網路交易應記載事項第 1 點;20261012110000):四項必填,加上供應商資料的電話
       AND s.legal_name IS NOT NULL AND s.representative IS NOT NULL AND s.business_address IS NOT NULL
       AND s.service_email IS NOT NULL AND public.market_visible(p.phone)
  )
$$;

-- ---------------------------------------------------------------------
-- 3. 查單 RPC:店家物件加法定資訊、明細加 withdrawal_exempt(其餘跟 130200 一字不差)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_get_orders(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', o.id,
           'status', o.status,
           'payment_method', o.payment_method,
           'subtotal', o.subtotal,
           'shipping_fee', o.shipping_fee,
           'total', o.total,
           'created_at', o.created_at,
           'status_note', o.status_note,
           'shipped_carrier', o.shipped_carrier,
           'shipped_tracking_no', o.shipped_tracking_no,
           'buyer_name', o.buyer_name,
           'buyer_phone', public.market_mask_phone(o.buyer_phone),
           'buyer_email', public.market_mask_email(o.buyer_email),
           'ship_city', o.ship_city,
           'ship_address', o.ship_address,
           'buyer_note', o.buyer_note,
           -- 店家:店名、電話給買家聯絡;suppliers.contact_email 是新訂單的通知信箱,不送到瀏覽器(第 1 階段已定案)。
           -- 法定資訊(20261012110000;消保法 §18):登記名稱、負責人、營業所地址、客服 Email、食品業者登錄字號
           'store', jsonb_build_object('supplier_id', s.supplier_id, 'name', sp.name, 'phone', sp.phone,
                                       'ship_days', s.ship_days, 'return_policy', s.return_policy,
                                       'legal_name', s.legal_name, 'representative', s.representative,
                                       'business_address', s.business_address, 'service_email', s.service_email,
                                       'food_registration_no', s.food_registration_no),
           'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'product_name', i.product_name, 'spec', i.spec, 'unit_price', i.unit_price,
                              'qty', i.qty, 'line_total', i.line_total, 'temperature', i.temperature,
                              'withdrawal_exempt', i.withdrawal_exempt)
                            ORDER BY i.created_at, i.id), '[]'::jsonb)
                       FROM public.market_order_items i WHERE i.order_id = o.id),
           'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('to_status', e.to_status, 'created_at', e.created_at, 'note', e.note)
                                      ORDER BY e.created_at, e.id), '[]'::jsonb)
                        FROM public.market_order_events e WHERE e.order_id = o.id),
           -- 店家接單後、還沒收款前才給轉帳資訊
           'transfer_info', CASE WHEN o.status = 'awaiting_payment' AND o.payment_method = 'transfer'
                                 THEN (SELECT t.transfer_info FROM public.market_store_transfer t WHERE t.supplier_id = o.supplier_id) END
         ) ORDER BY o.created_at, o.id)
    INTO v_result
    FROM public.market_orders o
    JOIN public.market_stores s ON s.supplier_id = o.supplier_id
    JOIN public.suppliers sp ON sp.id = o.supplier_id
   WHERE o.lookup_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  RETURN jsonb_build_object('ok', true, 'orders', v_result);
END;
$$;

NOTIFY pgrst, 'reload schema';
