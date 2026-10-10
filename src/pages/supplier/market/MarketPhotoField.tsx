// 零售商品照片(最多 5 張,第一張是封面):選檔 → 瀏覽器壓縮 → 上傳到 <supplier_id>/<商品 id>/ → 路徑放進表單。
// 移除只是從清單拿掉,不刪 Storage 的檔(已儲存的商品可能還在用,孤兒檔無害)。
// 上傳中不能調順序、移除(上傳完是「上傳前的清單 + 新照片」,期間的變更會被蓋掉),並用 onBusyChange 告訴父層
// (商品視窗上傳中不能儲存,否則存進去的少了那張照片)。
import { useId, useState } from "react";
import { Loader2, Star, X } from "lucide-react";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { PHOTO_RULES } from "@/lib/market/constants";
import { uploadMarketImage } from "@/lib/market/images";
import MarketImage from "@/components/market/MarketImage";

interface MarketPhotoFieldProps {
  supplierId: string;
  productId: string;
  category: MarketCategoryKey | "";
  value: string[];
  onChange: (next: string[]) => void;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
  /** 開始 / 結束上傳時通知父層 */
  onBusyChange?: (busy: boolean) => void;
}

export default function MarketPhotoField({
  supplierId,
  productId,
  category,
  value,
  onChange,
  upload = uploadMarketImage,
  onBusyChange,
}: MarketPhotoFieldProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const left = PHOTO_RULES.maxCount - value.length;

  const onFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setMessage(files.length > left ? `最多 ${PHOTO_RULES.maxCount} 張,多的已略過` : null);
    setBusy(true);
    onBusyChange?.(true);
    const added: string[] = [];
    try {
      for (const f of files.slice(0, left)) added.push(await upload(supplierId, productId, f));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      if (added.length > 0) onChange([...value, ...added]);
    }
  };

  const move = (i: number) => onChange([value[i], ...value.filter((_, j) => j !== i)]);
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">
        商品照片(最多 {PHOTO_RULES.maxCount} 張,第一張是封面;JPG、PNG、WebP,上傳前會自動壓縮)
      </legend>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((path, i) => (
            <li key={path} className="relative">
              <MarketImage path={path} category={category || "grocery"} alt={`第 ${i + 1} 張照片`} width={96} height={96} className="h-24 w-24 rounded-md border border-slate-200" />
              {i === 0 ? <span className="absolute left-1 top-1 rounded bg-emerald-700 px-1 text-[11px] text-white">封面</span> : null}
              <div className="mt-1 flex gap-1">
                {i > 0 ? (
                  <button
                    type="button"
                    onClick={() => move(i)}
                    disabled={busy}
                    aria-label={`第 ${i + 1} 張設為封面`}
                    className="flex h-11 w-11 items-center justify-center rounded border border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Star className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => remove(i)}
                  disabled={busy}
                  aria-label={`移除第 ${i + 1} 張照片`}
                  className="flex h-11 w-11 items-center justify-center rounded border border-slate-300 text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id} className="shrink-0 text-sm text-slate-700">
          新增照片
        </label>
        <input
          id={id}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || left <= 0}
          onChange={(e) => {
            void onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
          // 可點範圍至少 44px 高:欄位本身與裡面的選檔按鈕(::file-selector-button)都 min-h-11(同店家設定的 MarketImageField)
          className="min-h-11 max-w-full text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-slate-300 file:bg-white file:px-3 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50 disabled:file:cursor-not-allowed"
        />
      </div>
      <p aria-live="polite" className="text-sm text-slate-600">
        {busy ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            上傳中…
          </span>
        ) : (
          message ?? (left <= 0 ? `已經 ${PHOTO_RULES.maxCount} 張了` : "")
        )}
      </p>
    </fieldset>
  );
}
