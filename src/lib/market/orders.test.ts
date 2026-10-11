// orders.ts:狀態、中文、轉移表跟 migration 一字不差;各角色的按鈕;送出前檢查;寫入的內容。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const b = {
        select: () => b,
        insert: (v: unknown) => {
          call.op = "insert";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push(["eq", c, v]);
          return b;
        },
        in: (c: string, v: unknown) => {
          call.filters.push(["in", c, v]);
          return b;
        },
        order: () => b,
        limit: () => b,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
      };
      return b;
    },
  },
}));

import {
  addOrderEvent,
  adminActions,
  fetchAdminOrders,
  MARKET_TRANSITIONS,
  ORDER_STATUS_LABEL,
  ORDER_STATUSES,
  supplierActions,
  validateOrderAction,
} from "./orders";

const MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130000_market_orders.sql"), "utf8");
const block = (name: string) => {
  const m = MIGRATION.match(new RegExp(`-- @market-${name}-begin([\\s\\S]*?)-- @market-${name}-end`));
  if (!m) throw new Error(`migration 少了 @market-${name} 標記`);
  return m[1];
};

beforeEach(() => {
  calls.length = 0;
});

describe("跟 migration 一致", () => {
  it("狀態清單", () => {
    expect([...block("statuses").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...ORDER_STATUSES]);
  });

  it("狀態中文(market_order_status_label)", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.market_order_status_label"));
    const labels = Object.fromEntries([...fn.slice(0, fn.indexOf("$$;")).matchAll(/WHEN '([a-z_]+)' THEN '([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(labels).toEqual(ORDER_STATUS_LABEL);
  });

  it("轉移表:供應商、管理員、系統三份都跟前端這份一樣", () => {
    const rows = [...block("transitions").matchAll(/\('([a-z]+)', '([a-z_]+)', '([a-z_]+)', '([a-z]+)'\)/g)].map((m) => ({
      actor: m[1],
      from: m[2],
      to: m[3],
      payment: m[4],
    }));
    expect(rows).toHaveLength(MARKET_TRANSITIONS.length * 3);
    for (const actor of ["supplier", "admin", "system"]) {
      expect(rows.filter((r) => r.actor === actor).map(({ from, to, payment }) => ({ from, to, payment }))).toEqual([...MARKET_TRANSITIONS]);
    }
  });
});

describe("按鈕", () => {
  it("供應商:貨到付款 待接單 → 接單 / 拒單;已接單 → 出貨 / 取消;已出貨 → 完成", () => {
    expect(supplierActions({ status: "pending", payment_method: "cod" })).toEqual(["confirmed", "rejected"]);
    expect(supplierActions({ status: "confirmed", payment_method: "cod" })).toEqual(["shipped", "cancelled"]);
    expect(supplierActions({ status: "shipped", payment_method: "cod" })).toEqual(["completed"]);
    expect(supplierActions({ status: "completed", payment_method: "cod" })).toEqual([]);
  });

  it("供應商:轉帳 待匯款 → 確認已收款 / 取消;已收款 → 出貨 / 取消;沒有「改成待匯款」的按鈕", () => {
    expect(supplierActions({ status: "confirmed", payment_method: "transfer" })).toEqual(["cancelled"]);
    expect(supplierActions({ status: "awaiting_payment", payment_method: "transfer" })).toEqual(["paid", "cancelled"]);
    expect(supplierActions({ status: "paid", payment_method: "transfer" })).toEqual(["shipped", "cancelled"]);
  });

  it("管理員只能平台取消(出貨後不能取消)", () => {
    expect(adminActions({ status: "pending", payment_method: "cod" })).toEqual(["cancelled"]);
    expect(adminActions({ status: "awaiting_payment", payment_method: "transfer" })).toEqual(["cancelled"]);
    expect(adminActions({ status: "paid", payment_method: "transfer" })).toEqual(["cancelled"]);
    expect(adminActions({ status: "shipped", payment_method: "cod" })).toEqual([]);
  });
});

describe("validateOrderAction", () => {
  it("拒單、取消要原因;出貨要物流;長度上限", () => {
    expect(validateOrderAction("rejected", {})).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("cancelled", { reason: "  " })).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("rejected", { reason: "缺貨" })).toBeNull();
    expect(validateOrderAction("rejected", { reason: "字".repeat(301) })).toBe("原因最多 300 字");
    expect(validateOrderAction("shipped", {})).toBe("請填寫物流(例如:黑貓宅急便、自行配送)");
    expect(validateOrderAction("shipped", { carrier: "黑貓", trackingNo: "1".repeat(101) })).toBe("物流單號最多 100 字");
    expect(validateOrderAction("shipped", { carrier: "黑貓" })).toBeNull();
    expect(validateOrderAction("confirmed", {})).toBeNull();
  });

  it("原因只有全形空白、零寬字元也算沒填(資料庫的 market_visible 一樣會擋成 reason_required)", () => {
    expect(validateOrderAction("rejected", { reason: "\u{3000}\u{200B}" })).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("cancelled", { reason: "\u{FEFF}\u{2060}" })).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("cancelled", { reason: "\u{200B}缺貨" })).toBeNull();
  });
});

describe("寫入與查詢", () => {
  it("接單:新增一筆紀錄,帶畫面上的狀態;不送 actor", async () => {
    await addOrderEvent({ id: "o1", status: "pending" }, "confirmed");
    expect(calls[0]).toMatchObject({
      table: "market_order_events",
      op: "insert",
      payload: { order_id: "o1", from_status: "pending", to_status: "confirmed", note: null, payload: {} },
    });
    expect(calls[0].payload).not.toHaveProperty("actor_role");
  });

  it("出貨帶物流與單號(去頭尾空白;沒單號就不送);拒單帶原因", async () => {
    await addOrderEvent({ id: "o1", status: "confirmed" }, "shipped", { carrier: " 黑貓 ", trackingNo: " 9001 " });
    expect(calls[0].payload).toMatchObject({ payload: { carrier: "黑貓", tracking_no: "9001" } });
    await addOrderEvent({ id: "o1", status: "confirmed" }, "shipped", { carrier: "自行配送", trackingNo: "" });
    expect(calls[1].payload).toMatchObject({ payload: { carrier: "自行配送" } });
    await addOrderEvent({ id: "o2", status: "pending" }, "rejected", { reason: " 缺貨 " });
    expect(calls[2].payload).toMatchObject({ note: "缺貨", payload: {} });
  });

  it("管理員總覽的篩選", async () => {
    await fetchAdminOrders("open");
    expect(calls[0].filters).toEqual([["in", "status", ["pending", "confirmed", "awaiting_payment", "paid"]]]);
    await fetchAdminOrders("all");
    expect(calls[1].filters).toEqual([]);
  });
});
