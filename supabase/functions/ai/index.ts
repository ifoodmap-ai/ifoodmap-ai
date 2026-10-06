// Edge Function: ifoodmap AI
// Railway 停機後的常駐 AI 後端 — Gemini 走 REST,service-role 由平台注入。
//
// actions:
//   analyze-menu        菜單圖片 → 食材清單
//   analyze-chat        對話 → 食材清單(可續寫合併)
//   chat                客服對話回覆
//   parse-delivery-note 送貨單拍照 → 品項/數量/單價(收貨對帳)
//   parse-catalog       價目表照片 → 商品目錄(供應商自動上架)
//   dish-ideas          現有食材 + 當季便宜品項 → 新菜建議
//   quote-draft         詢價 + 歷史成交價 → 報價草稿
//
// 2026-10-07 防濫用(docs/DEPLOY.md「AI 防濫用與註冊導流」):
//   呼叫者分三級 —— landing(形象站代理,header x-ifm-proxy-secret = secret IFM_AI_PROXY_SECRET)、
//   user(Authorization: Bearer <使用者 access token>)、legacy(都不是,且 AI_ENFORCE_AUTH ≠ "1",過渡期相容舊前端)。
//   AI_ENFORCE_AUTH = "1" 之後 legacy 一律 401。每級有自己的額度(資料庫 RPC ai_rate_take 原子化計數)、
//   字數 / 歷史 / 圖片上限與輸出上限;數字、截斷、錯誤碼都在 guard.ts(純邏輯,有 vitest)。
//   形象站用自己的 chat prompt(landing-prompt.ts);產品站登入後的 CHAT_SYSTEM 一字不改。
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type Action,
  type ErrorCode,
  type HistoryMessage,
  type Tier,
  type TierLimits,
  LANDING_ACTIONS,
  LIMITS,
  appendImage,
  buildTranscript,
  clientIp,
  createRejectionBatcher,
  errorResponse,
  exposeUpstreamDetails,
  extractStage,
  imageMessages,
  imageStoreRule,
  inspectImage,
  isAction,
  isClaimToken,
  isUuid,
  keepTailChars,
  looksLikeUserJwt,
  bearerToken,
  mergeIngredients,
  outputLimitsFor,
  parseReason,
  payloadChars,
  persistDecision,
  prepareHistory,
  proxySecretMatches,
  rateKeyIp,
  rateRules,
  readCappedText,
  resolveTier,
  shouldSkipTooShort,
  stageFallbackReply,
  toStoredMessages,
  tooLongMessage,
} from "./guard.ts";
import { hmacHex16, newClaimToken, sha256Hex } from "./crypto.ts";
import { LANDING_CHAT_SYSTEM, LANDING_EN_BUTTONS } from "./landing-prompt.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
// 形象站代理與這支共用的密鑰(Vercel 形象站專案的 env 也要設同一個值);沒設 = landing tier 永不成立
const PROXY_SECRET = Deno.env.get("IFM_AI_PROXY_SECRET") ?? "";
// "1" = 強制模式:沒有合法身分一律 401;沒設 = 相容模式(舊前端走 legacy tier)
const ENFORCE_AUTH = Deno.env.get("AI_ENFORCE_AUTH") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // 429 的 Retry-After 要讓瀏覽器端讀得到
  "Access-Control-Expose-Headers": "Retry-After"
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** 錯誤一律 { code, message, retryAfterSeconds? };429 另帶 Retry-After header */
const fail = (code: ErrorCode, opts: { message?: string; retryAfterSeconds?: number | null; details?: string } = {}) => {
  const { status, body, headers } = errorResponse(code, opts);
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, ...headers, "Content-Type": "application/json" } });
};

/** 回應送出後還要跑完的寫入(用量、被擋統計);失敗不影響主流程 */
const background = (p: PromiseLike<unknown>) => {
  const done = Promise.resolve(p).then(() => {}, () => {});
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(done);
};

interface Ctx {
  tier: Tier;
  /** user tier 才有 */
  userId: string | null;
  /** 限流 key:user tier = user id;landing / legacy = HMAC(IP) 前 16 hex */
  subject: string;
  lim: TierLimits;
  lang: unknown;
}

// 被擋的請求記進 ai_guard_daily:ai_rate_take 擋下的在 DB 端逐筆記;這裡記 Edge Function 自己擋的(UNAUTHORIZED、TOO_LONG…)。
// 修訂 2 R7:不逐筆寫 DB(被大量直打時不能每個 401 都寫一次)—— 每個 isolate 在記憶體累計,最多每 60 秒寫一次,
// isolate 被回收前再補寫一次(盡力而為)。所以這些碼在 ai_guard_daily 是近似值。
const rejections = createRejectionBatcher({ intervalMs: 60_000 });
const writeRejections = (batch: { tier: string; action: string; code: string; hits: number }[]) => {
  for (const r of batch) {
    background(supabase.rpc("ai_note_rejection", { p_tier: r.tier, p_action: r.action, p_code: r.code, p_hits: r.hits }));
  }
};
const noteRejection = (tier: Tier | "none", action: string, code: ErrorCode) => {
  rejections.note(tier, action, code);
  writeRejections(rejections.takeIfDue());
};
(globalThis as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener?.(
  "beforeunload",
  () => writeRejections(rejections.takeAll())
);

const reject = (ctx: Ctx, action: Action, code: ErrorCode, message?: string) => {
  noteRejection(ctx.tier, action, code);
  return fail(code, { message });
};

interface Ingredient { name: string; quantity?: string; unit?: string; category?: string }
interface AnalysisResult { summary: string; ingredients: Ingredient[] }

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "一段繁體中文摘要,描述這份菜單/對話代表的採購需求重點" },
    ingredients: {
      type: "ARRAY",
      description: "餐廳需要採購的食材清單",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "食材名稱(繁體中文)" },
          quantity: { type: "STRING", description: "預估數量,例如 2、1.5、500" },
          unit: { type: "STRING", description: "單位,例如 kg、g、ml、份、包" },
          category: { type: "STRING", description: "分類,例如 肉類、海鮮、蔬菜、調味料、乾貨、其他" }
        },
        required: ["name"],
        propertyOrdering: ["name", "quantity", "unit", "category"]
      }
    }
  },
  required: ["summary", "ingredients"],
  propertyOrdering: ["summary", "ingredients"]
};

// 送貨單辨識 —— 收貨對帳用
const DELIVERY_NOTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    supplier_name: { type: "STRING", description: "送貨單上的供應商名稱,看不到就留空" },
    delivered_at: { type: "STRING", description: "送貨日期,格式 YYYY-MM-DD,看不到就留空" },
    items: {
      type: "ARRAY",
      description: "送貨單上的品項明細",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "品項名稱(繁體中文)" },
          quantity: { type: "NUMBER", description: "數量" },
          unit: { type: "STRING", description: "單位,如 kg、台斤、箱、包" },
          unit_price: { type: "NUMBER", description: "單價,沒有就填 0" },
          amount: { type: "NUMBER", description: "小計金額,沒有就填 0" }
        },
        required: ["name"],
        propertyOrdering: ["name", "quantity", "unit", "unit_price", "amount"]
      }
    },
    total: { type: "NUMBER", description: "總金額,看不到就填 0" }
  },
  required: ["items"],
  propertyOrdering: ["supplier_name", "delivered_at", "items", "total"]
};

// 價目表辨識 —— 供應商自動上架用
const CATALOG_SCHEMA = {
  type: "OBJECT",
  properties: {
    products: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "商品名稱(繁體中文)" },
          category: { type: "STRING", description: "分類:蔬菜/肉品/海鮮/菇類/米麵/豆製品/調味/其他" },
          price: { type: "NUMBER", description: "價格" },
          unit: { type: "STRING", description: "單位,如 kg、台斤、箱" },
          pack_size: { type: "STRING", description: "包裝規格,如 10kg/箱,沒有就留空" }
        },
        required: ["name"],
        propertyOrdering: ["name", "category", "price", "unit", "pack_size"]
      }
    }
  },
  required: ["products"]
};

// 新菜建議 —— 菜色實驗室用
const DISH_IDEAS_SCHEMA = {
  type: "OBJECT",
  properties: {
    dishes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "菜名(繁體中文,要像台灣餐廳會寫的菜名)" },
          description: { type: "STRING", description: "一句話說明賣點" },
          ingredients: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                quantity: { type: "NUMBER", description: "單份用量" },
                unit: { type: "STRING", description: "單位,預設 kg" }
              },
              required: ["name"],
              propertyOrdering: ["name", "quantity", "unit"]
            }
          },
          suggested_price: { type: "NUMBER", description: "建議售價(新台幣)" },
          reason: { type: "STRING", description: "為什麼現在推這道(季節性/成本/客群)" }
        },
        required: ["name", "ingredients"],
        propertyOrdering: ["name", "description", "ingredients", "suggested_price", "reason"]
      }
    }
  },
  required: ["dishes"]
};

// 報價草稿 —— 供應商線上報價用
const QUOTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unit: { type: "STRING" },
          unit_price: { type: "NUMBER", description: "建議單價" },
          amount: { type: "NUMBER", description: "小計" },
          note: { type: "STRING", description: "定價理由,如「參考近三次成交價」" }
        },
        required: ["name", "unit_price"],
        propertyOrdering: ["name", "quantity", "unit", "unit_price", "amount", "note"]
      }
    },
    total: { type: "NUMBER" },
    message: { type: "STRING", description: "給買家的一段繁體中文報價說明(2-3 句)" }
  },
  required: ["items", "total"],
  propertyOrdering: ["items", "total", "message"]
};

const ANALYSIS_SYSTEM = [
  "你是一個專業的餐飲供應鏈分析助手,服務對象是 ifoodmap(把餐廳菜單需求媒合到食材供應商的平台)。",
  "你的任務:從輸入(菜單圖片或客人對話)中,萃取出餐廳需要採購的食材清單,並寫一段簡短的繁體中文摘要。",
  "規則:",
  "1. ingredients 只列『可採購的原物料/食材』,不要列成品菜名。",
  "2. 數量與單位請依常識合理估計(例如一道牛肉麵需要的牛肉量);無法判斷時 quantity/unit 可留空。",
  "3. name 與 summary 一律使用繁體中文。",
  "4. 嚴格依照指定的 JSON schema 回傳,不要多加任何說明文字。"
].join("\n");

// 形象站首頁的搜尋列 / 分類籤會把關鍵字直接丟進這個對話(「我想找食材:有機葉菜」),
// 所以這支不是一問一答的客服,而是一場「訪談」:一次只問一題,把媒合需要的四件事問齊,
// 最後把人導去留聯絡方式(前端有 CTA 接手)。
// 2026-10-07 起形象站(landing tier)改用 landing-prompt.ts 的版本;這一份留給產品站登入後(user tier)
// 與過渡期的舊前端(legacy tier),業主要求維持現狀,內容不要改。
const CHAT_SYSTEM = [
  "你是 ifoodmap(食材地圖)的採購需求訪談助手,任務是在對話中把客人的食材需求問清楚,好讓平台幫他媒合供應商。",
  "用繁體中文,親切、專業、口語。每次回覆 2 到 4 句,不用 markdown 標題、不用清單符號。",
  "",
  "訪談原則:",
  "1. 一次只問一個問題,問完就停,等客人回答。不要一次列出好幾題。",
  "2. 順序:第一,確認要找的品項(有沒有規格、等級、有機或產銷履歷的要求);第二,數量與頻率(每次大約多少、多久叫一次);第三,配送區域(縣市與區);第四,用途或補充(餐廳、團膳、團購,預算,希望多久內開始)。客人已經講過的就不要重問,直接跳下一題。",
  "3. 客人第一句如果只是搜尋關鍵字(例如「有機葉菜」「火鍋肉片」「蔬菜」),先用一句話確認你理解的品項,接著就問數量與頻率。",
  "4. 四題問完,或客人明顯不想再答,就收尾:一句話總結需求,然後說明留下聯絡方式後,平台會把需求送給符合的供應商,通常 4 小時內開始有回覆,需求方完全免費。",
  "5. 不要憑空報價、不要保證有貨或有幾家會回覆;不確定的事就說會交給供應商回覆。"
].join("\n");

// 形象站有中英兩版(/ 與 /en)。英文訪客的每一句回覆、菜單分析的品名與摘要都要跟著換語言 ——
// 上面那幾個 system prompt 與 schema description 寫死「繁體中文」,所以這裡補一段優先級更高的
// 覆寫指令接在後面,而不是另外維護一整份英文 prompt(兩份會各自長歪)。
const EN_DIRECTIVE = [
  "",
  "LANGUAGE OVERRIDE — this instruction outranks every language rule above, including any field",
  "description in the JSON schema that says Traditional Chinese:",
  "The visitor is on the English site. Write every user-facing string in natural business English",
  "(replies, `name`, `summary`, `message`). Romanize Taiwanese place names (Taipei, Taichung,",
  "Da'an District). Keep the interview structure, tone and rules exactly as described above."
].join("\n");

const withLang = (system: string, lang: unknown): string =>
  lang === "en" ? system + "\n" + EN_DIRECTIVE : system;

type GPart = { text: string } | { inlineData: { mimeType: string; data: string } };

const geminiGenerate = async (
  contents: { role: string; parts: GPart[] }[],
  opts: { system: string; structured: boolean; temperature: number; schema?: unknown; action: Action; tier: Tier }
): Promise<string> => {
  // 輸出上限與思考預算(所有 tier 一致;思考 token 也算在 maxOutputTokens 裡)
  const out = outputLimitsFor(opts.action);
  const body: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: opts.system }] },
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens: out.maxOutputTokens,
      thinkingConfig: { thinkingBudget: out.thinkingBudget },
      ...(opts.structured
        ? { responseMimeType: "application/json", responseSchema: opts.schema ?? RESPONSE_SCHEMA }
        : {})
    }
  };
  const startedAt = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body)
    }
  );
  const data = await res.json().catch(() => null);
  const latency = Date.now() - startedAt;

  // 用量記錄供 /admin/ai-ops —— 失敗不影響主流程
  const usage = data?.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
    | undefined;
  background(supabase.from("ai_usage").insert({
    action: opts.action,
    model: MODEL,
    tier: opts.tier,
    prompt_tokens: usage?.promptTokenCount ?? null,
    completion_tokens: usage?.candidatesTokenCount ?? null,
    thoughts_tokens: usage?.thoughtsTokenCount ?? null,
    latency_ms: latency,
    ok: res.ok,
    error: res.ok ? null : JSON.stringify(data ?? {}).slice(0, 500)
  }));

  if (!res.ok) throw new Error(JSON.stringify(data ?? { status: res.status }));
  const parts = (data?.candidates?.[0]?.content?.parts ?? []) as { text?: string; thought?: boolean }[];
  const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Gemini 回傳空白內容");
  return text;
};

const parseAnalysis = (raw: string): AnalysisResult => {
  let parsed: Partial<AnalysisResult>;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Gemini 回傳非 JSON: ${raw.slice(0, 200)}`); }
  const list = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    ingredients: list
      .filter((i): i is Ingredient => Boolean(i) && typeof i.name === "string" && i.name.trim().length > 0)
      .map((i) => ({
        name: i.name.trim(),
        ...(i.quantity ? { quantity: String(i.quantity) } : {}),
        ...(i.unit ? { unit: String(i.unit) } : {}),
        ...(i.category ? { category: String(i.category) } : {})
      }))
  };
};

/** 存檔錯誤:登入使用者照舊看到原始訊息;形象站與舊前端只拿到一句話(原始訊息記在 function log) */
const shownPersistError = (ctx: Ctx, err: string | null): string | null => {
  if (!err) return null;
  console.error("[ai] analysis_records write failed:", err);
  return ctx.tier === "user" ? err : "存檔失敗";
};

// analysis_records 寫入。user tier 新建時 user_id = 呼叫者;landing tier 另存 claim_token_hash(token 本身不落地)
const persistAnalysis = async (
  o: {
    sourceType: "chatbot" | "menu_upload";
    result: AnalysisResult;
    transcript?: string;
    images?: string[];
    messages?: unknown[];
    claimTokenHash?: string | null;
  },
  ctx: Ctx
) => {
  const row: Record<string, unknown> = {
    source_type: o.sourceType,
    summary: o.result.summary,
    ingredient_list: o.result.ingredients,
    transcript: o.transcript ?? null,
    images: o.images && o.images.length ? o.images : null,
    messages: o.messages && o.messages.length ? o.messages : null,
    status: "pending_review"
  };
  if (ctx.tier === "user" && ctx.userId) row.user_id = ctx.userId;
  if (o.claimTokenHash) row.claim_token_hash = o.claimTokenHash;
  const { data, error } = await supabase.from("analysis_records").insert(row).select("id").single();
  if (error) return { analysisId: null as string | null, persistError: shownPersistError(ctx, error.message) };
  return { analysisId: (data as { id: string }).id, persistError: null as string | null };
};

// ---------------------------------------------------------------------
// 身分與額度
// ---------------------------------------------------------------------
const identify = async (req: Request): Promise<{ tier: Tier | "reject"; userId: string | null; subject: string }> => {
  const landing = proxySecretMatches(PROXY_SECRET, req.headers.get("x-ifm-proxy-secret"));
  let userId: string | null = null;
  if (!landing) {
    const token = bearerToken(req.headers.get("authorization"));
    // anon key / service_role key / 新式 sb_ 金鑰不是使用者,不用問 auth
    if (token && looksLikeUserJwt(token)) {
      try {
        const { data, error } = await supabase.auth.getUser(token);
        const user = data?.user as { id?: string; is_anonymous?: boolean } | null | undefined;
        if (!error && user?.id && !user.is_anonymous) userId = user.id;
      } catch (e) {
        console.error("[ai] auth.getUser failed:", e instanceof Error ? e.message : e);
      }
    }
  }
  const tier = resolveTier({ landing, userId, enforce: ENFORCE_AUTH });
  if (tier === "reject") return { tier, userId: null, subject: "" };
  if (tier === "user") return { tier, userId, subject: userId as string };
  // IP 不落地:只拿 HMAC 的前 16 hex 當限流 key;IPv6 先取 /64(修訂 2 R6)
  const ip = rateKeyIp(clientIp(tier, (name) => req.headers.get(name)));
  return { tier, userId: null, subject: await hmacHex16(PROXY_SECRET, ip) };
};

// 一次把這個請求要吃的額度都交給 DB(原子化;任何一條超過就整批不算、在 DB 端記一筆被擋)
const takeQuota = async (ctx: Ctx, action: Action): Promise<Response | null> => {
  try {
    const { data, error } = await supabase.rpc("ai_rate_take", {
      p_tier: ctx.tier,
      p_action: action,
      p_rules: rateRules(ctx.tier, action, ctx.subject)
    });
    if (error) throw new Error(error.message);
    const r = data as { ok?: boolean; code?: string; retry_after?: number } | null;
    if (r?.ok === true) return null;
    if (r?.code === "DAILY_CAP" || r?.code === "RATE_LIMITED") return fail(r.code, { retryAfterSeconds: r.retry_after });
    throw new Error(`unexpected ai_rate_take result: ${JSON.stringify(r)}`);
  } catch (e) {
    console.error("[ai] ai_rate_take failed:", e instanceof Error ? e.message : e);
    // 計數壞掉時:登入使用者照常服務(有帳號可追);形象站與舊前端寧可先停,不讓額度形同虛設
    if (ctx.tier === "user") return null;
    return fail("AI_UNAVAILABLE");
  }
};

// 菜單照片的每日存檔額度(guard.ts IMAGE_STORE_BUDGET);超過就只存文字,紀錄照存
const imageStoreAllowed = async (ctx: Ctx, action: Action, bytes: number): Promise<boolean> => {
  try {
    const { data, error } = await supabase.rpc("ai_rate_take", {
      p_tier: ctx.tier,
      p_action: action,
      p_rules: [imageStoreRule(ctx.tier, bytes)]
    });
    if (error) throw new Error(error.message);
    const ok = (data as { ok?: boolean } | null)?.ok === true;
    if (!ok) console.warn("[ai] daily image store budget reached; saving analysis without the photo");
    return ok;
  } catch (e) {
    console.error("[ai] image store budget check failed:", e instanceof Error ? e.message : e);
    return true;
  }
};

const imageReject = (ctx: Ctx, action: Action, code: "UNSUPPORTED_IMAGE" | "IMAGE_TOO_LARGE" | "BAD_REQUEST", message?: string) =>
  code === "BAD_REQUEST" ? fail("BAD_REQUEST", { message }) : reject(ctx, action, code, imageMessages(code, ctx.lim));

// ---------------------------------------------------------------------
// 「同一段對話」的那一筆:帶 analysisId(形象站還要 claimToken)且通過驗證才合併更新,否則新建
//   landing:token hash 相符、仍是 pending_review、來源是 chatbot / menu_upload、24 小時內建立、尚未被認領
//            (analyze-chat 與 analyze-menu 都用這組條件;修訂 2 R1)
//   user:只能更新 user_id = 自己的紀錄
//   legacy(過渡期舊前端):只能更新「沒有擁有者、不是形象站新流程建的」24 小時內待審紀錄
// 同一組條件同時用在查詢與更新,再加上 updated_at 樂觀鎖:查完到更新之間狀態變了不會改到,
// 兩個請求同時改同一筆(例如連傳兩張菜單)時後到的會重查、用最新內容重算一次,不會把對方的食材或照片蓋掉。
// ---------------------------------------------------------------------
interface MergeTarget {
  id: string;
  prev: unknown;
  images: unknown;
  updatedAt: string | null;
  claimToken: string | null;
  tokenHash: string | null;
}

const mergeFilters = <T>(q: T, ctx: Ctx, tokenHash: string | null): T => {
  // deno-lint-ignore no-explicit-any
  let f = q as any;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (ctx.tier === "landing") {
    f = f.eq("claim_token_hash", tokenHash).eq("status", "pending_review")
      .in("source_type", ["chatbot", "menu_upload"]).is("claimed_at", null).gte("created_at", since);
  } else if (ctx.tier === "user") {
    f = f.eq("user_id", ctx.userId);
  } else {
    f = f.is("user_id", null).is("claim_token_hash", null).is("claimed_at", null).eq("status", "pending_review")
      .in("source_type", ["chatbot", "menu_upload"]).gte("created_at", since);
  }
  return f as T;
};

const findMergeTarget = async (ctx: Ctx, body: Record<string, unknown>, withImages = false): Promise<MergeTarget | null> => {
  if (!isUuid(body.analysisId)) return null;
  let claimToken: string | null = null;
  let tokenHash: string | null = null;
  if (ctx.tier === "landing") {
    if (!isClaimToken(body.claimToken)) return null;
    claimToken = body.claimToken;
    tokenHash = await sha256Hex(claimToken);
  }
  // images 可能很大(base64),只有 analyze-menu 需要時才讀
  const cols = withImages ? "id, ingredient_list, updated_at, images" : "id, ingredient_list, updated_at";
  const { data, error } = await mergeFilters(
    supabase.from("analysis_records").select(cols).eq("id", body.analysisId),
    ctx,
    tokenHash
  ).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as { id: string; ingredient_list?: unknown; images?: unknown; updated_at?: unknown };
  return {
    id: row.id,
    prev: row.ingredient_list,
    images: row.images ?? null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    claimToken,
    tokenHash
  };
};

const updateMergeTarget = async (ctx: Ctx, t: MergeTarget, patch: Record<string, unknown>) => {
  // deno-lint-ignore no-explicit-any
  let q = mergeFilters(
    supabase.from("analysis_records").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", t.id),
    ctx,
    t.tokenHash
  ) as any;
  if (t.updatedAt) q = q.eq("updated_at", t.updatedAt);
  const { data, error } = await q.select("id");
  return { matched: Array.isArray(data) && data.length > 0, error: (error?.message as string | undefined) ?? null };
};

/**
 * 合併進同一筆:用那筆目前的內容算 patch、帶樂觀鎖更新;0 列(被別的請求改了)就重查重算一次。
 * 回傳 null = 已經沒有可以合併的紀錄(這段時間被認領 / 送審 / 過期了)→ 呼叫端照舊新建一筆。
 */
const mergeIntoTarget = async (
  ctx: Ctx,
  body: Record<string, unknown>,
  first: MergeTarget,
  buildPatch: (t: MergeTarget) => Record<string, unknown> | Promise<Record<string, unknown>>,
  withImages = false
): Promise<{ target: MergeTarget; patch: Record<string, unknown>; error: string | null } | null> => {
  let t: MergeTarget | null = first;
  for (let attempt = 0; attempt < 2 && t; attempt++) {
    const patch = await buildPatch(t);
    const upd = await updateMergeTarget(ctx, t, patch);
    if (upd.matched || upd.error) return { target: t, patch, error: upd.error };
    t = await findMergeTarget(ctx, body, withImages);
  }
  return null;
};

// ---------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------
const handleAnalyzeMenu = async (ctx: Ctx, body: Record<string, unknown>) => {
  const img = inspectImage(body.image, body.mimeType, ctx.lim);
  if (!img.ok) return imageReject(ctx, "analyze-menu", img.code, img.message);
  const limited = await takeQuota(ctx, "analyze-menu");
  if (limited) return limited;

  const raw = await geminiGenerate(
    [{ role: "user", parts: [
      { text: "這是一張餐廳菜單的照片。請辨識上面的菜色,推算需要採購的食材清單與摘要。" },
      { inlineData: { mimeType: img.mimeType, data: img.data } }
    ] }],
    { system: withLang(ANALYSIS_SYSTEM, ctx.lang), structured: true, temperature: 0.2, action: "analyze-menu", tier: ctx.tier }
  );
  const result = parseAnalysis(raw);
  const dataUrl = `data:${img.mimeType};base64,${img.data}`;
  // 每日圖片存量只檢查(扣)一次,合併失敗改成新建時沿用同一個結果
  let imageBudget: boolean | null = null;
  const imageAllowed = async () => (imageBudget ??= await imageStoreAllowed(ctx, "analyze-menu", img.bytes));

  // 修訂 2 R1:形象站帶了同一段對話的 analysisId + claimToken(驗證條件同 analyze-chat)→ 併進那一筆、回同一組。
  // 食材以名稱去重合併;照片附加到 images(同一筆最多 3 張,仍受每日圖片存量上限)。回應的 summary / ingredients 是這張照片的結果。
  if (ctx.tier === "landing") {
    const first = await findMergeTarget(ctx, body, true);
    if (first) {
      const merged = await mergeIntoTarget(ctx, body, first, async (t) => {
        const patch: Record<string, unknown> = { ingredient_list: mergeIngredients(t.prev, result.ingredients) };
        if (result.summary) patch.summary = result.summary;
        const images = appendImage(t.images, dataUrl);
        if (images && await imageAllowed()) patch.images = images;
        return patch;
      }, true);
      if (merged) {
        return json({ data: {
          analysisId: merged.target.id,
          claimToken: merged.target.claimToken,
          persistError: shownPersistError(ctx, merged.error),
          ...result
        } });
      }
    }
  }

  // 照舊每張存一筆(pending_review);形象站另外拿一組 claimToken,註冊後用來認領
  const claimToken = ctx.tier === "landing" ? newClaimToken() : null;
  const saved = await persistAnalysis({
    sourceType: "menu_upload",
    result,
    images: (await imageAllowed()) ? [dataUrl] : undefined,
    claimTokenHash: claimToken ? await sha256Hex(claimToken) : null
  }, ctx);
  if (ctx.tier === "landing") {
    return json({ data: {
      analysisId: saved.analysisId,
      claimToken: saved.analysisId ? claimToken : null,
      persistError: saved.persistError,
      ...result
    } });
  }
  return json({ data: { analysisId: saved.analysisId, persistError: saved.persistError, ...result } });
};

const createFromChat = async (
  ctx: Ctx,
  result: AnalysisResult,
  transcript: string,
  stored: unknown[] | undefined,
  reason: ReturnType<typeof parseReason>
) => {
  if (ctx.tier === "landing") {
    if (persistDecision({ hasTarget: false, extractedCount: result.ingredients.length, reason }) === "skip_no_ingredients") {
      return json({ data: { analysisId: null, claimToken: null, skipped: "no_ingredients", summary: result.summary, ingredients: [] } });
    }
    const claimToken = newClaimToken();
    const saved = await persistAnalysis(
      { sourceType: "chatbot", result, transcript, messages: stored, claimTokenHash: await sha256Hex(claimToken) },
      ctx
    );
    return json({ data: {
      analysisId: saved.analysisId,
      claimToken: saved.analysisId ? claimToken : null,
      persistError: saved.persistError,
      summary: result.summary,
      ingredients: result.ingredients
    } });
  }
  const saved = await persistAnalysis({ sourceType: "chatbot", result, transcript, messages: stored }, ctx);
  return json({ data: { analysisId: saved.analysisId, persistError: saved.persistError, ...result } });
};

const handleAnalyzeChat = async (ctx: Ctx, body: Record<string, unknown>) => {
  const hasMessages = Array.isArray(body.messages);
  const hist = prepareHistory(body.messages, ctx.lim, { enforceInput: false, imagePlaceholder: true });
  const forModel: HistoryMessage[] = hist.ok ? hist.messages : [];
  const full: HistoryMessage[] = hist.ok ? hist.stored : [];
  const userTextCount = hist.ok ? hist.userTextCount : 0;
  // 送給 Gemini 的照 §3 截斷;存進 DB 的是完整對話(修訂 2 R8:不含圖片、每則截斷、最多 40 則)。
  // transcript 參數:形象站忽略(只從 messages 組);其他 tier 沿用,兩份各自有字數上限
  const rawTranscript = ctx.tier !== "landing" && typeof body.transcript === "string" && body.transcript
    ? body.transcript
    : null;
  const transcript = rawTranscript ? keepTailChars(rawTranscript, ctx.lim.maxHistoryChars) : buildTranscript(forModel);
  const storedTranscript = rawTranscript
    ? keepTailChars(rawTranscript, ctx.lim.maxStoredTranscriptChars)
    : buildTranscript(full);
  if (!transcript) return fail("BAD_REQUEST", { message: "Provide messages[] or transcript" });
  const stored = hasMessages ? toStoredMessages(full) : undefined;
  const reason = parseReason(body.reason);
  const landing = ctx.tier === "landing";

  if (landing && shouldSkipTooShort(userTextCount, reason)) {
    return json({ data: { analysisId: null, claimToken: null, skipped: "too_short" } });
  }

  const limited = await takeQuota(ctx, "analyze-chat");
  if (limited) return limited;

  const extract = async () => parseAnalysis(await geminiGenerate(
    [{ role: "user", parts: [{ text: [
      "以下是客人與 ifoodmap 客服機器人的對話。請整理出客人實際的食材採購需求,並寫一段摘要。",
      "", "=== 對話開始 ===", transcript, "=== 對話結束 ==="
    ].join("\n") }] }],
    { system: withLang(ANALYSIS_SYSTEM, ctx.lang), structured: true, temperature: 0.2, action: "analyze-chat", tier: ctx.tier }
  ));

  const target = await findMergeTarget(ctx, body);
  if (target) {
    // 沿用原本的合併邏輯;抽取失敗時至少把對話內容更新上去
    let result: AnalysisResult | null = null;
    try {
      result = await extract();
    } catch (e) {
      console.error("[ai] analyze-chat extract failed (merge path):", e instanceof Error ? e.message : e);
    }
    const pairOf = (t: MergeTarget) => (landing ? { claimToken: t.claimToken } : {});
    if (result) {
      const r = result;
      const merged = await mergeIntoTarget(ctx, body, target, (t) => {
        const patch: Record<string, unknown> = {
          transcript: storedTranscript,
          ingredient_list: mergeIngredients(t.prev, r.ingredients)
        };
        if (r.summary) patch.summary = r.summary;
        if (stored) patch.messages = stored;
        return patch;
      });
      if (merged) {
        return json({ data: {
          analysisId: merged.target.id, ...pairOf(merged.target), persistError: shownPersistError(ctx, merged.error),
          summary: r.summary, ingredients: merged.patch.ingredient_list
        } });
      }
      // 這段時間被認領 / 送審 / 過期了:當作沒帶,新建一筆
      return await createFromChat(ctx, r, storedTranscript, stored, reason);
    }
    const merged = await mergeIntoTarget(ctx, body, target, () => {
      const patch: Record<string, unknown> = { transcript: storedTranscript };
      if (stored) patch.messages = stored;
      return patch;
    });
    const t = merged?.target ?? target;
    return json({ data: {
      analysisId: t.id, ...pairOf(t), persistError: shownPersistError(ctx, merged?.error ?? null), summary: null, ingredients: []
    } });
  }

  return await createFromChat(ctx, await extract(), storedTranscript, stored, reason);
};

const handleChat = async (ctx: Ctx, body: Record<string, unknown>) => {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return fail("BAD_REQUEST", { message: "messages is required" });
  }
  const hist = prepareHistory(body.messages, ctx.lim, { enforceInput: true, imagePlaceholder: false });
  if (!hist.ok) return reject(ctx, "chat", hist.code, hist.code === "TOO_LONG" ? tooLongMessage(hist.limit) : undefined);
  if (hist.messages.length === 0) return fail("BAD_REQUEST", { message: "messages is required" });
  const limited = await takeQuota(ctx, "chat");
  if (limited) return limited;

  const contents = hist.messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] as GPart[] }));
  // 只有形象站換新版 prompt(英文版另外接上英文網站的按鈕名稱);
  // 產品站登入後(以及過渡期的舊前端)沿用原本的 CHAT_SYSTEM
  const system = ctx.tier === "landing"
    ? withLang(LANDING_CHAT_SYSTEM, ctx.lang) + (ctx.lang === "en" ? "\n" + LANDING_EN_BUTTONS : "")
    : withLang(CHAT_SYSTEM, ctx.lang);
  const raw = await geminiGenerate(contents, {
    system, structured: false, temperature: 0.6, action: "chat", tier: ctx.tier
  });
  const { reply, stage } = extractStage(raw);
  if (!reply && !stage) throw new Error("Gemini 回傳空白內容");
  return json({ data: { reply: reply || stageFallbackReply(stage as "done" | "ended", ctx.lang), stage } });
};

// 送貨單比對只限呼叫者看得到的訂單:該店已接受、啟用中的成員,或該單供應商的啟用帳號
const readableOrder = async (userId: string, orderId: string): Promise<{ ingredient_list: unknown } | null> => {
  const { data } = await supabase
    .from("supplier_orders").select("id, restaurant_id, supplier_id, ingredient_list").eq("id", orderId).maybeSingle();
  const order = data as { restaurant_id: string | null; supplier_id: string | null; ingredient_list: unknown } | null;
  if (!order) return null;
  if (order.restaurant_id) {
    const { data: member } = await supabase.from("restaurant_accounts").select("id")
      .eq("user_id", userId).eq("restaurant_id", order.restaurant_id).eq("is_active", true)
      .not("accepted_at", "is", null).limit(1);
    if (Array.isArray(member) && member.length > 0) return order;
  }
  if (order.supplier_id) {
    const { data: member } = await supabase.from("supplier_accounts").select("id")
      .eq("user_id", userId).eq("supplier_id", order.supplier_id).eq("is_active", true).limit(1);
    if (Array.isArray(member) && member.length > 0) return order;
  }
  return null;
};

const handleDeliveryNote = async (ctx: Ctx, body: Record<string, unknown>) => {
  const img = inspectImage(body.image, body.mimeType, ctx.lim);
  if (!img.ok) return imageReject(ctx, "parse-delivery-note", img.code, img.message);
  const limited = await takeQuota(ctx, "parse-delivery-note");
  if (limited) return limited;

  const raw = await geminiGenerate(
    [{ role: "user", parts: [
      { text: "這是一張食材送貨單/出貨單的照片。請逐項辨識上面的品項、數量、單位、單價與小計。數字看不清楚時填 0,不要猜測。" },
      { inlineData: { mimeType: img.mimeType, data: img.data } }
    ] }],
    { system: "你是食材採購對帳助手。只回傳 JSON,不要說明文字。品名一律繁體中文。", structured: true, temperature: 0.1, schema: DELIVERY_NOTE_SCHEMA, action: "parse-delivery-note", tier: ctx.tier }
  );

  let parsed: { items?: { name?: string; quantity?: number; unit?: string; unit_price?: number; amount?: number }[]; total?: number; supplier_name?: string; delivered_at?: string };
  try { parsed = JSON.parse(raw); } catch {
    return fail("AI_UPSTREAM", { message: "送貨單辨識失敗", details: exposeUpstreamDetails(ctx.tier) ? raw.slice(0, 200) : undefined });
  }
  const items = (parsed.items ?? []).filter((i) => i?.name);

  // 有帶 orderId 就跟訂單品項比對出差異(只限登入者看得到的訂單,否則忽略 orderId)
  let discrepancies: { name: string; ordered: number | null; received: number | null; issue: string }[] = [];
  const order = ctx.tier === "user" && ctx.userId && isUuid(body.orderId)
    ? await readableOrder(ctx.userId, body.orderId)
    : null;
  if (order) {
    const ordered: { name?: string; quantity?: string | number }[] =
      Array.isArray(order.ingredient_list) ? order.ingredient_list : [];
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    for (const o of ordered) {
      if (!o?.name) continue;
      const hit = items.find((i) => norm(i.name!).includes(norm(o.name!)) || norm(o.name!).includes(norm(i.name!)));
      const oq = Number(o.quantity ?? 0);
      if (!hit) {
        discrepancies.push({ name: o.name, ordered: oq || null, received: 0, issue: "未送達" });
      } else if (oq > 0 && Number(hit.quantity ?? 0) > 0 && Math.abs(Number(hit.quantity) - oq) / oq > 0.02) {
        discrepancies.push({
          name: o.name, ordered: oq, received: Number(hit.quantity),
          issue: Number(hit.quantity) < oq ? "數量短少" : "數量超收"
        });
      }
    }
    const extra = items.filter((i) =>
      !ordered.some((o) => o?.name && (norm(i.name!).includes(norm(o.name)) || norm(o.name).includes(norm(i.name!)))));
    discrepancies = discrepancies.concat(
      extra.map((i) => ({ name: i.name!, ordered: null, received: Number(i.quantity ?? 0), issue: "訂單外品項" })));
  }

  return json({ data: {
    supplierName: parsed.supplier_name ?? null,
    deliveredAt: parsed.delivered_at ?? null,
    items, total: Number(parsed.total ?? 0),
    discrepancies, hasDiscrepancy: discrepancies.length > 0
  } });
};

const handleCatalog = async (ctx: Ctx, body: Record<string, unknown>) => {
  const image = typeof body.image === "string" ? body.image : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!image && !text) return fail("BAD_REQUEST", { message: "image or text is required" });
  if (payloadChars("parse-catalog", body) > ctx.lim.maxPayloadChars) {
    return reject(ctx, "parse-catalog", "TOO_LONG", tooLongMessage(ctx.lim.maxPayloadChars));
  }
  let img: { mimeType: string; data: string } | null = null;
  if (image) {
    const checked = inspectImage(image, body.mimeType, ctx.lim);
    if (!checked.ok) return imageReject(ctx, "parse-catalog", checked.code, checked.message);
    img = checked;
  }
  const limited = await takeQuota(ctx, "parse-catalog");
  if (limited) return limited;

  const parts: GPart[] = [{ text: [
    "以下是一份食材供應商的價目表。請逐項整理成商品目錄:名稱、分類、價格、單位、包裝規格。",
    "價格看不清楚時填 0。名稱一律用繁體中文標準寫法。"
  ].join("\n") }];
  if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  if (text) parts.push({ text: `\n=== 價目表內容 ===\n${text}` });

  const raw = await geminiGenerate([{ role: "user", parts }],
    { system: "你是食材供應商上架助手。只回傳 JSON。", structured: true, temperature: 0.1, schema: CATALOG_SCHEMA, action: "parse-catalog", tier: ctx.tier });
  let parsed: { products?: unknown[] };
  try { parsed = JSON.parse(raw); } catch { return fail("AI_UPSTREAM", { message: "價目表辨識失敗" }); }
  return json({ data: { products: Array.isArray(parsed.products) ? parsed.products : [] } });
};

const handleDishIdeas = async (ctx: Ctx, body: Record<string, unknown>) => {
  const ingredients = Array.isArray(body.ingredients) ? (body.ingredients as string[]) : [];
  const seasonal = Array.isArray(body.seasonal) ? (body.seasonal as string[]) : [];
  const cuisine = typeof body.cuisine === "string" ? body.cuisine : "台式";
  if (!ingredients.length && !seasonal.length) return fail("BAD_REQUEST", { message: "ingredients is required" });
  if (payloadChars("dish-ideas", body) > ctx.lim.maxPayloadChars) {
    return reject(ctx, "dish-ideas", "TOO_LONG", tooLongMessage(ctx.lim.maxPayloadChars));
  }
  const limited = await takeQuota(ctx, "dish-ideas");
  if (limited) return limited;

  const raw = await geminiGenerate(
    [{ role: "user", parts: [{ text: [
      `這是一家「${cuisine}」餐廳。請根據以下條件推薦 3 道新菜色:`,
      `- 廚房現有食材:${ingredients.join("、") || "(無)"}`,
      `- 目前當季且價格較低的食材:${seasonal.join("、") || "(無)"}`,
      "",
      "要求:優先使用現有食材以降低備料負擔;至少一道要用到當季便宜食材;",
      "每道菜列出單份食材用量(公斤),並給建議售價(參考台灣一般餐廳行情)。"
    ].join("\n") }] }],
    { system: "你是台灣餐飲研發顧問。只回傳 JSON,菜名要像真的會出現在台灣餐廳菜單上。", structured: true, temperature: 0.8, schema: DISH_IDEAS_SCHEMA, action: "dish-ideas", tier: ctx.tier }
  );
  let parsed: { dishes?: unknown[] };
  try { parsed = JSON.parse(raw); } catch { return fail("AI_UPSTREAM", { message: "新菜建議產生失敗" }); }
  return json({ data: { dishes: Array.isArray(parsed.dishes) ? parsed.dishes : [] } });
};

const handleQuoteDraft = async (ctx: Ctx, body: Record<string, unknown>) => {
  const items = Array.isArray(body.items) ? body.items : [];
  const catalog = Array.isArray(body.catalog) ? body.catalog : [];
  const history = Array.isArray(body.history) ? body.history : [];
  if (!items.length) return fail("BAD_REQUEST", { message: "items is required" });
  if (payloadChars("quote-draft", body) > ctx.lim.maxPayloadChars) {
    return reject(ctx, "quote-draft", "TOO_LONG", tooLongMessage(ctx.lim.maxPayloadChars));
  }
  const limited = await takeQuota(ctx, "quote-draft");
  if (limited) return limited;

  const raw = await geminiGenerate(
    [{ role: "user", parts: [{ text: [
      "請為以下詢價產生一份報價草稿。",
      "",
      `【客戶需求】\n${JSON.stringify(items, null, 0)}`,
      `\n【我的商品目錄與定價】\n${JSON.stringify(catalog, null, 0)}`,
      `\n【近期成交價參考】\n${JSON.stringify(history, null, 0)}`,
      "",
      "規則:單價必須以我的商品目錄定價為基準(可依數量給合理折扣,但不要低於目錄價 85%);",
      "目錄裡沒有的品項不要自行編價,unit_price 填 0 並在 note 註明「目錄無此品項」。"
    ].join("\n") }] }],
    { system: "你是食材供應商的報價助手。只回傳 JSON,金額務必以提供的目錄價為準,不可憑空捏造。", structured: true, temperature: 0.2, schema: QUOTE_SCHEMA, action: "quote-draft", tier: ctx.tier }
  );
  let parsed: { items?: unknown[]; total?: number; message?: string };
  try { parsed = JSON.parse(raw); } catch { return fail("AI_UPSTREAM", { message: "報價草稿產生失敗" }); }
  return json({ data: {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    total: Number(parsed.total ?? 0),
    message: parsed.message ?? ""
  } });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED");

  // 1. 身分(只看 header,還沒讀 body)
  const who = await identify(req);
  if (who.tier === "reject") {
    noteRejection("none", "unknown", "UNAUTHORIZED");
    return fail("UNAUTHORIZED");
  }
  const tier = who.tier;
  const lim = LIMITS[tier];

  // 2. body:有上限地讀(形象站代理另外在前面擋 2.5 MB)
  const raw = await readCappedText(req.body, req.headers.get("content-length"), lim.maxBodyBytes);
  if (!raw.ok) {
    noteRejection(tier, "unknown", "BODY_TOO_LARGE");
    return fail("BODY_TOO_LARGE");
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw.text);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    body = null;
  }
  if (!body || typeof body.action !== "string") return fail("BAD_REQUEST", { message: "action is required" });

  // 3. action 白名單:形象站只開 chat / analyze-menu / analyze-chat
  const requested = body.action;
  if (tier === "landing" && !(LANDING_ACTIONS as readonly string[]).includes(requested)) {
    noteRejection(tier, isAction(requested) ? requested : "unknown", "ACTION_NOT_ALLOWED");
    return fail("ACTION_NOT_ALLOWED");
  }
  if (!isAction(requested)) return fail("BAD_REQUEST", { message: `Unknown action: ${requested.slice(0, 40)}` });
  const action: Action = requested;
  if (!GEMINI_KEY) {
    return fail("AI_UNAVAILABLE", { message: tier === "user" ? "AI 服務尚未設定 (GEMINI_API_KEY missing)" : undefined });
  }

  const ctx: Ctx = { tier, userId: who.userId, subject: who.subject, lim, lang: body.lang };
  try {
    switch (action) {
      case "analyze-menu": return await handleAnalyzeMenu(ctx, body);
      case "analyze-chat": return await handleAnalyzeChat(ctx, body);
      case "chat": return await handleChat(ctx, body);
      case "parse-delivery-note": return await handleDeliveryNote(ctx, body);
      case "parse-catalog": return await handleCatalog(ctx, body);
      case "dish-ideas": return await handleDishIdeas(ctx, body);
      case "quote-draft": return await handleQuoteDraft(ctx, body);
      default: return fail("BAD_REQUEST", { message: "Unknown action" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 服務錯誤";
    // 失敗也記一筆,供 /admin/ai-ops 追蹤
    background(supabase.from("ai_usage").insert({
      action, model: MODEL, tier, ok: false, error: message.slice(0, 500)
    }));
    // Gemini 原始錯誤只給登入使用者(產品站原本就會顯示);形象站與舊前端只拿到 AI_UPSTREAM
    return exposeUpstreamDetails(tier)
      ? fail("AI_UPSTREAM", { message: "AI 分析失敗", details: message })
      : fail("AI_UPSTREAM");
  }
});
