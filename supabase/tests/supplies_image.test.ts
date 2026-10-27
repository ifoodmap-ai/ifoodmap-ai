// @vitest-environment node
//
// 批發商品圖片 migration(20261028100000_supplies_image.sql)的行為測試:PGlite 真的跑 SQL,
// 驗證 image_path 的 CHECK 只收「自己供應商 / 自己這個商品」資料夾底下的圖片路徑,以及還原檔。
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(join(ROOT, "supabase/migrations/20261028100000_supplies_image.sql"), "utf8");
const ROLLBACK = readFileSync(join(ROOT, "supabase/rollbacks/20261028100000_supplies_image.down.sql"), "utf8");

const SUP_A = "10000000-0000-0000-0000-00000000000a";
const SUP_B = "10000000-0000-0000-0000-00000000000b";
const ITEM_1 = "40000000-0000-0000-0000-000000000001";
const ITEM_2 = "40000000-0000-0000-0000-000000000002";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const SETUP = `
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text, name text);
INSERT INTO supabase_migrations.schema_migrations VALUES ('20261028100000', 'supplies_image');
CREATE TABLE public.supplies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  name text NOT NULL
);
INSERT INTO public.supplies (id, supplier_id, name) VALUES
  ('${ITEM_1}', '${SUP_A}', '高麗菜'),
  ('${ITEM_2}', '${SUP_A}', '雞蛋');
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SETUP);
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db.close();
});

const setPath = (id: string, path: string | null) =>
  db.query(`UPDATE public.supplies SET image_path = $2 WHERE id = $1`, [id, path]);

describe("supplies.image_path", () => {
  it("既有商品沒有圖片(NULL),可以設回 NULL", async () => {
    const r = await db.query<{ image_path: string | null }>(`SELECT image_path FROM public.supplies WHERE id = $1`, [ITEM_1]);
    expect(r.rows[0].image_path).toBeNull();
    await setPath(ITEM_1, null);
  });

  it.each(["jpg", "jpeg", "png", "webp"])("收自己供應商、自己商品資料夾底下的 %s 路徑", async (ext) => {
    await setPath(ITEM_1, `${SUP_A}/${ITEM_1}/${FILE}.${ext}`);
    const r = await db.query<{ image_path: string }>(`SELECT image_path FROM public.supplies WHERE id = $1`, [ITEM_1]);
    expect(r.rows[0].image_path).toBe(`${SUP_A}/${ITEM_1}/${FILE}.${ext}`);
  });

  it.each([
    ["別家供應商的資料夾", `${SUP_B}/${ITEM_1}/${FILE}.jpg`],
    ["別的商品的資料夾", `${SUP_A}/${ITEM_2}/${FILE}.jpg`],
    ["縮圖(_t)不能當正式圖片", `${SUP_A}/${ITEM_1}/${FILE}_t.jpg`],
    ["外部網址", `https://evil.example/pixel.png`],
    ["不是圖片副檔名", `${SUP_A}/${ITEM_1}/${FILE}.svg`],
    ["檔名不是 uuid", `${SUP_A}/${ITEM_1}/photo.jpg`],
    ["路徑穿越", `${SUP_A}/${ITEM_1}/../${ITEM_2}/${FILE}.jpg`],
    ["前後多字元", `x${SUP_A}/${ITEM_1}/${FILE}.jpg`],
    ["空字串", ``],
  ])("擋下:%s", async (_label, path) => {
    await expect(setPath(ITEM_1, path)).rejects.toThrow(/supplies_image_path_check/);
  });

  it("新增商品時一樣檢查(路徑要對應這一筆的 id)", async () => {
    const id = "40000000-0000-0000-0000-000000000009";
    await expect(
      db.query(`INSERT INTO public.supplies (id, supplier_id, name, image_path) VALUES ($1,$2,'x',$3)`, [id, SUP_A, `${SUP_A}/${ITEM_1}/${FILE}.jpg`]),
    ).rejects.toThrow(/supplies_image_path_check/);
    await db.query(`INSERT INTO public.supplies (id, supplier_id, name, image_path) VALUES ($1,$2,'x',$3)`, [id, SUP_A, `${SUP_A}/${id}/${FILE}.jpg`]);
  });

  it("重複套用 migration 不會出錯(idempotent)", async () => {
    await db.exec(MIGRATION);
  });
});

describe("還原檔", () => {
  it("拆掉欄位與 CHECK,並清掉 ledger", async () => {
    const fresh = new PGlite();
    await fresh.exec(SETUP);
    await fresh.exec(MIGRATION);
    await fresh.exec(ROLLBACK);
    const cols = await fresh.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'supplies' AND column_name = 'image_path'`);
    expect(cols.rows).toHaveLength(0);
    expect((await fresh.query(`SELECT * FROM supabase_migrations.schema_migrations`)).rows).toHaveLength(0);
    await fresh.close();
  });
});
