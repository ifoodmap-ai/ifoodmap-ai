// lookup.ts:token 格式不對不打資料庫;找不到回 null;找到回訂單;進度時間軸的排序。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import { fetchOrdersByToken, sortEvents, TOKEN_PATTERN } from "./lookup";
import type { OrderStatus } from "./orders";

const TOKEN = `tok_${"x".repeat(39)}`;

// 用大括號:直接回傳 mockReset() 的結果(mock 本身)會被 vitest 當成清理函式,測試結束後多呼叫一次 rpc
beforeEach(() => {
  rpc.mockReset();
});

describe("fetchOrdersByToken", () => {
  it("token 格式跟資料庫一樣是 43 字 base64url;不對就不呼叫", async () => {
    expect(TOKEN_PATTERN.test(TOKEN)).toBe(true);
    for (const bad of ["", "short", `${TOKEN}x`, `${"x".repeat(42)}=`, `${"x".repeat(42)}/`]) {
      expect(await fetchOrdersByToken(bad), bad).toBeNull();
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("找不到回 null;找到回訂單", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, code: "NOT_FOUND" }, error: null });
    expect(await fetchOrdersByToken(TOKEN)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("market_get_orders", { p_token: TOKEN });
    rpc.mockResolvedValueOnce({ data: { ok: true, orders: [{ id: "o1" }] }, error: null });
    expect(await fetchOrdersByToken(TOKEN)).toEqual([{ id: "o1" }]);
  });

  it("資料庫錯誤往上丟(頁面顯示「載入失敗」而不是「找不到」)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(fetchOrdersByToken(TOKEN)).rejects.toThrow("timeout");
  });
});

describe("sortEvents(進度時間軸)", () => {
  const ev = (to_status: OrderStatus, created_at: string) => ({ to_status, created_at, note: null });
  const order = (events: ReturnType<typeof ev>[]) => sortEvents(events).map((e) => e.to_status);

  it("照 created_at 由舊到新,不靠資料庫給的順序(不依賴 uuid);不改原陣列", () => {
    const events = [
      ev("shipped", "2026-10-10T01:00:00.5+00:00"),
      ev("pending", "2026-10-09T04:05:00+00:00"),
      ev("paid", "2026-10-10T01:00:00+00:00"),
    ];
    expect(order(events)).toEqual(["pending", "paid", "shipped"]);
    expect(events.map((e) => e.to_status)).toEqual(["shipped", "pending", "paid"]);
  });

  it("同一個交易寫的兩筆差 1 微秒(Date 只到毫秒)也照時間排 —— 資料庫保證同一張單的時間嚴格遞增", () => {
    // 刻意讓狀態先後跟時間相反:證明比的是到微秒的時間,不是狀態順序
    expect(order([ev("confirmed", "2026-10-09T05:00:00.123457+00:00"), ev("cancelled", "2026-10-09T05:00:00.123456+00:00")])).toEqual([
      "cancelled",
      "confirmed",
    ]);
    expect(order([ev("awaiting_payment", "2026-10-09T05:00:00.000001Z"), ev("confirmed", "2026-10-09T05:00:00Z")])).toEqual([
      "confirmed",
      "awaiting_payment",
    ]);
  });

  it("時間完全一樣(資料庫保證之前的資料)才看狀態的先後(計畫給的 ORDER_STATUSES 順序)", () => {
    expect(
      order([
        ev("awaiting_payment", "2026-10-09T05:00:00Z"),
        ev("confirmed", "2026-10-09T05:00:00Z"),
        ev("pending", "2026-10-09T04:05:00Z"),
      ]),
    ).toEqual(["pending", "confirmed", "awaiting_payment"]);
  });
});
