import { describe, expect, it } from "vitest";
import { TW_CITIES } from "./constants";
import {
  citiesSummary,
  formatTaipei,
  formatTwd,
  minOrderSummary,
  shipDaysSummary,
  shippingSummary,
  stockLabel,
} from "./format";

describe("format", () => {
  it("金額:NT$ 加千分位", () => {
    expect(formatTwd(3200)).toBe("NT$ 3,200");
    expect(formatTwd(0)).toBe("NT$ 0");
  });

  it("運費:免運、固定運費、滿額免運", () => {
    expect(shippingSummary({ shipping_fee: 0, free_shipping_threshold: null })).toBe("免運費");
    expect(shippingSummary({ shipping_fee: 120, free_shipping_threshold: null })).toBe("運費 NT$ 120");
    expect(shippingSummary({ shipping_fee: 120, free_shipping_threshold: 1000 })).toBe("運費 NT$ 120,滿 NT$ 1,000 免運");
  });

  it("最低訂購金額與出貨天數", () => {
    expect(minOrderSummary({ min_order_amount: 0 })).toBe("沒有最低訂購金額");
    expect(minOrderSummary({ min_order_amount: 300 })).toBe("滿 NT$ 300 才能下單");
    expect(shipDaysSummary(0)).toBe("當天出貨");
    expect(shipDaysSummary(2)).toBe("2 個工作天內出貨");
  });

  it("配送縣市:22 個全選就寫全台配送", () => {
    expect(citiesSummary(["臺北市", "新北市"])).toBe("臺北市、新北市");
    expect(citiesSummary(TW_CITIES)).toBe("全台配送");
  });

  it("庫存:不限、售完、剩幾件", () => {
    expect(stockLabel(null)).toBe("現貨");
    expect(stockLabel(0)).toBe("已售完");
    expect(stockLabel(3)).toBe("剩 3 件");
    expect(stockLabel(30)).toBe("現貨");
  });

  it("台北時間", () => {
    expect(formatTaipei("2026-10-09T04:05:00Z")).toBe("2026/10/09 12:05");
    expect(formatTaipei(null)).toBe("—");
    expect(formatTaipei("壞掉")).toBe("—");
  });
});
