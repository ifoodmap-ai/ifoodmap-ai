// 訂單狀態機 + 事件流 —— 三端共用的單一入口。
//
// 設計原則(docs/PORTALS_PLAN.md 第 4 節):
//   1. 任何狀態變更都只透過 recordOrderEvent() 寫 order_events
//   2. order_events 的 trigger 會同步更新 supplier_orders.status
//      → 前端永遠不要直接 update status,否則停留時間與履歷會失真
//   3. received 只能由餐廳端觸發,供應商最多推到 delivered
//   4. 下面的 TRANSITIONS 只決定「畫面上出現哪些按鈕」;真正的規則在資料庫
//      (supabase/migrations/20260929100000_order_transition_rules.sql 的 order_transition_rules()):
//      身分、目前狀態、目標狀態不在表裡就寫不進去,actor_id 也由伺服器用 auth.uid() 決定。
//      兩份表由 orders.test.ts 逐條比對,改一邊一定要改另一邊。

import { supabase } from "@/integrations/supabase/client";

export { formatOrderNo } from "./order-number";

export type OrderStatus =
  | "draft" | "submitted" | "dispatched" | "accepted" | "quoted" | "confirmed"
  | "shipped" | "in_transit" | "delivered" | "received" | "reviewed" | "closed"
  | "rejected" | "discrepancy" | "disputed" | "cancelled" | "expired"
  // 相容既有資料
  | "pending" | "sent" | "completed";

export type ActorRole = "restaurant" | "supplier" | "admin" | "system";
export type EventSource =
  | "restaurant_portal" | "supplier_portal" | "admin_portal"
  | "line_bot" | "api" | "cron" | "system";

export interface OrderEvent {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor_id: string | null;
  actor_role: ActorRole;
  actor_label: string | null;
  source: EventSource;
  payload: Record<string, unknown>;
  note: string | null;
  created_at: string;
}

interface StatusMeta {
  label: string;
  /** 正常流程的順序;異常分支為 -1 */
  step: number;
  className: string;
  /** 卡在這一階段多久算異常(小時);null = 不計 SLA */
  slaHours: number | null;
  /** 誰該採取下一步 */
  waitingOn: ActorRole | null;
}

export const ORDER_STATUS: Record<OrderStatus, StatusMeta> = {
  draft:       { label: "草稿",     step: 0,  className: "bg-slate-100 text-slate-600 border-slate-300", slaHours: null, waitingOn: "restaurant" },
  submitted:   { label: "待派發",   step: 1,  className: "bg-slate-100 text-slate-700 border-slate-300", slaHours: 12,   waitingOn: "admin" },
  dispatched:  { label: "待接單",   step: 2,  className: "bg-blue-50 text-blue-700 border-blue-200",     slaHours: 24,   waitingOn: "supplier" },
  accepted:    { label: "待報價",   step: 3,  className: "bg-blue-50 text-blue-700 border-blue-200",     slaHours: 24,   waitingOn: "supplier" },
  quoted:      { label: "待確認",   step: 4,  className: "bg-amber-50 text-amber-700 border-amber-200",  slaHours: 48,   waitingOn: "restaurant" },
  confirmed:   { label: "待出貨",   step: 5,  className: "bg-amber-50 text-amber-700 border-amber-200",  slaHours: 48,   waitingOn: "supplier" },
  shipped:     { label: "已出貨",   step: 6,  className: "bg-indigo-50 text-indigo-700 border-indigo-200", slaHours: 48, waitingOn: "supplier" },
  in_transit:  { label: "運送中",   step: 7,  className: "bg-indigo-50 text-indigo-700 border-indigo-200", slaHours: 48, waitingOn: "supplier" },
  delivered:   { label: "待收貨",   step: 8,  className: "bg-purple-50 text-purple-700 border-purple-200", slaHours: 72, waitingOn: "restaurant" },
  received:    { label: "待評價",   step: 9,  className: "bg-emerald-50 text-emerald-700 border-emerald-200", slaHours: 168, waitingOn: "restaurant" },
  reviewed:    { label: "已評價",   step: 10, className: "bg-emerald-50 text-emerald-700 border-emerald-200", slaHours: null, waitingOn: "admin" },
  closed:      { label: "已結案",   step: 11, className: "bg-emerald-100 text-emerald-800 border-emerald-300", slaHours: null, waitingOn: null },

  rejected:    { label: "供應商拒單", step: -1, className: "bg-red-50 text-red-700 border-red-200",       slaHours: null, waitingOn: "admin" },
  discrepancy: { label: "收貨有差異", step: -1, className: "bg-orange-50 text-orange-700 border-orange-200", slaHours: 24, waitingOn: "admin" },
  disputed:    { label: "爭議中",     step: -1, className: "bg-red-50 text-red-700 border-red-200",       slaHours: 48,   waitingOn: "admin" },
  cancelled:   { label: "已取消",     step: -1, className: "bg-slate-100 text-slate-500 border-slate-300", slaHours: null, waitingOn: null },
  expired:     { label: "逾時未回應", step: -1, className: "bg-red-50 text-red-700 border-red-200",       slaHours: null, waitingOn: "admin" },

  // 既有資料的舊狀態
  pending:     { label: "待處理",   step: 1,  className: "bg-slate-100 text-slate-700 border-slate-300", slaHours: 24,   waitingOn: "admin" },
  sent:        { label: "已派發",   step: 2,  className: "bg-blue-50 text-blue-700 border-blue-200",     slaHours: 24,   waitingOn: "supplier" },
  completed:   { label: "已完成",   step: 11, className: "bg-emerald-100 text-emerald-800 border-emerald-300", slaHours: null, waitingOn: null },
};

/** 正常流程的顯示順序(看板欄位、時間軸用) */
export const PIPELINE_STAGES: OrderStatus[] = [
  "submitted", "dispatched", "accepted", "quoted", "confirmed",
  "shipped", "in_transit", "delivered", "received", "reviewed",
];

/** 各角色在某狀態下可以推進到哪些狀態 —— 前端按鈕的唯一依據 */
const TRANSITIONS: Record<ActorRole, Partial<Record<OrderStatus, OrderStatus[]>>> = {
  restaurant: {
    // dispatched = 向已綁定的合作供應商直接叫貨(採購員也可以,不需簽核;供應商是否已綁定由資料庫檢查)
    draft:      ["submitted", "cancelled", "dispatched"],
    // accepted = 退回重新報價(只有老闆/店長,要填原因;見 RESTAURANT_APPROVER_ONLY)
    quoted:     ["confirmed", "accepted", "cancelled"],
    // ★ received 只有餐廳能觸發 —— GMV 可信度的來源
    delivered:  ["received", "discrepancy"],
    received:   ["reviewed"],
    discrepancy:["disputed"],
  },
  supplier: {
    dispatched: ["accepted", "rejected"],
    sent:       ["accepted", "rejected"],
    accepted:   ["quoted"],
    confirmed:  ["shipped"],
    shipped:    ["in_transit", "delivered"],
    in_transit: ["delivered"],
  },
  admin: {
    submitted:  ["dispatched", "cancelled"],
    pending:    ["dispatched", "cancelled"],
    draft:      ["dispatched", "cancelled"],
    rejected:   ["dispatched", "cancelled"],
    expired:    ["dispatched", "cancelled"],
    // 進行中的單卡住時由管理員取消(要填原因,資料庫會檢查)
    dispatched: ["cancelled"],
    sent:       ["cancelled"],
    accepted:   ["cancelled"],
    quoted:     ["cancelled"],
    confirmed:  ["cancelled"],
    shipped:    ["cancelled"],
    in_transit: ["cancelled"],
    discrepancy:["disputed", "received", "closed"],
    disputed:   ["closed", "received"],
    reviewed:   ["closed"],
    received:   ["closed"],
  },
  // 系統(service_role、排程):所有角色的轉移聯集 + 等待中的單逾時(每日排程 expire_stuck_orders;畫面上沒有系統按鈕)
  system: {
    draft:      ["submitted", "cancelled", "dispatched"],
    submitted:  ["dispatched", "cancelled"],
    pending:    ["dispatched", "cancelled"],
    dispatched: ["accepted", "rejected", "expired", "cancelled"],
    sent:       ["accepted", "rejected", "expired", "cancelled"],
    accepted:   ["quoted", "expired", "cancelled"],
    quoted:     ["confirmed", "accepted", "cancelled", "expired"],
    confirmed:  ["shipped", "expired", "cancelled"],
    shipped:    ["in_transit", "delivered", "cancelled"],
    in_transit: ["delivered", "cancelled"],
    delivered:  ["received", "discrepancy"],
    received:   ["reviewed", "closed"],
    reviewed:   ["closed"],
    discrepancy:["disputed", "received", "closed"],
    disputed:   ["closed", "received"],
    rejected:   ["dispatched", "cancelled"],
    expired:    ["dispatched", "cancelled"],
  },
};

/**
 * 管理員畫面上出現「派給…」的狀態:待派發(含舊資料 pending)、被拒、逾時。
 * 轉移表也允許管理員直接從草稿派單,但草稿要由餐廳老闆/店長簽核送出,畫面上刻意不給。
 */
export const ADMIN_DISPATCHABLE: OrderStatus[] = ["submitted", "pending", "rejected", "expired"];

export const allowedTransitions = (role: ActorRole, status: OrderStatus): OrderStatus[] =>
  TRANSITIONS[role]?.[status] ?? [];

/** 餐廳端只有老闆/店長能做的轉移:送出草稿(簽核)、退回重新報價。採購員看不到這兩顆按鈕,資料庫也擋 */
export const RESTAURANT_APPROVER_ONLY: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ["draft", "submitted"],
  ["quoted", "accepted"],
];

export type RestaurantMemberRole = "owner" | "manager" | "purchaser";

/** 餐廳成員在某狀態下可以做的轉移(採購員扣掉 RESTAURANT_APPROVER_ONLY) */
export const restaurantTransitions = (role: RestaurantMemberRole, status: OrderStatus): OrderStatus[] =>
  allowedTransitions("restaurant", status).filter(
    (to) => role !== "purchaser" || !RESTAURANT_APPROVER_ONLY.some(([f, t]) => f === status && t === to),
  );

/** 管理員取消這些狀態的單要填原因(資料庫 guard_order_transition 同一份清單) */
export const IN_FLIGHT_STATUSES: OrderStatus[] = [
  "dispatched", "sent", "accepted", "quoted", "confirmed", "shipped", "in_transit",
];

export const canTransition = (role: ActorRole, from: OrderStatus, to: OrderStatus): boolean =>
  allowedTransitions(role, from).includes(to);

interface RecordEventInput {
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorRole: ActorRole;
  source: EventSource;
  actorLabel?: string | null;
  payload?: Record<string, unknown>;
  note?: string | null;
}

/** 寫事件被資料庫擋下時的錯誤:message 是給使用者看的中文;hint 標出原因(見 isStaleOrderError) */
export class OrderEventError extends Error {
  readonly code: string | null;
  readonly hint: string | null;
  constructor(message: string, code: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "OrderEventError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * 呼叫訂單相關的 RPC(restaurant_receive_order / restaurant_open_dispute):一次交易完成事件與子表,
 * 失敗時跟 recordOrderEvent 一樣丟 OrderEventError(帶 code / hint,畫面過期可以用 isStaleOrderError 判斷)
 */
export const callOrderRpc = async <T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await (supabase as never as {
    rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: T | null; error: PgError }>;
  }).rpc(fn, args);
  if (error) throw new OrderEventError(error.message, error.code ?? null, error.hint ?? null);
  return data as T;
};

/** 畫面上的狀態已經過期(別人剛處理過這張單)—— 呼叫端應該重新整理列表 */
export const isStaleOrderError = (e: unknown): boolean =>
  e instanceof OrderEventError && (e.hint === "stale_order_status" || e.hint === "one_event_per_order");

type PgError = { message: string; code?: string | null; hint?: string | null } | null;

/**
 * 寫一筆訂單事件。DB trigger 會同步把 supplier_orders.status 更新成 toStatus
 * 並重設 current_stage_since —— 所以呼叫端不需要(也不應該)自己 update status。
 *
 * fromStatus 請傳畫面上看到的狀態:資料庫發現它跟目前狀態不同會擋下(isStaleOrderError)。
 * actor_id 不送 —— 伺服器一律用 auth.uid() 決定;actor_label 只是顯示用。
 */
export const recordOrderEvent = async (input: RecordEventInput): Promise<OrderEvent> => {
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await (supabase as never as {
    from: (t: string) => {
      insert: (v: unknown) => {
        select: (c: string) => { single: () => Promise<{ data: OrderEvent | null; error: PgError }> };
      };
    };
  })
    .from("order_events")
    .insert({
      order_id: input.orderId,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      actor_role: input.actorRole,
      actor_label: input.actorLabel ?? user?.email ?? null,
      source: input.source,
      payload: input.payload ?? {},
      note: input.note ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new OrderEventError(error?.message ?? "寫入訂單事件失敗", error?.code ?? null, error?.hint ?? null);
  }
  return data;
};

/** 取一筆訂單的完整履歷(時間順序) */
export const fetchOrderTimeline = async (orderId: string): Promise<OrderEvent[]> => {
  const { data, error } = (await (supabase as never as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => {
          order: (c: string, o: { ascending: boolean }) => Promise<{ data: OrderEvent[] | null; error: { message: string } | null }>;
        };
      };
    };
  })
    .from("order_events")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })) as { data: OrderEvent[] | null; error: { message: string } | null };

  if (error) throw new Error(error.message);
  return data ?? [];
};

/** 停留時數 */
export const hoursInStage = (since: string | null): number => {
  if (!since) return 0;
  const ms = Date.now() - new Date(since).getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : 0;
};

/** 是否卡關(超過該階段的 SLA) */
export const isStuck = (status: OrderStatus, since: string | null): boolean => {
  const sla = ORDER_STATUS[status]?.slaHours;
  return sla != null && hoursInStage(since) > sla;
};

export const formatStageAge = (since: string | null): string => {
  const h = hoursInStage(since);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分鐘`;
  if (h < 48) return `${Math.round(h)} 小時`;
  return `${Math.round(h / 24)} 天`;
};

/** 事件來源的顯示標籤 */
export const SOURCE_LABEL: Record<EventSource, string> = {
  restaurant_portal: "餐廳後台",
  supplier_portal: "供應商後台",
  admin_portal: "管理後台",
  line_bot: "LINE",
  api: "API",
  cron: "排程",
  system: "系統",
};

export const ROLE_LABEL: Record<ActorRole, string> = {
  restaurant: "餐廳",
  supplier: "供應商",
  admin: "管理員",
  system: "系統",
};
