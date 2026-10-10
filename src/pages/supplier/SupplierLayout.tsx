import { Link, Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  Inbox, Boxes, Radar, Users, LogOut,
  LayoutDashboard, Menu, X, Store, type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import PortalSwitcher from "@/components/PortalSwitcher";
import SectionTabs, { type SectionTabItem } from "@/components/portal/SectionTabs";
import { useEffect, useState } from "react";

// 後台精簡第一期:11 個選單項目收成 5 個分區,分區裡用分頁(深連結到原本的路由)。
// 路由完全不動 —— 分頁只是指向原路由的連結,所以通知信、書籤都不受影響。
// 這份 `sections` 是「分區怎麼分」唯一的事實來源,側邊欄與分頁列都從這裡讀。
interface SupplierSection {
  key: string;
  /** 側邊欄點下去要去哪,通常是這個分區第一個分頁的路徑 */
  to: string;
  label: string;
  icon: LucideIcon;
  /** 目前路由是否落在這個分區(一個分區可能對應好幾條路由) */
  match: (pathname: string) => boolean;
  /** 分區內的分頁;沒有分頁可切的分區(目前只有總覽)留 undefined */
  tabs?: SectionTabItem[];
}

const startsWithAny = (bases: string[]) => (pathname: string) =>
  bases.some((base) => pathname === base || pathname.startsWith(`${base}/`));

const sections: SupplierSection[] = [
  {
    key: "overview",
    to: "/supplier",
    label: "總覽",
    icon: LayoutDashboard,
    match: (pathname) => pathname === "/supplier",
  },
  {
    key: "orders",
    to: "/supplier/orders",
    label: "訂單",
    icon: Inbox,
    // 第二期(Q1-A):收單/報價/出貨合成一個訂單頁,頁面自己用狀態分頁(?stage=),這裡不再畫分頁列。
    // 舊網址 /supplier/quotes、/supplier/shipments、/supplier/logistics 在 App.tsx 轉址到對應的狀態分頁。
    match: startsWithAny(["/supplier/orders", "/supplier/quotes", "/supplier/shipments", "/supplier/logistics"]),
  },
  {
    key: "leads",
    to: "/supplier/leads",
    label: "商機",
    icon: Radar,
    match: startsWithAny(["/supplier/leads", "/supplier/forecast"]),
    tabs: [
      { label: "商機雷達", path: "/supplier/leads" },
      { label: "需求與備貨", path: "/supplier/forecast" },
    ],
  },
  {
    key: "catalog",
    to: "/supplier/catalog",
    label: "商品與價格",
    icon: Boxes,
    match: startsWithAny(["/supplier/catalog", "/supplier/pricing"]),
    tabs: [
      { label: "商品目錄", path: "/supplier/catalog" },
      // 業主拍板(QUESTIONS.md Q6-A):定價助手從選單收起來 —— 路由保留,直接打網址仍可用
      { label: "行情比價", path: "/supplier/pricing", hidden: true },
    ],
  },
  {
    key: "customers",
    to: "/supplier/customers",
    label: "客戶與評價",
    icon: Users,
    match: startsWithAny(["/supplier/customers", "/supplier/reviews"]),
    tabs: [
      { label: "客戶", path: "/supplier/customers" },
      { label: "評價", path: "/supplier/reviews" },
    ],
  },
  {
    // 消費者食材市集(B2C):跟餐廳的詢價訂單完全分開。零售商品在「商品與價格 › 商品目錄」的「零售商品」分頁
    key: "market",
    to: "/supplier/market/store",
    label: "零售市集",
    icon: Store,
    match: startsWithAny(["/supplier/market"]),
    tabs: [{ label: "店家設定", path: "/supplier/market/store" }],
  },
];

/** 分頁列控制的內容區塊 id,給 SectionTabs 的 aria-controls 用 */
const MAIN_PANEL_ID = "supplier-main-panel";

export default function SupplierLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setEmail(session?.user?.email ?? "");
    });
  }, []);

  // 換頁就把抽屜收起來 —— 不然點完選單還留在畫面上擋住內容
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  const activeSection = sections.find((section) => section.match(location.pathname)) ?? sections[0];

  const Sidebar = () => (
    <div className="flex flex-col h-full w-60 bg-white border-r border-gray-200">
      <div className="px-5 py-5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <span className="text-lg">🏭</span>
          <span className="font-bold text-emerald-700 text-sm">供應商入口</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">Supplier Portal</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="供應商後台導覽">
        {sections.map(({ key, to, label, icon: Icon }) => {
          const active = activeSection.key === key;
          return (
            <Link
              key={key}
              to={to}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-emerald-50 text-emerald-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-gray-100 space-y-2">
        <PortalSwitcher current="supplier" tone="light" />
        <p className="text-xs text-gray-400 truncate">{email}</p>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 text-xs text-gray-500 hover:text-red-500 transition-colors"
        >
          <LogOut size={13} />
          登出
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* 桌機:固定側邊欄 */}
      <div data-testid="supplier-sidebar-desktop" className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-60">
        <Sidebar />
      </div>

      {/* 手機:點遮罩關抽屜 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 手機:滑出式抽屜。原本是 flex-shrink-0 的 w-60 aside,
          在 390px 螢幕上會把內容擠到只剩 150px —— 金額直接被切掉、
          標籤一個字一行,等於不能用。 */}
      <div
        data-testid="supplier-sidebar-mobile"
        className={`fixed inset-y-0 left-0 z-50 flex flex-col md:hidden transition-transform duration-200 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar />
      </div>

      <div className="flex flex-col flex-1 min-w-0 md:pl-60">
        {/* 手機頂欄 */}
        <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen((v) => !v)}>
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <span className="font-semibold text-gray-800 truncate">{activeSection.label}</span>
        </header>

        <main className="flex-1 min-w-0 overflow-x-hidden">
          {activeSection.tabs && (
            <SectionTabs
              tabs={activeSection.tabs}
              ariaLabel={`${activeSection.label}分頁`}
              panelId={MAIN_PANEL_ID}
              className="bg-white"
            />
          )}
          <div id={MAIN_PANEL_ID}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
