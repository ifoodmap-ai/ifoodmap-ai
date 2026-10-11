// 零售市集通知信的寄信閘門(比照 ../notify/gate.ts):
// 環境變數 MARKET_NOTIFY_LIVE 不是字串 "true" 時,所有信只寄到內部測試信箱(ifoodmaptw@gmail.com)、
// 主旨加「[測試轉寄]」、內文最前面列出原本的收件人。
// 🔴 寄給真實消費者要業主核准 —— 程式、計畫、部署步驟都不會打開 MARKET_NOTIFY_LIVE。
// 沒有 Deno / npm 相依,vitest 直接測(gate.test.ts)。
import { escapeHtml, isLive, TEST_INBOX, TEST_SUBJECT_PREFIX } from "../notify/gate.ts";

export { isLive, TEST_INBOX, TEST_SUBJECT_PREFIX };

/** 零售市集自己的閘門(跟餐廳訂單 notify 的 NOTIFY_LIVE 分開:那支開了,零售照樣關著) */
export const MARKET_LIVE_ENV = "MARKET_NOTIFY_LIVE";

/** index.ts 每次請求用 Deno.env.get 呼叫(不快取);只有剛好是字串 "true" 才算開放 */
export const marketLiveFromEnv = (get: (key: string) => string | undefined): boolean => isLive(get(MARKET_LIVE_ENV));

export type MarketAudience = "consumer" | "supplier";

export interface MarketRecipient {
  email: string;
  audience: MarketAudience;
}

export interface MarketDelivery {
  /** 實際寄到哪裡 */
  to: string;
  audience: MarketAudience;
  subject: string;
  /** 這封信原本要寄給誰(閘門開放時就是 [to]) */
  originalRecipients: string[];
  /** 轉寄時插在內文最前面的說明(HTML);閘門開放時為 null */
  forwardNote: string | null;
}

const AUDIENCE_LABEL: Record<MarketAudience, string> = { consumer: "消費者", supplier: "供應商" };

export const marketForwardNoteHtml = (emails: string[], audience: MarketAudience): string =>
  `<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:560px;margin:0 auto 8px;` +
  `padding:12px 16px;border:1px dashed #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;line-height:1.6">` +
  `${TEST_SUBJECT_PREFIX} 原本的收件人(${AUDIENCE_LABEL[audience]}):${emails.map(escapeHtml).join("、")}<br>` +
  `零售市集正式寄信尚未開放(MARKET_NOTIFY_LIVE 未開啟),這封信只寄到內部測試信箱,原收件人沒有收到。` +
  `</div>`;

/** live:每位收件人各一封;非 live:同一種收件對象合併成一封寄到 TEST_INBOX */
export const planMarketDeliveries = (recipients: MarketRecipient[], subject: string, live: boolean): MarketDelivery[] => {
  if (live) {
    return recipients.map((r) => ({ to: r.email, audience: r.audience, subject, originalRecipients: [r.email], forwardNote: null }));
  }
  const grouped = new Map<MarketAudience, string[]>();
  for (const r of recipients) {
    const list = grouped.get(r.audience) ?? [];
    if (!list.includes(r.email)) list.push(r.email);
    grouped.set(r.audience, list);
  }
  return [...grouped].map(([audience, emails]) => ({
    to: TEST_INBOX,
    audience,
    subject: `${TEST_SUBJECT_PREFIX} ${subject}`,
    originalRecipients: emails,
    forwardNote: marketForwardNoteHtml(emails, audience),
  }));
};
