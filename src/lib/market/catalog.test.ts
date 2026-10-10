// catalog.ts:公開查詢帶對篩選條件、再篩一次可見性;首頁篩選、精選店家。supabase 換成記錄查詢的假物件。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, rows } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; select: string; filters: Array<[string, string, unknown]> }>,
  rows: { value: [] as unknown[] },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, select: "", filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const result = () => Promise.resolve({ data: rows.value, error: null });
      const builder = {
        select: (c: string) => {
          call.select = c;
          return builder;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push(["eq", c, v]);
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
        maybeSingle: () => Promise.resolve({ data: rows.value[0] ?? null, error: null }),
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
  fetchStoreProducts,
  filterProducts,
  filtersFromParams,
  isPubliclyVisible,
  paramsFromFilters,
} from "./catalog";
import { BEEF, CABBAGE, SALMON, STORE_A, STORE_B, SUPPLIER_A, makeProduct } from "./testFixtures";

beforeEach(() => {
  calls.length = 0;
  rows.value = [];
});

describe("公開查詢", () => {
  it("首頁只抓已核准、上架中的商品,並嵌入店家與供應商名稱", async () => {
    rows.value = [CABBAGE, makeProduct({ market_stores: { ...STORE_A, is_enabled: false } })];
    const list = await fetchListedProducts();
    expect(calls[0].table).toBe("market_products");
    expect(calls[0].select).toContain("market_stores(");
    expect(calls[0].select).toContain("suppliers(name, phone, contact_email, is_active)");
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

  it("店家頁只抓那一家的商品", async () => {
    rows.value = [CABBAGE];
    await fetchStoreProducts(SUPPLIER_A);
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "supplier_id", SUPPLIER_A]]));
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
