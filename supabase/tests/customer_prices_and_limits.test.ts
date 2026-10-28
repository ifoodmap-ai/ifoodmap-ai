// @vitest-environment node
//
// 客戶專屬價格與數量上限(20261029110000_customer_prices_and_limits.sql)的行為測試:
// PGlite 重放真正的訂單狀態機 migration + 綁定 + 配送日,再套這一支,用不同身分寫真的訂單事件。
// 日期一律排成「今天之後」的確定日子(不依賴測試跑在幾點、幾月幾號)。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REST_1, REST_2, SUP_A, SUP_B, U, buildStateMachineDb, failureOf, migration, rollback, runAs,
} from "./_state-machine-harness";

const BINDING = "20261028110000_restaurant_supplier_binding";
const DELIVERY = "20261029100000_delivery_date_and_cutoff";
const MIGRATION_NAME = "20261029110000_customer_prices_and_limits";
// repo 的 migration 沒有收錄 supplies(最早期的表),只留這支用得到的欄位
const SUPPLIES = `CREATE TABLE public.supplies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE, name text NOT NULL, price numeric);`;

let db: PGlite;
const as = <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => runAs<T>(db, who, sql, params);
const failure = (who: string | null, sql: string, params: unknown[] = []) => failureOf(db, who, sql, params);

const CABBAGE = "50000000-0000-0000-0000-00000000c001";
const EGG = "50000000-0000-0000-0000-00000000c002";
const OTHER_SUPPLY = "50000000-0000-0000-0000-00000000c003"; // 別家供應商的商品

/** 台灣時間的今天 + n 天(YYYY-MM-DD) */
const day = async (n: number) =>
  (await db.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date + $1::int)::text AS d`, [n])).rows[0].d;
/** 今天 + 14 天那個星期的星期一,再加 n 天 —— 一定在未來,而且同一個星期內 */
const weekDay = async (n: number) =>
  (await db.query<{ d: string }>(`SELECT (date_trunc('week', ((now() AT TIME ZONE 'Asia/Taipei')::date + 14)::timestamp)::date + $1::int)::text AS d`, [n])).rows[0].d;

const bind = (restaurant = REST_1, supplier = SUP_A) =>
  db.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [restaurant, supplier]);
const setLimit = (period: "day" | "week", max: number, supply = CABBAGE, restaurant = REST_1, supplier = SUP_A) =>
  db.query(
    `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (restaurant_id, supply_id) DO UPDATE SET period = EXCLUDED.period, max_qty = EXCLUDED.max_qty`,
    [restaurant, supply, supplier, period, max],
  );

type Item = { name: string; quantity: string; unit?: string };
/** 已經存在的訂單(直接寫入,不經事件):算在上限裡的「這段時間已經叫了多少」 */
const existing = (o: { status?: string; date: string | null; items: Item[]; restaurant?: string; supplier?: string; created?: string }) =>
  db.query(
    `INSERT INTO public.supplier_orders (restaurant_id, supplier_id, status, delivery_date, ingredient_list${o.created ? ", created_at" : ""})
     VALUES ($1,$2,$3,$4,$5::jsonb${o.created ? ", $6" : ""})`,
    [o.restaurant ?? REST_1, o.supplier ?? SUP_A, o.status ?? "dispatched", o.date, JSON.stringify(o.items), ...(o.created ? [o.created] : [])],
  );

const draft = async (who: string, date: string | null, items: Item[], restaurant = REST_1) =>
  (await as<{ id: string }>(who, `INSERT INTO public.supplier_orders (restaurant_id, status, delivery_date, ingredient_list) VALUES ($1,'draft',$2,$3::jsonb) RETURNING id`, [restaurant, date, JSON.stringify(items)]))[0].id;
const dispatchSql = `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','restaurant','restaurant_portal',$2::jsonb)`;
const dispatch = (who: string, id: string, supplier = SUP_A) => as(who, dispatchSql, [id, JSON.stringify({ supplier_id: supplier })]);
const dispatchFails = (who: string, id: string, supplier = SUP_A) => failure(who, dispatchSql, [id, JSON.stringify({ supplier_id: supplier })]);
const statusOf = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM public.supplier_orders WHERE id = $1`, [id])).rows[0].status;

beforeAll(async () => {
  db = await buildStateMachineDb([BINDING, DELIVERY], SUPPLIES);
  await db.exec(migration(MIGRATION_NAME));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.restaurant_suppliers, public.supplier_order_settings, public.supplier_customer_prices, public.supplier_customer_limits,
                          public.supplier_group_prices, public.supplier_customer_group_members, public.supplier_customer_groups,
                          public.supplies, public.order_quotes, public.supplier_shipments, public.order_events RESTART IDENTITY CASCADE;
                 DELETE FROM public.supplier_orders;`);
  await db.query(`INSERT INTO public.supplies (id, supplier_id, name, price) VALUES ($1,$4,'高麗菜',45),($2,$4,'雞蛋',620),($3,$5,'別家的商品',10)`, [CABBAGE, EGG, OTHER_SUPPLY, SUP_A, SUP_B]);
  await bind();
});

describe("品名比對 helper", () => {
  it("norm_item_name 去掉各種空白並轉小寫;order_item_qty 只加總純數字的數量", async () => {
    const r = (await db.query<{ a: string; q: string }>(
      `SELECT public.norm_item_name(E' 高麗\\u3000 菜\t') AS a,
              public.order_item_qty('[{"name":"高麗菜","quantity":"5"},{"name":" 高麗 菜","quantity":"2.5"},{"name":"高麗菜","quantity":"3箱"},{"name":"雞蛋","quantity":"9"},"壞資料"]'::jsonb, '高麗菜')::text AS q`)).rows[0];
    expect(r).toEqual({ a: "高麗菜", q: "7.5" });
    expect((await db.query<{ q: string }>(`SELECT public.order_item_qty('{"不是":"陣列"}'::jsonb, 'x')::text AS q`)).rows[0].q).toBe("0");
    expect((await db.query<{ f: string[] }>(`SELECT ARRAY[public.fmt_qty(100.00), public.fmt_qty(3.50), public.fmt_qty(0.25), public.fmt_qty(10)] AS f`)).rows[0].f).toEqual(["100", "3.5", "0.25", "10"]);
  });
});

describe("客戶專屬價格 supplier_customer_prices", () => {
  const upsertPrice = (who: string, price: number, supply = CABBAGE, restaurant = REST_1, supplier = SUP_A) =>
    as(who, `INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,$4)
             ON CONFLICT (restaurant_id, supply_id) DO UPDATE SET price = EXCLUDED.price`, [restaurant, supply, supplier, price]);

  it("供應商可以新增、修改、刪除自己商品的客戶價格", async () => {
    await upsertPrice(U.supA, 42);
    await upsertPrice(U.supA, 40);
    expect((await db.query<{ price: string }>(`SELECT price::text FROM public.supplier_customer_prices`)).rows).toEqual([{ price: "40.00" }]);
    expect(await as(U.supA, `DELETE FROM public.supplier_customer_prices WHERE restaurant_id = $1 RETURNING 1`, [REST_1])).toHaveLength(1);
  });

  it("不能替別家供應商的商品設價;別家供應商也不能動我的價格", async () => {
    expect(await failure(U.supA, `INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,5)`, [REST_1, OTHER_SUPPLY, SUP_A])).toContain("這個商品不是這家供應商的");
    expect(await failure(U.supB, `INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,5)`, [REST_1, CABBAGE, SUP_A])).toMatch(/row-level security/);
    await upsertPrice(U.supA, 42);
    expect(await as(U.supB, `UPDATE public.supplier_customer_prices SET price = 1 RETURNING 1`)).toHaveLength(0);
    expect(await as(U.supB, `DELETE FROM public.supplier_customer_prices RETURNING 1`)).toHaveLength(0);
  });

  it("價格要大於 0", async () => {
    await expect(db.query(`INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,0)`, [REST_1, CABBAGE, SUP_A])).rejects.toThrow(/violates check constraint/);
  });

  it("誰讀得到:供應商自己、這家餐廳的老闆與店長、管理員;採購員、別家餐廳、別家供應商、匿名讀不到;餐廳不能寫", async () => {
    await upsertPrice(U.supA, 42);
    for (const who of [U.supA, U.owner, U.manager, "admin"]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_prices`), who).toHaveLength(1);
    for (const who of [U.purchaser, U.otherOwner, U.supB, U.stranger]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_prices`), who).toHaveLength(0);
    expect(await failure(null, `SELECT 1 FROM public.supplier_customer_prices`)).toMatch(/permission denied/);
    expect(await failure(U.owner, `INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,1)`, [REST_1, EGG, SUP_A])).toMatch(/row-level security/);
    expect(await as(U.owner, `UPDATE public.supplier_customer_prices SET price = 1 RETURNING 1`)).toHaveLength(0);
  });

  it("商品刪掉,價格跟著刪", async () => {
    await upsertPrice(U.supA, 42);
    await db.query(`DELETE FROM public.supplies WHERE id = $1`, [CABBAGE]);
    expect((await db.query(`SELECT 1 FROM public.supplier_customer_prices`)).rows).toHaveLength(0);
  });
});

describe("客戶群組報價:群組、成員、群組價格", () => {
  const GROUP = "60000000-0000-0000-0000-00000000a001";
  const GROUP_B = "60000000-0000-0000-0000-00000000b001";

  const addGroup = (who: string, name: string, supplier = SUP_A, id?: string) =>
    as<{ id: string }>(who, `INSERT INTO public.supplier_customer_groups (id, supplier_id, name) VALUES (COALESCE($3::uuid, gen_random_uuid()), $1, $2) RETURNING id`, [supplier, name, id ?? null]);
  const addMember = (who: string, group: string, restaurant = REST_1, supplier = SUP_A) =>
    as(who, `INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)
             ON CONFLICT (supplier_id, restaurant_id) DO UPDATE SET group_id = EXCLUDED.group_id`, [supplier, restaurant, group]);
  const setGroupPrice = (who: string, group: string, supply: string, price: number, supplier = SUP_A) =>
    as(who, `INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,$4)
             ON CONFLICT (group_id, supply_id) DO UPDATE SET price = EXCLUDED.price`, [group, supply, supplier, price]);

  it("供應商建立、改名、刪除自己的群組;同一家供應商群組名不能重複;名字長度有限制", async () => {
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await as(U.supA, `UPDATE public.supplier_customer_groups SET name = '大型連鎖' WHERE id = $1`, [GROUP]);
    expect((await db.query<{ name: string }>(`SELECT name FROM public.supplier_customer_groups`)).rows).toEqual([{ name: "大型連鎖" }]);
    expect(await failure(U.supA, `INSERT INTO public.supplier_customer_groups (supplier_id, name) VALUES ($1,'大型連鎖')`, [SUP_A])).toMatch(/duplicate key/);
    await addGroup(U.supB, "大型連鎖", SUP_B); // 別家供應商同名沒關係
    await expect(db.query(`INSERT INTO public.supplier_customer_groups (supplier_id, name) VALUES ($1,'   ')`, [SUP_A])).rejects.toThrow(/violates check constraint/);
    await expect(db.query(`INSERT INTO public.supplier_customer_groups (supplier_id, name) VALUES ($1,$2)`, [SUP_A, "x".repeat(41)])).rejects.toThrow(/violates check constraint/);
    expect(await as(U.supA, `DELETE FROM public.supplier_customer_groups WHERE id = $1 RETURNING 1`, [GROUP])).toHaveLength(1);
  });

  it("別家供應商、餐廳(含老闆)、匿名都碰不到我的群組;管理員讀得到", async () => {
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    for (const who of [U.supB, U.owner, U.manager, U.purchaser, U.stranger]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_groups`), who).toHaveLength(0);
    expect(await as("admin", `SELECT 1 FROM public.supplier_customer_groups`)).toHaveLength(1);
    expect(await failure(null, `SELECT 1 FROM public.supplier_customer_groups`)).toMatch(/permission denied/);
    expect(await failure(U.supB, `INSERT INTO public.supplier_customer_groups (supplier_id, name) VALUES ($1,'偷建')`, [SUP_A])).toMatch(/row-level security/);
    expect(await failure(U.owner, `INSERT INTO public.supplier_customer_groups (supplier_id, name) VALUES ($1,'偷建')`, [SUP_A])).toMatch(/row-level security/);
    expect(await as(U.supB, `UPDATE public.supplier_customer_groups SET name = '改掉' RETURNING 1`)).toHaveLength(0);
    expect(await as(U.supB, `DELETE FROM public.supplier_customer_groups RETURNING 1`)).toHaveLength(0);
  });

  it("成員:只能加已經綁定你的客戶;一家客戶最多一個群組(改放別的群組 = 搬過去);不能放進別家供應商的群組", async () => {
    const second = "60000000-0000-0000-0000-00000000a002";
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await addGroup(U.supA, "小吃攤", SUP_A, second);
    await addGroup(U.supB, "別家的群組", SUP_B, GROUP_B);

    await addMember(U.supA, GROUP, REST_1);
    expect(await failure(U.supA, `INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)`, [SUP_A, REST_2, GROUP])).toContain("還沒有綁定你");
    await addMember(U.supA, second, REST_1); // 搬到另一個群組
    expect((await db.query<{ group_id: string }>(`SELECT group_id FROM public.supplier_customer_group_members`)).rows).toEqual([{ group_id: second }]);
    expect(await failure(U.supA, `INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)`, [SUP_A, REST_1, GROUP])).toMatch(/duplicate key/);
    await bind(REST_2, SUP_A);
    await expect(db.query(`INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)`, [SUP_A, REST_2, GROUP_B])).rejects.toThrow(/foreign key/);
    expect(await failure(U.supB, `INSERT INTO public.supplier_customer_group_members (supplier_id, restaurant_id, group_id) VALUES ($1,$2,$3)`, [SUP_A, REST_1, GROUP])).toMatch(/row-level security/);
  });

  it("成員列誰看得到:供應商自己、這家餐廳所有成員(含採購員);別家餐廳、別家供應商看不到", async () => {
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await addMember(U.supA, GROUP, REST_1);
    for (const who of [U.supA, U.owner, U.manager, U.purchaser, "admin"]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_group_members`), who).toHaveLength(1);
    for (const who of [U.otherOwner, U.supB, U.stranger]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_group_members`), who).toHaveLength(0);
    expect(await as(U.owner, `DELETE FROM public.supplier_customer_group_members RETURNING 1`)).toHaveLength(0);
  });

  it("群組價:供應商設自己商品的價格;不能替別家的商品設價;價格要大於 0;可以修改", async () => {
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await setGroupPrice(U.supA, GROUP, CABBAGE, 38);
    await setGroupPrice(U.supA, GROUP, CABBAGE, 36);
    expect((await db.query<{ price: string }>(`SELECT price::text FROM public.supplier_group_prices`)).rows).toEqual([{ price: "36.00" }]);
    expect(await failure(U.supA, `INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,5)`, [GROUP, OTHER_SUPPLY, SUP_A])).toContain("這個商品不是這家供應商的");
    await expect(db.query(`INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,0)`, [GROUP, EGG, SUP_A])).rejects.toThrow(/violates check constraint/);
    expect(await failure(U.supB, `INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,5)`, [GROUP, EGG, SUP_A])).toMatch(/row-level security/);
    expect(await as(U.supB, `DELETE FROM public.supplier_group_prices RETURNING 1`)).toHaveLength(0);
  });

  it("群組價誰讀得到:自己店在這個群組、還綁定著、而且是老闆 / 店長;採購員、別的群組的店、沒群組的店、解除綁定後都讀不到", async () => {
    const other = "60000000-0000-0000-0000-00000000a002";
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await addGroup(U.supA, "小吃攤", SUP_A, other);
    await setGroupPrice(U.supA, GROUP, CABBAGE, 38);
    await setGroupPrice(U.supA, other, CABBAGE, 30);
    await addMember(U.supA, GROUP, REST_1);
    await bind(REST_2, SUP_A);
    await addMember(U.supA, other, REST_2);

    for (const who of [U.owner, U.manager]) expect(await as<{ price: string }>(who, `SELECT price::text FROM public.supplier_group_prices`), who).toEqual([{ price: "38.00" }]);
    expect(await as<{ price: string }>(U.otherOwner, `SELECT price::text FROM public.supplier_group_prices`)).toEqual([{ price: "30.00" }]);
    expect(await as(U.purchaser, `SELECT 1 FROM public.supplier_group_prices`)).toHaveLength(0);
    expect(await as(U.supA, `SELECT 1 FROM public.supplier_group_prices`)).toHaveLength(2);
    expect(await as(U.supB, `SELECT 1 FROM public.supplier_group_prices`)).toHaveLength(0);
    expect(await failure(null, `SELECT 1 FROM public.supplier_group_prices`)).toMatch(/permission denied/);
    expect(await failure(U.owner, `INSERT INTO public.supplier_group_prices (group_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,1)`, [GROUP, EGG, SUP_A])).toMatch(/row-level security/);

    // 解除綁定:群組價與專屬價都讀不到了
    await db.query(`INSERT INTO public.supplier_customer_prices (restaurant_id, supply_id, supplier_id, price) VALUES ($1,$2,$3,40)`, [REST_1, CABBAGE, SUP_A]);
    expect(await as(U.owner, `SELECT 1 FROM public.supplier_customer_prices`)).toHaveLength(1);
    await db.query(`DELETE FROM public.restaurant_suppliers WHERE restaurant_id = $1 AND supplier_id = $2`, [REST_1, SUP_A]);
    expect(await as(U.owner, `SELECT 1 FROM public.supplier_group_prices`)).toHaveLength(0);
    expect(await as(U.owner, `SELECT 1 FROM public.supplier_customer_prices`)).toHaveLength(0);
  });

  it("刪掉群組,成員與群組價跟著刪(客戶沒有被刪);刪掉商品,群組價跟著刪", async () => {
    await addGroup(U.supA, "連鎖店", SUP_A, GROUP);
    await addMember(U.supA, GROUP, REST_1);
    await setGroupPrice(U.supA, GROUP, CABBAGE, 38);
    await setGroupPrice(U.supA, GROUP, EGG, 600);
    await db.query(`DELETE FROM public.supplies WHERE id = $1`, [EGG]);
    expect((await db.query(`SELECT 1 FROM public.supplier_group_prices`)).rows).toHaveLength(1);
    await as(U.supA, `DELETE FROM public.supplier_customer_groups WHERE id = $1`, [GROUP]);
    expect((await db.query(`SELECT 1 FROM public.supplier_customer_group_members`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM public.supplier_group_prices`)).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM public.restaurants WHERE id = $1`, [REST_1])).rows).toHaveLength(1);
  });
});

describe("客戶數量上限 supplier_customer_limits 的權限與限制", () => {
  it("供應商管理自己的;這家餐廳所有成員(含採購員)讀得到;別人讀不到", async () => {
    await as(U.supA, `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,'day',10)`, [REST_1, CABBAGE, SUP_A]);
    for (const who of [U.supA, U.owner, U.manager, U.purchaser, "admin"]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_limits`), who).toHaveLength(1);
    for (const who of [U.otherOwner, U.supB, U.stranger]) expect(await as(who, `SELECT 1 FROM public.supplier_customer_limits`), who).toHaveLength(0);
    expect(await as(U.purchaser, `UPDATE public.supplier_customer_limits SET max_qty = 999 RETURNING 1`)).toHaveLength(0);
    expect(await failure(U.supB, `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,'day',1)`, [REST_1, CABBAGE, SUP_A])).toMatch(/row-level security/);
    expect(await failure(U.supA, `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,'day',1)`, [REST_1, OTHER_SUPPLY, SUP_A])).toContain("這個商品不是這家供應商的");
  });

  it.each([
    ["期別不是 day / week", `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,'month',5)`],
    ["上限是 0", `INSERT INTO public.supplier_customer_limits (restaurant_id, supply_id, supplier_id, period, max_qty) VALUES ($1,$2,$3,'day',0)`],
  ])("不合理的設定被擋:%s", async (_label, sql) => {
    await expect(db.query(sql, [REST_1, CABBAGE, SUP_A])).rejects.toThrow(/violates check constraint/);
  });
});

describe("叫貨時檢查數量上限", () => {
  const cabbage = (q: string, name = "高麗菜"): Item[] => [{ name, quantity: q, unit: "kg" }];

  it("每日上限:同一天累計超過就擋,訊息說明上限、已叫、這張、還能叫多少;剛好到上限可以", async () => {
    await setLimit("day", 10);
    const d = await day(3);
    await existing({ date: d, items: cabbage("6") });

    const over = await draft(U.owner, d, cabbage("5"));
    const msg = await dispatchFails(U.owner, over);
    expect(msg).toContain("「高麗菜」每日上限 10,這段時間已經叫了 6,這張單 5,最多還能叫 4");
    expect(await statusOf(over)).toBe("draft");

    const exact = await draft(U.owner, d, cabbage("4"));
    await dispatch(U.owner, exact);
    expect(await statusOf(exact)).toBe("dispatched");

    // 已經滿了:再多叫 0.5 也不行
    const more = await draft(U.manager, d, cabbage("0.5"));
    expect(await dispatchFails(U.manager, more)).toContain("最多還能叫 0");
  });

  it("每日上限只算同一天;換一天重新計", async () => {
    await setLimit("day", 10);
    await existing({ date: await day(3), items: cabbage("10") });
    const other = await draft(U.owner, await day(4), cabbage("10"));
    await dispatch(U.owner, other);
    expect(await statusOf(other)).toBe("dispatched");
  });

  it("每週上限:同一個星期(週一到週日)累計;下一週重新計", async () => {
    await setLimit("week", 20);
    await existing({ date: await weekDay(0), items: cabbage("12") });
    await existing({ date: await weekDay(6), items: cabbage("5") });

    const over = await draft(U.purchaser, await weekDay(3), cabbage("4"));
    expect(await dispatchFails(U.purchaser, over)).toContain("「高麗菜」每週上限 20,這段時間已經叫了 17,這張單 4,最多還能叫 3");

    const ok = await draft(U.purchaser, await weekDay(3), cabbage("3"));
    await dispatch(U.purchaser, ok);
    expect(await statusOf(ok)).toBe("dispatched");

    const nextWeek = await draft(U.owner, await weekDay(7), cabbage("20"));
    await dispatch(U.owner, nextWeek);
    expect(await statusOf(nextWeek)).toBe("dispatched");
  });

  it("品名比對不分大小寫與空白;同一張單裡同一商品多列也加總", async () => {
    await setLimit("day", 10);
    const d = await day(3);
    await existing({ date: d, items: cabbage("4", " 高麗 菜") });
    const id = await draft(U.owner, d, [{ name: "高麗菜", quantity: "4" }, { name: "高麗　菜", quantity: "3" }]);
    expect(await dispatchFails(U.owner, id)).toContain("這張單 7");
  });

  it("不算進去的:草稿、取消、拒單、逾時的單,別家餐廳、別家供應商的單", async () => {
    await setLimit("day", 10);
    const d = await day(3);
    for (const status of ["draft", "cancelled", "rejected", "expired"]) await existing({ date: d, status, items: cabbage("9") });
    await existing({ date: d, restaurant: REST_2, items: cabbage("9") });
    await existing({ date: d, supplier: SUP_B, items: cabbage("9") });
    const id = await draft(U.owner, d, cabbage("10"));
    await dispatch(U.owner, id);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("有算進去的:各種進行中與已完成的狀態", async () => {
    await setLimit("day", 10);
    const d = await day(3);
    await existing({ date: d, status: "received", items: cabbage("5") });
    await existing({ date: d, status: "confirmed", items: cabbage("3") });
    const id = await draft(U.owner, d, cabbage("3"));
    expect(await dispatchFails(U.owner, id)).toContain("最多還能叫 2");
  });

  it("沒有設上限的商品、品名對不上目錄的品項、數量不是純數字的品項都不受限", async () => {
    await setLimit("day", 1);
    const d = await day(3);
    const id = await draft(U.owner, d, [
      { name: "雞蛋", quantity: "500", unit: "箱" },
      { name: "高麗菜心", quantity: "999" },
      { name: "高麗菜", quantity: "好多" },
    ]);
    await dispatch(U.owner, id);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("沒有配送日的單用今天算期別", async () => {
    await setLimit("day", 10);
    await existing({ date: null, items: cabbage("8") });
    const id = await draft(U.owner, null, cabbage("5"));
    expect(await dispatchFails(U.owner, id)).toContain("最多還能叫 2");
  });

  it("只管設了上限的那家客戶:別家餐廳不受影響", async () => {
    await setLimit("day", 1);
    await bind(REST_2, SUP_A);
    const id = await draft(U.otherOwner, await day(3), cabbage("50"), REST_2);
    await dispatch(U.otherOwner, id);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("管理員派單、系統身分不受數量上限限制", async () => {
    await setLimit("day", 1);
    const id = await draft(U.owner, await day(3), cabbage("50"));
    await as("admin", `INSERT INTO public.order_events (order_id, from_status, to_status, actor_role, source, payload) VALUES ($1,'draft','dispatched','admin','admin_portal',$2::jsonb)`, [id, JSON.stringify({ supplier_id: SUP_A })]);
    expect(await statusOf(id)).toBe("dispatched");
  });

  it("配送日 / 截單 / 綁定的檢查還在(這支沒有蓋掉前面的版本)", async () => {
    await db.query(`INSERT INTO public.supplier_order_settings (supplier_id, cutoff_time, lead_days, delivery_weekdays) VALUES ($1,'00:00',1,'{0,1,2,3,4,5,6}')`, [SUP_A]);
    const cutoff = await draft(U.owner, await day(1), cabbage("1"));
    expect(await dispatchFails(U.owner, cutoff)).toContain("超過這個配送日的截單時間");
    const missing = await draft(U.owner, null, cabbage("1"));
    expect(await dispatchFails(U.owner, missing)).toContain("請先選擇配送日期");
    await db.exec(`DELETE FROM public.restaurant_suppliers`);
    const unbound = await draft(U.owner, await day(5), cabbage("1"));
    expect(await dispatchFails(U.owner, unbound)).toContain("只能向已綁定的合作供應商叫貨");
  });
});

describe("還原檔", () => {
  it("退回配送日 / 截單版本:上限不再生效,兩張表與函式消失", async () => {
    const fresh = await buildStateMachineDb([BINDING, DELIVERY], SUPPLIES);
    await fresh.exec(migration(MIGRATION_NAME));
    await fresh.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text, name text); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261029110000','x');");
    await fresh.exec(rollback(MIGRATION_NAME));

    for (const t of ["supplier_customer_prices", "supplier_customer_limits", "supplier_customer_groups", "supplier_customer_group_members", "supplier_group_prices"]) {
      expect((await fresh.query(`SELECT to_regclass('public.${t}') AS t`)).rows[0]).toEqual({ t: null });
    }
    expect((await fresh.query(`SELECT 1 FROM pg_proc WHERE proname IN ('norm_item_name','order_item_qty','fmt_qty','guard_customer_rule_supply','guard_group_member_bound')`)).rows).toHaveLength(0);
    expect((await fresh.query(`SELECT * FROM supabase_migrations.schema_migrations`)).rows).toHaveLength(0);

    // 配送日的檢查還在:過去的日子仍被擋
    await fresh.query(`INSERT INTO public.restaurant_suppliers (restaurant_id, supplier_id) VALUES ($1,$2)`, [REST_1, SUP_A]);
    const id = (await runAs<{ id: string }>(fresh, U.owner, `INSERT INTO public.supplier_orders (restaurant_id, status, delivery_date) VALUES ($1,'draft', ((now() AT TIME ZONE 'Asia/Taipei')::date - 1)) RETURNING id`, [REST_1]))[0].id;
    await expect(runAs(fresh, U.owner, dispatchSql, [id, JSON.stringify({ supplier_id: SUP_A })])).rejects.toThrow(/配送日不能早於今天/);
    await fresh.close();
  }, 120_000);
});
