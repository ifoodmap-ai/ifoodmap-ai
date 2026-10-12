-- =====================================================================
-- 還原 20261012110000_market_compliance:
--   market_stores_guard、market_products_guard、market_store_is_open(20261009120000 的版本)與 market_get_orders
--   (20261009130200 的版本)換回原樣(逐字照抄;測試用 md5 比對線上套用前的定義);拆掉明細快照的 trigger 與函式、
--   新欄位(商品 / 明細的 withdrawal_exempt、店家的六個法定資訊)與兩個 CHECK;收回 market_email_ok 給 authenticated 的執行權。
-- 🔴 先把前端退回不讀這些欄位的版本(Vercel Instant Rollback)、通知信退回不寫店家法定資訊的版本,再跑這支:
--    欄位拆掉之後,還在讀它們的頁面與通知會出錯。拆掉的欄位資料不會留下(店家填的法定資訊、商品的標示、明細的快照)。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- 先換回函式(不再讀新欄位),再拆欄位。以下四支照抄原檔(函式內容一個字都不能改,測試比對 md5)
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

  -- 接受轉帳要先有轉帳資訊:只在供應商建店、或供應商的更新動到付款方式時檢查(付款方式已在上面去重排序,
  -- 順序不同不算有變)。管理員的更新(停用、啟用、改停用原因)一律不檢查 —— 供應商可以自己刪掉轉帳資訊,
  -- 若每次更新都檢查,管理員就停用不了這家店;付款方式含轉帳、轉帳資訊卻沒了的店,第 2 階段結帳本來就不能選轉帳。
  IF NOT v_admin
     AND 'transfer' = ANY (NEW.payment_methods)
     AND (TG_OP = 'INSERT' OR NEW.payment_methods IS DISTINCT FROM OLD.payment_methods)
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
           -- 店家:店名、電話給買家聯絡;suppliers.contact_email 是新訂單的通知信箱,不送到瀏覽器(第 1 階段已定案)
           'store', jsonb_build_object('supplier_id', s.supplier_id, 'name', sp.name, 'phone', sp.phone,
                                       'ship_days', s.ship_days, 'return_policy', s.return_policy),
           'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'product_name', i.product_name, 'spec', i.spec, 'unit_price', i.unit_price,
                              'qty', i.qty, 'line_total', i.line_total, 'temperature', i.temperature)
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

DROP TRIGGER IF EXISTS trg_market_order_items_snapshot ON public.market_order_items;
DROP FUNCTION IF EXISTS public.market_order_items_snapshot();

ALTER TABLE public.market_stores
  DROP CONSTRAINT IF EXISTS market_stores_service_email,
  DROP CONSTRAINT IF EXISTS market_stores_disclosure_lengths;
ALTER TABLE public.market_stores
  DROP COLUMN IF EXISTS legal_name,
  DROP COLUMN IF EXISTS representative,
  DROP COLUMN IF EXISTS business_address,
  DROP COLUMN IF EXISTS service_email,
  DROP COLUMN IF EXISTS food_registration_no,
  DROP COLUMN IF EXISTS liability_insurance;
ALTER TABLE public.market_order_items DROP COLUMN IF EXISTS withdrawal_exempt;
ALTER TABLE public.market_products DROP COLUMN IF EXISTS withdrawal_exempt;

REVOKE EXECUTE ON FUNCTION public.market_email_ok(text) FROM authenticated;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261012110000';

NOTIFY pgrst, 'reload schema';
