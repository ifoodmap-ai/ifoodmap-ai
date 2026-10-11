-- =====================================================================
-- 消費者食材市集:對外開放前(與之後營運時)的現況檢查 —— 唯讀;只回數字、true / false 與不涉密的設定值(版本、排程、bucket),
-- 不印任何密鑰、鹽、個資(密鑰與鹽只檢查有沒有、格式對不對)
--   cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" \
--     node scripts/supabase-sql.mjs ro supabase/tests/database/market_launch_readiness.sql
-- 每一項的期望值、意義與遇到時怎麼處理:docs/DEPLOY.md「第 3 階段」的「開放前檢查」。
-- 欄位與函式對照 migration 20261009120000 / 120100 / 130000 / 130100 / 130200 與加固 20261012100000(套用之後 migrations 多一個版本、
-- expire_orders_cron 有值、client_ip_ignores_xff / blocked_async_commit 變 true)。不呼叫 market_store_is_open() 等只開給 API 角色的函式:
-- 唯讀端點的角色沒有執行權(42501)。
-- 時間一律用台北日(擋下紀錄 market_rate_blocks_daily 的 day 就是台北日)。
-- =====================================================================
SELECT json_build_object(
  -- ---------- 固定值(每次都應該一樣;對不上就停下來查) ----------
  'migrations', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
                  WHERE m.version IN ('20261009120000', '20261009120100', '20261009130000', '20261009130100', '20261009130200',
                                      '20261012100000')),
  'checkout_open', (SELECT c.value = 'true' FROM public.app_config c WHERE c.key = 'market_checkout_open'),
  'notify_url_ok', (SELECT c.value = 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify'
                      FROM public.app_config c WHERE c.key = 'market_notify_function_url'),
  'notify_key_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'notify_service_key' AND length(c.value) >= 20),
  'rate_salt_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'market_rate_salt' AND c.value ~ '^[0-9a-f]{32}$'),
  'rate_cleanup_cron', (SELECT j.schedule FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup'),
  'cron_cleans_blocks', (SELECT j.command LIKE '%market_rate_blocks_daily%' FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup'),
  -- 最近一次執行成功了沒(null = 還沒跑過;清理排程每天 19:50 UTC 一次)
  'rate_cleanup_last_run_ok', (SELECT d.status = 'succeeded' FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
                                WHERE j.jobname = 'ifoodmap-market-rate-cleanup' ORDER BY d.runid DESC LIMIT 1),
  'image_bucket', (SELECT json_build_object('public', b.public, 'file_size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types)
                     FROM storage.buckets b WHERE b.id = 'market-images'),
  'image_bucket_versioning', (SELECT b.versioning_status FROM storage.buckets b WHERE b.id = 'market-images'),
  'image_policies', (SELECT count(*) FROM pg_policies p
                      WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname LIKE 'market images %'),
  'anon_can_read_orders', has_table_privilege('anon', 'public.market_orders', 'SELECT'),
  'anon_can_read_transfer', has_table_privilege('anon', 'public.market_store_transfer', 'SELECT'),
  'anon_can_place_order', has_function_privilege('anon', 'public.market_place_order(jsonb)', 'EXECUTE'),
  'api_can_touch_rate_tables', (SELECT bool_or(has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
                                 FROM unnest(ARRAY['anon', 'authenticated']) r,
                                      unnest(ARRAY['public.market_rate_counters', 'public.market_rate_blocks_daily']) t),
  -- 部署第 2 階段時驗 IP 標頭用的暫時探測函式,測完要刪掉(任何 schema 都不能留著)
  'tmp_ip_probe_absent', NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'market_tmp_ip_probe'),
  -- 加固 20261012100000 套用之後才會有 / 才會是 true(之前是 null / false):
  --   72 小時自動取消的排程(每 10 分鐘)
  'expire_orders_cron', (SELECT j.schedule FROM cron.job j WHERE j.jobname = 'ifoodmap-market-expire-orders'),
  'expire_orders_last_run_ok', (SELECT d.status = 'succeeded' FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
                                 WHERE j.jobname = 'ifoodmap-market-expire-orders' ORDER BY d.runid DESC LIMIT 1),
  --   market_client_ip() 不再讀 x-forwarded-for(只看程式裡有沒有取這個標頭;註解裡提到不算)
  'client_ip_ignores_xff', (SELECT pg_get_functiondef(p.oid) NOT LIKE '%->>''x-forwarded-for''%' FROM pg_proc p
                             WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'market_client_ip'),
  --   被擋的請求用非同步 commit(下單 RPC 或限流函式裡有 synchronous_commit)
  'blocked_async_commit', EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                                   AND p.proname IN ('market_rate_take', 'market_place_order')
                                   AND pg_get_functiondef(p.oid) LIKE '%synchronous_commit%'),

  -- ---------- 營運數字(照實記下來;意義與處理見 DEPLOY.md) ----------
  -- 對外營業中的店家:店家零售啟用 + 供應商帳號啟用。條件跟 market_store_is_open(120000)的內容一樣,但不呼叫它 ——
  -- 那支只開給 anon / authenticated / service_role,唯讀端點的角色沒有執行權(呼叫會 42501)
  'stores_open', (SELECT count(*) FROM public.market_stores s JOIN public.suppliers sp ON sp.id = s.supplier_id
                   WHERE s.is_enabled AND sp.is_active),
  -- 營業中、但聯絡信箱是空的或格式不對的店家 —— market-notify 寄新訂單通知前用同一條規則檢查
  -- (supabase/functions/_shared/supplier-mail.ts 的 EMAIL_PATTERN、≤ 254 字;不去頭尾空白),這幾家收不到新訂單信
  'stores_open_bad_contact_email', (SELECT count(*) FROM public.market_stores s JOIN public.suppliers sp ON sp.id = s.supplier_id
                                     WHERE s.is_enabled AND sp.is_active
                                       AND NOT COALESCE(char_length(sp.contact_email) <= 254 AND sp.contact_email
                                             ~ '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.([A-Za-z]{2,}|xn--[A-Za-z0-9-]+)$',
                                             false)),
  -- 付款方式含轉帳、轉帳資訊卻被刪掉的店家(這幾家的轉帳結帳會回 PAYMENT_NOT_ACCEPTED)
  'stores_transfer_without_info', (SELECT count(*) FROM public.market_stores s
                                    WHERE 'transfer' = ANY (s.payment_methods)
                                      AND NOT EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = s.supplier_id)),
  -- 消費者看得到的商品(已核准 + 上架中 + 店家營業中)
  'products_listed', (SELECT count(*) FROM public.market_products p
                        JOIN public.market_stores s ON s.supplier_id = p.supplier_id
                        JOIN public.suppliers sp ON sp.id = p.supplier_id
                       WHERE p.review_status = 'approved' AND p.is_listed AND s.is_enabled AND sp.is_active),
  'products_pending_review', (SELECT count(*) FROM public.market_products p WHERE p.review_status = 'pending'),
  'products_pending_over_2_days', (SELECT count(*) FROM public.market_products p
                                    WHERE p.review_status = 'pending' AND p.submitted_at < now() - interval '2 days'),
  'orders_total', (SELECT count(*) FROM public.market_orders),
  'orders_by_status', (SELECT COALESCE(json_object_agg(x.status, x.n ORDER BY x.status), '{}'::json)
                         FROM (SELECT o.status, count(*) AS n FROM public.market_orders o GROUP BY o.status) x),
  'orders_pending_over_1_day', (SELECT count(*) FROM public.market_orders o
                                 WHERE o.status = 'pending' AND o.created_at < now() - interval '1 day'),
  -- 超過 72 小時還沒接單 / 還沒匯款的單:加固 20261012100000 之後由排程自動取消,排程正常時是 0(最多晚 10 分鐘)
  'orders_pending_over_72h', (SELECT count(*) FROM public.market_orders o
                               WHERE o.status = 'pending' AND o.created_at < now() - interval '72 hours'),
  -- 待匯款從最後一筆「待匯款」紀錄起算(同自動取消的規則;轉帳單接單後同一個交易就補這一筆)
  'orders_awaiting_payment_over_72h', (SELECT count(*) FROM public.market_orders o
                                        WHERE o.status = 'awaiting_payment'
                                          AND (SELECT max(e.created_at) FROM public.market_order_events e
                                                WHERE e.order_id = o.id AND e.to_status = 'awaiting_payment') < now() - interval '72 hours'),
  'orders_paid_unshipped_over_3_days', (SELECT count(*) FROM public.market_orders o
                                         WHERE o.status = 'paid' AND o.paid_at < now() - interval '3 days'),
  -- 零售通知寄失敗(含 Email 格式不對沒寄的;零售的 message 都以「零售」開頭)
  'notify_failed_7_days', (SELECT count(*) FROM public.notifications n
                            WHERE n.status = 'failed' AND n.created_at > now() - interval '7 days' AND n.message LIKE '零售%'),
  -- 限流擋下次數:今天與前 6 天(共 7 個台北日),依規則種類加總;沒有擋下過是 {}
  'rate_blocks_7_days', (SELECT COALESCE(json_object_agg(x.rule, x.hits ORDER BY x.rule), '{}'::json)
                           FROM (SELECT b.rule, sum(b.hits) AS hits FROM public.market_rate_blocks_daily b
                                  WHERE b.day > (now() AT TIME ZONE 'Asia/Taipei')::date - 7 GROUP BY b.rule) x),
  -- noip 被擋過 = IP 取得壞了(擋下紀錄以台北日記:看 24 小時前那一天到今天,最多涵蓋 48 小時)
  'noip_blocked_24h', EXISTS (SELECT 1 FROM public.market_rate_blocks_daily b
                               WHERE b.rule = 'noip' AND b.hits > 0
                                 AND b.day >= ((now() - interval '24 hours') AT TIME ZONE 'Asia/Taipei')::date),
  -- 最近 24 小時拿不到 IP 的下單嘗試(沒被擋的也算;正常一定是 0 —— 不是 0 就代表 IP 取得壞了,還沒到被擋的量)
  'noip_attempts_24h', (SELECT COALESCE(sum(r.hits), 0) FROM public.market_rate_counters r
                         WHERE r.bucket = 'noip|1h' AND r.window_start > now() - interval '24 hours')
) AS readiness;
