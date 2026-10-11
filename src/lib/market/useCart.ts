// 購物車狀態:整個市集共用一份,存在 localStorage(key = CART_STORAGE_KEY);useSyncExternalStore 訂閱,
// 別的分頁改了也會同步(storage 事件)。沒有人訂閱的期間(離開了市集)不聽 storage 事件,重新開始訂閱時跟 localStorage 對一次。
// 🔴 localStorage 在無痕模式、封鎖網站資料時可能一讀寫就丟例外:一律 try/catch —— 讀不到當空的,寫不進去就只留在這個分頁的記憶體。
import { useSyncExternalStore } from "react";
import { addLine, CART_STORAGE_KEY, cartCount, type CartLine, parseCart, removeLines, setLineQty } from "./cart";

const listeners = new Set<() => void>();
let cache: CartLine[] | null = null;
/** 最後一次寫入有沒有存進 localStorage:沒存進去時,記憶體裡的那份比 localStorage 新(而且是唯一的一份) */
let persisted = true;

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
    persisted = true;
  } catch {
    /* 寫不進去:只留在記憶體 */
    persisted = false;
  }
  emit();
};

/**
 * 沒有人訂閱的期間別的分頁改過購物車的話,記憶體裡這份是舊的 —— 不對一次的話,畫面顯示舊的,下一次加入還會把別的分頁的修改蓋掉。
 * 讀不到 localStorage、或這個分頁最後一次寫入沒存進去時不對(記憶體裡的才是對的)。
 * 內容一樣就沿用原本的陣列:useSyncExternalStore 用 Object.is 比對,換新陣列會多畫一次。
 * 只改 cache、不 emit:React 訂閱完會再拿一次 snapshot 比對,不一樣就重畫。
 */
const resync = () => {
  if (cache === null || !persisted) return;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CART_STORAGE_KEY);
  } catch {
    return;
  }
  const fresh = parseCart(raw);
  if (JSON.stringify(fresh) !== JSON.stringify(cache)) cache = fresh;
};

const onStorage = (e: StorageEvent) => {
  if (e.key !== null && e.key !== CART_STORAGE_KEY) return;
  try {
    cache = parseCart(window.localStorage.getItem(CART_STORAGE_KEY));
    persisted = true; // 記憶體又跟 localStorage 一樣了:之後重新訂閱時要再對(不然寫入失敗過一次就永遠不對)
  } catch {
    cache = [];
  }
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
    resync();
  }
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
    persisted = true;
  },
};

const EMPTY: CartLine[] = [];

export const useCart = () => {
  const lines = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  return { lines, count: cartCount(lines), add: cartStore.add, setQty: cartStore.setQty, remove: cartStore.remove };
};
