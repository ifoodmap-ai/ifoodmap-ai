import { useEffect, useMemo, useState } from "react";
import { BarChart3, Download, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant } from "@/components/RestaurantRoute";
import { dealLedger, fetchAllPages, type StatusEventRow } from "@/lib/metrics";
import {
  ITEM_CSV_HEADERS,
  ORDER_CSV_HEADERS,
  RANGE_PRESETS,
  SUPPLIER_CSV_HEADERS,
  buildReport,
  downloadCsv,
  isValidRange,
  itemCsvRows,
  orderCsvRows,
  presetRange,
  rangeBounds,
  supplierCsvRows,
  toCsv,
  type RangePreset,
  type ReportOrder,
} from "@/lib/restaurant-report";

/* ── 沿用專案的 loose cast 慣例(這幾張表的型別不在 types.ts) ───────── */
type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: unknown[]): Q<T>;
  gte(col: string, val: unknown): Q<T>;
  lt(col: string, val: unknown): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  range(from: number, to: number): Q<T>;
}
const db = <T,>(table: string): Q<T> =>
  (supabase as never as { from: (t: string) => Q<T> }).from(table);

const TWD = (n: number) => `NT$ ${Math.round(n).toLocaleString("zh-TW")}`;

/** 訂單 id 一次最多帶幾個去查事件(網址太長會被擋) */
const ID_CHUNK = 100;

const chunk = <T,>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const RestaurantReportsPage = () => {
  const account = useRestaurant();

  const initial = presetRange("thisMonth");
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  // 按「查詢」才會用目前填的日期去抓;改日期不會每改一次就打一次資料庫
  const [applied, setApplied] = useState({ start: initial.start, end: initial.end });

  const [orders, setOrders] = useState<ReportOrder[]>([]);
  const [events, setEvents] = useState<StatusEventRow[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [supplierNames, setSupplierNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const rangeOk = isValidRange(start, end);

  useEffect(() => {
    let cancelled = false;
    const bounds = rangeBounds(applied.start, applied.end);

    const load = async () => {
      if (!bounds) return;
      setLoading(true);
      setLoadError(null);
      setEventsError(null);

      // 訂單分頁讀完:一次最多回 1000 筆,長區間會被截掉
      const { data: rows, error } = await fetchAllPages((from, to) =>
        db<ReportOrder>("supplier_orders")
          .select("id, status, total_amount, created_at, supplier_id, ingredient_list")
          .eq("restaurant_id", account.restaurant_id)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.to)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (cancelled) return;
      if (error) {
        setLoadError(error.message ?? "未知錯誤");
        toast.error("載入報表失敗", { description: error.message });
        setOrders([]);
        setEvents([]);
        setLoading(false);
        return;
      }

      // 收貨事件:判斷已結案的單有沒有收過貨(成交)。讀不完就整份不用,畫面上提示
      let eventRows: StatusEventRow[] = [];
      let evErrMsg: string | null = null;
      for (const ids of chunk(rows.map((o) => o.id), ID_CHUNK)) {
        const { data: ev, error: evErr } = await fetchAllPages((from, to) =>
          db<StatusEventRow>('order_events')
            .select("order_id, to_status, created_at")
            .in("order_id", ids)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
        );
        if (evErr) {
          eventRows = [];
          evErrMsg = evErr.message ?? "未知錯誤";
          break;
        }
        eventRows.push(...ev);
      }

      // 供應商名稱
      const supplierIds = Array.from(new Set(rows.map((o) => o.supplier_id).filter(Boolean) as string[]));
      const names: Record<string, string> = {};
      for (const ids of chunk(supplierIds, ID_CHUNK)) {
        const { data: sup } = await db<{ id: string; name: string }>("suppliers").select("id, name").in("id", ids);
        (sup ?? []).forEach((s) => { names[s.id] = s.name; });
      }

      if (cancelled) return;
      setOrders(rows);
      setEvents(eventRows);
      setEventsError(evErrMsg);
      setSupplierNames(names);
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [account.restaurant_id, applied]);

  const report = useMemo(
    () => buildReport(orders, dealLedger(events), supplierNames),
    [orders, events, supplierNames],
  );

  const applyPreset = (key: RangePreset) => {
    const r = presetRange(key);
    setStart(r.start);
    setEnd(r.end);
    setApplied(r);
  };

  const query = () => {
    if (!rangeOk) {
      toast.error("日期區間不正確", { description: "請確認起日與迄日都有填,而且起日不晚於迄日" });
      return;
    }
    setApplied({ start, end });
  };

  const stamp = `${applied.start}_${applied.end}`;
  const download = (kind: "orders" | "suppliers" | "items") => {
    if (kind === "orders") {
      downloadCsv(`採購報表_訂單明細_${stamp}.csv`, toCsv(ORDER_CSV_HEADERS, orderCsvRows(report.orders)));
    } else if (kind === "suppliers") {
      downloadCsv(`採購報表_供應商彙總_${stamp}.csv`, toCsv(SUPPLIER_CSV_HEADERS, supplierCsvRows(report.suppliers)));
    } else {
      downloadCsv(`採購報表_品項彙總_${stamp}.csv`, toCsv(ITEM_CSV_HEADERS, itemCsvRows(report.items)));
    }
  };

  const DownloadButton = ({ kind, count }: { kind: "orders" | "suppliers" | "items"; count: number }) => (
    <Button
      variant="outline"
      size="sm"
      disabled={count === 0}
      onClick={() => download(kind)}
    >
      <Download className="h-4 w-4 mr-1.5" />
      下載 CSV
    </Button>
  );

  const summaryCards = [
    { label: "訂單數", value: String(report.summary.orderCount), hint: "不含草稿、取消、拒單、逾時" },
    { label: "採購金額", value: TWD(report.summary.purchaseAmount), hint: "尚未報價的單以 0 計" },
    {
      label: "已收貨金額",
      value: TWD(report.summary.receivedAmount),
      hint: `${report.summary.receivedCount} 張單已確認收貨`,
    },
    { label: "進行中金額", value: TWD(report.summary.inProgressAmount), hint: "還沒確認收貨的有效訂單" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-emerald-600" />
          採購報表
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          選一段日期,看這段期間的採購明細與彙總,並下載成 CSV(可用 Excel 開啟)
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor="report-start" className="text-xs text-slate-500">起日</label>
              <Input
                id="report-start"
                type="date"
                value={start}
                max={end || undefined}
                onChange={(e) => setStart(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="report-end" className="text-xs text-slate-500">迄日</label>
              <Input
                id="report-end"
                type="date"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
                className="w-40"
              />
            </div>
            <Button
              onClick={query}
              disabled={!rangeOk || loading}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              查詢
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">快速選擇</span>
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            依訂單建立日期統計。目前顯示 {applied.start} 至 {applied.end}。
          </p>
        </CardContent>
      </Card>

      {loadError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          載入失敗:{loadError}
        </div>
      )}

      {eventsError && !loadError && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          讀不到訂單履歷,「已收貨」的數字可能偏低(已結案的單會先不算已收貨):{eventsError}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="report-summary">
            {summaryCards.map((c) => (
              <Card key={c.label}>
                <CardContent className="pt-5">
                  <p className="text-xs text-slate-500">{c.label}</p>
                  <p className="text-lg sm:text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{c.value}</p>
                  <p className="text-xs text-slate-400 mt-1">{c.hint}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Tabs defaultValue="orders">
            <TabsList>
              <TabsTrigger value="orders">訂單明細</TabsTrigger>
              <TabsTrigger value="suppliers">供應商彙總</TabsTrigger>
              <TabsTrigger value="items">品項彙總</TabsTrigger>
            </TabsList>

            <TabsContent value="orders">
              <Card>
                <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">訂單明細(共 {report.orders.length} 張)</CardTitle>
                  <DownloadButton kind="orders" count={report.orders.length} />
                </CardHeader>
                <CardContent>
                  {report.orders.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-10">這段期間沒有採購單</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>日期</TableHead>
                          <TableHead>訂單編號</TableHead>
                          <TableHead>供應商</TableHead>
                          <TableHead>狀態</TableHead>
                          <TableHead>品項</TableHead>
                          <TableHead className="text-right">金額</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.orders.map((o) => (
                          <TableRow key={o.id} data-testid="report-order-row">
                            <TableCell className="whitespace-nowrap">{o.date}</TableCell>
                            <TableCell className="font-mono text-xs">{o.orderNo}</TableCell>
                            <TableCell>{o.supplier}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={o.received ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}>
                                {o.statusLabel}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[320px] truncate" title={o.itemsText}>
                              <span className="text-slate-400 mr-1">{o.itemCount} 項</span>
                              {o.itemsText}
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap">{o.amount > 0 ? TWD(o.amount) : "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="suppliers">
              <Card>
                <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">供應商彙總(共 {report.suppliers.length} 家)</CardTitle>
                  <DownloadButton kind="suppliers" count={report.suppliers.length} />
                </CardHeader>
                <CardContent>
                  {report.suppliers.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-10">這段期間沒有採購單</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>供應商</TableHead>
                          <TableHead className="text-right">訂單數</TableHead>
                          <TableHead className="text-right">採購金額</TableHead>
                          <TableHead className="text-right">已收貨單數</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.suppliers.map((s) => (
                          <TableRow key={s.supplier} data-testid="report-supplier-row">
                            <TableCell>{s.supplier}</TableCell>
                            <TableCell className="text-right">{s.orders}</TableCell>
                            <TableCell className="text-right whitespace-nowrap">{s.amount > 0 ? TWD(s.amount) : "—"}</TableCell>
                            <TableCell className="text-right">{s.received}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="items">
              <Card>
                <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">品項彙總(共 {report.items.length} 項)</CardTitle>
                  <DownloadButton kind="items" count={report.items.length} />
                </CardHeader>
                <CardContent>
                  {report.items.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-10">這段期間沒有叫貨品項</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>品項</TableHead>
                          <TableHead>單位</TableHead>
                          <TableHead className="text-right">總數量</TableHead>
                          <TableHead className="text-right">叫貨次數</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.items.map((i) => (
                          <TableRow key={`${i.name}|${i.unit}`} data-testid="report-item-row">
                            <TableCell>{i.name}</TableCell>
                            <TableCell>{i.unit || "—"}</TableCell>
                            <TableCell className="text-right">
                              {i.quantity}
                              {i.hasUnparsed && (
                                <span className="ml-1 text-xs text-amber-600" title="部分數量不是純數字,未計入總數量">*</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">{i.orders}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  {report.items.some((i) => i.hasUnparsed) && (
                    <p className="text-xs text-amber-600 mt-3">* 有些數量不是純數字(例如「3箱」),沒有計入總數量</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
};

export default RestaurantReportsPage;
