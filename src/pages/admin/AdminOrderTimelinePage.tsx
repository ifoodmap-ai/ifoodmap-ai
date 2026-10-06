// 單筆訂單頁 /admin/orders/:id(訂單分區)。
//
// 後台精簡第一期:舊的「訂單明細」(/admin/orders/:id)與「訂單履歷」(/admin/orders/:id/timeline)
// 併成這一頁,以履歷為底(PROPOSAL.md §1 訂單列)。舊明細獨有的兩張卡「買方聯絡資訊」「對應分析來源」搬進來;
// 舊的 /timeline 網址在 App.tsx 轉址到這裡。舊明細的「更新狀態」卡與「刪除」沒有搬:
//   - 改狀態:直接 UPDATE status 會被 trg_guard_order_status 擋;刪除:會被 order_events 的 append-only 護欄擋
//     (PROPOSAL §5 #2)。正式的管理員動作列(派單/取消/結案/刪單,走 recordOrderEvent / admin_delete_order)是第二期。
//   - 同一張卡上的「備註」:狀態不變時其實存得進去,但那是直接改 supplier_orders.notes、不會留下任何事件,
//     放在這個「事實紀錄」頁上等於能無痕改訂單內容 —— 所以先不搬,要不要保留待業主決定(備註照樣在「訂單資訊」唯讀顯示)。
// 第二期(Q2-A):待派發/被拒/逾時的單在標題旁有「派給…」(DispatchOrderDialog,只寫一筆 recordOrderEvent);
// F5:管理員可以取消的單(含卡住的進行中訂單)有「取消訂單…」(CancelOrderDialog,要填原因,只寫一筆事件)。
// 除此之外這一頁維持唯讀,不寫任何資料表。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  FileWarning,
  ImageOff,
  ScrollText,
  Send,
  ShieldCheck,
  Star,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  ADMIN_DISPATCHABLE,
  ORDER_STATUS,
  ROLE_LABEL,
  SOURCE_LABEL,
  allowedTransitions,
  fetchOrderTimeline,
  formatStageAge,
  isStuck,
  type ActorRole,
  type OrderEvent,
  type OrderStatus,
} from '@/lib/orders';
import { formatOrderNo } from '@/lib/order-number';
import DispatchOrderDialog, { type DispatchTarget } from './DispatchOrderDialog';
import CancelOrderDialog, { type CancelTarget } from './CancelOrderDialog';
import { CLAIMED_ORDER_NOTE } from './analysisClaim';

/* ---------------------------------------------------------------
 * 新資料表尚未進 types.ts,沿用專案既有的 cast 慣例
 * ------------------------------------------------------------- */
type Res<T> = { data: T[] | null; error: { message: string } | null };

interface Chain<T> extends PromiseLike<Res<T>> {
  eq(col: string, v: unknown): Chain<T>;
  order(col: string, opts?: { ascending: boolean }): Chain<T>;
  limit(n: number): Chain<T>;
}

const table = <T,>(name: string) =>
  (supabase as never as {
    from: (t: string) => { select: (c: string) => Chain<T> };
  }).from(name);

/* ------------------------------ types ------------------------------ */
interface Ingredient {
  name?: string;
  quantity?: string | number;
  unit?: string;
  category?: string;
  price?: number;
  unit_price?: number;
  subtotal?: number;
}

interface OrderRow {
  id: string;
  created_at: string;
  updated_at: string | null;
  status: OrderStatus;
  notes: string | null;
  sent_at: string | null;
  supplier_id: string | null;
  restaurant_id: string | null;
  branch_id: string | null;
  analysis_id: string | null;
  total_amount: number | null;
  current_stage_since: string | null;
  approved_at: string | null;
  ingredient_list: Ingredient[] | null;
}

interface Receipt {
  id: string;
  order_id: string;
  shipment_id: string | null;
  image_url: string | null;
  ai_parsed: unknown;
  discrepancies: unknown;
  has_discrepancy: boolean | null;
  created_at: string;
}

interface Review {
  id: string;
  rating_overall: number | null;
  rating_ontime: number | null;
  rating_quality: number | null;
  rating_accuracy: number | null;
  comment: string | null;
  created_at: string;
}

/** 形象站留下的買方聯絡資訊(用 analysis_id 對到這張單的來源分析) */
interface BuyerLead {
  company_name: string | null;
  contact_phone: string | null;
  contact_line: string | null;
  /** 形象站「留 Email 讓專人聯絡」 */
  contact_email: string | null;
}

interface Dispute {
  id: string;
  kind: string;
  status: string;
  opened_role: string | null;
  detail: string | null;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

/* ------------------------------ labels ------------------------------ */
const DISPUTE_KIND: Record<string, string> = {
  shortage: '數量短缺',
  late: '延遲到貨',
  quality: '品質不符',
  wrong_item: '出錯品項',
  other: '其他',
};

const DISPUTE_STATUS: Record<string, { label: string; className: string }> = {
  open: { label: '待處理', className: 'bg-red-50 text-red-700 border-red-200' },
  investigating: { label: '調查中', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  resolved: { label: '已解決', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  closed: { label: '已結案', className: 'bg-slate-100 text-slate-600 border-slate-300' },
};

const DISCREPANCY_FIELD: Record<string, string> = {
  name: '品項',
  item: '品項',
  ingredient: '品項',
  expected: '應收',
  ordered: '訂購',
  actual: '實收',
  received: '實收',
  quantity: '數量',
  qty: '數量',
  unit: '單位',
  diff: '差異',
  reason: '原因',
  note: '備註',
  kind: '類型',
  type: '類型',
};

const statusLabel = (s: OrderStatus | string | null): string => {
  if (!s) return '—';
  return ORDER_STATUS[s as OrderStatus]?.label ?? String(s);
};

const statusClass = (s: OrderStatus | string | null): string =>
  ORDER_STATUS[s as OrderStatus]?.className ?? 'bg-slate-100 text-slate-700 border-slate-300';

const dotClass = (s: OrderStatus): string => {
  if (['rejected', 'disputed', 'expired', 'cancelled'].includes(s)) return 'bg-red-500';
  if (s === 'discrepancy') return 'bg-orange-500';
  if (['received', 'reviewed', 'closed', 'completed'].includes(s)) return 'bg-emerald-500';
  return 'bg-blue-500';
};

const money = (v: number | null) =>
  v == null ? null : `NT$ ${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`;

const fmtValue = (v: unknown): string => {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/* ------------------------------ small parts ------------------------------ */
const InfoRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex gap-2">
    <span className="text-slate-500 w-24 shrink-0">{label}</span>
    <span className="text-slate-800 min-w-0">{value}</span>
  </div>
);

const Stars = ({ value }: { value: number | null }) => {
  if (value == null) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${
            i < Math.round(value) ? 'text-amber-500 fill-amber-500' : 'text-slate-300'
          }`}
        />
      ))}
      <span className="ml-1 text-xs text-slate-600 tabular-nums">{value}</span>
    </span>
  );
};

const DiscrepancyList = ({ value }: { value: unknown }) => {
  if (value == null) return null;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li
          key={i}
          className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-xs text-orange-900"
        >
          {typeof it === 'object' && it !== null ? (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(it as Record<string, unknown>).map(([k, v]) => (
                <span key={k}>
                  <span className="text-orange-600">{DISCREPANCY_FIELD[k] ?? k}:</span>{' '}
                  {fmtValue(v)}
                </span>
              ))}
            </span>
          ) : (
            String(it)
          )}
        </li>
      ))}
    </ul>
  );
};

const JsonDetails = ({ label, value }: { label: string; value: unknown }) => (
  <details className="mt-2 group">
    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700 select-none">
      {label}
    </summary>
    <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-slate-900 p-2.5 text-[11px] leading-relaxed text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  </details>
);

const ReceiptBlock = ({ receipt }: { receipt: Receipt }) => {
  const hasDiff =
    receipt.has_discrepancy ||
    (Array.isArray(receipt.discrepancies) && receipt.discrepancies.length > 0);
  return (
    <div
      className={`mt-2 rounded-lg border p-2.5 ${
        hasDiff ? 'border-orange-200 bg-orange-50/60' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-slate-700">收貨憑證</span>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {new Date(receipt.created_at).toLocaleString('zh-TW')}
        </span>
      </div>

      {receipt.image_url ? (
        <a href={receipt.image_url} target="_blank" rel="noreferrer" className="block">
          <img
            src={receipt.image_url}
            alt="收貨照片"
            loading="lazy"
            className="max-h-56 w-auto rounded border border-slate-200 object-contain bg-white"
          />
        </a>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <ImageOff className="h-3.5 w-3.5" />
          未附照片
        </p>
      )}

      {hasDiff ? (
        <div className="mt-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-orange-800">
            <FileWarning className="h-3.5 w-3.5" />
            差異明細
          </p>
          <DiscrepancyList value={receipt.discrepancies} />
        </div>
      ) : (
        <p className="mt-2 text-xs text-emerald-700">品項與數量比對無差異</p>
      )}

      {receipt.ai_parsed != null && <JsonDetails label="AI 辨識結果 (ai_parsed)" value={receipt.ai_parsed} />}
    </div>
  );
};

/* ------------------------------ page ------------------------------ */
export default function AdminOrderTimelinePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // 這一頁從看板、全部訂單、爭議、營收、媒合品質都點得進來 —— 返回鈕回到來的地方;
  // 直接打網址或從外部連結進來(沒有站內上一頁)時,退回「全部訂單」。
  // BrowserRouter 在 history.state 放 idx(這個分頁裡第幾筆站內紀錄),replace 不會讓它變大 ——
  // 所以從外部連結打舊的 /timeline 網址(會 replace 轉址)進來,也算「沒有站內上一頁」,不會被帶離網站。
  const historyIdx = (window.history.state as { idx?: number } | null)?.idx;
  const hasInAppHistory = location.key !== 'default' && (historyIdx === undefined || historyIdx > 0);
  const goBack = () => (hasInAppHistory ? navigate(-1) : navigate('/admin/orders'));
  const backLabel = hasInAppHistory ? '返回上一頁' : '返回全部訂單';

  const [order, setOrder] = useState<OrderRow | null>(null);
  const [restaurantName, setRestaurantName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [timeline, setTimeline] = useState<OrderEvent[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [analysisSummary, setAnalysisSummary] = useState<string | null>(null);
  // 來源分析:通常是 supplier_orders.analysis_id;形象站訪客註冊認領的草稿則用 claimed_order_id 反查
  const [sourceAnalysisId, setSourceAnalysisId] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<BuyerLead | null>(null);
  const [loading, setLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<DispatchTarget | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setTimelineError(null);
    // 換到另一張單時,不要留著上一張單的名稱與聯絡資訊
    setRestaurantName('');
    setBranchName('');
    setSupplierName('');
    setAnalysisSummary(null);
    setSourceAnalysisId(null);
    setBuyer(null);

    const orderRes = await table<OrderRow>('supplier_orders').select('*').eq('id', id);
    const o = orderRes.data?.[0] ?? null;
    setOrder(o);

    if (o) {
      if (o.restaurant_id) {
        const r = await table<{ name: string }>('restaurants').select('name').eq('id', o.restaurant_id);
        setRestaurantName(r.data?.[0]?.name ?? '');
      }
      if (o.branch_id) {
        const b = await table<{ name: string }>('restaurant_branches')
          .select('name')
          .eq('id', o.branch_id);
        setBranchName(b.data?.[0]?.name ?? '');
      }
      if (o.supplier_id) {
        const s = await table<{ name: string }>('suppliers').select('name').eq('id', o.supplier_id);
        setSupplierName(s.data?.[0]?.name ?? '');
      }
      // 從舊明細搬來:這張單若來自某筆 AI 分析,帶出分析摘要與形象站留下的買方聯絡資訊
      if (o.analysis_id) {
        const [analysisRes, leadRes] = await Promise.all([
          table<{ summary: string | null }>('analysis_records').select('summary').eq('id', o.analysis_id),
          table<BuyerLead>('landing_leads')
            .select('company_name, contact_phone, contact_line, contact_email')
            .eq('analysis_id', o.analysis_id)
            .order('created_at', { ascending: false })
            .limit(1),
        ]);
        setSourceAnalysisId(o.analysis_id);
        setAnalysisSummary(analysisRes.data?.[0]?.summary ?? null);
        setBuyer(leadRes.data?.[0] ?? null);
      } else if (o.notes === CLAIMED_ORDER_NOTE) {
        // 形象站訪客註冊後由 claim_landing_analysis 建的草稿:契約沒要求寫 analysis_id,
        // 改用分析紀錄上的 claimed_order_id 反查來源(只有帶這個備註的單才查,一般訂單不多打查詢)
        const claimedRes = await table<{ id: string; summary: string | null }>('analysis_records')
          .select('id, summary')
          .eq('claimed_order_id', o.id)
          .limit(1);
        const source = claimedRes.data?.[0] ?? null;
        if (source) {
          const leadRes = await table<BuyerLead>('landing_leads')
            .select('company_name, contact_phone, contact_line, contact_email')
            .eq('analysis_id', source.id)
            .order('created_at', { ascending: false })
            .limit(1);
          setSourceAnalysisId(source.id);
          setAnalysisSummary(source.summary ?? null);
          setBuyer(leadRes.data?.[0] ?? null);
        }
      }
    }

    try {
      setTimeline(await fetchOrderTimeline(id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '讀取訂單履歷失敗';
      setTimelineError(msg);
      toast.error('讀取訂單履歷失敗', { description: msg });
    }

    const [rc, rv, dp] = await Promise.all([
      table<Receipt>('delivery_receipts').select('*').eq('order_id', id).order('created_at', { ascending: true }),
      table<Review>('order_reviews').select('*').eq('order_id', id),
      table<Dispute>('disputes').select('*').eq('order_id', id).order('created_at', { ascending: true }),
    ]);
    setReceipts(rc.data ?? []);
    setReviews(rv.data ?? []);
    setDisputes(dp.data ?? []);

    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /** 收貨憑證掛到時間最接近的收貨/差異事件底下 */
  const { receiptsByEvent, orphanReceipts } = useMemo(() => {
    const anchors = timeline.filter(
      (e) => e.to_status === 'received' || e.to_status === 'discrepancy',
    );
    const map: Record<string, Receipt[]> = {};
    const orphans: Receipt[] = [];

    receipts.forEach((rc) => {
      if (anchors.length === 0) {
        orphans.push(rc);
        return;
      }
      let bestId = anchors[0].id;
      let bestDiff = Number.POSITIVE_INFINITY;
      anchors.forEach((a) => {
        const d = Math.abs(new Date(rc.created_at).getTime() - new Date(a.created_at).getTime());
        if (d < bestDiff) {
          bestDiff = d;
          bestId = a.id;
        }
      });
      if (!map[bestId]) map[bestId] = [];
      map[bestId].push(rc);
    });

    return { receiptsByEvent: map, orphanReceipts: orphans };
  }, [timeline, receipts]);

  const stuck = order ? isStuck(order.status, order.current_stage_since) : false;
  const waitingOn: ActorRole | null = order ? ORDER_STATUS[order.status]?.waitingOn ?? null : null;

  /* ------------------------------ loading / empty ------------------------------ */
  if (loading) {
    return (
      <div className="max-w-4xl space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-4xl">
        <button
          onClick={goBack}
          className="mb-5 flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-800"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </button>
        <div className="py-20 text-center text-slate-500">找不到這筆訂單</div>
      </div>
    );
  }

  /* ------------------------------ render ------------------------------ */
  return (
    <div className="max-w-4xl">
      <button
        onClick={goBack}
        className="mb-5 flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </button>

      <div className="mb-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-800">訂單履歷</h1>
          <span className="font-mono text-sm text-slate-400">{formatOrderNo(order.id)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={statusClass(order.status)}>
            {statusLabel(order.status)}
          </Badge>
          {ADMIN_DISPATCHABLE.includes(order.status) && allowedTransitions('admin', order.status).includes('dispatched') && (
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() =>
                setDispatchTarget({
                  id: order.id,
                  status: order.status,
                  supplier_id: order.supplier_id,
                  restaurantName: restaurantName || null,
                })
              }
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {order.status === 'rejected' || order.status === 'expired' ? '改派給…' : '派給…'}
            </Button>
          )}
          {allowedTransitions('admin', order.status).includes('cancelled') && (
            <Button
              size="sm"
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50"
              onClick={() => setCancelTarget({ id: order.id, status: order.status, supplier_id: order.supplier_id })}
            >
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
              取消訂單…
            </Button>
          )}
        </div>
      </div>
      <p className="mb-5 text-sm text-slate-500">
        這一筆訂單從建立到現在,每一次狀態變更、誰做的、從哪個介面做的,全部按時間排列
      </p>

      {stuck && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          <p className="text-sm text-red-800">
            這筆訂單已在「{statusLabel(order.status)}」停留 {formatStageAge(order.current_stage_since)},
            超過處理時限{waitingOn ? ` — 該催${ROLE_LABEL[waitingOn]}` : ''}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {/* 基本資訊 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-700">訂單資訊</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <InfoRow label="餐廳" value={restaurantName || <span className="text-slate-400 italic">未指定</span>} />
            <InfoRow label="分店" value={branchName || <span className="text-slate-400 italic">—</span>} />
            <InfoRow label="供應商" value={supplierName || <span className="text-slate-400 italic">尚未派發</span>} />
            <InfoRow
              label="金額"
              value={
                money(order.total_amount) ?? <span className="text-slate-400 italic">尚未報價</span>
              }
            />
            <InfoRow label="目前狀態" value={statusLabel(order.status)} />
            <InfoRow
              label="已停留"
              value={
                <span className={stuck ? 'font-semibold text-red-600' : undefined}>
                  {formatStageAge(order.current_stage_since ?? order.created_at)}
                </span>
              }
            />
            <InfoRow label="建立時間" value={new Date(order.created_at).toLocaleString('zh-TW')} />
            {order.sent_at && (
              <InfoRow label="發送時間" value={new Date(order.sent_at).toLocaleString('zh-TW')} />
            )}
            <InfoRow
              label="等待對象"
              value={waitingOn ? ROLE_LABEL[waitingOn] : <span className="text-slate-400">流程已結束</span>}
            />
            {order.notes && <InfoRow label="備註" value={order.notes} />}
          </CardContent>
        </Card>

        {/* 買方聯絡資訊(從舊明細搬來) */}
        {buyer && (
          <Card className="border-emerald-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-emerald-700">買方聯絡資訊</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <InfoRow label="姓名 / 名稱" value={buyer.company_name || '—'} />
              <InfoRow label="聯絡電話" value={buyer.contact_phone || '—'} />
              <InfoRow label="LINE ID" value={buyer.contact_line || '—'} />
              <InfoRow label="Email" value={buyer.contact_email || '—'} />
            </CardContent>
          </Card>
        )}

        {/* 品項 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-700">訂購品項</CardTitle>
          </CardHeader>
          <CardContent>
            {order.ingredient_list && order.ingredient_list.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="text-slate-600">品項</TableHead>
                    <TableHead className="text-slate-600">數量</TableHead>
                    <TableHead className="text-slate-600">單位</TableHead>
                    <TableHead className="text-slate-600">分類</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.ingredient_list.map((it, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm text-slate-800">{it.name ?? '—'}</TableCell>
                      <TableCell className="text-sm text-slate-600">
                        {it.quantity != null && it.quantity !== '' ? String(it.quantity) : '—'}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{it.unit || '—'}</TableCell>
                      <TableCell className="text-sm text-slate-600">{it.category || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm italic text-slate-400">無品項資料</p>
            )}
          </CardContent>
        </Card>

        {/* 對應分析來源(從舊明細搬來;註冊認領的草稿用 claimed_order_id 反查到的那筆) */}
        {sourceAnalysisId && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-slate-700">對應分析來源</CardTitle>
              {!order.analysis_id && (
                <p className="text-xs text-emerald-700">形象站訪客註冊後,由 AI 採購助手的對話帶入成這張草稿</p>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {analysisSummary ?? <span className="italic text-slate-400">無摘要</span>}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/admin/analyses/${sourceAnalysisId}`)}
              >
                查看分析紀錄 →
              </Button>
            </CardContent>
          </Card>
        )}

        {/* 時間軸 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-slate-700">
              <ScrollText className="h-4 w-4 text-slate-400" />
              事件時間軸
              {timeline.length > 0 && (
                <span className="text-xs font-normal text-slate-400">共 {timeline.length} 筆</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {timelineError ? (
              <p className="py-8 text-center text-sm text-red-600">讀取履歷失敗:{timelineError}</p>
            ) : timeline.length === 0 ? (
              <div className="py-12 text-center text-slate-400">
                <p className="text-sm">這筆訂單還沒有任何事件紀錄</p>
                <p className="mt-1 text-xs">舊資料建立時尚未啟用事件流,之後的每一次狀態變更都會記在這裡</p>
              </div>
            ) : (
              <ol className="relative">
                {timeline.map((e, idx) => {
                  const attached = receiptsByEvent[e.id] ?? [];
                  const hasPayload = e.payload && Object.keys(e.payload).length > 0;
                  const last = idx === timeline.length - 1;
                  return (
                    <li key={e.id} className="relative pl-8 pb-5 last:pb-0">
                      {!last && (
                        <span className="absolute left-[7px] top-5 bottom-0 w-px bg-slate-200" aria-hidden />
                      )}
                      <span
                        className={`absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-white ${dotClass(
                          e.to_status,
                        )}`}
                        aria-hidden
                      />

                      <div className="flex flex-col sm:flex-row sm:gap-4">
                        <div className="shrink-0 pt-0.5 text-xs tabular-nums text-slate-500 sm:w-28">
                          <div>{new Date(e.created_at).toLocaleDateString('zh-TW')}</div>
                          <div className="text-slate-400">
                            {new Date(e.created_at).toLocaleTimeString('zh-TW', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>

                        <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {e.from_status ? (
                              <>
                                <Badge variant="outline" className={`${statusClass(e.from_status)} text-xs`}>
                                  {statusLabel(e.from_status)}
                                </Badge>
                                <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                              </>
                            ) : (
                              <span className="text-xs text-slate-400">建立訂單 →</span>
                            )}
                            <Badge variant="outline" className={`${statusClass(e.to_status)} text-xs`}>
                              {statusLabel(e.to_status)}
                            </Badge>
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                            <span>
                              <span className="text-slate-400">操作者:</span>{' '}
                              <span className="text-slate-700">{e.actor_label || '系統自動'}</span>
                              <span className="text-slate-400">
                                （{ROLE_LABEL[e.actor_role] ?? e.actor_role}）
                              </span>
                            </span>
                            <Badge
                              variant="outline"
                              className="border-slate-300 bg-slate-100 px-1.5 py-0 text-[11px] text-slate-600"
                            >
                              {SOURCE_LABEL[e.source] ?? e.source}
                            </Badge>
                          </div>

                          {e.note && (
                            <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1.5 text-sm text-slate-700">
                              {e.note}
                            </p>
                          )}

                          {attached.map((rc) => (
                            <ReceiptBlock key={rc.id} receipt={rc} />
                          ))}

                          {hasPayload && <JsonDetails label="展開附帶資料 (payload)" value={e.payload} />}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* 沒有對應事件的收貨憑證 */}
        {orphanReceipts.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-slate-700">收貨憑證</CardTitle>
            </CardHeader>
            <CardContent>
              {orphanReceipts.map((rc) => (
                <ReceiptBlock key={rc.id} receipt={rc} />
              ))}
            </CardContent>
          </Card>
        )}

        {/* 評價 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-700">餐廳評價</CardTitle>
          </CardHeader>
          <CardContent>
            {reviews.length === 0 ? (
              <p className="text-sm italic text-slate-400">這筆訂單尚未評價</p>
            ) : (
              <div className="space-y-4">
                {reviews.map((rv) => (
                  <div key={rv.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-700">整體</span>
                        <Stars value={rv.rating_overall} />
                      </div>
                      <span className="text-xs text-slate-400">
                        {new Date(rv.created_at).toLocaleString('zh-TW')}
                      </span>
                    </div>
                    <div className="grid gap-1.5 text-sm sm:grid-cols-3">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">準時</span>
                        <Stars value={rv.rating_ontime} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">品質</span>
                        <Stars value={rv.rating_quality} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">正確</span>
                        <Stars value={rv.rating_accuracy} />
                      </div>
                    </div>
                    {rv.comment && (
                      <p className="mt-2.5 whitespace-pre-wrap rounded bg-slate-50 px-2.5 py-2 text-sm text-slate-700">
                        {rv.comment}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 爭議 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-700">爭議紀錄</CardTitle>
          </CardHeader>
          <CardContent>
            {disputes.length === 0 ? (
              <p className="text-sm italic text-slate-400">這筆訂單沒有爭議紀錄</p>
            ) : (
              <div className="space-y-3">
                {disputes.map((d) => {
                  const st = DISPUTE_STATUS[d.status] ?? {
                    label: d.status,
                    className: 'bg-slate-100 text-slate-700 border-slate-300',
                  };
                  return (
                    <div key={d.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                          {DISPUTE_KIND[d.kind] ?? d.kind}
                        </Badge>
                        <Badge variant="outline" className={st.className}>
                          {st.label}
                        </Badge>
                        {d.opened_role && (
                          <span className="text-xs text-slate-500">
                            由{ROLE_LABEL[d.opened_role as ActorRole] ?? d.opened_role}提出
                          </span>
                        )}
                        <span className="ml-auto text-xs text-slate-400">
                          {new Date(d.created_at).toLocaleString('zh-TW')}
                        </span>
                      </div>
                      {d.detail && (
                        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{d.detail}</p>
                      )}
                      {d.resolution && (
                        <div className="mt-2 rounded bg-emerald-50 px-2.5 py-2">
                          <p className="text-xs text-emerald-600">處理結果</p>
                          <p className="whitespace-pre-wrap text-sm text-emerald-900">{d.resolution}</p>
                          {d.resolved_at && (
                            <p className="mt-1 text-xs text-emerald-600">
                              {new Date(d.resolved_at).toLocaleString('zh-TW')} 結案
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 提示卡 */}
        <Card className="border-slate-300 bg-slate-50">
          <CardContent className="flex gap-3 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
            <div className="space-y-1 text-sm text-slate-600">
              <p className="font-medium text-slate-700">爭議時,這一頁就是唯一的事實來源</p>
              <p>
                平台上每一次狀態變更都由系統寫入事件流(order_events)後才生效,無法事後改寫;
                因此「誰在什麼時候做了什麼、從哪個介面做的」以本頁記載為準。
              </p>
              <p className="text-slate-500">
                另外,「已收貨」只能由餐廳端確認,供應商最多只能推進到「已送達」——
                這是平台交易金額可信度的來源。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <DispatchOrderDialog order={dispatchTarget} onClose={() => setDispatchTarget(null)} onChanged={load} />
      <CancelOrderDialog order={cancelTarget} onClose={() => setCancelTarget(null)} onChanged={load} />
    </div>
  );
}
