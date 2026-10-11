// market-notify 的主要邏輯(index.ts 只負責接上 Deno 的環境變數與 serve;vitest 用 FakeDb 測每一條分支)。
//
// 呼叫者只有資料庫(pg_net,見 migration 20261009130100 的 market_enqueue_notify):
//   {kind:'placed', checkout_id, token} → 寄「下單確認」給消費者(內含查詢連結;一次結帳一封,列出每家店)
//   {kind:'event',  event_id}           → 依狀態紀錄寄給供應商或消費者(規則見 render.ts 的 resolveEventMails)
//
// 驗證:Authorization: Bearer <NOTIFY_SECRET>(跟 notify 同一把;資料庫那邊存在 app_config.notify_service_key)。
// 🔴 token 只放進確認信的連結:不寫進回應、log、notifications 表(外部回來的錯誤訊息進 log 前也先遮掉,見 redactLog)。
//    placed 先比對 sha256(token) 與訂單上的雜湊,對不上就不寄 —— 拿到密鑰的人也沒辦法替別人的訂單寄出一個假的查詢連結。
// 🔴 MARKET_NOTIFY_LIVE 不是 "true" 時,所有信只寄 ifoodmaptw@gmail.com(gate.ts)。開放要業主核准。
import type { Db, DbResult, LogFn } from "../_shared/db.ts";
import { isDeliverableEmail, type MailConfig, type SendMail } from "../_shared/supplier-mail.ts";
import { sha256Hex } from "../ai/crypto.ts";
import { type MarketAudience, planMarketDeliveries, TEST_SUBJECT_PREFIX } from "./gate.ts";
import {
  type EventContext,
  type EventMailKind,
  type Mail,
  type MailItem,
  type MailOrder,
  orderLabel,
  placedMail,
  renderEventMail,
  resolveEventMails,
} from "./render.ts";

export interface MarketNotifyDeps {
  db: Db;
  send: SendMail;
  config: MailConfig;
  /** = Supabase secret NOTIFY_SECRET */
  secret: string;
  /** 每次請求重讀 MARKET_NOTIFY_LIVE(不快取) */
  isLive: () => boolean;
  log: LogFn;
}

// 讀資料用的欄位(handler.test.ts 會對照 migration 的 CREATE TABLE,打錯字測試就會失敗)
export const ORDER_COLUMNS =
  "id, checkout_id, supplier_id, status, buyer_name, buyer_email, ship_city, ship_address, buyer_note, subtotal, shipping_fee, total, payment_method, lookup_token_hash, paid_at";
export const ITEM_COLUMNS = "product_name, spec, qty, unit_price, line_total";
export const EVENT_COLUMNS = "id, order_id, from_status, to_status, actor_role, note, payload";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** token 片段至少幾個字就遮:少於 8 字的片段最多透露 42 bits(token 有 256 bits),剩下的猜不出來 */
const TOKEN_FRAGMENT_MIN = 8;

/** 把文字裡的 token,以及任何 8 字以上的 token 片段(外部錯誤訊息可能把 token 截斷在中間),換成 *** */
const redactToken = (text: string, token: string): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    let len = 0;
    while (i + len < text.length && token.includes(text.slice(i, i + len + 1))) len += 1;
    if (len >= TOKEN_FRAGMENT_MIN) {
      out += "***";
      i += len;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
};

/** 逐一處理 log 內容裡的字串(不在序列化後的 JSON 上改,跳脫字元不會被弄壞) */
const redactValue = (v: unknown, token: string): unknown => {
  if (typeof v === "string") return redactToken(v, token);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, token));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, token)]));
  return v;
};

/**
 * 這次請求的每一筆 log 先遮掉查詢 token:外部回來的錯誤訊息(例如 Resend 的回應內文,createResendSender 只留前 300 字)
 * 可能夾帶信件內容,甚至把 token 截斷在中間 —— 所以連 8 字以上的片段也遮。
 */
const redactLog =
  (log: LogFn, token: string): LogFn =>
  (level, entry) =>
    log(level, redactValue(entry, token) as Record<string, unknown>);

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

const many = async (q: PromiseLike<DbResult>): Promise<Row[]> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
};
const one = async (q: PromiseLike<DbResult>): Promise<Row | null> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? null) as Row | null;
};

/** 訂單 → 信裡要用的樣子(店名、店家電話、明細、出貨天數),順便回傳供應商資料(contact_email 只用來寄給店家) */
const loadMailOrder = async (db: Db, order: Row): Promise<{ mail: MailOrder; supplier: Row | null }> => {
  const [supplier, store, items] = await Promise.all([
    one(db.from("suppliers").select("name, contact_email, phone").eq("id", order.supplier_id).maybeSingle()),
    one(db.from("market_stores").select("ship_days").eq("supplier_id", order.supplier_id).maybeSingle()),
    many(db.from("market_order_items").select(ITEM_COLUMNS).eq("order_id", order.id)),
  ]);
  const mailItems: MailItem[] = items
    .map((i) => ({
      product_name: str(i.product_name),
      spec: str(i.spec),
      qty: Number(i.qty),
      unit_price: Number(i.unit_price),
      line_total: Number(i.line_total),
    }))
    .sort((a, b) => a.product_name.localeCompare(b.product_name, "zh-Hant"));
  return {
    supplier,
    mail: {
      id: str(order.id),
      storeName: str(supplier?.name) || "店家",
      storePhone: str(supplier?.phone).trim(),
      paymentMethod: order.payment_method === "transfer" ? "transfer" : "cod",
      subtotal: Number(order.subtotal),
      shippingFee: Number(order.shipping_fee),
      total: Number(order.total),
      items: mailItems,
      shipDays: store?.ship_days === null || store?.ship_days === undefined ? null : Number(store.ship_days),
    },
  };
};

interface DeliveryResult {
  audience: MarketAudience;
  ok: boolean;
}

/** 經過閘門寄出,每封都記一筆 notifications(後台 /admin/notifications 看得到;不含 token) */
const deliver = async (
  deps: MarketNotifyDeps,
  live: boolean,
  recipient: { email: string; audience: MarketAudience },
  mail: Mail,
  logMessage: string,
): Promise<DeliveryResult[]> => {
  const results: DeliveryResult[] = [];
  for (const d of planMarketDeliveries([recipient], mail.subject, live)) {
    const forwarded = d.forwardNote !== null;
    const original = d.originalRecipients.join("、");
    const r = await deps.send({
      from: deps.config.applicantFrom,
      to: [d.to],
      subject: d.subject,
      html: (d.forwardNote ?? "") + mail.html,
      text: forwarded ? `${TEST_SUBJECT_PREFIX} 原本的收件人:${original}\n\n${mail.text}` : mail.text,
      // 回信一律到平台信箱:🔴 店家的 contact_email 是收新訂單通知的信箱,不給消費者(要聯絡店家看信裡的店家電話)
      replyTo: deps.config.replyTo,
    });
    await deps.db.from("notifications").insert({
      recipient: d.to,
      channel: "email",
      title: d.subject,
      message: logMessage + (forwarded ? `(測試轉寄,原收件人:${original})` : ""),
      status: r.ok ? "sent" : "failed",
      sent_at: r.ok ? new Date().toISOString() : null,
    });
    if (!r.ok) deps.log("error", { fn: "market-notify", step: "send", audience: d.audience, error: r.error });
    results.push({ audience: d.audience, ok: r.ok });
  }
  return results;
};

const summary = (live: boolean, results: { ok: boolean }[], extra: Row = {}) =>
  json({ data: { live, sent: results.filter((r) => r.ok).length, total: results.length, ...extra } });

const handlePlaced = async (deps: MarketNotifyDeps, live: boolean, body: Row): Promise<Response> => {
  const checkoutId = str(body.checkout_id);
  const token = str(body.token);
  if (!UUID_RE.test(checkoutId) || !TOKEN_RE.test(token)) return json({ message: "checkout_id 或 token 格式不對" }, 400);

  const orders = await many(deps.db.from("market_orders").select(ORDER_COLUMNS).eq("checkout_id", checkoutId));
  if (orders.length === 0) return json({ message: "order not found" }, 404);
  const hash = await sha256Hex(token);
  if (orders.some((o) => o.lookup_token_hash !== hash)) {
    deps.log("error", { fn: "market-notify", step: "placed", checkout_id: checkoutId, error: "token mismatch" });
    return json({ message: "token mismatch" }, 403);
  }

  const first = orders[0];
  const email = str(first.buyer_email);
  if (!isDeliverableEmail(email)) return json({ data: { skipped: true, reason: "buyer email not deliverable" } });

  const loaded = await Promise.all(orders.map((o) => loadMailOrder(deps.db, o)));
  const mailOrders = loaded.map((l) => l.mail).sort((a, b) => a.storeName.localeCompare(b.storeName, "zh-Hant"));
  const mail = placedMail({
    buyerName: str(first.buyer_name),
    orders: mailOrders,
    lookupUrl: `${deps.config.siteUrl}/market/orders/${token}`,
  });
  const results = await deliver(
    deps,
    live,
    { email, audience: "consumer" },
    mail,
    `零售下單確認:${mailOrders.map((o) => orderLabel(o.id)).join("、")}`,
  );
  return summary(live, results, { orders: mailOrders.length });
};

const handleEvent = async (deps: MarketNotifyDeps, live: boolean, body: Row): Promise<Response> => {
  const eventId = str(body.event_id);
  if (!UUID_RE.test(eventId)) return json({ message: "event_id 格式不對" }, 400);

  const ev = await one(deps.db.from("market_order_events").select(EVENT_COLUMNS).eq("id", eventId).maybeSingle());
  if (!ev) return json({ message: "event not found" }, 404);
  const order = await one(deps.db.from("market_orders").select(ORDER_COLUMNS).eq("id", ev.order_id).maybeSingle());
  if (!order) return json({ message: "order not found" }, 404);

  const toStatus = str(ev.to_status);
  const kinds = resolveEventMails({
    toStatus,
    actorRole: ev.actor_role === null || ev.actor_role === undefined ? null : str(ev.actor_role),
    paymentMethod: str(order.payment_method),
  });
  if (kinds.length === 0) return json({ data: { skipped: true, reason: `no mail for ${toStatus}` } });

  const { mail: mailOrder, supplier } = await loadMailOrder(deps.db, order);
  const transfer = kinds.includes("consumer_awaiting_payment")
    ? await one(deps.db.from("market_store_transfer").select("transfer_info").eq("supplier_id", order.supplier_id).maybeSingle())
    : null;
  const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Row;
  const ctx: EventContext = {
    order: mailOrder,
    buyerName: str(order.buyer_name),
    shipCity: str(order.ship_city),
    shipAddress: str(order.ship_address),
    buyerNote: order.buyer_note === null || order.buyer_note === undefined ? null : str(order.buyer_note),
    reason: str(ev.note).trim(),
    carrier: str(payload.carrier),
    trackingNo: str(payload.tracking_no),
    transferInfo: str(transfer?.transfer_info),
    supplierOrdersUrl: `${deps.config.siteUrl}/supplier/market/orders`,
    // 已收款:訂單上有 paid_at(套用狀態時寫入、之後不會清掉),或這筆紀錄本身就是從 paid 轉出(paid → cancelled)
    paid: (order.paid_at !== null && order.paid_at !== undefined) || ev.from_status === "paid",
  };

  const supplierEmail = str(supplier?.contact_email);
  const results: (DeliveryResult & { kind: EventMailKind })[] = [];
  const skipped: EventMailKind[] = [];
  for (const kind of kinds) {
    const audience: MarketAudience = kind.startsWith("supplier_") ? "supplier" : "consumer";
    const email = audience === "supplier" ? supplierEmail : str(order.buyer_email);
    if (!isDeliverableEmail(email)) {
      deps.log("error", { fn: "market-notify", step: "event", event_id: eventId, kind, error: "no deliverable email" });
      skipped.push(kind);
      continue;
    }
    const sent = await deliver(deps, live, { email, audience }, renderEventMail(kind, ctx), `${orderLabel(mailOrder.id)} → ${toStatus}`);
    results.push(...sent.map((r) => ({ ...r, kind })));
  }
  return summary(live, results, { kinds, skipped });
};

export const createMarketNotifyHandler =
  (deps: MarketNotifyDeps) =>
  async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ message: "Method not allowed" }, 405);
    if (!deps.secret) return json({ message: "NOTIFY_SECRET 未設定" }, 503);
    if ((req.headers.get("authorization") ?? "") !== `Bearer ${deps.secret}`) return json({ message: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => null)) as Row | null;
    const live = deps.isLive();
    // 🔴 帶了格式正確的 token(placed)時,這次請求的 log 一律先遮掉 token(格式不對的在 handlePlaced 直接 400,不會寫 log)
    const token = body?.kind === "placed" && typeof body.token === "string" && TOKEN_RE.test(body.token) ? body.token : "";
    const reqDeps: MarketNotifyDeps = token ? { ...deps, log: redactLog(deps.log, token) } : deps;
    try {
      if (body?.kind === "placed") return await handlePlaced(reqDeps, live, body);
      if (body?.kind === "event") return await handleEvent(reqDeps, live, body);
      return json({ message: "kind 必須是 placed 或 event" }, 400);
    } catch (e) {
      reqDeps.log("error", { fn: "market-notify", step: str(body?.kind), error: e instanceof Error ? e.message : "unknown error" });
      return json({ message: "internal error" }, 500);
    }
  };
