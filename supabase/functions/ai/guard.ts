// 形象站 AI 防濫用 —— 純邏輯(2026-10-07)
//
// 呼叫者分級、額度數字、字數與歷史截斷、圖片檢查、[[標記]] 剝除、錯誤碼對應都在這裡。
// 這支檔案沒有任何 Deno / npm / 遠端 URL 相依:index.ts 引用它,vitest 直接測(guard.test.ts)。
// 數字的來源是業主 2026-10-07 核准的額度;改數字要同步改 docs/DEPLOY.md「AI 防濫用與註冊導流」。

// ---------------------------------------------------------------------
// action 與呼叫者分級
// ---------------------------------------------------------------------
export const ACTIONS = [
  "analyze-menu",
  "analyze-chat",
  "chat",
  "parse-delivery-note",
  "parse-catalog",
  "dish-ideas",
  "quote-draft",
] as const;
export type Action = (typeof ACTIONS)[number];

/** 形象站代理(landing tier)只開放這三個 */
export const LANDING_ACTIONS: readonly Action[] = ["chat", "analyze-menu", "analyze-chat"];

export const isAction = (v: unknown): v is Action =>
  typeof v === "string" && (ACTIONS as readonly string[]).includes(v);

/**
 * landing:形象站代理(header x-ifm-proxy-secret 對得上 IFM_AI_PROXY_SECRET)
 * user:帶真的使用者 access token
 * legacy:以上皆非、且沒開強制模式(過渡期相容舊前端)
 */
export type Tier = "landing" | "user" | "legacy";

/** 常數時間比較(不因第一個不同的字元提早結束);長度不同一律不相等 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

/** secret 沒設(空字串 / undefined)時永遠不成立 —— 不能讓「兩邊都是空的」被當成相符 */
export const proxySecretMatches = (secret: string | null | undefined, header: string | null | undefined): boolean =>
  typeof secret === "string" && secret.length > 0 && typeof header === "string" && timingSafeEqual(header, secret);

export const bearerToken = (authorization: string | null | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return m ? m[1] : null;
};

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * 不驗簽,只判斷「值不值得拿去問 auth.getUser」:anon / service_role 金鑰、新式 sb_ 金鑰、
 * 沒有 sub 的 JWT 都直接跳過(省一次網路往返)。真正的身分一律以 auth.getUser 的結果為準。
 */
export const looksLikeUserJwt = (token: string): boolean => {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    return (
      typeof payload?.sub === "string" &&
      payload.sub.length > 0 &&
      payload.role !== "anon" &&
      payload.role !== "service_role"
    );
  } catch {
    return false;
  }
};

export const resolveTier = (o: {
  landing: boolean;
  userId: string | null | undefined;
  enforce: string | null | undefined;
}): Tier | "reject" => {
  if (o.landing) return "landing";
  if (o.userId) return "user";
  return o.enforce === "1" ? "reject" : "legacy";
};

/**
 * 限流用的訪客 IP。x-ifm-client-ip 只在 landing tier 採信(代理自己填的);
 * legacy 取請求本身 x-forwarded-for 的第一段;其他情況(含 user tier)一律 "unknown"。
 * 這個值只拿去做 HMAC,不落地。
 */
export const clientIp = (tier: Tier, header: (name: string) => string | null | undefined): string => {
  const first = (v: string | null | undefined) => {
    const s = (v ?? "").split(",")[0].trim().toLowerCase();
    return s && s.length <= 64 ? s : null;
  };
  if (tier === "landing") return first(header("x-ifm-client-ip")) ?? "unknown";
  if (tier === "legacy") return first(header("x-forwarded-for")) ?? "unknown";
  return "unknown";
};

const parseIPv4 = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
};

/** IPv6 → 8 個 16-bit 數字(支援 :: 縮寫與結尾的 IPv4 寫法);格式不對回 null */
const parseIPv6 = (input: string): number[] | null => {
  let s = input;
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseIPv4(tail[2]);
    if (!v4) return null;
    s = tail[1] + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
};

/**
 * 限流用的 IP key(修訂 2 R6):IPv4 照舊用完整位址;IPv6 一律取 /64(同一個用戶端通常拿到一整段 /64,
 * 換位址不能換到新額度)。也處理 [v6]:port、v4:port、zone id(%eth0)、IPv4-mapped(::ffff:a.b.c.d → 當 IPv4)。
 * 認不出來的字串原樣回傳(一樣只拿去做 HMAC)。
 */
export const rateKeyIp = (raw: string): string => {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s || s === "unknown") return "unknown";
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) s = v4port[1];
  const v4 = parseIPv4(s);
  if (v4) return v4.join(".");
  if (!s.includes(":")) return s;
  const groups = parseIPv6(s.replace(/%.*$/, ""));
  if (!groups) return s;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
};

// ---------------------------------------------------------------------
// 被擋統計的批次寫入(修訂 2 R7):Edge Function 自己擋下的請求(UNAUTHORIZED、TOO_LONG…)不逐筆寫 DB,
// 每個 isolate 在記憶體累計,最多每 intervalMs 寫一次(isolate 結束前再補寫一次,盡力而為)——
// 所以 ai_guard_daily 裡這些碼是「近似值」;ai_rate_take 在 DB 端擋下的(RATE_LIMITED / DAILY_CAP / IMAGE_NOT_STORED)是精確值。
// ---------------------------------------------------------------------
export interface RejectionCount {
  tier: string;
  action: string;
  code: string;
  hits: number;
}

export const createRejectionBatcher = (opts: { intervalMs: number; now?: () => number }) => {
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, RejectionCount>();
  let lastFlush = Number.NEGATIVE_INFINITY;
  const drain = (): RejectionCount[] => {
    const out = [...pending.values()];
    pending.clear();
    return out;
  };
  return {
    note(tier: string, action: string, code: string): void {
      const key = `${tier}|${action}|${code}`;
      const cur = pending.get(key);
      if (cur) cur.hits += 1;
      else pending.set(key, { tier, action, code, hits: 1 });
    },
    /** 距離上次寫入滿 intervalMs 才交出累計值(第一次一定交出) */
    takeIfDue(): RejectionCount[] {
      if (pending.size === 0) return [];
      const t = now();
      if (t - lastFlush < opts.intervalMs) return [];
      lastFlush = t;
      return drain();
    },
    /** isolate 要結束了:不管間隔,全部交出 */
    takeAll(): RejectionCount[] {
      if (pending.size > 0) lastFlush = now();
      return drain();
    },
    pendingCount(): number {
      let n = 0;
      for (const v of pending.values()) n += v.hits;
      return n;
    },
  };
};

// ---------------------------------------------------------------------
// 各 tier 的輸入上限
// ---------------------------------------------------------------------
const MiB = 1024 * 1024;

export interface TierLimits {
  /** 最新一則 user 訊息的字數上限(超過回 TOO_LONG;只在 chat 檢查) */
  maxUserChars: number;
  /** 較舊的 user 訊息超過就截斷 */
  maxOlderUserChars: number;
  /** 非 user 的訊息每則截到這個長度 */
  maxModelChars: number;
  /** 送給 Gemini 的歷史合計字數(從最舊的開始丟) */
  maxHistoryChars: number;
  /** 送給 Gemini 的歷史最多幾則(null = 不限) */
  maxHistoryMessages: number | null;
  /** 送進來的 messages 裡 role=user 超過這個數回 CONVERSATION_LIMIT(null = 不限;只在 chat 檢查) */
  maxUserMessages: number | null;
  /** true:role 只收 user / model / assistant / bot,其他丟掉;false:沿用舊行為(非 user 一律當 model) */
  strictRoles: boolean;
  /** true:沒有文字的訊息不送給 Gemini */
  dropEmpty: boolean;
  maxImageBytes: number;
  /** null = 任何 image/*(對齊產品站 MenuUpload 的 file.type.startsWith("image/")) */
  imageMimes: readonly string[] | null;
  /** 圖片要不要比對檔頭(magic bytes)確認真的是白名單格式 */
  sniffImage: boolean;
  /** request body 上限(bytes) */
  maxBodyBytes: number;
  /** 其他 action(dish-ideas / quote-draft / parse-catalog 的文字)序列化後的字數上限 */
  maxPayloadChars: number;
  /** 存進 analysis_records.messages 的完整對話最多幾則(SPEC 修訂 2 R8;每則照上面的字數上限截斷) */
  maxStoredMessages: number;
  /** 存進 analysis_records.transcript 的字數上限(前端直接送 transcript 參數時用) */
  maxStoredTranscriptChars: number;
}

const PUBLIC_LIMITS: TierLimits = {
  maxUserChars: 300,
  maxOlderUserChars: 300,
  maxModelChars: 1000,
  maxHistoryChars: 4000,
  maxHistoryMessages: 20,
  maxUserMessages: 20,
  strictRoles: true,
  dropEmpty: true,
  maxImageBytes: 1.5 * MiB,
  imageMimes: ["image/jpeg", "image/png", "image/webp"],
  sniffImage: true,
  maxBodyBytes: 2.5 * MiB,
  maxPayloadChars: 8000,
  maxStoredMessages: 40,
  maxStoredTranscriptChars: 30000,
};

/** 登入使用者的圖片 / body 上限(對齊產品站 MenuUpload:任何 image/*、10 MB) */
const USER_IMAGE_LIMITS: Pick<TierLimits, "maxImageBytes" | "imageMimes" | "sniffImage" | "maxBodyBytes"> = {
  maxImageBytes: 10 * MiB,
  imageMimes: null,
  sniffImage: false,
  // 10 MB 圖片的 base64 約 13.4 MB,再留一點給其他欄位
  maxBodyBytes: 15 * MiB,
};

export const LIMITS: Record<Tier, TierLimits> = {
  landing: PUBLIC_LIMITS,
  // 修訂 2 R5:legacy 的文字上限跟形象站一樣,但圖片與 body 上限跟登入使用者一樣
  // (過渡期還開著的舊產品站分頁才不會被 1.5 MB / jpeg-png-webp 擋)
  legacy: { ...PUBLIC_LIMITS, ...USER_IMAGE_LIMITS },
  user: {
    maxUserChars: 2000,
    maxOlderUserChars: 2000,
    maxModelChars: 2000,
    maxHistoryChars: 12000,
    maxHistoryMessages: null,
    maxUserMessages: null,
    strictRoles: false,
    dropEmpty: false,
    ...USER_IMAGE_LIMITS,
    maxPayloadChars: 60000,
    maxStoredMessages: 40,
    maxStoredTranscriptChars: 80000,
  },
};

// ---------------------------------------------------------------------
// 額度(業主 2026-10-07 核准)
// ---------------------------------------------------------------------
export type RateCode = "RATE_LIMITED" | "DAILY_CAP" | "IMAGE_NOT_STORED";

export interface RateRule {
  /** 計數的 key(DB 端會再接上 |10m 或 |day) */
  bucket: string;
  window: "10m" | "day";
  limit: number;
  /** 超過時回哪個錯誤碼 */
  code: RateCode;
  /** 這次要加多少(預設 1;圖片存檔額度用 bytes) */
  cost?: number;
}

export type QuotaGroup = "chat" | "menu" | "extract" | "other";

export const quotaGroup = (action: Action): QuotaGroup =>
  action === "chat" ? "chat" : action === "analyze-menu" ? "menu" : action === "analyze-chat" ? "extract" : "other";

/**
 * landing / legacy 的個人額度(以 IP 計,數字兩級一樣)。
 * other(只有 legacy 打得到:dish-ideas / parse-* / quote-draft)契約沒寫個人額度,這裡自訂一組保守值。
 */
export const IP_QUOTA: Record<QuotaGroup, { tenMin: number | null; day: number }> = {
  chat: { tenMin: 20, day: 60 },
  menu: { tenMin: 5, day: 10 },
  extract: { tenMin: null, day: 10 },
  other: { tenMin: 5, day: 20 },
};

/**
 * 全站每日額度,landing 與 legacy 分開計、各自封頂(修訂 2 R5):legacy 的 IP 取自 x-forwarded-for 第一段、可以偽造,
 * 分開之後有人燒光 legacy 的額度也鎖不到形象站的真訪客。landing 打不到 other(403),所以是 0。
 */
export const SITE_QUOTA: Record<"landing" | "legacy", Record<QuotaGroup, number>> = {
  landing: { chat: 500, menu: 100, extract: 200, other: 0 },
  legacy: { chat: 100, menu: 20, extract: 40, other: 100 },
};

/** user tier:全部 action 合計(不佔形象站全站額度) */
export const USER_QUOTA = { tenMin: 60, day: 200 };

export const rateRules = (tier: Tier, action: Action, subject: string): RateRule[] => {
  if (tier === "user") {
    return [
      { bucket: `user:${subject}:all`, window: "10m", limit: USER_QUOTA.tenMin, code: "RATE_LIMITED" },
      { bucket: `user:${subject}:all`, window: "day", limit: USER_QUOTA.day, code: "RATE_LIMITED" },
    ];
  }
  const group = quotaGroup(action);
  const q = IP_QUOTA[group];
  // 個人額度的 bucket 也按 tier 分開:偽造 x-forwarded-for 的人吃不到真訪客(landing)的個人額度
  const ip = `ip:${tier}:${subject}:${group}`;
  const rules: RateRule[] = [];
  if (q.tenMin !== null) rules.push({ bucket: ip, window: "10m", limit: q.tenMin, code: "RATE_LIMITED" });
  rules.push({ bucket: ip, window: "day", limit: q.day, code: "RATE_LIMITED" });
  rules.push({ bucket: `site:${tier}:${group}`, window: "day", limit: SITE_QUOTA[tier][group], code: "DAILY_CAP" });
  return rules;
};

/**
 * 菜單照片存進 analysis_records.images 的每日總量(台北日,解碼後 bytes),三級分開計。
 * 超過時紀錄照存、只是不存圖 —— 免得有人用 analyze-menu 把 free 方案 500 MB 的 DB 塞滿。
 * (契約沒寫,這裡自訂;正常流量一天不到 5 MB)
 */
export const IMAGE_STORE_BUDGET: Record<Tier, number> = { landing: 20 * MiB, legacy: 20 * MiB, user: 40 * MiB };

export const imageStoreRule = (tier: Tier, bytes: number): RateRule => ({
  bucket: `store:${tier}-images`,
  window: "day",
  limit: IMAGE_STORE_BUDGET[tier],
  code: "IMAGE_NOT_STORED",
  cost: Math.max(1, Math.ceil(bytes)),
});

/** 同一筆 analysis 最多存幾張菜單照片(修訂 2 R1:形象站同一段對話的照片併進同一筆) */
export const MAX_IMAGES_PER_RECORD = 3;

/** 還放得下就回傳附加後的新陣列;已經滿了(或格式不對以外的情況照常處理)回 null —— 食材照樣合併,只是不再存圖 */
export const appendImage = (existing: unknown, dataUrl: string, max = MAX_IMAGES_PER_RECORD): unknown[] | null => {
  const list = Array.isArray(existing) ? existing : [];
  return list.length < max ? [...list, dataUrl] : null;
};

// ---------------------------------------------------------------------
// 輸出上限(generationConfig,所有 tier)
// thinking 的 token 也算在 maxOutputTokens 裡,所以 analyze-menu 實際能給答案的是 4096 - 512 = 3584。
// analyze-menu 原本定 2560:2026-07-28 實測大菜單輸出到 1,703 token,扣掉思考只剩約 20% 餘裕,
// 超過會被截斷成壞掉的 JSON → 2026-10-07 調成 4096(思考預算維持 512)。
// ---------------------------------------------------------------------
export interface OutputLimits {
  maxOutputTokens: number;
  thinkingBudget: number;
}

const OUTPUT_LIMITS: Partial<Record<Action, OutputLimits>> = {
  chat: { maxOutputTokens: 400, thinkingBudget: 0 },
  "analyze-chat": { maxOutputTokens: 1024, thinkingBudget: 0 },
  "analyze-menu": { maxOutputTokens: 4096, thinkingBudget: 512 },
};
const DEFAULT_OUTPUT: OutputLimits = { maxOutputTokens: 4096, thinkingBudget: 1024 };

export const outputLimitsFor = (action: string): OutputLimits =>
  OUTPUT_LIMITS[action as Action] ?? DEFAULT_OUTPUT;

// ---------------------------------------------------------------------
// 字數與歷史
// ---------------------------------------------------------------------
/** 字元數 = Unicode code point 數(emoji 算一個字);一定 ≤ JS 的 .length */
export const charLen = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** 超過就截到 max 個字(最後一個字換成「…」) */
export const truncateChars = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(0, max - 1)).join("") + "…";
};

/** 超過就只留最後 max 個字(前面補「…」)—— transcript 用,保留最近的對話 */
export const keepTailChars = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return "…" + cps.slice(cps.length - Math.max(0, max - 1)).join("");
};

export interface HistoryMessage {
  role: "user" | "model";
  text: string;
}

export const normalizeRole = (role: unknown, strict: boolean): "user" | "model" | null => {
  if (role === "user") return "user";
  if (!strict) return "model";
  // 兩個現有前端(產品站 Chatbot、形象站助手)送的都是 "bot",所以 bot 也當 model
  return role === "model" || role === "assistant" || role === "bot" ? "model" : null;
};

export type HistoryResult =
  | {
      ok: true;
      /** 送給 Gemini 的歷史(最後 N 則、合計字數上限) */
      messages: HistoryMessage[];
      /** 存檔用的完整對話(修訂 2 R8):不含圖片、每則照字數上限截斷、最多 maxStoredMessages 則(保留最後的) */
      stored: HistoryMessage[];
      userTextCount: number;
    }
  | { ok: false; code: "TOO_LONG" | "CONVERSATION_LIMIT"; limit: number };

/**
 * 把前端送來的 messages 變成可以送給 Gemini 的歷史。
 * enforceInput(chat 用):role=user 的則數超過 → CONVERSATION_LIMIT;最新一則 user 訊息太長 → TOO_LONG。
 *   analyze-chat 不擋(那是對話結束時把需求存檔,擋下來就丟了 lead),一律截斷。
 * imagePlaceholder(analyze-chat 用):只有圖片沒有文字的訊息寫成「[圖片]」,跟原本的 buildTranscript 一樣。
 * 回傳兩份:messages 給 Gemini(照 §3 截斷);stored 給 analysis_records(完整對話,只做每則截斷與 40 則上限)。
 */
export const prepareHistory = (
  raw: unknown,
  lim: TierLimits,
  opts: { enforceInput: boolean; imagePlaceholder: boolean },
): HistoryResult => {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const roleOf = (m: unknown) => (m && typeof m === "object" ? (m as { role?: unknown }).role : undefined);
  const textOf = (m: unknown): string => {
    const t = m && typeof m === "object" ? (m as { text?: unknown }).text : undefined;
    return typeof t === "string" ? t : t == null ? "" : String(t);
  };

  if (opts.enforceInput) {
    const userCount = list.filter((m) => roleOf(m) === "user").length;
    if (lim.maxUserMessages !== null && userCount > lim.maxUserMessages) {
      return { ok: false, code: "CONVERSATION_LIMIT", limit: lim.maxUserMessages };
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (roleOf(list[i]) !== "user") continue;
      if (charLen(textOf(list[i])) > lim.maxUserChars) return { ok: false, code: "TOO_LONG", limit: lim.maxUserChars };
      break;
    }
  }

  const out: HistoryMessage[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const role = normalizeRole(roleOf(m), lim.strictRoles);
    if (!role) continue;
    let text = textOf(m);
    if (!text && opts.imagePlaceholder) {
      const img = (m as { image?: unknown }).image;
      if (typeof img === "string" && img) text = "[圖片]";
    }
    if (lim.dropEmpty && !text.trim()) continue;
    text = truncateChars(text, role === "user" ? lim.maxOlderUserChars : lim.maxModelChars);
    out.push({ role, text });
  }
  const userTextCount = out.filter((m) => m.role === "user" && m.text.trim() && m.text !== "[圖片]").length;

  let kept = lim.maxHistoryMessages !== null ? out.slice(-lim.maxHistoryMessages) : out;
  let total = kept.reduce((s, m) => s + charLen(m.text), 0);
  while (kept.length > 1 && total > lim.maxHistoryChars) {
    total -= charLen(kept[0].text);
    kept = kept.slice(1);
  }
  if (kept.length === 1 && total > lim.maxHistoryChars) {
    kept = [{ ...kept[0], text: truncateChars(kept[0].text, lim.maxHistoryChars) }];
  }
  return { ok: true, messages: kept, stored: out.slice(-lim.maxStoredMessages), userTextCount };
};

/** 跟原本的 buildTranscript 同一個格式 */
export const buildTranscript = (msgs: HistoryMessage[]): string =>
  msgs.map((m) => `${m.role === "user" ? "客人" : "客服"}: ${m.text}`).join("\n");

/** 存進 analysis_records.messages:只留 role / text(不存圖片,菜單照片由 analyze-menu 另存),role 沿用前端的 user / bot */
export const toStoredMessages = (msgs: HistoryMessage[]): { role: "user" | "bot"; text: string }[] =>
  msgs.map((m) => ({ role: m.role === "user" ? "user" : "bot", text: m.text }));

// ---------------------------------------------------------------------
// chat 回覆的 [[標記]]
// ---------------------------------------------------------------------
export type Stage = "done" | "ended" | null;

/** 把 [[DONE]] / [[END]](以及任何 [[...]] 標記)從回覆移除,轉成 stage。兩個都有時 ended 優先(對話已結束) */
export const extractStage = (raw: string): { reply: string; stage: Stage } => {
  const names = [...raw.matchAll(/\[\[\s*([^\[\]]{0,40}?)\s*\]\]/g)].map((m) => m[1].trim().toUpperCase());
  const stage: Stage = names.includes("END") ? "ended" : names.includes("DONE") ? "done" : null;
  const reply = raw
    .replace(/\[\[[^\[\]]{0,40}\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { reply, stage };
};

/** 模型只吐出標記、沒有文字時的備用句(極少見);按鈕名稱跟形象站 landing/i18n.js 的 ctaRegister / ctaEmail 一致 */
export const stageFallbackReply = (stage: "done" | "ended", lang: unknown): string => {
  if (lang === "en") {
    return stage === "done"
      ? "Your request is all set. Tap “Sign up free” below to save it to an account — it becomes a draft purchase order automatically. Rather not sign up? Leave your email and we'll reach out."
      : "This assistant only helps with food and ingredient sourcing. Tap “Sign up free” below anytime — or leave your email and we'll reach out.";
  }
  return stage === "done"
    ? "需求整理好了!點下方「免費註冊」,剛剛聊的內容會自動變成你的採購單草稿;不想註冊?留下 Email,專人跟你聯絡。"
    : "這個助手只協助餐飲食材採購喔。需要找食材的時候,歡迎點下方「免費註冊」;不想註冊?留下 Email,專人跟你聯絡。";
};

// ---------------------------------------------------------------------
// analyze-chat(landing tier)的存檔規則
// ---------------------------------------------------------------------
export type ExtractReason = "register" | "lead" | "close";

/** 缺省或看不懂的值都當 close */
export const parseReason = (v: unknown): ExtractReason => (v === "register" || v === "lead" ? v : "close");

/** 規則 1:有文字的 user 訊息少於 2 則、而且只是關掉對話 → 不呼叫 Gemini、不存檔 */
export const shouldSkipTooShort = (userTextCount: number, reason: ExtractReason): boolean =>
  reason === "close" && userTextCount < 2;

/**
 * 規則 2 / 3:有通過驗證的同一段對話紀錄 → 合併更新那筆;
 * 否則抽到 0 項、又不是留 Email(lead)→ 不存檔;其餘新建一筆。
 */
export const persistDecision = (o: {
  hasTarget: boolean;
  extractedCount: number;
  reason: ExtractReason;
}): "merge" | "create" | "skip_no_ingredients" => {
  if (o.hasTarget) return "merge";
  if (o.extractedCount === 0 && o.reason !== "lead") return "skip_no_ingredients";
  return "create";
};

export interface Ingredient {
  name: string;
  quantity?: string;
  unit?: string;
  category?: string;
}

/** 原本 analyze-chat 的合併邏輯:同名(不分大小寫、去頭尾空白)以新的為準 */
export const mergeIngredients = (prev: unknown, next: Ingredient[]): Ingredient[] => {
  const byName = new Map<string, Ingredient>();
  for (const ing of Array.isArray(prev) ? prev : []) {
    const name = ing && typeof ing === "object" ? (ing as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name) byName.set(name.trim().toLowerCase(), ing as Ingredient);
  }
  for (const ing of next) if (ing?.name) byName.set(ing.name.trim().toLowerCase(), ing);
  return [...byName.values()];
};

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** claimToken = 32 bytes 隨機值的 base64url(43 字元、無 padding) */
export const isClaimToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);

// ---------------------------------------------------------------------
// 圖片
// ---------------------------------------------------------------------
export const base64DecodedBytes = (b64: string): number => {
  if (!b64) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};

/** 看檔頭判斷真正的格式(只認白名單那三種) */
export const sniffImageMime = (b64: string): string | null => {
  let bin: string;
  try {
    bin = atob(b64.slice(0, 24));
  } catch {
    return null;
  }
  const b = (i: number) => bin.charCodeAt(i);
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && bin.slice(1, 4) === "PNG" && b(4) === 0x0d && b(5) === 0x0a) return "image/png";
  if (bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP") return "image/webp";
  return null;
};

export type ImageCheck =
  | { ok: true; mimeType: string; data: string; bytes: number }
  | { ok: false; code: "UNSUPPORTED_IMAGE" | "IMAGE_TOO_LARGE" | "BAD_REQUEST"; message?: string };

/**
 * image 可以是純 base64 或 data URL(跟原本一樣:有逗號就取逗號後面)。
 * mimeType 沒帶時:data URL 裡寫的 → 都沒有就當 image/jpeg(原本的預設)。
 */
export const inspectImage = (image: unknown, mimeType: unknown, lim: TierLimits): ImageCheck => {
  if (typeof image !== "string" || !image) return { ok: false, code: "BAD_REQUEST", message: "image is required" };
  const comma = image.indexOf(",");
  const prefixMime = image.startsWith("data:") && comma > 0 ? /^data:([^;,]+)/.exec(image)?.[1] : undefined;
  const mime = (typeof mimeType === "string" && mimeType.trim() ? mimeType : prefixMime ?? "image/jpeg").trim().toLowerCase();

  const allowed = lim.imageMimes === null ? /^image\/[a-z0-9][a-z0-9.+-]{0,62}$/.test(mime) : lim.imageMimes.includes(mime);
  if (!allowed) return { ok: false, code: "UNSUPPORTED_IMAGE" };

  const data = (comma >= 0 ? image.slice(comma + 1) : image).replace(/\s+/g, "");
  const bytes = base64DecodedBytes(data);
  if (bytes > lim.maxImageBytes) return { ok: false, code: "IMAGE_TOO_LARGE" };
  if (!data || data.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return { ok: false, code: "BAD_REQUEST", message: "image is not valid base64" };
  }

  if (lim.sniffImage) {
    const real = sniffImageMime(data);
    if (!real || !(lim.imageMimes ?? []).includes(real)) return { ok: false, code: "UNSUPPORTED_IMAGE" };
    return { ok: true, mimeType: real, data, bytes };
  }
  return { ok: true, mimeType: mime, data, bytes };
};

// ---------------------------------------------------------------------
// 其他 action 的文字輸入量(dish-ideas / quote-draft / parse-catalog)
// ---------------------------------------------------------------------
export const payloadChars = (action: Action, body: Record<string, unknown>): number => {
  const size = (v: unknown) => {
    try {
      return JSON.stringify(v ?? null)?.length ?? 0;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  switch (action) {
    case "parse-catalog":
      return typeof body.text === "string" ? body.text.length : 0;
    case "dish-ideas":
      return size(body.ingredients) + size(body.seasonal) + (typeof body.cuisine === "string" ? body.cuisine.length : 0);
    case "quote-draft":
      return size(body.items) + size(body.catalog) + size(body.history);
    default:
      return 0;
  }
};

// ---------------------------------------------------------------------
// 錯誤回應:{ code, message, retryAfterSeconds? },429 另帶 Retry-After header
// ---------------------------------------------------------------------
export type ErrorCode =
  | "UNAUTHORIZED"
  | "ACTION_NOT_ALLOWED"
  | "TOO_LONG"
  | "IMAGE_TOO_LARGE"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_IMAGE"
  | "RATE_LIMITED"
  | "CONVERSATION_LIMIT"
  | "DAILY_CAP"
  | "AI_UPSTREAM"
  // 以下是契約表格以外、沿用舊行為的情況
  | "BAD_REQUEST"
  | "METHOD_NOT_ALLOWED"
  | "AI_UNAVAILABLE";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  ACTION_NOT_ALLOWED: 403,
  TOO_LONG: 413,
  IMAGE_TOO_LARGE: 413,
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415,
  RATE_LIMITED: 429,
  CONVERSATION_LIMIT: 429,
  DAILY_CAP: 429,
  AI_UPSTREAM: 502,
  BAD_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  AI_UNAVAILABLE: 503,
};

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "請先登入再使用 AI 功能",
  ACTION_NOT_ALLOWED: "這個 AI 功能不開放在官網使用",
  TOO_LONG: "訊息太長了,請精簡一點再送出",
  IMAGE_TOO_LARGE: "照片太大了,請換一張小一點的照片",
  BODY_TOO_LARGE: "送出的資料太大了",
  UNSUPPORTED_IMAGE: "只支援 JPG、PNG、WebP 格式的圖片",
  RATE_LIMITED: "使用得太頻繁了,請稍後再試",
  CONVERSATION_LIMIT: "這段對話已經很長了,請點下方註冊或留下 Email,由專人接手協助",
  DAILY_CAP: "今天的 AI 使用量已經滿了,請明天再試,或直接留下 Email 由專人聯絡",
  AI_UPSTREAM: "AI 服務暫時無法回應,請稍後再試",
  BAD_REQUEST: "請求格式不正確",
  METHOD_NOT_ALLOWED: "Method not allowed",
  AI_UNAVAILABLE: "AI 服務暫時無法使用,請稍後再試",
};

/** 429 沒拿到確切秒數時的預設值;CONVERSATION_LIMIT 等再久都不會解除,給一天 */
const DEFAULT_RETRY: Partial<Record<ErrorCode, number>> = {
  RATE_LIMITED: 600,
  DAILY_CAP: 3600,
  CONVERSATION_LIMIT: 86400,
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryAfterSeconds?: number;
  details?: string;
}

export const errorResponse = (
  code: ErrorCode,
  opts: { message?: string; retryAfterSeconds?: number | null; details?: string } = {},
): { status: number; body: ErrorBody; headers: Record<string, string> } => {
  const status = ERROR_STATUS[code];
  const body: ErrorBody = { code, message: opts.message ?? DEFAULT_MESSAGES[code] };
  const headers: Record<string, string> = {};
  if (status === 429) {
    const raw = Number(opts.retryAfterSeconds ?? DEFAULT_RETRY[code] ?? 60);
    const secs = Math.max(1, Math.ceil(Number.isFinite(raw) ? raw : 60));
    body.retryAfterSeconds = secs;
    headers["Retry-After"] = String(secs);
  }
  if (opts.details) body.details = opts.details;
  return { status, body, headers };
};

/** Gemini 原始錯誤只給登入使用者看(產品站原本就會顯示);形象站與舊前端一律不回 */
export const exposeUpstreamDetails = (tier: Tier): boolean => tier === "user";

export const tooLongMessage = (limit: number) => `訊息太長了,請精簡到 ${limit} 字以內再送出`;

export const imageMessages = (code: "UNSUPPORTED_IMAGE" | "IMAGE_TOO_LARGE", lim: TierLimits): string => {
  if (code === "IMAGE_TOO_LARGE") return `照片太大了(上限 ${lim.maxImageBytes / MiB} MB),請換一張小一點的照片`;
  return lim.imageMimes === null ? "只支援圖片檔" : "只支援 JPG、PNG、WebP 格式的圖片";
};

// ---------------------------------------------------------------------
// request body(有上限地讀;Content-Length 謊報或 chunked 也擋得住)
// ---------------------------------------------------------------------
export const readCappedText = async (
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  cap: number,
): Promise<{ ok: true; text: string } | { ok: false }> => {
  const declared = contentLength === null ? NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared > cap) return { ok: false };
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return { ok: false };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
};
