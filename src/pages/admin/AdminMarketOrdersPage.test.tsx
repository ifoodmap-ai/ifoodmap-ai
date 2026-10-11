// 管理後台「零售訂單」(唯讀總覽,處理客訴用):預設進行中、換篩選重新抓、搜尋、查看完整內容(含店家聯絡方式)與時間軸。
// 🔴 這一頁沒有任何寫入動作 —— 每一種狀態 × 付款方式打開來都沒有改訂單的按鈕、從頭到尾沒有寫入、原始碼也不碰寫入的函式。
// 另外釘住:時間軸只依 created_at 排(到微秒,不看資料回來的順序)、載入失敗可以重新載入、慢回來的舊查詢不蓋掉新清單。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess, supabaseFrom, supabaseRpc } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  supabaseFrom: vi.fn(() => {
    throw new Error("測試不准直接打資料庫");
  }),
  supabaseRpc: vi.fn(() => {
    throw new Error("測試不准直接打資料庫");
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: supabaseFrom, rpc: supabaseRpc } }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/lib/market/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/orders")>()),
  fetchAdminOrders: vi.fn(),
  addOrderEvent: vi.fn(),
}));

import { makeOrder } from "@/lib/market/orderFixtures";
import { addOrderEvent, fetchAdminOrders, ORDER_ACTIONS, ORDER_STATUSES, type MarketOrderRow } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import AdminMarketOrdersPage from "./AdminMarketOrdersPage";
import pageSource from "./AdminMarketOrdersPage.tsx?raw";

const STORE = { suppliers: { name: "市集測試 A 店", phone: "02-2345-6789", contact_email: "store-a@market-test.invalid" } };
const PENDING = makeOrder({
  market_stores: STORE,
  market_order_events: [{ to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00Z" }],
});
const SHIPPED = makeOrder({
  status: "shipped",
  buyer_name: "林小華",
  buyer_phone: "0922000111",
  shipped_carrier: "黑貓宅急便",
  shipped_tracking_no: "9001",
  market_stores: STORE,
  market_order_events: [
    { to_status: "shipped", actor_role: "supplier", note: null, created_at: "2026-10-09T06:00:00Z" },
    { to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00Z" },
  ],
});

beforeEach(() => {
  vi.mocked(fetchAdminOrders).mockReset().mockResolvedValue([PENDING, SHIPPED]);
  vi.mocked(addOrderEvent).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("AdminMarketOrdersPage", () => {
  it("預設抓進行中;換篩選重新抓;搜尋電話只留符合的", async () => {
    render(<AdminMarketOrdersPage />);
    expect(fetchAdminOrders).toHaveBeenCalledWith("open");
    expect(await screen.findByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "搜尋訂單編號、收件人、電話、Email、店名" }), "0922");
    expect(screen.queryByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeNull();
    expect(screen.getByText(`${formatOrderNo(SHIPPED.id)}・市集測試 A 店`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(fetchAdminOrders).toHaveBeenLastCalledWith("all");
  });

  it("查看:收件資料、物流、店家聯絡方式、明細、時間軸(照時間排、標出是誰做的)", async () => {
    render(<AdminMarketOrdersPage />);
    await userEvent.click(await screen.findByRole("button", { name: `查看 ${formatOrderNo(SHIPPED.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("林小華・0922000111・buyer@example.com")).toBeInTheDocument();
    expect(dialog.getByText("物流:黑貓宅急便,單號 9001")).toBeInTheDocument();
    expect(dialog.getByText("市集測試 A 店・02-2345-6789・store-a@market-test.invalid")).toBeInTheDocument();
    expect(dialog.getByText("有機高麗菜")).toBeInTheDocument();
    expect(dialog.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單(消費者)",
      "2026/10/09 14:00 已出貨(店家)",
    ]);
    expect(dialog.queryByRole("button", { name: "平台取消" })).toBeNull();
  });

  it("唯讀:16 種狀態 × 付款方式打開來都沒有改訂單的按鈕;從頭到尾沒有任何寫入", async () => {
    const all: MarketOrderRow[] = ORDER_STATUSES.flatMap((status) =>
      (["cod", "transfer"] as const).map((payment_method) =>
        makeOrder({
          status,
          payment_method,
          market_stores: STORE,
          market_order_events: [{ to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00Z" }],
        }),
      ),
    );
    vi.mocked(fetchAdminOrders).mockResolvedValue(all);
    render(<AdminMarketOrdersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "全部" }));
    await screen.findByRole("button", { name: `查看 ${formatOrderNo(all[15].id)}` });

    // 清單上只有四個篩選與每張單的「查看」
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "進行中",
      "已出貨",
      "已結束",
      "全部",
      ...all.map((o) => `查看 ${formatOrderNo(o.id)}`),
    ]);

    const actionLabels = [...Object.values(ORDER_ACTIONS).map((m) => m?.label), "平台取消", "取消"];
    for (const o of all) {
      await userEvent.click(screen.getByRole("button", { name: `查看 ${formatOrderNo(o.id)}` }));
      const dialog = await screen.findByRole("dialog");
      // 視窗裡唯一的按鈕是右上角的關閉
      expect(within(dialog).getAllByRole("button").map((b) => b.textContent), `${o.status} / ${o.payment_method}`).toEqual(["Close"]);
      for (const label of actionLabels) {
        expect(within(dialog).queryByRole("button", { name: new RegExp(label as string) })).toBeNull();
      }
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(addOrderEvent).not.toHaveBeenCalled();
    expect(supabaseFrom).not.toHaveBeenCalled();
    expect(supabaseRpc).not.toHaveBeenCalled();
  });

  it("原始碼不碰任何寫入:不用 addOrderEvent、OrderActionDialog、adminActions,也不直接打資料庫", () => {
    const code = pageSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/addOrderEvent|OrderActionDialog|adminActions|validateOrderAction/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|marketDb|marketRpc|integrations\/supabase/);
    // 從 orders.ts 只拿讀取用的東西
    const imported = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/market\/orders["']/.exec(code)?.[1] ?? "";
    const names = imported.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(["fetchAdminOrders", "ORDER_LIST_LIMIT", "ORDER_STATUS_LABEL", "AdminOrderFilter", "MarketOrderRow", "MarketOrderEventRow"], n).toContain(n);
    }
  });

  it("時間軸只依 created_at 由早到晚(同一秒內比到微秒),不看資料回來的順序", async () => {
    const TRANSFER = makeOrder({
      status: "awaiting_payment",
      payment_method: "transfer",
      market_stores: STORE,
      market_order_events: [
        { to_status: "awaiting_payment", actor_role: "system", note: null, created_at: "2026-10-09T05:00:00.000002+00:00" },
        { to_status: "confirmed", actor_role: "supplier", note: null, created_at: "2026-10-09T05:00:00.000001+00:00" },
        { to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00.5+00:00" },
      ],
    });
    vi.mocked(fetchAdminOrders).mockResolvedValue([TRANSFER]);
    render(<AdminMarketOrdersPage />);
    await userEvent.click(await screen.findByRole("button", { name: `查看 ${formatOrderNo(TRANSFER.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單(消費者)",
      "2026/10/09 13:00 已接單(店家)",
      "2026/10/09 13:00 待匯款(系統)",
    ]);
  });

  it("載入失敗:顯示原因與「重新載入」,不會說成沒有訂單", async () => {
    vi.mocked(fetchAdminOrders).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AdminMarketOrdersPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("零售訂單載入失敗:連線失敗,請檢查網路後再試一次");
    expect(screen.queryByText("沒有符合的訂單")).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeInTheDocument();
    expect(fetchAdminOrders).toHaveBeenCalledTimes(2);
    expect(fetchAdminOrders).toHaveBeenLastCalledWith("open");
  });

  it("切換篩選時,比較慢回來的舊查詢不會蓋掉新清單", async () => {
    let resolveOpen: (rows: MarketOrderRow[]) => void = () => {};
    vi.mocked(fetchAdminOrders)
      .mockImplementationOnce(() => new Promise<MarketOrderRow[]>((resolve) => (resolveOpen = resolve)))
      .mockResolvedValueOnce([SHIPPED]);
    render(<AdminMarketOrdersPage />);
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(await screen.findByText(`${formatOrderNo(SHIPPED.id)}・市集測試 A 店`)).toBeInTheDocument();
    resolveOpen([PENDING]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeNull();
    expect(screen.getByText(`${formatOrderNo(SHIPPED.id)}・市集測試 A 店`)).toBeInTheDocument();
  });
});
