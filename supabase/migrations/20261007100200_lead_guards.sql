-- =====================================================================
-- 官網表單 lead 防灌:長度檢查、Email 欄位、限流(2026-10-07 業主拍板)
-- (說明與部署 / 還原步驟見 docs/DEPLOY.md「AI 防濫用與註冊導流」)
--
-- landing_leads / partnership_leads 對 anon 開放 INSERT、沒有任何上限:任何人都能一直灌、每筆都觸發寄信給業主
-- (20260923120000_lead_notifications.sql),也能塞超大文字把 free 方案的 DB 撐滿。
--
--   Email 規則全站統一(SPEC 修訂 2 R4;DB、notify-lead 的 reply-to、形象站 widget、異業合作表單一字不差):
--     長度 ≤ 254,且符合 ^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$
--     (擋掉 a@b..c、結尾帶逗號或分號、空白、一次填多個地址)
--   landing_leads
--     - 新增 contact_email(形象站改成「註冊為主、留 Email 為輔」,不再收電話);空字串視為沒填
--     - 至少要有電話、Email、LINE 其中一種(修訂 2 R3:產品站的 ContactGate 允許只留 LINE)
--     - 其他文字欄位合理上限:識別類欄位(店名 / 電話 / LINE / 來源 / 狀態)超過就擋;
--       長文字(品項、補充說明、瀏覽器)超過就截斷 —— 不能因為對話太長就讓 lead 送不進來
--     - 限流:同一 Email(不分大小寫)、同一電話(只比數字)或同一 LINE(不分大小寫)24 小時內已有 ≥ 3 筆、或全表 24 小時內已有 ≥ 100 筆
--       → raise 'LEAD_RATE_LIMITED'(P0001;PostgREST 回 400,body.message = LEAD_RATE_LIMITED)
--   partnership_leads
--     - 同樣的長度檢查(message 超長截斷);同一 Email 24 小時內 ≥ 3 筆、或全表 ≥ 50 筆 → LEAD_RATE_LIMITED
--
-- 「24 小時內已有 ≥ N 筆」= 第 N+1 筆才擋(每 24 小時最多 N 筆)。
-- 並發:trigger 先拿 transaction advisory lock 再數,兩筆同時送也不會各自數到 N-1 而一起過。
-- 既有資料(2026-10-07 查:landing_leads 9 筆全部有電話、最長欄位 detail 478 字;partnership_leads 0 筆,所以沒有不符合新 Email 規則的)都符合;
--   constraint 先以 NOT VALID 加上(只檢查新寫入),再嘗試 VALIDATE —— 之後若有不符合的舊資料,只留 NOT VALID、不擋部署。
-- trigger 是 SECURITY DEFINER:anon 對這兩張表沒有 SELECT 權限,用呼叫者身分數會永遠數到 0。
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. landing_leads.contact_email
-- ---------------------------------------------------------------------
ALTER TABLE public.landing_leads ADD COLUMN IF NOT EXISTS contact_email text;
COMMENT ON COLUMN public.landing_leads.contact_email IS '聯絡 Email(2026-10-07 起形象站以 Email 取代電話)';

CREATE INDEX IF NOT EXISTS landing_leads_created_at_idx     ON public.landing_leads (created_at);
CREATE INDEX IF NOT EXISTS partnership_leads_created_at_idx ON public.partnership_leads (created_at);

-- ---------------------------------------------------------------------
-- 2. constraints(NOT VALID → 嘗試 VALIDATE)
-- ---------------------------------------------------------------------
ALTER TABLE public.landing_leads DROP CONSTRAINT IF EXISTS landing_leads_contact_email_format;
ALTER TABLE public.landing_leads ADD CONSTRAINT landing_leads_contact_email_format CHECK (
  contact_email IS NULL
  OR (char_length(contact_email) <= 254 AND contact_email ~ '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$')
) NOT VALID;

ALTER TABLE public.landing_leads DROP CONSTRAINT IF EXISTS landing_leads_has_contact;
ALTER TABLE public.landing_leads ADD CONSTRAINT landing_leads_has_contact CHECK (
  NULLIF(btrim(contact_phone), '') IS NOT NULL
  OR NULLIF(btrim(contact_email), '') IS NOT NULL
  OR NULLIF(btrim(contact_line), '') IS NOT NULL
) NOT VALID;

ALTER TABLE public.landing_leads DROP CONSTRAINT IF EXISTS landing_leads_field_lengths;
ALTER TABLE public.landing_leads ADD CONSTRAINT landing_leads_field_lengths CHECK (
      (company_name  IS NULL OR char_length(company_name)  <= 200)
  AND (contact_phone IS NULL OR char_length(contact_phone) <= 40)
  AND (contact_line  IS NULL OR char_length(contact_line)  <= 100)
  AND (items_text    IS NULL OR char_length(items_text)    <= 4000)
  AND (detail        IS NULL OR char_length(detail)        <= 10000)
  AND char_length(source) <= 50
  AND char_length(status) <= 30
  AND (user_agent    IS NULL OR char_length(user_agent)    <= 500)
) NOT VALID;

ALTER TABLE public.partnership_leads DROP CONSTRAINT IF EXISTS partnership_leads_contact_email_format;
ALTER TABLE public.partnership_leads ADD CONSTRAINT partnership_leads_contact_email_format CHECK (
  char_length(contact_email) <= 254 AND contact_email ~ '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$'
) NOT VALID;

ALTER TABLE public.partnership_leads DROP CONSTRAINT IF EXISTS partnership_leads_field_lengths;
ALTER TABLE public.partnership_leads ADD CONSTRAINT partnership_leads_field_lengths CHECK (
      char_length(company_name) <= 200
  AND char_length(contact_name) <= 100
  AND (job_title     IS NULL OR char_length(job_title)     <= 100)
  AND (contact_phone IS NULL OR char_length(contact_phone) <= 40)
  AND (website       IS NULL OR char_length(website)       <= 500)
  AND (partner_type  IS NULL OR char_length(partner_type)  <= 50)
  AND char_length(message) <= 5000
  AND (lang          IS NULL OR char_length(lang)          <= 20)
  AND (source        IS NULL OR char_length(source)        <= 50)
  AND (status        IS NULL OR char_length(status)        <= 30)
  AND (user_agent    IS NULL OR char_length(user_agent)    <= 500)
) NOT VALID;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('public.landing_leads',     'landing_leads_contact_email_format'),
      ('public.landing_leads',     'landing_leads_has_contact'),
      ('public.landing_leads',     'landing_leads_field_lengths'),
      ('public.partnership_leads', 'partnership_leads_contact_email_format'),
      ('public.partnership_leads', 'partnership_leads_field_lengths')
    ) AS t(tbl, con)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.con);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '% 有既有資料不符合 %,先維持 NOT VALID(新寫入照樣檢查)', c.tbl, c.con;
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. BEFORE INSERT:正規化、長文字截斷、限流
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landing_leads_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_digits text;
BEGIN
  NEW.contact_email := NULLIF(btrim(NEW.contact_email), '');
  NEW.contact_phone := NULLIF(btrim(NEW.contact_phone), '');
  NEW.contact_line  := NULLIF(btrim(NEW.contact_line), '');
  IF char_length(NEW.items_text) > 4000 THEN NEW.items_text := left(NEW.items_text, 3999) || '…'; END IF;
  IF char_length(NEW.detail)     > 10000 THEN NEW.detail     := left(NEW.detail, 9999) || '…'; END IF;
  IF char_length(NEW.user_agent) > 500 THEN NEW.user_agent := left(NEW.user_agent, 500); END IF;

  -- 同一張表的 lead 一筆一筆數(交易結束才放鎖)
  PERFORM pg_advisory_xact_lock(hashtextextended('ifoodmap:landing_leads:rate', 0));

  IF (SELECT count(*) FROM public.landing_leads WHERE created_at > now() - interval '24 hours') >= 100 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'landing_leads: 100 per 24h';
  END IF;

  IF NEW.contact_email IS NOT NULL AND (
       SELECT count(*) FROM public.landing_leads
        WHERE created_at > now() - interval '24 hours'
          AND lower(contact_email) = lower(NEW.contact_email)
     ) >= 3 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'landing_leads: 3 per email per 24h';
  END IF;

  v_digits := NULLIF(regexp_replace(COALESCE(NEW.contact_phone, ''), '[^0-9]', '', 'g'), '');
  IF v_digits IS NOT NULL AND (
       SELECT count(*) FROM public.landing_leads
        WHERE created_at > now() - interval '24 hours'
          AND regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g') = v_digits
     ) >= 3 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'landing_leads: 3 per phone per 24h';
  END IF;

  IF NEW.contact_line IS NOT NULL AND (
       SELECT count(*) FROM public.landing_leads
        WHERE created_at > now() - interval '24 hours'
          AND lower(contact_line) = lower(NEW.contact_line)
     ) >= 3 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'landing_leads: 3 per LINE id per 24h';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.partnership_leads_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.contact_email := btrim(NEW.contact_email);
  IF char_length(NEW.message)    > 5000 THEN NEW.message    := left(NEW.message, 4999) || '…'; END IF;
  IF char_length(NEW.user_agent) > 500  THEN NEW.user_agent := left(NEW.user_agent, 500); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ifoodmap:partnership_leads:rate', 0));

  IF (SELECT count(*) FROM public.partnership_leads WHERE created_at > now() - interval '24 hours') >= 50 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'partnership_leads: 50 per 24h';
  END IF;

  IF NEW.contact_email IS NOT NULL AND (
       SELECT count(*) FROM public.partnership_leads
        WHERE created_at > now() - interval '24 hours'
          AND lower(contact_email) = lower(NEW.contact_email)
     ) >= 3 THEN
    RAISE EXCEPTION 'LEAD_RATE_LIMITED' USING ERRCODE = 'P0001', HINT = 'partnership_leads: 3 per email per 24h';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.landing_leads_guard() IS
  'landing_leads BEFORE INSERT:正規化、長文字截斷、限流(同 Email / 電話 / LINE 24h ≥ 3、全表 24h ≥ 100 → LEAD_RATE_LIMITED)';
COMMENT ON FUNCTION public.partnership_leads_guard() IS
  'partnership_leads BEFORE INSERT:長文字截斷、限流(同 Email 24h ≥ 3、全表 24h ≥ 50 → LEAD_RATE_LIMITED)';

REVOKE ALL ON FUNCTION public.landing_leads_guard()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.partnership_leads_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_landing_leads_guard ON public.landing_leads;
CREATE TRIGGER trg_landing_leads_guard
BEFORE INSERT ON public.landing_leads
FOR EACH ROW EXECUTE FUNCTION public.landing_leads_guard();

DROP TRIGGER IF EXISTS trg_partnership_leads_guard ON public.partnership_leads;
CREATE TRIGGER trg_partnership_leads_guard
BEFORE INSERT ON public.partnership_leads
FOR EACH ROW EXECUTE FUNCTION public.partnership_leads_guard();
