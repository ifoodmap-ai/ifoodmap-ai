// 供應商自家的零售商品(全部狀態)與店家是否已建立 —— 商品目錄頁兩個分頁共用。
//
// 讀取失敗時 error 有值:畫面只顯示原因與「重新載入」(retry),不能拿舊的或空的資料編輯 ——
// 空的清單會讓「開放零售」再建一筆重複的零售商品,舊的資料會在下次儲存時蓋掉剛存的修改。
// 存檔成功後先用 applySaved 換上資料庫回傳的那一筆,再背景重抓;重抓的回應比後來送出的那次晚到就丟掉(seq)。
import { useCallback, useEffect, useRef, useState } from "react";
import { marketDb, unwrap, friendlyDbError } from "@/lib/market/db";
import type { MarketProductRow } from "@/lib/market/types";

export interface SupplierMarketProducts {
  products: MarketProductRow[];
  hasStore: boolean;
  loading: boolean;
  error: string | null;
  /** 背景重抓(畫面維持目前的資料;失敗才換成 error) */
  reload: () => Promise<void>;
  /** 讀取失敗後的「重新載入」:先回到讀取中,成功才顯示資料 */
  retry: () => void;
  /** 存檔成功:資料庫回傳的那一筆立刻放到清單最前面(跟重抓的 updated_at 新到舊一致) */
  applySaved: (row: MarketProductRow) => void;
}

export const useSupplierMarketProducts = (supplierId: string | null): SupplierMarketProducts => {
  const [products, setProducts] = useState<MarketProductRow[]>([]);
  const [hasStore, setHasStore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 每次重抓加 1;回應回來時不是最新的那次就丟掉 */
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!supplierId) return;
    const mine = ++seq.current;
    try {
      const [rows, store] = await Promise.all([
        marketDb<MarketProductRow[]>("market_products")
          .select("*")
          .eq("supplier_id", supplierId)
          .order("updated_at", { ascending: false })
          .then(unwrap),
        marketDb<{ supplier_id: string }>("market_stores").select("supplier_id").eq("supplier_id", supplierId).maybeSingle().then(unwrap),
      ]);
      if (mine !== seq.current) return;
      setProducts(rows ?? []);
      setHasStore(!!store);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(friendlyDbError(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [supplierId]);

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    void reload();
  }, [reload]);

  const applySaved = useCallback((row: MarketProductRow) => {
    setProducts((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { products, hasStore, loading, error, reload, retry, applySaved };
};
