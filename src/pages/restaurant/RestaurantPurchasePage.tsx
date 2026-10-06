import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Sparkles, Plus, Trash2, Loader2, ShoppingCart, ClipboardCheck,
  History, Send, PackagePlus, Hourglass, Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

/* ── 新資料表不在 types.ts,沿用專案的 loose cast 慣例 ─────────────── */
type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: unknown[]): Q<T>;
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
}

interface OrderRow {
  id: string;
  created_at: string;
  status: string;
  ingredient_list: RawIngredient[] | null;
  created_by: string | null;
  approved_by: string | null;
  notes: string | null;
}

interface Suggestion {
  name: string;
  unit: string;
  quantity: string;
  times: number;
  daysSince: number;
  avgCycle: number;
  checked: boolean;
}

interface ManualItem {
  key: string;
  name: string;
  quantity: string;
  unit: string;
}

const DAY = 86_400_000;
const dayDiff = (a: number, b: number) => Math.max(0, Math.round((a - b) / DAY));

const RestaurantPurchasePage = () => {
  const account = useRestaurant();
  const mustApprove = needsApproval(account.role);
  // 形象站 AI 對話剛被認領成草稿時,RestaurantLayout 會帶著 claimedOrderId 導過來
  const claimedOrderId =
    (useLocation().state as Partial<ClaimedDraftLocationState> | null)?.claimedOrderId ?? null;

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [frequent, setFrequent] = useState<{ name: string; unit: string; quantity: string }[]>([]);
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
        .map((name, i) => ({ key: `handoff-${i}`, name: name.trim(), quantity: "", unit: "kg" }));
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState({ name: "", quantity: "", unit: "" });
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
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!cancelled) setUserId(user?.id ?? null);

      const { data: orders } = await db<OrderRow>("supplier_orders")
        .select("id, created_at, status, ingredient_list, created_by, approved_by, notes")
        .eq("restaurant_id", account.restaurant_id)
        .order("created_at", { ascending: false })
        .limit(300);

      const history = new Map<string, { dates: number[]; unit: string; quantity: string; times: number }>();
      (orders ?? [])
        .filter((o) => o.status !== "cancelled" && o.status !== "draft")
        .forEach((o) => {
          const at = new Date(o.created_at).getTime();
          if (!Number.isFinite(at)) return;
          const list = Array.isArray(o.ingredient_list) ? o.ingredient_list : [];
          const seen = new Set<string>();
          list.forEach((raw) => {
            const name = (raw?.name ?? "").trim();
            if (!name || seen.has(name)) return;
            seen.add(name);
            const prev = history.get(name);
            const qty = raw?.quantity != null ? String(raw.quantity) : "";
            if (prev) {
              prev.dates.push(at);
              prev.times += 1;
            } else {
              history.set(name, { dates: [at], unit: raw?.unit ?? "", quantity: qty, times: 1 });
            }
          });
        });

      const now = Date.now();
      const suggested: Suggestion[] = [];
      const freq: { name: string; unit: string; quantity: string; times: number }[] = [];

      history.forEach((v, name) => {
        const dates = [...v.dates].sort((a, b) => a - b);
        const last = dates[dates.length - 1];
        const daysSince = dayDiff(now, last);
        freq.push({ name, unit: v.unit, quantity: v.quantity, times: v.times });
        if (dates.length < 2) return;
        const avgCycle = Math.max(1, Math.round((last - dates[0]) / (dates.length - 1) / DAY));
        if (daysSince >= avgCycle) {
          suggested.push({
            name,
            unit: v.unit,
            quantity: v.quantity || "1",
            times: v.times,
            daysSince,
            avgCycle,
            checked: true,
          });
        }
      });

      suggested.sort((a, b) => b.daysSince / b.avgCycle - a.daysSince / a.avgCycle);
      freq.sort((a, b) => b.times - a.times);

      if (!cancelled) {
        setSuggestions(suggested);
        setFrequent(freq.slice(0, 12).map(({ name, unit, quantity }) => ({ name, unit, quantity })));
      }

      await loadDrafts();
      if (!cancelled) setLoading(false);
    };

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.restaurant_id]);

  // 本來就停在這一頁時才認領完成(直接打 /restaurant/purchase 進來):第一次載入可能早於草稿建立,
  // 收到 claimedOrderId 就再抓一次待簽核清單,剛建好的 AI 草稿才看得到
  useEffect(() => {
    if (!claimedOrderId) return;
    void loadDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimedOrderId]);

  const cart = useMemo(() => {
    const picked = suggestions
      .filter((s) => s.checked)
      .map((s) => ({ name: s.name, quantity: s.quantity, unit: s.unit, source: "ai" as const }));
    const extra = manual.map((m) => ({
      name: m.name, quantity: m.quantity, unit: m.unit, source: "manual" as const,
    }));
    // 同名只留一筆(手動輸入優先)
    const merged = new Map<string, { name: string; quantity: string; unit: string; source: "ai" | "manual" }>();
    [...picked, ...extra].forEach((i) => {
      const name = i.name.trim();
      if (name) merged.set(name, { ...i, name });
    });
    return [...merged.values()];
  }, [suggestions, manual]);

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
          }],
    );
    if (!name) setForm({ name: "", quantity: "", unit: "" });
  };

  const submit = async () => {
    if (cart.length === 0) {
      toast.error("請先勾選或加入至少一項食材");
      return;
    }
    setSubmitting(true);
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

      if (mustApprove) {
        toast.success("已建立採購單,等待老闆或店長簽核");
      } else {
        await recordOrderEvent({
          orderId: data.id,
          fromStatus: "draft",
          toStatus: "submitted",
          actorRole: "restaurant",
          source: "restaurant_portal",
          note: `${account.restaurant_name} 送出採購需求(${cart.length} 項)`,
          payload: { item_count: cart.length },
        });
        toast.success("採購需求已送出,ifoodmap 將盡快媒合供應商");
      }

      setSuggestions((prev) => prev.map((s) => ({ ...s, checked: false })));
      setManual([]);
      setNotes("");
      await loadDrafts();
    } catch (e) {
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
          依照過往叫貨週期自動提醒該補的品項,勾一勾就能送出採購需求
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

      {/* AI 建議採購清單 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            AI 建議採購清單
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suggestions.length === 0 ? (
            <div className="text-center py-10 text-slate-400">
              <History className="h-9 w-9 mx-auto mb-3 opacity-40" />
              <p className="text-sm">還沒有足夠的叫貨紀錄可以推算週期</p>
              <p className="text-xs mt-1">同一項食材叫過兩次以上,系統就會開始提醒你補貨</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {suggestions.map((s, idx) => {
                const overdue = s.daysSince >= s.avgCycle * 1.5;
                return (
                  <div key={s.name} className="flex flex-wrap items-center gap-3 py-3">
                    <Checkbox
                      checked={s.checked}
                      onCheckedChange={(v) =>
                        setSuggestions((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, checked: v === true } : x)),
                        )
                      }
                    />
                    <div className="flex-1 min-w-[140px]">
                      <p className="text-sm font-medium text-slate-800">{s.name}</p>
                      <p className="text-xs text-slate-400">
                        上次叫貨 {s.daysSince} 天前 · 平均週期 {s.avgCycle} 天 · 共叫過 {s.times} 次
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={overdue
                        ? "bg-red-50 text-red-700 border-red-200"
                        : "bg-amber-50 text-amber-700 border-amber-200"}
                    >
                      {overdue ? "嚴重超期" : "該補貨了"}
                    </Badge>
                    <Input
                      value={s.quantity}
                      onChange={(e) =>
                        setSuggestions((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)),
                        )
                      }
                      className="w-24 h-9"
                      placeholder="數量"
                    />
                    <Input
                      value={s.unit}
                      onChange={(e) =>
                        setSuggestions((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, unit: e.target.value } : x)),
                        )
                      }
                      className="w-20 h-9"
                      placeholder="單位"
                    />
                  </div>
                );
              })}
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

          {frequent.length > 0 && (
            <div>
              <p className="text-xs text-slate-400 mb-2">常叫的品項,點一下快速加入</p>
              <div className="flex flex-wrap gap-1.5">
                {frequent.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => addManual(f.name, f.quantity, f.unit)}
                    className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                  >
                    + {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {manual.length > 0 && (
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {manual.map((m) => (
                <div key={m.key} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800 truncate">{m.name}</p>
                  </div>
                  <Input
                    value={m.quantity}
                    onChange={(e) =>
                      setManual((prev) => prev.map((x) => (x.key === m.key ? { ...x, quantity: e.target.value } : x)))
                    }
                    className="w-24 h-9"
                    placeholder="數量"
                  />
                  <Input
                    value={m.unit}
                    onChange={(e) =>
                      setManual((prev) => prev.map((x) => (x.key === m.key ? { ...x, unit: e.target.value } : x)))
                    }
                    className="w-20 h-9"
                    placeholder="單位"
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
            <p className="text-sm text-slate-500 flex-1">
              目前共 <span className="font-semibold text-slate-800">{cart.length}</span> 項
              {mustApprove && <span className="text-amber-600">（採購員建立的採購單要由老闆或店長簽核後才會送出）</span>}
            </p>
            <Button
              onClick={submit}
              disabled={submitting || cart.length === 0}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Send className="h-4 w-4 mr-1.5" />}
              {mustApprove ? "送交簽核" : "送出採購需求"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default RestaurantPurchasePage;
