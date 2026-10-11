#!/usr/bin/env node
/**
 * 正式庫 SQL 小工具 —— 這個專案只有正式庫(cwvpehqcvbfuynabpqop),沒有 staging、沒有本機 Supabase。
 *
 *   node scripts/supabase-sql.mjs dry <test.sql> [--with-migration <file>]... [--with-rollback <file>]...
 *     乾跑:BEGIN → COMMIT 保險 → 共用工具(supabase/tests/database/_market_helpers.sql)→ migration… → rollback… → 測試 → 彙總 → ROLLBACK。
 *     兩道防線,乾跑絕不會 commit:
 *       1. 送出前的靜態檢查:照 Postgres 的切字規則切出最外層語句(註解可以巢狀、-- 到 \n 或 \r 為止、'…' / E'…' / $tag$ / "識別字"、
 *          識別字可以含 $ 與非 ASCII 字),必須是「單一 BEGIN … ROLLBACK」,中間不能有 COMMIT / END / 另一個 BEGIN …;不符合就拒送。
 *       2. 伺服器端保險(COMMIT_GUARD_SQL):BEGIN 之後先建暫存表、掛 DEFERRABLE INITIALLY DEFERRED 的 constraint trigger、插一列。
 *          延後的 trigger 只在 commit 時跑,一跑就 RAISE —— 靜態檢查漏掉的 COMMIT / END / PREPARE TRANSACTION 都會失敗、整筆回滾;
 *          最後正常的 ROLLBACK 直接丟掉待跑的 trigger,不受影響。
 *     測試裡每一項 got ≠ want 都算失敗;有失敗、或一項檢查都沒有 → exit 1。
 *   node scripts/supabase-sql.mjs ro <query.sql>
 *     走唯讀端點(/database/query/read-only),印出 JSON。查殘留、查現況用。
 *   node scripts/supabase-sql.mjs apply <supabase/migrations/<版本>_<名稱>.sql>
 *     1. 先用唯讀端點查 ledger(supabase_migrations.schema_migrations):版本已經在了就拒送(exit 2,migration 一個字都不送)。
 *     2. timeout(等鎖 5 秒、單句 120 秒)+ migration + ledger 的 INSERT 放在同一個請求(同一個交易)送出。
 *        INSERT 不帶 ON CONFLICT:萬一版本已存在,會在同一個交易裡報錯、連 migration 一起回滾。
 *     3. 讀回 ledger,version / name 不符 → exit 1。
 *     migration 裡不能有 BEGIN / COMMIT / ROLLBACK(否則拒送)。🔴 會真的改正式庫,只在各階段的「部署與驗收」任務用。
 *
 * exit code:0 成功;1 乾跑有失敗或一項都沒有、apply 讀回的 ledger 不符;2 拒送、參數錯、API 錯誤或其他例外。
 * Token 從環境變數 SUPABASE_ACCESS_TOKEN 讀:送出前先驗格式(sbp_ + 40 位小寫十六進位),任何錯誤訊息裡的 token 都會遮掉,工具不會印出來。
 * Cloudflare 會擋沒有瀏覽器 User-Agent 的請求(1010)。
 * 純函式與 main() 由 scripts/supabase-sql.test.mjs 測(fetch 換成假的,不打網路)。
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_REF = "cwvpehqcvbfuynabpqop";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HELPERS_PATH = join(ROOT, "supabase/tests/database/_market_helpers.sql");

// ---------------------------------------------------------------------------
// 靜態檢查:照 Postgres 的切字規則(src/backend/parser/scan.l)切出最外層語句。
// 跟伺服器切法不一樣的地方就是漏洞:2026-10-10 審查實測,舊版遇到 E'\'、"it's"、a$x$、巢狀註解、-- 後面只有 \r、
// 非 ASCII 的 $標$,都能夾帶真的 COMMIT 通過檢查(scripts/supabase-sql.test.mjs 逐一測)。
// 這只用來找交易控制語句,不是完整的 SQL parser;漏網的 COMMIT 還有伺服器端保險擋。
// ---------------------------------------------------------------------------

// 識別字:開頭是英文字母、_ 或非 ASCII(Postgres 把 \200-\377 的位元組都當字母),後面還能接數字與 $
const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c.charCodeAt(0) >= 0x80;
const isIdentCont = (c) => isIdentStart(c) || (c >= "0" && c <= "9") || c === "$";
// $tag$:tag 的字元規則跟識別字一樣,但不能含 $
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;

// -- 註解到換行為止;Postgres 的換行是 \n 或 \r
const skipLineComment = (src, i) => {
  while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
  return i;
};

// i 指在開頭的 /* 之後;/* … */ 可以巢狀
const skipBlockComment = (src, i) => {
  let depth = 1;
  while (depth > 0) {
    if (i >= src.length) throw new Error("拒送:SQL 裡有沒結束的 /* 註解");
    if (src.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (src.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return i;
};

// 字串的結束引號之後:「水平空白或 -- 註解」*、換行、「任何空白或 -- 註解」*、再一個 ' → Postgres 把它當成同一個字串接下去
// (E'…' 接續的那段一樣吃反斜線跳脫)。回傳接續的那個 ' 的位置,沒有接續回 -1。
const quoteContinuation = (src, i) => {
  const n = src.length;
  while (i < n && (" \t\f\v".includes(src[i]) || src.startsWith("--", i))) {
    i = src.startsWith("--", i) ? skipLineComment(src, i) : i + 1;
  }
  if (i >= n || (src[i] !== "\n" && src[i] !== "\r")) return -1;
  while (i < n && (" \t\n\r\f\v".includes(src[i]) || src.startsWith("--", i))) {
    i = src.startsWith("--", i) ? skipLineComment(src, i) : i + 1;
  }
  return src[i] === "'" ? i : -1;
};

// 單引號字串,i 指在開頭的 ' 之後;'' 是字串裡的單引號。backslash = E'…':反斜線跳脫下一個字(包括 ')。
// 一般 '…' 裡的反斜線不跳脫:正式庫 standard_conforming_strings = on(預設值,2026-10-10 查證,沒有角色層級的覆寫)。
const skipQuoted = (src, i, backslash) => {
  for (;;) {
    if (i >= src.length) throw new Error("拒送:SQL 裡有沒結束的 ' 字串");
    if (backslash && src[i] === "\\") {
      i += 2;
    } else if (src[i] !== "'") {
      i += 1;
    } else if (src[i + 1] === "'") {
      i += 2;
    } else {
      const next = quoteContinuation(src, i + 1);
      if (next < 0) return i + 1;
      i = next + 1;
    }
  }
};

// 雙引號識別字,i 指在開頭的 " 之後;"" 是識別字裡的雙引號
const skipQuotedIdent = (src, i) => {
  for (;;) {
    const j = src.indexOf('"', i);
    if (j < 0) throw new Error('拒送:SQL 裡有沒結束的 " 識別字');
    if (src[j + 1] !== '"') return j + 1;
    i = j + 2;
  }
};

/** 去掉註解、字串、"識別字"、$tag$ 本體之後切出最外層的語句;沒結束的字串 / 註解 / 識別字 → 拒送(Postgres 也會整段報錯) */
export const topLevelStatements = (src) => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (src.startsWith("--", i)) {
      i = skipLineComment(src, i);
      out += " ";
    } else if (src.startsWith("/*", i)) {
      i = skipBlockComment(src, i + 2);
      out += " ";
    } else if (c === "'") {
      i = skipQuoted(src, i + 1, false);
      out += " '' ";
    } else if (c === '"') {
      i = skipQuotedIdent(src, i + 1);
      out += ' "" ';
    } else if (c === "$") {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(src);
      if (tag) {
        const end = src.indexOf(tag[0], i + tag[0].length);
        if (end < 0) throw new Error("拒送:SQL 裡有沒結束的 $$ 字串");
        i = end + tag[0].length;
        out += " $body$ ";
      } else {
        out += c; // $1 這類位置參數
        i += 1;
      }
    } else if (isIdentStart(c)) {
      // 識別字開頭才可能是字串前綴:E'…'(反斜線跳脫)、B'…' X'…' N'…'、U&'…'、U&"…"
      const c1 = src[i + 1];
      const c2 = src[i + 2];
      if ((c === "E" || c === "e") && c1 === "'") {
        i = skipQuoted(src, i + 2, true);
        out += " '' ";
      } else if ("BbXxNn".includes(c) && c1 === "'") {
        i = skipQuoted(src, i + 2, false);
        out += " '' ";
      } else if ((c === "U" || c === "u") && c1 === "&" && c2 === "'") {
        i = skipQuoted(src, i + 3, false);
        out += " '' ";
      } else if ((c === "U" || c === "u") && c1 === "&" && c2 === '"') {
        i = skipQuotedIdent(src, i + 3);
        out += ' "" ';
      } else {
        // 整個識別字一次吃掉:a$x$ 是一個識別字,裡面的 $x$ 不是字串開頭
        let j = i + 1;
        while (j < n && isIdentCont(src[j])) j += 1;
        out += src.slice(i, j);
        i = j;
      }
    } else {
      out += c;
      i += 1;
    }
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

/**
 * 伺服器端的 COMMIT 保險,接在 BEGIN 之後、使用者的 SQL 之前。
 * DEFERRABLE INITIALLY DEFERRED 的 constraint trigger 只在 commit(COMMIT / END / COMMIT AND CHAIN / PREPARE TRANSACTION)時才跑,
 * 一跑就 RAISE → commit 失敗、整筆回滾;ROLLBACK 直接丟掉待跑的 trigger,不受影響。
 * 交易中途也拔不掉:有待跑 trigger 的表不能 DROP / TRUNCATE / ALTER。全部是暫存物件,不會留在正式庫。
 * 擋不到的只有「先漏一句 ROLLBACK、後面再漏一句 COMMIT」(保險跟著第一句 ROLLBACK 一起消失),這要兩句都騙過靜態檢查。
 */
export const COMMIT_GUARD_SQL = [
  "CREATE TEMP TABLE _supabase_sql_commit_guard (armed boolean NOT NULL) ON COMMIT DROP",
  `CREATE FUNCTION pg_temp._supabase_sql_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION '乾跑保險:SQL 在交易中途要 commit(COMMIT / END / PREPARE TRANSACTION),整筆交易已回滾,正式庫沒有被改'
    USING HINT = 'dry_run_commit_blocked';
END
$guard$`,
  "CREATE CONSTRAINT TRIGGER _supabase_sql_commit_guard AFTER INSERT ON _supabase_sql_commit_guard" +
    " DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp._supabase_sql_commit_guard()",
  "INSERT INTO _supabase_sql_commit_guard VALUES (true)",
].join("\n;\n");

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
    COMMIT_GUARD_SQL,
    helpers,
    ...migrations,
    ...rollbacks,
    test,
    SUMMARY_SQL,
    "ROLLBACK",
  ].join("\n;\n") + ";\n";

/** 檔名 20261009120000_market_catalog.sql → ledger 那一列。不帶 ON CONFLICT:重複版本要在同一個交易裡報錯、連 migration 一起回滾 */
export const ledgerFor = (file) => {
  const m = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(basename(file));
  if (!m) throw new Error(`migration 檔名要是 <14 位數字版本>_<小寫名稱>.sql:${basename(file)}`);
  return {
    version: m[1],
    name: m[2],
    sql: `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${m[1]}', '${m[2]}');`,
  };
};

// apply 的 timeout:等鎖最多 5 秒(不要排在正式站的查詢後面、把它們一起卡住),單句最多 120 秒
const APPLY_LOCK_TIMEOUT = "5s";
const APPLY_STATEMENT_TIMEOUT = "120s";

export const composeApply = (migrationSql, file) => {
  assertNoTxControl(migrationSql);
  return (
    [
      `SET LOCAL lock_timeout = '${APPLY_LOCK_TIMEOUT}'`,
      `SET LOCAL statement_timeout = '${APPLY_STATEMENT_TIMEOUT}'`,
      migrationSql,
      ledgerFor(file).sql,
    ].join("\n;\n") + "\n"
  );
};

const ledgerQuery = (version) =>
  `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '${version}'`;

export const summarize = (body) => {
  const result = Array.isArray(body) ? body[0]?.result : undefined;
  if (!result || typeof result.total !== "number") {
    throw new Error(`看不懂乾跑結果:${JSON.stringify(body).slice(0, 300)}`);
  }
  return result;
};

// Supabase personal access token 的格式(跟 Supabase CLI 的檢查一樣):sbp_ 或 sbp_oauth_ 加 40 位小寫十六進位
const TOKEN_PATTERN = /^sbp_(?:oauth_)?[0-9a-f]{40}$/;

/** 送出前驗 token 格式。格式不對的 token(例如中間夾換行)會讓 fetch 在錯誤訊息裡印出整個 Authorization 標頭;這裡的訊息不含 token */
export const checkToken = (token) => {
  if (!token) throw new Error("需要環境變數 SUPABASE_ACCESS_TOKEN(值不要印出來)");
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("SUPABASE_ACCESS_TOKEN 格式不對:要是 sbp_ 開頭加 40 位小寫十六進位,中間不能有空白或換行(值不印出來)");
  }
  return token;
};

/** 把訊息裡的 token 遮成 ***:整串、被空白 / 換行切開的每一段(8 字以上)、JSON 跳脫後的樣子 */
export const redact = (text, token) => {
  let out = String(text);
  if (!token) return out;
  const pieces = [token, JSON.stringify(token).slice(1, -1), ...token.split(/\s+/)]
    .filter((p) => p.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const p of pieces) out = out.split(p).join("***");
  return out;
};

export const post = async (path, query) => {
  const token = checkToken(process.env.SUPABASE_ACCESS_TOKEN);
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

/** 執行一個指令,回傳 exit code;例外往外丟,由 main() 統一處理 */
const run = async (argv) => {
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
    return result.failed > 0 || result.total === 0 ? 1 : 0;
  }

  if (mode === "ro") {
    console.log(JSON.stringify(await post("/database/query/read-only", read(file)), null, 2));
    return 0;
  }

  if (mode === "apply") {
    const ledger = ledgerFor(file);
    const sql = composeApply(read(file), file); // 檔名、交易控制都先在本機檢查,不合格一個請求都不送
    const before = await post("/database/query/read-only", ledgerQuery(ledger.version));
    if (!Array.isArray(before)) throw new Error(`看不懂 ledger 查詢結果,不套用:${JSON.stringify(before).slice(0, 300)}`);
    if (before.length > 0) {
      throw new Error(`拒送:ledger 已經有版本 ${ledger.version}(${JSON.stringify(before)}),這支 migration 套用過了,不會再送一次`);
    }
    await post("/database/query", sql);
    const after = await post("/database/query/read-only", ledgerQuery(ledger.version));
    const matches =
      Array.isArray(after) && after.length === 1 && after[0]?.version === ledger.version && after[0]?.name === ledger.name;
    if (!matches) {
      console.error(`套用後讀回的 ledger 不符(預期 ${ledger.version} / ${ledger.name}):${JSON.stringify(after)}`);
      return 1;
    }
    console.log(`已套用 ${basename(file)};ledger:${JSON.stringify(after)}`);
    return 0;
  }

  throw new Error(`不認得的模式:${mode}(只有 dry / ro / apply)`);
};

/** CLI 進入點:回傳 exit code;任何錯誤都印到 stderr(token 一律遮掉)並回 2 */
export const main = async (argv) => {
  try {
    return await run(argv);
  } catch (e) {
    console.error(redact(e instanceof Error ? e.message : String(e), process.env.SUPABASE_ACCESS_TOKEN));
    return 2;
  }
};

/** 是不是直接執行本檔:兩邊都先轉成實際路徑再比(經 symlink、/tmp → /private/tmp 執行時,argv[1] 跟 import.meta.url 寫法不同) */
export const isDirectRun = (argv1, moduleUrl = import.meta.url) => {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};

if (isDirectRun(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
