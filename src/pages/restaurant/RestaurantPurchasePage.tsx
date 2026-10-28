import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  Sparkles, Plus, Trash2, Loader2, ShoppingCart, ClipboardCheck,
  History, Send, PackagePlus, Hourglass, Undo2, Minus, Store,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant, needsApproval } from "@/components/RestaurantRoute";
import { ANALYSIS_HANDOFF_KEY } from "./RestaurantAnalyzePage";
import { recordOrderEvent } from "@/lib/orders";
import type { ClaimedDraftLocationState } from "@/hooks/use-landing-handoff-claim";
import SupplyThumb from "@/components/SupplyThumb";
import { buildSupplyImageLookup, type SupplyImageLookup, type SupplyImageRow } from "@/lib/supply-images";

/* ── 新資料表不在 types.ts,沿用專案的 loose cast 慣例 ─────────────── */
type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: unknown[]): Q<T>;
  not(col: string, op: string, val: unknown): Q<T>;
  gte(col: string, val: unknown): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  limit(n: number): Q<T>;
  single(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
  insert(values: unknown): Q<T>;
  update(values: unknown): Q<T>;
  delete(): Q<T>;
}
const db = <T,>(table: string): Q<T> =>
  (supabase as never as { from: (t: string) => Q<T> }).from(table);

interface RawIngredient {
  name?: string;
  quantity?: string | number;
  unit?: string;
  category?: string;
  reference_price?: string | number;
}

interface OrderRow {
  id: string;
  created_at: string;
  status: string;
  ingredient_list: RawIngredient[] | null;
  created_by: string | null;
  approved_by: string | null;
  notes: string | null;
  supplier_id?: string | null;
}

/** 過往叫過的品項:進頁就全部列出,預設都在這張單裡,不要的刪掉、數量與參考價自己調 */
interface HistoryItem {
  name: string;
  unit: string;
  quantity: string;
  referencePrice: string;
  times: number;
  daysSince: number;
  /** 叫過兩次以上才算得出週期;只叫過一次是 0 */
  avgCycle: number;
  due: boolean;
  /** 最近一次叫這個品項的供應商,配對商品縮圖時優先找這家 */
  supplierId: string | null;
}

interface ManualItem {
  key: string;
  name: string;
  quantity: string;
  unit: string;
  referencePrice: string;
}

/** 這家店已綁定的合作供應商(叫貨只能叫這些) */
interface Partner {
  id: string;
  name: string;
}

const DAY = 86_400_000;
const dayDiff = (a: number, b: number) => Math.max(0, Math.round((a - b) / DAY));

/** 數量 / 參考價欄只收數字與一個小數點 */
const numericOnly = (v: string) => /^\d*\.?\d*$/.test(v);

/** ± 按鈕:數量不是數字(例如舊單寫「3箱」)就從 0 起算;最少停在 1,要拿掉請按刪除 */
const stepQuantity = (current: string, delta: 1 | -1) => {
  const n = Number.parseFloat(current);
  const base = Number.isFinite(n) ? n : 0;
  const next = Math.max(1, Math.round((base + delta) * 100) / 100);
  return String(next);
};

const toPrice = (v: string) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

interface QtyStepperProps {
  value: string;
  name: string;
  onChange: (v: string) => void;
}

const QtyStepper = ({ value, name, onChange }: QtyStepperProps) => (
  <div className="flex items-center">
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-9 w-9 rounded-r-none shrink-0"
      aria-label={`${name} 數量減 1`}
      onClick={() => onChange(stepQuantity(value, -1))}
    >
      <Minus className="h-3.5 w-3.5" />
    </Button>
    <Input
      value={value}
      inputMode="decimal"
      onChange={(e) => { if (numericOnly(e.target.value)) onChange(e.target.value); }}
      className="h-9 w-16 rounded-none text-center border-x-0"
      placeholder="數量"
      aria-label={`${name} 數量`}
    />
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-9 w-9 rounded-l-none shrink-0"
      aria-label={`${name} 數量加 1`}
      onClick={() => onChange(stepQuantity(value, 1))}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  </div>
);

interface PriceInputProps {
  value: string;
  name: string;
  unit: string;
  onChange: (v: string) => void;
}

const PriceInput = ({ value, name, unit, onChange }: PriceInputProps) => (
  <div className="flex items-center gap-1 shrink-0">
    <span className="text-xs text-slate-400">參考價 $</span>
    <Input
      value={value}
      inputMode="decimal"
      onChange={(e) => { if (numericOnly(e.target.value)) onChange(e.target.value); }}
      className="h-9 w-20"
      placeholder="選填"
      aria-label={`${name} 參考價`}
    />
    <span className="text-xs text-slate-400 w-9 truncate">{unit ? `/ ${unit}` : ""}</span>
  </div>
);

const RestaurantPurchasePage = () => {
  const account = useRestaurant();
  const mustApprove = needsApproval(account.role);
  const canBind = account.role === "owner" || account.role === "manager";
  // 形象站 AI 對話剛被認領成草稿時,RestaurantLayout 會帶著 claimedOrderId 導過來
  const claimedOrderId =
    (useLocation().state as Partial<ClaimedDraftLocationState> | null)?.claimedOrderId ?? null;

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [removed, setRemoved] = useState<HistoryItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // 合作供應商:叫貨先選一家,訂單直接送給他(從「待接單」開始,不經管理員派發)
  const [partners, setPartners] = useState<Partner[]>([]);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const preferredSupplier = searchParams.get("supplier");
  // 叫貨品項的商品縮圖:用品名配對往來供應商上架的商品圖片;純裝飾,讀不到就都顯示佔位
  const [thumbOf, setThumbOf] = useState<SupplyImageLookup>(() => () => null);
  // AI 菜單分析頁按「帶到智慧採購」時暫存的食材,進頁時接手
  const [manual, setManual] = useState<ManualItem[]>(() => {
    try {
      const raw = sessionStorage.getItem(ANALYSIS_HANDOFF_KEY);
      if (!raw) return [];
      sessionStorage.removeItem(ANALYSIS_HANDOFF_KEY);
      const names = JSON.parse(raw) as unknown;
      if (!Array.isArray(names)) return [];
      return names
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .map((name, i) => ({ key: `handoff-${i}`, name: name.trim(), quantity: "", unit: "kg", referencePrice: "" }));
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState({ name: "", quantity: "", unit: "", referencePrice: "" });
  const [notes, setNotes] = useState("");
  const [drafts, setDrafts] = useState<OrderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [returnTarget, setReturnTarget] = useState<OrderRow | null>(null);

  const loadDrafts = async () => {
    const { data } = await db<OrderRow>("supplier_orders")
      .select("id, created_at, status, ingredient_list, created_by, approved_by, notes")
      .eq("restaurant_id", account.restaurant_id)
      .eq("status", "draft")
      .order("created_at", { ascending: false });
    setDrafts(data ?? []);
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (reloadKey === 0) setLoading(true);
      setRemoved([]);
      const { data: { user } } = await supabase.auth.getUser();
      if (!cancelled) setUserId(user?.id ?? null);

      const { data: orders } = await db<OrderRow>("supplier_orders")
        .select("id, created_at, status, ingredient_list, created_by, approved_by, notes, supplier_id")
        .eq("restaurant_id", account.restaurant_id)
        .order("created_at", { ascending: false })
        .limit(300);

      // orders 由新到舊:每個品項的單位 / 數量 / 參考價取「最近一次」叫貨時的
      const history = new Map<string, { name: string; dates: number[]; unit: string; quantity: string; price: string; times: number; supplierId: string }>();
      (orders ?? [])
        // 沒有供應商的單(還在媒合、等管理員派發)不是例行叫貨,不列進品項
        .filter((o) => o.status !== "cancelled" && o.status !== "draft" && !!o.supplier_id)
        .forEach((o) => {
          const at = new Date(o.created_at).getTime();
          if (!Number.isFinite(at)) return;
          const list = Array.isArray(o.ingredient_list) ? o.ingredient_list : [];
          const seen = new Set<string>();
          list.forEach((raw) => {
            const name = (raw?.name ?? "").trim();
            if (!name || seen.has(name)) return;
            seen.add(name);
            const key = `${o.supplier_id}|${name}`;
            const prev = history.get(key);
            const qty = raw?.quantity != null ? String(raw.quantity) : "";
            const price = raw?.reference_price != null ? String(raw.reference_price) : "";
            if (prev) {
              prev.dates.push(at);
              prev.times += 1;
              if (!prev.price && price) prev.price = price;
            } else {
              history.set(key, { name, dates: [at], unit: raw?.unit ?? "", quantity: qty, price, times: 1, supplierId: o.supplier_id as string });
            }
          });
        });

      const now = Date.now();
      const list: HistoryItem[] = [];

      history.forEach((v) => {
        const name = v.name;
        const dates = [...v.dates].sort((x, y) => x - y);
        const last = dates[dates.length - 1];
        const daysSince = dayDiff(now, last);
        const avgCycle = dates.length >= 2
          ? Math.max(1, Math.round((last - dates[0]) / (dates.length - 1) / DAY))
          : 0;
        list.push({
          name,
          unit: v.unit,
          quantity: v.quantity || "1",
          referencePrice: v.price,
          times: v.times,
          daysSince,
          avgCycle,
          due: avgCycle > 0 && daysSince >= avgCycle,
          supplierId: v.supplierId,
        });
      });

      // 該補貨的排前面(越超期越前面),其餘依叫過的次數
      list.sort((x, y) => {
        if (x.due !== y.due) return x.due ? -1 : 1;
        if (x.due && y.due) return y.daysSince / y.avgCycle - x.daysSince / x.avgCycle;
        return y.times - x.times;
      });

      if (!cancelled) setItems(list);

      // 已綁定、還在營業的合作供應商
      let partnerList: Partner[] = [];
      try {
        const { data: bound } = await db<{ supplier_id: string }>("restaurant_suppliers")
          .select("supplier_id")
          .eq("restaurant_id", account.restaurant_id);
        const boundIds = (bound ?? []).map((b) => b.supplier_id);
        if (boundIds.length > 0) {
          const { data: sups } = await db<{ id: string; name: string; is_active: boolean | null }>("suppliers")
            .select("id, name, is_active")
            .in("id", boundIds);
          partnerList = (sups ?? [])
            .filter((x) => x.is_active !== false)
            .map((x) => ({ id: x.id, name: x.name }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        }
      } catch {
        partnerList = [];
      }
      if (!cancelled) {
        setPartners(partnerList);
        // 預設選誰:網址指定的(從「我的供應商」按「向他叫貨」帶來)→ 之前選的 → 最近叫過貨的 → 第一家
        const lastOrdered = (orders ?? []).find((o) => o.supplier_id && partnerList.some((x) => x.id === o.supplier_id))?.supplier_id ?? null;
        setSupplierId((cur) => {
          const ids = new Set(partnerList.map((x) => x.id));
          if (preferredSupplier && ids.has(preferredSupplier)) return preferredSupplier;
          if (cur && ids.has(cur)) return cur;
          return lastOrdered ?? partnerList[0]?.id ?? null;
        });
      }

      try {
        const supplierIds = Array.from(
          new Set((orders ?? []).map((o) => o.supplier_id).filter((id): id is string => !!id)),
        );
        if (supplierIds.length > 0) {
          const { data: imgs } = await db<SupplyImageRow>("supplies")
            .select("supplier_id, name, image_path")
            .in("supplier_id", supplierIds)
            .not("image_path", "is", null);
          if (!cancelled) setThumbOf(() => buildSupplyImageLookup(imgs ?? []));
        } else if (!cancelled) {
          setThumbOf(() => () => null);
        }
      } catch {
        if (!cancelled) setThumbOf(() => () => null);
      }

      await loadDrafts();
      if (!cancelled) setLoading(false);
    };

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.restaurant_id, reloadKey]);

  // 本來就停在這一頁時才認領完成(直接打 /restaurant/purchase 進來):第一次載入可能早於草稿建立,
  // 收到 claimedOrderId 就再抓一次待簽核清單,剛建好的 AI 草稿才看得到
  useEffect(() => {
    if (!claimedOrderId) return;
    void loadDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimedOrderId]);

  interface CartItem {
    name: string;
    quantity: string;
    unit: string;
    reference_price?: number;
    source: "ai" | "manual";
  }

  // 只顯示選中的供應商過往叫過的品項(例行叫貨:一張單一家供應商)
  const visibleItems = useMemo(() => items.filter((i) => i.supplierId === supplierId), [items, supplierId]);
  const visibleRemoved = useMemo(() => removed.filter((i) => i.supplierId === supplierId), [removed, supplierId]);
  const supplierName = partners.find((x) => x.id === supplierId)?.name ?? "";

  const cart = useMemo(() => {
    const picked: CartItem[] = visibleItems.map((i) => ({
      name: i.name, quantity: i.quantity, unit: i.unit, reference_price: toPrice(i.referencePrice), source: "ai",
    }));
    const extra: CartItem[] = manual.map((m) => ({
      name: m.name, quantity: m.quantity, unit: m.unit, reference_price: toPrice(m.referencePrice), source: "manual",
    }));
    // 同名只留一筆(手動輸入優先)
    const merged = new Map<string, CartItem>();
    [...picked, ...extra].forEach((i) => {
      const name = i.name.trim();
      if (!name) return;
      const { reference_price, ...rest } = i;
      merged.set(name, { ...rest, name, ...(reference_price !== undefined ? { reference_price } : {}) });
    });
    return [...merged.values()];
  }, [visibleItems, manual]);

  const same = (a: HistoryItem, b: { name: string; supplierId: string | null }) => a.name === b.name && a.supplierId === b.supplierId;

  const updateItem = (name: string, patch: Partial<HistoryItem>) =>
    setItems((prev) => prev.map((x) => (same(x, { name, supplierId }) ? { ...x, ...patch } : x)));

  const removeItem = (item: HistoryItem) => {
    setItems((prev) => prev.filter((x) => !same(x, item)));
    setRemoved((prev) => (prev.some((x) => same(x, item)) ? prev : [...prev, item]));
  };

  const restoreItem = (item: HistoryItem) => {
    setRemoved((prev) => prev.filter((x) => !same(x, item)));
    setItems((prev) => (prev.some((x) => same(x, item)) ? prev : [...prev, item]));
  };

  const addManual = (name?: string, quantity?: string, unit?: string) => {
    const n = (name ?? form.name).trim();
    if (!n) return;
    setManual((prev) =>
      prev.some((m) => m.name === n)
        ? prev
        : [...prev, {
            key: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: n,
            quantity: (quantity ?? form.quantity).trim() || "1",
            unit: (unit ?? form.unit).trim(),
            referencePrice: form.referencePrice.trim(),
          }],
    );
    if (!name) setForm({ name: "", quantity: "", unit: "", referencePrice: "" });
  };

  const submit = async () => {
    if (!supplierId) {
      toast.error("請先選擇要叫貨的合作供應商");
      return;
    }
    if (cart.length === 0) {
      toast.error("請先加入至少一項食材");
      return;
    }
    const noQty = cart.find((i) => {
      const q = i.quantity.trim();
      return q === "" || !(Number.parseFloat(q) > 0);
    });
    if (noQty) {
      toast.error("請確認每一項的數量", { description: `「${noQty.name}」還沒有填數量,或數量不是大於 0 的數字` });
      return;
    }
    setSubmitting(true);
    let draftId: string | null = null;
    try {
      const { data, error } = await db<{ id: string }>("supplier_orders")
        .insert({
          restaurant_id: account.restaurant_id,
          branch_id: account.branch_id,
          created_by: userId,
          ingredient_list: cart,
          status: "draft",
          notes: notes.trim() || null,
        })
        .select("id")
        .single();

      if (error || !data) throw new Error(error?.message ?? "建立採購單失敗");
      draftId = data.id;

      // 向綁定的合作供應商叫貨:草稿直接進供應商的「待接單」,不經管理員派發,採購員也不用簽核。
      // 供應商一定要是這家店已綁定的 —— 資料庫會檢查(guard_restaurant_direct_dispatch)
      await recordOrderEvent({
        orderId: data.id,
        fromStatus: "draft",
        toStatus: "dispatched",
        actorRole: "restaurant",
        source: "restaurant_portal",
        note: `${account.restaurant_name} 向 ${supplierName} 叫貨(${cart.length} 項)`,
        payload: { supplier_id: supplierId, item_count: cart.length },
      });
      toast.success(`已送出給 ${supplierName},等待供應商接單`);

      // 剛送出的品項會變成「最近一次叫貨」:重抓一次,清單回到乾淨的起點
      setReloadKey((k) => k + 1);
      setManual([]);
      setNotes("");
      await loadDrafts();
    } catch (e) {
      // 草稿建好了、叫貨卻被擋下(例如剛好被解除綁定):把這張草稿取消,免得變成待簽核區裡一張沒人要的單
      if (draftId) {
        try {
          await recordOrderEvent({
            orderId: draftId,
            fromStatus: "draft",
            toStatus: "cancelled",
            actorRole: "restaurant",
            source: "restaurant_portal",
            note: "叫貨失敗,自動取消草稿",
          });
        } catch {
          /* 取消不了就留著,不再打斷錯誤訊息 */
        }
        await loadDrafts();
      }
      toast.error("送出失敗", { description: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  /** 這張單在畫面載入後已被別人處理(核准、退回或取消):提示並重抓清單,不再寫任何東西 */
  const handledElsewhere = async () => {
    toast.error("這張採購單已經被處理", { description: "可能已由其他人核准或退回,清單已重新整理" });
    await loadDrafts();
  };

  const approve = async (order: OrderRow) => {
    setApprovingId(order.id);
    try {
      // 只在還是草稿時記下核准人:停在舊畫面時,不會把別人剛退回/送出的單再核准一次
      const { data: stamped, error } = await db<{ id: string }>("supplier_orders")
        .update({ approved_by: userId, approved_at: new Date().toISOString() })
        .eq("id", order.id)
        .eq("status", "draft")
        .select("id");
      if (error) throw new Error(error.message);
      if (!stamped || stamped.length === 0) {
        await handledElsewhere();
        return;
      }

      await recordOrderEvent({
        orderId: order.id,
        fromStatus: "draft",
        toStatus: "submitted",
        actorRole: "restaurant",
        source: "restaurant_portal",
        note: account.role === "owner" ? "老闆核准採購單" : "店長核准採購單",
        payload: { approved: true },
      });
      toast.success("已核准並送出");
      setDrafts((prev) => prev.filter((d) => d.id !== order.id));
    } catch (e) {
      toast.error("核准失敗", { description: (e as Error).message });
    } finally {
      setApprovingId(null);
    }
  };

  /** 退回 = 取消這張草稿(不會送出)。只給老闆/店長;資料庫也允許採購員取消草稿,但畫面上不給 */
  const returnDraft = async (order: OrderRow) => {
    setApprovingId(order.id);
    try {
      // 停在舊畫面時,這張可能已被別人核准送出 —— 已送出的單不能從這裡退回
      const { data: still, error } = await db<{ id: string }>("supplier_orders")
        .select("id")
        .eq("id", order.id)
        .eq("status", "draft");
      if (error) throw new Error(error.message);
      if (!still || still.length === 0) {
        await handledElsewhere();
        return;
      }

      await recordOrderEvent({
        orderId: order.id,
        fromStatus: "draft",
        toStatus: "cancelled",
        actorRole: "restaurant",
        source: "restaurant_portal",
        note: "退回採購單(未送出)",
        payload: { returned: true },
      });
      toast.success("已退回,這張採購單不會送出");
      setDrafts((prev) => prev.filter((d) => d.id !== order.id));
    } catch (e) {
      toast.error("退回失敗", { description: (e as Error).message });
    } finally {
      setApprovingId(null);
    }
  };

  const itemNames = (list: RawIngredient[] | null) => {
    const arr = Array.isArray(list) ? list : [];
    const names = arr.map((i) => i?.name).filter(Boolean) as string[];
    if (names.length === 0) return "（無品項）";
    return names.slice(0, 5).join("、") + (names.length > 5 ? ` …共 ${names.length} 項` : "");
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <ShoppingCart className="h-6 w-6 text-emerald-600" />
          智慧採購
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          選一家合作供應商,叫過的品項會自動列在下面,調整數量、刪掉不需要的,就能直接向他叫貨
        </p>
      </div>

      {/* 待簽核區:草稿只出現在這裡(訂單分頁不列草稿)。
          老闆/店長:核准並送出、退回;採購員:只看得到「等待簽核」,沒有送出鈕(業主拍板 Q8-A)。
          資料庫 trg_guard_order_submission 也擋採購員送出,這裡不是唯一防線。 */}
      {drafts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60" data-testid="pending-approval">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-amber-800">
              {mustApprove ? <Hourglass className="h-4 w-4" /> : <ClipboardCheck className="h-4 w-4" />}
              {mustApprove ? "等待簽核的採購單" : "待簽核採購單"}（{drafts.length}）
            </CardTitle>
            <p className="text-xs text-amber-700">
              {mustApprove
                ? "老闆或店長簽核後才會送出媒合;需要修改請聯絡店長退回"
                : "採購員建立、或 AI 採購助手帶入的採購單,核准後才會送出媒合"}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {drafts.map((d) => (
              <div
                key={d.id}
                data-testid="pending-draft"
                className="flex flex-col sm:flex-row sm:items-center gap-3 bg-white rounded-lg border border-amber-200 px-4 py-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{itemNames(d.ingredient_list)}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    建立於 {new Date(d.created_at).toLocaleString("zh-TW")}
                    {d.notes ? ` · ${d.notes}` : ""}
                  </p>
                </div>
                {mustApprove ? (
                  <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 shrink-0 self-start sm:self-auto">
                    <Hourglass className="h-3 w-3 mr-1" />
                    等待簽核
                  </Badge>
                ) : (
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-200 text-slate-600"
                      disabled={approvingId === d.id}
                      onClick={() => setReturnTarget(d)}
                    >
                      <Undo2 className="h-4 w-4 mr-1.5" />
                      退回
                    </Button>
                    <Button
                      size="sm"
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={approvingId === d.id}
                      onClick={() => approve(d)}
                    >
                      {approvingId === d.id
                        ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                        : <ClipboardCheck className="h-4 w-4 mr-1.5" />}
                      核准並送出
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 退回確認 */}
      <AlertDialog
        open={!!returnTarget}
        onOpenChange={(o) => {
          if (!o) setReturnTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>退回這張採購單?</AlertDialogTitle>
            <AlertDialogDescription>
              退回後這張單不會送出媒合,會從待簽核清單移除。採購員需要的話可以重新建立一張。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                const target = returnTarget;
                setReturnTarget(null);
                if (target) returnDraft(target);
              }}
            >
              確定退回
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {partners.length === 0 ? (
        <Card data-testid="no-partners">
          <CardContent className="py-14 text-center">
            <Store className="h-10 w-10 mx-auto mb-4 text-slate-300" />
            <p className="text-slate-600 font-medium">還沒有綁定合作供應商</p>
            <p className="text-sm text-slate-400 mt-1 mb-5">
              {canBind
                ? "先綁定你固定往來的供應商,就能直接向他們叫貨"
                : "請老闆或店長先綁定合作供應商,綁定後就能直接叫貨"}
            </p>
            <Link to="/restaurant/suppliers">
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white">
                <Store className="h-4 w-4 mr-1.5" />
                {canBind ? "去綁定合作供應商" : "查看我的供應商"}
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
      <>
      {/* 向哪家合作供應商叫貨 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Store className="h-4 w-4 text-emerald-600" />
            向哪家供應商叫貨
          </CardTitle>
          <p className="text-xs text-slate-400">一張單向一家叫貨;要向多家叫貨就分開送出。想新增合作供應商請到「我的供應商」。</p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="合作供應商">
            {partners.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={supplierId === x.id}
                onClick={() => setSupplierId(x.id)}
                className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
                  supplierId === x.id
                    ? "bg-emerald-600 border-emerald-600 text-white"
                    : "bg-white border-slate-200 text-slate-600 hover:border-emerald-300"
                }`}
              >
                {x.name}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 過往叫貨品項:全部列出,預設都在這張單裡 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            過往叫貨品項
            {visibleItems.length > 0 && <span className="text-xs font-normal text-slate-400">共 {visibleItems.length} 項</span>}
          </CardTitle>
          {visibleItems.length > 0 && (
            <p className="text-xs text-slate-400">
              用 + − 或直接輸入數字調整數量,不需要的按垃圾桶移除;參考價是你預期的單價,選填
            </p>
          )}
        </CardHeader>
        <CardContent>
          {visibleItems.length === 0 ? (
            <div className="text-center py-10 text-slate-400">
              <History className="h-9 w-9 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{visibleRemoved.length > 0 ? "叫過的品項都已移除" : "還沒有叫過貨的品項"}</p>
              <p className="text-xs mt-1">
                {visibleRemoved.length > 0
                  ? "可以從下方「已移除的品項」加回來,或手動加入新品項"
                  : "送出第一張採購單之後,叫過的品項會自動列在這裡,下次不用再一個個加入"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100" data-testid="history-items">
              {visibleItems.map((i) => {
                const overdue = i.due && i.daysSince >= i.avgCycle * 1.5;
                return (
                  <div key={i.name} data-testid="history-item" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                    <SupplyThumb path={thumbOf(i.name, i.supplierId)} name={i.name} />
                    <div className="flex-1 min-w-[140px]">
                      <div className="text-sm font-medium text-slate-800 flex items-center gap-2 flex-wrap">
                        {i.name}
                        {i.due && (
                          <Badge
                            variant="outline"
                            className={overdue
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-amber-50 text-amber-700 border-amber-200"}
                          >
                            {overdue ? "嚴重超期" : "該補貨了"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-400">
                        上次叫貨 {i.daysSince} 天前
                        {i.avgCycle > 0 && ` · 平均週期 ${i.avgCycle} 天`} · 共叫過 {i.times} 次
                      </p>
                    </div>
                    <QtyStepper
                      name={i.name}
                      value={i.quantity}
                      onChange={(v) => updateItem(i.name, { quantity: v })}
                    />
                    <Input
                      value={i.unit}
                      onChange={(e) => updateItem(i.name, { unit: e.target.value })}
                      className="w-20 h-9"
                      placeholder="單位"
                      aria-label={`${i.name} 單位`}
                    />
                    <PriceInput
                      name={i.name}
                      unit={i.unit}
                      value={i.referencePrice}
                      onChange={(v) => updateItem(i.name, { referencePrice: v })}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-slate-400 hover:text-red-600 hover:bg-red-50"
                      onClick={() => removeItem(i)}
                      aria-label={`移除 ${i.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {visibleRemoved.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-400 mb-2">已移除的品項,點一下加回</p>
              <div className="flex flex-wrap gap-1.5">
                {visibleRemoved.map((r) => (
                  <button
                    key={r.name}
                    type="button"
                    onClick={() => restoreItem(r)}
                    className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                  >
                    + {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 手動加品項 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PackagePlus className="h-4 w-4 text-emerald-600" />
            手動加入品項
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="食材名稱,例:高麗菜"
              className="flex-1 min-w-[160px]"
              onKeyDown={(e) => { if (e.key === "Enter") addManual(); }}
            />
            <Input
              value={form.quantity}
              onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
              placeholder="數量"
              className="w-24"
              onKeyDown={(e) => { if (e.key === "Enter") addManual(); }}
            />
            <Input
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              placeholder="單位 kg / 箱"
              className="w-32"
              onKeyDown={(e) => { if (e.key === "Enter") addManual(); }}
            />
            <Input
              value={form.referencePrice}
              inputMode="decimal"
              onChange={(e) => { if (numericOnly(e.target.value)) setForm((f) => ({ ...f, referencePrice: e.target.value })); }}
              placeholder="參考價(選填)"
              aria-label="參考價"
              className="w-32"
              onKeyDown={(e) => { if (e.key === "Enter") addManual(); }}
            />
            <Button
              variant="outline"
              onClick={() => addManual()}
              disabled={!form.name.trim()}
              className="shrink-0"
            >
              <Plus className="h-4 w-4 mr-1.5" />
              加入
            </Button>
          </div>

          {manual.length > 0 && (
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {manual.map((m) => (
                <div key={m.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <SupplyThumb path={thumbOf(m.name)} name={m.name} size={32} />
                  <div className="flex-1 min-w-[120px]">
                    <p className="text-sm text-slate-800 truncate">{m.name}</p>
                  </div>
                  <QtyStepper
                    name={m.name}
                    value={m.quantity}
                    onChange={(v) => setManual((prev) => prev.map((x) => (x.key === m.key ? { ...x, quantity: v } : x)))}
                  />
                  <Input
                    value={m.unit}
                    onChange={(e) =>
                      setManual((prev) => prev.map((x) => (x.key === m.key ? { ...x, unit: e.target.value } : x)))
                    }
                    className="w-20 h-9"
                    placeholder="單位"
                    aria-label={`${m.name} 單位`}
                  />
                  <PriceInput
                    name={m.name}
                    unit={m.unit}
                    value={m.referencePrice}
                    onChange={(v) => setManual((prev) => prev.map((x) => (x.key === m.key ? { ...x, referencePrice: v } : x)))}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    onClick={() => setManual((prev) => prev.filter((x) => x.key !== m.key))}
                    aria-label="移除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 送出 */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="備註（送貨時間、規格要求…）"
          />
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-sm text-slate-500 flex-1" data-testid="order-summary">
              向 <span className="font-semibold text-slate-800">{supplierName}</span> 叫貨,目前共{" "}
              <span className="font-semibold text-slate-800">{cart.length}</span> 項
            </p>
            <Button
              onClick={submit}
              disabled={submitting || cart.length === 0 || !supplierId}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Send className="h-4 w-4 mr-1.5" />}
              送出訂單
            </Button>
          </div>
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
};

export default RestaurantPurchasePage;
