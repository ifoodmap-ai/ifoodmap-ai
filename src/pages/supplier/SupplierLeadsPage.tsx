import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  MapPin,
  PackagePlus,
  PhoneCall,
  Radar,
  Sparkles,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

type LeadStatus = 'new' | 'viewed' | 'contacted' | 'won' | 'lost' | 'dismissed';

/** 官網 AI 助手留言轉進來的聯絡資料(後端快照,只有被轉到的供應商看得到) */
interface LeadContact {
  company?: string;
  name?: string;
  phone?: string;
  line?: string;
  email?: string;
  area?: string;
  frequency?: string;
  notes?: string;
  contact_time?: string;
}

interface LeadRow {
  id: string;
  contact?: LeadContact | null;
  supplier_id: string;
  restaurant_id: string | null;
  analysis_id: string | null;
  matched_items: unknown;
  score: number | null;
  reason: string | null;
  status: LeadStatus | string;
  created_at: string;
}

interface AnalysisRow {
  id: string;
  user_id: string | null;
  created_at: string;
  ingredient_list: { name?: string }[] | null;
}

interface GapItem {
  name: string;
  count: number;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  new: { label: '新商機', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  viewed: { label: '已檢視', className: 'bg-slate-100 text-slate-600 border-slate-300' },
  contacted: { label: '已聯繫', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  won: { label: '已成交', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  lost: { label: '未成交', className: 'bg-slate-100 text-slate-500 border-slate-300' },
  dismissed: { label: '不感興趣', className: 'bg-slate-100 text-slate-500 border-slate-300' },
};

const TABS: { value: string; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '新商機' },
  { value: 'contacted', label: '已聯繫' },
  { value: 'won', label: '已成交' },
  { value: 'dismissed', label: '不感興趣' },
];

const DAY_MS = 86_400_000;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '');

/** matched_items 可能是字串陣列或物件陣列,兩種都要吃 */
const parseItems = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((it) => {
        if (typeof it === 'string') return it.trim();
        if (it && typeof it === 'object') {
          const o = it as {
            name?: string; item?: string; ingredient?: string; raw_name?: string;
            quantity?: number | string; unit?: string;
          };
          const n = o.name ?? o.item ?? o.ingredient ?? o.raw_name;
          if (!n) return '';
          const qty = o.quantity != null && o.quantity !== '' ? ` ${o.quantity}${o.unit ?? ''}` : '';
          return `${String(n).trim()}${qty}`;
        }
        return '';
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object') return Object.keys(raw as Record<string, unknown>);
  return [];
};

const scoreClass = (score: number | null): string => {
  if (score == null) return 'bg-slate-100 text-slate-600 border-slate-300';
  if (score >= 80) return 'bg-emerald-100 text-emerald-800 border-emerald-300';
  if (score >= 50) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-slate-100 text-slate-600 border-slate-300';
};

const formatDate = (v: string): string => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

export default function SupplierLeadsPage() {
  const [loading, setLoading] = useState(true);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [restaurantNames, setRestaurantNames] = useState<Record<string, string>>({});
  const [serviceAreas, setServiceAreas] = useState<string[]>([]);
  const [mySupplyNames, setMySupplyNames] = useState<string[]>([]);
  const [gapItems, setGapItems] = useState<GapItem[]>([]);
  const [analysisScope, setAnalysisScope] = useState({ total: 0, inArea: 0, regionFiltered: false });
  const [gapLoading, setGapLoading] = useState(true);
  const [tab, setTab] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { if (!cancelled) { setLoading(false); setGapLoading(false); } return; }

        const { data: acct } = (await (supabase as never)
          .from('supplier_accounts')
          .select('supplier_id')
          .eq('user_id', session.user.id)
          .eq('is_active', true)
          .maybeSingle()) as { data: { supplier_id: string } | null };

        const sid = acct?.supplier_id ?? null;
        if (!sid) { if (!cancelled) { setLoading(false); setGapLoading(false); } return; }
        if (!cancelled) setSupplierId(sid);

        // ── 商機列表 ────────────────────────────────
        const { data: leadRows } = (await (supabase as never)
          .from('supplier_leads')
          .select('id, supplier_id, restaurant_id, analysis_id, matched_items, score, reason, status, created_at, contact')
          .eq('supplier_id', sid)
          .order('created_at', { ascending: false })) as { data: LeadRow[] | null };
        const rows = leadRows ?? [];

        const restaurantIds = Array.from(
          new Set(rows.map((l) => l.restaurant_id).filter(Boolean) as string[]),
        );
        const nameMap: Record<string, string> = {};
        if (restaurantIds.length > 0) {
          const { data: rs } = (await (supabase as never)
            .from('restaurants')
            .select('id, name')
            .in('id', restaurantIds)) as { data: { id: string; name: string }[] | null };
          (rs ?? []).forEach((r) => { nameMap[r.id] = r.name; });
        }

        if (!cancelled) {
          setLeads(rows);
          setRestaurantNames(nameMap);
          setLoading(false);
        }

        // ── 品項缺口分析 ─────────────────────────────
        const [supplierRes, suppliesRes, analysisRes] = await Promise.all([
          (supabase as never).from('suppliers').select('service_areas').eq('id', sid).maybeSingle(),
          (supabase as never).from('supplies').select('name').eq('supplier_id', sid),
          (supabase as never)
            .from('analysis_records')
            .select('id, user_id, created_at, ingredient_list')
            .gte('created_at', new Date(Date.now() - 90 * DAY_MS).toISOString()),
        ]);

        const areas = (((supplierRes as { data: { service_areas: string[] | null } | null }).data)?.service_areas ?? [])
          .filter(Boolean);
        const supplyNames = (((suppliesRes as { data: { name: string }[] | null }).data) ?? [])
          .map((s) => s.name)
          .filter(Boolean);
        const analyses = ((analysisRes as { data: AnalysisRow[] | null }).data) ?? [];

        // 需求 → 餐廳 → 城市,才能對到服務區域
        let cityByUser: Record<string, string> = {};
        const userIds = Array.from(new Set(analyses.map((a) => a.user_id).filter(Boolean) as string[]));
        if (areas.length > 0 && userIds.length > 0) {
          const { data: accts } = (await (supabase as never)
            .from('restaurant_accounts')
            .select('user_id, restaurant_id')
            .in('user_id', userIds)) as { data: { user_id: string; restaurant_id: string }[] | null };
          const pairs = accts ?? [];
          const rids = Array.from(new Set(pairs.map((p) => p.restaurant_id).filter(Boolean)));
          if (rids.length > 0) {
            const { data: rs } = (await (supabase as never)
              .from('restaurants')
              .select('id, city')
              .in('id', rids)) as { data: { id: string; city: string | null }[] | null };
            const cityById: Record<string, string> = {};
            (rs ?? []).forEach((r) => { if (r.city) cityById[r.id] = r.city; });
            cityByUser = pairs.reduce<Record<string, string>>((acc, p) => {
              const c = cityById[p.restaurant_id];
              if (c) acc[p.user_id] = c;
              return acc;
            }, {});
          }
        }

        const inServiceArea = (userId: string | null): boolean => {
          if (areas.length === 0) return true;
          if (!userId) return true;
          const city = cityByUser[userId];
          if (!city) return true; // 判定不出區域的需求一併計入
          const c = norm(city);
          return areas.some((a) => {
            const n = norm(a);
            return n.length > 0 && (c.includes(n) || n.includes(c));
          });
        };

        const scoped = analyses.filter((a) => inServiceArea(a.user_id));

        // 每筆需求單內同名品項只算一次
        const demand = new Map<string, { display: string; count: number }>();
        scoped.forEach((a) => {
          const seen = new Set<string>();
          (a.ingredient_list ?? []).forEach((i) => {
            const raw = i?.name?.trim();
            if (!raw) return;
            const key = norm(raw);
            if (!key || seen.has(key)) return;
            seen.add(key);
            const cur = demand.get(key);
            if (cur) cur.count += 1;
            else demand.set(key, { display: raw, count: 1 });
          });
        });

        const normalizedSupplies = supplyNames.map(norm).filter(Boolean);
        const alreadyListed = (key: string): boolean =>
          normalizedSupplies.some((s) => s.includes(key) || key.includes(s));

        const gaps = [...demand.entries()]
          .filter(([key]) => !alreadyListed(key))
          .map(([, v]) => ({ name: v.display, count: v.count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        if (!cancelled) {
          setServiceAreas(areas);
          setMySupplyNames(supplyNames);
          setGapItems(gaps);
          setAnalysisScope({
            total: analyses.length,
            inArea: scoped.length,
            regionFiltered: areas.length > 0,
          });
          setGapLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          toast.error('載入商機資料失敗', { description: (e as { message?: string })?.message });
          setLoading(false);
          setGapLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const updateStatus = async (lead: LeadRow, next: LeadStatus) => {
    setBusyId(lead.id);
    const prev = lead.status;
    setLeads((list) => list.map((l) => (l.id === lead.id ? { ...l, status: next } : l)));
    const { error } = await (supabase as never)
      .from('supplier_leads')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', lead.id);
    setBusyId(null);
    if (error) {
      setLeads((list) => list.map((l) => (l.id === lead.id ? { ...l, status: prev } : l)));
      toast.error('更新失敗', { description: (error as { message?: string }).message });
      return;
    }
    toast.success(`已標記為「${STATUS_META[next]?.label ?? next}」`);
  };

  const sorted = useMemo(() => {
    const rank = (s: string) => (s === 'new' ? 0 : 1);
    return [...leads].sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [leads]);

  const filtered = useMemo(
    () => (tab === 'all' ? sorted : sorted.filter((l) => l.status === tab)),
    [sorted, tab],
  );

  const newCount = leads.filter((l) => l.status === 'new').length;
  const maxGap = gapItems.length > 0 ? gapItems[0].count : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-1">商機雷達</h1>
      <p className="text-sm text-gray-500 mb-6">
        平台依需求單自動媒合的潛在客戶,越早回覆成交率越高
      </p>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-slate-200">
              <CardContent className="p-4 space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-8 w-64" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !supplierId ? (
        <div className="text-center py-20 text-gray-400">此帳號尚未綁定供應商</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                {TABS.map(({ value, label }) => (
                  <TabsTrigger key={value} value={value}>{label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {newCount > 0 && (
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                <Sparkles size={12} className="mr-1" />{newCount} 筆新商機待處理
              </Badge>
            )}
          </div>

          {leads.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="py-16 text-center">
                <Radar size={40} className="mx-auto mb-3 text-slate-300" />
                <p className="text-slate-600 font-medium mb-1">目前還沒有商機</p>
                <p className="text-sm text-slate-400 max-w-md mx-auto">
                  當餐廳上傳菜單或送出需求單、且品項與你的商品目錄相符時,
                  平台會自動把商機推送到這裡。把商品目錄補齊,能讓你被媒合到更多需求。
                </p>
                <Link to="/supplier/catalog">
                  <Button variant="outline" size="sm" className="mt-4 border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                    <PackagePlus size={15} className="mr-1.5" />去補齊商品目錄
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : filtered.length === 0 ? (
            <Card className="border-slate-200">
              <CardContent className="py-12 text-center text-slate-400 text-sm">
                這個分類目前沒有商機
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {filtered.map((lead) => {
                const meta = STATUS_META[lead.status] ?? {
                  label: String(lead.status),
                  className: 'bg-slate-100 text-slate-600 border-slate-300',
                };
                const items = parseItems(lead.matched_items);
                const isNew = lead.status === 'new';
                return (
                  <Card
                    key={lead.id}
                    className={`border ${isNew ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200'}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-slate-800">
                              {(lead.restaurant_id && restaurantNames[lead.restaurant_id]) || lead.contact?.company || '未具名餐廳'}
                            </p>
                            <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
                            {lead.score != null && (
                              <Badge variant="outline" className={scoreClass(lead.score)}>
                                <TrendingUp size={11} className="mr-1" />媒合分數 {lead.score}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 mt-1">推送於 {formatDate(lead.created_at)}</p>
                        </div>
                      </div>

                      {items.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-3">
                          {items.slice(0, 12).map((it, i) => (
                            <span
                              key={`${lead.id}-item-${i}`}
                              className="px-2 py-0.5 rounded-full bg-white border border-slate-200 text-xs text-slate-600"
                            >
                              {it}
                            </span>
                          ))}
                          {items.length > 12 && (
                            <span className="px-2 py-0.5 text-xs text-slate-400">
                              +{items.length - 12} 項
                            </span>
                          )}
                        </div>
                      )}

                      {lead.contact && (
                        <dl
                          className="mt-3 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 rounded-lg border border-emerald-100 bg-white px-3 py-2.5"
                          aria-label="客戶聯絡資料"
                        >
                          {([
                            ['聯絡人', lead.contact.name],
                            ['電話', lead.contact.phone],
                            ['LINE', lead.contact.line],
                            ['Email', lead.contact.email],
                            ['配送地點', lead.contact.area],
                            ['配送頻率', lead.contact.frequency],
                            ['方便聯繫', lead.contact.contact_time],
                            ['特殊需求', lead.contact.notes],
                          ] as const)
                            .filter(([, v]) => !!v)
                            .map(([k, v]) => (
                              <div key={k} className="flex gap-2 min-w-0">
                                <dt className="shrink-0 text-slate-400">{k}</dt>
                                <dd className="min-w-0 break-words text-slate-800">
                                  {k === '電話' ? (
                                    <a href={`tel:${String(v).replace(/[^0-9+]/g, '')}`} className="text-emerald-700 underline underline-offset-2">{v}</a>
                                  ) : k === 'Email' ? (
                                    <a href={`mailto:${v}`} className="text-emerald-700 underline underline-offset-2">{v}</a>
                                  ) : v}
                                </dd>
                              </div>
                            ))}
                        </dl>
                      )}

                      {lead.reason && (
                        <p className="text-sm text-slate-600 mt-3 bg-white/70 rounded-lg border border-slate-100 px-3 py-2">
                          {lead.reason}
                        </p>
                      )}

                      <div className="flex flex-wrap gap-2 mt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-blue-200 text-blue-700 hover:bg-blue-50"
                          disabled={busyId === lead.id || lead.status === 'contacted'}
                          onClick={() => updateStatus(lead, 'contacted')}
                        >
                          <PhoneCall size={14} className="mr-1.5" />標記已聯繫
                        </Button>
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          disabled={busyId === lead.id || lead.status === 'won'}
                          onClick={() => updateStatus(lead, 'won')}
                        >
                          <CheckCircle2 size={14} className="mr-1.5" />已成交
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-slate-400 hover:text-slate-600"
                          disabled={busyId === lead.id || lead.status === 'dismissed'}
                          onClick={() => updateStatus(lead, 'dismissed')}
                        >
                          <XCircle size={14} className="mr-1.5" />不感興趣
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* ── 品項缺口分析 ───────────────────────────── */}
          <Card className="border-slate-200 mt-6">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-slate-700 flex items-center gap-2">
                <PackagePlus size={16} className="text-slate-400" />
                品項缺口分析
              </CardTitle>
              <p className="text-xs text-slate-400">
                近 90 天買家需求裡出現最多、但你還沒上架的品項 Top 10
              </p>
            </CardHeader>
            <CardContent>
              {gapLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mb-4">
                    <span className="flex items-center gap-1">
                      <MapPin size={12} className="text-slate-400" />
                      服務區域:{serviceAreas.length > 0 ? serviceAreas.join('、') : '未設定(全區統計)'}
                    </span>
                    <span>
                      取樣需求單:{analysisScope.inArea} 筆
                      {analysisScope.regionFiltered && analysisScope.total !== analysisScope.inArea
                        ? `(全平台 ${analysisScope.total} 筆)`
                        : ''}
                    </span>
                    <span>你已上架 {mySupplyNames.length} 項商品</span>
                  </div>

                  {analysisScope.inArea === 0 ? (
                    <div className="py-10 text-center text-slate-400 text-sm">
                      近 90 天還沒有可分析的需求資料
                    </div>
                  ) : gapItems.length === 0 ? (
                    <div className="py-10 text-center text-slate-400 text-sm">
                      <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-300" />
                      <p className="text-slate-600">買家近期需求的品項你都已經上架了</p>
                    </div>
                  ) : (
                    <>
                      <div className="space-y-2">
                        {gapItems.map((g, i) => (
                          <div key={g.name} className="flex items-center gap-3">
                            <span className="w-5 shrink-0 text-xs text-slate-400 tabular-nums text-right">
                              {i + 1}
                            </span>
                            <span className="w-28 shrink-0 text-sm text-slate-700 truncate" title={g.name}>
                              {g.name}
                            </span>
                            <div className="flex-1 h-5 rounded bg-slate-100 overflow-hidden">
                              <div
                                className="h-full rounded bg-amber-400/80"
                                style={{ width: `${maxGap > 0 ? Math.max(6, (g.count / maxGap) * 100) : 0}%` }}
                              />
                            </div>
                            <span className="w-20 shrink-0 text-xs text-slate-500 tabular-nums text-right">
                              {g.count} 次需求
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                        <p className="text-xs text-slate-400">
                          上架這些品項可以提高被媒合到商機的機會
                        </p>
                        <Link to="/supplier/catalog">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                          >
                            <PackagePlus size={15} className="mr-1.5" />去上架商品
                          </Button>
                        </Link>
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
