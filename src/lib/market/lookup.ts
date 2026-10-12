// 訂單查詢頁(/market/orders/:token)的資料:用 token 呼叫 market_get_orders(免登入;anon 不能直接讀 market_orders)。
// token 格式不對就不打資料庫(跟 RPC 一樣的規則:43 字 base64url)。
// 店家給店名、電話、出貨天數、退換貨說明與法定資訊(登記名稱、負責人、營業所地址、客服 Email、食品業者登錄字號;
// migration 20261012110000)—— 不給 contact_email(那是店家收新訂單通知的信箱,不是客服信箱)。
// 明細多 withdrawal_exempt(下單當時是不是「不適用七日鑑賞期」的快照)。
import type { PaymentMethod, Temperature, TwCity } from "./constants";
import { marketRpc } from "./db";
import { ORDER_STATUSES, type OrderStatus } from "./orders";

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LookupEvent {
  to_status: OrderStatus;
  created_at: string;
  note: string | null;
}

export interface LookupOrder {
  id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  subtotal: number;
  shipping_fee: number;
  total: number;
  created_at: string;
  status_note: string | null;
  shipped_carrier: string | null;
  shipped_tracking_no: string | null;
  buyer_name: string;
  /** 已遮罩:0912***678 */
  buyer_phone: string;
  /** 已遮罩:h***@example.com */
  buyer_email: string;
  ship_city: TwCity;
  ship_address: string;
  buyer_note: string | null;
  store: {
    supplier_id: string;
    name: string;
    phone: string | null;
    ship_days: number;
    return_policy: string | null;
    /** 法定資訊(migration 20261012110000 之前的回應沒有這幾個欄位,畫面當成沒填) */
    legal_name?: string | null;
    representative?: string | null;
    business_address?: string | null;
    service_email?: string | null;
    food_registration_no?: string | null;
  };
  items: Array<{
    product_name: string;
    spec: string;
    unit_price: number;
    qty: number;
    line_total: number;
    temperature: Temperature;
    /** 下單當時的「不適用七日鑑賞期」(舊回應沒有 → 當成適用) */
    withdrawal_exempt?: boolean;
  }>;
  events: LookupEvent[];
  /** 只有「待匯款」的轉帳訂單才有 */
  transfer_info: string | null;
}

/** 找不到、token 格式不對 → null */
export const fetchOrdersByToken = async (token: string): Promise<LookupOrder[] | null> => {
  if (!TOKEN_PATTERN.test(token)) return null;
  const r = await marketRpc<{ ok: boolean; orders?: LookupOrder[] }>("market_get_orders", { p_token: token });
  return r.ok && Array.isArray(r.orders) && r.orders.length > 0 ? r.orders : null;
};

/**
 * created_at → 可以比大小的 [毫秒, 毫秒以下的三位數]。PostgreSQL 給到微秒(…05:00:00.123456+00:00),Date 只到毫秒:
 * 同一個交易寫的兩筆(接單 + 自動補的待匯款)資料庫保證至少差 1 微秒,只看毫秒會變成一樣。看不懂的時間排最後。
 */
const timeKey = (iso: string): [number, number] => {
  const ms = Date.parse(iso);
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? "";
  return [Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms, Number(fraction.slice(3, 6).padEnd(3, "0"))];
};

/**
 * 進度時間軸的順序:created_at 由舊到新(比到微秒);時間完全一樣才照狀態的先後(ORDER_STATUSES)。
 * 不靠資料庫給的順序 —— market_get_orders 的 ORDER BY created_at, id 遇到同一時間是隨機的 uuid 決定。不改原陣列。
 */
export const sortEvents = <T extends Pick<LookupEvent, "to_status" | "created_at">>(events: readonly T[]): T[] =>
  events
    .map((event, index) => ({ event, index, time: timeKey(event.created_at), rank: ORDER_STATUSES.indexOf(event.to_status) }))
    .sort((a, b) => a.time[0] - b.time[0] || a.time[1] - b.time[1] || a.rank - b.rank || a.index - b.index)
    .map((x) => x.event);
