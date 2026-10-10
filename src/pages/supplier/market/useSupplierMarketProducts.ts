// 供應商自家的零售商品(全部狀態)與店家是否已建立 —— 商品目錄頁兩個分頁共用。
import { useCallback, useEffect, useState } from "react";
import { marketDb, unwrap, friendlyDbError } from "@/lib/market/db";
import type { MarketProductRow } from "@/lib/market/types";

export interface SupplierMarketProducts {
  products: MarketProductRow[];
  hasStore: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const useSupplierMarketProducts = (supplierId: string | null): SupplierMarketProducts => {
  const [products, setProducts] = useState<MarketProductRow[]>([]);
  const [hasStore, setHasStore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!supplierId) return;
    try {
      const [rows, store] = await Promise.all([
        marketDb<MarketProductRow[]>("market_products")
          .select("*")
          .eq("supplier_id", supplierId)
          .order("updated_at", { ascending: false })
          .then(unwrap),
        marketDb<{ supplier_id: string }>("market_stores").select("supplier_id").eq("supplier_id", supplierId).maybeSingle().then(unwrap),
      ]);
      setProducts(rows ?? []);
      setHasStore(!!store);
      setError(null);
    } catch (e) {
      setError(friendlyDbError(e));
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { products, hasStore, loading, error, reload };
};
