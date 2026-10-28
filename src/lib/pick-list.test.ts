import { describe, expect, it } from "vitest";
import { buildPickList, isPickable, linesCsv, totalsCsv, type PickOrder } from "./pick-list";

const NAMES = { r1: "好味小館", r2: "阿財麵店" };
const o = (id: string, restaurant: string | null, status: string, date: string | null, items: PickOrder["ingredient_list"]): PickOrder => ({
  id, status, restaurant_id: restaurant, delivery_date: date, ingredient_list: items,
});

const ORDERS: PickOrder[] = [
  o("aaaaaaa1", "r1", "confirmed", "2026-10-30", [{ name: "高麗菜", quantity: "5", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }]),
  o("aaaaaaa2", "r2", "accepted", "2026-10-30", [{ name: "高麗菜", quantity: "3.5", unit: "kg" }, { name: "吳郭魚", quantity: "3箱", unit: "" }]),
  o("aaaaaaa3", "r1", "dispatched", "2026-10-30", [{ name: "洋蔥", quantity: "9", unit: "kg" }]),
  o("aaaaaaa4", "r1", "rejected", "2026-10-30", [{ name: "洋蔥", quantity: "9", unit: "kg" }]),
  o("aaaaaaa5", "r2", "confirmed", "2026-10-31", [{ name: "高麗菜", quantity: "100", unit: "kg" }]),
  o("aaaaaaa6", "r2", "confirmed", null, [{ name: "高麗菜", quantity: "100", unit: "kg" }]),
];

describe("isPickable", () => {
  it("接單之後、送到之前才要備貨", () => {
    ["accepted", "quoted", "confirmed", "shipped", "in_transit"].forEach((s) => expect(isPickable({ status: s })).toBe(true));
    ["draft", "dispatched", "sent", "rejected", "cancelled", "expired", "delivered", "received"].forEach((s) => expect(isPickable({ status: s })).toBe(false));
  });
});

describe("buildPickList", () => {
  const r = buildPickList(ORDERS, "2026-10-30", NAMES);

  it("只算這個配送日、已接單的單;待接單的只提示張數", () => {
    expect(r.orderCount).toBe(2);
    expect(r.waitingCount).toBe(1);
  });

  it("出貨彙總:同品項同單位加總,算客戶數與訂單數,非純數字的數量不加總並標示", () => {
    expect(r.totals).toEqual([
      { name: "高麗菜", unit: "kg", quantity: 8.5, customers: 2, orders: 2, hasUnparsed: false },
      { name: "吳郭魚", unit: "", quantity: 0, customers: 1, orders: 1, hasUnparsed: true },
      { name: "雞蛋", unit: "箱", quantity: 2, customers: 1, orders: 1, hasUnparsed: false },
    ].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")));
  });

  it("揀貨單依客戶分組,帶訂單編號", () => {
    expect(r.lines.map((l) => [l.customer, l.orderNo, l.name, l.quantity, l.unit])).toEqual([
      ["好味小館", "#AAAAAAA1", "高麗菜", "5", "kg"],
      ["好味小館", "#AAAAAAA1", "雞蛋", "2", "箱"],
      ["阿財麵店", "#AAAAAAA2", "高麗菜", "3.5", "kg"],
      ["阿財麵店", "#AAAAAAA2", "吳郭魚", "3箱", ""],
    ]);
  });

  it("沒有訂單的日子是空的", () => {
    expect(buildPickList(ORDERS, "2026-12-25", NAMES)).toEqual({ orderCount: 0, totals: [], lines: [], waitingCount: 0 });
  });

  it("同一張單裡同品項重複只算一張單", () => {
    const x = buildPickList([o("bbbbbbb1", "r1", "confirmed", "2026-10-30", [{ name: "蔥", quantity: "1", unit: "斤" }, { name: "蔥", quantity: "2", unit: "斤" }])], "2026-10-30", NAMES);
    expect(x.totals).toEqual([{ name: "蔥", unit: "斤", quantity: 3, customers: 1, orders: 1, hasUnparsed: false }]);
  });
});

describe("CSV", () => {
  it("開頭有 BOM、表頭與資料列", () => {
    const r = buildPickList(ORDERS, "2026-10-30", NAMES);
    const totals = totalsCsv(r.totals).replace(/^\uFEFF/, "").split("\r\n");
    expect(totalsCsv(r.totals).startsWith("\uFEFF")).toBe(true);
    expect(totals[0]).toBe("品項,單位,總數量,客戶數,訂單數,備註");
    expect(totals).toContain("高麗菜,kg,8.5,2,2,");
    const lines = linesCsv(r.lines).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("客戶,訂單編號,品項,數量,單位");
    expect(lines[1]).toBe("好味小館,#AAAAAAA1,高麗菜,5,kg");
  });
});
