// 市集頁面共用的鍵盤焦點小工具。
import type { FocusEvent } from "react";

/**
 * 橫向捲動列裡的按鈕(分類列、商品縮圖列):得到焦點時把整顆按鈕(連同畫在外面的焦點框)捲進可見範圍。
 * Chrome 用 Tab 聚焦時,露出一半的元素不會自己捲(只有完全看不到才捲),按鈕和焦點框都會被切掉一截;
 * 2026-10-10 用 headless Chrome 逐次按 Tab 實測:分類列的「肉品」「調味品」「包材耗材」都停在半露出來。
 * 搭配捲動列的 scroll-px-*,捲完離邊緣留空間。jsdom 沒有 scrollIntoView,所以用 ?.。
 */
export const scrollIntoViewOnFocus = (e: FocusEvent<HTMLElement>) =>
  e.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
