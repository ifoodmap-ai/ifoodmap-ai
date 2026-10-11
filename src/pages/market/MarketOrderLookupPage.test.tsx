// /market/orders/:token:token 頁 —— 壞網址 / 找不到、每張訂單的狀態與明細、轉帳資訊只在待匯款時出現、拒單原因、出貨單號、
// 剛下單的提示(網址與複製)、載入失敗可以重試。
// 檔尾另外釘住:已收款後被取消、進度照時間排、聯絡店家只有電話(查單 RPC 不給 contact_email)、離線、複製失敗、背景重抓失敗。
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/lookup")>()),
  fetchOrdersByToken: vi.fn(),
}));

import { fetchOrdersByToken, type LookupOrder } from "@/lib/market/lookup";
import { formatOrderNo } from "@/lib/order-number";
import MarketOrderLookupPage from "./MarketOrderLookupPage";
import { newTestQueryClient, renderMarketRoute } from "./testUtils";

const TOKEN = `tok_${"x".repeat(39)}`;
const renderAt = (path: string, client = newTestQueryClient()) =>
  renderMarketRoute(path, [{ path: "/market/orders/:token", element: <MarketOrderLookupPage /> }], client);

const base = (over: Partial<LookupOrder>): LookupOrder => ({
  id: "a9600000-0000-4000-8000-0000000000a1",
  status: "pending",
  payment_method: "cod",
  subtotal: 650,
  shipping_fee: 120,
  total: 770,
  created_at: "2026-10-09T04:05:00Z",
  status_note: null,
  shipped_carrier: null,
  shipped_tracking_no: null,
  buyer_name: "王小明",
  buyer_phone: "0912***678",
  buyer_email: "b***@example.com",
  ship_city: "臺北市",
  ship_address: "測試路 1 號 2 樓",
  buyer_note: "請放管理室",
  store: { supplier_id: "s-a", name: "市集測試 A 店", phone: "02-2345-6789", ship_days: 2, return_policy: null },
  items: [{ product_name: "有機高麗菜", spec: "1 顆", unit_price: 100, qty: 2, line_total: 200, temperature: "chilled" }],
  events: [{ to_status: "pending", created_at: "2026-10-09T04:05:00Z", note: null }],
  transfer_info: null,
  ...over,
});

const A = base({});
const B = base({
  id: "a9600000-0000-4000-8000-0000000000b1",
  status: "awaiting_payment",
  payment_method: "transfer",
  subtotal: 200,
  shipping_fee: 60,
  total: 260,
  store: { ...A.store, supplier_id: "s-b", name: "市集測試 B 店" },
  transfer_info: "郵局(700)\n帳號 0001234-5678901",
  events: [
    { to_status: "pending", created_at: "2026-10-09T04:05:00Z", note: null },
    { to_status: "confirmed", created_at: "2026-10-09T05:00:00Z", note: null },
    { to_status: "awaiting_payment", created_at: "2026-10-09T05:00:00Z", note: null },
  ],
});

// 一定要用大括號:箭頭函式直接回傳 mockReset() 的結果(就是 mock 本身)時,vitest 會把它當成清理函式在測試結束後呼叫一次
beforeEach(() => {
  vi.mocked(fetchOrdersByToken).mockReset();
});
afterEach(cleanup);
// 時鐘固定在 2026-10-09T06:00Z(假資料的期限都在 10/12):頁面會依「現在」判斷自動取消到期了沒,不能跟著真的時間走
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T06:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("MarketOrderLookupPage", () => {
  it("網址的 token 格式不對:直接顯示找不到,不查資料庫", () => {
    renderAt("/market/orders/short");
    expect(screen.getByRole("heading", { name: /找不到這筆訂單/ })).toBeInTheDocument();
    expect(fetchOrdersByToken).not.toHaveBeenCalled();
    expect(document.title).toBe("找不到訂單｜iFoodmap 食材市集");
  });

  it("查不到:找不到", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue(null);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: /找不到這筆訂單/ })).toBeInTheDocument();
  });

  it("兩家店兩張單:店名、訂單編號、狀態、明細;收件資料是遮罩過的", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const a = within(await screen.findByRole("region", { name: `市集測試 A 店 訂單 ${formatOrderNo(A.id)}` }));
    expect(a.getByText("待接單")).toBeInTheDocument();
    expect(a.getByText("有機高麗菜")).toBeInTheDocument();
    expect(a.getByText("NT$ 770")).toBeInTheDocument();
    expect(a.queryByText(/請匯款/)).toBeNull();
    expect(screen.getByRole("region", { name: "收件資料" })).toHaveTextContent("王小明・0912***678・b***@example.com");
    expect(screen.getByRole("heading", { level: 1, name: "訂單查詢" })).toBeInTheDocument();
  });

  it("待匯款的轉帳訂單:顯示金額與匯款資訊(保留換行);時間軸", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = within(await screen.findByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    expect(b.getByText("店家已接單,請匯款 NT$ 260:")).toBeInTheDocument();
    expect(b.getByText(/帳號 0001234-5678901/)).toHaveClass("whitespace-pre-line");
    expect(b.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單",
      "2026/10/09 13:00 已接單",
      "2026/10/09 13:00 待匯款",
    ]);
  });

  it("拒單顯示原因;出貨顯示物流與單號", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([
      base({ status: "rejected", status_note: "今天缺貨" }),
      base({ id: "a9600000-0000-4000-8000-0000000000c1", status: "shipped", shipped_carrier: "黑貓宅急便", shipped_tracking_no: "9001" }),
    ]);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByText("原因:今天缺貨")).toBeInTheDocument();
    expect(screen.getByText("物流:黑貓宅急便,單號 9001")).toBeInTheDocument();
  });

  it("剛下單(?new=1):提示已送出、顯示這個網址、可以複製", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}?new=1`);
    expect(await screen.findByText("訂單已送出,共 2 張(每家店一張)。店家接單後會寄信通知你。")).toBeInTheDocument();
    const url = screen.getByRole("textbox", { name: "訂單查詢網址" });
    expect(url).toHaveValue(`${window.location.origin}/market/orders/${TOKEN}`);
    await userEvent.click(screen.getByRole("button", { name: "複製連結" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/market/orders/${TOKEN}`);
    expect(await screen.findByText("已複製。")).toBeInTheDocument();
  });

  it("載入失敗:顯示錯誤,可以再試一次", async () => {
    vi.mocked(fetchOrdersByToken).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce([A]);
    renderAt(`/market/orders/${TOKEN}`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("訂單載入失敗");
    expect(within(alert).getByRole("heading", { level: 1, name: "訂單載入失敗" })).toBeInTheDocument();
    expect(document.title).toBe("訂單載入失敗｜iFoodmap 食材市集");
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByText("有機高麗菜")).toBeInTheDocument();
  });
});

describe("MarketOrderLookupPage:取消、排序、聯絡店家、離線、複製失敗、背景重抓", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("轉帳單已收款後被取消:照常顯示「已取消」與原因,不顯示匯款資訊;進度走到已取消", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([
      base({
        status: "cancelled",
        payment_method: "transfer",
        status_note: "臨時缺貨,款項會全額退回",
        events: [
          { to_status: "pending", created_at: "2026-10-09T04:05:00Z", note: null },
          { to_status: "confirmed", created_at: "2026-10-09T05:00:00.000001Z", note: null },
          { to_status: "awaiting_payment", created_at: "2026-10-09T05:00:00.000002Z", note: null },
          { to_status: "paid", created_at: "2026-10-10T01:00:00Z", note: null },
          { to_status: "cancelled", created_at: "2026-10-10T02:30:00Z", note: "臨時缺貨,款項會全額退回" },
        ],
      }),
    ]);
    renderAt(`/market/orders/${TOKEN}`);
    const o = within(await screen.findByRole("region", { name: `市集測試 A 店 訂單 ${formatOrderNo(A.id)}` }));
    expect(o.getByText("已取消")).toBeInTheDocument();
    expect(o.getByText("原因:臨時缺貨,款項會全額退回")).toBeInTheDocument();
    expect(o.queryByText(/請匯款/)).toBeNull();
    expect(o.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單",
      "2026/10/09 13:00 已接單",
      "2026/10/09 13:00 待匯款",
      "2026/10/10 09:00 已收款",
      "2026/10/10 10:30 已取消",
    ]);
  });

  it("進度照 created_at 排:資料庫給的順序亂了(同一毫秒、差幾微秒)也排得對", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([
      base({
        ...B,
        events: [
          { to_status: "awaiting_payment", created_at: "2026-10-09T05:00:00.123457+00:00", note: null },
          { to_status: "confirmed", created_at: "2026-10-09T05:00:00.123456+00:00", note: null },
          { to_status: "pending", created_at: "2026-10-09T04:05:00+00:00", note: null },
        ],
      }),
    ]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = within(await screen.findByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    expect(b.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單",
      "2026/10/09 13:00 已接單",
      "2026/10/09 13:00 待匯款",
    ]);
  });

  it("聯絡店家只有電話(tel: 連結,查單不給 Email);沒電話就不顯示;頁面上沒有任何外部 http 連結", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, { ...B, store: { ...B.store, phone: null, return_policy: "收到 24 小時內\n拍照聯絡" } }]);
    const { container } = renderAt(`/market/orders/${TOKEN}`);
    const a = within(await screen.findByRole("region", { name: `市集測試 A 店 訂單 ${formatOrderNo(A.id)}` }));
    expect(a.getByRole("link", { name: "02-2345-6789" })).toHaveAttribute("href", "tel:02-2345-6789");
    const b = within(screen.getByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    expect(b.queryByText(/電話/)).toBeNull();
    expect(b.getByText(/收到 24 小時內/)).toHaveClass("whitespace-pre-line");
    expect(screen.queryByText(/Email:/)).toBeNull();
    const hrefs = [...container.querySelectorAll("a[href]")].map((el) => el.getAttribute("href"));
    expect(hrefs).toEqual(["tel:02-2345-6789"]);
  });

  it("離線時第一次載入:整頁「目前離線」(一個 h1),不說找不到;連線後自動載入", async () => {
    onlineManager.setOnline(false);
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A]);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByRole("heading", { level: 1, name: "目前離線" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /找不到這筆訂單/ })).toBeNull();
    expect(document.title).toBe("目前離線｜iFoodmap 食材市集");
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText("有機高麗菜")).toBeInTheDocument();
  });

  it("沒辦法自動複製(瀏覽器沒有 navigator.clipboard):請消費者手動複製(電腦沒有長按:直接選好網址),不會整個沒反應", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A]);
    renderAt(`/market/orders/${TOKEN}?new=1`);
    await userEvent.click(await screen.findByRole("button", { name: "複製連結" }));
    expect(await screen.findByText("沒辦法自動複製,請選取上面的網址手動複製(手機可以長按網址)。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "訂單查詢網址" })).toHaveFocus();
  });

  it("剛下單的提示顯示後拿掉網址的 ?new=1(加入書籤不會每次都顯示「已送出」),提示照樣留在畫面上、不重抓", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}?new=1`);
    expect(await screen.findByText(/訂單已送出,共 2 張/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(`/market/orders/${TOKEN}`));
    expect(screen.getByText(/訂單已送出,共 2 張/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "訂單查詢網址" })).toHaveValue(`${window.location.origin}/market/orders/${TOKEN}`);
    expect(fetchOrdersByToken).toHaveBeenCalledTimes(1);
  });

  it("明細的金額欄一律不換行(360px 寬時粗體的總額不會被拆成「NT$」與數字兩行)", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A]);
    renderAt(`/market/orders/${TOKEN}`);
    const table = await screen.findByRole("table", { name: "訂單明細" });
    const amountCells = [...table.querySelectorAll("tbody td:last-child, tfoot td")];
    expect(amountCells.map((c) => c.textContent)).toEqual(["NT$ 200", "NT$ 650", "NT$ 120", "NT$ 770"]);
    for (const c of amountCells) expect(c).toHaveClass("whitespace-nowrap");
  });

  it("背景重抓失敗:繼續顯示之前載入的訂單,只加一行提示(不整頁變錯誤)", async () => {
    const client = newTestQueryClient();
    client.setQueryData(["market", "lookup", TOKEN], [A]);
    vi.mocked(fetchOrdersByToken).mockRejectedValue(new Error("network"));
    renderAt(`/market/orders/${TOKEN}`, client);
    expect(await screen.findByText(/更新失敗/)).toBeInTheDocument();
    expect(screen.getByText("有機高麗菜")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MarketOrderLookupPage:72 小時自動取消的期限", () => {
  it("待接單:說店家 72 小時內沒接單會自動取消,附期限(下單時間 + 72 小時,台北時間)", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const a = within(await screen.findByRole("region", { name: `市集測試 A 店 訂單 ${formatOrderNo(A.id)}` }));
    // 下單 2026-10-09T04:05Z → 期限 2026-10-12T04:05Z = 台北 10/12 12:05
    expect(a.getByText("店家 72 小時內沒有接單,訂單會自動取消(期限 10/12 12:05)")).toBeInTheDocument();
    expect(a.queryByText(/前完成匯款/)).toBeNull();
  });

  it("待匯款:在匯款資訊裡寫期限(最後一筆「待匯款」紀錄 + 72 小時);不寫待接單那句", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = within(await screen.findByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    // 待匯款紀錄 2026-10-09T05:00Z → 期限 2026-10-12T05:00Z = 台北 10/12 13:00
    const note = b.getByText("請在 10/12 13:00 前完成匯款,逾期訂單會自動取消");
    const box = b.getByText("店家已接單,請匯款 NT$ 260:").parentElement as HTMLElement;
    expect(box).toContainElement(note);
    expect(box).toHaveTextContent("帳號 0001234-5678901");
    expect(b.queryByText(/小時內沒有接單/)).toBeNull();
  });

  it("待匯款但沒有匯款資訊(店家刪了轉帳資訊):期限照樣寫在單上", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([{ ...B, transfer_info: null }]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = within(await screen.findByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    expect(b.getByText("請在 10/12 13:00 前完成匯款,逾期訂單會自動取消")).toBeInTheDocument();
    expect(b.queryByText(/店家已接單,請匯款/)).toBeNull();
  });

  it("其他狀態不寫自動取消", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([
      base({ status: "confirmed" }),
      base({ id: "a9600000-0000-4000-8000-0000000000c2", status: "paid", payment_method: "transfer" }),
      base({ id: "a9600000-0000-4000-8000-0000000000c3", status: "cancelled", status_note: "店家超過 72 小時沒有接單,系統自動取消" }),
    ]);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByText("原因:店家超過 72 小時沒有接單,系統自動取消")).toBeInTheDocument();
    expect(screen.queryByText(/訂單會自動取消/)).toBeNull();
    expect(screen.queryByText(/逾期訂單會自動取消/)).toBeNull();
  });
});

describe("MarketOrderLookupPage:過了自動取消的期限、排程還沒跑到", () => {
  // A:待接單,下單 2026-10-09T04:05Z → 期限 2026-10-12T04:05Z;B:待匯款,待匯款紀錄 2026-10-09T05:00Z → 期限 2026-10-12T05:00Z
  const clockAt = (iso: string, tick = false) => {
    // 檔案開頭的 beforeEach 已經換過 Date;vitest 換第二次時不會套用新的 toFake,要先換回真的再換
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: tick ? ["Date", "setInterval", "clearInterval"] : ["Date"] });
    vi.setSystemTime(new Date(iso));
  };
  const regionOf = async (o: LookupOrder) => within(await screen.findByRole("region", { name: `${o.store.name} 訂單 ${formatOrderNo(o.id)}` }));
  const EXPIRED = "已超過匯款期限,訂單即將自動取消,請不要再匯款。如果已經匯款,請直接聯絡店家";

  it.each([
    ["剛好到期", "2026-10-12T04:05:00Z"],
    ["過期 30 分鐘", "2026-10-12T04:35:00Z"],
  ])("待接單%s:改寫「訂單即將自動取消」,不再寫期限", async (_label, now) => {
    clockAt(now);
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A]);
    renderAt(`/market/orders/${TOKEN}`);
    const a = await regionOf(A);
    expect(a.getByText("店家超過 72 小時沒有接單,訂單即將自動取消")).toBeInTheDocument();
    expect(a.queryByText(/期限/)).toBeNull();
  });

  it.each([
    ["剛好到期", "2026-10-12T05:00:00Z"],
    ["過期 30 分鐘", "2026-10-12T05:30:00Z"],
  ])("待匯款%s:收起匯款帳號(DOM 裡完全沒有),改請消費者不要再匯款、已經匯款就聯絡店家(附電話)", async (_label, now) => {
    clockAt(now);
    vi.mocked(fetchOrdersByToken).mockResolvedValue([B]);
    const { container } = renderAt(`/market/orders/${TOKEN}`);
    const b = await regionOf(B);
    const warning = b.getByText(/已超過匯款期限/);
    expect(warning).toHaveTextContent(`${EXPIRED},電話 02-2345-6789。`);
    expect(within(warning).getByRole("link", { name: "02-2345-6789" })).toHaveAttribute("href", "tel:02-2345-6789");
    // 電話號碼不要在「-」那裡斷成兩行(390px 實測會斷)
    expect(within(warning).getByRole("link", { name: "02-2345-6789" })).toHaveClass("whitespace-nowrap");
    expect(container.textContent).not.toContain("0001234-5678901");
    expect(container.textContent).not.toContain("郵局");
    expect(container.innerHTML).not.toContain("0001234-5678901");
    expect(b.queryByText(/店家已接單,請匯款/)).toBeNull();
    expect(b.queryByText(/前完成匯款/)).toBeNull();
  });

  it("待匯款到期前 1 分鐘:照樣給匯款資訊與期限(過了才收)", async () => {
    clockAt("2026-10-12T04:59:00Z");
    vi.mocked(fetchOrdersByToken).mockResolvedValue([B]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = await regionOf(B);
    expect(b.getByText(/帳號 0001234-5678901/)).toBeInTheDocument();
    expect(b.getByText("請在 10/12 13:00 前完成匯款,逾期訂單會自動取消")).toBeInTheDocument();
    expect(b.queryByText(/已超過匯款期限/)).toBeNull();
  });

  it("待匯款過期、店家沒有電話:照樣請消費者聯絡店家,不留空的電話", async () => {
    clockAt("2026-10-12T05:30:00Z");
    vi.mocked(fetchOrdersByToken).mockResolvedValue([{ ...B, store: { ...B.store, phone: null } }]);
    const { container } = renderAt(`/market/orders/${TOKEN}`);
    const b = await regionOf(B);
    expect(b.getByText(/已超過匯款期限/)).toHaveTextContent(`${EXPIRED}。`);
    expect(b.queryByText(/電話/)).toBeNull();
    expect(container.textContent).not.toContain("0001234-5678901");
  });

  it("頁面開著時過了期限:下一分鐘就收起匯款帳號(每分鐘更新的時鐘)", async () => {
    clockAt("2026-10-12T04:59:30Z", true);
    vi.mocked(fetchOrdersByToken).mockResolvedValue([B]);
    const { container } = renderAt(`/market/orders/${TOKEN}`);
    const b = await regionOf(B);
    expect(b.getByText(/帳號 0001234-5678901/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(b.getByText(/已超過匯款期限/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("0001234-5678901");
  });
});
