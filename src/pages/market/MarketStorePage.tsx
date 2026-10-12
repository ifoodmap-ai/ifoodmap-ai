// /market/s/:supplierId 店家頁:封面、logo、店名、介紹、配送與付款條件、退換貨說明、店家的法定資訊、這家店上架中的商品(可依分類篩)。
// 法定資訊(消保法 §18、應記載事項第 1 點):登記名稱、負責人、營業所地址、電話、客服 Email,登錄字號、責任險有填才顯示。
// 退換貨:店家沒寫時顯示逐項標示的版本(法規查證報告 5.2 的 A 版;不再說「生鮮一律不適用」),一律附服務條款第六條的連結。
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import CategoryChips from "@/components/market/CategoryChips";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketOfflineNotice, MarketStaleNotice } from "@/components/market/MarketNotices";
import ProductCard from "@/components/market/ProductCard";
import StoreInfoList from "@/components/market/StoreInfoList";
import StoreLegalInfo from "@/components/market/StoreLegalInfo";
import { fetchMarketStore, fetchStoreProducts, isStoreOpen } from "@/lib/market/catalog";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { isUuid } from "@/lib/market/db";
import { publicImageUrl } from "@/lib/market/images";
import { WITHDRAWAL_EXEMPT_LABEL, WITHDRAWAL_TERMS_PATH } from "@/lib/market/withdrawal";
import MarketLoadError from "./MarketLoadError";
import MarketNotFound from "./MarketNotFound";
import MarketOffline from "./MarketOffline";

/** 店家沒寫退換貨說明時(報告 5.2 的 A 版;標示文字跟商品頁、服務條款第六條一樣) */
const DEFAULT_RETURN_POLICY = `請直接聯絡店家。商品頁標示「${WITHDRAWAL_EXEMPT_LABEL}」的商品(例如生鮮易腐食品)不能無理由退貨,其他商品收到隔天起 7 天內可以退貨;商品有瑕疵時都可以向店家要求處理。`;

export default function MarketStorePage() {
  const { supplierId = "" } = useParams();
  const valid = isUuid(supplierId);
  const storeQuery = useQuery({ queryKey: ["market", "store", supplierId], queryFn: () => fetchMarketStore(supplierId), enabled: valid });
  const productsQuery = useQuery({
    queryKey: ["market", "store-products", supplierId],
    queryFn: () => fetchStoreProducts(supplierId),
    enabled: valid,
  });
  const [category, setCategory] = useState<MarketCategoryKey | null>(null);
  const store = storeQuery.data;
  // 還沒有資料時:離線(第一次載入被暫停,isLoading 是 false)、載入中、失敗;查過了而且沒開放才是「找不到」。
  // 已經有資料時,背景重抓失敗(isRefetchError)照樣顯示舊資料,只加一行提示。商品區也照同樣的規則。
  const storeOffline = valid && storeQuery.isPending && storeQuery.isPaused;
  const notFound = !valid || (!storeQuery.isPending && !storeQuery.isLoadingError && !isStoreOpen(store));
  const productsOffline = productsQuery.isPending && productsQuery.isPaused;
  const productsLoading = productsQuery.isPending && !productsQuery.isPaused;
  const stale = storeQuery.isRefetchError || productsQuery.isRefetchError;
  // 分頁標題跟畫面一致(MarketNotFound 會設同一個字):子元件的 effect 先跑、父元件後跑,字不一樣的話會被這裡蓋掉
  useMarketTitle(
    notFound ? "找不到店家" : storeOffline ? "目前離線" : storeQuery.isLoadingError ? "店家資料載入失敗" : store?.suppliers?.name ?? null,
  );

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);
  const shown = category ? products.filter((p) => p.category === category) : products;

  if (!valid) return <MarketNotFound message="找不到這家店。" title="找不到店家" />;
  if (storeOffline) return <MarketOffline />;
  if (storeQuery.isPending) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6" aria-busy="true">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (storeQuery.isLoadingError) {
    return (
      <MarketLoadError
        title="店家資料載入失敗"
        onRetry={() => {
          storeQuery.refetch();
          if (productsQuery.isError) productsQuery.refetch();
        }}
      />
    );
  }
  if (!store || !isStoreOpen(store)) return <MarketNotFound message="這家店目前沒有開放零售。" title="找不到店家" />;

  const name = store.suppliers?.name ?? "店家";
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      {stale && (
        <MarketStaleNotice
          onRetry={() => {
            if (storeQuery.isError) storeQuery.refetch();
            if (productsQuery.isError) productsQuery.refetch();
          }}
        />
      )}
      <header className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {store.cover_path ? (
          <img
            src={publicImageUrl(store.cover_path)}
            alt=""
            width={1200}
            height={400}
            className="aspect-[2/1] w-full object-cover min-[881px]:aspect-[3/1]"
          />
        ) : (
          <div className="h-24 w-full bg-gradient-to-r from-emerald-50 to-lime-50" aria-hidden="true" />
        )}
        <div className="flex items-center gap-3 p-4">
          {store.logo_path ? (
            <img src={publicImageUrl(store.logo_path)} alt="" width={64} height={64} className="h-16 w-16 rounded-full border border-slate-200 object-cover" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-800" aria-hidden="true">
              <Store className="h-8 w-8" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{name}</h1>
            {store.suppliers?.phone ? <p className="text-sm text-slate-600">電話 {store.suppliers.phone}</p> : null}
          </div>
        </div>
      </header>

      <div className="grid gap-4 min-[881px]:grid-cols-[2fr,1fr]">
        <section aria-labelledby="store-intro-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="store-intro-title" className="font-semibold text-slate-900">
            店家介紹
          </h2>
          <p className="whitespace-pre-line text-slate-700">{store.intro ?? "店家還沒有填寫介紹。"}</p>
          <h2 className="pt-2 font-semibold text-slate-900">退換貨說明</h2>
          <p className="whitespace-pre-line text-slate-700">{store.return_policy ?? DEFAULT_RETURN_POLICY}</p>
          <Link to={WITHDRAWAL_TERMS_PATH} className={`inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
            詳見服務條款第六、七條
          </Link>
        </section>
        <div className="space-y-4">
          <section aria-labelledby="store-terms-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
            <h2 id="store-terms-title" className="font-semibold text-slate-900">
              配送與付款
            </h2>
            <StoreInfoList store={store} />
          </section>
          <section aria-labelledby="store-legal-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
            <h2 id="store-legal-title" className="font-semibold text-slate-900">
              店家資訊
            </h2>
            <StoreLegalInfo
              info={{
                legalName: store.legal_name,
                representative: store.representative,
                businessAddress: store.business_address,
                phone: store.suppliers?.phone,
                serviceEmail: store.service_email,
                foodRegistrationNo: store.food_registration_no,
                liabilityInsurance: store.liability_insurance,
              }}
            />
          </section>
        </div>
      </div>

      <section aria-labelledby="store-products-title" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="store-products-title" className="text-xl font-bold text-slate-900">
            商品
          </h2>
          <p aria-live="polite" className="text-sm text-slate-600">
            {productsLoading ? "載入中…" : productsOffline || productsQuery.isLoadingError ? "" : `共 ${shown.length} 項`}
          </p>
        </div>
        {categories.length > 1 && <CategoryChips value={category} onChange={setCategory} available={categories} />}
        {productsOffline ? (
          <MarketOfflineNotice />
        ) : productsQuery.isLoadingError ? (
          // 查詢失敗不能當成「沒有商品」:店家資料正常、商品其實有的時候,會誤導買家以為這家店沒東西賣
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            商品載入失敗,請檢查網路後再試一次。
            <button
              type="button"
              onClick={() => productsQuery.refetch()}
              className={`ml-3 min-h-11 font-semibold underline ${MARKET_FOCUS_RING}`}
            >
              重新載入
            </button>
          </div>
        ) : !productsLoading && shown.length === 0 ? (
          <p className="rounded-xl bg-white py-12 text-center text-slate-600">這家店還沒有上架的商品。</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4">
            {shown.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} showStore={false} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
