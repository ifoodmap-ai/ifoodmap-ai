// 單張圖片欄位(店家 logo、封面):選檔 → 瀏覽器壓縮 → 上傳到 <supplier_id>/store/ → 回傳路徑給表單。
// 換圖或移除時不刪舊檔(舊檔可能還被已儲存的設定引用;孤兒檔無害)。
// 上傳中用 onBusyChange 告訴父層:店家設定頁上傳中不能儲存(否則存進去的是舊圖,或存完才冒出資料庫沒有的新圖)。
import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { friendlyDbError } from "@/lib/market/db";
import { publicImageUrl, uploadMarketImage } from "@/lib/market/images";

interface MarketImageFieldProps {
  label: string;
  hint?: string;
  supplierId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}

export default function MarketImageField({
  label,
  hint,
  supplierId,
  value,
  onChange,
  upload = uploadMarketImage,
  onBusyChange,
}: MarketImageFieldProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      onChange(await upload(supplierId, "store", file));
    } catch (e) {
      // 走 db.ts 的中文轉換:images.ts 丟的 MarketImageError 本來就是中文;斷網、非預期的英文錯誤換成中文
      setError(friendlyDbError(e, "上傳失敗,請再試一次"));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        {value ? (
          <img src={publicImageUrl(value)} alt={`目前的${label}`} width={96} height={96} className="h-24 w-24 rounded-md border border-slate-200 object-cover" />
        ) : (
          <span className="flex h-24 w-24 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs text-slate-500">
            尚未上傳
          </span>
        )}
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
          // 可點範圍至少 44px 高:欄位本身 min-h-11,裡面的選檔按鈕(::file-selector-button)也撐到 44px,樣式比照「全選」「清除」
          className="min-h-11 max-w-full text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-md file:border file:border-solid file:border-slate-300 file:bg-white file:px-3 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50 disabled:file:cursor-not-allowed"
        />
        {busy ? (
          <span className="inline-flex items-center gap-1 text-sm text-slate-600" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            上傳中…
          </span>
        ) : null}
        {value && !busy ? (
          <button type="button" onClick={() => onChange(null)} className="min-h-11 rounded-md px-3 text-sm text-red-700 hover:bg-red-50">
            移除{label}
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
