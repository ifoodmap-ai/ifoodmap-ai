// 後台精簡第一期:餐廳後台選單 10 → 5 個分區(採購員 4 個),分區裡用分頁。
// 這裡驗證:①老闆/店長側欄 6 項、採購員 4 項(桌機與手機抽屜都是)②原本 10 條網址加上報表頁全部還能開,
// 落在正確的分區與分頁 ③「菜單與成本」對採購員不只藏選單,打網址也會被導回總覽
// ④AI 泡泡與內容區底部留白保留。
//
// 子頁面全部換成空殼標題(這裡只驗版面殼);AI 泡泡換成替身(泡泡本身的行為在 RestaurantLayout.test.tsx)。
// supabase 與 PortalSwitcher 都 mock 掉,並擋掉所有網路請求。

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantLayout from "./RestaurantLayout";

type Role = "owner" | "manager" | "purchaser";
const { roleRef } = vi.hoisted(() => ({ roleRef: { current: "owner" as Role } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

// 身分一律照 RestaurantRoute 的規則:成本只給老闆/店長(這支檔案不動 RestaurantRoute 本身)
vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: null,
    role: roleRef.current,
    restaurant_name: "好味小館",
  }),
  canSeeCost: (role: Role) => role === "owner" || role === "manager",
  needsApproval: (role: Role) => role === "purchaser",
}));

vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));
vi.mock("@/components/AIAssistantBubble", () => ({
  default: () => <div data-ai-assistant="restaurant">AI 泡泡替身</div>,
}));

/** 原本的 10 條路由(App.tsx 一條都沒改) */
const ROUTES: [string, string][] = [
  ["", "營運總覽頁"],
  ["analyze", "AI 菜單分析頁"],
  ["menu", "我的菜單頁"],
  ["purchase", "智慧採購頁"],
  ["orders", "訂單與收貨頁"],
  ["costs", "成本與省錢頁"],
  ["reports", "採購報表頁"],
  ["suppliers", "我的供應商頁"],
  ["lab", "菜色實驗室頁"],
  ["team", "分店與成員頁"],
  ["settings", "店家設定頁"],
];

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const renderLayout = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/restaurant" element={<RestaurantLayout />}>
          {ROUTES.map(([sub, heading]) =>
            sub === "" ? (
              <Route key="index" index element={<h1>{heading}</h1>} />
            ) : (
              <Route key={sub} path={sub} element={<h1>{heading}</h1>} />
            ),
          )}
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );

const desktopNav = () =>
  within(screen.getByTestId("restaurant-sidebar-desktop")).getByRole("navigation", { name: "餐廳後台導覽" });
const sectionLabels = (nav: HTMLElement) => within(nav).getAllByRole("link").map((a) => a.textContent?.trim());

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  roleRef.current = "owner";
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("RestaurantLayout — 選單收成分區", () => {
  it.each<Role>(["owner", "manager"])("%s:桌機側欄 6 個分區,依序為總覽、AI 菜單分析、叫貨與訂單、菜單與成本、報表、設定", (role) => {
    roleRef.current = role;
    renderLayout("/restaurant");

    expect(sectionLabels(desktopNav())).toEqual(["總覽", "AI 菜單分析", "叫貨與訂單", "菜單與成本", "報表", "設定"]);
  });

  it("採購員:桌機側欄 4 個分區(沒有「菜單與成本」與「報表」)", () => {
    roleRef.current = "purchaser";
    renderLayout("/restaurant");

    expect(sectionLabels(desktopNav())).toEqual(["總覽", "AI 菜單分析", "叫貨與訂單", "設定"]);
  });

  it.each<[Role, number]>([["owner", 6], ["manager", 6], ["purchaser", 4]])(
    "%s:手機抽屜打開也是 %i 項,點分區會關掉抽屜",
    async (role, count) => {
      roleRef.current = role;
      const user = userEvent.setup();
      renderLayout("/restaurant");

      expect(screen.queryByTestId("restaurant-sidebar-mobile")).toBeNull();
      await user.click(screen.getByRole("button", { name: "開啟選單" }));
      const drawer = screen.getByTestId("restaurant-sidebar-mobile");
      const nav = within(drawer).getByRole("navigation", { name: "餐廳後台導覽" });
      expect(within(nav).getAllByRole("link")).toHaveLength(count);

      await user.click(within(nav).getByRole("link", { name: "叫貨與訂單" }));
      expect(screen.getByRole("heading", { name: "訂單與收貨頁" })).toBeInTheDocument();
      expect(screen.queryByTestId("restaurant-sidebar-mobile")).toBeNull();
    },
  );

  it("「叫貨與訂單」點下去預設是「訂單」分頁(/restaurant/orders,通知信連的網址)", () => {
    renderLayout("/restaurant");

    const link = within(desktopNav()).getByRole("link", { name: "叫貨與訂單" });
    expect(link).toHaveAttribute("href", "/restaurant/orders");
    fireEvent.click(link);
    expect(screen.getByTestId("where")).toHaveTextContent("/restaurant/orders");
    expect(screen.getByRole("tab", { name: "訂單" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("RestaurantLayout — 全部網址都還能開,落在正確的分區與分頁", () => {
  // [網址, 頁面, 側欄分區, 分頁(沒有分頁列為 null), 同分區的分頁依序]
  const CASES: [string, string, string, string | null, string[] | null][] = [
    ["/restaurant", "營運總覽頁", "總覽", null, null],
    ["/restaurant/analyze", "AI 菜單分析頁", "AI 菜單分析", null, null],
    ["/restaurant/purchase", "智慧採購頁", "叫貨與訂單", "叫貨", ["叫貨", "訂單", "供應商"]],
    ["/restaurant/orders", "訂單與收貨頁", "叫貨與訂單", "訂單", ["叫貨", "訂單", "供應商"]],
    ["/restaurant/suppliers", "我的供應商頁", "叫貨與訂單", "供應商", ["叫貨", "訂單", "供應商"]],
    ["/restaurant/menu", "我的菜單頁", "菜單與成本", "我的菜單", ["我的菜單", "食材行情", "新菜實驗室"]],
    ["/restaurant/costs", "成本與省錢頁", "菜單與成本", "食材行情", ["我的菜單", "食材行情", "新菜實驗室"]],
    ["/restaurant/lab", "菜色實驗室頁", "菜單與成本", "新菜實驗室", ["我的菜單", "食材行情", "新菜實驗室"]],
    ["/restaurant/reports", "採購報表頁", "報表", null, null],
    ["/restaurant/settings", "店家設定頁", "設定", "店家資料", ["店家資料", "分店與成員"]],
    ["/restaurant/team", "分店與成員頁", "設定", "分店與成員", ["店家資料", "分店與成員"]],
  ];

  it.each(CASES)("老闆開 %s → %s,側欄「%s」、分頁「%s」", (path, heading, section, tab, tabs) => {
    renderLayout(path);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(path);

    const current = within(desktopNav()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent?.trim())).toEqual([section]);

    if (tab === null) {
      expect(screen.queryByRole("tablist")).toBeNull();
      return;
    }
    const tablist = screen.getByRole("tablist", { name: `${section}分頁` });
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(tabs);
    expect(within(tablist).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    // 分頁控制的是主內容區
    expect(within(tablist).getByRole("tab", { name: tab })).toHaveAttribute("aria-controls", "restaurant-main-panel");
    expect(screen.getByRole("main")).toHaveAttribute("id", "restaurant-main-panel");
  });

  it("店長開 /restaurant/lab 也進得去(成本分區給老闆與店長)", () => {
    roleRef.current = "manager";
    renderLayout("/restaurant/lab");

    expect(screen.getByRole("heading", { name: "菜色實驗室頁" })).toBeInTheDocument();
  });

  it("在分區裡切分頁就是換網址(叫貨 → 供應商)", async () => {
    const user = userEvent.setup();
    renderLayout("/restaurant/purchase");

    await user.click(screen.getByRole("tab", { name: "供應商" }));
    expect(screen.getByRole("heading", { name: "我的供應商頁" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/restaurant/suppliers");
  });
});

describe("RestaurantLayout — 採購員", () => {
  it.each(["/restaurant/menu", "/restaurant/costs", "/restaurant/lab", "/restaurant/reports"])(
    "打 %s 會被導回總覽(不只藏選單,路由也擋)",
    (path) => {
      roleRef.current = "purchaser";
      renderLayout(path);

      expect(screen.getByRole("heading", { name: "營運總覽頁" })).toBeInTheDocument();
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/restaurant$/);
      expect(screen.queryByRole("tab", { name: "我的菜單" })).toBeNull();
    },
  );

  it.each([
    ["/restaurant/analyze", "AI 菜單分析頁"],
    ["/restaurant/purchase", "智慧採購頁"],
    ["/restaurant/orders", "訂單與收貨頁"],
    ["/restaurant/suppliers", "我的供應商頁"],
    ["/restaurant/settings", "店家設定頁"],
    ["/restaurant/team", "分店與成員頁"],
  ])("其餘網址照常能開:%s", (path, heading) => {
    roleRef.current = "purchaser";
    renderLayout(path);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });
});

describe("RestaurantLayout — 保留 AI 泡泡與底部留白", () => {
  it.each(["/restaurant", "/restaurant/orders", "/restaurant/settings"])("%s:泡泡只有一顆、主內容底部 pb-40", (path) => {
    renderLayout(path);

    expect(document.querySelectorAll("[data-ai-assistant]")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveClass("pb-40", "md:pb-40");
  });
});
