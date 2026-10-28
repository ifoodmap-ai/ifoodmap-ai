// 配送日與截單時間(supabase/migrations/20261029100000_delivery_date_and_cutoff.sql)的前端共用邏輯:
// 供應商的接單規則(截單時間、提前幾天截單、哪幾天配送)、算出最早能選的配送日、說明文字。
// 資料庫才是真正的守門員(叫貨時再檢查一次);這裡只是讓畫面不要讓人選到一定會被擋下的日期。
// 時間一律用台灣時區(Asia/Taipei),跟資料庫一樣 —— 不管使用者的電腦設在哪個時區。

export interface OrderRules {
  /** HH:MM 或 HH:MM:SS */
  cutoff_time: string;
  /** 提前幾天截單:1 = 配送日前一天的截單時間之前要下單;0 = 當天截單 */
  lead_days: number;
  /** 0 = 週日 … 6 = 週六 */
  delivery_weekdays: number[];
}

export const DEFAULT_RULES: OrderRules = {
  cutoff_time: "22:00",
  lead_days: 1,
  delivery_weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const WEEKDAY_LABEL = ["日", "一", "二", "三", "四", "五", "六"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 台灣現在的日期與時間(YYYY-MM-DD、HH:MM) */
export const taipeiNow = (now: Date = new Date()): { date: string; time: string } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
};

const parse = (s: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};

const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

export const isDateString = (s: string): boolean => {
  const d = parse(s);
  return !Number.isNaN(d.getTime()) && fmt(d) === s;
};

export const addDays = (date: string, n: number): string => fmt(new Date(parse(date).getTime() + n * 86_400_000));

/** 星期幾(0 = 週日 … 6 = 週六) */
export const weekdayOf = (date: string): number => parse(date).getUTCDay();

/** HH:MM(丟掉秒) */
export const hhmm = (t: string): string => t.slice(0, 5);

/** 這個配送日的截單時刻:(配送日 − 提前天數) 的截單時間(台灣) */
export const cutoffFor = (date: string, rules: OrderRules): { date: string; time: string } => ({
  date: addDays(date, -rules.lead_days),
  time: hhmm(rules.cutoff_time),
});

export type DeliveryCheck = "ok" | "required" | "invalid" | "past" | "weekday" | "cutoff";

/**
 * 這個配送日能不能叫貨(跟資料庫 guard_restaurant_direct_dispatch 同一套規則):
 * 不能是過去的日子;有接單規則的話,一定要選、那天要有配送、還沒超過截單時間。
 * rules = null 代表這家供應商沒設規則:配送日可有可無。
 */
export const checkDeliveryDate = (date: string, rules: OrderRules | null, now: Date = new Date()): DeliveryCheck => {
  if (!date) return rules ? "required" : "ok";
  if (!isDateString(date)) return "invalid";
  const t = taipeiNow(now);
  if (date < t.date) return "past";
  if (!rules) return "ok";
  if (!rules.delivery_weekdays.includes(weekdayOf(date))) return "weekday";
  const cut = cutoffFor(date, rules);
  if (t.date > cut.date || (t.date === cut.date && t.time > cut.time)) return "cutoff";
  return "ok";
};

/** 最早能選的配送日(從今天往後找 60 天);規則設得找不到就回 null */
export const earliestDeliveryDate = (rules: OrderRules | null, now: Date = new Date()): string | null => {
  const today = taipeiNow(now).date;
  for (let i = 0; i < 60; i += 1) {
    const d = addDays(today, i);
    if (checkDeliveryDate(d, rules, now) === "ok") return d;
  }
  return null;
};

export const DELIVERY_CHECK_MESSAGE: Readonly<Record<Exclude<DeliveryCheck, "ok">, string>> = {
  required: "請先選擇配送日期",
  invalid: "配送日期格式不正確",
  past: "配送日不能早於今天",
  weekday: "這家供應商這一天不配送,請改選其他日期",
  cutoff: "已經超過這個配送日的截單時間,請改選之後的日期",
};

const weekdaysText = (days: number[]): string => {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "每天配送";
  // 連續的幾天合併成「週一至週五」
  const runs: number[][] = [];
  sorted.forEach((d) => {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  });
  const text = runs
    .map((r) => (r.length >= 3 ? `週${WEEKDAY_LABEL[r[0]]}至週${WEEKDAY_LABEL[r[r.length - 1]]}` : r.map((d) => `週${WEEKDAY_LABEL[d]}`).join("、")))
    .join("、");
  return `${text}配送`;
};

/** 給人看的規則說明:「配送日前 1 天 22:00 截單 · 週一至週六配送」 */
export const describeRules = (rules: OrderRules): string => {
  const lead = rules.lead_days === 0 ? "配送當天" : `配送日前 ${rules.lead_days} 天`;
  return `${lead} ${hhmm(rules.cutoff_time)} 截單 · ${weekdaysText(rules.delivery_weekdays)}`;
};

/** 訂單卡片上的配送日:2026-10-30(週五) */
export const deliveryLabel = (date: string | null | undefined): string | null =>
  date && isDateString(date) ? `${date}(週${WEEKDAY_LABEL[weekdayOf(date)]})` : null;
