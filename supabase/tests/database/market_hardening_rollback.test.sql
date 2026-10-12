-- 20261012100000 的還原檔能跑、跑完跟套用前的線上一模一樣
-- (runner:--with-migration 20261012100000_market_hardening.sql --with-migration 20261012110000_market_compliance.sql
--  --with-rollback 20261012110000_market_compliance.down.sql --with-rollback 20261012100000_market_hardening.down.sql(反序還原),本檔最後執行;
--  已經套用的 120000 / 120100 / 130000 / 130100 / 130200 不要再帶)
-- 期待值 = 線上套用 hardening 之前(= 130000 / 130200 的版本)的 md5(pg_get_functiondef)、權限、排程指紋,
-- 2026-10-12 用唯讀端點取得;hardening 套用之後這支照樣成立(還原檔換回來的就是這個版本)。
SELECT pg_temp.expect('三支函式的定義跟線上套用前逐字相同(md5)',
  (SELECT string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.oid IN ('public.market_client_ip()'::regprocedure, 'public.market_rate_take(jsonb)'::regprocedure,
                    'public.market_guard_event()'::regprocedure)),
  'market_client_ip=e8d219380c5633e93fe99ac1cd882d24,market_guard_event=b56c84c339a4ed64fce66f4917d0cf20,market_rate_take=43abd2d6149520b325cf46723c96c1b0');
SELECT pg_temp.expect('三支函式的權限跟線上相同',
  (SELECT string_agg(p.proname || '=' || COALESCE(p.proacl::text, 'NULL'), ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.oid IN ('public.market_client_ip()'::regprocedure, 'public.market_rate_take(jsonb)'::regprocedure,
                    'public.market_guard_event()'::regprocedure)),
  'market_client_ip={postgres=X/postgres,service_role=X/postgres},market_guard_event={postgres=X/postgres,service_role=X/postgres},market_rate_take={postgres=X/postgres,service_role=X/postgres}');
SELECT pg_temp.expect('market_expire_orders 與它的排程都拆掉了;其他排程跟線上一模一樣(名稱、時間、指令、啟用)',
  concat_ws('|',
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'market_expire_orders'),
    (SELECT count(*) FROM cron.job WHERE jobname = 'ifoodmap-market-expire-orders'),
    (SELECT md5(string_agg(jobname || ':' || schedule || ':' || md5(command) || ':' || active::text, ',' ORDER BY jobname)) FROM cron.job)),
  '0|0|70b6b0635bd8fa1d145dd887a1cfb109');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2"}', true);
SELECT pg_temp.expect('還原後的行為也是 130200 的:只有 x-forwarded-for 時照舊退回第一段',
  COALESCE(public.market_client_ip(), '∅'), '1.1.1.1');
SELECT set_config('request.headers', '', true);
