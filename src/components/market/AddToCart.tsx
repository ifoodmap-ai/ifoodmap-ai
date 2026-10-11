// 商品頁的「加入購物車」:數量 + 按鈕。手機(≤ 880px)黏在畫面底部,桌機跟著內容走。
// 用 sticky 不用 fixed:fixed 一直蓋在畫面最下面,捲到底時會蓋住頁尾的服務條款 / 隱私權政策連結(點不到、Tab 到也看不到);
// sticky 只在商品資訊那一欄的範圍裡黏著,捲過了就回到原位,不會蓋到店家卡和頁尾。-mx-4 抵掉頁面的左右留白,手機上滿版。
// 售完、預覽中(還沒上架)、購物車滿了都不能加;加入後用 role="status" 告訴螢幕閱讀器,並給「看購物車」連結。
import { useState } from "react";
import { Link } from "react-router-dom";
import { isPubliclyVisible } from "@/lib/market/catalog";
import { CART_LIMITS, isCartFull, maxQtyFor } from "@/lib/market/cart";
import type { MarketProductRow } from "@/lib/market/types";
import { useCart } from "@/lib/market/useCart";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON } from "./MarketLayout";
import QtyStepper from "./QtyStepper";

/** 換商品就整個重來(數量、「已加入購物車」):路由的 :productId 換了時 React 會沿用同一個元件,狀態會留到下一個商品 */
export default function AddToCart({ product }: { product: MarketProductRow }) {
  return <AddToCartPanel key={product.id} product={product} />;
}

function AddToCartPanel({ product }: { product: MarketProductRow }) {
  const { lines, add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const inCart = lines.find((l) => l.productId === product.id)?.qty ?? 0;
  const max = maxQtyFor(product);
  const remaining = Math.max(0, max - inCart);
  const full = isCartFull(lines, product.id);

  if (!isPubliclyVisible(product)) return null;

  const reason =
    max === 0 ? "已售完" : remaining === 0 ? `購物車裡已經有 ${inCart} 件(已達可購買上限)` : full ? `購物車最多 ${CART_LIMITS.maxLines} 種商品` : null;

  return (
    <div className="sticky bottom-0 z-20 -mx-4 border-t border-slate-200 bg-white p-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] min-[881px]:static min-[881px]:mx-0 min-[881px]:border-0 min-[881px]:p-0 min-[881px]:shadow-none">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <QtyStepper value={Math.min(qty, Math.max(1, remaining))} max={Math.max(1, remaining)} onChange={setQty} label={`${product.name} 數量`} disabled={!!reason} />
        <button
          type="button"
          disabled={!!reason}
          onClick={() => {
            add(product.id, Math.min(qty, remaining), max);
            setAdded(true);
            setQty(1);
          }}
          className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-6 font-semibold disabled:bg-slate-300 disabled:text-slate-600 min-[881px]:flex-none ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
        >
          {max === 0 ? "已售完" : "加入購物車"}
        </button>
        <p role="status" className="w-full text-sm text-slate-700 min-[881px]:w-auto">
          {reason && max > 0 ? reason : null}
          {added && !reason ? (
            <>
              已加入購物車。
              <Link to="/market/cart" className={`ml-1 font-medium text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                看購物車
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
