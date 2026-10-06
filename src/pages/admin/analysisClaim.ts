// AI 分析紀錄被「註冊認領」後的顯示(SPEC §6:claim_landing_analysis 會押 claimed_at / claimed_order_id)。
//
// 被認領的紀錄 status 仍是 pending_review,但已經不算待審(見 adminCounts.ts 的 applyPendingAnalysisFilter)——
// 列表與明細一律用這裡的標籤取代「待審核」,三個地方(今日待辦、列表、明細)口徑一致。

export interface ClaimFields {
  claimed_at?: string | null;
  claimed_order_id?: string | null;
}

/** 認領時 RPC 寫進採購單草稿的備註(SPEC §6),訂單頁靠它反查來源分析 */
export const CLAIMED_ORDER_NOTE = 'AI 採購助手帶入';

export const isClaimed = (record: ClaimFields): boolean => !!record.claimed_at;

/** 列表與明細標題旁的標籤 */
export const claimedBadgeLabel = (record: ClaimFields): string =>
  record.claimed_order_id ? '已轉採購單' : '已註冊帶入';

export const CLAIMED_BADGE_CLASS = 'bg-emerald-100 text-emerald-800 border-emerald-300';

/** 明細頁的說明句 */
export const claimedSummary = (record: ClaimFields): string =>
  record.claimed_order_id
    ? '已由註冊帶入，轉成採購單草稿'
    : '已由註冊帶入（沒有辨識到食材，沒有建立採購單）';
