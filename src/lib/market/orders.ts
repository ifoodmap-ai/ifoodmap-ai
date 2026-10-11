// 零售訂單:狀態、各角色能按的動作、供應商 / 管理員的查詢與寫入。
//
// 🔴 狀態與轉移表的唯一來源是 supabase/migrations/20261009130000_market_orders.sql
//    (market_orders 的 status CHECK、market_transition_rules()、market_order_status_label());
//    orders.test.ts 解析 @market-statuses / @market-transitions 標記比對,改一邊一定要改另一邊。
// 狀態只能經 market_order_events 改變:前端只「新增一筆紀錄」,資料庫的 guard 再檢查身分、目前狀態(畫面過期會擋)、原因、物流。
import { LIMITS, type PaymentMethod, type Temperature, type TwCity } from "./constants";
import { marketDb, unwrap } from "./db";
import { hasVisibleText } from "./productForm";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "awaiting_payment",
  "paid",
  "shipped",
  "completed",
  "rejected",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "待接單",
  confirmed: "已接單",
  awaiting_payment: "待匯款",
  paid: "已收款",
  shipped: "已出貨",
  completed: "已完成",
  rejected: "已拒單",
  cancelled: "已取消",
};

/** 還要有人處理的狀態(供應商「待處理」、管理員「進行中」) */
export const OPEN_STATUSES: readonly OrderStatus[] = ["pending", "confirmed", "awaiting_payment", "paid"];

/** 供應商、管理員、系統共用的轉移表;payment = 只限哪一種付款方式 */
export const MARKET_TRANSITIONS: ReadonlyArray<{ from: OrderStatus; to: OrderStatus; payment: "any" | PaymentMethod }> = [
  { from: "pending", to: "confirmed", payment: "any" },
  { from: "pending", to: "rejected", payment: "any" },
  { from: "pending", to: "cancelled", payment: "any" },
  { from: "confirmed", to: "awaiting_payment", payment: "transfer" },
  { from: "confirmed", to: "shipped", payment: "cod" },
  { from: "confirmed", to: "cancelled", payment: "any" },
  { from: "awaiting_payment", to: "paid", payment: "transfer" },
  { from: "awaiting_payment", to: "cancelled", payment: "transfer" },
  { from: "paid", to: "shipped", payment: "transfer" },
  { from: "paid", to: "cancelled", payment: "transfer" },
  { from: "shipped", to: "completed", payment: "any" },
];

export interface OrderActionMeta {
  label: string;
  needsReason: boolean;
  needsCarrier: boolean;
  danger: boolean;
}

/** 按鈕文字與要填的東西(key = 目標狀態;awaiting_payment 是資料庫自動轉的,沒有按鈕) */
export const ORDER_ACTIONS: Partial<Record<OrderStatus, OrderActionMeta>> = {
  confirmed: { label: "接單", needsReason: false, needsCarrier: false, danger: false },
  rejected: { label: "拒單", needsReason: true, needsCarrier: false, danger: true },
  paid: { label: "確認已收款", needsReason: false, needsCarrier: false, danger: false },
  shipped: { label: "出貨", needsReason: false, needsCarrier: true, danger: false },
  completed: { label: "標記完成", needsReason: false, needsCarrier: false, danger: false },
  cancelled: { label: "取消訂單", needsReason: true, needsCarrier: false, danger: true },
};

export interface MarketOrderItemRow {
  product_name: string;
  spec: string;
  temperature: Temperature;
  unit_price: number;
  qty: number;
  line_total: number;
}

export interface MarketOrderEventRow {
  to_status: OrderStatus;
  actor_role: "consumer" | "supplier" | "admin" | "system";
  note: string | null;
  created_at: string;
}

export interface MarketOrderRow {
  id: string;
  checkout_id: string;
  supplier_id: string;
  status: OrderStatus;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  ship_city: TwCity;
  ship_address: string;
  buyer_note: string | null;
  subtotal: number;
  shipping_fee: number;
  total: number;
  payment_method: PaymentMethod;
  status_note: string | null;
  shipped_carrier: string | null;
  shipped_tracking_no: string | null;
  created_at: string;
  updated_at: string;
  market_order_items: MarketOrderItemRow[];
  /** 只有管理員的查詢會帶(店家電話與 contact_email 給管理員處理客訴用;供應商、消費者的查詢都不帶 contact_email) */
  market_stores?: { suppliers: { name: string; phone?: string | null; contact_email?: string | null } | null } | null;
  market_order_events?: MarketOrderEventRow[];
}

const allowedTargets = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  MARKET_TRANSITIONS.filter((t) => t.from === o.status && (t.payment === "any" || t.payment === o.payment_method)).map((t) => t.to);

/** 供應商後台的按鈕:轉帳訂單接單後資料庫自動轉成「待匯款」(不給按);待接單時用「拒單」,不另外給「取消」 */
export const supplierActions = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  allowedTargets(o).filter((to) => to !== "awaiting_payment" && !(o.status === "pending" && to === "cancelled"));

/** 管理員(處理客訴)只做「平台取消」;接單、出貨都是店家的事 */
export const adminActions = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  allowedTargets(o).filter((to) => to === "cancelled");

export interface OrderActionInput {
  reason?: string;
  carrier?: string;
  trackingNo?: string;
}

/**
 * 送出前的檢查(跟 guard 同一套);回傳錯誤訊息或 null。
 * 原因、物流用 hasVisibleText:guard 用 market_visible 判斷有沒有填,只有全形空白、零寬字元也算沒填(跟第 1 階段的商品欄位同一組字元)。
 * 單號選填:只有看不見的字元時 guard 當成沒填(不存),這裡也不擋。
 */
export const validateOrderAction = (to: OrderStatus, input: OrderActionInput): string | null => {
  const meta = ORDER_ACTIONS[to];
  const reason = (input.reason ?? "").trim();
  const carrier = (input.carrier ?? "").trim();
  const tracking = (input.trackingNo ?? "").trim();
  if (meta?.needsReason && !hasVisibleText(reason)) return "請填寫原因(會告知消費者)";
  if (reason.length > LIMITS.orderNote) return `原因最多 ${LIMITS.orderNote} 字`;
  if (meta?.needsCarrier && !hasVisibleText(carrier)) return "請填寫物流(例如:黑貓宅急便、自行配送)";
  if (carrier.length > LIMITS.carrier) return `物流最多 ${LIMITS.carrier} 字`;
  if (tracking.length > LIMITS.trackingNo) return `物流單號最多 ${LIMITS.trackingNo} 字`;
  return null;
};

export const ORDER_COLUMNS =
  "id, checkout_id, supplier_id, status, buyer_name, buyer_phone, buyer_email, ship_city, ship_address, buyer_note, " +
  "subtotal, shipping_fee, total, payment_method, status_note, shipped_carrier, shipped_tracking_no, created_at, updated_at, " +
  "market_order_items(product_name, spec, temperature, unit_price, qty, line_total)";

const ADMIN_ORDER_COLUMNS = `${ORDER_COLUMNS}, market_stores(suppliers(name, phone, contact_email)), market_order_events(to_status, actor_role, note, created_at)`;

/** 一次最多抓幾張(訂單多到這個數字時要加分頁 —— 見計畫「風險」) */
export const ORDER_LIST_LIMIT = 200;

export const fetchSupplierOrders = async (supplierId: string): Promise<MarketOrderRow[]> =>
  unwrap(
    await marketDb<MarketOrderRow[]>("market_orders")
      .select(ORDER_COLUMNS)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false })
      .limit(ORDER_LIST_LIMIT),
  );

export type AdminOrderFilter = "open" | "shipped" | "closed" | "all";

export const fetchAdminOrders = async (filter: AdminOrderFilter): Promise<MarketOrderRow[]> => {
  let q = marketDb<MarketOrderRow[]>("market_orders").select(ADMIN_ORDER_COLUMNS);
  if (filter === "open") q = q.in("status", OPEN_STATUSES);
  if (filter === "shipped") q = q.eq("status", "shipped");
  if (filter === "closed") q = q.in("status", ["completed", "rejected", "cancelled"]);
  return unwrap(await q.order("created_at", { ascending: false }).limit(ORDER_LIST_LIMIT));
};

/**
 * 改訂單狀態 = 新增一筆紀錄。from_status 帶畫面上的狀態:別人剛處理過時資料庫回 stale_order_status(friendlyDbError 會翻成中文)。
 * actor_role / actor_id 前端不送,資料庫依登入身分決定。
 */
export const addOrderEvent = async (
  order: Pick<MarketOrderRow, "id" | "status">,
  to: OrderStatus,
  input: OrderActionInput = {},
): Promise<void> => {
  const carrier = (input.carrier ?? "").trim();
  const tracking = (input.trackingNo ?? "").trim();
  const payload: Record<string, string> = {};
  if (to === "shipped") {
    payload.carrier = carrier;
    if (tracking) payload.tracking_no = tracking;
  }
  unwrap(
    await marketDb<null>("market_order_events").insert({
      order_id: order.id,
      from_status: order.status,
      to_status: to,
      note: (input.reason ?? "").trim() || null,
      payload,
    }),
  );
};
