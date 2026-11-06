import { describe, expect, it } from "vitest";
import { DEFAULT_INPUT, DEFAULT_REDUCTIONS, MONTHLY_HOURS, ORDER_METHODS, calcSavings } from "./savings";

const r = Math.round;

describe("calcSavings", () => {
  // 對照 OrderUp B2B 隱形成本計算器的預設畫面(400 張、8 分鐘、月薪 42,000、出錯 8%、每次 600、對帳 16 小時、方案 5,880):
  // 打單 12,727、出錯 19,200、對帳 3,818、合計 35,745/月、年 428,945;省 24,015;淨效益 18,135;69 小時 ≈ 0.4 位全職
  it("公式與參考計算器的預設數字一致(同樣的輸入與 50 / 80 / 60 的減少比例)", () => {
    const x = calcSavings(
      { orders: 400, minutesPerOrder: 8, monthlySalary: 42000, errorRatePct: 8, costPerError: 600, reconcileHours: 16, platformFee: 5880 },
      { timePct: 50, errorPct: 80, reconcilePct: 60 },
    );
    expect([r(x.cost.typing), r(x.cost.errors), r(x.cost.reconcile), r(x.cost.total)]).toEqual([12727, 19200, 3818, 35745]);
    expect(r(x.yearlyCost)).toBe(428945);
    expect(r(x.hours)).toBe(69);
    expect(x.fte).toBeCloseTo(0.39, 2);
    expect(r(x.saved.total)).toBe(24015);
    expect(r(x.net)).toBe(18135);
  });

  it("預設值:單價、時薪與各項成本", () => {
    const x = calcSavings(DEFAULT_INPUT, DEFAULT_REDUCTIONS);
    expect(x.hourlyCost).toBeCloseTo(40000 / MONTHLY_HOURS, 6);
    expect(r(x.cost.typing)).toBe(12121); // 400 張 × 8 分鐘 = 53.3 小時 × 227
    expect(x.cost.errors).toBe(19200); // 400 × 8% × 600
    expect(x.cost.reconcile).toBe(0);
    expect(r(x.cost.total)).toBe(31321);
    expect(r(x.yearlyCost)).toBe(375855);
    expect(x.fte).toBeCloseTo(0.3, 1);
    expect(x.saved.total).toBeCloseTo(x.cost.total / 2, 6); // 各項都減少一半
    expect(x.net).toBe(x.saved.total); // 沒有平台費用
    expect(x.netYearly).toBeCloseTo(x.net * 12, 6);
  });

  it("平台費用大於省下的:淨效益是負的,不騙人", () => {
    const x = calcSavings({ ...DEFAULT_INPUT, orders: 10, platformFee: 5000 });
    expect(x.net).toBeLessThan(0);
  });

  it("減少 0% 就省 0;減少超過 100% 以 100% 算", () => {
    expect(calcSavings(DEFAULT_INPUT, { timePct: 0, errorPct: 0, reconcilePct: 0 }).saved.total).toBe(0);
    const all = calcSavings(DEFAULT_INPUT, { timePct: 500, errorPct: 100, reconcilePct: 1e9 });
    expect(all.saved.total).toBeCloseTo(all.cost.total, 6);
  });

  it("亂填(負數、NaN、空白):當成 0,不會算出 NaN 或負的成本", () => {
    const x = calcSavings({ orders: -5, minutesPerOrder: Number.NaN, monthlySalary: -1, errorRatePct: -3, costPerError: Number.POSITIVE_INFINITY, reconcileHours: -2, platformFee: -9 });
    expect(x.cost.total).toBe(0);
    expect(x.net).toBe(0);
    expect(Number.isNaN(x.fte)).toBe(false);
  });
});

describe("接單方式", () => {
  it("LINE 8 分鐘、電話 12 分鐘、其他 10 分鐘;預設是 LINE", () => {
    expect(ORDER_METHODS.map((m) => [m.key, m.minutes])).toEqual([["line", 8], ["phone", 12], ["other", 10]]);
    expect(DEFAULT_INPUT.minutesPerOrder).toBe(ORDER_METHODS[0].minutes);
  });
});
