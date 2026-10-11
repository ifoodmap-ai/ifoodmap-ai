// 商品卡片(首頁、店家頁共用):整張卡片是一個連結,連結名稱包含品名、規格、價格。
// 外框、圓角、overflow-hidden 都放在連結自己身上:焦點框是畫在連結外面的 box-shadow,
// 外層若 overflow-hidden 會把它整圈切掉,鍵盤使用者就看不到焦點(WCAG 2.4.7)。
import { Link } from "react-router-dom";
import { TEMPERATURES } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";
import type { MarketProductRow } from "@/lib/market/types";
import MarketImage from "./MarketImage";
import { MARKET_FOCUS_RING } from "./MarketLayout";

export default function ProductCard({ product, showStore = true }: { product: MarketProductRow; showStore?: boolean }) {
  const soldOut = product.stock === 0;
  const storeName = product.market_stores?.suppliers?.name ?? "";
  return (
    <article className="h-full">
      <Link
        to={`/market/p/${product.id}`}
        className={`flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white ${MARKET_FOCUS_RING}`}
      >
        <MarketImage path={product.photos[0]} category={product.category} alt="" className="aspect-square w-full" />
        <div className="flex flex-1 flex-col gap-1 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">{product.name}</h3>
          <p className="text-xs text-slate-600">{product.spec}</p>
          <p className="text-base font-bold text-emerald-800">{formatTwd(product.price)}</p>
          <p className="flex flex-wrap items-center gap-1 text-xs">
            <span className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-700">{TEMPERATURES[product.temperature]}</span>
            {soldOut ? <span className="rounded border border-red-300 px-1.5 py-0.5 text-red-700">已售完</span> : null}
          </p>
          {showStore && storeName ? <p className="mt-auto truncate text-xs text-slate-500">{storeName}</p> : null}
        </div>
      </Link>
    </article>
  );
}
