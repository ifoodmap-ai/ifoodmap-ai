// @vitest-environment node
//
// 供應商請款單 migration(20261022100000_supplier_invoices.sql)的行為測試。
//
// 金額、狀態、誰能看 / 誰能改都是資料庫在管,光看 SQL 字串證明不了什麼,所以這支用 PGlite
// (在行程內跑真的 Postgres,不需要另外裝)把 migration 真的套一次,再用不同身分打每一支 RPC 與 RLS。
// 身分:set_config('test.uid') 模擬 auth.uid(),SET ROLE authenticated / anon 讓 RLS 生效;
// RPC 是 SECURITY DEFINER,跟正式環境一樣以資料表擁有者身分跑。
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(join(ROOT, "supabase/migrations/20261022100000_supplier_invoices.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/20261022100000_supplier_invoices.down.sql"), "utf8");

// Supabase 的最小替身:角色、auth.uid() / auth.jwt()、is_admin()、身分 helper(與 portals_foundation 同寫法)與 migration 用到的表
const HARNESS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SET search_path = public
  AS $$ SELECT COALESCE(auth.jwt()->'app_metadata'->>'role', '') = 'admin' $$;

CREATE TABLE public.suppliers   (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.restaurants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE public.supplier_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, supplier_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.restaurant_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, restaurant_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'owner', is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.supplier_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES public.suppliers(id), restaurant_id uuid REFERENCES public.restaurants(id),
  status text NOT NULL, total_amount numeric(12,2), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES public.supplier_orders(id),
  from_status text, to_status text, created_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION public.current_restaurant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT restaurant_id FROM public.restaurant_accounts WHERE user_id = auth.uid() AND is_active $$;
CREATE FUNCTION public.restaurant_role(p_restaurant uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT role FROM public.restaurant_accounts WHERE user_id = auth.uid() AND restaurant_id = p_restaurant AND is_active LIMIT 1 $$;
CREATE FUNCTION public.current_supplier_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT supplier_id FROM public.supplier_accounts WHERE user_id = auth.uid() AND is_active $$;

-- Supabase 預設會把 public 的資料表權限都給 anon / authenticated,這裡照做,才驗得出 migration 有收回寫入權限
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
`;

const U = {
  supA: "00000000-0000-0000-0000-0000000000a1",
  supA2: "00000000-0000-0000-0000-0000000000a2",
  supB: "00000000-0000-0000-0000-0000000000b1",
  owner: "00000000-0000-0000-0000-0000000000c1",
  manager: "00000000-0000-0000-0000-0000000000c2",
  purchaser: "00000000-0000-0000-0000-0000000000c3",
  otherOwner: "00000000-0000-0000-0000-0000000000d1",
  stranger: "00000000-0000-0000-0000-0000000000e1",
  admin: "00000000-0000-0000-0000-0000000000f1",
};
const SUP_A = "10000000-0000-0000-0000-00000000000a";
const SUP_B = "10000000-0000-0000-0000-00000000000b";
const REST_1 = "20000000-0000-0000-0000-000000000001";
const REST_2 = "20000000-0000-0000-0000-000000000002";

let db: PGlite;

/** 以某個身分跑一段 SQL:null = 匿名,"admin" = 平台管理員,其餘為使用者 id */
const as = async <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => {
  await db.exec(`SET ROLE ${who === null ? "anon" : "authenticated"}`);
  await db.query(`SELECT set_config('test.uid', $1, false), set_config('test.jwt', $2, false)`, [
    who === null || who === "admin" ? "" : who,
    who === "admin" ? JSON.stringify({ app_metadata: { role: "admin" } }) : "",
  ]);
  try {
    const r = await db.query<T>(sql, params);
    return r.rows;
  } finally {
    await db.exec("RESET ROLE");
  }
};

/** 預期這一段 SQL 會被資料庫擋下,回傳錯誤訊息 */
const failure = async (who: string | null, sql: string, params: unknown[] = []) => {
  try {
    await as(who, sql, params);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`預期會失敗,但成功了:${sql}`);
};

let orderSeq = 0;
const addOrder = async (o: { status?: string; amount?: number | null; supplier?: string; restaurant?: string; at?: string }) => {
  orderSeq += 1;
  const id = `30000000-0000-0000-0000-${String(orderSeq).padStart(12, "0")}`;
  await db.query(
    `INSERT INTO public.supplier_orders (id, supplier_id, restaurant_id, status, total_amount, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, o.supplier ?? SUP_A, o.restaurant ?? REST_1, o.status ?? "received", o.amount === undefined ? 1000 : o.amount, o.at ?? "2026-10-05T02:00:00Z"],
  );
  return id;
};

const create = (who: string, ids: string[], over: Partial<{ kind: string; start: string; end: string; net: number; supplier: string; restaurant: string; note: string | null }> = {}) =>
  as<{ supplier_create_invoice: string }>(
    who,
    `SELECT public.supplier_create_invoice($1::uuid, $2::uuid, $3, $4::date, $5::date, $6, $7::uuid[], $8)`,
    [over.supplier ?? SUP_A, over.restaurant ?? REST_1, over.kind ?? "custom", over.start ?? "2026-10-01", over.end ?? "2026-10-07", over.net ?? 30, ids, over.note ?? null],
  ).then((r) => r[0].supplier_create_invoice);

// 日期欄位轉成文字:PGlite 會把 date 讀成 JS Date(跟著本機時區),測試要比的是「哪一天」
const invoice = async (id: string) =>
  (await db.query<Record<string, unknown>>(
    `SELECT *, due_date::text AS due_date, period_start::text AS period_start, period_end::text AS period_end
       FROM public.supplier_invoices WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(HARNESS);
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.supplier_invoice_orders, public.supplier_invoices, public.order_events, public.supplier_orders,
             public.supplier_accounts, public.restaurant_accounts, public.suppliers, public.restaurants, auth.users CASCADE;
  `);
  await db.query(`INSERT INTO public.suppliers (id, name) VALUES ($1,'阿明蔬果'),($2,'大海水產')`, [SUP_A, SUP_B]);
  await db.query(`INSERT INTO public.restaurants (id, name) VALUES ($1,'好味小館'),($2,'別家餐廳')`, [REST_1, REST_2]);
  await db.query(`INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES ($1,$3),($2,$3),($4,$5)`, [U.supA, U.supA2, SUP_A, U.supB, SUP_B]);
  await db.query(
    `INSERT INTO public.restaurant_accounts (user_id, restaurant_id, role) VALUES ($1,$5,'owner'),($2,$5,'manager'),($3,$5,'purchaser'),($4,$6,'owner')`,
    [U.owner, U.manager, U.purchaser, U.otherOwner, REST_1, REST_2],
  );
});

describe("開請款單 supplier_create_invoice", () => {
  it("把多張已收貨訂單合併成一張:金額由資料庫加總、到期日 = 迄日 + 付款天數、留下明細快照與單號", async () => {
    const a = await addOrder({ amount: 1000, at: "2026-10-02T02:00:00Z" });
    const b = await addOrder({ amount: 2500.5, status: "reviewed", at: "2026-10-03T02:00:00Z" });
    const c = await addOrder({ amount: 300, status: "completed", at: "2026-10-04T02:00:00Z" });

    const id = await create(U.supA, [a, b, c], { kind: "custom", start: "2026-10-01", end: "2026-10-07", net: 30, note: "  十月上旬  " });
    const inv = await invoice(id);

    expect(inv).toMatchObject({
      supplier_id: SUP_A, restaurant_id: REST_1, period_kind: "custom", status: "issued", issued_by: U.supA, note: "十月上旬",
    });
    expect(Number(inv.total_amount)).toBe(3800.5);
    expect(inv.invoice_no).toMatch(/^INV-\d{8}-\d{4}$/);
    expect(String(inv.due_date)).toBe("2026-11-06");
    const lines = inv.lines as { order_no: string; amount: number }[];
    expect(lines.map((l) => l.order_no)).toEqual([`#${a.slice(-8).toUpperCase()}`, `#${b.slice(-8).toUpperCase()}`, `#${c.slice(-8).toUpperCase()}`]);
    expect((await db.query(`SELECT count(*)::int AS n FROM public.supplier_invoice_orders WHERE invoice_id = $1`, [id])).rows[0]).toEqual({ n: 3 });
  });

  it("日結:迄日就是當天;付款天數 0 = 當天到期", async () => {
    const a = await addOrder({ amount: 500 });
    const id = await create(U.supA, [a], { kind: "daily", start: "2026-10-05", end: "2026-10-05", net: 0 });
    expect(String((await invoice(id)).due_date)).toBe("2026-10-05");
  });

  it("月結:必須是整個月;到期日算到月底再加付款天數", async () => {
    const a = await addOrder({ amount: 500 });
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'monthly','2026-10-02','2026-10-31',30,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("monthly_period_must_be_a_whole_month");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'monthly','2026-10-01','2026-10-30',30,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("monthly_period_must_be_a_whole_month");
    const id = await create(U.supA, [a], { kind: "monthly", start: "2026-10-01", end: "2026-10-31", net: 30 });
    expect(String((await invoice(id)).due_date)).toBe("2026-11-30");
  });

  it("日結區間必須是同一天;區間倒過來、付款天數超出範圍都擋下", async () => {
    const a = await addOrder({});
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'daily','2026-10-05','2026-10-06',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("daily_period_must_be_one_day");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-09','2026-10-01',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("invalid_period");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',366,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("invalid_net_days");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'weekly','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [a]]))
      .toContain("invalid_period_kind");
  });

  it("訂單必須已收貨:還在途的、草稿、取消的都不能請款", async () => {
    for (const status of ["submitted", "quoted", "shipped", "delivered", "discrepancy", "disputed", "cancelled", "draft"]) {
      const o = await addOrder({ status });
      expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [o]]), status)
        .toContain("invoice_orders_not_eligible");
    }
  });

  it("已結案的單:有收貨事件才能請款;爭議直接結案(沒收過貨)不行", async () => {
    const received = await addOrder({ status: "closed" });
    const never = await addOrder({ status: "closed" });
    await db.query(`INSERT INTO public.order_events (order_id, to_status) VALUES ($1,'delivered'),($1,'received'),($1,'closed'),($2,'disputed'),($2,'closed')`, [received, never]);

    expect(await create(U.supA, [received])).toBeTruthy();
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [never]]))
      .toContain("invoice_orders_not_eligible");
  });

  it("沒有金額(0 或還沒報價)的單不能請款", async () => {
    const zero = await addOrder({ amount: 0 });
    const none = await addOrder({ amount: null });
    for (const o of [zero, none]) {
      expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [o]]))
        .toContain("invoice_orders_not_eligible");
    }
  });

  it("訂單必須屬於這家供應商與這家餐廳:不能替別人的單請款", async () => {
    const otherSupplier = await addOrder({ supplier: SUP_B });
    const otherRestaurant = await addOrder({ restaurant: REST_2 });
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [otherSupplier]]))
      .toContain("invoice_orders_not_eligible");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [otherRestaurant]]))
      .toContain("invoice_orders_not_eligible");
  });

  it("不是這家供應商的人(別家供應商、餐廳、陌生人、匿名)不能開", async () => {
    const o = await addOrder({});
    for (const who of [U.supB, U.owner, U.stranger]) {
      expect(await failure(who, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [o]]), who)
        .toContain("not_a_member_of_this_supplier");
    }
    expect(await failure(null, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [o]]))
      .toMatch(/permission denied/);
  });

  it("同一張訂單不能同時在兩張請款單;重複的 id 只算一張;空清單擋下", async () => {
    const o = await addOrder({ amount: 700 });
    const id = await create(U.supA, [o, o, o]);
    expect(Number((await invoice(id)).total_amount)).toBe(700);
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, [o]]))
      .toContain("invoice_orders_already_invoiced");
    expect(await failure(U.supA, `SELECT public.supplier_create_invoice($1::uuid,$2::uuid,'custom','2026-10-01','2026-10-09',0,$3::uuid[],NULL)`, [SUP_A, REST_1, []]))
      .toContain("invoice_needs_1_to_500_orders");
  });

  it("同一家供應商的另一位帳號也能開(以供應商為單位)", async () => {
    const o = await addOrder({});
    expect(await create(U.supA2, [o])).toBeTruthy();
  });
});

describe("讀取權限(RLS)", () => {
  it("供應商看得到自己的;別家供應商、陌生人、匿名看不到", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    expect(await as(U.supA, `SELECT id FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.supA2, `SELECT id FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.supB, `SELECT id FROM public.supplier_invoices`)).toHaveLength(0);
    expect(await as(U.stranger, `SELECT id FROM public.supplier_invoices`)).toHaveLength(0);
    expect(await failure(null, `SELECT id FROM public.supplier_invoices`)).toMatch(/permission denied/);
    expect(await as(U.supB, `SELECT * FROM public.supplier_invoice_orders WHERE invoice_id = $1`, [id])).toHaveLength(0);
    expect(await as(U.supA, `SELECT * FROM public.supplier_invoice_orders WHERE invoice_id = $1`, [id])).toHaveLength(1);
  });

  it("餐廳只有老闆與店長看得到(採購員看不到金額);別家餐廳看不到;admin 看得到", async () => {
    await create(U.supA, [await addOrder({})]);
    expect(await as(U.owner, `SELECT id FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.manager, `SELECT id FROM public.supplier_invoices`)).toHaveLength(1);
    expect(await as(U.purchaser, `SELECT id FROM public.supplier_invoices`)).toHaveLength(0);
    expect(await as(U.otherOwner, `SELECT id FROM public.supplier_invoices`)).toHaveLength(0);
    expect(await as("admin", `SELECT id FROM public.supplier_invoices`)).toHaveLength(1);
  });

  it("任何人都不能直接寫資料表(包含供應商自己改金額、狀態)", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    for (const who of [U.supA, U.owner, "admin"]) {
      expect(await failure(who, `UPDATE public.supplier_invoices SET total_amount = 1 WHERE id = $1`, [id])).toMatch(/permission denied/);
      expect(await failure(who, `UPDATE public.supplier_invoices SET status = 'paid' WHERE id = $1`, [id])).toMatch(/permission denied/);
      expect(await failure(who, `DELETE FROM public.supplier_invoices WHERE id = $1`, [id])).toMatch(/permission denied/);
      expect(await failure(who, `DELETE FROM public.supplier_invoice_orders WHERE invoice_id = $1`, [id])).toMatch(/permission denied/);
    }
    expect(await failure(U.supA, `INSERT INTO public.supplier_invoices (invoice_no, supplier_id, restaurant_id, period_kind, period_start, period_end, due_date, total_amount)
                                   VALUES ('X', '${SUP_A}', '${REST_1}', 'custom', '2026-10-01', '2026-10-02', '2026-10-02', 1)`)).toMatch(/permission denied/);
    expect(Number((await invoice(id)).total_amount)).toBe(1000);
  });
});

describe("餐廳確認 / 提出異議 restaurant_respond_invoice", () => {
  const respond = (who: string, id: string, action: string, note: string | null = null) =>
    as(who, `SELECT public.restaurant_respond_invoice($1::uuid, $2, $3)`, [id, action, note]);

  it("老闆與店長可以確認", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    await respond(U.owner, id, "confirm");
    expect(await invoice(id)).toMatchObject({ status: "confirmed", confirmed_by: U.owner });
    const id2 = await create(U.supA, [await addOrder({})]);
    await respond(U.manager, id2, "confirm");
    expect(await invoice(id2)).toMatchObject({ status: "confirmed", confirmed_by: U.manager });
  });

  it("提出異議必須寫原因;可以從已確認改成異議,異議後可再確認", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    expect(await failure(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid,'dispute','   ')`, [id])).toContain("dispute_note_required");
    await respond(U.owner, id, "dispute", " 少了一箱雞蛋 ");
    expect(await invoice(id)).toMatchObject({ status: "disputed", dispute_note: "少了一箱雞蛋" });
    await respond(U.owner, id, "confirm");
    expect(await invoice(id)).toMatchObject({ status: "confirmed" });
    await respond(U.owner, id, "dispute", "金額不對");
    expect(await invoice(id)).toMatchObject({ status: "disputed", dispute_note: "金額不對" });
  });

  it("採購員、別家餐廳、供應商自己、匿名都不能回應(一律回「找不到」,不洩漏存在)", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    for (const who of [U.purchaser, U.otherOwner, U.supA, U.stranger]) {
      expect(await failure(who, `SELECT public.restaurant_respond_invoice($1::uuid,'confirm',NULL)`, [id]), who).toContain("invoice_not_found");
    }
    expect(await failure(null, `SELECT public.restaurant_respond_invoice($1::uuid,'confirm',NULL)`, [id])).toMatch(/permission denied/);
    expect(await invoice(id)).toMatchObject({ status: "issued" });
  });

  it("已收款或已作廢的請款單不能再回應;不認得的動作擋下", async () => {
    const paid = await create(U.supA, [await addOrder({})]);
    await as(U.supA, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [paid]);
    expect(await failure(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid,'confirm',NULL)`, [paid])).toContain("invoice_not_confirmable");
    expect(await failure(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid,'dispute','x')`, [paid])).toContain("invoice_not_disputable");
    expect(await failure(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid,'refund',NULL)`, [paid])).toContain("invalid_action");
  });
});

describe("標記已收款 supplier_mark_invoice_paid", () => {
  it("待確認、已確認、有異議的都能標已收款,記下時間與誰標的;只能標一次", async () => {
    for (const prep of [null, "confirm", "dispute"]) {
      const id = await create(U.supA, [await addOrder({})]);
      if (prep) await as(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid, $2, '備註')`, [id, prep]);
      await as(U.supA2, `SELECT public.supplier_mark_invoice_paid($1::uuid, '  轉帳  ')`, [id]);
      const inv = await invoice(id);
      expect(inv).toMatchObject({ status: "paid", paid_by: U.supA2, paid_note: "轉帳" });
      expect(inv.paid_at).toBeTruthy();
      expect(await failure(U.supA, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [id])).toContain("invoice_not_payable");
    }
  });

  it("別家供應商、餐廳、匿名不能標", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    for (const who of [U.supB, U.owner, U.stranger]) {
      expect(await failure(who, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [id]), who).toContain("invoice_not_found");
    }
    expect(await failure(null, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [id])).toMatch(/permission denied/);
  });
});

describe("作廢 supplier_void_invoice", () => {
  it("作廢要寫原因,作廢後訂單釋放、可以重新請款;明細快照仍保留", async () => {
    const o = await addOrder({ amount: 900 });
    const id = await create(U.supA, [o]);
    expect(await failure(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '  ')`, [id])).toContain("void_reason_required");

    await as(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '金額寫錯')`, [id]);
    const inv = await invoice(id);
    expect(inv).toMatchObject({ status: "void", void_reason: "金額寫錯" });
    expect((inv.lines as unknown[]).length).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM public.supplier_invoice_orders`)).rows[0]).toEqual({ n: 0 });

    const again = await create(U.supA, [o]);
    expect(Number((await invoice(again)).total_amount)).toBe(900);
  });

  it("已收款不能作廢;作廢過的不能再作廢也不能再收款或回應", async () => {
    const paid = await create(U.supA, [await addOrder({})]);
    await as(U.supA, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [paid]);
    expect(await failure(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '想作廢')`, [paid])).toContain("invoice_not_voidable");

    const voided = await create(U.supA, [await addOrder({})]);
    await as(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '不要了')`, [voided]);
    expect(await failure(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '再一次')`, [voided])).toContain("invoice_not_voidable");
    expect(await failure(U.supA, `SELECT public.supplier_mark_invoice_paid($1::uuid, NULL)`, [voided])).toContain("invoice_not_payable");
    expect(await failure(U.owner, `SELECT public.restaurant_respond_invoice($1::uuid,'confirm',NULL)`, [voided])).toContain("invoice_not_confirmable");
  });

  it("別家供應商、餐廳不能作廢", async () => {
    const id = await create(U.supA, [await addOrder({})]);
    for (const who of [U.supB, U.owner]) {
      expect(await failure(who, `SELECT public.supplier_void_invoice($1::uuid, '搞破壞')`, [id]), who).toContain("invoice_not_found");
    }
  });
});

describe("資料完整性", () => {
  it("放在請款單裡的訂單不能被刪(要先作廢請款單)", async () => {
    const o = await addOrder({});
    const id = await create(U.supA, [o]);
    await expect(db.query(`DELETE FROM public.supplier_orders WHERE id = $1`, [o])).rejects.toThrow(/violates RESTRICT setting of foreign key/);
    await as(U.supA, `SELECT public.supplier_void_invoice($1::uuid, '作廢')`, [id]);
    await db.query(`DELETE FROM public.supplier_orders WHERE id = $1`, [o]);
  });

  it("單號不重複、依序遞增", async () => {
    const a = await create(U.supA, [await addOrder({})]);
    const b = await create(U.supA, [await addOrder({})]);
    const na = String((await invoice(a)).invoice_no);
    const nb = String((await invoice(b)).invoice_no);
    expect(na).not.toBe(nb);
    expect(Number(nb.slice(-4))).toBe(Number(na.slice(-4)) + 1);
  });
});

describe("還原檔", () => {
  it("rollback 乾淨拆掉所有東西", async () => {
    const fresh = new PGlite();
    await fresh.exec(HARNESS);
    await fresh.exec(MIGRATION);
    await fresh.exec("CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text, name text); INSERT INTO supabase_migrations.schema_migrations VALUES ('20261022100000','x');");
    await fresh.exec(ROLLBACK);
    const left = await fresh.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND (p.proname LIKE '%invoice%'))::int AS n`,
    );
    expect(left.rows[0].n).toBe(0);
    const tables = await fresh.query(`SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'supplier_invoice%'`);
    expect(tables.rows).toHaveLength(0);
    expect((await fresh.query(`SELECT * FROM supabase_migrations.schema_migrations`)).rows).toHaveLength(0);
    await fresh.close();
  });
});
