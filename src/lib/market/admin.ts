// 管理後台「零售市集」的資料存取:商品審核、零售店家停用 / 恢復。全部用管理員既有的 RLS(is_admin())。
//
// 審核用「樂觀鎖」:更新時多帶 updated_at = 畫面上那一筆的值。供應商在管理員看的同時改了內容
// (資料庫會把 updated_at 換掉、狀態改回 pending),這次更新就會 0 列 → 告訴管理員重新整理,
// 不會把管理員「沒看過的新內容」核准掉。
import { LIMITS, type ReviewStatus } from "./constants";
import { marketDb, unwrap } from "./db";
import type { MarketProductRow, MarketStoreRow } from "./types";

export const ADMIN_PRODUCT_COLUMNS = "*, market_stores(supplier_id, is_enabled, suppliers(name))";

export type ReviewFilter = ReviewStatus | "all";

export const fetchAdminProducts = async (filter: ReviewFilter): Promise<MarketProductRow[]> => {
  let q = marketDb<MarketProductRow[]>("market_products").select(ADMIN_PRODUCT_COLUMNS);
  if (filter !== "all") q = q.eq("review_status", filter);
  return unwrap(await q.order(filter === "pending" ? "submitted_at" : "updated_at", { ascending: filter === "pending" }).limit(500)) ?? [];
};

export class StaleReviewError extends Error {
  constructor() {
    super("這個商品剛被供應商修改過,請重新整理後再審核");
    this.name = "StaleReviewError";
  }
}

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
  const patch =
    action.kind === "approve"
      ? { review_status: "approved" }
      : { review_status: "rejected", reject_reason: action.kind === "delist" ? `${DELIST_PREFIX}${action.reason.trim()}` : action.reason.trim() };
  let q = marketDb<MarketProductRow>("market_products").update(patch).eq("id", product.id);
  if (product.updated_at) q = q.eq("updated_at", product.updated_at);
  const row = unwrap(await q.select(ADMIN_PRODUCT_COLUMNS).maybeSingle());
  if (!row) throw new StaleReviewError();
  return row;
};

export interface AdminStoreRow extends MarketStoreRow {
  created_at?: string;
}

export const fetchAdminStores = async (): Promise<AdminStoreRow[]> =>
  unwrap(
    await marketDb<AdminStoreRow[]>("market_stores")
      .select("*, suppliers(name, phone, contact_email, is_active)")
      .order("updated_at", { ascending: false }),
  ) ?? [];

/** 每家店的商品數(上架中 / 待審) */
export const fetchProductCounts = async (): Promise<Map<string, { listed: number; pending: number }>> => {
  const rows =
    unwrap(await marketDb<Array<Pick<MarketProductRow, "supplier_id" | "review_status" | "is_listed">>>("market_products").select("supplier_id, review_status, is_listed")) ??
    [];
  const counts = new Map<string, { listed: number; pending: number }>();
  for (const r of rows) {
    const c = counts.get(r.supplier_id) ?? { listed: 0, pending: 0 };
    if (r.review_status === "approved" && r.is_listed) c.listed += 1;
    if (r.review_status === "pending") c.pending += 1;
    counts.set(r.supplier_id, c);
  }
  return counts;
};

export const setStoreEnabled = async (supplierId: string, enabled: boolean, reason: string | null): Promise<AdminStoreRow> =>
  unwrap(
    await marketDb<AdminStoreRow>("market_stores")
      .update(enabled ? { is_enabled: true } : { is_enabled: false, disabled_reason: (reason ?? "").trim() })
      .eq("supplier_id", supplierId)
      .select("*, suppliers(name, phone, contact_email, is_active)")
      .single(),
  );
