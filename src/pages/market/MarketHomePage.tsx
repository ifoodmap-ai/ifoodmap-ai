// /market 市集首頁:搜尋、配送縣市、溫層、分類、精選店家、商品列表。
// 篩選條件放在網址(?q=&cat=&city=&temp=),可以分享、按上一頁不會掉;篩選是純函式(src/lib/market/catalog.ts)。
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import CategoryChips from "@/components/market/CategoryChips";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketOfflineNotice, MarketStaleNotice } from "@/components/market/MarketNotices";
import ProductCard from "@/components/market/ProductCard";
import {
  featuredStores,
  fetchListedProducts,
  filterProducts,
  filtersFromParams,
  paramsFromFilters,
  type ProductFilters,
} from "@/lib/market/catalog";
import { isTwCity, TEMPERATURE_KEYS, TEMPERATURES, TW_CITIES, type Temperature } from "@/lib/market/constants";
import { citiesSummary } from "@/lib/market/format";

const FIELD = `min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 ${MARKET_FOCUS_RING}`;

export default function MarketHomePage() {
  useMarketTitle(null);
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const { data, isPending, isPaused, isLoadingError, isRefetchError, refetch } = useQuery({
    queryKey: ["market", "products"],
    queryFn: fetchListedProducts,
  });
  // 還沒有資料時分三種:離線(React Query 暫停第一次載入,isLoading 是 false,不能當成「沒有商品」)、載入中、失敗。
  // 有資料時背景重抓失敗(isRefetchError)照樣顯示舊資料,只加一行提示。
  const offline = isPending && isPaused;
  const loading = isPending && !isPaused;
  const products = useMemo(() => data ?? [], [data]);
  const visible = useMemo(
    () => filterProducts(products, filters),
    // filters 每次 render 都是新物件,依賴拆成四個值
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products, filters.q, filters.category, filters.city, filters.temperature],
  );
  const stores = useMemo(() => featuredStores(products, filters.city), [products, filters.city]);

  const update = (patch: Partial<ProductFilters>) => setParams(paramsFromFilters({ ...filters, ...patch }), { replace: true });

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-6">
      <section aria-labelledby="market-title" className="space-y-4">
        <div className="space-y-1">
          <h1 id="market-title" className="text-2xl font-bold text-slate-900 min-[881px]:text-3xl">
            iFoodmap 食材市集
          </h1>
          <p className="text-slate-600">直接向平台上的在地供應商買食材,店家自己出貨、收款。</p>
        </div>

        <form role="search" aria-label="搜尋與篩選" onSubmit={(e) => e.preventDefault()} className="grid gap-3 min-[881px]:grid-cols-[1fr,14rem]">
          <div>
            <label htmlFor="market-q" className="mb-1 block text-sm font-medium text-slate-700">
              搜尋食材
            </label>
            <input
              id="market-q"
              type="search"
              value={filters.q}
              maxLength={50}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="例如:高麗菜、牛肉片"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="market-city" className="mb-1 block text-sm font-medium text-slate-700">
              配送到哪
            </label>
            <select
              id="market-city"
              value={filters.city ?? ""}
              onChange={(e) => update({ city: isTwCity(e.target.value) ? e.target.value : null })}
              className={FIELD}
            >
              <option value="">全部縣市</option>
              {TW_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="min-[881px]:col-span-2">
            <legend className="mb-1 text-sm font-medium text-slate-700">溫層</legend>
            <div className="flex flex-wrap gap-2">
              {([null, ...TEMPERATURE_KEYS] as Array<Temperature | null>).map((t) => (
                <button
                  key={t ?? "all"}
                  type="button"
                  aria-pressed={filters.temperature === t}
                  onClick={() => update({ temperature: t })}
                  className={`min-h-11 rounded-full border px-4 text-sm ${
                    filters.temperature === t
                      ? "border-emerald-700 bg-emerald-50 font-semibold text-emerald-800"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  } ${MARKET_FOCUS_RING}`}
                >
                  {t ? TEMPERATURES[t] : "全部"}
                </button>
              ))}
            </div>
          </fieldset>
        </form>

        <CategoryChips value={filters.category} onChange={(category) => update({ category })} />
      </section>

      {stores.length > 0 && (
        <section aria-labelledby="market-stores-title" className="space-y-3">
          <h2 id="market-stores-title" className="text-xl font-bold text-slate-900">
            精選店家
          </h2>
          <ul className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[881px]:grid-cols-4">
            {stores.map((s) => (
              <li key={s.supplierId}>
                <Link
                  to={`/market/s/${s.supplierId}`}
                  className={`flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 hover:border-emerald-300 ${MARKET_FOCUS_RING}`}
                >
                  <MarketImage path={s.logoPath} category="grocery" alt="" variant="thumb" className="h-12 w-12 shrink-0 rounded-full" width={48} height={48} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{s.name}</span>
                    <span className="block truncate text-xs text-slate-600">
                      {citiesSummary(s.deliveryCities)}・{s.productCount} 項商品
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="market-products-title" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="market-products-title" className="text-xl font-bold text-slate-900">
            商品
          </h2>
          <p aria-live="polite" className="text-sm text-slate-600">
            {loading ? "載入中…" : offline || isLoadingError ? "" : `共 ${visible.length} 項`}
          </p>
        </div>

        {isRefetchError && <MarketStaleNotice onRetry={() => refetch()} />}

        {loading ? (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i}>
                <Skeleton className="aspect-[3/4] w-full rounded-xl" />
              </li>
            ))}
          </ul>
        ) : offline ? (
          <MarketOfflineNotice />
        ) : isLoadingError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            商品載入失敗,請檢查網路後再試一次。
            <button type="button" onClick={() => refetch()} className={`ml-3 min-h-11 font-semibold underline ${MARKET_FOCUS_RING}`}>
              重新載入
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl bg-white py-12 text-center text-slate-600">
            {products.length === 0 ? "市集還沒有上架的商品,敬請期待。" : "沒有符合條件的商品,換個分類或縣市看看。"}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4">
            {visible.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
