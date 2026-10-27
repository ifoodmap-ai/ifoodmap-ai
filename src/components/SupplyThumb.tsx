import { useState } from "react";
import { supplyImageUrl } from "@/lib/supply-images";

interface SupplyThumbProps {
  /** supplies.image_path;沒有就顯示佔位 */
  path: string | null | undefined;
  /** 佔位用的品名(取第一個字)與圖片的替代文字 */
  name: string;
  /** 邊長(px),預設 40 */
  size?: number;
  className?: string;
}

/** 商品小縮圖:有圖顯示 480px 縮圖(lazy),沒有圖或載入失敗顯示品名第一個字的佔位,版面不會跳動 */
const SupplyThumb = ({ path, name, size = 40, className = "" }: SupplyThumbProps) => {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : supplyImageUrl(path, true);
  const box = { width: size, height: size };

  if (!url) {
    return (
      <span
        aria-hidden="true"
        style={box}
        className={`inline-flex shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400 text-sm font-medium select-none ${className}`}
      >
        {Array.from(name.trim())[0] ?? "·"}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      style={box}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md object-cover bg-slate-100 ${className}`}
    />
  );
};

export default SupplyThumb;
