// images.ts:格式與大小檢查、縮放計算、路徑、公開網址、壓縮重試、上傳(壓縮與 Storage 都用假的;jsdom 沒有 canvas)。
import { describe, expect, it, vi } from "vitest";

// images.ts 會 import db.ts → 真的 supabase client;換成空殼,不讓 GoTrue 在測試裡啟動(Node 25 的 localStorage 是空殼)
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  compressForUpload,
  fitWithin,
  imagePath,
  MarketImageError,
  publicImageUrl,
  thumbPathOf,
  uploadMarketImage,
  validateImageFile,
  type UploadDeps,
} from "./images";

const SUP = "a9200000-0000-4000-8000-00000000000a";
const PROD = "a9300000-0000-4000-8000-000000000001";
const IMG = "a9900000-0000-4000-8000-000000000001";

describe("validateImageFile", () => {
  it("只收 JPG / PNG / WebP", () => {
    expect(validateImageFile({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/webp", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/gif", size: 1000 })).toBe("只收 JPG、PNG、WebP 照片");
    expect(validateImageFile({ type: "image/heic", size: 1000 })).toBe("只收 JPG、PNG、WebP 照片");
  });

  it("原始檔 15 MB 以內(上傳前會壓縮,所以手機照片 3–8 MB 可以)", () => {
    expect(validateImageFile({ type: "image/jpeg", size: 8 * 1024 * 1024 })).toBeNull();
    expect(validateImageFile({ type: "image/jpeg", size: 15 * 1024 * 1024 + 1 })).toBe("照片太大了(原始檔請小於 15 MB)");
  });
});

describe("fitWithin", () => {
  it("長邊縮到 1600,等比例", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("小圖不放大", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("路徑與網址", () => {
  it("主圖與縮圖路徑", () => {
    expect(imagePath(SUP, PROD, IMG)).toBe(`${SUP}/${PROD}/${IMG}.jpg`);
    expect(imagePath(SUP, "store", IMG, true)).toBe(`${SUP}/store/${IMG}_t.jpg`);
    expect(thumbPathOf(`${SUP}/${PROD}/${IMG}.jpg`)).toBe(`${SUP}/${PROD}/${IMG}_t.jpg`);
    expect(thumbPathOf(`${SUP}/store/${IMG}.webp`)).toBe(`${SUP}/store/${IMG}_t.jpg`);
  });

  it("公開網址走 /storage/v1/object/public/market-images/", () => {
    expect(publicImageUrl(`${SUP}/store/${IMG}.jpg`, "https://x.supabase.co/")).toBe(
      `https://x.supabase.co/storage/v1/object/public/market-images/${SUP}/store/${IMG}.jpg`,
    );
  });
});

describe("compressForUpload", () => {
  const fakeBlob = (size: number) => ({ size }) as Blob;

  it("第一次就小於 2 MB 就用它", async () => {
    const compress = vi.fn().mockResolvedValue(fakeBlob(300_000));
    await expect(compressForUpload(fakeBlob(5_000_000), compress)).resolves.toEqual(fakeBlob(300_000));
    expect(compress).toHaveBeenCalledWith(expect.anything(), 1600, 0.82);
  });

  it("太大就降品質重壓;三次都太大就丟錯", async () => {
    const compress = vi
      .fn()
      .mockResolvedValueOnce(fakeBlob(3_000_000))
      .mockResolvedValueOnce(fakeBlob(1_900_000));
    await expect(compressForUpload(fakeBlob(9_000_000), compress)).resolves.toEqual(fakeBlob(1_900_000));
    expect(compress.mock.calls.map((c) => c[2])).toEqual([0.82, 0.7]);

    const tooBig = vi.fn().mockResolvedValue(fakeBlob(2_500_000));
    await expect(compressForUpload(fakeBlob(9_000_000), tooBig)).rejects.toThrow("照片壓縮後還是超過 2 MB");
  });
});

describe("uploadMarketImage", () => {
  const deps = (uploadError: string | null = null) => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: uploadError ? { message: uploadError } : null });
    const d: UploadDeps = {
      compressMain: vi.fn().mockResolvedValue(new Blob(["main"])),
      compressThumb: vi.fn().mockResolvedValue(new Blob(["thumb"])),
      storage: () => ({ upload }),
      newId: () => IMG,
    };
    return { d, upload };
  };
  const file = (type = "image/png") => new File(["x"], "photo.png", { type });

  it("上傳主圖與縮圖,回傳主圖路徑", async () => {
    const { d, upload } = deps();
    await expect(uploadMarketImage(SUP, PROD, file(), d)).resolves.toBe(`${SUP}/${PROD}/${IMG}.jpg`);
    expect(upload.mock.calls.map((c) => c[0])).toEqual([`${SUP}/${PROD}/${IMG}.jpg`, `${SUP}/${PROD}/${IMG}_t.jpg`]);
    expect(upload.mock.calls[0][2]).toEqual({ contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  });

  it("格式不對在壓縮前就擋下", async () => {
    const { d, upload } = deps();
    await expect(uploadMarketImage(SUP, PROD, file("image/gif"), d)).rejects.toBeInstanceOf(MarketImageError);
    expect(d.compressMain).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("Storage 回錯就丟出看得懂的錯", async () => {
    const { d } = deps("new row violates row-level security policy");
    await expect(uploadMarketImage(SUP, PROD, file(), d)).rejects.toThrow("上傳失敗:new row violates row-level security policy");
  });
});
