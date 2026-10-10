// 供應商零售商品的表單邏輯:資料列 ↔ 表單、驗證(跟資料庫 CHECK 一樣的上限)、儲存、各審核狀態下有哪些按鈕。
//
// 審核狀態由資料庫決定(market_products_guard):這裡只在「送出審核 / 重新送審」時把 review_status 設成 pending;
// 一般儲存不送 review_status —— 已核准的商品改了內容,資料庫會自己改回 pending。
//
// 修改既有商品用樂觀鎖:多比對畫面讀到的 updated_at(原字串,不經過 Date —— JavaScript 的 Date 只到毫秒,
// 資料庫是微秒,轉過就永遠比不到);沒有更新到任何一列 = 別人(管理員、另一個分頁)先改過 → StaleProductError,不覆寫。
// 新商品重送:第一次其實存好了、只是回應在路上遺失,再按一次會撞主鍵 23505 → 讀回那一筆,是自家的就當作已經存好。
import {
  CATEGORY_LABEL,
  isCategoryKey,
  LIMITS,
  PHOTO_RULES,
  type MarketCategoryKey,
  type ReviewStatus,
  type Temperature,
} from "./constants";
import { MarketDbError, marketDb, unwrap } from "./db";
import type { MarketProductRow } from "./types";

/**
 * 「看不見」的字元:跟 migration 120000 的 market_visible 同一組(productForm.test.ts 逐字比對)——
 * 空白、控制字元(Cc)、格式字元(Cf)、Default_Ignorable 與看起來空白的字元(韓文填充字、點字空白、異體字選擇符…)。
 * 寫成 RegExp u 旗標的字元類(一律 \u{十六進位});只用來判斷「是不是空的」,不改內容(emoji 的 U+FE0F 照樣保留)。
 */
export const INVISIBLE_CHARS =
  "\\s\\u{1}-\\u{1f}\\u{7f}-\\u{a0}\\u{ad}\\u{34f}\\u{600}-\\u{605}\\u{61c}\\u{6dd}\\u{70f}\\u{890}\\u{891}\\u{8e2}\\u{115f}\\u{1160}\\u{1680}\\u{17b4}\\u{17b5}\\u{180b}-\\u{180f}\\u{2000}-\\u{200f}\\u{2028}-\\u{202f}\\u{205f}-\\u{206f}\\u{2800}\\u{3000}\\u{3164}\\u{fe00}-\\u{fe0f}\\u{feff}\\u{ffa0}\\u{fff0}-\\u{fffb}\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}";
// 字元類裡的組合字元(U+034F)、異體字選擇符(U+FE00–U+FE0F)等都是刻意逐一列出的單一碼位(u 旗標逐碼位比對),
// 不是「看起來一個字、其實兩個碼位」的誤寫 —— no-misleading-character-class 在這裡是誤判。
// eslint-disable-next-line no-misleading-character-class
const VISIBLE_CHAR = new RegExp(`[^${INVISIBLE_CHARS}]`, "u");

/** 至少有一個看得見的字。資料庫把只有看不見字元的品名、規格當成空字串(被 CHECK 擋成 23514),前端先擋、顯示「請填…」 */
export const hasVisibleText = (s: string): boolean => VISIBLE_CHAR.test(s);

export interface ProductForm {
  name: string;
  category: MarketCategoryKey | "";
  spec: string;
  price: string;
  unlimitedStock: boolean;
  stock: string;
  temperature: Temperature;
  origin: string;
  storageMethod: string;
  shelfLife: string;
  description: string;
  photos: string[];
  isListed: boolean;
  supplyId: string | null;
}

export type ProductFormErrors = Partial<Record<keyof ProductForm, string>>;

/** 從 B2B 商品(supplies)帶入時用得到的欄位 */
export interface SupplySeed {
  id: string;
  name: string;
  category: string | null;
  pack_size: string | null;
  price: number | null;
  description: string | null;
}

/** B2B 的分類是自由文字;剛好等於 12 類的中文名稱(或 key)才帶入 */
const categoryFromText = (text: string | null): MarketCategoryKey | "" => {
  if (!text) return "";
  const t = text.trim();
  if (isCategoryKey(t)) return t;
  const hit = (Object.entries(CATEGORY_LABEL) as Array<[MarketCategoryKey, string]>).find(([, label]) => label === t);
  return hit ? hit[0] : "";
};

export const emptyProductForm = (seed?: SupplySeed | null): ProductForm => ({
  name: seed?.name ?? "",
  category: categoryFromText(seed?.category ?? null),
  spec: seed?.pack_size ?? "",
  price: "",
  unlimitedStock: true,
  stock: "",
  temperature: "ambient",
  origin: "",
  storageMethod: "",
  shelfLife: "",
  description: seed?.description ?? "",
  photos: [],
  isListed: true,
  supplyId: seed?.id ?? null,
});

export const productFormFromRow = (row: MarketProductRow): ProductForm => ({
  name: row.name,
  category: row.category,
  spec: row.spec,
  price: String(row.price),
  unlimitedStock: row.stock === null,
  stock: row.stock === null ? "" : String(row.stock),
  temperature: row.temperature,
  origin: row.origin ?? "",
  storageMethod: row.storage_method ?? "",
  shelfLife: row.shelf_life ?? "",
  description: row.description ?? "",
  photos: [...row.photos],
  isListed: row.is_listed,
  supplyId: row.supply_id ?? null,
});

const toInt = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);

export const validateProductForm = (f: ProductForm): ProductFormErrors => {
  const e: ProductFormErrors = {};
  const name = f.name.trim();
  if (!hasVisibleText(name)) e.name = "請填品名";
  else if (name.length > LIMITS.productName) e.name = `品名最多 ${LIMITS.productName} 字`;
  if (!f.category) e.category = "請選分類";
  const spec = f.spec.trim();
  if (!hasVisibleText(spec)) e.spec = "請填零售規格,例如:600g/盒";
  else if (spec.length > LIMITS.spec) e.spec = `規格最多 ${LIMITS.spec} 字`;
  const price = toInt(f.price);
  if (!Number.isInteger(price) || price < 1 || price > LIMITS.price) e.price = "價格要是 1 到 1,000,000 的整數(新台幣)";
  if (!f.unlimitedStock) {
    const stock = toInt(f.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > LIMITS.stock) e.stock = "庫存要是 0 到 100,000 的整數(不限庫存請勾選「不限」)";
  }
  if (f.origin.trim().length > LIMITS.origin) e.origin = `產地最多 ${LIMITS.origin} 字`;
  if (f.storageMethod.trim().length > LIMITS.storageMethod) e.storageMethod = `保存方式最多 ${LIMITS.storageMethod} 字`;
  if (f.shelfLife.trim().length > LIMITS.shelfLife) e.shelfLife = `保存期限最多 ${LIMITS.shelfLife} 字`;
  if (f.description.trim().length > LIMITS.description) e.description = `說明最多 ${LIMITS.description} 字`;
  if (f.photos.length > PHOTO_RULES.maxCount) e.photos = `照片最多 ${PHOTO_RULES.maxCount} 張`;
  return e;
};

export const productPayload = (f: ProductForm) => ({
  name: f.name.trim(),
  category: f.category,
  spec: f.spec.trim(),
  price: toInt(f.price),
  stock: f.unlimitedStock ? null : toInt(f.stock),
  temperature: f.temperature,
  origin: f.origin.trim() || null,
  storage_method: f.storageMethod.trim() || null,
  shelf_life: f.shelfLife.trim() || null,
  description: f.description.trim() || null,
  photos: f.photos,
  is_listed: f.isListed,
  supply_id: f.supplyId,
});

export interface SaveProductInput {
  supplierId: string;
  productId: string;
  isNew: boolean;
  form: ProductForm;
  /** true = 送出審核 / 重新送審(review_status → pending) */
  submit: boolean;
  /** 修改既有商品:畫面讀到的 updated_at 原字串(樂觀鎖);新商品不用 */
  expectedUpdatedAt?: string | null;
}

export interface SaveProductResult {
  row: MarketProductRow;
  /** true = 新商品重按時資料庫已經有自家的這一筆(上一次其實存好了),畫面提示「已儲存」 */
  alreadySaved: boolean;
}

/** 修改時沒有更新到任何一列:畫面上那一筆已經不是最新的 */
export class StaleProductError extends Error {
  constructor() {
    super("這個商品已被其他人更新,請重新載入後再改");
    this.name = "StaleProductError";
  }
}

export const saveMarketProduct = async ({
  supplierId,
  productId,
  isNew,
  form,
  submit,
  expectedUpdatedAt,
}: SaveProductInput): Promise<SaveProductResult> => {
  const fields = productPayload(form);
  if (isNew) {
    try {
      const row = unwrap(
        await marketDb<MarketProductRow>("market_products")
          .insert({ id: productId, supplier_id: supplierId, ...fields, review_status: submit ? "pending" : "draft" })
          .select("*")
          .single(),
      );
      return { row, alreadySaved: false };
    } catch (e) {
      if (!(e instanceof MarketDbError) || e.code !== "23505") throw e;
      // 主鍵已經有了:讀回來看是不是自家的(別家的 RLS 讀不到 → null)。不是就報錯,絕不拿這次的內容去覆寫。
      const existing = unwrap(await marketDb<MarketProductRow>("market_products").select("*").eq("id", productId).maybeSingle());
      if (existing && existing.supplier_id === supplierId) return { row: existing, alreadySaved: true };
      throw new Error("這個商品編號已經被使用,請關閉視窗後重新新增");
    }
  }
  // 沒有讀到的 updated_at 就沒辦法確認畫面上是不是最新的:不送
  if (!expectedUpdatedAt) throw new StaleProductError();
  const row = unwrap(
    await marketDb<MarketProductRow>("market_products")
      .update(submit ? { ...fields, review_status: "pending" } : fields)
      .eq("id", productId)
      .eq("updated_at", expectedUpdatedAt)
      .select("*")
      .maybeSingle(),
  );
  if (!row) throw new StaleProductError();
  return { row, alreadySaved: false };
};

export interface ProductActions {
  /** 次要按鈕(不送審) */
  secondary: { label: string; submit: false } | null;
  primary: { label: string; submit: boolean };
  /** 顯示在按鈕上方的提醒 */
  notice: string | null;
}

/** 各審核狀態下的按鈕(null = 新商品) */
export const productActions = (status: ReviewStatus | null): ProductActions => {
  switch (status) {
    case "pending":
      return { secondary: null, primary: { label: "儲存", submit: false }, notice: "審核中:管理員核准後才會出現在市集。" };
    case "approved":
      return {
        secondary: null,
        primary: { label: "儲存", submit: false },
        notice: "修改品名、分類、規格、溫層、產地、保存方式、保存期限、說明或照片後會重新送審(審核通過前消費者看不到);只改價格、庫存、上架開關不用重審。",
      };
    case "rejected":
      return { secondary: { label: "儲存(先不送審)", submit: false }, primary: { label: "重新送審", submit: true }, notice: null };
    default:
      return { secondary: { label: "儲存草稿", submit: false }, primary: { label: "送出審核", submit: true }, notice: null };
  }
};
