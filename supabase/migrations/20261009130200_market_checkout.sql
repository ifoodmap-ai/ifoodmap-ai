-- =====================================================================
-- 消費者食材市集:免註冊下單 RPC、token 查單 RPC、防灌單限流
--
-- market_place_order(p_checkout jsonb)(SECURITY DEFINER,anon / 登入者都能叫):
--   伺服器重新查一切,不相信瀏覽器送來的任何金額 —— 商品是否已核准上架、店家零售是否啟用、價格、庫存、
--   配送範圍、最低訂購金額、付款方式(轉帳要店家已填轉帳資訊);算運費(固定運費,小計 ≥ 免運門檻就 0)、扣庫存、
--   每家店建一張單 + 明細快照 + 第一筆紀錄(pending),同一次結帳共用一組查詢 token(DB 只存 sha256 hex)。
--   可選的 expected_totals:跟伺服器算的不一樣就回 PRICE_CHANGED(價格在你看購物車之後變了),不建單。
--   商業上的錯誤一律回 200 + {ok:false, code},不 raise —— 這樣「被擋的嘗試」也會留下 A 段的限流計數。
-- market_get_orders(p_token text):用 token 換這次結帳的訂單(電話、Email 遮罩);待匯款時附上轉帳資訊。
--
-- market_place_order 的順序:欄位檢查 → 開關 → 限流 A 段 → 購物車、商品、店家檢查與算錢 → 限流 B 段 → 建單。
--   鎖的順序因此固定:A 段的計數列 → 依 id 鎖商品(FOR UPDATE)→ B 段的計數列;A、B 的 bucket 不重疊,所有結帳同一個順序。
--
-- 下單開關 app_config.market_checkout_open(預設 'false'):對外開放前只有平台管理員能下單,其他人拿到 MARKET_CLOSED;
--   開關擋下的嘗試不寫任何計數。🔴 改成 'true' = 對外開放,待業主核准。
--
-- 防灌單(market_rate_take,不沿用 ai_rate_take —— 理由見計畫「關鍵技術決定」第 1 點);平台管理員(業主實測)不限流。
--   A 段只防灌爆:同一個網路的嘗試次數,失敗的嘗試也算(回 RATE_LIMITED)
--     ip(IPv4 用完整位址、IPv6 取 /64):每小時 30 次,不設每天 —— 手機業者的 IPv4 常是一大群人共用一個(CGNAT),
--       每天的上限會誤擋同一個出口後面的正常買家;成單另外由 B 段的 ipo / ip48o 管
--     ip48(IPv6 的 /48):每小時 200 次 —— /48 是電信、寬頻業者的共用位址池(手機、家用寬頻的 /64、/56 都從這裡切),
--       一個 /48 背後可能是成千上萬個互不相干的用戶,所以只防灌爆;嚴格的額度只算成單(B 段的 ip48o)
--     noip(拿不到 IP):全站共用一格,每小時 60 次、每天 300 次(拿得到 IP 時不加這條)。
--       正常情況一定拿得到 IP(計畫 Task 57 Step 8-2 會驗);這條只是 IP 取不到時的保險 ——
--       被觸發代表 IP 取得壞了(所有拿不到 IP 的請求共用這一格,正常買家也會被擋),要去查。
--   B 段只算成單:所有檢查都通過、準備建單時才扣,一次結帳不論幾家店都算 1;缺貨、價格變了、超過金額上限、配送不到、
--     未達最低金額等失敗都不吃這段。B 段被擋時不建單、不動庫存;A 段已經扣的照算
--     email(去 +tag、gmail 去點,沿用 supplier_mail_email_key):每小時 3 單、每天 10 單 —— 同一個買家
--     phone:每天 10 單 —— 同一個買家換了 Email 也擋得到
--     ipo(只有 IPv4):同一個 IPv4 每天 20 單;ip48o(只有 IPv6):同一個 /48 每天 20 單 —— 同一個網路的成單上限。
--       A 段為了 CGNAT、共用 /48 放寬之後一定要有這兩條,不然用假訂單吃光全站 500 單會變便宜
--     global:全站每天 500 單(DAILY_CAP)—— 總量的保險
--   A 段的 bucket(ip / ip48 / noip)跟 B 段的(email / phone / ipo / ip48o / global)名稱不重疊。
--   同一段裡任何一條超過就整段退回(被擋的那次不吃那一段的額度)。
--   IP / Email / 電話只以「加鹽 sha256 前 16 hex」落地(鹽 = app_config.market_rate_salt,migration 產生,不印出來)
--   量變大時怎麼調:另開一支 migration,用 CREATE OR REPLACE FUNCTION public.market_place_order 改 A 段、B 段的數字
--     (計數表與 market_rate_take 不用動)。窗格是整點與台北日:數字改小時,目前窗格裡已經有的計數照算,
--     下一個窗格起完全生效;要加新的一條,bucket 種類取新名字,不要跟另一段重疊。
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

-- ---------------------------------------------------------------------
-- 2. 下單
--   p_checkout = {
--     buyer: {name, phone, email, city, address, note?},
--     items: [{product_id, qty}](1–50 行,qty 1–99;同一商品合併,上限 99),
--     payments: {<supplier_id>: 'cod' | 'transfer'},
--     expected_totals?: {<supplier_id>: 畫面上的總額},
--     terms_version: 同意的服務條款版本
--   }
--   成功 → {ok:true, token, checkout_id, orders:[{id, supplier_id, total}]}
--   失敗 → {ok:false, code, …}:MARKET_CLOSED / INVALID_INPUT(field)/ RATE_LIMITED、DAILY_CAP(retry_after)/
--          EMPTY_CART / TOO_MANY_ITEMS / PRODUCT_UNAVAILABLE(products)/ OUT_OF_STOCK(products)/ TOO_MANY_STORES /
--          ORDER_TOO_LARGE(stores:任一家店的商品小計(不含運費)超過 1,000,000)/
--          NOT_DELIVERABLE(stores)/ BELOW_MINIMUM(stores)/ PAYMENT_NOT_ACCEPTED(stores)/ PRICE_CHANGED(stores)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_place_order(p_checkout jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_admin     boolean := public.is_admin();
  v_buyer     jsonb;
  v_items     jsonb;
  v_payments  jsonb;
  v_expected  jsonb;
  v_name      text;
  v_phone     text;
  v_email     text;
  v_city      text;
  v_address   text;
  v_note      text;
  v_terms     text;
  v_salt      text;
  v_ip        text;
  v_ip48      text;
  v_email_key text;
  v_rules     jsonb;
  v_rate      jsonb;
  v_req       jsonb;
  v_stores    jsonb;
  v_bad       jsonb;
  v_store     jsonb;
  v_order     uuid;
  v_orders    jsonb := '[]'::jsonb;
  v_checkout  uuid := gen_random_uuid();
  v_token     text;
  v_hash      text;
BEGIN
  -- 1. 形狀
  IF p_checkout IS NULL OR jsonb_typeof(p_checkout) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'checkout');
  END IF;
  v_buyer    := p_checkout->'buyer';
  v_items    := p_checkout->'items';
  v_payments := COALESCE(p_checkout->'payments', '{}'::jsonb);
  v_expected := p_checkout->'expected_totals';
  IF jsonb_typeof(v_buyer) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer');
  END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'items');
  END IF;
  IF jsonb_typeof(v_payments) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'payments');
  END IF;
  IF v_expected IS NOT NULL AND jsonb_typeof(v_expected) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'expected_totals');
  END IF;

  -- 2. 收件資料(長度與格式跟 src/lib/market/checkout.ts 一樣)
  --    姓名、地址、備註、條款版本跟第 1 階段商品欄位同一套:去頭尾空白連全形空白、零寬字元一起去(market_trim),
  --    去完看不到任何字(market_visible)就當成空的 —— 姓名、地址、條款版本被下面的長度檢查擋下,備註當成沒填。
  --    電話、Email、縣市另有格式 / 清單檢查(只收數字、ASCII、22 縣市),看不見的字元本來就過不了。
  --    (兩支都是線性時間:100 萬字的刻意輸入實測幾十毫秒,跟 btrim 同一個量級)
  v_name    := CASE WHEN public.market_visible(v_buyer->>'name') THEN public.market_trim(v_buyer->>'name') ELSE '' END;
  v_phone   := regexp_replace(COALESCE(v_buyer->>'phone', ''), '[[:space:]()-]', '', 'g');
  v_email   := lower(btrim(COALESCE(v_buyer->>'email', '')));
  v_city    := btrim(COALESCE(v_buyer->>'city', ''));
  v_address := CASE WHEN public.market_visible(v_buyer->>'address') THEN public.market_trim(v_buyer->>'address') ELSE '' END;
  v_note    := CASE WHEN public.market_visible(v_buyer->>'note') THEN public.market_trim(v_buyer->>'note') END;
  v_terms   := CASE WHEN public.market_visible(p_checkout->>'terms_version')
                    THEN public.market_trim(p_checkout->>'terms_version') ELSE '' END;
  IF char_length(v_name) NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.name');
  END IF;
  IF NOT public.market_phone_ok(v_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.phone');
  END IF;
  IF NOT public.market_email_ok(v_email) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.email');
  END IF;
  IF NOT (v_city = ANY (public.market_tw_cities())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.city');
  END IF;
  IF char_length(v_address) NOT BETWEEN 5 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.address');
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.note');
  END IF;
  IF char_length(v_terms) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'terms_version');
  END IF;

  -- 3. 開關:對外開放前只有平台管理員能下單(app_config.market_checkout_open,待業主核准才改成 'true')。
  --    放在限流之前:開關關著時被擋的嘗試不寫任何計數
  IF NOT v_admin AND COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'), '') <> 'true' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MARKET_CLOSED');
  END IF;

  -- 4. 限流 A 段:同一個網路的嘗試次數(失敗的嘗試也算);拿不到 IP 就算進全站共用的 noip。平台管理員(業主實測)不限流
  IF NOT v_admin THEN
    v_salt := COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_rate_salt'), 'ifoodmap-market-rate-fallback');
    v_ip := public.market_client_ip();
    IF v_ip IS NOT NULL THEN
      -- 同一個 IP(IPv4 完整位址、IPv6 /64)每小時 30 次:只防灌爆;CGNAT 後面很多人共用,不設每天(成單看 B 段的 ipo)
      v_rules := jsonb_build_array(
        jsonb_build_object('bucket', public.market_rate_key('ip', v_ip, v_salt), 'window', '1h', 'limit', 30)
      );
      -- IPv6 另外彙總到 /48(market_client_ip 已經把 IPv6 正規化成 /64 的網段位址):每小時 200 次,只防灌爆。
      -- /48 是很多用戶共用的位址池,嚴格的額度只算成單(第 7 步 B 段的 ip48o,每天 20 單)
      IF position(':' IN v_ip) > 0 THEN
        v_ip48 := host(network(set_masklen(v_ip::inet, 48)));
        v_rules := v_rules || jsonb_build_array(
          jsonb_build_object('bucket', public.market_rate_key('ip48', v_ip48, v_salt), 'window', '1h', 'limit', 200)
        );
      END IF;
    ELSE
      -- 拿不到 IP 時的保險:全站共用一格 noip(每小時 60、每天 300)。正常情況一定拿得到 IP(Task 57 Step 8-2 會驗),
      -- 這一格被用到就代表 IP 取得壞了,要去查
      v_rules := jsonb_build_array(
        jsonb_build_object('bucket', 'noip', 'window', '1h', 'limit', 60),
        jsonb_build_object('bucket', 'noip', 'window', 'day', 'limit', 300)
      );
    END IF;
    v_rate := public.market_rate_take(v_rules);
    IF NOT COALESCE((v_rate->>'ok')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'code', v_rate->>'code', 'retry_after', (v_rate->>'retry_after')::integer);
    END IF;
  END IF;

  -- 5. 購物車
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_CART');
  END IF;
  IF jsonb_array_length(v_items) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_MANY_ITEMS');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) AS e(value)
     WHERE jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value->>'product_id', '') !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        OR CASE WHEN jsonb_typeof(e.value->'qty') = 'number' AND (e.value->>'qty') ~ '^[0-9]{1,2}$'
                THEN (e.value->>'qty')::integer NOT BETWEEN 1 AND 99
                ELSE true END
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'items');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', r.product_id, 'qty', r.qty) ORDER BY r.product_id)
    INTO v_req
    FROM (SELECT (e.value->>'product_id')::uuid AS product_id, LEAST(sum((e.value->>'qty')::integer), 99)::integer AS qty
            FROM jsonb_array_elements(v_items) AS e(value)
           GROUP BY 1) r;

  -- 鎖住這些商品(固定照 id 排序,兩張單同時搶同一批商品不會互等),之後讀到的庫存不會被同時扣走
  PERFORM 1 FROM public.market_products p
   WHERE p.id IN (SELECT q.product_id FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer))
   ORDER BY p.id
     FOR UPDATE;

  SELECT jsonb_agg(q.product_id ORDER BY q.product_id) INTO v_bad
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
    LEFT JOIN public.market_products p ON p.id = q.product_id
   WHERE p.id IS NULL OR p.review_status <> 'approved' OR NOT p.is_listed OR NOT public.market_store_is_open(p.supplier_id);
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PRODUCT_UNAVAILABLE', 'products', v_bad);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'available', p.stock) ORDER BY p.id) INTO v_bad
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
    JOIN public.market_products p ON p.id = q.product_id
   WHERE p.stock IS NOT NULL AND p.stock < q.qty;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'OUT_OF_STOCK', 'products', v_bad);
  END IF;

  -- 6. 每家店:小計、運費(固定運費;小計 ≥ 免運門檻就 0)、配送範圍、最低金額、付款方式 —— 一律伺服器算
  SELECT jsonb_agg(jsonb_build_object(
           'supplier_id', s.supplier_id,
           'subtotal', g.subtotal,
           'shipping_fee', CASE WHEN s.free_shipping_threshold IS NOT NULL AND g.subtotal >= s.free_shipping_threshold
                                THEN 0 ELSE s.shipping_fee END,
           'min_order_amount', s.min_order_amount,
           'deliverable', v_city = ANY (s.delivery_cities),
           'payment', v_payments->>(s.supplier_id::text),
           'payment_ok', COALESCE(v_payments->>(s.supplier_id::text) = ANY (s.payment_methods), false)
                         AND (COALESCE(v_payments->>(s.supplier_id::text), '') <> 'transfer'
                              OR EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = s.supplier_id))
         ) ORDER BY s.supplier_id)
    INTO v_stores
    -- 小計用 bigint(sum(integer) 的型別):百萬元商品 ×99 × 好幾項會超過 integer,轉回 integer 會丟例外
    FROM (SELECT p.supplier_id, sum(p.price * q.qty) AS subtotal
            FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
            JOIN public.market_products p ON p.id = q.product_id
           GROUP BY p.supplier_id) g
    JOIN public.market_stores s ON s.supplier_id = g.supplier_id;

  IF jsonb_array_length(v_stores) > 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_MANY_STORES');
  END IF;

  -- 金額上限:任一家店的商品小計(不含運費)超過 1,000,000 → ORDER_TOO_LARGE(bigint 比較,不丟例外;
  -- 要放在下面任何 ::integer 轉型之前)。只看小計:一件 1,000,000 元的商品加運費照樣買得到,
  -- 最低訂購金額的上限(1,000,000)也一定達得到。market_orders_money 另有 subtotal BETWEEN 1 AND 1000000 當第二道
  SELECT jsonb_agg(jsonb_build_object('supplier_id', x.value->'supplier_id', 'subtotal', (x.value->>'subtotal')::bigint))
    INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value)
   WHERE (x.value->>'subtotal')::bigint > 1000000;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_TOO_LARGE', 'stores', v_bad);
  END IF;

  SELECT jsonb_agg(x.value->'supplier_id') INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value) WHERE NOT (x.value->>'deliverable')::boolean;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_DELIVERABLE', 'stores', v_bad);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('supplier_id', x.value->'supplier_id',
                                      'min_order_amount', x.value->'min_order_amount', 'subtotal', x.value->'subtotal'))
    INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value)
   WHERE (x.value->>'subtotal')::integer < (x.value->>'min_order_amount')::integer;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BELOW_MINIMUM', 'stores', v_bad);
  END IF;

  SELECT jsonb_agg(x.value->'supplier_id') INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value) WHERE NOT (x.value->>'payment_ok')::boolean;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_ACCEPTED', 'stores', v_bad);
  END IF;

  IF v_expected IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object('supplier_id', x.value->'supplier_id',
                                        'total', (x.value->>'subtotal')::integer + (x.value->>'shipping_fee')::integer))
      INTO v_bad
      FROM jsonb_array_elements(v_stores) AS x(value)
     WHERE (v_expected->>(x.value->>'supplier_id'))
           IS DISTINCT FROM ((x.value->>'subtotal')::integer + (x.value->>'shipping_fee')::integer)::text;
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_CHANGED', 'stores', v_bad);
    END IF;
  END IF;

  -- 7. 限流 B 段:所有檢查都通過、準備建單時才扣(上面的缺貨、價格變了、超過金額上限、配送不到、未達最低金額都不吃),
  --    一次結帳不論幾家店都算 1。商品已經在第 5 步依 id 鎖住,這裡才鎖計數列(所有結帳同一個順序)。
  --    被擋時直接回傳:不建單、不動庫存;A 段已經扣的照算(兩段各自一次 market_rate_take,只退回被擋的那一段)
  IF NOT v_admin THEN
    v_email_key := public.supplier_mail_email_key(v_email);
    v_rules := jsonb_build_array(
      jsonb_build_object('bucket', public.market_rate_key('email', v_email_key, v_salt), 'window', '1h', 'limit', 3),
      jsonb_build_object('bucket', public.market_rate_key('email', v_email_key, v_salt), 'window', 'day', 'limit', 10),
      jsonb_build_object('bucket', public.market_rate_key('phone', v_phone, v_salt), 'window', 'day', 'limit', 10),
      jsonb_build_object('bucket', 'global', 'window', 'day', 'limit', 500, 'code', 'DAILY_CAP')
    );
    -- 同一個網路的成單上限,每天 20 單:IPv6 算 /48(ip48o)、IPv4 算整個位址(ipo);拿不到 IP 就不加。
    -- 名稱跟 A 段(ip / ip48 / noip)不同,維持「A 計數 → 商品 → B 計數」不重疊
    IF v_ip48 IS NOT NULL THEN
      v_rules := v_rules || jsonb_build_array(
        jsonb_build_object('bucket', public.market_rate_key('ip48o', v_ip48, v_salt), 'window', 'day', 'limit', 20)
      );
    ELSIF v_ip IS NOT NULL THEN
      v_rules := v_rules || jsonb_build_array(
        jsonb_build_object('bucket', public.market_rate_key('ipo', v_ip, v_salt), 'window', 'day', 'limit', 20)
      );
    END IF;
    v_rate := public.market_rate_take(v_rules);
    IF NOT COALESCE((v_rate->>'ok')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'code', v_rate->>'code', 'retry_after', (v_rate->>'retry_after')::integer);
    END IF;
  END IF;

  -- 8. 建單:同一次結帳的訂單共用一組查詢 token(32 bytes 隨機值的 base64url,43 字;DB 只存 sha256 hex)
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_hash  := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  FOR v_store IN SELECT x.value FROM jsonb_array_elements(v_stores) AS x(value) LOOP
    INSERT INTO public.market_orders
      (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address, buyer_note,
       subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES
      (v_checkout, (v_store->>'supplier_id')::uuid, v_name, v_phone, v_email, v_city, v_address, v_note,
       (v_store->>'subtotal')::integer, (v_store->>'shipping_fee')::integer,
       (v_store->>'subtotal')::integer + (v_store->>'shipping_fee')::integer,
       v_store->>'payment', v_hash, v_terms)
    RETURNING id INTO v_order;

    -- stock_deducted:有設庫存的商品等一下會扣 qty(下面的 UPDATE),不限量的記 0 —— 拒單 / 取消只補這個數
    INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total, stock_deducted)
    SELECT v_order, p.id, p.name, p.spec, p.temperature, p.price, q.qty, p.price * q.qty,
           CASE WHEN p.stock IS NOT NULL THEN q.qty ELSE 0 END
      FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
      JOIN public.market_products p ON p.id = q.product_id
     WHERE p.supplier_id = (v_store->>'supplier_id')::uuid
     ORDER BY p.name, p.id;

    -- 第一筆紀錄(guard 認得「還沒有紀錄的單」= 剛建好,身分記成 consumer);trigger 會排供應商的新訂單通知
    INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (v_order, NULL, 'pending');

    v_orders := v_orders || jsonb_build_array(jsonb_build_object(
      'id', v_order,
      'supplier_id', v_store->>'supplier_id',
      'total', (v_store->>'subtotal')::integer + (v_store->>'shipping_fee')::integer));
  END LOOP;

  UPDATE public.market_products p
     SET stock = p.stock - q.qty
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
   WHERE p.id = q.product_id AND p.stock IS NOT NULL;

  -- 下單確認信(含查詢連結):只有這裡知道 token 明文
  PERFORM public.market_enqueue_notify(jsonb_build_object('kind', 'placed', 'checkout_id', v_checkout, 'token', v_token));

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'checkout_id', v_checkout, 'orders', v_orders);
END;
$$;

COMMENT ON FUNCTION public.market_place_order(jsonb) IS
  '零售市集免註冊下單:伺服器重算價格、庫存、配送範圍、最低金額、付款方式;每家店一張單;回傳查詢 token。錯誤回 {ok:false, code},不 raise。';

REVOKE ALL ON FUNCTION public.market_place_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_place_order(jsonb) TO anon, authenticated, service_role;

-- 下單開關的狀態,給前端決定要不要讓人進結帳(真正的關卡仍是 market_place_order 第 3 步)。
-- {open:對外開放了沒, can_order:這位呼叫者現在能不能下單(開放了,或是平台管理員)};不洩漏 app_config 其他內容。
CREATE OR REPLACE FUNCTION public.market_checkout_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('open', s.open, 'can_order', s.open OR public.is_admin())
    FROM (SELECT COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'), '') = 'true' AS open) s
$$;

REVOKE ALL ON FUNCTION public.market_checkout_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_checkout_status() TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. token 查單(免登入;token 格式不對、找不到都回 NOT_FOUND,不區分)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_mask_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p IS NULL OR char_length(p) < 8 THEN '***'
              ELSE left(p, 4) || repeat('*', char_length(p) - 7) || right(p, 3) END
$$;

CREATE OR REPLACE FUNCTION public.market_mask_email(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p IS NULL OR position('@' IN p) < 2 THEN '***'
              ELSE left(p, 1) || '***' || substr(p, position('@' IN p)) END
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

COMMENT ON FUNCTION public.market_get_orders(text) IS
  '用下單時拿到的 token 查那一次結帳的訂單(電話、Email 遮罩;待匯款時附轉帳資訊)。anon 可呼叫;anon 不能直接讀 market_orders。';

REVOKE ALL ON FUNCTION public.market_mask_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_mask_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_get_orders(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_get_orders(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
