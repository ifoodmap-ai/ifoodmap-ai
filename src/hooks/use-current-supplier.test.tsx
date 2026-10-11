import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    session: { user: { id: "user-1" } } as { user: { id: string } } | null,
    sessionThrows: null as Error | null,
    row: { supplier_id: "sup-1" } as { supplier_id: string } | null,
    queryErrors: [] as Array<{ message: string; code?: string; hint?: string } | null>,
    filters: [] as Array<[string, unknown]>,
    queries: 0,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => {
        if (state.sessionThrows) throw state.sessionThrows;
        return { data: { session: state.session } };
      },
    },
    from: () => {
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          state.filters.push([c, v]);
          return b;
        },
        maybeSingle: async () => {
          state.queries += 1;
          const error = state.queryErrors.shift() ?? null;
          return error ? { data: null, error } : { data: state.row, error: null };
        },
      };
      return b;
    },
  },
}));

import { useCurrentSupplier } from "./use-current-supplier";

beforeEach(() => {
  state.session = { user: { id: "user-1" } };
  state.sessionThrows = null;
  state.row = { supplier_id: "sup-1" };
  state.queryErrors = [];
  state.filters = [];
  state.queries = 0;
});

describe("useCurrentSupplier", () => {
  it("查啟用中的 supplier_accounts,回傳 supplier_id", async () => {
    const { result } = renderHook(() => useCurrentSupplier());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current).toMatchObject({ supplierId: "sup-1", loading: false, error: null }));
    expect(state.filters).toEqual([
      ["user_id", "user-1"],
      ["is_active", true],
    ]);
  });

  it("沒有綁定供應商 → error", async () => {
    state.row = null;
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("找不到你的供應商帳號"));
  });

  it("沒登入 → error", async () => {
    state.session = null;
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("尚未登入"));
  });
});

// 錯誤原文(TypeError: Failed to fetch、PostgREST 英文訊息)不能直接出現在頁面上:一律走 db.ts 的中文轉換。
describe("useCurrentSupplier — 錯誤轉中文、可以重試", () => {
  it("查詢斷網(PostgREST 回 TypeError: Failed to fetch)→ 連線失敗", async () => {
    state.queryErrors = [{ message: "TypeError: Failed to fetch", code: "", hint: "" }];
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("連線失敗,請檢查網路後再試一次"));
    expect(result.current.supplierId).toBeNull();
  });

  it("PostgREST 英文錯誤 → 中文 + 錯誤代碼,不顯示原文", async () => {
    state.queryErrors = [{ message: "JWT expired", code: "PGRST301" }];
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("讀取供應商帳號失敗,請重新載入(錯誤代碼 PGRST301)"));
  });

  it("丟出例外(TypeError: Failed to fetch)→ 連線失敗;其他例外 → 中文備援", async () => {
    state.sessionThrows = new TypeError("Failed to fetch");
    const first = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(first.result.current.error).toBe("連線失敗,請檢查網路後再試一次"));

    state.sessionThrows = new TypeError("Cannot read properties of undefined (reading 'id')");
    const second = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(second.result.current.error).toBe("讀取供應商帳號失敗,請重新載入"));
  });

  it("reload():重新查一次,成功就拿到 supplier_id", async () => {
    state.queryErrors = [{ message: "TypeError: Failed to fetch", code: "", hint: "" }];
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("連線失敗,請檢查網路後再試一次"));
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current).toMatchObject({ supplierId: "sup-1", loading: false, error: null }));
    expect(state.queries).toBe(2);
  });
});
