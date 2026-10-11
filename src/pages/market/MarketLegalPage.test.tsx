// /market/terms、/market/privacy:草稿提示、標題、設計稿要求的三個重點;兩頁互相連結。
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { LEGAL_DRAFT, TERMS_VERSION } from "@/lib/market/legal";
import MarketLegalPage from "./MarketLegalPage";

afterEach(cleanup);

describe("MarketLegalPage", () => {
  it("服務條款:草稿提示;平台是仲介、生鮮不適用 7 日解除權、發票由店家開立", () => {
    render(
      <MemoryRouter>
        <MarketLegalPage doc="terms" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "食材市集服務條款" })).toBeInTheDocument();
    expect(LEGAL_DRAFT).toBe(true);
    expect(screen.getByText("草稿:本文件待業主與法律專業確認後定稿。")).toBeInTheDocument();
    expect(screen.getByText(/店家是賣方/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 條第 1 款的情形,不適用 7 日解除權/)).toBeInTheDocument();
    expect(screen.getByText("發票由店家開立。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看隱私權政策" })).toHaveAttribute("href", "/market/privacy");
    expect(document.title).toBe("食材市集服務條款｜iFoodmap 食材市集");
  });

  it("隱私權政策:蒐集項目與誰看得到;版本字串放得進資料庫(≤ 20 字)", () => {
    render(
      <MemoryRouter>
        <MarketLegalPage doc="privacy" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "食材市集隱私權政策" })).toBeInTheDocument();
    expect(screen.getByText(/你下單的店家:為了出貨與聯絡你/)).toBeInTheDocument();
    expect(TERMS_VERSION.length).toBeLessThanOrEqual(20);
  });

  it("兩頁都標「草稿」;條款明講平台是仲介、店家就是刊登商品的供應商、生鮮不適用俗稱的七天鑑賞期", () => {
    for (const doc of ["terms", "privacy"] as const) {
      render(
        <MemoryRouter>
          <MarketLegalPage doc={doc} />
        </MemoryRouter>,
      );
      expect(screen.getByText("草稿:本文件待業主與法律專業確認後定稿。")).toBeInTheDocument();
      cleanup();
    }
    render(
      <MemoryRouter>
        <MarketLegalPage doc="terms" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/交易媒合\(仲介\)平台/)).toBeInTheDocument();
    expect(screen.getByText(/「店家」是在本市集刊登商品的供應商/)).toBeInTheDocument();
    expect(screen.getByText(/俗稱七天鑑賞期/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看隱私權政策" })).toBeInTheDocument();
  });
});
