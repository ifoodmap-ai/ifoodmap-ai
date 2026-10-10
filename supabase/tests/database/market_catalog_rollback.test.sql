-- 20261009120000 的還原檔能跑、跑完乾淨(runner:--with-migration <migration> --with-rollback <down.sql>,本檔在兩者之後執行)
SELECT pg_temp.expect('還原後三張表都不在',
  (SELECT count(*)::text FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname IN ('market_stores', 'market_store_transfer', 'market_products')),
  '0');
SELECT pg_temp.expect('還原後函式都不在',
  (SELECT count(*)::text FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('market_tw_cities', 'market_image_path_matches', 'market_trim', 'market_store_is_open',
                      'market_stores_guard', 'market_products_guard', 'market_store_transfer_touch')),
  '0');
SELECT pg_temp.expect('ledger 沒有這支 migration',
  (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261009120000'), '0');
