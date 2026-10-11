// checkout.ts:表單驗證(跟資料庫同一套正規表示式)、送出的內容(只算能結帳的店、帶預期總額)、錯誤訊息。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import { buildCart } from "./cart";
import {
  buildCheckoutPayload,
  checkoutErrorMessage,
  defaultPayment,
  EMAIL_PATTERN,
  emptyBuyer,
  fetchCheckoutStatus,
  PHONE_PATTERN,
  placeOrder,
  validateBuyer,
  type BuyerForm,
  type PlaceOrderResult,
} from "./checkout";
import { BEEF, CABBAGE, SALMON, SUPPLIER_A, SUPPLIER_B } from "./testFixtures";

const MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130000_market_orders.sql"), "utf8");
const CHECKOUT_MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130200_market_checkout.sql"), "utf8");
const sqlRegex = (marker: string) => {
  const m = MIGRATION.match(new RegExp(`p ~ '([^']+)'\\s+-- @market-${marker}-regex`));
  if (!m) throw new Error(`migration 少了 @market-${marker}-regex`);
  return m[1];
};

const GOOD: BuyerForm = {
  name: " 王小明 ",
  phone: "0912-345-678",
  email: " Buyer@Example.com ",
  city: "臺北市",
  address: "測試路 1 號 2 樓",
  note: " 請放管理室 ",
};

describe("跟資料庫一致", () => {
  it("電話、Email 的正規表示式", () => {
    expect(PHONE_PATTERN.source).toBe(sqlRegex("phone"));
    expect(EMAIL_PATTERN.source).toBe(sqlRegex("email"));
  });
});

describe("validateBuyer", () => {
  it("全部空白:每一欄都有錯誤", () => {
    expect(Object.keys(validateBuyer(emptyBuyer())).sort()).toEqual(["address", "city", "email", "name", "phone"]);
  });

  it("電話接受手機與市話(可以有空白、連字號、括號);格式不對要擋", () => {
    for (const phone of ["0912345678", "0912-345-678", "(02) 2345-6789", "037-123456"]) {
      expect(validateBuyer({ ...GOOD, phone }).phone, phone).toBeUndefined();
    }
    for (const phone of ["912345678", "09123456789", "0912-345-67a", "+886912345678"]) {
      expect(validateBuyer({ ...GOOD, phone }).phone, phone).toBe("請填寫手機或市話,例如 0912345678 或 02-2345-6789");
    }
  });

  it("Email、縣市、地址、姓名與備註長度", () => {
    expect(validateBuyer({ ...GOOD, email: "a@b" }).email).toBe("Email 格式不對(訂單通知會寄到這裡)");
    expect(validateBuyer({ ...GOOD, email: "名字<a@b.com>" }).email).toBeDefined();
    expect(validateBuyer({ ...GOOD, city: "" }).city).toBe("請選擇收件縣市");
    expect(validateBuyer({ ...GOOD, address: "一號" }).address).toBe("請填寫完整的收件地址(5–200 字)");
    expect(validateBuyer({ ...GOOD, name: "王".repeat(51) }).name).toBe("姓名最多 50 字");
    expect(validateBuyer({ ...GOOD, note: "字".repeat(301) }).note).toBe("備註最多 300 字");
    expect(validateBuyer(GOOD)).toEqual({});
  });

  it("姓名、地址只有全形空白、零寬字元也算沒填(資料庫的 market_visible 一樣會擋成 INVALID_INPUT)", () => {
    expect(validateBuyer({ ...GOOD, name: "\u{3000}\u{200B}" }).name).toBe("請填寫收件人姓名");
    expect(validateBuyer({ ...GOOD, address: "\u{200B}".repeat(6) }).address).toBe("請填寫完整的收件地址(5–200 字)");
    expect(validateBuyer({ ...GOOD, name: "\u{200B}王小明" }).name).toBeUndefined();
  });
});

describe("buildCheckoutPayload", () => {
  const view = buildCart(
    [
      { productId: CABBAGE.id, qty: 2 },
      { productId: BEEF.id, qty: 1 },
      { productId: SALMON.id, qty: 1 },
    ],
    [CABBAGE, BEEF, SALMON],
    "臺北市",
  );

  it("收件資料去空白、電話去符號、Email 轉小寫;明細、付款方式、預期總額", () => {
    const payload = buildCheckoutPayload({ buyer: GOOD, groups: view.groups, payments: { [SUPPLIER_A]: "transfer" }, termsVersion: "2026-10-draft" });
    expect(payload).toEqual({
      buyer: { name: "王小明", phone: "0912345678", email: "buyer@example.com", city: "臺北市", address: "測試路 1 號 2 樓", note: "請放管理室" },
      items: [
        { product_id: CABBAGE.id, qty: 2 },
        { product_id: BEEF.id, qty: 1 },
        { product_id: SALMON.id, qty: 1 },
      ],
      payments: { [SUPPLIER_A]: "transfer", [SUPPLIER_B]: "cod" },
      expected_totals: { [SUPPLIER_A]: 770, [SUPPLIER_B]: 260 },
      terms_version: "2026-10-draft",
    });
  });

  it("只送傳進來的店(不能結帳的店不要傳);沒填備註就不送 note", () => {
    const payload = buildCheckoutPayload({ buyer: { ...GOOD, note: "  " }, groups: [view.groups[1]], payments: {}, termsVersion: "v" });
    expect(payload.items).toEqual([{ product_id: SALMON.id, qty: 1 }]);
    expect(Object.keys(payload.payments)).toEqual([SUPPLIER_B]);
    expect(payload.buyer).not.toHaveProperty("note");
  });

  it("預設付款方式:有貨到付款就用貨到付款", () => {
    expect(defaultPayment(["cod", "transfer"])).toBe("cod");
    expect(defaultPayment(["transfer"])).toBe("transfer");
  });
});

describe("呼叫資料庫", () => {
  it("下單送 p_checkout;開關狀態不帶參數", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, token: "t", checkout_id: "c", orders: [] }, error: null });
    const payload = buildCheckoutPayload({ buyer: GOOD, groups: [], payments: {}, termsVersion: "v" });
    await placeOrder(payload);
    expect(rpc).toHaveBeenLastCalledWith("market_place_order", { p_checkout: payload });
    rpc.mockResolvedValueOnce({ data: { open: false, can_order: true }, error: null });
    expect(await fetchCheckoutStatus()).toEqual({ open: false, can_order: true });
    expect(rpc).toHaveBeenLastCalledWith("market_checkout_status", {});
  });
});

describe("checkoutErrorMessage", () => {
  const name = (id: string) => (id === SUPPLIER_A ? "A 店" : "B 店");
  it.each([
    [{ ok: false as const, code: "MARKET_CLOSED" }, "線上訂購還沒對外開放,購物車會幫你保留。"],
    [{ ok: false as const, code: "RATE_LIMITED", retry_after: 1500 }, "下單次數太頻繁,請 25 分鐘後再試。"],
    [{ ok: false as const, code: "INVALID_INPUT", field: "buyer.phone" }, "電話格式不對"],
    [{ ok: false as const, code: "NOT_DELIVERABLE", stores: [SUPPLIER_B] }, "B 店 不配送到你選的縣市。"],
    [{ ok: false as const, code: "BELOW_MINIMUM", stores: [{ supplier_id: SUPPLIER_A }] }, "A 店 還沒到最低訂購金額。"],
    [{ ok: false as const, code: "PRICE_CHANGED", stores: [{ supplier_id: SUPPLIER_A }] }, "價格或運費剛剛有變動,畫面已更新成最新金額,請確認後再送出一次。"],
    [{ ok: false as const, code: "SOMETHING_NEW" }, "下單失敗,請稍後再試。"],
  ])("%o", (r, msg) => {
    expect(checkoutErrorMessage(r, name)).toBe(msg);
  });

  it("等待時間:不滿 1 分鐘算 1 分鐘、無條件進位;2 小時以上改用小時(每天的上限要等到隔天)", () => {
    const msg = (retry_after: number) => checkoutErrorMessage({ ok: false, code: "RATE_LIMITED", retry_after }, name);
    expect(msg(59)).toBe("下單次數太頻繁,請 1 分鐘後再試。");
    expect(msg(61)).toBe("下單次數太頻繁,請 2 分鐘後再試。");
    expect(msg(7140)).toBe("下單次數太頻繁,請 119 分鐘後再試。");
    expect(msg(7200)).toBe("下單次數太頻繁,請 2 小時後再試。");
    expect(msg(30590)).toBe("下單次數太頻繁,請 9 小時後再試。");
  });

  it("其餘代碼各一句(店名照順序接起來)", () => {
    const msg = (r: Extract<PlaceOrderResult, { ok: false }>) => checkoutErrorMessage(r, name);
    expect(msg({ ok: false, code: "DAILY_CAP", retry_after: 3600 })).toBe("今天的訂單量已達上限,請明天再試。");
    expect(msg({ ok: false, code: "EMPTY_CART" })).toBe("購物車是空的。");
    expect(msg({ ok: false, code: "TOO_MANY_ITEMS" })).toBe("一次最多結帳 50 種商品。");
    expect(msg({ ok: false, code: "TOO_MANY_STORES" })).toBe("一次最多結帳 10 家店,請分次結帳。");
    expect(msg({ ok: false, code: "ORDER_TOO_LARGE", stores: [{ supplier_id: SUPPLIER_A }] })).toBe(
      "A 店 這張訂單超過 NT$1,000,000,請減少數量或分開下單。",
    );
    expect(msg({ ok: false, code: "PRODUCT_UNAVAILABLE", products: [CABBAGE.id] })).toBe("有商品剛剛下架了,請回購物車移除後再結帳。");
    expect(msg({ ok: false, code: "OUT_OF_STOCK", products: [{ product_id: SALMON.id, available: 1 }] })).toBe(
      "有商品庫存不足,已更新成最新庫存,請調整數量後再送出。",
    );
    expect(msg({ ok: false, code: "PAYMENT_NOT_ACCEPTED", stores: [SUPPLIER_A, SUPPLIER_B] })).toBe("A 店、B 店 不接受你選的付款方式,請重新選擇。");
    expect(msg({ ok: false, code: "INVALID_INPUT", field: "terms_version" })).toBe("有欄位格式不對,請檢查後再送出。");
  });

  it("下單 RPC 回的每一種代碼都有自己的一句話,不會掉到「下單失敗,請稍後再試。」", () => {
    // migration 130200 從 market_rate_take(RATE_LIMITED / DAILY_CAP)到 market_place_order 結束;
    // 後面的 market_get_orders(查單)另有 NOT_FOUND,由查單頁處理,不算在這裡
    const start = CHECKOUT_MIGRATION.indexOf("FUNCTION public.market_rate_take(");
    const end = CHECKOUT_MIGRATION.indexOf("FUNCTION public.market_checkout_status(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const codes = [...new Set([...CHECKOUT_MIGRATION.slice(start, end).matchAll(/'code', '([A-Z_]+)'/g)].map((m) => m[1]))];
    expect(codes.length).toBeGreaterThanOrEqual(13);
    const fallback = checkoutErrorMessage({ ok: false, code: "SOMETHING_NEW" }, name);
    const messages = codes.map((code) => checkoutErrorMessage({ ok: false, code, stores: [SUPPLIER_A] }, name));
    messages.forEach((m, i) => expect(m, codes[i]).not.toBe(fallback));
    expect(new Set(messages).size).toBe(codes.length);
  });
});
