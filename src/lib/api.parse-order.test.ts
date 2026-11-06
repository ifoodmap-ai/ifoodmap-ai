// parseOrder:叫貨頁「貼上訊息 / 拍手寫單」打 ai 的 parse-order。fetch 一律換成假的,不打正式的 ai。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession } } }));

import { AiError, parseOrder } from "./api";

let fetchMock: ReturnType<typeof vi.fn>;
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
const sentBody = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

beforeEach(() => {
  getSession.mockResolvedValue({ data: { session: { access_token: "tok", user: { id: "u" } } }, error: null });
  fetchMock = vi.fn(async () => reply(200, { data: { items: [{ name: "高麗菜", quantity: 10, unit: "kg", source_text: "高麗菜10公斤" }], unclear: ["那個"] } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("parseOrder", () => {
  it("文字:action = parse-order,帶文字與已知品名;沒給的欄位不送", async () => {
    const r = await parseOrder({ text: "  高麗菜 10kg  ", knownItems: ["高麗菜", "雞蛋"] });
    expect(sentBody()).toEqual({ action: "parse-order", text: "高麗菜 10kg", knownItems: ["高麗菜", "雞蛋"] });
    expect(r.items).toEqual([{ name: "高麗菜", quantity: 10, unit: "kg", source_text: "高麗菜10公斤" }]);
    expect(r.unclear).toEqual(["那個"]);
  });

  it("圖片:base64(不含 data: 前綴)與 mimeType", async () => {
    await parseOrder({ file: new File(["abc"], "note.png", { type: "image/png" }) });
    const body = sentBody();
    expect(body).toMatchObject({ action: "parse-order", mimeType: "image/png" });
    expect(atob(body.image)).toBe("abc");
    expect(body.text).toBeUndefined();
  });

  it("帶登入身分(Bearer token)", async () => {
    await parseOrder({ text: "雞蛋 2箱" });
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("回應缺欄位 → 當成沒辨識到,不爆", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: {} }));
    expect(await parseOrder({ text: "x" })).toEqual({ items: [], unclear: [] });
  });

  it("額度用完等錯誤照樣丟 AiError(畫面用 friendlyAiError 轉白話)", async () => {
    fetchMock.mockResolvedValueOnce(reply(429, { code: "DAILY_CAP", message: "limit", retryAfterSeconds: 7200 }));
    await expect(parseOrder({ text: "x" })).rejects.toBeInstanceOf(AiError);
  });
});
