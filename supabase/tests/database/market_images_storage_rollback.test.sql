-- 20261009120100 的還原檔:policy 與函式拆掉,bucket 留著(SQL 刪不掉,要用 Storage API)
SELECT pg_temp.expect('還原後 market images policy 都不在',
  (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'market images%'), '0');
SELECT pg_temp.expect('還原後路徑函式不在',
  (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'market_image_object_ok'), '0');
SELECT pg_temp.expect('bucket 還在(要用 Storage API 刪)',
  (SELECT count(*)::text FROM storage.buckets WHERE id = 'market-images'), '1');
