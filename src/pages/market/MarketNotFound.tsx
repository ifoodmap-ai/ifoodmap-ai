// 市集裡找不到的頁面 / 商品 / 店家:一句話 + 回市集首頁(不用全站的 NotFound,那頁是英文、會導回登入頁)
import { Link } from "react-router-dom";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";

// title:分頁標題。商品頁、店家頁會傳跟自己 useMarketTitle 一樣的字(「找不到商品」「找不到店家」),
// 父子兩個 effect 誰後跑結果都一樣。
export default function MarketNotFound({
  message = "找不到這個頁面。",
  title = "找不到頁面",
}: {
  message?: string;
  title?: string;
}) {
  useMarketTitle(title);
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">{message}</h1>
      <Link
        to="/market"
        className={`mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 ${MARKET_FOCUS_RING}`}
      >
        回市集首頁
      </Link>
    </div>
  );
}
