-- 還原 20261107100000_standing_price_orders:
-- 約定價成交停用(已經成交的訂單與履歷不動),守門函式與通知函式回到 20260929110000 的版本。
-- 先決條件:沒有執行中的 standing_accept_order。
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_guard_standing_auto_event ON public.order_events;
DROP FUNCTION IF EXISTS public.standing_accept_order(uuid);
DROP FUNCTION IF EXISTS public.guard_standing_auto_event();

CREATE OR REPLACE FUNCTION public.guard_order_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET row_security TO 'off'
AS $function$
DECLARE
  v_status        text;
  v_restaurant    uuid;
  v_supplier      uuid;
  v_uid           uuid := auth.uid();
  v_is_system     boolean;
  v_actor         text;
  v_actor_label   text;
  v_target        uuid;
  v_amount        numeric;
  v_lock_supplier uuid;
BEGIN
  -- 會用到 suppliers 外鍵的轉移(派單寫 supplier_id、出貨新增 supplier_shipments):先鎖供應商、再鎖訂單,
  -- 跟「刪供應商 → ON DELETE SET NULL 改訂單」同一個順序,兩邊不會互等
  IF NEW.to_status = 'dispatched' AND NULLIF(NEW.payload->>'supplier_id', '') IS NOT NULL THEN
    BEGIN
      v_lock_supplier := (NEW.payload->>'supplier_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lock_supplier := NULL;  -- 格式錯誤:下面會回「找不到要派單的供應商」
    END;
  ELSIF NEW.to_status = 'shipped' THEN
    SELECT o.supplier_id INTO v_lock_supplier FROM public.supplier_orders o WHERE o.id = NEW.order_id;
  END IF;
  IF v_lock_supplier IS NOT NULL THEN
    PERFORM 1 FROM public.suppliers s WHERE s.id = v_lock_supplier FOR KEY SHARE;
  END IF;

  -- 鎖住訂單這一列(apply_order_event 稍後的 UPDATE 本來就要拿同一種鎖),同一張單的並發事件在這裡排隊
  SELECT o.status, o.restaurant_id, o.supplier_id
    INTO v_status, v_restaurant, v_supplier
    FROM public.supplier_orders o
   WHERE o.id = NEW.order_id
     FOR NO KEY UPDATE;

  -- 訂單不存在:交給外鍵去報錯
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_is_system := v_uid IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role';

  -- 執行者由伺服器決定,前端送來的 actor_id 不採信;事件時間也一樣(系統身分可以補登歷史時間)
  NEW.actor_id := v_uid;
  IF NOT v_is_system THEN
    NEW.created_at := now();
  END IF;

  -- 身分必須名副其實
  IF NEW.actor_role = 'system' THEN
    IF NOT v_is_system THEN
      RAISE EXCEPTION '只有系統排程可以用「系統」身分寫訂單事件'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'system';
  ELSIF NEW.actor_role = 'admin' THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION '只有平台管理員可以用「管理員」身分操作訂單'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'admin';
  ELSIF NEW.actor_role = 'restaurant' THEN
    v_actor := CASE WHEN v_uid IS NULL THEN NULL ELSE public.restaurant_role(v_restaurant) END;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION '你不是這家餐廳的成員(或邀請還沒接受),不能操作這張訂單'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
  ELSIF NEW.actor_role = 'supplier' THEN
    IF v_uid IS NULL OR v_supplier IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.supplier_accounts a
          WHERE a.user_id = v_uid AND a.is_active AND a.supplier_id = v_supplier) THEN
      RAISE EXCEPTION '這張訂單不是派給你的供應商,不能操作'
        USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
    END IF;
    v_actor := 'supplier';
  ELSE
    -- actor_role 的 CHECK 會擋,這裡只是保險
    RAISE EXCEPTION '不認得的身分:%', NEW.actor_role USING ERRCODE = '42501', HINT = 'actor_role_mismatch';
  END IF;

  -- 履歷上顯示的「誰」與「從哪個介面」也由伺服器決定(系統身分照填,給排程/串接標示來源)
  IF NOT v_is_system THEN
    NEW.actor_label := NULLIF(auth.jwt()->>'email', '');
    NEW.source := CASE v_actor
      WHEN 'supplier' THEN 'supplier_portal'
      WHEN 'admin' THEN 'admin_portal'
      ELSE 'restaurant_portal' END;
  END IF;

  -- 畫面過期:前端以為的狀態跟資料庫不一樣
  IF NEW.from_status IS NOT NULL AND NEW.from_status IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION '這張訂單的狀態已經變成「%」,畫面上的資料過期了,請重新整理後再操作',
        public.order_status_label(v_status)
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;
  NEW.from_status := v_status;

  IF NOT EXISTS (
       SELECT 1 FROM public.order_transition_rules() r
        WHERE r.actor = v_actor AND r.from_status = v_status AND r.to_status = NEW.to_status) THEN
    v_actor_label := CASE v_actor
      WHEN 'owner' THEN '餐廳老闆' WHEN 'manager' THEN '餐廳店長' WHEN 'purchaser' THEN '餐廳採購員'
      WHEN 'supplier' THEN '供應商' WHEN 'admin' THEN '平台管理員' ELSE '系統' END;
    RAISE EXCEPTION '%不能把訂單從「%」改成「%」',
        v_actor_label, public.order_status_label(v_status), public.order_status_label(NEW.to_status)
      USING ERRCODE = '42501', HINT = 'transition_not_allowed';
  END IF;

  -- 管理員取消進行中的單、餐廳退回重新報價:一定要寫原因(記在事件備註,履歷保留;通知信會帶給對方)
  IF v_actor = 'admin' AND NEW.to_status = 'cancelled'
     AND v_status IN ('dispatched', 'sent', 'accepted', 'quoted', 'confirmed', 'shipped', 'in_transit')
     AND NULLIF(btrim(COALESCE(NEW.note, '')), '') IS NULL THEN
    RAISE EXCEPTION '取消進行中的訂單要填寫原因' USING ERRCODE = '22023', HINT = 'cancel_reason_required';
  END IF;
  IF v_actor IN ('owner', 'manager') AND v_status = 'quoted' AND NEW.to_status = 'accepted'
     AND NULLIF(btrim(COALESCE(NEW.note, '')), '') IS NULL THEN
    RAISE EXCEPTION '退回重新報價要填寫原因(會轉告供應商)' USING ERRCODE = '22023', HINT = 'requote_reason_required';
  END IF;

  -- 出貨:先鎖的是訂單「當時」的供應商;鎖完訂單發現已經換了(管理員剛改過),當成畫面過期
  IF NEW.to_status = 'shipped' AND v_supplier IS DISTINCT FROM v_lock_supplier THEN
    RAISE EXCEPTION '這張訂單的供應商剛剛變更,畫面上的資料過期了,請重新整理後再操作'
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;

  -- 派單:指定的供應商必須存在(是否啟用由派單畫面篩選)
  IF NEW.to_status = 'dispatched' AND NEW.payload ? 'supplier_id' THEN
    BEGIN
      v_target := (NEW.payload->>'supplier_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_target := NULL;
    END;
    IF v_target IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = v_target) THEN
      RAISE EXCEPTION '找不到要派單的供應商' USING ERRCODE = '22023', HINT = 'invalid_supplier';
    END IF;
  END IF;

  -- 報價:一定要有大於 0 的金額;統一存成 payload.total_amount(20260929100100 會同步到訂單)
  IF NEW.to_status = 'quoted' THEN
    BEGIN
      v_amount := COALESCE(NEW.payload->>'total_amount', NEW.payload->>'amount')::numeric;
    EXCEPTION WHEN OTHERS THEN
      v_amount := NULL;
    END;
    IF v_amount IS NULL OR NOT (v_amount > 0 AND v_amount <= 99999999) THEN
      RAISE EXCEPTION '報價金額要是大於 0 的數字' USING ERRCODE = '22023', HINT = 'invalid_quote_amount';
    END IF;
    NEW.payload := NEW.payload || jsonb_build_object('total_amount', round(v_amount, 2));

    IF NULLIF(NEW.payload->>'valid_until', '') IS NOT NULL THEN
      BEGIN
        PERFORM (NEW.payload->>'valid_until')::date;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION '報價有效日期格式不對(要是 YYYY-MM-DD)'
          USING ERRCODE = '22023', HINT = 'invalid_valid_until';
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_order_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'extensions'
AS $function$
DECLARE
  v_url  TEXT;
  v_key  TEXT;
BEGIN
  SELECT value INTO v_url FROM public.app_config WHERE key = 'notify_function_url';
  SELECT value INTO v_key FROM public.app_config WHERE key = 'notify_service_key';

  -- 沒設定就安靜跳過 —— 不要因為通知沒接好就讓下單失敗
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- pg_net 不管 WITH SCHEMA 寫什麼,函式一律建在 net schema
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := jsonb_build_object(
                 'order_id',    NEW.order_id,
                 'to_status',   NEW.to_status,
                 -- 20260929110000 起多帶這三個:notify 分辨「退回重新報價」「誰取消的」,並用 event_id 讀原因
                 'from_status', NEW.from_status,
                 'actor_role',  NEW.actor_role,
                 'event_id',    NEW.id
               ),
    timeout_milliseconds := 8000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 通知出任何問題都不能影響訂單流程
  RAISE WARNING 'notify_order_event failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_order_transition() FROM PUBLIC, anon, authenticated;

DROP TABLE IF EXISTS public.supplier_standing_agreements;
DROP FUNCTION IF EXISTS public.guard_standing_agreement();
DROP FUNCTION IF EXISTS public.standing_order_total(uuid);
DROP FUNCTION IF EXISTS public.standing_active(uuid, uuid);
