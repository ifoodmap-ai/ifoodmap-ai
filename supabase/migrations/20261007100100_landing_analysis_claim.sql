-- =====================================================================
-- 形象站 AI 對話 → 註冊後自動變成採購單草稿(2026-10-07 業主拍板)
-- (說明與部署 / 還原步驟見 docs/DEPLOY.md「AI 防濫用與註冊導流」)
--
-- 流程:
--   1. 陌生訪客在 ifoodmap.ai 跟 AI 聊需求 / 傳菜單。ai Edge Function(landing tier)每存一筆 analysis_records,
--      就產生一組 claimToken(32 bytes 隨機值的 base64url)回給前端;DB 只存 claim_token_hash = sha256 hex。
--   2. 訪客點「免費註冊」,形象站把 <analysisId>.<claimToken> 放在網址 # 片段帶到產品站。
--   3. 註冊完、第一次進到 /restaurant 時,產品站呼叫 claim_landing_analysis(p_handoff, p_restaurant_id):
--      驗證 token → 用那筆的食材清單建一張 supplier_orders(status = 'draft')→ 記下認領資訊。
--
-- 認領規則(條件都在同一個交易、鎖住那筆 analysis 之後判斷):
--   - 店家(SPEC 修訂 2 R2):有帶 p_restaurant_id(產品站一律帶目前畫面上那家店)→ 呼叫者必須是那家店「已接受、啟用中」的成員,
--     branch_id 取自那筆成員資格;沒帶 → 取最近接受的那一家。待接受的邀請不算成員。找不到 → no_restaurant
--     (no_restaurant 時前端會保留 handoff 下次再試,所以這個判斷在驗 token 之前)
--   - 只有這一個兩參數的版本(p_restaurant_id 預設 NULL):單參數版若並存,只帶 p_handoff 的呼叫 PostgREST 會不知道該用哪一版
--   - token hash 相符、尚未認領、7 天內建立、source_type ∈ {chatbot, menu_upload}、status = pending_review → 否則 expired_or_used
--   - 同一家店重複認領 → ok + already:true + 原 order_id(冪等)
--   - 格式不對 → invalid
--   一律回 200 + jsonb,用 ok / reason 表達結果,不 raise。
--
-- 建單:照產品站 RestaurantPurchasePage 建草稿的方式 —— restaurant_id / branch_id / created_by = auth.uid() /
--   ingredient_list(轉成產品站購物車格式 {name, quantity(字串), unit(字串), source:'ai'})/ status 'draft' /
--   notes 'AI 採購助手帶入';另外帶 analysis_id,後台訂單頁才對得到來源對話(AdminOrderTimelinePage)。
--   只建 draft:不送出、不寫 order_events,之後要送出照原本的簽核 / 狀態機走。食材清單是空的 → 只標記認領、order_id null。
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. analysis_records:認領用的欄位(全部可為 NULL、沒有預設值,不動既有欄位與資料)
-- ---------------------------------------------------------------------
ALTER TABLE public.analysis_records
  ADD COLUMN IF NOT EXISTS claim_token_hash      text,
  ADD COLUMN IF NOT EXISTS claimed_at            timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_restaurant_id uuid REFERENCES public.restaurants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_order_id      uuid REFERENCES public.supplier_orders(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.analysis_records'::regclass AND conname = 'analysis_records_claim_token_hash_format'
  ) THEN
    ALTER TABLE public.analysis_records
      ADD CONSTRAINT analysis_records_claim_token_hash_format
      CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$');
  END IF;
END;
$$;

COMMENT ON COLUMN public.analysis_records.claim_token_hash IS
  '形象站 landing tier 存檔時產生的 claimToken 的 sha256 hex(token 本身只在 ai 的回應裡出現一次)';
COMMENT ON COLUMN public.analysis_records.claimed_at IS '被 claim_landing_analysis 認領的時間';
COMMENT ON COLUMN public.analysis_records.claimed_restaurant_id IS '認領的餐廳';
COMMENT ON COLUMN public.analysis_records.claimed_order_id IS '認領時建立的採購單草稿(食材清單是空的就是 NULL)';

-- ---------------------------------------------------------------------
-- 2. 認領 RPC(產品站登入後呼叫)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_landing_analysis(text);
CREATE OR REPLACE FUNCTION public.claim_landing_analysis(p_handoff text, p_restaurant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_handoff    text := btrim(COALESCE(p_handoff, ''));
  v_id         uuid;
  v_hash       text;
  v_restaurant uuid;
  v_branch     uuid;
  v_rec        public.analysis_records%ROWTYPE;
  v_items      jsonb;
  v_order      uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- <analysisId>.<claimToken>:uuid + 43 字元 base64url
  IF char_length(v_handoff) > 100
     OR v_handoff !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.[A-Za-z0-9_-]{43}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;
  v_id   := split_part(v_handoff, '.', 1)::uuid;
  v_hash := encode(sha256(convert_to(split_part(v_handoff, '.', 2), 'UTF8')), 'hex');

  -- 呼叫者是哪家店的成員(跟 current_restaurant_ids() 同一個定義:啟用中、已接受)。
  -- 有指定店家就只認那一家;沒指定取最近接受的那一家。branch_id 一律取自那筆成員資格
  SELECT ra.restaurant_id, ra.branch_id
    INTO v_restaurant, v_branch
    FROM public.restaurant_accounts ra
   WHERE ra.user_id = v_uid
     AND ra.is_active
     AND ra.accepted_at IS NOT NULL
     AND (p_restaurant_id IS NULL OR ra.restaurant_id = p_restaurant_id)
   ORDER BY ra.accepted_at DESC, ra.created_at DESC, ra.id DESC
   LIMIT 1;
  IF v_restaurant IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_restaurant');
  END IF;

  -- 鎖住那筆:同一個 token 並發認領時,後到的人會看到已認領
  SELECT * INTO v_rec FROM public.analysis_records WHERE id = v_id FOR UPDATE;
  IF NOT FOUND OR v_rec.claim_token_hash IS NULL OR v_rec.claim_token_hash <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired_or_used');
  END IF;

  IF v_rec.claimed_at IS NOT NULL THEN
    IF v_rec.claimed_restaurant_id = v_restaurant THEN
      RETURN jsonb_build_object('ok', true, 'order_id', v_rec.claimed_order_id, 'already', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired_or_used');
  END IF;

  IF v_rec.created_at < now() - interval '7 days'
     OR v_rec.status IS DISTINCT FROM 'pending_review'
     OR v_rec.source_type NOT IN ('chatbot', 'menu_upload') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired_or_used');
  END IF;

  -- 轉成產品站購物車的格式;同名(不分大小寫)只留第一筆,最多 200 項
  SELECT COALESCE(jsonb_agg(d.item ORDER BY d.ord), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT u.ord, u.item
        FROM (
          SELECT DISTINCT ON (lower(x.name))
                 x.ord,
                 jsonb_strip_nulls(jsonb_build_object(
                   'name',     x.name,
                   'quantity', x.quantity,
                   'unit',     x.unit,
                   'source',   'ai',
                   'category', x.category
                 )) AS item
            FROM (
              SELECT e.ord,
                     left(btrim(e.value->>'name'), 100)                                   AS name,
                     left(btrim(COALESCE(e.value->>'quantity', '')), 30)                  AS quantity,
                     left(btrim(COALESCE(e.value->>'unit', '')), 30)                      AS unit,
                     NULLIF(left(btrim(COALESCE(e.value->>'category', '')), 30), '')      AS category
                FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(v_rec.ingredient_list) = 'array'
                            THEN v_rec.ingredient_list ELSE '[]'::jsonb END
                     ) WITH ORDINALITY AS e(value, ord)
               WHERE jsonb_typeof(e.value) = 'object'
                 AND NULLIF(btrim(e.value->>'name'), '') IS NOT NULL
            ) x
           ORDER BY lower(x.name), x.ord
        ) u
       ORDER BY u.ord
       LIMIT 200
    ) d;

  IF jsonb_array_length(v_items) > 0 THEN
    -- 跟 RLS 的 restaurant_create_own_orders 同一組條件:自己的店、沒有供應商、只能是 draft
    INSERT INTO public.supplier_orders
      (restaurant_id, branch_id, created_by, ingredient_list, status, notes, analysis_id)
    VALUES
      (v_restaurant, v_branch, v_uid, v_items, 'draft', 'AI 採購助手帶入', v_id)
    RETURNING id INTO v_order;
  END IF;

  UPDATE public.analysis_records
     SET claimed_at            = now(),
         claimed_restaurant_id = v_restaurant,
         claimed_order_id      = v_order,
         user_id               = COALESCE(user_id, v_uid),
         updated_at            = now()
   WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order, 'already', false);
END;
$$;

COMMENT ON FUNCTION public.claim_landing_analysis(text, uuid) IS
  '形象站 AI 對話的認領:p_handoff = <analysisId>.<claimToken>,p_restaurant_id = 認領到哪家店(NULL = 最近接受的那家)。'
  '成功時建一張 status=draft 的 supplier_orders。回傳 {ok:true, order_id, already} 或 {ok:false, reason: invalid|no_restaurant|expired_or_used},不 raise。只給 authenticated。';

REVOKE ALL ON FUNCTION public.claim_landing_analysis(text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.claim_landing_analysis(text, uuid) TO authenticated;
