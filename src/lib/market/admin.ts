// 管理後台「零售市集」的資料存取:商品審核、零售店家停用 / 恢復。全部用管理員既有的 RLS(is_admin())。
//
// 核准、退回用「樂觀鎖」:更新時多帶 updated_at = 畫面上那一筆的值。供應商在管理員看的同時改了內容
// (資料庫會把 updated_at 換掉、狀態改回 pending),這次更新就會 0 列 → 告訴管理員重新整理,
// 不會把管理員「沒看過的新內容」核准掉。下架不鎖:下架只會讓商品下市集、不會核准任何內容,
// 鎖了反而會被供應商改價格、庫存(第 2 階段下單扣庫存也算)擋住,怎麼按都是「剛被修改過」。
//
// 錯誤訊息一律中文(adminErrorMessage):頁面呼叫時都給中文備援;這裡自己丟的錯名稱一律 Market 開頭,
// friendlyDbError 才會照原本的中文顯示、不被備援蓋掉。
//
// 數量:PostgREST 一次最多回 1000 列(Supabase 的 max rows),超過的會被截掉而且不報錯 ——
// 商品數、店家清單一律用 fetchAllPages 分頁讀完;審核清單用分頁(一頁 ADMIN_PAGE_SIZE 筆,count 算總數)加品名搜尋,
// 任何商品都找得到、下得了架。
import { fetchAllPages } from "@/lib/metrics";
import { LIMITS, type ReviewStatus } from "./constants";
import { friendlyDbError, MarketDbError, marketDb, unwrap, type PgResult } from "./db";
import { hasVisibleText } from "./productForm";
import { disclosureValuesOf, missingDisclosures } from "./store";
import type { MarketProductRow, MarketStoreRow } from "./types";

export const ADMIN_PRODUCT_COLUMNS = "*, market_stores(supplier_id, is_enabled, suppliers(name))";
const ADMIN_STORE_COLUMNS = "*, suppliers(name, phone, contact_email, is_active)";

export type ReviewFilter = ReviewStatus | "all";

/** db.ts 的 MarketQuery 沒有 range / ilike / count,這裡用得到的那一小段另外描述(同樣是 loose cast,不用 any) */
interface PagedQuery<T> extends PromiseLike<PgResult<T> & { count?: number | null }> {
  eq(column: string, value: unknown): PagedQuery<T>;
  ilike(column: string, pattern: string): PagedQuery<T>;
  order(column: string, options: { ascending: boolean }): PagedQuery<T>;
  range(from: number, to: number): PagedQuery<T>;
}
const pagedDb = <T>(table: string) =>
  marketDb<T>(table) as never as { select(columns: string, options?: { count: "exact" }): PagedQuery<T> };

/** 審核清單一頁幾筆 */
export const ADMIN_PAGE_SIZE = 50;

export interface AdminProductPage {
  rows: MarketProductRow[];
  /** 符合篩選與搜尋的總筆數 */
  total: number;
}

/** 品名搜尋的 ilike 樣式:去頭尾空白;% _ \ 當一般字(跳脫);* 在 PostgREST 是 % 的別名,換成 _(任一個字)。只有空白回 null(不搜尋) */
export const nameSearchPattern = (search: string): string | null => {
  const term = search.trim();
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_")}%`;
};

/** 審核清單的一頁。排序固定(最後再加 id),翻頁才不會重複或漏掉:待審是先送審的在前,其他是最近更新的在前 */
export const fetchAdminProducts = async (
  filter: ReviewFilter,
  { page = 0, search = "" }: { page?: number; search?: string } = {},
): Promise<AdminProductPage> => {
  const from = Math.max(0, Math.floor(page)) * ADMIN_PAGE_SIZE;
  let q = pagedDb<MarketProductRow[]>("market_products").select(ADMIN_PRODUCT_COLUMNS, { count: "exact" });
  if (filter !== "all") q = q.eq("review_status", filter);
  const pattern = nameSearchPattern(search);
  if (pattern) q = q.ilike("name", pattern);
  q = q.order(filter === "pending" ? "submitted_at" : "updated_at", { ascending: filter === "pending" }).order("id", { ascending: true });
  const res = await q.range(from, from + ADMIN_PAGE_SIZE - 1);
  const rows = unwrap(res) ?? [];
  return { rows, total: res.count ?? from + rows.length };
};

/** 核准 / 退回時這個商品剛被供應商改過(樂觀鎖一列都沒更新到) */
export class MarketStaleReviewError extends Error {
  constructor() {
    super("這個商品剛被供應商修改過,請重新整理後再審核");
    this.name = "MarketStaleReviewError";
  }
}

/** 退回 / 下架 / 停用店家的原因看不到字(空白、零寬字元)。下架的原因有前綴,資料庫的 reject_reason_required 擋不到,所以這裡先擋 */
export class MarketReasonRequiredError extends Error {
  constructor() {
    super("請填寫原因(會顯示給供應商)");
    this.name = "MarketReasonRequiredError";
  }
}

/** 下架時一列都沒更新到(商品已被供應商刪除,或權限不足被 RLS 擋掉) */
export class MarketReviewGoneError extends Error {
  constructor() {
    super("沒有更新到這個商品(可能已被供應商刪除或權限不足),請重新整理後再試");
    this.name = "MarketReviewGoneError";
  }
}

/** 停用 / 恢復店家時一列都沒更新到(店家已被移除,或權限不足被 RLS 擋掉) */
export class MarketStoreGoneError extends Error {
  constructor() {
    super("沒有更新到這家店(可能已被移除或權限不足),請重新整理後再試");
    this.name = "MarketStoreGoneError";
  }
}

/** 頁面給 adminErrorMessage 的中文備援 */
export const ADMIN_LOAD_FALLBACK = "伺服器暫時沒有回應,請稍後再試";
export const ADMIN_REVIEW_FALLBACK = "審核沒有完成,請重新整理後再試";
export const ADMIN_STORE_FALLBACK = "沒有更新成功,請重新整理後再試";

/**
 * 管理後台的錯誤 → 中文。登入過期(PostgREST 的 PGRST301 / PGRST303,訊息「JWT expired」)請管理員重新登入;
 * 其他照 friendlyDbError(認得的 hint、斷網),認不得的顯示備援(資料庫錯誤附代碼),市集自己丟的錯照原訊息。
 */
export const adminErrorMessage = (e: unknown, fallback: string): string => {
  if (e instanceof MarketDbError && (e.code === "PGRST301" || e.code === "PGRST303" || /\bJWT\b/i.test(e.message))) {
    return "登入已過期,請重新登入後再試";
  }
  return friendlyDbError(e, fallback);
};

export type ReviewAction = { kind: "approve" } | { kind: "reject"; reason: string } | { kind: "delist"; reason: string };

/** 下架 = 退回,原因前面加這段讓供應商分得出來 */
export const DELIST_PREFIX = "(管理員下架)";
/** 下架原因的輸入上限:資料庫的 reject_reason 上限(300)含前綴,輸入框要扣掉前綴,否則填滿 300 字會被 CHECK 擋 */
export const DELIST_REASON_MAX = LIMITS.rejectReason - DELIST_PREFIX.length;

/** 核准 / 退回 / 下架(下架 = 退回並填原因,供應商改好可以重新送審) */
export const reviewProduct = async (
  product: Pick<MarketProductRow, "id" | "updated_at">,
  action: ReviewAction,
): Promise<MarketProductRow> => {
  if (action.kind !== "approve" && !hasVisibleText(action.reason)) throw new MarketReasonRequiredError();
  const patch =
    action.kind === "approve"
      ? { review_status: "approved" }
      : { review_status: "rejected", reject_reason: action.kind === "delist" ? `${DELIST_PREFIX}${action.reason.trim()}` : action.reason.trim() };
  let q = marketDb<MarketProductRow>("market_products").update(patch).eq("id", product.id);
  const locked = action.kind !== "delist";
  if (locked && product.updated_at) q = q.eq("updated_at", product.updated_at);
  const row = unwrap(await q.select(ADMIN_PRODUCT_COLUMNS).maybeSingle());
  if (!row) throw locked ? new MarketStaleReviewError() : new MarketReviewGoneError();
  return row;
};

export interface AdminStoreRow extends MarketStoreRow {
  created_at?: string;
}

/** 全部的零售店家:分頁讀完(supplier_id 排序固定),再依 updated_at 新到舊排 */
export const fetchAdminStores = async (): Promise<AdminStoreRow[]> => {
  const res = await fetchAllPages((from, to) =>
    pagedDb<AdminStoreRow[]>("market_stores").select(ADMIN_STORE_COLUMNS).order("supplier_id", { ascending: true }).range(from, to),
  );
  if (res.error) throw new MarketDbError(res.error);
  return [...res.data].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
};

/** 每家店的商品數(上架中 / 待審)。分頁讀完(id 排序固定):只讀一次的話超過 1000 列會少算、不報錯 */
export const fetchProductCounts = async (): Promise<Map<string, { listed: number; pending: number }>> => {
  const res = await fetchAllPages((from, to) =>
    pagedDb<Array<Pick<MarketProductRow, "supplier_id" | "review_status" | "is_listed">>>("market_products")
      .select("supplier_id, review_status, is_listed")
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (res.error) throw new MarketDbError(res.error);
  const rows = res.data;
  const counts = new Map<string, { listed: number; pending: number }>();
  for (const r of rows) {
    const c = counts.get(r.supplier_id) ?? { listed: 0, pending: 0 };
    if (r.review_status === "approved" && r.is_listed) c.listed += 1;
    if (r.review_status === "pending") c.pending += 1;
    counts.set(r.supplier_id, c);
  }
  return counts;
};

/** 停用(要原因)/ 恢復某家店的零售。用 maybeSingle:0 列時 single() 會回英文的 PGRST116,改丟中文的 MarketStoreGoneError */
export const setStoreEnabled = async (supplierId: string, enabled: boolean, reason: string | null): Promise<AdminStoreRow> => {
  if (!enabled && !hasVisibleText(reason ?? "")) throw new MarketReasonRequiredError();
  const row = unwrap(
    await marketDb<AdminStoreRow>("market_stores")
      .update(enabled ? { is_enabled: true } : { is_enabled: false, disabled_reason: (reason ?? "").trim() })
      .eq("supplier_id", supplierId)
      .select(ADMIN_STORE_COLUMNS)
      .maybeSingle(),
  );
  if (!row) throw new MarketStoreGoneError();
  return row;
};

// ---------------------------------------------------------------------------------------------
// 法規(食材市集法規查證 M3、M6、M8、S3、S4):審核檢查清單、自動提醒、零售店家缺的法定資訊
// ---------------------------------------------------------------------------------------------

export interface ReviewCheckItem {
  key: string;
  label: string;
}

/**
 * 審核檢查清單:查看視窗裡每一項都打勾才能核准(食品資訊先寫在商品說明、審核時把關;酒類連料理米酒、料理酒都不能賣)。
 * 標示「不適用七日鑑賞期」的商品多一項 —— 例外要從嚴認定(消保處函),不是店家勾了就算。
 */
export const reviewChecklist = (row: Pick<MarketProductRow, "withdrawal_exempt">): ReviewCheckItem[] => [
  {
    key: "food-info",
    label: "商品說明裡有食品資訊:成分、淨重或容量、食品添加物、製造或負責廠商的名稱、電話、地址、原產地、到貨時離有效日期至少幾天、食品業者登錄字號",
  },
  { key: "no-alcohol", label: "不是酒類(包括料理米酒、料理酒;菸酒管理法禁止網路販售)" },
  { key: "no-illegal-wording", label: "品名、說明、照片沒有違法字句:「恕不退換」「退貨運費自付」「圖片僅供參考」、醫療效能宣稱" },
  ...(row.withdrawal_exempt
    ? [{ key: "exempt-perishable", label: "標示「不適用七日鑑賞期」的商品確實屬於易腐或短效商品(保存期限少於 7 天左右,或到貨時已接近到期)" }]
    : []),
];

/** 自動提醒的規則:[要找的字(最左邊、最長的先比), 提醒] */
const WARNING_RULES: Array<[RegExp, (found: string) => string]> = [
  [/料理米酒|料理酒|米酒|紅酒|白酒|啤酒|清酒|酒/, (w) => `提到「${w}」:酒類(包括料理米酒、料理酒)不能在網路販售`],
  [/恕不退換|不退不換|不接受退貨|退貨運費自付/, (w) => `有「${w}」:不能限制消費者的退貨權利`],
  [/僅供參考/, (w) => `有「${w}」:商品頁的圖文是契約的一部分,不能寫「僅供參考」`],
  [/治療|療效|治癒|預防疾病|抗癌|降血壓|降血糖|消炎/, (w) => `有醫療效能字句「${w}」:食品不能宣稱醫療效能`],
];

/** 品名、規格、說明裡要特別看的字句(只是提醒;沒有提醒不代表沒問題,檢查清單還是要逐項確認) */
export const reviewWarnings = (row: Pick<MarketProductRow, "name" | "spec" | "description">): string[] => {
  const text = [row.name, row.spec, row.description ?? ""].join("\n");
  return WARNING_RULES.flatMap(([re, message]) => {
    const found = re.exec(text);
    return found ? [message(found[0])] : [];
  });
};

/** 這家店還缺哪些法定資訊(四項加上供應商資料的電話);缺任何一項,資料庫不讓它開放零售(store_disclosure_missing) */
export const storeMissingDisclosures = (store: MarketStoreRow): string[] =>
  missingDisclosures(disclosureValuesOf(store), store.suppliers?.phone ?? null);
