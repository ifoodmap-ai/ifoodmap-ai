// 72 小時自動取消(資料庫的 pg_cron 每 10 分鐘跑一次,migration 20261012100000_market_hardening.sql):
// - 待接單:下單(訂單的 created_at)滿 72 小時店家還沒接單
// - 待匯款(轉帳單):進入待匯款(最後一筆 to_status = 'awaiting_payment' 的紀錄)滿 72 小時還沒收到款
// 取消紀錄的身分是 system,原因由資料庫寫進 status_note(查單頁、供應商頁照原本的「原因:…」顯示)。
//
// 🔴 時數跟 migration 的 `-- @market-auto-cancel-hours 72` 一樣:autoCancel.test.ts 解析比對。
// 這裡算的期限只是給人看的:真正取消由資料庫判斷,排程每 10 分鐘一次,實際取消可能比期限晚幾分鐘。
// 時間比到微秒(PostgreSQL 給到微秒,Date 只到毫秒),「最後一筆」照 lookup.ts 的 sortEvents 排。
import { sortEvents } from "./lookup";
import type { OrderStatus } from "./orders";

export const MARKET_AUTO_CANCEL_HOURS = 72;

const HOUR_MS = 3_600_000;

/** ISO 時間加幾小時 → UTC 的 ISO 字串,保留毫秒以下的三位(微秒);看不懂 → null */
const addHoursKeepMicros = (iso: string, hours: number): string | null => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const micros = (/\.(\d+)/.exec(iso)?.[1] ?? "").slice(3, 6).padEnd(3, "0");
  return new Date(ms + hours * HOUR_MS).toISOString().replace("Z", `${micros}Z`);
};

/**
 * 這張單什麼時候會被自動取消(UTC ISO,保留微秒);不會被自動取消的狀態 → null。
 * 待匯款卻查不到「待匯款」紀錄(資料不一致)也回 null,不猜。
 */
export const autoCancelDeadline = (
  order: { status: OrderStatus; created_at: string },
  events: ReadonlyArray<{ to_status: OrderStatus; created_at: string }>,
): string | null => {
  if (order.status === "pending") return addHoursKeepMicros(order.created_at, MARKET_AUTO_CANCEL_HOURS);
  if (order.status !== "awaiting_payment") return null;
  const awaiting = sortEvents(events).filter((e) => e.to_status === "awaiting_payment");
  const last = awaiting[awaiting.length - 1];
  return last ? addHoursKeepMicros(last.created_at, MARKET_AUTO_CANCEL_HOURS) : null;
};

/** 期限 → 台北時間「M/D HH:mm」(月、日不補零);沒有、看不懂 → — */
export const formatAutoCancelDeadline = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
};

/**
 * 離期限還有幾個「完整」小時(無條件捨去 —— 畫面寫「N 小時內沒接單會自動取消」,店家在 N 小時內處理一定來得及);
 * 不到 1 小時(含已經過期、排程還沒跑到)→ 0。
 */
export const hoursUntilAutoCancel = (deadline: string, now: number = Date.now()): number =>
  Math.max(0, Math.floor((Date.parse(deadline) - now) / HOUR_MS));
