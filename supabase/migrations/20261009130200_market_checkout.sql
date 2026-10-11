-- =====================================================================
-- 消費者食材市集:免註冊下單 RPC、token 查單 RPC、防灌單限流
--
-- market_place_order(p_checkout jsonb)(SECURITY DEFINER,anon / 登入者都能叫):
--   伺服器重新查一切,不相信瀏覽器送來的任何金額 —— 商品是否已核准上架、店家零售是否啟用、價格、庫存、
--   配送範圍、最低訂購金額、付款方式(轉帳要店家已填轉帳資訊);算運費(固定運費,小計 ≥ 免運門檻就 0)、扣庫存、
--   每家店建一張單 + 明細快照 + 第一筆紀錄(pending),同一次結帳共用一組查詢 token(DB 只存 sha256 hex)。
--   可選的 expected_totals:跟伺服器算的不一樣就回 PRICE_CHANGED(價格在你看購物車之後變了),不建單。
--   商業上的錯誤一律回 200 + {ok:false, code},不 raise —— 這樣「被擋的嘗試」也會留下限流計數。
-- market_get_orders(p_token text):用 token 換這次結帳的訂單(電話、Email 遮罩);待匯款時附上轉帳資訊。
--
-- 防灌單(market_rate_take,不沿用 ai_rate_take —— 理由見計畫「關鍵技術決定」第 1 點):
--   同一個 IP:每小時 5 次、每天 20 次(拿不到 IP 就不算這兩條)
--   同一個 Email(去 +tag、gmail 去點,沿用 supplier_mail_email_key):每小時 3 次、每天 10 次
--   同一支電話:每天 10 次;全站:每天 500 次(DAILY_CAP)
--   IP / Email / 電話只以「加鹽 sha256 前 16 hex」落地(鹽 = app_config.market_rate_salt,migration 產生,不印出來)
--   被擋的請求不吃額度;平台管理員(業主實測)不限流。
--
-- 下單開關 app_config.market_checkout_open(預設 'false'):對外開放前只有平台管理員能下單,其他人拿到 MARKET_CLOSED。
--   🔴 改成 'true' = 對外開放,待業主核准。
--
-- 前端:src/lib/market/checkout.ts(結帳)、src/lib/market/lookup.ts(查單)。
-- 還原:supabase/rollbacks/20261009130200_market_checkout.down.sql
-- 測試:supabase/tests/database/market_checkout.test.sql
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 限流計數(固定窗格;演算法照抄 20261007100000 的 ai_rate_take)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_rate_counters (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start),
  CONSTRAINT market_rate_counters_bucket_len CHECK (char_length(bucket) BETWEEN 1 AND 120)
);
CREATE INDEX IF NOT EXISTS market_rate_counters_window_idx ON public.market_rate_counters (window_start);

COMMENT ON TABLE public.market_rate_counters IS
  '零售下單限流計數(固定窗格,1h = 整點、day = 台北日)。只由 market_rate_take 寫入;每天清掉 2 天前的列。IP / Email / 電話只以加鹽雜湊出現。';

ALTER TABLE public.market_rate_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_rate_counters FROM PUBLIC, anon, authenticated;

INSERT INTO public.app_config (key, value) VALUES ('market_checkout_open', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_config (key, value) VALUES ('market_rate_salt', encode(extensions.gen_random_bytes(16), 'hex')) ON CONFLICT (key) DO NOTHING;

-- p_rules = [{bucket, window: "1h"|"day", limit, code?: "RATE_LIMITED"|"DAILY_CAP"}](1–8 條)
-- 回 {ok:true} 或 {ok:false, code, retry_after(秒)};任何一條超過就整批退回(被擋的請求不吃額度)。
-- 只給內部用(market_place_order 以擁有者身分呼叫);API 角色沒有執行權,函式裡再擋一次。
CREATE OR REPLACE FUNCTION public.market_rate_take(p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_rule   jsonb;
  v_bucket text;
  v_window text;
  v_code   text;
  v_limit  integer;
  v_start  timestamptz;
  v_end    timestamptz;
  v_hits   integer;
  v_failed jsonb := '[]'::jsonb;
  v_pick   text;
  v_retry  integer;
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'market_rate_take: internal only' USING ERRCODE = '42501';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' OR jsonb_array_length(p_rules) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'market_rate_take: p_rules must be an array of 1..8 rules' USING ERRCODE = '22023';
  END IF;

  BEGIN  -- 子交易:任何一條超額就整批退回
    FOR v_rule IN
      SELECT r.value FROM jsonb_array_elements(p_rules) AS r(value)
       ORDER BY r.value->>'bucket', r.value->>'window'   -- 固定上鎖順序,兩個請求不會互等
    LOOP
      v_bucket := v_rule->>'bucket';
      v_window := v_rule->>'window';
      v_code   := COALESCE(v_rule->>'code', 'RATE_LIMITED');
      v_limit  := CASE WHEN jsonb_typeof(v_rule->'limit') = 'number' THEN (v_rule->>'limit')::integer END;
      IF v_bucket IS NULL OR char_length(v_bucket) NOT BETWEEN 1 AND 100
         OR v_window IS NULL OR v_window NOT IN ('1h', 'day')
         OR v_limit IS NULL OR v_limit < 0
         OR v_code NOT IN ('RATE_LIMITED', 'DAILY_CAP') THEN
        RAISE EXCEPTION 'market_rate_take: invalid rule %', v_rule USING ERRCODE = '22023';
      END IF;

      IF v_window = '1h' THEN
        v_start := date_trunc('hour', v_now);
        v_end   := v_start + interval '1 hour';
      ELSE
        v_start := (date_trunc('day', v_now AT TIME ZONE 'Asia/Taipei')) AT TIME ZONE 'Asia/Taipei';
        v_end   := v_start + interval '1 day';
      END IF;

      INSERT INTO public.market_rate_counters AS c (bucket, window_start, hits, updated_at)
      VALUES (v_bucket || '|' || v_window, v_start, 1, v_now)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET hits = c.hits + 1, updated_at = EXCLUDED.updated_at
      RETURNING c.hits INTO v_hits;

      IF v_hits > v_limit THEN
        v_failed := v_failed || jsonb_build_array(jsonb_build_object(
          'code', v_code, 'retry_after', GREATEST(1, ceil(extract(epoch FROM (v_end - v_now)))::integer)));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_failed) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'IFM02', MESSAGE = 'market_rate_take: over limit';
    END IF;
  EXCEPTION WHEN SQLSTATE 'IFM02' THEN
    NULL;  -- 子交易已 rollback:這次的加一全部退回(區域變數 v_failed 保留)
  END;

  IF jsonb_array_length(v_failed) = 0 THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  v_pick := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = 'DAILY_CAP')
                 THEN 'DAILY_CAP' ELSE 'RATE_LIMITED' END;
  SELECT max((f->>'retry_after')::integer) INTO v_retry FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = v_pick;
  RETURN jsonb_build_object('ok', false, 'code', v_pick, 'retry_after', v_retry);
END;
$$;

-- 限流 bucket:<種類>:<加鹽 sha256 前 16 hex>
CREATE OR REPLACE FUNCTION public.market_rate_key(p_kind text, p_value text, p_salt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_kind || ':' || left(encode(sha256(convert_to(COALESCE(p_value, '') || '|' || COALESCE(p_salt, ''), 'UTF8')), 'hex'), 16)
$$;

-- IP 正規化:IPv6 取 /64(跟 AI 限流一樣)、IPv4 用完整位址;解析不了回 NULL
CREATE OR REPLACE FUNCTION public.market_normalize_ip(p_ip text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' THEN
    RETURN NULL;
  END IF;
  IF position(':' IN p_ip) > 0 THEN
    RETURN host(network(set_masklen(btrim(p_ip)::inet, 64)));
  END IF;
  RETURN host(btrim(p_ip)::inet);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 呼叫者 IP:PostgREST 把請求標頭放在 request.headers。
-- 優先 cf-connecting-ip(Cloudflare 會覆寫、偽造不了),其次 x-real-ip,最後 x-forwarded-for 第一段(可能被偽造)。
-- 🔴 部署後一定要跑計畫第 2 階段「部署與驗收」的 IP 標頭檢查,確認實際用到的是偽造不了的那一個。
CREATE OR REPLACE FUNCTION public.market_client_ip()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  RETURN public.market_normalize_ip(COALESCE(
    NULLIF(btrim(v_headers->>'cf-connecting-ip'), ''),
    NULLIF(btrim(v_headers->>'x-real-ip'), ''),
    NULLIF(btrim(split_part(v_headers->>'x-forwarded-for', ',', 1)), '')
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.market_rate_take(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_rate_key(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_normalize_ip(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_client_ip() FROM PUBLIC, anon, authenticated;

-- 每天 19:50 UTC(台北 03:50,錯開 19:00 的訂單逾時與 19:40 的 AI 清理)清掉 2 天前的計數。同名排程已存在時會更新
SELECT cron.schedule(
  'ifoodmap-market-rate-cleanup',
  '50 19 * * *',
  $cron$DELETE FROM public.market_rate_counters WHERE window_start < now() - interval '2 days'$cron$
);
