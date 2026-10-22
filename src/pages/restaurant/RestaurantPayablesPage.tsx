import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useRestaurant } from "@/components/RestaurantRoute";
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
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

type Filter = "all" | "todo" | "overdue" | InvoiceStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "todo", label: "待我確認" },
  { value: "overdue", label: "已逾期" },
  { value: "confirmed", label: STATUS_META.confirmed.label },
  { value: "disputed", label: STATUS_META.disputed.label },
  { value: "paid", label: STATUS_META.paid.label },
  { value: "void", label: STATUS_META.void.label },
];

const RestaurantPayablesPage = () => {
  const account = useRestaurant();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<InvoiceRow | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<InvoiceRow | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<InvoiceRow | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data: rows, error } = await fetchAllPages((from, to) =>
        db<InvoiceRow>("supplier_invoices")
          .select(INVOICE_COLUMNS)
          .eq("restaurant_id", account.restaurant_id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (error) throw new Error(error.message);
      setInvoices(rows);

      const ids = Array.from(new Set(rows.map((r) => r.supplier_id)));
      const map: Record<string, string> = {};
      if (ids.length > 0) {
        const { data: ss } = await db<{ id: string; name: string }>("suppliers").select("id, name").in("id", ids);
        (ss ?? []).forEach((s) => { map[s.id] = s.name; });
      }
      setNames(map);
    } catch (e) {
      const message = (e as Error).message;
      setLoadError(message);
      toast.error("載入應付帳款失敗", { description: message });
    } finally {
      setLoading(false);
    }
  }, [account.restaurant_id]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => summarizeInvoices(invoices), [invoices]);
  const todoCount = invoices.filter((i) => i.status === "issued").length;

  const visible = useMemo(
    () =>
      invoices.filter((i) => {
        if (filter === "all") return true;
        if (filter === "todo") return i.status === "issued";
        if (filter === "overdue") return isOverdue(i);
        return i.status === filter;
      }),
    [invoices, filter],
  );

  const respond = async (inv: InvoiceRow, action: "confirm" | "dispute", note: string, ok: string) => {
    setBusy(true);
    try {
      await callInvoiceRpc(supabase, "restaurant_respond_invoice", { p_invoice_id: inv.id, p_action: action, p_note: note || null });
      toast.success(ok);
      setConfirmTarget(null);
      setDisputeTarget(null);
      setSelected(null);
      setText("");
      await load();
    } catch (e) {
      toast.error("操作失敗", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const canConfirm = (i: InvoiceRow) => i.status === "issued" || i.status === "disputed";
  const canDispute = (i: InvoiceRow) => i.status === "issued" || i.status === "confirmed";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Receipt className="h-6 w-6 text-emerald-600" />
          應付帳款
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          供應商開來的請款單。核對訂單無誤後按「確認無誤」,有問題就提出異議;款項由你直接付給供應商,平台不經手金流
        </p>
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
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4" data-testid="payable-summary">
            <Card><CardContent className="pt-5">
              <p className="text-xs text-slate-500">應付金額</p>
              <p className="text-lg sm:text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{TWD(totals.openAmount)}</p>
              <p className="text-xs text-slate-400 mt-1">{totals.openCount} 張請款單</p>
            </CardContent></Card>
            <Card><CardContent className="pt-5">
              <p className="text-xs text-slate-500">已逾期</p>
              <p className={`text-lg sm:text-xl font-bold mt-1 whitespace-nowrap ${totals.overdueCount > 0 ? "text-red-600" : "text-slate-800"}`}>{TWD(totals.overdueAmount)}</p>
              <p className="text-xs text-slate-400 mt-1">{totals.overdueCount} 張請款單</p>
            </CardContent></Card>
            <Card className="col-span-2 lg:col-span-1"><CardContent className="pt-5">
              <p className="text-xs text-slate-500">待我確認</p>
              <p className="text-lg sm:text-xl font-bold text-amber-700 mt-1">{todoCount} 張</p>
              <p className="text-xs text-slate-400 mt-1">供應商剛開、還沒回應的請款單</p>
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
                  onClick={() => downloadCsv(`應付帳款_${localDateStr(new Date())}.csv`, invoiceListCsv(visible, names, "supplier_id"))}
                >
                  <Download className="h-4 w-4 mr-1.5" />
                  下載 CSV
                </Button>
              </div>

              {visible.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-10">
                  {invoices.length === 0 ? "還沒有供應商向你請款" : "這個狀態下沒有請款單"}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>請款單號</TableHead>
                      <TableHead>供應商</TableHead>
                      <TableHead>帳期</TableHead>
                      <TableHead>到期日</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                      <TableHead>狀態</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((i) => (
                      <TableRow key={i.id} data-testid="payable-row">
                        <TableCell className="font-mono text-xs whitespace-nowrap">{i.invoice_no}</TableCell>
                        <TableCell>{names[i.supplier_id] ?? "—"}</TableCell>
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
        partyLabel="供應商"
        partyName={selected ? names[selected.supplier_id] ?? "" : ""}
        onClose={() => setSelected(null)}
        actions={
          selected && (
            <>
              <Button
                variant="outline"
                onClick={() => downloadCsv(`請款單_${selected.invoice_no}.csv`, invoiceLinesCsv(selected, names[selected.supplier_id] ?? ""))}
              >
                <Download className="h-4 w-4 mr-1.5" />下載明細
              </Button>
              {canDispute(selected) && (
                <Button variant="outline" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => { setText(""); setDisputeTarget(selected); }}>
                  有異議
                </Button>
              )}
              {canConfirm(selected) && (
                <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setConfirmTarget(selected)}>
                  確認無誤
                </Button>
              )}
            </>
          )
        }
      />

      <AlertDialog open={!!confirmTarget} onOpenChange={(o) => { if (!o) setConfirmTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確認這張請款單無誤?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget && `${confirmTarget.invoice_no},金額 ${TWD(invoiceAmount(confirmTarget))},到期日 ${confirmTarget.due_date}。確認後供應商會看到「已確認」;實際付款請直接與供應商聯繫。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (confirmTarget) void respond(confirmTarget, "confirm", "", "已確認這張請款單"); }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}確認無誤
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!disputeTarget} onOpenChange={(o) => { if (!o) setDisputeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>對這張請款單提出異議</AlertDialogTitle>
            <AlertDialogDescription>
              請寫下哪裡有問題(例如金額不對、少收貨),供應商會看到並重新處理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="異議原因(必填)" aria-label="異議原因" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>先不要</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={busy || text.trim() === ""}
              onClick={(e) => { e.preventDefault(); if (disputeTarget) void respond(disputeTarget, "dispute", text.trim(), "已送出異議"); }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}送出異議
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default RestaurantPayablesPage;
