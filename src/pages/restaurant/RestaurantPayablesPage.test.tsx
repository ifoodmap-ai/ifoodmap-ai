// 餐廳「應付帳款」:看供應商開來的請款單,確認無誤或提出異議。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantPayablesPage from "./RestaurantPayablesPage";

const { state, toast } = vi.hoisted(() => ({
  state: {
    invoices: [] as Record<string, unknown>[],
    filters: [] as [string, unknown][],
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    rpcError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  let from = 0;
  const result = () => {
    if (from > 0) return { data: [], error: null };
    if (table === "supplier_invoices") return { data: state.invoices, error: null };
    if (table === "suppliers") return { data: [{ id: "sup-1", name: "阿明蔬果" }], error: null };
    return { data: [], error: null };
  };
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => { state.filters.push([c, v]); return b; },
    in: () => b, order: () => b,
    range: (f: number) => { from = f; return b; },
    then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(a, r),
  };
  return b;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: null, error: null };
    },
  },
}));
vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({ id: "a1", restaurant_id: "rest-1", branch_id: null, role: "owner", restaurant_name: "好味小館" }),
}));
vi.mock("sonner", () => ({ toast }));

const base = {
  supplier_id: "sup-1", restaurant_id: "rest-1", period_kind: "monthly", period_start: "2026-09-01", period_end: "2026-09-30",
  net_days: 30, note: null, issued_at: "2026-10-01T02:00:00Z", confirmed_at: null, disputed_at: null, dispute_note: null,
  paid_at: null, paid_note: null, voided_at: null, void_reason: null,
  lines: [{ order_id: "o1", order_no: "#AAAAAAA1", ordered_at: "2026-09-10T02:00:00Z", amount: 1000 }],
};
const inv = (over: Record<string, unknown>) => ({ ...base, ...over });

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  state.rpcCalls = [];
  state.rpcError = null;
  state.filters = [];
  state.invoices = [
    inv({ id: "i1", invoice_no: "INV-1", status: "issued", total_amount: 1000, due_date: "2020-01-01" }),
    inv({ id: "i2", invoice_no: "INV-2", status: "confirmed", total_amount: 2000, due_date: "2099-01-01" }),
    inv({ id: "i3", invoice_no: "INV-3", status: "disputed", total_amount: 300, due_date: "2099-01-01", disputed_at: "2026-10-03T02:00:00Z", dispute_note: "少一箱" }),
    inv({ id: "i4", invoice_no: "INV-4", status: "paid", total_amount: 700, due_date: "2020-01-01" }),
  ];
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

const rowOf = async (no: string) => (await screen.findAllByTestId("payable-row")).find((r) => r.textContent?.includes(no))!;
const open = async (user: ReturnType<typeof userEvent.setup>, no: string) =>
  user.click(within(await rowOf(no)).getByRole("button", { name: "查看" }));

describe("RestaurantPayablesPage", () => {
  it("只查這家餐廳的請款單;摘要:應付金額、已逾期、待我確認", async () => {
    render(<RestaurantPayablesPage />);
    const s = await screen.findByTestId("payable-summary");
    expect(state.filters).toContainEqual(["restaurant_id", "rest-1"]);
    expect(within(s).getByText("應付金額").nextElementSibling).toHaveTextContent("NT$ 3,300");
    expect(within(s).getByText("已逾期").nextElementSibling).toHaveTextContent("NT$ 1,000");
    expect(within(s).getByText("待我確認").nextElementSibling).toHaveTextContent("1 張");
    expect(await rowOf("INV-1")).toHaveTextContent("阿明蔬果");
  });

  it("確認無誤:送出 confirm,成功後重新載入", async () => {
    const user = userEvent.setup();
    render(<RestaurantPayablesPage />);
    await open(user, "INV-1");
    await user.click(await screen.findByRole("button", { name: "確認無誤" }));
    // 對話框裡的「確認無誤」是最後一顆(明細對話框底下還有一顆)
    await user.click(screen.getAllByRole("button", { name: "確認無誤" }).at(-1)!);

    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0]).toEqual({ fn: "restaurant_respond_invoice", args: { p_invoice_id: "i1", p_action: "confirm", p_note: null } });
    expect(toast.success).toHaveBeenCalledWith("已確認這張請款單");
  });

  it("提出異議要寫原因,沒寫不能送出", async () => {
    const user = userEvent.setup();
    render(<RestaurantPayablesPage />);
    await open(user, "INV-2");
    await user.click(await screen.findByRole("button", { name: "有異議" }));

    const send = await screen.findByRole("button", { name: "送出異議" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("異議原因"), " 金額不對 ");
    await user.click(send);
    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0]).toEqual({ fn: "restaurant_respond_invoice", args: { p_invoice_id: "i2", p_action: "dispute", p_note: "金額不對" } });
  });

  it("有異議的請款單看得到自己寫的原因,而且可以改成確認(不能重複提異議)", async () => {
    const user = userEvent.setup();
    render(<RestaurantPayablesPage />);
    await open(user, "INV-3");
    expect(await screen.findByTestId("invoice-history")).toHaveTextContent("餐廳提出異議:少一箱");
    expect(screen.getByRole("button", { name: "確認無誤" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "有異議" })).toBeNull();
  });

  it("已收款的請款單只能看,沒有確認 / 異議按鈕", async () => {
    const user = userEvent.setup();
    render(<RestaurantPayablesPage />);
    await open(user, "INV-4");
    expect(await screen.findByRole("button", { name: "下載明細" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確認無誤" })).toBeNull();
    expect(screen.queryByRole("button", { name: "有異議" })).toBeNull();
  });

  it("資料庫拒絕時顯示中文原因", async () => {
    const user = userEvent.setup();
    state.rpcError = "invoice_not_confirmable";
    render(<RestaurantPayablesPage />);
    await open(user, "INV-1");
    await user.click(await screen.findByRole("button", { name: "確認無誤" }));
    await user.click(screen.getAllByRole("button", { name: "確認無誤" }).at(-1)!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("操作失敗", { description: expect.stringContaining("目前不能確認") }));
  });

  it("還沒有請款單時顯示說明", async () => {
    state.invoices = [];
    render(<RestaurantPayablesPage />);
    expect(await screen.findByText("還沒有供應商向你請款")).toBeInTheDocument();
  });
});
