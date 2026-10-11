// market-notify 寄信:沿用 _shared/supplier-mail.ts 的 createResendSender(信件內容、reply_to、錯誤處理、
// 錯誤內文只留前 300 字都一樣),只多帶 Resend 的 Idempotency-Key 標頭 —— 同一封信重送
// (pg_net 重送、有人重放同一個 event_id)時,Resend 24 小時內只寄一次(同一個 key、內容不同會回 409)。
// key 由 handler.ts 決定:狀態信 market-notify:<event_id>:<consumer|supplier>、下單確認 market-notify:placed:<checkout_id>。
// 沒有 Deno 相依,vitest 直接測(send.test.ts)。
import { createResendSender, type SendMail, type SendResult } from "../_shared/supplier-mail.ts";

export type MarketMailMessage = Parameters<SendMail>[0] & { idempotencyKey: string };
export type MarketSendMail = (msg: MarketMailMessage) => Promise<SendResult>;

export const createMarketResendSender =
  (apiKey: string, fetchImpl: typeof fetch = fetch): MarketSendMail =>
  ({ idempotencyKey, ...msg }) =>
    // createResendSender 送出的 headers 是一般物件(Authorization、Content-Type),在這裡補上 Idempotency-Key
    createResendSender(apiKey, (input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "Idempotency-Key": idempotencyKey } }),
    )(msg);
