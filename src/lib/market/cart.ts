// 購物車:按店家分組、小計、運費、免運、最低訂購金額、配送縣市 —— 純函式,cart.test.ts 測。
//
// 瀏覽器只存 [{productId, qty}](localStorage,見 useCart.ts);價格、庫存、店家條件每次都重新跟資料庫拿,
// 所以購物車裡永遠是最新的價格。運費規則跟 market_place_order 一樣:小計 ≥ 免運門檻 → 0,否則店家的固定運費。
// 🔴 這裡算的金額只是給人看的;真正收多少由資料庫重算(結帳時送 expected_totals,不一樣就回 PRICE_CHANGED)。
import { isPubliclyVisible } from "./catalog";
import type { TwCity } from "./constants";
import { isUuid } from "./db";
import { formatTwd } from "./format";
import type { MarketProductRow, MarketStoreRow } from "./types";

export interface CartLine {
  productId: string;
  qty: number;
}

/** 跟 market_place_order 的上限一樣:每項最多 99 件、最多 50 種商品、一次最多 10 家店 */
export const CART_LIMITS = { maxQty: 99, maxLines: 50, maxStores: 10 } as const;

export const CART_STORAGE_KEY = "ifoodmap-market-cart-v1";

const clampQty = (qty: number, max: number): number => Math.max(1, Math.min(Math.floor(qty) || 1, max));

/** 這個商品最多能買幾件(庫存與 99 取小的;售完 = 0) */
export const maxQtyFor = (product: Pick<MarketProductRow, "stock">): number =>
  product.stock === null ? CART_LIMITS.maxQty : Math.max(0, Math.min(product.stock, CART_LIMITS.maxQty));

/** localStorage 讀回來的字串 → 購物車;壞掉的資料、重複的商品、超過上限的一律丟掉 */
export const parseCart = (raw: string | null): CartLine[] => {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CartLine[] = [];
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const { productId, qty } = x as Record<string, unknown>;
    if (!isUuid(productId) || out.some((l) => l.productId === productId)) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty)) continue;
    out.push({ productId, qty: clampQty(qty, CART_LIMITS.maxQty) });
    if (out.length >= CART_LIMITS.maxLines) break;
  }
  return out;
};

export const isCartFull = (lines: CartLine[], productId: string): boolean =>
  !lines.some((l) => l.productId === productId) && lines.length >= CART_LIMITS.maxLines;

/** 加入購物車:同一個商品合併數量,不超過 max(庫存);購物車滿了就原封不動(畫面先用 isCartFull 擋) */
export const addLine = (lines: CartLine[], productId: string, qty: number, max: number = CART_LIMITS.maxQty): CartLine[] => {
  const cap = Math.max(1, Math.min(max, CART_LIMITS.maxQty));
  if (lines.some((l) => l.productId === productId)) {
    return lines.map((l) => (l.productId === productId ? { ...l, qty: clampQty(l.qty + qty, cap) } : l));
  }
  if (isCartFull(lines, productId)) return lines;
  return [...lines, { productId, qty: clampQty(qty, cap) }];
};

export const setLineQty = (lines: CartLine[], productId: string, qty: number, max: number = CART_LIMITS.maxQty): CartLine[] =>
  lines.map((l) => (l.productId === productId ? { ...l, qty: clampQty(qty, Math.max(1, Math.min(max, CART_LIMITS.maxQty))) } : l));

export const removeLines = (lines: CartLine[], productIds: Iterable<string>): CartLine[] => {
  const drop = new Set(productIds);
  return lines.filter((l) => !drop.has(l.productId));
};

/** 運費:小計達免運門檻就免運,否則店家的固定運費(跟 market_place_order 一樣) */
export const shippingFeeFor = (store: Pick<MarketStoreRow, "shipping_fee" | "free_shipping_threshold">, subtotal: number): number =>
  store.free_shipping_threshold !== null && subtotal >= store.free_shipping_threshold ? 0 : store.shipping_fee;

export interface CartGroupLine {
  product: MarketProductRow;
  qty: number;
  lineTotal: number;
  /** 最多能買幾件(數量選擇器的上限) */
  maxQty: number;
  /** 超過庫存 / 已售完:這家店要先改數量才能結帳 */
  overStock: boolean;
}

export interface CartGroup {
  supplierId: string;
  store: MarketStoreRow;
  storeName: string;
  lines: CartGroupLine[];
  subtotal: number;
  shippingFee: number;
  total: number;
  /** 再買多少就免運(沒有免運門檻、已經免運 → null) */
  freeShippingRemaining: number | null;
  /** 還差多少才到最低訂購金額(已達 → 0) */
  minimumShort: number;
  /** 選了收件縣市才知道(沒選 → null) */
  deliverable: boolean | null;
  /** 不能結帳的原因(給畫面看) */
  problems: string[];
  canCheckout: boolean;
}

export interface CartView {
  groups: CartGroup[];
  /** 已下架、店家停用、找不到的商品(畫面列出來讓人刪掉) */
  unavailable: CartLine[];
}

/**
 * 購物車 + 剛查到的商品 → 按店家分組(店家照第一次加入的順序)。
 * city:結帳頁選的收件縣市;購物車頁還沒選就傳 null(不檢查配送範圍)。
 */
export const buildCart = (lines: CartLine[], products: MarketProductRow[], city: TwCity | null = null): CartView => {
  const byId = new Map(products.map((p) => [p.id, p]));
  const groups = new Map<string, CartGroup>();
  const unavailable: CartLine[] = [];

  for (const line of lines) {
    const product = byId.get(line.productId);
    const store = product?.market_stores;
    if (!product || !store || !isPubliclyVisible(product)) {
      unavailable.push(line);
      continue;
    }
    let group = groups.get(product.supplier_id);
    if (!group) {
      group = {
        supplierId: product.supplier_id,
        store,
        storeName: store.suppliers?.name ?? "店家",
        lines: [],
        subtotal: 0,
        shippingFee: 0,
        total: 0,
        freeShippingRemaining: null,
        minimumShort: 0,
        deliverable: null,
        problems: [],
        canCheckout: false,
      };
      groups.set(product.supplier_id, group);
    }
    const maxQty = maxQtyFor(product);
    group.lines.push({ product, qty: line.qty, lineTotal: product.price * line.qty, maxQty, overStock: line.qty > maxQty });
  }

  for (const g of groups.values()) {
    g.subtotal = g.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    g.shippingFee = shippingFeeFor(g.store, g.subtotal);
    g.total = g.subtotal + g.shippingFee;
    g.freeShippingRemaining =
      g.store.free_shipping_threshold !== null && g.shippingFee > 0 ? g.store.free_shipping_threshold - g.subtotal : null;
    g.minimumShort = Math.max(0, g.store.min_order_amount - g.subtotal);
    g.deliverable = city ? g.store.delivery_cities.includes(city) : null;
    if (g.lines.some((l) => l.overStock)) g.problems.push("有商品超過庫存,請減少數量或移除");
    if (g.minimumShort > 0) {
      g.problems.push(`還差 ${formatTwd(g.minimumShort)} 才到這家店的最低訂購金額 ${formatTwd(g.store.min_order_amount)}`);
    }
    if (g.deliverable === false) g.problems.push(`這家店不配送到${city}`);
    g.canCheckout = g.problems.length === 0;
  }

  return { groups: [...groups.values()], unavailable };
};

/** react-query 的 key:購物車頁與結帳頁共用同一份商品資料(結帳失敗時 invalidate ["market", "cart-products"] 重抓) */
export const cartProductsKey = (ids: string[]) => ["market", "cart-products", [...ids].sort().join(",")] as const;

/** 購物車圖示上的數字:幾件商品(數量加總) */
export const cartCount = (lines: CartLine[]): number => lines.reduce((sum, l) => sum + l.qty, 0);
