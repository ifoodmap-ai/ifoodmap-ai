import { describe, expect, it, vi } from "vitest";
import { createMarketResendSender, retryAfterMs, type MarketRetryInfo } from "./send.ts";

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

// 2026-10-12:Resend 預設每秒只收 2 個請求 —— 一次結帳 3 家店會同時送出 1 封下單確認 + 3 封新訂單信,有幾封會被回 429
describe("遇到限速、伺服器錯誤、連線失敗會重試(最多 3 次、同一個 Idempotency-Key)", () => {
  const msg = {
    from: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
    to: ["ifoodmaptw@gmail.com"],
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    replyTo: "ifoodmaptw@gmail.com",
    idempotencyKey: "market-notify:placed:a9500000-0000-4000-8000-000000000001",
  };
  const reply = (status: number, body = "{}", headers: Record<string, string> = {}) => () => new Response(body, { status, headers });
  const ok = reply(200, JSON.stringify({ id: "re_ok" }));
  const boom = () => {
    throw new TypeError("network down");
  };
  /** 依序回應的假 fetch(用完就一直用最後一個);記下每次的 Idempotency-Key */
  const scripted = (...steps: (() => Response)[]) => {
    const keys: string[] = [];
    const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return steps[Math.min(keys.length - 1, steps.length - 1)]();
    });
    return { impl, keys };
  };
  /** 注入假的 sleep(只記下要等多久,不真的等)與固定的亂數 */
  const make = (impl: ReturnType<typeof scripted>["impl"], random = () => 0) => {
    const waits: number[] = [];
    const retries: MarketRetryInfo[] = [];
    const send = createMarketResendSender("re_key", impl as unknown as typeof fetch, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random,
    });
    return { waits, retries, run: () => send({ ...msg, onRetry: (info) => retries.push(info) }) };
  };
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("429 兩次後成功:只寄出一封、三次都是同一個 Idempotency-Key、依序等 1 秒與 2 秒", async () => {
    const f = scripted(reply(429), reply(429), ok);
    const s = make(f.impl);
    await expect(s.run()).resolves.toEqual({ ok: true, id: "re_ok", error: null });
    expect(f.impl).toHaveBeenCalledTimes(3);
    expect(f.keys).toEqual([msg.idempotencyKey, msg.idempotencyKey, msg.idempotencyKey]);
    expect(s.waits).toEqual([1000, 2000]);
    expect(s.retries).toEqual([
      { status: 429, attempt: 1 },
      { status: 429, attempt: 2 },
    ]);
  });

  it("一直 429:重試 3 次(共 4 次請求)後回失敗;等待是 1、2、4 秒加抖動(各不到 250 毫秒),總和不超過 20 秒", async () => {
    const f = scripted(reply(429, '{"name":"rate_limit_exceeded"}'));
    const s = make(f.impl, () => 0.999);
    await expect(s.run()).resolves.toEqual({ ok: false, id: null, error: 'Resend 429: {"name":"rate_limit_exceeded"}' });
    expect(f.impl).toHaveBeenCalledTimes(4);
    expect(s.waits).toEqual([1249, 2249, 4249]);
    expect(total(s.waits)).toBeLessThanOrEqual(20_000);
    expect(s.retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("422、409 等 4xx(429 以外)不重試", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const f = scripted(reply(status));
      const s = make(f.impl);
      const r = await s.run();
      expect(r.ok, String(status)).toBe(false);
      expect(r.error, String(status)).toBe(`Resend ${status}: {}`);
      expect(f.impl, String(status)).toHaveBeenCalledTimes(1);
      expect(s.waits, String(status)).toEqual([]);
      expect(s.retries, String(status)).toEqual([]);
    }
  });

  it("5xx 會重試", async () => {
    const f = scripted(reply(500), reply(503), ok);
    const s = make(f.impl);
    await expect(s.run()).resolves.toMatchObject({ ok: true });
    expect(f.impl).toHaveBeenCalledTimes(3);
    expect(s.retries).toEqual([
      { status: 500, attempt: 1 },
      { status: 503, attempt: 2 },
    ]);
  });

  it("連線失敗(丟出例外)也重試;一直失敗就照原本的方式回失敗與原因", async () => {
    const f1 = scripted(boom, boom, ok);
    const s1 = make(f1.impl);
    await expect(s1.run()).resolves.toMatchObject({ ok: true });
    expect(s1.retries).toEqual([
      { status: null, attempt: 1 },
      { status: null, attempt: 2 },
    ]);
    const f2 = scripted(boom);
    const s2 = make(f2.impl);
    await expect(s2.run()).resolves.toEqual({ ok: false, id: null, error: "network down" });
    expect(f2.impl).toHaveBeenCalledTimes(4);
    expect(total(s2.waits)).toBeLessThanOrEqual(20_000);
  });

  it("有 retry-after 就照它的秒數等;超過 10 秒只等 10 秒;等待總和用完就不再重試", async () => {
    const f1 = scripted(reply(429, "{}", { "retry-after": "3" }), ok);
    const s1 = make(f1.impl);
    await expect(s1.run()).resolves.toMatchObject({ ok: true });
    expect(s1.waits).toEqual([3000]);

    const f2 = scripted(reply(429, "{}", { "retry-after": "30" }));
    const s2 = make(f2.impl);
    await expect(s2.run()).resolves.toMatchObject({ ok: false });
    expect(s2.waits).toEqual([10_000, 10_000]); // 第 3 次重試時已經等滿 20 秒,不再重試
    expect(f2.impl).toHaveBeenCalledTimes(3);
    expect(total(s2.waits)).toBeLessThanOrEqual(20_000);

    const f3 = scripted(reply(503, "{}", { "retry-after": "9" }), reply(503, "{}", { "retry-after": "9" }), reply(503, "{}", { "retry-after": "9" }), ok);
    const s3 = make(f3.impl);
    await expect(s3.run()).resolves.toMatchObject({ ok: true });
    expect(s3.waits).toEqual([9000, 9000, 2000]); // 第 3 次只剩 2 秒額度
  });

  it("retry-after 的寫法:秒數(可以有小數)、HTTP 日期;讀不出來回 null、過去的時間是 0", () => {
    const now = Date.parse("2026-10-12T03:00:00Z");
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs("1.5", now)).toBe(1500);
    expect(retryAfterMs("Mon, 12 Oct 2026 03:00:04 GMT", now)).toBe(4000);
    expect(retryAfterMs("Mon, 12 Oct 2026 02:59:00 GMT", now)).toBe(0);
    for (const v of [null, "", "soon", "-1"]) expect(retryAfterMs(v, now), String(v)).toBeNull();
  });

  it("沒有注入 sleep 時用 setTimeout 等(假的 timer,測試不真的等)", async () => {
    vi.useFakeTimers();
    try {
      const f = scripted(reply(429), ok);
      const pending = createMarketResendSender("re_key", f.impl as unknown as typeof fetch)(msg);
      await vi.advanceTimersByTimeAsync(1250); // 第 1 次重試最多等 1 秒 + 250 毫秒抖動
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(f.impl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
