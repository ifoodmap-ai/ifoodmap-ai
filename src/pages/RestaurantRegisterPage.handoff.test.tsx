// 註冊頁接手形象站的 AI 需求交接碼(SPEC §7):
//   網址 /register/restaurant#handoff=<analysisId>.<claimToken>
//   → 驗格式、存 localStorage、立刻 replaceState 拿掉片段、顯示說明橫幅、signUp 時放進 options.data.ifm_handoff。
// registerRestaurant 用真的(不 mock),supabase.auth.signUp 換成 spy —— 驗的是真的送出去的 signUp 參數。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";
import { HANDOFF_STORAGE_KEY, clearStoredHandoff, saveHandoff } from "@/lib/landing-handoff";
import RestaurantRegisterPage, { HANDOFF_BANNER_TEXT } from "./RestaurantRegisterPage";

const { navigate, signUp, getSession, rpc } = vi.hoisted(() => ({
  navigate: vi.fn(),
  signUp: vi.fn(),
  getSession: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "zh", setLanguage: vi.fn(), t: (key: string) => key }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession,
      signUp,
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    rpc,
  },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const HANDOFF = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d.q5Vh2kK8mX0bZr3Lw9TfYc1NpQe7JdUsHaGiOvRx4yA";

let storage: Storage;
let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigate.mockReset();
  signUp.mockReset();
  rpc.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: null }, error: null });
  // 正式環境 mailer_autoconfirm=false:signUp 不會給 session → 頁面顯示「請確認你的 Email」
  signUp.mockResolvedValue({
    data: { user: { identities: [{ id: "identity-1" }] }, session: null },
    error: null,
  });
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  clearStoredHandoff();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  clearStoredHandoff();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  expect(fetchGuard).not.toHaveBeenCalled();
});

const renderAt = (url: string) => {
  window.history.replaceState(null, "", url);
  return render(
    <MemoryRouter initialEntries={["/register/restaurant"]}>
      <RestaurantRegisterPage />
    </MemoryRouter>,
  );
};

const fillAndSubmit = async () => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("餐廳名稱"), "好食餐廳");
  await user.type(screen.getByLabelText("聯絡人姓名"), "王小明");
  await user.type(screen.getByLabelText("聯絡電話"), "0912345678");
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("密碼"), "password123");
  await user.type(screen.getByLabelText("確認密碼"), "password123");
  await user.click(screen.getByRole("checkbox", { name: "同意服務條款" }));
  await user.click(screen.getByRole("button", { name: "建立餐廳帳號" }));
};

describe("RestaurantRegisterPage — 形象站 AI 需求交接", () => {
  it("帶 #handoff= 進來:立刻把片段從網址拿掉(replaceState)、存進 localStorage、顯示說明橫幅", async () => {
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    renderAt(`/register/restaurant#handoff=${encodeURIComponent(HANDOFF)}`);

    expect(await screen.findByTestId("handoff-banner")).toHaveTextContent(HANDOFF_BANNER_TEXT);
    expect(HANDOFF_BANNER_TEXT).toBe(
      "你跟 AI 採購助手聊的需求已經保存，註冊完成後會自動幫你建成一張採購單草稿",
    );
    // renderAt 自己呼叫一次設定網址,第二次才是頁面拿掉片段
    expect(replaceSpy).toHaveBeenLastCalledWith(null, "", "/register/restaurant");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("handoff");
    expect(JSON.parse(storage.getItem(HANDOFF_STORAGE_KEY) ?? "null")).toMatchObject({ v: HANDOFF });
  });

  it("送出註冊:signUp 的 options.data 帶 ifm_handoff(換裝置開確認信也帶得過去)", async () => {
    renderAt(`/register/restaurant#handoff=${encodeURIComponent(HANDOFF)}`);
    await screen.findByTestId("handoff-banner");

    await fillAndSubmit();

    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    const options = (signUp.mock.calls[0][0] as { options: { data: Record<string, unknown> } }).options;
    expect(options.data).toMatchObject({
      pending_restaurant_name: "好食餐廳",
      ifm_handoff: HANDOFF,
    });
    // 要收確認信 → 顯示「請確認你的 Email」,橫幅還在(交接碼也還在 localStorage,等進 /restaurant 認領)
    expect(await screen.findByText("請確認你的 Email")).toBeInTheDocument();
    expect(screen.getByTestId("handoff-banner")).toBeInTheDocument();
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).not.toBeNull();
  });

  it("之前存過、還沒過期(例如先去登入頁又回來)→ 沒有片段也顯示橫幅,signUp 照樣帶交接碼", async () => {
    saveHandoff(HANDOFF);
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    renderAt("/register/restaurant");

    expect(await screen.findByTestId("handoff-banner")).toBeInTheDocument();
    // 只有 renderAt 設定網址那一次,頁面沒有多動網址
    expect(replaceSpy).toHaveBeenCalledTimes(1);

    await fillAndSubmit();
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect((signUp.mock.calls[0][0] as { options: { data: Record<string, unknown> } }).options.data.ifm_handoff).toBe(
      HANDOFF,
    );
  });

  it("沒有交接碼:沒有橫幅,signUp 不帶 ifm_handoff", async () => {
    renderAt("/register/restaurant");
    await screen.findByRole("heading", { name: "建立餐廳帳號" });
    expect(screen.queryByTestId("handoff-banner")).toBeNull();

    await fillAndSubmit();
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect((signUp.mock.calls[0][0] as { options: { data: Record<string, unknown> } }).options.data).not.toHaveProperty(
      "ifm_handoff",
    );
  });

  it("交接碼格式不對:一樣從網址拿掉,但不存、不顯示橫幅", async () => {
    renderAt("/register/restaurant#handoff=not-a-real-token");
    await screen.findByRole("heading", { name: "建立餐廳帳號" });

    expect(window.location.hash).toBe("");
    expect(screen.queryByTestId("handoff-banner")).toBeNull();
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
  });
});
