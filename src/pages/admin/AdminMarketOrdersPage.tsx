// 管理後台「零售市集 › 零售訂單」(/admin/market/orders):所有店家的零售訂單總覽 —— 唯讀,處理客訴時查資料用。
// 篩選:進行中 / 已出貨 / 已結束 / 全部;搜尋:訂單編號、收件人、電話、Email、店名(在已載入的清單裡找)。
// 「查看」看收件資料、物流、店家聯絡方式(店家電話與 contact_email 只有管理員看得到)、明細與時間軸
// (依 created_at 由早到晚,標出是消費者 / 店家 / 平台 / 系統做的)。
// 🔴 這一頁不改任何訂單:接單、出貨、取消都由店家在供應商後台處理,平台不經手貨款。
//    資料庫的轉移表雖然允許管理員取消,這一頁刻意不提供;測試釘住「沒有任何寫入」(連原始碼用到的函式都檢查)。
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import OrderItems from '@/components/market/OrderItems';
import { ADMIN_LOAD_FALLBACK, adminErrorMessage } from '@/lib/market/admin';
import { PAYMENT_METHODS } from '@/lib/market/constants';
import { formatTaipei, formatTwd } from '@/lib/market/format';
import { fetchAdminOrders, ORDER_LIST_LIMIT, ORDER_STATUS_LABEL, type AdminOrderFilter, type MarketOrderRow } from '@/lib/market/orders';
import { formatOrderNo } from '@/lib/order-number';

const FILTERS: Array<{ key: AdminOrderFilter; label: string }> = [
  { key: 'open', label: '進行中' },
  { key: 'shipped', label: '已出貨' },
  { key: 'closed', label: '已結束' },
  { key: 'all', label: '全部' },
];

const ACTOR_LABEL: Record<string, string> = { consumer: '消費者', supplier: '店家', admin: '平台', system: '系統' };

const SEARCH_LABEL = '搜尋訂單編號、收件人、電話、Email、店名';

const storeName = (o: MarketOrderRow) => o.market_stores?.suppliers?.name ?? '';

const matches = (o: MarketOrderRow, q: string) => {
  const needle = q.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  return [formatOrderNo(o.id).slice(1), o.buyer_name, o.buyer_phone, o.buyer_email, storeName(o)].some((v) =>
    v.toLowerCase().includes(needle),
  );
};

/**
 * created_at → 可以比大小的 [到秒的毫秒數, 秒以下的微秒]。PostgREST 回到微秒(…05:00:00.000001+00:00),Date 只到毫秒;
 * 同一個交易裡寫的兩筆(接單與自動補的「待匯款」)資料庫保證時間有先後,但可能只差幾微秒。只看時間,不看 id 也不看資料回來的順序。
 */
const instantOf = (iso: string): [number, number] => {
  const seconds = Date.parse(iso.replace(/\.\d+/, ''));
  const fraction = /\.(\d+)/.exec(iso)?.[1] ?? '';
  return [Number.isNaN(seconds) ? 0 : seconds, Number(fraction.slice(0, 6).padEnd(6, '0'))];
};

const byCreatedAt = (a: { created_at: string }, b: { created_at: string }) => {
  const [aSeconds, aMicros] = instantOf(a.created_at);
  const [bSeconds, bMicros] = instantOf(b.created_at);
  return aSeconds - bSeconds || aMicros - bMicros;
};

const OrderDetail = ({ order }: { order: MarketOrderRow }) => {
  const store = order.market_stores?.suppliers;
  const events = [...(order.market_order_events ?? [])].sort(byCreatedAt);
  const storeContact = [store?.name, store?.phone, store?.contact_email].filter(Boolean).join('・');
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          訂單 {formatOrderNo(order.id)}・{ORDER_STATUS_LABEL[order.status]}
        </DialogTitle>
        <DialogDescription>
          {store?.name ?? '—'}・{PAYMENT_METHODS[order.payment_method]}・{formatTaipei(order.created_at)}
        </DialogDescription>
      </DialogHeader>
      <section className="space-y-1 text-sm text-slate-700">
        <h3 className="font-semibold text-slate-900">收件人</h3>
        <p className="break-all">
          {order.buyer_name}・{order.buyer_phone}・{order.buyer_email}
        </p>
        <p>
          {order.ship_city}
          {order.ship_address}
        </p>
        {order.buyer_note ? <p className="whitespace-pre-line text-slate-600">備註:{order.buyer_note}</p> : null}
        {order.status_note ? <p className="whitespace-pre-line text-red-700">原因:{order.status_note}</p> : null}
        {order.shipped_carrier ? (
          <p>
            物流:{order.shipped_carrier}
            {order.shipped_tracking_no ? `,單號 ${order.shipped_tracking_no}` : ''}
          </p>
        ) : null}
      </section>
      <section className="space-y-1 text-sm text-slate-700">
        <h3 className="font-semibold text-slate-900">店家聯絡</h3>
        <p className="break-all">{storeContact || '—'}</p>
      </section>
      <OrderItems items={order.market_order_items} subtotal={order.subtotal} shippingFee={order.shipping_fee} total={order.total} />
      <section>
        <h3 className="text-sm font-semibold text-slate-900">時間軸</h3>
        {events.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">沒有紀錄</p>
        ) : (
          <ol className="mt-1 space-y-1 text-sm text-slate-700">
            {events.map((e, i) => (
              <li key={`${e.created_at}-${i}`} className="whitespace-pre-line">
                {`${formatTaipei(e.created_at)} ${ORDER_STATUS_LABEL[e.to_status] ?? e.to_status}(${ACTOR_LABEL[e.actor_role] ?? e.actor_role})${e.note ? `:${e.note}` : ''}`}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
};

const AdminMarketOrdersPage = () => {
  const [filter, setFilter] = useState<AdminOrderFilter>('open');
  const [rows, setRows] = useState<MarketOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<MarketOrderRow | null>(null);

  useEffect(() => {
    // 換篩選時,比較慢回來的舊查詢(成功或失敗)一律丟掉,不蓋掉新清單
    let outdated = false;
    setLoading(true);
    setLoadError(null);
    fetchAdminOrders(filter).then(
      (list) => {
        if (outdated) return;
        setRows(list);
        setLoading(false);
      },
      (e) => {
        if (outdated) return;
        setRows([]);
        setLoadError(adminErrorMessage(e, ADMIN_LOAD_FALLBACK));
        setLoading(false);
      },
    );
    return () => {
      outdated = true;
    };
  }, [filter, reloadKey]);

  const shown = useMemo(() => rows.filter((o) => matches(o, query)), [rows, query]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售訂單</h1>
      <p className="mb-4 text-sm text-slate-500">
        消費者在食材市集的訂單(每家店一張)。這裡只能查看,用來查詢與處理客訴;接單、出貨、取消由店家在供應商後台處理,平台不經手貨款。
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="訂單狀態" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'outline'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </Button>
          ))}
        </div>
        <Input aria-label={SEARCH_LABEL} placeholder={SEARCH_LABEL} value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-[12rem] max-w-xs flex-1" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16" role="status">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-hidden="true" />
          <span className="sr-only">載入中</span>
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>零售訂單載入失敗:{loadError}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setReloadKey((n) => n + 1)}>
            重新載入
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">沒有符合的訂單</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {shown.map((o) => {
            const no = formatOrderNo(o.id);
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-[12rem] flex-1">
                  <p className="font-medium text-slate-800">
                    {no}・{storeName(o) || '—'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatTaipei(o.created_at)}・{o.buyer_name}・{o.ship_city}・{PAYMENT_METHODS[o.payment_method]}・{formatTwd(o.total)}
                  </p>
                </div>
                <Badge variant="outline">{ORDER_STATUS_LABEL[o.status]}</Badge>
                <Button size="sm" variant="outline" onClick={() => setDetail(o)} aria-label={`查看 ${no}`}>
                  查看
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !loadError && rows.length >= ORDER_LIST_LIMIT ? (
        <p className="mt-3 text-sm text-slate-500">只載入最新的 {ORDER_LIST_LIMIT} 張;更早的訂單不會出現在清單與搜尋結果裡。</p>
      ) : null}

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">{detail ? <OrderDetail order={detail} /> : null}</DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketOrdersPage;
