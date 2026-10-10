// 市集裡找不到的頁面 / 商品 / 店家:一句話 + 回市集首頁(不用全站的 NotFound,那頁是英文、會導回登入頁)
import { Link } from "react-router-dom";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";

export default function MarketNotFound({ message = "找不到這個頁面。" }: { message?: string }) {
  useMarketTitle("找不到頁面");
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
