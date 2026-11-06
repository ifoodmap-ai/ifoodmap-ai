import { useEffect, useState } from "react";
import { Calculator, Clock, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_INPUT, DEFAULT_REDUCTIONS, ORDER_METHODS, calcSavings, type Reductions, type SavingsInput,
} from "@/lib/savings";

type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  gte(col: string, val: unknown): Q<T>;
  limit(n: number): Q<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

const nt = (n: number) => `NT$ ${Math.round(n).toLocaleString("zh-TW")}`;

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  /** 滑桿的上限(數字欄可以輸入更大的值) */
  sliderMax?: number;
  suffix: string;
}

/** 數字欄 + 滑桿,兩邊同步;拉滑桿或打字,右邊的結果都即時更新 */
const Field = ({ id, label, hint, value, onChange, min, max, step, sliderMax, suffix }: FieldProps) => (
  <div className="space-y-1.5">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">{label}</label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Math.min(max, Math.max(min, Number(e.target.value))))}
          className="h-9 w-28 text-right"
        />
        <span className="w-8 text-xs text-slate-500">{suffix}</span>
      </div>
    </div>
    <input
      type="range"
      aria-label={`${label}(滑桿)`}
      min={min}
      max={sliderMax ?? max}
      step={step}
      value={Math.min(value, sliderMax ?? max)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-emerald-600"
    />
    {hint && <p className="text-xs text-slate-400">{hint}</p>}
  </div>
);

/** 省多少錢:選現在怎麼接單、填單量與出錯率,右邊即時算出每月隱藏成本;導入後每月可以省多少 */
const SupplierSavingsPage = () => {
  const [input, setInput] = useState<SavingsInput>(DEFAULT_INPUT);
  const [red, setRed] = useState<Reductions>(DEFAULT_REDUCTIONS);
  /** 目前選的接單方式;自己改了「處理一張單的時間」就變成 custom(沒有選項被選中) */
  const [method, setMethod] = useState<string>(ORDER_METHODS[0].key);
  /** 這家供應商最近 30 天實際收到的訂單張數(讀得到才有) */
  const [actual, setActual] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { data: acct } = await db<{ supplier_id: string }>("supplier_accounts")
          .select("supplier_id").eq("user_id", session.user.id).eq("is_active", true).maybeSingle();
        if (!acct?.supplier_id) return;
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { data } = await db<{ id: string }>("supplier_orders")
          .select("id").eq("supplier_id", acct.supplier_id).gte("created_at", since).limit(1000);
        if (!cancelled && data) setActual(data.length);
      } catch {
        /* 讀不到就不顯示「用實際單量」,照樣可以自己填 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const set = <K extends keyof SavingsInput>(k: K) => (v: number) => setInput((s) => ({ ...s, [k]: v }));
  const setR = <K extends keyof Reductions>(k: K) => (v: number) => setRed((s) => ({ ...s, [k]: v }));
  const pickMethod = (key: string, minutes: number) => { setMethod(key); setInput((s) => ({ ...s, minutesPerOrder: minutes })); };
  const x = calcSavings(input, red);
  const lines: [string, number, number, string][] = [
    ["打單與回覆的人力時間", x.cost.typing, x.saved.typing, "bg-violet-400"],
    ["出錯與重工", x.cost.errors, x.saved.errors, "bg-amber-400"],
    ["對帳與追單", x.cost.reconcile, x.saved.reconcile, "bg-sky-400"],
  ];
  const shown = lines.filter(([, cost]) => cost > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Calculator className="h-6 w-6 text-emerald-600" />
          每月其實有多少隱藏成本?
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          打單時間、錯單重工不會出現在帳上,卻每個月都在發生。選你現在的接單方式、填入單量和出錯率,馬上看到每個月藏了多少成本,以及改用系統接單後可以省多少。資料只在你的瀏覽器計算,不會送出。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-3xl">
          <CardContent className="pt-6 space-y-6">
            <fieldset className="space-y-2">
              <legend className="font-semibold text-slate-800 mb-2">現在怎麼接單?</legend>
              {ORDER_METHODS.map((m) => (
                <label
                  key={m.key}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                    method === m.key ? "border-emerald-600 bg-emerald-50/60" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="order-method"
                      value={m.key}
                      checked={method === m.key}
                      onChange={() => pickMethod(m.key, m.minutes)}
                      className="accent-emerald-600"
                    />
                    <span className="font-medium text-slate-800">{m.label}</span>
                  </span>
                  <span className="text-xs text-slate-500">約 {m.minutes} 分鐘 / 張</span>
                </label>
              ))}
            </fieldset>

            <div className="space-y-2">
              <Field id="sv-orders" label="每月訂單數" value={input.orders} onChange={set("orders")} min={0} max={20000} sliderMax={3000} step={10} suffix="張" />
              {actual != null && actual > 0 && (
                <div className="flex items-center gap-2 text-xs text-slate-500" data-testid="actual-orders">
                  最近 30 天你實際收到 {actual}{actual >= 1000 ? "+" : ""} 張單
                  <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => set("orders")(actual)}>用這個數字</Button>
                </div>
              )}
            </div>
            <Field id="sv-error" label="訂單出錯率" value={input.errorRatePct} onChange={set("errorRatePct")} min={0} max={50} sliderMax={25} step={0.5} suffix="%"
              hint="資深內勤約 8%,新手甚至到 15%" />

            <details className="rounded-xl border border-slate-200 p-4 text-sm" data-testid="assumptions">
              <summary className="cursor-pointer font-medium text-slate-700">進階:估算假設(可以自己調整)</summary>
              <div className="mt-4 space-y-5">
                <p className="text-xs text-slate-500">
                  以一般批發商常見情況估算。處理一張單的時間依接單方式估算(看訊息、抄單、對價格、打進系統、回覆客戶);「可減少比例」是估算、不是保證,有實際使用數據之後請改成自己的數字。
                </p>
                <Field id="sv-minutes" label="處理一張單的時間" value={input.minutesPerOrder} onChange={(v) => { setMethod("custom"); set("minutesPerOrder")(v); }} min={0} max={60} sliderMax={30} step={1} suffix="分鐘" />
                <Field id="sv-salary" label="內勤月薪(含勞健保)" value={input.monthlySalary} onChange={set("monthlySalary")} min={0} max={150000} sliderMax={90000} step={1000} suffix="NT$" />
                <Field id="sv-cost" label="每次出錯的處理成本" value={input.costPerError} onChange={set("costPerError")} min={0} max={20000} sliderMax={3000} step={50} suffix="NT$"
                  hint="重新出貨運費、退貨、折讓與溝通時間" />
                <Field id="sv-reconcile" label="每月對帳與追單時數" value={input.reconcileHours} onChange={set("reconcileHours")} min={0} max={400} sliderMax={120} step={1} suffix="小時"
                  hint="預設不算;每月要花時間對帳追單的話填在這裡" />
                <Field id="sv-r-time" label="打單與回覆時間可減少" value={red.timePct} onChange={setR("timePct")} min={0} max={100} step={5} suffix="%" />
                <Field id="sv-r-error" label="出錯與重工可減少" value={red.errorPct} onChange={setR("errorPct")} min={0} max={100} step={5} suffix="%" />
                <Field id="sv-r-reconcile" label="對帳與追單時間可減少" value={red.reconcilePct} onChange={setR("reconcilePct")} min={0} max={100} step={5} suffix="%" />
                <Field id="sv-fee" label="平台每月費用(沒有就填 0)" value={input.platformFee} onChange={set("platformFee")} min={0} max={100000} sliderMax={20000} step={100} suffix="NT$"
                  hint="有的話會從省下的錢裡扣掉,算出每月淨效益" />
                <p className="text-xs text-slate-400">月工時以 176 小時計(22 天 × 8 小時);人工輸入一張訂單約 5–10 分鐘。</p>
              </div>
            </details>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:sticky lg:top-6 self-start">
          <div className="rounded-3xl bg-slate-900 p-6 text-white space-y-4" data-testid="cost-card">
            <p className="text-sm text-slate-300">你現在每個月的接單隱形成本</p>
            <p className="text-5xl font-bold tracking-tight" data-testid="cost-total">NT$ {Math.round(x.cost.total).toLocaleString("zh-TW")}<span className="text-base font-normal text-slate-400"> /月</span></p>
            <p className="text-sm text-slate-300" data-testid="cost-yearly">一年累積約 <span className="text-lg font-semibold text-amber-300">{nt(x.yearlyCost)}</span></p>
            <div className="space-y-3 pt-1">
              {shown.map(([label, cost, , color]) => (
                <div key={label}>
                  <div className="flex justify-between text-sm"><span className="text-slate-200">{label}</span><span className="text-slate-300">{nt(cost)}</span></div>
                  <div className="mt-1.5 h-2 rounded-full bg-slate-700">
                    <div className={`h-2 rounded-full ${color}`} style={{ width: `${x.cost.total > 0 ? (cost / x.cost.total) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="flex items-center gap-1.5 rounded-xl bg-slate-800 px-4 py-3 text-sm text-slate-200" data-testid="cost-hours">
              <Clock className="h-4 w-4 shrink-0" />每個月光是接單就花掉約 <span className="font-semibold text-amber-300">{Math.round(x.hours)} 小時</span>,等於 <span className="font-semibold text-amber-300">{x.fte.toFixed(1)} 位全職內勤</span>的工作量。
            </p>

            <div className="rounded-2xl bg-white p-4 text-slate-800 space-y-2" data-testid="saving-card">
              <p className="flex items-center gap-1.5 text-xs text-emerald-700"><TrendingUp className="h-3.5 w-3.5" />改用系統接單後,每月可省下約</p>
              <p className="text-3xl font-bold text-emerald-700" data-testid="saved-total">{nt(x.saved.total)}</p>
              <ul className="space-y-0.5 text-sm text-slate-600">
                {shown.map(([label, , saved]) => (
                  <li key={label} className="flex justify-between"><span>{label}</span><span>− {nt(saved)}</span></li>
                ))}
              </ul>
              {input.platformFee > 0 && (
                <div className="flex justify-between border-t border-slate-200 pt-2 text-sm text-slate-600">
                  <span>平台費用</span><span>− {nt(input.platformFee)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                <span className="text-sm font-medium text-slate-700">每月淨效益</span>
                <span className={`text-xl font-bold ${x.net < 0 ? "text-red-600" : "text-emerald-700"}`} data-testid="net">{x.net < 0 ? "− " : ""}{nt(Math.abs(x.net))}</span>
              </div>
              <p className="text-xs text-slate-500" data-testid="net-yearly">一年約 {x.netYearly < 0 ? "− " : ""}{nt(Math.abs(x.netYearly))}</p>
              <p className="text-[11px] text-slate-400">以估算假設:打單時間、出錯、對帳時間各減少 {red.timePct}% / {red.errorPct}% / {red.reconcilePct}%。實際依產業與流程而定,試算僅供參考。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SupplierSavingsPage;
