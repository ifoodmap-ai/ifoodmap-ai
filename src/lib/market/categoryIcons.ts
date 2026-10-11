// 分類圖示:直接引用形象站的 SVG(landing/assets/cat-*.svg),不複製檔案 —— 圖只有一份來源。
// Vite 建置時這些檔案(都小於 4 KB)會被內聯成 data URI;vitest 裡拿到的是檔案路徑字串。
// ⚠️ 只改 landing/ 的 commit 不會重建產品站(vercel.json 的 ignoreCommand、deploy-vercel.yml 的 paths-ignore),
//    改了圖示要等下一次產品站部署才會換上。
import condiment from "../../../landing/assets/cat-condiment.svg";
import drink from "../../../landing/assets/cat-drink.svg";
import egg from "../../../landing/assets/cat-egg.svg";
import fruit from "../../../landing/assets/cat-fruit.svg";
import grain from "../../../landing/assets/cat-grain.svg";
import grocery from "../../../landing/assets/cat-grocery.svg";
import hotpot from "../../../landing/assets/cat-hotpot.svg";
import meat from "../../../landing/assets/cat-meat.svg";
import packaging from "../../../landing/assets/cat-packaging.svg";
import processed from "../../../landing/assets/cat-processed.svg";
import seafood from "../../../landing/assets/cat-seafood.svg";
import vegetable from "../../../landing/assets/cat-vegetable.svg";
import type { MarketCategoryKey } from "./constants";

export const CATEGORY_ICON: Record<MarketCategoryKey, string> = {
  vegetable,
  fruit,
  seafood,
  meat,
  egg,
  grain,
  grocery,
  processed,
  hotpot,
  condiment,
  drink,
  packaging,
};
