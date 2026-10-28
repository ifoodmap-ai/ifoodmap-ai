// @vitest-environment node
//
// 餐廳 × 合作供應商綁定與直接叫貨(20261028110000_restaurant_supplier_binding.sql)的行為測試。
//
// 這支改的是訂單狀態機的守門規則,所以不是只驗新表:用 PGlite(行程內的真 Postgres)把「真正的」狀態機 migration
// (portals_foundation、草稿簽核、轉移表、事件副作用、完整性強化、取消 / 退回重新報價)原封不動重放一遍,
// 底下墊幾張最小的替身表(repo 的 migration 沒有收錄那幾張最早期的表),再套這一支,
// 然後用不同身分寫真的訂單事件,確認:綁定的權限、直接叫貨只能叫已綁定的供應商、原本的簽核與派單流程完全沒被改到。
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const MIG = (name: string) => read(`supabase/migrations/${name}.sql`);

const STATE_MACHINE = [
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
const MIGRATION = MIG("20261028110000_restaurant_supplier_binding");
const ROLLBACK = read("supabase/rollbacks/20261028110000_restaurant_supplier_binding.down.sql");

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

-- repo 的 migration 沒有收錄的最早期資料表(正式庫在 migration 之前就有),只留狀態機用得到的欄位
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

const AFTER_STATE_MACHINE = `
-- Supabase 預設會把 public 的資料表權限給 anon / authenticated:照做,才驗得出 migration 有收回寫入權限
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`;

const U = {
  owner: "00000000-0000-0000-0000-0000000000c1",
  manager: "00000000-0000-0000-0000-0000000000c2",
  purchaser: "00000000-0000-0000-0000-0000000000c3",
  otherOwner: "00000000-0000-0000-0000-0000000000d1",
  supA: "00000000-0000-0000-0000-0000000000a1",
  supB: "00000000-0000-0000-0000-0000000000b1",
  stranger: "00000000-0000-0000-0000-0000000000e1",
  admin: "00000000-0000-0000-0000-0000000000f1",
};
const SUP_A = "10000000-0000-0000-0000-00000000000a";
const SUP_B = "10000000-0000-0000-0000-00000000000b";
const SUP_OFF = "10000000-0000-0000-0000-0000000000ff";
const REST_1 = "20000000-0000-0000-0000-000000000001";
const REST_2 = "20000000-0000-0000-0000-000000000002";

const buildDb = async (beforeMigration?: (db: PGlite) => Promise<void>) => {
  const db = new PGlite();
  await db.exec(BASE);
  for (const name of STATE_MACHINE) await db.exec(MIG(name));
  await db.exec(AFTER_STATE_MACHINE);
  await seed(db);
  if (beforeMigration) await beforeMigration(db);
  return db;
};

const seed = async (db: PGlite) => {
  for (const id of Object.values(U)) await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
  await db.query(`INSERT INTO public.suppliers (id, name, is_active) VALUES ($1,'阿明蔬果',true),($2,'大海水產',true),($3,'已歇業供應商',false)`, [SUP_A, SUP_B, SUP_OFF]);
  await db.query(`INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES ($1,$3),($2,$4)`, [U.supA, U.supB, SUP_A, SUP_B]);
  await db.query(`INSERT INTO public.restaurants (id, name) VALUES ($1,'好味小館'),($2,'別家餐廳')`, [REST_1, REST_2]);
  await db.query(
    `INSERT INTO public.restaurant_accounts (user_id, restaurant_id, role) VALUES ($1,$5,'owner'),($2,$5,'manager'),($3,$5,'purchaser'),($4,$6,'owner')`,
    [U.owner, U.manager, U.purchaser, U.otherOwner, REST_1, REST_2],
  );
};

let db: PGlite;

/** 以某個身分跑一段 SQL:null = 匿名,"admin" = 平台管理員,"system" = service_role,其餘為使用者 id */
const as = async <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = [], target: PGlite = db) => {
  const role = who === null ? "anon" : who === "system" ? "service_role" : "authenticated";
  await target.exec(`SET ROLE ${role}`);
  await target.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', $2, false), set_config('test.role', $3, false)`, [
    who === null || who === "admin" || who === "system" ? "" : who,
    who === "admin" ? JSON.stringify({ app_metadata: { role: "admin" } }) : "",
    role,
  ]);
  try {
    return (await target.query<T>(sql, params)).rows;
  } finally {
    await target.exec("RESET ROLE");
  }
};

const failure = async (who: string | null, sql: string, params: unknown[] = []) => {
  try {
    await as(who, sql, params);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`預期會失敗,但成功了:${sql}`);
};

/** 餐廳成員建一張草稿(走真的 RLS:restaurant_create_own_orders) */
const draftBy = async (who: string, restaurant = REST_1) => {
  const rows = await as<{ id: string }>(
    who,
    `INSERT INTO public.supplier_orders (restaurant_id, status, ingredient_list) VALUES ($1, 'draft', '[{"name":"高麗菜","quantity":"5","unit":"kg"}]'::jsonb) RETURNING id`,
    [restaurant],
  );
  return rows[0].id;
};

const event = (who: string, orderId: string, from: string | null, to: string, role: string, payload: object = {}, note: string | null = null) =>
  as(who, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload, note) VALUES ($1,$2,$3,$4,'restaurant_portal',$5::jsonb,$6)`, [
    orderId, from, to, role, JSON.stringify(payload), note,
  ]);

const orderRow = async (id: string) => (await db.query<{ status: string; supplier_id: string | null }>(`SELECT status, supplier_id FROM public.supplier_orders WHERE id = $1`, [id])).rows[0];

const bind = async (restaurant = REST_1, supplier = SUP_A) =>
  db.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [restaurant, supplier]);

beforeAll(async () => {
  db = await buildDb();
  await db.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.restaurant_suppliers, public.order_quotes, public.supplier_shipments, public.order_events RESTART IDENTITY CASCADE;
                 DELETE FROM public.supplier_orders;`);
});

describe("轉移表", () => {
  it("共 105 條:原本的 102 條 + 老闆 / 店長 / 採購員的 draft → dispatched", async () => {
    const rows = (await db.query<{ actor: string; from_status: string; to_status: string }>(`SELECT * FROM public.order_transition_rules()`)).rows;
    expect(rows).toHaveLength(105);
    for (const actor of ["owner", "manager", "purchaser"]) {
      expect(rows).toContainEqual({ actor, from_status: "draft", to_status: "dispatched" });
    }
    // 採購員仍然不能送出簽核(draft → submitted)
    expect(rows).not.toContainEqual({ actor: "purchaser", from_status: "draft", to_status: "submitted" });
  });
});

describe("綁定 restaurant_suppliers 的權限", () => {
  it("老闆與店長可以綁定還在營業的供應商;created_by 是自己", async () => {
    await as(U.owner, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A]);
    await as(U.manager, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_B]);
    const rows = (await db.query<{ supplier_id: string; created_by: string }>(`SELECT supplier_id, created_by FROM public.restaurant_suppliers ORDER BY created_by`)).rows;
    expect(rows).toEqual([
      { supplier_id: SUP_A, created_by: U.owner },
      { supplier_id: SUP_B, created_by: U.manager },
    ]);
  });

  it("採購員、別家餐廳的老闆、供應商、陌生人、匿名都不能綁定", async () => {
    for (const who of [U.purchaser, U.otherOwner, U.supA, U.stranger]) {
      expect(await failure(who, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A]), who)
        .toMatch(/row-level security/);
    }
    expect(await failure(null, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A])).toMatch(/permission denied/);
  });

  it("不能綁已歇業的供應商,也不能冒用別人當 created_by", async () => {
    expect(await failure(U.owner, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_OFF])).toMatch(/row-level security/);
    expect(await failure(U.owner, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id, created_by) VALUES ($1,$2,$3)`, [REST_1, SUP_A, U.manager])).toMatch(/row-level security/);
  });

  it("重複綁定同一家會被擋(主鍵)", async () => {
    await as(U.owner, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A]);
    expect(await failure(U.owner, `INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A])).toMatch(/duplicate key/);
  });

  it("老闆與店長可以解除綁定;採購員與別家餐廳不能", async () => {
    await bind();
    for (const who of [U.purchaser, U.otherOwner, U.supA]) {
      expect(await as(who, `DELETE FROM public.restaurant_suppliers WHERE restaurant_id = $1 RETURNING 1`, [REST_1]), who).toHaveLength(0);
    }
    expect((await db.query(`SELECT 1 FROM public.restaurant_suppliers`)).rows).toHaveLength(1);
    expect(await as(U.manager, `DELETE FROM public.restaurant_suppliers WHERE restaurant_id = $1 RETURNING 1`, [REST_1])).toHaveLength(1);
  });

  it("不能改綁定(沒有 UPDATE 權限)", async () => {
    await bind();
    expect(await failure(U.owner, `UPDATE public.restaurant_suppliers SET supplier_id = $2 WHERE restaurant_id = $1`, [REST_1, SUP_B])).toMatch(/permission denied/);
  });

  it("誰看得到:這家餐廳所有成員(含採購員)、被綁定的供應商自己、管理員;別人看不到", async () => {
    await bind();
    for (const who of [U.owner, U.manager, U.purchaser, U.supA, "admin"]) {
      expect(await as(who, `SELECT 1 FROM public.restaurant_suppliers`), who).toHaveLength(1);
    }
    for (const who of [U.otherOwner, U.supB, U.stranger]) {
      expect(await as(who, `SELECT 1 FROM public.restaurant_suppliers`), who).toHaveLength(0);
    }
    expect(await failure(null, `SELECT 1 FROM public.restaurant_suppliers`)).toMatch(/permission denied/);
  });
});

describe("直接叫貨:草稿 → 待接單", () => {
  it.each([["owner"], ["manager"], ["purchaser"]] as const)("%s 向已綁定的供應商叫貨:訂單直接進待接單,供應商寫到訂單上", async (who) => {
    await bind();
    const id = await draftBy(U[who]);
    await event(U[who], id, "draft", "dispatched", "restaurant", { supplier_id: SUP_A }, "叫貨");
    expect(await orderRow(id)).toEqual({ status: "dispatched", supplier_id: SUP_A });

    const events = (await db.query<{ from_status: string; to_status: string; actor_id: string }>(`SELECT from_status, to_status, actor_id FROM public.order_events WHERE order_id = $1`, [id])).rows;
    expect(events).toEqual([{ from_status: "draft", to_status: "dispatched", actor_id: U[who] }]);
  });

  it("沒綁定的供應商不能叫(包含存在、營業中的供應商)", async () => {
    const id = await draftBy(U.owner);
    expect(await failure(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_A })]))
      .toContain("只能向已綁定的合作供應商叫貨");
    expect(await orderRow(id)).toEqual({ status: "draft", supplier_id: null });
  });

  it("別家餐廳綁的供應商不算:要這家店自己綁定", async () => {
    await bind(REST_2, SUP_A);
    const id = await draftBy(U.owner);
    expect(await failure(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_A })]))
      .toContain("只能向已綁定的合作供應商叫貨");
  });

  it("綁定之後供應商歇業了就不能再叫", async () => {
    await db.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_OFF]);
    const id = await draftBy(U.owner);
    expect(await failure(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_OFF })]))
      .toContain("只能向已綁定的合作供應商叫貨");
  });

  it.each([
    ["沒帶供應商", {}],
    ["供應商 id 格式不對", { supplier_id: "not-a-uuid" }],
    ["供應商是空字串", { supplier_id: "" }],
    ["供應商不存在", { supplier_id: "10000000-0000-0000-0000-000000000999" }],
  ])("%s:擋下", async (_label, payload) => {
    await bind();
    const id = await draftBy(U.owner);
    expect(await failure(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [id, JSON.stringify(payload)]))
      .toMatch(/只能向已綁定的合作供應商叫貨|找不到要派單的供應商/);
    expect(await orderRow(id)).toEqual({ status: "draft", supplier_id: null });
  });

  it("別家餐廳的人、供應商、陌生人不能替這家店叫貨", async () => {
    await bind();
    await bind(REST_2, SUP_A);
    const id = await draftBy(U.owner);
    for (const [who, role] of [[U.otherOwner, "restaurant"], [U.supA, "restaurant"], [U.stranger, "restaurant"], [U.otherOwner, "admin"]] as const) {
      await expect(event(who, id, "draft", "dispatched", role, { supplier_id: SUP_A }), who).rejects.toThrow();
    }
    expect(await orderRow(id)).toEqual({ status: "draft", supplier_id: null });
  });

  it("叫貨之後供應商可以接單;別的供應商不行", async () => {
    await bind();
    const id = await draftBy(U.purchaser);
    await event(U.purchaser, id, "draft", "dispatched", "restaurant", { supplier_id: SUP_A });
    await expect(event(U.supB, id, "dispatched", "accepted", "supplier")).rejects.toThrow();
    await event(U.supA, id, "dispatched", "accepted", "supplier");
    expect((await orderRow(id)).status).toBe("accepted");
  });

  it("叫過貨的單不能再被餐廳改派(dispatched → dispatched 不在轉移表)", async () => {
    await bind();
    await bind(REST_1, SUP_B);
    const id = await draftBy(U.owner);
    await event(U.owner, id, "draft", "dispatched", "restaurant", { supplier_id: SUP_A });
    await expect(event(U.owner, id, "dispatched", "dispatched", "restaurant", { supplier_id: SUP_B })).rejects.toThrow();
    expect((await orderRow(id)).supplier_id).toBe(SUP_A);
  });
});

describe("原本的流程沒被改到", () => {
  it("採購員仍然不能把草稿送出簽核(draft → submitted)", async () => {
    const id = await draftBy(U.purchaser);
    expect(await failure(U.purchaser, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source) VALUES ($1,'draft','submitted','restaurant','restaurant_portal')`, [id]))
      .toContain("老闆或店長簽核");
  });

  it("老闆送出 → 待派發 → 管理員派給任何供應商(不需要綁定)→ 供應商接單", async () => {
    const id = await draftBy(U.owner);
    await event(U.owner, id, "draft", "submitted", "restaurant");
    expect((await orderRow(id)).status).toBe("submitted");
    await event("admin", id, "submitted", "dispatched", "admin", { supplier_id: SUP_B });
    expect(await orderRow(id)).toEqual({ status: "dispatched", supplier_id: SUP_B });
    await event(U.supB, id, "dispatched", "accepted", "supplier");
    expect((await orderRow(id)).status).toBe("accepted");
  });

  it("系統身分仍可 draft → dispatched;管理員派單不受綁定限制", async () => {
    const a = await draftBy(U.owner);
    await as("admin", `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','admin','admin_portal',$2::jsonb)`, [a, JSON.stringify({ supplier_id: SUP_B })]);
    expect(await orderRow(a)).toEqual({ status: "dispatched", supplier_id: SUP_B });
  });

  it("對已取消的單做送出類動作:訊息仍說「單已取消」(guard_order_submission 現行版本的行為沒被退回舊版)", async () => {
    await bind();
    const id = await draftBy(U.purchaser);
    await event(U.purchaser, id, "draft", "cancelled", "restaurant");
    for (const to of ["dispatched", "accepted"]) {
      expect(await failure(U.purchaser, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'cancelled',$2,'restaurant','restaurant_portal',$3::jsonb)`, [id, to, JSON.stringify({ supplier_id: SUP_A })]), to)
        .toContain("這張訂單已經取消");
    }
    expect(await failure(U.purchaser, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source) VALUES ($1,'cancelled','submitted','restaurant','restaurant_portal')`, [id]))
      .toContain("老闆或店長簽核");
  });

  it("系統身分(service_role、沒有登入者)仍可 draft → dispatched,不受綁定限制", async () => {
    const id = await draftBy(U.owner);
    await as("system", `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','system','system',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_B })]);
    expect(await orderRow(id)).toEqual({ status: "dispatched", supplier_id: SUP_B });
  });

  it("採購員取消自己的草稿仍可以", async () => {
    const id = await draftBy(U.purchaser);
    await event(U.purchaser, id, "draft", "cancelled", "restaurant");
    expect((await orderRow(id)).status).toBe("cancelled");
  });

  it("餐廳還是不能直接把訂單推到後面的狀態(例如 draft → received)", async () => {
    await bind();
    const id = await draftBy(U.owner);
    await expect(event(U.owner, id, "draft", "received", "restaurant")).rejects.toThrow();
    await expect(event(U.owner, id, "draft", "accepted", "restaurant")).rejects.toThrow();
  });
});

describe("既有往來自動綁定", () => {
  it("已收貨的餐廳 × 供應商補成已綁定;沒收過貨、沒指派供應商、歇業的不補", async () => {
    const fresh = await buildDb(async (d) => {
      const o = (id: string, rest: string, sup: string | null, status: string) =>
        d.query(`INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status) VALUES ($1,$2,$3,$4)`, [id, rest, sup, status]);
      await o("30000000-0000-0000-0000-000000000001", REST_1, SUP_A, "received");
      await o("30000000-0000-0000-0000-000000000002", REST_1, SUP_B, "shipped");
      await o("30000000-0000-0000-0000-000000000003", REST_2, SUP_A, "completed");
      await o("30000000-0000-0000-0000-000000000004", REST_2, SUP_B, "closed");
      await o("30000000-0000-0000-0000-000000000005", REST_1, null, "received");
      await o("30000000-0000-0000-0000-000000000006", REST_1, SUP_OFF, "received");
      // closed:有收貨事件的算,沒有的(爭議直接結案)不算 —— 這裡 REST_2 × SUP_B 沒有事件
    });
    await fresh.exec(MIGRATION);
    const rows = (await fresh.query<{ restaurant_id: string; supplier_id: string; created_by: string | null }>(
      `SELECT restaurant_id, supplier_id, created_by FROM public.restaurant_suppliers ORDER BY restaurant_id, supplier_id`)).rows;
    expect(rows).toEqual([
      { restaurant_id: REST_1, supplier_id: SUP_A, created_by: null },
      { restaurant_id: REST_2, supplier_id: SUP_A, created_by: null },
    ]);
    await fresh.close();
  }, 120_000);

  it("已結案且有收貨事件的算", async () => {
    const fresh = await buildDb(async (d) => {
      await d.query(`INSERT INTO public.supplier_orders (id, restaurant_id, supplier_id, status) VALUES ('30000000-0000-0000-0000-000000000004',$1,$2,'closed')`, [REST_2, SUP_B]);
      // 補一筆歷史的收貨事件:關掉 trigger(狀態機的守門規則不讓一張已結案的單再多一筆 received)
      await d.exec(`SET session_replication_role = replica`);
      await d.query(`INSERT INTO public.order_events (id, order_id, from_status, to_status, actor_role, source) VALUES (gen_random_uuid(),'30000000-0000-0000-0000-000000000004','delivered','received','system','system')`);
      await d.exec(`SET session_replication_role = DEFAULT`);
    });
    await fresh.exec(MIGRATION);
    expect((await fresh.query(`SELECT 1 FROM public.restaurant_suppliers WHERE restaurant_id = $1 AND supplier_id = $2`, [REST_2, SUP_B])).rows).toHaveLength(1);
    await fresh.close();
  }, 120_000);

  it("重複套用 migration 不會出錯,也不會重複綁定(idempotent)", async () => {
    await bind();
    await db.exec(MIGRATION);
    expect((await db.query(`SELECT 1 FROM public.restaurant_suppliers`)).rows).toHaveLength(1);
  });
});

describe("還原檔", () => {
  it("退回 102 條、採購員又不能直接叫貨、綁定表消失", async () => {
    const fresh = await buildDb();
    await fresh.exec(MIGRATION);
    await fresh.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text, name text); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261028110000','x');");
    await fresh.exec(ROLLBACK);

    expect((await fresh.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.order_transition_rules()`)).rows[0].n).toBe(102);
    expect((await fresh.query(`SELECT to_regclass('public.restaurant_suppliers') AS t`)).rows[0]).toEqual({ t: null });
    expect((await fresh.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_restaurant_dispatch'`)).rows).toHaveLength(0);
    expect((await fresh.query(`SELECT * FROM supabase_migrations.schema_migrations`)).rows).toHaveLength(0);

    const rows = await as<{ id: string }>(U.purchaser, `INSERT INTO public.supplier_orders (restaurant_id, status) VALUES ($1,'draft') RETURNING id`, [REST_1], fresh);
    await expect(
      as(U.purchaser, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [rows[0].id, JSON.stringify({ supplier_id: SUP_A })], fresh),
    ).rejects.toThrow();
    await fresh.close();
  }, 120_000);
});
