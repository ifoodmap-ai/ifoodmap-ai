import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  FlaskConical, Sparkles, Loader2, Leaf, TrendingDown, Info, ChefHat, Camera,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant, canSeeCost } from "@/components/RestaurantRoute";
import { AiError, friendlyAiError, requestAi } from "@/lib/api";

/* ── 新資料表不在 types.ts,沿用專案的 loose cast 慣例 ─────────────── */
type Result<T> = { data: T[] | null; error: { message: string } | null };
interface Q<T> extends PromiseLike<Result<T>> {
  select(cols?: string): Q<T>;
  eq(col: string, val: unknown): Q<T>;
  in(col: string, vals: unknown[]): Q<T>;
  gte(col: string, val: unknown): Q<T>;
  order(col: string, opts?: { ascending: boolean }): Q<T>;
  limit(n: number): Q<T>;
}
const db = <T,>(table: string): Q<T> =>
  (supabase as never as { from: (t: string) => Q<T> }).from(table);

interface IngredientRow {
  id: string;
  canonical_name: string;
  category: string | null;
  season_months: number[] | null;
}
interface PriceRow {
  ingredient_id: string | null;
  raw_name: string | null;
  price: number | null;
  normalized_price: number | null;
  unit: string | null;
  captured_at: string;
}
interface SupplyRow {
  id: string;
  name: string;
  price: number | null;
  unit: string | null;
  is_available: boolean | null;
}

interface SeasonalItem {
  id: string;
  name: string;
  category: string | null;
  recentAvg: number | null;
  prevAvg: number | null;
  changePct: number | null;
  unit: string | null;
}

interface Idea {
  name: string;
  ingredients: string[];
  cost: number | null;
  price: number | null;
  margin: number | null;
  note: string | null;
}

const DAY = 86_400_000;

const normalizeName = (s: string) =>
  s.toLowerCase().replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "");
const money = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)}`;
const avg = (arr: number[]) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const RestaurantLabPage = () => {
  const account = useRestaurant();
  const showCost = canSeeCost(account.role);

  const [loading, setLoading] = useState(true);
  const [myIngredients, setMyIngredients] = useState<{ name: string; times: number }[]>([]);
  const [seasonal, setSeasonal] = useState<SeasonalItem[]>([]);
  const [supplies, setSupplies] = useState<SupplyRow[]>([]);
  const [cuisine, setCuisine] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [aiUnavailable, setAiUnavailable] = useState(false);

  const month = new Date().getMonth() + 1;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      const since60 = new Date(Date.now() - 60 * DAY).toISOString();

      const { data: restaurants } = await db<{ id: string; cuisine_type: string | null }>("restaurants")
        .select("id, cuisine_type")
        .eq("id", account.restaurant_id);
      const cui = restaurants?.[0]?.cuisine_type ?? "";

      const { data: dishRows } = await db<{ id: string }>("menu_dishes")
        .select("id")
        .eq("restaurant_id", account.restaurant_id);
      const dishIds = (dishRows ?? []).map((d) => d.id);

      const freq = new Map<string, number>();
      if (dishIds.length > 0) {
        const { data: ingRows } = await db<{ raw_name: string }>("menu_dish_ingredients")
          .select("raw_name")
          .in("menu_dish_id", dishIds);
        (ingRows ?? []).forEach((r) => {
          const n = (r.raw_name ?? "").trim();
          if (n) freq.set(n, (freq.get(n) ?? 0) + 1);
        });
      }
      const mine = [...freq.entries()]
        .map(([name, times]) => ({ name, times }))
        .sort((a, b) => b.times - a.times);

      const [{ data: ingredientsAll }, { data: priceRows }, { data: supplyRows }] = await Promise.all([
        db<IngredientRow>("ingredients").select("id, canonical_name, category, season_months").limit(2000),
        db<PriceRow>("price_history")
          .select("ingredient_id, raw_name, price, normalized_price, unit, captured_at")
          .gte("captured_at", since60)
          .order("captured_at", { ascending: false })
          .limit(4000),
        db<SupplyRow>("supplies").select("id, name, price, unit, is_available").eq("is_available", true),
      ]);

      const now = Date.now();
      const recentBuckets = new Map<string, number[]>();
      const prevBuckets = new Map<string, number[]>();
      const unitById = new Map<string, string | null>();

      (priceRows ?? []).forEach((p) => {
        if (!p.ingredient_id) return;
        const v = p.normalized_price != null ? Number(p.normalized_price)
          : p.price != null ? Number(p.price) : null;
        if (v == null || !Number.isFinite(v)) return;
        const ageDays = (now - new Date(p.captured_at).getTime()) / DAY;
        const target = ageDays <= 30 ? recentBuckets : ageDays <= 60 ? prevBuckets : null;
        if (!target) return;
        const bucket = target.get(p.ingredient_id);
        if (bucket) bucket.push(v);
        else target.set(p.ingredient_id, [v]);
        if (!unitById.has(p.ingredient_id)) unitById.set(p.ingredient_id, p.unit);
      });

      const inSeason = (ingredientsAll ?? []).filter(
        (i) => Array.isArray(i.season_months) && i.season_months.includes(month),
      );

      const seasonalItems: SeasonalItem[] = inSeason.map((i) => {
        const recentAvg = avg(recentBuckets.get(i.id) ?? []);
        const prevAvg = avg(prevBuckets.get(i.id) ?? []);
        const changePct = recentAvg != null && prevAvg != null && prevAvg > 0
          ? (recentAvg - prevAvg) / prevAvg
          : null;
        return {
          id: i.id,
          name: i.canonical_name,
          category: i.category,
          recentAvg,
          prevAvg,
          changePct,
          unit: unitById.get(i.id) ?? null,
        };
      });

      // 當季「便宜」= 近期均價低於前期;沒有價格資料的當季食材仍保留在後面
      seasonalItems.sort((a, b) => {
        const av = a.changePct ?? 999;
        const bv = b.changePct ?? 999;
        return av - bv;
      });

      const cheapSeasonal = seasonalItems.filter((s) => s.changePct != null && s.changePct < 0);
      const defaults = new Set<string>([
        ...mine.slice(0, 10).map((m) => m.name),
        ...(cheapSeasonal.length > 0 ? cheapSeasonal : seasonalItems).slice(0, 6).map((s) => s.name),
      ]);

      if (!cancelled) {
        setCuisine(cui);
        setMyIngredients(mine);
        setSeasonal(seasonalItems);
        setSupplies(supplyRows ?? []);
        setPicked(defaults);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.restaurant_id]);

  const cheapSeasonal = useMemo(
    () => seasonal.filter((s) => s.changePct != null && s.changePct < 0),
    [seasonal],
  );

  /** 用 supplies 最低價估成本(和「我的菜單」同一套雙向 includes 比對) */
  const cheapestFor = useMemo(() => {
    return (raw: string): number | null => {
      const key = normalizeName(raw ?? "");
      if (!key) return null;
      let best: number | null = null;
      for (const s of supplies) {
        if (s.price == null) continue;
        const sn = normalizeName(s.name ?? "");
        if (!sn) continue;
        if (sn.includes(key) || key.includes(sn)) {
          const p = Number(s.price);
          if (Number.isFinite(p) && (best == null || p < best)) best = p;
        }
      }
      return best;
    };
  }, [supplies]);

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const generate = async () => {
    const list = [...picked];
    if (list.length === 0) {
      toast.error("請先選幾樣食材");
      return;
    }
    setGenerating(true);
    try {
      // 走共用的 requestAi:apikey + 登入者的 Bearer token 都在那裡帶(user tier)
      const json = await requestAi({ action: "dish-ideas", ingredients: list, cuisine: cuisine || "台式" });
      const payload = (json?.data ?? json) as Record<string, unknown> | unknown[] | null;
      const rawList: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as Record<string, unknown>)?.dishes)
          ? ((payload as Record<string, unknown>).dishes as unknown[])
          : Array.isArray((payload as Record<string, unknown>)?.ideas)
            ? ((payload as Record<string, unknown>).ideas as unknown[])
            : [];

      const parsed: Idea[] = rawList.map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const ings = Array.isArray(r.ingredients)
          ? (r.ingredients as unknown[]).map((x) =>
              typeof x === "string" ? x : String((x as Record<string, unknown>)?.name ?? ""))
            .filter(Boolean)
          : [];
        const cost = num(r.estimated_cost ?? r.cost ?? r.food_cost);
        const price = num(r.suggested_price ?? r.price ?? r.sell_price);
        const fallbackCost = cost == null
          ? ings.reduce<number | null>((acc, n) => {
              const c = cheapestFor(n);
              if (c == null) return acc;
              return (acc ?? 0) + c;
            }, null)
          : cost;
        const marginRaw = num(r.margin ?? r.margin_rate ?? r.gross_margin);
        const margin = marginRaw != null
          ? (marginRaw > 1 ? marginRaw / 100 : marginRaw)
          : price != null && price > 0 && fallbackCost != null
            ? (price - fallbackCost) / price
            : null;
        return {
          name: String(r.name ?? r.dish_name ?? r.title ?? "未命名新菜"),
          ingredients: ings,
          cost: fallbackCost,
          price,
          margin,
          note: r.note != null ? String(r.note) : r.reason != null ? String(r.reason) : null,
        };
      }).filter((i) => i.name);

      if (parsed.length === 0) {
        setAiUnavailable(true);
        toast.info("AI 建議即將推出", { description: "這個功能還在準備中,請稍後再試" });
      } else {
        setIdeas(parsed);
        setAiUnavailable(false);
      }
    } catch (e) {
      // 用量上限、照片太大這類有錯誤碼的 → 照實說,不要講成「即將推出」
      const friendly = friendlyAiError(e);
      if (friendly) {
        toast.error(friendly);
      } else {
        setAiUnavailable(true);
        // 沒有錯誤碼的 HTTP 錯誤照舊只說狀態碼 —— 不把伺服器訊息(可能是設定類的技術字串)秀給餐廳
        toast.info("AI 建議即將推出", {
          description: e instanceof AiError ? `AI 回應 ${e.status}` : (e as Error).message,
        });
      }
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-emerald-600" />
          菜色實驗室
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          用你現有的食材 + 當季正便宜的食材,想幾道可以上的新菜
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 現有食材 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ChefHat className="h-4 w-4 text-emerald-600" />
              本店現有食材
              <span className="text-xs font-normal text-slate-400">點一下加入／移除</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {myIngredients.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-slate-400">還沒有菜單食材資料</p>
                <Link to="/restaurant/menu">
                  <Button variant="outline" size="sm" className="mt-3">
                    <Camera className="h-4 w-4 mr-1.5" />
                    先去建立菜單
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {myIngredients.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => toggle(m.name)}
                    className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                      picked.has(m.name)
                        ? "bg-emerald-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {m.name}
                    <span className="opacity-60 ml-1">×{m.times}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 當季便宜食材 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Leaf className="h-4 w-4 text-emerald-600" />
              {month} 月當季食材
            </CardTitle>
          </CardHeader>
          <CardContent>
            {seasonal.length === 0 ? (
              <div className="py-8 text-center text-slate-400">
                <p className="text-sm">資料累積中</p>
                <p className="text-xs mt-1">食材產季資料還在建置,建好後這裡會列出本月當季品項</p>
              </div>
            ) : (
              <div className="space-y-2">
                {(cheapSeasonal.length > 0 ? cheapSeasonal : seasonal).slice(0, 10).map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggle(s.name)}
                      className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                        picked.has(s.name)
                          ? "bg-emerald-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {s.name}
                    </button>
                    {s.changePct != null && s.changePct < 0 && (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[11px]">
                        <TrendingDown className="h-3 w-3 mr-1" />
                        跌 {Math.abs(s.changePct * 100).toFixed(0)}%
                      </Badge>
                    )}
                    {showCost && s.recentAvg != null && (
                      <span className="text-xs text-slate-500">
                        {money(s.recentAvg)}{s.unit ? ` / ${s.unit}` : ""}
                      </span>
                    )}
                    {s.recentAvg == null && (
                      <span className="text-xs text-slate-400">尚無報價</span>
                    )}
                  </div>
                ))}
                {cheapSeasonal.length === 0 && (
                  <p className="text-xs text-slate-400 pt-1">
                    價格資料累積中,先以產季清單供你參考
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 產生新菜建議 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-sm text-slate-500 flex-1">
              已選 <span className="font-semibold text-slate-800">{picked.size}</span> 樣食材
              {cuisine ? ` · 料理類型：${cuisine}` : ""}
            </p>
            <Button
              onClick={generate}
              disabled={generating || picked.size === 0}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {generating
                ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                : <Sparkles className="h-4 w-4 mr-1.5" />}
              產生新菜建議
            </Button>
          </div>

          {aiUnavailable && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <Info className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" />
              <span>AI 建議即將推出。功能上線前,你仍可以參考上面的當季便宜食材自己組合新菜。</span>
            </div>
          )}
        </CardContent>
      </Card>

      {ideas.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ideas.map((idea, i) => (
            <Card key={`${idea.name}-${i}`}>
              <CardContent className="pt-6">
                <h3 className="font-semibold text-slate-800 mb-2">{idea.name}</h3>
                {idea.ingredients.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {idea.ingredients.map((n) => (
                      <span key={n} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                        {n}
                      </span>
                    ))}
                  </div>
                )}
                {idea.note && <p className="text-xs text-slate-400 mb-3">{idea.note}</p>}

                {showCost ? (
                  <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                    <div>
                      <p className="text-[11px] text-slate-400">預估成本</p>
                      <p className="text-sm font-semibold text-slate-800">
                        {idea.cost != null ? money(idea.cost) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-400">建議售價</p>
                      <p className="text-sm font-semibold text-slate-800">
                        {idea.price != null ? money(idea.price) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-400">預估毛利率</p>
                      <p className={`text-sm font-semibold ${
                        idea.margin == null ? "text-slate-400"
                          : idea.margin < 0.3 ? "text-red-600"
                            : idea.margin > 0.6 ? "text-emerald-600" : "text-amber-600"
                      }`}>
                        {idea.margin != null ? `${(idea.margin * 100).toFixed(0)}%` : "—"}
                      </p>
                    </div>
                  </div>
                ) : (
                  idea.price != null && (
                    <div className="border-t border-slate-100 pt-3">
                      <p className="text-[11px] text-slate-400">建議售價</p>
                      <p className="text-sm font-semibold text-slate-800">{money(idea.price)}</p>
                    </div>
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default RestaurantLabPage;
