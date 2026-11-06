// 供應商「省多少錢」試算:把人工接單(看訊息、抄單、對價格、打進系統、回覆客戶)、出錯重工、對帳追單
// 每個月花掉的錢算出來,再用「導入後可以減少的比例」估算每月省下多少。
// 公式與預設值對照 OrderUp B2B「接單隱形成本計算器」的算法(月工時 176 小時);減少的比例是估算假設,畫面上可以自己調整,
// 不是承諾的成效 —— 有實際用量資料之後再回頭校正。

/** 每月工時(22 天 × 8 小時) */
export const MONTHLY_HOURS = 176;

export interface SavingsInput {
  /** 每月訂單數(張) */
  orders: number;
  /** 處理一張單的分鐘數:看訊息、抄單、對價格、打進系統、回覆客戶全部加起來 */
  minutesPerOrder: number;
  /** 內勤月薪(含勞健保) */
  monthlySalary: number;
  /** 訂單出錯率(%):品項、數量、價格、送貨地點任何一項要重來的單 */
  errorRatePct: number;
  /** 每次出錯的處理成本:重新出貨運費、退貨、折讓與溝通時間 */
  costPerError: number;
  /** 每月對帳與追單時數 */
  reconcileHours: number;
  /** 使用平台每月要付的費用(沒有就 0),從省下的錢裡扣掉算淨效益 */
  platformFee: number;
}

export interface Reductions {
  /** 打單與回覆時間可以減少的比例(%) */
  timePct: number;
  /** 出錯與重工可以減少的比例(%) */
  errorPct: number;
  /** 對帳與追單時間可以減少的比例(%) */
  reconcilePct: number;
}

/** 現在怎麼接單 → 處理一張單大約幾分鐘(一般批發商常見情況,電話最久) */
export const ORDER_METHODS = [
  { key: "line", label: "收到 LINE 文字後人工打單", minutes: 8 },
  { key: "phone", label: "接電話後人工打單", minutes: 12 },
  { key: "other", label: "其他(傳真、手寫單、Email)", minutes: 10 },
] as const;
export type OrderMethodKey = (typeof ORDER_METHODS)[number]["key"];

/** 預設:LINE 接單、400 張、月薪 4 萬、出錯率 8%;對帳追單時數預設 0(要算的人到進階裡自己填) */
export const DEFAULT_INPUT: SavingsInput = {
  orders: 400,
  minutesPerOrder: 8,
  monthlySalary: 40000,
  errorRatePct: 8,
  costPerError: 600,
  reconcileHours: 0,
  platformFee: 0,
};

/** 預設保守一點(各 50%);OrderUp 公布的客戶常見成效是 50 / 80 / 60,這裡不照抄 */
export const DEFAULT_REDUCTIONS: Reductions = { timePct: 50, errorPct: 50, reconcilePct: 50 };

export interface SavingsResult {
  hourlyCost: number;
  /** 目前每月成本 */
  cost: { typing: number; errors: number; reconcile: number; total: number };
  yearlyCost: number;
  /** 每月花在接單的時間(小時)與相當於幾位全職內勤 */
  hours: number;
  fte: number;
  /** 每月可以省下 */
  saved: { typing: number; errors: number; reconcile: number; total: number };
  /** 每月淨效益 = 省下的 − 平台費用 */
  net: number;
  netYearly: number;
}

const num = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
const pct = (v: number) => Math.min(100, num(v)) / 100;

export const calcSavings = (input: SavingsInput, red: Reductions = DEFAULT_REDUCTIONS): SavingsResult => {
  const orders = num(input.orders);
  const hourlyCost = num(input.monthlySalary) / MONTHLY_HOURS;
  const typingHours = (orders * num(input.minutesPerOrder)) / 60;
  const reconcileHours = num(input.reconcileHours);

  const cost = {
    typing: typingHours * hourlyCost,
    errors: orders * pct(input.errorRatePct) * num(input.costPerError),
    reconcile: reconcileHours * hourlyCost,
    total: 0,
  };
  cost.total = cost.typing + cost.errors + cost.reconcile;

  const saved = {
    typing: cost.typing * pct(red.timePct),
    errors: cost.errors * pct(red.errorPct),
    reconcile: cost.reconcile * pct(red.reconcilePct),
    total: 0,
  };
  saved.total = saved.typing + saved.errors + saved.reconcile;

  const hours = typingHours + reconcileHours;
  const net = saved.total - num(input.platformFee);
  return {
    hourlyCost,
    cost,
    yearlyCost: cost.total * 12,
    hours,
    fte: hours / MONTHLY_HOURS,
    saved,
    net,
    netYearly: net * 12,
  };
};
