// db.ts:錯誤會帶出 code / hint,hint 會翻成中文;uuid 工具。supabase 換成假的,不打網路。
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (fn: string) =>
      fn === "boom"
        ? { data: null, error: { message: "new row violates", code: "22023", hint: "transfer_info_required" } }
        : { data: { ok: true }, error: null },
  },
}));

import { friendlyDbError, isUuid, MarketDbError, marketRpc, newUuid, unwrap } from "./db";

describe("unwrap / marketRpc", () => {
  it("沒錯就回 data", async () => {
    expect(unwrap({ data: [1], error: null })).toEqual([1]);
    await expect(marketRpc("ok", {})).resolves.toEqual({ ok: true });
  });

  it("有錯丟 MarketDbError,帶 code 與 hint", async () => {
    const err = await marketRpc("boom", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketDbError);
    expect((err as MarketDbError).code).toBe("22023");
    expect((err as MarketDbError).hint).toBe("transfer_info_required");
  });
});

describe("friendlyDbError", () => {
  it("認得的 hint 翻成中文", () => {
    expect(friendlyDbError(new MarketDbError({ message: "x", hint: "review_status_forbidden" }))).toBe(
      "商品要經過管理員審核才能上架",
    );
  });

  it("外鍵錯誤 = 還沒建店家;CHECK 錯誤 = 欄位格式", () => {
    expect(friendlyDbError(new MarketDbError({ message: "fk", code: "23503" }))).toMatch(/店家設定/);
    expect(friendlyDbError(new MarketDbError({ message: "check", code: "23514" }))).toMatch(/長度上限或格式/);
  });

  it("不認得的照原文、一般 Error 照 message", () => {
    expect(friendlyDbError(new MarketDbError({ message: "原文" }))).toBe("原文");
    expect(friendlyDbError(new Error("一般錯誤"))).toBe("一般錯誤");
  });
});

describe("uuid", () => {
  it("newUuid 產生合法的 v4 uuid,isUuid 認得", () => {
    const id = newUuid();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("4");
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
