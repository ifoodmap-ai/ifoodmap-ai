// 雜湊與隨機 token —— 只用 Web Crypto(Deno 與 Node ≥ 19 都有 globalThis.crypto),沒有任何外部相依。
// vitest 直接測(crypto.test.ts)。

const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * IFM_AI_PROXY_SECRET 沒設時的固定 key。只是讓 IP 不以明文落地;
 * 真正讓雜湊無法反推的是 secret 本身,所以正式環境一定要設 secret。
 */
export const RATE_KEY_FALLBACK = "ifoodmap-ai-rate-limit-fallback-v1";

/** 限流 key:HMAC-SHA256(secret 或 fallback, ip) 的前 16 個 hex 字元 */
export const hmacHex16 = async (secret: string | null | undefined, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret ? secret : RATE_KEY_FALLBACK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value))).slice(0, 16);
};

/** claim_token_hash = sha256(token 的 UTF-8)的 hex —— 跟 SQL 的 encode(sha256(convert_to(token,'UTF8')),'hex') 一致 */
export const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));

/** claimToken:32 bytes 隨機值的 base64url(43 字元、無 padding) */
export const newClaimToken = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
