-- =====================================================================
-- 官網 AI 助手留下的需求,自動轉給符合的供應商(2026-11-18 業主要求)
--
-- 背景:首頁 AI 助手問完需求後,訪客只留 Email 的話供應商聯絡不到人,也沒有任何機制把需求交給供應商。
-- 這次:
--   1. landing_leads 多收:聯絡人姓名、配送地點、配送頻率、特殊需求、方便聯繫的時間,
--      以及「同意把聯絡方式提供給符合需求的供應商」(consent_share)
--   2. 新增 landing_leads 的處理狀態:forward_status = pending → forwarded / no_match
--   3. AFTER INSERT:consent_share = true 的 lead,依 analysis_id 的食材清單 + 配送地點,
--      比對供應商的上架品項與服務區域,挑最符合的前 10 家,寫進 supplier_leads(商機)並附上聯絡資料快照
--   4. supplier_leads:+landing_lead_id、+contact(聯絡資料快照,只有該供應商自己看得到:沿用既有「leads own」policy)
--
-- 保護:
--   - 沒勾同意(consent_share = false)的 lead 不會轉出去,維持原本「只有管理員看得到」
--   - 轉送失敗不會讓 lead 寫不進來(例外只記 WARNING,forward_status 維持 pending,可重送)
--   - anon 塞進來的 forward_status / forwarded_* 一律被 BEFORE INSERT 蓋回初始值
--   - 供應商不能改自己那筆商機的 contact / landing_lead_id
--   - 比對規則沿用既有商機頁:名稱雙向包含(兩邊都 ≥ 2 字,或完全相同)、服務區域空白或判斷不出來都算符合
-- 說明與還原步驟見 docs/DEPLOY.md「官網留言自動轉供應商」
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. landing_leads 新欄位
-- ---------------------------------------------------------------------
ALTER TABLE public.landing_leads
  ADD COLUMN IF NOT EXISTS contact_name    text,
  ADD COLUMN IF NOT EXISTS delivery_area   text,
  ADD COLUMN IF NOT EXISTS frequency       text,
  ADD COLUMN IF NOT EXISTS extra_notes     text,
  ADD COLUMN IF NOT EXISTS contact_time    text,
  ADD COLUMN IF NOT EXISTS consent_share   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forward_status  text    NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS forwarded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS forwarded_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.landing_leads.consent_share  IS '訪客勾選同意:聯絡方式提供給符合需求的供應商(false 不會轉出去)';
COMMENT ON COLUMN public.landing_leads.forward_status IS 'pending 尚未處理 / forwarded 已轉給供應商 / no_match 沒有符合的供應商(管理員人工處理)';

ALTER TABLE public.landing_leads DROP CONSTRAINT IF EXISTS landing_leads_forward_fields;
ALTER TABLE public.landing_leads ADD CONSTRAINT landing_leads_forward_fields CHECK (
      forward_status IN ('pending', 'forwarded', 'no_match')
  AND forwarded_count >= 0
  AND (contact_name  IS NULL OR char_length(contact_name)  <= 100)
  AND (delivery_area IS NULL OR char_length(delivery_area) <= 200)
  AND (frequency     IS NULL OR char_length(frequency)     <= 100)
  AND (extra_notes   IS NULL OR char_length(extra_notes)   <= 2000)
  AND (contact_time  IS NULL OR char_length(contact_time)  <= 100)
) NOT VALID;
ALTER TABLE public.landing_leads VALIDATE CONSTRAINT landing_leads_forward_fields;

-- ---------------------------------------------------------------------
-- 2. supplier_leads:來源 lead + 聯絡資料快照
-- ---------------------------------------------------------------------
ALTER TABLE public.supplier_leads
  ADD COLUMN IF NOT EXISTS landing_lead_id uuid REFERENCES public.landing_leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact         jsonb;

COMMENT ON COLUMN public.supplier_leads.contact IS '官網留言的聯絡資料快照(店名、姓名、電話、LINE、Email、配送地點、頻率、需求、方便聯繫時間);只有這家供應商與管理員看得到';

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_leads_landing
  ON public.supplier_leads (supplier_id, landing_lead_id) WHERE landing_lead_id IS NOT NULL;

-- 不用 SECURITY DEFINER:要看的是「呼叫者」的角色(current_user),定義者身分會讓判斷永遠不成立
CREATE OR REPLACE FUNCTION public.supplier_leads_guard_contact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.contact IS DISTINCT FROM OLD.contact OR NEW.landing_lead_id IS DISTINCT FROM OLD.landing_lead_id)
     AND current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'SUPPLIER_LEAD_CONTACT_READONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_supplier_leads_guard_contact ON public.supplier_leads;
CREATE TRIGGER trg_supplier_leads_guard_contact BEFORE UPDATE ON public.supplier_leads
  FOR EACH ROW EXECUTE FUNCTION public.supplier_leads_guard_contact();

-- ---------------------------------------------------------------------
-- 3. BEFORE INSERT:處理狀態一律從初始值開始(anon 不能自己填)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landing_leads_forward_prep()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.forward_status  := 'pending';
  NEW.forwarded_at    := NULL;
  NEW.forwarded_count := 0;
  NEW.contact_name    := NULLIF(btrim(NEW.contact_name), '');
  NEW.delivery_area   := NULLIF(btrim(NEW.delivery_area), '');
  NEW.frequency       := NULLIF(btrim(NEW.frequency), '');
  NEW.contact_time    := NULLIF(btrim(NEW.contact_time), '');
  NEW.extra_notes     := NULLIF(btrim(NEW.extra_notes), '');
  IF char_length(NEW.extra_notes) > 2000 THEN NEW.extra_notes := left(NEW.extra_notes, 1999) || '…'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_landing_leads_forward_prep ON public.landing_leads;
CREATE TRIGGER trg_landing_leads_forward_prep BEFORE INSERT ON public.landing_leads
  FOR EACH ROW EXECUTE FUNCTION public.landing_leads_forward_prep();
REVOKE ALL ON FUNCTION public.landing_leads_forward_prep() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. 比對 + 轉送
-- ---------------------------------------------------------------------
-- 名稱正規化:去空白、臺→台、轉小寫
CREATE OR REPLACE FUNCTION public.lead_norm(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT lower(replace(regexp_replace(COALESCE(p, ''), '\s+', '', 'g'), '臺', '台')) $$;

-- 回傳這次轉給了幾家供應商(最多 10 家);沒有勾同意、已處理過、找不到對應的 lead 都回 0
CREATE OR REPLACE FUNCTION public.forward_landing_lead(p_lead uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  l       public.landing_leads;
  v_items text[];
  v_area  text;
  v_n     integer := 0;
BEGIN
  SELECT * INTO l FROM public.landing_leads WHERE id = p_lead FOR UPDATE;
  IF NOT FOUND OR l.forward_status <> 'pending' OR NOT l.consent_share THEN RETURN 0; END IF;

  -- 需求品項:AI 助手存的那筆分析(ingredient_list 可以是 [{name}] 或 ["名稱"])
  SELECT array_agg(DISTINCT public.lead_norm(nm)) FILTER (WHERE public.lead_norm(nm) <> '')
    INTO v_items
    FROM (
      SELECT CASE jsonb_typeof(x) WHEN 'string' THEN x #>> '{}' ELSE x ->> 'name' END AS nm
        FROM public.analysis_records a,
             jsonb_array_elements(CASE WHEN jsonb_typeof(a.ingredient_list) = 'array' THEN a.ingredient_list ELSE '[]'::jsonb END) x
       WHERE a.id = l.analysis_id
    ) q;

  v_area := public.lead_norm(l.delivery_area);

  IF v_items IS NOT NULL THEN
    WITH want AS (SELECT unnest(v_items) AS item),
    hits AS (
      SELECT sp.id AS supplier_id, w.item
        FROM want w
        JOIN public.supplies s
          ON s.is_available
         AND (public.lead_norm(s.name) = w.item
              OR (char_length(public.lead_norm(s.name)) >= 2 AND char_length(w.item) >= 2
                  AND (position(w.item IN public.lead_norm(s.name)) > 0 OR position(public.lead_norm(s.name) IN w.item) > 0)))
        JOIN public.suppliers sp ON sp.id = s.supplier_id AND sp.is_active
       WHERE v_area = ''
          OR cardinality(sp.service_areas) = 0
          OR EXISTS (
               SELECT 1 FROM unnest(sp.service_areas) a
                WHERE public.lead_norm(a) <> ''
                  AND (position(public.lead_norm(a) IN v_area) > 0 OR position(v_area IN public.lead_norm(a)) > 0)
             )
    ),
    ranked AS (
      SELECT supplier_id, count(DISTINCT item) AS n, jsonb_agg(DISTINCT item) AS items
        FROM hits GROUP BY supplier_id
       ORDER BY count(DISTINCT item) DESC, supplier_id
       LIMIT 10
    ),
    ins AS (
      INSERT INTO public.supplier_leads (supplier_id, analysis_id, matched_items, score, reason, status, landing_lead_id, contact)
      SELECT r.supplier_id, l.analysis_id, r.items,
             LEAST(99, round(100.0 * r.n / cardinality(v_items))::int),
             '官網 AI 助手留言:符合 ' || r.n || ' / ' || cardinality(v_items) || ' 項',
             'new', l.id,
             jsonb_strip_nulls(jsonb_build_object(
               'company', l.company_name, 'name', l.contact_name, 'phone', l.contact_phone,
               'line', l.contact_line, 'email', l.contact_email, 'area', l.delivery_area,
               'frequency', l.frequency, 'notes', l.extra_notes, 'contact_time', l.contact_time,
               'items', l.items_text))
        FROM ranked r
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM ins;
  END IF;

  UPDATE public.landing_leads
     SET forward_status  = CASE WHEN v_n > 0 THEN 'forwarded' ELSE 'no_match' END,
         forwarded_at    = now(),
         forwarded_count = v_n
   WHERE id = l.id;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.forward_landing_lead(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.landing_leads_forward_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM public.forward_landing_lead(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- 轉送出錯不能讓 lead 本身寫不進來:狀態維持 pending,之後可重送
    RAISE WARNING 'forward_landing_lead(%) failed: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_landing_leads_forward ON public.landing_leads;
CREATE TRIGGER trg_landing_leads_forward AFTER INSERT ON public.landing_leads
  FOR EACH ROW WHEN (NEW.consent_share) EXECUTE FUNCTION public.landing_leads_forward_trg();
REVOKE ALL ON FUNCTION public.landing_leads_forward_trg() FROM PUBLIC, anon, authenticated;
