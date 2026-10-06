import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_MAX_LENGTH, EMAIL_PATTERN, isValidEmail, replyToAddress, shouldRetryWithoutReplyTo } from "./lead-email.ts";

const here = (rel: string) => join(__dirname, rel);

describe("全站統一的 Email 規則(SPEC 修訂 2 R4)", () => {
  it("一般地址都收:+ 標籤、子網域、大小寫、底線、百分比、xn-- 網域", () => {
    for (const ok of [
      "a@b.co",
      "first.last+tag@sub.example.com",
      "A_B%c-d@EXAMPLE.ORG",
      "owner@shop.com.tw",
      "x@xn--fiqs8s.tw",
    ]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it("擋掉 a@b..c、結尾逗號 / 分號、空白、一次多個地址、缺網域、一個字母的 TLD、非 ASCII", () => {
    for (const bad of [
      "a@b..c",
      "a@b..com",
      "a@b.com,",
      "a@b.com;",
      "a @b.com",
      " a@b.com",
      "a@b.com b@c.com",
      "a@b.com,b@c.com",
      "a@b.com;b@c.com",
      "a@b",
      "a@b.c",
      "a@.com",
      "@b.com",
      "a@b.c0m",
      "a@@b.com",
      "王@example.com",
      "",
    ]) {
      expect(isValidEmail(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });

  it("長度上限 254", () => {
    const local = "a".repeat(64);
    const domain = (n: number) => "b".repeat(n - local.length - 1 - 4) + ".com";
    expect(isValidEmail(`${local}@${domain(254)}`)).toBe(true);
    expect(`${local}@${domain(254)}`).toHaveLength(EMAIL_MAX_LENGTH);
    expect(isValidEmail(`${local}@${domain(255)}`)).toBe(false);
  });

  it("資料庫 constraint 用的是同一條 regex(landing_leads 與 partnership_leads 都是)", () => {
    const sql = readFileSync(here("../../migrations/20261007100200_lead_guards.sql"), "utf8");
    const patterns = [...sql.matchAll(/contact_email ~ '([^']+)'/g)].map((m) => m[1]);
    expect(patterns).toHaveLength(2);
    for (const p of patterns) expect(p).toBe(EMAIL_PATTERN);
    expect(sql.match(/char_length\(contact_email\) <= 254/g)).toHaveLength(2);
  });

  it("notify-lead 本身沒有另一條 Email regex(reply-to 一律走 lead-email.ts)", () => {
    const src = readFileSync(here("./index.ts"), "utf8");
    expect(src).toContain('from "./lead-email.ts"');
    expect(src).not.toMatch(/\/\^\[\^\\s@\]/);
  });
});

describe("reply-to", () => {
  it("格式有效才設(去頭尾空白);不合格就不設", () => {
    expect(replyToAddress("  buyer@example.com ")).toBe("buyer@example.com");
    expect(replyToAddress("buyer@example.com,")).toBeUndefined();
    expect(replyToAddress("a@b..c")).toBeUndefined();
    expect(replyToAddress(null)).toBeUndefined();
    expect(replyToAddress(123)).toBeUndefined();
  });

  it("Resend 回 4xx 而且有 reply_to 才拿掉 reply_to 重寄", () => {
    expect(shouldRetryWithoutReplyTo(422, "buyer@example.com")).toBe(true);
    expect(shouldRetryWithoutReplyTo(400, "buyer@example.com")).toBe(true);
    expect(shouldRetryWithoutReplyTo(429, "buyer@example.com")).toBe(true);
    expect(shouldRetryWithoutReplyTo(422, undefined)).toBe(false);
    expect(shouldRetryWithoutReplyTo(500, "buyer@example.com")).toBe(false);
    expect(shouldRetryWithoutReplyTo(200, "buyer@example.com")).toBe(false);
    expect(shouldRetryWithoutReplyTo(null, "buyer@example.com")).toBe(false);
  });
});
