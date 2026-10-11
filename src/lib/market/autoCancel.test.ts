// autoCancel.ts:72 小時自動取消的期限(待接單看下單時間、待匯款看最後一筆「待匯款」紀錄)、台北時間的期限文字、剩幾個小時。
// 時數跟 migration 20261012100000_market_hardening.sql 的 `-- @market-auto-cancel-hours` 標記(與它下一行的 c_hours 常數)比對。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { autoCancelDeadline, formatAutoCancelDeadline, hoursUntilAutoCancel, MARKET_AUTO_CANCEL_HOURS } from "./autoCancel";
import type { OrderStatus } from "./orders";

const HARDENING = resolve(__dirname, "../../../supabase/migrations/20261012100000_market_hardening.sql");
const ev = (to_status: OrderStatus, created_at: string) => ({ to_status, created_at });

describe("MARKET_AUTO_CANCEL_HOURS", () => {
  it("是 72", () => {
    expect(MARKET_AUTO_CANCEL_HOURS).toBe(72);
  });

  it("跟 migration 的 `-- @market-auto-cancel-hours` 標記一樣(全檔剛好一處),標記下一行的 c_hours 常數也一樣", () => {
    const sql = readFileSync(HARDENING, "utf8");
    const marks = [...sql.matchAll(/--\s*@market-auto-cancel-hours\s+(\d+)\s*\n\s*c_hours\s+CONSTANT\s+integer\s*:=\s*(\d+)\s*;/g)];
    expect(marks.map((m) => [Number(m[1]), Number(m[2])])).toEqual([[MARKET_AUTO_CANCEL_HOURS, MARKET_AUTO_CANCEL_HOURS]]);
    expect(sql.match(/@market-auto-cancel-hours/g)).toHaveLength(1);
  });
});

describe("autoCancelDeadline", () => {
  it("待接單:下單時間加 72 小時,保留微秒(PostgreSQL 給到微秒,Date 只到毫秒)", () => {
    expect(autoCancelDeadline({ status: "pending", created_at: "2026-10-09T04:05:00.123456+00:00" }, [])).toBe("2026-10-12T04:05:00.123456Z");
    expect(autoCancelDeadline({ status: "pending", created_at: "2026-10-09T12:05:00+08:00" }, [])).toBe("2026-10-12T04:05:00.000000Z");
  });

  it("待匯款:最後一筆 to_status = awaiting_payment 的紀錄加 72 小時;紀錄照時間排(比到微秒),不靠陣列順序", () => {
    const events = [
      ev("awaiting_payment", "2026-10-10T05:00:00.000002+00:00"),
      ev("pending", "2026-10-09T04:05:00+00:00"),
      ev("awaiting_payment", "2026-10-10T05:00:00.000001+00:00"),
      ev("confirmed", "2026-10-10T05:00:00+00:00"),
    ];
    expect(autoCancelDeadline({ status: "awaiting_payment", created_at: "2026-10-09T04:05:00+00:00" }, events)).toBe(
      "2026-10-13T05:00:00.000002Z",
    );
  });

  it("待匯款但查不到「待匯款」紀錄 → null(不猜);其他狀態一律 null", () => {
    expect(autoCancelDeadline({ status: "awaiting_payment", created_at: "2026-10-09T04:05:00Z" }, [ev("pending", "2026-10-09T04:05:00Z")])).toBeNull();
    for (const status of ["confirmed", "paid", "shipped", "completed", "rejected", "cancelled"] as const) {
      expect(autoCancelDeadline({ status, created_at: "2026-10-09T04:05:00Z" }, [ev("awaiting_payment", "2026-10-09T05:00:00Z")]), status).toBeNull();
    }
  });

  it("時間看不懂 → null", () => {
    expect(autoCancelDeadline({ status: "pending", created_at: "not a time" }, [])).toBeNull();
  });
});

describe("formatAutoCancelDeadline(台北時間 M/D HH:mm)", () => {
  it("一律換成台北時間;月、日不補零,時、分兩位", () => {
    expect(formatAutoCancelDeadline("2026-10-12T04:05:00.123456Z")).toBe("10/12 12:05");
    // 跨日:UTC 16:30 是台北隔天 00:30
    expect(formatAutoCancelDeadline("2026-10-02T16:30:00Z")).toBe("10/3 00:30");
    expect(formatAutoCancelDeadline("2026-12-31T23:59:59.999999Z")).toBe("1/1 07:59");
  });

  it("沒有期限、看不懂 → —", () => {
    expect(formatAutoCancelDeadline(null)).toBe("—");
    expect(formatAutoCancelDeadline("garbage")).toBe("—");
  });
});

describe("hoursUntilAutoCancel(還有幾個完整的小時)", () => {
  const deadline = "2026-10-12T04:05:00.000000Z";
  const at = (iso: string) => Date.parse(iso);

  it("無條件捨去:寫「N 小時內」,店家在 N 小時內處理一定來得及", () => {
    expect(hoursUntilAutoCancel(deadline, at("2026-10-09T04:05:00Z"))).toBe(72);
    expect(hoursUntilAutoCancel(deadline, at("2026-10-11T04:35:00Z"))).toBe(23);
    expect(hoursUntilAutoCancel(deadline, at("2026-10-12T03:05:00Z"))).toBe(1);
  });

  it("不到 1 小時(含已經過期、排程還沒跑到)→ 0", () => {
    expect(hoursUntilAutoCancel(deadline, at("2026-10-12T03:05:00.001Z"))).toBe(0);
    expect(hoursUntilAutoCancel(deadline, at("2026-10-12T05:00:00Z"))).toBe(0);
  });
});
