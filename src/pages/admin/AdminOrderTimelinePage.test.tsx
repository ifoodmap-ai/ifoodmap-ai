// 單筆訂單頁 /admin/orders/:id:舊明細與「訂單履歷」併成一頁(以履歷為底)。
// 驗證:①舊明細獨有的「買方聯絡資訊」「對應分析來源」搬過來了 ②履歷內容照舊(事件時間軸、評價、爭議)
//       ③舊明細那些必被 DB 擋的「改狀態」「刪除」沒有搬、整頁不寫資料 ④/admin/orders/:id 用的就是這個元件。

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './testFakeSupabase';
import AdminOrderTimelinePage from './AdminOrderTimelinePage';
import AdminOrderDetailPage from './AdminOrderDetailPage';

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('./testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ORDER = {
  id: 'order-0000-1111-2222-3333abcdef12',
  created_at: '2026-09-20T02:00:00.000Z',
  updated_at: null,
  status: 'dispatched',
  notes: '請早上送',
  sent_at: '2026-09-20T03:00:00.000Z',
  supplier_id: 'sup-1',
  restaurant_id: 'rest-1',
  branch_id: null,
  analysis_id: 'an-7',
  total_amount: 5200,
  current_stage_since: new Date().toISOString(),
  approved_at: null,
  ingredient_list: [{ name: '牛腱', quantity: 10, unit: 'kg', category: '肉品' }],
};

const EVENT = {
  id: 'ev-1',
  order_id: ORDER.id,
  from_status: 'submitted',
  to_status: 'dispatched',
  actor_id: 'x',
  actor_role: 'admin',
  actor_label: 'ops@example.test',
  source: 'admin_portal',
  payload: {},
  note: null,
  created_at: '2026-09-20T03:00:00.000Z',
};

const serve = (order: Partial<typeof ORDER> = {}) =>
  fakeSupabase.respond((q) => {
    switch (q.table) {
      case 'supplier_orders':
        return { data: [{ ...ORDER, ...order }] };
      case 'restaurants':
        return { data: [{ name: '老王牛肉麵' }] };
      case 'suppliers':
        return { data: [{ name: '頂鮮肉品行' }] };
      case 'order_events':
        return { data: [EVENT] };
      case 'analysis_records':
        return { data: [{ summary: '牛肉麵店,每週需要牛腱' }] };
      case 'landing_leads':
        return { data: [{ company_name: '王先生', contact_phone: '0912-000-111', contact_line: 'wang-beef' }] };
      default:
        return { data: [] };
    }
  });

const renderAt = (Component = AdminOrderTimelinePage, history: string[] = [`/admin/orders/${ORDER.id}`]) =>
  render(
    <MemoryRouter initialEntries={history} initialIndex={history.length - 1}>
      <Routes>
        <Route path="/admin/orders/:id" element={<Component />} />
        <Route path="/admin/analyses/:id" element={<h1>分析詳情頁</h1>} />
        <Route path="/admin/pipeline" element={<h1>看板頁</h1>} />
        <Route path="/admin/orders" element={<h1>全部訂單頁</h1>} />
      </Routes>
    </MemoryRouter>,
  );

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // BrowserRouter 那一個測試會動到真的 window.history,每個測試後都還原
  window.history.replaceState(null, '', '/');
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe('單筆訂單頁(明細 + 履歷合一)', () => {
  it('/admin/orders/:id 的元件(AdminOrderDetailPage)就是這一頁', () => {
    expect(AdminOrderDetailPage).toBe(AdminOrderTimelinePage);
  });

  it('舊明細的兩張卡搬過來了:買方聯絡資訊、對應分析來源(可以點去分析紀錄)', async () => {
    serve();
    const user = userEvent.setup();
    renderAt(AdminOrderDetailPage);

    expect(await screen.findByText('買方聯絡資訊')).toBeInTheDocument();
    expect(screen.getByText('王先生')).toBeInTheDocument();
    expect(screen.getByText('0912-000-111')).toBeInTheDocument();
    expect(screen.getByText('wang-beef')).toBeInTheDocument();

    expect(screen.getByText('對應分析來源')).toBeInTheDocument();
    expect(screen.getByText('牛肉麵店,每週需要牛腱')).toBeInTheDocument();

    const leads = fakeSupabase.queriesOf('landing_leads')[0];
    expect(leads.filters).toEqual([
      { op: 'eq', column: 'analysis_id', value: 'an-7' },
      { op: 'order', column: 'created_at', value: { ascending: false } },
      { op: 'limit', column: 'limit', value: 1 },
    ]);

    await user.click(screen.getByRole('button', { name: '查看分析紀錄 →' }));
    expect(await screen.findByRole('heading', { name: '分析詳情頁' })).toBeInTheDocument();
  });

  it('履歷內容照舊:訂單資訊(含發送時間)、品項、事件時間軸', async () => {
    serve();
    renderAt();

    expect(await screen.findByRole('heading', { name: '訂單履歷' })).toBeInTheDocument();
    expect(screen.getByText('老王牛肉麵')).toBeInTheDocument();
    expect(screen.getByText('頂鮮肉品行')).toBeInTheDocument();
    expect(screen.getByText('發送時間')).toBeInTheDocument();
    // 舊明細能編輯的「備註」,在合併頁照樣看得到(唯讀)
    expect(screen.getByText('備註')).toBeInTheDocument();
    expect(screen.getByText('請早上送')).toBeInTheDocument();
    expect(screen.getByText('牛腱')).toBeInTheDocument();
    expect(screen.getByText('事件時間軸')).toBeInTheDocument();
    expect(screen.getByText('ops@example.test')).toBeInTheDocument();
    expect(screen.getByText('餐廳評價')).toBeInTheDocument();
    expect(screen.getByText('爭議紀錄')).toBeInTheDocument();
  });

  it('沒有舊明細那些必被 DB 擋的按鈕(改狀態、刪除),也沒有連回自己的「訂單詳情 →」;整頁不寫資料', async () => {
    serve();
    renderAt();
    await screen.findByRole('heading', { name: '訂單履歷' });
    await waitFor(() => expect(fakeSupabase.queriesOf('disputes')).toHaveLength(1));

    expect(screen.queryByRole('button', { name: /訂單詳情/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /刪除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /儲存|Save/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/更新狀態/)).toBeNull();
    expect(fakeSupabase.writes()).toEqual([]);
  });

  it('返回鈕回到來的地方:從看板點進來就回看板', async () => {
    serve();
    const user = userEvent.setup();
    renderAt(AdminOrderTimelinePage, ['/admin/pipeline', `/admin/orders/${ORDER.id}`]);
    await screen.findByRole('heading', { name: '訂單履歷' });

    await user.click(screen.getByRole('button', { name: '返回上一頁' }));
    expect(await screen.findByRole('heading', { name: '看板頁' })).toBeInTheDocument();
  });

  it('沒有站內上一頁(直接打網址、信件連結)→ 返回鈕退回「全部訂單」,不會把人帶離網站', async () => {
    serve();
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('heading', { name: '訂單履歷' });

    await user.click(screen.getByRole('button', { name: '返回全部訂單' }));
    expect(await screen.findByRole('heading', { name: '全部訂單頁' })).toBeInTheDocument();
  });

  it('從外部連結打舊的 /timeline 網址進來(被 replace 轉址):仍然算沒有站內上一頁,返回鈕退回「全部訂單」', async () => {
    serve();
    const user = userEvent.setup();
    // 模擬新分頁第一次打開:瀏覽器歷史只有這一筆,還沒有 React Router 的 idx
    window.history.replaceState(null, '', `/admin/orders/${ORDER.id}/timeline`);
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/admin/orders/:id" element={<AdminOrderTimelinePage />} />
          <Route path="/admin/orders/:id/timeline" element={<Navigate to=".." relative="path" replace />} />
          <Route path="/admin/orders" element={<h1>全部訂單頁</h1>} />
        </Routes>
      </BrowserRouter>,
    );
    await screen.findByRole('heading', { name: '訂單履歷' });
    expect(window.location.pathname).toBe(`/admin/orders/${ORDER.id}`);

    await user.click(screen.getByRole('button', { name: '返回全部訂單' }));
    expect(await screen.findByRole('heading', { name: '全部訂單頁' })).toBeInTheDocument();
  });

  it('不是從 AI 分析來的單:不顯示那兩張卡,也不去查分析與聯絡資訊', async () => {
    serve({ analysis_id: null, sent_at: null });
    renderAt();
    await screen.findByRole('heading', { name: '訂單履歷' });
    await waitFor(() => expect(fakeSupabase.queriesOf('disputes')).toHaveLength(1));

    expect(screen.queryByText('買方聯絡資訊')).toBeNull();
    expect(screen.queryByText('對應分析來源')).toBeNull();
    expect(screen.queryByText('發送時間')).toBeNull();
    expect(fakeSupabase.queriesOf('analysis_records')).toEqual([]);
    expect(fakeSupabase.queriesOf('landing_leads')).toEqual([]);
  });
});

describe('單筆訂單頁 — 形象站 Email 與註冊認領的草稿', () => {
  const LEAD = { company_name: '王先生', contact_phone: null, contact_line: null, contact_email: 'wang@beef.example' };

  it('買方聯絡資訊多一欄 Email(landing_leads.contact_email)', async () => {
    fakeSupabase.respond((q) => {
      if (q.table === 'supplier_orders') return { data: [ORDER] };
      if (q.table === 'analysis_records') return { data: [{ summary: '牛肉麵店,每週需要牛腱' }] };
      if (q.table === 'landing_leads') return { data: [LEAD] };
      if (q.table === 'order_events') return { data: [EVENT] };
      return { data: [] };
    });
    renderAt();

    expect(await screen.findByText('買方聯絡資訊')).toBeInTheDocument();
    expect(screen.getByText('wang@beef.example')).toBeInTheDocument();
    expect(fakeSupabase.queriesOf('landing_leads')[0].columns).toBe(
      'company_name, contact_phone, contact_line, contact_email',
    );
  });

  it('註冊認領建的草稿(沒有 analysis_id、備註「AI 採購助手帶入」)→ 用 claimed_order_id 反查來源分析與聯絡資訊', async () => {
    const draft = {
      ...ORDER,
      status: 'draft',
      analysis_id: null,
      notes: 'AI 採購助手帶入',
      supplier_id: null,
      sent_at: null,
    };
    fakeSupabase.respond((q) => {
      if (q.table === 'supplier_orders') return { data: [draft] };
      if (q.table === 'analysis_records') return { data: [{ id: 'an-claimed', summary: '火鍋店每週要高麗菜' }] };
      if (q.table === 'landing_leads') return { data: [LEAD] };
      if (q.table === 'restaurants') return { data: [{ name: '新開的小館' }] };
      return { data: [] };
    });
    const user = userEvent.setup();
    renderAt();

    expect(await screen.findByText('對應分析來源')).toBeInTheDocument();
    expect(screen.getByText('火鍋店每週要高麗菜')).toBeInTheDocument();
    expect(screen.getByText(/形象站訪客註冊後/)).toBeInTheDocument();
    expect(await screen.findByText('wang@beef.example')).toBeInTheDocument();

    const [lookup] = fakeSupabase.queriesOf('analysis_records');
    expect(lookup.filters).toEqual([
      { op: 'eq', column: 'claimed_order_id', value: ORDER.id },
      { op: 'limit', column: 'limit', value: 1 },
    ]);
    expect(fakeSupabase.queriesOf('landing_leads')[0].filters[0]).toEqual({
      op: 'eq',
      column: 'analysis_id',
      value: 'an-claimed',
    });

    await user.click(screen.getByRole('button', { name: '查看分析紀錄 →' }));
    expect(await screen.findByRole('heading', { name: '分析詳情頁' })).toBeInTheDocument();
  });

  it('反查不到來源(例如分析紀錄被刪了)→ 不顯示那兩張卡,也不查聯絡資訊', async () => {
    fakeSupabase.respond((q) => {
      if (q.table === 'supplier_orders') return { data: [{ ...ORDER, analysis_id: null, notes: 'AI 採購助手帶入' }] };
      if (q.table === 'analysis_records') return { data: [] };
      return { data: [] };
    });
    renderAt();
    await screen.findByRole('heading', { name: '訂單履歷' });
    await waitFor(() => expect(fakeSupabase.queriesOf('disputes')).toHaveLength(1));

    expect(fakeSupabase.queriesOf('analysis_records')).toHaveLength(1);
    expect(fakeSupabase.queriesOf('landing_leads')).toEqual([]);
    expect(screen.queryByText('對應分析來源')).toBeNull();
    expect(screen.queryByText('買方聯絡資訊')).toBeNull();
  });
});
