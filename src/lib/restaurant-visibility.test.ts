import { describe, expect, it } from "vitest";
import { ROLE_VISIBILITY_HINT, visibilityText } from "./restaurant-visibility";

describe("visibilityText", () => {
  it("老闆:一律看全部,就算被指派了分店", () => {
    expect(visibilityText("owner", null)).toBe("所有分店的訂單、價格與報表");
    expect(visibilityText("owner", "中正店")).toBe("所有分店的訂單、價格與報表");
  });

  it("店長:指派了分店只看那家的訂單與價格;沒指派看全部並提醒", () => {
    expect(visibilityText("manager", "中正店")).toBe("「中正店」的訂單與價格;其他分店的看不到");
    expect(visibilityText("manager", null)).toContain("所有分店的訂單與價格");
    expect(visibilityText("manager", null)).toContain("還沒指派分店");
  });

  it("採購員:只看品項與數量、不顯示價格與金額;指派分店只看那一家", () => {
    expect(visibilityText("purchaser", "信義店")).toBe("「信義店」的訂單,只看品項與數量,不顯示單價與金額");
    expect(visibilityText("purchaser", null)).toContain("建議指派分店");
    expect(visibilityText("purchaser", null)).toContain("不顯示單價與金額");
  });

  it("角色說明三種都有;採購員那句明講看不到價格", () => {
    expect(Object.keys(ROLE_VISIBILITY_HINT).sort()).toEqual(["manager", "owner", "purchaser"]);
    expect(ROLE_VISIBILITY_HINT.purchaser).toContain("看不到價格");
  });
});
