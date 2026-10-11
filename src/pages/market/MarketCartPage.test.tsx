// /market/cart:按店家分組、小計 / 運費 / 免運差額 / 最低金額、改數量、下架商品、下單開關沒開時不能前往結帳。
// 檔尾另外釘住:離線、載入失敗、移除商品時不閃成載入中、下單開關查不到 —— 這幾種都不能把購物車裡的商品說成「已下架」或「還沒開放」。
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchProductsByIds: vi.fn(),
}));
vi.mock("@/lib/market/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/checkout")>()),
  fetchCheckoutStatus: vi.fn(),
}));

import { fetchProductsByIds } from "@/lib/market/catalog";
import { fetchCheckoutStatus } from "@/lib/market/checkout";
import { BEEF, CABBAGE, SALMON } from "@/lib/market/testFixtures";
import type { MarketProductRow } from "@/lib/market/types";
import { cartStore } from "@/lib/market/useCart";
import MarketCartPage from "./MarketCartPage";
import { renderMarketRoute } from "./testUtils";

const renderCart = () => renderMarketRoute("/market/cart", [{ path: "/market/cart", element: <MarketCartPage /> }]);
const store = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
  // mockReset:上一個測試沒用完的 mockResolvedValueOnce 不會留到這個測試(clearMocks 只清呼叫紀錄)
  vi.mocked(fetchProductsByIds).mockReset().mockResolvedValue([CABBAGE, BEEF, SALMON]);
  vi.mocked(fetchCheckoutStatus).mockReset().mockResolvedValue({ open: true, can_order: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketCartPage", () => {
  it("空的購物車:說明 + 去逛市集", () => {
    renderCart();
    expect(screen.getByText("購物車是空的。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去逛市集" })).toHaveAttribute("href", "/market");
    expect(fetchProductsByIds).not.toHaveBeenCalled();
  });

  it("按店家分組:每家店的小計、運費、合計、再買多少免運;全部合計;可以前往結帳", async () => {
    cartStore.add(CABBAGE.id, 2);
    cartStore.add(SALMON.id, 1);
    cartStore.add(BEEF.id, 1);
    renderCart();
    await screen.findByRole("region", { name: "市集測試 A 店" });
    const a = within(store("市集測試 A 店"));
    expect(a.getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("有機高麗菜"), expect.stringContaining("牛肉片")]);
    expect(a.getByText("NT$ 650")).toBeInTheDocument();
    expect(a.getByText("NT$ 120")).toBeInTheDocument();
    expect(a.getByText("NT$ 770")).toBeInTheDocument();
    expect(a.getByText("再買 NT$ 350 就免運")).toBeInTheDocument();
    expect(within(store("市集測試 B 店")).getByText("NT$ 260")).toBeInTheDocument();
    expect(screen.getByText("NT$ 1,030")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往結帳" })).toHaveAttribute("href", "/market/checkout");
  });

  it("沒到最低訂購金額:紅字說明、不能前往結帳;加一件就可以了", async () => {
    cartStore.add(CABBAGE.id, 2);
    renderCart();
    expect(await screen.findByText("還差 NT$ 100 才到這家店的最低訂購金額 NT$ 300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往結帳" })).toBeDisabled();
    await userEvent.click(within(screen.getByRole("group", { name: "有機高麗菜 數量" })).getByRole("button", { name: "增加一件" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
    expect(await screen.findByRole("link", { name: "前往結帳" })).toBeInTheDocument();
  });

  it("已下架的商品另外列出來,可以一次移除", async () => {
    cartStore.add(CABBAGE.id, 3);
    cartStore.add(BEEF.id, 1);
    vi.mocked(fetchProductsByIds).mockResolvedValue([CABBAGE, { ...BEEF, is_listed: false }]);
    renderCart();
    expect(await screen.findByRole("heading", { name: "1 項商品已下架或暫停販售" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "從購物車移除" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
  });

  it("移除單一商品", async () => {
    cartStore.add(CABBAGE.id, 3);
    cartStore.add(SALMON.id, 1);
    renderCart();
    await userEvent.click(await screen.findByRole("button", { name: "移除 挪威鮭魚" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
  });

  it("下單還沒對外開放:提示可以先逛,前往結帳不能按", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: false });
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText(/線上訂購還沒對外開放,現在可以先逛/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往結帳" })).toBeDisabled();
    expect(screen.getByText("線上訂購還沒對外開放。")).toBeInTheDocument();
  });

  it("還沒開放但你是平台管理員:提示可以下測試單", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: true });
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText("市集還沒對外開放;你是平台管理員,可以下測試單。")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "前往結帳" })).toBeInTheDocument();
  });
});

describe("MarketCartPage:離線、載入失敗、換一組商品、下單開關查不到", () => {
  afterEach(() => onlineManager.setOnline(true));

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("離線時第一次載入:顯示離線提示,不把購物車裡的商品說成已下架(不給「從購物車移除」);連線後自動載入", async () => {
    onlineManager.setOnline(false);
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText("目前離線,連線後會自動重新載入。")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /已下架/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "從購物車移除" })).toBeNull();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByRole("region", { name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.queryByText("目前離線,連線後會自動重新載入。")).toBeNull();
  });

  it("商品資料載入失敗:顯示原因與重新載入,不把商品說成已下架;重新載入成功就顯示購物車", async () => {
    vi.mocked(fetchProductsByIds).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce([CABBAGE]);
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByRole("alert")).toHaveTextContent("商品資料載入失敗");
    expect(screen.queryByRole("heading", { name: /已下架/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByRole("region", { name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("移除商品時其他店照樣顯示(不整頁閃成載入中);別的分頁剛加進來、還沒查到的商品不算已下架", async () => {
    const afterRemove = deferred<MarketProductRow[]>();
    const afterAdd = deferred<MarketProductRow[]>();
    vi.mocked(fetchProductsByIds)
      .mockResolvedValueOnce([CABBAGE, SALMON])
      .mockReturnValueOnce(afterRemove.promise)
      .mockReturnValueOnce(afterAdd.promise);
    cartStore.add(CABBAGE.id, 3);
    cartStore.add(SALMON.id, 1);
    const { container } = renderCart();
    await userEvent.click(await screen.findByRole("button", { name: "移除 挪威鮭魚" }));
    // 商品清單變了 → 查詢的 key 跟著變,新的那次還沒回來
    expect(fetchProductsByIds).toHaveBeenLastCalledWith([CABBAGE.id]);
    expect(store("市集測試 A 店")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "市集測試 B 店" })).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    act(() => cartStore.add(BEEF.id, 1)); // 等於別的分頁加了一件(storage 事件也是走同一個 store)
    expect(fetchProductsByIds).toHaveBeenLastCalledWith([CABBAGE.id, BEEF.id]);
    expect(screen.queryByRole("heading", { name: /已下架/ })).toBeNull();
    expect(store("市集測試 A 店")).toBeInTheDocument();

    await act(async () => afterAdd.resolve([CABBAGE, BEEF]));
    expect(await within(store("市集測試 A 店")).findByText("牛肉片")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /已下架/ })).toBeNull();
  });

  it("下單開關查詢失敗:不說還沒開放,可以重新確認;確認可以下單後就能前往結帳", async () => {
    vi.mocked(fetchCheckoutStatus).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ open: true, can_order: true });
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText("沒辦法確認線上訂購是否開放,請檢查網路後再試一次。")).toBeInTheDocument();
    expect(screen.queryByText(/還沒對外開放/)).toBeNull();
    expect(screen.getByRole("button", { name: "前往結帳" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重新確認" }));
    expect(await screen.findByRole("link", { name: "前往結帳" })).toHaveAttribute("href", "/market/checkout");
  });
});
