// 供應商後台「零售市集 › 零售訂單」(/supplier/market/orders):消費者在食材市集下的訂單(跟餐廳詢價訂單完全分開)。
// 分頁:待處理(待接單 / 已接單 / 待匯款 / 已收款)、已出貨、已結束,分頁上顯示件數。每張單:訂單編號、狀態、時間、付款方式、
// 收件人(電話可以直接撥)、地址、備註、原因、物流、明細、能按的動作(按鈕名稱帶訂單編號,螢幕閱讀器分得出是哪一張)。
// 能按的動作一律由 orders.ts 的 supplierActions(= 轉移表 MARKET_TRANSITIONS)推出來,這裡不寫死;實際規則在資料庫的轉移表。
// 只看得到自家的單:fetchSupplierOrders 依 supplier_id 查,資料庫的 RLS 另外把關。
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import OrderActionDialog, { type OrderActionTarget } from "@/components/market/OrderActionDialog";
import OrderItems from "@/components/market/OrderItems";
import { useCurrentSupplier } from "@/hooks/use-current-supplier";
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { friendlyDbError } from "@/lib/market/db";
import { formatTaipei } from "@/lib/market/format";
import {
  fetchSupplierOrders,
  OPEN_STATUSES,
  ORDER_ACTIONS,
  ORDER_LIST_LIMIT,
  ORDER_STATUS_LABEL,
  supplierActions,
  type OrderStatus,
} from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";

type TabKey = "open" | "shipped" | "closed";

const TABS: Array<{ key: TabKey; label: string; statuses: readonly OrderStatus[] }> = [
  { key: "open", label: "待處理", statuses: OPEN_STATUSES },
  { key: "shipped", label: "已出貨", statuses: ["shipped"] },
  { key: "closed", label: "已結束", statuses: ["completed", "rejected", "cancelled"] },
];

const LOAD_FALLBACK = "請稍後再試一次";

/** 跟供應商後台其他頁一樣自己留邊(SupplierLayout 的主內容區沒有 padding) */
const PAGE = "mx-auto max-w-4xl p-4 md:p-6";

export default function SupplierMarketOrdersPage() {
  const { supplierId, loading: idLoading, error: idError, reload: reloadSupplier } = useCurrentSupplier();
  const orders = useQuery({
    queryKey: ["market", "supplier-orders", supplierId],
    queryFn: () => fetchSupplierOrders(supplierId as string),
    enabled: !!supplierId,
  });
  const [tab, setTab] = useState<TabKey>("open");
  const [target, setTarget] = useState<OrderActionTarget | null>(null);

  const rows = useMemo(() => orders.data ?? [], [orders.data]);
  const counts = useMemo(
    () => Object.fromEntries(TABS.map((t) => [t.key, rows.filter((o) => t.statuses.includes(o.status)).length])) as Record<TabKey, number>,
    [rows],
  );
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const shown = rows.filter((o) => current.statuses.includes(o.status));

  const heading = (
    <>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售訂單</h1>
      <p className="mb-4 text-sm text-slate-500">
        消費者在食材市集下的訂單。貨款由你直接收(貨到付款 / 銀行轉帳),發票由你開立。消費者會收到每一步的 Email 通知。
      </p>
    </>
  );

  if (idLoading) {
    return (
      <div className={PAGE}>
        {heading}
        <div className="flex justify-center py-16" role="status">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-hidden="true" />
          <span className="sr-only">載入中</span>
        </div>
      </div>
    );
  }

  if (!supplierId) {
    return (
      <div className={PAGE}>
        {heading}
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {idError ?? "此帳號尚未綁定供應商"}
        </div>
        <Button type="button" variant="outline" className="mt-3 min-h-11" onClick={reloadSupplier}>
          重新載入
        </Button>
      </div>
    );
  }

  return (
    <div className={PAGE}>
      {heading}

      <div role="group" aria-label="訂單分類" className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            className="min-h-11"
            variant={tab === t.key ? "secondary" : "outline"}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {/* 還沒讀到(或讀取失敗)時不顯示件數,不會誤寫成 0 */}
            {orders.data ? `${t.label}(${counts[t.key]})` : t.label}
          </Button>
        ))}
      </div>

      {orders.isRefetchError ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="min-w-0 flex-1">訂單清單沒有更新成功,畫面上的狀態可能不是最新的。</p>
          <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => void orders.refetch()}>
            重新載入
          </Button>
        </div>
      ) : null}

      {orders.isPending ? (
        <div className="flex justify-center py-16" role="status">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-hidden="true" />
          <span className="sr-only">載入中</span>
        </div>
      ) : orders.isLoadingError ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p>訂單讀取失敗:{friendlyDbError(orders.error, LOAD_FALLBACK)}</p>
          <Button type="button" size="sm" variant="outline" className="mt-3 min-h-11" onClick={() => void orders.refetch()}>
            重新載入
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-500">沒有{current.label}的訂單</p>
      ) : (
        <ul className="space-y-4">
          {shown.map((o) => {
            const no = formatOrderNo(o.id);
            const actions = supplierActions(o);
            return (
              <li key={o.id}>
                <article aria-labelledby={`market-order-${o.id}`} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 id={`market-order-${o.id}`} className="font-semibold text-slate-900">
                      訂單 {no}
                    </h2>
                    <Badge variant="outline">{ORDER_STATUS_LABEL[o.status]}</Badge>
                    <span className="text-sm text-slate-500">
                      {formatTaipei(o.created_at)}・{PAYMENT_METHODS[o.payment_method]}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div className="min-w-0 space-y-1 text-sm text-slate-700">
                      <p className="font-medium text-slate-900">{o.buyer_name}</p>
                      <p>
                        <a href={`tel:${o.buyer_phone}`} className="text-emerald-800 underline underline-offset-2">
                          {o.buyer_phone}
                        </a>
                      </p>
                      <p className="break-all">{o.buyer_email}</p>
                      <p>
                        {o.ship_city}
                        {o.ship_address}
                      </p>
                      {o.buyer_note ? <p className="whitespace-pre-line text-slate-600">備註:{o.buyer_note}</p> : null}
                      {o.status_note ? <p className="whitespace-pre-line text-red-700">原因:{o.status_note}</p> : null}
                      {o.shipped_carrier ? (
                        <p>
                          物流:{o.shipped_carrier}
                          {o.shipped_tracking_no ? `,單號 ${o.shipped_tracking_no}` : ""}
                        </p>
                      ) : null}
                    </div>
                    <OrderItems items={o.market_order_items} subtotal={o.subtotal} shippingFee={o.shipping_fee} total={o.total} />
                  </div>
                  {actions.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                      {actions.map((to) => {
                        const meta = ORDER_ACTIONS[to];
                        if (!meta) return null;
                        return (
                          <Button
                            key={to}
                            size="sm"
                            variant={meta.danger ? "outline" : "default"}
                            className={`min-h-11 ${meta.danger ? "text-red-700" : "bg-emerald-700 text-white hover:bg-emerald-800"}`}
                            aria-label={`${meta.label} ${no}`}
                            onClick={() => setTarget({ order: o, to })}
                          >
                            {meta.label}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length >= ORDER_LIST_LIMIT ? (
        <p className="mt-4 text-sm text-slate-500">只顯示最新的 {ORDER_LIST_LIMIT} 張訂單。</p>
      ) : null}

      <OrderActionDialog target={target} onClose={() => setTarget(null)} onChanged={() => void orders.refetch()} />
    </div>
  );
}
