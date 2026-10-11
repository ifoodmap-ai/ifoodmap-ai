// 前端的縣市、分類、溫層必須跟資料庫一字不差:直接解析 migration 標記之間的字串比對。
// 長度 / 金額上限、照片張數、付款方式、審核狀態、bucket 設定也從 migration 120000 / 120100 讀出來比對 —— 改了任何一邊這裡都會紅。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIMITS,
  MARKET_CATEGORIES,
  MARKET_IMAGE_BUCKET,
  PAYMENT_METHODS,
  PHOTO_RULES,
  REVIEW_STATUS_LABEL,
  TEMPERATURE_KEYS,
  TW_CITIES,
  isCategoryKey,
  isTemperature,
  isTwCity,
} from "./constants";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20261009120000_market_catalog.sql"),
  "utf8",
);
const STORAGE_MIGRATION = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20261009120100_market_images_storage.sql"),
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

// ---------------------------------------------------------------------
// 上限與設定:每一個數字都從 migration 讀(寫法必須剛好出現一處,migration 改了格式這裡會紅、要回來更新)
// ---------------------------------------------------------------------
/** sql 裡 re 剛好一處符合 */
const onlyMatch = (sql: string, re: RegExp): RegExpMatchArray => {
  const hits = [...sql.matchAll(re)];
  if (hits.length !== 1) throw new Error(`migration 裡「${re.source}」應該剛好一處,實際 ${hits.length} 處`);
  return hits[0];
};
/** prefix(正規式原文)後面緊接的整數 */
const numberAfter = (prefix: string) => new RegExp(`(${prefix})(\\d+)`, "g");
const readNumber = (sql: string, prefix: string) => Number(onlyMatch(sql, numberAfter(prefix))[2]);
const bumpNumber = (sql: string, prefix: string) =>
  sql.replace(numberAfter(prefix), (_whole, p: string, n: string) => `${p}${Number(n) + 1}`);
const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** LIMITS 的每個 key 在 migration 120000 的哪一句 CHECK(數字緊接在 prefix 後面) */
const LIMIT_PREFIXES: Array<[keyof typeof LIMITS, string]> = [
  ["productName", "char_length\\(name\\) BETWEEN \\d+ AND "],
  ["spec", "char_length\\(spec\\) BETWEEN \\d+ AND "],
  ["origin", "char_length\\(origin\\) <= "],
  ["storageMethod", "char_length\\(storage_method\\) <= "],
  ["shelfLife", "char_length\\(shelf_life\\) <= "],
  ["description", "char_length\\(description\\) <= "],
  ["rejectReason", "char_length\\(reject_reason\\) <= "],
  ["storeIntro", "char_length\\(intro\\) <= "],
  ["returnPolicy", "char_length\\(return_policy\\) <= "],
  ["transferInfoMin", "char_length\\(transfer_info\\) BETWEEN "],
  ["transferInfo", "char_length\\(transfer_info\\) BETWEEN \\d+ AND "],
  ["disabledReason", "char_length\\(disabled_reason\\) <= "],
  ["price", "\\bprice BETWEEN \\d+ AND "],
  ["stock", "\\bstock BETWEEN \\d+ AND "],
  ["shippingFee", "\\bshipping_fee BETWEEN \\d+ AND "],
  ["freeShippingThreshold", "\\bfree_shipping_threshold BETWEEN \\d+ AND "],
  ["minOrderAmount", "\\bmin_order_amount BETWEEN \\d+ AND "],
  ["shipDays", "\\bship_days BETWEEN \\d+ AND "],
];
const PHOTO_COUNT_PREFIX = "cardinality\\(photos\\) <= ";
const BUCKET_RE =
  /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s*VALUES \('([^']+)', '[^']+', (true|false), (\d+), ARRAY\[([^\]]*)\]\)/g;

describe("上限與設定跟 migration 一致", () => {
  it("LIMITS 每一個上限都等於 migration 120000 的 CHECK(多一個 key、少一個 key 都會紅)", () => {
    const fromMigration = Object.fromEntries(LIMIT_PREFIXES.map(([key, prefix]) => [key, readNumber(MIGRATION, prefix)]));
    expect(fromMigration).toEqual({ ...LIMITS });
  });

  it("照片最多 5 張、縣市最多 22 個 = migration 的 cardinality", () => {
    expect(readNumber(MIGRATION, PHOTO_COUNT_PREFIX)).toBe(PHOTO_RULES.maxCount);
    expect(readNumber(MIGRATION, "cardinality\\(delivery_cities\\) BETWEEN \\d+ AND ")).toBe(TW_CITIES.length);
  });

  it("付款方式、審核狀態 = migration 的 CHECK 清單", () => {
    const payment = onlyMatch(MIGRATION, /payment_methods <@ ARRAY\[([^\]]+)\]/g);
    expect(quoted(payment[1])).toEqual(Object.keys(PAYMENT_METHODS));
    expect(readNumber(MIGRATION, "cardinality\\(payment_methods\\) BETWEEN \\d+ AND ")).toBe(Object.keys(PAYMENT_METHODS).length);
    const review = onlyMatch(MIGRATION, /CHECK \(review_status IN \(([^)]+)\)\)/g);
    expect(quoted(review[1])).toEqual(Object.keys(REVIEW_STATUS_LABEL));
  });

  it("bucket = migration 120100:market-images、公開、2 MB、JPG / PNG / WebP", () => {
    const [, id, isPublic, size, mimes] = onlyMatch(STORAGE_MIGRATION, BUCKET_RE);
    expect(id).toBe(MARKET_IMAGE_BUCKET);
    expect(isPublic).toBe("true");
    expect(Number(size)).toBe(PHOTO_RULES.maxBytes);
    expect(quoted(mimes)).toEqual([...PHOTO_RULES.inputTypes]);
  });

  it("數字真的是從 migration 讀出來的:migration 任何一個數字改了,讀到的值就跟著變(比對會紅)", () => {
    for (const [key, prefix] of LIMIT_PREFIXES) {
      expect(readNumber(bumpNumber(MIGRATION, prefix), prefix), key).toBe(LIMITS[key] + 1);
    }
    expect(readNumber(bumpNumber(MIGRATION, PHOTO_COUNT_PREFIX), PHOTO_COUNT_PREFIX)).toBe(PHOTO_RULES.maxCount + 1);
  });
});
