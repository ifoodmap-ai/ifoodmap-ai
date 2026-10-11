// 市集測試共用的假資料(只給 *.test.ts(x) 用,正式程式不會 import)。
// 金額刻意跟資料庫測試同一組:A 店運費 120、滿 1000 免運、最低 300;B 店運費 60、沒有免運、沒有最低金額。
import type { MarketProductRow, MarketStoreRow } from "./types";

export const SUPPLIER_A = "a9200000-0000-4000-8000-00000000000a";
export const SUPPLIER_B = "a9200000-0000-4000-8000-00000000000b";

export const STORE_A: MarketStoreRow = {
  supplier_id: SUPPLIER_A,
  is_enabled: true,
  logo_path: null,
  cover_path: null,
  intro: "當日採收的葉菜與根莖類",
  return_policy: "生鮮食品收到後 24 小時內有問題請拍照聯絡我們",
  delivery_cities: ["臺北市", "新北市"],
  shipping_fee: 120,
  free_shipping_threshold: 1000,
  min_order_amount: 300,
  ship_days: 2,
  payment_methods: ["cod", "transfer"],
  suppliers: { name: "市集測試 A 店", phone: "02-2345-6789", contact_email: "store-a@market-test.invalid", is_active: true },
};

export const STORE_B: MarketStoreRow = {
  supplier_id: SUPPLIER_B,
  is_enabled: true,
  logo_path: null,
  cover_path: null,
  intro: null,
  return_policy: null,
  delivery_cities: ["臺北市"],
  shipping_fee: 60,
  free_shipping_threshold: null,
  min_order_amount: 0,
  ship_days: 1,
  payment_methods: ["cod"],
  suppliers: { name: "市集測試 B 店", phone: null, contact_email: "store-b@market-test.invalid", is_active: true },
};

let seq = 0;
export const makeProduct = (over: Partial<MarketProductRow> = {}): MarketProductRow => {
  seq += 1;
  return {
    id: `a9300000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    supplier_id: SUPPLIER_A,
    name: `測試商品 ${seq}`,
    category: "vegetable",
    spec: "1 包",
    price: 100,
    stock: null,
    temperature: "ambient",
    origin: null,
    storage_method: null,
    shelf_life: null,
    description: null,
    photos: [],
    review_status: "approved",
    is_listed: true,
    created_at: "2026-10-09T02:00:00Z",
    market_stores: STORE_A,
    ...over,
  };
};

/** A 店:高麗菜 100(庫存 10)、牛肉片 450(不限);B 店:鮭魚 200(庫存 3,冷凍) */
export const CABBAGE = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000a1",
  name: "有機高麗菜",
  spec: "1 顆(約 1.2 公斤)",
  price: 100,
  stock: 10,
  temperature: "chilled",
  origin: "宜蘭三星",
});
export const BEEF = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000a2",
  name: "牛肉片",
  category: "meat",
  spec: "300g/盒",
  price: 450,
  stock: null,
  temperature: "frozen",
});
export const SALMON = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000b1",
  supplier_id: SUPPLIER_B,
  name: "挪威鮭魚",
  category: "seafood",
  spec: "200g/片",
  price: 200,
  stock: 3,
  temperature: "frozen",
  market_stores: STORE_B,
});
