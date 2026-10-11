// /market/orders/:token 訂單查詢(免登入):這次結帳的每張訂單 —— 店家、訂單編號、狀態與時間軸、明細、付款方式;
// 轉帳訂單在店家接單後(待匯款)顯示匯款資訊;拒單 / 取消顯示原因(已收款後被取消也一樣);出貨顯示物流與單號。
// ?new=1 = 剛下單:顯示「已送出」與這個網址(提醒加入書籤 —— 寄信閘門沒開時,消費者收不到確認信)。
// 🔴 這個網址就是查詢權限(token),頁面上不放任何外部連結,避免 token 經 Referer 外流(聯絡店家只有 tel:)。
// 還沒有資料時:離線(第一次載入被暫停)、載入中、失敗各自有畫面;查過了而且是 null 才是「找不到」。
// 已經有訂單時,背景重抓失敗(isRefetchError)照樣顯示,只加一行提示。
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketStaleNotice } from "@/components/market/MarketNotices";
import OrderItems from "@/components/market/OrderItems";
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { formatTaipei, formatTwd } from "@/lib/market/format";
import { fetchOrdersByToken, sortEvents, TOKEN_PATTERN } from "@/lib/market/lookup";
import { ORDER_STATUS_LABEL } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import MarketLoadError from "./MarketLoadError";
import MarketNotFound from "./MarketNotFound";
import MarketOffline from "./MarketOffline";

export default function MarketOrderLookupPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get("new") === "1";
  const valid = TOKEN_PATTERN.test(token);
  const { data: orders, isPending, isPaused, isLoadingError, isRefetchError, refetch } = useQuery({
    queryKey: ["market", "lookup", token],
    queryFn: () => fetchOrdersByToken(token),
    enabled: valid,
  });
  const offline = valid && isPending && isPaused;
  const notFound = !valid || (!isPending && !isLoadingError && !orders);
  // 分頁標題跟畫面一致(MarketNotFound 會設同一個字):子元件的 effect 先跑、父元件後跑,字不一樣的話會被這裡蓋掉
  useMarketTitle(notFound ? "找不到訂單" : offline ? "目前離線" : isLoadingError ? "訂單載入失敗" : "訂單查詢");
  const [copied, setCopied] = useState<boolean | null>(null);
  const pageUrl = typeof window === "undefined" ? "" : `${window.location.origin}/market/orders/${token}`;

  if (notFound) return <MarketNotFound message="找不到這筆訂單。請確認網址完整(從確認信裡的連結打開最保險)。" title="找不到訂單" />;
  if (offline) return <MarketOffline />;
  if (isPending) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6" aria-busy="true">
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (isLoadingError || !orders) return <MarketLoadError title="訂單載入失敗" onRetry={() => void refetch()} />;

  const first = orders[0];
  // navigator.clipboard 在不安全的連線、舊瀏覽器是 undefined(不能直接 ?.writeText().then —— 會丟 TypeError、按了沒反應)
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-900">訂單查詢</h1>
      {isRefetchError ? <MarketStaleNotice onRetry={() => void refetch()} /> : null}

      {isNew ? (
        <div role="status" className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
          <p className="font-semibold">訂單已送出,共 {orders.length} 張(每家店一張)。店家接單後會寄信通知你。</p>
          <p className="text-sm">這個網址就是你的訂單查詢頁,請加入書籤或複製保存,不要分享給別人:</p>
          <div className="flex flex-wrap gap-2">
            <input
              readOnly
              value={pageUrl}
              aria-label="訂單查詢網址"
              className="min-h-11 min-w-0 flex-1 basis-56 rounded-md border border-emerald-300 bg-white px-3 text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" onClick={() => void copy()} className={`min-h-11 rounded-md border border-emerald-400 bg-white px-4 text-sm font-medium ${MARKET_FOCUS_RING}`}>
              複製連結
            </button>
          </div>
          {copied === true ? <p className="text-sm">已複製。</p> : null}
          {copied === false ? <p className="text-sm">沒辦法自動複製,請長按上面的網址手動複製。</p> : null}
        </div>
      ) : null}

      <section aria-labelledby="lookup-buyer" className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h2 id="lookup-buyer" className="mb-2 font-semibold text-slate-900">
          收件資料
        </h2>
        <p className="break-words">
          {first.buyer_name}・{first.buyer_phone}・{first.buyer_email}
        </p>
        <p className="break-words">
          {first.ship_city}
          {first.ship_address}
        </p>
        {first.buyer_note ? <p className="break-words text-slate-600">備註:{first.buyer_note}</p> : null}
      </section>

      {orders.map((o) => (
        <section key={o.id} aria-labelledby={`lookup-${o.id}`} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`lookup-${o.id}`} className="text-lg font-semibold text-slate-900">
              {/* 店名與編號之間的空白給螢幕閱讀器:行內元素之間不會自動補空白,會唸成「A 店訂單」 */}
              {o.store.name}{" "}
              <span className="ml-1 whitespace-nowrap text-sm font-normal text-slate-500">訂單 {formatOrderNo(o.id)}</span>
            </h2>
            <p className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900">{ORDER_STATUS_LABEL[o.status]}</p>
          </div>
          <p className="text-sm text-slate-600">
            {formatTaipei(o.created_at)} 下單・{PAYMENT_METHODS[o.payment_method]}
          </p>

          {o.transfer_info ? (
            <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
              <p className="font-semibold">店家已接單,請匯款 {formatTwd(o.total)}:</p>
              <p className="mt-1 whitespace-pre-line break-words">{o.transfer_info}</p>
              <p className="mt-1 text-xs">店家確認收款後就會出貨。</p>
            </div>
          ) : null}
          {(o.status === "rejected" || o.status === "cancelled") && o.status_note ? (
            <p className="break-words rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">原因:{o.status_note}</p>
          ) : null}
          {o.shipped_carrier ? (
            <p className="break-words text-sm text-slate-800">
              物流:{o.shipped_carrier}
              {o.shipped_tracking_no ? `,單號 ${o.shipped_tracking_no}` : ""}
            </p>
          ) : null}

          <OrderItems items={o.items} subtotal={o.subtotal} shippingFee={o.shipping_fee} total={o.total} />

          <div>
            <h3 className="text-sm font-semibold text-slate-900">進度</h3>
            <ol className="mt-1 space-y-1 text-sm text-slate-700">
              {sortEvents(o.events).map((e, i) => (
                <li key={`${e.to_status}-${i}`}>
                  {formatTaipei(e.created_at)} {ORDER_STATUS_LABEL[e.to_status]}
                </li>
              ))}
            </ol>
          </div>

          <div className="text-sm text-slate-700">
            <h3 className="font-semibold text-slate-900">聯絡店家</h3>
            {o.store.phone ? (
              <p>
                電話:
                <a href={`tel:${o.store.phone}`} className={`inline-flex min-h-11 items-center text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                  {o.store.phone}
                </a>
              </p>
            ) : null}
            {o.store.return_policy ? <p className="mt-1 whitespace-pre-line break-words text-slate-600">退換貨:{o.store.return_policy}</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
