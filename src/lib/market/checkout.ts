// 結帳:收件資料驗證(跟 market_place_order 同一套規則)、組送給資料庫的內容、下單、錯誤代碼 → 中文。
//
// 🔴 電話、Email 的正規表示式跟資料庫一字不差:checkout.test.ts 解析 20261009130000_market_orders.sql 的
//    @market-phone-regex / @market-email-regex 比對。長度上限在 constants.ts 的 LIMITS。
// 🔴 金額只是「預期」:expected_totals 跟資料庫算的不一樣時回 PRICE_CHANGED,不會用前端的數字建單。
import type { CartGroup } from "./cart";
import { isTwCity, LIMITS, type PaymentMethod, type TwCity } from "./constants";
import { marketRpc } from "./db";
import { hasVisibleText } from "./productForm";

export const PHONE_PATTERN = /^0[0-9]{8,9}$/;
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export interface BuyerForm {
  name: string;
  phone: string;
  email: string;
  city: TwCity | "";
  address: string;
  note: string;
}
export type BuyerErrors = Partial<Record<keyof BuyerForm, string>>;

export const emptyBuyer = (): BuyerForm => ({ name: "", phone: "", email: "", city: "", address: "", note: "" });

/** 跟資料庫一樣:拿掉空白、括號、連字號(0912-345-678 → 0912345678) */
export const normalizePhone = (s: string): string => s.replace(/[\s()-]/g, "");
export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

/** 姓名、地址用 hasVisibleText:market_place_order 用 market_visible 判斷,只有全形空白、零寬字元也算沒填 */
export const validateBuyer = (f: BuyerForm): BuyerErrors => {
  const e: BuyerErrors = {};
  const name = f.name.trim();
  if (!hasVisibleText(name)) e.name = "請填寫收件人姓名";
  else if (name.length > LIMITS.buyerName) e.name = `姓名最多 ${LIMITS.buyerName} 字`;
  if (!PHONE_PATTERN.test(normalizePhone(f.phone))) e.phone = "請填寫手機或市話,例如 0912345678 或 02-2345-6789";
  const email = normalizeEmail(f.email);
  if (!EMAIL_PATTERN.test(email) || email.length > 254) e.email = "Email 格式不對(訂單通知會寄到這裡)";
  if (!isTwCity(f.city)) e.city = "請選擇收件縣市";
  const address = f.address.trim();
  if (!hasVisibleText(address) || address.length < LIMITS.addressMin || address.length > LIMITS.address) {
    e.address = `請填寫完整的收件地址(${LIMITS.addressMin}–${LIMITS.address} 字)`;
  }
  if (f.note.trim().length > LIMITS.buyerNote) e.note = `備註最多 ${LIMITS.buyerNote} 字`;
  return e;
};

/** 預設付款方式:店家接受的第一種(貨到付款優先) */
export const defaultPayment = (methods: readonly PaymentMethod[]): PaymentMethod => (methods.includes("cod") ? "cod" : methods[0]);

export interface CheckoutPayload {
  buyer: { name: string; phone: string; email: string; city: TwCity; address: string; note?: string };
  items: Array<{ product_id: string; qty: number }>;
  payments: Record<string, PaymentMethod>;
  expected_totals: Record<string, number>;
  terms_version: string;
}

/** groups = 這次要結帳的店(都是 canCheckout 的);payments 沒選的用 defaultPayment */
export const buildCheckoutPayload = (opts: {
  buyer: BuyerForm;
  groups: CartGroup[];
  payments: Record<string, PaymentMethod>;
  termsVersion: string;
}): CheckoutPayload => {
  const note = opts.buyer.note.trim();
  return {
    buyer: {
      name: opts.buyer.name.trim(),
      phone: normalizePhone(opts.buyer.phone),
      email: normalizeEmail(opts.buyer.email),
      city: opts.buyer.city as TwCity,
      address: opts.buyer.address.trim(),
      ...(note ? { note } : {}),
    },
    items: opts.groups.flatMap((g) => g.lines.map((l) => ({ product_id: l.product.id, qty: l.qty }))),
    payments: Object.fromEntries(
      opts.groups.map((g) => [g.supplierId, opts.payments[g.supplierId] ?? defaultPayment(g.store.payment_methods)]),
    ),
    expected_totals: Object.fromEntries(opts.groups.map((g) => [g.supplierId, g.total])),
    terms_version: opts.termsVersion,
  };
};

export type PlaceOrderResult =
  | { ok: true; token: string; checkout_id: string; orders: Array<{ id: string; supplier_id: string; total: number }> }
  | {
      ok: false;
      code: string;
      field?: string;
      retry_after?: number;
      products?: unknown[];
      stores?: Array<string | { supplier_id: string }>;
    };

export const placeOrder = (payload: CheckoutPayload): Promise<PlaceOrderResult> =>
  marketRpc<PlaceOrderResult>("market_place_order", { p_checkout: payload });

/** 下單開關:open = 對外開放了沒;can_order = 你現在能不能下單(開放了,或你是平台管理員) */
export interface CheckoutStatus {
  open: boolean;
  can_order: boolean;
}
export const fetchCheckoutStatus = (): Promise<CheckoutStatus> => marketRpc<CheckoutStatus>("market_checkout_status", {});

const FIELD_MESSAGES: Record<string, string> = {
  "buyer.name": "收件人姓名格式不對",
  "buyer.phone": "電話格式不對",
  "buyer.email": "Email 格式不對",
  "buyer.city": "請選擇收件縣市",
  "buyer.address": "收件地址格式不對",
  "buyer.note": "備註太長了",
  items: "購物車內容有問題,請回購物車重新整理",
};

/** 失敗代碼 → 給消費者看的一句話;storeName 把 supplier_id 換成店名 */
export const checkoutErrorMessage = (
  r: Extract<PlaceOrderResult, { ok: false }>,
  storeName: (supplierId: string) => string,
): string => {
  const stores = (r.stores ?? []).map((s) => storeName(typeof s === "string" ? s : s.supplier_id)).join("、");
  switch (r.code) {
    case "MARKET_CLOSED":
      return "線上訂購還沒對外開放,購物車會幫你保留。";
    case "RATE_LIMITED": {
      // retry_after 是秒;每天的上限可能要等好幾個小時(「510 分鐘」不好懂),2 小時以上改用小時,一律無條件進位
      const minutes = Math.max(1, Math.ceil((r.retry_after ?? 60) / 60));
      return minutes >= 120 ? `下單次數太頻繁,請 ${Math.ceil(minutes / 60)} 小時後再試。` : `下單次數太頻繁,請 ${minutes} 分鐘後再試。`;
    }
    case "DAILY_CAP":
      return "今天的訂單量已達上限,請明天再試。";
    case "INVALID_INPUT":
      return FIELD_MESSAGES[r.field ?? ""] ?? "有欄位格式不對,請檢查後再送出。";
    case "EMPTY_CART":
      return "購物車是空的。";
    case "TOO_MANY_ITEMS":
      return "一次最多結帳 50 種商品。";
    case "TOO_MANY_STORES":
      return "一次最多結帳 10 家店,請分次結帳。";
    case "ORDER_TOO_LARGE":
      // 資料庫:任一家店「小計 + 運費」超過 1,000,000 就不建單(stores 是超過的那幾家)
      return `${stores} 這張訂單超過 NT$1,000,000,請減少數量或分開下單。`;
    case "PRODUCT_UNAVAILABLE":
      return "有商品剛剛下架了,請回購物車移除後再結帳。";
    case "OUT_OF_STOCK":
      return "有商品庫存不足,已更新成最新庫存,請調整數量後再送出。";
    case "NOT_DELIVERABLE":
      return `${stores} 不配送到你選的縣市。`;
    case "BELOW_MINIMUM":
      return `${stores} 還沒到最低訂購金額。`;
    case "PAYMENT_NOT_ACCEPTED":
      return `${stores} 不接受你選的付款方式,請重新選擇。`;
    case "PRICE_CHANGED":
      return "價格或運費剛剛有變動,畫面已更新成最新金額,請確認後再送出一次。";
    default:
      return "下單失敗,請稍後再試。";
  }
};
