(function (root, factory) {
  var savings = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = savings;
  }

  if (root) {
    root.IfmSavings = savings;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  // /suppliers「接單與報價作業成本」試算的算法。畫面只負責輸入與呈現,數字全在這裡算(tests/savings.test.cjs 釘住)。
  //
  // 算法就是「件數 × 每件時間 × 時薪」這種一般的成本估算,沒有任何隱藏係數:
  //   每月單數 = 合作客戶數 × 每家每週叫貨次數 × 4.33(一個月約幾週)
  //   接單與核對 = 每月單數 × 每張單分鐘數 ÷ 60 × 時薪
  //   出錯與重工 = 每月單數 × 出錯比例 × 每次出錯成本
  //   對帳與請款 = 每月對帳時數 × 時薪
  // 「整合後預估」= 各項乘上 (1 − 可減少比例)。可減少比例是估算假設、不是承諾的成效,畫面上可以調。
  // 資料只在瀏覽器計算,不送出。

  var WEEKS_PER_MONTH = 4.33;

  var DEFAULTS = {
    customers: 40,
    ordersPerWeek: 2,
    minutesPerOrder: 6,
    errorRatePct: 4,
    hourlyWage: 220,
    costPerError: 500,
    billingHours: 12,
  };

  // 預設偏保守;沒有實際使用數據前,不把它講成實測成效。
  var ASSUMPTIONS = { handlingCutPct: 40, errorCutPct: 50, billingCutPct: 50 };

  // 每個欄位的合法範圍(輸入框與滑桿共用),超出會被夾回來
  var LIMITS = {
    customers: { min: 0, max: 2000, step: 1 },
    ordersPerWeek: { min: 0, max: 14, step: 1 },
    minutesPerOrder: { min: 0, max: 60, step: 1 },
    errorRatePct: { min: 0, max: 50, step: 0.5 },
    hourlyWage: { min: 0, max: 2000, step: 10 },
    costPerError: { min: 0, max: 20000, step: 50 },
    billingHours: { min: 0, max: 300, step: 1 },
    handlingCutPct: { min: 0, max: 100, step: 5 },
    errorCutPct: { min: 0, max: 100, step: 5 },
    billingCutPct: { min: 0, max: 100, step: 5 },
  };

  function clamp(key, value) {
    var limit = LIMITS[key];
    var n = Number(value);
    if (!limit || !isFinite(n)) return limit ? limit.min : 0;
    return Math.min(limit.max, Math.max(limit.min, n));
  }

  function normalize(base, input) {
    var out = {};
    Object.keys(base).forEach(function (key) {
      out[key] = clamp(key, input && input[key] != null ? input[key] : base[key]);
    });
    return out;
  }

  function calc(input, assumptions) {
    var v = normalize(DEFAULTS, input);
    var a = normalize(ASSUMPTIONS, assumptions);

    var orders = v.customers * v.ordersPerWeek * WEEKS_PER_MONTH;
    var handlingHours = (orders * v.minutesPerOrder) / 60;

    var before = {
      handling: handlingHours * v.hourlyWage,
      errors: orders * (v.errorRatePct / 100) * v.costPerError,
      billing: v.billingHours * v.hourlyWage,
    };
    before.total = before.handling + before.errors + before.billing;

    var after = {
      handling: before.handling * (1 - a.handlingCutPct / 100),
      errors: before.errors * (1 - a.errorCutPct / 100),
      billing: before.billing * (1 - a.billingCutPct / 100),
    };
    after.total = after.handling + after.errors + after.billing;

    var hoursBefore = handlingHours + v.billingHours;
    var hoursAfter = handlingHours * (1 - a.handlingCutPct / 100) + v.billingHours * (1 - a.billingCutPct / 100);
    var savedMoney = before.total - after.total;

    return {
      orders: orders,
      before: before,
      after: after,
      hours: { before: hoursBefore, after: hoursAfter, saved: hoursBefore - hoursAfter },
      saved: { monthly: savedMoney, yearly: savedMoney * 12 },
    };
  }

  // 千分位整數;NaN / 負的當 0
  function formatNumber(n) {
    var v = Math.max(0, Math.round(Number(n) || 0));
    return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return {
    WEEKS_PER_MONTH: WEEKS_PER_MONTH,
    DEFAULTS: DEFAULTS,
    ASSUMPTIONS: ASSUMPTIONS,
    LIMITS: LIMITS,
    clamp: clamp,
    calc: calc,
    formatNumber: formatNumber,
  };
});
