import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PERIOD_LABEL, STATUS_META, TWD, invoiceAmount, isOverdue, periodText, type InvoiceRow,
} from "@/lib/invoices";
import { localDateStr } from "@/lib/restaurant-report";

export const InvoiceStatusBadge = ({ invoice }: { invoice: InvoiceRow }) => {
  const meta = STATUS_META[invoice.status];
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
      {isOverdue(invoice) && (
        <Badge variant="outline" className="bg-red-600 text-white border-red-600">逾期</Badge>
      )}
    </span>
  );
};

const when = (iso: string | null) => (iso ? localDateStr(new Date(iso)) : "");

interface InvoiceDetailDialogProps {
  invoice: InvoiceRow | null;
  /** 「客戶」(供應商看)或「供應商」(餐廳看) */
  partyLabel: string;
  partyName: string;
  onClose: () => void;
  /** 操作按鈕(標記已收款、確認…),放在對話框底部 */
  actions?: ReactNode;
}

/** 請款單明細:基本資料、狀態紀錄、包含的訂單 */
export const InvoiceDetailDialog = ({ invoice, partyLabel, partyName, onClose, actions }: InvoiceDetailDialogProps) => {
  const lines = invoice && Array.isArray(invoice.lines) ? invoice.lines : [];
  return (
    <Dialog open={!!invoice} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {invoice && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                請款單 {invoice.invoice_no}
                <InvoiceStatusBadge invoice={invoice} />
              </DialogTitle>
              <DialogDescription>
                {partyLabel}:{partyName || "—"} · {PERIOD_LABEL[invoice.period_kind]} {periodText(invoice)}
              </DialogDescription>
            </DialogHeader>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div><dt className="text-xs text-slate-400">金額</dt><dd className="font-semibold text-slate-800">{TWD(invoiceAmount(invoice))}</dd></div>
              <div><dt className="text-xs text-slate-400">到期日</dt><dd className={isOverdue(invoice) ? "font-semibold text-red-600" : "text-slate-800"}>{invoice.due_date}(付款 {invoice.net_days} 天)</dd></div>
              <div><dt className="text-xs text-slate-400">開立日</dt><dd className="text-slate-800">{when(invoice.issued_at)}</dd></div>
              {invoice.note && <div className="col-span-2"><dt className="text-xs text-slate-400">備註</dt><dd className="text-slate-800 whitespace-pre-wrap">{invoice.note}</dd></div>}
            </dl>

            <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 space-y-1" data-testid="invoice-history">
              <p>{when(invoice.issued_at)} 供應商開立請款單</p>
              {invoice.confirmed_at && <p>{when(invoice.confirmed_at)} 餐廳確認無誤</p>}
              {invoice.disputed_at && <p className="text-red-700">{when(invoice.disputed_at)} 餐廳提出異議:{invoice.dispute_note}</p>}
              {invoice.paid_at && <p className="text-emerald-700">{when(invoice.paid_at)} 已收款{invoice.paid_note ? `(${invoice.paid_note})` : ""}</p>}
              {invoice.voided_at && <p className="text-slate-500">{when(invoice.voided_at)} 已作廢:{invoice.void_reason}</p>}
            </div>

            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">包含的訂單(共 {lines.length} 張)</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>訂單編號</TableHead>
                    <TableHead>訂單日期</TableHead>
                    <TableHead className="text-right">金額</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.order_id}>
                      <TableCell className="font-mono text-xs">{l.order_no}</TableCell>
                      <TableCell>{when(l.ordered_at)}</TableCell>
                      <TableCell className="text-right">{TWD(Number(l.amount))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {actions && <DialogFooter className="gap-2 sm:gap-2 flex-wrap">{actions}</DialogFooter>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
