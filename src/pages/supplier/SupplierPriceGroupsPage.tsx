import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import type { CatalogItem } from "@/lib/pricing";

type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: readonly unknown[]): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  insert(values: unknown): Q<T>;
  update(values: unknown): Q<T>;
  upsert(values: unknown, opts?: { onConflict: string }): Q<T>;
  delete(): Q<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}
const db = <T,>(table: string): Q<T> => (supabase as never as { from: (t: string) => Q<T> }).from(table);

interface Customer { id: string; name: string }
interface Group { id: string; name: string }

const MAX_NAME = 40;
const isPositive = (s: string) => s.trim() === "" || (Number.isFinite(Number(s)) && Number(s) > 0);

/** 群組報價:把客戶放進群組,同一群組同一個價格,客戶很多時不用一家一家設價(個別例外再到「客戶價格與上限」) */
const SupplierPriceGroupsPage = () => {
  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  /** restaurant_id → group_id */
  const [members, setMembers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const [loadingPrices, setLoadingPrices] = useState(false);
  const [savedPrices, setSavedPrices] = useState<Record<string, string>>({});
  const [draftPrices, setDraftPrices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (sid: string) => {
    const [g, m] = await Promise.all([
      db<Group>("supplier_customer_groups").select("id, name").eq("supplier_id", sid).order("name", { ascending: true }),
      db<{ restaurant_id: string; group_id: string }>("supplier_customer_group_members").select("restaurant_id, group_id").eq("supplier_id", sid),
    ]);
    if (g.error || m.error) throw new Error((g.error ?? m.error)?.message);
    setGroups(g.data ?? []);
    setMembers(Object.fromEntries((m.data ?? []).map((r) => [r.restaurant_id, r.group_id])));
  }, []);

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
        await load(sid);
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
  }, [load]);

  const group = groups.find((g) => g.id === selected) ?? null;

  // 選了群組:讀這個群組的價格
  useEffect(() => {
    setConfirmDelete(false);
    setRenameTo(group?.name ?? "");
    if (!selected) { setSavedPrices({}); setDraftPrices({}); return; }
    let cancelled = false;
    (async () => {
      setLoadingPrices(true);
      const { data, error } = await db<{ supply_id: string; price: number | string }>("supplier_group_prices")
        .select("supply_id, price").eq("group_id", selected);
      if (cancelled) return;
      if (error) toast.error("載入群組價格失敗", { description: error.message });
      const map = Object.fromEntries((data ?? []).map((p) => [p.supply_id, String(Number(p.price))]));
      setSavedPrices(map);
      setDraftPrices(map);
      setLoadingPrices(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const memberCount = (gid: string) => Object.values(members).filter((g) => g === gid).length;
  const ungrouped = customers.filter((c) => !members[c.id]).length;

  const nameError = (name: string, selfId?: string): string | null => {
    const n = name.trim();
    if (!n) return "請輸入群組名稱";
    if (n.length > MAX_NAME) return `群組名稱最多 ${MAX_NAME} 個字`;
    if (groups.some((g) => g.id !== selfId && g.name === n)) return "已經有同名的群組";
    return null;
  };

  const createGroup = async () => {
    if (!supplierId || nameError(newName)) return;
    setBusy(true);
    try {
      const { data, error } = await db<Group>("supplier_customer_groups").insert({ supplier_id: supplierId, name: newName.trim() }).select("id, name");
      if (error) throw new Error(error.message);
      setNewName("");
      await load(supplierId);
      if (data?.[0]) setSelected(data[0].id);
      toast.success("群組已建立,接著把客戶加進去並設定價格");
    } catch (e) {
      toast.error("建立群組失敗", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const renameGroup = async () => {
    if (!supplierId || !group || nameError(renameTo, group.id) || renameTo.trim() === group.name) return;
    setBusy(true);
    try {
      const { error } = await db("supplier_customer_groups").update({ name: renameTo.trim() }).eq("id", group.id);
      if (error) throw new Error(error.message);
      await load(supplierId);
      toast.success("群組名稱已更新");
    } catch (e) {
      toast.error("改名失敗", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const deleteGroup = async () => {
    if (!supplierId || !group) return;
    setBusy(true);
    try {
      const { error } = await db("supplier_customer_groups").delete().eq("id", group.id);
      if (error) throw new Error(error.message);
      setSelected(null);
      await load(supplierId);
      toast.success("群組已刪除,原本的成員改回照商品定價(有專屬價的照專屬價)");
    } catch (e) {
      toast.error("刪除失敗", { description: (e as Error).message });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const toggleMember = async (customer: Customer, on: boolean) => {
    if (!supplierId || !group) return;
    setBusy(true);
    try {
      const res = on
        ? await db("supplier_customer_group_members").upsert(
            { supplier_id: supplierId, restaurant_id: customer.id, group_id: group.id },
            { onConflict: "supplier_id,restaurant_id" },
          )
        : await db("supplier_customer_group_members").delete().eq("supplier_id", supplierId).eq("restaurant_id", customer.id);
      if (res.error) throw new Error(res.error.message);
      setMembers((m) => {
        const next = { ...m };
        if (on) next[customer.id] = group.id;
        else delete next[customer.id];
        return next;
      });
    } catch (e) {
      toast.error(`更新「${customer.name}」失敗`, { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const priceOf = (id: string) => draftPrices[id] ?? "";
  const invalid = useMemo(
    () => catalog.filter((c) => !isPositive(draftPrices[c.id] ?? "")),
    [catalog, draftPrices],
  );
  const dirtyIds = useMemo(
    () => catalog.filter((c) => (draftPrices[c.id] ?? "").trim() !== (savedPrices[c.id] ?? "").trim()).map((c) => c.id),
    [catalog, draftPrices, savedPrices],
  );

  const savePrices = async () => {
    if (!supplierId || !group || invalid.length > 0 || dirtyIds.length === 0) return;
    setSaving(true);
    try {
      const up: unknown[] = [];
      const del: string[] = [];
      dirtyIds.forEach((id) => {
        const v = priceOf(id).trim();
        if (v !== "") up.push({ group_id: group.id, supply_id: id, supplier_id: supplierId, price: Number(v), updated_at: new Date().toISOString() });
        else del.push(id);
      });
      if (up.length) {
        const { error } = await db("supplier_group_prices").upsert(up, { onConflict: "group_id,supply_id" });
        if (error) throw new Error(error.message);
      }
      if (del.length) {
        const { error } = await db("supplier_group_prices").delete().eq("group_id", group.id).in("supply_id", del);
        if (error) throw new Error(error.message);
      }
      setSavedPrices({ ...draftPrices });
      toast.success(`已儲存「${group.name}」的價格(${memberCount(group.id)} 家客戶適用)`);
    } catch (e) {
      toast.error("儲存失敗", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <UsersRound className="h-6 w-6 text-emerald-600" />
          群組報價
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          把客戶放進群組,同一群組同一個價格,不用一家一家設。價格優先順序:客戶專屬價 → 群組價 → 商品定價。一家客戶最多在一個群組。
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : !supplierId ? (
        <p className="text-sm text-slate-500">找不到你的供應商帳號。</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <Card className="self-start">
            <CardContent className="pt-5 space-y-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => { e.preventDefault(); void createGroup(); }}
              >
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={MAX_NAME}
                  placeholder="新群組名稱,例如 連鎖店"
                  aria-label="新群組名稱"
                  className="h-9"
                />
                <Button type="submit" size="sm" disabled={busy || !!nameError(newName)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  <Plus className="h-4 w-4 mr-1" />新增
                </Button>
              </form>
              {newName.trim() !== "" && nameError(newName) && <p role="alert" className="text-xs text-red-600">{nameError(newName)}</p>}

              {groups.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">還沒有群組</p>
              ) : (
                <ul className="space-y-1" aria-label="群組列表">
                  {groups.map((g) => (
                    <li key={g.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(g.id)}
                        aria-pressed={g.id === selected}
                        data-testid="group-item"
                        className={`w-full flex items-center justify-between rounded-md px-3 py-2 text-sm text-left transition-colors ${g.id === selected ? "bg-emerald-50 text-emerald-800 font-medium" : "hover:bg-slate-50 text-slate-700"}`}
                      >
                        <span className="truncate">{g.name}</span>
                        <span className="text-xs text-slate-400 shrink-0 ml-2">{memberCount(g.id)} 家</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {customers.length > 0 && (
                <p className="text-xs text-slate-400" data-testid="ungrouped-note">{ungrouped} 家客戶還沒有群組(照商品定價或專屬價)</p>
              )}
            </CardContent>
          </Card>

          {!group ? (
            <p className="text-sm text-slate-400 text-center py-10">{groups.length === 0 ? "先建立一個群組" : "選一個群組,設定成員與價格"}</p>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardContent className="pt-5 space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <label htmlFor="group-name" className="text-xs text-slate-500">群組名稱</label>
                      <Input id="group-name" value={renameTo} maxLength={MAX_NAME} onChange={(e) => setRenameTo(e.target.value)} className="h-9 w-56" />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !!nameError(renameTo, group.id) || renameTo.trim() === group.name}
                      onClick={() => void renameGroup()}
                    >
                      改名
                    </Button>
                    <div className="ml-auto flex items-center gap-2">
                      {confirmDelete ? (
                        <>
                          <span className="text-xs text-red-600">刪除後 {memberCount(group.id)} 家客戶會改回定價</span>
                          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>取消</Button>
                          <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => void deleteGroup()} disabled={busy}>確定刪除</Button>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" className="text-red-600" onClick={() => setConfirmDelete(true)} disabled={busy}>
                          <Trash2 className="h-4 w-4 mr-1.5" />刪除群組
                        </Button>
                      )}
                    </div>
                  </div>
                  {nameError(renameTo, group.id) && renameTo.trim() !== group.name && <p role="alert" className="text-xs text-red-600">{nameError(renameTo, group.id)}</p>}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-5 space-y-3">
                  <h2 className="font-semibold text-slate-800">成員({memberCount(group.id)} 家)</h2>
                  {customers.length === 0 ? (
                    <p className="text-sm text-slate-400">還沒有綁定你的客戶。客戶在他們的採購系統綁定你之後,就能加進群組。</p>
                  ) : (
                    <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                      {customers.map((c) => {
                        const current = members[c.id];
                        const elsewhere = current && current !== group.id ? groups.find((g) => g.id === current)?.name : null;
                        return (
                          <li key={c.id}>
                            <label className="flex items-center gap-2 text-sm text-slate-700">
                              <Checkbox
                                checked={current === group.id}
                                disabled={busy}
                                onCheckedChange={(v) => void toggleMember(c, v === true)}
                                aria-label={`${c.name} 加入${group.name}`}
                              />
                              <span>{c.name}</span>
                              {elsewhere && <span className="text-xs text-amber-600">目前在「{elsewhere}」,勾選會搬過來</span>}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-semibold text-slate-800">群組價格</h2>
                    <Button
                      size="sm"
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={saving || loadingPrices || dirtyIds.length === 0 || invalid.length > 0}
                      onClick={() => void savePrices()}
                    >
                      {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                      儲存{dirtyIds.length > 0 ? `(${dirtyIds.length} 項變更)` : ""}
                    </Button>
                  </div>
                  {catalog.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-6">你的商品目錄還是空的,請先到「商品與價格」新增商品</p>
                  ) : loadingPrices ? (
                    <Skeleton className="h-40 w-full rounded-xl" />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>商品</TableHead>
                          <TableHead className="text-right">定價</TableHead>
                          <TableHead>{group.name} 的價格</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {catalog.map((c) => {
                          const bad = !isPositive(priceOf(c.id));
                          return (
                            <TableRow key={c.id} data-testid="group-price-row">
                              <TableCell>
                                <p className="font-medium text-slate-800">{c.name}</p>
                                {c.sku && <p className="text-xs text-slate-400">{c.sku}</p>}
                              </TableCell>
                              <TableCell className="text-right whitespace-nowrap text-slate-500">
                                {c.price != null ? `$${c.price.toLocaleString()}` : "—"}{c.unit ? ` / ${c.unit}` : ""}
                              </TableCell>
                              <TableCell>
                                <Input
                                  value={priceOf(c.id)}
                                  inputMode="decimal"
                                  placeholder={c.price != null ? `照定價 ${c.price}` : "未設"}
                                  aria-label={`${c.name} 群組價`}
                                  aria-invalid={bad}
                                  onChange={(e) => { if (/^\d*\.?\d{0,2}$/.test(e.target.value)) setDraftPrices((d) => ({ ...d, [c.id]: e.target.value })); }}
                                  className={`h-9 w-32 ${bad ? "border-red-400" : ""}`}
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                  <p className="text-xs text-slate-400">空白 = 這個群組沒有特別價,照商品定價。個別客戶要例外,到「客戶價格與上限」設專屬價。</p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SupplierPriceGroupsPage;
