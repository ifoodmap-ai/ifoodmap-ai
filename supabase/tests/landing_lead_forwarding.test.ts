// @vitest-environment node
//
// 官網 AI 助手留言自動轉供應商(20261118100000_landing_lead_forwarding.sql)的行為測試:
// PGlite 重放真正的 portals_foundation(supplier_leads)+ 本次 migration,landing_leads / supplies / analysis_records 用替身表。
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SUP_A, SUP_B, U, buildStateMachineDb, failureOf, migration, rollback, runAs } from "./_state-machine-harness";

const MIGRATION_NAME = "20261118100000_landing_lead_forwarding";
const SUP_C = "10000000-0000-0000-0000-00000000000c"; // 停用的供應商
const AN1 = "50000000-0000-0000-0000-000000000001";

let db: PGlite;
const as = <T = Record<string, unknown>>(who: string | null, sql: string, params: unknown[] = []) => runAs<T>(db, who, sql, params);

const SETUP = `
ALTER TABLE public.suppliers ADD COLUMN service_areas text[] NOT NULL DEFAULT '{}';
CREATE TABLE public.supplies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  name text NOT NULL, is_available boolean NOT NULL DEFAULT true);
CREATE TABLE public.analysis_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ingredient_list jsonb NOT NULL DEFAULT '[]'::jsonb);
CREATE TABLE public.landing_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_name text, contact_phone text, contact_line text, contact_email text,
  items_text text, detail text, source text NOT NULL DEFAULT 'ai_widget', status text NOT NULL DEFAULT 'new',
  analysis_id uuid, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert" ON public.landing_leads FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "admin read" ON public.landing_leads FOR SELECT TO authenticated USING (public.is_admin());
`;

const lead = async (extra: Record<string, unknown> = {}) => {
  const row = {
    company_name: "阿輝鍋燒麵", contact_name: "阿輝", contact_phone: "0912345678", delivery_area: "台北市中正區",
    analysis_id: AN1, consent_share: true, items_text: "高麗菜10kg、雞蛋20箱", ...extra,
  };
  const cols = Object.keys(row);
  await as(null, `INSERT INTO public.landing_leads (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
  return (await db.query<{ id: string }>(`SELECT id FROM public.landing_leads ORDER BY created_at DESC, id LIMIT 1`)).rows[0].id;
};
const leadsOf = async (who: string | null) =>
  as<{ supplier_id: string; matched_items: string[]; score: number; status: string; contact: Record<string, string> }>(
    who, `SELECT supplier_id, matched_items, score, status, contact FROM public.supplier_leads ORDER BY supplier_id`);
const status = async (id: string) =>
  (await db.query<{ forward_status: string; forwarded_count: number }>(`SELECT forward_status, forwarded_count FROM public.landing_leads WHERE id=$1`, [id])).rows[0];

beforeAll(async () => {
  db = await buildStateMachineDb([], SETUP);
  // 替身表要先補上本次 migration 才加的欄位以外的基本欄位;grant 讓 anon / authenticated 能寫(正式庫是 PostgREST 的預設權限)
  await db.exec(`GRANT INSERT ON public.landing_leads TO anon, authenticated; GRANT ALL ON public.supplies, public.analysis_records TO authenticated;`);
  await db.exec(migration(MIGRATION_NAME));
}, 120_000);
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec(`DELETE FROM public.supplier_leads; DELETE FROM public.landing_leads; DELETE FROM public.supplies; DELETE FROM public.analysis_records;
                 DELETE FROM public.suppliers WHERE id <> '${SUP_A}' AND id <> '${SUP_B}'`);
  await db.query(`UPDATE public.suppliers SET service_areas = $2, is_active = true WHERE id = $1`, [SUP_A, ["台北市", "新北市"]]);
  await db.query(`UPDATE public.suppliers SET service_areas = $2, is_active = true WHERE id = $1`, [SUP_B, ["高雄市"]]);
  await db.query(`INSERT INTO public.suppliers (id, name, is_active, service_areas) VALUES ($1,'停用供應商',false,'{}')`, [SUP_C]);
  await db.query(`INSERT INTO public.analysis_records (id, ingredient_list) VALUES ($1, $2)`,
    [AN1, JSON.stringify([{ name: "高麗菜", quantity: 10, unit: "kg" }, { name: "雞蛋" }, "小白菜"])]);
  await db.query(`INSERT INTO public.supplies (supplier_id, name) VALUES ($1,'有機高麗菜'),($1,'小白菜'),($2,'雞蛋'),($2,'高麗菜'),($3,'高麗菜'),($1,'下架品')`, [SUP_A, SUP_B, SUP_C]);
  await db.query(`UPDATE public.supplies SET is_available = false WHERE name = '下架品'`);
});

describe("留言 → 自動轉給符合的供應商", () => {
  it("品項與服務區域都符合的供應商拿到商機,附聯絡資料;不在服務區域的、停用的不會有", async () => {
    const id = await lead();
    const rows = await leadsOf("admin");
    expect(rows.map((r) => r.supplier_id)).toEqual([SUP_A]); // B 服務高雄、C 已停用
    expect([...rows[0].matched_items].sort()).toEqual(["小白菜", "高麗菜"]);
    expect(rows[0].score).toBe(67); // 3 項裡符合 2 項
    expect(rows[0].status).toBe("new");
    expect(rows[0].contact).toMatchObject({ company: "阿輝鍋燒麵", name: "阿輝", phone: "0912345678", area: "台北市中正區" });
    expect(await status(id)).toEqual({ forward_status: "forwarded", forwarded_count: 1 });
  });

  it("沒填配送地點:所有品項符合的供應商都收到", async () => {
    await lead({ delivery_area: null });
    expect((await leadsOf("admin")).map((r) => r.supplier_id)).toEqual([SUP_A, SUP_B]);
  });

  it("「臺」「台」視為同一個字", async () => {
    await lead({ delivery_area: "臺北市大安區" });
    expect((await leadsOf("admin")).map((r) => r.supplier_id)).toEqual([SUP_A]);
  });

  it("沒有符合的供應商:標成 no_match(留給管理員人工處理),lead 照樣寫入", async () => {
    await db.query(`UPDATE public.analysis_records SET ingredient_list = '[{"name":"龍蝦"}]'::jsonb WHERE id = $1`, [AN1]);
    const id = await lead();
    expect(await leadsOf("admin")).toHaveLength(0);
    expect(await status(id)).toEqual({ forward_status: "no_match", forwarded_count: 0 });
  });

  it("沒勾同意:不轉出去,狀態維持 pending", async () => {
    const id = await lead({ consent_share: false });
    expect(await leadsOf("admin")).toHaveLength(0);
    expect(await status(id)).toEqual({ forward_status: "pending", forwarded_count: 0 });
  });

  it("找不到對應的分析:no_match,不會出錯", async () => {
    const id = await lead({ analysis_id: null });
    expect(await status(id)).toEqual({ forward_status: "no_match", forwarded_count: 0 });
  });

  it("anon 自己填的處理狀態被蓋回初始值,仍然照規則轉送", async () => {
    const id = await lead({ forward_status: "no_match", forwarded_count: 99 });
    expect(await status(id)).toEqual({ forward_status: "forwarded", forwarded_count: 1 });
    expect(await leadsOf("admin")).toHaveLength(1);
  });

  it("最多轉給 10 家,品項符合最多的優先", async () => {
    for (let i = 0; i < 12; i++) {
      const sid = `10000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`;
      await db.query(`INSERT INTO public.suppliers (id, name, service_areas) VALUES ($1,'補位${i}','{}')`, [sid]);
      await db.query(`INSERT INTO public.supplies (supplier_id, name) VALUES ($1,'高麗菜')`, [sid]);
    }
    await lead({ delivery_area: null });
    const rows = await leadsOf("admin");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.supplier_id)).toContain(SUP_A); // 符合 2 項,排最前面
  });
});

describe("誰看得到、誰改得動", () => {
  it("供應商只看得到轉給自己的商機與聯絡資料", async () => {
    await lead({ delivery_area: null });
    expect((await leadsOf(U.supA)).map((r) => r.supplier_id)).toEqual([SUP_A]);
    expect((await leadsOf(U.supB)).map((r) => r.supplier_id)).toEqual([SUP_B]);
    expect(await leadsOf(U.stranger)).toHaveLength(0);
  });

  it("供應商可以更新商機狀態,但改不了聯絡資料與來源", async () => {
    await lead();
    await as(U.supA, `UPDATE public.supplier_leads SET status = 'contacted'`);
    expect((await leadsOf(U.supA))[0].status).toBe("contacted");
    expect(await failureOf(db, U.supA, `UPDATE public.supplier_leads SET contact = '{"phone":"x"}'::jsonb`)).toMatch(/SUPPLIER_LEAD_CONTACT_READONLY/);
    expect(await failureOf(db, U.supA, `UPDATE public.supplier_leads SET landing_lead_id = NULL`)).toMatch(/SUPPLIER_LEAD_CONTACT_READONLY/);
  });

  it("匿名訪客讀不到任何 lead 或商機,也不能自己呼叫轉送函式", async () => {
    const id = await lead({ consent_share: false });
    expect(await as(null, `SELECT * FROM public.landing_leads`)).toHaveLength(0); // RLS:匿名沒有 SELECT policy
    expect(await as(null, `SELECT * FROM public.supplier_leads`)).toHaveLength(0);
    expect(await failureOf(db, null, `SELECT public.forward_landing_lead($1)`, [id])).toMatch(/permission denied/i);
  });
});

describe("還原", () => {
  it("還原後新 lead 不再轉送,已轉出的商機與欄位保留;可以再套回去", async () => {
    await lead();
    await db.exec(rollback(MIGRATION_NAME));
    await lead({ company_name: "第二家" });
    expect(await leadsOf("admin")).toHaveLength(1);
    await db.exec(migration(MIGRATION_NAME));
  });
});
