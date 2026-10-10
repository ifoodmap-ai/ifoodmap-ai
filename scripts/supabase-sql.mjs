#!/usr/bin/env node
/**
 * 正式庫 SQL 小工具 —— 這個專案只有正式庫(cwvpehqcvbfuynabpqop),沒有 staging、沒有本機 Supabase。
 *
 *   node scripts/supabase-sql.mjs dry <test.sql> [--with-migration <file>]... [--with-rollback <file>]...
 *     乾跑:BEGIN → 共用工具(supabase/tests/database/_market_helpers.sql)→ migration… → rollback… → 測試 → 彙總 → ROLLBACK。
 *     送出前先檢查組好的 SQL 是「單一 BEGIN … ROLLBACK」(中間不能有 COMMIT / END / 另一個 BEGIN …),不符合就拒送。
 *     測試裡每一項 got ≠ want 都算失敗;有失敗、或一項檢查都沒有 → exit 1。
 *   node scripts/supabase-sql.mjs ro <query.sql>
 *     走唯讀端點(/database/query/read-only),印出 JSON。查殘留、查現況用。
 *   node scripts/supabase-sql.mjs apply <supabase/migrations/<版本>_<名稱>.sql>
 *     套 migration,並在同一個請求(同一個交易)補 supabase_migrations.schema_migrations 的 ledger;
 *     migration 裡不能有 BEGIN / COMMIT / ROLLBACK(否則拒送)。🔴 會真的改正式庫,只在各階段的「部署與驗收」任務用。
 *
 * Token 從環境變數 SUPABASE_ACCESS_TOKEN 讀,工具不會印出來。Cloudflare 會擋沒有瀏覽器 User-Agent 的請求(1010)。
 * 純函式由 scripts/supabase-sql.test.mjs 測。
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_REF = "cwvpehqcvbfuynabpqop";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HELPERS_PATH = join(ROOT, "supabase/tests/database/_market_helpers.sql");

/** 去掉註解、字串、$tag$ 本體之後,切出最外層的語句(只用來判斷交易控制語句,不是完整的 SQL parser) */
export const topLevelStatements = (src) => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src.startsWith("--", i)) {
      const j = src.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const j = src.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      out += " ";
      continue;
    }
    if (src[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        j += 1;
      }
      i = j + 1;
      out += "''";
      continue;
    }
    const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
    if (tag) {
      const end = src.indexOf(tag[0], i + tag[0].length);
      if (end < 0) throw new Error("拒送:SQL 裡有沒結束的 $$ 字串");
      i = end + tag[0].length;
      out += " $body$ ";
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
};

const TX_CONTROL = new Set(["begin", "start", "commit", "end", "abort", "rollback", "release", "prepare", "savepoint"]);
const firstWord = (stmt) => stmt.split(/\s+/, 1)[0].toLowerCase();

/** 乾跑的 SQL 一定要是單一 BEGIN … ROLLBACK;回傳語句數 */
export const assertSingleRollbackTx = (sql) => {
  const stmts = topLevelStatements(sql);
  if (stmts.length < 2) throw new Error("拒送:至少要有 BEGIN 與 ROLLBACK");
  if (firstWord(stmts[0]) !== "begin") throw new Error(`拒送:第一句必須是 BEGIN(現在是「${stmts[0].slice(0, 40)}」)`);
  if (stmts[stmts.length - 1].toLowerCase() !== "rollback") throw new Error("拒送:最後一句必須是 ROLLBACK");
  for (const s of stmts.slice(1, -1)) {
    if (TX_CONTROL.has(firstWord(s))) throw new Error(`拒送:中間不能有交易控制語句「${s.slice(0, 60)}」`);
  }
  return stmts.length;
};

/** migration 不能自己控制交易(apply 要把 ledger 放進同一個交易) */
export const assertNoTxControl = (sql) => {
  for (const s of topLevelStatements(sql)) {
    if (TX_CONTROL.has(firstWord(s))) throw new Error(`拒送:migration 裡不能有交易控制語句「${s.slice(0, 60)}」`);
  }
};

/** 乾跑最後的彙總:got ≠ want 的都列出來 */
export const SUMMARY_SQL = `SELECT json_build_object(
  'total',    (SELECT count(*) FROM _r),
  'failed',   (SELECT count(*) FROM _r WHERE got IS DISTINCT FROM want),
  'failures', (SELECT COALESCE(json_agg(json_build_object('k', k, 'got', got, 'want', want) ORDER BY seq), '[]'::json)
                 FROM _r WHERE got IS DISTINCT FROM want)
) AS result`;

export const composeDryRun = ({ helpers, migrations = [], rollbacks = [], test }) =>
  [
    "BEGIN",
    "SET LOCAL lock_timeout = '3s'",
    "SET LOCAL statement_timeout = '30s'",
    helpers,
    ...migrations,
    ...rollbacks,
    test,
    SUMMARY_SQL,
    "ROLLBACK",
  ].join("\n;\n") + ";\n";

/** 檔名 20261009120000_market_catalog.sql → ledger 那一列 */
export const ledgerFor = (file) => {
  const m = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(basename(file));
  if (!m) throw new Error(`migration 檔名要是 <14 位數字版本>_<小寫名稱>.sql:${basename(file)}`);
  return {
    version: m[1],
    name: m[2],
    sql: `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${m[1]}', '${m[2]}') ON CONFLICT (version) DO NOTHING;`,
  };
};

export const composeApply = (migrationSql, file) => {
  assertNoTxControl(migrationSql);
  return `${migrationSql}\n;\n${ledgerFor(file).sql}\n`;
};

export const summarize = (body) => {
  const result = Array.isArray(body) ? body[0]?.result : undefined;
  if (!result || typeof result.total !== "number") {
    throw new Error(`看不懂乾跑結果:${JSON.stringify(body).slice(0, 300)}`);
  }
  return result;
};

const post = async (path, query) => {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("需要環境變數 SUPABASE_ACCESS_TOKEN(值不要印出來)");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 不是 JSON 就照原文回報 */
  }
  if (!res.ok) throw new Error(`Management API ${res.status}:${text.slice(0, 800)}`);
  return body;
};

const parseArgs = (argv) => {
  const [mode, file, ...rest] = argv;
  const migrations = [];
  const rollbacks = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--with-migration" && rest[i + 1]) migrations.push(rest[i + 1]);
    else if (rest[i] === "--with-rollback" && rest[i + 1]) rollbacks.push(rest[i + 1]);
    else throw new Error(`看不懂的參數:${rest[i]}`);
  }
  return { mode, file, migrations, rollbacks };
};

const read = (path) => readFileSync(path, "utf8");

const main = async (argv) => {
  const { mode, file, migrations, rollbacks } = parseArgs(argv);
  if (!mode || !file) throw new Error("用法:dry <test.sql> [--with-migration f]… [--with-rollback f]… | ro <query.sql> | apply <migration.sql>");

  if (mode === "dry") {
    const sql = composeDryRun({
      helpers: read(HELPERS_PATH),
      migrations: migrations.map(read),
      rollbacks: rollbacks.map(read),
      test: read(file),
    });
    const count = assertSingleRollbackTx(sql);
    const result = summarize(await post("/database/query", sql));
    console.log(
      `乾跑 ${basename(file)}(migration ${migrations.length} 支、rollback ${rollbacks.length} 支、${count} 句):` +
        `共 ${result.total} 項,失敗 ${result.failed} 項`,
    );
    for (const f of result.failures) console.log(`  ✗ ${f.k}\n      got:  ${f.got}\n      want: ${f.want}`);
    if (result.failed > 0 || result.total === 0) process.exitCode = 1;
    return;
  }

  if (mode === "ro") {
    console.log(JSON.stringify(await post("/database/query/read-only", read(file)), null, 2));
    return;
  }

  if (mode === "apply") {
    await post("/database/query", composeApply(read(file), file));
    const { version } = ledgerFor(file);
    const ledger = await post(
      "/database/query/read-only",
      `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '${version}'`,
    );
    console.log(`已套用 ${basename(file)};ledger:${JSON.stringify(ledger)}`);
    return;
  }

  throw new Error(`不認得的模式:${mode}(只有 dry / ro / apply)`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
