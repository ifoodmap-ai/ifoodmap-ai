// @vitest-environment node
//
// 餐廳端「依分店與身分看訂單」(20261110100000_restaurant_branch_scope.sql)的行為測試:
// PGlite 重放真正的訂單狀態機 migration + 請款單,再套這一支,用不同身分讀寫真的資料。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REST_1, REST_2, SUP_A, SUP_B, U, buildStateMachineDb, failureOf, migration, rollback, runAs,
} from "./_state-machine-harness";

const INVOICES = "20261022100000_supplier_invoices";
const MIGRATION_NAME = "20261110100000_restaurant_branch_scope";

const B1 = "30000000-0000-0000-0000-0000000000b1"; // 中正店
const B2 = "30000000-0000-0000-0000-0000000000b2"; // 信義店
const O1 = "40000000-0000-0000-0000-0000000000a1"; // B1 的單,派給供應商 A
const O2 = "40000000-0000-0000-0000-0000000000a2"; // B2 的單,派給供應商 B
const O3 = "40000000-0000-0000-0000-0000000000a3"; // 沒有分店的單(舊單)

let db: PGlite;
const as = <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => runAs<T>(db, who, sql, params);
const failure = (who: string | null, sql: string, params: unknown[] = []) => failureOf(db, who, sql, params);
const ids = async (who: string | null, table = "supplier_orders") =>
  (await as<{ id: string }>(who, `SELECT id FROM public.${table} ORDER BY id`)).map((r) => r.id);

/** 帳號所屬分店:null = 沒指派 */
const assign = (user: string, branch: string | null) =>
  db.query(`UPDATE public.restaurant_accounts SET branch_id = $2 WHERE user_id = $1 AND restaurant_id = $3`, [user, branch, REST_1]);

beforeAll(async () => {
  db = await buildStateMachineDb([INVOICES]);
  // 測試資料庫的 supplier_orders 是替身表,沒有 RLS:補上正式庫本來就有的「供應商讀派給自己的單」與「管理員全部」兩條,
  // 餐廳端的 policy 由本次 migration 提供(要驗的就是它)
  await db.exec(`
    ALTER TABLE public.supplier_orders ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "stand-in supplier read" ON public.supplier_orders;
    CREATE POLICY "stand-in supplier read" ON public.supplier_orders FOR SELECT TO authenticated USING (supplier_id IN (SELECT public.current_supplier_ids()));
    DROP POLICY IF EXISTS "stand-in admin all" ON public.supplier_orders;
    CREATE POLICY "stand-in admin all" ON public.supplier_orders FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

    -- 報價也是替身表:照正式庫的 policy(20260727044345)補上「訂單 id 的子查詢」那種寫法(出貨與事件的 policy 是真的 migration 重放出來的)
    ALTER TABLE public.order_quotes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.supplier_shipments ENABLE ROW LEVEL SECURITY; -- policy 本身來自重放的 20260726120000,只是替身表沒開 RLS
    CREATE POLICY "transaction parties read order_quotes" ON public.order_quotes FOR SELECT TO authenticated
      USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.supplier_orders o WHERE o.id = order_quotes.order_id
             AND (o.restaurant_id IN (SELECT public.current_restaurant_ids()) OR o.supplier_id IN (SELECT public.current_supplier_ids()))));`);
  await db.exec(migration(MIGRATION_NAME));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // 注意:不能對 restaurant_branches 用 TRUNCATE ... CASCADE —— 會連帶清空外鍵指向它的 restaurant_accounts(成員)
  await db.exec(`TRUNCATE public.supplier_invoice_orders, public.supplier_invoices, public.order_quotes, public.supplier_shipments, public.order_events RESTART IDENTITY CASCADE;
                 DELETE FROM public.supplier_orders;
                 DELETE FROM public.restaurant_branches;`);
  await db.query(`INSERT INTO public.restaurant_branches (id, restaurant_id, name, address, receiving_hours) VALUES ($1,$3,'中正店','台北市中正區','09:00-11:00'),($2,$3,'信義店','台北市信義區',NULL)`, [B1, B2, REST_1]);
  await db.query(
    `INSERT INTO public.supplier_orders (id, restaurant_id, branch_id, supplier_id, status, ingredient_list) VALUES
       ($1,$4,$5,$7,'dispatched','[]'::jsonb),($2,$4,$6,$8,'dispatched','[]'::jsonb),($3,$4,NULL,NULL,'draft','[]'::jsonb)`,
    [O1, O2, O3, REST_1, B1, B2, SUP_A, SUP_B],
  );
  await db.query(`UPDATE public.restaurant_accounts SET is_active = true`); // 有的測試會停用帳號
  await assign(U.owner, null);
  await assign(U.manager, B1);
  await assign(U.purchaser, B1);
});

describe("誰看得到哪些訂單", () => {
  it("老闆看得到所有分店的訂單", async () => {
    expect(await ids(U.owner)).toEqual([O1, O2, O3]);
  });

  it("老闆就算被指派了分店,還是看全部(老闆的範圍是整家餐廳)", async () => {
    await assign(U.owner, B1);
    expect(await ids(U.owner)).toEqual([O1, O2, O3]);
  });

  it("店長 / 採購員只看自己分店的單,加上沒有分店的單;別家分店的單看不到", async () => {
    expect(await ids(U.manager)).toEqual([O1, O3]);
    expect(await ids(U.purchaser)).toEqual([O1, O3]);
    await assign(U.manager, B2);
    expect(await ids(U.manager)).toEqual([O2, O3]);
  });

  it("還沒指派分店的店長 / 採購員維持看全部(舊帳號不會突然看不到東西)", async () => {
    await assign(U.manager, null);
    await assign(U.purchaser, null);
    expect(await ids(U.manager)).toEqual([O1, O2, O3]);
    expect(await ids(U.purchaser)).toEqual([O1, O2, O3]);
  });

  it("別家餐廳的老闆、不相干的人、匿名都看不到;管理員看全部;供應商只看派給自己的", async () => {
    expect(await ids(U.otherOwner)).toEqual([]);
    expect(await ids(U.stranger)).toEqual([]);
    expect(await as(null, `SELECT 1 FROM public.supplier_orders`)).toHaveLength(0); // 匿名:沒有任何 policy 放行
    expect(await ids("admin")).toEqual([O1, O2, O3]);
    expect(await ids(U.supA)).toEqual([O1]);
    expect(await ids(U.supB)).toEqual([O2]);
  });

  it("停用的帳號看不到任何東西", async () => {
    await db.query(`UPDATE public.restaurant_accounts SET is_active = false WHERE user_id = $1`, [U.manager]);
    expect(await ids(U.manager)).toEqual([]);
  });
});

describe("連動的表跟著收緊(訂單事件、報價、出貨)", () => {
  it("別家分店訂單的事件、報價、出貨紀錄,店長也看不到;自己分店的看得到", async () => {
    await db.query(`INSERT INTO public.order_quotes (order_id, supplier_id, total_amount, status) VALUES ($1,$3,100,'quoted'),($2,$4,200,'quoted')`, [O1, O2, SUP_A, SUP_B]);
    await db.query(`INSERT INTO public.supplier_shipments (order_id, supplier_id) VALUES ($1,$3),($2,$4)`, [O1, O2, SUP_A, SUP_B]);
    // 直接寫事件要用系統身分(runAs 設的使用者會留在 session 裡,先清掉)
    await db.query(`SELECT set_config('test.uid', '', false), set_config('test.jwt', '', false), set_config('test.role', 'service_role', false)`);
    await db.query(`INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source) VALUES ($1,'dispatched','accepted','system','system'),($2,'dispatched','accepted','system','system')`, [O1, O2]);

    const orderIds = async (who: string, table: string) => (await as<{ order_id: string }>(who, `SELECT order_id FROM public.${table}`)).map((r) => r.order_id);
    for (const table of ["order_quotes", "supplier_shipments", "order_events"]) {
      expect(await orderIds(U.manager, table), table).toEqual([O1]);
      expect((await orderIds(U.owner, table)).sort(), table).toEqual([O1, O2]);
    }
  });
});

describe("寫入:只能動自己分店的單", () => {
  const insertDraft = (who: string, branch: string | null) =>
    as(who, `INSERT INTO public.supplier_orders (restaurant_id, branch_id, status, ingredient_list) VALUES ($1,$2,'draft','[]'::jsonb) RETURNING id`, [REST_1, branch]);

  it("店長 / 採購員只能建自己分店(或沒有分店)的單,建到別家分店會被擋", async () => {
    expect(await insertDraft(U.manager, B1)).toHaveLength(1);
    expect(await insertDraft(U.purchaser, null)).toHaveLength(1);
    expect(await failure(U.manager, `INSERT INTO public.supplier_orders (restaurant_id, branch_id, status, ingredient_list) VALUES ($1,$2,'draft','[]'::jsonb)`, [REST_1, B2])).toMatch(/row-level security/);
    expect(await failure(U.purchaser, `INSERT INTO public.supplier_orders (restaurant_id, branch_id, status, ingredient_list) VALUES ($1,$2,'draft','[]'::jsonb)`, [REST_1, B2])).toMatch(/row-level security/);
  });

  it("老闆可以替任何分店建單;別家餐廳的人不能替這家建單", async () => {
    expect(await insertDraft(U.owner, B2)).toHaveLength(1);
    expect(await failure(U.otherOwner, `INSERT INTO public.supplier_orders (restaurant_id, branch_id, status, ingredient_list) VALUES ($1,$2,'draft','[]'::jsonb)`, [REST_1, B1])).toMatch(/row-level security/);
  });

  it("改單:店長只改得到自己分店的單,別家分店的單改不到(0 列)", async () => {
    expect(await as(U.manager, `UPDATE public.supplier_orders SET notes = '改' WHERE id = $1 RETURNING 1`, [O3])).toHaveLength(1);
    expect(await as(U.manager, `UPDATE public.supplier_orders SET notes = '改' WHERE id = $1 RETURNING 1`, [O2])).toHaveLength(0);
    expect(await as(U.owner, `UPDATE public.supplier_orders SET notes = '改' WHERE id = $1 RETURNING 1`, [O2])).toHaveLength(1);
  });

  it("不能把訂單改去別家分店(改完自己就看不到、也不該能改)", async () => {
    expect(await failure(U.manager, `UPDATE public.supplier_orders SET branch_id = $2 WHERE id = $1`, [O3, B2])).toMatch(/row-level security|不能換/);
  });
});

describe("請款單是整家餐廳層級:老闆、或沒指派分店的店長才看得到", () => {
  const SUPPLIER_INVOICE = `INSERT INTO public.supplier_invoices (invoice_no, supplier_id, restaurant_id, period_kind, period_start, period_end, due_date, total_amount)
                            VALUES ('INV-1',$1,$2,'daily','2026-11-01','2026-11-01','2026-11-01',100)`;

  it("老闆看得到;有指派分店的店長、採購員看不到;沒指派分店的店長看得到", async () => {
    await db.query(SUPPLIER_INVOICE, [SUP_A, REST_1]);
    expect(await as(U.owner, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.manager, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(0);
    expect(await as(U.purchaser, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(0);
    await assign(U.manager, null);
    expect(await as(U.manager, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.supA, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(1); // 供應商不受影響
    expect(await as(U.otherOwner, `SELECT 1 FROM public.supplier_invoices`)).toHaveLength(0);
  });
});

describe("供應商讀得到派給自己的訂單所屬分店(送貨地點)", () => {
  it("供應商 A 只讀得到訂單 O1 的分店(中正店),看不到信義店;沒有派給他的分店一律看不到", async () => {
    const rows = await as<{ name: string; address: string; receiving_hours: string | null }>(U.supA, `SELECT name, address, receiving_hours FROM public.restaurant_branches`);
    expect(rows).toEqual([{ name: "中正店", address: "台北市中正區", receiving_hours: "09:00-11:00" }]);
    expect((await as<{ name: string }>(U.supB, `SELECT name FROM public.restaurant_branches`)).map((r) => r.name)).toEqual(["信義店"]);
    expect(await as(U.stranger, `SELECT 1 FROM public.restaurant_branches`)).toHaveLength(0);
  });

  it("供應商只能讀,不能新增、修改、刪除分店", async () => {
    expect(await failure(U.supA, `INSERT INTO public.restaurant_branches (restaurant_id, name) VALUES ($1,'偷建')`, [REST_1])).toMatch(/row-level security/);
    expect(await as(U.supA, `UPDATE public.restaurant_branches SET name = '改' RETURNING 1`)).toHaveLength(0);
    expect(await as(U.supA, `DELETE FROM public.restaurant_branches RETURNING 1`)).toHaveLength(0);
  });

  it("餐廳成員讀分店的方式不變:同一家餐廳的成員看得到全部分店(店長要選分店、指派成員用)", async () => {
    expect((await as<{ name: string }>(U.manager, `SELECT name FROM public.restaurant_branches ORDER BY name`)).map((r) => r.name)).toEqual(["中正店", "信義店"]);
    expect(await as(U.otherOwner, `SELECT 1 FROM public.restaurant_branches`)).toHaveLength(0);
  });
});

describe("rollback", () => {
  it("還原後:同一家餐廳的成員又看得到全部訂單,判斷函式消失;重新套用沒問題", async () => {
    await db.exec(rollback(MIGRATION_NAME));
    expect(await ids(U.manager)).toEqual([O1, O2, O3]);
    expect((await db.query(`SELECT 1 FROM pg_proc WHERE proname IN ('can_see_branch_order','can_see_all_branches')`)).rows).toHaveLength(0);
    expect(await as(U.supA, `SELECT 1 FROM public.restaurant_branches`)).toHaveLength(0);
    await db.exec(migration(MIGRATION_NAME));
    expect(await ids(U.manager)).toEqual([O1, O3]);
  });
});

void REST_2;
