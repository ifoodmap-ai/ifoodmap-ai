// 後台精簡第一期:供應商後台選單 11 → 5 個分區,分區裡用分頁。
// 第二期(Q1-A):訂單分區的收單/報價/出貨合成一個訂單頁(頁面自己用 ?stage= 狀態分頁),
// 版面不再畫訂單分區的分頁列;舊網址轉址到 /supplier/orders?stage=…(轉址寫法與 App.tsx 相同)。
// 這裡驗證:①側欄剛好 6 項(2026-10 加「零售市集」) ②分頁依路由標出 active ③舊路由全部還能開、
// 落在正確的分區與分頁 ④定價助手從選單/分頁收起來但路由仍可直接開 ⑤鍵盤與 aria
// ⑥手機抽屜收起時不在 Tab 順序與無障礙樹裡,收起後焦點回到選單鈕。
//
// 子頁面全部換成空殼標題(這裡只驗版面殼,不驗個別頁面內容);
// 跟其他 Layout 測試一樣 mock 掉 supabase 與 PortalSwitcher,不打任何正式服務。

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierLayout from "./SupplierLayout";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      signOut: vi.fn(),
    },
  },
}));

vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));

/** 訂單頁空殼:把轉址後的網址(含 ?stage=)印出來 */
const OrdersStub = () => {
  const location = useLocation();
  return (
    <>
      <h1>訂單頁</h1>
      <p data-testid="orders-url">{`${location.pathname}${location.search}`}</p>
    </>
  );
};

const renderLayout = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/supplier" element={<SupplierLayout />}>
          <Route index element={<h1>總覽頁</h1>} />
          <Route path="leads" element={<h1>商機雷達頁</h1>} />
          <Route path="orders" element={<OrdersStub />} />
          {/* 對齊 App.tsx:收單/報價/出貨合成一個訂單頁,舊網址轉到對應的狀態分頁 */}
          <Route path="quotes" element={<Navigate to="/supplier/orders?stage=accepted" replace />} />
          <Route path="catalog" element={<h1>商品目錄頁</h1>} />
          <Route path="pricing" element={<h1>定價助手頁</h1>} />
          <Route path="forecast" element={<h1>需求預測頁</h1>} />
          <Route path="customers" element={<h1>客戶管理頁</h1>} />
          <Route path="logistics" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
          <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
          <Route path="reviews" element={<h1>我的評價頁</h1>} />
          <Route path="market/store" element={<h1>店家設定頁</h1>} />
          <Route path="market/orders" element={<h1>零售訂單頁</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

/** 手機頂欄的選單鈕;名字跟著抽屜開關變 */
const menuButton = (name: "開啟選單" | "關閉選單") =>
  within(screen.getByRole("banner")).getByRole("button", { name });

/** 從頁面開頭(焦點在 body)一路按 Tab 直到繞回 body,依序回傳拿到焦點的元素 */
const tabThroughPage = async (user: ReturnType<typeof userEvent.setup>) => {
  (document.activeElement as HTMLElement | null)?.blur();
  const visited: Element[] = [];
  for (let i = 0; i < 100; i++) {
    await user.tab();
    if (document.activeElement === document.body) return visited;
    visited.push(document.activeElement as Element);
  }
  throw new Error("按了 100 次 Tab 還沒繞回頁面開頭");
};

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("SupplierLayout — 側欄剛好 6 個分區", () => {
  it("桌機側欄是 6 個分區連結,文字依序為:總覽、訂單、商機、商品與價格、客戶與評價、零售市集", () => {
    renderLayout("/supplier");
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    const links = within(desktopNav).getAllByRole("link");
    expect(links).toHaveLength(6);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價", "零售市集"]);
  });

  it("手機抽屜打開後也是同樣 6 個分區連結", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    await user.click(menuButton("開啟選單"));
    const mobileNav = screen.getByTestId("supplier-sidebar-mobile");
    const links = within(mobileNav).getAllByRole("link");
    expect(links).toHaveLength(6);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價", "零售市集"]);
  });

  it("找不到「定價助手」「需求預測」「收單紀錄」等舊的 11 項標籤 —— 選單只剩 5 個分區名", () => {
    renderLayout("/supplier");
    ["定價助手", "商機雷達", "收單紀錄", "線上報價", "物流追蹤", "出貨紀錄", "我的評價"].forEach((oldLabel) => {
      expect(screen.queryByRole("link", { name: oldLabel })).toBeNull();
    });
  });
});

describe("SupplierLayout — aria-current 標出目前分區", () => {
  it("在訂單分區底下的路由,側欄只有「訂單」帶 aria-current=page", () => {
    renderLayout("/supplier/quotes");
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktopNav).getByRole("link", { name: "訂單" })).toHaveAttribute("aria-current", "page");
    ["總覽", "商機", "商品與價格", "客戶與評價", "零售市集"].forEach((label) => {
      expect(within(desktopNav).getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    });
  });
});

describe("SupplierLayout — 11 條舊路由全部打得開,落在正確的分區與分頁", () => {
  it.each([
    ["/supplier", "總覽頁", "總覽", null as string[] | null, null as string | null],
    ["/supplier/leads", "商機雷達頁", "商機", ["商機雷達", "需求與備貨"], "商機雷達"],
    ["/supplier/forecast", "需求預測頁", "商機", ["商機雷達", "需求與備貨"], "需求與備貨"],
    ["/supplier/orders", "訂單頁", "訂單", null as string[] | null, null as string | null],
    ["/supplier/quotes", "訂單頁", "訂單", null as string[] | null, null as string | null],
    ["/supplier/shipments", "訂單頁", "訂單", null as string[] | null, null as string | null],
    ["/supplier/logistics", "訂單頁", "訂單", null as string[] | null, null as string | null],
    ["/supplier/catalog", "商品目錄頁", "商品與價格", null as string[] | null, null as string | null],
    ["/supplier/customers", "客戶管理頁", "客戶與評價", ["客戶", "評價"], "客戶"],
    ["/supplier/reviews", "我的評價頁", "客戶與評價", ["客戶", "評價"], "評價"],
    ["/supplier/market/orders", "零售訂單頁", "零售市集", ["零售訂單", "店家設定"], "零售訂單"],
    ["/supplier/market/store", "店家設定頁", "零售市集", ["零售訂單", "店家設定"], "店家設定"],
  ])("%s → 頁面 %s,分區「%s」", (path, heading, sectionLabel, expectedTabs, activeTab) => {
    renderLayout(path);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();

    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktopNav).getByRole("link", { name: sectionLabel })).toHaveAttribute("aria-current", "page");

    if (expectedTabs) {
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(expectedTabs);
      expect(screen.getByRole("tab", { name: activeTab as string })).toHaveAttribute("aria-selected", "true");
    } else {
      expect(screen.queryByRole("tablist")).toBeNull();
    }
  });

  it.each([
    ["/supplier/orders", "/supplier/orders"],
    ["/supplier/quotes", "/supplier/orders?stage=accepted"],
    ["/supplier/shipments", "/supplier/orders?stage=shipped"],
    ["/supplier/logistics", "/supplier/orders?stage=shipped"],
  ])("舊網址 %s 會真的轉址到 %s(落在對應的狀態分頁)", (path, landed) => {
    renderLayout(path);
    expect(screen.getByTestId("orders-url")).toHaveTextContent(landed);
    expect(screen.queryByRole("heading", { name: /物流|出貨紀錄|線上報價/ })).toBeNull();
  });
});

describe("SupplierLayout — 定價助手:選單收起來,路由仍可直接開(Q6-A)", () => {
  it("直接打 /supplier/pricing 網址,頁面正常渲染,側欄標出「商品與價格」", () => {
    renderLayout("/supplier/pricing");
    expect(screen.getByRole("heading", { name: "定價助手頁" })).toBeInTheDocument();

    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktopNav).getByRole("link", { name: "商品與價格" })).toHaveAttribute("aria-current", "page");
  });

  it("畫面上完全找不到「定價助手」或「行情比價」這兩個選單/分頁字樣", () => {
    renderLayout("/supplier/pricing");
    expect(screen.queryByText("定價助手")).toBeNull();
    expect(screen.queryByText("行情比價")).toBeNull();
  });

  it("商品與價格分區只剩一個可見分頁,不畫分頁列(catalog 與 pricing 兩條路由都一樣)", () => {
    renderLayout("/supplier/catalog");
    expect(screen.queryByRole("tablist")).toBeNull();
    renderLayout("/supplier/pricing");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("SupplierLayout — 分頁列的鍵盤操作與 aria(整合驗證,細節見 SectionTabs.test.tsx)", () => {
  it("方向鍵可以在商機分區的 2 個分頁間移動焦點", () => {
    renderLayout("/supplier/leads");
    const tablist = screen.getByRole("tablist");
    const first = screen.getByRole("tab", { name: "商機雷達" });
    const second = screen.getByRole("tab", { name: "需求與備貨" });

    first.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(second).toHaveFocus();
  });

  it("分頁列有正確的 aria-label,並且 aria-controls 指到主內容區", () => {
    renderLayout("/supplier/leads");
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveAttribute("aria-label", "商機分頁");
    screen.getAllByRole("tab").forEach((tab) => {
      expect(tab).toHaveAttribute("aria-controls", "supplier-main-panel");
    });
    expect(document.getElementById("supplier-main-panel")).toBeInTheDocument();
  });
});

describe("SupplierLayout — 手機抽屜:收起時不在 Tab 順序與無障礙樹裡,收起後焦點回到選單鈕", () => {
  it("抽屜收起時,從頁面開頭一路按 Tab 都不會停在抽屜裡;讀屏也讀不到抽屜的連結", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    const drawer = screen.getByTestId("supplier-sidebar-mobile");
    expect(menuButton("開啟選單")).toHaveAttribute("aria-expanded", "false");

    const visited = await tabThroughPage(user);
    // 抽屜在 DOM 裡排在選單鈕前面:走得到選單鈕,才代表真的走過抽屜所在的位置
    expect(visited).toContain(menuButton("開啟選單"));
    expect(visited.filter((el) => drawer.contains(el))).toEqual([]);

    // 連結還留在 DOM 裡(滑出動畫要用),只是藏起來:無障礙樹裡沒有、畫面上看不到
    expect(within(drawer).queryAllByRole("link")).toEqual([]);
    const hiddenLinks = within(drawer).getAllByRole("link", { hidden: true });
    expect(hiddenLinks).toHaveLength(6);
    hiddenLinks.forEach((link) => expect(link).not.toBeVisible());
  });

  it("抽屜打開後,6 個分區連結和登出都按 Tab 走得到、讀屏讀得到", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    await user.click(menuButton("開啟選單"));
    expect(menuButton("關閉選單")).toHaveAttribute("aria-expanded", "true");

    const drawer = screen.getByTestId("supplier-sidebar-mobile");
    const links = within(drawer).getAllByRole("link");
    expect(links).toHaveLength(6);
    links.forEach((link) => expect(link).toBeVisible());

    const visited = await tabThroughPage(user);
    expect(visited.filter((el) => drawer.contains(el)).map((el) => el.textContent)).toEqual([
      "總覽", "訂單", "商機", "商品與價格", "客戶與評價", "零售市集", "登出",
    ]);
  });

  it("用鍵盤在抽屜裡選分區:換頁、抽屜收起,焦點回到選單鈕,不會留在藏起來的抽屜裡", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    await user.click(menuButton("開啟選單"));

    const ordersLink = within(screen.getByTestId("supplier-sidebar-mobile")).getByRole("link", { name: "訂單" });
    ordersLink.focus();
    expect(ordersLink).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "訂單頁" })).toBeInTheDocument();
    expect(menuButton("開啟選單")).toHaveAttribute("aria-expanded", "false");
    expect(menuButton("開啟選單")).toHaveFocus();
    expect(within(screen.getByTestId("supplier-sidebar-mobile")).queryAllByRole("link")).toEqual([]);
  });

  it("點遮罩收起:焦點從抽屜回到選單鈕", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    await user.click(menuButton("開啟選單"));
    const firstLink = within(screen.getByTestId("supplier-sidebar-mobile")).getByRole("link", { name: "總覽" });
    firstLink.focus();
    expect(firstLink).toHaveFocus();

    await user.click(screen.getByTestId("supplier-drawer-overlay"));
    expect(screen.queryByTestId("supplier-drawer-overlay")).toBeNull();
    expect(menuButton("開啟選單")).toHaveFocus();
  });

  it("用選單鈕收起:焦點留在選單鈕上", async () => {
    const user = userEvent.setup();
    renderLayout("/supplier");
    menuButton("開啟選單").focus();
    await user.keyboard("{Enter}");
    expect(menuButton("關閉選單")).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(menuButton("開啟選單")).toHaveFocus();
    expect(within(screen.getByTestId("supplier-sidebar-mobile")).queryAllByRole("link")).toEqual([]);
  });
});
