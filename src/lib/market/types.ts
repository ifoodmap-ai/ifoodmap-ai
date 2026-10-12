// market_* 資料表在前端用到的形狀(型別沒有進 src/integrations/supabase/types.ts,這裡手寫一份)。
// 欄位定義的唯一來源是 supabase/migrations/20261009120000_market_catalog.sql。
import type { MarketCategoryKey, PaymentMethod, ReviewStatus, Temperature, TwCity } from "./constants";

/** PostgREST 嵌入的 suppliers。市集公開查詢只抓 name, phone, is_active;contact_email 只有管理後台的查詢會帶 */
export interface MarketSupplierEmbed {
  name: string;
  phone: string | null;
  contact_email?: string | null;
  is_active?: boolean | null;
}

export interface MarketStoreRow {
  supplier_id: string;
  is_enabled: boolean;
  disabled_reason?: string | null;
  /**
   * 店家法定資訊(migration 20261012110000_market_compliance.sql;消保法 §18、零售 / 食品應記載事項):
   * 登記名稱、負責人、營業所地址、客服 Email 四項加上供應商電話(suppliers.phone)都有,才能開放零售。
   * 只有店家自己(store.ts)與管理後台的查詢會帶;市集公開查詢帶哪幾項看 catalog.ts。
   */
  legal_name?: string | null;
  representative?: string | null;
  business_address?: string | null;
  service_email?: string | null;
  /** 食品業者登錄字號(依法要登錄的才有;選填) */
  food_registration_no?: string | null;
  /** 產品責任險(選填) */
  liability_insurance?: string | null;
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
  /**
   * true = 不適用七日鑑賞期(店家勾選,管理員審核時確認;改了會回到待審)。預設 false = 適用。
   * migration 20261012110000 之後一定有值;沒有這個欄位的舊假資料當成 false。
   */
  withdrawal_exempt?: boolean;
  review_status: ReviewStatus;
  reject_reason?: string | null;
  is_listed: boolean;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at?: string;
  market_stores?: MarketStoreRow | null;
}
