// admin.ts:審核送出的內容、樂觀鎖(updated_at)、下架 = 退回加前綴、店家停用 / 恢復、商品數統計。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, next } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  next: { data: null as unknown },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const b = {
        select: () => b,
        update: (v: unknown) => {
          call.op = "update";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: next.data, error: null }),
        single: async () => ({ data: next.data, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: next.data, error: null }).then(ok),
      };
      return b;
    },
  },
}));

import {
  DELIST_PREFIX,
  DELIST_REASON_MAX,
  fetchAdminProducts,
  fetchProductCounts,
  reviewProduct,
  setStoreEnabled,
  StaleReviewError,
} from "./admin";
import { LIMITS } from "./constants";

beforeEach(() => {
  calls.length = 0;
  next.data = { id: "p1" };
});

describe("reviewProduct", () => {
  const product = { id: "p1", updated_at: "2026-10-09T02:00:00.123456+00:00" };

  it("核准:只送 review_status,帶 id 與 updated_at(樂觀鎖)", async () => {
    await reviewProduct(product, { kind: "approve" });
    expect(calls[0]).toMatchObject({ op: "update", payload: { review_status: "approved" } });
    expect(calls[0].filters).toEqual([
      ["id", "p1"],
      ["updated_at", product.updated_at],
    ]);
  });

  it("退回帶原因;下架 = 退回,原因加「(管理員下架)」", async () => {
    await reviewProduct(product, { kind: "reject", reason: " 照片太暗 " });
    expect(calls[0].payload).toEqual({ review_status: "rejected", reject_reason: "照片太暗" });
    await reviewProduct(product, { kind: "delist", reason: "標示不實" });
    expect(calls[1].payload).toEqual({ review_status: "rejected", reject_reason: "(管理員下架)標示不實" });
  });

  it("0 列(供應商剛改過)→ StaleReviewError", async () => {
    next.data = null;
    await expect(reviewProduct(product, { kind: "approve" })).rejects.toBeInstanceOf(StaleReviewError);
  });

  it("下架原因的上限要扣掉前綴:前綴 + 原因剛好是資料庫的 300 字(reject_reason <= 300)", async () => {
    expect(DELIST_PREFIX).toBe("(管理員下架)");
    expect(DELIST_REASON_MAX + DELIST_PREFIX.length).toBe(LIMITS.rejectReason);
    await reviewProduct(product, { kind: "delist", reason: "字".repeat(DELIST_REASON_MAX) });
    expect((calls[0].payload as { reject_reason: string }).reject_reason).toHaveLength(LIMITS.rejectReason);
  });
});

describe("清單與店家", () => {
  it("待審清單篩 review_status;全部不篩", async () => {
    next.data = [];
    await fetchAdminProducts("pending");
    expect(calls[0].filters).toEqual([["review_status", "pending"]]);
    await fetchAdminProducts("all");
    expect(calls[1].filters).toEqual([]);
  });

  it("停用要帶原因;恢復只送 is_enabled", async () => {
    await setStoreEnabled("sup-1", false, " 客訴處理中 ");
    expect(calls[0].payload).toEqual({ is_enabled: false, disabled_reason: "客訴處理中" });
    await setStoreEnabled("sup-1", true, null);
    expect(calls[1].payload).toEqual({ is_enabled: true });
  });

  it("商品數:上架中 = 已核准且開著;待審另外算", async () => {
    next.data = [
      { supplier_id: "a", review_status: "approved", is_listed: true },
      { supplier_id: "a", review_status: "approved", is_listed: false },
      { supplier_id: "a", review_status: "pending", is_listed: true },
      { supplier_id: "b", review_status: "draft", is_listed: true },
    ];
    const counts = await fetchProductCounts();
    expect(counts.get("a")).toEqual({ listed: 1, pending: 1 });
    expect(counts.get("b")).toEqual({ listed: 0, pending: 0 });
  });
});
