// 供應商端零售元件:照片欄位(上傳、最多 5 張、設封面、移除)、商品視窗(驗證、送審、按鈕依狀態)。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { MarketDbError } from "@/lib/market/db";
import { MarketImageError } from "@/lib/market/images";
import { MarketStaleProductError } from "@/lib/market/productForm";
import { CABBAGE, SUPPLIER_A } from "@/lib/market/testFixtures";
import type { MarketProductRow } from "@/lib/market/types";
import MarketPhotoField from "./MarketPhotoField";
import MarketProductDialog from "./MarketProductDialog";
import SupplierMarketProductsPanel, { statusText } from "./SupplierMarketProductsPanel";

afterEach(cleanup);

const photo = (n: number) => `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-00000000000${n}.jpg`;
const file = (name = "a.jpg") => new File(["x"], name, { type: "image/jpeg" });

const PhotoHarness = ({
  initial,
  upload,
  onBusyChange,
}: {
  initial: string[];
  upload: (s: string, f: string, file: File) => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <MarketPhotoField
      supplierId={SUPPLIER_A}
      productId={CABBAGE.id}
      category="vegetable"
      value={value}
      onChange={setValue}
      upload={upload}
      onBusyChange={onBusyChange}
    />
  );
};

/** 上傳到一半停住的假 upload:呼叫 finish(path) 才完成 */
const pendingUpload = () => {
  const finishers: Array<(path: string) => void> = [];
  const upload = vi.fn(() => new Promise<string>((resolve) => finishers.push(resolve)));
  return { upload, finish: (path: string) => finishers.shift()?.(path) };
};

describe("MarketPhotoField", () => {
  it("選檔就上傳到 <supplier>/<商品 id>,路徑加進清單", async () => {
    const upload = vi.fn().mockResolvedValueOnce(photo(1)).mockResolvedValueOnce(photo(2));
    render(<PhotoHarness initial={[]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file("a.jpg"), file("b.jpg")]);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(upload).toHaveBeenCalledWith(SUPPLIER_A, CABBAGE.id, expect.any(File));
    expect(screen.getByText("封面")).toBeInTheDocument();
  });

  it("已經 4 張再選 3 張:只傳 1 張,提示多的略過;5 張就不能再選", async () => {
    const upload = vi.fn().mockResolvedValue(photo(5));
    render(<PhotoHarness initial={[photo(1), photo(2), photo(3), photo(4)]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file("a.jpg"), file("b.jpg"), file("c.jpg")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("最多 5 張,多的已略過")).toBeInTheDocument();
    expect(screen.getByLabelText("新增照片")).toBeDisabled();
  });

  it("設為封面、移除", async () => {
    render(<PhotoHarness initial={[photo(1), photo(2)]} upload={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "第 2 張設為封面" }));
    expect(screen.getAllByRole("img")[0].getAttribute("src")).toContain("000000000002");
    await userEvent.click(screen.getByRole("button", { name: "移除第 1 張照片" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("上傳失敗顯示原因", async () => {
    const upload = vi.fn().mockRejectedValue(new MarketImageError("只收 JPG、PNG、WebP 照片"));
    render(<PhotoHarness initial={[]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file()]);
    expect(await screen.findByText("只收 JPG、PNG、WebP 照片")).toBeInTheDocument();
  });
});

const renderDialog = (product: MarketProductRow | null, save = vi.fn().mockResolvedValue({ row: { ...CABBAGE }, alreadySaved: false })) => {
  const onSaved = vi.fn();
  render(
    <MarketProductDialog open onOpenChange={vi.fn()} supplierId={SUPPLIER_A} product={product} onSaved={onSaved} save={save} upload={vi.fn()} />,
  );
  return { save, onSaved };
};

describe("MarketProductDialog", () => {
  it("新商品:必填沒填會擋;填好按「送出審核」送 submit=true 與畫面先決定的 id", async () => {
    const { save, onSaved } = renderDialog(null);
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "送出審核" }));
    expect(screen.getByLabelText("品名 *")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("請填品名")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("品名 *"), "有機高麗菜");
    await userEvent.selectOptions(screen.getByLabelText("分類 *"), "vegetable");
    await userEvent.type(screen.getByLabelText("零售規格 *"), "1 顆");
    await userEvent.type(screen.getByLabelText("零售價(元)*"), "120");
    await userEvent.click(screen.getByLabelText("冷藏"));
    await userEvent.click(within(dialog).getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0][0];
    expect(input).toMatchObject({ supplierId: SUPPLIER_A, isNew: true, submit: true, form: { name: "有機高麗菜", temperature: "chilled" } });
    expect(input.productId).toMatch(/^[0-9a-f-]{36}$/);
    // onSaved 與提示在 save 的 Promise 回來之後才跑:要等,不能看到 save 被呼叫就同步檢查
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("已送出審核");
  });

  it("退回的商品:顯示原因,按鈕是「儲存(先不送審)」與「重新送審」", () => {
    renderDialog({ ...CABBAGE, review_status: "rejected", reject_reason: "照片太暗" });
    expect(screen.getByText(/退回原因:照片太暗/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存(先不送審)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新送審" })).toBeInTheDocument();
  });

  it("已核准的商品:只有「儲存」、有上架開關、提醒哪些欄位會重審", async () => {
    const { save } = renderDialog({ ...CABBAGE, review_status: "approved" });
    expect(screen.queryByRole("button", { name: "送出審核" })).toBeNull();
    expect(screen.getByRole("switch", { name: /上架中/ })).toBeChecked();
    expect(screen.getByText(/只改價格、庫存、上架開關不用重審/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ isNew: false, submit: false, productId: CABBAGE.id })));
  });

  it("資料庫擋下時顯示中文原因,視窗不關", async () => {
    const save = vi.fn().mockRejectedValue(new MarketDbError({ message: "fk", code: "23503" }));
    renderDialog({ ...CABBAGE, review_status: "draft" }, save);
    await userEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "請先完成「零售市集 › 店家設定」再新增零售商品" }),
    );
  });
});

describe("SupplierMarketProductsPanel", () => {
  it("沒建店家:新增鈕停用,提示去店家設定", () => {
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel products={[]} hasStore={false} loading={false} error={null} onCreate={vi.fn()} onEdit={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "新增零售商品" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "零售市集 › 店家設定" })).toHaveAttribute("href", "/supplier/market/store");
  });

  it("列出狀態與退回原因,編輯回傳那一筆", async () => {
    const onEdit = vi.fn();
    const rejected = { ...CABBAGE, review_status: "rejected" as const, reject_reason: "照片太暗" };
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel products={[rejected]} hasStore loading={false} error={null} onCreate={vi.fn()} onEdit={onEdit} />
      </MemoryRouter>,
    );
    expect(screen.getByText("退回")).toBeInTheDocument();
    expect(screen.getByText("退回原因:照片太暗")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "編輯 有機高麗菜" }));
    expect(onEdit).toHaveBeenCalledWith(rejected);
    expect(statusText({ review_status: "approved", is_listed: false })).toBe("已核准・暫停販售");
  });
});

describe("MarketPhotoField — 上傳中與觸控大小", () => {
  it("上傳中:設封面、移除都停用(上傳完才把新照片加進清單,不會蓋掉期間的變更),並通知父層", async () => {
    const { upload, finish } = pendingUpload();
    const onBusyChange = vi.fn();
    render(<PhotoHarness initial={[photo(1), photo(2)]} upload={upload} onBusyChange={onBusyChange} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file()]);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("button", { name: "移除第 1 張照片" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "第 2 張設為封面" })).toBeDisabled();
    finish(photo(3));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(3));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "移除第 1 張照片" })).toBeEnabled();
  });

  it("設封面、移除按鈕與選檔欄位的可點範圍至少 44px", () => {
    render(<PhotoHarness initial={[photo(1), photo(2)]} upload={vi.fn()} />);
    for (const name of ["第 2 張設為封面", "移除第 1 張照片", "移除第 2 張照片"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("h-11", "w-11");
    }
    expect(screen.getByLabelText("新增照片")).toHaveClass("min-h-11", "file:min-h-11");
  });
});

describe("MarketProductDialog — 上傳中、出錯的焦點、版面", () => {
  it("照片還在上傳時不能儲存;上傳完成才放行,存進去的有那張照片", async () => {
    const { upload, finish } = pendingUpload();
    const save = vi.fn().mockResolvedValue({ row: { ...CABBAGE }, alreadySaved: false });
    render(
      <MarketProductDialog
        open
        onOpenChange={vi.fn()}
        supplierId={SUPPLIER_A}
        product={{ ...CABBAGE, review_status: "draft" }}
        onSaved={vi.fn()}
        save={save}
        upload={upload}
      />,
    );
    await userEvent.upload(screen.getByLabelText("新增照片"), [file()]);
    await waitFor(() => expect(screen.getByRole("button", { name: "送出審核" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "儲存草稿" })).toBeDisabled();
    finish(photo(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "送出審核" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].form.photos).toEqual([photo(1)]);
  });

  it("驗證沒過:焦點移到第一個出錯的欄位(視窗很長,按鈕在最下面時錯誤訊息可能在畫面外)", async () => {
    renderDialog(null);
    await userEvent.click(screen.getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(screen.getByLabelText("品名 *")).toHaveFocus());
    await userEvent.type(screen.getByLabelText("品名 *"), "有機高麗菜");
    await userEvent.selectOptions(screen.getByLabelText("分類 *"), "vegetable");
    await userEvent.type(screen.getByLabelText("零售規格 *"), "1 顆");
    await userEvent.click(screen.getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(screen.getByLabelText("零售價(元)*")).toHaveFocus());
  });

  it("底部按鈕至少 44px 高;勾「不限」時庫存欄看得出是停用的", () => {
    renderDialog(null);
    for (const name of ["取消", "儲存草稿", "送出審核"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11");
    }
    expect(screen.getByLabelText("庫存")).toBeDisabled();
    expect(screen.getByLabelText("庫存")).toHaveClass("disabled:bg-slate-100");
  });
});

describe("SupplierMarketProductsPanel — 讀取失敗與版面", () => {
  it("讀取失敗:只顯示原因與「重新載入」,不顯示清單與新增鈕(不能拿舊的或空的資料編輯)", async () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel
          products={[CABBAGE]}
          hasStore
          loading={false}
          error="連線失敗,請檢查網路後再試一次"
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onRetry={onRetry}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("零售商品讀取失敗:連線失敗,請檢查網路後再試一次");
    expect(screen.queryByRole("button", { name: "新增零售商品" })).toBeNull();
    expect(screen.queryByRole("button", { name: "編輯 有機高麗菜" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "重新載入" })).toHaveClass("min-h-11");
  });

  it("狀態徽章跟品名放在同一個資訊欄(窄螢幕不跟編輯鈕搶寬度、不會把品名擠成「動物…」);新增鈕 44px", () => {
    const rejected = { ...CABBAGE, review_status: "rejected" as const, reject_reason: "照片太暗" };
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel products={[rejected]} hasStore loading={false} error={null} onCreate={vi.fn()} onEdit={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("有機高麗菜").parentElement).toContainElement(screen.getByText("退回"));
    expect(screen.getByRole("button", { name: "新增零售商品" })).toHaveClass("min-h-11");
  });
});

// 樂觀鎖(別人先改過就不覆寫)、新商品重送(回應遺失後重按)、狀態文字照消費者實際看到的寫。
const STAMP = "2026-10-10T07:00:00.123456+00:00";

describe("MarketProductDialog — 樂觀鎖與新商品重送", () => {
  it("修改既有商品:把讀到的 updated_at 原字串交給儲存", async () => {
    const { save } = renderDialog({ ...CABBAGE, review_status: "approved", updated_at: STAMP });
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ isNew: false, expectedUpdatedAt: STAMP })));
  });

  it("別人先改過:顯示原因、視窗不關、不能再存;按「重新載入」才關視窗並請父層重新讀取", async () => {
    const save = vi.fn().mockRejectedValue(new MarketStaleProductError());
    const onOpenChange = vi.fn();
    const onStale = vi.fn();
    const onSaved = vi.fn();
    render(
      <MarketProductDialog
        open
        onOpenChange={onOpenChange}
        supplierId={SUPPLIER_A}
        product={{ ...CABBAGE, review_status: "approved", updated_at: STAMP }}
        onSaved={onSaved}
        onStale={onStale}
        save={save}
        upload={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "這個商品已被其他人更新,請重新載入後再改" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("這個商品已被其他人更新,請重新載入後再改");
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 撞主鍵的補存(saveMarketProduct 用讀回那一筆的 updated_at 再存一次這次的內容)完成後,狀態就是使用者按的那個:
  // 按「送出審核」就提示「已送出審核」,不能說「已儲存」卻還停在草稿。
  it("新商品重按時資料庫已經有自家的那一筆:補存完照按的按鈕提示,並交給父層換進清單", async () => {
    const saved = { ...CABBAGE, review_status: "pending" as const, price: 150 };
    const { onSaved } = renderDialog(null, vi.fn().mockResolvedValue({ row: saved, alreadySaved: true }));
    await userEvent.type(screen.getByLabelText("品名 *"), "有機高麗菜");
    await userEvent.selectOptions(screen.getByLabelText("分類 *"), "vegetable");
    await userEvent.type(screen.getByLabelText("零售規格 *"), "1 顆");
    await userEvent.type(screen.getByLabelText("零售價(元)*"), "150");
    await userEvent.click(screen.getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已送出審核"));
    expect(toastSuccess).not.toHaveBeenCalledWith("已儲存");
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("新商品的 id 可以由父層指定(同一個來源沿用還沒確認存好的 id)", async () => {
    const save = vi.fn().mockResolvedValue({ row: { ...CABBAGE }, alreadySaved: false });
    render(
      <MarketProductDialog
        open
        onOpenChange={vi.fn()}
        supplierId={SUPPLIER_A}
        product={null}
        newProductId="a9300000-0000-4000-8000-0000000000e1"
        onSaved={vi.fn()}
        save={save}
        upload={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText("品名 *"), "有機高麗菜");
    await userEvent.selectOptions(screen.getByLabelText("分類 *"), "vegetable");
    await userEvent.type(screen.getByLabelText("零售規格 *"), "1 顆");
    await userEvent.type(screen.getByLabelText("零售價(元)*"), "120");
    await userEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ isNew: true, productId: "a9300000-0000-4000-8000-0000000000e1" })));
  });
});

describe("statusText — 照消費者實際看到的寫", () => {
  it("店家停用(零售被暫停或供應商帳號停用)、暫停販售、缺貨都不寫「已上架」", () => {
    const approved = { review_status: "approved" as const, is_listed: true };
    expect(statusText({ ...approved, stock: 5 })).toBe("已上架");
    expect(statusText({ ...approved, stock: null })).toBe("已上架");
    expect(statusText({ ...approved, stock: 0 })).toBe("已上架・缺貨");
    expect(statusText({ ...approved, stock: 5 }, false)).toBe("已核准・店家停用中(消費者看不到)");
    expect(statusText({ ...approved, is_listed: false, stock: 0 }, false)).toBe("已核准・店家停用中(消費者看不到)");
    expect(statusText({ ...approved, is_listed: false, stock: 0 })).toBe("已核准・暫停販售");
    expect(statusText({ review_status: "pending", is_listed: true, stock: 0 }, false)).toBe("待審");
  });

  it("清單:缺貨寫「已上架・缺貨」、店家停用時已核准的都寫「店家停用中」,而且不是綠色", () => {
    const soldOut = { ...CABBAGE, id: "a9300000-0000-4000-8000-0000000000a9", name: "缺貨的高麗菜", review_status: "approved" as const, stock: 0 };
    const listed = { ...CABBAGE, review_status: "approved" as const };
    const props = { hasStore: true, loading: false, error: null, onCreate: vi.fn(), onEdit: vi.fn() };
    const { rerender } = render(
      <MemoryRouter>
        <SupplierMarketProductsPanel {...props} products={[listed, soldOut]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("已上架")).toHaveClass("bg-emerald-50");
    expect(screen.getByText("已上架・缺貨")).toHaveClass("bg-amber-50");
    rerender(
      <MemoryRouter>
        <SupplierMarketProductsPanel {...props} products={[listed, soldOut]} storeOpen={false} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText("已核准・店家停用中(消費者看不到)")).toHaveLength(2);
    expect(screen.queryByText("已上架")).toBeNull();
    screen.getAllByText("已核准・店家停用中(消費者看不到)").forEach((badge) => expect(badge).toHaveClass("bg-amber-50"));
  });
});

// 認不得的錯誤不顯示英文原文(比照店家設定):資料庫錯誤附錯誤代碼,其他例外只給中文備援。
describe("錯誤訊息一律中文", () => {
  it("照片上傳遇到認不得的錯誤:顯示「上傳失敗,請再試一次」,不顯示英文原文", async () => {
    const upload = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'upload')"));
    render(<PhotoHarness initial={[]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file()]);
    expect(await screen.findByText("上傳失敗,請再試一次")).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it("儲存遇到認不得的錯誤:資料庫錯誤附錯誤代碼,其他例外只說請稍後再試", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new MarketDbError({ message: "unexpected internal error", code: "XX000" }))
      .mockRejectedValueOnce(new Error("boom"));
    renderDialog({ ...CABBAGE, review_status: "draft" }, save);
    await userEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "請稍後再試(錯誤代碼 XX000)" }));
    await userEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "請稍後再試" }));
  });
});

// 已核准的商品改了品名、說明或照片,資料庫會改回待審(market_products_guard):提示要講清楚消費者暫時看不到。
describe("MarketProductDialog — 改回待審的提示", () => {
  it("已核准的商品存完變成待審:提示「已重新送審,通過前消費者看不到」;只改價格(仍是已核准)才說「已儲存」", async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ row: { ...CABBAGE, review_status: "pending" }, alreadySaved: false })
      .mockResolvedValueOnce({ row: { ...CABBAGE, review_status: "approved" }, alreadySaved: false });
    renderDialog({ ...CABBAGE, review_status: "approved", updated_at: STAMP }, save);
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("已重新送審,通過前消費者看不到"));
    expect(toastSuccess).not.toHaveBeenCalledWith("已儲存");
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenLastCalledWith("已儲存"));
  });
});
