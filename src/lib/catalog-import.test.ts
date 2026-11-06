import { describe, expect, it } from "vitest";
import { catalogCsv, planImport, templateCsv, MAX_ROWS, type CatalogRow } from "./catalog-import";

const row = (o: Partial<CatalogRow> & { id: string; name: string }): CatalogRow => ({
  category: null, sku: null, unit: null, pack_size: null, price: null, description: null, is_available: true, ...o,
});
const EXISTING: CatalogRow[] = [
  row({ id: "a", name: "高麗菜", sku: "VEG-001", category: "蔬菜", unit: "kg", price: 45 }),
  row({ id: "b", name: "雞蛋", unit: "箱", price: 620 }),
  row({ id: "c", name: "吳郭魚", sku: "FISH-1" }),
  row({ id: "d", name: "吳郭魚", sku: "FISH-2" }),
];
const H = "商品名稱,貨號,分類,單位,規格,定價,說明,上架\r\n";

describe("匯出與範本", () => {
  it("匯出的檔案可以直接再匯入、而且沒有任何變動", () => {
    const plan = planImport(catalogCsv(EXISTING), EXISTING);
    expect(plan.errors).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(4);
  });

  it("範本匯入空目錄:兩個範例商品都是新增", () => {
    const plan = planImport(templateCsv(), []);
    expect(plan.errors).toEqual([]);
    expect(plan.creates.map((c) => c.fields.name)).toEqual(["高麗菜", "雞蛋"]);
    expect(plan.creates[0].fields).toMatchObject({ sku: "VEG-001", price: 45, is_available: true, pack_size: "每箱 10kg" });
  });
});

describe("比對:貨號優先,其次品名", () => {
  it("貨號對得到就更新那個商品(品名可以順便改);只列出有變的欄位", () => {
    const plan = planImport(`${H}高麗菜(新),veg-001,,,,48,,`, EXISTING);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: "a", patch: { name: "高麗菜(新)", price: 48 } });
    expect(plan.updates[0].changes.map((c) => `${c.label}:${c.from}→${c.to}`)).toEqual(["商品名稱:高麗菜→高麗菜(新)", "定價:45→48"]);
  });

  it("沒填貨號就用品名(全形半形、大小寫、空白不影響),空白儲存格不動現有的值", () => {
    const plan = planImport(`${H}雞 蛋,,,,,650,,`, EXISTING);
    expect(plan.updates[0]).toMatchObject({ id: "b", patch: { price: 650 } });
    expect(plan.updates[0].patch.unit).toBeUndefined();
  });

  it("現有商品沒有貨號、匯入檔補上貨號 → 更新原商品,不是新增", () => {
    const plan = planImport(`${H}雞蛋,EGG-010,,,,,,`, EXISTING);
    expect(plan.creates).toEqual([]);
    expect(plan.updates[0]).toMatchObject({ id: "b", patch: { sku: "EGG-010" } });
  });

  it("同名但貨號不同 = 不同規格的商品,另外新增", () => {
    const plan = planImport(`${H}高麗菜,VEG-002,蔬菜,kg,,50,,`, EXISTING);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].fields).toMatchObject({ name: "高麗菜", sku: "VEG-002", price: 50 });
  });

  it("目錄裡有好幾個同名商品又沒填貨號:報錯請填貨號,不亂猜", () => {
    const plan = planImport(`${H}吳郭魚,,,,,100,,`, EXISTING);
    expect(plan.updates).toEqual([]);
    expect(plan.errors).toEqual([{ line: 2, message: "「吳郭魚」在目錄裡有 2 個同名商品,請填貨號指定要更新哪一個" }]);
  });

  it("內容一樣的列算「沒變」,不會寫入", () => {
    const plan = planImport(`${H}高麗菜,VEG-001,蔬菜,kg,,45,,是`, EXISTING);
    expect(plan.unchanged).toBe(1);
    expect(plan.updates).toEqual([]);
  });
});

describe("欄位檢查", () => {
  it("定價:支援 NT$ / $ / 千分位;0、負數、文字報錯並指出列號,其他列照常處理", () => {
    const plan = planImport(`${H}新商品A,,,,,"NT$1,200",,\r\n新商品B,,,,,0,,\r\n新商品C,,,,,貴,,\r\n新商品D,,,,,$30,,`, []);
    expect(plan.creates.map((c) => [c.fields.name, c.fields.price])).toEqual([["新商品A", 1200], ["新商品D", 30]]);
    expect(plan.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(plan.errors[0].message).toContain("定價要是大於 0 的數字");
  });

  it("上架:是 / 否 / Y / N / 上架 / 下架;別的字報錯;新增沒寫預設上架", () => {
    const plan = planImport(`${H}A,,,,,,,否\r\nB,,,,,,,Y\r\nC,,,,,,,也許\r\nD,,,,,,,`, []);
    expect(plan.creates.map((c) => [c.fields.name, c.fields.is_available])).toEqual([["A", false], ["B", true], ["D", true]]);
    expect(plan.errors).toEqual([{ line: 4, message: "「C」的「上架」要寫「是」或「否」" }]);
  });

  it("品名空白、過長都報錯;檔案內重複的商品只收第一列", () => {
    const plan = planImport(`${H},,,,,10,,\r\n${"長".repeat(101)},,,,,,,\r\n甲,S1,,,,,,\r\n甲,S1,,,,,,\r\n乙,,,,,,,\r\n乙,,,,,,,`, []);
    expect(plan.creates.map((c) => c.fields.name)).toEqual(["甲", "乙"]);
    expect(plan.errors.map((e) => [e.line, e.message])).toEqual([
      [2, "商品名稱是空的"],
      [3, expect.stringContaining("商品名稱太長")],
      [5, "「甲」重複出現(同一個商品只能一列)"],
      [7, "「乙」重複出現(同一個商品只能一列)"],
    ]);
  });

  it("同一個現有商品在檔案裡出現兩次(貨號一次、品名一次):第二次報重複", () => {
    const plan = planImport(`${H}高麗菜,VEG-001,,,,46,,\r\n高麗菜,VEG-001,,,,47,,`, EXISTING);
    expect(plan.updates).toHaveLength(1);
    expect(plan.errors[0]).toMatchObject({ line: 3 });
  });

  it("欄位名稱容許同義詞(商品 / 品名、單價、備註),只留需要的欄位也行", () => {
    const plan = planImport("品名,單價\r\n芭樂,35", []);
    expect(plan.creates[0].fields).toMatchObject({ name: "芭樂", price: 35, sku: null });
  });

  it("沒有商品名稱欄、空檔、只有表頭、超過上限:整份擋下並說明", () => {
    expect(planImport("貨號,定價\r\nA,1", []).errors[0].message).toContain("找不到「商品名稱」欄");
    expect(planImport("", []).errors[0].message).toBe("檔案是空的");
    expect(planImport(H, []).errors[0].message).toContain("沒有商品");
    const big = H + Array.from({ length: MAX_ROWS + 1 }, (_, i) => `P${i}`).join("\r\n");
    const plan = planImport(big, []);
    expect(plan.errors[0].message).toContain(`最多匯入 ${MAX_ROWS} 列`);
    expect(plan.creates).toEqual([]);
  });
});
