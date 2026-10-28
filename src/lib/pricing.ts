// 客戶專屬價格與數量上限(supabase/migrations/20261029110000_customer_prices_and_limits.sql)的前端共用邏輯:
// 叫貨品項(只有品名)配對供應商的商品目錄、算單價與預估金額、數量上限提示、價格表 CSV 匯出入。
// 價格只是「下單時自動帶入、供應商報價時預填」,不是報價本身;數量上限由資料庫在叫貨時檢查,這裡只是提前提示。
import { normalizeItemName } from "@/lib/supply-images";
import { toCsv } from "@/lib/restaurant-report";

export interface CatalogItem {
  id: string;
  name: string;
  sku?: string | null;
  unit?: string | null;
  /** 商品定價 */
  price: number | null;
}

export type LimitPeriod = "day" | "week";

export interface CustomerLimit {
  supply_id: string;
  period: LimitPeriod;
  max_qty: number;
}

export const PERIOD_LABEL: Readonly<Record<LimitPeriod, string>> = { day: "每日", week: "每週" };

/** 數量:只收純數字(「3箱」「好多」不算) */
export const parseQty = (q: string | number | null | undefined): number | null => {
  const s = String(q ?? "").trim();
  return /^\d+(\.\d+)?$/.test(s) ? Number.parseFloat(s) : null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 品名(正規化後)對商品目錄;同名的商品取第一個 */
export const matchCatalog = (name: string, catalog: readonly CatalogItem[]): CatalogItem | null => {
  const key = normalizeItemName(name);
  if (!key) return null;
  return catalog.find((c) => normalizeItemName(c.name) === key) ?? null;
};

export interface PricedItem {
  /** 配對到的商品 */
  supply: CatalogItem | null;
  /** 這家客戶實際的單價:有專屬價 / 群組價用該價格,沒有就用商品定價;都沒有是 null */
  unitPrice: number | null;
  source: "customer" | "list" | null;
}

/**
 * 這家客戶實際適用的價格表:群組價打底,客戶專屬價蓋過去(專屬價 > 群組價 > 商品定價,定價由 priceOf 補)。
 * 兩個參數都是 supply_id → 價格。
 */
export const effectivePrices = (
  groupPrices: ReadonlyMap<string, number>,
  customerPrices: ReadonlyMap<string, number>,
): Map<string, number> => new Map([...groupPrices, ...customerPrices]);

/** customerPrices:supply_id → 這家客戶適用的價格(專屬價或群組價,見 effectivePrices) */
export const priceOf = (
  name: string,
  catalog: readonly CatalogItem[],
  customerPrices: ReadonlyMap<string, number>,
): PricedItem => {
  const supply = matchCatalog(name, catalog);
  if (!supply) return { supply: null, unitPrice: null, source: null };
  const special = customerPrices.get(supply.id);
  if (special != null) return { supply, unitPrice: special, source: "customer" };
  if (supply.price != null && supply.price > 0) return { supply, unitPrice: supply.price, source: "list" };
  return { supply, unitPrice: null, source: null };
};

export interface EstimateLine { name: string; quantity: string | number }

/**
 * 預估金額:每個「有單價、數量是純數字」的品項 單價 × 數量 加總。
 * unpriced = 算不出來的品項數(沒有單價、或數量不是純數字),畫面上要說「不含 N 項」。
 */
export const estimateTotal = (
  lines: readonly EstimateLine[],
  catalog: readonly CatalogItem[],
  customerPrices: ReadonlyMap<string, number>,
): { total: number; priced: number; unpriced: number } => {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  lines.forEach((l) => {
    const p = priceOf(l.name, catalog, customerPrices);
    const q = parseQty(l.quantity);
    if (p.unitPrice == null || q == null) {
      unpriced += 1;
      return;
    }
    total += p.unitPrice * q;
    priced += 1;
  });
  return { total: round2(total), priced, unpriced };
};

/** 供應商報價時預填的金額:每個品項都算得出來才給(只算一部分會讓人誤以為是完整金額);否則回 null */
export const suggestQuote = (
  lines: readonly EstimateLine[],
  catalog: readonly CatalogItem[],
  customerPrices: ReadonlyMap<string, number>,
): number | null => {
  if (lines.length === 0) return null;
  const e = estimateTotal(lines, catalog, customerPrices);
  return e.unpriced === 0 && e.total > 0 ? e.total : null;
};

/** 這家客戶對這個品項的數量上限(沒有商品配對、沒設上限回 null) */
export const limitOf = (
  name: string,
  catalog: readonly CatalogItem[],
  limits: readonly CustomerLimit[],
): { supply: CatalogItem; limit: CustomerLimit } | null => {
  const supply = matchCatalog(name, catalog);
  const limit = supply ? limits.find((l) => l.supply_id === supply.id) : undefined;
  return supply && limit ? { supply, limit } : null;
};

export const limitText = (l: Pick<CustomerLimit, "period" | "max_qty">, unit?: string | null): string =>
  `${PERIOD_LABEL[l.period]}上限 ${Number(l.max_qty)}${unit ?? ""}`;

/* ------------------------------ 價格表 CSV(Excel 可開) ------------------------------ */

export interface PriceSheetRow {
  supply: CatalogItem;
  /** 客戶專屬價(沒設是 null) */
  price: number | null;
  limit: { period: LimitPeriod; max_qty: number } | null;
}

export const SHEET_HEADERS = ["商品", "貨號", "單位", "定價", "客戶價", "數量上限", "上限期別"] as const;

export const sheetCsv = (rows: readonly PriceSheetRow[]): string =>
  toCsv(
    SHEET_HEADERS,
    rows.map((r) => [
      r.supply.name,
      r.supply.sku ?? "",
      r.supply.unit ?? "",
      r.supply.price ?? "",
      r.price ?? "",
      r.limit?.max_qty ?? "",
      r.limit ? PERIOD_LABEL[r.limit.period] : "",
    ]),
  );

/** 一般 CSV 解析:支援引號、引號裡的逗號與換行、"" 跳脫、BOM、CRLF */
export const parseCsv = (text: string): string[][] => {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
};

export interface SheetImportResult {
  /** 比對到商品、要套用的列 */
  rows: { supplyId: string; name: string; price: number | null; limit: { period: LimitPeriod; max_qty: number } | null }[];
  /** 看不懂或對不上的列(列號從 2 開始,第 1 列是表頭)與原因 */
  errors: { line: number; message: string }[];
}

const PERIOD_FROM_TEXT: Readonly<Record<string, LimitPeriod>> = { 每日: "day", 每天: "day", day: "day", 每週: "week", 每周: "week", week: "week" };

/**
 * 匯入價格表:用「商品」欄的品名比對目錄(跟匯出的檔案同一個格式,也可以只留需要的欄位)。
 * 客戶價空白 = 沒有專屬價(照定價);數量上限空白 = 沒有上限;有上限就要有期別(沒寫預設每日)。
 */
export const importSheet = (text: string, catalog: readonly CatalogItem[]): SheetImportResult => {
  const table = parseCsv(text);
  const result: SheetImportResult = { rows: [], errors: [] };
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: "檔案是空的" }] };
  const header = table[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const cName = col("商品");
  const cPrice = col("客戶價");
  const cMax = col("數量上限");
  const cPeriod = col("上限期別");
  if (cName < 0) return { rows: [], errors: [{ line: 1, message: "找不到「商品」欄,請用匯出的檔案當範本" }] };
  if (cPrice < 0 && cMax < 0) return { rows: [], errors: [{ line: 1, message: "找不到「客戶價」或「數量上限」欄,請用匯出的檔案當範本" }] };

  const seen = new Set<string>();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = (r[cName] ?? "").trim();
    if (!name) return;
    const supply = matchCatalog(name, catalog);
    if (!supply) { result.errors.push({ line, message: `「${name}」不在你的商品目錄裡` }); return; }
    if (seen.has(supply.id)) { result.errors.push({ line, message: `「${name}」重複出現,只能一列` }); return; }

    let price: number | null = null;
    if (cPrice >= 0 && (r[cPrice] ?? "").trim() !== "") {
      const n = Number((r[cPrice] ?? "").trim().replace(/^NT\$?\s*/i, "").replace(/,/g, ""));
      if (!Number.isFinite(n) || n <= 0) { result.errors.push({ line, message: `「${name}」的客戶價要是大於 0 的數字` }); return; }
      price = round2(n);
    }

    let limit: { period: LimitPeriod; max_qty: number } | null = null;
    if (cMax >= 0 && (r[cMax] ?? "").trim() !== "") {
      const n = Number((r[cMax] ?? "").trim().replace(/,/g, ""));
      if (!Number.isFinite(n) || n <= 0) { result.errors.push({ line, message: `「${name}」的數量上限要是大於 0 的數字` }); return; }
      const periodText = cPeriod >= 0 ? (r[cPeriod] ?? "").trim() : "";
      const period = periodText === "" ? "day" : PERIOD_FROM_TEXT[periodText.toLowerCase()];
      if (!period) { result.errors.push({ line, message: `「${name}」的上限期別要寫「每日」或「每週」` }); return; }
      limit = { period, max_qty: round2(n) };
    }
    seen.add(supply.id);
    result.rows.push({ supplyId: supply.id, name: supply.name, price, limit });
  });
  return result;
};
