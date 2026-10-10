import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    session: { user: { id: "user-1" } } as { user: { id: string } } | null,
    row: { supplier_id: "sup-1" } as { supplier_id: string } | null,
    filters: [] as Array<[string, unknown]>,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: () => {
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          state.filters.push([c, v]);
          return b;
        },
        maybeSingle: async () => ({ data: state.row, error: null }),
      };
      return b;
    },
  },
}));

import { useCurrentSupplier } from "./use-current-supplier";

beforeEach(() => {
  state.session = { user: { id: "user-1" } };
  state.row = { supplier_id: "sup-1" };
  state.filters = [];
});

describe("useCurrentSupplier", () => {
  it("查啟用中的 supplier_accounts,回傳 supplier_id", async () => {
    const { result } = renderHook(() => useCurrentSupplier());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current).toEqual({ supplierId: "sup-1", loading: false, error: null }));
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
