// 供應商「請款單」列表:看狀態與逾期、標記已收款、作廢、下載 CSV。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierInvoicesPage from "./SupplierInvoicesPage";

const { state, toast } = vi.hoisted(() => ({
  state: {
    invoices: [] as Record<string, unknown>[],
    rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
    rpcError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  let from = 0;
  const result = () => {
    if (from > 0) return { data: [], error: null };
    if (table === "supplier_accounts") return { data: { supplier_id: "sup-1" }, error: null };
    if (table === "supplier_invoices") return { data: state.invoices, error: null };
    if (table === "restaurants") return { data: [{ id: "rest-1", name: "好味小館" }], error: null };
    return { data: [], error: null };
  };
  const b = {
    select: () => b, eq: () => b, in: () => b, order: () => b,
    range: (f: number) => { from = f; return b; },
    maybeSingle: () => Promise.resolve(result()),
    then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(a, r),
  };
  return b;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcError ? { data: null, error: { message: state.rpcError } } : { data: null, error: null };
    },
  },
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
let blobs: Blob[];

beforeEach(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  state.rpcCalls = [];
  state.rpcError = null;
  // 到期日固定遠早於 / 遠晚於今天,測試不隨日期變
  state.invoices = [
    inv({ id: "i1", invoice_no: "INV-1", status: "issued", total_amount: 1000, due_date: "2020-01-01" }),
    inv({ id: "i2", invoice_no: "INV-2", status: "confirmed", total_amount: 2000, due_date: "2099-01-01" }),
    inv({ id: "i3", invoice_no: "INV-3", status: "paid", total_amount: 700, due_date: "2020-01-01", paid_at: "2026-10-05T02:00:00Z" }),
    inv({ id: "i4", invoice_no: "INV-4", status: "void", total_amount: 5000, due_date: "2020-01-01", voided_at: "2026-10-06T02:00:00Z", void_reason: "金額寫錯" }),
  ];
  toast.success.mockReset();
  toast.error.mockReset();
  blobs = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return "blob:t"; }, revokeObjectURL: vi.fn() }));
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

const renderPage = () => render(<MemoryRouter><SupplierInvoicesPage /></MemoryRouter>);
const rowOf = async (no: string) => (await screen.findAllByTestId("invoice-row")).find((r) => r.textContent?.includes(no))!;

describe("SupplierInvoicesPage", () => {
  it("摘要:未收款(待確認 + 已確認)、已逾期、已收款;作廢的不算", async () => {
    renderPage();
    const s = await screen.findByTestId("invoice-summary");
    expect(within(s).getByText("未收款").nextElementSibling).toHaveTextContent("NT$ 3,000");
    expect(within(s).getByText("已逾期").nextElementSibling).toHaveTextContent("NT$ 1,000");
    expect(within(s).getByText("已收款(累計)").nextElementSibling).toHaveTextContent("NT$ 700");
  });

  it("列表標示狀態與逾期:逾期的未收款單有「逾期」標籤,已收款的沒有", async () => {
    renderPage();
    expect(await rowOf("INV-1")).toHaveTextContent("逾期");
    expect(await rowOf("INV-2")).not.toHaveTextContent("逾期");
    expect(await rowOf("INV-3")).not.toHaveTextContent("逾期");
    expect(await rowOf("INV-3")).toHaveTextContent("已收款");
    expect(await rowOf("INV-4")).toHaveTextContent("已作廢");
    expect(await rowOf("INV-1")).toHaveTextContent("好味小館");
  });

  it("狀態篩選:已逾期只剩逾期的那張", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("invoice-row");
    await user.click(screen.getByRole("combobox", { name: "狀態篩選" }));
    await user.click(await screen.findByRole("option", { name: "已逾期" }));
    expect(screen.getAllByTestId("invoice-row")).toHaveLength(1);
    expect(screen.getByTestId("invoice-row")).toHaveTextContent("INV-1");
  });

  it("標記已收款:對話框帶備註送給資料庫,成功後重新載入", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await rowOf("INV-2")).getByRole("button", { name: "查看" }));
    await user.click(await screen.findByRole("button", { name: "標記已收款" }));
    await user.type(await screen.findByLabelText("收款備註"), " 轉帳 12345 ");
    await user.click(screen.getByRole("button", { name: "確定已收款" }));

    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0]).toEqual({ fn: "supplier_mark_invoice_paid", args: { p_invoice_id: "i2", p_note: "轉帳 12345" } });
    expect(toast.success).toHaveBeenCalledWith("已標記收款");
  });

  it("作廢要先寫原因,沒寫不能按", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await rowOf("INV-1")).getByRole("button", { name: "查看" }));
    await user.click(await screen.findByRole("button", { name: "作廢" }));

    const confirm = await screen.findByRole("button", { name: "確定作廢" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("作廢原因"), "金額寫錯");
    await user.click(confirm);
    await waitFor(() => expect(state.rpcCalls).toHaveLength(1));
    expect(state.rpcCalls[0]).toEqual({ fn: "supplier_void_invoice", args: { p_invoice_id: "i1", p_reason: "金額寫錯" } });
  });

  it("已收款與已作廢的請款單沒有收款 / 作廢按鈕", async () => {
    const user = userEvent.setup();
    renderPage();
    for (const no of ["INV-3", "INV-4"]) {
      await user.click(within(await rowOf(no)).getByRole("button", { name: "查看" }));
      expect(await screen.findByRole("button", { name: "下載明細" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "標記已收款" })).toBeNull();
      expect(screen.queryByRole("button", { name: "作廢" })).toBeNull();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("button", { name: "下載明細" })).toBeNull());
    }
  });

  it("資料庫拒絕時顯示中文原因", async () => {
    const user = userEvent.setup();
    state.rpcError = "invoice_not_payable";
    renderPage();
    await user.click(within(await rowOf("INV-1")).getByRole("button", { name: "查看" }));
    await user.click(await screen.findByRole("button", { name: "標記已收款" }));
    await user.click(await screen.findByRole("button", { name: "確定已收款" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("操作失敗", { description: expect.stringContaining("已經收款或作廢") }));
  });

  it("下載明細 CSV:每張訂單一列", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await rowOf("INV-2")).getByRole("button", { name: "查看" }));
    await user.click(await screen.findByRole("button", { name: "下載明細" }));
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blobs[0], "utf-8"); });
    const lines = text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("INV-2,好味小館,月結,2026-09-01 ~ 2026-09-30,2099-01-01,#AAAAAAA1,2026-09-10,1000,已確認");
  });

  it("還沒有請款單時顯示引導", async () => {
    state.invoices = [];
    renderPage();
    expect(await screen.findByText(/還沒有請款單/)).toBeInTheDocument();
  });
});
