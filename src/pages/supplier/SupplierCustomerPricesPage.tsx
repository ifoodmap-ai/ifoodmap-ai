import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Tags, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsv, localDateStr } from "@/lib/restaurant-report";
import {
  importSheet, sheetCsv, type CatalogItem, type LimitPeriod, type PriceSheetRow,
} from "@/lib/pricing";

type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: readonly unknown[]): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  upsert(values: unknown, opts?: { onConflict: string }): Q<T>;
  delete(): Q<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

interface Customer { id: string; name: string }

/** 畫面上每個商品那一列正在編輯的內容(字串,空白 = 沒設) */
interface Draft { price: string; max: string; period: LimitPeriod }
const EMPTY: Draft = { price: "", max: "", period: "day" };

const isPositive = (s: string) => s.trim() === "" || (Number.isFinite(Number(s)) && Number(s) > 0);
const same = (a: Draft, b: Draft) => a.price.trim() === b.price.trim() && a.max.trim() === b.max.trim() && (a.max.trim() === "" || a.period === b.period);

const SupplierCustomerPricesPage = () => {
  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [loadingRules, setLoadingRules] = useState(false);
  const [saved, setSaved] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  /** 這家客戶所屬的群組(沒有群組是 null)與群組價:沒填專屬價的商品用群組價 */
  const [group, setGroup] = useState<{ name: string; prices: Record<string, number> } | null>(null);
  const [importErrors, setImportErrors] = useState<{ line: number; message: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // 供應商帳號、綁定的客戶、自己的商品目錄
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

        const [{ data: bound, error: e1 }, { data: supplies, error: e2 }] = await Promise.all([
          db<{ restaurant_id: string }>("restaurant_suppliers").select("restaurant_id").eq("supplier_id", sid),
          db<{ id: string; name: string; sku: string | null; unit: string | null; price: number | string | null }>("supplies")
            .select("id, name, sku, unit, price").eq("supplier_id", sid).order("name", { ascending: true }),
        ]);
        if (e1 || e2) throw new Error((e1 ?? e2)?.message);
        const ids = (bound ?? []).map((b) => b.restaurant_id);
        const names: Customer[] = [];
        if (ids.length > 0) {
          const { data: rs } = await db<Customer>("restaurants").select("id, name").in("id", ids);
          names.push(...(rs ?? []));
        }
        names.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        if (cancelled) return;
        setCustomers(names);
        setCatalog((supplies ?? []).map((s) => ({ id: s.id, name: s.name, sku: s.sku, unit: s.unit, price: s.price == null ? null : Number(s.price) })));
      } catch (e) {
        if (!cancelled) toast.error("載入失敗", { description: (e as Error).message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 選了客戶:讀他的專屬價格與數量上限
  const loadRules = useCallback(async (sid: string, rid: string) => {
    setLoadingRules(true);
    setImportErrors([]);
    try {
      const [{ data: prices, error: e1 }, { data: limits, error: e2 }, { data: member, error: e3 }] = await Promise.all([
        db<{ supply_id: string; price: number | string }>("supplier_customer_prices").select("supply_id, price").eq("supplier_id", sid).eq("restaurant_id", rid),
        db<{ supply_id: string; period: LimitPeriod; max_qty: number | string }>("supplier_customer_limits").select("supply_id, period, max_qty").eq("supplier_id", sid).eq("restaurant_id", rid),
        db<{ group_id: string }>("supplier_customer_group_members").select("group_id").eq("supplier_id", sid).eq("restaurant_id", rid),
      ]);
      if (e1 || e2 || e3) throw new Error((e1 ?? e2 ?? e3)?.message);
      const groupId = member?.[0]?.group_id;
      if (groupId) {
        const [{ data: gp }, { data: g }] = await Promise.all([
          db<{ supply_id: string; price: number | string }>("supplier_group_prices").select("supply_id, price").eq("group_id", groupId),
          db<{ name: string }>("supplier_customer_groups").select("name").eq("id", groupId),
        ]);
        setGroup({ name: g?.[0]?.name ?? "群組", prices: Object.fromEntries((gp ?? []).map((p) => [p.supply_id, Number(p.price)])) });
      } else {
        setGroup(null);
      }
      const map: Record<string, Draft> = {};
      (prices ?? []).forEach((p) => { map[p.supply_id] = { ...EMPTY, ...map[p.supply_id], price: String(Number(p.price)) }; });
      (limits ?? []).forEach((l) => { map[l.supply_id] = { ...EMPTY, ...map[l.supply_id], max: String(Number(l.max_qty)), period: l.period }; });
      setSaved(map);
      setDraft(map);
    } catch (e) {
      toast.error("載入這家客戶的價格失敗", { description: (e as Error).message });
      setSaved({});
      setDraft({});
      setGroup(null);
    } finally {
      setLoadingRules(false);
    }
  }, []);

  useEffect(() => {
    if (supplierId && restaurantId) void loadRules(supplierId, restaurantId);
    else { setSaved({}); setDraft({}); setGroup(null); }
  }, [supplierId, restaurantId, loadRules]);

  const rowOf = (id: string): Draft => draft[id] ?? EMPTY;
  const setRow = (id: string, patch: Partial<Draft>) => setDraft((d) => ({ ...d, [id]: { ...(d[id] ?? EMPTY), ...patch } }));

  const invalid = useMemo(
    () => catalog.filter((c) => !isPositive(rowOf(c.id).price) || !isPositive(rowOf(c.id).max)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, draft],
  );
  const dirtyIds = useMemo(
    () => catalog.filter((c) => !same(rowOf(c.id), saved[c.id] ?? EMPTY)).map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, draft, saved],
  );

  const save = async () => {
    if (!supplierId || !restaurantId || invalid.length > 0) return;
    setSaving(true);
    try {
      const upPrices: unknown[] = [];
      const delPrices: string[] = [];
      const upLimits: unknown[] = [];
      const delLimits: string[] = [];
      dirtyIds.forEach((id) => {
        const d = rowOf(id);
        const was = saved[id] ?? EMPTY;
        if (d.price.trim() !== "") upPrices.push({ restaurant_id: restaurantId, supply_id: id, supplier_id: supplierId, price: Number(d.price), updated_at: new Date().toISOString() });
        else if (was.price.trim() !== "") delPrices.push(id);
        if (d.max.trim() !== "") upLimits.push({ restaurant_id: restaurantId, supply_id: id, supplier_id: supplierId, period: d.period, max_qty: Number(d.max), updated_at: new Date().toISOString() });
        else if (was.max.trim() !== "") delLimits.push(id);
      });

      const steps = [
        upPrices.length ? db("supplier_customer_prices").upsert(upPrices, { onConflict: "restaurant_id,supply_id" }) : null,
        delPrices.length ? db("supplier_customer_prices").delete().eq("restaurant_id", restaurantId).in("supply_id", delPrices) : null,
        upLimits.length ? db("supplier_customer_limits").upsert(upLimits, { onConflict: "restaurant_id,supply_id" }) : null,
        delLimits.length ? db("supplier_customer_limits").delete().eq("restaurant_id", restaurantId).in("supply_id", delLimits) : null,
      ];
      for (const step of steps) {
        if (!step) continue;
        const { error } = (await step) as { error: { message: string } | null };
        if (error) throw new Error(error.message);
      }
      toast.success(`已儲存(${dirtyIds.length} 個商品)`);
      await loadRules(supplierId, restaurantId);
    } catch (e) {
      toast.error("儲存失敗", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const customerName = customers.find((c) => c.id === restaurantId)?.name ?? "";

  const exportSheet = () => {
    const rows: PriceSheetRow[] = catalog.map((c) => {
      const d = rowOf(c.id);
      return {
        supply: c,
        price: d.price.trim() !== "" ? Number(d.price) : null,
        limit: d.max.trim() !== "" ? { period: d.period, max_qty: Number(d.max) } : null,
      };
    });
    downloadCsv(`客戶價格表_${customerName}_${localDateStr(new Date())}.csv`, sheetCsv(rows));
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const r = importSheet(text, catalog);
      setImportErrors(r.errors);
      if (r.rows.length > 0) {
        setDraft((d) => {
          const next = { ...d };
          r.rows.forEach((row) => {
            next[row.supplyId] = {
              price: row.price != null ? String(row.price) : "",
              max: row.limit ? String(row.limit.max_qty) : "",
              period: row.limit?.period ?? "day",
            };
          });
          return next;
        });
        toast.success(`已套用 ${r.rows.length} 個商品,檢查一下再按「儲存」`);
      } else if (r.errors.length > 0) {
        toast.error("沒有可以匯入的資料", { description: r.errors[0].message });
      }
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Tags className="h-6 w-6 text-emerald-600" />
          客戶價格與上限
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          替每家合作客戶設專屬價格與每日 / 每週叫貨上限。客戶叫貨時會自動帶入價格,你報價時也會預填;超過上限的訂單會被擋下。
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : !supplierId ? (
        <p className="text-sm text-slate-500">找不到你的供應商帳號。</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label htmlFor="price-customer" className="text-xs text-slate-500">客戶</label>
                  <select
                    id="price-customer"
                    value={restaurantId}
                    onChange={(e) => setRestaurantId(e.target.value)}
                    className="h-10 w-64 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{customers.length === 0 ? "還沒有綁定你的客戶" : "選擇客戶"}</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2 ml-auto">
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    aria-label="選擇價格表檔案"
                    onChange={(e) => void importFile(e.target.files?.[0])}
                  />
                  <Button variant="outline" size="sm" disabled={!restaurantId || loadingRules} onClick={() => fileInput.current?.click()}>
                    <Upload className="h-4 w-4 mr-1.5" />匯入 CSV
                  </Button>
                  <Button variant="outline" size="sm" disabled={!restaurantId || catalog.length === 0} onClick={exportSheet}>
                    <Download className="h-4 w-4 mr-1.5" />匯出 CSV
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                客戶很多的話,可以到「群組報價」把客戶放進群組,同群組同一個價格;這裡只填例外(客戶專屬價會蓋過群組價)。
                <br />
                匯出的檔案用 Excel 打開改「客戶價」「數量上限」「上限期別」,存成 CSV 再匯入(用「商品」欄的品名對商品目錄)。空白 = 沒設(價格照定價、沒有上限)。
              </p>
            </CardContent>
          </Card>

          {importErrors.length > 0 && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="import-errors">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />這些列沒有匯入(其他列已經套用到下面的表格)</p>
              <ul className="mt-1 list-disc pl-5 space-y-0.5">
                {importErrors.map((e) => <li key={e.line}>第 {e.line} 列:{e.message}</li>)}
              </ul>
            </div>
          )}

          {restaurantId && !loadingRules && (
            <p className="text-sm text-slate-600" data-testid="group-note">
              {group
                ? <>{customerName} 屬於群組「<span className="font-medium">{group.name}</span>」,沒有填客戶價的商品會用群組價。</>
                : <>{customerName} 沒有加入任何群組,沒有填客戶價的商品用商品定價。</>}
            </p>
          )}

          {!restaurantId ? (
            <p className="text-sm text-slate-400 text-center py-10">先選擇客戶</p>
          ) : catalog.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">你的商品目錄還是空的,請先到「商品與價格」新增商品</p>
          ) : (
            <Card>
              <CardContent className="pt-5 space-y-4">
                {loadingRules ? (
                  <Skeleton className="h-48 w-full rounded-xl" />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>商品</TableHead>
                        <TableHead className="text-right">定價</TableHead>
                        <TableHead>{customerName} 的價格</TableHead>
                        <TableHead>數量上限</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catalog.map((c) => {
                        const d = rowOf(c.id);
                        const priceBad = !isPositive(d.price);
                        const maxBad = !isPositive(d.max);
                        return (
                          <TableRow key={c.id} data-testid="price-row">
                            <TableCell>
                              <p className="font-medium text-slate-800">{c.name}</p>
                              {c.sku && <p className="text-xs text-slate-400">{c.sku}</p>}
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap text-slate-500">
                              {c.price != null ? `$${c.price.toLocaleString()}` : "—"}{c.unit ? ` / ${c.unit}` : ""}
                            </TableCell>
                            <TableCell>
                              <Input
                                value={d.price}
                                inputMode="decimal"
                                placeholder={group?.prices[c.id] != null ? `群組價 ${group.prices[c.id]}` : c.price != null ? `照定價 ${c.price}` : "未設"}
                                aria-label={`${c.name} 客戶價`}
                                aria-invalid={priceBad}
                                onChange={(e) => { if (/^\d*\.?\d{0,2}$/.test(e.target.value)) setRow(c.id, { price: e.target.value }); }}
                                className={`h-9 w-32 ${priceBad ? "border-red-400" : ""}`}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <select
                                  value={d.period}
                                  onChange={(e) => setRow(c.id, { period: e.target.value as LimitPeriod })}
                                  aria-label={`${c.name} 上限期別`}
                                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                                >
                                  <option value="day">每日</option>
                                  <option value="week">每週</option>
                                </select>
                                <Input
                                  value={d.max}
                                  inputMode="decimal"
                                  placeholder="不限"
                                  aria-label={`${c.name} 數量上限`}
                                  aria-invalid={maxBad}
                                  onChange={(e) => { if (/^\d*\.?\d{0,2}$/.test(e.target.value)) setRow(c.id, { max: e.target.value }); }}
                                  className={`h-9 w-24 ${maxBad ? "border-red-400" : ""}`}
                                />
                                {c.unit && <span className="text-xs text-slate-400">{c.unit}</span>}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
                  <p className="text-sm text-slate-500 flex-1" data-testid="dirty-summary">
                    {invalid.length > 0
                      ? <span className="text-red-600">有 {invalid.length} 個商品的價格或上限不是大於 0 的數字</span>
                      : dirtyIds.length > 0 ? `有 ${dirtyIds.length} 個商品的修改還沒儲存` : "目前沒有未儲存的修改"}
                  </p>
                  <Button
                    onClick={save}
                    disabled={saving || loadingRules || dirtyIds.length === 0 || invalid.length > 0}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}儲存
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
};

export default SupplierCustomerPricesPage;
