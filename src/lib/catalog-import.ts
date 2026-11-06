// 批發商品目錄的 CSV 批次匯入 / 匯出:供應商用 Excel 整理幾十、幾百個商品,存成 CSV 一次匯入。
// 規則:用「貨號」(沒有貨號就用品名)比對現有商品 —— 比到了就更新、比不到就新增;
// 儲存格空白 = 不動現有的值(所以匯入不能用來清空欄位,要清空請到商品編輯);沒有刪除,匯入不會刪商品。
import { normalizeItemName } from "@/lib/supply-images";
import { parseCsv } from "@/lib/pricing";
import { toCsv } from "@/lib/restaurant-report";

export interface CatalogRow {
  id: string;
  name: string;
  category: string | null;
  sku: string | null;
  unit: string | null;
  pack_size: string | null;
  price: number | null;
  description: string | null;
  is_available: boolean;
}

export type CatalogFields = Omit<CatalogRow, "id">;

export const MAX_ROWS = 1000;
const MAX_LEN = { name: 100, category: 30, sku: 40, unit: 20, pack_size: 40, description: 500 } as const;

export const CATALOG_HEADERS = ["商品名稱", "貨號", "分類", "單位", "規格", "定價", "說明", "上架"] as const;

export const catalogCsv = (rows: readonly CatalogRow[]): string =>
  toCsv(
    CATALOG_HEADERS,
    rows.map((r) => [r.name, r.sku ?? "", r.category ?? "", r.unit ?? "", r.pack_size ?? "", r.price ?? "", r.description ?? "", r.is_available ? "是" : "否"]),
  );

/** 範本:表頭加兩列範例,供應商照格式填 */
export const templateCsv = (): string =>
  toCsv(CATALOG_HEADERS, [
    ["高麗菜", "VEG-001", "蔬菜", "kg", "每箱 10kg", 45, "產地:雲林", "是"],
    ["雞蛋", "EGG-010", "蛋品", "箱", "每箱 10 台斤", 620, "", "是"],
  ]);

const TRUE_TEXT = new Set(["是", "y", "yes", "true", "1", "上架", "有"]);
const FALSE_TEXT = new Set(["否", "n", "no", "false", "0", "下架", "無", "没有", "沒有"]);

export interface Change { field: keyof CatalogFields; label: string; from: string; to: string }

export interface ImportPlan {
  creates: { line: number; fields: CatalogFields }[];
  updates: { line: number; id: string; name: string; patch: Partial<CatalogFields>; changes: Change[] }[];
  /** 比對到現有商品、但內容完全一樣 */
  unchanged: number;
  errors: { line: number; message: string }[];
}

const FIELD_LABEL: Readonly<Record<keyof CatalogFields, string>> = {
  name: "商品名稱", sku: "貨號", category: "分類", unit: "單位", pack_size: "規格", price: "定價", description: "說明", is_available: "上架",
};

const show = (v: unknown): string => (v === null || v === undefined || v === "" ? "(空)" : typeof v === "boolean" ? (v ? "上架" : "下架") : String(v));
const skuKey = (s: string | null) => (s ?? "").normalize("NFKC").trim().toLowerCase();

const HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  name: ["商品名稱", "商品", "品名", "名稱"],
  sku: ["貨號", "料號", "sku", "編號"],
  category: ["分類", "類別"],
  unit: ["單位"],
  pack_size: ["規格", "包裝"],
  price: ["定價", "單價", "價格"],
  description: ["說明", "備註", "描述"],
  is_available: ["上架", "上架中", "狀態"],
};

export const planImport = (text: string, existing: readonly CatalogRow[]): ImportPlan => {
  const plan: ImportPlan = { creates: [], updates: [], unchanged: 0, errors: [] };
  const table = parseCsv(text);
  if (table.length === 0) { plan.errors.push({ line: 1, message: "檔案是空的" }); return plan; }
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (key: string) => header.findIndex((h) => HEADER_ALIASES[key].some((a) => a.toLowerCase() === h));
  const idx = Object.fromEntries(Object.keys(HEADER_ALIASES).map((k) => [k, col(k)])) as Record<keyof CatalogFields, number>;
  if (idx.name < 0) { plan.errors.push({ line: 1, message: "找不到「商品名稱」欄,請用範本或匯出的檔案" }); return plan; }
  const body = table.slice(1);
  if (body.length === 0) { plan.errors.push({ line: 1, message: "檔案只有表頭,沒有商品" }); return plan; }
  if (body.length > MAX_ROWS) { plan.errors.push({ line: 1, message: `一次最多匯入 ${MAX_ROWS} 列,這個檔案有 ${body.length} 列,請分成幾個檔案` }); return plan; }

  const bySku = new Map<string, CatalogRow>();
  const byName = new Map<string, CatalogRow[]>();
  existing.forEach((e) => {
    const sk = skuKey(e.sku);
    if (sk && !bySku.has(sk)) bySku.set(sk, e);
    const nk = normalizeItemName(e.name);
    byName.set(nk, [...(byName.get(nk) ?? []), e]);
  });

  const usedIds = new Set<string>();
  const usedNew = new Set<string>();

  body.forEach((r, i) => {
    const line = i + 2;
    const cell = (k: keyof CatalogFields): string | undefined => {
      if (idx[k] < 0) return undefined;
      const v = (r[idx[k]] ?? "").trim();
      return v === "" ? undefined : v;
    };
    const name = cell("name");
    if (!name) { plan.errors.push({ line, message: "商品名稱是空的" }); return; }
    const fail = (message: string) => plan.errors.push({ line, message: `「${name}」${message}` });

    const text: Partial<Record<"name" | "sku" | "category" | "unit" | "pack_size" | "description", string>> = { name };
    for (const k of ["sku", "category", "unit", "pack_size", "description"] as const) {
      const v = cell(k);
      if (v !== undefined) text[k] = v;
    }
    for (const k of Object.keys(text) as (keyof typeof text)[]) {
      if ((text[k] as string).length > MAX_LEN[k]) { fail(`的${FIELD_LABEL[k]}太長(最多 ${MAX_LEN[k]} 個字)`); return; }
    }

    let price: number | undefined;
    const priceText = cell("price");
    if (priceText !== undefined) {
      const n = Number(priceText.replace(/^NT\$?\s*|^\$\s*/i, "").replace(/,/g, ""));
      if (!Number.isFinite(n) || n <= 0) { fail("的定價要是大於 0 的數字"); return; }
      price = Math.round(n * 100) / 100;
      if (price >= 1e10) { fail("的定價太大"); return; }
    }

    let available: boolean | undefined;
    const availText = cell("is_available");
    if (availText !== undefined) {
      const k = availText.toLowerCase();
      if (TRUE_TEXT.has(k)) available = true;
      else if (FALSE_TEXT.has(k)) available = false;
      else { fail("的「上架」要寫「是」或「否」"); return; }
    }

    // 比對現有商品:貨號優先;沒貨號(或貨號對不到)再用品名
    const sk = skuKey(text.sku ?? null);
    const nk = normalizeItemName(name);
    let target: CatalogRow | undefined;
    if (sk && bySku.has(sk)) target = bySku.get(sk);
    else {
      const sameName = byName.get(nk) ?? [];
      // 有填貨號而現有同名商品已有不同貨號 = 不同規格的商品,另外新增
      const candidates = sk ? sameName.filter((e) => !skuKey(e.sku)) : sameName;
      if (candidates.length > 1) { fail(`在目錄裡有 ${candidates.length} 個同名商品,請填貨號指定要更新哪一個`); return; }
      target = candidates[0];
    }

    if (target) {
      if (usedIds.has(target.id)) { fail("重複出現(同一個商品只能一列)"); return; }
      usedIds.add(target.id);
      const next: Partial<CatalogFields> = {};
      if (text.name !== target.name) next.name = text.name;
      for (const k of ["sku", "category", "unit", "pack_size", "description"] as const) {
        if (text[k] === undefined || text[k] === (target[k] ?? "")) continue;
        if (k === "sku" && skuKey(text[k]) === skuKey(target.sku)) continue; // 貨號只差大小寫 = 同一個,不算變動
        next[k] = text[k];
      }
      if (price !== undefined && price !== target.price) next.price = price;
      if (available !== undefined && available !== target.is_available) next.is_available = available;
      const keys = Object.keys(next) as (keyof CatalogFields)[];
      if (keys.length === 0) { plan.unchanged += 1; return; }
      plan.updates.push({
        line,
        id: target.id,
        name: target.name,
        patch: next,
        changes: keys.map((k) => ({ field: k, label: FIELD_LABEL[k], from: show(target[k]), to: show(next[k]) })),
      });
      return;
    }

    const newKey = sk ? `sku:${sk}` : `name:${nk}`;
    if (usedNew.has(newKey)) { fail("重複出現(同一個商品只能一列)"); return; }
    usedNew.add(newKey);
    plan.creates.push({
      line,
      fields: {
        name,
        sku: text.sku ?? null,
        category: text.category ?? null,
        unit: text.unit ?? null,
        pack_size: text.pack_size ?? null,
        price: price ?? null,
        description: text.description ?? null,
        is_available: available ?? true,
      },
    });
  });
  return plan;
};
