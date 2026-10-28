import { describe, expect, it } from "vitest";
import {
  addDays, checkDeliveryDate, cutoffFor, deliveryLabel, describeRules, earliestDeliveryDate, taipeiNow, weekdayOf,
  type OrderRules,
} from "./delivery";

// 2026-10-28(週三)台灣時間 21:30 = UTC 13:30
const NOW = new Date("2026-10-28T13:30:00Z");
const RULES: OrderRules = { cutoff_time: "22:00:00", lead_days: 1, delivery_weekdays: [1, 2, 3, 4, 5, 6] };

describe("台灣時間", () => {
  it("不管電腦時區,都用台灣的日期與時間", () => {
    expect(taipeiNow(NOW)).toEqual({ date: "2026-10-28", time: "21:30" });
    // UTC 還是前一天,台灣已經是隔天凌晨
    expect(taipeiNow(new Date("2026-10-28T17:00:00Z"))).toEqual({ date: "2026-10-29", time: "01:00" });
    expect(taipeiNow(new Date("2026-10-28T16:00:00Z"))).toEqual({ date: "2026-10-29", time: "00:00" });
  });

  it("日期運算與星期", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayOf("2026-10-28")).toBe(3);
    expect(weekdayOf("2026-11-01")).toBe(0);
  });
});

describe("checkDeliveryDate(跟資料庫同一套規則)", () => {
  it("沒有接單規則:可以不選;選了不能是過去", () => {
    expect(checkDeliveryDate("", null, NOW)).toBe("ok");
    expect(checkDeliveryDate("2026-10-28", null, NOW)).toBe("ok");
    expect(checkDeliveryDate("2026-10-27", null, NOW)).toBe("past");
    expect(checkDeliveryDate("2026/10/30", null, NOW)).toBe("invalid");
  });

  it("有接單規則:一定要選", () => {
    expect(checkDeliveryDate("", RULES, NOW)).toBe("required");
  });

  it("提前 1 天、22:00 截單:現在 21:30,明天(週四)的配送日還來得及;今晚過了 22:00 就不行", () => {
    expect(checkDeliveryDate("2026-10-29", RULES, NOW)).toBe("ok");
    const late = new Date("2026-10-28T14:01:00Z"); // 22:01
    expect(checkDeliveryDate("2026-10-29", RULES, late)).toBe("cutoff");
    expect(checkDeliveryDate("2026-10-30", RULES, late)).toBe("ok");
  });

  it("剛好在截單時間那一分鐘還來得及(資料庫是 > 才擋)", () => {
    const exact = new Date("2026-10-28T14:00:00Z"); // 22:00
    expect(checkDeliveryDate("2026-10-29", RULES, exact)).toBe("ok");
  });

  it("當天截單(提前 0 天)", () => {
    const sameDay: OrderRules = { cutoff_time: "10:00", lead_days: 0, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(checkDeliveryDate("2026-10-28", sameDay, NOW)).toBe("cutoff"); // 現在 21:30,今天 10:00 已過
    expect(checkDeliveryDate("2026-10-28", sameDay, new Date("2026-10-28T01:00:00Z"))).toBe("ok"); // 台灣 09:00
  });

  it("那天不配送(週日)", () => {
    expect(checkDeliveryDate("2026-11-01", RULES, NOW)).toBe("weekday");
  });
});

describe("earliestDeliveryDate", () => {
  it("今晚還沒截單 → 明天;截單後 → 後天;遇到休息日就跳過", () => {
    expect(earliestDeliveryDate(RULES, NOW)).toBe("2026-10-29");
    expect(earliestDeliveryDate(RULES, new Date("2026-10-28T14:30:00Z"))).toBe("2026-10-30");
    // 週六晚上 22:30 → 週日不配送,最早是下週一
    expect(earliestDeliveryDate(RULES, new Date("2026-10-31T14:30:00Z"))).toBe("2026-11-02");
  });

  it("沒有規則就是今天", () => {
    expect(earliestDeliveryDate(null, NOW)).toBe("2026-10-28");
  });

  it("規則不可能達成時回 null", () => {
    // 只有一個星期幾配送也一定找得到;這裡用空陣列模擬壞資料
    expect(earliestDeliveryDate({ ...RULES, delivery_weekdays: [] }, NOW)).toBeNull();
  });
});

describe("說明文字", () => {
  it("describeRules", () => {
    expect(describeRules(RULES)).toBe("配送日前 1 天 22:00 截單 · 週一至週六配送");
    expect(describeRules({ cutoff_time: "10:30:00", lead_days: 0, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("配送當天 10:30 截單 · 每天配送");
    expect(describeRules({ cutoff_time: "20:00", lead_days: 2, delivery_weekdays: [1, 3, 5] })).toBe("配送日前 2 天 20:00 截單 · 週一、週三、週五配送");
    expect(describeRules({ cutoff_time: "20:00", lead_days: 1, delivery_weekdays: [6, 0, 1, 2] })).toBe("配送日前 1 天 20:00 截單 · 週日至週二、週六配送");
  });

  it("cutoffFor 與 deliveryLabel", () => {
    expect(cutoffFor("2026-10-30", RULES)).toEqual({ date: "2026-10-29", time: "22:00" });
    expect(deliveryLabel("2026-10-30")).toBe("2026-10-30(週五)");
    expect(deliveryLabel(null)).toBeNull();
    expect(deliveryLabel("亂寫")).toBeNull();
  });
});
