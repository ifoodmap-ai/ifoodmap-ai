// 商品目錄頁的「零售商品」分頁內容:列出自家零售商品(狀態、退回原因、上架開關)、新增、編輯。
// 編輯視窗由父層(SupplierCatalogPage)畫,這裡只發出 onCreate / onEdit —— 「開放零售」也用同一個視窗。
// 讀取失敗只顯示原因與「重新載入」(onRetry),不顯示清單與新增鈕:不能拿舊的或空的資料編輯。
import { Link } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarketImage from "@/components/market/MarketImage";
import { REVIEW_STATUS_LABEL, TEMPERATURES, type ReviewStatus } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";
import type { MarketProductRow } from "@/lib/market/types";

const STATUS_CLASS: Record<ReviewStatus, string> = {
  draft: "border-slate-300 bg-slate-50 text-slate-700",
  pending: "border-amber-300 bg-amber-50 text-amber-800",
  approved: "border-emerald-300 bg-emerald-50 text-emerald-800",
  rejected: "border-red-300 bg-red-50 text-red-800",
};

type StatusInput = Pick<MarketProductRow, "review_status" | "is_listed"> & { stock?: number | null };

/** 已核准但消費者現在買不到(店家停用、暫停販售、缺貨)—— 徽章不用綠色 */
const NOT_BUYABLE_CLASS = "border-amber-300 bg-amber-50 text-amber-800";

/**
 * 狀態徽章文字,照消費者實際看到的寫(市集只顯示「已核准 + 上架中 + 店家開著」的商品,見 market_store_is_open):
 * 店家零售被停用或供應商帳號停用 → 「已核准・店家停用中(消費者看不到)」;上架開關關掉 → 「已核准・暫停販售」;
 * 庫存 0 → 「已上架・缺貨」(消費者看得到,標「已售完」、不能買)。storeOpen 沒給當作開著。
 */
export const statusText = (p: StatusInput, storeOpen = true): string => {
  if (p.review_status !== "approved") return REVIEW_STATUS_LABEL[p.review_status];
  if (!storeOpen) return "已核准・店家停用中(消費者看不到)";
  if (!p.is_listed) return "已核准・暫停販售";
  return p.stock === 0 ? "已上架・缺貨" : "已上架";
};

const statusClass = (p: StatusInput, storeOpen: boolean): string =>
  p.review_status === "approved" && (!storeOpen || !p.is_listed || p.stock === 0) ? NOT_BUYABLE_CLASS : STATUS_CLASS[p.review_status];

interface PanelProps {
  products: MarketProductRow[];
  hasStore: boolean;
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onEdit: (product: MarketProductRow) => void;
  /** 讀取失敗後按「重新載入」 */
  onRetry?: () => void;
  /** 店家對消費者開著嗎(零售啟用 + 供應商帳號啟用);沒給當作開著 */
  storeOpen?: boolean;
}

export default function SupplierMarketProductsPanel({
  products,
  hasStore,
  loading,
  error,
  onCreate,
  onEdit,
  onRetry,
  storeOpen = true,
}: PanelProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-emerald-600" size={28} aria-label="載入中" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p role="alert" className="text-red-700">
          零售商品讀取失敗:{error}
        </p>
        {onRetry ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
            重新載入
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">賣給一般消費者的商品(iFoodmap 食材市集)。第一次上架要經過管理員審核。</p>
        <Button onClick={onCreate} disabled={!hasStore} className="min-h-11 bg-emerald-700 text-white hover:bg-emerald-800">
          <Plus size={16} className="mr-1.5" aria-hidden="true" />
          新增零售商品
        </Button>
      </div>
      {!hasStore ? (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          上架零售商品前,請先完成{" "}
          <Link to="/supplier/market/store" className="font-semibold underline underline-offset-2">
            零售市集 › 店家設定
          </Link>
          (配送縣市、運費、付款方式)。
        </p>
      ) : null}
      {products.length === 0 ? (
        <p className="py-12 text-center text-gray-400">還沒有零售商品。</p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {products.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-3">
              <MarketImage path={p.photos[0]} category={p.category} alt="" width={56} height={56} className="h-14 w-14 shrink-0 rounded-md" />
              {/* 狀態徽章放在品名旁邊(放不下就換到下一行),不跟編輯鈕搶寬度:390 寬時品名才不會被擠成「動物…」 */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="min-w-0 max-w-full truncate font-medium text-gray-800">{p.name}</p>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${statusClass(p, storeOpen)}`}>{statusText(p, storeOpen)}</span>
                </div>
                <p className="text-xs text-gray-500">
                  {p.spec}・{formatTwd(p.price)}・{TEMPERATURES[p.temperature]}・庫存 {p.stock === null ? "不限" : p.stock}
                </p>
                {p.review_status === "rejected" && p.reject_reason ? <p className="text-xs text-red-700">退回原因:{p.reject_reason}</p> : null}
              </div>
              <Button variant="outline" size="sm" className="min-h-11 shrink-0" onClick={() => onEdit(p)} aria-label={`編輯 ${p.name}`}>
                編輯
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
