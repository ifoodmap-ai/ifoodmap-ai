// 前端的縣市、分類、溫層必須跟資料庫一字不差:直接解析 migration 標記之間的字串比對。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKET_CATEGORIES, TEMPERATURE_KEYS, TW_CITIES, isCategoryKey, isTemperature, isTwCity } from "./constants";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20261009120000_market_catalog.sql"),
  "utf8",
);

/** migration 裡「單獨一行」的 -- @name-begin 到 -- @name-end 之間所有單引號字串 */
const quotedBetween = (name: string): string[] => {
  const begin = MIGRATION.search(new RegExp(`^\\s*-- @${name}-begin\\s*$`, "m"));
  const end = MIGRATION.search(new RegExp(`^\\s*-- @${name}-end\\s*$`, "m"));
  expect(begin, `${name}-begin`).toBeGreaterThan(-1);
  expect(end, `${name}-end`).toBeGreaterThan(begin);
  return [...MIGRATION.slice(begin, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("市集常數與 migration 一致", () => {
  it("22 縣市,順序與寫法跟 market_tw_cities() 一樣", () => {
    expect(TW_CITIES).toHaveLength(22);
    expect([...TW_CITIES]).toEqual(quotedBetween("market-cities"));
  });

  it("12 個分類 key 跟 market_products 的 CHECK 一樣", () => {
    expect(MARKET_CATEGORIES.map((c) => c.key)).toEqual(quotedBetween("market-categories"));
  });

  it("溫層 key 跟 CHECK 一樣", () => {
    expect(TEMPERATURE_KEYS).toEqual(quotedBetween("market-temperatures"));
  });

  it("型別守衛只認清單裡的值", () => {
    expect(isTwCity("臺北市")).toBe(true);
    expect(isTwCity("台北市")).toBe(false);
    expect(isCategoryKey("meat")).toBe(true);
    expect(isCategoryKey("alcohol")).toBe(false);
    expect(isTemperature("frozen")).toBe(true);
    expect(isTemperature(null)).toBe(false);
  });

  it("飲品分類標明不含酒(市集不賣酒)", () => {
    expect(MARKET_CATEGORIES.find((c) => c.key === "drink")?.label).toBe("飲品（不含酒）");
  });
});
