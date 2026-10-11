// useCart:存進 localStorage、重新整理讀得回來、別的分頁改了會同步;localStorage 壞掉也不會讓頁面掛掉。
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { CART_STORAGE_KEY } from "./cart";
import { BEEF, CABBAGE } from "./testFixtures";
import { cartStore, useCart } from "./useCart";

let storage: Storage;
beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  cartStore.resetForTests();
});
afterEach(() => {
  // vitest 沒開 globals,Testing Library 不會自動 cleanup:上一個測試的 hook 沒卸載的話會一直訂閱,「沒有人在看」的情境測不到
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCart", () => {
  it("加入後存進 localStorage;重新整理(丟掉記憶體)讀得回來", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.add(CABBAGE.id, 2, 10));
    expect(result.current.count).toBe(2);
    expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? "[]")).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
    cartStore.resetForTests();
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
  });

  it("改數量、移除", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.add(CABBAGE.id, 1);
      result.current.add(BEEF.id, 1);
    });
    act(() => result.current.setQty(CABBAGE.id, 5));
    act(() => result.current.remove([BEEF.id]));
    expect(result.current.lines).toEqual([{ productId: CABBAGE.id, qty: 5 }]);
  });

  it("別的分頁改了購物車(storage 事件)會跟著更新", () => {
    const { result } = renderHook(() => useCart());
    storage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: BEEF.id, qty: 3 }]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CART_STORAGE_KEY }));
    });
    expect(result.current.count).toBe(3);
  });

  it("沒有畫面在看購物車時(離開市集)別的分頁改了:回來時讀到新的,再加入也不會蓋掉別的分頁加的", () => {
    const first = renderHook(() => useCart());
    act(() => first.result.current.add(CABBAGE.id, 1));
    first.unmount(); // 沒有人訂閱 → 不聽 storage 事件
    // 別的分頁加了牛肉;這個分頁沒有人在聽,事件等於沒收到
    storage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify([
        { productId: CABBAGE.id, qty: 1 },
        { productId: BEEF.id, qty: 2 },
      ]),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: CART_STORAGE_KEY }));
    const again = renderHook(() => useCart());
    expect(again.result.current.lines).toEqual([
      { productId: CABBAGE.id, qty: 1 },
      { productId: BEEF.id, qty: 2 },
    ]);
    act(() => again.result.current.add(CABBAGE.id, 1));
    expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? "[]")).toEqual([
      { productId: CABBAGE.id, qty: 2 },
      { productId: BEEF.id, qty: 2 },
    ]);
  });

  it("localStorage 寫不進去時,離開市集再回來,記憶體裡的購物車還在(不被 localStorage 裡舊的那份蓋掉)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    cartStore.resetForTests();
    const first = renderHook(() => useCart());
    act(() => first.result.current.add(CABBAGE.id, 1));
    first.unmount();
    const again = renderHook(() => useCart());
    expect(again.result.current.lines).toEqual([{ productId: CABBAGE.id, qty: 1 }]);
  });

  it("localStorage 一碰就丟例外(無痕、封鎖):當成空的,加入照樣有效(只在記憶體)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    cartStore.resetForTests();
    const { result } = renderHook(() => useCart());
    expect(result.current.lines).toEqual([]);
    act(() => result.current.add(CABBAGE.id, 1));
    expect(result.current.count).toBe(1);
  });
});
