// 市集頁面整頁「目前離線」(商品頁、店家頁):瀏覽器離線、第一次載入被 React Query 暫停、手上還沒有任何資料時。
// 不能顯示「找不到」—— 還沒查過;連線恢復後 React Query 會自動重抓,畫面自己換成內容。分頁標題由頁面設「目前離線」。
export default function MarketOffline() {
  return (
    <div role="status" className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">目前離線</h1>
      <p className="mt-2 text-slate-600">連線後會自動重新載入。</p>
    </div>
  );
}
