import { describe, expect, it } from "vitest";
import { dealLedger } from "@/lib/metrics";
import {
  buildReport,
  csvCell,
  isValidRange,
  localDateStr,
  orderCsvRows,
  presetRange,
  rangeBounds,
  toCsv,
  ORDER_CSV_HEADERS,
  type ReportOrder,
} from "./restaurant-report";

// vitest 固定台灣時區(vite.config.ts 的 test.env.TZ)
const order = (id: string, status: string, amount: number | null, createdAt: string, items: ReportOrder["ingredient_list"], supplier = "s1"): ReportOrder => ({
  id, status, total_amount: amount, created_at: createdAt, supplier_id: supplier, ingredient_list: items,
});

const NAMES = { s1: "阿明蔬果", s2: "大海水產" };

describe("日期區間", () => {
  it("rangeBounds:起日 00:00 到迄日隔天 00:00(本地時區),迄日當天整天都算", () => {
    const b = rangeBounds("2026-10-01", "2026-10-31");
    expect(b).toEqual({ from: "2026-09-30T16:00:00.000Z", to: "2026-10-31T16:00:00.000Z" });
  });

  it("台灣早上 8 點前建立的單算在當天,不是前一天", () => {
    expect(localDateStr(new Date("2026-10-05T23:30:00Z"))).toBe("2026-10-06");
  });

  it("isValidRange:起日不能晚於迄日,格式要對,不存在的日期不算", () => {
    expect(isValidRange("2026-10-01", "2026-10-01")).toBe(true);
    expect(isValidRange("2026-10-02", "2026-10-01")).toBe(false);
    expect(isValidRange("", "2026-10-01")).toBe(false);
    expect(isValidRange("2026-02-30", "2026-03-05")).toBe(false);
    expect(rangeBounds("2026-10-02", "2026-10-01")).toBeNull();
  });

  it("presetRange:本月、上月、近 30 天、近 90 天", () => {
    const now = new Date(2026, 9, 21, 10, 0, 0); // 2026-10-21
    expect(presetRange("thisMonth", now)).toEqual({ start: "2026-10-01", end: "2026-10-21" });
    expect(presetRange("lastMonth", now)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(presetRange("last30", now)).toEqual({ start: "2026-09-22", end: "2026-10-21" });
    expect(presetRange("last90", now)).toEqual({ start: "2026-07-24", end: "2026-10-21" });
  });

  it("presetRange:一月的上月是去年十二月", () => {
    const now = new Date(2026, 0, 15);
    expect(presetRange("lastMonth", now)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });
});

describe("buildReport", () => {
  const ROWS: ReportOrder[] = [
    order("a0000001", "received", 1000, "2026-10-03T02:00:00Z", [{ name: "高麗菜", quantity: "5", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }]),
    order("b0000002", "shipped", 500, "2026-10-05T02:00:00Z", [{ name: "高麗菜", quantity: "3", unit: "kg" }]),
    order("c0000003", "closed", 300, "2026-10-06T02:00:00Z", [{ name: "吳郭魚", quantity: "3箱", unit: "" }], "s2"),
    order("d0000004", "cancelled", 999, "2026-10-07T02:00:00Z", [{ name: "高麗菜", quantity: "100", unit: "kg" }]),
    order("e0000005", "draft", null, "2026-10-08T02:00:00Z", [{ name: "高麗菜", quantity: "100", unit: "kg" }]),
    order("f0000006", "quoted", null, "2026-10-09T02:00:00Z", [], "s2"),
  ];

  it("訂單數與採購金額不含草稿、取消;沒報價的單金額以 0 計", () => {
    const r = buildReport(ROWS, dealLedger([]), NAMES);
    expect(r.summary.orderCount).toBe(4);
    expect(r.summary.purchaseAmount).toBe(1800);
    expect(r.orders.map((o) => o.orderNo)).toEqual(["#F0000006", "#C0000003", "#B0000002", "#A0000001"]);
  });

  it("已結案的單沒有收貨紀錄不算已收貨;有收貨事件才算", () => {
    const without = buildReport(ROWS, dealLedger([]), NAMES);
    expect(without.summary.receivedCount).toBe(1);
    expect(without.summary.receivedAmount).toBe(1000);

    const events = [{ order_id: "c0000003", to_status: "received", created_at: "2026-10-07T01:00:00Z" }];
    const withEvents = buildReport(ROWS, dealLedger(events), NAMES);
    expect(withEvents.summary.receivedCount).toBe(2);
    expect(withEvents.summary.receivedAmount).toBe(1300);
    expect(withEvents.orders.find((o) => o.id === "c0000003")?.received).toBe(true);
  });

  it("進行中金額 = 有效但還沒收貨的單", () => {
    const r = buildReport(ROWS, dealLedger([]), NAMES);
    expect(r.summary.inProgressAmount).toBe(500);
  });

  it("供應商彙總:依金額由大到小,未指派的單另列", () => {
    const rows = [...ROWS, order("g0000007", "submitted", null, "2026-10-10T02:00:00Z", [], null as unknown as string)];
    const r = buildReport(rows, dealLedger([]), NAMES);
    expect(r.suppliers.map((s) => [s.supplier, s.orders, s.amount])).toEqual([
      ["阿明蔬果", 2, 1500],
      ["大海水產", 2, 300],
      ["（尚未指派）", 1, 0],
    ]);
  });

  it("品項彙總:同品項同單位加總、叫貨次數是張數、取消與草稿的不算;非純數字的數量不加總並標示", () => {
    const r = buildReport(ROWS, dealLedger([]), NAMES);
    const cabbage = r.items.find((i) => i.name === "高麗菜");
    expect(cabbage).toEqual({ name: "高麗菜", unit: "kg", quantity: 8, orders: 2, hasUnparsed: false });
    const fish = r.items.find((i) => i.name === "吳郭魚");
    expect(fish).toEqual({ name: "吳郭魚", unit: "", quantity: 0, orders: 1, hasUnparsed: true });
  });

  it("同一張單裡同品項重複出現只算一次叫貨次數", () => {
    const r = buildReport(
      [order("h0000008", "submitted", null, "2026-10-10T02:00:00Z", [{ name: "蔥", quantity: "1", unit: "斤" }, { name: "蔥", quantity: "2", unit: "斤" }])],
      dealLedger([]),
      NAMES,
    );
    expect(r.items).toEqual([{ name: "蔥", unit: "斤", quantity: 3, orders: 1, hasUnparsed: false }]);
  });
});

describe("CSV", () => {
  it("開頭有 BOM、欄位用逗號、換行 CRLF;含逗號 / 引號 / 換行的文字會加引號", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line1\nline2", 3]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1)).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line1\nline2",3');
  });

  it("以 = + - @ 開頭的文字前面補單引號,避免 Excel 當公式執行;數字不受影響", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(0.5)).toBe("0.5");
    expect(csvCell(null)).toBe("");
  });

  it("訂單明細的欄位與表頭一一對應", () => {
    const r = buildReport(
      [order("a0000001", "received", 1000, "2026-10-03T02:00:00Z", [{ name: "高麗菜", quantity: "5", unit: "kg" }])],
      dealLedger([]),
      NAMES,
    );
    const [row] = orderCsvRows(r.orders);
    expect(row).toHaveLength(ORDER_CSV_HEADERS.length);
    expect(row).toEqual(["2026-10-03", "#A0000001", "阿明蔬果", "待評價", 1, "高麗菜 5kg", 1000, "是"]);
  });
});
