// catalog.ts:公開查詢帶對篩選條件、再篩一次可見性;首頁篩選、精選店家。supabase 換成記錄查詢的假物件。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, rows, failWith } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; select: string; filters: Array<[string, string, unknown]> }>,
  rows: { value: [] as unknown[] },
  /** 設了就讓查詢回這個錯誤(模擬 PostgREST 擋下來 / 斷線) */
  failWith: { value: null as null | { message: string; code: string; hint: string } },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, select: "", filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const result = () =>
        Promise.resolve(failWith.value ? { data: null, error: failWith.value } : { data: rows.value, error: null });
      const builder = {
        select: (c: string) => {
          call.select = c;
          return builder;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push(["eq", c, v]);
          return builder;
        },
        in: (c: string, v: unknown) => {
          call.filters.push(["in", c, v]);
          return builder;
        },
        order: (c: string, o: { ascending: boolean }) => {
          call.filters.push(["order", c, o.ascending]);
          return builder;
        },
        limit: (n: number) => {
          call.filters.push(["limit", "limit", n]);
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve(failWith.value ? { data: null, error: failWith.value } : { data: rows.value[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => result().then(ok, bad),
      };
      return builder;
    },
  },
}));

import {
  featuredStores,
  fetchListedProducts,
  fetchMarketProduct,
  fetchMarketStore,
  fetchProductsByIds,
  fetchStoreProducts,
  filterProducts,
  filtersFromParams,
  isPubliclyVisible,
  paramsFromFilters,
  PRODUCT_PUBLIC_COLUMNS,
  STORE_PUBLIC_COLUMNS,
} from "./catalog";
import type { MarketCategoryKey } from "./constants";
import { MarketDbError } from "./db";
import { BEEF, CABBAGE, SALMON, STORE_A, STORE_B, SUPPLIER_A, SUPPLIER_B, makeProduct } from "./testFixtures";

beforeEach(() => {
  calls.length = 0;
  rows.value = [];
  failWith.value = null;
});

describe("公開查詢", () => {
  it("首頁只抓已核准、上架中的商品,並嵌入店家與供應商名稱", async () => {
    rows.value = [CABBAGE, makeProduct({ market_stores: { ...STORE_A, is_enabled: false } })];
    const list = await fetchListedProducts();
    expect(calls[0].table).toBe("market_products");
    expect(calls[0].select).toContain("market_stores(");
    expect(calls[0].select).toContain("suppliers(name, phone, is_active)");
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "review_status", "approved"],
        ["eq", "is_listed", true],
        ["limit", "limit", 500],
      ]),
    );
    // 登入中的供應商看得到自家停用店家的商品,但市集上不能出現
    expect(list.map((p) => p.id)).toEqual([CABBAGE.id]);
  });

  it("商品 id 不是 uuid 就不查", async () => {
    await expect(fetchMarketProduct("abc")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("店家頁:只抓那一家、已核准、上架中的商品,回來再篩一次可見性(三道少一道都會紅)", async () => {
    rows.value = [
      CABBAGE,
      makeProduct({ market_stores: { ...STORE_A, is_enabled: false } }),
      makeProduct({ review_status: "pending" }),
      makeProduct({ is_listed: false }),
    ];
    const list = await fetchStoreProducts(SUPPLIER_A);
    expect(calls[0].table).toBe("market_products");
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "supplier_id", SUPPLIER_A],
        ["eq", "review_status", "approved"],
        ["eq", "is_listed", true],
      ]),
    );
    // 登入中的店家 / 管理員看得到自家停用、待審、下架的商品(RLS 放行),市集上不能出現
    expect(list.map((p) => p.id)).toEqual([CABBAGE.id]);
  });

  it("店家頁:供應商 id 不是 uuid 就不查", async () => {
    await expect(fetchStoreProducts("abc")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("店家:用 supplier_id 查 market_stores 的公開欄位,回傳那一列", async () => {
    rows.value = [STORE_A];
    await expect(fetchMarketStore(SUPPLIER_A)).resolves.toEqual(STORE_A);
    expect(calls[0].table).toBe("market_stores");
    expect(calls[0].select).toBe(STORE_PUBLIC_COLUMNS);
    expect(calls[0].filters).toEqual([["eq", "supplier_id", SUPPLIER_A]]);
  });

  it("店家:沒有這家(或 RLS 看不到)回 null;id 不是 uuid 就不查", async () => {
    await expect(fetchMarketStore(SUPPLIER_B)).resolves.toBeNull();
    calls.length = 0;
    await expect(fetchMarketStore("abc")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("查詢失敗一律丟 MarketDbError(頁面才會顯示載入失敗,不會當成沒資料)", async () => {
    failWith.value = { message: "Could not find the table", code: "PGRST205", hint: "" };
    await expect(fetchMarketStore(SUPPLIER_A)).rejects.toBeInstanceOf(MarketDbError);
    await expect(fetchStoreProducts(SUPPLIER_A)).rejects.toBeInstanceOf(MarketDbError);
    await expect(fetchListedProducts()).rejects.toBeInstanceOf(MarketDbError);
    await expect(fetchMarketProduct(CABBAGE.id)).rejects.toBeInstanceOf(MarketDbError);
  });

  it("購物車:依 id 重新抓(去重、丟掉不是 uuid 的;不篩可見性);一個都沒有就不查", async () => {
    rows.value = [CABBAGE, { ...BEEF, review_status: "pending" }];
    const list = await fetchProductsByIds([CABBAGE.id, CABBAGE.id, "abc", BEEF.id]);
    expect(calls[0].filters).toEqual([["in", "id", [CABBAGE.id, BEEF.id]]]);
    expect(calls[0].select).toContain("market_stores(");
    expect(list).toHaveLength(2);
    await expect(fetchProductsByIds(["abc"])).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("公開欄位", () => {
  const HIDDEN = ["reject_reason", "supply_id", "disabled_reason", "contact_email", "reviewed_by"];

  it("明列欄位、不用 *;不含審核原因、批發對應、停用原因、店家聯絡信箱", () => {
    for (const columns of [STORE_PUBLIC_COLUMNS, PRODUCT_PUBLIC_COLUMNS]) {
      expect(columns).not.toContain("*");
      for (const name of HIDDEN) expect(columns).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  // 店家的法定資訊(消保法 §18、應記載事項第 1 點)與商品的七日鑑賞期標示(準則 §2:要逐項告知):店家頁、商品頁、購物車、結帳要顯示
  const STORE_LEGAL = ["legal_name", "representative", "business_address", "service_email", "food_registration_no", "liability_insurance"];
  const COMPLIANCE = resolve(__dirname, "../../../supabase/migrations/20261012110000_market_compliance.sql");

  it("店家的法定資訊、商品的七日鑑賞期標示都在公開欄位裡;店家聯絡信箱(contact_email)仍然不抓", () => {
    for (const name of STORE_LEGAL) expect(STORE_PUBLIC_COLUMNS).toMatch(new RegExp(`\\b${name}\\b`));
    expect(PRODUCT_PUBLIC_COLUMNS).toMatch(/\bwithdrawal_exempt\b/);
    expect(`${STORE_PUBLIC_COLUMNS} ${PRODUCT_PUBLIC_COLUMNS}`).not.toMatch(/contact_email/);
  });

  it.skipIf(!existsSync(COMPLIANCE))("新欄位的名稱跟 migration 20261012110000_market_compliance.sql 一樣", () => {
    const sql = readFileSync(COMPLIANCE, "utf8");
    for (const name of [...STORE_LEGAL, "withdrawal_exempt"]) expect(sql, name).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("四支公開查詢實際送出的 select 都是這兩組欄位", async () => {
    rows.value = [CABBAGE];
    await fetchListedProducts();
    await fetchStoreProducts(SUPPLIER_A);
    await fetchMarketProduct(CABBAGE.id);
    await fetchMarketStore(SUPPLIER_A);
    const withStore = `${PRODUCT_PUBLIC_COLUMNS}, market_stores(${STORE_PUBLIC_COLUMNS})`;
    expect(calls.map((c) => c.select)).toEqual([withStore, withStore, withStore, STORE_PUBLIC_COLUMNS]);
  });
});

describe("isPubliclyVisible", () => {
  it("已核准 + 上架中 + 店家啟用 + 供應商啟用才算", () => {
    expect(isPubliclyVisible(CABBAGE)).toBe(true);
    expect(isPubliclyVisible({ ...CABBAGE, review_status: "pending" })).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, is_listed: false })).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, market_stores: { ...STORE_A, is_enabled: false } })).toBe(false);
    expect(
      isPubliclyVisible({
        ...CABBAGE,
        market_stores: { ...STORE_A, suppliers: { name: "x", phone: null, contact_email: null, is_active: false } },
      }),
    ).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, market_stores: null })).toBe(false);
  });
});

describe("首頁篩選", () => {
  const all = [CABBAGE, BEEF, SALMON];
  const base = { q: "", category: null, city: null, temperature: null };

  it("網址參數 ↔ 篩選條件;不認得的值丟掉", () => {
    const f = filtersFromParams(new URLSearchParams("q=高麗&cat=meat&city=臺北市&temp=frozen"));
    expect(f).toEqual({ q: "高麗", category: "meat", city: "臺北市", temperature: "frozen" });
    expect(filtersFromParams(new URLSearchParams("cat=alcohol&city=台北市&temp=hot"))).toEqual(base);
    expect(paramsFromFilters({ ...base, category: "meat" }).toString()).toBe("cat=meat");
  });

  it("分類、溫層", () => {
    expect(filterProducts(all, { ...base, category: "meat" }).map((p) => p.name)).toEqual(["牛肉片"]);
    expect(filterProducts(all, { ...base, temperature: "frozen" }).map((p) => p.name)).toEqual(["牛肉片", "挪威鮭魚"]);
  });

  it("配送縣市:只留配送到那裡的店家的商品", () => {
    expect(filterProducts(all, { ...base, city: "新北市" }).map((p) => p.name)).toEqual(["有機高麗菜", "牛肉片"]);
  });

  it("搜尋:資料裡有前端不認得的分類(資料庫先加了新分類)也不會整頁壞掉", () => {
    const odd = makeProduct({ name: "神秘食材", category: "mystery" as unknown as MarketCategoryKey });
    expect(filterProducts([odd, CABBAGE], { ...base, q: "神秘" }).map((p) => p.name)).toEqual(["神秘食材"]);
    expect(filterProducts([odd, CABBAGE], { ...base, q: "高麗" }).map((p) => p.name)).toEqual(["有機高麗菜"]);
  });

  it("搜尋:不分大小寫、忽略空白,也搜規格、產地、分類、店名", () => {
    expect(filterProducts(all, { ...base, q: "高 麗" }).map((p) => p.name)).toEqual(["有機高麗菜"]);
    expect(filterProducts(all, { ...base, q: "宜蘭" }).map((p) => p.name)).toEqual(["有機高麗菜"]);
    expect(filterProducts(all, { ...base, q: "海鮮" }).map((p) => p.name)).toEqual(["挪威鮭魚"]);
    expect(filterProducts(all, { ...base, q: "B 店" }).map((p) => p.name)).toEqual(["挪威鮭魚"]);
  });

  it("精選店家:商品多的排前面;選了縣市只留配送到那裡的店", () => {
    expect(featuredStores(all, null).map((s) => [s.name, s.productCount])).toEqual([
      ["市集測試 A 店", 2],
      ["市集測試 B 店", 1],
    ]);
    expect(featuredStores(all, "新北市").map((s) => s.supplierId)).toEqual([STORE_A.supplier_id]);
    expect(featuredStores(all, null, 1)).toHaveLength(1);
    expect(featuredStores([SALMON], null)[0].deliveryCities).toEqual(STORE_B.delivery_cities);
  });
});
