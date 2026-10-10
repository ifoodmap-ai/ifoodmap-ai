// market_* 資料表在前端用到的形狀(型別沒有進 src/integrations/supabase/types.ts,這裡手寫一份)。
// 欄位定義的唯一來源是 supabase/migrations/20261009120000_market_catalog.sql。
import type { MarketCategoryKey, PaymentMethod, ReviewStatus, Temperature, TwCity } from "./constants";

/** PostgREST 嵌入的 suppliers(name, phone, contact_email, is_active) —— suppliers 本來就是公開表 */
export interface MarketSupplierEmbed {
  name: string;
  phone: string | null;
  contact_email: string | null;
  is_active?: boolean | null;
}

export interface MarketStoreRow {
  supplier_id: string;
  is_enabled: boolean;
  disabled_reason?: string | null;
  logo_path: string | null;
  cover_path: string | null;
  intro: string | null;
  return_policy: string | null;
  delivery_cities: TwCity[];
  shipping_fee: number;
  free_shipping_threshold: number | null;
  min_order_amount: number;
  ship_days: number;
  payment_methods: PaymentMethod[];
  updated_at?: string;
  suppliers?: MarketSupplierEmbed | null;
}

export interface MarketProductRow {
  id: string;
  supplier_id: string;
  supply_id?: string | null;
  name: string;
  category: MarketCategoryKey;
  spec: string;
  price: number;
  stock: number | null;
  temperature: Temperature;
  origin: string | null;
  storage_method: string | null;
  shelf_life: string | null;
  description: string | null;
  photos: string[];
  review_status: ReviewStatus;
  reject_reason?: string | null;
  is_listed: boolean;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at?: string;
  market_stores?: MarketStoreRow | null;
}
