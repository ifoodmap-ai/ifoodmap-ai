import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Download, Loader2, Receipt } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/metrics";
import {
  INVOICE_COLUMNS, PERIOD_LABEL, STATUS_META, TWD, callInvoiceRpc, invoiceAmount, invoiceLinesCsv,
  invoiceListCsv, isOverdue, periodText, summarizeInvoices, type InvoiceRow, type InvoiceStatus,
} from "@/lib/invoices";
import { downloadCsv, localDateStr } from "@/lib/restaurant-report";
import { InvoiceDetailDialog, InvoiceStatusBadge } from "@/components/invoices/InvoiceParts";

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

type Filter = "all" | "open" | "overdue" | InvoiceStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "未收款" },
  { value: "overdue", label: "已逾期" },
  { value: "issued", label: STATUS_META.issued.label },
  { value: "confirmed", label: STATUS_META.confirmed.label },
  { value: "disputed", label: STATUS_META.disputed.label },
  { value: "paid", label: STATUS_META.paid.label },
  { value: "void", label: STATUS_META.void.label },
];

const SupplierInvoicesPage = () => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<InvoiceRow | null>(null);
  const [payTarget, setPayTarget] = useState<InvoiceRow | null>(null);
  const [voidTarget, setVoidTarget] = useState<InvoiceRow | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setLoading(false); return; }
      const { data: acct } = await db<{ supplier_id: string }>("supplier_accounts")
        .select("supplier_id").eq("user_id", session.user.id).eq("is_active", true).maybeSingle();
      const sid = acct?.supplier_id ?? null;
      setSupplierId(sid);
      if (!sid) { setLoading(false); return; }

      const { data: rows, error } = await fetchAllPages((from, to) =>
        db<InvoiceRow>("supplier_invoices")
          .select(INVOICE_COLUMNS)
          .eq("supplier_id", sid)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (error) throw new Error(error.message);
      setInvoices(rows);

      const ids = Array.from(new Set(rows.map((r) => r.restaurant_id)));
      const map: Record<string, string> = {};
      if (ids.length > 0) {
        const { data: rs } = await db<{ id: string; name: string }>("restaurants").select("id, name").in("id", ids);
        (rs ?? []).forEach((r) => { map[r.id] = r.name; });
      }
      setNames(map);
    } catch (e) {
      const message = (e as Error).message;
      setLoadError(message);
      toast.error("載入請款單失敗", { description: message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => summarizeInvoices(invoices), [invoices]);

  const visible = useMemo(
    () =>
      invoices.filter((i) => {
        if (filter === "all") return true;
        if (filter === "open") return i.status === "issued" || i.status === "confirmed" || i.status === "disputed";
        if (filter === "overdue") return isOverdue(i);
        return i.status === filter;
      }),
    [invoices, filter],
  );

  const run = async (fn: "supplier_mark_invoice_paid" | "supplier_void_invoice", args: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await callInvoiceRpc(supabase, fn, args);
      toast.success(ok);
      setPayTarget(null);
      setVoidTarget(null);
      setSelected(null);
      setText("");
      await load();
    } catch (e) {
      toast.error("操作失敗", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const canAct = (i: InvoiceRow) => i.status === "issued" || i.status === "confirmed" || i.status === "disputed";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Receipt className="h-6 w-6 text-emerald-600" />
            請款單
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            依帳期(日結、月結、自訂區間)向餐廳請款;餐廳確認後,收到款項再標記已收款
          </p>
        </div>
        <Button asChild className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Link to="/supplier/invoice-create">新增請款</Link>
        </Button>
      </div>

      {loadError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          載入失敗:{loadError}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : !supplierId ? (
        <p className="text-sm text-slate-500">找不到你的供應商帳號。</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4" data-testid="invoice-summary">
            <Card><CardContent className="pt-5">
              <p className="text-xs text-slate-500">未收款</p>
              <p className="text-lg sm:text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{TWD(totals.openAmount)}</p>
              <p className="text-xs text-slate-400 mt-1">{totals.openCount} 張請款單</p>
            </CardContent></Card>
            <Card><CardContent className="pt-5">
              <p className="text-xs text-slate-500">已逾期</p>
              <p className={`text-lg sm:text-xl font-bold mt-1 whitespace-nowrap ${totals.overdueCount > 0 ? "text-red-600" : "text-slate-800"}`}>{TWD(totals.overdueAmount)}</p>
              <p className="text-xs text-slate-400 mt-1">{totals.overdueCount} 張請款單</p>
            </CardContent></Card>
            <Card className="col-span-2 lg:col-span-1"><CardContent className="pt-5">
              <p className="text-xs text-slate-500">已收款(累計)</p>
              <p className="text-lg sm:text-xl font-bold text-emerald-700 mt-1 whitespace-nowrap">{TWD(totals.paidAmount)}</p>
              <p className="text-xs text-slate-400 mt-1">已標記收款的請款單</p>
            </CardContent></Card>
          </div>

          <Card>
            <CardContent className="pt-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                  <SelectTrigger className="w-40" aria-label="狀態篩選"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline" size="sm" disabled={visible.length === 0}
                  onClick={() => downloadCsv(`請款單列表_${localDateStr(new Date())}.csv`, invoiceListCsv(visible, names, "restaurant_id"))}
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  下載 CSV
                </Button>
              </div>

              {visible.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-10">
                  {invoices.length === 0 ? "還沒有請款單,按右上角「新增請款」開第一張" : "這個狀態下沒有請款單"}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>請款單號</TableHead>
                      <TableHead>客戶</TableHead>
                      <TableHead>帳期</TableHead>
                      <TableHead>到期日</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                      <TableHead>狀態</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((i) => (
                      <TableRow key={i.id} data-testid="invoice-row">
                        <TableCell className="font-mono text-xs whitespace-nowrap">{i.invoice_no}</TableCell>
                        <TableCell>{names[i.restaurant_id] ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {PERIOD_LABEL[i.period_kind]}
                          <span className="block text-xs text-slate-400">{periodText(i)}</span>
                        </TableCell>
                        <TableCell className={`whitespace-nowrap ${isOverdue(i) ? "text-red-600 font-medium" : ""}`}>{i.due_date}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{TWD(invoiceAmount(i))}</TableCell>
                        <TableCell><InvoiceStatusBadge invoice={i} /></TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelected(i)}>查看</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <InvoiceDetailDialog
        invoice={selected}
        partyLabel="客戶"
        partyName={selected ? names[selected.restaurant_id] ?? "" : ""}
        onClose={() => setSelected(null)}
        actions={
          selected && (
            <>
              <Button
                variant="outline"
                onClick={() => downloadCsv(`請款單_${selected.invoice_no}.csv`, invoiceLinesCsv(selected, names[selected.restaurant_id] ?? ""))}
              >
                <Download className="h-4 w-4 mr-1.5" />下載明細
              </Button>
              {canAct(selected) && (
                <>
                  <Button variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => { setText(""); setVoidTarget(selected); }}>
                    作廢
                  </Button>
                  <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => { setText(""); setPayTarget(selected); }}>
                    標記已收款
                  </Button>
                </>
              )}
            </>
          )
        }
      />

      <AlertDialog open={!!payTarget} onOpenChange={(o) => { if (!o) setPayTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>標記這張請款單已收款?</AlertDialogTitle>
            <AlertDialogDescription>
              {payTarget && `${payTarget.invoice_no},金額 ${TWD(invoiceAmount(payTarget))}。標記後不能再修改或作廢。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="備註(選填,例如:轉帳後五碼、收款日期)" aria-label="收款備註" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (payTarget) void run("supplier_mark_invoice_paid", { p_invoice_id: payTarget.id, p_note: text.trim() || null }, "已標記收款");
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}確定已收款
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!voidTarget} onOpenChange={(o) => { if (!o) setVoidTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>作廢這張請款單?</AlertDialogTitle>
            <AlertDialogDescription>
              作廢後這張請款單裡的訂單會釋放出來,可以重新開請款單。請寫下作廢原因,餐廳也看得到。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="作廢原因(必填,例如:金額寫錯)" aria-label="作廢原因" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={busy || text.trim() === ""}
              onClick={(e) => {
                e.preventDefault();
                if (voidTarget) void run("supplier_void_invoice", { p_invoice_id: voidTarget.id, p_reason: text.trim() }, "已作廢,訂單已釋放");
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}確定作廢
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SupplierInvoicesPage;
