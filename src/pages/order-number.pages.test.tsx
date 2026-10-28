// F4 訂單編號統一:這幾頁原本自己截 id(金流頁取前 8 碼、爭議 / 營收 / 媒合品質取末 8 碼小寫、
// 我的供應商自己轉大寫),現在一律呼叫 src/lib/order-number.ts 的 formatOrderNo(#+末 8 碼大寫)。
// 每頁驗兩件事:
//   ①用真的 formatOrderNo:畫面上是統一格式 #EDCF4143,舊格式(#A1E337B0 / #a1e337b0 / #edcf4143)都不見了
//   ②把 formatOrderNo 換成會印「⟦編號:id⟧」的替身:每一個顯示編號的地方都變成替身的字 ——
//     只要有一處還在自己截字串(即使輸出剛好一樣,例如「我的供應商」),就會露出 #EDCF4143 而被抓到
// supabase 換成記憶體假資料(testFakeSupabase),不打網路、不碰正式庫。

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from '@/pages/admin/testFakeSupabase';
import { formatOrderNo } from '@/lib/order-number';
import AdminBillingPage from '@/pages/admin/AdminBillingPage';
import AdminDisputesPage from '@/pages/admin/AdminDisputesPage';
import AdminRevenuePage from '@/pages/admin/AdminRevenuePage';
import AdminMatchQualityPage from '@/pages/admin/AdminMatchQualityPage';
import RestaurantSuppliersPage from '@/pages/restaurant/RestaurantSuppliersPage';

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('@/pages/admin/testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('@/lib/order-number', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-number')>();
  return { ...actual, formatOrderNo: vi.fn(actual.formatOrderNo) };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/RestaurantRoute', () => ({
  useRestaurant: () => ({
    id: 'account-1',
    restaurant_id: 'rest-1',
    branch_id: null,
    role: 'owner',
    restaurant_name: '好味小館',
  }),
  canSeeCost: () => true,
  needsApproval: () => false,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 正式庫那張 NT$1,800 的單(DEMO_GUIDE 記錄過三種編號:#EDCF4143 / #A1E337B0 / #edcf4143) */
const ID = 'a1e337b0-de8c-4e65-b22a-ca76edcf4143';
const UNIFIED = '#EDCF4143';
const OLD_FORMATS = ['#A1E337B0', '#a1e337b0', '#edcf4143'];
const AT = '2026-07-23T10:00:35Z';
const SENTINEL = `⟦編號:${ID}⟧`;

interface PageCase {
  name: string;
  /** 假資料 */
  respond: () => void;
  ui: () => JSX.Element;
  /** 把所有顯示編號的地方都叫出來(例如打開處理視窗、展開績效) */
  reveal: () => Promise<void>;
  /** 這頁顯示編號的地方有幾處 */
  sites: number;
}

const PAGES: PageCase[] = [
  {
    name: '財務 › 金流 / 發票(AdminBillingPage):原本取前 8 碼',
    respond: () =>
      fakeSupabase.respond((q) => {
        if (q.table === 'supplier_orders') return { data: [{ id: ID, created_at: AT, status: 'received', supplier_id: null }] };
        if (q.table === 'order_payments') {
          return {
            data: [
              {
                id: 'pay-1', order_id: ID, amount: 1800, method: 'credit_card', status: 'paid',
                transaction_no: 'TX-1', paid_at: AT, created_at: AT,
              },
            ],
          };
        }
        return { data: [] };
      }),
    ui: () => <AdminBillingPage />,
    reveal: async () => {
      await screen.findByText('TX-1');
    },
    sites: 1, // 收款清單的訂單欄(發票分頁、兩個對話框的選單要切換 / 打開才會出現)
  },
  {
    name: '訂單 › 爭議(AdminDisputesPage):清單與處理視窗原本都取末 8 碼小寫',
    respond: () =>
      fakeSupabase.respond((q) => {
        if (q.table === 'disputes') {
          return {
            data: [
              {
                id: 'd-1', order_id: ID, kind: 'shortage', status: 'open', opened_by: null, opened_role: 'restaurant',
                detail: '少兩箱', resolution: null, resolved_by: null, resolved_at: null, created_at: AT,
              },
            ],
          };
        }
        if (q.table === 'supplier_orders') {
          return { data: [{ id: ID, status: 'disputed', restaurant_id: 'rest-1', supplier_id: 'sup-1', total_amount: 1800 }] };
        }
        return { data: [] };
      }),
    ui: () => <AdminDisputesPage />,
    reveal: async () => {
      await userEvent.setup().click(await screen.findByRole('button', { name: '處理' }));
      await screen.findByRole('dialog');
    },
    sites: 2, // 清單 + 處理視窗
  },
  {
    name: '財務 › 營收(AdminRevenuePage):「最近認列 GMV 的訂單」原本取末 8 碼小寫',
    respond: () =>
      fakeSupabase.respond((q) => {
        if (q.table === 'supplier_orders') {
          return { data: [{ id: ID, status: 'received', restaurant_id: 'rest-1', supplier_id: 'sup-1', total_amount: 1800, created_at: AT }] };
        }
        if (q.table === 'order_events') return { data: [{ order_id: ID, to_status: 'received', created_at: AT }] };
        return { data: [] };
      }),
    ui: () => <AdminRevenuePage />,
    reveal: async () => {
      await screen.findByText('最近認列 GMV 的訂單');
    },
    sites: 1,
  },
  {
    name: '需求與媒合 › 供給缺口與品質(AdminMatchQualityPage):未接單清單原本取末 8 碼小寫',
    respond: () =>
      fakeSupabase.respond((q) => {
        if (q.table === 'supplier_orders') {
          return {
            data: [
              {
                id: ID, status: 'dispatched', restaurant_id: 'rest-1', supplier_id: 'sup-1', total_amount: null,
                current_stage_since: AT, created_at: AT,
              },
            ],
          };
        }
        return { data: [] };
      }),
    ui: () => <AdminMatchQualityPage />,
    reveal: async () => {
      await screen.findByText('未接單筆數');
    },
    sites: 1,
  },
  {
    name: '餐廳 › 我的供應商(RestaurantSuppliersPage):近期合作原本自己轉大寫(輸出一樣)',
    respond: () =>
      fakeSupabase.respond((q) => {
        if (q.table === 'supplier_orders') {
          return { data: [{ id: ID, supplier_id: 'sup-1', total_amount: 1800, status: 'delivered', created_at: AT }] };
        }
        if (q.table === 'restaurant_suppliers') return { data: [{ supplier_id: 'sup-1' }] };
        if (q.table === 'suppliers') {
          return { data: [{ id: 'sup-1', name: '鮮綠農產', description: null, service_areas: [] }] };
        }
        return { data: [] };
      }),
    ui: () => <RestaurantSuppliersPage />,
    reveal: async () => {
      await userEvent.setup().click(await screen.findByRole('button', { name: '查看績效' }));
      screen.getByRole('region', { name: '鮮綠農產 的績效明細' });
    },
    sites: 1,
  },
];

/** 畫面上(含對話框的 portal)文字剛好等於 text 的節點 */
const exactly = (text: string) => screen.queryAllByText((_, el) => el?.childNodes.length === 1 && el.textContent?.trim() === text);

let fetchGuard: ReturnType<typeof vi.fn>;
let realFormat: typeof formatOrderNo;

beforeAll(async () => {
  realFormat = (await vi.importActual<typeof import('@/lib/order-number')>('@/lib/order-number')).formatOrderNo;
});

beforeEach(() => {
  // 每個測試都從真的 formatOrderNo 開始(替身只在需要的測試裡換上)
  vi.mocked(formatOrderNo).mockImplementation(realFormat);
  fakeSupabase.reset();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
  expect(fakeSupabase.writes()).toEqual([]);
});

describe('訂單編號一律用 formatOrderNo(#+末 8 碼大寫)', () => {
  it.each(PAGES)('$name —— 畫面上是統一格式,舊格式不見了', async (page) => {
    page.respond();
    render(<MemoryRouter>{page.ui()}</MemoryRouter>);
    await page.reveal();

    await waitFor(() => expect(document.body.textContent).toContain(UNIFIED));
    OLD_FORMATS.forEach((old) => expect(document.body.textContent).not.toContain(old));
    expect(formatOrderNo).toHaveBeenCalledWith(ID);
  });

  it.each(PAGES)('$name —— 每一個顯示編號的地方都呼叫 formatOrderNo(沒有自己截字串)', async (page) => {
    vi.mocked(formatOrderNo).mockImplementation((id) => `⟦編號:${id}⟧`);
    page.respond();
    render(<MemoryRouter>{page.ui()}</MemoryRouter>);
    await page.reveal();

    await waitFor(() => expect(document.body.textContent?.split(SENTINEL).length ?? 0).toBeGreaterThan(page.sites));
    // 替身之外不應該還有任何人自己把 id 截成編號
    [UNIFIED, ...OLD_FORMATS].forEach((own) => expect(document.body.textContent).not.toContain(own));
    expect(exactly(UNIFIED)).toEqual([]);
  });
});

describe('爭議頁處理視窗(單獨驗)', () => {
  it('視窗描述是「訂單 #EDCF4143 · 短缺 …」,而且是 formatOrderNo 產生的', async () => {
    PAGES[1].respond();
    vi.mocked(formatOrderNo).mockImplementation((id) => `⟦編號:${id}⟧`);
    render(<MemoryRouter><AdminDisputesPage /></MemoryRouter>);
    await PAGES[1].reveal();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith(`訂單 ${SENTINEL} ·`))).toBeInTheDocument();
  });
});
