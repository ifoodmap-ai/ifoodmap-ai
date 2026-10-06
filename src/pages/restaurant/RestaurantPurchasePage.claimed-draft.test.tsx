// 形象站 AI 對話認領成的採購單草稿(claim_landing_analysis 建的 draft,notes = 'AI 採購助手帶入'):
//   ①新註冊的老闆在「叫貨」頁的待簽核區看得到這張草稿,可以「核准並送出」(draft → submitted)
//   ②本來就停在這一頁時才認領完成(Layout 帶 state.claimedOrderId 導過來)→ 重抓草稿,剛建好的那張要出現
// supabase 換成記憶體假資料(同 RestaurantPurchasePage.test.tsx 的寫法),recordOrderEvent 換成 spy,擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantPurchasePage from "./RestaurantPurchasePage";

type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; op: string; cols?: string; values?: unknown; filters: Filter[] }

const { state, recordOrderEvent, toast } = vi.hoisted(() => ({
  state: { calls: [] as Call[], drafts: [] as Record<string, unknown>[] },
  recordOrderEvent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const result = () => {
    state.calls.push(call);
    if (table !== "supplier_orders") return { data: [], error: null };
    const onlyDrafts = call.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft");
    const byId = call.filters.find(([op, col]) => op === "eq" && col === "id")?.[2];
    const matched = byId ? state.drafts.filter((d) => d.id === byId) : state.drafts;
    if (call.op === "update") return { data: onlyDrafts ? matched.map((d) => ({ id: d.id })) : [], error: null };
    return { data: onlyDrafts ? matched : [], error: null };
  };
  const builder = {
    select: (cols?: string) => { if (call.op === "select") call.cols = cols; return builder; },
    insert: (values: unknown) => { call.op = "insert"; call.values = values; return builder; },
    update: (values: unknown) => { call.op = "update"; call.values = values; return builder; },
    eq: (col: string, val: unknown) => { call.filters.push(["eq", col, val]); return builder; },
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(result()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled, onRejected),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getUser: async () => ({ data: { user: { id: "owner-user" } } }) },
  },
}));

// 新註冊的人 = 自己店的老闆(create_restaurant_onboarding 建的 owner)
vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-new",
    branch_id: "branch-main",
    role: "owner",
    restaurant_name: "新開的小館",
  }),
  canSeeCost: () => true,
  needsApproval: () => false,
}));

vi.mock("./RestaurantAnalyzePage", () => ({ ANALYSIS_HANDOFF_KEY: "ifm_analysis_handoff" }));
vi.mock("@/lib/orders", () => ({ recordOrderEvent }));
vi.mock("sonner", () => ({ toast }));

/** claim_landing_analysis 建出來的那張(created_by = 老闆自己、ingredient_list = cart 格式、quantity 是字串) */
const AI_DRAFT = {
  id: "0b6c3e2a-7d14-4f58-9a3b-2c1d0e9f8a7b",
  created_at: "2026-10-07T02:00:00Z",
  status: "draft",
  ingredient_list: [
    { name: "牛腱", quantity: "10", unit: "kg" },
    { name: "青蔥", quantity: "", unit: "" },
  ],
  created_by: "owner-user",
  approved_by: null,
  notes: "AI 採購助手帶入",
};

/** 模擬 RestaurantLayout 認領完成後的導頁(本來就停在採購頁) */
const ClaimNavigator = () => {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/restaurant/purchase", { state: { claimedOrderId: AI_DRAFT.id } })}>
      模擬認領完成
    </button>
  );
};

const renderPage = (entry: string | { pathname: string; state: unknown } = "/restaurant/purchase") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ClaimNavigator />
      <Routes>
        <Route path="/restaurant/purchase" element={<RestaurantPurchasePage />} />
      </Routes>
    </MemoryRouter>,
  );

const draftSelects = () =>
  state.calls.filter(
    (c) => c.table === "supplier_orders" && c.op === "select" && c.filters.some(([, col, val]) => col === "status" && val === "draft"),
  );

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.calls = [];
  state.drafts = [{ ...AI_DRAFT }];
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
  toast.success.mockReset();
  toast.error.mockReset();
  sessionStorage.clear();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("AI 採購助手帶入的草稿 —— 新註冊的老闆", () => {
  it("待簽核區看得到這張草稿(品項 + 「AI 採購助手帶入」),有「核准並送出」與「退回」", async () => {
    renderPage();

    const card = await screen.findByTestId("pending-approval");
    expect(within(card).getByText(/待簽核採購單/)).toHaveTextContent("待簽核採購單（1）");
    expect(within(card).getByText(/AI 採購助手帶入的採購單/)).toBeInTheDocument();
    const row = within(card).getByTestId("pending-draft");
    expect(row).toHaveTextContent("牛腱、青蔥");
    expect(row).toHaveTextContent("AI 採購助手帶入");
    expect(within(row).getByRole("button", { name: /核准並送出/ })).toBeEnabled();
    expect(within(row).getByRole("button", { name: /退回/ })).toBeEnabled();

    // 讀的是自己店的草稿
    expect(draftSelects()[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "restaurant_id", "restaurant-new"],
        ["eq", "status", "draft"],
      ]),
    );
  });

  it("按「核准並送出」→ 記下核准人(只在還是草稿時),再寫 draft → submitted 事件,這張從待簽核區消失", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = within(await screen.findByTestId("pending-approval")).getByTestId("pending-draft");

    await user.click(within(row).getByRole("button", { name: /核准並送出/ }));

    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    const stamp = state.calls.find((c) => c.table === "supplier_orders" && c.op === "update");
    expect(stamp?.values).toMatchObject({ approved_by: "owner-user" });
    expect(stamp?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", AI_DRAFT.id],
        ["eq", "status", "draft"],
      ]),
    );
    expect(recordOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: AI_DRAFT.id, fromStatus: "draft", toStatus: "submitted", actorRole: "restaurant" }),
    );
    expect(toast.success).toHaveBeenCalledWith("已核准並送出");
    await waitFor(() => expect(screen.queryByTestId("pending-approval")).toBeNull());
  });
});

describe("認領完成時本來就停在採購頁", () => {
  it("第一次載入時草稿還沒建好 → 收到 claimedOrderId 後重抓,AI 草稿出現", async () => {
    state.drafts = []; // 頁面先載入,RPC 還沒建出草稿
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: /智慧採購/ });
    expect(screen.queryByTestId("pending-approval")).toBeNull();
    const before = draftSelects().length;

    state.drafts = [{ ...AI_DRAFT }]; // RPC 建好了,Layout 帶 state 導過來
    await user.click(screen.getByRole("button", { name: "模擬認領完成" }));

    const card = await screen.findByTestId("pending-approval");
    expect(within(card).getByTestId("pending-draft")).toHaveTextContent("AI 採購助手帶入");
    expect(draftSelects().length).toBe(before + 1);
  });

  it("一般進入(沒有 claimedOrderId)不會多抓一次", async () => {
    renderPage();
    await screen.findByTestId("pending-approval");
    expect(draftSelects()).toHaveLength(1);
  });
});
