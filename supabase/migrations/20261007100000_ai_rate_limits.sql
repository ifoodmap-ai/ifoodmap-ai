-- =====================================================================
-- AI 防濫用:原子化限流計數、被擋統計、ai_usage 加 tier / thoughts_tokens、每日清理排程
-- (2026-10-07 業主拍板;說明與部署 / 還原步驟見 docs/DEPLOY.md「AI 防濫用與註冊導流」)
--
-- 為什麼要有:
--   Edge Function `ai` 原本沒有身分驗證、限流、字數或輸出上限,任何人都能繞過網站直接打。
--   ai 改成分三種呼叫者(形象站代理 landing / 登入使用者 user / 過渡期舊前端 legacy),每種有自己的額度,
--   數字在 supabase/functions/ai/guard.ts。計數放資料庫,由這支 migration 的 RPC 原子化加一。
--
-- 設計:
--   - ai_rate_counters(bucket, window_start, hits):固定窗格。10 分鐘窗格以 UTC 每 10 分鐘對齊;
--     「每天」= 台北時間(Asia/Taipei)日曆日。bucket 後面會接上 |10m 或 |day(台北午夜 = UTC 16:00,
--     剛好也是一個 10 分鐘窗格的起點,不分開的話兩種窗格會撞在同一列)。
--   - ai_rate_take(p_tier, p_action, p_rules):一次帶入這個請求要吃的全部額度(個人 10 分鐘、個人每日、全站每日)。
--     INSERT … ON CONFLICT DO UPDATE 會鎖住那一列:同一個 bucket 的並發請求排隊加一,不會各自讀到舊值而超量。
--     任何一條超過上限就整批退回(子交易 rollback)—— 被擋的請求不吃額度。固定照 bucket 排序上鎖,兩個請求不會互等。
--   - ai_guard_daily(day, tier, action, code, hits):被擋的請求按台北日統計。
--     ai_rate_take 擋下的(RATE_LIMITED / DAILY_CAP / IMAGE_NOT_STORED)在同一個交易裡記;
--     Edge Function 自己擋的(UNAUTHORIZED / TOO_LONG / …)在記憶體累計、最多每 60 秒呼叫一次 ai_note_rejection(p_hits = 累計數)
--     —— 所以這些碼是近似值(isolate 被回收前沒寫到的會漏)。tier / action / code 都走白名單,列數有上限。
--   - 每日清理:pg_cron 每天 19:40 UTC(台北 03:40)刪 2 天前的計數、90 天前的統計。
--
-- 權限:兩張表開 RLS、對 anon / authenticated 收回全部權限(ai_guard_daily 另給平台管理員唯讀);
--   三支函式只有 service_role(與資料庫擁有者 / 排程)能執行,函式裡再擋一次。
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. ai_usage:呼叫者分級與思考 token(Gemini usageMetadata.thoughtsTokenCount,按輸出計價)
-- ---------------------------------------------------------------------
ALTER TABLE public.ai_usage
  ADD COLUMN IF NOT EXISTS tier text,
  ADD COLUMN IF NOT EXISTS thoughts_tokens integer;

COMMENT ON COLUMN public.ai_usage.tier IS
  '呼叫者分級:landing(形象站代理)/ user(登入使用者)/ legacy(過渡期舊前端);2026-10-07 之前的列是 NULL';
COMMENT ON COLUMN public.ai_usage.thoughts_tokens IS
  'Gemini usageMetadata.thoughtsTokenCount(思考 token,跟輸出 token 同價)';

-- ---------------------------------------------------------------------
-- 2. 計數表與被擋統計
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_rate_counters (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         bigint      NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start),
  CONSTRAINT ai_rate_counters_bucket_len CHECK (char_length(bucket) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS ai_rate_counters_window_start_idx ON public.ai_rate_counters (window_start);

COMMENT ON TABLE public.ai_rate_counters IS
  'AI 限流計數(固定窗格)。只由 ai_rate_take 寫入;每天由 ai_guard_cleanup 清掉 2 天前的列。IP 只以 HMAC 前 16 hex 出現在 bucket 裡。';

CREATE TABLE IF NOT EXISTS public.ai_guard_daily (
  day        date        NOT NULL,
  tier       text        NOT NULL,
  action     text        NOT NULL,
  code       text        NOT NULL,
  hits       integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, tier, action, code)
);

COMMENT ON TABLE public.ai_guard_daily IS
  'AI 被擋的請求按台北日統計(day = 台北日期)。code = 回給呼叫端的錯誤碼;IMAGE_NOT_STORED = 超過每日圖片存檔額度(紀錄照存、不存圖)。';

ALTER TABLE public.ai_rate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_guard_daily   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_rate_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ai_guard_daily   FROM PUBLIC, anon, authenticated;

-- 後台之後要顯示「今天擋了多少」:只開給平台管理員讀
GRANT SELECT ON TABLE public.ai_guard_daily TO authenticated;
DROP POLICY IF EXISTS "ai guard daily admin read" ON public.ai_guard_daily;
CREATE POLICY "ai guard daily admin read" ON public.ai_guard_daily
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ---------------------------------------------------------------------
-- 3. 記被擋的次數(Edge Function 擋下的請求批次寫入;ai_rate_take 擋下的也走這裡,一次 1)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.ai_note_rejection(text, text, text);
CREATE OR REPLACE FUNCTION public.ai_note_rejection(p_tier text, p_action text, p_code text, p_hits integer DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'ai_note_rejection: service_role only' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.ai_guard_daily AS g (day, tier, action, code, hits, updated_at)
  VALUES (
    (now() AT TIME ZONE 'Asia/Taipei')::date,
    CASE WHEN p_tier IN ('landing', 'user', 'legacy', 'none') THEN p_tier ELSE 'other' END,
    CASE WHEN p_action IN ('analyze-menu', 'analyze-chat', 'chat', 'parse-delivery-note', 'parse-catalog',
                           'dish-ideas', 'quote-draft', 'unknown') THEN p_action ELSE 'other' END,
    CASE WHEN p_code IN ('UNAUTHORIZED', 'ACTION_NOT_ALLOWED', 'TOO_LONG', 'IMAGE_TOO_LARGE', 'BODY_TOO_LARGE',
                         'UNSUPPORTED_IMAGE', 'RATE_LIMITED', 'CONVERSATION_LIMIT', 'DAILY_CAP',
                         'IMAGE_NOT_STORED') THEN p_code ELSE 'OTHER' END,
    LEAST(GREATEST(COALESCE(p_hits, 1), 1), 1000000),
    now()
  )
  ON CONFLICT (day, tier, action, code)
  DO UPDATE SET hits = g.hits + EXCLUDED.hits, updated_at = EXCLUDED.updated_at;
END;
$$;

COMMENT ON FUNCTION public.ai_note_rejection(text, text, text, integer) IS
  'AI 被擋的請求計數(ai_guard_daily),p_hits = 這次要加幾次(Edge Function 批次寫入)。只給 service_role。';

-- ---------------------------------------------------------------------
-- 4. 原子化限流
--    p_rules = [{bucket, window: "10m"|"day", limit, code: "RATE_LIMITED"|"DAILY_CAP"|"IMAGE_NOT_STORED", cost?}](1–8 條)
--    回傳 {ok: true} 或 {ok: false, code, retry_after(秒), failed: [...]};同時超過時 DAILY_CAP 優先。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_rate_take(p_tier text, p_action text, p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_rule   jsonb;
  v_bucket text;
  v_window text;
  v_code   text;
  v_limit  bigint;
  v_cost   bigint;
  v_start  timestamptz;
  v_end    timestamptz;
  v_hits   bigint;
  v_failed jsonb := '[]'::jsonb;
  v_pick   text;
  v_retry  integer;
BEGIN
  -- 權限已收回到只剩 service_role;這裡再擋一次,免得之後有人誤開 grant
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'ai_rate_take: service_role only' USING ERRCODE = '42501';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array'
     OR jsonb_array_length(p_rules) < 1 OR jsonb_array_length(p_rules) > 8 THEN
    RAISE EXCEPTION 'ai_rate_take: p_rules must be an array of 1..8 rules' USING ERRCODE = '22023';
  END IF;

  BEGIN  -- 子交易:任何一條超額就整批退回
    FOR v_rule IN
      SELECT r.value
        FROM jsonb_array_elements(p_rules) AS r(value)
       ORDER BY r.value->>'bucket', r.value->>'window'   -- 固定上鎖順序
    LOOP
      IF jsonb_typeof(v_rule) <> 'object'
         OR jsonb_typeof(v_rule->'limit') IS DISTINCT FROM 'number'
         OR (v_rule ? 'cost' AND jsonb_typeof(v_rule->'cost') IS DISTINCT FROM 'number') THEN
        RAISE EXCEPTION 'ai_rate_take: invalid rule %', v_rule USING ERRCODE = '22023';
      END IF;
      v_bucket := v_rule->>'bucket';
      v_window := v_rule->>'window';
      v_code   := COALESCE(v_rule->>'code', 'RATE_LIMITED');
      v_limit  := floor((v_rule->>'limit')::numeric)::bigint;
      v_cost   := COALESCE(ceil((v_rule->>'cost')::numeric)::bigint, 1);
      IF v_bucket IS NULL OR char_length(v_bucket) NOT BETWEEN 1 AND 190
         OR v_window IS NULL OR v_window NOT IN ('10m', 'day')
         OR v_limit < 0 OR v_cost < 1
         OR v_code NOT IN ('RATE_LIMITED', 'DAILY_CAP', 'IMAGE_NOT_STORED') THEN
        RAISE EXCEPTION 'ai_rate_take: invalid rule %', v_rule USING ERRCODE = '22023';
      END IF;

      IF v_window = '10m' THEN
        v_start := date_bin('10 minutes', v_now, timestamptz '2000-01-01 00:00:00+00');
        v_end   := v_start + interval '10 minutes';
      ELSE
        -- 台北日曆日:台北午夜 ~ 隔天台北午夜
        v_start := (date_trunc('day', v_now AT TIME ZONE 'Asia/Taipei')) AT TIME ZONE 'Asia/Taipei';
        v_end   := v_start + interval '1 day';
      END IF;

      INSERT INTO public.ai_rate_counters AS c (bucket, window_start, hits, updated_at)
      VALUES (v_bucket || '|' || v_window, v_start, v_cost, v_now)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET hits = c.hits + EXCLUDED.hits, updated_at = EXCLUDED.updated_at
      RETURNING c.hits INTO v_hits;

      IF v_hits > v_limit THEN
        v_failed := v_failed || jsonb_build_array(jsonb_build_object(
          'bucket', v_bucket,
          'window', v_window,
          'code', v_code,
          'limit', v_limit,
          'retry_after', GREATEST(1, ceil(extract(epoch FROM (v_end - v_now)))::integer)
        ));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_failed) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'IFM01', MESSAGE = 'ai_rate_take: over limit';
    END IF;
  EXCEPTION WHEN SQLSTATE 'IFM01' THEN
    NULL;  -- 子交易已 rollback:這次的加一全部退回(區域變數 v_failed 保留)
  END;

  IF jsonb_array_length(v_failed) = 0 THEN
    RETURN jsonb_build_object('ok', true);
  END IF;

  v_pick := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = 'DAILY_CAP') THEN 'DAILY_CAP'
    ELSE v_failed->0->>'code'
  END;
  SELECT max((f->>'retry_after')::integer) INTO v_retry
    FROM jsonb_array_elements(v_failed) f
   WHERE f->>'code' = v_pick;

  PERFORM public.ai_note_rejection(p_tier, p_action, v_pick);
  RETURN jsonb_build_object('ok', false, 'code', v_pick, 'retry_after', v_retry, 'failed', v_failed);
END;
$$;

COMMENT ON FUNCTION public.ai_rate_take(text, text, jsonb) IS
  'AI 原子化限流:一次吃掉這個請求的全部額度,任何一條超過就整批退回並記進 ai_guard_daily。只給 service_role。';

-- ---------------------------------------------------------------------
-- 5. 每日清理(排程以資料庫擁有者身分跑、沒有 JWT;登入的使用者就算拿到執行權也不行)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_guard_cleanup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_counters integer;
  v_daily    integer;
BEGIN
  IF auth.uid() IS NOT NULL OR COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION '只有系統排程可以執行 AI 計數清理' USING ERRCODE = '42501', HINT = 'system_only';
  END IF;

  DELETE FROM public.ai_rate_counters WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS v_counters = ROW_COUNT;

  DELETE FROM public.ai_guard_daily WHERE day < (now() AT TIME ZONE 'Asia/Taipei')::date - 90;
  GET DIAGNOSTICS v_daily = ROW_COUNT;

  RETURN jsonb_build_object('counters_deleted', v_counters, 'daily_deleted', v_daily, 'ran_at', now());
END;
$$;

COMMENT ON FUNCTION public.ai_guard_cleanup() IS
  '每天清掉 2 天前的 ai_rate_counters 與 90 天前的 ai_guard_daily(pg_cron:ifoodmap-ai-guard-cleanup)。';

-- ---------------------------------------------------------------------
-- 6. 權限:只有 service_role(與擁有者)能執行
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.ai_note_rejection(text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_rate_take(text, text, jsonb)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_guard_cleanup()                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_note_rejection(text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_rate_take(text, text, jsonb)      TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_guard_cleanup()                   TO service_role;

-- ---------------------------------------------------------------------
-- 7. 排程:每天 19:40 UTC(台北 03:40,錯開 19:00 的逾時排程)。同名排程已存在時 cron.schedule 會直接更新
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'ifoodmap-ai-guard-cleanup',
  '40 19 * * *',
  $cron$SELECT public.ai_guard_cleanup();$cron$
);
