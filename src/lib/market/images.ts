// 市集圖片:檢查、在瀏覽器壓縮、上傳到 Storage bucket market-images、組公開網址。
//
// - 只收 JPG / PNG / WebP 原始檔(≤ 15 MB);壓成長邊 1600px 的 JPEG(品質 0.82,超過 2 MB 再降到 0.7、0.6),
//   另存一張 480px 縮圖(<uuid>_t.jpg,列表用)。壓縮寫法沿用 src/components/restaurant/ReceiveOrderDialog.tsx 的
//   fileToCompressedDataUrl,但存成檔案(Blob)不存 base64,而且先鋪白底(PNG 透明處才不會變黑)。
// - bucket 本身也限制 2 MB 與三種格式(migration 20261009120100),前端繞不過。
// - 路徑 <supplier_id>/<商品 id 或 store>/<uuid>.jpg —— storage.objects 的 policy 只讓該供應商寫自己的資料夾。
// - 換照片時「不刪」舊檔:舊檔可能還被已儲存的商品引用;孤兒檔無害(公開 bucket 但網址是猜不到的 uuid)。
import { MARKET_IMAGE_BUCKET, PHOTO_RULES } from "./constants";
import { marketStorage, newUuid, type StorageBucket } from "./db";

export class MarketImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketImageError";
  }
}

export const validateImageFile = (file: { type: string; size: number }): string | null => {
  if (!(PHOTO_RULES.inputTypes as readonly string[]).includes(file.type)) return "只收 JPG、PNG、WebP 照片";
  if (file.size > PHOTO_RULES.maxInputBytes) return "照片太大了(原始檔請小於 15 MB)";
  return null;
};

/** 等比縮到長邊不超過 max(小圖不放大) */
export const fitWithin = (width: number, height: number, max: number): { width: number; height: number } => {
  const scale = Math.min(1, max / Math.max(width, height) || 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export const imagePath = (supplierId: string, folder: string, id: string, thumb = false): string =>
  `${supplierId}/${folder}/${id}${thumb ? "_t" : ""}.jpg`;

/** 主圖路徑 → 縮圖路徑(a/b/c.jpg → a/b/c_t.jpg) */
export const thumbPathOf = (path: string): string => path.replace(/\.(jpg|jpeg|png|webp)$/i, "_t.jpg");

/** Storage 公開網址(public bucket,不經過 RLS) */
export const publicImageUrl = (path: string, base: string = import.meta.env.VITE_SUPABASE_URL as string): string =>
  `${String(base).replace(/\/+$/, "")}/storage/v1/object/public/${MARKET_IMAGE_BUCKET}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/** 讀圖 → 長邊縮到 maxSide → 白底 JPEG。瀏覽器解不開就丟錯(不上傳看不懂的檔案) */
export const compressToJpeg = (file: Blob, maxSide: number, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new MarketImageError("這張照片無法讀取,請換一張"));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { width, height } = fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height, maxSide);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new MarketImageError("這個瀏覽器無法處理照片"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new MarketImageError("照片壓縮失敗,請換一張"))),
        "image/jpeg",
        quality,
      );
    };
    img.src = url;
  });

/** 壓到 ≤ 2 MB:品質 0.82 → 0.7 → 0.6,還是太大就丟錯 */
export const compressForUpload = async (file: Blob, compress = compressToJpeg): Promise<Blob> => {
  for (const quality of [0.82, 0.7, 0.6]) {
    const blob = await compress(file, PHOTO_RULES.longSide, quality);
    if (blob.size <= PHOTO_RULES.maxBytes) return blob;
  }
  throw new MarketImageError("照片壓縮後還是超過 2 MB,請換一張");
};

export interface UploadDeps {
  compressMain: (file: Blob) => Promise<Blob>;
  compressThumb: (file: Blob) => Promise<Blob>;
  storage: () => StorageBucket;
  newId: () => string;
}

const defaultDeps: UploadDeps = {
  compressMain: (f) => compressForUpload(f),
  compressThumb: (f) => compressToJpeg(f, PHOTO_RULES.thumbLongSide, 0.8),
  storage: marketStorage,
  newId: newUuid,
};

/** 上傳一張照片(主圖 + 縮圖)到 <supplierId>/<folder>/<uuid>.jpg,回傳主圖路徑(存進資料表的就是這個) */
export const uploadMarketImage = async (
  supplierId: string,
  folder: string,
  file: File,
  deps: UploadDeps = defaultDeps,
): Promise<string> => {
  const problem = validateImageFile(file);
  if (problem) throw new MarketImageError(problem);
  const main = await deps.compressMain(file);
  const thumb = await deps.compressThumb(file);
  const id = deps.newId();
  const options = { contentType: "image/jpeg", cacheControl: "31536000", upsert: false };
  const bucket = deps.storage();
  const mainPath = imagePath(supplierId, folder, id);
  const up = await bucket.upload(mainPath, main, options);
  if (up.error) throw new MarketImageError(`上傳失敗:${up.error.message}`);
  const upThumb = await bucket.upload(imagePath(supplierId, folder, id, true), thumb, options);
  if (upThumb.error) throw new MarketImageError(`縮圖上傳失敗:${upThumb.error.message}`);
  return mainPath;
};
