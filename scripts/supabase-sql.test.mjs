// scripts/supabase-sql.mjs 的純函式:乾跑一定是單一 BEGIN … ROLLBACK、ledger 從檔名來、結果看得懂。
// 不打網路(main() 只有直接執行這支腳本時才會跑)。
import { describe, expect, it } from "vitest";
import {
  assertNoTxControl,
  assertSingleRollbackTx,
  composeApply,
  composeDryRun,
  ledgerFor,
  summarize,
  topLevelStatements,
} from "./supabase-sql.mjs";

describe("topLevelStatements", () => {
  it("註解、字串、$$ 本體裡的分號與 COMMIT 都不算", () => {
    const sql = [
      "BEGIN; -- COMMIT;",
      "SELECT 'a;b COMMIT';",
      "/* ROLLBACK; */",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$ SELECT 1; $fn$;",
      "ROLLBACK;",
    ].join("\n");
    expect(topLevelStatements(sql).map((s) => s.split(/\s+/)[0].toUpperCase())).toEqual([
      "BEGIN",
      "SELECT",
      "DO",
      "CREATE",
      "ROLLBACK",
    ]);
  });
});

describe("assertSingleRollbackTx", () => {
  it("BEGIN … ROLLBACK 通過,回傳語句數", () => {
    expect(assertSingleRollbackTx("BEGIN; SELECT 1; ROLLBACK;")).toBe(3);
  });

  it.each([
    ["沒有 ROLLBACK", "BEGIN; SELECT 1;"],
    ["最後是 COMMIT", "BEGIN; SELECT 1; COMMIT;"],
    ["中間偷 COMMIT 再 BEGIN", "BEGIN; SELECT 1; COMMIT; BEGIN; ROLLBACK;"],
    ["中間 END", "BEGIN; END; ROLLBACK;"],
    ["第一句不是 BEGIN", "SELECT 1; ROLLBACK;"],
    ["中間 SAVEPOINT", "BEGIN; SAVEPOINT a; ROLLBACK;"],
  ])("%s → 拒送", (_name, sql) => {
    expect(() => assertSingleRollbackTx(sql)).toThrow(/拒送/);
  });
});

describe("composeDryRun", () => {
  it("順序是 BEGIN → 工具 → migration → rollback → 測試 → 彙總 → ROLLBACK,而且過得了檢查", () => {
    const sql = composeDryRun({
      helpers: "SELECT 'helpers'",
      migrations: ["SELECT 'mig1'", "SELECT 'mig2';"],
      rollbacks: ["SELECT 'down'"],
      test: "SELECT 'test'",
    });
    const marks = ["'helpers'", "'mig1'", "'mig2'", "'down'", "'test'", "AS result", "ROLLBACK"].map((s) => sql.indexOf(s));
    marks.forEach((pos, i) => {
      expect(pos).toBeGreaterThan(i === 0 ? -1 : marks[i - 1]);
    });
    expect(sql.startsWith("BEGIN")).toBe(true);
    expect(() => assertSingleRollbackTx(sql)).not.toThrow();
  });

  it("migration 裡偷放 COMMIT 會被擋下", () => {
    const sql = composeDryRun({ helpers: "", migrations: ["CREATE TABLE x (); COMMIT;"], test: "SELECT 1" });
    expect(() => assertSingleRollbackTx(sql)).toThrow(/拒送/);
  });
});

describe("ledgerFor / composeApply", () => {
  it("從檔名取出版本與名稱", () => {
    const l = ledgerFor("supabase/migrations/20261009120000_market_catalog.sql");
    expect(l).toMatchObject({ version: "20261009120000", name: "market_catalog" });
    expect(l.sql).toBe(
      "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261009120000', 'market_catalog') ON CONFLICT (version) DO NOTHING;",
    );
  });

  it("檔名不合規就丟錯", () => {
    expect(() => ledgerFor("market.sql")).toThrow();
    expect(() => ledgerFor("2026_market.sql")).toThrow();
  });

  it("migration 與 ledger 放在同一個請求;migration 不准自己控制交易", () => {
    const sql = composeApply("CREATE TABLE t (id int);", "supabase/migrations/20261009120000_market_catalog.sql");
    expect(sql).toContain("CREATE TABLE t (id int);");
    expect(sql.trim().endsWith("ON CONFLICT (version) DO NOTHING;")).toBe(true);
    expect(() => assertNoTxControl("CREATE TABLE t (); COMMIT;")).toThrow(/拒送/);
    expect(() =>
      composeApply("BEGIN; CREATE TABLE t (); COMMIT;", "supabase/migrations/20261009120000_market_catalog.sql"),
    ).toThrow(/拒送/);
  });
});

describe("summarize", () => {
  it("讀出 total / failed / failures", () => {
    expect(summarize([{ result: { total: 3, failed: 1, failures: [{ k: "a", got: "1", want: "2" }] } }])).toMatchObject({
      total: 3,
      failed: 1,
    });
  });

  it("格式不對就丟錯", () => {
    expect(() => summarize([{ x: 1 }])).toThrow();
    expect(() => summarize("oops")).toThrow();
  });
});
