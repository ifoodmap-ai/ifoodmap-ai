import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { CATALOG_HEADERS, MAX_ROWS, planImport, templateCsv, type CatalogRow, type ImportPlan } from "@/lib/catalog-import";
import { readCsvFile } from "@/lib/csv-file";
import { downloadCsv } from "@/lib/restaurant-report";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  supplies: readonly CatalogRow[];
  /** 套用成功(或部分成功)後呼叫,讓頁面重新讀目錄 */
  onApplied: () => void | Promise<void>;
}

const CHUNK = 200;
const chunks = <T,>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

const table = (name: string) => (supabase as never as { from: (t: string) => { insert: (v: unknown) => PromiseLike<{ error: { message: string } | null }>; upsert: (v: unknown, o: { onConflict: string }) => PromiseLike<{ error: { message: string } | null }> } }).from(name);

/** 商品目錄批次匯入:選 CSV → 先預覽「新增幾個、更新幾個、哪幾列有問題」→ 按確定才寫入 */
const SupplierCatalogImportDialog = ({ open, onOpenChange, supplierId, supplies, onApplied }: Props) => {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [applying, setApplying] = useState(false);

  const reset = () => { setFileName(""); setPlan(null); if (input.current) input.current.value = ""; };
  const close = (v: boolean) => { if (applying) return; if (!v) reset(); onOpenChange(v); };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    try {
      setPlan(planImport(await readCsvFile(file), supplies));
    } catch {
      setPlan({ creates: [], updates: [], unchanged: 0, errors: [{ line: 1, message: "讀不到這個檔案" }] });
    }
  };

  const byId = useMemo(() => new Map(supplies.map((s) => [s.id, s])), [supplies]);
  const todo = plan ? plan.creates.length + plan.updates.length : 0;

  const apply = async () => {
    if (!plan || todo === 0) return;
    setApplying(true);
    let created = 0;
    let updated = 0;
    try {
      for (const part of chunks(plan.creates)) {
        const { error } = await table("supplies").insert(part.map((c) => ({ ...c.fields, supplier_id: supplierId, currency: "TWD" })));
        if (error) throw new Error(error.message);
        created += part.length;
      }
      for (const part of chunks(plan.updates)) {
        const rows = part.map((u) => {
          const { id, ...rest } = byId.get(u.id) as CatalogRow;
          return { ...rest, ...u.patch, id, supplier_id: supplierId };
        });
        const { error } = await table("supplies").upsert(rows, { onConflict: "id" });
        if (error) throw new Error(error.message);
        updated += part.length;
      }
      toast({ title: `匯入完成:新增 ${created} 個、更新 ${updated} 個商品` });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "匯入中斷",
        description: `${(e as Error).message}(已寫入:新增 ${created} 個、更新 ${updated} 個;其餘沒有寫入,修正後重新匯入同一個檔案即可)`,
        variant: "destructive",
      });
    } finally {
      setApplying(false);
      await onApplied();
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>批次匯入商品</DialogTitle>
          <DialogDescription>
            用 Excel 整理好商品,存成 CSV 一次匯入。用「貨號」(沒有就用商品名稱)比對現有商品:比到就更新、比不到就新增。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-sm text-slate-600">
          <p>欄位:{CATALOG_HEADERS.join("、")}(只有「商品名稱」必填,一次最多 {MAX_ROWS} 列)</p>
          <ul className="list-disc pl-5 space-y-0.5 text-xs text-slate-500">
            <li>儲存格空白 = 不動現有的值;匯入不會刪除商品,也不能清空欄位(要清空請到商品編輯)。</li>
            <li>「上架」寫「是」或「否」,新增商品沒寫預設上架。</li>
            <li>最簡單的做法:先到頁面按「匯出 CSV」,用 Excel 改完再匯入。</li>
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label="選擇商品 CSV 檔案"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={applying}>
            <FileSpreadsheet className="h-4 w-4 mr-1.5" />選擇 CSV 檔案
          </Button>
          <Button variant="ghost" size="sm" onClick={() => downloadCsv("商品目錄範本.csv", templateCsv())}>
            <Download className="h-4 w-4 mr-1.5" />下載範本
          </Button>
          {fileName && <span className="text-xs text-slate-500">{fileName}</span>}
        </div>

        {plan && (
          <div className="space-y-3" data-testid="import-preview">
            <p className="text-sm text-slate-700" data-testid="import-summary">
              新增 <span className="font-semibold text-emerald-700">{plan.creates.length}</span> 個、更新 <span className="font-semibold text-emerald-700">{plan.updates.length}</span> 個
              {plan.unchanged > 0 && <>、沒有變動 {plan.unchanged} 個</>}
              {plan.errors.length > 0 && <>、<span className="font-semibold text-amber-700">有問題 {plan.errors.length} 列(不會匯入)</span></>}
            </p>

            {plan.errors.length > 0 && (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="import-errors">
                <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />這些列有問題</p>
                <ul className="mt-1 list-disc pl-5 space-y-0.5 max-h-40 overflow-y-auto">
                  {plan.errors.map((e, i) => <li key={`${e.line}-${i}`}>第 {e.line} 列:{e.message}</li>)}
                </ul>
              </div>
            )}

            {plan.updates.length > 0 && (
              <div className="rounded-lg border border-slate-200 text-sm">
                <p className="px-4 py-2 font-medium text-slate-700 border-b border-slate-200">要更新的商品</p>
                <ul className="max-h-48 overflow-y-auto divide-y divide-slate-100" data-testid="import-updates">
                  {plan.updates.map((u) => (
                    <li key={u.id} className="px-4 py-2">
                      <span className="font-medium text-slate-800">{u.name}</span>
                      <span className="ml-2 text-xs text-slate-500">{u.changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(";")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.creates.length > 0 && (
              <p className="text-xs text-slate-500" data-testid="import-creates">
                新增:{plan.creates.slice(0, 8).map((c) => c.fields.name).join("、")}{plan.creates.length > 8 ? ` 等 ${plan.creates.length} 個` : ""}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={applying}>取消</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => void apply()} disabled={applying || todo === 0}>
            {applying && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            {todo > 0 ? `確定匯入(${todo} 個商品)` : "確定匯入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SupplierCatalogImportDialog;
