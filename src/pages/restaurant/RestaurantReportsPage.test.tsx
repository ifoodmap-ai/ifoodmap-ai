// 餐廳「報表」頁:依日期區間查採購單、看明細與彙總、下載 CSV。
// supabase 換成記憶體假資料(記錄每次查詢的條件),並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantReportsPage from "./RestaurantReportsPage";

type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; filters: Filter[]; from: number }

const { state, toast } = vi.hoisted(() => ({
  state: {
    calls: [] as { table: string; filters: [string, string, unknown][]; from: number }[],
    orders: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    eventsError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, filters: [], from: 0 };
  const result = () => {
    state.calls.push(call);
    if (call.from > 0) return { data: [], error: null };
    if (table === "supplier_orders") return { data: state.orders, error: null };
    if (table === "order_events") {
      return state.eventsError
        ? { data: null, error: { message: state.eventsError } }
        : { data: state.events, error: null };
    }
    if (table === "suppliers") return { data: [{ id: "s1", name: "阿明蔬果" }, { id: "s2", name: "大海水產" }], error: null };
    return { data: [], error: null };
  };
  const filter = (op: string) => (col: string, val: unknown) => { call.filters.push([op, col, val]); return builder; };
  const builder = {
    select: () => builder,
    eq: filter("eq"),
    gte: filter("gte"),
    lt: filter("lt"),
    in: filter("in"),
    order: () => builder,
    range: (from: number) => { call.from = from; return builder; },
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled, onRejected),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => fakeFrom(t) } }));
vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({ id: "account-1", restaurant_id: "restaurant-1", branch_id: null, role: "owner", restaurant_name: "好味小館" }),
}));
vi.mock("sonner", () => ({ toast }));

const ORDERS = [
  { id: "a0000001", status: "received", total_amount: 1000, created_at: "2026-10-03T02:00:00Z", supplier_id: "s1",
    ingredient_list: [{ name: "高麗菜", quantity: "5", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }] },
  { id: "b0000002", status: "shipped", total_amount: 500, created_at: "2026-10-05T02:00:00Z", supplier_id: "s1",
    ingredient_list: [{ name: "高麗菜", quantity: "3", unit: "kg" }] },
  { id: "c0000003", status: "cancelled", total_amount: 999, created_at: "2026-10-06T02:00:00Z", supplier_id: "s2",
    ingredient_list: [{ name: "吳郭魚", quantity: "9", unit: "kg" }] },
];

let fetchGuard: ReturnType<typeof vi.fn>;
let blobs: Blob[];

beforeEach(() => {
  state.calls = [];
  state.orders = ORDERS.map((o) => ({ ...o }));
  state.events = [];
  state.eventsError = null;
  toast.error.mockReset();
  blobs = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: (b: Blob) => { blobs.push(b); return "blob:test"; },
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const ordersQuery = () => state.calls.filter((c) => c.table === "supplier_orders").at(-1)!;
const bound = (call: Call, op: string) => call.filters.find(([o]) => o === op)?.[2];

describe("RestaurantReportsPage", () => {
  it("摘要:訂單數、採購金額、已收貨金額、進行中金額(不含取消的單)", async () => {
    render(<RestaurantReportsPage />);

    const summary = await screen.findByTestId("report-summary");
    expect(within(summary).getByText("訂單數").nextElementSibling).toHaveTextContent("2");
    expect(within(summary).getByText("採購金額").nextElementSibling).toHaveTextContent("NT$ 1,500");
    expect(within(summary).getByText("已收貨金額").nextElementSibling).toHaveTextContent("NT$ 1,000");
    expect(within(summary).getByText("進行中金額").nextElementSibling).toHaveTextContent("NT$ 500");
    expect(screen.getAllByTestId("report-order-row")).toHaveLength(2);
  });

  it("依日期區間查:起日 00:00 到迄日隔天 00:00(本地時區),只查這家店", async () => {
    const user = userEvent.setup();
    render(<RestaurantReportsPage />);
    await screen.findByTestId("report-summary");

    fireEvent.change(screen.getByLabelText("起日"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("迄日"), { target: { value: "2026-09-30" } });
    await user.click(screen.getByRole("button", { name: "查詢" }));

    await waitFor(() => expect(bound(ordersQuery(), "gte")).toBe("2026-08-31T16:00:00.000Z"));
    expect(bound(ordersQuery(), "lt")).toBe("2026-09-30T16:00:00.000Z");
    expect(ordersQuery().filters).toContainEqual(["eq", "restaurant_id", "restaurant-1"]);
  });

  it("起日晚於迄日時不能查詢", async () => {
    render(<RestaurantReportsPage />);
    await screen.findByTestId("report-summary");

    fireEvent.change(screen.getByLabelText("起日"), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText("迄日"), { target: { value: "2026-10-01" } });
    expect(screen.getByRole("button", { name: "查詢" })).toBeDisabled();
  });

  it("快速選擇「上月」會直接重新查詢並更新日期欄", async () => {
    const user = userEvent.setup();
    render(<RestaurantReportsPage />);
    await screen.findByTestId("report-summary");
    const before = state.calls.filter((c) => c.table === "supplier_orders").length;

    await user.click(screen.getByRole("button", { name: "上月" }));
    await waitFor(() => expect(state.calls.filter((c) => c.table === "supplier_orders").length).toBeGreaterThan(before));
    expect((screen.getByLabelText("起日") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("供應商彙總與品項彙總分頁", async () => {
    const user = userEvent.setup();
    render(<RestaurantReportsPage />);
    await screen.findByTestId("report-summary");

    await user.click(screen.getByRole("tab", { name: "供應商彙總" }));
    const supplierRows = await screen.findAllByTestId("report-supplier-row");
    expect(supplierRows).toHaveLength(1);
    expect(supplierRows[0]).toHaveTextContent("阿明蔬果");
    expect(supplierRows[0]).toHaveTextContent("NT$ 1,500");

    await user.click(screen.getByRole("tab", { name: "品項彙總" }));
    const itemRows = await screen.findAllByTestId("report-item-row");
    expect(itemRows.map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("高麗菜")]));
    expect(screen.queryByText("吳郭魚")).toBeNull();
  });

  it("下載 CSV:檔案內容是目前區間的訂單明細(含 BOM)", async () => {
    const user = userEvent.setup();
    render(<RestaurantReportsPage />);
    await screen.findByTestId("report-summary");

    await user.click(screen.getByRole("button", { name: "下載 CSV" }));

    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blobs[0], "utf-8");
    });
    const lines = text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("日期,訂單編號,供應商,狀態,品項數,品項,金額,已收貨");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("#B0000002");
    expect(lines[2]).toContain("#A0000001");
    expect(lines.join("\n")).not.toContain("C0000003");
  });

  it("這段期間沒有採購單:顯示空狀態,下載鈕不能按", async () => {
    state.orders = [];
    render(<RestaurantReportsPage />);

    expect(await screen.findByText("這段期間沒有採購單")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下載 CSV" })).toBeDisabled();
  });

  it("讀不到訂單履歷時提示「已收貨」可能偏低,其餘照常顯示", async () => {
    state.eventsError = "權限不足";
    render(<RestaurantReportsPage />);

    expect(await screen.findByRole("status")).toHaveTextContent("權限不足");
    expect(screen.getAllByTestId("report-order-row")).toHaveLength(2);
  });
});
