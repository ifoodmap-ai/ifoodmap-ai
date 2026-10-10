// 供應商「零售市集 › 店家設定」的表單邏輯:資料列 ↔ 表單、驗證(跟資料庫 CHECK 同樣的上限)、儲存。
//
// 儲存順序(轉帳資訊與店家是兩張表、兩個請求,順序要讓「只存好一半」越少越好):
//   1. 第一次接受轉帳(資料庫還沒有轉帳資訊):market_stores_guard 要求勾轉帳前已經有轉帳資訊,只能先寫;
//      用 insert —— 別的分頁先存了 → 23505 → MarketStaleError,不覆寫。
//   2. 店家(更新時比對 updated_at,見下)。
//   3. 已經有轉帳資訊而且改了:店家存好之後才更新(店家過期或驗證失敗就什麼都不寫)。
//   真的只存好一部分 → MarketPartialSaveError,訊息講清楚哪一部分存好、帶著已經存進資料庫的值。
//
// 不蓋掉別人的修改:更新既有店家時只更新 updated_at 還是「讀到的那個值」的列(兩個分頁、兩位同事同時改,
// 後存的人更新不到任何一列 → MarketStaleError,什麼都不覆寫)。updated_at 一定用讀到的原字串比對:
// PostgREST 回的是微秒精度,轉成 Date 再轉回字串會掉到毫秒,就永遠對不上。第一次建立店家沒有值可比對,用 insert
// (別的分頁先建好了 → 23505 → 一樣是 MarketStaleError,不會用 upsert 把它蓋掉)。
import { isTwCity, LIMITS, type PaymentMethod, type TwCity } from "./constants";
import { friendlyDbError, MarketDbError, marketDb, unwrap } from "./db";
import type { MarketStoreRow } from "./types";

export const STALE_STORE_MESSAGE = "資料已被其他人更新,請重新載入後再改";

/** 資料已被其他人更新(另一個分頁、另一位同事):這次沒有覆寫任何東西 */
export class MarketStaleError extends Error {
  constructor() {
    super(STALE_STORE_MESSAGE);
    this.name = "MarketStaleError";
  }
}

/** 只存好一部分:saved 是已經寫進資料庫的那一部分,store / transferInfo 是它在資料庫裡現在的值 */
export class MarketPartialSaveError extends Error {
  readonly saved: "store" | "transfer";
  /** saved = "store":資料庫回傳的店家(updated_at 已經是新的) */
  readonly store: MarketStoreRow | null;
  /** saved = "transfer":資料庫裡現在的轉帳資訊 */
  readonly transferInfo: string | null;
  /** 沒存到的那一部分的錯誤 */
  readonly failure: unknown;
  constructor(saved: "store" | "transfer", store: MarketStoreRow | null, transferInfo: string | null, failure: unknown) {
    const reason = friendlyDbError(failure);
    super(
      saved === "store"
        ? `店家設定已儲存,但轉帳資訊沒有存到:${reason}。消費者看到的仍是原本的轉帳資訊,請再按一次儲存。`
        : `轉帳資訊已儲存,但店家設定(配送、付款等)沒有存到:${reason}`,
    );
    this.name = "MarketPartialSaveError";
    this.saved = saved;
    this.store = store;
    this.transferInfo = transferInfo;
    this.failure = failure;
  }
}

/** 頁面讀到的資料庫狀態,儲存時拿來比對 */
export interface StoreBase {
  /** 讀到的 market_stores.updated_at 原字串;還沒建店是 null */
  updatedAt: string | null;
  /** 資料庫裡目前的轉帳資訊;沒有是 null */
  transferInfo: string | null;
}

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

const isUniqueViolation = (e: unknown) => e instanceof MarketDbError && e.code === "23505";

/** 寫店家:第一次建立用 insert;更新時比對讀到的 updated_at,沒有更新到任何一列就是資料已被其他人更新 */
const writeStore = async (supplierId: string, f: StoreForm, updatedAt: string | null): Promise<MarketStoreRow> => {
  const payload = storePayload(supplierId, f);
  if (updatedAt === null) {
    try {
      return unwrap(await marketDb<MarketStoreRow>("market_stores").insert(payload).select(STORE_OWNER_COLUMNS).single());
    } catch (e) {
      if (isUniqueViolation(e)) throw new MarketStaleError();
      throw e;
    }
  }
  const rows = unwrap(
    await marketDb<MarketStoreRow[]>("market_stores")
      .update(payload)
      .eq("supplier_id", supplierId)
      .eq("updated_at", updatedAt)
      .select(STORE_OWNER_COLUMNS),
  );
  if (!Array.isArray(rows) || rows.length === 0) throw new MarketStaleError();
  return rows[0];
};

/** 第一次存轉帳資訊:insert(別的分頁先存了 → 23505 → 過期,不覆寫) */
const insertTransfer = async (supplierId: string, info: string) => {
  try {
    unwrap(await marketDb("market_store_transfer").insert({ supplier_id: supplierId, transfer_info: info }));
  } catch (e) {
    if (isUniqueViolation(e)) throw new MarketStaleError();
    throw e;
  }
};

const upsertTransfer = async (supplierId: string, info: string) => {
  unwrap(await marketDb("market_store_transfer").upsert({ supplier_id: supplierId, transfer_info: info }, { onConflict: "supplier_id" }));
};

export const saveStore = async (supplierId: string, f: StoreForm, base: StoreBase): Promise<MarketStoreRow> => {
  const info = f.transferInfo.trim();
  const transferFirst = f.acceptTransfer && base.transferInfo === null;
  if (transferFirst) await insertTransfer(supplierId, info);

  let store: MarketStoreRow;
  try {
    store = await writeStore(supplierId, f, base.updatedAt);
  } catch (e) {
    if (transferFirst) throw new MarketPartialSaveError("transfer", null, info, e);
    throw e;
  }

  if (f.acceptTransfer && !transferFirst && info !== base.transferInfo) {
    try {
      await upsertTransfer(supplierId, info);
    } catch (e) {
      throw new MarketPartialSaveError("store", store, null, e);
    }
  }
  return store;
};
