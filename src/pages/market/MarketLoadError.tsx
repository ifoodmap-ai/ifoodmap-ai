// 市集頁面整頁載入失敗(商品頁、店家頁):一個 h1、說明、「重新載入」(只重抓資料,不重新整理整頁)、回市集首頁。
// 跟 MarketNotFound 分開:找不到是確定沒有,載入失敗是還不知道 —— 要給重試的路。
import { Link } from "react-router-dom";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON } from "@/components/market/MarketLayout";

export default function MarketLoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">{title}</h1>
      <p className="mt-2 text-slate-600">請檢查網路後再試一次。</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className={`inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
        >
          重新載入
        </button>
        <Link
          to="/market"
          className={`inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 ${MARKET_FOCUS_RING}`}
        >
          回市集首頁
        </Link>
      </div>
    </div>
  );
}
