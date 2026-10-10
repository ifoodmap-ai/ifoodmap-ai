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

  it("hint 只認表裡自己的 key:constructor / toString / __proto__ 不會拿到函式或物件", () => {
    for (const hint of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(friendlyDbError(new MarketDbError({ message: "原文", hint }))).toBe("原文");
    }
  });

  it("照片沒傳完就核准(photos_not_uploaded)", () => {
    expect(friendlyDbError(new MarketDbError({ message: "x", code: "22023", hint: "photos_not_uploaded" }))).toBe(
      "這個商品還有照片沒有上傳完成,無法核准",
    );
  });

  it("斷網:fetch 失敗、沒有 code 也沒有 hint → 連線失敗", () => {
    const offline = "連線失敗,請檢查網路後再試一次";
    // supabase-js(postgrest-js 2.78)斷網時回 { message: "TypeError: Failed to fetch", hint: "", code: "" }
    expect(friendlyDbError(new MarketDbError({ message: "TypeError: Failed to fetch", hint: "", code: "" }))).toBe(offline);
    // Safari、Firefox 的寫法
    expect(friendlyDbError(new MarketDbError({ message: "TypeError: Load failed", hint: "", code: "" }))).toBe(offline);
    expect(
      friendlyDbError(new MarketDbError({ message: "TypeError: NetworkError when attempting to fetch resource.", hint: "", code: "" })),
    ).toBe(offline);
    // 直接丟出來的 TypeError(沒經過 PostgREST 的 fetch)
    expect(friendlyDbError(new TypeError("Failed to fetch"))).toBe(offline);
    // 資料庫真的回了錯誤碼就不是斷網,照原本的規則
    expect(friendlyDbError(new MarketDbError({ message: "Failed to fetch policy", code: "42501" }))).toBe("沒有權限做這個動作");
    expect(friendlyDbError(new TypeError("x is not a function"))).toBe("x is not a function");
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
