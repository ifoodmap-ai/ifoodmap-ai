import { describe, expect, it } from "vitest";
import { dealLedger } from "@/lib/metrics";
import {
  defaultNetDays,
  dueDateOf,
  eligibleOrders,
  invoiceErrorMessage,
  invoiceLinesCsv,
  isOverdue,
  periodRange,
  summarizeInvoices,
  type InvoiceRow,
} from "./invoices";

const inv = (over: Partial<InvoiceRow>): InvoiceRow => ({
  id: "i1", invoice_no: "INV-20261022-0001", supplier_id: "s1", restaurant_id: "r1", period_kind: "custom",
  period_start: "2026-10-01", period_end: "2026-10-07", net_days: 30, due_date: "2026-11-06", total_amount: 1000,
  status: "issued", note: null, lines: [], issued_at: "2026-10-08T02:00:00Z", confirmed_at: null, disputed_at: null,
  dispute_note: null, paid_at: null, paid_note: null, voided_at: null, void_reason: null, ...over,
});

describe("帳期區間 periodRange", () => {
  it("日結:選哪天就是哪天;日期不存在回 null", () => {
    expect(periodRange("daily", { day: "2026-10-05" })).toEqual({ start: "2026-10-05", end: "2026-10-05" });
    expect(periodRange("daily", { day: "2026-02-30" })).toBeNull();
    expect(periodRange("daily", {})).toBeNull();
  });

  it("月結:整個月,二月看閏年,十二月不會跨年出錯", () => {
    expect(periodRange("monthly", { month: "2026-10" })).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodRange("monthly", { month: "2026-02" })).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodRange("monthly", { month: "2028-02" })).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(periodRange("monthly", { month: "2026-12" })).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(periodRange("monthly", { month: "2026-13" })).toBeNull();
    expect(periodRange("monthly", { month: "" })).toBeNull();
  });

  it("自訂區間:起日不能晚於迄日", () => {
    expect(periodRange("custom", { start: "2026-10-01", end: "2026-10-15" })).toEqual({ start: "2026-10-01", end: "2026-10-15" });
    expect(periodRange("custom", { start: "2026-10-16", end: "2026-10-15" })).toBeNull();
    expect(periodRange("custom", { start: "2026-10-01" })).toBeNull();
  });

  it("預設付款天數與到期日(跟資料庫同算法:迄日 + 付款天數)", () => {
    expect(defaultNetDays("daily")).toBe(0);
    expect(defaultNetDays("monthly")).toBe(30);
    expect(dueDateOf("2026-10-31", 30)).toBe("2026-11-30");
    expect(dueDateOf("2026-10-05", 0)).toBe("2026-10-05");
    expect(dueDateOf("2026-12-20", 30)).toBe("2027-01-19");
  });
});

describe("逾期與彙總", () => {
  it("逾期 = 到期日早於今天且還沒收款 / 作廢;當天到期還不算逾期", () => {
    expect(isOverdue(inv({ due_date: "2026-10-20" }), "2026-10-21")).toBe(true);
    expect(isOverdue(inv({ due_date: "2026-10-21" }), "2026-10-21")).toBe(false);
    expect(isOverdue(inv({ due_date: "2026-10-01", status: "paid" }), "2026-10-21")).toBe(false);
    expect(isOverdue(inv({ due_date: "2026-10-01", status: "void" }), "2026-10-21")).toBe(false);
    expect(isOverdue(inv({ due_date: "2026-10-01", status: "disputed" }), "2026-10-21")).toBe(true);
  });

  it("summarizeInvoices:未收金額、逾期金額、已收款分開算;作廢不算", () => {
    const rows = [
      inv({ id: "a", status: "issued", total_amount: 1000, due_date: "2026-10-30" }),
      inv({ id: "b", status: "confirmed", total_amount: "2000.50", due_date: "2026-10-10" }),
      inv({ id: "c", status: "paid", total_amount: 700 }),
      inv({ id: "d", status: "void", total_amount: 9999 }),
    ];
    expect(summarizeInvoices(rows, "2026-10-21")).toEqual({
      openAmount: 3000.5, openCount: 2, overdueAmount: 2000.5, overdueCount: 1, paidAmount: 700,
    });
  });
});

describe("可請款的訂單 eligibleOrders", () => {
  const orders = [
    { id: "aaaaaaa1", status: "received", total_amount: 1000, created_at: "2026-10-01T02:00:00Z" },
    { id: "aaaaaaa2", status: "reviewed", total_amount: 500, created_at: "2026-10-02T02:00:00Z" },
    { id: "aaaaaaa3", status: "shipped", total_amount: 300, created_at: "2026-10-03T02:00:00Z" },
    { id: "aaaaaaa4", status: "received", total_amount: null, created_at: "2026-10-03T02:00:00Z" },
    { id: "aaaaaaa5", status: "closed", total_amount: 800, created_at: "2026-10-03T02:00:00Z" },
    { id: "aaaaaaa6", status: "closed", total_amount: 900, created_at: "2026-10-03T02:00:00Z" },
    { id: "aaaaaaa7", status: "received", total_amount: 100, created_at: "2026-10-04T02:00:00Z" },
  ];
  const events = [
    { order_id: "aaaaaaa1", to_status: "received", created_at: "2026-10-10T02:00:00Z" },
    { order_id: "aaaaaaa5", to_status: "received", created_at: "2026-10-09T02:00:00Z" },
    { order_id: "aaaaaaa6", to_status: "disputed", created_at: "2026-10-09T02:00:00Z" },
  ];
  const ledger = dealLedger(events);

  it("只列已收貨、有金額、沒被請款過的單;已結案的單要收過貨", () => {
    const r = eligibleOrders(orders, ledger, new Set(["aaaaaaa7"]), "2026-10-01", "2026-10-31");
    expect(r.map((o) => o.id)).toEqual(["aaaaaaa2", "aaaaaaa5", "aaaaaaa1"]);
  });

  it("以「收貨日」判斷落在哪個區間:有收貨事件用事件日,沒有就用建立日", () => {
    // aaaaaaa1 建立日 10/1、收貨日 10/10 → 算在 10/10;aaaaaaa2 沒事件 → 算在建立日 10/2
    expect(eligibleOrders(orders, ledger, new Set(), "2026-10-01", "2026-10-05").map((o) => o.id)).toEqual(["aaaaaaa2", "aaaaaaa7"]);
    expect(eligibleOrders(orders, ledger, new Set(), "2026-10-10", "2026-10-10").map((o) => o.id)).toEqual(["aaaaaaa1"]);
  });

  it("帶出訂單編號與金額", () => {
    const [first] = eligibleOrders(orders, ledger, new Set(), "2026-10-10", "2026-10-10");
    expect(first).toEqual({ id: "aaaaaaa1", orderNo: "#AAAAAAA1", receivedDate: "2026-10-10", amount: 1000 });
  });
});

describe("錯誤訊息與 CSV", () => {
  it("資料庫的錯誤代碼翻成中文,認不得的原樣回傳", () => {
    expect(invoiceErrorMessage("invoice_not_payable")).toContain("已經收款或作廢");
    expect(invoiceErrorMessage('Error: invoice_orders_already_invoiced (23505)')).toContain("別張請款單");
    expect(invoiceErrorMessage("something else")).toBe("something else");
    expect(invoiceErrorMessage(null)).toBe("未知錯誤");
  });

  it("請款單明細 CSV:每張訂單一列、有 BOM", () => {
    const csv = invoiceLinesCsv(
      inv({ lines: [{ order_id: "o1", order_no: "#A1", ordered_at: "2026-10-03T02:00:00Z", amount: 1000 }, { order_id: "o2", order_no: "#A2", ordered_at: "2026-10-04T02:00:00Z", amount: 500 }] }),
      "好味小館",
    );
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("INV-20261022-0001,好味小館,自訂區間,2026-10-01 ~ 2026-10-07,2026-11-06,#A1,2026-10-03,1000,待確認");
  });
});
