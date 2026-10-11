// /market/checkout:欄位驗證(錯誤在欄位旁、焦點移過去)、配送縣市決定哪些店能結帳、付款方式、送出內容、成功導到查詢頁、失敗訊息。
// 檔尾另外釘住:錯誤訊息一律用 checkout.ts 的對照、離線 / 載入失敗不顯示表單、已下架的商品要讓人看到、店家不收的付款方式不會送出去。
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchProductsByIds: vi.fn(),
}));
vi.mock("@/lib/market/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/checkout")>()),
  fetchCheckoutStatus: vi.fn(),
  placeOrder: vi.fn(),
}));

import { fetchProductsByIds } from "@/lib/market/catalog";
import { checkoutErrorMessage, fetchCheckoutStatus, placeOrder } from "@/lib/market/checkout";
import { TERMS_VERSION } from "@/lib/market/legal";
import { BEEF, CABBAGE, SALMON, STORE_A, SUPPLIER_A, SUPPLIER_B } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import MarketCheckoutPage from "./MarketCheckoutPage";
import { newTestQueryClient, renderMarketRoute } from "./testUtils";

const TOKEN = `tok_${"x".repeat(39)}`;
const renderCheckout = () =>
  renderMarketRoute("/market/checkout", [
    { path: "/market/checkout", element: <MarketCheckoutPage /> },
    { path: "/market/orders/:token", element: <p>查詢頁</p> },
  ]);

const fill = async (city = "臺北市") => {
  await userEvent.type(await screen.findByLabelText("收件人姓名"), "王小明");
  await userEvent.type(screen.getByLabelText("電話"), "0912-345-678");
  await userEvent.type(screen.getByLabelText(/^Email/), "buyer@example.com");
  await userEvent.selectOptions(screen.getByLabelText("收件縣市"), city);
  await userEvent.type(screen.getByLabelText(/^收件地址/), "測試路 1 號 2 樓");
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
  cartStore.add(CABBAGE.id, 2);
  cartStore.add(BEEF.id, 1);
  cartStore.add(SALMON.id, 1);
  // mockReset:上一個測試沒用完的 mockResolvedValueOnce 不會留到這個測試(clearMocks 只清呼叫紀錄)
  vi.mocked(fetchProductsByIds).mockReset().mockResolvedValue([CABBAGE, BEEF, SALMON]);
  vi.mocked(fetchCheckoutStatus).mockReset().mockResolvedValue({ open: true, can_order: true });
  vi.mocked(placeOrder).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketCheckoutPage", () => {
  it("什麼都沒填就送出:每個欄位旁顯示錯誤、標 aria-invalid、焦點到第一個欄位;不會下單", async () => {
    renderCheckout();
    await userEvent.click(await screen.findByRole("button", { name: /送出訂單/ }));
    const name = screen.getByLabelText("收件人姓名");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("請填寫收件人姓名");
    expect(name).toHaveFocus();
    expect(screen.getByLabelText("電話")).toHaveAccessibleDescription("請填寫手機或市話,例如 0912345678 或 02-2345-6789");
    expect(screen.getByLabelText("收件縣市")).toHaveAccessibleDescription("請選擇收件縣市");
    expect(screen.getByText("請先勾選同意服務條款與隱私權政策")).toBeInTheDocument();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("沒勾同意條款:焦點到勾選框,不會下單", async () => {
    renderCheckout();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
    expect(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" })).toHaveFocus();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("條款連結另開分頁", async () => {
    renderCheckout();
    expect(await screen.findByRole("link", { name: "服務條款" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "隱私權政策" })).toHaveAttribute("href", "/market/privacy");
  });

  it("收件縣市不在 B 店配送範圍:B 店列在「這次不能結帳」,只結 A 店", async () => {
    renderCheckout();
    await fill("新北市");
    const blocked = screen.getByRole("region", { name: "這次不能結帳的店家(商品會留在購物車)" });
    expect(within(blocked).getByRole("listitem")).toHaveTextContent("市集測試 B 店:這家店不配送到新北市");
    expect(screen.getByRole("region", { name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送出訂單(NT$ 770)" })).toBeInTheDocument();
  });

  it("成功:送出伺服器要的內容;結帳的商品從購物車拿掉;帶 token 進查詢頁", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill();
    const a = within(screen.getByRole("region", { name: "市集測試 A 店" }));
    await userEvent.click(a.getByRole("radio", { name: "銀行轉帳" }));
    expect(a.getByText("店家接單後,訂單查詢頁會顯示匯款帳號,也會寄信通知你。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    await userEvent.click(screen.getByRole("button", { name: "送出訂單(NT$ 1,030)" }));
    expect(placeOrder).toHaveBeenCalledWith({
      buyer: { name: "王小明", phone: "0912345678", email: "buyer@example.com", city: "臺北市", address: "測試路 1 號 2 樓" },
      items: [
        { product_id: CABBAGE.id, qty: 2 },
        { product_id: BEEF.id, qty: 1 },
        { product_id: SALMON.id, qty: 1 },
      ],
      payments: { [SUPPLIER_A]: "transfer", [SUPPLIER_B]: "cod" },
      expected_totals: { [SUPPLIER_A]: 770, [SUPPLIER_B]: 260 },
      terms_version: TERMS_VERSION,
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/market/orders/${TOKEN}?new=1`));
    expect(cartStore.get()).toEqual([]);
  });

  it("只結一部分的店:沒結的商品留在購物車", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill("新北市");
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    await userEvent.click(screen.getByRole("button", { name: "送出訂單(NT$ 770)" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/market/orders/${TOKEN}`));
    expect(cartStore.get()).toEqual([{ productId: SALMON.id, qty: 1 }]);
  });

  it("價格變了(PRICE_CHANGED):顯示說明、重新抓商品,不離開這頁", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: false, code: "PRICE_CHANGED", stores: [{ supplier_id: SUPPLIER_A }] });
    renderCheckout();
    await fill();
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    const calls = vi.mocked(fetchProductsByIds).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("價格或運費剛剛有變動");
    await waitFor(() => expect(vi.mocked(fetchProductsByIds).mock.calls.length).toBeGreaterThan(calls));
    expect(screen.getByTestId("location")).toHaveTextContent("/market/checkout");
    expect(cartStore.get()).toHaveLength(3);
  });

  it("下單還沒對外開放:不顯示表單", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: false });
    renderCheckout();
    expect(await screen.findByText("線上訂購還沒對外開放,購物車會幫你保留。")).toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).toBeNull();
  });
});

describe("MarketCheckoutPage:錯誤對照、離線與載入失敗、下架商品、付款方式", () => {
  afterEach(() => onlineManager.setOnline(true));

  const agreeAndSubmit = async () => {
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
  };

  it("伺服器擋下(例如 ORDER_TOO_LARGE):顯示的就是 checkout.ts 對照出來的那一句,不離開這頁、購物車不動", async () => {
    const result = { ok: false as const, code: "ORDER_TOO_LARGE", stores: [{ supplier_id: SUPPLIER_A }] };
    vi.mocked(placeOrder).mockResolvedValue(result);
    renderCheckout();
    await fill();
    await agreeAndSubmit();
    const names: Record<string, string> = { [SUPPLIER_A]: "市集測試 A 店", [SUPPLIER_B]: "市集測試 B 店" };
    expect(await screen.findByRole("alert")).toHaveTextContent(checkoutErrorMessage(result, (id) => names[id]));
    expect(screen.getByTestId("location")).toHaveTextContent("/market/checkout");
    expect(cartStore.get()).toHaveLength(3);
  });

  it("離線時第一次載入:整頁離線提示(一個 h1),不顯示金額是 0 的表單;連線後自動顯示表單", async () => {
    onlineManager.setOnline(false);
    renderCheckout();
    expect(await screen.findByRole("heading", { level: 1, name: "目前離線" })).toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).toBeNull();
    expect(screen.queryByRole("button", { name: /送出訂單/ })).toBeNull();
    expect(document.title).toBe("目前離線｜iFoodmap 食材市集");
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByLabelText("收件人姓名")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送出訂單(NT$ 1,030)" })).toBeInTheDocument();
  });

  it("商品資料載入失敗:整頁錯誤(h1)與重新載入,不顯示表單;重新載入成功就顯示表單", async () => {
    vi.mocked(fetchProductsByIds).mockRejectedValueOnce(new Error("network"));
    renderCheckout();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1, name: "商品資料載入失敗" })).toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByLabelText("收件人姓名")).toBeInTheDocument();
  });

  it("購物車裡有已下架的商品:列在「這次不能結帳」裡,送出內容不含它,結帳後它留在購物車", async () => {
    vi.mocked(fetchProductsByIds).mockResolvedValue([CABBAGE, BEEF]);
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill();
    const blocked = screen.getByRole("region", { name: "這次不能結帳的店家(商品會留在購物車)" });
    expect(within(blocked).getByRole("listitem")).toHaveTextContent("1 項商品已下架或暫停販售,這次不會結帳");
    expect(within(blocked).getByRole("link", { name: "回購物車修改" })).toHaveAttribute("href", "/market/cart");
    expect(screen.getByRole("button", { name: "送出訂單(NT$ 770)" })).toBeInTheDocument();
    await agreeAndSubmit();
    expect(vi.mocked(placeOrder).mock.calls[0][0].items).toEqual([
      { product_id: CABBAGE.id, qty: 2 },
      { product_id: BEEF.id, qty: 1 },
    ]);
    expect(vi.mocked(placeOrder).mock.calls[0][0].payments).toEqual({ [SUPPLIER_A]: "cod" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/market/orders/${TOKEN}?new=1`));
    expect(cartStore.get()).toEqual([{ productId: SALMON.id, qty: 1 }]);
  });

  it("選了銀行轉帳、店家剛好不收了(PAYMENT_NOT_ACCEPTED 後重抓):畫面選回店家接受的方式,再送出就送那一種", async () => {
    const codOnly = { ...STORE_A, payment_methods: ["cod" as const] };
    vi.mocked(fetchProductsByIds)
      .mockResolvedValueOnce([CABBAGE, BEEF, SALMON])
      .mockResolvedValue([{ ...CABBAGE, market_stores: codOnly }, { ...BEEF, market_stores: codOnly }, SALMON]);
    vi.mocked(placeOrder)
      .mockResolvedValueOnce({ ok: false, code: "PAYMENT_NOT_ACCEPTED", stores: [SUPPLIER_A] })
      .mockResolvedValueOnce({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill();
    await userEvent.click(within(screen.getByRole("region", { name: "市集測試 A 店" })).getByRole("radio", { name: "銀行轉帳" }));
    await agreeAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("市集測試 A 店 不接受你選的付款方式");
    const a = within(screen.getByRole("region", { name: "市集測試 A 店" }));
    await waitFor(() => expect(a.queryByRole("radio", { name: "銀行轉帳" })).toBeNull());
    expect(a.getByRole("radio", { name: "貨到付款" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(vi.mocked(placeOrder).mock.calls[1][0].payments).toEqual({ [SUPPLIER_A]: "cod", [SUPPLIER_B]: "cod" });
  });

  it("每個欄位都有 autocomplete(備註沒有對應的自動填入,明講 off)", async () => {
    renderCheckout();
    expect(await screen.findByLabelText("收件人姓名")).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText("電話")).toHaveAttribute("autocomplete", "tel");
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("收件縣市")).toHaveAttribute("autocomplete", "address-level1");
    expect(screen.getByLabelText(/^收件地址/)).toHaveAttribute("autocomplete", "street-address");
    expect(screen.getByLabelText(/^備註/)).toHaveAttribute("autocomplete", "off");
  });

  it("下單開關查不到:表單照樣顯示但先講沒辦法確認,可以重新確認;確認是關著就換成還沒開放的說明", async () => {
    vi.mocked(fetchCheckoutStatus).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ open: false, can_order: false });
    renderCheckout();
    expect(await screen.findByText("沒辦法確認線上訂購是否開放,請檢查網路;送出訂單時會再確認一次。")).toBeInTheDocument();
    expect(screen.getByLabelText("收件人姓名")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新確認" }));
    expect(await screen.findByText(checkoutErrorMessage({ ok: false, code: "MARKET_CLOSED" }, () => ""))).toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).toBeNull();
  });

  it("送出時才知道還沒開放(MARKET_CLOSED):重新確認開關,表單換成還沒開放的說明;購物車不動", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValueOnce({ open: true, can_order: true }).mockResolvedValue({ open: false, can_order: false });
    vi.mocked(placeOrder).mockResolvedValue({ ok: false, code: "MARKET_CLOSED" });
    renderCheckout();
    await fill();
    await agreeAndSubmit();
    await waitFor(() => expect(screen.queryByLabelText("收件人姓名")).toBeNull());
    expect(screen.getByText(checkoutErrorMessage({ ok: false, code: "MARKET_CLOSED" }, () => ""))).toBeInTheDocument();
    expect(fetchCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(cartStore.get()).toHaveLength(3);
  });

  it("成功後用 replace 進查詢頁:按上一頁回到結帳之前那一頁,不會回到已經送出的結帳頁", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    const Back = () => {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(-1)}>
          上一頁
        </button>
      );
    };
    render(
      <QueryClientProvider client={newTestQueryClient()}>
        <MemoryRouter initialEntries={["/market/cart", "/market/checkout"]} initialIndex={1}>
          <Routes>
            <Route path="/market/cart" element={<p>購物車頁</p>} />
            <Route path="/market/checkout" element={<MarketCheckoutPage />} />
            <Route path="/market/orders/:token" element={<Back />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await fill();
    await agreeAndSubmit();
    await userEvent.click(await screen.findByRole("button", { name: "上一頁" }));
    expect(await screen.findByText("購物車頁")).toBeInTheDocument();
  });
});
