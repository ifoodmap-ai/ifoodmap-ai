-- =====================================================================
-- 還原 20261012100000_market_hardening:
--   market_client_ip、market_rate_take(20261009130200 的版本)與 market_guard_event(20261009130000 的版本)換回原樣
--   (逐字照抄;測試用 md5 比對線上套用前的定義),拆掉逾時自動取消 market_expire_orders 與排程 ifoodmap-market-expire-orders。
-- 已經被自動取消的訂單不會復原(狀態紀錄只能新增);還原之後沒有逾時取消,待接單、待匯款會一直留著。
-- 還原之後 IP 又會退回 x-forwarded-for 第一段(偽造得了)、被擋的請求又是同步 commit。
-- 🔴 先把前端退回不顯示自動取消期限的版本(Vercel Instant Rollback),通知信也要退回不寫期限的版本,再跑這支。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- 先停排程,再拆它呼叫的函式
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ifoodmap-market-expire-orders';
DROP FUNCTION IF EXISTS public.market_expire_orders();

-- 以下三支照抄原檔(函式內容一個字都不能改,測試比對 md5)
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
         OR split_part(v_bucket, ':', 1) = ''   -- 冒號前的種類是擋下紀錄的 rule,不能是空的
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
          'code', v_code, 'rule', split_part(v_bucket, ':', 1),
          'retry_after', GREATEST(1, ceil(extract(epoch FROM (v_end - v_now)))::integer)));
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
  -- 擋下紀錄:這次被哪幾種規則擋下,每種 +1(同一種的兩條一起擋下也只算 1)。寫在上面的子交易之外,
  -- 才不會跟著計數一起退回;依種類排序寫,同時被擋的請求鎖這張表的順序固定
  INSERT INTO public.market_rate_blocks_daily AS b (day, rule, hits)
  SELECT (v_now AT TIME ZONE 'Asia/Taipei')::date, k.rule, 1
    FROM (SELECT DISTINCT f->>'rule' AS rule FROM jsonb_array_elements(v_failed) f) k
   ORDER BY k.rule
  ON CONFLICT (day, rule) DO UPDATE SET hits = b.hits + 1;
  v_pick := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = 'DAILY_CAP')
                 THEN 'DAILY_CAP' ELSE 'RATE_LIMITED' END;
  SELECT max((f->>'retry_after')::integer) INTO v_retry FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = v_pick;
  RETURN jsonb_build_object('ok', false, 'code', v_pick, 'retry_after', v_retry);
END;
$$;

CREATE OR REPLACE FUNCTION public.market_guard_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order    public.market_orders%ROWTYPE;
  v_uid      uuid := auth.uid();
  v_actor    text;
  v_carrier  text;
  v_tracking text;
  v_last     timestamptz;
BEGIN
  -- 鎖住訂單這一列:同一張單的並發操作在這裡排隊,後到的會讀到新狀態
  SELECT * INTO v_order FROM public.market_orders o WHERE o.id = NEW.order_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- 交給外鍵報錯
  END IF;

  -- 原因 / 備註:跟第 1 階段商品欄位同一套 —— 去頭尾空白連全形空白、零寬字元一起去(market_trim),
  -- 去完看不到字(market_visible)就當成沒填,所以只填全形空白或零寬字元的拒單 / 取消原因會被 reason_required 擋下。
  -- (兩支都是線性時間:100 萬字的刻意輸入實測幾十毫秒,跟 btrim 同一個量級,不用先粗擋長度)
  NEW.note := CASE WHEN public.market_visible(NEW.note) THEN public.market_trim(NEW.note) END;
  NEW.actor_id := v_uid;

  -- 這張單上一筆紀錄的時間(NULL = 還沒有紀錄)。訂單列已經鎖住,同一張單的紀錄一筆一筆排隊寫,讀到的就是最新的
  SELECT max(e.created_at) INTO v_last FROM public.market_order_events e WHERE e.order_id = NEW.order_id;

  -- 第一筆紀錄:訂單只能由 market_place_order 建立,建好的當下(同一個交易裡)還沒有任何紀錄
  IF v_last IS NULL THEN
    IF NEW.to_status <> 'pending' OR NEW.from_status IS NOT NULL THEN
      RAISE EXCEPTION '訂單的第一筆紀錄只能是「待接單」' USING ERRCODE = '42501', HINT = 'transition_not_allowed';
    END IF;
    NEW.actor_role := 'consumer';
    NEW.payload := '{}'::jsonb;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- 身分由伺服器決定(前端送的 actor_role 不算)
  IF public.is_admin() THEN
    v_actor := 'admin';
  ELSIF v_uid IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.supplier_accounts a
           WHERE a.user_id = v_uid AND a.is_active AND a.supplier_id = v_order.supplier_id) THEN
    v_actor := 'supplier';
  ELSIF v_uid IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role' THEN
    v_actor := 'system';
  ELSE
    RAISE EXCEPTION '這張零售訂單不是你家的,不能操作' USING ERRCODE = '42501', HINT = 'not_order_party';
  END IF;
  -- 轉帳訂單接單後,market_apply_event 在同一個交易自動補的「待匯款」一律記成 system、不記 actor_id(不是接單的人)。
  -- 只認 trigger 裡送出的 INSERT(pg_trigger_depth() > 1):API 角色只能直接 INSERT(深度 1),也沒有在這幾張表建
  -- trigger 的權限(REVOKE ALL),冒充不了;上面的當事人檢查照樣要先過(送出這筆的是接單那一筆的 apply trigger)。
  IF pg_trigger_depth() > 1 AND NEW.to_status = 'awaiting_payment' AND v_order.status = 'confirmed' THEN
    v_actor := 'system';
    NEW.actor_id := NULL;
  END IF;
  NEW.actor_role := v_actor;
  -- 紀錄時間一律由伺服器決定(前端、API 送來的值都不算,system 也一樣):用 clock_timestamp() 而不是 now() ——
  -- now() 是交易開始的時間,同一個交易寫的「已接單」與自動補的「待匯款」會一模一樣,查單頁依隨機 id 排序先後就亂了。
  -- 再保證比這張單上一筆晚至少 1 微秒(同一微秒、或主機時鐘被往回調時也分得出先後)。
  NEW.created_at := GREATEST(clock_timestamp(), v_last + interval '1 microsecond');

  -- 畫面過期:前端以為的狀態跟資料庫不一樣
  IF NEW.from_status IS NOT NULL AND NEW.from_status IS DISTINCT FROM v_order.status THEN
    RAISE EXCEPTION '這張訂單已經是「%」了,畫面上的資料過期,請重新整理', public.market_order_status_label(v_order.status)
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;
  NEW.from_status := v_order.status;

  IF NOT EXISTS (
       SELECT 1 FROM public.market_transition_rules() r
        WHERE r.actor = v_actor AND r.from_status = v_order.status AND r.to_status = NEW.to_status
          AND r.payment IN ('any', v_order.payment_method)) THEN
    RAISE EXCEPTION '不能把訂單從「%」改成「%」',
        public.market_order_status_label(v_order.status), public.market_order_status_label(NEW.to_status)
      USING ERRCODE = '42501', HINT = 'transition_not_allowed';
  END IF;

  IF NEW.to_status IN ('rejected', 'cancelled') AND NEW.note IS NULL THEN
    RAISE EXCEPTION '拒單或取消要填寫原因(會告知消費者)' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;

  IF NEW.to_status = 'shipped' THEN
    -- 物流、單號跟拒單原因同一套:market_trim 去頭尾(連全形空白、零寬字元),market_visible 看不到字就當成沒填
    v_carrier  := CASE WHEN public.market_visible(NEW.payload->>'carrier') THEN public.market_trim(NEW.payload->>'carrier') END;
    v_tracking := CASE WHEN public.market_visible(NEW.payload->>'tracking_no') THEN public.market_trim(NEW.payload->>'tracking_no') END;
    IF v_carrier IS NULL OR char_length(v_carrier) > 50 THEN
      RAISE EXCEPTION '出貨要填寫物流(50 字以內)' USING ERRCODE = '22023', HINT = 'carrier_required';
    END IF;
    IF v_tracking IS NOT NULL AND char_length(v_tracking) > 100 THEN
      RAISE EXCEPTION '物流單號太長(100 字以內)' USING ERRCODE = '22023', HINT = 'tracking_too_long';
    END IF;
    NEW.payload := jsonb_strip_nulls(jsonb_build_object('carrier', v_carrier, 'tracking_no', v_tracking));
  ELSE
    NEW.payload := '{}'::jsonb;
  END IF;

  RETURN NEW;
END;
$$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261012100000';

NOTIFY pgrst, 'reload schema';
