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

  it("429 兩次後成功:只寄出一封、三次都是同一個 Idempotency-Key、依序等 0.7 秒與 1.5 秒", async () => {
    const f = scripted(reply(429), reply(429), ok);
    const s = make(f.impl);
    await expect(s.run()).resolves.toEqual({ ok: true, id: "re_ok", error: null });
    expect(f.impl).toHaveBeenCalledTimes(3);
    expect(f.keys).toEqual([msg.idempotencyKey, msg.idempotencyKey, msg.idempotencyKey]);
    expect(s.waits).toEqual([700, 1500]);
    expect(s.retries).toEqual([
      { status: 429, attempt: 1 },
      { status: 429, attempt: 2 },
    ]);
  });

  it("一直 429:重試 3 次(共 4 次請求)後回失敗;等待是 0.7、1.5、2.5 秒加抖動(各不到 250 毫秒),總和不超過 5 秒", async () => {
    const f = scripted(reply(429, '{"name":"rate_limit_exceeded"}'));
    const s = make(f.impl, () => 0.999);
    await expect(s.run()).resolves.toEqual({ ok: false, id: null, error: 'Resend 429: {"name":"rate_limit_exceeded"}' });
    expect(f.impl).toHaveBeenCalledTimes(4);
    expect(s.waits).toEqual([949, 1749, 2302]); // 第 3 次只剩 5000 − 949 − 1749 = 2302 毫秒的額度
    expect(total(s.waits)).toBe(5_000);
    const calm = make(scripted(reply(429)).impl); // 沒有抖動:0.7 + 1.5 + 2.5 = 4.7 秒
    await calm.run();
    expect(calm.waits).toEqual([700, 1500, 2500]);
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
    expect(total(s2.waits)).toBeLessThanOrEqual(5_000);
  });

  it("有 retry-after 就照它的秒數等;超過 3 秒只等 3 秒;等待總和(5 秒)用完就不再重試", async () => {
    const f1 = scripted(reply(429, "{}", { "retry-after": "3" }), ok);
    const s1 = make(f1.impl);
    await expect(s1.run()).resolves.toMatchObject({ ok: true });
    expect(s1.waits).toEqual([3000]);

    const f2 = scripted(reply(429, "{}", { "retry-after": "30" }));
    const s2 = make(f2.impl);
    await expect(s2.run()).resolves.toMatchObject({ ok: false });
    expect(s2.waits).toEqual([3000, 2000]); // 30 秒只等 3 秒;第 2 次只剩 2 秒額度;之後額度用完,不再重試
    expect(f2.impl).toHaveBeenCalledTimes(3);
    expect(total(s2.waits)).toBe(5_000);

    const f3 = scripted(reply(503, "{}", { "retry-after": "2" }), reply(503, "{}", { "retry-after": "2" }), reply(503, "{}", { "retry-after": "2" }), ok);
    const s3 = make(f3.impl);
    await expect(s3.run()).resolves.toMatchObject({ ok: true });
    expect(s3.waits).toEqual([2000, 2000, 1000]); // 第 3 次只剩 1 秒額度
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
      await vi.advanceTimersByTimeAsync(950); // 第 1 次重試最多等 0.7 秒 + 250 毫秒抖動
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(f.impl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-10-12:總等待壓在 pg_net 的 8 秒逾時以內(5 秒)。Resend 的限速以秒計算,等 1–2 秒就夠讓同一次結帳的 4 封信都寄出
/** 假的 Resend:每一秒(依 Date.now(),測試用假的 timer)最多收 perSecond 封,超過回 429 */
const limitedResend = (perSecond: number) => {
  const accepted: { key: string; at: number }[] = [];
  let rejected = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const now = Date.now();
    const key = (init?.headers as Record<string, string>)["Idempotency-Key"];
    if (accepted.filter((a) => Math.floor(a.at / 1000) === Math.floor(now / 1000)).length >= perSecond) {
      rejected += 1;
      return new Response('{"name":"rate_limit_exceeded"}', { status: 429 });
    }
    accepted.push({ key, at: now });
    return new Response(JSON.stringify({ id: `re_${accepted.length}` }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, accepted, rejected: () => rejected };
};

describe("同一刻 4 封信、Resend 每秒只收 2 封(假的 timer,不真的等)", () => {
  const base = {
    from: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
    to: ["ifoodmaptw@gmail.com"],
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    replyTo: "ifoodmaptw@gmail.com",
  };

  it.each([
    ["沒有 retry-after", 0.5],
    ["抖動最大", 0.999],
    ["沒有抖動", 0],
  ])("%s:4 封最後都寄出、每個 key 只寄一次、每封總等待不超過 5 秒", async (_label, jitter) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const resend = limitedResend(2);
      const keys = ["placed", "store-a", "store-b", "store-c"].map((k) => `market-notify:${k}`);
      const waits = new Map<string, number>(keys.map((k) => [k, 0]));
      const all = Promise.all(
        keys.map((key) =>
          createMarketResendSender("re_key", resend.fetchImpl, {
            random: () => jitter,
            sleep: (ms) => {
              waits.set(key, (waits.get(key) ?? 0) + ms);
              return new Promise<void>((done) => setTimeout(done, ms));
            },
          })({ ...base, idempotencyKey: key }),
        ),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await all;
      expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
      expect(resend.accepted.map((a) => a.key).sort()).toEqual([...keys].sort());
      expect(resend.rejected()).toBeGreaterThan(0); // 真的碰到限速
      for (const [key, ms] of waits) expect(ms, key).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
