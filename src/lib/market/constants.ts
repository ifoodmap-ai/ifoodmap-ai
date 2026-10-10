// 消費者食材市集的固定清單與長度上限 —— 前端唯一的出處。
//
// 🔴 縣市、分類、溫層跟資料庫的 CHECK / 函式一字不差:constants.test.ts 會解析
//    supabase/migrations/20261009120000_market_catalog.sql 的 @market-*-begin … @market-*-end 比對,改一邊一定要改另一邊。
// 長度與金額上限也跟資料庫的 CHECK 一樣(資料庫才是最後一道關卡,這裡讓使用者在送出前就知道)。

export const TW_CITIES = [
  "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
  "基隆市", "新竹市", "嘉義市",
  "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣",
  "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
] as const;
export type TwCity = (typeof TW_CITIES)[number];
export const isTwCity = (v: unknown): v is TwCity =>
  typeof v === "string" && (TW_CITIES as readonly string[]).includes(v);

/** 12 類,順序與圖示跟形象站首頁「食材分類」一樣(landing/i18n.js home.data.categories、landing/index.html CATEGORY_IMGS) */
export const MARKET_CATEGORIES = [
  { key: "vegetable", label: "蔬菜" },
  { key: "fruit", label: "水果" },
  { key: "seafood", label: "海鮮" },
  { key: "meat", label: "肉品" },
  { key: "egg", label: "蛋品" },
  { key: "grain", label: "五穀雜糧" },
  { key: "grocery", label: "南北雜貨" },
  { key: "processed", label: "加工食品" },
  { key: "hotpot", label: "火鍋料" },
  { key: "condiment", label: "調味品" },
  // 形象站叫「酒與飲品」;市集不賣酒(菸酒管理法第 30 條:不得以電子購物等無法辨識年齡的方式賣酒)
  { key: "drink", label: "飲品（不含酒）" },
  { key: "packaging", label: "包材耗材" },
] as const;
export type MarketCategoryKey = (typeof MARKET_CATEGORIES)[number]["key"];
export const CATEGORY_LABEL = Object.fromEntries(MARKET_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  MarketCategoryKey,
  string
>;
export const isCategoryKey = (v: unknown): v is MarketCategoryKey =>
  typeof v === "string" && MARKET_CATEGORIES.some((c) => c.key === v);

export const TEMPERATURES = { ambient: "常溫", chilled: "冷藏", frozen: "冷凍" } as const;
export type Temperature = keyof typeof TEMPERATURES;
export const TEMPERATURE_KEYS = Object.keys(TEMPERATURES) as Temperature[];
export const isTemperature = (v: unknown): v is Temperature =>
  typeof v === "string" && (TEMPERATURE_KEYS as string[]).includes(v);

export const PAYMENT_METHODS = { cod: "貨到付款", transfer: "銀行轉帳" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export type ReviewStatus = "draft" | "pending" | "approved" | "rejected";
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: "草稿",
  pending: "待審",
  approved: "已核准",
  rejected: "退回",
};

/** 跟 migration 的 CHECK 一樣 */
export const LIMITS = {
  productName: 60,
  spec: 40,
  origin: 40,
  storageMethod: 100,
  shelfLife: 40,
  description: 2000,
  rejectReason: 300,
  storeIntro: 1000,
  returnPolicy: 1000,
  transferInfoMin: 5,
  transferInfo: 300,
  disabledReason: 300,
  price: 1_000_000,
  stock: 100_000,
  shippingFee: 10_000,
  freeShippingThreshold: 1_000_000,
  minOrderAmount: 1_000_000,
  shipDays: 30,
} as const;

export const PHOTO_RULES = {
  /** 每個商品最多幾張照片(資料庫 CHECK cardinality(photos) <= 5) */
  maxCount: 5,
  /** 上傳到 Storage 的檔案上限(bucket file_size_limit) */
  maxBytes: 2 * 1024 * 1024,
  /** 原始檔上限:手機照片 3–8 MB 很正常,先在瀏覽器壓縮;超過 15 MB 直接拒絕,避免手機記憶體爆掉 */
  maxInputBytes: 15 * 1024 * 1024,
  longSide: 1600,
  thumbLongSide: 480,
  inputTypes: ["image/jpeg", "image/png", "image/webp"],
} as const;

export const MARKET_IMAGE_BUCKET = "market-images";
