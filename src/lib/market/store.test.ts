// store.ts:表單 ↔ 資料列、驗證(上限跟資料庫一樣)、儲存順序(轉帳資訊一定先存)。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// 店家法定資訊(登記名稱、負責人、營業所地址、客服 Email 必填,食品業者登錄字號、產品責任險選填):長度、格式跟
// migration 20261012110000_market_compliance 的 CHECK / market_email_ok 一樣,看不到字也算沒填。
// 測試字串裡看不見的字元一律寫成 \u{…}。
import { beforeEach, describe, expect, it, vi } from "vitest";

// 假的 supabase:每次 from() 記一筆(表、操作、資料、篩選),await 時從 queue 拿「<表>.<操作>」的回應,沒有就用預設值。
type Call = {
  table: string;
  op: "select" | "upsert" | "insert" | "update";
  payload?: unknown;
  opts?: unknown;
  columns?: string;
  returning?: string;
  filters: Array<[string, unknown]>;
};
type Res = { data: unknown; error: { message: string; code?: string; hint?: string } | null };
const { calls, queue } = vi.hoisted(() => ({ calls: [] as Call[], queue: {} as Record<string, Res[]> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      let recorded = false;
      const respond = (): Promise<Res> => {
        if (!recorded) {
          calls.push(call);
          recorded = true;
        }
        const q = queue[`${table}.${call.op}`];
        if (q && q.length) return Promise.resolve(q.shift() as Res);
        // 預設:查詢查無資料;寫入成功並回傳一列(update 加 .select() 回的是陣列)
        if (call.op === "select") return Promise.resolve({ data: null, error: null });
        if (call.op === "update") return Promise.resolve({ data: [{ supplier_id: "sup-1", updated_at: "2026-10-10T08:00:00.000001+00:00" }], error: null });
        return Promise.resolve({ data: { supplier_id: "sup-1" }, error: null });
      };
      const b = {
        select: (cols?: string) => {
          if (call.op === "select") call.columns = cols;
          else call.returning = cols;
          return b;
        },
        upsert: (payload: unknown, opts: unknown) => {
          Object.assign(call, { op: "upsert", payload, opts });
          return b;
        },
        insert: (payload: unknown) => {
          Object.assign(call, { op: "insert", payload });
          return b;
        },
        update: (payload: unknown) => {
          Object.assign(call, { op: "update", payload });
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        single: respond,
        maybeSingle: respond,
        then: (ok: (v: Res) => unknown, ko?: (e: unknown) => unknown) => respond().then(ok, ko),
      };
      return b;
    },
  },
}));

import { MarketDbError } from "./db";
import { STORE_A } from "./testFixtures";
import {
  DISCLOSURE_LIMITS,
  disclosureValuesOf,
  emptyStoreForm,
  fetchOwnStore,
  MarketPartialSaveError,
  MarketStaleError,
  MARKET_TRIM_CHARS,
  marketTrim,
  missingDisclosures,
  saveStore,
  STORE_OWNER_COLUMNS,
  storeFormFromRow,
  storePayload,
  validateStoreForm,
  type StoreBase,
  type StoreForm,
} from "./store";

/** 法定資訊四項都填好的表單值 */
const LEGAL = {
  legalName: "市集測試 A 店有限公司",
  representative: "王小明",
  businessAddress: "臺北市測試路 1 號",
  serviceEmail: "service-a@example.com",
};

const valid = (over: Partial<StoreForm> = {}): StoreForm => ({
  ...emptyStoreForm(),
  deliveryCities: ["臺北市"],
  shippingFee: "120",
  freeShippingThreshold: "1000",
  minOrderAmount: "300",
  shipDays: "2",
  ...LEGAL,
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(queue)) delete queue[k];
});

describe("validateStoreForm", () => {
  it("合法的表單沒有錯誤", () => {
    expect(validateStoreForm(valid())).toEqual({});
  });

  it("至少一個縣市、至少一種付款方式", () => {
    expect(validateStoreForm(valid({ deliveryCities: [] })).deliveryCities).toBe("至少選一個配送縣市");
    expect(validateStoreForm(valid({ acceptCod: false, acceptTransfer: false })).acceptCod).toBe("至少接受一種付款方式");
  });

  it("金額與天數:整數、範圍跟資料庫一樣", () => {
    expect(validateStoreForm(valid({ shippingFee: "10001" })).shippingFee).toMatch(/0 到 10,000/);
    expect(validateStoreForm(valid({ shippingFee: "12.5" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ shippingFee: "-1" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "" })).freeShippingThreshold).toBeUndefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "0" })).freeShippingThreshold).toBeDefined();
    expect(validateStoreForm(valid({ minOrderAmount: "abc" })).minOrderAmount).toBeDefined();
    expect(validateStoreForm(valid({ shipDays: "31" })).shipDays).toMatch(/0 到 30/);
  });

  it("勾銀行轉帳一定要填 5–300 字的轉帳資訊", () => {
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "  " })).transferInfo).toMatch(/轉帳資訊/);
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "x".repeat(301) })).transferInfo).toBeDefined();
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "台灣銀行 004 帳號 123" })).transferInfo).toBeUndefined();
  });

  it("介紹與退換貨最多 1000 字", () => {
    expect(validateStoreForm(valid({ intro: "字".repeat(1001) })).intro).toBe("店家介紹最多 1000 字");
    expect(validateStoreForm(valid({ returnPolicy: "字".repeat(1001) })).returnPolicy).toBe("退換貨說明最多 1000 字");
  });
});

describe("店家法定資訊(法規查證 M6:沒填齊不能開放零售)", () => {
  it("登記名稱、負責人、營業所地址、客服 Email 必填:空白、全形空白、零寬字元都算沒填", () => {
    for (const blank of ["", "   ", "\u{3000}\u{3000}", "\u{200B}", "\u{200B}\u{3000} \u{FEFF}"]) {
      const e = validateStoreForm(valid({ legalName: blank, representative: blank, businessAddress: blank, serviceEmail: blank }));
      expect(e.legalName, JSON.stringify(blank)).toBe("請填登記名稱(公司或商號登記的名稱)");
      expect(e.representative).toBe("請填負責人");
      expect(e.businessAddress).toBe("請填營業所地址");
      expect(e.serviceEmail).toBe("請填客服 Email(會公開在店家頁,消費者用來聯絡你)");
    }
  });

  it("長度跟資料庫一樣:登記名稱 1–100、負責人 1–50、營業所地址 5–200、登錄字號 ≤ 40、產品責任險 ≤ 100", () => {
    expect(DISCLOSURE_LIMITS).toEqual({
      legalName: 100,
      representative: 50,
      businessAddressMin: 5,
      businessAddress: 200,
      serviceEmail: 254,
      foodRegistrationNo: 40,
      liabilityInsurance: 100,
    });
    expect(validateStoreForm(valid({ legalName: "名".repeat(101) })).legalName).toBe("登記名稱最多 100 字");
    expect(validateStoreForm(valid({ legalName: "名".repeat(100) })).legalName).toBeUndefined();
    expect(validateStoreForm(valid({ representative: "人".repeat(51) })).representative).toBe("負責人最多 50 字");
    expect(validateStoreForm(valid({ representative: "人".repeat(50) })).representative).toBeUndefined();
    expect(validateStoreForm(valid({ businessAddress: "臺北1號" })).businessAddress).toBe("營業所地址要 5–200 字");
    expect(validateStoreForm(valid({ businessAddress: "址".repeat(201) })).businessAddress).toBe("營業所地址要 5–200 字");
    expect(validateStoreForm(valid({ businessAddress: "址".repeat(200) })).businessAddress).toBeUndefined();
    expect(validateStoreForm(valid({ foodRegistrationNo: "A".repeat(41) })).foodRegistrationNo).toBe("食品業者登錄字號最多 40 字");
    expect(validateStoreForm(valid({ foodRegistrationNo: "A".repeat(40) })).foodRegistrationNo).toBeUndefined();
    expect(validateStoreForm(valid({ liabilityInsurance: "保".repeat(101) })).liabilityInsurance).toBe("產品責任險最多 100 字");
    // 頭尾空白不算在長度裡(資料庫存的是去掉頭尾空白之後的值)
    expect(validateStoreForm(valid({ representative: `  ${"人".repeat(50)}  ` })).representative).toBeUndefined();
  });

  it("客服 Email 照 market_email_ok:亂填、沒有網域、超過 254 字都擋;一般格式可以", () => {
    for (const bad of ["not-an-email", "a@b", `${"a".repeat(243)}@example.com`]) {
      expect(validateStoreForm(valid({ serviceEmail: bad })).serviceEmail, bad).toBe("客服 Email 格式不對");
    }
    expect(validateStoreForm(valid({ serviceEmail: " Shop.Service+1@example.com.tw " })).serviceEmail).toBeUndefined();
  });

  it("食品業者登錄字號、產品責任險可以不填", () => {
    expect(validateStoreForm(valid({ foodRegistrationNo: "", liabilityInsurance: "" }))).toEqual({});
  });

  it("法定資訊的錯誤排在最前面(畫面上這一區在最上面,toast 顯示第一個錯誤)", () => {
    const e = validateStoreForm({ ...emptyStoreForm() });
    expect(Object.keys(e).slice(0, 4)).toEqual(["legalName", "representative", "businessAddress", "serviceEmail"]);
  });

  it("missingDisclosures:依序列出還缺的項目(看不到字也算缺);供應商電話只有空白也算缺", () => {
    expect(missingDisclosures(valid(), "02-2345-6789")).toEqual([]);
    expect(missingDisclosures(valid({ legalName: "", serviceEmail: "\u{3000}" }), "02-2345-6789")).toEqual(["登記名稱", "客服 Email"]);
    expect(missingDisclosures({ ...emptyStoreForm() }, null)).toEqual(["登記名稱", "負責人", "營業所地址", "客服 Email", "店家電話"]);
    expect(missingDisclosures(valid(), "\u{3000}")).toEqual(["店家電話"]);
    // 零寬字元 JS 的 trim() 去不掉:一樣要算缺(資料庫用 market_visible 判斷)
    expect(missingDisclosures(valid(), "\u{200B}")).toEqual(["店家電話"]);
    expect(missingDisclosures(valid(), "")).toEqual(["店家電話"]);
  });

  it("missingDisclosures 只看四項法定資訊:資料列(管理後台、儲存過的店)用 disclosureValuesOf 取值,不需要其他欄位", () => {
    const row = { legal_name: "市集測試 A 店有限公司", representative: null, business_address: "臺北市測試路 1 號", service_email: "\u{200B}" };
    expect(disclosureValuesOf(row)).toEqual({ legalName: "市集測試 A 店有限公司", representative: "", businessAddress: "臺北市測試路 1 號", serviceEmail: "\u{200B}" });
    expect(missingDisclosures(disclosureValuesOf(row), "02-2345-6789")).toEqual(["負責人", "客服 Email"]);
    expect(missingDisclosures(disclosureValuesOf(null), null)).toEqual(["登記名稱", "負責人", "營業所地址", "客服 Email", "店家電話"]);
  });

  it("去頭尾跟資料庫的 market_trim 同一組字元:零寬字元、WORD JOINER、BOM、U+0085 也去掉(JS 的 trim() 去不掉)", () => {
    expect(marketTrim("\u{200B}\u{2060} 王小明\u{3000}\u{FEFF}\u{85}\u{180E}")).toBe("王小明");
    expect(marketTrim("王\u{200B}小明")).toBe("王\u{200B}小明");
    // 從網頁複製、尾巴帶零寬空白的 Email:資料庫會先去掉再檢查,前端也不能誤擋;存的是去掉之後的值
    expect(validateStoreForm(valid({ serviceEmail: "service-a@example.com\u{200B}" })).serviceEmail).toBeUndefined();
    expect(storePayload("s", valid({ serviceEmail: "\u{FEFF}service-a@example.com\u{200B}" })).service_email).toBe("service-a@example.com");
    // 頭尾的零寬字元不算長度:資料庫 market_trim 之後只剩 3 字,前端也要擋(不然會變成通用的 23514)
    expect(validateStoreForm(valid({ businessAddress: "臺北市\u{200B}\u{200B}" })).businessAddress).toBe("營業所地址要 5–200 字");
    expect(storePayload("s", valid({ legalName: "\u{200B}市集測試 A 店有限公司\u{2060}" })).legal_name).toBe("市集測試 A 店有限公司");
  });
});

describe("資料列 ↔ 表單", () => {
  it("storeFormFromRow 再 storePayload 回得去", () => {
    const form = storeFormFromRow(STORE_A, "台灣銀行 004 帳號 123");
    expect(form).toMatchObject({ shippingFee: "120", freeShippingThreshold: "1000", acceptCod: true, acceptTransfer: true });
    expect(storePayload(STORE_A.supplier_id, form)).toMatchObject({
      delivery_cities: ["臺北市", "新北市"],
      shipping_fee: 120,
      free_shipping_threshold: 1000,
      min_order_amount: 300,
      ship_days: 2,
      payment_methods: ["cod", "transfer"],
      intro: "當日採收的葉菜與根莖類",
    });
  });

  it("storePayload 每個欄位都照表單送(logo、封面、退換貨說明不能變成 null 把原本的蓋掉)", () => {
    const form = valid({
      intro: " 介紹 ",
      returnPolicy: " 收到 24 小時內可退 ",
      logoPath: "sup-1/store/logo.jpg",
      coverPath: "sup-1/store/cover.jpg",
      acceptTransfer: true,
      transferInfo: "台灣銀行 004 帳號 123",
    });
    expect(storePayload("sup-1", form)).toEqual({
      supplier_id: "sup-1",
      intro: "介紹",
      return_policy: "收到 24 小時內可退",
      delivery_cities: ["臺北市"],
      shipping_fee: 120,
      free_shipping_threshold: 1000,
      min_order_amount: 300,
      ship_days: 2,
      payment_methods: ["cod", "transfer"],
      logo_path: "sup-1/store/logo.jpg",
      cover_path: "sup-1/store/cover.jpg",
      legal_name: "市集測試 A 店有限公司",
      representative: "王小明",
      business_address: "臺北市測試路 1 號",
      service_email: "service-a@example.com",
      food_registration_no: null,
      liability_insurance: null,
    });
  });

  it("法定資訊:資料列 → 表單 → payload 回得去;去掉頭尾空白;選填留白 = null", () => {
    const row = {
      ...STORE_A,
      legal_name: "市集測試 A 店有限公司",
      representative: "王小明",
      business_address: "臺北市測試路 1 號",
      service_email: "service-a@example.com",
      food_registration_no: "A-123456789-00000-0",
      liability_insurance: "新光產險 產品責任險 2000 萬",
    };
    const form = storeFormFromRow(row, null);
    expect(form).toMatchObject({ ...LEGAL, foodRegistrationNo: "A-123456789-00000-0", liabilityInsurance: "新光產險 產品責任險 2000 萬" });
    expect(storePayload("sup-1", form)).toMatchObject({
      legal_name: "市集測試 A 店有限公司",
      food_registration_no: "A-123456789-00000-0",
      liability_insurance: "新光產險 產品責任險 2000 萬",
    });
    expect(storeFormFromRow(STORE_A, null)).toMatchObject({ legalName: "", representative: "", businessAddress: "", serviceEmail: "" });
    expect(
      storePayload("s", valid({ legalName: " 市集測試 A 店有限公司 ", serviceEmail: " service-a@example.com ", foodRegistrationNo: "  " })),
    ).toMatchObject({ legal_name: "市集測試 A 店有限公司", service_email: "service-a@example.com", food_registration_no: null });
  });

  it("免運門檻留白 = null;空白介紹 = null", () => {
    expect(storePayload("s", valid({ freeShippingThreshold: " ", intro: "  " }))).toMatchObject({
      free_shipping_threshold: null,
      intro: null,
    });
  });
});

// 讀取出錯一定要丟錯:回 null 的話頁面會當成「還沒建店」顯示空白表單,一儲存就把原本的設定蓋掉。
describe("店家法定資訊跟 migration 20261012110000_market_compliance 一致", () => {
  const MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261012110000_market_compliance.sql"), "utf8");
  /** 只切 guard 這一支函式(到它自己的 $$; 為止),不會連到後面 market_store_is_open 的同一段條件 */
  const fnBody = (name: string) => {
    const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    expect(start, name).toBeGreaterThan(-1);
    return MIGRATION.slice(start, MIGRATION.indexOf("$$;", start));
  };
  const GUARD = fnBody("market_stores_guard");
  const between = (col: string): [number, number] => {
    const all = [...MIGRATION.matchAll(new RegExp(`char_length\\(${col}\\) BETWEEN (\\d+) AND (\\d+)`, "g"))];
    expect(all, `${col} 的 CHECK 要剛好一處`).toHaveLength(1);
    return [Number(all[0][1]), Number(all[0][2])];
  };

  it("長度:market_stores_disclosure_lengths 每一個 BETWEEN 都等於 DISCLOSURE_LIMITS", () => {
    expect(between("legal_name")).toEqual([1, DISCLOSURE_LIMITS.legalName]);
    expect(between("representative")).toEqual([1, DISCLOSURE_LIMITS.representative]);
    expect(between("business_address")).toEqual([DISCLOSURE_LIMITS.businessAddressMin, DISCLOSURE_LIMITS.businessAddress]);
    expect(between("food_registration_no")).toEqual([1, DISCLOSURE_LIMITS.foodRegistrationNo]);
    expect(between("liability_insurance")).toEqual([1, DISCLOSURE_LIMITS.liabilityInsurance]);
  });

  it("客服 Email 照 market_email_ok(130000:254 字以內 + 跟 EMAIL_PATTERN 同一組正規式)", () => {
    expect(MIGRATION).toContain("CHECK (service_email IS NULL OR public.market_email_ok(service_email))");
    const orders = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130000_market_orders.sql"), "utf8");
    const fn = orders.slice(orders.indexOf("CREATE OR REPLACE FUNCTION public.market_email_ok"));
    expect(fn.slice(0, fn.indexOf("$$;"))).toContain(`char_length(p) <= ${DISCLOSURE_LIMITS.serviceEmail}`);
  });

  it("guard:六個欄位都用 market_visible / market_trim(看不到字 = 沒填);開放零售要四項加上供應商電話,hint 是 store_disclosure_missing", () => {
    for (const col of ["legal_name", "representative", "business_address", "service_email", "food_registration_no", "liability_insurance"]) {
      expect(GUARD, col).toContain(`CASE WHEN public.market_visible(NEW.${col}) THEN public.market_trim(NEW.${col}) END`);
    }
    expect(GUARD).toContain("NEW.legal_name IS NULL OR NEW.representative IS NULL OR NEW.business_address IS NULL OR NEW.service_email IS NULL");
    expect(GUARD).toContain("public.market_visible(p.phone)");
    expect(GUARD).toContain("HINT = 'store_disclosure_missing'");
    // missingDisclosures 列的就是這五項(四個欄位 + 電話)
    expect(missingDisclosures({ ...emptyStoreForm() }, null)).toHaveLength(5);
  });

  it("market_store_is_open(公開頁面與下單)也要求同一組:四項法定資訊、供應商電話看得到字 —— 供應商商品清單與管理員頁照這個寫", () => {
    const isOpen = fnBody("market_store_is_open");
    expect(isOpen).toContain("s.legal_name IS NOT NULL AND s.representative IS NOT NULL AND s.business_address IS NOT NULL");
    expect(isOpen).toContain("s.service_email IS NOT NULL AND public.market_visible(p.phone)");
  });

  it("market_trim 的字元組跟 MARKET_TRIM_CHARS 一字不差(120000)", () => {
    const catalog = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009120000_market_catalog.sql"), "utf8");
    const fn = catalog.slice(catalog.indexOf("CREATE OR REPLACE FUNCTION public.market_trim"));
    const set = /VALUES \('\[([^\]]+)\]'\)/.exec(fn.slice(0, fn.indexOf("$$;")))?.[1];
    expect(set).toBe(MARKET_TRIM_CHARS);
  });
});

describe("fetchOwnStore", () => {
  it("讀到店家、轉帳資訊與供應商電話:只查自家、欄位是 STORE_OWNER_COLUMNS", async () => {
    queue["market_stores.select"] = [{ data: STORE_A, error: null }];
    queue["market_store_transfer.select"] = [{ data: { transfer_info: "台灣銀行 004 帳號 123" }, error: null }];
    queue["suppliers.select"] = [{ data: { phone: "02-2345-6789" }, error: null }];
    await expect(fetchOwnStore("sup-1")).resolves.toEqual({ store: STORE_A, transferInfo: "台灣銀行 004 帳號 123", supplierPhone: "02-2345-6789" });
    expect(calls.map((c) => [c.table, c.columns, c.filters])).toEqual([
      ["market_stores", STORE_OWNER_COLUMNS, [["supplier_id", "sup-1"]]],
      ["market_store_transfer", "transfer_info", [["supplier_id", "sup-1"]]],
      ["suppliers", "phone", [["id", "sup-1"]]],
    ]);
  });

  it("店家自己的查詢帶六個法定資訊欄位;不帶 contact_email", () => {
    for (const col of ["legal_name", "representative", "business_address", "service_email", "food_registration_no", "liability_insurance"]) {
      expect(STORE_OWNER_COLUMNS.split(", "), col).toContain(col);
    }
    expect(STORE_OWNER_COLUMNS).not.toContain("contact_email");
  });

  it("查無店家、查無轉帳資訊 → 都是 null(這才是「還沒建店」);查無電話 → null", async () => {
    await expect(fetchOwnStore("sup-1")).resolves.toEqual({ store: null, transferInfo: null, supplierPhone: null });
  });

  it("供應商電話查詢失敗 → 丟 MarketDbError,不能當成沒有電話", async () => {
    queue["suppliers.select"] = [{ data: null, error: { message: "permission denied", code: "42501" } }];
    await expect(fetchOwnStore("sup-1")).rejects.toBeInstanceOf(MarketDbError);
  });

  it("店家查詢失敗 → 丟 MarketDbError,不能回 null", async () => {
    queue["market_stores.select"] = [{ data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "" } }];
    await expect(fetchOwnStore("sup-1")).rejects.toBeInstanceOf(MarketDbError);
  });

  it("轉帳資訊查詢失敗 → 丟 MarketDbError,不能當成沒有轉帳資訊", async () => {
    queue["market_stores.select"] = [{ data: STORE_A, error: null }];
    queue["market_store_transfer.select"] = [{ data: null, error: { message: "permission denied", code: "42501" } }];
    await expect(fetchOwnStore("sup-1")).rejects.toBeInstanceOf(MarketDbError);
  });
});

/** PostgREST 回的 updated_at:微秒精度。轉成 Date 再轉回字串會掉到毫秒(.123Z),比對就永遠對不上 */
const READ_AT = "2026-10-10T07:00:00.123456+00:00";
const NEW_STORE: StoreBase = { updatedAt: null, transferInfo: null };
const EXISTING: StoreBase = { updatedAt: READ_AT, transferInfo: null };

describe("saveStore", () => {
  it("第一次接受轉帳、轉帳資訊存失敗 → 丟錯,不會接著存店家", async () => {
    queue["market_store_transfer.insert"] = [{ data: null, error: { message: "value too long", code: "23514" } }];
    await expect(
      saveStore("sup-1", valid({ acceptTransfer: true, transferInfo: "台灣銀行 004 帳號 123" }), NEW_STORE),
    ).rejects.toBeInstanceOf(MarketDbError);
    expect(calls.map((c) => c.table)).toEqual(["market_store_transfer"]);
  });

  it("第一次接受轉帳(資料庫還沒有轉帳資訊):先 insert 轉帳資訊(guard 要求),再存店家", async () => {
    await saveStore("sup-1", valid({ acceptTransfer: true, transferInfo: " 台灣銀行 004 帳號 123 " }), NEW_STORE);
    expect(calls.map((c) => [c.table, c.op])).toEqual([
      ["market_store_transfer", "insert"],
      ["market_stores", "insert"],
    ]);
    expect(calls[0].payload).toEqual({ supplier_id: "sup-1", transfer_info: "台灣銀行 004 帳號 123" });
  });

  it("只收貨到付款:不碰轉帳資訊", async () => {
    await saveStore("sup-1", valid(), NEW_STORE);
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });
});

// 轉帳資訊與店家是兩張表、兩個請求:順序要讓「只存好一半」越少越好,真的只存好一半時要講清楚是哪一半。
describe("saveStore — 儲存順序與只存好一部分", () => {
  const WITH_TRANSFER: StoreBase = { updatedAt: READ_AT, transferInfo: "舊帳號 1111" };
  const transferForm = (info: string) => valid({ acceptTransfer: true, transferInfo: info });

  it("第一次接受轉帳,但別的分頁已經存了轉帳資訊(23505)→ MarketStaleError,店家也不寫", async () => {
    queue["market_store_transfer.insert"] = [{ data: null, error: { message: "duplicate key value", code: "23505" } }];
    await expect(saveStore("sup-1", transferForm("新帳號 2222"), EXISTING)).rejects.toBeInstanceOf(MarketStaleError);
    expect(calls.map((c) => c.table)).toEqual(["market_store_transfer"]);
  });

  it("已經有轉帳資訊而且改了:先存店家,店家存好才更新轉帳資訊", async () => {
    await saveStore("sup-1", transferForm(" 新帳號 2222 "), WITH_TRANSFER);
    expect(calls.map((c) => [c.table, c.op])).toEqual([
      ["market_stores", "update"],
      ["market_store_transfer", "upsert"],
    ]);
    expect(calls[1].payload).toEqual({ supplier_id: "sup-1", transfer_info: "新帳號 2222" });
  });

  it("已經有轉帳資訊、店家過期:什麼都不寫(轉帳資訊也不動)", async () => {
    queue["market_stores.update"] = [{ data: [], error: null }];
    await expect(saveStore("sup-1", transferForm("新帳號 2222"), WITH_TRANSFER)).rejects.toBeInstanceOf(MarketStaleError);
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });

  it("已經有轉帳資訊、店家存失敗:丟原本的錯(不是只存好一部分),轉帳資訊不動", async () => {
    queue["market_stores.update"] = [{ data: null, error: { message: "check", code: "23514" } }];
    const err = await saveStore("sup-1", transferForm("新帳號 2222"), WITH_TRANSFER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketDbError);
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });

  it("轉帳資訊沒改:不寫轉帳資訊", async () => {
    await saveStore("sup-1", transferForm(" 舊帳號 1111 "), WITH_TRANSFER);
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });

  it("店家存好、轉帳資訊存失敗 → MarketPartialSaveError(saved=store),帶存好的店家,訊息講清楚哪一部分存好", async () => {
    const saved = { ...STORE_A, updated_at: "2026-10-10T07:05:00.654321+00:00" };
    queue["market_stores.update"] = [{ data: [saved], error: null }];
    queue["market_store_transfer.upsert"] = [{ data: null, error: { message: "check", code: "23514" } }];
    const err = await saveStore("sup-1", transferForm("新帳號 2222"), WITH_TRANSFER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketPartialSaveError);
    const partial = err as MarketPartialSaveError;
    expect(partial.saved).toBe("store");
    expect(partial.store).toEqual(saved);
    expect(partial.message).toBe(
      "店家設定已儲存,但轉帳資訊沒有存到:有欄位超過長度上限或格式不對,請檢查後再送出。消費者看到的仍是原本的轉帳資訊,請再按一次儲存。",
    );
  });

  it("轉帳資訊先存好、店家存失敗 → MarketPartialSaveError(saved=transfer),帶存好的轉帳資訊,訊息講清楚", async () => {
    queue["market_stores.update"] = [{ data: [], error: null }];
    const err = await saveStore("sup-1", transferForm(" 新帳號 2222 "), EXISTING).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketPartialSaveError);
    const partial = err as MarketPartialSaveError;
    expect(partial.saved).toBe("transfer");
    expect(partial.transferInfo).toBe("新帳號 2222");
    expect(partial.failure).toBeInstanceOf(MarketStaleError);
    expect(partial.message).toBe("轉帳資訊已儲存,但店家設定(配送、付款等)沒有存到:資料已被其他人更新,請重新載入後再改");
    expect(calls.map((c) => [c.table, c.op])).toEqual([
      ["market_store_transfer", "insert"],
      ["market_stores", "update"],
    ]);
  });
});

// 兩個分頁、兩位同事同時改:後存的人不能把對方的修改整份蓋掉。
describe("saveStore — 不蓋掉別人的修改(比對讀到的 updated_at)", () => {
  it("第一次建立店家:insert(沒有 updated_at 可比對),回傳資料庫的那一列", async () => {
    queue["market_stores.insert"] = [{ data: { ...STORE_A, updated_at: READ_AT }, error: null }];
    await expect(saveStore("sup-1", valid(), NEW_STORE)).resolves.toEqual({ ...STORE_A, updated_at: READ_AT });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "market_stores", op: "insert", returning: STORE_OWNER_COLUMNS, filters: [] });
    expect(calls[0].payload).toEqual(storePayload("sup-1", valid()));
  });

  it("第一次建立時別的分頁已經先建好(23505)→ MarketStaleError,不覆寫", async () => {
    queue["market_stores.insert"] = [{ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } }];
    await expect(saveStore("sup-1", valid(), NEW_STORE)).rejects.toBeInstanceOf(MarketStaleError);
  });

  it("更新既有店家:update + 比對讀到的 updated_at 原字串(微秒精度,不轉成 Date)", async () => {
    const saved = { ...STORE_A, updated_at: "2026-10-10T07:05:00.654321+00:00" };
    queue["market_stores.update"] = [{ data: [saved], error: null }];
    await expect(saveStore("sup-1", valid(), EXISTING)).resolves.toEqual(saved);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: "market_stores", op: "update", returning: STORE_OWNER_COLUMNS });
    expect(calls[0].filters).toEqual([
      ["supplier_id", "sup-1"],
      ["updated_at", "2026-10-10T07:00:00.123456+00:00"],
    ]);
    expect(calls[0].payload).toEqual(storePayload("sup-1", valid()));
  });

  it("updated_at 對不上(沒有更新到任何一列)→ MarketStaleError「資料已被其他人更新,請重新載入後再改」", async () => {
    queue["market_stores.update"] = [{ data: [], error: null }];
    const err = await saveStore("sup-1", valid(), EXISTING).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketStaleError);
    expect((err as Error).message).toBe("資料已被其他人更新,請重新載入後再改");
  });
});
