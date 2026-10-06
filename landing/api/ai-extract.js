// Serverless proxy: landing 瀏覽器 → 此函式 → Supabase Edge Function `ai`
// action 寫死成 analyze-chat(body 蓋不掉);白名單、大小上限、往上游帶的 header 全在 _ai-proxy.js(SPEC §8)。
// 前端在三個時機呼叫:按「免費註冊」(reason=register)、留 Email(lead)、關面板/離開頁面(close)。
import { createProxyHandler } from './_ai-proxy.js';

export default createProxyHandler('analyze-chat');
