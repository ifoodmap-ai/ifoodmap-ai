// 供應商「訂單」頁(/supplier/orders,後台精簡 Q1-A):收單、報價、出貨、送達合成一頁。
// 驗證:①狀態分頁(?stage=)與舊網址落點 ②每張單只出現 allowedTransitions 給的按鈕
// ③每個動作都走 recordOrderEvent、帶對的參數 ④拒單要原因、報價要金額 ⑤失敗照實顯示、過期就重抓
// ⑥通知信的 ?order= 會切到那張單的分頁 ⑦訂單編號用 formatOrderNo ⑧這頁不直接寫任何表。
// supabase 換成記憶體假資料(每次查詢都記下來),並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import SupplierOrdersPage from "./SupplierOrdersPage";
import { OrderEventError } from "@/lib/orders";

interface Call { table: string; op: string; filters: [string, string, unknown][] }

const { state, recordOrderEvent, toastSuccess, toastError } = vi.hoisted(() => ({
  state: {
    calls: [] as Call[],
    orders: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    supplies: [] as Record<string, unknown>[],
    prices: [] as Record<string, unknown>[],
    /** 下單餐廳所屬群組的群組價(沒群組 = 空陣列) */
    member: [] as Record<string, unknown>[],
    groupPrices: [] as Record<string, unknown>[],
  },
  recordOrderEvent: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const resolveRows = () => {
    state.calls.push(call);
    if (table === "supplier_accounts") return { data: { supplier_id: "sup-1" }, error: null };
    if (table === "supplier_orders") return { data: state.orders, error: null };
    if (table === "restaurants") return { data: [{ id: "rest-1", name: "好味小館", city: "台北市" }], error: null };
    if (table === "order_events") return { data: state.events, error: null };
    if (table === "supplies") return { data: state.supplies, error: null };
    if (table === "supplier_customer_prices") return { data: state.prices, error: null };
    if (table === "supplier_customer_group_members") return { data: state.member, error: null };
    if (table === "supplier_group_prices") return { data: state.groupPrices, error: null };
    if (table === "supplier_shipments")
      return {
        data: [{ order_id: "ord-shipped-000000a4", shipped_at: "2026-09-28T02:00:00Z", tracking_info: { carrier: "自有車隊", tracking_number: "T-9" }, notes: null }],
        error: null,
      };
    return { data: [], error: null };
  };
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { call.filters.push(["eq", col, val]); return builder; },
    in: (col: string, val: unknown) => { call.filters.push(["in", col, val]); return builder; },
    order: (col: string, opts?: { ascending?: boolean }) => { call.filters.push(["order", col, opts?.ascending ?? true]); return builder; },
    insert: () => { call.op = "insert"; return builder; },
    update: () => { call.op = "update"; return builder; },
    delete: () => { call.op = "delete"; return builder; },
    maybeSingle: () => Promise.resolve(resolveRows()),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolveRows()).then(ok, bad),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-sup", email: "sales@example.com" } } } }) },
  },
}));

vi.mock("@/lib/orders", async () => {
  const actual = await vi.importActual<typeof import("@/lib/orders")>("@/lib/orders");
  return { ...actual, recordOrderEvent };
});

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, info: vi.fn() } }));

const order = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  restaurant_id: "rest-1",
  ingredient_list: [{ name: "高麗菜", quantity: 10, unit: "kg" }],
  total_amount: null,
  notes: null,
  created_at: "2026-09-27T02:00:00Z",
  current_stage_since: new Date().toISOString(),
  ...extra,
});

const ALL = () => [
  order("ord-dispatched-000000a1", "dispatched"),
  order("ord-accepted-000000a2", "accepted"),
  order("ord-confirmed-000000a3", "confirmed", { total_amount: 3200 }),
  order("ord-shipped-000000a4", "shipped", { total_amount: 1800 }),
  order("ord-transit-000000a5", "in_transit", { total_amount: 900 }),
  order("ord-quoted-000000a6", "quoted", { total_amount: 1500 }),
  order("ord-delivered-000000a7", "delivered", { total_amount: 700 }),
  order("ord-rejected-000000a8", "rejected"),
];

const LocationProbe = () => {
  const location = useLocation();
  return <p data-testid="url">{`${location.pathname}${location.search}`}</p>;
};

/** 路由跟 App.tsx 一樣:舊網址轉到對應的狀態分頁 */
const renderPage = (path = "/supplier/orders") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/supplier/orders" element={<><SupplierOrdersPage /><LocationProbe /></>} />
        <Route path="/supplier/quotes" element={<Navigate to="/supplier/orders?stage=accepted" replace />} />
        <Route path="/supplier/shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
        <Route path="/supplier/logistics" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
      </Routes>
    </MemoryRouter>,
  );

const card = (id: string) => screen.getByTestId(`supplier-order-${id}`);
const visibleIds = () => screen.queryAllByTestId(/^supplier-order-/).map((el) => el.getAttribute("data-testid")!.replace("supplier-order-", ""));
const waitLoaded = () => waitFor(() => expect(screen.queryAllByTestId(/^supplier-order-/).length).toBeGreaterThan(0));

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.calls = [];
  state.orders = ALL();
  state.events = [];
  state.supplies = [];
  state.prices = [];
  state.member = [];
  state.groupPrices = [];
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
  toastSuccess.mockReset();
  toastError.mockReset();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
  // 這頁不直接寫任何表:狀態、報價金額、出貨紀錄都只經由 recordOrderEvent(資料庫 trigger 在同一交易裡寫)
  expect(state.calls.filter((c) => c.op !== "select")).toEqual([]);
});

describe("狀態分頁", () => {
  it("預設是「待處理」:列出所有等供應商動作的單,不含待餐廳確認/已送達/已拒單", async () => {
    renderPage();
    await waitLoaded();
    expect(screen.getByRole("tab", { name: /待處理/ })).toHaveAttribute("aria-selected", "true");
    expect(visibleIds().sort()).toEqual(
      ["ord-accepted-000000a2", "ord-confirmed-000000a3", "ord-dispatched-000000a1", "ord-shipped-000000a4", "ord-transit-000000a5"],
    );
    // 只查自己供應商的單
    const orderQuery = state.calls.find((c) => c.table === "supplier_orders")!;
    expect(orderQuery.filters).toContainEqual(["eq", "supplier_id", "sup-1"]);
  });

  it.each([
    ["/supplier/quotes", "待報價", ["ord-accepted-000000a2"]],
    ["/supplier/shipments", "出貨紀錄", ["ord-shipped-000000a4", "ord-transit-000000a5", "ord-delivered-000000a7"]],
    ["/supplier/logistics", "出貨紀錄", ["ord-shipped-000000a4", "ord-transit-000000a5", "ord-delivered-000000a7"]],
    ["/supplier/orders?stage=dispatched", "待接單", ["ord-dispatched-000000a1"]],
    ["/supplier/orders?stage=quoted", "待餐廳確認", ["ord-quoted-000000a6"]],
    ["/supplier/orders?stage=all", "全部", ALL().map((o) => o.id)],
  ])("舊網址/分頁 %s 落在「%s」", async (path, tab, ids) => {
    renderPage(path);
    await waitLoaded();
    expect(screen.getByRole("tab", { name: new RegExp(tab) })).toHaveAttribute("aria-selected", "true");
    expect(visibleIds().sort()).toEqual([...ids].sort());
  });

  it("點分頁會換網址(?stage=),分頁上有張數", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitLoaded();
    expect(screen.getByRole("tab", { name: /待出貨\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /待處理\s*5/ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /待出貨/ }));
    expect(screen.getByTestId("url")).toHaveTextContent("/supplier/orders?stage=confirmed");
    expect(visibleIds()).toEqual(["ord-confirmed-000000a3"]);
  });

  it("通知信連結 ?order=<id>:自動切到那張單所在的分頁並標出來", async () => {
    renderPage("/supplier/orders?order=ord-delivered-000000a7");
    await waitFor(() => expect(screen.getByRole("tab", { name: /出貨紀錄/ })).toHaveAttribute("aria-selected", "true"));
    expect(card("ord-delivered-000000a7")).toHaveAttribute("data-highlighted", "true");
  });
});

describe("每張單的按鈕 = allowedTransitions(\"supplier\", status)", () => {
  it.each([
    ["ord-dispatched-000000a1", ["接單", "拒單"]],
    ["ord-accepted-000000a2", ["報價"]],
    ["ord-confirmed-000000a3", ["出貨"]],
    ["ord-shipped-000000a4", ["標記運送中", "已送達"]],
    ["ord-transit-000000a5", ["已送達"]],
    ["ord-quoted-000000a6", []],
    ["ord-delivered-000000a7", []],
    ["ord-rejected-000000a8", []],
  ])("%s → %j", async (id, labels) => {
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();
    const buttons = within(card(id)).queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(labels);
  });

  it("等餐廳動作的單顯示一句說明,不給按鈕", async () => {
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();
    expect(within(card("ord-quoted-000000a6")).getByText(/等餐廳確認後就可以出貨/)).toBeInTheDocument();
    expect(within(card("ord-delivered-000000a7")).getByText(/等餐廳確認收貨/)).toBeInTheDocument();
  });

  it("訂單編號是 # + 末 8 碼大寫(跟餐廳、通知信一樣)", async () => {
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();
    expect(within(card("ord-dispatched-000000a1")).getByText("#000000A1")).toBeInTheDocument();
  });

  it("顯示報價金額與出貨物流資訊", async () => {
    renderPage("/supplier/orders?stage=shipped");
    await waitLoaded();
    const c = card("ord-shipped-000000a4");
    expect(within(c).getByText("NT$ 1,800")).toBeInTheDocument();
    expect(within(c).getByText(/自有車隊 · 單號 T-9/)).toBeInTheDocument();
  });
});

describe("動作都走 recordOrderEvent", () => {
  it("接單:dispatched → accepted,身分 supplier、來源 supplier_portal", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitLoaded();
    await user.click(within(card("ord-dispatched-000000a1")).getByRole("button", { name: "接單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent).toHaveBeenCalledWith({
      orderId: "ord-dispatched-000000a1",
      fromStatus: "dispatched",
      toStatus: "accepted",
      actorRole: "supplier",
      source: "supplier_portal",
      note: null,
      payload: undefined,
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("訂單 #000000A1 已接單"));
  });

  it("拒單一定要填原因,原因寫進事件備註", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitLoaded();
    await user.click(within(card("ord-dispatched-000000a1")).getByRole("button", { name: "拒單" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "確定拒單" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("請填寫拒單原因");
    expect(recordOrderEvent).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/拒單原因/), "這週高麗菜缺貨");
    await user.click(within(dialog).getByRole("button", { name: "確定拒單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent.mock.calls[0][0]).toMatchObject({
      orderId: "ord-dispatched-000000a1",
      fromStatus: "dispatched",
      toStatus: "rejected",
      note: "這週高麗菜缺貨",
      payload: { reason: "這週高麗菜缺貨" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("報價:金額必填且大於 0;送出 accepted → quoted,金額與有效日期放在 payload", async () => {
    const user = userEvent.setup();
    renderPage("/supplier/orders?stage=accepted");
    await waitLoaded();
    await user.click(within(card("ord-accepted-000000a2")).getByRole("button", { name: "報價" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "送出報價" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("請輸入大於 0 的報價金額");
    await user.type(within(dialog).getByLabelText(/報價總金額/), "0");
    await user.click(within(dialog).getByRole("button", { name: "送出報價" }));
    expect(recordOrderEvent).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText(/報價總金額/));
    await user.type(within(dialog).getByLabelText(/報價總金額/), "3200.5");
    await user.type(within(dialog).getByLabelText(/報價有效到/), "2099-12-31");
    await user.type(within(dialog).getByLabelText(/備註/), "含運費");
    await user.click(within(dialog).getByRole("button", { name: "送出報價" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent.mock.calls[0][0]).toMatchObject({
      orderId: "ord-accepted-000000a2",
      fromStatus: "accepted",
      toStatus: "quoted",
      actorRole: "supplier",
      note: "含運費",
      payload: { total_amount: 3200.5, valid_until: "2099-12-31" },
    });
  });

  it("出貨:confirmed → shipped,物流資訊放在 payload.tracking", async () => {
    const user = userEvent.setup();
    renderPage("/supplier/orders?stage=confirmed");
    await waitLoaded();
    await user.click(within(card("ord-confirmed-000000a3")).getByRole("button", { name: "出貨" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/物流/), "黑貓");
    await user.type(within(dialog).getByLabelText(/追蹤單號/), "8812");
    await user.click(within(dialog).getByRole("button", { name: "確定出貨" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent.mock.calls[0][0]).toMatchObject({
      fromStatus: "confirmed",
      toStatus: "shipped",
      payload: { tracking: { carrier: "黑貓", tracking_number: "8812" } },
    });
  });

  it("送達要先確認:in_transit → delivered", async () => {
    const user = userEvent.setup();
    renderPage("/supplier/orders?stage=shipped");
    await waitLoaded();
    await user.click(within(card("ord-transit-000000a5")).getByRole("button", { name: "已送達" }));
    const dialog = await screen.findByRole("dialog");
    expect(recordOrderEvent).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "確定已送達" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
    expect(recordOrderEvent.mock.calls[0][0]).toMatchObject({ fromStatus: "in_transit", toStatus: "delivered" });
  });
});

describe("失敗照實顯示", () => {
  it("資料庫擋下的訊息原樣顯示在對話框與提示裡,對話框不關", async () => {
    const user = userEvent.setup();
    recordOrderEvent.mockRejectedValueOnce(
      new OrderEventError("這張訂單不是派給你的供應商,不能操作", "42501", "actor_role_mismatch"),
    );
    renderPage("/supplier/orders?stage=accepted");
    await waitLoaded();
    await user.click(within(card("ord-accepted-000000a2")).getByRole("button", { name: "報價" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/報價總金額/), "1000");
    await user.click(within(dialog).getByRole("button", { name: "送出報價" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("操作失敗", { description: "這張訂單不是派給你的供應商,不能操作" }),
    );
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("這張訂單不是派給你的供應商");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("畫面過期(別人剛處理過):顯示訊息並重抓列表", async () => {
    const user = userEvent.setup();
    recordOrderEvent.mockRejectedValueOnce(
      new OrderEventError("這張訂單的狀態已經變成「供應商拒單」,畫面上的資料過期了,請重新整理後再操作", "P0001", "stale_order_status"),
    );
    renderPage();
    await waitLoaded();
    const before = state.calls.filter((c) => c.table === "supplier_orders").length;
    await user.click(within(card("ord-dispatched-000000a1")).getByRole("button", { name: "接單" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][1].description).toContain("畫面上的資料過期了");
    await waitFor(() => expect(state.calls.filter((c) => c.table === "supplier_orders").length).toBe(before + 1));
  });
});

describe("App.tsx 的路由", () => {
  it("舊網址轉到訂單頁對應的分頁;舊的報價、出貨、物流頁檔案已經拿掉", () => {
    const app = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    expect(app).toContain('<Route path="orders" element={<SupplierOrdersPage />} />');
    expect(app).toContain('<Route path="quotes" element={<Navigate to="/supplier/orders?stage=accepted" replace />} />');
    expect(app).toContain('<Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />');
    expect(app).toContain('<Route path="logistics" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />');
    expect(app).not.toMatch(/SupplierQuotesPage|SupplierShipmentsPage|SupplierLogisticsPage/);
  });
});

describe("退回重新報價、取消、逾時的原因(業主拍板 N2 / F5)", () => {
  it("被餐廳退回的單(quoted → accepted)在待報價顯示原因;供應商自己接單的不顯示", async () => {
    state.orders = [
      order("ord-requote-00000000b1", "accepted"),
      order("ord-accepted-000000a2", "accepted"),
      order("ord-cancelled-0000000c1", "cancelled", { total_amount: 900 }),
      order("ord-expired-000000000e1", "expired"),
    ];
    state.events = [
      { order_id: "ord-requote-00000000b1", from_status: "dispatched", to_status: "accepted", note: null, created_at: "2026-09-28T01:00:00Z" },
      { order_id: "ord-requote-00000000b1", from_status: "quoted", to_status: "accepted", note: "高麗菜改成 20 顆", created_at: "2026-09-28T03:00:00Z" },
      { order_id: "ord-accepted-000000a2", from_status: "dispatched", to_status: "accepted", note: null, created_at: "2026-09-28T01:00:00Z" },
      { order_id: "ord-cancelled-0000000c1", from_status: "confirmed", to_status: "cancelled", note: "餐廳改訂,平台取消", created_at: "2026-09-28T04:00:00Z" },
      { order_id: "ord-expired-000000000e1", from_status: "dispatched", to_status: "expired", note: "在「待接單」停留超過 24 小時沒有人處理,系統標為逾時", created_at: "2026-09-28T05:00:00Z" },
    ];
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();

    expect(screen.getByTestId("reason-ord-requote-00000000b1")).toHaveTextContent("餐廳退回報價,請重新報價:高麗菜改成 20 顆");
    expect(screen.queryByTestId("reason-ord-accepted-000000a2")).toBeNull();
    expect(screen.getByTestId("reason-ord-cancelled-0000000c1")).toHaveTextContent("取消原因:餐廳改訂,平台取消");
    expect(screen.getByTestId("reason-ord-expired-000000000e1")).toHaveTextContent("逾時:在「待接單」停留超過 24 小時");
    // 被退回的單照樣可以重新報價
    expect(within(card("ord-requote-00000000b1")).getByRole("button", { name: "報價" })).toBeInTheDocument();
    const evQuery = state.calls.find((c) => c.table === "order_events")!;
    expect(evQuery.filters).toContainEqual(["in", "to_status", ["accepted", "cancelled", "expired"]]);
    // 新到舊撈:筆數超過上限時被截掉的是最舊的事件
    expect(evQuery.filters).toContainEqual(["order", "created_at", false]);
  });

  it("只看造成目前狀態的那一筆:退回 → 逾時 → 改派給我、我接單之後,不顯示以前寫給上一家的退回原因", async () => {
    state.orders = [order("ord-redispatch-0000000r1", "accepted")];
    state.events = [
      { order_id: "ord-redispatch-0000000r1", from_status: "dispatched", to_status: "accepted", note: null, created_at: "2026-09-26T01:00:00Z" },
      { order_id: "ord-redispatch-0000000r1", from_status: "quoted", to_status: "accepted", note: "寫給上一家的:單價太高", created_at: "2026-09-26T05:00:00Z" },
      { order_id: "ord-redispatch-0000000r1", from_status: "accepted", to_status: "expired", note: "在「待報價」停留超過 24 小時沒有人處理,系統標為逾時", created_at: "2026-09-27T06:00:00Z" },
      { order_id: "ord-redispatch-0000000r1", from_status: "dispatched", to_status: "accepted", note: null, created_at: "2026-09-28T02:00:00Z" },
    ];
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();
    expect(card("ord-redispatch-0000000r1")).toBeInTheDocument();
    expect(screen.queryByTestId("reason-ord-redispatch-0000000r1")).toBeNull();
  });

  it("事件不管用什麼順序回來,都取最新一筆進到目前狀態的事件", async () => {
    state.orders = [order("ord-twice-00000000t1", "accepted")];
    // 資料庫依新到舊回來:最新一次退回(R2)排第一
    state.events = [
      { order_id: "ord-twice-00000000t1", from_status: "quoted", to_status: "accepted", note: "第二次退回:數量改 30", created_at: "2026-09-28T06:00:00Z" },
      { order_id: "ord-twice-00000000t1", from_status: "quoted", to_status: "accepted", note: "第一次退回:單價太高", created_at: "2026-09-27T06:00:00Z" },
      { order_id: "ord-twice-00000000t1", from_status: "dispatched", to_status: "accepted", note: null, created_at: "2026-09-26T06:00:00Z" },
    ];
    renderPage("/supplier/orders?stage=all");
    await waitLoaded();
    expect(screen.getByTestId("reason-ord-twice-00000000t1")).toHaveTextContent("第二次退回:數量改 30");
  });

  describe("配送日、接單設定與出貨彙總", () => {
    it("訂單卡片顯示配送日(含星期);沒有配送日的單不顯示這行", async () => {
      state.orders = [
        order("ord-with-date-0000000d1", "accepted", { delivery_date: "2026-10-30" }),
        order("ord-no-date-000000000d2", "accepted"),
      ];
      renderPage("/supplier/orders?stage=all");
      await waitLoaded();
      expect(screen.getByTestId("delivery-ord-with-date-0000000d1")).toHaveTextContent("配送日 2026-10-30(週五)");
      expect(screen.queryByTestId("delivery-ord-no-date-000000000d2")).toBeNull();
    });

    it("頁首有「接單設定」與「出貨彙總」,按下去開對應的視窗", async () => {
      const user = userEvent.setup();
      renderPage("/supplier/orders?stage=all");
      await waitLoaded();

      await user.click(screen.getByRole("button", { name: /出貨彙總/ }));
      expect(await screen.findByRole("heading", { name: "出貨彙總與揀貨單" })).toBeInTheDocument();
      await user.keyboard("{Escape}");

      await user.click(screen.getByRole("button", { name: /接單設定/ }));
      expect(await screen.findByRole("heading", { name: "接單設定" })).toBeInTheDocument();
    });
  });

  describe("報價金額預填", () => {
    const CATALOG = [
      { id: "p1", name: "高麗菜", sku: null, unit: "kg", price: 45 },
      { id: "p2", name: "雞蛋", sku: null, unit: "箱", price: 620 },
    ];
    const open = async (id: string) => {
      const user = userEvent.setup();
      renderPage("/supplier/orders?stage=all");
      await waitLoaded();
      await user.click(within(card(id)).getByRole("button", { name: "報價" }));
      return { user, dialog: await screen.findByRole("dialog") };
    };

    it("每個品項都算得出來:依這家客戶的專屬價格(沒有專屬價用定價)預填金額,並說明來源", async () => {
      state.supplies = CATALOG;
      state.prices = [{ supply_id: "p1", price: "40.00" }];
      state.orders = [order("ord-prefill-0000000p1", "accepted", { ingredient_list: [{ name: "高麗菜", quantity: "10", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }] })];
      const { dialog } = await open("ord-prefill-0000000p1");

      await waitFor(() => expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(1640));
      expect(within(dialog).getByTestId("quote-hint")).toHaveTextContent("專屬價格");
    });

    it("客戶在群組裡:專屬價 > 群組價 > 定價(高麗菜專屬價 40、雞蛋群組價 600)", async () => {
      state.supplies = CATALOG;
      state.prices = [{ supply_id: "p1", price: "40.00" }];
      state.member = [{ group_id: "g1" }];
      state.groupPrices = [{ supply_id: "p1", price: "38.00" }, { supply_id: "p2", price: "600.00" }];
      state.orders = [order("ord-group-0000000000g1", "accepted", { ingredient_list: [{ name: "高麗菜", quantity: "10", unit: "kg" }, { name: "雞蛋", quantity: "2", unit: "箱" }] })];
      const { dialog } = await open("ord-group-0000000000g1");

      await waitFor(() => expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(1600));
      expect(within(dialog).getByTestId("quote-hint")).toHaveTextContent("群組價格");
    });

    it("只算得出一部分(有品項沒單價):不預填,免得被當成完整金額", async () => {
      state.supplies = CATALOG;
      state.orders = [order("ord-partial-00000000p2", "accepted", { ingredient_list: [{ name: "高麗菜", quantity: "10", unit: "kg" }, { name: "牛肉", quantity: "3", unit: "kg" }] })];
      const { dialog } = await open("ord-partial-00000000p2");
      await new Promise((r) => setTimeout(r, 50));
      expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(null);
      expect(within(dialog).queryByTestId("quote-hint")).toBeNull();
    });

    it("預填之後可以直接改成自己的金額", async () => {
      state.supplies = CATALOG;
      state.orders = [order("ord-typed-0000000000p3", "accepted", { ingredient_list: [{ name: "高麗菜", quantity: "10", unit: "kg" }] })];
      const { user, dialog } = await open("ord-typed-0000000000p3");
      await waitFor(() => expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(450));
      await user.clear(within(dialog).getByLabelText(/報價總金額/));
      await user.type(within(dialog).getByLabelText(/報價總金額/), "999");
      expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(999);
    });

    it("讀不到價格資料時照常讓供應商自己填", async () => {
      state.supplies = [];
      state.orders = [order("ord-none-00000000000p4", "accepted")];
      const { dialog } = await open("ord-none-00000000000p4");
      expect(within(dialog).getByLabelText(/報價總金額/)).toHaveValue(null);
    });
  });
});
