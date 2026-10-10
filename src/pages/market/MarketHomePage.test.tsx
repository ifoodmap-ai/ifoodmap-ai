// /market 首頁:列商品與精選店家;分類、縣市、溫層、搜尋都會改網址並篩掉不符合的;空狀態與錯誤。
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchListedProducts: vi.fn(),
}));

import { fetchListedProducts } from "@/lib/market/catalog";
import { BEEF, CABBAGE, SALMON, STORE_A } from "@/lib/market/testFixtures";
import MarketHomePage from "./MarketHomePage";
import { newTestQueryClient, renderMarketRoute } from "./testUtils";

const renderHome = (path = "/market") => renderMarketRoute(path, [{ path: "/market", element: <MarketHomePage /> }]);
const productNames = () =>
  within(screen.getByRole("region", { name: "商品" }))
    .queryAllByRole("heading", { level: 3 })
    .map((h) => h.textContent);

beforeEach(() => {
  vi.mocked(fetchListedProducts).mockResolvedValue([CABBAGE, BEEF, SALMON]);
});
afterEach(cleanup);

describe("MarketHomePage", () => {
  it("一個 h1;列出商品、精選店家(商品多的在前)", async () => {
    renderHome();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await screen.findByText("共 3 項")).toBeInTheDocument();
    expect(productNames()).toEqual(["有機高麗菜", "牛肉片", "挪威鮭魚"]);
    const stores = within(screen.getByRole("region", { name: "精選店家" })).getAllByRole("link");
    expect(stores[0]).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
    expect(stores[0]).toHaveTextContent("市集測試 A 店");
    expect(stores[0]).toHaveTextContent("2 項商品");
  });

  it("點分類:只剩那一類,網址帶 ?cat=", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    await userEvent.click(screen.getByRole("button", { name: "肉品" }));
    expect(productNames()).toEqual(["牛肉片"]);
    expect(screen.getByTestId("location")).toHaveTextContent("/market?cat=meat");
  });

  it("選配送縣市:不配送到那裡的店家的商品不見", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    await userEvent.selectOptions(screen.getByLabelText("配送到哪"), "新北市");
    expect(productNames()).toEqual(["有機高麗菜", "牛肉片"]);
    expect(screen.getByText("共 2 項")).toBeInTheDocument();
  });

  it("溫層與搜尋", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    const temperature = within(screen.getByRole("group", { name: "溫層" }));
    await userEvent.click(temperature.getByRole("button", { name: "冷凍" }));
    expect(productNames()).toEqual(["牛肉片", "挪威鮭魚"]);
    expect(screen.getByTestId("location")).toHaveTextContent("temp=frozen");
    await userEvent.click(temperature.getByRole("button", { name: "全部" }));
    await userEvent.type(screen.getByLabelText("搜尋食材"), "鮭魚");
    expect(productNames()).toEqual(["挪威鮭魚"]);
  });

  it("網址帶篩選條件進來就套用", async () => {
    renderHome("/market?cat=seafood");
    expect(await screen.findByText("共 1 項")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "海鮮" })).toHaveAttribute("aria-pressed", "true");
  });

  it("沒有任何上架商品時說敬請期待;篩到沒有時提示換條件", async () => {
    vi.mocked(fetchListedProducts).mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText("市集還沒有上架的商品,敬請期待。")).toBeInTheDocument();
    cleanup();
    vi.mocked(fetchListedProducts).mockResolvedValue([CABBAGE]);
    renderHome("/market?cat=meat");
    expect(await screen.findByText("沒有符合條件的商品,換個分類或縣市看看。")).toBeInTheDocument();
  });

  it("載入失敗顯示錯誤與重新載入", async () => {
    vi.mocked(fetchListedProducts).mockRejectedValue(new Error("network"));
    renderHome();
    expect(await screen.findByRole("alert")).toHaveTextContent("商品載入失敗");
    expect(screen.getByRole("button", { name: "重新載入" })).toBeInTheDocument();
  });

  it("載入失敗時不顯示「共 0 項」(沒有載到不等於沒有商品)", async () => {
    vi.mocked(fetchListedProducts).mockRejectedValue(new Error("network"));
    renderHome();
    await screen.findByRole("alert");
    expect(screen.queryByText(/共 \d+ 項/)).toBeNull();
  });
});

describe("MarketHomePage:離線與背景重抓失敗", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("離線時第一次載入(React Query 暫停):顯示離線提示,不顯示空狀態與件數;連線後自動載入", async () => {
    onlineManager.setOnline(false);
    renderHome();
    expect(await screen.findByText("目前離線,連線後會自動重新載入。")).toBeInTheDocument();
    expect(screen.queryByText("市集還沒有上架的商品,敬請期待。")).toBeNull();
    expect(screen.queryByText(/共 \d+ 項/)).toBeNull();
    expect(fetchListedProducts).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText("共 3 項")).toBeInTheDocument();
    expect(screen.queryByText("目前離線,連線後會自動重新載入。")).toBeNull();
  });

  it("背景重抓失敗但手上有資料:繼續顯示,只加一行提示與重新載入(不整頁變錯誤)", async () => {
    const client = newTestQueryClient();
    client.setQueryData(["market", "products"], [CABBAGE]);
    vi.mocked(fetchListedProducts).mockRejectedValueOnce(new Error("network")).mockResolvedValue([CABBAGE, BEEF]);
    renderMarketRoute("/market", [{ path: "/market", element: <MarketHomePage /> }], client);
    const notice = await screen.findByText(/更新失敗/);
    expect(productNames()).toEqual(["有機高麗菜"]);
    expect(screen.getByText("共 1 項")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(within(notice).getByRole("button", { name: "重新載入" }));
    expect(await screen.findByText("共 2 項")).toBeInTheDocument();
    expect(screen.queryByText(/更新失敗/)).toBeNull();
  });
});
