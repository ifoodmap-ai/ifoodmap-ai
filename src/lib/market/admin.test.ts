// admin.ts:審核送出的內容、樂觀鎖(updated_at)、下架 = 退回加前綴、店家停用 / 恢復、商品數統計、錯誤訊息一律中文。
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, unknown]>;
  selectOptions?: unknown;
  orders: Array<[string, boolean]>;
  range?: [number, number];
  terminal?: "single" | "maybeSingle";
};

const { calls, next } = vi.hoisted(() => ({
  calls: [] as Call[],
  // pages:分頁測試用,每次查詢依序拿一頁(拿完就是空陣列);否則每次都回 data / error / count
  next: { data: null as unknown, error: null as unknown, count: null as number | null, pages: null as unknown[][] | null },
}));

// 假的 PostgREST builder。single() 在 0 列時跟真的 postgrest-js 一樣回英文的 PGRST116;maybeSingle() 回 data null。
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [], orders: [] };
      calls.push(call);
      const result = () =>
        next.pages ? { data: next.pages.shift() ?? [], error: null, count: next.count } : { data: next.data, error: next.error, count: next.count };
      const b = {
        select: (_columns?: string, options?: unknown) => {
          if (options) call.selectOptions = options;
          return b;
        },
        update: (v: unknown) => {
          call.op = "update";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        ilike: (c: string, v: unknown) => {
          call.filters.push([`${c} ilike`, v]);
          return b;
        },
        order: (c: string, o: { ascending: boolean }) => {
          call.orders.push([c, o.ascending]);
          return b;
        },
        range: (from: number, to: number) => {
          call.range = [from, to];
          return b;
        },
        limit: () => b,
        maybeSingle: async () => {
          call.terminal = "maybeSingle";
          return result();
        },
        single: async () => {
          call.terminal = "single";
          const r = result();
          return r.data == null && !r.error
            ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: "The result contains 0 rows", hint: null } }
            : r;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, fail),
      };
      return b;
    },
  },
}));

import {
  adminErrorMessage,
  DELIST_PREFIX,
  DELIST_REASON_MAX,
  fetchAdminProducts,
  fetchProductCounts,
  MarketReasonRequiredError,
  MarketReviewGoneError,
  MarketStaleReviewError,
  MarketStoreGoneError,
  reviewProduct,
  setStoreEnabled,
} from "./admin";
import { LIMITS } from "./constants";
import { friendlyDbError, MarketDbError } from "./db";

beforeEach(() => {
  calls.length = 0;
  next.data = { id: "p1" };
  next.error = null;
  next.count = null;
  next.pages = null;
});

describe("reviewProduct", () => {
  const product = { id: "p1", updated_at: "2026-10-09T02:00:00.123456+00:00" };

  it("核准:只送 review_status,帶 id 與 updated_at(樂觀鎖)", async () => {
    await reviewProduct(product, { kind: "approve" });
    expect(calls[0]).toMatchObject({ op: "update", payload: { review_status: "approved" } });
    // 只送 review_status(toMatchObject 是子集比對,多送欄位也會過)
    expect(calls[0].payload).toEqual({ review_status: "approved" });
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

  it("0 列(供應商剛改過)→ MarketStaleReviewError", async () => {
    next.data = null;
    await expect(reviewProduct(product, { kind: "approve" })).rejects.toBeInstanceOf(MarketStaleReviewError);
  });

  it("樂觀鎖的錯誤名稱是 Market 開頭:頁面給了中文備援,也不會蓋掉它原本的中文", async () => {
    next.data = null;
    const err = await reviewProduct(product, { kind: "reject", reason: "照片太暗" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketStaleReviewError);
    expect((err as Error).name).toBe("MarketStaleReviewError");
    expect(friendlyDbError(err, "備援")).toBe("這個商品剛被供應商修改過,請重新整理後再審核");
    expect(adminErrorMessage(err, "備援")).toBe("這個商品剛被供應商修改過,請重新整理後再審核");
  });

  it("退回仍有樂觀鎖(帶 updated_at);下架不鎖、只帶 id —— 供應商改價格 / 庫存(第 2 階段下單扣庫存也算)不會擋住下架", async () => {
    await reviewProduct(product, { kind: "reject", reason: "照片太暗" });
    expect(calls[0].filters).toEqual([
      ["id", "p1"],
      ["updated_at", product.updated_at],
    ]);
    await reviewProduct(product, { kind: "delist", reason: "標示不實" });
    expect(calls[1].filters).toEqual([["id", "p1"]]);
  });

  it("下架一列都沒更新到(商品已被刪除)→ 中文的 MarketReviewGoneError,不是「剛被供應商修改過」", async () => {
    next.data = null;
    const err = await reviewProduct(product, { kind: "delist", reason: "標示不實" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketReviewGoneError);
    expect(err).not.toBeInstanceOf(MarketStaleReviewError);
    expect(adminErrorMessage(err, "備援")).toBe("沒有更新到這個商品(可能已被供應商刪除或權限不足),請重新整理後再試");
  });

  it("退回 / 下架的原因看不到字(只有零寬字元)→ 不送出,丟中文錯誤(下架有前綴,資料庫擋不到)", async () => {
    for (const kind of ["reject", "delist"] as const) {
      const err = await reviewProduct(product, { kind, reason: "\u{200b}\u{2060} " }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketReasonRequiredError);
      expect(adminErrorMessage(err, "備援")).toBe("請填寫原因(會顯示給供應商)");
    }
    expect(calls).toHaveLength(0);
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
    expect(calls[0].filters).toEqual([["supplier_id", "sup-1"]]);
    await setStoreEnabled("sup-1", true, null);
    expect(calls[1].payload).toEqual({ is_enabled: true });
    expect(calls[1].filters).toEqual([["supplier_id", "sup-1"]]);
  });

  it("停用原因看不到字 → 不送出,丟中文錯誤", async () => {
    await expect(setStoreEnabled("sup-1", false, "\u{200b}")).rejects.toBeInstanceOf(MarketReasonRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("停用 / 恢復時一列都沒更新到 → 中文錯誤(不是 PGRST116 的「JSON object requested…」)", async () => {
    next.data = null;
    const err = await setStoreEnabled("sup-1", false, "客訴處理中").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketStoreGoneError);
    expect((err as Error).message).toBe("沒有更新到這家店(可能已被移除或權限不足),請重新整理後再試");
    expect(adminErrorMessage(err, "備援")).toBe("沒有更新到這家店(可能已被移除或權限不足),請重新整理後再試");
    await expect(setStoreEnabled("sup-1", true, null)).rejects.toBeInstanceOf(MarketStoreGoneError);
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

describe("adminErrorMessage:管理後台的錯誤訊息一律中文", () => {
  it("登入過期 / JWT 失效 → 請重新登入(不顯示「JWT expired」)", () => {
    expect(adminErrorMessage(new MarketDbError({ message: "JWT expired", code: "PGRST301" }), "備援")).toBe("登入已過期,請重新登入後再試");
    expect(adminErrorMessage(new MarketDbError({ message: "JWT expired", code: "PGRST303" }), "備援")).toBe("登入已過期,請重新登入後再試");
    expect(adminErrorMessage(new MarketDbError({ message: "JWT expired" }), "備援")).toBe("登入已過期,請重新登入後再試");
  });

  it("認不得的資料庫錯誤 → 中文備援加錯誤代碼;認得的 hint / 斷網照 friendlyDbError;市集自己的錯照原訊息", () => {
    expect(adminErrorMessage(new MarketDbError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }), "沒有更新成功")).toBe(
      "沒有更新成功(錯誤代碼 PGRST116)",
    );
    expect(adminErrorMessage(new MarketDbError({ message: "x", code: "22023", hint: "photos_not_uploaded" }), "備援")).toBe(
      "這個商品還有照片沒有上傳完成,無法核准",
    );
    expect(adminErrorMessage(new MarketDbError({ message: "TypeError: Failed to fetch", code: "", hint: "" }), "備援")).toBe(
      "連線失敗,請檢查網路後再試一次",
    );
    expect(adminErrorMessage(new Error("Something broke"), "備援")).toBe("備援");
    expect(adminErrorMessage(new MarketStaleReviewError(), "備援")).toBe("這個商品剛被供應商修改過,請重新整理後再審核");
  });
});
