// 管理員後台共用版面:
//   ① AI 助手泡泡每一頁都看得到,而且是純對話(admin 模式)。
//   ② 後台精簡第一期:選單 23 項 → 7 個分區,分區裡用分頁(SectionTabs);金流/發票從選單收起來;
//      2026-10 加第 8 個分區「零售市集」(消費者食材市集的商品審核、零售店家、零售訂單);
//      「會員 › 入駐審核」分頁帶待審數。
//
// 🔴 管理員後台是另一個網站(VITE_PORTAL=admin),沒有 /restaurant/* 路由 —— 對話裡講到「供應商」「媒合」
//    也不能擷取需求或導頁,導過去就是 404。
// 子頁面換成空殼(這裡只驗版面);泡泡與 Chatbot 是真的,只 mock 掉 AI 呼叫(不打正式 AI Edge Function)。
// Supabase 換成假的(testFakeSupabase),待審數的查詢在這裡驗;每一條真實路由的分區/分頁對照在 AdminRoutes.test.tsx。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/LanguageContext";
import type { AnalysisResult } from "@/lib/api";
import AdminLayout from "./AdminLayout";
import { fakeSupabase } from "./testFakeSupabase";

const { chatReply, analyzeChat } = vi.hoisted(() => ({
  chatReply: vi.fn(),
  analyzeChat: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", async () => ({
  supabase: (await import("./testFakeSupabase")).fakeSupabase.client,
}));

vi.mock("@/components/PortalSwitcher", () => ({ default: () => null }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, chatReply, analyzeChat };
});

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const ANALYSIS: AnalysisResult = {
  analysisId: "analysis-1",
  persistError: null,
  summary: "",
  ingredients: [{ name: "牛肉", quantity: "5", unit: "kg" }],
};

const SECTION_LABELS = ["總覽", "訂單", "需求與媒合", "會員", "食材資料", "財務", "零售市集", "系統"];

let pathnames: string[] = [];
const PathProbe = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    pathnames.push(pathname);
  }, [pathname]);
  return null;
};

const renderLayout = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<h1>儀表板頁</h1>} />
            <Route path="growth" element={<h1>成長儀表板頁</h1>} />
            <Route path="pipeline" element={<h1>交易看板頁</h1>} />
            <Route path="orders" element={<h1>供應商訂單頁</h1>} />
            <Route path="analyses" element={<h1>分析紀錄頁</h1>} />
            <Route path="restaurants" element={<h1>餐廳管理頁</h1>} />
            <Route path="suppliers" element={<h1>供應商管理頁</h1>} />
            <Route path="applications" element={<h1>入駐申請頁</h1>} />
            <Route path="revenue" element={<h1>營收頁</h1>} />
            <Route path="billing" element={<h1>金流發票頁</h1>} />
          </Route>
          <Route path="*" element={<h1>不該來到這裡</h1>} />
        </Routes>
        <PathProbe />
      </LanguageProvider>
    </MemoryRouter>,
  );

const fab = () => screen.getByRole("button", { name: "AI 助手" });
const chatInput = () => screen.getByRole("textbox", { name: "輸入食材需求" });

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  pathnames = [];
  chatReply.mockReset();
  analyzeChat.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("AdminLayout 的 AI 助手泡泡", () => {
  it.each([
    ["/admin", "儀表板頁"],
    ["/admin/orders", "供應商訂單頁"],
    ["/admin/analyses", "分析紀錄頁"],
  ])("%s 看得到泡泡,小標是中性的「AI 助手」(整個版面只有一顆)", async (path, heading) => {
    renderLayout(path);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(fab()).toBeInTheDocument();
    expect(screen.getByTestId("ai-assistant-tip")).toHaveTextContent("AI 助手");
    expect(screen.queryByText("找食材嗎？")).toBeNull();
    expect(document.querySelectorAll("[data-ai-assistant]")).toHaveLength(1);
    expect(document.querySelector("[data-ai-assistant]")).toHaveAttribute("data-ai-assistant", "admin");
    // 等 AdminLayout 讀完登入狀態,避免 act 警告
    await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
  });

  it("送出含「供應商」「媒合」的訊息 → 只有 AI 回話,不擷取需求、不導頁(🔴 不能導去 /restaurant/*)", async () => {
    chatReply.mockResolvedValueOnce({ reply: "好的,請問是哪一家餐廳的需求?" });
    // 萬一 admin 模式誤把交接函式傳給 Chatbot,這個回覆會讓它真的導頁 —— 測試就會抓到
    analyzeChat.mockResolvedValue(ANALYSIS);
    const user = userEvent.setup();
    renderLayout("/admin/orders");

    await user.click(fab());
    await user.type(chatInput(), "牛肉 5kg,幫我媒合供應商並報價");
    fireEvent.keyPress(chatInput(), { key: "Enter", code: "Enter", charCode: 13 });

    expect(await screen.findByText("好的,請問是哪一家餐廳的需求?")).toBeInTheDocument();
    expect(analyzeChat).not.toHaveBeenCalled();
    expect(pathnames).toEqual(["/admin/orders"]);
    expect(screen.queryByRole("heading", { name: "不該來到這裡" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "AI 助手" })).toBeInTheDocument();
  });

  it("用側欄換頁:泡泡一直在,開著的面板會收起", async () => {
    const user = userEvent.setup();
    renderLayout("/admin");

    await user.click(fab());
    expect(screen.getByRole("dialog", { name: "AI 助手" })).toBeInTheDocument();

    // 選單收成分區後,「分析紀錄」在「需求與媒合」分區裡。桌機與手機側欄各有一份連結,點第一份就好
    await user.click(screen.getAllByRole("link", { name: "需求與媒合" })[0]);

    expect(screen.getByRole("heading", { name: "分析紀錄頁" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI 分析紀錄" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fab()).toHaveAttribute("aria-expanded", "false");
    expect(within(document.body).getAllByTestId("ai-assistant-tip")).toHaveLength(1);
  });

  it("主內容底部留白(160px)讓表格底下靠右的按鈕能捲到泡泡與小標籤上方", async () => {
    renderLayout("/admin/orders");

    expect(screen.getByRole("main")).toHaveClass("pb-40");
    await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
  });

  it("有分頁列的分區(訂單)也一樣:分頁列在 main 裡,底部留白與泡泡都還在", async () => {
    renderLayout("/admin/pipeline");

    const main = screen.getByRole("main");
    expect(main).toHaveClass("pb-40");
    expect(within(main).getByRole("tablist", { name: "訂單分頁" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-ai-assistant]")).toHaveLength(1);
    await waitFor(() => expect(main).toBeInTheDocument());
  });
});

describe("AdminLayout — 選單剛好 8 個分區(23 項收成 7 區,2026-10 加零售市集)", () => {
  it.each([
    ["桌機側欄", "admin-sidebar-desktop"],
    ["手機抽屜", "admin-sidebar-mobile"],
  ])("%s:剛好 8 個分區連結,依序是 總覽、訂單、需求與媒合、會員、食材資料、財務、零售市集、系統", async (_name, testId) => {
    renderLayout("/admin");
    const nav = within(screen.getByTestId(testId)).getByRole("navigation", { name: "管理員後台導覽" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(8);
    expect(links.map((l) => l.textContent)).toEqual(SECTION_LABELS);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/admin",
      "/admin/pipeline",
      "/admin/analyses",
      "/admin/restaurants",
      "/admin/ingredients",
      "/admin/revenue",
      "/admin/market/products",
      "/admin/ai-ops",
    ]);
    await waitFor(() => expect(nav).toBeInTheDocument());
  });

  it("舊的 23 個選單標籤都不在側欄上(金流/發票、推播與活動、發展藍圖也不佔主選單)", async () => {
    renderLayout("/admin");
    const desktop = screen.getByTestId("admin-sidebar-desktop");
    [
      "儀表板", "交易全流程看板", "分析紀錄", "供應商訂單", "智慧媒合", "需求預測",
      "餐廳管理", "供應商管理", "入駐申請", "帳號與權限",
      "食材主檔", "菜色↔食材對應", "替代食材關係", "價格資料維護",
      "媒合品質監控", "AI 用量與品質", "履約與爭議", "營收與抽成", "金流／發票",
      "成長儀表板", "推播與活動", "通知中心", "發展藍圖",
    ].forEach((oldLabel) => {
      expect(within(desktop).queryByRole("link", { name: oldLabel })).toBeNull();
    });
    await waitFor(() => expect(desktop).toBeInTheDocument());
  });

  it("目前分區只有一個帶 aria-current=page(在 /admin/orders 是「訂單」)", async () => {
    renderLayout("/admin/orders");
    const desktop = screen.getByTestId("admin-sidebar-desktop");
    expect(within(desktop).getByRole("link", { name: "訂單" })).toHaveAttribute("aria-current", "page");
    SECTION_LABELS.filter((l) => l !== "訂單").forEach((label) => {
      expect(within(desktop).getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    });
    await waitFor(() => expect(desktop).toBeInTheDocument());
  });
});

describe("AdminLayout — 總覽:營運/成長兩個分頁(Q4-A)", () => {
  it("在 /admin:「營運」選中", async () => {
    renderLayout("/admin");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["營運", "成長"]);
    expect(screen.getByRole("tab", { name: "營運" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "成長" })).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
  });

  it("在 /admin/growth:只有「成長」選中(/admin 是所有網址的前綴,不能被誤判),「營運」仍連回 /admin", async () => {
    renderLayout("/admin/growth");
    expect(screen.getByRole("heading", { name: "成長儀表板頁" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "成長" })).toHaveAttribute("aria-selected", "true");
    const ops = screen.getByRole("tab", { name: "營運" });
    expect(ops).toHaveAttribute("aria-selected", "false");
    expect(ops).toHaveAttribute("href", "/admin");

    fireEvent.click(ops);
    expect(await screen.findByRole("heading", { name: "儀表板頁" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "營運" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("AdminLayout — 金流/發票從選單收起來,網址仍可直接開(Q6-A)", () => {
  it("直接打 /admin/billing:頁面正常、側欄標出「財務」,但畫面上沒有「金流/發票」的選單或分頁", async () => {
    renderLayout("/admin/billing");
    expect(screen.getByRole("heading", { name: "金流發票頁" })).toBeInTheDocument();
    const desktop = screen.getByTestId("admin-sidebar-desktop");
    expect(within(desktop).getByRole("link", { name: "財務" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/金流／發票/)).toBeNull();
    // 財務分區只剩一個看得到的分頁 → 不畫分頁列
    expect(screen.queryByRole("tablist")).toBeNull();
    await waitFor(() => expect(desktop).toBeInTheDocument());
  });

  it("/admin/revenue 也沒有分頁列(唯一看得到的分頁不需要切換器)", async () => {
    renderLayout("/admin/revenue");
    expect(screen.getByRole("heading", { name: "營收頁" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
  });
});

describe("AdminLayout — 會員 › 入駐審核分頁帶待審數", () => {
  const respondPending = (res: { count?: number | null; error?: { message: string } }) =>
    fakeSupabase.respond((q) => (q.table === "supplier_applications" ? res : undefined));

  it("有 3 筆待審 → 分頁標題「入駐審核（3）」;查的是 supplier_applications 的 pending 筆數", async () => {
    respondPending({ count: 3 });
    renderLayout("/admin/restaurants");

    expect(await screen.findByRole("tab", { name: "入駐審核（3）" })).toHaveAttribute("href", "/admin/applications");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "餐廳", "供應商", "入駐審核（3）", "帳號", "分眾名單",
    ]);

    const [query] = fakeSupabase.queriesOf("supplier_applications");
    expect(query.action).toBe("select");
    expect(query.options).toEqual({ count: "exact", head: true });
    expect(query.filters).toEqual([{ op: "eq", column: "status", value: "pending" }]);
    expect(fakeSupabase.writes()).toEqual([]);
  });

  it("停在入駐審核分頁本身也看得到數字,而且是選中狀態", async () => {
    respondPending({ count: 12 });
    renderLayout("/admin/applications");
    const tab = await screen.findByRole("tab", { name: "入駐審核（12）" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "入駐申請頁" })).toBeInTheDocument();
  });

  it("0 筆待審 → 只顯示「入駐審核」,不顯示（0）", async () => {
    respondPending({ count: 0 });
    renderLayout("/admin/suppliers");
    await waitFor(() => expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1));
    expect(await screen.findByRole("tab", { name: "入駐審核" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /入駐審核（/ })).toBeNull();
  });

  it("查詢失敗 → 只顯示「入駐審核」(不顯示錯的數字),分頁照樣能點", async () => {
    respondPending({ error: { message: "permission denied" } });
    renderLayout("/admin/suppliers");
    await waitFor(() => expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1));
    const tab = await screen.findByRole("tab", { name: "入駐審核" });
    expect(tab).toHaveAttribute("href", "/admin/applications");
    expect(screen.queryByRole("tab", { name: /（/ })).toBeNull();
  });

  it("在會員分區裡換分頁會重查一次(審完回來數字會更新)", async () => {
    let pending = 2;
    fakeSupabase.respond((q) => (q.table === "supplier_applications" ? { count: pending } : undefined));
    renderLayout("/admin/applications");
    expect(await screen.findByRole("tab", { name: "入駐審核（2）" })).toBeInTheDocument();

    pending = 1;
    fireEvent.click(screen.getByRole("tab", { name: "餐廳" }));
    expect(await screen.findByRole("tab", { name: "入駐審核（1）" })).toBeInTheDocument();
    expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(2);
  });

  it("待審數晚一點才回來:側欄不會被整個重建,鍵盤焦點留在原本的連結上", async () => {
    let release: (res: { count: number }) => void = () => undefined;
    fakeSupabase.respond((q) =>
      q.table === "supplier_applications" ? new Promise((resolve) => (release = resolve)) : undefined,
    );
    renderLayout("/admin/restaurants");
    await waitFor(() => expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1));

    const link = within(screen.getByTestId("admin-sidebar-desktop")).getByRole("link", { name: "會員" });
    link.focus();
    expect(link).toHaveFocus();

    release({ count: 4 });
    expect(await screen.findByRole("tab", { name: "入駐審核（4）" })).toBeInTheDocument();
    expect(link).toBeInTheDocument(); // 還是同一個 DOM 節點
    expect(link).toHaveFocus();
  });

  it("入駐審核頁是原地核准、不換網址:視窗重新拿到焦點、或每 30 秒,待審數會自己更新", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let pending = 3;
      fakeSupabase.respond((q) => (q.table === "supplier_applications" ? { count: pending } : undefined));
      renderLayout("/admin/applications");
      expect(await screen.findByRole("tab", { name: "入駐審核（3）" })).toBeInTheDocument();

      pending = 2; // 在頁面上核准了一筆
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(await screen.findByRole("tab", { name: "入駐審核（2）" })).toBeInTheDocument();

      pending = 1; // 又核准一筆,這次什麼都沒點
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(await screen.findByRole("tab", { name: "入駐審核（1）" })).toBeInTheDocument();
      expect(screen.getAllByRole("tab").map((t) => t.getAttribute("href"))).toContain("/admin/applications");
    } finally {
      vi.useRealTimers();
    }
  });

  it("分頁在背景時不自動重查;切回前景(visibilitychange)才重查", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      let pending = 5;
      fakeSupabase.respond((q) => (q.table === "supplier_applications" ? { count: pending } : undefined));
      renderLayout("/admin/applications");
      expect(await screen.findByRole("tab", { name: "入駐審核（5）" })).toBeInTheDocument();
      expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1);

      // 使用者切到別的瀏覽器分頁:30 秒一次的輪詢不查
      visibility = "hidden";
      pending = 4;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1);

      // 切回來:馬上重查
      visibility = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(await screen.findByRole("tab", { name: "入駐審核（4）" })).toBeInTheDocument();
      expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(2);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("兩個重查請求同時在路上、先送的比較晚回來:畫面採用最後送出的那個,舊數字不會蓋掉新數字", async () => {
    const answers: Array<(res: { count: number }) => void> = [];
    fakeSupabase.respond((q) =>
      q.table === "supplier_applications" ? new Promise((resolve) => answers.push(resolve)) : undefined,
    );
    renderLayout("/admin/applications");
    await waitFor(() => expect(answers).toHaveLength(1));
    answers[0]({ count: 3 });
    expect(await screen.findByRole("tab", { name: "入駐審核（3）" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("focus")); // 請求 A(送出時還沒核准)
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange")); // 請求 B(核准之後)
    });
    await waitFor(() => expect(answers).toHaveLength(3));

    answers[2]({ count: 2 }); // B 先回來
    expect(await screen.findByRole("tab", { name: "入駐審核（2）" })).toBeInTheDocument();
    answers[1]({ count: 3 }); // A 很晚才回來,帶著舊數字
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("tab", { name: "入駐審核（2）" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "入駐審核（3）" })).toBeNull();
  });

  it("離開會員分區就停止自動重查", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderLayout("/admin/applications");
      await waitFor(() => expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1));

      fireEvent.click(within(screen.getByTestId("admin-sidebar-desktop")).getByRole("link", { name: "訂單" }));
      expect(await screen.findByRole("heading", { name: "交易看板頁" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("不在會員分區時不查待審數(不在每一頁多打一個查詢)", async () => {
    renderLayout("/admin/orders");
    await waitFor(() => expect(screen.getByRole("main")).toBeInTheDocument());
    expect(fakeSupabase.queriesOf("supplier_applications")).toHaveLength(0);
  });
});

describe("AdminLayout — 手機頂欄與抽屜", () => {
  it("抽屜開著時,不是點抽屜裡的連結而是從別處換頁(例如分頁列、瀏覽器上一頁),抽屜也會收起來", async () => {
    const user = userEvent.setup();
    renderLayout("/admin/pipeline");
    await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "開啟選單" }));
    expect(screen.getByTestId("admin-sidebar-mobile")).toHaveClass("translate-x-0");

    // 分頁列在主內容區,不在抽屜裡 —— 抽屜本身的 onClick 管不到它
    fireEvent.click(screen.getByRole("tab", { name: "全部訂單" }));
    expect(await screen.findByRole("heading", { name: "供應商訂單頁" })).toBeInTheDocument();
    expect(screen.getByTestId("admin-sidebar-mobile")).toHaveClass("-translate-x-full");
  });

  it("頂欄顯示目前分區;選單鈕有名字,點了展開抽屜,換頁後自動收起", async () => {
    const user = userEvent.setup();
    renderLayout("/admin/pipeline");

    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("訂單");
    const menuButton = within(header).getByRole("button", { name: "開啟選單" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("admin-sidebar-mobile")).toHaveClass("-translate-x-full");

    await user.click(menuButton);
    expect(within(header).getByRole("button", { name: "關閉選單" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("admin-sidebar-mobile")).toHaveClass("translate-x-0");

    await user.click(within(screen.getByTestId("admin-sidebar-mobile")).getByRole("link", { name: "會員" }));
    expect(await screen.findByRole("heading", { name: "餐廳管理頁" })).toBeInTheDocument();
    expect(screen.getByTestId("admin-sidebar-mobile")).toHaveClass("-translate-x-full");
    expect(screen.getByRole("banner")).toHaveTextContent("會員");
  });
});
