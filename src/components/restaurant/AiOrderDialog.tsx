import { useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { friendlyAiError, parseOrder, type ParsedOrder } from "@/lib/api";

export interface AiOrderRow { name: string; quantity: string; unit: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierName: string;
  /** 這家供應商的品名(叫過的 + 商品目錄),讓 AI 遇到簡稱時用同一個寫法 */
  knownItems: string[];
  /** 這個品名已經在叫貨清單裡了嗎(是 → 加入時只改數量) */
  isListed: (name: string) => boolean;
  onApply: (rows: AiOrderRow[]) => void;
}

interface Row extends AiOrderRow { key: string; include: boolean; source: string }

const MAX_IMAGE_MB = 10;
const isQty = (q: string) => /^\d+(\.\d+)?$/.test(q.trim()) && Number(q) > 0;

/**
 * 貼上 LINE 訊息 / 拍手寫單 → AI 整理成叫貨品項 → 使用者核對、改數量 → 加進叫貨清單。
 * AI 只是幫忙「打字」:沒有任何東西會自動送出,數量看不出來的品項要使用者自己填。
 */
const AiOrderDialog = ({ open, onOpenChange, supplierName, knownItems, isListed, onApply }: Props) => {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unclear, setUnclear] = useState<string[]>([]);

  const reset = () => { setText(""); setFile(null); setLoading(false); setError(null); setRows(null); setUnclear([]); };
  const close = (v: boolean) => { if (loading) return; if (!v) reset(); onOpenChange(v); };

  const pickFile = (f: File | undefined) => {
    setError(null);
    if (!f) { setFile(null); return; }
    if (!f.type.startsWith("image/")) { setError("請選擇圖片檔(手寫單的照片或截圖)"); return; }
    if (f.size > MAX_IMAGE_MB * 1024 * 1024) { setError(`圖片太大了(上限 ${MAX_IMAGE_MB} MB)`); return; }
    setFile(f);
  };

  const recognize = async () => {
    setLoading(true);
    setError(null);
    try {
      const r: ParsedOrder = await parseOrder({ text, file, knownItems });
      setRows(r.items.map((i, n) => ({
        key: `${n}-${i.name}`,
        name: i.name,
        quantity: i.quantity > 0 ? String(i.quantity) : "",
        unit: i.unit,
        source: i.source_text,
        include: true,
      })));
      setUnclear(r.unclear);
      if (r.items.length === 0) setError("沒有辨識到要訂的品項,可以換個寫法或拍清楚一點再試");
    } catch (e) {
      setError(friendlyAiError(e) ?? (e instanceof Error ? e.message : "辨識失敗,請稍後再試"));
    } finally {
      setLoading(false);
    }
  };

  const patch = (key: string, p: Partial<Row>) => setRows((cur) => cur?.map((r) => (r.key === key ? { ...r, ...p } : r)) ?? null);
  const chosen = rows?.filter((r) => r.include) ?? [];
  const bad = chosen.filter((r) => !r.name.trim() || !isQty(r.quantity));
  const canApply = chosen.length > 0 && bad.length === 0;

  const apply = () => {
    if (!canApply) return;
    onApply(chosen.map((r) => ({ name: r.name.trim(), quantity: r.quantity.trim(), unit: r.unit.trim() })));
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>貼上訊息 / 拍手寫單</DialogTitle>
          <DialogDescription>
            把平常傳給{supplierName ? ` ${supplierName} ` : "供應商"}的 LINE 訊息貼上來,或拍手寫的叫貨單,AI 幫你整理成品項。核對過數量才會加進叫貨清單,不會自動送出。
          </DialogDescription>
        </DialogHeader>

        {!rows ? (
          <div className="space-y-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"例:\n高麗菜 10kg\n雞蛋 2箱\n小白菜 5把"}
              rows={6}
              aria-label="叫貨訊息"
              maxLength={5000}
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <ImagePlus className="h-4 w-4" />
                {file ? "換一張照片" : "上傳手寫單照片"}
                <input type="file" accept="image/*" className="sr-only" aria-label="上傳手寫單照片" onChange={(e) => pickFile(e.target.files?.[0])} />
              </label>
              {file && <span className="text-xs text-slate-500">{file.name}</span>}
            </div>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3" data-testid="ai-order-rows">
            <p className="text-sm text-slate-600">
              辨識出 {rows.length} 項,請核對品名與數量(AI 可能看錯)。不要的取消勾選;「已在清單」的品項只會更新數量與單位。
            </p>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {rows.map((r) => {
                const listed = isListed(r.name);
                const qtyBad = r.include && !isQty(r.quantity);
                return (
                  <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-testid="ai-order-row">
                    <Checkbox checked={r.include} onCheckedChange={(v) => patch(r.key, { include: v === true })} aria-label={`加入 ${r.name}`} />
                    <div className="min-w-[140px] flex-1">
                      <Input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} className="h-9" aria-label={`${r.name} 品名`} />
                      <p className="mt-1 text-xs text-slate-400">
                        {listed ? "已在清單(更新數量)" : "新增品項"}
                        {r.source && <> · 原文:{r.source}</>}
                      </p>
                    </div>
                    <Input
                      value={r.quantity}
                      inputMode="decimal"
                      placeholder="數量"
                      aria-label={`${r.name} 數量`}
                      aria-invalid={qtyBad}
                      onChange={(e) => { if (/^\d*\.?\d{0,2}$/.test(e.target.value)) patch(r.key, { quantity: e.target.value }); }}
                      className={`h-9 w-24 ${qtyBad ? "border-red-400" : ""}`}
                    />
                    <Input value={r.unit} placeholder="單位" aria-label={`${r.name} 單位`} onChange={(e) => patch(r.key, { unit: e.target.value })} className="h-9 w-20" />
                  </div>
                );
              })}
            </div>
            {bad.length > 0 && <p role="alert" className="text-xs text-red-600">有 {bad.length} 項要勾選的品項還沒有填數量(大於 0 的數字)</p>}
            {unclear.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="ai-order-unclear">
                <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />這些看不清楚,沒有加入(需要的話請手動加)</p>
                <ul className="mt-1 list-disc pl-5">{unclear.map((u, i) => <li key={`${i}-${u}`}>{u}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {rows ? (
            <>
              <Button variant="outline" onClick={() => { setRows(null); setUnclear([]); setError(null); }}>重新辨識</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!canApply} onClick={apply}>
                加入叫貨清單{chosen.length > 0 ? `(${chosen.length} 項)` : ""}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={loading}>取消</Button>
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={loading || (!text.trim() && !file)} onClick={() => void recognize()}>
                {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                {loading ? "辨識中…" : "AI 辨識"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AiOrderDialog;
