// 消費者食材市集(/market/*)的共用版面:頁首(logo、導覽)、主內容(<Outlet/>)、頁尾(平台角色說明)。
//
// 手機優先;≤ 880px 是手機(跟形象站同一個分界),桌機用 Tailwind 任意斷點 min-[881px]:。
// 無障礙:第一個 Tab 到的是「跳到主要內容」;<main id="market-main"> 可以接收焦點(scroll-mt-16:跳過去時不會被固定的頁首蓋住);
// 每頁的 <h1> 由各頁自己畫(剛好一個)。
import { useEffect } from "react";
import { Link, Outlet } from "react-router-dom";

export const MARKET_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2";

/** 主要按鈕的顏色(白字對 emerald-700 約 5.5:1;產品站 primary 綠對白字只有約 2.3:1,市集不用 variant="default") */
export const MARKET_PRIMARY_BUTTON = "bg-emerald-700 text-white hover:bg-emerald-800";

/** 各頁設定 document.title(換頁時螢幕閱讀器會唸) */
export const useMarketTitle = (title: string | null | undefined) => {
  useEffect(() => {
    document.title = title ? `${title}｜iFoodmap 食材市集` : "iFoodmap 食材市集";
  }, [title]);
};

export default function MarketLayout() {
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
          <nav aria-label="市集" className="ml-auto flex items-center gap-1" />
        </div>
      </header>

      <main id="market-main" tabIndex={-1} className="flex-1 scroll-mt-16 focus:outline-none">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-slate-600">
          <p>iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。</p>
        </div>
      </footer>
    </div>
  );
}
