# 消費者食材市集 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓一般消費者在產品站 `app.ifoodmap.ai/market` 免註冊逛供應商的零售商品、跨店結帳(貨到付款 / 銀行轉帳,錢由供應商自己收),供應商在後台上架與接單、管理員審核,全程有 Email 通知(寄給真實消費者的閘門待業主核准)。

**Architecture:** 另開 `market_*` 資料表(不動餐廳的 `supplier_orders` / `order_events`),權限全靠 RLS + SECURITY DEFINER RPC:anon 只讀已核准上架的商品、只能透過 `market_place_order`(伺服器重算價格、庫存、運費、配送範圍、防灌單)下單、透過 `market_get_orders(token)` 查單;訂單狀態比照餐廳訂單用「只能新增的事件表 + guard / apply / notify trigger」,通知走 pg_net → 新 Edge Function `market-notify` → Resend。前端是產品站裡的新路由 `/market/*`(購物車存在 localStorage)、供應商後台與管理後台各加一個「零售市集」分區;照片放新的公開 Storage bucket `market-images`。

**Tech Stack:** React 18 + Vite + TypeScript + Tailwind + shadcn/ui + @tanstack/react-query、vitest(jsdom)+ Testing Library、Supabase(Postgres 17 + PostgREST + RLS + Storage + pg_net + pg_cron)、Supabase Edge Functions(Deno)+ Resend、形象站 `landing/`(靜態頁 + node:test)。

---

## 執行前必讀

### A. 這份計畫怎麼用

- 照 Task 順序做,一次一個;每個 Task 的步驟照寫的跑:**先寫測試 → 跑一次確認失敗 → 寫實作 → 跑一次確認通過 → commit**。「確認失敗」那一步不能省:沒看到它失敗,就不知道測試有沒有在測東西。
- 程式碼、SQL 都是**完整內容**,照抄;「在 X 找到 → 換成」的段落,找到的那段在檔案裡只會出現一次,整段換掉。看不懂為什麼要這樣寫時,先讀檔案開頭的註解。
- 每個 Task 結尾的 commit **一律列出明確路徑**(不准 `git add -A` / `git add .`),訊息結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。git 一律用 `git -C /Users/aimand/.gemini/File/ifoodmap …`(🔴 不要在上一層 `~/.gemini/File` 那個殼 repo 做任何 git 操作)。
- **只有各階段最後的「部署與驗收」Task 會動正式庫(apply migration)、部署 Edge Function、push。** 其他 Task 只在本機 commit、只用 BEGIN…ROLLBACK 乾跑。
- 🔴 **兩個閘門不在本計畫的執行範圍,只能寫「待業主核准」**:寄信給真實消費者的 secret `MARKET_NOTIFY_LIVE`、對外開放下單的 `app_config.market_checkout_open`。任何 Task 都不准設定它們。
- 卡住(同一個錯誤修兩次還是失敗、或結果跟「Expected」對不上)就停下來回報,附上指令與完整輸出;不要改測試去遷就實作。

### B. 專案事實與限制

- repo:`/Users/aimand/.gemini/File/ifoodmap`(GitHub `ifoodmap-ai/ifoodmap-ai`,分支 `main`)。push main 會自動部署產品站 `app.ifoodmap.ai` 與管理員站 `ifoodmap-admin.vercel.app`(`.github/workflows/deploy-vercel.yml`);改到 `landing/**` 會另外部署形象站 `ifoodmap.ai`(`landing-deploy.yml`)。
- **只有正式庫**(Supabase ref `cwvpehqcvbfuynabpqop`,Postgres 17、pgcrypto 在 `extensions` schema、pg_net、pg_cron),沒有 staging、沒有 Docker、沒有本機 Postgres。
  - migration 用 Management API 一支一支套,並補 `supabase_migrations.schema_migrations` 的 ledger(CI 的 `check-migrations` 會比對)。Task 1 會做一個工具 `scripts/supabase-sql.mjs` 把這件事包起來。
  - **資料庫測試只能在正式庫用 `BEGIN; … ROLLBACK;` 乾跑**,事後一定要跑殘留檢查(`supabase/tests/database/market_residue.sql`,五個數字都要是 0)。Management API 一個請求就是一個交易。
  - Token:`SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"`(這是 2026-10-09 派工時給的路徑;檔案不存在就停下來問派工者,不要自己找)。🔴 **不准印出 token**(不要 `echo`、不要 `cat` 到畫面上)。所有請求都要帶瀏覽器 User-Agent(Cloudflare 會擋,回 1010),工具已經內建。
- Edge Function 部署:`supabase functions deploy <name> --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api`(本機沒有 Docker 所以 `--use-api`;資料庫 trigger 呼叫的函式靠共享密鑰驗證,一定要 `--no-verify-jwt`)。
- **部署順序:migration 先上線,前端才 push**,否則讀新表的頁面會壞。
- Storage:這個專案之前沒用過。bucket 與 `storage.objects` 的 policy 用 SQL 建(2026-10-09 已在正式庫乾跑驗證 postgres 角色建得起來);🔴 **storage 的檔案不能用 SQL 刪**(`storage.protect_objects_delete`),只能用 Storage API / Dashboard。
- 寄信:新閘門 `MARKET_NOTIFY_LIVE` 不是字串 `true` 時,所有信轉寄 `ifoodmaptw@gmail.com`、主旨加「[測試轉寄]」。
- 圖片 2000px 限制:任何截圖要 Read 之前先 `sips -Z 1024 原圖.png --out /tmp/preview.png`,只 Read preview。
- 本機 Node 25 內建一個沒有方法的 `localStorage` 空殼:測試裡要用 localStorage 一律 `vi.stubGlobal("localStorage", createMemoryStorage())`(`src/test/memory-storage.ts`);會 import 到 `@/integrations/supabase/client` 的測試一律 `vi.mock("@/integrations/supabase/client", …)`,否則真的 client 會在 Node 25 炸掉。
- `tsconfig.app.json` 沒開 `strict`:聯集型別用 `if (r.ok === false)` 收窄,`if (r.ok)` 收窄不了(Task 50 有實例)。

### C. 關鍵技術決定(為什麼這樣做)

1. **限流:新寫 `market_rate_take`,不沿用 `ai_rate_take`**(演算法照抄:固定窗格、`INSERT … ON CONFLICT` 鎖列計數、任何一條超過就整批退回且不吃額度)。理由:
   - 呼叫端不同:`ai_rate_take` 只開給 service_role、由 Edge Function `ai` 呼叫(`supabase/migrations/20261007100000_ai_rate_limits.sql:122-223`);下單是 anon 直接呼叫 SECURITY DEFINER 的 `market_place_order`,限流要在同一個交易裡、在 SQL 裡做。
   - `ai_rate_take` 的 bucket 帶 tier / action、被擋統計寫進 `ai_guard_daily`(AI 成本監控用,`/admin/ai-ops` 看的就是它);混進下單會污染 AI 的數字。
   - 改 `ai_rate_take` 的簽名或權限會動到已上線的 AI 防濫用;分開寫,計數表與清理排程(`ifoodmap-market-rate-cleanup`,19:50 UTC)各自獨立,還原時互不影響。
   - 額度:同 IP 每小時 5 / 每天 20(拿不到 IP 不算)、同 Email(去 +tag、gmail 去點,沿用 `supplier_mail_email_key`)每小時 3 / 每天 10、同電話每天 10、全站每天 500。IP / Email / 電話只以「加鹽 sha256 前 16 hex」落地(鹽在 `app_config.market_rate_salt`,migration 隨機產生、不印出來)。平台管理員不限流(業主實測用)。限流放在下單開關之前,開放前的嘗試一樣會被計數。
2. **查單 token**:一次結帳產生一組 32 bytes 隨機值的 base64url(43 字,`extensions.gen_random_bytes`),同一次結帳的每張單共用;資料庫只存 `sha256(token)` 的 hex。token 只出現在兩個地方:下單 RPC 回給買家瀏覽器的結果(前端立刻導到 `/market/orders/<token>?new=1`),以及下單確認信裡的連結(由 `market_place_order` 經 pg_net 傳給 `market-notify`,`market-notify` 寄信前先比對雜湊)。`market-notify` 的回應、log、`notifications` 表都不含 token。查詢頁的電話、Email 遮罩;轉帳資訊只在「待匯款」時給。後續的接單 / 出貨信沒有 token(資料庫只有雜湊),請消費者用確認信的連結看進度。
3. **Storage policy**:bucket `market-images` 公開讀取(商品照片本來就要公開),單檔 ≤ 2 MB、只收 jpeg / png / webp(bucket 設定擋)。寫入由 `storage.objects` 的 4 條 policy 控制:路徑必須是 `<supplier_id>/<product_id 或 store>/<uuid>(_t).<副檔名>`,而且第一層資料夾 ∈ `current_supplier_ids()`;upsert 需要 SELECT + INSERT + UPDATE 三條都在。新商品的 id 由瀏覽器先產生(照片才能先上傳到正確資料夾),資料庫 guard 再檢查 `photos` 裡的路徑都在自家資料夾。前端上傳前壓成長邊 1600px 的 JPEG(縮圖 480px)。刪檔不能用 SQL,換掉的舊照片會留在 bucket(見「風險」)。
4. **下單開關**:`app_config.market_checkout_open`(預設 `'false'`)+ 公開的 `market_checkout_status()` 回 `{open, can_order}`。關著的時候只有平台管理員能下單,業主可以在對外開放前完整實測;購物車頁照樣能逛、能放購物車,只是「前往結帳」不能按並說明原因。
5. **訂單狀態機**:比照餐廳訂單 —— 狀態只經 `market_order_events` 改變;BEFORE trigger(guard)依登入身分決定 actor、檢查目前狀態(畫面過期回 `stale_order_status`)、查轉移表 `market_transition_rules()`;AFTER trigger 改訂單、拒單 / 取消把庫存加回去、轉帳訂單接單後自動轉「待匯款」、排通知。轉移表在 migration 裡用 `-- @market-transitions-begin/end` 標記,前端的 `MARKET_TRANSITIONS` 由 vitest 解析比對,不會各寫各的。縣市、分類、溫層、狀態、電話與 Email 的正規表示式也都用同樣的標記比對。
6. **前端存取 `market_*`**:這些表不在自動產生的 `src/integrations/supabase/types.ts` 裡,沿用專案的 loose cast 慣例(`src/pages/SupplierDetail.tsx:48-58`),集中在 `src/lib/market/db.ts` 的 `marketDb()` / `marketRpc()`,不寫 `any`(eslint 的 `no-explicit-any` 是 error)。

### D. 跟設計稿不一樣的地方(都是為了能照順序做、能驗收)

- **服務條款與隱私權政策頁移到第 2 階段**:結帳要「勾選同意服務條款」,條款頁必須先存在。第 2 階段上線的是草稿(頁面上標「草稿」、`TERMS_VERSION = "2026-10-draft"`),第 3 階段由業主(建議請法律專業)確認文字後定稿。
- **多一個下單開關**(上面 C.4):讓業主在對外開放前用管理員帳號完整走一輪,不必等寄信閘門。
- **形象站入口放在分支 `market-launch`**,業主核准對外開放後才合併推上 main(push main 會自動部署形象站)。

### E. 新檔案地圖

| 位置 | 內容 |
|---|---|
| `scripts/supabase-sql.mjs`(+ `.test.mjs`) | 正式庫乾跑 / 唯讀查詢 / 套 migration 的工具 |
| `supabase/migrations/20261009120000_market_catalog.sql` | 店家、轉帳資訊、零售商品、RLS、guard |
| `supabase/migrations/20261009120100_market_images_storage.sql` | Storage bucket 與 policy |
| `supabase/migrations/20261009130000_market_orders.sql` | 訂單、明細、狀態紀錄、轉移表、guard / apply trigger |
| `supabase/migrations/20261009130100_market_notify.sql` | 狀態紀錄 → pg_net → `market-notify` |
| `supabase/migrations/20261009130200_market_checkout.sql` | 限流、下單 RPC、查單 RPC、下單開關 |
| `supabase/rollbacks/2026100913*.down.sql`、`20261009120*.down.sql` | 每支 migration 的還原檔 |
| `supabase/tests/database/_market_helpers.sql`、`market_*.test.sql` | 乾跑測試(共用工具、各 migration 的測試、還原測試) |
| `supabase/tests/database/market_residue.sql`、`market_launch_readiness.sql` | 殘留檢查、開放前檢查(唯讀) |
| `supabase/functions/market-notify/` | 通知信 Edge Function(gate / render / handler / index) |
| `src/lib/market/` | 常數、型別、資料存取、格式、目錄查詢、圖片、店家 / 商品表單、審核、訂單、購物車、結帳、查單、條款 |
| `src/components/market/` | 市集版面、圖片、商品卡、分類、店家條件、數量、加入購物車、訂單明細、訂單動作視窗 |
| `src/pages/market/` | 市集首頁、商品頁、店家頁、購物車、結帳、訂單查詢、條款頁 |
| `src/pages/supplier/SupplierMarket*.tsx`、`src/pages/supplier/market/` | 供應商:店家設定、零售商品、零售訂單 |
| `src/pages/admin/AdminMarket*.tsx` | 管理員:商品審核、零售店家、零售訂單 |
| `src/hooks/use-current-supplier.ts` | 目前登入者的供應商 id |

### F. 共用指令與基準數字

- 跑單一測試檔(每次都在 repo 根目錄、帶 CI 用的假環境變數):
  ```bash
  cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run <測試檔>
  ```
  通過時最後會有 `Tests  N passed (N)`;下文的 Expected 只寫這一行。
- 資料庫乾跑(Task 1 之後才有這個工具):
  ```bash
  cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry <測試.sql> --with-migration <migration.sql> …
  ```
  通過時最後一行是 `乾跑 <檔名>(migration N 支、rollback M 支、K 句):共 X 項,失敗 0 項`(句數 K 不用管)。
- 殘留檢查(每次乾跑之後):
  ```bash
  cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
  ```
  Expected:`fixture_users`、`fixture_suppliers`、`fixture_objects`、`test_queue_rows`、`test_config_rows` 全部是 `0`。
- 型別與 lint(只報告、不擋,但不能比基準多):
  ```bash
  cd /Users/aimand/.gemini/File/ifoodmap && npx tsc --noEmit -p tsconfig.app.json > /tmp/market-tsc.log 2>&1; grep -c 'error TS' /tmp/market-tsc.log
  cd /Users/aimand/.gemini/File/ifoodmap && npx eslint . -f json -o /tmp/market-eslint.json > /dev/null 2>&1; node -p 'require("/tmp/market-eslint.json").reduce((a, f) => a + f.errorCount, 0)'
  ```
- 兩種 build:
  ```bash
  cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vite build --outDir /tmp/market-build-main > /tmp/market-build-main.log 2>&1; echo $?
  cd /Users/aimand/.gemini/File/ifoodmap && VITE_PORTAL=admin VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vite build --outDir /tmp/market-build-admin > /tmp/market-build-admin.log 2>&1; echo $?
  ```
- **基準(2026-10-09,HEAD `3665192`)與每階段完成後的數字**(2026-10-09 在驗證用副本實測):

  | | vitest | tsc 錯誤 | eslint 錯誤 | 形象站 `npm test` |
  |---|---|---|---|---|
  | 開工前 | 77 檔 / 1177 項 | 72 | 10 | 211 |
  | 第 1 階段完成 | 97 檔 / 1311 項 | 72 | 10 | 211 |
  | 第 2 階段完成 | 111 檔 / 1428 項 | 72 | 10 | 211 |
  | 第 3 階段完成 | 111 檔 / 1428 項 | 72 | 10 | 212 |

  (CI 的報告基準是 tsc 125、eslint 12,這裡用實測值當上限。)
- 乾跑測試的項數:`market_harness` 5、`market_catalog` 70(Task 3 之後 23)、`market_catalog_rollback` 3、`market_images_storage` 17、`market_images_storage_rollback` 3、`market_orders` 45(Task 32 之後 17、Task 33 之後 28)、`market_notify` 9、`market_checkout` 56(Task 36 之後 17、Task 37 之後 48)、`market_phase2_rollback` 4。

### G. 已查證的既有程式位置(2026-10-09,HEAD `3665192`)

- 路由:管理員站 `AdminRoutes` `src/App.tsx:90-127`、前台站 `MainRoutes` `src/App.tsx:129-183`(`IS_ADMIN_BUILD` 二選一,`src/lib/portal.ts:38`);公開頁 `/investors` 在 `src/App.tsx:148`;供應商後台最後一條路由 `src/App.tsx:177`;管理員最後一條 `src/App.tsx:123`;import 的落點 `src/App.tsx:30`、`src/App.tsx:60`、`src/App.tsx:72`。🔴 公開的 `/supplier/:id` 跟供應商後台 `/supplier/*` 已經撞名,市集一律用 `/market` 前綴。
- 登入後分流 `src/lib/portal.ts:112-164`;供應商頁的守門 `src/components/SupplierRoute.tsx:22-27`(查 `supplier_accounts`)。
- 供應商後台選單 `src/pages/supplier/SupplierLayout.tsx:30-81`;商品目錄頁:找自家供應商 id `src/pages/supplier/SupplierCatalogPage.tsx:84-100`、標題區 `src/pages/supplier/SupplierCatalogPage.tsx:171-178`、商品表格 `src/pages/supplier/SupplierCatalogPage.tsx:190-236`。
- 管理後台選單 `src/pages/admin/AdminLayout.tsx:48-160`;管理員呼叫 Edge Function 的寫法 `src/pages/admin/AdminApplicationsPage.tsx:85-107`。
- 照片壓縮的既有做法(存 base64)在 `src/components/restaurant/ReceiveOrderDialog.tsx:63-93`;市集改成存檔案、長邊 1600px。錯誤訊息轉中文的慣例 `src/lib/api.ts:63-78`、`src/lib/api.ts:135-163`。
- 資料庫:`is_admin()` `supabase/migrations/20260528233000_core_supply_schema.sql:3`、`suppliers` `supabase/migrations/20260528233000_core_supply_schema.sql:12`、`supplies` `supabase/migrations/20260528233000_core_supply_schema.sql:29`;`current_supplier_ids()` `supabase/migrations/20260726100000_portals_foundation.sql:108-114`;餐廳訂單事件的 apply trigger `supabase/migrations/20260726100000_portals_foundation.sql:166-183`、只能新增 `supabase/migrations/20260726100000_portals_foundation.sql:186-196`;轉移表標記 `supabase/migrations/20260929100000_order_transition_rules.sql:58`、guard `supabase/migrations/20260929100000_order_transition_rules.sql:178-303`、一次一筆 `supabase/migrations/20260929100000_order_transition_rules.sql:316-335`;pg_net 通知 `supabase/migrations/20260728100000_order_notifications.sql:19-69`;AI 限流 `supabase/migrations/20261007100000_ai_rate_limits.sql:44-51`、清理排程 `supabase/migrations/20261007100000_ai_rate_limits.sql:271-277`;token 只存 sha256 的先例 `supabase/migrations/20261007100100_landing_analysis_claim.sql:39-50`;Email 正規化 `supplier_mail_email_key` `supabase/migrations/20260928180000_supplier_application_mail.sql:131-147`。
- Edge Function:寄信閘門 `supabase/functions/notify/gate.ts:32`、`supabase/functions/notify/gate.ts:51-76`;共享密鑰驗證 `supabase/functions/notify/index.ts:43`、`supabase/functions/notify/index.ts:78-80`;共用寄信 `supabase/functions/_shared/supplier-mail.ts:31-32`、`supabase/functions/_shared/supplier-mail.ts:46-61`、`supabase/functions/_shared/supplier-mail.ts:70-76`、`supabase/functions/_shared/supplier-mail.ts:339-367`。
- 文件:`docs/DEPLOY.md` 套 migration 的做法 `docs/DEPLOY.md:155-180`、寄信閘門 `docs/DEPLOY.md:535-543`、AI 防濫用整段(格式範本)`docs/DEPLOY.md:565-754`。
- 形象站:產品站網址 `landing/index.html:14`、`productUrls` `landing/index.html:2604-2608`、食材分類標題 `landing/index.html:973-976`、分類圖示 `CATEGORY_IMGS` `landing/index.html:2039-2043`(檔案在 `landing/assets/cat-*.svg`);中文分類 `landing/i18n.js:197-210`、英文 `landing/i18n.js:899-912`;網址測試 `landing/tests/content.test.cjs:318-331`。
- **分類圖示怎麼共用**:產品站直接 import 形象站的 `landing/assets/cat-<key>.svg`(Vite 會把 4 KB 以下的 SVG 內嵌成 data URI,其餘打包成雜湊檔名),對照表在 `src/lib/market/categoryIcons.ts`(Task 9),vitest 會檢查 12 個分類都有對應檔案。市集的「酒與飲品」改叫「飲品(不含酒)」:菸酒管理法第 30 條不准用無法辨識年齡的電子購物方式賣酒。

---

## 第 1 階段:上架＋逛店(Task 1–31)

做完這一階段:供應商可以設定零售店家、把商品開放零售並送審;管理員審核;消費者在 `/market` 逛首頁、商品頁、店家頁(還不能下單)。

### Task 1:正式庫乾跑工具 `scripts/supabase-sql.mjs`

這個專案只有正式庫,所有資料庫測試都要包在單一 `BEGIN … ROLLBACK` 裡送出。這支工具負責:組合「共用工具 + migration + 測試 + 彙總」、送出前檢查整段 SQL 真的只有一個 BEGIN…ROLLBACK(中間不能混進 COMMIT)、把結果整理成「共幾項、失敗幾項」;另外提供唯讀查詢與套 migration(順便補 ledger)。純函式用 vitest 測。

**Files:**
- Create: `scripts/supabase-sql.mjs`
- Test: `scripts/supabase-sql.test.mjs`

**Step 1:寫失敗的測試**

```js
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
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run scripts/supabase-sql.test.mjs`

Expected:FAIL,`Failed to load url ./supabase-sql.mjs … Does the file exist?`

**Step 3:寫實作**

```js
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
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  15 passed (15)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add scripts/supabase-sql.mjs scripts/supabase-sql.test.mjs
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 正式庫乾跑工具 supabase-sql.mjs(BEGIN…ROLLBACK 檢查、唯讀查詢、套 migration 補 ledger)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 2:乾跑測試的共用工具、殘留檢查

每支 `market_*.test.sql` 都靠這幾個暫存函式:`pg_temp.expect(項目, 實際, 期望)` 記一筆檢查;`pg_temp.as_exec(角色, JWT claims, SQL)` 以 anon / 登入者身分執行並回 `OK` 或 `ERR <SQLSTATE>[:<hint>]`;`pg_temp.jwt(uid, 是否管理員)` 組 claims。測試資料一律用 `@market-test.invalid` 的 Email 與 `a9?00000-…` 開頭的 uuid,殘留檢查就查這些。

**Files:**
- Create: `supabase/tests/database/_market_helpers.sql`
- Create: `supabase/tests/database/market_residue.sql`
- Test: `supabase/tests/database/market_harness.test.sql`

**Step 1:寫失敗的測試**

```sql
-- 乾跑工具自我檢查(scripts/supabase-sql.mjs dry 組裝:BEGIN → _market_helpers.sql → 本檔 → 彙總 → ROLLBACK)
SELECT pg_temp.expect('as_val 換成 anon 身分執行',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT current_user::text$q$), 'anon');
SELECT pg_temp.expect('as_exec 回報 SQLSTATE',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$SELECT 1 / 0$q$), 'ERR 22012');
SELECT pg_temp.expect('執行完換回資料庫擁有者', current_user::text, 'postgres');
SELECT pg_temp.expect('jwt() 可以帶管理員角色',
  pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true)::json -> 'app_metadata' ->> 'role', 'admin');
SELECT pg_temp.expect('auth.uid() 讀得到 as_val 帶的 sub',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$SELECT auth.uid()::text$q$),
  'a9100000-0000-4000-8000-000000000001');
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_harness.test.sql`

Expected:`ENOENT: no such file or directory, open '…/supabase/tests/database/_market_helpers.sql'`(exit 2,還沒送出任何 SQL)

**Step 3:寫實作**

`supabase/tests/database/_market_helpers.sql`:

```sql
-- =====================================================================
-- 零售市集資料庫測試的共用工具(scripts/supabase-sql.mjs dry 會自動接在 BEGIN 之後、migration 之前)
--
-- 整個乾跑是同一個交易,最後一定 ROLLBACK:fixture、計數、pg_net 佇列都不會留下
-- (事後一定要用 market_residue.sql 走唯讀端點查證)。
-- 每一項檢查寫進暫存表 _r(k = 說明、got = 實際、want = 預期);runner 最後彙總,got ≠ want 就算失敗。
--
-- fixture 慣例(market_residue.sql 靠這兩個特徵查殘留):
--   Email 一律 …@market-test.invalid、UUID 一律 a9?00000-0000-4000-8000- 開頭
-- =====================================================================
CREATE TEMP TABLE _r (seq serial PRIMARY KEY, k text NOT NULL, got text, want text) ON COMMIT DROP;

-- 記一項檢查
CREATE FUNCTION pg_temp.expect(p_k text, p_got text, p_want text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO _r (k, got, want) VALUES (p_k, p_got, p_want)
$f$;

-- 換成某個身分(anon / authenticated + JWT claims)跑一段 SQL:回 'OK',或 'ERR <SQLSTATE>[:<HINT>]'
-- (只附上我們自己 RAISE 的 snake_case HINT;Supabase 在 permission denied 時附的英文說明不算)
CREATE FUNCTION pg_temp.as_exec(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_state text;
  v_hint  text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN CASE WHEN v_state IS NULL THEN 'OK'
              ELSE 'ERR ' || v_state || CASE WHEN COALESCE(v_hint, '') ~ '^[a-z_]+$' THEN ':' || v_hint ELSE '' END END;
END
$f$;

-- 換成某個身分取一個值(查詢只回一列一欄);出錯回 'ERR <SQLSTATE>[:<HINT>]'
CREATE FUNCTION pg_temp.as_val(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_out   text;
  v_state text;
  v_hint  text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    v_out := 'ERR ' || v_state || CASE WHEN COALESCE(v_hint, '') ~ '^[a-z_]+$' THEN ':' || v_hint ELSE '' END;
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_out;
END
$f$;

-- 登入者的 JWT claims(p_admin = 平台管理員:app_metadata.role = admin,跟 public.is_admin() 的判斷一樣)
CREATE FUNCTION pg_temp.jwt(p_uid uuid, p_admin boolean DEFAULT false) RETURNS text LANGUAGE sql AS $f$
  SELECT json_build_object(
    'sub', p_uid,
    'role', 'authenticated',
    'app_metadata', CASE WHEN p_admin THEN json_build_object('role', 'admin') ELSE json_build_object() END
  )::text
$f$;

CREATE FUNCTION pg_temp.anon() RETURNS text LANGUAGE sql AS $f$ SELECT '{"role":"anon"}'::text $f$;

-- 用資料庫擁有者身分(繞過 RLS)但帶某個 JWT 執行一句 SQL:建只有管理員能設的 fixture(例如已核准的商品)
CREATE FUNCTION pg_temp.exec_with_claims(p_claims text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claims', '', true);
END
$f$;
```

`supabase/tests/database/market_residue.sql`(唯讀):

```sql
-- 乾跑之後查殘留(scripts/supabase-sql.mjs ro,唯讀端點)。每個數字都必須是 0。
-- fixture 的特徵:Email 結尾 @market-test.invalid、UUID 開頭 a9?00000-0000-4000-8000-、測試用通知網址 http://127.0.0.1:9/
-- (零售店家、商品、訂單都有外鍵連到 suppliers,fixture 供應商不在 = 它們的資料也不在)
SELECT json_build_object(
  'fixture_users',     (SELECT count(*) FROM auth.users WHERE email LIKE '%@market-test.invalid'),
  'fixture_suppliers', (SELECT count(*) FROM public.suppliers WHERE id::text LIKE 'a9200000-0000-4000-8000-%'),
  'fixture_objects',   (SELECT count(*) FROM storage.objects WHERE name LIKE 'a9200000-0000-4000-8000-%'),
  'test_queue_rows',   (SELECT count(*) FROM net.http_request_queue WHERE url LIKE 'http://127.0.0.1:9/%'),
  'test_config_rows',  (SELECT count(*) FROM public.app_config WHERE value LIKE 'http://127.0.0.1:9/%')
) AS residue;
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`乾跑 market_harness.test.sql(migration 0 支、rollback 0 支、… 句):共 5 項,失敗 0 項`

再跑殘留檢查(「F. 共用指令」裡那一行)。Expected:五個數字全部 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/tests/database/_market_helpers.sql supabase/tests/database/market_residue.sql supabase/tests/database/market_harness.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
test(market): 乾跑測試共用工具與殘留檢查

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 3:migration 120000(上半):零售店家、轉帳資訊

`market_stores`(PK = supplier_id)與 `market_store_transfer`(轉帳資訊分表,anon 讀不到)、22 縣市清單 `market_tw_cities()`(`@market-cities` 標記,前端比對)、`market_store_is_open()`、guard(非管理員改不了零售啟用;停用要原因;縣市去重排序;勾轉帳一定要先有轉帳資訊;logo / 封面路徑必須在自家資料夾)。

**Files:**
- Create: `supabase/migrations/20261009120000_market_catalog.sql`(本 Task 寫上半,Task 4 接下半)
- Test: `supabase/tests/database/market_catalog.test.sql`(同上)

**Step 1:寫失敗的測試**

```sql
-- =====================================================================
-- migration 20261009120000_market_catalog 的資料庫層測試
-- 執行(還沒套用時要帶 --with-migration;套用之後拿掉再跑一次):
--   SUPABASE_ACCESS_TOKEN=… node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql
-- 本檔不含 BEGIN / ROLLBACK(runner 會包起來);fixture 慣例見 _market_helpers.sql。
-- =====================================================================

-- 身分:A 店員工、B 店員工、管理員、一般登入者(不是供應商)、D 店員工(還沒建零售店家)
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'shopper@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-d@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());

INSERT INTO public.suppliers (id, name, contact_email, is_active) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid', true),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid', true),
  ('a9200000-0000-4000-8000-00000000000c', '市集測試 C 店(供應商停用中)', 'store-c@market-test.invalid', false),
  ('a9200000-0000-4000-8000-00000000000d', '市集測試 D 店(還沒建零售店家)', 'store-d@market-test.invalid', true);

INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b'),
  ('a9100000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000d');

INSERT INTO public.supplies (id, supplier_id, name, currency) VALUES
  ('a9500000-0000-4000-8000-0000000000b1', 'a9200000-0000-4000-8000-00000000000b', 'B 店的批發高麗菜', 'TWD');

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
CREATE FUNCTION pg_temp.uadmin() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true) $f$;
CREATE FUNCTION pg_temp.ushop() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000004') $f$;
CREATE FUNCTION pg_temp.ud() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000005') $f$;

-- ---------------------------------------------------------------------
-- 0. 物件與權限
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('anon 對轉帳資訊沒有任何權限',
  has_table_privilege('anon', 'public.market_store_transfer', 'SELECT,INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('anon 不能新增、修改、刪除店家',
  has_table_privilege('anon', 'public.market_stores', 'INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('guard 函式不開給 API 角色',
  (has_function_privilege('authenticated', 'public.market_stores_guard()', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_stores_guard()', 'EXECUTE'))::text, 'false');
SELECT pg_temp.expect('market_store_is_open 開給 anon(公開讀取的 RLS 要用)',
  has_function_privilege('anon', 'public.market_store_is_open(uuid)', 'EXECUTE')::text, 'true');

-- ---------------------------------------------------------------------
-- 1. 零售店家
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('A 建自己的店家(自己填 is_enabled=false)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, ship_days, payment_methods, is_enabled)
    VALUES ('a9200000-0000-4000-8000-00000000000a', ARRAY['新北市', '臺北市', '臺北市'], 120, 1000, 300, 2, ARRAY['cod'], false)$q$),
  'OK');
SELECT pg_temp.expect('供應商不能自己停用:建店時被改回 true',
  (SELECT is_enabled::text FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'), 'true');
SELECT pg_temp.expect('配送縣市去重複、照官方順序存',
  (SELECT array_to_string(delivery_cities, ',') FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'),
  '臺北市,新北市');
SELECT pg_temp.expect('A 不能幫 B 建店家',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'])$q$),
  'ERR 42501');
SELECT pg_temp.expect('B 建自己的店家',
  pg_temp.as_exec('authenticated', pg_temp.ub(), $q$
    INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, min_order_amount, ship_days, payment_methods)
    VALUES ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, 0, 1, ARRAY['cod'])$q$),
  'OK');
SELECT pg_temp.expect('縣市要用官方寫法(「台北市」被擋)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET delivery_cities = ARRAY['台北市'] WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 23514');
SELECT pg_temp.expect('運費超過 10000 被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET shipping_fee = 10001 WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 23514');
SELECT pg_temp.expect('A 自己改 is_enabled 沒有作用',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_stores SET is_enabled = false
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING is_enabled)
    SELECT is_enabled::text FROM u$q$),
  'true');
SELECT pg_temp.expect('勾銀行轉帳但還沒填轉帳資訊被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores SET payment_methods = ARRAY['cod', 'transfer'] WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 22023:transfer_info_required');
SELECT pg_temp.expect('A 存轉帳資訊',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
    VALUES ('a9200000-0000-4000-8000-00000000000a', '  台灣銀行(004) 帳號 0123-456-789 戶名 市集測試  ')$q$),
  'OK');
SELECT pg_temp.expect('轉帳資訊去頭尾空白',
  (SELECT transfer_info FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'),
  '台灣銀行(004) 帳號 0123-456-789 戶名 市集測試');
SELECT pg_temp.expect('填好轉帳資訊就能接受轉帳,付款方式排序存',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_stores SET payment_methods = ARRAY['transfer', 'cod']
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING payment_methods)
    SELECT array_to_string(payment_methods, ',') FROM u$q$),
  'cod,transfer');
SELECT pg_temp.expect('logo 放在別家的資料夾被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores
       SET logo_path = 'a9200000-0000-4000-8000-00000000000b/store/a9900000-0000-4000-8000-000000000001.jpg'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'ERR 22023:invalid_image_path');
SELECT pg_temp.expect('logo 放在自己的 store 資料夾可以',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_stores
       SET logo_path = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000001.jpg'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'OK');
SELECT pg_temp.expect('anon 讀不到轉帳資訊',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_store_transfer$q$), 'ERR 42501');
SELECT pg_temp.expect('B 讀不到 A 的轉帳資訊',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '0');
SELECT pg_temp.expect('A 讀得到自己的轉帳資訊',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '1');
SELECT pg_temp.expect('anon 看得到兩家啟用中的店家',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_stores
     WHERE supplier_id IN ('a9200000-0000-4000-8000-00000000000a', 'a9200000-0000-4000-8000-00000000000b')$q$),
  '2');
SELECT pg_temp.expect('管理員停用店家不填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b'$q$),
  'ERR 22023:disabled_reason_required');
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql`

Expected:`Management API 400:… 42P01: relation \"public.market_store_transfer\" does not exist`(exit 2;整個交易已經回滾)

**Step 3:寫 migration(上半)**

```sql
-- =====================================================================
-- 消費者食材市集(B2C)第 1 階段:零售店家 + 轉帳資訊 + 零售商品與審核
-- (業主 2026-10-09 核准;設計 docs/plans/2026-10-09-consumer-market-design.md、計畫 docs/plans/2026-10-09-consumer-market-plan.md)
--
-- 跟餐廳的詢價訂單(supplier_orders / order_events)完全分開,全部用 market_ 前綴:
--   market_stores          一家供應商一列(PK = supplier_id):配送縣市、運費、免運、最低金額、出貨天數、付款方式、介紹
--   market_store_transfer  轉帳資訊(只有該供應商與管理員讀得到;消費者要等店家接單後,經 token 查單 RPC 才看得到)
--   market_products        零售商品(可選對應 B2B 的 supplies.id,只供參考)與審核狀態
--
-- 權限:
--   anon / 一般登入者:只讀「零售啟用 + 供應商啟用中」的店家,與其中「已核准 + 上架中」的商品(market_store_is_open)
--   供應商:用 current_supplier_ids() 讀寫自家的店家、轉帳資訊、商品;guard trigger 擋「自己核准」「改零售啟用」「搬到別家」
--   管理員(is_admin()):全部;核准 / 退回 / 下架(= 退回並填原因)/ 停用店家零售(要填原因)
--
-- 審核規則(guard trigger 在伺服器端決定,前端只是顯示):
--   - 供應商只能把商品設成 draft / pending;approved / rejected 只有管理員能設
--   - 已核准(approved)的商品改了內容欄位(品名、分類、規格、溫層、產地、保存方式、保存期限、說明、照片)→ 自動回到 pending;
--     改價格、庫存、上架開關(is_listed)、對應的 B2B 商品不用重審
--   - 退回一定要填原因(會顯示給供應商);核准時清掉原因;reviewed_by / reviewed_at / submitted_at 由伺服器填
--
-- 圖片路徑(Storage bucket 在下一支 migration 20261009120100):<supplier_id>/<商品 id 或 store>/<uuid>.<jpg|jpeg|png|webp>
--
-- 前端 src/lib/market/constants.ts 由 vitest 解析本檔 @market-cities / @market-categories / @market-temperatures 標記之間的內容逐字比對。
-- 還原:supabase/rollbacks/20261009120000_market_catalog.down.sql
-- 測試:supabase/tests/database/market_catalog.test.sql(node scripts/supabase-sql.mjs dry,正式庫 BEGIN … ROLLBACK)
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 0. 固定清單與共用檢查
-- ---------------------------------------------------------------------
-- 臺灣 22 縣市(官方寫法「臺」;前端一律用下拉選單,不讓人手打)
CREATE OR REPLACE FUNCTION public.market_tw_cities()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    -- @market-cities-begin
    '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市',
    '基隆市', '新竹市', '嘉義市',
    '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣',
    '宜蘭縣', '花蓮縣', '臺東縣', '澎湖縣', '金門縣', '連江縣'
    -- @market-cities-end
  ]::text[]
$$;

COMMENT ON FUNCTION public.market_tw_cities() IS '零售市集的配送 / 收件縣市清單(22 縣市,與 src/lib/market/constants.ts TW_CITIES 一字不差)';

-- 存在資料表裡的圖片路徑:<supplier_id>/<資料夾>/<uuid>.<副檔名>(資料夾 = 商品 id 或 store;縮圖 _t 不能當正式圖片)
CREATE OR REPLACE FUNCTION public.market_image_path_matches(p_path text, p_supplier uuid, p_folder text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_path IS NOT NULL
     AND p_path ~ ('^' || p_supplier::text || '/' || p_folder
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')
$$;

-- ---------------------------------------------------------------------
-- 1. 零售店家
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_stores (
  supplier_id             uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  is_enabled              boolean NOT NULL DEFAULT true,
  disabled_reason         text,
  logo_path               text,
  cover_path              text,
  intro                   text,
  return_policy           text,
  delivery_cities         text[] NOT NULL,
  shipping_fee            integer NOT NULL DEFAULT 0,
  free_shipping_threshold integer,
  min_order_amount        integer NOT NULL DEFAULT 0,
  ship_days               integer NOT NULL DEFAULT 3,
  payment_methods         text[] NOT NULL DEFAULT ARRAY['cod']::text[],
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_stores_text_lengths CHECK (
    (disabled_reason IS NULL OR char_length(disabled_reason) <= 300)
    AND (intro IS NULL OR char_length(intro) <= 1000)
    AND (return_policy IS NULL OR char_length(return_policy) <= 1000)
    AND (logo_path IS NULL OR char_length(logo_path) <= 200)
    AND (cover_path IS NULL OR char_length(cover_path) <= 200)
  ),
  CONSTRAINT market_stores_delivery_cities CHECK (
    cardinality(delivery_cities) BETWEEN 1 AND 22 AND delivery_cities <@ public.market_tw_cities()
  ),
  CONSTRAINT market_stores_money CHECK (
    shipping_fee BETWEEN 0 AND 10000
    AND (free_shipping_threshold IS NULL OR free_shipping_threshold BETWEEN 1 AND 1000000)
    AND min_order_amount BETWEEN 0 AND 1000000
  ),
  CONSTRAINT market_stores_ship_days CHECK (ship_days BETWEEN 0 AND 30),
  CONSTRAINT market_stores_payment_methods CHECK (
    cardinality(payment_methods) BETWEEN 1 AND 2 AND payment_methods <@ ARRAY['cod', 'transfer']::text[]
  )
);

COMMENT ON TABLE public.market_stores IS
  '零售店家(一家供應商一列)。is_enabled / disabled_reason 只有管理員能改(market_stores_guard)。';

-- 轉帳資訊另一張表:market_stores 對 anon 公開,這張不公開。外鍵接 suppliers(不是 market_stores),
-- 讓店家設定頁可以「先存轉帳資訊、再存店家」(勾銀行轉帳時 guard 會檢查這裡有沒有資料)。
CREATE TABLE IF NOT EXISTS public.market_store_transfer (
  supplier_id   uuid PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  transfer_info text NOT NULL CHECK (char_length(transfer_info) BETWEEN 5 AND 300),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.market_store_transfer IS
  '零售店家的轉帳資訊(銀行、帳號、戶名)。只有該供應商與管理員讀得到;消費者在訂單「待匯款」時經 market_get_orders 看到。';

-- 店家是否對外營業(公開讀取的 RLS 與下單都用這一支;SECURITY DEFINER 才不會被 suppliers 的 RLS 卡住)
CREATE OR REPLACE FUNCTION public.market_store_is_open(p_supplier uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.market_stores s
      JOIN public.suppliers p ON p.id = s.supplier_id
     WHERE s.supplier_id = p_supplier AND s.is_enabled AND p.is_active
  )
$$;

CREATE OR REPLACE FUNCTION public.market_stores_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.supplier_id IS DISTINCT FROM OLD.supplier_id THEN
    RAISE EXCEPTION '不能更改店家所屬的供應商' USING ERRCODE = '42501', HINT = 'supplier_immutable';
  END IF;

  NEW.intro           := NULLIF(btrim(COALESCE(NEW.intro, '')), '');
  NEW.return_policy   := NULLIF(btrim(COALESCE(NEW.return_policy, '')), '');
  NEW.disabled_reason := NULLIF(btrim(COALESCE(NEW.disabled_reason, '')), '');

  -- 零售啟用 / 停用原因只有管理員能改
  IF NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_enabled := true;
      NEW.disabled_reason := NULL;
    ELSE
      NEW.is_enabled := OLD.is_enabled;
      NEW.disabled_reason := OLD.disabled_reason;
    END IF;
  ELSIF NOT NEW.is_enabled AND NEW.disabled_reason IS NULL THEN
    RAISE EXCEPTION '停用店家零售要填寫原因' USING ERRCODE = '22023', HINT = 'disabled_reason_required';
  ELSIF NEW.is_enabled THEN
    NEW.disabled_reason := NULL;
  END IF;

  -- 縣市去重複、照官方順序;付款方式去重複、排序
  NEW.delivery_cities := ARRAY(
    SELECT d.c FROM (SELECT DISTINCT c FROM unnest(NEW.delivery_cities) AS c) d
     ORDER BY array_position(public.market_tw_cities(), d.c) NULLS LAST, d.c
  );
  NEW.payment_methods := ARRAY(SELECT DISTINCT m FROM unnest(NEW.payment_methods) AS m ORDER BY m);

  IF NEW.logo_path IS NOT NULL AND NOT public.market_image_path_matches(NEW.logo_path, NEW.supplier_id, 'store') THEN
    RAISE EXCEPTION '店家 logo 的圖片路徑不正確' USING ERRCODE = '22023', HINT = 'invalid_image_path';
  END IF;
  IF NEW.cover_path IS NOT NULL AND NOT public.market_image_path_matches(NEW.cover_path, NEW.supplier_id, 'store') THEN
    RAISE EXCEPTION '店家封面的圖片路徑不正確' USING ERRCODE = '22023', HINT = 'invalid_image_path';
  END IF;

  IF 'transfer' = ANY (NEW.payment_methods)
     AND NOT EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '接受銀行轉帳要先填寫轉帳資訊' USING ERRCODE = '22023', HINT = 'transfer_info_required';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_stores_guard ON public.market_stores;
CREATE TRIGGER trg_market_stores_guard
BEFORE INSERT OR UPDATE ON public.market_stores
FOR EACH ROW EXECUTE FUNCTION public.market_stores_guard();

CREATE OR REPLACE FUNCTION public.market_store_transfer_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.transfer_info := btrim(COALESCE(NEW.transfer_info, ''));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_store_transfer_touch ON public.market_store_transfer;
CREATE TRIGGER trg_market_store_transfer_touch
BEFORE INSERT OR UPDATE ON public.market_store_transfer
FOR EACH ROW EXECUTE FUNCTION public.market_store_transfer_touch();

ALTER TABLE public.market_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_store_transfer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market stores public read" ON public.market_stores;
CREATE POLICY "market stores public read" ON public.market_stores
  FOR SELECT TO anon, authenticated
  USING (public.market_store_is_open(supplier_id));

DROP POLICY IF EXISTS "market stores supplier manage" ON public.market_stores;
CREATE POLICY "market stores supplier manage" ON public.market_stores
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market stores admin" ON public.market_stores;
CREATE POLICY "market stores admin" ON public.market_stores
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "market store transfer supplier manage" ON public.market_store_transfer;
CREATE POLICY "market store transfer supplier manage" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market store transfer admin" ON public.market_store_transfer;
CREATE POLICY "market store transfer admin" ON public.market_store_transfer
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 這個專案的 public schema 預設把新表的全部權限給 anon / authenticated,RLS 之外再收一層
REVOKE ALL ON TABLE public.market_store_transfer FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_stores FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_stores, public.market_store_transfer FROM authenticated;

REVOKE ALL ON FUNCTION public.market_stores_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_transfer_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_image_path_matches(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_store_is_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_store_is_open(uuid) TO anon, authenticated, service_role;
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql`

Expected:`…共 23 項,失敗 0 項`;接著跑殘留檢查,五個數字全部 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009120000_market_catalog.sql supabase/tests/database/market_catalog.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售店家與轉帳資訊資料表、RLS 與 guard(migration 120000 上半)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 4:migration 120000(下半):零售商品與審核

`market_products`:分類(`@market-categories`,12 類)、溫層(`@market-temperatures`)、價格 1–1,000,000、庫存(NULL = 不限)、照片 ≤ 5 張且路徑必須在 `<自家>/<這個商品>/`、審核狀態。guard:供應商只能送審不能自己核准;已核准的商品改了品名 / 分類 / 規格 / 溫層 / 產地 / 保存方式 / 保存期限 / 說明 / 照片就自動回到待審(改價格、庫存、上架開關不用);退回要原因;管理員核准記錄審核者與時間。anon 只看得到「已核准 + 上架中 + 店家開著」。

**Files:**
- Modify: `supabase/migrations/20261009120000_market_catalog.sql`(接在檔尾)
- Test: `supabase/tests/database/market_catalog.test.sql`(接在檔尾)

**Step 1:寫失敗的測試(接在測試檔最後面)**

```sql

-- ---------------------------------------------------------------------
-- 2. 零售商品與審核
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('anon 不能新增、修改、刪除商品',
  has_table_privilege('anon', 'public.market_products', 'INSERT,UPDATE,DELETE')::text, 'false');
SELECT pg_temp.expect('商品 guard 不開給 API 角色',
  has_function_privilege('authenticated', 'public.market_products_guard()', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('A 新增草稿商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, photos)
    VALUES ('a9300000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a', '  有機高麗菜  ', 'vegetable',
            '1 顆(約 1.2 公斤)', 120, 10, 'chilled',
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000002.jpg'])$q$),
  'OK');
SELECT pg_temp.expect('品名去頭尾空白、預設是草稿、還沒有送審時間',
  (SELECT name || '|' || review_status || '|' || (submitted_at IS NULL)::text
     FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'),
  '有機高麗菜|draft|true');
SELECT pg_temp.expect('供應商不能直接新增成已核准',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, review_status)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '偷上架', 'fruit', '1 盒', 100, 'approved')$q$),
  'ERR 42501:review_status_forbidden');
SELECT pg_temp.expect('A 不能替 B 新增商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b', '冒名', 'fruit', '1 盒', 100)$q$),
  'ERR 42501');
SELECT pg_temp.expect('對應到別家的批發商品被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, supply_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a',
            'a9500000-0000-4000-8000-0000000000b1', '借別人的', 'vegetable', '1 顆', 100)$q$),
  'ERR 22023:supply_not_owned');
SELECT pg_temp.expect('照片放在別的商品資料夾被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '照片錯資料夾', 'fruit', '1 盒', 100,
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000003.jpg'])$q$),
  'ERR 22023:invalid_photo_path');
SELECT pg_temp.expect('縮圖(_t)不能當商品照片',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '拿縮圖', 'fruit', '1 盒', 100,
            ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000002/a9900000-0000-4000-8000-000000000003_t.jpg'])$q$),
  'ERR 22023:invalid_photo_path');
SELECT pg_temp.expect('照片超過 5 張被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, photos)
    SELECT 'a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '六張照片', 'fruit', '1 盒', 100,
           ARRAY(SELECT 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000002/a9900000-0000-4000-8000-00000000001' || n || '.jpg'
                   FROM generate_series(0, 5) AS n)$q$),
  'ERR 23514');
SELECT pg_temp.expect('品名超過 60 字被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', repeat('菜', 61), 'vegetable', '1 顆', 100)$q$),
  'ERR 23514');
SELECT pg_temp.expect('價格 0 元被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '免費', 'vegetable', '1 顆', 0)$q$),
  'ERR 23514');
SELECT pg_temp.expect('分類不在 12 類裡被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', '紅酒', 'alcohol', '1 瓶', 900)$q$),
  'ERR 23514');
SELECT pg_temp.expect('還沒建零售店家的供應商不能新增商品(外鍵)',
  pg_temp.as_exec('authenticated', pg_temp.ud(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-0000000000d1', 'a9200000-0000-4000-8000-00000000000d', '沒有店', 'fruit', '1 盒', 100)$q$),
  'ERR 23503');
SELECT pg_temp.expect('A 送出審核',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET review_status = 'pending' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('送審時間由伺服器填',
  (SELECT (submitted_at IS NOT NULL)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'), 'true');
SELECT pg_temp.expect('供應商不能自己核准',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:review_status_forbidden');
SELECT pg_temp.expect('anon 看不到待審商品',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('B 看不到 A 的待審商品',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('管理員退回不填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'rejected' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 22023:reject_reason_required');
SELECT pg_temp.expect('管理員退回(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'rejected', reject_reason = '照片太暗'
     WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('退回後 A 改內容:原因保留(還沒重新送審)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET description = '更新說明'
                WHERE id = 'a9300000-0000-4000-8000-000000000001'
                RETURNING review_status || '|' || COALESCE(reject_reason, '∅') AS v)
    SELECT v FROM u$q$),
  'rejected|照片太暗');
SELECT pg_temp.expect('A 重新送審,原因清掉',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET review_status = 'pending'
                WHERE id = 'a9300000-0000-4000-8000-000000000001'
                RETURNING review_status || '|' || COALESCE(reject_reason, '∅') AS v)
    SELECT v FROM u$q$),
  'pending|∅');
SELECT pg_temp.expect('管理員核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('核准者與時間由伺服器填',
  (SELECT reviewed_by::text || '|' || (reviewed_at IS NOT NULL)::text
     FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'),
  'a9100000-0000-4000-8000-000000000003|true');
SELECT pg_temp.expect('anon 看得到已核准、上架中、店家啟用的商品',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '1');
SELECT pg_temp.expect('一般登入者(不是供應商)也看得到',
  pg_temp.as_val('authenticated', pg_temp.ushop(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '1');
SELECT pg_temp.expect('B 看得到 A 上架中的商品,但改不了(0 列)',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH u AS (UPDATE public.market_products SET price = 1 WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '0');
SELECT pg_temp.expect('A 改價格、庫存不用重審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET price = 99, stock = 5
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'approved');
SELECT pg_temp.expect('A 改品名就回到待審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET name = '有機高麗菜(大)'
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'pending');
SELECT pg_temp.expect('回到待審後 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('管理員再核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('A 換照片也要重審',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products
                  SET photos = ARRAY['a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004.jpg']
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'pending');
SELECT pg_temp.expect('管理員第三次核准',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_products SET review_status = 'approved' WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('A 關掉上架開關:狀態仍是已核准',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE public.market_products SET is_listed = false
                WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING review_status)
    SELECT review_status FROM u$q$),
  'approved');
SELECT pg_temp.expect('關掉上架開關後 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$), '0');
SELECT pg_temp.expect('A 重新打開上架開關',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET is_listed = true WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'OK');
SELECT pg_temp.expect('管理員停用 A 的零售(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.uadmin(), $q$
    UPDATE public.market_stores SET is_enabled = false, disabled_reason = '客訴處理中'
     WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  'OK');
SELECT pg_temp.expect('店家停用後 anon 看不到商品、也看不到店家',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT (SELECT count(*) FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001')::text || '|' ||
           (SELECT count(*) FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a')::text$q$),
  '0|0');
SELECT pg_temp.expect('A 自己看得到停用原因',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT disabled_reason FROM public.market_stores WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a'$q$),
  '客訴處理中');
SELECT pg_temp.expect('管理員恢復零售,原因清掉',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    WITH u AS (UPDATE public.market_stores SET is_enabled = true
                WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000a' RETURNING COALESCE(disabled_reason, '∅') AS v)
    SELECT v FROM u$q$),
  '∅');
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(), $q$
  INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000c', ARRAY['臺北市'])$q$);
SELECT pg_temp.exec_with_claims(pg_temp.uadmin(), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, review_status)
  VALUES ('a9300000-0000-4000-8000-0000000000c1', 'a9200000-0000-4000-8000-00000000000c', '停用供應商的商品', 'fruit', '1 盒', 100, 'approved')$q$);
SELECT pg_temp.expect('供應商停用中(suppliers.is_active = false)的商品 anon 看不到',
  pg_temp.as_val('anon', pg_temp.anon(), $q$
    SELECT count(*)::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000c1'$q$), '0');
SELECT pg_temp.expect('A 不能把商品搬到 B',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_products SET supplier_id = 'a9200000-0000-4000-8000-00000000000b'
     WHERE id = 'a9300000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:supplier_immutable');
SELECT pg_temp.expect('anon 不能新增商品',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.market_products (supplier_id, name, category, spec, price)
    VALUES ('a9200000-0000-4000-8000-00000000000a', '匿名', 'fruit', '1 盒', 100)$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 新增第二個草稿商品',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_products (id, supplier_id, name, category, spec, price)
    VALUES ('a9300000-0000-4000-8000-000000000003', 'a9200000-0000-4000-8000-00000000000a', '要刪的草稿', 'fruit', '1 盒', 100)$q$),
  'OK');
SELECT pg_temp.expect('A 刪掉自己的草稿商品',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH d AS (DELETE FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000003' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '1');
SELECT pg_temp.expect('B 刪不掉 A 的商品',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH d AS (DELETE FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-000000000001' RETURNING 1)
    SELECT count(*)::text FROM d$q$),
  '0');
```

**Step 2:跑測試,確認失敗**

Run:同 Task 3 Step 4。Expected:`Management API 400:… 42P01: relation \"public.market_products\" does not exist`

**Step 3:寫 migration(下半,接在檔尾)**

```sql

-- ---------------------------------------------------------------------
-- 2. 零售商品
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES public.market_stores(supplier_id) ON DELETE CASCADE,
  supply_id      uuid REFERENCES public.supplies(id) ON DELETE SET NULL,
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN (
    -- @market-categories-begin
    'vegetable', 'fruit', 'seafood', 'meat', 'egg', 'grain',
    'grocery', 'processed', 'hotpot', 'condiment', 'drink', 'packaging'
    -- @market-categories-end
  )),
  spec           text NOT NULL,
  price          integer NOT NULL,
  stock          integer,
  temperature    text NOT NULL DEFAULT 'ambient' CHECK (temperature IN (
    -- @market-temperatures-begin
    'ambient', 'chilled', 'frozen'
    -- @market-temperatures-end
  )),
  origin         text,
  storage_method text,
  shelf_life     text,
  description    text,
  photos         text[] NOT NULL DEFAULT '{}'::text[],
  review_status  text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'pending', 'approved', 'rejected')),
  reject_reason  text,
  is_listed      boolean NOT NULL DEFAULT true,
  submitted_at   timestamptz,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_products_text_lengths CHECK (
    char_length(name) BETWEEN 1 AND 60
    AND char_length(spec) BETWEEN 1 AND 40
    AND (origin IS NULL OR char_length(origin) <= 40)
    AND (storage_method IS NULL OR char_length(storage_method) <= 100)
    AND (shelf_life IS NULL OR char_length(shelf_life) <= 40)
    AND (description IS NULL OR char_length(description) <= 2000)
    AND (reject_reason IS NULL OR char_length(reject_reason) <= 300)
  ),
  CONSTRAINT market_products_price CHECK (price BETWEEN 1 AND 1000000),
  CONSTRAINT market_products_stock CHECK (stock IS NULL OR stock BETWEEN 0 AND 100000),
  CONSTRAINT market_products_photos CHECK (cardinality(photos) <= 5)
);

CREATE INDEX IF NOT EXISTS market_products_supplier_idx ON public.market_products (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_products_public_idx ON public.market_products (review_status, is_listed, created_at DESC);

COMMENT ON TABLE public.market_products IS
  '零售商品。價格為整數新台幣;stock NULL = 不限。review_status 由 market_products_guard 把關(供應商只能 draft / pending)。';
COMMENT ON COLUMN public.market_products.supply_id IS '對應的 B2B 商品(supplies.id),只供參考,不影響價格與庫存';
COMMENT ON COLUMN public.market_products.is_listed IS '供應商自己的上架開關(已核准的商品暫停販售用,不用重審)';

CREATE OR REPLACE FUNCTION public.market_products_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin   boolean := public.is_admin();
  v_content boolean;
  v_bad     text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.id IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION '不能更改商品所屬的店家' USING ERRCODE = '42501', HINT = 'supplier_immutable';
  END IF;

  -- 文字欄位去頭尾空白,空字串當成沒填
  NEW.name           := btrim(COALESCE(NEW.name, ''));
  NEW.spec           := btrim(COALESCE(NEW.spec, ''));
  NEW.origin         := NULLIF(btrim(COALESCE(NEW.origin, '')), '');
  NEW.storage_method := NULLIF(btrim(COALESCE(NEW.storage_method, '')), '');
  NEW.shelf_life     := NULLIF(btrim(COALESCE(NEW.shelf_life, '')), '');
  NEW.description    := NULLIF(btrim(COALESCE(NEW.description, '')), '');
  NEW.reject_reason  := NULLIF(btrim(COALESCE(NEW.reject_reason, '')), '');
  NEW.photos         := COALESCE(NEW.photos, '{}'::text[]);

  -- 照片一定在自己的資料夾:<supplier_id>/<商品 id>/<uuid>.<副檔名>
  SELECT p INTO v_bad
    FROM unnest(NEW.photos) AS p
   WHERE NOT public.market_image_path_matches(p, NEW.supplier_id, NEW.id::text)
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '商品照片的路徑不正確:%', v_bad USING ERRCODE = '22023', HINT = 'invalid_photo_path';
  END IF;

  -- 對應的 B2B 商品必須是自家的
  IF NEW.supply_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.supplies s WHERE s.id = NEW.supply_id AND s.supplier_id = NEW.supplier_id) THEN
    RAISE EXCEPTION '對應的批發商品不是你家的' USING ERRCODE = '22023', HINT = 'supply_not_owned';
  END IF;

  IF v_admin THEN
    IF NEW.review_status = 'rejected' AND NEW.reject_reason IS NULL THEN
      RAISE EXCEPTION '退回或下架要填寫原因(會顯示給供應商)' USING ERRCODE = '22023', HINT = 'reject_reason_required';
    END IF;
    IF NEW.review_status IN ('approved', 'rejected')
       AND (TG_OP = 'INSERT' OR NEW.review_status IS DISTINCT FROM OLD.review_status) THEN
      NEW.reviewed_by := auth.uid();
      NEW.reviewed_at := now();
    END IF;
    IF NEW.review_status = 'approved' THEN
      NEW.reject_reason := NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.review_status NOT IN ('draft', 'pending') THEN
      RAISE EXCEPTION '商品要經過管理員審核才能上架' USING ERRCODE = '42501', HINT = 'review_status_forbidden';
    END IF;
    NEW.reviewed_by   := NULL;
    NEW.reviewed_at   := NULL;
    NEW.reject_reason := NULL;
  ELSE
    -- 審核欄位只有管理員能動
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    IF NEW.review_status IS DISTINCT FROM OLD.review_status
       AND NOT (NEW.review_status IN ('draft', 'pending') AND OLD.review_status IN ('draft', 'pending', 'rejected')) THEN
      RAISE EXCEPTION '商品要經過管理員審核才能上架' USING ERRCODE = '42501', HINT = 'review_status_forbidden';
    END IF;
    -- 已核准的商品改了內容 → 回到待審(改價格、庫存、上架開關不用重審)
    v_content := NEW.name IS DISTINCT FROM OLD.name
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.spec IS DISTINCT FROM OLD.spec
      OR NEW.temperature IS DISTINCT FROM OLD.temperature
      OR NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.storage_method IS DISTINCT FROM OLD.storage_method
      OR NEW.shelf_life IS DISTINCT FROM OLD.shelf_life
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.photos IS DISTINCT FROM OLD.photos;
    IF OLD.review_status = 'approved' AND v_content THEN
      NEW.review_status := 'pending';
    END IF;
    -- 退回原因留給供應商看;重新送審就清掉
    NEW.reject_reason := CASE WHEN NEW.review_status = 'rejected' THEN OLD.reject_reason ELSE NULL END;
  END IF;

  IF NEW.review_status = 'pending' AND (TG_OP = 'INSERT' OR OLD.review_status IS DISTINCT FROM 'pending') THEN
    NEW.submitted_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.submitted_at := OLD.submitted_at;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_products_guard ON public.market_products;
CREATE TRIGGER trg_market_products_guard
BEFORE INSERT OR UPDATE ON public.market_products
FOR EACH ROW EXECUTE FUNCTION public.market_products_guard();

ALTER TABLE public.market_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "market products public read" ON public.market_products;
CREATE POLICY "market products public read" ON public.market_products
  FOR SELECT TO anon, authenticated
  USING (review_status = 'approved' AND is_listed AND public.market_store_is_open(supplier_id));

DROP POLICY IF EXISTS "market products supplier manage" ON public.market_products;
CREATE POLICY "market products supplier manage" ON public.market_products
  FOR ALL TO authenticated
  USING (supplier_id IN (SELECT public.current_supplier_ids()))
  WITH CHECK (supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market products admin" ON public.market_products;
CREATE POLICY "market products admin" ON public.market_products
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_products FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.market_products FROM authenticated;
REVOKE ALL ON FUNCTION public.market_products_guard() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
```

**Step 4:跑測試,確認通過**

Run:同 Task 3 Step 4。Expected:`…共 70 項,失敗 0 項`;殘留檢查五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009120000_market_catalog.sql supabase/tests/database/market_catalog.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售商品資料表、審核狀態與 RLS(migration 120000 下半)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 5:migration 120000 的還原檔

**Files:**
- Create: `supabase/rollbacks/20261009120000_market_catalog.down.sql`
- Test: `supabase/tests/database/market_catalog_rollback.test.sql`

**Step 1:寫失敗的測試**

```sql
-- 20261009120000 的還原檔能跑、跑完乾淨(runner:--with-migration <migration> --with-rollback <down.sql>,本檔在兩者之後執行)
SELECT pg_temp.expect('還原後三張表都不在',
  (SELECT count(*)::text FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname IN ('market_stores', 'market_store_transfer', 'market_products')),
  '0');
SELECT pg_temp.expect('還原後函式都不在',
  (SELECT count(*)::text FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('market_tw_cities', 'market_image_path_matches', 'market_store_is_open',
                      'market_stores_guard', 'market_products_guard', 'market_store_transfer_touch')),
  '0');
SELECT pg_temp.expect('ledger 沒有這支 migration',
  (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261009120000'), '0');
```

**Step 2:跑測試,確認失敗(只套 migration、不套還原檔)**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql`

Expected:`…共 3 項,失敗 2 項`,失敗的是「還原後三張表都不在」(got 3)與「還原後函式都不在」(got 6);exit 1。

**Step 3:寫還原檔**

```sql
-- =====================================================================
-- 還原 20261009120000_market_catalog
-- 🔴 會刪掉零售店家、轉帳資訊、零售商品的資料 —— 先匯出再跑。
-- 🔴 順序:第 2 階段的 migration(20261009130200 → 130100 → 130000)與 20261009120100(Storage)要先還原;
--    前端也要先退回不碰 market_* 的版本(Vercel Instant Rollback),否則供應商後台的商品目錄頁會壞。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案(Management API 一個請求就是一個交易)。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS public.market_products;
DROP TABLE IF EXISTS public.market_store_transfer;
DROP TABLE IF EXISTS public.market_stores;

DROP FUNCTION IF EXISTS public.market_products_guard();
DROP FUNCTION IF EXISTS public.market_stores_guard();
DROP FUNCTION IF EXISTS public.market_store_transfer_touch();
DROP FUNCTION IF EXISTS public.market_store_is_open(uuid);
DROP FUNCTION IF EXISTS public.market_image_path_matches(text, uuid, text);
DROP FUNCTION IF EXISTS public.market_tw_cities();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009120000';

NOTIFY pgrst, 'reload schema';
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-rollback supabase/rollbacks/20261009120000_market_catalog.down.sql`

Expected:`…共 3 項,失敗 0 項`;殘留檢查五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/rollbacks/20261009120000_market_catalog.down.sql supabase/tests/database/market_catalog_rollback.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): migration 120000 還原檔與還原測試

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 6:migration 120100:商品照片的 Storage bucket 與 policy

bucket `market-images`(公開讀取、2 MB、jpeg / png / webp),`market_image_object_ok(name)` 檢查路徑格式且第一層資料夾是自家供應商,4 條 policy 只開給 authenticated。測試以登入的供應商身分在交易裡寫 `storage.objects`(會跟著 ROLLBACK 消失;🔴 不要在交易外用 SQL 刪 storage 的列)。

**Files:**
- Create: `supabase/migrations/20261009120100_market_images_storage.sql`
- Test: `supabase/tests/database/market_images_storage.test.sql`

**Step 1:寫失敗的測試**

```sql
-- =====================================================================
-- migration 20261009120100_market_images_storage 的資料庫層測試(Storage 的 RLS)
--   … dry supabase/tests/database/market_images_storage.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql \
--     --with-migration supabase/migrations/20261009120100_market_images_storage.sql
-- 只 INSERT / UPDATE storage.objects(SQL 刪不掉,靠 ROLLBACK 清乾淨)。這裡不會產生任何真的檔案。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
-- 用 A 的身分上傳一個物件(只寫 metadata 列,不是真的檔案)
CREATE FUNCTION pg_temp.put(p_claims text, p_name text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_exec('authenticated', p_claims,
    format($q$INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('market-images', %L, auth.uid())$q$, p_name))
$f$;

SELECT pg_temp.expect('bucket:公開、2 MB、三種圖片格式',
  (SELECT public::text || '|' || file_size_limit::text || '|' || array_to_string(allowed_mime_types, ',')
     FROM storage.buckets WHERE id = 'market-images'),
  'true|2097152|image/jpeg,image/png,image/webp');
SELECT pg_temp.expect('四條 policy 都在',
  (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname)
     FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'market images%'),
  'market images supplier delete:DELETE,market images supplier insert:INSERT,market images supplier select:SELECT,market images supplier update:UPDATE');
SELECT pg_temp.expect('anon 不能執行路徑檢查函式(也不需要)',
  has_function_privilege('anon', 'public.market_image_object_ok(text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('A 上傳商品照片',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg'), 'OK');
SELECT pg_temp.expect('A 上傳縮圖',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001_t.jpg'), 'OK');
SELECT pg_temp.expect('A 上傳店家封面(webp)',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp'), 'OK');
SELECT pg_temp.expect('A 用 upsert 覆寫同一個檔(SELECT + INSERT + UPDATE 三條都要過)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('market-images', 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg', auth.uid())
    ON CONFLICT (bucket_id, name) DO UPDATE SET owner = EXCLUDED.owner$q$),
  'OK');
SELECT pg_temp.expect('A 傳到 B 的資料夾被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000b/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000003.jpg'), 'ERR 42501');
SELECT pg_temp.expect('gif 被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000004.gif'), 'ERR 42501');
SELECT pg_temp.expect('多一層資料夾被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/x/a9900000-0000-4000-8000-000000000005.jpg'), 'ERR 42501');
SELECT pg_temp.expect('第二層不是商品 id 也不是 store 被擋',
  pg_temp.put(pg_temp.ua(), 'a9200000-0000-4000-8000-00000000000a/logo/a9900000-0000-4000-8000-000000000006.jpg'), 'ERR 42501');
SELECT pg_temp.expect('anon 不能上傳',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO storage.objects (bucket_id, name)
    VALUES ('market-images', 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000007.jpg')$q$),
  'ERR 42501');
SELECT pg_temp.expect('B 列不到 A 的檔案',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'market-images' AND name LIKE 'a9200000-0000-4000-8000-00000000000a/%'$q$),
  '0');
SELECT pg_temp.expect('A 列得到自己的 3 個檔',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'market-images' AND name LIKE 'a9200000-0000-4000-8000-00000000000a/%'$q$),
  '3');
SELECT pg_temp.expect('A 改得了自己的檔案(UPDATE policy)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH u AS (UPDATE storage.objects SET user_metadata = '{"by":"test"}'::jsonb
                WHERE bucket_id = 'market-images'
                  AND name = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '1');
SELECT pg_temp.expect('B 改不到 A 的檔案',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    WITH u AS (UPDATE storage.objects SET user_metadata = '{"by":"b"}'::jsonb
                WHERE bucket_id = 'market-images'
                  AND name = 'a9200000-0000-4000-8000-00000000000a/store/a9900000-0000-4000-8000-000000000002.webp' RETURNING 1)
    SELECT count(*)::text FROM u$q$),
  '0');
UPDATE public.supplier_accounts SET is_active = false WHERE user_id = 'a9100000-0000-4000-8000-000000000002';
SELECT pg_temp.expect('帳號停用後不能再上傳',
  pg_temp.put(pg_temp.ub(), 'a9200000-0000-4000-8000-00000000000b/store/a9900000-0000-4000-8000-000000000008.jpg'), 'ERR 42501');
```

**Step 2:跑測試,確認失敗(只套 120000)**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql`

Expected:`Management API 400:… 42883: function \"public.market_image_object_ok(text)\" does not exist`

**Step 3:寫 migration**

```sql
-- =====================================================================
-- 消費者食材市集:商品照片與店家 logo / 封面的 Storage bucket(這個專案第一次用 Storage)
--
-- bucket market-images:
--   - 公開讀取(圖片網址 /storage/v1/object/public/market-images/<路徑>,不經過 RLS);沒有給 anon 的 SELECT policy → 不能列目錄
--   - 每個檔案 ≤ 2 MB、只收 image/jpeg、image/png、image/webp(Storage 伺服器端檢查,前端繞不過)
-- 路徑:<supplier_id>/<商品 id 或 store>/<uuid>[_t].<jpg|jpeg|png|webp>(_t = 列表用的 480px 縮圖)
-- 寫入(上傳、覆寫、刪除)只限路徑第一段 ∈ current_supplier_ids() 的登入者(該供應商的啟用中帳號)。
--
-- 🔴 Storage 的 upsert(x-upsert: true)要 SELECT + INSERT + UPDATE 三條 policy 都過(PikTag 2026-06 踩過),SELECT 不能省。
-- 🔴 storage.objects / storage.buckets 不能用 SQL 刪資料(protect_delete trigger 會擋,42501)。
--    還原只拆 policy 與函式;bucket 本身要清空後用 Storage API 刪(見 supabase/rollbacks/20261009120100_market_images_storage.down.sql)。
-- 測試:supabase/tests/database/market_images_storage.test.sql
-- =====================================================================

SET LOCAL lock_timeout = '3s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('market-images', 'market-images', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
   SET public = EXCLUDED.public,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 物件路徑合不合規、是不是自家的資料夾(CASE 保證格式不對時不會去轉 uuid)
CREATE OR REPLACE FUNCTION public.market_image_object_ok(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_name ~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                   || '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|store)/'
                   || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_t)?\.(jpg|jpeg|png|webp)$')
      THEN split_part(p_name, '/', 1)::uuid IN (SELECT public.current_supplier_ids())
    ELSE false
  END
$$;

REVOKE ALL ON FUNCTION public.market_image_object_ok(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.market_image_object_ok(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "market images supplier select" ON storage.objects;
CREATE POLICY "market images supplier select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'market-images' AND public.market_image_object_ok(name));

DROP POLICY IF EXISTS "market images supplier insert" ON storage.objects;
CREATE POLICY "market images supplier insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'market-images' AND public.market_image_object_ok(name));

DROP POLICY IF EXISTS "market images supplier update" ON storage.objects;
CREATE POLICY "market images supplier update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'market-images' AND public.market_image_object_ok(name))
  WITH CHECK (bucket_id = 'market-images' AND public.market_image_object_ok(name));

DROP POLICY IF EXISTS "market images supplier delete" ON storage.objects;
CREATE POLICY "market images supplier delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'market-images' AND public.market_image_object_ok(name));
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009120100_market_images_storage.sql`

Expected:`…共 17 項,失敗 0 項`;殘留檢查五個 `0`(`fixture_objects` 也要是 0)。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009120100_market_images_storage.sql supabase/tests/database/market_images_storage.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 商品照片 Storage bucket market-images 與只准自家寫入的 policy(migration 120100)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 7:migration 120100 的還原檔

只拆 policy 與函式;bucket 不能用 SQL 刪(還原檔開頭寫了 Dashboard 的做法)。

**Files:**
- Create: `supabase/rollbacks/20261009120100_market_images_storage.down.sql`
- Test: `supabase/tests/database/market_images_storage_rollback.test.sql`

**Step 1:寫失敗的測試**

```sql
-- 20261009120100 的還原檔:policy 與函式拆掉,bucket 留著(SQL 刪不掉,要用 Storage API)
SELECT pg_temp.expect('還原後 market images policy 都不在',
  (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'market images%'), '0');
SELECT pg_temp.expect('還原後路徑函式不在',
  (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'market_image_object_ok'), '0');
SELECT pg_temp.expect('bucket 還在(要用 Storage API 刪)',
  (SELECT count(*)::text FROM storage.buckets WHERE id = 'market-images'), '1');
```

**Step 2:跑測試,確認失敗(不套還原檔)**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009120100_market_images_storage.sql`

Expected:`…共 3 項,失敗 2 項`(policy 還有 4 條、路徑函式還在);exit 1。

**Step 3:寫還原檔**

```sql
-- =====================================================================
-- 還原 20261009120100_market_images_storage:只拆 policy 與函式。
-- 🔴 bucket 不能用 SQL 刪(storage.protect_delete 會擋)。真的要刪 bucket:
--    1. Supabase Dashboard → Storage → market-images 把檔案清空
--    2. DELETE https://cwvpehqcvbfuynabpqop.supabase.co/storage/v1/bucket/market-images(帶 service_role key;業主在 Dashboard 操作)
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "market images supplier select" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier insert" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier update" ON storage.objects;
DROP POLICY IF EXISTS "market images supplier delete" ON storage.objects;
DROP FUNCTION IF EXISTS public.market_image_object_ok(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009120100';
```

**Step 4:跑測試,確認通過**

Run:同 Step 2,最後加 `--with-rollback supabase/rollbacks/20261009120100_market_images_storage.down.sql`。Expected:`…共 3 項,失敗 0 項`;殘留檢查五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/rollbacks/20261009120100_market_images_storage.down.sql supabase/tests/database/market_images_storage_rollback.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): migration 120100 還原檔與還原測試

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 8:前端常數(縣市、分類、溫層、付款方式、長度上限)

前端唯一的出處;測試直接解析 migration 120000 的 `@market-cities` / `@market-categories` / `@market-temperatures` 標記比對,改一邊忘了改另一邊測試就會紅。

**Files:**
- Create: `src/lib/market/constants.ts`
- Test: `src/lib/market/constants.test.ts`

**Step 1:寫失敗的測試**

```ts
// 前端的縣市、分類、溫層必須跟資料庫一字不差:直接解析 migration 標記之間的字串比對。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKET_CATEGORIES, TEMPERATURE_KEYS, TW_CITIES, isCategoryKey, isTemperature, isTwCity } from "./constants";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../../supabase/migrations/20261009120000_market_catalog.sql"),
  "utf8",
);

/** migration 裡「單獨一行」的 -- @name-begin 到 -- @name-end 之間所有單引號字串 */
const quotedBetween = (name: string): string[] => {
  const begin = MIGRATION.search(new RegExp(`^\\s*-- @${name}-begin\\s*$`, "m"));
  const end = MIGRATION.search(new RegExp(`^\\s*-- @${name}-end\\s*$`, "m"));
  expect(begin, `${name}-begin`).toBeGreaterThan(-1);
  expect(end, `${name}-end`).toBeGreaterThan(begin);
  return [...MIGRATION.slice(begin, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("市集常數與 migration 一致", () => {
  it("22 縣市,順序與寫法跟 market_tw_cities() 一樣", () => {
    expect(TW_CITIES).toHaveLength(22);
    expect([...TW_CITIES]).toEqual(quotedBetween("market-cities"));
  });

  it("12 個分類 key 跟 market_products 的 CHECK 一樣", () => {
    expect(MARKET_CATEGORIES.map((c) => c.key)).toEqual(quotedBetween("market-categories"));
  });

  it("溫層 key 跟 CHECK 一樣", () => {
    expect(TEMPERATURE_KEYS).toEqual(quotedBetween("market-temperatures"));
  });

  it("型別守衛只認清單裡的值", () => {
    expect(isTwCity("臺北市")).toBe(true);
    expect(isTwCity("台北市")).toBe(false);
    expect(isCategoryKey("meat")).toBe(true);
    expect(isCategoryKey("alcohol")).toBe(false);
    expect(isTemperature("frozen")).toBe(true);
    expect(isTemperature(null)).toBe(false);
  });

  it("飲品分類標明不含酒(市集不賣酒)", () => {
    expect(MARKET_CATEGORIES.find((c) => c.key === "drink")?.label).toBe("飲品（不含酒）");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/constants.test.ts`

Expected:FAIL,`Failed to resolve import "./constants" from "src/lib/market/constants.test.ts". Does the file exist?`

**Step 3:寫實作**

```ts
// 消費者食材市集的固定清單與長度上限 —— 前端唯一的出處。
//
// 🔴 縣市、分類、溫層跟資料庫的 CHECK / 函式一字不差:constants.test.ts 會解析
//    supabase/migrations/20261009120000_market_catalog.sql 的 @market-*-begin … @market-*-end 比對,改一邊一定要改另一邊。
// 長度與金額上限也跟資料庫的 CHECK 一樣(資料庫才是最後一道關卡,這裡讓使用者在送出前就知道)。

export const TW_CITIES = [
  "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市",
  "基隆市", "新竹市", "嘉義市",
  "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣",
  "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
] as const;
export type TwCity = (typeof TW_CITIES)[number];
export const isTwCity = (v: unknown): v is TwCity =>
  typeof v === "string" && (TW_CITIES as readonly string[]).includes(v);

/** 12 類,順序與圖示跟形象站首頁「食材分類」一樣(landing/i18n.js home.data.categories、landing/index.html CATEGORY_IMGS) */
export const MARKET_CATEGORIES = [
  { key: "vegetable", label: "蔬菜" },
  { key: "fruit", label: "水果" },
  { key: "seafood", label: "海鮮" },
  { key: "meat", label: "肉品" },
  { key: "egg", label: "蛋品" },
  { key: "grain", label: "五穀雜糧" },
  { key: "grocery", label: "南北雜貨" },
  { key: "processed", label: "加工食品" },
  { key: "hotpot", label: "火鍋料" },
  { key: "condiment", label: "調味品" },
  // 形象站叫「酒與飲品」;市集不賣酒(菸酒管理法第 30 條:不得以電子購物等無法辨識年齡的方式賣酒)
  { key: "drink", label: "飲品（不含酒）" },
  { key: "packaging", label: "包材耗材" },
] as const;
export type MarketCategoryKey = (typeof MARKET_CATEGORIES)[number]["key"];
export const CATEGORY_LABEL = Object.fromEntries(MARKET_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  MarketCategoryKey,
  string
>;
export const isCategoryKey = (v: unknown): v is MarketCategoryKey =>
  typeof v === "string" && MARKET_CATEGORIES.some((c) => c.key === v);

export const TEMPERATURES = { ambient: "常溫", chilled: "冷藏", frozen: "冷凍" } as const;
export type Temperature = keyof typeof TEMPERATURES;
export const TEMPERATURE_KEYS = Object.keys(TEMPERATURES) as Temperature[];
export const isTemperature = (v: unknown): v is Temperature =>
  typeof v === "string" && (TEMPERATURE_KEYS as string[]).includes(v);

export const PAYMENT_METHODS = { cod: "貨到付款", transfer: "銀行轉帳" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export type ReviewStatus = "draft" | "pending" | "approved" | "rejected";
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: "草稿",
  pending: "待審",
  approved: "已核准",
  rejected: "退回",
};

/** 跟 migration 的 CHECK 一樣 */
export const LIMITS = {
  productName: 60,
  spec: 40,
  origin: 40,
  storageMethod: 100,
  shelfLife: 40,
  description: 2000,
  rejectReason: 300,
  storeIntro: 1000,
  returnPolicy: 1000,
  transferInfoMin: 5,
  transferInfo: 300,
  disabledReason: 300,
  price: 1_000_000,
  stock: 100_000,
  shippingFee: 10_000,
  freeShippingThreshold: 1_000_000,
  minOrderAmount: 1_000_000,
  shipDays: 30,
} as const;

export const PHOTO_RULES = {
  /** 每個商品最多幾張照片(資料庫 CHECK cardinality(photos) <= 5) */
  maxCount: 5,
  /** 上傳到 Storage 的檔案上限(bucket file_size_limit) */
  maxBytes: 2 * 1024 * 1024,
  /** 原始檔上限:手機照片 3–8 MB 很正常,先在瀏覽器壓縮;超過 15 MB 直接拒絕,避免手機記憶體爆掉 */
  maxInputBytes: 15 * 1024 * 1024,
  longSide: 1600,
  thumbLongSide: 480,
  inputTypes: ["image/jpeg", "image/png", "image/webp"],
} as const;

export const MARKET_IMAGE_BUCKET = "market-images";
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  5 passed (5)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/constants.ts src/lib/market/constants.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 前端常數(縣市、分類、溫層、上限),vitest 對照 migration 標記

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 9:分類圖示沿用形象站的 `cat-*.svg`

直接 import `landing/assets/cat-<key>.svg`(跟形象站首頁「食材分類」同一組圖,順序也一樣)。測試檢查 12 類都有圖、檔案真的存在。

**Files:**
- Create: `src/lib/market/categoryIcons.ts`
- Test: `src/lib/market/categoryIcons.test.ts`

**Step 1:寫失敗的測試**

```ts
// 12 個分類都有圖示,而且引用的是形象站的那一份 SVG(檔案真的存在、檔名對得上)。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_ICON } from "./categoryIcons";
import { MARKET_CATEGORIES } from "./constants";

describe("分類圖示", () => {
  it("每個分類都有一個非空的圖示網址", () => {
    for (const c of MARKET_CATEGORIES) {
      expect(typeof CATEGORY_ICON[c.key], c.key).toBe("string");
      expect(CATEGORY_ICON[c.key].length, c.key).toBeGreaterThan(0);
    }
  });

  it("圖示檔就是形象站 landing/assets/cat-<key>.svg", () => {
    for (const c of MARKET_CATEGORIES) {
      expect(existsSync(resolve(__dirname, `../../../landing/assets/cat-${c.key}.svg`)), c.key).toBe(true);
      expect(CATEGORY_ICON[c.key]).toMatch(new RegExp(`cat-${c.key}\\.svg|^data:image/svg\\+xml`));
    }
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/categoryIcons.test.ts`

Expected:FAIL,`Failed to resolve import "./categoryIcons"`

**Step 3:寫實作**

```ts
// 分類圖示:直接引用形象站的 SVG(landing/assets/cat-*.svg),不複製檔案 —— 圖只有一份來源。
// Vite 建置時這些檔案(都小於 4 KB)會被內聯成 data URI;vitest 裡拿到的是檔案路徑字串。
// ⚠️ 只改 landing/ 的 commit 不會重建產品站(vercel.json 的 ignoreCommand、deploy-vercel.yml 的 paths-ignore),
//    改了圖示要等下一次產品站部署才會換上。
import condiment from "../../../landing/assets/cat-condiment.svg";
import drink from "../../../landing/assets/cat-drink.svg";
import egg from "../../../landing/assets/cat-egg.svg";
import fruit from "../../../landing/assets/cat-fruit.svg";
import grain from "../../../landing/assets/cat-grain.svg";
import grocery from "../../../landing/assets/cat-grocery.svg";
import hotpot from "../../../landing/assets/cat-hotpot.svg";
import meat from "../../../landing/assets/cat-meat.svg";
import packaging from "../../../landing/assets/cat-packaging.svg";
import processed from "../../../landing/assets/cat-processed.svg";
import seafood from "../../../landing/assets/cat-seafood.svg";
import vegetable from "../../../landing/assets/cat-vegetable.svg";
import type { MarketCategoryKey } from "./constants";

export const CATEGORY_ICON: Record<MarketCategoryKey, string> = {
  vegetable,
  fruit,
  seafood,
  meat,
  egg,
  grain,
  grocery,
  processed,
  hotpot,
  condiment,
  drink,
  packaging,
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  2 passed (2)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/categoryIcons.ts src/lib/market/categoryIcons.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 分類圖示直接沿用形象站 landing/assets/cat-*.svg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 10:型別與資料存取入口 `db.ts`

`marketDb()` / `marketRpc()` / `marketStorage()`(loose cast,不用 `any`)、`MarketDbError`(帶 SQLSTATE 與 snake_case hint)、`friendlyDbError()`(hint → 中文;第 2 階段的訂單 hint 也先列在這裡)、`newUuid()`。

**Files:**
- Create: `src/lib/market/types.ts`
- Create: `src/lib/market/db.ts`
- Test: `src/lib/market/db.test.ts`

**Step 1:寫失敗的測試**

```ts
// db.ts:錯誤會帶出 code / hint,hint 會翻成中文;uuid 工具。supabase 換成假的,不打網路。
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (fn: string) =>
      fn === "boom"
        ? { data: null, error: { message: "new row violates", code: "22023", hint: "transfer_info_required" } }
        : { data: { ok: true }, error: null },
  },
}));

import { friendlyDbError, isUuid, MarketDbError, marketRpc, newUuid, unwrap } from "./db";

describe("unwrap / marketRpc", () => {
  it("沒錯就回 data", async () => {
    expect(unwrap({ data: [1], error: null })).toEqual([1]);
    await expect(marketRpc("ok", {})).resolves.toEqual({ ok: true });
  });

  it("有錯丟 MarketDbError,帶 code 與 hint", async () => {
    const err = await marketRpc("boom", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketDbError);
    expect((err as MarketDbError).code).toBe("22023");
    expect((err as MarketDbError).hint).toBe("transfer_info_required");
  });
});

describe("friendlyDbError", () => {
  it("認得的 hint 翻成中文", () => {
    expect(friendlyDbError(new MarketDbError({ message: "x", hint: "review_status_forbidden" }))).toBe(
      "商品要經過管理員審核才能上架",
    );
  });

  it("外鍵錯誤 = 還沒建店家;CHECK 錯誤 = 欄位格式", () => {
    expect(friendlyDbError(new MarketDbError({ message: "fk", code: "23503" }))).toMatch(/店家設定/);
    expect(friendlyDbError(new MarketDbError({ message: "check", code: "23514" }))).toMatch(/長度上限或格式/);
  });

  it("不認得的照原文、一般 Error 照 message", () => {
    expect(friendlyDbError(new MarketDbError({ message: "原文" }))).toBe("原文");
    expect(friendlyDbError(new Error("一般錯誤"))).toBe("一般錯誤");
  });
});

describe("uuid", () => {
  it("newUuid 產生合法的 v4 uuid,isUuid 認得", () => {
    const id = newUuid();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("4");
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/db.test.ts`

Expected:FAIL,`Failed to resolve import "./db"`

**Step 3:寫實作**

`src/lib/market/types.ts`:

```ts
// market_* 資料表在前端用到的形狀(型別沒有進 src/integrations/supabase/types.ts,這裡手寫一份)。
// 欄位定義的唯一來源是 supabase/migrations/20261009120000_market_catalog.sql。
import type { MarketCategoryKey, PaymentMethod, ReviewStatus, Temperature, TwCity } from "./constants";

/** PostgREST 嵌入的 suppliers(name, phone, contact_email, is_active) —— suppliers 本來就是公開表 */
export interface MarketSupplierEmbed {
  name: string;
  phone: string | null;
  contact_email: string | null;
  is_active?: boolean | null;
}

export interface MarketStoreRow {
  supplier_id: string;
  is_enabled: boolean;
  disabled_reason?: string | null;
  logo_path: string | null;
  cover_path: string | null;
  intro: string | null;
  return_policy: string | null;
  delivery_cities: TwCity[];
  shipping_fee: number;
  free_shipping_threshold: number | null;
  min_order_amount: number;
  ship_days: number;
  payment_methods: PaymentMethod[];
  updated_at?: string;
  suppliers?: MarketSupplierEmbed | null;
}

export interface MarketProductRow {
  id: string;
  supplier_id: string;
  supply_id?: string | null;
  name: string;
  category: MarketCategoryKey;
  spec: string;
  price: number;
  stock: number | null;
  temperature: Temperature;
  origin: string | null;
  storage_method: string | null;
  shelf_life: string | null;
  description: string | null;
  photos: string[];
  review_status: ReviewStatus;
  reject_reason?: string | null;
  is_listed: boolean;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at?: string;
  market_stores?: MarketStoreRow | null;
}
```

`src/lib/market/db.ts`:

```ts
// 零售市集的資料存取入口:所有 market_* 表、RPC、Storage 都經過這裡。
//
// market_* 表不在自動產生的 src/integrations/supabase/types.ts 裡 —— 沿用專案的 loose cast 慣例
// (src/pages/SupplierDetail.tsx 的 db()、src/lib/portal.ts 的 fetchAccounts),只描述用得到的 builder,不用 any。
// PostgREST 的 builder 是 thenable、沒有 .catch():一律 await 之後用 unwrap() 收錯。
import { supabase } from "@/integrations/supabase/client";
import { MARKET_IMAGE_BUCKET } from "./constants";

export type PgError = { message: string; code?: string | null; hint?: string | null; details?: string | null } | null;
export type PgResult<T> = { data: T | null; error: PgError };

export interface MarketQuery<T> extends PromiseLike<PgResult<T>> {
  select(columns?: string): MarketQuery<T>;
  insert(values: unknown): MarketQuery<T>;
  update(values: unknown): MarketQuery<T>;
  upsert(values: unknown, options?: { onConflict?: string }): MarketQuery<T>;
  delete(): MarketQuery<T>;
  eq(column: string, value: unknown): MarketQuery<T>;
  in(column: string, values: readonly unknown[]): MarketQuery<T>;
  order(column: string, options: { ascending: boolean }): MarketQuery<T>;
  limit(count: number): MarketQuery<T>;
  maybeSingle(): PromiseLike<PgResult<T>>;
  single(): PromiseLike<PgResult<T>>;
}

export const marketDb = <T>(table: string): MarketQuery<T> =>
  (supabase as never as { from: (t: string) => MarketQuery<T> }).from(table);

/** 資料庫擋下來的錯誤:hint 是 migration 裡 RAISE 的 snake_case 原因(見 friendlyDbError) */
export class MarketDbError extends Error {
  readonly code: string | null;
  readonly hint: string | null;
  constructor(error: NonNullable<PgError>) {
    super(error.message || "資料庫錯誤");
    this.name = "MarketDbError";
    this.code = error.code ?? null;
    this.hint = error.hint ?? null;
  }
}

export const unwrap = <T>(res: PgResult<T>): T => {
  if (res.error) throw new MarketDbError(res.error);
  return res.data as T;
};

export const marketRpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
  unwrap(
    await (supabase as never as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<PgResult<T>> }).rpc(
      fn,
      args,
    ),
  );

export interface StorageBucket {
  upload(
    path: string,
    body: Blob,
    options: { contentType: string; cacheControl: string; upsert: boolean },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export const marketStorage = (): StorageBucket =>
  (supabase as never as { storage: { from: (bucket: string) => StorageBucket } }).storage.from(MARKET_IMAGE_BUCKET);

/** migration 裡 RAISE 的 HINT → 給使用者看的中文 */
const HINT_MESSAGES: Record<string, string> = {
  transfer_info_required: "接受銀行轉帳要先填寫轉帳資訊",
  invalid_image_path: "圖片路徑不正確,請重新上傳",
  invalid_photo_path: "商品照片路徑不正確,請重新上傳",
  review_status_forbidden: "商品要經過管理員審核才能上架",
  supply_not_owned: "對應的批發商品不是你家的",
  reject_reason_required: "退回或下架要填寫原因",
  disabled_reason_required: "停用店家零售要填寫原因",
  supplier_immutable: "不能更改所屬的店家",
  stale_order_status: "這張訂單剛被處理過,畫面已重新整理,請再確認一次",
  transition_not_allowed: "這張訂單目前不能做這個動作",
  reason_required: "請填寫原因(會告知消費者)",
  carrier_required: "請填寫物流",
  tracking_too_long: "物流單號太長了",
  not_order_party: "這張訂單不是你家的",
  one_event_per_order: "請一步一步操作",
};

export const friendlyDbError = (e: unknown): string => {
  if (e instanceof MarketDbError) {
    if (e.hint && HINT_MESSAGES[e.hint]) return HINT_MESSAGES[e.hint];
    if (e.code === "23503") return "請先完成「零售市集 › 店家設定」再新增零售商品";
    if (e.code === "23514") return "有欄位超過長度上限或格式不對,請檢查後再送出";
    if (e.code === "42501") return "沒有權限做這個動作";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** 瀏覽器產生 uuid(新商品先決定 id,照片才能先上傳到 <supplier>/<商品 id>/) */
export const newUuid = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  6 passed (6)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/types.ts src/lib/market/db.ts src/lib/market/db.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): market_* 型別與資料存取入口(marketDb、錯誤轉中文)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 11:顯示用格式(金額、運費、最低金額、出貨、配送、庫存、台北時間)

**Files:**
- Create: `src/lib/market/format.ts`
- Test: `src/lib/market/format.test.ts`

**Step 1:寫失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { TW_CITIES } from "./constants";
import {
  citiesSummary,
  formatTaipei,
  formatTwd,
  minOrderSummary,
  shipDaysSummary,
  shippingSummary,
  stockLabel,
} from "./format";

describe("format", () => {
  it("金額:NT$ 加千分位", () => {
    expect(formatTwd(3200)).toBe("NT$ 3,200");
    expect(formatTwd(0)).toBe("NT$ 0");
  });

  it("運費:免運、固定運費、滿額免運", () => {
    expect(shippingSummary({ shipping_fee: 0, free_shipping_threshold: null })).toBe("免運費");
    expect(shippingSummary({ shipping_fee: 120, free_shipping_threshold: null })).toBe("運費 NT$ 120");
    expect(shippingSummary({ shipping_fee: 120, free_shipping_threshold: 1000 })).toBe("運費 NT$ 120,滿 NT$ 1,000 免運");
  });

  it("最低訂購金額與出貨天數", () => {
    expect(minOrderSummary({ min_order_amount: 0 })).toBe("沒有最低訂購金額");
    expect(minOrderSummary({ min_order_amount: 300 })).toBe("滿 NT$ 300 才能下單");
    expect(shipDaysSummary(0)).toBe("當天出貨");
    expect(shipDaysSummary(2)).toBe("2 個工作天內出貨");
  });

  it("配送縣市:22 個全選就寫全台配送", () => {
    expect(citiesSummary(["臺北市", "新北市"])).toBe("臺北市、新北市");
    expect(citiesSummary(TW_CITIES)).toBe("全台配送");
  });

  it("庫存:不限、售完、剩幾件", () => {
    expect(stockLabel(null)).toBe("現貨");
    expect(stockLabel(0)).toBe("已售完");
    expect(stockLabel(3)).toBe("剩 3 件");
    expect(stockLabel(30)).toBe("現貨");
  });

  it("台北時間", () => {
    expect(formatTaipei("2026-10-09T04:05:00Z")).toBe("2026/10/09 12:05");
    expect(formatTaipei(null)).toBe("—");
    expect(formatTaipei("壞掉")).toBe("—");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/format.test.ts`

Expected:FAIL,`Failed to resolve import "./format"`

**Step 3:寫實作**

```ts
// 市集畫面上的顯示文字(金額、運費、配送、庫存)—— 純函式,format.test.ts 測。
import { TW_CITIES } from "./constants";
import type { MarketStoreRow } from "./types";

/** NT$ 3,200(跟 supabase/functions/notify/render.ts 的 money() 同一種寫法) */
export const formatTwd = (n: number): string => `NT$ ${Number(n).toLocaleString("zh-TW")}`;

export const shippingSummary = (store: Pick<MarketStoreRow, "shipping_fee" | "free_shipping_threshold">): string => {
  if (store.shipping_fee === 0) return "免運費";
  const base = `運費 ${formatTwd(store.shipping_fee)}`;
  return store.free_shipping_threshold != null ? `${base},滿 ${formatTwd(store.free_shipping_threshold)} 免運` : base;
};

export const minOrderSummary = (store: Pick<MarketStoreRow, "min_order_amount">): string =>
  store.min_order_amount > 0 ? `滿 ${formatTwd(store.min_order_amount)} 才能下單` : "沒有最低訂購金額";

export const shipDaysSummary = (days: number): string => (days === 0 ? "當天出貨" : `${days} 個工作天內出貨`);

export const citiesSummary = (cities: readonly string[]): string =>
  cities.length >= TW_CITIES.length ? "全台配送" : cities.join("、");

/** 庫存顯示:不限 → 現貨;0 → 已售完;5 件以下顯示剩幾件 */
export const stockLabel = (stock: number | null): string => {
  if (stock === null) return "現貨";
  if (stock <= 0) return "已售完";
  return stock <= 5 ? `剩 ${stock} 件` : "現貨";
};

/** 台北時間「2026/10/09 12:05」(後台、查詢頁用)。用 formatToParts 自己拼,不同瀏覽器的分隔字元才會一致 */
export const formatTaipei = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  6 passed (6)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/format.ts src/lib/market/format.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 市集顯示用格式(金額、運費、配送、庫存、台北時間)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 12:公開目錄查詢與首頁篩選 `catalog.ts`(+ 測試用假資料)

查詢一律再篩一次 `isPubliclyVisible`(登入中的供應商 / 管理員透過 RLS 看得到自家草稿,但市集上不能出現);篩選條件放網址 `?q=&cat=&city=&temp=`。`testFixtures.ts` 的金額跟資料庫測試同一組(A 店運費 120、滿 1000 免運、最低 300;B 店運費 60),之後的前端測試都用它。

**Files:**
- Create: `src/lib/market/testFixtures.ts`
- Create: `src/lib/market/catalog.ts`
- Test: `src/lib/market/catalog.test.ts`

**Step 1:寫失敗的測試**

```ts
// catalog.ts:公開查詢帶對篩選條件、再篩一次可見性;首頁篩選、精選店家。supabase 換成記錄查詢的假物件。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, rows } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; select: string; filters: Array<[string, string, unknown]> }>,
  rows: { value: [] as unknown[] },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, select: "", filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const result = () => Promise.resolve({ data: rows.value, error: null });
      const builder = {
        select: (c: string) => {
          call.select = c;
          return builder;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push(["eq", c, v]);
          return builder;
        },
        order: (c: string, o: { ascending: boolean }) => {
          call.filters.push(["order", c, o.ascending]);
          return builder;
        },
        limit: (n: number) => {
          call.filters.push(["limit", "limit", n]);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: rows.value[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => result().then(ok, bad),
      };
      return builder;
    },
  },
}));

import {
  featuredStores,
  fetchListedProducts,
  fetchMarketProduct,
  fetchStoreProducts,
  filterProducts,
  filtersFromParams,
  isPubliclyVisible,
  paramsFromFilters,
} from "./catalog";
import { BEEF, CABBAGE, SALMON, STORE_A, STORE_B, SUPPLIER_A, makeProduct } from "./testFixtures";

beforeEach(() => {
  calls.length = 0;
  rows.value = [];
});

describe("公開查詢", () => {
  it("首頁只抓已核准、上架中的商品,並嵌入店家與供應商名稱", async () => {
    rows.value = [CABBAGE, makeProduct({ market_stores: { ...STORE_A, is_enabled: false } })];
    const list = await fetchListedProducts();
    expect(calls[0].table).toBe("market_products");
    expect(calls[0].select).toContain("market_stores(");
    expect(calls[0].select).toContain("suppliers(name, phone, contact_email, is_active)");
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        ["eq", "review_status", "approved"],
        ["eq", "is_listed", true],
        ["limit", "limit", 500],
      ]),
    );
    // 登入中的供應商看得到自家停用店家的商品,但市集上不能出現
    expect(list.map((p) => p.id)).toEqual([CABBAGE.id]);
  });

  it("商品 id 不是 uuid 就不查", async () => {
    await expect(fetchMarketProduct("abc")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("店家頁只抓那一家的商品", async () => {
    rows.value = [CABBAGE];
    await fetchStoreProducts(SUPPLIER_A);
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "supplier_id", SUPPLIER_A]]));
  });
});

describe("isPubliclyVisible", () => {
  it("已核准 + 上架中 + 店家啟用 + 供應商啟用才算", () => {
    expect(isPubliclyVisible(CABBAGE)).toBe(true);
    expect(isPubliclyVisible({ ...CABBAGE, review_status: "pending" })).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, is_listed: false })).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, market_stores: { ...STORE_A, is_enabled: false } })).toBe(false);
    expect(
      isPubliclyVisible({
        ...CABBAGE,
        market_stores: { ...STORE_A, suppliers: { name: "x", phone: null, contact_email: null, is_active: false } },
      }),
    ).toBe(false);
    expect(isPubliclyVisible({ ...CABBAGE, market_stores: null })).toBe(false);
  });
});

describe("首頁篩選", () => {
  const all = [CABBAGE, BEEF, SALMON];
  const base = { q: "", category: null, city: null, temperature: null };

  it("網址參數 ↔ 篩選條件;不認得的值丟掉", () => {
    const f = filtersFromParams(new URLSearchParams("q=高麗&cat=meat&city=臺北市&temp=frozen"));
    expect(f).toEqual({ q: "高麗", category: "meat", city: "臺北市", temperature: "frozen" });
    expect(filtersFromParams(new URLSearchParams("cat=alcohol&city=台北市&temp=hot"))).toEqual(base);
    expect(paramsFromFilters({ ...base, category: "meat" }).toString()).toBe("cat=meat");
  });

  it("分類、溫層", () => {
    expect(filterProducts(all, { ...base, category: "meat" }).map((p) => p.name)).toEqual(["牛肉片"]);
    expect(filterProducts(all, { ...base, temperature: "frozen" }).map((p) => p.name)).toEqual(["牛肉片", "挪威鮭魚"]);
  });

  it("配送縣市:只留配送到那裡的店家的商品", () => {
    expect(filterProducts(all, { ...base, city: "新北市" }).map((p) => p.name)).toEqual(["有機高麗菜", "牛肉片"]);
  });

  it("搜尋:不分大小寫、忽略空白,也搜規格、產地、分類、店名", () => {
    expect(filterProducts(all, { ...base, q: "高 麗" }).map((p) => p.name)).toEqual(["有機高麗菜"]);
    expect(filterProducts(all, { ...base, q: "宜蘭" }).map((p) => p.name)).toEqual(["有機高麗菜"]);
    expect(filterProducts(all, { ...base, q: "海鮮" }).map((p) => p.name)).toEqual(["挪威鮭魚"]);
    expect(filterProducts(all, { ...base, q: "B 店" }).map((p) => p.name)).toEqual(["挪威鮭魚"]);
  });

  it("精選店家:商品多的排前面;選了縣市只留配送到那裡的店", () => {
    expect(featuredStores(all, null).map((s) => [s.name, s.productCount])).toEqual([
      ["市集測試 A 店", 2],
      ["市集測試 B 店", 1],
    ]);
    expect(featuredStores(all, "新北市").map((s) => s.supplierId)).toEqual([STORE_A.supplier_id]);
    expect(featuredStores(all, null, 1)).toHaveLength(1);
    expect(featuredStores([SALMON], null)[0].deliveryCities).toEqual(STORE_B.delivery_cities);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/catalog.test.ts`

Expected:FAIL,`Failed to resolve import "./catalog"`

**Step 3:寫實作**

`src/lib/market/testFixtures.ts`(只給測試用):

```ts
// 市集測試共用的假資料(只給 *.test.ts(x) 用,正式程式不會 import)。
// 金額刻意跟資料庫測試同一組:A 店運費 120、滿 1000 免運、最低 300;B 店運費 60、沒有免運、沒有最低金額。
import type { MarketProductRow, MarketStoreRow } from "./types";

export const SUPPLIER_A = "a9200000-0000-4000-8000-00000000000a";
export const SUPPLIER_B = "a9200000-0000-4000-8000-00000000000b";

export const STORE_A: MarketStoreRow = {
  supplier_id: SUPPLIER_A,
  is_enabled: true,
  logo_path: null,
  cover_path: null,
  intro: "當日採收的葉菜與根莖類",
  return_policy: "生鮮食品收到後 24 小時內有問題請拍照聯絡我們",
  delivery_cities: ["臺北市", "新北市"],
  shipping_fee: 120,
  free_shipping_threshold: 1000,
  min_order_amount: 300,
  ship_days: 2,
  payment_methods: ["cod", "transfer"],
  suppliers: { name: "市集測試 A 店", phone: "02-2345-6789", contact_email: "store-a@market-test.invalid", is_active: true },
};

export const STORE_B: MarketStoreRow = {
  supplier_id: SUPPLIER_B,
  is_enabled: true,
  logo_path: null,
  cover_path: null,
  intro: null,
  return_policy: null,
  delivery_cities: ["臺北市"],
  shipping_fee: 60,
  free_shipping_threshold: null,
  min_order_amount: 0,
  ship_days: 1,
  payment_methods: ["cod"],
  suppliers: { name: "市集測試 B 店", phone: null, contact_email: "store-b@market-test.invalid", is_active: true },
};

let seq = 0;
export const makeProduct = (over: Partial<MarketProductRow> = {}): MarketProductRow => {
  seq += 1;
  return {
    id: `a9300000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    supplier_id: SUPPLIER_A,
    name: `測試商品 ${seq}`,
    category: "vegetable",
    spec: "1 包",
    price: 100,
    stock: null,
    temperature: "ambient",
    origin: null,
    storage_method: null,
    shelf_life: null,
    description: null,
    photos: [],
    review_status: "approved",
    is_listed: true,
    created_at: "2026-10-09T02:00:00Z",
    market_stores: STORE_A,
    ...over,
  };
};

/** A 店:高麗菜 100(庫存 10)、牛肉片 450(不限);B 店:鮭魚 200(庫存 3,冷凍) */
export const CABBAGE = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000a1",
  name: "有機高麗菜",
  spec: "1 顆(約 1.2 公斤)",
  price: 100,
  stock: 10,
  temperature: "chilled",
  origin: "宜蘭三星",
});
export const BEEF = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000a2",
  name: "牛肉片",
  category: "meat",
  spec: "300g/盒",
  price: 450,
  stock: null,
  temperature: "frozen",
});
export const SALMON = makeProduct({
  id: "a9300000-0000-4000-8000-0000000000b1",
  supplier_id: SUPPLIER_B,
  name: "挪威鮭魚",
  category: "seafood",
  spec: "200g/片",
  price: 200,
  stock: 3,
  temperature: "frozen",
  market_stores: STORE_B,
});
```

`src/lib/market/catalog.ts`:

```ts
// 市集的公開查詢(商品、店家)與首頁篩選 —— 篩選是純函式,catalog.test.ts 測。
//
// 對 anon 來說「看得到什麼」由資料庫 RLS 決定(已核准 + 上架中 + 店家零售啟用 + 供應商啟用中);
// 但登入中的供應商 / 管理員另外看得到自家或全部的草稿,所以查詢一律再篩一次 isPubliclyVisible —— 市集上不會出現沒上架的東西。
import {
  CATEGORY_LABEL,
  isCategoryKey,
  isTemperature,
  isTwCity,
  type MarketCategoryKey,
  type Temperature,
  type TwCity,
} from "./constants";
import { isUuid, marketDb, unwrap } from "./db";
import type { MarketProductRow, MarketStoreRow } from "./types";

export const STORE_PUBLIC_COLUMNS =
  "supplier_id, is_enabled, logo_path, cover_path, intro, return_policy, delivery_cities, shipping_fee, " +
  "free_shipping_threshold, min_order_amount, ship_days, payment_methods, suppliers(name, phone, contact_email, is_active)";

export const PRODUCT_PUBLIC_COLUMNS =
  "id, supplier_id, name, category, spec, price, stock, temperature, origin, storage_method, shelf_life, " +
  "description, photos, review_status, is_listed, created_at";

const PRODUCT_WITH_STORE = `${PRODUCT_PUBLIC_COLUMNS}, market_stores(${STORE_PUBLIC_COLUMNS})`;

/** 首頁一次最多抓幾筆(上架商品多到這個數字時,要改成伺服器端搜尋 —— 見計畫「風險」) */
export const LISTING_LIMIT = 500;

export const isStoreOpen = (store: MarketStoreRow | null | undefined): boolean =>
  !!store && store.is_enabled && store.suppliers?.is_active !== false;

export const isPubliclyVisible = (p: MarketProductRow): boolean =>
  p.review_status === "approved" && p.is_listed && isStoreOpen(p.market_stores);

export const fetchListedProducts = async (): Promise<MarketProductRow[]> =>
  unwrap(
    await marketDb<MarketProductRow[]>("market_products")
      .select(PRODUCT_WITH_STORE)
      .eq("review_status", "approved")
      .eq("is_listed", true)
      .order("created_at", { ascending: false })
      .limit(LISTING_LIMIT),
  ).filter(isPubliclyVisible);

/** 單一商品(不篩可見性:供應商、管理員要能預覽自己的草稿;頁面自己用 isPubliclyVisible 決定要不要標「預覽」) */
export const fetchMarketProduct = async (id: string): Promise<MarketProductRow | null> => {
  if (!isUuid(id)) return null;
  return unwrap(await marketDb<MarketProductRow>("market_products").select(PRODUCT_WITH_STORE).eq("id", id).maybeSingle());
};

export const fetchMarketStore = async (supplierId: string): Promise<MarketStoreRow | null> => {
  if (!isUuid(supplierId)) return null;
  return unwrap(
    await marketDb<MarketStoreRow>("market_stores").select(STORE_PUBLIC_COLUMNS).eq("supplier_id", supplierId).maybeSingle(),
  );
};

export const fetchStoreProducts = async (supplierId: string): Promise<MarketProductRow[]> => {
  if (!isUuid(supplierId)) return [];
  return unwrap(
    await marketDb<MarketProductRow[]>("market_products")
      .select(PRODUCT_WITH_STORE)
      .eq("supplier_id", supplierId)
      .eq("review_status", "approved")
      .eq("is_listed", true)
      .order("created_at", { ascending: false }),
  ).filter(isPubliclyVisible);
};

// ---------------------------------------------------------------------
// 首頁篩選(條件放在網址 ?q=&cat=&city=&temp=,可以分享、上一頁不會掉)
// ---------------------------------------------------------------------
export interface ProductFilters {
  q: string;
  category: MarketCategoryKey | null;
  city: TwCity | null;
  temperature: Temperature | null;
}

export const filtersFromParams = (params: URLSearchParams): ProductFilters => {
  const cat = params.get("cat");
  const city = params.get("city");
  const temp = params.get("temp");
  return {
    q: (params.get("q") ?? "").slice(0, 50),
    category: isCategoryKey(cat) ? cat : null,
    city: isTwCity(city) ? city : null,
    temperature: isTemperature(temp) ? temp : null,
  };
};

export const paramsFromFilters = (f: ProductFilters): URLSearchParams => {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q);
  if (f.category) p.set("cat", f.category);
  if (f.city) p.set("city", f.city);
  if (f.temperature) p.set("temp", f.temperature);
  return p;
};

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");

const matchesQuery = (p: MarketProductRow, q: string): boolean => {
  const needle = normalize(q);
  if (!needle) return true;
  return [p.name, p.spec, p.description ?? "", p.origin ?? "", CATEGORY_LABEL[p.category], p.market_stores?.suppliers?.name ?? ""]
    .some((text) => normalize(text).includes(needle));
};

export const filterProducts = (products: MarketProductRow[], f: ProductFilters): MarketProductRow[] =>
  products.filter(
    (p) =>
      (!f.category || p.category === f.category) &&
      (!f.temperature || p.temperature === f.temperature) &&
      (!f.city || (p.market_stores?.delivery_cities ?? []).includes(f.city)) &&
      matchesQuery(p, f.q),
  );

export interface FeaturedStore {
  supplierId: string;
  name: string;
  logoPath: string | null;
  deliveryCities: TwCity[];
  productCount: number;
}

/** 精選店家:有上架商品的店(選了縣市就只算配送到那裡的店),商品多的排前面,最多 limit 家 */
export const featuredStores = (products: MarketProductRow[], city: TwCity | null, limit = 8): FeaturedStore[] => {
  const byStore = new Map<string, FeaturedStore>();
  for (const p of products) {
    const s = p.market_stores;
    if (!s || (city && !s.delivery_cities.includes(city))) continue;
    const cur = byStore.get(s.supplier_id);
    if (cur) cur.productCount += 1;
    else
      byStore.set(s.supplier_id, {
        supplierId: s.supplier_id,
        name: s.suppliers?.name ?? "店家",
        logoPath: s.logo_path,
        deliveryCities: s.delivery_cities,
        productCount: 1,
      });
  }
  return [...byStore.values()]
    .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, "zh-Hant"))
    .slice(0, limit);
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  9 passed (9)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/testFixtures.ts src/lib/market/catalog.ts src/lib/market/catalog.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 公開商品 / 店家查詢與首頁篩選

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 13:照片驗證、壓縮、上傳 `images.ts`

只收 jpeg / png / webp、原檔 ≤ 15 MB;在瀏覽器畫到 canvas 壓成長邊 1600px 的 JPEG(白底,品質 0.82 → 0.7 → 0.6 直到 ≤ 2 MB)與 480px 縮圖(`_t.jpg`),上傳到 `<supplier>/<product 或 store>/<uuid>.jpg`。canvas 與 Storage 都用注入的 deps,vitest 測得到。

**Files:**
- Create: `src/lib/market/images.ts`
- Test: `src/lib/market/images.test.ts`

**Step 1:寫失敗的測試**

```ts
// images.ts:格式與大小檢查、縮放計算、路徑、公開網址、壓縮重試、上傳(壓縮與 Storage 都用假的;jsdom 沒有 canvas)。
import { describe, expect, it, vi } from "vitest";

// images.ts 會 import db.ts → 真的 supabase client;換成空殼,不讓 GoTrue 在測試裡啟動(Node 25 的 localStorage 是空殼)
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  compressForUpload,
  fitWithin,
  imagePath,
  MarketImageError,
  publicImageUrl,
  thumbPathOf,
  uploadMarketImage,
  validateImageFile,
  type UploadDeps,
} from "./images";

const SUP = "a9200000-0000-4000-8000-00000000000a";
const PROD = "a9300000-0000-4000-8000-000000000001";
const IMG = "a9900000-0000-4000-8000-000000000001";

describe("validateImageFile", () => {
  it("只收 JPG / PNG / WebP", () => {
    expect(validateImageFile({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/webp", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/gif", size: 1000 })).toBe("只收 JPG、PNG、WebP 照片");
    expect(validateImageFile({ type: "image/heic", size: 1000 })).toBe("只收 JPG、PNG、WebP 照片");
  });

  it("原始檔 15 MB 以內(上傳前會壓縮,所以手機照片 3–8 MB 可以)", () => {
    expect(validateImageFile({ type: "image/jpeg", size: 8 * 1024 * 1024 })).toBeNull();
    expect(validateImageFile({ type: "image/jpeg", size: 15 * 1024 * 1024 + 1 })).toBe("照片太大了(原始檔請小於 15 MB)");
  });
});

describe("fitWithin", () => {
  it("長邊縮到 1600,等比例", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("小圖不放大", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("路徑與網址", () => {
  it("主圖與縮圖路徑", () => {
    expect(imagePath(SUP, PROD, IMG)).toBe(`${SUP}/${PROD}/${IMG}.jpg`);
    expect(imagePath(SUP, "store", IMG, true)).toBe(`${SUP}/store/${IMG}_t.jpg`);
    expect(thumbPathOf(`${SUP}/${PROD}/${IMG}.jpg`)).toBe(`${SUP}/${PROD}/${IMG}_t.jpg`);
    expect(thumbPathOf(`${SUP}/store/${IMG}.webp`)).toBe(`${SUP}/store/${IMG}_t.jpg`);
  });

  it("公開網址走 /storage/v1/object/public/market-images/", () => {
    expect(publicImageUrl(`${SUP}/store/${IMG}.jpg`, "https://x.supabase.co/")).toBe(
      `https://x.supabase.co/storage/v1/object/public/market-images/${SUP}/store/${IMG}.jpg`,
    );
  });
});

describe("compressForUpload", () => {
  const fakeBlob = (size: number) => ({ size }) as Blob;

  it("第一次就小於 2 MB 就用它", async () => {
    const compress = vi.fn().mockResolvedValue(fakeBlob(300_000));
    await expect(compressForUpload(fakeBlob(5_000_000), compress)).resolves.toEqual(fakeBlob(300_000));
    expect(compress).toHaveBeenCalledWith(expect.anything(), 1600, 0.82);
  });

  it("太大就降品質重壓;三次都太大就丟錯", async () => {
    const compress = vi
      .fn()
      .mockResolvedValueOnce(fakeBlob(3_000_000))
      .mockResolvedValueOnce(fakeBlob(1_900_000));
    await expect(compressForUpload(fakeBlob(9_000_000), compress)).resolves.toEqual(fakeBlob(1_900_000));
    expect(compress.mock.calls.map((c) => c[2])).toEqual([0.82, 0.7]);

    const tooBig = vi.fn().mockResolvedValue(fakeBlob(2_500_000));
    await expect(compressForUpload(fakeBlob(9_000_000), tooBig)).rejects.toThrow("照片壓縮後還是超過 2 MB");
  });
});

describe("uploadMarketImage", () => {
  const deps = (uploadError: string | null = null) => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: uploadError ? { message: uploadError } : null });
    const d: UploadDeps = {
      compressMain: vi.fn().mockResolvedValue(new Blob(["main"])),
      compressThumb: vi.fn().mockResolvedValue(new Blob(["thumb"])),
      storage: () => ({ upload }),
      newId: () => IMG,
    };
    return { d, upload };
  };
  const file = (type = "image/png") => new File(["x"], "photo.png", { type });

  it("上傳主圖與縮圖,回傳主圖路徑", async () => {
    const { d, upload } = deps();
    await expect(uploadMarketImage(SUP, PROD, file(), d)).resolves.toBe(`${SUP}/${PROD}/${IMG}.jpg`);
    expect(upload.mock.calls.map((c) => c[0])).toEqual([`${SUP}/${PROD}/${IMG}.jpg`, `${SUP}/${PROD}/${IMG}_t.jpg`]);
    expect(upload.mock.calls[0][2]).toEqual({ contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  });

  it("格式不對在壓縮前就擋下", async () => {
    const { d, upload } = deps();
    await expect(uploadMarketImage(SUP, PROD, file("image/gif"), d)).rejects.toBeInstanceOf(MarketImageError);
    expect(d.compressMain).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("Storage 回錯就丟出看得懂的錯", async () => {
    const { d } = deps("new row violates row-level security policy");
    await expect(uploadMarketImage(SUP, PROD, file(), d)).rejects.toThrow("上傳失敗:new row violates row-level security policy");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/images.test.ts`

Expected:FAIL,`Failed to resolve import "./images"`

**Step 3:寫實作**

```ts
// 市集圖片:檢查、在瀏覽器壓縮、上傳到 Storage bucket market-images、組公開網址。
//
// - 只收 JPG / PNG / WebP 原始檔(≤ 15 MB);壓成長邊 1600px 的 JPEG(品質 0.82,超過 2 MB 再降到 0.7、0.6),
//   另存一張 480px 縮圖(<uuid>_t.jpg,列表用)。壓縮寫法沿用 src/components/restaurant/ReceiveOrderDialog.tsx 的
//   fileToCompressedDataUrl,但存成檔案(Blob)不存 base64,而且先鋪白底(PNG 透明處才不會變黑)。
// - bucket 本身也限制 2 MB 與三種格式(migration 20261009120100),前端繞不過。
// - 路徑 <supplier_id>/<商品 id 或 store>/<uuid>.jpg —— storage.objects 的 policy 只讓該供應商寫自己的資料夾。
// - 換照片時「不刪」舊檔:舊檔可能還被已儲存的商品引用;孤兒檔無害(公開 bucket 但網址是猜不到的 uuid)。
import { MARKET_IMAGE_BUCKET, PHOTO_RULES } from "./constants";
import { marketStorage, newUuid, type StorageBucket } from "./db";

export class MarketImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketImageError";
  }
}

export const validateImageFile = (file: { type: string; size: number }): string | null => {
  if (!(PHOTO_RULES.inputTypes as readonly string[]).includes(file.type)) return "只收 JPG、PNG、WebP 照片";
  if (file.size > PHOTO_RULES.maxInputBytes) return "照片太大了(原始檔請小於 15 MB)";
  return null;
};

/** 等比縮到長邊不超過 max(小圖不放大) */
export const fitWithin = (width: number, height: number, max: number): { width: number; height: number } => {
  const scale = Math.min(1, max / Math.max(width, height) || 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export const imagePath = (supplierId: string, folder: string, id: string, thumb = false): string =>
  `${supplierId}/${folder}/${id}${thumb ? "_t" : ""}.jpg`;

/** 主圖路徑 → 縮圖路徑(a/b/c.jpg → a/b/c_t.jpg) */
export const thumbPathOf = (path: string): string => path.replace(/\.(jpg|jpeg|png|webp)$/i, "_t.jpg");

/** Storage 公開網址(public bucket,不經過 RLS) */
export const publicImageUrl = (path: string, base: string = import.meta.env.VITE_SUPABASE_URL as string): string =>
  `${String(base).replace(/\/+$/, "")}/storage/v1/object/public/${MARKET_IMAGE_BUCKET}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/** 讀圖 → 長邊縮到 maxSide → 白底 JPEG。瀏覽器解不開就丟錯(不上傳看不懂的檔案) */
export const compressToJpeg = (file: Blob, maxSide: number, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new MarketImageError("這張照片無法讀取,請換一張"));
    };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { width, height } = fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height, maxSide);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new MarketImageError("這個瀏覽器無法處理照片"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new MarketImageError("照片壓縮失敗,請換一張"))),
        "image/jpeg",
        quality,
      );
    };
    img.src = url;
  });

/** 壓到 ≤ 2 MB:品質 0.82 → 0.7 → 0.6,還是太大就丟錯 */
export const compressForUpload = async (file: Blob, compress = compressToJpeg): Promise<Blob> => {
  for (const quality of [0.82, 0.7, 0.6]) {
    const blob = await compress(file, PHOTO_RULES.longSide, quality);
    if (blob.size <= PHOTO_RULES.maxBytes) return blob;
  }
  throw new MarketImageError("照片壓縮後還是超過 2 MB,請換一張");
};

export interface UploadDeps {
  compressMain: (file: Blob) => Promise<Blob>;
  compressThumb: (file: Blob) => Promise<Blob>;
  storage: () => StorageBucket;
  newId: () => string;
}

const defaultDeps: UploadDeps = {
  compressMain: (f) => compressForUpload(f),
  compressThumb: (f) => compressToJpeg(f, PHOTO_RULES.thumbLongSide, 0.8),
  storage: marketStorage,
  newId: newUuid,
};

/** 上傳一張照片(主圖 + 縮圖)到 <supplierId>/<folder>/<uuid>.jpg,回傳主圖路徑(存進資料表的就是這個) */
export const uploadMarketImage = async (
  supplierId: string,
  folder: string,
  file: File,
  deps: UploadDeps = defaultDeps,
): Promise<string> => {
  const problem = validateImageFile(file);
  if (problem) throw new MarketImageError(problem);
  const main = await deps.compressMain(file);
  const thumb = await deps.compressThumb(file);
  const id = deps.newId();
  const options = { contentType: "image/jpeg", cacheControl: "31536000", upsert: false };
  const bucket = deps.storage();
  const mainPath = imagePath(supplierId, folder, id);
  const up = await bucket.upload(mainPath, main, options);
  if (up.error) throw new MarketImageError(`上傳失敗:${up.error.message}`);
  const upThumb = await bucket.upload(imagePath(supplierId, folder, id, true), thumb, options);
  if (upThumb.error) throw new MarketImageError(`縮圖上傳失敗:${upThumb.error.message}`);
  return mainPath;
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  11 passed (11)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/images.ts src/lib/market/images.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 商品照片驗證、瀏覽器壓縮(1600px JPEG + 縮圖)與上傳

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 14:市集共用元件(版面、圖片、商品卡、分類、店家條件)

- `MarketLayout`:跳到主要內容(第一個 Tab)、固定頁首、`<main id="market-main">`(`scroll-mt-16`,跳過去不會被頁首蓋住)、頁尾說明平台角色;匯出 `MARKET_FOCUS_RING`(焦點框)、`MARKET_PRIMARY_BUTTON`(emerald-700,白字對比約 5.5:1;產品站 primary 綠對白字只有約 2.3:1,市集不用)、`useMarketTitle()`。手機 ≤ 880px(跟形象站同一個分界),桌機用 Tailwind 任意斷點 `min-[881px]:`。
- `MarketImage`:列表用縮圖 → 壞了退回主圖 → 沒有照片或主圖也壞了就顯示分類圖示;一律有寬高、lazy。🔴 分類圖示的留白用「圖示 = 外框 76%」,不能用百分比 padding(百分比 padding 是照父元素寬度算的,64px 的圖放在整列寬的清單裡圖示會整個不見,2026-10-09 實測)。
- `ProductCard`:整張卡是一個連結;`CategoryChips`:`role="group"` + `aria-pressed`;`StoreInfoList`:配送縣市、運費、最低訂購、出貨、付款方式。

**Files:**
- Create: `src/components/market/MarketLayout.tsx`
- Create: `src/components/market/MarketImage.tsx`
- Create: `src/components/market/ProductCard.tsx`
- Create: `src/components/market/CategoryChips.tsx`
- Create: `src/components/market/StoreInfoList.tsx`
- Test: `src/components/market/market-components.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 市集共用元件:版面的地標與跳到主要內容、照片的退回順序、商品卡、分類切換、店家條件。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import CategoryChips from "./CategoryChips";
import MarketImage from "./MarketImage";
import MarketLayout, { useMarketTitle } from "./MarketLayout";
import ProductCard from "./ProductCard";
import StoreInfoList from "./StoreInfoList";

afterEach(cleanup);

const TitleProbe = ({ title }: { title: string | null }) => {
  useMarketTitle(title);
  return <h1>頁面</h1>;
};

describe("MarketLayout", () => {
  it("有跳到主要內容、logo 回市集首頁、main 地標;頁尾說明平台角色", () => {
    render(
      <MemoryRouter initialEntries={["/market"]}>
        <Routes>
          <Route path="/market" element={<MarketLayout />}>
            <Route index element={<TitleProbe title="測試頁" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toHaveAttribute("href", "#market-main");
    expect(screen.getByRole("link", { name: /食材市集 首頁/ })).toHaveAttribute("href", "/market");
    expect(screen.getByRole("main")).toHaveAttribute("id", "market-main");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("商品由各店家販售、出貨與收款");
    expect(document.title).toBe("測試頁｜iFoodmap 食材市集");
  });
});

describe("MarketImage", () => {
  const PATH = "a9200000-0000-4000-8000-00000000000a/a9300000-0000-4000-8000-000000000001/a9900000-0000-4000-8000-000000000001.jpg";

  it("縮圖 → 主圖 → 分類圖示,一路退回", () => {
    render(<MarketImage path={PATH} category="vegetable" alt="高麗菜" />);
    const img = screen.getByRole("img", { name: "高麗菜" });
    expect(img.getAttribute("src")).toMatch(/_t\.jpg$/);
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "高麗菜" }).getAttribute("src")).toMatch(/0001\.jpg$/);
    fireEvent.error(screen.getByRole("img", { name: "高麗菜" }));
    expect(screen.getByRole("img", { name: "高麗菜" })).toHaveAttribute("data-fallback", "category");
  });

  it("沒有照片就顯示分類圖示;有寬高、lazy", () => {
    render(<MarketImage path={null} category="meat" alt="牛肉" width={200} height={200} />);
    const img = screen.getByRole("img", { name: "牛肉" });
    expect(img).toHaveAttribute("data-fallback", "category");
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("分類圖示的留白跟著外框大小走(外框拿 className;不用百分比 padding —— 那是照父元素寬度算的)", () => {
    render(<MarketImage path={null} category="meat" alt="牛肉" className="h-16 w-16 rounded-md" />);
    const img = screen.getByRole("img", { name: "牛肉" });
    expect(img.parentElement).toHaveClass("h-16", "w-16", "rounded-md", "bg-emerald-50");
    expect(img).toHaveClass("h-[76%]", "w-[76%]");
    expect(img.className).not.toMatch(/\bp-\[/);
  });
});

describe("ProductCard", () => {
  it("整張卡片連到商品頁,顯示品名、規格、價格、溫層、店名", () => {
    render(
      <MemoryRouter>
        <ProductCard product={CABBAGE} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /有機高麗菜/ });
    expect(link).toHaveAttribute("href", `/market/p/${CABBAGE.id}`);
    expect(link).toHaveTextContent("NT$ 100");
    expect(link).toHaveTextContent("冷藏");
    expect(link).toHaveTextContent("市集測試 A 店");
    expect(link).not.toHaveTextContent("已售完");
  });

  it("庫存 0 標已售完", () => {
    render(
      <MemoryRouter>
        <ProductCard product={{ ...BEEF, stock: 0 }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /牛肉片/ })).toHaveTextContent("已售完");
  });
});

describe("CategoryChips", () => {
  it("全部 + 12 類,目前選的 aria-pressed=true;點了回傳 key", async () => {
    const onChange = vi.fn();
    render(<CategoryChips value="meat" onChange={onChange} />);
    const group = screen.getByRole("group", { name: "食材分類" });
    expect(within(group).getAllByRole("button")).toHaveLength(13);
    expect(within(group).getByRole("button", { name: "肉品" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(within(group).getByRole("button", { name: "海鮮" }));
    expect(onChange).toHaveBeenCalledWith("seafood");
    await userEvent.click(within(group).getByRole("button", { name: "全部" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("available 只列這家店有的分類", () => {
    render(<CategoryChips value={null} onChange={vi.fn()} available={["fruit"]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["全部", "水果"]);
  });
});

describe("StoreInfoList", () => {
  it("配送縣市、運費、最低訂購、出貨、付款方式", () => {
    render(<StoreInfoList store={STORE_A} />);
    expect(screen.getByText("臺北市、新北市")).toBeInTheDocument();
    expect(screen.getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByText("滿 NT$ 300 才能下單")).toBeInTheDocument();
    expect(screen.getByText("2 個工作天內出貨")).toBeInTheDocument();
    expect(screen.getByText("貨到付款、銀行轉帳")).toBeInTheDocument();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/components/market/market-components.test.tsx`

Expected:FAIL,`Failed to resolve import "./CategoryChips"`

**Step 3:寫實作**

`src/components/market/MarketLayout.tsx`:

```tsx
// 消費者食材市集(/market/*)的共用版面:頁首(logo、導覽)、主內容(<Outlet/>)、頁尾(平台角色說明)。
//
// 手機優先;≤ 880px 是手機(跟形象站同一個分界),桌機用 Tailwind 任意斷點 min-[881px]:。
// 無障礙:第一個 Tab 到的是「跳到主要內容」;<main id="market-main"> 可以接收焦點(scroll-mt-16:跳過去時不會被固定的頁首蓋住);
// 每頁的 <h1> 由各頁自己畫(剛好一個)。
import { useEffect } from "react";
import { Link, Outlet } from "react-router-dom";

export const MARKET_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2";

/** 主要按鈕的顏色(白字對 emerald-700 約 5.5:1;產品站 primary 綠對白字只有約 2.3:1,市集不用 variant="default") */
export const MARKET_PRIMARY_BUTTON = "bg-emerald-700 text-white hover:bg-emerald-800";

/** 各頁設定 document.title(換頁時螢幕閱讀器會唸) */
export const useMarketTitle = (title: string | null | undefined) => {
  useEffect(() => {
    document.title = title ? `${title}｜iFoodmap 食材市集` : "iFoodmap 食材市集";
  }, [title]);
};

export default function MarketLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <a
        href="#market-main"
        className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-emerald-800 focus:shadow ${MARKET_FOCUS_RING}`}
      >
        跳到主要內容
      </a>

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
          <Link to="/market" className={`inline-flex min-h-11 items-center gap-2 rounded-md ${MARKET_FOCUS_RING}`}>
            <img src="/logo.png" alt="" width={192} height={56} className="h-8 w-auto" />
            <span className="text-base font-bold text-emerald-800">食材市集</span>
            <span className="sr-only">首頁</span>
          </Link>
          <nav aria-label="市集" className="ml-auto flex items-center gap-1" />
        </div>
      </header>

      <main id="market-main" tabIndex={-1} className="flex-1 scroll-mt-16 focus:outline-none">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-slate-600">
          <p>iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。</p>
        </div>
      </footer>
    </div>
  );
}
```

`src/components/market/MarketImage.tsx`:

```tsx
// 商品 / 店家照片:列表用縮圖(_t.jpg),縮圖壞了退回主圖;沒有照片、或主圖也壞了就顯示分類圖示。
// 一律 width/height(避免版面跳動)、loading="lazy"、decoding="async"。
import { useEffect, useState } from "react";
import { CATEGORY_ICON } from "@/lib/market/categoryIcons";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { publicImageUrl, thumbPathOf } from "@/lib/market/images";

interface MarketImageProps {
  path: string | null | undefined;
  category: MarketCategoryKey;
  alt: string;
  variant?: "thumb" | "full";
  className?: string;
  width?: number;
  height?: number;
  eager?: boolean;
}

export default function MarketImage({
  path,
  category,
  alt,
  variant = "thumb",
  className = "",
  width = 480,
  height = 480,
  eager = false,
}: MarketImageProps) {
  const sources = path ? (variant === "thumb" ? [publicImageUrl(thumbPathOf(path)), publicImageUrl(path)] : [publicImageUrl(path)]) : [];
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [path, variant]);
  const src = sources[index];
  const loading = eager ? "eager" : "lazy";

  if (!src) {
    // 圖示外面包一層:留白用「圖示 = 外框的 76%」做,不能用 p-[12%] —— 百分比 padding 是照「父元素」寬度算的,
    // 64px 的圖放在整列寬的清單裡(購物車、審核清單)時 padding 會比圖還大,圖示整個不見(2026-10-09 實測)。
    return (
      <span className={`${className} flex items-center justify-center bg-emerald-50`}>
        <img
          src={CATEGORY_ICON[category]}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          decoding="async"
          data-fallback="category"
          className="h-[76%] w-[76%] object-contain"
        />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      decoding="async"
      onError={() => setIndex((i) => i + 1)}
      className={`${className} bg-slate-100 object-cover`}
    />
  );
}
```

`src/components/market/ProductCard.tsx`:

```tsx
// 商品卡片(首頁、店家頁共用):整張卡片是一個連結,連結名稱包含品名、規格、價格。
import { Link } from "react-router-dom";
import { TEMPERATURES } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";
import type { MarketProductRow } from "@/lib/market/types";
import MarketImage from "./MarketImage";
import { MARKET_FOCUS_RING } from "./MarketLayout";

export default function ProductCard({ product, showStore = true }: { product: MarketProductRow; showStore?: boolean }) {
  const soldOut = product.stock === 0;
  const storeName = product.market_stores?.suppliers?.name ?? "";
  return (
    <article className="h-full overflow-hidden rounded-xl border border-slate-200 bg-white">
      <Link to={`/market/p/${product.id}`} className={`flex h-full flex-col ${MARKET_FOCUS_RING}`}>
        <MarketImage path={product.photos[0]} category={product.category} alt="" className="aspect-square w-full" />
        <div className="flex flex-1 flex-col gap-1 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">{product.name}</h3>
          <p className="text-xs text-slate-600">{product.spec}</p>
          <p className="text-base font-bold text-emerald-800">{formatTwd(product.price)}</p>
          <p className="flex flex-wrap items-center gap-1 text-xs">
            <span className="rounded border border-slate-300 px-1.5 py-0.5 text-slate-700">{TEMPERATURES[product.temperature]}</span>
            {soldOut ? <span className="rounded border border-red-300 px-1.5 py-0.5 text-red-700">已售完</span> : null}
          </p>
          {showStore && storeName ? <p className="mt-auto truncate text-xs text-slate-500">{storeName}</p> : null}
        </div>
      </Link>
    </article>
  );
}
```

`src/components/market/CategoryChips.tsx`:

```tsx
// 分類切換(首頁、店家頁):「全部」+ 12 類(或只列這家店有的分類),圖示用形象站的 cat-*.svg。
// 手機上是一列可以橫向滑動的按鈕(自己捲,不把頁面撐寬);桌機換行排開。切換鈕用 aria-pressed。
import { CATEGORY_ICON } from "@/lib/market/categoryIcons";
import { MARKET_CATEGORIES, type MarketCategoryKey } from "@/lib/market/constants";
import { MARKET_FOCUS_RING } from "./MarketLayout";

interface CategoryChipsProps {
  value: MarketCategoryKey | null;
  onChange: (value: MarketCategoryKey | null) => void;
  /** 只列這些分類(店家頁用);不給就是全部 12 類 */
  available?: MarketCategoryKey[];
}

const chipClass = (active: boolean) =>
  `inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${
    active ? "border-emerald-700 bg-emerald-50 font-semibold text-emerald-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
  } ${MARKET_FOCUS_RING}`;

export default function CategoryChips({ value, onChange, available }: CategoryChipsProps) {
  const categories = available ? MARKET_CATEGORIES.filter((c) => available.includes(c.key)) : MARKET_CATEGORIES;
  return (
    <div
      role="group"
      aria-label="食材分類"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 min-[881px]:mx-0 min-[881px]:flex-wrap min-[881px]:overflow-visible min-[881px]:px-0"
    >
      <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={chipClass(value === null)}>
        全部
      </button>
      {categories.map((c) => (
        <button key={c.key} type="button" aria-pressed={value === c.key} onClick={() => onChange(c.key)} className={chipClass(value === c.key)}>
          <img src={CATEGORY_ICON[c.key]} alt="" width={24} height={24} className="h-6 w-6 rounded" />
          {c.label}
        </button>
      ))}
    </div>
  );
}
```

`src/components/market/StoreInfoList.tsx`:

```tsx
// 店家的配送與付款條件(商品頁的店家卡、店家頁共用)。
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { citiesSummary, minOrderSummary, shipDaysSummary, shippingSummary } from "@/lib/market/format";
import type { MarketStoreRow } from "@/lib/market/types";

export default function StoreInfoList({ store }: { store: MarketStoreRow }) {
  const rows: Array<[string, string]> = [
    ["配送縣市", citiesSummary(store.delivery_cities)],
    ["運費", shippingSummary(store)],
    ["最低訂購", minOrderSummary(store)],
    ["出貨", shipDaysSummary(store.ship_days)],
    ["付款方式", store.payment_methods.map((m) => PAYMENT_METHODS[m]).join("、")],
  ];
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  9 passed (9)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/components/market/MarketLayout.tsx src/components/market/MarketImage.tsx src/components/market/ProductCard.tsx src/components/market/CategoryChips.tsx src/components/market/StoreInfoList.tsx src/components/market/market-components.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 市集共用元件(版面、圖片退回、商品卡、分類、店家條件)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 15:市集首頁 `/market`

搜尋列、配送縣市、溫層、12 類分類(圖示)、精選店家、商品列表;條件都放網址(可以分享、上一頁不會掉);沒有商品時有空狀態。`testUtils.tsx` 是頁面測試共用的渲染工具(QueryClient 不重試 + MemoryRouter + `data-testid="location"` 讀目前網址)。

**Files:**
- Create: `src/pages/market/testUtils.tsx`
- Create: `src/pages/market/MarketNotFound.tsx`
- Create: `src/pages/market/MarketHomePage.tsx`
- Test: `src/pages/market/MarketHomePage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market 首頁:列商品與精選店家;分類、縣市、溫層、搜尋都會改網址並篩掉不符合的;空狀態與錯誤。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchListedProducts: vi.fn(),
}));

import { fetchListedProducts } from "@/lib/market/catalog";
import { BEEF, CABBAGE, SALMON, STORE_A } from "@/lib/market/testFixtures";
import MarketHomePage from "./MarketHomePage";
import { renderMarketRoute } from "./testUtils";

const renderHome = (path = "/market") => renderMarketRoute(path, [{ path: "/market", element: <MarketHomePage /> }]);
const productNames = () =>
  within(screen.getByRole("region", { name: "商品" }))
    .queryAllByRole("heading", { level: 3 })
    .map((h) => h.textContent);

beforeEach(() => {
  vi.mocked(fetchListedProducts).mockResolvedValue([CABBAGE, BEEF, SALMON]);
});
afterEach(cleanup);

describe("MarketHomePage", () => {
  it("一個 h1;列出商品、精選店家(商品多的在前)", async () => {
    renderHome();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await screen.findByText("共 3 項")).toBeInTheDocument();
    expect(productNames()).toEqual(["有機高麗菜", "牛肉片", "挪威鮭魚"]);
    const stores = within(screen.getByRole("region", { name: "精選店家" })).getAllByRole("link");
    expect(stores[0]).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
    expect(stores[0]).toHaveTextContent("市集測試 A 店");
    expect(stores[0]).toHaveTextContent("2 項商品");
  });

  it("點分類:只剩那一類,網址帶 ?cat=", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    await userEvent.click(screen.getByRole("button", { name: "肉品" }));
    expect(productNames()).toEqual(["牛肉片"]);
    expect(screen.getByTestId("location")).toHaveTextContent("/market?cat=meat");
  });

  it("選配送縣市:不配送到那裡的店家的商品不見", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    await userEvent.selectOptions(screen.getByLabelText("配送到哪"), "新北市");
    expect(productNames()).toEqual(["有機高麗菜", "牛肉片"]);
    expect(screen.getByText("共 2 項")).toBeInTheDocument();
  });

  it("溫層與搜尋", async () => {
    renderHome();
    await screen.findByText("共 3 項");
    const temperature = within(screen.getByRole("group", { name: "溫層" }));
    await userEvent.click(temperature.getByRole("button", { name: "冷凍" }));
    expect(productNames()).toEqual(["牛肉片", "挪威鮭魚"]);
    expect(screen.getByTestId("location")).toHaveTextContent("temp=frozen");
    await userEvent.click(temperature.getByRole("button", { name: "全部" }));
    await userEvent.type(screen.getByLabelText("搜尋食材"), "鮭魚");
    expect(productNames()).toEqual(["挪威鮭魚"]);
  });

  it("網址帶篩選條件進來就套用", async () => {
    renderHome("/market?cat=seafood");
    expect(await screen.findByText("共 1 項")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "海鮮" })).toHaveAttribute("aria-pressed", "true");
  });

  it("沒有任何上架商品時說敬請期待;篩到沒有時提示換條件", async () => {
    vi.mocked(fetchListedProducts).mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText("市集還沒有上架的商品,敬請期待。")).toBeInTheDocument();
    cleanup();
    vi.mocked(fetchListedProducts).mockResolvedValue([CABBAGE]);
    renderHome("/market?cat=meat");
    expect(await screen.findByText("沒有符合條件的商品,換個分類或縣市看看。")).toBeInTheDocument();
  });

  it("載入失敗顯示錯誤與重新載入", async () => {
    vi.mocked(fetchListedProducts).mockRejectedValue(new Error("network"));
    renderHome();
    expect(await screen.findByRole("alert")).toHaveTextContent("商品載入失敗");
    expect(screen.getByRole("button", { name: "重新載入" })).toBeInTheDocument();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketHomePage.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketHomePage"`

**Step 3:寫實作**

`src/pages/market/testUtils.tsx`(只給測試用):

```tsx
// 市集頁面測試共用的渲染工具(只給 *.test.tsx 用,正式程式不會 import):
// QueryClient(不重試)+ MemoryRouter + 指定的路由表,另外畫一個 data-testid="location" 讓測試讀目前網址
// (用 <span> 不用 <output>:<output> 的角色是 status,會跟頁面上的 role="status" 撞在一起)。
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const LocationProbe = () => {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
};

export const renderMarketRoute = (path: string, routes: Array<{ path: string; element: ReactElement }>) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
```

`src/pages/market/MarketNotFound.tsx`:

```tsx
// 市集裡找不到的頁面 / 商品 / 店家:一句話 + 回市集首頁(不用全站的 NotFound,那頁是英文、會導回登入頁)
import { Link } from "react-router-dom";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";

export default function MarketNotFound({ message = "找不到這個頁面。" }: { message?: string }) {
  useMarketTitle("找不到頁面");
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">{message}</h1>
      <Link
        to="/market"
        className={`mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 ${MARKET_FOCUS_RING}`}
      >
        回市集首頁
      </Link>
    </div>
  );
}
```

`src/pages/market/MarketHomePage.tsx`:

```tsx
// /market 市集首頁:搜尋、配送縣市、溫層、分類、精選店家、商品列表。
// 篩選條件放在網址(?q=&cat=&city=&temp=),可以分享、按上一頁不會掉;篩選是純函式(src/lib/market/catalog.ts)。
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import CategoryChips from "@/components/market/CategoryChips";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import ProductCard from "@/components/market/ProductCard";
import {
  featuredStores,
  fetchListedProducts,
  filterProducts,
  filtersFromParams,
  paramsFromFilters,
  type ProductFilters,
} from "@/lib/market/catalog";
import { isTwCity, TEMPERATURE_KEYS, TEMPERATURES, TW_CITIES, type Temperature } from "@/lib/market/constants";
import { citiesSummary } from "@/lib/market/format";

const FIELD = `min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 ${MARKET_FOCUS_RING}`;

export default function MarketHomePage() {
  useMarketTitle(null);
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["market", "products"], queryFn: fetchListedProducts });
  const products = useMemo(() => data ?? [], [data]);
  const visible = useMemo(
    () => filterProducts(products, filters),
    // filters 每次 render 都是新物件,依賴拆成四個值
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products, filters.q, filters.category, filters.city, filters.temperature],
  );
  const stores = useMemo(() => featuredStores(products, filters.city), [products, filters.city]);

  const update = (patch: Partial<ProductFilters>) => setParams(paramsFromFilters({ ...filters, ...patch }), { replace: true });

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-6">
      <section aria-labelledby="market-title" className="space-y-4">
        <div className="space-y-1">
          <h1 id="market-title" className="text-2xl font-bold text-slate-900 min-[881px]:text-3xl">
            iFoodmap 食材市集
          </h1>
          <p className="text-slate-600">直接向平台上的在地供應商買食材,店家自己出貨、收款。</p>
        </div>

        <form role="search" aria-label="搜尋與篩選" onSubmit={(e) => e.preventDefault()} className="grid gap-3 min-[881px]:grid-cols-[1fr,14rem]">
          <div>
            <label htmlFor="market-q" className="mb-1 block text-sm font-medium text-slate-700">
              搜尋食材
            </label>
            <input
              id="market-q"
              type="search"
              value={filters.q}
              maxLength={50}
              onChange={(e) => update({ q: e.target.value })}
              placeholder="例如:高麗菜、牛肉片"
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="market-city" className="mb-1 block text-sm font-medium text-slate-700">
              配送到哪
            </label>
            <select
              id="market-city"
              value={filters.city ?? ""}
              onChange={(e) => update({ city: isTwCity(e.target.value) ? e.target.value : null })}
              className={FIELD}
            >
              <option value="">全部縣市</option>
              {TW_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="min-[881px]:col-span-2">
            <legend className="mb-1 text-sm font-medium text-slate-700">溫層</legend>
            <div className="flex flex-wrap gap-2">
              {([null, ...TEMPERATURE_KEYS] as Array<Temperature | null>).map((t) => (
                <button
                  key={t ?? "all"}
                  type="button"
                  aria-pressed={filters.temperature === t}
                  onClick={() => update({ temperature: t })}
                  className={`min-h-11 rounded-full border px-4 text-sm ${
                    filters.temperature === t
                      ? "border-emerald-700 bg-emerald-50 font-semibold text-emerald-800"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  } ${MARKET_FOCUS_RING}`}
                >
                  {t ? TEMPERATURES[t] : "全部"}
                </button>
              ))}
            </div>
          </fieldset>
        </form>

        <CategoryChips value={filters.category} onChange={(category) => update({ category })} />
      </section>

      {stores.length > 0 && (
        <section aria-labelledby="market-stores-title" className="space-y-3">
          <h2 id="market-stores-title" className="text-xl font-bold text-slate-900">
            精選店家
          </h2>
          <ul className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[881px]:grid-cols-4">
            {stores.map((s) => (
              <li key={s.supplierId}>
                <Link
                  to={`/market/s/${s.supplierId}`}
                  className={`flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 hover:border-emerald-300 ${MARKET_FOCUS_RING}`}
                >
                  <MarketImage path={s.logoPath} category="grocery" alt="" variant="thumb" className="h-12 w-12 shrink-0 rounded-full" width={48} height={48} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{s.name}</span>
                    <span className="block truncate text-xs text-slate-600">
                      {citiesSummary(s.deliveryCities)}・{s.productCount} 項商品
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="market-products-title" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="market-products-title" className="text-xl font-bold text-slate-900">
            商品
          </h2>
          <p aria-live="polite" className="text-sm text-slate-600">
            {isLoading ? "載入中…" : `共 ${visible.length} 項`}
          </p>
        </div>

        {isLoading ? (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i}>
                <Skeleton className="aspect-[3/4] w-full rounded-xl" />
              </li>
            ))}
          </ul>
        ) : isError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            商品載入失敗,請檢查網路後再試一次。
            <button type="button" onClick={() => refetch()} className={`ml-3 min-h-11 font-semibold underline ${MARKET_FOCUS_RING}`}>
              重新載入
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl bg-white py-12 text-center text-slate-600">
            {products.length === 0 ? "市集還沒有上架的商品,敬請期待。" : "沒有符合條件的商品,換個分類或縣市看看。"}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4">
            {visible.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  7 passed (7)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/market/testUtils.tsx src/pages/market/MarketNotFound.tsx src/pages/market/MarketHomePage.tsx src/pages/market/MarketHomePage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 市集首頁(搜尋、縣市、溫層、分類、精選店家、商品列表)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 16:商品頁 `/market/p/:productId`

照片(最多 5 張,可切換)、品名、規格、價格、溫層、庫存、產地、保存方式、保存期限、說明、店家卡;供應商 / 管理員打開自家還沒上架的商品時顯示「預覽」。第 1 階段還不能下單,顯示「線上訂購即將開放。」(第 2 階段 Task 46 換成加入購物車)。

**Files:**
- Create: `src/pages/market/MarketProductPage.tsx`
- Test: `src/pages/market/MarketProductPage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market/p/:productId:商品資訊、店家卡、照片切換;沒上架的顯示預覽;找不到、壞網址。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchMarketProduct: vi.fn(),
}));

import { fetchMarketProduct } from "@/lib/market/catalog";
import { CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import MarketProductPage from "./MarketProductPage";
import { renderMarketRoute } from "./testUtils";

const PHOTO = (n: number) =>
  `${STORE_A.supplier_id}/${CABBAGE.id}/a9900000-0000-4000-8000-00000000000${n}.jpg`;
const renderAt = (id: string) => renderMarketRoute(`/market/p/${id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }]);

afterEach(cleanup);

describe("MarketProductPage", () => {
  it("品名、規格、價格、溫層、庫存、產地,店家卡連到店家頁", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { level: 1, name: "有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByText("NT$ 100")).toBeInTheDocument();
    expect(screen.getByText("冷藏・現貨")).toBeInTheDocument();
    expect(screen.getByText("宜蘭三星")).toBeInTheDocument();
    const card = screen.getByRole("complementary");
    expect(within(card).getByRole("link", { name: "市集測試 A 店" })).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
    expect(within(card).getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "麵包屑" })).toHaveTextContent("市集›蔬菜›有機高麗菜");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.title).toBe("有機高麗菜｜iFoodmap 食材市集");
  });

  it("多張照片可以切換", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, photos: [PHOTO(1), PHOTO(2)] });
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("img", { name: "有機高麗菜 照片 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看第 2 張照片" }));
    expect(screen.getByRole("img", { name: "有機高麗菜 照片 2" }).getAttribute("src")).toContain(PHOTO(2));
    expect(screen.getByRole("button", { name: "看第 2 張照片" })).toHaveAttribute("aria-pressed", "true");
  });

  it("還沒上架(供應商預覽自己的商品)顯示預覽提示", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, review_status: "pending" });
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("status")).toHaveTextContent("預覽:消費者目前看不到這個商品(審核狀態:待審)");
  });

  it("找不到商品、網址不是 uuid 都顯示找不到", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(null);
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("heading", { name: "找不到這個商品,可能已經下架了。" })).toBeInTheDocument();
    cleanup();
    renderAt("not-a-uuid");
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketProductPage.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketProductPage"`

**Step 3:寫實作**

```tsx
// /market/p/:productId 商品頁:照片(最多 5 張)、品名、規格、價格、溫層、庫存、產地、保存方式、保存期限、說明,
// 店家卡(店名、配送縣市、運費、免運門檻、最低訂購金額、出貨天數、付款方式)。
// 供應商 / 管理員打開自家還沒上架的商品時,照樣顯示但加「預覽」提示(消費者看不到,RLS 擋)。
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import StoreInfoList from "@/components/market/StoreInfoList";
import { fetchMarketProduct, isPubliclyVisible } from "@/lib/market/catalog";
import { CATEGORY_LABEL, REVIEW_STATUS_LABEL, TEMPERATURES } from "@/lib/market/constants";
import { isUuid } from "@/lib/market/db";
import { formatTwd, stockLabel } from "@/lib/market/format";
import MarketNotFound from "./MarketNotFound";

export default function MarketProductPage() {
  const { productId = "" } = useParams();
  const valid = isUuid(productId);
  const { data: product, isLoading, isError } = useQuery({
    queryKey: ["market", "product", productId],
    queryFn: () => fetchMarketProduct(productId),
    enabled: valid,
  });
  const [photoIndex, setPhotoIndex] = useState(0);
  useMarketTitle(product?.name ?? null);

  if (!valid || (!isLoading && !isError && !product)) return <MarketNotFound message="找不到這個商品,可能已經下架了。" />;
  if (isLoading) {
    return (
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 min-[881px]:grid-cols-2" aria-busy="true">
        <Skeleton className="aspect-square w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (isError || !product) {
    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-16 text-center text-red-800">
        商品載入失敗,請重新整理再試一次。
      </div>
    );
  }

  const store = product.market_stores;
  const preview = !isPubliclyVisible(product);
  const details: Array<[string, string | null]> = [
    ["產地", product.origin],
    ["保存方式", product.storage_method],
    ["保存期限", product.shelf_life],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <nav aria-label="麵包屑" className="mb-4 text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to="/market" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              市集
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li>
            <Link to={`/market?cat=${product.category}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              {CATEGORY_LABEL[product.category]}
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li aria-current="page" className="text-slate-900">
            {product.name}
          </li>
        </ol>
      </nav>

      {preview && (
        <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          預覽:消費者目前看不到這個商品(審核狀態:{REVIEW_STATUS_LABEL[product.review_status]}
          {product.is_listed ? "" : "、上架開關關閉"}
          {store && !store.is_enabled ? "、店家零售已停用" : ""})。
        </p>
      )}

      <div className="grid gap-6 min-[881px]:grid-cols-2">
        <section aria-label="商品照片" className="space-y-2">
          <MarketImage
            path={product.photos[photoIndex]}
            category={product.category}
            alt={`${product.name}${product.photos.length > 1 ? ` 照片 ${photoIndex + 1}` : ""}`}
            variant="full"
            eager
            width={800}
            height={800}
            className="aspect-square w-full rounded-xl"
          />
          {product.photos.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {product.photos.map((p, i) => (
                <button
                  key={p}
                  type="button"
                  aria-label={`看第 ${i + 1} 張照片`}
                  aria-pressed={i === photoIndex}
                  onClick={() => setPhotoIndex(i)}
                  className={`shrink-0 rounded-md border-2 ${i === photoIndex ? "border-emerald-700" : "border-transparent"} ${MARKET_FOCUS_RING}`}
                >
                  <MarketImage path={p} category={product.category} alt="" width={64} height={64} className="h-16 w-16 rounded" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="product-title" className="space-y-4">
          <div>
            <h1 id="product-title" className="text-2xl font-bold text-slate-900">
              {product.name}
            </h1>
            <p className="text-slate-600">{product.spec}</p>
          </div>
          <p className="text-3xl font-bold text-emerald-800">{formatTwd(product.price)}</p>
          <p className="text-sm text-slate-700">
            {TEMPERATURES[product.temperature]}・{stockLabel(product.stock)}
          </p>
          {details.some(([, v]) => v) && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
              {details
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="text-slate-800">{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          {product.description && (
            <div>
              <h2 className="mb-1 font-semibold text-slate-900">商品說明</h2>
              <p className="whitespace-pre-line text-slate-700">{product.description}</p>
            </div>
          )}

          <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">線上訂購即將開放。</p>

          {store && (
            <aside aria-labelledby="store-card-title" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
              <h2 id="store-card-title" className="font-semibold text-slate-900">
                <Link to={`/market/s/${store.supplier_id}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                  {store.suppliers?.name ?? "店家"}
                </Link>
              </h2>
              <StoreInfoList store={store} />
            </aside>
          )}
        </section>
      </div>
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  4 passed (4)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/market/MarketProductPage.tsx src/pages/market/MarketProductPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 商品頁(照片、規格、店家卡、預覽提示)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 17:店家頁 `/market/s/:supplierId`

logo、封面(沒有封面時只留一條矮的色帶)、介紹、退換貨說明、配送與付款條件、該店所有上架商品(可依分類篩)。

**Files:**
- Create: `src/pages/market/MarketStorePage.tsx`
- Test: `src/pages/market/MarketStorePage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market/s/:supplierId:店名、介紹、退換貨、配送條件、商品與分類篩選;停用的店與找不到的店。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchMarketStore: vi.fn(),
  fetchStoreProducts: vi.fn(),
}));

import { fetchMarketStore, fetchStoreProducts } from "@/lib/market/catalog";
import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import MarketStorePage from "./MarketStorePage";
import { renderMarketRoute } from "./testUtils";

const renderAt = (id: string) => renderMarketRoute(`/market/s/${id}`, [{ path: "/market/s/:supplierId", element: <MarketStorePage /> }]);

afterEach(cleanup);

describe("MarketStorePage", () => {
  it("店名、介紹、退換貨、配送條件與商品;只列這家店有的分類", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue(STORE_A);
    vi.mocked(fetchStoreProducts).mockResolvedValue([CABBAGE, BEEF]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { level: 1, name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.getByText("當日採收的葉菜與根莖類")).toBeInTheDocument();
    expect(screen.getByText("生鮮食品收到後 24 小時內有問題請拍照聯絡我們")).toBeInTheDocument();
    expect(screen.getByText("滿 NT$ 300 才能下單")).toBeInTheDocument();
    expect(await screen.findByText("共 2 項")).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "食材分類" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["全部", "蔬菜", "肉品"]);
    await userEvent.click(within(chips).getByRole("button", { name: "肉品" }));
    expect(screen.getByText("共 1 項")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /牛肉片/ })).toHaveAttribute("href", `/market/p/${BEEF.id}`);
  });

  it("店家零售停用(登入的店家自己看得到那一列)時顯示沒有開放", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue({ ...STORE_A, is_enabled: false });
    vi.mocked(fetchStoreProducts).mockResolvedValue([]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { name: "這家店目前沒有開放零售。" })).toBeInTheDocument();
  });

  it("找不到的店、壞網址", async () => {
    vi.mocked(fetchMarketStore).mockResolvedValue(null);
    vi.mocked(fetchStoreProducts).mockResolvedValue([]);
    renderAt(STORE_A.supplier_id);
    expect(await screen.findByRole("heading", { name: "這家店目前沒有開放零售。" })).toBeInTheDocument();
    cleanup();
    renderAt("abc");
    expect(screen.getByRole("heading", { name: "找不到這家店。" })).toBeInTheDocument();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketStorePage.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketStorePage"`

**Step 3:寫實作**

```tsx
// /market/s/:supplierId 店家頁:封面、logo、店名、介紹、配送與付款條件、退換貨說明、這家店上架中的商品(可依分類篩)。
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import CategoryChips from "@/components/market/CategoryChips";
import { useMarketTitle } from "@/components/market/MarketLayout";
import ProductCard from "@/components/market/ProductCard";
import StoreInfoList from "@/components/market/StoreInfoList";
import { fetchMarketStore, fetchStoreProducts, isStoreOpen } from "@/lib/market/catalog";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { isUuid } from "@/lib/market/db";
import { publicImageUrl } from "@/lib/market/images";
import MarketNotFound from "./MarketNotFound";

export default function MarketStorePage() {
  const { supplierId = "" } = useParams();
  const valid = isUuid(supplierId);
  const storeQuery = useQuery({ queryKey: ["market", "store", supplierId], queryFn: () => fetchMarketStore(supplierId), enabled: valid });
  const productsQuery = useQuery({
    queryKey: ["market", "store-products", supplierId],
    queryFn: () => fetchStoreProducts(supplierId),
    enabled: valid,
  });
  const [category, setCategory] = useState<MarketCategoryKey | null>(null);
  const store = storeQuery.data;
  useMarketTitle(store?.suppliers?.name ?? null);

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);
  const shown = category ? products.filter((p) => p.category === category) : products;

  if (!valid) return <MarketNotFound message="找不到這家店。" />;
  if (storeQuery.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6" aria-busy="true">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (storeQuery.isError) {
    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-16 text-center text-red-800">
        店家資料載入失敗,請重新整理再試一次。
      </div>
    );
  }
  if (!store || !isStoreOpen(store)) return <MarketNotFound message="這家店目前沒有開放零售。" />;

  const name = store.suppliers?.name ?? "店家";
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {store.cover_path ? (
          <img
            src={publicImageUrl(store.cover_path)}
            alt=""
            width={1200}
            height={400}
            className="aspect-[2/1] w-full object-cover min-[881px]:aspect-[3/1]"
          />
        ) : (
          <div className="h-24 w-full bg-gradient-to-r from-emerald-50 to-lime-50" aria-hidden="true" />
        )}
        <div className="flex items-center gap-3 p-4">
          {store.logo_path ? (
            <img src={publicImageUrl(store.logo_path)} alt="" width={64} height={64} className="h-16 w-16 rounded-full border border-slate-200 object-cover" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-800" aria-hidden="true">
              <Store className="h-8 w-8" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{name}</h1>
            {store.suppliers?.phone ? <p className="text-sm text-slate-600">電話 {store.suppliers.phone}</p> : null}
          </div>
        </div>
      </header>

      <div className="grid gap-4 min-[881px]:grid-cols-[2fr,1fr]">
        <section aria-labelledby="store-intro-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="store-intro-title" className="font-semibold text-slate-900">
            店家介紹
          </h2>
          <p className="whitespace-pre-line text-slate-700">{store.intro ?? "店家還沒有填寫介紹。"}</p>
          <h2 className="pt-2 font-semibold text-slate-900">退換貨說明</h2>
          <p className="whitespace-pre-line text-slate-700">{store.return_policy ?? "請直接聯絡店家。生鮮食品依法不適用七天鑑賞期。"}</p>
        </section>
        <section aria-labelledby="store-terms-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h2 id="store-terms-title" className="font-semibold text-slate-900">
            配送與付款
          </h2>
          <StoreInfoList store={store} />
        </section>
      </div>

      <section aria-labelledby="store-products-title" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="store-products-title" className="text-xl font-bold text-slate-900">
            商品
          </h2>
          <p aria-live="polite" className="text-sm text-slate-600">
            {productsQuery.isLoading ? "載入中…" : `共 ${shown.length} 項`}
          </p>
        </div>
        {categories.length > 1 && <CategoryChips value={category} onChange={setCategory} available={categories} />}
        {!productsQuery.isLoading && shown.length === 0 ? (
          <p className="rounded-xl bg-white py-12 text-center text-slate-600">這家店還沒有上架的商品。</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 min-[881px]:grid-cols-4">
            {shown.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} showStore={false} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  3 passed (3)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/market/MarketStorePage.tsx src/pages/market/MarketStorePage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 店家頁(介紹、退換貨、配送條件、上架商品)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 18:掛上 `/market` 路由(前台站)

市集掛在 `MainRoutes`(前台站),免登入;`/market/*` 打錯的網址顯示市集自己的找不到頁(不是全站的英文 NotFound)。

**Files:**
- Modify: `src/App.tsx:30`(在這行後面加 import)、`src/App.tsx:148`(在這行後面加路由)
- Test: `src/App.market-routes.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 主站(前台)路由表:/market 底下三頁掛在 MarketLayout 裡、免登入;市集裡打錯網址顯示市集自己的找不到頁。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchListedProducts: vi.fn().mockResolvedValue([]),
}));

import App from "./App";

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(<App />);
};

describe("市集路由(前台站)", () => {
  it("/market 是市集首頁,包在市集版面裡(有跳到主要內容)", async () => {
    renderAt("/market");
    expect(await screen.findByRole("heading", { level: 1, name: "iFoodmap 食材市集" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
  });

  it("/market 底下打錯的網址顯示市集的找不到頁,不是全站 NotFound", async () => {
    renderAt("/market/nope/123");
    expect(await screen.findByRole("heading", { name: "找不到這個頁面。" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回市集首頁" })).toHaveAttribute("href", "/market");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/App.market-routes.test.tsx`

Expected:FAIL,`Unable to find role="heading" and name "iFoodmap 食材市集"`(`/market` 還落在全站的 catch-all)

**Step 3:改 `src/App.tsx`**

在 `src/App.tsx` 找到:

```tsx
import PriceIndexPage from "./pages/PriceIndexPage";

// 平台營運後台(僅 admin 站)
import AdminRoute from "./components/AdminRoute";
```

換成:

```tsx
import PriceIndexPage from "./pages/PriceIndexPage";

// 消費者食材市集(僅前台站,免登入)
import MarketLayout from "./components/market/MarketLayout";
import MarketHomePage from "./pages/market/MarketHomePage";
import MarketProductPage from "./pages/market/MarketProductPage";
import MarketStorePage from "./pages/market/MarketStorePage";
import MarketNotFound from "./pages/market/MarketNotFound";

// 平台營運後台(僅 admin 站)
import AdminRoute from "./components/AdminRoute";
```

在 `src/App.tsx` 找到:

```tsx
    <Route path="/architecture" element={<Architecture />} />
    <Route path="/investors" element={<InvestorsPage />} />

    {/* 餐廳後台 */}
```

換成:

```tsx
    <Route path="/architecture" element={<Architecture />} />
    <Route path="/investors" element={<InvestorsPage />} />

    {/* 消費者食材市集(免登入)。用 /market 前綴:公開的 /supplier/:id 跟供應商後台 /supplier/* 已經撞名,不要再往那邊加 */}
    <Route path="/market" element={<MarketLayout />}>
      <Route index element={<MarketHomePage />} />
      <Route path="p/:productId" element={<MarketProductPage />} />
      <Route path="s/:supplierId" element={<MarketStorePage />} />
      <Route path="*" element={<MarketNotFound />} />
    </Route>

    {/* 餐廳後台 */}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  2 passed (2)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/App.tsx src/App.market-routes.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 前台站掛上 /market 路由(首頁、商品頁、店家頁、找不到頁)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 19:目前登入者的供應商 id(`useCurrentSupplier`)

供應商後台的零售頁共用:查 `supplier_accounts` 裡啟用中的那一列(跟 `src/pages/supplier/SupplierCatalogPage.tsx:84-100` 同一種查法)。

**Files:**
- Create: `src/hooks/use-current-supplier.ts`
- Test: `src/hooks/use-current-supplier.test.tsx`

**Step 1:寫失敗的測試**

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    session: { user: { id: "user-1" } } as { user: { id: string } } | null,
    row: { supplier_id: "sup-1" } as { supplier_id: string } | null,
    filters: [] as Array<[string, unknown]>,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: () => {
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          state.filters.push([c, v]);
          return b;
        },
        maybeSingle: async () => ({ data: state.row, error: null }),
      };
      return b;
    },
  },
}));

import { useCurrentSupplier } from "./use-current-supplier";

beforeEach(() => {
  state.session = { user: { id: "user-1" } };
  state.row = { supplier_id: "sup-1" };
  state.filters = [];
});

describe("useCurrentSupplier", () => {
  it("查啟用中的 supplier_accounts,回傳 supplier_id", async () => {
    const { result } = renderHook(() => useCurrentSupplier());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current).toEqual({ supplierId: "sup-1", loading: false, error: null }));
    expect(state.filters).toEqual([
      ["user_id", "user-1"],
      ["is_active", true],
    ]);
  });

  it("沒有綁定供應商 → error", async () => {
    state.row = null;
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("找不到你的供應商帳號"));
  });

  it("沒登入 → error", async () => {
    state.session = null;
    const { result } = renderHook(() => useCurrentSupplier());
    await waitFor(() => expect(result.current.error).toBe("尚未登入"));
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/hooks/use-current-supplier.test.tsx`

Expected:FAIL,`Failed to resolve import "./use-current-supplier"`

**Step 3:寫實作**

```ts
// 目前登入者所屬的供應商 id(供應商後台的零售市集頁共用)。
// 跟 SupplierCatalogPage / SupplierOrdersPage 原本各寫一份的查法一樣:supplier_accounts 啟用中的那一列。
// 頁面外層已經有 SupplierRoute 擋未登入與沒有供應商帳號的人;這裡查不到就回 error,讓頁面顯示原因。
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CurrentSupplier {
  supplierId: string | null;
  loading: boolean;
  error: string | null;
}

type AccountQuery = PromiseLike<{ data: { supplier_id: string } | null; error: { message: string } | null }>;

export const useCurrentSupplier = (): CurrentSupplier => {
  const [state, setState] = useState<CurrentSupplier>({ supplierId: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          if (!cancelled) setState({ supplierId: null, loading: false, error: "尚未登入" });
          return;
        }
        const { data, error } = await (supabase as never as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { maybeSingle: () => AccountQuery } };
            };
          };
        })
          .from("supplier_accounts")
          .select("supplier_id")
          .eq("user_id", session.user.id)
          .eq("is_active", true)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data) setState({ supplierId: null, loading: false, error: error?.message ?? "找不到你的供應商帳號" });
        else setState({ supplierId: data.supplier_id, loading: false, error: null });
      } catch (e) {
        if (!cancelled) setState({ supplierId: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  3 passed (3)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/hooks/use-current-supplier.ts src/hooks/use-current-supplier.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): useCurrentSupplier —— 目前登入者的供應商 id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 20:店家設定的表單邏輯 `store.ts`

驗證規則跟資料庫 CHECK 同一套(至少一個縣市、運費 / 免運門檻 / 最低金額範圍、出貨天數、勾轉帳就要填 5–300 字的轉帳資訊);儲存時**先寫轉帳資訊再寫店家**(資料庫 guard 要求勾轉帳前已經有轉帳資訊)。

**Files:**
- Create: `src/lib/market/store.ts`
- Test: `src/lib/market/store.test.ts`

**Step 1:寫失敗的測試**

```ts
// store.ts:表單 ↔ 資料列、驗證(上限跟資料庫一樣)、儲存順序(轉帳資訊一定先存)。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ table: string; op: string; payload: unknown; opts?: unknown }> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const b = {
        upsert: (payload: unknown, opts: unknown) => {
          calls.push({ table, op: "upsert", payload, opts });
          return b;
        },
        select: () => b,
        eq: () => b,
        single: async () => ({ data: { supplier_id: "sup-1" }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      return b;
    },
  },
}));

import { STORE_A } from "./testFixtures";
import { emptyStoreForm, saveStore, storeFormFromRow, storePayload, validateStoreForm, type StoreForm } from "./store";

const valid = (over: Partial<StoreForm> = {}): StoreForm => ({
  ...emptyStoreForm(),
  deliveryCities: ["臺北市"],
  shippingFee: "120",
  freeShippingThreshold: "1000",
  minOrderAmount: "300",
  shipDays: "2",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
});

describe("validateStoreForm", () => {
  it("合法的表單沒有錯誤", () => {
    expect(validateStoreForm(valid())).toEqual({});
  });

  it("至少一個縣市、至少一種付款方式", () => {
    expect(validateStoreForm(valid({ deliveryCities: [] })).deliveryCities).toBe("至少選一個配送縣市");
    expect(validateStoreForm(valid({ acceptCod: false, acceptTransfer: false })).acceptCod).toBe("至少接受一種付款方式");
  });

  it("金額與天數:整數、範圍跟資料庫一樣", () => {
    expect(validateStoreForm(valid({ shippingFee: "10001" })).shippingFee).toMatch(/0 到 10,000/);
    expect(validateStoreForm(valid({ shippingFee: "12.5" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ shippingFee: "-1" })).shippingFee).toBeDefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "" })).freeShippingThreshold).toBeUndefined();
    expect(validateStoreForm(valid({ freeShippingThreshold: "0" })).freeShippingThreshold).toBeDefined();
    expect(validateStoreForm(valid({ minOrderAmount: "abc" })).minOrderAmount).toBeDefined();
    expect(validateStoreForm(valid({ shipDays: "31" })).shipDays).toMatch(/0 到 30/);
  });

  it("勾銀行轉帳一定要填 5–300 字的轉帳資訊", () => {
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "  " })).transferInfo).toMatch(/轉帳資訊/);
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "x".repeat(301) })).transferInfo).toBeDefined();
    expect(validateStoreForm(valid({ acceptTransfer: true, transferInfo: "台灣銀行 004 帳號 123" })).transferInfo).toBeUndefined();
  });

  it("介紹與退換貨最多 1000 字", () => {
    expect(validateStoreForm(valid({ intro: "字".repeat(1001) })).intro).toBe("店家介紹最多 1000 字");
    expect(validateStoreForm(valid({ returnPolicy: "字".repeat(1001) })).returnPolicy).toBe("退換貨說明最多 1000 字");
  });
});

describe("資料列 ↔ 表單", () => {
  it("storeFormFromRow 再 storePayload 回得去", () => {
    const form = storeFormFromRow(STORE_A, "台灣銀行 004 帳號 123");
    expect(form).toMatchObject({ shippingFee: "120", freeShippingThreshold: "1000", acceptCod: true, acceptTransfer: true });
    expect(storePayload(STORE_A.supplier_id, form)).toMatchObject({
      delivery_cities: ["臺北市", "新北市"],
      shipping_fee: 120,
      free_shipping_threshold: 1000,
      min_order_amount: 300,
      ship_days: 2,
      payment_methods: ["cod", "transfer"],
      intro: "當日採收的葉菜與根莖類",
    });
  });

  it("免運門檻留白 = null;空白介紹 = null", () => {
    expect(storePayload("s", valid({ freeShippingThreshold: " ", intro: "  " }))).toMatchObject({
      free_shipping_threshold: null,
      intro: null,
    });
  });
});

describe("saveStore", () => {
  it("接受轉帳:先存轉帳資訊、再存店家", async () => {
    await saveStore("sup-1", valid({ acceptTransfer: true, transferInfo: " 台灣銀行 004 帳號 123 " }));
    expect(calls.map((c) => c.table)).toEqual(["market_store_transfer", "market_stores"]);
    expect(calls[0].payload).toEqual({ supplier_id: "sup-1", transfer_info: "台灣銀行 004 帳號 123" });
    expect(calls[1].opts).toEqual({ onConflict: "supplier_id" });
  });

  it("只收貨到付款:不碰轉帳資訊", async () => {
    await saveStore("sup-1", valid());
    expect(calls.map((c) => c.table)).toEqual(["market_stores"]);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/store.test.ts`

Expected:FAIL,`Failed to resolve import "./store"`

**Step 3:寫實作**

```ts
// 供應商「零售市集 › 店家設定」的表單邏輯:資料列 ↔ 表單、驗證(跟資料庫 CHECK 同樣的上限)、儲存。
//
// 儲存順序:勾了銀行轉帳 → 先 upsert market_store_transfer,再 upsert market_stores
// (資料庫的 market_stores_guard 會檢查「接受轉帳一定要已經有轉帳資訊」,所以轉帳資訊要先存)。
import { isTwCity, LIMITS, type PaymentMethod, type TwCity } from "./constants";
import { marketDb, unwrap } from "./db";
import type { MarketStoreRow } from "./types";

export interface StoreForm {
  intro: string;
  returnPolicy: string;
  deliveryCities: TwCity[];
  shippingFee: string;
  freeShippingThreshold: string;
  minOrderAmount: string;
  shipDays: string;
  acceptCod: boolean;
  acceptTransfer: boolean;
  transferInfo: string;
  logoPath: string | null;
  coverPath: string | null;
}

export type StoreFormErrors = Partial<Record<keyof StoreForm, string>>;

export const emptyStoreForm = (): StoreForm => ({
  intro: "",
  returnPolicy: "",
  deliveryCities: [],
  shippingFee: "0",
  freeShippingThreshold: "",
  minOrderAmount: "0",
  shipDays: "3",
  acceptCod: true,
  acceptTransfer: false,
  transferInfo: "",
  logoPath: null,
  coverPath: null,
});

export const storeFormFromRow = (row: MarketStoreRow, transferInfo: string | null): StoreForm => ({
  intro: row.intro ?? "",
  returnPolicy: row.return_policy ?? "",
  deliveryCities: row.delivery_cities.filter(isTwCity),
  shippingFee: String(row.shipping_fee),
  freeShippingThreshold: row.free_shipping_threshold == null ? "" : String(row.free_shipping_threshold),
  minOrderAmount: String(row.min_order_amount),
  shipDays: String(row.ship_days),
  acceptCod: row.payment_methods.includes("cod"),
  acceptTransfer: row.payment_methods.includes("transfer"),
  transferInfo: transferInfo ?? "",
  logoPath: row.logo_path,
  coverPath: row.cover_path,
});

/** 只接受純數字的整數字串 */
const toInt = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);
const inRange = (s: string, min: number, max: number) => {
  const n = toInt(s);
  return Number.isInteger(n) && n >= min && n <= max;
};

export const validateStoreForm = (f: StoreForm): StoreFormErrors => {
  const e: StoreFormErrors = {};
  if (f.deliveryCities.length === 0) e.deliveryCities = "至少選一個配送縣市";
  if (!inRange(f.shippingFee, 0, LIMITS.shippingFee)) e.shippingFee = `運費要是 0 到 ${LIMITS.shippingFee.toLocaleString("zh-TW")} 的整數`;
  if (f.freeShippingThreshold.trim() && !inRange(f.freeShippingThreshold, 1, LIMITS.freeShippingThreshold)) {
    e.freeShippingThreshold = "免運門檻要是大於 0 的整數(不提供免運就留白)";
  }
  if (!inRange(f.minOrderAmount, 0, LIMITS.minOrderAmount)) e.minOrderAmount = "最低訂購金額要是 0 以上的整數(沒有就填 0)";
  if (!inRange(f.shipDays, 0, LIMITS.shipDays)) e.shipDays = `出貨天數要是 0 到 ${LIMITS.shipDays} 的整數`;
  if (!f.acceptCod && !f.acceptTransfer) e.acceptCod = "至少接受一種付款方式";
  if (f.acceptTransfer) {
    const len = f.transferInfo.trim().length;
    if (len < LIMITS.transferInfoMin || len > LIMITS.transferInfo) {
      e.transferInfo = `接受銀行轉帳要填轉帳資訊(${LIMITS.transferInfoMin}–${LIMITS.transferInfo} 字:銀行、分行、帳號、戶名)`;
    }
  }
  if (f.intro.length > LIMITS.storeIntro) e.intro = `店家介紹最多 ${LIMITS.storeIntro} 字`;
  if (f.returnPolicy.length > LIMITS.returnPolicy) e.returnPolicy = `退換貨說明最多 ${LIMITS.returnPolicy} 字`;
  return e;
};

export const storePayload = (supplierId: string, f: StoreForm) => {
  const methods: PaymentMethod[] = [];
  if (f.acceptCod) methods.push("cod");
  if (f.acceptTransfer) methods.push("transfer");
  return {
    supplier_id: supplierId,
    intro: f.intro.trim() || null,
    return_policy: f.returnPolicy.trim() || null,
    delivery_cities: f.deliveryCities,
    shipping_fee: toInt(f.shippingFee),
    free_shipping_threshold: f.freeShippingThreshold.trim() ? toInt(f.freeShippingThreshold) : null,
    min_order_amount: toInt(f.minOrderAmount),
    ship_days: toInt(f.shipDays),
    payment_methods: methods,
    logo_path: f.logoPath,
    cover_path: f.coverPath,
  };
};

export const STORE_OWNER_COLUMNS =
  "supplier_id, is_enabled, disabled_reason, logo_path, cover_path, intro, return_policy, delivery_cities, shipping_fee, " +
  "free_shipping_threshold, min_order_amount, ship_days, payment_methods, updated_at";

export const fetchOwnStore = async (supplierId: string): Promise<{ store: MarketStoreRow | null; transferInfo: string | null }> => {
  const store = unwrap(
    await marketDb<MarketStoreRow>("market_stores").select(STORE_OWNER_COLUMNS).eq("supplier_id", supplierId).maybeSingle(),
  );
  const transfer = unwrap(
    await marketDb<{ transfer_info: string }>("market_store_transfer").select("transfer_info").eq("supplier_id", supplierId).maybeSingle(),
  );
  return { store, transferInfo: transfer?.transfer_info ?? null };
};

export const saveStore = async (supplierId: string, f: StoreForm): Promise<MarketStoreRow> => {
  if (f.acceptTransfer) {
    unwrap(
      await marketDb("market_store_transfer").upsert(
        { supplier_id: supplierId, transfer_info: f.transferInfo.trim() },
        { onConflict: "supplier_id" },
      ),
    );
  }
  return unwrap(
    await marketDb<MarketStoreRow>("market_stores")
      .upsert(storePayload(supplierId, f), { onConflict: "supplier_id" })
      .select(STORE_OWNER_COLUMNS)
      .single(),
  );
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  9 passed (9)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/store.ts src/lib/market/store.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售店家設定的驗證與儲存(先寫轉帳資訊再寫店家)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 21:供應商「零售市集 › 店家設定」頁

logo、封面、介紹、配送縣市(22 個勾選框)、固定運費、免運門檻、最低訂購金額、出貨天數、付款方式、轉帳資訊、退換貨說明;錯誤顯示在欄位旁(`aria-invalid` + `aria-describedby`);被管理員停用時最上面顯示原因。

**Files:**
- Create: `src/pages/supplier/market/MarketImageField.tsx`
- Create: `src/pages/supplier/SupplierMarketStorePage.tsx`
- Test: `src/pages/supplier/SupplierMarketStorePage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 供應商「店家設定」:讀既有設定、驗證錯誤顯示在欄位旁(aria-invalid)、儲存、被停用時顯示原因。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/hooks/use-current-supplier", () => ({
  useCurrentSupplier: () => ({ supplierId: "a9200000-0000-4000-8000-00000000000a", loading: false, error: null }),
}));
vi.mock("@/lib/market/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/store")>()),
  fetchOwnStore: vi.fn(),
  saveStore: vi.fn(),
}));

import { fetchOwnStore, saveStore } from "@/lib/market/store";
import { STORE_A } from "@/lib/market/testFixtures";
import SupplierMarketStorePage from "./SupplierMarketStorePage";

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierMarketStorePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(fetchOwnStore).mockResolvedValue({ store: null, transferInfo: null });
  vi.mocked(saveStore).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("SupplierMarketStorePage", () => {
  it("還沒建店:沒選縣市就儲存 → 縣市欄位顯示錯誤,不會送出", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "儲存店家設定" }));
    expect(await screen.findByText("至少選一個配送縣市")).toBeInTheDocument();
    expect(saveStore).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("有欄位需要修正", { description: "至少選一個配送縣市" });
  });

  it("勾銀行轉帳就出現轉帳資訊欄位,沒填會被擋並標 aria-invalid", async () => {
    renderPage();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.click(screen.getByLabelText(/銀行轉帳/));
    const info = screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    expect(info).toHaveAttribute("aria-invalid", "true");
    expect(info).toHaveAttribute("aria-describedby", "store-transferInfo-error");
    expect(saveStore).not.toHaveBeenCalled();
  });

  it("填好就儲存,送出的表單帶選的縣市與運費", async () => {
    renderPage();
    await userEvent.click(await screen.findByLabelText("臺北市"));
    await userEvent.clear(screen.getByLabelText("固定運費(元)"));
    await userEvent.type(screen.getByLabelText("固定運費(元)"), "120");
    await userEvent.click(screen.getByRole("button", { name: "儲存店家設定" }));
    await waitFor(() => expect(saveStore).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveStore).mock.calls[0][1]).toMatchObject({ deliveryCities: ["臺北市"], shippingFee: "120", acceptCod: true });
    expect(toastSuccess).toHaveBeenCalledWith("已儲存店家設定");
  });

  it("已有設定就帶入;被平台停用時顯示原因", async () => {
    vi.mocked(fetchOwnStore).mockResolvedValue({
      store: { ...STORE_A, is_enabled: false, disabled_reason: "客訴處理中" },
      transferInfo: "台灣銀行 004 帳號 123",
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("原因:客訴處理中");
    expect(screen.getByLabelText("新北市")).toBeChecked();
    expect(screen.getByLabelText("轉帳資訊(銀行、分行、帳號、戶名)")).toHaveValue("台灣銀行 004 帳號 123");
    expect(screen.getByRole("link", { name: "看消費者看到的店家頁" })).toHaveAttribute("href", `/market/s/${STORE_A.supplier_id}`);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/SupplierMarketStorePage.test.tsx`

Expected:FAIL,`Failed to resolve import "./SupplierMarketStorePage"`

**Step 3:寫實作**

`src/pages/supplier/market/MarketImageField.tsx`(logo / 封面共用的單張圖片上傳):

```tsx
// 單張圖片欄位(店家 logo、封面):選檔 → 瀏覽器壓縮 → 上傳到 <supplier_id>/store/ → 回傳路徑給表單。
// 換圖或移除時不刪舊檔(舊檔可能還被已儲存的設定引用;孤兒檔無害)。
import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { publicImageUrl, uploadMarketImage } from "@/lib/market/images";

interface MarketImageFieldProps {
  label: string;
  hint?: string;
  supplierId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
}

export default function MarketImageField({ label, hint, supplierId, value, onChange, upload = uploadMarketImage }: MarketImageFieldProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await upload(supplierId, "store", file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        {value ? (
          <img src={publicImageUrl(value)} alt={`目前的${label}`} width={96} height={96} className="h-24 w-24 rounded-md border border-slate-200 object-cover" />
        ) : (
          <span className="flex h-24 w-24 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs text-slate-500">
            尚未上傳
          </span>
        )}
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
          className="text-sm"
        />
        {busy ? (
          <span className="inline-flex items-center gap-1 text-sm text-slate-600" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            上傳中…
          </span>
        ) : null}
        {value && !busy ? (
          <button type="button" onClick={() => onChange(null)} className="min-h-11 rounded-md px-3 text-sm text-red-700 hover:bg-red-50">
            移除{label}
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

`src/pages/supplier/SupplierMarketStorePage.tsx`:

```tsx
// 供應商後台「零售市集 › 店家設定」(/supplier/market/store):logo、封面、介紹、配送縣市、固定運費、免運門檻、
// 最低訂購金額、出貨天數、接受的付款方式、轉帳資訊、退換貨說明。
// 驗證規則在 src/lib/market/store.ts(跟資料庫 CHECK 同一套上限);資料庫的 guard 再擋一次(例如沒填轉帳資訊卻勾轉帳)。
// 「零售啟用」只有管理員能改:被停用時這頁最上面顯示原因。
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCurrentSupplier } from "@/hooks/use-current-supplier";
import { LIMITS, TW_CITIES, type TwCity } from "@/lib/market/constants";
import { friendlyDbError } from "@/lib/market/db";
import {
  emptyStoreForm,
  fetchOwnStore,
  saveStore,
  storeFormFromRow,
  validateStoreForm,
  type StoreForm,
  type StoreFormErrors,
} from "@/lib/market/store";
import type { MarketStoreRow } from "@/lib/market/types";
import MarketImageField from "./market/MarketImageField";

const INPUT = "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700";

const FieldError = ({ id, message }: { id: string; message?: string }) =>
  message ? (
    <p id={id} className="mt-1 text-sm text-red-700">
      {message}
    </p>
  ) : null;

export default function SupplierMarketStorePage() {
  const { supplierId, loading: idLoading, error: idError } = useCurrentSupplier();
  const [row, setRow] = useState<MarketStoreRow | null>(null);
  const [form, setForm] = useState<StoreForm>(emptyStoreForm());
  const [errors, setErrors] = useState<StoreFormErrors>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      try {
        const { store, transferInfo } = await fetchOwnStore(supplierId);
        if (cancelled) return;
        setRow(store);
        setForm(store ? storeFormFromRow(store, transferInfo) : emptyStoreForm());
      } catch (e) {
        toast.error("讀取店家設定失敗", { description: friendlyDbError(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  const set = <K extends keyof StoreForm>(key: K, value: StoreForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleCity = (city: TwCity) =>
    set("deliveryCities", form.deliveryCities.includes(city) ? form.deliveryCities.filter((c) => c !== city) : [...form.deliveryCities, city]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supplierId) return;
    const errs = validateStoreForm(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.error("有欄位需要修正", { description: Object.values(errs)[0] });
      return;
    }
    setSaving(true);
    try {
      setRow(await saveStore(supplierId, form));
      toast.success("已儲存店家設定");
    } catch (err) {
      toast.error("儲存失敗", { description: friendlyDbError(err) });
    } finally {
      setSaving(false);
    }
  };

  if (idLoading || (supplierId && loading)) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="animate-spin text-emerald-600" size={28} aria-label="載入中" />
      </div>
    );
  }
  if (!supplierId) return <p className="p-6 text-slate-600">{idError ?? "此帳號尚未綁定供應商"}</p>;

  const describe = (key: keyof StoreForm) => (errors[key] ? `store-${key}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">店家設定</h1>
        <p className="text-sm text-gray-500">
          消費者在 iFoodmap 食材市集看到的店家資訊與配送、付款條件。零售商品請到「商品與價格 › 商品目錄」的「零售商品」分頁上架。
        </p>
        {row ? (
          <p className="mt-2 text-sm">
            <Link to={`/market/s/${supplierId}`} className="text-emerald-800 underline underline-offset-2">
              看消費者看到的店家頁
            </Link>
          </p>
        ) : null}
      </div>

      {row && !row.is_enabled ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          平台已暫停你的零售(消費者看不到你的店家與商品)。原因:{row.disabled_reason ?? "未說明"}。有問題請聯絡 iFoodmap。
        </div>
      ) : null}

      <section className="space-y-4" aria-labelledby="store-look">
        <h2 id="store-look" className="font-semibold text-gray-900">
          外觀與介紹
        </h2>
        <MarketImageField label="店家 logo" hint="正方形最好看;JPG、PNG、WebP" supplierId={supplierId} value={form.logoPath} onChange={(p) => set("logoPath", p)} />
        <MarketImageField label="店家封面" hint="橫式,建議 3:1" supplierId={supplierId} value={form.coverPath} onChange={(p) => set("coverPath", p)} />
        <div>
          <label htmlFor="store-intro" className="mb-1 block text-sm font-medium text-slate-700">
            店家介紹
          </label>
          <textarea
            id="store-intro"
            rows={4}
            maxLength={LIMITS.storeIntro}
            value={form.intro}
            onChange={(e) => set("intro", e.target.value)}
            aria-invalid={!!errors.intro}
            aria-describedby={describe("intro")}
            className={`${INPUT} py-2`}
          />
          <FieldError id="store-intro-error" message={errors.intro} />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="store-delivery">
        <h2 id="store-delivery" className="font-semibold text-gray-900">
          配送
        </h2>
        <fieldset aria-describedby={describe("deliveryCities")}>
          <legend className="mb-2 text-sm font-medium text-slate-700">配送縣市(收件地址不在這裡的訂單不能結帳)</legend>
          <div className="mb-2 flex gap-2">
            <button type="button" onClick={() => set("deliveryCities", [...TW_CITIES])} className="min-h-11 rounded-md border border-slate-300 px-3 text-sm">
              全選
            </button>
            <button type="button" onClick={() => set("deliveryCities", [])} className="min-h-11 rounded-md border border-slate-300 px-3 text-sm">
              清除
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 min-[640px]:grid-cols-4">
            {TW_CITIES.map((c) => (
              <label key={c} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={form.deliveryCities.includes(c)} onChange={() => toggleCity(c)} className="h-5 w-5" />
                {c}
              </label>
            ))}
          </div>
          <FieldError id="store-deliveryCities-error" message={errors.deliveryCities} />
        </fieldset>
        <div className="grid gap-4 min-[640px]:grid-cols-2">
          {(
            [
              ["shippingFee", "固定運費(元)", "0 = 免運費"],
              ["freeShippingThreshold", "滿多少免運(元)", "不提供免運就留白"],
              ["minOrderAmount", "最低訂購金額(元)", "沒有就填 0;看商品小計,不含運費"],
              ["shipDays", "幾個工作天內出貨", "0 = 當天出貨"],
            ] as Array<[keyof StoreForm, string, string]>
          ).map(([key, label, hint]) => (
            <div key={key}>
              <label htmlFor={`store-${key}`} className="mb-1 block text-sm font-medium text-slate-700">
                {label}
              </label>
              <input
                id={`store-${key}`}
                inputMode="numeric"
                value={String(form[key])}
                onChange={(e) => set(key, e.target.value as never)}
                aria-invalid={!!errors[key]}
                aria-describedby={describe(key) ?? `store-${key}-hint`}
                className={INPUT}
              />
              <p id={`store-${key}-hint`} className="mt-1 text-xs text-slate-500">
                {hint}
              </p>
              <FieldError id={`store-${key}-error`} message={errors[key]} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="store-payment">
        <h2 id="store-payment" className="font-semibold text-gray-900">
          付款(店家自己收款,平台不經手)
        </h2>
        <fieldset aria-describedby={describe("acceptCod")}>
          <legend className="sr-only">接受的付款方式</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={form.acceptCod} onChange={(e) => set("acceptCod", e.target.checked)} className="h-5 w-5" />
            貨到付款
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={form.acceptTransfer} onChange={(e) => set("acceptTransfer", e.target.checked)} className="h-5 w-5" />
            銀行轉帳(接單後,消費者會在訂單查詢頁看到下面的轉帳資訊)
          </label>
          <FieldError id="store-acceptCod-error" message={errors.acceptCod} />
        </fieldset>
        {form.acceptTransfer ? (
          <div>
            <label htmlFor="store-transferInfo" className="mb-1 block text-sm font-medium text-slate-700">
              轉帳資訊(銀行、分行、帳號、戶名)
            </label>
            <textarea
              id="store-transferInfo"
              rows={3}
              maxLength={LIMITS.transferInfo}
              value={form.transferInfo}
              onChange={(e) => set("transferInfo", e.target.value)}
              aria-invalid={!!errors.transferInfo}
              aria-describedby={describe("transferInfo")}
              className={`${INPUT} py-2`}
            />
            <FieldError id="store-transferInfo-error" message={errors.transferInfo} />
          </div>
        ) : null}
        <div>
          <label htmlFor="store-returnPolicy" className="mb-1 block text-sm font-medium text-slate-700">
            退換貨說明
          </label>
          <textarea
            id="store-returnPolicy"
            rows={3}
            maxLength={LIMITS.returnPolicy}
            value={form.returnPolicy}
            onChange={(e) => set("returnPolicy", e.target.value)}
            placeholder="例:生鮮食品收到後 24 小時內有問題請拍照聯絡我們"
            aria-invalid={!!errors.returnPolicy}
            aria-describedby={describe("returnPolicy")}
            className={`${INPUT} py-2`}
          />
          <FieldError id="store-returnPolicy-error" message={errors.returnPolicy} />
        </div>
      </section>

      <Button type="submit" disabled={saving} className="min-h-11 bg-emerald-700 text-white hover:bg-emerald-800">
        {saving ? "儲存中…" : "儲存店家設定"}
      </Button>
    </form>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  4 passed (4)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/supplier/market/MarketImageField.tsx src/pages/supplier/SupplierMarketStorePage.tsx src/pages/supplier/SupplierMarketStorePage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 供應商零售店家設定頁

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 22:供應商後台加「零售市集」分區與 `/supplier/market/store` 路由

**Files:**
- Modify: `src/pages/supplier/SupplierLayout.tsx:2-5`(icon import)、`src/pages/supplier/SupplierLayout.tsx:71-81`(在 `sections` 最後加一個分區)
- Modify: `src/App.tsx:72`(import)、`src/App.tsx:177`(路由)
- Test: `src/pages/supplier/SupplierLayout.test.tsx`

**Step 1:改測試(側欄變 6 個分區、新路由落在「零售市集」)**

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
// 第二期(Q1-A):訂單分區的收單/報價/出貨合成一個訂單頁(頁面自己用 ?stage= 狀態分頁),
// 版面不再畫訂單分區的分頁列;舊網址轉址到 /supplier/orders?stage=…(轉址寫法與 App.tsx 相同)。
// 這裡驗證:①側欄剛好 5 項 ②分頁依路由標出 active ③舊路由全部還能開、
// 落在正確的分區與分頁 ④定價助手從選單/分頁收起來但路由仍可直接開 ⑤鍵盤與 aria。
//
```

換成:

```tsx
// 第二期(Q1-A):訂單分區的收單/報價/出貨合成一個訂單頁(頁面自己用 ?stage= 狀態分頁),
// 版面不再畫訂單分區的分頁列;舊網址轉址到 /supplier/orders?stage=…(轉址寫法與 App.tsx 相同)。
// 這裡驗證:①側欄剛好 6 項(2026-10 加「零售市集」) ②分頁依路由標出 active ③舊路由全部還能開、
// 落在正確的分區與分頁 ④定價助手從選單/分頁收起來但路由仍可直接開 ⑤鍵盤與 aria。
//
```

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
          <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
          <Route path="reviews" element={<h1>我的評價頁</h1>} />
        </Route>
      </Routes>
```

換成:

```tsx
          <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
          <Route path="reviews" element={<h1>我的評價頁</h1>} />
          <Route path="market/store" element={<h1>店家設定頁</h1>} />
        </Route>
      </Routes>
```

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
});

describe("SupplierLayout — 側欄剛好 5 個分區", () => {
  it("桌機側欄是 5 個分區連結,文字依序為:總覽、訂單、商機、商品與價格、客戶與評價", () => {
    renderLayout("/supplier");
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    const links = within(desktopNav).getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價"]);
  });

  it("手機抽屜也是同樣 5 個分區連結", () => {
    renderLayout("/supplier");
    const mobileNav = screen.getByTestId("supplier-sidebar-mobile");
    const links = within(mobileNav).getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價"]);
  });

```

換成:

```tsx
});

describe("SupplierLayout — 側欄剛好 6 個分區", () => {
  it("桌機側欄是 6 個分區連結,文字依序為:總覽、訂單、商機、商品與價格、客戶與評價、零售市集", () => {
    renderLayout("/supplier");
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    const links = within(desktopNav).getAllByRole("link");
    expect(links).toHaveLength(6);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價", "零售市集"]);
  });

  it("手機抽屜也是同樣 6 個分區連結", () => {
    renderLayout("/supplier");
    const mobileNav = screen.getByTestId("supplier-sidebar-mobile");
    const links = within(mobileNav).getAllByRole("link");
    expect(links).toHaveLength(6);
    expect(links.map((l) => l.textContent)).toEqual(["總覽", "訂單", "商機", "商品與價格", "客戶與評價", "零售市集"]);
  });

```

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktopNav).getByRole("link", { name: "訂單" })).toHaveAttribute("aria-current", "page");
    ["總覽", "商機", "商品與價格", "客戶與評價"].forEach((label) => {
      expect(within(desktopNav).getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    });
```

換成:

```tsx
    const desktopNav = screen.getByTestId("supplier-sidebar-desktop");
    expect(within(desktopNav).getByRole("link", { name: "訂單" })).toHaveAttribute("aria-current", "page");
    ["總覽", "商機", "商品與價格", "客戶與評價", "零售市集"].forEach((label) => {
      expect(within(desktopNav).getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
    });
```

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
    ["/supplier/customers", "客戶管理頁", "客戶與評價", ["客戶", "評價"], "客戶"],
    ["/supplier/reviews", "我的評價頁", "客戶與評價", ["客戶", "評價"], "評價"],
  ])("%s → 頁面 %s,分區「%s」", (path, heading, sectionLabel, expectedTabs, activeTab) => {
    renderLayout(path);
```

換成:

```tsx
    ["/supplier/customers", "客戶管理頁", "客戶與評價", ["客戶", "評價"], "客戶"],
    ["/supplier/reviews", "我的評價頁", "客戶與評價", ["客戶", "評價"], "評價"],
    // 零售市集第 1 階段只有一個分頁 → 不畫分頁列
    ["/supplier/market/store", "店家設定頁", "零售市集", null as string[] | null, null as string | null],
  ])("%s → 頁面 %s,分區「%s」", (path, heading, sectionLabel, expectedTabs, activeTab) => {
    renderLayout(path);
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/SupplierLayout.test.tsx`

Expected:FAIL,側欄連結 `expected […] to have a length of 6 but got 5`,以及 `/supplier/market/store` 那一列找不到「零售市集」。

**Step 3:改 `SupplierLayout.tsx` 與 `App.tsx`**

在 `src/pages/supplier/SupplierLayout.tsx` 找到:

```tsx
import {
  Inbox, Boxes, Radar, Users, LogOut,
  LayoutDashboard, Menu, X, type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
```

換成:

```tsx
import {
  Inbox, Boxes, Radar, Users, LogOut,
  LayoutDashboard, Menu, X, Store, type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
```

在 `src/pages/supplier/SupplierLayout.tsx` 找到:

```tsx
      { label: "評價", path: "/supplier/reviews" },
    ],
  },
];
```

換成:

```tsx
      { label: "評價", path: "/supplier/reviews" },
    ],
  },
  {
    // 消費者食材市集(B2C):跟餐廳的詢價訂單完全分開。零售商品在「商品與價格 › 商品目錄」的「零售商品」分頁
    key: "market",
    to: "/supplier/market/store",
    label: "零售市集",
    icon: Store,
    match: startsWithAny(["/supplier/market"]),
    tabs: [{ label: "店家設定", path: "/supplier/market/store" }],
  },
];
```

在 `src/App.tsx` 找到:

```tsx
import SupplierCustomersPage from "./pages/supplier/SupplierCustomersPage";
import SupplierReviewsPage from "./pages/supplier/SupplierReviewsPage";

// 餐廳後台(僅前台站)
```

換成:

```tsx
import SupplierCustomersPage from "./pages/supplier/SupplierCustomersPage";
import SupplierReviewsPage from "./pages/supplier/SupplierReviewsPage";
import SupplierMarketStorePage from "./pages/supplier/SupplierMarketStorePage";

// 餐廳後台(僅前台站)
```

在 `src/App.tsx` 找到:

```tsx
      <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
      <Route path="reviews" element={<SupplierReviewsPage />} />
    </Route>

```

換成:

```tsx
      <Route path="shipments" element={<Navigate to="/supplier/orders?stage=shipped" replace />} />
      <Route path="reviews" element={<SupplierReviewsPage />} />
      {/* 零售市集(B2C) */}
      <Route path="market/store" element={<SupplierMarketStorePage />} />
    </Route>

```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  24 passed (24)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/supplier/SupplierLayout.tsx src/pages/supplier/SupplierLayout.test.tsx src/App.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 供應商後台加「零售市集」分區與店家設定路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 23:零售商品的表單邏輯 `productForm.ts`

從批發商品帶入品名與規格(`SupplySeed`);驗證跟資料庫 CHECK 同一套;`saveMarketProduct` 新增時用畫面打開時就決定的 id(照片已經上傳到那個資料夾);`productActions(status)` 決定按鈕(草稿可存草稿 / 送審、退回可修改後重送、已核准改內容會回到待審並提醒)。

**Files:**
- Create: `src/lib/market/productForm.ts`
- Test: `src/lib/market/productForm.test.ts`

**Step 1:寫失敗的測試**

```ts
// productForm.ts:B2B 商品帶入、驗證上限、payload、新增 / 修改 / 送審送出的內容、各狀態的按鈕。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ op: string; payload?: unknown; filters: unknown[] }> }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const call = { op: "select", payload: undefined as unknown, filters: [] as unknown[] };
      calls.push(call);
      const b = {
        insert: (v: unknown) => {
          call.op = "insert";
          call.payload = v;
          return b;
        },
        update: (v: unknown) => {
          call.op = "update";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        select: () => b,
        single: async () => ({ data: { id: "p1" }, error: null }),
      };
      return b;
    },
  },
}));

import { CABBAGE } from "./testFixtures";
import {
  emptyProductForm,
  productActions,
  productFormFromRow,
  productPayload,
  saveMarketProduct,
  validateProductForm,
  type ProductForm,
} from "./productForm";

const valid = (over: Partial<ProductForm> = {}): ProductForm => ({
  ...emptyProductForm(),
  name: "有機高麗菜",
  category: "vegetable",
  spec: "1 顆",
  price: "120",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
});

describe("emptyProductForm(從 B2B 商品帶入)", () => {
  it("品名、規格、說明照帶;分類剛好是 12 類的中文名稱才帶入", () => {
    const f = emptyProductForm({ id: "s1", name: "牛腱心", category: "肉品", pack_size: "5kg/箱", price: 420, description: "澳洲" });
    expect(f).toMatchObject({ name: "牛腱心", category: "meat", spec: "5kg/箱", description: "澳洲", supplyId: "s1", price: "" });
    expect(emptyProductForm({ id: "s2", name: "x", category: "肉類", pack_size: null, price: null, description: null }).category).toBe("");
  });
});

describe("validateProductForm", () => {
  it("合法的沒有錯誤", () => {
    expect(validateProductForm(valid())).toEqual({});
  });

  it("必填:品名、分類、規格、價格", () => {
    const e = validateProductForm({ ...emptyProductForm(), price: "" });
    expect(e).toMatchObject({ name: "請填品名", category: "請選分類", spec: "請填零售規格,例如:600g/盒" });
    expect(e.price).toMatch(/1 到 1,000,000/);
  });

  it("上限跟資料庫一樣:品名 60、規格 40、說明 2000、價格整數、庫存 0–100000、照片 5 張", () => {
    expect(validateProductForm(valid({ name: "菜".repeat(61) })).name).toBe("品名最多 60 字");
    expect(validateProductForm(valid({ spec: "x".repeat(41) })).spec).toBe("規格最多 40 字");
    expect(validateProductForm(valid({ description: "x".repeat(2001) })).description).toBe("說明最多 2000 字");
    expect(validateProductForm(valid({ price: "99.5" })).price).toBeDefined();
    expect(validateProductForm(valid({ price: "0" })).price).toBeDefined();
    expect(validateProductForm(valid({ unlimitedStock: false, stock: "" })).stock).toBeDefined();
    expect(validateProductForm(valid({ unlimitedStock: false, stock: "0" })).stock).toBeUndefined();
    expect(validateProductForm(valid({ photos: ["a", "b", "c", "d", "e", "f"] })).photos).toBe("照片最多 5 張");
  });
});

describe("payload 與儲存", () => {
  it("資料列 → 表單 → payload 回得去;不限庫存 = null", () => {
    expect(productPayload(productFormFromRow(CABBAGE))).toMatchObject({ name: "有機高麗菜", price: 100, stock: 10, temperature: "chilled" });
    expect(productPayload(valid()).stock).toBeNull();
    expect(productPayload(valid({ origin: "  " })).origin).toBeNull();
  });

  it("新商品:用畫面先決定的 id 新增;送審 → pending、存草稿 → draft", async () => {
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: true, form: valid(), submit: true });
    expect(calls[0]).toMatchObject({ op: "insert", payload: { id: "p1", supplier_id: "sup", review_status: "pending", price: 120 } });
    await saveMarketProduct({ supplierId: "sup", productId: "p2", isNew: true, form: valid(), submit: false });
    expect(calls[1].payload).toMatchObject({ review_status: "draft" });
  });

  it("修改:一般儲存不送 review_status(交給資料庫判斷要不要重審);重新送審才送 pending", async () => {
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: false });
    expect(calls[0].op).toBe("update");
    expect(calls[0].payload).not.toHaveProperty("review_status");
    expect(calls[0].filters).toEqual([["id", "p1"]]);
    await saveMarketProduct({ supplierId: "sup", productId: "p1", isNew: false, form: valid(), submit: true });
    expect(calls[1].payload).toMatchObject({ review_status: "pending" });
  });
});

describe("productActions", () => {
  it("新商品 / 草稿:儲存草稿 + 送出審核", () => {
    expect(productActions(null)).toMatchObject({ secondary: { label: "儲存草稿" }, primary: { label: "送出審核", submit: true } });
    expect(productActions("draft").primary.label).toBe("送出審核");
  });

  it("退回:可以先存不送審,或重新送審", () => {
    expect(productActions("rejected")).toMatchObject({ secondary: { label: "儲存(先不送審)" }, primary: { label: "重新送審", submit: true } });
  });

  it("審核中、已核准:只有儲存;已核准提醒哪些欄位會重審", () => {
    expect(productActions("pending")).toMatchObject({ secondary: null, primary: { label: "儲存", submit: false } });
    expect(productActions("approved").notice).toMatch(/只改價格、庫存、上架開關不用重審/);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/productForm.test.ts`

Expected:FAIL,`Failed to resolve import "./productForm"`

**Step 3:寫實作**

```ts
// 供應商零售商品的表單邏輯:資料列 ↔ 表單、驗證(跟資料庫 CHECK 一樣的上限)、儲存、各審核狀態下有哪些按鈕。
//
// 審核狀態由資料庫決定(market_products_guard):這裡只在「送出審核 / 重新送審」時把 review_status 設成 pending;
// 一般儲存不送 review_status —— 已核准的商品改了內容,資料庫會自己改回 pending。
import {
  CATEGORY_LABEL,
  isCategoryKey,
  LIMITS,
  PHOTO_RULES,
  type MarketCategoryKey,
  type ReviewStatus,
  type Temperature,
} from "./constants";
import { marketDb, unwrap } from "./db";
import type { MarketProductRow } from "./types";

export interface ProductForm {
  name: string;
  category: MarketCategoryKey | "";
  spec: string;
  price: string;
  unlimitedStock: boolean;
  stock: string;
  temperature: Temperature;
  origin: string;
  storageMethod: string;
  shelfLife: string;
  description: string;
  photos: string[];
  isListed: boolean;
  supplyId: string | null;
}

export type ProductFormErrors = Partial<Record<keyof ProductForm, string>>;

/** 從 B2B 商品(supplies)帶入時用得到的欄位 */
export interface SupplySeed {
  id: string;
  name: string;
  category: string | null;
  pack_size: string | null;
  price: number | null;
  description: string | null;
}

/** B2B 的分類是自由文字;剛好等於 12 類的中文名稱(或 key)才帶入 */
const categoryFromText = (text: string | null): MarketCategoryKey | "" => {
  if (!text) return "";
  const t = text.trim();
  if (isCategoryKey(t)) return t;
  const hit = (Object.entries(CATEGORY_LABEL) as Array<[MarketCategoryKey, string]>).find(([, label]) => label === t);
  return hit ? hit[0] : "";
};

export const emptyProductForm = (seed?: SupplySeed | null): ProductForm => ({
  name: seed?.name ?? "",
  category: categoryFromText(seed?.category ?? null),
  spec: seed?.pack_size ?? "",
  price: "",
  unlimitedStock: true,
  stock: "",
  temperature: "ambient",
  origin: "",
  storageMethod: "",
  shelfLife: "",
  description: seed?.description ?? "",
  photos: [],
  isListed: true,
  supplyId: seed?.id ?? null,
});

export const productFormFromRow = (row: MarketProductRow): ProductForm => ({
  name: row.name,
  category: row.category,
  spec: row.spec,
  price: String(row.price),
  unlimitedStock: row.stock === null,
  stock: row.stock === null ? "" : String(row.stock),
  temperature: row.temperature,
  origin: row.origin ?? "",
  storageMethod: row.storage_method ?? "",
  shelfLife: row.shelf_life ?? "",
  description: row.description ?? "",
  photos: [...row.photos],
  isListed: row.is_listed,
  supplyId: row.supply_id ?? null,
});

const toInt = (s: string): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);

export const validateProductForm = (f: ProductForm): ProductFormErrors => {
  const e: ProductFormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = "請填品名";
  else if (name.length > LIMITS.productName) e.name = `品名最多 ${LIMITS.productName} 字`;
  if (!f.category) e.category = "請選分類";
  const spec = f.spec.trim();
  if (!spec) e.spec = "請填零售規格,例如:600g/盒";
  else if (spec.length > LIMITS.spec) e.spec = `規格最多 ${LIMITS.spec} 字`;
  const price = toInt(f.price);
  if (!Number.isInteger(price) || price < 1 || price > LIMITS.price) e.price = "價格要是 1 到 1,000,000 的整數(新台幣)";
  if (!f.unlimitedStock) {
    const stock = toInt(f.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > LIMITS.stock) e.stock = "庫存要是 0 到 100,000 的整數(不限庫存請勾選「不限」)";
  }
  if (f.origin.trim().length > LIMITS.origin) e.origin = `產地最多 ${LIMITS.origin} 字`;
  if (f.storageMethod.trim().length > LIMITS.storageMethod) e.storageMethod = `保存方式最多 ${LIMITS.storageMethod} 字`;
  if (f.shelfLife.trim().length > LIMITS.shelfLife) e.shelfLife = `保存期限最多 ${LIMITS.shelfLife} 字`;
  if (f.description.trim().length > LIMITS.description) e.description = `說明最多 ${LIMITS.description} 字`;
  if (f.photos.length > PHOTO_RULES.maxCount) e.photos = `照片最多 ${PHOTO_RULES.maxCount} 張`;
  return e;
};

export const productPayload = (f: ProductForm) => ({
  name: f.name.trim(),
  category: f.category,
  spec: f.spec.trim(),
  price: toInt(f.price),
  stock: f.unlimitedStock ? null : toInt(f.stock),
  temperature: f.temperature,
  origin: f.origin.trim() || null,
  storage_method: f.storageMethod.trim() || null,
  shelf_life: f.shelfLife.trim() || null,
  description: f.description.trim() || null,
  photos: f.photos,
  is_listed: f.isListed,
  supply_id: f.supplyId,
});

export interface SaveProductInput {
  supplierId: string;
  productId: string;
  isNew: boolean;
  form: ProductForm;
  /** true = 送出審核 / 重新送審(review_status → pending) */
  submit: boolean;
}

export const saveMarketProduct = async ({ supplierId, productId, isNew, form, submit }: SaveProductInput): Promise<MarketProductRow> => {
  const fields = productPayload(form);
  if (isNew) {
    return unwrap(
      await marketDb<MarketProductRow>("market_products")
        .insert({ id: productId, supplier_id: supplierId, ...fields, review_status: submit ? "pending" : "draft" })
        .select("*")
        .single(),
    );
  }
  return unwrap(
    await marketDb<MarketProductRow>("market_products")
      .update(submit ? { ...fields, review_status: "pending" } : fields)
      .eq("id", productId)
      .select("*")
      .single(),
  );
};

export interface ProductActions {
  /** 次要按鈕(不送審) */
  secondary: { label: string; submit: false } | null;
  primary: { label: string; submit: boolean };
  /** 顯示在按鈕上方的提醒 */
  notice: string | null;
}

/** 各審核狀態下的按鈕(null = 新商品) */
export const productActions = (status: ReviewStatus | null): ProductActions => {
  switch (status) {
    case "pending":
      return { secondary: null, primary: { label: "儲存", submit: false }, notice: "審核中:管理員核准後才會出現在市集。" };
    case "approved":
      return {
        secondary: null,
        primary: { label: "儲存", submit: false },
        notice: "修改品名、分類、規格、溫層、產地、保存方式、保存期限、說明或照片後會重新送審(審核通過前消費者看不到);只改價格、庫存、上架開關不用重審。",
      };
    case "rejected":
      return { secondary: { label: "儲存(先不送審)", submit: false }, primary: { label: "重新送審", submit: true }, notice: null };
    default:
      return { secondary: { label: "儲存草稿", submit: false }, primary: { label: "送出審核", submit: true }, notice: null };
  }
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  10 passed (10)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/productForm.ts src/lib/market/productForm.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售商品表單驗證、儲存與送審按鈕邏輯

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 24:零售商品的照片欄、編輯視窗、清單

- `MarketPhotoField`:最多 5 張,上傳前壓縮、可刪、可調順序(第一張是封面),每張都有替代文字與 44px 的按鈕。
- `MarketProductDialog`:新增 / 修改零售商品;新商品的 id 在視窗打開時用 `newUuid()` 決定(父層每次打開給新的 `key`)。
- `useSupplierMarketProducts`:自家零售商品與「有沒有建店家」;`SupplierMarketProductsPanel` + `statusText()`:清單與狀態文字(草稿 / 待審 / 已上架 / 已下架 / 退回:原因)。

**Files:**
- Create: `src/pages/supplier/market/MarketPhotoField.tsx`
- Create: `src/pages/supplier/market/MarketProductDialog.tsx`
- Create: `src/pages/supplier/market/useSupplierMarketProducts.ts`
- Create: `src/pages/supplier/market/SupplierMarketProductsPanel.tsx`
- Test: `src/pages/supplier/market/market-supplier-components.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 供應商端零售元件:照片欄位(上傳、最多 5 張、設封面、移除)、商品視窗(驗證、送審、按鈕依狀態)。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

import { MarketDbError } from "@/lib/market/db";
import { CABBAGE, SUPPLIER_A } from "@/lib/market/testFixtures";
import type { MarketProductRow } from "@/lib/market/types";
import MarketPhotoField from "./MarketPhotoField";
import MarketProductDialog from "./MarketProductDialog";
import SupplierMarketProductsPanel, { statusText } from "./SupplierMarketProductsPanel";

afterEach(cleanup);

const photo = (n: number) => `${SUPPLIER_A}/${CABBAGE.id}/a9900000-0000-4000-8000-00000000000${n}.jpg`;
const file = (name = "a.jpg") => new File(["x"], name, { type: "image/jpeg" });

const PhotoHarness = ({ initial, upload }: { initial: string[]; upload: (s: string, f: string, file: File) => Promise<string> }) => {
  const [value, setValue] = useState(initial);
  return <MarketPhotoField supplierId={SUPPLIER_A} productId={CABBAGE.id} category="vegetable" value={value} onChange={setValue} upload={upload} />;
};

describe("MarketPhotoField", () => {
  it("選檔就上傳到 <supplier>/<商品 id>,路徑加進清單", async () => {
    const upload = vi.fn().mockResolvedValueOnce(photo(1)).mockResolvedValueOnce(photo(2));
    render(<PhotoHarness initial={[]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file("a.jpg"), file("b.jpg")]);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(upload).toHaveBeenCalledWith(SUPPLIER_A, CABBAGE.id, expect.any(File));
    expect(screen.getByText("封面")).toBeInTheDocument();
  });

  it("已經 4 張再選 3 張:只傳 1 張,提示多的略過;5 張就不能再選", async () => {
    const upload = vi.fn().mockResolvedValue(photo(5));
    render(<PhotoHarness initial={[photo(1), photo(2), photo(3), photo(4)]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file("a.jpg"), file("b.jpg"), file("c.jpg")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("最多 5 張,多的已略過")).toBeInTheDocument();
    expect(screen.getByLabelText("新增照片")).toBeDisabled();
  });

  it("設為封面、移除", async () => {
    render(<PhotoHarness initial={[photo(1), photo(2)]} upload={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "第 2 張設為封面" }));
    expect(screen.getAllByRole("img")[0].getAttribute("src")).toContain("000000000002");
    await userEvent.click(screen.getByRole("button", { name: "移除第 1 張照片" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("上傳失敗顯示原因", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("只收 JPG、PNG、WebP 照片"));
    render(<PhotoHarness initial={[]} upload={upload} />);
    await userEvent.upload(screen.getByLabelText("新增照片"), [file()]);
    expect(await screen.findByText("只收 JPG、PNG、WebP 照片")).toBeInTheDocument();
  });
});

const renderDialog = (product: MarketProductRow | null, save = vi.fn().mockResolvedValue({ ...CABBAGE })) => {
  const onSaved = vi.fn();
  render(
    <MarketProductDialog open onOpenChange={vi.fn()} supplierId={SUPPLIER_A} product={product} onSaved={onSaved} save={save} upload={vi.fn()} />,
  );
  return { save, onSaved };
};

describe("MarketProductDialog", () => {
  it("新商品:必填沒填會擋;填好按「送出審核」送 submit=true 與畫面先決定的 id", async () => {
    const { save, onSaved } = renderDialog(null);
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "送出審核" }));
    expect(screen.getByLabelText("品名 *")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("請填品名")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("品名 *"), "有機高麗菜");
    await userEvent.selectOptions(screen.getByLabelText("分類 *"), "vegetable");
    await userEvent.type(screen.getByLabelText("零售規格 *"), "1 顆");
    await userEvent.type(screen.getByLabelText("零售價(元)*"), "120");
    await userEvent.click(screen.getByLabelText("冷藏"));
    await userEvent.click(within(dialog).getByRole("button", { name: "送出審核" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0][0];
    expect(input).toMatchObject({ supplierId: SUPPLIER_A, isNew: true, submit: true, form: { name: "有機高麗菜", temperature: "chilled" } });
    expect(input.productId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onSaved).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("已送出審核");
  });

  it("退回的商品:顯示原因,按鈕是「儲存(先不送審)」與「重新送審」", () => {
    renderDialog({ ...CABBAGE, review_status: "rejected", reject_reason: "照片太暗" });
    expect(screen.getByText(/退回原因:照片太暗/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存(先不送審)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新送審" })).toBeInTheDocument();
  });

  it("已核准的商品:只有「儲存」、有上架開關、提醒哪些欄位會重審", async () => {
    const { save } = renderDialog({ ...CABBAGE, review_status: "approved" });
    expect(screen.queryByRole("button", { name: "送出審核" })).toBeNull();
    expect(screen.getByRole("switch", { name: /上架中/ })).toBeChecked();
    expect(screen.getByText(/只改價格、庫存、上架開關不用重審/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ isNew: false, submit: false, productId: CABBAGE.id })));
  });

  it("資料庫擋下時顯示中文原因,視窗不關", async () => {
    const save = vi.fn().mockRejectedValue(new MarketDbError({ message: "fk", code: "23503" }));
    renderDialog({ ...CABBAGE, review_status: "draft" }, save);
    await userEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("儲存失敗", { description: "請先完成「零售市集 › 店家設定」再新增零售商品" }),
    );
  });
});

describe("SupplierMarketProductsPanel", () => {
  it("沒建店家:新增鈕停用,提示去店家設定", () => {
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel products={[]} hasStore={false} loading={false} error={null} onCreate={vi.fn()} onEdit={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "新增零售商品" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "零售市集 › 店家設定" })).toHaveAttribute("href", "/supplier/market/store");
  });

  it("列出狀態與退回原因,編輯回傳那一筆", async () => {
    const onEdit = vi.fn();
    const rejected = { ...CABBAGE, review_status: "rejected" as const, reject_reason: "照片太暗" };
    render(
      <MemoryRouter>
        <SupplierMarketProductsPanel products={[rejected]} hasStore loading={false} error={null} onCreate={vi.fn()} onEdit={onEdit} />
      </MemoryRouter>,
    );
    expect(screen.getByText("退回")).toBeInTheDocument();
    expect(screen.getByText("退回原因:照片太暗")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "編輯 有機高麗菜" }));
    expect(onEdit).toHaveBeenCalledWith(rejected);
    expect(statusText({ review_status: "approved", is_listed: false })).toBe("已核准・暫停販售");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/market/market-supplier-components.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketPhotoField"`

**Step 3:寫實作**

`src/pages/supplier/market/MarketPhotoField.tsx`:

```tsx
// 零售商品照片(最多 5 張,第一張是封面):選檔 → 瀏覽器壓縮 → 上傳到 <supplier_id>/<商品 id>/ → 路徑放進表單。
// 移除只是從清單拿掉,不刪 Storage 的檔(已儲存的商品可能還在用,孤兒檔無害)。
import { useId, useState } from "react";
import { Loader2, Star, X } from "lucide-react";
import type { MarketCategoryKey } from "@/lib/market/constants";
import { PHOTO_RULES } from "@/lib/market/constants";
import { uploadMarketImage } from "@/lib/market/images";
import MarketImage from "@/components/market/MarketImage";

interface MarketPhotoFieldProps {
  supplierId: string;
  productId: string;
  category: MarketCategoryKey | "";
  value: string[];
  onChange: (next: string[]) => void;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
}

export default function MarketPhotoField({ supplierId, productId, category, value, onChange, upload = uploadMarketImage }: MarketPhotoFieldProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const left = PHOTO_RULES.maxCount - value.length;

  const onFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setMessage(files.length > left ? `最多 ${PHOTO_RULES.maxCount} 張,多的已略過` : null);
    setBusy(true);
    const added: string[] = [];
    try {
      for (const f of files.slice(0, left)) added.push(await upload(supplierId, productId, f));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (added.length > 0) onChange([...value, ...added]);
    }
  };

  const move = (i: number) => onChange([value[i], ...value.filter((_, j) => j !== i)]);
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-700">
        商品照片(最多 {PHOTO_RULES.maxCount} 張,第一張是封面;JPG、PNG、WebP,上傳前會自動壓縮)
      </legend>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((path, i) => (
            <li key={path} className="relative">
              <MarketImage path={path} category={category || "grocery"} alt={`第 ${i + 1} 張照片`} width={96} height={96} className="h-24 w-24 rounded-md border border-slate-200" />
              {i === 0 ? <span className="absolute left-1 top-1 rounded bg-emerald-700 px-1 text-[11px] text-white">封面</span> : null}
              <div className="mt-1 flex gap-1">
                {i > 0 ? (
                  <button type="button" onClick={() => move(i)} aria-label={`第 ${i + 1} 張設為封面`} className="flex h-9 w-9 items-center justify-center rounded border border-slate-300">
                    <Star className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                <button type="button" onClick={() => remove(i)} aria-label={`移除第 ${i + 1} 張照片`} className="flex h-9 w-9 items-center justify-center rounded border border-slate-300 text-red-700">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="text-sm text-slate-700">
          新增照片
        </label>
        <input
          id={id}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || left <= 0}
          onChange={(e) => {
            void onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
          className="text-sm"
        />
      </div>
      <p aria-live="polite" className="text-sm text-slate-600">
        {busy ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            上傳中…
          </span>
        ) : (
          message ?? (left <= 0 ? `已經 ${PHOTO_RULES.maxCount} 張了` : "")
        )}
      </p>
    </fieldset>
  );
}
```

`src/pages/supplier/market/MarketProductDialog.tsx`:

```tsx
// 零售商品的新增 / 編輯視窗(商品目錄頁的「零售商品」分頁與每列的「開放零售」共用)。
// 父層每次打開都給新的 key:新商品的 id 在打開當下決定(照片要先上傳到 <supplier>/<商品 id>/)。
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { LIMITS, MARKET_CATEGORIES, REVIEW_STATUS_LABEL, TEMPERATURE_KEYS, TEMPERATURES } from "@/lib/market/constants";
import { friendlyDbError, newUuid } from "@/lib/market/db";
import {
  emptyProductForm,
  productActions,
  productFormFromRow,
  saveMarketProduct,
  validateProductForm,
  type ProductForm,
  type ProductFormErrors,
  type SupplySeed,
} from "@/lib/market/productForm";
import type { MarketProductRow } from "@/lib/market/types";
import MarketPhotoField from "./MarketPhotoField";

interface MarketProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  product: MarketProductRow | null;
  fromSupply?: SupplySeed | null;
  onSaved: (row: MarketProductRow) => void;
  save?: typeof saveMarketProduct;
  upload?: (supplierId: string, folder: string, file: File) => Promise<string>;
}

const INPUT = "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700";

export default function MarketProductDialog({
  open,
  onOpenChange,
  supplierId,
  product,
  fromSupply,
  onSaved,
  save = saveMarketProduct,
  upload,
}: MarketProductDialogProps) {
  const [productId] = useState(() => product?.id ?? newUuid());
  const [form, setForm] = useState<ProductForm>(() => (product ? productFormFromRow(product) : emptyProductForm(fromSupply)));
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [saving, setSaving] = useState(false);
  const actions = productActions(product?.review_status ?? null);
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: keyof ProductForm) =>
    errors[key] ? (
      <p id={`mp-${key}-error`} className="mt-1 text-sm text-red-700">
        {errors[key]}
      </p>
    ) : null;
  const aria = (key: keyof ProductForm) => ({ "aria-invalid": !!errors[key], "aria-describedby": errors[key] ? `mp-${key}-error` : undefined });

  const doSave = async (submit: boolean) => {
    const e = validateProductForm(form);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSaving(true);
    try {
      const row = await save({ supplierId, productId, isNew: !product, form, submit });
      toast.success(submit ? "已送出審核" : "已儲存");
      onSaved(row);
      onOpenChange(false);
    } catch (error) {
      toast.error("儲存失敗", { description: friendlyDbError(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? "編輯零售商品" : "新增零售商品"}</DialogTitle>
          <DialogDescription>
            {product ? `目前狀態:${REVIEW_STATUS_LABEL[product.review_status]}` : "第一次上架要經過管理員審核。"}
            {product?.review_status === "rejected" && product.reject_reason ? `。退回原因:${product.reject_reason}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="mp-name" className="mb-1 block text-sm font-medium text-slate-700">
              品名 *
            </label>
            <input id="mp-name" value={form.name} maxLength={LIMITS.productName} onChange={(e) => set("name", e.target.value)} className={INPUT} {...aria("name")} />
            {err("name")}
          </div>
          <div className="grid gap-4 min-[640px]:grid-cols-2">
            <div>
              <label htmlFor="mp-category" className="mb-1 block text-sm font-medium text-slate-700">
                分類 *
              </label>
              <select id="mp-category" value={form.category} onChange={(e) => set("category", e.target.value as ProductForm["category"])} className={INPUT} {...aria("category")}>
                <option value="">請選擇</option>
                {MARKET_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              {err("category")}
            </div>
            <div>
              <label htmlFor="mp-spec" className="mb-1 block text-sm font-medium text-slate-700">
                零售規格 *
              </label>
              <input id="mp-spec" value={form.spec} maxLength={LIMITS.spec} placeholder="例:600g/盒" onChange={(e) => set("spec", e.target.value)} className={INPUT} {...aria("spec")} />
              {err("spec")}
            </div>
            <div>
              <label htmlFor="mp-price" className="mb-1 block text-sm font-medium text-slate-700">
                零售價(元)*
              </label>
              <input id="mp-price" inputMode="numeric" value={form.price} onChange={(e) => set("price", e.target.value)} className={INPUT} {...aria("price")} />
              {err("price")}
            </div>
            <div>
              <label htmlFor="mp-stock" className="mb-1 block text-sm font-medium text-slate-700">
                庫存
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="mp-stock"
                  inputMode="numeric"
                  value={form.stock}
                  disabled={form.unlimitedStock}
                  onChange={(e) => set("stock", e.target.value)}
                  className={INPUT}
                  {...aria("stock")}
                />
                <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.unlimitedStock} onChange={(e) => set("unlimitedStock", e.target.checked)} className="h-5 w-5" />
                  不限
                </label>
              </div>
              {err("stock")}
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">溫層 *</legend>
            <div className="flex flex-wrap gap-4">
              {TEMPERATURE_KEYS.map((t) => (
                <label key={t} className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="radio" name="mp-temperature" checked={form.temperature === t} onChange={() => set("temperature", t)} className="h-5 w-5" />
                  {TEMPERATURES[t]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 min-[640px]:grid-cols-3">
            {(
              [
                ["origin", "產地", LIMITS.origin, "例:宜蘭三星"],
                ["storageMethod", "保存方式", LIMITS.storageMethod, "例:0–4°C 冷藏"],
                ["shelfLife", "保存期限", LIMITS.shelfLife, "例:冷藏 5 天"],
              ] as Array<[keyof ProductForm, string, number, string]>
            ).map(([key, label, max, ph]) => (
              <div key={key}>
                <label htmlFor={`mp-${key}`} className="mb-1 block text-sm font-medium text-slate-700">
                  {label}
                </label>
                <input
                  id={`mp-${key}`}
                  value={String(form[key])}
                  maxLength={max}
                  placeholder={ph}
                  onChange={(e) => set(key, e.target.value as never)}
                  className={INPUT}
                  {...aria(key)}
                />
                {err(key)}
              </div>
            ))}
          </div>
          <div>
            <label htmlFor="mp-description" className="mb-1 block text-sm font-medium text-slate-700">
              說明
            </label>
            <textarea
              id="mp-description"
              rows={4}
              value={form.description}
              maxLength={LIMITS.description}
              onChange={(e) => set("description", e.target.value)}
              className={`${INPUT} py-2`}
              {...aria("description")}
            />
            {err("description")}
          </div>
          <MarketPhotoField supplierId={supplierId} productId={productId} category={form.category} value={form.photos} onChange={(p) => set("photos", p)} upload={upload} />
          {err("photos")}
          {product?.review_status === "approved" ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Switch checked={form.isListed} onCheckedChange={(v) => set("isListed", v)} aria-label="上架中(關掉就暫停販售,不用重審)" />
              上架中(關掉就暫停販售,不用重審)
            </label>
          ) : null}
          {actions.notice ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">{actions.notice}</p> : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {actions.secondary ? (
            <Button type="button" variant="outline" disabled={saving} onClick={() => doSave(false)}>
              {actions.secondary.label}
            </Button>
          ) : null}
          <Button type="button" disabled={saving} onClick={() => doSave(actions.primary.submit)} className="bg-emerald-700 text-white hover:bg-emerald-800">
            {saving ? "儲存中…" : actions.primary.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`src/pages/supplier/market/useSupplierMarketProducts.ts`:

```ts
// 供應商自家的零售商品(全部狀態)與店家是否已建立 —— 商品目錄頁兩個分頁共用。
import { useCallback, useEffect, useState } from "react";
import { marketDb, unwrap, friendlyDbError } from "@/lib/market/db";
import type { MarketProductRow } from "@/lib/market/types";

export interface SupplierMarketProducts {
  products: MarketProductRow[];
  hasStore: boolean;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const useSupplierMarketProducts = (supplierId: string | null): SupplierMarketProducts => {
  const [products, setProducts] = useState<MarketProductRow[]>([]);
  const [hasStore, setHasStore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!supplierId) return;
    try {
      const [rows, store] = await Promise.all([
        marketDb<MarketProductRow[]>("market_products")
          .select("*")
          .eq("supplier_id", supplierId)
          .order("updated_at", { ascending: false })
          .then(unwrap),
        marketDb<{ supplier_id: string }>("market_stores").select("supplier_id").eq("supplier_id", supplierId).maybeSingle().then(unwrap),
      ]);
      setProducts(rows ?? []);
      setHasStore(!!store);
      setError(null);
    } catch (e) {
      setError(friendlyDbError(e));
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { products, hasStore, loading, error, reload };
};
```

`src/pages/supplier/market/SupplierMarketProductsPanel.tsx`:

```tsx
// 商品目錄頁的「零售商品」分頁內容:列出自家零售商品(狀態、退回原因、上架開關)、新增、編輯。
// 編輯視窗由父層(SupplierCatalogPage)畫,這裡只發出 onCreate / onEdit —— 「開放零售」也用同一個視窗。
import { Link } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarketImage from "@/components/market/MarketImage";
import { REVIEW_STATUS_LABEL, TEMPERATURES, type ReviewStatus } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";
import type { MarketProductRow } from "@/lib/market/types";

const STATUS_CLASS: Record<ReviewStatus, string> = {
  draft: "border-slate-300 bg-slate-50 text-slate-700",
  pending: "border-amber-300 bg-amber-50 text-amber-800",
  approved: "border-emerald-300 bg-emerald-50 text-emerald-800",
  rejected: "border-red-300 bg-red-50 text-red-800",
};

/** 狀態徽章文字:已核准但上架開關關掉 → 「已核准・暫停販售」 */
export const statusText = (p: Pick<MarketProductRow, "review_status" | "is_listed">): string =>
  p.review_status === "approved" ? (p.is_listed ? "已上架" : "已核准・暫停販售") : REVIEW_STATUS_LABEL[p.review_status];

interface PanelProps {
  products: MarketProductRow[];
  hasStore: boolean;
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onEdit: (product: MarketProductRow) => void;
}

export default function SupplierMarketProductsPanel({ products, hasStore, loading, error, onCreate, onEdit }: PanelProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-emerald-600" size={28} aria-label="載入中" />
      </div>
    );
  }
  if (error) return <p role="alert" className="py-8 text-center text-red-700">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">賣給一般消費者的商品(iFoodmap 食材市集)。第一次上架要經過管理員審核。</p>
        <Button onClick={onCreate} disabled={!hasStore} className="bg-emerald-700 text-white hover:bg-emerald-800">
          <Plus size={16} className="mr-1.5" aria-hidden="true" />
          新增零售商品
        </Button>
      </div>
      {!hasStore ? (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          上架零售商品前,請先完成{" "}
          <Link to="/supplier/market/store" className="font-semibold underline underline-offset-2">
            零售市集 › 店家設定
          </Link>
          (配送縣市、運費、付款方式)。
        </p>
      ) : null}
      {products.length === 0 ? (
        <p className="py-12 text-center text-gray-400">還沒有零售商品。</p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {products.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 p-3">
              <MarketImage path={p.photos[0]} category={p.category} alt="" width={56} height={56} className="h-14 w-14 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-gray-800">{p.name}</p>
                <p className="text-xs text-gray-500">
                  {p.spec}・{formatTwd(p.price)}・{TEMPERATURES[p.temperature]}・庫存 {p.stock === null ? "不限" : p.stock}
                </p>
                {p.review_status === "rejected" && p.reject_reason ? <p className="text-xs text-red-700">退回原因:{p.reject_reason}</p> : null}
              </div>
              <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASS[p.review_status]}`}>{statusText(p)}</span>
              <Button variant="outline" size="sm" className="min-h-11" onClick={() => onEdit(p)} aria-label={`編輯 ${p.name}`}>
                編輯
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  10 passed (10)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/supplier/market/MarketPhotoField.tsx src/pages/supplier/market/MarketProductDialog.tsx src/pages/supplier/market/useSupplierMarketProducts.ts src/pages/supplier/market/SupplierMarketProductsPanel.tsx src/pages/supplier/market/market-supplier-components.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售商品照片欄、編輯視窗與清單

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 25:商品目錄頁加「零售商品」分頁與每列的「開放零售」

批發與零售分兩個分頁;批發商品表格多一欄「零售」:已經有對應零售商品就顯示狀態(點了打開編輯),沒有就顯示「開放零售」(還沒建零售店家時停用並提示);表格最小寬度 640 → 760px(手機橫向捲動表格本身,不撐寬頁面)。

**Files:**
- Modify: `src/pages/supplier/SupplierCatalogPage.tsx`(import、`src/pages/supplier/SupplierCatalogPage.tsx:171-178` 標題區、`src/pages/supplier/SupplierCatalogPage.tsx:190-236` 表格)
- Test: `src/pages/supplier/SupplierCatalogPage.market.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 商品目錄頁多了「零售商品」分頁與每列的「開放零售」(設計:擴充 SupplierCatalogPage)。
// 驗證:①兩個分頁 ②批發商品列:沒有對應零售商品的出現「開放零售」,有的顯示零售狀態 ③開放零售打開視窗並帶入品名
// ④零售分頁列出自家零售商品 ⑤還沒建零售店家時「開放零售」停用。supabase 換成記憶體假資料。
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    supplies: [] as Record<string, unknown>[],
    marketProducts: [] as Record<string, unknown>[],
    hasStore: true,
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }) },
    from: (table: string) => {
      const result = () => {
        if (table === "supplier_accounts") return { data: { supplier_id: "a9200000-0000-4000-8000-00000000000a" }, error: null };
        if (table === "supplies") return { data: db.supplies, error: null };
        if (table === "market_products") return { data: db.marketProducts, error: null };
        if (table === "market_stores") return { data: db.hasStore ? { supplier_id: "a9200000-0000-4000-8000-00000000000a" } : null, error: null };
        return { data: [], error: null };
      };
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
      };
      return b;
    },
  },
}));

import { CABBAGE } from "@/lib/market/testFixtures";
import SupplierCatalogPage from "./SupplierCatalogPage";

const SUPPLY = (id: string, name: string) => ({
  id,
  name,
  category: "蔬菜",
  sku: null,
  unit: "kg",
  pack_size: "10kg/箱",
  price: 300,
  currency: "TWD",
  description: null,
  is_available: true,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierCatalogPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  db.supplies = [SUPPLY("s-cabbage", "高麗菜"), SUPPLY("s-onion", "洋蔥")];
  db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "pending" }];
  db.hasStore = true;
});
afterEach(cleanup);

describe("SupplierCatalogPage — 零售市集", () => {
  it("兩個分頁;批發商品每列有零售狀態或「開放零售」", async () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "批發商品(給餐廳)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "零售商品(給消費者)" })).toBeInTheDocument();
    const cabbageRow = (await screen.findByText("高麗菜")).closest("tr") as HTMLElement;
    expect(within(cabbageRow).getByRole("button", { name: "待審" })).toBeInTheDocument();
    const onionRow = screen.getByText("洋蔥").closest("tr") as HTMLElement;
    expect(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" })).toBeEnabled();
  });

  it("「開放零售」打開零售商品視窗,品名與規格從批發商品帶入", async () => {
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    await userEvent.click(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "新增零售商品" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("品名 *")).toHaveValue("洋蔥");
    expect(within(dialog).getByLabelText("零售規格 *")).toHaveValue("10kg/箱");
    expect(within(dialog).getByLabelText("分類 *")).toHaveValue("vegetable");
  });

  it("零售分頁列出自家零售商品", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    expect(await screen.findByRole("button", { name: "編輯 有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增零售商品" })).toBeEnabled();
  });

  it("還沒建零售店家:「開放零售」停用", async () => {
    db.hasStore = false;
    db.marketProducts = [];
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    const button = await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" });
    expect(button).toBeDisabled();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/SupplierCatalogPage.market.test.tsx`

Expected:FAIL 4 項,例如 `Unable to find an accessible element with the role "tab" and name "批發商品(給餐廳)"`

**Step 3:改 `SupplierCatalogPage.tsx`(8 處,由上而下)**

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
import { useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
```

換成:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface Supply {
```

換成:

```tsx
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { SupplySeed } from '@/lib/market/productForm';
import type { MarketProductRow } from '@/lib/market/types';
import MarketProductDialog from './market/MarketProductDialog';
import SupplierMarketProductsPanel, { statusText } from './market/SupplierMarketProductsPanel';
import { useSupplierMarketProducts } from './market/useSupplierMarketProducts';

interface Supply {
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchSupplies = async (sid: string) => {
```

換成:

```tsx
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // 零售市集(B2C):自家零售商品;編輯視窗每次打開給新的 key(新商品的 id 在打開時決定)
  const market = useSupplierMarketProducts(supplierId);
  const [retail, setRetail] = useState<{ key: number; product: MarketProductRow | null; seed: SupplySeed | null } | null>(null);
  const retailBySupply = useMemo(
    () => new Map(market.products.filter((p) => p.supply_id).map((p) => [p.supply_id as string, p])),
    [market.products],
  );
  const openRetail = (product: MarketProductRow | null, seed: SupplySeed | null = null) =>
    setRetail({ key: Date.now(), product, seed });

  const fetchSupplies = async (sid: string) => {
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-gray-900">商品目錄</h1>
        <Button onClick={openCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!supplierId}>
          <Plus size={16} className="mr-1.5" />新增商品
        </Button>
      </div>
      <p className="text-sm text-gray-500 mb-6">管理您上架給 ifoodmap 買家的商品品項與價格</p>

      {loading ? (
```

換成:

```tsx
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-4">商品目錄</h1>
      <Tabs defaultValue="wholesale">
        <TabsList className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="wholesale" className="min-h-11">批發商品(給餐廳)</TabsTrigger>
          <TabsTrigger value="retail" className="min-h-11">零售商品(給消費者)</TabsTrigger>
        </TabsList>
        <TabsContent value="wholesale">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-sm text-gray-500">管理您上架給 ifoodmap 買家的商品品項與價格</p>
        <Button onClick={openCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!supplierId}>
          <Plus size={16} className="mr-1.5" />新增商品
        </Button>
      </div>

      {loading ? (
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
          {/* overflow-x-auto:手機放不下整張表時讓表格自己橫向捲,
              而不是把整個頁面撐寬 */}
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
```

換成:

```tsx
          {/* overflow-x-auto:手機放不下整張表時讓表格自己橫向捲,
              而不是把整個頁面撐寬 */}
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
                <th className="text-right px-5 py-3 font-medium text-gray-600">單價</th>
                <th className="text-center px-5 py-3 font-medium text-gray-600">上架</th>
                <th className="text-right px-5 py-3 font-medium text-gray-600 w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {supplies.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">
```

換成:

```tsx
                <th className="text-right px-5 py-3 font-medium text-gray-600">單價</th>
                <th className="text-center px-5 py-3 font-medium text-gray-600">上架</th>
                <th className="text-center px-5 py-3 font-medium text-gray-600">零售</th>
                <th className="text-right px-5 py-3 font-medium text-gray-600 w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {supplies.map((s) => {
                const retailItem = retailBySupply.get(s.id);
                return (
                <tr key={s.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-5 py-3">
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
                    <Switch checked={s.is_available} onCheckedChange={() => toggleAvailable(s)} />
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-700" onClick={() => openEdit(s)} aria-label="編輯">
```

換成:

```tsx
                    <Switch checked={s.is_available} onCheckedChange={() => toggleAvailable(s)} />
                  </td>
                  <td className="px-5 py-3 text-center whitespace-nowrap">
                    {retailItem ? (
                      <button type="button" className="text-xs text-emerald-800 underline underline-offset-2" onClick={() => openRetail(retailItem)}>
                        {statusText(retailItem)}
                      </button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={!market.hasStore}
                        title={market.hasStore ? undefined : '請先完成「零售市集 › 店家設定」'}
                        aria-label={`${s.name} 開放消費者購買`}
                        onClick={() => openRetail(null, s)}
                      >
                        開放零售
                      </Button>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-700" onClick={() => openEdit(s)} aria-label="編輯">
```

在 `src/pages/supplier/SupplierCatalogPage.tsx` 找到:

```tsx
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
```

換成:

```tsx
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </TabsContent>
        <TabsContent value="retail">
          {supplierId ? (
            <SupplierMarketProductsPanel
              products={market.products}
              hasStore={market.hasStore}
              loading={market.loading}
              error={market.error}
              onCreate={() => openRetail(null)}
              onEdit={(p) => openRetail(p)}
            />
          ) : (
            <div className="text-center py-20 text-gray-400">此帳號尚未綁定供應商</div>
          )}
        </TabsContent>
      </Tabs>

      {retail && supplierId ? (
        <MarketProductDialog
          key={retail.key}
          open
          onOpenChange={(o) => {
            if (!o) setRetail(null);
          }}
          supplierId={supplierId}
          product={retail.product}
          fromSupply={retail.seed}
          onSaved={() => void market.reload()}
        />
      ) : null}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  4 passed (4)`;再跑一次既有的商品目錄測試確認沒壞:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier`,Expected:全部 passed、0 failed。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/supplier/SupplierCatalogPage.tsx src/pages/supplier/SupplierCatalogPage.market.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 商品目錄頁加零售商品分頁與「開放零售」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 26:審核與零售店家的資料邏輯 `admin.ts`

`fetchAdminProducts(篩選)`、`reviewProduct(商品, {approve | reject | delist})`:更新時帶 `updated_at` 當樂觀鎖(供應商在你看的同時改了內容 → 0 列 → `StaleReviewError`,畫面要求重新整理);下架 = 退回並在原因前加「(管理員下架)」。`fetchAdminStores`、`fetchProductCounts`、`setStoreEnabled(停用要原因)`。

**Files:**
- Create: `src/lib/market/admin.ts`
- Test: `src/lib/market/admin.test.ts`

**Step 1:寫失敗的測試**

```ts
// admin.ts:審核送出的內容、樂觀鎖(updated_at)、下架 = 退回加前綴、店家停用 / 恢復、商品數統計。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, next } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  next: { data: null as unknown },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, unknown]> };
      calls.push(call);
      const b = {
        select: () => b,
        update: (v: unknown) => {
          call.op = "update";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return b;
        },
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: next.data, error: null }),
        single: async () => ({ data: next.data, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: next.data, error: null }).then(ok),
      };
      return b;
    },
  },
}));

import { fetchAdminProducts, fetchProductCounts, reviewProduct, setStoreEnabled, StaleReviewError } from "./admin";

beforeEach(() => {
  calls.length = 0;
  next.data = { id: "p1" };
});

describe("reviewProduct", () => {
  const product = { id: "p1", updated_at: "2026-10-09T02:00:00.123456+00:00" };

  it("核准:只送 review_status,帶 id 與 updated_at(樂觀鎖)", async () => {
    await reviewProduct(product, { kind: "approve" });
    expect(calls[0]).toMatchObject({ op: "update", payload: { review_status: "approved" } });
    expect(calls[0].filters).toEqual([
      ["id", "p1"],
      ["updated_at", product.updated_at],
    ]);
  });

  it("退回帶原因;下架 = 退回,原因加「(管理員下架)」", async () => {
    await reviewProduct(product, { kind: "reject", reason: " 照片太暗 " });
    expect(calls[0].payload).toEqual({ review_status: "rejected", reject_reason: "照片太暗" });
    await reviewProduct(product, { kind: "delist", reason: "標示不實" });
    expect(calls[1].payload).toEqual({ review_status: "rejected", reject_reason: "(管理員下架)標示不實" });
  });

  it("0 列(供應商剛改過)→ StaleReviewError", async () => {
    next.data = null;
    await expect(reviewProduct(product, { kind: "approve" })).rejects.toBeInstanceOf(StaleReviewError);
  });
});

describe("清單與店家", () => {
  it("待審清單篩 review_status;全部不篩", async () => {
    next.data = [];
    await fetchAdminProducts("pending");
    expect(calls[0].filters).toEqual([["review_status", "pending"]]);
    await fetchAdminProducts("all");
    expect(calls[1].filters).toEqual([]);
  });

  it("停用要帶原因;恢復只送 is_enabled", async () => {
    await setStoreEnabled("sup-1", false, " 客訴處理中 ");
    expect(calls[0].payload).toEqual({ is_enabled: false, disabled_reason: "客訴處理中" });
    await setStoreEnabled("sup-1", true, null);
    expect(calls[1].payload).toEqual({ is_enabled: true });
  });

  it("商品數:上架中 = 已核准且開著;待審另外算", async () => {
    next.data = [
      { supplier_id: "a", review_status: "approved", is_listed: true },
      { supplier_id: "a", review_status: "approved", is_listed: false },
      { supplier_id: "a", review_status: "pending", is_listed: true },
      { supplier_id: "b", review_status: "draft", is_listed: true },
    ];
    const counts = await fetchProductCounts();
    expect(counts.get("a")).toEqual({ listed: 1, pending: 1 });
    expect(counts.get("b")).toEqual({ listed: 0, pending: 0 });
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/admin.test.ts`

Expected:FAIL,`Failed to resolve import "./admin"`

**Step 3:寫實作**

```ts
// 管理後台「零售市集」的資料存取:商品審核、零售店家停用 / 恢復。全部用管理員既有的 RLS(is_admin())。
//
// 審核用「樂觀鎖」:更新時多帶 updated_at = 畫面上那一筆的值。供應商在管理員看的同時改了內容
// (資料庫會把 updated_at 換掉、狀態改回 pending),這次更新就會 0 列 → 告訴管理員重新整理,
// 不會把管理員「沒看過的新內容」核准掉。
import type { ReviewStatus } from "./constants";
import { marketDb, unwrap } from "./db";
import type { MarketProductRow, MarketStoreRow } from "./types";

export const ADMIN_PRODUCT_COLUMNS = "*, market_stores(supplier_id, is_enabled, suppliers(name))";

export type ReviewFilter = ReviewStatus | "all";

export const fetchAdminProducts = async (filter: ReviewFilter): Promise<MarketProductRow[]> => {
  let q = marketDb<MarketProductRow[]>("market_products").select(ADMIN_PRODUCT_COLUMNS);
  if (filter !== "all") q = q.eq("review_status", filter);
  return unwrap(await q.order(filter === "pending" ? "submitted_at" : "updated_at", { ascending: filter === "pending" }).limit(500)) ?? [];
};

export class StaleReviewError extends Error {
  constructor() {
    super("這個商品剛被供應商修改過,請重新整理後再審核");
    this.name = "StaleReviewError";
  }
}

export type ReviewAction = { kind: "approve" } | { kind: "reject"; reason: string } | { kind: "delist"; reason: string };

/** 核准 / 退回 / 下架(下架 = 退回並填原因,供應商改好可以重新送審) */
export const reviewProduct = async (
  product: Pick<MarketProductRow, "id" | "updated_at">,
  action: ReviewAction,
): Promise<MarketProductRow> => {
  const patch =
    action.kind === "approve"
      ? { review_status: "approved" }
      : { review_status: "rejected", reject_reason: action.kind === "delist" ? `(管理員下架)${action.reason.trim()}` : action.reason.trim() };
  let q = marketDb<MarketProductRow>("market_products").update(patch).eq("id", product.id);
  if (product.updated_at) q = q.eq("updated_at", product.updated_at);
  const row = unwrap(await q.select(ADMIN_PRODUCT_COLUMNS).maybeSingle());
  if (!row) throw new StaleReviewError();
  return row;
};

export interface AdminStoreRow extends MarketStoreRow {
  created_at?: string;
}

export const fetchAdminStores = async (): Promise<AdminStoreRow[]> =>
  unwrap(
    await marketDb<AdminStoreRow[]>("market_stores")
      .select("*, suppliers(name, phone, contact_email, is_active)")
      .order("updated_at", { ascending: false }),
  ) ?? [];

/** 每家店的商品數(上架中 / 待審) */
export const fetchProductCounts = async (): Promise<Map<string, { listed: number; pending: number }>> => {
  const rows =
    unwrap(await marketDb<Array<Pick<MarketProductRow, "supplier_id" | "review_status" | "is_listed">>>("market_products").select("supplier_id, review_status, is_listed")) ??
    [];
  const counts = new Map<string, { listed: number; pending: number }>();
  for (const r of rows) {
    const c = counts.get(r.supplier_id) ?? { listed: 0, pending: 0 };
    if (r.review_status === "approved" && r.is_listed) c.listed += 1;
    if (r.review_status === "pending") c.pending += 1;
    counts.set(r.supplier_id, c);
  }
  return counts;
};

export const setStoreEnabled = async (supplierId: string, enabled: boolean, reason: string | null): Promise<AdminStoreRow> =>
  unwrap(
    await marketDb<AdminStoreRow>("market_stores")
      .update(enabled ? { is_enabled: true } : { is_enabled: false, disabled_reason: (reason ?? "").trim() })
      .eq("supplier_id", supplierId)
      .select("*, suppliers(name, phone, contact_email, is_active)")
      .single(),
  );
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  6 passed (6)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/admin.ts src/lib/market/admin.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 管理員審核零售商品(樂觀鎖)與停用零售店家

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 27:管理後台「商品審核」與「零售店家」兩頁

- 商品審核:預設看待審(先送審的在前);「查看」看完整內容與全部照片;核准、退回(要原因)、已上架的可以下架。頁首寫明不收的東西(酒類、標示不實、照片不是商品本身)。
- 零售店家:每家的狀態、上架 / 待審商品數;停用要原因(停用後消費者看不到這家店的商品),可以恢復。

**Files:**
- Create: `src/pages/admin/AdminMarketProductsPage.tsx`
- Create: `src/pages/admin/AdminMarketStoresPage.tsx`
- Test: `src/pages/admin/AdminMarketPages.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 管理後台零售市集兩頁:商品審核(待審清單、查看全部內容、核准、退回要原因、下架、被改過要重新整理)、零售店家(停用要原因、恢復)。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@/lib/market/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/admin")>()),
  fetchAdminProducts: vi.fn(),
  reviewProduct: vi.fn(),
  fetchAdminStores: vi.fn(),
  fetchProductCounts: vi.fn(),
  setStoreEnabled: vi.fn(),
}));

import { fetchAdminProducts, fetchAdminStores, fetchProductCounts, reviewProduct, setStoreEnabled, StaleReviewError } from "@/lib/market/admin";
import { CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import AdminMarketProductsPage from "./AdminMarketProductsPage";
import AdminMarketStoresPage from "./AdminMarketStoresPage";

const PENDING = { ...CABBAGE, review_status: "pending" as const, submitted_at: "2026-10-09T04:05:00Z", updated_at: "2026-10-09T04:05:00.1+00:00" };

beforeEach(() => {
  vi.mocked(fetchAdminProducts).mockResolvedValue([PENDING]);
  vi.mocked(reviewProduct).mockResolvedValue(PENDING);
  vi.mocked(fetchAdminStores).mockResolvedValue([STORE_A]);
  vi.mocked(fetchProductCounts).mockResolvedValue(new Map([[STORE_A.supplier_id, { listed: 3, pending: 1 }]]));
  vi.mocked(setStoreEnabled).mockResolvedValue(STORE_A);
});
afterEach(cleanup);

describe("AdminMarketProductsPage", () => {
  it("預設看待審;查看顯示完整內容;核准送 approve", async () => {
    render(<AdminMarketProductsPage />);
    expect(fetchAdminProducts).toHaveBeenCalledWith("pending");
    await userEvent.click(await screen.findByRole("button", { name: "查看 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("宜蘭三星")).toBeInTheDocument();
    expect(within(dialog).getByText("沒有照片")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "核准上架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(PENDING, { kind: "approve" }));
    expect(toastSuccess).toHaveBeenCalledWith("已核准「有機高麗菜」");
  });

  it("退回一定要填原因", async () => {
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "退回 有機高麗菜" }));
    const confirm = await screen.findByRole("button", { name: "確定退回" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("原因(必填)"), "照片太暗");
    await userEvent.click(confirm);
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(PENDING, { kind: "reject", reason: "照片太暗" }));
  });

  it("已核准的可以下架(= 退回加原因)", async () => {
    vi.mocked(fetchAdminProducts).mockResolvedValue([{ ...PENDING, review_status: "approved" }]);
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "已核准" }));
    await userEvent.click(await screen.findByRole("button", { name: "下架 有機高麗菜" }));
    await userEvent.type(screen.getByLabelText("原因(必填)"), "標示不實");
    await userEvent.click(screen.getByRole("button", { name: "確定下架" }));
    await waitFor(() => expect(reviewProduct).toHaveBeenCalledWith(expect.objectContaining({ id: CABBAGE.id }), { kind: "delist", reason: "標示不實" }));
  });

  it("供應商剛改過(樂觀鎖擋下)→ 顯示要重新整理,並重抓清單", async () => {
    vi.mocked(reviewProduct).mockRejectedValue(new StaleReviewError());
    render(<AdminMarketProductsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "核准 有機高麗菜" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("處理失敗", { description: "這個商品剛被供應商修改過,請重新整理後再審核" }),
    );
    expect(vi.mocked(fetchAdminProducts).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AdminMarketStoresPage", () => {
  it("列出店家與商品數;停用要原因", async () => {
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("市集測試 A 店")).toBeInTheDocument();
    expect(screen.getByText(/上架 3・待審 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停用 市集測試 A 店 的零售" }));
    expect(screen.getByRole("button", { name: "確定停用" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("原因(必填)"), "客訴處理中");
    await userEvent.click(screen.getByRole("button", { name: "確定停用" }));
    await waitFor(() => expect(setStoreEnabled).toHaveBeenCalledWith(STORE_A.supplier_id, false, "客訴處理中"));
  });

  it("已停用的店顯示原因,可以恢復", async () => {
    vi.mocked(fetchAdminStores).mockResolvedValue([{ ...STORE_A, is_enabled: false, disabled_reason: "客訴處理中" }]);
    render(<AdminMarketStoresPage />);
    expect(await screen.findByText("停用原因:客訴處理中")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢復 市集測試 A 店 的零售" }));
    await waitFor(() => expect(setStoreEnabled).toHaveBeenCalledWith(STORE_A.supplier_id, true, null));
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/admin/AdminMarketPages.test.tsx`

Expected:FAIL,`Failed to resolve import "./AdminMarketProductsPage"`

**Step 3:寫實作**

`src/pages/admin/AdminMarketProductsPage.tsx`:

```tsx
// 管理後台「零售市集 › 商品審核」(/admin/market/products):待審清單(先送審的在前),可以核准、退回(填原因);
// 已上架的可以下架(= 退回並填原因,供應商改好重新送審)。審核前一定要能看到完整內容與全部照片(「查看」)。
// 樂觀鎖:供應商在你看的同時改了內容,這次審核會被擋下並要求重新整理(src/lib/market/admin.ts)。
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import MarketImage from '@/components/market/MarketImage';
import { fetchAdminProducts, reviewProduct, type ReviewFilter } from '@/lib/market/admin';
import { CATEGORY_LABEL, LIMITS, REVIEW_STATUS_LABEL, TEMPERATURES } from '@/lib/market/constants';
import { friendlyDbError } from '@/lib/market/db';
import { formatTaipei, formatTwd, stockLabel } from '@/lib/market/format';
import type { MarketProductRow } from '@/lib/market/types';

const FILTERS: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'pending', label: '待審' },
  { key: 'approved', label: '已核准' },
  { key: 'rejected', label: '退回 / 下架' },
  { key: 'draft', label: '草稿' },
  { key: 'all', label: '全部' },
];

type ReasonMode = 'reject' | 'delist';

const AdminMarketProductsPage = () => {
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [rows, setRows] = useState<MarketProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<MarketProductRow | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ row: MarketProductRow; mode: ReasonMode } | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchAdminProducts(filter));
    } catch (e) {
      toast.error('載入失敗', { description: friendlyDbError(e) });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (row: MarketProductRow, run: () => Promise<unknown>, done: string) => {
    setBusyId(row.id);
    try {
      await run();
      toast.success(done);
      setDetail(null);
      setReasonTarget(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error('處理失敗', { description: friendlyDbError(e) });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const approve = (row: MarketProductRow) => act(row, () => reviewProduct(row, { kind: 'approve' }), `已核准「${row.name}」`);
  const submitReason = () => {
    if (!reasonTarget || !reason.trim()) return;
    const { row, mode } = reasonTarget;
    void act(row, () => reviewProduct(row, { kind: mode, reason }), mode === 'delist' ? `已下架「${row.name}」` : `已退回「${row.name}」`);
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售商品審核</h1>
      <p className="mb-4 text-sm text-slate-500">
        供應商第一次開放零售、或改了品名 / 照片 / 說明等內容,都要在這裡核准後消費者才看得到。改價格、庫存不用重審。
        <br />
        不收:酒類(免註冊結帳無法辨識年齡)、標示不實、照片不是商品本身。
      </p>

      <div role="group" aria-label="審核狀態" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'outline'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">沒有{FILTERS.find((f) => f.key === filter)?.label}的商品</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
              <MarketImage path={r.photos[0]} category={r.category} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">{r.name}</p>
                <p className="text-xs text-slate-500">
                  {r.market_stores?.suppliers?.name ?? '—'}・{CATEGORY_LABEL[r.category]}・{r.spec}・{formatTwd(r.price)}・送審 {formatTaipei(r.submitted_at)}
                </p>
                {r.reject_reason ? <p className="text-xs text-red-700">原因:{r.reject_reason}</p> : null}
              </div>
              <Badge variant="outline">{REVIEW_STATUS_LABEL[r.review_status]}</Badge>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDetail(r)} aria-label={`查看 ${r.name}`}>
                  查看
                </Button>
                {r.review_status === 'pending' ? (
                  <>
                    <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busyId === r.id} onClick={() => approve(r)} aria-label={`核准 ${r.name}`}>
                      核准
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-600" onClick={() => setReasonTarget({ row: r, mode: 'reject' })} aria-label={`退回 ${r.name}`}>
                      退回
                    </Button>
                  </>
                ) : null}
                {r.review_status === 'approved' ? (
                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => setReasonTarget({ row: r, mode: 'delist' })} aria-label={`下架 ${r.name}`}>
                    下架
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.name}</DialogTitle>
                <DialogDescription>
                  {detail.market_stores?.suppliers?.name ?? '—'}・{REVIEW_STATUS_LABEL[detail.review_status]}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-3 gap-2">
                {detail.photos.length === 0 ? <p className="col-span-3 text-sm text-red-700">沒有照片</p> : null}
                {detail.photos.map((p, i) => (
                  <MarketImage key={p} path={p} category={detail.category} alt={`第 ${i + 1} 張照片`} variant="full" width={240} height={240} className="aspect-square w-full rounded-md" />
                ))}
              </div>
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
                {(
                  [
                    ['分類', CATEGORY_LABEL[detail.category]],
                    ['規格', detail.spec],
                    ['價格', formatTwd(detail.price)],
                    ['庫存', stockLabel(detail.stock)],
                    ['溫層', TEMPERATURES[detail.temperature]],
                    ['產地', detail.origin ?? '—'],
                    ['保存方式', detail.storage_method ?? '—'],
                    ['保存期限', detail.shelf_life ?? '—'],
                  ] as Array<[string, string]>
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="whitespace-pre-line text-sm text-slate-700">{detail.description ?? '(沒有說明)'}</p>
              {detail.review_status === 'pending' ? (
                <DialogFooter className="gap-2">
                  <Button variant="outline" className="text-red-600" onClick={() => setReasonTarget({ row: detail, mode: 'reject' })}>
                    退回
                  </Button>
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busyId === detail.id} onClick={() => approve(detail)}>
                    核准上架
                  </Button>
                </DialogFooter>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={!!reasonTarget} onOpenChange={(o) => !o && setReasonTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonTarget?.mode === 'delist' ? '下架' : '退回'}「{reasonTarget?.row.name}」</DialogTitle>
            <DialogDescription>原因會顯示給供應商,供應商修改後可以重新送審。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="market-review-reason">原因(必填)</Label>
            <Textarea id="market-review-reason" rows={3} maxLength={LIMITS.rejectReason} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={!reason.trim() || !!busyId} onClick={submitReason}>
              {reasonTarget?.mode === 'delist' ? '確定下架' : '確定退回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketProductsPage;
```

`src/pages/admin/AdminMarketStoresPage.tsx`:

```tsx
// 管理後台「零售市集 › 零售店家」(/admin/market/stores):列出開了零售的店家、上架中 / 待審商品數,
// 可以停用某家店的零售(要填原因,供應商後台會看到)或恢復。停用後消費者看不到這家店與它的商品(RLS)。
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { fetchAdminStores, fetchProductCounts, setStoreEnabled, type AdminStoreRow } from '@/lib/market/admin';
import { LIMITS } from '@/lib/market/constants';
import { friendlyDbError } from '@/lib/market/db';
import { citiesSummary, shippingSummary } from '@/lib/market/format';

const AdminMarketStoresPage = () => {
  const [stores, setStores] = useState<AdminStoreRow[]>([]);
  const [counts, setCounts] = useState<Map<string, { listed: number; pending: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AdminStoreRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([fetchAdminStores(), fetchProductCounts()]);
      setStores(s);
      setCounts(c);
    } catch (e) {
      toast.error('載入失敗', { description: friendlyDbError(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (store: AdminStoreRow, enabled: boolean) => {
    setBusy(true);
    try {
      await setStoreEnabled(store.supplier_id, enabled, enabled ? null : reason);
      toast.success(enabled ? '已恢復零售' : '已停用零售');
      setTarget(null);
      setReason('');
      await load();
    } catch (e) {
      toast.error('處理失敗', { description: friendlyDbError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售店家</h1>
      <p className="mb-4 text-sm text-slate-500">停用後,消費者看不到這家店與它的商品;已成立的訂單不受影響。</p>
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : stores.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">還沒有供應商開零售</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {stores.map((s) => {
            const c = counts.get(s.supplier_id) ?? { listed: 0, pending: 0 };
            const name = s.suppliers?.name ?? s.supplier_id;
            return (
              <li key={s.supplier_id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-800">{name}</p>
                  <p className="text-xs text-slate-500">
                    {citiesSummary(s.delivery_cities)}・{shippingSummary(s)}・上架 {c.listed}・待審 {c.pending}
                  </p>
                  {!s.is_enabled && s.disabled_reason ? <p className="text-xs text-red-700">停用原因:{s.disabled_reason}</p> : null}
                </div>
                <Badge variant="outline">{s.is_enabled ? '零售中' : '已停用'}</Badge>
                {s.is_enabled ? (
                  <Button size="sm" variant="outline" className="text-red-600" onClick={() => setTarget(s)} aria-label={`停用 ${name} 的零售`}>
                    停用零售
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => change(s, true)} aria-label={`恢復 ${name} 的零售`}>
                    恢復零售
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用「{target?.suppliers?.name}」的零售</DialogTitle>
            <DialogDescription>原因會顯示在供應商的店家設定頁。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="market-store-reason">原因(必填)</Label>
            <Textarea id="market-store-reason" rows={3} maxLength={LIMITS.disabledReason} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={!reason.trim() || busy} onClick={() => target && change(target, false)}>
              確定停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminMarketStoresPage;
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  6 passed (6)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/admin/AdminMarketProductsPage.tsx src/pages/admin/AdminMarketStoresPage.tsx src/pages/admin/AdminMarketPages.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 管理後台零售商品審核與零售店家頁

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 28:管理後台加「零售市集」分區與兩條路由

分區放在「財務」與「系統」之間;路由掛在管理員站的 `AdminRoutes`。

**Files:**
- Modify: `src/pages/admin/AdminLayout.tsx:3-6`(icon import)、`src/pages/admin/AdminLayout.tsx:148`(在 `system` 分區前面加一個分區)
- Modify: `src/App.tsx:60`(import)、`src/App.tsx:123`(路由)
- Test: `src/pages/admin/AdminLayout.test.tsx`、`src/pages/admin/AdminRoutes.test.tsx`

**Step 1:改測試(選單 8 個分區;路由表 28 條,多兩條零售市集)**

`src/pages/admin/AdminLayout.test.tsx`:

在 `src/pages/admin/AdminLayout.test.tsx` 找到:

```tsx
//   ① AI 助手泡泡每一頁都看得到,而且是純對話(admin 模式)。
//   ② 後台精簡第一期:選單 23 項 → 7 個分區,分區裡用分頁(SectionTabs);金流/發票從選單收起來;
//      「會員 › 入駐審核」分頁帶待審數。
//
```

換成:

```tsx
//   ① AI 助手泡泡每一頁都看得到,而且是純對話(admin 模式)。
//   ② 後台精簡第一期:選單 23 項 → 7 個分區,分區裡用分頁(SectionTabs);金流/發票從選單收起來;
//      2026-10 加第 8 個分區「零售市集」(消費者食材市集的商品審核、零售店家);
//      「會員 › 入駐審核」分頁帶待審數。
//
```

在 `src/pages/admin/AdminLayout.test.tsx` 找到:

```tsx
};

const SECTION_LABELS = ["總覽", "訂單", "需求與媒合", "會員", "食材資料", "財務", "系統"];

let pathnames: string[] = [];
```

換成:

```tsx
};

const SECTION_LABELS = ["總覽", "訂單", "需求與媒合", "會員", "食材資料", "財務", "零售市集", "系統"];

let pathnames: string[] = [];
```

在 `src/pages/admin/AdminLayout.test.tsx` 找到:

```tsx
});

describe("AdminLayout — 選單剛好 7 個分區(23 項收成 7 區)", () => {
  it.each([
    ["桌機側欄", "admin-sidebar-desktop"],
    ["手機抽屜", "admin-sidebar-mobile"],
  ])("%s:剛好 7 個分區連結,依序是 總覽、訂單、需求與媒合、會員、食材資料、財務、系統", async (_name, testId) => {
    renderLayout("/admin");
    const nav = within(screen.getByTestId(testId)).getByRole("navigation", { name: "管理員後台導覽" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(7);
    expect(links.map((l) => l.textContent)).toEqual(SECTION_LABELS);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
```

換成:

```tsx
});

describe("AdminLayout — 選單剛好 8 個分區(23 項收成 7 區,2026-10 加零售市集)", () => {
  it.each([
    ["桌機側欄", "admin-sidebar-desktop"],
    ["手機抽屜", "admin-sidebar-mobile"],
  ])("%s:剛好 8 個分區連結,依序是 總覽、訂單、需求與媒合、會員、食材資料、財務、零售市集、系統", async (_name, testId) => {
    renderLayout("/admin");
    const nav = within(screen.getByTestId(testId)).getByRole("navigation", { name: "管理員後台導覽" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(8);
    expect(links.map((l) => l.textContent)).toEqual(SECTION_LABELS);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
```

在 `src/pages/admin/AdminLayout.test.tsx` 找到:

```tsx
      "/admin/ingredients",
      "/admin/revenue",
      "/admin/ai-ops",
    ]);
```

換成:

```tsx
      "/admin/ingredients",
      "/admin/revenue",
      "/admin/market/products",
      "/admin/ai-ops",
    ]);
```

`src/pages/admin/AdminRoutes.test.tsx`:

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
// 管理員站(VITE_PORTAL=admin)的真實路由表:用 App.tsx 本身渲染,不是複製一份路由。
// 驗證:①原本 26 條管理員路由全部打得開、渲染的是原本那個頁面 ②每一條落在正確的分區與分頁
//       ③唯一的轉址 /admin/orders/:id/timeline → /admin/orders/:id 真的換了網址
//       ④每一頁都有 AI 泡泡、主內容底部留白 pb-40 還在。
```

換成:

```tsx
// 管理員站(VITE_PORTAL=admin)的真實路由表:用 App.tsx 本身渲染,不是複製一份路由。
// 驗證:①原本 26 條管理員路由(2026-10 加零售市集 2 條,共 28 條)全部打得開、渲染的是原本那個頁面 ②每一條落在正確的分區與分頁
//       ③唯一的轉址 /admin/orders/:id/timeline → /admin/orders/:id 真的換了網址
//       ④每一頁都有 AI 泡泡、主內容底部留白 pb-40 還在。
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
vi.mock("./AdminNotificationsPage", async () => (await import("./testRouteStub")).stubPage("AdminNotificationsPage"));
vi.mock("./AdminRoadmapPage", async () => (await import("./testRouteStub")).stubPage("AdminRoadmapPage"));

const ORDER_TABS = ["看板", "全部訂單", "爭議"];
```

換成:

```tsx
vi.mock("./AdminNotificationsPage", async () => (await import("./testRouteStub")).stubPage("AdminNotificationsPage"));
vi.mock("./AdminRoadmapPage", async () => (await import("./testRouteStub")).stubPage("AdminRoadmapPage"));
vi.mock("./AdminMarketProductsPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketProductsPage"));
vi.mock("./AdminMarketStoresPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketStoresPage"));

const ORDER_TABS = ["看板", "全部訂單", "爭議"];
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
const SYSTEM_TABS = ["AI 用量", "通知紀錄", "投資人頁內容"];
const OVERVIEW_TABS = ["營運", "成長"];

// [網址, 渲染的頁面, 側欄分區, 分頁列(null = 不畫分頁列), 選中的分頁]
```

換成:

```tsx
const SYSTEM_TABS = ["AI 用量", "通知紀錄", "投資人頁內容"];
const OVERVIEW_TABS = ["營運", "成長"];
const MARKET_TABS = ["商品審核", "零售店家"];

// [網址, 渲染的頁面, 側欄分區, 分頁列(null = 不畫分頁列), 選中的分頁]
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
  ["/admin/notifications", "AdminNotificationsPage", "系統", SYSTEM_TABS, "通知紀錄"],
  ["/admin/roadmap", "AdminRoadmapPage", "系統", SYSTEM_TABS, "投資人頁內容"],
];

```

換成:

```tsx
  ["/admin/notifications", "AdminNotificationsPage", "系統", SYSTEM_TABS, "通知紀錄"],
  ["/admin/roadmap", "AdminRoadmapPage", "系統", SYSTEM_TABS, "投資人頁內容"],
  ["/admin/market/products", "AdminMarketProductsPage", "零售市集", MARKET_TABS, "商品審核"],
  ["/admin/market/stores", "AdminMarketStoresPage", "零售市集", MARKET_TABS, "零售店家"],
];

```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
      "/admin/orders/:id/timeline", // 轉址,見下一組測試
    ];
    expect(declared).toHaveLength(26);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
```

換成:

```tsx
      "/admin/orders/:id/timeline", // 轉址,見下一組測試
    ];
    expect(declared).toHaveLength(28);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/admin/AdminLayout.test.tsx src/pages/admin/AdminRoutes.test.tsx`

Expected:FAIL,選單 `expected […] to have a length of 8 but got 7`、路由表 `to have a length of 28 but got 26`、`/admin/market/products` 與 `/admin/market/stores` 兩列找不到頁面。

**Step 3:改 `AdminLayout.tsx` 與 `App.tsx`**

在 `src/pages/admin/AdminLayout.tsx` 找到:

```tsx
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, Sparkles, Users, Carrot, Wallet, Settings,
  LogOut, Menu, X, type LucideIcon,
} from 'lucide-react';
```

換成:

```tsx
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, Sparkles, Users, Carrot, Wallet, Settings, Store,
  LogOut, Menu, X, type LucideIcon,
} from 'lucide-react';
```

在 `src/pages/admin/AdminLayout.tsx` 找到:

```tsx
      // 路由保留、直接打 /admin/billing 仍然可以用,側欄照樣標出「財務」
      { label: '金流／發票（沙盒）', path: '/admin/billing', hidden: true },
    ],
  },
```

換成:

```tsx
      // 路由保留、直接打 /admin/billing 仍然可以用,側欄照樣標出「財務」
      { label: '金流／發票（沙盒）', path: '/admin/billing', hidden: true },
    ],
  },
  {
    // 消費者食材市集(B2C,2026-10):商品審核、零售店家(第 2 階段加零售訂單)
    key: 'market',
    to: '/admin/market/products',
    label: '零售市集',
    icon: Store,
    match: startsWithAny(['/admin/market']),
    tabs: [
      { label: '商品審核', path: '/admin/market/products' },
      { label: '零售店家', path: '/admin/market/stores' },
    ],
  },
```

在 `src/App.tsx` 找到:

```tsx
import AdminGrowthPage from "./pages/admin/AdminGrowthPage";
import AdminCampaignsPage from "./pages/admin/AdminCampaignsPage";

// 供應商後台(僅前台站)
```

換成:

```tsx
import AdminGrowthPage from "./pages/admin/AdminGrowthPage";
import AdminCampaignsPage from "./pages/admin/AdminCampaignsPage";
import AdminMarketProductsPage from "./pages/admin/AdminMarketProductsPage";
import AdminMarketStoresPage from "./pages/admin/AdminMarketStoresPage";

// 供應商後台(僅前台站)
```

在 `src/App.tsx` 找到:

```tsx
      <Route path="notifications" element={<AdminNotificationsPage />} />
      <Route path="roadmap" element={<AdminRoadmapPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
```

換成:

```tsx
      <Route path="notifications" element={<AdminNotificationsPage />} />
      <Route path="roadmap" element={<AdminRoadmapPage />} />
      {/* 消費者食材市集(B2C) */}
      <Route path="market/products" element={<AdminMarketProductsPage />} />
      <Route path="market/stores" element={<AdminMarketStoresPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  62 passed (62)`(AdminLayout 28 + AdminRoutes 34)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/admin/AdminLayout.tsx src/pages/admin/AdminLayout.test.tsx src/pages/admin/AdminRoutes.test.tsx src/App.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 管理後台加「零售市集」分區(商品審核、零售店家)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 29:第 1 階段全套檢查(本機)

不寫新程式,只確認整個 repo 沒被弄壞。任何一項對不上就停下來回報。

**Step 1:全部 vitest**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run > /tmp/market-p1-vitest.log 2>&1; grep -E "Test Files|Tests " /tmp/market-p1-vitest.log`

Expected:`Test Files  97 passed (97)`、`Tests  1311 passed (1311)`

**Step 2:tsc / eslint 不比基準多**(指令見「F. 共用指令」)

Expected:tsc `72`、eslint `10`。多出來的錯誤一定在這次新增 / 修改的檔案裡,修到回到基準。

**Step 3:兩種 build**(指令見「F. 共用指令」)

Expected:兩行都印 `0`。

**Step 4:沒有 Step 5 的 commit**(這個 Task 不改檔案)。`git -C /Users/aimand/.gemini/File/ifoodmap status --short` 應該沒有任何本 Task 造成的變更。

### Task 30:`docs/DEPLOY.md` 加第 1 階段說明

**Files:**
- Modify: `docs/DEPLOY.md`(接在檔尾,最後一節「還原順序」後面)

**Step 1:把下面整段接在 `docs/DEPLOY.md` 最後面**

````markdown

## 消費者食材市集 B2C(2026-10,migration 20261009120000 / 120100)

設計:`docs/plans/2026-10-09-consumer-market-design.md`;實作計畫:`docs/plans/2026-10-09-consumer-market-plan.md`。
一般消費者在產品站 `https://app.ifoodmap.ai/market` 免登入逛供應商的零售商品;供應商在後台開放零售、管理員審核後才上架。
跟餐廳的詢價訂單(`supplier_orders` / `order_events`)完全分開,資料表、函式、bucket 一律 `market` 開頭。

- **120000 market_catalog**
  - `market_stores`(PK = supplier_id):零售啟用(`is_enabled`,只有管理員能改、停用要填原因)、logo / 封面 / 介紹 / 退換貨說明、
    配送縣市(22 縣市,一律用「臺」,清單在 `market_tw_cities()`)、固定運費、免運門檻、最低訂購金額、出貨天數、付款方式(`cod` / `transfer`)。
  - `market_store_transfer`:轉帳資訊,獨立一張表 —— anon 讀不到(第 2 階段只在「待匯款」時經查單 RPC 給那位消費者)。
  - `market_products`:零售商品。`review_status` = draft / pending / approved / rejected;改品名、分類、規格、溫層、產地、保存方式、
    保存期限、說明、照片 → guard 自動改回 pending;改價格、庫存、上架開關不用重審。退回 / 下架要填原因(`reject_reason`)。
  - RLS:anon 只讀「已核准 + 上架中 + 店家零售啟用 + 供應商啟用中」;供應商用 `current_supplier_ids()` 管自家;管理員全部。
    審核欄位(`review_status` 改成 approved / rejected、`reviewed_by`、`is_enabled`)由 trigger 擋掉非管理員。
- **120100 market_images_storage**:bucket `market-images`(公開讀取、單檔 ≤ 2 MB、只收 jpeg / png / webp)。
  路徑 `<supplier_id>/<product_id 或 store>/<uuid>.jpg`(縮圖 `<uuid>_t.jpg`);`storage.objects` 的 4 條 policy
  (`market images supplier select / insert / update / delete`)只准該供應商的成員動自己資料夾。
  前端上傳前先在瀏覽器壓成長邊 1600px 的 JPEG(縮圖 480px,`src/lib/market/images.ts`)。
  🔴 storage 的檔案**不能用 SQL 刪**(`storage.protect_objects_delete`),要刪檔、刪 bucket 用 Storage API 或 Dashboard。
- **測試**:`supabase/tests/database/market_*.test.sql`,用 `scripts/supabase-sql.mjs dry` 在正式庫 BEGIN…ROLLBACK 乾跑
  (用法見檔案開頭;共用工具 `_market_helpers.sql`),事後跑 `market_residue.sql`(唯讀)確認沒有殘留,五個數字都要是 0。

### 部署(第 1 階段)

1. migration(先 120000 再 120100;`apply` 會在同一個請求補 ledger,並回讀確認):
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/supabase-sql.mjs apply supabase/migrations/20261009120000_market_catalog.sql
   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/supabase-sql.mjs apply supabase/migrations/20261009120100_market_images_storage.sql
   ```
   新表要等 PostgREST 重新載入 schema 才查得到(migration 最後有 `NOTIFY pgrst`);之後若前端拿到 `PGRST205`,再跑一次 `notify pgrst, 'reload schema';`。
2. **push 前端**(產品站 + 管理員站同一個 push)。🔴 一定在 migration 之後:供應商的商品目錄頁會讀 `market_products`。
3. 驗收見實作計畫 Task 31。

### 還原(第 1 階段)

1. 前端先退:Vercel Instant Rollback(`dish-to-supply`、`ifoodmap-admin` 兩個專案)。
2. 資料庫(先 120100 再 120000;用上面「寫了新 migration 之後」的 curl 方式送整份檔案):
   `supabase/rollbacks/20261009120100_market_images_storage.down.sql` → `supabase/rollbacks/20261009120000_market_catalog.down.sql`。
   🔴 120000 的還原會刪掉零售店家與商品資料,先匯出。bucket 與檔案要在 Dashboard → Storage 清空再刪。
3. repo 裡兩支 migration 一起 revert,否則 `check-migrations` 會一直紅。
````

**Step 2:確認接對了**

Run:`grep -n "^## 消費者食材市集\|^### 部署(第 1 階段)\|^### 還原(第 1 階段)" /Users/aimand/.gemini/File/ifoodmap/docs/DEPLOY.md`

Expected:三行,行號遞增,都在檔案最後面。

**Step 3:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add docs/DEPLOY.md
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
docs(market): DEPLOY.md 加消費者食材市集第 1 階段(資料表、Storage、部署與還原)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 31:第 1 階段部署與驗收

🔴 這個 Task 會改正式庫、會部署兩個網站。照順序做,每一步的 Expected 對不上就停。

**Step 1:確認本機乾淨、跟 origin 同步**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap status --short
git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count HEAD..origin/main
```

Expected:`status` 沒有未 commit 的變更(計畫檔本身若還沒進版控可以忽略);`rev-list` 印 `0`。**不是 0 就停下來回報**(origin 上有別人的新 commit;不要自己 rebase / merge)。

**Step 2:上線前最後一次乾跑(第 1 階段全部)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
node scripts/supabase-sql.mjs dry supabase/tests/database/market_harness.test.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-rollback supabase/rollbacks/20261009120000_market_catalog.down.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009120100_market_images_storage.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009120100_market_images_storage.sql --with-rollback supabase/rollbacks/20261009120100_market_images_storage.down.sql
node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
```

Expected:依序 `共 5 項` / `共 70 項` / `共 3 項` / `共 17 項` / `共 3 項`,全部 `失敗 0 項`;殘留五個 `0`。

**Step 3:套 migration(先 120000 再 120100)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
node scripts/supabase-sql.mjs apply supabase/migrations/20261009120000_market_catalog.sql
node scripts/supabase-sql.mjs apply supabase/migrations/20261009120100_market_images_storage.sql
```

Expected:
```
已套用 20261009120000_market_catalog.sql;ledger:[{"version":"20261009120000","name":"market_catalog"}]
已套用 20261009120100_market_images_storage.sql;ledger:[{"version":"20261009120100","name":"market_images_storage"}]
```
第一支失敗(例如 lock timeout)時整支會回滾,ledger 不會寫;等幾秒重跑同一行。第二支失敗時第一支已經上線,不用還原,修好再套第二支。

**Step 4:確認線上 schema**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" && Q=$(mktemp) && cat > "$Q" <<'SQL'
SELECT json_build_object(
  'ledger', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
              WHERE m.version IN ('20261009120000', '20261009120100')),
  'tables_with_rls', (SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c
                       WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity
                         AND c.relname IN ('market_stores', 'market_store_transfer', 'market_products')),
  'anon_can_read_products', has_table_privilege('anon', 'public.market_products', 'SELECT'),
  'anon_can_read_transfer', has_table_privilege('anon', 'public.market_store_transfer', 'SELECT'),
  'anon_can_write_products', has_table_privilege('anon', 'public.market_products', 'INSERT,UPDATE,DELETE'),
  'image_bucket', (SELECT json_build_object('public', b.public, 'file_size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types)
                     FROM storage.buckets b WHERE b.id = 'market-images'),
  'image_policies', (SELECT count(*) FROM pg_policies p
                      WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname LIKE 'market images %')
) AS phase1;
SQL
node scripts/supabase-sql.mjs ro "$Q"
```

Expected(JSON 裡的值):`ledger` = `["20261009120000","20261009120100"]`、`tables_with_rls` = 三張表、`anon_can_read_products` = `true`(RLS 再篩)、`anon_can_read_transfer` = `false`、`anon_can_write_products` = `false`、`image_bucket` = `{"public": true, "file_size_limit": 2097152, "mime_types": ["image/jpeg", "image/png", "image/webp"]}`、`image_policies` = `4`。

**Step 5:用線上 schema 再跑一次測試(不帶 `--with-migration`,一樣包在 BEGIN…ROLLBACK)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql
node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
```

Expected:`共 70 項,失敗 0 項`、`共 17 項,失敗 0 項`;殘留五個 `0`。

**Step 6:push(前端在 migration 之後)**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap push origin main
```

push 被 403 擋(`denied to aimand2025`)時:`gh auth switch --user armand-forge` → `git -C /Users/aimand/.gemini/File/ifoodmap -c credential.helper='!gh auth git-credential' push origin main` → push 完 `gh auth switch --user aimand2025` 切回。

等部署跑完:

```bash
gh run list --repo ifoodmap-ai/ifoodmap-ai --branch main --limit 6
```

Expected:這次 push 的 `Deploy Frontend to Vercel` 與 `Product CI` 都是 `completed success`(`check-migrations` 這次應該是綠的)。還在跑就用 `gh run watch <run id> --repo ifoodmap-ai/ifoodmap-ai` 等;GitHub 的部署狀態可能慢 5 分鐘,以 Actions 結果為準。

**Step 7:線上自我檢查**

1. anon 讀寫權限(publishable key 是公開的,但不要印出來):
   ```bash
   export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
   UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
   PK=$(curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/api-keys -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.type==="publishable");process.stdout.write(k?k.api_key:"")})')
   API=https://cwvpehqcvbfuynabpqop.supabase.co/rest/v1
   curl -s -o /dev/null -w 'products %{http_code}\n' "$API/market_products?select=id&limit=1" -H "apikey: $PK"
   curl -s -w ' transfer %{http_code}\n' "$API/market_store_transfer?select=supplier_id&limit=1" -H "apikey: $PK"
   curl -s -w ' insert %{http_code}\n' -X POST "$API/market_products" -H "apikey: $PK" -H "Content-Type: application/json" -d '{}'
   ```
   Expected:`products 200`;`transfer` 回 401(內容含 `42501` / permission denied);`insert` 回 401(42501)。
2. 頁面(手機 375 與桌機 1280,不能有橫向捲動):
   ```bash
   mkdir -p /tmp/market-p1-shots
   node ~/.claude/tools/cdp-shot.mjs https://app.ifoodmap.ai/market 375 812 market-main /tmp/market-p1-shots
   node ~/.claude/tools/cdp-shot.mjs https://app.ifoodmap.ai/market 1280 800 market-main /tmp/market-p1-shots
   sips -Z 1024 /tmp/market-p1-shots/market-main-375x812.png --out /tmp/market-p1-preview-375.png
   sips -Z 1024 /tmp/market-p1-shots/market-main-1280x800.png --out /tmp/market-p1-preview-1280.png
   ```
   Expected:兩行輸出的 `docW` 分別等於 `375`、`1280`;Read 兩張 preview:看得到「iFoodmap 食材市集」標題、搜尋列、分類圖示、空狀態文字(還沒有核准的商品)。
   再開 `https://app.ifoodmap.ai/market/nope`:顯示「找不到這個頁面。」與「回市集首頁」。
3. 管理員站:`curl -s -o /dev/null -w '%{http_code}\n' https://ifoodmap-admin.vercel.app/admin/market/products` → `200`(內容要登入,留給業主在第 3 階段實測)。

**Step 8:派一個沒參與實作的 agent 獨立驗收**(fresh context;給它這份計畫的路徑與下面的清單,只准讀、乾跑、唯讀查詢,不准改檔、不准 apply、不准輸入任何密碼)

- [ ] `supabase_migrations.schema_migrations` 有 `20261009120000`、`20261009120100`;這次 push 的 `check-migrations` 綠燈。
- [ ] 用線上 schema 乾跑 `market_catalog.test.sql`(70 項)、`market_images_storage.test.sql`(17 項)全過,事後殘留五個 0。
- [ ] anon:讀得到 `market_products` / `market_stores`(只有已核准上架的)、讀不到 `market_store_transfer`、寫不進任何 `market_*` 表;Storage 以 anon 上傳到 `market-images` 被拒。
- [ ] `/market`、`/market/p/<隨便一個 uuid>`、`/market/s/<隨便一個 uuid>`、`/market/nope` 在 375 / 1280 都沒有橫向捲動;第一個 Tab 是「跳到主要內容」;找不到的頁面是中文、有「回市集首頁」。
- [ ] 讀過 `git -C /Users/aimand/.gemini/File/ifoodmap log --stat` 這一階段的 commit:沒有 `any`、沒有密鑰、每支 migration 都有還原檔與測試、`docs/DEPLOY.md` 有第 1 階段的部署與還原說明。
- [ ] 回報格式:每一項 ✅ / ❌ + 證據(指令與輸出摘要)。

有任何 ❌:照 `docs/DEPLOY.md`「還原(第 1 階段)」判斷要不要退版,回報派工者,不要直接進第 2 階段。


---

## 第 2 階段:購物車＋下單(Task 32–57)

做完這一階段:消費者可以把商品放進購物車、按店家分組結帳(下單開關關著時只有平台管理員能下單)、用 token 連結查訂單;供應商在後台接單 / 拒單 / 收款 / 出貨 / 完成 / 取消;管理員看零售訂單總覽、必要時平台取消;每一步寄通知信(閘門沒開時全部轉寄 `ifoodmaptw@gmail.com`)。

先決條件:第 1 階段已經部署並通過驗收(Task 31)。下面的乾跑都要帶 `--with-migration supabase/migrations/20261009120000_market_catalog.sql`(第 1 階段若已上線,帶著也沒關係:migration 是可以重跑的)。

### Task 32:migration 130000(第 1 段):訂單、明細、狀態紀錄、轉移表、權限

- `market_phone_ok` / `market_email_ok`(`@market-phone-regex` / `@market-email-regex`,前端比對)。
- `market_orders`(每家店一張;收件資料、小計 / 運費 / 總額必須相加相等、付款方式、`lookup_token_hash` 必須是 64 位 hex、預留 `payment_status` / `payment_ref`)、`market_order_items`(快照,`line_total = unit_price × qty`)、`market_order_events`(備註 ≤ 300 字、payload ≤ 1000 bytes)。
- `market_transition_rules()`(`@market-transitions-begin/end`,供應商 / 管理員 / 系統各 10 條)、`market_order_status_label()`。
- 權限:anon 對三張表完全沒權限;authenticated 可讀(RLS:管理員全部、供應商自家)、只有 events 能 INSERT。

**Files:**
- Create: `supabase/migrations/20261009130000_market_orders.sql`(本 Task 第 1 段,Task 33、34 接下去)
- Test: `supabase/tests/database/market_orders.test.sql`(同上)

**Step 1:寫失敗的測試**

```sql
-- =====================================================================
-- migration 20261009130000_market_orders 的資料庫層測試(訂單表、RLS、狀態紀錄 guard / apply)
-- 執行(還沒套用時兩支都要帶;套用之後拿掉 --with-migration 再跑一次):
--   … dry supabase/tests/database/market_orders.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql
-- 訂單 fixture 直接用資料庫擁有者身分建(正式流程只能經 market_place_order,那支在 market_checkout.test.sql 測)。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'shopper@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '台灣銀行(004) 帳號 0123-456-789 戶名 市集測試');
INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, payment_methods) VALUES
  ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市', '新北市'], 120, 1000, 300, ARRAY['cod', 'transfer']),
  ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, NULL, 0, ARRAY['cod']);
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, review_status)
  VALUES ('a9300000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-00000000000a', '有機高麗菜', 'vegetable', '1 顆', 100, 8, 'approved')$q$);

CREATE FUNCTION pg_temp.ua() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000001') $f$;
CREATE FUNCTION pg_temp.ub() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000002') $f$;
CREATE FUNCTION pg_temp.uadmin() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true) $f$;
CREATE FUNCTION pg_temp.ushop() RETURNS text LANGUAGE sql AS $f$ SELECT pg_temp.jwt('a9100000-0000-4000-8000-000000000004') $f$;

-- 建一張訂單 + 第一筆紀錄(資料庫擁有者身分,= 下單 RPC 在做的事)
CREATE FUNCTION pg_temp.mk_order(p_id uuid, p_supplier uuid, p_payment text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.market_orders (id, checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                    subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
  VALUES (p_id, 'a9700000-0000-4000-8000-000000000001', p_supplier, '測試買家', '0912345678', 'shopper@market-test.invalid',
          '臺北市', '測試路 1 號 2 樓', 200, 120, 320, p_payment, repeat('a', 64), '2026-10-draft');
  INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (p_id, NULL, 'pending');
$f$;

SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000a', 'transfer');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000003', 'a9200000-0000-4000-8000-00000000000b', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000004', 'a9200000-0000-4000-8000-00000000000a', 'cod');
SELECT pg_temp.mk_order('a9600000-0000-4000-8000-000000000005', 'a9200000-0000-4000-8000-00000000000a', 'cod');
INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total) VALUES
  ('a9600000-0000-4000-8000-000000000004', 'a9300000-0000-4000-8000-0000000000a1', '有機高麗菜', '1 顆', 'ambient', 100, 2, 200);

-- ---------------------------------------------------------------------
-- 1. 物件與權限
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('RLS:三張表都開了',
  (SELECT string_agg(relname || '=' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname IN ('market_orders', 'market_order_items', 'market_order_events')),
  'market_order_events=true,market_order_items=true,market_orders=true');
SELECT pg_temp.expect('anon 對訂單三張表沒有任何權限',
  (has_table_privilege('anon', 'public.market_orders', 'SELECT,INSERT,UPDATE,DELETE')
   OR has_table_privilege('anon', 'public.market_order_items', 'SELECT,INSERT,UPDATE,DELETE')
   OR has_table_privilege('anon', 'public.market_order_events', 'SELECT,INSERT,UPDATE,DELETE'))::text,
  'false');
SELECT pg_temp.expect('登入者:訂單、明細只能讀;紀錄只能讀和新增',
  has_table_privilege('authenticated', 'public.market_orders', 'INSERT,UPDATE,DELETE')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_items', 'INSERT,UPDATE,DELETE')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_events', 'UPDATE,DELETE')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_order_events', 'INSERT')::text || '|' ||
  has_table_privilege('authenticated', 'public.market_orders', 'SELECT')::text,
  'false|false|false|true|true');
SELECT pg_temp.expect('轉移表 30 條(供應商、管理員、系統各 10 條)',
  (SELECT count(*)::text FROM public.market_transition_rules()), '30');
SELECT pg_temp.expect('電話:09 開頭 10 碼或市話 9 碼,只收數字',
  (public.market_phone_ok('0912345678') AND public.market_phone_ok('023456789')
   AND NOT public.market_phone_ok('12345') AND NOT public.market_phone_ok('0912-345-678'))::text, 'true');
SELECT pg_temp.expect('Email 格式',
  (public.market_email_ok('a.b+c@ex-ample.com.tw') AND NOT public.market_email_ok('a@b')
   AND NOT public.market_email_ok('a b@c.com') AND NOT public.market_email_ok('x@y.com,z@w.com'))::text, 'true');
SELECT pg_temp.expect('總額一定要等於小計 + 運費',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '買家', '0912345678', 'a@market-test.invalid', '臺北市',
            '測試路 1 號', 100, 60, 999, 'cod', repeat('b', 64), 'v1')$q$),
  'ERR 23514');
SELECT pg_temp.expect('收件縣市要在 22 縣市內',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '買家', '0912345678', 'a@market-test.invalid', '台北市',
            '測試路 1 號', 100, 60, 160, 'cod', repeat('b', 64), 'v1')$q$),
  'ERR 23514');
SELECT pg_temp.expect('anon 讀不到訂單',
  pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_orders$q$), 'ERR 42501');
SELECT pg_temp.expect('一般登入者(不是供應商)讀不到任何訂單',
  pg_temp.as_val('authenticated', pg_temp.ushop(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '0');
SELECT pg_temp.expect('A 只讀得到自己的 4 張單',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '4');
SELECT pg_temp.expect('B 只讀得到自己的 1 張單',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '1');
SELECT pg_temp.expect('管理員讀得到全部 5 張',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    SELECT count(*)::text FROM public.market_orders WHERE id::text LIKE 'a9600000-0000-4000-8000-%'$q$), '5');
SELECT pg_temp.expect('A 讀得到自己訂單的明細',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    SELECT count(*)::text FROM public.market_order_items WHERE order_id = 'a9600000-0000-4000-8000-000000000004'$q$), '1');
SELECT pg_temp.expect('B 讀不到 A 訂單的明細與紀錄',
  pg_temp.as_val('authenticated', pg_temp.ub(), $q$
    SELECT ((SELECT count(*) FROM public.market_order_items WHERE order_id = 'a9600000-0000-4000-8000-000000000004')
          + (SELECT count(*) FROM public.market_order_events WHERE order_id = 'a9600000-0000-4000-8000-000000000004'))::text$q$),
  '0');
SELECT pg_temp.expect('A 不能直接改訂單狀態(沒有 UPDATE 權限)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_orders SET status = 'completed' WHERE id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 不能自己建訂單',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_orders (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                      subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES (gen_random_uuid(), 'a9200000-0000-4000-8000-00000000000a', '假單', '0912345678', 'a@market-test.invalid', '臺北市',
            '測試路 1 號', 100, 0, 100, 'cod', repeat('c', 64), 'v1')$q$),
  'ERR 42501');
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql`

Expected:`Management API 400:… 42P01: relation \"public.market_orders\" does not exist`

**Step 3:寫 migration(第 1 段)**

```sql
-- =====================================================================
-- 消費者食材市集第 2 階段:零售訂單(每家店一張)、明細快照、只能新增的狀態紀錄
-- 比照餐廳訂單的「事件流 + guard trigger + apply trigger + notify trigger」(20260726100000 / 20260929100000 / 20260929110000),
-- 但完全另開新表,不動 supplier_orders / order_events。
--
-- 狀態:
--   pending → confirmed → shipped → completed                                  ← 貨到付款(cod)
--   pending → confirmed →(自動)awaiting_payment → paid → shipped → completed     ← 銀行轉帳(transfer)
--   pending → rejected(要原因)
--   pending / confirmed / awaiting_payment → cancelled(要原因;供應商或管理員)
--
-- 寫入規則(全部在伺服器端):
--   - market_orders / market_order_items 只能由 market_place_order()(SECURITY DEFINER,20261009130200)建立;
--     API 角色對這兩張表沒有任何寫入權限,也沒有寫入 policy
--   - 狀態只能經由 INSERT market_order_events 改變:
--       trg_market_guard_event(BEFORE):鎖訂單列;身分由伺服器決定(這家店的啟用中帳號 = supplier、is_admin() = admin、
--         沒有登入者且是 service_role / 資料庫直連 = system);from_status 必須等於目前狀態(畫面過期 → P0001 stale_order_status);
--         (身分, 目前狀態, 目標狀態, 付款方式) 必須在 market_transition_rules() 裡;拒單 / 取消要原因;出貨要物流。
--         第一筆紀錄(pending)只會出現在建單的交易裡
--       trg_market_apply_event(AFTER):套用狀態與時間;拒單 / 取消把庫存加回去;轉帳訂單接單後自動再寫一筆 confirmed → awaiting_payment
--   - 紀錄只能新增:UPDATE / DELETE 一律擋(所以訂單也刪不掉 —— 那是交易紀錄);同一個 INSERT 同一張單只能一筆
--
-- 讀取:供應商讀自家的訂單、明細、紀錄;管理員全部;anon 什麼都讀不到(消費者只能經 market_get_orders(token))
--
-- 前端 src/lib/market/orders.ts 的 MARKET_TRANSITIONS / 狀態清單,由 vitest 解析本檔 @market-transitions / @market-statuses 標記比對。
-- 還原:supabase/rollbacks/20261009130000_market_orders.down.sql
-- 測試:supabase/tests/database/market_orders.test.sql
-- =====================================================================

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 0. 共用檢查(收件電話、Email;下單 RPC 也用同一支 —— 前端 src/lib/market/checkout.ts 的 regex 由 vitest 比對)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_phone_ok(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p IS NOT NULL AND p ~ '^0[0-9]{8,9}$'  -- @market-phone-regex
$$;

CREATE OR REPLACE FUNCTION public.market_email_ok(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p IS NOT NULL AND char_length(p) <= 254
     AND p ~ '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$'  -- @market-email-regex
$$;

-- ---------------------------------------------------------------------
-- 1. 訂單、明細、狀態紀錄
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id         uuid NOT NULL,
  supplier_id         uuid NOT NULL REFERENCES public.market_stores(supplier_id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'pending',
  buyer_name          text NOT NULL,
  buyer_phone         text NOT NULL,
  buyer_email         text NOT NULL,
  ship_city           text NOT NULL,
  ship_address        text NOT NULL,
  buyer_note          text,
  subtotal            integer NOT NULL,
  shipping_fee        integer NOT NULL,
  total               integer NOT NULL,
  payment_method      text NOT NULL,
  payment_status      text NOT NULL DEFAULT 'unpaid',
  payment_ref         text,
  lookup_token_hash   text NOT NULL,
  terms_version       text NOT NULL,
  status_note         text,
  shipped_carrier     text,
  shipped_tracking_no text,
  confirmed_at        timestamptz,
  paid_at             timestamptz,
  shipped_at          timestamptz,
  completed_at        timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_orders_status CHECK (status IN (
    -- @market-statuses-begin
    'pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled'
    -- @market-statuses-end
  )),
  CONSTRAINT market_orders_buyer CHECK (
    char_length(buyer_name) BETWEEN 1 AND 50
    AND public.market_phone_ok(buyer_phone)
    AND public.market_email_ok(buyer_email)
    AND ship_city = ANY (public.market_tw_cities())
    AND char_length(ship_address) BETWEEN 5 AND 200
    AND (buyer_note IS NULL OR char_length(buyer_note) <= 300)
  ),
  CONSTRAINT market_orders_money CHECK (subtotal > 0 AND shipping_fee >= 0 AND total = subtotal + shipping_fee),
  -- payment_status / payment_ref 預留給之後的線上付款,目前不用
  CONSTRAINT market_orders_payment CHECK (
    payment_method IN ('cod', 'transfer')
    AND payment_status IN ('unpaid', 'paid', 'refunded')
    AND (payment_ref IS NULL OR char_length(payment_ref) <= 100)
  ),
  CONSTRAINT market_orders_token CHECK (lookup_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT market_orders_misc_lengths CHECK (
    char_length(terms_version) BETWEEN 1 AND 20
    AND (status_note IS NULL OR char_length(status_note) <= 300)
    AND (shipped_carrier IS NULL OR char_length(shipped_carrier) <= 50)
    AND (shipped_tracking_no IS NULL OR char_length(shipped_tracking_no) <= 100)
  )
);

CREATE INDEX IF NOT EXISTS market_orders_supplier_idx ON public.market_orders (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_orders_token_idx ON public.market_orders (lookup_token_hash);
CREATE INDEX IF NOT EXISTS market_orders_checkout_idx ON public.market_orders (checkout_id);
CREATE INDEX IF NOT EXISTS market_orders_status_idx ON public.market_orders (status, created_at DESC);

COMMENT ON TABLE public.market_orders IS
  '零售訂單(一次結帳按店家拆成多張,checkout_id 相同、共用一組查詢 token)。只由 market_place_order 建立;狀態只經 market_order_events 改變。';
COMMENT ON COLUMN public.market_orders.lookup_token_hash IS '查詢 token 的 sha256 hex(token 本身只在下單回傳與確認信裡出現)';

CREATE TABLE IF NOT EXISTS public.market_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES public.market_orders(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES public.market_products(id) ON DELETE SET NULL,
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 60),
  spec         text NOT NULL CHECK (char_length(spec) BETWEEN 1 AND 40),
  temperature  text NOT NULL CHECK (temperature IN ('ambient', 'chilled', 'frozen')),
  unit_price   integer NOT NULL CHECK (unit_price BETWEEN 1 AND 1000000),
  qty          integer NOT NULL CHECK (qty BETWEEN 1 AND 99),
  line_total   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_order_items_line_total CHECK (line_total = unit_price * qty)
);

CREATE INDEX IF NOT EXISTS market_order_items_order_idx ON public.market_order_items (order_id);

COMMENT ON TABLE public.market_order_items IS '零售訂單明細(下單當下的品名、規格、單價快照;商品之後改價不影響舊訂單)';

CREATE TABLE IF NOT EXISTS public.market_order_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES public.market_orders(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor_role  text NOT NULL DEFAULT 'supplier' CHECK (actor_role IN ('consumer', 'supplier', 'admin', 'system')),
  actor_id    uuid,
  note        text CHECK (note IS NULL OR char_length(note) <= 300),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_order_events_statuses CHECK (
    to_status IN ('pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled')
    AND (from_status IS NULL
         OR from_status IN ('pending', 'confirmed', 'awaiting_payment', 'paid', 'shipped', 'completed', 'rejected', 'cancelled'))
  ),
  CONSTRAINT market_order_events_payload CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1000)
);

CREATE INDEX IF NOT EXISTS market_order_events_order_idx ON public.market_order_events (order_id, created_at);

COMMENT ON TABLE public.market_order_events IS
  '零售訂單狀態紀錄(只能新增)。actor_role / actor_id / from_status 由 market_guard_event 依登入身分與目前狀態改寫,前端送什麼都不算。';

-- ---------------------------------------------------------------------
-- 2. 轉移表(唯一來源;前端 MARKET_TRANSITIONS 由 vitest 對照)、狀態中文
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_transition_rules()
RETURNS TABLE (actor text, from_status text, to_status text, payment text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT t.actor, t.from_status, t.to_status, t.payment FROM (VALUES
    -- @market-transitions-begin
    -- 這家店的供應商
    ('supplier', 'pending', 'confirmed', 'any'),
    ('supplier', 'pending', 'rejected', 'any'),
    ('supplier', 'pending', 'cancelled', 'any'),
    ('supplier', 'confirmed', 'awaiting_payment', 'transfer'),
    ('supplier', 'confirmed', 'shipped', 'cod'),
    ('supplier', 'confirmed', 'cancelled', 'any'),
    ('supplier', 'awaiting_payment', 'paid', 'transfer'),
    ('supplier', 'awaiting_payment', 'cancelled', 'transfer'),
    ('supplier', 'paid', 'shipped', 'transfer'),
    ('supplier', 'shipped', 'completed', 'any'),
    -- 平台管理員(處理客訴):同供應商
    ('admin', 'pending', 'confirmed', 'any'),
    ('admin', 'pending', 'rejected', 'any'),
    ('admin', 'pending', 'cancelled', 'any'),
    ('admin', 'confirmed', 'awaiting_payment', 'transfer'),
    ('admin', 'confirmed', 'shipped', 'cod'),
    ('admin', 'confirmed', 'cancelled', 'any'),
    ('admin', 'awaiting_payment', 'paid', 'transfer'),
    ('admin', 'awaiting_payment', 'cancelled', 'transfer'),
    ('admin', 'paid', 'shipped', 'transfer'),
    ('admin', 'shipped', 'completed', 'any'),
    -- 系統(service_role、資料庫直連;緊急處理用):同供應商
    ('system', 'pending', 'confirmed', 'any'),
    ('system', 'pending', 'rejected', 'any'),
    ('system', 'pending', 'cancelled', 'any'),
    ('system', 'confirmed', 'awaiting_payment', 'transfer'),
    ('system', 'confirmed', 'shipped', 'cod'),
    ('system', 'confirmed', 'cancelled', 'any'),
    ('system', 'awaiting_payment', 'paid', 'transfer'),
    ('system', 'awaiting_payment', 'cancelled', 'transfer'),
    ('system', 'paid', 'shipped', 'transfer'),
    ('system', 'shipped', 'completed', 'any')
    -- @market-transitions-end
  ) AS t(actor, from_status, to_status, payment)
$$;

CREATE OR REPLACE FUNCTION public.market_order_status_label(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_status
    WHEN 'pending' THEN '待接單'   WHEN 'confirmed' THEN '已接單'  WHEN 'awaiting_payment' THEN '待匯款'
    WHEN 'paid' THEN '已收款'      WHEN 'shipped' THEN '已出貨'    WHEN 'completed' THEN '已完成'
    WHEN 'rejected' THEN '已拒單'  WHEN 'cancelled' THEN '已取消'
    ELSE COALESCE(p_status, '(無)')
  END
$$;

-- ---------------------------------------------------------------------
-- 3. 權限:供應商讀自家、管理員全部;只有狀態紀錄開放 INSERT(guard 再檢查)
-- ---------------------------------------------------------------------
ALTER TABLE public.market_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_order_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.market_orders, public.market_order_items, public.market_order_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.market_orders, public.market_order_items, public.market_order_events TO authenticated;
GRANT INSERT ON TABLE public.market_order_events TO authenticated;

DROP POLICY IF EXISTS "market orders party read" ON public.market_orders;
CREATE POLICY "market orders party read" ON public.market_orders
  FOR SELECT TO authenticated
  USING (public.is_admin() OR supplier_id IN (SELECT public.current_supplier_ids()));

DROP POLICY IF EXISTS "market order items party read" ON public.market_order_items;
CREATE POLICY "market order items party read" ON public.market_order_items
  FOR SELECT TO authenticated
  USING (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

DROP POLICY IF EXISTS "market order events party read" ON public.market_order_events;
CREATE POLICY "market order events party read" ON public.market_order_events
  FOR SELECT TO authenticated
  USING (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

DROP POLICY IF EXISTS "market order events party insert" ON public.market_order_events;
CREATE POLICY "market order events party insert" ON public.market_order_events
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR order_id IN (
    SELECT o.id FROM public.market_orders o WHERE o.supplier_id IN (SELECT public.current_supplier_ids())));

REVOKE ALL ON FUNCTION public.market_transition_rules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_order_status_label(text) FROM PUBLIC, anon, authenticated;
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009130000_market_orders.sql`

Expected:`…共 17 項,失敗 0 項`;殘留檢查五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130000_market_orders.sql supabase/tests/database/market_orders.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單、明細、狀態紀錄資料表與轉移表(migration 130000 第 1 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 33:migration 130000(第 2 段):狀態紀錄的 guard、只能新增、一次一筆

guard(BEFORE INSERT):鎖住訂單列;第一筆紀錄只能是 `pending`、身分記成 consumer(只有下單 RPC 會寫);之後身分由伺服器決定(管理員 / 該店成員 / service_role = system,其他人 `not_order_party`);`from_status` 跟目前狀態不同 → `stale_order_status`;查轉移表;拒單 / 取消要原因;出貨要物流(≤ 50 字)、單號 ≤ 100 字。另外兩個 trigger:紀錄不能改不能刪、同一個 INSERT 同一張單只能一筆。

**Files:**
- Modify: `supabase/migrations/20261009130000_market_orders.sql`(接在檔尾)
- Test: `supabase/tests/database/market_orders.test.sql`(接在檔尾)

**Step 1:寫失敗的測試(接在測試檔最後面)**

```sql

-- ---------------------------------------------------------------------
-- 2. 狀態紀錄的 guard
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('第一筆紀錄的身分是消費者',
  (SELECT actor_role FROM public.market_order_events WHERE order_id = 'a9600000-0000-4000-8000-000000000001'), 'consumer');
SELECT pg_temp.expect('已經有紀錄的單不能再寫「待接單」',
  pg_temp.as_exec('postgres', '', $q$
    INSERT INTO public.market_order_events (order_id, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', 'pending')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('B 不能操作 A 的單',
  pg_temp.as_exec('authenticated', pg_temp.ub(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed')$q$),
  'ERR 42501:not_order_party');
SELECT pg_temp.expect('anon 不能寫紀錄',
  pg_temp.as_exec('anon', pg_temp.anon(), $q$
    INSERT INTO public.market_order_events (order_id, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed')$q$),
  'ERR 42501');
SELECT pg_temp.expect('A 不能從待接單直接出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('畫面過期(前端以為已經接單)被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR P0001:stale_order_status');
SELECT pg_temp.expect('拒單沒填原因被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'rejected', '   ')$q$),
  'ERR 22023:reason_required');
SELECT pg_temp.expect('同一個 INSERT 對同一張單寫兩筆被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note) VALUES
      ('a9600000-0000-4000-8000-000000000005', 'pending', 'confirmed', NULL),
      ('a9600000-0000-4000-8000-000000000005', 'pending', 'rejected', '重複')$q$),
  'ERR P0001:one_event_per_order');
SELECT pg_temp.expect('紀錄不能修改',
  pg_temp.as_exec('postgres', '', $q$
    UPDATE public.market_order_events SET note = '竄改' WHERE order_id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:events_append_only');
SELECT pg_temp.expect('紀錄不能刪除(所以訂單也刪不掉)',
  pg_temp.as_exec('postgres', '', $q$
    DELETE FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501:events_append_only');
SELECT pg_temp.expect('供應商連 UPDATE 紀錄的權限都沒有',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    UPDATE public.market_order_events SET note = '竄改' WHERE order_id = 'a9600000-0000-4000-8000-000000000001'$q$),
  'ERR 42501');
```

**Step 2:跑測試,確認失敗**

Run:同 Task 32 Step 4。Expected:`…共 28 項,失敗 9 項`(例如「第一筆紀錄的身分是消費者」got `supplier`);exit 1。

**Step 3:寫 migration(第 2 段,接在檔尾)**

```sql

-- ---------------------------------------------------------------------
-- 4. 狀態紀錄寫入前的檢查(guard)、只能新增、同一個 INSERT 同一張單只能一筆
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_guard_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order    public.market_orders%ROWTYPE;
  v_uid      uuid := auth.uid();
  v_actor    text;
  v_carrier  text;
  v_tracking text;
BEGIN
  -- 鎖住訂單這一列:同一張單的並發操作在這裡排隊,後到的會讀到新狀態
  SELECT * INTO v_order FROM public.market_orders o WHERE o.id = NEW.order_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- 交給外鍵報錯
  END IF;

  NEW.note := NULLIF(btrim(COALESCE(NEW.note, '')), '');
  NEW.actor_id := v_uid;

  -- 第一筆紀錄:訂單只能由 market_place_order 建立,建好的當下(同一個交易裡)還沒有任何紀錄
  IF NOT EXISTS (SELECT 1 FROM public.market_order_events e WHERE e.order_id = NEW.order_id) THEN
    IF NEW.to_status <> 'pending' OR NEW.from_status IS NOT NULL THEN
      RAISE EXCEPTION '訂單的第一筆紀錄只能是「待接單」' USING ERRCODE = '42501', HINT = 'transition_not_allowed';
    END IF;
    NEW.actor_role := 'consumer';
    NEW.payload := '{}'::jsonb;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- 身分由伺服器決定(前端送的 actor_role 不算)
  IF public.is_admin() THEN
    v_actor := 'admin';
  ELSIF v_uid IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.supplier_accounts a
           WHERE a.user_id = v_uid AND a.is_active AND a.supplier_id = v_order.supplier_id) THEN
    v_actor := 'supplier';
  ELSIF v_uid IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role' THEN
    v_actor := 'system';
  ELSE
    RAISE EXCEPTION '這張零售訂單不是你家的,不能操作' USING ERRCODE = '42501', HINT = 'not_order_party';
  END IF;
  NEW.actor_role := v_actor;
  IF v_actor <> 'system' THEN
    NEW.created_at := now();
  END IF;

  -- 畫面過期:前端以為的狀態跟資料庫不一樣
  IF NEW.from_status IS NOT NULL AND NEW.from_status IS DISTINCT FROM v_order.status THEN
    RAISE EXCEPTION '這張訂單已經是「%」了,畫面上的資料過期,請重新整理', public.market_order_status_label(v_order.status)
      USING ERRCODE = 'P0001', HINT = 'stale_order_status';
  END IF;
  NEW.from_status := v_order.status;

  IF NOT EXISTS (
       SELECT 1 FROM public.market_transition_rules() r
        WHERE r.actor = v_actor AND r.from_status = v_order.status AND r.to_status = NEW.to_status
          AND r.payment IN ('any', v_order.payment_method)) THEN
    RAISE EXCEPTION '不能把訂單從「%」改成「%」',
        public.market_order_status_label(v_order.status), public.market_order_status_label(NEW.to_status)
      USING ERRCODE = '42501', HINT = 'transition_not_allowed';
  END IF;

  IF NEW.to_status IN ('rejected', 'cancelled') AND NEW.note IS NULL THEN
    RAISE EXCEPTION '拒單或取消要填寫原因(會告知消費者)' USING ERRCODE = '22023', HINT = 'reason_required';
  END IF;

  IF NEW.to_status = 'shipped' THEN
    v_carrier  := NULLIF(btrim(COALESCE(NEW.payload->>'carrier', '')), '');
    v_tracking := NULLIF(btrim(COALESCE(NEW.payload->>'tracking_no', '')), '');
    IF v_carrier IS NULL OR char_length(v_carrier) > 50 THEN
      RAISE EXCEPTION '出貨要填寫物流(50 字以內)' USING ERRCODE = '22023', HINT = 'carrier_required';
    END IF;
    IF v_tracking IS NOT NULL AND char_length(v_tracking) > 100 THEN
      RAISE EXCEPTION '物流單號太長(100 字以內)' USING ERRCODE = '22023', HINT = 'tracking_too_long';
    END IF;
    NEW.payload := jsonb_strip_nulls(jsonb_build_object('carrier', v_carrier, 'tracking_no', v_tracking));
  ELSE
    NEW.payload := '{}'::jsonb;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_guard_event ON public.market_order_events;
CREATE TRIGGER trg_market_guard_event
BEFORE INSERT ON public.market_order_events
FOR EACH ROW EXECUTE FUNCTION public.market_guard_event();

CREATE OR REPLACE FUNCTION public.market_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '零售訂單的狀態紀錄只能新增,不能修改或刪除' USING ERRCODE = '42501', HINT = 'events_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_market_events_immutable ON public.market_order_events;
CREATE TRIGGER trg_market_events_immutable
BEFORE UPDATE OR DELETE ON public.market_order_events
FOR EACH ROW EXECUTE FUNCTION public.market_events_immutable();

CREATE OR REPLACE FUNCTION public.market_events_one_per_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_events GROUP BY order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '同一張訂單一次只能寫一筆紀錄,請一步一步來' USING ERRCODE = 'P0001', HINT = 'one_event_per_order';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_events_one_per_order ON public.market_order_events;
CREATE TRIGGER trg_market_events_one_per_order
AFTER INSERT ON public.market_order_events
REFERENCING NEW TABLE AS new_events
FOR EACH STATEMENT EXECUTE FUNCTION public.market_events_one_per_order();

REVOKE ALL ON FUNCTION public.market_guard_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_events_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_events_one_per_order() FROM PUBLIC, anon, authenticated;
```

**Step 4:跑測試,確認通過**

Run:同 Task 32 Step 4。Expected:`…共 28 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130000_market_orders.sql supabase/tests/database/market_orders.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單狀態紀錄 guard、只能新增、一次一筆(migration 130000 第 2 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 34:migration 130000(第 3 段):套用狀態、補庫存、轉帳自動待匯款

apply(AFTER INSERT):改訂單狀態與各時間欄、拒單 / 取消把庫存加回去(不限量的不動)、記原因 / 物流;轉帳訂單一接單就自動再寫一筆 `confirmed → awaiting_payment`(actor = system)。

**Files:**
- Modify: `supabase/migrations/20261009130000_market_orders.sql`(接在檔尾)
- Test: `supabase/tests/database/market_orders.test.sql`(接在檔尾)

**Step 1:寫失敗的測試(接在測試檔最後面)**

```sql

-- ---------------------------------------------------------------------
-- 3. 套用狀態(apply)
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('A 接單(貨到付款)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed')$q$),
  'OK');
SELECT pg_temp.expect('狀態與接單時間套上去;紀錄的身分是供應商、actor_id 是 A',
  (SELECT o.status || '|' || (o.confirmed_at IS NOT NULL)::text || '|' || e.actor_role || '|' || e.actor_id::text
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'confirmed'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000001'),
  'confirmed|true|supplier|a9100000-0000-4000-8000-000000000001');
SELECT pg_temp.expect('出貨沒填物流被擋',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"tracking_no":"9001"}')$q$),
  'ERR 22023:carrier_required');
SELECT pg_temp.expect('A 出貨(物流、單號)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped',
            '{"carrier":" 黑貓宅急便 ","tracking_no":"9001","extra":"不該存"}')$q$),
  'OK');
SELECT pg_temp.expect('物流與單號寫進訂單;紀錄只留 carrier / tracking_no',
  (SELECT o.shipped_carrier || '|' || o.shipped_tracking_no || '|' || e.payload::text
     FROM public.market_orders o
     JOIN public.market_order_events e ON e.order_id = o.id AND e.to_status = 'shipped'
    WHERE o.id = 'a9600000-0000-4000-8000-000000000001'),
  '黑貓宅急便|9001|{"carrier": "黑貓宅急便", "tracking_no": "9001"}');
SELECT pg_temp.expect('A 完成訂單',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000001', 'shipped', 'completed')$q$),
  'OK');
SELECT pg_temp.expect('轉帳訂單接單 → 自動待匯款(三筆紀錄)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000002', 'pending', 'confirmed') RETURNING 1)
    SELECT count(*)::text FROM e$q$),
  '1');
SELECT pg_temp.expect('……訂單停在待匯款,紀錄 pending → confirmed → awaiting_payment',
  (SELECT o.status || '|' || (SELECT string_agg(e.to_status, '>' ORDER BY e.created_at, e.to_status = 'awaiting_payment')
                                FROM public.market_order_events e WHERE e.order_id = o.id)
     FROM public.market_orders o WHERE o.id = 'a9600000-0000-4000-8000-000000000002'),
  'awaiting_payment|pending>confirmed>awaiting_payment');
SELECT pg_temp.expect('待匯款不能直接出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'awaiting_payment', 'shipped', '{"carrier":"黑貓"}')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('標記已收款',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'awaiting_payment', 'paid')$q$),
  'OK');
SELECT pg_temp.expect('已收款後出貨',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
    VALUES ('a9600000-0000-4000-8000-000000000002', 'paid', 'shipped', '{"carrier":"自行配送"}')$q$),
  'OK');
SELECT pg_temp.expect('……狀態已出貨、收款時間有填',
  (SELECT status || '|' || (paid_at IS NOT NULL)::text FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000002'),
  'shipped|true');
SELECT pg_temp.expect('取消(填原因)',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
    VALUES ('a9600000-0000-4000-8000-000000000004', 'pending', 'cancelled', '缺貨')$q$),
  'OK');
SELECT pg_temp.expect('……庫存加回去(8 + 2 = 10)、原因與結束時間寫進訂單',
  (SELECT p.stock::text || '|' || o.status_note || '|' || (o.closed_at IS NOT NULL)::text
     FROM public.market_products p, public.market_orders o
    WHERE p.id = 'a9300000-0000-4000-8000-0000000000a1' AND o.id = 'a9600000-0000-4000-8000-000000000004'),
  '10|缺貨|true');
SELECT pg_temp.expect('已取消的單不能再接',
  pg_temp.as_exec('authenticated', pg_temp.ua(), $q$
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES ('a9600000-0000-4000-8000-000000000004', 'cancelled', 'confirmed')$q$),
  'ERR 42501:transition_not_allowed');
SELECT pg_temp.expect('管理員取消 B 的單,紀錄的身分是管理員',
  pg_temp.as_val('authenticated', pg_temp.uadmin(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status, note)
               VALUES ('a9600000-0000-4000-8000-000000000003', 'pending', 'cancelled', '客訴:重複下單') RETURNING actor_role)
    SELECT actor_role FROM e$q$),
  'admin');
SELECT pg_temp.expect('前端送的 actor_role 不算(A 冒充管理員 → 記成 supplier)',
  pg_temp.as_val('authenticated', pg_temp.ua(), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status, actor_role)
               VALUES ('a9600000-0000-4000-8000-000000000005', 'pending', 'confirmed', 'admin') RETURNING actor_role)
    SELECT actor_role FROM e$q$),
  'supplier');
```

**Step 2:跑測試,確認失敗**

Run:同 Task 32 Step 4。Expected:`…共 45 項,失敗 12 項`(例如「狀態與接單時間套上去」got `pending|false|…`);exit 1。

**Step 3:寫 migration(第 3 段,接在檔尾)**

```sql

-- ---------------------------------------------------------------------
-- 5. 狀態紀錄寫入後:套用狀態與時間、拒單 / 取消補庫存、轉帳訂單接單後自動待匯款
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_apply_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment text;
BEGIN
  UPDATE public.market_orders o
     SET status              = NEW.to_status,
         updated_at          = now(),
         confirmed_at        = CASE WHEN NEW.to_status = 'confirmed' THEN NEW.created_at ELSE o.confirmed_at END,
         paid_at             = CASE WHEN NEW.to_status = 'paid' THEN NEW.created_at ELSE o.paid_at END,
         shipped_at          = CASE WHEN NEW.to_status = 'shipped' THEN NEW.created_at ELSE o.shipped_at END,
         completed_at        = CASE WHEN NEW.to_status = 'completed' THEN NEW.created_at ELSE o.completed_at END,
         closed_at           = CASE WHEN NEW.to_status IN ('rejected', 'cancelled') THEN NEW.created_at ELSE o.closed_at END,
         status_note         = CASE WHEN NEW.to_status IN ('rejected', 'cancelled') THEN NEW.note ELSE o.status_note END,
         shipped_carrier     = CASE WHEN NEW.to_status = 'shipped' THEN NEW.payload->>'carrier' ELSE o.shipped_carrier END,
         shipped_tracking_no = CASE WHEN NEW.to_status = 'shipped' THEN NEW.payload->>'tracking_no' ELSE o.shipped_tracking_no END
   WHERE o.id = NEW.order_id
  RETURNING o.payment_method INTO v_payment;

  -- 拒單 / 取消:有設庫存的商品把數量加回去(商品已刪除的就算了)
  IF NEW.to_status IN ('rejected', 'cancelled') THEN
    UPDATE public.market_products p
       SET stock = LEAST(p.stock + i.qty, 100000)
      FROM public.market_order_items i
     WHERE i.order_id = NEW.order_id AND i.product_id = p.id AND p.stock IS NOT NULL;
  END IF;

  -- 轉帳訂單:接單後同一個交易、同一個身分自動進入「待匯款」(供應商畫面上只有一顆「接單」)
  IF NEW.to_status = 'confirmed' AND v_payment = 'transfer' THEN
    INSERT INTO public.market_order_events (order_id, from_status, to_status)
    VALUES (NEW.order_id, 'confirmed', 'awaiting_payment');
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_market_apply_event ON public.market_order_events;
CREATE TRIGGER trg_market_apply_event
AFTER INSERT ON public.market_order_events
FOR EACH ROW EXECUTE FUNCTION public.market_apply_event();

REVOKE ALL ON FUNCTION public.market_apply_event() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
```

**Step 4:跑測試,確認通過**

Run:同 Task 32 Step 4。Expected:`…共 45 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130000_market_orders.sql supabase/tests/database/market_orders.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單狀態套用、拒單取消補庫存、轉帳自動待匯款(migration 130000 第 3 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 35:migration 130100:狀態紀錄 → pg_net → `market-notify`

比照 `supabase/migrations/20260728100000_order_notifications.sql:19-69`:共用既有的 `app_config.notify_service_key`(= secret `NOTIFY_SECRET`,不新增 secret,就不會因為 `supabase secrets set` 讓所有 function 重啟),新增 `app_config.market_notify_function_url`;送不出去只 `RAISE WARNING`,不影響訂單。測試把網址換成 `http://127.0.0.1:9/market-test`,佇列跟著 ROLLBACK 消失。

**Files:**
- Create: `supabase/migrations/20261009130100_market_notify.sql`
- Test: `supabase/tests/database/market_notify.test.sql`

**Step 1:寫失敗的測試**

```sql
-- =====================================================================
-- migration 20261009130100_market_notify 的資料庫層測試
--   … dry supabase/tests/database/market_notify.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql \
--     --with-migration supabase/migrations/20261009130100_market_notify.sql
-- 通知網址在交易裡換成 http://127.0.0.1:9/market-test:排進 pg_net 佇列的請求跟著 ROLLBACK 消失,不會真的送出。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a');
INSERT INTO public.market_stores (supplier_id, delivery_cities) VALUES ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市']);
INSERT INTO public.market_orders (id, checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address,
                                  subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
VALUES ('a9600000-0000-4000-8000-000000000001', 'a9700000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a',
        '測試買家', '0912345678', 'shopper@market-test.invalid', '臺北市', '測試路 1 號', 200, 0, 200, 'cod', repeat('a', 64), 'v1');

CREATE FUNCTION pg_temp.queued() RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM net.http_request_queue WHERE url = 'http://127.0.0.1:9/market-test'
$f$;

SELECT pg_temp.expect('通知函式不開給 API 角色',
  (has_function_privilege('anon', 'public.market_enqueue_notify(jsonb)', 'EXECUTE')
   OR has_function_privilege('authenticated', 'public.market_enqueue_notify(jsonb)', 'EXECUTE'))::text, 'false');
SELECT pg_temp.expect('通知網址指向 market-notify(套用前沒有這一列時由 migration 新增)',
  (SELECT value FROM public.app_config WHERE key = 'market_notify_function_url'),
  'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify');
SELECT pg_temp.expect('共用的 notify_service_key 存在(值不印出來)',
  (SELECT (count(*) = 1)::text FROM public.app_config WHERE key = 'notify_service_key'), 'true');
SELECT pg_temp.expect('AFTER trigger 依名稱字母序執行:先套用狀態(apply)、再排通知(notify)',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.market_order_events'::regclass AND NOT tgisinternal AND tgname LIKE 'trg_market_%'
      AND tgtype & 2 = 0),  -- tgtype 第 2 個位元 = BEFORE;0 = AFTER
  'trg_market_apply_event,trg_market_events_one_per_order,trg_market_notify_event');

UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES ('a9600000-0000-4000-8000-000000000001', NULL, 'pending');

SELECT pg_temp.expect('每筆狀態紀錄排一個通知請求',
  pg_temp.queued()::text, '1');
SELECT pg_temp.expect('……內容只有 kind 與 event_id,帶 Authorization',
  (SELECT (convert_from(q.body, 'UTF8')::jsonb ->> 'kind') || '|' ||
          ((convert_from(q.body, 'UTF8')::jsonb ->> 'event_id') = (SELECT e.id::text FROM public.market_order_events e
                                                                     WHERE e.order_id = 'a9600000-0000-4000-8000-000000000001'))::text || '|' ||
          (q.headers ? 'Authorization')::text || '|' ||
          (SELECT count(*) FROM jsonb_object_keys(convert_from(q.body, 'UTF8')::jsonb))::text
     FROM net.http_request_queue q WHERE q.url = 'http://127.0.0.1:9/market-test'),
  'event|true|true|2');
SELECT pg_temp.expect('供應商操作也會排通知(接單)',
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
    WITH e AS (INSERT INTO public.market_order_events (order_id, from_status, to_status)
               VALUES ('a9600000-0000-4000-8000-000000000001', 'pending', 'confirmed') RETURNING 1)
    SELECT count(*)::text FROM e$q$),
  '1');
SELECT pg_temp.expect('……佇列變 2 筆', pg_temp.queued()::text, '2');

DELETE FROM public.app_config WHERE key = 'market_notify_function_url';
SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000001'), $q$
  INSERT INTO public.market_order_events (order_id, from_status, to_status, payload)
  VALUES ('a9600000-0000-4000-8000-000000000001', 'confirmed', 'shipped', '{"carrier":"黑貓"}')$q$);
SELECT pg_temp.expect('沒設通知網址:照樣出貨、不排通知',
  (SELECT status FROM public.market_orders WHERE id = 'a9600000-0000-4000-8000-000000000001') || '|' || pg_temp.queued()::text,
  'shipped|2');
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009130000_market_orders.sql`

Expected:`Management API 400:… 42883: function \"public.market_enqueue_notify(jsonb)\" does not exist`

**Step 3:寫 migration**

```sql
-- =====================================================================
-- 消費者食材市集:訂單通知(DB → pg_net → Edge Function market-notify → Resend)
-- 比照 20260728100000_order_notifications.sql 的 notify_order_event:
--   - 非同步(pg_net 送出就返回),寄信失敗不會讓訂單交易 rollback
--   - 共享密鑰:沿用 app_config.notify_service_key(= Supabase secret NOTIFY_SECRET,notify 那支同一把)——
--     不新增 secret,就不會因為 supabase secrets set 讓專案上所有 Edge Function 版號 +1
--   - 網址:新增 app_config.market_notify_function_url
-- 送出的內容:
--   每一筆狀態紀錄 → {kind:'event', event_id}(market-notify 自己用 service role 讀紀錄與訂單)
--   下單成功 → {kind:'placed', checkout_id, token}(由 market_place_order 呼叫,見 20261009130200;
--     token 只在這裡出現:pg_net 寄出後佇列列就刪除,net._http_response 只存回應,market-notify 的回應不含 token)
-- 🔴 寄給真實消費者要業主核准:market-notify 在 secret MARKET_NOTIFY_LIVE 不是 "true" 時,所有信只寄 ifoodmaptw@gmail.com。
-- 測試:supabase/tests/database/market_notify.test.sql(把網址換成 http://127.0.0.1:9/… 再 ROLLBACK,佇列不會真的送出)
-- =====================================================================
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.market_enqueue_notify(p_body jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, extensions
AS $$
DECLARE
  v_url text;
  v_key text;
BEGIN
  SELECT value INTO v_url FROM public.app_config WHERE key = 'market_notify_function_url';
  SELECT value INTO v_key FROM public.app_config WHERE key = 'notify_service_key';
  -- 沒設定就安靜跳過 —— 不要因為通知沒接好就讓下單失敗
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := p_body,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  -- 通知出任何問題都不能影響訂單
  RAISE WARNING 'market_enqueue_notify failed: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.market_notify_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.market_enqueue_notify(jsonb_build_object('kind', 'event', 'event_id', NEW.id));
  RETURN NULL;
END;
$$;

-- 名稱字母序排在 trg_market_apply_event 後面:先套用狀態、再排通知
DROP TRIGGER IF EXISTS trg_market_notify_event ON public.market_order_events;
CREATE TRIGGER trg_market_notify_event
AFTER INSERT ON public.market_order_events
FOR EACH ROW EXECUTE FUNCTION public.market_notify_event();

INSERT INTO public.app_config (key, value)
VALUES ('market_notify_function_url', 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON FUNCTION public.market_enqueue_notify(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_notify_event() FROM PUBLIC, anon, authenticated;
```

**Step 4:跑測試,確認通過**

Run:同 Step 2,最後加 `--with-migration supabase/migrations/20261009130100_market_notify.sql`。Expected:`…共 9 項,失敗 0 項`;殘留五個 `0`(`test_queue_rows` 也是 0)。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130100_market_notify.sql supabase/tests/database/market_notify.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單狀態紀錄經 pg_net 排通知(migration 130100)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 36:migration 130200(第 1 段):下單限流 `market_rate_take`

計數表 `market_rate_counters`(只有雜湊)、`market_rate_take(規則)`(1h = 整點、day = 台北日;任何一條超過整批退回、不吃額度;`DAILY_CAP` 優先;只給內部用,API 角色沒有執行權,函式裡再擋一次)、`market_rate_key`(加鹽 sha256 前 16 hex)、`market_normalize_ip`(IPv6 取 /64)、`market_client_ip()`(`cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` 第一段;拿不到回 NULL)、`app_config.market_checkout_open = 'false'` 與隨機鹽、清理排程。

**Files:**
- Create: `supabase/migrations/20261009130200_market_checkout.sql`(本 Task 第 1 段,Task 37、38 接下去)
- Test: `supabase/tests/database/market_checkout.test.sql`(同上)

**Step 1:寫失敗的測試**

```sql
-- =====================================================================
-- migration 20261009130200_market_checkout 的資料庫層測試(限流、下單 RPC、token 查單)
--   … dry supabase/tests/database/market_checkout.test.sql \
--     --with-migration supabase/migrations/20261009120000_market_catalog.sql \
--     --with-migration supabase/migrations/20261009130000_market_orders.sql \
--     --with-migration supabase/migrations/20261009130100_market_notify.sql \
--     --with-migration supabase/migrations/20261009130200_market_checkout.sql
-- 通知網址換成 http://127.0.0.1:9/market-test;下單開關在交易裡切換;全部跟著 ROLLBACK 消失。
-- 金額跟前端測試同一組:A 店運費 120、滿 1000 免運、最低 300;B 店運費 60、沒有免運、沒有最低金額。
-- =====================================================================
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
  ('a9100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-a@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'store-b@market-test.invalid', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('a9100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@market-test.invalid', '', '{"provider":"email","providers":["email"],"role":"admin"}', '{}', now(), now());
INSERT INTO public.suppliers (id, name, contact_email) VALUES
  ('a9200000-0000-4000-8000-00000000000a', '市集測試 A 店', 'store-a@market-test.invalid'),
  ('a9200000-0000-4000-8000-00000000000b', '市集測試 B 店', 'store-b@market-test.invalid');
INSERT INTO public.supplier_accounts (user_id, supplier_id) VALUES
  ('a9100000-0000-4000-8000-000000000001', 'a9200000-0000-4000-8000-00000000000a'),
  ('a9100000-0000-4000-8000-000000000002', 'a9200000-0000-4000-8000-00000000000b');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info) VALUES
  ('a9200000-0000-4000-8000-00000000000b', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');
INSERT INTO public.market_stores (supplier_id, delivery_cities, shipping_fee, free_shipping_threshold, min_order_amount, payment_methods) VALUES
  ('a9200000-0000-4000-8000-00000000000a', ARRAY['臺北市', '新北市'], 120, 1000, 300, ARRAY['cod']),
  ('a9200000-0000-4000-8000-00000000000b', ARRAY['臺北市'], 60, NULL, 0, ARRAY['cod', 'transfer']);
SELECT pg_temp.exec_with_claims(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), $q$
  INSERT INTO public.market_products (id, supplier_id, name, category, spec, price, stock, temperature, review_status, is_listed) VALUES
    ('a9300000-0000-4000-8000-0000000000a1', 'a9200000-0000-4000-8000-00000000000a', '有機高麗菜', 'vegetable', '1 顆', 100, 10, 'chilled', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a2', 'a9200000-0000-4000-8000-00000000000a', '牛肉片', 'meat', '300g/盒', 450, NULL, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000a3', 'a9200000-0000-4000-8000-00000000000a', '待審商品', 'fruit', '1 盒', 100, NULL, 'ambient', 'pending', true),
    ('a9300000-0000-4000-8000-0000000000b1', 'a9200000-0000-4000-8000-00000000000b', '挪威鮭魚', 'seafood', '200g/片', 200, 3, 'frozen', 'approved', true),
    ('a9300000-0000-4000-8000-0000000000b2', 'a9200000-0000-4000-8000-00000000000b', '暫停販售的蝦', 'seafood', '1 盒', 300, NULL, 'frozen', 'approved', false)$q$);

-- ---------------------------------------------------------------------
-- 1. 限流
-- ---------------------------------------------------------------------
SELECT pg_temp.expect('限流相關函式不開給 API 角色',
  (has_function_privilege('anon', 'public.market_rate_take(jsonb)', 'EXECUTE')
   OR has_function_privilege('authenticated', 'public.market_rate_take(jsonb)', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_client_ip()', 'EXECUTE')
   OR has_function_privilege('anon', 'public.market_rate_key(text,text,text)', 'EXECUTE'))::text,
  'false');
SELECT pg_temp.expect('計數表 anon / 登入者都碰不到',
  (has_table_privilege('anon', 'public.market_rate_counters', 'SELECT,INSERT,UPDATE,DELETE')
   OR has_table_privilege('authenticated', 'public.market_rate_counters', 'SELECT,INSERT,UPDATE,DELETE'))::text,
  'false');
SELECT pg_temp.expect('上限 3:前 3 次通過',
  (SELECT string_agg(public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'ok', ',')
     FROM generate_series(1, 3)),
  'true,true,true');
SELECT pg_temp.expect('第 4 次被擋(RATE_LIMITED)',
  public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'code', 'RATE_LIMITED');
SELECT pg_temp.expect('被擋的那次不吃額度(計數停在 3)',
  (SELECT hits::text FROM public.market_rate_counters WHERE bucket = 'test:a|1h'), '3');
SELECT pg_temp.expect('任何一條超過就整批退回:另一條也不加',
  (public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3},{"bucket":"test:b","window":"1h","limit":100}]'::jsonb) ->> 'code')
  || '|' || (SELECT count(*)::text FROM public.market_rate_counters WHERE bucket = 'test:b|1h'),
  'RATE_LIMITED|0');
SELECT pg_temp.expect('每日上限回 DAILY_CAP,而且優先於 RATE_LIMITED',
  public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3},{"bucket":"test:c","window":"day","limit":0,"code":"DAILY_CAP"}]'::jsonb) ->> 'code',
  'DAILY_CAP');
SELECT pg_temp.expect('retry_after 是正的秒數',
  ((public.market_rate_take('[{"bucket":"test:a","window":"1h","limit":3}]'::jsonb) ->> 'retry_after')::integer > 0)::text, 'true');
SELECT pg_temp.expect('規則格式不對直接報錯(沒有 10m 窗格)',
  pg_temp.as_exec('postgres', '', $q$SELECT public.market_rate_take('[{"bucket":"x","window":"10m","limit":1}]'::jsonb)$q$),
  'ERR 22023');
SELECT pg_temp.expect('IP 正規化:IPv4 原樣、IPv6 取 /64、亂填回 NULL',
  public.market_normalize_ip('203.0.113.7') || '|' || public.market_normalize_ip('2001:db8:1:2:3:4:5:6') || '|'
  || COALESCE(public.market_normalize_ip('不是 IP'), '∅'),
  '203.0.113.7|2001:db8:1:2::|∅');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2","x-real-ip":"3.3.3.3","cf-connecting-ip":"4.4.4.4"}', true);
SELECT pg_temp.expect('呼叫者 IP:cf-connecting-ip 優先', public.market_client_ip(), '4.4.4.4');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2","x-real-ip":"3.3.3.3"}', true);
SELECT pg_temp.expect('……沒有就用 x-real-ip', public.market_client_ip(), '3.3.3.3');
SELECT set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 2.2.2.2"}', true);
SELECT pg_temp.expect('……再沒有才用 x-forwarded-for 第一段', public.market_client_ip(), '1.1.1.1');
SELECT set_config('request.headers', '', true);
SELECT pg_temp.expect('……都沒有回 NULL(不算 IP 額度)', COALESCE(public.market_client_ip(), '∅'), '∅');
SELECT pg_temp.expect('bucket 只存加鹽雜湊',
  (public.market_rate_key('email', 'a@b.c', 'salt') ~ '^email:[0-9a-f]{16}$')::text, 'true');
SELECT pg_temp.expect('清理排程每天 19:50 UTC',
  (SELECT schedule FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup'), '50 19 * * *');
SELECT pg_temp.expect('下單開關與限流的鹽都在 app_config(值不印出來)',
  (SELECT count(*)::text FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt')), '2');
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009130000_market_orders.sql --with-migration supabase/migrations/20261009130100_market_notify.sql`

Expected:`Management API 400:… 42883: function \"public.market_rate_take(jsonb)\" does not exist`

**Step 3:寫 migration(第 1 段)**

```sql
-- =====================================================================
-- 消費者食材市集:免註冊下單 RPC、token 查單 RPC、防灌單限流
--
-- market_place_order(p_checkout jsonb)(SECURITY DEFINER,anon / 登入者都能叫):
--   伺服器重新查一切,不相信瀏覽器送來的任何金額 —— 商品是否已核准上架、店家零售是否啟用、價格、庫存、
--   配送範圍、最低訂購金額、付款方式(轉帳要店家已填轉帳資訊);算運費(固定運費,小計 ≥ 免運門檻就 0)、扣庫存、
--   每家店建一張單 + 明細快照 + 第一筆紀錄(pending),同一次結帳共用一組查詢 token(DB 只存 sha256 hex)。
--   可選的 expected_totals:跟伺服器算的不一樣就回 PRICE_CHANGED(價格在你看購物車之後變了),不建單。
--   商業上的錯誤一律回 200 + {ok:false, code},不 raise —— 這樣「被擋的嘗試」也會留下限流計數。
-- market_get_orders(p_token text):用 token 換這次結帳的訂單(電話、Email 遮罩);待匯款時附上轉帳資訊。
--
-- 防灌單(market_rate_take,不沿用 ai_rate_take —— 理由見計畫「關鍵技術決定」第 1 點):
--   同一個 IP:每小時 5 次、每天 20 次(拿不到 IP 就不算這兩條)
--   同一個 Email(去 +tag、gmail 去點,沿用 supplier_mail_email_key):每小時 3 次、每天 10 次
--   同一支電話:每天 10 次;全站:每天 500 次(DAILY_CAP)
--   IP / Email / 電話只以「加鹽 sha256 前 16 hex」落地(鹽 = app_config.market_rate_salt,migration 產生,不印出來)
--   被擋的請求不吃額度;平台管理員(業主實測)不限流。
--
-- 下單開關 app_config.market_checkout_open(預設 'false'):對外開放前只有平台管理員能下單,其他人拿到 MARKET_CLOSED。
--   🔴 改成 'true' = 對外開放,待業主核准。
--
-- 前端:src/lib/market/checkout.ts(結帳)、src/lib/market/lookup.ts(查單)。
-- 還原:supabase/rollbacks/20261009130200_market_checkout.down.sql
-- 測試:supabase/tests/database/market_checkout.test.sql
-- =====================================================================
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------
-- 1. 限流計數(固定窗格;演算法照抄 20261007100000 的 ai_rate_take)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_rate_counters (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, window_start),
  CONSTRAINT market_rate_counters_bucket_len CHECK (char_length(bucket) BETWEEN 1 AND 120)
);
CREATE INDEX IF NOT EXISTS market_rate_counters_window_idx ON public.market_rate_counters (window_start);

COMMENT ON TABLE public.market_rate_counters IS
  '零售下單限流計數(固定窗格,1h = 整點、day = 台北日)。只由 market_rate_take 寫入;每天清掉 2 天前的列。IP / Email / 電話只以加鹽雜湊出現。';

ALTER TABLE public.market_rate_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_rate_counters FROM PUBLIC, anon, authenticated;

INSERT INTO public.app_config (key, value) VALUES ('market_checkout_open', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO public.app_config (key, value) VALUES ('market_rate_salt', encode(extensions.gen_random_bytes(16), 'hex')) ON CONFLICT (key) DO NOTHING;

-- p_rules = [{bucket, window: "1h"|"day", limit, code?: "RATE_LIMITED"|"DAILY_CAP"}](1–8 條)
-- 回 {ok:true} 或 {ok:false, code, retry_after(秒)};任何一條超過就整批退回(被擋的請求不吃額度)。
-- 只給內部用(market_place_order 以擁有者身分呼叫);API 角色沒有執行權,函式裡再擋一次。
CREATE OR REPLACE FUNCTION public.market_rate_take(p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now    timestamptz := now();
  v_rule   jsonb;
  v_bucket text;
  v_window text;
  v_code   text;
  v_limit  integer;
  v_start  timestamptz;
  v_end    timestamptz;
  v_hits   integer;
  v_failed jsonb := '[]'::jsonb;
  v_pick   text;
  v_retry  integer;
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'market_rate_take: internal only' USING ERRCODE = '42501';
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' OR jsonb_array_length(p_rules) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'market_rate_take: p_rules must be an array of 1..8 rules' USING ERRCODE = '22023';
  END IF;

  BEGIN  -- 子交易:任何一條超額就整批退回
    FOR v_rule IN
      SELECT r.value FROM jsonb_array_elements(p_rules) AS r(value)
       ORDER BY r.value->>'bucket', r.value->>'window'   -- 固定上鎖順序,兩個請求不會互等
    LOOP
      v_bucket := v_rule->>'bucket';
      v_window := v_rule->>'window';
      v_code   := COALESCE(v_rule->>'code', 'RATE_LIMITED');
      v_limit  := CASE WHEN jsonb_typeof(v_rule->'limit') = 'number' THEN (v_rule->>'limit')::integer END;
      IF v_bucket IS NULL OR char_length(v_bucket) NOT BETWEEN 1 AND 100
         OR v_window IS NULL OR v_window NOT IN ('1h', 'day')
         OR v_limit IS NULL OR v_limit < 0
         OR v_code NOT IN ('RATE_LIMITED', 'DAILY_CAP') THEN
        RAISE EXCEPTION 'market_rate_take: invalid rule %', v_rule USING ERRCODE = '22023';
      END IF;

      IF v_window = '1h' THEN
        v_start := date_trunc('hour', v_now);
        v_end   := v_start + interval '1 hour';
      ELSE
        v_start := (date_trunc('day', v_now AT TIME ZONE 'Asia/Taipei')) AT TIME ZONE 'Asia/Taipei';
        v_end   := v_start + interval '1 day';
      END IF;

      INSERT INTO public.market_rate_counters AS c (bucket, window_start, hits, updated_at)
      VALUES (v_bucket || '|' || v_window, v_start, 1, v_now)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET hits = c.hits + 1, updated_at = EXCLUDED.updated_at
      RETURNING c.hits INTO v_hits;

      IF v_hits > v_limit THEN
        v_failed := v_failed || jsonb_build_array(jsonb_build_object(
          'code', v_code, 'retry_after', GREATEST(1, ceil(extract(epoch FROM (v_end - v_now)))::integer)));
      END IF;
    END LOOP;

    IF jsonb_array_length(v_failed) > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'IFM02', MESSAGE = 'market_rate_take: over limit';
    END IF;
  EXCEPTION WHEN SQLSTATE 'IFM02' THEN
    NULL;  -- 子交易已 rollback:這次的加一全部退回(區域變數 v_failed 保留)
  END;

  IF jsonb_array_length(v_failed) = 0 THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  v_pick := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = 'DAILY_CAP')
                 THEN 'DAILY_CAP' ELSE 'RATE_LIMITED' END;
  SELECT max((f->>'retry_after')::integer) INTO v_retry FROM jsonb_array_elements(v_failed) f WHERE f->>'code' = v_pick;
  RETURN jsonb_build_object('ok', false, 'code', v_pick, 'retry_after', v_retry);
END;
$$;

-- 限流 bucket:<種類>:<加鹽 sha256 前 16 hex>
CREATE OR REPLACE FUNCTION public.market_rate_key(p_kind text, p_value text, p_salt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_kind || ':' || left(encode(sha256(convert_to(COALESCE(p_value, '') || '|' || COALESCE(p_salt, ''), 'UTF8')), 'hex'), 16)
$$;

-- IP 正規化:IPv6 取 /64(跟 AI 限流一樣)、IPv4 用完整位址;解析不了回 NULL
CREATE OR REPLACE FUNCTION public.market_normalize_ip(p_ip text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' THEN
    RETURN NULL;
  END IF;
  IF position(':' IN p_ip) > 0 THEN
    RETURN host(network(set_masklen(btrim(p_ip)::inet, 64)));
  END IF;
  RETURN host(btrim(p_ip)::inet);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 呼叫者 IP:PostgREST 把請求標頭放在 request.headers。
-- 優先 cf-connecting-ip(Cloudflare 會覆寫、偽造不了),其次 x-real-ip,最後 x-forwarded-for 第一段(可能被偽造)。
-- 🔴 部署後一定要跑計畫第 2 階段「部署與驗收」的 IP 標頭檢查,確認實際用到的是偽造不了的那一個。
CREATE OR REPLACE FUNCTION public.market_client_ip()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  RETURN public.market_normalize_ip(COALESCE(
    NULLIF(btrim(v_headers->>'cf-connecting-ip'), ''),
    NULLIF(btrim(v_headers->>'x-real-ip'), ''),
    NULLIF(btrim(split_part(v_headers->>'x-forwarded-for', ',', 1)), '')
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.market_rate_take(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_rate_key(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_normalize_ip(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_client_ip() FROM PUBLIC, anon, authenticated;

-- 每天 19:50 UTC(台北 03:50,錯開 19:00 的訂單逾時與 19:40 的 AI 清理)清掉 2 天前的計數。同名排程已存在時會更新
SELECT cron.schedule(
  'ifoodmap-market-rate-cleanup',
  '50 19 * * *',
  $cron$DELETE FROM public.market_rate_counters WHERE window_start < now() - interval '2 days'$cron$
);
```

**Step 4:跑測試,確認通過**

Run:同 Step 2,最後加 `--with-migration supabase/migrations/20261009130200_market_checkout.sql`。Expected:`…共 17 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130200_market_checkout.sql supabase/tests/database/market_checkout.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售下單限流 market_rate_take 與下單開關(migration 130200 第 1 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 37:migration 130200(第 2 段):免註冊下單 `market_place_order`、開關狀態 `market_checkout_status`

順序:形狀 → 收件資料(錯就 `INVALID_INPUT` + 欄位)→ 限流(非管理員)→ 開關(`MARKET_CLOSED`,非管理員)→ 購物車(1–50 行、數量 1–99、同商品合併)→ 照 id 排序 `FOR UPDATE` 鎖商品 → 上架檢查 → 庫存 → 每家店算小計與運費 → ≤ 10 家店 → 配送範圍 → 最低金額 → 付款方式(轉帳要店家有轉帳資訊)→ 跟 `expected_totals` 比對 → 產生 token、每家店建單 + 明細快照 + 第一筆紀錄 → 扣庫存 → 排確認信 → 回 `{ok, token, checkout_id, orders}`。商業錯誤一律回 `{ok:false, code}`(不 raise),被擋的嘗試也會留下限流計數。

**Files:**
- Modify: `supabase/migrations/20261009130200_market_checkout.sql`(接在檔尾)
- Test: `supabase/tests/database/market_checkout.test.sql`(接在檔尾)

**Step 1:寫失敗的測試(接在測試檔最後面)**

```sql

-- ---------------------------------------------------------------------
-- 2. 下單 RPC
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

-- 以 anon(或帶 JWT 的登入者)身分呼叫下單 RPC;p_ip = 這次請求的 cf-connecting-ip(NULL = 沒有 IP 標頭)
CREATE FUNCTION pg_temp.place(p_claims text, p_ip text, p_checkout jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb;
  v_state text;
BEGIN
  PERFORM set_config('request.headers', CASE WHEN p_ip IS NULL THEN '' ELSE json_build_object('cf-connecting-ip', p_ip)::text END, true);
  PERFORM set_config('request.jwt.claims', p_claims, true);
  PERFORM set_config('role', CASE WHEN p_claims LIKE '%"authenticated"%' THEN 'authenticated' ELSE 'anon' END, true);
  BEGIN
    r := public.market_place_order(p_checkout);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    r := jsonb_build_object('ok', false, 'code', 'ERR ' || v_state, 'message', SQLERRM);
  END;
  PERFORM set_config('role', 'none', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.headers', '', true);
  RETURN r;
END
$f$;

-- 結帳內容。電話預設由 Email 算出一支不重複的(同一支電話每天只能下 10 單,測試會超過);
-- 要測正規化時自己帶(例如 '0912-345-678')。Email 可以帶大寫:伺服器會轉小寫
CREATE FUNCTION pg_temp.co(p_email text, p_items jsonb, p_payments jsonb, p_city text DEFAULT '臺北市',
                           p_expected jsonb DEFAULT NULL, p_phone text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'buyer', jsonb_build_object('name', '測試買家',
                                'phone', COALESCE(p_phone, '09' || lpad((abs(hashtext(p_email)) % 100000000)::text, 8, '0')),
                                'email', p_email, 'city', p_city, 'address', '測試路 1 號 2 樓', 'note', '請放管理室'),
    'items', p_items, 'payments', p_payments, 'expected_totals', p_expected, 'terms_version', '2026-10-draft'))
$f$;

CREATE FUNCTION pg_temp.item(p_product text, p_qty integer) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('product_id', 'a9300000-0000-4000-8000-0000000000' || p_product, 'qty', p_qty)
$f$;

CREATE FUNCTION pg_temp.queued(p_kind text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM net.http_request_queue q
   WHERE q.url = 'http://127.0.0.1:9/market-test' AND convert_from(q.body, 'UTF8')::jsonb ->> 'kind' = p_kind
$f$;

UPDATE public.app_config SET value = 'http://127.0.0.1:9/market-test' WHERE key = 'market_notify_function_url';
UPDATE public.app_config SET value = 'false' WHERE key = 'market_checkout_open';

SELECT pg_temp.expect('開關關閉:anon 拿到 MARKET_CLOSED',
  pg_temp.place(pg_temp.anon(), '198.51.100.1',
    pg_temp.co('closed@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code',
  'MARKET_CLOSED');
SELECT pg_temp.expect('開關關閉:平台管理員可以下單(業主實測用)',
  pg_temp.place(pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), '198.51.100.1',
    pg_temp.co('owner-test@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok',
  'true');

SELECT pg_temp.expect('開關狀態:關閉時 anon 不能下單、管理員可以',
  pg_temp.as_val('anon', pg_temp.anon(), 'SELECT public.market_checkout_status()::text') || '|' ||
  pg_temp.as_val('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000003', true), 'SELECT public.market_checkout_status()::text'),
  '{"open": false, "can_order": false}|{"open": false, "can_order": true}');

UPDATE public.app_config SET value = 'true' WHERE key = 'market_checkout_open';

SELECT pg_temp.expect('開關狀態:打開後 anon 也能下單',
  pg_temp.as_val('anon', pg_temp.anon(), 'SELECT public.market_checkout_status()::text'),
  '{"open": true, "can_order": true}');

INSERT INTO _ctx VALUES ('happy', pg_temp.place(pg_temp.anon(), '198.51.100.2', pg_temp.co('Happy@Market-Test.invalid',
  jsonb_build_array(pg_temp.item('a1', 2) || '{"price": 1}', pg_temp.item('a2', 1), pg_temp.item('b1', 1)),
  '{"a9200000-0000-4000-8000-00000000000a":"cod","a9200000-0000-4000-8000-00000000000b":"transfer"}',
  '臺北市', NULL, '0912-345-678')));
SELECT pg_temp.expect('anon 一次結帳兩家店成功', (SELECT v ->> 'ok' FROM _ctx WHERE k = 'happy'), 'true');
SELECT pg_temp.expect('金額是伺服器算的(送來的 price 不算):A 200+450+運費 120 = 770;B 200+運費 60 = 260',
  (SELECT string_agg(o ->> 'total', ',' ORDER BY o ->> 'supplier_id') FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy'),
  '770,260');
SELECT pg_temp.expect('token 43 字;兩張單共用、DB 只存它的 sha256',
  (SELECT (char_length(v ->> 'token') = 43)::text || '|' ||
          (SELECT count(*) FROM public.market_orders o
            WHERE o.lookup_token_hash = encode(sha256(convert_to(v ->> 'token', 'UTF8')), 'hex'))::text
     FROM _ctx WHERE k = 'happy'),
  'true|2');
SELECT pg_temp.expect('明細是下單當下的快照',
  (SELECT string_agg(i.product_name || '×' || i.qty || '=' || i.line_total, ',' ORDER BY i.unit_price)
     FROM public.market_order_items i
    WHERE i.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '有機高麗菜×2=200,挪威鮭魚×1=200,牛肉片×1=450');
SELECT pg_temp.expect('庫存扣掉(高麗菜 10→8、鮭魚 3→2;不限庫存的牛肉片不動)',
  (SELECT string_agg(COALESCE(stock::text, '∅'), '|' ORDER BY id) FROM public.market_products
    WHERE id IN ('a9300000-0000-4000-8000-0000000000a1', 'a9300000-0000-4000-8000-0000000000a2', 'a9300000-0000-4000-8000-0000000000b1')),
  '8|∅|2');
SELECT pg_temp.expect('每張單第一筆紀錄是 pending、身分是消費者',
  (SELECT count(*)::text FROM public.market_order_events e
    WHERE e.to_status = 'pending' AND e.actor_role = 'consumer'
      AND e.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '2');
SELECT pg_temp.expect('收件資料正規化:電話去掉 -、Email 轉小寫',
  (SELECT string_agg(DISTINCT o.buyer_phone || '|' || o.buyer_email, ',') FROM public.market_orders o
    WHERE o.id IN (SELECT (x ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') x WHERE k = 'happy')),
  '0912345678|happy@market-test.invalid');
SELECT pg_temp.expect('排了 1 封下單確認(帶 token)+ 2 封新訂單通知',
  (SELECT count(*)::text FROM net.http_request_queue q, _ctx c
    WHERE c.k = 'happy' AND q.url = 'http://127.0.0.1:9/market-test'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'kind' = 'placed'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'checkout_id' = c.v ->> 'checkout_id'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'token' = c.v ->> 'token')
  || '|' ||
  (SELECT count(*)::text FROM net.http_request_queue q
     JOIN public.market_order_events e ON e.id::text = convert_from(q.body, 'UTF8')::jsonb ->> 'event_id'
    WHERE q.url = 'http://127.0.0.1:9/market-test'
      AND e.order_id IN (SELECT (o ->> 'id')::uuid FROM _ctx, jsonb_array_elements(v -> 'orders') o WHERE k = 'happy')),
  '1|2');

INSERT INTO _ctx VALUES ('price', pg_temp.place(pg_temp.anon(), '198.51.100.3', pg_temp.co('price@market-test.invalid',
  jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}', '臺北市',
  '{"a9200000-0000-4000-8000-00000000000a": 1}')));
SELECT pg_temp.expect('畫面上的總額對不上 → PRICE_CHANGED,回伺服器算的 570,不建單',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'total') FROM _ctx WHERE k = 'price') || '|' ||
  (SELECT count(*)::text FROM public.market_orders WHERE buyer_email = 'price@market-test.invalid'),
  'PRICE_CHANGED|570|0');
SELECT pg_temp.expect('總額對得上就成功',
  pg_temp.place(pg_temp.anon(), '198.51.100.3', pg_temp.co('price@market-test.invalid',
    jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}', '臺北市',
    '{"a9200000-0000-4000-8000-00000000000a": 570}')) ->> 'ok',
  'true');

INSERT INTO _ctx VALUES ('stock', pg_temp.place(pg_temp.anon(), '198.51.100.4', pg_temp.co('stock@market-test.invalid',
  jsonb_build_array(pg_temp.item('b1', 5)), '{"a9200000-0000-4000-8000-00000000000b":"cod"}')));
SELECT pg_temp.expect('庫存不足 → OUT_OF_STOCK(剩 2),庫存不變',
  (SELECT (v ->> 'code') || '|' || (v -> 'products' -> 0 ->> 'available') FROM _ctx WHERE k = 'stock') || '|' ||
  (SELECT stock::text FROM public.market_products WHERE id = 'a9300000-0000-4000-8000-0000000000b1'),
  'OUT_OF_STOCK|2|2');
SELECT pg_temp.expect('待審、暫停販售、不存在的商品都 PRODUCT_UNAVAILABLE',
  (pg_temp.place(pg_temp.anon(), '198.51.100.5', pg_temp.co('u1@market-test.invalid', jsonb_build_array(pg_temp.item('a3', 1)),
     '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.6', pg_temp.co('u2@market-test.invalid', jsonb_build_array(pg_temp.item('b2', 1)),
     '{"a9200000-0000-4000-8000-00000000000b":"cod"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.7', pg_temp.co('u3@market-test.invalid',
     '[{"product_id":"a9300000-0000-4000-8000-0000000000ff","qty":1}]', '{}')) ->> 'code'),
  'PRODUCT_UNAVAILABLE|PRODUCT_UNAVAILABLE|PRODUCT_UNAVAILABLE');
INSERT INTO _ctx VALUES ('city', pg_temp.place(pg_temp.anon(), '198.51.100.8', pg_temp.co('city@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 3), pg_temp.item('b1', 1)),
  '{"a9200000-0000-4000-8000-00000000000a":"cod","a9200000-0000-4000-8000-00000000000b":"cod"}', '新北市')));
SELECT pg_temp.expect('收件縣市不在配送範圍 → NOT_DELIVERABLE,只列不送新北市的 B 店',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores')::text FROM _ctx WHERE k = 'city'),
  'NOT_DELIVERABLE|["a9200000-0000-4000-8000-00000000000b"]');
INSERT INTO _ctx VALUES ('min', pg_temp.place(pg_temp.anon(), '198.51.100.9', pg_temp.co('min@market-test.invalid',
  jsonb_build_array(pg_temp.item('a1', 2)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')));
SELECT pg_temp.expect('A 店最低 300、小計 200 → BELOW_MINIMUM',
  (SELECT (v ->> 'code') || '|' || (v -> 'stores' -> 0 ->> 'subtotal') || '|' || (v -> 'stores' -> 0 ->> 'min_order_amount') FROM _ctx WHERE k = 'min'),
  'BELOW_MINIMUM|200|300');
SELECT pg_temp.expect('剛好 300 就可以(運費 120 → 420)',
  (SELECT (r ->> 'ok') || '|' || (r -> 'orders' -> 0 ->> 'total')
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.100.10', pg_temp.co('min300@market-test.invalid',
             jsonb_build_array(pg_temp.item('a1', 3)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true|420');
SELECT pg_temp.expect('滿 1000 免運:牛肉片 ×2 + 高麗菜 ×1 = 1000 → 總額 1000',
  (SELECT (r ->> 'ok') || '|' || (r -> 'orders' -> 0 ->> 'total')
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.100.11', pg_temp.co('free@market-test.invalid',
             jsonb_build_array(pg_temp.item('a2', 2), pg_temp.item('a1', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true|1000');
SELECT pg_temp.expect('付款方式不在店家接受的裡面、或沒選 → PAYMENT_NOT_ACCEPTED',
  (pg_temp.place(pg_temp.anon(), '198.51.100.12', pg_temp.co('pay1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)),
     '{"a9200000-0000-4000-8000-00000000000a":"transfer"}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.100.13', pg_temp.co('pay2@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}')) ->> 'code'),
  'PAYMENT_NOT_ACCEPTED|PAYMENT_NOT_ACCEPTED');
DELETE FROM public.market_store_transfer WHERE supplier_id = 'a9200000-0000-4000-8000-00000000000b';
SELECT pg_temp.expect('轉帳資訊被刪掉的店不能選轉帳',
  pg_temp.place(pg_temp.anon(), '198.51.100.14', pg_temp.co('pay3@market-test.invalid', jsonb_build_array(pg_temp.item('b1', 1)),
    '{"a9200000-0000-4000-8000-00000000000b":"transfer"}')) ->> 'code',
  'PAYMENT_NOT_ACCEPTED');
INSERT INTO public.market_store_transfer (supplier_id, transfer_info)
VALUES ('a9200000-0000-4000-8000-00000000000b', '郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');

CREATE FUNCTION pg_temp.bad(p_n integer, p_checkout jsonb) RETURNS text LANGUAGE sql AS $f$
  SELECT COALESCE(pg_temp.place(pg_temp.anon(), '198.51.101.' || p_n, p_checkout) ->> 'field', '(沒有 field)')
$f$;
SELECT pg_temp.expect('欄位驗證:每個欄位都有上限與格式',
  concat_ws(',',
    pg_temp.bad(1, jsonb_set(pg_temp.co('f1@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,phone}', '"12345"')),
    pg_temp.bad(2, pg_temp.co('a@b', jsonb_build_array(pg_temp.item('a2', 1)), '{}')),
    pg_temp.bad(3, jsonb_set(pg_temp.co('f3@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,name}', '"  "')),
    pg_temp.bad(4, jsonb_set(pg_temp.co('f4@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,name}', to_jsonb(repeat('名', 51)))),
    pg_temp.bad(5, pg_temp.co('f5@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}', '台北市')),
    pg_temp.bad(6, jsonb_set(pg_temp.co('f6@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,address}', '"短"')),
    pg_temp.bad(7, jsonb_set(pg_temp.co('f7@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{buyer,note}', to_jsonb(repeat('字', 301)))),
    pg_temp.bad(8, jsonb_set(pg_temp.co('f8@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 1)), '{}'), '{terms_version}', '""')),
    pg_temp.bad(9, pg_temp.co('f9@market-test.invalid', jsonb_build_array(pg_temp.item('a2', 0)), '{}')),
    pg_temp.bad(10, pg_temp.co('f10@market-test.invalid', '[{"product_id":"a9300000-0000-4000-8000-0000000000a2","qty":"2"}]', '{}')),
    pg_temp.bad(11, pg_temp.co('f11@market-test.invalid', '[{"product_id":"a9300000-0000-4000-8000-0000000000a2","qty":1.5}]', '{}')),
    pg_temp.bad(12, pg_temp.co('f12@market-test.invalid', '[{"product_id":"x","qty":1}]', '{}'))),
  'buyer.phone,buyer.email,buyer.name,buyer.name,buyer.city,buyer.address,buyer.note,terms_version,items,items,items,items');
SELECT pg_temp.expect('空購物車 → EMPTY_CART;超過 50 行 → TOO_MANY_ITEMS',
  (pg_temp.place(pg_temp.anon(), '198.51.102.1', pg_temp.co('e1@market-test.invalid', '[]', '{}')) ->> 'code') || '|' ||
  (pg_temp.place(pg_temp.anon(), '198.51.102.2', pg_temp.co('e2@market-test.invalid',
     (SELECT jsonb_agg(pg_temp.item('a2', 1)) FROM generate_series(1, 51)), '{}')) ->> 'code'),
  'EMPTY_CART|TOO_MANY_ITEMS');
SELECT pg_temp.expect('同一個 Email 一小時前 3 次可以,第 4 次 RATE_LIMITED(有 retry_after)',
  (SELECT string_agg(pg_temp.place(pg_temp.anon(), '198.51.103.' || n, pg_temp.co('rate@market-test.invalid',
            jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok', ',' ORDER BY n)
     FROM generate_series(1, 3) AS n) || '|' ||
  (SELECT (r ->> 'code') || '|' || ((r ->> 'retry_after')::integer > 0)::text
     FROM (SELECT pg_temp.place(pg_temp.anon(), '198.51.103.9', pg_temp.co('rate@market-test.invalid',
             jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) AS r) x),
  'true,true,true|RATE_LIMITED|true');
SELECT pg_temp.expect('……被擋的那次不吃額度(Email 計數停在 3)',
  (SELECT hits::text FROM public.market_rate_counters
    WHERE bucket = public.market_rate_key('email', 'rate@market-test.invalid',
                                          (SELECT value FROM public.app_config WHERE key = 'market_rate_salt')) || '|1h'),
  '3');
SELECT pg_temp.expect('同一個 IP 一小時第 6 次 RATE_LIMITED',
  (SELECT string_agg(pg_temp.place(pg_temp.anon(), '198.51.104.1', pg_temp.co('ip' || n || '@market-test.invalid',
            jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'code', ',' ORDER BY n)
     FROM generate_series(1, 6) AS n),
  'RATE_LIMITED');
SELECT pg_temp.expect('拿不到 IP 的請求不算 IP 額度(不會所有人共用一格)',
  pg_temp.place(pg_temp.anon(), NULL, pg_temp.co('noip@market-test.invalid',
    jsonb_build_array(pg_temp.item('a2', 1)), '{"a9200000-0000-4000-8000-00000000000a":"cod"}')) ->> 'ok',
  'true');
SELECT pg_temp.expect('計數表裡沒有明文 Email / 電話 / IP',
  (SELECT count(*)::text FROM public.market_rate_counters WHERE bucket ~ '@|09[0-9]{8}|198\.51'), '0');
SELECT pg_temp.expect('anon 讀不到訂單、明細、紀錄、計數',
  concat_ws('|',
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_orders$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_order_items$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_order_events$q$),
    pg_temp.as_val('anon', pg_temp.anon(), $q$SELECT count(*)::text FROM public.market_rate_counters$q$)),
  'ERR 42501|ERR 42501|ERR 42501|ERR 42501');
SELECT pg_temp.expect('下單 RPC 有鎖商品列(FOR UPDATE),兩張單搶最後一件不會超賣',
  (position('FOR UPDATE' IN pg_get_functiondef('public.market_place_order(jsonb)'::regprocedure)) > 0)::text, 'true');
```

**Step 2:跑測試,確認失敗**

Run:同 Task 36 Step 4。Expected:`Management API 400:… 42883: function \"public.market_place_order(jsonb)\" does not exist`

**Step 3:寫 migration(第 2 段,接在檔尾)**

```sql

-- ---------------------------------------------------------------------
-- 2. 下單
--   p_checkout = {
--     buyer: {name, phone, email, city, address, note?},
--     items: [{product_id, qty}](1–50 行,qty 1–99;同一商品合併,上限 99),
--     payments: {<supplier_id>: 'cod' | 'transfer'},
--     expected_totals?: {<supplier_id>: 畫面上的總額},
--     terms_version: 同意的服務條款版本
--   }
--   成功 → {ok:true, token, checkout_id, orders:[{id, supplier_id, total}]}
--   失敗 → {ok:false, code, …}:MARKET_CLOSED / INVALID_INPUT(field)/ RATE_LIMITED、DAILY_CAP(retry_after)/
--          EMPTY_CART / TOO_MANY_ITEMS / PRODUCT_UNAVAILABLE(products)/ OUT_OF_STOCK(products)/ TOO_MANY_STORES /
--          NOT_DELIVERABLE(stores)/ BELOW_MINIMUM(stores)/ PAYMENT_NOT_ACCEPTED(stores)/ PRICE_CHANGED(stores)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_place_order(p_checkout jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_admin     boolean := public.is_admin();
  v_buyer     jsonb;
  v_items     jsonb;
  v_payments  jsonb;
  v_expected  jsonb;
  v_name      text;
  v_phone     text;
  v_email     text;
  v_city      text;
  v_address   text;
  v_note      text;
  v_terms     text;
  v_salt      text;
  v_ip        text;
  v_email_key text;
  v_rules     jsonb;
  v_rate      jsonb;
  v_req       jsonb;
  v_stores    jsonb;
  v_bad       jsonb;
  v_store     jsonb;
  v_order     uuid;
  v_orders    jsonb := '[]'::jsonb;
  v_checkout  uuid := gen_random_uuid();
  v_token     text;
  v_hash      text;
BEGIN
  -- 1. 形狀
  IF p_checkout IS NULL OR jsonb_typeof(p_checkout) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'checkout');
  END IF;
  v_buyer    := p_checkout->'buyer';
  v_items    := p_checkout->'items';
  v_payments := COALESCE(p_checkout->'payments', '{}'::jsonb);
  v_expected := p_checkout->'expected_totals';
  IF jsonb_typeof(v_buyer) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer');
  END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'items');
  END IF;
  IF jsonb_typeof(v_payments) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'payments');
  END IF;
  IF v_expected IS NOT NULL AND jsonb_typeof(v_expected) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'expected_totals');
  END IF;

  -- 2. 收件資料(長度與格式跟 src/lib/market/checkout.ts 一樣)
  v_name    := btrim(COALESCE(v_buyer->>'name', ''));
  v_phone   := regexp_replace(COALESCE(v_buyer->>'phone', ''), '[[:space:]()-]', '', 'g');
  v_email   := lower(btrim(COALESCE(v_buyer->>'email', '')));
  v_city    := btrim(COALESCE(v_buyer->>'city', ''));
  v_address := btrim(COALESCE(v_buyer->>'address', ''));
  v_note    := NULLIF(btrim(COALESCE(v_buyer->>'note', '')), '');
  v_terms   := btrim(COALESCE(p_checkout->>'terms_version', ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.name');
  END IF;
  IF NOT public.market_phone_ok(v_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.phone');
  END IF;
  IF NOT public.market_email_ok(v_email) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.email');
  END IF;
  IF NOT (v_city = ANY (public.market_tw_cities())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.city');
  END IF;
  IF char_length(v_address) NOT BETWEEN 5 AND 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.address');
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'buyer.note');
  END IF;
  IF char_length(v_terms) NOT BETWEEN 1 AND 20 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'terms_version');
  END IF;

  -- 3. 防灌單(平台管理員實測不限流)。放在開關之前:開放前的嘗試一樣會被計數
  IF NOT v_admin THEN
    v_salt := COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_rate_salt'), 'ifoodmap-market-rate-fallback');
    v_ip := public.market_client_ip();
    v_email_key := public.supplier_mail_email_key(v_email);
    v_rules := jsonb_build_array(
      jsonb_build_object('bucket', public.market_rate_key('email', v_email_key, v_salt), 'window', '1h', 'limit', 3),
      jsonb_build_object('bucket', public.market_rate_key('email', v_email_key, v_salt), 'window', 'day', 'limit', 10),
      jsonb_build_object('bucket', public.market_rate_key('phone', v_phone, v_salt), 'window', 'day', 'limit', 10),
      jsonb_build_object('bucket', 'global', 'window', 'day', 'limit', 500, 'code', 'DAILY_CAP')
    );
    IF v_ip IS NOT NULL THEN
      v_rules := v_rules || jsonb_build_array(
        jsonb_build_object('bucket', public.market_rate_key('ip', v_ip, v_salt), 'window', '1h', 'limit', 5),
        jsonb_build_object('bucket', public.market_rate_key('ip', v_ip, v_salt), 'window', 'day', 'limit', 20)
      );
    END IF;
    v_rate := public.market_rate_take(v_rules);
    IF NOT COALESCE((v_rate->>'ok')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'code', v_rate->>'code', 'retry_after', (v_rate->>'retry_after')::integer);
    END IF;
  END IF;

  -- 4. 開關:對外開放前只有平台管理員能下單(app_config.market_checkout_open,待業主核准才改成 'true')
  IF NOT v_admin AND COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'), '') <> 'true' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MARKET_CLOSED');
  END IF;

  -- 5. 購物車
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_CART');
  END IF;
  IF jsonb_array_length(v_items) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_MANY_ITEMS');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_items) AS e(value)
     WHERE jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value->>'product_id', '') !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        OR CASE WHEN jsonb_typeof(e.value->'qty') = 'number' AND (e.value->>'qty') ~ '^[0-9]{1,2}$'
                THEN (e.value->>'qty')::integer NOT BETWEEN 1 AND 99
                ELSE true END
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'items');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', r.product_id, 'qty', r.qty) ORDER BY r.product_id)
    INTO v_req
    FROM (SELECT (e.value->>'product_id')::uuid AS product_id, LEAST(sum((e.value->>'qty')::integer), 99)::integer AS qty
            FROM jsonb_array_elements(v_items) AS e(value)
           GROUP BY 1) r;

  -- 鎖住這些商品(固定照 id 排序,兩張單同時搶同一批商品不會互等),之後讀到的庫存不會被同時扣走
  PERFORM 1 FROM public.market_products p
   WHERE p.id IN (SELECT q.product_id FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer))
   ORDER BY p.id
     FOR UPDATE;

  SELECT jsonb_agg(q.product_id ORDER BY q.product_id) INTO v_bad
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
    LEFT JOIN public.market_products p ON p.id = q.product_id
   WHERE p.id IS NULL OR p.review_status <> 'approved' OR NOT p.is_listed OR NOT public.market_store_is_open(p.supplier_id);
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PRODUCT_UNAVAILABLE', 'products', v_bad);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', p.id, 'available', p.stock) ORDER BY p.id) INTO v_bad
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
    JOIN public.market_products p ON p.id = q.product_id
   WHERE p.stock IS NOT NULL AND p.stock < q.qty;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'OUT_OF_STOCK', 'products', v_bad);
  END IF;

  -- 6. 每家店:小計、運費(固定運費;小計 ≥ 免運門檻就 0)、配送範圍、最低金額、付款方式 —— 一律伺服器算
  SELECT jsonb_agg(jsonb_build_object(
           'supplier_id', s.supplier_id,
           'subtotal', g.subtotal,
           'shipping_fee', CASE WHEN s.free_shipping_threshold IS NOT NULL AND g.subtotal >= s.free_shipping_threshold
                                THEN 0 ELSE s.shipping_fee END,
           'min_order_amount', s.min_order_amount,
           'deliverable', v_city = ANY (s.delivery_cities),
           'payment', v_payments->>(s.supplier_id::text),
           'payment_ok', COALESCE(v_payments->>(s.supplier_id::text) = ANY (s.payment_methods), false)
                         AND (COALESCE(v_payments->>(s.supplier_id::text), '') <> 'transfer'
                              OR EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = s.supplier_id))
         ) ORDER BY s.supplier_id)
    INTO v_stores
    FROM (SELECT p.supplier_id, sum(p.price * q.qty)::integer AS subtotal
            FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
            JOIN public.market_products p ON p.id = q.product_id
           GROUP BY p.supplier_id) g
    JOIN public.market_stores s ON s.supplier_id = g.supplier_id;

  IF jsonb_array_length(v_stores) > 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_MANY_STORES');
  END IF;

  SELECT jsonb_agg(x.value->'supplier_id') INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value) WHERE NOT (x.value->>'deliverable')::boolean;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_DELIVERABLE', 'stores', v_bad);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('supplier_id', x.value->'supplier_id',
                                      'min_order_amount', x.value->'min_order_amount', 'subtotal', x.value->'subtotal'))
    INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value)
   WHERE (x.value->>'subtotal')::integer < (x.value->>'min_order_amount')::integer;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BELOW_MINIMUM', 'stores', v_bad);
  END IF;

  SELECT jsonb_agg(x.value->'supplier_id') INTO v_bad
    FROM jsonb_array_elements(v_stores) AS x(value) WHERE NOT (x.value->>'payment_ok')::boolean;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_NOT_ACCEPTED', 'stores', v_bad);
  END IF;

  IF v_expected IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object('supplier_id', x.value->'supplier_id',
                                        'total', (x.value->>'subtotal')::integer + (x.value->>'shipping_fee')::integer))
      INTO v_bad
      FROM jsonb_array_elements(v_stores) AS x(value)
     WHERE (v_expected->>(x.value->>'supplier_id'))
           IS DISTINCT FROM ((x.value->>'subtotal')::integer + (x.value->>'shipping_fee')::integer)::text;
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRICE_CHANGED', 'stores', v_bad);
    END IF;
  END IF;

  -- 7. 建單:同一次結帳的訂單共用一組查詢 token(32 bytes 隨機值的 base64url,43 字;DB 只存 sha256 hex)
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_hash  := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  FOR v_store IN SELECT x.value FROM jsonb_array_elements(v_stores) AS x(value) LOOP
    INSERT INTO public.market_orders
      (checkout_id, supplier_id, buyer_name, buyer_phone, buyer_email, ship_city, ship_address, buyer_note,
       subtotal, shipping_fee, total, payment_method, lookup_token_hash, terms_version)
    VALUES
      (v_checkout, (v_store->>'supplier_id')::uuid, v_name, v_phone, v_email, v_city, v_address, v_note,
       (v_store->>'subtotal')::integer, (v_store->>'shipping_fee')::integer,
       (v_store->>'subtotal')::integer + (v_store->>'shipping_fee')::integer,
       v_store->>'payment', v_hash, v_terms)
    RETURNING id INTO v_order;

    INSERT INTO public.market_order_items (order_id, product_id, product_name, spec, temperature, unit_price, qty, line_total)
    SELECT v_order, p.id, p.name, p.spec, p.temperature, p.price, q.qty, p.price * q.qty
      FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
      JOIN public.market_products p ON p.id = q.product_id
     WHERE p.supplier_id = (v_store->>'supplier_id')::uuid
     ORDER BY p.name, p.id;

    -- 第一筆紀錄(guard 認得「還沒有紀錄的單」= 剛建好,身分記成 consumer);trigger 會排供應商的新訂單通知
    INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (v_order, NULL, 'pending');

    v_orders := v_orders || jsonb_build_array(jsonb_build_object(
      'id', v_order,
      'supplier_id', v_store->>'supplier_id',
      'total', (v_store->>'subtotal')::integer + (v_store->>'shipping_fee')::integer));
  END LOOP;

  UPDATE public.market_products p
     SET stock = p.stock - q.qty
    FROM jsonb_to_recordset(v_req) AS q(product_id uuid, qty integer)
   WHERE p.id = q.product_id AND p.stock IS NOT NULL;

  -- 下單確認信(含查詢連結):只有這裡知道 token 明文
  PERFORM public.market_enqueue_notify(jsonb_build_object('kind', 'placed', 'checkout_id', v_checkout, 'token', v_token));

  RETURN jsonb_build_object('ok', true, 'token', v_token, 'checkout_id', v_checkout, 'orders', v_orders);
END;
$$;

COMMENT ON FUNCTION public.market_place_order(jsonb) IS
  '零售市集免註冊下單:伺服器重算價格、庫存、配送範圍、最低金額、付款方式;每家店一張單;回傳查詢 token。錯誤回 {ok:false, code},不 raise。';

REVOKE ALL ON FUNCTION public.market_place_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_place_order(jsonb) TO anon, authenticated, service_role;

-- 下單開關的狀態,給前端決定要不要讓人進結帳(真正的關卡仍是 market_place_order 第 4 步)。
-- {open:對外開放了沒, can_order:這位呼叫者現在能不能下單(開放了,或是平台管理員)};不洩漏 app_config 其他內容。
CREATE OR REPLACE FUNCTION public.market_checkout_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object('open', s.open, 'can_order', s.open OR public.is_admin())
    FROM (SELECT COALESCE((SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'), '') = 'true' AS open) s
$$;

REVOKE ALL ON FUNCTION public.market_checkout_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_checkout_status() TO anon, authenticated, service_role;
```

**Step 4:跑測試,確認通過**

Run:同 Task 36 Step 4。Expected:`…共 48 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130200_market_checkout.sql supabase/tests/database/market_checkout.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 免註冊下單 RPC(伺服器重算價格、庫存、運費、配送、付款)與開關狀態(migration 130200 第 2 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 38:migration 130200(第 3 段):token 查單 `market_get_orders`

token 格式不對、找不到一律 `NOT_FOUND`(不區分);回這次結帳的每張單:店家、明細、狀態紀錄、收件資料(電話、Email 遮罩);轉帳資訊只在「待匯款」時給。

**Files:**
- Modify: `supabase/migrations/20261009130200_market_checkout.sql`(接在檔尾)
- Test: `supabase/tests/database/market_checkout.test.sql`(接在檔尾)

**Step 1:寫失敗的測試(接在測試檔最後面)**

```sql

-- ---------------------------------------------------------------------
-- 3. token 查單
-- ---------------------------------------------------------------------
CREATE FUNCTION pg_temp.lookup(p_token text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT pg_temp.as_val('anon', pg_temp.anon(), format('SELECT public.market_get_orders(%L)::text', p_token))::jsonb
$f$;

SELECT pg_temp.expect('anon 可以呼叫查單 RPC;遮罩函式不開放',
  has_function_privilege('anon', 'public.market_get_orders(text)', 'EXECUTE')::text || '|' ||
  has_function_privilege('anon', 'public.market_mask_phone(text)', 'EXECUTE')::text,
  'true|false');
SELECT pg_temp.expect('anon 用 token 查到這次結帳的兩張單',
  (SELECT jsonb_array_length(pg_temp.lookup(v ->> 'token') -> 'orders')::text FROM _ctx WHERE k = 'happy'), '2');
SELECT pg_temp.expect('電話、Email 遮罩',
  (SELECT (o ->> 'buyer_phone') || '|' || (o ->> 'buyer_email')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' LIMIT 1),
  '0912***678|h***@market-test.invalid');
SELECT pg_temp.expect('A 店那張:明細 2 項、紀錄 1 筆、店名',
  (SELECT jsonb_array_length(o -> 'items')::text || '|' || jsonb_array_length(o -> 'events')::text || '|' || (o -> 'store' ->> 'name')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o -> 'store' ->> 'supplier_id' = 'a9200000-0000-4000-8000-00000000000a'),
  '2|1|市集測試 A 店');
SELECT pg_temp.expect('還沒接單:不給轉帳資訊',
  (SELECT COALESCE(o ->> 'transfer_info', '∅')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o ->> 'payment_method' = 'transfer'),
  '∅');
SELECT pg_temp.expect('B 店接單(轉帳 → 自動待匯款)',
  (SELECT pg_temp.as_exec('authenticated', pg_temp.jwt('a9100000-0000-4000-8000-000000000002'), format($q$
     INSERT INTO public.market_order_events (order_id, from_status, to_status) VALUES (%L, 'pending', 'confirmed')$q$, o ->> 'id'))
     FROM _ctx, jsonb_array_elements(v -> 'orders') o
    WHERE k = 'happy' AND o ->> 'supplier_id' = 'a9200000-0000-4000-8000-00000000000b'),
  'OK');
SELECT pg_temp.expect('待匯款時才看得到轉帳資訊',
  (SELECT (o ->> 'status') || '|' || (o ->> 'transfer_info')
     FROM _ctx, jsonb_array_elements(pg_temp.lookup(v ->> 'token') -> 'orders') o
    WHERE k = 'happy' AND o ->> 'payment_method' = 'transfer'),
  'awaiting_payment|郵局(700) 帳號 0001234-5678901 戶名 市集測試 B');
SELECT pg_temp.expect('亂填、格式不對、空的 token 都是 NOT_FOUND',
  concat_ws('|', pg_temp.lookup(repeat('A', 43)) ->> 'code', pg_temp.lookup('short') ->> 'code', pg_temp.lookup('') ->> 'code'),
  'NOT_FOUND|NOT_FOUND|NOT_FOUND');
```

**Step 2:跑測試,確認失敗**

Run:同 Task 36 Step 4。Expected:`Management API 400:… 42883: function \"public.market_get_orders(text)\" does not exist`

**Step 3:寫 migration(第 3 段,接在檔尾)**

```sql

-- ---------------------------------------------------------------------
-- 3. token 查單(免登入;token 格式不對、找不到都回 NOT_FOUND,不區分)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_mask_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p IS NULL OR char_length(p) < 8 THEN '***'
              ELSE left(p, 4) || repeat('*', char_length(p) - 7) || right(p, 3) END
$$;

CREATE OR REPLACE FUNCTION public.market_mask_email(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p IS NULL OR position('@' IN p) < 2 THEN '***'
              ELSE left(p, 1) || '***' || substr(p, position('@' IN p)) END
$$;

CREATE OR REPLACE FUNCTION public.market_get_orders(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', o.id,
           'status', o.status,
           'payment_method', o.payment_method,
           'subtotal', o.subtotal,
           'shipping_fee', o.shipping_fee,
           'total', o.total,
           'created_at', o.created_at,
           'status_note', o.status_note,
           'shipped_carrier', o.shipped_carrier,
           'shipped_tracking_no', o.shipped_tracking_no,
           'buyer_name', o.buyer_name,
           'buyer_phone', public.market_mask_phone(o.buyer_phone),
           'buyer_email', public.market_mask_email(o.buyer_email),
           'ship_city', o.ship_city,
           'ship_address', o.ship_address,
           'buyer_note', o.buyer_note,
           'store', jsonb_build_object('supplier_id', s.supplier_id, 'name', sp.name, 'phone', sp.phone,
                                       'contact_email', sp.contact_email, 'ship_days', s.ship_days,
                                       'return_policy', s.return_policy),
           'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'product_name', i.product_name, 'spec', i.spec, 'unit_price', i.unit_price,
                              'qty', i.qty, 'line_total', i.line_total, 'temperature', i.temperature)
                            ORDER BY i.created_at, i.id), '[]'::jsonb)
                       FROM public.market_order_items i WHERE i.order_id = o.id),
           'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('to_status', e.to_status, 'created_at', e.created_at, 'note', e.note)
                                      ORDER BY e.created_at, e.id), '[]'::jsonb)
                        FROM public.market_order_events e WHERE e.order_id = o.id),
           -- 店家接單後、還沒收款前才給轉帳資訊
           'transfer_info', CASE WHEN o.status = 'awaiting_payment' AND o.payment_method = 'transfer'
                                 THEN (SELECT t.transfer_info FROM public.market_store_transfer t WHERE t.supplier_id = o.supplier_id) END
         ) ORDER BY o.created_at, o.id)
    INTO v_result
    FROM public.market_orders o
    JOIN public.market_stores s ON s.supplier_id = o.supplier_id
    JOIN public.suppliers sp ON sp.id = o.supplier_id
   WHERE o.lookup_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  RETURN jsonb_build_object('ok', true, 'orders', v_result);
END;
$$;

COMMENT ON FUNCTION public.market_get_orders(text) IS
  '用下單時拿到的 token 查那一次結帳的訂單(電話、Email 遮罩;待匯款時附轉帳資訊)。anon 可呼叫;anon 不能直接讀 market_orders。';

REVOKE ALL ON FUNCTION public.market_mask_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_mask_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_get_orders(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.market_get_orders(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
```

**Step 4:跑測試,確認通過**

Run:同 Task 36 Step 4。Expected:`…共 56 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/migrations/20261009130200_market_checkout.sql supabase/tests/database/market_checkout.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): token 查單 RPC(遮罩、待匯款才給轉帳資訊)(migration 130200 第 3 段)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 39:第 2 階段三支 migration 的還原檔

順序 130200 → 130100 → 130000;只拆第 2 階段的東西,第 1 階段的表要還在。130000 的還原會刪掉所有零售訂單(檔頭有警告)。

**Files:**
- Create: `supabase/rollbacks/20261009130200_market_checkout.down.sql`
- Create: `supabase/rollbacks/20261009130100_market_notify.down.sql`
- Create: `supabase/rollbacks/20261009130000_market_orders.down.sql`
- Test: `supabase/tests/database/market_phase2_rollback.test.sql`

**Step 1:寫失敗的測試**

```sql
-- 第 2 階段三支還原檔照順序(130200 → 130100 → 130000)能跑、跑完乾淨;第 1 階段的表還在。
-- runner:--with-migration 120000、130000、130100、130200,--with-rollback 130200、130100、130000(本檔在最後執行)
-- (DROP TABLE 不會觸發逐列的 DELETE trigger;還原檔仍先拆「只能新增」的 trigger,保險)
SELECT pg_temp.expect('還原後第 2 階段的表都不在',
  (SELECT count(*)::text FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('market_orders', 'market_order_items', 'market_order_events', 'market_rate_counters')),
  '0');
SELECT pg_temp.expect('還原後第 2 階段的函式都不在',
  (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('market_place_order', 'market_checkout_status', 'market_get_orders', 'market_rate_take', 'market_rate_key', 'market_client_ip',
                      'market_normalize_ip', 'market_mask_phone', 'market_mask_email', 'market_enqueue_notify', 'market_notify_event',
                      'market_guard_event', 'market_apply_event', 'market_events_immutable', 'market_events_one_per_order',
                      'market_transition_rules', 'market_order_status_label', 'market_phone_ok', 'market_email_ok')),
  '0');
SELECT pg_temp.expect('排程與設定拆掉',
  (SELECT count(*)::text FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup') || '|' ||
  (SELECT count(*)::text FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt', 'market_notify_function_url')),
  '0|0');
SELECT pg_temp.expect('第 1 階段的表還在',
  (SELECT count(*)::text FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('market_stores', 'market_store_transfer', 'market_products')),
  '3');
```

**Step 2:跑測試,確認失敗(只套 migration)**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs dry supabase/tests/database/market_phase2_rollback.test.sql --with-migration supabase/migrations/20261009120000_market_catalog.sql --with-migration supabase/migrations/20261009130000_market_orders.sql --with-migration supabase/migrations/20261009130100_market_notify.sql --with-migration supabase/migrations/20261009130200_market_checkout.sql`

Expected:`…共 4 項,失敗 3 項`(表還有 4 張、函式還有 19 支、排程與設定還在);exit 1。

**Step 3:寫還原檔**

`supabase/rollbacks/20261009130200_market_checkout.down.sql`:

```sql
-- =====================================================================
-- 還原 20261009130200_market_checkout:拆掉下單 / 查單 RPC、限流、清理排程與兩個 app_config 設定。
-- 🔴 先把前端退回不會呼叫 market_place_order / market_get_orders 的版本(Vercel Instant Rollback),再跑這支。
-- 已成立的訂單保留(在 market_orders,20261009130000 才會拆)。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup';

DROP FUNCTION IF EXISTS public.market_checkout_status();
DROP FUNCTION IF EXISTS public.market_get_orders(text);
DROP FUNCTION IF EXISTS public.market_place_order(jsonb);
DROP FUNCTION IF EXISTS public.market_mask_email(text);
DROP FUNCTION IF EXISTS public.market_mask_phone(text);
DROP FUNCTION IF EXISTS public.market_client_ip();
DROP FUNCTION IF EXISTS public.market_normalize_ip(text);
DROP FUNCTION IF EXISTS public.market_rate_key(text, text, text);
DROP FUNCTION IF EXISTS public.market_rate_take(jsonb);
DROP TABLE IF EXISTS public.market_rate_counters;

DELETE FROM public.app_config WHERE key IN ('market_checkout_open', 'market_rate_salt');
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130200';

NOTIFY pgrst, 'reload schema';
```

`supabase/rollbacks/20261009130100_market_notify.down.sql`:

```sql
-- =====================================================================
-- 還原 20261009130100_market_notify:拆掉狀態紀錄的通知 trigger 與排程函式、通知網址設定。
-- 🔴 要先還原 20261009130200(market_place_order 會呼叫 market_enqueue_notify)。
-- Edge Function market-notify 本身不用動(沒人呼叫就不會寄信);要停用可在 Dashboard 刪除那支函式。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_market_notify_event ON public.market_order_events;
DROP FUNCTION IF EXISTS public.market_notify_event();
DROP FUNCTION IF EXISTS public.market_enqueue_notify(jsonb);
DELETE FROM public.app_config WHERE key = 'market_notify_function_url';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130100';
```

`supabase/rollbacks/20261009130000_market_orders.down.sql`:

```sql
-- =====================================================================
-- 還原 20261009130000_market_orders
-- 🔴 會刪掉所有零售訂單、明細、狀態紀錄 —— 先匯出再跑;要先還原 20261009130200 → 20261009130100。
-- 狀態紀錄有「只能新增」的 trigger(刪訂單會連帶刪紀錄而被擋),所以先拆 trigger 再刪表。
-- 正式執行:照 docs/DEPLOY.md「寫了新 migration 之後」的 curl 方式送整份檔案。
-- =====================================================================
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS trg_market_events_immutable ON public.market_order_events;
DROP TABLE IF EXISTS public.market_order_events;
DROP TABLE IF EXISTS public.market_order_items;
DROP TABLE IF EXISTS public.market_orders;

DROP FUNCTION IF EXISTS public.market_apply_event();
DROP FUNCTION IF EXISTS public.market_guard_event();
DROP FUNCTION IF EXISTS public.market_events_immutable();
DROP FUNCTION IF EXISTS public.market_events_one_per_order();
DROP FUNCTION IF EXISTS public.market_order_status_label(text);
DROP FUNCTION IF EXISTS public.market_transition_rules();
DROP FUNCTION IF EXISTS public.market_email_ok(text);
DROP FUNCTION IF EXISTS public.market_phone_ok(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261009130000';

NOTIFY pgrst, 'reload schema';
```

**Step 4:跑測試,確認通過**

Run:同 Step 2,最後加 `--with-rollback supabase/rollbacks/20261009130200_market_checkout.down.sql --with-rollback supabase/rollbacks/20261009130100_market_notify.down.sql --with-rollback supabase/rollbacks/20261009130000_market_orders.down.sql`(順序不能換)。Expected:`…共 4 項,失敗 0 項`;殘留五個 `0`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/rollbacks/20261009130200_market_checkout.down.sql supabase/rollbacks/20261009130100_market_notify.down.sql supabase/rollbacks/20261009130000_market_orders.down.sql supabase/tests/database/market_phase2_rollback.test.sql
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 第 2 階段 migration 還原檔與還原測試

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 40:`market-notify` 的寄信閘門 `gate.ts`

沿用 `notify` 的 `isLive` / `TEST_INBOX` / `TEST_SUBJECT_PREFIX`(`supabase/functions/notify/gate.ts:32`),新增零售用的 `planMarketDeliveries`:閘門開 → 每位收件人一封;沒開 → 同一種收件對象(消費者 / 供應商)合併成一封寄 `ifoodmaptw@gmail.com`、主旨加「[測試轉寄]」、內文最前面列出原收件人與「MARKET_NOTIFY_LIVE 未開啟」。這支沒有 Deno 相依,vitest 直接測。

**Files:**
- Create: `supabase/functions/market-notify/gate.ts`
- Test: `supabase/functions/market-notify/gate.test.ts`

**Step 1:寫失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { isLive, marketForwardNoteHtml, planMarketDeliveries, TEST_INBOX, TEST_SUBJECT_PREFIX } from "./gate.ts";

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
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run supabase/functions/market-notify/gate.test.ts`

Expected:FAIL,`Failed to resolve import "./gate.ts"`

**Step 3:寫實作**

```ts
// 零售市集通知信的寄信閘門(比照 ../notify/gate.ts):
// 環境變數 MARKET_NOTIFY_LIVE 不是字串 "true" 時,所有信只寄到內部測試信箱(ifoodmaptw@gmail.com)、
// 主旨加「[測試轉寄]」、內文最前面列出原本的收件人。
// 🔴 寄給真實消費者要業主核准 —— 程式、計畫、部署步驟都不會打開 MARKET_NOTIFY_LIVE。
// 沒有 Deno / npm 相依,vitest 直接測(gate.test.ts)。
import { escapeHtml, isLive, TEST_INBOX, TEST_SUBJECT_PREFIX } from "../notify/gate.ts";

export { isLive, TEST_INBOX, TEST_SUBJECT_PREFIX };

export type MarketAudience = "consumer" | "supplier";

export interface MarketRecipient {
  email: string;
  audience: MarketAudience;
}

export interface MarketDelivery {
  /** 實際寄到哪裡 */
  to: string;
  audience: MarketAudience;
  subject: string;
  /** 這封信原本要寄給誰(閘門開放時就是 [to]) */
  originalRecipients: string[];
  /** 轉寄時插在內文最前面的說明(HTML);閘門開放時為 null */
  forwardNote: string | null;
}

const AUDIENCE_LABEL: Record<MarketAudience, string> = { consumer: "消費者", supplier: "供應商" };

export const marketForwardNoteHtml = (emails: string[], audience: MarketAudience): string =>
  `<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:560px;margin:0 auto 8px;` +
  `padding:12px 16px;border:1px dashed #f59e0b;background:#fffbeb;color:#92400e;font-size:13px;line-height:1.6">` +
  `${TEST_SUBJECT_PREFIX} 原本的收件人(${AUDIENCE_LABEL[audience]}):${emails.map(escapeHtml).join("、")}<br>` +
  `零售市集正式寄信尚未開放(MARKET_NOTIFY_LIVE 未開啟),這封信只寄到內部測試信箱,原收件人沒有收到。` +
  `</div>`;

/** live:每位收件人各一封;非 live:同一種收件對象合併成一封寄到 TEST_INBOX */
export const planMarketDeliveries = (recipients: MarketRecipient[], subject: string, live: boolean): MarketDelivery[] => {
  if (live) {
    return recipients.map((r) => ({ to: r.email, audience: r.audience, subject, originalRecipients: [r.email], forwardNote: null }));
  }
  const grouped = new Map<MarketAudience, string[]>();
  for (const r of recipients) {
    const list = grouped.get(r.audience) ?? [];
    if (!list.includes(r.email)) list.push(r.email);
    grouped.set(r.audience, list);
  }
  return [...grouped].map(([audience, emails]) => ({
    to: TEST_INBOX,
    audience,
    subject: `${TEST_SUBJECT_PREFIX} ${subject}`,
    originalRecipients: emails,
    forwardNote: marketForwardNoteHtml(emails, audience),
  }));
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  5 passed (5)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/functions/market-notify/gate.ts supabase/functions/market-notify/gate.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): market-notify 寄信閘門(MARKET_NOTIFY_LIVE 沒開全部轉寄內部信箱)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 41:通知信內容 `render.ts`

- `resolveEventMails`:哪個狀態寄給誰 —— 新訂單 → 店家;接單(貨到付款)/ 待匯款 / 拒單 / 出貨 / 取消 → 消費者;平台(管理員 / 系統)取消 → 也通知店家不要出貨;轉帳訂單的 `confirmed` 不寄(緊接著的 `awaiting_payment` 才寄,內含匯款資訊);已收款、完成不寄。
- `placedMail`:下單確認(唯一含查詢連結的信,列出每家店的明細、運費、總額、付款方式);`renderEventMail`:其餘每一種。
- 🔴 店名、品名、姓名、地址、備註、原因、轉帳資訊、物流全部 `esc()` 後才放進 HTML;主旨是純文字。訂單編號用跟三個後台同一支 `formatOrderNo`(`src/lib/order-number.ts`,沒有任何 import,Deno 可以直接載入)。

**Files:**
- Create: `supabase/functions/market-notify/render.ts`
- Test: `supabase/functions/market-notify/render.test.ts`

**Step 1:寫失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { formatOrderNo } from "../../../src/lib/order-number.ts";
import { placedMail, renderEventMail, resolveEventMails, twd, type EventContext, type MailOrder } from "./render.ts";

const ORDER: MailOrder = {
  id: "a9600000-0000-4000-8000-0000000000a1",
  storeName: "鮮綠<b>農產</b>",
  paymentMethod: "transfer",
  subtotal: 650,
  shippingFee: 120,
  total: 770,
  items: [{ product_name: "高麗菜", spec: "1 顆", qty: 2, unit_price: 100, line_total: 200 }],
  shipDays: 2,
};
const CTX: EventContext = {
  order: ORDER,
  buyerName: "王<script>小明",
  shipCity: "臺北市",
  shipAddress: "測試路 1 號",
  buyerNote: "請放<管理室>",
  reason: "缺貨<img src=x>",
  carrier: "黑貓宅急便",
  trackingNo: "9001",
  transferInfo: "台灣銀行 004\n帳號 0123-456-789",
  supplierOrdersUrl: "https://app.ifoodmap.ai/supplier/market/orders",
};

describe("resolveEventMails", () => {
  it("每個狀態寄給誰", () => {
    expect(resolveEventMails({ toStatus: "pending", actorRole: "consumer", paymentMethod: "cod" })).toEqual(["supplier_new"]);
    expect(resolveEventMails({ toStatus: "confirmed", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_confirmed"]);
    expect(resolveEventMails({ toStatus: "confirmed", actorRole: "supplier", paymentMethod: "transfer" })).toEqual([]);
    expect(resolveEventMails({ toStatus: "awaiting_payment", actorRole: "supplier", paymentMethod: "transfer" })).toEqual(["consumer_awaiting_payment"]);
    expect(resolveEventMails({ toStatus: "rejected", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_rejected"]);
    expect(resolveEventMails({ toStatus: "shipped", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_shipped"]);
    expect(resolveEventMails({ toStatus: "paid", actorRole: "supplier", paymentMethod: "transfer" })).toEqual([]);
    expect(resolveEventMails({ toStatus: "completed", actorRole: "supplier", paymentMethod: "cod" })).toEqual([]);
  });

  it("供應商自己取消只通知消費者;平台(管理員 / 系統)取消也要通知供應商不要出貨", () => {
    expect(resolveEventMails({ toStatus: "cancelled", actorRole: "supplier", paymentMethod: "cod" })).toEqual(["consumer_cancelled"]);
    expect(resolveEventMails({ toStatus: "cancelled", actorRole: "admin", paymentMethod: "cod" })).toEqual([
      "consumer_cancelled",
      "supplier_cancelled_by_platform",
    ]);
  });
});

describe("placedMail", () => {
  const mail = placedMail({ buyerName: "王<script>小明", orders: [ORDER], lookupUrl: "https://app.ifoodmap.ai/market/orders/TOKEN123" });

  it("主旨、查詢連結、金額、訂單編號", () => {
    expect(mail.subject).toBe("訂單已送出(共 1 家店)— iFoodmap 食材市集");
    expect(mail.html).toContain('href="https://app.ifoodmap.ai/market/orders/TOKEN123"');
    expect(mail.text).toContain("https://app.ifoodmap.ai/market/orders/TOKEN123");
    expect(mail.html).toContain(twd(770));
    expect(mail.html).toContain(formatOrderNo(ORDER.id));
    expect(mail.html).toContain("店家接單後,查詢頁會顯示匯款帳號");
  });

  it("使用者填的字都跳脫", () => {
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("王&lt;script&gt;小明");
    expect(mail.html).toContain("鮮綠&lt;b&gt;農產&lt;/b&gt;");
  });
});

describe("renderEventMail", () => {
  it("每一種都組得出主旨與內文,而且都不含 token / 查詢連結", () => {
    for (const kind of [
      "supplier_new",
      "consumer_confirmed",
      "consumer_awaiting_payment",
      "consumer_rejected",
      "consumer_shipped",
      "consumer_cancelled",
      "supplier_cancelled_by_platform",
    ] as const) {
      const m = renderEventMail(kind, CTX);
      expect(m.subject.length, kind).toBeGreaterThan(0);
      expect(m.html, kind).not.toContain("/market/orders/");
      expect(m.html, kind).not.toContain("<script>");
      expect(m.html, kind).not.toContain("<img src=x>");
    }
  });

  it("待匯款:金額與轉帳資訊(跳脫、保留換行)", () => {
    const m = renderEventMail("consumer_awaiting_payment", CTX);
    expect(m.subject).toBe(`請匯款 NT$ 770 — 零售訂單 ${formatOrderNo(ORDER.id)}`);
    expect(m.html).toContain("台灣銀行 004\n帳號 0123-456-789");
    expect(m.html).toContain("white-space:pre-line");
  });

  it("出貨:物流與單號;拒單 / 取消:原因跳脫", () => {
    expect(renderEventMail("consumer_shipped", CTX).html).toContain("黑貓宅急便,單號 9001");
    expect(renderEventMail("consumer_rejected", CTX).html).toContain("缺貨&lt;img src=x&gt;");
    expect(renderEventMail("consumer_cancelled", CTX).text).toContain("缺貨<img src=x>");
  });

  it("寄給供應商的新訂單信:後台連結、備註(跳脫)", () => {
    const m = renderEventMail("supplier_new", CTX);
    expect(m.subject).toBe(`新的零售訂單 ${formatOrderNo(ORDER.id)} — 請到後台接單`);
    expect(m.html).toContain('href="https://app.ifoodmap.ai/supplier/market/orders"');
    expect(m.html).toContain("請放&lt;管理室&gt;");
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run supabase/functions/market-notify/render.test.ts`

Expected:FAIL,`Failed to resolve import "./render.ts"`

**Step 3:寫實作**

```ts
// 零售市集通知信的內容 —— 純函式,vitest 直接測(render.test.ts)。
//
// 🔴 內文是 HTML:店名、品名、買家姓名、地址、備註、原因、轉帳資訊、物流單號都是使用者填的字,一律先 esc() 再放進模板;
//    主旨是純文字(Resend 的 subject 欄位),不跳脫。
// 🔴 查詢連結(含 token)只出現在「下單確認」這一封;handler 的回傳值、log、notifications 表都不能出現 token。
//    後續的接單 / 出貨信沒有 token(資料庫只存雜湊),改請消費者用確認信裡的連結查看。
import { esc } from "../_shared/supplier-mail.ts";
// 訂單編號跟三個後台同一支函式(src/lib/order-number.ts 沒有任何 import,Deno 可以直接載入;--use-api 會一起上傳)
import { formatOrderNo } from "../../../src/lib/order-number.ts";

export interface Mail {
  subject: string;
  html: string;
  text: string;
}

export interface MailItem {
  product_name: string;
  spec: string;
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface MailOrder {
  id: string;
  storeName: string;
  paymentMethod: "cod" | "transfer";
  subtotal: number;
  shippingFee: number;
  total: number;
  items: MailItem[];
  shipDays: number | null;
}

export const twd = (n: number) => `NT$ ${Number(n).toLocaleString("zh-TW")}`;
export const orderLabel = (id: string) => `零售訂單 ${formatOrderNo(id)}`;
const PAYMENT_LABEL = { cod: "貨到付款", transfer: "銀行轉帳" } as const;

const FOOTER = "iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。";

const shell = (title: string, inner: string) => `
<div style="font-family:-apple-system,'PingFang TC','Microsoft JhengHei',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <div style="font-size:20px;font-weight:700;color:#047857;margin-bottom:20px">iFoodmap 食材市集</div>
  <h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>
  ${inner}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
  <p style="font-size:12px;color:#64748b;line-height:1.7;margin:0">${esc(FOOTER)}</p>
</div>`;

const p = (html: string) => `<p style="font-size:15px;line-height:1.75;color:#334155;margin:0 0 14px">${html}</p>`;
const box = (label: string, value: string) =>
  `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:0 0 14px">` +
  `<div style="font-size:12px;color:#64748b;margin-bottom:4px">${esc(label)}</div>` +
  `<div style="font-size:14px;line-height:1.7;color:#0f172a;white-space:pre-line">${esc(value)}</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:8px 0 20px"><a href="${esc(href)}" style="display:inline-block;background:#047857;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">${esc(label)}</a></p>`;

const itemsTable = (o: MailOrder) =>
  `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 8px">` +
  o.items
    .map(
      (i) =>
        `<tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9">${esc(i.product_name)}(${esc(i.spec)})× ${i.qty}</td>` +
        `<td style="padding:4px 0;border-bottom:1px solid #f1f5f9;text-align:right">${esc(twd(i.line_total))}</td></tr>`,
    )
    .join("") +
  `<tr><td style="padding:4px 0;color:#64748b">運費</td><td style="padding:4px 0;text-align:right;color:#64748b">${esc(
    o.shippingFee === 0 ? "免運" : twd(o.shippingFee),
  )}</td></tr>` +
  `<tr><td style="padding:4px 0;font-weight:700">總額</td><td style="padding:4px 0;text-align:right;font-weight:700">${esc(twd(o.total))}</td></tr>` +
  `</table>`;

const itemsText = (o: MailOrder) =>
  [...o.items.map((i) => `- ${i.product_name}(${i.spec})× ${i.qty}:${twd(i.line_total)}`), `運費:${o.shippingFee === 0 ? "免運" : twd(o.shippingFee)}`, `總額:${twd(o.total)}`].join("\n");

/** 下單確認(寄給消費者,含查詢連結) */
export const placedMail = (opts: { buyerName: string; orders: MailOrder[]; lookupUrl: string }): Mail => {
  const subject = `訂單已送出(共 ${opts.orders.length} 家店)— iFoodmap 食材市集`;
  const sections = opts.orders
    .map(
      (o) =>
        `<h2 style="font-size:15px;margin:18px 0 6px">${esc(o.storeName)}・${esc(orderLabel(o.id))}</h2>` +
        itemsTable(o) +
        p(
          esc(
            o.paymentMethod === "transfer"
              ? "付款方式:銀行轉帳。店家接單後,查詢頁會顯示匯款帳號,我們也會寄信通知你。"
              : "付款方式:貨到付款。",
          ),
        ),
    )
    .join("");
  const html = shell(
    "訂單已送給店家",
    p(`${esc(opts.buyerName)} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`) +
      sections +
      button(opts.lookupUrl, "查看訂單") +
      p(esc("這個連結就是您的訂單查詢頁,請保留這封信、不要轉寄給別人。")),
  );
  const text = [
    `${opts.buyerName} 您好,感謝您在 iFoodmap 食材市集訂購。以下訂單已送給店家,店家接單後會再寄信通知您。`,
    ...opts.orders.map((o) => `\n【${o.storeName}】${orderLabel(o.id)}\n${itemsText(o)}\n付款方式:${PAYMENT_LABEL[o.paymentMethod]}`),
    `\n查看訂單:${opts.lookupUrl}`,
    "這個連結就是您的訂單查詢頁,請保留這封信、不要轉寄給別人。",
    "",
    FOOTER,
  ].join("\n");
  return { subject, html, text };
};

export type EventMailKind =
  | "supplier_new"
  | "consumer_confirmed"
  | "consumer_awaiting_payment"
  | "consumer_rejected"
  | "consumer_shipped"
  | "consumer_cancelled"
  | "supplier_cancelled_by_platform";

/** 這筆狀態紀錄要寄哪幾封信(paid / completed 不寄;轉帳訂單的 confirmed 不寄,緊接著的 awaiting_payment 才寄) */
export const resolveEventMails = (ev: { toStatus: string; actorRole: string | null; paymentMethod: string }): EventMailKind[] => {
  switch (ev.toStatus) {
    case "pending":
      return ["supplier_new"];
    case "confirmed":
      return ev.paymentMethod === "transfer" ? [] : ["consumer_confirmed"];
    case "awaiting_payment":
      return ["consumer_awaiting_payment"];
    case "rejected":
      return ["consumer_rejected"];
    case "shipped":
      return ["consumer_shipped"];
    case "cancelled":
      return ev.actorRole === "supplier" ? ["consumer_cancelled"] : ["consumer_cancelled", "supplier_cancelled_by_platform"];
    default:
      return [];
  }
};

export interface EventContext {
  order: MailOrder;
  buyerName: string;
  shipCity: string;
  shipAddress: string;
  buyerNote: string | null;
  reason: string;
  carrier: string;
  trackingNo: string;
  transferInfo: string;
  /** 供應商後台的訂單連結(只放在寄給供應商的信) */
  supplierOrdersUrl: string;
}

const LOOKUP_HINT = "訂單進度請用「下單確認信」裡的「查看訂單」連結查看。";

export const renderEventMail = (kind: EventMailKind, c: EventContext): Mail => {
  const o = c.order;
  const label = orderLabel(o.id);
  switch (kind) {
    case "supplier_new": {
      const subject = `新的零售訂單 ${formatOrderNo(o.id)} — 請到後台接單`;
      const html = shell(
        "有一張新的零售訂單",
        p(`消費者 ${esc(c.buyerName)} 向你訂購(${esc(PAYMENT_LABEL[o.paymentMethod])},收件縣市 ${esc(c.shipCity)})。請盡快接單或拒單。`) +
          itemsTable(o) +
          (c.buyerNote ? box("消費者備註", c.buyerNote) : "") +
          button(c.supplierOrdersUrl, "到後台處理"),
      );
      const text = [`有一張新的零售訂單 ${label}`, itemsText(o), c.buyerNote ? `消費者備註:${c.buyerNote}` : "", `到後台處理:${c.supplierOrdersUrl}`].filter(Boolean).join("\n");
      return { subject, html, text };
    }
    case "consumer_confirmed": {
      const subject = `${o.storeName} 已接單 — ${label}`;
      const days = o.shipDays == null ? "" : o.shipDays === 0 ? ",預計當天出貨" : `,預計 ${o.shipDays} 個工作天內出貨`;
      const html = shell("店家已接單", p(`「${esc(o.storeName)}」已接受您的訂單 ${esc(label)}${esc(days)}。付款方式:貨到付款。`) + itemsTable(o) + p(esc(LOOKUP_HINT)));
      return { subject, html, text: `「${o.storeName}」已接受您的訂單 ${label}${days}。付款方式:貨到付款。\n${itemsText(o)}\n${LOOKUP_HINT}` };
    }
    case "consumer_awaiting_payment": {
      const subject = `請匯款 ${twd(o.total)} — ${label}`;
      const html = shell(
        "店家已接單,請匯款",
        p(`「${esc(o.storeName)}」已接受您的訂單 ${esc(label)}。請依下列資訊匯款 ${esc(twd(o.total))},店家確認收款後就會安排出貨。`) +
          box("匯款資訊", c.transferInfo || "(店家尚未提供,請直接聯絡店家)") +
          itemsTable(o) +
          p(esc(LOOKUP_HINT)),
      );
      const text = [`「${o.storeName}」已接受您的訂單 ${label}。請匯款 ${twd(o.total)}:`, c.transferInfo || "(店家尚未提供,請直接聯絡店家)", itemsText(o), LOOKUP_HINT].join("\n");
      return { subject, html, text };
    }
    case "consumer_rejected": {
      const subject = `店家無法接單 — ${label}`;
      const html = shell("店家無法接這張訂單", p(`很抱歉,「${esc(o.storeName)}」無法接受您的訂單 ${esc(label)}。`) + box("原因", c.reason || "(沒有填寫)") + p(esc("這張訂單不會成立,您不需要付款。")));
      return { subject, html, text: `很抱歉,「${o.storeName}」無法接受您的訂單 ${label}。\n原因:${c.reason || "(沒有填寫)"}\n這張訂單不會成立,您不需要付款。` };
    }
    case "consumer_shipped": {
      const subject = `已出貨 — ${label}`;
      const tracking = `${c.carrier}${c.trackingNo ? `,單號 ${c.trackingNo}` : ""}`;
      const html = shell("您的訂單已出貨", p(`「${esc(o.storeName)}」已將訂單 ${esc(label)} 出貨。`) + box("物流", tracking) + p(esc(LOOKUP_HINT)));
      return { subject, html, text: `「${o.storeName}」已將訂單 ${label} 出貨。\n物流:${tracking}\n${LOOKUP_HINT}` };
    }
    case "consumer_cancelled": {
      const subject = `訂單已取消 — ${label}`;
      const html = shell("訂單已取消", p(`您在「${esc(o.storeName)}」的訂單 ${esc(label)} 已取消。`) + box("原因", c.reason || "(沒有填寫)") + p(esc("如果已經匯款,請直接聯絡店家退款。")));
      return { subject, html, text: `您在「${o.storeName}」的訂單 ${label} 已取消。\n原因:${c.reason || "(沒有填寫)"}\n如果已經匯款,請直接聯絡店家退款。` };
    }
    case "supplier_cancelled_by_platform": {
      const subject = `平台已取消零售訂單 ${formatOrderNo(o.id)} — 請不要出貨`;
      const html = shell("平台已取消這張零售訂單", p(`iFoodmap 平台已取消訂單 ${esc(label)}(消費者 ${esc(c.buyerName)})。<strong>請不要出貨</strong>。`) + box("原因", c.reason || "(沒有填寫)") + button(c.supplierOrdersUrl, "到後台查看"));
      return { subject, html, text: `iFoodmap 平台已取消訂單 ${label}(消費者 ${c.buyerName}),請不要出貨。\n原因:${c.reason || "(沒有填寫)"}\n${c.supplierOrdersUrl}` };
    }
  }
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  8 passed (8)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/functions/market-notify/render.ts supabase/functions/market-notify/render.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單通知信內容(下單確認含查詢連結、其餘各狀態)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 42:`market-notify` 主程式、入口與 JWT 設定

- `handler.ts`(依賴全部注入,vitest 用 `supabase/tests/fake-supabase.ts` 的 `FakeDb` 測):驗 `Authorization: Bearer <NOTIFY_SECRET>`(沒設 503、不對 401);`{kind:'placed'}` 先比對 `sha256(token)` 跟每張單的 `lookup_token_hash`(對不上 403、不寄),寄一封確認信給消費者;`{kind:'event'}` 依 `resolveEventMails` 寄;寄給消費者的信回覆地址設成店家信箱(閘門沒開時一律回平台信箱);每封都記 `notifications`(不含 token);讀資料庫失敗回 500、不洩漏細節。讀的欄位名稱有測試對照 migration 的 `CREATE TABLE`,打錯字會紅。
- `index.ts`:接上 Deno 的環境變數與 `Deno.serve`(讀的 secret 全部是既有的)。
- `supabase/config.toml`:`[functions.market-notify] verify_jwt = false`(資料庫呼叫沒有使用者 JWT)。

**Files:**
- Create: `supabase/functions/market-notify/handler.ts`
- Create: `supabase/functions/market-notify/index.ts`
- Modify: `supabase/config.toml`(檔尾)
- Test: `supabase/functions/market-notify/handler.test.ts`

**Step 1:寫失敗的測試**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeDb, type FakeDbOptions, type Row } from "../../tests/fake-supabase.ts";
import type { MailConfig, SendMail } from "../_shared/supplier-mail.ts";
import { sha256Hex } from "../ai/crypto.ts";
import { createMarketNotifyHandler, EVENT_COLUMNS, ITEM_COLUMNS, ORDER_COLUMNS } from "./handler.ts";

const SECRET = "notify-secret";
const TOKEN = `tok_${"x".repeat(39)}`; // 43 字元 base64url
const HASH = await sha256Hex(TOKEN);
const CHECKOUT = "a9500000-0000-4000-8000-000000000001";
const ORDER_A = "a9600000-0000-4000-8000-0000000000a1";
const ORDER_B = "a9600000-0000-4000-8000-0000000000b1";
const SUP_A = "a9200000-0000-4000-8000-00000000000a";
const SUP_B = "a9200000-0000-4000-8000-00000000000b";
const EV = (n: number) => `a9700000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const CONFIG: MailConfig = {
  resendKey: "re_test",
  applicantFrom: "iFoodmap 食材地圖 <noreply@gathertaiwan.com>",
  ownerFrom: "iFoodmap 表單通知 <noreply@gathertaiwan.com>",
  ownerTo: ["ifoodmaptw@gmail.com"],
  replyTo: "ifoodmaptw@gmail.com",
  siteUrl: "https://app.ifoodmap.ai",
  adminSiteUrl: "https://ifoodmap-admin.vercel.app",
};

const order = (over: Row): Row => ({
  checkout_id: CHECKOUT,
  status: "pending",
  buyer_name: "王小明",
  buyer_email: "buyer@example.com",
  ship_city: "臺北市",
  ship_address: "測試路 1 號",
  buyer_note: null,
  payment_method: "cod",
  lookup_token_hash: HASH,
  ...over,
});

const tables = (): Record<string, Row[]> => ({
  suppliers: [
    { id: SUP_A, name: "市集測試 A 店", contact_email: "store-a@example.com" },
    { id: SUP_B, name: "市集測試 B 店", contact_email: null },
  ],
  market_stores: [
    { supplier_id: SUP_A, ship_days: 2 },
    { supplier_id: SUP_B, ship_days: 3 },
  ],
  market_store_transfer: [{ supplier_id: SUP_B, transfer_info: "郵局(700) 帳號 0001234-5678901" }],
  market_orders: [
    order({ id: ORDER_A, supplier_id: SUP_A, subtotal: 650, shipping_fee: 120, total: 770 }),
    order({ id: ORDER_B, supplier_id: SUP_B, subtotal: 400, shipping_fee: 60, total: 460, payment_method: "transfer" }),
  ],
  market_order_items: [
    { order_id: ORDER_A, product_name: "有機高麗菜", spec: "1 顆", qty: 2, unit_price: 100, line_total: 200 },
    { order_id: ORDER_A, product_name: "牛肉片", spec: "300g/盒", qty: 1, unit_price: 450, line_total: 450 },
    { order_id: ORDER_B, product_name: "挪威鮭魚", spec: "200g/片", qty: 2, unit_price: 200, line_total: 400 },
  ],
  market_order_events: [
    { id: EV(1), order_id: ORDER_A, from_status: null, to_status: "pending", actor_role: "consumer", note: null, payload: {} },
    { id: EV(2), order_id: ORDER_A, from_status: "pending", to_status: "confirmed", actor_role: "supplier", note: null, payload: {} },
    { id: EV(3), order_id: ORDER_B, from_status: "pending", to_status: "confirmed", actor_role: "supplier", note: null, payload: {} },
    { id: EV(4), order_id: ORDER_B, from_status: "confirmed", to_status: "awaiting_payment", actor_role: "system", note: null, payload: {} },
    { id: EV(5), order_id: ORDER_A, from_status: "pending", to_status: "cancelled", actor_role: "admin", note: "疑似假單", payload: {} },
    { id: EV(6), order_id: ORDER_A, from_status: "confirmed", to_status: "shipped", actor_role: "supplier", note: null, payload: { carrier: "黑貓宅急便", tracking_no: "9001" } },
    { id: EV(7), order_id: ORDER_A, from_status: "shipped", to_status: "completed", actor_role: "supplier", note: null, payload: {} },
    { id: EV(8), order_id: ORDER_B, from_status: null, to_status: "pending", actor_role: "consumer", note: null, payload: {} },
  ],
  notifications: [],
});

const setup = (opts: { live?: boolean; secret?: string; fail?: FakeDbOptions["fail"]; send?: SendMail } = {}) => {
  const db = new FakeDb({ tables: tables(), fail: opts.fail });
  const send = vi.fn(opts.send ?? (async () => ({ ok: true, id: "re_1", error: null })));
  const log = vi.fn();
  const handler = createMarketNotifyHandler({
    db,
    send,
    config: CONFIG,
    secret: opts.secret ?? SECRET,
    isLive: () => opts.live ?? false,
    log,
  });
  const call = async (body: unknown, auth = `Bearer ${SECRET}`, method = "POST") => {
    const res = await handler(
      new Request("https://x.supabase.co/functions/v1/market-notify", {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  return { db, send, log, call };
};

describe("market-notify:驗證", () => {
  it("沒設密鑰 503;密鑰不對 401;不是 POST 405;都不寄信", async () => {
    expect((await setup({ secret: "" }).call({ kind: "event", event_id: EV(1) })).status).toBe(503);
    const s = setup();
    expect((await s.call({ kind: "event", event_id: EV(1) }, "Bearer wrong")).status).toBe(401);
    expect((await s.call(null, `Bearer ${SECRET}`, "GET")).status).toBe(405);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("kind 不對、id 格式不對 400", async () => {
    const s = setup();
    expect((await s.call({ kind: "nope" })).status).toBe(400);
    expect((await s.call({ kind: "event", event_id: "1" })).status).toBe(400);
    expect((await s.call({ kind: "placed", checkout_id: CHECKOUT, token: "short" })).status).toBe(400);
  });
});

describe("market-notify:下單確認", () => {
  it("閘門關閉:只寄一封到測試信箱,列出兩家店與查詢連結;回應與紀錄都沒有 token", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ live: false, sent: 1, total: 1, orders: 2 });
    expect(s.send).toHaveBeenCalledTimes(1);
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["ifoodmaptw@gmail.com"]);
    expect(msg.subject).toBe("[測試轉寄] 訂單已送出(共 2 家店)— iFoodmap 食材市集");
    expect(msg.html).toContain("buyer@example.com");
    expect(msg.html).toContain(`https://app.ifoodmap.ai/market/orders/${TOKEN}`);
    expect(msg.html).toContain("市集測試 A 店");
    expect(msg.html).toContain("市集測試 B 店");
    expect(msg.replyTo).toBe("ifoodmaptw@gmail.com");
    expect(r.text).not.toContain(TOKEN);
    expect(JSON.stringify(s.db.tables.notifications)).not.toContain(TOKEN);
    expect(s.db.tables.notifications).toHaveLength(1);
    expect(s.db.tables.notifications[0]).toMatchObject({ recipient: "ifoodmaptw@gmail.com", channel: "email", status: "sent" });
  });

  it("閘門開放:寄給消費者本人", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "placed", checkout_id: CHECKOUT, token: TOKEN });
    expect(s.send.mock.calls[0][0].to).toEqual(["buyer@example.com"]);
    expect(s.send.mock.calls[0][0].subject).toBe("訂單已送出(共 2 家店)— iFoodmap 食材市集");
  });

  it("token 跟訂單上的雜湊對不上 403,不寄", async () => {
    const s = setup();
    const r = await s.call({ kind: "placed", checkout_id: CHECKOUT, token: `tok_${"y".repeat(39)}` });
    expect(r.status).toBe(403);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("找不到這次結帳 404", async () => {
    const s = setup();
    expect((await s.call({ kind: "placed", checkout_id: "a9500000-0000-4000-8000-000000000099", token: TOKEN })).status).toBe(404);
  });
});

describe("market-notify:狀態紀錄", () => {
  it("新訂單 → 供應商(閘門開放時寄到店家信箱,附後台連結)", async () => {
    const s = setup({ live: true });
    const r = await s.call({ kind: "event", event_id: EV(1) });
    expect(r.body.data).toMatchObject({ kinds: ["supplier_new"], sent: 1 });
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["store-a@example.com"]);
    expect(msg.html).toContain('href="https://app.ifoodmap.ai/supplier/market/orders"');
  });

  it("貨到付款接單 → 消費者;回信給店家", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "event", event_id: EV(2) });
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(["buyer@example.com"]);
    expect(msg.subject).toContain("市集測試 A 店 已接單");
    expect(msg.replyTo).toBe("store-a@example.com");
  });

  it("轉帳訂單:confirmed 不寄,緊接著的 awaiting_payment 寄匯款資訊", async () => {
    const s = setup({ live: true });
    expect((await s.call({ kind: "event", event_id: EV(3) })).body.data).toMatchObject({ skipped: true });
    await s.call({ kind: "event", event_id: EV(4) });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0][0].html).toContain("郵局(700) 帳號 0001234-5678901");
    // B 店沒有聯絡信箱 → 回信退回平台信箱
    expect(s.send.mock.calls[0][0].replyTo).toBe("ifoodmaptw@gmail.com");
  });

  it("平台取消 → 消費者與供應商各一封;閘門關閉時兩封都寄測試信箱", async () => {
    const s = setup();
    const r = await s.call({ kind: "event", event_id: EV(5) });
    expect(r.body.data).toMatchObject({ kinds: ["consumer_cancelled", "supplier_cancelled_by_platform"], sent: 2 });
    expect(s.send.mock.calls.map((c) => c[0].to[0])).toEqual(["ifoodmaptw@gmail.com", "ifoodmaptw@gmail.com"]);
    expect(s.send.mock.calls[1][0].html).toContain("store-a@example.com");
    expect(s.send.mock.calls[1][0].html).toContain("疑似假單");
  });

  it("出貨信帶物流單號;完成不寄", async () => {
    const s = setup({ live: true });
    await s.call({ kind: "event", event_id: EV(6) });
    expect(s.send.mock.calls[0][0].html).toContain("黑貓宅急便,單號 9001");
    expect((await s.call({ kind: "event", event_id: EV(7) })).body.data).toMatchObject({ skipped: true });
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("供應商沒有聯絡信箱:跳過並記錯誤,仍回 200", async () => {
    const s = setup({ live: true });
    const r = await s.call({ kind: "event", event_id: EV(8) });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ sent: 0, skipped: ["supplier_new"] });
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ kind: "supplier_new" }));
  });

  it("寄信失敗:紀錄標 failed、記錯誤", async () => {
    const s = setup({ live: true, send: async () => ({ ok: false, id: null, error: "Resend 500" }) });
    const r = await s.call({ kind: "event", event_id: EV(2) });
    expect(r.body.data).toMatchObject({ sent: 0, total: 1 });
    expect(s.db.tables.notifications[0]).toMatchObject({ status: "failed", sent_at: null });
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ step: "send", error: "Resend 500" }));
  });

  it("讀資料庫失敗 500(不洩漏細節)", async () => {
    const s = setup({ fail: (table) => (table === "market_orders" ? { message: "boom" } : undefined) });
    const r = await s.call({ kind: "event", event_id: EV(1) });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("boom");
    expect(s.log).toHaveBeenCalledWith("error", expect.objectContaining({ error: "boom" }));
  });
});

describe("讀取的欄位都存在於 migration", () => {
  const sql = readFileSync(resolve(__dirname, "../../migrations/20261009130000_market_orders.sql"), "utf8");
  const tableBlock = (name: string) => {
    const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
    expect(start, name).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("\n);", start));
  };
  it.each([
    ["market_orders", ORDER_COLUMNS],
    ["market_order_items", ITEM_COLUMNS],
    ["market_order_events", EVENT_COLUMNS],
  ])("%s", (table, columns) => {
    const block = tableBlock(table);
    for (const col of columns.split(",").map((c) => c.trim())) {
      expect(block, `${table}.${col}`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run supabase/functions/market-notify/handler.test.ts`

Expected:FAIL,`Failed to resolve import "./handler.ts"`

**Step 3:寫實作**

`supabase/functions/market-notify/handler.ts`:

```ts
// market-notify 的主要邏輯(index.ts 只負責接上 Deno 的環境變數與 serve;vitest 用 FakeDb 測每一條分支)。
//
// 呼叫者只有資料庫(pg_net,見 migration 20261009130100 的 market_enqueue_notify):
//   {kind:'placed', checkout_id, token} → 寄「下單確認」給消費者(內含查詢連結;一次結帳一封,列出每家店)
//   {kind:'event',  event_id}           → 依狀態紀錄寄給供應商或消費者(規則見 render.ts 的 resolveEventMails)
//
// 驗證:Authorization: Bearer <NOTIFY_SECRET>(跟 notify 同一把;資料庫那邊存在 app_config.notify_service_key)。
// 🔴 token 只放進確認信的連結:不寫進回應、log、notifications 表。placed 先比對 sha256(token) 與訂單上的雜湊,
//    對不上就不寄 —— 拿到密鑰的人也沒辦法替別人的訂單寄出一個假的查詢連結。
// 🔴 MARKET_NOTIFY_LIVE 不是 "true" 時,所有信只寄 ifoodmaptw@gmail.com(gate.ts)。開放要業主核准。
import type { Db, DbResult, LogFn } from "../_shared/db.ts";
import { isDeliverableEmail, type MailConfig, type SendMail } from "../_shared/supplier-mail.ts";
import { sha256Hex } from "../ai/crypto.ts";
import { type MarketAudience, planMarketDeliveries, TEST_SUBJECT_PREFIX } from "./gate.ts";
import {
  type EventContext,
  type EventMailKind,
  type Mail,
  type MailItem,
  type MailOrder,
  orderLabel,
  placedMail,
  renderEventMail,
  resolveEventMails,
} from "./render.ts";

export interface MarketNotifyDeps {
  db: Db;
  send: SendMail;
  config: MailConfig;
  /** = Supabase secret NOTIFY_SECRET */
  secret: string;
  /** 每次請求重讀 MARKET_NOTIFY_LIVE(不快取) */
  isLive: () => boolean;
  log: LogFn;
}

// 讀資料用的欄位(handler.test.ts 會對照 migration 的 CREATE TABLE,打錯字測試就會失敗)
export const ORDER_COLUMNS =
  "id, checkout_id, supplier_id, status, buyer_name, buyer_email, ship_city, ship_address, buyer_note, subtotal, shipping_fee, total, payment_method, lookup_token_hash";
export const ITEM_COLUMNS = "product_name, spec, qty, unit_price, line_total";
export const EVENT_COLUMNS = "id, order_id, from_status, to_status, actor_role, note, payload";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

const many = async (q: PromiseLike<DbResult>): Promise<Row[]> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
};
const one = async (q: PromiseLike<DbResult>): Promise<Row | null> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? null) as Row | null;
};

/** 訂單 → 信裡要用的樣子(店名、明細、出貨天數),順便回傳供應商資料(收件信箱) */
const loadMailOrder = async (db: Db, order: Row): Promise<{ mail: MailOrder; supplier: Row | null }> => {
  const [supplier, store, items] = await Promise.all([
    one(db.from("suppliers").select("name, contact_email").eq("id", order.supplier_id).maybeSingle()),
    one(db.from("market_stores").select("ship_days").eq("supplier_id", order.supplier_id).maybeSingle()),
    many(db.from("market_order_items").select(ITEM_COLUMNS).eq("order_id", order.id)),
  ]);
  const mailItems: MailItem[] = items
    .map((i) => ({
      product_name: str(i.product_name),
      spec: str(i.spec),
      qty: Number(i.qty),
      unit_price: Number(i.unit_price),
      line_total: Number(i.line_total),
    }))
    .sort((a, b) => a.product_name.localeCompare(b.product_name, "zh-Hant"));
  return {
    supplier,
    mail: {
      id: str(order.id),
      storeName: str(supplier?.name) || "店家",
      paymentMethod: order.payment_method === "transfer" ? "transfer" : "cod",
      subtotal: Number(order.subtotal),
      shippingFee: Number(order.shipping_fee),
      total: Number(order.total),
      items: mailItems,
      shipDays: store?.ship_days === null || store?.ship_days === undefined ? null : Number(store.ship_days),
    },
  };
};

interface DeliveryResult {
  audience: MarketAudience;
  ok: boolean;
}

/** 經過閘門寄出,每封都記一筆 notifications(後台 /admin/notifications 看得到;不含 token) */
const deliver = async (
  deps: MarketNotifyDeps,
  live: boolean,
  recipient: { email: string; audience: MarketAudience },
  mail: Mail,
  logMessage: string,
  replyTo: string | null,
): Promise<DeliveryResult[]> => {
  const results: DeliveryResult[] = [];
  for (const d of planMarketDeliveries([recipient], mail.subject, live)) {
    const forwarded = d.forwardNote !== null;
    const original = d.originalRecipients.join("、");
    const r = await deps.send({
      from: deps.config.applicantFrom,
      to: [d.to],
      subject: d.subject,
      html: (d.forwardNote ?? "") + mail.html,
      text: forwarded ? `${TEST_SUBJECT_PREFIX} 原本的收件人:${original}\n\n${mail.text}` : mail.text,
      // 消費者回信給店家(訂單由店家處理);測試轉寄時一律回平台信箱
      replyTo: forwarded ? deps.config.replyTo : (replyTo ?? deps.config.replyTo),
    });
    await deps.db.from("notifications").insert({
      recipient: d.to,
      channel: "email",
      title: d.subject,
      message: logMessage + (forwarded ? `(測試轉寄,原收件人:${original})` : ""),
      status: r.ok ? "sent" : "failed",
      sent_at: r.ok ? new Date().toISOString() : null,
    });
    if (!r.ok) deps.log("error", { fn: "market-notify", step: "send", audience: d.audience, error: r.error });
    results.push({ audience: d.audience, ok: r.ok });
  }
  return results;
};

const summary = (live: boolean, results: { ok: boolean }[], extra: Row = {}) =>
  json({ data: { live, sent: results.filter((r) => r.ok).length, total: results.length, ...extra } });

const handlePlaced = async (deps: MarketNotifyDeps, live: boolean, body: Row): Promise<Response> => {
  const checkoutId = str(body.checkout_id);
  const token = str(body.token);
  if (!UUID_RE.test(checkoutId) || !TOKEN_RE.test(token)) return json({ message: "checkout_id 或 token 格式不對" }, 400);

  const orders = await many(deps.db.from("market_orders").select(ORDER_COLUMNS).eq("checkout_id", checkoutId));
  if (orders.length === 0) return json({ message: "order not found" }, 404);
  const hash = await sha256Hex(token);
  if (orders.some((o) => o.lookup_token_hash !== hash)) {
    deps.log("error", { fn: "market-notify", step: "placed", checkout_id: checkoutId, error: "token mismatch" });
    return json({ message: "token mismatch" }, 403);
  }

  const first = orders[0];
  const email = str(first.buyer_email);
  if (!isDeliverableEmail(email)) return json({ data: { skipped: true, reason: "buyer email not deliverable" } });

  const loaded = await Promise.all(orders.map((o) => loadMailOrder(deps.db, o)));
  const mailOrders = loaded.map((l) => l.mail).sort((a, b) => a.storeName.localeCompare(b.storeName, "zh-Hant"));
  const mail = placedMail({
    buyerName: str(first.buyer_name),
    orders: mailOrders,
    lookupUrl: `${deps.config.siteUrl}/market/orders/${token}`,
  });
  const results = await deliver(
    deps,
    live,
    { email, audience: "consumer" },
    mail,
    `零售下單確認:${mailOrders.map((o) => orderLabel(o.id)).join("、")}`,
    null,
  );
  return summary(live, results, { orders: mailOrders.length });
};

const handleEvent = async (deps: MarketNotifyDeps, live: boolean, body: Row): Promise<Response> => {
  const eventId = str(body.event_id);
  if (!UUID_RE.test(eventId)) return json({ message: "event_id 格式不對" }, 400);

  const ev = await one(deps.db.from("market_order_events").select(EVENT_COLUMNS).eq("id", eventId).maybeSingle());
  if (!ev) return json({ message: "event not found" }, 404);
  const order = await one(deps.db.from("market_orders").select(ORDER_COLUMNS).eq("id", ev.order_id).maybeSingle());
  if (!order) return json({ message: "order not found" }, 404);

  const toStatus = str(ev.to_status);
  const kinds = resolveEventMails({
    toStatus,
    actorRole: ev.actor_role === null || ev.actor_role === undefined ? null : str(ev.actor_role),
    paymentMethod: str(order.payment_method),
  });
  if (kinds.length === 0) return json({ data: { skipped: true, reason: `no mail for ${toStatus}` } });

  const { mail: mailOrder, supplier } = await loadMailOrder(deps.db, order);
  const transfer = kinds.includes("consumer_awaiting_payment")
    ? await one(deps.db.from("market_store_transfer").select("transfer_info").eq("supplier_id", order.supplier_id).maybeSingle())
    : null;
  const payload = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Row;
  const ctx: EventContext = {
    order: mailOrder,
    buyerName: str(order.buyer_name),
    shipCity: str(order.ship_city),
    shipAddress: str(order.ship_address),
    buyerNote: order.buyer_note === null || order.buyer_note === undefined ? null : str(order.buyer_note),
    reason: str(ev.note).trim(),
    carrier: str(payload.carrier),
    trackingNo: str(payload.tracking_no),
    transferInfo: str(transfer?.transfer_info),
    supplierOrdersUrl: `${deps.config.siteUrl}/supplier/market/orders`,
  };

  const supplierEmail = str(supplier?.contact_email);
  const results: (DeliveryResult & { kind: EventMailKind })[] = [];
  const skipped: EventMailKind[] = [];
  for (const kind of kinds) {
    const audience: MarketAudience = kind.startsWith("supplier_") ? "supplier" : "consumer";
    const email = audience === "supplier" ? supplierEmail : str(order.buyer_email);
    if (!isDeliverableEmail(email)) {
      deps.log("error", { fn: "market-notify", step: "event", event_id: eventId, kind, error: "no deliverable email" });
      skipped.push(kind);
      continue;
    }
    const replyTo = audience === "consumer" && isDeliverableEmail(supplierEmail) ? supplierEmail : null;
    const sent = await deliver(deps, live, { email, audience }, renderEventMail(kind, ctx), `${orderLabel(mailOrder.id)} → ${toStatus}`, replyTo);
    results.push(...sent.map((r) => ({ ...r, kind })));
  }
  return summary(live, results, { kinds, skipped });
};

export const createMarketNotifyHandler =
  (deps: MarketNotifyDeps) =>
  async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ message: "Method not allowed" }, 405);
    if (!deps.secret) return json({ message: "NOTIFY_SECRET 未設定" }, 503);
    if ((req.headers.get("authorization") ?? "") !== `Bearer ${deps.secret}`) return json({ message: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => null)) as Row | null;
    const live = deps.isLive();
    try {
      if (body?.kind === "placed") return await handlePlaced(deps, live, body);
      if (body?.kind === "event") return await handleEvent(deps, live, body);
      return json({ message: "kind 必須是 placed 或 event" }, 400);
    } catch (e) {
      deps.log("error", { fn: "market-notify", step: str(body?.kind), error: e instanceof Error ? e.message : "unknown error" });
      return json({ message: "internal error" }, 500);
    }
  };
```

`supabase/functions/market-notify/index.ts`(Deno 入口,vitest 不測;部署時才會被打包):

```ts
// Edge Function:零售市集訂單通知(下單確認、新訂單、接單 / 待匯款 / 拒單 / 出貨 / 取消)。
// 由資料庫透過 pg_net 呼叫(migration 20261009130100 的 market_enqueue_notify);邏輯全在 handler.ts(vitest 測)。
//
// 部署(🔴 一定要 --no-verify-jwt:資料庫沒有使用者 JWT,改用共享密鑰 NOTIFY_SECRET 驗證;見 supabase/config.toml):
//   supabase functions deploy market-notify --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
//
// 讀的 secret(全部是既有的,不用新增):SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY(平台自動提供)、
//   NOTIFY_SECRET、RESEND_API_KEY、NOTIFY_FROM、SITE_URL、SUPPLIER_MAIL_REPLY_TO / LEAD_NOTIFY_TO。
// 🔴 MARKET_NOTIFY_LIVE 不是 "true" 時所有信只寄 ifoodmaptw@gmail.com、主旨加「[測試轉寄]」。
//    寄給真實消費者要業主核准 —— 不要自己設定這個 secret。
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, defaultLog } from "../_shared/db.ts";
import { createResendSender, mailConfigFromEnv } from "../_shared/supplier-mail.ts";
import { isLive } from "./gate.ts";
import { createMarketNotifyHandler } from "./handler.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const config = mailConfigFromEnv((k) => Deno.env.get(k));

Deno.serve(
  createMarketNotifyHandler({
    db: db as unknown as Db,
    send: createResendSender(config.resendKey),
    config,
    secret: Deno.env.get("NOTIFY_SECRET") ?? "",
    isLive: () => isLive(Deno.env.get("MARKET_NOTIFY_LIVE")),
    log: defaultLog,
  }),
);
```

`supabase/config.toml` 檔尾加:

在 `supabase/config.toml` 找到:

```toml
[functions.invite-restaurant-member]
verify_jwt = true
```

換成:

```toml
[functions.invite-restaurant-member]
verify_jwt = true

# 零售市集訂單通知:DB(pg_net)呼叫,靠 NOTIFY_SECRET 共享密鑰驗證(跟 notify 同一把)
[functions.market-notify]
verify_jwt = false
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run supabase/functions/market-notify/`

Expected:`Tests  30 passed (30)`(gate 5 + render 8 + handler 17)。再跑 `cd /Users/aimand/.gemini/File/ifoodmap && npx eslint supabase/functions/market-notify/`,Expected:沒有任何輸出(0 error、0 warning)。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/functions/market-notify/handler.ts supabase/functions/market-notify/handler.test.ts supabase/functions/market-notify/index.ts supabase/config.toml
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): Edge Function market-notify(共享密鑰驗證、token 雜湊比對、閘門、寄信紀錄)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 43:訂單狀態、按鈕、查詢與寫入 `orders.ts`

- `ORDER_STATUSES` / `ORDER_STATUS_LABEL` / `MARKET_TRANSITIONS`:測試解析 migration 130000 的標記與 `market_order_status_label()` 逐字比對(供應商、管理員、系統三份都要跟前端這份一樣)。
- `supplierActions()`:轉帳接單後資料庫自動轉待匯款,所以沒有「改成待匯款」的按鈕;待接單時用「拒單」,不另外給「取消」。`adminActions()`:管理員只做「平台取消」。
- `validateOrderAction()`(跟 guard 同一套)、`addOrderEvent()`(帶畫面上的狀態當 `from_status`;不送 actor)、`fetchSupplierOrders()`、`fetchAdminOrders(篩選)`。
- `constants.ts` 的 `LIMITS` 補上訂單相關上限。

**Files:**
- Modify: `src/lib/market/constants.ts`(`LIMITS` 最後)
- Create: `src/lib/market/orders.ts`
- Test: `src/lib/market/orders.test.ts`

**Step 1:寫失敗的測試**

```ts
// orders.ts:狀態、中文、轉移表跟 migration 一字不差;各角色的按鈕;送出前檢查;寫入的內容。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]> }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const b = {
        select: () => b,
        insert: (v: unknown) => {
          call.op = "insert";
          call.payload = v;
          return b;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push(["eq", c, v]);
          return b;
        },
        in: (c: string, v: unknown) => {
          call.filters.push(["in", c, v]);
          return b;
        },
        order: () => b,
        limit: () => b,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
      };
      return b;
    },
  },
}));

import {
  addOrderEvent,
  adminActions,
  fetchAdminOrders,
  MARKET_TRANSITIONS,
  ORDER_STATUS_LABEL,
  ORDER_STATUSES,
  supplierActions,
  validateOrderAction,
} from "./orders";

const MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130000_market_orders.sql"), "utf8");
const block = (name: string) => {
  const m = MIGRATION.match(new RegExp(`-- @market-${name}-begin([\\s\\S]*?)-- @market-${name}-end`));
  if (!m) throw new Error(`migration 少了 @market-${name} 標記`);
  return m[1];
};

beforeEach(() => {
  calls.length = 0;
});

describe("跟 migration 一致", () => {
  it("狀態清單", () => {
    expect([...block("statuses").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...ORDER_STATUSES]);
  });

  it("狀態中文(market_order_status_label)", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.market_order_status_label"));
    const labels = Object.fromEntries([...fn.slice(0, fn.indexOf("$$;")).matchAll(/WHEN '([a-z_]+)' THEN '([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(labels).toEqual(ORDER_STATUS_LABEL);
  });

  it("轉移表:供應商、管理員、系統三份都跟前端這份一樣", () => {
    const rows = [...block("transitions").matchAll(/\('([a-z]+)', '([a-z_]+)', '([a-z_]+)', '([a-z]+)'\)/g)].map((m) => ({
      actor: m[1],
      from: m[2],
      to: m[3],
      payment: m[4],
    }));
    expect(rows).toHaveLength(MARKET_TRANSITIONS.length * 3);
    for (const actor of ["supplier", "admin", "system"]) {
      expect(rows.filter((r) => r.actor === actor).map(({ from, to, payment }) => ({ from, to, payment }))).toEqual([...MARKET_TRANSITIONS]);
    }
  });
});

describe("按鈕", () => {
  it("供應商:貨到付款 待接單 → 接單 / 拒單;已接單 → 出貨 / 取消;已出貨 → 完成", () => {
    expect(supplierActions({ status: "pending", payment_method: "cod" })).toEqual(["confirmed", "rejected"]);
    expect(supplierActions({ status: "confirmed", payment_method: "cod" })).toEqual(["shipped", "cancelled"]);
    expect(supplierActions({ status: "shipped", payment_method: "cod" })).toEqual(["completed"]);
    expect(supplierActions({ status: "completed", payment_method: "cod" })).toEqual([]);
  });

  it("供應商:轉帳 待匯款 → 確認已收款 / 取消;已收款 → 出貨;沒有「改成待匯款」的按鈕", () => {
    expect(supplierActions({ status: "confirmed", payment_method: "transfer" })).toEqual(["cancelled"]);
    expect(supplierActions({ status: "awaiting_payment", payment_method: "transfer" })).toEqual(["paid", "cancelled"]);
    expect(supplierActions({ status: "paid", payment_method: "transfer" })).toEqual(["shipped"]);
  });

  it("管理員只能平台取消(出貨後不能取消)", () => {
    expect(adminActions({ status: "pending", payment_method: "cod" })).toEqual(["cancelled"]);
    expect(adminActions({ status: "awaiting_payment", payment_method: "transfer" })).toEqual(["cancelled"]);
    expect(adminActions({ status: "shipped", payment_method: "cod" })).toEqual([]);
  });
});

describe("validateOrderAction", () => {
  it("拒單、取消要原因;出貨要物流;長度上限", () => {
    expect(validateOrderAction("rejected", {})).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("cancelled", { reason: "  " })).toBe("請填寫原因(會告知消費者)");
    expect(validateOrderAction("rejected", { reason: "缺貨" })).toBeNull();
    expect(validateOrderAction("rejected", { reason: "字".repeat(301) })).toBe("原因最多 300 字");
    expect(validateOrderAction("shipped", {})).toBe("請填寫物流(例如:黑貓宅急便、自行配送)");
    expect(validateOrderAction("shipped", { carrier: "黑貓", trackingNo: "1".repeat(101) })).toBe("物流單號最多 100 字");
    expect(validateOrderAction("shipped", { carrier: "黑貓" })).toBeNull();
    expect(validateOrderAction("confirmed", {})).toBeNull();
  });
});

describe("寫入與查詢", () => {
  it("接單:新增一筆紀錄,帶畫面上的狀態;不送 actor", async () => {
    await addOrderEvent({ id: "o1", status: "pending" }, "confirmed");
    expect(calls[0]).toMatchObject({
      table: "market_order_events",
      op: "insert",
      payload: { order_id: "o1", from_status: "pending", to_status: "confirmed", note: null, payload: {} },
    });
    expect(calls[0].payload).not.toHaveProperty("actor_role");
  });

  it("出貨帶物流與單號(去頭尾空白;沒單號就不送);拒單帶原因", async () => {
    await addOrderEvent({ id: "o1", status: "confirmed" }, "shipped", { carrier: " 黑貓 ", trackingNo: " 9001 " });
    expect(calls[0].payload).toMatchObject({ payload: { carrier: "黑貓", tracking_no: "9001" } });
    await addOrderEvent({ id: "o1", status: "confirmed" }, "shipped", { carrier: "自行配送", trackingNo: "" });
    expect(calls[1].payload).toMatchObject({ payload: { carrier: "自行配送" } });
    await addOrderEvent({ id: "o2", status: "pending" }, "rejected", { reason: " 缺貨 " });
    expect(calls[2].payload).toMatchObject({ note: "缺貨", payload: {} });
  });

  it("管理員總覽的篩選", async () => {
    await fetchAdminOrders("open");
    expect(calls[0].filters).toEqual([["in", "status", ["pending", "confirmed", "awaiting_payment", "paid"]]]);
    await fetchAdminOrders("all");
    expect(calls[1].filters).toEqual([]);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/orders.test.ts`

Expected:FAIL,`Failed to resolve import "./orders"`

**Step 3:寫實作**

`src/lib/market/constants.ts`:

在 `src/lib/market/constants.ts` 找到:

```ts
  minOrderAmount: 1_000_000,
  shipDays: 30,
} as const;

```

換成:

```ts
  minOrderAmount: 1_000_000,
  shipDays: 30,
  // 訂單(20261009130000_market_orders.sql、20261009130200_market_checkout.sql)
  buyerName: 50,
  addressMin: 5,
  address: 200,
  buyerNote: 300,
  orderNote: 300,
  carrier: 50,
  trackingNo: 100,
} as const;

```

`src/lib/market/orders.ts`:

```ts
// 零售訂單:狀態、各角色能按的動作、供應商 / 管理員的查詢與寫入。
//
// 🔴 狀態與轉移表的唯一來源是 supabase/migrations/20261009130000_market_orders.sql
//    (market_orders 的 status CHECK、market_transition_rules()、market_order_status_label());
//    orders.test.ts 解析 @market-statuses / @market-transitions 標記比對,改一邊一定要改另一邊。
// 狀態只能經 market_order_events 改變:前端只「新增一筆紀錄」,資料庫的 guard 再檢查身分、目前狀態(畫面過期會擋)、原因、物流。
import { LIMITS, type PaymentMethod, type Temperature, type TwCity } from "./constants";
import { marketDb, unwrap } from "./db";

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "awaiting_payment",
  "paid",
  "shipped",
  "completed",
  "rejected",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "待接單",
  confirmed: "已接單",
  awaiting_payment: "待匯款",
  paid: "已收款",
  shipped: "已出貨",
  completed: "已完成",
  rejected: "已拒單",
  cancelled: "已取消",
};

/** 還要有人處理的狀態(供應商「待處理」、管理員「進行中」) */
export const OPEN_STATUSES: readonly OrderStatus[] = ["pending", "confirmed", "awaiting_payment", "paid"];

/** 供應商、管理員、系統共用的轉移表;payment = 只限哪一種付款方式 */
export const MARKET_TRANSITIONS: ReadonlyArray<{ from: OrderStatus; to: OrderStatus; payment: "any" | PaymentMethod }> = [
  { from: "pending", to: "confirmed", payment: "any" },
  { from: "pending", to: "rejected", payment: "any" },
  { from: "pending", to: "cancelled", payment: "any" },
  { from: "confirmed", to: "awaiting_payment", payment: "transfer" },
  { from: "confirmed", to: "shipped", payment: "cod" },
  { from: "confirmed", to: "cancelled", payment: "any" },
  { from: "awaiting_payment", to: "paid", payment: "transfer" },
  { from: "awaiting_payment", to: "cancelled", payment: "transfer" },
  { from: "paid", to: "shipped", payment: "transfer" },
  { from: "shipped", to: "completed", payment: "any" },
];

export interface OrderActionMeta {
  label: string;
  needsReason: boolean;
  needsCarrier: boolean;
  danger: boolean;
}

/** 按鈕文字與要填的東西(key = 目標狀態;awaiting_payment 是資料庫自動轉的,沒有按鈕) */
export const ORDER_ACTIONS: Partial<Record<OrderStatus, OrderActionMeta>> = {
  confirmed: { label: "接單", needsReason: false, needsCarrier: false, danger: false },
  rejected: { label: "拒單", needsReason: true, needsCarrier: false, danger: true },
  paid: { label: "確認已收款", needsReason: false, needsCarrier: false, danger: false },
  shipped: { label: "出貨", needsReason: false, needsCarrier: true, danger: false },
  completed: { label: "標記完成", needsReason: false, needsCarrier: false, danger: false },
  cancelled: { label: "取消訂單", needsReason: true, needsCarrier: false, danger: true },
};

export interface MarketOrderItemRow {
  product_name: string;
  spec: string;
  temperature: Temperature;
  unit_price: number;
  qty: number;
  line_total: number;
}

export interface MarketOrderEventRow {
  to_status: OrderStatus;
  actor_role: "consumer" | "supplier" | "admin" | "system";
  note: string | null;
  created_at: string;
}

export interface MarketOrderRow {
  id: string;
  checkout_id: string;
  supplier_id: string;
  status: OrderStatus;
  buyer_name: string;
  buyer_phone: string;
  buyer_email: string;
  ship_city: TwCity;
  ship_address: string;
  buyer_note: string | null;
  subtotal: number;
  shipping_fee: number;
  total: number;
  payment_method: PaymentMethod;
  status_note: string | null;
  shipped_carrier: string | null;
  shipped_tracking_no: string | null;
  created_at: string;
  updated_at: string;
  market_order_items: MarketOrderItemRow[];
  /** 只有管理員的查詢會帶 */
  market_stores?: { suppliers: { name: string } | null } | null;
  market_order_events?: MarketOrderEventRow[];
}

const allowedTargets = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  MARKET_TRANSITIONS.filter((t) => t.from === o.status && (t.payment === "any" || t.payment === o.payment_method)).map((t) => t.to);

/** 供應商後台的按鈕:轉帳訂單接單後資料庫自動轉成「待匯款」(不給按);待接單時用「拒單」,不另外給「取消」 */
export const supplierActions = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  allowedTargets(o).filter((to) => to !== "awaiting_payment" && !(o.status === "pending" && to === "cancelled"));

/** 管理員(處理客訴)只做「平台取消」;接單、出貨都是店家的事 */
export const adminActions = (o: Pick<MarketOrderRow, "status" | "payment_method">): OrderStatus[] =>
  allowedTargets(o).filter((to) => to === "cancelled");

export interface OrderActionInput {
  reason?: string;
  carrier?: string;
  trackingNo?: string;
}

/** 送出前的檢查(跟 guard 同一套);回傳錯誤訊息或 null */
export const validateOrderAction = (to: OrderStatus, input: OrderActionInput): string | null => {
  const meta = ORDER_ACTIONS[to];
  const reason = (input.reason ?? "").trim();
  const carrier = (input.carrier ?? "").trim();
  const tracking = (input.trackingNo ?? "").trim();
  if (meta?.needsReason && !reason) return "請填寫原因(會告知消費者)";
  if (reason.length > LIMITS.orderNote) return `原因最多 ${LIMITS.orderNote} 字`;
  if (meta?.needsCarrier && !carrier) return "請填寫物流(例如:黑貓宅急便、自行配送)";
  if (carrier.length > LIMITS.carrier) return `物流最多 ${LIMITS.carrier} 字`;
  if (tracking.length > LIMITS.trackingNo) return `物流單號最多 ${LIMITS.trackingNo} 字`;
  return null;
};

export const ORDER_COLUMNS =
  "id, checkout_id, supplier_id, status, buyer_name, buyer_phone, buyer_email, ship_city, ship_address, buyer_note, " +
  "subtotal, shipping_fee, total, payment_method, status_note, shipped_carrier, shipped_tracking_no, created_at, updated_at, " +
  "market_order_items(product_name, spec, temperature, unit_price, qty, line_total)";

const ADMIN_ORDER_COLUMNS = `${ORDER_COLUMNS}, market_stores(suppliers(name)), market_order_events(to_status, actor_role, note, created_at)`;

/** 一次最多抓幾張(訂單多到這個數字時要加分頁 —— 見計畫「風險」) */
export const ORDER_LIST_LIMIT = 200;

export const fetchSupplierOrders = async (supplierId: string): Promise<MarketOrderRow[]> =>
  unwrap(
    await marketDb<MarketOrderRow[]>("market_orders")
      .select(ORDER_COLUMNS)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false })
      .limit(ORDER_LIST_LIMIT),
  );

export type AdminOrderFilter = "open" | "shipped" | "closed" | "all";

export const fetchAdminOrders = async (filter: AdminOrderFilter): Promise<MarketOrderRow[]> => {
  let q = marketDb<MarketOrderRow[]>("market_orders").select(ADMIN_ORDER_COLUMNS);
  if (filter === "open") q = q.in("status", OPEN_STATUSES);
  if (filter === "shipped") q = q.eq("status", "shipped");
  if (filter === "closed") q = q.in("status", ["completed", "rejected", "cancelled"]);
  return unwrap(await q.order("created_at", { ascending: false }).limit(ORDER_LIST_LIMIT));
};

/**
 * 改訂單狀態 = 新增一筆紀錄。from_status 帶畫面上的狀態:別人剛處理過時資料庫回 stale_order_status(friendlyDbError 會翻成中文)。
 * actor_role / actor_id 前端不送,資料庫依登入身分決定。
 */
export const addOrderEvent = async (
  order: Pick<MarketOrderRow, "id" | "status">,
  to: OrderStatus,
  input: OrderActionInput = {},
): Promise<void> => {
  const carrier = (input.carrier ?? "").trim();
  const tracking = (input.trackingNo ?? "").trim();
  const payload: Record<string, string> = {};
  if (to === "shipped") {
    payload.carrier = carrier;
    if (tracking) payload.tracking_no = tracking;
  }
  unwrap(
    await marketDb<null>("market_order_events").insert({
      order_id: order.id,
      from_status: order.status,
      to_status: to,
      note: (input.reason ?? "").trim() || null,
      payload,
    }),
  );
};
```

**Step 4:跑測試,確認通過**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/orders.test.ts src/lib/market/constants.test.ts`

Expected:`Tests  15 passed (15)`(orders 10 + constants 5)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/constants.ts src/lib/market/orders.ts src/lib/market/orders.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 零售訂單狀態、各角色按鈕、查詢與寫入(轉移表對照 migration)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 44:購物車邏輯 `cart.ts`(分組、運費、免運、最低金額)+ 依 id 重抓商品

- 瀏覽器只存 `[{productId, qty}]`;`parseCart` 把 localStorage 讀回來的東西清乾淨(壞 JSON、重複、非 uuid、數量夾在 1–99、最多 50 種)。
- `buildCart(購物車, 剛查到的商品, 收件縣市?)`:按店家分組(照第一次加入的順序),每組小計、運費(小計 ≥ 免運門檻 → 0,跟資料庫一樣)、總額、再買多少免運、還差多少到最低金額、配送縣市、超過庫存;下架 / 找不到的商品另外放 `unavailable`。
- `catalog.ts` 加 `fetchProductsByIds()`(購物車與結帳每次都重抓,價格永遠是最新的;不篩可見性,交給 `buildCart` 標「已下架」)。

**Files:**
- Create: `src/lib/market/cart.ts`
- Modify: `src/lib/market/catalog.ts`(「首頁篩選」那一節前面)
- Test: `src/lib/market/cart.test.ts`、`src/lib/market/catalog.test.ts`

**Step 1:寫失敗的測試**

`src/lib/market/cart.test.ts`:

```ts
// cart.ts:按店家分組、運費、免運、最低訂購金額、配送縣市、庫存、下架商品、localStorage 資料清洗。
// 金額跟資料庫測試同一組(market_checkout.test.sql):A 店 200+450+運費 120 = 770;B 店 200+運費 60 = 260。
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { addLine, buildCart, CART_LIMITS, cartCount, isCartFull, parseCart, removeLines, setLineQty, shippingFeeFor } from "./cart";
import { BEEF, CABBAGE, SALMON, STORE_A, STORE_B } from "./testFixtures";

const ALL = [CABBAGE, BEEF, SALMON];
const line = (productId: string, qty: number) => ({ productId, qty });
const uuid = (n: number) => `a9300000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("分組", () => {
  it("按店家分組,店家照第一次加入的順序;同店的商品放一起", () => {
    const { groups, unavailable } = buildCart([line(CABBAGE.id, 2), line(SALMON.id, 1), line(BEEF.id, 1)], ALL);
    expect(groups.map((g) => g.storeName)).toEqual(["市集測試 A 店", "市集測試 B 店"]);
    expect(groups[0].lines.map((l) => l.product.name)).toEqual(["有機高麗菜", "牛肉片"]);
    expect(groups[1].lines.map((l) => [l.product.name, l.lineTotal])).toEqual([["挪威鮭魚", 200]]);
    expect(unavailable).toEqual([]);
  });

  it("小計、運費、總額(跟資料庫算的一樣:770 / 260)", () => {
    const { groups } = buildCart([line(CABBAGE.id, 2), line(BEEF.id, 1), line(SALMON.id, 1)], ALL);
    expect(groups.map((g) => [g.subtotal, g.shippingFee, g.total])).toEqual([
      [650, 120, 770],
      [200, 60, 260],
    ]);
  });
});

describe("運費與免運", () => {
  it("剛好達到免運門檻就免運(≥),差多少顯示出來", () => {
    expect(shippingFeeFor(STORE_A, 999)).toBe(120);
    expect(shippingFeeFor(STORE_A, 1000)).toBe(0);
    const [a] = buildCart([line(CABBAGE.id, 10)], ALL).groups;
    expect([a.subtotal, a.shippingFee, a.total, a.freeShippingRemaining]).toEqual([1000, 0, 1000, null]);
    const [a2] = buildCart([line(CABBAGE.id, 7)], ALL).groups;
    expect(a2.freeShippingRemaining).toBe(300);
  });

  it("沒有免運門檻的店:永遠收運費,不顯示「再買多少免運」", () => {
    expect(shippingFeeFor(STORE_B, 100000)).toBe(60);
    expect(buildCart([line(SALMON.id, 3)], ALL).groups[0].freeShippingRemaining).toBeNull();
  });

  it("運費 0 的店:免運", () => {
    expect(shippingFeeFor({ shipping_fee: 0, free_shipping_threshold: null }, 50)).toBe(0);
  });
});

describe("最低訂購金額", () => {
  it("沒到最低金額:差多少、不能結帳", () => {
    const [a] = buildCart([line(CABBAGE.id, 2)], ALL).groups;
    expect(a.minimumShort).toBe(100);
    expect(a.canCheckout).toBe(false);
    expect(a.problems).toEqual(["還差 NT$ 100 才到這家店的最低訂購金額 NT$ 300"]);
  });

  it("剛好等於最低金額可以結帳;沒有最低金額的店不檢查", () => {
    expect(buildCart([line(CABBAGE.id, 3)], ALL).groups[0]).toMatchObject({ minimumShort: 0, canCheckout: true });
    expect(buildCart([line(SALMON.id, 1)], ALL).groups[0]).toMatchObject({ minimumShort: 0, canCheckout: true });
  });
});

describe("配送縣市", () => {
  it("沒選縣市不檢查;選了就標出不配送的店", () => {
    const lines = [line(CABBAGE.id, 3), line(SALMON.id, 1)];
    expect(buildCart(lines, ALL).groups.map((g) => g.deliverable)).toEqual([null, null]);
    const newTaipei = buildCart(lines, ALL, "新北市").groups;
    expect(newTaipei.map((g) => [g.deliverable, g.canCheckout])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(newTaipei[1].problems).toEqual(["這家店不配送到新北市"]);
  });
});

describe("庫存與下架", () => {
  it("超過庫存:標出來、這家店不能結帳;上限 = 庫存", () => {
    const [b] = buildCart([line(SALMON.id, 5)], ALL).groups;
    expect(b.lines[0]).toMatchObject({ overStock: true, maxQty: 3 });
    expect(b.canCheckout).toBe(false);
    expect(b.problems).toEqual(["有商品超過庫存,請減少數量或移除"]);
  });

  it("售完(庫存 0)也算超過庫存", () => {
    const [b] = buildCart([line(SALMON.id, 1)], [{ ...SALMON, stock: 0 }]).groups;
    expect(b.lines[0]).toMatchObject({ overStock: true, maxQty: 0 });
  });

  it("找不到、沒核准、下架、店家停用的商品放到 unavailable,不算進任何一家店", () => {
    const view = buildCart(
      [line(uuid(999), 1), line(CABBAGE.id, 3), line(BEEF.id, 1), line(SALMON.id, 1)],
      [CABBAGE, { ...BEEF, review_status: "pending" }, { ...SALMON, market_stores: { ...STORE_B, is_enabled: false } }],
    );
    expect(view.unavailable.map((l) => l.productId)).toEqual([uuid(999), BEEF.id, SALMON.id]);
    expect(view.groups.map((g) => g.subtotal)).toEqual([300]);
  });
});

describe("購物車內容(存在 localStorage 的那份)", () => {
  it("壞掉的資料讀回來是空的;不合格的項目丟掉、重複的只留第一筆、數量夾在 1–99", () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart("{not json")).toEqual([]);
    expect(parseCart('{"a":1}')).toEqual([]);
    expect(
      parseCart(
        JSON.stringify([
          { productId: CABBAGE.id, qty: 2 },
          { productId: "not-a-uuid", qty: 1 },
          { productId: CABBAGE.id, qty: 5 },
          { productId: BEEF.id, qty: 500 },
          { productId: SALMON.id, qty: -3 },
          { productId: uuid(77), qty: "2" },
          null,
        ]),
      ),
    ).toEqual([line(CABBAGE.id, 2), line(BEEF.id, 99), line(SALMON.id, 1)]);
  });

  it("最多 50 種商品", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ productId: uuid(i + 1), qty: 1 }));
    expect(parseCart(JSON.stringify(many))).toHaveLength(CART_LIMITS.maxLines);
  });

  it("加入:同商品合併、不超過庫存;滿 50 種就加不進新商品", () => {
    let lines = addLine([], CABBAGE.id, 2, 10);
    lines = addLine(lines, CABBAGE.id, 9, 10);
    expect(lines).toEqual([line(CABBAGE.id, 10)]);
    const full = Array.from({ length: 50 }, (_, i) => line(uuid(i + 1), 1));
    expect(isCartFull(full, BEEF.id)).toBe(true);
    expect(isCartFull(full, uuid(1))).toBe(false);
    expect(addLine(full, BEEF.id, 1)).toBe(full);
  });

  it("改數量夾在 1 到上限;移除;數量加總", () => {
    const lines = [line(CABBAGE.id, 2), line(BEEF.id, 1)];
    expect(setLineQty(lines, CABBAGE.id, 0)).toEqual([line(CABBAGE.id, 1), line(BEEF.id, 1)]);
    expect(setLineQty(lines, CABBAGE.id, 50, 10)).toEqual([line(CABBAGE.id, 10), line(BEEF.id, 1)]);
    expect(removeLines(lines, [CABBAGE.id])).toEqual([line(BEEF.id, 1)]);
    expect(cartCount(lines)).toBe(3);
  });
});
```

`src/lib/market/catalog.test.ts`(假 builder 多一個 `in`、import 新函式、加一個測試):

在 `src/lib/market/catalog.test.ts` 找到:

```ts
          return builder;
        },
        order: (c: string, o: { ascending: boolean }) => {
          call.filters.push(["order", c, o.ascending]);
```

換成:

```ts
          return builder;
        },
        in: (c: string, v: unknown) => {
          call.filters.push(["in", c, v]);
          return builder;
        },
        order: (c: string, o: { ascending: boolean }) => {
          call.filters.push(["order", c, o.ascending]);
```

在 `src/lib/market/catalog.test.ts` 找到:

```ts
  fetchListedProducts,
  fetchMarketProduct,
  fetchStoreProducts,
  filterProducts,
```

換成:

```ts
  fetchListedProducts,
  fetchMarketProduct,
  fetchProductsByIds,
  fetchStoreProducts,
  filterProducts,
```

在 `src/lib/market/catalog.test.ts` 找到:

```ts
    await fetchStoreProducts(SUPPLIER_A);
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "supplier_id", SUPPLIER_A]]));
  });
});
```

換成:

```ts
    await fetchStoreProducts(SUPPLIER_A);
    expect(calls[0].filters).toEqual(expect.arrayContaining([["eq", "supplier_id", SUPPLIER_A]]));
  });

  it("購物車:依 id 重新抓(去重、丟掉不是 uuid 的;不篩可見性);一個都沒有就不查", async () => {
    rows.value = [CABBAGE, { ...BEEF, review_status: "pending" }];
    const list = await fetchProductsByIds([CABBAGE.id, CABBAGE.id, "abc", BEEF.id]);
    expect(calls[0].filters).toEqual([["in", "id", [CABBAGE.id, BEEF.id]]]);
    expect(calls[0].select).toContain("market_stores(");
    expect(list).toHaveLength(2);
    await expect(fetchProductsByIds(["abc"])).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/cart.test.ts src/lib/market/catalog.test.ts`

Expected:`cart.test.ts` FAIL `Failed to resolve import "./cart"`;`catalog.test.ts` 1 failed(`TypeError: fetchProductsByIds is not a function`)、9 passed。

**Step 3:寫實作**

`src/lib/market/catalog.ts`:

在 `src/lib/market/catalog.ts` 找到:

```ts
      .order("created_at", { ascending: false }),
  ).filter(isPubliclyVisible);
};

```

換成:

```ts
      .order("created_at", { ascending: false }),
  ).filter(isPubliclyVisible);
};

/**
 * 購物車、結帳用:依 id 重新抓商品(最新的價格、庫存、店家條件)。不篩可見性 —— 下架的交給 buildCart 標成「已下架」。
 * 不是 uuid 的 id 丟掉;一個都沒有就不查。
 */
export const fetchProductsByIds = async (ids: readonly string[]): Promise<MarketProductRow[]> => {
  const valid = [...new Set(ids)].filter(isUuid);
  if (valid.length === 0) return [];
  return unwrap(await marketDb<MarketProductRow[]>("market_products").select(PRODUCT_WITH_STORE).in("id", valid));
};

```

`src/lib/market/cart.ts`:

```ts
// 購物車:按店家分組、小計、運費、免運、最低訂購金額、配送縣市 —— 純函式,cart.test.ts 測。
//
// 瀏覽器只存 [{productId, qty}](localStorage,見 useCart.ts);價格、庫存、店家條件每次都重新跟資料庫拿,
// 所以購物車裡永遠是最新的價格。運費規則跟 market_place_order 一樣:小計 ≥ 免運門檻 → 0,否則店家的固定運費。
// 🔴 這裡算的金額只是給人看的;真正收多少由資料庫重算(結帳時送 expected_totals,不一樣就回 PRICE_CHANGED)。
import { isPubliclyVisible } from "./catalog";
import type { TwCity } from "./constants";
import { isUuid } from "./db";
import { formatTwd } from "./format";
import type { MarketProductRow, MarketStoreRow } from "./types";

export interface CartLine {
  productId: string;
  qty: number;
}

/** 跟 market_place_order 的上限一樣:每項最多 99 件、最多 50 種商品、一次最多 10 家店 */
export const CART_LIMITS = { maxQty: 99, maxLines: 50, maxStores: 10 } as const;

export const CART_STORAGE_KEY = "ifoodmap-market-cart-v1";

const clampQty = (qty: number, max: number): number => Math.max(1, Math.min(Math.floor(qty) || 1, max));

/** 這個商品最多能買幾件(庫存與 99 取小的;售完 = 0) */
export const maxQtyFor = (product: Pick<MarketProductRow, "stock">): number =>
  product.stock === null ? CART_LIMITS.maxQty : Math.max(0, Math.min(product.stock, CART_LIMITS.maxQty));

/** localStorage 讀回來的字串 → 購物車;壞掉的資料、重複的商品、超過上限的一律丟掉 */
export const parseCart = (raw: string | null): CartLine[] => {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CartLine[] = [];
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const { productId, qty } = x as Record<string, unknown>;
    if (!isUuid(productId) || out.some((l) => l.productId === productId)) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty)) continue;
    out.push({ productId, qty: clampQty(qty, CART_LIMITS.maxQty) });
    if (out.length >= CART_LIMITS.maxLines) break;
  }
  return out;
};

export const isCartFull = (lines: CartLine[], productId: string): boolean =>
  !lines.some((l) => l.productId === productId) && lines.length >= CART_LIMITS.maxLines;

/** 加入購物車:同一個商品合併數量,不超過 max(庫存);購物車滿了就原封不動(畫面先用 isCartFull 擋) */
export const addLine = (lines: CartLine[], productId: string, qty: number, max: number = CART_LIMITS.maxQty): CartLine[] => {
  const cap = Math.max(1, Math.min(max, CART_LIMITS.maxQty));
  if (lines.some((l) => l.productId === productId)) {
    return lines.map((l) => (l.productId === productId ? { ...l, qty: clampQty(l.qty + qty, cap) } : l));
  }
  if (isCartFull(lines, productId)) return lines;
  return [...lines, { productId, qty: clampQty(qty, cap) }];
};

export const setLineQty = (lines: CartLine[], productId: string, qty: number, max: number = CART_LIMITS.maxQty): CartLine[] =>
  lines.map((l) => (l.productId === productId ? { ...l, qty: clampQty(qty, Math.max(1, Math.min(max, CART_LIMITS.maxQty))) } : l));

export const removeLines = (lines: CartLine[], productIds: Iterable<string>): CartLine[] => {
  const drop = new Set(productIds);
  return lines.filter((l) => !drop.has(l.productId));
};

/** 運費:小計達免運門檻就免運,否則店家的固定運費(跟 market_place_order 一樣) */
export const shippingFeeFor = (store: Pick<MarketStoreRow, "shipping_fee" | "free_shipping_threshold">, subtotal: number): number =>
  store.free_shipping_threshold !== null && subtotal >= store.free_shipping_threshold ? 0 : store.shipping_fee;

export interface CartGroupLine {
  product: MarketProductRow;
  qty: number;
  lineTotal: number;
  /** 最多能買幾件(數量選擇器的上限) */
  maxQty: number;
  /** 超過庫存 / 已售完:這家店要先改數量才能結帳 */
  overStock: boolean;
}

export interface CartGroup {
  supplierId: string;
  store: MarketStoreRow;
  storeName: string;
  lines: CartGroupLine[];
  subtotal: number;
  shippingFee: number;
  total: number;
  /** 再買多少就免運(沒有免運門檻、已經免運 → null) */
  freeShippingRemaining: number | null;
  /** 還差多少才到最低訂購金額(已達 → 0) */
  minimumShort: number;
  /** 選了收件縣市才知道(沒選 → null) */
  deliverable: boolean | null;
  /** 不能結帳的原因(給畫面看) */
  problems: string[];
  canCheckout: boolean;
}

export interface CartView {
  groups: CartGroup[];
  /** 已下架、店家停用、找不到的商品(畫面列出來讓人刪掉) */
  unavailable: CartLine[];
}

/**
 * 購物車 + 剛查到的商品 → 按店家分組(店家照第一次加入的順序)。
 * city:結帳頁選的收件縣市;購物車頁還沒選就傳 null(不檢查配送範圍)。
 */
export const buildCart = (lines: CartLine[], products: MarketProductRow[], city: TwCity | null = null): CartView => {
  const byId = new Map(products.map((p) => [p.id, p]));
  const groups = new Map<string, CartGroup>();
  const unavailable: CartLine[] = [];

  for (const line of lines) {
    const product = byId.get(line.productId);
    const store = product?.market_stores;
    if (!product || !store || !isPubliclyVisible(product)) {
      unavailable.push(line);
      continue;
    }
    let group = groups.get(product.supplier_id);
    if (!group) {
      group = {
        supplierId: product.supplier_id,
        store,
        storeName: store.suppliers?.name ?? "店家",
        lines: [],
        subtotal: 0,
        shippingFee: 0,
        total: 0,
        freeShippingRemaining: null,
        minimumShort: 0,
        deliverable: null,
        problems: [],
        canCheckout: false,
      };
      groups.set(product.supplier_id, group);
    }
    const maxQty = maxQtyFor(product);
    group.lines.push({ product, qty: line.qty, lineTotal: product.price * line.qty, maxQty, overStock: line.qty > maxQty });
  }

  for (const g of groups.values()) {
    g.subtotal = g.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    g.shippingFee = shippingFeeFor(g.store, g.subtotal);
    g.total = g.subtotal + g.shippingFee;
    g.freeShippingRemaining =
      g.store.free_shipping_threshold !== null && g.shippingFee > 0 ? g.store.free_shipping_threshold - g.subtotal : null;
    g.minimumShort = Math.max(0, g.store.min_order_amount - g.subtotal);
    g.deliverable = city ? g.store.delivery_cities.includes(city) : null;
    if (g.lines.some((l) => l.overStock)) g.problems.push("有商品超過庫存,請減少數量或移除");
    if (g.minimumShort > 0) {
      g.problems.push(`還差 ${formatTwd(g.minimumShort)} 才到這家店的最低訂購金額 ${formatTwd(g.store.min_order_amount)}`);
    }
    if (g.deliverable === false) g.problems.push(`這家店不配送到${city}`);
    g.canCheckout = g.problems.length === 0;
  }

  return { groups: [...groups.values()], unavailable };
};

/** react-query 的 key:購物車頁與結帳頁共用同一份商品資料(結帳失敗時 invalidate ["market", "cart-products"] 重抓) */
export const cartProductsKey = (ids: string[]) => ["market", "cart-products", [...ids].sort().join(",")] as const;

/** 購物車圖示上的數字:幾件商品(數量加總) */
export const cartCount = (lines: CartLine[]): number => lines.reduce((sum, l) => sum + l.qty, 0);
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  25 passed (25)`(cart 15 + catalog 10)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/cart.ts src/lib/market/cart.test.ts src/lib/market/catalog.ts src/lib/market/catalog.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 購物車按店家分組、運費 / 免運 / 最低金額計算,購物車商品依 id 重抓

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 45:購物車狀態 `useCart`(localStorage + 跨分頁同步)

`useSyncExternalStore` 訂閱;寫進 `localStorage`(key `ifoodmap-market-cart-v1`);別的分頁改了透過 `storage` 事件同步。🔴 無痕模式、封鎖網站資料時 localStorage 一碰就丟例外:讀不到當空的,寫不進去就只留在這個分頁的記憶體,頁面不能掛。

**Files:**
- Create: `src/lib/market/useCart.ts`
- Test: `src/lib/market/useCart.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// useCart:存進 localStorage、重新整理讀得回來、別的分頁改了會同步;localStorage 壞掉也不會讓頁面掛掉。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { CART_STORAGE_KEY } from "./cart";
import { BEEF, CABBAGE } from "./testFixtures";
import { cartStore, useCart } from "./useCart";

let storage: Storage;
beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  cartStore.resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCart", () => {
  it("加入後存進 localStorage;重新整理(丟掉記憶體)讀得回來", () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.add(CABBAGE.id, 2, 10));
    expect(result.current.count).toBe(2);
    expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? "[]")).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
    cartStore.resetForTests();
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
  });

  it("改數量、移除", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.add(CABBAGE.id, 1);
      result.current.add(BEEF.id, 1);
    });
    act(() => result.current.setQty(CABBAGE.id, 5));
    act(() => result.current.remove([BEEF.id]));
    expect(result.current.lines).toEqual([{ productId: CABBAGE.id, qty: 5 }]);
  });

  it("別的分頁改了購物車(storage 事件)會跟著更新", () => {
    const { result } = renderHook(() => useCart());
    storage.setItem(CART_STORAGE_KEY, JSON.stringify([{ productId: BEEF.id, qty: 3 }]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CART_STORAGE_KEY }));
    });
    expect(result.current.count).toBe(3);
  });

  it("localStorage 一碰就丟例外(無痕、封鎖):當成空的,加入照樣有效(只在記憶體)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    cartStore.resetForTests();
    const { result } = renderHook(() => useCart());
    expect(result.current.lines).toEqual([]);
    act(() => result.current.add(CABBAGE.id, 1));
    expect(result.current.count).toBe(1);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/useCart.test.tsx`

Expected:FAIL,`Failed to resolve import "./useCart"`

**Step 3:寫實作**

```ts
// 購物車狀態:整個市集共用一份,存在 localStorage(key = CART_STORAGE_KEY);useSyncExternalStore 訂閱,
// 別的分頁改了也會同步(storage 事件)。
// 🔴 localStorage 在無痕模式、封鎖網站資料時可能一讀寫就丟例外:一律 try/catch —— 讀不到當空的,寫不進去就只留在這個分頁的記憶體。
import { useSyncExternalStore } from "react";
import { addLine, CART_STORAGE_KEY, cartCount, type CartLine, parseCart, removeLines, setLineQty } from "./cart";

const listeners = new Set<() => void>();
let cache: CartLine[] | null = null;

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
  } catch {
    /* 寫不進去:只留在記憶體 */
  }
  emit();
};

const onStorage = (e: StorageEvent) => {
  if (e.key !== null && e.key !== CART_STORAGE_KEY) return;
  cache = read();
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
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
  },
};

const EMPTY: CartLine[] = [];

export const useCart = () => {
  const lines = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  return { lines, count: cartCount(lines), add: cartStore.add, setQty: cartStore.setQty, remove: cartStore.remove };
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  4 passed (4)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/useCart.ts src/lib/market/useCart.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 購物車狀態 useCart(localStorage、跨分頁同步、無痕模式不掛)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 46:加入購物車(商品頁)、頁首購物車連結、頁尾條款連結

- `QtyStepper`:− [數字] +,按鈕 44px,`role="group"` + 名稱(例如「有機高麗菜 數量」)。
- `AddToCart`:數量上限 = 庫存與 99 取小、扣掉購物車裡已有的;售完、預覽中(還沒上架)、購物車滿 50 種都不能加;加入後 `role="status"` 說「已加入購物車。看購物車」。手機(≤ 880px)固定在畫面底部,商品頁底部留 `pb-32` 不被蓋住。
- `MarketLayout`:頁首右上「購物車」連結(螢幕閱讀器念「購物車,N 件」)、頁尾加服務條款 / 隱私權政策連結(頁面在 Task 49)。

**Files:**
- Create: `src/components/market/QtyStepper.tsx`
- Create: `src/components/market/AddToCart.tsx`
- Modify: `src/components/market/MarketLayout.tsx`
- Modify: `src/pages/market/MarketProductPage.tsx`
- Test: `src/components/market/market-components.test.tsx`、`src/pages/market/MarketProductPage.test.tsx`

**Step 1:寫失敗的測試**

`src/components/market/market-components.test.tsx`:

在 `src/components/market/market-components.test.tsx` 找到:

```tsx

import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import CategoryChips from "./CategoryChips";
import MarketImage from "./MarketImage";
```

換成:

```tsx

import { BEEF, CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import { createMemoryStorage } from "@/test/memory-storage";
import CategoryChips from "./CategoryChips";
import MarketImage from "./MarketImage";
```

在 `src/components/market/market-components.test.tsx` 找到:

```tsx
    expect(screen.getByRole("contentinfo")).toHaveTextContent("商品由各店家販售、出貨與收款");
    expect(document.title).toBe("測試頁｜iFoodmap 食材市集");
  });
});
```

換成:

```tsx
    expect(screen.getByRole("contentinfo")).toHaveTextContent("商品由各店家販售、出貨與收款");
    expect(document.title).toBe("測試頁｜iFoodmap 食材市集");
  });

  it("頁首的購物車連結念出件數;頁尾有服務條款與隱私權政策", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    cartStore.resetForTests();
    cartStore.add(CABBAGE.id, 2);
    render(
      <MemoryRouter initialEntries={["/market"]}>
        <Routes>
          <Route path="/market" element={<MarketLayout />}>
            <Route index element={<TitleProbe title="測試頁" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "購物車,2 件" })).toHaveAttribute("href", "/market/cart");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: "服務條款" })).toHaveAttribute("href", "/market/terms");
    expect(footer.getByRole("link", { name: "隱私權政策" })).toHaveAttribute("href", "/market/privacy");
    vi.unstubAllGlobals();
    cartStore.resetForTests();
  });
});
```

`src/pages/market/MarketProductPage.test.tsx`(每個測試前換上記憶體版 localStorage;預覽提示改用文字找,因為加入購物車的提示也是 `role="status"`):

在 `src/pages/market/MarketProductPage.test.tsx` 找到:

```tsx
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
```

換成:

```tsx
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
```

在 `src/pages/market/MarketProductPage.test.tsx` 找到:

```tsx

import { fetchMarketProduct } from "@/lib/market/catalog";
import { CABBAGE, STORE_A } from "@/lib/market/testFixtures";
import MarketProductPage from "./MarketProductPage";
import { renderMarketRoute } from "./testUtils";
```

換成:

```tsx

import { fetchMarketProduct } from "@/lib/market/catalog";
import { CABBAGE, SALMON, STORE_A } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import { createMemoryStorage } from "@/test/memory-storage";
import MarketProductPage from "./MarketProductPage";
import { renderMarketRoute } from "./testUtils";
```

在 `src/pages/market/MarketProductPage.test.tsx` 找到:

```tsx
const renderAt = (id: string) => renderMarketRoute(`/market/p/${id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }]);

afterEach(cleanup);

describe("MarketProductPage", () => {
```

換成:

```tsx
const renderAt = (id: string) => renderMarketRoute(`/market/p/${id}`, [{ path: "/market/p/:productId", element: <MarketProductPage /> }]);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketProductPage", () => {
```

在 `src/pages/market/MarketProductPage.test.tsx` 找到:

```tsx
    expect(within(card).getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "麵包屑" })).toHaveTextContent("市集›蔬菜›有機高麗菜");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.title).toBe("有機高麗菜｜iFoodmap 食材市集");
  });
```

換成:

```tsx
    expect(within(card).getByText("運費 NT$ 120,滿 NT$ 1,000 免運")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "麵包屑" })).toHaveTextContent("市集›蔬菜›有機高麗菜");
    expect(screen.queryByText(/預覽:/)).toBeNull();
    expect(document.title).toBe("有機高麗菜｜iFoodmap 食材市集");
  });
```

在 `src/pages/market/MarketProductPage.test.tsx` 找到:

```tsx
  });

  it("還沒上架(供應商預覽自己的商品)顯示預覽提示", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, review_status: "pending" });
    renderAt(CABBAGE.id);
    expect(await screen.findByRole("status")).toHaveTextContent("預覽:消費者目前看不到這個商品(審核狀態:待審)");
  });

```

換成:

```tsx
  });

  it("還沒上架(供應商預覽自己的商品)顯示預覽提示,不能加入購物車", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...CABBAGE, review_status: "pending" });
    renderAt(CABBAGE.id);
    expect(await screen.findByText(/預覽:消費者目前看不到這個商品/)).toHaveTextContent("預覽:消費者目前看不到這個商品(審核狀態:待審)");
    expect(screen.queryByRole("button", { name: "加入購物車" })).toBeNull();
  });

  it("加入購物車:選數量、存進購物車、告訴使用者已加入", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(CABBAGE);
    renderAt(CABBAGE.id);
    const stepper = await screen.findByRole("group", { name: "有機高麗菜 數量" });
    await userEvent.click(within(stepper).getByRole("button", { name: "增加一件" }));
    await userEvent.click(screen.getByRole("button", { name: "加入購物車" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 2 }]);
    expect(screen.getByText(/已加入購物車/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看購物車" })).toHaveAttribute("href", "/market/cart");
  });

  it("數量上限是庫存(鮭魚剩 3 件);已售完不能按", async () => {
    vi.mocked(fetchMarketProduct).mockResolvedValue(SALMON);
    renderAt(SALMON.id);
    const stepper = await screen.findByRole("group", { name: "挪威鮭魚 數量" });
    const plus = within(stepper).getByRole("button", { name: "增加一件" });
    await userEvent.click(plus);
    await userEvent.click(plus);
    expect(within(stepper).getByRole("spinbutton", { name: "數量" })).toHaveValue(3);
    expect(plus).toBeDisabled();
    cleanup();
    vi.mocked(fetchMarketProduct).mockResolvedValue({ ...SALMON, stock: 0 });
    renderAt(SALMON.id);
    expect(await screen.findByRole("button", { name: "已售完" })).toBeDisabled();
  });

```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/components/market/market-components.test.tsx src/pages/market/MarketProductPage.test.tsx`

Expected:3 failed —— `Unable to find an accessible element with the role "link" and name "購物車,2 件"`、`Unable to find role="group" and name "有機高麗菜 數量"`、`Unable to find role="group" and name "挪威鮭魚 數量"`。

**Step 3:寫實作**

`src/components/market/QtyStepper.tsx`:

```tsx
// 數量選擇:− [數字] +(按鈕至少 44px;數字框可以直接打)。label 給螢幕閱讀器用,例如「有機高麗菜 數量」。
import { MARKET_FOCUS_RING } from "./MarketLayout";

interface QtyStepperProps {
  value: number;
  max: number;
  onChange: (qty: number) => void;
  label: string;
  min?: number;
  disabled?: boolean;
}

const BTN = `inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg text-slate-800 hover:bg-slate-50 disabled:opacity-40 ${MARKET_FOCUS_RING}`;

export default function QtyStepper({ value, max, onChange, label, min = 1, disabled = false }: QtyStepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(Number.isFinite(n) ? Math.floor(n) : min, Math.max(min, max)));
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-1">
      <button type="button" className={BTN} aria-label="減少一件" disabled={disabled || value <= min} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="數量"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className={`h-11 w-14 rounded-md border border-slate-300 bg-white text-center text-base ${MARKET_FOCUS_RING}`}
      />
      <button type="button" className={BTN} aria-label="增加一件" disabled={disabled || value >= max} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}
```

`src/components/market/AddToCart.tsx`:

```tsx
// 商品頁的「加入購物車」:數量 + 按鈕。手機(≤ 880px)固定在畫面底部,桌機跟著內容走。
// 售完、預覽中(還沒上架)、購物車滿了都不能加;加入後用 role="status" 告訴螢幕閱讀器,並給「看購物車」連結。
import { useState } from "react";
import { Link } from "react-router-dom";
import { isPubliclyVisible } from "@/lib/market/catalog";
import { CART_LIMITS, isCartFull, maxQtyFor } from "@/lib/market/cart";
import type { MarketProductRow } from "@/lib/market/types";
import { useCart } from "@/lib/market/useCart";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON } from "./MarketLayout";
import QtyStepper from "./QtyStepper";

export default function AddToCart({ product }: { product: MarketProductRow }) {
  const { lines, add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const inCart = lines.find((l) => l.productId === product.id)?.qty ?? 0;
  const max = maxQtyFor(product);
  const remaining = Math.max(0, max - inCart);
  const full = isCartFull(lines, product.id);

  if (!isPubliclyVisible(product)) return null;

  const reason =
    max === 0 ? "已售完" : remaining === 0 ? `購物車裡已經有 ${inCart} 件(已達可購買上限)` : full ? `購物車最多 ${CART_LIMITS.maxLines} 種商品` : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white p-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] min-[881px]:static min-[881px]:border-0 min-[881px]:p-0 min-[881px]:shadow-none">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <QtyStepper value={Math.min(qty, Math.max(1, remaining))} max={Math.max(1, remaining)} onChange={setQty} label={`${product.name} 數量`} disabled={!!reason} />
        <button
          type="button"
          disabled={!!reason}
          onClick={() => {
            add(product.id, Math.min(qty, remaining), max);
            setAdded(true);
            setQty(1);
          }}
          className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-6 font-semibold disabled:bg-slate-300 disabled:text-slate-600 min-[881px]:flex-none ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
        >
          {max === 0 ? "已售完" : "加入購物車"}
        </button>
        <p role="status" className="w-full text-sm text-slate-700 min-[881px]:w-auto">
          {reason && max > 0 ? reason : null}
          {added && !reason ? (
            <>
              已加入購物車。
              <Link to="/market/cart" className={`ml-1 font-medium text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                看購物車
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
```

`src/components/market/MarketLayout.tsx`:

在 `src/components/market/MarketLayout.tsx` 找到:

```tsx
// 消費者食材市集(/market/*)的共用版面:頁首(logo、導覽)、主內容(<Outlet/>)、頁尾(平台角色說明)。
//
// 手機優先;≤ 880px 是手機(跟形象站同一個分界),桌機用 Tailwind 任意斷點 min-[881px]:。
```

換成:

```tsx
// 消費者食材市集(/market/*)的共用版面:頁首(logo、購物車)、主內容(<Outlet/>)、頁尾(平台角色說明、條款連結)。
//
// 手機優先;≤ 880px 是手機(跟形象站同一個分界),桌機用 Tailwind 任意斷點 min-[881px]:。
```

在 `src/components/market/MarketLayout.tsx` 找到:

```tsx
import { useEffect } from "react";
import { Link, Outlet } from "react-router-dom";

export const MARKET_FOCUS_RING =
```

換成:

```tsx
import { useEffect } from "react";
import { Link, Outlet } from "react-router-dom";
import { ShoppingCart } from "lucide-react";
import { useCart } from "@/lib/market/useCart";

export const MARKET_FOCUS_RING =
```

在 `src/components/market/MarketLayout.tsx` 找到:

```tsx

export default function MarketLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
```

換成:

```tsx

export default function MarketLayout() {
  const { count } = useCart();
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
```

在 `src/components/market/MarketLayout.tsx` 找到:

```tsx
            <span className="sr-only">首頁</span>
          </Link>
          <nav aria-label="市集" className="ml-auto flex items-center gap-1" />
        </div>
      </header>
```

換成:

```tsx
            <span className="sr-only">首頁</span>
          </Link>
          <nav aria-label="市集" className="ml-auto flex items-center gap-1">
            <Link
              to="/market/cart"
              aria-label={`購物車,${count} 件`}
              className={`relative inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-slate-800 hover:bg-slate-100 ${MARKET_FOCUS_RING}`}
            >
              <ShoppingCart className="h-5 w-5" aria-hidden="true" />
              <span className="text-sm">購物車</span>
              {count > 0 ? (
                <span aria-hidden="true" className="rounded-full bg-emerald-700 px-1.5 text-xs font-semibold text-white">
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </Link>
          </nav>
        </div>
      </header>
```

在 `src/components/market/MarketLayout.tsx` 找到:

```tsx
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-slate-600">
          <p>iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。</p>
        </div>
      </footer>
```

換成:

```tsx
        <div className="mx-auto max-w-6xl space-y-2 px-4 py-6 text-sm text-slate-600">
          <p>iFoodmap 食材市集是媒合平台:商品由各店家販售、出貨與收款,發票由店家開立。</p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link to="/market/terms" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              服務條款
            </Link>
            <Link to="/market/privacy" className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
              隱私權政策
            </Link>
          </p>
        </div>
      </footer>
```

`src/pages/market/MarketProductPage.tsx`:

在 `src/pages/market/MarketProductPage.tsx` 找到:

```tsx
// /market/p/:productId 商品頁:照片(最多 5 張)、品名、規格、價格、溫層、庫存、產地、保存方式、保存期限、說明,
// 店家卡(店名、配送縣市、運費、免運門檻、最低訂購金額、出貨天數、付款方式)。
// 供應商 / 管理員打開自家還沒上架的商品時,照樣顯示但加「預覽」提示(消費者看不到,RLS 擋)。
import { useState } from "react";
```

換成:

```tsx
// /market/p/:productId 商品頁:照片(最多 5 張)、品名、規格、價格、溫層、庫存、產地、保存方式、保存期限、說明,
// 加入購物車(手機固定在畫面底部)、店家卡(店名、配送縣市、運費、免運門檻、最低訂購金額、出貨天數、付款方式)。
// 供應商 / 管理員打開自家還沒上架的商品時,照樣顯示但加「預覽」提示(消費者看不到,RLS 擋)。
import { useState } from "react";
```

在 `src/pages/market/MarketProductPage.tsx` 找到:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
```

換成:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import AddToCart from "@/components/market/AddToCart";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
```

在 `src/pages/market/MarketProductPage.tsx` 找到:

```tsx

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <nav aria-label="麵包屑" className="mb-4 text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1">
```

換成:

```tsx

  return (
    <div className="mx-auto max-w-6xl px-4 pb-32 pt-6 min-[881px]:pb-6">
      <nav aria-label="麵包屑" className="mb-4 text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1">
```

在 `src/pages/market/MarketProductPage.tsx` 找到:

```tsx
          )}

          <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">線上訂購即將開放。</p>

          {store && (
```

換成:

```tsx
          )}

          <AddToCart product={product} />

          {store && (
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  16 passed (16)`(10 + 6)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/components/market/QtyStepper.tsx src/components/market/AddToCart.tsx src/components/market/MarketLayout.tsx src/components/market/market-components.test.tsx src/pages/market/MarketProductPage.tsx src/pages/market/MarketProductPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 商品頁加入購物車(手機固定底部)、頁首購物車連結、頁尾條款連結

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 47:結帳邏輯 `checkout.ts`(表單驗證、送出內容、錯誤訊息)

- `PHONE_PATTERN` / `EMAIL_PATTERN`:測試解析 migration 130000 的 `@market-phone-regex` / `@market-email-regex`,`.source` 必須一字不差。
- `validateBuyer`:姓名 1–50、電話(去空白 / 括號 / 連字號後 `0` 開頭 9–10 碼)、Email、縣市、地址 5–200、備註 ≤ 300。
- `buildCheckoutPayload`:只送這次能結帳的店;電話去符號、Email 轉小寫;付款方式沒選用預設(有貨到付款就用貨到付款);`expected_totals` 帶畫面上的每店總額。
- `placeOrder` / `fetchCheckoutStatus`(呼叫兩支 RPC)、`checkoutErrorMessage`(每個錯誤代碼一句中文;店名由呼叫端提供)。

**Files:**
- Create: `src/lib/market/checkout.ts`
- Test: `src/lib/market/checkout.test.ts`

**Step 1:寫失敗的測試**

```ts
// checkout.ts:表單驗證(跟資料庫同一套正規表示式)、送出的內容(只算能結帳的店、帶預期總額)、錯誤訊息。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import { buildCart } from "./cart";
import {
  buildCheckoutPayload,
  checkoutErrorMessage,
  defaultPayment,
  EMAIL_PATTERN,
  emptyBuyer,
  fetchCheckoutStatus,
  PHONE_PATTERN,
  placeOrder,
  validateBuyer,
  type BuyerForm,
} from "./checkout";
import { BEEF, CABBAGE, SALMON, SUPPLIER_A, SUPPLIER_B } from "./testFixtures";

const MIGRATION = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261009130000_market_orders.sql"), "utf8");
const sqlRegex = (marker: string) => {
  const m = MIGRATION.match(new RegExp(`p ~ '([^']+)'\\s+-- @market-${marker}-regex`));
  if (!m) throw new Error(`migration 少了 @market-${marker}-regex`);
  return m[1];
};

const GOOD: BuyerForm = {
  name: " 王小明 ",
  phone: "0912-345-678",
  email: " Buyer@Example.com ",
  city: "臺北市",
  address: "測試路 1 號 2 樓",
  note: " 請放管理室 ",
};

describe("跟資料庫一致", () => {
  it("電話、Email 的正規表示式", () => {
    expect(PHONE_PATTERN.source).toBe(sqlRegex("phone"));
    expect(EMAIL_PATTERN.source).toBe(sqlRegex("email"));
  });
});

describe("validateBuyer", () => {
  it("全部空白:每一欄都有錯誤", () => {
    expect(Object.keys(validateBuyer(emptyBuyer())).sort()).toEqual(["address", "city", "email", "name", "phone"]);
  });

  it("電話接受手機與市話(可以有空白、連字號、括號);格式不對要擋", () => {
    for (const phone of ["0912345678", "0912-345-678", "(02) 2345-6789", "037-123456"]) {
      expect(validateBuyer({ ...GOOD, phone }).phone, phone).toBeUndefined();
    }
    for (const phone of ["912345678", "09123456789", "0912-345-67a", "+886912345678"]) {
      expect(validateBuyer({ ...GOOD, phone }).phone, phone).toBe("請填寫手機或市話,例如 0912345678 或 02-2345-6789");
    }
  });

  it("Email、縣市、地址、姓名與備註長度", () => {
    expect(validateBuyer({ ...GOOD, email: "a@b" }).email).toBe("Email 格式不對(訂單通知會寄到這裡)");
    expect(validateBuyer({ ...GOOD, email: "名字<a@b.com>" }).email).toBeDefined();
    expect(validateBuyer({ ...GOOD, city: "" }).city).toBe("請選擇收件縣市");
    expect(validateBuyer({ ...GOOD, address: "一號" }).address).toBe("請填寫完整的收件地址(5–200 字)");
    expect(validateBuyer({ ...GOOD, name: "王".repeat(51) }).name).toBe("姓名最多 50 字");
    expect(validateBuyer({ ...GOOD, note: "字".repeat(301) }).note).toBe("備註最多 300 字");
    expect(validateBuyer(GOOD)).toEqual({});
  });
});

describe("buildCheckoutPayload", () => {
  const view = buildCart(
    [
      { productId: CABBAGE.id, qty: 2 },
      { productId: BEEF.id, qty: 1 },
      { productId: SALMON.id, qty: 1 },
    ],
    [CABBAGE, BEEF, SALMON],
    "臺北市",
  );

  it("收件資料去空白、電話去符號、Email 轉小寫;明細、付款方式、預期總額", () => {
    const payload = buildCheckoutPayload({ buyer: GOOD, groups: view.groups, payments: { [SUPPLIER_A]: "transfer" }, termsVersion: "2026-10-draft" });
    expect(payload).toEqual({
      buyer: { name: "王小明", phone: "0912345678", email: "buyer@example.com", city: "臺北市", address: "測試路 1 號 2 樓", note: "請放管理室" },
      items: [
        { product_id: CABBAGE.id, qty: 2 },
        { product_id: BEEF.id, qty: 1 },
        { product_id: SALMON.id, qty: 1 },
      ],
      payments: { [SUPPLIER_A]: "transfer", [SUPPLIER_B]: "cod" },
      expected_totals: { [SUPPLIER_A]: 770, [SUPPLIER_B]: 260 },
      terms_version: "2026-10-draft",
    });
  });

  it("只送傳進來的店(不能結帳的店不要傳);沒填備註就不送 note", () => {
    const payload = buildCheckoutPayload({ buyer: { ...GOOD, note: "  " }, groups: [view.groups[1]], payments: {}, termsVersion: "v" });
    expect(payload.items).toEqual([{ product_id: SALMON.id, qty: 1 }]);
    expect(Object.keys(payload.payments)).toEqual([SUPPLIER_B]);
    expect(payload.buyer).not.toHaveProperty("note");
  });

  it("預設付款方式:有貨到付款就用貨到付款", () => {
    expect(defaultPayment(["cod", "transfer"])).toBe("cod");
    expect(defaultPayment(["transfer"])).toBe("transfer");
  });
});

describe("呼叫資料庫", () => {
  it("下單送 p_checkout;開關狀態不帶參數", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, token: "t", checkout_id: "c", orders: [] }, error: null });
    const payload = buildCheckoutPayload({ buyer: GOOD, groups: [], payments: {}, termsVersion: "v" });
    await placeOrder(payload);
    expect(rpc).toHaveBeenLastCalledWith("market_place_order", { p_checkout: payload });
    rpc.mockResolvedValueOnce({ data: { open: false, can_order: true }, error: null });
    expect(await fetchCheckoutStatus()).toEqual({ open: false, can_order: true });
    expect(rpc).toHaveBeenLastCalledWith("market_checkout_status", {});
  });
});

describe("checkoutErrorMessage", () => {
  const name = (id: string) => (id === SUPPLIER_A ? "A 店" : "B 店");
  it.each([
    [{ ok: false as const, code: "MARKET_CLOSED" }, "線上訂購還沒對外開放,購物車會幫你保留。"],
    [{ ok: false as const, code: "RATE_LIMITED", retry_after: 1500 }, "下單次數太頻繁,請 25 分鐘後再試。"],
    [{ ok: false as const, code: "INVALID_INPUT", field: "buyer.phone" }, "電話格式不對"],
    [{ ok: false as const, code: "NOT_DELIVERABLE", stores: [SUPPLIER_B] }, "B 店 不配送到你選的縣市。"],
    [{ ok: false as const, code: "BELOW_MINIMUM", stores: [{ supplier_id: SUPPLIER_A }] }, "A 店 還沒到最低訂購金額。"],
    [{ ok: false as const, code: "PRICE_CHANGED", stores: [{ supplier_id: SUPPLIER_A }] }, "價格或運費剛剛有變動,畫面已更新成最新金額,請確認後再送出一次。"],
    [{ ok: false as const, code: "SOMETHING_NEW" }, "下單失敗,請稍後再試。"],
  ])("%o", (r, msg) => {
    expect(checkoutErrorMessage(r, name)).toBe(msg);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/checkout.test.ts`

Expected:FAIL,`Failed to resolve import "./checkout"`

**Step 3:寫實作**

```ts
// 結帳:收件資料驗證(跟 market_place_order 同一套規則)、組送給資料庫的內容、下單、錯誤代碼 → 中文。
//
// 🔴 電話、Email 的正規表示式跟資料庫一字不差:checkout.test.ts 解析 20261009130000_market_orders.sql 的
//    @market-phone-regex / @market-email-regex 比對。長度上限在 constants.ts 的 LIMITS。
// 🔴 金額只是「預期」:expected_totals 跟資料庫算的不一樣時回 PRICE_CHANGED,不會用前端的數字建單。
import type { CartGroup } from "./cart";
import { isTwCity, LIMITS, type PaymentMethod, type TwCity } from "./constants";
import { marketRpc } from "./db";

export const PHONE_PATTERN = /^0[0-9]{8,9}$/;
export const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export interface BuyerForm {
  name: string;
  phone: string;
  email: string;
  city: TwCity | "";
  address: string;
  note: string;
}
export type BuyerErrors = Partial<Record<keyof BuyerForm, string>>;

export const emptyBuyer = (): BuyerForm => ({ name: "", phone: "", email: "", city: "", address: "", note: "" });

/** 跟資料庫一樣:拿掉空白、括號、連字號(0912-345-678 → 0912345678) */
export const normalizePhone = (s: string): string => s.replace(/[\s()-]/g, "");
export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

export const validateBuyer = (f: BuyerForm): BuyerErrors => {
  const e: BuyerErrors = {};
  const name = f.name.trim();
  if (!name) e.name = "請填寫收件人姓名";
  else if (name.length > LIMITS.buyerName) e.name = `姓名最多 ${LIMITS.buyerName} 字`;
  if (!PHONE_PATTERN.test(normalizePhone(f.phone))) e.phone = "請填寫手機或市話,例如 0912345678 或 02-2345-6789";
  const email = normalizeEmail(f.email);
  if (!EMAIL_PATTERN.test(email) || email.length > 254) e.email = "Email 格式不對(訂單通知會寄到這裡)";
  if (!isTwCity(f.city)) e.city = "請選擇收件縣市";
  const address = f.address.trim();
  if (address.length < LIMITS.addressMin || address.length > LIMITS.address) {
    e.address = `請填寫完整的收件地址(${LIMITS.addressMin}–${LIMITS.address} 字)`;
  }
  if (f.note.trim().length > LIMITS.buyerNote) e.note = `備註最多 ${LIMITS.buyerNote} 字`;
  return e;
};

/** 預設付款方式:店家接受的第一種(貨到付款優先) */
export const defaultPayment = (methods: readonly PaymentMethod[]): PaymentMethod => (methods.includes("cod") ? "cod" : methods[0]);

export interface CheckoutPayload {
  buyer: { name: string; phone: string; email: string; city: TwCity; address: string; note?: string };
  items: Array<{ product_id: string; qty: number }>;
  payments: Record<string, PaymentMethod>;
  expected_totals: Record<string, number>;
  terms_version: string;
}

/** groups = 這次要結帳的店(都是 canCheckout 的);payments 沒選的用 defaultPayment */
export const buildCheckoutPayload = (opts: {
  buyer: BuyerForm;
  groups: CartGroup[];
  payments: Record<string, PaymentMethod>;
  termsVersion: string;
}): CheckoutPayload => {
  const note = opts.buyer.note.trim();
  return {
    buyer: {
      name: opts.buyer.name.trim(),
      phone: normalizePhone(opts.buyer.phone),
      email: normalizeEmail(opts.buyer.email),
      city: opts.buyer.city as TwCity,
      address: opts.buyer.address.trim(),
      ...(note ? { note } : {}),
    },
    items: opts.groups.flatMap((g) => g.lines.map((l) => ({ product_id: l.product.id, qty: l.qty }))),
    payments: Object.fromEntries(
      opts.groups.map((g) => [g.supplierId, opts.payments[g.supplierId] ?? defaultPayment(g.store.payment_methods)]),
    ),
    expected_totals: Object.fromEntries(opts.groups.map((g) => [g.supplierId, g.total])),
    terms_version: opts.termsVersion,
  };
};

export type PlaceOrderResult =
  | { ok: true; token: string; checkout_id: string; orders: Array<{ id: string; supplier_id: string; total: number }> }
  | {
      ok: false;
      code: string;
      field?: string;
      retry_after?: number;
      products?: unknown[];
      stores?: Array<string | { supplier_id: string }>;
    };

export const placeOrder = (payload: CheckoutPayload): Promise<PlaceOrderResult> =>
  marketRpc<PlaceOrderResult>("market_place_order", { p_checkout: payload });

/** 下單開關:open = 對外開放了沒;can_order = 你現在能不能下單(開放了,或你是平台管理員) */
export interface CheckoutStatus {
  open: boolean;
  can_order: boolean;
}
export const fetchCheckoutStatus = (): Promise<CheckoutStatus> => marketRpc<CheckoutStatus>("market_checkout_status", {});

const FIELD_MESSAGES: Record<string, string> = {
  "buyer.name": "收件人姓名格式不對",
  "buyer.phone": "電話格式不對",
  "buyer.email": "Email 格式不對",
  "buyer.city": "請選擇收件縣市",
  "buyer.address": "收件地址格式不對",
  "buyer.note": "備註太長了",
  items: "購物車內容有問題,請回購物車重新整理",
};

/** 失敗代碼 → 給消費者看的一句話;storeName 把 supplier_id 換成店名 */
export const checkoutErrorMessage = (
  r: Extract<PlaceOrderResult, { ok: false }>,
  storeName: (supplierId: string) => string,
): string => {
  const stores = (r.stores ?? []).map((s) => storeName(typeof s === "string" ? s : s.supplier_id)).join("、");
  switch (r.code) {
    case "MARKET_CLOSED":
      return "線上訂購還沒對外開放,購物車會幫你保留。";
    case "RATE_LIMITED":
      return `下單次數太頻繁,請 ${Math.max(1, Math.ceil((r.retry_after ?? 60) / 60))} 分鐘後再試。`;
    case "DAILY_CAP":
      return "今天的訂單量已達上限,請明天再試。";
    case "INVALID_INPUT":
      return FIELD_MESSAGES[r.field ?? ""] ?? "有欄位格式不對,請檢查後再送出。";
    case "EMPTY_CART":
      return "購物車是空的。";
    case "TOO_MANY_ITEMS":
      return "一次最多結帳 50 種商品。";
    case "TOO_MANY_STORES":
      return "一次最多結帳 10 家店,請分次結帳。";
    case "PRODUCT_UNAVAILABLE":
      return "有商品剛剛下架了,請回購物車移除後再結帳。";
    case "OUT_OF_STOCK":
      return "有商品庫存不足,已更新成最新庫存,請調整數量後再送出。";
    case "NOT_DELIVERABLE":
      return `${stores} 不配送到你選的縣市。`;
    case "BELOW_MINIMUM":
      return `${stores} 還沒到最低訂購金額。`;
    case "PAYMENT_NOT_ACCEPTED":
      return `${stores} 不接受你選的付款方式,請重新選擇。`;
    case "PRICE_CHANGED":
      return "價格或運費剛剛有變動,畫面已更新成最新金額,請確認後再送出一次。";
    default:
      return "下單失敗,請稍後再試。";
  }
};
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  15 passed (15)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/checkout.ts src/lib/market/checkout.test.ts
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 結帳表單驗證(正規表示式對照 migration)、送出內容與錯誤訊息

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 48:購物車頁 `/market/cart`

按店家分組,每組:商品(縮圖、品名、規格、單價、數量、小計、移除)、小計、運費(免運就寫免運)、這家店合計、再買多少免運、紅字問題(超過庫存、沒到最低金額);已下架的商品另外列出來一次移除;全部合計;下單開關沒開時提示「可以先逛、先放購物車」且「前往結帳」不能按(平台管理員另有提示可以下測試單)。

**Files:**
- Create: `src/pages/market/MarketCartPage.tsx`
- Test: `src/pages/market/MarketCartPage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market/cart:按店家分組、小計 / 運費 / 免運差額 / 最低金額、改數量、下架商品、下單開關沒開時不能前往結帳。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchProductsByIds: vi.fn(),
}));
vi.mock("@/lib/market/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/checkout")>()),
  fetchCheckoutStatus: vi.fn(),
}));

import { fetchProductsByIds } from "@/lib/market/catalog";
import { fetchCheckoutStatus } from "@/lib/market/checkout";
import { BEEF, CABBAGE, SALMON } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import MarketCartPage from "./MarketCartPage";
import { renderMarketRoute } from "./testUtils";

const renderCart = () => renderMarketRoute("/market/cart", [{ path: "/market/cart", element: <MarketCartPage /> }]);
const store = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
  vi.mocked(fetchProductsByIds).mockResolvedValue([CABBAGE, BEEF, SALMON]);
  vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: true, can_order: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketCartPage", () => {
  it("空的購物車:說明 + 去逛市集", () => {
    renderCart();
    expect(screen.getByText("購物車是空的。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去逛市集" })).toHaveAttribute("href", "/market");
    expect(fetchProductsByIds).not.toHaveBeenCalled();
  });

  it("按店家分組:每家店的小計、運費、合計、再買多少免運;全部合計;可以前往結帳", async () => {
    cartStore.add(CABBAGE.id, 2);
    cartStore.add(SALMON.id, 1);
    cartStore.add(BEEF.id, 1);
    renderCart();
    await screen.findByRole("region", { name: "市集測試 A 店" });
    const a = within(store("市集測試 A 店"));
    expect(a.getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("有機高麗菜"), expect.stringContaining("牛肉片")]);
    expect(a.getByText("NT$ 650")).toBeInTheDocument();
    expect(a.getByText("NT$ 120")).toBeInTheDocument();
    expect(a.getByText("NT$ 770")).toBeInTheDocument();
    expect(a.getByText("再買 NT$ 350 就免運")).toBeInTheDocument();
    expect(within(store("市集測試 B 店")).getByText("NT$ 260")).toBeInTheDocument();
    expect(screen.getByText("NT$ 1,030")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往結帳" })).toHaveAttribute("href", "/market/checkout");
  });

  it("沒到最低訂購金額:紅字說明、不能前往結帳;加一件就可以了", async () => {
    cartStore.add(CABBAGE.id, 2);
    renderCart();
    expect(await screen.findByText("還差 NT$ 100 才到這家店的最低訂購金額 NT$ 300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往結帳" })).toBeDisabled();
    await userEvent.click(within(screen.getByRole("group", { name: "有機高麗菜 數量" })).getByRole("button", { name: "增加一件" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
    expect(await screen.findByRole("link", { name: "前往結帳" })).toBeInTheDocument();
  });

  it("已下架的商品另外列出來,可以一次移除", async () => {
    cartStore.add(CABBAGE.id, 3);
    cartStore.add(BEEF.id, 1);
    vi.mocked(fetchProductsByIds).mockResolvedValue([CABBAGE, { ...BEEF, is_listed: false }]);
    renderCart();
    expect(await screen.findByRole("heading", { name: "1 項商品已下架或暫停販售" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "從購物車移除" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
  });

  it("移除單一商品", async () => {
    cartStore.add(CABBAGE.id, 3);
    cartStore.add(SALMON.id, 1);
    renderCart();
    await userEvent.click(await screen.findByRole("button", { name: "移除 挪威鮭魚" }));
    expect(cartStore.get()).toEqual([{ productId: CABBAGE.id, qty: 3 }]);
  });

  it("下單還沒對外開放:提示可以先逛,前往結帳不能按", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: false });
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText(/線上訂購還沒對外開放,現在可以先逛/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往結帳" })).toBeDisabled();
    expect(screen.getByText("線上訂購還沒對外開放。")).toBeInTheDocument();
  });

  it("還沒開放但你是平台管理員:提示可以下測試單", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: true });
    cartStore.add(CABBAGE.id, 3);
    renderCart();
    expect(await screen.findByText("市集還沒對外開放;你是平台管理員,可以下測試單。")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "前往結帳" })).toBeInTheDocument();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketCartPage.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketCartPage"`

**Step 3:寫實作**

```tsx
// /market/cart 購物車:按店家分組;每組顯示小計、運費(固定運費,達免運門檻免運)、再買多少免運、是否達最低訂購金額。
// 商品資料每次重新抓(價格、庫存、上下架都是最新的);已下架的商品另外列出來讓人刪除。
// 下單開關(market_checkout_status)還沒開時照樣能逛、能放購物車,但「前往結帳」不能按並說明原因。
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import MarketImage from "@/components/market/MarketImage";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON, useMarketTitle } from "@/components/market/MarketLayout";
import QtyStepper from "@/components/market/QtyStepper";
import { buildCart, cartProductsKey } from "@/lib/market/cart";
import { fetchProductsByIds } from "@/lib/market/catalog";
import { fetchCheckoutStatus } from "@/lib/market/checkout";
import { citiesSummary, formatTwd, shippingSummary } from "@/lib/market/format";
import { useCart } from "@/lib/market/useCart";

export default function MarketCartPage() {
  useMarketTitle("購物車");
  const { lines, setQty, remove } = useCart();
  const ids = lines.map((l) => l.productId);
  const products = useQuery({ queryKey: cartProductsKey(ids), queryFn: () => fetchProductsByIds(ids), enabled: ids.length > 0 });
  const status = useQuery({ queryKey: ["market", "checkout-status"], queryFn: fetchCheckoutStatus });
  const view = useMemo(() => buildCart(lines, products.data ?? []), [lines, products.data]);
  const grandTotal = view.groups.reduce((sum, g) => sum + g.total, 0);
  const canGo = !!status.data?.can_order && view.groups.some((g) => g.canCheckout);

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">購物車</h1>
        <p className="mt-2 text-slate-600">購物車是空的。</p>
        <Link to="/market" className={`mt-6 inline-flex min-h-11 items-center rounded-md px-5 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}>
          去逛市集
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold text-slate-900">購物車</h1>

      {status.data && !status.data.can_order ? (
        <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          線上訂購還沒對外開放,現在可以先逛、先放進購物車(購物車存在這台裝置的瀏覽器裡)。
        </p>
      ) : null}
      {status.data && !status.data.open && status.data.can_order ? (
        <p role="status" className="mb-4 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          市集還沒對外開放;你是平台管理員,可以下測試單。
        </p>
      ) : null}

      {products.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : products.isError ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          商品資料載入失敗,請重新整理再試一次。
        </p>
      ) : (
        <div className="space-y-6">
          {view.unavailable.length > 0 ? (
            <section aria-labelledby="cart-unavailable" className="rounded-xl border border-red-200 bg-red-50 p-4">
              <h2 id="cart-unavailable" className="font-semibold text-red-900">
                {view.unavailable.length} 項商品已下架或暫停販售
              </h2>
              <button
                type="button"
                onClick={() => remove(view.unavailable.map((l) => l.productId))}
                className={`mt-2 inline-flex min-h-11 items-center rounded-md border border-red-300 bg-white px-4 text-sm text-red-800 ${MARKET_FOCUS_RING}`}
              >
                從購物車移除
              </button>
            </section>
          ) : null}

          {view.groups.map((g) => (
            <section key={g.supplierId} aria-labelledby={`cart-store-${g.supplierId}`} className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 id={`cart-store-${g.supplierId}`} className="text-lg font-semibold text-slate-900">
                <Link to={`/market/s/${g.supplierId}`} className={`underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                  {g.storeName}
                </Link>
              </h2>
              <p className="text-xs text-slate-500">
                配送:{citiesSummary(g.store.delivery_cities)}・{shippingSummary(g.store)}
              </p>

              <ul className="mt-3 divide-y divide-slate-100">
                {g.lines.map((l) => (
                  <li key={l.product.id} className="flex gap-3 py-3">
                    <MarketImage path={l.product.photos[0]} category={l.product.category} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <Link to={`/market/p/${l.product.id}`} className={`font-medium text-slate-900 underline-offset-2 hover:underline ${MARKET_FOCUS_RING}`}>
                          {l.product.name}
                        </Link>
                        <p className="text-xs text-slate-500">
                          {l.product.spec}・{formatTwd(l.product.price)}
                        </p>
                        {l.overStock ? (
                          <p className="text-sm text-red-700">{l.maxQty === 0 ? "已售完,請移除" : `庫存只剩 ${l.maxQty} 件`}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <QtyStepper value={l.qty} max={Math.max(l.qty, l.maxQty)} onChange={(q) => setQty(l.product.id, q)} label={`${l.product.name} 數量`} />
                        <p className="ml-auto font-medium text-slate-900">{formatTwd(l.lineTotal)}</p>
                        <button
                          type="button"
                          onClick={() => remove([l.product.id])}
                          aria-label={`移除 ${l.product.name}`}
                          className={`inline-flex min-h-11 items-center rounded-md px-2 text-sm text-slate-600 hover:text-red-700 ${MARKET_FOCUS_RING}`}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <dl className="mt-2 grid grid-cols-[1fr,auto] gap-y-1 border-t border-slate-100 pt-3 text-sm">
                <dt className="text-slate-600">小計</dt>
                <dd className="text-right">{formatTwd(g.subtotal)}</dd>
                <dt className="text-slate-600">運費</dt>
                <dd className="text-right">{g.shippingFee === 0 ? "免運" : formatTwd(g.shippingFee)}</dd>
                <dt className="font-semibold text-slate-900">這家店合計</dt>
                <dd className="text-right font-bold text-emerald-800">{formatTwd(g.total)}</dd>
              </dl>
              {g.freeShippingRemaining !== null ? (
                <p className="mt-2 text-sm text-emerald-800">再買 {formatTwd(g.freeShippingRemaining)} 就免運</p>
              ) : null}
              {g.problems.map((p) => (
                <p key={p} className="mt-2 text-sm text-red-700">
                  {p}
                </p>
              ))}
            </section>
          ))}

          {view.groups.length > 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="flex items-baseline justify-between text-lg">
                <span className="font-semibold text-slate-900">全部合計</span>
                <span className="font-bold text-emerald-800">{formatTwd(grandTotal)}</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">運費與能不能配送,到結帳頁選好收件縣市後會再確認一次。每家店各自出貨、各自收款。</p>
              {canGo ? (
                <Link
                  to="/market/checkout"
                  className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md px-6 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
                >
                  前往結帳
                </Link>
              ) : (
                <>
                  <button type="button" disabled aria-describedby="cart-cannot-checkout" className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-slate-300 px-6 font-semibold text-slate-600">
                    前往結帳
                  </button>
                  <p id="cart-cannot-checkout" className="mt-2 text-sm text-slate-600">
                    {!status.data?.can_order ? "線上訂購還沒對外開放。" : "每家店都還有需要調整的地方(見上方紅字)。"}
                  </p>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  7 passed (7)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/market/MarketCartPage.tsx src/pages/market/MarketCartPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 購物車頁(按店家分組、運費、免運差額、最低金額、下架商品)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 49:服務條款與隱私權政策(草稿)`/market/terms`、`/market/privacy`

內容在 `legal.ts`:平台是仲介、店家是賣方;生鮮與易腐食品依「通訊交易解除權合理例外情事適用準則」第 2 條第 1 款不適用 7 日解除權;發票由店家開立;不賣酒;查詢連結請勿分享;隱私權:蒐集項目、用途、誰看得到(只有下單的店家)、IP / Email / 電話只存加鹽雜湊 2 天、權利行使。`LEGAL_DRAFT = true` 時頁面最上面標「草稿」;`TERMS_VERSION = "2026-10-draft"` 會記在每張訂單上(≤ 20 字)。🔴 文字是工程團隊擬的草稿,定稿要業主(建議法律專業)確認 —— 見「風險與待業主決定」。

**Files:**
- Create: `src/lib/market/legal.ts`
- Create: `src/pages/market/MarketLegalPage.tsx`
- Test: `src/pages/market/MarketLegalPage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market/terms、/market/privacy:草稿提示、標題、設計稿要求的三個重點;兩頁互相連結。
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { LEGAL_DRAFT, TERMS_VERSION } from "@/lib/market/legal";
import MarketLegalPage from "./MarketLegalPage";

afterEach(cleanup);

describe("MarketLegalPage", () => {
  it("服務條款:草稿提示;平台是仲介、生鮮不適用 7 日解除權、發票由店家開立", () => {
    render(
      <MemoryRouter>
        <MarketLegalPage doc="terms" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "食材市集服務條款" })).toBeInTheDocument();
    expect(LEGAL_DRAFT).toBe(true);
    expect(screen.getByText("草稿:本文件待業主與法律專業確認後定稿。")).toBeInTheDocument();
    expect(screen.getByText(/店家是賣方/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 條第 1 款的情形,不適用 7 日解除權/)).toBeInTheDocument();
    expect(screen.getByText("發票由店家開立。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看隱私權政策" })).toHaveAttribute("href", "/market/privacy");
    expect(document.title).toBe("食材市集服務條款｜iFoodmap 食材市集");
  });

  it("隱私權政策:蒐集項目與誰看得到;版本字串放得進資料庫(≤ 20 字)", () => {
    render(
      <MemoryRouter>
        <MarketLegalPage doc="privacy" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "食材市集隱私權政策" })).toBeInTheDocument();
    expect(screen.getByText(/你下單的店家:為了出貨與聯絡你/)).toBeInTheDocument();
    expect(TERMS_VERSION.length).toBeLessThanOrEqual(20);
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketLegalPage.test.tsx`

Expected:FAIL,`Failed to resolve import "@/lib/market/legal"`

**Step 3:寫實作**

`src/lib/market/legal.ts`:

```ts
// 食材市集的服務條款與隱私權政策(/market/terms、/market/privacy)。
//
// 🔴 目前是「草稿」:2026-10 由工程團隊依業主核准的設計擬稿,待業主(建議請法律專業)確認後定稿。
//    定稿時:改文字 → LEGAL_DRAFT 改成 false → TERMS_VERSION 換新版本(≤ 20 字;訂單上會記下消費者同意的版本)。
// 三個重點(設計稿「業主待辦」):平台是仲介、供應商是賣方;生鮮與易腐食品不適用七天解除權;發票由供應商開立。
export const TERMS_VERSION = "2026-10-draft";
export const LEGAL_DRAFT = true;

export interface LegalDoc {
  title: string;
  updated: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
}

const CONTACT = "ifoodmaptw@gmail.com";

export const TERMS: LegalDoc = {
  title: "食材市集服務條款",
  updated: "2026-10-09",
  sections: [
    {
      heading: "一、平台的角色",
      paragraphs: [
        "iFoodmap 食材市集(以下稱「本市集」)由 iFoodmap 食材地圖經營,提供店家刊登食材、消費者向店家下單的媒合服務。",
        "每一筆訂單的買賣契約成立在你和店家之間:店家是賣方,負責商品、出貨、收款、開立發票與售後服務;本市集不是賣方,也不經手貨款。",
      ],
    },
    {
      heading: "二、下單與訂單成立",
      paragraphs: [
        "你送出訂單後,店家會在後台看到訂單並決定接單或拒單(例如缺貨)。店家接單時,你與該店家的買賣契約成立;店家拒單時訂單不成立,你不需要付款。",
        "一次結帳包含多家店時,會按店家拆成多張訂單,各自由各店家處理。",
      ],
    },
    {
      heading: "三、價格、運費與付款",
      paragraphs: [
        "價格、運費、免運門檻與最低訂購金額由各店家設定,以你送出訂單當下系統計算的金額為準。",
        "付款方式由店家提供(貨到付款或銀行轉帳),款項直接付給店家。選擇銀行轉帳時,店家接單後訂單查詢頁會顯示店家的匯款資訊。",
      ],
    },
    {
      heading: "四、配送",
      paragraphs: ["商品由店家安排出貨,配送範圍與出貨天數以各店家頁面的標示為準。出貨後你可以在訂單查詢頁看到物流與單號。"],
    },
    {
      heading: "五、退換貨與解除契約",
      paragraphs: [
        "依消費者保護法,通訊交易原則上可以在收到商品後 7 日內解除契約。但生鮮、冷藏冷凍及其他易於腐敗、保存期限較短的食品,屬於「通訊交易解除權合理例外情事適用準則」第 2 條第 1 款的情形,不適用 7 日解除權。",
        "商品有瑕疵、與說明不符或運送損壞時,請在收到商品後盡快拍照並聯絡店家處理;各店家的退換貨說明見店家頁。",
      ],
    },
    {
      heading: "六、發票",
      paragraphs: ["發票由店家開立。"],
    },
    {
      heading: "七、不販售的商品",
      paragraphs: ["本市集不販售酒類及其他依法不得以網路方式販售的商品。發現違規商品,本市集會下架。"],
    },
    {
      heading: "八、訂單查詢連結",
      paragraphs: ["下單後你會拿到一個專屬的訂單查詢網址,知道這個網址的人就能看到訂單內容與收件資料,請妥善保存、不要分享給別人。"],
    },
    {
      heading: "九、個人資料",
      paragraphs: ["你的個人資料如何使用,請見「食材市集隱私權政策」。"],
    },
    {
      heading: "十、聯絡我們",
      paragraphs: [`對本市集的服務有任何問題,請寄信到 ${CONTACT}。訂單、商品與退換貨問題請直接聯絡店家。`],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  title: "食材市集隱私權政策",
  updated: "2026-10-09",
  sections: [
    {
      heading: "一、我們蒐集哪些資料",
      paragraphs: [
        "你下單時填寫的收件人姓名、電話、Email、收件縣市與地址、備註,以及訂單內容。",
        "為了防止灌單與濫用,我們會記錄下單的網路位址(IP)、Email 與電話的雜湊值(經過加密處理、無法直接還原),2 天後自動刪除。",
        "購物車內容只存在你自己的瀏覽器(localStorage),不會傳到我們的伺服器,直到你送出訂單。",
      ],
    },
    {
      heading: "二、用途",
      paragraphs: ["把訂單交給你下單的店家出貨、寄送訂單通知信、處理客訴與爭議、防止濫用。我們不會把你的資料用於其他行銷用途。"],
    },
    {
      heading: "三、誰會看到你的資料",
      paragraphs: [
        "你下單的店家:為了出貨與聯絡你,會看到你的收件資料與訂單內容;其他店家看不到。",
        "本市集的管理人員:處理客訴時。",
        "受託處理資料的服務商:資料庫與主機(Supabase、Vercel)、寄信服務(Resend)。",
      ],
    },
    {
      heading: "四、保存期間",
      paragraphs: ["訂單資料會保存到交易完成後,店家處理售後、會計與稅務所需的期間為止(實際年限待業主確認),之後刪除或去識別化。"],
    },
    {
      heading: "五、你的權利",
      paragraphs: [
        `依個人資料保護法,你可以查詢、閱覽、要求複本、補充或更正、停止蒐集處理利用、刪除你的個人資料。請寄信到 ${CONTACT},並附上訂單編號。`,
      ],
    },
  ],
};

export const LEGAL_DOCS = { terms: TERMS, privacy: PRIVACY } as const;
export type LegalDocKey = keyof typeof LEGAL_DOCS;
```

`src/pages/market/MarketLegalPage.tsx`:

```tsx
// /market/terms、/market/privacy:食材市集的服務條款與隱私權政策(內容在 src/lib/market/legal.ts)。
// LEGAL_DRAFT = true 時最上面顯示「草稿」提示 —— 定稿前不要拿掉。
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { Link } from "react-router-dom";
import { LEGAL_DOCS, LEGAL_DRAFT, type LegalDocKey } from "@/lib/market/legal";

export default function MarketLegalPage({ doc }: { doc: LegalDocKey }) {
  const d = LEGAL_DOCS[doc];
  useMarketTitle(d.title);
  const other = doc === "terms" ? { to: "/market/privacy", label: "隱私權政策" } : { to: "/market/terms", label: "服務條款" };
  return (
    <article className="mx-auto max-w-3xl px-4 py-8">
      {LEGAL_DRAFT ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          草稿:本文件待業主與法律專業確認後定稿。
        </p>
      ) : null}
      <h1 className="text-2xl font-bold text-slate-900">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-500">最後更新:{d.updated}</p>
      <div className="mt-6 space-y-6">
        {d.sections.map((s) => (
          <section key={s.heading}>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p} className="mb-2 leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-8 text-sm">
        <Link to={other.to} className={`text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
          看{other.label}
        </Link>
      </p>
    </article>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  2 passed (2)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/legal.ts src/pages/market/MarketLegalPage.tsx src/pages/market/MarketLegalPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 食材市集服務條款與隱私權政策頁(草稿,待業主確認)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 50:結帳頁 `/market/checkout`

- 收件資料(每欄有 `<label>`、`autocomplete`;錯誤在欄位下方,`aria-invalid` + `aria-describedby`;送出失敗時焦點移到第一個錯的欄位,`scroll-mt-20` 不被頁首蓋住)。
- 收件縣市一選,就重新判斷每家店能不能配送:不配送 / 沒到最低金額 / 超過庫存的店列在「這次不能結帳的店家(商品會留在購物車)」。
- 每家店一組付款方式(只列該店接受的;選轉帳會說明接單後才看得到匯款帳號)。
- 同意條款(勾選框旁邊另開分頁的連結,不在 `<label>` 裡);提醒生鮮不適用 7 日解除權、款項付給店家、發票由店家開。
- 成功:結帳的商品從購物車拿掉、導到 `/market/orders/<token>?new=1`(`replace`);失敗:顯示中文原因(`role="alert"`),價格 / 庫存 / 上架有變時重抓商品。
- 🔴 `tsconfig.app.json` 沒開 strict:用 `if (r.ok === false)` 收窄結果型別。

**Files:**
- Create: `src/pages/market/MarketCheckoutPage.tsx`
- Test: `src/pages/market/MarketCheckoutPage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// /market/checkout:欄位驗證(錯誤在欄位旁、焦點移過去)、配送縣市決定哪些店能結帳、付款方式、送出內容、成功導到查詢頁、失敗訊息。
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@/test/memory-storage";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/catalog")>()),
  fetchProductsByIds: vi.fn(),
}));
vi.mock("@/lib/market/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/checkout")>()),
  fetchCheckoutStatus: vi.fn(),
  placeOrder: vi.fn(),
}));

import { fetchProductsByIds } from "@/lib/market/catalog";
import { fetchCheckoutStatus, placeOrder } from "@/lib/market/checkout";
import { TERMS_VERSION } from "@/lib/market/legal";
import { BEEF, CABBAGE, SALMON, SUPPLIER_A, SUPPLIER_B } from "@/lib/market/testFixtures";
import { cartStore } from "@/lib/market/useCart";
import MarketCheckoutPage from "./MarketCheckoutPage";
import { renderMarketRoute } from "./testUtils";

const TOKEN = `tok_${"x".repeat(39)}`;
const renderCheckout = () =>
  renderMarketRoute("/market/checkout", [
    { path: "/market/checkout", element: <MarketCheckoutPage /> },
    { path: "/market/orders/:token", element: <p>查詢頁</p> },
  ]);

const fill = async (city = "臺北市") => {
  await userEvent.type(await screen.findByLabelText("收件人姓名"), "王小明");
  await userEvent.type(screen.getByLabelText("電話"), "0912-345-678");
  await userEvent.type(screen.getByLabelText(/^Email/), "buyer@example.com");
  await userEvent.selectOptions(screen.getByLabelText("收件縣市"), city);
  await userEvent.type(screen.getByLabelText(/^收件地址/), "測試路 1 號 2 樓");
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  cartStore.resetForTests();
  cartStore.add(CABBAGE.id, 2);
  cartStore.add(BEEF.id, 1);
  cartStore.add(SALMON.id, 1);
  vi.mocked(fetchProductsByIds).mockResolvedValue([CABBAGE, BEEF, SALMON]);
  vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: true, can_order: true });
  vi.mocked(placeOrder).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketCheckoutPage", () => {
  it("什麼都沒填就送出:每個欄位旁顯示錯誤、標 aria-invalid、焦點到第一個欄位;不會下單", async () => {
    renderCheckout();
    await userEvent.click(await screen.findByRole("button", { name: /送出訂單/ }));
    const name = screen.getByLabelText("收件人姓名");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("請填寫收件人姓名");
    expect(name).toHaveFocus();
    expect(screen.getByLabelText("電話")).toHaveAccessibleDescription("請填寫手機或市話,例如 0912345678 或 02-2345-6789");
    expect(screen.getByLabelText("收件縣市")).toHaveAccessibleDescription("請選擇收件縣市");
    expect(screen.getByText("請先勾選同意服務條款與隱私權政策")).toBeInTheDocument();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("沒勾同意條款:焦點到勾選框,不會下單", async () => {
    renderCheckout();
    await fill();
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
    expect(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" })).toHaveFocus();
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("條款連結另開分頁", async () => {
    renderCheckout();
    expect(await screen.findByRole("link", { name: "服務條款" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "隱私權政策" })).toHaveAttribute("href", "/market/privacy");
  });

  it("收件縣市不在 B 店配送範圍:B 店列在「這次不能結帳」,只結 A 店", async () => {
    renderCheckout();
    await fill("新北市");
    const blocked = screen.getByRole("region", { name: "這次不能結帳的店家(商品會留在購物車)" });
    expect(within(blocked).getByRole("listitem")).toHaveTextContent("市集測試 B 店:這家店不配送到新北市");
    expect(screen.getByRole("region", { name: "市集測試 A 店" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "送出訂單(NT$ 770)" })).toBeInTheDocument();
  });

  it("成功:送出伺服器要的內容;結帳的商品從購物車拿掉;帶 token 進查詢頁", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill();
    const a = within(screen.getByRole("region", { name: "市集測試 A 店" }));
    await userEvent.click(a.getByRole("radio", { name: "銀行轉帳" }));
    expect(a.getByText("店家接單後,訂單查詢頁會顯示匯款帳號,也會寄信通知你。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    await userEvent.click(screen.getByRole("button", { name: "送出訂單(NT$ 1,030)" }));
    expect(placeOrder).toHaveBeenCalledWith({
      buyer: { name: "王小明", phone: "0912345678", email: "buyer@example.com", city: "臺北市", address: "測試路 1 號 2 樓" },
      items: [
        { product_id: CABBAGE.id, qty: 2 },
        { product_id: BEEF.id, qty: 1 },
        { product_id: SALMON.id, qty: 1 },
      ],
      payments: { [SUPPLIER_A]: "transfer", [SUPPLIER_B]: "cod" },
      expected_totals: { [SUPPLIER_A]: 770, [SUPPLIER_B]: 260 },
      terms_version: TERMS_VERSION,
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/market/orders/${TOKEN}?new=1`));
    expect(cartStore.get()).toEqual([]);
  });

  it("只結一部分的店:沒結的商品留在購物車", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: true, token: TOKEN, checkout_id: "c1", orders: [] });
    renderCheckout();
    await fill("新北市");
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    await userEvent.click(screen.getByRole("button", { name: "送出訂單(NT$ 770)" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/market/orders/${TOKEN}`));
    expect(cartStore.get()).toEqual([{ productId: SALMON.id, qty: 1 }]);
  });

  it("價格變了(PRICE_CHANGED):顯示說明、重新抓商品,不離開這頁", async () => {
    vi.mocked(placeOrder).mockResolvedValue({ ok: false, code: "PRICE_CHANGED", stores: [{ supplier_id: SUPPLIER_A }] });
    renderCheckout();
    await fill();
    await userEvent.click(screen.getByRole("checkbox", { name: "我已閱讀並同意服務條款與隱私權政策" }));
    const calls = vi.mocked(fetchProductsByIds).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /送出訂單/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("價格或運費剛剛有變動");
    await waitFor(() => expect(vi.mocked(fetchProductsByIds).mock.calls.length).toBeGreaterThan(calls));
    expect(screen.getByTestId("location")).toHaveTextContent("/market/checkout");
    expect(cartStore.get()).toHaveLength(3);
  });

  it("下單還沒對外開放:不顯示表單", async () => {
    vi.mocked(fetchCheckoutStatus).mockResolvedValue({ open: false, can_order: false });
    renderCheckout();
    expect(await screen.findByText("線上訂購還沒對外開放,購物車會幫你保留。")).toBeInTheDocument();
    expect(screen.queryByLabelText("收件人姓名")).toBeNull();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/market/MarketCheckoutPage.test.tsx`

Expected:FAIL,`Failed to resolve import "./MarketCheckoutPage"`

**Step 3:寫實作**

```tsx
// /market/checkout 免註冊結帳:姓名、電話、Email、收件縣市與地址、備註;每家店各選一種付款方式;勾選同意服務條款。
// 收件縣市不在某家店的配送範圍時,那家店這次不能結帳(留在購物車);一次結帳按店家拆成多張訂單。
// 送出後資料庫重算一切(market_place_order);成功就把結帳的商品從購物車拿掉,帶著 token 進訂單查詢頁(?new=1 顯示「已送出」)。
// 無障礙:每個欄位有 <label>;錯誤顯示在欄位下方(aria-invalid + aria-describedby),送出失敗時焦點移到第一個錯的欄位。
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON, useMarketTitle } from "@/components/market/MarketLayout";
import { buildCart, CART_LIMITS, cartProductsKey } from "@/lib/market/cart";
import { fetchProductsByIds } from "@/lib/market/catalog";
import {
  buildCheckoutPayload,
  checkoutErrorMessage,
  defaultPayment,
  emptyBuyer,
  fetchCheckoutStatus,
  placeOrder,
  validateBuyer,
  type BuyerErrors,
  type BuyerForm,
} from "@/lib/market/checkout";
import { LIMITS, PAYMENT_METHODS, TW_CITIES, type PaymentMethod, type TwCity } from "@/lib/market/constants";
import { friendlyDbError } from "@/lib/market/db";
import { formatTwd } from "@/lib/market/format";
import { TERMS_VERSION } from "@/lib/market/legal";
import { cartStore, useCart } from "@/lib/market/useCart";

// scroll-mt-20:送出失敗時焦點移到欄位,不要被固定的頁首蓋住
const INPUT = `min-h-11 w-full scroll-mt-20 rounded-md border border-slate-300 bg-white px-3 text-base ${MARKET_FOCUS_RING}`;
const FIELD_ORDER: Array<keyof BuyerForm> = ["name", "phone", "email", "city", "address", "note"];
const REFETCH_CODES = ["PRICE_CHANGED", "OUT_OF_STOCK", "PRODUCT_UNAVAILABLE", "NOT_DELIVERABLE", "BELOW_MINIMUM", "PAYMENT_NOT_ACCEPTED"];

const FieldError = ({ id, message }: { id: string; message?: string }) =>
  message ? (
    <p id={id} className="mt-1 text-sm text-red-700">
      {message}
    </p>
  ) : null;

export default function MarketCheckoutPage() {
  useMarketTitle("結帳");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { lines } = useCart();
  const ids = lines.map((l) => l.productId);
  const products = useQuery({ queryKey: cartProductsKey(ids), queryFn: () => fetchProductsByIds(ids), enabled: ids.length > 0 });
  const status = useQuery({ queryKey: ["market", "checkout-status"], queryFn: fetchCheckoutStatus });

  const [buyer, setBuyer] = useState<BuyerForm>(emptyBuyer);
  const [errors, setErrors] = useState<BuyerErrors>({});
  const [payments, setPayments] = useState<Record<string, PaymentMethod>>({});
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const view = useMemo(() => buildCart(lines, products.data ?? [], buyer.city || null), [lines, products.data, buyer.city]);
  const ready = view.groups.filter((g) => g.canCheckout);
  const blocked = view.groups.filter((g) => !g.canCheckout);
  const grandTotal = ready.reduce((sum, g) => sum + g.total, 0);

  const set = <K extends keyof BuyerForm>(key: K, value: BuyerForm[K]) => setBuyer((b) => ({ ...b, [key]: value }));
  const field = (key: keyof BuyerForm) => ({
    id: `checkout-${key}`,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `checkout-${key}-error` : undefined,
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const errs = validateBuyer(buyer);
    setErrors(errs);
    setAgreeError(!agreed);
    const firstBad = FIELD_ORDER.find((k) => errs[k]);
    if (firstBad) {
      document.getElementById(`checkout-${firstBad}`)?.focus();
      return;
    }
    if (!agreed) {
      document.getElementById("checkout-agree")?.focus();
      return;
    }
    if (ready.length === 0) {
      setSubmitError("沒有可以結帳的店家,請看上方每家店的說明。");
      return;
    }
    if (ready.length > CART_LIMITS.maxStores) {
      setSubmitError(`一次最多結帳 ${CART_LIMITS.maxStores} 家店,請先從購物車移除一些店家的商品。`);
      return;
    }
    setSubmitting(true);
    try {
      const r = await placeOrder(buildCheckoutPayload({ buyer, groups: ready, payments, termsVersion: TERMS_VERSION }));
      // 用 === 比對:tsconfig.app.json 沒開 strict,只靠 if (r.ok) 收窄不了聯集型別
      if (r.ok === false) {
        setSubmitError(checkoutErrorMessage(r, (id) => view.groups.find((g) => g.supplierId === id)?.storeName ?? "有一家店"));
        if (REFETCH_CODES.includes(r.code)) await queryClient.invalidateQueries({ queryKey: ["market", "cart-products"] });
        return;
      }
      cartStore.remove(ready.flatMap((g) => g.lines.map((l) => l.product.id)));
      navigate(`/market/orders/${r.token}?new=1`, { replace: true });
    } catch (err) {
      setSubmitError(friendlyDbError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">結帳</h1>
        <p className="mt-2 text-slate-600">購物車是空的。</p>
        <Link to="/market" className={`mt-6 inline-flex min-h-11 items-center rounded-md px-5 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}>
          去逛市集
        </Link>
      </div>
    );
  }
  if (status.data && !status.data.can_order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">結帳</h1>
        <p role="status" className="mt-2 text-slate-700">
          線上訂購還沒對外開放,購物車會幫你保留。
        </p>
        <Link to="/market/cart" className={`mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-5 ${MARKET_FOCUS_RING}`}>
          回購物車
        </Link>
      </div>
    );
  }
  if (products.isLoading || status.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6" aria-busy="true">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold text-slate-900">結帳</h1>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="space-y-6">
        <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
          <legend className="px-1 text-lg font-semibold text-slate-900">收件資料</legend>
          <div>
            <label htmlFor="checkout-name" className="mb-1 block text-sm font-medium">
              收件人姓名
            </label>
            <input {...field("name")} autoComplete="name" maxLength={LIMITS.buyerName} value={buyer.name} onChange={(e) => set("name", e.target.value)} className={INPUT} />
            <FieldError id="checkout-name-error" message={errors.name} />
          </div>
          <div>
            <label htmlFor="checkout-phone" className="mb-1 block text-sm font-medium">
              電話
            </label>
            <input {...field("phone")} type="tel" autoComplete="tel" inputMode="tel" maxLength={20} value={buyer.phone} onChange={(e) => set("phone", e.target.value)} className={INPUT} />
            <FieldError id="checkout-phone-error" message={errors.phone} />
          </div>
          <div>
            <label htmlFor="checkout-email" className="mb-1 block text-sm font-medium">
              Email(訂單通知與查詢連結會寄到這裡)
            </label>
            <input {...field("email")} type="email" autoComplete="email" maxLength={254} value={buyer.email} onChange={(e) => set("email", e.target.value)} className={INPUT} />
            <FieldError id="checkout-email-error" message={errors.email} />
          </div>
          <div>
            <label htmlFor="checkout-city" className="mb-1 block text-sm font-medium">
              收件縣市
            </label>
            <select {...field("city")} autoComplete="address-level1" value={buyer.city} onChange={(e) => set("city", e.target.value as TwCity | "")} className={INPUT}>
              <option value="">請選擇</option>
              {TW_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <FieldError id="checkout-city-error" message={errors.city} />
          </div>
          <div>
            <label htmlFor="checkout-address" className="mb-1 block text-sm font-medium">
              收件地址(區、路、號、樓)
            </label>
            <input {...field("address")} autoComplete="street-address" maxLength={LIMITS.address} value={buyer.address} onChange={(e) => set("address", e.target.value)} className={INPUT} />
            <FieldError id="checkout-address-error" message={errors.address} />
          </div>
          <div>
            <label htmlFor="checkout-note" className="mb-1 block text-sm font-medium">
              備註(選填,例如:請放管理室)
            </label>
            <textarea {...field("note")} rows={2} maxLength={LIMITS.buyerNote} value={buyer.note} onChange={(e) => set("note", e.target.value)} className={`${INPUT} py-2`} />
            <FieldError id="checkout-note-error" message={errors.note} />
          </div>
        </fieldset>

        {blocked.length > 0 ? (
          <section aria-labelledby="checkout-blocked" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <h2 id="checkout-blocked" className="font-semibold text-amber-900">
              這次不能結帳的店家(商品會留在購物車)
            </h2>
            <ul className="mt-2 space-y-2 text-sm text-amber-900">
              {blocked.map((g) => (
                <li key={g.supplierId}>
                  <span className="font-medium">{g.storeName}</span>:{g.problems.join(";")}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {ready.map((g) => {
          const chosen = payments[g.supplierId] ?? defaultPayment(g.store.payment_methods);
          return (
            <section key={g.supplierId} aria-labelledby={`checkout-store-${g.supplierId}`} className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 id={`checkout-store-${g.supplierId}`} className="text-lg font-semibold text-slate-900">
                {g.storeName}
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {g.lines.map((l) => (
                  <li key={l.product.id} className="flex justify-between gap-2">
                    <span>
                      {l.product.name}({l.product.spec})× {l.qty}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">{formatTwd(l.lineTotal)}</span>
                  </li>
                ))}
                <li className="flex justify-between gap-2 text-slate-600">
                  <span>運費</span>
                  <span>{g.shippingFee === 0 ? "免運" : formatTwd(g.shippingFee)}</span>
                </li>
                <li className="flex justify-between gap-2 font-semibold">
                  <span>這家店合計</span>
                  <span>{formatTwd(g.total)}</span>
                </li>
              </ul>
              <fieldset className="mt-3">
                <legend className="text-sm font-medium text-slate-900">付款方式</legend>
                <div className="mt-1 flex flex-wrap gap-4">
                  {g.store.payment_methods.map((m) => (
                    <label key={m} className="inline-flex min-h-11 items-center gap-2">
                      <input
                        type="radio"
                        name={`payment-${g.supplierId}`}
                        value={m}
                        checked={chosen === m}
                        onChange={() => setPayments((p) => ({ ...p, [g.supplierId]: m }))}
                        className="h-5 w-5 accent-emerald-700"
                      />
                      {PAYMENT_METHODS[m]}
                    </label>
                  ))}
                </div>
                {chosen === "transfer" ? <p className="text-xs text-slate-600">店家接單後,訂單查詢頁會顯示匯款帳號,也會寄信通知你。</p> : null}
              </fieldset>
            </section>
          );
        })}

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="flex items-baseline justify-between text-lg">
            <span className="font-semibold text-slate-900">應付總額({ready.length} 家店)</span>
            <span className="font-bold text-emerald-800">{formatTwd(grandTotal)}</span>
          </p>
          <p className="text-xs text-slate-600">
            款項直接付給各店家,發票由店家開立。生鮮、冷藏冷凍等易腐食品不適用 7 日解除權(詳見服務條款第五條)。
          </p>
          <div>
            <div className="flex items-start gap-2">
              <input
                id="checkout-agree"
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                aria-invalid={agreeError && !agreed ? true : undefined}
                aria-describedby={agreeError && !agreed ? "checkout-agree-error" : undefined}
                className="mt-1 h-5 w-5 accent-emerald-700"
              />
              <label htmlFor="checkout-agree" className="text-sm">
                我已閱讀並同意服務條款與隱私權政策
              </label>
            </div>
            <p className="ml-7 text-sm">
              <Link to="/market/terms" target="_blank" rel="noopener" className={`text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                服務條款
              </Link>
              、
              <Link to="/market/privacy" target="_blank" rel="noopener" className={`text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                隱私權政策
              </Link>
              (另開新分頁)
            </p>
            <FieldError id="checkout-agree-error" message={agreeError && !agreed ? "請先勾選同意服務條款與隱私權政策" : undefined} />
          </div>
          {submitError ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {submitError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className={`inline-flex min-h-11 w-full items-center justify-center rounded-md px-6 font-semibold disabled:opacity-60 ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
          >
            {submitting ? "送出中…" : `送出訂單(${formatTwd(grandTotal)})`}
          </button>
        </div>
      </form>
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  8 passed (8)`;再確認型別沒有新增錯誤:`cd /Users/aimand/.gemini/File/ifoodmap && npx tsc --noEmit -p tsconfig.app.json > /tmp/market-tsc.log 2>&1; grep -c 'error TS' /tmp/market-tsc.log` → `72`。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/market/MarketCheckoutPage.tsx src/pages/market/MarketCheckoutPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 免註冊結帳頁(收件資料、配送判斷、每店付款方式、同意條款、送出)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 51:訂單查詢頁 `/market/orders/:token`(token 頁)

- `lookup.ts`:token 不是 43 字 base64url 就不打資料庫;`NOT_FOUND` → `null`;資料庫錯誤往上丟(頁面顯示「載入失敗」+ 再試一次,而不是「找不到」)。
- `OrderItems`:訂單明細表(查詢頁、供應商、管理員共用)。
- 頁面:剛下單(`?new=1`)顯示「已送出,共 N 張」與這個網址(唯讀輸入框 + 複製連結;寄信閘門沒開時消費者收不到確認信,這裡是唯一的保存機會);收件資料(遮罩過的);每張單:店名 + 訂單編號、狀態、下單時間與付款方式、待匯款時的匯款資訊(保留換行)、拒單 / 取消原因、物流與單號、明細、進度時間軸、店家電話 / Email / 退換貨說明。🔴 頁面不放任何外部 http 連結(token 在網址裡,避免經 Referer 外流)。

**Files:**
- Create: `src/lib/market/lookup.ts`
- Create: `src/components/market/OrderItems.tsx`
- Create: `src/pages/market/MarketOrderLookupPage.tsx`
- Test: `src/lib/market/lookup.test.ts`、`src/pages/market/MarketOrderLookupPage.test.tsx`

**Step 1:寫失敗的測試**

`src/lib/market/lookup.test.ts`:

```ts
// lookup.ts:token 格式不對不打資料庫;找不到回 null;找到回訂單。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

import { fetchOrdersByToken, TOKEN_PATTERN } from "./lookup";

const TOKEN = `tok_${"x".repeat(39)}`;

beforeEach(() => rpc.mockReset());

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
```

`src/pages/market/MarketOrderLookupPage.test.tsx`:

```tsx
// /market/orders/:token:token 頁 —— 壞網址 / 找不到、每張訂單的狀態與明細、轉帳資訊只在待匯款時出現、拒單原因、出貨單號、
// 剛下單的提示(網址與複製)、載入失敗可以重試。
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/market/lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/lookup")>()),
  fetchOrdersByToken: vi.fn(),
}));

import { fetchOrdersByToken, type LookupOrder } from "@/lib/market/lookup";
import { formatOrderNo } from "@/lib/order-number";
import MarketOrderLookupPage from "./MarketOrderLookupPage";
import { renderMarketRoute } from "./testUtils";

const TOKEN = `tok_${"x".repeat(39)}`;
const renderAt = (path: string) => renderMarketRoute(path, [{ path: "/market/orders/:token", element: <MarketOrderLookupPage /> }]);

const base = (over: Partial<LookupOrder>): LookupOrder => ({
  id: "a9600000-0000-4000-8000-0000000000a1",
  status: "pending",
  payment_method: "cod",
  subtotal: 650,
  shipping_fee: 120,
  total: 770,
  created_at: "2026-10-09T04:05:00Z",
  status_note: null,
  shipped_carrier: null,
  shipped_tracking_no: null,
  buyer_name: "王小明",
  buyer_phone: "0912***678",
  buyer_email: "b***@example.com",
  ship_city: "臺北市",
  ship_address: "測試路 1 號 2 樓",
  buyer_note: "請放管理室",
  store: { supplier_id: "s-a", name: "市集測試 A 店", phone: "02-2345-6789", contact_email: "a@example.com", ship_days: 2, return_policy: null },
  items: [{ product_name: "有機高麗菜", spec: "1 顆", unit_price: 100, qty: 2, line_total: 200, temperature: "chilled" }],
  events: [{ to_status: "pending", created_at: "2026-10-09T04:05:00Z", note: null }],
  transfer_info: null,
  ...over,
});

const A = base({});
const B = base({
  id: "a9600000-0000-4000-8000-0000000000b1",
  status: "awaiting_payment",
  payment_method: "transfer",
  subtotal: 200,
  shipping_fee: 60,
  total: 260,
  store: { ...A.store, supplier_id: "s-b", name: "市集測試 B 店" },
  transfer_info: "郵局(700)\n帳號 0001234-5678901",
  events: [
    { to_status: "pending", created_at: "2026-10-09T04:05:00Z", note: null },
    { to_status: "confirmed", created_at: "2026-10-09T05:00:00Z", note: null },
    { to_status: "awaiting_payment", created_at: "2026-10-09T05:00:00Z", note: null },
  ],
});

beforeEach(() => vi.mocked(fetchOrdersByToken).mockReset());
afterEach(cleanup);

describe("MarketOrderLookupPage", () => {
  it("網址的 token 格式不對:直接顯示找不到,不查資料庫", () => {
    renderAt("/market/orders/short");
    expect(screen.getByRole("heading", { name: /找不到這筆訂單/ })).toBeInTheDocument();
    expect(fetchOrdersByToken).not.toHaveBeenCalled();
  });

  it("查不到:找不到", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue(null);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: /找不到這筆訂單/ })).toBeInTheDocument();
  });

  it("兩家店兩張單:店名、訂單編號、狀態、明細;收件資料是遮罩過的", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const a = within(await screen.findByRole("region", { name: `市集測試 A 店 訂單 ${formatOrderNo(A.id)}` }));
    expect(a.getByText("待接單")).toBeInTheDocument();
    expect(a.getByText("有機高麗菜")).toBeInTheDocument();
    expect(a.getByText("NT$ 770")).toBeInTheDocument();
    expect(a.queryByText(/請匯款/)).toBeNull();
    expect(screen.getByRole("region", { name: "收件資料" })).toHaveTextContent("王小明・0912***678・b***@example.com");
    expect(screen.getByRole("heading", { level: 1, name: "訂單查詢" })).toBeInTheDocument();
  });

  it("待匯款的轉帳訂單:顯示金額與匯款資訊(保留換行);時間軸", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}`);
    const b = within(await screen.findByRole("region", { name: `市集測試 B 店 訂單 ${formatOrderNo(B.id)}` }));
    expect(b.getByText("店家已接單,請匯款 NT$ 260:")).toBeInTheDocument();
    expect(b.getByText(/帳號 0001234-5678901/)).toHaveClass("whitespace-pre-line");
    expect(b.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單",
      "2026/10/09 13:00 已接單",
      "2026/10/09 13:00 待匯款",
    ]);
  });

  it("拒單顯示原因;出貨顯示物流與單號", async () => {
    vi.mocked(fetchOrdersByToken).mockResolvedValue([
      base({ status: "rejected", status_note: "今天缺貨" }),
      base({ id: "a9600000-0000-4000-8000-0000000000c1", status: "shipped", shipped_carrier: "黑貓宅急便", shipped_tracking_no: "9001" }),
    ]);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByText("原因:今天缺貨")).toBeInTheDocument();
    expect(screen.getByText("物流:黑貓宅急便,單號 9001")).toBeInTheDocument();
  });

  it("剛下單(?new=1):提示已送出、顯示這個網址、可以複製", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(fetchOrdersByToken).mockResolvedValue([A, B]);
    renderAt(`/market/orders/${TOKEN}?new=1`);
    expect(await screen.findByText("訂單已送出,共 2 張(每家店一張)。店家接單後會寄信通知你。")).toBeInTheDocument();
    const url = screen.getByRole("textbox", { name: "訂單查詢網址" });
    expect(url).toHaveValue(`${window.location.origin}/market/orders/${TOKEN}`);
    await userEvent.click(screen.getByRole("button", { name: "複製連結" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/market/orders/${TOKEN}`);
    expect(await screen.findByText("已複製。")).toBeInTheDocument();
  });

  it("載入失敗:顯示錯誤,可以再試一次", async () => {
    vi.mocked(fetchOrdersByToken).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce([A]);
    renderAt(`/market/orders/${TOKEN}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("訂單載入失敗");
    await userEvent.click(screen.getByRole("button", { name: "再試一次" }));
    expect(await screen.findByText("有機高麗菜")).toBeInTheDocument();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/lib/market/lookup.test.ts src/pages/market/MarketOrderLookupPage.test.tsx`

Expected:兩個檔都 FAIL,`Failed to resolve import "./lookup"` / `"@/lib/market/lookup"`

**Step 3:寫實作**

`src/lib/market/lookup.ts`:

```ts
// 訂單查詢頁(/market/orders/:token)的資料:用 token 呼叫 market_get_orders(免登入;anon 不能直接讀 market_orders)。
// token 格式不對就不打資料庫(跟 RPC 一樣的規則:43 字 base64url)。
import type { PaymentMethod, Temperature, TwCity } from "./constants";
import { marketRpc } from "./db";
import type { OrderStatus } from "./orders";

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface LookupOrder {
  id: string;
  status: OrderStatus;
  payment_method: PaymentMethod;
  subtotal: number;
  shipping_fee: number;
  total: number;
  created_at: string;
  status_note: string | null;
  shipped_carrier: string | null;
  shipped_tracking_no: string | null;
  buyer_name: string;
  /** 已遮罩:0912***678 */
  buyer_phone: string;
  /** 已遮罩:h***@example.com */
  buyer_email: string;
  ship_city: TwCity;
  ship_address: string;
  buyer_note: string | null;
  store: {
    supplier_id: string;
    name: string;
    phone: string | null;
    contact_email: string | null;
    ship_days: number;
    return_policy: string | null;
  };
  items: Array<{ product_name: string; spec: string; unit_price: number; qty: number; line_total: number; temperature: Temperature }>;
  events: Array<{ to_status: OrderStatus; created_at: string; note: string | null }>;
  /** 只有「待匯款」的轉帳訂單才有 */
  transfer_info: string | null;
}

/** 找不到、token 格式不對 → null */
export const fetchOrdersByToken = async (token: string): Promise<LookupOrder[] | null> => {
  if (!TOKEN_PATTERN.test(token)) return null;
  const r = await marketRpc<{ ok: boolean; orders?: LookupOrder[] }>("market_get_orders", { p_token: token });
  return r.ok && Array.isArray(r.orders) && r.orders.length > 0 ? r.orders : null;
};
```

`src/components/market/OrderItems.tsx`:

```tsx
// 訂單明細表(查詢頁、供應商零售訂單、管理員總覽共用):品名、規格、單價 × 數量、小計;下面運費與總額。
import { TEMPERATURES, type Temperature } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";

interface OrderItemsProps {
  items: Array<{ product_name: string; spec: string; temperature: Temperature; unit_price: number; qty: number; line_total: number }>;
  subtotal: number;
  shippingFee: number;
  total: number;
}

export default function OrderItems({ items, subtotal, shippingFee, total }: OrderItemsProps) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">訂單明細</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">商品</th>
          <th scope="col">金額</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i, n) => (
          <tr key={`${i.product_name}-${n}`} className="border-b border-slate-100">
            <td className="py-2 pr-2">
              <span className="font-medium text-slate-900">{i.product_name}</span>
              <span className="block text-xs text-slate-500">
                {i.spec}・{TEMPERATURES[i.temperature]}・{formatTwd(i.unit_price)} × {i.qty}
              </span>
            </td>
            <td className="py-2 text-right align-top text-slate-900">{formatTwd(i.line_total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="pt-2 text-left font-normal text-slate-600">
            小計
          </th>
          <td className="pt-2 text-right">{formatTwd(subtotal)}</td>
        </tr>
        <tr>
          <th scope="row" className="text-left font-normal text-slate-600">
            運費
          </th>
          <td className="text-right">{shippingFee === 0 ? "免運" : formatTwd(shippingFee)}</td>
        </tr>
        <tr>
          <th scope="row" className="text-left font-semibold text-slate-900">
            總額
          </th>
          <td className="text-right font-bold text-emerald-800">{formatTwd(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
```

`src/pages/market/MarketOrderLookupPage.tsx`:

```tsx
// /market/orders/:token 訂單查詢(免登入):這次結帳的每張訂單 —— 店家、訂單編號、狀態與時間軸、明細、付款方式;
// 轉帳訂單在店家接單後(待匯款)顯示匯款資訊;拒單 / 取消顯示原因;出貨顯示物流與單號。
// ?new=1 = 剛下單:顯示「已送出」與這個網址(提醒加入書籤 —— 寄信閘門沒開時,消費者收不到確認信)。
// 🔴 這個網址就是查詢權限(token),頁面上不放任何外部連結,避免 token 經 Referer 外流。
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import OrderItems from "@/components/market/OrderItems";
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { formatTaipei, formatTwd } from "@/lib/market/format";
import { fetchOrdersByToken, TOKEN_PATTERN } from "@/lib/market/lookup";
import { ORDER_STATUS_LABEL } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import MarketNotFound from "./MarketNotFound";

export default function MarketOrderLookupPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get("new") === "1";
  const valid = TOKEN_PATTERN.test(token);
  useMarketTitle("訂單查詢");
  const { data: orders, isLoading, isError, refetch } = useQuery({
    queryKey: ["market", "lookup", token],
    queryFn: () => fetchOrdersByToken(token),
    enabled: valid,
  });
  const [copied, setCopied] = useState<boolean | null>(null);
  const pageUrl = typeof window === "undefined" ? "" : `${window.location.origin}/market/orders/${token}`;

  if (!valid || (!isLoading && !isError && !orders)) {
    return <MarketNotFound message="找不到這筆訂單。請確認網址完整(從確認信裡的連結打開最保險)。" />;
  }
  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6" aria-busy="true">
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (isError || !orders) {
    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-16 text-center text-red-800">
        訂單載入失敗。
        <button type="button" onClick={() => void refetch()} className={`ml-2 underline ${MARKET_FOCUS_RING}`}>
          再試一次
        </button>
      </div>
    );
  }

  const first = orders[0];
  const copy = () => {
    navigator.clipboard?.writeText(pageUrl).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-900">訂單查詢</h1>

      {isNew ? (
        <div role="status" className="space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
          <p className="font-semibold">訂單已送出,共 {orders.length} 張(每家店一張)。店家接單後會寄信通知你。</p>
          <p className="text-sm">這個網址就是你的訂單查詢頁,請加入書籤或複製保存,不要分享給別人:</p>
          <div className="flex flex-wrap gap-2">
            <input readOnly value={pageUrl} aria-label="訂單查詢網址" className="min-h-11 min-w-0 flex-1 rounded-md border border-emerald-300 bg-white px-3 text-sm" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={copy} className={`min-h-11 rounded-md border border-emerald-400 bg-white px-4 text-sm font-medium ${MARKET_FOCUS_RING}`}>
              複製連結
            </button>
          </div>
          {copied === true ? <p className="text-sm">已複製。</p> : null}
          {copied === false ? <p className="text-sm">沒辦法自動複製,請長按上面的網址手動複製。</p> : null}
        </div>
      ) : null}

      <section aria-labelledby="lookup-buyer" className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <h2 id="lookup-buyer" className="mb-2 font-semibold text-slate-900">
          收件資料
        </h2>
        <p>
          {first.buyer_name}・{first.buyer_phone}・{first.buyer_email}
        </p>
        <p>
          {first.ship_city}
          {first.ship_address}
        </p>
        {first.buyer_note ? <p className="text-slate-600">備註:{first.buyer_note}</p> : null}
      </section>

      {orders.map((o) => (
        <section key={o.id} aria-labelledby={`lookup-${o.id}`} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id={`lookup-${o.id}`} className="text-lg font-semibold text-slate-900">
              {o.store.name}
              <span className="ml-2 text-sm font-normal text-slate-500">訂單 {formatOrderNo(o.id)}</span>
            </h2>
            <p className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900">{ORDER_STATUS_LABEL[o.status]}</p>
          </div>
          <p className="text-sm text-slate-600">
            {formatTaipei(o.created_at)} 下單・{PAYMENT_METHODS[o.payment_method]}
          </p>

          {o.transfer_info ? (
            <div className="rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
              <p className="font-semibold">店家已接單,請匯款 {formatTwd(o.total)}:</p>
              <p className="mt-1 whitespace-pre-line">{o.transfer_info}</p>
              <p className="mt-1 text-xs">店家確認收款後就會出貨。</p>
            </div>
          ) : null}
          {(o.status === "rejected" || o.status === "cancelled") && o.status_note ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">原因:{o.status_note}</p>
          ) : null}
          {o.shipped_carrier ? (
            <p className="text-sm text-slate-800">
              物流:{o.shipped_carrier}
              {o.shipped_tracking_no ? `,單號 ${o.shipped_tracking_no}` : ""}
            </p>
          ) : null}

          <OrderItems items={o.items} subtotal={o.subtotal} shippingFee={o.shipping_fee} total={o.total} />

          <div>
            <h3 className="text-sm font-semibold text-slate-900">進度</h3>
            <ol className="mt-1 space-y-1 text-sm text-slate-700">
              {o.events.map((e, i) => (
                <li key={`${e.to_status}-${i}`}>
                  {formatTaipei(e.created_at)} {ORDER_STATUS_LABEL[e.to_status]}
                </li>
              ))}
            </ol>
          </div>

          <div className="text-sm text-slate-700">
            <h3 className="font-semibold text-slate-900">聯絡店家</h3>
            {o.store.phone ? (
              <p>
                電話:
                <a href={`tel:${o.store.phone}`} className={`text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                  {o.store.phone}
                </a>
              </p>
            ) : null}
            {o.store.contact_email ? (
              <p>
                Email:
                <a href={`mailto:${o.store.contact_email}`} className={`text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                  {o.store.contact_email}
                </a>
              </p>
            ) : null}
            {o.store.return_policy ? <p className="mt-1 whitespace-pre-line text-slate-600">退換貨:{o.store.return_policy}</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  10 passed (10)`(3 + 7)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/lib/market/lookup.ts src/lib/market/lookup.test.ts src/components/market/OrderItems.tsx src/pages/market/MarketOrderLookupPage.tsx src/pages/market/MarketOrderLookupPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): token 訂單查詢頁(剛下單提示與複製連結、匯款資訊、進度、明細)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 52:掛上購物車、結帳、查詢、條款路由

**Files:**
- Modify: `src/App.tsx`(市集 import 與 `/market` 底下的路由)
- Test: `src/App.market-routes.test.tsx`

**Step 1:寫失敗的測試**

在 `src/App.market-routes.test.tsx` 找到:

```tsx
// 主站(前台)路由表:/market 底下三頁掛在 MarketLayout 裡、免登入;市集裡打錯網址顯示市集自己的找不到頁。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
```

換成:

```tsx
// 主站(前台)路由表:/market 底下的頁面掛在 MarketLayout 裡、免登入;市集裡打錯網址顯示市集自己的找不到頁。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
```

在 `src/App.market-routes.test.tsx` 找到:

```tsx
  });

  it("/market 底下打錯的網址顯示市集的找不到頁,不是全站 NotFound", async () => {
    renderAt("/market/nope/123");
```

換成:

```tsx
  });

  it("購物車、條款、隱私權政策都在市集版面裡", async () => {
    renderAt("/market/cart");
    expect(await screen.findByText("購物車是空的。")).toBeInTheDocument();
    cleanup();
    renderAt("/market/terms");
    expect(await screen.findByRole("heading", { level: 1, name: "食材市集服務條款" })).toBeInTheDocument();
    cleanup();
    renderAt("/market/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "食材市集隱私權政策" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "跳到主要內容" })).toBeInTheDocument();
  });

  it("/market 底下打錯的網址顯示市集的找不到頁,不是全站 NotFound", async () => {
    renderAt("/market/nope/123");
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/App.market-routes.test.tsx`

Expected:1 failed,`Unable to find an element with the text: 購物車是空的。`(`/market/cart` 還落在市集的找不到頁)

**Step 3:改 `src/App.tsx`**

在 `src/App.tsx` 找到:

```tsx
import MarketStorePage from "./pages/market/MarketStorePage";
import MarketNotFound from "./pages/market/MarketNotFound";

// 平台營運後台(僅 admin 站)
```

換成:

```tsx
import MarketStorePage from "./pages/market/MarketStorePage";
import MarketNotFound from "./pages/market/MarketNotFound";
import MarketCartPage from "./pages/market/MarketCartPage";
import MarketCheckoutPage from "./pages/market/MarketCheckoutPage";
import MarketOrderLookupPage from "./pages/market/MarketOrderLookupPage";
import MarketLegalPage from "./pages/market/MarketLegalPage";

// 平台營運後台(僅 admin 站)
```

在 `src/App.tsx` 找到:

```tsx
      <Route path="p/:productId" element={<MarketProductPage />} />
      <Route path="s/:supplierId" element={<MarketStorePage />} />
      <Route path="*" element={<MarketNotFound />} />
    </Route>
```

換成:

```tsx
      <Route path="p/:productId" element={<MarketProductPage />} />
      <Route path="s/:supplierId" element={<MarketStorePage />} />
      <Route path="cart" element={<MarketCartPage />} />
      <Route path="checkout" element={<MarketCheckoutPage />} />
      <Route path="orders/:token" element={<MarketOrderLookupPage />} />
      <Route path="terms" element={<MarketLegalPage doc="terms" />} />
      <Route path="privacy" element={<MarketLegalPage doc="privacy" />} />
      <Route path="*" element={<MarketNotFound />} />
    </Route>
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  3 passed (3)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/App.tsx src/App.market-routes.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 掛上購物車、結帳、訂單查詢、服務條款、隱私權政策路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 53:供應商「零售訂單」頁與訂單動作視窗

- `OrderActionDialog`(供應商與管理員共用):每個動作都先確認一次並說明後果;拒單 / 取消要原因(會寄給消費者)、出貨要物流(單號選填);送出 = `addOrderEvent`;資料庫說畫面過期(`stale_order_status`)時顯示原因、關掉視窗、重新抓清單。
- `SupplierMarketOrdersPage`:分頁「待處理(待接單 / 已接單 / 待匯款 / 已收款)」「已出貨」「已結束」並顯示件數;每張單:訂單編號、狀態、時間、付款方式、收件人(電話可直接撥)、地址、備註、原因、物流、明細、能按的動作(按鈕名稱帶訂單編號,螢幕閱讀器分得出是哪一張)。
- `orderFixtures.ts`:訂單測試假資料(只給測試用)。

**Files:**
- Create: `src/components/market/OrderActionDialog.tsx`
- Create: `src/lib/market/orderFixtures.ts`
- Create: `src/pages/supplier/SupplierMarketOrdersPage.tsx`
- Test: `src/pages/supplier/SupplierMarketOrdersPage.test.tsx`

**Step 1:寫失敗的測試**

```tsx
// 供應商「零售訂單」:分頁與件數、接單、拒單要原因、出貨要物流、畫面過期時重新整理。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/hooks/use-current-supplier", () => ({
  useCurrentSupplier: () => ({ supplierId: "a9200000-0000-4000-8000-00000000000a", loading: false, error: null }),
}));
vi.mock("@/lib/market/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/orders")>()),
  fetchSupplierOrders: vi.fn(),
  addOrderEvent: vi.fn(),
}));

import { MarketDbError } from "@/lib/market/db";
import { makeOrder } from "@/lib/market/orderFixtures";
import { addOrderEvent, fetchSupplierOrders } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import SupplierMarketOrdersPage from "./SupplierMarketOrdersPage";

const PENDING = makeOrder({ status: "pending" });
const AWAITING = makeOrder({ status: "awaiting_payment", payment_method: "transfer" });
const CONFIRMED = makeOrder({ status: "confirmed" });
const SHIPPED = makeOrder({ status: "shipped", shipped_carrier: "黑貓宅急便", shipped_tracking_no: "9001" });
const DONE = makeOrder({ status: "rejected", status_note: "缺貨" });

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SupplierMarketOrdersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(fetchSupplierOrders).mockReset().mockResolvedValue([PENDING, AWAITING, CONFIRMED, SHIPPED, DONE]);
  vi.mocked(addOrderEvent).mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  toastSuccess.mockReset();
});
afterEach(cleanup);

describe("SupplierMarketOrdersPage", () => {
  it("預設看待處理;分頁顯示件數;收件資料與明細", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "待處理(3)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "已出貨(1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已結束(1)" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    const card = within(screen.getByRole("article", { name: `訂單 ${formatOrderNo(PENDING.id)}` }));
    expect(card.getByText("待接單")).toBeInTheDocument();
    expect(card.getByRole("link", { name: "0912345678" })).toHaveAttribute("href", "tel:0912345678");
    expect(card.getByText("有機高麗菜")).toBeInTheDocument();
    expect(card.getByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` })).toBeInTheDocument();
    expect(card.getByRole("button", { name: `拒單 ${formatOrderNo(PENDING.id)}` })).toBeInTheDocument();
  });

  it("接單:確認後新增紀錄、成功訊息、重新抓清單", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定接單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PENDING, "confirmed", { reason: "", carrier: "", trackingNo: "" });
    await waitFor(() => expect(fetchSupplierOrders).toHaveBeenCalledTimes(2));
    expect(toastSuccess).toHaveBeenCalledWith(`訂單 ${formatOrderNo(PENDING.id)} 已改成「已接單」`);
  });

  it("拒單:沒填原因擋下來;填了才送", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `拒單 ${formatOrderNo(PENDING.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫原因(會告知消費者)");
    expect(addOrderEvent).not.toHaveBeenCalled();
    await userEvent.type(dialog.getByLabelText("原因(必填,會寄給消費者)"), "今天缺貨");
    await userEvent.click(dialog.getByRole("button", { name: "確定拒單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PENDING, "rejected", { reason: "今天缺貨", carrier: "", trackingNo: "" });
  });

  it("轉帳待匯款:確認已收款;貨到付款已接單:出貨要填物流", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: `確認已收款 ${formatOrderNo(AWAITING.id)}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `出貨 ${formatOrderNo(CONFIRMED.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "確定出貨" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("請填寫物流");
    await userEvent.type(dialog.getByLabelText("物流(必填)"), "黑貓宅急便");
    await userEvent.type(dialog.getByLabelText("物流單號(選填)"), "9001");
    await userEvent.click(dialog.getByRole("button", { name: "確定出貨" }));
    expect(addOrderEvent).toHaveBeenCalledWith(CONFIRMED, "shipped", { reason: "", carrier: "黑貓宅急便", trackingNo: "9001" });
  });

  it("畫面過期(別人剛處理過):顯示原因、關掉視窗、重新抓清單", async () => {
    vi.mocked(addOrderEvent).mockRejectedValue(new MarketDbError({ message: "stale", code: "P0001", hint: "stale_order_status" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: `接單 ${formatOrderNo(PENDING.id)}` }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "確定接單" }));
    expect(toastError).toHaveBeenCalledWith("沒有改成功", { description: "這張訂單剛被處理過,畫面已重新整理,請再確認一次" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchSupplierOrders).toHaveBeenCalledTimes(2);
  });

  it("已出貨分頁:物流單號、標記完成;已結束分頁:原因、沒有按鈕", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "已出貨(1)" }));
    expect(screen.getByText("物流:黑貓宅急便,單號 9001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `標記完成 ${formatOrderNo(SHIPPED.id)}` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已結束(1)" }));
    const card = within(screen.getByRole("article"));
    expect(card.getByText("原因:缺貨")).toBeInTheDocument();
    expect(card.queryByRole("button")).toBeNull();
  });
});
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/SupplierMarketOrdersPage.test.tsx`

Expected:FAIL,`Failed to resolve import "@/lib/market/orderFixtures"`

**Step 3:寫實作**

`src/lib/market/orderFixtures.ts`(只給測試用):

```ts
// 零售訂單的測試假資料(只給 *.test.tsx 用,正式程式不會 import)。
import type { MarketOrderRow } from "./orders";
import { SUPPLIER_A } from "./testFixtures";

let seq = 0;
export const makeOrder = (over: Partial<MarketOrderRow> = {}): MarketOrderRow => {
  seq += 1;
  return {
    id: `a9600000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    checkout_id: "a9500000-0000-4000-8000-000000000001",
    supplier_id: SUPPLIER_A,
    status: "pending",
    buyer_name: "王小明",
    buyer_phone: "0912345678",
    buyer_email: "buyer@example.com",
    ship_city: "臺北市",
    ship_address: "測試路 1 號 2 樓",
    buyer_note: null,
    subtotal: 650,
    shipping_fee: 120,
    total: 770,
    payment_method: "cod",
    status_note: null,
    shipped_carrier: null,
    shipped_tracking_no: null,
    created_at: "2026-10-09T04:05:00Z",
    updated_at: "2026-10-09T04:05:00Z",
    market_order_items: [
      { product_name: "有機高麗菜", spec: "1 顆", temperature: "chilled", unit_price: 100, qty: 2, line_total: 200 },
      { product_name: "牛肉片", spec: "300g/盒", temperature: "frozen", unit_price: 450, qty: 1, line_total: 450 },
    ],
    ...over,
  };
};
```

`src/components/market/OrderActionDialog.tsx`:

```tsx
// 改零售訂單狀態的確認視窗(供應商零售訂單頁、管理員訂單總覽共用):
// 拒單 / 取消要填原因(會寄給消費者)、出貨要填物流(單號選填),其他動作只確認一次。
// 送出 = addOrderEvent(新增一筆狀態紀錄);資料庫說畫面過期(stale_order_status)時一樣關掉視窗、重新整理清單。
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LIMITS } from "@/lib/market/constants";
import { friendlyDbError, MarketDbError } from "@/lib/market/db";
import { addOrderEvent, ORDER_ACTIONS, ORDER_STATUS_LABEL, validateOrderAction, type MarketOrderRow, type OrderStatus } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";

interface OrderActionDialogProps {
  target: { order: MarketOrderRow; to: OrderStatus } | null;
  onClose: () => void;
  /** 成功或畫面過期:重新抓清單 */
  onChanged: () => void;
}

const DESCRIPTIONS: Partial<Record<OrderStatus, string>> = {
  confirmed: "接單後消費者會收到 Email 通知;選銀行轉帳的訂單會自動轉成「待匯款」,消費者會看到你的匯款資訊。",
  rejected: "拒單後訂單不成立。原因會寄給消費者。",
  paid: "確認你已經收到這筆轉帳,接著就可以出貨。",
  shipped: "消費者會收到出貨通知,信裡有物流與單號。",
  completed: "消費者已經收到貨、這筆交易結束。",
  cancelled: "取消後訂單不成立,原因會寄給消費者(管理員取消時也會通知店家不要出貨)。",
};

export default function OrderActionDialog({ target, onClose, onChanged }: OrderActionDialogProps) {
  const [reason, setReason] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReason("");
    setCarrier("");
    setTrackingNo("");
    setError(null);
  }, [target]);

  const meta = target ? ORDER_ACTIONS[target.to] : undefined;

  const submit = async () => {
    if (!target) return;
    const input = { reason, carrier, trackingNo };
    const invalid = validateOrderAction(target.to, input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      await addOrderEvent(target.order, target.to, input);
      toast.success(`訂單 ${formatOrderNo(target.order.id)} 已改成「${ORDER_STATUS_LABEL[target.to]}」`);
      onClose();
      onChanged();
    } catch (e) {
      const stale = e instanceof MarketDbError && e.hint === "stale_order_status";
      toast.error("沒有改成功", { description: friendlyDbError(e) });
      if (stale) {
        onClose();
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {target && meta ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {meta.label}:訂單 {formatOrderNo(target.order.id)}
              </DialogTitle>
              <DialogDescription>{DESCRIPTIONS[target.to]}</DialogDescription>
            </DialogHeader>
            {meta.needsReason ? (
              <div className="space-y-1.5">
                <Label htmlFor="market-order-reason">原因(必填,會寄給消費者)</Label>
                <Textarea id="market-order-reason" rows={3} maxLength={LIMITS.orderNote} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            ) : null}
            {meta.needsCarrier ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="market-order-carrier">物流(必填)</Label>
                  <Input id="market-order-carrier" placeholder="例如:黑貓宅急便、自行配送" maxLength={LIMITS.carrier} value={carrier} onChange={(e) => setCarrier(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="market-order-tracking">物流單號(選填)</Label>
                  <Input id="market-order-tracking" maxLength={LIMITS.trackingNo} value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                返回
              </Button>
              <Button
                className={meta.danger ? "bg-red-600 text-white hover:bg-red-700" : "bg-emerald-700 text-white hover:bg-emerald-800"}
                disabled={busy}
                onClick={() => void submit()}
              >
                確定{meta.label}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
```

`src/pages/supplier/SupplierMarketOrdersPage.tsx`:

```tsx
// 供應商後台「零售市集 › 零售訂單」(/supplier/market/orders):消費者的訂單(跟餐廳詢價訂單完全分開)。
// 分頁:待處理(待接單 / 已接單 / 待匯款 / 已收款)、已出貨、已結束。每張單:收件資料、明細、付款方式、能按的動作。
// 動作:接單、拒單(填原因)、確認已收款(轉帳)、出貨(填物流與單號)、完成、取消(填原因)—— 實際規則在資料庫的轉移表。
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import OrderActionDialog from "@/components/market/OrderActionDialog";
import OrderItems from "@/components/market/OrderItems";
import { useCurrentSupplier } from "@/hooks/use-current-supplier";
import { PAYMENT_METHODS } from "@/lib/market/constants";
import { formatTaipei } from "@/lib/market/format";
import {
  fetchSupplierOrders,
  OPEN_STATUSES,
  ORDER_ACTIONS,
  ORDER_STATUS_LABEL,
  supplierActions,
  type MarketOrderRow,
  type OrderStatus,
} from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";

const TABS: Array<{ key: string; label: string; statuses: readonly OrderStatus[] }> = [
  { key: "open", label: "待處理", statuses: OPEN_STATUSES },
  { key: "shipped", label: "已出貨", statuses: ["shipped"] },
  { key: "closed", label: "已結束", statuses: ["completed", "rejected", "cancelled"] },
];

export default function SupplierMarketOrdersPage() {
  const { supplierId, loading: idLoading, error: idError } = useCurrentSupplier();
  const orders = useQuery({
    queryKey: ["market", "supplier-orders", supplierId],
    queryFn: () => fetchSupplierOrders(supplierId as string),
    enabled: !!supplierId,
  });
  const [tab, setTab] = useState("open");
  const [target, setTarget] = useState<{ order: MarketOrderRow; to: OrderStatus } | null>(null);

  const rows = useMemo(() => orders.data ?? [], [orders.data]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, rows.filter((o) => t.statuses.includes(o.status)).length])), [rows]);
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const shown = rows.filter((o) => current.statuses.includes(o.status));

  if (idError) return <p className="p-6 text-red-700">{idError}</p>;

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售訂單</h1>
      <p className="mb-4 text-sm text-slate-500">消費者在食材市集下的訂單。貨款由你直接收(貨到付款 / 銀行轉帳),發票由你開立。消費者會收到每一步的 Email 通知。</p>

      <div role="group" aria-label="訂單分類" className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button key={t.key} size="sm" variant={tab === t.key ? "secondary" : "outline"} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}({counts[t.key] ?? 0})
          </Button>
        ))}
      </div>

      {idLoading || orders.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : orders.isError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800">
          訂單載入失敗,請重新整理再試一次。
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-500">沒有{current.label}的訂單</p>
      ) : (
        <ul className="space-y-4">
          {shown.map((o) => {
            const no = formatOrderNo(o.id);
            return (
              <li key={o.id}>
                <article aria-labelledby={`market-order-${o.id}`} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id={`market-order-${o.id}`} className="font-semibold text-slate-900">
                      訂單 {no}
                    </h2>
                    <Badge variant="outline">{ORDER_STATUS_LABEL[o.status]}</Badge>
                    <span className="text-sm text-slate-500">
                      {formatTaipei(o.created_at)}・{PAYMENT_METHODS[o.payment_method]}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <div className="space-y-1 text-sm">
                      <p className="font-medium text-slate-900">{o.buyer_name}</p>
                      <p>
                        <a href={`tel:${o.buyer_phone}`} className="text-emerald-800 underline">
                          {o.buyer_phone}
                        </a>
                        ・{o.buyer_email}
                      </p>
                      <p>
                        {o.ship_city}
                        {o.ship_address}
                      </p>
                      {o.buyer_note ? <p className="text-slate-600">備註:{o.buyer_note}</p> : null}
                      {o.status_note ? <p className="text-red-700">原因:{o.status_note}</p> : null}
                      {o.shipped_carrier ? (
                        <p className="text-slate-700">
                          物流:{o.shipped_carrier}
                          {o.shipped_tracking_no ? `,單號 ${o.shipped_tracking_no}` : ""}
                        </p>
                      ) : null}
                    </div>
                    <OrderItems items={o.market_order_items} subtotal={o.subtotal} shippingFee={o.shipping_fee} total={o.total} />
                  </div>
                  {supplierActions(o).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                      {supplierActions(o).map((to) => {
                        const meta = ORDER_ACTIONS[to];
                        if (!meta) return null;
                        return (
                          <Button
                            key={to}
                            size="sm"
                            variant={meta.danger ? "outline" : "default"}
                            className={meta.danger ? "text-red-700" : "bg-emerald-700 text-white hover:bg-emerald-800"}
                            aria-label={`${meta.label} ${no}`}
                            onClick={() => setTarget({ order: o, to })}
                          >
                            {meta.label}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <OrderActionDialog target={target} onClose={() => setTarget(null)} onChanged={() => void orders.refetch()} />
    </div>
  );
}
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  6 passed (6)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/components/market/OrderActionDialog.tsx src/lib/market/orderFixtures.ts src/pages/supplier/SupplierMarketOrdersPage.tsx src/pages/supplier/SupplierMarketOrdersPage.test.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 供應商零售訂單頁(接單、拒單、收款、出貨、完成、取消)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 54:供應商「零售市集」分區加「零售訂單」分頁與路由

分區的入口改成零售訂單(每天要看的),分頁:零售訂單、店家設定。

**Files:**
- Modify: `src/pages/supplier/SupplierLayout.tsx`(`market` 分區)
- Modify: `src/App.tsx`(import 與 `/supplier` 底下的路由)
- Test: `src/pages/supplier/SupplierLayout.test.tsx`

**Step 1:改測試**

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
          <Route path="reviews" element={<h1>我的評價頁</h1>} />
          <Route path="market/store" element={<h1>店家設定頁</h1>} />
        </Route>
      </Routes>
```

換成:

```tsx
          <Route path="reviews" element={<h1>我的評價頁</h1>} />
          <Route path="market/store" element={<h1>店家設定頁</h1>} />
          <Route path="market/orders" element={<h1>零售訂單頁</h1>} />
        </Route>
      </Routes>
```

在 `src/pages/supplier/SupplierLayout.test.tsx` 找到:

```tsx
    ["/supplier/customers", "客戶管理頁", "客戶與評價", ["客戶", "評價"], "客戶"],
    ["/supplier/reviews", "我的評價頁", "客戶與評價", ["客戶", "評價"], "評價"],
    // 零售市集第 1 階段只有一個分頁 → 不畫分頁列
    ["/supplier/market/store", "店家設定頁", "零售市集", null as string[] | null, null as string | null],
  ])("%s → 頁面 %s,分區「%s」", (path, heading, sectionLabel, expectedTabs, activeTab) => {
    renderLayout(path);
```

換成:

```tsx
    ["/supplier/customers", "客戶管理頁", "客戶與評價", ["客戶", "評價"], "客戶"],
    ["/supplier/reviews", "我的評價頁", "客戶與評價", ["客戶", "評價"], "評價"],
    ["/supplier/market/orders", "零售訂單頁", "零售市集", ["零售訂單", "店家設定"], "零售訂單"],
    ["/supplier/market/store", "店家設定頁", "零售市集", ["零售訂單", "店家設定"], "店家設定"],
  ])("%s → 頁面 %s,分區「%s」", (path, heading, sectionLabel, expectedTabs, activeTab) => {
    renderLayout(path);
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/supplier/SupplierLayout.test.tsx`

Expected:2 failed(`/supplier/market/orders`、`/supplier/market/store` 兩列),`Unable to find an accessible element with the role "tab"`

**Step 3:改 `SupplierLayout.tsx` 與 `App.tsx`**

在 `src/pages/supplier/SupplierLayout.tsx` 找到:

```tsx
    // 消費者食材市集(B2C):跟餐廳的詢價訂單完全分開。零售商品在「商品與價格 › 商品目錄」的「零售商品」分頁
    key: "market",
    to: "/supplier/market/store",
    label: "零售市集",
    icon: Store,
    match: startsWithAny(["/supplier/market"]),
    tabs: [{ label: "店家設定", path: "/supplier/market/store" }],
  },
];
```

換成:

```tsx
    // 消費者食材市集(B2C):跟餐廳的詢價訂單完全分開。零售商品在「商品與價格 › 商品目錄」的「零售商品」分頁
    key: "market",
    to: "/supplier/market/orders",
    label: "零售市集",
    icon: Store,
    match: startsWithAny(["/supplier/market"]),
    tabs: [
      { label: "零售訂單", path: "/supplier/market/orders" },
      { label: "店家設定", path: "/supplier/market/store" },
    ],
  },
];
```

在 `src/App.tsx` 找到:

```tsx
import SupplierReviewsPage from "./pages/supplier/SupplierReviewsPage";
import SupplierMarketStorePage from "./pages/supplier/SupplierMarketStorePage";

// 餐廳後台(僅前台站)
```

換成:

```tsx
import SupplierReviewsPage from "./pages/supplier/SupplierReviewsPage";
import SupplierMarketStorePage from "./pages/supplier/SupplierMarketStorePage";
import SupplierMarketOrdersPage from "./pages/supplier/SupplierMarketOrdersPage";

// 餐廳後台(僅前台站)
```

在 `src/App.tsx` 找到:

```tsx
      {/* 零售市集(B2C) */}
      <Route path="market/store" element={<SupplierMarketStorePage />} />
    </Route>

```

換成:

```tsx
      {/* 零售市集(B2C) */}
      <Route path="market/store" element={<SupplierMarketStorePage />} />
      <Route path="market/orders" element={<SupplierMarketOrdersPage />} />
    </Route>

```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  25 passed (25)`

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/supplier/SupplierLayout.tsx src/pages/supplier/SupplierLayout.test.tsx src/App.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 供應商後台零售市集分區加零售訂單分頁與路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 55:管理後台「零售訂單」總覽

篩選:進行中 / 已出貨 / 已結束 / 全部;搜尋訂單編號、收件人、電話、Email、店名;「查看」看收件資料、明細與時間軸(標出是消費者 / 店家 / 平台 / 系統做的);唯一的動作是「平台取消」(要原因;消費者與店家都會收到通知,出貨後不能取消)。接單、出貨是店家的事,管理員不代勞。

**Files:**
- Create: `src/pages/admin/AdminMarketOrdersPage.tsx`
- Modify: `src/pages/admin/AdminLayout.tsx`(`market` 分區的分頁)
- Modify: `src/App.tsx`(import 與 `AdminRoutes` 的路由)
- Test: `src/pages/admin/AdminMarketOrdersPage.test.tsx`、`src/pages/admin/AdminRoutes.test.tsx`、`src/pages/admin/AdminLayout.test.tsx`(只改註解)

**Step 1:寫失敗的測試**

`src/pages/admin/AdminMarketOrdersPage.test.tsx`:

```tsx
// 管理後台「零售訂單」:預設進行中、搜尋、查看完整內容與時間軸、平台取消要原因、出貨後不能取消。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, toastSuccess } = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("@/lib/market/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/market/orders")>()),
  fetchAdminOrders: vi.fn(),
  addOrderEvent: vi.fn(),
}));

import { makeOrder } from "@/lib/market/orderFixtures";
import { addOrderEvent, fetchAdminOrders } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";
import AdminMarketOrdersPage from "./AdminMarketOrdersPage";

const STORE = { suppliers: { name: "市集測試 A 店" } };
const PENDING = makeOrder({
  market_stores: STORE,
  market_order_events: [{ to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00Z" }],
});
const SHIPPED = makeOrder({
  status: "shipped",
  buyer_name: "林小華",
  buyer_phone: "0922000111",
  market_stores: STORE,
  market_order_events: [
    { to_status: "shipped", actor_role: "supplier", note: null, created_at: "2026-10-09T06:00:00Z" },
    { to_status: "pending", actor_role: "consumer", note: null, created_at: "2026-10-09T04:05:00Z" },
  ],
});

beforeEach(() => {
  vi.mocked(fetchAdminOrders).mockReset().mockResolvedValue([PENDING, SHIPPED]);
  vi.mocked(addOrderEvent).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("AdminMarketOrdersPage", () => {
  it("預設抓進行中;換篩選重新抓;搜尋電話只留符合的", async () => {
    render(<AdminMarketOrdersPage />);
    expect(fetchAdminOrders).toHaveBeenCalledWith("open");
    expect(await screen.findByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "搜尋訂單編號、收件人、電話、Email、店名" }), "0922");
    expect(screen.queryByText(`${formatOrderNo(PENDING.id)}・市集測試 A 店`)).toBeNull();
    expect(screen.getByText(`${formatOrderNo(SHIPPED.id)}・市集測試 A 店`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(fetchAdminOrders).toHaveBeenLastCalledWith("all");
  });

  it("查看:收件資料、明細、時間軸(照時間排、標出是誰做的)", async () => {
    render(<AdminMarketOrdersPage />);
    await userEvent.click(await screen.findByRole("button", { name: `查看 ${formatOrderNo(SHIPPED.id)}` }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("林小華・0922000111・buyer@example.com")).toBeInTheDocument();
    expect(dialog.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "2026/10/09 12:05 待接單(消費者)",
      "2026/10/09 14:00 已出貨(店家)",
    ]);
    expect(dialog.queryByRole("button", { name: "平台取消" })).toBeNull();
  });

  it("平台取消:要填原因;送出後重新載入清單", async () => {
    render(<AdminMarketOrdersPage />);
    await userEvent.click(await screen.findByRole("button", { name: `查看 ${formatOrderNo(PENDING.id)}` }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "平台取消" }));
    const confirm = await screen.findByRole("dialog", { name: `取消訂單:訂單 ${formatOrderNo(PENDING.id)}` });
    await userEvent.click(within(confirm).getByRole("button", { name: "確定取消訂單" }));
    expect(within(confirm).getByRole("alert")).toHaveTextContent("請填寫原因");
    await userEvent.type(within(confirm).getByLabelText("原因(必填,會寄給消費者)"), "疑似假單");
    await userEvent.click(within(confirm).getByRole("button", { name: "確定取消訂單" }));
    expect(addOrderEvent).toHaveBeenCalledWith(PENDING, "cancelled", { reason: "疑似假單", carrier: "", trackingNo: "" });
    await waitFor(() => expect(fetchAdminOrders).toHaveBeenCalledTimes(2));
  });
});
```

`src/pages/admin/AdminRoutes.test.tsx`:

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
// 管理員站(VITE_PORTAL=admin)的真實路由表:用 App.tsx 本身渲染,不是複製一份路由。
// 驗證:①原本 26 條管理員路由(2026-10 加零售市集 2 條,共 28 條)全部打得開、渲染的是原本那個頁面 ②每一條落在正確的分區與分頁
//       ③唯一的轉址 /admin/orders/:id/timeline → /admin/orders/:id 真的換了網址
//       ④每一頁都有 AI 泡泡、主內容底部留白 pb-40 還在。
```

換成:

```tsx
// 管理員站(VITE_PORTAL=admin)的真實路由表:用 App.tsx 本身渲染,不是複製一份路由。
// 驗證:①原本 26 條管理員路由(2026-10 加零售市集 3 條,共 29 條)全部打得開、渲染的是原本那個頁面 ②每一條落在正確的分區與分頁
//       ③唯一的轉址 /admin/orders/:id/timeline → /admin/orders/:id 真的換了網址
//       ④每一頁都有 AI 泡泡、主內容底部留白 pb-40 還在。
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
vi.mock("./AdminMarketProductsPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketProductsPage"));
vi.mock("./AdminMarketStoresPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketStoresPage"));

const ORDER_TABS = ["看板", "全部訂單", "爭議"];
```

換成:

```tsx
vi.mock("./AdminMarketProductsPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketProductsPage"));
vi.mock("./AdminMarketStoresPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketStoresPage"));
vi.mock("./AdminMarketOrdersPage", async () => (await import("./testRouteStub")).stubPage("AdminMarketOrdersPage"));

const ORDER_TABS = ["看板", "全部訂單", "爭議"];
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
const SYSTEM_TABS = ["AI 用量", "通知紀錄", "投資人頁內容"];
const OVERVIEW_TABS = ["營運", "成長"];
const MARKET_TABS = ["商品審核", "零售店家"];

// [網址, 渲染的頁面, 側欄分區, 分頁列(null = 不畫分頁列), 選中的分頁]
```

換成:

```tsx
const SYSTEM_TABS = ["AI 用量", "通知紀錄", "投資人頁內容"];
const OVERVIEW_TABS = ["營運", "成長"];
const MARKET_TABS = ["商品審核", "零售店家", "零售訂單"];

// [網址, 渲染的頁面, 側欄分區, 分頁列(null = 不畫分頁列), 選中的分頁]
```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
  ["/admin/market/products", "AdminMarketProductsPage", "零售市集", MARKET_TABS, "商品審核"],
  ["/admin/market/stores", "AdminMarketStoresPage", "零售市集", MARKET_TABS, "零售店家"],
];

```

換成:

```tsx
  ["/admin/market/products", "AdminMarketProductsPage", "零售市集", MARKET_TABS, "商品審核"],
  ["/admin/market/stores", "AdminMarketStoresPage", "零售市集", MARKET_TABS, "零售店家"],
  ["/admin/market/orders", "AdminMarketOrdersPage", "零售市集", MARKET_TABS, "零售訂單"],
];

```

在 `src/pages/admin/AdminRoutes.test.tsx` 找到:

```tsx
      "/admin/orders/:id/timeline", // 轉址,見下一組測試
    ];
    expect(declared).toHaveLength(28);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
```

換成:

```tsx
      "/admin/orders/:id/timeline", // 轉址,見下一組測試
    ];
    expect(declared).toHaveLength(29);
    expect([...declared].sort()).toEqual([...covered].sort());
  });
```

`src/pages/admin/AdminLayout.test.tsx`(註解):

在 `src/pages/admin/AdminLayout.test.tsx` 找到:

```tsx
//   ① AI 助手泡泡每一頁都看得到,而且是純對話(admin 模式)。
//   ② 後台精簡第一期:選單 23 項 → 7 個分區,分區裡用分頁(SectionTabs);金流/發票從選單收起來;
//      2026-10 加第 8 個分區「零售市集」(消費者食材市集的商品審核、零售店家);
//      「會員 › 入駐審核」分頁帶待審數。
//
```

換成:

```tsx
//   ① AI 助手泡泡每一頁都看得到,而且是純對話(admin 模式)。
//   ② 後台精簡第一期:選單 23 項 → 7 個分區,分區裡用分頁(SectionTabs);金流/發票從選單收起來;
//      2026-10 加第 8 個分區「零售市集」(消費者食材市集的商品審核、零售店家、零售訂單);
//      「會員 › 入駐審核」分頁帶待審數。
//
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run src/pages/admin/AdminMarketOrdersPage.test.tsx src/pages/admin/AdminRoutes.test.tsx src/pages/admin/AdminLayout.test.tsx`

Expected:`AdminMarketOrdersPage.test.tsx` FAIL `Failed to resolve import "./AdminMarketOrdersPage"`;`AdminRoutes.test.tsx` 4 failed(分頁列 `expected [ '商品審核', '零售店家' ] to deeply equal [ '商品審核', '零售店家', '零售訂單' ]`、`/admin/market/orders` 找不到頁面、`to have a length of 29 but got 28`)。

**Step 3:寫實作**

`src/pages/admin/AdminMarketOrdersPage.tsx`:

```tsx
// 管理後台「零售市集 › 零售訂單」(/admin/market/orders):所有店家的零售訂單總覽(處理客訴用)。
// 篩選:進行中 / 已出貨 / 已結束 / 全部;搜尋:訂單編號、收件人、電話、Email、店名(在已載入的清單裡找)。
// 「查看」看完整內容與時間軸;唯一能做的動作是「平台取消」(填原因,消費者與店家都會收到通知)。接單、出貨是店家的事。
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import OrderActionDialog from '@/components/market/OrderActionDialog';
import OrderItems from '@/components/market/OrderItems';
import { PAYMENT_METHODS } from '@/lib/market/constants';
import { friendlyDbError } from '@/lib/market/db';
import { formatTaipei, formatTwd } from '@/lib/market/format';
import { adminActions, fetchAdminOrders, ORDER_STATUS_LABEL, type AdminOrderFilter, type MarketOrderRow, type OrderStatus } from '@/lib/market/orders';
import { formatOrderNo } from '@/lib/order-number';

const FILTERS: Array<{ key: AdminOrderFilter; label: string }> = [
  { key: 'open', label: '進行中' },
  { key: 'shipped', label: '已出貨' },
  { key: 'closed', label: '已結束' },
  { key: 'all', label: '全部' },
];

const ACTOR_LABEL: Record<string, string> = { consumer: '消費者', supplier: '店家', admin: '平台', system: '系統' };

const matches = (o: MarketOrderRow, q: string) => {
  const needle = q.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  return [formatOrderNo(o.id).slice(1), o.buyer_name, o.buyer_phone, o.buyer_email, o.market_stores?.suppliers?.name ?? '']
    .some((v) => v.toLowerCase().includes(needle));
};

const AdminMarketOrdersPage = () => {
  const [filter, setFilter] = useState<AdminOrderFilter>('open');
  const [rows, setRows] = useState<MarketOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<MarketOrderRow | null>(null);
  const [target, setTarget] = useState<{ order: MarketOrderRow; to: OrderStatus } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAdminOrders(filter)
      .then((list) => !cancelled && setRows(list))
      .catch((e) => toast.error('載入失敗', { description: friendlyDbError(e) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filter, reload]);

  const shown = useMemo(() => rows.filter((o) => matches(o, query)), [rows, query]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-800">零售訂單</h1>
      <p className="mb-4 text-sm text-slate-500">消費者在食材市集的訂單(每家店一張)。平台不經手貨款;這裡用來查詢與處理客訴,必要時可以平台取消。</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="訂單狀態" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'outline'} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </Button>
          ))}
        </div>
        <Input aria-label="搜尋訂單編號、收件人、電話、Email、店名" placeholder="搜尋訂單編號、收件人、電話、Email、店名" value={query} onChange={(e) => setQuery(e.target.value)} className="max-w-xs" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" aria-label="載入中" />
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white py-10 text-center text-slate-400">沒有符合的訂單</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {shown.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-800">
                  {formatOrderNo(o.id)}・{o.market_stores?.suppliers?.name ?? '—'}
                </p>
                <p className="text-xs text-slate-500">
                  {formatTaipei(o.created_at)}・{o.buyer_name}・{o.ship_city}・{PAYMENT_METHODS[o.payment_method]}・{formatTwd(o.total)}
                </p>
              </div>
              <Badge variant="outline">{ORDER_STATUS_LABEL[o.status]}</Badge>
              <Button size="sm" variant="outline" onClick={() => setDetail(o)} aria-label={`查看 ${formatOrderNo(o.id)}`}>
                查看
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  訂單 {formatOrderNo(detail.id)}・{ORDER_STATUS_LABEL[detail.status]}
                </DialogTitle>
                <DialogDescription>
                  {detail.market_stores?.suppliers?.name ?? '—'}・{PAYMENT_METHODS[detail.payment_method]}・{formatTaipei(detail.created_at)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1 text-sm">
                <p>
                  {detail.buyer_name}・{detail.buyer_phone}・{detail.buyer_email}
                </p>
                <p>
                  {detail.ship_city}
                  {detail.ship_address}
                </p>
                {detail.buyer_note ? <p className="text-slate-600">備註:{detail.buyer_note}</p> : null}
                {detail.status_note ? <p className="text-red-700">原因:{detail.status_note}</p> : null}
              </div>
              <OrderItems items={detail.market_order_items} subtotal={detail.subtotal} shippingFee={detail.shipping_fee} total={detail.total} />
              <div>
                <h2 className="text-sm font-semibold text-slate-900">時間軸</h2>
                <ol className="mt-1 space-y-1 text-sm text-slate-700">
                  {[...(detail.market_order_events ?? [])]
                    .sort((a, b) => a.created_at.localeCompare(b.created_at))
                    .map((e, i) => (
                      <li key={`${e.to_status}-${i}`}>
                        {formatTaipei(e.created_at)} {ORDER_STATUS_LABEL[e.to_status]}({ACTOR_LABEL[e.actor_role] ?? e.actor_role})
                        {e.note ? `:${e.note}` : ''}
                      </li>
                    ))}
                </ol>
              </div>
              {adminActions(detail).includes('cancelled') ? (
                <div className="flex justify-end">
                  <Button variant="outline" className="text-red-700" onClick={() => setTarget({ order: detail, to: 'cancelled' })}>
                    平台取消
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <OrderActionDialog
        target={target}
        onClose={() => setTarget(null)}
        onChanged={() => {
          setDetail(null);
          setReload((n) => n + 1);
        }}
      />
    </div>
  );
};

export default AdminMarketOrdersPage;
```

`src/pages/admin/AdminLayout.tsx`:

在 `src/pages/admin/AdminLayout.tsx` 找到:

```tsx
  },
  {
    // 消費者食材市集(B2C,2026-10):商品審核、零售店家(第 2 階段加零售訂單)
    key: 'market',
    to: '/admin/market/products',
```

換成:

```tsx
  },
  {
    // 消費者食材市集(B2C,2026-10):商品審核、零售店家、零售訂單
    key: 'market',
    to: '/admin/market/products',
```

在 `src/pages/admin/AdminLayout.tsx` 找到:

```tsx
      { label: '商品審核', path: '/admin/market/products' },
      { label: '零售店家', path: '/admin/market/stores' },
    ],
  },
```

換成:

```tsx
      { label: '商品審核', path: '/admin/market/products' },
      { label: '零售店家', path: '/admin/market/stores' },
      { label: '零售訂單', path: '/admin/market/orders' },
    ],
  },
```

`src/App.tsx`:

在 `src/App.tsx` 找到:

```tsx
import AdminMarketProductsPage from "./pages/admin/AdminMarketProductsPage";
import AdminMarketStoresPage from "./pages/admin/AdminMarketStoresPage";

// 供應商後台(僅前台站)
```

換成:

```tsx
import AdminMarketProductsPage from "./pages/admin/AdminMarketProductsPage";
import AdminMarketStoresPage from "./pages/admin/AdminMarketStoresPage";
import AdminMarketOrdersPage from "./pages/admin/AdminMarketOrdersPage";

// 供應商後台(僅前台站)
```

在 `src/App.tsx` 找到:

```tsx
      <Route path="market/products" element={<AdminMarketProductsPage />} />
      <Route path="market/stores" element={<AdminMarketStoresPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
```

換成:

```tsx
      <Route path="market/products" element={<AdminMarketProductsPage />} />
      <Route path="market/stores" element={<AdminMarketStoresPage />} />
      <Route path="market/orders" element={<AdminMarketOrdersPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`Tests  66 passed (66)`(3 + 35 + 28)

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add src/pages/admin/AdminMarketOrdersPage.tsx src/pages/admin/AdminMarketOrdersPage.test.tsx src/pages/admin/AdminLayout.tsx src/pages/admin/AdminLayout.test.tsx src/pages/admin/AdminRoutes.test.tsx src/App.tsx
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(market): 管理後台零售訂單總覽(搜尋、時間軸、平台取消)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 56:第 2 階段全套檢查與 `docs/DEPLOY.md`

**Step 1:全部 vitest**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && VITE_SUPABASE_URL=https://ci-placeholder.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=ci-placeholder-key npx vitest run > /tmp/market-p2-vitest.log 2>&1; grep -E "Test Files|Tests " /tmp/market-p2-vitest.log`

Expected:`Test Files  111 passed (111)`、`Tests  1428 passed (1428)`

**Step 2:tsc / eslint / 兩種 build**(指令見「F. 共用指令」)

Expected:tsc `72`、eslint `10`、兩個 build 都印 `0`。

**Step 3:把下面整段接在 `docs/DEPLOY.md` 最後面(第 1 階段那一節後面)**

````markdown

### 第 2 階段:購物車、免註冊下單、訂單通知(migration 20261009130000 / 130100 / 130200、Edge Function `market-notify`)

- **130000 market_orders**:`market_orders`(每家店一張;收件資料、小計 / 運費 / 總額、付款方式、查詢 token 的 sha256、
  預留 `payment_status` / `payment_ref` 給之後的線上付款)、`market_order_items`(下單當下的品名 / 規格 / 單價快照)、
  `market_order_events`(只能新增)。狀態只經 events 改變:guard(BEFORE)依登入身分決定 actor、檢查目前狀態(畫面過期回 `stale_order_status`)、
  轉移表 `market_transition_rules()`、原因 / 物流;apply(AFTER)改訂單狀態、拒單 / 取消時把庫存加回去、轉帳訂單接單後自動轉成「待匯款」。
  ```
  貨到付款:pending → confirmed → shipped → completed
  銀行轉帳:pending → confirmed →(自動)awaiting_payment → paid → shipped → completed
  pending → rejected(拒單,要原因);pending / confirmed / awaiting_payment → cancelled(取消,要原因;店家或平台)
  ```
  anon 對三張表完全沒有權限;供應商讀自家、管理員全部;只有 events 開放 INSERT(guard 再擋)。
- **130100 market_notify**:每筆狀態紀錄 → pg_net → `market-notify`;共用既有的 `app_config.notify_service_key`(= secret `NOTIFY_SECRET`,不新增 secret)。
- **130200 market_checkout**:
  - `market_place_order(p_checkout)`(anon 可叫):伺服器重查商品是否上架、價格、庫存、配送範圍、最低金額、付款方式(轉帳要店家填了轉帳資訊),
    算運費(小計 ≥ 免運門檻 → 0)、扣庫存、每家店一張單;同一次結帳共用一組 43 字的查詢 token(DB 只存 sha256 hex)。
    前端送的 `expected_totals` 跟伺服器算的不一樣 → `PRICE_CHANGED`,不建單。商業錯誤一律回 `{ok:false, code}`,不 raise。
  - `market_get_orders(p_token)`(anon 可叫):用 token 查那次結帳的訂單;電話、Email 遮罩;轉帳資訊只在「待匯款」時給。
  - `market_checkout_status()`:`{open, can_order}`,前端用來決定要不要讓人進結帳;真正的關卡在 `market_place_order`。
  - 防灌單 `market_rate_take`(新寫的,不沿用 `ai_rate_take`,理由見實作計畫「關鍵技術決定」):同 IP 每小時 5 / 每天 20(拿不到 IP 不算)、
    同 Email(去 +tag、gmail 去點)每小時 3 / 每天 10、同電話每天 10、全站每天 500(`DAILY_CAP`);IP / Email / 電話只以加鹽雜湊落地,
    計數表 `market_rate_counters` 每天 19:50 UTC 清掉 2 天前的列(pg_cron `ifoodmap-market-rate-cleanup`);平台管理員不限流。
  - **下單開關** `app_config.market_checkout_open`(預設 `'false'`):關著的時候只有平台管理員能下單(業主實測用),其他人拿到 `MARKET_CLOSED`。
    🔴 改成 `'true'` = 對外開放,**待業主核准**。
- **Edge Function `market-notify`**(`supabase/functions/market-notify/`,邏輯在 `handler.ts`,vitest 測):
  下單確認(含查詢連結,只有這一封有 token)、新訂單 → 店家、接單 / 待匯款(含匯款資訊)/ 拒單 / 出貨 / 取消 → 消費者、平台取消 → 也通知店家。
  🔴 **寄信閘門 `MARKET_NOTIFY_LIVE`**:不是字串 `true` 時,所有信只寄 `ifoodmaptw@gmail.com`、主旨加「[測試轉寄]」、內文最前面列出原收件人。
  寄給真實消費者要業主核准 —— **待業主核准**,不要自己設定這個 secret。
  每封都記一筆 `notifications`(後台「通知紀錄」看得到;不含 token)。

### 部署(第 2 階段,照這個順序)

1. migration(130000 → 130100 → 130200,每支用 `node scripts/supabase-sql.mjs apply …`)。套完 130200 確認 `market_checkout_open` 是 `false`。
2. Edge Function(🔴 一定要 `--no-verify-jwt`:呼叫者是資料庫,沒有使用者 JWT;靠 `NOTIFY_SECRET` 驗證):
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy market-notify --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
   ```
   部署後 `GET https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/functions/market-notify` 確認 `verify_jwt: false`。
   它讀的 secret 全部是既有的(`NOTIFY_SECRET`、`RESEND_API_KEY`、`NOTIFY_FROM`、`SITE_URL`、`SUPPLIER_MAIL_REPLY_TO` / `LEAD_NOTIFY_TO`)。
3. **push 前端**(產品站 + 管理員站同一個 push)。
4. 驗收見實作計畫 Task 57(含 IP 標頭檢查)。

### 怎麼查(第 2 階段)

```sql
-- 被限流擋下的(bucket 只有雜湊;global = 全站每日上限)
select bucket, window_start, hits from public.market_rate_counters where window_start >= now() - interval '1 day' order by hits desc limit 20;
-- 通知有沒有寄出(閘門沒開時 recipient 都是 ifoodmaptw@gmail.com)
select created_at, recipient, title, status from public.notifications where message like '零售%' order by created_at desc limit 20;
-- pg_net 呼叫 market-notify 的結果(status_code 應該是 200)
select id, status_code, left(content::text, 120) from net._http_response order by id desc limit 10;
```

### 還原(第 2 階段)

1. 前端先退(Vercel Instant Rollback,兩個專案)——🔴 產品站會呼叫 `market_place_order` / `market_get_orders`。
2. 資料庫(130200 → 130100 → 130000,curl 方式送 `supabase/rollbacks/` 底下對應的 `.down.sql`)。🔴 130000 的還原會刪掉所有零售訂單,先匯出。
3. `market-notify` 不用刪(沒人呼叫就不會寄信);repo 裡三支 migration 一起 revert。
````

**Step 4:確認接對了**

Run:`grep -n "^### 第 2 階段\|^### 部署(第 2 階段\|^### 怎麼查(第 2 階段)\|^### 還原(第 2 階段)" /Users/aimand/.gemini/File/ifoodmap/docs/DEPLOY.md`

Expected:四行,行號遞增,都在第 1 階段那一節後面。

**Step 5:Commit**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add docs/DEPLOY.md
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
docs(market): DEPLOY.md 加消費者食材市集第 2 階段(訂單、下單 RPC、限流、market-notify、寄信閘門)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 57:第 2 階段部署與驗收

🔴 會改正式庫、部署 Edge Function、部署兩個網站。照順序做,每一步的 Expected 對不上就停。**不准**設定 `MARKET_NOTIFY_LIVE`、不准改 `market_checkout_open`(兩個都待業主核准)。

**Step 1:確認本機乾淨、跟 origin 同步**(同 Task 31 Step 1;`rev-list` 不是 `0` 就停)

**Step 2:上線前最後一次乾跑(第 2 階段全部)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
C=supabase/migrations/20261009120000_market_catalog.sql
O=supabase/migrations/20261009130000_market_orders.sql
N=supabase/migrations/20261009130100_market_notify.sql
K=supabase/migrations/20261009130200_market_checkout.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql --with-migration $C --with-migration $O
node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql --with-migration $C --with-migration $O --with-migration $N
node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql --with-migration $C --with-migration $O --with-migration $N --with-migration $K
node scripts/supabase-sql.mjs dry supabase/tests/database/market_phase2_rollback.test.sql --with-migration $C --with-migration $O --with-migration $N --with-migration $K --with-rollback supabase/rollbacks/20261009130200_market_checkout.down.sql --with-rollback supabase/rollbacks/20261009130100_market_notify.down.sql --with-rollback supabase/rollbacks/20261009130000_market_orders.down.sql
node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
```

Expected:依序 `共 45 項` / `共 9 項` / `共 56 項` / `共 4 項`,全部 `失敗 0 項`;殘留五個 `0`。

**Step 3:套 migration(130000 → 130100 → 130200)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
node scripts/supabase-sql.mjs apply supabase/migrations/20261009130000_market_orders.sql
node scripts/supabase-sql.mjs apply supabase/migrations/20261009130100_market_notify.sql
node scripts/supabase-sql.mjs apply supabase/migrations/20261009130200_market_checkout.sql
```

Expected:三行 `已套用 …;ledger:[{"version":"2026100913xx00","name":"…"}]`(版本與名稱對應各檔)。

**Step 4:確認線上 schema**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" && Q=$(mktemp) && cat > "$Q" <<'SQL'
SELECT json_build_object(
  'ledger', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
              WHERE m.version IN ('20261009130000', '20261009130100', '20261009130200')),
  'event_triggers', (SELECT json_agg(t.tgname ORDER BY t.tgname) FROM pg_trigger t
                      WHERE t.tgrelid = 'public.market_order_events'::regclass AND NOT t.tgisinternal),
  'anon_can_read_orders', has_table_privilege('anon', 'public.market_orders', 'SELECT'),
  'anon_can_insert_events', has_table_privilege('anon', 'public.market_order_events', 'INSERT'),
  'anon_rpc', json_build_object(
    'place_order', has_function_privilege('anon', 'public.market_place_order(jsonb)', 'EXECUTE'),
    'get_orders', has_function_privilege('anon', 'public.market_get_orders(text)', 'EXECUTE'),
    'checkout_status', has_function_privilege('anon', 'public.market_checkout_status()', 'EXECUTE'),
    'rate_take', has_function_privilege('anon', 'public.market_rate_take(jsonb)', 'EXECUTE')),
  'checkout_open', (SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'),
  'notify_url_ok', (SELECT c.value = 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify'
                      FROM public.app_config c WHERE c.key = 'market_notify_function_url'),
  'rate_salt_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'market_rate_salt' AND c.value ~ '^[0-9a-f]{32}$'),
  'rate_cleanup_cron', (SELECT j.schedule FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup')
) AS phase2;
SQL
node scripts/supabase-sql.mjs ro "$Q"
```

Expected:`ledger` 三個版本;`event_triggers` = `["trg_market_apply_event", "trg_market_events_immutable", "trg_market_events_one_per_order", "trg_market_guard_event", "trg_market_notify_event"]`;`anon_can_read_orders` 與 `anon_can_insert_events` 都是 `false`;`anon_rpc` = `{"place_order": true, "get_orders": true, "checkout_status": true, "rate_take": false}`;`checkout_open` = `"false"`;`notify_url_ok`、`rate_salt_set` 都是 `true`;`rate_cleanup_cron` = `"50 19 * * *"`。

**Step 5:用線上 schema 再跑一次測試(不帶 `--with-migration`)**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql
node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql
node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
```

Expected:`共 45 項` / `共 9 項` / `共 56 項`,全部 `失敗 0 項`;殘留五個 `0`(測試在交易裡改的通知網址、下單開關都跟著回滾)。

**Step 6:部署 Edge Function `market-notify`**

```bash
cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" supabase functions deploy market-notify --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
```

Expected:`Deployed Functions on project cwvpehqcvbfuynabpqop: market-notify`。接著確認 JWT 驗證是關的、沒密鑰會被擋:

```bash
export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/functions/market-notify -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);console.log(f.slug,f.status,"verify_jwt="+f.verify_jwt)})'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify -H "Content-Type: application/json" -d '{"kind":"event","event_id":"00000000-0000-4000-8000-000000000000"}'
```

Expected:`market-notify ACTIVE verify_jwt=false`;沒帶密鑰的 POST 回 `401`。(`verify_jwt=true` 的話資料庫的通知會全部 401:重新用上面那一行帶 `--no-verify-jwt` 部署。)

**Step 7:push 前端,等部署**(同 Task 31 Step 6)

**Step 8:線上自我檢查**

8-1 anon 呼叫 RPC 與讀表:

```bash
export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
PK=$(curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/api-keys -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.type==="publishable");process.stdout.write(k?k.api_key:"")})')
API=https://cwvpehqcvbfuynabpqop.supabase.co/rest/v1
curl -s -X POST "$API/rpc/market_checkout_status" -H "apikey: $PK" -H "Content-Type: application/json" -d '{}'; echo
curl -s -X POST "$API/rpc/market_get_orders" -H "apikey: $PK" -H "Content-Type: application/json" -d '{"p_token":"x"}'; echo
curl -s -o /dev/null -w 'orders %{http_code}\n' "$API/market_orders?select=id&limit=1" -H "apikey: $PK"
```

Expected:`{"open": false, "can_order": false}`、`{"ok": false, "code": "NOT_FOUND"}`、`orders 401`。

8-2 **IP 標頭檢查**(限流用的 IP 必須是偽造不了的那一個;下單開關關著,這次嘗試只會留下限流計數、不會建單)。接著 8-1 同一個 shell 跑(要用到 `$API`、`$PK`):

```bash
MYIP=$(curl -s -4 https://api.ipify.org); EMAIL="ip-check-$(date +%s)@example.com"
curl -s -X POST "$API/rpc/market_place_order" -H "apikey: $PK" -H "Content-Type: application/json" \
  -H "X-Forwarded-For: 203.0.113.9" -H "X-Real-IP: 203.0.113.10" -H "CF-Connecting-IP: 203.0.113.11" \
  -d "{\"p_checkout\":{\"buyer\":{\"name\":\"IP 檢查\",\"phone\":\"0900000000\",\"email\":\"$EMAIL\",\"city\":\"臺北市\",\"address\":\"只是檢查不會建單\"},\"items\":[],\"terms_version\":\"ip-check\"}}"; echo
cd /Users/aimand/.gemini/File/ifoodmap && Q=$(mktemp) && cat > "$Q" <<'SQL'
WITH s AS (SELECT c.value AS salt FROM public.app_config c WHERE c.key = 'market_rate_salt'),
     cand(source, ip) AS (VALUES ('real', '__MYIP__'), ('x-forwarded-for', '203.0.113.9'), ('x-real-ip', '203.0.113.10'), ('cf-connecting-ip', '203.0.113.11'))
SELECT json_agg(json_build_object('source', cand.source, 'counted', EXISTS (
         SELECT 1 FROM public.market_rate_counters r
          WHERE r.bucket = 'ip:' || left(encode(sha256(convert_to(cand.ip || '|' || s.salt, 'UTF8')), 'hex'), 16) || '|1h'
            AND r.window_start > now() - interval '2 hours')) ORDER BY cand.source) AS ip_check
  FROM cand, s;
SQL
sed -i '' "s/__MYIP__/$MYIP/" "$Q" && node scripts/supabase-sql.mjs ro "$Q"
```

Expected:第一個指令回 `{"ok": false, "code": "MARKET_CLOSED"}`;查詢結果只有 `"source": "real"` 是 `"counted": true`,三個偽造的都是 `false`。

- 偽造的有一個是 `true` → 那個標頭偽造得了:IP 額度可以被繞過(Email、電話、全站上限仍有效)。停下來回報,建議把 `market_client_ip()` 改成只認 Supabase 實際使用的那個標頭(另開 migration)。
- 四個全是 `false` → PostgREST 拿不到 IP 標頭,IP 那兩條額度形同沒有。一樣回報。

8-3 頁面:`https://app.ifoodmap.ai/market/cart`(空購物車)、`/market/terms`、`/market/privacy` 用 `node ~/.claude/tools/cdp-shot.mjs <網址> 375 812 market-main /tmp/market-p2-shots` 與 1280×800 各截一次:`docW` 等於視窗寬;preview(`sips -Z 1024`)看得到內容,條款頁最上面有「草稿」。`/market/orders/abc` 顯示「找不到這筆訂單…」。

**Step 9:派一個沒參與實作的 agent 獨立驗收**(fresh context;只准讀、乾跑、唯讀查詢;不准改檔、不准 apply、不准輸入密碼、不准設定任何 secret 或 `app_config`)

- [ ] ledger 有 `20261009130000`、`130100`、`130200`;`check-migrations` 綠燈;`market-notify` 是 ACTIVE 且 `verify_jwt=false`。
- [ ] 用線上 schema 乾跑 `market_orders`(45)、`market_notify`(9)、`market_checkout`(56)全過;殘留五個 0。
- [ ] 資料庫層的五件事(設計稿「驗證方式」):下單 RPC 改不了價格(測試「金額是伺服器算的」)、庫存不足 / 超出配送範圍 / 未達最低金額被擋、anon 讀不到訂單、不合法的狀態轉換被擋、供應商讀不到別家資料 —— 在乾跑輸出裡逐項指出對應的檢查名稱。
- [ ] anon:`market_checkout_status` = `{open:false, can_order:false}`;直接讀 `market_orders` 被拒;亂填 token 是 `NOT_FOUND`。
- [ ] IP 標頭檢查的結果(Step 8-2)符合預期,或已回報。
- [ ] `MARKET_NOTIFY_LIVE` 沒有被設定(`supabase secrets list --project-ref cwvpehqcvbfuynabpqop` 只看名稱,不印值;清單裡不能有它)、`market_checkout_open` 還是 `false`。
- [ ] 375 / 1280 下 `/market/cart`、`/market/terms`、`/market/privacy` 沒有橫向捲動;結帳頁、查詢頁的表單欄位都有 label(讀 `src/pages/market/MarketCheckoutPage.tsx` 確認)。
- [ ] 讀過這一階段的 commit:token 沒有出現在 `market-notify` 的回應 / log / `notifications`(看 `handler.ts` 與它的測試)、沒有 `any`、沒有密鑰。
- [ ] 回報格式:每一項 ✅ / ❌ + 證據。

有 ❌:照 `docs/DEPLOY.md`「還原(第 2 階段)」判斷要不要退版,回報派工者。


---

## 第 3 階段:對外開放(Task 58–60)

做完這一階段:有一支「開放前檢查」查詢、`docs/DEPLOY.md` 寫清楚開放步驟、形象站入口在分支 `market-launch` 準備好、業主用測試店家完整實測過一輪。**對外開放下單、對真實消費者寄信、合併形象站入口、條款定稿都待業主核准**,不在這份計畫裡執行。

先決條件:第 2 階段已經部署並通過驗收(Task 57)。

### Task 58:開放前檢查查詢與 `docs/DEPLOY.md` 第 3 階段

唯讀查詢,只回數字與 true / false(不印任何密鑰的值);業主決定開放前、以及之後營運時都可以跑。這個 Task 在 `main` 上做。

**Files:**
- Create: `supabase/tests/database/market_launch_readiness.sql`
- Modify: `docs/DEPLOY.md`(接在檔尾)

**Step 1:寫查詢**

```sql
-- 消費者食材市集:對外開放前的現況檢查(唯讀;只回數字與 true/false,不印任何密鑰的值)
--   SUPABASE_ACCESS_TOKEN=… node scripts/supabase-sql.mjs ro supabase/tests/database/market_launch_readiness.sql
-- 第 3 階段「部署與驗收」與業主決定開放前各跑一次;每一項的期望值見計畫 Task 58。
SELECT json_build_object(
  'migrations', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
                  WHERE m.version IN ('20261009120000', '20261009120100', '20261009130000', '20261009130100', '20261009130200')),
  'stores_open', (SELECT count(*) FROM public.market_stores s WHERE public.market_store_is_open(s.supplier_id)),
  'stores_open_without_contact_email', (SELECT count(*) FROM public.market_stores s JOIN public.suppliers sp ON sp.id = s.supplier_id
                                         WHERE public.market_store_is_open(s.supplier_id) AND COALESCE(btrim(sp.contact_email), '') = ''),
  'stores_transfer_without_info', (SELECT count(*) FROM public.market_stores s
                                    WHERE 'transfer' = ANY (s.payment_methods)
                                      AND NOT EXISTS (SELECT 1 FROM public.market_store_transfer t WHERE t.supplier_id = s.supplier_id)),
  'products_listed', (SELECT count(*) FROM public.market_products p
                       WHERE p.review_status = 'approved' AND p.is_listed AND public.market_store_is_open(p.supplier_id)),
  'products_pending_review', (SELECT count(*) FROM public.market_products p WHERE p.review_status = 'pending'),
  'products_pending_over_2_days', (SELECT count(*) FROM public.market_products p
                                    WHERE p.review_status = 'pending' AND p.submitted_at < now() - interval '2 days'),
  'orders_total', (SELECT count(*) FROM public.market_orders),
  'orders_pending_over_1_day', (SELECT count(*) FROM public.market_orders o WHERE o.status = 'pending' AND o.created_at < now() - interval '1 day'),
  'notify_failed_7_days', (SELECT count(*) FROM public.notifications n
                            WHERE n.status = 'failed' AND n.created_at > now() - interval '7 days' AND n.message LIKE '零售%'),
  'checkout_open', (SELECT c.value = 'true' FROM public.app_config c WHERE c.key = 'market_checkout_open'),
  'notify_url_ok', (SELECT c.value = 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify'
                      FROM public.app_config c WHERE c.key = 'market_notify_function_url'),
  'notify_key_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'notify_service_key' AND length(c.value) >= 20),
  'rate_salt_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'market_rate_salt' AND c.value ~ '^[0-9a-f]{32}$'),
  'rate_cleanup_cron', (SELECT j.schedule FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup'),
  'image_bucket', (SELECT json_build_object('public', b.public, 'file_size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types)
                     FROM storage.buckets b WHERE b.id = 'market-images'),
  'image_policies', (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname LIKE 'market images %'),
  'anon_can_read_orders', has_table_privilege('anon', 'public.market_orders', 'SELECT'),
  'anon_can_place_order', has_function_privilege('anon', 'public.market_place_order(jsonb)', 'EXECUTE')
) AS readiness;
```

**Step 2:對正式庫跑一次**

Run:`cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" node scripts/supabase-sql.mjs ro supabase/tests/database/market_launch_readiness.sql`

Expected(固定的值):`migrations` 五個版本(`20261009120000`、`120100`、`130000`、`130100`、`130200`)、`checkout_open` `false`、`notify_url_ok` `true`、`notify_key_set` `true`、`rate_salt_set` `true`、`rate_cleanup_cron` `"50 19 * * *"`、`image_bucket` `{"public": true, "file_size_limit": 2097152, "mime_types": ["image/jpeg", "image/png", "image/webp"]}`、`image_policies` `4`、`anon_can_read_orders` `false`、`anon_can_place_order` `true`。其他是營運數字(店家、商品、訂單、寄信失敗),照實記下來;`stores_transfer_without_info` 一定是 `0`(資料庫 guard 擋)。
(2026-10-09 在乾跑裡套完五支 migration 實測:欄位齊全,值如上,營運數字全部 0。)

**Step 3:把下面整段接在 `docs/DEPLOY.md` 最後面(第 2 階段那一節後面)**

````markdown

### 第 3 階段:對外開放(形象站入口;各項開關待業主核准)

- 形象站首頁「食材分類」標題旁的入口「個人也能買：逛食材市集 →」(`marketUrl` = 產品站 `/market`,`landing/index.html`)。
  第 3 階段的程式在分支 `market-launch`,**業主核准對外開放後**才合併到 main(push main 會自動部署形象站)。
- 開放前跑一次現況檢查(唯讀,只回數字與 true/false):
  ```bash
  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/supabase-sql.mjs ro supabase/tests/database/market_launch_readiness.sql
  ```
- 業主實測一輪(閘門都還關著:信只寄 `ifoodmaptw@gmail.com`、只有平台管理員能下單),步驟見實作計畫 Task 60。
- **待業主核准**(這幾項不在實作計畫裡執行,業主點頭後另開任務):
  1. 對外開放下單(`app_config.market_checkout_open`)
  2. 對真實消費者與店家寄信(`MARKET_NOTIFY_LIVE`)—— 建議跟第 1 項一起開:只開下單不開寄信,消費者收不到確認信,只能靠下單完成頁的連結
  3. 服務條款與隱私權政策定稿(`src/lib/market/legal.ts`:改文字、`LEGAL_DRAFT = false`、`TERMS_VERSION` 換新版本)
  4. 合併 `market-launch`(形象站入口)
  5. Supabase 升級 Pro(免費方案閒置會暫停 = 市集關店)
````

**Step 4:確認接對了**

Run:`grep -n "^### 第 3 階段" /Users/aimand/.gemini/File/ifoodmap/docs/DEPLOY.md`

Expected:一行,在第 2 階段那一節後面。

**Step 5:Commit(這一步在 main;下一個 Task 才開分支)**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add supabase/tests/database/market_launch_readiness.sql docs/DEPLOY.md
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
docs(market): 開放前檢查查詢與 DEPLOY.md 第 3 階段(對外開放各項待業主核准)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

### Task 59:形象站入口(分支 `market-launch`,先不合併)

首頁「食材分類」標題旁加一個連結「個人也能買：逛食材市集 →」(英文「Buying for home? Visit the Food Market →」),網址 `marketUrl` 跟其他產品站網址一樣從 `IFM_PRODUCT_BASE_URL` 推出來(`landing/index.html:2604-2608`)。顏色 `#0E6B40`(白底對比約 6.6:1)、加底線。形象站的連結檢查只准綁定變數,所以 `tests/i18n.test.cjs` 的白名單要加 `marketUrl`。

**Files:**
- Modify: `landing/index.html:973-976`(標題區加連結)、`landing/index.html:2604-2608`(加 `marketUrl`)
- Modify: `landing/i18n.js:74`(中文)、`landing/i18n.js:771`(英文)
- Test: `landing/tests/content.test.cjs`、`landing/tests/i18n.test.cjs`

**Step 0:開分支(從已經部署第 2 階段的 main)**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap switch -c market-launch
```

**Step 1:寫失敗的測試**

`landing/tests/content.test.cjs`:

在 `landing/tests/content.test.cjs` 找到:

```js
  assert.match(home, /<a[^>]+href="\{\{\s*restaurantRegistrationUrl\s*\}\}"[^>]*>免費註冊會員<\/a>/);
  assertMobileLogin(footer);
});

```

換成:

```js
  assert.match(home, /<a[^>]+href="\{\{\s*restaurantRegistrationUrl\s*\}\}"[^>]*>免費註冊會員<\/a>/);
  assertMobileLogin(footer);
});

test('home links to the consumer food market on the product site (/market)', () => {
  // 消費者食材市集(2026-10):入口在首頁「食材分類」標題旁,網址一樣從 IFM_PRODUCT_BASE_URL 推出來
  assert.match(source, /marketUrl:\s*productBaseUrl \+ '\/market'/);
  assert.match(home, /<a href="\{\{ marketUrl \}\}" class="mc-catmarket"[^>]*>個人也能買：逛食材市集 →<\/a>/);
  assert.equal(dict('en').home.marketCta, 'Buying for home? Visit the Food Market →');
});

```

`landing/tests/i18n.test.cjs`(連結白名單):

在 `landing/tests/i18n.test.cjs` 找到:

```js
      // d.href 是法律文件在 sc-for 裡逐份算出來的網址(pageToPath 產的,已帶語系前綴);
      // t.href 是同一頁目錄的 #錨點,不跨頁也不跨語系。
      /^\{\{ (href[A-Za-z]*|langHref|loginUrl|restaurantRegistrationUrl|supplierApplicationUrl|a\.href|lk\.href|q\.linkHref|d\.href|t\.href) \}\}$/,
      `internal link must be a binding, got ${href}`,
    );
```

換成:

```js
      // d.href 是法律文件在 sc-for 裡逐份算出來的網址(pageToPath 產的,已帶語系前綴);
      // t.href 是同一頁目錄的 #錨點,不跨頁也不跨語系。
      // marketUrl 跟 loginUrl 一樣是產品站的網址(產品站沒有語系前綴,中英兩版都連到同一個 /market)。
      /^\{\{ (href[A-Za-z]*|langHref|loginUrl|restaurantRegistrationUrl|supplierApplicationUrl|marketUrl|a\.href|lk\.href|q\.linkHref|d\.href|t\.href) \}\}$/,
      `internal link must be a binding, got ${href}`,
    );
```

**Step 2:跑測試,確認失敗**

Run:`cd /Users/aimand/.gemini/File/ifoodmap/landing && npm test > /tmp/market-landing-test.log 2>&1; grep -E "^ℹ (tests|pass|fail)|^✖ " /tmp/market-landing-test.log`

Expected:`ℹ tests 212`、`ℹ pass 211`、`ℹ fail 1`,失敗的是 `home links to the consumer food market on the product site (/market)`。

**Step 3:寫實作**

`landing/index.html`:

在 `landing/index.html` 找到:

```html
          <h2 style="font-size:clamp(26px,3.4vw,38px)">{{ L.home.categoriesTitle }}</h2>
          <p class="mc-catsub" style="font-size:14px;color:#4B5A52;font-weight:300">{{ L.home.categoriesSub }}</p>
        </div>
        <div class="mc-catgrid" style="margin-top:34px;display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:0;border-top:1px solid #E1E7E3;border-left:1px solid #E1E7E3;border-radius:12px;overflow:hidden">
```

換成:

```html
          <h2 style="font-size:clamp(26px,3.4vw,38px)">{{ L.home.categoriesTitle }}</h2>
          <p class="mc-catsub" style="font-size:14px;color:#4B5A52;font-weight:300">{{ L.home.categoriesSub }}</p>
          <a href="{{ marketUrl }}" class="mc-catmarket" style="font-size:14.5px;font-weight:700;color:#0E6B40;text-decoration:underline;text-underline-offset:3px">{{ L.home.marketCta }}</a>
        </div>
        <div class="mc-catgrid" style="margin-top:34px;display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:0;border-top:1px solid #E1E7E3;border-left:1px solid #E1E7E3;border-radius:12px;overflow:hidden">
```

在 `landing/index.html` 找到:

```html
      supplierApplicationUrl: productBaseUrl + '/join',
      loginUrl: productBaseUrl + '/',
    };

```

換成:

```html
      supplierApplicationUrl: productBaseUrl + '/join',
      loginUrl: productBaseUrl + '/',
      // 消費者食材市集(2026-10,產品站 /market):一般消費者直接向供應商下單
      marketUrl: productBaseUrl + '/market',
    };

```

`landing/i18n.js`:

在 `landing/i18n.js` 找到:

```js
        "rpFeaturesAria": "例行採購的功能",
        "categoriesSub": "從產地、工廠、大盤到小盤商",
        "testimonialsTitle": "使用者怎麼說",
        "quoteOpen": "「",
```

換成:

```js
        "rpFeaturesAria": "例行採購的功能",
        "categoriesSub": "從產地、工廠、大盤到小盤商",
        "marketCta": "個人也能買：逛食材市集 →",
        "testimonialsTitle": "使用者怎麼說",
        "quoteOpen": "「",
```

在 `landing/i18n.js` 找到:

```js
        "rpFeaturesAria": "Routine purchasing features",
        "categoriesSub": "From farms and factories to wholesalers and local distributors",
        "testimonialsTitle": "What Users Say",
        "quoteOpen": "“",
```

換成:

```js
        "rpFeaturesAria": "Routine purchasing features",
        "categoriesSub": "From farms and factories to wholesalers and local distributors",
        "marketCta": "Buying for home? Visit the Food Market →",
        "testimonialsTitle": "What Users Say",
        "quoteOpen": "“",
```

**Step 4:跑測試,確認通過**

Run:同 Step 2。Expected:`ℹ tests 212`、`ℹ pass 212`、`ℹ fail 0`。

畫面(不能有橫向捲動):

```bash
cd /Users/aimand/.gemini/File/ifoodmap/landing && (npx --yes serve -s . -l 4399 > /tmp/market-landing-serve.log 2>&1 &) && sleep 4
mkdir -p /tmp/market-landing-shots
node ~/.claude/tools/cdp-shot.mjs http://localhost:4399/ 375 812 how-it-works /tmp/market-landing-shots
node ~/.claude/tools/cdp-shot.mjs http://localhost:4399/en 1280 800 how-it-works /tmp/market-landing-shots
```

Expected:兩行輸出的 `docW` 分別是 `375`、`1280`。再用瀏覽器開 `http://localhost:4399/` 與 `/en`,捲到「食材分類 / Ingredient Categories」:連結在標題列(手機換到下一行)、指向 `https://app.ifoodmap.ai/market`。看完 `pkill -f "serve -s . -l 4399"` 關掉伺服器。

**Step 5:Commit(在分支 `market-launch` 上;不要 push、不要合併)**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap add landing/index.html landing/i18n.js landing/tests/content.test.cjs landing/tests/i18n.test.cjs
git -C /Users/aimand/.gemini/File/ifoodmap commit -m "$(cat <<'MSG'
feat(landing): 首頁食材分類加「個人也能買：逛食材市集」入口(待業主核准對外開放後合併)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
git -C /Users/aimand/.gemini/File/ifoodmap switch main
```

### Task 60:第 3 階段部署與驗收(業主實測)

**Step 1:確認狀態**

```bash
git -C /Users/aimand/.gemini/File/ifoodmap status --short
git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count HEAD..origin/main
git -C /Users/aimand/.gemini/File/ifoodmap log --oneline main..market-launch
```

Expected:沒有未 commit 的變更;`rev-list` 印 `0`(不是 0 就停);`market-launch` 比 main 多一個 commit(形象站入口)。

**Step 2:push main 上的 Task 58**(只有文件與唯讀查詢;會觸發一次產品站重新部署,內容不變)

```bash
git -C /Users/aimand/.gemini/File/ifoodmap push origin main
```

**Step 3:跑開放前檢查**(Task 58 Step 2 的指令),把結果貼給業主。要先處理的:

- `stores_open_without_contact_email` > 0:那幾家店的供應商沒有聯絡信箱,新訂單通知寄不出去 → 請店家在供應商資料補上 Email。
- `products_pending_over_2_days` > 0:有商品等審核超過 2 天 → 提醒管理員審核。
- `notify_failed_7_days` > 0:去後台「通知紀錄」看原因(多半是 Resend 或收件信箱問題)。

**Step 4:業主實測一輪**(閘門都還關著:信只寄 `ifoodmaptw@gmail.com`、只有平台管理員能下單)。把下面的清單交給業主,由業主在瀏覽器操作(🔴 代理人不准替業主輸入任何密碼);每一步打勾,有問題截圖。

1. 用**測試用的供應商帳號**(不要用真實店家)到「零售市集 › 店家設定」:配送縣市勾臺北市、運費 120、滿 1000 免運、最低 300、勾貨到付款與銀行轉帳並填轉帳資訊、上傳 logo。
2. 「商品與價格 › 商品目錄 › 零售商品」新增 2 個商品(各傳 1–2 張照片,一個限量庫存 3)→ 送審。
3. 管理員站「零售市集 › 商品審核」核准兩個商品。
4. 無痕視窗開 `https://app.ifoodmap.ai/market`:看得到商品與店家;加入購物車;購物車顯示「線上訂購還沒對外開放」(預期)。
5. 在 `app.ifoodmap.ai` 用平台管理員帳號登入後再到 `/market/cart`:顯示「你是平台管理員,可以下測試單」→ 前往結帳 → 收件 Email 填業主自己的 → 這家店選銀行轉帳 → 送出 → 看到「訂單已送出」與查詢網址。
6. `ifoodmaptw@gmail.com` 收到兩封:「[測試轉寄] 訂單已送出…」(內含查詢連結,點得開)與「[測試轉寄] 新的零售訂單…」(寄給店家的那封)。
7. 測試供應商帳號「零售市集 › 零售訂單」→ 接單 → 查詢頁出現匯款資訊;信箱收到「[測試轉寄] 請匯款…」。
8. 確認已收款 → 出貨(填物流與單號)→ 信箱收到「[測試轉寄] 已出貨…」,查詢頁顯示單號 → 標記完成。
9. 再下一張貨到付款的單,店家拒單(填原因)→ 信箱收到「[測試轉寄] 店家無法接單…」,查詢頁顯示原因,限量商品的庫存加回來。
10. 管理員站「零售市集 › 零售訂單」看得到這兩張單與時間軸。
11. 用手機實機走一次 4–5:「加入購物車」固定在畫面底部、結帳表單好填、送出後的查詢網址可以複製。
12. 實測完,管理員站「零售市集 › 零售店家」把測試店家**停用**(填原因「測試店家」),消費者就看不到它的商品。

業主做完後,代理人用唯讀查詢佐證(只看狀態,不印個資):

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat /private/tmp/claude-501/-Users-aimand--gemini-File/a4e87b5d-cc7e-48b1-99a9-949bb04fb5c2/scratchpad/.sbp)" && Q=$(mktemp) && cat > "$Q" <<'SQL'
SELECT json_build_object(
  'orders_by_status', (SELECT json_object_agg(s.status, s.n) FROM (SELECT status, count(*) AS n FROM public.market_orders GROUP BY status) s),
  'market_mails_24h', (SELECT json_object_agg(m.status, m.n) FROM (SELECT status, count(*) AS n FROM public.notifications
                        WHERE message LIKE '零售%' AND created_at > now() - interval '1 day' GROUP BY status) m),
  'forwarded_only', (SELECT bool_and(recipient = 'ifoodmaptw@gmail.com') FROM public.notifications
                      WHERE message LIKE '零售%' AND created_at > now() - interval '1 day'),
  'net_status_codes_24h', (SELECT json_object_agg(r.status_code, r.n) FROM (SELECT status_code, count(*) AS n FROM net._http_response
                            WHERE created > now() - interval '1 day' GROUP BY status_code) r)
) AS owner_test;
SQL
node scripts/supabase-sql.mjs ro "$Q"
```

Expected:`orders_by_status` 有 `completed` 1、`rejected` 1;`market_mails_24h` 全部是 `sent`(沒有 `failed`);`forwarded_only` `true`(閘門沒開,全部轉寄內部信箱);`net_status_codes_24h` 以 `200` 為主(`net._http_response` 只留最近幾小時,查不到不算失敗)。

**Step 5:待業主核准(本計畫不執行,業主點頭後另開任務)**

1. 對外開放下單(`app_config.market_checkout_open`)。
2. 對真實消費者與店家寄信(`MARKET_NOTIFY_LIVE`)—— 建議跟第 1 項一起開:只開下單不開寄信,消費者收不到確認信,只能靠下單完成頁的連結。
3. 服務條款與隱私權政策定稿(`src/lib/market/legal.ts`:改文字、`LEGAL_DRAFT = false`、`TERMS_VERSION` 換新版本;改完 `MarketLegalPage.test.tsx` 的草稿斷言跟著改)。
4. 合併 `market-launch`(形象站入口)。業主核准對外開放之後才做:`git -C /Users/aimand/.gemini/File/ifoodmap switch main && git -C /Users/aimand/.gemini/File/ifoodmap merge --no-ff market-launch` → `cd landing && npm test`(212 passed)→ `git -C /Users/aimand/.gemini/File/ifoodmap push origin main` → 等 `Landing – Deploy to Vercel (Production)` 綠燈 → 開 `https://ifoodmap.ai/` 與 `/en` 確認入口。
5. Supabase 升級 Pro(免費方案閒置會暫停 = 市集關店)。

**Step 6:派一個沒參與實作的 agent 獨立驗收**(fresh context;只准讀、唯讀查詢、跑測試;不准改檔、不准 push、不准設定任何 secret 或 `app_config`)

- [ ] 開放前檢查的固定值都符合 Task 58 Step 2;營運數字已交給業主。
- [ ] 分支 `market-launch`:`cd landing && npm test` 212 passed、0 failed;`git diff main..market-launch --stat` 只動 `landing/` 的四個檔。
- [ ] `docs/DEPLOY.md` 三個階段的部署、還原、待業主核准清單都在,而且沒有任何打開 `MARKET_NOTIFY_LIVE` 或 `market_checkout_open` 的指令。
- [ ] `MARKET_NOTIFY_LIVE` 沒有被設定(`supabase secrets list` 只看名稱)、`market_checkout_open` 還是 `false`。
- [ ] 業主實測 12 步都打勾(業主回報 + Step 4 的唯讀佐證);測試店家已停用。
- [ ] 回報格式:每一項 ✅ / ❌ + 證據。


---

## 風險與待業主決定

### 風險(依嚴重程度)

1. **限流用的 IP 可能偽造得了(上線後才驗得到)**:`market_client_ip()` 依序認 `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`,PostgREST 實際收到哪些標頭、Cloudflare / Supabase 會不會覆寫,本機與乾跑都驗不了。Task 57 Step 8-2 用三個偽造標頭打一次,查是哪個 IP 被計數。偽造得了 → IP 額度形同虛設(Email、電話、全站每天 500 單仍有效),要另開 migration 只認可信的那一個標頭。
2. **消費者拿不到或弄丟查詢連結**:token 只出現在下單完成頁與確認信;之後的接單 / 出貨信沒有連結(資料庫只有雜湊),本次也沒有「重寄連結」。寄信閘門沒開時消費者完全收不到信,只能靠完成頁的「複製連結」。→ 建議兩個閘門一起開;之後可加「輸入 Email + 訂單編號重寄連結」(要另做防濫用)。
3. **Supabase 免費方案閒置會暫停**:暫停期間市集打不開、下單失敗(= 關店),業主的待辦裡已列「升級 Pro」,對外開放前一定要處理。
4. **審核積壓、店家收不到新訂單通知**:沒有自動提醒;商品待審沒人處理就上不了架,店家的供應商資料沒有聯絡信箱就收不到新訂單信。開放前檢查(Task 58)有這兩個數字,營運初期建議每天跑一次。
5. **條款與隱私權政策是工程擬的草稿**:七天解除權例外要「事先清楚告知」才有效(準則第 3 條),目前靠結帳頁的提示與條款第五條;個資保存年限、平台責任範圍都需要法律專業確認。
6. **Storage 會累積孤兒檔**:換照片、新增商品途中取消時,已上傳的檔案留在 bucket;SQL 刪不了,量大了再用 Storage API 做清理(本次不做)。
7. **清單上限**:市集首頁一次最多抓 500 個上架商品、供應商與管理員的訂單清單一次最多 200 張;超過要改成伺服器端搜尋與分頁。
8. **寄信失敗不會自動重送**:pg_net / Resend 失敗只在 `notifications` 記 `failed`;要看後台「通知紀錄」手動處理。
9. **測試資料留在正式庫**:業主實測的訂單刪不掉(狀態紀錄只能新增),所以要用測試店家、實測後停用(Task 60 第 12 步)。
10. **違規商品只靠人工審核**:酒類、醫療宣稱、照片不是商品本身,都靠管理員在「商品審核」擋(頁首有提示),沒有自動偵測。

### 待業主決定

1. 先找哪幾家供應商願意接小量零售單、自己出貨與收款;對外開放前至少要有幾家店、幾個商品。
2. 何時對外開放下單(`app_config.market_checkout_open`)。
3. 何時對真實消費者與店家寄信(`MARKET_NOTIFY_LIVE`)—— 建議跟第 2 項同一天。
4. 服務條款與隱私權政策定稿(建議請法律專業;含個資保存年限)。
5. 何時合併形象站入口(分支 `market-launch`)。
6. Supabase 升級 Pro。
7. 限流額度(每 IP 每小時 5 單 / 每天 20、每 Email 每小時 3 / 每天 10、每電話每天 10、全站每天 500)是否合適;上線後依實際情況調。
8. 之後要不要做線上刷卡、平台抽成、消費者帳號(本次都不做;訂單已預留 `payment_status` / `payment_ref`)。

## 勘誤

### 2026-10-10:Task 1 的 `scripts/supabase-sql.mjs` 審查後加固(commit `359f69f`,分支 `market`)

Task 1–2 照本計畫做完後,獨立審查找出工具本身的漏洞,已修正。**repo 裡的 `scripts/supabase-sql.mjs` 與 `scripts/supabase-sql.test.mjs` 以這個 commit 為準,不要再照抄 Task 1 的程式碼區塊。** 乾跑(`乾跑 <檔名>(migration N 支、rollback M 支、K 句):共 X 項,失敗 Y 項`)與 `ro` 的輸出格式沒變。

**改了什麼、為什麼**

1. **乾跑可能被繞過而真的 commit**:舊的靜態切字跟 Postgres 不一致,`E'a\'b'`、識別字 `"it's"`、`a$x$`、巢狀註解 `/* /* */ $x$ */`、`--` 後面只有 `\r`、非 ASCII 的 `$標$` 都能夾帶真的 COMMIT 通過檢查。
   - **伺服器端保險**:`composeDryRun` 在 BEGIN 之後、共用工具之前多 4 句(`COMMIT_GUARD_SQL`:暫存表 + `DEFERRABLE INITIALLY DEFERRED` 的 constraint trigger + 插一列)。漏網的 COMMIT / END / PREPARE TRANSACTION 在 commit 時 RAISE `乾跑保險:…`(HINT `dry_run_commit_blocked`)、整筆回滾;正常的 ROLLBACK 不受影響。2026-10-10 在正式庫實測(COMMIT 之前只有暫存物件):回 `Management API 400 … P0001: 乾跑保險…`,前後的唯讀指紋(永久 relation / 函式數、最新 ledger 版本)不變,殘留五個 0。
   - **靜態檢查改照 Postgres 的 `scan.l` 切字**:上面 6 種都切得出 COMMIT 並拒送;沒結束的字串 / 註解 / 識別字直接拒送。repo 現有的 78 個 SQL 檔與本計畫全部 33 個 SQL 程式碼區塊,新舊切法結果完全相同,沒有誤擋。
   - 還是擋不到的只有「先漏一句 ROLLBACK、再漏一句 COMMIT」(保險跟著第一句 ROLLBACK 消失),這要兩句都騙過靜態檢查。
2. **經 symlink 或 `/tmp`(實際是 `/private/tmp`)執行時 main() 被跳過、exit 0**:改用 `realpathSync` 比對 `argv[1]` 與本檔。
3. **token 可能被印出**(中間夾換行時,fetch 的錯誤訊息含 `Bearer <token>`):送出前先驗格式(`sbp_` 加 40 位小寫十六進位;不合格 exit 2,訊息不含 token),所有錯誤訊息印出前一律把 token 遮成 `***`。
4. **apply 補 ledger**(Task 31、第 2 階段部署會用到):
   - 先用唯讀端點查 ledger:版本已經在 → `拒送:ledger 已經有版本 …`、exit 2,migration 一個字都不送(舊版會把 migration 再跑一次,而且 exit 0)。
   - ledger 的 INSERT 拿掉 `ON CONFLICT (version) DO NOTHING`:萬一版本已存在,會在同一個交易裡報 23505、連 migration 一起回滾。
   - 讀回 version / name 不符 → exit 1。這時 migration 已經套上去了:停下來回報,**不要重跑**。
   - 同一個請求最前面加 `SET LOCAL lock_timeout = '5s'`、`SET LOCAL statement_timeout = '120s'`(沒有明確 BEGIN 的多語句請求裡 SET LOCAL 有效,2026-10-10 用唯讀端點驗過)。等鎖超過 5 秒會整支回滾、ledger 不寫,等一下重跑同一行即可(Task 31 Step 3 的說明照舊適用)。
   - 成功時輸出格式不變:`已套用 <檔名>;ledger:[{"version":"…","name":"…"}]`。
5. `main()` 改成回傳 exit code(0 成功;1 乾跑有失敗 / 一項都沒有、apply 讀回不符;2 拒送、參數錯、API 錯誤),並 export 給測試用。

**Task 1 的測試字串改了哪些**(`scripts/supabase-sql.test.mjs`)

- 「從檔名取出版本與名稱」:`l.sql` 的預期值去掉結尾的 ` ON CONFLICT (version) DO NOTHING`,現在是 `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261009120000', 'market_catalog');`。
- 「migration 與 ledger 放在同一個請求」:不再以 `ON CONFLICT (version) DO NOTHING;` 結尾;改成開頭是兩句 SET LOCAL、結尾是 `VALUES ('20261009120000', 'market_catalog');`、整段不含 `ON CONFLICT`。
- 其餘 13 項照原樣;另外新增 38 項(6 種繞過寫法、不誤擋、沒結束的字串 / 註解 / 識別字、保險的位置、token、main() 的 exit code、apply、經 symlink 執行)。

**數字跟本計畫不一樣的地方**

- Task 1 Step 4 的 Expected:`Tests  15 passed (15)` → `Tests  53 passed (53)`。
- 「F. 共用指令與基準數字」的表格與之後各 Task 的 vitest 總數都要**多 38 項**(檔數不變):第 1 階段完成 97 檔 / 1349 項,第 2、3 階段完成 111 檔 / 1466 項。
- 乾跑輸出的句數 K 比原本多 4(保險那 4 句;本來就不用管 K),各測試的項數不變。
- Task 1 Step 2 的錯誤訊息:vitest 2.1.9 實際印的是 `Failed to resolve import "./supabase-sql.mjs" … Does the file exist?`(意思相同)。
