// 市集頁面測試共用的渲染工具(只給 *.test.tsx 用,正式程式不會 import):
// QueryClient(不重試)+ MemoryRouter + 指定的路由表,另外畫一個 data-testid="location" 讓測試讀目前網址
// (用 <span> 不用 <output>:<output> 的角色是 status,會跟頁面上的 role="status" 撞在一起)。
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const LocationProbe = () => {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
};

export const renderMarketRoute = (path: string, routes: Array<{ path: string; element: ReactElement }>) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
