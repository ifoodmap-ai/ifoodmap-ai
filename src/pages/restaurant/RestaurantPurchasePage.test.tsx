// 「叫貨與訂單 → 叫貨」分頁(/restaurant/purchase)的待簽核區(業主拍板 Q8-A):
//   - 採購員:看得到自己店裡的草稿,但只有「等待簽核」,沒有任何送出/退回按鈕;自己建單只會建草稿
//   - 老闆、店長:待簽核區有「核准並送出」(draft → submitted)與「退回」(draft → cancelled)
// supabase 換成記憶體假資料(記錄每次寫入),recordOrderEvent 換成 spy,並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantPurchasePage from "./RestaurantPurchasePage";

type Role = "owner" | "manager" | "purchaser";
type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; op: string; cols?: string; values?: unknown; filters: Filter[] }

const { state, recordOrderEvent, toast } = vi.hoisted(() => ({
  state: {
    role: "owner" as Role,
    calls: [] as Call[],
    drafts: [] as Record<string, unknown>[],
    /** 畫面載入後才被別人處理掉的草稿(資料庫裡已經不是 draft) */
    handledElsewhere: [] as string[],
    /** 這家店已綁定的合作供應商 */
    bound: ["sup-1"] as string[],
  },
  recordOrderEvent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const result = () => {
    state.calls.push(call);
    if (table === "restaurant_suppliers") return { data: state.bound.map((id) => ({ supplier_id: id })), error: null };
    if (table === "suppliers") return { data: [{ id: "sup-1", name: "阿明蔬果", is_active: true }], error: null };
    if (table !== "supplier_orders") return { data: [], error: null };
    if (call.op === "insert") return { data: { id: "new-order-1" }, error: null };
    const onlyDrafts = call.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft");
    const byId = call.filters.find(([op, col]) => op === "eq" && col === "id")?.[2];
    // 資料庫裡「現在」還是草稿的單
    const pending = state.drafts.filter((d) => !state.handledElsewhere.includes(String(d.id)));
    const matched = byId ? pending.filter((d) => d.id === byId) : pending;
    if (call.op === "update") return { data: onlyDrafts ? matched.map((d) => ({ id: d.id })) : [], error: null };
    return { data: onlyDrafts ? matched : [], error: null };
  };
  const builder = {
    select: (cols?: string) => { if (call.op === "select") call.cols = cols; return builder; },
    insert: (values: unknown) => { call.op = "insert"; call.values = values; return builder; },
    update: (values: unknown) => { call.op = "update"; call.values = values; return builder; },
    eq: (col: string, val: unknown) => { call.filters.push(["eq", col, val]); return builder; },
    in: () => builder,
    not: () => builder,
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
    auth: { getUser: async () => ({ data: { user: { id: `user-${state.role}` } } }) },
  },
}));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: "branch-1",
    role: state.role,
    restaurant_name: "好味小館",
  }),
  canSeeCost: (role: Role) => role === "owner" || role === "manager",
  needsApproval: (role: Role) => role === "purchaser",
}));

// 只需要交接用的 key,不要把整個 AI 分析頁(與它的相依)拉進來
vi.mock("./RestaurantAnalyzePage", () => ({ ANALYSIS_HANDOFF_KEY: "ifm_analysis_handoff" }));
vi.mock("@/lib/orders", () => ({ recordOrderEvent }));
vi.mock("sonner", () => ({ toast }));

const DRAFT = {
  id: "draft-0001",
  created_at: "2026-09-28T01:00:00Z",
  status: "draft",
  ingredient_list: [{ name: "高麗菜", quantity: "3", unit: "kg" }, { name: "洋蔥", quantity: "2", unit: "kg" }],
  created_by: "user-purchaser",
  approved_by: null,
  notes: "明早 8 點前送到",
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/purchase"]}>
      <RestaurantPurchasePage />
    </MemoryRouter>,
  );

const pendingCard = () => screen.findByTestId("pending-approval");

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.role = "owner";
  state.calls = [];
  state.drafts = [{ ...DRAFT }];
  state.handledElsewhere = [];
  state.bound = ["sup-1"];
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
  sessionStorage.clear();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("RestaurantPurchasePage — 採購員只看得到「等待簽核」", () => {
  it("草稿列在待簽核區,只有「等待簽核」標籤,沒有送出或退回按鈕", async () => {
    state.role = "purchaser";
    renderPage();

    const card = await pendingCard();
    expect(within(card).getByText(/等待簽核的採購單/)).toHaveTextContent("等待簽核的採購單（1）");
    const row = within(card).getByTestId("pending-draft");
    expect(row).toHaveTextContent("高麗菜、洋蔥");
    expect(within(row).getByText("等待簽核")).toBeInTheDocument();
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /核准並送出|退回/ })).toBeNull();
  });

  it("採購員向合作供應商叫貨:不用簽核,先建草稿再直接寫 draft → dispatched(待接單),帶著供應商", async () => {
    state.role = "purchaser";
    state.drafts = [];
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
    await user.click(screen.getByRole("button", { name: "加入" }));
    await user.click(screen.getByRole("button", { name: "送出訂單" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已送出給 阿明蔬果,等待供應商接單"));
    const insert = state.calls.find((c) => c.op === "insert");
    expect(insert?.values).toEqual(expect.objectContaining({ status: "draft", restaurant_id: "restaurant-1", created_by: "user-purchaser" }));
    expect(recordOrderEvent).toHaveBeenCalledTimes(1);
    expect(recordOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "new-order-1", fromStatus: "draft", toStatus: "dispatched", actorRole: "restaurant",
        payload: expect.objectContaining({ supplier_id: "sup-1" }),
      }),
    );
  });
});

describe("RestaurantPurchasePage — 老闆與店長在待簽核區送出", () => {
  it.each<Role>(["owner", "manager"])("%s:看得到「核准並送出」與「退回」,沒有「等待簽核」標籤", async (role) => {
    state.role = role;
    renderPage();

    const card = await pendingCard();
    expect(within(card).getByText(/待簽核採購單/)).toHaveTextContent("待簽核採購單（1）");
    expect(within(card).getByRole("button", { name: "核准並送出" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "退回" })).toBeEnabled();
    expect(within(card).queryByText("等待簽核")).toBeNull();
  });

  it.each<[Role, string]>([["owner", "老闆核准採購單"], ["manager", "店長核准採購單"]])(
    "%s 按「核准並送出」→ 記下核准人,再寫 draft → submitted 事件,這張從待簽核區消失",
    async (role, note) => {
      state.role = role;
      const user = userEvent.setup();
      renderPage();

      await user.click(within(await pendingCard()).getByRole("button", { name: "核准並送出" }));

      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      expect(recordOrderEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: "draft-0001",
          fromStatus: "draft",
          toStatus: "submitted",
          actorRole: "restaurant",
          source: "restaurant_portal",
          note,
        }),
      );
      const update = state.calls.find((c) => c.op === "update");
      expect(update?.values).toEqual(expect.objectContaining({ approved_by: `user-${role}` }));
      // 只在還是草稿時才記核准人
      expect(update?.filters).toEqual([["eq", "id", "draft-0001"], ["eq", "status", "draft"]]);
      await waitFor(() => expect(screen.queryByTestId("pending-approval")).toBeNull());
    },
  );

  it("老闆按「退回」要先確認,確認後寫 draft → cancelled 事件", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(within(await pendingCard()).getByRole("button", { name: "退回" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(recordOrderEvent).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "確定退回" }));

    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "draft-0001", fromStatus: "draft", toStatus: "cancelled", actorRole: "restaurant" }),
    );
    await waitFor(() => expect(screen.queryByTestId("pending-approval")).toBeNull());
  });

  it.each(["核准並送出", "退回"])("停在舊畫面:這張已被別人處理,按「%s」只提示並重新整理,不寫任何事件", async (action) => {
    const user = userEvent.setup();
    renderPage();
    const card = await pendingCard();
    state.handledElsewhere = ["draft-0001"];

    await user.click(within(card).getByRole("button", { name: action }));
    if (action === "退回") {
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "確定退回" }));
    }

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("這張採購單已經被處理", { description: "可能已由其他人核准或退回,清單已重新整理" }),
    );
    expect(recordOrderEvent).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("pending-approval")).toBeNull());
  });

  it("資料庫擋下送出時(例如角色剛被改成採購員)顯示錯誤,草稿留在待簽核區", async () => {
    recordOrderEvent.mockRejectedValueOnce(new Error("採購單要由這家餐廳的老闆或店長簽核後才能送出"));
    const user = userEvent.setup();
    renderPage();

    await user.click(within(await pendingCard()).getByRole("button", { name: "核准並送出" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("核准失敗", { description: "採購單要由這家餐廳的老闆或店長簽核後才能送出" }),
    );
    expect(screen.getByTestId("pending-draft")).toBeInTheDocument();
  });

  it("老闆叫貨:先建草稿再寫 draft → dispatched(直接進供應商待接單,不經管理員派發)", async () => {
    state.drafts = [];
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
    await user.click(screen.getByRole("button", { name: "加入" }));
    await user.click(screen.getByRole("button", { name: "送出訂單" }));

    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(state.calls.find((c) => c.op === "insert")?.values).toEqual(expect.objectContaining({ status: "draft" }));
    expect(recordOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "new-order-1", fromStatus: "draft", toStatus: "dispatched", actorRole: "restaurant",
        payload: expect.objectContaining({ supplier_id: "sup-1" }),
      }),
    );
  });
});
