// 菜色實驗室(/restaurant/lab)以前自己 fetch ai、只帶 apikey —— ai 改成強制驗證後會 401。
// 現在改走共用的 requestAi:這裡從真的頁面按「產生新菜建議」,確認送出去的請求帶著登入者的 Bearer token,
// 以及用量上限時給白話提示(不是「AI 建議即將推出」)。
//
// 🔴 fetch 一律換成假的,絕不打正式的 ai。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantLabPage from "./RestaurantLabPage";

const { toast, getSession } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  getSession: vi.fn(),
}));

/** 每張表回什麼(只給頁面需要的最少資料:一道菜用到牛腱 → 預設勾選牛腱) */
const TABLES: Record<string, unknown[]> = {
  restaurants: [{ id: "restaurant-1", cuisine_type: "台式" }],
  menu_dishes: [{ id: "dish-1" }],
  menu_dish_ingredients: [{ raw_name: "牛腱" }],
  ingredients: [],
  price_history: [],
  supplies: [],
};

const fakeFrom = (table: string) => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve({ data: TABLES[table] ?? [], error: null }).then(onFulfilled, onRejected),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => fakeFrom(t), auth: { getSession } },
}));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: null,
    role: "owner",
    restaurant_name: "好味小館",
  }),
  canSeeCost: () => true,
}));

vi.mock("sonner", () => ({ toast }));

let fetchMock: ReturnType<typeof vi.fn>;

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/lab"]}>
      <RestaurantLabPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "owner-token", user: { id: "u-1" } } }, error: null });
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data: { dishes: [{ name: "蔥爆牛腱", ingredients: ["牛腱", "青蔥"], suggested_price: 220 }] } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("菜色實驗室的 AI 呼叫", () => {
  it("按「產生新菜建議」→ 打 ai 時帶 apikey + Authorization: Bearer <登入者 token>", async () => {
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: /產生新菜建議/ });
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    expect(await screen.findByText("蔥爆牛腱")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai`);
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: "Bearer owner-token",
    });
    expect(JSON.parse(String(init.body))).toEqual({ action: "dish-ideas", ingredients: ["牛腱"], cuisine: "台式" });
  });

  it("用量上限(429 RATE_LIMITED)→ 白話提示,不顯示「AI 建議即將推出」", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "40000" }),
      json: async () => ({ code: "RATE_LIMITED", message: "rate limited", retryAfterSeconds: 40_000 }),
    });
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: /產生新菜建議/ });
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("今天的 AI 使用次數已達上限，請明天再試"));
    expect(toast.info).not.toHaveBeenCalled();
    expect(screen.queryByText(/AI 建議即將推出/)).toBeNull();
  });

  it("舊版 ai 沒有錯誤碼的錯誤 → 照舊「AI 建議即將推出」+「AI 回應 <狀態碼>」,不把伺服器的設定訊息秀給餐廳", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({ message: "AI 服務尚未設定 (GEMINI_API_KEY missing)" }),
    });
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: /產生新菜建議/ });
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("AI 建議即將推出", { description: "AI 回應 503" }),
    );
    expect(JSON.stringify(toast.info.mock.calls)).not.toContain("GEMINI_API_KEY");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
