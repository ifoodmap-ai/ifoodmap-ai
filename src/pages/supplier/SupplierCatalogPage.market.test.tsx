// 商品目錄頁多了「零售商品」分頁與每列的「開放零售」(設計:擴充 SupplierCatalogPage)。
// 驗證:①兩個分頁 ②批發商品列:沒有對應零售商品的出現「開放零售」,有的顯示零售狀態 ③開放零售打開視窗並帶入品名
// ④零售分頁列出自家零售商品 ⑤還沒建零售店家時「開放零售」停用。supabase 換成記憶體假資料。
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    supplies: [] as Record<string, unknown>[],
    marketProducts: [] as Record<string, unknown>[],
    hasStore: true,
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }) },
    from: (table: string) => {
      const result = () => {
        if (table === "supplier_accounts") return { data: { supplier_id: "a9200000-0000-4000-8000-00000000000a" }, error: null };
        if (table === "supplies") return { data: db.supplies, error: null };
        if (table === "market_products") return { data: db.marketProducts, error: null };
        if (table === "market_stores") return { data: db.hasStore ? { supplier_id: "a9200000-0000-4000-8000-00000000000a" } : null, error: null };
        return { data: [], error: null };
      };
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return b;
    },
  },
}));

import { CABBAGE } from "@/lib/market/testFixtures";
import SupplierCatalogPage from "./SupplierCatalogPage";

const SUPPLY = (id: string, name: string) => ({
  id,
  name,
  category: "蔬菜",
  sku: null,
  unit: "kg",
  pack_size: "10kg/箱",
  price: 300,
  currency: "TWD",
  description: null,
  is_available: true,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierCatalogPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  db.supplies = [SUPPLY("s-cabbage", "高麗菜"), SUPPLY("s-onion", "洋蔥")];
  db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "pending" }];
  db.hasStore = true;
});
afterEach(cleanup);

describe("SupplierCatalogPage — 零售市集", () => {
  it("兩個分頁;批發商品每列有零售狀態或「開放零售」", async () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "批發商品(給餐廳)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "零售商品(給消費者)" })).toBeInTheDocument();
    const cabbageRow = (await screen.findByText("高麗菜")).closest("tr") as HTMLElement;
    expect(within(cabbageRow).getByRole("button", { name: "待審" })).toBeInTheDocument();
    const onionRow = screen.getByText("洋蔥").closest("tr") as HTMLElement;
    expect(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" })).toBeEnabled();
  });

  it("「開放零售」打開零售商品視窗,品名與規格從批發商品帶入", async () => {
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    await userEvent.click(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "新增零售商品" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("品名 *")).toHaveValue("洋蔥");
    expect(within(dialog).getByLabelText("零售規格 *")).toHaveValue("10kg/箱");
    expect(within(dialog).getByLabelText("分類 *")).toHaveValue("vegetable");
  });

  it("零售分頁列出自家零售商品", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    expect(await screen.findByRole("button", { name: "編輯 有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增零售商品" })).toBeEnabled();
  });

  it("還沒建零售店家:「開放零售」停用", async () => {
    db.hasStore = false;
    db.marketProducts = [];
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    const button = await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" });
    expect(button).toBeDisabled();
  });
});
