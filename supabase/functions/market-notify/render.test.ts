import { describe, expect, it } from "vitest";
import { formatOrderNo } from "../../../src/lib/order-number.ts";
import { placedMail, renderEventMail, resolveEventMails, twd, type EventContext, type EventMailKind, type MailOrder } from "./render.ts";

const ORDER: MailOrder = {
  id: "a9600000-0000-4000-8000-0000000000a1",
  storeName: "鮮綠<b>農產</b>",
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
    placed: ["S-NAME", "P-NAME", "P-SPEC", "B-NAME"],
    supplier_new: ["B-NAME", "B-CITY", "P-NAME", "P-SPEC", "B-NOTE"],
    consumer_confirmed: ["S-NAME", "P-NAME", "P-SPEC"],
    consumer_awaiting_payment: ["S-NAME", "X-BANK", "X-ACCOUNT", "P-NAME", "P-SPEC"],
    consumer_rejected: ["S-NAME", "R-REASON"],
    consumer_shipped: ["S-NAME", "T-CARRIER", "T-NO"],
    consumer_cancelled: ["S-NAME", "R-REASON"],
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
  const order = { ...ORDER, storeName: NASTY };

  it("店名帶 \\r\\nBcc: 這類字:主旨變成單行", () => {
    expect(renderEventMail("consumer_confirmed", { ...CTX, order }).subject).toBe(`A 店 Bcc: x@y 尾 已接單 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
  });

  it("每一種信的主旨都沒有控制字元、換行類分隔字元或連續空白", () => {
    const subjects = [
      placedMail({ buyerName: NASTY, orders: [order], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" }).subject,
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
      ).map((k) => renderEventMail(k, { ...CTX, order, buyerName: NASTY, reason: NASTY }).subject),
    ];
    for (const s of subjects) {
      expect(s, JSON.stringify(s)).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(s, JSON.stringify(s)).not.toMatch(/\s{2,}/u);
      expect(s, JSON.stringify(s)).toBe(s.trim());
    }
  });
});
