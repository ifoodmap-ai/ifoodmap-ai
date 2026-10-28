// 供應商的「出貨彙總」與「揀貨單」:把某個配送日要送出去的訂單,整理成「每個品項總共要備多少」與「每家客戶各要什麼」。
// 純前端整理,不寫資料庫;輸出 CSV(開頭有 BOM,Excel 可直接開)。
import { formatOrderNo } from "@/lib/order-number";
import { toCsv } from "@/lib/restaurant-report";

export interface PickItem {
  name?: string;
  quantity?: string | number;
  unit?: string;
}

export interface PickOrder {
  id: string;
  status: string;
  restaurant_id: string | null;
  delivery_date: string | null;
  ingredient_list: PickItem[] | null;
}

/**
 * 備貨要算進去的訂單:供應商已經接單、還沒送到的單(待報價、待餐廳確認、待出貨、已出貨、運送中)。
 * 還在「待接單」的單供應商還沒答應要送,不算;已拒單、取消、逾時的更不算。
 */
const PICK_STATUSES: readonly string[] = ["accepted", "quoted", "confirmed", "shipped", "in_transit"];

export const isPickable = (o: Pick<PickOrder, "status">): boolean => PICK_STATUSES.includes(o.status);

export interface PickTotalRow {
  name: string;
  unit: string;
  /** 能解析成數字的數量加總;全部都是「3箱」這類文字時為 0 */
  quantity: number;
  customers: number;
  orders: number;
  /** 有些數量不是純數字,沒有算進加總 */
  hasUnparsed: boolean;
}

export interface PickLine {
  orderId: string;
  orderNo: string;
  customer: string;
  name: string;
  quantity: string;
  unit: string;
}

export interface PickList {
  orderCount: number;
  totals: PickTotalRow[];
  lines: PickLine[];
  /** 這天已接單以外、還在等供應商接單的張數(提醒用) */
  waitingCount: number;
}

const itemsOf = (o: PickOrder): { name: string; quantity: string; unit: string }[] =>
  (Array.isArray(o.ingredient_list) ? o.ingredient_list : [])
    .map((i) => ({
      name: (i?.name ?? "").trim(),
      quantity: i?.quantity != null ? String(i.quantity).trim() : "",
      unit: (i?.unit ?? "").trim(),
    }))
    .filter((i) => i.name);

const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

export const buildPickList = (
  orders: readonly PickOrder[],
  deliveryDate: string,
  customerNames: Readonly<Record<string, string>>,
): PickList => {
  const sameDay = orders.filter((o) => o.delivery_date === deliveryDate);
  const picked = sameDay.filter(isPickable);

  const totals = new Map<string, PickTotalRow & { customerIds: Set<string> }>();
  const lines: PickLine[] = [];
  picked.forEach((o) => {
    const customer = (o.restaurant_id && customerNames[o.restaurant_id]) || "（未知客戶）";
    const seen = new Set<string>();
    itemsOf(o).forEach((i) => {
      lines.push({ orderId: o.id, orderNo: formatOrderNo(o.id), customer, name: i.name, quantity: i.quantity, unit: i.unit });
      const key = `${i.name}\u0000${i.unit}`;
      const row = totals.get(key) ?? { name: i.name, unit: i.unit, quantity: 0, customers: 0, orders: 0, hasUnparsed: false, customerIds: new Set<string>() };
      if (PLAIN_NUMBER.test(i.quantity)) row.quantity = Math.round((row.quantity + Number.parseFloat(i.quantity)) * 100) / 100;
      else row.hasUnparsed = true;
      if (!seen.has(key)) {
        row.orders += 1;
        seen.add(key);
      }
      row.customerIds.add(o.restaurant_id ?? o.id);
      totals.set(key, row);
    });
  });

  return {
    orderCount: picked.length,
    totals: [...totals.values()]
      .map(({ customerIds, ...row }) => ({ ...row, customers: customerIds.size }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant") || a.unit.localeCompare(b.unit, "zh-Hant")),
    // 揀貨單依客戶分組、同一家的單放在一起
    lines: lines.sort((a, b) => a.customer.localeCompare(b.customer, "zh-Hant") || a.orderNo.localeCompare(b.orderNo)),
    waitingCount: sameDay.filter((o) => o.status === "dispatched" || o.status === "sent").length,
  };
};

export const TOTALS_CSV_HEADERS = ["品項", "單位", "總數量", "客戶數", "訂單數", "備註"] as const;
export const totalsCsv = (rows: readonly PickTotalRow[]): string =>
  toCsv(TOTALS_CSV_HEADERS, rows.map((r) => [r.name, r.unit, r.quantity, r.customers, r.orders, r.hasUnparsed ? "部分數量不是純數字,未計入總數量" : ""]));

export const LINES_CSV_HEADERS = ["客戶", "訂單編號", "品項", "數量", "單位"] as const;
export const linesCsv = (rows: readonly PickLine[]): string =>
  toCsv(LINES_CSV_HEADERS, rows.map((r) => [r.customer, r.orderNo, r.name, r.quantity, r.unit]));
