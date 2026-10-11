-- =====================================================================
-- 20261012100000_market_hardening:消費者食材市集對外開放前的資料庫收尾(第 3 階段)
-- 130000 / 130100 / 130200 已經套用,不再改原檔;這支用 CREATE OR REPLACE 換掉三支函式、新增逾時自動取消。
--
-- 1. IP 退路不再信任 X-Forwarded-For(market_client_ip,簽章不變):
--    依序認 cf-connecting-ip → x-real-ip,兩個都沒有就回 NULL(下單 RPC 算進全站共用的 noip:每小時 60、每天 300)。
--    部署時用探測函式驗過:正式請求一定帶 cf-connecting-ip,用戶端自己帶會被 Cloudflare 回 403;偽造的 X-Real-IP 會被
--    中間的 proxy 改寫成真實 IP;只有 XFF 第一段偽造得了 —— 原本兩個都沒有時退回 XFF,等於讓請求自己挑 IP 繞過限流。
--    擋下紀錄(market_rate_blocks_daily)出現 rule = 'noip' = 拿 IP 壞了(正式請求應該都有 cf-connecting-ip),要去查。
--    Cloudflare 的 Pseudo IPv4:cf-connecting-ip 落在 240.0.0.0/4、而且 cf-connecting-ipv6 是合法的 IPv6 時,改用 cf-connecting-ipv6
--    (照 /64 正規化,IPv6 的 /48 規則才接得上)。這種情形不一定會發生 —— 要看 Supabase 的 Cloudflare 有沒有開 Pseudo IPv4;
--    IPv6 實測仍是開放前待辦。
-- 2. 被擋的請求改成非同步 commit(market_rate_take):
--    被灌爆時,被擋的請求都要更新 market_rate_blocks_daily 的同一列(今天, 種類),要等前一個交易 commit(含 WAL flush)
--    才寫得進去,一個接一個排隊。擋下的那條路先 set_config('synchronous_commit', 'off', true) 再寫擋下紀錄:commit 不等
--    flush,這一列的鎖幾乎立刻放掉。取捨:資料庫當機時,最後幾百毫秒裡被擋請求的計數與擋下紀錄可能掉幾筆 —— 被擋的交易
--    不建單、不動庫存,掉了無妨。沒被擋的路完全不動:建單一定同步 commit。
--    SET LOCAL 一直到交易結束:呼叫端(market_place_order)拿到被擋就直接回傳,同一個交易不會再寫別的。
--    🔴 以後若有別的呼叫端在被擋之後還要寫重要的資料,要自己 set_config('synchronous_commit', 'on', true) 改回來。
-- 3. 逾時自動取消(market_expire_orders;pg_cron ifoodmap-market-expire-orders 每 10 分鐘):
--    待接單(pending)從下單起、待匯款(awaiting_payment)從進入待匯款(最後一筆 to_status = 'awaiting_payment' 紀錄的
--    時間)起,超過自動取消的時數就由系統寫一筆取消紀錄;已接單(貨到付款)、已收款、已出貨等其他狀態一律不動。
--    時數只定義在 market_expire_orders 裡的一個常數,旁邊那行標記給前端與通知信的測試解析(三邊一致),改時數只改那裡。
--    補庫存、通知照既有的 trigger(market_apply_event、market_notify_event),不另外寫。
--    取消紀錄的 payload 帶 {"auto_expire": "pending" | "awaiting_payment"}(通知信依它換文案)。payload 的 CHECK 只管
--    「是物件、1000 bytes 內」,不會擋;但 market_guard_event 原本把出貨以外的 payload 一律清成 {},所以這裡一起換掉 guard:
--    auto_expire 只有系統的取消能帶、值只能是 pending / awaiting_payment 而且要等於取消前的狀態,其他事件帶了就擋下(22023);
--    其餘照舊。身分照舊交給 guard:pg_cron 沒有 JWT → system,轉移表本來就允許 system 做這兩種取消。
--    並發:每張單先 FOR UPDATE SKIP LOCKED,供應商、管理員正在操作的單直接跳過,下一輪再來;乾跑是單一連線,測不到。
--    每次最多看 50 張候選、成功取消 3 張就停(配合寄信的限速;數字與理由見函式裡的常數);沒有任何狀態紀錄的單不當候選(guard 一定擋,
--    排在前面只會一直失敗、卡住後面的單)。函式設 lock_timeout = 5s:補庫存遇到被長時間鎖住的商品列時,那一張照
--    EXCEPTION 跳過、下一輪再處理,不會一直等、也不會一直鎖著已經處理過的訂單與商品。
-- 4. pg_cron 執行紀錄的清理:自動取消每 10 分鐘一次,cron.job_run_details 每天多 144 列。沿用每天的清理排程
--    ifoodmap-market-rate-cleanup(cron.alter_job 換指令,時間不變),多刪 jobname 開頭是 ifoodmap-market- 的工作超過
--    14 天的執行紀錄;別的工作的紀錄不碰。
--
-- 營運注意:
--   - market_hardening.test.sql 會在乾跑交易裡對線上資料執行取消(先把線上本來就該取消的單清掉),還會暫時換掉 guard。
--     交易最後一定 ROLLBACK、換掉的 guard 只有那個交易看得到,但跑的那幾秒會鎖住被取消的訂單與商品。開放後要跑,只能在離峰時段。
--   - 轉帳單的競態是刻意接受的:買家快到期限才匯款(例如期限前一小時)、店家過了自動取消的期限才按「已收款」,這時單已經被
--     系統取消(已取消不能再改),只能人工退款。這點會告知業主。
--
-- 還原:supabase/rollbacks/20261012100000_market_hardening.down.sql(三支函式恢復成線上原樣、拆掉新函式與排程)
-- 測試:supabase/tests/database/market_hardening.test.sql、market_hardening_rollback.test.sql
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 呼叫者 IP:不再退回 X-Forwarded-For
-- ---------------------------------------------------------------------
-- PostgREST 把請求標頭放在 request.headers。cf-connecting-ip(Cloudflare 覆寫,用戶端自己帶會被回 403)優先,
-- 其次 x-real-ip(中間的 proxy 會改寫成真實 IP);兩個都沒有回 NULL。
-- Pseudo IPv4 的回退:Cloudflare 開了 Pseudo IPv4(覆寫標頭模式)時,IPv6 用戶的 cf-connecting-ip 會被換成 240.0.0.0/4
-- (Class E,真的用戶端不可能是這個位址)的假 IPv4,真的位址放在 cf-connecting-ipv6。cf-connecting-ip 落在 240.0.0.0/4、
-- 而且 cf-connecting-ipv6 是合法的 IPv6 位址時,兩個標頭都是 Cloudflare 自己設的(用戶端自帶 CF-Connecting-IP 會被 Cloudflare
-- 擋掉,部署時實測 403 / 1000,造不出 240.x),改用 cf-connecting-ipv6、照 /64 正規化。cf-connecting-ip 是一般位址時,
-- 就算帶了 cf-connecting-ipv6 也一律不理;只有 cf-connecting-ipv6、沒有 cf-connecting-ip 也不理。
-- 這種情形不一定會發生:要看 Supabase 的 Cloudflare 有沒有開 Pseudo IPv4;IPv6 實測仍是開放前待辦。
CREATE OR REPLACE FUNCTION public.market_client_ip()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb;
  v_cf      text;
  v_cf6     text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  v_cf  := NULLIF(btrim(v_headers->>'cf-connecting-ip'), '');
  v_cf6 := NULLIF(btrim(v_headers->>'cf-connecting-ipv6'), '');
  -- Pseudo IPv4(見上面):兩個條件都成立才改用 cf-connecting-ipv6;任一個解析不了就當作不成立
  IF v_cf IS NOT NULL AND v_cf6 IS NOT NULL THEN
    BEGIN
      IF v_cf::inet << '240.0.0.0/4'::inet AND family(v_cf6::inet) = 6 AND masklen(v_cf6::inet) = 128 THEN
        RETURN public.market_normalize_ip(v_cf6);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  -- x-forwarded-for 不再用(第一段偽造得了,見檔頭);兩個都沒有回 NULL → 下單 RPC 算進全站共用的 noip
  RETURN public.market_normalize_ip(COALESCE(v_cf, NULLIF(btrim(v_headers->>'x-real-ip'), '')));
END;
$$;

-- ---------------------------------------------------------------------
-- 2. 限流:被擋的請求改成非同步 commit(其餘跟 130200 一字不差)
-- ---------------------------------------------------------------------
-- p_rules = [{bucket, window: "1h"|"day", limit, code?: "RATE_LIMITED"|"DAILY_CAP"}](1–8 條)
-- 回 {ok:true} 或 {ok:false, code, retry_after(秒)};任何一條超過就整批退回(被擋的請求不吃額度)。
-- 被擋時另外在 market_rate_blocks_daily 把擋下的規則種類加 1,而且這個交易改成非同步 commit。
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
  -- 只有被擋的這條路:這個交易改成非同步 commit(取捨見檔頭)。被擋的交易不建單,只有計數與擋下紀錄,當機時掉幾筆無妨;
  -- commit 不等 WAL flush,下面那一列(今天, 種類)的鎖幾乎立刻放掉,灌爆時不用排隊等 flush。
  -- SET LOCAL 只到這個交易結束;呼叫端(market_place_order)拿到被擋就直接回傳。沒被擋的路(上面的 RETURN)不動:建單一定同步 commit
  PERFORM set_config('synchronous_commit', 'off', true);
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

-- ---------------------------------------------------------------------
-- 3. 逾時自動取消
-- ---------------------------------------------------------------------
-- 狀態紀錄寫入前的檢查:跟 130000 一樣,只多了 auto_expire 那一段(見檔頭)
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

  -- 逾時自動取消的標記(market_expire_orders 寫的;通知信依它換文案):只有系統的取消能帶,值要等於取消前的狀態
  -- (待接單 pending / 待匯款 awaiting_payment)—— 供應商、管理員帶不得,冒充不了「系統自動取消」;其他事件帶了一樣擋下
  IF jsonb_typeof(NEW.payload) = 'object' AND NEW.payload ? 'auto_expire' THEN
    IF NEW.to_status <> 'cancelled' OR v_actor <> 'system'
       OR jsonb_typeof(NEW.payload->'auto_expire') <> 'string'
       OR NEW.payload->>'auto_expire' NOT IN ('pending', 'awaiting_payment')
       OR NEW.payload->>'auto_expire' <> v_order.status THEN
      RAISE EXCEPTION '自動取消的標記只能用在系統的逾時取消(待接單或待匯款)' USING ERRCODE = '22023', HINT = 'auto_expire_invalid';
    END IF;
    NEW.payload := jsonb_build_object('auto_expire', NEW.payload->>'auto_expire');
  ELSIF NEW.to_status = 'shipped' THEN
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

-- 待接單從下單起、待匯款從進入待匯款起,超過時數的單由系統取消。依下單時間(created_at)、id 排序,每次最多看 50 張候選、
-- 成功取消 3 張就停(配合寄信的限速);回傳這次取消了幾張。每張單包在自己的子交易:一張失敗只記 WARNING、跳過,不讓整批失敗(下一輪會再試)。
-- 沒有任何狀態紀錄的單不當候選。lock_timeout 5 秒:等不到鎖(例如被長時間鎖住的商品列)的那一張照 EXCEPTION 跳過。
-- 並發:每張單先 FOR UPDATE SKIP LOCKED —— 供應商 / 管理員正在操作的單(guard 鎖著訂單列)直接跳過、不互等,
-- 下一輪(10 分鐘後)再來;拿到鎖之後重讀一次狀態與時間(候選清單查完到上鎖之間,可能剛好被接單、取消)。
-- 乾跑是單一連線,並發測不到,靠 SKIP LOCKED 與上鎖後重讀。
-- 身分交給 guard:pg_cron 沒有 JWT → system。補庫存、通知照既有的 trigger。
CREATE OR REPLACE FUNCTION public.market_expire_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  -- @market-auto-cancel-hours 72
  c_hours  CONSTANT integer := 72;
  -- 每 10 分鐘最多 3 張,每小時最多 18 張 —— 配合寄信的限速:每張取消會寄 2 封通知信(買家、店家),Resend 預設每秒只收
  -- 2 個請求。第 3 階段審查模擬:一輪 5 張(10 封信)最後有 1–2 封寄不出去,降到 3 張(6 封)就 0 封失敗。
  -- 對現在的量綽綽有餘;量變大時先看寄信的限速再調
  c_per_run CONSTANT integer := 3;
  -- 每次最多看 50 張候選、逐張嘗試:前面幾張一直取消失敗(例如鎖不到)時,後面真正逾時的單照樣輪得到
  c_scan   CONSTANT integer := 50;
  v_cutoff timestamptz := now() - make_interval(hours => c_hours);
  v_id     uuid;
  v_status text;
  v_since  timestamptz;
  v_done   integer := 0;
BEGIN
  FOR v_id IN
    SELECT c.id FROM (
      SELECT o.id, o.created_at FROM public.market_orders o
       WHERE o.status = 'pending' AND o.created_at < v_cutoff
         -- 至少要有一筆狀態紀錄:沒有紀錄的單 guard 一定擋(第一筆只能是待接單),排在前面只會一直失敗、卡住後面的單
         AND EXISTS (SELECT 1 FROM public.market_order_events e WHERE e.order_id = o.id)
      UNION ALL
      SELECT o.id, o.created_at FROM public.market_orders o
       WHERE o.status = 'awaiting_payment'
         AND (SELECT max(e.created_at) FROM public.market_order_events e
               WHERE e.order_id = o.id AND e.to_status = 'awaiting_payment') < v_cutoff
    ) c
     ORDER BY c.created_at, c.id
     LIMIT c_scan
  LOOP
    EXIT WHEN v_done >= c_per_run;  -- 成功 c_per_run 張就停,剩下的下一輪
    BEGIN
      PERFORM 1 FROM public.market_orders o WHERE o.id = v_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        CONTINUE;  -- 有人正在操作這張單:跳過,下一輪再來
      END IF;
      -- 上鎖之後重讀(這一句的快照在拿到鎖之後,看得到剛 commit 的接單、取消)
      SELECT o.status,
             CASE o.status
               WHEN 'pending' THEN o.created_at
               WHEN 'awaiting_payment' THEN (SELECT max(e.created_at) FROM public.market_order_events e
                                              WHERE e.order_id = o.id AND e.to_status = 'awaiting_payment')
             END
        INTO v_status, v_since
        FROM public.market_orders o
       WHERE o.id = v_id;
      IF v_since IS NULL OR v_since >= v_cutoff THEN
        CONTINUE;  -- 已經不是待接單 / 待匯款,或還沒到時間
      END IF;
      INSERT INTO public.market_order_events (order_id, from_status, to_status, note, payload)
      VALUES (v_id, v_status, 'cancelled',
              CASE v_status
                WHEN 'pending' THEN format('店家超過 %s 小時沒有接單,系統自動取消', c_hours)
                ELSE format('超過 %s 小時沒有完成匯款,系統自動取消', c_hours)
              END,
              jsonb_build_object('auto_expire', v_status));
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'market_expire_orders: 訂單 % 自動取消失敗,先跳過:% (SQLSTATE %)', v_id, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  RETURN v_done;
END;
$$;

COMMENT ON FUNCTION public.market_expire_orders() IS
  '零售訂單逾時自動取消(待接單看下單時間、待匯款看進入待匯款的時間;時數見函式裡的常數)。由 pg_cron ifoodmap-market-expire-orders 每 10 分鐘呼叫,回傳取消了幾張。';

REVOKE ALL ON FUNCTION public.market_expire_orders() FROM PUBLIC, anon, authenticated;

-- 每 10 分鐘。同名排程已存在時會更新
SELECT cron.schedule(
  'ifoodmap-market-expire-orders',
  '*/10 * * * *',
  $cron$SELECT public.market_expire_orders()$cron$
);

-- ---------------------------------------------------------------------
-- 4. pg_cron 執行紀錄的清理
-- ---------------------------------------------------------------------
-- 自動取消每 10 分鐘一次,cron.job_run_details 每天多 144 列。沿用每天的清理排程 ifoodmap-market-rate-cleanup
-- (20261009130200 建的;時間不變、只換指令):原本的兩句照舊,多刪我們自己(jobname 開頭 ifoodmap-market-)的工作
-- 超過 14 天的執行紀錄,別的工作的紀錄不碰。還原檔把指令換回 130200 的原樣(逐字)
DO $do$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT j.jobid INTO v_jobid FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup';
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION '找不到排程 ifoodmap-market-rate-cleanup(應該由 20261009130200 建好)';
  END IF;
  PERFORM cron.alter_job(v_jobid, command := $cron$DELETE FROM public.market_rate_counters WHERE window_start < now() - interval '2 days';
DELETE FROM public.market_rate_blocks_daily WHERE day < (now() AT TIME ZONE 'Asia/Taipei')::date - 90;
DELETE FROM cron.job_run_details
 WHERE jobid IN (SELECT j.jobid FROM cron.job j WHERE j.jobname LIKE 'ifoodmap-market-%')
   AND COALESCE(end_time, start_time) < now() - interval '14 days'$cron$);
END
$do$;

NOTIFY pgrst, 'reload schema';
