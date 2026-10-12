// 供應商自家的零售商品(全部狀態)與店家是否已建立 —— 商品目錄頁兩個分頁共用。
//
// 讀取失敗時 error 有值:畫面只顯示原因與「重新載入」(retry),不能拿舊的或空的資料編輯 ——
// 空的清單會讓「開放零售」再建一筆重複的零售商品,舊的資料會在下次儲存時蓋掉剛存的修改。
// 存檔成功後先用 applySaved 換上資料庫回傳的那一筆,再背景重抓;重抓的回應比後來送出的那次晚到就丟掉(seq)。
// storeOpen:店家對消費者開著嗎 —— 同 market_store_is_open(migration 20261012110000):零售啟用、供應商帳號啟用,
// 而且四項法定資訊(登記名稱、負責人、營業所地址、客服 Email)與供應商電話都有。storeClosedReason 說明為什麼關著,狀態文字照這個寫。
import { useCallback, useEffect, useRef, useState } from "react";
import { marketDb, unwrap, friendlyDbError } from "@/lib/market/db";
import { hasVisibleText } from "@/lib/market/productForm";
import type { MarketProductRow } from "@/lib/market/types";

/** 店家對消費者關著的原因:disabled = 零售或供應商帳號被停用;disclosure = 法定資訊或供應商電話沒填齊 */
export type StoreClosedReason = "disabled" | "disclosure";

export interface SupplierMarketProducts {
  products: MarketProductRow[];
  hasStore: boolean;
  /** 店家零售啟用中、供應商帳號也啟用中、法定資訊與電話都有(消費者看得到這家店);沒有店家時是 false */
  storeOpen: boolean;
  /** 關著的原因(停用優先);開著或沒有店家時是 null */
  storeClosedReason: StoreClosedReason | null;
  loading: boolean;
  error: string | null;
  /** 背景重抓(畫面維持目前的資料;失敗才換成 error) */
  reload: () => Promise<void>;
  /** 讀取失敗後的「重新載入」:先回到讀取中,成功才顯示資料 */
  retry: () => void;
  /** 存檔成功:資料庫回傳的那一筆立刻放到清單最前面(跟重抓的 updated_at 新到舊一致) */
  applySaved: (row: MarketProductRow) => void;
}

type StoreState = {
  supplier_id: string;
  is_enabled?: boolean;
  legal_name?: string | null;
  representative?: string | null;
  business_address?: string | null;
  service_email?: string | null;
  suppliers?: { is_active?: boolean | null; phone?: string | null } | null;
};

const STORE_STATE_COLUMNS = "supplier_id, is_enabled, legal_name, representative, business_address, service_email, suppliers(is_active, phone)";

/** 讀到了但看不到字(null、空白、零寬字元);沒讀到的欄位(undefined)不算缺 —— 同「只有明確是 false 才算停用」 */
const blank = (v: string | null | undefined) => v !== undefined && !hasVisibleText((v ?? "").trim());

const closedReasonOf = (store: StoreState | null): StoreClosedReason | null => {
  if (!store) return null;
  if (store.is_enabled === false || store.suppliers?.is_active === false) return "disabled";
  const required = [store.legal_name, store.representative, store.business_address, store.service_email, store.suppliers?.phone];
  return required.some(blank) ? "disclosure" : null;
};

export const useSupplierMarketProducts = (supplierId: string | null): SupplierMarketProducts => {
  const [products, setProducts] = useState<MarketProductRow[]>([]);
  const [hasStore, setHasStore] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [storeClosedReason, setStoreClosedReason] = useState<StoreClosedReason | null>(null);
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
        marketDb<StoreState>("market_stores").select(STORE_STATE_COLUMNS).eq("supplier_id", supplierId).maybeSingle().then(unwrap),
      ]);
      if (mine !== seq.current) return;
      setProducts(rows ?? []);
      setHasStore(!!store);
      // 沒讀到欄位時不說停用(只有明確是 false 才算停用);法定資訊同樣只有讀到而且看不到字才算缺
      const reason = closedReasonOf(store);
      setStoreOpen(!!store && reason === null);
      setStoreClosedReason(reason);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(friendlyDbError(e, "請稍後再試"));
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

  return { products, hasStore, storeOpen, storeClosedReason, loading, error, reload, retry, applySaved };
};
