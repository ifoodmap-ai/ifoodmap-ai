// 管理員後台的「待辦計數」查詢 —— 總覽「今日待辦」與「會員 › 入駐審核」分頁的待審數字共用這一份,
// 同一個數字只有一個定義,不會兩個地方各算各的(業主嫌「重複」正是從這種地方長出來的)。
//
// 四個數字的定義:
//   卡關訂單  進行中的訂單(order_pipeline view;view 不能用時退回查 supplier_orders 的進行中狀態),
//            在目前階段停留超過該階段的處理時限 SLA(src/lib/orders.ts 的 ORDER_STATUS.slaHours:
//            待派發 12 小時、待接單/待報價 24 小時、待確認/待出貨/運送中 48 小時、待收貨 72 小時、
//            收貨有差異 24 小時、爭議中 48 小時;草稿、已評價等沒有 SLA 的狀態永遠不算卡關)。
//            這跟「訂單 › 看板」頁上的「卡關筆數」是同一個判斷(isStuck),點過去看到的數字會對得上。
//   待審入駐  supplier_applications.status = 'pending'
//   未結爭議  disputes.status in ('open', 'investigating') —— 跟爭議頁 KPI「未結案」同一個定義
//   待審分析  analysis_records.status = 'pending_review' 且 claimed_at is null
//            (形象站訪客註冊後已被認領、轉成採購單草稿的不算待審 —— 跟「分析紀錄」列表的「待審核」分頁同一個定義,
//            兩邊都呼叫 applyPendingAnalysisFilter)
//
// 全部用管理員既有的 RLS 權限讀(is_admin()),不新增任何資料庫物件;
// 三個純計數用 head:true + count:'exact',只回筆數、不回資料。

import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { PIPELINE_STAGES, isStuck, type OrderStatus } from '@/lib/orders';

/* ---------------------------------------------------------------
 * 這幾張表還沒進 types.ts,沿用專案既有的 cast 慣例,只描述這裡用得到的那一小段 builder
 * ------------------------------------------------------------- */
type PgError = { message: string } | null;
type CountResult = { count: number | null; error: PgError };
type RowsResult<T> = { data: T[] | null; error: PgError };

interface CountQuery extends PromiseLike<CountResult> {
  eq(col: string, v: unknown): CountQuery;
  in(col: string, v: readonly unknown[]): CountQuery;
  is(col: string, v: null): CountQuery;
}

interface RowsQuery<T> extends PromiseLike<RowsResult<T>> {
  in(col: string, v: readonly unknown[]): RowsQuery<T>;
}

const countOf = (table: string) =>
  (supabase as never as {
    from: (t: string) => { select: (c: string, o: { count: 'exact'; head: true }) => CountQuery };
  })
    .from(table)
    .select('id', { count: 'exact', head: true });

const rowsOf = <T,>(table: string, columns: string) =>
  (supabase as never as {
    from: (t: string) => { select: (c: string) => RowsQuery<T> };
  })
    .from(table)
    .select(columns);

/** 查詢失敗或拿不到筆數都丟錯 —— 呼叫端要能分辨「0 筆」與「不知道幾筆」,不然失敗會被顯示成 0 */
const unwrapCount = ({ count, error }: CountResult): number => {
  if (error) throw new Error(error.message || '查詢失敗');
  if (count == null) throw new Error('沒有拿到筆數');
  return count;
};

/**
 * 沒有 order_pipeline view 時的後備查詢範圍 —— 「訂單 › 看板」頁也用這一份,兩邊不會各自漂移。
 * (舊狀態 pending/sent 併在裡面,是相容 7/26 改版前的舊訂單)
 */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  ...PIPELINE_STAGES,
  'pending',
  'sent',
  'discrepancy',
  'disputed',
];

interface StageRow {
  id: string;
  status: OrderStatus;
  current_stage_since: string | null;
}

/** 卡關訂單數(定義見檔頭) */
export const fetchStuckOrderCount = async (): Promise<number> => {
  const columns = 'id, status, current_stage_since';
  let res = await rowsOf<StageRow>('order_pipeline', columns);
  if (res.error) {
    res = await rowsOf<StageRow>('supplier_orders', columns).in('status', ACTIVE_ORDER_STATUSES);
    if (res.error) throw new Error(res.error.message || '查詢失敗');
  }
  return (res.data ?? []).filter((row) => isStuck(row.status, row.current_stage_since)).length;
};

/** 待審入駐數:supplier_applications.status = 'pending' */
export const fetchPendingApplicationCount = async (): Promise<number> =>
  unwrapCount(await countOf('supplier_applications').eq('status', 'pending'));

/** 未結爭議數:disputes.status in ('open','investigating') */
export const OPEN_DISPUTE_STATUSES = ['open', 'investigating'] as const;

export const fetchOpenDisputeCount = async (): Promise<number> =>
  unwrapCount(await countOf('disputes').in('status', OPEN_DISPUTE_STATUSES));

/**
 * 「待審分析」的篩選條件(唯一定義):還在 pending_review、而且還沒被註冊認領(claimed_at is null)。
 * 今日待辦的計數與「分析紀錄」列表的「待審核」分頁共用這一份。
 */
export const applyPendingAnalysisFilter = <Q extends { eq(col: string, v: unknown): Q; is(col: string, v: null): Q }>(
  query: Q,
): Q => query.eq('status', 'pending_review').is('claimed_at', null);

/** 待審分析數(定義見 applyPendingAnalysisFilter) */
export const fetchPendingAnalysisCount = async (): Promise<number> =>
  unwrapCount(await applyPendingAnalysisFilter(countOf('analysis_records')));

/** 停在會員分區時,多久自動重查一次待審數 */
export const PENDING_APPLICATIONS_REFRESH_MS = 30_000;

/**
 * 「會員 › 入駐審核」分頁標題上的待審數。
 * 只在 enabled(目前停在會員分區、分頁列看得到)時查。什麼時候重查:
 *   - refreshKey(目前路由)改變:在會員分區裡切分頁就更新
 *   - 視窗重新拿到焦點、分頁從背景切回來
 *   - 停在會員分區時每 30 秒一次(分頁在背景時不查)——入駐審核頁核准/退件是原地完成、不換網址,
 *     靠這個讓分頁上的數字跟著變,不會一直停在審核前的數字
 * 查詢失敗回 null —— 分頁就只顯示名稱,不顯示錯的數字。
 */
export const usePendingApplicationCount = (enabled: boolean, refreshKey: string): number | null => {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // 請求序號:同時有兩個請求在路上(例如輪詢剛送出、使用者又切回分頁)時,只採用最後送出的那個 ——
    // 不然比較早送出、比較晚回來的舊數字會把新數字蓋掉
    let latest = 0;
    const load = () => {
      const id = ++latest;
      const isCurrent = () => !cancelled && id === latest;
      fetchPendingApplicationCount()
        .then((n) => {
          if (isCurrent()) setCount(n);
        })
        .catch(() => {
          if (isCurrent()) setCount(null);
        });
    };
    const loadIfVisible = () => {
      if (document.visibilityState !== 'hidden') load();
    };

    load();
    window.addEventListener('focus', loadIfVisible);
    document.addEventListener('visibilitychange', loadIfVisible);
    const timer = window.setInterval(loadIfVisible, PENDING_APPLICATIONS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', loadIfVisible);
      document.removeEventListener('visibilitychange', loadIfVisible);
      window.clearInterval(timer);
    };
  }, [enabled, refreshKey]);

  return enabled ? count : null;
};
