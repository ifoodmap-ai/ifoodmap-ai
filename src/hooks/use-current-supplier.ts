// 目前登入者所屬的供應商 id(供應商後台的零售市集頁共用)。
// 跟 SupplierCatalogPage / SupplierOrdersPage 原本各寫一份的查法一樣:supplier_accounts 啟用中的那一列。
// 頁面外層已經有 SupplierRoute 擋未登入與沒有供應商帳號的人;這裡查不到就回 error,讓頁面顯示原因。
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CurrentSupplier {
  supplierId: string | null;
  loading: boolean;
  error: string | null;
}

type AccountQuery = PromiseLike<{ data: { supplier_id: string } | null; error: { message: string } | null }>;

export const useCurrentSupplier = (): CurrentSupplier => {
  const [state, setState] = useState<CurrentSupplier>({ supplierId: null, loading: true, error: null });

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
        if (error || !data) setState({ supplierId: null, loading: false, error: error?.message ?? "找不到你的供應商帳號" });
        else setState({ supplierId: data.supplier_id, loading: false, error: null });
      } catch (e) {
        if (!cancelled) setState({ supplierId: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};
