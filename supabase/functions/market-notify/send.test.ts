import { describe, expect, it, vi } from "vitest";
import { createMarketResendSender } from "./send.ts";

describe("createMarketResendSender(Resend + Idempotency-Key)", () => {
  const msg = {
    from: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
    to: ["ifoodmaptw@gmail.com"],
    subject: "[測試轉寄] 訂單已取消 — 零售訂單 #000000A1",
    html: "<p>h</p>",
    text: "t",
    replyTo: "ifoodmaptw@gmail.com",
    idempotencyKey: "market-notify:a9700000-0000-4000-8000-000000000005:consumer",
  };

  it("帶 Idempotency-Key 標頭;其餘照 createResendSender(key 不放進信件內容)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    const send = createMarketResendSender("re_key", fetchImpl as unknown as typeof fetch);
    await expect(send(msg)).resolves.toEqual({ ok: true, id: "re_123", error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer re_key",
      "Content-Type": "application/json",
      "Idempotency-Key": "market-notify:a9700000-0000-4000-8000-000000000005:consumer",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: "<p>h</p>",
      text: "t",
      reply_to: "ifoodmaptw@gmail.com",
    });
  });

  it("Resend 回 409(同一個 key、內容不同):回失敗與原因", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"name":"invalid_idempotent_request"}', { status: 409 }));
    const send = createMarketResendSender("re_key", fetchImpl as unknown as typeof fetch);
    await expect(send(msg)).resolves.toEqual({ ok: false, id: null, error: 'Resend 409: {"name":"invalid_idempotent_request"}' });
  });

  it("沒有 RESEND_API_KEY:不送出", async () => {
    const fetchImpl = vi.fn();
    const send = createMarketResendSender("", fetchImpl as unknown as typeof fetch);
    await expect(send(msg)).resolves.toEqual({ ok: false, id: null, error: "RESEND_API_KEY 未設定" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
