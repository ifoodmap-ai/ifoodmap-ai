// 消費者食材市集(/market/*)的共用版面:頁首(logo、購物車)、主內容(<Outlet/>)、頁尾(平台角色說明、條款連結)。
//
// 手機優先;≤ 880px 是手機(跟形象站同一個分界),桌機用 Tailwind 任意斷點 min-[881px]:。
// 無障礙:第一個 Tab 到的是「跳到主要內容」;<main id="market-main"> 可以接收焦點(scroll-mt-16:跳過去時不會被固定的頁首蓋住);
// 每頁的 <h1> 由各頁自己畫(剛好一個)。
// 換頁:點連結進到市集的另一頁會捲回頂端;離開市集時把分頁標題還原成進市集之前的。
import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigationType } from "react-router-dom";
import { ShoppingCart } from "lucide-react";
import { useCart } from "@/lib/market/useCart";

export const MARKET_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2";

/** 主要按鈕的顏色(白字對 emerald-700 約 5.5:1;產品站 primary 綠對白字只有約 2.3:1,市集不用 variant="default") */
export const MARKET_PRIMARY_BUTTON = "bg-emerald-700 text-white hover:bg-emerald-800";

/**
 * 進市集之前的分頁標題:市集裡第一次設定標題時記下,MarketLayout 卸載(離開市集)時還原。
 * 不在各頁的 effect 裡還原 —— 市集裡換頁時標題會先閃回原本的;也不在 MarketLayout 掛上時記 ——
 * 子元件的 effect 比父元件先跑,那時標題已經被市集改掉了。
 */
let titleBeforeMarket: string | null = null;

/** 各頁設定 document.title(換頁時螢幕閱讀器會唸) */
export const useMarketTitle = (title: string | null | undefined) => {
  useEffect(() => {
    if (titleBeforeMarket === null) titleBeforeMarket = document.title;
    document.title = title ? `${title}｜iFoodmap 食材市集` : "iFoodmap 食材市集";
  }, [title]);
};

export default function MarketLayout() {
  const { count } = useCart();
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  // 點連結換頁(PUSH / REPLACE)捲回頂端,不然手機從清單下方點進商品頁會停在半頁。
  // 上一頁 / 下一頁(POP)交給瀏覽器還原位置;第一次載入也是 POP。網址帶 #錨點(例如條款第六條)時交給頁面自己捲到那一條。
  useEffect(() => {
    if (navigationType !== "POP" && !hash) window.scrollTo(0, 0);
    // 只看 pathname:首頁改篩選條件(?q=、?cat=)是 REPLACE,不能每打一個字就捲回頂端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(
    () => () => {
      if (titleBeforeMarket !== null) document.title = titleBeforeMarket;
      titleBeforeMarket = null;
    },
    [],
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <a
        href="#market-main"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-emerald-800 focus:shadow ${MARKET_FOCUS_RING}`}
      >
        跳到主要內容
      </a>

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <Link to="/market" className={`inline-flex min-h-11 items-center gap-2 rounded-md ${MARKET_FOCUS_RING}`}>
            <img src="/logo.png" alt="" width={192} height={56} className="h-8 w-auto" />
            <span className="text-base font-bold text-emerald-800">食材市集</span>
            <span className="sr-only">首頁</span>
          </Link>
          <nav aria-label="市集" className="ml-auto flex items-center gap-1">
            <Link
              to="/market/cart"
              aria-label={`購物車,${count} 件`}
              className={`relative inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-slate-800 hover:bg-slate-100 ${MARKET_FOCUS_RING}`}
            >
              <ShoppingCart className="h-5 w-5" aria-hidden="true" />
              <span className="text-sm">購物車</span>
              {count > 0 ? (
                <span aria-hidden="true" className="rounded-full bg-emerald-700 px-1.5 text-xs font-semibold text-white">
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </Link>
          </nav>
        </div>
      </header>

      <main id="market-main" tabIndex={-1} className="flex-1 scroll-mt-16 focus:outline-none">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-slate-600">
          <p>iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link to="/market/terms" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              服務條款
            </Link>
            <Link to="/market/privacy" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              隱私權政策
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
