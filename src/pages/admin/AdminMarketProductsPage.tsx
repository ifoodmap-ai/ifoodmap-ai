// 管理後台「零售市集 › 商品審核」(/admin/market/products):待審清單(先送審的在前),可以核准、退回(填原因);
// 已上架的可以下架(= 退回並填原因,供應商改好重新送審)。核准只能在「查看」視窗裡做:清單上沒有核准鈕,
// 從清單核准的話,第 2–5 張照片和所有主圖都沒看到。
// 樂觀鎖:供應商在你看的同時改了內容,核准 / 退回會被擋下並要求重新整理(src/lib/market/admin.ts;下架不鎖)。
//
// 照片:每張照片是兩個檔 —— 主圖 <uuid>.jpg(商品頁)與另外上傳的縮圖 <uuid>_t.jpg(市集首頁、店家頁的商品卡先顯示它)。
// Storage 的檔只能寫一次,核准之後換不掉,所以兩個檔都要在這裡看過。這頁刻意不用 MarketImage:它讀不到縮圖會改顯示主圖,
// 縮圖缺了(或根本是另一張圖)審核者看不出來。改用 ReviewImage:主圖、縮圖並排,讀不到就在那一格用紅框寫「讀不到…」,
// 不退回任何東西。查看視窗的圖立即載入(不延遲),**每張主圖和縮圖都載入成功**「核准上架」才按得下去 ——
// 載入中、讀不到都不行:紅框還在(或還沒載入完)時能按的話,供應商這時才補傳(可能是另一張圖),
// 就核准了審核者沒看過的檔。補傳後要關掉重開(ReviewDetail 每次打開都重新掛上、圖重新載入)、全部看得到才能核准。
// 縮圖缺檔時資料庫也會擋核准(22023 photos_not_uploaded,中文訊息在 src/lib/market/db.ts),訊息除了 toast,
// 也顯示在查看視窗裡。
//
// 清單分頁(一頁 ADMIN_PAGE_SIZE 筆)加品名搜尋:已核准的商品再多,較舊的也找得到、下得了架。
//
// 法規(食材市集法規查證 M3、M8、S3、S4):查看視窗最上面醒目標示「適用 / 不適用七日鑑賞期」(店家勾選,例外要從嚴認定),
// 清單上不適用的商品也標出來;審核檢查清單(admin.ts 的 reviewChecklist:食品資訊、不是酒類、沒有違法字句,不適用七日
// 鑑賞期的再加「確實是易腐或短效商品」)每一項都打勾才能核准;reviewWarnings 自動提醒要特別看的字句(只是提醒)。
import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  ADMIN_LOAD_FALLBACK,
  ADMIN_PAGE_SIZE,
  ADMIN_REVIEW_FALLBACK,
  adminErrorMessage,
  DELIST_REASON_MAX,
  fetchAdminProducts,
  MarketStaleReviewError,
  reviewChecklist,
  reviewProduct,
  reviewWarnings,
  type ReviewFilter,
} from '@/lib/market/admin';
import { CATEGORY_LABEL, LIMITS, REVIEW_STATUS_LABEL, TEMPERATURES } from '@/lib/market/constants';
import { formatTaipei, formatTwd, stockLabel } from '@/lib/market/format';
import { hasVisibleText } from '@/lib/market/productForm';
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
  missingText: ReactNode;
  width: number;
  height: number;
  className: string;
  /** 立即載入(查看視窗);清單的小縮圖用延遲載入 */
  eager?: boolean;
  /** 載入成功 / 讀不到時通知呼叫端(查看視窗用來決定能不能核准) */
  onLoad?: () => void;
  onFail?: () => void;
}

/** 審核用的圖片:讀不到就在原位明白標出來(紅框),不像 MarketImage 會退回主圖或分類圖示。換照片時呼叫端用 key 重掛。 */
const ReviewImage = ({ path, label, missingText, width, height, className, eager = false, onLoad, onFail }: ReviewImageProps) => {
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
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={onLoad}
      onError={() => {
        setFailed(true);
        onFail?.();
      }}
      className={`${className} bg-slate-100`}
    />
  );
};

interface ReviewDetailProps {
  row: MarketProductRow;
  /** 這次審核失敗的原因(例如照片沒上傳完成) */
  error: string | null;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * 查看視窗的內容:完整欄位與每張照片的主圖、縮圖。呼叫端每次打開視窗都給新的 key(重新掛上 = 每張圖重新載入、
 * 載入結果歸零;Radix 的關閉動畫還沒跑完就重開同一個商品時,沒有 key 的話圖不會再觸發 load,核准會永遠按不下去)。
 */
const ReviewDetail = ({ row, error, busy, onApprove, onReject }: ReviewDetailProps) => {
  const [loaded, setLoaded] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const mark = (set: Dispatch<SetStateAction<string[]>>) => (file: string) =>
    set((files) => (files.includes(file) ? files : [...files, file]));
  const markLoaded = mark(setLoaded);
  const markFailed = mark(setFailed);
  const files = row.photos.flatMap((p) => [p, thumbPathOf(p)]);
  const allLoaded = files.every((f) => loaded.includes(f));
  const pending = row.review_status === 'pending';
  const exempt = !!row.withdrawal_exempt;
  const checklist = reviewChecklist(row);
  const warnings = reviewWarnings(row);
  /** 打勾的檢查項目(每次打開都重新掛上 = 從頭勾) */
  const [checked, setChecked] = useState<string[]>([]);
  const allChecked = checklist.every((item) => checked.includes(item.key));
  const toggle = (key: string) => setChecked((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{row.name}</DialogTitle>
        <DialogDescription>
          {row.market_stores?.suppliers?.name ?? '—'}・{REVIEW_STATUS_LABEL[row.review_status]}
        </DialogDescription>
      </DialogHeader>
      <p
        className={
          exempt
            ? 'rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm font-semibold text-amber-900'
            : 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900'
        }
      >
        {exempt ? '不適用七日鑑賞期(店家勾選:消費者不能無理由退貨)' : '適用七日鑑賞期(消費者收到後 7 天內可以退貨)'}
      </p>
      <section aria-labelledby="market-review-photos" className="space-y-2">
        <h3 id="market-review-photos" className="text-sm font-medium text-slate-700">
          照片({row.photos.length} 張)
        </h3>
        {row.photos.length === 0 ? (
          <p className="text-sm text-red-700">沒有照片</p>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              每張照片有主圖和縮圖兩個檔,市集的商品卡先顯示縮圖:兩張都要看,而且要是同一張照片。每個檔都載入成功才能核准;紅框是讀不到的檔(多半是還沒上傳完成)。
            </p>
            <ul className="space-y-3">
              {row.photos.map((p, i) => (
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
                        eager
                        onLoad={() => markLoaded(p)}
                        onFail={() => markFailed(p)}
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
                        eager
                        onLoad={() => markLoaded(thumbPathOf(p))}
                        onFail={() => markFailed(thumbPathOf(p))}
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
            ['分類', CATEGORY_LABEL[row.category]],
            ['規格', row.spec],
            ['價格', formatTwd(row.price)],
            ['庫存', stockLabel(row.stock)],
            ['溫層', TEMPERATURES[row.temperature]],
            ['產地', row.origin ?? '—'],
            ['保存方式', row.storage_method ?? '—'],
            ['保存期限', row.shelf_life ?? '—'],
            ['七日鑑賞期', exempt ? '不適用' : '適用'],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="whitespace-pre-line text-sm text-slate-700">{row.description ?? '(沒有說明)'}</p>
      {warnings.length > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p id="market-review-warnings" className="font-medium">
            自動偵測到要特別看的字句(只是提醒,仍要逐項確認)
          </p>
          <ul aria-label="自動偵測到要特別看的字句" className="mt-1 list-disc space-y-0.5 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {pending ? (
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-700">審核檢查清單(每一項都確認才能核准)</legend>
          <div className="space-y-1">
            {checklist.map((item) => (
              <label key={item.key} className="flex min-h-11 items-start gap-2 py-1 text-sm text-slate-700">
                <input type="checkbox" checked={checked.includes(item.key)} onChange={() => toggle(item.key)} className="mt-0.5 h-5 w-5 shrink-0" />
                {item.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {pending && failed.length > 0 ? (
        <p className="text-sm text-red-700">
          有 {failed.length} 個檔讀不到,不能核准:可以先退回請供應商補傳;補傳後關掉這個視窗重新查看,每張都看得到才能核准。
        </p>
      ) : pending && !allLoaded ? (
        <p className="text-sm text-slate-600">照片載入中,每張主圖和縮圖都載入完成才能核准</p>
      ) : null}
      {pending && !allChecked ? <p className="text-sm text-slate-600">檢查清單每一項都確認後才能核准</p> : null}
      {pending ? (
        <DialogFooter className="gap-2">
          <Button variant="outline" className="text-red-600" onClick={onReject}>
            退回
          </Button>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy || !allLoaded || !allChecked} onClick={onApprove}>
            核准上架
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
};

const AdminMarketProductsPage = () => {
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [page, setPage] = useState(0);
  /** 送出的搜尋字(按「搜尋」才算);searchInput 是輸入框裡正在打的 */
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [rows, setRows] = useState<MarketProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 審核結果回來時,開著的視窗可能已經換成別的商品:結果只作用在同一個商品(以下都用 row.id 比對)。
  /** 開著的查看視窗;session 每次打開都換新(ReviewDetail 的 key);error 是這個商品審核失敗的原因 */
  const [detail, setDetail] = useState<{ row: MarketProductRow; session: number; error: string | null } | null>(null);
  const detailSession = useRef(0);
  /** 開著的退回 / 下架視窗與打到一半的原因 */
  const [reasonDraft, setReasonDraft] = useState<{ row: MarketProductRow; mode: ReasonMode; text: string } | null>(null);
  /** 審核送出中的商品(可以同時有好幾個) */
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const loadSeq = useRef(0);
  // load 一律讀「現在」的篩選、頁數、搜尋字:審核完的重抓用的是按下按鈕那次 render 的 load,
  // 那之後才切了篩選的話,照閉包裡的舊篩選重抓會把清單換回舊分頁的內容
  const queryRef = useRef({ filter, page, search });

  const load = useCallback(async () => {
    // 篩選切得快時,比較慢回來的舊查詢不能蓋掉新的:只認最後一次
    const seq = ++loadSeq.current;
    const query = queryRef.current;
    let movedPage = false;
    setLoading(true);
    try {
      const res = await fetchAdminProducts(query.filter, { page: query.page, search: query.search });
      if (seq !== loadSeq.current) return;
      // 這一頁空了(例如審核完最後一頁只剩的那一筆)→ 換到最後一個有東西的頁(換頁會再觸發一次 load)
      const lastPage = Math.max(0, Math.ceil(res.total / ADMIN_PAGE_SIZE) - 1);
      if (res.rows.length === 0 && query.page > lastPage) {
        movedPage = true;
        setPage(lastPage);
        return;
      }
      setRows(res.rows);
      setTotal(res.total);
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(adminErrorMessage(e, ADMIN_LOAD_FALLBACK));
    } finally {
      if (seq === loadSeq.current && !movedPage) setLoading(false);
    }
  }, []);

  useEffect(() => {
    queryRef.current = { filter, page, search };
    void load();
  }, [filter, page, search, load]);

  const chooseFilter = (next: ReviewFilter) => {
    setFilter(next);
    setPage(0);
  };
  const submitSearch = (term: string) => {
    setSearchInput(term);
    setSearch(term.trim());
    setPage(0);
  };
  const filterLabel = FILTERS.find((f) => f.key === filter)?.label;
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));

  const openDetail = (row: MarketProductRow) => {
    detailSession.current += 1;
    setDetail({ row, session: detailSession.current, error: null });
  };
  const closeDetail = () => setDetail(null);
  /** 只改「同一個商品」的視窗;開著的是別的商品就不動 */
  const forDetailOf = (id: string, change: (d: NonNullable<typeof detail>) => typeof detail) =>
    setDetail((d) => (d && d.row.id === id ? change(d) : d));
  const closeReasonOf = (id: string) => setReasonDraft((r) => (r && r.row.id === id ? null : r));
  // 每次都從空白開始:上一個商品沒送出的原因不能帶到下一個商品
  const openReason = (row: MarketProductRow, mode: ReasonMode) => setReasonDraft({ row, mode, text: '' });

  const act = async (row: MarketProductRow, run: () => Promise<unknown>, done: string) => {
    setBusyIds((ids) => [...ids, row.id]);
    forDetailOf(row.id, (d) => ({ ...d, error: null }));
    try {
      await run();
      toast.success(done);
      forDetailOf(row.id, () => null);
      closeReasonOf(row.id);
      await load();
    } catch (e) {
      const message = adminErrorMessage(e, ADMIN_REVIEW_FALLBACK);
      toast.error('處理失敗', { description: message });
      if (e instanceof MarketStaleReviewError) {
        // 供應商剛改過:視窗裡是舊內容,關掉;重新整理後的清單才是最新的,要重新查看
        forDetailOf(row.id, () => null);
        closeReasonOf(row.id);
      } else {
        forDetailOf(row.id, (d) => ({ ...d, error: message }));
      }
      await load();
    } finally {
      setBusyIds((ids) => {
        const i = ids.indexOf(row.id);
        return i < 0 ? ids : [...ids.slice(0, i), ...ids.slice(i + 1)];
      });
    }
  };

  const approve = (row: MarketProductRow) => act(row, () => reviewProduct(row, { kind: 'approve' }), `已核准「${row.name}」`);
  const submitReason = () => {
    if (!reasonDraft || !hasVisibleText(reasonDraft.text)) return;
    const { row, mode, text } = reasonDraft;
    void act(row, () => reviewProduct(row, { kind: mode, reason: text }), mode === 'delist' ? `已下架「${row.name}」` : `已退回「${row.name}」`);
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售商品審核</h1>
      <p className="mb-4 text-sm text-slate-500">
        供應商第一次開放零售、或改了品名 / 照片 / 說明等內容,都要在這裡核准後消費者才看得到。改價格、庫存不用重審。
        <br />
        不收:酒類(包括料理米酒、料理酒;菸酒管理法禁止網路販售)、標示不實、照片不是商品本身。
      </p>

      <div role="group" aria-label="審核狀態" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'outline'} aria-pressed={filter === f.key} onClick={() => chooseFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      <form
        role="search"
        aria-label="搜尋商品"
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch(searchInput);
        }}
      >
        <Input
          type="search"
          aria-label="搜尋品名"
          placeholder="搜尋品名"
          maxLength={LIMITS.productName}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-9 min-w-0 flex-1 sm:max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline">
          搜尋
        </Button>
        {search ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => submitSearch('')}>
            清除搜尋
          </Button>
        ) : null}
      </form>

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
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">
          {search ? `${filterLabel}裡找不到品名含「${search}」的商品` : `沒有${filterLabel}的商品`}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
                {r.photos.length > 0 ? (
                  <ReviewImage
                    key={r.photos[0]}
                    path={thumbPathOf(r.photos[0])}
                    label={`${r.name} 第 1 張・縮圖`}
                    missingText={
                      <>
                        讀不到
                        <br />
                        縮圖
                      </>
                    }
                    width={64}
                    height={64}
                    className="h-16 w-16 shrink-0 rounded-md object-cover text-[11px]"
                  />
                ) : (
                  <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-slate-100 text-center text-[11px] text-slate-500">沒有照片</span>
                )}
                {/* 至少 10rem:窄螢幕上狀態與按鈕放不下時換到下一行,品名欄才不會被擠成一兩個字一行 */}
                <div className="min-w-[10rem] flex-1">
                  <p className="font-medium text-slate-800">{r.name}</p>
                  <p className="text-xs text-slate-500">
                    {r.market_stores?.suppliers?.name ?? '—'}・{CATEGORY_LABEL[r.category]}・{r.spec}・{formatTwd(r.price)}・送審 {formatTaipei(r.submitted_at)}
                  </p>
                  {r.reject_reason ? <p className="text-xs text-red-700">原因:{r.reject_reason}</p> : null}
                </div>
                {r.withdrawal_exempt ? (
                  <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-900">
                    不適用七日鑑賞期
                  </Badge>
                ) : null}
                <Badge variant="outline">{REVIEW_STATUS_LABEL[r.review_status]}</Badge>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => openDetail(r)} aria-label={`查看 ${r.name}`}>
                    查看
                  </Button>
                  {/* 核准只在查看視窗裡(要看過每張主圖和縮圖) */}
                  {r.review_status === 'pending' ? (
                    <Button size="sm" variant="outline" className="text-red-600" onClick={() => openReason(r, 'reject')} aria-label={`退回 ${r.name}`}>
                      退回
                    </Button>
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
          <nav aria-label="清單分頁" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
            <p>
              第 {page + 1} / {pageCount} 頁・共 {total.toLocaleString('zh-TW')} 筆
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                上一頁
              </Button>
              <Button size="sm" variant="outline" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
                下一頁
              </Button>
            </div>
          </nav>
        </>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && closeDetail()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail ? (
            <ReviewDetail
              key={detail.session}
              row={detail.row}
              error={detail.error}
              busy={busyIds.includes(detail.row.id)}
              onApprove={() => approve(detail.row)}
              onReject={() => openReason(detail.row, 'reject')}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!reasonDraft} onOpenChange={(o) => !o && setReasonDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonDraft?.mode === 'delist' ? '下架' : '退回'}「{reasonDraft?.row.name}」</DialogTitle>
            <DialogDescription>原因會顯示給供應商,供應商修改後可以重新送審。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="market-review-reason">原因(必填)</Label>
            {/* 下架會在原因前面加「(管理員下架)」,資料庫的 300 字含前綴 */}
            <Textarea
              id="market-review-reason"
              rows={3}
              maxLength={reasonDraft?.mode === 'delist' ? DELIST_REASON_MAX : LIMITS.rejectReason}
              value={reasonDraft?.text ?? ''}
              onChange={(e) => {
                const text = e.target.value;
                setReasonDraft((r) => (r ? { ...r, text } : r));
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonDraft(null)}>
              取消
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={!reasonDraft || !hasVisibleText(reasonDraft.text) || busyIds.includes(reasonDraft.row.id)}
              onClick={submitReason}
            >
              {reasonDraft?.mode === 'delist' ? '確定下架' : '確定退回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketProductsPage;
