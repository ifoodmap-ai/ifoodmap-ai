// 官網 lead 通知信的 Email 規則與 reply-to(SPEC 修訂 2 R4)。沒有任何 Deno / npm 相依,vitest 直接測(lead-email.test.ts)。
//
// Email 規則全站統一、一字不差:資料庫 constraint(migration 20261007100200_lead_guards.sql)、這裡的 reply-to、
// 形象站 AI 助手的留 Email、異業合作表單。lead-email.test.ts 會檢查 migration 裡的 regex 跟這裡的 EMAIL_PATTERN 一樣。
//   長度 ≤ 254,且符合 ^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$
//   (擋掉 a@b..c、結尾帶逗號或分號、空白、一次填多個地址)

export const EMAIL_PATTERN = "^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)+[A-Za-z]{2,}$";
export const EMAIL_MAX_LENGTH = 254;

const EMAIL_RE = new RegExp(EMAIL_PATTERN);

export const isValidEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(value);

/** reply-to 只用格式有效的 Email(去頭尾空白後判斷);不合格就不設,照樣寄信 */
export const replyToAddress = (value: unknown): string | undefined => {
  const email = String(value ?? "").trim();
  return isValidEmail(email) ? email : undefined;
};

/**
 * 保險:Resend 回 4xx、而且信上有 reply_to → 拿掉 reply_to 重寄一次。
 * 就算格式檢查漏了什麼,也不能因為訪客填的地址讓業主整封收不到。
 */
export const shouldRetryWithoutReplyTo = (status: number | null, replyTo: string | undefined): boolean =>
  Boolean(replyTo) && status !== null && status >= 400 && status < 500;
