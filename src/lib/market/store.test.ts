// store.ts:表單 ↔ 資料列、驗證(上限跟資料庫一樣)、儲存順序(轉帳資訊一定先存)。
import { beforeEach, describe, expect, it, vi } from "vitest";

// 假的 supabase:每次 from() 記一筆(表、操作、資料、篩選),await 時從 queue 拿「<表>.<操作>」的回應,沒有就用預設值。
type Call = {
  table: string;
  op: "select" | "upsert" | "insert" | "update";
  payload?: unknown;
  opts?: unknown;
  columns?: string;
  returning?: string;
  filters: Array<[string, unknown]>;
};
type Res = { data: unknown; error: { message: string; code?: string; hint?: string } | null };
const { calls, queue } = vi.hoisted(() => ({ calls: [] as Call[], queue: {} as Record<string, Res[]> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      let recorded = false;
      const respond = (): Promise<Res> => {
        if (!recorded) {
          calls.push(call);
          recorded = true;
        }
        const q = queue[`${table}.${call.op}`];
        if (q && q.length) return Promise.resolve(q.shift() as Res);
        // 預設:查詢查無資料;寫入成功並回傳一列
        return Promise.resolve(call.op === "select" ? { data: null, error: null } : { data: { supplier_id: "sup-1" }, error: null });
      };
      const b = {
        select: (cols?: string) => {
          if (call.op === "select") call.columns = cols;
          else call.returning = cols;
          return b;
        },
        upsert: (payload: unknown, opts: unknown) => {
          Object.assign(call, { op: "upsert", payload, opts });
          return b;
        },
        insert: (payload: unknown) => {
          Object.assign(call, { op: "insert", payload });
          return b;
        },
        update: (payload: unknown) => {
          Object.assign(call, { op: "update", payload });
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        single: respond,
        maybeSingle: respond,
        then: (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => respond().then(ok, ko),
      };
      return b;
    },
  },
}));

import { MarketDbError } from "./db";
import { STORE_A } from "./testFixtures";
import {
  emptyStoreForm,
  fetchOwnStore,
  saveStore,
  STORE_OWNER_COLUMNS,
  storeFormFromRow,
  storePayload,
  validateStoreForm,
  type StoreForm,
} from "./store";

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
  for (const k of Object.keys(queue)) delete queue[k];
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

  it("storePayload 每個欄位都照表單送(logo、封面、退換貨說明不能變成 null 把原本的蓋掉)", () => {
    const form = valid({
      intro: " 介紹 ",
      returnPolicy: " 收到 24 小時內可退 ",
      logoPath: "sup-1/store/logo.jpg",
      coverPath: "sup-1/store/cover.jpg",
      acceptTransfer: true,
      transferInfo: "台灣銀行 004 帳號 123",
    });
    expect(storePayload("sup-1", form)).toEqual({
      supplier_id: "sup-1",
      intro: "介紹",
      return_policy: "收到 24 小時內可退",
      delivery_cities: ["臺北市"],
      shipping_fee: 120,
      free_shipping_threshold: 1000,
      min_order_amount: 300,
      ship_days: 2,
      payment_methods: ["cod", "transfer"],
      logo_path: "sup-1/store/logo.jpg",
      cover_path: "sup-1/store/cover.jpg",
    });
  });

  it("免運門檻留白 = null;空白介紹 = null", () => {
    expect(storePayload("s", valid({ freeShippingThreshold: " ", intro: "  " }))).toMatchObject({
      free_shipping_threshold: null,
      intro: null,
    });
  });
});

// 讀取出錯一定要丟錯:回 null 的話頁面會當成「還沒建店」顯示空白表單,一儲存就把原本的設定蓋掉。
describe("fetchOwnStore", () => {
  it("讀到店家與轉帳資訊:只查自家、欄位是 STORE_OWNER_COLUMNS", async () => {
    queue["market_stores.select"] = [{ data: STORE_A, error: null }];
    queue["market_store_transfer.select"] = [{ data: { transfer_info: "台灣銀行 004 帳號 123" }, error: null }];
    await expect(fetchOwnStore("sup-1")).resolves.toEqual({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123" });
    expect(calls.map((c) => [c.table, c.columns, c.filters])).toEqual([
      ["market_stores", STORE_OWNER_COLUMNS, [["supplier_id", "sup-1"]]],
      ["market_store_transfer", "transfer_info", [["supplier_id", "sup-1"]]],
    ]);
  });

  it("查無店家、查無轉帳資訊 → 都是 null(這才是「還沒建店」)", async () => {
    await expect(fetchOwnStore("sup-1")).resolves.toEqual({ store: null, transferInfo: null });
  });

  it("店家查詢失敗 → 丟 MarketDbError,不能回 null", async () => {
    queue["market_stores.select"] = [{ data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "" } }];
    await expect(fetchOwnStore("sup-1")).rejects.toBeInstanceOf(MarketDbError);
  });

  it("轉帳資訊查詢失敗 → 丟 MarketDbError,不能當成沒有轉帳資訊", async () => {
    queue["market_stores.select"] = [{ data: STORE_A, error: null }];
    queue["market_store_transfer.select"] = [{ data: null, error: { message: "permission denied", code: "42501" } }];
    await expect(fetchOwnStore("sup-1")).rejects.toBeInstanceOf(MarketDbError);
  });
});

describe("saveStore", () => {
  it("轉帳資訊存失敗 → 丟錯,不會接著存店家", async () => {
    queue["market_store_transfer.upsert"] = [{ data: null, error: { message: "value too long", code: "23514" } }];
    await expect(saveStore("sup-1", valid({ acceptTransfer: true, transferInfo: "台灣銀行 004 帳號 123" }))).rejects.toBeInstanceOf(
      MarketDbError,
    );
    expect(calls.map((c) => c.table)).toEqual(["market_store_transfer"]);
  });

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
