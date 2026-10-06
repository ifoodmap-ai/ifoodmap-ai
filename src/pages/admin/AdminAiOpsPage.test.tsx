// /admin/ai-ops 的成本估算:單價改成 Gemini 2.5 Flash 公告價(每百萬 tokens 輸入 US$0.30、輸出 US$2.50),
// 輸出成本要把 ai_usage.thoughts_tokens(思考 tokens,按輸出價計費)算進去;沒有值當 0。

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './testFakeSupabase';
import AdminAiOpsPage from './AdminAiOpsPage';
import {
  USD_PER_M_INPUT,
  USD_PER_M_OUTPUT,
  costOf,
  formatUnitPrice,
  inputTokensOf,
  outputTokensOf,
} from './aiCost';

vi.mock('@/integrations/supabase/client', async () => ({
  supabase: (await import('./testFakeSupabase')).fakeSupabase.client,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('aiCost:單價與公式', () => {
  it('單價 = 輸入 US$0.30、輸出 US$2.50(每百萬 tokens)', () => {
    expect(USD_PER_M_INPUT).toBe(0.3);
    expect(USD_PER_M_OUTPUT).toBe(2.5);
    expect(formatUnitPrice(USD_PER_M_INPUT)).toBe('US$0.30');
    expect(formatUnitPrice(USD_PER_M_OUTPUT)).toBe('US$2.50');
  });

  it('輸出 tokens = completion + thoughts;thoughts 沒有值(舊資料 null / 沒這欄)當 0', () => {
    expect(outputTokensOf({ prompt_tokens: 10, completion_tokens: 100, thoughts_tokens: 512 })).toBe(612);
    expect(outputTokensOf({ prompt_tokens: 10, completion_tokens: 100, thoughts_tokens: null })).toBe(100);
    expect(outputTokensOf({ prompt_tokens: 10, completion_tokens: 100 })).toBe(100);
    expect(outputTokensOf({ prompt_tokens: null, completion_tokens: null, thoughts_tokens: null })).toBe(0);
    expect(inputTokensOf({ prompt_tokens: null, completion_tokens: 1 })).toBe(0);
  });

  it('成本 = 輸入 × 0.30/1M + 輸出(含思考)× 2.50/1M', () => {
    expect(costOf(1_000_000, 0)).toBeCloseTo(0.3, 10);
    expect(costOf(0, 1_000_000)).toBeCloseTo(2.5, 10);
    // 一次菜單分析:輸入 2,000、輸出 787 + 思考 512
    const row = { prompt_tokens: 2_000, completion_tokens: 787, thoughts_tokens: 512 };
    expect(costOf(inputTokensOf(row), outputTokensOf(row))).toBeCloseTo(0.0006 + 0.0032475, 10);
  });
});

describe('AdminAiOpsPage:頁面上的成本', () => {
  beforeEach(() => {
    fakeSupabase.reset();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('測試不准打網路'))));
    const now = new Date().toISOString();
    fakeSupabase.respond((q) =>
      q.table === 'ai_usage'
        ? {
            data: [
              // 輸入 1M、輸出 0.1M + 思考 0.3M → 0.30 + 0.4 × 2.50 = US$1.30
              { id: 'u1', action: 'analyze-menu', model: 'gemini-2.5-flash', prompt_tokens: 1_000_000, completion_tokens: 100_000, thoughts_tokens: 300_000, latency_ms: 4000, ok: true, error: null, created_at: now },
              // 舊資料:沒有 thoughts_tokens
              { id: 'u2', action: 'chat', model: 'gemini-2.5-flash', prompt_tokens: 0, completion_tokens: 0, thoughts_tokens: null, latency_ms: 900, ok: true, error: null, created_at: now },
            ],
          }
        : undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('讀 thoughts_tokens;估算成本含思考 tokens(US$1.30,不是只算 completion 的 US$0.55);說明寫新單價', async () => {
    render(<AdminAiOpsPage />);

    await waitFor(() => expect(screen.getAllByText('US$1.30').length).toBeGreaterThan(0));
    expect(screen.queryByText('US$0.55')).toBeNull();

    const [query] = fakeSupabase.queriesOf('ai_usage');
    expect(query.columns).toContain('thoughts_tokens');

    const note = screen.getByTestId('ai-cost-note');
    expect(note).toHaveTextContent('輸入 US$0.30/1M tokens');
    expect(note).toHaveTextContent('輸出 US$2.50/1M tokens');
    expect(note).toHaveTextContent('含思考 tokens');
    // KPI 提示:輸出 400,000(含思考 300,000)
    expect(screen.getByText(/輸出 400,000\(含思考 300,000\)/)).toBeInTheDocument();
  });

  it('超過 1000 筆(PostgREST 單次上限)→ 分頁讀完,呼叫數與成本不會被截掉', async () => {
    const now = new Date().toISOString();
    // 1,500 筆,每筆輸入 1,000、輸出 100 + 思考 100 tokens
    const many = Array.from({ length: 1500 }, (_, i) => ({
      id: `u${String(i).padStart(4, '0')}`,
      action: 'chat',
      model: 'gemini-2.5-flash',
      prompt_tokens: 1000,
      completion_tokens: 100,
      thoughts_tokens: 100,
      latency_ms: 800,
      ok: true,
      error: null,
      created_at: now,
    }));
    fakeSupabase.respond((q) => (q.table === 'ai_usage' ? { data: many } : undefined));

    render(<AdminAiOpsPage />);

    // 1,500 × (1,000 × 0.30 + 200 × 2.50) / 1M = US$1.20(只讀到 1000 筆會是 US$0.80)
    await waitFor(() => expect(screen.getAllByText('US$1.20').length).toBeGreaterThan(0));
    expect(screen.getAllByText('1,500').length).toBeGreaterThan(0);
    expect(screen.queryByText('US$0.80')).toBeNull();

    const pages = fakeSupabase.queriesOf('ai_usage');
    expect(pages.map((q) => q.filters.find((f) => f.op === 'range')?.value)).toEqual([
      [0, 999],
      [1000, 1999],
      [1500, 2499],
    ]);
    // 翻頁要固定排序(created_at 再加 id),不然可能重複或漏掉
    expect(pages[0].filters.filter((f) => f.op === 'order').map((f) => f.column)).toEqual(['created_at', 'id']);
  });
});
