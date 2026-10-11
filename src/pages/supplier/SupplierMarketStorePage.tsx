// 供應商後台「零售市集 › 店家設定」(/supplier/market/store):logo、封面、介紹、配送縣市、固定運費、免運門檻、
// 最低訂購金額、出貨天數、接受的付款方式、轉帳資訊、退換貨說明。
// 驗證規則在 src/lib/market/store.ts(跟資料庫 CHECK 同一套上限);資料庫的 guard 再擋一次(例如沒填轉帳資訊卻勾轉帳)。
// 「零售啟用」只有管理員能改:被停用時這頁最上面顯示原因。
// 讀取失敗 ≠ 還沒建店:讀取失敗只顯示錯誤與「重新載入」、不顯示表單 —— 顯示空白表單的話,
// 供應商一儲存,upsert 就把原本的介紹、退換貨說明、logo、封面蓋掉。只有讀取成功、而且查無店家,才是新店家表單。
// 兩個分頁 / 兩位同事同時改:儲存時把讀到的 updated_at 交給 saveStore 比對,對不上就顯示「資料已被其他人更新」、不覆寫。
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCurrentSupplier } from "@/hooks/use-current-supplier";
import { LIMITS, TW_CITIES, type TwCity } from "@/lib/market/constants";
import { friendlyDbError } from "@/lib/market/db";
import {
  emptyStoreForm,
  fetchOwnStore,
  MarketPartialSaveError,
  MarketStaleError,
  saveStore,
  STALE_STORE_MESSAGE,
  storeFormFromRow,
  validateStoreForm,
  type StoreForm,
  type StoreFormErrors,
} from "@/lib/market/store";
import type { MarketStoreRow } from "@/lib/market/types";
import MarketImageField from "./market/MarketImageField";

const INPUT = "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700";
/** shrink-0:文字換行時(390 寬的「銀行轉帳」)勾選框才不會被 flex 壓小 */
const CHECKBOX = "h-5 w-5 shrink-0";
/** 認不得的錯誤顯示這句(資料庫錯誤附上錯誤代碼),不顯示英文原文 */
const UNEXPECTED = "請稍後再試";

const FieldError = ({ id, message }: { id: string; message?: string }) =>
  message ? (
    <p id={id} className="mt-1 text-sm text-red-700">
      {message}
    </p>
  ) : null;

export default function SupplierMarketStorePage() {
  const { supplierId, loading: idLoading, error: idError, reload: reloadSupplier } = useCurrentSupplier();
  const [row, setRow] = useState<MarketStoreRow | null>(null);
  const [form, setForm] = useState<StoreForm>(emptyStoreForm());
  const [errors, setErrors] = useState<StoreFormErrors>({});
  const [loading, setLoading] = useState(true);
  /** 讀取失敗的原因;有值時不顯示表單 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** 資料庫裡目前的轉帳資訊(沒勾轉帳時儲存不會動它,存完表單要換回這個值) */
  const [savedTransfer, setSavedTransfer] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** logo / 封面上傳中:不能儲存(存進去的會是舊圖,或存完才冒出資料庫沒有的新圖) */
  const [uploading, setUploading] = useState({ logo: false, cover: false });
  const anyUploading = uploading.logo || uploading.cover;
  /** 儲存時發現資料已被其他人更新:沒有覆寫,要重新載入才能再改 */
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      try {
        const { store, transferInfo } = await fetchOwnStore(supplierId);
        if (cancelled) return;
        setRow(store);
        setSavedTransfer(transferInfo);
        setForm(store ? storeFormFromRow(store, transferInfo) : emptyStoreForm());
        setErrors({});
        setStale(false);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError(friendlyDbError(e, UNEXPECTED));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId, reloadKey]);

  // 重抓期間 loading 優先(下面先判斷 loading),畫面只有載入中;loadError 只在讀取成功時清掉
  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const set = <K extends keyof StoreForm>(key: K, value: StoreForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleCity = (city: TwCity) =>
    set("deliveryCities", form.deliveryCities.includes(city) ? form.deliveryCities.filter((c) => c !== city) : [...form.deliveryCities, city]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // 沒讀到原本的設定、儲存中、照片上傳中都不准存(畫面上本來就按不到,這裡再擋一次)
    if (!supplierId || loading || loadError || saving || anyUploading) return;
    const errs = validateStoreForm(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error("有欄位需要修正", { description: Object.values(errs)[0] });
      return;
    }
    setSaving(true);
    try {
      // updatedAt 用讀到(或上次存完資料庫回)的原字串,saveStore 拿它比對,對不上就不覆寫
      const saved = await saveStore(supplierId, form, { updatedAt: row?.updated_at ?? null, transferInfo: savedTransfer });
      // 畫面換成資料庫整理過的值(market_stores_guard 把縣市照官方順序排好、介紹 / 退換貨說明去掉頭尾空白),
      // 下一次存的才不會跟資料庫不一致。轉帳資訊:有勾就是剛存的值(saveStore 存的是 trim 過的,資料庫的 btrim
      // 不會再改);沒勾的話 saveStore 不會動它,換回資料庫裡原本的值。
      const transfer = form.acceptTransfer ? form.transferInfo.trim() : savedTransfer;
      setRow(saved);
      setSavedTransfer(transfer);
      setForm(storeFormFromRow(saved, transfer));
      setStale(false);
      toast.success("已儲存店家設定");
    } catch (err) {
      // 只存好一部分:狀態要跟資料庫一致
      if (err instanceof MarketPartialSaveError) {
        if (err.saved === "transfer") {
          // 轉帳資訊已經是新的:記下來(之後沒勾轉帳存檔時表單換回的是它,不會把舊帳號帶回來)
          setSavedTransfer(err.transferInfo);
        } else if (err.store) {
          // 店家已經存好:換成資料庫的值(下次比對用新的 updated_at);轉帳資訊還沒存到,保留剛打的讓使用者再存一次
          setRow(err.store);
          setForm(storeFormFromRow(err.store, form.transferInfo));
        }
      }
      // 資料已被其他人更新:店家沒有寫,表單保留剛改的內容,顯示重新載入(重新載入才換成資料庫的值)
      setStale(err instanceof MarketStaleError || (err instanceof MarketPartialSaveError && err.failure instanceof MarketStaleError));
      toast.error(err instanceof MarketPartialSaveError ? "只存好一部分" : "儲存失敗", { description: friendlyDbError(err, UNEXPECTED) });
    } finally {
      setSaving(false);
    }
  };

  if (idLoading || (supplierId && loading)) {
    return (
      <div className="flex justify-center py-20" role="status">
        <Loader2 className="animate-spin text-emerald-600" size={28} aria-hidden="true" />
        <span className="sr-only">載入中</span>
      </div>
    );
  }
  if (!supplierId) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-xl font-bold text-gray-900">店家設定</h1>
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {idError ?? "此帳號尚未綁定供應商"}
        </div>
        <Button type="button" variant="outline" onClick={reloadSupplier} className="min-h-11">
          重新載入
        </Button>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-xl font-bold text-gray-900">店家設定</h1>
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">讀取店家設定失敗:{loadError}</p>
          <p className="mt-1">讀到原本的設定之前不能編輯,以免儲存時蓋掉原本的介紹、退換貨說明、logo 與封面。</p>
        </div>
        <Button type="button" variant="outline" onClick={reload} className="min-h-11">
          重新載入
        </Button>
      </div>
    );
  }

  const describe = (key: keyof StoreForm) => (errors[key] ? `store-${key}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">店家設定</h1>
        <p className="text-sm text-gray-500">
          消費者在 iFoodmap 食材市集看到的店家資訊與配送、付款條件。零售商品請到「商品與價格 › 商品目錄」的「零售商品」分頁上架。
        </p>
        {row ? (
          <p className="mt-2 text-sm">
            <Link to={`/market/s/${supplierId}`} className="inline-flex min-h-11 items-center text-emerald-800 underline underline-offset-2">
              看消費者看到的店家頁
            </Link>
          </p>
        ) : null}
      </div>

      {row && !row.is_enabled ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          平台已暫停你的零售(消費者看不到你的店家與商品)。原因:{row.disabled_reason ?? "未說明"}。有問題請聯絡 iFoodmap。
        </div>
      ) : null}

      {/* 儲存中鎖住所有欄位:存完表單會換成資料庫的值,期間的修改會被蓋掉(min-w-0:fieldset 預設 min-width 會撐寬手機版面) */}
      <fieldset disabled={saving} className="min-w-0 space-y-8">
        <section className="space-y-4" aria-labelledby="store-look">
          <h2 id="store-look" className="font-semibold text-gray-900">
            外觀與介紹
          </h2>
          <MarketImageField
            label="店家 logo"
            hint="正方形最好看;JPG、PNG、WebP"
            supplierId={supplierId}
            value={form.logoPath}
            onChange={(p) => set("logoPath", p)}
            onBusyChange={(busy) => setUploading((u) => ({ ...u, logo: busy }))}
          />
          <MarketImageField
            label="店家封面"
            hint="橫式,建議 3:1"
            supplierId={supplierId}
            value={form.coverPath}
            onChange={(p) => set("coverPath", p)}
            onBusyChange={(busy) => setUploading((u) => ({ ...u, cover: busy }))}
          />
          <div>
            <label htmlFor="store-intro" className="mb-1 block text-sm font-medium text-slate-700">
              店家介紹
            </label>
            <textarea
              id="store-intro"
              rows={4}
              maxLength={LIMITS.storeIntro}
              value={form.intro}
              onChange={(e) => set("intro", e.target.value)}
              aria-invalid={!!errors.intro}
              aria-describedby={describe("intro")}
              className={`${INPUT} py-2`}
            />
            <FieldError id="store-intro-error" message={errors.intro} />
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="store-delivery">
          <h2 id="store-delivery" className="font-semibold text-gray-900">
            配送
          </h2>
          {/* 錯誤標示放在每個勾選框上(aria-invalid + aria-describedby,跟其他欄位一樣),fieldset 不再重複指一次 */}
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">配送縣市(收件地址不在這裡的訂單不能結帳)</legend>
            <div className="mb-2 flex gap-2">
              <button type="button" onClick={() => set("deliveryCities", [...TW_CITIES])} className="min-h-11 rounded-md border border-slate-300 px-3 text-sm">
                全選
              </button>
              <button type="button" onClick={() => set("deliveryCities", [])} className="min-h-11 rounded-md border border-slate-300 px-3 text-sm">
                清除
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1 min-[640px]:grid-cols-4">
              {TW_CITIES.map((c) => (
                <label key={c} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.deliveryCities.includes(c)}
                    onChange={() => toggleCity(c)}
                    aria-invalid={!!errors.deliveryCities}
                    aria-describedby={describe("deliveryCities")}
                    className={CHECKBOX}
                  />
                  {c}
                </label>
              ))}
            </div>
            <FieldError id="store-deliveryCities-error" message={errors.deliveryCities} />
          </fieldset>
          <div className="grid gap-4 min-[640px]:grid-cols-2">
            {(
              [
                ["shippingFee", "固定運費(元)", "0 = 免運費"],
                ["freeShippingThreshold", "滿多少免運(元)", "不提供免運就留白"],
                ["minOrderAmount", "最低訂購金額(元)", "沒有就填 0;看商品小計,不含運費"],
                ["shipDays", "幾個工作天內出貨", "0 = 當天出貨"],
              ] as Array<[keyof StoreForm, string, string]>
            ).map(([key, label, hint]) => (
              <div key={key}>
                <label htmlFor={`store-${key}`} className="mb-1 block text-sm font-medium text-slate-700">
                  {label}
                </label>
                <input
                  id={`store-${key}`}
                  inputMode="numeric"
                  value={String(form[key])}
                  onChange={(e) => set(key, e.target.value as never)}
                  aria-invalid={!!errors[key]}
                  // 提示文字一直接著;出錯時再加上錯誤訊息(提示不會被擠掉)
                  aria-describedby={[`store-${key}-hint`, describe(key)].filter(Boolean).join(" ")}
                  className={INPUT}
                />
                <p id={`store-${key}-hint`} className="mt-1 text-xs text-slate-500">
                  {hint}
                </p>
                <FieldError id={`store-${key}-error`} message={errors[key]} />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="store-payment">
          <h2 id="store-payment" className="font-semibold text-gray-900">
            付款(店家自己收款,平台不經手)
          </h2>
          <fieldset>
            <legend className="sr-only">接受的付款方式</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.acceptCod}
                onChange={(e) => set("acceptCod", e.target.checked)}
                aria-invalid={!!errors.acceptCod}
                aria-describedby={describe("acceptCod")}
                className={CHECKBOX}
              />
              貨到付款
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.acceptTransfer}
                onChange={(e) => set("acceptTransfer", e.target.checked)}
                aria-invalid={!!errors.acceptCod}
                aria-describedby={describe("acceptCod")}
                className={CHECKBOX}
              />
              銀行轉帳(接單後,消費者會在訂單查詢頁看到下面的轉帳資訊)
            </label>
            <FieldError id="store-acceptCod-error" message={errors.acceptCod} />
          </fieldset>
          {form.acceptTransfer ? (
            <div>
              <label htmlFor="store-transferInfo" className="mb-1 block text-sm font-medium text-slate-700">
                轉帳資訊(銀行、分行、帳號、戶名)
              </label>
              <textarea
                id="store-transferInfo"
                rows={3}
                maxLength={LIMITS.transferInfo}
                value={form.transferInfo}
                onChange={(e) => set("transferInfo", e.target.value)}
                aria-invalid={!!errors.transferInfo}
                aria-describedby={describe("transferInfo")}
                className={`${INPUT} py-2`}
              />
              <FieldError id="store-transferInfo-error" message={errors.transferInfo} />
            </div>
          ) : null}
          <div>
            <label htmlFor="store-returnPolicy" className="mb-1 block text-sm font-medium text-slate-700">
              退換貨說明
            </label>
            <textarea
              id="store-returnPolicy"
              rows={3}
              maxLength={LIMITS.returnPolicy}
              value={form.returnPolicy}
              onChange={(e) => set("returnPolicy", e.target.value)}
              placeholder="例:生鮮食品收到後 24 小時內有問題請拍照聯絡我們"
              aria-invalid={!!errors.returnPolicy}
              aria-describedby={describe("returnPolicy")}
              className={`${INPUT} py-2`}
            />
            <FieldError id="store-returnPolicy-error" message={errors.returnPolicy} />
          </div>
        </section>
      </fieldset>

      {stale ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="min-w-0 flex-1">{STALE_STORE_MESSAGE}。店家設定這次沒有儲存,你剛改的內容還在畫面上;重新載入會換成最新的設定。</p>
          <Button type="button" variant="outline" onClick={reload} className="min-h-11">
            重新載入
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={saving || anyUploading}
          aria-describedby={anyUploading ? "store-save-blocked" : undefined}
          className="min-h-11 bg-emerald-700 text-white hover:bg-emerald-800"
        >
          {saving ? "儲存中…" : "儲存店家設定"}
        </Button>
        {anyUploading ? (
          <p id="store-save-blocked" className="text-sm text-slate-600">
            照片上傳中,上傳完成才能儲存
          </p>
        ) : null}
      </div>
    </form>
  );
}
