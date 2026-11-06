// @vitest-environment node
//
// 約定價成交(20261107100000_standing_price_orders.sql)的行為測試:
// PGlite 重放真正的訂單狀態機 migration + 綁定 + 配送日 + 客戶價格 / 群組價,再套這一支,用不同身分寫真的訂單事件。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REST_1, REST_2, SUP_A, SUP_B, U, buildStateMachineDb, failureOf, migration, rollback, runAs,
} from "./_state-machine-harness";

const BINDING = "20261028110000_restaurant_supplier_binding";
const DELIVERY = "20261029100000_delivery_date_and_cutoff";
const PRICES = "20261029110000_customer_prices_and_limits";
const MIGRATION_NAME = "20261107100000_standing_price_orders";
// repo 的 migration 沒有收錄 supplies(最早期的表),只留用得到的欄位
const SUPPLIES = `CREATE TABLE public.supplies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE, name text NOT NULL, price numeric, is_available boolean NOT NULL DEFAULT true);`;

let db: PGlite;
const as = <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => runAs<T>(db, who, sql, params);
const failure = (who: string | null, sql: string, params: unknown[] = []) => failureOf(db, who, sql, params);

const CABBAGE = "50000000-0000-0000-0000-00000000c001";
const EGG = "50000000-0000-0000-0000-00000000c002";
const FISH = "50000000-0000-0000-0000-00000000c003"; // 沒有定價
const GROUP = "60000000-0000-0000-0000-00000000a001";

type Item = { name: string; quantity: string; unit?: string };
const ITEMS: Item[] = [{ name: "高麗菜", quantity: "10", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }]; // 10×45 + 2×620 = 1690

const bind = (restaurant = REST_1, supplier = SUP_A) =>
  db.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [restaurant, supplier]);
const propose = (who = U.supA, restaurant = REST_1, supplier = SUP_A) =>
  as(who, `INSERT INTO public.supplier_standing_agreements (supplier_id, restaurant_id) VALUES ($1,$2)`, [supplier, restaurant]);
const agree = (who = U.owner, restaurant = REST_1, supplier = SUP_A) =>
  as(who, `UPDATE public.supplier_standing_agreements SET status = 'active' WHERE supplier_id = $1 AND restaurant_id = $2 RETURNING 1`, [supplier, restaurant]);
const activate = async (restaurant = REST_1, supplier = SUP_A) => { await propose(U.supA, restaurant, supplier); await agree(U.owner, restaurant, supplier); };

/** 已經派給供應商 A、等待接單的訂單(經過真的事件流程) */
const dispatched = async (items: Item[] = ITEMS, restaurant = REST_1) => {
  const id = (await as<{ id: string }>(U.owner, `INSERT INTO public.supplier_orders (restaurant_id, status, ingredient_list) VALUES ($1,'draft',$2::jsonb) RETURNING id`, [restaurant, JSON.stringify(items)]))[0].id;
  await as(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_A })]);
  return id;
};
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].status;
const total = async (id: string) => (await db.query<{ t: string | null }>(`SELECT public.standing_order_total($1)::text AS t`, [id])).rows[0].t;
const accept = (who: string | null, id: string) => as<{ standing_accept_order: { status: string; total_amount: number } }>(who, `SELECT public.standing_accept_order($1) AS standing_accept_order`, [id]);
const events = async (id: string) =>
  (await db.query<{ from_status: string; to_status: string; actor_role: string; source: string; payload: Record<string, unknown>; note: string }>(
    `SELECT from_status, to_status, actor_role, source, payload, note FROM public.order_events WHERE order_id = $1 ORDER BY created_at, id`, [id])).rows;

beforeAll(async () => {
  db = await buildStateMachineDb([BINDING, DELIVERY, PRICES], SUPPLIES);
  await db.exec(migration(MIGRATION_NAME));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.supplier_standing_agreements, public.restaurant_suppliers, public.supplier_customer_prices,
                          public.supplier_group_prices, public.supplier_customer_group_members, public.supplier_customer_groups,
                          public.supplies, public.order_quotes, public.supplier_shipments, public.order_events RESTART IDENTITY CASCADE;
                 DELETE FROM public.supplier_orders;`);
  await db.query(`INSERT INTO public.supplies (id, supplier_id, name, price) VALUES ($1,$4,'高麗菜',45),($2,$4,'雞蛋',620),($3,$4,'吳郭魚',NULL)`, [CABBAGE, EGG, FISH, SUP_A]);
  await bind();
});

describe("約定價協議:供應商提議 → 餐廳老闆 / 店長同意", () => {
  it("供應商只能對已綁定的客戶提議,而且只能是「提議」;自己不能把它改成生效", async () => {
    await propose();
    expect((await db.query<{ status: string; proposed_by: string }>(`SELECT status, proposed_by FROM public.supplier_standing_agreements`)).rows).toEqual([{ status: "proposed", proposed_by: U.supA }]);
    expect(await failure(U.supA, `INSERT INTO public.supplier_standing_agreements (supplier_id, restaurant_id) VALUES ($1,$2)`, [SUP_A, REST_2])).toContain("還沒有綁定你");
    expect(await failure(U.supA, `INSERT INTO public.supplier_standing_agreements (supplier_id, restaurant_id, status, agreed_at) VALUES ($1,$2,'active', now())`, [SUP_A, REST_2])).toMatch(/row-level security|只能先「提議」/);
    expect(await as(U.supA, `UPDATE public.supplier_standing_agreements SET status = 'active' RETURNING 1`)).toHaveLength(0);
    expect(await failure(U.supB, `INSERT INTO public.supplier_standing_agreements (supplier_id, restaurant_id) VALUES ($1,$2)`, [SUP_A, REST_1])).toMatch(/row-level security/);
  });

  it("老闆、店長可以同意(同意人與時間由伺服器填);採購員、別家餐廳的老闆、供應商都不行", async () => {
    await propose();
    for (const who of [U.purchaser, U.otherOwner, U.supA, U.stranger]) expect(await agree(who), who).toHaveLength(0);
    expect(await agree(U.manager)).toHaveLength(1);
    const row = (await db.query<{ status: string; agreed_by: string; agreed_at: string | null }>(`SELECT status, agreed_by, agreed_at::text FROM public.supplier_standing_agreements`)).rows[0];
    expect(row.status).toBe("active");
    expect(row.agreed_by).toBe(U.manager);
    expect(row.agreed_at).not.toBeNull();
    // 同意之後不能再改
    expect(await as(U.owner, `UPDATE public.supplier_standing_agreements SET status = 'proposed' RETURNING 1`)).toHaveLength(0);
    expect(await failure(U.owner, `UPDATE public.supplier_standing_agreements SET status = 'proposed'`).catch((e) => String(e))).toBeTruthy();
  });

  it("誰看得到:供應商自己、這家餐廳所有成員(採購員也看得到有沒有約定);別家看不到", async () => {
    await activate();
    for (const who of [U.supA, U.owner, U.manager, U.purchaser, "admin"]) expect(await as(who, `SELECT 1 FROM public.supplier_standing_agreements`), who).toHaveLength(1);
    for (const who of [U.supB, U.otherOwner, U.stranger]) expect(await as(who, `SELECT 1 FROM public.supplier_standing_agreements`), who).toHaveLength(0);
    expect(await failure(null, `SELECT 1 FROM public.supplier_standing_agreements`)).toMatch(/permission denied/);
  });

  it("停用:供應商、餐廳老闆 / 店長都能刪;採購員不行;刪掉後可以重新提議", async () => {
    await activate();
    expect(await as(U.purchaser, `DELETE FROM public.supplier_standing_agreements RETURNING 1`)).toHaveLength(0);
    expect(await as(U.supB, `DELETE FROM public.supplier_standing_agreements RETURNING 1`)).toHaveLength(0);
    expect(await as(U.manager, `DELETE FROM public.supplier_standing_agreements RETURNING 1`)).toHaveLength(1);
    await propose();
    expect(await as(U.supA, `DELETE FROM public.supplier_standing_agreements RETURNING 1`)).toHaveLength(1);
    await propose();
  });
});

describe("standing_order_total:專屬價 > 群組價 > 定價,算不出來就是 NULL", () => {
  it("只有定價:10×45 + 2×620 = 1690", async () => {
    expect(await total(await dispatched())).toBe("1690.00");
  });

  it("群組價蓋過定價、客戶專屬價蓋過群組價", async () => {
    await as(U.supA, `INSERT INTO public.supplier_customer_groups (id, supplier_id, name) VALUES ($1,$2,'連鎖店')`, [GROUP, SUP_A]);
    await as(U.supA, `INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)`, [SUP_A, REST_1, GROUP]);
    await as(U.supA, `INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,38),($1,$4,$3,600)`, [GROUP, CABBAGE, SUP_A, EGG]);
    const id = await dispatched();
    expect(await total(id)).toBe("1580.00"); // 10×38 + 2×600
    await as(U.supA, `INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,40)`, [REST_1, CABBAGE, SUP_A]);
    expect(await total(id)).toBe("1600.00"); // 10×40 + 2×600
  });

  it("小數數量與四捨五入到分", async () => {
    expect(await total(await dispatched([{ name: "高麗菜", quantity: "2.5" }, { name: " 高 麗菜", quantity: "0.333" }]))).toBe("127.49"); // 112.5 + 14.985 → 127.485 → 127.49
  });

  it.each([
    ["對不到商品", [{ name: "牛肉", quantity: "1" }]],
    ["商品沒有價格", [{ name: "吳郭魚", quantity: "1" }]],
    ["數量不是純數字", [{ name: "高麗菜", quantity: "3箱" }]],
    ["數量是 0", [{ name: "高麗菜", quantity: "0" }]],
    ["沒有品項", []],
    ["其中一項算不出來(整張都不算)", [{ name: "高麗菜", quantity: "1" }, { name: "牛肉", quantity: "1" }]],
  ])("%s → NULL", async (_label, items) => {
    expect(await total(await dispatched(items as Item[]))).toBeNull();
  });

  it("商品下架、或品名對到好幾個商品 → NULL(不猜)", async () => {
    const id = await dispatched([{ name: "高麗菜", quantity: "1" }]);
    expect(await total(id)).toBe("45.00");
    await db.query(`UPDATE public.supplies SET is_available = false WHERE id = $1`, [CABBAGE]);
    expect(await total(id)).toBeNull();
    await db.query(`UPDATE public.supplies SET is_available = true WHERE id = $1`, [CABBAGE]);
    await db.query(`INSERT INTO public.supplies (supplier_id, name, price) VALUES ($1,'高麗 菜',50)`, [SUP_A]);
    expect(await total(id)).toBeNull();
  });

  it("別家供應商的商品價格不會拿來算", async () => {
    await db.query(`INSERT INTO public.supplies (supplier_id, name, price) VALUES ($1,'牛肉',999)`, [SUP_B]);
    expect(await total(await dispatched([{ name: "牛肉", quantity: "1" }]))).toBeNull();
  });
});

describe("standing_accept_order:接單 → 報價 → 成交,同一個交易", () => {
  it("協議生效、每個品項都有價:訂單直接進「待出貨」;三筆事件的身分與金額都記在履歷", async () => {
    await activate();
    const id = await dispatched();
    expect((await accept(U.supA, id))[0].standing_accept_order).toEqual({ status: "confirmed", total_amount: 1690 });

    expect(await statusOf(id)).toBe("confirmed");
    expect((await db.query<{ t: string }>(`SELECT total_amount::text AS t FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].t).toBe("1690.00");
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.order_quotes WHERE order_id = $1`, [id])).rows[0].n).toBe(1);

    const ev = (await events(id)).slice(1); // 第一筆是餐廳叫貨
    expect(ev.map((e) => `${e.from_status}→${e.to_status}:${e.actor_role}/${e.source}`)).toEqual([
      "dispatched→accepted:supplier/supplier_portal",
      "accepted→quoted:system/system",
      "quoted→confirmed:system/system",
    ]);
    expect(ev[1].payload).toMatchObject({ standing_price: true, total_amount: 1690 });
    expect(ev[2].payload).toMatchObject({ standing_price: true });
  });

  it("接著供應商可以照一般流程出貨", async () => {
    await activate();
    const id = await dispatched();
    await accept(U.supA, id);
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'confirmed','shipped','supplier','supplier_portal','{}'::jsonb)`, [id]);
    expect(await statusOf(id)).toBe("shipped");
  });

  it("沒有協議、或還只是「提議」:不能用,訂單維持待接單、沒有任何新事件", async () => {
    const id = await dispatched();
    expect(await failure(U.supA, `SELECT public.standing_accept_order($1)`, [id])).toContain("沒有生效的約定價");
    await propose();
    expect(await failure(U.supA, `SELECT public.standing_accept_order($1)`, [id])).toContain("沒有生效的約定價");
    expect(await statusOf(id)).toBe("dispatched");
    expect(await events(id)).toHaveLength(1);
  });

  it("有品項算不出價格:整個交易回滾,訂單維持待接單,供應商改走一般流程", async () => {
    await activate();
    const id = await dispatched([{ name: "高麗菜", quantity: "1" }, { name: "牛肉", quantity: "1" }]);
    expect(await failure(U.supA, `SELECT public.standing_accept_order($1)`, [id])).toContain("有品項沒有可用的價格");
    expect(await statusOf(id)).toBe("dispatched");
    expect(await events(id)).toHaveLength(1);
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'dispatched','accepted','supplier','supplier_portal','{}'::jsonb)`, [id]);
    expect(await statusOf(id)).toBe("accepted");
  });

  it("只有這張單的供應商能用;匿名、餐廳、別家供應商都不行", async () => {
    await activate();
    const id = await dispatched();
    for (const who of [U.supB, U.owner, U.stranger]) expect(await failure(who, `SELECT public.standing_accept_order($1)`, [id]), who).toContain("不是派給你的供應商");
    expect(await failure(null, `SELECT public.standing_accept_order($1)`, [id])).toMatch(/permission denied/);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("狀態已經不是待接單(例如已經接過單):報畫面過期", async () => {
    await activate();
    const id = await dispatched();
    await accept(U.supA, id);
    expect(await failure(U.supA, `SELECT public.standing_accept_order($1)`, [id])).toContain("畫面上的資料過期");
  });

  it("客戶解除綁定後,約定價就不生效", async () => {
    await activate();
    const id = await dispatched();
    await db.query(`DELETE FROM public.restaurant_suppliers WHERE restaurant_id = $1 AND supplier_id = $2`, [REST_1, SUP_A]);
    expect(await failure(U.supA, `SELECT public.standing_accept_order($1)`, [id])).toContain("沒有生效的約定價");
  });

  it("價格在叫貨之後調整:成交金額用「接單當下」的價格", async () => {
    await activate();
    const id = await dispatched([{ name: "高麗菜", quantity: "10" }]);
    await db.query(`UPDATE public.supplies SET price = 50 WHERE id = $1`, [CABBAGE]);
    expect((await accept(U.supA, id))[0].standing_accept_order.total_amount).toBe(500);
  });
});

describe("繞過約定價流程的嘗試都會被擋", () => {
  const insertEvent = (who: string | null, id: string, from: string, to: string, role: string, payload: object, source = "system") =>
    failure(who, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [id, from, to, role, source, JSON.stringify(payload)]);

  it("供應商不能自己用「系統」身分寫報價 / 成交事件", async () => {
    await activate();
    const id = await dispatched();
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'dispatched','accepted','supplier','supplier_portal','{}'::jsonb)`, [id]);
    expect(await insertEvent(U.supA, id, "accepted", "quoted", "system", { total_amount: 1 })).toContain("只有系統排程可以用「系統」身分");
    expect(await insertEvent(U.supA, id, "accepted", "quoted", "system", { standing_price: true, total_amount: 1690 })).toContain("只有系統排程可以用「系統」身分");
    expect(await insertEvent(U.supA, id, "accepted", "quoted", "supplier", { standing_price: true, total_amount: 1690 }, "supplier_portal")).toContain("只能由系統在「接單並依約定價成交」時寫入");
    expect(await statusOf(id)).toBe("accepted");
  });

  it("就算偽造旗標,金額跟約定價不一致、或沒有生效的協議,一樣寫不進去", async () => {
    const id = await dispatched();
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'dispatched','accepted','supplier','supplier_portal','{}'::jsonb)`, [id]);
    const spoof = async (payload: object) => {
      await db.exec("SET ROLE authenticated");
      await db.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', '', false), set_config('test.role', 'authenticated', false)`, [U.supA]);
      try {
        await db.query("BEGIN");
        await db.query(`SELECT set_config('ifm.standing_auto', $1, true)`, [id]);
        await db.query(`INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'accepted','quoted','system','system',$2::jsonb)`, [id, JSON.stringify(payload)]);
        await db.query("COMMIT");
        return "ok";
      } catch (e) {
        await db.query("ROLLBACK");
        return String((e as Error).message);
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    expect(await spoof({ standing_price: true, total_amount: 1690 })).toContain("沒有生效的約定價");
    await activate();
    expect(await spoof({ standing_price: true, total_amount: 1 })).toContain("必須是依約定價算出來的 1690");
    expect(await statusOf(id)).toBe("accepted");
  });

  it("沒帶 standing_price 的一般事件完全不受影響:一般報價 → 餐廳確認照舊", async () => {
    const id = await dispatched();
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'dispatched','accepted','supplier','supplier_portal','{}'::jsonb)`, [id]);
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'accepted','quoted','supplier','supplier_portal','{"total_amount":1800}'::jsonb)`, [id]);
    expect(await statusOf(id)).toBe("quoted");
    await as(U.owner, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'quoted','confirmed','restaurant','restaurant_portal','{}'::jsonb)`, [id]);
    expect(await statusOf(id)).toBe("confirmed");
    // 一般事件仍然不能冒用系統身分
    const id2 = await dispatched();
    expect(await insertEvent(U.supA, id2, "dispatched", "accepted", "system", {})).toContain("只有系統排程可以用「系統」身分");
  });
});

describe("rollback", () => {
  it("還原後:約定價相關物件消失、狀態機守門函式回到原版,一般流程照常", async () => {
    await db.exec(rollback(MIGRATION_NAME));
    const left = (await db.query<{ n: string }>(
      `SELECT proname AS n FROM pg_proc WHERE proname IN ('standing_accept_order','standing_order_total','standing_active','guard_standing_agreement','guard_standing_auto_event')`)).rows;
    expect(left).toEqual([]);
    expect((await db.query(`SELECT 1 FROM pg_class WHERE relname = 'supplier_standing_agreements'`)).rows).toHaveLength(0);
    const src = (await db.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE proname = 'guard_order_transition'`)).rows[0].s;
    expect(src).not.toContain("standing");
    const id = await dispatched();
    await as(U.supA, `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'dispatched','accepted','supplier','supplier_portal','{}'::jsonb)`, [id]);
    expect(await statusOf(id)).toBe("accepted");
    // 之後重新套用也沒問題
    await db.exec(migration(MIGRATION_NAME));
  });
});
