// useSupplierMarketProducts:讀取失敗與「重新載入」、存檔後立刻換上資料庫回傳的那一筆、晚到的舊回應不蓋掉新資料。
// supabase 換成「每個請求都等測試回應」的假 client,測試自己決定回應的順序。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Res = { data: unknown; error: { message: string; code?: string; hint?: string } | null };
const { queue } = vi.hoisted(() => ({ queue: [] as Array<{ table: string; resolve: (r: Res) => void }> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let pending: Promise<Res> | null = null;
      const respond = () => (pending ??= new Promise<Res>((resolve) => queue.push({ table, resolve })));
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        maybeSingle: () => respond(),
        then: (ok: (v: Res) => unknown, bad?: (e: unknown) => unknown) => respond().then(ok, bad),
      };
      return b;
    },
  },
}));

import { CABBAGE, SUPPLIER_A, makeProduct } from "@/lib/market/testFixtures";
import { useSupplierMarketProducts } from "./useSupplierMarketProducts";

/** 拿走目前等待中的請求(依送出順序),並確認是一組「商品 + 店家」 */
const takePair = () => {
  const [products, store] = queue.splice(0, 2);
  expect([products?.table, store?.table]).toEqual(["market_products", "market_stores"]);
  return { products, store };
};
const HAS_STORE: Res = { data: { supplier_id: SUPPLIER_A }, error: null };
const OFFLINE: Res = { data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "" } };

beforeEach(() => {
  queue.length = 0;
});

describe("useSupplierMarketProducts", () => {
  it("讀取失敗:有 error、讀取結束、沒有資料;retry 先回到讀取中,成功才有資料、error 清掉", async () => {
    const { result } = renderHook(() => useSupplierMarketProducts(SUPPLIER_A));
    expect(result.current.loading).toBe(true);
    const first = takePair();
    first.products.resolve(OFFLINE);
    first.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("連線失敗,請檢查網路後再試一次");
    expect(result.current.products).toEqual([]);
    expect(result.current.hasStore).toBe(false);

    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    const second = takePair();
    second.products.resolve({ data: [CABBAGE], error: null });
    second.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.products).toEqual([CABBAGE]);
    expect(result.current.hasStore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("applySaved:存好的那一筆立刻換成資料庫回傳的值、排到最前面(跟重抓的 updated_at 排序一致);新的一筆加在最前面", async () => {
    const other = makeProduct({ name: "其他商品" });
    const { result } = renderHook(() => useSupplierMarketProducts(SUPPLIER_A));
    const first = takePair();
    first.products.resolve({ data: [other, CABBAGE], error: null });
    first.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.products).toHaveLength(2));

    act(() => result.current.applySaved({ ...CABBAGE, price: 120 }));
    expect(result.current.products.map((p) => [p.id, p.price])).toEqual([
      [CABBAGE.id, 120],
      [other.id, other.price],
    ]);
    const fresh = makeProduct({ name: "新商品" });
    act(() => result.current.applySaved(fresh));
    expect(result.current.products.map((p) => p.id)).toEqual([fresh.id, CABBAGE.id, other.id]);
  });

  it("重抓的回應晚到(比後來送出的那次還晚)就丟掉:不蓋掉比較新的資料,晚到的失敗也不顯示錯誤", async () => {
    const { result } = renderHook(() => useSupplierMarketProducts(SUPPLIER_A));
    const first = takePair();
    first.products.resolve({ data: [CABBAGE], error: null });
    first.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.reload();
    });
    const older = takePair();
    act(() => {
      void result.current.reload();
    });
    const newer = takePair();
    newer.products.resolve({ data: [{ ...CABBAGE, price: 120 }], error: null });
    newer.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.products[0]?.price).toBe(120));

    older.products.resolve({ data: [{ ...CABBAGE, price: 100 }], error: null });
    older.store.resolve(HAS_STORE);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.products[0]?.price).toBe(120);

    // 晚到的是失敗:也丟掉,不把畫面換成錯誤
    act(() => {
      void result.current.reload();
    });
    const olderFail = takePair();
    act(() => {
      void result.current.reload();
    });
    const newerOk = takePair();
    newerOk.products.resolve({ data: [{ ...CABBAGE, price: 130 }], error: null });
    newerOk.store.resolve(HAS_STORE);
    await waitFor(() => expect(result.current.products[0]?.price).toBe(130));
    olderFail.products.resolve(OFFLINE);
    olderFail.store.resolve(HAS_STORE);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.products[0]?.price).toBe(130);
  });
});

describe("useSupplierMarketProducts — 店家對消費者開著嗎", () => {
  it("storeOpen:零售被管理員停用、或供應商帳號停用 → false(消費者看不到);都開著才 true", async () => {
    const { result } = renderHook(() => useSupplierMarketProducts(SUPPLIER_A));
    const first = takePair();
    first.products.resolve({ data: [CABBAGE], error: null });
    first.store.resolve({ data: { supplier_id: SUPPLIER_A, is_enabled: false, suppliers: { is_active: true } }, error: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasStore).toBe(true);
    expect(result.current.storeOpen).toBe(false);

    act(() => {
      void result.current.reload();
    });
    const second = takePair();
    second.products.resolve({ data: [CABBAGE], error: null });
    second.store.resolve({ data: { supplier_id: SUPPLIER_A, is_enabled: true, suppliers: { is_active: true } }, error: null });
    await waitFor(() => expect(result.current.storeOpen).toBe(true));

    act(() => {
      void result.current.reload();
    });
    const third = takePair();
    third.products.resolve({ data: [CABBAGE], error: null });
    third.store.resolve({ data: { supplier_id: SUPPLIER_A, is_enabled: true, suppliers: { is_active: false } }, error: null });
    await waitFor(() => expect(result.current.storeOpen).toBe(false));
  });
});
