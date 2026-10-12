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

import { friendlyDbError, friendlyStorageError, isUuid, MarketDbError, marketRpc, newUuid, unwrap } from "./db";

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
  it("店家法定資訊沒填齊(store_disclosure_missing)→ 中文,講清楚要填哪些", () => {
    expect(friendlyDbError(new MarketDbError({ message: "x", code: "22023", hint: "store_disclosure_missing" }))).toBe(
      "開放零售前要填齊店家法定資訊:登記名稱、負責人、營業所地址、客服 Email,以及供應商資料的電話",
    );
  });

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

// 有給中文備援的地方(店家設定頁、useCurrentSupplier、圖片欄位):英文原文不會直接出現在畫面上。
describe("friendlyDbError 的中文備援", () => {
  const FB = "讀取供應商帳號失敗,請重新載入";

  it("認不得的資料庫錯誤 → 備援文字 + 錯誤代碼(不顯示英文原文);沒有代碼就只有備援", () => {
    expect(friendlyDbError(new MarketDbError({ message: "JWT expired", code: "PGRST301" }), FB)).toBe(`${FB}(錯誤代碼 PGRST301)`);
    expect(friendlyDbError(new MarketDbError({ message: "something odd" }), FB)).toBe(FB);
  });

  it("認得的照舊:hint、權限、斷網都還是原本的中文", () => {
    expect(friendlyDbError(new MarketDbError({ message: "x", code: "42501" }), FB)).toBe("沒有權限做這個動作");
    expect(friendlyDbError(new MarketDbError({ message: "TypeError: Failed to fetch", code: "", hint: "" }), FB)).toBe(
      "連線失敗,請檢查網路後再試一次",
    );
    expect(friendlyDbError(new TypeError("Failed to fetch"), FB)).toBe("連線失敗,請檢查網路後再試一次");
  });

  it("市集自己丟的錯(名稱 Market 開頭,訊息本來就是中文)照原訊息;其他非預期的錯誤用備援", () => {
    class MarketImageError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "MarketImageError";
      }
    }
    expect(friendlyDbError(new MarketImageError("只收 JPG、PNG、WebP 照片"), FB)).toBe("只收 JPG、PNG、WebP 照片");
    expect(friendlyDbError(new TypeError("x is not a function"), FB)).toBe(FB);
    expect(friendlyDbError("boom", FB)).toBe(FB);
  });

  it("沒給備援時行為不變(其他頁面照舊)", () => {
    expect(friendlyDbError(new MarketDbError({ message: "原文", code: "PGRST301" }))).toBe("原文");
    expect(friendlyDbError(new Error("一般錯誤"))).toBe("一般錯誤");
  });
});

// Storage 上傳的錯誤(storage-js 的 StorageApiError:HTTP status + 伺服器的 statusCode;斷網是 StorageUnknownError)
describe("friendlyStorageError", () => {
  it("權限:RLS 擋下(HTTP 400 + statusCode 403)、401 / 403", () => {
    const msg = "沒有權限上傳到這個店家的資料夾,請重新登入後再試";
    expect(friendlyStorageError({ message: "new row violates row-level security policy", status: 400, statusCode: "403" })).toBe(msg);
    expect(friendlyStorageError({ message: "Unauthorized", status: 401 })).toBe(msg);
    expect(friendlyStorageError({ message: "new row violates row-level security policy" })).toBe(msg);
  });

  it("同名檔案、太大、格式不對、斷網、其他", () => {
    expect(friendlyStorageError({ message: "The resource already exists", status: 409 })).toBe("同名的檔案已經存在,請重新選一次照片");
    expect(friendlyStorageError({ message: "The object exceeded the maximum allowed size", status: 413 })).toBe(
      "照片超過 2 MB,請換一張或先縮小再上傳",
    );
    expect(friendlyStorageError({ message: "mime type image/gif is not supported", statusCode: "415" })).toBe("只收 JPG、PNG、WebP 照片");
    expect(friendlyStorageError({ message: "Failed to fetch" })).toBe("連線失敗,請檢查網路後再試一次");
    expect(friendlyStorageError({ message: "Internal Server Error", status: 500 })).toBe("伺服器暫時無法處理,請稍後再試");
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
