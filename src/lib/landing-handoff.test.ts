// 形象站 → 產品站的 AI 需求交接碼(SPEC §7):格式驗證、7 天有效、網址片段立刻拿掉。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";
import {
  HANDOFF_STORAGE_KEY,
  HANDOFF_TTL_MS,
  captureHandoffFromUrl,
  clearStoredHandoff,
  isValidHandoff,
  readStoredHandoff,
  saveHandoff,
} from "./landing-handoff";

const ANALYSIS_ID = "3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0d";
// 32 bytes 的 base64url(43 字、不補位)—— 跟後端產生的 claimToken 同格式
const TOKEN = "q5Vh2kK8mX0bZr3Lw9TfYc1NpQe7JdUsHaGiOvRx4yA";
const HANDOFF = `${ANALYSIS_ID}.${TOKEN}`;
const NOW = Date.UTC(2026, 9, 7, 2, 0, 0);

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  clearStoredHandoff();
  window.history.replaceState(null, "", "/register/restaurant");
});

afterEach(() => {
  clearStoredHandoff();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("isValidHandoff:uuid + '.' + base64url,長度合理", () => {
  it("接受正確格式(token 43 字);uuid 大小寫都可以", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isValidHandoff(HANDOFF)).toBe(true);
    expect(isValidHandoff(`${ANALYSIS_ID.toUpperCase()}.${TOKEN}`)).toBe(true);
    // 長度只要合理:32–128 字都收,容許 base64 補位的 =
    expect(isValidHandoff(`${ANALYSIS_ID}.${"a".repeat(32)}`)).toBe(true);
    expect(isValidHandoff(`${ANALYSIS_ID}.${"a".repeat(128)}`)).toBe(true);
    expect(isValidHandoff(`${ANALYSIS_ID}.${TOKEN}=`)).toBe(true);
  });

  it.each([
    ["空字串", ""],
    ["只有 uuid", ANALYSIS_ID],
    ["沒有點", `${ANALYSIS_ID}${TOKEN}`],
    ["uuid 壞掉", `3f2b8c1e-9a4d-4e7b-8c21-5d6f7a8b9c0.${TOKEN}`],
    ["uuid 不是 hex", `zzzzzzzz-9a4d-4e7b-8c21-5d6f7a8b9c0d.${TOKEN}`],
    ["token 太短(31 字)", `${ANALYSIS_ID}.${"a".repeat(31)}`],
    ["token 太長(129 字)", `${ANALYSIS_ID}.${"a".repeat(129)}`],
    ["token 有一般 base64 的 + /", `${ANALYSIS_ID}.${TOKEN.slice(0, 40)}+/a`],
    ["多一個點", `${ANALYSIS_ID}.${TOKEN}.x`],
    ["token 有空白", `${ANALYSIS_ID}.${TOKEN.slice(0, 20)} ${TOKEN.slice(21)}`],
    ["前面多空白", ` ${HANDOFF}`],
    ["script 注入", `${ANALYSIS_ID}.<script>alert(1)</script>aaaaaaaaaaaaaaaa`],
  ])("拒絕:%s", (_label, value) => {
    expect(isValidHandoff(value)).toBe(false);
  });

  it("不是字串一律拒絕", () => {
    expect(isValidHandoff(null)).toBe(false);
    expect(isValidHandoff(undefined)).toBe(false);
    expect(isValidHandoff(123)).toBe(false);
    expect(isValidHandoff({ v: HANDOFF })).toBe(false);
  });
});

describe("localStorage ifm:handoff = {v, at},7 天有效", () => {
  it("存進去的格式是 {v, at}", () => {
    saveHandoff(HANDOFF, NOW);
    expect(JSON.parse(storage.getItem(HANDOFF_STORAGE_KEY) ?? "null")).toEqual({ v: HANDOFF, at: NOW });
    expect(readStoredHandoff(NOW)).toBe(HANDOFF);
  });

  it("剛好 7 天還有效;多 1 毫秒就過期,讀的時候順手清掉", () => {
    saveHandoff(HANDOFF, NOW);
    expect(readStoredHandoff(NOW + HANDOFF_TTL_MS)).toBe(HANDOFF);

    expect(readStoredHandoff(NOW + HANDOFF_TTL_MS + 1)).toBeNull();
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    // 清掉之後就算時間倒回來也讀不到了
    expect(readStoredHandoff(NOW)).toBeNull();
  });

  it("TTL 是 7 天", () => {
    expect(HANDOFF_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    ["不是 JSON", "not-json"],
    ["v 格式不對", JSON.stringify({ v: "bad", at: NOW })],
    ["沒有 at", JSON.stringify({ v: HANDOFF })],
    ["at 不是數字", JSON.stringify({ v: HANDOFF, at: "2026-10-07" })],
  ])("壞掉的值(%s)→ 讀不到、而且被清掉", (_label, raw) => {
    storage.setItem(HANDOFF_STORAGE_KEY, raw);
    expect(readStoredHandoff(NOW)).toBeNull();
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it("格式不對的交接碼不會被存", () => {
    saveHandoff("not-a-handoff", NOW);
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    expect(readStoredHandoff(NOW)).toBeNull();
  });

  it("clearStoredHandoff 清掉", () => {
    saveHandoff(HANDOFF, NOW);
    clearStoredHandoff();
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
    expect(readStoredHandoff(NOW)).toBeNull();
  });

  it("另一個分頁清掉了(localStorage 沒有了)→ 不會從記憶體備援讀回來", () => {
    saveHandoff(HANDOFF, NOW);
    storage.removeItem(HANDOFF_STORAGE_KEY);
    expect(readStoredHandoff(NOW)).toBeNull();
  });

  it("localStorage 不能用(Node 25 的空物件、封鎖網站資料)→ 同一個網頁執行期內還讀得到,也照樣 7 天過期", () => {
    vi.stubGlobal("localStorage", {});
    saveHandoff(HANDOFF, NOW);
    expect(readStoredHandoff(NOW + 1000)).toBe(HANDOFF);
    expect(readStoredHandoff(NOW + HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("寫入丟錯(額度滿)→ 退回記憶體備援,不丟錯", () => {
    const broken = createMemoryStorage();
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    vi.stubGlobal("localStorage", broken);
    expect(() => saveHandoff(HANDOFF, NOW)).not.toThrow();
    expect(readStoredHandoff(NOW)).toBe(HANDOFF);
  });
});

describe("captureHandoffFromUrl:讀到 #handoff= 就存起來,立刻用 replaceState 拿掉片段", () => {
  it("形象站的網址(encodeURIComponent 過)→ 回傳交接碼、存進 localStorage、片段從網址拿掉", () => {
    window.history.replaceState({ usr: null, key: "abc", idx: 0 }, "", `/register/restaurant#handoff=${encodeURIComponent(HANDOFF)}`);
    const spy = vi.spyOn(window.history, "replaceState");

    expect(captureHandoffFromUrl(NOW)).toBe(HANDOFF);

    expect(spy).toHaveBeenCalledTimes(1);
    // 保留 React Router 的 history.state,只換網址
    expect(spy).toHaveBeenCalledWith({ usr: null, key: "abc", idx: 0 }, "", "/register/restaurant");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.parse(storage.getItem(HANDOFF_STORAGE_KEY) ?? "null")).toEqual({ v: HANDOFF, at: NOW });
  });

  it("補位的 = 被編成 %3D 也解得回來", () => {
    const padded = `${ANALYSIS_ID}.${TOKEN}=`;
    window.history.replaceState(null, "", `/register/restaurant#handoff=${encodeURIComponent(padded)}`);
    expect(captureHandoffFromUrl(NOW)).toBe(padded);
  });

  it("query string 保留、片段裡其他參數保留,只拿掉 handoff", () => {
    window.history.replaceState(null, "", `/register/restaurant?ref=landing#utm=x&handoff=${encodeURIComponent(HANDOFF)}`);
    const spy = vi.spyOn(window.history, "replaceState");

    expect(captureHandoffFromUrl(NOW)).toBe(HANDOFF);
    expect(spy).toHaveBeenCalledWith(null, "", "/register/restaurant?ref=landing#utm=x");
    expect(window.location.search).toBe("?ref=landing");
    expect(window.location.hash).toBe("#utm=x");
  });

  it("格式不對 → 一樣從網址拿掉,但不存、也不蓋掉之前存的有效交接碼", () => {
    saveHandoff(HANDOFF, NOW - 1000);
    window.history.replaceState(null, "", "/register/restaurant#handoff=garbage");
    const spy = vi.spyOn(window.history, "replaceState");

    expect(captureHandoffFromUrl(NOW)).toBeNull();
    expect(spy).toHaveBeenCalledWith(null, "", "/register/restaurant");
    expect(window.location.hash).toBe("");
    expect(readStoredHandoff(NOW)).toBe(HANDOFF);
  });

  it("新的有效交接碼覆蓋舊的(最新一段對話為準)", () => {
    const older = `${ANALYSIS_ID}.${"b".repeat(43)}`;
    saveHandoff(older, NOW - 1000);
    window.history.replaceState(null, "", `/register/restaurant#handoff=${HANDOFF}`);
    expect(captureHandoffFromUrl(NOW)).toBe(HANDOFF);
    expect(readStoredHandoff(NOW)).toBe(HANDOFF);
  });

  it("沒有片段、或片段裡沒有 handoff → 什麼都不做", () => {
    const spy = vi.spyOn(window.history, "replaceState");
    expect(captureHandoffFromUrl(NOW)).toBeNull();

    window.history.replaceState(null, "", "/register/restaurant#section=form");
    spy.mockClear();
    expect(captureHandoffFromUrl(NOW)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#section=form");
    expect(storage.getItem(HANDOFF_STORAGE_KEY)).toBeNull();
  });
});
