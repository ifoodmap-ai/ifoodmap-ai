import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Clock,
  History,
  Inbox,
  Loader2,
  Lock,
  PackageCheck,
  RotateCcw,
  Search,
  ShieldX,
  Star,
  Store,
  TriangleAlert,
  Truck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant, canSeeCost, needsApproval } from "@/components/RestaurantRoute";
import {
  ORDER_STATUS,
  PIPELINE_STAGES,
  ROLE_LABEL,
  SOURCE_LABEL,
  callOrderRpc,
  fetchOrderTimeline,
  formatStageAge,
  isStaleOrderError,
  isStuck,
  recordOrderEvent,
  restaurantTransitions,
  type OrderEvent,
  type OrderStatus,
} from "@/lib/orders";
import { formatOrderNo } from "@/lib/order-number";
import ReceiveOrderDialog, {
  type OrderIngredient,
} from "@/components/restaurant/ReceiveOrderDialog";
import OrderReviewDialog from "@/components/restaurant/OrderReviewDialog";

/* 新資料表不在 types.ts 裡 —— 沿用專案既有的 cast 慣例 */
type PgError = { message: string } | null;

interface QueryBuilder<T> extends PromiseLike<{ data: T[] | null; error: PgError }> {
  select: (cols: string) => QueryBuilder<T>;
  insert: (values: unknown) => QueryBuilder<T>;
  eq: (col: string, val: string | number | boolean) => QueryBuilder<T>;
  neq: (col: string, val: string | number | boolean) => QueryBuilder<T>;
  order: (col: string, opts: { ascending: boolean }) => QueryBuilder<T>;
}

const db = <T,>(table: string): QueryBuilder<T> =>
  (supabase as never as { from: (t: string) => QueryBuilder<T> }).from(table);

/* ------------------------------------------------------------------ */

interface OrderRow {
  id: string;
  status: OrderStatus;
  supplier_id: string | null;
  ingredient_list: OrderIngredient[] | null;
  total_amount: number | null;
  notes: string | null;
  created_at: string;
  current_stage_since: string | null;
}

const CLOSED_STATUSES: OrderStatus[] = [
  "reviewed",
  "closed",
  "completed",
  "cancelled",
  "expired",
];

type TabKey = "all" | "active" | "delivered" | "received" | "closed";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "進行中" },
  { key: "delivered", label: "待收貨" },
  { key: "received", label: "待評價" },
  { key: "closed", label: "已結案" },
];

const matchTab = (status: OrderStatus, tab: TabKey): boolean => {
  switch (tab) {
    case "all":
      return true;
    case "active":
      return !CLOSED_STATUSES.includes(status);
    case "delivered":
      return status === "delivered";
    case "received":
      return status === "received";
    case "closed":
      return CLOSED_STATUSES.includes(status);
    default:
      return true;
  }
};

interface ActionConf {
  label: string;
  icon: LucideIcon;
  tone: "primary" | "warn" | "danger" | "plain";
}

/**
 * 動作按鈕外觀 —— 實際會出現哪幾顆完全由 restaurantTransitions(轉移表 + 採購員限制)決定。
 *
 * 刻意沒有 submitted(「送出訂單」):草稿只在「叫貨」分頁的待簽核區處理,
 * 送出只給老闆/店長(業主拍板 Q8-A;資料庫 trg_guard_order_submission 也擋採購員)。
 * 這頁的查詢本來就排除草稿,這裡再少一顆按鈕是第二道保險。
 */
const ACTION_CONF: Partial<Record<OrderStatus, ActionConf>> = {
  confirmed: { label: "確認訂單", icon: CheckCircle2, tone: "primary" },
  // 待確認 → 待報價:退回重新報價(只有老闆/店長;要填原因,會轉告供應商)
  accepted: { label: "退回重新報價", icon: RotateCcw, tone: "warn" },
  cancelled: { label: "取消訂單", icon: XCircle, tone: "danger" },
  received: { label: "已收到貨", icon: PackageCheck, tone: "primary" },
  discrepancy: { label: "回報異常", icon: TriangleAlert, tone: "warn" },
  reviewed: { label: "給評價", icon: Star, tone: "primary" },
  disputed: { label: "申請爭議處理", icon: ShieldX, tone: "danger" },
};

const TONE_CLASS: Record<ActionConf["tone"], string> = {
  primary: "bg-emerald-600 hover:bg-emerald-700 text-white",
  warn: "bg-white border border-orange-300 text-orange-700 hover:bg-orange-50",
  danger: "bg-white border border-red-200 text-red-600 hover:bg-red-50",
  plain: "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50",
};

const DISPUTE_KINDS: { key: string; label: string }[] = [
  { key: "shortage", label: "數量短缺" },
  { key: "late", label: "延遲送達" },
  { key: "quality", label: "品質不良" },
  { key: "wrong_item", label: "送錯品項" },
  { key: "other", label: "其他問題" },
];

const statusMeta = (status: OrderStatus) =>
  ORDER_STATUS[status] ?? {
    label: status,
    step: -1,
    className: "bg-slate-100 text-slate-600 border-slate-300",
    slaHours: null,
    waitingOn: null,
  };

/**
 * 採購系統是向「既定的合作供應商」叫貨,供應商本來就確定了:訂單從「待接單」開始,沒有「待派發」(管理員派單)這一步。
 * 管理員派單是媒合平台的流程,不列在這頁。
 */
const ORDER_STAGES = PIPELINE_STAGES.filter((stage) => stage !== "submitted");

/** 這張單算不算「採購系統的訂單」:有供應商,而且不是還在等管理員派發(待派發 / 舊資料待處理) */
const isProcurementOrder = (o: { supplier_id: string | null; status: string }) =>
  !!o.supplier_id && o.status !== "submitted" && o.status !== "pending" && o.status !== "draft";

/** 橫向流程步驟條;異常狀態整條轉為灰階並在上方另外提示 */
const PipelineBar = ({ status }: { status: OrderStatus }) => {
  const current = statusMeta(status).step;
  const abnormal = current < 0;

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex min-w-[620px] items-start">
        {ORDER_STAGES.map((stage, i) => {
          const step = statusMeta(stage).step;
          const done = !abnormal && step < current;
          const active = !abnormal && step === current;
          return (
            <div key={stage} className="flex flex-1 items-start">
              <div className="flex w-full flex-col items-center">
                <div className="flex w-full items-center">
                  <div
                    className={`h-0.5 flex-1 ${
                      i === 0 ? "bg-transparent" : done || active ? "bg-emerald-400" : "bg-slate-200"
                    }`}
                  />
                  <div
                    className={`h-3 w-3 shrink-0 rounded-full border-2 ${
                      active
                        ? "border-emerald-600 bg-emerald-600 ring-4 ring-emerald-100"
                        : done
                          ? "border-emerald-400 bg-emerald-400"
                          : "border-slate-300 bg-white"
                    }`}
                  />
                  <div
                    className={`h-0.5 flex-1 ${
                      i === ORDER_STAGES.length - 1
                        ? "bg-transparent"
                        : done
                          ? "bg-emerald-400"
                          : "bg-slate-200"
                    }`}
                  />
                </div>
                <span
                  className={`mt-1.5 whitespace-nowrap text-[11px] ${
                    active
                      ? "font-semibold text-emerald-700"
                      : done
                        ? "text-slate-500"
                        : "text-slate-300"
                  }`}
                >
                  {statusMeta(stage).label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default function RestaurantOrdersPage() {
  const { restaurant_id, restaurant_name, role } = useRestaurant();
  const showCost = canSeeCost(role);
  const mustApprove = needsApproval(role);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  /** 待簽核的草稿張數 —— 草稿不在這頁列出,只在頂端提示並連到叫貨分頁 */
  const [draftCount, setDraftCount] = useState(0);
  // 還在媒合的需求(沒有供應商、等管理員派發):不是採購系統的訂單,這頁不列,只提示張數
  const [matchingCount, setMatchingCount] = useState(0);
  const [supplierMap, setSupplierMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [timelines, setTimelines] = useState<Record<string, OrderEvent[]>>({});
  const [timelineLoading, setTimelineLoading] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<{
    order: OrderRow;
    mode: "receive" | "report";
  } | null>(null);
  const [reviewTarget, setReviewTarget] = useState<OrderRow | null>(null);
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<OrderRow | null>(null);
  const [disputeKind, setDisputeKind] = useState("shortage");
  const [disputeDetail, setDisputeDetail] = useState("");
  const [requoteTarget, setRequoteTarget] = useState<OrderRow | null>(null);
  const [requoteReason, setRequoteReason] = useState("");

  const supplierName = useCallback(
    (id: string | null) => (id && supplierMap[id]) || "尚未指派供應商",
    [supplierMap],
  );

  const fetchOrders = useCallback(async () => {
    // 草稿(待簽核)不列在這頁:它們只出現在「叫貨」分頁的待簽核區,只有老闆/店長能送出
    const [{ data, error }, { data: drafts }] = await Promise.all([
      db<OrderRow>("supplier_orders")
        .select(
          "id, status, supplier_id, ingredient_list, total_amount, notes, created_at, current_stage_since",
        )
        .eq("restaurant_id", restaurant_id)
        .neq("status", "draft")
        .order("created_at", { ascending: false }),
      db<{ id: string }>("supplier_orders")
        .select("id")
        .eq("restaurant_id", restaurant_id)
        .eq("status", "draft"),
    ]);

    // 查不到張數時只是少一行提示,不影響訂單列表
    setDraftCount((drafts ?? []).length);

    if (error) {
      toast.error("訂單載入失敗", { description: error.message });
      setOrders([]);
      return;
    }
    const all = (data ?? []).filter((o) => o.status !== "draft");
    setOrders(all.filter(isProcurementOrder));
    setMatchingCount(all.length - all.filter(isProcurementOrder).length);
  }, [restaurant_id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: sup } = await db<{ id: string; name: string }>("suppliers").select("id, name");
      if (!cancelled) {
        const map: Record<string, string> = {};
        (sup ?? []).forEach((s) => {
          map[s.id] = s.name;
        });
        setSupplierMap(map);
      }
      await fetchOrders();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchOrders]);

  /** 動作完成後:重抓訂單 + 讓該筆履歷失效 */
  const refreshAfterAction = useCallback(
    async (orderId: string) => {
      setTimelines((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      await fetchOrders();
      if (expanded === orderId) {
        try {
          const evs = await fetchOrderTimeline(orderId);
          setTimelines((prev) => ({ ...prev, [orderId]: evs }));
        } catch {
          /* 履歷載入失敗不影響主流程 */
        }
      }
    },
    [fetchOrders, expanded],
  );

  const toggleTimeline = async (orderId: string) => {
    if (expanded === orderId) {
      setExpanded(null);
      return;
    }
    setExpanded(orderId);
    if (timelines[orderId]) return;
    setTimelineLoading(orderId);
    try {
      const evs = await fetchOrderTimeline(orderId);
      setTimelines((prev) => ({ ...prev, [orderId]: evs }));
    } catch (e) {
      toast.error("履歷載入失敗", { description: (e as Error).message });
    } finally {
      setTimelineLoading(null);
    }
  };

  /** 單純推進狀態(確認訂單、送出訂單、取消) */
  const advance = async (order: OrderRow, to: OrderStatus, note?: string) => {
    setBusyId(order.id);
    try {
      await recordOrderEvent({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: to,
        actorRole: "restaurant",
        source: "restaurant_portal",
        note: note ?? null,
      });
      toast.success(`已更新為「${statusMeta(to).label}」`);
      await refreshAfterAction(order.id);
    } catch (e) {
      toast.error("操作失敗", { description: (e as Error).message });
      // 別人剛處理過這張單(資料庫回「畫面上的資料過期了」):順手重抓,畫面才會是最新狀態
      if (isStaleOrderError(e)) await refreshAfterAction(order.id);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 申請爭議:事件與爭議案件在資料庫一次交易寫完(restaurant_open_dispute)。
   * 別人剛處理過這張單(畫面過期)時整筆被擋,不會留下爭議案件;這時順手重抓。
   */
  const submitDispute = async () => {
    if (!disputeTarget) return;
    const order = disputeTarget;
    setBusyId(order.id);
    try {
      await callOrderRpc("restaurant_open_dispute", {
        p_order_id: order.id,
        p_from_status: order.status,
        p_kind: disputeKind,
        p_detail: disputeDetail.trim() || null,
      });

      toast.success("已送出爭議申請", { description: "客服會在 1 個工作天內聯繫您" });
      setDisputeTarget(null);
      setDisputeDetail("");
      setDisputeKind("shortage");
      await refreshAfterAction(order.id);
    } catch (e) {
      toast.error("送出失敗", { description: (e as Error).message });
      if (isStaleOrderError(e)) {
        setDisputeTarget(null);
        await refreshAfterAction(order.id);
      }
    } finally {
      setBusyId(null);
    }
  };

  /** 退回重新報價:訂單回到「待報價」、舊報價作廢,原因會寄給供應商(資料庫要求一定要填原因) */
  const submitRequote = async () => {
    if (!requoteTarget) return;
    const order = requoteTarget;
    const reason = requoteReason.trim();
    if (!reason) return;
    setBusyId(order.id);
    try {
      await recordOrderEvent({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "accepted",
        actorRole: "restaurant",
        source: "restaurant_portal",
        note: reason,
        payload: { reason },
      });
      toast.success("已退回給供應商重新報價", { description: "供應商重新報價後會通知您確認" });
      setRequoteTarget(null);
      setRequoteReason("");
      await refreshAfterAction(order.id);
    } catch (e) {
      toast.error("退回失敗", { description: (e as Error).message });
      if (isStaleOrderError(e)) {
        setRequoteTarget(null);
        await refreshAfterAction(order.id);
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleAction = (order: OrderRow, to: OrderStatus) => {
    switch (to) {
      case "received":
        setReceiveTarget({ order, mode: "receive" });
        return;
      case "discrepancy":
        setReceiveTarget({ order, mode: "report" });
        return;
      case "reviewed":
        setReviewTarget(order);
        return;
      case "cancelled":
        setCancelTarget(order);
        return;
      case "disputed":
        setDisputeKind("shortage");
        setDisputeDetail("");
        setDisputeTarget(order);
        return;
      case "accepted":
        setRequoteReason("");
        setRequoteTarget(order);
        return;
      default:
        advance(order, to);
    }
  };

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { all: 0, active: 0, delivered: 0, received: 0, closed: 0 };
    orders.forEach((o) => {
      TABS.forEach(({ key }) => {
        if (matchTab(o.status, key)) c[key] += 1;
      });
    });
    return c;
  }, [orders]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (!matchTab(o.status, tab)) return false;
      if (!q) return true;
      const names = (Array.isArray(o.ingredient_list) ? o.ingredient_list : [])
        .map((i) => i.name ?? "")
        .join(" ");
      return `${o.id} ${supplierName(o.supplier_id)} ${names}`.toLowerCase().includes(q);
    });
  }, [orders, tab, search, supplierName]);

  /** 傳給彈窗的物件必須維持穩定的 identity,否則彈窗內的表單會在父層重繪時被重設 */
  const receiveOrderProp = useMemo(
    () =>
      receiveTarget
        ? {
            id: receiveTarget.order.id,
            status: receiveTarget.order.status,
            supplier_id: receiveTarget.order.supplier_id,
            supplier_name: supplierName(receiveTarget.order.supplier_id),
            ingredient_list: receiveTarget.order.ingredient_list,
          }
        : null,
    [receiveTarget, supplierName],
  );

  const reviewOrderProp = useMemo(
    () =>
      reviewTarget
        ? {
            id: reviewTarget.id,
            status: reviewTarget.status,
            supplier_id: reviewTarget.supplier_id,
            supplier_name: supplierName(reviewTarget.supplier_id),
          }
        : null,
    [reviewTarget, supplierName],
  );

  const itemSummary = (list: OrderIngredient[] | null) => {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {arr.slice(0, 6).map((it, i) => (
          <span key={i} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
            {it.name ?? `品項 ${i + 1}`}
            {it.quantity ? ` · ${it.quantity}${it.unit ?? ""}` : ""}
          </span>
        ))}
        {arr.length > 6 && (
          <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-400">
            …共 {arr.length} 項
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">我的訂單</h1>
        <span className="flex items-center gap-1.5 text-sm text-slate-400">
          <Store className="h-4 w-4" />
          {restaurant_name}
        </span>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        追蹤每一張採購單的進度,貨到請務必按「已收到貨」—— 這是我們與供應商對帳的依據
        {!showCost && "(採購員身分不顯示金額)"}
      </p>

      {matchingCount > 0 && (
        <p data-testid="matching-notice" className="mb-5 text-xs text-slate-400">
          另有 {matchingCount} 筆還在媒合的需求(還沒有供應商),不列在採購訂單裡。
        </p>
      )}

      {/* 待簽核的草稿:只提示張數,送出/退回在叫貨分頁 */}
      {draftCount > 0 && (
        <div
          data-testid="pending-approval-notice"
          className="mb-5 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center"
        >
          <ClipboardCheck className="hidden h-4 w-4 shrink-0 sm:block" />
          <span className="flex-1">
            {mustApprove
              ? `待簽核 ${draftCount} 張:採購單要由老闆或店長簽核後才會送出`
              : `待簽核 ${draftCount} 張:採購單要在「叫貨」分頁簽核後才會送出`}
          </span>
          <Link
            to="/restaurant/purchase"
            className="inline-flex items-center gap-1 self-start font-medium text-amber-900 underline-offset-2 hover:underline sm:self-auto"
          >
            {mustApprove ? "查看待簽核" : "前往簽核"}
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      )}

      {/* 頁籤 + 搜尋 */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* 手機上五個狀態籤放不下時橫向捲,不要把「全部」擠成一字一行 */}
        <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
              {counts[t.key] > 0 && (
                <span className="ml-1 text-xs text-slate-400">{counts[t.key]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋供應商 / 品項 / 訂單編號…"
            className="pl-9"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="mb-3 h-8 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-20 text-center text-slate-400">
          <Inbox className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">
            {orders.length === 0
              ? "還沒有訂單 —— 完成菜單分析後就能一鍵向供應商下單"
              : search.trim()
                ? "找不到符合的訂單,換個關鍵字試試"
                : "這個分類目前沒有訂單"}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((order) => {
            const meta = statusMeta(order.status);
            const since = order.current_stage_since ?? order.created_at;
            const stuck = isStuck(order.status, since);
            // 按鈕只由轉移表產生;採購員看不到只有老闆/店長能做的(送出、退回重新報價)
            const transitions = restaurantTransitions(role, order.status);
            // 報價之後品項就鎖住了(資料庫 guard_order_update 擋);只有待確認時還能用「退回重新報價」改,所以提示只在這時出現
            const showItemsLockHint = order.status === "quoted";
            const isOpen = expanded === order.id;
            const events = timelines[order.id];
            const busy = busyId === order.id;

            return (
              <Card key={order.id} className="border-slate-200 p-5">
                {/* 標頭 */}
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-800">
                        {formatOrderNo(order.id)}
                      </span>
                      <Badge variant="outline" className={meta.className}>
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="flex items-center gap-1.5 text-sm text-slate-600">
                      <Truck className="h-3.5 w-3.5 text-slate-400" />
                      {supplierName(order.supplier_id)}
                      <span className="text-slate-300">·</span>
                      <span className="text-slate-400">
                        {new Date(order.created_at).toLocaleDateString("zh-TW")} 下單
                      </span>
                    </p>
                  </div>
                  {showCost && (
                    <div className="text-right">
                      <p className="text-xs text-slate-400">訂單金額</p>
                      <p className="text-lg font-semibold tabular-nums text-slate-800">
                        {order.total_amount != null
                          ? `NT$ ${Number(order.total_amount).toLocaleString()}`
                          : "尚未報價"}
                      </p>
                    </div>
                  )}
                </div>

                {/* 異常提示(取消的單不會轉客服:包含老闆/店長在叫貨分頁退回的草稿) */}
                {meta.step < 0 && (
                  <div className="mb-3 flex items-center gap-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-orange-800">
                    <TriangleAlert className="h-4 w-4 shrink-0" />
                    {order.status === "cancelled"
                      ? "這張訂單已取消"
                      : `這張訂單目前為「${meta.label}」,已交由客服跟進`}
                  </div>
                )}

                {/* 流程步驟條 */}
                <div className="mb-3">
                  <PipelineBar status={order.status} />
                </div>

                {/* 品項摘要 */}
                {itemSummary(order.ingredient_list) ?? (
                  <p className="text-xs italic text-slate-400">尚無品項明細</p>
                )}

                {showItemsLockHint && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                    <Lock className="h-3.5 w-3.5 text-slate-400" />
                    供應商已報價,品項與數量已鎖定
                    {mustApprove ? ",要改請老闆或店長退回重新報價" : ",要改請按「退回重新報價」"}
                  </p>
                )}

                {order.notes && (
                  <p className="mt-2 text-xs text-slate-500">備註:{order.notes}</p>
                )}

                {/* 停留時間 */}
                <p
                  className={`mt-3 flex items-center gap-1.5 text-xs ${
                    stuck ? "text-amber-600" : "text-slate-400"
                  }`}
                >
                  <Clock className="h-3.5 w-3.5" />
                  已在「{meta.label}」停留 {formatStageAge(since)}
                  {stuck && " —— 超過預期時間,客服已收到提醒"}
                </p>

                {/* 動作列 */}
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  <button
                    onClick={() => toggleTimeline(order.id)}
                    className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
                  >
                    <History className="h-3.5 w-3.5" />
                    {isOpen ? "收起履歷" : "查看履歷"}
                    {isOpen ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                  </button>

                  <div className="ml-auto flex flex-wrap gap-2">
                    {transitions.map((to) => {
                      const conf = ACTION_CONF[to];
                      if (!conf) return null;
                      const Icon = conf.icon;
                      return (
                        <Button
                          key={to}
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => handleAction(order, to)}
                          className={TONE_CLASS[conf.tone]}
                        >
                          {busy ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Icon className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {conf.label}
                        </Button>
                      );
                    })}
                    {transitions.length === 0 && (
                      <span className="text-xs text-slate-400">
                        {meta.waitingOn && meta.waitingOn !== "restaurant"
                          ? `等待${ROLE_LABEL[meta.waitingOn]}處理中`
                          : "目前無需操作"}
                      </span>
                    )}
                  </div>
                </div>

                {/* 完整履歷 */}
                {isOpen && (
                  <div className="mt-3 rounded-lg bg-slate-50 p-4">
                    {timelineLoading === order.id ? (
                      <div className="flex justify-center py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                      </div>
                    ) : !events || events.length === 0 ? (
                      <p className="py-2 text-center text-xs text-slate-400">尚無履歷紀錄</p>
                    ) : (
                      <ol className="space-y-3">
                        {events.map((ev) => (
                          <li key={ev.id} className="flex gap-3">
                            <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-sm font-medium text-slate-700">
                                  {statusMeta(ev.to_status).label}
                                </span>
                                <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-500">
                                  {ROLE_LABEL[ev.actor_role] ?? ev.actor_role}
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  {SOURCE_LABEL[ev.source] ?? ev.source}
                                </span>
                                <span className="text-[11px] text-slate-400">
                                  {new Date(ev.created_at).toLocaleString("zh-TW")}
                                </span>
                              </div>
                              {ev.actor_label && (
                                <p className="text-[11px] text-slate-400">{ev.actor_label}</p>
                              )}
                              {ev.note && (
                                <p className="mt-0.5 text-xs text-slate-600">{ev.note}</p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* 收貨 / 回報異常 */}
      <ReceiveOrderDialog
        open={!!receiveTarget}
        onOpenChange={(o) => {
          if (!o) setReceiveTarget(null);
        }}
        order={receiveOrderProp}
        mode={receiveTarget?.mode ?? "receive"}
        onDone={() => {
          const id = receiveTarget?.order.id;
          if (id) refreshAfterAction(id);
        }}
      />

      {/* 交易評價 */}
      <OrderReviewDialog
        open={!!reviewTarget}
        onOpenChange={(o) => {
          if (!o) setReviewTarget(null);
        }}
        order={reviewOrderProp}
        restaurantId={restaurant_id}
        onDone={() => {
          const id = reviewTarget?.id;
          if (id) refreshAfterAction(id);
        }}
      />

      {/* 取消訂單 */}
      <AlertDialog
        open={!!cancelTarget}
        onOpenChange={(o) => {
          if (!o) setCancelTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要取消這張訂單?</AlertDialogTitle>
            <AlertDialogDescription>
              取消後供應商會收到通知,這張單將不再進行。若只是想調整內容,建議先與供應商聯繫。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                const target = cancelTarget;
                setCancelTarget(null);
                if (target) advance(target, "cancelled", "餐廳端主動取消");
              }}
            >
              確定取消訂單
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 退回重新報價 */}
      <Dialog
        open={!!requoteTarget}
        onOpenChange={(o) => {
          if (!o && busyId === null) setRequoteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-orange-500" />
              退回重新報價
            </DialogTitle>
            <DialogDescription>
              訂單 {formatOrderNo(requoteTarget?.id)} —— 這份報價會作廢,訂單回到「待報價」,供應商會收到你寫的原因並重新報價。
              要改品項或數量,請在原因裡寫清楚。
            </DialogDescription>
          </DialogHeader>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">退回原因(必填)</p>
            <Textarea
              rows={4}
              value={requoteReason}
              onChange={(e) => setRequoteReason(e.target.value)}
              placeholder="例如:高麗菜改成 20 顆、價格請再優惠"
              aria-label="退回原因"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequoteTarget(null)} disabled={busyId !== null}>
              取消
            </Button>
            <Button
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={submitRequote}
              disabled={busyId !== null || !requoteReason.trim()}
            >
              {busyId !== null && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              確定退回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 申請爭議處理 */}
      <Dialog
        open={!!disputeTarget}
        onOpenChange={(o) => {
          if (!o && busyId === null) setDisputeTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldX className="h-5 w-5 text-red-500" />
              申請爭議處理
            </DialogTitle>
            <DialogDescription>
              訂單 {formatOrderNo(disputeTarget?.id)} —— 客服會介入協調並回覆處理結果
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">問題類型</p>
              <div className="flex flex-wrap gap-2">
                {DISPUTE_KINDS.map((k) => (
                  <button
                    key={k.key}
                    type="button"
                    onClick={() => setDisputeKind(k.key)}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      disputeKind === k.key
                        ? "border-red-400 bg-red-50 text-red-700"
                        : "border-slate-200 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">詳細說明</p>
              <Textarea
                rows={4}
                value={disputeDetail}
                onChange={(e) => setDisputeDetail(e.target.value)}
                placeholder="請描述事發經過與您期望的處理方式"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDisputeTarget(null)}
              disabled={busyId !== null}
            >
              取消
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={submitDispute}
              disabled={busyId !== null || !disputeDetail.trim()}
            >
              {busyId !== null && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              送出申請
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
