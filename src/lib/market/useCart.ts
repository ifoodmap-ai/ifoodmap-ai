// 購物車狀態:整個市集共用一份,存在 localStorage(key = CART_STORAGE_KEY);useSyncExternalStore 訂閱,
// 別的分頁改了也會同步(storage 事件)。
// 🔴 localStorage 在無痕模式、封鎖網站資料時可能一讀寫就丟例外:一律 try/catch —— 讀不到當空的,寫不進去就只留在這個分頁的記憶體。
import { useSyncExternalStore } from "react";
import { addLine, CART_STORAGE_KEY, cartCount, type CartLine, parseCart, removeLines, setLineQty } from "./cart";

const listeners = new Set<() => void>();
let cache: CartLine[] | null = null;

const read = (): CartLine[] => {
  try {
    return parseCart(window.localStorage.getItem(CART_STORAGE_KEY));
  } catch {
    return [];
  }
};

const getSnapshot = (): CartLine[] => {
  if (cache === null) cache = read();
  return cache;
};

const emit = () => listeners.forEach((l) => l());

const write = (next: CartLine[]) => {
  if (next === cache) return;
  cache = next;
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 寫不進去:只留在記憶體 */
  }
  emit();
};

const onStorage = (e: StorageEvent) => {
  if (e.key !== null && e.key !== CART_STORAGE_KEY) return;
  cache = read();
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
};

export const cartStore = {
  get: getSnapshot,
  /** max = 這個商品最多能買幾件(庫存) */
  add: (productId: string, qty: number, max?: number) => write(addLine(getSnapshot(), productId, qty, max)),
  setQty: (productId: string, qty: number, max?: number) => write(setLineQty(getSnapshot(), productId, qty, max)),
  remove: (productIds: Iterable<string>) => write(removeLines(getSnapshot(), productIds)),
  /** 只給測試用:丟掉記憶體裡的那份,下次重新讀 localStorage */
  resetForTests: () => {
    cache = null;
  },
};

const EMPTY: CartLine[] = [];

export const useCart = () => {
  const lines = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  return { lines, count: cartCount(lines), add: cartStore.add, setQty: cartStore.setQty, remove: cartStore.remove };
};
