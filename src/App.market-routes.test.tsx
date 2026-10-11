// 主站(前台)路由表:/market 底下的頁面掛在 MarketLayout 裡、免登入;市集裡打錯網址顯示市集自己的找不到頁。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchListedProducts: vi.fn().mockResolvedValue([]),
}));

import App from "./App";

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(<App />);
};

describe("市集路由(前台站)", () => {
  it("/market 是市集首頁,包在市集版面裡(有跳到主要內容)", async () => {
    renderAt("/market");
    expect(await screen.findByRole("heading", { level: 1, name: "iFoodmap 食材市集" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
  });

  it("購物車、條款、隱私權政策都在市集版面裡", async () => {
    renderAt("/market/cart");
    expect(await screen.findByText("購物車是空的。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
    cleanup();
    renderAt("/market/terms");
    expect(await screen.findByRole("heading", { level: 1, name: "食材市集服務條款" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
    cleanup();
    renderAt("/market/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "食材市集隱私權政策" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
  });

  it("結帳、訂單查詢也在市集版面裡(購物車是空的、token 格式不對都不會落到市集的找不到頁)", async () => {
    renderAt("/market/checkout");
    expect(await screen.findByRole("heading", { level: 1, name: "結帳" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
    cleanup();
    renderAt("/market/orders/short");
    expect(await screen.findByRole("heading", { level: 1, name: /找不到這筆訂單/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "找不到這個頁面。" })).toBeNull();
  });

  it("/market 底下打錯的網址顯示市集的找不到頁,不是全站 NotFound", async () => {
    renderAt("/market/nope/123");
    expect(await screen.findByRole("heading", { name: "找不到這個頁面。" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});
