// 市集的公開查詢(商品、店家)與首頁篩選 —— 篩選是純函式,catalog.test.ts 測。
//
// 對 anon 來說「看得到什麼」由資料庫 RLS 決定(已核准 + 上架中 + 店家零售啟用 + 供應商啟用中);
// 但登入中的供應商 / 管理員另外看得到自家或全部的草稿,所以查詢一律再篩一次 isPubliclyVisible —— 市集上不會出現沒上架的東西。
import {
  CATEGORY_LABEL,
  isCategoryKey,
  isTemperature,
  isTwCity,
  type MarketCategoryKey,
  type Temperature,
  type TwCity,
} from "./constants";
import { isUuid, marketDb, unwrap } from "./db";
import type { MarketProductRow, MarketStoreRow } from "./types";

// 公開欄位一律明列(不用 *):不抓 disabled_reason、reject_reason、supply_id、reviewed_by;
// 供應商只抓 name / phone / is_active —— contact_email 是新訂單通知信箱,市集頁面用不到,不送到瀏覽器(catalog.test.ts 釘住)。
export const STORE_PUBLIC_COLUMNS =
  "supplier_id, is_enabled, logo_path, cover_path, intro, return_policy, delivery_cities, shipping_fee, " +
  "free_shipping_threshold, min_order_amount, ship_days, payment_methods, suppliers(name, phone, is_active)";

export const PRODUCT_PUBLIC_COLUMNS =
  "id, supplier_id, name, category, spec, price, stock, temperature, origin, storage_method, shelf_life, " +
  "description, photos, review_status, is_listed, created_at";

const PRODUCT_WITH_STORE = `${PRODUCT_PUBLIC_COLUMNS}, market_stores(${STORE_PUBLIC_COLUMNS})`;

/** 首頁一次最多抓幾筆(上架商品多到這個數字時,要改成伺服器端搜尋 —— 見計畫「風險」) */
export const LISTING_LIMIT = 500;

export const isStoreOpen = (store: MarketStoreRow | null | undefined): boolean =>
  !!store && store.is_enabled && store.suppliers?.is_active !== false;

export const isPubliclyVisible = (p: MarketProductRow): boolean =>
  p.review_status === "approved" && p.is_listed && isStoreOpen(p.market_stores);

export const fetchListedProducts = async (): Promise<MarketProductRow[]> =>
  unwrap(
    await marketDb<MarketProductRow[]>("market_products")
      .select(PRODUCT_WITH_STORE)
      .eq("review_status", "approved")
      .eq("is_listed", true)
      .order("created_at", { ascending: false })
      .limit(LISTING_LIMIT),
  ).filter(isPubliclyVisible);

/** 單一商品(不篩可見性:供應商、管理員要能預覽自己的草稿;頁面自己用 isPubliclyVisible 決定要不要標「預覽」) */
export const fetchMarketProduct = async (id: string): Promise<MarketProductRow | null> => {
  if (!isUuid(id)) return null;
  return unwrap(await marketDb<MarketProductRow>("market_products").select(PRODUCT_WITH_STORE).eq("id", id).maybeSingle());
};

export const fetchMarketStore = async (supplierId: string): Promise<MarketStoreRow | null> => {
  if (!isUuid(supplierId)) return null;
  return unwrap(
    await marketDb<MarketStoreRow>("market_stores").select(STORE_PUBLIC_COLUMNS).eq("supplier_id", supplierId).maybeSingle(),
  );
};

export const fetchStoreProducts = async (supplierId: string): Promise<MarketProductRow[]> => {
  if (!isUuid(supplierId)) return [];
  return unwrap(
    await marketDb<MarketProductRow[]>("market_products")
      .select(PRODUCT_WITH_STORE)
      .eq("supplier_id", supplierId)
      .eq("review_status", "approved")
      .eq("is_listed", true)
      .order("created_at", { ascending: false }),
  ).filter(isPubliclyVisible);
};

// ---------------------------------------------------------------------
// 首頁篩選(條件放在網址 ?q=&cat=&city=&temp=,可以分享、上一頁不會掉)
// ---------------------------------------------------------------------
export interface ProductFilters {
  q: string;
  category: MarketCategoryKey | null;
  city: TwCity | null;
  temperature: Temperature | null;
}

export const filtersFromParams = (params: URLSearchParams): ProductFilters => {
  const cat = params.get("cat");
  const city = params.get("city");
  const temp = params.get("temp");
  return {
    q: (params.get("q") ?? "").slice(0, 50),
    category: isCategoryKey(cat) ? cat : null,
    city: isTwCity(city) ? city : null,
    temperature: isTemperature(temp) ? temp : null,
  };
};

export const paramsFromFilters = (f: ProductFilters): URLSearchParams => {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q);
  if (f.category) p.set("cat", f.category);
  if (f.city) p.set("city", f.city);
  if (f.temperature) p.set("temp", f.temperature);
  return p;
};

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

const matchesQuery = (p: MarketProductRow, q: string): boolean => {
  const needle = normalize(q);
  if (!needle) return true;
  return [p.name, p.spec, p.description ?? "", p.origin ?? "", CATEGORY_LABEL[p.category], p.market_stores?.suppliers?.name ?? ""]
    .some((text) => normalize(text).includes(needle));
};

export const filterProducts = (products: MarketProductRow[], f: ProductFilters): MarketProductRow[] =>
  products.filter(
    (p) =>
      (!f.category || p.category === f.category) &&
      (!f.temperature || p.temperature === f.temperature) &&
      (!f.city || (p.market_stores?.delivery_cities ?? []).includes(f.city)) &&
      matchesQuery(p, f.q),
  );

export interface FeaturedStore {
  supplierId: string;
  name: string;
  logoPath: string | null;
  deliveryCities: TwCity[];
  productCount: number;
}

/** 精選店家:有上架商品的店(選了縣市就只算配送到那裡的店),商品多的排前面,最多 limit 家 */
export const featuredStores = (products: MarketProductRow[], city: TwCity | null, limit = 8): FeaturedStore[] => {
  const byStore = new Map<string, FeaturedStore>();
  for (const p of products) {
    const s = p.market_stores;
    if (!s || (city && !s.delivery_cities.includes(city))) continue;
    const cur = byStore.get(s.supplier_id);
    if (cur) cur.productCount += 1;
    else
      byStore.set(s.supplier_id, {
        supplierId: s.supplier_id,
        name: s.suppliers?.name ?? "店家",
        logoPath: s.logo_path,
        deliveryCities: s.delivery_cities,
        productCount: 1,
      });
  }
  return [...byStore.values()]
    .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, "zh-Hant"))
    .slice(0, limit);
};
