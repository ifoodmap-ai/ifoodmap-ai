// 七日解除權(俗稱七日鑑賞期)的逐項標示文字:商品頁、購物車、結帳、訂單查詢共用(法規查證報告 M3 的 A 方案)。
// 🔴 WITHDRAWAL_EXEMPT_LABEL 就是服務條款第六條第 2 段引用的「商品頁標示」:準則 §2 要先告知才能排除,
//    畫面上的字跟條款引用的字不一樣,例外可能不成立。改這裡就要改 legal.ts(withdrawal.test.ts 會對照)。
// 商品的 withdrawal_exempt(店家上架時選、管理員審核):true = 不適用;false、沒有這個欄位的舊資料 = 適用。
export const WITHDRAWAL_EXEMPT_LABEL = "不適用七日鑑賞期";
// 只寫「收到後」再接天數,會被讀成比法定少一天(消保法 §19 的 7 日從收到的隔天起算),一律寫「收到隔天起」;withdrawal.test.ts 掃消費者頁面
export const WITHDRAWAL_OK_LABEL = "收到隔天起 7 天內可退貨";
export const WITHDRAWAL_EXEMPT_REASON = "這項商品易腐敗、保存期限較短或到貨時已接近到期,依法不能無理由退貨;商品有瑕疵時,仍可以向店家要求處理。";
/** 服務條款第六條的固定錨點(legal.ts 的 id: "withdrawal") */
export const WITHDRAWAL_TERMS_PATH = "/market/terms#withdrawal";

export const isWithdrawalExempt = (p: { withdrawal_exempt?: boolean | null }): boolean => p.withdrawal_exempt === true;
