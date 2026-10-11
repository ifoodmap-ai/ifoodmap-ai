// 零售訂單的測試假資料(只給 *.test.tsx 用,正式程式不會 import)。
import type { MarketOrderRow } from "./orders";
import { SUPPLIER_A } from "./testFixtures";

let seq = 0;
export const makeOrder = (over: Partial<MarketOrderRow> = {}): MarketOrderRow => {
  seq += 1;
  return {
    id: `a9600000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    checkout_id: "a9500000-0000-4000-8000-000000000001",
    supplier_id: SUPPLIER_A,
    status: "pending",
    buyer_name: "王小明",
    buyer_phone: "0912345678",
    buyer_email: "buyer@example.com",
    ship_city: "臺北市",
    ship_address: "測試路 1 號 2 樓",
    buyer_note: null,
    subtotal: 650,
    shipping_fee: 120,
    total: 770,
    payment_method: "cod",
    status_note: null,
    shipped_carrier: null,
    shipped_tracking_no: null,
    created_at: "2026-10-09T04:05:00Z",
    updated_at: "2026-10-09T04:05:00Z",
    market_order_items: [
      { product_name: "有機高麗菜", spec: "1 顆", temperature: "chilled", unit_price: 100, qty: 2, line_total: 200 },
      { product_name: "牛肉片", spec: "300g/盒", temperature: "frozen", unit_price: 450, qty: 1, line_total: 450 },
    ],
    ...over,
  };
};
