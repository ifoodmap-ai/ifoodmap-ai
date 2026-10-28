// 餐廳後台的「採購金額」改用 src/lib/metrics.ts 的共用定義(業主拍板 Q5-A):不含草稿、取消、拒單、逾時。
//   - 營運總覽:本月採購金額 / 採購單數 / 合作供應商(舊算法本來就是這組狀態,數字不變,但改成呼叫共用函式)
//   - 我的供應商:原本連取消單都算進累計金額,現在跟營運總覽、供應商端「客戶管理」同一組單
// 每頁都餵「狀態矩陣」(每種狀態一張單、金額是 2 的次方),驗:①數字 = metrics.ts 對同一份資料的結果
// ②頁面真的呼叫了 metrics.ts(函式包成 spy)。預期值在 describe 層先算好,it() 裡的呼叫都是頁面發出的。

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '@/pages/admin/testFakeSupabase';
import RestaurantDashboard from './RestaurantDashboard';
import RestaurantSuppliersPage from './RestaurantSuppliersPage';
import * as metrics from '@/lib/metrics';
import { ALL_STATUSES, ntd, orderMatrix, sumFor } from '@/test/orderMatrix';

type Role = 'owner' | 'manager' | 'purchaser';
const { state } = vi.hoisted(() => ({ state: { role: 'owner' as Role } }));

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('@/pages/admin/testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('@/lib/metrics', async (importOriginal) =>
  (await import('@/test/metricsSpy')).spyOnMetrics(await importOriginal()),
);
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/RestaurantRoute', () => ({
  useRestaurant: () => ({
    id: 'account-1',
    restaurant_id: 'rest-1',
    branch_id: null,
    role: state.role,
    restaurant_name: '好味小館',
  }),
  canSeeCost: (role: Role) => role === 'owner' || role === 'manager',
  needsApproval: (role: Role) => role === 'purchaser',
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = new Date(2026, 8, 15, 12, 0, 0); // 本地 2026-09-15 中午
const localIso = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0).toISOString();

const cellOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

/** 有效的單都給鮮綠農產;草稿 / 取消 / 拒單 / 逾時給另一家 —— 那家不該被算成「合作過」 */
const ORDERS = orderMatrix((status) => ({
  supplier_id: metrics.EXCLUDED_ORDER_STATUSES.includes(status) ? 'sup-void' : 'sup-1',
  created_at: localIso(2026, 9, 3),
  current_stage_since: localIso(2026, 9, 14),
}));
const SUPPLIERS = [
  { id: 'sup-1', name: '鮮綠農產', description: null, service_areas: [] },
  { id: 'sup-void', name: '只有取消單的行號', description: null, service_areas: [] },
];
const AMOUNT = metrics.sumOrderAmount(ORDERS);
const COUNT = metrics.countOrders(ORDERS); // 16
const AMOUNT_OLD_UNFILTERED = sumFor(ALL_STATUSES); // 我的供應商舊算法完全不篩

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.role = 'owner';
  fakeSupabase.reset();
  fakeSupabase.respond((q) => {
    if (q.table === 'supplier_orders') return { data: ORDERS };
    // 我的供應商只列「綁定」的合作供應商(只有取消單的那家沒綁)
    if (q.table === 'restaurant_suppliers') return { data: [{ supplier_id: 'sup-1' }] };
    if (q.table === 'suppliers') {
      // 跟真的資料庫一樣照 .in('id', …) 篩(我的供應商只查合作過的那幾家)
      const ids = q.filters.find((f) => f.op === 'in' && f.column === 'id')?.value as string[] | undefined;
      return { data: ids ? SUPPLIERS.filter((sup) => ids.includes(sup.id)) : SUPPLIERS };
    }
    return { data: [] };
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
  expect(fakeSupabase.writes()).toEqual([]);
});

/* ------------------------------------------------------------------ */
describe('餐廳 › 營運總覽(RestaurantDashboard)', () => {
  it('本月採購金額與合作供應商 = 共用的訂單定義', async () => {
    render(<MemoryRouter><RestaurantDashboard /></MemoryRouter>);

    await waitFor(() => expect(within(cellOf('本月採購金額')).getByText(ntd(AMOUNT))).toBeInTheDocument());
    // 只有取消單的那家不算合作供應商
    expect(within(cellOf('合作供應商')).getByText('1 家')).toBeInTheDocument();
    expect(metrics.countedOrders).toHaveBeenCalledWith(ORDERS);
  });

  it('看不到金額的採購員:本月採購單數 = 共用的訂單數', async () => {
    state.role = 'purchaser';
    render(<MemoryRouter><RestaurantDashboard /></MemoryRouter>);
    await waitFor(() => expect(within(cellOf('本月採購單數')).getByText(`${COUNT} 筆`)).toBeInTheDocument());
    expect(screen.queryByText('本月採購金額')).toBeNull();
    expect(metrics.countedOrders).toHaveBeenCalledWith(ORDERS);
  });
});

/* ------------------------------------------------------------------ */
describe('餐廳 › 我的供應商(RestaurantSuppliersPage)', () => {
  it('累計訂單 / 累計採購金額不再算草稿與取消單;只有取消單的供應商不列為合作', async () => {
    render(<MemoryRouter><RestaurantSuppliersPage /></MemoryRouter>);

    expect(await screen.findByText('鮮綠農產')).toBeInTheDocument();
    expect(screen.queryByText('只有取消單的行號')).toBeNull();

    expect(within(cellOf('合作供應商')).getByText('1')).toBeInTheDocument();
    expect(within(cellOf('累計訂單')).getByText(String(COUNT))).toBeInTheDocument();

    // 我的供應商用 $1,234 的格式
    const summary = screen.getAllByText('累計採購金額')[0].parentElement as HTMLElement;
    expect(within(summary).getByText(`$${Math.round(AMOUNT).toLocaleString()}`)).toBeInTheDocument();
    expect(screen.queryByText('累計金額')).toBeNull();
    expect(screen.queryByText(`$${Math.round(AMOUNT_OLD_UNFILTERED).toLocaleString()}`)).toBeNull();
    expect(metrics.countedOrders).toHaveBeenCalledWith(ORDERS);
  });
});
