// 供應商「新增請款」:選客戶與帳期,列出這段期間已收貨、還沒請款的訂單,勾選後開立請款單。
// supabase 換成記憶體假資料(記錄每次查詢條件與 RPC 呼叫),並擋掉所有網路請求。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierInvoiceCreatePage from "./SupplierInvoiceCreatePage";

const { state, toast } = vi.hoisted(() => ({
  state: {
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    rpcError: null as string | null,
    orders: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    invoiced: [] as Record<string, unknown>[],
    eventsError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  let from = 0;
  let restaurantFilter: unknown = undefined;
  const result = () => {
    if (from > 0) return { data: [], error: null };
    if (table === "supplier_accounts") return { data: { supplier_id: "sup-1" }, error: null };
    if (table === "supplier_orders") {
      const list = restaurantFilter ? state.orders.filter((o) => o.restaurant_id === restaurantFilter) : state.orders;
      return { data: list, error: null };
    }
    if (table === "restaurants") return { data: [{ id: "rest-1", name: "好味小館" }, { id: "rest-2", name: "別家餐廳" }], error: null };
    if (table === "order_events") return state.eventsError ? { data: null, error: { message: state.eventsError } } : { data: state.events, error: null };
    if (table === "supplier_invoice_orders") return { data: state.invoiced, error: null };
    return { data: [], error: null };
  };
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { if (col === "restaurant_id") restaurantFilter = val; return builder; },
    in: () => builder,
    order: () => builder,
    range: (f: number) => { from = f; return builder; },
    maybeSingle: () => Promise.resolve(result()),
    then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise.resolve(result()).then(a, b),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: "new-invoice-id", error: null };
    },
  },
}));
vi.mock("sonner", () => ({ toast }));

const ORDERS = [
  { id: "aaaaaaa1", restaurant_id: "rest-1", status: "received", total_amount: 1000, created_at: "2026-10-02T02:00:00Z" },
  { id: "aaaaaaa2", restaurant_id: "rest-1", status: "reviewed", total_amount: 2500, created_at: "2026-10-03T02:00:00Z" },
  { id: "aaaaaaa3", restaurant_id: "rest-1", status: "shipped", total_amount: 300, created_at: "2026-10-04T02:00:00Z" },
  { id: "aaaaaaa4", restaurant_id: "rest-1", status: "received", total_amount: 700, created_at: "2026-10-20T02:00:00Z" },
  { id: "aaaaaaa5", restaurant_id: "rest-1", status: "received", total_amount: 400, created_at: "2026-10-05T02:00:00Z" },
  { id: "bbbbbbb1", restaurant_id: "rest-2", status: "received", total_amount: 999, created_at: "2026-10-05T02:00:00Z" },
];

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  state.rpcCalls = [];
  state.rpcError = null;
  state.orders = ORDERS.map((o) => ({ ...o }));
  state.events = [];
  state.invoiced = [{ order_id: "aaaaaaa5" }];
  state.eventsError = null;
  toast.success.mockReset();
  toast.error.mockReset();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/supplier/invoice-create"]}>
      <Routes>
        <Route path="/supplier/invoice-create" element={<SupplierInvoiceCreatePage />} />
        <Route path="/supplier/invoices" element={<h1>請款單列表頁</h1>} />
      </Routes>
    </MemoryRouter>,
  );

const pickCustomer = async (user: ReturnType<typeof userEvent.setup>, name = "好味小館") => {
  await user.click(await screen.findByRole("combobox", { name: "客戶" }));
  await user.click(await screen.findByRole("option", { name }));
};

const useCustomRange = async (user: ReturnType<typeof userEvent.setup>, start: string, end: string) => {
  await user.click(screen.getByRole("radio", { name: "自訂區間" }));
  fireEvent.change(screen.getByLabelText("起日"), { target: { value: start } });
  fireEvent.change(screen.getByLabelText("迄日"), { target: { value: end } });
};

describe("SupplierInvoiceCreatePage", () => {
  it("客戶選單列出有往來的餐廳;沒選客戶前提示先選", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("先選擇客戶")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "客戶" }));
    expect(await screen.findByRole("option", { name: "好味小館" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "別家餐廳" })).toBeInTheDocument();
  });

  it("只列這段期間已收貨、有金額、還沒請款的訂單;不含在途的、已請款的、別家客戶的", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2026-10-01", "2026-10-15");

    const rows = await screen.findAllByTestId("eligible-order");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("#AAAAAAA1"),
      expect.stringContaining("#AAAAAAA2"),
    ]);
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("已選 2 張訂單");
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("NT$ 3,500");
  });

  it("換區間會換一批訂單(依收貨日判斷)", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2026-10-16", "2026-10-31");

    const rows = await screen.findAllByTestId("eligible-order");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("#AAAAAAA4");
  });

  it("可以取消勾選某張訂單,金額跟著變;全部取消後不能開單", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2026-10-01", "2026-10-15");
    await screen.findAllByTestId("eligible-order");

    await user.click(screen.getByRole("checkbox", { name: "請款 #AAAAAAA2" }));
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("已選 1 張訂單");
    expect(screen.getByTestId("invoice-total")).toHaveTextContent("NT$ 1,000");

    await user.click(screen.getByRole("checkbox", { name: "請款 #AAAAAAA1" }));
    expect(screen.getByRole("button", { name: "開立請款單" })).toBeDisabled();
  });

  it("開立請款單:把選的訂單、帳期與區間、付款天數送給資料庫,成功後回到請款單列表", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2026-10-01", "2026-10-15");
    await screen.findAllByTestId("eligible-order");

    const net = screen.getByLabelText(/付款天數/);
    await user.clear(net);
    await user.type(net, "45");
    await user.type(screen.getByLabelText("備註"), " 十月上半月 ");
    await user.click(screen.getByRole("button", { name: "開立請款單" }));

    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0]).toEqual({
      fn: "supplier_create_invoice",
      args: {
        p_supplier_id: "sup-1",
        p_restaurant_id: "rest-1",
        p_period_kind: "custom",
        p_period_start: "2026-10-01",
        p_period_end: "2026-10-15",
        p_net_days: 45,
        p_order_ids: ["aaaaaaa1", "aaaaaaa2"],
        p_note: "十月上半月",
      },
    });
    expect(await screen.findByRole("heading", { name: "請款單列表頁" })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it("日結:切到日結後付款天數預設 0,區間是同一天", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await user.click(screen.getByRole("radio", { name: "日結" }));
    expect(screen.getByLabelText(/付款天數/)).toHaveValue("0");
    fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-10-02" } });

    const rows = await screen.findAllByTestId("eligible-order");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("#AAAAAAA1");
    await user.click(screen.getByRole("button", { name: "開立請款單" }));
    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0].args).toMatchObject({ p_period_kind: "daily", p_period_start: "2026-10-02", p_period_end: "2026-10-02", p_net_days: 0 });
  });

  it("月結:選月份,區間是整個月,付款天數預設 30", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    expect(screen.getByRole("radio", { name: "月結" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText(/付款天數/)).toHaveValue("30");
    fireEvent.change(screen.getByLabelText("月份"), { target: { value: "2026-10" } });

    await screen.findAllByTestId("eligible-order");
    await user.click(screen.getByRole("button", { name: "開立請款單" }));
    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0].args).toMatchObject({
      p_period_kind: "monthly", p_period_start: "2026-10-01", p_period_end: "2026-10-31", p_net_days: 30,
      p_order_ids: ["aaaaaaa1", "aaaaaaa2", "aaaaaaa4"],
    });
  });

  it("資料庫拒絕時顯示中文原因,留在這一頁", async () => {
    const user = userEvent.setup();
    state.rpcError = "invoice_orders_already_invoiced";
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2026-10-01", "2026-10-15");
    await screen.findAllByTestId("eligible-order");

    await user.click(screen.getByRole("button", { name: "開立請款單" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("開立失敗", { description: expect.stringContaining("別張請款單") }));
    expect(screen.queryByRole("heading", { name: "請款單列表頁" })).toBeNull();
  });

  it("這段期間沒有可請款的訂單時顯示說明,不能開單", async () => {
    const user = userEvent.setup();
    renderPage();
    await pickCustomer(user);
    await useCustomRange(user, "2025-01-01", "2025-01-31");

    expect(await screen.findByText(/沒有可請款的訂單/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開立請款單" })).toBeDisabled();
  });

  it("讀不到訂單履歷時提示已結案的訂單暫時不會列出", async () => {
    const user = userEvent.setup();
    state.eventsError = "權限不足";
    renderPage();
    await pickCustomer(user);
    expect(await screen.findByRole("status")).toHaveTextContent("權限不足");
  });
});
