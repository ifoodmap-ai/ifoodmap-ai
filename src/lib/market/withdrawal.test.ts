// withdrawal.ts:商品頁、購物車、結帳、查單的七日鑑賞期標示文字;標示文字一定要跟服務條款第六條引用的一樣(不然例外不成立)。
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { TERMS } from "./legal";
import { isWithdrawalExempt, WITHDRAWAL_EXEMPT_LABEL, WITHDRAWAL_EXEMPT_REASON, WITHDRAWAL_OK_LABEL, WITHDRAWAL_TERMS_PATH } from "./withdrawal";

describe("七日鑑賞期標示", () => {
  it("文字:不適用 / 適用(協調者指定);不適用的說明講得出原因與瑕疵仍可處理", () => {
    expect(WITHDRAWAL_EXEMPT_LABEL).toBe("不適用七日鑑賞期");
    expect(WITHDRAWAL_OK_LABEL).toBe("收到後 7 天內可退貨");
    expect(WITHDRAWAL_EXEMPT_REASON).toMatch(/易腐敗或保存期限較短/);
    expect(WITHDRAWAL_EXEMPT_REASON).toMatch(/瑕疵/);
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
