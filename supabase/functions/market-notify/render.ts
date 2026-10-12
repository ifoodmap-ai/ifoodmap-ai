// 零售市集通知信的內容 —— 純函式,vitest 直接測(render.test.ts)。
//
// 🔴 內文是 HTML:店名、品名、買家姓名、地址、備註、原因、轉帳資訊、物流單號、店家的法定資訊(登記名稱、負責人、營業所地址、
//    客服 Email、食品業者登錄字號、產品責任險)都是使用者填的字,一律先 esc() 再放進模板;主旨是純文字(Resend 的 subject 欄位),不跳脫。
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
  /** 不適用七日鑑賞期(market_order_items.withdrawal_exempt,下單當時的快照);只有下單確認信用,沒有就當成適用 */
  withdrawalExempt?: boolean;
}

/**
 * 店家的法定資訊(消保法 §18;market_stores 的欄位,migration 20261012110000)—— 只放在下單確認信。
 * 店家電話照舊用 MailOrder.storePhone(suppliers.phone)。都是店家自己填的字:一律跳脫、壓成一行。
 */
export interface StoreLegal {
  /** 登記名稱 */
  legalName: string;
  /** 負責人 */
  representative: string;
  /** 營業所地址 */
  businessAddress: string;
  /** 給消費者的客服 Email(跟收新訂單通知的 contact_email 是兩回事) */
  serviceEmail: string;
  /** 食品業者登錄字號(選填) */
  foodRegistrationNo: string;
  /** 產品責任險說明(選填) */
  liabilityInsurance: string;
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

/** 下單確認信的一家店:多了店家的法定資訊 */
export interface PlacedMailOrder extends MailOrder {
  legal: StoreLegal;
}

export const twd = (n: number) => `NT$ ${Number(n).toLocaleString("zh-TW")}`;

/**
 * 主旨只能一行(Resend 的 subject 是純文字、不跳脫):格式字元拿掉,控制字元(含 CR、LF)與 U+2028 / U+2029 換成空白,
 * 連續空白壓成一個 —— 參考 _shared/supplier-mail.ts 申請通知信裡的 oneLine(那支沒有 export,這裡另寫一份)。
 * placedMail / renderEventMail 回傳前一律套用,店名等變數怎麼填都只會是一行。
 */
export const oneLine = (v: unknown) =>
  String(v ?? "")
    // 格式字元(\p{Cf}:RLO U+202E、零寬空白 U+200B、BOM U+FEFF、軟連字號…)本來就看不見,直接拿掉 ——
    // 留著的話,店名帶 RLO 時主旨會顯示成反過來的字
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

export const orderLabel = (id: string) => `零售訂單 ${formatOrderNo(id)}`;

/**
 * 自動取消的時限(小時):pending 超過這麼久店家沒接單、或轉帳單進入待匯款超過這麼久,系統自動取消。
 * 跟 migration 20261012100000_market_hardening.sql 的 `-- @market-auto-cancel-hours` 標記是同一個數字(render.test.ts 對照);
 * 信裡提到時限的地方一律用這個常數。
 */
export const MARKET_AUTO_CANCEL_HOURS = 72;

const TAIPEI_PARTS = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * 台北時間「2026/10/15 11:00(台北時間)」—— 跟 _shared/supplier-mail.ts 的 taipeiTime 同一種寫法(測試對照),
 * 但逐欄組出來、固定 h23:不靠執行環境的時區(Edge Function 跑在 UTC),午夜寫 00:00 不會變成 24:00。
 */
export const taipeiDateTime = (d: Date): string => {
  const part = (type: Intl.DateTimeFormatPartTypes) => TAIPEI_PARTS.formatToParts(d).find((x) => x.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}\u{FF08}台北時間\u{FF09}`;
};

/** 匯款期限 = 這筆待匯款紀錄的建立時間 + MARKET_AUTO_CANCEL_HOURS;時間讀不出來回 null(信裡改寫「72 小時內」) */
export const paymentDeadline = (createdAt: string): string | null => {
  const t = Date.parse(createdAt);
  if (!createdAt || Number.isNaN(t)) return null;
  return taipeiDateTime(new Date(t + MARKET_AUTO_CANCEL_HOURS * 60 * 60 * 1000));
};
const PAYMENT_LABEL = { cod: "貨到付款", transfer: "銀行轉帳" } as const;

// 跟服務條款第十條一致:店家開的可能是收據,不一定是發票
const FOOTER = "iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票或收據由店家開立。";

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

/** 72 小時自動取消:下單確認、新訂單信多的那一句 */
const PLACED_DEADLINE = `店家會在 ${MARKET_AUTO_CANCEL_HOURS} 小時內確認訂單;超過時間沒有接單,訂單會自動取消。`;
const ACCEPT_DEADLINE = `請在 ${MARKET_AUTO_CANCEL_HOURS} 小時內接單,超過時間系統會自動取消這張訂單。`;
const STOCK_RESTORED = "訂單裡的商品庫存已經自動補回(只限有設定庫存的商品)。";
/** 待匯款信的期限那一句(期限算不出來就寫「72 小時內」) */
const payByText = (createdAt: string) => {
  const deadline = paymentDeadline(createdAt);
  return deadline
    ? `請在 ${deadline}前完成匯款,逾期訂單會自動取消。`
    : `請在 ${MARKET_AUTO_CANCEL_HOURS} 小時內完成匯款,逾期訂單會自動取消。`;
};

// ---- 下單確認信每家店的法定資訊(2026-10-12 業主決定;法規查證 M7:下單確認信就是消保法 §18 要求的書面) ----

/** 申訴管道:先聯絡店家,聯絡不到再寫信給平台 */
export const PLATFORM_COMPLAINT_EMAIL = "ifoodmaptw@gmail.com";
const NOT_PROVIDED = "(店家尚未提供)";
// 七日解除權:消保法 §18 要寫明期限「和行使方式」(確認信就是那份電子書面);不適用的品項那句(exemptText)接在後面
const WITHDRAWAL_TEXT =
  "收到商品隔天起 7 天內可以解除契約(退貨):把商品寄回店家,或用 Email 等書面方式通知店家;退回運費由店家負擔。標示不適用七日鑑賞期的商品除外,詳見服務條款第六條。";
const COMPLAINT_TEXT = `申訴:請先聯絡店家;聯絡不到時,寫信到 ${PLATFORM_COMPLAINT_EMAIL}。`;

/**
 * 店家資訊的每一列:登記名稱、負責人、營業所地址、電話、客服 Email 一定列(沒填寫「(店家尚未提供)」);
 * 食品業者登錄字號、產品責任險有填才列。值先壓成一行:店家填的換行不會在純文字版多出一行,冒充申訴管道或別的欄位。
 */
const legalRows = (o: PlacedMailOrder): [string, string][] => {
  const required = (v: string) => oneLine(v) || NOT_PROVIDED;
  const rows: [string, string][] = [
    ["登記名稱", required(o.legal.legalName)],
    ["負責人", required(o.legal.representative)],
    ["營業所地址", required(o.legal.businessAddress)],
    ["店家電話", required(o.storePhone)],
    ["客服 Email", required(o.legal.serviceEmail)],
  ];
  const optional: [string, string][] = [
    ["食品業者登錄字號", oneLine(o.legal.foodRegistrationNo)],
    ["產品責任險", oneLine(o.legal.liabilityInsurance)],
  ];
  return [...rows, ...optional.filter(([, v]) => v)];
};

/** 出貨天數:貨到付款從店家接單起算,轉帳從店家確認收款起算 */
const shipDaysText = (o: MailOrder) => {
  if (o.shipDays == null) return `出貨天數:${NOT_PROVIDED}`;
  const from = o.paymentMethod === "transfer" ? "店家確認收款後" : "店家接單後";
  return `出貨天數:${from}${o.shipDays === 0 ? "當天出貨" : ` ${o.shipDays} 個工作天內出貨`}。`;
};

/** 這張單裡不適用七日鑑賞期的商品(同名只列一次);沒有就是空字串 */
const exemptText = (o: MailOrder) => {
  const names = [...new Set(o.items.filter((i) => i.withdrawalExempt === true).map((i) => i.product_name))];
  return names.length ? `以下商品不適用七日鑑賞期:${names.join("、")}。` : "";
};

const legalText = (o: PlacedMailOrder) =>
  ["店家資訊", ...legalRows(o).map(([k, v]) => `${k}:${v}`), shipDaysText(o), WITHDRAWAL_TEXT, exemptText(o), COMPLAINT_TEXT].filter(Boolean).join("\n");

const small = (html: string, style = "") => `<p style="font-size:13px;line-height:1.7;color:#334155;margin:0 0 6px;${style}">${html}</p>`;
const legalHtml = (o: PlacedMailOrder) => {
  const exempt = exemptText(o);
  return (
    `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:0 0 10px;font-size:13px;line-height:1.7;color:#0f172a">` +
    `<div style="font-size:12px;color:#64748b;margin-bottom:4px">店家資訊</div>` +
    legalRows(o)
      .map(([k, v]) => `<div>${esc(k)}:${esc(v)}</div>`)
      .join("") +
    `</div>` +
    small(esc(shipDaysText(o))) +
    small(esc(WITHDRAWAL_TEXT)) +
    (exempt ? small(esc(exempt), "font-weight:600") : "") +
    small(esc(COMPLAINT_TEXT), "margin-bottom:14px")
  );
};

/** 下單確認(寄給消費者,含查詢連結;每家店附法定資訊) */
export const placedMail = (opts: { buyerName: string; orders: PlacedMailOrder[]; lookupUrl: string }): Mail => {
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
        // 店家電話併進店家資訊(法定資訊,一定列)
        legalHtml(o),
    )
    .join("");
  const html = shell(
    "訂單已送給店家",
    p(`${esc(opts.buyerName)} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`) +
      p(esc(PLACED_DEADLINE)) +
      sections +
      button(opts.lookupUrl, "查看訂單") +
      p(esc("這個連結就是您的訂單查詢頁,請保留這封信、不要轉寄給別人。")),
  );
  const text = [
    `${opts.buyerName} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`,
    PLACED_DEADLINE,
    ...opts.orders.map((o) => [`\n【${o.storeName}】${orderLabel(o.id)}`, itemsText(o), `付款方式:${PAYMENT_LABEL[o.paymentMethod]}`, legalText(o)].join("\n")),
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
  /** 系統的 72 小時自動取消(紀錄的 payload.auto_expire);不是自動取消就是 null */
  autoExpire: "pending" | "awaiting_payment" | null;
  /** 這筆狀態紀錄的建立時間(ISO 字串):待匯款信用它算匯款期限 */
  eventCreatedAt: string;
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
          p(esc(ACCEPT_DEADLINE)) +
          itemsTable(o) +
          (c.buyerNote ? box("消費者備註", c.buyerNote) : "") +
          button(c.supplierOrdersUrl, "到後台處理"),
      );
      const text = [`有一張新的零售訂單 ${label}`, ACCEPT_DEADLINE, itemsText(o), c.buyerNote ? `消費者備註:${c.buyerNote}` : "", `到後台處理:${c.supplierOrdersUrl}`].filter(Boolean).join("\n");
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
          p(esc(payByText(c.eventCreatedAt))) +
          itemsTable(o) +
          phoneHtml(o) +
          p(esc(LOOKUP_HINT)),
      );
      const text = [`「${o.storeName}」已接受您的訂單 ${label}。請匯款 ${twd(o.total)}:`, c.transferInfo || "(店家尚未提供,請直接聯絡店家)", payByText(c.eventCreatedAt), itemsText(o), phoneText(o), LOOKUP_HINT].filter(Boolean).join("\n");
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
      if (c.autoExpire) {
        // 72 小時自動取消:寫明是系統因逾時取消(不是店家取消);待接單、待匯款一定還沒收款,不放已收款那種退款句。
        // 2026-10-12 業主決定(法規查證 S6):轉帳單系統判斷的是「店家有沒有確認收到款項」,不是「買家有沒有匯款」
        // (買家可能已經匯了);接單時契約已經成立,不寫「這張訂單不會成立」
        const what =
          c.autoExpire === "pending"
            ? `店家超過 ${MARKET_AUTO_CANCEL_HOURS} 小時沒有接單,訂單已自動取消。`
            : "因為店家在期限內沒有確認收到您的匯款,訂單已自動取消。";
        const after = c.autoExpire === "pending" ? "您不需要付款。" : "不需要再匯款;如果您已經匯款,請聯絡店家退款並保留匯款證明。";
        const subject = `訂單已自動取消(${c.autoExpire === "pending" ? "店家逾時未接單" : "逾時未確認收款"})— ${label}`;
        const html = shell("訂單已自動取消", p(`您的訂單 ${esc(label)}(「${esc(o.storeName)}」):${esc(what)}`) + p(esc(after)) + phoneHtml(o));
        const text = [`您的訂單 ${label}(「${o.storeName}」):${what}`, after, phoneText(o)].filter(Boolean).join("\n");
        return { subject, html, text };
      }
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
      if (c.autoExpire) {
        // 72 小時自動取消:寫明是系統因逾時自動取消、庫存已經補回(130000 的 apply trigger 取消時把有設定庫存的商品加回去)
        const why =
          c.autoExpire === "pending"
            ? `這張訂單超過 ${MARKET_AUTO_CANCEL_HOURS} 小時沒有接單`
            : `店家超過 ${MARKET_AUTO_CANCEL_HOURS} 小時沒有確認收到款項`; // S6:判斷的是店家有沒有確認收款
        const subject = `零售訂單 ${formatOrderNo(o.id)} 已逾時自動取消 — 請不要出貨`;
        const html = shell(
          "系統已自動取消這張零售訂單",
          p(`訂單 ${esc(label)}(消費者 ${esc(c.buyerName)}):${esc(why)},系統因逾時自動取消。<strong>請不要出貨</strong>。`) +
            p(esc(STOCK_RESTORED)) +
            button(c.supplierOrdersUrl, "到後台查看"),
        );
        const text = [`訂單 ${label}(消費者 ${c.buyerName}):${why},系統因逾時自動取消。請不要出貨。`, STOCK_RESTORED, c.supplierOrdersUrl].join("\n");
        return { subject, html, text };
      }
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
