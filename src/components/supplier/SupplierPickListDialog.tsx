import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { addDays, deliveryLabel, taipeiNow } from "@/lib/delivery";
import { buildPickList, isPickable, linesCsv, totalsCsv, type PickOrder } from "@/lib/pick-list";
import { downloadCsv } from "@/lib/restaurant-report";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orders: readonly PickOrder[];
  customerNames: Readonly<Record<string, string>>;
}

/** 出貨彙總與揀貨單:選一個配送日,看「每個品項總共要備多少」,並下載給倉庫 / 進銷存用的 CSV(Excel 可開) */
const SupplierPickListDialog = ({ open, onOpenChange, orders, customerNames }: Props) => {
  const [date, setDate] = useState(() => addDays(taipeiNow().date, 1));
  const list = useMemo(() => buildPickList(orders, date, customerNames), [orders, date, customerNames]);
  const undated = useMemo(() => orders.filter((o) => !o.delivery_date && isPickable(o)).length, [orders]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>出貨彙總與揀貨單</DialogTitle>
          <DialogDescription>選配送日,看這天已接單的訂單每個品項總共要備多少,並下載 CSV(可用 Excel 開啟)。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="pick-date" className="text-xs text-slate-500">配送日</label>
            <Input id="pick-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
          </div>
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" disabled={list.totals.length === 0} onClick={() => downloadCsv(`出貨彙總_${date}.csv`, totalsCsv(list.totals))}>
              <Download className="h-4 w-4 mr-1.5" />下載出貨彙總
            </Button>
            <Button variant="outline" size="sm" disabled={list.lines.length === 0} onClick={() => downloadCsv(`揀貨單_${date}.csv`, linesCsv(list.lines))}>
              <Download className="h-4 w-4 mr-1.5" />下載揀貨單
            </Button>
          </div>
        </div>

        <p className="text-sm text-slate-600" data-testid="pick-summary">
          {deliveryLabel(date) ?? date} 共 <span className="font-semibold">{list.orderCount}</span> 張已接單的訂單
          {list.waitingCount > 0 && <span className="text-amber-700">,另有 {list.waitingCount} 張還沒接單(沒有算進去)</span>}
        </p>
        {undated > 0 && (
          <p className="text-xs text-slate-400">另有 {undated} 張進行中的訂單沒有配送日(舊單或平台派單),不會出現在彙總裡。</p>
        )}

        {list.totals.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-8">這一天沒有要備貨的訂單</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>品項</TableHead>
                <TableHead>單位</TableHead>
                <TableHead className="text-right">總數量</TableHead>
                <TableHead className="text-right">客戶數</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.totals.map((r) => (
                <TableRow key={`${r.name}|${r.unit}`} data-testid="pick-row">
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.unit || "—"}</TableCell>
                  <TableCell className="text-right">
                    {r.quantity}
                    {r.hasUnparsed && <span className="ml-1 text-xs text-amber-600" title="部分數量不是純數字,未計入總數量">*</span>}
                  </TableCell>
                  <TableCell className="text-right">{r.customers}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {list.totals.some((r) => r.hasUnparsed) && (
          <p className="text-xs text-amber-600">* 有些數量不是純數字(例如「3箱」),沒有計入總數量,請看揀貨單</p>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default SupplierPickListDialog;
