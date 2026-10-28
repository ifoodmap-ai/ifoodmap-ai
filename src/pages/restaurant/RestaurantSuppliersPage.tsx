import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Store, Star, ShieldAlert, Truck, PackageX, Clock, ChevronDown, ChevronUp, Plus, Link2Off, Loader2, Search,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant, canSeeCost } from "@/components/RestaurantRoute";
import { ORDER_STATUS, type OrderStatus } from "@/lib/orders";
import { countedOrders, orderAmount } from "@/lib/metrics";
import { formatOrderNo } from "@/lib/order-number";

/* ── 新資料表不在 types.ts,沿用專案的 loose cast 慣例 ─────────────── */
type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: unknown[]): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  limit(n: number): Q<T>;
  insert(values: unknown): Q<T>;
  delete(): Q<T>;
}
const db = <T,>(table: string): Q<T> =>
  (supabase as never as { from: (t: string) => Q<T> }).from(table);

interface OrderRow {
  id: string;
  supplier_id: string | null;
  total_amount: number | null;
  status: string;
  created_at: string;
}

interface SupplierRow {
  id: string;
  name: string;
  description: string | null;
  service_areas: string[] | null;
}

interface MetricsRow {
  supplier_id: string;
  orders_total: number | null;
  ontime_rate: number | null;
  shortage_rate: number | null;
  avg_reply_minutes: number | null;
  avg_rating: number | null;
  computed_at: string | null;
}

interface RecentOrder {
  id: string;
  status: string;
  created_at: string;
}

interface Partner {
  supplier: SupplierRow;
  orders: number;
  amount: number;
  lastAt: string | null;
  metrics: MetricsRow | null;
  /** 最近幾張合作的單(新到舊),展開績效時列出 */
  recent: RecentOrder[];
}

/** 展開績效時列出的近期訂單張數 */
const RECENT_LIMIT = 5;

// 「合作供應商」= 這家店「綁定」的供應商(restaurant_suppliers):綁定的供應商可以直接叫貨(訂單從待接單開始,不經管理員派發)。
// 綁定由老闆 / 店長新增與解除、立刻生效;採購員只能看與叫貨。既有往來(已收過貨)在 migration 時自動補成已綁定。
// 下面的合作單數、累計訂單、累計採購金額、最近合作、近期合作清單只看這家供應商的有效訂單(沒有訂單就是 0)。
//
// 「合作」= 全站共用的訂單定義(src/lib/metrics.ts,業主拍板 Q5-A):不含草稿、取消、拒單、逾時。
// 合作供應商、累計訂單、累計採購金額、最近合作、近期合作清單都只看這些單,
// 跟營運總覽的「合作供應商」「本月採購金額」同一個口徑;供應商端「客戶管理」看到的累計訂單金額也是同一組單。

const statusLabel = (status: string) => ORDER_STATUS[status as OrderStatus]?.label ?? status;

/** 比率可能存 0–1 或 0–100,統一換算成百分比 */
const toPct = (v: number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

const RestaurantSuppliersPage = () => {
  const account = useRestaurant();
  const showCost = canSeeCost(account.role);

  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState<Partner[]>([]);
  // 「查看」改成就地展開績效(PROPOSAL.md §2 / Q7-A):不再帶去公開供應商頁 —— 那頁是給訪客看的
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const canManage = account.role === "owner" || account.role === "manager";
  const [reloadKey, setReloadKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [unbindTarget, setUnbindTarget] = useState<Partner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 新增合作供應商的視窗:還在營業、還沒綁定的供應商名單
  const [directory, setDirectory] = useState<SupplierRow[] | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (reloadKey === 0) setLoading(true);

      const { data: orders } = await db<OrderRow>("supplier_orders")
        .select("id, supplier_id, total_amount, status, created_at")
        .eq("restaurant_id", account.restaurant_id)
        .order("created_at", { ascending: false })
        .limit(500);

      const grouped = new Map<string, { orders: number; amount: number; lastAt: string | null; recent: RecentOrder[] }>();
      countedOrders(orders ?? []).forEach((o) => {
        if (!o.supplier_id) return;
        const cur = grouped.get(o.supplier_id) ?? { orders: 0, amount: 0, lastAt: null, recent: [] };
        cur.orders += 1;
        cur.amount += orderAmount(o);
        if (!cur.lastAt || new Date(o.created_at) > new Date(cur.lastAt)) cur.lastAt = o.created_at;
        cur.recent.push({ id: o.id, status: o.status, created_at: o.created_at });
        grouped.set(o.supplier_id, cur);
      });

      const { data: bound } = await db<{ supplier_id: string }>("restaurant_suppliers")
        .select("supplier_id")
        .eq("restaurant_id", account.restaurant_id);
      const ids = (bound ?? []).map((b) => b.supplier_id);
      if (ids.length === 0) {
        if (!cancelled) { setPartners([]); setLoading(false); }
        return;
      }

      const [{ data: sups }, { data: metrics }] = await Promise.all([
        db<SupplierRow>("suppliers").select("id, name, description, service_areas").in("id", ids),
        db<MetricsRow>("supplier_metrics")
          .select("supplier_id, orders_total, ontime_rate, shortage_rate, avg_reply_minutes, avg_rating, computed_at")
          .in("supplier_id", ids),
      ]);

      const metricsById = new Map((metrics ?? []).map((m) => [m.supplier_id, m]));
      const list: Partner[] = (sups ?? []).map((s) => {
        const g = grouped.get(s.id) ?? { orders: 0, amount: 0, lastAt: null, recent: [] as RecentOrder[] };
        return {
          supplier: s,
          orders: g.orders,
          amount: g.amount,
          lastAt: g.lastAt,
          metrics: metricsById.get(s.id) ?? null,
          recent: [...g.recent]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, RECENT_LIMIT),
        };
      }).sort((a, b) => b.orders - a.orders);

      if (!cancelled) { setPartners(list); setLoading(false); }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.restaurant_id, reloadKey]);

  const openAdd = async () => {
    setAddOpen(true);
    setQuery("");
    if (directory) return;
    setDirectoryError(null);
    const { data, error } = await db<SupplierRow>("suppliers")
      .select("id, name, description, service_areas")
      .eq("is_active", true)
      .order("name", { ascending: true })
      .limit(500);
    if (error) setDirectoryError(error.message);
    else setDirectory(data ?? []);
  };

  const bind = async (supplier: SupplierRow) => {
    setBusy(supplier.id);
    const { error } = await db("restaurant_suppliers").insert({ restaurant_id: account.restaurant_id, supplier_id: supplier.id });
    setBusy(null);
    if (error) {
      toast.error("綁定失敗", { description: error.message });
      return;
    }
    toast.success(`已綁定 ${supplier.name},現在可以直接向他們叫貨`);
    setAddOpen(false);
    setReloadKey((k) => k + 1);
  };

  const unbind = async (partner: Partner) => {
    setBusy(partner.supplier.id);
    const { error } = await db("restaurant_suppliers")
      .delete()
      .eq("restaurant_id", account.restaurant_id)
      .eq("supplier_id", partner.supplier.id);
    setBusy(null);
    setUnbindTarget(null);
    if (error) {
      toast.error("解除綁定失敗", { description: error.message });
      return;
    }
    toast.success(`已解除與 ${partner.supplier.name} 的綁定(進行中的訂單照常處理)`);
    setReloadKey((k) => k + 1);
  };

  const candidates = useMemo(() => {
    const boundIds = new Set(partners.map((p) => p.supplier.id));
    const q = query.trim().toLowerCase();
    return (directory ?? [])
      .filter((d) => !boundIds.has(d.id))
      .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q));
  }, [directory, partners, query]);

  const totals = useMemo(() => ({
    suppliers: partners.length,
    orders: partners.reduce((a, p) => a + p.orders, 0),
    amount: partners.reduce((a, p) => a + p.amount, 0),
  }), [partners]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-44" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Store className="h-6 w-6 text-emerald-600" />
            我的供應商
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            綁定合作的供應商,之後可以直接向他們叫貨;也看得到他們的表現,準時率或短少率不佳時會提醒你先找備援
          </p>
        </div>
        {canManage && (
          <Button onClick={openAdd} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Plus className="h-4 w-4 mr-1.5" />
            新增合作供應商
          </Button>
        )}
      </div>

      {partners.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <PackageX className="h-10 w-10 mx-auto mb-4 text-slate-300" />
            <p className="text-slate-600 font-medium">還沒有綁定合作供應商</p>
            <p className="text-sm text-slate-400 mt-1 mb-5">
              {canManage
                ? "綁定你固定往來的供應商後,就能直接向他們叫貨"
                : "請老闆或店長先綁定合作供應商,綁定後就能直接叫貨"}
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {canManage && (
                <Button onClick={openAdd} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  <Plus className="h-4 w-4 mr-1.5" />
                  新增合作供應商
                </Button>
              )}
              <Link to="/suppliers">
                <Button variant="outline">
                  <Store className="h-4 w-4 mr-1.5" />
                  瀏覽供應商名錄
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className={`grid gap-4 ${showCost ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs text-slate-500">合作供應商</p>
                <p className="text-2xl font-bold text-slate-800 mt-1">{totals.suppliers}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs text-slate-500">累計訂單</p>
                <p className="text-2xl font-bold text-slate-800 mt-1">{totals.orders}</p>
              </CardContent>
            </Card>
            {showCost && (
              <Card>
                <CardContent className="pt-6">
                  <p className="text-xs text-slate-500">累計採購金額</p>
                  <p className="text-2xl font-bold text-slate-800 mt-1">
                    {totals.amount > 0 ? money(totals.amount) : "—"}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {partners.map((p) => {
              const ontime = toPct(p.metrics?.ontime_rate);
              const shortage = toPct(p.metrics?.shortage_rate);
              const risky = (ontime != null && ontime < 80) || (shortage != null && shortage > 10);
              const isOpen = expandedId === p.supplier.id;
              const detailId = `supplier-detail-${p.supplier.id}`;
              return (
                <Card key={p.supplier.id} className={risky ? "border-red-200" : undefined}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-semibold text-slate-800 truncate">{p.supplier.name}</h2>
                          {risky && (
                            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                              <ShieldAlert className="h-3 w-3 mr-1" />
                              建議備援
                            </Badge>
                          )}
                        </div>
                        {p.supplier.description && (
                          <p className="text-xs text-slate-400 mt-1 line-clamp-2">{p.supplier.description}</p>
                        )}
                        {p.supplier.service_areas && p.supplier.service_areas.length > 0 && (
                          <p className="text-xs text-slate-400 mt-1">
                            配送:{p.supplier.service_areas.join("、")}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        onClick={() => setExpandedId(isOpen ? null : p.supplier.id)}
                      >
                        {isOpen
                          ? <ChevronUp className="h-3.5 w-3.5 mr-1.5" />
                          : <ChevronDown className="h-3.5 w-3.5 mr-1.5" />}
                        {isOpen ? "收起" : "查看績效"}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      <Link to={`/restaurant/purchase?supplier=${p.supplier.id}`}>
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white">
                          <Truck className="h-3.5 w-3.5 mr-1.5" />
                          向他叫貨
                        </Button>
                      </Link>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-slate-500 hover:text-red-600"
                          disabled={busy === p.supplier.id}
                          onClick={() => setUnbindTarget(p)}
                        >
                          <Link2Off className="h-3.5 w-3.5 mr-1.5" />
                          解除綁定
                        </Button>
                      )}
                    </div>

                    <div className={`grid gap-3 ${showCost ? "grid-cols-3" : "grid-cols-2"} border-t border-slate-100 pt-3`}>
                      <div>
                        <p className="text-[11px] text-slate-400">合作單數</p>
                        <p className="text-sm font-semibold text-slate-800">{p.orders}</p>
                      </div>
                      {showCost && (
                        <div>
                          <p className="text-[11px] text-slate-400">累計採購金額</p>
                          <p className="text-sm font-semibold text-slate-800">
                            {p.amount > 0 ? money(p.amount) : "—"}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-[11px] text-slate-400">最近合作</p>
                        <p className="text-sm font-semibold text-slate-800">
                          {p.lastAt ? new Date(p.lastAt).toLocaleDateString("zh-TW") : "—"}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 border-t border-slate-100 mt-3 pt-3">
                      <div>
                        <p className="text-[11px] text-slate-400">準時率</p>
                        <p className={`text-sm font-semibold ${
                          ontime == null ? "text-slate-400" : ontime < 80 ? "text-red-600" : "text-emerald-600"
                        }`}>
                          {ontime != null ? `${ontime.toFixed(0)}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-400">短少率</p>
                        <p className={`text-sm font-semibold ${
                          shortage == null ? "text-slate-400" : shortage > 10 ? "text-red-600" : "text-emerald-600"
                        }`}>
                          {shortage != null ? `${shortage.toFixed(0)}%` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-400">平均評分</p>
                        <p className="text-sm font-semibold text-slate-800 flex items-center gap-1">
                          {p.metrics?.avg_rating != null ? (
                            <>
                              <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                              {Number(p.metrics.avg_rating).toFixed(1)}
                            </>
                          ) : <span className="text-slate-400">—</span>}
                        </p>
                      </div>
                    </div>

                    {p.metrics?.avg_reply_minutes != null && (
                      <p className="text-[11px] text-slate-400 mt-3 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        平均回覆 {Math.round(Number(p.metrics.avg_reply_minutes))} 分鐘
                        {p.metrics.computed_at
                          ? ` · 統計於 ${new Date(p.metrics.computed_at).toLocaleDateString("zh-TW")}`
                          : ""}
                      </p>
                    )}
                    {!p.metrics && (
                      <p className="text-[11px] text-slate-400 mt-3">尚無績效統計資料</p>
                    )}

                    {isOpen && (
                      <div
                        id={detailId}
                        role="region"
                        aria-label={`${p.supplier.name} 的績效明細`}
                        className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3"
                      >
                        <div>
                          <p className="text-[11px] font-medium text-slate-500">近期合作</p>
                          <ul className="mt-1 space-y-1">
                            {p.recent.map((o) => (
                              <li key={o.id} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                                <span className="font-mono">{formatOrderNo(o.id)}</span>
                                <span className="text-slate-400">{new Date(o.created_at).toLocaleDateString("zh-TW")}</span>
                                <span className="ml-auto">{statusLabel(o.status)}</span>
                              </li>
                            ))}
                          </ul>
                          {p.orders > p.recent.length && (
                            <p className="mt-1 text-[11px] text-slate-400">只列最近 {p.recent.length} 張,共 {p.orders} 張</p>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <p className="text-[11px] text-slate-400">平台累計訂單</p>
                            <p className="text-sm font-semibold text-slate-800">
                              {p.metrics?.orders_total != null ? p.metrics.orders_total : "—"}
                            </p>
                          </div>
                          <div>
                            <p className="text-[11px] text-slate-400">平均回覆</p>
                            <p className="text-sm font-semibold text-slate-800">
                              {p.metrics?.avg_reply_minutes != null
                                ? `${Math.round(Number(p.metrics.avg_reply_minutes))} 分鐘`
                                : "—"}
                            </p>
                          </div>
                        </div>
                        {p.supplier.description && (
                          <p className="text-xs leading-relaxed text-slate-500">{p.supplier.description}</p>
                        )}
                        <Link
                          to="/restaurant/orders"
                          className="inline-flex text-xs font-medium text-emerald-700 hover:underline"
                        >
                          到訂單分頁看完整履歷
                        </Link>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新增合作供應商</DialogTitle>
            <DialogDescription>選擇你固定往來的供應商,綁定後馬上可以直接向他們叫貨(不需要供應商同意)。</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋供應商名稱"
              aria-label="搜尋供應商"
              className="pl-9"
            />
          </div>
          {directoryError ? (
            <p role="alert" className="text-sm text-red-600">載入供應商名單失敗:{directoryError}</p>
          ) : directory === null ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">
              {query.trim() ? "找不到符合的供應商" : "沒有可以新增的供應商了"}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="bind-candidates">
              {candidates.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{d.name}</p>
                    {d.service_areas && d.service_areas.length > 0 && (
                      <p className="text-xs text-slate-400 truncate">配送:{d.service_areas.join("、")}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === d.id}
                    aria-label={`綁定 ${d.name}`}
                    onClick={() => void bind(d)}
                  >
                    {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "綁定"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!unbindTarget} onOpenChange={(o) => { if (!o) setUnbindTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解除與 {unbindTarget?.supplier.name} 的綁定?</AlertDialogTitle>
            <AlertDialogDescription>
              解除後不能再直接向他叫貨,要用的話可以重新綁定。已經送出、進行中的訂單照常處理,歷史訂單也都還在。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={(e) => { e.preventDefault(); if (unbindTarget) void unbind(unbindTarget); }}
            >
              確定解除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default RestaurantSuppliersPage;
