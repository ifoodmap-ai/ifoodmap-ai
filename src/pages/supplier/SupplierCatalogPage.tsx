import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Plus, Pencil, Trash2, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { SupplySeed } from '@/lib/market/productForm';
import type { MarketProductRow } from '@/lib/market/types';
import MarketProductDialog from './market/MarketProductDialog';
import SupplierMarketProductsPanel, { statusText } from './market/SupplierMarketProductsPanel';
import { useSupplierMarketProducts } from './market/useSupplierMarketProducts';

interface Supply {
  id: string;
  name: string;
  category: string | null;
  sku: string | null;
  unit: string | null;
  pack_size: string | null;
  price: number | null;
  currency: string;
  description: string | null;
  is_available: boolean;
}

interface FormState {
  id: string | null;
  name: string;
  category: string;
  sku: string;
  unit: string;
  pack_size: string;
  price: string;
  description: string;
  is_available: boolean;
}

const emptyForm: FormState = {
  id: null,
  name: '',
  category: '',
  sku: '',
  unit: '',
  pack_size: '',
  price: '',
  description: '',
  is_available: true,
};

export default function SupplierCatalogPage() {
  const { toast } = useToast();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // 零售市集(B2C):自家零售商品;編輯視窗每次打開給新的 key(新商品的 id 在打開時決定)
  // 讀取中、讀取失敗時「零售」欄不給任何按鈕:還不知道有沒有店家、有沒有對應的零售商品,
  // 用空的清單會重複開放零售,用舊的資料會在儲存時蓋掉剛存的修改(上方顯示原因與「重新載入」)。
  const market = useSupplierMarketProducts(supplierId);
  const [retail, setRetail] = useState<{ key: number; product: MarketProductRow | null; seed: SupplySeed | null } | null>(null);
  const retailBySupply = useMemo(
    () => new Map(market.products.filter((p) => p.supply_id).map((p) => [p.supply_id as string, p])),
    [market.products],
  );
  const openRetail = (product: MarketProductRow | null, seed: SupplySeed | null = null) =>
    setRetail({ key: Date.now(), product, seed });

  const fetchSupplies = async (sid: string) => {
    const { data } = (await (supabase as never)
      .from('supplies')
      .select('*')
      .eq('supplier_id', sid)
      .order('category', { ascending: true })
      .order('name', { ascending: true })) as { data: Supply[] | null };
    setSupplies(data ?? []);
  };

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setLoading(false); return; }
      const { data: acct } = await (supabase as never)
        .from('supplier_accounts')
        .select('supplier_id')
        .eq('user_id', session.user.id)
        .eq('is_active', true)
        .maybeSingle() as { data: { supplier_id: string } | null };
      if (acct?.supplier_id) {
        setSupplierId(acct.supplier_id);
        await fetchSupplies(acct.supplier_id);
      }
      setLoading(false);
    })();
  }, []);

  const toggleAvailable = async (s: Supply) => {
    const next = !s.is_available;
    setSupplies((prev) => prev.map((x) => (x.id === s.id ? { ...x, is_available: next } : x)));
    const { error } = await (supabase as never)
      .from('supplies')
      .update({ is_available: next })
      .eq('id', s.id);
    if (error) {
      setSupplies((prev) => prev.map((x) => (x.id === s.id ? { ...x, is_available: s.is_available } : x)));
      toast({ title: '更新失敗', description: (error as { message?: string }).message, variant: 'destructive' });
    }
  };

  const openCreate = () => { setForm(emptyForm); setFormOpen(true); };
  const openEdit = (s: Supply) => {
    setForm({
      id: s.id,
      name: s.name,
      category: s.category ?? '',
      sku: s.sku ?? '',
      unit: s.unit ?? '',
      pack_size: s.pack_size ?? '',
      price: s.price != null ? String(s.price) : '',
      description: s.description ?? '',
      is_available: s.is_available,
    });
    setFormOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !supplierId) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      category: form.category.trim() || null,
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || null,
      pack_size: form.pack_size.trim() || null,
      price: form.price.trim() ? Number(form.price) : null,
      description: form.description.trim() || null,
      is_available: form.is_available,
    };
    const { error } = form.id
      ? await (supabase as never).from('supplies').update(payload).eq('id', form.id)
      : await (supabase as never).from('supplies').insert({ ...payload, supplier_id: supplierId, currency: 'TWD' });
    setSaving(false);
    if (error) {
      toast({ title: '儲存失敗', description: (error as { message?: string }).message, variant: 'destructive' });
      return;
    }
    setFormOpen(false);
    toast({ title: form.id ? '已更新商品' : '已新增商品' });
    await fetchSupplies(supplierId);
  };

  const handleDelete = async () => {
    if (!deleteId || !supplierId) return;
    const id = deleteId;
    setDeleteId(null);
    const { error } = await (supabase as never).from('supplies').delete().eq('id', id);
    if (error) {
      toast({ title: '刪除失敗', description: (error as { message?: string }).message, variant: 'destructive' });
      return;
    }
    setSupplies((prev) => prev.filter((x) => x.id !== id));
    toast({ title: '已刪除商品' });
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-4">商品目錄</h1>
      <Tabs defaultValue="wholesale">
        <TabsList className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="wholesale" className="min-h-11">批發商品(給餐廳)</TabsTrigger>
          <TabsTrigger value="retail" className="min-h-11">零售商品(給消費者)</TabsTrigger>
        </TabsList>
        <TabsContent value="wholesale">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-sm text-gray-500">管理您上架給 ifoodmap 買家的商品品項與價格</p>
        <Button onClick={openCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!supplierId}>
          <Plus size={16} className="mr-1.5" />新增商品
        </Button>
      </div>

      {supplierId && supplies.length > 0 && market.error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p>零售商品資料讀取失敗:{market.error}。讀到之前「零售」欄先不能操作。</p>
          <Button type="button" variant="outline" className="min-h-11 bg-white" onClick={market.retry}>
            重新載入
          </Button>
        </div>
      ) : supplierId && supplies.length > 0 && !market.loading && !market.hasStore ? (
        <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          要把商品開放給一般消費者購買,請先完成{' '}
          <Link to="/supplier/market/store" className="font-semibold underline underline-offset-2">
            零售市集 › 店家設定
          </Link>
          (配送縣市、運費、付款方式)。
        </p>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="animate-spin text-emerald-500" size={28} /></div>
      ) : !supplierId ? (
        <div className="text-center py-20 text-gray-400">此帳號尚未綁定供應商</div>
      ) : supplies.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <PackageX size={40} className="mx-auto mb-3 opacity-40" />
          <p>尚無商品,點右上角「新增商品」開始建立目錄</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden overflow-x-auto">
          {/* overflow-x-auto:手機放不下整張表時讓表格自己橫向捲,
              而不是把整個頁面撐寬 */}
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-5 py-3 font-medium text-gray-600">商品</th>
                <th className="text-left px-5 py-3 font-medium text-gray-600">分類</th>
                <th className="text-left px-5 py-3 font-medium text-gray-600">規格</th>
                <th className="text-right px-5 py-3 font-medium text-gray-600">單價</th>
                <th className="text-center px-5 py-3 font-medium text-gray-600">上架</th>
                <th className="text-center px-5 py-3 font-medium text-gray-600">零售</th>
                <th className="text-right px-5 py-3 font-medium text-gray-600 w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {supplies.map((s) => {
                const retailItem = retailBySupply.get(s.id);
                return (
                <tr key={s.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <p className="font-medium text-gray-800">{s.name}</p>
                    {s.description && <p className="text-xs text-gray-400 truncate max-w-xs">{s.description}</p>}
                  </td>
                  {/* whitespace-nowrap:橫向捲的表格裡欄寬會被壓縮,
                      「乾貨」「海鮮」這種短詞會被折成一個字一行 */}
                  <td className="px-5 py-3 text-gray-600 whitespace-nowrap">{s.category ?? '—'}</td>
                  <td className="px-5 py-3 text-gray-600 whitespace-nowrap">
                    {s.pack_size ?? '—'}
                    {s.sku && <span className="text-gray-400 ml-1">· {s.sku}</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-800 tabular-nums whitespace-nowrap">
                    {s.price != null ? `$${s.price.toLocaleString()} / ${s.unit ?? '件'}` : '—'}
                  </td>
                  <td className="px-5 py-3 text-center">
                    <Switch checked={s.is_available} onCheckedChange={() => toggleAvailable(s)} />
                  </td>
                  <td className="px-5 py-3 text-center whitespace-nowrap">
                    {market.loading ? null : market.error ? (
                      <span className="text-xs text-gray-400">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">零售資料讀取失敗</span>
                      </span>
                    ) : retailItem ? (
                      <button
                        type="button"
                        className="inline-flex min-h-8 items-center px-1 text-xs text-emerald-800 underline underline-offset-2"
                        onClick={() => openRetail(retailItem)}
                      >
                        {statusText(retailItem)}
                      </button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={!market.hasStore}
                        title={market.hasStore ? undefined : '請先完成「零售市集 › 店家設定」'}
                        aria-label={`${s.name} 開放消費者購買`}
                        onClick={() => openRetail(null, s)}
                      >
                        開放零售
                      </Button>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-700" onClick={() => openEdit(s)} aria-label="編輯">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50" onClick={() => setDeleteId(s.id)} aria-label="刪除">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </TabsContent>
        <TabsContent value="retail">
          {supplierId ? (
            <SupplierMarketProductsPanel
              products={market.products}
              hasStore={market.hasStore}
              loading={market.loading}
              error={market.error}
              onCreate={() => openRetail(null)}
              onEdit={(p) => openRetail(p)}
              onRetry={market.retry}
            />
          ) : (
            <div className="text-center py-20 text-gray-400">此帳號尚未綁定供應商</div>
          )}
        </TabsContent>
      </Tabs>

      {retail && supplierId ? (
        <MarketProductDialog
          key={retail.key}
          open
          onOpenChange={(o) => {
            if (!o) setRetail(null);
          }}
          supplierId={supplierId}
          product={retail.product}
          fromSupply={retail.seed}
          onSaved={(row) => {
            // 先換上資料庫回傳的那一筆(重抓還沒回來或失敗,也不會留著舊內容讓人再編輯),再背景重抓
            market.applySaved(row);
            void market.reload();
          }}
        />
      ) : null}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{form.id ? '編輯商品' : '新增商品'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm text-gray-600 mb-1 block">商品名稱 *</label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="例:牛腱心" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600 mb-1 block">分類</label>
                <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="肉類 / 蔬菜 / 調味料…" />
              </div>
              <div>
                <label className="text-sm text-gray-600 mb-1 block">貨號 (SKU)</label>
                <Input value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} placeholder="BEEF-001" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm text-gray-600 mb-1 block">單價</label>
                <Input type="number" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="420" />
              </div>
              <div>
                <label className="text-sm text-gray-600 mb-1 block">計價單位</label>
                <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} placeholder="kg / 箱 / 瓶" />
              </div>
              <div>
                <label className="text-sm text-gray-600 mb-1 block">包裝規格</label>
                <Input value={form.pack_size} onChange={(e) => setForm((f) => ({ ...f, pack_size: e.target.value }))} placeholder="5kg/箱" />
              </div>
            </div>
            <div>
              <label className="text-sm text-gray-600 mb-1 block">說明</label>
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="產地、特色…" />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.is_available} onCheckedChange={(v) => setForm((f) => ({ ...f, is_available: v }))} />
              <span className="text-sm text-gray-600">上架供買家瀏覽</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!form.name.trim() || saving} onClick={handleSave}>
              {saving ? '儲存中…' : '儲存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定刪除這個商品?</AlertDialogTitle>
            <AlertDialogDescription>此操作無法復原。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">確定刪除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
