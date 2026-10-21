// 「叫貨」分頁:過往叫過的品項進頁就全部列出(不用一個個手動加入),
// 數量可用 ± 或直接輸入調整,不要的可以刪,每一列都能填參考價。
// supabase 換成記憶體假資料,記錄每次寫入,並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantPurchasePage from "./RestaurantPurchasePage";

type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; op: string; values?: unknown; filters: Filter[] }

const { state, recordOrderEvent, toast } = vi.hoisted(() => ({
  state: {
    calls: [] as Call[],
    history: [] as Record<string, unknown>[],
  },
  recordOrderEvent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const result = () => {
    state.calls.push(call);
    if (table !== "supplier_orders") return { data: [], error: null };
    if (call.op === "insert") return { data: { id: "new-order-1" }, error: null };
    const onlyDrafts = call.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft");
    return { data: onlyDrafts ? [] : state.history, error: null };
  };
  const builder = {
    select: () => builder,
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
    auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  },
}));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: "branch-1",
    role: "owner",
    restaurant_name: "好味小館",
  }),
  canSeeCost: () => true,
  needsApproval: () => false,
}));

vi.mock("./RestaurantAnalyzePage", () => ({ ANALYSIS_HANDOFF_KEY: "ifm_analysis_handoff" }));
vi.mock("@/lib/orders", () => ({ recordOrderEvent }));
vi.mock("sonner", () => ({ toast }));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const order = (id: string, createdAt: string, ingredient_list: unknown[], status = "completed") => ({
  id, created_at: createdAt, status, ingredient_list, created_by: "user-owner", approved_by: null, notes: null,
});

// 高麗菜叫過兩次(週期 7 天、上次 10 天前 → 該補貨);雞蛋只叫過一次
const HISTORY = [
  order("o-3", daysAgo(10), [
    { name: "高麗菜", quantity: "5", unit: "kg", reference_price: 35 },
    { name: "雞蛋", quantity: "2", unit: "箱" },
  ]),
  order("o-2", daysAgo(17), [{ name: "高麗菜", quantity: "4", unit: "kg" }]),
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/purchase"]}>
      <RestaurantPurchasePage />
    </MemoryRouter>,
  );

const rowOf = async (name: string) => {
  const rows = await screen.findAllByTestId("history-item");
  const row = rows.find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`找不到 ${name} 這一列`);
  return row;
};

const insertedList = () => {
  const insert = state.calls.find((c) => c.op === "insert");
  return (insert?.values as { ingredient_list: Record<string, unknown>[] }).ingredient_list;
};

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.calls = [];
  state.history = HISTORY.map((o) => ({ ...o }));
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
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

describe("RestaurantPurchasePage — 過往叫貨品項自動列出", () => {
  it("叫過的品項全部列出(包含只叫過一次的),不用手動加入;該補貨的排最前面並標示", async () => {
    renderPage();

    const rows = await screen.findAllByTestId("history-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("高麗菜");
    expect(within(rows[0]).getByText("該補貨了")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("雞蛋");
    expect(within(rows[1]).queryByText("該補貨了")).toBeNull();
    // 數量、單位、參考價帶入「最近一次」叫貨時的值
    expect(within(rows[0]).getByLabelText("高麗菜 數量")).toHaveValue("5");
    expect(within(rows[0]).getByLabelText("高麗菜 參考價")).toHaveValue("35");
    expect(screen.getByText(/目前共/)).toHaveTextContent("目前共 2 項");
  });

  it("按 + / − 調整數量,最少停在 1", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("高麗菜");

    await user.click(within(row).getByRole("button", { name: "高麗菜 數量加 1" }));
    expect(within(row).getByLabelText("高麗菜 數量")).toHaveValue("6");

    for (let i = 0; i < 8; i++) await user.click(within(row).getByRole("button", { name: "高麗菜 數量減 1" }));
    expect(within(row).getByLabelText("高麗菜 數量")).toHaveValue("1");
  });

  it("也可以直接輸入數字,送出時用輸入的數量;只收數字", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    const qty = within(row).getByLabelText("雞蛋 數量");
    await user.clear(qty);
    await user.type(qty, "a1b2.5");
    expect(qty).toHaveValue("12.5");

    await user.click(screen.getByRole("button", { name: "送出採購需求" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());
    expect(insertedList().find((i) => i.name === "雞蛋")).toEqual(
      expect.objectContaining({ quantity: "12.5", unit: "箱" }),
    );
  });

  it("可以刪掉不要的品項,送出的單就不含它;刪掉的可以點一下加回", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "移除 雞蛋" }));
    expect(screen.getAllByTestId("history-item")).toHaveLength(1);
    expect(screen.getByText(/目前共/)).toHaveTextContent("目前共 1 項");

    await user.click(screen.getByRole("button", { name: "+ 雞蛋" }));
    expect(screen.getAllByTestId("history-item")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "移除 雞蛋" }));
    await user.click(screen.getByRole("button", { name: "送出採購需求" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());
    expect(insertedList().map((i) => i.name)).toEqual(["高麗菜"]);
  });

  it("每一列都能填參考價,送出時寫進品項;沒填的不帶這個欄位", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    await user.type(within(row).getByLabelText("雞蛋 參考價"), "620");
    await user.click(screen.getByRole("button", { name: "送出採購需求" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());

    const list = insertedList();
    expect(list.find((i) => i.name === "雞蛋")).toEqual(expect.objectContaining({ reference_price: 620 }));
    expect(list.find((i) => i.name === "高麗菜")).toEqual(expect.objectContaining({ reference_price: 35 }));

    // 沒填參考價的品項不該帶 reference_price
    expect(list.every((i) => i.reference_price === undefined || typeof i.reference_price === "number")).toBe(true);
  });

  it("手動加入的品項也能填參考價", async () => {
    const user = userEvent.setup();
    state.history = [];
    renderPage();

    await user.type(await screen.findByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
    await user.type(screen.getByLabelText("參考價"), "480");
    await user.click(screen.getByRole("button", { name: "加入" }));
    await user.click(screen.getByRole("button", { name: "送出採購需求" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());

    expect(insertedList()).toEqual([
      expect.objectContaining({ name: "牛肉", quantity: "1", reference_price: 480, source: "manual" }),
    ]);
  });

  it("數量空白或 0 時擋下,不建單", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    await user.clear(within(row).getByLabelText("雞蛋 數量"));
    await user.click(screen.getByRole("button", { name: "送出採購需求" }));

    expect(toast.error).toHaveBeenCalledWith("請確認每一項的數量", expect.anything());
    expect(state.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("還沒有叫貨紀錄時顯示說明,不是空白", async () => {
    state.history = [];
    renderPage();
    expect(await screen.findByText("還沒有叫過貨的品項")).toBeInTheDocument();
  });
});
