-- 第 2 階段三支還原檔照順序(130200 → 130100 → 130000)能跑、跑完乾淨;第 1 階段的表還在。
-- runner:--with-migration 130000、130100、130200,--with-rollback 130200、130100、130000(本檔在最後執行)
-- (第 1 階段的 120000 / 120100 已套用正式庫,不要再帶;「第 1 階段的表還在」查的就是線上那三張表)
-- (DROP TABLE 不會觸發逐列的 DELETE trigger;還原檔仍先拆「只能新增」的 trigger,保險)
SELECT pg_temp.expect('還原後第 2 階段的表都不在',
  (SELECT count(*)::text FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('market_orders', 'market_order_items', 'market_order_events', 'market_rate_counters')),
  '0');
SELECT pg_temp.expect('還原後第 2 階段的函式都不在',
  (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('market_place_order', 'market_checkout_status', 'market_get_orders', 'market_rate_take', 'market_rate_key', 'market_client_ip',
                      'market_normalize_ip', 'market_mask_phone', 'market_mask_email', 'market_enqueue_notify', 'market_notify_event',
                      'market_guard_event', 'market_apply_event', 'market_events_immutable', 'market_events_one_per_order',
                      'market_transition_rules', 'market_order_status_label', 'market_phone_ok', 'market_email_ok')),
  '0');
SELECT pg_temp.expect('排程與設定拆掉',
  (SELECT count(*)::text FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup') || '|' ||
  (SELECT count(*)::text FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt', 'market_notify_function_url')),
  '0|0');
SELECT pg_temp.expect('第 1 階段的表還在',
  (SELECT count(*)::text FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('market_stores', 'market_store_transfer', 'market_products')),
  '3');
