-- 乾跑工具自我檢查(scripts/supabase-sql.mjs dry 組裝:BEGIN → _market_helpers.sql → 本檔 → 彙總 → ROLLBACK)
SELECT pg_temp.expect('as_val 換成 anon 身分執行',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT current_user::text$q$), 'anon');
SELECT pg_temp.expect('as_exec 回報 SQLSTATE',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$SELECT 1 / 0$q$), 'ERR 22012');
SELECT pg_temp.expect('執行完換回資料庫擁有者', current_user::text, 'postgres');
SELECT pg_temp.expect('jwt() 可以帶管理員角色',
  pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true)::json -> 'app_metadata' ->> 'role', 'admin');
SELECT pg_temp.expect('auth.uid() 讀得到 as_val 帶的 sub',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$SELECT auth.uid()::text$q$),
  'a9100000-0000-4000-8000-000000000001');
