const assert = require('node:assert/strict');
const test = require('node:test');

const { ASSUMPTIONS, DEFAULTS, LIMITS, WEEKS_PER_MONTH, calc, clamp, formatNumber } = require('../savings.js');

const r = Math.round;

test('預設值:單數、各項成本、整合後預估、每月與每年省下', () => {
  const x = calc();
  // 40 家 × 每週 2 次 × 4.33 = 346.4 張
  assert.equal(r(x.orders), 346);
  assert.ok(Math.abs(x.orders - 40 * 2 * WEEKS_PER_MONTH) < 1e-9);
  // 接單與核對:346.4 × 6 分鐘 = 34.64 小時 × 220 = 7,621
  assert.equal(r(x.before.handling), 7621);
  // 出錯與重工:346.4 × 4% × 500 = 6,928
  assert.equal(r(x.before.errors), 6928);
  // 對帳與請款:12 小時 × 220 = 2,640
  assert.equal(r(x.before.billing), 2640);
  assert.equal(r(x.before.total), 17189);
  // 整合後(減少 40% / 50% / 50%):4,573 + 3,464 + 1,320
  assert.equal(r(x.after.total), 9356);
  assert.equal(r(x.saved.monthly), 7832);
  assert.equal(r(x.saved.yearly), 93988);
  // 時間:34.64 + 12 = 46.64 小時;整合後 20.78 + 6 = 26.78 → 省 19.9 小時
  assert.equal(x.hours.before.toFixed(1), '46.6');
  assert.equal(x.hours.saved.toFixed(1), '19.9');
});

test('每一項都對得上自己的公式,而且「省下」= 整合前 − 整合後', () => {
  const x = calc({ customers: 10, ordersPerWeek: 3, minutesPerOrder: 10, errorRatePct: 10, hourlyWage: 300, costPerError: 1000, billingHours: 5 }, { handlingCutPct: 0, errorCutPct: 100, billingCutPct: 20 });
  const orders = 10 * 3 * WEEKS_PER_MONTH;
  assert.ok(Math.abs(x.before.handling - (orders * 10 / 60) * 300) < 1e-6);
  assert.ok(Math.abs(x.before.errors - orders * 0.1 * 1000) < 1e-6);
  assert.equal(x.before.billing, 1500);
  assert.equal(x.after.handling, x.before.handling); // 減少 0%
  assert.equal(x.after.errors, 0); // 減少 100%
  assert.equal(x.after.billing, 1200);
  assert.ok(Math.abs(x.saved.monthly - (x.before.total - x.after.total)) < 1e-6);
  assert.ok(Math.abs(x.saved.yearly - x.saved.monthly * 12) < 1e-6);
});

test('沒有客戶或沒有單:成本是 0,不會出現 NaN 或負數', () => {
  for (const input of [{ customers: 0 }, { ordersPerWeek: 0 }, {}]) {
    const x = calc({ ...input, billingHours: 0 });
    for (const v of [x.before.total, x.after.total, x.saved.monthly, x.hours.saved]) {
      assert.ok(Number.isFinite(v) && v >= 0, JSON.stringify(input));
    }
  }
  assert.equal(calc({ customers: 0, billingHours: 0 }).before.total, 0);
});

test('亂填(負數、文字、NaN、Infinity、空白)會被夾回合法範圍,結果仍是有限的數字', () => {
  const x = calc({ customers: -5, ordersPerWeek: 'abc', minutesPerOrder: NaN, errorRatePct: Infinity, hourlyWage: '', costPerError: -1, billingHours: null }, { handlingCutPct: 500, errorCutPct: -3, billingCutPct: 'x' });
  for (const v of [x.orders, x.before.total, x.after.total, x.saved.monthly, x.hours.before]) assert.ok(Number.isFinite(v) && v >= 0);
  assert.equal(clamp('customers', -5), LIMITS.customers.min);
  assert.equal(clamp('customers', 1e9), LIMITS.customers.max);
  assert.equal(clamp('errorRatePct', 'abc'), 0);
  assert.equal(clamp('不存在的欄位', 3), 0);
});

test('整合後可減少 100% → 全部省下;可減少 0% → 省 0', () => {
  const all = calc(DEFAULTS, { handlingCutPct: 100, errorCutPct: 100, billingCutPct: 100 });
  assert.equal(all.after.total, 0);
  assert.ok(Math.abs(all.saved.monthly - all.before.total) < 1e-6);
  const none = calc(DEFAULTS, { handlingCutPct: 0, errorCutPct: 0, billingCutPct: 0 });
  assert.equal(none.saved.monthly, 0);
  assert.equal(none.hours.saved, 0);
});

test('預設假設是保守的(各項不超過一半);所有預設值都在合法範圍內', () => {
  for (const v of Object.values(ASSUMPTIONS)) assert.ok(v > 0 && v <= 50);
  for (const [key, value] of Object.entries({ ...DEFAULTS, ...ASSUMPTIONS })) {
    assert.ok(value >= LIMITS[key].min && value <= LIMITS[key].max, key);
  }
});

test('formatNumber:千分位、四捨五入、不顯示負數與 NaN', () => {
  assert.equal(formatNumber(1234567.6), '1,234,568');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(-50), '0');
  assert.equal(formatNumber(NaN), '0');
  assert.equal(formatNumber(undefined), '0');
});
