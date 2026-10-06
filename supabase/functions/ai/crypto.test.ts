// @vitest-environment node
// Web Crypto 要用 Node 的實作(jsdom 沒有 crypto.subtle);拿 node:crypto 交叉比對,確保跟 SQL 端的 sha256 一致。
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RATE_KEY_FALLBACK, hmacHex16, newClaimToken, sha256Hex } from "./crypto.ts";
import { isClaimToken } from "./guard.ts";

describe("限流 key:HMAC-SHA256(secret 或 fallback, ip) 前 16 hex", () => {
  it("跟 node:crypto 算的一樣、固定 16 個 hex、不含 IP 明文", async () => {
    const ip = "203.0.113.9";
    const got = await hmacHex16("proxy-secret-value", ip);
    expect(got).toBe(createHmac("sha256", "proxy-secret-value").update(ip).digest("hex").slice(0, 16));
    expect(got).toMatch(/^[0-9a-f]{16}$/);
    expect(got).not.toContain("203");
  });

  it("同一個 IP 換 key 就不同;secret 沒設時用固定 fallback", async () => {
    const ip = "198.51.100.7";
    expect(await hmacHex16("a", ip)).not.toBe(await hmacHex16("b", ip));
    expect(await hmacHex16("", ip)).toBe(await hmacHex16(RATE_KEY_FALLBACK, ip));
    expect(await hmacHex16(undefined, ip)).toBe(await hmacHex16(RATE_KEY_FALLBACK, ip));
    expect(await hmacHex16("k", ip)).toBe(await hmacHex16("k", ip));
  });
});

describe("claimToken", () => {
  it("32 bytes 隨機值的 base64url:43 字元、沒有 padding、每次都不同", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newClaimToken();
      expect(isClaimToken(t)).toBe(true);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("DB 只存 sha256 hex,跟 SQL 的 encode(sha256(convert_to(token,'UTF8')),'hex') 同一種算法", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const t = newClaimToken();
    const h = await sha256Hex(t);
    expect(h).toBe(createHash("sha256").update(t, "utf8").digest("hex"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
  });
});
