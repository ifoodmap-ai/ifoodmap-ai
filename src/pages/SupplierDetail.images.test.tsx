// 公開供應商頁(餐廳瀏覽供應商商品的頁面):有上傳商品圖片就顯示縮圖,沒有或載入失敗就退回分類色塊。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { createMemoryStorage } from "@/test/memory-storage";
import SupplierDetail from "./SupplierDetail";

const SUP = "10000000-0000-0000-0000-00000000000a";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const TABLES: Record<string, unknown> = {
  suppliers: { id: SUP, name: "鮮綠農產", description: "葉菜", contact_email: null, phone: null, service_areas: [], is_active: true },
  supplies: [
    { id: "p-1", supplier_id: SUP, name: "高麗菜", category: "蔬菜", unit: "kg", pack_size: null, price: 45, currency: "TWD", description: null, is_available: true, image_path: `${SUP}/p-1/${FILE}.jpg` },
    { id: "p-2", supplier_id: SUP, name: "洋蔥", category: "蔬菜", unit: "kg", pack_size: null, price: 38, currency: "TWD", description: null, is_available: true, image_path: null },
  ],
  supplier_reviews: [],
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const result = () => ({ data: TABLES[table] ?? [], error: null });
      const b = {
        select: () => b, eq: () => b, order: () => b, insert: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result()).then(a, r),
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: null } }) },
  },
}));

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LanguageProvider>
        <MemoryRouter initialEntries={[`/supplier/${SUP}`]}>
          <Routes><Route path="/supplier/:id" element={<SupplierDetail />} /></Routes>
        </MemoryRouter>
      </LanguageProvider>
    </QueryClientProvider>,
  );

const cardOf = async (name: string) => {
  const heading = await screen.findByRole("heading", { name });
  return heading.closest(".overflow-hidden") as HTMLElement;
};

describe("SupplierDetail — 商品圖片", () => {
  it("有上傳圖片的商品顯示縮圖(lazy);沒有圖片的維持分類色塊", async () => {
    renderPage();

    const withImage = await cardOf("高麗菜");
    const img = within(withImage).getByRole("img", { name: "高麗菜" });
    expect(img.getAttribute("src")).toContain(`/market-images/${SUP}/p-1/${FILE}_t.jpg`);
    expect(img).toHaveAttribute("loading", "lazy");

    const without = await cardOf("洋蔥");
    expect(within(without).queryByRole("img")).toBeNull();
    // 分類字樣出現兩次:色塊上一次、商品說明一次;有圖片的卡片只有說明那一次
    expect(within(without).getAllByText("蔬菜")).toHaveLength(2);
    expect(within(withImage).getAllByText("蔬菜")).toHaveLength(1);
  });

  it("圖片載入失敗時退回分類色塊,不留破圖", async () => {
    renderPage();
    const card = await cardOf("高麗菜");
    fireEvent.error(within(card).getByRole("img", { name: "高麗菜" }));

    expect(within(card).queryByRole("img")).toBeNull();
    expect(within(card).getAllByText("蔬菜")).toHaveLength(2);
  });
});
