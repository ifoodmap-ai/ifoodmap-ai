// 店家的配送與付款條件(商品頁的店家卡、店家頁共用)。
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { citiesSummary, minOrderSummary, shipDaysSummary, shippingSummary } from "@/lib/market/format";
import type { MarketStoreRow } from "@/lib/market/types";

export default function StoreInfoList({ store }: { store: MarketStoreRow }) {
  const rows: Array<[string, string]> = [
    ["配送縣市", citiesSummary(store.delivery_cities)],
    ["運費", shippingSummary(store)],
    ["最低訂購", minOrderSummary(store)],
    ["出貨", shipDaysSummary(store.ship_days)],
    ["付款方式", store.payment_methods.map((m) => PAYMENT_METHODS[m]).join("、")],
  ];
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
