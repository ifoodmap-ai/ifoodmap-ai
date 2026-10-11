// 供應商「零售訂單」:分頁與件數、接單、拒單要原因、出貨要物流、畫面過期時重新整理。
// 另外釘住:每一種「狀態 × 付款方式」的按鈕都跟轉移表(MARKET_TRANSITIONS)一致、已收款的轉帳單可以出貨也可以取消、
// 原因 / 物流只有空白、全形空白、零寬字元一律擋下(資料庫的 market_visible 也會擋)、讀取失敗可以重新載入、
// 清單分「還沒結束 / 已結束」兩次查(已結束的單再多也擠不掉還沒處理的單)、換供應商登入不看到上一家的快取、
// 視窗每次從空白開始、送出中不能關、只有畫面過期才關窗重抓、頁首寫的寄信步驟跟 market-notify 一致。
// 測試字串裡看不見的字元一律寫成 \u{…}(不要直接貼字元本身)。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  ORDER_LIST_LIMIT,
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

const SUPPLIER = "a9200000-0000-4000-8000-00000000000a";
const CLOSED: readonly OrderStatus[] = ["completed", "rejected", "cancelled"];

/**
 * 假的伺服器:依查詢的組別在「伺服器端」篩狀態(跟 fetchSupplierOrders 的 active / closed 一樣)。
 * 沒帶組別 = 舊寫法(所有狀態共用一次 ORDER_LIST_LIMIT 張的上限,前端才分頁籤):回最新的那幾張。
 */
const serve = (rows: MarketOrderRow[]) => async (_supplierId: string, group?: "active" | "closed") => {
  if (!group) return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, ORDER_LIST_LIMIT);
  return rows.filter((o) => CLOSED.includes(o.status) === (group === "closed"));
};
const fetchesOf = (group: "active" | "closed") => vi.mocked(fetchSupplierOrders).mock.calls.filter((c) => c[1] === group).length;

const tree = (client: QueryClient) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <SupplierMarketOrdersPage />
    </MemoryRouter>
  </QueryClientProvider>
);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = () => render(tree(newClient()));

beforeEach(() => {
  supplier.current = null;
  vi.mocked(fetchSupplierOrders).mockReset().mockImplementation(serve([PENDING, AWAITING, CONFIRMED, SHIPPED, DONE]));
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
    // 兩組都重抓(拒單、取消、完成會把單從「還沒結束」移到「已結束」)
    await waitFor(() => expect([fetchesOf("active"), fetchesOf("closed")]).toEqual([2, 2]));
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
    await waitFor(() => expect([fetchesOf("active"), fetchesOf("closed")]).toEqual([2, 2]));
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
    vi.mocked(fetchSupplierOrders).mockImplementation(serve(all));
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
    vi.mocked(fetchSupplierOrders).mockImplementation(serve([PAID]));
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
    vi.mocked(fetchSupplierOrders).mockImplementation(serve([PENDING, COD_CONFIRMED]));
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
    expect([fetchesOf("active"), fetchesOf("closed")]).toEqual([1, 1]);
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    expect(addOrderEvent).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("訂單讀取失敗:顯示原因與「重新載入」,不會說成沒有訂單", async () => {
    const base = serve([PENDING, AWAITING, CONFIRMED, SHIPPED, DONE]);
    let failed = false;
    vi.mocked(fetchSupplierOrders).mockImplementation(async (id, group) => {
      if (group === "active" && !failed) {
        failed = true;
        throw new TypeError("Failed to fetch");
      }
      return base(id, group);
    });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("訂單讀取失敗:連線失敗,請檢查網路後再試一次");
    expect(screen.queryByText(/沒有待處理的訂單/)).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByRole("button", { name: "待處理(3)" })).toBeInTheDocument();
    expect(fetchesOf("active")).toBe(2);
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

  it("用目前登入的供應商 id 查,還沒結束 / 已結束兩組都查", async () => {
    renderPage();
    await screen.findByRole("button", { name: "待處理(3)" });
    expect(fetchSupplierOrders).toHaveBeenCalledWith(SUPPLIER, "active");
    expect(fetchSupplierOrders).toHaveBeenCalledWith(SUPPLIER, "closed");
    expect(fetchSupplierOrders).toHaveBeenCalledTimes(2);
  });

  it("已結束的單再多也擠不掉還沒處理的單:舊的已收款轉帳單照樣在待處理;已結束到上限時件數寫「200+」並提示", async () => {
    const OLD_PAID = makeOrder({ status: "paid", payment_method: "transfer", created_at: "2026-09-01T01:00:00+00:00" });
    const recentClosed = Array.from({ length: ORDER_LIST_LIMIT + 50 }, (_, i) =>
      makeOrder({ status: CLOSED[i % 3], created_at: `2026-10-10T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+00:00` }),
    );
    const base = serve([OLD_PAID, ...recentClosed]);
    // 伺服器的已結束清單只回最新的 ORDER_LIST_LIMIT 張
    vi.mocked(fetchSupplierOrders).mockImplementation(async (id, group) => (await base(id, group)).slice(0, ORDER_LIST_LIMIT));
    renderPage();
    const no = formatOrderNo(OLD_PAID.id);
    expect(await screen.findByRole("button", { name: "待處理(1)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("article", { name: `訂單 ${no}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `出貨 ${no}` })).toBeInTheDocument();
    expect(screen.queryByText(/只顯示最新/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: `已結束(${ORDER_LIST_LIMIT}+)` }));
    expect(screen.getAllByRole("article")).toHaveLength(ORDER_LIST_LIMIT);
    expect(screen.getByText(`只顯示最新的 ${ORDER_LIST_LIMIT} 張已結束的訂單。`)).toBeInTheDocument();
  });

  it("已結束的單沒到上限:件數照實寫、不顯示「只顯示最新」的提示", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "已結束(1)" }));
    expect(screen.queryByText(/只顯示最新/)).toBeNull();
  });

  it("換一家供應商登入(同一個 SPA、同一份快取):用新的 id 重查,不會看到上一家的單", async () => {
    const OTHER = "a9200000-0000-4000-8000-00000000000b";
    const B_ORDER = makeOrder({ status: "pending", supplier_id: OTHER, buyer_name: "B 店的客人" });
    vi.mocked(fetchSupplierOrders).mockImplementation(async (id, group) => (group === "closed" ? [] : id === OTHER ? [B_ORDER] : [PENDING]));
    const client = newClient();
    const { rerender } = render(tree(client));
    expect(await screen.findByRole("article", { name: `訂單 ${formatOrderNo(PENDING.id)}` })).toBeInTheDocument();
    supplier.current = { supplierId: OTHER, loading: false, error: null, reload: () => {} };
    rerender(tree(client));
    expect(await screen.findByRole("article", { name: `訂單 ${formatOrderNo(B_ORDER.id)}` })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: `訂單 ${formatOrderNo(PENDING.id)}` })).toBeNull();
    expect(fetchSupplierOrders).toHaveBeenCalledWith(OTHER, "active");
    expect(fetchSupplierOrders).toHaveBeenCalledWith(OTHER, "closed");
  });

  it("視窗每次打開都從空白開始:上一張單填了沒送出的原因、錯誤訊息不會帶到下一張", async () => {
    const OTHER_PENDING = makeOrder({ status: "pending" });
    vi.mocked(fetchSupplierOrders).mockImplementation(serve([PENDING, OTHER_PENDING]));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `拒單 ${formatOrderNo(PENDING.id)}` }));
    let dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫原因(會告知消費者)");
    await userEvent.type(dialog.getByLabelText("原因(必填,會寄給消費者)"), "A 單缺貨");
    await userEvent.click(dialog.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: `拒單 ${formatOrderNo(OTHER_PENDING.id)}` }));
    dialog = within(await screen.findByRole("dialog", { name: `拒單:訂單 ${formatOrderNo(OTHER_PENDING.id)}` }));
    expect(dialog.getByLabelText("原因(必填,會寄給消費者)")).toHaveValue("");
    expect(dialog.queryByRole("alert")).toBeNull();
    // 直接送出:不會把 A 單的原因寄給 B 單的消費者
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(addOrderEvent).not.toHaveBeenCalled();
  });

  it("送出中不能關:按 Esc、右上角關閉都不會關,返回鈕停用;回來之後才關", async () => {
    let finish: () => void = () => {};
    vi.mocked(addOrderEvent).mockImplementation(() => new Promise<void>((done) => (finish = done)));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    expect(dialog.getByRole("button", { name: "返回" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "確定接單" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastSuccess).toHaveBeenCalledWith(`訂單 ${formatOrderNo(PENDING.id)} 已改成「已接單」`);
  });

  it("沒有改成功、但不是畫面過期(one_event_per_order):視窗留著、不重抓清單", async () => {
    vi.mocked(addOrderEvent).mockRejectedValueOnce(new MarketDbError({ message: "one", code: "P0001", hint: "one_event_per_order" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("沒有改成功", { description: "請一步一步操作" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect([fetchesOf("active"), fetchesOf("closed")]).toEqual([1, 1]);
  });

  it("確認已收款的確定鈕寫「確定已收款」(不是「確定確認已收款」)", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `確認已收款 ${formatOrderNo(AWAITING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "確定已收款" })).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /確定確認/ })).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "確定已收款" }));
    expect(addOrderEvent).toHaveBeenCalledWith(AWAITING, "paid", { reason: "", carrier: "", trackingNo: "" });
  });

  it("轉帳單接單:提示照實際狀態寫(資料庫同一個交易就轉成待匯款)", async () => {
    const TRANSFER_PENDING = makeOrder({ status: "pending", payment_method: "transfer" });
    vi.mocked(fetchSupplierOrders).mockImplementation(serve([TRANSFER_PENDING]));
    renderPage();
    const no = formatOrderNo(TRANSFER_PENDING.id);
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${no}` }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "確定接單" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(`訂單 ${no} 已接單,等消費者匯款(狀態:待匯款)`));
    expect(toastSuccess).not.toHaveBeenCalledWith(`訂單 ${no} 已改成「已接單」`);
  });

  it("頁首寫的寄信步驟跟 market-notify 的 resolveEventMails 一致(確認已收款、標記完成不寄信)", async () => {
    // 從 market-notify 的原始碼讀出「哪些狀態會寄信給消費者」(render.ts 是 Deno 程式,不直接 import)
    const render = readFileSync(resolve(__dirname, "../../../supabase/functions/market-notify/render.ts"), "utf8");
    const fn = render.slice(render.indexOf("export const resolveEventMails"));
    const body = fn.slice(0, fn.indexOf("\n};"));
    const mailed = [...body.matchAll(/case "([a-z_]+)":\s*return ([^;]+);/g)].filter((m) => m[2].includes('"consumer_')).map((m) => m[1]);
    expect(mailed).toEqual(["confirmed", "awaiting_payment", "rejected", "shipped", "cancelled"]);
    expect(body).toContain('case "confirmed":\n      return ev.paymentMethod === "transfer" ? [] : ["consumer_confirmed"];');

    renderPage();
    const intro = await screen.findByText(/消費者會收到 Email 通知/);
    expect(intro).toHaveTextContent("你接單、拒單、出貨、取消時,消費者會收到 Email 通知(轉帳單接單後寄的是匯款資訊);確認已收款、標記完成不寄信。");
    expect(screen.queryByText(/每一步/)).toBeNull();
  });
});
