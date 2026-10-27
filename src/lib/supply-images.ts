// 批發商品(supplies)的圖片:路徑存在 supplies.image_path,檔案放在 Storage bucket market-images,
// 規則與上傳流程跟零售商品照片同一套(src/lib/market/images.ts)。縮圖是主圖旁邊的 <uuid>_t.jpg(480px)。
import { publicImageUrl, thumbPathOf, uploadMarketImage } from "@/lib/market/images";

/** 商品圖片的公開網址;thumb = true 給列表 / 小縮圖用。沒有圖片回 null */
export const supplyImageUrl = (path: string | null | undefined, thumb = false): string | null =>
  path ? publicImageUrl(thumb ? thumbPathOf(path) : path) : null;

/** 上傳一張商品圖片(主圖 + 縮圖),回傳要存進 supplies.image_path 的路徑 */
export const uploadSupplyImage = (supplierId: string, supplyId: string, file: File): Promise<string> =>
  uploadMarketImage(supplierId, supplyId, file);

/** 品名比對用:全形半形、大小寫、空白都不影響(「高麗菜 」「高麗菜」「ＡＢ」「ab」視為同一個) */
export const normalizeItemName = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export interface SupplyImageRow {
  supplier_id: string;
  name: string;
  image_path: string | null;
}

export type SupplyImageLookup = (name: string, supplierId?: string | null) => string | null;

/**
 * 叫貨品項(只有品名)配對供應商商品圖片:先找「同一家供應商的同名商品」,找不到再找任何一家同名商品。
 * 品名不同就配不到,顯示預設佔位 —— 寧可沒圖,不要配錯圖。
 */
export const buildSupplyImageLookup = (rows: readonly SupplyImageRow[]): SupplyImageLookup => {
  const bySupplier = new Map<string, string>();
  const byName = new Map<string, string>();
  rows.forEach((r) => {
    if (!r.image_path) return;
    const key = normalizeItemName(r.name);
    if (!key) return;
    bySupplier.set(`${r.supplier_id}|${key}`, r.image_path);
    if (!byName.has(key)) byName.set(key, r.image_path);
  });
  return (name, supplierId) => {
    const key = normalizeItemName(name);
    if (!key) return null;
    return (supplierId ? bySupplier.get(`${supplierId}|${key}`) : undefined) ?? byName.get(key) ?? null;
  };
};
