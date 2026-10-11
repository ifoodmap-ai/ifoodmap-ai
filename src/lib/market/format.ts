// 市集畫面上的顯示文字(金額、運費、配送、庫存)—— 純函式,format.test.ts 測。
import { TW_CITIES } from "./constants";
import type { MarketStoreRow } from "./types";

/** NT$ 3,200(跟 supabase/functions/notify/render.ts 的 money() 同一種寫法) */
export const formatTwd = (n: number): string => `NT$ ${Number(n).toLocaleString("zh-TW")}`;

export const shippingSummary = (store: Pick<MarketStoreRow, "shipping_fee" | "free_shipping_threshold">): string => {
  if (store.shipping_fee === 0) return "免運費";
  const base = `運費 ${formatTwd(store.shipping_fee)}`;
  return store.free_shipping_threshold != null ? `${base},滿 ${formatTwd(store.free_shipping_threshold)} 免運` : base;
};

export const minOrderSummary = (store: Pick<MarketStoreRow, "min_order_amount">): string =>
  store.min_order_amount > 0 ? `滿 ${formatTwd(store.min_order_amount)} 才能下單` : "沒有最低訂購金額";

export const shipDaysSummary = (days: number): string => (days === 0 ? "當天出貨" : `${days} 個工作天內出貨`);

export const citiesSummary = (cities: readonly string[]): string =>
  cities.length >= TW_CITIES.length ? "全台配送" : cities.join("、");

/** 庫存顯示:不限 → 現貨;0 → 已售完;5 件以下顯示剩幾件 */
export const stockLabel = (stock: number | null): string => {
  if (stock === null) return "現貨";
  if (stock <= 0) return "已售完";
  return stock <= 5 ? `剩 ${stock} 件` : "現貨";
};

/** 台北時間「2026/10/09 12:05」(後台、查詢頁用)。用 formatToParts 自己拼,不同瀏覽器的分隔字元才會一致 */
export const formatTaipei = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
};
