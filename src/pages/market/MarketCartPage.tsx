// /market/cart 購物車:按店家分組;每組顯示小計、運費(固定運費,達免運門檻免運)、再買多少免運、是否達最低訂購金額。
// 商品資料每次重新抓(價格、庫存、上下架都是最新的);已下架的商品另外列出來讓人刪除。
// 下單開關(market_checkout_status)還沒開時照樣能逛、能放購物車,但「前往結帳」不能按並說明原因。
//
// 🔴 還沒拿到商品資料時不能用空陣列算購物車:buildCart 會把每一件都當成「已下架」,還給「從購物車移除」(一按就清光)。
//    所以離線(React Query 把第一次載入暫停,isLoading 是 false)、載入中、載入失敗各自有畫面;背景重抓失敗則保留舊資料加一行提示。
// 移除商品時查詢的 key 跟著變:placeholderData 先沿用上一份資料(整頁不閃成載入中);
// 這時上一份資料裡沒有的商品(別的分頁剛加進來)還不知道狀態,新資料回來之前不列成已下架。
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketOfflineNotice, MarketStaleNotice } from "@/components/market/MarketNotices";
import QtyStepper from "@/components/market/QtyStepper";
import { WithdrawalExemptBadge } from "@/components/market/WithdrawalNotice";
import { buildCart, cartProductsKey } from "@/lib/market/cart";
import { fetchProductsByIds } from "@/lib/market/catalog";
import { fetchCheckoutStatus } from "@/lib/market/checkout";
import { citiesSummary, formatTwd, shippingSummary } from "@/lib/market/format";
import { useCart } from "@/lib/market/useCart";
import { isWithdrawalExempt } from "@/lib/market/withdrawal";

export default function MarketCartPage() {
  useMarketTitle("購物車");
  const { lines, setQty, remove } = useCart();
  const ids = lines.map((l) => l.productId);
  const products = useQuery({
    queryKey: cartProductsKey(ids),
    queryFn: () => fetchProductsByIds(ids),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
  });
  const status = useQuery({ queryKey: ["market", "checkout-status"], queryFn: fetchCheckoutStatus });
  const view = useMemo(() => buildCart(lines, products.data ?? []), [lines, products.data]);
  const unavailable = useMemo(
    () =>
      products.isPlaceholderData
        ? view.unavailable.filter((l) => (products.data ?? []).some((p) => p.id === l.productId))
        : view.unavailable,
    [view.unavailable, products.isPlaceholderData, products.data],
  );
  const grandTotal = view.groups.reduce((sum, g) => sum + g.total, 0);
  const canGo = !!status.data?.can_order && view.groups.some((g) => g.canCheckout);
  const productsOffline = products.isPending && products.isPaused;
  const productsLoading = products.isPending && !products.isPaused;

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">購物車</h1>
        <p className="mt-2 text-slate-600">購物車是空的。</p>
        <Link to="/market" className={`mt-6 inline-flex min-h-11 items-center rounded-md px-5 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}>
          去逛市集
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold text-slate-900">購物車</h1>

      {status.data && !status.data.can_order ? (
        <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          線上訂購還沒對外開放,現在可以先逛、先放進購物車(購物車存在這台裝置的瀏覽器裡)。
        </p>
      ) : null}
      {status.data && !status.data.open && status.data.can_order ? (
        <p role="status" className="mb-4 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          市集還沒對外開放;你是平台管理員,可以下測試單。
        </p>
      ) : null}

      {productsOffline ? (
        <MarketOfflineNotice />
      ) : productsLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : products.isLoadingError ? (
        // 載入失敗不能當成「已下架」:商品其實都還在
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          商品資料載入失敗,請檢查網路後再試一次。
          <button type="button" onClick={() => void products.refetch()} className={`ml-3 min-h-11 font-semibold underline ${MARKET_FOCUS_RING}`}>
            重新載入
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {products.isRefetchError ? <MarketStaleNotice onRetry={() => void products.refetch()} /> : null}

          {unavailable.length > 0 ? (
            <section aria-labelledby="cart-unavailable" className="rounded-xl border border-red-200 bg-red-50 p-4">
              <h2 id="cart-unavailable" className="font-semibold text-red-900">
                {unavailable.length} 項商品已下架或暫停販售
              </h2>
              <button
                type="button"
                onClick={() => remove(unavailable.map((l) => l.productId))}
                className={`mt-2 inline-flex min-h-11 items-center rounded-md border border-red-300 bg-white px-4 text-sm text-red-800 ${MARKET_FOCUS_RING}`}
              >
                從購物車移除
              </button>
            </section>
          ) : null}

          {view.groups.map((g) => (
            <section key={g.supplierId} aria-labelledby={`cart-store-${g.supplierId}`} className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 id={`cart-store-${g.supplierId}`} className="text-lg font-semibold text-slate-900">
                <Link to={`/market/s/${g.supplierId}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                  {g.storeName}
                </Link>
              </h2>
              <p className="text-xs text-slate-500">
                配送:{citiesSummary(g.store.delivery_cities)}・{shippingSummary(g.store)}
              </p>

              <ul className="mt-3 divide-y divide-slate-100">
                {g.lines.map((l) => (
                  <li key={l.product.id} className="flex gap-3 py-3">
                    <MarketImage path={l.product.photos[0]} category={l.product.category} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <Link to={`/market/p/${l.product.id}`} className={`font-medium text-slate-900 underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                          {l.product.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {l.product.spec}・{formatTwd(l.product.price)}
                        </p>
                        {isWithdrawalExempt(l.product) ? <WithdrawalExemptBadge /> : null}
                        {l.overStock ? (
                          <p className="text-sm text-red-700">{l.maxQty === 0 ? "已售完,請移除" : `庫存只剩 ${l.maxQty} 件`}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <QtyStepper value={l.qty} max={Math.max(l.qty, l.maxQty)} onChange={(q) => setQty(l.product.id, q)} label={`${l.product.name} 數量`} />
                        {/* 小計與「移除」包成一組:窄螢幕放不下時一起換到下一行靠右(不然 390px 寬只有「移除」掉到下一行的左邊) */}
                        <div className="ml-auto flex items-center gap-2">
                          <p className="whitespace-nowrap font-medium text-slate-900">{formatTwd(l.lineTotal)}</p>
                          <button
                            type="button"
                            onClick={() => remove([l.product.id])}
                            aria-label={`移除 ${l.product.name}`}
                            className={`inline-flex min-h-11 items-center rounded-md px-2 text-sm text-slate-600 hover:text-red-700 ${MARKET_FOCUS_RING}`}
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <dl className="mt-2 grid grid-cols-[1fr,auto] gap-y-1 border-t border-slate-100 pt-3 text-sm">
                <dt className="text-slate-600">小計</dt>
                <dd className="text-right">{formatTwd(g.subtotal)}</dd>
                <dt className="text-slate-600">運費</dt>
                <dd className="text-right">{g.shippingFee === 0 ? "免運" : formatTwd(g.shippingFee)}</dd>
                <dt className="font-semibold text-slate-900">這家店合計</dt>
                <dd className="text-right font-bold text-emerald-800">{formatTwd(g.total)}</dd>
              </dl>
              {g.freeShippingRemaining !== null ? (
                <p className="mt-2 text-sm text-emerald-800">再買 {formatTwd(g.freeShippingRemaining)} 就免運</p>
              ) : null}
              {g.problems.map((p) => (
                <p key={p} className="mt-2 text-sm text-red-700">
                  {p}
                </p>
              ))}
            </section>
          ))}

          {view.groups.length > 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="flex items-baseline justify-between text-lg">
                <span className="font-semibold text-slate-900">全部合計</span>
                <span className="font-bold text-emerald-800">{formatTwd(grandTotal)}</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">運費與能不能配送,到結帳頁選好收件縣市後會再確認一次。每家店各自出貨、各自收款。</p>
              {canGo ? (
                <Link
                  to="/market/checkout"
                  className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md px-6 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
                >
                  前往結帳
                </Link>
              ) : (
                <>
                  <button type="button" disabled aria-describedby="cart-cannot-checkout" className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-slate-300 px-6 font-semibold text-slate-600">
                    前往結帳
                  </button>
                  {/* 下單開關還沒查到(載入中 / 查詢失敗)不能說成「還沒開放」 */}
                  <p id="cart-cannot-checkout" className="mt-2 text-sm text-slate-600">
                    {status.isLoadingError
                      ? "沒辦法確認線上訂購是否開放,請檢查網路後再試一次。"
                      : status.isPending
                        ? "正在確認線上訂購是否開放…"
                        : !status.data?.can_order
                          ? "線上訂購還沒對外開放。"
                          : "每家店都還有需要調整的地方(見上方紅字)。"}
                  </p>
                  {status.isLoadingError ? (
                    <button type="button" onClick={() => void status.refetch()} className={`min-h-11 text-sm font-semibold text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                      重新確認
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
