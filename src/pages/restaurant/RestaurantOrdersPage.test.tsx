// 「叫貨與訂單 → 訂單」分頁(/restaurant/orders)的簽核規則(業主拍板 Q8-A):
//   - 草稿不列在這頁(查詢就排除),只在頂端提示「待簽核 N 張」並連到叫貨分頁
//   - 這頁沒有任何「送出訂單」鈕 —— 送出只在叫貨分頁的待簽核區、只給老闆/店長
//   - 其他既有動作(確認訂單、取消、收貨…)照舊
// supabase 換成記憶體假資料(每次查詢都記錄下來),並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantOrdersPage from "./RestaurantOrdersPage";

type Role = "owner" | "manager" | "purchaser";
type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; op: string; cols?: string; values?: unknown; filters: Filter[] }

const { state, recordOrderEvent, callOrderRpc, toastError } = vi.hoisted(() => ({
  state: {
    role: "owner" as Role,
    calls: [] as Call[],
    listRows: [] as Record<string, unknown>[],
    draftRows: [] as Record<string, unknown>[],
  },
  recordOrderEvent: vi.fn(),
  callOrderRpc: vi.fn(),
  toastError: vi.fn(),
}));

/** 只實作這頁用得到的 PostgREST builder;回傳什麼依篩選條件決定 */
const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const resolve = () => {
    state.calls.push(call);
    if (table === "suppliers") return { data: [{ id: "sup-1", name: "鮮綠農產" }], error: null };
    if (table === "supplier_orders") {
      const isDraftCount = call.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft");
      return { data: isDraftCount ? state.draftRows : state.listRows, error: null };
    }
    return { data: [], error: null };
  };
  const builder = {
    select: (cols: string) => { call.cols = cols; return builder; },
    insert: (values: unknown) => { call.op = "insert"; call.values = values; return builder; },
    eq: (col: string, val: unknown) => { call.filters.push(["eq", col, val]); return builder; },
    neq: (col: string, val: unknown) => { call.filters.push(["neq", col, val]); return builder; },
    order: () => builder,
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.com" } } }) },
  },
}));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: null,
    role: state.role,
    restaurant_name: "好味小館",
  }),
  canSeeCost: (role: Role) => role === "owner" || role === "manager",
  needsApproval: (role: Role) => role === "purchaser",
}));

vi.mock("@/lib/orders", async () => {
  const actual = await vi.importActual<typeof import("@/lib/orders")>("@/lib/orders");
  return { ...actual, recordOrderEvent, callOrderRpc, fetchOrderTimeline: vi.fn(async () => []) };
});

vi.mock("@/components/restaurant/ReceiveOrderDialog", () => ({ default: () => null }));
vi.mock("@/components/restaurant/OrderReviewDialog", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }));

const order = (id: string, status: string) => ({
  id,
  status,
  supplier_id: "sup-1",
  ingredient_list: [{ name: "高麗菜", quantity: 3, unit: "kg" }],
  total_amount: 1200,
  notes: null,
  created_at: "2026-09-27T02:00:00Z",
  current_stage_since: "2026-09-27T02:00:00Z",
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/orders"]}>
      <RestaurantOrdersPage />
    </MemoryRouter>,
  );

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.role = "owner";
  state.calls = [];
  state.listRows = [order("aaaaaaaa-0000-4000-8000-00000000q001", "quoted"), order("aaaaaaaa-0000-4000-8000-00000000d001", "delivered")];
  state.draftRows = [{ id: "draft-1" }, { id: "draft-2" }];
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
  callOrderRpc.mockReset();
  callOrderRpc.mockResolvedValue({});
  toastError.mockReset();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const waitLoaded = () => screen.findByText("#0000Q001");

describe("RestaurantOrdersPage — 草稿不在訂單分頁", () => {
  it("訂單列表的查詢排除草稿(neq status draft),另外只查草稿張數", async () => {
    renderPage();
    await waitLoaded();

    const orderQueries = state.calls.filter((c) => c.table === "supplier_orders");
    const list = orderQueries.find((c) => c.filters.some(([op]) => op === "neq"));
    expect(list?.filters).toEqual(
      expect.arrayContaining([["eq", "restaurant_id", "restaurant-1"], ["neq", "status", "draft"]]),
    );
    const count = orderQueries.find((c) => c.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft"));
    expect(count?.cols).toBe("id");
  });

  it("就算查詢回來混了一張草稿,也不會畫在列表上", async () => {
    state.listRows = [...state.listRows, order("aaaaaaaa-0000-4000-8000-00000000f001", "draft")];
    renderPage();
    await waitLoaded();

    expect(screen.queryByText("#0000F001")).toBeNull();
    expect(screen.queryByText("草稿")).toBeNull();
  });

  it.each<[Role, RegExp, string]>([
    ["owner", /待簽核 2 張:採購單要在「叫貨」分頁簽核後才會送出/, "前往簽核"],
    ["manager", /待簽核 2 張:採購單要在「叫貨」分頁簽核後才會送出/, "前往簽核"],
    ["purchaser", /待簽核 2 張:採購單要由老闆或店長簽核後才會送出/, "查看待簽核"],
  ])("%s:頂端提示待簽核張數,連到叫貨分頁", async (role, text, linkName) => {
    state.role = role;
    renderPage();
    await waitLoaded();

    const notice = await screen.findByTestId("pending-approval-notice");
    expect(notice).toHaveTextContent(text);
    expect(within(notice).getByRole("link", { name: linkName })).toHaveAttribute("href", "/restaurant/purchase");
  });

  it("沒有草稿就不顯示提示", async () => {
    state.draftRows = [];
    renderPage();
    await waitLoaded();

    expect(screen.queryByTestId("pending-approval-notice")).toBeNull();
  });
});

describe("RestaurantOrdersPage — 沒有送出鈕,其他既有動作照舊", () => {
  it.each<Role>(["owner", "manager", "purchaser"])("%s:整頁沒有「送出訂單」(連混進來的草稿也沒有)", async (role) => {
    state.role = role;
    state.listRows = [...state.listRows, order("aaaaaaaa-0000-4000-8000-00000000f001", "draft")];
    renderPage();
    await waitLoaded();

    expect(screen.queryByRole("button", { name: /送出訂單/ })).toBeNull();
  });

  it("待確認的單照樣有「確認訂單」「取消訂單」,待收貨的單有「已收到貨」「回報異常」", async () => {
    renderPage();
    await waitLoaded();

    expect(screen.getByRole("button", { name: "確認訂單" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消訂單" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已收到貨" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "回報異常" })).toBeInTheDocument();
  });

  it("已取消的單(含被退回的草稿)只寫「已取消」,不說轉客服;爭議中的單照舊說已交由客服跟進", async () => {
    state.listRows = [
      ...state.listRows,
      order("aaaaaaaa-0000-4000-8000-00000000c001", "cancelled"),
      order("aaaaaaaa-0000-4000-8000-00000000e001", "disputed"),
    ];
    renderPage();
    await waitLoaded();

    const cancelledCard = (await screen.findByText("#0000C001")).closest("[class*='rounded']") as HTMLElement;
    expect(cancelledCard).toHaveTextContent("這張訂單已取消");
    expect(cancelledCard).not.toHaveTextContent("客服");
    const disputedCard = screen.getByText("#0000E001").closest("[class*='rounded']") as HTMLElement;
    expect(disputedCard).toHaveTextContent("這張訂單目前為「爭議中」,已交由客服跟進");
  });

  it("按「確認訂單」一樣只走 recordOrderEvent(quoted → confirmed)", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitLoaded();

    await user.click(screen.getByRole("button", { name: "確認訂單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "aaaaaaaa-0000-4000-8000-00000000q001",
        fromStatus: "quoted",
        toStatus: "confirmed",
        actorRole: "restaurant",
        source: "restaurant_portal",
      }),
    );
  });
});

describe("RestaurantOrdersPage — 退回重新報價(報價後品項鎖住,業主拍板 N2)", () => {
  it.each<Role>(["owner", "manager"])("%s:待確認的單有「退回重新報價」,並提示品項已鎖定", async (role) => {
    state.role = role;
    renderPage();
    await waitLoaded();

    const card = screen.getByText("#0000Q001").closest("[class*='rounded']") as HTMLElement;
    expect(within(card).getByRole("button", { name: "退回重新報價" })).toBeInTheDocument();
    expect(card).toHaveTextContent("供應商已報價,品項與數量已鎖定,要改請按「退回重新報價」");
  });

  it("採購員沒有「退回重新報價」(只有老闆/店長能退),提示請老闆或店長處理", async () => {
    state.role = "purchaser";
    renderPage();
    await waitLoaded();

    expect(screen.queryByRole("button", { name: "退回重新報價" })).toBeNull();
    const card = screen.getByText("#0000Q001").closest("[class*='rounded']") as HTMLElement;
    expect(card).toHaveTextContent("要改請老闆或店長退回重新報價");
    // 採購員照舊可以確認報價
    expect(within(card).getByRole("button", { name: "確認訂單" })).toBeInTheDocument();
  });

  it("要填原因才送得出去;送出只寫一筆事件 quoted → accepted,原因寫進 note", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitLoaded();

    await user.click(screen.getByRole("button", { name: "退回重新報價" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "確定退回" });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText("退回原因"), "高麗菜改成 20 顆");
    await user.click(confirm);
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent).toHaveBeenCalledWith({
      orderId: "aaaaaaaa-0000-4000-8000-00000000q001",
      fromStatus: "quoted",
      toStatus: "accepted",
      actorRole: "restaurant",
      source: "restaurant_portal",
      note: "高麗菜改成 20 顆",
      payload: { reason: "高麗菜改成 20 顆" },
    });
  });
});

describe("RestaurantOrdersPage — 申請爭議一次交易完成(F7)", () => {
  it("送出只呼叫 restaurant_open_dispute RPC,不再從前端直接寫 disputes", async () => {
    const user = userEvent.setup();
    state.listRows = [order("aaaaaaaa-0000-4000-8000-00000000d201", "discrepancy")];
    renderPage();
    await screen.findByText("#0000D201");

    await user.click(screen.getByRole("button", { name: "申請爭議處理" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/請描述事發經過/), "少了兩箱");
    await user.click(within(dialog).getByRole("button", { name: "送出申請" }));

    await waitFor(() => expect(callOrderRpc).toHaveBeenCalledTimes(1));
    expect(callOrderRpc).toHaveBeenCalledWith("restaurant_open_dispute", {
      p_order_id: "aaaaaaaa-0000-4000-8000-00000000d201",
      p_from_status: "discrepancy",
      p_kind: "shortage",
      p_detail: "少了兩箱",
    });
    expect(recordOrderEvent).not.toHaveBeenCalled();
    expect(state.calls.filter((c) => c.table === "disputes")).toEqual([]);
  });

  it("後到的人(畫面過期):照實顯示錯誤、關掉對話框並重抓列表", async () => {
    const user = userEvent.setup();
    const { OrderEventError } = await vi.importActual<typeof import("@/lib/orders")>("@/lib/orders");
    callOrderRpc.mockRejectedValueOnce(
      new OrderEventError("這張訂單的狀態已經變成「爭議中」,畫面上的資料過期了,請重新整理後再操作", "P0001", "stale_order_status"),
    );
    state.listRows = [order("aaaaaaaa-0000-4000-8000-00000000d202", "discrepancy")];
    renderPage();
    await screen.findByText("#0000D202");
    const before = state.calls.filter((c) => c.table === "supplier_orders").length;

    await user.click(screen.getByRole("button", { name: "申請爭議處理" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/請描述事發經過/), "我也要申請");
    await user.click(within(dialog).getByRole("button", { name: "送出申請" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][1].description).toContain("畫面上的資料過期了");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(state.calls.filter((c) => c.table === "supplier_orders").length).toBeGreaterThan(before));
  });
});


describe("RestaurantOrdersPage — 採購系統的訂單沒有「待派發」", () => {
  const unassigned = (id: string, status: string) => ({ ...order(id, status), supplier_id: null });

  it("還在媒合的需求(沒有供應商、待派發)不列在這頁,只提示張數;有供應商的單照列", async () => {
    state.listRows = [
      order("aaaaaaaa-0000-4000-8000-00000000q001", "quoted"),
      unassigned("aaaaaaaa-0000-4000-8000-00000000m001", "submitted"),
      unassigned("aaaaaaaa-0000-4000-8000-00000000m002", "submitted"),
    ];
    renderPage();

    expect(await screen.findByText("#0000Q001")).toBeInTheDocument();
    expect(screen.queryByText("#0000M001")).toBeNull();
    expect(screen.queryByText("#0000M002")).toBeNull();
    expect(screen.queryByText("尚未指派供應商")).toBeNull();
    expect(screen.getByTestId("matching-notice")).toHaveTextContent("另有 2 筆還在媒合的需求");
    // 分頁的張數也只算採購系統的訂單
    expect(screen.getByRole("button", { name: /全部\s*1/ })).toBeInTheDocument();
  });

  it("舊資料的「待處理」(pending)與「待派發」就算有供應商也不列", async () => {
    state.listRows = [
      order("aaaaaaaa-0000-4000-8000-00000000q001", "quoted"),
      order("aaaaaaaa-0000-4000-8000-00000000p001", "pending"),
      order("aaaaaaaa-0000-4000-8000-00000000s001", "submitted"),
    ];
    renderPage();

    expect(await screen.findByText("#0000Q001")).toBeInTheDocument();
    expect(screen.queryByText("#0000P001")).toBeNull();
    expect(screen.queryByText("#0000S001")).toBeNull();
  });

  it("沒有還在媒合的需求時不顯示提示", async () => {
    renderPage();
    await screen.findByText("#0000Q001");
    expect(screen.queryByTestId("matching-notice")).toBeNull();
  });

  it("進度條從「待接單」開始,沒有「待派發」這一格", async () => {
    state.listRows = [order("aaaaaaaa-0000-4000-8000-00000000a001", "dispatched")];
    renderPage();

    await screen.findByText("#0000A001");
    expect(screen.queryByText("待派發")).toBeNull();
    // 「待接單」同時是狀態標籤與進度條第一格
    expect(screen.getAllByText("待接單").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("已評價")).toBeInTheDocument();
  });
});

describe("RestaurantOrdersPage — 配送日", () => {
  it("訂單卡片顯示配送日(含星期);沒有配送日的單不顯示", async () => {
    state.listRows = [
      { ...order("aaaaaaaa-0000-4000-8000-00000000g001", "quoted"), delivery_date: "2026-10-30" },
      order("aaaaaaaa-0000-4000-8000-00000000g002", "quoted"),
    ];
    renderPage();
    expect(await screen.findByTestId("delivery-aaaaaaaa-0000-4000-8000-00000000g001")).toHaveTextContent("配送日 2026-10-30(週五)");
    expect(screen.queryByTestId("delivery-aaaaaaaa-0000-4000-8000-00000000g002")).toBeNull();
  });
});
