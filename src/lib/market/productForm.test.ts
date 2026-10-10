// productForm.ts:B2B 商品帶入、驗證上限、payload、新增 / 修改 / 送審送出的內容、各狀態的按鈕。
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data: unknown; error: { message: string; code?: string } | null };
const { calls, replies } = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; payload?: unknown; filters: unknown[] }>,
  /** 測試排好的回應(依請求順序);沒排就回 { id: "p1" } */
  replies: [] as Reply[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const call = { op: "select", payload: undefined as unknown, filters: [] as unknown[] };
      calls.push(call);
      const b = {
        insert: (v: unknown) => {
          call.op = "insert";
          call.payload = v;
          return b;
        },
        update: (v: unknown) => {
          call.op = "update";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        select: () => b,
        single: async () => replies.shift() ?? { data: { id: "p1" }, error: null },
        maybeSingle: async () => replies.shift() ?? { data: { id: "p1" }, error: null },
      };
      return b;
    },
  },
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CABBAGE } from "./testFixtures";
import {
  emptyProductForm,
  hasVisibleText,
  INVISIBLE_CHARS,
  productActions,
  productFormFromRow,
  productPayload,
  saveMarketProduct,
  StaleProductError,
  validateProductForm,
  type ProductForm,
} from "./productForm";

const valid = (over: Partial<ProductForm> = {}): ProductForm => ({
  ...emptyProductForm(),
  name: "有機高麗菜",
  category: "vegetable",
  spec: "1 顆",
  price: "120",
  ...over,
});

const STAMP = "2026-10-10T07:00:00.123456+00:00";

beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
});

describe("emptyProductForm(從 B2B 商品帶入)", () => {
  it("品名、規格、說明照帶;分類剛好是 12 類的中文名稱才帶入", () => {
    const f = emptyProductForm({ id: "s1", name: "牛腱心", category: "肉品", pack_size: "5kg/箱", price: 420, description: "澳洲" });
    expect(f).toMatchObject({ name: "牛腱心", category: "meat", spec: "5kg/箱", description: "澳洲", supplyId: "s1", price: "" });
    expect(emptyProductForm({ id: "s2", name: "x", category: "肉類", pack_size: null, price: null, description: null }).category).toBe("");
  });
});

describe("validateProductForm", () => {
  it("合法的沒有錯誤", () => {
    expect(validateProductForm(valid())).toEqual({});
  });

  it("必填:品名、分類、規格、價格", () => {
    const e = validateProductForm({ ...emptyProductForm(), price: "" });
    expect(e).toMatchObject({ name: "請填品名", category: "請選分類", spec: "請填零售規格,例如:600g/盒" });
    expect(e.price).toMatch(/1 到 1,000,000/);
  });

  it("上限跟資料庫一樣:品名 60、規格 40、說明 2000、價格整數、庫存 0–100000、照片 5 張", () => {
    expect(validateProductForm(valid({ name: "菜".repeat(61) })).name).toBe("品名最多 60 字");
    expect(validateProductForm(valid({ spec: "x".repeat(41) })).spec).toBe("規格最多 40 字");
    expect(validateProductForm(valid({ description: "x".repeat(2001) })).description).toBe("說明最多 2000 字");
    expect(validateProductForm(valid({ price: "99.5" })).price).toBeDefined();
    expect(validateProductForm(valid({ price: "0" })).price).toBeDefined();
    expect(validateProductForm(valid({ unlimitedStock: false, stock: "" })).stock).toBeDefined();
    expect(validateProductForm(valid({ unlimitedStock: false, stock: "0" })).stock).toBeUndefined();
    expect(validateProductForm(valid({ photos: ["a", "b", "c", "d", "e", "f"] })).photos).toBe("照片最多 5 張");
  });
});

describe("payload 與儲存", () => {
  it("資料列 → 表單 → payload 回得去;不限庫存 = null", () => {
    expect(productPayload(productFormFromRow(CABBAGE))).toMatchObject({ name: "有機高麗菜", price: 100, stock: 10, temperature: "chilled" });
    expect(productPayload(valid()).stock).toBeNull();
    expect(productPayload(valid({ origin: "  " })).origin).toBeNull();
  });

  it("新商品:用畫面先決定的 id 新增;送審 → pending、存草稿 → draft", async () => {
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: true, form: valid(), submit: true });
    expect(calls[0]).toMatchObject({ op: "insert", payload: { id: "p1", supplier_id: "sup", review_status: "pending", price: 120 } });
    await saveMarketProduct({ supplierId: "sup", productId: "p2", isNew: true, form: valid(), submit: false });
    expect(calls[1].payload).toMatchObject({ review_status: "draft" });
  });

  it("修改:一般儲存不送 review_status(交給資料庫判斷要不要重審);重新送審才送 pending", async () => {
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: false, expectedUpdatedAt: STAMP });
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).not.toHaveProperty("review_status");
    expect(calls[0].filters).toEqual([
      ["id", "p1"],
      ["updated_at", STAMP],
    ]);
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: true, expectedUpdatedAt: STAMP });
    expect(calls[1].payload).toMatchObject({ review_status: "pending" });
  });
});

describe("productActions", () => {
  it("新商品 / 草稿:儲存草稿 + 送出審核", () => {
    expect(productActions(null)).toMatchObject({ secondary: { label: "儲存草稿" }, primary: { label: "送出審核", submit: true } });
    expect(productActions("draft").primary.label).toBe("送出審核");
  });

  it("退回:可以先存不送審,或重新送審", () => {
    expect(productActions("rejected")).toMatchObject({ secondary: { label: "儲存(先不送審)" }, primary: { label: "重新送審", submit: true } });
  });

  it("審核中、已核准:只有儲存;已核准提醒哪些欄位會重審", () => {
    expect(productActions("pending")).toMatchObject({ secondary: null, primary: { label: "儲存", submit: false } });
    expect(productActions("approved").notice).toMatch(/只改價格、庫存、上架開關不用重審/);
  });
});


// 資料庫的 market_products_guard 把「只有看不見的字元」的品名、規格當成空字串(被 CHECK 擋成 23514,畫面只能顯示通用錯誤)。
// 前端先用同一組字元判斷,直接顯示「請填品名」。(測試字串一律用 \u{…} 寫,檔案裡不放看不見的字元本身)
describe("看不見的字元(跟資料庫的 market_visible 同一套)", () => {
  it("品名、規格只有空白 / 零寬 / 格式 / 看起來空白的字元就當成沒填;夾著一般字、emoji 照常", () => {
    expect(validateProductForm(valid({ name: "\u{200b}\u{3000}\u{2060}" })).name).toBe("請填品名");
    expect(validateProductForm(valid({ name: "\u{e0020}\u{3164}\u{ad}" })).name).toBe("請填品名");
    expect(validateProductForm(valid({ spec: "\u{2800}\u{fe0f}\u{200e}" })).spec).toBe("請填零售規格,例如:600g/盒");
    expect(validateProductForm(valid({ name: "\u{200b}高麗菜" })).name).toBeUndefined();
    expect(validateProductForm(valid({ name: "\u{2764}\u{fe0f} 高麗菜" })).name).toBeUndefined();
    expect(hasVisibleText("\u{1f96c}")).toBe(true);
    expect(hasVisibleText("")).toBe(false);
  });

  it("看不見的字元清單跟 migration 120000 的 market_visible 一字不差", () => {
    const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009120000_market_catalog.sql"), "utf8");
    const found = [...sql.matchAll(/p_text ~ '\[\^(.+?)\]'/g)];
    expect(found).toHaveLength(1);
    // 兩邊都換成 \u{十六進位}:Postgres 的 \UXXXXXXXX(8 位)與 \uXXXX(4 位)、前端常數(u 旗標的 \u{X})
    const canon = (cls: string) =>
      cls
        .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) => `\\u{${parseInt(hex, 16).toString(16)}}`)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => `\\u{${parseInt(hex, 16).toString(16)}}`);
    expect(INVISIBLE_CHARS).toBe(canon(found[0][1]));
    expect(INVISIBLE_CHARS).toBe(canon(INVISIBLE_CHARS));
  });
});

// 樂觀鎖:修改既有商品時多比對讀到的 updated_at(原字串,不經過 Date —— 微秒會掉,永遠比不到);
// 新商品重送:第一次其實存好了、只是回應遺失,再按一次會撞主鍵 23505 → 讀回那一筆,是自家的就當作已經存好。
describe("樂觀鎖與新商品重送", () => {
  it("修改:用讀到的 updated_at 原字串比對,成功回傳那一筆", async () => {
    const result = await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: false, expectedUpdatedAt: STAMP });
    expect(calls[0].filters).toContainEqual(["updated_at", STAMP]);
    expect(result).toEqual({ row: { id: "p1" }, alreadySaved: false });
  });

  it("修改:沒有更新到任何一列(別人或另一個分頁先改過)→ StaleProductError,不覆寫", async () => {
    replies.push({ data: null, error: null });
    const save = saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: false, expectedUpdatedAt: STAMP });
    await expect(save).rejects.toBeInstanceOf(StaleProductError);
    expect(new StaleProductError().message).toBe("這個商品已被其他人更新,請重新載入後再改");
  });

  it("修改:沒有讀到的 updated_at 就不送出(沒辦法確認畫面上是不是最新的)", async () => {
    await expect(saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: false })).rejects.toBeInstanceOf(
      StaleProductError,
    );
    expect(calls).toHaveLength(0);
  });

  it("新商品撞主鍵 23505:讀回那一筆,是自家的就當作已經存好(alreadySaved)", async () => {
    const existing = { id: "p1", supplier_id: "sup", review_status: "pending" };
    replies.push({ data: null, error: { message: 'duplicate key value violates unique constraint "market_products_pkey"', code: "23505" } });
    replies.push({ data: existing, error: null });
    const result = await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: true, form: valid(), submit: true });
    expect(result).toEqual({ row: existing, alreadySaved: true });
    expect(calls[1]).toMatchObject({ op: "select", filters: [["id", "p1"]] });
  });

  it("新商品撞主鍵,但讀不到那一筆或不是自家的:中文錯誤,不覆寫", async () => {
    const input = { supplierId: "sup", productId: "p1", isNew: true, form: valid(), submit: false };
    replies.push({ data: null, error: { message: "duplicate key", code: "23505" } }, { data: null, error: null });
    await expect(saveMarketProduct(input)).rejects.toThrow("這個商品編號已經被使用,請關閉視窗後重新新增");
    replies.push({ data: null, error: { message: "duplicate key", code: "23505" } }, { data: { id: "p1", supplier_id: "other" }, error: null });
    await expect(saveMarketProduct(input)).rejects.toThrow("這個商品編號已經被使用,請關閉視窗後重新新增");
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("新商品的其他錯誤照原樣丟出(例如還沒建店家的 23503),不另外讀", async () => {
    replies.push({ data: null, error: { message: "fk", code: "23503" } });
    await expect(saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: true, form: valid(), submit: false })).rejects.toMatchObject({
      code: "23503",
    });
    expect(calls).toHaveLength(1);
  });
});
