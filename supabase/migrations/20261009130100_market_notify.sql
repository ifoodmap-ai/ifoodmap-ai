-- =====================================================================
-- 消費者食材市集:訂單通知(DB → pg_net → Edge Function market-notify → Resend)
-- 比照 20260728100000_order_notifications.sql 的 notify_order_event:
--   - 非同步(pg_net 送出就返回),寄信失敗不會讓訂單交易 rollback
--   - 共享密鑰:沿用 app_config.notify_service_key(= Supabase secret NOTIFY_SECRET,notify 那支同一把)——
--     不新增 secret,就不會因為 supabase secrets set 讓專案上所有 Edge Function 版號 +1
--   - 網址:新增 app_config.market_notify_function_url
-- 送出的內容:
--   每一筆狀態紀錄 → {kind:'event', event_id}(market-notify 自己用 service role 讀紀錄與訂單)
--   下單成功 → {kind:'placed', checkout_id, token}(由 market_place_order 呼叫,見 20261009130200;
--     token 只在這裡出現:pg_net 寄出後佇列列就刪除,net._http_response 只存回應,market-notify 的回應不含 token)
-- 🔴 寄給真實消費者要業主核准:market-notify 在 secret MARKET_NOTIFY_LIVE 不是 "true" 時,所有信只寄 ifoodmaptw@gmail.com。
-- 測試:supabase/tests/database/market_notify.test.sql(把網址換成 http://127.0.0.1:9/… 再 ROLLBACK,佇列不會真的送出)
-- =====================================================================
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.market_enqueue_notify(p_body jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, extensions
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  SELECT value INTO v_url FROM public.app_config WHERE key = 'market_notify_function_url';
  SELECT value INTO v_key FROM public.app_config WHERE key = 'notify_service_key';
  -- 沒設定就安靜跳過 —— 不要因為通知沒接好就讓下單失敗
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := p_body,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  -- 通知出任何問題都不能影響訂單
  RAISE WARNING 'market_enqueue_notify failed: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.market_notify_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.market_enqueue_notify(jsonb_build_object('kind', 'event', 'event_id', NEW.id));
  RETURN NULL;
END;
$$;

-- 名稱字母序排在 trg_market_apply_event 後面:先套用狀態、再排通知
DROP TRIGGER IF EXISTS trg_market_notify_event ON public.market_order_events;
CREATE TRIGGER trg_market_notify_event
AFTER INSERT ON public.market_order_events
FOR EACH ROW EXECUTE FUNCTION public.market_notify_event();

INSERT INTO public.app_config (key, value)
VALUES ('market_notify_function_url', 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON FUNCTION public.market_enqueue_notify(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_notify_event() FROM PUBLIC, anon, authenticated;
