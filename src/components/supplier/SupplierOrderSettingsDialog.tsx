import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_RULES, WEEKDAY_LABEL, describeRules, hhmm, type OrderRules } from "@/lib/delivery";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
}

type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  upsert(values: unknown, opts?: { onConflict: string }): Q<T>;
  delete(): Q<T>;
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

const LEAD_OPTIONS = [0, 1, 2, 3, 7];
const leadLabel = (n: number) => (n === 0 ? "配送當天" : `配送日前 ${n} 天`);

/** 供應商的接單規則:截單時間、提前幾天截單、哪幾天配送。沒有設定 = 沒有限制(餐廳叫貨時配送日選填) */
const SupplierOrderSettingsDialog = ({ open, onOpenChange, supplierId }: Props) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<OrderRules>(DEFAULT_RULES);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await db<{ cutoff_time: string; lead_days: number; delivery_weekdays: number[] }>("supplier_order_settings")
        .select("cutoff_time, lead_days, delivery_weekdays")
        .eq("supplier_id", supplierId);
      if (cancelled) return;
      if (error) toast.error("載入接單設定失敗", { description: error.message });
      const row = data?.[0];
      setEnabled(!!row);
      setRules(row ? { cutoff_time: hhmm(row.cutoff_time), lead_days: row.lead_days, delivery_weekdays: row.delivery_weekdays } : DEFAULT_RULES);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, supplierId]);

  const toggleDay = (day: number, on: boolean) =>
    setRules((r) => ({
      ...r,
      delivery_weekdays: on ? [...new Set([...r.delivery_weekdays, day])].sort() : r.delivery_weekdays.filter((d) => d !== day),
    }));

  const timeOk = /^\d{2}:\d{2}$/.test(rules.cutoff_time);
  const canSave = !saving && !loading && (!enabled || (timeOk && rules.delivery_weekdays.length > 0));

  const save = async () => {
    setSaving(true);
    const res = enabled
      ? await db("supplier_order_settings").upsert(
          { supplier_id: supplierId, cutoff_time: rules.cutoff_time, lead_days: rules.lead_days, delivery_weekdays: rules.delivery_weekdays, updated_at: new Date().toISOString() },
          { onConflict: "supplier_id" },
        )
      : await db("supplier_order_settings").delete().eq("supplier_id", supplierId);
    setSaving(false);
    if (res.error) {
      toast.error("儲存失敗", { description: res.error.message });
      return;
    }
    toast.success(enabled ? "接單設定已儲存,餐廳叫貨時會看到截單時間" : "已關閉截單與配送日限制");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>接單設定</DialogTitle>
          <DialogDescription>設定截單時間與配送日,餐廳叫貨時要選配送日,過了截單時間就不能再下那一天的單。</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div>
        ) : (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} aria-label="啟用截單與配送日限制" />
              啟用截單與配送日限制
            </label>

            {enabled && (
              <div className="space-y-4 rounded-lg border border-slate-200 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="cutoff-time" className="text-xs text-slate-500">截單時間</label>
                    <Input
                      id="cutoff-time"
                      type="time"
                      value={rules.cutoff_time}
                      onChange={(e) => setRules((r) => ({ ...r, cutoff_time: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="lead-days" className="text-xs text-slate-500">在哪一天截單</label>
                    <select
                      id="lead-days"
                      value={rules.lead_days}
                      onChange={(e) => setRules((r) => ({ ...r, lead_days: Number(e.target.value) }))}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {LEAD_OPTIONS.map((n) => <option key={n} value={n}>{leadLabel(n)}</option>)}
                    </select>
                  </div>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-xs text-slate-500">哪幾天配送</legend>
                  <div className="flex flex-wrap gap-3">
                    {WEEKDAY_LABEL.map((label, day) => (
                      <label key={day} className="flex items-center gap-1.5 text-sm text-slate-700">
                        <Checkbox
                          checked={rules.delivery_weekdays.includes(day)}
                          onCheckedChange={(v) => toggleDay(day, v === true)}
                          aria-label={`週${label}配送`}
                        />
                        週{label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                {timeOk && rules.delivery_weekdays.length > 0 ? (
                  <p className="text-xs text-slate-500" data-testid="rules-preview">餐廳會看到:{describeRules(rules)}</p>
                ) : (
                  <p role="alert" className="text-xs text-red-600">請填截單時間,而且至少選一天配送</p>
                )}
              </div>
            )}
            {!enabled && <p className="text-xs text-slate-400">沒有啟用時,餐廳叫貨的配送日是選填,也沒有截單限制。</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={save} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SupplierOrderSettingsDialog;
