// 分析紀錄列表 /admin/analyses:
//   ①「待審核」分頁跟今日待辦的「待審分析」同一個定義(pending_review 且 claimed_at is null)
//   ②被形象站訪客註冊認領的紀錄在列表上標成「已轉採購單」/「已註冊帶入」,不再顯示「待審核」

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './testFakeSupabase';
import AnalysisListPage from './AnalysisListPage';

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('./testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const ROWS = [
  {
    id: 'an-claimed',
    created_at: '2026-10-07T02:00:00.000Z',
    source_type: 'chatbot',
    summary: '牛肉麵店要牛腱',
    status: 'pending_review',
    claimed_at: '2026-10-07T03:00:00.000Z',
    claimed_order_id: '0b6c3e2a-7d14-4f58-9a3b-2c1d0e9f8a7b',
  },
  {
    id: 'an-claimed-empty',
    created_at: '2026-10-06T02:00:00.000Z',
    source_type: 'menu_upload',
    summary: '看不出食材的菜單',
    status: 'pending_review',
    claimed_at: '2026-10-06T03:00:00.000Z',
    claimed_order_id: null,
  },
  {
    id: 'an-pending',
    created_at: '2026-10-05T02:00:00.000Z',
    source_type: 'chatbot',
    summary: '火鍋店要高麗菜',
    status: 'pending_review',
    claimed_at: null,
    claimed_order_id: null,
  },
];

const rowOf = (summary: string) => screen.getByText(summary).closest('tr') as HTMLElement;

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  fakeSupabase.respond((q) => (q.table === 'analysis_records' ? { data: ROWS } : undefined));
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AnalysisListPage />
    </MemoryRouter>,
  );

describe('AnalysisListPage — 註冊認領', () => {
  it('「全部」:讀 claimed_at / claimed_order_id;被認領的標「已轉採購單」或「已註冊帶入」,沒被認領的照舊「待審核」', async () => {
    renderPage();
    await screen.findByText('牛肉麵店要牛腱');

    const [query] = fakeSupabase.queriesOf('analysis_records');
    expect(query.columns).toBe('id, created_at, source_type, summary, status, claimed_at, claimed_order_id');
    expect(query.filters.filter((f) => f.op !== 'order')).toEqual([]);

    expect(within(rowOf('牛肉麵店要牛腱')).getByText('已轉採購單')).toBeInTheDocument();
    expect(within(rowOf('牛肉麵店要牛腱')).queryByText('待審核')).toBeNull();
    expect(within(rowOf('看不出食材的菜單')).getByText('已註冊帶入')).toBeInTheDocument();
    expect(within(rowOf('火鍋店要高麗菜')).getByText('待審核')).toBeInTheDocument();
  });

  it('「待審核」分頁 = 今日待辦「待審分析」的同一個定義:pending_review 且 claimed_at is null', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('牛肉麵店要牛腱');

    await user.click(screen.getByRole('tab', { name: '待審核' }));

    await waitFor(() => expect(fakeSupabase.queriesOf('analysis_records')).toHaveLength(2));
    const pendingQuery = fakeSupabase.queriesOf('analysis_records')[1];
    expect(pendingQuery.filters.filter((f) => f.op !== 'order')).toEqual([
      { op: 'eq', column: 'status', value: 'pending_review' },
      { op: 'is', column: 'claimed_at', value: null },
    ]);
  });

  it('其他分頁只篩 status(沒有多加認領條件)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('牛肉麵店要牛腱');

    await user.click(screen.getByRole('tab', { name: '已發送' }));

    await waitFor(() => expect(fakeSupabase.queriesOf('analysis_records')).toHaveLength(2));
    expect(fakeSupabase.queriesOf('analysis_records')[1].filters.filter((f) => f.op !== 'order')).toEqual([
      { op: 'eq', column: 'status', value: 'sent' },
    ]);
  });
});
