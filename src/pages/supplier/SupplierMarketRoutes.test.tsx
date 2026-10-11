// 前台站(供應商後台)的零售市集路由:用 App.tsx 本身渲染,不是複製一份路由(同 AdminRoutes.test.tsx 的做法)。
// 新訂單通知信的「到後台查看」連結(market-notify handler 的 supplierOrdersUrl)要打得開零售訂單頁,
// 落在「零售市集」分區、「零售訂單」分頁;店家設定頁也還在。頁面元件換成空殼(testRouteStub),
// 版面(SupplierLayout)、守門(SupplierRoute)、分頁列都是真的;Supabase 是假的,不打任何網路。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { fakeSupabase } from "../admin/testFakeSupabase";

vi.mock("@/integrations/supabase/client", async () => ({
  supabase: (await import("../admin/testFakeSupabase")).fakeSupabase.client,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./SupplierMarketOrdersPage", async () => (await import("../admin/testRouteStub")).stubPage("SupplierMarketOrdersPage"));
vi.mock("./SupplierMarketStorePage", async () => (await import("../admin/testRouteStub")).stubPage("SupplierMarketStorePage"));

/** 通知信裡「到後台查看」的路徑,直接從 market-notify 的原始碼讀(handler.ts 是 Deno 程式,不直接 import) */
const HANDLER = readFileSync(resolve(__dirname, "../../../supabase/functions/market-notify/handler.ts"), "utf8");
const MAIL_ORDERS_PATH = /supplierOrdersUrl: `\$\{deps\.config\.siteUrl\}(\/supplier\/[^`]+)`/.exec(HANDLER)?.[1];

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(<App />);
};

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  // SupplierRoute 查 supplier_accounts:有一個啟用中的供應商帳號才放行
  fakeSupabase.respond((q) =>
    q.table === "supplier_accounts" && q.single ? { data: { id: "acc-1", supplier_id: "a9200000-0000-4000-8000-00000000000a" } } : undefined,
  );
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("供應商後台零售市集路由(前台站,App.tsx)", () => {
  it("通知信「到後台查看」的路徑是 /supplier/market/orders", () => {
    expect(MAIL_ORDERS_PATH).toBe("/supplier/market/orders");
  });

  it.each([
    [MAIL_ORDERS_PATH ?? "(通知信裡找不到路徑)", "SupplierMarketOrdersPage", "零售訂單"],
    ["/supplier/market/store", "SupplierMarketStorePage", "店家設定"],
  ])("%s → %s,分區「零售市集」、分頁「%s」", async (path, page, tab) => {
    renderAt(path);
    expect(await screen.findByRole("heading", { name: page })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    const desktop = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktop).getByRole("link", { name: "零售市集" })).toHaveAttribute("aria-current", "page");
    const tablist = screen.getByRole("tablist", { name: "零售市集分頁" });
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["零售訂單", "店家設定"]);
    expect(within(tablist).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  });
});
