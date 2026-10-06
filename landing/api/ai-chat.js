// Serverless proxy: landing 瀏覽器 → 此函式 → Supabase Edge Function `ai`
// action 寫死成 chat(body 蓋不掉);白名單、大小上限、往上游帶的 header 全在 _ai-proxy.js(SPEC §8)。
import { createProxyHandler } from './_ai-proxy.js';

export default createProxyHandler('chat');
