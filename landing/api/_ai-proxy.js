// 三支 /api/ai-* 共用的代理:形象站瀏覽器 → 這裡 → Supabase Edge Function `ai`(server→server,無 CORS 問題)。
// 介面契約見「形象站 AI 防濫用＋註冊導流」SPEC §8 —— 名稱、格式、狀態碼都是跟後端講好的,不要自己改。
//
// 🔴 檔名開頭的底線是刻意的:Vercel 不會把它變成公開路由。
//    已對照 Vercel CLI 54.4.1 內建的 @vercel/fs-detectors(detect-builders):
//    ① maybeGetApiBuilder() 遇到路徑含 "/_" 直接 return null → 不是 function,/api/_ai-proxy 是 404;
//    ② 靜態輸出的 src 是 "!{api/**,node_modules/**,...}" → api/ 底下的檔案也不會被當成靜態檔公開。
//    它只會在三支入口 import 時,被 @vercel/nft 追進各自的 bundle(ESM 一起被編成 CommonJS)。
//    放 landing/lib/ 反而不行:那裡會被當成靜態檔原樣公開。
//
// 契約重點(SPEC §8):
//   - action 寫死在入口檔,body 蓋不掉
//   - 欄位白名單,白名單外的一律丟掉
//   - body > 2.5 MB → 413 {code:"BODY_TOO_LARGE"},不轉發
//   - 往上游帶 Content-Type、apikey、x-ifm-proxy-secret(env 有設才帶)、x-ifm-client-ip
//   - 上游的狀態碼、JSON、Retry-After 原樣轉回;非 POST 回 405

const DEFAULT_EDGE_URL = 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/ai';
// anon key 是公開金鑰(跟 index.html 的 IFM_SUPA 同一把),寫死沒問題;防線在後端的分級與限流。
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3dnBlaHFjdmJmdXluYWJwcW9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5NzQ5NjgsImV4cCI6MjA5NTU1MDk2OH0.QMkcOlGjRTP5XeddI4IAzSkGJoUjaRtcjI_Tjl6rj2k';

// 2.5 MB 取 2.5 MiB。後端(landing tier)的圖片上限是解碼後 1.5 MB,base64 約 2.0 MB,
// 加上 JSON 外殼仍在這個上限之內;正常的對話 body 只有幾十 KB。
export const MAX_BODY_BYTES = Math.floor(2.5 * 1024 * 1024);

// SPEC §8 欄位白名單。key = 上游的 action。
// analyze-menu 的 analysisId / claimToken:SPEC 修訂 2 R1(同一段對話的後續照片併進同一筆)。
export const ALLOWED_FIELDS = Object.freeze({
  chat: Object.freeze(['messages', 'lang']),
  'analyze-chat': Object.freeze(['messages', 'lang', 'reason', 'analysisId', 'claimToken']),
  'analyze-menu': Object.freeze(['image', 'mimeType', 'lang', 'analysisId', 'claimToken']),
});

function headerValue(headers, name) {
  const value = headers ? headers[name] : undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

// 訪客 IP:優先 x-real-ip,沒有才取 x-forwarded-for 的第一段(SPEC §8)。
// 在 Vercel 上這兩個 header 都是平台自己蓋上去的,訪客偽造不了;
// 瀏覽器自己送來的 x-ifm-client-ip 一律不看。兩個都沒有就不帶,後端會記成 "unknown"。
export function clientIpFrom(headers) {
  const realIp = headerValue(headers, 'x-real-ip').split(',')[0].trim();
  if (realIp) return realIp;
  return headerValue(headers, 'x-forwarded-for').split(',')[0].trim();
}

// 只留白名單內、有值的欄位。用 hasOwnProperty:原型鏈上的東西不算。
export function pickFields(body, fields) {
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

function parseRaw(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  return text.trim() ? JSON.parse(text) : {};
}

// 沒有 Vercel helpers(或 Content-Type 不是它認得的)時自己讀 stream,讀到上限就停。
function readStream(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { finish({ tooLarge: true }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ raw: Buffer.concat(chunks) }));
    // 訪客中途斷線:不要讓這個 promise 永遠等下去(回什麼都送不到了,但 function 要能結束)
    req.on('close', () => finish({ raw: Buffer.concat(chunks) }));
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

// 回傳 { value } / { tooLarge: true } / { invalid: true }。
// 大小檢查分兩段:先看宣告的 Content-Length(不用解析就能擋),再量實際的 body
// —— Vercel 的 helpers 已經把 body 讀完、依 Content-Type 解析成 req.body(JSON 壞掉時 getter 直接 throw)。
async function readJsonBody(req, limit) {
  const declared = Number(headerValue(req.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };

  let body;
  try {
    body = req.body;
  } catch (e) {
    return { invalid: true };
  }

  if (body === undefined || body === null) {
    if (typeof req.on === 'function' && !req.readableEnded) {
      let read;
      try {
        read = await readStream(req, limit);
      } catch (e) {
        return { invalid: true };
      }
      if (read.tooLarge) return { tooLarge: true };
      body = read.raw;
    } else {
      body = {};
    }
  }

  if (byteLength(body) > limit) return { tooLarge: true };

  let value = body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try {
      value = parseRaw(body);
    } catch (e) {
      return { invalid: true };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { invalid: true };
  return { value };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

// deps 只給測試用:注入假的 fetch 與 env。正式環境用 globalThis.fetch 與 process.env(每次請求現讀)。
export function createProxyHandler(action, deps = {}) {
  const fields = ALLOWED_FIELDS[action];
  if (!fields) throw new Error(`unknown ai action: ${action}`);

  return async function aiProxy(req, res) {
    const env = deps.env || process.env;
    const doFetch = deps.fetch || globalThis.fetch;

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' });
      return;
    }

    const parsed = await readJsonBody(req, MAX_BODY_BYTES);
    if (parsed.tooLarge) {
      sendJson(res, 413, { code: 'BODY_TOO_LARGE', message: '請求內容超過 2.5 MB' });
      return;
    }
    if (parsed.invalid) {
      sendJson(res, 400, { code: 'BAD_REQUEST', message: '請求格式不正確' });
      return;
    }

    // action 最後才蓋上去:就算哪天白名單手滑加了 action,body 也蓋不掉入口檔寫死的那個
    const payload = Object.assign(pickFields(parsed.value, fields), { action });

    const headers = {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY,
    };
    const secret = env.IFM_AI_PROXY_SECRET;
    if (typeof secret === 'string' && secret) headers['x-ifm-proxy-secret'] = secret;
    const ip = clientIpFrom(req.headers);
    if (ip) headers['x-ifm-client-ip'] = ip;

    let upstream;
    let text;
    try {
      upstream = await doFetch(env.IFOODMAP_AI_EDGE_URL || DEFAULT_EDGE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      text = await upstream.text();
    } catch (e) {
      // 原始錯誤只進 Vercel log,不回給瀏覽器(SPEC §2:landing 不得看到上游細節)
      console.error(`[ai-proxy] ${action} upstream unreachable:`, (e && e.message) || e);
      sendJson(res, 502, { code: 'AI_UPSTREAM', message: 'AI 服務暫時無法連線，請稍後再試' });
      return;
    }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    res.end(text);
  };
}
