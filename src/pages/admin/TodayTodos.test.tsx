// 總覽「營運」分頁的「今日待辦」:四個數字、各自點到對應分頁;0 照實顯示 0;查詢失敗顯示「讀取失敗」不是 0。
// 查詢走真的 adminCounts(只把 Supabase 換成假的),所以同時驗證每個數字「查哪張表、怎麼篩」。

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeResponse, type RecordedQuery } from './testFakeSupabase';
import TodayTodos from './TodayTodos';

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('./testFakeSupabase')).fakeSupabase.client,
}));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const renderTodos = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <TodayTodos />
    </MemoryRouter>,
  );

const tile = (key: 'stuck' | 'applications' | 'disputes' | 'analyses') => screen.getByTestId(`todo-${key}`);
const value = (key: 'stuck' | 'applications' | 'disputes' | 'analyses') => screen.getByTestId(`todo-${key}-value`);

/** 各表的回應:沒列到的表用預設(空) */
type Table = 'order_pipeline' | 'supplier_orders' | 'supplier_applications' | 'disputes' | 'analysis_records';
const respondByTable = (map: Partial<Record<Table, (q: RecordedQuery) => FakeResponse>>) =>
  fakeSupabase.respond((q) => map[q.table as Table]?.(q));

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSupabase.reset();
  fetchGuard = vi.fn(() => Promise.reject(new Error('測試不准打網路')));
  vi.stubGlobal('fetch', fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe('今日待辦 — 四個數字與連結', () => {
  it('四個數字都顯示,各自連到對應分頁', async () => {
    respondByTable({
      order_pipeline: () => ({
        data: [
          { id: 'o1', status: 'submitted', current_stage_since: hoursAgo(13) }, // 待派發 SLA 12h → 卡關
          { id: 'o2', status: 'delivered', current_stage_since: hoursAgo(80) }, // 待收貨 SLA 72h → 卡關
          { id: 'o3', status: 'dispatched', current_stage_since: hoursAgo(2) }, // 待接單 SLA 24h → 沒事
        ],
      }),
      supplier_applications: () => ({ count: 2 }),
      disputes: () => ({ count: 4 }),
      analysis_records: () => ({ count: 7 }),
    });
    renderTodos();

    await waitFor(() => expect(value('analyses')).toHaveTextContent('7'));
    expect(value('stuck')).toHaveTextContent('2');
    expect(value('applications')).toHaveTextContent('2');
    expect(value('disputes')).toHaveTextContent('4');

    expect(screen.getByRole('heading', { name: '今日待辦' })).toBeInTheDocument();
    expect(tile('stuck')).toHaveAttribute('href', '/admin/pipeline');
    expect(tile('applications')).toHaveAttribute('href', '/admin/applications');
    expect(tile('disputes')).toHaveAttribute('href', '/admin/disputes');
    expect(tile('analyses')).toHaveAttribute('href', '/admin/analyses');
    // 連結的名字就是「標籤 + 數字」,螢幕閱讀器念得出來
    expect(screen.getByRole('link', { name: /卡關訂單\s*2/ })).toBe(tile('stuck'));
  });

  it('每個數字查的是對的表、用對的條件;三個純計數只要筆數(head + exact count)', async () => {
    renderTodos();
    await waitFor(() => expect(value('analyses')).toHaveTextContent('0'));

    const q = (table: string) => fakeSupabase.queriesOf(table);

    expect(q('supplier_applications')).toHaveLength(1);
    expect(q('supplier_applications')[0].options).toEqual({ count: 'exact', head: true });
    expect(q('supplier_applications')[0].filters).toEqual([{ op: 'eq', column: 'status', value: 'pending' }]);

    expect(q('disputes')[0].options).toEqual({ count: 'exact', head: true });
    expect(q('disputes')[0].filters).toEqual([{ op: 'in', column: 'status', value: ['open', 'investigating'] }]);

    expect(q('analysis_records')[0].options).toEqual({ count: 'exact', head: true });
    // 待審分析 = 還在 pending_review、而且還沒被形象站訪客註冊認領(claimed_at is null)
    expect(q('analysis_records')[0].filters).toEqual([
      { op: 'eq', column: 'status', value: 'pending_review' },
      { op: 'is', column: 'claimed_at', value: null },
    ]);

    expect(q('order_pipeline')[0].columns).toBe('id, status, current_stage_since');

    // 純讀取:今日待辦不寫任何資料
    expect(fakeSupabase.writes()).toEqual([]);
  });
});

describe('今日待辦 — 數字為 0', () => {
  it('四個都是 0 就照實顯示 0,不是「讀取失敗」', async () => {
    respondByTable({
      order_pipeline: () => ({ data: [] }),
      supplier_applications: () => ({ count: 0 }),
      disputes: () => ({ count: 0 }),
      analysis_records: () => ({ count: 0 }),
    });
    renderTodos();

    await waitFor(() => {
      (['stuck', 'applications', 'disputes', 'analyses'] as const).forEach((k) => expect(value(k)).toHaveTextContent(/^0$/));
    });
    expect(screen.queryByText('讀取失敗')).toBeNull();
  });

  it('進行中的單都在時限內、或狀態沒有 SLA(草稿、已評價)→ 卡關 0', async () => {
    respondByTable({
      order_pipeline: () => ({
        data: [
          { id: 'a', status: 'quoted', current_stage_since: hoursAgo(47) }, // 待確認 48h,還沒到
          { id: 'b', status: 'draft', current_stage_since: hoursAgo(9999) }, // 草稿沒有 SLA
          { id: 'c', status: 'reviewed', current_stage_since: hoursAgo(9999) }, // 已評價沒有 SLA
        ],
      }),
    });
    renderTodos();
    await waitFor(() => expect(value('stuck')).toHaveTextContent(/^0$/));
  });
});

describe('今日待辦 — 查詢失敗', () => {
  it('其中一個查詢失敗 → 那一格顯示「—」與「讀取失敗」,其他三格照常顯示', async () => {
    respondByTable({
      order_pipeline: () => ({ data: [{ id: 'o1', status: 'submitted', current_stage_since: hoursAgo(30) }] }),
      supplier_applications: () => ({ error: { message: 'permission denied for table supplier_applications' } }),
      disputes: () => ({ count: 1 }),
      analysis_records: () => ({ count: 3 }),
    });
    renderTodos();

    await waitFor(() => expect(within(tile('applications')).getByText('讀取失敗')).toBeInTheDocument());
    expect(value('applications')).toHaveTextContent('—');
    expect(value('applications')).not.toHaveTextContent('0');
    expect(value('stuck')).toHaveTextContent('1');
    expect(value('disputes')).toHaveTextContent('1');
    expect(value('analyses')).toHaveTextContent('3');
    // 失敗的那一格仍然可以點過去看
    expect(tile('applications')).toHaveAttribute('href', '/admin/applications');
  });

  it('沒有錯誤但拿不到筆數(count 為 null)也算失敗,不能當成 0', async () => {
    respondByTable({ disputes: () => ({ count: null }) });
    renderTodos();
    await waitFor(() => expect(within(tile('disputes')).getByText('讀取失敗')).toBeInTheDocument());
    expect(value('disputes')).toHaveTextContent('—');
  });

  it('order_pipeline view 不能用 → 退回查 supplier_orders 的進行中狀態,數字照算', async () => {
    respondByTable({
      order_pipeline: () => ({ error: { message: 'relation "order_pipeline" does not exist' } }),
      supplier_orders: () => ({ data: [{ id: 'x', status: 'disputed', current_stage_since: hoursAgo(49) }] }), // 爭議中 48h
    });
    renderTodos();

    await waitFor(() => expect(value('stuck')).toHaveTextContent(/^1$/));
    const fallback = fakeSupabase.queriesOf('supplier_orders')[0];
    expect(fallback.filters[0].op).toBe('in');
    expect(fallback.filters[0].column).toBe('status');
    expect(fallback.filters[0].value).toEqual(expect.arrayContaining(['submitted', 'delivered', 'pending', 'sent', 'discrepancy', 'disputed']));
    expect(fallback.filters[0].value).not.toContain('closed');
  });

  it('view 跟後備查詢都失敗 → 卡關訂單顯示「讀取失敗」', async () => {
    respondByTable({
      order_pipeline: () => ({ error: { message: 'boom' } }),
      supplier_orders: () => ({ error: { message: 'boom again' } }),
    });
    renderTodos();
    await waitFor(() => expect(within(tile('stuck')).getByText('讀取失敗')).toBeInTheDocument());
    expect(value('stuck')).toHaveTextContent('—');
  });

  it('按「重新整理」會重查;這次成功就換成數字', async () => {
    let fail = true;
    respondByTable({
      analysis_records: () => (fail ? { error: { message: 'timeout' } } : { count: 5 }),
    });
    renderTodos();
    await waitFor(() => expect(within(tile('analyses')).getByText('讀取失敗')).toBeInTheDocument());

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重新整理' }));

    await waitFor(() => expect(value('analyses')).toHaveTextContent('5'));
    expect(within(tile('analyses')).queryByText('讀取失敗')).toBeNull();
    expect(fakeSupabase.queriesOf('analysis_records')).toHaveLength(2);
  });
});

describe('今日待辦 — 讀取中', () => {
  it('還沒回來之前顯示「讀取中」,不會先閃一個 0', () => {
    fakeSupabase.respond(() => undefined);
    renderTodos();
    (['stuck', 'applications', 'disputes', 'analyses'] as const).forEach((k) => {
      expect(value(k)).toHaveTextContent('讀取中');
      expect(value(k)).not.toHaveTextContent('0');
    });
  });
});
