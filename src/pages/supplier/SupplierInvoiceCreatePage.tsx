import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, FilePlus2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { dealLedger, fetchAllPages, type StatusEventRow } from "@/lib/metrics";
import {
  PERIOD_LABEL, TWD, callInvoiceRpc, defaultNetDays, dueDateOf, eligibleOrders, periodRange,
  type CandidateOrder, type PeriodKind,
} from "@/lib/invoices";
import { RANGE_PRESETS, localDateStr, presetRange } from "@/lib/restaurant-report";

type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: readonly unknown[]): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  range(from: number, to: number): Q<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

const ID_CHUNK = 100;
const chunk = <T,>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

interface Customer { id: string; name: string }

const KINDS: PeriodKind[] = ["daily", "monthly", "custom"];

const SupplierInvoiceCreatePage = () => {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [restaurantId, setRestaurantId] = useState("");

  const today = localDateStr(new Date());
  const [kind, setKind] = useState<PeriodKind>("monthly");
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [start, setStart] = useState(presetRange("thisMonth").start);
  const [end, setEnd] = useState(today);
  const [netDays, setNetDays] = useState(String(defaultNetDays("monthly")));
  const [note, setNote] = useState("");

  const [loadingOrders, setLoadingOrders] = useState(false);
  const [orders, setOrders] = useState<CandidateOrder[]>([]);
  const [events, setEvents] = useState<StatusEventRow[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [invoiced, setInvoiced] = useState<Set<string>>(new Set());
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 供應商帳號與有往來的客戶
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { data: acct } = await db<{ supplier_id: string }>("supplier_accounts")
          .select("supplier_id").eq("user_id", session.user.id).eq("is_active", true).maybeSingle();
        const sid = acct?.supplier_id ?? null;
        if (cancelled) return;
        setSupplierId(sid);
        if (!sid) return;

        const { data: rows, error } = await fetchAllPages((from, to) =>
          db<{ id: string; restaurant_id: string | null }>("supplier_orders")
            .select("id, restaurant_id")
            .eq("supplier_id", sid)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        );
        if (error) throw new Error(error.message);
        const ids = Array.from(new Set(rows.map((r) => r.restaurant_id).filter(Boolean) as string[]));
        const list: Customer[] = [];
        for (const part of chunk(ids, ID_CHUNK)) {
          const { data: rs } = await db<Customer>("restaurants").select("id, name").in("id", part);
          list.push(...(rs ?? []));
        }
        list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        if (!cancelled) setCustomers(list);
      } catch (e) {
        if (!cancelled) toast.error("載入客戶失敗", { description: (e as Error).message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 選了客戶:讀他的訂單、收貨事件、已經請款過的訂單
  useEffect(() => {
    if (!supplierId || !restaurantId) {
      setOrders([]); setEvents([]); setInvoiced(new Set()); setEventsError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingOrders(true);
      setUnchecked(new Set());
      try {
        const { data: rows, error } = await fetchAllPages((from, to) =>
          db<CandidateOrder>("supplier_orders")
            .select("id, status, total_amount, created_at")
            .eq("supplier_id", supplierId)
            .eq("restaurant_id", restaurantId)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        );
        if (error) throw new Error(error.message);

        const orderIds = rows.map((o) => o.id);
        let eventRows: StatusEventRow[] = [];
        let evErr: string | null = null;
        for (const part of chunk(orderIds, ID_CHUNK)) {
          const { data: ev, error: e1 } = await fetchAllPages((from, to) =>
            db<StatusEventRow>('order_events')
              .select("order_id, to_status, created_at")
              .in("order_id", part)
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .range(from, to),
          );
          if (e1) { eventRows = []; evErr = e1.message ?? "未知錯誤"; break; }
          eventRows.push(...ev);
        }

        const done = new Set<string>();
        for (const part of chunk(orderIds, ID_CHUNK)) {
          const { data: io } = await db<{ order_id: string }>("supplier_invoice_orders").select("order_id").in("order_id", part);
          (io ?? []).forEach((r) => done.add(r.order_id));
        }

        if (cancelled) return;
        setOrders(rows);
        setEvents(eventRows);
        setEventsError(evErr);
        setInvoiced(done);
      } catch (e) {
        if (!cancelled) toast.error("載入訂單失敗", { description: (e as Error).message });
      } finally {
        if (!cancelled) setLoadingOrders(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId, restaurantId]);

  const range = useMemo(() => periodRange(kind, { day, month, start, end }), [kind, day, month, start, end]);
  const ledger = useMemo(() => dealLedger(events), [events]);
  const eligible = useMemo(
    () => (range ? eligibleOrders(orders, ledger, invoiced, range.start, range.end) : []),
    [orders, ledger, invoiced, range],
  );
  const picked = eligible.filter((o) => !unchecked.has(o.id));
  const total = picked.reduce((s, o) => s + o.amount, 0);

  const netOk = /^\d+$/.test(netDays) && Number(netDays) <= 365;
  const due = range && netOk ? dueDateOf(range.end, Number(netDays)) : null;
  const canSubmit = !!supplierId && !!restaurantId && !!range && netOk && picked.length > 0 && !submitting;

  const changeKind = (k: PeriodKind) => {
    setKind(k);
    setNetDays(String(defaultNetDays(k)));
  };

  const toggle = (id: string, on: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id); else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!canSubmit || !range) return;
    setSubmitting(true);
    try {
      await callInvoiceRpc(supabase, "supplier_create_invoice", {
        p_supplier_id: supplierId,
        p_restaurant_id: restaurantId,
        p_period_kind: kind,
        p_period_start: range.start,
        p_period_end: range.end,
        p_net_days: Number(netDays),
        p_order_ids: picked.map((o) => o.id),
        p_note: note.trim() || null,
      });
      toast.success("請款單已開立,餐廳可以在「應付帳款」看到");
      navigate("/supplier/invoices");
    } catch (e) {
      toast.error("開立失敗", { description: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <FilePlus2 className="h-6 w-6 text-emerald-600" />
          新增請款
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          選客戶與帳期,系統列出這段期間餐廳「已確認收貨」、還沒請款的訂單,勾選後開立請款單
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : !supplierId ? (
        <p className="text-sm text-slate-500">找不到你的供應商帳號。</p>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">1. 客戶與帳期</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 max-w-sm">
                <label className="text-xs text-slate-500" htmlFor="invoice-customer">客戶</label>
                <Select value={restaurantId} onValueChange={setRestaurantId}>
                  <SelectTrigger id="invoice-customer" aria-label="客戶"><SelectValue placeholder={customers.length === 0 ? "還沒有往來的客戶" : "選擇客戶"} /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-slate-500">帳期</p>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="帳期">
                  {KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={kind === k}
                      onClick={() => changeKind(k)}
                      className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
                        kind === k
                          ? "bg-emerald-600 border-emerald-600 text-white"
                          : "bg-white border-slate-200 text-slate-600 hover:border-emerald-300"
                      }`}
                    >
                      {PERIOD_LABEL[k]}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  {kind === "daily" && (
                    <div className="space-y-1">
                      <label htmlFor="invoice-day" className="text-xs text-slate-500">日期</label>
                      <Input id="invoice-day" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="w-44" />
                    </div>
                  )}
                  {kind === "monthly" && (
                    <div className="space-y-1">
                      <label htmlFor="invoice-month" className="text-xs text-slate-500">月份</label>
                      <Input id="invoice-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
                    </div>
                  )}
                  {kind === "custom" && (
                    <>
                      <div className="space-y-1">
                        <label htmlFor="invoice-start" className="text-xs text-slate-500">起日</label>
                        <Input id="invoice-start" type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} className="w-44" />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="invoice-end" className="text-xs text-slate-500">迄日</label>
                        <Input id="invoice-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} className="w-44" />
                      </div>
                    </>
                  )}
                  <div className="space-y-1">
                    <label htmlFor="invoice-net" className="text-xs text-slate-500">付款天數(迄日後幾天內付款)</label>
                    <Input
                      id="invoice-net" value={netDays} inputMode="numeric"
                      onChange={(e) => { if (/^\d{0,3}$/.test(e.target.value)) setNetDays(e.target.value); }}
                      className="w-28"
                    />
                  </div>
                </div>

                {kind === "custom" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">快速選擇</span>
                    {RANGE_PRESETS.map((p) => (
                      <button
                        key={p.key} type="button"
                        onClick={() => { const r = presetRange(p.key); setStart(r.start); setEnd(r.end); }}
                        className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}

                <p className="text-xs text-slate-400">
                  {range ? `請款區間 ${range.start}${range.start === range.end ? "" : ` 至 ${range.end}`}` : "請完整填寫日期"}
                  {due && `,到期日 ${due}`}
                  。依餐廳確認收貨的日期判斷訂單落在哪個區間。
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">2. 選擇要請款的訂單</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {eventsError && (
                <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  讀不到訂單履歷,已結案的訂單暫時不會列出:{eventsError}
                </div>
              )}
              {!restaurantId ? (
                <p className="text-sm text-slate-400 text-center py-8">先選擇客戶</p>
              ) : loadingOrders ? (
                <Skeleton className="h-40 w-full rounded-xl" />
              ) : !range ? (
                <p className="text-sm text-slate-400 text-center py-8">請先完整填寫帳期日期</p>
              ) : eligible.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">這段期間沒有可請款的訂單(要已確認收貨、有金額、且還沒請款)</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><span className="sr-only">選取</span></TableHead>
                      <TableHead>訂單編號</TableHead>
                      <TableHead>收貨日</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {eligible.map((o) => (
                      <TableRow key={o.id} data-testid="eligible-order">
                        <TableCell>
                          <Checkbox
                            checked={!unchecked.has(o.id)}
                            onCheckedChange={(v) => toggle(o.id, v === true)}
                            aria-label={`請款 ${o.orderNo}`}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{o.orderNo}</TableCell>
                        <TableCell>{o.receivedDate}</TableCell>
                        <TableCell className="text-right">{TWD(o.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="備註(選填,例如:匯款帳號、聯絡人)" aria-label="備註" />
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <p className="text-sm text-slate-500 flex-1" data-testid="invoice-total">
                  已選 <span className="font-semibold text-slate-800">{picked.length}</span> 張訂單,請款金額{" "}
                  <span className="font-semibold text-slate-800">{TWD(total)}</span>
                </p>
                <Button onClick={submit} disabled={!canSubmit} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  開立請款單
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

export default SupplierInvoiceCreatePage;
