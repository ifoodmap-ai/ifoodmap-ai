import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeDb, type FakeDbOptions, type Row } from "../../tests/fake-supabase.ts";
import type { Db, DbQuery, DbResult } from "../_shared/db.ts";
import type { MailConfig } from "../_shared/supplier-mail.ts";
import { formatOrderNo } from "../../../src/lib/order-number.ts";
import { sha256Hex } from "../ai/crypto.ts";
import { marketLiveFromEnv } from "./gate.ts";
import {
  createMarketNotifyHandler,
  EVENT_COLUMNS,
  ITEM_COLUMNS,
  maskEmail,
  ORDER_COLUMNS,
  secretMatches,
  STORE_COLUMNS,
  SUPPLIER_COLUMNS,
  TRANSFER_COLUMNS,
} from "./handler.ts";
import { createMarketResendSender, type MarketSendMail } from "./send.ts";

const SECRET = "notify-secret";
const TOKEN = `tok_${"x".repeat(39)}`; // 43 字元 base64url
const HASH = await sha256Hex(TOKEN);
const CHECKOUT = "a9500000-0000-4000-8000-000000000001";
const ORDER_A = "a9600000-0000-4000-8000-0000000000a1";
const ORDER_B = "a9600000-0000-4000-8000-0000000000b1";
const SUP_A = "a9200000-0000-4000-8000-00000000000a";
const SUP_B = "a9200000-0000-4000-8000-00000000000b";
const EV = (n: number) => `a9700000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const CONFIG: MailConfig = {
  resendKey: "re_test",
  applicantFrom: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
  ownerFrom: "iFoodmap 表單通知 <noreply@gathertaiwan.com>",
  ownerTo: ["ifoodmaptw@gmail.com"],
  replyTo: "ifoodmaptw@gmail.com",
  siteUrl: "https://app.ifoodmap.ai",
  adminSiteUrl: "https://ifoodmap-admin.vercel.app",
};

const order = (over: Row): Row => ({
  checkout_id: CHECKOUT,
  status: "pending",
  buyer_name: "王小明",
  buyer_email: "buyer@example.com",
  ship_city: "臺北市",
  ship_address: "測試路 1 號",
  buyer_note: null,
  payment_method: "cod",
  lookup_token_hash: HASH,
  // 跟正式庫一樣:沒收款的單 paid_at 是 null(不是沒有這個欄位)
  paid_at: null,
  ...over,
});

const tables = (): Record<string, Row[]> => ({
  suppliers: [
    { id: SUP_A, name: "市集測試 A 店", contact_email: "store-a@example.com", phone: "02-2345-6789" },
    { id: SUP_B, name: "市集測試 B 店", contact_email: null, phone: null },
  ],
  market_stores: [
    { supplier_id: SUP_A, ship_days: 2 },
    { supplier_id: SUP_B, ship_days: 3 },
  ],
  market_store_transfer: [{ supplier_id: SUP_B, transfer_info: "郵局(700) 帳號 0001234-5678901" }],
  market_orders: [
    order({ id: ORDER_A, supplier_id: SUP_A, subtotal: 650, shipping_fee: 120, total: 770 }),
    order({ id: ORDER_B, supplier_id: SUP_B, subtotal: 400, shipping_fee: 60, total: 460, payment_method: "transfer" }),
  ],
  market_order_items: [
    { order_id: ORDER_A, product_name: "有機高麗菜", spec: "1 顆", qty: 2, unit_price: 100, line_total: 200 },
    { order_id: ORDER_A, product_name: "牛肉片", spec: "300g/盒", qty: 1, unit_price: 450, line_total: 450 },
    { order_id: ORDER_B, product_name: "挪威鮭魚", spec: "200g/片", qty: 2, unit_price: 200, line_total: 400 },
  ],
  market_order_events: [
    { id: EV(1), order_id: ORDER_A, from_status: null, to_status: "pending", actor_role: "consumer", note: null, payload: {} },
    { id: EV(2), order_id: ORDER_A, from_status: "pending", to_status: "confirmed", actor_role: "supplier", note: null, payload: {} },
    { id: EV(3), order_id: ORDER_B, from_status: "pending", to_status: "confirmed", actor_role: "supplier", note: null, payload: {} },
    // created_at:PostgREST 回的微秒格式(台北 2026/10/12 11:00 進入待匯款 → 匯款期限 2026/10/15 11:00)
    { id: EV(4), order_id: ORDER_B, from_status: "confirmed", to_status: "awaiting_payment", actor_role: "system", note: null, payload: {}, created_at: "2026-10-12T03:00:00.123456+00:00" },
    { id: EV(5), order_id: ORDER_A, from_status: "pending", to_status: "cancelled", actor_role: "admin", note: "疑似假單", payload: {} },
    { id: EV(6), order_id: ORDER_A, from_status: "confirmed", to_status: "shipped", actor_role: "supplier", note: null, payload: { carrier: "黑貓宅急便", tracking_no: "9001" } },
    { id: EV(7), order_id: ORDER_A, from_status: "shipped", to_status: "completed", actor_role: "supplier", note: null, payload: {} },
    { id: EV(8), order_id: ORDER_B, from_status: null, to_status: "pending", actor_role: "consumer", note: null, payload: {} },
  ],
  notifications: [],
});

/**
 * 跟 PostgREST 一樣:select("a, b") 只回傳選到的欄位(資料列裡沒有的欄位是 null)。
 * 共用的 FakeDb 不看欄位清單 —— 少讀一個欄位(total、phone、contact_email…)測試照樣全綠、正式環境卻壞掉。
 * 這裡包一層,handler 只拿得到它真的有選的欄位(其他 Edge Function 的測試也用 FakeDb,所以不改共用檔)。
 */
class SelectingQuery implements DbQuery {
  private columns: string[] | null = null;
  constructor(private inner: DbQuery) {}
  select(columns?: string) {
    if (columns !== undefined && columns.trim() !== "*") {
      this.columns = columns.split(",").map((c) => c.trim());
      // 別名、巢狀查詢這裡不支援:handler 改用那種寫法時要先改這個包裝,不然測試會照錯的欄位跑
      for (const c of this.columns) if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`測試的假資料庫只認單純的欄位名稱:${c}`);
    }
    this.inner = this.inner.select(columns);
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.inner = this.inner.insert(values);
    return this;
  }
  update(values: Record<string, unknown>) {
    this.inner = this.inner.update(values);
    return this;
  }
  delete() {
    this.inner = this.inner.delete();
    return this;
  }
  eq(column: string, value: unknown) {
    this.inner = this.inner.eq(column, value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.inner = this.inner.neq(column, value);
    return this;
  }
  private pick = (r: DbResult): DbResult => {
    const cols = this.columns;
    if (!cols || r.error || r.data === null || r.data === undefined) return r;
    const only = (row: Row) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));
    return { data: Array.isArray(r.data) ? (r.data as Row[]).map(only) : only(r.data as Row), error: null };
  };
  maybeSingle() {
    return this.inner.maybeSingle().then(this.pick);
  }
  single() {
    return this.inner.single().then(this.pick);
  }
  then<A = DbResult, B = never>(
    onfulfilled?: ((value: DbResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.inner.then(this.pick).then(onfulfilled, onrejected);
  }
}
/** 給 handler 用的資料庫:照 select 字串回傳欄位;測試自己檢查用的還是原本的 FakeDb(db.tables、db.calls) */
const selecting = (db: FakeDb): Db => ({ from: (table) => new SelectingQuery(db.from(table)), rpc: (fn, args) => db.rpc(fn, args) });

const setup = (opts: { live?: boolean; secret?: string; fail?: FakeDbOptions["fail"]; send?: MarketSendMail } = {}) => {
  const db = new FakeDb({ tables: tables(), fail: opts.fail });
  const send = vi.fn<MarketSendMail>(opts.send ?? (async () => ({ ok: true, id: "re_1", error: null })));
  const log = vi.fn();
  const handler = createMarketNotifyHandler({
    db: selecting(db),
    send,
    config: CONFIG,
    secret: opts.secret ?? SECRET,
    isLive: () => opts.live ?? false,
    log,
  });
  const call = async (body: unknown, auth = `Bearer ${SECRET}`, method = "POST") => {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/market-notify", {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  return { db, send, log, call };
};

describe("market-notify:驗證", () => {
  it("沒設密鑰 503;密鑰不對 401;不是 POST 405;都不寄信", async () => {
    expect((await setup({ secret: "" }).call({ kind: "event", event_id: EV(1) })).status).toBe(503);
    const s = setup();
    expect((await s.call({ kind: "event", event_id: EV(1) }, "Bearer wrong")).status).toBe(401);
    expect((await s.call(null, `Bearer ${SECRET}`, "GET")).status).toBe(405);
    expect(s.send).not.toHaveBeenCalled();
  });

  // 審查追加:密鑰改成常數時間比對(secretMatches);只對開頭、長度不同、大小寫不同、少了 Bearer 一律擋
  // (計畫規定密鑰不對回 401;token 對不上才是 403)
  it("密鑰只對開頭、多一個字、重複兩次、少一個字、大小寫不同、沒有 Bearer、空的:都 401、都不寄", async () => {
    const s = setup();
    for (const auth of [
      `Bearer ${SECRET.slice(0, 6)}`,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET}${SECRET}`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${SECRET.toUpperCase()}`,
      `bearer ${SECRET}`,
      SECRET,
      "",
    ]) {
      expect((await s.call({ kind: "event", event_id: EV(2) }, auth)).status, JSON.stringify(auth)).toBe(401);
    }
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.call({ kind: "event", event_id: EV(2) })).status).toBe(200); // 對照組:完全相同才過
  });

  it("secretMatches:完全相同才是 true(兩邊先 sha256 再逐字比,長度不同也照樣跑完)", async () => {
    expect(await secretMatches("Bearer abc", "Bearer abc")).toBe(true);
    for (const given of ["Bearer ab", "Bearer abcd", "Bearer abC", "", "Bearer abc ".repeat(50)]) {
      expect(await secretMatches(given, "Bearer abc"), JSON.stringify(given)).toBe(false);
    }
  });

  it("kind 不對、id 格式不對 400", async () => {
    const s = setup();
    expect((await s.call({ kind: "nope" })).status).toBe(400);
    expect((await s.call({ kind: "event", event_id: "1" })).status).toBe(400);
    expect((await s.call({ kind: "placed", checkout_id: CHECKOUT, token: "short" })).status).toBe(400);
  });
});

describe("market-notify:下單確認", () => {
  it("閘門關閉:只寄一封到測試信箱,列出兩家店與查詢連結;回應與紀錄都沒有 token", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ live: false, sent: 1, total: 1, orders: 2 });
    expect(s.send).toHaveBeenCalledTimes(1);
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["ifoodmaptw@gmail.com"]);
    expect(msg.subject).toBe("[測試轉寄] 訂單已送出(共 2 家店)— iFoodmap 食材市集");
    expect(msg.html).toContain("buyer@example.com");
    expect(msg.html).toContain(`https://app.ifoodmap.ai/market/orders/${TOKEN}`);
    expect(msg.html).toContain("市集測試 A 店");
    expect(msg.html).toContain("市集測試 B 店");
    expect(msg.replyTo).toBe("ifoodmaptw@gmail.com");
    expect(r.text).not.toContain(TOKEN);
    expect(JSON.stringify(s.db.tables.notifications)).not.toContain(TOKEN);
    expect(s.db.tables.notifications).toHaveLength(1);
    expect(s.db.tables.notifications[0]).toMatchObject({ recipient: "ifoodmaptw@gmail.com", channel: "email", status: "sent" });
  });

  it("閘門開放:寄給消費者本人", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(s.send.mock.calls[0][0].to).toEqual(["buyer@example.com"]);
    expect(s.send.mock.calls[0][0].subject).toBe("訂單已送出(共 2 家店)— iFoodmap 食材市集");
  });

  it("token 跟訂單上的雜湊對不上 403,不寄", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: `tok_${"y".repeat(39)}` });
    expect(r.status).toBe(403);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("找不到這次結帳 404", async () => {
    const s = setup();
    expect((await s.call({ kind: "placed", checkout_id: "a9500000-0000-4000-8000-000000000099", token: TOKEN })).status).toBe(404);
  });
});

describe("market-notify:狀態紀錄", () => {
  it("新訂單 → 供應商(閘門開放時寄到店家信箱,附後台連結)", async () => {
    const s = setup({ live: true });
    const r = await s.call({ kind: "event", event_id: EV(1) });
    expect(r.body.data).toMatchObject({ kinds: ["supplier_new"], sent: 1 });
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["store-a@example.com"]);
    expect(msg.html).toContain('href="https://app.ifoodmap.ai/supplier/market/orders"');
  });

  // 審查修正:原本回信給店家(contact_email);第 1 階段定案 contact_email 是收新訂單通知的信箱、不給消費者 → 回信到平台信箱
  it("貨到付款接單 → 消費者;回信到平台信箱(不給店家的 contact_email)", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "event", event_id: EV(2) });
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["buyer@example.com"]);
    expect(msg.subject).toContain("市集測試 A 店 已接單");
    expect(msg.replyTo).toBe("ifoodmaptw@gmail.com");
    // 出貨天數讀自 market_stores.ship_days(A 店 2 天)
    expect(msg.text).toContain("預計 2 個工作天內出貨");
    expect(msg.html).toContain("預計 2 個工作天內出貨");
  });

  it("轉帳訂單:confirmed 不寄,緊接著的 awaiting_payment 寄匯款資訊", async () => {
    const s = setup({ live: true });
    expect((await s.call({ kind: "event", event_id: EV(3) })).body.data).toMatchObject({ skipped: true });
    await s.call({ kind: "event", event_id: EV(4) });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0][0].html).toContain("郵局(700) 帳號 0001234-5678901");
    // 72 小時自動取消:匯款期限 = 這筆待匯款紀錄的 created_at + 72 小時(台北時間)
    for (const body of [s.send.mock.calls[0][0].html, s.send.mock.calls[0][0].text]) {
      expect(body).toContain("請在 2026/10/15 11:00\u{FF08}台北時間\u{FF09}前完成匯款,逾期訂單會自動取消。");
    }
    // 回信一律到平台信箱
    expect(s.send.mock.calls[0][0].replyTo).toBe("ifoodmaptw@gmail.com");
  });

  it("平台取消 → 消費者與供應商各一封;閘門關閉時兩封都寄測試信箱", async () => {
    const s = setup();
    const r = await s.call({ kind: "event", event_id: EV(5) });
    expect(r.body.data).toMatchObject({ kinds: ["consumer_cancelled", "supplier_cancelled_by_platform"], sent: 2 });
    expect(s.send.mock.calls.map((c) => c[0].to[0])).toEqual(["ifoodmaptw@gmail.com", "ifoodmaptw@gmail.com"]);
    expect(s.send.mock.calls[1][0].html).toContain("store-a@example.com");
    expect(s.send.mock.calls[1][0].html).toContain("疑似假單");
  });

  it("出貨信帶物流單號;完成不寄", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "event", event_id: EV(6) });
    expect(s.send.mock.calls[0][0].html).toContain("黑貓宅急便,單號 9001");
    expect((await s.call({ kind: "event", event_id: EV(7) })).body.data).toMatchObject({ skipped: true });
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("供應商沒有聯絡信箱:跳過並記錯誤,仍回 200", async () => {
    const s = setup({ live: true });
    const r = await s.call({ kind: "event", event_id: EV(8) });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ sent: 0, skipped: ["supplier_new"] });
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ kind: "supplier_new" }));
  });

  it("寄信失敗:紀錄標 failed、記錯誤", async () => {
    const s = setup({ live: true, send: async () => ({ ok: false, id: null, error: "Resend 500" }) });
    const r = await s.call({ kind: "event", event_id: EV(2) });
    expect(r.body.data).toMatchObject({ sent: 0, total: 1 });
    expect(s.db.tables.notifications[0]).toMatchObject({ status: "failed", sent_at: null });
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "send", error: "Resend 500" }));
  });

  // 審查追加:資料庫的 subtotal / shipping_fee / total / line_total 各自對到信裡對的標籤(數字都不一樣,對錯欄位一定看得出來)
  it("金額:小計、運費、總額、每一列小計都對到資料庫的欄位(待匯款與下單確認,html 與 text)", async () => {
    const s = setup({ live: true });
    Object.assign(s.db.tables.market_orders.find((o) => o.id === ORDER_B)!, { subtotal: 1234, shipping_fee: 150, total: 1384 });
    s.db.tables.market_order_items = [
      ...s.db.tables.market_order_items.filter((i) => i.order_id !== ORDER_B),
      { order_id: ORDER_B, product_name: "挪威鮭魚", spec: "200g/片", qty: 3, unit_price: 205, line_total: 615 },
      { order_id: ORDER_B, product_name: "白蝦仁", spec: "300g/盒", qty: 1, unit_price: 619, line_total: 619 },
    ];
    await s.call({ kind: "event", event_id: EV(4) }); // 待匯款
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    const [awaiting, placed] = s.send.mock.calls.map((c) => c[0]);
    expect(awaiting.subject).toBe(`請匯款 NT$ 1,384 — 零售訂單 ${formatOrderNo(ORDER_B)}`);
    expect(awaiting.html).toContain("請依下列資訊匯款 NT$ 1,384,");
    expect(awaiting.text).toContain("請匯款 NT$ 1,384:");
    const reEsc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rows: [string, string][] = [
      ["挪威鮭魚(200g/片)× 3", "NT$ 615"],
      ["白蝦仁(300g/盒)× 1", "NT$ 619"],
      ["小計", "NT$ 1,234"],
      ["運費", "NT$ 150"],
      ["總額", "NT$ 1,384"],
    ];
    for (const m of [awaiting, placed]) {
      for (const [label, value] of rows) expect(m.html, label).toMatch(new RegExp(`${reEsc(label)}</td><td[^>]*>${reEsc(value)}</td>`));
      for (const line of ["- 挪威鮭魚(200g/片)× 3:NT$ 615", "- 白蝦仁(300g/盒)× 1:NT$ 619", "小計:NT$ 1,234", "運費:NT$ 150", "總額:NT$ 1,384"]) {
        expect(m.text.split("\n"), line).toContain(line);
      }
    }
  });

  it("店名帶 \\r\\nBcc: …:實際交給寄信的主旨只有一行(閘門開 / 關都一樣)", async () => {
    for (const live of [true, false]) {
      const s = setup({ live });
      s.db.tables.suppliers[0].name = "A 店\r\nBcc: victim@example.com\r\n";
      await s.call({ kind: "event", event_id: EV(2) });
      const subject = s.send.mock.calls[0][0].subject;
      expect(subject).toBe(`${live ? "" : "[測試轉寄] "}A 店 Bcc: victim@example.com 已接單 — 零售訂單 ${formatOrderNo(ORDER_A)}`);
      expect(subject).not.toMatch(/[\r\n]/);
    }
  });

  // 審查追加:店家的 contact_email 是收新訂單通知的信箱(第 1 階段定案),給消費者的信一律不出現;要聯絡店家看店家電話
  it("給消費者的信:html、text、reply_to 都沒有店家的 contact_email,改附店家電話(閘門開 / 關)", async () => {
    for (const live of [true, false]) {
      const s = setup({ live });
      s.db.tables.suppliers[1].contact_email = "store-b@example.com"; // 第 3 輪審查:B 店也有 contact_email,待匯款那封(B 店)才驗得到
      s.db.tables.market_order_events.push(
        { id: EV(9), order_id: ORDER_A, from_status: "pending", to_status: "rejected", actor_role: "supplier", note: "缺貨", payload: {} },
        { id: EV(10), order_id: ORDER_A, from_status: "confirmed", to_status: "cancelled", actor_role: "supplier", note: "無法出貨", payload: {} },
      );
      await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
      for (const id of [EV(2), EV(4), EV(5), EV(6), EV(9), EV(10)]) await s.call({ kind: "event", event_id: id });
      const consumer = s.send.mock.calls.map((c) => c[0]).filter((m) => !m.subject.includes("請不要出貨"));
      expect(consumer, `live=${live}`).toHaveLength(7); // 下單確認、接單、待匯款、平台取消(消費者那封)、出貨、拒單、店家取消
      for (const m of consumer) {
        const label = `live=${live} ${m.subject}`;
        for (const storeEmail of ["store-a@example.com", "store-b@example.com"]) {
          expect(m.html, label).not.toContain(storeEmail);
          expect(m.text, label).not.toContain(storeEmail);
        }
        expect(m.replyTo, label).toBe("ifoodmaptw@gmail.com");
      }
      // A 店有電話:A 店的每一封(含下單確認裡 A 店那段)都附;B 店沒有電話就不寫這一行
      for (const m of consumer.filter((x) => !x.subject.startsWith(`${live ? "" : "[測試轉寄] "}請匯款`))) {
        expect(m.html, m.subject).toContain("店家電話:02-2345-6789");
        expect(m.text, m.subject).toContain("店家電話:02-2345-6789");
      }
      const awaitingB = consumer.find((x) => x.subject.includes("請匯款"))!;
      expect(awaitingB.html).not.toContain("店家電話");
    }
  });

  // 審查追加(新規則):已收款的轉帳單也能取消(paid → cancelled;店家、管理員、系統都能做,原因必填)
  it("已收款的單被取消:消費者的信說明退款由店家處理(附電話、平台不經手款項);管理員 / 系統取消也通知店家", async () => {
    const paidCancel = (id: string, actor: string, orderId = ORDER_A) => ({
      id,
      order_id: orderId,
      from_status: "paid",
      to_status: "cancelled",
      actor_role: actor,
      note: "缺貨無法出貨",
      payload: {},
    });
    const s = setup({ live: true });
    s.db.tables.market_order_events.push(paidCancel(EV(11), "supplier"), paidCancel(EV(12), "admin"), paidCancel(EV(13), "system"));
    Object.assign(s.db.tables.market_orders.find((o) => o.id === ORDER_A)!, { payment_method: "transfer", paid_at: "2026-10-11T03:00:00Z" });
    const kinds: unknown[] = [];
    for (const id of [EV(11), EV(12), EV(13)]) kinds.push((await s.call({ kind: "event", event_id: id })).body.data.kinds);
    expect(kinds).toEqual([
      ["consumer_cancelled"],
      ["consumer_cancelled", "supplier_cancelled_by_platform"],
      ["consumer_cancelled", "supplier_cancelled_by_platform"],
    ]);
    const msgs = s.send.mock.calls.map((c) => c[0]);
    expect(msgs.map((m) => m.to[0])).toEqual(["buyer@example.com", "buyer@example.com", "store-a@example.com", "buyer@example.com", "store-a@example.com"]);
    for (const m of msgs.filter((x) => x.to[0] === "buyer@example.com")) {
      expect(m.text).toContain("退款由店家處理,請直接聯絡店家(店家電話:02-2345-6789)");
      expect(m.text).toContain("iFoodmap 平台不經手款項");
      expect(m.html).toContain("iFoodmap 平台不經手款項");
    }
    // 只看紀錄的 from_status 也算(paid_at 沒帶到的情況)
    const s2 = setup({ live: true });
    s2.db.tables.market_order_events.push(paidCancel(EV(11), "supplier"));
    await s2.call({ kind: "event", event_id: EV(11) });
    expect(s2.send.mock.calls[0][0].text).toContain("退款由店家處理");
    // 只看訂單的 paid_at 也算(現在的轉移表只有 paid → cancelled,之後若開放別的狀態取消已收款的單也不會漏)
    const s4 = setup({ live: true });
    Object.assign(s4.db.tables.market_orders.find((o) => o.id === ORDER_A)!, { paid_at: "2026-10-11T03:00:00Z" });
    await s4.call({ kind: "event", event_id: EV(5) }); // from_status = pending
    expect(s4.send.mock.calls[0][0].text).toContain("退款由店家處理");
    // 還沒收款的取消不變
    const s3 = setup({ live: true });
    await s3.call({ kind: "event", event_id: EV(5) });
    expect(s3.send.mock.calls[0][0].text).toContain("如果已經匯款,請直接聯絡店家退款。");
  });

  // 審查追加:notifications 寫入失敗要記 log(經過遮 token 的 log),但不影響寄信結果
  it("notifications 寫入失敗:照樣算寄出,記一筆 log;下單確認那條 log 也會遮 token", async () => {
    const failWith = (message: string): FakeDbOptions["fail"] => (table, op) => (table === "notifications" && op === "insert" ? { message } : undefined);
    const s1 = setup({ fail: failWith("insert denied") });
    const r1 = await s1.call({ kind: "event", event_id: EV(2) });
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ sent: 1, total: 1 });
    expect(s1.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "notifications", audience: "consumer", error: "insert denied" }));
    // 下單確認:就算錯誤訊息夾帶了連結,log 也看不到 token(這條 log 走 redactLog)
    const s2 = setup({ fail: failWith(`insert denied near https://app.ifoodmap.ai/market/orders/${TOKEN}`) });
    const r2 = await s2.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r2.body.data).toMatchObject({ sent: 1, total: 1 });
    expect(s2.send).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(s2.log.mock.calls);
    expect(logged).toContain('"step":"notifications"');
    expect(logged).toContain("/market/orders/***");
    expect(logged).not.toContain(TOKEN.slice(0, 8));
  });

  // 第 3 輪審查:notifications 寫入失敗的 log 只記原因,不帶整列(列裡有收件信箱)
  it("notifications 寫入失敗(平台取消兩封):兩封照寄、sent 2;log 沒有任何 Email", async () => {
    const s = setup({ live: true, fail: (table, op) => (table === "notifications" && op === "insert" ? { message: "permission denied for table notifications" } : undefined) });
    const r = await s.call({ kind: "event", event_id: EV(5) });
    expect(r.body.data).toMatchObject({ sent: 2, total: 2 });
    const logs = s.log.mock.calls.filter((c) => c[1].step === "notifications");
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toMatch(/@/);
  });

  // 審查追加:同一封信重送(pg_net 重送、有人重放)時 Resend 只寄一次 —— 每封信帶 Idempotency-Key
  it("每封信帶 Idempotency-Key:狀態信 market-notify:<event_id>:<收件對象>,下單確認 market-notify:placed:<checkout_id>", async () => {
    const s = setup();
    await s.call({ kind: "event", event_id: EV(5) }); // 平台取消 → 消費者 + 店家
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    await s.call({ kind: "event", event_id: EV(5) }); // 同一個事件重送
    const keys = s.send.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys).toEqual([
      `market-notify:${EV(5)}:consumer`,
      `market-notify:${EV(5)}:supplier`,
      `market-notify:placed:${CHECKOUT}`,
      `market-notify:${EV(5)}:consumer`,
      `market-notify:${EV(5)}:supplier`,
    ]);
    expect(keys[0]).not.toBe(keys[1]); // 同一個事件、兩種收件人的 key 不同
    expect(keys.join(" ")).not.toContain(TOKEN); // 下單確認用結帳 id,不用 token
  });

  // 審查追加:收件 Email 不能寄時,除了跳過,也要記 log(Email 遮罩)與一筆「沒寄」的 notifications
  // (notifications.status 只收 sent / failed / pending → 記成 failed,原因寫在 message)
  it("買家 Email 格式不對:下單確認與狀態信都不寄,記 log(遮罩)與「沒寄」紀錄", async () => {
    const s = setup({ live: true });
    for (const o of s.db.tables.market_orders) o.buyer_email = "王小明<buyer@example.com>";
    const r1 = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r1.body.data).toMatchObject({ skipped: true });
    expect(r1.text).not.toContain("buyer@example.com"); // 回應會存在 net._http_response,不能帶出 Email
    const r2 = await s.call({ kind: "event", event_id: EV(2) });
    expect(r2.text).not.toContain("buyer@example.com");
    expect(r2.body.data).toMatchObject({ sent: 0, skipped: ["consumer_confirmed"] });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.db.tables.notifications).toHaveLength(2);
    for (const n of s.db.tables.notifications) {
      expect(n).toMatchObject({ recipient: "王***@exa…", channel: "email", status: "failed", sent_at: null });
      expect(String(n.message)).toContain("(沒寄:買家 Email 格式不對)");
    }
    expect(s.db.tables.notifications[0].title).toBe("訂單已送出(共 2 家店)— iFoodmap 食材市集");
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "placed", recipient: "王***@exa…" }));
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "event", kind: "consumer_confirmed", recipient: "王***@exa…" }));
    // 帳號部分只留第一個字
    expect(JSON.stringify(s.log.mock.calls) + JSON.stringify(s.db.tables.notifications)).not.toContain("小明<buyer");
  });

  // 第 3 輪審查:原本保留 @ 之後最多 100 字,店家的 contact_email 沒有格式限制,亂填的地址、電話會留在 log
  it("maskEmail:帳號只留第一個字、網域只留前 3 個字", () => {
    expect(maskEmail("王小明<buyer@example.com>")).toBe("王***@exa…");
    expect(maskEmail("a@b@台北市信義區市府路 1 號 王小明 0912-345-678")).toBe("a***@台北市…");
    expect(maskEmail("0912345678")).toBe("0***");
    expect(maskEmail("x@ab")).toBe("x***@ab");
    expect(maskEmail("\u{1F600}x@example.com")).toBe("\u{1F600}***@exa…");
    expect(maskEmail("")).toBeNull();
  });

  it("店家把地址、電話填進聯絡信箱:log 與「沒寄」紀錄只留很短一段", async () => {
    const s = setup({ live: true });
    s.db.tables.suppliers[0].contact_email = "a@b@台北市信義區市府路 1 號 王小明 0912-345-678";
    await s.call({ kind: "event", event_id: EV(1) });
    expect(s.db.tables.notifications[0]).toMatchObject({ recipient: "a***@台北市…", status: "failed" });
    const dump = JSON.stringify(s.log.mock.calls) + JSON.stringify(s.db.tables.notifications);
    for (const leak of ["信義區", "市府路", "0912", "王小明 "]) expect(dump, leak).not.toContain(leak);
  });

  // 第 3 輪審查:閘門關著時,Email 不合格的收件人也不能「轉寄到測試信箱」了事 —— 一樣跳過、留「沒寄」紀錄
  it("閘門關閉時 Email 不合格:一樣不寄(不轉寄測試信箱)、留「沒寄」紀錄", async () => {
    const s = setup();
    for (const o of s.db.tables.market_orders) o.buyer_email = "王小明<buyer@example.com>";
    s.db.tables.suppliers[0].contact_email = "sales.example.com";
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    for (const id of [EV(1), EV(2), EV(5)]) await s.call({ kind: "event", event_id: id });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.db.tables.notifications.map((n) => n.status)).toEqual(["failed", "failed", "failed", "failed", "failed"]);
    expect(s.db.tables.notifications.every((n) => String(n.message).includes("(沒寄:"))).toBe(true);
  });

  it("店家聯絡信箱格式不對(不是空的):跳過、記 log 與「沒寄」紀錄;沒有填的也留紀錄", async () => {
    const s = setup({ live: true });
    s.db.tables.suppliers[0].contact_email = "sales.example.com";
    const r = await s.call({ kind: "event", event_id: EV(1) });
    expect(r.body.data).toMatchObject({ sent: 0, skipped: ["supplier_new"] });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ kind: "supplier_new", recipient: "s***" }));
    expect(s.db.tables.notifications[0]).toMatchObject({ recipient: "s***", status: "failed" });
    expect(String(s.db.tables.notifications[0].message)).toContain("(沒寄:店家聯絡信箱格式不對)");
    await s.call({ kind: "event", event_id: EV(8) }); // B 店沒有填
    expect(s.db.tables.notifications[1]).toMatchObject({ recipient: null, status: "failed" });
    expect(String(s.db.tables.notifications[1].message)).toContain("(沒寄:店家沒有填聯絡信箱)");
  });

  it("系統取消也通知店家不要出貨(跟管理員取消一樣)", async () => {
    const s = setup({ live: true });
    s.db.tables.market_order_events.push({ id: EV(14), order_id: ORDER_A, from_status: "pending", to_status: "cancelled", actor_role: "system", note: "逾時未接單", payload: {} });
    const r = await s.call({ kind: "event", event_id: EV(14) });
    expect(r.body.data).toMatchObject({ kinds: ["consumer_cancelled", "supplier_cancelled_by_platform"], sent: 2 });
    expect(s.send.mock.calls.map((c) => c[0].to[0])).toEqual(["buyer@example.com", "store-a@example.com"]);
    expect(s.send.mock.calls[1][0].subject).toContain("請不要出貨");
  });

  it("請求內容帶 live: true 也打不開閘門(只看 MARKET_NOTIFY_LIVE)", async () => {
    const s = setup();
    await s.call({ kind: "event", event_id: EV(2), live: true });
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN, live: true });
    expect(s.send.mock.calls.map((c) => c[0].to[0])).toEqual(["ifoodmaptw@gmail.com", "ifoodmaptw@gmail.com"]);
  });

  it("同一次結帳的訂單雜湊不一致(不應該發生):只要有一張對不上就 403、不寄", async () => {
    const s = setup();
    s.db.tables.market_orders[1].lookup_token_hash = "0".repeat(64);
    expect((await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN })).status).toBe(403);
    expect(s.send).not.toHaveBeenCalled();
  });

  // 第 3 輪審查:handler 層沒有跑過「轉帳單還沒付款就取消」,fixture 的訂單又沒有 paid_at 這個欄位(正式庫回來的是 null)
  // —— 判斷改成 order.paid_at !== undefined 也全綠,上線後每張取消的單都會說「店家已確認收款」
  it("退款句只在已收款:貨到付款取消、轉帳單在 pending / confirmed / awaiting_payment 取消都沒有;paid → cancelled 才有", async () => {
    const REFUND = /已確認收款|退款由店家處理|不經手款項/;
    const cancel = (id: string, orderId: string, from: string, actor: string) => ({
      id,
      order_id: orderId,
      from_status: from,
      to_status: "cancelled",
      actor_role: actor,
      note: "取消原因",
      payload: {},
    });
    const s = setup({ live: true });
    s.db.tables.market_order_events.push(
      cancel(EV(21), ORDER_A, "pending", "supplier"), // 貨到付款、店家取消
      cancel(EV(22), ORDER_A, "confirmed", "admin"), // 貨到付款、平台取消
      cancel(EV(23), ORDER_B, "pending", "admin"), // 轉帳、還沒接單
      cancel(EV(24), ORDER_B, "confirmed", "supplier"), // 轉帳、剛接單
      cancel(EV(25), ORDER_B, "awaiting_payment", "system"), // 轉帳、等匯款
    );
    const consumerMail = async (id: string) => {
      const before = s.send.mock.calls.length;
      await s.call({ kind: "event", event_id: id });
      const mine = s.send.mock.calls.slice(before).map((c) => c[0]).filter((m) => m.to[0] === "buyer@example.com");
      expect(mine, id).toHaveLength(1);
      return mine[0];
    };
    for (const id of [EV(21), EV(22), EV(23), EV(24), EV(25)]) {
      const m = await consumerMail(id);
      expect(`${m.html}\n${m.text}`, id).not.toMatch(REFUND);
      expect(m.text, id).toContain("如果已經匯款,請直接聯絡店家退款。");
    }
    // paid → cancelled:套用狀態之後,訂單上有 paid_at
    Object.assign(s.db.tables.market_orders.find((o) => o.id === ORDER_B)!, { paid_at: "2026-10-11T03:00:00Z" });
    s.db.tables.market_order_events.push(cancel(EV(26), ORDER_B, "paid", "supplier"));
    const paid = await consumerMail(EV(26));
    expect(paid.text).toMatch(/已確認收款,退款由店家處理/);
    expect(paid.html).toMatch(/iFoodmap 平台不經手款項/);
  });

  // 2026-10-12 業主決定:72 小時自動取消(migration 20261012100000 的 market_expire_orders 由系統寫取消紀錄,payload 帶 auto_expire)
  it("72 小時自動取消:消費者與店家都收到寫明「自動取消」的信;沒有標記(或標記不認得)的系統取消照舊", async () => {
    const s = setup({ live: true });
    s.db.tables.suppliers[1].contact_email = "store-b@example.com";
    const sysCancel = (id: string, orderId: string, from: string, note: string, payload: Row) => ({
      id,
      order_id: orderId,
      from_status: from,
      to_status: "cancelled",
      actor_role: "system",
      note,
      payload,
    });
    s.db.tables.market_order_events.push(
      sysCancel(EV(31), ORDER_A, "pending", "店家超過 72 小時沒有接單,系統自動取消", { auto_expire: "pending" }),
      sysCancel(EV(32), ORDER_B, "awaiting_payment", "超過 72 小時沒有完成匯款,系統自動取消", { auto_expire: "awaiting_payment" }),
      sysCancel(EV(33), ORDER_A, "pending", "系統取消", {}),
      sysCancel(EV(34), ORDER_A, "pending", "系統取消", { auto_expire: "shipped" }),
    );
    const mailsOf = async (id: string) => {
      const before = s.send.mock.calls.length;
      const r = await s.call({ kind: "event", event_id: id });
      return { data: r.body.data, msgs: s.send.mock.calls.slice(before).map((c) => c[0]) };
    };
    const p = await mailsOf(EV(31));
    expect(p.data).toMatchObject({ kinds: ["consumer_cancelled", "supplier_cancelled_by_platform"], sent: 2 });
    expect(p.msgs.map((m) => m.to[0])).toEqual(["buyer@example.com", "store-a@example.com"]);
    expect(p.msgs[0].subject).toBe(`訂單已自動取消(店家逾時未接單)— 零售訂單 ${formatOrderNo(ORDER_A)}`);
    expect(p.msgs[1].subject).toBe(`零售訂單 ${formatOrderNo(ORDER_A)} 已逾時自動取消 — 請不要出貨`);
    for (const body of [p.msgs[0].html, p.msgs[0].text]) expect(body).toContain("店家超過 72 小時沒有接單,訂單已自動取消。");
    for (const body of [p.msgs[1].html, p.msgs[1].text]) expect(body).toContain("這張訂單超過 72 小時沒有接單,系統因逾時自動取消。");
    const a = await mailsOf(EV(32));
    expect(a.msgs.map((m) => m.to[0])).toEqual(["buyer@example.com", "store-b@example.com"]);
    expect(a.msgs[0].subject).toBe(`訂單已自動取消(逾時未完成匯款)— 零售訂單 ${formatOrderNo(ORDER_B)}`);
    for (const body of [a.msgs[0].html, a.msgs[0].text]) expect(body).toContain("因為超過 72 小時沒有完成匯款,訂單已自動取消。");
    for (const body of [a.msgs[1].html, a.msgs[1].text]) expect(body).toContain("消費者超過 72 小時沒有完成匯款,系統因逾時自動取消。");
    for (const m of [...p.msgs, ...a.msgs]) {
      const all = `${m.subject}\n${m.html}\n${m.text}`;
      expect(all, m.subject).not.toContain("店家取消");
      expect(all, m.subject).not.toMatch(/退款|已確認收款|不經手款項/); // 待匯款被取消的單一定還沒收款(paid_at: null、from_status 不是 paid)
    }
    for (const m of [...p.msgs, ...a.msgs].filter((x) => x.subject.startsWith("零售訂單"))) expect(m.text).toContain("庫存已經自動補回");
    for (const m of [p.msgs[0], a.msgs[0]]) {
      for (const storeEmail of ["store-a@example.com", "store-b@example.com"]) expect(`${m.html}${m.text}`).not.toContain(storeEmail);
      expect(m.replyTo).toBe("ifoodmaptw@gmail.com");
    }
    // 沒有標記、或標記不是 pending / awaiting_payment:照一般的平台取消
    for (const id of [EV(33), EV(34)]) {
      const n = await mailsOf(id);
      expect(n.msgs.map((m) => m.subject)).toEqual([`訂單已取消 — 零售訂單 ${formatOrderNo(ORDER_A)}`, `平台已取消零售訂單 ${formatOrderNo(ORDER_A)} — 請不要出貨`]);
    }
  });

  // 2026-10-12:Resend 預設每秒只收 2 個請求;send.ts 遇到 429 / 5xx / 連線失敗會重試,handler 記每次重試(只有狀態碼與第幾次)
  const resend = (statuses: number[]) => {
    const keys: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      const status = statuses[Math.min(keys.length - 1, statuses.length - 1)];
      return new Response(status === 200 ? '{"id":"re_ok"}' : '{"name":"rate_limit_exceeded"}', { status });
    }) as typeof fetch;
    const waits: number[] = [];
    const send = createMarketResendSender("re_key", fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    });
    return { keys, waits, send };
  };

  it("寄信被限速兩次後成功:同一個 key 送三次、記兩筆重試 log(只有狀態碼與第幾次)、notifications 記 sent", async () => {
    const r = resend([429, 429, 200]);
    const s = setup({ live: true, send: r.send });
    const res = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(res.body.data).toMatchObject({ sent: 1, total: 1 });
    expect(r.keys).toEqual(Array(3).fill(`market-notify:placed:${CHECKOUT}`));
    expect(r.waits).toEqual([700, 1500]);
    expect(s.db.tables.notifications.map((n) => n.status)).toEqual(["sent"]);
    expect(s.log.mock.calls.filter((c) => c[1].step === "send-retry")).toEqual([
      ["info", { fn: "market-notify", step: "send-retry", audience: "consumer", status: 429, attempt: 1 }],
      ["info", { fn: "market-notify", step: "send-retry", audience: "consumer", status: 429, attempt: 2 }],
    ]);
    expect(s.log.mock.calls.filter((c) => c[1].step === "send")).toEqual([]);
  });

  it("寄信一直被限速:重試 3 次後照原本的方式記 failed 與錯誤", async () => {
    const r = resend([429]);
    const s = setup({ live: true, send: r.send });
    const res = await s.call({ kind: "event", event_id: EV(2) });
    expect(res.body.data).toMatchObject({ sent: 0, total: 1 });
    expect(r.keys).toHaveLength(4);
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000); // 壓在 pg_net 的 8 秒逾時以內
    expect(s.db.tables.notifications[0]).toMatchObject({ status: "failed", sent_at: null });
    expect(s.log.mock.calls.filter((c) => c[1].step === "send-retry").map((c) => c[1].attempt)).toEqual([1, 2, 3]);
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "send", error: 'Resend 429: {"name":"rate_limit_exceeded"}' }));
  });

  it("一次結帳 3 家店:下單確認 + 3 封新訂單信同時送、Resend 每秒只收 2 封 → 4 封都記成 sent,每封總等待不超過 5 秒(假的 timer)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      // 假的 Resend:每一秒最多收 2 封,超過回 429(限速以秒計算)
      const accepted: { key: string; at: number }[] = [];
      let rejected = 0;
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const now = Date.now();
        const key = (init?.headers as Record<string, string>)["Idempotency-Key"];
        if (accepted.filter((a) => Math.floor(a.at / 1000) === Math.floor(now / 1000)).length >= 2) {
          rejected += 1;
          return new Response('{"name":"rate_limit_exceeded"}', { status: 429 });
        }
        accepted.push({ key, at: now });
        return new Response(JSON.stringify({ id: `re_${accepted.length}` }), { status: 200 });
      }) as typeof fetch;
      // 每封信各自記下等了多久(真的重試邏輯,等待走假的 setTimeout)
      const waits = new Map<string, number>();
      const send: MarketSendMail = (msg) =>
        createMarketResendSender("re_key", fetchImpl, {
          random: () => 0.5,
          sleep: (ms) => {
            waits.set(msg.idempotencyKey, (waits.get(msg.idempotencyKey) ?? 0) + ms);
            return new Promise<void>((done) => setTimeout(done, ms));
          },
        })(msg);
      const s = setup({ live: true, send });
      // 第三家店 C,跟 A、B 同一次結帳;三家店都有聯絡信箱
      const SUP_C = "a9200000-0000-4000-8000-00000000000c";
      const ORDER_C = "a9600000-0000-4000-8000-0000000000c1";
      s.db.tables.suppliers[1].contact_email = "store-b@example.com";
      s.db.tables.suppliers.push({ id: SUP_C, name: "市集測試 C 店", contact_email: "store-c@example.com", phone: null });
      s.db.tables.market_stores.push({ supplier_id: SUP_C, ship_days: 1 });
      s.db.tables.market_orders.push(order({ id: ORDER_C, supplier_id: SUP_C, subtotal: 300, shipping_fee: 0, total: 300 }));
      s.db.tables.market_order_items.push({ order_id: ORDER_C, product_name: "土雞蛋", spec: "10 顆", qty: 1, unit_price: 300, line_total: 300 });
      s.db.tables.market_order_events.push({ id: EV(40), order_id: ORDER_C, from_status: null, to_status: "pending", actor_role: "consumer", note: null, payload: {} });

      const started = Date.now();
      const finished: number[] = [];
      let done = false;
      const all = Promise.all(
        [
          { kind: "placed", checkout_id: CHECKOUT, token: TOKEN },
          { kind: "event", event_id: EV(1) },
          { kind: "event", event_id: EV(8) },
          { kind: "event", event_id: EV(40) },
        ].map((body) =>
          s.call(body).then((r) => {
            finished.push(Date.now() - started);
            return r;
          }),
        ),
      ).finally(() => {
        done = true;
      });
      const yieldReal = () => new Promise<void>((resolve) => setImmediate(resolve)); // 驗密鑰、算雜湊的 crypto 是真的非同步
      // 假的時鐘停在同一刻,等 4 封信都送到假的 Resend
      for (let i = 0; i < 2000 && accepted.length + rejected < 4; i += 1) await yieldReal();
      expect(accepted.length + rejected).toBe(4);
      expect(rejected).toBe(2); // 同一秒只收 2 封,另外 2 封被回 429
      // 一次推 50 毫秒,中間讓真的非同步跑完
      for (let step = 0; step < 120 && !done; step += 1) {
        await vi.advanceTimersByTimeAsync(50);
        for (let i = 0; i < 20; i += 1) await yieldReal();
      }
      const results = await all;
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(results.map((r) => r.body.data.sent)).toEqual([1, 1, 1, 1]);
      expect(s.db.tables.notifications.map((n) => n.status)).toEqual(["sent", "sent", "sent", "sent"]);
      expect(accepted.map((a) => a.key).sort()).toEqual(
        [`market-notify:placed:${CHECKOUT}`, `market-notify:${EV(1)}:supplier`, `market-notify:${EV(8)}:supplier`, `market-notify:${EV(40)}:supplier`].sort(),
      );
      for (const [key, ms] of waits) expect(ms, key).toBeLessThanOrEqual(5_000);
      for (const ms of finished) expect(ms).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- 第 3 階段審查:一次呼叫(一個 pg_net 請求)裡的信共用一個 5 秒的等待額度,整次呼叫落在 pg_net 的 8 秒逾時以內 ----
  /** 用假的 timer 推時間;每推 50 毫秒前先讓真的非同步(驗密鑰、算雜湊的 crypto)跑完 */
  const drive = async (isDone: () => boolean, maxMs = 12_000) => {
    const yieldReal = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (let t = 0; t <= maxMs && !isDone(); t += 50) {
      for (let i = 0; i < 30; i += 1) await yieldReal();
      if (isDone()) break;
      await vi.advanceTimersByTimeAsync(50);
    }
  };
  /** 假的 Resend:到達時依「這一秒已經收了幾個」決定收或回 429,回應要等 latencyMs(假的 timer) */
  const fakeResend = (perSecond: number, latencyMs: number) => {
    const accepted: { key: string; at: number }[] = [];
    const rejected: { key: string; at: number }[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const at = Date.now();
      const key = (init?.headers as Record<string, string>)["Idempotency-Key"];
      const ok = accepted.filter((a) => Math.floor(a.at / 1000) === Math.floor(at / 1000)).length < perSecond;
      (ok ? accepted : rejected).push({ key, at });
      await new Promise<void>((done) => setTimeout(done, latencyMs));
      return ok
        ? new Response(JSON.stringify({ id: `re_${accepted.length}` }), { status: 200 })
        : new Response('{"name":"rate_limit_exceeded"}', { status: 429 });
    }) as typeof fetch;
    return { fetchImpl, accepted, rejected };
  };
  /** 每封信各自建寄信包裝(真的重試邏輯,等待走假的 setTimeout),記下每個 key 等了多久 */
  const timedSender = (fetchImpl: typeof fetch, random: () => number) => {
    const waits = new Map<string, number>();
    const send: MarketSendMail = (msg) =>
      createMarketResendSender("re_key", fetchImpl, {
        random,
        sleep: (ms) => {
          waits.set(msg.idempotencyKey, (waits.get(msg.idempotencyKey) ?? 0) + ms);
          return new Promise<void>((done) => setTimeout(done, ms));
        },
      })(msg);
    return { send, waits };
  };

  it("同一次呼叫的信共用一個 5 秒額度:平台取消(兩封)遇到 Resend 一直 429,整次呼叫的等待加起來不超過 5 秒", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const fetchImpl = (async () => new Response('{"name":"rate_limit_exceeded"}', { status: 429 })) as unknown as typeof fetch;
      const t = timedSender(fetchImpl, () => 0.5);
      const s = setup({ live: true, send: t.send });
      const started = Date.now();
      let elapsed = -1;
      const pending = s.call({ kind: "event", event_id: EV(5) }).then((r) => {
        elapsed = Date.now() - started;
        return r;
      });
      await drive(() => elapsed >= 0);
      const r = await pending;
      expect(r.body.data).toMatchObject({ sent: 0, total: 2 });
      expect([...t.waits.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000); // 兩封加起來(原本每封各 5 秒,共 10 秒)
      expect(elapsed).toBeLessThanOrEqual(5_000);
      expect(s.db.tables.notifications.map((n) => n.status)).toEqual(["failed", "failed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // 第 3 階段審查 M6
  it("連線失敗後重試、Resend 回 409:記 failed,message 寫清楚第一次可能已經寄出;其他 409 照原本", async () => {
    let n = 0;
    const flaky = (async () => {
      n += 1;
      if (n === 1) throw new TypeError("connection reset");
      return new Response('{"name":"concurrent_idempotent_requests"}', { status: 409 });
    }) as unknown as typeof fetch;
    const s = setup({ live: true, send: createMarketResendSender("re_key", flaky, { sleep: async () => undefined, random: () => 0 }) });
    await s.call({ kind: "event", event_id: EV(2) });
    expect(s.db.tables.notifications[0]).toMatchObject({ status: "failed", sent_at: null });
    expect(String(s.db.tables.notifications[0].message)).toContain("(重試時 Resend 回 409,第一次可能已經寄出,人工補寄前請先確認收件人沒收到)");
    const conflict = (async () => new Response('{"name":"invalid_idempotent_request"}', { status: 409 })) as unknown as typeof fetch;
    const s2 = setup({ live: true, send: createMarketResendSender("re_key", conflict, { sleep: async () => undefined }) });
    await s2.call({ kind: "event", event_id: EV(2) });
    expect(s2.db.tables.notifications[0]).toMatchObject({ status: "failed" });
    expect(String(s2.db.tables.notifications[0].message)).not.toContain("第一次可能已經寄出");
  });

  // 部署前審查 m2:502、504(Resend 那邊可能還在處理)、請求逾時之後回 409,也一樣可能已經寄出
  it("502、504、逾時之後重試回 409:一樣記 failed,message 寫清楚第一次可能已經寄出", async () => {
    const conflict = () => new Response('{"name":"concurrent_idempotent_requests"}', { status: 409 });
    const cases: [string, (n: number, init?: RequestInit) => Response][] = [
      ["502", (n) => (n === 1 ? new Response("bad gateway", { status: 502 }) : conflict())],
      ["504", (n) => (n === 1 ? new Response("gateway timeout", { status: 504 }) : conflict())],
      [
        "逾時",
        (_n, init) => {
          if (init?.signal?.aborted) throw init.signal.reason; // 跟真的 fetch 一樣:signal 中止就丟出原因
          return conflict();
        },
      ],
    ];
    for (const [label, respond] of cases) {
      let n = 0;
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => respond(++n, init)) as typeof fetch;
      let made = 0;
      // 「逾時」:第一個請求的逾時 signal 已經中止(假的逾時,不用真的等)
      const timeoutSignal = (ms: number) =>
        ++made === 1 && label === "逾時" ? AbortSignal.abort(new DOMException(`${ms} ms`, "TimeoutError")) : new AbortController().signal;
      const s = setup({ live: true, send: createMarketResendSender("re_key", fetchImpl, { sleep: async () => undefined, random: () => 0, timeoutSignal }) });
      const r = await s.call({ kind: "event", event_id: EV(2) });
      expect(r.body.data, label).toMatchObject({ sent: 0, total: 1 });
      expect(n, label).toBe(2);
      expect(s.db.tables.notifications[0], label).toMatchObject({ status: "failed", sent_at: null });
      expect(String(s.db.tables.notifications[0].message), label).toContain("(重試時 Resend 回 409,第一次可能已經寄出,人工補寄前請先確認收件人沒收到)");
    }
  });

  // 部署前審查 m1:截止時間只管「等多久再重試」;已經送出、還在等回應的請求也要有逾時,Resend 很慢時整次呼叫才會在 8 秒內
  it("Resend 每個請求要 2 秒、一直 429:平台取消(兩封)整次呼叫不超過 7 秒、每個請求不超過 3 秒,兩封記 failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const spans: number[] = [];
      // 每個請求 2 秒才回 429;signal 中止時跟真的 fetch 一樣丟出原因(index.ts 用預設的 AbortSignal.timeout,這裡也是)
      const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const start = Date.now();
          const signal = init?.signal;
          const timer = setTimeout(() => {
            spans.push(Date.now() - start);
            resolve(new Response('{"name":"rate_limit_exceeded"}', { status: 429 }));
          }, 2_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              spans.push(Date.now() - start);
              reject(signal.reason);
            },
            { once: true },
          );
        })) as typeof fetch;
      const t = timedSender(fetchImpl, () => 0.999);
      const s = setup({ live: true, send: t.send });
      const started = Date.now();
      let elapsed = -1;
      const pending = s.call({ kind: "event", event_id: EV(5) }).then((r) => {
        elapsed = Date.now() - started;
        return r;
      });
      await drive(() => elapsed >= 0);
      const r = await pending;
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ sent: 0, total: 2 });
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThanOrEqual(7_000); // 沒有逾時時是 9 秒(第一封 7 秒、第二封 2 秒),超過 pg_net 的 8 秒
      expect(spans.length).toBeGreaterThanOrEqual(3);
      for (const ms of spans) expect(ms).toBeLessThanOrEqual(3_000);
      expect([...t.waits.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000);
      expect(s.db.tables.notifications.map((n) => n.status)).toEqual(["failed", "failed"]);
      expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "send", error: "Resend 請求逾時(1000 毫秒沒有回應)" }));
    } finally {
      vi.useRealTimers();
    }
  });

  /** 可重現的亂數(mulberry32) */
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  it.each([
    ["沒有抖動", () => 0],
    ["抖動一半", () => 0.5],
    ["抖動最大", () => 0.999],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((seed) => [`亂數 seed ${seed}`, seeded(seed)] as [string, () => number]),
  ])("模擬:Resend 每秒只收 2 個請求、每個請求 0.3 秒;3 張單同時被取消(6 封信、3 次呼叫)— %s", async (_label, random) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const resend = fakeResend(2, 300);
      const t = timedSender(resend.fetchImpl, random);
      const s = setup({ live: true, send: t.send });
      // 第三家店 C;三家店都有聯絡信箱;三張單同一刻被系統自動取消(待接單逾時)
      const SUP_C = "a9200000-0000-4000-8000-00000000000c";
      const ORDER_C = "a9600000-0000-4000-8000-0000000000c1";
      s.db.tables.suppliers[1].contact_email = "store-b@example.com";
      s.db.tables.suppliers.push({ id: SUP_C, name: "市集測試 C 店", contact_email: "store-c@example.com", phone: null });
      s.db.tables.market_stores.push({ supplier_id: SUP_C, ship_days: 1 });
      s.db.tables.market_orders.push(order({ id: ORDER_C, supplier_id: SUP_C, subtotal: 300, shipping_fee: 0, total: 300 }));
      s.db.tables.market_order_items.push({ order_id: ORDER_C, product_name: "土雞蛋", spec: "10 顆", qty: 1, unit_price: 300, line_total: 300 });
      const events = [
        [EV(51), ORDER_A],
        [EV(52), ORDER_B],
        [EV(53), ORDER_C],
      ] as const;
      for (const [id, orderId] of events) {
        s.db.tables.market_order_events.push({
          id,
          order_id: orderId,
          from_status: "pending",
          to_status: "cancelled",
          actor_role: "system",
          note: "店家超過 72 小時沒有接單,系統自動取消",
          payload: { auto_expire: "pending" },
        });
      }
      const started = Date.now();
      const elapsed: Record<string, number> = {};
      const all = Promise.all(
        events.map(([id]) =>
          s.call({ kind: "event", event_id: id }).then((r) => {
            elapsed[id] = Date.now() - started;
            return r;
          }),
        ),
      );
      await drive(() => Object.keys(elapsed).length === 3);
      const results = await all;
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      for (const [id] of events) {
        expect(elapsed[id], `${id} 整次呼叫`).toBeLessThan(8_000); // pg_net 的逾時
        const waited = (t.waits.get(`market-notify:${id}:consumer`) ?? 0) + (t.waits.get(`market-notify:${id}:supplier`) ?? 0);
        expect(waited, `${id} 等待`).toBeLessThanOrEqual(5_000);
      }
      expect(resend.rejected.length).toBeGreaterThan(0); // 真的碰到限速
      const statuses = s.db.tables.notifications.map((n) => n.status);
      expect(statuses).toHaveLength(6);
      expect(statuses.filter((x) => x === "sent")).toHaveLength(6); // 6 封都記成 sent
    } finally {
      vi.useRealTimers();
    }
  });

  it("讀資料庫失敗 500(不洩漏細節)", async () => {
    const s = setup({ fail: (table) => (table === "market_orders" ? { message: "boom" } : undefined) });
    const r = await s.call({ kind: "event", event_id: EV(1) });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("boom");
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ error: "boom" }));
  });
});

describe("讀取的欄位都存在於 migration", () => {
  const migration = (file: string) => readFileSync(resolve(__dirname, `../../migrations/${file}`), "utf8");
  const tableBlock = (sql: string, name: string) => {
    const found = new RegExp(`CREATE TABLE (IF NOT EXISTS )?public\\.${name} \\(`).exec(sql);
    expect(found, name).not.toBeNull();
    const start = found!.index;
    return sql.slice(start, sql.indexOf("\n);", start));
  };
  // 第 3 輪審查追加 suppliers、market_stores、market_store_transfer(定義在更早的 migration;之後沒有改名或刪欄位)
  it.each([
    ["market_orders", ORDER_COLUMNS, "20261009130000_market_orders.sql"],
    ["market_order_items", ITEM_COLUMNS, "20261009130000_market_orders.sql"],
    ["market_order_events", EVENT_COLUMNS, "20261009130000_market_orders.sql"],
    ["suppliers", SUPPLIER_COLUMNS, "20260528233000_core_supply_schema.sql"],
    ["market_stores", STORE_COLUMNS, "20261009120000_market_catalog.sql"],
    ["market_store_transfer", TRANSFER_COLUMNS, "20261009120000_market_catalog.sql"],
  ])("%s", (table, columns, file) => {
    const block = tableBlock(migration(file), table);
    for (const col of columns.split(",").map((c) => c.trim())) {
      expect(block, `${table}.${col}`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
  });

  it("寫進 notifications 的欄位也都存在(寄出、寄信失敗、沒寄三種紀錄)", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "event", event_id: EV(2) }); // 寄出
    await s.call({ kind: "event", event_id: EV(8) }); // 沒寄(B 店沒有聯絡信箱)
    const failing = setup({ live: true, send: async () => ({ ok: false, id: null, error: "Resend 500" }) });
    await failing.call({ kind: "event", event_id: EV(2) }); // 寄信失敗
    const rows = [...s.db.tables.notifications, ...failing.db.tables.notifications];
    expect(rows.map((n) => n.status)).toEqual(["sent", "failed", "failed"]);
    const block = tableBlock(migration("20260704140000_transaction_and_ops_tables.sql"), "notifications");
    for (const key of new Set(rows.flatMap((n) => Object.keys(n)))) expect(block, `notifications.${key}`).toMatch(new RegExp(`\\n\\s+${key}\\s`));
  });
});

// ---------------------------------------------------------------------
// 派工追加(2026-10-11):閘門與 token 走完整條路徑
// ---------------------------------------------------------------------

/** 跟 index.ts 一樣:每次請求用 marketLiveFromEnv 讀「環境變數」(這裡是測試中途可以改值的物件) */
const setupEnv = (env: Record<string, string | undefined>) => {
  const db = new FakeDb({ tables: tables() });
  // 補上 fixture 沒有的兩種:拒單、供應商自己取消(閘門測試要走過每一種信)
  db.tables.market_order_events.push(
    { id: EV(9), order_id: ORDER_A, from_status: "pending", to_status: "rejected", actor_role: "supplier", note: "缺貨", payload: {} },
    { id: EV(10), order_id: ORDER_A, from_status: "confirmed", to_status: "cancelled", actor_role: "supplier", note: "無法出貨", payload: {} },
    { id: EV(11), order_id: ORDER_B, from_status: "paid", to_status: "cancelled", actor_role: "supplier", note: "缺貨", payload: {} },
    // 72 小時自動取消(系統、payload.auto_expire)
    { id: EV(12), order_id: ORDER_A, from_status: "pending", to_status: "cancelled", actor_role: "system", note: "店家超過 72 小時沒有接單,系統自動取消", payload: { auto_expire: "pending" } },
    { id: EV(13), order_id: ORDER_B, from_status: "awaiting_payment", to_status: "cancelled", actor_role: "system", note: "超過 72 小時沒有完成匯款,系統自動取消", payload: { auto_expire: "awaiting_payment" } },
  );
  db.tables.suppliers[1].contact_email = "store-b@example.com";
  const send = vi.fn<MarketSendMail>(async () => ({ ok: true, id: "re_1", error: null }));
  const handler = createMarketNotifyHandler({
    db: selecting(db),
    send,
    config: CONFIG,
    secret: SECRET,
    isLive: () => marketLiveFromEnv((key) => env[key]),
    log: vi.fn(),
  });
  const call = async (body: unknown) => {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/market-notify", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  return { db, send, call };
};

describe("market-notify:MARKET_NOTIFY_LIVE 不是剛好字串 true,就不會寄給真實的消費者或供應商", () => {
  const NOT_LIVE: (string | undefined)[] = [undefined, "", "TRUE", "True", "1", " true", "true ", "\ttrue", "true\n", "yes", "false"];
  const REAL = ["buyer@example.com", "store-a@example.com", "store-b@example.com"];

  it("每一種值:下單確認與每一種狀態信全部轉寄 ifoodmaptw@gmail.com,主旨加 [測試轉寄]、回信也是平台信箱", async () => {
    for (const v of NOT_LIVE) {
      const label = `MARKET_NOTIFY_LIVE=${JSON.stringify(v)}`;
      // 餐廳訂單的 NOTIFY_LIVE 開了也一樣:零售只看 MARKET_NOTIFY_LIVE
      const s = setupEnv({ MARKET_NOTIFY_LIVE: v, NOTIFY_LIVE: "true" });
      // 第 3 輪審查:這兩條路徑原本沒走到 —— B 店沒填匯款資訊的待匯款、已收款的單被取消(EV 11)
      s.db.tables.market_store_transfer = [];
      Object.assign(s.db.tables.market_orders.find((o) => o.id === ORDER_B)!, { paid_at: "2026-10-11T03:00:00Z" });
      expect((await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN })).body.data, label).toMatchObject({ live: false, sent: 1 });
      // 新訂單(→ 供應商)、貨到付款接單、待匯款(→ 消費者)、平台取消(→ 消費者 + 供應商)、出貨、拒單、供應商取消(→ 消費者)
      const kinds: string[] = [];
      for (const id of [EV(1), EV(2), EV(4), EV(5), EV(6), EV(9), EV(10), EV(11), EV(12), EV(13)]) {
        const data = (await s.call({ kind: "event", event_id: id })).body.data;
        expect(data, `${label} ${id}`).toMatchObject({ live: false });
        kinds.push(...data.kinds);
      }
      expect(new Set(kinds), label).toEqual(
        new Set([
          "supplier_new",
          "consumer_confirmed",
          "consumer_awaiting_payment",
          "consumer_rejected",
          "consumer_shipped",
          "consumer_cancelled",
          "supplier_cancelled_by_platform",
        ]),
      );
      const msgs = s.send.mock.calls.map((c) => c[0]);
      expect(msgs, label).toHaveLength(14);
      // 72 小時自動取消:消費者與店家各兩封,一樣只寄測試信箱
      expect(msgs.filter((m) => m.subject.includes("自動取消")), `${label} 自動取消`).toHaveLength(4);
      expect(msgs.filter((m) => m.text.includes("退款由店家處理")), `${label} 已收款取消`).toHaveLength(1);
      expect(msgs.filter((m) => m.text.includes("店家尚未提供")), `${label} 沒填匯款資訊`).toHaveLength(1);
      for (const m of msgs) {
        expect(m.to, label).toEqual(["ifoodmaptw@gmail.com"]);
        expect(m.subject.startsWith("[測試轉寄] "), `${label} ${m.subject}`).toBe(true);
        expect(m.replyTo, label).toBe("ifoodmaptw@gmail.com");
        expect(m.text.startsWith("[測試轉寄] 原本的收件人:"), label).toBe(true);
        expect(m.html, label).toContain("MARKET_NOTIFY_LIVE 未開啟");
      }
      expect(msgs.flatMap((m) => m.to).filter((to) => REAL.includes(to)), label).toEqual([]);
      // 原收件人只列在轉寄說明裡
      expect(msgs[0].html, label).toContain("原本的收件人(消費者):buyer@example.com");
      expect(msgs[1].html, label).toContain("原本的收件人(供應商):store-a@example.com");
      expect(s.db.tables.notifications.map((n) => n.recipient), label).toEqual(Array(14).fill("ifoodmaptw@gmail.com"));
    }
  });

  it("對照組:剛好字串 true 才寄給本人(同一套流程)", async () => {
    const s = setupEnv({ MARKET_NOTIFY_LIVE: "true" });
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    await s.call({ kind: "event", event_id: EV(1) });
    expect(s.send.mock.calls.map((c) => c[0].to)).toEqual([["buyer@example.com"], ["store-a@example.com"]]);
    expect(s.send.mock.calls.every((c) => !c[0].subject.includes("[測試轉寄]"))).toBe(true);
  });

  it("每次請求都重讀(不快取):改成 true 才寄本人,改回空字串下一封立刻回到轉寄", async () => {
    const env: Record<string, string | undefined> = {};
    const s = setupEnv(env);
    await s.call({ kind: "event", event_id: EV(2) });
    env.MARKET_NOTIFY_LIVE = "true";
    await s.call({ kind: "event", event_id: EV(2) });
    env.MARKET_NOTIFY_LIVE = "";
    await s.call({ kind: "event", event_id: EV(2) });
    expect(s.send.mock.calls.map((c) => c[0].to[0])).toEqual(["ifoodmaptw@gmail.com", "buyer@example.com", "ifoodmaptw@gmail.com"]);
  });

  it("index.ts(Deno 入口,vitest 跑不到)的閘門只接 marketLiveFromEnv、每次請求讀 Deno.env", () => {
    const src = readFileSync(resolve(__dirname, "index.ts"), "utf8");
    expect(src).toContain("isLive: () => marketLiveFromEnv((k) => Deno.env.get(k)),");
    expect(src.match(/\bisLive\s*:/g)).toHaveLength(1);
    // 寄信接 send.ts(帶 Idempotency-Key)
    expect(src).toContain("send: createMarketResendSender(config.resendKey),");
  });
});

describe("market-notify:token 只出現在寄出的確認信,回應、log、資料庫都沒有", () => {
  const WRONG = `tok_${"y".repeat(39)}`;
  /** 回應內文、每一筆 log、每一次資料庫讀寫(條件與內容;會進 PostgREST 網址與 log)、資料表內容 */
  const leaks = (s: ReturnType<typeof setup>, r: { text: string }, token: string) => ({
    response: r.text.includes(token),
    log: JSON.stringify(s.log.mock.calls).includes(token),
    dbCalls: JSON.stringify(s.db.calls).includes(token),
    dbRows: JSON.stringify(s.db.tables).includes(token),
  });
  const NONE = { response: false, log: false, dbCalls: false, dbRows: false };
  const link = `https://app.ifoodmap.ai/market/orders/${TOKEN}`;

  it("閘門關閉 / 開放:token 只在信裡的連結(html 與純文字)", async () => {
    for (const live of [false, true]) {
      const s = setup({ live });
      const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
      expect(r.status).toBe(200);
      const msg = s.send.mock.calls[0][0];
      expect(msg.html).toContain(`href="${link}"`);
      expect(msg.text).toContain(link);
      expect(msg.subject).not.toContain(TOKEN);
      expect(leaks(s, r, TOKEN), `live=${live}`).toEqual(NONE);
    }
  });

  it("token 對不上(403):不寄,記一筆 log 但不含 token", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: WRONG });
    expect(r.status).toBe(403);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ error: "token mismatch" }));
    expect(leaks(s, r, WRONG)).toEqual(NONE);
  });

  it("checkout_id 格式不對(400)但 token 格式對:回應與 log 都沒有 token", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: "not-a-uuid", token: TOKEN });
    expect(r.status).toBe(400);
    expect(s.send).not.toHaveBeenCalled();
    expect(leaks(s, r, TOKEN)).toEqual(NONE);
  });

  it("寄信失敗、外部回來的錯誤訊息夾帶信件內容:log 裡的 token 遮成 ***", async () => {
    const s = setup({ send: async () => ({ ok: false, id: null, error: `Resend 422: invalid html near ${link}` }) });
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r.body.data).toMatchObject({ sent: 0, total: 1 });
    expect(s.db.tables.notifications[0]).toMatchObject({ status: "failed" });
    expect(s.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ step: "send", error: "Resend 422: invalid html near https://app.ifoodmap.ai/market/orders/***" }),
    );
    expect(leaks(s, r, TOKEN)).toEqual(NONE);
  });

  it("錯誤訊息把 token 截斷在中間(Resend 內文只留前 300 字)、或從 token 中間開始:任何 8 字以上的 token 片段都遮掉", async () => {
    const tok = "Zq3_Kp9-Lm2xVb7nRt5wYc1dHs8fJg4kQe6uAo0iPzT"; // 43 字 base64url,字元不重複出現,片段好認
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = await sha256Hex(tok);
    const cases = [
      `Resend 422: {"snippet":"<a href=\\"https://app.ifoodmap.ai/market/orders/${tok.slice(0, 20)}`, // 截在 token 中間
      `Resend 422: {"snippet":"${tok.slice(12, 40)}\\">查看訂單</a>"}`, // 從 token 中間開始、沒有網址前綴
    ];
    for (const error of cases) {
      const s = setup({ send: async () => ({ ok: false, id: null, error }) });
      for (const o of s.db.tables.market_orders) o.lookup_token_hash = hash;
      const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: tok });
      expect(r.body.data).toMatchObject({ sent: 0, total: 1 });
      const logged = JSON.stringify(s.log.mock.calls);
      expect(logged).toContain("Resend 422");
      expect(logged).toContain("***");
      for (let i = 0; i + 8 <= tok.length; i++) expect(logged, `token 第 ${i} 字起的 8 字片段`).not.toContain(tok.slice(i, i + 8));
    }
  });

  it("讀資料庫失敗(500)、買家 Email 不能寄:都不含 token", async () => {
    const failed = setup({ fail: (table) => (table === "market_order_items" ? { message: "boom" } : undefined) });
    const r1 = await failed.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r1.status).toBe(500);
    expect(failed.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "placed", error: "boom" }));
    expect(leaks(failed, r1, TOKEN)).toEqual(NONE);

    const noEmail = setup();
    for (const o of noEmail.db.tables.market_orders) o.buyer_email = "王小明<buyer@example.com>";
    const r2 = await noEmail.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r2.body.data).toMatchObject({ skipped: true });
    expect(noEmail.send).not.toHaveBeenCalled();
    expect(leaks(noEmail, r2, TOKEN)).toEqual(NONE);
  });
});
