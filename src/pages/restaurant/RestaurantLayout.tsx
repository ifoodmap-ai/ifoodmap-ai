import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Sparkles, PackageCheck, UtensilsCrossed, Settings,
  LogOut, Menu, X, type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useRestaurant, canSeeCost } from "@/components/RestaurantRoute";
import PortalSwitcher from "@/components/PortalSwitcher";
import AIAssistantBubble from "@/components/AIAssistantBubble";
import SectionTabs, { type SectionTabItem } from "@/components/portal/SectionTabs";
import { useLandingHandoffClaim } from "@/hooks/use-landing-handoff-claim";

// 後台精簡第一期(PROPOSAL.md §2):10 個選單項目收成 5 個分區,分區裡用分頁(深連結到原本的路由)。
// 路由一條都沒動、也不需要轉址 —— 通知信(/restaurant/orders)、AI 交接(/restaurant/purchase)、
// AI 泡泡(/restaurant/analyze)、書籤都照舊能開,只是畫面上落在對應的分區與分頁。
// 這份 sections 是「分區怎麼分」唯一的事實來源:側邊欄、分頁列、成本分區擋路由都從這裡讀。
interface RestaurantSection {
  key: string;
  /** 側邊欄點下去要去哪 */
  to: string;
  label: string;
  icon: LucideIcon;
  /** 目前路由是否落在這個分區(一個分區可能對應好幾條路由) */
  match: (pathname: string) => boolean;
  /** 分區內的分頁;沒有分頁可切的分區留 undefined */
  tabs?: SectionTabItem[];
  /** 只給老闆/店長(canSeeCost):採購員的選單看不到,直接打網址也會被導回總覽 */
  costOnly?: boolean;
}

const startsWithAny = (bases: string[]) => (pathname: string) =>
  bases.some((base) => pathname === base || pathname.startsWith(`${base}/`));

const sections: RestaurantSection[] = [
  {
    key: "overview",
    to: "/restaurant",
    label: "總覽",
    icon: LayoutDashboard,
    match: (pathname) => pathname === "/restaurant" || pathname === "/restaurant/",
  },
  {
    // 不動:AI 泡泡與分析頁的簡化是另一條工作線
    key: "analyze",
    to: "/restaurant/analyze",
    label: "AI 菜單分析",
    icon: Sparkles,
    match: startsWithAny(["/restaurant/analyze"]),
  },
  {
    // 選單點下去預設「訂單」—— 每封訂單通知信也都連這裡
    key: "orders",
    to: "/restaurant/orders",
    label: "叫貨與訂單",
    icon: PackageCheck,
    match: startsWithAny(["/restaurant/purchase", "/restaurant/orders", "/restaurant/suppliers"]),
    tabs: [
      { label: "叫貨", path: "/restaurant/purchase" },
      { label: "訂單", path: "/restaurant/orders" },
      { label: "供應商", path: "/restaurant/suppliers" },
    ],
  },
  {
    key: "menu",
    to: "/restaurant/menu",
    label: "菜單與成本",
    icon: UtensilsCrossed,
    costOnly: true,
    match: startsWithAny(["/restaurant/menu", "/restaurant/costs", "/restaurant/lab"]),
    tabs: [
      { label: "我的菜單", path: "/restaurant/menu" },
      { label: "食材行情", path: "/restaurant/costs" },
      { label: "新菜實驗室", path: "/restaurant/lab" },
    ],
  },
  {
    key: "settings",
    to: "/restaurant/settings",
    label: "設定",
    icon: Settings,
    match: startsWithAny(["/restaurant/settings", "/restaurant/team"]),
    tabs: [
      { label: "店家資料", path: "/restaurant/settings" },
      { label: "分店與成員", path: "/restaurant/team" },
    ],
  },
];

/** 分頁列控制的內容區塊 id,給 SectionTabs 的 aria-controls 用 */
const MAIN_PANEL_ID = "restaurant-main-panel";

const ROLE_LABEL: Record<string, string> = {
  owner: "老闆",
  manager: "店長",
  purchaser: "採購員",
};

const RestaurantLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const account = useRestaurant();
  const [mobileOpen, setMobileOpen] = useState(false);
  // 形象站 AI 對話帶過來的需求 → 採購單草稿。認領只在這裡做(註冊、換裝置開確認信、改成登入都會經過);
  // 帶上畫面正在用的這家店,草稿才會建在使用者看得到的地方(多店的人不會建到另一家)
  useLandingHandoffClaim(account.restaurant_id);

  const showCost = canSeeCost(account.role);
  // 採購員看不到成本相關的分區(整個「菜單與成本」)
  const visibleSections = sections.filter((s) => !s.costOnly || showCost);
  const activeSection = sections.find((s) => s.match(location.pathname)) ?? sections[0];
  // 💰 原本只藏選單、不擋路由:採購員打網址仍進得去,還能編輯菜單。分區殼順便擋掉
  const blocked = !!activeSection.costOnly && !showCost;

  // 換頁就把抽屜收起來(點分頁列換頁時也一樣)
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  const Sidebar = () => (
    <div className="flex flex-col h-full w-64 bg-emerald-950 text-white">
      <div className="px-6 py-5 border-b border-emerald-800">
        <span className="text-lg font-semibold tracking-tight block truncate">
          {account.restaurant_name}
        </span>
        <span className="text-xs text-emerald-300">
          {ROLE_LABEL[account.role] ?? account.role} · 餐廳後台
        </span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="餐廳後台導覽">
        {visibleSections.map(({ key, to, label, icon: Icon }) => {
          const active = activeSection.key === key;
          return (
            <Link
              key={key}
              to={to}
              aria-current={active ? "page" : undefined}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active
                  ? "bg-emerald-800 text-white"
                  : "text-emerald-100 hover:bg-emerald-900 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-4 border-t border-emerald-800 space-y-2">
        <PortalSwitcher current="restaurant" tone="dark" />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="w-full justify-start text-emerald-100 hover:text-white hover:bg-emerald-900"
        >
          <LogOut className="h-4 w-4 mr-2" />
          登出
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      <div data-testid="restaurant-sidebar-desktop" className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-64">
        <Sidebar />
      </div>

      {mobileOpen && (
        <div data-testid="restaurant-sidebar-mobile" className="md:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative z-50">
            <Sidebar />
          </div>
        </div>
      )}

      {/* min-w-0 同 AdminLayout:讓寬表格自己橫向捲,不要撐寬整頁 */}
      <div className="flex-1 min-w-0 md:pl-64 w-full">
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-emerald-950 text-white">
          <span className="font-semibold truncate">{account.restaurant_name}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "關閉選單" : "開啟選單"}
            aria-expanded={mobileOpen}
            className="text-white hover:bg-emerald-900"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </header>
        {activeSection.tabs && !blocked && (
          <SectionTabs
            tabs={activeSection.tabs}
            ariaLabel={`${activeSection.label}分頁`}
            panelId={MAIN_PANEL_ID}
            className="bg-white"
          />
        )}
        {/* 底部多留 pb-40(160px):右下角的 AI 小助手泡泡(距底 18–88px)與小標籤(距底 100–144px)
            不能蓋住頁尾最後一個按鈕 —— 捲到底時它要停在兩者上方 */}
        <main id={MAIN_PANEL_ID} className="p-4 pb-40 md:p-8 md:pb-40 max-w-7xl mx-auto">
          {blocked ? <Navigate to="/restaurant" replace /> : <Outlet />}
        </main>
      </div>

      {/* AI 小助手:每一頁都看得到;對話送出需求後,使用者按下才帶去「AI 菜單分析」頁 */}
      <AIAssistantBubble />
    </div>
  );
};

export default RestaurantLayout;
