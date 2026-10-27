import { describe, expect, it } from "vitest";
import { buildSupplyImageLookup, normalizeItemName, supplyImageUrl } from "./supply-images";

const SUP = "10000000-0000-0000-0000-00000000000a";
const ITEM = "40000000-0000-0000-0000-000000000001";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("supplyImageUrl", () => {
  it("沒有路徑回 null", () => {
    expect(supplyImageUrl(null)).toBeNull();
    expect(supplyImageUrl(undefined, true)).toBeNull();
    expect(supplyImageUrl("")).toBeNull();
  });

  it("主圖是公開網址;縮圖是同資料夾的 _t.jpg", () => {
    const path = `${SUP}/${ITEM}/${FILE}.jpg`;
    expect(supplyImageUrl(path)).toContain(`/storage/v1/object/public/market-images/${SUP}/${ITEM}/${FILE}.jpg`);
    expect(supplyImageUrl(path, true)).toContain(`/storage/v1/object/public/market-images/${SUP}/${ITEM}/${FILE}_t.jpg`);
  });
});

describe("normalizeItemName", () => {
  it("全形半形、大小寫、空白都不影響", () => {
    expect(normalizeItemName(" 高麗菜 ")).toBe("高麗菜");
    expect(normalizeItemName("高 麗　菜")).toBe("高麗菜");
    expect(normalizeItemName("ＡＢ Cut")).toBe("abcut");
  });
});

describe("buildSupplyImageLookup", () => {
  const lookup = buildSupplyImageLookup([
    { supplier_id: "s1", name: "高麗菜", image_path: "s1/p1/a.jpg" },
    { supplier_id: "s2", name: "高麗菜", image_path: "s2/p2/b.jpg" },
    { supplier_id: "s2", name: "雞蛋", image_path: "s2/p3/c.jpg" },
    { supplier_id: "s1", name: "洋蔥", image_path: null },
  ]);

  it("優先配同一家供應商的同名商品", () => {
    expect(lookup("高麗菜", "s1")).toBe("s1/p1/a.jpg");
    expect(lookup("高麗菜", "s2")).toBe("s2/p2/b.jpg");
  });

  it("同一家沒有,就用任何一家的同名商品;沒指定供應商也能配", () => {
    expect(lookup("雞蛋", "s1")).toBe("s2/p3/c.jpg");
    expect(lookup("雞蛋")).toBe("s2/p3/c.jpg");
  });

  it("品名要一樣才配;名字差一點、沒有圖片、空白品名都配不到", () => {
    expect(lookup("高麗菜心", "s1")).toBeNull();
    expect(lookup("洋蔥", "s1")).toBeNull();
    expect(lookup("   ")).toBeNull();
    expect(lookup(" 高 麗 菜 ", "s1")).toBe("s1/p1/a.jpg");
  });
});
