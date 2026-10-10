import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, Sparkles, Users, Carrot, Wallet, Settings, Store,
  LogOut, Menu, X, type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import PortalSwitcher from '@/components/PortalSwitcher';
import AIAssistantBubble from '@/components/AIAssistantBubble';
import SectionTabs, { type SectionTabItem } from '@/components/portal/SectionTabs';
import { usePendingApplicationCount } from './adminCounts';

// 後台精簡第一期:選單從 23 項(5 組)收成 7 個分區,分區裡用分頁(深連結到原本的路由)。
// 路由幾乎不動 —— 分頁只是指向原路由的連結,書籤、Email 連結、既有測試都不受影響;
// 唯一的轉址是 /admin/orders/:id/timeline → /admin/orders/:id(兩個單筆訂單頁併成一頁,見 App.tsx)。
// 這份 SECTIONS 是「分區怎麼分」唯一的事實來源,側邊欄與分頁列都從這裡讀。
// 對照與理由見 scratchpad portals/PROPOSAL.md §1;業主拍板見 QUESTIONS.md Q3/Q4/Q6(都選 A)。

interface TabContext {
  pathname: string;
  /** 待審入駐數;還沒查到或查詢失敗是 null */
  pendingApplications: number | null;
}

interface AdminTab extends SectionTabItem {
  /** 依目前狀態調整這個分頁(例如標題帶待審數),回傳交給 SectionTabs 的那一份 */
  resolve?: (tab: SectionTabItem, ctx: TabContext) => SectionTabItem;
}

interface AdminSection {
  key: string;
  /** 側邊欄點下去要去哪 —— 這個分區第一個分頁 */
  to: string;
  label: string;
  icon: LucideIcon;
  /** 目前路由是否落在這個分區(一個分區對應好幾條路由) */
  match: (pathname: string) => boolean;
  tabs: AdminTab[];
}

const startsWithAny = (bases: string[]) => (pathname: string) =>
  bases.some((base) => pathname === base || pathname.startsWith(`${base}/`));

/** 總覽首頁本身(營運分頁) */
const isOverviewHome = (pathname: string) => pathname === '/admin' || pathname === '/admin/';

const SECTIONS: AdminSection[] = [
  {
    key: 'overview',
    to: '/admin',
    label: '總覽',
    icon: LayoutDashboard,
    match: (pathname) => isOverviewHome(pathname) || startsWithAny(['/admin/growth'])(pathname),
    tabs: [
      {
        key: 'overview-ops',
        label: '營運',
        path: '/admin',
        // SectionTabs 用「前綴」判斷目前在哪個分頁,而 /admin 是每一條管理員網址的前綴 ——
        // 直接給 "/admin",停在 /admin/growth 時「營運」也會被標成選中。SectionTabs 目前沒有
        // 「完全相符」的選項(這一期不能改它,已回報建議加 end 旗標),所以不在 /admin 本身時,
        // 「營運」改用相對路徑 "."(相對於 /admin 這個版面路由):連結一樣解析成 /admin,但不會被當成前綴比中。
        resolve: (tab, { pathname }) => (isOverviewHome(pathname) ? tab : { ...tab, path: '.' }),
      },
      { key: 'overview-growth', label: '成長', path: '/admin/growth' },
    ],
  },
  {
    key: 'orders',
    to: '/admin/pipeline',
    label: '訂單',
    icon: Package,
    // 單筆訂單 /admin/orders/:id 也落在這個分區(「全部訂單」分頁底下)
    match: startsWithAny(['/admin/pipeline', '/admin/orders', '/admin/disputes']),
    tabs: [
      { label: '看板', path: '/admin/pipeline' },
      { label: '全部訂單', path: '/admin/orders' },
      { label: '爭議', path: '/admin/disputes' },
    ],
  },
  {
    key: 'demand',
    to: '/admin/analyses',
    label: '需求與媒合',
    icon: Sparkles,
    match: startsWithAny(['/admin/analyses', '/admin/matching', '/admin/forecast', '/admin/match-quality']),
    tabs: [
      { label: 'AI 分析紀錄', path: '/admin/analyses' },
      // 原「智慧媒合」:它只比價、不會媒合,所以分頁照實叫「供應商比價」
      { label: '供應商比價', path: '/admin/matching' },
      { label: '需求預測', path: '/admin/forecast' },
      { label: '供給缺口與品質', path: '/admin/match-quality' },
    ],
  },
  {
    key: 'members',
    to: '/admin/restaurants',
    label: '會員',
    icon: Users,
    match: startsWithAny([
      '/admin/restaurants', '/admin/suppliers', '/admin/applications', '/admin/accounts', '/admin/campaigns',
    ]),
    tabs: [
      { label: '餐廳', path: '/admin/restaurants' },
      { label: '供應商', path: '/admin/suppliers' },
      {
        key: 'members-applications',
        label: '入駐審核',
        path: '/admin/applications',
        // 有待審的申請就把數字帶在分頁標題上;0 筆或查詢失敗只顯示名稱(不顯示錯的數字)
        resolve: (tab, { pendingApplications }) =>
          pendingApplications ? { ...tab, label: `${tab.label}（${pendingApplications}）` } : tab,
      },
      { label: '帳號', path: '/admin/accounts' },
      // 原「推播與活動」(Q6-A:保留,但只放在分區的分頁裡)。它沒有推播功能,是分眾名單產生器
      { label: '分眾名單', path: '/admin/campaigns' },
    ],
  },
  {
    key: 'master-data',
    to: '/admin/ingredients',
    label: '食材資料',
    icon: Carrot,
    match: startsWithAny(['/admin/ingredients', '/admin/substitutes', '/admin/dishes', '/admin/prices']),
    tabs: [
      { label: '食材主檔', path: '/admin/ingredients' },
      { label: '替代關係', path: '/admin/substitutes' },
      { label: '菜色對應', path: '/admin/dishes' },
      // 原「價格資料維護」:它是唯讀報表,改不了任何資料
      { label: '價格檢查', path: '/admin/prices' },
    ],
  },
  {
    key: 'finance',
    to: '/admin/revenue',
    label: '財務',
    icon: Wallet,
    match: startsWithAny(['/admin/revenue', '/admin/billing']),
    tabs: [
      { label: '營收與抽成', path: '/admin/revenue' },
      // Q6-A:金流/發票仍是沙盒(demo 手冊「現場絕對不要碰」),從選單收起來 ——
      // 路由保留、直接打 /admin/billing 仍然可以用,側欄照樣標出「財務」
      { label: '金流／發票（沙盒）', path: '/admin/billing', hidden: true },
    ],
  },
  {
    // 消費者食材市集(B2C,2026-10):商品審核、零售店家(第 2 階段加零售訂單)
    key: 'market',
    to: '/admin/market/products',
    label: '零售市集',
    icon: Store,
    match: startsWithAny(['/admin/market']),
    tabs: [
      { label: '商品審核', path: '/admin/market/products' },
      { label: '零售店家', path: '/admin/market/stores' },
    ],
  },
  {
    key: 'system',
    to: '/admin/ai-ops',
    label: '系統',
    icon: Settings,
    match: startsWithAny(['/admin/ai-ops', '/admin/notifications', '/admin/roadmap']),
    tabs: [
      { label: 'AI 用量', path: '/admin/ai-ops' },
      { label: '通知紀錄', path: '/admin/notifications' },
      // 原「發展藍圖」(Q6-A:保留在分頁裡):它是投資人頁 /investors 的內容後台
      { label: '投資人頁內容', path: '/admin/roadmap' },
    ],
  },
];

/** 分頁列控制的內容區塊 id,給 SectionTabs 的 aria-controls 用 */
const MAIN_PANEL_ID = 'admin-main-panel';

const AdminLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserEmail(session?.user?.email ?? null);
    });
  }, []);

  // 換頁就把手機抽屜收起來(點分頁、點今日待辦、瀏覽器上一頁都算)
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  const activeSection = SECTIONS.find((section) => section.match(location.pathname)) ?? SECTIONS[0];

  // 待審數字只在會員分區(看得到「入駐審核」分頁的時候)才查;什麼時候重查見 usePendingApplicationCount
  const pendingApplications = usePendingApplicationCount(activeSection.key === 'members', location.pathname);

  const tabs = useMemo<SectionTabItem[]>(
    () =>
      activeSection.tabs.map(({ resolve, ...tab }) =>
        resolve ? resolve(tab, { pathname: location.pathname, pendingApplications }) : tab,
      ),
    [activeSection, location.pathname, pendingApplications],
  );

  // 側欄是「元素」不是在這裡宣告的元件:在 render 裡宣告元件,每次版面重畫(換頁、待審數回來)
  // 都會被當成新的元件整個卸載重建 —— 側欄裡的鍵盤焦點會掉,PortalSwitcher 也會一直重查身分。
  const sidebar = (
    <div className="flex flex-col h-full w-64 bg-slate-900 text-white">
      <div className="px-6 py-5 border-b border-slate-700">
        <span className="text-lg font-semibold tracking-tight">ifoodmap Admin</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="管理員後台導覽">
        {SECTIONS.map(({ key, to, label, icon: Icon }) => {
          const active = activeSection.key === key;
          return (
            <Link
              key={key}
              to={to}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                active ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-4 border-t border-slate-700 space-y-2">
        <PortalSwitcher current="admin" tone="dark" />
        {userEmail && (
          <p className="text-xs text-slate-400 truncate px-1">{userEmail}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="w-full justify-start text-slate-300 hover:text-white hover:bg-slate-800"
        >
          <LogOut className="h-4 w-4 mr-2" />
          登出 (Logout)
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* 桌機:固定側邊欄 */}
      <div data-testid="admin-sidebar-desktop" className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:w-64">
        {sidebar}
      </div>

      {/* 手機:點遮罩關抽屜 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 手機:滑出式抽屜 */}
      <div
        data-testid="admin-sidebar-mobile"
        className={`fixed inset-y-0 left-0 z-50 flex flex-col md:hidden transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </div>

      {/* Main content */}
      {/* min-w-0 是必要的,不是保險:flex 子元素預設 min-width:auto,會被內容
          撐開而不是縮到容器寬。少了它,底下那些已經寫了 overflow-x-auto 的
          寬表格與看板不會自己捲,而是把整頁撐寬(實測 /admin/pipeline 在 390px
          螢幕上撐到 3376px)。 */}
      <div className="flex flex-col flex-1 min-w-0 md:pl-64">
        {/* 手機頂欄:顯示目前在哪個分區 */}
        <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-200 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label={mobileOpen ? '關閉選單' : '開啟選單'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <span className="font-semibold text-slate-800 truncate">{activeSection.label}</span>
        </header>

        {/* 底部多留 pb-40(160px):右下角的 AI 助手泡泡(距底 18–88px)與小標籤(距底 100–144px)
            不能蓋住表格底下靠右的分頁按鈕 —— 捲到底時它要停在兩者上方 */}
        <main className="flex-1 min-w-0 pb-40">
          <SectionTabs
            tabs={tabs}
            ariaLabel={`${activeSection.label}分頁`}
            panelId={MAIN_PANEL_ID}
            className="bg-white"
          />
          <div id={MAIN_PANEL_ID} className="px-6 pt-6">
            <Outlet />
          </div>
        </main>
      </div>

      {/* AI 助手:管理員站是另一個網站,沒有 /restaurant/* —— admin 模式純對話,不導頁 */}
      <AIAssistantBubble variant="admin" />
    </div>
  );
};

export default AdminLayout;
