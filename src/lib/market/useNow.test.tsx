// useNow:每分鐘更新一次的「現在」(自動取消的倒數與過期判斷用);卸載時停掉計時器。
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./useNow";

afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("一開始是現在;每過一分鐘更新一次;卸載後計時器停掉", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
    const { result, unmount } = renderHook(() => useNow());
    expect(result.current).toBe(Date.parse("2026-10-12T04:00:00Z"));
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(Date.parse("2026-10-12T04:00:00Z"));
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(Date.parse("2026-10-12T04:01:00Z"));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
