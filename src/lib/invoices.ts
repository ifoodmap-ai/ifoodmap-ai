// 供應商請款單(supabase/migrations/20261022100000_supplier_invoices.sql)的前端共用邏輯:
// 狀態與標示、帳期區間、可請款的訂單篩選、錯誤訊息翻成中文、CSV。
// 金額與「已收貨」的定義一律來自 src/lib/metrics.ts(全站唯一定義)。
// 日期一律用「本地時區」切(台灣 UTC+8),不用 toISOString().slice(0, 10)。

import { formatOrderNo } from "@/lib/orders";
import { dealRecognizedAt, isDeal, orderAmount, type DealLedger } from "@/lib/metrics";
import { localDateStr, toCsv } from "@/lib/restaurant-report";

export type InvoiceStatus = "issued" | "confirmed" | "disputed" | "paid" | "void";
export type PeriodKind = "daily" | "monthly" | "custom";

export interface InvoiceLine {
  order_id: string;
  order_no: string;
  ordered_at: string;
  amount: number;
}

export interface InvoiceRow {
  id: string;
  invoice_no: string;
  supplier_id: string;
  restaurant_id: string;
  period_kind: PeriodKind;
  period_start: string;
  period_end: string;
  net_days: number;
  due_date: string;
  total_amount: number | string;
  status: InvoiceStatus;
  note: string | null;
  lines: InvoiceLine[] | null;
  issued_at: string;
  confirmed_at: string | null;
  disputed_at: string | null;
  dispute_note: string | null;
  paid_at: string | null;
  paid_note: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

export const INVOICE_COLUMNS =
  "id, invoice_no, supplier_id, restaurant_id, period_kind, period_start, period_end, net_days, due_date, total_amount, status, note, lines, issued_at, confirmed_at, disputed_at, dispute_note, paid_at, paid_note, voided_at, void_reason";

export const STATUS_META: Readonly<Record<InvoiceStatus, { label: string; className: string }>> = {
  issued: { label: "待確認", className: "bg-amber-50 text-amber-700 border-amber-200" },
  confirmed: { label: "已確認", className: "bg-blue-50 text-blue-700 border-blue-200" },
  disputed: { label: "有異議", className: "bg-red-50 text-red-700 border-red-200" },
  paid: { label: "已收款", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  void: { label: "已作廢", className: "bg-slate-100 text-slate-500 border-slate-300" },
};

export const PERIOD_LABEL: Readonly<Record<PeriodKind, string>> = {
  daily: "日結",
  monthly: "月結",
  custom: "自訂區間",
};

/** 還沒結束的請款單(待確認 / 已確認 / 有異議):收款前都算應收 / 應付 */
export const isOpenInvoice = (status: InvoiceStatus): boolean =>
  status === "issued" || status === "confirmed" || status === "disputed";

/** 逾期:到期日早於今天,而且還沒收款、沒作廢。「逾期」不存資料庫,每次現算 */
export const isOverdue = (inv: Pick<InvoiceRow, "status" | "due_date">, today: string = localDateStr(new Date())): boolean =>
  isOpenInvoice(inv.status) && inv.due_date < today;

export const invoiceAmount = (inv: Pick<InvoiceRow, "total_amount">): number => orderAmount({ total_amount: inv.total_amount });

export interface InvoiceTotals {
  openAmount: number;
  overdueAmount: number;
  openCount: number;
  overdueCount: number;
  paidAmount: number;
}

export const summarizeInvoices = (rows: readonly InvoiceRow[], today: string = localDateStr(new Date())): InvoiceTotals => {
  const t: InvoiceTotals = { openAmount: 0, overdueAmount: 0, openCount: 0, overdueCount: 0, paidAmount: 0 };
  rows.forEach((r) => {
    const amount = invoiceAmount(r);
    if (isOpenInvoice(r.status)) {
      t.openAmount += amount;
      t.openCount += 1;
      if (isOverdue(r, today)) {
        t.overdueAmount += amount;
        t.overdueCount += 1;
      }
    } else if (r.status === "paid") {
      t.paidAmount += amount;
    }
  });
  return t;
};

/* ------------------------------ 帳期 ------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** 日結選哪天、月結選哪個月(YYYY-MM)、自訂區間選起迄日,算出請款區間;輸入不完整或不合理回 null */
export const periodRange = (
  kind: PeriodKind,
  input: { day?: string; month?: string; start?: string; end?: string },
): { start: string; end: string } | null => {
  if (kind === "daily") {
    const d = input.day ?? "";
    return DATE_RE.test(d) && localDateStr(parse(d)) === d ? { start: d, end: d } : null;
  }
  if (kind === "monthly") {
    const m = MONTH_RE.exec(input.month ?? "");
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { start: localDateStr(new Date(y, mo - 1, 1)), end: localDateStr(new Date(y, mo, 0)) };
  }
  const { start = "", end = "" } = input;
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || localDateStr(parse(start)) !== start || localDateStr(parse(end)) !== end) return null;
  return start <= end ? { start, end } : null;
};

const parse = (s: string): Date => {
  const m = DATE_RE.exec(s)!;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** 開單時預設的付款天數:日結當天到期,月結 30 天,自訂區間 30 天(都能自己改) */
export const defaultNetDays = (kind: PeriodKind): number => (kind === "daily" ? 0 : 30);

/** 到期日 = 區間迄日 + 付款天數(跟資料庫算法一樣) */
export const dueDateOf = (periodEnd: string, netDays: number): string => {
  const d = parse(periodEnd);
  return localDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + netDays));
};

export const periodText = (inv: Pick<InvoiceRow, "period_kind" | "period_start" | "period_end">): string =>
  inv.period_start === inv.period_end ? inv.period_start : `${inv.period_start} ~ ${inv.period_end}`;

/* ------------------------------ 可請款的訂單 ------------------------------ */

export interface CandidateOrder {
  id: string;
  status: string;
  total_amount: number | string | null;
  created_at: string;
}

export interface EligibleOrder {
  id: string;
  orderNo: string;
  /** 算在哪一天:餐廳確認收貨的那天;舊資料沒有收貨事件就用建立日 */
  receivedDate: string;
  amount: number;
}

/**
 * 這個區間內可以請款的訂單:已收貨(成交定義)、有金額、還沒放進別張請款單,
 * 而且「收貨日」落在區間內(收貨日 = 第一次進入成交狀態的時間,舊資料用建立時間)。
 */
export const eligibleOrders = (
  orders: readonly CandidateOrder[],
  ledger: DealLedger,
  invoicedIds: ReadonlySet<string>,
  start: string,
  end: string,
): EligibleOrder[] =>
  orders
    .filter((o) => isDeal({ id: o.id, status: o.status }, ledger) && orderAmount(o) > 0 && !invoicedIds.has(o.id))
    .map((o) => ({
      id: o.id,
      orderNo: formatOrderNo(o.id),
      receivedDate: localDateStr(new Date(dealRecognizedAt(o, ledger))),
      amount: orderAmount(o),
    }))
    .filter((o) => o.receivedDate >= start && o.receivedDate <= end)
    .sort((a, b) => (a.receivedDate < b.receivedDate ? -1 : a.receivedDate > b.receivedDate ? 1 : a.orderNo.localeCompare(b.orderNo)));

/* ------------------------------ 錯誤訊息 ------------------------------ */

const ERROR_TEXT: Readonly<Record<string, string>> = {
  not_a_member_of_this_supplier: "你的帳號不屬於這家供應商,無法開請款單",
  invalid_period_kind: "帳期種類不正確",
  invalid_period: "請款區間不正確,請確認起日不晚於迄日",
  daily_period_must_be_one_day: "日結的區間必須是同一天",
  monthly_period_must_be_a_whole_month: "月結的區間必須是整個月",
  invalid_net_days: "付款天數要在 0 到 365 天之間",
  invoice_needs_1_to_500_orders: "一張請款單要包含 1 到 500 張訂單",
  invoice_orders_already_invoiced: "有訂單已經放進別張請款單了,請重新整理後再試",
  invoice_orders_not_eligible: "有訂單不能請款(還沒收貨、沒有金額,或不屬於這家餐廳),請重新整理後再試",
  invoice_not_found: "找不到這張請款單,或你沒有權限",
  invoice_not_payable: "這張請款單已經收款或作廢,不能再標記收款",
  invoice_not_voidable: "已收款或已作廢的請款單不能作廢",
  void_reason_required: "作廢請先寫原因",
  invoice_not_confirmable: "這張請款單目前不能確認(可能已收款或作廢)",
  invoice_not_disputable: "這張請款單目前不能提出異議(可能已收款或作廢)",
  dispute_note_required: "提出異議請先寫原因",
  invalid_action: "動作不正確",
};

/** 資料庫 RPC 丟出的錯誤訊息裡有代碼(例如 invoice_not_payable),翻成中文;認不得的原樣回傳 */
export const invoiceErrorMessage = (message: string | null | undefined): string => {
  const text = message ?? "";
  const code = Object.keys(ERROR_TEXT).find((c) => text.includes(c));
  return code ? ERROR_TEXT[code] : text || "未知錯誤";
};

/* ------------------------------ CSV ------------------------------ */

export const invoiceLinesCsv = (inv: InvoiceRow, partyName: string): string => {
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  return toCsv(
    ["請款單號", "對象", "帳期", "區間", "到期日", "訂單編號", "訂單日期", "金額", "請款單狀態"],
    lines.map((l) => [
      inv.invoice_no,
      partyName,
      PERIOD_LABEL[inv.period_kind],
      periodText(inv),
      inv.due_date,
      l.order_no,
      localDateStr(new Date(l.ordered_at)),
      l.amount,
      STATUS_META[inv.status].label,
    ]),
  );
};

export const invoiceListCsv = (rows: readonly InvoiceRow[], partyNames: Readonly<Record<string, string>>, partyKey: "restaurant_id" | "supplier_id"): string =>
  toCsv(
    ["請款單號", "對象", "帳期", "區間", "開立日", "到期日", "金額", "狀態", "逾期"],
    rows.map((r) => [
      r.invoice_no,
      partyNames[r[partyKey]] ?? "",
      PERIOD_LABEL[r.period_kind],
      periodText(r),
      localDateStr(new Date(r.issued_at)),
      r.due_date,
      invoiceAmount(r),
      STATUS_META[r.status].label,
      isOverdue(r) ? "是" : "否",
    ]),
  );

/* ------------------------------ 呼叫資料庫 RPC ------------------------------ */

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/** 呼叫請款相關的 RPC;失敗時丟出已經翻成中文的 Error */
export const callInvoiceRpc = async <T = unknown>(
  client: unknown,
  fn: "supplier_create_invoice" | "supplier_mark_invoice_paid" | "supplier_void_invoice" | "restaurant_respond_invoice",
  args: Record<string, unknown>,
): Promise<T> => {
  const { data, error } = await (client as RpcClient).rpc(fn, args);
  if (error) throw new Error(invoiceErrorMessage(error.message));
  return data as T;
};

export const TWD = (n: number): string => `NT$ ${Math.round(n).toLocaleString("zh-TW")}`;
