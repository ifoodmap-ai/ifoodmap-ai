// 零售商品的新增 / 編輯視窗(商品目錄頁的「零售商品」分頁與每列的「開放零售」共用)。
// 父層每次打開都給新的 key:新商品的 id 在打開當下決定(照片要先上傳到 <supplier>/<商品 id>/)。
// 照片上傳中不能儲存(存進去的會少那張);驗證沒過時焦點移到第一個出錯的欄位(視窗很長,錯誤可能在畫面外)。
// 修改既有商品帶讀到的 updated_at(樂觀鎖):別人先改過就不覆寫,視窗留著(可以先抄下改過的內容)、不能再存,
// 按「重新載入」才關視窗、請父層重新讀取。新商品的 id 可以由父層給(同一個來源沿用還沒確認存好的 id,
// 存檔回應遺失後重開不會建出第二筆;撞主鍵時 saveMarketProduct 會補存到那一筆)。
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { LIMITS, MARKET_CATEGORIES, REVIEW_STATUS_LABEL, TEMPERATURE_KEYS, TEMPERATURES } from "@/lib/market/constants";
import { friendlyDbError, newUuid } from "@/lib/market/db";
import {
  emptyProductForm,
  productActions,
  productFormFromRow,
  MarketStaleProductError,
  saveMarketProduct,
  validateProductForm,
  type ProductForm,
  type ProductFormErrors,
  type SupplySeed,
} from "@/lib/market/productForm";
import type { MarketProductRow } from "@/lib/market/types";
import MarketPhotoField from "./MarketPhotoField";

interface MarketProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  product: MarketProductRow | null;
  /** 新商品的 id(父層沿用還沒確認存好的 id);沒給就在打開時產生 */
  newProductId?: string | null;
  fromSupply?: SupplySeed | null;
  onSaved: (row: MarketProductRow) => void;
  /** 別人先改過、使用者按「重新載入」:父層重新讀取清單 */
  onStale?: () => void;
  save?: typeof saveMarketProduct;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
}

const INPUT =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

/** 畫面由上而下的欄位順序(照片沒有單一欄位可以聚焦,不在裡面) */
const FIELD_ORDER: Array<keyof ProductForm> = ["name", "category", "spec", "price", "stock", "origin", "storageMethod", "shelfLife", "description"];

export default function MarketProductDialog({
  open,
  onOpenChange,
  supplierId,
  product,
  newProductId,
  fromSupply,
  onSaved,
  onStale,
  save = saveMarketProduct,
  upload,
}: MarketProductDialogProps) {
  const [productId] = useState(() => product?.id ?? newProductId ?? newUuid());
  const [form, setForm] = useState<ProductForm>(() => (product ? productFormFromRow(product) : emptyProductForm(fromSupply)));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 樂觀鎖擋下:畫面上的內容已經不是最新的,不能再存 */
  const [stale, setStale] = useState(false);
  const focusAfterErrors = useRef<keyof ProductForm | null>(null);
  const actions = productActions(product?.review_status ?? null);
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: keyof ProductForm) =>
    errors[key] ? (
      <p id={`mp-${key}-error`} className="mt-1 text-sm text-red-700">
        {errors[key]}
      </p>
    ) : null;
  const aria = (key: keyof ProductForm) => ({ "aria-invalid": !!errors[key], "aria-describedby": errors[key] ? `mp-${key}-error` : undefined });

  // 錯誤訊息畫出來(aria-describedby 接上)之後才移焦點,螢幕報讀才會連錯誤一起念
  useEffect(() => {
    const key = focusAfterErrors.current;
    if (!key) return;
    focusAfterErrors.current = null;
    document.getElementById(`mp-${key}`)?.focus();
  }, [errors]);

  const doSave = async (submit: boolean) => {
    if (uploading || stale) return;
    const e = validateProductForm(form);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      focusAfterErrors.current = FIELD_ORDER.find((k) => e[k]) ?? null;
      return;
    }
    setSaving(true);
    try {
      const { row } = await save({
        supplierId,
        productId,
        isNew: !product,
        form,
        submit,
        expectedUpdatedAt: product?.updated_at ?? null,
      });
      // 已核准的商品改了品名、說明、照片等內容,資料庫會改回待審:講清楚消費者暫時看不到(只改價格、庫存、上架開關不會)
      const reReview = product?.review_status === "approved" && row.review_status === "pending";
      toast.success(reReview ? "已重新送審,通過前消費者看不到" : submit ? "已送出審核" : "已儲存");
      onSaved(row);
      onOpenChange(false);
    } catch (error) {
      if (error instanceof MarketStaleProductError) setStale(true);
      // 認不得的錯誤不顯示英文原文(資料庫錯誤附錯誤代碼);市集自己丟的錯照原訊息
      toast.error("儲存失敗", { description: friendlyDbError(error, "請稍後再試") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? "編輯零售商品" : "新增零售商品"}</DialogTitle>
          <DialogDescription>
            {product ? `目前狀態:${REVIEW_STATUS_LABEL[product.review_status]}` : "第一次上架要經過管理員審核。"}
            {product?.review_status === "rejected" && product.reject_reason ? `。退回原因:${product.reject_reason}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="mp-name" className="mb-1 block text-sm font-medium text-slate-700">
              品名 *
            </label>
            <input id="mp-name" value={form.name} maxLength={LIMITS.productName} onChange={(e) => set("name", e.target.value)} className={INPUT} {...aria("name")} />
            {err("name")}
          </div>
          <div className="grid gap-4 min-[640px]:grid-cols-2">
            <div>
              <label htmlFor="mp-category" className="mb-1 block text-sm font-medium text-slate-700">
                分類 *
              </label>
              <select id="mp-category" value={form.category} onChange={(e) => set("category", e.target.value as ProductForm["category"])} className={INPUT} {...aria("category")}>
                <option value="">請選擇</option>
                {MARKET_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              {err("category")}
            </div>
            <div>
              <label htmlFor="mp-spec" className="mb-1 block text-sm font-medium text-slate-700">
                零售規格 *
              </label>
              <input id="mp-spec" value={form.spec} maxLength={LIMITS.spec} placeholder="例:600g/盒" onChange={(e) => set("spec", e.target.value)} className={INPUT} {...aria("spec")} />
              {err("spec")}
            </div>
            <div>
              <label htmlFor="mp-price" className="mb-1 block text-sm font-medium text-slate-700">
                零售價(元)*
              </label>
              <input id="mp-price" inputMode="numeric" value={form.price} onChange={(e) => set("price", e.target.value)} className={INPUT} {...aria("price")} />
              {err("price")}
            </div>
            <div>
              <label htmlFor="mp-stock" className="mb-1 block text-sm font-medium text-slate-700">
                庫存
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="mp-stock"
                  inputMode="numeric"
                  value={form.stock}
                  disabled={form.unlimitedStock}
                  onChange={(e) => set("stock", e.target.value)}
                  className={INPUT}
                  {...aria("stock")}
                />
                <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.unlimitedStock} onChange={(e) => set("unlimitedStock", e.target.checked)} className="h-5 w-5" />
                  不限
                </label>
              </div>
              {err("stock")}
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">溫層 *</legend>
            <div className="flex flex-wrap gap-4">
              {TEMPERATURE_KEYS.map((t) => (
                <label key={t} className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="mp-temperature" checked={form.temperature === t} onChange={() => set("temperature", t)} className="h-5 w-5" />
                  {TEMPERATURES[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 min-[640px]:grid-cols-3">
            {(
              [
                ["origin", "產地", LIMITS.origin, "例:宜蘭三星"],
                ["storageMethod", "保存方式", LIMITS.storageMethod, "例:0–4°C 冷藏"],
                ["shelfLife", "保存期限", LIMITS.shelfLife, "例:冷藏 5 天"],
              ] as Array<[keyof ProductForm, string, number, string]>
            ).map(([key, label, max, ph]) => (
              <div key={key}>
                <label htmlFor={`mp-${key}`} className="mb-1 block text-sm font-medium text-slate-700">
                  {label}
                </label>
                <input
                  id={`mp-${key}`}
                  value={String(form[key])}
                  maxLength={max}
                  placeholder={ph}
                  onChange={(e) => set(key, e.target.value as never)}
                  className={INPUT}
                  {...aria(key)}
                />
                {err(key)}
              </div>
            ))}
          </div>
          <div>
            <label htmlFor="mp-description" className="mb-1 block text-sm font-medium text-slate-700">
              說明
            </label>
            <textarea
              id="mp-description"
              rows={4}
              value={form.description}
              maxLength={LIMITS.description}
              onChange={(e) => set("description", e.target.value)}
              className={`${INPUT} py-2`}
              {...aria("description")}
            />
            {err("description")}
          </div>
          <MarketPhotoField
            supplierId={supplierId}
            productId={productId}
            category={form.category}
            value={form.photos}
            onChange={(p) => set("photos", p)}
            upload={upload}
            onBusyChange={setUploading}
          />
          {err("photos")}
          {product?.review_status === "approved" ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Switch checked={form.isListed} onCheckedChange={(v) => set("isListed", v)} aria-label="上架中(關掉就暫停販售,不用重審)" />
              上架中(關掉就暫停販售,不用重審)
            </label>
          ) : null}
          {actions.notice ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{actions.notice}</p> : null}
          {stale ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>{new MarketStaleProductError().message}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 bg-white"
                onClick={() => {
                  onStale?.();
                  onOpenChange(false);
                }}
              >
                重新載入
              </Button>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)} className="min-h-11">
            取消
          </Button>
          {actions.secondary ? (
            <Button type="button" variant="outline" disabled={saving || uploading || stale} onClick={() => doSave(false)} className="min-h-11">
              {actions.secondary.label}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={saving || uploading || stale}
            onClick={() => doSave(actions.primary.submit)}
            className="min-h-11 bg-emerald-700 text-white hover:bg-emerald-800"
          >
            {saving ? "儲存中…" : actions.primary.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
