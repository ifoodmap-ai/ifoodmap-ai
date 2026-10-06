// /admin/ai-ops 的成本估算(只是估算,實際帳單以 Google Cloud 為準)。
//
// 單價 = Gemini 2.5 Flash 公告價(每百萬 tokens):輸入 US$0.30、輸出 US$2.50。
// 2.5 Flash 的「思考」tokens 按輸出價計費 —— ai 函式把它另外記在 ai_usage.thoughts_tokens
// (舊資料沒有這個欄位/是 null,一律當 0),所以輸出 = completion_tokens + thoughts_tokens。

export const USD_PER_M_INPUT = 0.3;
export const USD_PER_M_OUTPUT = 2.5;

export interface AiTokenRow {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  thoughts_tokens?: number | null;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

/** 這一筆的輸入 tokens */
export const inputTokensOf = (row: AiTokenRow): number => n(row.prompt_tokens);

/** 這一筆的輸出 tokens(含思考 tokens) */
export const outputTokensOf = (row: AiTokenRow): number => n(row.completion_tokens) + n(row.thoughts_tokens);

/** 這一筆的思考 tokens(只用來顯示「含思考 N」) */
export const thoughtsTokensOf = (row: AiTokenRow): number => n(row.thoughts_tokens);

/** 估算成本(US$) */
export const costOf = (inTok: number, outTok: number): number =>
  (inTok / 1_000_000) * USD_PER_M_INPUT + (outTok / 1_000_000) * USD_PER_M_OUTPUT;

/** 頁面上說明單價用:US$0.30 / US$2.50 */
export const formatUnitPrice = (usdPerMillion: number): string => `US$${usdPerMillion.toFixed(2)}`;
