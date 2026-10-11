// /market/p/:productId:商品資訊、店家卡、照片切換;沒上架的顯示預覽;找不到、壞網址。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchMarketProduct: vi.fn(),
}));

import { fetchMarketProduct } from "@/lib/market/catalog";
import { CABBAGE, SALMON, STORE_A } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import { createMemoryStorage } from "@/test/memory-storage";
import MarketProductPage from "./MarketProductPage";
import { renderMarketRoute } from "./testUtils";
// 檔尾「離線與背景重抓失敗」那組測試用。分開寫、不併進上面幾行:第 2 階段 Task 46 會在上面那幾行做「找到 → 換成」
import { act } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { newTestQueryClient } from "./testUtils";

const PHOTO = (n: number) =>
  `${STORE_A.supplier_id}/${CABBAGE.id}/a9900000-0000-4000-8000-00000000000${n}.jpg`;
const renderAt = (id: string) => renderMarketRoute(`/market/p/${id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }]);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketProductPage", () => {
  it("品名、規格、價格、溫層、庫存、產地,店家卡連到店家頁", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { level: 1, name: "有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByText("NT$ 100")).toBeInTheDocument();
    expect(screen.getByText("冷藏・現貨")).toBeInTheDocument();
    expect(screen.getByText("宜蘭三星")).toBeInTheDocument();
    const card = screen.getByRole("complementary");
    expect(within(card).getByRole("link", { name: "市集測試 A 店" })).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
    expect(within(card).getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "麵包屑" })).toHaveTextContent("市集›蔬菜›有機高麗菜");
    expect(screen.queryByText(/預覽:/)).toBeNull();
    expect(document.title).toBe("有機高麗菜｜iFoodmap 食材市集");
  });

  it("多張照片可以切換", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, photos: [PHOTO(1), PHOTO(2)] });
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("img", { name: "有機高麗菜 照片 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看第 2 張照片" }));
    expect(screen.getByRole("img", { name: "有機高麗菜 照片 2" }).getAttribute("src")).toContain(PHOTO(2));
    expect(screen.getByRole("button", { name: "看第 2 張照片" })).toHaveAttribute("aria-pressed", "true");
  });

  it("還沒上架(供應商預覽自己的商品)顯示預覽提示,不能加入購物車", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, review_status: "pending" });
    renderAt(CABBAGE.id);
    expect(await screen.findByText(/預覽:消費者目前看不到這個商品/)).toHaveTextContent("預覽:消費者目前看不到這個商品(審核狀態:待審)");
    expect(screen.queryByRole("button", { name: "加入購物車" })).toBeNull();
  });

  it("加入購物車:選數量、存進購物車、告訴使用者已加入", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    const stepper = await screen.findByRole("group", { name: "有機高麗菜 數量" });
    await userEvent.click(within(stepper).getByRole("button", { name: "增加一件" }));
    await userEvent.click(screen.getByRole("button", { name: "加入購物車" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
    expect(screen.getByText(/已加入購物車/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看購物車" })).toHaveAttribute("href", "/market/cart");
  });

  it("數量上限是庫存(鮭魚剩 3 件);已售完不能按", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(SALMON);
    renderAt(SALMON.id);
    const stepper = await screen.findByRole("group", { name: "挪威鮭魚 數量" });
    const plus = within(stepper).getByRole("button", { name: "增加一件" });
    await userEvent.click(plus);
    await userEvent.click(plus);
    expect(within(stepper).getByRole("spinbutton", { name: "數量" })).toHaveValue(3);
    expect(plus).toBeDisabled();
    cleanup();
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...SALMON, stock: 0 });
    renderAt(SALMON.id);
    expect(await screen.findByRole("button", { name: "已售完" })).toBeDisabled();
  });

  it("載入失敗:有 h1、重新載入(重抓)與回市集首頁", async () => {
    vi.mocked(fetchMarketProduct).mockRejectedValueOnce(new Error("network")).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { level: 1, name: "商品載入失敗" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("請檢查網路後再試一次");
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByRole("heading", { level: 1, name: "有機高麗菜" })).toBeInTheDocument();
  });

  it("分頁標題跟畫面一致:找不到(含網址壞掉)是「找不到商品」、載入失敗是「商品載入失敗」", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(null);
    renderAt(CABBAGE.id);
    await screen.findByRole("heading", { name: "找不到這個商品,可能已經下架了。" });
    expect(document.title).toBe("找不到商品｜iFoodmap 食材市集");
    cleanup();
    document.title = "";
    renderAt("not-a-uuid");
    expect(document.title).toBe("找不到商品｜iFoodmap 食材市集");
    cleanup();
    vi.mocked(fetchMarketProduct).mockRejectedValue(new Error("network"));
    renderAt(CABBAGE.id);
    await screen.findByRole("heading", { level: 1, name: "商品載入失敗" });
    expect(document.title).toBe("商品載入失敗｜iFoodmap 食材市集");
  });

  it("找不到商品、網址不是 uuid 都顯示找不到", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(null);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { name: "找不到這個商品,可能已經下架了。" })).toBeInTheDocument();
    cleanup();
    renderAt("not-a-uuid");
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});

describe("MarketProductPage:縮圖列的焦點框", () => {
  it("縮圖列(橫向捲動)四周留出焦點框的空間,捲到邊緣時也留 scroll-padding", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, photos: [PHOTO(1), PHOTO(2)] });
    renderAt(CABBAGE.id);
    const row = (await screen.findByRole("button", { name: "看第 1 張照片" })).parentElement as HTMLElement;
    // overflow-x-auto 會讓 overflow-y 也變成 auto:按鈕外 4px 的焦點框(ring-2 + ring-offset-2)會被切掉
    expect(row).toHaveClass("overflow-x-auto");
    expect(row.className).toMatch(/(^|\s)p-(1|1\.5|2)(\s|$)/);
    expect(row.className).toMatch(/(^|\s)scroll-px-\S+/);
  });

  it("縮圖得到焦點時整顆捲進可見範圍(5 張時最後一張在手機上只露出一半)", async () => {
    const original = Element.prototype.scrollIntoView; // jsdom 沒有這個方法
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, photos: [PHOTO(1), PHOTO(2)] });
      renderAt(CABBAGE.id);
      (await screen.findByRole("button", { name: "看第 2 張照片" })).focus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("MarketProductPage:離線與背景重抓失敗", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("離線時第一次載入:整頁離線提示(一個 h1),不說找不到;連線後自動載入", async () => {
    onlineManager.setOnline(false);
    vi.mocked(fetchMarketProduct).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { level: 1, name: "目前離線" })).toBeInTheDocument();
    expect(screen.getByText("連線後會自動重新載入。")).toBeInTheDocument();
    expect(screen.queryByText("找不到這個商品,可能已經下架了。")).toBeNull();
    expect(document.title).toBe("目前離線｜iFoodmap 食材市集");
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByRole("heading", { level: 1, name: "有機高麗菜" })).toBeInTheDocument();
  });

  it("背景重抓失敗但已經有這個商品:繼續顯示商品,加一行提示與重新載入", async () => {
    const client = newTestQueryClient();
    client.setQueryData(["market", "product", CABBAGE.id], CABBAGE);
    vi.mocked(fetchMarketProduct).mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ...CABBAGE, price: 120 });
    renderMarketRoute(`/market/p/${CABBAGE.id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }], client);
    const notice = await screen.findByText(/更新失敗/);
    expect(screen.getByRole("heading", { level: 1, name: "有機高麗菜" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "商品載入失敗" })).toBeNull();
    expect(document.title).toBe("有機高麗菜｜iFoodmap 食材市集");
    await userEvent.click(within(notice).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByText("NT$ 120")).toBeInTheDocument();
    expect(screen.queryByText(/更新失敗/)).toBeNull();
  });
});
