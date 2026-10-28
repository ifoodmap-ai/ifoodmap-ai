// 供應商後台「訂單」分區(/supplier/orders):收單、報價、出貨、送達全部在這一頁(業主拍板後台精簡 Q1-A)。
//
// - 依狀態分頁,分頁記在網址 ?stage=(舊網址 /supplier/quotes → 待報價、/supplier/shipments、
//   /supplier/logistics → 出貨紀錄,都在 App.tsx 轉址過來);通知信連結帶 ?order=<id>,
//   會自動切到那張單所在的分頁並標出來。沒帶參數就是「待處理」(所有等你動作的單)。
// - 每張單的按鈕只由 allowedTransitions("supplier", status) 產生,寫入一律 recordOrderEvent:
//   資料庫 20260929100000 再檢查一次身分與轉移(actor_id 由伺服器決定),
//   報價金額、出貨紀錄由 20260929100100 跟狀態在同一個交易裡寫 —— 這頁不直接 UPDATE / INSERT 任何表。
// - 失敗照實顯示資料庫回的訊息;畫面過期(別人剛處理過這張單)就重抓列表。
// - 💰 這頁會顯示「報價金額」(supplier_orders.total_amount,供應商自己報的價),不做任何加總。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  Inbox,
  Loader2,
  ClipboardList,
  PackageCheck,
  ReceiptText,
  Settings2,
  Truck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { supabase } from "@/integrations/supabase/client";
import {
  ORDER_STATUS,
  allowedTransitions,
  formatStageAge,
  isStaleOrderError,
  isStuck,
  recordOrderEvent,
  type OrderStatus,
} from "@/lib/orders";
import { formatOrderNo } from "@/lib/order-number";
import { deliveryLabel } from "@/lib/delivery";
import { effectivePrices, suggestQuote, type CatalogItem } from "@/lib/pricing";
import SupplierOrderSettingsDialog from "@/components/supplier/SupplierOrderSettingsDialog";
import SupplierPickListDialog from "@/components/supplier/SupplierPickListDialog";

/* 新資料表不在 types.ts 裡 —— 沿用專案既有的 cast 慣例,只描述這頁用得到的 builder */
type PgError = { message: string } | null;
interface Query<T> extends PromiseLike<{ data: T[] | null; error: PgError }> {
  select: (cols: string) => Query<T>;
  eq: (col: string, val: string | boolean) => Query<T>;
  in: (col: string, vals: string[]) => Query<T>;
  order: (col: string, opts: { ascending: boolean }) => Query<T>;
  maybeSingle: () => PromiseLike<{ data: T | null; error: PgError }>;
}
const db = <T,>(table: string): Query<T> =>
  (supabase as never as { from: (t: string) => Query<T> }).from(table);

interface OrderItem {
  name?: string;
  quantity?: string | number;
  unit?: string;
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  restaurant_id: string | null;
  ingredient_list: OrderItem[] | null;
  total_amount: number | string | null;
  notes: string | null;
  created_at: string;
  current_stage_since: string | null;
  delivery_date: string | null;
}

interface RestaurantRow {
  id: string;
  name: string;
  city: string | null;
}

/** 讓這張單變成目前狀態的那筆事件的原因:餐廳退回重新報價、管理員取消、系統逾時 */
interface ReasonEventRow {
  order_id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}

interface ShipmentRow {
  order_id: string;
  shipped_at: string | null;
  tracking_info: Record<string, unknown> | null;
  notes: string | null;
}

/* ------------------------------ 分頁 ------------------------------ */
type StageKey = "todo" | "dispatched" | "accepted" | "quoted" | "confirmed" | "shipped" | "all";

const STAGES: { key: StageKey; label: string; statuses: OrderStatus[] | null }[] = [
  { key: "todo", label: "待處理", statuses: ["dispatched", "sent", "accepted", "confirmed", "shipped", "in_transit"] },
  { key: "dispatched", label: "待接單", statuses: ["dispatched", "sent"] },
  { key: "accepted", label: "待報價", statuses: ["accepted"] },
  { key: "quoted", label: "待餐廳確認", statuses: ["quoted"] },
  { key: "confirmed", label: "待出貨", statuses: ["confirmed"] },
  // 出過貨的單(運送中、已送達、已收貨…):對應舊的「出貨紀錄」「物流追蹤」兩頁
  { key: "shipped", label: "出貨紀錄", statuses: ["shipped", "in_transit", "delivered", "received", "reviewed", "closed", "completed"] },
  { key: "all", label: "全部", statuses: null },
];

const DEFAULT_STAGE: StageKey = "todo";
const isStageKey = (v: string | null): v is StageKey => STAGES.some((s) => s.key === v);
const inStage = (status: OrderStatus, key: StageKey) => {
  const stage = STAGES.find((s) => s.key === key);
  return !stage?.statuses || stage.statuses.includes(status);
};
/** 通知信帶 ?order= 時要切到哪個分頁:要你動作的放「待處理」,其他放它自己的分頁,都沒有就「全部」 */
const stageForStatus = (status: OrderStatus): StageKey =>
  inStage(status, "todo")
    ? "todo"
    : (STAGES.find((s) => s.key !== "all" && s.key !== "todo" && s.statuses?.includes(status))?.key ?? "all");

/* ------------------------------ 動作 ------------------------------ */
interface ActionConf {
  label: string;
  icon: LucideIcon;
  tone: "primary" | "danger" | "plain";
  /** 按下去要先開哪個對話框;沒有就直接寫事件 */
  dialog?: "reject" | "quote" | "ship" | "deliver";
  /** 成功訊息用的動詞 */
  done: string;
}

/** 按鈕外觀 —— 實際出現哪幾顆完全由 allowedTransitions("supplier", status) 決定 */
const ACTION_CONF: Partial<Record<OrderStatus, ActionConf>> = {
  accepted: { label: "接單", icon: CheckCircle2, tone: "primary", done: "接單" },
  rejected: { label: "拒單", icon: XCircle, tone: "danger", dialog: "reject", done: "拒單" },
  quoted: { label: "報價", icon: ReceiptText, tone: "primary", dialog: "quote", done: "送出報價" },
  shipped: { label: "出貨", icon: Truck, tone: "primary", dialog: "ship", done: "出貨" },
  in_transit: { label: "標記運送中", icon: Truck, tone: "plain", done: "標記運送中" },
  delivered: { label: "已送達", icon: PackageCheck, tone: "primary", dialog: "deliver", done: "標記送達" },
};

const TONE_CLASS: Record<ActionConf["tone"], string> = {
  primary: "bg-emerald-600 hover:bg-emerald-700 text-white",
  danger: "bg-white border border-red-200 text-red-600 hover:bg-red-50",
  plain: "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50",
};

/** 等對方動作時給供應商看的一句話 */
const WAITING_NOTE: Partial<Record<OrderStatus, string>> = {
  quoted: "已報價,等餐廳確認後就可以出貨",
  delivered: "已送達,等餐廳確認收貨",
  received: "餐廳已確認收貨",
  reviewed: "餐廳已確認收貨並給了評價",
  closed: "這張單已結案",
  rejected: "你已拒絕這張單,平台會改派其他供應商",
  cancelled: "這張單已取消",
  expired: "這張單逾時未回應,已交回平台處理",
  discrepancy: "餐廳回報收貨有差異,平台客服會跟你聯繫",
  disputed: "這張單在爭議處理中,平台客服會跟你聯繫",
};

const statusMeta = (status: OrderStatus) =>
  ORDER_STATUS[status] ?? { label: status, className: "bg-slate-100 text-slate-600 border-slate-300" };

const money = (v: OrderRow["total_amount"]) =>
  v == null || Number.isNaN(Number(v)) ? null : `NT$ ${Number(v).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;

/** 今天(台灣本地日期,YYYY-MM-DD)—— 不用 toISOString,凌晨 0–8 點會變成昨天 */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ------------------------------ 頁面 ------------------------------ */
type DialogState =
  | { kind: "reject" | "quote" | "ship" | "deliver"; order: OrderRow; to: OrderStatus }
  | null;

export default function SupplierOrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const stageParam = searchParams.get("stage");
  const focusOrderId = searchParams.get("order");
  const stage: StageKey = isStageKey(stageParam) ? stageParam : DEFAULT_STAGE;

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [restaurants, setRestaurants] = useState<Record<string, RestaurantRow>>({});
  const [shipments, setShipments] = useState<Record<string, ShipmentRow>>({});
  const [reasons, setReasons] = useState<Record<string, ReasonEventRow>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  // 報價視窗的金額預填來源說明:依這家客戶的專屬價格 / 商品定價算出來的(可以改)
  const [quoteHint, setQuoteHint] = useState<string | null>(null);
  const [validUntil, setValidUntil] = useState("");
  const [note, setNote] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");

  const highlightRef = useRef<HTMLDivElement | null>(null);
  const focusHandled = useRef<string | null>(null);

  /* ---------- 讀取 ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { data: acct, error } = await db<{ supplier_id: string }>("supplier_accounts")
        .select("supplier_id")
        .eq("user_id", session.user.id)
        .eq("is_active", true)
        .maybeSingle();
      if (cancelled) return;
      if (error || !acct) {
        setLoadError(error?.message ?? "找不到你的供應商帳號");
        setLoading(false);
        return;
      }
      setSupplierId(acct.supplier_id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchOrders = useCallback(async (sid: string) => {
    const { data, error } = await db<OrderRow>("supplier_orders")
      .select("id, status, restaurant_id, ingredient_list, total_amount, notes, created_at, current_stage_since, delivery_date")
      .eq("supplier_id", sid)
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(error.message);
      setOrders([]);
      return;
    }
    setLoadError(null);
    const list = data ?? [];
    setOrders(list);

    const restaurantIds = [...new Set(list.map((o) => o.restaurant_id).filter((v): v is string => !!v))];
    const [rest, ship] = await Promise.all([
      restaurantIds.length
        ? db<RestaurantRow>("restaurants").select("id, name, city").in("id", restaurantIds)
        : Promise.resolve({ data: [] as RestaurantRow[], error: null }),
      db<ShipmentRow>("supplier_shipments")
        .select("order_id, shipped_at, tracking_info, notes")
        .eq("supplier_id", sid)
        .order("shipped_at", { ascending: true }),
    ]);
    const rMap: Record<string, RestaurantRow> = {};
    (rest.data ?? []).forEach((r) => {
      rMap[r.id] = r;
    });
    setRestaurants(rMap);
    const sMap: Record<string, ShipmentRow> = {};
    // 依出貨時間由舊到新,同一張單留最後一筆
    (ship.data ?? []).forEach((s) => {
      sMap[s.order_id] = s;
    });
    setShipments(sMap);

    // 待報價(被退回重新報價)、已取消、逾時的單:把原因撈出來顯示(讀不到只是少一行說明,不擋列表)
    const reasonIds = list.filter((o) => ["accepted", "cancelled", "expired"].includes(o.status)).map((o) => o.id);
    if (reasonIds.length > 0) {
      const { data: evs } = await db<ReasonEventRow>("order_events")
        .select("order_id, from_status, to_status, note, created_at")
        .in("order_id", reasonIds)
        .in("to_status", ["accepted", "cancelled", "expired"])
        // 新到舊:筆數超過 PostgREST 上限時被截掉的是最舊的,不會漏掉造成目前狀態的那一筆
        .order("created_at", { ascending: false });
      // 「造成目前狀態」的那一筆 = 最新一筆進到目前狀態的事件(前端再排一次,不依賴回傳順序)
      const statusOf = new Map(list.map((o) => [o.id, o.status]));
      const latest: Record<string, ReasonEventRow> = {};
      [...(evs ?? [])]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .forEach((ev) => {
          if (!latest[ev.order_id] && ev.to_status === statusOf.get(ev.order_id)) latest[ev.order_id] = ev;
        });
      // 待報價只有「退回重新報價」(quoted → accepted)才有原因;供應商接單(包含改派後新的供應商接單)不算 ——
      // 不然改派後的新供應商會看到以前寫給上一家的退回原因
      const reasonMap: Record<string, ReasonEventRow> = {};
      Object.values(latest).forEach((ev) => {
        if (ev.to_status !== "accepted" || ev.from_status === "quoted") reasonMap[ev.order_id] = ev;
      });
      setReasons(reasonMap);
    } else {
      setReasons({});
    }
  }, []);

  useEffect(() => {
    if (!supplierId) return;
    (async () => {
      setLoading(true);
      await fetchOrders(supplierId);
      setLoading(false);
    })();
  }, [supplierId, fetchOrders]);

  /* ---------- 通知信的 ?order=:切到那張單的分頁並標出來 ---------- */
  useEffect(() => {
    if (!focusOrderId || loading || focusHandled.current === focusOrderId) return;
    const target = orders.find((o) => o.id === focusOrderId);
    if (!target) return;
    focusHandled.current = focusOrderId;
    if (!stageParam) {
      const next = new URLSearchParams(searchParams);
      next.set("stage", stageForStatus(target.status));
      setSearchParams(next, { replace: true });
    }
  }, [focusOrderId, loading, orders, stageParam, searchParams, setSearchParams]);

  useEffect(() => {
    highlightRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [stage, focusOrderId, loading]);

  /* ---------- 分頁 ---------- */
  const counts = useMemo(() => {
    const c = {} as Record<StageKey, number>;
    STAGES.forEach(({ key }) => {
      c[key] = orders.filter((o) => inStage(o.status, key)).length;
    });
    return c;
  }, [orders]);

  const visible = useMemo(() => orders.filter((o) => inStage(o.status, stage)), [orders, stage]);

  const selectStage = (key: StageKey) => {
    const next = new URLSearchParams(searchParams);
    if (key === DEFAULT_STAGE) next.delete("stage");
    else next.set("stage", key);
    setSearchParams(next);
  };

  /* ---------- 寫事件 ---------- */
  const resetForm = () => {
    setDialogError(null);
    setReason("");
    setAmount("");
    setQuoteHint(null);
    setValidUntil("");
    setNote("");
    setCarrier("");
    setTrackingNo("");
  };

  const perform = async (
    order: OrderRow,
    to: OrderStatus,
    extra: { note?: string | null; payload?: Record<string, unknown> } = {},
  ): Promise<boolean> => {
    setBusyId(order.id);
    try {
      await recordOrderEvent({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: to,
        actorRole: "supplier",
        source: "supplier_portal",
        note: extra.note ?? null,
        payload: extra.payload,
      });
      toast.success(`訂單 ${formatOrderNo(order.id)} 已${ACTION_CONF[to]?.done ?? "更新"}`);
      if (supplierId) await fetchOrders(supplierId);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "操作失敗";
      toast.error("操作失敗", { description: message });
      setDialogError(message);
      // 別人剛處理過這張單:重抓,畫面才會是最新狀態
      if (isStaleOrderError(e) && supplierId) await fetchOrders(supplierId);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  /** 報價預填:用這家客戶的專屬價格、沒有就用他所屬群組的價格、再沒有就用商品定價算每個品項,每個都算得出來才預填;失敗就不預填 */
  const prefillQuote = async (order: OrderRow) => {
    if (!supplierId || !order.restaurant_id) return;
    try {
      const [{ data: supplies }, { data: prices }, { data: membership }] = await Promise.all([
        db<{ id: string; name: string; sku: string | null; unit: string | null; price: number | string | null }>("supplies")
          .select("id, name, sku, unit, price")
          .eq("supplier_id", supplierId),
        db<{ supply_id: string; price: number | string }>("supplier_customer_prices")
          .select("supply_id, price")
          .eq("supplier_id", supplierId)
          .eq("restaurant_id", order.restaurant_id),
        db<{ group_id: string }>("supplier_customer_group_members")
          .select("group_id")
          .eq("supplier_id", supplierId)
          .eq("restaurant_id", order.restaurant_id),
      ]);
      const groupId = membership?.[0]?.group_id;
      const { data: gPrices } = groupId
        ? await db<{ supply_id: string; price: number | string }>("supplier_group_prices").select("supply_id, price").eq("group_id", groupId)
        : { data: [] as { supply_id: string; price: number | string }[] };
      const catalog: CatalogItem[] = (supplies ?? []).map((c) => ({ id: c.id, name: c.name, sku: c.sku, unit: c.unit, price: c.price == null ? null : Number(c.price) }));
      const special = effectivePrices(
        new Map((gPrices ?? []).map((p) => [p.supply_id, Number(p.price)])),
        new Map((prices ?? []).map((p) => [p.supply_id, Number(p.price)])),
      );
      const suggested = suggestQuote(
        (Array.isArray(order.ingredient_list) ? order.ingredient_list : []).map((i) => ({ name: i.name ?? "", quantity: i.quantity ?? "" })),
        catalog,
        special,
      );
      if (suggested != null) {
        // 供應商已經自己打了字就不蓋掉
        setAmount((cur) => (cur === "" ? String(suggested) : cur));
        setQuoteHint(special.size > 0 ? "金額已依這家客戶的專屬價格、群組價格與商品定價預填,請確認後再送出(可以修改)" : "金額已依商品定價預填,請確認後再送出(可以修改)");
      }
    } catch {
      /* 預填失敗就讓供應商自己填 */
    }
  };

  const handleAction = (order: OrderRow, to: OrderStatus) => {
    const conf = ACTION_CONF[to];
    if (conf?.dialog) {
      resetForm();
      if (conf.dialog === "quote" && order.total_amount != null) setAmount(String(Number(order.total_amount)));
      setDialog({ kind: conf.dialog, order, to });
      if (conf.dialog === "quote" && order.total_amount == null) void prefillQuote(order);
      return;
    }
    void perform(order, to);
  };

  const closeDialog = () => {
    setDialog(null);
    resetForm();
  };

  const submitDialog = async () => {
    if (!dialog) return;
    const { kind, order, to } = dialog;
    setDialogError(null);

    let ok = false;
    if (kind === "reject") {
      const r = reason.trim();
      if (!r) {
        setDialogError("請填寫拒單原因,平台改派時會參考");
        return;
      }
      ok = await perform(order, to, { note: r, payload: { reason: r } });
    } else if (kind === "quote") {
      const n = Number(amount);
      if (!amount.trim() || !Number.isFinite(n) || n <= 0) {
        setDialogError("請輸入大於 0 的報價金額");
        return;
      }
      if (validUntil && validUntil < today()) {
        setDialogError("報價有效日期不能早於今天");
        return;
      }
      const payload: Record<string, unknown> = { total_amount: Math.round(n * 100) / 100 };
      if (validUntil) payload.valid_until = validUntil;
      ok = await perform(order, to, { note: note.trim() || null, payload });
    } else if (kind === "ship") {
      const tracking: Record<string, string> = {};
      if (carrier.trim()) tracking.carrier = carrier.trim();
      if (trackingNo.trim()) tracking.tracking_number = trackingNo.trim();
      ok = await perform(order, to, { note: note.trim() || null, payload: { tracking } });
    } else {
      ok = await perform(order, to, { note: note.trim() || null });
    }
    if (ok) closeDialog();
  };

  /* ---------- 畫面 ---------- */
  const itemChips = (list: OrderItem[] | null) => {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length === 0) return <p className="text-xs text-slate-400">(沒有品項明細)</p>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {arr.slice(0, 8).map((it, i) => (
          <span key={i} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
            {it.name ?? `品項 ${i + 1}`}
            {it.quantity != null && it.quantity !== "" ? ` · ${it.quantity}${it.unit ?? ""}` : ""}
          </span>
        ))}
        {arr.length > 8 && (
          <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-400">…共 {arr.length} 項</span>
        )}
      </div>
    );
  };

  const customerNames = useMemo(
    () => Object.fromEntries(Object.values(restaurants).map((r) => [r.id, r.name])),
    [restaurants],
  );
  const dialogOrderNo = dialog ? formatOrderNo(dialog.order.id) : "";
  const dialogBusy = dialog ? busyId === dialog.order.id : false;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">訂單</h1>
          <p className="mb-4 mt-1 text-sm text-slate-500">接單、報價、出貨、送達都在這裡;每一步都會通知餐廳</p>
        </div>
        {supplierId && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPickOpen(true)}>
              <ClipboardList className="h-4 w-4 mr-1.5" />
              出貨彙總
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-4 w-4 mr-1.5" />
              接單設定
            </Button>
          </div>
        )}
      </div>

      {/* 狀態分頁:手機放不下時橫向捲 */}
      <div
        role="tablist"
        aria-label="訂單狀態"
        className="mb-4 flex w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1"
      >
        {STAGES.map((s) => {
          const active = s.key === stage;
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectStage(s.key)}
              className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {s.label}
              {counts[s.key] > 0 && (
                <span className={`ml-1 text-xs ${active ? "text-emerald-600" : "text-slate-400"}`}>{counts[s.key]}</span>
              )}
            </button>
          );
        })}
      </div>

      {loadError ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-700">
          讀取訂單失敗:{loadError}
        </div>
      ) : loading ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="mb-3 h-5 w-40" />
              <Skeleton className="mb-2 h-6 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-16 text-center text-slate-400">
          <Inbox className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">
            {orders.length === 0 ? "還沒有派給你的訂單 —— 平台派單後會寄信通知你" : "這個分頁目前沒有訂單"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((order) => {
            const meta = statusMeta(order.status);
            const since = order.current_stage_since ?? order.created_at;
            const stuck = isStuck(order.status, since);
            const actions = allowedTransitions("supplier", order.status);
            const restaurant = order.restaurant_id ? restaurants[order.restaurant_id] : undefined;
            const shipment = shipments[order.id];
            const reason = reasons[order.id];
            const tracking = shipment?.tracking_info ?? {};
            const carrierText = typeof tracking.carrier === "string" ? tracking.carrier : null;
            const trackingText = typeof tracking.tracking_number === "string" ? tracking.tracking_number : null;
            const busy = busyId === order.id;
            const highlighted = order.id === focusOrderId;
            const amountText = money(order.total_amount);

            return (
              <Card
                key={order.id}
                ref={highlighted ? highlightRef : undefined}
                data-testid={`supplier-order-${order.id}`}
                data-highlighted={highlighted ? "true" : undefined}
                className={`p-4 ${highlighted ? "border-emerald-400 ring-2 ring-emerald-200" : "border-slate-200"}`}
              >
                <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-800">{formatOrderNo(order.id)}</span>
                      <Badge variant="outline" className={meta.className}>
                        {meta.label}
                      </Badge>
                      {stuck && (
                        <Badge variant="outline" className="border-red-300 bg-red-50 text-red-700">
                          已超過處理時限
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-700">
                      {restaurant?.name ?? "餐廳"}
                      {restaurant?.city ? <span className="text-slate-400"> · {restaurant.city}</span> : null}
                    </p>
                    <p className="text-xs text-slate-400">
                      {new Date(order.created_at).toLocaleDateString("zh-TW")} 下單 · 這一關已停留 {formatStageAge(since)}
                    </p>
                    {deliveryLabel(order.delivery_date) && (
                      <p className="text-xs font-medium text-emerald-700" data-testid={`delivery-${order.id}`}>
                        配送日 {deliveryLabel(order.delivery_date)}
                      </p>
                    )}
                  </div>
                  {amountText && (
                    <div className="text-right">
                      <p className="text-xs text-slate-400">報價金額</p>
                      <p className="text-base font-semibold tabular-nums text-slate-800">{amountText}</p>
                    </div>
                  )}
                </div>

                {itemChips(order.ingredient_list)}

                {order.notes && <p className="mt-2 text-xs text-slate-500">餐廳備註:{order.notes}</p>}

                {reason && (
                  <p
                    data-testid={`reason-${order.id}`}
                    className={`mt-2 rounded-md px-3 py-2 text-xs ${
                      reason.to_status === "accepted" ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"
                    }`}
                  >
                    {reason.to_status === "accepted"
                      ? `餐廳退回報價,請重新報價:${reason.note ?? "(沒有寫原因)"}`
                      : reason.to_status === "cancelled"
                        ? `取消原因:${reason.note ?? "(沒有寫原因)"}`
                        : `逾時:${reason.note ?? "超過處理時限,已交回平台"}`}
                  </p>
                )}

                {shipment && (
                  <p className="mt-2 text-xs text-slate-500">
                    出貨:{shipment.shipped_at ? new Date(shipment.shipped_at).toLocaleString("zh-TW") : "—"}
                    {carrierText ? ` · ${carrierText}` : ""}
                    {trackingText ? ` · 單號 ${trackingText}` : ""}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {actions.length > 0 ? (
                    actions.map((to) => {
                      const conf = ACTION_CONF[to];
                      if (!conf) return null;
                      const Icon = conf.icon;
                      return (
                        <Button
                          key={to}
                          size="sm"
                          disabled={busy}
                          onClick={() => handleAction(order, to)}
                          className={TONE_CLASS[conf.tone]}
                        >
                          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Icon className="mr-1.5 h-4 w-4" />}
                          {conf.label}
                        </Button>
                      );
                    })
                  ) : (
                    <p className="text-xs text-slate-500">{WAITING_NOTE[order.status] ?? "目前不需要你處理"}</p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!dialog} onOpenChange={(open) => (!open && !dialogBusy ? closeDialog() : undefined)}>
        <DialogContent className="max-w-md">
          {dialog?.kind === "reject" && (
            <DialogHeader>
              <DialogTitle>拒絕訂單 {dialogOrderNo}</DialogTitle>
              <DialogDescription>拒單後平台會改派其他供應商。請寫下原因(缺貨、送不到、價格…)。</DialogDescription>
            </DialogHeader>
          )}
          {dialog?.kind === "quote" && (
            <DialogHeader>
              <DialogTitle>報價 {dialogOrderNo}</DialogTitle>
              <DialogDescription>送出後訂單會變成「待確認」,並寄信請餐廳確認;餐廳確認後才出貨。</DialogDescription>
            </DialogHeader>
          )}
          {dialog?.kind === "ship" && (
            <DialogHeader>
              <DialogTitle>出貨 {dialogOrderNo}</DialogTitle>
              <DialogDescription>會寄信通知餐廳已出貨。物流資訊可以不填。</DialogDescription>
            </DialogHeader>
          )}
          {dialog?.kind === "deliver" && (
            <DialogHeader>
              <DialogTitle>標記送達 {dialogOrderNo}</DialogTitle>
              <DialogDescription>會寄信請餐廳清點並按「已收到貨」。確定貨已經送到了嗎?</DialogDescription>
            </DialogHeader>
          )}

          <div className="space-y-3">
            {dialog?.kind === "reject" && (
              <div className="space-y-1.5">
                <Label htmlFor="reject-reason">拒單原因(必填)</Label>
                <Textarea
                  id="reject-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="例如:這週高麗菜缺貨"
                  rows={3}
                />
              </div>
            )}
            {dialog?.kind === "quote" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="quote-amount">報價總金額(新台幣,必填)</Label>
                  <Input
                    id="quote-amount"
                    inputMode="decimal"
                    type="number"
                    min="0"
                    step="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="例如:3200"
                  />
                  {quoteHint && <p className="text-xs text-emerald-700" data-testid="quote-hint">{quoteHint}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="quote-valid-until">報價有效到(可不填)</Label>
                  <Input
                    id="quote-valid-until"
                    type="date"
                    min={today()}
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                </div>
              </>
            )}
            {dialog?.kind === "ship" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ship-carrier">物流(可不填)</Label>
                  <Input id="ship-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="自有車隊 / 黑貓…" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ship-tracking">追蹤單號(可不填)</Label>
                  <Input id="ship-tracking" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
                </div>
              </div>
            )}
            {dialog && dialog.kind !== "reject" && (
              <div className="space-y-1.5">
                <Label htmlFor="action-note">備註(可不填,餐廳看得到)</Label>
                <Textarea id="action-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </div>
            )}
            {dialogError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {dialogError}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeDialog} disabled={dialogBusy}>
              取消
            </Button>
            <Button
              onClick={submitDialog}
              disabled={dialogBusy}
              className={dialog?.kind === "reject" ? "bg-red-600 hover:bg-red-700 text-white" : "bg-emerald-600 hover:bg-emerald-700 text-white"}
            >
              {dialogBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {dialog?.kind === "reject"
                ? "確定拒單"
                : dialog?.kind === "quote"
                  ? "送出報價"
                  : dialog?.kind === "ship"
                    ? "確定出貨"
                    : "確定已送達"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {supplierId && (
        <>
          <SupplierOrderSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} supplierId={supplierId} />
          <SupplierPickListDialog open={pickOpen} onOpenChange={setPickOpen} orders={orders} customerNames={customerNames} />
        </>
      )}
    </div>
  );
}
