// market-notify 寄信:沿用 _shared/supplier-mail.ts 的 createResendSender(信件內容、reply_to、錯誤處理、
// 錯誤內文只留前 300 字都一樣),多做兩件事:
//   1. 帶 Resend 的 Idempotency-Key 標頭 —— 同一封信重送(pg_net 重送、有人重放同一個 event_id、下面的重試)時,
//      Resend 24 小時內只寄一次(同一個 key、內容不同會回 409)。key 由 handler.ts 決定:
//      狀態信 market-notify:<event_id>:<consumer|supplier>、下單確認 market-notify:placed:<checkout_id>。
//   2. 遇到限速(429)、伺服器錯誤(5xx)或連線失敗(丟出例外)時重試,最多 3 次:回應有 retry-after 就照它等
//      (最多 3 秒,再加最多 0.5 秒抖動),沒有就依序等 0.7、1.5、2.5 秒加最多 0.25 秒抖動。
//      等待額度是「截止時間」(RetryBudget):handler 每次呼叫建一個 5 秒的額度,同一次呼叫的每封信共用,
//      寄信本身的時間也算在內 —— 一次呼叫不管寄幾封,重試都在截止時間前結束,整次呼叫落在 pg_net 的 8 秒逾時以內
//      (20261009130100 的 timeout_milliseconds)。沒給額度時,這封信自己一個 5 秒額度。
//      連線失敗、請求逾時、502、504(Resend 那邊可能還在處理)之後重試,Resend 回 409:同一個 key 的第一次請求
//      可能還在處理、其實已經寄出 → 結果標 maybeDelivered。
//      其他 4xx(422、409…)不重試。每次重試都用同一個 Idempotency-Key,Resend 自己去重,不會寄出兩封。
//      為什麼要重試:Resend 預設每秒只收 2 個請求,一次結帳 3 家店會同時送出 1 封下單確認 + 3 封新訂單信;
//      Resend 的限速以秒計算,等 1–2 秒就夠讓 4 封信都寄出。
//   3. 每個請求都帶 AbortSignal.timeout:截止時間只管「等多久再重試」,管不到已經送出、還在等回應的請求。
//      逾時取「剩下的額度」和 3 秒中較小的,下限 1 秒(額度用完了,還沒送過的信也有一次機會);送出請求到讀完回應內文都算在內。
//      逾時算連線失敗,照上面的規則決定要不要重試,也受同一個截止時間限制。
//      一次呼叫最多寄 2 封(取消紀錄的消費者 + 店家):第一封最後一次重試最多超過截止時間 1 秒、第二封最多再 1 秒,
//      整次呼叫(從 handler 收到請求算起)最多 7 秒加上寫 notifications —— Resend 很慢時也在 pg_net 的 8 秒以內。
// 沒有 Deno 相依,vitest 直接測(send.test.ts);等待用注入的 sleep、逾時可以注入 timeoutSignal,測試不會真的等。
import { createResendSender, type SendMail, type SendResult } from "../_shared/supplier-mail.ts";

/** 每次要重試之前回報(handler 用它記 log,經過 redactLog):只有狀態碼(連線失敗是 null)與第幾次重試 */
export interface MarketRetryInfo {
  status: number | null;
  attempt: number;
}

/**
 * 等待額度:建立時起算 totalMs 的截止時間,重試只在截止時間以前等(照時鐘算,寄信本身的時間也算在內,不是把等待加總)。
 * handler 每次呼叫建一個,給同一次呼叫的每封信共用。
 */
export interface RetryBudget {
  /** 離截止時間還有幾毫秒(過了是 0) */
  remainingMs(): number;
}

export type MarketMailMessage = Parameters<SendMail>[0] & {
  idempotencyKey: string;
  onRetry?: (info: MarketRetryInfo) => void;
  /** 跟同一次呼叫的其他信共用的額度;沒給就這封信自己一個 TOTAL_WAIT_CAP_MS 的額度 */
  budget?: RetryBudget;
};

/**
 * maybeDelivered:連線失敗、請求逾時、502、504 之後重試,Resend 回 409(同一個 key 的第一次請求還在處理)——
 * 第一次可能已經寄出
 */
export type MarketSendResult = SendResult & { maybeDelivered?: true };
export type MarketSendMail = (msg: MarketMailMessage) => Promise<MarketSendResult>;

/** 最多重試幾次(不含第一次) */
export const MAX_RETRIES = 3;
/** 沒有 retry-after 時,第 1、2、3 次重試前等多久 */
export const BACKOFF_MS = [700, 1500, 2500] as const;
/** 隨機抖動的上限(不含):同時被擋的幾封信錯開重試 */
export const JITTER_MS = 250;
/** retry-after 最多照著等多久 */
export const RETRY_AFTER_CAP_MS = 3_000;
/** 有 retry-after 時也加的抖動上限(不含):被擋的信不會在同一刻一起重試 */
export const RETRY_AFTER_JITTER_MS = 500;
/** 一次呼叫(或沒給額度時的一封信)的等待額度:壓在 pg_net 的 8 秒逾時以內(留時間給最後一次請求、冷啟動與寫 notifications) */
export const TOTAL_WAIT_CAP_MS = 5_000;

export const createRetryBudget = (totalMs: number = TOTAL_WAIT_CAP_MS, now: () => number = Date.now): RetryBudget => {
  const deadline = now() + totalMs;
  return { remainingMs: () => Math.max(0, deadline - now()) };
};

/** 每個請求(送出到讀完回應內文)最多等多久 */
export const REQUEST_TIMEOUT_CAP_MS = 3_000;
/** 每個請求至少給多久:額度快用完(甚至用完)時,這個請求也有機會等到回應 */
export const REQUEST_TIMEOUT_FLOOR_MS = 1_000;

/** 這個請求的逾時:剩下的額度和 3 秒取小的,下限 1 秒 */
export const requestTimeoutMs = (remainingMs: number): number =>
  Math.max(REQUEST_TIMEOUT_FLOOR_MS, Math.min(remainingMs, REQUEST_TIMEOUT_CAP_MS));

export interface MarketSenderOptions {
  /** 等待(測試注入假的,不會真的等);預設 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 抖動用的亂數(0 ≤ x < 1);預設 Math.random */
  random?: () => number;
  /** retry-after 是 HTTP 日期時的「現在」;預設 Date.now */
  now?: () => number;
  /** 每個請求的逾時 signal(測試注入跟著假 timer 走的);預設 AbortSignal.timeout */
  timeoutSignal?: (ms: number) => AbortSignal;
}

/** 這個狀態碼要不要重試:429 與 5xx 要;其他 4xx(422、409…)不要 */
export const isRetryableStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/**
 * 回這些狀態時,Resend 那邊可能還在處理這個請求(閘道替它回的錯誤:上游出錯、上游逾時):之後同一個 key 回 409,
 * 第一次可能已經寄出。500、503 是 Resend 自己處理完才回的錯誤,不算;連線失敗與請求逾時另外算。
 */
export const MAYBE_IN_FLIGHT_STATUSES: readonly number[] = [502, 504];

/** retry-after(秒數,可以有小數;或 HTTP 日期)換成要等幾毫秒;讀不出來回 null,過去的時間是 0 */
export const retryAfterMs = (value: string | null, now: number): number | null => {
  const v = (value ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (!/[A-Za-z]/.test(v)) return null; // HTTP 日期一定有星期 / 月份的英文;"-1" 之類的不當成日期
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
};

export const createMarketResendSender =
  (apiKey: string, fetchImpl: typeof fetch = fetch, opts: MarketSenderOptions = {}): MarketSendMail =>
  async ({ idempotencyKey, onRetry, budget, ...msg }) => {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    const random = opts.random ?? Math.random;
    const now = opts.now ?? Date.now;
    const timeoutSignal = opts.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
    const shared = budget ?? createRetryBudget(TOTAL_WAIT_CAP_MS, now);
    // 之前的請求可能還在 Resend 那邊處理(連線失敗、逾時、502、504):之後同一個 key 回 409,第一次可能已經寄出
    let maybeInFlight = false;
    let conflictAfterFailure = false;

    const fetchWithRetry = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // createResendSender 送出的 headers 是一般物件(Authorization、Content-Type),在這裡補上 Idempotency-Key;每次重試都一樣
      const withKey: RequestInit = { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "Idempotency-Key": idempotencyKey } };
      for (let retry = 0; ; retry += 1) {
        const timeoutMs = requestTimeoutMs(shared.remainingMs());
        const signal = timeoutSignal(timeoutMs);
        let res: Response | null = null;
        let failure: unknown = null;
        try {
          const raw = await fetchImpl(input, { ...withKey, signal });
          // 回應內文也在這裡讀完(signal 也管內文;標頭到了、內文卡住一樣會逾時),交給 createResendSender 的是讀好的回應
          const text = await raw.text();
          res = new Response(text === "" ? null : text, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
        } catch (e) {
          // 連線失敗、逾時都算可以重試;逾時換成固定的訊息(各執行環境 TimeoutError 的訊息不一樣)
          failure = signal.aborted ? new Error(`Resend 請求逾時(${timeoutMs} 毫秒沒有回應)`) : e;
        }
        const retryable = res === null || isRetryableStatus(res.status);
        const remaining = shared.remainingMs();
        if (!retryable || retry >= MAX_RETRIES || remaining <= 0) {
          // 不重試了:回應交給 createResendSender 照原本的方式判斷(失敗就是 Resend <狀態碼>: …);例外也照原本的方式處理
          if (res === null) throw failure;
          if (res.status === 409 && maybeInFlight) conflictAfterFailure = true;
          return res;
        }
        if (res === null || MAYBE_IN_FLIGHT_STATUSES.includes(res.status)) maybeInFlight = true;
        const hinted = res === null ? null : retryAfterMs(res.headers.get("retry-after"), now());
        const wish =
          hinted === null
            ? BACKOFF_MS[retry] + Math.floor(random() * JITTER_MS)
            : Math.min(hinted, RETRY_AFTER_CAP_MS) + Math.floor(random() * RETRY_AFTER_JITTER_MS);
        const wait = Math.min(wish, remaining);
        onRetry?.({ status: res === null ? null : res.status, attempt: retry + 1 });
        await sleep(wait);
      }
    };

    const result = await createResendSender(apiKey, fetchWithRetry)(msg);
    return !result.ok && conflictAfterFailure ? { ...result, maybeDelivered: true } : result;
  };
