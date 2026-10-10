// scripts/supabase-sql.mjs 的測試:乾跑一定是單一 BEGIN … ROLLBACK(靜態檢查照 Postgres 的切字規則,伺服器端再加一道 COMMIT 保險)、
// ledger 從檔名來而且不准重套、token 不外洩、main() 的 exit code、經 symlink 執行也會跑。
// 不打網路:main() 的測試把 fetch 換成假的;直接執行的判斷用子行程跑一個不連網的錯誤參數。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMIT_GUARD_SQL,
  assertNoTxControl,
  assertSingleRollbackTx,
  checkToken,
  composeApply,
  composeDryRun,
  ledgerFor,
  main,
  redact,
  summarize,
  topLevelStatements,
} from "./supabase-sql.mjs";

// 假 token:格式合格(sbp_ + 40 位小寫十六進位),不是真的
const FAKE_TOKEN = `sbp_${"0123456789abcdef".repeat(2)}01234567`;
// 中間夾換行的 token(fetch 會在錯誤訊息裡印出整個 Authorization 標頭)
const BROKEN_TOKEN = `${FAKE_TOKEN.slice(0, 24)}\n${FAKE_TOKEN.slice(24)}`;
const firstWords = (sql) => topLevelStatements(sql).map((s) => s.split(/\s+/)[0].toUpperCase());

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

  // 2026-10-10 審查實測:舊版切字跟 Postgres 不一致,下面每一種都能夾帶真的 COMMIT 而通過檢查
  it.each([
    ["E'' 字串裡的 \\'", String.raw`SELECT E'a\'b'; COMMIT; SELECT E'c\'d';`],
    ['雙引號識別字裡的單引號 "it\'s"', `SELECT 1 AS "it's"; COMMIT; SELECT 1 AS "it's";`],
    ["識別字裡的 $(a$x$)", "SELECT 1 AS a$x$; COMMIT; SELECT 1 AS b$x$;"],
    ["巢狀註解 /* /* */ $x$ */", "/* /* */ $x$ */ COMMIT; /* $x$ */"],
    ["-- 註解後面只有 \\r", "SELECT 1; -- note\rCOMMIT;\nSELECT 2;"],
    ["非 ASCII 的 $標$", "SELECT $標$'$標$; COMMIT; SELECT $標$'$標$;"],
  ])("%s:切得出 COMMIT,乾跑拒送", (_name, sql) => {
    expect(firstWords(sql)).toContain("COMMIT");
    expect(() => assertSingleRollbackTx(composeDryRun({ helpers: "", test: sql }))).toThrow(/拒送/);
  });

  it("Postgres 當成字串、識別字、註解的內容不算(不誤擋)", () => {
    const sql = [
      "SELECT 'C:\\';", // 一般字串裡的反斜線不跳脫(standard_conforming_strings = on)
      "SELECT E'it\\'s', E'x''y';", // E'' 字串:\' 與 '' 都是字串內容
      "SELECT E'a'\n  'b\\'c; COMMIT';", // 換行後接續的那段一樣是 E'' 字串
      'SELECT 1 AS "a;""COMMIT";', // 雙引號識別字裡的分號與 ""
      "SELECT 1 AS a$b, $1;", // 識別字裡的 $、位置參數
      "/* a /* COMMIT; */ b */ SELECT 2;", // 巢狀註解
      "DO $標$ BEGIN PERFORM 1; END $標$;", // 非 ASCII 的 $tag$
      "SELECT 3; -- COMMIT;\r\n",
    ].join("\n");
    expect(firstWords(sql)).toEqual(["SELECT", "SELECT", "SELECT", "SELECT", "SELECT", "SELECT", "DO", "SELECT"]);
  });

  it.each([
    ["沒結束的 ' 字串", "SELECT 'abc; ROLLBACK;"],
    ['沒結束的 " 識別字', 'SELECT "abc; ROLLBACK;'],
    ["沒結束的巢狀 /* 註解", "SELECT 1; /* /* */ ROLLBACK;"],
    ["沒結束的 $tag$ 字串", "SELECT $x$ abc; ROLLBACK;"],
    ["E'' 字串最後是 \\'", "SELECT E'abc\\'; ROLLBACK;"],
  ])("%s → 拒送", (_name, sql) => {
    expect(() => topLevelStatements(sql)).toThrow(/拒送/);
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

  it("BEGIN 之後、使用者的 SQL 之前先裝 COMMIT 保險(延到 commit 才跑的 constraint trigger,一跑就 RAISE)", () => {
    const sql = composeDryRun({ helpers: "SELECT 'helpers'", test: "SELECT 'test'" });
    const at = sql.indexOf(COMMIT_GUARD_SQL);
    expect(at).toBeGreaterThan(sql.indexOf("BEGIN"));
    expect(at).toBeLessThan(sql.indexOf("'helpers'"));
    expect(COMMIT_GUARD_SQL).toMatch(/CREATE TEMP TABLE _supabase_sql_commit_guard/);
    expect(COMMIT_GUARD_SQL).toMatch(/CREATE CONSTRAINT TRIGGER [\s\S]+ DEFERRABLE INITIALLY DEFERRED/);
    expect(COMMIT_GUARD_SQL).toMatch(/RAISE EXCEPTION/);
    expect(firstWords(COMMIT_GUARD_SQL)).toEqual(["CREATE", "CREATE", "CREATE", "INSERT"]);
  });

  it("migration 裡偷放 COMMIT 會被擋下", () => {
    const sql = composeDryRun({ helpers: "", migrations: ["CREATE TABLE x (); COMMIT;"], test: "SELECT 1" });
    expect(() => assertSingleRollbackTx(sql)).toThrow(/拒送/);
  });
});

describe("ledgerFor / composeApply", () => {
  it("從檔名取出版本與名稱;ledger 的 INSERT 不帶 ON CONFLICT(重複版本要在同一個交易裡報錯)", () => {
    const l = ledgerFor("supabase/migrations/20261009120000_market_catalog.sql");
    expect(l).toMatchObject({ version: "20261009120000", name: "market_catalog" });
    expect(l.sql).toBe(
      "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261009120000', 'market_catalog');",
    );
  });

  it("檔名不合規就丟錯", () => {
    expect(() => ledgerFor("market.sql")).toThrow();
    expect(() => ledgerFor("2026_market.sql")).toThrow();
  });

  it("timeout、migration 與 ledger 放在同一個請求;migration 不准自己控制交易", () => {
    const sql = composeApply("CREATE TABLE t (id int);", "supabase/migrations/20261009120000_market_catalog.sql");
    expect(sql).toContain("CREATE TABLE t (id int);");
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s'\n;\nSET LOCAL statement_timeout = '120s'\n;\n")).toBe(true);
    expect(sql.trim().endsWith("VALUES ('20261009120000', 'market_catalog');")).toBe(true);
    expect(sql).not.toContain("ON CONFLICT");
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

describe("token", () => {
  it("格式合格才放行;不合格時錯誤訊息裡不含 token", () => {
    expect(checkToken(FAKE_TOKEN)).toBe(FAKE_TOKEN);
    for (const bad of [undefined, "", BROKEN_TOKEN, `${FAKE_TOKEN} `, "sbp_123", FAKE_TOKEN.toUpperCase()]) {
      let message = "";
      try {
        checkToken(bad);
      } catch (e) {
        message = e.message;
      }
      expect(message).toMatch(/SUPABASE_ACCESS_TOKEN/);
      for (const piece of (bad ?? "").split(/\s+/).filter((p) => p.length >= 8)) expect(message).not.toContain(piece);
    }
  });

  it("redact 遮掉整串、被換行切開的每一段、JSON 跳脫後的樣子", () => {
    const message = `TypeError: Headers.append: "Bearer ${BROKEN_TOKEN}" is an invalid header value. ${JSON.stringify(BROKEN_TOKEN)}`;
    const out = redact(message, BROKEN_TOKEN);
    expect(out).toContain("Bearer ***");
    expect(out).not.toContain(FAKE_TOKEN.slice(0, 24));
    expect(out).not.toContain(FAKE_TOKEN.slice(24));
  });
});

describe("main()(fetch 換成假的,不打網路)", () => {
  const dir = mkdtempSync(join(tmpdir(), "supabase-sql-test-"));
  const file = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  const QUERY = "/v1/projects/cwvpehqcvbfuynabpqop/database/query";
  const READ_ONLY = `${QUERY}/read-only`;
  const ok = (body) => ({ status: 200, body });
  const dryResult = (total, failed, failures = []) => ok([{ result: { total, failed, failures } }]);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // 依序回應每個請求(放 Error = fetch 本身丟錯);回傳 exit code、送出的請求、stdout、stderr
  const run = async (argv, responses = [], token = FAKE_TOKEN) => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ path: new URL(url).pathname, query: JSON.parse(init.body).query });
      const r = responses.shift();
      if (!r) throw new Error("沒預期到的請求");
      if (r instanceof Error) throw r;
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return { ok: r.status < 400, status: r.status, text: async () => text };
    });
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", token);
    const out = [];
    const err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => err.push(a.join(" ")));
    const code = await main(argv);
    return { code, calls, out: out.join("\n"), err: err.join("\n") };
  };

  describe("dry", () => {
    const testFile = () => file("probe.test.sql", "SELECT pg_temp.expect('x', '1', '1');");

    it("全過 → 0;輸出格式不變;送出的是 BEGIN → 保險 → … → ROLLBACK", async () => {
      const r = await run(["dry", testFile()], [dryResult(1, 0)]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^乾跑 probe\.test\.sql\(migration 0 支、rollback 0 支、\d+ 句\):共 1 項,失敗 0 項$/);
      expect(r.calls.map((c) => c.path)).toEqual([QUERY]);
      const sql = r.calls[0].query;
      expect(sql.startsWith("BEGIN\n;\n")).toBe(true);
      expect(sql.indexOf(COMMIT_GUARD_SQL)).toBeGreaterThan(0);
      expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    });

    it("有失敗 → 1,列出 got / want", async () => {
      const r = await run(["dry", testFile()], [dryResult(2, 1, [{ k: "某一項", got: "1", want: "2" }])]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("共 2 項,失敗 1 項");
      expect(r.out).toContain("✗ 某一項\n      got:  1\n      want: 2");
    });

    it("一項檢查都沒有 → 1", async () => {
      const r = await run(["dry", testFile()], [dryResult(0, 0)]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("共 0 項,失敗 0 項");
    });

    it("Management API 回錯(例如保險擋下 COMMIT)→ 2", async () => {
      const r = await run(["dry", testFile()], [{ status: 400, body: { message: "ERROR: P0001: 乾跑保險" } }]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Management API 400");
    });

    it("回應看不懂 → 2", async () => {
      const r = await run(["dry", testFile()], [ok([])]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("看不懂乾跑結果");
    });

    it("靜態檢查不過 → 2,一個請求都不送", async () => {
      const m = file("20991231000000_evil.sql", "CREATE TABLE x (); COMMIT;");
      const r = await run(["dry", testFile(), "--with-migration", m]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/拒送/);
      expect(r.calls).toHaveLength(0);
    });
  });

  it("ro → 0,原樣印出 JSON", async () => {
    const r = await run(["ro", file("q.sql", "SELECT 1 AS a;")], [ok([{ a: 1 }])]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(JSON.stringify([{ a: 1 }], null, 2));
    expect(r.calls.map((c) => c.path)).toEqual([READ_ONLY]);
  });

  it.each([
    ["沒參數", []],
    ["不認得的模式", ["bogus", "x.sql"]],
    ["看不懂的參數", ["dry", "x.sql", "--nope"]],
  ])("參數錯(%s)→ 2,不送請求", async (_name, argv) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it.each([
    ["沒有 token", ""],
    ["token 中間夾換行", BROKEN_TOKEN],
  ])("%s → 2,不送請求,訊息裡不含 token", async (_name, token) => {
    const r = await run(["ro", file("q.sql", "SELECT 1;")], [], token);
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(r.err).toMatch(/SUPABASE_ACCESS_TOKEN/);
    expect(r.err).not.toContain(FAKE_TOKEN.slice(0, 24));
    expect(r.err).not.toContain(FAKE_TOKEN.slice(24));
  });

  it("錯誤訊息帶出 token 時,印出來之前遮掉 → 2", async () => {
    const r = await run(
      ["ro", file("q.sql", "SELECT 1;")],
      [new TypeError(`Headers.append: "Bearer ${FAKE_TOKEN}" is an invalid header value.`)],
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("Bearer ***");
    expect(r.err).not.toContain(FAKE_TOKEN);
  });

  describe("apply", () => {
    const migration = () => file("20991231000000_fake_apply.sql", "CREATE TABLE t (id int);");
    const row = { version: "20991231000000", name: "fake_apply" };

    it("ledger 已經有這個版本 → 2,migration 不送", async () => {
      const r = await run(["apply", migration()], [ok([row])]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/拒送/);
      expect(r.calls.map((c) => c.path)).toEqual([READ_ONLY]);
    });

    it("先查 ledger → 套用(timeout + migration + 不帶 ON CONFLICT 的 ledger)→ 讀回相符 → 0", async () => {
      const r = await run(["apply", migration()], [ok([]), ok([]), ok([row])]);
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => c.path)).toEqual([READ_ONLY, QUERY, READ_ONLY]);
      expect(r.calls[0].query).toContain("WHERE version = '20991231000000'");
      expect(r.calls[1].query).toBe(composeApply("CREATE TABLE t (id int);", "20991231000000_fake_apply.sql"));
      expect(r.calls[1].query).not.toContain("ON CONFLICT");
      expect(r.out).toContain("已套用 20991231000000_fake_apply.sql");
    });

    it.each([
      ["讀回沒有這一列", []],
      ["讀回的名稱不符", [{ ...row, name: "other" }]],
      ["讀回不只一列", [row, row]],
    ])("%s → 1", async (_name, readBack) => {
      const r = await run(["apply", migration()], [ok([]), ok([]), ok(readBack)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("ledger 不符");
    });

    it("套用時伺服器報錯(例如重複版本 23505,整筆回滾)→ 2", async () => {
      const dup = 'ERROR: 23505: duplicate key value violates unique constraint "schema_migrations_pkey"';
      const r = await run(["apply", migration()], [ok([]), { status: 400, body: { message: dup } }]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Management API 400");
      expect(r.calls).toHaveLength(2);
    });

    it("ledger 查詢結果看不懂 → 2,migration 不送", async () => {
      const r = await run(["apply", migration()], [ok({ weird: true })]);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(1);
    });

    it.each([
      ["migration 自己控制交易", "20991231000001_tx.sql", "BEGIN; CREATE TABLE t (); COMMIT;"],
      ["檔名不合規", "fake.sql", "CREATE TABLE t ();"],
    ])("%s → 2,一個請求都不送", async (_name, name, content) => {
      const r = await run(["apply", file(name, content)]);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    });
  });
});

describe("直接執行(argv[1] 跟實際路徑寫法不同:symlink、/tmp → /private/tmp)", () => {
  it("main() 一樣會跑,exit code 照實回報", () => {
    const dir = mkdtempSync(join(tmpdir(), "supabase-sql-link-"));
    const link = join(dir, "supabase-sql.mjs");
    // 不用 new URL("./…", import.meta.url):Vite 會把它當成靜態資源網址改寫
    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "supabase-sql.mjs"), link);
    try {
      // 不認得的模式 → 不連網就 exit 2;main() 沒跑的話會是 exit 0、什麼都不印
      const r = spawnSync(process.execPath, [link, "bogus", "x.sql"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(r.stderr).toContain("不認得的模式");
      expect(r.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
