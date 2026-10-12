// 零售市集的資料存取入口:所有 market_* 表、RPC、Storage 都經過這裡。
//
// market_* 表不在自動產生的 src/integrations/supabase/types.ts 裡 —— 沿用專案的 loose cast 慣例
// (src/pages/SupplierDetail.tsx 的 db()、src/lib/portal.ts 的 fetchAccounts),只描述用得到的 builder,不用 any。
// PostgREST 的 builder 是 thenable、沒有 .catch():一律 await 之後用 unwrap() 收錯。
import { supabase } from "@/integrations/supabase/client";
import { MARKET_IMAGE_BUCKET } from "./constants";

export type PgError = { message: string; code?: string | null; hint?: string | null; details?: string | null } | null;
export type PgResult<T> = { data: T | null; error: PgError };

export interface MarketQuery<T> extends PromiseLike<PgResult<T>> {
  select(columns?: string): MarketQuery<T>;
  insert(values: unknown): MarketQuery<T>;
  update(values: unknown): MarketQuery<T>;
  upsert(values: unknown, options?: { onConflict?: string }): MarketQuery<T>;
  delete(): MarketQuery<T>;
  eq(column: string, value: unknown): MarketQuery<T>;
  in(column: string, values: readonly unknown[]): MarketQuery<T>;
  order(column: string, options: { ascending: boolean }): MarketQuery<T>;
  limit(count: number): MarketQuery<T>;
  maybeSingle(): PromiseLike<PgResult<T>>;
  single(): PromiseLike<PgResult<T>>;
}

export const marketDb = <T>(table: string): MarketQuery<T> =>
  (supabase as never as { from: (t: string) => MarketQuery<T> }).from(table);

/** 資料庫擋下來的錯誤:hint 是 migration 裡 RAISE 的 snake_case 原因(見 friendlyDbError) */
export class MarketDbError extends Error {
  readonly code: string | null;
  readonly hint: string | null;
  constructor(error: NonNullable<PgError>) {
    super(error.message || "資料庫錯誤");
    this.name = "MarketDbError";
    this.code = error.code ?? null;
    this.hint = error.hint ?? null;
  }
}

export const unwrap = <T>(res: PgResult<T>): T => {
  if (res.error) throw new MarketDbError(res.error);
  return res.data as T;
};

export const marketRpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
  unwrap(
    await (supabase as never as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<PgResult<T>> }).rpc(
      fn,
      args,
    ),
  );

export interface StorageBucket {
  upload(
    path: string,
    body: Blob,
    options: { contentType: string; cacheControl: string; upsert: boolean },
  ): PromiseLike<{ data: unknown; error: { message: string; status?: number | string; statusCode?: number | string } | null }>;
}

export const marketStorage = (): StorageBucket =>
  (supabase as never as { storage: { from: (bucket: string) => StorageBucket } }).storage.from(MARKET_IMAGE_BUCKET);

/** migration 裡 RAISE 的 HINT → 給使用者看的中文 */
const HINT_MESSAGES: Record<string, string> = {
  transfer_info_required: "接受銀行轉帳要先填寫轉帳資訊",
  invalid_image_path: "圖片路徑不正確,請重新上傳",
  invalid_photo_path: "商品照片路徑不正確,請重新上傳",
  review_status_forbidden: "商品要經過管理員審核才能上架",
  supply_not_owned: "對應的批發商品不是你家的",
  reject_reason_required: "退回或下架要填寫原因",
  disabled_reason_required: "停用店家零售要填寫原因",
  supplier_immutable: "不能更改所屬的店家",
  stale_order_status: "這張訂單剛被處理過,畫面已重新整理,請再確認一次",
  transition_not_allowed: "這張訂單目前不能做這個動作",
  reason_required: "請填寫原因(會告知消費者)",
  carrier_required: "請填寫物流",
  tracking_too_long: "物流單號太長了",
  not_order_party: "這張訂單不是你家的",
  one_event_per_order: "請一步一步操作",
  photos_not_uploaded: "這個商品還有照片沒有上傳完成,無法核准",
  // migration 20261012110000_market_compliance:開放中(或剛建立)的店家缺法定資訊、供應商資料沒有電話
  store_disclosure_missing: "開放零售前要填齊店家法定資訊:登記名稱、負責人、營業所地址、客服 Email,以及供應商資料的電話",
};

/** fetch 本身失敗(斷網、連不到伺服器)時各瀏覽器的訊息:Chrome / Safari / Firefox / React Native、Node */
const NETWORK_ERROR_RE = /Failed to fetch|Load failed|NetworkError|Network request failed|fetch failed/i;
const NETWORK_ERROR_MESSAGE = "連線失敗,請檢查網路後再試一次";

/**
 * 錯誤 → 給使用者看的中文。
 * fallback(選填):認不得的資料庫錯誤、非預期的例外不顯示英文原文,改顯示這句(資料庫錯誤附上錯誤代碼給客服查)。
 * 市集自己丟的錯(名稱 Market 開頭:MarketImageError、MarketStaleError…)訊息本來就是中文,照原訊息。
 * 沒給 fallback 時行為跟原本一樣(認不得的照原文)。
 */
export const friendlyDbError = (e: unknown, fallback?: string): string => {
  if (e instanceof MarketDbError) {
    // 只認表裡自己的 key:用 HINT_MESSAGES[hint] 判斷的話,"constructor" 這類 hint 會拿到 Object 原型上的函式。
    // (tsconfig 的 lib 是 ES2020,沒有 Object.hasOwn 的型別,所以用 hasOwnProperty.call,效果相同)
    if (e.hint && Object.prototype.hasOwnProperty.call(HINT_MESSAGES, e.hint)) return HINT_MESSAGES[e.hint];
    if (e.code === "23503") return "請先完成「零售市集 › 店家設定」再新增零售商品";
    if (e.code === "23514") return "有欄位超過長度上限或格式不對,請檢查後再送出";
    if (e.code === "42501") return "沒有權限做這個動作";
    // supabase-js 斷網時回 { message: "TypeError: Failed to fetch", hint: "", code: "" }(資料庫沒有回應,所以沒有 code)
    if (!e.hint && !e.code && NETWORK_ERROR_RE.test(e.message)) return NETWORK_ERROR_MESSAGE;
    if (fallback) return e.code ? `${fallback}(錯誤代碼 ${e.code})` : fallback;
    return e.message;
  }
  if (e instanceof TypeError && NETWORK_ERROR_RE.test(e.message)) return NETWORK_ERROR_MESSAGE;
  if (e instanceof Error && e.name.startsWith("Market")) return e.message;
  if (fallback) return fallback;
  return e instanceof Error ? e.message : String(e);
};

/**
 * Storage 上傳的錯誤 → 中文。storage-js 的 StorageApiError 帶 HTTP status 與伺服器的 statusCode
 * (RLS 擋下是 HTTP 400 + statusCode "403"),斷網是 StorageUnknownError("Failed to fetch")。
 */
export const friendlyStorageError = (err: { message?: string; status?: number | string; statusCode?: number | string }): string => {
  const msg = err?.message ?? "";
  const codes = [err?.status, err?.statusCode].map((c) => Number(c));
  if (NETWORK_ERROR_RE.test(msg)) return NETWORK_ERROR_MESSAGE;
  if (codes.includes(401) || codes.includes(403) || /row-level security|unauthorized|not authorized|permission/i.test(msg)) {
    return "沒有權限上傳到這個店家的資料夾,請重新登入後再試";
  }
  if (codes.includes(409) || /already exists|duplicate/i.test(msg)) return "同名的檔案已經存在,請重新選一次照片";
  if (codes.includes(413) || /maximum allowed size|too large/i.test(msg)) return "照片超過 2 MB,請換一張或先縮小再上傳";
  if (codes.includes(415) || /mime type/i.test(msg)) return "只收 JPG、PNG、WebP 照片";
  return "伺服器暫時無法處理,請稍後再試";
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** 瀏覽器產生 uuid(新商品先決定 id,照片才能先上傳到 <supplier>/<商品 id>/) */
export const newUuid = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
