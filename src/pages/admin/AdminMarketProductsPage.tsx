// 管理後台「零售市集 › 商品審核」(/admin/market/products):待審清單(先送審的在前),可以核准、退回(填原因);
// 已上架的可以下架(= 退回並填原因,供應商改好重新送審)。審核前一定要能看到完整內容與全部照片(「查看」)。
// 樂觀鎖:供應商在你看的同時改了內容,這次審核會被擋下並要求重新整理(src/lib/market/admin.ts)。
//
// 照片:每張照片是兩個檔 —— 主圖 <uuid>.jpg(商品頁)與另外上傳的縮圖 <uuid>_t.jpg(市集首頁、店家頁的商品卡先顯示它)。
// Storage 的檔只能寫一次,核准之後換不掉,所以兩個檔都要在這裡看過。這頁刻意不用 MarketImage:它讀不到縮圖會改顯示主圖,
// 縮圖缺了(或根本是另一張圖)審核者看不出來。改用 ReviewImage:主圖、縮圖並排,讀不到就在那一格用紅框寫「讀不到…」,
// 不退回任何東西。縮圖缺檔時資料庫也會擋核准(22023 photos_not_uploaded,中文訊息在 src/lib/market/db.ts),
// 訊息除了 toast,也顯示在查看視窗裡(就在讀不到的那一格旁邊)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DELIST_REASON_MAX, fetchAdminProducts, reviewProduct, StaleReviewError, type ReviewFilter } from '@/lib/market/admin';
import { CATEGORY_LABEL, LIMITS, REVIEW_STATUS_LABEL, TEMPERATURES } from '@/lib/market/constants';
import { friendlyDbError } from '@/lib/market/db';
import { formatTaipei, formatTwd, stockLabel } from '@/lib/market/format';
import { publicImageUrl, thumbPathOf } from '@/lib/market/images';
import type { MarketProductRow } from '@/lib/market/types';

const FILTERS: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'pending', label: '待審' },
  { key: 'approved', label: '已核准' },
  { key: 'rejected', label: '退回 / 下架' },
  { key: 'draft', label: '草稿' },
  { key: 'all', label: '全部' },
];

type ReasonMode = 'reject' | 'delist';

interface ReviewImageProps {
  path: string;
  /** 替代文字;讀不到時改成「<label>:讀不到」 */
  label: string;
  /** 讀不到時那一格寫的字 */
  missingText: string;
  width: number;
  height: number;
  className: string;
}

/** 審核用的圖片:讀不到就在原位明白標出來(紅框),不像 MarketImage 會退回主圖或分類圖示。換照片時呼叫端用 key 重掛。 */
const ReviewImage = ({ path, label, missingText, width, height, className }: ReviewImageProps) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        role="img"
        aria-label={`${label}:讀不到`}
        className={`${className} flex items-center justify-center border-2 border-dashed border-red-500 bg-red-50 p-1 text-center font-medium leading-tight text-red-700`}
      >
        {missingText}
      </span>
    );
  }
  return (
    <img
      src={publicImageUrl(path)}
      alt={label}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`${className} bg-slate-100`}
    />
  );
};

const AdminMarketProductsPage = () => {
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [rows, setRows] = useState<MarketProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketProductRow | null>(null);
  /** 在查看視窗裡審核失敗的原因(例如照片沒上傳完成),顯示在視窗裡 */
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ row: MarketProductRow; mode: ReasonMode } | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    // 篩選切得快時,比較慢回來的舊查詢不能蓋掉新的:只認最後一次
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const next = await fetchAdminProducts(filter);
      if (seq !== loadSeq.current) return;
      setRows(next);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(friendlyDbError(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = (row: MarketProductRow) => {
    setDetailError(null);
    setDetail(row);
  };
  const closeDetail = () => {
    setDetail(null);
    setDetailError(null);
  };
  // 每次都從空白開始:上一個商品沒送出的原因不能帶到下一個商品
  const openReason = (row: MarketProductRow, mode: ReasonMode) => {
    setReason('');
    setReasonTarget({ row, mode });
  };

  const act = async (row: MarketProductRow, run: () => Promise<unknown>, done: string) => {
    setBusyId(row.id);
    setDetailError(null);
    try {
      await run();
      toast.success(done);
      closeDetail();
      setReasonTarget(null);
      setReason('');
      await load();
    } catch (e) {
      const message = friendlyDbError(e);
      toast.error('處理失敗', { description: message });
      if (e instanceof StaleReviewError) {
        // 供應商剛改過:視窗裡是舊內容,關掉;重新整理後的清單才是最新的,要重新查看
        closeDetail();
        setReasonTarget(null);
        setReason('');
      } else {
        setDetailError(message);
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const approve = (row: MarketProductRow) => act(row, () => reviewProduct(row, { kind: 'approve' }), `已核准「${row.name}」`);
  const submitReason = () => {
    if (!reasonTarget || !reason.trim()) return;
    const { row, mode } = reasonTarget;
    void act(row, () => reviewProduct(row, { kind: mode, reason }), mode === 'delist' ? `已下架「${row.name}」` : `已退回「${row.name}」`);
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售商品審核</h1>
      <p className="mb-4 text-sm text-slate-500">
        供應商第一次開放零售、或改了品名 / 照片 / 說明等內容,都要在這裡核准後消費者才看得到。改價格、庫存不用重審。
        <br />
        不收:酒類(免註冊結帳無法辨識年齡)、標示不實、照片不是商品本身。
      </p>

      <div role="group" aria-label="審核狀態" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'outline'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : loadError ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>商品清單載入失敗:{loadError}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
            重新載入
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">沒有{FILTERS.find((f) => f.key === filter)?.label}的商品</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
              {r.photos.length > 0 ? (
                <ReviewImage
                  key={r.photos[0]}
                  path={thumbPathOf(r.photos[0])}
                  label={`${r.name} 第 1 張・縮圖`}
                  missingText="讀不到縮圖"
                  width={64}
                  height={64}
                  className="h-16 w-16 shrink-0 rounded-md object-cover text-[11px]"
                />
              ) : (
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-slate-100 text-center text-[11px] text-slate-500">沒有照片</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">{r.name}</p>
                <p className="text-xs text-slate-500">
                  {r.market_stores?.suppliers?.name ?? '—'}・{CATEGORY_LABEL[r.category]}・{r.spec}・{formatTwd(r.price)}・送審 {formatTaipei(r.submitted_at)}
                </p>
                {r.reject_reason ? <p className="text-xs text-red-700">原因:{r.reject_reason}</p> : null}
              </div>
              <Badge variant="outline">{REVIEW_STATUS_LABEL[r.review_status]}</Badge>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => openDetail(r)} aria-label={`查看 ${r.name}`}>
                  查看
                </Button>
                {r.review_status === 'pending' ? (
                  <>
                    <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busyId === r.id} onClick={() => approve(r)} aria-label={`核准 ${r.name}`}>
                      核准
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600" onClick={() => openReason(r, 'reject')} aria-label={`退回 ${r.name}`}>
                      退回
                    </Button>
                  </>
                ) : null}
                {r.review_status === 'approved' ? (
                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => openReason(r, 'delist')} aria-label={`下架 ${r.name}`}>
                    下架
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && closeDetail()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.name}</DialogTitle>
                <DialogDescription>
                  {detail.market_stores?.suppliers?.name ?? '—'}・{REVIEW_STATUS_LABEL[detail.review_status]}
                </DialogDescription>
              </DialogHeader>
              <section aria-labelledby="market-review-photos" className="space-y-2">
                <h3 id="market-review-photos" className="text-sm font-medium text-slate-700">
                  照片({detail.photos.length} 張)
                </h3>
                {detail.photos.length === 0 ? (
                  <p className="text-sm text-red-700">沒有照片</p>
                ) : (
                  <>
                    <p className="text-xs text-slate-500">
                      每張照片有主圖和縮圖兩個檔,市集的商品卡先顯示縮圖:兩張都要看,而且要是同一張照片。紅框是讀不到的檔(多半是還沒上傳完成,核准會被擋下)。
                    </p>
                    <ul className="space-y-3">
                      {detail.photos.map((p, i) => (
                        <li key={p}>
                          <p className="mb-1 text-xs font-medium text-slate-600">第 {i + 1} 張</p>
                          <div className="grid grid-cols-2 gap-2">
                            <figure>
                              <ReviewImage
                                path={p}
                                label={`第 ${i + 1} 張・主圖`}
                                missingText="讀不到主圖"
                                width={300}
                                height={300}
                                className="aspect-square w-full rounded-md object-contain text-sm"
                              />
                              <figcaption className="mt-1 text-xs text-slate-500">主圖(商品頁)</figcaption>
                            </figure>
                            <figure>
                              <ReviewImage
                                path={thumbPathOf(p)}
                                label={`第 ${i + 1} 張・縮圖`}
                                missingText="讀不到縮圖"
                                width={300}
                                height={300}
                                className="aspect-square w-full rounded-md object-contain text-sm"
                              />
                              <figcaption className="mt-1 text-xs text-slate-500">縮圖(商品卡先顯示)</figcaption>
                            </figure>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
                {(
                  [
                    ['分類', CATEGORY_LABEL[detail.category]],
                    ['規格', detail.spec],
                    ['價格', formatTwd(detail.price)],
                    ['庫存', stockLabel(detail.stock)],
                    ['溫層', TEMPERATURES[detail.temperature]],
                    ['產地', detail.origin ?? '—'],
                    ['保存方式', detail.storage_method ?? '—'],
                    ['保存期限', detail.shelf_life ?? '—'],
                  ] as Array<[string, string]>
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="whitespace-pre-line text-sm text-slate-700">{detail.description ?? '(沒有說明)'}</p>
              {detailError ? (
                <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                  {detailError}
                </p>
              ) : null}
              {detail.review_status === 'pending' ? (
                <DialogFooter className="gap-2">
                  <Button variant="outline" className="text-red-600" onClick={() => openReason(detail, 'reject')}>
                    退回
                  </Button>
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busyId === detail.id} onClick={() => approve(detail)}>
                    核准上架
                  </Button>
                </DialogFooter>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!reasonTarget} onOpenChange={(o) => !o && setReasonTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonTarget?.mode === 'delist' ? '下架' : '退回'}「{reasonTarget?.row.name}」</DialogTitle>
            <DialogDescription>原因會顯示給供應商,供應商修改後可以重新送審。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="market-review-reason">原因(必填)</Label>
            {/* 下架會在原因前面加「(管理員下架)」,資料庫的 300 字含前綴 */}
            <Textarea
              id="market-review-reason"
              rows={3}
              maxLength={reasonTarget?.mode === 'delist' ? DELIST_REASON_MAX : LIMITS.rejectReason}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={!reason.trim() || !!busyId} onClick={submitReason}>
              {reasonTarget?.mode === 'delist' ? '確定下架' : '確定退回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketProductsPage;
