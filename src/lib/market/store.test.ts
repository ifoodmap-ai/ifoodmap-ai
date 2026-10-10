// store.ts:表單 ↔ 資料列、驗證(上限跟資料庫一樣)、儲存順序(轉帳資訊一定先存)。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ table: string; op: string; payload: unknown; opts?: unknown }> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const b = {
        upsert: (payload: unknown, opts: unknown) => {
          calls.push({ table, op: "upsert", payload, opts });
          return b;
        },
        select: () => b,
        eq: () => b,
        single: async () => ({ data: { supplier_id: "sup-1" }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      return b;
    },
  },
}));

import { STORE_A } from "./testFixtures";
import { emptyStoreForm, saveStore, storeFormFromRow, storePayload, validateStoreForm, type StoreForm } from "./store";

const valid = (over: Partial<StoreForm> = {}): StoreForm => ({
  ...emptyStoreForm(),
  deliveryCities: ["臺北市"],
  shippingFee: "120",
  freeShippingThreshold: "1000",
  minOrderAmount: "300",
  shipDays: "2",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
});

describe("validateStoreForm", () => {
  it("合法的表單沒有錯誤", () => {
    expect(validateStoreForm(valid())).toEqual({});
  });

  it("至少一個縣市、至少一種付款方式", () => {
    expect(validateStoreForm(valid({ deliveryCities: [] })).deliveryCities).toBe("至少選一個配送縣市");
    expect(validateStoreForm(valid({ acceptCod: false, acceptTransfer: false })).acceptCod).toBe("至少接受一種付款方式");
  });

  it("金額與天數:整數、範圍跟資料庫一樣", () => {
    expect(validateStoreForm(valid({ shippingFee: "10001" })).shippingFee).toMatch(/0 到 10,000/);
    expect(validateStoreForm(valid({ shippingFee: "12.5" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ shippingFee: "-1" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "" })).freeShippingThreshold).toBeUndefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "0" })).freeShippingThreshold).toBeDefined();
    expect(validateStoreForm(valid({ minOrderAmount: "abc" })).minOrderAmount).toBeDefined();
    expect(validateStoreForm(valid({ shipDays: "31" })).shipDays).toMatch(/0 到 30/);
  });

  it("勾銀行轉帳一定要填 5–300 字的轉帳資訊", () => {
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "  " })).transferInfo).toMatch(/轉帳資訊/);
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "x".repeat(301) })).transferInfo).toBeDefined();
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "台灣銀行 004 帳號 123" })).transferInfo).toBeUndefined();
  });

  it("介紹與退換貨最多 1000 字", () => {
    expect(validateStoreForm(valid({ intro: "字".repeat(1001) })).intro).toBe("店家介紹最多 1000 字");
    expect(validateStoreForm(valid({ returnPolicy: "字".repeat(1001) })).returnPolicy).toBe("退換貨說明最多 1000 字");
  });
});

describe("資料列 ↔ 表單", () => {
  it("storeFormFromRow 再 storePayload 回得去", () => {
    const form = storeFormFromRow(STORE_A, "台灣銀行 004 帳號 123");
    expect(form).toMatchObject({ shippingFee: "120", freeShippingThreshold: "1000", acceptCod: true, acceptTransfer: true });
    expect(storePayload(STORE_A.supplier_id, form)).toMatchObject({
      delivery_cities: ["臺北市", "新北市"],
      shipping_fee: 120,
      free_shipping_threshold: 1000,
      min_order_amount: 300,
      ship_days: 2,
      payment_methods: ["cod", "transfer"],
      intro: "當日採收的葉菜與根莖類",
    });
  });

  it("免運門檻留白 = null;空白介紹 = null", () => {
    expect(storePayload("s", valid({ freeShippingThreshold: " ", intro: "  " }))).toMatchObject({
      free_shipping_threshold: null,
      intro: null,
    });
  });
});

describe("saveStore", () => {
  it("接受轉帳:先存轉帳資訊、再存店家", async () => {
    await saveStore("sup-1", valid({ acceptTransfer: true, transferInfo: " 台灣銀行 004 帳號 123 " }));
    expect(calls.map((c) => c.table)).toEqual(["market_store_transfer", "market_stores"]);
    expect(calls[0].payload).toEqual({ supplier_id: "sup-1", transfer_info: "台灣銀行 004 帳號 123" });
    expect(calls[1].opts).toEqual({ onConflict: "supplier_id" });
  });

  it("只收貨到付款:不碰轉帳資訊", async () => {
    await saveStore("sup-1", valid());
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });
});
