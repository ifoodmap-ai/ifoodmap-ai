// 餐廳端「報表」:把一段日期內的採購單整理成訂單明細、供應商彙總、品項彙總,並輸出 CSV。
// 金額與「已收貨(成交)」的定義一律來自 src/lib/metrics.ts(全站唯一定義),這裡不另寫狀態清單。
// 日期一律用「本地時區」切(台灣 UTC+8):不能用 toISOString().slice(0, 10),
// 那是 UTC,早上 8 點前的單會被算到前一天。

import { ORDER_STATUS, formatOrderNo, type OrderStatus } from "@/lib/orders";
import {
  countDeals,
  countOrders,
  countedOrders,
  isDeal,
  orderAmount,
  sumGmv,
  sumInProgressAmount,
  sumOrderAmount,
  type DealLedger,
} from "@/lib/metrics";

export interface ReportRawItem {
  name?: string;
  quantity?: string | number;
  unit?: string;
  reference_price?: string | number;
}

export interface ReportOrder {
  id: string;
  status: string;
  total_amount: number | string | null;
  created_at: string;
  supplier_id: string | null;
  ingredient_list: ReportRawItem[] | null;
}

export interface ReportOrderRow {
  id: string;
  orderNo: string;
  date: string;
  supplier: string;
  statusLabel: string;
  itemCount: number;
  itemsText: string;
  amount: number;
  /** 餐廳確認收貨之後(成交) */
  received: boolean;
}

export interface SupplierSummaryRow {
  supplier: string;
  orders: number;
  amount: number;
  received: number;
}

export interface ItemSummaryRow {
  name: string;
  unit: string;
  /** 數量能解析成數字的加總;全部都是「3箱」這類文字時為 0 */
  quantity: number;
  /** 有幾張單叫過 */
  orders: number;
  /** 有些數量不是純數字,沒有算進加總 */
  hasUnparsed: boolean;
}

export interface ReportSummary {
  orderCount: number;
  purchaseAmount: number;
  receivedCount: number;
  receivedAmount: number;
  inProgressAmount: number;
}

export interface ReportData {
  summary: ReportSummary;
  orders: ReportOrderRow[];
  suppliers: SupplierSummaryRow[];
  items: ItemSummaryRow[];
}

/* ------------------------------ 日期 ------------------------------ */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地時區的 YYYY-MM-DD */
export const localDateStr = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const parseLocalDate = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || localDateStr(d) !== s ? null : d;
};

export const isValidRange = (start: string, end: string): boolean => {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  return !!a && !!b && a.getTime() <= b.getTime();
};

/** 查詢用的時間範圍:[起日 00:00, 迄日隔天 00:00)(本地時區),回傳 ISO 字串 */
export const rangeBounds = (start: string, end: string): { from: string; to: string } | null => {
  const a = parseLocalDate(start);
  const b = parseLocalDate(end);
  if (!a || !b || a.getTime() > b.getTime()) return null;
  const next = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
  return { from: a.toISOString(), to: next.toISOString() };
};

export type RangePreset = "thisMonth" | "lastMonth" | "last30" | "last90";

export const RANGE_PRESETS: readonly { key: RangePreset; label: string }[] = [
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "last30", label: "近 30 天" },
  { key: "last90", label: "近 90 天" },
];

export const presetRange = (preset: RangePreset, now: Date = new Date()): { start: string; end: string } => {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "thisMonth":
      return { start: localDateStr(new Date(y, m, 1)), end: localDateStr(now) };
    case "lastMonth":
      return { start: localDateStr(new Date(y, m - 1, 1)), end: localDateStr(new Date(y, m, 0)) };
    case "last30":
      return { start: localDateStr(new Date(y, m, now.getDate() - 29)), end: localDateStr(now) };
    case "last90":
      return { start: localDateStr(new Date(y, m, now.getDate() - 89)), end: localDateStr(now) };
  }
};

/* ------------------------------ 彙總 ------------------------------ */

const statusLabel = (status: string): string =>
  ORDER_STATUS[status as OrderStatus]?.label ?? status;

const itemsOf = (o: ReportOrder): ReportRawItem[] =>
  Array.isArray(o.ingredient_list) ? o.ingredient_list.filter((i) => (i?.name ?? "").trim() !== "") : [];

const itemLine = (i: ReportRawItem): string => {
  const q = i.quantity != null && String(i.quantity).trim() !== "" ? ` ${i.quantity}${i.unit ?? ""}` : "";
  return `${(i.name ?? "").trim()}${q}`;
};

/**
 * 把訂單整理成報表。訂單先過共用定義(不含草稿、取消、拒單、逾時);
 * ledger 是收貨帳本(從 order_events 做的),沒有它已結案的單會一律不算已收貨。
 */
export const buildReport = (
  rows: readonly ReportOrder[],
  ledger: DealLedger,
  supplierNames: Readonly<Record<string, string>>,
): ReportData => {
  const counted = countedOrders(rows);
  const supplierOf = (o: ReportOrder) =>
    (o.supplier_id && supplierNames[o.supplier_id]) || (o.supplier_id ? "（未知供應商）" : "（尚未指派）");

  const newestFirst = [...counted].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const orders: ReportOrderRow[] = newestFirst
    .map((o) => {
      const items = itemsOf(o);
      return {
        id: o.id,
        orderNo: formatOrderNo(o.id),
        date: localDateStr(new Date(o.created_at)),
        supplier: supplierOf(o),
        statusLabel: statusLabel(o.status),
        itemCount: items.length,
        itemsText: items.map(itemLine).join("、"),
        amount: orderAmount(o),
        received: isDeal({ id: o.id, status: o.status }, ledger),
      };
    });

  const bySupplier = new Map<string, SupplierSummaryRow>();
  counted.forEach((o) => {
    const name = supplierOf(o);
    const row = bySupplier.get(name) ?? { supplier: name, orders: 0, amount: 0, received: 0 };
    row.orders += 1;
    row.amount += orderAmount(o);
    if (isDeal({ id: o.id, status: o.status }, ledger)) row.received += 1;
    bySupplier.set(name, row);
  });

  const byItem = new Map<string, ItemSummaryRow>();
  counted.forEach((o) => {
    const seen = new Set<string>();
    itemsOf(o).forEach((i) => {
      const name = (i.name ?? "").trim();
      const unit = (i.unit ?? "").trim();
      const key = `${name}\u0000${unit}`;
      const row = byItem.get(key) ?? { name, unit, quantity: 0, orders: 0, hasUnparsed: false };
      const q = Number.parseFloat(String(i.quantity ?? ""));
      if (Number.isFinite(q) && /^\s*\d+(\.\d+)?\s*$/.test(String(i.quantity))) {
        row.quantity = Math.round((row.quantity + q) * 100) / 100;
      } else {
        row.hasUnparsed = true;
      }
      if (!seen.has(key)) {
        row.orders += 1;
        seen.add(key);
      }
      byItem.set(key, row);
    });
  });

  const dealRows = counted.map((o) => ({ id: o.id, status: o.status, total_amount: o.total_amount }));

  return {
    summary: {
      orderCount: countOrders(rows),
      purchaseAmount: sumOrderAmount(rows),
      receivedCount: countDeals(dealRows, ledger),
      receivedAmount: sumGmv(dealRows, ledger),
      inProgressAmount: sumInProgressAmount(rows),
    },
    orders,
    suppliers: [...bySupplier.values()].sort((a, b) => b.amount - a.amount || b.orders - a.orders),
    items: [...byItem.values()].sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name, "zh-Hant")),
  };
};

/* ------------------------------ CSV ------------------------------ */

type CsvValue = string | number | null | undefined;

/**
 * 一格 CSV。文字以 = + - @ 開頭時前面補單引號,避免 Excel 把品項名稱 / 供應商名稱當成公式執行;
 * 數字原樣輸出(負數、小數不受影響)。
 */
export const csvCell = (v: CsvValue): string => {
  if (v == null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 開頭加 BOM,Excel 開啟才不會把中文變亂碼 */
export const toCsv = (headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string =>
  `\uFEFF${[headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}`;

export const ORDER_CSV_HEADERS = ["日期", "訂單編號", "供應商", "狀態", "品項數", "品項", "金額", "已收貨"] as const;
export const orderCsvRows = (rows: readonly ReportOrderRow[]) =>
  rows.map((r) => [r.date, r.orderNo, r.supplier, r.statusLabel, r.itemCount, r.itemsText, r.amount, r.received ? "是" : "否"]);

export const SUPPLIER_CSV_HEADERS = ["供應商", "訂單數", "採購金額", "已收貨單數"] as const;
export const supplierCsvRows = (rows: readonly SupplierSummaryRow[]) =>
  rows.map((r) => [r.supplier, r.orders, r.amount, r.received]);

export const ITEM_CSV_HEADERS = ["品項", "單位", "總數量", "叫貨次數", "備註"] as const;
export const itemCsvRows = (rows: readonly ItemSummaryRow[]) =>
  rows.map((r) => [r.name, r.unit, r.quantity, r.orders, r.hasUnparsed ? "部分數量不是純數字,未計入總數量" : ""]);

/** 前端 Blob 下載 */
export const downloadCsv = (filename: string, csv: string) => {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
