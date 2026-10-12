-- 20261012110000 的還原檔能跑、跑完跟套用前的線上一模一樣
-- (runner:--with-migration 20261012100000_market_hardening.sql --with-migration 20261012110000_market_compliance.sql
--  --with-rollback 20261012110000_market_compliance.down.sql,本檔在最後執行;已經套用的 120000–130200 不要再帶)
-- 期待值 = 線上套用 110000 之前的 md5(pg_get_functiondef)、權限、欄位、constraint、trigger,2026-10-12 用唯讀端點取得;
-- 110000 套用之後這支照樣成立(還原檔換回來的就是這個版本)。
SELECT pg_temp.expect('四支函式的定義跟線上套用前逐字相同(md5)',
  (SELECT string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('market_stores_guard', 'market_products_guard', 'market_store_is_open', 'market_get_orders')),
  'market_get_orders=a4fcbb5fc51cdcbbed85983856b6688f,market_products_guard=de44718aa72a4a8b86d52f09d8d4f60c,market_store_is_open=412d05e2799e6ea0fd6bb7af4f6680e0,market_stores_guard=adc8a4e3026cffece1abe3f4a85aaa0d');
SELECT pg_temp.expect('四支函式與 market_email_ok 的權限跟線上相同(market_email_ok 收回 authenticated)',
  (SELECT string_agg(p.proname || '=' || COALESCE(p.proacl::text, 'NULL'), ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('market_stores_guard', 'market_products_guard', 'market_store_is_open', 'market_get_orders', 'market_email_ok')),
  'market_email_ok={postgres=X/postgres,service_role=X/postgres},market_get_orders={postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres},market_products_guard={postgres=X/postgres,service_role=X/postgres},market_store_is_open={postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres},market_stores_guard={postgres=X/postgres,service_role=X/postgres}');
SELECT pg_temp.expect('三張表的欄位跟線上相同(新欄位都拆掉了)',
  ((SELECT jsonb_object_agg(table_name, cols) FROM (
      SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS cols FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('market_stores', 'market_products', 'market_order_items') GROUP BY table_name) x)
   = '{"market_order_items": "id,order_id,product_id,product_name,spec,temperature,unit_price,qty,line_total,stock_deducted,created_at", "market_products": "id,supplier_id,supply_id,name,category,spec,price,stock,temperature,origin,storage_method,shelf_life,description,photos,review_status,reject_reason,is_listed,submitted_at,reviewed_by,reviewed_at,created_at,updated_at", "market_stores": "supplier_id,is_enabled,disabled_reason,logo_path,cover_path,intro,return_policy,delivery_cities,shipping_fee,free_shipping_threshold,min_order_amount,ship_days,payment_methods,created_at,updated_at"}'::jsonb)::text,
  'true');
SELECT pg_temp.expect('三張表的 constraint 與 trigger 跟線上相同;明細快照函式拆掉了',
  concat_ws('|',
    (jsonb_build_object(
       'market_order_items', (SELECT jsonb_agg(conname ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.market_order_items'::regclass),
       'market_products', (SELECT jsonb_agg(conname ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.market_products'::regclass),
       'market_stores', (SELECT jsonb_agg(conname ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.market_stores'::regclass))
     = '{"market_order_items": ["market_order_items_line_total", "market_order_items_order_id_fkey", "market_order_items_pkey", "market_order_items_product_id_fkey", "market_order_items_product_name_check", "market_order_items_qty_check", "market_order_items_spec_check", "market_order_items_stock_deducted", "market_order_items_temperature_check", "market_order_items_unit_price_check"], "market_products": ["market_products_category_check", "market_products_photos", "market_products_pkey", "market_products_price", "market_products_review_status_check", "market_products_stock", "market_products_supplier_id_fkey", "market_products_supply_id_fkey", "market_products_temperature_check", "market_products_text_lengths"], "market_stores": ["market_stores_delivery_cities", "market_stores_money", "market_stores_payment_methods", "market_stores_pkey", "market_stores_ship_days", "market_stores_supplier_id_fkey", "market_stores_text_lengths"]}'::jsonb)::text,
    ((SELECT jsonb_agg(c.relname || ':' || t.tgname ORDER BY c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('market_stores', 'market_products', 'market_order_items'))
     = '["market_products:trg_market_products_guard", "market_stores:trg_market_stores_guard"]'::jsonb)::text,
    (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'market_order_items_snapshot')),
  'true|true|0');
