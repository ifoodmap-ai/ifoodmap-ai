// /market/p/:productId 商品頁:照片(最多 5 張)、品名、規格、價格、溫層、庫存、產地、保存方式、保存期限、說明,
// 加入購物車(手機固定在畫面底部)、店家卡(店名、配送縣市、運費、免運門檻、最低訂購金額、出貨天數、付款方式)。
// 供應商 / 管理員打開自家還沒上架的商品時,照樣顯示但加「預覽」提示(消費者看不到,RLS 擋)。
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import AddToCart from "@/components/market/AddToCart";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketStaleNotice } from "@/components/market/MarketNotices";
import { scrollIntoViewOnFocus } from "@/components/market/focus";
import StoreInfoList from "@/components/market/StoreInfoList";
import { fetchMarketProduct, isPubliclyVisible } from "@/lib/market/catalog";
import { CATEGORY_LABEL, REVIEW_STATUS_LABEL, TEMPERATURES } from "@/lib/market/constants";
import { isUuid } from "@/lib/market/db";
import { formatTwd, stockLabel } from "@/lib/market/format";
import MarketLoadError from "./MarketLoadError";
import MarketNotFound from "./MarketNotFound";
import MarketOffline from "./MarketOffline";

export default function MarketProductPage() {
  const { productId = "" } = useParams();
  const valid = isUuid(productId);
  const { data: product, isPending, isPaused, isLoadingError, isRefetchError, refetch } = useQuery({
    queryKey: ["market", "product", productId],
    queryFn: () => fetchMarketProduct(productId),
    enabled: valid,
  });
  const [photoIndex, setPhotoIndex] = useState(0);
  // 還沒有資料時:離線(第一次載入被暫停)、載入中、失敗;查過了而且是 null 才是「找不到」。
  // 已經有這個商品時,背景重抓失敗(isRefetchError)照樣顯示,只加一行提示。
  const offline = valid && isPending && isPaused;
  const notFound = !valid || (!isPending && !isLoadingError && !product);
  // 分頁標題跟畫面一致(MarketNotFound 會設同一個字):子元件的 effect 先跑、父元件後跑,字不一樣的話會被這裡蓋掉
  useMarketTitle(notFound ? "找不到商品" : offline ? "目前離線" : isLoadingError ? "商品載入失敗" : product?.name ?? null);

  if (notFound) return <MarketNotFound message="找不到這個商品,可能已經下架了。" title="找不到商品" />;
  if (offline) return <MarketOffline />;
  if (isPending) {
    return (
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 min-[881px]:grid-cols-2" aria-busy="true">
        <Skeleton className="aspect-square w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (isLoadingError || !product) return <MarketLoadError title="商品載入失敗" onRetry={() => refetch()} />;

  const store = product.market_stores;
  const preview = !isPubliclyVisible(product);
  const details: Array<[string, string | null]> = [
    ["產地", product.origin],
    ["保存方式", product.storage_method],
    ["保存期限", product.shelf_life],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-32 pt-6 min-[881px]:pb-6">
      <nav aria-label="麵包屑" className="mb-4 text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to="/market" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              市集
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li>
            <Link to={`/market?cat=${product.category}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              {CATEGORY_LABEL[product.category]}
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li aria-current="page" className="text-slate-900">
            {product.name}
          </li>
        </ol>
      </nav>

      {isRefetchError && (
        <div className="mb-4">
          <MarketStaleNotice onRetry={() => refetch()} />
        </div>
      )}

      {preview && (
        <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          預覽:消費者目前看不到這個商品(審核狀態:{REVIEW_STATUS_LABEL[product.review_status]}
          {product.is_listed ? "" : "、上架開關關閉"}
          {store && !store.is_enabled ? "、店家零售已停用" : ""})。
        </p>
      )}

      <div className="grid gap-6 min-[881px]:grid-cols-2">
        <section aria-label="商品照片" className="space-y-2">
          <MarketImage
            path={product.photos[photoIndex]}
            category={product.category}
            alt={`${product.name}${product.photos.length > 1 ? ` 照片 ${photoIndex + 1}` : ""}`}
            variant="full"
            eager
            width={800}
            height={800}
            className="aspect-square w-full rounded-xl"
          />
          {product.photos.length > 1 && (
            // 捲動列四周留 6px 給焦點框(按鈕外 4px;overflow-x-auto 會讓上下也被裁),-mx-1.5 讓縮圖跟主圖左緣對齊
            <div className="-mx-1.5 flex scroll-px-1.5 gap-2 overflow-x-auto p-1.5">
              {product.photos.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  aria-label={`看第 ${i + 1} 張照片`}
                  aria-pressed={i === photoIndex}
                  onClick={() => setPhotoIndex(i)}
                  onFocus={scrollIntoViewOnFocus}
                  className={`shrink-0 rounded-md border-2 ${i === photoIndex ? "border-emerald-700" : "border-transparent"} ${MARKET_FOCUS_RING}`}
                >
                  <MarketImage path={p} category={product.category} alt="" width={64} height={64} className="h-16 w-16 rounded" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="product-title" className="space-y-4">
          <div>
            <h1 id="product-title" className="text-2xl font-bold text-slate-900">
              {product.name}
            </h1>
            <p className="text-slate-600">{product.spec}</p>
          </div>
          <p className="text-3xl font-bold text-emerald-800">{formatTwd(product.price)}</p>
          <p className="text-sm text-slate-700">
            {TEMPERATURES[product.temperature]}・{stockLabel(product.stock)}
          </p>
          {details.some(([, v]) => v) && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
              {details
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="text-slate-800">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {product.description && (
            <div>
              <h2 className="mb-1 font-semibold text-slate-900">商品說明</h2>
              <p className="whitespace-pre-line text-slate-700">{product.description}</p>
            </div>
          )}

          <AddToCart product={product} />

          {store && (
            <aside aria-labelledby="store-card-title" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
              <h2 id="store-card-title" className="font-semibold text-slate-900">
                <Link to={`/market/s/${store.supplier_id}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                  {store.suppliers?.name ?? "店家"}
                </Link>
              </h2>
              <StoreInfoList store={store} />
            </aside>
          )}
        </section>
      </div>
    </div>
  );
}
