// 單筆 AI 分析紀錄(業主拍板 Q3-A):保留當潛在客戶名單,拿掉「批准並發送」。
// 驗證:①畫面上沒有「批准並發送」、也不會再寫 supplier_orders、不再讀供應商清單
//       ②其他功能照舊:內容、買方聯絡資訊、拒絕、刪除 ③拒絕寫入失敗時照實報錯(以前會顯示成功)。

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './testFakeSupabase';
import AnalysisDetailPage from './AnalysisDetailPage';

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('./testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

const RECORD = {
  id: 'an-1',
  created_at: '2026-09-20T02:00:00.000Z',
  source_type: 'chatbot',
  summary: '牛肉麵店,每週需要牛腱與蔥',
  status: 'pending_review',
  ingredient_list: [{ name: '牛腱', quantity: '10', unit: 'kg' }, { name: '青蔥', quantity: '3', unit: 'kg' }],
  admin_notes: null,
  reviewed_at: null,
  transcript: null,
  images: null,
  messages: null,
};

const LEAD = { company_name: '老王牛肉麵', contact_phone: '0912-000-111', contact_line: 'wang-beef' };

type Rec = typeof RECORD;

const serve = (record: Partial<Rec> | null, opts: { updateError?: string; deleteError?: string } = {}) =>
  fakeSupabase.respond((q) => {
    if (q.table === 'analysis_records' && q.action === 'select') return { data: record ? { ...RECORD, ...record } : null };
    if (q.table === 'analysis_records' && q.action === 'update') {
      return opts.updateError ? { error: { message: opts.updateError } } : { data: null };
    }
    if (q.table === 'analysis_records' && q.action === 'delete') {
      return opts.deleteError ? { error: { message: opts.deleteError } } : { data: null };
    }
    if (q.table === 'landing_leads') return { data: [LEAD] };
    return undefined;
  });

const renderPage = (id = 'an-1') =>
  render(
    <MemoryRouter initialEntries={[`/admin/analyses/${id}`]}>
      <Routes>
        <Route path="/admin/analyses/:id" element={<AnalysisDetailPage />} />
        <Route path="/admin/analyses" element={<h1>分析紀錄列表頁</h1>} />
      </Routes>
    </MemoryRouter>,
  );

const loaded = () => screen.findByRole('heading', { name: /分析詳情/ });

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  toastSpy.mockReset();
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
  // 不管做了什麼,這一頁都不准再建訂單
  expect(fakeSupabase.queriesOf('supplier_orders')).toEqual([]);
});

describe('AnalysisDetailPage — 已經沒有「批准並發送」', () => {
  it('待審核的紀錄:沒有批准並發送、沒有選供應商的對話框,只剩「拒絕」與「刪除」', async () => {
    serve({});
    renderPage();
    await loaded();

    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.queryByText(/批准並發送|Approve/)).toBeNull();
    expect(screen.queryByText(/選擇供應商/)).toBeNull();
    expect(screen.getByRole('button', { name: /拒絕/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /刪除/ })).toBeInTheDocument();
    // 告訴管理員這筆要怎麼成交
    expect(screen.getByText(/潛在客戶名單/)).toHaveTextContent('註冊餐廳後台叫貨');
  });

  it('不再讀供應商清單(那只是給批准對話框用的),打開頁面也不寫任何資料', async () => {
    serve({});
    renderPage();
    await loaded();
    await waitFor(() => expect(fakeSupabase.queriesOf('landing_leads')).toHaveLength(1));

    expect(fakeSupabase.queriesOf('suppliers')).toEqual([]);
    expect(fakeSupabase.writes()).toEqual([]);
  });
});

describe('AnalysisDetailPage — 其他功能照舊', () => {
  it('顯示摘要、食材、買方聯絡資訊', async () => {
    serve({});
    renderPage();
    await loaded();

    expect(screen.getByText('牛肉麵店,每週需要牛腱與蔥')).toBeInTheDocument();
    expect(screen.getByText('牛腱 · 10kg')).toBeInTheDocument();
    expect(screen.getByText('青蔥 · 3kg')).toBeInTheDocument();
    expect(await screen.findByText('老王牛肉麵')).toBeInTheDocument();
    expect(screen.getByText('0912-000-111')).toBeInTheDocument();
    expect(screen.getByText('wang-beef')).toBeInTheDocument();
    expect(screen.getByText('待審核')).toBeInTheDocument();
  });

  it('拒絕:寫入 status=rejected + 原因 + 審核人,成功才顯示「已拒絕」', async () => {
    serve({});
    const user = userEvent.setup();
    renderPage();
    await loaded();

    await user.click(screen.getByRole('button', { name: /拒絕/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('請輸入拒絕原因…'), '重複的測試資料');
    await user.click(within(dialog).getByRole('button', { name: '確認拒絕' }));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: '已拒絕 (Rejected)' }));
    const [update] = fakeSupabase.writes();
    expect(update.table).toBe('analysis_records');
    expect(update.action).toBe('update');
    expect(update.payload).toMatchObject({
      status: 'rejected',
      admin_notes: '重複的測試資料',
      reviewed_by: 'admin-user-1',
    });
    expect(update.filters).toEqual([{ op: 'eq', column: 'id', value: 'an-1' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('拒絕寫入失敗 → 顯示「拒絕失敗」與原因,不顯示「已拒絕」,對話框留著可以重試', async () => {
    serve({}, { updateError: 'new row violates row-level security policy' });
    const user = userEvent.setup();
    renderPage();
    await loaded();

    await user.click(screen.getByRole('button', { name: /拒絕/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '確認拒絕' }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '拒絕失敗 (Reject failed)',
          description: 'new row violates row-level security policy',
          variant: 'destructive',
        }),
      ),
    );
    expect(toastSpy).not.toHaveBeenCalledWith({ title: '已拒絕 (Rejected)' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '確認拒絕' })).toBeEnabled();
  });

  it('刪除:確認後刪掉這筆紀錄並回到列表', async () => {
    serve({});
    const user = userEvent.setup();
    renderPage();
    await loaded();

    await user.click(screen.getByRole('button', { name: /刪除/ }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: '確定刪除' }));

    expect(await screen.findByRole('heading', { name: '分析紀錄列表頁' })).toBeInTheDocument();
    const [del] = fakeSupabase.writes();
    expect(del).toMatchObject({ table: 'analysis_records', action: 'delete' });
    expect(del.filters).toEqual([{ op: 'eq', column: 'id', value: 'an-1' }]);
    expect(toastSpy).toHaveBeenCalledWith({ title: '已刪除 (Deleted)' });
  });

  it('舊流程已發送過的紀錄照常顯示「已發送」,沒有任何審核按鈕', async () => {
    serve({ status: 'sent', reviewed_at: '2026-09-21T03:00:00.000Z' });
    renderPage();
    await loaded();

    expect(screen.getByText('已發送')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒絕/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
  });

  it('找不到紀錄 → 顯示「找不到紀錄」', async () => {
    serve(null);
    renderPage('missing');
    expect(await screen.findByText(/找不到紀錄/)).toBeInTheDocument();
  });
});

describe('AnalysisDetailPage — 形象站 Email 與註冊認領', () => {
  const ORDER_ID = '0b6c3e2a-7d14-4f58-9a3b-2c1d0e9f8a7b';

  const serveWith = (record: Record<string, unknown>, lead: Record<string, unknown> | null = null) =>
    fakeSupabase.respond((q) => {
      if (q.table === 'analysis_records' && q.action === 'select') return { data: { ...RECORD, ...record } };
      if (q.table === 'landing_leads') return { data: lead ? [lead] : [] };
      return undefined;
    });

  const renderWithOrderRoute = () =>
    render(
      <MemoryRouter initialEntries={['/admin/analyses/an-1']}>
        <Routes>
          <Route path="/admin/analyses/:id" element={<AnalysisDetailPage />} />
          <Route path="/admin/orders/:id" element={<h1>訂單頁</h1>} />
        </Routes>
      </MemoryRouter>,
    );

  it('買方聯絡資訊多一欄 Email(landing_leads.contact_email),查詢也有帶這個欄位', async () => {
    serveWith({}, { ...LEAD, contact_phone: null, contact_email: 'boss@beef.example' });
    renderPage();
    await loaded();

    expect(await screen.findByText('boss@beef.example')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    const [leads] = fakeSupabase.queriesOf('landing_leads');
    expect(leads.columns).toBe('company_name, contact_phone, contact_line, contact_email');
    expect(leads.filters[0]).toEqual({ op: 'eq', column: 'analysis_id', value: 'an-1' });
  });

  it('claimed_at 有值 → 顯示「已由註冊帶入，轉成採購單草稿」並連到那張訂單;不再是待審(沒有拒絕鈕、標籤不是待審核)', async () => {
    serveWith({ claimed_at: '2026-10-07T02:00:00.000Z', claimed_order_id: ORDER_ID });
    const user = userEvent.setup();
    renderWithOrderRoute();
    await loaded();

    const card = screen.getByTestId('claimed-card');
    expect(card).toHaveTextContent('已由註冊帶入，轉成採購單草稿');
    const link = within(card).getByRole('link', { name: /查看採購單/ });
    expect(link).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    expect(link).toHaveTextContent('#0E9F8A7B'); // 訂單編號 = id 後 8 碼大寫(formatOrderNo)
    expect(screen.getByText('已轉採購單')).toBeInTheDocument();
    expect(screen.queryByText('待審核')).toBeNull();
    expect(screen.queryByRole('button', { name: /拒絕/ })).toBeNull();
    expect(screen.queryByText(/潛在客戶名單/)).toBeNull();

    await user.click(link);
    expect(await screen.findByRole('heading', { name: '訂單頁' })).toBeInTheDocument();
  });

  it('認領了但沒有建單(對話沒有食材)→ 說明沒有建立採購單,沒有連結', async () => {
    serveWith({ claimed_at: '2026-10-07T02:00:00.000Z', claimed_order_id: null });
    renderPage();
    await loaded();

    const card = screen.getByTestId('claimed-card');
    expect(card).toHaveTextContent('已由註冊帶入（沒有辨識到食材，沒有建立採購單）');
    expect(within(card).queryByRole('link')).toBeNull();
    expect(screen.getByText('已註冊帶入')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒絕/ })).toBeNull();
  });

  it('沒被認領的待審紀錄 → 沒有認領卡,照舊是待審', async () => {
    serveWith({ claimed_at: null, claimed_order_id: null }, LEAD);
    renderPage();
    await loaded();

    expect(screen.queryByTestId('claimed-card')).toBeNull();
    expect(screen.getByText('待審核')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拒絕/ })).toBeInTheDocument();
  });
});
