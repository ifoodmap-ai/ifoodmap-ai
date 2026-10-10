// 商品 / 店家照片:列表用縮圖(_t.jpg),縮圖壞了退回主圖;沒有照片、或主圖也壞了就顯示分類圖示。
// 一律 width/height(避免版面跳動)、loading="lazy"、decoding="async"。
import { useEffect, useState } from "react";
import { CATEGORY_ICON } from "@/lib/market/categoryIcons";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { publicImageUrl, thumbPathOf } from "@/lib/market/images";

interface MarketImageProps {
  path: string | null | undefined;
  category: MarketCategoryKey;
  alt: string;
  variant?: "thumb" | "full";
  className?: string;
  width?: number;
  height?: number;
  eager?: boolean;
}

export default function MarketImage({
  path,
  category,
  alt,
  variant = "thumb",
  className = "",
  width = 480,
  height = 480,
  eager = false,
}: MarketImageProps) {
  const sources = path ? (variant === "thumb" ? [publicImageUrl(thumbPathOf(path)), publicImageUrl(path)] : [publicImageUrl(path)]) : [];
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [path, variant]);
  const src = sources[index];
  const loading = eager ? "eager" : "lazy";

  if (!src) {
    // 圖示外面包一層:留白用「圖示 = 外框的 76%」做,不能用 p-[12%] —— 百分比 padding 是照「父元素」寬度算的,
    // 64px 的圖放在整列寬的清單裡(購物車、審核清單)時 padding 會比圖還大,圖示整個不見(2026-10-09 實測)。
    return (
      <span className={`${className} flex items-center justify-center bg-emerald-50`}>
        <img
          src={CATEGORY_ICON[category]}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          decoding="async"
          data-fallback="category"
          className="h-[76%] w-[76%] object-contain"
        />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      decoding="async"
      onError={() => setIndex((i) => i + 1)}
      className={`${className} bg-slate-100 object-cover`}
    />
  );
}
