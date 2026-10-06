// 產品站打 ai Edge Function 的身分標頭(SPEC §1):
//   - 有登入 → Authorization: Bearer <session.access_token>(user tier);apikey 照舊帶
//   - 沒有 session / 讀 session 失敗 → 不帶 Authorization,照樣送出(舊版 ai、相容模式都能用)
// 以及錯誤碼 → 白話中文(SPEC §2),不認得的錯誤保留原本訊息。
//
// 🔴 測試環境會讀到 .env.local 的正式 Supabase 網址 —— fetch 一律換成假的,絕不打正式的 ai(會計費、會進正式庫)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession } },
}));

import {
  AiError,
  aiRequestHeaders,
  analyzeChat,
  analyzeMenu,
  chatReply,
  friendlyAiError,
  requestAi,
} from "./api";

const AI_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai`;
const APIKEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type FakeResponseInit = { status?: number; body?: unknown; headers?: Record<string, string> };

const fakeResponse = ({ status = 200, body = { data: {} }, headers = {} }: FakeResponseInit = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
});

let fetchMock: ReturnType<typeof vi.fn>;

const sentHeaders = (call = 0) => (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

const withSession = (token = "user-access-token") =>
  getSession.mockResolvedValue({ data: { session: { access_token: token, user: { id: "u-1" } } }, error: null });
const withoutSession = () => getSession.mockResolvedValue({ data: { session: null }, error: null });

/** 每一個 ai 呼叫點(api.ts 的三支 + 菜色實驗室用的 requestAi) */
const CALL_SITES: [string, () => Promise<unknown>][] = [
  ["analyzeMenu(菜單上傳)", () => analyzeMenu(new File(["fake"], "menu.jpg", { type: "image/jpeg" }))],
  ["analyzeChat(對話萃取)", () => analyzeChat([{ role: "user", text: "我要牛肉" }])],
  ["chatReply(AI 對話)", () => chatReply([{ role: "user", text: "你好" }])],
  ["requestAi(菜色實驗室 dish-ideas)", () => requestAi({ action: "dish-ideas", ingredients: ["牛肉"] })],
];

beforeEach(() => {
  getSession.mockReset();
  fetchMock = vi.fn(async () => fakeResponse({ body: { data: { reply: "好", ingredients: [], summary: "" } } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai 呼叫的身分標頭", () => {
  it.each(CALL_SITES)("%s:有登入 → 帶 Authorization: Bearer <access_token>,apikey 照舊", async (_name, call) => {
    withSession("tok-123");
    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(AI_URL);
    expect(init.method).toBe("POST");
    expect(sentHeaders()).toEqual({
      "Content-Type": "application/json",
      apikey: APIKEY,
      Authorization: "Bearer tok-123",
    });
  });

  it.each(CALL_SITES)("%s:沒有 session → 不帶 Authorization,照樣送出", async (_name, call) => {
    withoutSession();
    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).toEqual({ "Content-Type": "application/json", apikey: APIKEY });
    expect(sentHeaders()).not.toHaveProperty("Authorization");
  });

  it("讀 session 失敗(丟錯)→ 不帶 Authorization,AI 照樣能用", async () => {
    getSession.mockRejectedValue(new Error("auth lock timeout"));
    await chatReply([{ role: "user", text: "你好" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentHeaders()).not.toHaveProperty("Authorization");
    expect(sentHeaders().apikey).toBe(APIKEY);
  });

  it("session 沒有 access_token(或是空字串)→ 不帶 Authorization", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "", user: { id: "u-1" } } }, error: null });
    expect(await aiRequestHeaders()).not.toHaveProperty("Authorization");
  });

  it("每次呼叫都重新讀 session(換人登入、token 換新都跟得上)", async () => {
    withSession("first");
    await chatReply([{ role: "user", text: "1" }]);
    withSession("second");
    await chatReply([{ role: "user", text: "2" }]);

    expect(sentHeaders(0).Authorization).toBe("Bearer first");
    expect(sentHeaders(1).Authorization).toBe("Bearer second");
  });
});

describe("ai 的錯誤 → 使用者看得懂的提示", () => {
  beforeEach(() => withSession());

  it("429 RATE_LIMITED:丟 AiError(錯誤碼、retryAfterSeconds 從 body 讀)", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 429,
        body: { code: "RATE_LIMITED", message: "今日額度已用完", retryAfterSeconds: 43_200 },
        headers: { "Retry-After": "43200" },
      }),
    );

    const error = await chatReply([{ role: "user", text: "你好" }]).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterSeconds: 43_200 });
    // 每日額度(要等超過一小時)→ 業主指定的那句
    expect(friendlyAiError(error)).toBe("今天的 AI 使用次數已達上限，請明天再試");
  });

  it("RATE_LIMITED 但一小時內就能再用(10 分鐘頻率上限)→ 講幾分鐘後再試", () => {
    const error = new AiError("x", { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 250 });
    expect(friendlyAiError(error)).toBe("AI 使用太頻繁了，請 5 分鐘後再試");
    expect(friendlyAiError(new AiError("x", { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 3 }))).toBe(
      "AI 使用太頻繁了，請 1 分鐘後再試",
    );
  });

  it("body 沒帶 retryAfterSeconds 時改讀 Retry-After 標頭", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 429, body: { code: "RATE_LIMITED", message: "慢一點" }, headers: { "Retry-After": "120" } }),
    );
    const error = await requestAi({ action: "chat" }).catch((e) => e);
    expect(error.retryAfterSeconds).toBe(120);
    expect(friendlyAiError(error)).toBe("AI 使用太頻繁了，請 2 分鐘後再試");
  });

  it("不知道要等多久 → 不亂講「明天」", () => {
    expect(friendlyAiError(new AiError("x", { status: 429, code: "RATE_LIMITED" }))).toBe(
      "AI 使用次數已達上限，請稍後再試",
    );
    // 沒有錯誤碼的 429(例如閘道層)也當限流
    expect(friendlyAiError(new AiError("Too Many Requests", { status: 429 }))).toBe("AI 使用次數已達上限，請稍後再試");
  });

  it.each([
    ["DAILY_CAP", 429, "今天的 AI 服務使用量已達上限，請明天再試"],
    ["CONVERSATION_LIMIT", 429, "這段對話已經很長了，請重新開始一段新的對話"],
    ["TOO_LONG", 413, "訊息太長了，請精簡後再送出"],
    ["IMAGE_TOO_LARGE", 413, "照片太大了，請換一張較小的照片"],
    ["BODY_TOO_LARGE", 413, "照片太大了，請換一張較小的照片"],
    ["UNSUPPORTED_IMAGE", 415, "這種圖片格式無法辨識，請改用 JPG 或 PNG 照片"],
    ["UNAUTHORIZED", 401, "登入狀態已過期，請重新登入後再試"],
    ["ACTION_NOT_ALLOWED", 403, "目前無法使用這項 AI 功能"],
    ["AI_UPSTREAM", 502, "AI 服務暫時忙碌，請稍後再試"],
  ])("%s → %s", (code, status, text) => {
    const error = new AiError("raw upstream detail: gemini 500 INTERNAL", { status, code });
    expect(friendlyAiError(error)).toBe(text);
    expect(friendlyAiError(error)).not.toMatch(/gemini|INTERNAL|raw/i);
  });

  it("舊版 ai 的錯誤(沒有錯誤碼)→ 不改寫,訊息照舊(呼叫端維持原本的顯示)", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 502, body: { message: "AI 分析失敗", details: "..." } }));
    const error = await analyzeChat([{ role: "user", text: "牛肉" }]).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("AI 分析失敗");
    expect(error.code).toBeNull();
    expect(friendlyAiError(error)).toBeNull();
  });

  it("一般 Error(網路斷線等)→ friendlyAiError 回 null", () => {
    expect(friendlyAiError(new Error("Failed to fetch"))).toBeNull();
    expect(friendlyAiError("oops")).toBeNull();
  });

  it("成功時 aiCall 只回 data,requestAi 回整包", async () => {
    fetchMock.mockResolvedValue(fakeResponse({ body: { data: { reply: "您好" } } }));
    await expect(chatReply([{ role: "user", text: "hi" }])).resolves.toEqual({ reply: "您好" });
    fetchMock.mockResolvedValue(fakeResponse({ body: { data: { dishes: [] } } }));
    await expect(requestAi({ action: "dish-ideas" })).resolves.toEqual({ data: { dishes: [] } });
  });
});
