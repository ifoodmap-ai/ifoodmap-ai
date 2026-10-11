// orders.ts:狀態、中文、轉移表跟 migration 一字不差;各角色的按鈕;送出前檢查;寫入的內容。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = {
  table: string;
  op: string;
  columns?: string;
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
  order: Array<[string, boolean]>;
  limit?: number;
  range?: [number, number];
};
const { calls, respond } = vi.hoisted(() => ({
  calls: [] as Call[],
  /** null = 一律回空陣列;個別測試換成依條件回資料的假資料表 */
  respond: { current: null as null | ((call: Call) => { data: unknown; error: unknown }) },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [], order: [] };
      calls.push(call);
      const b = {
        select: (columns?: string) => {
          call.columns = columns;
          return b;
        },
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
        order: (c: string, o: { ascending: boolean }) => {
          call.order.push([c, o.ascending]);
          return b;
        },
        limit: (n: number) => {
          call.limit = n;
          return b;
        },
        range: (from: number, to: number) => {
          call.range = [from, to];
          return b;
        },
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve(respond.current ? respond.current(call) : { data: [], error: null }).then(ok),
      };
      return b;
    },
  },
}));

import {
  addOrderEvent,
  adminActions,
  fetchAdminOrders,
  fetchSupplierOrders,
  MARKET_TRANSITIONS,
  ORDER_COLUMNS,
  ORDER_LIST_LIMIT,
  SUPPLIER_ACTIVE_ORDER_COLUMNS,
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
  respond.current = null;
});

/** 假資料表:照查詢條件篩(eq / in)、排序、range、limit,一次最多回 1000 列(= Supabase 的 max rows) */
const serve = (rows: Array<Record<string, unknown>>, call: Call) => {
  let out = rows.filter((r) =>
    call.filters.every(([op, col, v]) => (op === "eq" ? r[col] === v : op === "in" ? (v as unknown[]).includes(r[col]) : true)),
  );
  out = [...out].sort((a, b) => {
    for (const [col, asc] of call.order) {
      const x = String(a[col]);
      const y = String(b[col]);
      if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
  if (call.range) out = out.slice(call.range[0], call.range[1] + 1);
  if (call.limit !== undefined) out = out.slice(0, call.limit);
  return out.slice(0, 1000);
};

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

  it("物流只有全形空白、零寬字元也算沒填(資料庫的 market_visible 一樣會擋成 carrier_required);單號選填,看不到字當成沒填", () => {
    expect(validateOrderAction("shipped", { carrier: "\u{3000}\u{3000}" })).toBe("請填寫物流(例如:黑貓宅急便、自行配送)");
    expect(validateOrderAction("shipped", { carrier: "\u{200B}" })).toBe("請填寫物流(例如:黑貓宅急便、自行配送)");
    expect(validateOrderAction("shipped", { carrier: "\u{200B}\u{3000} \u{FEFF}\u{2060}" })).toBe("請填寫物流(例如:黑貓宅急便、自行配送)");
    expect(validateOrderAction("shipped", { carrier: "\u{200B}黑貓" })).toBeNull();
    expect(validateOrderAction("shipped", { carrier: "黑貓", trackingNo: "\u{200B}\u{3000}" })).toBeNull();
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
    expect(calls[0].payload).toEqual({
      order_id: "o1",
      from_status: "confirmed",
      to_status: "shipped",
      note: null,
      payload: { carrier: "黑貓", tracking_no: "9001" },
    });
    // 完整比對:沒填單號時 payload 裡連 tracking_no 這個 key 都不能有(多送 tracking_no: "" 也要紅)
    await addOrderEvent({ id: "o1", status: "confirmed" }, "shipped", { carrier: "自行配送", trackingNo: "" });
    expect(calls[1].payload).toEqual({ order_id: "o1", from_status: "confirmed", to_status: "shipped", note: null, payload: { carrier: "自行配送" } });
    await addOrderEvent({ id: "o2", status: "pending" }, "rejected", { reason: " 缺貨 " });
    expect(calls[2].payload).toEqual({ order_id: "o2", from_status: "pending", to_status: "rejected", note: "缺貨", payload: {} });
  });

  it("管理員總覽的篩選", async () => {
    await fetchAdminOrders("open");
    expect(calls[0].filters).toEqual([["in", "status", ["pending", "confirmed", "awaiting_payment", "paid"]]]);
    await fetchAdminOrders("all");
    expect(calls[1].filters).toEqual([]);
  });

  it("店家的電話與 contact_email 只有管理員的查詢會帶(處理客訴用);供應商的查詢不碰店家資料", async () => {
    await fetchAdminOrders("all");
    expect(calls[0].columns).toContain("market_stores(suppliers(name, phone, contact_email))");
    await fetchSupplierOrders("a9200000-0000-4000-8000-00000000000a", "active");
    await fetchSupplierOrders("a9200000-0000-4000-8000-00000000000a", "closed");
    expect(calls.slice(1).map((c) => c.columns)).toEqual([SUPPLIER_ACTIVE_ORDER_COLUMNS, ORDER_COLUMNS]);
    for (const c of calls.slice(1)) expect(c.columns).not.toMatch(/contact_email|market_stores|suppliers/);
  });

  it("供應商還沒結束的單多帶狀態紀錄的 to_status、created_at(待匯款的 72 小時期限從「待匯款」那一筆算),不帶身分與備註", async () => {
    expect(SUPPLIER_ACTIVE_ORDER_COLUMNS).toBe(`${ORDER_COLUMNS}, market_order_events(to_status, created_at)`);
    await fetchSupplierOrders("a9200000-0000-4000-8000-00000000000a", "active");
    expect(calls[0].columns).toContain("market_order_events(to_status, created_at)");
    expect(calls[0].columns).not.toMatch(/actor_role|actor_id/);
  });

  it("供應商:還沒結束的單一張都不漏(在伺服器依狀態篩、分頁讀完,不跟已結束的單共用上限);已結束的只抓最新 200 張", async () => {
    const SUP = "a9200000-0000-4000-8000-00000000000a";
    const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
    const ACTIVE = ["pending", "confirmed", "awaiting_payment", "paid", "shipped"];
    const CLOSED = ["completed", "rejected", "cancelled"];
    const rows: Array<Record<string, unknown>> = [
      // 最舊的一張:已收款、還沒出貨的轉帳單 —— 共用上限時最先被擠掉(收了款卻出不了貨)
      { id: "old-paid", supplier_id: SUP, status: "paid", payment_method: "transfer", created_at: at(0) },
      // 1100 張還沒結束的單(超過一頁 1000 列)
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `a-${String(i + 1).padStart(4, "0")}`, supplier_id: SUP, status: ACTIVE[i % 5], payment_method: "transfer", created_at: at(i + 1) })),
      // 300 張已結束的單,全部比還沒結束的新
      ...Array.from({ length: 300 }, (_, i) => ({ id: `c-${String(i + 1).padStart(4, "0")}`, supplier_id: SUP, status: CLOSED[i % 3], payment_method: "cod", created_at: at(5000 + i) })),
      // 別家的單不能混進來
      { id: "other", supplier_id: "a9200000-0000-4000-8000-00000000000b", status: "pending", payment_method: "cod", created_at: at(9999) },
    ];
    respond.current = (call) => ({ data: serve(rows, call), error: null });

    const active = await fetchSupplierOrders(SUP, "active");
    expect(active).toHaveLength(1101);
    expect(active.map((o) => o.id)).toContain("old-paid");
    expect(new Set(active.map((o) => o.status))).toEqual(new Set(ACTIVE));
    expect(active[0].id).toBe("a-1100");
    expect(active[active.length - 1].id).toBe("old-paid");

    const closed = await fetchSupplierOrders(SUP, "closed");
    expect(closed).toHaveLength(ORDER_LIST_LIMIT);
    expect(closed.every((o) => CLOSED.includes(o.status))).toBe(true);
    expect(closed[0].id).toBe("c-0300");

    // 每一次查詢都限定自家
    expect(calls.every((c) => c.filters.some(([op, col, v]) => op === "eq" && col === "supplier_id" && v === SUP))).toBe(true);
  });
});
