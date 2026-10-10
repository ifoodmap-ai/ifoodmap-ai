// 供應商「零售市集 › 店家設定」的表單邏輯:資料列 ↔ 表單、驗證(跟資料庫 CHECK 同樣的上限)、儲存。
//
// 儲存順序:勾了銀行轉帳 → 先 upsert market_store_transfer,再 upsert market_stores
// (資料庫的 market_stores_guard 會檢查「接受轉帳一定要已經有轉帳資訊」,所以轉帳資訊要先存)。
import { isTwCity, LIMITS, type PaymentMethod, type TwCity } from "./constants";
import { marketDb, unwrap } from "./db";
import type { MarketStoreRow } from "./types";

export interface StoreForm {
  intro: string;
  returnPolicy: string;
  deliveryCities: TwCity[];
  shippingFee: string;
  freeShippingThreshold: string;
  minOrderAmount: string;
  shipDays: string;
  acceptCod: boolean;
  acceptTransfer: boolean;
  transferInfo: string;
  logoPath: string | null;
  coverPath: string | null;
}

export type StoreFormErrors = Partial<Record<keyof StoreForm, string>>;

export const emptyStoreForm = (): StoreForm => ({
  intro: "",
  returnPolicy: "",
  deliveryCities: [],
  shippingFee: "0",
  freeShippingThreshold: "",
  minOrderAmount: "0",
  shipDays: "3",
  acceptCod: true,
  acceptTransfer: false,
  transferInfo: "",
  logoPath: null,
  coverPath: null,
});

export const storeFormFromRow = (row: MarketStoreRow, transferInfo: string | null): StoreForm => ({
  intro: row.intro ?? "",
  returnPolicy: row.return_policy ?? "",
  deliveryCities: row.delivery_cities.filter(isTwCity),
  shippingFee: String(row.shipping_fee),
  freeShippingThreshold: row.free_shipping_threshold == null ? "" : String(row.free_shipping_threshold),
  minOrderAmount: String(row.min_order_amount),
  shipDays: String(row.ship_days),
  acceptCod: row.payment_methods.includes("cod"),
  acceptTransfer: row.payment_methods.includes("transfer"),
  transferInfo: transferInfo ?? "",
  logoPath: row.logo_path,
  coverPath: row.cover_path,
});

/** 只接受純數字的整數字串 */
const toInt = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);
const inRange = (s: string, min: number, max: number) => {
  const n = toInt(s);
  return Number.isInteger(n) && n >= min && n <= max;
};

export const validateStoreForm = (f: StoreForm): StoreFormErrors => {
  const e: StoreFormErrors = {};
  if (f.deliveryCities.length === 0) e.deliveryCities = "至少選一個配送縣市";
  if (!inRange(f.shippingFee, 0, LIMITS.shippingFee)) e.shippingFee = `運費要是 0 到 ${LIMITS.shippingFee.toLocaleString("zh-TW")} 的整數`;
  if (f.freeShippingThreshold.trim() && !inRange(f.freeShippingThreshold, 1, LIMITS.freeShippingThreshold)) {
    e.freeShippingThreshold = "免運門檻要是大於 0 的整數(不提供免運就留白)";
  }
  if (!inRange(f.minOrderAmount, 0, LIMITS.minOrderAmount)) e.minOrderAmount = "最低訂購金額要是 0 以上的整數(沒有就填 0)";
  if (!inRange(f.shipDays, 0, LIMITS.shipDays)) e.shipDays = `出貨天數要是 0 到 ${LIMITS.shipDays} 的整數`;
  if (!f.acceptCod && !f.acceptTransfer) e.acceptCod = "至少接受一種付款方式";
  if (f.acceptTransfer) {
    const len = f.transferInfo.trim().length;
    if (len < LIMITS.transferInfoMin || len > LIMITS.transferInfo) {
      e.transferInfo = `接受銀行轉帳要填轉帳資訊(${LIMITS.transferInfoMin}–${LIMITS.transferInfo} 字:銀行、分行、帳號、戶名)`;
    }
  }
  if (f.intro.length > LIMITS.storeIntro) e.intro = `店家介紹最多 ${LIMITS.storeIntro} 字`;
  if (f.returnPolicy.length > LIMITS.returnPolicy) e.returnPolicy = `退換貨說明最多 ${LIMITS.returnPolicy} 字`;
  return e;
};

export const storePayload = (supplierId: string, f: StoreForm) => {
  const methods: PaymentMethod[] = [];
  if (f.acceptCod) methods.push("cod");
  if (f.acceptTransfer) methods.push("transfer");
  return {
    supplier_id: supplierId,
    intro: f.intro.trim() || null,
    return_policy: f.returnPolicy.trim() || null,
    delivery_cities: f.deliveryCities,
    shipping_fee: toInt(f.shippingFee),
    free_shipping_threshold: f.freeShippingThreshold.trim() ? toInt(f.freeShippingThreshold) : null,
    min_order_amount: toInt(f.minOrderAmount),
    ship_days: toInt(f.shipDays),
    payment_methods: methods,
    logo_path: f.logoPath,
    cover_path: f.coverPath,
  };
};

export const STORE_OWNER_COLUMNS =
  "supplier_id, is_enabled, disabled_reason, logo_path, cover_path, intro, return_policy, delivery_cities, shipping_fee, " +
  "free_shipping_threshold, min_order_amount, ship_days, payment_methods, updated_at";

export const fetchOwnStore = async (supplierId: string): Promise<{ store: MarketStoreRow | null; transferInfo: string | null }> => {
  const store = unwrap(
    await marketDb<MarketStoreRow>("market_stores").select(STORE_OWNER_COLUMNS).eq("supplier_id", supplierId).maybeSingle(),
  );
  const transfer = unwrap(
    await marketDb<{ transfer_info: string }>("market_store_transfer").select("transfer_info").eq("supplier_id", supplierId).maybeSingle(),
  );
  return { store, transferInfo: transfer?.transfer_info ?? null };
};

export const saveStore = async (supplierId: string, f: StoreForm): Promise<MarketStoreRow> => {
  if (f.acceptTransfer) {
    unwrap(
      await marketDb("market_store_transfer").upsert(
        { supplier_id: supplierId, transfer_info: f.transferInfo.trim() },
        { onConflict: "supplier_id" },
      ),
    );
  }
  return unwrap(
    await marketDb<MarketStoreRow>("market_stores")
      .upsert(storePayload(supplierId, f), { onConflict: "supplier_id" })
      .select(STORE_OWNER_COLUMNS)
      .single(),
  );
};
