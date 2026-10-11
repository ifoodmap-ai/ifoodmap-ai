-- =====================================================================
-- migration 20261009120100_market_images_storage 的資料庫層測試(Storage 的 RLS)
--   … dry supabase/tests/database/market_images_storage.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql \
--     --with-migration supabase/migrations/20261009120100_market_images_storage.sql
-- 只 INSERT storage.objects;覆寫、UPDATE、DELETE 只用來確認會被拒(物件只能寫一次)。整筆交易最後 ROLLBACK,這裡不會產生任何真的檔案。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
-- 用 A 的身分上傳一個物件(只寫 metadata 列,不是真的檔案)
CREATE FUNCTION pg_temp.put(p_claims text, p_name text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_exec('authenticated', p_claims,
    format($q$INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('market-images', %L, auth.uid())$q$, p_name))
$f$;

SELECT pg_temp.expect('bucket:公開、2 MB、三種圖片格式',
  (SELECT public::text || '|' || file_size_limit::text || '|' || array_to_string(allowed_mime_types, ',')
     FROM storage.buckets WHERE id = 'market-images'),
  'true|2097152|image/jpeg,image/png,image/webp');
SELECT pg_temp.expect('bucket 不開版本(versioning_status = DISABLED):「照片只能寫一次」的前提',
  (SELECT versioning_status FROM storage.buckets WHERE id = 'market-images'), 'DISABLED');
SELECT pg_temp.expect('只有 SELECT、INSERT 兩條 policy(沒有 UPDATE / DELETE:物件只能寫一次)',
  (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname)
     FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'market images%'),
  'market images supplier insert:INSERT,market images supplier select:SELECT');
SELECT pg_temp.expect('anon 不能執行路徑檢查函式(也不需要)',
  has_function_privilege('anon', 'public.market_image_object_ok(text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('A 上傳商品照片',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg'), 'OK');
SELECT pg_temp.expect('A 上傳縮圖',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001_t.jpg'), 'OK');
SELECT pg_temp.expect('A 上傳店家封面(webp)',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp'), 'OK');
-- Supabase 2026-10-10 的 Storage 更新拿掉了 storage.objects 的 (bucket_id, name) unique index,只剩帶條件的
-- idx_objects_current_version (bucket_id, name COLLATE "C") WHERE archived_at IS NULL;upsert 照 Storage API 現在的寫法。
SELECT pg_temp.expect('A 用 upsert(x-upsert)覆寫同一個檔被拒(沒有 UPDATE policy;已核准的照片換不掉)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg', auth.uid())
    ON CONFLICT (bucket_id, name COLLATE "C") WHERE archived_at IS NULL DO UPDATE SET owner = EXCLUDED.owner$q$),
  'ERR 42501');
-- 不綁 ON CONFLICT 的寫法(Supabase 再改 index 也不怕):同一路徑直接再 INSERT 一次要被擋(unique 23505 或 RLS 42501 都算)
SELECT pg_temp.expect('A 同一路徑直接再傳一次被擋(23505 或 42501 都算擋住)',
  (SELECT CASE WHEN x.r IN ('ERR 23505', 'ERR 42501') THEN '擋住' ELSE x.r END
     FROM (SELECT pg_temp.put(pg_temp.ua(),
             'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg') AS r) AS x),
  '擋住');
SELECT pg_temp.expect('A 傳到 B 的資料夾被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000b/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000003.jpg'), 'ERR 42501');
SELECT pg_temp.expect('gif 被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004.gif'), 'ERR 42501');
SELECT pg_temp.expect('多一層資料夾被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/x/a9900000-0000-4000-8000-000000000005.jpg'), 'ERR 42501');
SELECT pg_temp.expect('第二層不是商品 id 也不是 store 被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/logo/a9900000-0000-4000-8000-000000000006.jpg'), 'ERR 42501');
SELECT pg_temp.expect('anon 不能上傳',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO storage.objects (bucket_id, name)
    VALUES ('market-images', 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000007.jpg')$q$),
  'ERR 42501');
SELECT pg_temp.expect('B 列不到 A 的檔案',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'market-images' AND name LIKE 'a9200000-0000-4000-8000-00000000000a/%'$q$),
  '0');
SELECT pg_temp.expect('A 列得到自己的 3 個檔',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'market-images' AND name LIKE 'a9200000-0000-4000-8000-00000000000a/%'$q$),
  '3');
SELECT pg_temp.expect('A 也改不了自己的檔案(沒有 UPDATE policy,0 列)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE storage.objects SET user_metadata = '{"by":"test"}'::jsonb
                WHERE bucket_id = 'market-images'
                  AND name = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '0');
SELECT pg_temp.expect('B 改不到 A 的檔案',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH u AS (UPDATE storage.objects SET user_metadata = '{"by":"b"}'::jsonb
                WHERE bucket_id = 'market-images'
                  AND name = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '0');
-- Storage API 刪檔時會先設 storage.allow_delete_query = 'true'(放行 storage.protect_delete 這個 statement trigger),
-- 再以使用者身分 DELETE,照樣受 RLS 管。這裡照做:沒有 DELETE policy 就一列都刪不到(刪掉再同名重傳的路也斷了)。
SELECT set_config('storage.allow_delete_query', 'true', true);
SELECT pg_temp.expect('A 刪不掉自己的檔案(沒有 DELETE policy,0 列)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH d AS (DELETE FROM storage.objects
                WHERE bucket_id = 'market-images'
                  AND name = 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg'
                RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '0');
SELECT set_config('storage.allow_delete_query', 'false', true);
UPDATE public.supplier_accounts SET is_active = false WHERE user_id = 'a9100000-0000-4000-8000-000000000002';
SELECT pg_temp.expect('帳號停用後不能再上傳',
  pg_temp.put(pg_temp.ub(), 'a9200000-0000-4000-8000-00000000000b/store/a9900000-0000-4000-8000-000000000008.jpg'), 'ERR 42501');
