import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  Bot,
  CircleDollarSign,
  Cpu,
  Gauge,
  RefreshCw,
  Timer,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/metrics';
import {
  USD_PER_M_INPUT,
  USD_PER_M_OUTPUT,
  costOf,
  formatUnitPrice,
  inputTokensOf,
  outputTokensOf,
  thoughtsTokensOf,
} from './aiCost';

/* ---------------------------------------------------------------
 * 新資料表尚未進 types.ts,沿用專案既有的 cast 慣例
 * ------------------------------------------------------------- */
type Res<T> = { data: T[] | null; error: { message: string } | null };

interface Chain<T> extends PromiseLike<Res<T>> {
  eq(col: string, v: unknown): Chain<T>;
  gte(col: string, v: unknown): Chain<T>;
  order(col: string, opts?: { ascending: boolean }): Chain<T>;
  limit(n: number): Chain<T>;
  range(from: number, to: number): Chain<T>;
}

const table = <T,>(name: string) =>
  (supabase as never as {
    from: (t: string) => { select: (c: string) => Chain<T> };
  }).from(name);

/* ------------------------------ types ------------------------------ */
interface AiUsageRow {
  id: string;
  action: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Gemini 2.5 的思考 tokens(按輸出價計費);舊資料是 null */
  thoughts_tokens: number | null;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
  created_at: string;
}

/* ------------------------------ constants ------------------------------ */
// 單價與成本公式在 ./aiCost(Gemini 2.5 Flash 公告價,輸出含思考 tokens)
/** 粗估台幣用的匯率,只用於顯示 */
const TWD_RATE = 32;

const ACTION_LABEL: Record<string, string> = {
  'analyze-menu': '菜單分析',
  'analyze-chat': '對話萃取',
  chat: 'AI 對話',
  'parse-delivery-note': '送貨單辨識',
  'parse-catalog': '目錄上架辨識',
  'dish-ideas': '菜色發想',
  'quote-draft': '報價草稿',
  unknown: '未分類',
};

const ACTION_COLORS = [
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#ec4899',
  '#64748b',
];

const RANGE_OPTIONS = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
];

const usd = (v: number): string => `US$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
const twd = (v: number): string =>
  `約 NT$${Math.round(v * TWD_RATE).toLocaleString('zh-TW')}`;
const actionLabel = (a: string): string => ACTION_LABEL[a] ?? a;

/* ------------------------------ page ------------------------------ */
export default function AdminAiOpsPage() {
  const [days, setDays] = useState('30');
  const [rows, setRows] = useState<AiUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const fetchData = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);

      const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
      // 分頁讀完:PostgREST 一次最多回 1000 筆,超過的會被默默截掉 —— 流量大(正是要看成本的時候)
      // 呼叫數、tokens、成本都會偏低。排序加 id 才不會翻頁時重複或漏掉。
      const res = await fetchAllPages((from, to) =>
        table<AiUsageRow>('ai_usage')
          .select(
            'id, action, model, prompt_tokens, completion_tokens, thoughts_tokens, latency_ms, ok, error, created_at',
          )
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      );

      if (res.error) {
        setLoadError(res.error.message);
        toast.error('讀取 AI 用量失敗', { description: res.error.message });
        setRows([]);
      } else {
        setRows(res.data ?? []);
      }

      setFetchedAt(new Date());
      setLoading(false);
      setRefreshing(false);
    },
    [days],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const stats = useMemo(() => {
    const total = rows.length;
    const okCount = rows.filter((r) => r.ok).length;
    const failed = rows.filter((r) => !r.ok);
    const latencies = rows
      .map((r) => r.latency_ms)
      .filter((v): v is number => v != null && v >= 0)
      .sort((a, b) => a - b);
    const avgLatency =
      latencies.length > 0
        ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
        : null;
    const p95 =
      latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

    const inTok = rows.reduce((s, r) => s + inputTokensOf(r), 0);
    // 輸出含思考 tokens(2.5 Flash 按輸出價計費)
    const outTok = rows.reduce((s, r) => s + outputTokensOf(r), 0);
    const thoughtsTok = rows.reduce((s, r) => s + thoughtsTokensOf(r), 0);

    return {
      total,
      okCount,
      failed,
      successRate: total > 0 ? Math.round((okCount / total) * 100) : 0,
      avgLatency,
      p95,
      inTok,
      outTok,
      thoughtsTok,
      cost: costOf(inTok, outTok),
    };
  }, [rows]);

  /** 出現過的 action(依呼叫量排序),供堆疊圖與表格共用 */
  const actions = useMemo(() => {
    const count = new Map<string, number>();
    rows.forEach((r) => count.set(r.action, (count.get(r.action) ?? 0) + 1));
    return [...count.entries()].sort(([, a], [, b]) => b - a).map(([a]) => a);
  }, [rows]);

  const trend = useMemo(() => {
    if (rows.length === 0) return [];
    const n = Number(days);
    const byDay = new Map<string, Record<string, number>>();
    // 先鋪滿整段區間,沒有呼叫的日子也要留空欄,趨勢才不會被壓縮
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(d, {});
    }
    rows.forEach((r) => {
      const d = r.created_at.slice(0, 10);
      const bucket = byDay.get(d);
      if (!bucket) return;
      bucket[r.action] = (bucket[r.action] ?? 0) + 1;
    });
    return [...byDay.entries()].map(([date, counts]) => ({
      date: date.slice(5),
      ...actions.reduce<Record<string, number>>((acc, a) => {
        acc[a] = counts[a] ?? 0;
        return acc;
      }, {}),
    }));
  }, [rows, actions, days]);

  const byAction = useMemo(
    () =>
      actions.map((a) => {
        const list = rows.filter((r) => r.action === a);
        const ok = list.filter((r) => r.ok).length;
        const lat = list
          .map((r) => r.latency_ms)
          .filter((v): v is number => v != null && v >= 0);
        const inTok = list.reduce((s, r) => s + inputTokensOf(r), 0);
        const outTok = list.reduce((s, r) => s + outputTokensOf(r), 0);
        return {
          action: a,
          total: list.length,
          successRate: list.length > 0 ? Math.round((ok / list.length) * 100) : 0,
          avgLatency:
            lat.length > 0 ? Math.round(lat.reduce((s, v) => s + v, 0) / lat.length) : null,
          inTok,
          outTok,
          cost: costOf(inTok, outTok),
        };
      }),
    [actions, rows],
  );

  const models = useMemo(() => {
    const set = new Set(rows.map((r) => r.model).filter((m): m is string => !!m));
    return [...set];
  }, [rows]);

  const kpis = [
    {
      title: '總呼叫次數',
      value: stats.total.toLocaleString('zh-TW'),
      hint: RANGE_OPTIONS.find((o) => o.value === days)?.label ?? '',
      icon: Activity,
      accent: 'text-slate-800',
      bg: 'bg-slate-100',
    },
    {
      title: '成功率',
      value: `${stats.successRate}%`,
      hint: `失敗 ${stats.failed.length} 次`,
      icon: Gauge,
      accent: stats.successRate >= 95 ? 'text-emerald-600' : 'text-red-600',
      bg: stats.successRate >= 95 ? 'bg-emerald-50' : 'bg-red-50',
    },
    {
      title: '平均延遲',
      value: stats.avgLatency == null ? '—' : `${(stats.avgLatency / 1000).toFixed(1)}s`,
      hint: stats.p95 == null ? '—' : `P95 ${(stats.p95 / 1000).toFixed(1)}s`,
      icon: Timer,
      accent:
        stats.avgLatency != null && stats.avgLatency > 8000 ? 'text-amber-600' : 'text-slate-800',
      bg: 'bg-blue-50',
    },
    {
      title: 'Token 用量',
      value: (stats.inTok + stats.outTok).toLocaleString('zh-TW'),
      hint: `輸入 ${stats.inTok.toLocaleString('zh-TW')} / 輸出 ${stats.outTok.toLocaleString('zh-TW')}${
        stats.thoughtsTok > 0 ? `(含思考 ${stats.thoughtsTok.toLocaleString('zh-TW')})` : ''
      }`,
      icon: Cpu,
      accent: 'text-purple-600',
      bg: 'bg-purple-50',
    },
    {
      title: '估算成本',
      value: usd(stats.cost),
      hint: twd(stats.cost),
      icon: CircleDollarSign,
      accent: 'text-emerald-600',
      bg: 'bg-emerald-50',
    },
  ];

  /* ------------------------------ render ------------------------------ */
  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-slate-800 mb-1">AI 用量與品質 (AI Ops)</h1>
        <p className="text-sm text-slate-500 mb-6">AI 呼叫量、成功率、延遲與成本</p>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="border-slate-200">
              <CardContent className="p-4">
                <Skeleton className="h-7 w-7 rounded-lg mb-2" />
                <Skeleton className="h-7 w-20 mb-2" />
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className="border-slate-200">
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-60 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-2xl font-bold text-slate-800">AI 用量與品質 (AI Ops)</h1>
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => fetchData(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
            重新整理
          </Button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        AI 每天被呼叫幾次、成功率多少、跑多久、燒多少錢
        {models.length > 0 && <span className="text-slate-400"> · 模型 {models.join('、')}</span>}
        {fetchedAt && (
          <span className="text-slate-400"> · 更新於 {fetchedAt.toLocaleTimeString('zh-TW')}</span>
        )}
      </p>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-700">讀取 AI 用量失敗:{loadError}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => fetchData()}>
            重新載入
          </Button>
        </div>
      )}

      {rows.length === 0 && !loadError ? (
        <Card className="border-slate-200">
          <CardContent className="py-20 text-center text-slate-400">
            <Bot className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm text-slate-500 font-medium">AI 用量記錄啟用中</p>
            <p className="text-xs mt-1.5 max-w-md mx-auto leading-relaxed">
              這段期間還沒有 AI 呼叫紀錄。每一次菜單分析、對話萃取、送貨單辨識都會自動寫入
              ai_usage,之後這裡會顯示呼叫量趨勢、成功率、延遲與估算成本。
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            {kpis.map(({ title, value, hint, icon: Icon, accent, bg }) => (
              <Card key={title} className="border border-slate-200">
                <CardContent className="p-4">
                  <div className={`inline-flex p-1.5 rounded-lg ${bg} mb-2`}>
                    <Icon className={`h-4 w-4 ${accent}`} />
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ${accent}`}>{value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{title}</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-snug">{hint}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="space-y-4">
            {/* 趨勢 */}
            <Card className="border-slate-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-slate-700">
                  呼叫量趨勢(依用途堆疊)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={trend} margin={{ left: -20, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      interval="preserveStartEnd"
                      minTickGap={16}
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {actions.map((a, i) => (
                      <Bar
                        key={a}
                        dataKey={a}
                        stackId="calls"
                        name={actionLabel(a)}
                        fill={ACTION_COLORS[i % ACTION_COLORS.length]}
                        radius={i === actions.length - 1 ? [3, 3, 0, 0] : undefined}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* 依用途統計 */}
            <Card className="border-slate-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-slate-700">各用途的量、品質與成本</CardTitle>
                <p className="text-xs text-slate-500 mt-1" data-testid="ai-cost-note">
                  成本為估算值:輸入 {formatUnitPrice(USD_PER_M_INPUT)}/1M tokens、輸出{' '}
                  {formatUnitPrice(USD_PER_M_OUTPUT)}/1M tokens(Gemini 2.5 Flash 公告價;輸出 tokens
                  含思考 tokens),實際帳單以 Google Cloud 為準
                </p>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border border-slate-200 overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="text-slate-600">用途</TableHead>
                        <TableHead className="text-slate-600 text-right">呼叫數</TableHead>
                        <TableHead className="text-slate-600">成功率</TableHead>
                        <TableHead className="text-slate-600 text-right">平均延遲</TableHead>
                        <TableHead className="text-slate-600 text-right">輸入 tokens</TableHead>
                        <TableHead className="text-slate-600 text-right">輸出 tokens(含思考)</TableHead>
                        <TableHead className="text-slate-600 text-right">估算成本</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byAction.map((a) => (
                        <TableRow key={a.action} className="hover:bg-slate-50">
                          <TableCell className="text-sm font-medium text-slate-800">
                            {actionLabel(a.action)}
                          </TableCell>
                          <TableCell className="text-right text-sm text-slate-700 tabular-nums">
                            {a.total.toLocaleString('zh-TW')}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 rounded bg-slate-100 overflow-hidden min-w-[60px]">
                                <div
                                  className={`h-full rounded ${
                                    a.successRate >= 95 ? 'bg-emerald-500' : 'bg-amber-500'
                                  }`}
                                  style={{ width: `${a.successRate}%` }}
                                />
                              </div>
                              <span className="text-sm text-slate-700 tabular-nums w-10 text-right">
                                {a.successRate}%
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm text-slate-600 tabular-nums whitespace-nowrap">
                            {a.avgLatency == null ? '—' : `${(a.avgLatency / 1000).toFixed(1)}s`}
                          </TableCell>
                          <TableCell className="text-right text-sm text-slate-600 tabular-nums">
                            {a.inTok.toLocaleString('zh-TW')}
                          </TableCell>
                          <TableCell className="text-right text-sm text-slate-600 tabular-nums">
                            {a.outTok.toLocaleString('zh-TW')}
                          </TableCell>
                          <TableCell className="text-right text-sm text-slate-800 tabular-nums whitespace-nowrap">
                            {usd(a.cost)}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-slate-50 font-medium">
                        <TableCell className="text-sm text-slate-800">合計</TableCell>
                        <TableCell className="text-right text-sm text-slate-800 tabular-nums">
                          {stats.total.toLocaleString('zh-TW')}
                        </TableCell>
                        <TableCell className="text-sm text-slate-800 tabular-nums">
                          {stats.successRate}%
                        </TableCell>
                        <TableCell className="text-right text-sm text-slate-800 tabular-nums">
                          {stats.avgLatency == null ? '—' : `${(stats.avgLatency / 1000).toFixed(1)}s`}
                        </TableCell>
                        <TableCell className="text-right text-sm text-slate-800 tabular-nums">
                          {stats.inTok.toLocaleString('zh-TW')}
                        </TableCell>
                        <TableCell className="text-right text-sm text-slate-800 tabular-nums">
                          {stats.outTok.toLocaleString('zh-TW')}
                        </TableCell>
                        <TableCell className="text-right text-sm text-slate-800 tabular-nums whitespace-nowrap">
                          {usd(stats.cost)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* 失敗清單 */}
            <Card className="border-slate-200">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <AlertOctagon
                    className={`h-4 w-4 ${stats.failed.length > 0 ? 'text-red-500' : 'text-slate-400'}`}
                  />
                  <CardTitle className="text-base text-slate-700">
                    失敗紀錄 ({stats.failed.length})
                  </CardTitle>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  ok = false 的呼叫,直接看到錯誤訊息才知道要不要調 prompt、配額還是逾時
                </p>
              </CardHeader>
              <CardContent>
                {stats.failed.length === 0 ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-8 text-center text-sm text-emerald-800">
                    這段期間 {stats.total} 次呼叫全部成功,沒有失敗紀錄
                  </div>
                ) : (
                  <div className="rounded-md border border-slate-200 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-slate-50">
                          <TableHead className="text-slate-600">時間</TableHead>
                          <TableHead className="text-slate-600">用途</TableHead>
                          <TableHead className="text-slate-600">模型</TableHead>
                          <TableHead className="text-slate-600">延遲</TableHead>
                          <TableHead className="text-slate-600">錯誤訊息</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stats.failed.slice(0, 50).map((r) => (
                          <TableRow key={r.id} className="hover:bg-red-50/40">
                            <TableCell className="text-sm text-slate-500 whitespace-nowrap">
                              {new Date(r.created_at).toLocaleString('zh-TW')}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className="bg-slate-100 text-slate-700 border-slate-300"
                              >
                                {actionLabel(r.action)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-slate-500 font-mono">
                              {r.model ?? '—'}
                            </TableCell>
                            <TableCell className="text-sm text-slate-600 tabular-nums whitespace-nowrap">
                              {r.latency_ms == null ? '—' : `${(r.latency_ms / 1000).toFixed(1)}s`}
                            </TableCell>
                            <TableCell className="text-sm text-red-700 max-w-md">
                              <span className="line-clamp-2 break-all">{r.error ?? '(無錯誤訊息)'}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {stats.failed.length > 50 && (
                  <p className="text-xs text-slate-400 mt-2">
                    共 {stats.failed.length} 筆失敗,只顯示最近 50 筆
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
