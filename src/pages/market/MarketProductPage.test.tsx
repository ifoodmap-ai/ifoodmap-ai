// /market/p/:productId:商品資訊、店家卡、照片切換;沒上架的顯示預覽;找不到、壞網址。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchMarketProduct: vi.fn(),
}));

import { fetchMarketProduct } from "@/lib/market/catalog";
import { CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import MarketProductPage from "./MarketProductPage";
import { renderMarketRoute } from "./testUtils";

const PHOTO = (n: number) =>
  `${STORE_A.supplier_id}/${CABBAGE.id}/a9900000-0000-4000-8000-00000000000${n}.jpg`;
const renderAt = (id: string) => renderMarketRoute(`/market/p/${id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }]);

afterEach(cleanup);

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
    expect(screen.queryByRole("status")).toBeNull();
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

  it("還沒上架(供應商預覽自己的商品)顯示預覽提示", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, review_status: "pending" });
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("status")).toHaveTextContent("預覽:消費者目前看不到這個商品(審核狀態:待審)");
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

  it("找不到商品、網址不是 uuid 都顯示找不到", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(null);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { name: "找不到這個商品,可能已經下架了。" })).toBeInTheDocument();
    cleanup();
    renderAt("not-a-uuid");
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});
