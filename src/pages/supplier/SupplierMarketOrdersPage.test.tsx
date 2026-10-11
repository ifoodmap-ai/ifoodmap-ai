// 供應商「零售訂單」:分頁與件數、接單、拒單要原因、出貨要物流、畫面過期時重新整理。
// 另外釘住:每一種「狀態 × 付款方式」的按鈕都跟轉移表(MARKET_TRANSITIONS)一致、已收款的轉帳單可以出貨也可以取消、
// 原因 / 物流只有空白、全形空白、零寬字元一律擋下(資料庫的 market_visible 也會擋)、讀取失敗可以重新載入。
// 測試字串裡看不見的字元一律寫成 \u{…}(不要直接貼字元本身)。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SupplierState = { supplierId: string | null; loading: boolean; error: string | null; reload: () => void };
const { toastError, toastSuccess, supplier } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  /** null = 預設(已登入的 A 店);個別測試換成讀不到供應商帳號的狀態 */
  supplier: { current: null as SupplierState | null },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/hooks/use-current-supplier", () => ({
  useCurrentSupplier: () =>
    supplier.current ?? { supplierId: "a9200000-0000-4000-8000-00000000000a", loading: false, error: null, reload: () => {} },
}));
vi.mock("@/lib/market/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/orders")>()),
  fetchSupplierOrders: vi.fn(),
  addOrderEvent: vi.fn(),
}));

import { MarketDbError } from "@/lib/market/db";
import { makeOrder } from "@/lib/market/orderFixtures";
import {
  addOrderEvent,
  fetchSupplierOrders,
  MARKET_TRANSITIONS,
  ORDER_ACTIONS,
  ORDER_STATUSES,
  type MarketOrderRow,
  type OrderStatus,
} from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import SupplierMarketOrdersPage from "./SupplierMarketOrdersPage";

const PENDING = makeOrder({ status: "pending" });
const AWAITING = makeOrder({ status: "awaiting_payment", payment_method: "transfer" });
const CONFIRMED = makeOrder({ status: "confirmed" });
const SHIPPED = makeOrder({ status: "shipped", shipped_carrier: "黑貓宅急便", shipped_tracking_no: "9001" });
const DONE = makeOrder({ status: "rejected", status_note: "缺貨" });

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SupplierMarketOrdersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  supplier.current = null;
  vi.mocked(fetchSupplierOrders).mockReset().mockResolvedValue([PENDING, AWAITING, CONFIRMED, SHIPPED, DONE]);
  vi.mocked(addOrderEvent).mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  toastSuccess.mockReset();
});
afterEach(cleanup);

describe("SupplierMarketOrdersPage", () => {
  it("預設看待處理;分頁顯示件數;收件資料與明細", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "待處理(3)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "已出貨(1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已結束(1)" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    const card = within(screen.getByRole("article", { name: `訂單 ${formatOrderNo(PENDING.id)}` }));
    expect(card.getByText("待接單")).toBeInTheDocument();
    expect(card.getByRole("link", { name: "0912345678" })).toHaveAttribute("href", "tel:0912345678");
    expect(card.getByText("有機高麗菜")).toBeInTheDocument();
    expect(card.getByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` })).toBeInTheDocument();
    expect(card.getByRole("button", { name: `拒單 ${formatOrderNo(PENDING.id)}` })).toBeInTheDocument();
  });

  it("接單:確認後新增紀錄、成功訊息、重新抓清單", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PENDING, "confirmed", { reason: "", carrier: "", trackingNo: "" });
    await waitFor(() => expect(fetchSupplierOrders).toHaveBeenCalledTimes(2));
    expect(toastSuccess).toHaveBeenCalledWith(`訂單 ${formatOrderNo(PENDING.id)} 已改成「已接單」`);
  });

  it("拒單:沒填原因擋下來;填了才送", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `拒單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫原因(會告知消費者)");
    expect(addOrderEvent).not.toHaveBeenCalled();
    await userEvent.type(dialog.getByLabelText("原因(必填,會寄給消費者)"), "今天缺貨");
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PENDING, "rejected", { reason: "今天缺貨", carrier: "", trackingNo: "" });
  });

  it("轉帳待匯款:確認已收款;貨到付款已接單:出貨要填物流", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: `確認已收款 ${formatOrderNo(AWAITING.id)}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `出貨 ${formatOrderNo(CONFIRMED.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定出貨" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫物流");
    await userEvent.type(dialog.getByLabelText("物流(必填)"), "黑貓宅急便");
    await userEvent.type(dialog.getByLabelText("物流單號(選填)"), "9001");
    await userEvent.click(dialog.getByRole("button", { name: "確定出貨" }));
    expect(addOrderEvent).toHaveBeenCalledWith(CONFIRMED, "shipped", { reason: "", carrier: "黑貓宅急便", trackingNo: "9001" });
  });

  it("畫面過期(別人剛處理過):顯示原因、關掉視窗、重新抓清單", async () => {
    vi.mocked(addOrderEvent).mockRejectedValue(new MarketDbError({ message: "stale", code: "P0001", hint: "stale_order_status" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "確定接單" }));
    expect(toastError).toHaveBeenCalledWith("沒有改成功", { description: "這張訂單剛被處理過,畫面已重新整理,請再確認一次" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchSupplierOrders).toHaveBeenCalledTimes(2);
  });

  it("已出貨分頁:物流單號、標記完成;已結束分頁:原因、沒有按鈕", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "已出貨(1)" }));
    expect(screen.getByText("物流:黑貓宅急便,單號 9001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `標記完成 ${formatOrderNo(SHIPPED.id)}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已結束(1)" }));
    const card = within(screen.getByRole("article"));
    expect(card.getByText("原因:缺貨")).toBeInTheDocument();
    expect(card.queryByRole("button")).toBeNull();
  });

  it("每一種狀態 × 付款方式(16 種)的按鈕都跟轉移表一致", async () => {
    // 看得懂的規格表:供應商在每一種組合看到哪些按鈕(依畫面順序)
    const SPEC: Record<OrderStatus, { cod: string[]; transfer: string[] }> = {
      pending: { cod: ["接單", "拒單"], transfer: ["接單", "拒單"] },
      confirmed: { cod: ["出貨", "取消訂單"], transfer: ["取消訂單"] },
      awaiting_payment: { cod: [], transfer: ["確認已收款", "取消訂單"] },
      paid: { cod: [], transfer: ["出貨", "取消訂單"] },
      shipped: { cod: ["標記完成"], transfer: ["標記完成"] },
      completed: { cod: [], transfer: [] },
      rejected: { cod: [], transfer: [] },
      cancelled: { cod: [], transfer: [] },
    };
    // 規格表本身也要跟轉移表一致:轉移表裡這個狀態、這種付款方式能去的地方,
    // 去掉「待匯款」(資料庫自動轉,不給按)與「待接單 → 取消」(待接單用「拒單」),依轉移表的順序
    const fromTransitions = (status: OrderStatus, payment: "cod" | "transfer") =>
      MARKET_TRANSITIONS.filter((t) => t.from === status && (t.payment === "any" || t.payment === payment))
        .map((t) => t.to)
        .filter((to) => to !== "awaiting_payment" && !(status === "pending" && to === "cancelled"))
        .map((to) => ORDER_ACTIONS[to]?.label);
    for (const status of ORDER_STATUSES) {
      for (const payment of ["cod", "transfer"] as const) {
        expect(fromTransitions(status, payment), `${status} / ${payment}`).toEqual(SPEC[status][payment]);
      }
    }

    const all: MarketOrderRow[] = ORDER_STATUSES.flatMap((status) =>
      (["cod", "transfer"] as const).map((payment_method) => makeOrder({ status, payment_method })),
    );
    vi.mocked(fetchSupplierOrders).mockResolvedValue(all);
    renderPage();
    await screen.findByRole("button", { name: "待處理(8)" });
    const seen = new Set<string>();
    for (const tab of ["待處理(8)", "已出貨(2)", "已結束(6)"]) {
      await userEvent.click(screen.getByRole("button", { name: tab }));
      for (const article of screen.getAllByRole("article")) {
        const order = all.find((o) => article.getAttribute("aria-labelledby") === `market-order-${o.id}`);
        if (!order) throw new Error("畫面上有一張不認得的訂單");
        seen.add(order.id);
        const no = formatOrderNo(order.id);
        const buttons = within(article).queryAllByRole("button");
        const expected = SPEC[order.status][order.payment_method];
        expect(buttons.map((b) => b.textContent), `${order.status} / ${order.payment_method}`).toEqual(expected);
        // 按鈕名稱帶訂單編號,螢幕閱讀器分得出是哪一張
        expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(expected.map((label) => `${label} ${no}`));
      }
    }
    expect(seen.size).toBe(16);
  });

  it("已收款的轉帳單:同時有「出貨」和「取消訂單」;取消要原因,視窗說明退款由店家處理", async () => {
    const PAID = makeOrder({ status: "paid", payment_method: "transfer" });
    vi.mocked(fetchSupplierOrders).mockResolvedValue([PAID]);
    renderPage();
    const no = formatOrderNo(PAID.id);
    expect(await screen.findByRole("button", { name: `出貨 ${no}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `取消訂單 ${no}` }));
    const dialog = within(await screen.findByRole("dialog", { name: `取消訂單:訂單 ${no}` }));
    expect(dialog.getByText(/這筆訂單你已確認收款,取消後要由你自行退款給消費者/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "確定取消訂單" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫原因(會告知消費者)");
    expect(addOrderEvent).not.toHaveBeenCalled();
    await userEvent.type(dialog.getByLabelText("原因(必填,會寄給消費者)"), "商品損壞,已退款");
    await userEvent.click(dialog.getByRole("button", { name: "確定取消訂單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PAID, "cancelled", { reason: "商品損壞,已退款", carrier: "", trackingNo: "" });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(`訂單 ${no} 已改成「已取消」`));
  });

  it("原因、物流只有空白、全形空白、零寬字元:拒單、取消、出貨都擋下來,不會送出", async () => {
    const COD_CONFIRMED = makeOrder({ status: "confirmed", payment_method: "cod" });
    vi.mocked(fetchSupplierOrders).mockResolvedValue([PENDING, COD_CONFIRMED]);
    renderPage();
    await screen.findByRole("button", { name: "待處理(2)" });
    const BLANKS = ["", "   ", "\u{3000}\u{3000}", "\u{200B}", "\u{200B}\u{3000} \u{FEFF}\u{2060}"];
    const cases: Array<{ order: MarketOrderRow; action: string; field: string; message: string }> = [
      { order: PENDING, action: "拒單", field: "原因(必填,會寄給消費者)", message: "請填寫原因(會告知消費者)" },
      { order: COD_CONFIRMED, action: "取消訂單", field: "原因(必填,會寄給消費者)", message: "請填寫原因(會告知消費者)" },
      { order: COD_CONFIRMED, action: "出貨", field: "物流(必填)", message: "請填寫物流" },
    ];
    for (const c of cases) {
      for (const blank of BLANKS) {
        await userEvent.click(screen.getByRole("button", { name: `${c.action} ${formatOrderNo(c.order.id)}` }));
        const dialog = within(await screen.findByRole("dialog"));
        if (blank) await userEvent.type(dialog.getByLabelText(c.field), blank);
        await userEvent.click(dialog.getByRole("button", { name: `確定${c.action}` }));
        expect(dialog.getByRole("alert"), `${c.action}:${JSON.stringify(blank)}`).toHaveTextContent(c.message);
        expect(dialog.getByLabelText(c.field)).toHaveAttribute("aria-invalid", "true");
        await userEvent.click(dialog.getByRole("button", { name: "返回" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
    }
    expect(addOrderEvent).not.toHaveBeenCalled();
  });

  it("沒有改成功(不是畫面過期):視窗留著、顯示中文原因,可以再按一次", async () => {
    vi.mocked(addOrderEvent).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("沒有改成功", { description: "連線失敗,請檢查網路後再試一次" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fetchSupplierOrders).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    expect(addOrderEvent).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("訂單讀取失敗:顯示原因與「重新載入」,不會說成沒有訂單", async () => {
    vi.mocked(fetchSupplierOrders).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("訂單讀取失敗:連線失敗,請檢查網路後再試一次");
    expect(screen.queryByText(/沒有待處理的訂單/)).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByRole("button", { name: "待處理(3)" })).toBeInTheDocument();
    expect(fetchSupplierOrders).toHaveBeenCalledTimes(2);
  });

  it("讀不到供應商帳號:顯示原因與「重新載入」,不查訂單", async () => {
    const reload = vi.fn();
    supplier.current = { supplierId: null, loading: false, error: "找不到你的供應商帳號", reload };
    renderPage();
    expect(screen.getByRole("heading", { name: "零售訂單" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("找不到你的供應商帳號");
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchSupplierOrders).not.toHaveBeenCalled();
  });
});
