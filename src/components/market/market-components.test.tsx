// 市集共用元件:版面的地標與跳到主要內容、照片的退回順序、商品卡、分類切換、店家條件。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import { createMemoryStorage } from "@/test/memory-storage";
import CategoryChips from "./CategoryChips";
import MarketImage from "./MarketImage";
import MarketLayout, { useMarketTitle } from "./MarketLayout";
import ProductCard from "./ProductCard";
import QtyStepper from "./QtyStepper";
import StoreInfoList from "./StoreInfoList";

afterEach(cleanup);

const TitleProbe = ({ title }: { title: string | null }) => {
  useMarketTitle(title);
  return <h1>頁面</h1>;
};

describe("MarketLayout", () => {
  it("有跳到主要內容、logo 回市集首頁、main 地標;頁尾說明平台角色", () => {
    render(
      <MemoryRouter initialEntries={["/market"]}>
        <Routes>
          <Route path="/market" element={<MarketLayout />}>
            <Route index element={<TitleProbe title="測試頁" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toHaveAttribute("href", "#market-main");
    expect(screen.getByRole("link", { name: /食材市集 首頁/ })).toHaveAttribute("href", "/market");
    expect(screen.getByRole("main")).toHaveAttribute("id", "market-main");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("商品由各店家販售、出貨與收款");
    expect(document.title).toBe("測試頁｜iFoodmap 食材市集");
  });

  it("頁首的購物車連結念出件數;頁尾有服務條款與隱私權政策", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    cartStore.resetForTests();
    cartStore.add(CABBAGE.id, 2);
    render(
      <MemoryRouter initialEntries={["/market"]}>
        <Routes>
          <Route path="/market" element={<MarketLayout />}>
            <Route index element={<TitleProbe title="測試頁" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "購物車,2 件" })).toHaveAttribute("href", "/market/cart");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "服務條款" })).toHaveAttribute("href", "/market/terms");
    expect(footer.getByRole("link", { name: "隱私權政策" })).toHaveAttribute("href", "/market/privacy");
    vi.unstubAllGlobals();
    cartStore.resetForTests();
  });
});

describe("MarketLayout 換頁", () => {
  afterEach(() => vi.restoreAllMocks());

  /** 在 router 裡、市集外面的測試用導覽 */
  const TestNav = () => {
    const navigate = useNavigate();
    return (
      <div>
        <button type="button" onClick={() => navigate("/market")}>
          去市集
        </button>
        <button type="button" onClick={() => navigate("/market/p/x")}>
          去商品
        </button>
        <button type="button" onClick={() => navigate("/market/p/x?photo=2", { replace: true })}>
          只改查詢字串
        </button>
        <button type="button" onClick={() => navigate(-1)}>
          上一頁
        </button>
        <button type="button" onClick={() => navigate("/elsewhere")}>
          離開市集
        </button>
      </div>
    );
  };
  const renderShell = (initial: string) =>
    render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/market" element={<MarketLayout />}>
            <Route index element={<TitleProbe title={null} />} />
            <Route path="p/:id" element={<TitleProbe title="高麗菜" />} />
          </Route>
          <Route path="/elsewhere" element={<p>市集外的頁面</p>} />
        </Routes>
        <TestNav />
      </MemoryRouter>,
    );

  it("市集裡點連結換頁捲回頂端;第一次進來、上一頁(POP)、只改查詢字串都不捲", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    renderShell("/market");
    expect(scrollTo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "去商品" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    await userEvent.click(screen.getByRole("button", { name: "只改查詢字串" }));
    await userEvent.click(screen.getByRole("button", { name: "上一頁" }));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("離開市集時,分頁標題還原成進市集之前的", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    document.title = "進市集之前的標題";
    renderShell("/elsewhere");
    await userEvent.click(screen.getByRole("button", { name: "去市集" }));
    expect(document.title).toBe("iFoodmap 食材市集");
    await userEvent.click(screen.getByRole("button", { name: "去商品" }));
    expect(document.title).toBe("高麗菜｜iFoodmap 食材市集");
    await userEvent.click(screen.getByRole("button", { name: "離開市集" }));
    expect(screen.getByText("市集外的頁面")).toBeInTheDocument();
    expect(document.title).toBe("進市集之前的標題");
  });
});

describe("MarketImage", () => {
  const PATH = "a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg";

  it("縮圖 → 主圖 → 分類圖示,一路退回", () => {
    render(<MarketImage path={PATH} category="vegetable" alt="高麗菜" />);
    const img = screen.getByRole("img", { name: "高麗菜" });
    expect(img.getAttribute("src")).toMatch(/_t\.jpg$/);
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "高麗菜" }).getAttribute("src")).toMatch(/0001\.jpg$/);
    fireEvent.error(screen.getByRole("img", { name: "高麗菜" }));
    expect(screen.getByRole("img", { name: "高麗菜" })).toHaveAttribute("data-fallback", "category");
  });

  it("沒有照片就顯示分類圖示;有寬高、lazy", () => {
    render(<MarketImage path={null} category="meat" alt="牛肉" width={200} height={200} />);
    const img = screen.getByRole("img", { name: "牛肉" });
    expect(img).toHaveAttribute("data-fallback", "category");
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("分類圖示的留白跟著外框大小走(外框拿 className;不用百分比 padding —— 那是照父元素寬度算的)", () => {
    render(<MarketImage path={null} category="meat" alt="牛肉" className="h-16 w-16 rounded-md" />);
    const img = screen.getByRole("img", { name: "牛肉" });
    expect(img.parentElement).toHaveClass("h-16", "w-16", "rounded-md", "bg-emerald-50");
    expect(img).toHaveClass("h-[76%]", "w-[76%]");
    expect(img.className).not.toMatch(/\bp-\[/);
  });
});

describe("ProductCard", () => {
  it("整張卡片連到商品頁,顯示品名、規格、價格、溫層、店名", () => {
    render(
      <MemoryRouter>
        <ProductCard product={CABBAGE} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /有機高麗菜/ });
    expect(link).toHaveAttribute("href", `/market/p/${CABBAGE.id}`);
    expect(link).toHaveTextContent("NT$ 100");
    expect(link).toHaveTextContent("冷藏");
    expect(link).toHaveTextContent("市集測試 A 店");
    expect(link).not.toHaveTextContent("已售完");
  });

  it("鍵盤焦點框看得到:連結外面(到卡片外框為止)沒有會裁切的 overflow", () => {
    const { container } = render(
      <MemoryRouter>
        <ProductCard product={CABBAGE} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /有機高麗菜/ });
    expect(link).toHaveClass("focus-visible:ring-2");
    // 焦點框是畫在連結「外面」的 box-shadow;連結填滿整張卡片,任何一層祖先 overflow-hidden / clip 都會把它整圈切掉
    for (let el = link.parentElement; el && el !== container; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)overflow-(hidden|clip)(\s|$)/);
    }
  });

  it("庫存 0 標已售完", () => {
    render(
      <MemoryRouter>
        <ProductCard product={{ ...BEEF, stock: 0 }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /牛肉片/ })).toHaveTextContent("已售完");
  });
});

describe("CategoryChips", () => {
  it("全部 + 12 類,目前選的 aria-pressed=true;點了回傳 key", async () => {
    const onChange = vi.fn();
    render(<CategoryChips value="meat" onChange={onChange} />);
    const group = screen.getByRole("group", { name: "食材分類" });
    expect(within(group).getAllByRole("button")).toHaveLength(13);
    expect(within(group).getByRole("button", { name: "肉品" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(group).getByRole("button", { name: "海鮮" }));
    expect(onChange).toHaveBeenCalledWith("seafood");
    await userEvent.click(within(group).getByRole("button", { name: "全部" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("手機的橫向捲動列留出焦點框的空間:上下 padding,捲到邊緣時也留 scroll-padding", () => {
    render(<CategoryChips value={null} onChange={vi.fn()} />);
    const row = screen.getByRole("group", { name: "食材分類" });
    // overflow-x-auto 會讓 overflow-y 也變成 auto:按鈕外 4px 的焦點框(ring-2 + ring-offset-2)超出 padding box 的部分會被切掉
    expect(row).toHaveClass("overflow-x-auto");
    expect(row.className).toMatch(/(^|\s)pt-(1|1\.5|2)(\s|$)/);
    expect(row.className).toMatch(/(^|\s)pb-(1|1\.5|2)(\s|$)/);
    expect(row.className).toMatch(/(^|\s)scroll-px-\S+/);
  });

  it("按鈕得到焦點時整顆捲進可見範圍(Chrome 用 Tab 聚焦時,露出一半的按鈕不會自己捲)", () => {
    const original = Element.prototype.scrollIntoView; // jsdom 沒有這個方法
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<CategoryChips value={null} onChange={vi.fn()} />);
      screen.getByRole("button", { name: "包材耗材" }).focus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("available 只列這家店有的分類", () => {
    render(<CategoryChips value={null} onChange={vi.fn()} available={["fruit"]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["全部", "水果"]);
  });
});

describe("QtyStepper", () => {
  const Harness = ({ max = 10 }: { max?: number }) => {
    const [qty, setQty] = useState(1);
    return (
      <>
        <QtyStepper value={qty} max={max} onChange={setQty} label="有機高麗菜 數量" />
        <span data-testid="qty">{qty}</span>
      </>
    );
  };

  it("數量框可以先清空再打新的數字(不會先跳回 1、接著打成 15)", async () => {
    render(<Harness max={99} />);
    const input = screen.getByRole("spinbutton", { name: "數量" });
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    expect(screen.getByTestId("qty")).toHaveTextContent(/^5$/);
    expect(input).toHaveValue(5);
  });

  it("打超過上限的數字:數量用上限,離開欄位後框裡也顯示上限;清空就離開則顯示原本的數量", async () => {
    render(<Harness max={10} />);
    const input = screen.getByRole("spinbutton", { name: "數量" });
    await userEvent.clear(input);
    await userEvent.type(input, "50");
    expect(screen.getByTestId("qty")).toHaveTextContent(/^10$/);
    await userEvent.tab();
    expect(input).toHaveValue(10);
    await userEvent.clear(input);
    await userEvent.tab();
    expect(input).toHaveValue(10);
    expect(screen.getByTestId("qty")).toHaveTextContent(/^10$/);
  });
});

describe("StoreInfoList", () => {
  it("配送縣市、運費、最低訂購、出貨、付款方式", () => {
    render(<StoreInfoList store={STORE_A} />);
    expect(screen.getByText("臺北市、新北市")).toBeInTheDocument();
    expect(screen.getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByText("滿 NT$ 300 才能下單")).toBeInTheDocument();
    expect(screen.getByText("2 個工作天內出貨")).toBeInTheDocument();
    expect(screen.getByText("貨到付款、銀行轉帳")).toBeInTheDocument();
  });
});
