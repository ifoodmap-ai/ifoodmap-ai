// 目前登入者所屬的供應商 id(供應商後台的零售市集頁共用)。
// 跟 SupplierCatalogPage / SupplierOrdersPage 原本各寫一份的查法一樣:supplier_accounts 啟用中的那一列。
// 頁面外層已經有 SupplierRoute 擋未登入與沒有供應商帳號的人;這裡查不到就回 error,讓頁面顯示原因。
// 錯誤一律走 db.ts 的中文轉換(斷網、PostgREST 的英文訊息不直接顯示),reload() 給頁面的「重新載入」用。
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { friendlyDbError, MarketDbError } from "@/lib/market/db";

export interface CurrentSupplier {
  supplierId: string | null;
  loading: boolean;
  error: string | null;
  /** 重新查一次(讀取失敗時的「重新載入」) */
  reload: () => void;
}

type SupplierLookup = Omit<CurrentSupplier, "reload">;
type AccountQuery = PromiseLike<{
  data: { supplier_id: string } | null;
  error: { message: string; code?: string | null; hint?: string | null; details?: string | null } | null;
}>;

/** 認不得的錯誤顯示這句(資料庫錯誤會附上錯誤代碼),不顯示英文原文 */
const LOOKUP_FAILED = "讀取供應商帳號失敗,請重新載入";

export const useCurrentSupplier = (): CurrentSupplier => {
  const [state, setState] = useState<SupplierLookup>({ supplierId: null, loading: true, error: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          if (!cancelled) setState({ supplierId: null, loading: false, error: "尚未登入" });
          return;
        }
        const { data, error } = await (supabase as never as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { maybeSingle: () => AccountQuery } };
            };
          };
        })
          .from("supplier_accounts")
          .select("supplier_id")
          .eq("user_id", session.user.id)
          .eq("is_active", true)
          .maybeSingle();
        if (cancelled) return;
        if (error) setState({ supplierId: null, loading: false, error: friendlyDbError(new MarketDbError(error), LOOKUP_FAILED) });
        else if (!data) setState({ supplierId: null, loading: false, error: "找不到你的供應商帳號" });
        else setState({ supplierId: data.supplier_id, loading: false, error: null });
      } catch (e) {
        if (!cancelled) setState({ supplierId: null, loading: false, error: friendlyDbError(e, LOOKUP_FAILED) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setState({ supplierId: null, loading: true, error: null });
    setReloadKey((k) => k + 1);
  }, []);

  return { ...state, reload };
};
