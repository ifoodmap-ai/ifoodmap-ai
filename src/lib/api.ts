// Thin client for the ifoodmap backend API (Railway). The backend holds the
// Gemini API key and Supabase service-role key — never call Gemini from here.
//
// Set VITE_API_URL to the Railway public URL of the `api` service, e.g.
//   VITE_API_URL=https://ifoodmap-api-production.up.railway.app

import { supabase } from "@/integrations/supabase/client";

export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export interface Ingredient {
  name: string;
  quantity?: string;
  unit?: string;
  category?: string;
}

export interface AnalysisResult {
  analysisId: string | null;
  persistError: string | null;
  summary: string;
  ingredients: Ingredient[];
}

interface ApiError {
  code?: string;
  message?: string;
  details?: unknown;
  retryAfterSeconds?: number;
}

// AI endpoints run on the Supabase Edge Function `ai` (Railway-independent).
// 🔴 產品站所有 AI 呼叫都要經過這裡(requestAi / aiCall)—— 身分標頭只在這裡組一次。
const AI_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai`;

/** 目前登入者的 access token;沒登入、或讀 session 失敗都回 null(不擋 AI 呼叫) */
const currentAccessToken = async (): Promise<string | null> => {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
};

/**
 * 打 ai 的標頭。apikey 照舊帶;有登入就加 Authorization: Bearer <access_token>,
 * 讓 ai 把呼叫者認成 user tier(SPEC §1)。沒有 session 就不帶 —— anon key 不算身分。
 * 舊版 ai 不讀這個標頭(CORS 早就允許 authorization),新舊版都能共存。
 */
export const aiRequestHeaders = async (): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
  const token = await currentAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/** ai 回的錯誤。新版帶 { code, message, retryAfterSeconds? }(SPEC §2);舊版只有 message。 */
export class AiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status: number; code?: string | null; retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = "AiError";
    this.status = options.status;
    this.code = options.code ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

const parseRetryAfter = (json: ApiError | null, res: Response): number | null => {
  const fromBody = Number(json?.retryAfterSeconds);
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const header = res.headers?.get?.("Retry-After");
  const fromHeader = header != null && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  return Number.isFinite(fromHeader) ? fromHeader : null;
};

/**
 * 呼叫 ai,回傳整包 JSON(呼叫端自己決定怎麼拆)。HTTP 不是 2xx → 丟 AiError。
 * 菜色實驗室這種「回應格式比較寬鬆」的頁面直接用這支;其他用下面的 aiCall。
 */
export const requestAi = async (
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const res = await fetch(AI_FN_URL, {
    method: "POST",
    headers: await aiRequestHeaders(),
    body: JSON.stringify(payload),
  });

  const json = (await res.json().catch(() => null)) as (Record<string, unknown> & ApiError) | null;

  if (!res.ok) {
    throw new AiError(json?.message ?? `Request failed (${res.status})`, {
      status: res.status,
      code: typeof json?.code === "string" ? json.code : null,
      retryAfterSeconds: parseRetryAfter(json, res),
    });
  }

  return json;
};

const aiCall = async <T>(payload: Record<string, unknown>): Promise<T> => {
  const json = await requestAi(payload);
  if (!json) {
    throw new AiError("Request failed (empty response)", { status: 200 });
  }
  return json.data as T;
};

const rateLimitedMessage = (retryAfterSeconds: number | null): string => {
  if (retryAfterSeconds == null) return "AI 使用次數已達上限，請稍後再試";
  // 一小時內就能再用(10 分鐘的頻率上限,或接近午夜的每日上限)→ 直接講幾分鐘
  if (retryAfterSeconds <= 3600) {
    return `AI 使用太頻繁了，請 ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} 分鐘後再試`;
  }
  return "今天的 AI 使用次數已達上限，請明天再試";
};

/**
 * 已知錯誤碼 → 給使用者看的中文(不露技術細節)。不認得的錯誤回 null,呼叫端照舊顯示原本的訊息。
 * 錯誤碼與狀態碼的定義見 SPEC §2。
 */
export const friendlyAiError = (error: unknown): string | null => {
  if (!(error instanceof AiError)) return null;
  switch (error.code) {
    case "RATE_LIMITED":
      return rateLimitedMessage(error.retryAfterSeconds);
    case "DAILY_CAP":
      return "今天的 AI 服務使用量已達上限，請明天再試";
    case "CONVERSATION_LIMIT":
      return "這段對話已經很長了，請重新開始一段新的對話";
    case "TOO_LONG":
      return "訊息太長了，請精簡後再送出";
    case "IMAGE_TOO_LARGE":
    case "BODY_TOO_LARGE":
      return "照片太大了，請換一張較小的照片";
    case "UNSUPPORTED_IMAGE":
      return "這種圖片格式無法辨識，請改用 JPG 或 PNG 照片";
    case "UNAUTHORIZED":
      return "登入狀態已過期，請重新登入後再試";
    case "ACTION_NOT_ALLOWED":
      return "目前無法使用這項 AI 功能";
    case "AI_UPSTREAM":
      return "AI 服務暫時忙碌，請稍後再試";
    default:
      break;
  }
  // 沒帶錯誤碼的 429(例如閘道層)也當成限流
  if (error.status === 429) return rateLimitedMessage(error.retryAfterSeconds);
  return null;
};

/** Read a File as a base64 string (no data: prefix). */
export const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Analyze a menu image → ingredient list + summary (creates a pending analysis record). */
export const analyzeMenu = async (file: File): Promise<AnalysisResult> => {
  const image = await fileToBase64(file);
  return aiCall<AnalysisResult>({
    action: "analyze-menu",
    image,
    mimeType: file.type || "image/jpeg",
    fileName: file.name
  });
};

/** Extract purchasing requirements from a chat transcript (creates a pending analysis record). */
export const analyzeChat = (messages: { role: "user" | "bot"; text: string }[]): Promise<AnalysisResult> =>
  aiCall<AnalysisResult>({ action: "analyze-chat", messages });

/** Get a conversational assistant reply for the chatbot. */
export const chatReply = (messages: { role: "user" | "bot"; text: string }[]): Promise<{ reply: string }> =>
  aiCall<{ reply: string }>({ action: "chat", messages });

export interface MatchedItem {
  ingredient: string;
  name: string;
  price: number | null;
  unit: string | null;
  pack_size: string | null;
}

export interface MatchedSupplier {
  supplier: {
    id: string;
    name: string;
    description: string | null;
    service_areas: string[] | null;
  };
  score: number;
  matchedCount: number;
  items: MatchedItem[];
}

export interface MatchResult {
  requested: string[];
  suppliers: MatchedSupplier[];
}

interface SupplierListRow {
  id: string;
  name: string;
  description: string | null;
  service_areas: string[] | null;
  is_active?: boolean | null;
}

interface SupplyListRow {
  id: string;
  supplier_id: string;
  name: string;
  category: string | null;
  unit: string | null;
  pack_size: string | null;
  price: number | null;
  is_available?: boolean | null;
}

// Public catalog reads go straight to Supabase (anon SELECT policies on
// active suppliers / available supplies) — independent of backend deploys.
const getCatalog = async <T>(table: string, availCol: string): Promise<T[]> => {
  const { data, error } = (await (supabase as never as {
    from: (t: string) => {
      select: (c: string) => { eq: (col: string, v: boolean) => Promise<{ data: T[] | null; error: { message: string } | null }> };
    };
  })
    .from(table)
    .select("*")
    .eq(availCol, true)) as { data: T[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data ?? [];
};

const normalizeName = (s: string) =>
  s.toLowerCase().replace(/\s+/g, "").replace(/[（(].*?[)）]/g, "");

/**
 * Match analyzed ingredient names against real suppliers.
 * Catalog comes from the public list endpoints; the ranking (base 70 +
 * price competitiveness ≤25 + availability 5) runs locally so matching
 * works even while backend deploys are frozen.
 */
export const matchSuppliers = async (ingredients: string[]): Promise<MatchResult> => {
  const [suppliers, supplies] = await Promise.all([
    getCatalog<SupplierListRow>("suppliers", "is_active"),
    getCatalog<SupplyListRow>("supplies", "is_available")
  ]);

  const active = new Map(suppliers.filter((s) => s.is_active !== false).map((s) => [s.id, s]));
  const available = supplies.filter((s) => s.is_available !== false);

  type Hit = { ingredient: string; supply: SupplyListRow };
  const hits: Hit[] = [];
  for (const raw of ingredients) {
    const wn = normalizeName(raw);
    if (!wn) continue;
    for (const s of available) {
      const sn = normalizeName(s.name);
      if (sn.includes(wn) || wn.includes(sn)) hits.push({ ingredient: raw, supply: s });
    }
  }

  const cheapest = new Map<string, number>();
  for (const h of hits) {
    if (h.supply.price == null) continue;
    const cur = cheapest.get(h.ingredient);
    if (cur == null || Number(h.supply.price) < cur) cheapest.set(h.ingredient, Number(h.supply.price));
  }

  const bySupplier = new Map<string, Hit[]>();
  for (const h of hits) {
    if (!active.has(h.supply.supplier_id)) continue;
    bySupplier.set(h.supply.supplier_id, [...(bySupplier.get(h.supply.supplier_id) ?? []), h]);
  }

  const ranked: MatchedSupplier[] = [...bySupplier.entries()]
    .map(([sid, group]) => {
      let priceScore = 0;
      let priced = 0;
      for (const h of group) {
        const min = cheapest.get(h.ingredient);
        if (min != null && h.supply.price != null && Number(h.supply.price) > 0) {
          priceScore += (min / Number(h.supply.price)) * 25;
          priced += 1;
        }
      }
      const sup = active.get(sid)!;
      return {
        supplier: {
          id: sup.id,
          name: sup.name,
          description: sup.description,
          service_areas: sup.service_areas
        },
        score: Math.min(Math.round(70 + (priced > 0 ? priceScore / priced : 12) + 5), 99),
        matchedCount: new Set(group.map((g) => g.ingredient)).size,
        items: group.map((g) => ({
          ingredient: g.ingredient,
          name: g.supply.name,
          price: g.supply.price,
          unit: g.supply.unit,
          pack_size: g.supply.pack_size
        }))
      };
    })
    .sort((a, b) => b.score - a.score || b.matchedCount - a.matchedCount);

  return { requested: ingredients, suppliers: ranked };
};

/** Format an ingredient object into a display string like "牛肉 2kg". */
export const formatIngredient = (i: Ingredient): string => {
  const qty = [i.quantity, i.unit].filter(Boolean).join("");
  return qty ? `${i.name} ${qty}` : i.name;
};
