// /market 首頁:列商品與精選店家;分類、縣市、溫層、搜尋都會改網址並篩掉不符合的;空狀態與錯誤。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchListedProducts: vi.fn(),
}));

import { fetchListedProducts } from "@/lib/market/catalog";
import { BEEF, CABBAGE, SALMON, STORE_A } from "@/lib/market/testFixtures";
import MarketHomePage from "./MarketHomePage";
import { renderMarketRoute } from "./testUtils";

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
});
