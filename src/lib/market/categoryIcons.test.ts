// 12 個分類都有圖示,而且引用的是形象站的那一份 SVG(檔案真的存在、檔名對得上)。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_ICON } from "./categoryIcons";
import { MARKET_CATEGORIES } from "./constants";

describe("分類圖示", () => {
  it("每個分類都有一個非空的圖示網址", () => {
    for (const c of MARKET_CATEGORIES) {
      expect(typeof CATEGORY_ICON[c.key], c.key).toBe("string");
      expect(CATEGORY_ICON[c.key].length, c.key).toBeGreaterThan(0);
    }
  });

  it("圖示檔就是形象站 landing/assets/cat-<key>.svg", () => {
    for (const c of MARKET_CATEGORIES) {
      expect(existsSync(resolve(__dirname, `../../../landing/assets/cat-${c.key}.svg`)), c.key).toBe(true);
      expect(CATEGORY_ICON[c.key]).toMatch(new RegExp(`cat-${c.key}\\.svg|^data:image/svg\\+xml`));
    }
  });
});
