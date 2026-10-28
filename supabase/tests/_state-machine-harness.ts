// 訂單狀態機的 PGlite 測試共用工具:用 PGlite(行程內的真 Postgres)把「真正的」狀態機 migration 原封不動重放一遍,
// 底下墊幾張最小的替身表(repo 的 migration 沒有收錄那幾張最早期的表),再讓各支測試套自己的 migration。
// 身分:set_config('test.uid' / 'test.jwt' / 'test.role') 模擬 auth.uid() / auth.jwt() / auth.role(),SET ROLE 讓 RLS 生效。
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
export const readRepoFile = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
export const migration = (name: string) => readRepoFile(`supabase/migrations/${name}.sql`);
export const rollback = (name: string) => readRepoFile(`supabase/rollbacks/${name}.down.sql`);

export const STATE_MACHINE = [
  "20260702120000_roadmap_features",
  "20260726100000_portals_foundation",
  "20260726120000_restaurant_order_rls",
  "20260928190000_restaurant_draft_approval",
  "20260928190100_restaurant_order_update_guard",
  "20260929100000_order_transition_rules",
  "20260929100100_order_event_side_effects",
  "20260929100200_order_integrity_hardening",
  "20260929110000_order_cancel_requote_rules",
];

const BASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;
CREATE SCHEMA extensions; CREATE SCHEMA net;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SET search_path = public
  AS $$ SELECT COALESCE(auth.jwt()->'app_metadata'->>'role', '') = 'admin' $$;

CREATE TABLE public.suppliers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.supplier_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.supplier_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL, status text NOT NULL DEFAULT 'draft',
  ingredient_list jsonb, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.order_quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES public.supplier_orders(id) ON DELETE CASCADE,
  supplier_id uuid, total_amount numeric, note text, valid_until date, status text DEFAULT 'pending', created_at timestamptz DEFAULT now());
CREATE TABLE public.supplier_shipments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES public.supplier_orders(id) ON DELETE CASCADE,
  supplier_id uuid, shipped_at timestamptz, tracking_info jsonb, notes text, confirmed_by uuid, created_at timestamptz DEFAULT now());
`;

const GRANTS = `
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`;

export const U = {
  owner: "00000000-0000-0000-0000-0000000000c1",
  manager: "00000000-0000-0000-0000-0000000000c2",
  purchaser: "00000000-0000-0000-0000-0000000000c3",
  otherOwner: "00000000-0000-0000-0000-0000000000d1",
  supA: "00000000-0000-0000-0000-0000000000a1",
  supB: "00000000-0000-0000-0000-0000000000b1",
  stranger: "00000000-0000-0000-0000-0000000000e1",
  admin: "00000000-0000-0000-0000-0000000000f1",
};
export const SUP_A = "10000000-0000-0000-0000-00000000000a";
export const SUP_B = "10000000-0000-0000-0000-00000000000b";
export const REST_1 = "20000000-0000-0000-0000-000000000001";
export const REST_2 = "20000000-0000-0000-0000-000000000002";

/** 狀態機 + 前面幾支 migration(例如 20261028110000 綁定)+ 基本資料:餐廳 2 家、供應商 2 家、各角色的帳號 */
export const buildStateMachineDb = async (extraMigrations: string[] = [], setupSql = "") => {
  const db = new PGlite();
  await db.exec(BASE);
  for (const name of STATE_MACHINE) await db.exec(migration(name));
  await db.exec(GRANTS);
  for (const id of Object.values(U)) await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
  await db.query(`INSERT INTO public.suppliers (id, name, is_active) VALUES ($1,'阿明蔬果',true),($2,'大海水產',true)`, [SUP_A, SUP_B]);
  await db.query(`INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES ($1,$3),($2,$4)`, [U.supA, U.supB, SUP_A, SUP_B]);
  await db.query(`INSERT INTO public.restaurants (id, name) VALUES ($1,'好味小館'),($2,'別家餐廳')`, [REST_1, REST_2]);
  await db.query(
    `INSERT INTO public.restaurant_accounts (user_id, restaurant_id, role) VALUES ($1,$5,'owner'),($2,$5,'manager'),($3,$5,'purchaser'),($4,$6,'owner')`,
    [U.owner, U.manager, U.purchaser, U.otherOwner, REST_1, REST_2],
  );
  if (setupSql) await db.exec(setupSql);
  for (const name of extraMigrations) await db.exec(migration(name));
  return db;
};

/** 以某個身分跑一段 SQL:null = 匿名,"admin" = 平台管理員,"system" = service_role,其餘為使用者 id */
export const runAs = async <T = Record<string, unknown>>(db: PGlite, who: string | null, sql: string, params: unknown[] = []) => {
  const role = who === null ? "anon" : who === "system" ? "service_role" : "authenticated";
  await db.exec(`SET ROLE ${role}`);
  await db.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', $2, false), set_config('test.role', $3, false)`, [
    who === null || who === "admin" || who === "system" ? "" : who,
    who === "admin" ? JSON.stringify({ app_metadata: { role: "admin" } }) : "",
    role,
  ]);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("RESET ROLE");
  }
};

/** 預期這一段 SQL 會被資料庫擋下,回傳錯誤訊息 */
export const failureOf = async (db: PGlite, who: string | null, sql: string, params: unknown[] = []) => {
  try {
    await runAs(db, who, sql, params);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`預期會失敗,但成功了:${sql}`);
};
