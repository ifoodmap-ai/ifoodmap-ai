// /market/terms、/market/privacy:定稿(沒有草稿提示、沒有【待補】)、標題、法規查證要求的重點、業主決定的數字;兩頁互相連結;
// 「第六條」的錨點(商品頁、結帳頁、店家頁會連過來)。
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { LEGAL_DOCS, LEGAL_DRAFT, PRIVACY, TERMS, TERMS_VERSION } from "@/lib/market/legal";
import MarketLegalPage from "./MarketLegalPage";

afterEach(cleanup);

const renderDoc = (doc: "terms" | "privacy", path = `/market/${doc}`) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <MarketLegalPage doc={doc} />
    </MemoryRouter>,
  );
const allText = (d: typeof TERMS) => d.sections.flatMap((s) => [s.heading, ...s.paragraphs]).join("\n");

describe("MarketLegalPage", () => {
  it("服務條款:定稿、沒有草稿提示;平台是仲介、店家是賣方、不適用七日解除權要在商品頁標示、發票或收據由店家開立", () => {
    renderDoc("terms");
    expect(screen.getByRole("heading", { level: 1, name: "食材市集服務條款" })).toBeInTheDocument();
    expect(LEGAL_DRAFT).toBe(false);
    expect(screen.queryByText(/草稿/)).toBeNull();
    expect(screen.getByText(/店家是賣方/)).toBeInTheDocument();
    expect(screen.getByText(/在商品頁標示「不適用七日鑑賞期」時,不適用七日解除權/)).toBeInTheDocument();
    expect(screen.getByText(/店家依法應開立統一發票的,由店家開立/)).toBeInTheDocument();
    expect(screen.getByText("最後更新:2026-10-12")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看隱私權政策" })).toHaveAttribute("href", "/market/privacy");
    expect(document.title).toBe("食材市集服務條款｜iFoodmap 食材市集");
  });

  it("隱私權政策:蒐集項目與誰看得到;版本字串放得進資料庫(≤ 20 字)", () => {
    renderDoc("privacy");
    expect(screen.getByRole("heading", { level: 1, name: "食材市集隱私權政策" })).toBeInTheDocument();
    expect(screen.getByText(/你下單的店家:為了出貨與聯絡你/)).toBeInTheDocument();
    expect(screen.getByText("最後更新:2026-10-12")).toBeInTheDocument();
    expect(TERMS_VERSION).toBe("2026-10-12");
    expect(TERMS_VERSION.length).toBeLessThanOrEqual(20);
  });

  it("兩頁都沒有草稿提示;條款明講平台是仲介、店家就是刊登商品的供應商、俗稱七天鑑賞期", () => {
    for (const doc of ["terms", "privacy"] as const) {
      renderDoc(doc);
      expect(screen.queryByText(/草稿/)).toBeNull();
      cleanup();
    }
    renderDoc("terms");
    expect(screen.getByText(/交易媒合\(仲介\)平台/)).toBeInTheDocument();
    expect(screen.getByText(/「店家」是在本市集刊登商品的供應商/)).toBeInTheDocument();
    expect(screen.getByText(/俗稱七天鑑賞期/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看隱私權政策" })).toBeInTheDocument();
  });

  it("沒有任何【待補】", () => {
    expect(JSON.stringify(LEGAL_DOCS)).not.toMatch(/【待補/);
    expect(JSON.stringify(LEGAL_DOCS)).not.toMatch(/待補/);
  });

  it("業主 2026-10-12 的決定:經營者用品牌名稱(不留統編、負責人、地址)、退款 7 天、回覆 3 個工作天、保存 5 年、複本不收費、系統紀錄 1 至 7 天、維運人員不寫名稱", () => {
    const terms = allText(TERMS);
    const privacy = allText(PRIVACY);
    for (const opener of [TERMS.sections[0].paragraphs[0], PRIVACY.sections[0].paragraphs[0]]) {
      expect(opener).toContain("食材地圖 iFoodMap");
      expect(opener).toContain("ifoodmaptw@gmail.com");
      expect(opener).not.toMatch(/統一編號|負責人|地址/);
    }
    expect(terms).toContain("店家應在確認後 7 天內退款");
    expect(terms).toContain("我們會在 3 個工作天內回覆");
    expect(privacy).toContain("保存 5 年");
    expect(privacy).toContain("製給複製本不收費用");
    expect(privacy).toContain("連線紀錄:依各服務商方案,通常保存 1 至 7 天");
    expect(privacy).toContain("受本市集委託維護系統的人員");
    expect(TERMS.updated).toBe("2026-10-12");
    expect(PRIVACY.updated).toBe("2026-10-12");
  });

  it("第六條(七日解除權)有固定的錨點 #withdrawal;從別頁連過來會捲到那一條", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
    try {
      renderDoc("terms", "/market/terms#withdrawal");
      const section = document.getElementById("withdrawal");
      expect(section).not.toBeNull();
      expect(section?.querySelector("h2")?.textContent).toMatch(/^六、七日解除權/);
      expect(scrolled).toEqual(["withdrawal"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
