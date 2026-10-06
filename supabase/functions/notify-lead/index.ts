// Edge Function: 表單 lead 進站通知
//
// 由 partnership_leads / landing_leads 的 AFTER INSERT trigger 透過 pg_net 呼叫
// (見 migration 20260923120000_lead_notifications.sql)。
//
// 為什麼要有這支:
//   這兩張表對 anon 只開 INSERT、沒有任何 SELECT policy,而 27 個 admin 頁面
//   裡沒有一頁列出它們(只有 AnalysisDetailPage / AdminOrderDetailPage 會用
//   analysis_id 反查 landing_leads)。換句話說**表單送進來沒有人看得到**,
//   只能靠主動寄信通知。
//
// 為什麼掛在 DB 而不是前端:
//   形象站是純靜態站,表單直接用 PostgREST INSERT。瀏覽器端只管寫入,
//   寄信失敗不會讓使用者看到錯誤、lead 也不會掉 —— 解耦。
//
// 安全性:這支是 --no-verify-jwt 部署的(DB trigger 沒有使用者 JWT 可用),
// 改用共享密鑰 LEAD_HOOK_SECRET 驗證。沒有密鑰就回 401 ——
// 不能做成任何人都能打的公開寄信端點。
//
// 2026-09-28 起也處理「供應商入駐申請」(supplier_applications):
//   trigger 只帶申請 id 過來,要寄哪些信(申請者確認信、業主通知)、有沒有超過頻率限制,
//   都已經在資料庫裡決定好並排隊(migration 20260928180000_supplier_application_mail.sql)。
//   這裡只把排好隊的信寄出去,邏輯在 supplier-application.ts(有 vitest)。
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, defaultLog } from "../_shared/db.ts";
import { createResendSender, mailConfigFromEnv } from "../_shared/supplier-mail.ts";
import { NotFoundError, processSupplierApplication } from "./supplier-application.ts";
import { replyToAddress, shouldRetryWithoutReplyTo } from "./lead-email.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const HOOK_SECRET = Deno.env.get("LEAD_HOOK_SECRET") ?? "";

// 寄件網域必須在 Resend 驗證過。這個 Resend 帳號目前驗證過的是
// gathertaiwan.com 與 beunion.tw,ifoodmap.com.tw 還沒 ——
// 所以沿用 notify 那支已經在用的 gathertaiwan.com。
const FROM = Deno.env.get("LEAD_NOTIFY_FROM") ?? "iFoodmap 表單通知 <noreply@gathertaiwan.com>";
const TO = (Deno.env.get("LEAD_NOTIFY_TO") ?? "ifoodmaptw@gmail.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lead-hook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/** lead 內容是公開網路上任何人送進來的 —— 一定要跳脫,不然等於讓對方在業主信箱裡注入 HTML */
const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** 台北時間,方便業主直接對照 Supabase dashboard */
const taipei = (iso: unknown) => {
  if (!iso) return "";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d) + " (台北)";
};

interface Spec {
  label: string;
  /** 欄位順序 = 信裡的顯示順序;沒列到的欄位會自動補在最後,不會漏 */
  fields: Record<string, string>;
  subject: (r: Record<string, unknown>) => string;
  /** 可以直接回信的聯絡信箱欄位(格式有效才會設成 reply-to,見 replyToFor) */
  replyToField?: string;
}

const SPECS: Record<string, Spec> = {
  partnership_leads: {
    label: "異業合作",
    replyToField: "contact_email",
    fields: {
      company_name: "公司名稱",
      contact_name: "聯絡人",
      job_title: "職稱",
      contact_email: "Email",
      contact_phone: "電話",
      website: "網站",
      partner_type: "合作類型",
      message: "需求說明",
      lang: "語系",
      source: "來源",
      status: "狀態",
      user_agent: "瀏覽器",
    },
    subject: (r) => {
      const co = String(r.company_name ?? "").trim() || "(未填公司名)";
      const who = String(r.contact_name ?? "").trim();
      return `【異業合作】${co}${who ? ` — ${who}` : ""}`;
    },
  },
  landing_leads: {
    label: "食材需求",
    // 2026-10-07 起形象站以 Email 取代電話(migration 20261007100200 加的 contact_email)
    replyToField: "contact_email",
    fields: {
      company_name: "公司／店名",
      contact_email: "Email",
      contact_phone: "電話",
      contact_line: "LINE",
      items_text: "需要的品項",
      detail: "補充說明",
      source: "來源",
      status: "狀態",
      analysis_id: "菜單分析 ID",
      user_agent: "瀏覽器",
    },
    // landing_leads 沒有 contact_name 欄位,用店名 → Email → 電話 → LINE 依序當標題
    // (資料庫規定電話或 Email 至少要有一個,所以最後那個備用字樣只會出現在 constraint 之前的舊資料)
    subject: (r) => {
      const who = [r.company_name, r.contact_email, r.contact_phone, r.contact_line]
        .map((v) => String(v ?? "").trim()).find(Boolean) ?? "(未留聯絡方式)";
      return `【食材需求】${who}`;
    },
  },
};

/**
 * reply-to 只用格式有效的 Email(全站統一的規則在 lead-email.ts,跟資料庫 constraint 一字不差)。
 * 格式不對就不設 —— reply_to 不合法時寄信 API 可能整封拒收,業主反而收不到通知。
 */
const replyToFor = (spec: Spec, record: Record<string, unknown>): string | undefined =>
  spec.replyToField ? replyToAddress(record[spec.replyToField]) : undefined;

const buildHtml = (spec: Spec, record: Record<string, unknown>, table: string) => {
  const known = Object.keys(spec.fields);
  // 沒在 fields 裡列到的欄位也要顯示 —— 之後加欄位不用改這支就不會漏資料
  const extra = Object.keys(record).filter((k) => !known.includes(k) && k !== "id" && k !== "created_at");
  const order = [...known, ...extra];

  const rows = order
    .filter((k) => {
      const v = record[k];
      return v !== null && v !== undefined && String(v).trim() !== "";
    })
    .map((k) => {
      const label = spec.fields[k] ?? k;
      let v = String(record[k]);
      if (k === "user_agent" && v.length > 180) v = v.slice(0, 180) + "…";
      const val = esc(v).replace(/\n/g, "<br>");
      return `<tr>
        <td style="padding:9px 14px 9px 0;vertical-align:top;color:#64748b;font-size:13px;white-space:nowrap">${esc(label)}</td>
        <td style="padding:9px 0;vertical-align:top;color:#0f172a;font-size:14px;line-height:1.65">${val}</td>
      </tr>`;
    })
    .join("");

  return `
<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <div style="font-size:19px;font-weight:700;color:#059669;margin-bottom:6px">iFoodmap 食材地圖</div>
  <div style="font-size:13px;color:#94a3b8;margin-bottom:24px">官網有新的${esc(spec.label)}表單送出</div>

  <table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0">${rows}</table>

  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px">
  <table style="width:100%;border-collapse:collapse">
    <tr>
      <td style="padding:4px 14px 4px 0;color:#94a3b8;font-size:12px;white-space:nowrap">送出時間</td>
      <td style="padding:4px 0;color:#64748b;font-size:12px">${esc(taipei(record.created_at))}</td>
    </tr>
    <tr>
      <td style="padding:4px 14px 4px 0;color:#94a3b8;font-size:12px;white-space:nowrap">資料表</td>
      <td style="padding:4px 0;color:#64748b;font-size:12px"><code>public.${esc(table)}</code></td>
    </tr>
    <tr>
      <td style="padding:4px 14px 4px 0;color:#94a3b8;font-size:12px;white-space:nowrap">紀錄 ID</td>
      <td style="padding:4px 0;color:#64748b;font-size:12px;font-family:ui-monospace,monospace">${esc(record.id)}</td>
    </tr>
  </table>
  <p style="font-size:12px;color:#94a3b8;line-height:1.7;margin:16px 0 0">
    這是 iFoodmap 官網表單的系統通知信。原始資料在 Supabase 的
    <code>public.${esc(table)}</code>,可用上面的紀錄 ID 對照。
  </p>
</div>`;
};

const sendMail = async (subject: string, html: string, replyTo?: string) => {
  if (!RESEND_KEY) return { ok: false, err: "RESEND_API_KEY 未設定", id: null as string | null, status: null as number | null };
  const payload: Record<string, unknown> = { from: FROM, to: TO, subject, html };
  if (replyTo) payload.reply_to = replyTo;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, err: `Resend ${res.status}: ${text.slice(0, 300)}`, id: null, status: res.status };
    let id: string | null = null;
    try { id = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* ignore */ }
    return { ok: true, err: null as string | null, id, status: res.status };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : "unknown", id: null, status: null };
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ message: "Method not allowed" }, 405);

  // 沒設密鑰就整支停用,不要退化成公開端點
  if (!HOOK_SECRET) return json({ message: "LEAD_HOOK_SECRET 未設定" }, 503);

  // 自己寫的 pg_net trigger 用 Authorization: Bearer;
  // 若日後改用 Dashboard 的 Database Webhook,自訂 header 也接受
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const custom = req.headers.get("x-lead-hook-secret") ?? "";
  if (bearer !== HOOK_SECRET && custom !== HOOK_SECRET) {
    return json({ message: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null) as
    | { type?: string; table?: string; schema?: string; record?: Record<string, unknown> }
    | null;
  if (!body) return json({ message: "invalid JSON body" }, 400);

  const table = body.table ?? "";
  const record = body.record;
  if (!record || typeof record !== "object") return json({ message: "record is required" }, 400);

  // 供應商入駐申請:只寄資料庫裡排好隊(queued)的信,payload 裡只用得到申請 id
  if (table === "supplier_applications") {
    if (body.type && body.type !== "INSERT") {
      return json({ data: { skipped: true, reason: `ignoring ${body.type}` } });
    }
    try {
      const db = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      ) as unknown as Db;
      const result = await processSupplierApplication(
        {
          db,
          send: createResendSender(RESEND_KEY),
          config: mailConfigFromEnv((k) => Deno.env.get(k)),
          log: defaultLog,
        },
        record.id,
      );
      return json({ data: result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown";
      // pg_net 不會重試:至少在 function log 留下紀錄,排隊中的信可以用 supplier_application_mails 查到
      defaultLog("error", { at: "notify-lead.supplier_applications", application_id: String(record.id ?? ""), error: message });
      if (e instanceof NotFoundError) return json({ message }, 404);
      return json({ message: "supplier application mail failed", error: message }, 500);
    }
  }

  // 白名單 —— 只有這兩張表會照 record 內容寄信,別讓這支變成通用寄信機
  const spec = SPECS[table];
  if (!spec) return json({ data: { skipped: true, reason: `no spec for table ${table}` } });
  if (body.type && body.type !== "INSERT") {
    return json({ data: { skipped: true, reason: `ignoring ${body.type}` } });
  }

  const subject = spec.subject(record);
  const replyTo = replyToFor(spec, record);
  const html = buildHtml(spec, record, table);

  let r = await sendMail(subject, html, replyTo);
  // 保險(SPEC 修訂 2 R4):Resend 回 4xx 而且信上有 reply_to → 拿掉 reply_to 重寄一次,業主至少收得到
  if (!r.ok && shouldRetryWithoutReplyTo(r.status, replyTo)) {
    console.warn("[notify-lead] Resend rejected the mail with reply_to; retrying without it:", r.err);
    r = await sendMail(subject, html, undefined);
  }
  if (!r.ok) return json({ message: "send failed", error: r.err }, 502);

  return json({ data: { sent: true, to: TO, subject, resend_id: r.id, record_id: record.id } });
});
