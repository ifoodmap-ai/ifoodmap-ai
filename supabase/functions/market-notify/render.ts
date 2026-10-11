// 零售市集通知信的內容 —— 純函式,vitest 直接測(render.test.ts)。
//
// 🔴 內文是 HTML:店名、品名、買家姓名、地址、備註、原因、轉帳資訊、物流單號都是使用者填的字,一律先 esc() 再放進模板;
//    主旨是純文字(Resend 的 subject 欄位),不跳脫。
// 🔴 查詢連結(含 token)只出現在「下單確認」這一封;handler 的回傳值、log、notifications 表都不能出現 token。
//    後續的接單 / 出貨信沒有 token(資料庫只存雜湊),改請消費者用確認信裡的連結查看。
import { esc } from "../_shared/supplier-mail.ts";
// 訂單編號跟三個後台同一支函式(src/lib/order-number.ts 沒有任何 import,Deno 可以直接載入;--use-api 會一起上傳)
import { formatOrderNo } from "../../../src/lib/order-number.ts";

export interface Mail {
  subject: string;
  html: string;
  text: string;
}

export interface MailItem {
  product_name: string;
  spec: string;
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface MailOrder {
  id: string;
  storeName: string;
  /**
   * 店家電話(suppliers.phone;市集的店家頁本來就公開)—— 給消費者的信用它讓消費者聯絡店家。
   * 🔴 不放店家的 contact_email:那是收新訂單通知的信箱,不給消費者(第 1 階段定案),信裡、reply_to 都不出現。
   */
  storePhone: string;
  paymentMethod: "cod" | "transfer";
  subtotal: number;
  shippingFee: number;
  total: number;
  items: MailItem[];
  shipDays: number | null;
}

export const twd = (n: number) => `NT$ ${Number(n).toLocaleString("zh-TW")}`;

/**
 * 主旨只能一行(Resend 的 subject 是純文字、不跳脫):控制字元(含 CR、LF)與 U+2028 / U+2029 換成空白,
 * 連續空白壓成一個 —— 同 _shared/supplier-mail.ts 申請通知信裡的 oneLine(那支沒有 export,這裡另寫一份)。
 * placedMail / renderEventMail 回傳前一律套用,店名等變數怎麼填都只會是一行。
 */
export const oneLine = (v: unknown) =>
  String(v ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
export const orderLabel = (id: string) => `零售訂單 ${formatOrderNo(id)}`;
const PAYMENT_LABEL = { cod: "貨到付款", transfer: "銀行轉帳" } as const;

const FOOTER = "iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。";

const shell = (title: string, inner: string) => `
<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <div style="font-size:20px;font-weight:700;color:#047857;margin-bottom:20px">iFoodmap 食材市集</div>
  <h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>
  ${inner}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
  <p style="font-size:12px;color:#64748b;line-height:1.7;margin:0">${esc(FOOTER)}</p>
</div>`;

const p = (html: string) => `<p style="font-size:15px;line-height:1.75;color:#334155;margin:0 0 14px">${html}</p>`;
const box = (label: string, value: string) =>
  `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:0 0 14px">` +
  `<div style="font-size:12px;color:#64748b;margin-bottom:4px">${esc(label)}</div>` +
  `<div style="font-size:14px;line-height:1.7;color:#0f172a;white-space:pre-line">${esc(value)}</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:8px 0 20px"><a href="${esc(href)}" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">${esc(label)}</a></p>`;

/** 給消費者的信的店家聯絡方式:只有電話;店家沒有填就不寫這一行 */
const phoneText = (o: MailOrder) => (o.storePhone ? `店家電話:${o.storePhone}` : "");
const phoneHtml = (o: MailOrder) => (o.storePhone ? p(esc(phoneText(o))) : "");

const itemsTable = (o: MailOrder) =>
  `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 8px">` +
  o.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9">${esc(i.product_name)}(${esc(i.spec)})× ${i.qty}</td>` +
        `<td style="padding:4px 0;border-bottom:1px solid #f1f5f9;text-align:right">${esc(twd(i.line_total))}</td></tr>`,
    )
    .join("") +
  `<tr><td style="padding:4px 0;color:#64748b">小計</td><td style="padding:4px 0;text-align:right;color:#64748b">${esc(twd(o.subtotal))}</td></tr>` +
  `<tr><td style="padding:4px 0;color:#64748b">運費</td><td style="padding:4px 0;text-align:right;color:#64748b">${esc(
    o.shippingFee === 0 ? "免運" : twd(o.shippingFee),
  )}</td></tr>` +
  `<tr><td style="padding:4px 0;font-weight:700">總額</td><td style="padding:4px 0;text-align:right;font-weight:700">${esc(twd(o.total))}</td></tr>` +
  `</table>`;

const itemsText = (o: MailOrder) =>
  [
    ...o.items.map((i) => `- ${i.product_name}(${i.spec})× ${i.qty}:${twd(i.line_total)}`),
    `小計:${twd(o.subtotal)}`,
    `運費:${o.shippingFee === 0 ? "免運" : twd(o.shippingFee)}`,
    `總額:${twd(o.total)}`,
  ].join("\n");

/** 下單確認(寄給消費者,含查詢連結) */
export const placedMail = (opts: { buyerName: string; orders: MailOrder[]; lookupUrl: string }): Mail => {
  const subject = `訂單已送出(共 ${opts.orders.length} 家店)— iFoodmap 食材市集`;
  const sections = opts.orders
    .map(
      (o) =>
        `<h2 style="font-size:15px;margin:18px 0 6px">${esc(o.storeName)}・${esc(orderLabel(o.id))}</h2>` +
        itemsTable(o) +
        p(
          esc(
            o.paymentMethod === "transfer"
              ? "付款方式:銀行轉帳。店家接單後,查詢頁會顯示匯款帳號,我們也會寄信通知你。"
              : "付款方式:貨到付款。",
          ),
        ) +
        phoneHtml(o),
    )
    .join("");
  const html = shell(
    "訂單已送給店家",
    p(`${esc(opts.buyerName)} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`) +
      sections +
      button(opts.lookupUrl, "查看訂單") +
      p(esc("這個連結就是您的訂單查詢頁,請保留這封信、不要轉寄給別人。")),
  );
  const text = [
    `${opts.buyerName} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`,
    ...opts.orders.map((o) =>
      [`\n【${o.storeName}】${orderLabel(o.id)}`, itemsText(o), `付款方式:${PAYMENT_LABEL[o.paymentMethod]}`, phoneText(o)].filter(Boolean).join("\n"),
    ),
    `\n查看訂單:${opts.lookupUrl}`,
    "這個連結就是您的訂單查詢頁,請保留這封信、不要轉寄給別人。",
    "",
    FOOTER,
  ].join("\n");
  return { subject: oneLine(subject), html, text };
};

export type EventMailKind =
  | "supplier_new"
  | "consumer_confirmed"
  | "consumer_awaiting_payment"
  | "consumer_rejected"
  | "consumer_shipped"
  | "consumer_cancelled"
  | "supplier_cancelled_by_platform";

/** 這筆狀態紀錄要寄哪幾封信(paid / completed 不寄;轉帳訂單的 confirmed 不寄,緊接著的 awaiting_payment 才寄) */
export const resolveEventMails = (ev: { toStatus: string; actorRole: string | null; paymentMethod: string }): EventMailKind[] => {
  switch (ev.toStatus) {
    case "pending":
      return ["supplier_new"];
    case "confirmed":
      return ev.paymentMethod === "transfer" ? [] : ["consumer_confirmed"];
    case "awaiting_payment":
      return ["consumer_awaiting_payment"];
    case "rejected":
      return ["consumer_rejected"];
    case "shipped":
      return ["consumer_shipped"];
    case "cancelled":
      return ev.actorRole === "supplier" ? ["consumer_cancelled"] : ["consumer_cancelled", "supplier_cancelled_by_platform"];
    default:
      return [];
  }
};

export interface EventContext {
  order: MailOrder;
  buyerName: string;
  shipCity: string;
  shipAddress: string;
  buyerNote: string | null;
  reason: string;
  carrier: string;
  trackingNo: string;
  transferInfo: string;
  /** 供應商後台的訂單連結(只放在寄給供應商的信) */
  supplierOrdersUrl: string;
  /** 這張單已收款(paid_at 有值,或這筆紀錄是從 paid 轉過來的):取消信要說明退款由店家處理 */
  paid: boolean;
}

const LOOKUP_HINT = "訂單進度請用「下單確認信」裡的「查看訂單」連結查看。";

/** 狀態信的內容;主旨在 renderEventMail 壓成單行 */
const eventMail = (kind: EventMailKind, c: EventContext): Mail => {
  const o = c.order;
  const label = orderLabel(o.id);
  switch (kind) {
    case "supplier_new": {
      const subject = `新的零售訂單 ${formatOrderNo(o.id)} — 請到後台接單`;
      const html = shell(
        "有一張新的零售訂單",
        p(`消費者 ${esc(c.buyerName)} 向你訂購(${esc(PAYMENT_LABEL[o.paymentMethod])},收件縣市 ${esc(c.shipCity)})。請盡快接單或拒單。`) +
          itemsTable(o) +
          (c.buyerNote ? box("消費者備註", c.buyerNote) : "") +
          button(c.supplierOrdersUrl, "到後台處理"),
      );
      const text = [`有一張新的零售訂單 ${label}`, itemsText(o), c.buyerNote ? `消費者備註:${c.buyerNote}` : "", `到後台處理:${c.supplierOrdersUrl}`].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_confirmed": {
      const subject = `${o.storeName} 已接單 — ${label}`;
      const days = o.shipDays == null ? "" : o.shipDays === 0 ? ",預計當天出貨" : `,預計 ${o.shipDays} 個工作天內出貨`;
      const html = shell("店家已接單", p(`「${esc(o.storeName)}」已接受您的訂單 ${esc(label)}${esc(days)}。付款方式:貨到付款。`) + itemsTable(o) + phoneHtml(o) + p(esc(LOOKUP_HINT)));
      const text = [`「${o.storeName}」已接受您的訂單 ${label}${days}。付款方式:貨到付款。`, itemsText(o), phoneText(o), LOOKUP_HINT].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_awaiting_payment": {
      const subject = `請匯款 ${twd(o.total)} — ${label}`;
      const html = shell(
        "店家已接單,請匯款",
        p(`「${esc(o.storeName)}」已接受您的訂單 ${esc(label)}。請依下列資訊匯款 ${esc(twd(o.total))},店家確認收款後就會安排出貨。`) +
          box("匯款資訊", c.transferInfo || "(店家尚未提供,請直接聯絡店家)") +
          itemsTable(o) +
          phoneHtml(o) +
          p(esc(LOOKUP_HINT)),
      );
      const text = [`「${o.storeName}」已接受您的訂單 ${label}。請匯款 ${twd(o.total)}:`, c.transferInfo || "(店家尚未提供,請直接聯絡店家)", itemsText(o), phoneText(o), LOOKUP_HINT].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_rejected": {
      const subject = `店家無法接單 — ${label}`;
      const html = shell("店家無法接這張訂單", p(`很抱歉,「${esc(o.storeName)}」無法接受您的訂單 ${esc(label)}。`) + box("原因", c.reason || "(沒有填寫)") + p(esc("這張訂單不會成立,您不需要付款。")) + phoneHtml(o));
      const text = [`很抱歉,「${o.storeName}」無法接受您的訂單 ${label}。`, `原因:${c.reason || "(沒有填寫)"}`, "這張訂單不會成立,您不需要付款。", phoneText(o)].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_shipped": {
      const subject = `已出貨 — ${label}`;
      const tracking = `${c.carrier}${c.trackingNo ? `,單號 ${c.trackingNo}` : ""}`;
      const html = shell("您的訂單已出貨", p(`「${esc(o.storeName)}」已將訂單 ${esc(label)} 出貨。`) + box("物流", tracking) + phoneHtml(o) + p(esc(LOOKUP_HINT)));
      const text = [`「${o.storeName}」已將訂單 ${label} 出貨。`, `物流:${tracking}`, phoneText(o), LOOKUP_HINT].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_cancelled": {
      const subject = `訂單已取消 — ${label}`;
      // 已收款的單被取消(paid → cancelled):退款由店家處理、平台不經手款項,電話寫在同一句裡
      const refund = c.paid
        ? `這張訂單店家已確認收款,退款由店家處理,請直接聯絡店家${o.storePhone ? `(店家電話:${o.storePhone})` : ""}。iFoodmap 平台不經手款項。`
        : "如果已經匯款,請直接聯絡店家退款。";
      const contact = c.paid ? "" : phoneText(o);
      const html = shell(
        "訂單已取消",
        p(`您在「${esc(o.storeName)}」的訂單 ${esc(label)} 已取消。`) + box("原因", c.reason || "(沒有填寫)") + p(esc(refund)) + (contact ? p(esc(contact)) : ""),
      );
      const text = [`您在「${o.storeName}」的訂單 ${label} 已取消。`, `原因:${c.reason || "(沒有填寫)"}`, refund, contact].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "supplier_cancelled_by_platform": {
      const subject = `平台已取消零售訂單 ${formatOrderNo(o.id)} — 請不要出貨`;
      const html = shell("平台已取消這張零售訂單", p(`iFoodmap 平台已取消訂單 ${esc(label)}(消費者 ${esc(c.buyerName)})。<strong>請不要出貨</strong>。`) + box("原因", c.reason || "(沒有填寫)") + button(c.supplierOrdersUrl, "到後台查看"));
      return { subject, html, text: `iFoodmap 平台已取消訂單 ${label}(消費者 ${c.buyerName}),請不要出貨。\n原因:${c.reason || "(沒有填寫)"}\n${c.supplierOrdersUrl}` };
    }
  }
};

export const renderEventMail = (kind: EventMailKind, c: EventContext): Mail => {
  const m = eventMail(kind, c);
  return { ...m, subject: oneLine(m.subject) };
};
