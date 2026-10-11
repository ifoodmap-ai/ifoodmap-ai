// Edge Function:零售市集訂單通知(下單確認、新訂單、接單 / 待匯款 / 拒單 / 出貨 / 取消)。
// 由資料庫透過 pg_net 呼叫(migration 20261009130100 的 market_enqueue_notify);邏輯全在 handler.ts(vitest 測)。
//
// 部署(🔴 一定要 --no-verify-jwt:資料庫沒有使用者 JWT,改用共享密鑰 NOTIFY_SECRET 驗證;見 supabase/config.toml):
//   supabase functions deploy market-notify --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
//
// 讀的 secret(全部是既有的,不用新增):SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY(平台自動提供)、
//   NOTIFY_SECRET、RESEND_API_KEY、NOTIFY_FROM、SITE_URL、SUPPLIER_MAIL_REPLY_TO / LEAD_NOTIFY_TO。
// 🔴 MARKET_NOTIFY_LIVE 不是 "true" 時所有信只寄 ifoodmaptw@gmail.com、主旨加「[測試轉寄]」。
//    寄給真實消費者要業主核准 —— 不要自己設定這個 secret。
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, defaultLog } from "../_shared/db.ts";
import { mailConfigFromEnv } from "../_shared/supplier-mail.ts";
import { marketLiveFromEnv } from "./gate.ts";
import { createMarketNotifyHandler } from "./handler.ts";
import { createMarketResendSender } from "./send.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const config = mailConfigFromEnv((k) => Deno.env.get(k));

Deno.serve(
  createMarketNotifyHandler({
    db: db as unknown as Db,
    // 帶 Idempotency-Key 的 Resend 寄信(send.ts);這一行的寫法 handler.test.ts 有逐字比對
    send: createMarketResendSender(config.resendKey),
    config,
    secret: Deno.env.get("NOTIFY_SECRET") ?? "",
    // 每次請求重讀 MARKET_NOTIFY_LIVE(gate.ts;不快取)。這一行的寫法 handler.test.ts 有逐字比對
    isLive: () => marketLiveFromEnv((k) => Deno.env.get(k)),
    log: defaultLog,
  }),
);
