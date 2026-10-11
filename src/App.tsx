// 路由總表。
//
// 同一份 codebase 部署成兩個 Vercel 站,用建置變數 VITE_PORTAL 分流:
//   VITE_PORTAL=admin  → ifoodmap-admin.vercel.app,只有平台營運後台
//   (未設定)          → app.ifoodmap.ai(Vercel 專案 dish-to-supply),餐廳 + 供應商 + 公開頁
//
// 管理員後台刻意不出現在客戶看得到的站上。

import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { IS_ADMIN_BUILD } from "@/lib/portal";

import LoginPortal from "./pages/LoginPortal";
import RestaurantRegisterPage from "./pages/RestaurantRegisterPage";
import RegisterCompletePage from "./pages/RegisterCompletePage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import NotFound from "./pages/NotFound";

// 公開頁(僅前台站)
import SupplierDetail from "./pages/SupplierDetail";
import Architecture from "./pages/Architecture";
import InvestorsPage from "./pages/InvestorsPage";
import JoinSupplierPage from "./pages/JoinSupplierPage";
import SuppliersPage from "./pages/SuppliersPage";
import BuyerPortalPage from "./pages/BuyerPortalPage";
import PriceIndexPage from "./pages/PriceIndexPage";

// 消費者食材市集(僅前台站,免登入)
import MarketLayout from "./components/market/MarketLayout";
import MarketHomePage from "./pages/market/MarketHomePage";
import MarketProductPage from "./pages/market/MarketProductPage";
import MarketStorePage from "./pages/market/MarketStorePage";
import MarketNotFound from "./pages/market/MarketNotFound";
import MarketCartPage from "./pages/market/MarketCartPage";
import MarketCheckoutPage from "./pages/market/MarketCheckoutPage";
import MarketOrderLookupPage from "./pages/market/MarketOrderLookupPage";
import MarketLegalPage from "./pages/market/MarketLegalPage";

// 平台營運後台(僅 admin 站)
import AdminRoute from "./components/AdminRoute";
import AdminLayout from "./pages/admin/AdminLayout";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AnalysisListPage from "./pages/admin/AnalysisListPage";
import AnalysisDetailPage from "./pages/admin/AnalysisDetailPage";
import AdminOrdersPage from "./pages/admin/AdminOrdersPage";
import AdminOrderDetailPage from "./pages/admin/AdminOrderDetailPage";
import AdminOrderTimelinePage from "./pages/admin/AdminOrderTimelinePage";
import AdminPipelinePage from "./pages/admin/AdminPipelinePage";
import AdminRoadmapPage from "./pages/admin/AdminRoadmapPage";
import AdminApplicationsPage from "./pages/admin/AdminApplicationsPage";
import AdminMatchingPage from "./pages/admin/AdminMatchingPage";
import AdminForecastPage from "./pages/admin/AdminForecastPage";
import AdminBillingPage from "./pages/admin/AdminBillingPage";
import AdminNotificationsPage from "./pages/admin/AdminNotificationsPage";
import AdminRestaurantsPage from "./pages/admin/AdminRestaurantsPage";
import AdminSuppliersPage from "./pages/admin/AdminSuppliersPage";
import AdminAccountsPage from "./pages/admin/AdminAccountsPage";
import AdminIngredientsPage from "./pages/admin/AdminIngredientsPage";
import AdminDishMappingPage from "./pages/admin/AdminDishMappingPage";
import AdminSubstitutesPage from "./pages/admin/AdminSubstitutesPage";
import AdminPricesPage from "./pages/admin/AdminPricesPage";
import AdminMatchQualityPage from "./pages/admin/AdminMatchQualityPage";
import AdminAiOpsPage from "./pages/admin/AdminAiOpsPage";
import AdminDisputesPage from "./pages/admin/AdminDisputesPage";
import AdminRevenuePage from "./pages/admin/AdminRevenuePage";
import AdminGrowthPage from "./pages/admin/AdminGrowthPage";
import AdminCampaignsPage from "./pages/admin/AdminCampaignsPage";
import AdminMarketProductsPage from "./pages/admin/AdminMarketProductsPage";
import AdminMarketStoresPage from "./pages/admin/AdminMarketStoresPage";
import AdminMarketOrdersPage from "./pages/admin/AdminMarketOrdersPage";

// 供應商後台(僅前台站)
import SupplierRoute from "./components/SupplierRoute";
import SupplierLayout from "./pages/supplier/SupplierLayout";
import SupplierDashboard from "./pages/supplier/SupplierDashboard";
import SupplierOrdersPage from "./pages/supplier/SupplierOrdersPage";
import SupplierCatalogPage from "./pages/supplier/SupplierCatalogPage";
import SupplierLeadsPage from "./pages/supplier/SupplierLeadsPage";
import SupplierPricingPage from "./pages/supplier/SupplierPricingPage";
import SupplierForecastPage from "./pages/supplier/SupplierForecastPage";
import SupplierCustomersPage from "./pages/supplier/SupplierCustomersPage";
import SupplierReviewsPage from "./pages/supplier/SupplierReviewsPage";
import SupplierMarketStorePage from "./pages/supplier/SupplierMarketStorePage";
import SupplierMarketOrdersPage from "./pages/supplier/SupplierMarketOrdersPage";

// 餐廳後台(僅前台站)
import RestaurantRoute from "./components/RestaurantRoute";
import RestaurantLayout from "./pages/restaurant/RestaurantLayout";
import RestaurantDashboard from "./pages/restaurant/RestaurantDashboard";
import RestaurantAnalyzePage from "./pages/restaurant/RestaurantAnalyzePage";
import RestaurantMenuPage from "./pages/restaurant/RestaurantMenuPage";
import RestaurantPurchasePage from "./pages/restaurant/RestaurantPurchasePage";
import RestaurantOrdersPage from "./pages/restaurant/RestaurantOrdersPage";
import RestaurantCostsPage from "./pages/restaurant/RestaurantCostsPage";
import RestaurantSuppliersPage from "./pages/restaurant/RestaurantSuppliersPage";
import RestaurantLabPage from "./pages/restaurant/RestaurantLabPage";
import RestaurantTeamPage from "./pages/restaurant/RestaurantTeamPage";
import RestaurantSettingsPage from "./pages/restaurant/RestaurantSettingsPage";

const queryClient = new QueryClient();

const AdminRoutes = () => (
  <Routes>
    <Route path="/" element={<LoginPortal />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />
    <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
      <Route index element={<AdminDashboard />} />
      <Route path="pipeline" element={<AdminPipelinePage />} />
      <Route path="analyses" element={<AnalysisListPage />} />
      <Route path="analyses/:id" element={<AnalysisDetailPage />} />
      <Route path="orders" element={<AdminOrdersPage />} />
      <Route path="orders/:id" element={<AdminOrderDetailPage />} />
      {/* 後台精簡第一期:舊明細與「訂單履歷」併成 /admin/orders/:id 一頁(以履歷為底),
          舊的 /timeline 網址轉址過去 —— 管理員後台唯一的一條轉址(PROPOSAL.md §1)。
          relative="path":".." 是去掉網址最後一段(/timeline),不是回上一層路由 */}
      <Route path="orders/:id/timeline" element={<Navigate to=".." relative="path" replace />} />
      <Route path="matching" element={<AdminMatchingPage />} />
      <Route path="forecast" element={<AdminForecastPage />} />
      <Route path="restaurants" element={<AdminRestaurantsPage />} />
      <Route path="suppliers" element={<AdminSuppliersPage />} />
      <Route path="applications" element={<AdminApplicationsPage />} />
      <Route path="accounts" element={<AdminAccountsPage />} />
      <Route path="ingredients" element={<AdminIngredientsPage />} />
      <Route path="dishes" element={<AdminDishMappingPage />} />
      <Route path="substitutes" element={<AdminSubstitutesPage />} />
      <Route path="prices" element={<AdminPricesPage />} />
      <Route path="match-quality" element={<AdminMatchQualityPage />} />
      <Route path="ai-ops" element={<AdminAiOpsPage />} />
      <Route path="disputes" element={<AdminDisputesPage />} />
      <Route path="revenue" element={<AdminRevenuePage />} />
      <Route path="billing" element={<AdminBillingPage />} />
      <Route path="growth" element={<AdminGrowthPage />} />
      <Route path="campaigns" element={<AdminCampaignsPage />} />
      <Route path="notifications" element={<AdminNotificationsPage />} />
      <Route path="roadmap" element={<AdminRoadmapPage />} />
      {/* 消費者食材市集(B2C) */}
      <Route path="market/products" element={<AdminMarketProductsPage />} />
      <Route path="market/stores" element={<AdminMarketStoresPage />} />
      <Route path="market/orders" element={<AdminMarketOrdersPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);

const MainRoutes = () => (
  <Routes>
    {/* 登入首頁 —— 登出後看到的第一個畫面 */}
    <Route path="/" element={<LoginPortal />} />
    <Route path="/reset-password" element={<ResetPasswordPage />} />
    <Route path="/auth" element={<Navigate to="/" replace />} />
    <Route path="/login" element={<Navigate to="/" replace />} />

    {/* 公開頁 */}
    <Route path="/register/restaurant" element={<RestaurantRegisterPage />} />
    <Route path="/register/complete" element={<RegisterCompletePage />} />
    <Route path="/suppliers" element={<SuppliersPage />} />
    <Route path="/join" element={<JoinSupplierPage />} />
    {/* 舊版買家入口退場(後台精簡 Q7-A):站內零入口、詢價供應商也收不到 → 轉去餐廳後台。
        沒登入會再被 RestaurantRoute 帶回登入首頁。BuyerPortalPage 與既有 inquiries 資料都保留 */}
    <Route path="/my" element={<Navigate to="/restaurant" replace />} />
    <Route path="/price-index" element={<PriceIndexPage />} />
    <Route path="/supplier/:id" element={<SupplierDetail />} />
    <Route path="/architecture" element={<Architecture />} />
    <Route path="/investors" element={<InvestorsPage />} />

    {/* 消費者食材市集(免登入)。用 /market 前綴:公開的 /supplier/:id 跟供應商後台 /supplier/* 已經撞名,不要再往那邊加 */}
    <Route path="/market" element={<MarketLayout />}>
      <Route index element={<MarketHomePage />} />
      <Route path="p/:productId" element={<MarketProductPage />} />
      <Route path="s/:supplierId" element={<MarketStorePage />} />
      <Route path="cart" element={<MarketCartPage />} />
      <Route path="checkout" element={<MarketCheckoutPage />} />
      <Route path="orders/:token" element={<MarketOrderLookupPage />} />
      <Route path="terms" element={<MarketLegalPage doc="terms" />} />
      <Route path="privacy" element={<MarketLegalPage doc="privacy" />} />
      <Route path="*" element={<MarketNotFound />} />
    </Route>

    {/* 餐廳後台 */}
    <Route path="/restaurant" element={<RestaurantRoute><RestaurantLayout /></RestaurantRoute>}>
      <Route index element={<RestaurantDashboard />} />
      <Route path="analyze" element={<RestaurantAnalyzePage />} />
      <Route path="menu" element={<RestaurantMenuPage />} />
      <Route path="purchase" element={<RestaurantPurchasePage />} />
      <Route path="orders" element={<RestaurantOrdersPage />} />
      <Route path="costs" element={<RestaurantCostsPage />} />
      <Route path="suppliers" element={<RestaurantSuppliersPage />} />
      <Route path="lab" element={<RestaurantLabPage />} />
      <Route path="team" element={<RestaurantTeamPage />} />
      <Route path="settings" element={<RestaurantSettingsPage />} />
    </Route>

    {/* 供應商後台 */}
    <Route path="/supplier" element={<SupplierRoute><SupplierLayout /></SupplierRoute>}>
      <Route index element={<SupplierDashboard />} />
      <Route path="leads" element={<SupplierLeadsPage />} />
      <Route path="orders" element={<SupplierOrdersPage />} />
      {/* 後台精簡第二期(Q1-A):收單/報價/出貨合成一個訂單頁,舊網址轉到對應的狀態分頁(書籤、舊信件連結不會壞) */}
      <Route path="quotes" element={<Navigate to="/supplier/orders?stage=accepted" replace />} />
      <Route path="catalog" element={<SupplierCatalogPage />} />
      <Route path="pricing" element={<SupplierPricingPage />} />
      <Route path="forecast" element={<SupplierForecastPage />} />
      <Route path="customers" element={<SupplierCustomersPage />} />
      <Route path="logistics" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
      <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
      <Route path="reviews" element={<SupplierReviewsPage />} />
      {/* 零售市集(B2C) */}
      <Route path="market/store" element={<SupplierMarketStorePage />} />
      <Route path="market/orders" element={<SupplierMarketOrdersPage />} />
    </Route>

    {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
    <Route path="*" element={<NotFound />} />
  </Routes>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <LanguageProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          {IS_ADMIN_BUILD ? <AdminRoutes /> : <MainRoutes />}
        </BrowserRouter>
      </TooltipProvider>
    </LanguageProvider>
  </QueryClientProvider>
);

export default App;
