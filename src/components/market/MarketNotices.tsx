// 市集頁面裡「資料狀態」的兩種小提示(首頁、商品頁、店家頁共用):
// - MarketOfflineNotice:瀏覽器離線,React Query 把第一次載入暫停了(還沒有任何資料)。不能顯示空狀態 ——
//   「市集還沒有商品」「這家店還沒有上架的商品」在離線時是錯的;連線恢復後 React Query 會自動重抓,這行就會換掉。
// - MarketStaleNotice:背景重抓失敗(例如切回分頁時剛好沒網路),但手上還有之前載入的資料:繼續顯示舊資料,
//   只在上方放一行不打擾的提示 + 重新載入(不整頁變成錯誤)。
// 兩個都用 role="status"(禮貌地念一次,不打斷),不用 alert。
import { MARKET_FOCUS_RING } from "./MarketLayout";

export function MarketOfflineNotice() {
  return (
    <p role="status" className="rounded-xl bg-white py-12 text-center text-slate-600">
      目前離線,連線後會自動重新載入。
    </p>
  );
}

export function MarketStaleNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600"
    >
      更新失敗,目前顯示的是之前載入的內容。
      <button type="button" onClick={onRetry} className={`min-h-11 font-semibold text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
        重新載入
      </button>
    </p>
  );
}
