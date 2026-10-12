// 管理後台「零售市集 › 零售店家」(/admin/market/stores):列出開了零售的店家、上架中 / 待審商品數,
// 可以停用某家店的零售(要填原因,供應商後台會看到)或恢復。停用後消費者看不到這家店與它的商品(RLS)。
// 供應商帳號本身被停用(suppliers.is_active = false)時,零售開著消費者也看不到(market_store_is_open),這裡另外標出來。
// 店家法定資訊(食材市集法規查證 M6):每家店列出登記名稱、負責人、電話、營業所地址、客服 Email、食品業者登錄字號、
// 產品責任險;缺必填的項目(含供應商資料的電話)標出來 —— 資料庫不讓這種店開放零售(恢復時回 store_disclosure_missing)。
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  ADMIN_LOAD_FALLBACK,
  ADMIN_STORE_FALLBACK,
  adminErrorMessage,
  fetchAdminStores,
  fetchProductCounts,
  setStoreEnabled,
  storeMissingDisclosures,
  type AdminStoreRow,
} from '@/lib/market/admin';
import { LIMITS } from '@/lib/market/constants';
import { citiesSummary, shippingSummary } from '@/lib/market/format';
import { hasVisibleText } from '@/lib/market/productForm';

const storeName = (s: AdminStoreRow) => s.suppliers?.name ?? s.supplier_id;
/** 必填的空著寫「—」,選填的空著寫「未填」 */
const shown = (v: string | null | undefined, empty = '—') => (v && v.trim() ? v : empty);

const AdminMarketStoresPage = () => {
  const [stores, setStores] = useState<AdminStoreRow[]>([]);
  const [counts, setCounts] = useState<Map<string, { listed: number; pending: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<AdminStoreRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([fetchAdminStores(), fetchProductCounts()]);
      setStores(s);
      setCounts(c);
      setLoadError(null);
    } catch (e) {
      setLoadError(adminErrorMessage(e, ADMIN_LOAD_FALLBACK));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 每次都從空白開始:上一家沒送出的原因不能帶到下一家
  const openDisable = (store: AdminStoreRow) => {
    setReason('');
    setTarget(store);
  };

  const change = async (store: AdminStoreRow, enabled: boolean) => {
    setBusy(true);
    try {
      await setStoreEnabled(store.supplier_id, enabled, enabled ? null : reason);
      toast.success(enabled ? '已恢復零售' : '已停用零售');
      setTarget(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error('處理失敗', { description: adminErrorMessage(e, ADMIN_STORE_FALLBACK) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售店家</h1>
      <p className="mb-4 text-sm text-slate-500">停用後,消費者看不到這家店與它的商品;已成立的訂單不受影響。</p>
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>零售店家載入失敗:{loadError}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
            重新載入
          </Button>
        </div>
      ) : stores.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">還沒有供應商開零售</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {stores.map((s) => {
            const c = counts.get(s.supplier_id) ?? { listed: 0, pending: 0 };
            const name = storeName(s);
            const missing = storeMissingDisclosures(s);
            return (
              <li key={s.supplier_id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">{name}</p>
                  <p className="text-xs text-slate-500">
                    {citiesSummary(s.delivery_cities)}・{shippingSummary(s)}・上架 {c.listed}・待審 {c.pending}
                  </p>
                  {!s.is_enabled && s.disabled_reason ? <p className="text-xs text-red-700">停用原因:{s.disabled_reason}</p> : null}
                  {s.suppliers?.is_active === false ? <p className="text-xs text-amber-700">供應商帳號已停用,消費者看不到這家店</p> : null}
                  <div role="group" aria-label={`${name}的法定資訊`} className="mt-1 space-y-0.5 text-xs text-slate-600">
                    <p className="break-words">
                      登記名稱:{shown(s.legal_name)}・負責人:{shown(s.representative)}・電話:{shown(s.suppliers?.phone)}
                    </p>
                    <p className="break-words">
                      營業所地址:{shown(s.business_address)}・客服 Email:{shown(s.service_email)}
                    </p>
                    <p className="break-words">
                      食品業者登錄字號:{shown(s.food_registration_no, '未填')}・產品責任險:{shown(s.liability_insurance, '未填')}
                    </p>
                  </div>
                  {missing.length > 0 ? (
                    <p className="text-xs font-medium text-red-700">法定資訊沒填齊(缺:{missing.join('、')}),不能開放零售</p>
                  ) : null}
                </div>
                <Badge variant="outline">{s.is_enabled ? '零售中' : '已停用'}</Badge>
                {s.is_enabled ? (
                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => openDisable(s)} aria-label={`停用 ${name} 的零售`}>
                    停用零售
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => change(s, true)} aria-label={`恢復 ${name} 的零售`}>
                    恢復零售
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用「{target ? storeName(target) : ''}」的零售</DialogTitle>
            <DialogDescription>原因會顯示在供應商的店家設定頁。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="market-store-reason">原因(必填)</Label>
            <Textarea id="market-store-reason" rows={3} maxLength={LIMITS.disabledReason} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={!hasVisibleText(reason) || busy} onClick={() => target && change(target, false)}>
              確定停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketStoresPage;
