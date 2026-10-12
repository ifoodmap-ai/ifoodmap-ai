// withdrawal.ts:商品頁、購物車、結帳、查單的七日鑑賞期標示文字;標示文字一定要跟服務條款第六條引用的一樣(不然例外不成立)。
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { TERMS } from "./legal";
import { isWithdrawalExempt, WITHDRAWAL_EXEMPT_LABEL, WITHDRAWAL_EXEMPT_REASON, WITHDRAWAL_OK_LABEL, WITHDRAWAL_TERMS_PATH } from "./withdrawal";

describe("七日鑑賞期標示", () => {
  it("文字:不適用 / 適用(協調者指定;法規查證員核對後:從收到隔天起算、原因含到貨時已接近到期)", () => {
    expect(WITHDRAWAL_EXEMPT_LABEL).toBe("不適用七日鑑賞期");
    expect(WITHDRAWAL_OK_LABEL).toBe("收到隔天起 7 天內可退貨");
    expect(WITHDRAWAL_EXEMPT_REASON).toBe("這項商品易腐敗、保存期限較短或到貨時已接近到期,依法不能無理由退貨;商品有瑕疵時,仍可以向店家要求處理。");
  });

  // 「收到後 7 天內」會被讀成比法定(收到隔天起算 7 天)少一天:消費者看得到的頁面一律不用這個說法
  it("消費者頁面(src/pages/market、src/components/market、src/lib/market)沒有「收到後 7 天」的說法", () => {
    const root = resolve(__dirname, "../..");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const scanned = ["pages/market", "components/market", "lib/market"].flatMap((d) => files(join(root, d)));
    expect(scanned.length).toBeGreaterThan(20);
    const hits = scanned.filter((f) => /收到後\s*7\s*天/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it("服務條款第六條引用的標示文字跟畫面一樣;連結指到第六條的錨點", () => {
    const withdrawal = TERMS.sections.find((s) => s.id === "withdrawal");
    expect(withdrawal?.heading).toMatch(/^六、/);
    expect(withdrawal?.paragraphs.join("")).toContain(`在商品頁標示「${WITHDRAWAL_EXEMPT_LABEL}」時,不適用七日解除權`);
    expect(WITHDRAWAL_TERMS_PATH).toBe("/market/terms#withdrawal");
  });

  it("只有 withdrawal_exempt = true 才算不適用(預設、沒有這個欄位的舊資料都算適用)", () => {
    expect(isWithdrawalExempt({ withdrawal_exempt: true })).toBe(true);
    expect(isWithdrawalExempt({ withdrawal_exempt: false })).toBe(false);
    expect(isWithdrawalExempt({})).toBe(false);
    expect(isWithdrawalExempt({ withdrawal_exempt: null })).toBe(false);
  });
});
