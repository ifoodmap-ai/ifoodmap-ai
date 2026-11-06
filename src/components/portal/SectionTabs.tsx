// 後台「分區裡用分頁」的共用元件 —— 給供應商/餐廳/管理員三個後台共用。
//
// 這不是傳統的「同頁切換內容」分頁:每個分頁背後是一條真實路由(NavLink 深連結),
// 切分頁 = 換網址,所以書籤、Email 連結、既有測試都不會壞。
// 元件只負責「畫分頁列 + 依目前路由標出所在分頁」,不管內容怎麼顯示(那是 <Outlet/> 的事)。
//
// 無障礙設計:
//   - 容器 role="tablist",每個分頁 role="tab" + aria-selected。
//   - 用 roving tabindex(只有目前分頁 tabIndex=0,其餘 -1)配合方向鍵在分頁間移動焦點,
//     Home/End 跳到頭尾 —— 符合 WAI-ARIA APG 的 tabs 鍵盤操作慣例。
//   - 用 Enter/Space 觸發真正的路由跳轉(Space 在原生 <a> 上預設不會觸發,所以手動補)。

import { Link, useLocation } from "react-router-dom";
import { useMemo, useRef, type KeyboardEvent } from "react";

export interface SectionTabItem {
  /** 分頁顯示文字 */
  label: string;
  /** 分頁對應的路由絕對路徑,例如 "/supplier/orders" */
  path: string;
  /** 用於 React key 與 aria id,預設用 path */
  key?: string;
  /**
   * 是否從分頁列隱藏(路由本身不受影響,直接打網址仍然可以開)。
   * 可以是固定值,也可以是回傳布林值的函式(以後要依角色/模組開關決定時用)。
   */
  hidden?: boolean | (() => boolean);
}

export interface SectionTabsProps {
  /** 這個分區底下的分頁清單 */
  tabs: SectionTabItem[];
  /** tablist 的無障礙標籤,例如「訂單分區的分頁」 */
  ariaLabel: string;
  /** 分頁列要控制的內容區塊 id(接 aria-controls),沒有就不寫這個屬性 */
  panelId?: string;
  className?: string;
}

const isTabActive = (pathname: string, tabPath: string): boolean =>
  pathname === tabPath || pathname.startsWith(`${tabPath}/`);

const resolveHidden = (hidden: SectionTabItem["hidden"]): boolean =>
  typeof hidden === "function" ? hidden() : Boolean(hidden);

/**
 * 分區內的分頁列。少於 2 個可見分頁時不畫任何東西 ——
 * 只剩一個目的地的「切換器」對使用者沒有意義,只會讓人誤以為少東西。
 */
export default function SectionTabs({ tabs, ariaLabel, panelId, className = "" }: SectionTabsProps) {
  const location = useLocation();
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const visibleTabs = useMemo(() => tabs.filter((tab) => !resolveHidden(tab.hidden)), [tabs]);

  if (visibleTabs.length < 2) return null;

  // 同時符合好幾個分頁時選路徑最長的(例如分區首頁 /supplier 與它底下的 /supplier/savings,後者才是目前這頁)
  const activeIndex = visibleTabs.reduce(
    (best, tab, i) =>
      isTabActive(location.pathname, tab.path) && (best === -1 || tab.path.length > visibleTabs[best].path.length) ? i : best,
    -1,
  );

  const focusTabAt = (index: number) => {
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = visibleTabs.findIndex((_, i) => tabRefs.current[i] === document.activeElement);
    if (currentIndex === -1) return;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusTabAt((currentIndex + 1) % visibleTabs.length);
        return;
      case "ArrowLeft":
        event.preventDefault();
        focusTabAt((currentIndex - 1 + visibleTabs.length) % visibleTabs.length);
        return;
      case "Home":
        event.preventDefault();
        focusTabAt(0);
        return;
      case "End":
        event.preventDefault();
        focusTabAt(visibleTabs.length - 1);
        return;
      case " ":
        // 原生 <a> 預設不吃 Space 觸發,手動補上跟 Enter 一致的行為
        event.preventDefault();
        tabRefs.current[currentIndex]?.click();
        return;
      default:
        return;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-gray-200 px-4 md:px-6 ${className}`}
    >
      {visibleTabs.map((tab, index) => {
        const id = tab.key ?? tab.path;
        const active = index === activeIndex;
        // 沒有任何分頁對到目前路由(例如停在被隱藏的分頁)時,
        // 讓第一個分頁保有 tabIndex=0,分頁列仍然可以用鍵盤進入
        const focusable = active || (activeIndex === -1 && index === 0);

        return (
          <Link
            key={id}
            id={`tab-${id}`}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            to={tab.path}
            role="tab"
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={focusable ? 0 : -1}
            className={`shrink-0 border-b-2 -mb-px px-3 py-2.5 text-sm font-medium transition-colors ${
              active
                ? "border-emerald-600 text-emerald-700"
                : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
