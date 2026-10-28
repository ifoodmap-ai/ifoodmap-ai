import { describe, expect, it } from "vitest";
import {
  effectivePrices, estimateTotal, importSheet, limitOf, limitText, matchCatalog, parseCsv, parseQty, priceOf, sheetCsv, suggestQuote,
  type CatalogItem, type CustomerLimit,
} from "./pricing";

const CATALOG: CatalogItem[] = [
  { id: "p1", name: "高麗菜", sku: "VEG-001", unit: "kg", price: 45 },
  { id: "p2", name: "雞蛋", sku: null, unit: "箱", price: 620 },
  { id: "p3", name: "吳郭魚", sku: null, unit: "kg", price: null },
];
const SPECIAL = new Map([["p1", 40]]);

describe("配對與單價", () => {
  it("品名全形半形、大小寫、空白不影響;配不到回 null", () => {
    expect(matchCatalog(" 高 麗菜 ", CATALOG)?.id).toBe("p1");
    expect(matchCatalog("高麗菜心", CATALOG)).toBeNull();
    expect(matchCatalog("  ", CATALOG)).toBeNull();
  });

  it("有專屬價用專屬價,沒有用定價,都沒有是 null", () => {
    expect(priceOf("高麗菜", CATALOG, SPECIAL)).toMatchObject({ unitPrice: 40, source: "customer" });
    expect(priceOf("雞蛋", CATALOG, SPECIAL)).toMatchObject({ unitPrice: 620, source: "list" });
    expect(priceOf("吳郭魚", CATALOG, SPECIAL)).toMatchObject({ unitPrice: null, source: null });
    expect(priceOf("牛肉", CATALOG, SPECIAL)).toMatchObject({ supply: null, unitPrice: null });
  });

  it("群組價打底、客戶專屬價蓋過去;都沒有才落到定價", () => {
    const group = new Map([["p1", 42], ["p2", 600]]);
    const merged = effectivePrices(group, SPECIAL);
    expect(merged.get("p1")).toBe(40); // 專屬價 > 群組價
    expect(merged.get("p2")).toBe(600); // 只有群組價
    expect(priceOf("雞蛋", CATALOG, merged)).toMatchObject({ unitPrice: 600, source: "customer" });
    expect(priceOf("吳郭魚", CATALOG, merged)).toMatchObject({ unitPrice: null }); // 都沒有且沒定價
    expect(effectivePrices(new Map(), new Map()).size).toBe(0);
  });

  it("parseQty 只收純數字", () => {
    expect(parseQty("5")).toBe(5);
    expect(parseQty(" 2.5 ")).toBe(2.5);
    expect(parseQty("3箱")).toBeNull();
    expect(parseQty("")).toBeNull();
    expect(parseQty(null)).toBeNull();
  });
});

describe("預估與報價預填", () => {
  it("預估金額:算得出來的加總,算不出來的(沒單價、數量不是純數字、不在目錄)另外計數", () => {
    const e = estimateTotal(
      [{ name: "高麗菜", quantity: "10" }, { name: "雞蛋", quantity: "2" }, { name: "吳郭魚", quantity: "3" }, { name: "牛肉", quantity: "1" }, { name: "雞蛋", quantity: "兩箱" }],
      CATALOG,
      SPECIAL,
    );
    expect(e).toEqual({ total: 1640, priced: 2, unpriced: 3 });
  });

  it("小數不會有浮點誤差", () => {
    expect(estimateTotal([{ name: "高麗菜", quantity: "0.3" }], CATALOG, new Map([["p1", 0.1]])).total).toBe(0.03);
  });

  it("報價預填:每個品項都算得出來才給金額;只算得出一部分就不給(避免當成完整金額)", () => {
    expect(suggestQuote([{ name: "高麗菜", quantity: "10" }, { name: "雞蛋", quantity: "2" }], CATALOG, SPECIAL)).toBe(1640);
    expect(suggestQuote([{ name: "高麗菜", quantity: "10" }, { name: "吳郭魚", quantity: "2" }], CATALOG, SPECIAL)).toBeNull();
    expect(suggestQuote([], CATALOG, SPECIAL)).toBeNull();
  });
});

describe("數量上限", () => {
  const LIMITS: CustomerLimit[] = [{ supply_id: "p1", period: "week", max_qty: 50 }];
  it("依品名找到那個商品的上限;沒設的回 null", () => {
    expect(limitOf("高麗菜", CATALOG, LIMITS)?.limit.max_qty).toBe(50);
    expect(limitOf("雞蛋", CATALOG, LIMITS)).toBeNull();
    expect(limitOf("牛肉", CATALOG, LIMITS)).toBeNull();
  });
  it("limitText", () => {
    expect(limitText({ period: "week", max_qty: 50 }, "kg")).toBe("每週上限 50kg");
    expect(limitText({ period: "day", max_qty: 12.5 })).toBe("每日上限 12.5");
  });
});

describe("CSV 解析", () => {
  it("引號、逗號、換行、跳脫、BOM、CRLF", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,y","say ""hi"""\r\n"l1\nl2",3\r\n\r\n')).toEqual([["a", "b"], ["x,y", 'say "hi"'], ["l1\nl2", "3"]]);
    expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("價格表匯出入", () => {
  it("匯出再匯入得到同樣的內容(來回一致)", () => {
    const csv = sheetCsv([
      { supply: CATALOG[0], price: 40, limit: { period: "week", max_qty: 50 } },
      { supply: CATALOG[1], price: null, limit: null },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const r = importSheet(csv, CATALOG);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { supplyId: "p1", name: "高麗菜", price: 40, limit: { period: "week", max_qty: 50 } },
      { supplyId: "p2", name: "雞蛋", price: null, limit: null },
    ]);
  });

  it("只留需要的欄位也能匯入;品名用目錄的名字;期別沒寫預設每日;客戶價可以寫 NT$ 與千分位", () => {
    const r = importSheet('商品,客戶價,數量上限\n 高麗 菜 ,"NT$ 1,040.5",12\n', CATALOG);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ supplyId: "p1", name: "高麗菜", price: 1040.5, limit: { period: "day", max_qty: 12 } }]);
  });

  it("看不懂的列只跳過那一列並說明原因,其他列照收", () => {
    const text = [
      "商品,客戶價,數量上限,上限期別",
      "高麗菜,40,,",
      "牛肉,100,,",
      "雞蛋,abc,,",
      "吳郭魚,,0,每日",
      "高麗菜,41,,",
      "雞蛋,,5,每月",
      ",,,",
    ].join("\n");
    const r = importSheet(text, CATALOG);
    expect(r.rows.map((x) => x.name)).toEqual(["高麗菜"]);
    expect(r.errors).toEqual([
      { line: 3, message: "「牛肉」不在你的商品目錄裡" },
      { line: 4, message: "「雞蛋」的客戶價要是大於 0 的數字" },
      { line: 5, message: "「吳郭魚」的數量上限要是大於 0 的數字" },
      { line: 6, message: "「高麗菜」重複出現,只能一列" },
      { line: 7, message: "「雞蛋」的上限期別要寫「每日」或「每週」" },
    ]);
  });

  it("沒有「商品」欄、或沒有可套用的欄位:整份拒絕", () => {
    expect(importSheet("name,price\na,1", CATALOG).errors[0].message).toContain("找不到「商品」欄");
    expect(importSheet("商品,單位\n高麗菜,kg", CATALOG).errors[0].message).toContain("找不到「客戶價」或「數量上限」欄");
    expect(importSheet("", CATALOG).errors[0].message).toBe("檔案是空的");
  });
});
