import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatOrderNo } from "../../../src/lib/order-number.ts";
import { taipeiTime } from "../_shared/supplier-mail.ts";
import {
  MARKET_AUTO_CANCEL_HOURS,
  paymentDeadline,
  placedMail,
  renderEventMail,
  resolveEventMails,
  taipeiDateTime,
  twd,
  type EventContext,
  type EventMailKind,
  type MailOrder,
} from "./render.ts";

const ORDER: MailOrder = {
  id: "a9600000-0000-4000-8000-0000000000a1",
  storeName: "鮮綠<b>農產</b>",
  storePhone: "02-2345-6789",
  paymentMethod: "transfer",
  subtotal: 650,
  shippingFee: 120,
  total: 770,
  items: [{ product_name: "高麗菜", spec: "1 顆", qty: 2, unit_price: 100, line_total: 200 }],
  shipDays: 2,
};
const CTX: EventContext = {
  order: ORDER,
  buyerName: "王<script>小明",
  shipCity: "臺北市",
  shipAddress: "測試路 1 號",
  buyerNote: "請放<管理室>",
  reason: "缺貨<img src=x>",
  carrier: "黑貓宅急便",
  trackingNo: "9001",
  transferInfo: "台灣銀行 004\n帳號 0123-456-789",
  supplierOrdersUrl: "https://app.ifoodmap.ai/supplier/market/orders",
  paid: false,
  autoExpire: null,
  // 這筆狀態紀錄的建立時間(PostgREST 回的是微秒格式)
  eventCreatedAt: "2026-10-12T03:00:00.123456+00:00",
};

describe("resolveEventMails", () => {
  it("每個狀態寄給誰", () => {
    expect(resolveEventMails({ toStatus: "pending", actorRole: "consumer", paymentMethod: "cod" })).toEqual(["supplier_new"]);
    expect(resolveEventMails({ toStatus: "confirmed", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_confirmed"]);
    expect(resolveEventMails({ toStatus: "confirmed", actorRole: "supplier", paymentMethod: "transfer" })).toEqual([]);
    expect(resolveEventMails({ toStatus: "awaiting_payment", actorRole: "supplier", paymentMethod: "transfer" })).toEqual(["consumer_awaiting_payment"]);
    expect(resolveEventMails({ toStatus: "rejected", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_rejected"]);
    expect(resolveEventMails({ toStatus: "shipped", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_shipped"]);
    expect(resolveEventMails({ toStatus: "paid", actorRole: "supplier", paymentMethod: "transfer" })).toEqual([]);
    expect(resolveEventMails({ toStatus: "completed", actorRole: "supplier", paymentMethod: "cod" })).toEqual([]);
  });

  // 轉帳訂單接單後自動補的「待匯款」紀錄:migration 130000 自 commit f04df17 起一律記成 system
  // (之前跟接單的人一樣,supplier / admin / system 都有可能)。寄信不看身分 —— 三種都寄匯款資訊,之後 migration 再改也不受影響
  it("待匯款不看身分:supplier / admin / system 補的那一筆都寄匯款資訊給消費者", () => {
    for (const actorRole of ["supplier", "admin", "system"]) {
      expect(resolveEventMails({ toStatus: "awaiting_payment", actorRole, paymentMethod: "transfer" }), actorRole).toEqual([
        "consumer_awaiting_payment",
      ]);
    }
  });

  it("供應商自己取消只通知消費者;平台(管理員 / 系統)取消也要通知供應商不要出貨", () => {
    expect(resolveEventMails({ toStatus: "cancelled", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_cancelled"]);
    expect(resolveEventMails({ toStatus: "cancelled", actorRole: "admin", paymentMethod: "cod" })).toEqual([
      "consumer_cancelled",
      "supplier_cancelled_by_platform",
    ]);
  });
});

describe("placedMail", () => {
  const mail = placedMail({ buyerName: "王<script>小明", orders: [ORDER], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" });

  it("主旨、查詢連結、金額、訂單編號", () => {
    expect(mail.subject).toBe("訂單已送出(共 1 家店)— iFoodmap 食材市集");
    expect(mail.html).toContain('href="https://app.ifoodmap.ai/market/orders/TOKEN123"');
    expect(mail.text).toContain("https://app.ifoodmap.ai/market/orders/TOKEN123");
    expect(mail.html).toContain(twd(770));
    expect(mail.html).toContain(formatOrderNo(ORDER.id));
    expect(mail.html).toContain("店家接單後,查詢頁會顯示匯款帳號");
  });

  it("使用者填的字都跳脫", () => {
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("王&lt;script&gt;小明");
    expect(mail.html).toContain("鮮綠&lt;b&gt;農產&lt;/b&gt;");
  });
});

describe("renderEventMail", () => {
  it("每一種都組得出主旨與內文,而且都不含 token / 查詢連結", () => {
    for (const kind of [
      "supplier_new",
      "consumer_confirmed",
      "consumer_awaiting_payment",
      "consumer_rejected",
      "consumer_shipped",
      "consumer_cancelled",
      "supplier_cancelled_by_platform",
    ] as const) {
      const m = renderEventMail(kind, CTX);
      expect(m.subject.length, kind).toBeGreaterThan(0);
      expect(m.html, kind).not.toContain("/market/orders/");
      expect(m.html, kind).not.toContain("<script>");
      expect(m.html, kind).not.toContain("<img src=x>");
    }
  });

  it("待匯款:金額與轉帳資訊(跳脫、保留換行)", () => {
    const m = renderEventMail("consumer_awaiting_payment", CTX);
    expect(m.subject).toBe(`請匯款 NT$ 770 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
    expect(m.html).toContain("台灣銀行 004\n帳號 0123-456-789");
    expect(m.html).toContain("white-space:pre-line");
  });

  it("出貨:物流與單號;拒單 / 取消:原因跳脫", () => {
    expect(renderEventMail("consumer_shipped", CTX).html).toContain("黑貓宅急便,單號 9001");
    expect(renderEventMail("consumer_rejected", CTX).html).toContain("缺貨&lt;img src=x&gt;");
    expect(renderEventMail("consumer_cancelled", CTX).text).toContain("缺貨<img src=x>");
  });

  it("接單信的出貨天數:N 天、當天、沒有設定(不寫)", () => {
    expect(renderEventMail("consumer_confirmed", CTX).text).toContain("已接受您的訂單 零售訂單 #000000A1,預計 2 個工作天內出貨。");
    expect(renderEventMail("consumer_confirmed", { ...CTX, order: { ...ORDER, shipDays: 0 } }).text).toContain(",預計當天出貨。");
    const none = renderEventMail("consumer_confirmed", { ...CTX, order: { ...ORDER, shipDays: null } });
    expect(none.text).toContain("已接受您的訂單 零售訂單 #000000A1。付款方式");
    expect(none.html).not.toContain("預計");
  });

  it("寄給供應商的新訂單信:後台連結、備註(跳脫)", () => {
    const m = renderEventMail("supplier_new", CTX);
    expect(m.subject).toBe(`新的零售訂單 ${formatOrderNo(ORDER.id)} — 請到後台接單`);
    expect(m.html).toContain('href="https://app.ifoodmap.ai/supplier/market/orders"');
    expect(m.html).toContain("請放&lt;管理室&gt;");
  });
});

// ---------------------------------------------------------------------
// 審查追加(2026-10-11):跳脫與金額要有測試釘住 —— 拿掉任何一處 esc()、或欄位 / 金額對錯,都要紅
// ---------------------------------------------------------------------

const EVIL_LINK = '<a href="https://evil.example">點我</a>';
const EVIL_IMG = '"><img src=x onerror=alert(1)>';
/** 每個欄位一個獨立的記號(看得出是哪個欄位被印出來)+ 三種壞字串 */
const evil = (marker: string) => `${marker}${EVIL_LINK}${EVIL_IMG}&`;
const htmlEscaped = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const EVIL_ORDER: MailOrder = {
  ...ORDER,
  storeName: evil("S-NAME"),
  storePhone: evil("S-PHONE"),
  items: [{ product_name: evil("P-NAME"), spec: evil("P-SPEC"), qty: 2, unit_price: 100, line_total: 200 }],
};
const EVIL_CTX: EventContext = {
  ...CTX,
  order: EVIL_ORDER,
  buyerName: evil("B-NAME"),
  shipCity: evil("B-CITY"),
  shipAddress: evil("B-ADDR"),
  buyerNote: evil("B-NOTE"),
  reason: evil("R-REASON"),
  carrier: evil("T-CARRIER"),
  trackingNo: evil("T-NO"),
  transferInfo: `${evil("X-BANK")}\n${evil("X-ACCOUNT")}`,
};

describe("店家、買家能控制的欄位放進 HTML 前一律跳脫", () => {
  // 每一封信的 HTML 會印出哪些欄位(新訂單信只放收件縣市、不放地址;地址任何一封都不出現)
  const RENDERED: Record<string, string[]> = {
    placed: ["S-NAME", "S-PHONE", "P-NAME", "P-SPEC", "B-NAME"],
    supplier_new: ["B-NAME", "B-CITY", "P-NAME", "P-SPEC", "B-NOTE"],
    consumer_confirmed: ["S-NAME", "S-PHONE", "P-NAME", "P-SPEC"],
    consumer_awaiting_payment: ["S-NAME", "S-PHONE", "X-BANK", "X-ACCOUNT", "P-NAME", "P-SPEC"],
    consumer_rejected: ["S-NAME", "S-PHONE", "R-REASON"],
    consumer_shipped: ["S-NAME", "S-PHONE", "T-CARRIER", "T-NO"],
    consumer_cancelled: ["S-NAME", "S-PHONE", "R-REASON"],
    supplier_cancelled_by_platform: ["B-NAME", "R-REASON"],
  };
  const mails = () => [
    ["placed", placedMail({ buyerName: evil("B-NAME"), orders: [EVIL_ORDER], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" })] as const,
    ...(Object.keys(RENDERED).filter((k) => k !== "placed") as EventMailKind[]).map((k) => [k, renderEventMail(k, EVIL_CTX)] as const),
  ];

  it("每一封信:沒有原始的 <a href=\"https://evil 或 <img,每個欄位都以跳脫後的樣子出現", () => {
    for (const [kind, m] of mails()) {
      expect(m.html, kind).not.toContain('<a href="https://evil');
      expect(m.html, kind).not.toContain("<img");
      for (const marker of RENDERED[kind]) expect(m.html, `${kind} ${marker}`).toContain(htmlEscaped(evil(marker)));
      expect(m.html, kind).not.toContain("B-ADDR");
    }
  });

  // 第 3 輪審查:原本的跳脫測試都是「還沒收款」,已收款的測試電話又沒有特殊字元 —— 退款那一句(含店家電話)沒有被釘住
  it("已收款的取消信:店名、退款那一句裡的店家電話都是跳脫後的樣子", () => {
    const m = renderEventMail("consumer_cancelled", { ...EVIL_CTX, paid: true });
    expect(m.html).not.toContain('<a href="https://evil');
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain(`您在「${htmlEscaped(evil("S-NAME"))}」的訂單`);
    expect(m.html).toContain(`請直接聯絡店家(店家電話:${htmlEscaped(evil("S-PHONE"))})。iFoodmap 平台不經手款項。`);
    expect(m.text).toContain(`請直接聯絡店家(店家電話:${evil("S-PHONE")})。iFoodmap 平台不經手款項。`);
  });

  it("純文字版維持原樣(不做 HTML 跳脫)", () => {
    for (const [kind, m] of mails()) {
      expect(m.text, kind).not.toMatch(/&(lt|gt|amp|quot|#39);/);
      expect(m.text, kind).not.toContain("B-ADDR");
    }
    expect(renderEventMail("consumer_shipped", EVIL_CTX).text).toContain(`${evil("T-CARRIER")},單號 ${evil("T-NO")}`);
    expect(renderEventMail("consumer_awaiting_payment", EVIL_CTX).text).toContain(evil("X-BANK"));
  });
});

describe("金額:每個數字都在對的標籤旁(html 與 text)", () => {
  // 小計、運費、總額、每一列小計、單價都是不同的數字:欄位對錯一定看得出來
  const MONEY: MailOrder = {
    ...ORDER,
    storeName: "鮮綠農產",
    subtotal: 1234,
    shippingFee: 150,
    total: 1384,
    items: [
      { product_name: "挪威鮭魚", spec: "200g/片", qty: 3, unit_price: 205, line_total: 615 },
      { product_name: "白蝦仁", spec: "300g/盒", qty: 1, unit_price: 619, line_total: 619 },
    ],
  };
  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** HTML 表格:標籤那一格的下一格就是金額 */
  const cell = (label: string, value: string) => new RegExp(`${reEsc(label)}</td><td[^>]*>${reEsc(value)}</td>`);
  const ROWS: [string, string][] = [
    ["挪威鮭魚(200g/片)× 3", "NT$ 615"],
    ["白蝦仁(300g/盒)× 1", "NT$ 619"],
    ["小計", "NT$ 1,234"],
    ["運費", "NT$ 150"],
    ["總額", "NT$ 1,384"],
  ];
  const TEXT_ROWS = ["- 挪威鮭魚(200g/片)× 3:NT$ 615", "- 白蝦仁(300g/盒)× 1:NT$ 619", "小計:NT$ 1,234", "運費:NT$ 150", "總額:NT$ 1,384"];
  const tableMails = () => [
    ["placed", placedMail({ buyerName: "王小明", orders: [MONEY], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" })] as const,
    ...(["supplier_new", "consumer_confirmed", "consumer_awaiting_payment"] as const).map((k) => [k, renderEventMail(k, { ...CTX, order: MONEY })] as const),
  ];

  it("明細、小計、運費、總額:html 的標籤格旁邊、text 的標籤後面都是對的數字", () => {
    for (const [kind, m] of tableMails()) {
      for (const [label, value] of ROWS) expect(m.html, `${kind} ${label}`).toMatch(cell(label, value));
      for (const line of TEXT_ROWS) expect(m.text.split("\n"), `${kind} ${line}`).toContain(line);
    }
  });

  it("待匯款:主旨、內文、純文字的匯款金額都是總額(不是小計)", () => {
    const m = renderEventMail("consumer_awaiting_payment", { ...CTX, order: MONEY });
    expect(m.subject).toBe(`請匯款 NT$ 1,384 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
    expect(m.html).toContain("請依下列資訊匯款 NT$ 1,384,");
    expect(m.text).toContain("請匯款 NT$ 1,384:");
    expect(`${m.html}\n${m.text}`).not.toMatch(/匯款 NT\$ 1,234/);
  });

  it("免運:運費那一格寫「免運」;貨到付款接單信寫明付款方式", () => {
    const free = { ...MONEY, shippingFee: 0, total: 1234 };
    const m = renderEventMail("consumer_confirmed", { ...CTX, order: free });
    expect(m.html).toMatch(cell("運費", "免運"));
    expect(m.text.split("\n")).toContain("運費:免運");
    expect(m.html).toContain("付款方式:貨到付款。");
    expect(m.text).toContain("付款方式:貨到付款。");
  });
});

describe("主旨只有一行(店名等變數去掉 CR / LF / 控制字元 / U+2028 / U+2029,連續空白壓成一個)", () => {
  const NASTY = "A 店\r\nBcc: x@y\u{2028}\u{2029}\x00\x07\t  尾";
  const NASTY_CF = `${NASTY}\u{202E}\u{200B}\u{FEFF}`; // 每一種信的檢查也帶格式字元
  const order = { ...ORDER, storeName: NASTY };

  it("店名帶 \\r\\nBcc: 這類字:主旨變成單行", () => {
    expect(renderEventMail("consumer_confirmed", { ...CTX, order }).subject).toBe(`A 店 Bcc: x@y 尾 已接單 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
  });

  // 第 3 輪審查:格式字元(\p{Cf})原本留在主旨 —— 店名帶 RLO(U+202E)時主旨會顯示成反過來的字
  it("店名帶格式字元(RLO、零寬空白、BOM、軟連字號):主旨裡全部去掉,不會顯示成反過來的字", () => {
    const order = { ...ORDER, storeName: "店\u{202E}evil\u{200B}\u{FEFF}\u{AD}名" };
    const subject = renderEventMail("consumer_confirmed", { ...CTX, order }).subject;
    expect(subject).toBe(`店evil名 已接單 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
    expect(subject).not.toMatch(/\p{Cf}/u);
  });

  it("每一種信的主旨都沒有控制字元、換行類分隔字元或連續空白", () => {
    const subjects = [
      placedMail({ buyerName: NASTY_CF, orders: [{ ...order, storeName: NASTY_CF }], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" }).subject,
      ...(
        [
          "supplier_new",
          "consumer_confirmed",
          "consumer_awaiting_payment",
          "consumer_rejected",
          "consumer_shipped",
          "consumer_cancelled",
          "supplier_cancelled_by_platform",
        ] as const
      ).map((k) => renderEventMail(k, { ...CTX, order: { ...order, storeName: NASTY_CF }, buyerName: NASTY_CF, reason: NASTY_CF }).subject),
    ];
    for (const s of subjects) {
      expect(s, JSON.stringify(s)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(s, JSON.stringify(s)).not.toMatch(/\s{2,}/u);
      expect(s, JSON.stringify(s)).toBe(s.trim());
    }
  });
});

describe("給消費者的信附店家電話(不給店家的 contact_email)", () => {
  const CONSUMER = ["consumer_confirmed", "consumer_awaiting_payment", "consumer_rejected", "consumer_shipped", "consumer_cancelled"] as const;

  it("有電話:下單確認與每一封給消費者的狀態信都有「店家電話」;寄給店家的信不放", () => {
    const placed = placedMail({ buyerName: "王小明", orders: [ORDER], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" });
    for (const m of [placed, ...CONSUMER.map((k) => renderEventMail(k, CTX))]) {
      expect(m.html, m.subject).toContain("店家電話:02-2345-6789");
      expect(m.text, m.subject).toContain("店家電話:02-2345-6789");
    }
    for (const k of ["supplier_new", "supplier_cancelled_by_platform"] as const) expect(renderEventMail(k, CTX).html, k).not.toContain("店家電話");
  });

  it("店家沒有填電話:不寫這一行", () => {
    const order = { ...ORDER, storePhone: "" };
    const placed = placedMail({ buyerName: "王小明", orders: [order], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" });
    for (const m of [placed, ...CONSUMER.map((k) => renderEventMail(k, { ...CTX, order }))]) {
      expect(m.html, m.subject).not.toContain("店家電話");
      expect(m.text, m.subject).not.toContain("店家電話");
    }
  });
});

describe("已收款的單被取消(paid → cancelled)", () => {
  it("給消費者的取消信:退款由店家處理、請直接聯絡店家(附電話)、平台不經手款項", () => {
    const m = renderEventMail("consumer_cancelled", { ...CTX, paid: true });
    for (const body of [m.html, m.text]) {
      expect(body).toContain("店家已確認收款");
      expect(body).toContain("退款由店家處理,請直接聯絡店家(店家電話:02-2345-6789)");
      expect(body).toContain("iFoodmap 平台不經手款項");
      expect(body).not.toContain("如果已經匯款");
    }
  });

  it("店家沒有填電話:照樣說明退款由店家處理,不寫電話", () => {
    const m = renderEventMail("consumer_cancelled", { ...CTX, paid: true, order: { ...ORDER, storePhone: "" } });
    expect(m.text).toContain("退款由店家處理,請直接聯絡店家。iFoodmap 平台不經手款項。");
    expect(m.html).not.toContain("店家電話");
  });

  it("還沒收款的取消信不變(如果已經匯款,請直接聯絡店家退款)", () => {
    const m = renderEventMail("consumer_cancelled", CTX);
    expect(m.text).toContain("如果已經匯款,請直接聯絡店家退款。");
    expect(`${m.html}${m.text}`).not.toContain("不經手款項");
  });

  it("寄給誰不看是不是已收款:店家取消只通知消費者,管理員 / 系統取消也通知店家不要出貨", () => {
    expect(resolveEventMails({ toStatus: "cancelled", actorRole: "supplier", paymentMethod: "transfer" })).toEqual(["consumer_cancelled"]);
    for (const actorRole of ["admin", "system"]) {
      expect(resolveEventMails({ toStatus: "cancelled", actorRole, paymentMethod: "transfer" }), actorRole).toEqual([
        "consumer_cancelled",
        "supplier_cancelled_by_platform",
      ]);
    }
  });
});

// ---------------------------------------------------------------------
// 2026-10-12 業主決定:72 小時自動取消(資料庫 migration 20261012100000_market_hardening.sql)
// ---------------------------------------------------------------------

describe("72 小時自動取消:時限只有一個常數,跟 migration 的標記同一個數字", () => {
  const dir = resolve(__dirname, "../../migrations");
  const HARDENING = "20261012100000_market_hardening.sql";
  const marks = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .flatMap((f) => [...readFileSync(resolve(dir, f), "utf8").matchAll(/--\s*@market-auto-cancel-hours\s+(\d+)\b/g)].map((m) => ({ file: f, hours: Number(m[1]) })));
  const hasHardening = existsSync(resolve(dir, HARDENING));

  // 標記已經 commit(fc25de1),這項不再跳過:檔案不見、標記不只一處、或數字不同都要紅
  it("MARKET_AUTO_CANCEL_HOURS = migration 20261012100000 的 -- @market-auto-cancel-hours(全部 migration 只有這一處)", () => {
    expect(hasHardening, HARDENING).toBe(true);
    expect(marks.map((m) => m.file)).toEqual([HARDENING]);
    expect(marks[0].hours).toBe(MARKET_AUTO_CANCEL_HOURS);
  });

  it("業主定的是 72 小時", () => {
    expect(MARKET_AUTO_CANCEL_HOURS).toBe(72);
  });
});

describe("匯款期限:待匯款那筆紀錄的建立時間 + 72 小時,一律用台北時間", () => {
  it.each([
    ["2026-10-12T03:00:00.123456+00:00", "2026/10/15 11:00(台北時間)"], // PostgREST 的微秒格式
    ["2026-10-12T17:30:00Z", "2026/10/16 01:30(台北時間)"], // UTC 還是 15 日、台北已經 16 日(跨日)
    ["2026-10-29T18:00:00+00:00", "2026/11/02 02:00(台北時間)"], // 跨月
    ["2026-12-29T16:00:00Z", "2027/01/02 00:00(台北時間)"], // 跨年;午夜寫 00:00,不寫 24:00
    ["2026-10-12T11:00:00+08:00", "2026/10/15 11:00(台北時間)"], // 帶 +08:00 的寫法
  ])("%s → %s", (createdAt, expected) => {
    expect(paymentDeadline(createdAt)).toBe(expected.replace("(", "\u{FF08}").replace(")", "\u{FF09}"));
  });

  it("時間讀不出來回 null", () => {
    for (const v of ["", "not-a-date"]) expect(paymentDeadline(v), v).toBeNull();
  });

  it("不靠執行環境的時區(Edge Function 跑在 UTC)", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        expect(paymentDeadline("2026-10-12T17:30:00Z"), tz).toBe("2026/10/16 01:30\u{FF08}台北時間\u{FF09}");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  // taipeiTime 直接用 Intl 的格式:新版 ICU(Node 25)在日期與時間之間放的是 U+2009 細空白,別的 ICU 版本可能是一般空白;
  // 這裡逐欄組、一律用一般空白,不管跑在哪個 runtime 都一樣 —— 所以比對時把空白類字元都當成一般空白
  // 第 3 階段審查 M2:日期格式物件是載入模組時建好的,上面那項是載入「之後」才換時區(拿掉 timeZone 照樣綠)。
  // 這裡先把預設時區換成 UTC 再重新載入模組:拿掉 timeZone 的話,格式物件會用 UTC,這項就紅
  it("在別的時區(UTC)載入模組,期限照樣是台北時間", async () => {
    const before = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      vi.resetModules();
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC"); // 這時候預設時區真的是 UTC
      const fresh = await import("./render.ts");
      expect(fresh.paymentDeadline("2026-10-12T17:30:00Z")).toBe("2026/10/16 01:30\u{FF08}台北時間\u{FF09}");
      expect(fresh.taipeiDateTime(new Date("2026-10-15T16:30:00Z"))).toBe("2026/10/16 00:30\u{FF08}台北時間\u{FF09}");
      const m = fresh.renderEventMail("consumer_awaiting_payment", CTX);
      expect(m.text).toContain("請在 2026/10/15 11:00\u{FF08}台北時間\u{FF09}前完成匯款");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
      vi.resetModules();
    }
  });

  // 第 3 階段審查 M3:卡在分鐘邊界 —— 無條件捨去到分鐘(不四捨五入),跟前端 src/lib/market/autoCancel.ts 一樣用 Intl 只取到分鐘
  it.each([
    ["2026-10-12T02:59:59.999999+00:00", "2026/10/15 10:59"], // 差 1 微秒就 11:00:捨去
    ["2026-10-12T02:59:30.000000+00:00", "2026/10/15 10:59"], // 30 秒也捨去
    ["2026-10-12T15:59:59.999999Z", "2026/10/15 23:59"], // 捨去不會進到隔天
    ["2026-10-12T03:00:00.000000+00:00", "2026/10/15 11:00"], // 剛好整分
  ])("分鐘邊界 %s → %s(捨去,不進位)", (createdAt, expected) => {
    expect(paymentDeadline(createdAt)).toBe(`${expected}\u{FF08}台北時間\u{FF09}`);
  });

  it("寫法跟信裡現有的日期一樣(_shared/supplier-mail.ts 的 taipeiTime;空白一律用一般空白)", () => {
    for (const iso of ["2026-10-15T03:00:00Z", "2026-10-16T05:07:00Z"]) {
      expect(taipeiDateTime(new Date(iso))).toBe(taipeiTime(iso).replace(/\s/gu, " "));
      expect(taipeiDateTime(new Date(iso))).not.toMatch(/[^\S ]/u); // 只有一般空白
    }
  });
});

describe("72 小時自動取消:信裡新增的句子(html 與 text)", () => {
  it("店家的新訂單信:請在 72 小時內接單,超過時間系統會自動取消這張訂單", () => {
    const m = renderEventMail("supplier_new", CTX);
    for (const body of [m.html, m.text]) expect(body).toContain("請在 72 小時內接單,超過時間系統會自動取消這張訂單。");
  });

  it("消費者的下單確認信:店家會在 72 小時內確認訂單;超過時間沒有接單,訂單會自動取消", () => {
    const m = placedMail({ buyerName: "王小明", orders: [ORDER], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" });
    for (const body of [m.html, m.text]) expect(body).toContain("店家會在 72 小時內確認訂單;超過時間沒有接單,訂單會自動取消。");
  });

  it("消費者的待匯款信:請在 <待匯款時間 + 72 小時> 前完成匯款,逾期訂單會自動取消", () => {
    const m = renderEventMail("consumer_awaiting_payment", CTX);
    for (const body of [m.html, m.text]) expect(body).toContain("請在 2026/10/15 11:00\u{FF08}台北時間\u{FF09}前完成匯款,逾期訂單會自動取消。");
  });

  it("待匯款信:時間讀不出來就寫「72 小時內」", () => {
    const m = renderEventMail("consumer_awaiting_payment", { ...CTX, eventCreatedAt: "" });
    for (const body of [m.html, m.text]) expect(body).toContain("請在 72 小時內完成匯款,逾期訂單會自動取消。");
  });

  it("其他信不多這些句子", () => {
    for (const k of ["consumer_confirmed", "consumer_rejected", "consumer_shipped", "consumer_cancelled", "supplier_cancelled_by_platform"] as const) {
      expect(renderEventMail(k, CTX).text, k).not.toMatch(/72 小時/);
    }
  });
});

describe("72 小時自動取消的信(紀錄的 payload.auto_expire 有值)", () => {
  const AUTO_P: EventContext = { ...CTX, autoExpire: "pending", reason: "店家超過 72 小時沒有接單,系統自動取消" };
  const AUTO_A: EventContext = { ...CTX, autoExpire: "awaiting_payment", reason: "超過 72 小時沒有完成匯款,系統自動取消" };
  const REFUND = /退款|已確認收款|不經手款項/;

  it("消費者:pending → 店家超過 72 小時沒有接單,訂單已自動取消(不需要付款)", () => {
    const m = renderEventMail("consumer_cancelled", AUTO_P);
    expect(m.subject).toBe(`訂單已自動取消(店家逾時未接單)— 零售訂單 ${formatOrderNo(ORDER.id)}`);
    for (const body of [m.html, m.text]) {
      expect(body).toContain("店家超過 72 小時沒有接單,訂單已自動取消。");
      expect(body).toContain("這張訂單不會成立,您不需要付款。");
      expect(body).toContain("店家電話:02-2345-6789");
    }
  });

  it("消費者:awaiting_payment → 因為超過 72 小時沒有完成匯款,訂單已自動取消", () => {
    const m = renderEventMail("consumer_cancelled", AUTO_A);
    expect(m.subject).toBe(`訂單已自動取消(逾時未完成匯款)— 零售訂單 ${formatOrderNo(ORDER.id)}`);
    for (const body of [m.html, m.text]) {
      expect(body).toContain("因為超過 72 小時沒有完成匯款,訂單已自動取消。");
      expect(body).toContain("這張訂單不會成立,不需要再匯款;如果您已經匯款,請直接聯絡店家。");
    }
  });

  it("消費者的自動取消信:不寫成店家取消、沒有退款句(就算資料說已收款也一樣)", () => {
    for (const c of [AUTO_P, AUTO_A, { ...AUTO_A, paid: true }]) {
      const m = renderEventMail("consumer_cancelled", c);
      const all = `${m.subject}\n${m.html}\n${m.text}`;
      expect(all, `${c.autoExpire} paid=${c.paid}`).not.toContain("店家取消");
      expect(all, `${c.autoExpire} paid=${c.paid}`).not.toMatch(REFUND);
    }
  });

  it("店家:寫明系統因逾時自動取消、庫存已經自動補回、請不要出貨", () => {
    const p = renderEventMail("supplier_cancelled_by_platform", AUTO_P);
    const a = renderEventMail("supplier_cancelled_by_platform", AUTO_A);
    for (const m of [p, a]) {
      expect(m.subject).toBe(`零售訂單 ${formatOrderNo(ORDER.id)} 已逾時自動取消 — 請不要出貨`);
      for (const body of [m.html, m.text]) {
        expect(body).toContain("系統因逾時自動取消");
        expect(body).toContain("訂單裡的商品庫存已經自動補回(只限有設定庫存的商品)。");
        expect(body).toContain("請不要出貨");
        expect(body).not.toMatch(REFUND);
      }
    }
    for (const body of [p.html, p.text]) expect(body).toContain("這張訂單超過 72 小時沒有接單");
    for (const body of [a.html, a.text]) expect(body).toContain("消費者超過 72 小時沒有完成匯款");
  });

  it("主旨分得出是自動取消;一般取消的主旨與內容不變", () => {
    for (const k of ["consumer_cancelled", "supplier_cancelled_by_platform"] as const) {
      const normal = renderEventMail(k, CTX);
      expect(`${normal.subject}\n${normal.text}`, k).not.toContain("自動取消");
      for (const c of [AUTO_P, AUTO_A]) expect(renderEventMail(k, c).subject, `${k} ${c.autoExpire}`).toContain("自動取消");
    }
    expect(renderEventMail("consumer_cancelled", CTX).subject).toBe(`訂單已取消 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
    expect(renderEventMail("supplier_cancelled_by_platform", CTX).subject).toBe(`平台已取消零售訂單 ${formatOrderNo(ORDER.id)} — 請不要出貨`);
  });

  it("自動取消信也把店名、店家電話、買家姓名跳脫", () => {
    for (const autoExpire of ["pending", "awaiting_payment"] as const) {
      const consumer = renderEventMail("consumer_cancelled", { ...EVIL_CTX, autoExpire });
      const supplier = renderEventMail("supplier_cancelled_by_platform", { ...EVIL_CTX, autoExpire });
      for (const m of [consumer, supplier]) {
        expect(m.html, autoExpire).not.toContain('<a href="https://evil');
        expect(m.html, autoExpire).not.toContain("<img");
      }
      expect(consumer.html).toContain(htmlEscaped(evil("S-NAME")));
      expect(consumer.html).toContain(htmlEscaped(evil("S-PHONE")));
      expect(supplier.html).toContain(htmlEscaped(evil("B-NAME")));
    }
  });
});
