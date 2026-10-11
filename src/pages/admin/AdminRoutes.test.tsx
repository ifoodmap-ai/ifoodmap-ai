// 管理員站(VITE_PORTAL=admin)的真實路由表:用 App.tsx 本身渲染,不是複製一份路由。
// 驗證:①原本 26 條管理員路由(2026-10 加零售市集 3 條,共 29 條)全部打得開、渲染的是原本那個頁面 ②每一條落在正確的分區與分頁
//       ③唯一的轉址 /admin/orders/:id/timeline → /admin/orders/:id 真的換了網址
//       ④每一頁都有 AI 泡泡、主內容底部留白 pb-40 還在。
// 頁面元件換成空殼(testRouteStub),版面(AdminLayout)、權限閘(AdminRoute)、分頁列(SectionTabs)都是真的;
// Supabase 是假的(預設登入身分是管理員),不打任何網路。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import appSource from "@/App.tsx?raw";
import { fakeSupabase } from "./testFakeSupabase";

vi.mock("@/integrations/supabase/client", async () => ({
  supabase: (await import("./testFakeSupabase")).fakeSupabase.client,
}));
vi.mock("@/lib/portal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal")>()),
  IS_ADMIN_BUILD: true,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("../LoginPortal", async () => (await import("./testRouteStub")).stubPage("LoginPortal"));
vi.mock("./AdminDashboard", async () => (await import("./testRouteStub")).stubPage("AdminDashboard"));
vi.mock("./AdminGrowthPage", async () => (await import("./testRouteStub")).stubPage("AdminGrowthPage"));
vi.mock("./AdminPipelinePage", async () => (await import("./testRouteStub")).stubPage("AdminPipelinePage"));
vi.mock("./AdminOrdersPage", async () => (await import("./testRouteStub")).stubPage("AdminOrdersPage"));
vi.mock("./AdminOrderDetailPage", async () => (await import("./testRouteStub")).stubPage("AdminOrderDetailPage"));
vi.mock("./AdminOrderTimelinePage", async () => (await import("./testRouteStub")).stubPage("AdminOrderTimelinePage"));
vi.mock("./AdminDisputesPage", async () => (await import("./testRouteStub")).stubPage("AdminDisputesPage"));
vi.mock("./AnalysisListPage", async () => (await import("./testRouteStub")).stubPage("AnalysisListPage"));
vi.mock("./AnalysisDetailPage", async () => (await import("./testRouteStub")).stubPage("AnalysisDetailPage"));
vi.mock("./AdminMatchingPage", async () => (await import("./testRouteStub")).stubPage("AdminMatchingPage"));
vi.mock("./AdminForecastPage", async () => (await import("./testRouteStub")).stubPage("AdminForecastPage"));
vi.mock("./AdminMatchQualityPage", async () => (await import("./testRouteStub")).stubPage("AdminMatchQualityPage"));
vi.mock("./AdminRestaurantsPage", async () => (await import("./testRouteStub")).stubPage("AdminRestaurantsPage"));
vi.mock("./AdminSuppliersPage", async () => (await import("./testRouteStub")).stubPage("AdminSuppliersPage"));
vi.mock("./AdminApplicationsPage", async () => (await import("./testRouteStub")).stubPage("AdminApplicationsPage"));
vi.mock("./AdminAccountsPage", async () => (await import("./testRouteStub")).stubPage("AdminAccountsPage"));
vi.mock("./AdminCampaignsPage", async () => (await import("./testRouteStub")).stubPage("AdminCampaignsPage"));
vi.mock("./AdminIngredientsPage", async () => (await import("./testRouteStub")).stubPage("AdminIngredientsPage"));
vi.mock("./AdminSubstitutesPage", async () => (await import("./testRouteStub")).stubPage("AdminSubstitutesPage"));
vi.mock("./AdminDishMappingPage", async () => (await import("./testRouteStub")).stubPage("AdminDishMappingPage"));
vi.mock("./AdminPricesPage", async () => (await import("./testRouteStub")).stubPage("AdminPricesPage"));
vi.mock("./AdminRevenuePage", async () => (await import("./testRouteStub")).stubPage("AdminRevenuePage"));
vi.mock("./AdminBillingPage", async () => (await import("./testRouteStub")).stubPage("AdminBillingPage"));
vi.mock("./AdminAiOpsPage", async () => (await import("./testRouteStub")).stubPage("AdminAiOpsPage"));
vi.mock("./AdminNotificationsPage", async () => (await import("./testRouteStub")).stubPage("AdminNotificationsPage"));
vi.mock("./AdminRoadmapPage", async () => (await import("./testRouteStub")).stubPage("AdminRoadmapPage"));
vi.mock("./AdminMarketProductsPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketProductsPage"));
vi.mock("./AdminMarketStoresPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketStoresPage"));
vi.mock("./AdminMarketOrdersPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketOrdersPage"));

const ORDER_TABS = ["看板", "全部訂單", "爭議"];
const DEMAND_TABS = ["AI 分析紀錄", "供應商比價", "需求預測", "供給缺口與品質"];
const MEMBER_TABS = ["餐廳", "供應商", "入駐審核", "帳號", "分眾名單"];
const DATA_TABS = ["食材主檔", "替代關係", "菜色對應", "價格檢查"];
const SYSTEM_TABS = ["AI 用量", "通知紀錄", "投資人頁內容"];
const OVERVIEW_TABS = ["營運", "成長"];
const MARKET_TABS = ["商品審核", "零售店家", "零售訂單"];

// [網址, 渲染的頁面, 側欄分區, 分頁列(null = 不畫分頁列), 選中的分頁]
const ROUTES: Array<[string, string, string, string[] | null, string | null]> = [
  ["/admin", "AdminDashboard", "總覽", OVERVIEW_TABS, "營運"],
  ["/admin/growth", "AdminGrowthPage", "總覽", OVERVIEW_TABS, "成長"],
  ["/admin/pipeline", "AdminPipelinePage", "訂單", ORDER_TABS, "看板"],
  ["/admin/orders", "AdminOrdersPage", "訂單", ORDER_TABS, "全部訂單"],
  ["/admin/orders/ord-1", "AdminOrderDetailPage", "訂單", ORDER_TABS, "全部訂單"],
  ["/admin/disputes", "AdminDisputesPage", "訂單", ORDER_TABS, "爭議"],
  ["/admin/analyses", "AnalysisListPage", "需求與媒合", DEMAND_TABS, "AI 分析紀錄"],
  ["/admin/analyses/an-1", "AnalysisDetailPage", "需求與媒合", DEMAND_TABS, "AI 分析紀錄"],
  ["/admin/matching", "AdminMatchingPage", "需求與媒合", DEMAND_TABS, "供應商比價"],
  ["/admin/forecast", "AdminForecastPage", "需求與媒合", DEMAND_TABS, "需求預測"],
  ["/admin/match-quality", "AdminMatchQualityPage", "需求與媒合", DEMAND_TABS, "供給缺口與品質"],
  ["/admin/restaurants", "AdminRestaurantsPage", "會員", MEMBER_TABS, "餐廳"],
  ["/admin/suppliers", "AdminSuppliersPage", "會員", MEMBER_TABS, "供應商"],
  ["/admin/applications", "AdminApplicationsPage", "會員", MEMBER_TABS, "入駐審核"],
  ["/admin/accounts", "AdminAccountsPage", "會員", MEMBER_TABS, "帳號"],
  ["/admin/campaigns", "AdminCampaignsPage", "會員", MEMBER_TABS, "分眾名單"],
  ["/admin/ingredients", "AdminIngredientsPage", "食材資料", DATA_TABS, "食材主檔"],
  ["/admin/substitutes", "AdminSubstitutesPage", "食材資料", DATA_TABS, "替代關係"],
  ["/admin/dishes", "AdminDishMappingPage", "食材資料", DATA_TABS, "菜色對應"],
  ["/admin/prices", "AdminPricesPage", "食材資料", DATA_TABS, "價格檢查"],
  // 財務:金流/發票從選單收起來(Q6-A)→ 只剩一個看得到的分頁,不畫分頁列
  ["/admin/revenue", "AdminRevenuePage", "財務", null, null],
  ["/admin/billing", "AdminBillingPage", "財務", null, null],
  ["/admin/ai-ops", "AdminAiOpsPage", "系統", SYSTEM_TABS, "AI 用量"],
  ["/admin/notifications", "AdminNotificationsPage", "系統", SYSTEM_TABS, "通知紀錄"],
  ["/admin/roadmap", "AdminRoadmapPage", "系統", SYSTEM_TABS, "投資人頁內容"],
  ["/admin/market/products", "AdminMarketProductsPage", "零售市集", MARKET_TABS, "商品審核"],
  ["/admin/market/stores", "AdminMarketStoresPage", "零售市集", MARKET_TABS, "零售店家"],
  ["/admin/market/orders", "AdminMarketOrdersPage", "零售市集", MARKET_TABS, "零售訂單"],
];

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(<App />);
};

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
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

describe("管理員站路由表(App.tsx)— 舊網址全部還能開,落在正確的分區與分頁", () => {
  it.each(ROUTES)("%s → %s,分區「%s」", async (path, page, section, tabs, activeTab) => {
    renderAt(path);

    expect(await screen.findByRole("heading", { name: page })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);

    const desktop = screen.getByTestId("admin-sidebar-desktop");
    expect(within(desktop).getByRole("link", { name: section })).toHaveAttribute("aria-current", "page");
    expect(within(desktop).getAllByRole("link", { current: "page" })).toHaveLength(1);

    if (tabs) {
      const tablist = screen.getByRole("tablist", { name: `${section}分頁` });
      expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(tabs);
      expect(within(tablist).getByRole("tab", { name: activeTab as string })).toHaveAttribute("aria-selected", "true");
      expect(within(tablist).getAllByRole("tab", { selected: true })).toHaveLength(1);
    } else {
      expect(screen.queryByRole("tablist")).toBeNull();
    }

    // AI 泡泡與主內容底部留白每一頁都在
    expect(document.querySelectorAll('[data-ai-assistant="admin"]')).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveClass("pb-40");
  });

  it("App.tsx 管理員站的每一條 /admin 路由都在上表或轉址表裡(新增路由沒排分區,這裡會失敗)", () => {
    // 從 App.tsx 原始碼抓出 AdminRoutes 區塊裡 <Route path="/admin"> 底下的子路由
    const block = appSource.slice(appSource.indexOf("const AdminRoutes"), appSource.indexOf("const MainRoutes"));
    const adminBlock = block.slice(block.indexOf('<Route path="/admin"'), block.indexOf('<Route path="*"'));
    const declared = [...adminBlock.matchAll(/<Route (index|path="([^"]+)")/g)]
      .map((m) => (m[1] === "index" ? "/admin" : m[2] === "/admin" ? null : `/admin/${m[2]}`))
      .filter((p): p is string => p !== null);

    const covered = [
      ...ROUTES.map(([path]) => path.replace("/orders/ord-1", "/orders/:id").replace("/analyses/an-1", "/analyses/:id")),
      "/admin/orders/:id/timeline", // 轉址,見下一組測試
    ];
    expect(declared).toHaveLength(29);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
});

describe("唯一的轉址:/admin/orders/:id/timeline → /admin/orders/:id(兩個單筆訂單頁併成一頁)", () => {
  it.each([
    ["/admin/orders/ord-9/timeline", "/admin/orders/ord-9"],
    ["/admin/orders/ord-9/timeline/", "/admin/orders/ord-9"],
    ["/admin/orders/5b0c1e7a-0000-4000-8000-000000000001/timeline", "/admin/orders/5b0c1e7a-0000-4000-8000-000000000001"],
  ])("%s → 網址換成 %s,畫面是單筆訂單頁、落在「訂單 › 全部訂單」", async (from, to) => {
    renderAt(from);

    expect(await screen.findByRole("heading", { name: "AdminOrderDetailPage" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe(to));
    // 舊的履歷頁元件不會再從這條網址渲染出來
    expect(screen.queryByRole("heading", { name: "AdminOrderTimelinePage" })).toBeNull();

    const desktop = screen.getByTestId("admin-sidebar-desktop");
    expect(within(desktop).getByRole("link", { name: "訂單" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "全部訂單" })).toHaveAttribute("aria-selected", "true");
  });

  it("轉址用 replace:瀏覽器上一頁不會又回到 /timeline 再被轉一次", async () => {
    window.history.pushState({}, "", "/admin/orders");
    renderAt("/admin/orders/ord-9/timeline");
    await waitFor(() => expect(window.location.pathname).toBe("/admin/orders/ord-9"));
    // replace 之後,歷史紀錄上一筆是 /admin/orders;如果用 push,上一頁會回到 /timeline
    cleanup();
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/admin/orders"));
  });
});

describe("管理員站路由表 — 權限與萬用路由照舊", () => {
  it("不是管理員 → 被 AdminRoute 送回登入頁", async () => {
    fakeSupabase.setSession({
      user: { id: "u-2", email: "someone@example.test", app_metadata: {} },
      access_token: "fake",
    });
    renderAt("/admin/pipeline");
    expect(await screen.findByRole("heading", { name: "LoginPortal" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("管理員站沒有的網址(例如主站的 /supplier/:id)→ 導回登入頁", async () => {
    renderAt("/supplier/s-1");
    expect(await screen.findByRole("heading", { name: "LoginPortal" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });
});
