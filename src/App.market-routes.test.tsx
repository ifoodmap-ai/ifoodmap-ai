// 主站(前台)路由表:/market 底下三頁掛在 MarketLayout 裡、免登入;市集裡打錯網址顯示市集自己的找不到頁。
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

  it("/market 底下打錯的網址顯示市集的找不到頁,不是全站 NotFound", async () => {
    renderAt("/market/nope/123");
    expect(await screen.findByRole("heading", { name: "找不到這個頁面。" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});
