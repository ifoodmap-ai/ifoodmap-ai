// 前端 TRANSITIONS(決定出現哪些按鈕)必須跟資料庫的轉移表(真正的規則)逐條一致:
// 這裡直接解析「最新一支」定義 order_transition_rules() 的 migration(@transitions-begin … @transitions-end)來比對,
// 任何一邊多一條或少一條都會紅。每日逾時排程的時限(@expiry-begin … @expiry-end)也要等於 ORDER_STATUS.slaHours。
// 另外驗 recordOrderEvent 不再送 actor_id、錯誤會帶出原因,以及 RPC 的錯誤處理。

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertSpy, rpcSpy, result } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  rpcSpy: vi.fn(),
  result: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "sales@example.com" } } }) },
    from: () => ({
      insert: (v: unknown) => {
        insertSpy(v);
        return { select: () => ({ single: async () => result }) };
      },
    }),
    rpc: async (fn: string, args: unknown) => {
      rpcSpy(fn, args);
      return result;
    },
  },
}));

import {
  ADMIN_DISPATCHABLE,
  allowedTransitions,
  callOrderRpc,
  formatOrderNo,
  IN_FLIGHT_STATUSES,
  isStaleOrderError,
  ORDER_STATUS,
  OrderEventError,
  recordOrderEvent,
  restaurantTransitions,
  type ActorRole,
  type OrderStatus,
} from "./orders";

const MIGRATIONS_DIR = resolve(__dirname, "../../supabase/migrations");
/** 最新一支含有某個標記的 migration(函式是 CREATE OR REPLACE,最後一支才是正式庫現行的定義) */
const latestMigrationWith = (marker: string): string => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const hits = files.filter((f) => readFileSync(resolve(MIGRATIONS_DIR, f), "utf8").includes(marker));
  expect(hits.length).toBeGreaterThan(0);
  return readFileSync(resolve(MIGRATIONS_DIR, hits[hits.length - 1]), "utf8");
};
const MIGRATION = latestMigrationWith("@transitions-begin");

/** migration 裡「單獨一行」的 -- @name-begin 到 -- @name-end 之間(檔頭說明裡提到標記名稱不算) */
const markedBlock = (sql: string, name: string): string => {
  const begin = sql.search(new RegExp(`^\\s*-- @${name}-begin\\s*$`, "m"));
  const end = sql.search(new RegExp(`^\\s*-- @${name}-end\\s*$`, "m"));
  expect(begin, `${name}-begin`).toBeGreaterThan(-1);
  expect(end, `${name}-end`).toBeGreaterThan(begin);
  return sql.slice(begin, end);
};

/** 解析 migration 裡 @transitions-begin … @transitions-end 之間的 ('身分','從','到') */
const dbRules = (): Set<string> => {
  const block = markedBlock(MIGRATION, "transitions");
  const rows = [...block.matchAll(/\('(\w+)',\s*'(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  return new Set(rows);
};

const STATUSES: OrderStatus[] = [
  "draft", "submitted", "dispatched", "accepted", "quoted", "confirmed", "shipped", "in_transit", "delivered",
  "received", "reviewed", "closed", "rejected", "discrepancy", "disputed", "cancelled", "expired",
  "pending", "sent", "completed",
];

/** 前端的表攤平成同樣的 (身分, 從, 到);餐廳拆成老闆/店長/採購員(採購員扣掉只有老闆/店長能做的) */
const frontRules = (): Set<string> => {
  const out = new Set<string>();
  const add = (actor: string, role: ActorRole) =>
    STATUSES.forEach((from) =>
      allowedTransitions(role, from).forEach((to) => out.add(`${actor}|${from}|${to}`)),
    );
  (["owner", "manager", "purchaser"] as const).forEach((member) =>
    STATUSES.forEach((from) =>
      restaurantTransitions(member, from).forEach((to) => out.add(`${member}|${from}|${to}`)),
    ),
  );
  add("supplier", "supplier");
  add("admin", "admin");
  add("system", "system");
  return out;
};

describe("轉移表:前端 TRANSITIONS 與資料庫 order_transition_rules() 逐條一致", () => {
  it("資料庫共 105 條", () => {
    expect(dbRules().size).toBe(105);
  });

  it("兩邊完全相同(多一條、少一條都不行)", () => {
    const db = dbRules();
    const front = frontRules();
    expect([...front].filter((r) => !db.has(r)).sort()).toEqual([]);
    expect([...db].filter((r) => !front.has(r)).sort()).toEqual([]);
  });

  it("供應商最多推到 delivered:received 只有餐廳能觸發", () => {
    STATUSES.forEach((from) => {
      expect(allowedTransitions("supplier", from)).not.toContain("received");
    });
  });

  it("供應商在各狀態的按鈕:接單/拒單、報價、出貨、送達", () => {
    expect(allowedTransitions("supplier", "dispatched")).toEqual(["accepted", "rejected"]);
    expect(allowedTransitions("supplier", "accepted")).toEqual(["quoted"]);
    expect(allowedTransitions("supplier", "quoted")).toEqual([]);
    expect(allowedTransitions("supplier", "confirmed")).toEqual(["shipped"]);
    expect(allowedTransitions("supplier", "shipped")).toEqual(["in_transit", "delivered"]);
    expect(allowedTransitions("supplier", "in_transit")).toEqual(["delivered"]);
    expect(allowedTransitions("supplier", "delivered")).toEqual([]);
  });

  it("管理員可以從待派發、被拒、逾時派單;畫面上的「派給…」狀態都在轉移表裡,而且不含草稿", () => {
    expect(ADMIN_DISPATCHABLE).toEqual(["submitted", "pending", "rejected", "expired"]);
    ADMIN_DISPATCHABLE.forEach((s) => {
      expect(allowedTransitions("admin", s)).toContain("dispatched");
    });
    expect(ADMIN_DISPATCHABLE).not.toContain("draft");
    // 已派發的單管理員不能再派(只能取消,20260929110000 起)
    expect(allowedTransitions("admin", "dispatched")).toEqual(["cancelled"]);
  });
});

describe("recordOrderEvent", () => {
  beforeEach(() => {
    insertSpy.mockReset();
    result.data = { id: "ev-1" };
    result.error = null;
  });

  it("不送 actor_id(伺服器用 auth.uid() 決定),其餘欄位照傳", async () => {
    await recordOrderEvent({
      orderId: "order-1",
      fromStatus: "accepted",
      toStatus: "quoted",
      actorRole: "supplier",
      source: "supplier_portal",
      note: "含運",
      payload: { total_amount: 1200 },
    });
    const sent = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("actor_id");
    expect(sent).toMatchObject({
      order_id: "order-1",
      from_status: "accepted",
      to_status: "quoted",
      actor_role: "supplier",
      source: "supplier_portal",
      actor_label: "sales@example.com",
      note: "含運",
      payload: { total_amount: 1200 },
    });
  });

  it("資料庫擋下時丟 OrderEventError,訊息照實、帶出 code 與 hint", async () => {
    result.data = null;
    result.error = {
      message: "這張訂單的狀態已經變成「待報價」,畫面上的資料過期了,請重新整理後再操作",
      code: "P0001",
      hint: "stale_order_status",
    };
    const err = await recordOrderEvent({
      orderId: "order-1", fromStatus: "dispatched", toStatus: "accepted", actorRole: "supplier", source: "supplier_portal",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderEventError);
    expect(err.message).toContain("畫面上的資料過期了");
    expect(err.code).toBe("P0001");
    expect(isStaleOrderError(err)).toBe(true);
  });

  it("權限不符不是「過期」:不會被當成重新整理就好", async () => {
    result.data = null;
    result.error = { message: "供應商不能把訂單從「待收貨」改成「待評價」", code: "42501", hint: "transition_not_allowed" };
    const err = await recordOrderEvent({
      orderId: "order-1", fromStatus: "delivered", toStatus: "received", actorRole: "supplier", source: "supplier_portal",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderEventError);
    expect(isStaleOrderError(err)).toBe(false);
    expect(isStaleOrderError(new Error("x"))).toBe(false);
  });

  it("orders.ts 也匯出訂單編號函式", () => {
    expect(formatOrderNo("a1e337b0-de8c-4e65-b22a-ca76edcf4143")).toBe("#EDCF4143");
  });
});

describe("20260929110000:退回重新報價、管理員取消進行中的單", () => {
  it("待確認時老闆/店長可以退回重新報價,採購員看不到", () => {
    expect(restaurantTransitions("owner", "quoted")).toEqual(["confirmed", "accepted", "cancelled"]);
    expect(restaurantTransitions("manager", "quoted")).toEqual(["confirmed", "accepted", "cancelled"]);
    expect(restaurantTransitions("purchaser", "quoted")).toEqual(["confirmed", "cancelled"]);
    // 採購員不能送出簽核(submitted),但可以向合作供應商直接叫貨(dispatched,20261028110000)
    expect(restaurantTransitions("purchaser", "draft")).toEqual(["cancelled", "dispatched"]);
    expect(restaurantTransitions("owner", "draft")).toEqual(["submitted", "cancelled", "dispatched"]);
    expect(restaurantTransitions("owner", "confirmed")).toEqual([]);
  });

  it("管理員在待接單、待報價、待餐廳確認、待出貨、已出貨、運送中都能取消", () => {
    IN_FLIGHT_STATUSES.forEach((s) => expect(allowedTransitions("admin", s)).toContain("cancelled"));
    expect(IN_FLIGHT_STATUSES).toEqual(["dispatched", "sent", "accepted", "quoted", "confirmed", "shipped", "in_transit"]);
    expect(allowedTransitions("admin", "delivered")).toEqual([]);
  });

  it("前端的「取消要填原因」狀態清單與資料庫 guard 一致", () => {
    const guard = latestMigrationWith("cancel_reason_required");
    const m = guard.match(/v_status IN \(([^)]*)\)\s*\n\s*AND NULLIF\(btrim\(COALESCE\(NEW\.note/);
    expect(m).not.toBeNull();
    const dbList = [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    expect(dbList).toEqual(IN_FLIGHT_STATUSES);
  });

  it("notify 判斷「取消要不要通知」的清單(Deno 那邊自己一份)也跟前端一致", () => {
    const render = readFileSync(resolve(__dirname, "../../supabase/functions/notify/render.ts"), "utf8");
    const m = render.match(/export const IN_FLIGHT_STATUSES = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    expect([...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1])).toEqual(IN_FLIGHT_STATUSES);
  });
});

describe("20260929110100:每日逾時排程的時限 = ORDER_STATUS.slaHours(isStuck 用的同一組數字)", () => {
  const EXPIRY = latestMigrationWith("@expiry-begin");
  const block = markedBlock(EXPIRY, "expiry");
  const rules = [...block.matchAll(/\('(\w+)',\s*(\d+)\)/g)].map((m) => [m[1] as OrderStatus, Number(m[2])] as const);

  it("會逾時的就是出貨前、等對方動作的那幾關", () => {
    expect(rules.map(([s]) => s)).toEqual(["dispatched", "sent", "accepted", "quoted", "confirmed"]);
  });

  it("每一關的時限都跟 ORDER_STATUS.slaHours 一樣", () => {
    rules.forEach(([s, h]) => expect(h, s).toBe(ORDER_STATUS[s].slaHours));
  });

  it("貨在路上或之後(已出貨、運送中、待收貨…)、平台自己的待派發都不自動逾時", () => {
    const set = new Set(rules.map(([s]) => s));
    (["shipped", "in_transit", "delivered", "received", "reviewed", "submitted", "pending", "draft"] as OrderStatus[])
      .forEach((s) => expect(set.has(s), s).toBe(false));
  });

  it("每一關都允許系統 → expired,逾時後管理員可以改派或取消", () => {
    rules.forEach(([s]) => expect(allowedTransitions("system", s), s).toContain("expired"));
    expect(allowedTransitions("admin", "expired")).toEqual(["dispatched", "cancelled"]);
  });
});

describe("callOrderRpc", () => {
  beforeEach(() => {
    rpcSpy.mockReset();
    result.data = { event_id: "ev-9" };
    result.error = null;
  });

  it("成功就回傳 RPC 的結果", async () => {
    await expect(callOrderRpc("restaurant_receive_order", { p_order_id: "o-1" })).resolves.toEqual({ event_id: "ev-9" });
    expect(rpcSpy).toHaveBeenCalledWith("restaurant_receive_order", { p_order_id: "o-1" });
  });

  it("失敗時丟 OrderEventError,畫面過期可以被 isStaleOrderError 認出來", async () => {
    result.data = null;
    result.error = { message: "這張訂單的狀態已經變成「待評價」,畫面上的資料過期了,請重新整理後再操作", code: "P0001", hint: "stale_order_status" };
    const err: unknown = await callOrderRpc("restaurant_receive_order", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderEventError);
    expect(isStaleOrderError(err)).toBe(true);
    expect((err as OrderEventError).message).toContain("畫面上的資料過期了");
  });
});
