-- =====================================================================
-- 零售市集資料庫測試的共用工具(scripts/supabase-sql.mjs dry 會自動接在 BEGIN 之後、migration 之前)
--
-- 整個乾跑是同一個交易,最後一定 ROLLBACK:fixture、計數、pg_net 佇列都不會留下
-- (事後一定要用 market_residue.sql 走唯讀端點查證)。
-- 每一項檢查寫進暫存表 _r(k = 說明、got = 實際、want = 預期);runner 最後彙總,got ≠ want 就算失敗。
--
-- fixture 慣例(market_residue.sql 靠這兩個特徵查殘留):
--   Email 一律 …@market-test.invalid、UUID 一律 a9?00000-0000-4000-8000- 開頭
-- =====================================================================
CREATE TEMP TABLE _r (seq serial PRIMARY KEY, k text NOT NULL, got text, want text) ON COMMIT DROP;

-- 記一項檢查
CREATE FUNCTION pg_temp.expect(p_k text, p_got text, p_want text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO _r (k, got, want) VALUES (p_k, p_got, p_want)
$f$;

-- 換成某個身分(anon / authenticated + JWT claims)跑一段 SQL:回 'OK',或 'ERR <SQLSTATE>[:<HINT>]'
-- (只附上我們自己 RAISE 的 snake_case HINT;Supabase 在 permission denied 時附的英文說明不算)
CREATE FUNCTION pg_temp.as_exec(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_state text;
  v_hint  text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN CASE WHEN v_state IS NULL THEN 'OK'
              ELSE 'ERR ' || v_state || CASE WHEN COALESCE(v_hint, '') ~ '^[a-z_]+$' THEN ':' || v_hint ELSE '' END END;
END
$f$;

-- 換成某個身分取一個值(查詢只回一列一欄);出錯回 'ERR <SQLSTATE>[:<HINT>]'
CREATE FUNCTION pg_temp.as_val(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_out   text;
  v_state text;
  v_hint  text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || v_state || CASE WHEN COALESCE(v_hint, '') ~ '^[a-z_]+$' THEN ':' || v_hint ELSE '' END;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_out;
END
$f$;

-- 登入者的 JWT claims(p_admin = 平台管理員:app_metadata.role = admin,跟 public.is_admin() 的判斷一樣)
CREATE FUNCTION pg_temp.jwt(p_uid uuid, p_admin boolean DEFAULT false) RETURNS text LANGUAGE sql AS $f$
  SELECT json_build_object(
    'sub', p_uid,
    'role', 'authenticated',
    'app_metadata', CASE WHEN p_admin THEN json_build_object('role', 'admin') ELSE json_build_object() END
  )::text
$f$;

CREATE FUNCTION pg_temp.anon() RETURNS text LANGUAGE sql AS $f$ SELECT '{"role":"anon"}'::text $f$;

-- 用資料庫擁有者身分(繞過 RLS)但帶某個 JWT 執行一句 SQL:建只有管理員能設的 fixture(例如已核准的商品)
CREATE FUNCTION pg_temp.exec_with_claims(p_claims text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claims', '', true);
END
$f$;
