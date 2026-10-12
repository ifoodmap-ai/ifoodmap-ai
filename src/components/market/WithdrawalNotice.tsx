// 七日鑑賞期的標示(withdrawal.ts 的文字):
// - WithdrawalExemptBadge:小標籤「不適用七日鑑賞期」(購物車、結帳、訂單明細的每一列)
// - ProductWithdrawalNotice:商品頁價格與規格旁邊的完整標示 —— 不適用:標籤 + 原因;適用:「收到後 7 天內可退貨」;都附服務條款第六條的連結
import { Link } from "react-router-dom";
import { WITHDRAWAL_EXEMPT_LABEL, WITHDRAWAL_EXEMPT_REASON, WITHDRAWAL_OK_LABEL, WITHDRAWAL_TERMS_PATH } from "@/lib/market/withdrawal";
import { MARKET_FOCUS_RING } from "./MarketLayout";

export function WithdrawalExemptBadge() {
  return (
    <span className="inline-block whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 text-xs font-medium text-amber-900">
      {WITHDRAWAL_EXEMPT_LABEL}
    </span>
  );
}

export function ProductWithdrawalNotice({ exempt }: { exempt: boolean }) {
  const link = (
    <Link to={WITHDRAWAL_TERMS_PATH} className={`inline-flex min-h-11 items-center font-medium text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
      詳見服務條款第六條
    </Link>
  );
  return exempt ? (
    <div aria-label="退貨規定" role="group" className="rounded-lg border border-amber-300 bg-amber-50 px-3 pt-2 text-sm text-amber-900">
      <p className="font-semibold">{WITHDRAWAL_EXEMPT_LABEL}</p>
      <p>{WITHDRAWAL_EXEMPT_REASON}</p>
      {link}
    </div>
  ) : (
    <div aria-label="退貨規定" role="group" className="flex flex-wrap items-center gap-x-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-sm text-emerald-900">
      <p className="py-2 font-semibold">{WITHDRAWAL_OK_LABEL}</p>
      {link}
    </div>
  );
}
