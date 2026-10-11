// useCart:存進 localStorage、重新整理讀得回來、別的分頁改了會同步;localStorage 壞掉也不會讓頁面掛掉。
import { act, renderHook } from "@testing-library/react";
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
