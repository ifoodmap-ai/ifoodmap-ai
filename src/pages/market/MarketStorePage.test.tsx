// /market/s/:supplierId:店名、介紹、退換貨、配送條件、商品與分類篩選;停用的店與找不到的店。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchMarketStore: vi.fn(),
  fetchStoreProducts: vi.fn(),
}));

import { fetchMarketStore, fetchStoreProducts } from "@/lib/market/catalog";
import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import MarketStorePage from "./MarketStorePage";
import { renderMarketRoute } from "./testUtils";

const renderAt = (id: string) => renderMarketRoute(`/market/s/${id}`, [{ path: "/market/s/:supplierId", element: <MarketStorePage /> }]);

afterEach(cleanup);

describe("MarketStorePage", () => {
  it("店名、介紹、退換貨、配送條件與商品;只列這家店有的分類", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue(STORE_A);
    vi.mocked(fetchStoreProducts).mockResolvedValue([CABBAGE, BEEF]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { level: 1, name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.getByText("當日採收的葉菜與根莖類")).toBeInTheDocument();
    expect(screen.getByText("生鮮食品收到後 24 小時內有問題請拍照聯絡我們")).toBeInTheDocument();
    expect(screen.getByText("滿 NT$ 300 才能下單")).toBeInTheDocument();
    expect(await screen.findByText("共 2 項")).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "食材分類" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["全部", "蔬菜", "肉品"]);
    await userEvent.click(within(chips).getByRole("button", { name: "肉品" }));
    expect(screen.getByText("共 1 項")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /牛肉片/ })).toHaveAttribute("href", `/market/p/${BEEF.id}`);
  });

  it("店家零售停用(登入的店家自己看得到那一列)時顯示沒有開放", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue({ ...STORE_A, is_enabled: false });
    vi.mocked(fetchStoreProducts).mockResolvedValue([]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { name: "這家店目前沒有開放零售。" })).toBeInTheDocument();
  });

  it("找不到的店、壞網址", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue(null);
    vi.mocked(fetchStoreProducts).mockResolvedValue([]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { name: "這家店目前沒有開放零售。" })).toBeInTheDocument();
    cleanup();
    renderAt("abc");
    expect(screen.getByRole("heading", { name: "找不到這家店。" })).toBeInTheDocument();
  });
});
