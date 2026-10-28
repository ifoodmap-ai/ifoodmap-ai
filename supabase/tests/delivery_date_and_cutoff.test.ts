// @vitest-environment node
//
// 配送日與截單時間(20261029100000_delivery_date_and_cutoff.sql)的行為測試:
// PGlite 重放真正的訂單狀態機 migration 與 20261028110000(綁定),再套這一支,用不同身分寫真的訂單事件。
// 時間相關的規則用「相對今天」的日期與 00:00 的截單時間排出確定的結果(不依賴測試跑在幾點)。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REST_1, REST_2, SUP_A, SUP_B, U, buildStateMachineDb, failureOf, migration, rollback, runAs,
} from "./_state-machine-harness";

const BINDING = "20261028110000_restaurant_supplier_binding";
const MIGRATION_NAME = "20261029100000_delivery_date_and_cutoff";

let db: PGlite;
const as = <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => runAs<T>(db, who, sql, params);
const failure = (who: string | null, sql: string, params: unknown[] = []) => failureOf(db, who, sql, params);

/** 台灣時間的今天 + n 天(YYYY-MM-DD) */
const day = async (n: number) =>
  (await db.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date + $1::int)::text AS d`, [n])).rows[0].d;
const dow = async (d: string) => (await db.query<{ n: number }>(`SELECT extract(dow FROM $1::date)::int AS n`, [d])).rows[0].n;

const bind = (restaurant = REST_1, supplier = SUP_A) =>
  db.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [restaurant, supplier]);

const setRules = (over: { cutoff?: string; lead?: number; weekdays?: number[] } = {}, supplier = SUP_A) =>
  db.query(
    `INSERT INTO public.supplier_order_settings (supplier_id, cutoff_time, lead_days, delivery_weekdays) VALUES ($1,$2,$3,$4::smallint[])
     ON CONFLICT (supplier_id) DO UPDATE SET cutoff_time = EXCLUDED.cutoff_time, lead_days = EXCLUDED.lead_days, delivery_weekdays = EXCLUDED.delivery_weekdays`,
    [supplier, over.cutoff ?? "22:00", over.lead ?? 1, over.weekdays ?? [0, 1, 2, 3, 4, 5, 6]],
  );

const draft = async (who: string, deliveryDate: string | null, restaurant = REST_1) =>
  (await as<{ id: string }>(
    who,
    `INSERT INTO public.supplier_orders (restaurant_id, status, delivery_date, ingredient_list) VALUES ($1,'draft',$2,'[{"name":"高麗菜","quantity":"5","unit":"kg"}]'::jsonb) RETURNING id`,
    [restaurant, deliveryDate],
  ))[0].id;

const dispatchSql = `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`;
const dispatch = (who: string, id: string, supplier = SUP_A) => as(who, dispatchSql, [id, JSON.stringify({ supplier_id: supplier })]);
const dispatchFails = (who: string, id: string, supplier = SUP_A) => failure(who, dispatchSql, [id, JSON.stringify({ supplier_id: supplier })]);
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].status;

beforeAll(async () => {
  db = await buildStateMachineDb([BINDING]);
  await db.exec(migration(MIGRATION_NAME));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.restaurant_suppliers, public.supplier_order_settings, public.order_quotes, public.supplier_shipments, public.order_events RESTART IDENTITY CASCADE;
                 DELETE FROM public.supplier_orders;`);
});

describe("接單規則 supplier_order_settings", () => {
  it("預設值:22:00 截單、提前 1 天、每天配送", async () => {
    await db.query(`INSERT INTO public.supplier_order_settings (supplier_id) VALUES ($1)`, [SUP_A]);
    const r = (await db.query<{ cutoff_time: string; lead_days: number; delivery_weekdays: number[] }>(`SELECT cutoff_time::text, lead_days, delivery_weekdays FROM public.supplier_order_settings`)).rows[0];
    expect(r).toEqual({ cutoff_time: "22:00:00", lead_days: 1, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] });
  });

  it("供應商自己的帳號可以新增、修改、刪除自己的規則;別家供應商不行", async () => {
    await as(U.supA, `INSERT INTO public.supplier_order_settings (supplier_id, cutoff_time, lead_days, delivery_weekdays) VALUES ($1,'20:30',2,'{1,2,3}')`, [SUP_A]);
    await as(U.supA, `UPDATE public.supplier_order_settings SET lead_days = 0 WHERE supplier_id = $1`, [SUP_A]);
    expect((await db.query<{ lead_days: number }>(`SELECT lead_days FROM public.supplier_order_settings`)).rows[0].lead_days).toBe(0);

    expect(await failure(U.supB, `INSERT INTO public.supplier_order_settings (supplier_id) VALUES ($1)`, [SUP_A])).toMatch(/row-level security/);
    expect(await as(U.supB, `UPDATE public.supplier_order_settings SET lead_days = 5 WHERE supplier_id = $1 RETURNING 1`, [SUP_A])).toHaveLength(0);
    expect(await as(U.supB, `DELETE FROM public.supplier_order_settings WHERE supplier_id = $1 RETURNING 1`, [SUP_A])).toHaveLength(0);
    expect(await as(U.supA, `DELETE FROM public.supplier_order_settings WHERE supplier_id = $1 RETURNING 1`, [SUP_A])).toHaveLength(1);
  });

  it("已綁定這家供應商的餐廳成員(含採購員)與管理員讀得到;沒綁定的、別家餐廳、匿名讀不到;餐廳不能寫", async () => {
    await setRules();
    await bind(REST_1, SUP_A);
    for (const who of [U.owner, U.manager, U.purchaser, U.supA, "admin"]) {
      expect(await as(who, `SELECT 1 FROM public.supplier_order_settings`), who).toHaveLength(1);
    }
    for (const who of [U.otherOwner, U.supB, U.stranger]) {
      expect(await as(who, `SELECT 1 FROM public.supplier_order_settings`), who).toHaveLength(0);
    }
    expect(await failure(null, `SELECT 1 FROM public.supplier_order_settings`)).toMatch(/permission denied/);
    expect(await failure(U.owner, `INSERT INTO public.supplier_order_settings (supplier_id) VALUES ($1)`, [SUP_B])).toMatch(/row-level security/);
    expect(await as(U.owner, `UPDATE public.supplier_order_settings SET lead_days = 9 WHERE supplier_id = $1 RETURNING 1`, [SUP_A])).toHaveLength(0);
  });

  it.each([
    ["提前天數超過 14", `INSERT INTO public.supplier_order_settings (supplier_id, lead_days) VALUES ($1, 15)`],
    ["提前天數是負的", `INSERT INTO public.supplier_order_settings (supplier_id, lead_days) VALUES ($1, -1)`],
    ["配送日是空的", `INSERT INTO public.supplier_order_settings (supplier_id, delivery_weekdays) VALUES ($1, '{}')`],
    ["配送日有 7 以上的數字", `INSERT INTO public.supplier_order_settings (supplier_id, delivery_weekdays) VALUES ($1, '{1,7}')`],
  ])("不合理的設定被擋:%s", async (_label, sql) => {
    await expect(db.query(sql, [SUP_A])).rejects.toThrow(/violates check constraint/);
  });
});

describe("直接叫貨的配送日檢查", () => {
  it("供應商沒有設接單規則:配送日可有可無,但不能是過去的日子", async () => {
    await bind();
    const none = await draft(U.owner, null);
    await dispatch(U.owner, none);
    expect(await statusOf(none)).toBe("dispatched");

    const future = await draft(U.manager, await day(3));
    await dispatch(U.manager, future);
    expect(await statusOf(future)).toBe("dispatched");

    const past = await draft(U.purchaser, await day(-1));
    expect(await dispatchFails(U.purchaser, past)).toContain("配送日不能早於今天");
    expect(await statusOf(past)).toBe("draft");
  });

  it("供應商有設接單規則:一定要選配送日", async () => {
    await bind();
    await setRules();
    const id = await draft(U.owner, null);
    expect(await dispatchFails(U.owner, id)).toContain("請先選擇配送日期");
  });

  it("過了截單時間不能叫:提前 1 天、00:00 截單 → 明天的配送日已經截單,後天還來得及", async () => {
    await bind();
    await setRules({ lead: 1, cutoff: "00:00" });
    const tomorrow = await draft(U.owner, await day(1));
    expect(await dispatchFails(U.owner, tomorrow)).toContain("超過這個配送日的截單時間");
    const later = await draft(U.owner, await day(2));
    await dispatch(U.owner, later);
    expect(await statusOf(later)).toBe("dispatched");
  });

  it("當天截單(提前 0 天):今天已經截單,明天還來得及", async () => {
    await bind();
    await setRules({ lead: 0, cutoff: "00:00" });
    const today = await draft(U.purchaser, await day(0));
    expect(await dispatchFails(U.purchaser, today)).toContain("超過這個配送日的截單時間");
    const tomorrow = await draft(U.purchaser, await day(1));
    await dispatch(U.purchaser, tomorrow);
    expect(await statusOf(tomorrow)).toBe("dispatched");
  });

  it("提前很多天、截單很晚:還來得及就能叫", async () => {
    await bind();
    await setRules({ lead: 1, cutoff: "23:59" });
    const id = await draft(U.owner, await day(3));
    await dispatch(U.owner, id);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("那天不配送就不能叫(例如週日公休)", async () => {
    await bind();
    const target = await day(5);
    const weekday = await dow(target);
    await setRules({ lead: 0, cutoff: "00:00", weekdays: [0, 1, 2, 3, 4, 5, 6].filter((n) => n !== weekday) });
    const id = await draft(U.owner, target);
    expect(await dispatchFails(U.owner, id)).toContain("這一天不配送");
    // 隔天(只要不是同一個星期幾)就可以
    const next = await draft(U.owner, await day(6));
    await dispatch(U.owner, next);
    expect(await statusOf(next)).toBe("dispatched");
  });

  it("規則是看「叫的那一家」:A 家有規則不影響向 B 家叫貨", async () => {
    await bind(REST_1, SUP_A);
    await bind(REST_1, SUP_B);
    await setRules({ lead: 1, cutoff: "00:00" }, SUP_A);
    const id = await draft(U.owner, await day(1));
    await dispatch(U.owner, id, SUP_B);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("管理員派單、系統身分不受配送日規則限制", async () => {
    await setRules({ lead: 1, cutoff: "00:00" });
    const a = await draft(U.owner, null);
    await as("admin", `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','admin','admin_portal',$2::jsonb)`, [a, JSON.stringify({ supplier_id: SUP_A })]);
    expect(await statusOf(a)).toBe("dispatched");
    const b = await draft(U.owner, await day(-5));
    await as("system", `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','system','system',$2::jsonb)`, [b, JSON.stringify({ supplier_id: SUP_A })]);
    expect(await statusOf(b)).toBe("dispatched");
  });

  it("沒綁定的供應商仍然叫不了(原本的檢查沒被這支蓋掉)", async () => {
    const id = await draft(U.owner, await day(3));
    expect(await dispatchFails(U.owner, id)).toContain("只能向已綁定的合作供應商叫貨");
  });
});

describe("送出之後配送日鎖住", () => {
  it("草稿可以隨便改配送日", async () => {
    const id = await draft(U.purchaser, await day(2));
    const target = await day(4);
    await as(U.purchaser, `UPDATE public.supplier_orders SET delivery_date = $2 WHERE id = $1`, [id, target]);
    expect((await db.query<{ d: string }>(`SELECT delivery_date::text AS d FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].d).toBe(target);
  });

  it("叫貨之後,餐廳(老闆、店長、採購員)與供應商都不能直接改配送日", async () => {
    await bind();
    const id = await draft(U.owner, await day(3));
    await dispatch(U.owner, id);
    for (const who of [U.owner, U.manager, U.purchaser, U.supA]) {
      expect(await failure(who, `UPDATE public.supplier_orders SET delivery_date = $2 WHERE id = $1`, [id, await day(10)]), who)
        .toMatch(/配送日不能直接修改|row-level security|permission denied|只有老闆或店長可以修改/);
    }
    expect((await db.query<{ d: string }>(`SELECT delivery_date::text AS d FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].d).toBe(await day(3));
  });

  it("管理員可以改配送日", async () => {
    await bind();
    const id = await draft(U.owner, await day(3));
    await dispatch(U.owner, id);
    await as("admin", `UPDATE public.supplier_orders SET delivery_date = $2 WHERE id = $1`, [id, await day(7)]);
    expect((await db.query<{ d: string }>(`SELECT delivery_date::text AS d FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].d).toBe(await day(7));
  });
});

describe("還原檔", () => {
  it("退回只檢查綁定:拆掉配送日欄位與規則表、鎖定 trigger", async () => {
    const fresh = await buildStateMachineDb([BINDING]);
    await fresh.exec(migration(MIGRATION_NAME));
    await fresh.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text, name text); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261029100000','x');");
    await fresh.exec(rollback(MIGRATION_NAME));

    expect((await fresh.query(`SELECT to_regclass('public.supplier_order_settings') AS t`)).rows[0]).toEqual({ t: null });
    expect((await fresh.query(`SELECT 1 FROM information_schema.columns WHERE table_name='supplier_orders' AND column_name='delivery_date'`)).rows).toHaveLength(0);
    expect((await fresh.query(`SELECT 1 FROM pg_trigger WHERE tgname='trg_guard_delivery_date_lock'`)).rows).toHaveLength(0);
    expect((await fresh.query(`SELECT * FROM supabase_migrations.schema_migrations`)).rows).toHaveLength(0);

    // 綁定的檢查還在:沒綁定的供應商仍叫不了,綁定了就能叫
    const id = (await runAs<{ id: string }>(fresh, U.owner, `INSERT INTO public.supplier_orders (restaurant_id, status) VALUES ($1,'draft') RETURNING id`, [REST_1]))[0].id;
    await expect(runAs(fresh, U.owner, dispatchSql, [id, JSON.stringify({ supplier_id: SUP_A })])).rejects.toThrow(/只能向已綁定/);
    await fresh.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A]);
    await runAs(fresh, U.owner, dispatchSql, [id, JSON.stringify({ supplier_id: SUP_A })]);
    await fresh.close();
  }, 120_000);
});
