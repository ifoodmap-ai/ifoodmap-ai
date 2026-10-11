import { describe, expect, it } from "vitest";
import { formatOrderNo } from "../../../src/lib/order-number.ts";
import { placedMail, renderEventMail, resolveEventMails, twd, type EventContext, type MailOrder } from "./render.ts";

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
