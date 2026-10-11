import { describe, expect, it, vi } from "vitest";
import { createMarketResendSender, createRetryBudget, retryAfterMs, type MarketRetryInfo, type RetryBudget } from "./send.ts";

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
  /** 注入假的時鐘與 sleep(sleep 只把假時鐘往前推,不真的等)與固定的亂數;額度是照時鐘算的截止時間 */
  const make = (impl: ReturnType<typeof scripted>["impl"], random = () => 0, clock = { t: 0 }) => {
    const waits: number[] = [];
    const retries: MarketRetryInfo[] = [];
    const now = () => clock.t;
    const send = createMarketResendSender("re_key", impl as unknown as typeof fetch, {
      sleep: async (ms) => {
        waits.push(ms);
        clock.t += ms;
      },
      random,
      now,
    });
    return {
      waits,
      retries,
      clock,
      now,
      run: (budget?: RetryBudget) => send({ ...msg, onRetry: (info) => retries.push(info), ...(budget ? { budget } : {}) }),
    };
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

  // 第 3 階段審查 M5:有 retry-after 時也加抖動(最多 0.5 秒),被擋的信不會在同一刻一起重試
  it("有 retry-after 時也加最多 0.5 秒的抖動(retry-after 先封頂 3 秒再加)", async () => {
    const s1 = make(scripted(reply(429, "{}", { "retry-after": "1" }), ok).impl, () => 0.999);
    await expect(s1.run()).resolves.toMatchObject({ ok: true });
    expect(s1.waits).toEqual([1499]);
    const s2 = make(scripted(reply(429, "{}", { "retry-after": "30" })).impl, () => 0.999);
    await s2.run();
    expect(s2.waits).toEqual([3499, 1501]); // 第 2 次只剩 5000 − 3499 毫秒
  });

  // 第 3 階段審查 Important:一次呼叫(一個 pg_net 請求)裡的信共用一個 5 秒的額度,寄信本身的時間也算在內
  it("同一次呼叫的兩封信共用一個 5 秒額度:不管寄幾封,等待加起來不超過 5 秒", async () => {
    const clock = { t: 0 };
    const first = make(scripted(reply(429)).impl, () => 0, clock);
    const second = make(scripted(reply(429)).impl, () => 0, clock);
    const budget = createRetryBudget(5_000, () => clock.t);
    await expect(first.run(budget)).resolves.toMatchObject({ ok: false });
    await expect(second.run(budget)).resolves.toMatchObject({ ok: false });
    expect(first.waits).toEqual([700, 1500, 2500]);
    expect(second.waits).toEqual([300]); // 第一封用掉 4.7 秒,第二封只剩 0.3 秒
    expect(total([...first.waits, ...second.waits])).toBe(5_000);
    expect(budget.remainingMs()).toBe(0);
  });

  it("寄信本身的時間也算進額度(額度是截止時間,不是等待的加總)", async () => {
    const clock = { t: 0 };
    const keys: string[] = [];
    const slow = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      clock.t += 1_000; // 每次請求要 1 秒
      return new Response("{}", { status: 429 });
    });
    const s = make(slow, () => 0, clock);
    await expect(s.run()).resolves.toMatchObject({ ok: false });
    // 0–1 秒請求、等 0.7、1.7–2.7 秒請求、等 1.5、4.2–5.2 秒請求;這時已過截止時間,不再等也不再重試
    expect(s.waits).toEqual([700, 1500]);
    expect(slow).toHaveBeenCalledTimes(3);
    expect(clock.t).toBe(5_200);
  });

  // 第 3 階段審查 M6:連線失敗之後重試,Resend 回 409 表示第一次的請求可能還在處理、其實已經寄出
  it("連線失敗後重試回 409:回失敗、標記第一次可能已經寄出;其他 409 照原本", async () => {
    const r1 = await make(scripted(boom, reply(409, '{"name":"concurrent_idempotent_requests"}')).impl).run();
    expect(r1).toEqual({ ok: false, id: null, error: 'Resend 409: {"name":"concurrent_idempotent_requests"}', maybeDelivered: true });
    const r2 = await make(scripted(reply(409)).impl).run();
    expect(r2).toEqual({ ok: false, id: null, error: "Resend 409: {}" });
    const r3 = await make(scripted(reply(503), reply(409)).impl).run();
    expect(r3).toEqual({ ok: false, id: null, error: "Resend 409: {}" });
  });

  // 部署前審查 m2:502、504(Resend 那邊可能還在處理)或請求逾時之後,同一個 key 回 409 也一樣可能已經寄出
  it("502、504、逾時之後重試回 409:也標記第一次可能已經寄出(中間隔了別的回應也算);500、503、429 之後的 409 照原本", async () => {
    const conflict = '{"name":"concurrent_idempotent_requests"}';
    for (const first of [502, 504]) {
      const r = await make(scripted(reply(first), reply(409, conflict)).impl).run();
      expect(r, String(first)).toEqual({ ok: false, id: null, error: `Resend 409: ${conflict}`, maybeDelivered: true });
    }
    await expect(make(scripted(reply(504), reply(429), reply(409)).impl).run()).resolves.toMatchObject({ maybeDelivered: true });
    // 逾時:第一個請求的 signal 已經中止(假的逾時),fetch 跟真的一樣丟出 signal.reason
    const timedOut = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(conflict, { status: 409 });
    });
    let made = 0;
    const timeoutOnce = (ms: number) => {
      made += 1;
      return made === 1 ? AbortSignal.abort(new DOMException(`${ms} ms`, "TimeoutError")) : new AbortController().signal;
    };
    const send = createMarketResendSender("re_key", timedOut as unknown as typeof fetch, { sleep: async () => undefined, random: () => 0, timeoutSignal: timeoutOnce });
    await expect(send(msg)).resolves.toEqual({ ok: false, id: null, error: `Resend 409: ${conflict}`, maybeDelivered: true });
    expect(timedOut).toHaveBeenCalledTimes(2);
    for (const first of [500, 503, 429]) {
      const r = await make(scripted(reply(first), reply(409)).impl).run();
      expect(r, String(first)).toEqual({ ok: false, id: null, error: "Resend 409: {}" });
    }
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

// 部署前審查 m1:截止時間只管「等多久再重試」,管不到已經送出、還在等回應的請求 —— 每個請求都要帶逾時
describe("每個請求都帶逾時(AbortSignal.timeout):剩下的額度和 3 秒取小的、下限 1 秒;逾時算連線失敗", () => {
  const msg = {
    from: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
    to: ["ifoodmaptw@gmail.com"],
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    replyTo: "ifoodmaptw@gmail.com",
    idempotencyKey: "market-notify:a9700000-0000-4000-8000-000000000005:consumer",
  };
  const keyOf = (init?: RequestInit) => (init?.headers as Record<string, string>)["Idempotency-Key"];

  it("逾時 = min(剩下的額度, 3 秒),下限 1 秒;額度用完了,下一封信的請求也有 1 秒;每個請求都帶這個 signal", async () => {
    const clock = { t: 0 };
    const made: { ms: number; signal: AbortSignal }[] = [];
    const impl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 429 }));
    const send = createMarketResendSender("re_key", impl as unknown as typeof fetch, {
      sleep: async (ms) => {
        clock.t += ms;
      },
      random: () => 0,
      now: () => clock.t,
      timeoutSignal: (ms) => {
        const signal = new AbortController().signal;
        made.push({ ms, signal });
        return signal;
      },
    });
    const budget = createRetryBudget(5_000, () => clock.t);
    await send({ ...msg, budget });
    // 請求在 0、0.7、2.2、4.7 秒送出,剩下 5、4.3、2.8、0.3 秒
    expect(made.map((m) => m.ms)).toEqual([3_000, 3_000, 2_800, 1_000]);
    await send({ ...msg, budget });
    // 第二封:剩 0.3 秒 → 1 秒;等 0.3 秒後額度用完 → 1 秒,之後不再重試
    expect(made.map((m) => m.ms).slice(4)).toEqual([1_000, 1_000]);
    expect(impl).toHaveBeenCalledTimes(6);
    impl.mock.calls.forEach(([, init], i) => expect(init?.signal, `第 ${i + 1} 個請求`).toBe(made[i].signal));
  });

  it("沒有注入時用 AbortSignal.timeout,signal 交給 fetch", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const impl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"id":"re_1"}', { status: 200 }));
      await expect(createMarketResendSender("re_key", impl as unknown as typeof fetch)(msg)).resolves.toEqual({ ok: true, id: "re_1", error: null });
      expect(spy.mock.calls).toEqual([[3_000]]);
      expect(impl.mock.calls[0][1]?.signal).toBe(spy.mock.results[0].value);
    } finally {
      spy.mockRestore();
    }
  });

  /** 假的 Resend:每個請求要 latencyMs 才回應(假的 timer);signal 中止時跟真的 fetch 一樣丟出 signal.reason */
  const slowResend = (latencyMs: number, respond: () => Response) => {
    const calls: { key: string; start: number; end: number; outcome: "response" | "aborted" }[] = [];
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const key = keyOf(init);
          const start = Date.now();
          const signal = init?.signal;
          if (signal?.aborted) return reject(signal.reason);
          const timer = setTimeout(() => {
            calls.push({ key, start, end: Date.now(), outcome: "response" });
            resolve(respond());
          }, latencyMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              calls.push({ key, start, end: Date.now(), outcome: "aborted" });
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    return { fetchImpl, calls };
  };
  /** 跟 AbortSignal.timeout 一樣時間到就以 TimeoutError 中止,但用 setTimeout(跟著假的 timer 走,不看執行環境) */
  const timerSignal = (ms: number): AbortSignal => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return ac.signal;
  };
  /** 推假的 timer,直到 done() 或推了 maxMs */
  const runUntil = async (done: () => boolean, maxMs = 15_000) => {
    for (let t = 0; t < maxMs && !done(); t += 50) await vi.advanceTimersByTimeAsync(50);
  };

  it.each([
    ["預設的 AbortSignal.timeout、抖動最大", undefined, 0.999],
    ["預設的 AbortSignal.timeout、沒有抖動", undefined, 0],
    ["setTimeout 做的逾時、抖動一半", timerSignal, 0.5],
  ])("Resend 每個請求要 2 秒、一直 429:同一次呼叫依序寄 2 封(共用額度),總時間不超過 7 秒 —— %s", async (_label, timeoutSignal, jitter) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const resend = slowResend(2_000, () => new Response('{"name":"rate_limit_exceeded"}', { status: 429 }));
      const send = createMarketResendSender("re_key", resend.fetchImpl as unknown as typeof fetch, {
        random: () => jitter,
        ...(timeoutSignal ? { timeoutSignal } : {}),
      });
      const started = Date.now();
      const budget = createRetryBudget(5_000); // handler 每次呼叫建一個
      let elapsed = -1;
      const pending = (async () => {
        const consumer = await send({ ...msg, idempotencyKey: "market-notify:e:consumer", budget });
        const supplier = await send({ ...msg, idempotencyKey: "market-notify:e:supplier", budget });
        elapsed = Date.now() - started;
        return [consumer, supplier];
      })();
      await runUntil(() => elapsed >= 0);
      const results = await pending;
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThanOrEqual(7_000); // 沒有逾時的話:第一封 7 秒(第 3 次請求在 5 秒送出、7 秒回來)、第二封再 2 秒,共 9 秒
      expect(results.map((r) => r.ok)).toEqual([false, false]);
      expect(results.map((r) => r.error)).toEqual(["Resend 請求逾時(1000 毫秒沒有回應)", "Resend 請求逾時(1000 毫秒沒有回應)"]);
      for (const c of resend.calls) expect(c.end - c.start, `${c.key} @${c.start - started}`).toBeLessThanOrEqual(3_000);
      expect(resend.calls.some((c) => c.outcome === "aborted")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("逾時算連線失敗:同一個 key 重試、onRetry 的狀態碼是 null;一直逾時就回失敗,訊息寫清楚逾時(各執行環境的 TimeoutError 訊息不一樣)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const resend = slowResend(4_000, () => new Response('{"id":"re_late"}', { status: 200 }));
      const retries: MarketRetryInfo[] = [];
      const started = Date.now();
      let elapsed = -1;
      const pending = createMarketResendSender("re_key", resend.fetchImpl as unknown as typeof fetch, { random: () => 0 })({
        ...msg,
        onRetry: (info) => retries.push(info),
      }).then((r) => {
        elapsed = Date.now() - started;
        return r;
      });
      await runUntil(() => elapsed >= 0);
      // 0 秒送出、3 秒逾時;等 0.7 秒;3.7 秒送出、只剩 1.3 秒 → 5 秒逾時;額度用完,不再重試
      await expect(pending).resolves.toEqual({ ok: false, id: null, error: "Resend 請求逾時(1300 毫秒沒有回應)" });
      expect(elapsed).toBe(5_000);
      expect(resend.calls.map((c) => [c.start - started, c.end - started, c.outcome])).toEqual([
        [0, 3_000, "aborted"],
        [3_700, 5_000, "aborted"],
      ]);
      expect(resend.calls.map((c) => c.key)).toEqual([msg.idempotencyKey, msg.idempotencyKey]);
      expect(retries).toEqual([{ status: null, attempt: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回應標頭到了、內文一直讀不完:一樣在逾時中止、算連線失敗而重試(同一個 key),不會卡住", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-12T03:00:00Z"));
    try {
      const keys: string[] = [];
      const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        keys.push(keyOf(init));
        if (keys.length > 1) return new Response('{"id":"re_ok"}', { status: 200 });
        const signal = init?.signal;
        // 真的 fetch:signal 也管回應內文,中止時內文讀到一半就失敗
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"id":'));
            signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200 });
      });
      const started = Date.now();
      let elapsed = -1;
      const pending = createMarketResendSender("re_key", impl as unknown as typeof fetch, { random: () => 0 })(msg).then((r) => {
        elapsed = Date.now() - started;
        return r;
      });
      await runUntil(() => elapsed >= 0);
      await expect(pending).resolves.toEqual({ ok: true, id: "re_ok", error: null });
      expect(elapsed).toBe(3_700); // 3 秒逾時、等 0.7 秒再送一次
      expect(keys).toEqual([msg.idempotencyKey, msg.idempotencyKey]);
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
