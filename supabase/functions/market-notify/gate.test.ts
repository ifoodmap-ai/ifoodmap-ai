import { describe, expect, it } from "vitest";
import {
  isLive,
  MARKET_LIVE_ENV,
  marketForwardNoteHtml,
  marketLiveFromEnv,
  planMarketDeliveries,
  TEST_INBOX,
  TEST_SUBJECT_PREFIX,
} from "./gate.ts";

describe("market-notify 寄信閘門", () => {
  it("只有字串 true 才算開放(沿用 notify 的 isLive)", () => {
    expect(isLive("true")).toBe(true);
    for (const v of [undefined, "", "1", "TRUE", " true"]) expect(isLive(v)).toBe(false);
  });

  it("沒開:寄到內部信箱、主旨加 [測試轉寄]、內文列出原收件人(跳脫過)", () => {
    const [d] = planMarketDeliveries([{ email: "buyer<x>@example.com", audience: "consumer" }], "訂單已送出", false);
    expect(d.to).toBe(TEST_INBOX);
    expect(TEST_INBOX).toBe("ifoodmaptw@gmail.com");
    expect(d.subject).toBe(`${TEST_SUBJECT_PREFIX} 訂單已送出`);
    expect(d.forwardNote).toContain("buyer&lt;x&gt;@example.com");
    expect(d.forwardNote).toContain("MARKET_NOTIFY_LIVE 未開啟");
    expect(d.forwardNote).toContain("消費者");
  });

  it("沒開:消費者與供應商分開兩封(內文不同)", () => {
    const out = planMarketDeliveries(
      [
        { email: "a@example.com", audience: "consumer" },
        { email: "s@example.com", audience: "supplier" },
      ],
      "x",
      false,
    );
    expect(out.map((d) => d.audience)).toEqual(["consumer", "supplier"]);
    expect(out.every((d) => d.to === TEST_INBOX)).toBe(true);
  });

  it("開了:寄給本人、主旨不變、沒有轉寄說明", () => {
    const [d] = planMarketDeliveries([{ email: "a@example.com", audience: "consumer" }], "訂單已送出", true);
    expect(d).toMatchObject({ to: "a@example.com", subject: "訂單已送出", forwardNote: null });
  });

  it("轉寄說明標出對象", () => {
    expect(marketForwardNoteHtml(["s@example.com"], "supplier")).toContain("供應商");
  });
});

// 派工追加(2026-10-11):閘門是 market-notify 最重要的部分 —— MARKET_NOTIFY_LIVE 不是剛好字串 "true" 時,
// 消費者與供應商的信都只能寄到 ifoodmaptw@gmail.com、主旨加「[測試轉寄]」。
// 這裡一律比對字面值(不只比常數):有人改掉 notify/gate.ts 的 TEST_INBOX / TEST_SUBJECT_PREFIX,這裡也會紅。
describe("market-notify 寄信閘門:MARKET_NOTIFY_LIVE 的每一種值", () => {
  const NOT_LIVE: (string | undefined)[] = [
    undefined, // 沒設
    "", // 空字串
    "TRUE",
    "True",
    "1",
    " true",
    "true ",
    "\ttrue",
    "true\n",
    "yes",
    "on",
    "false",
    "0",
  ];
  const env = (v: string | undefined) => (key: string) => (key === "MARKET_NOTIFY_LIVE" ? v : undefined);
  const REAL = [
    { email: "buyer@real-consumer.tw", audience: "consumer" as const },
    { email: "sales@real-supplier.tw", audience: "supplier" as const },
  ];

  it("只有剛好字串 true 才開;沒設、空字串、TRUE、1、前後有空白都不開", () => {
    expect(marketLiveFromEnv(env("true"))).toBe(true);
    for (const v of NOT_LIVE) expect(marketLiveFromEnv(env(v)), JSON.stringify(v)).toBe(false);
  });

  it("只認 MARKET_NOTIFY_LIVE:餐廳訂單的 NOTIFY_LIVE 開了,零售市集照樣關著", () => {
    expect(MARKET_LIVE_ENV).toBe("MARKET_NOTIFY_LIVE");
    expect(marketLiveFromEnv((key) => (key === "NOTIFY_LIVE" ? "true" : undefined))).toBe(false);
  });

  it("沒開的每一種值:消費者、供應商的信全部轉寄 ifoodmaptw@gmail.com,主旨加 [測試轉寄],原收件人只列在說明裡", () => {
    for (const v of NOT_LIVE) {
      const label = JSON.stringify(v);
      const out = planMarketDeliveries(REAL, "訂單已送出", marketLiveFromEnv(env(v)));
      expect(out.map((d) => d.to), label).toEqual(["ifoodmaptw@gmail.com", "ifoodmaptw@gmail.com"]);
      expect(out.map((d) => d.subject), label).toEqual(["[測試轉寄] 訂單已送出", "[測試轉寄] 訂單已送出"]);
      expect(out.map((d) => d.originalRecipients), label).toEqual([["buyer@real-consumer.tw"], ["sales@real-supplier.tw"]]);
      for (const d of out) {
        expect(d.forwardNote, label).toContain("[測試轉寄] 原本的收件人");
        expect(d.forwardNote, label).toContain("MARKET_NOTIFY_LIVE 未開啟");
      }
    }
  });
});
