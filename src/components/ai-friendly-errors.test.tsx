// ai 回錯誤碼時(SPEC §2)聊天泡泡與菜單上傳要給白話中文,不露技術錯誤;
// 舊版 ai / 網路錯誤(沒有錯誤碼)維持原本的顯示 —— 那部分由 Chatbot.test.tsx 的快照鎖住。
// AI 呼叫全部 mock 掉,fetch 換成一律失敗的假函式當保險。

import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { AiError } from "@/lib/api";
import Chatbot from "./Chatbot";
import MenuUpload from "./MenuUpload";

const { chatReply, analyzeChat, analyzeMenu, toastError } = vi.hoisted(() => ({
  chatReply: vi.fn(),
  analyzeChat: vi.fn(),
  analyzeMenu: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, chatReply, analyzeChat, analyzeMenu };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

const renderWithLanguage = (ui: ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

const DAILY_LIMIT = () =>
  new AiError("Rate limit exceeded for user 1234 (bucket ai:user:day)", {
    status: 429,
    code: "RATE_LIMITED",
    retryAfterSeconds: 36_000,
  });

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  chatReply.mockReset();
  analyzeChat.mockReset();
  analyzeMenu.mockReset();
  toastError.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("Chatbot:用量上限給白話提示", () => {
  it("429 RATE_LIMITED → 泡泡與 toast 都是「今天的 AI 使用次數已達上限，請明天再試」,不露技術訊息", async () => {
    chatReply.mockRejectedValueOnce(DAILY_LIMIT());
    renderWithLanguage(<Chatbot variant="panel" onRequirementsSubmit={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "輸入食材需求" });
    fireEvent.change(input, { target: { value: "我要牛肉" } });
    fireEvent.keyPress(input, { key: "Enter", code: "Enter", charCode: 13 });

    expect(await screen.findByText("今天的 AI 使用次數已達上限，請明天再試")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("今天的 AI 使用次數已達上限，請明天再試");
    expect(screen.queryByText(/抱歉,AI 服務暫時無法回覆/)).toBeNull();
    expect(screen.queryByText(/bucket|1234|Rate limit/)).toBeNull();
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("Rate limit"));
    // 打字中的三個點要收掉,可以再輸入
    await waitFor(() => expect(screen.queryByText("AI 正在分析...")).toBeNull());
  });

  it("需求整理(analyzeChat)被限流也一樣", async () => {
    chatReply.mockResolvedValueOnce({ reply: "好的,我來整理" });
    analyzeChat.mockRejectedValueOnce(new AiError("x", { status: 429, code: "RATE_LIMITED", retryAfterSeconds: 120 }));
    renderWithLanguage(<Chatbot variant="panel" onRequirementsSubmit={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "輸入食材需求" });
    fireEvent.change(input, { target: { value: "牛肉 5kg,幫我找供應商" } });
    fireEvent.keyPress(input, { key: "Enter", code: "Enter", charCode: 13 });

    expect(await screen.findByText("AI 使用太頻繁了，請 2 分鐘後再試")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("AI 使用太頻繁了，請 2 分鐘後再試");
  });
});

describe("MenuUpload:用量上限給白話提示", () => {
  it("429 RATE_LIMITED → toast「今天的 AI 使用次數已達上限，請明天再試」(不是「AI 分析失敗:<技術訊息>」)", async () => {
    const createObjectURL = vi.fn(() => "blob:menu-preview");
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL }));
    analyzeMenu.mockRejectedValueOnce(DAILY_LIMIT());
    const { container } = renderWithLanguage(<MenuUpload compact onAnalysisComplete={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>("#menu-upload");
    if (!input) throw new Error("找不到上傳 input");
    fireEvent.change(input, { target: { files: [new File(["img"], "menu.jpg", { type: "image/jpeg" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "開始分析" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("今天的 AI 使用次數已達上限，請明天再試"));
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("AI 分析失敗"));
  });

  it("沒有錯誤碼的錯誤 → 照舊「AI 分析失敗:<訊息>」", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => "blob:x") }));
    analyzeMenu.mockRejectedValueOnce(new Error("逾時"));
    const { container } = renderWithLanguage(<MenuUpload compact onAnalysisComplete={vi.fn()} />);

    const input = container.querySelector<HTMLInputElement>("#menu-upload");
    if (!input) throw new Error("找不到上傳 input");
    fireEvent.change(input, { target: { files: [new File(["img"], "menu.jpg", { type: "image/jpeg" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "開始分析" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("AI 分析失敗:逾時"));
  });
});
