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

### 2026-10-10:Task 1 的 `scripts/supabase-sql.mjs` 審查後加固(主要修正在 commit `359f69f`,分支 `market`)

Task 1–2 照本計畫做完後,獨立審查找出工具本身的漏洞,已修正。**以 repo(`market` 分支)裡的 `scripts/supabase-sql.mjs` 與 `scripts/supabase-sql.test.mjs` 為準,不要再照抄 Task 1 的程式碼區塊。** 乾跑(`乾跑 <檔名>(migration N 支、rollback M 支、K 句):共 X 項,失敗 Y 項`)與 `ro` 的輸出格式沒變。

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

### 2026-10-10:migration 120000 / 120100 品質審查後的修正(commit `6ab2cb7`、`513f486`,分支 `market`)

Task 3–7 照本計畫做完、規格審查逐位元相同之後,品質審查找出兩支 migration 的漏洞,已修正(兩支都還沒套正式庫,第 31 個 Task 才套)。**以 repo(`market` 分支)裡的 `supabase/migrations/20261009120000_market_catalog.sql`、`20261009120100_market_images_storage.sql`、兩支還原檔與四支乾跑測試為準,不要再照抄 Task 3–7 的 SQL 程式碼區塊。**

**120000 改了什麼、為什麼**

1. **管理員停用店家可以被繞過**:供應商的 `market stores supplier manage` 是 FOR ALL(含 DELETE),guard 在 INSERT 時又一律設成啟用 → 被停用的店家刪掉再重建就變回啟用、停用原因也不見。
   - 拆成 `market stores supplier read / insert / update`(SELECT / INSERT / UPDATE),**供應商不能刪店家**;管理員的 FOR ALL 不變。店家設定頁的儲存是 upsert(INSERT … ON CONFLICT DO UPDATE),用到的是 SELECT + INSERT + UPDATE,不受影響。
   - 商品、轉帳資訊查過沒有同樣的問題,維持 FOR ALL:商品刪掉再重建只會得到草稿,還是要送審、管理員核准才上架;轉帳資訊沒有管理員設的欄位。
2. **`created_at` 供應商可以任意寫**(帶 2099 就永遠排在首頁最前面):兩支 guard 改成新增一律 `now()`、修改保留原值(管理員也一樣)。
3. **資料表權限漏了 PG17 的 `MAINTAIN`**(乾跑實測:anon 對店家與商品、authenticated 對三張表原本都有):三張表改成先 `REVOKE ALL … FROM anon, authenticated` 再 GRANT 需要的 —— anon:店家、商品 `SELECT`;authenticated:三張表 `SELECT, INSERT, UPDATE, DELETE`(細分靠 RLS;店家表的 DELETE 只有管理員的 policy 用得到)。
4. **guard 比 RLS 先跑,會洩漏別家有沒有轉帳資訊**(替別家建店並勾轉帳:回 22023 = 沒存、42501 = 有存):`market_stores_guard` 在 INSERT 時先檢查擁有權,不是自家的一律 42501(沒有 HINT,跟 RLS 一樣)。`auth.uid()` 是 NULL(資料庫擁有者 / service_role 直接寫,本來就不受 RLS 管)時不擋 —— 第 2 階段的測試(Task 32、35、36)用資料庫擁有者身分直接 INSERT 店家當 fixture,要能照常跑。商品 guard 查過不用改:它繞過 RLS 查的只有 `supplies`,而 `supplies` 本來就開放所有登入者讀。
5. **全形空白、零寬字元也能當品名**:新增 `market_trim(text)`(去掉頭尾的 ASCII 空白、Unicode White_Space、U+180E、U+200B–U+200D、U+2060、U+FEFF;中間的字元不動;不開給 API 角色),商品 guard 的七個文字欄位改用它,品名、規格去完是空的被 `market_products_text_lengths` 擋(23514)。店家的介紹 / 退換貨說明 / 停用原因與轉帳資訊仍用 `btrim`(審查只點名商品;停用原因只有管理員填、轉帳資訊是店家自己的資料)。
6. **二維 `photos` 存得進去**:`market_products_photos` 改成 `cardinality(photos) <= 5 AND COALESCE(array_ndims(photos), 1) = 1`。
7. **新增草稿時自己帶的 `submitted_at` 會留下**:INSERT 但沒送審(草稿,或管理員直接建成已核准 / 退回)一律清成 NULL。
8. (審查清單外,修 photos 時一起發現)**`photos` 裡的 NULL 會通過路徑檢查**:`market_image_path_matches(NULL, …)` 回 false,但 `SELECT p INTO v_bad` 拿到的是 NULL,`IF v_bad IS NOT NULL` 擋不到。改成 `COALESCE(p, '(空值)')`,回 22023 `invalid_photo_path`。
9. 還原檔多 `DROP FUNCTION IF EXISTS public.market_trim(text);`,還原測試的函式清單多 `market_trim`。
10. 以下**不修**(審查決定):anon 讀得到 `reviewed_by`(低風險,改了會讓 `select *` 類的查詢壞掉);刪掉轉帳資訊後付款方式仍標示轉帳(第 2 階段下單時已經擋,見 Task 37「轉帳資訊被刪掉的店不能選轉帳」,第 9929 行)。

**120100 改了什麼、為什麼**

- **已核准的照片可以被換掉而不回待審**:UPDATE、DELETE 兩條 policy 讓供應商能用 x-upsert 覆寫,或刪掉再用同名重傳。兩條都拿掉,**物件只能寫一次**(只剩 `market images supplier select / insert`)。前端本來就 `upsert: false`、換照片不刪舊檔(Task 13 `images.ts`),不受影響。還原檔只拆剩下的兩條 policy。
- 測試:policy 只剩兩條;upsert 覆寫被拒(`ERR 42501`);供應商 UPDATE 自己的檔 0 列;刪檔 0 列。直接用 SQL DELETE 一律被 `storage.protect_objects_delete`(FOR EACH STATEMENT 的 trigger)擋成 42501,測不到 policy,所以照 Storage API 的做法,在交易裡先 `set_config('storage.allow_delete_query', 'true', true)` 再以供應商身分刪(這個 trigger 的定義用唯讀端點查過)。

**測試項數與其他數字跟本計畫不一樣的地方**

| 乾跑 | 本計畫 | 現在 | 差異 |
|---|---|---|---|
| `market_catalog` | 70(Task 3 之後 23) | **87**(Task 3 之後 23、Task 4 之後 70) | 檔尾新增「3. 審查後補強」17 項 |
| `market_catalog_rollback` | 3 | 3 | 函式清單 6 → 7 個;Task 5 Step 2(第 1564 行)的失敗項「還原後函式都不在」got 6 → **got 7** |
| `market_images_storage` | 17 | **18** | 改 3 項(policy 清單、upsert → `ERR 42501`、UPDATE → `0`),新增 1 項(刪檔 0 列) |
| `market_images_storage_rollback` | 3 | 3 | Task 7 Step 2(第 1828 行)的失敗原因變成「policy 還有 **2** 條、路徑函式還在」 |

- 要跟著改的 Expected:「F. 共用指令與基準數字」(第 116 行);Task 4 Step 4(第 1522 行,`共 70 項` 是 Task 4 當時的數字,之後重跑是 87);Task 6 Step 4(第 1790 行,17 → 18);Task 31 Step 2(第 8291 行,70 → 87、17 → 18)、Step 4(第 8330 行,`image_policies` 4 → **2**)、Step 5(第 8341 行,70 → 87、17 → 18)、Step 7 驗收清單(第 8387 行,同上);Task 58 開放前檢查(第 16747 行,`image_policies` 4 → **2**)。
- 「C. 關鍵技術決定」第 3 點(第 47 行)與 Task 6 開頭(第 1614 行)的「4 條 policy、upsert 需要 SELECT + INSERT + UPDATE」改成「2 條 policy(SELECT + INSERT),物件只能寫一次,不能 upsert」。
- vitest 沒有變(沒有 vitest 讀這兩支 migration):`market` 分支目前 78 檔 / 1230 項全過。乾跑輸出的句數 K 也變了(本來就不用管)。

**給後續 Task 的注意事項**

1. **Task 27 管理員「商品審核」頁**:`_t` 縮圖是另外上傳的檔,不在 `photos` 裡。照計畫寫法,詳細視窗每張照片都用 `MarketImage variant="full"`(只看得到主圖)、清單只顯示第一張照片的縮圖;但市集的商品卡用預設的 `variant="thumb"`,先顯示縮圖 —— 縮圖沒人審。詳細視窗要把每張照片的主圖與縮圖(`thumbPathOf(p)`)都顯示出來。
2. **Task 30 `docs/DEPLOY.md`**:
   - 120100 那段(計畫第 8220–8221 行)的「4 條 policy(`market images supplier select / insert / update / delete`)只准該供應商的成員動自己資料夾」改成「2 條 policy(`select / insert`):只准該供應商的成員上傳到自己資料夾;物件只能寫一次,不能覆寫、不能刪」。
   - 加一段 runbook「違規圖片怎麼刪」:管理員沒有任何 storage policy,後台刪不了檔。先在管理後台「商品審核」把商品退回 / 下架(填原因);再從 Supabase Dashboard → Storage → `market-images` 刪掉那張主圖**和**它的 `_t` 縮圖,或用 service role key 呼叫 Storage API(supabase-js `storage.from('market-images').remove([主圖路徑, 縮圖路徑])`)。🔴 不能用 SQL 刪(`storage.protect_objects_delete`)。bucket 是公開的:只下架商品、不刪檔,知道網址的人還是看得到。
3. **前端有沒有依賴「供應商刪店家」或「刪照片」**:grep 全計畫確認**沒有**,不用改任何 Task。
   - Task 20 `store.ts` 的 `saveStore` 對 `market_store_transfer`、`market_stores` 用 upsert(SELECT + INSERT + UPDATE,仍然允許)。
   - Task 13 `images.ts` 上傳一律 `upsert: false`,不刪檔;Task 21(logo / 封面「移除」)與 Task 24(商品照片「移除」)只是從表單 / 清單拿掉路徑,不刪 Storage 的檔。
   - 全計畫沒有任何對 `market_*` 資料表的 `.delete()`,也沒有 Storage 的 `.remove()`(出現的 `remove` 都是購物車的,`listeners.delete` 是 JS 的 Set)。供應商刪商品在資料庫層仍然允許,但沒有任何 Task 的前端用到。
4. 編輯含 Unicode 跳脫序列(反斜線 + u + 四位十六進位,例如正規式裡的全形空白)的檔案時,agent 的工具可能把跳脫直接換成看不見的字元本身(`009e8e0` 與這次都發生過)。改完用程式掃一次 Unicode 類別 Zs / Zl / Zp / Cf / Cc 的字元。

### 2026-10-10:migration 修正(第 2 輪複審)(commit `242204c`,分支 `market`)

上一節(第 1 輪)的修正經複審,攻擊都還擋得住;另外補 1 個 Important、3 個 Minor。**以 repo(`market` 分支)為準。** 只改了 120000(migration、還原檔、兩支測試),120100 沒有變。

**改了什麼、為什麼**

1. 【Important】**照片「只能寫一次」只保護核准時已經存在的檔**:photos 先填還沒上傳的路徑、或只傳主圖不傳縮圖,等核准後才第一次上傳 —— Storage 放行,商品仍是已核准,anon 看得到;前端 MarketImage 讀不到縮圖會改顯示主圖,審核畫面看不出缺了縮圖。
   - 管理員核准(含直接建成已核准)、以及已核准時改了照片,guard 檢查 photos 每張照片與它的縮圖(`<uuid>_t.<副檔名>`,照 120100 的路徑格式,跟主圖同一個副檔名)都已經在 `storage.objects`(bucket `market-images`);缺任何一張 → 22023,HINT `photos_not_uploaded`(前端已對應中文,commit `cd05649`)。錯誤訊息帶第一個缺檔的路徑。
   - 只在「變成已核准」與「已核准時改了照片」檢查:改價格、庫存(含第 2 階段下單扣庫存、取消補庫存)不檢查,管理員之後從 Storage 刪掉違規圖也不會讓這些操作失敗。photos 是空陣列時沒有東西要查,照樣能核准(審核頁會顯示「沒有照片」)。
   - 🔴 **還沒解決的落差(要擇一處理)**:前端 `thumbPathOf`(`src/lib/market/images.ts`)把縮圖一律換成 `_t.jpg`,資料庫照指示推成 `_t.<同一個副檔名>`。前端上傳的主圖一律是 `.jpg`,兩邊一致;但供應商若直接打 API 把 photos 填成 `.png` / `.jpeg` / `.webp`,核准時檢查的是 `_t.png` 等,商品卡顯示的卻是 `_t.jpg` —— 核准後才上傳 `_t.jpg` 就繞過了。修法二選一:前端 `thumbPathOf` 保留副檔名(正常流程不受影響),或資料庫把商品照片限定 `.jpg`。
2. 【Minor】`market_stores_guard` 擁有權檢查的例外改看 `auth.role()`:NULL(資料庫擁有者直接寫,沒有 JWT)與 `service_role` 不擋,其他一律檢查。原本看 `auth.uid()` 有沒有值,沒有 sub 的 authenticated JWT 會被當成擁有者放過,又能用 42501 / 22023 分辨別家有沒有轉帳資訊。第 2 階段測試(Task 32、35、36)用資料庫擁有者身分直接 INSERT 店家,`auth.role()` 是 NULL,照常能跑。
3. 【Minor】**只填 U+200E、U+00AD、U+3164、U+2800、U+FE0F 這類字元的品名看起來是空白卻存得進去**:新增 `market_visible(text)`,去掉空白、控制字元(Cc)、格式字元(Cf)與看起來空白的字元(韓文填充字 U+115F、U+1160、U+3164、U+FFA0,點字空白 U+2800,異體字選擇符 U+FE00–U+FE0F 與 U+E0100–U+E01EF,組合字形連接符 U+034F,高棉文 U+17B4、U+17B5,蒙古文 U+180B–U+180F)之後至少要剩 1 個字。
   - 商品 guard 的文字欄位看不到字就當成空的:品名、規格變成空字串、被 `market_products_text_lengths` 擋(23514);產地、保存方式、保存期限、說明、退回原因當成沒填(NULL;管理員退回時原因因此會觸發 `reject_reason_required`)。
   - 只判斷不改內容:U+FE0F 沒有放進 `market_trim`(emoji 結尾的品名不會被截掉),ZWJ 組合原樣保留。店家欄位與轉帳資訊沒有改(同第 1 輪,審查只點名商品)。
   - 只給 SECURITY DEFINER 的 guard 用,不開給 API 角色;還原檔與還原測試加 `market_visible`。
4. 【Minor】**created_at 的測試分不出「保留原值」和「改成 now()」**(同一個交易裡 `now()` 不會變):改成先暫停 guard(`ALTER TABLE … DISABLE TRIGGER`,拿 SHARE ROW EXCLUSIVE 鎖、擋寫不擋讀,交易結束就放),把店家與商品的 created_at 設成 2020-01-01,再驗證供應商改成 2099 時保留 2020-01-01。突變驗證:把兩支 guard 修改分支的 `NEW.created_at := OLD.created_at` 換成 `now()`,正好這兩項失敗(其他 95 項照樣過)。
5. **測試 fixture**:`market_catalog.test.sql` 只帶 120000,核准又要查 Storage,所以第 2 節開頭先建 bucket `market-images`(已經有就 `ON CONFLICT DO NOTHING`)與 P1 會用到的四個照片物件(兩張主圖、兩張縮圖),都用資料庫擁有者身分直接寫、交易最後 ROLLBACK;第 31 個 Task 套上 120100 之後再跑也一樣。

**測試項數**

| 乾跑 | 第 1 輪後 | 現在 | 差異 |
|---|---|---|---|
| `market_catalog` | 87 | **97** | 新增第 4 節 10 項(沒有 sub 的 JWT 1、照片上傳 5、看起來空白的文字 4);created_at 兩項改寫,項數不變 |
| `market_catalog_rollback` | 3 | 3 | 函式清單 7 → 8 個(多 `market_visible`);只套 migration、不套還原檔時「還原後函式都不在」got 7 → **got 8** |
| `market_images_storage` | 18 | 18 | 不變 |
| `market_images_storage_rollback` | 3 | 3 | 不變 |

- 上一節「要跟著改的 Expected」裡 `market_catalog` 的 87 一律改成 **97**(F 節第 116 行、Task 31 第 8291 / 8341 / 8387 行);`market_images_storage` 維持 18,`image_policies` 維持 2。
- 業主實測(Task 60)或用 Dashboard 手動放照片時:主圖和 `<uuid>_t.<副檔名>` 縮圖都要放,否則核准會被擋(前端上傳本來就兩張都傳)。
- **追加(commit `bf1681a`)**:上面「還沒解決的落差」採第二種修法 —— 商品照片(`market_products.photos`)的路徑只收小寫 `.jpg`(`.png`、`.webp`、`.jpeg` 改成 22023 `invalid_photo_path`;`.JPG` 跟 120100 的路徑規則一樣本來就不收)。理由:前端把所有照片壓成 JPEG 上傳(主圖 `.jpg`、縮圖 `_t.jpg`),限定之後資料庫推出的縮圖 `<uuid>_t.<同副檔名>` 一定是 `_t.jpg`,跟前端 `thumbPathOf` 顯示的是同一張,前端不用改;店家 logo / 封面(`store` 資料夾,不在 photos 裡)不受影響,仍收 jpg / jpeg / png / webp。`market_catalog` 乾跑 97 → **99** 項(新增「副檔名」與「store 資料夾不受影響」2 項;上面要改成 97 的 Expected 一律改成 99)。

### 2026-10-10:前端修正(Task 8–18 審查)(commit `9e5cf43`、`dd559ca`、`af1e450`、`cd05649`、`2d27fa9`、`1023c48`、`97af257`、`89abdf5`、`3ad3e02`,分支 `market`;中間穿插的 `242204c`、`d336b6d`、`bf1681a`、`2e521f1` 是上一節的 migration 修正,不屬於這一節)

Task 8–13(`src/lib/market/`)的獨立審查(Important 1–4、Minor)與 Task 14–18 頁面的自查 / 複審找出的問題,已修正。**以 repo(`market` 分支)的 `src/lib/market/`、`src/components/market/`、`src/pages/market/` 為準,不要再照抄 Task 10–17 對應的程式碼區塊。** 沒有改任何 migration;每一項都是先寫測試、看到失敗才改。

**改了什麼、為什麼**

A. `src/lib/market/`(部署前必修)

1. **`fetchStoreProducts` 的三道過濾沒有被測試釘住**(`.eq("review_status", "approved")`、`.eq("is_listed", true)`、`.filter(isPubliclyVisible)` 各刪一道,測試仍全綠):`catalog.test.ts` 改寫「店家頁」測試,三道各拿掉一道都會紅(突變驗證過);補 `fetchMarketStore` 的測試(查 `market_stores`、select 等於 `STORE_PUBLIC_COLUMNS`、找不到回 null、id 不是 uuid 不查);查詢失敗四支公開查詢都丟 `MarketDbError`(頁面才會顯示載入失敗,不會當成沒資料);新增「公開欄位」:兩組欄位不准 `*`、不含 `reject_reason` / `supply_id` / `disabled_reason` / `contact_email` / `reviewed_by`,四支查詢實際送出的 select 必須就是這兩組。(`9e5cf43`)
2. **`STORE_PUBLIC_COLUMNS` 拿掉 `suppliers.contact_email`**:那是新訂單通知信箱,市集頁面用不到,不該送到每個訪客的瀏覽器。`MarketSupplierEmbed.contact_email` 改成可選(Task 26 管理後台的 `select("*, suppliers(name, phone, contact_email, is_active)")` 照樣用得到;`testFixtures.ts` 不用改)。Task 10 測試「首頁只抓已核准、上架中的商品」裡的 `suppliers(name, phone, contact_email, is_active)` 改成 `suppliers(name, phone, is_active)`。(`9e5cf43`)
3. **首頁搜尋遇到前端不認得的分類會白屏**:`matchesQuery` 的 `CATEGORY_LABEL[p.category]` 改成 `?? ""`(資料庫先加了新分類、前端還沒部署時,`normalize(undefined)` 丟例外,一輸入搜尋字整個 app 白屏)。(`dd559ca`)
4. **只有縣市、分類、溫層跟 migration 比對**:`constants.test.ts` 新增 5 項 —— 從 migration 120000 的 CHECK(`BETWEEN` / `<=`)讀出每個上限跟 `LIMITS` 比(多一個 key、少一個 key 都會紅);照片張數(`cardinality(photos) <= 5`)、縣市數、付款方式、審核狀態(`REVIEW_STATUS_LABEL` 的 key)跟 CHECK 比;120100 的 bucket(`market-images`、公開、2097152 bytes、JPG / PNG / WebP)跟 `MARKET_IMAGE_BUCKET`、`PHOTO_RULES` 比。每一種寫法必須在 migration 裡剛好出現一處(migration 改了格式會紅,要回來更新);另一項把 migration 的每個數字加 1,確認讀到的值跟著變(不是寫死)。前端那一邊用突變驗證過:改 `LIMITS.productName`、`PHOTO_RULES.maxBytes`、`inputTypes`、`PAYMENT_METHODS`、`REVIEW_STATUS_LABEL` 都會紅。(`af1e450`)
5. Minor(`cd05649`、`2d27fa9`):
   - `friendlyDbError` 用 `Object.prototype.hasOwnProperty.call(HINT_MESSAGES, hint)`:原本 `"constructor"`、`"toString"` 這類 hint 會拿到 Object 原型上的函式。審查建議 `Object.hasOwn`,但 `tsconfig.app.json` 的 lib 是 ES2020,會多一個 TS2550(tsc 錯誤超過 72),效果相同所以用 `hasOwnProperty.call`。
   - 斷網:postgrest-js 2.78 在 fetch 失敗時回 `{ message: "TypeError: Failed to fetch", hint: "", code: "" }`(Safari 是 `Load failed`、Firefox 是 `NetworkError…`),直接丟出的 `TypeError` 也一樣 →「連線失敗,請檢查網路後再試一次」。資料庫有回錯誤碼時照原本的規則。
   - 新 hint `photos_not_uploaded` →「這個商品還有照片沒有上傳完成,無法核准」(資料庫端見上一節「第 2 輪複審」)。中文標點照 repo 慣例用半形逗號。
   - `compressToJpeg` 的 `img.onload` 包 try/catch,例外轉 reject(`MarketImageError`):事件處理裡的例外不會變成 reject,原本照片超過瀏覽器的 canvas 上限時 Promise 永遠 pending、上傳一直轉。`drawImage` 前設 `imageSmoothingEnabled = true`、`imageSmoothingQuality = "high"`(主圖與 480px 縮圖共用同一支)。檔頭註解改成現況:120100 只有 SELECT / INSERT policy,物件只能寫一次,前端不能覆寫也不能刪。`images.test.ts` 補 3 項(Image / canvas 用假的)。

B. 頁面

6. **商品卡的鍵盤焦點框被整圈裁掉**:外框、圓角、`overflow-hidden` 從 `<article>` 移到 `<Link>` 自己身上(焦點框是畫在連結外面的 box-shadow,連結填滿卡片,外層 `overflow-hidden` 會把它切掉;WCAG 2.4.7)。測試:連結到卡片外框之間不准有 `overflow-hidden` / `overflow-clip`。另用 headless Chrome 實際按 Tab:焦點落在商品卡時 `:focus-visible` 成立、box-shadow 是白色 2px + emerald-700 4px、所有祖先的 overflow 都是 visible(390 與 1280 寬)。(`1023c48`)
7. **店家頁商品查詢失敗會誤說「這家店還沒有上架的商品」**(還顯示「共 0 項」):改成 `role="alert"` 的錯誤訊息 +「重新載入」(只重抓商品),件數欄空白。(`97af257`)
8. **載入失敗的畫面**:首頁件數欄空白(不顯示「共 0 項」);新增 `src/pages/market/MarketLoadError.tsx`(一個 h1、「請檢查網路後再試一次」、「重新載入」只重抓資料、「回市集首頁」),商品頁「商品載入失敗」、店家頁「店家資料載入失敗」改用它(原本只有一行紅字,沒有 h1、沒有重試)。重試按鈕的字沿用首頁的「重新載入」。(`89abdf5`)
9. **換頁與分頁標題**(`3ad3e02`):
   - `MarketLayout`:pathname 變了、而且是點連結(PUSH / REPLACE)就 `window.scrollTo(0, 0)`;上一頁 / 下一頁(POP,含第一次載入)交給瀏覽器還原;只改查詢字串(首頁篩選是 REPLACE)不捲。
   - `useMarketTitle` 第一次設定時記下進市集之前的標題(模組層變數),`MarketLayout` 卸載(離開 `/market`)時還原。不在各頁的 effect 裡還原(市集裡換頁時標題會先閃回原本的),也不在 MarketLayout 掛上時記(子元件的 effect 比父元件先跑,那時標題已經被改掉)。
   - 商品頁 / 店家頁的標題跟畫面一致:找不到(含網址不是 uuid)是「找不到商品」「找不到店家」(店家沒開放零售也是「找不到店家」),載入失敗是「商品載入失敗」「店家資料載入失敗」。`MarketNotFound` 加 `title`(預設「找不到頁面」),頁面傳跟自己一樣的字 —— 原本網址壞掉時父元件的 `useMarketTitle(null)` 比子元件晚跑,標題變回通用的「iFoodmap 食材市集」。

**測試數字跟本計畫不一樣的地方**

- vitest:Task 18 做完是 89 檔 / 1294 項,現在 **89 檔 / 1321 項**(+27 項,沒有新的測試檔)。各檔:`catalog.test.ts` 9 → 16、`constants.test.ts` 5 → 10、`db.test.ts` 6 → 9、`images.test.ts` 11 → 14、`market-components.test.tsx` 9 → 12、`MarketHomePage.test.tsx` 7 → 8、`MarketProductPage.test.tsx` 4 → 6、`MarketStorePage.test.tsx` 3 → 6。
- 「F. 共用指令與基準數字」的總數(含第一節勘誤的 +38)再**多 27 項**:第 1 階段完成 97 檔 / **1376** 項,第 2、3 階段完成 111 檔 / **1493** 項。tsc 72、eslint 10 不變;兩種 build 都過。
- 之後的 Task 跑到上面這些測試檔時,Expected 的項數要加上該檔多出來的數目,例如:
  - Task 44 Step 2(第 12380 行):`catalog.test.ts` 1 failed、9 passed → **1 failed、16 passed**;Step 4(第 12592 行):`Tests  25 passed (25)`(cart 15 + catalog 10)→ **`Tests  32 passed (32)`(cart 15 + catalog 17)**。
  - Task 46 Step 2(第 13005 行)仍是 3 failed(另外 18 passed);Step 4(第 13311 行):`Tests  16 passed (16)`(10 + 6)→ **`Tests  21 passed (21)`(13 + 8)**。

**給後續 Task 的注意事項**

1. 第 4611 行之後所有「在 `檔案` 找到 → 換成」依序模擬套到現在的 repo,只有下面 4 組對不上,其餘(`App.tsx` 10 組、`constants.ts`、`catalog.ts`、`market-components.test.tsx` 2 組、`MarketProductPage.test.tsx` 5 組、`MarketLayout.tsx` 另外 3 組、`MarketProductPage.tsx` 4 組)都剛好命中一次:
   - Task 44,`catalog.test.ts` 第 12329 行(import 清單):現在是 `fetchMarketProduct,` / `fetchMarketStore,` / `fetchStoreProducts,`,把 `fetchProductsByIds,` 加在 `fetchMarketStore,` 後面。
   - Task 44,`catalog.test.ts` 第 12348 行(舊的「店家頁只抓那一家的商品」測試結尾):那個測試已經改寫,找不到。把「購物車:依 id 重新抓…」那個 `it(...)` 放進 `describe("公開查詢")` 的最後(「查詢失敗一律丟 MarketDbError…」之後、`describe("公開欄位")` 之前)。
   - Task 46,`MarketLayout.tsx` 第 13131 行(import):react-router-dom 那行現在是 `import { Link, Outlet, useLocation, useNavigationType } from "react-router-dom";`,`ShoppingCart`、`useCart` 兩行 import 加在它後面。
   - Task 46,`MarketLayout.tsx` 第 13151 行(`export default function MarketLayout() {`):函式開頭現在先有 `useLocation()` / `useNavigationType()` 與兩個 effect;`const { count } = useCart();` 放在函式的第一行。
2. 會在 `MarketLayout` 裡用點連結換頁(PUSH)的測試,jsdom 會印 `Not implemented: window.scrollTo`(不影響結果);要安靜就在那個測試裡 `vi.spyOn(window, "scrollTo").mockImplementation(() => {})`。Task 46 之後 `MarketLayout` 會呼叫 `useCart()`;`useCart` 讀寫 localStorage 都有 try/catch,`market-components.test.tsx` 新增的兩個換頁測試不用另外換 localStorage。
3. 新頁面要設分頁標題一律用 `useMarketTitle`(離開市集會自動還原);頁面裡畫 `MarketNotFound` 時傳跟頁面自己一樣的 `title`。整頁載入失敗用 `MarketLoadError`(要有 h1 與重試)。
4. 🔴 **Task 43 在 `LIMITS` 最後加 7 個訂單上限(第 11900 行)之後,`constants.test.ts` 的「LIMITS 每一個上限都等於 migration 120000 的 CHECK」會紅**(多出來的 key 沒有對照)—— 這是故意的:每個上限都要跟資料庫比。Task 43 要同時在 `constants.test.ts` 加 130000 的對照(寫法以當時 repo 裡的 migration 為準):讀 `supabase/migrations/20261009130000_market_orders.sql`,`buyerName` ← `char_length(buyer_name) BETWEEN 1 AND 50`、`addressMin` / `address` ← `char_length(ship_address) BETWEEN 5 AND 200`、`buyerNote` ← `char_length(buyer_note) <= 300`、`orderNote` ← `char_length(note) <= 300`(`market_order_events.note`)、`carrier` ← `char_length(v_carrier) > 50`、`trackingNo` ← `char_length(v_tracking) > 100`;第一項把兩份對照合併後再跟 `{ ...LIMITS }` 比,「數字真的是從 migration 讀出來的」那一項也跑新的對照。項數不變。

### 2026-10-10:migration 修正(第 3 輪複審)(commit `5eaf80c`,分支 `market`)

第 3 輪複審通過(沒有 Critical / Important),套用前把 4 個 Minor 與 1 個 nit 一起修。**以 repo(`market` 分支)為準。**

1. **`market_visible` 補缺口、改寫法**:改成 `p_text ~ '[^…]'`(只要有一個字不在「看不見」的集合裡就算,找到就停),不再整串取代再量長度;1e6 個 U+200B 從約 750ms 降到幾十毫秒。Default_Ignorable_Code_Point 的區段合併成 U+205F–U+206F、U+FFF0–U+FFFB、U+E0000–U+E0FFF,補上原本當品名存得進去的 U+2065、U+FFF0–U+FFF8、U+E0000、U+E0002–U+E001F、U+E0080–U+E00FF、U+E01F0–U+E0FFF;一般字串的結果跟舊寫法相同。
2. **`market_products_guard` 先擋擁有權與長度,才做正規化**(market_visible、market_trim、照片路徑):
   - 新增別家的商品 → 42501(例外跟 `market_stores_guard` 一樣只看 `auth.role()`)。原本靠 RLS,但 guard 比 RLS 先跑:不是供應商的登入者替別家塞 6 個各 1e6 字的欄位,要 5 秒才拿到 42501。
   - 粗擋長度:任一文字欄位原始長度超過 10000 字、或照片超過 50 張 → 23514。比 CHECK 寬很多、只擋亂塞的,精確上限仍由 CHECK 在正規化之後檢查。行為差異:原始長度超過 10000 字、去掉頭尾空白後其實很短的輸入,以前會被接受,現在一律擋。
3. **官方測試補 2 項**(複審拿掉這兩個條件時,原本 99 項仍全過):管理員改已核准商品的 photos 也要照片都已上傳;只認 `market-images` bucket(同名檔放在別的 bucket 不算,缺主圖、缺縮圖各一)。突變驗證:拿掉「已核准時改了照片」的條件、或主圖 / 縮圖不限 bucket,各自正好被對應的一項抓到。
4. **Storage 版本功能**:正式庫的 `storage.buckets.versioning_status` 是 `text NOT NULL DEFAULT 'DISABLED'`(可填 DISABLED / ENABLED / SUSPENDED;目前另有 Supabase 的 dark-launch CHECK `buckets_versioning_dark_check` 強制 DISABLED)。「照片只能寫一次」的前提是這個 bucket 不開版本,所以 120100 另寫一句 `UPDATE storage.buckets SET versioning_status = 'DISABLED' WHERE id = 'market-images'`(沒有塞進原本的 INSERT:前端 `src/lib/market/constants.test.ts` 逐字比對那句 INSERT 的欄位),`market_images_storage.test.sql` 多驗一項。預設值與 dark-launch CHECK 本來就是 DISABLED,這項目前不可能先看到失敗,是之後的回歸保護。
   - 🔴 **Task 31 Step 4(第 8308 行起)的線上 schema 查詢要加驗這點**:在 `json_build_object(...)` 裡加 `'image_bucket_versioning', (SELECT b.versioning_status FROM storage.buckets b WHERE b.id = 'market-images')`,Expected 加 `image_bucket_versioning` = `"DISABLED"`。
5. **縮短持鎖時間**:會暫停 guard trigger(`ALTER TABLE … DISABLE TRIGGER`,SHARE ROW EXCLUSIVE 鎖、擋寫不擋讀)的兩段 created_at 測試搬到 `market_catalog.test.sql` 最後(第 7 節),鎖只持有到交易結束前一下下。
6. (nit)**缺檔時錯誤訊息帶真正缺的那張**:每張照片展開成主圖、縮圖兩個檔名,回第一個真的缺的,不再固定帶主圖。

| 乾跑 | 第 2 輪後(含 .jpg 限定) | 現在 | 差異 |
|---|---|---|---|
| `market_catalog` | 99 | **105** | 第 6 節新增 6 項(Default_Ignorable 缺口、兩種超長輸入 1 秒內被擋、管理員改已核准商品的照片、只認 `market-images` bucket、缺檔訊息);created_at 兩項搬到第 7 節,項數不變 |
| `market_catalog_rollback` | 3 | 3 | 不變 |
| `market_images_storage` | 18 | **19** | 多驗 bucket 不開版本 |
| `market_images_storage_rollback` | 3 | 3 | 不變 |

- 前面各節要改成 99 的 Expected 一律改成 **105**,`market_images_storage` 的 18 一律改成 **19**(F 節第 116 行、Task 6 第 1790 行、Task 31 第 8291 / 8341 / 8387 行)。
- 「1 秒內」那兩項是寬鬆的時間上限(修正前約 5 秒、修正後幾十毫秒);正式庫很忙時萬一超過,先重跑一次再判斷。

### 2026-10-10:前端修正第 2 輪(commit `20a0db2`、`4e7e146`,分支 `market`)

離線時第一次載入被 React Query 暫停(`isPending` + `isPaused`)改顯示「目前離線,連線後會自動重新載入」(首頁與店家頁商品區 `MarketOfflineNotice`、商品頁與店家頁整頁 `MarketOffline`),只有 `isLoadingError`(失敗而且沒有資料)才顯示錯誤、`isRefetchError`(背景重抓失敗)保留舊資料並加一行 `MarketStaleNotice`,分類列與縮圖列加 padding / `scroll-px-*` 且按鈕聚焦時 `scrollIntoView({ block: "nearest", inline: "nearest" })`(`src/components/market/focus.ts`;Chrome 用 Tab 不會捲露出一半的按鈕)—— vitest 多 11 項(`MarketHomePage` 8 → 10、`MarketProductPage` 6 → 10、`MarketStorePage` 6 → 9、`market-components` 12 → 14),第 1 階段完成改成 97 檔 / **1387** 項、第 2、3 階段 111 檔 / **1504** 項,Task 46 Step 2 是 3 failed / 24 passed、Step 4 改成 **`Tests  27 passed (27)`(15 + 12)**,第 4611 行之後的「找到 → 換成」沒有新增對不上的。

### 2026-10-10:Task 21 店家設定頁自查修正(commit `b7d52d8`、`235a482`、`f80f7d4`,分支 `market`)

以 repo 的 `src/pages/supplier/SupplierMarketStorePage.tsx`、`src/pages/supplier/market/MarketImageField.tsx` 為準、不要再照抄 Task 21 的程式碼區塊:讀取失敗改成錯誤畫面加「重新載入」、不顯示表單(原本照樣畫出空白的新店家表單,一儲存 upsert 就蓋掉原本的介紹、退換貨說明、logo、封面;只有讀取成功而且查無店家才是新店家表單),勾選框加 `shrink-0`(390 寬的「銀行轉帳」換行時不再被壓小),選檔欄位與裡面的按鈕 `min-h-11`,縣市 / 付款方式出錯時每個勾選框標 `aria-invalid` + `aria-describedby`,儲存成功後表單換成資料庫回傳的值(縣市照官方順序、去掉頭尾空白)—— `SupplierMarketStorePage.test.tsx` 4 → 14 項,第 1 階段完成改成 97 檔 / **1397** 項、第 2、3 階段 111 檔 / **1514** 項。

### 2026-10-10:Task 26–28 管理後台審核與零售店家(commit `3e5d3a6`、`00d0b94`、`9b0f0e4`、`ec97402`,分支 `market`)

以 repo 的 `src/lib/market/admin.ts`、`src/pages/admin/AdminMarketProductsPage.tsx`、`src/pages/admin/AdminMarketStoresPage.tsx` 與兩支測試為準,不要再照抄 Task 26、27 的程式碼區塊;Task 28(選單分區、兩條路由)照計畫,沒有改。

1. **照片審核**(上面「120000 / 120100 品質審查」一節的注意事項第 1 點):查看視窗每張照片並排顯示主圖(`<uuid>.jpg`,商品頁大圖)與縮圖(`thumbPathOf` = `<uuid>_t.jpg`,商品卡先顯示)。不用 `MarketImage` —— 它讀不到縮圖會改顯示主圖,兩格看起來一樣,審核者看不出縮圖缺了;改用頁內的 `ReviewImage`:沒有任何退回,讀不到就在原位顯示紅色虛線框「讀不到縮圖 / 讀不到主圖」(`role="img"`,名稱「第 N 張・縮圖:讀不到」),圖用 `object-contain` 看整張不裁切。縮圖跟主圖不是同一張時,並排就看得出來。清單第 1 張也改成不退回的縮圖(紅框寫「讀不到 / 縮圖」兩行;沒有照片顯示「沒有照片」)。
2. **核准被資料庫擋下**(22023 `photos_not_uploaded`):除了 toast,查看視窗裡也顯示「這個商品還有照片沒有上傳完成,無法核准」(`role="alert"`),視窗不關,讀不到的那一格就在旁邊。
3. **自查修正**(每項都先寫測試、看到失敗才改):
   - 下架會在原因前加「(管理員下架)」7 個字,原本輸入框上限 300,填滿會被 `reject_reason <= 300` 擋(23514)→ `admin.ts` 新增 `DELIST_PREFIX`、`DELIST_REASON_MAX`(= 293),下架時輸入框用它。
   - 樂觀鎖擋下(`StaleReviewError`)時關掉查看 / 原因視窗(畫面上是舊內容),清單重抓,要重新查看才看得到新內容。
   - 原因視窗每次從空白開始(原本上一個商品 / 店家沒送出的原因會帶到下一個)。
   - 清單載入失敗改成錯誤訊息加「重新載入」(原本只有 toast,畫面還寫「沒有待審的商品」/「還沒有供應商開零售」);切換篩選時,比較慢回來的舊查詢不會蓋掉新清單。
   - 零售店家:供應商帳號停用(`suppliers.is_active = false`)時加一行「供應商帳號已停用,消費者看不到這家店」(零售開著也看不到,`market_store_is_open`);停用視窗的標題沒有店名時用 supplier_id。
4. **測試數字**:`admin.test.ts` 6 → **7**、`AdminMarketPages.test.tsx` 6 → **19**;Task 28 的 `AdminLayout` 28 + `AdminRoutes` 34 = 62 跟計畫一樣。第 1 階段完成(上一節 1397)再多 14 項:97 檔 / **1411** 項(`9b0f0e4` 實測全過);第 2、3 階段 111 檔 / **1528** 項。tsc 72、eslint 10 不變,兩種 build 都過(管理員站 build 才有這兩頁,前台站 build 裡沒有)。
5. 第 8176 行之後對 `src/App.tsx`、`AdminLayout.tsx`、`AdminLayout.test.tsx`、`AdminRoutes.test.tsx` 的「找到 → 換成」(Task 52、54、55 共 14 組)依序模擬套到現在的 repo,全部剛好命中一次。

### 2026-10-10:Task 23–25 零售商品表單、編輯視窗、商品目錄分頁(commit `3653d17`、`0e86a99`、`a353152`;自查修正 `bb6d801`、`55144b9`、`610f9e3`、`ac2529d`、`933ef3f`,分支 `market`)

Task 23–25 先照計畫做完(三個 commit 跟計畫的程式碼區塊逐字相同,Task 25 的 8 組「找到 → 換成」都剛好命中一次,測試 10 / 10 / 4 項先紅後綠),再做自查修正。**以 repo 的 `src/lib/market/productForm.ts`、`src/pages/supplier/market/`(`MarketPhotoField`、`MarketProductDialog`、`useSupplierMarketProducts`、`SupplierMarketProductsPanel`)、`src/pages/supplier/SupplierCatalogPage.tsx` 與測試為準,不要再照抄 Task 23–25 的程式碼區塊。** 沒有改任何 migration;每一項都先寫測試、看到失敗才改。

1. **讀取中 / 讀取失敗不能拿舊的或空的資料編輯**(跟 Task 21 店家設定頁同一類問題):編輯視窗的表單直接用清單那一列、沒有另外讀取,所以沒有「讀取失敗 → 空白表單 → 儲存蓋掉」;但清單本身有洞:
   - 第一次讀取失敗(或還在讀)時 `hasStore` 是 false、`products` 是空的,批發分頁每一列都顯示停用的「開放零售」,提示卻寫「請先完成店家設定」。
   - 存檔成功、背景重抓失敗或還沒回來時,清單留著存檔前的內容而且按鈕能按:再打開同一筆會帶出舊價格,一存就把剛存的修改蓋回去;剛「開放零售」的那一列還是「開放零售」,再按會建出第二筆重複的零售商品。
   - 修法:`useSupplierMarketProducts` 新增 `retry()`(先回到讀取中)、`applySaved(row)`(存檔成功先把資料庫回傳的那一筆放到清單最前面,跟重抓的 `updated_at` 新到舊一致,再背景重抓)與序號(重抓的回應比後來送出的那次晚到就丟掉,晚到的失敗也不顯示)。讀取中「零售」欄空著;讀取失敗時「零售」欄只有「—」(螢幕報讀「零售資料讀取失敗」),批發分頁上方與零售分頁都顯示原因與「重新載入」,零售分頁不顯示清單與新增鈕。
   - 還沒建零售店家:批發分頁上方直接顯示「零售市集 › 店家設定」的連結(停用按鈕的 `title` 手機看不到)。
   - 「—」裡的 `sr-only` 是 absolute:沒有定位的祖先時會跑出表格的橫向捲動容器,390 寬整頁被撐到 646px(headless Chrome 實測)→ 外層加 `relative`。
2. **照片上傳中**:`MarketPhotoField` 上傳完才 `onChange([...上傳前的清單, ...新照片])`,上傳期間的「設封面 / 移除」會被蓋回去;視窗也能在上傳中按儲存,存進去的少了那張照片(視窗關掉,照片變孤兒檔)。上傳中「設封面 / 移除」停用,用新的 `onBusyChange` 通知視窗,視窗的儲存 / 送審停用到上傳完成。
3. **驗證沒過時焦點移到第一個出錯的欄位**:390 寬時視窗要捲(內容 1300–1600px、可視 758px),按鈕在最下面,原本錯誤訊息在畫面外、按了像沒反應。等錯誤訊息畫出來(`aria-describedby` 接上)才移焦點。
4. **觸控大小**(Task 24 的說明寫「44px 的按鈕」,程式碼卻是 `h-9` = 36px):設封面 / 移除 `h-11 w-11`、選檔欄位 `min-h-11` + `file:min-h-11`(同 `MarketImageField`,原本 26px 高)、視窗底部按鈕、新增零售商品、重新載入 `min-h-11`;批發表格的零售狀態按鈕原本 16px 高,改 `min-h-8`(跟同一列的「開放零售」、編輯、刪除一樣 32px)。勾「不限」時庫存欄加停用底色。
5. **零售清單 390 寬**:狀態徽章與編輯鈕原本並排在右邊,資訊欄被擠窄(「動物性鮮奶油」截成「動物…」、規格價格拆成 5 行)→ 徽章放到品名旁邊(放不下就換行),編輯鈕固定在右邊。
6. **只有看不見字元的品名 / 規格**:資料庫當成空字串、被 CHECK 擋成 23514,畫面只顯示通用的「有欄位超過長度上限或格式不對」→ `productForm.ts` 新增 `INVISIBLE_CHARS` / `hasVisibleText`,品名、規格看不到字就顯示「請填品名」「請填零售規格…」。`INVISIBLE_CHARS` 由 vitest 逐字比對 migration 120000 的 `market_visible`(兩邊都換成 `\u{十六進位}` 再比;突變驗證:拿掉 U+2800 兩項都紅)。字元類刻意逐一列出組合字元與異體字選擇符,`no-misleading-character-class` 在這裡是誤判,加 `eslint-disable-next-line` 並寫明原因(不加的話 eslint 錯誤 10 → 11)。測試字串一律寫成 `\u{…}`:上面注意事項第 4 點的工具問題這次又發生(反斜線 + u + 四位十六進位被換成看不見的字元本身,`\u{…}` 不會)。
7. **測試數字**:`productForm.test.ts` 10 → **12**、`market-supplier-components.test.tsx` 10 → **17**、`SupplierCatalogPage.market.test.tsx` 4 → **10**,新增 `src/pages/supplier/market/useSupplierMarketProducts.test.ts` **3** 項(共多 1 檔 / 18 項)。第 1 階段完成(上一節 97 檔 / 1411 項)改成 **98 檔 / 1429 項**(`933ef3f` 實測全過);第 2、3 階段 **112 檔 / 1546 項**。tsc 72、eslint 錯誤 10 不變,兩種 build 都過。
8. 計畫第 7163 行之後沒有任何 Task 引用這幾個檔案,之後的「找到 → 換成」不受影響。
9. **沒有處理(留給審查決定)**:
   - 供應商端沒有樂觀鎖:管理員或另一個分頁在視窗打開後改了同一筆,儲存會用視窗裡的內容覆蓋價格、庫存、文字(審核狀態仍由 guard 決定,繞不過)。
   - 「已上架」只看 `review_status` 與 `is_listed`:店家被管理員停用、或庫存 0 時一樣寫「已上架」。
   - 新商品存檔時回應遺失(資料庫其實寫入了)再按一次會撞主鍵 23505,`friendlyDbError` 只顯示英文原文。
   - shadcn `DialogContent` 右上角的關閉鈕 16×16(共用元件,不在這次範圍;底部有 44px 的「取消」)。
10. **追加(commit `4a9a04c`)**:第 9 點前三項已修 —— 修改既有商品比對讀到的 `updated_at` 原字串,沒更新到任何一列就顯示「這個商品已被其他人更新,請重新載入後再改」、不覆寫(視窗留著但不能再存,按「重新載入」才關視窗並重新讀取;用語同店家設定的「資料已被其他人更新,請重新載入後再改」);狀態文字照消費者實際看到的寫(店家零售或供應商帳號停用 →「已核准・店家停用中(消費者看不到)」、庫存 0 →「已上架・缺貨」,這類徽章改琥珀色);新商品撞主鍵 23505 時讀回那一筆,是自家的就當作已存好(換進清單、提示「已儲存」),否則顯示中文錯誤、不覆寫。`saveMarketProduct` 改回傳 `{ row, alreadySaved }`、多收 `expectedUpdatedAt`;vitest 再多 14 項(`productForm` 12 → 18、`market-supplier-components` 17 → 22、`useSupplierMarketProducts` 3 → 4、`SupplierCatalogPage.market` 10 → 12),`4a9a04c` 實測全套 99 檔 / 1466 項全過(含店家設定同時新增的測試),tsc 72、eslint 錯誤 10,兩種 build 都過。

### 2026-10-10:Task 26–28 複審修正(commit `2cc52ed`,分支 `market`)

接上面「Task 26–28 管理後台審核與零售店家」一節。fresh-context 複審後再修 2 項(都先寫測試、看到失敗才改),以 repo 為準:

1. **核准 / 退回還沒回來就切了篩選**:完成後的重抓用的是按下按鈕那次 render 的 `load`(閉包裡是舊篩選),會把「已核准」分頁換成待審清單 → `load` 改讀 `filterRef`(在篩選的 effect 裡更新)。
2. **查看視窗裡有任何一格讀不到(紅框)時「核准上架」按不下去**,並寫明「有 N 個檔讀不到,不能核准…補傳後關掉這個視窗重新查看」:原本被 `photos_not_uploaded` 擋下後視窗留著,供應商這時才補傳(可能是另一張圖),再按一次就核准了審核者沒看過的縮圖(Storage 補傳不會改商品的 `updated_at`,樂觀鎖擋不到)。從清單直接按「核准」時只有資料庫把關、顯示 toast。
3. 測試補強(項數不變):核准只送 `review_status`(`toEqual`)、店家停用 / 恢復帶 `supplier_id`、停用原因 `maxlength`。
4. **測試數字**:`AdminMarketPages.test.tsx` 19 → **21**(`admin.test.ts` 仍是 7)。`2cc52ed` 乾淨副本(`git archive`)實測全套 **99 檔 / 1477 項**全過(含其他節同時新增的測試),tsc 72、eslint 錯誤 10,兩種 build 都過。
5. **複審發現、沒有處理(範圍外或規模還沒到)**:
   - 🔴 migration 120000 `market_stores_guard` 對**所有** UPDATE 檢查「付款方式含 `transfer` 就要有轉帳資訊」,管理員也不例外;供應商可以刪自己的 `market_store_transfer`(FOR ALL + DELETE),之後**管理員停用這家店會被 22023 `transfer_info_required` 擋下**(頁面只跳「接受銀行轉帳要先填寫轉帳資訊」,店照樣開著)。只有直接打 API 才會進到這個狀態(`store.ts` 只 upsert)。建議另開 migration:這項檢查只在 `payment_methods` 有變、或不是管理員時才做。靜態閱讀發現,未在資料庫實跑。
   - `fetchProductCounts` 一次撈整張 `market_products`,PostgREST 一次最多回 1000 列:超過時「上架 N・待審 M」少算且不報錯;清單的 `.limit(500)` 超過也不提示(同計畫「風險」第 7 點)。
   - `reviewProduct` 在 `updated_at` 缺值時不上鎖(目前呼叫端都有 `select *`);下架原因只貼零寬字元時前端放行、存成只有「(管理員下架)」;`busyId` 只有一個值,同時審兩筆時先回來的會讓另一筆的按鈕提早可按。

### 2026-10-10:管理員停用店家不被 `transfer_info_required` 擋住(commit `ef1df39`,分支 `market`)

`market_stores_guard` 原本對所有 INSERT / UPDATE 都檢查「接受轉帳要先有轉帳資訊」:供應商先建店勾轉帳、再自己刪掉轉帳資訊(轉帳資訊表開放供應商刪),之後管理員停用這家店就被 `transfer_info_required` 擋下、店照樣開著。改成只在**供應商建店、或供應商的更新動到付款方式**(去重排序後有變)而且新的付款方式含轉帳時才檢查;**管理員的更新一律不檢查**(停用、啟用、改停用原因;管理員建店也不檢查)。管理員重新啟用「付款方式含轉帳、轉帳資訊已刪」的店也不擋 —— 第 2 階段結帳本來就不能選轉帳(Task 37「轉帳資訊被刪掉的店不能選轉帳」,第 9929 行);供應商只改介紹等其他欄位、付款方式沒動,也不再被這項擋。供應商建店勾轉帳沒資訊、把付款方式改成含轉帳沒資訊,照樣擋。`market_catalog` 乾跑 105 → **112** 項(第 7 節新增 7 項;會暫停 guard 的 created_at 測試順延成第 8 節,仍在檔尾),前面要改成 105 的 Expected 一律改成 112。

### 2026-10-10:Task 19–22 獨立審查後的修正(commit `7db94b0`、`d2d5d64`、`c1dee5a`、`4aebf0c`、`638f8ef`、`9081011`,分支 `market`)

以 repo 的 `src/lib/market/store.ts`、`src/hooks/use-current-supplier.ts`、`src/pages/supplier/SupplierMarketStorePage.tsx`、`src/pages/supplier/market/MarketImageField.tsx` 為準,另外 `src/lib/market/db.ts` 的 `friendlyDbError` 多一個選填的中文備援參數(沒給的呼叫端行為不變)、新增 `friendlyStorageError`,`src/lib/market/images.ts` 的「上傳失敗:」後面改接中文(`MarketPhotoField` 也一起變中文,`images.test.ts` 那一項的預期跟著改):①照片上傳中儲存鈕停用並說明原因、儲存中用 `<fieldset disabled>` 鎖住所有欄位(審查重現的三種「上傳 / 打字跟儲存同時發生」都有測試);②補「不准空白蓋掉」的資料層與頁面測試,審查列的突變(讀取出錯回 null、退換貨說明 / logo / 封面變 null、不檢查轉帳資訊存失敗、重新載入不設 loading、上傳到錯的資料夾、上傳失敗清掉原圖)現在每一種都會紅(`onSubmit` 的守門畫面上按不到,留著當第二道防線);③**`saveStore` 簽名改成 `saveStore(supplierId, form, { updatedAt, transferInfo })`**:更新既有店家用 update + `eq("updated_at", 讀到的原字串)`(PostgREST 回微秒精度,不能轉 `Date`),沒更新到任何一列丟 `MarketStaleError`「資料已被其他人更新,請重新載入後再改」、不覆寫;第一次建立改用 insert(沒有值可比對,撞到 23505 一樣當成已被更新,不用 upsert 蓋掉別的分頁剛建的店);④`useCurrentSupplier` 的錯誤走中文轉換並新增 `reload()`,頁面讀不到供應商帳號時顯示原因與重新載入;⑤儲存順序改成只有第一次接受轉帳(guard 要求)才先 insert 轉帳資訊,其他情況先存店家、店家存好且轉帳資訊有改才更新,真的只存好一部分丟 `MarketPartialSaveError`(訊息講清楚哪一部分存好,頁面依存好的那部分更新狀態);⑥選檔欄位出錯標 `aria-invalid`、提示文字接到 `aria-describedby`,數字欄位出錯時提示不被擠掉,「看消費者看到的店家頁」連結 44px,載入中 `role="status"` —— 測試:`store.test.ts` 9 → **26**、`SupplierMarketStorePage.test.tsx` 14 → **30**、`use-current-supplier.test.tsx` 3 → **7**、`db.test.ts` 9 → **15**,新增 `src/pages/supplier/market/MarketImageField.test.tsx` **7** 項(共多 1 檔 / 50 項);第 1 階段完成(Task 23–25 一節的 98 檔 / 1429 項,加 Task 26–28 複審的 2 項)改成 **99 檔 / 1481 項**,第 2、3 階段 **113 檔 / 1598 項**。

### 2026-10-10:Task 23–25 獨立審查後的修正(commit `8398058`、`cc13ecd`、`64158c4`、`1799f09`、`4d0a0e2`、`cae435f`、`6bad165`、`b6640e8`,分支 `market`)

以 repo 為準(同上面 Task 23–25 一節);每一項都先寫測試、看到失敗才改,補測試的兩項用突變驗證:①**新商品重送**:撞主鍵 23505、讀回的是自家那一筆時,用它的 `updated_at` 把這一次的內容與按的按鈕(明講 `review_status` 草稿 / 待審)再存一次 —— 原本直接當作已存好,「儲存草稿」回應遺失 → 改價格 → 送審,資料庫仍是舊價格、草稿,畫面卻說已儲存;父層(`SupplierCatalogPage`)依來源(批發商品 id,或「新增零售商品」)沿用還沒確認存好的商品 id(`MarketProductDialog` 新增 `newProductId`),確認存好才換,沒確認存好就關窗時重新讀取清單 —— 原本每次換新 uuid,會建出第二筆、又沒有刪除鈕;②**測試時紅時綠**:商品目錄頁的假 client 讓零售資料一律晚 25ms 回來,「兩個分頁」那項改成 `await findByRole`(150ms 也全過,沒有其他同類寫法);③390 寬時長的狀態徽章最多跟資訊欄一樣寬、括號前 `<wbr>` 換行、`break-keep`(headless Chrome 實測不再壓到「編輯」鈕);④已核准的商品存完變回待審 → 提示「已重新送審,通過前消費者看不到」;⑤儲存中 `<fieldset disabled>` 鎖住欄位與照片欄;⑥錯誤訊息一律中文:`friendlyDbError` 給中文備援(視窗與清單「請稍後再試」、照片欄「上傳失敗,請再試一次」),自己丟的錯改名 `MarketStaleProductError`、`MarketProductIdTakenError`(名稱 Market 開頭,備援不會蓋掉);⑦`productForm.test.ts` 的假 client 分開 `single` / `maybeSingle`(0 列時 single 回英文的 PGRST116,修改改用 `.single()` 會紅),`images.test.ts` 補縮圖上傳失敗(拿掉 `upThumb.error` 檢查會紅,`images.ts` 沒改)—— vitest 多 14 項(`productForm` 18 → **21**、`market-supplier-components` 22 → **28**、`useSupplierMarketProducts` 4 → **5**、`SupplierCatalogPage.market` 12 → **15**、`images` 14 → **15**);`0d3933b` 的乾淨副本連跑 3 次都是 **99 檔 / 1523 項**全過(上一節的 1481 沒算到 Task 23–25 第 2 輪 `4a9a04c` 的 14 項),tsc 72、eslint 錯誤 10,兩種 build 都過。

### 2026-10-10:Task 26–28 獨立審查後的修正(commit `713dc50`、`6ccf381`、`0d3933b`、`b7a2d0b`、`5f4a390`、`f4379a6`、`5e4caa9`、`886157c`,分支 `market`)

接上面兩節 Task 26–28。以 repo 的 `src/lib/market/admin.ts`、`src/pages/admin/AdminMarketProductsPage.tsx`、`AdminMarketStoresPage.tsx` 與兩支測試為準。沒有改 migration;`productForm.ts`、`db.ts` 只 import、沒有改。每一點都先寫測試、看到失敗才改。

1. 【Important】**核准只能在查看視窗裡做,而且每個檔都載入成功才能按**(`5f4a390`):
   - 拿掉清單上的「核准」:清單只看得到第 1 張的縮圖,第 2–5 張與所有主圖都沒看到;清單縮圖出紅框時照樣送得出核准。
   - 查看視窗原本只有圖報錯後才停用,載入中按得下去 → 改成每張照片的主圖和縮圖都 `load` 成功才能核准(載入中、讀不到都不行,各自有一行說明);照片改成立即載入(`loading="eager"`,原本延遲載入)。
   - 視窗內容抽成 `ReviewDetail`,每次打開都換 key:圖重新載入、載入結果歸零(Radix 的關閉動畫沒跑完就重開同一個商品時,圖不會再觸發 load,沒有 key 會永遠卡在「載入中」)。
2. 【Important】**錯誤訊息一律中文**(`713dc50`):新增 `adminErrorMessage(e, 備援)` —— 登入過期(PGRST301 / PGRST303 /「JWT expired」)→「登入已過期,請重新登入後再試」,其他照 `friendlyDbError` 的選填備援(認不得的資料庫錯誤顯示「備援(錯誤代碼 X)」),四個顯示錯誤的地方都給中文備援。停用 / 恢復店家改用 `maybeSingle`,0 列丟 `MarketStoreGoneError`(`single()` 回英文的 PGRST116)。樂觀鎖的錯誤改名 `MarketStaleReviewError`(Market 開頭,給了備援也照原本的中文)。
3. **審核結果只作用在同一個商品**(`f4379a6`):查看視窗的錯誤、退回 / 下架視窗與打到一半的原因都跟著商品走(`row.id` 比對);送出中的商品改成清單 `busyIds`(A 送出中不會擋住 B)。
4. **數量與上限**(`b7a2d0b`,沒有 migration):
   - 審核清單一頁 50 筆(`range` + `count: "exact"` 算總數,排序最後加 `id` 才不會重複或漏掉)、上一頁 / 下一頁、品名搜尋(`ilike`,`% _ \` 當一般字跳脫、`*` 換成 `_`);審核完那一頁空了就回到前一頁。`fetchAdminProducts(filter, { page, search })` 改回傳 `{ rows, total }`。
   - 商品數與零售店家清單用 `src/lib/metrics.ts` 的 `fetchAllPages` 分頁讀完(讀到空的一頁為止,伺服器上限比 1000 小也不會漏)。
5. **下架不套樂觀鎖**(`6ccf381`):供應商改價格、庫存(第 2 階段下單扣庫存也算)不會再擋住下架;下架 0 列(商品已被刪)丟 `MarketReviewGoneError`。核准、退回照舊帶 `updated_at`。
6. **原因只有看不見的字元時按不下去**(`0d3933b`):兩頁的按鈕改用 `productForm.ts` 的 `hasVisibleText`;`admin.ts` 送出前也擋(`MarketReasonRequiredError`:下架有「(管理員下架)」前綴,資料庫的 `reject_reason_required` 擋不到)。
7. **補測試**(`5e4caa9`):查看視窗的圖改成裁切(`object-cover`)、審核成功後不重抓、舊查詢晚到的失敗蓋掉新清單 —— 審查的突變 M6 / M15 / M10 原本全綠,現在各自被對應的測試抓到。第 1 點另外用 4 種改壞驗過(只看讀不到不看載入中、拿掉主圖的 onFail、改回延遲載入、只等縮圖載入),都會紅。
8. (自查)拿掉清單的「核准」後,390 寬時狀態與兩顆按鈕剛好擠進同一行,品名欄被壓到約 58px → 品名欄 `min-w-[10rem]`、放不下時按鈕換行,搜尋鈕跟輸入框同一行(`886157c`,headless Chrome 1280 / 390 截圖確認)。
9. **測試數字**:`admin.test.ts` 7 → **20**、`AdminMarketPages.test.tsx` 21 → **43**。`886157c` 的乾淨副本(`git archive`)連跑 3 次都是 **99 檔 / 1544 項**全過(含其他節同時新增的測試),tsc 72、eslint 錯誤 10,兩種 build 都過,前台站的 build 裡沒有這兩頁。
10. 之後的 Task:Task 55 對 `App.tsx`、`AdminLayout.tsx`、兩支版面 / 路由測試的「找到 → 換成」不受影響(這次沒動那幾個檔)。

### 2026-10-10:Task 29 全套檢查、Task 30 `docs/DEPLOY.md`(commit `5ffafbe`,分支 `market`)

**Task 29 實測**(HEAD `440ac4b`,這個 Task 沒有改任何檔):

- vitest 連跑 3 次都是 **99 檔 / 1544 項**全過(Task 29 Step 1 的 97 / 1311 是勘誤前的數字);tsc 錯誤 72、eslint 錯誤 10,都在既有檔案
  (`SupplierCatalogPage.tsx` 的 6 個 tsc 錯誤是開工前就有的 `(supabase as never)`,只是行號往下移);兩種 build 都 exit 0
  (前台站的 build 裡沒有管理員審核頁、管理員站的 build 裡沒有市集首頁);形象站 `npm test` 211 / 211。
- 乾跑:`market_harness` 5、`market_catalog` 112、`market_catalog_rollback` 3、`market_images_storage` 19、`market_images_storage_rollback` 3,全部失敗 0;
  每支之後殘留五個 0。另外乾跑「兩支 migration + 依序 120100、120000 兩支還原檔」再跑 `market_catalog_rollback`,也是 3 / 3(還原順序可行)。
- 正式庫唯讀查:ledger 最新是 `20261007100200`,還沒有任何 `market_*` 資料表 / 函式、bucket、policy;repo 比線上只多這兩支 migration(線上沒有 repo 以外的版本)。

**Task 30**:DEPLOY.md 不照抄第 8203–8245 行的區塊,改寫進各輪勘誤(2 條 policy、物件只能寫一次、版本 DISABLED、商品照片只收 .jpg、
核准前主圖與縮圖都要上傳、管理員停用店家不受轉帳檢查影響、違規圖片怎麼刪),新段落在 `docs/DEPLOY.md` 第 756–1076 行。
**Task 31 以 DEPLOY.md「消費者食材市集 B2C」一節的「部署(第 1 階段)」「還原(第 1 階段)」為準**,跟 Task 31 原文不一樣的地方:

1. Step 4 的查詢多 `anon_can_read_stores`、`anon_can_write_stores`、`image_bucket_versioning`(= `"DISABLED"`)、`image_policy_names`(insert、select 兩條);
   `image_policies` = 2;另跑 `scripts/check-migrations.mjs`(應該是 ✅,repo 43 個、線上 43 個)。除了 `ledger`,每個值都在乾跑裡套兩支 migration 實測過。
2. Step 5 多兩支「線上 schema + 還原檔」的乾跑(各 3 項):推前端之前先確認還原檔在線上跑得動。
3. Step 6:原文是在 main 上直接 push;實際開發在 `market` 分支,改成 fetch → `market..origin/main` 是 0 → `switch main` → `merge --ff-only origin/main`
   → `merge --no-ff market` → `diff --stat market main` 沒有輸出 → push → 記下合併 commit → `market` 快轉到 main。
   用 `--no-ff`:還原時一個 `git revert -m 1 <合併 commit>` 就退掉整個階段;最後快轉 `market`,第 2 階段 Task 57 Step 1 的 `rev-list --count HEAD..origin/main` 才會是 0。
4. Step 7 用 `gh run list --commit <合併 commit>`;線上驗證多 bundle 探針(只有新版 bundle 才有的兩句字;部署前實測兩站都是舊版)、anon 讀 `market_stores`、
   anon 上傳 Storage 被拒(路徑用 fixture 前綴,萬一上傳成功,殘留檢查的 `fixture_objects` 會抓到)。
5. 還原多「先匯出」(唯讀端點的角色 `supabase_read_only_user` 有 BYPASSRLS)、「先乾跑還原」、用 `send_sql` 送還原檔(整份檔案一個請求;第一支回 `[]` 才送第二支)、
   「還原後確認」,repo 用 `git revert -m 1 <合併 commit>`。
6. DEPLOY.md 裡的 SQL 用 `printf '%s\n' "…" > "$Q"` 寫檔,不用 heredoc(指令在清單裡有縮排,照原樣複製時 heredoc 的結尾那一行對不上)。
   三段 SQL、bundle 探針、`send_sql` 都照原樣抽出來在 zsh 與 bash 跑過;SQL 另外放進乾跑確認輸出跟 Expected 一致。

**沒有處理(記錄)**:

- 前端上傳帶 `cacheControl: "31536000"`(一年,`src/lib/market/images.ts`):刪掉違規圖之後,CDN 與看過的瀏覽器可能還會顯示快取一段時間,沒有實測。
  DEPLOY.md「違規圖片怎麼刪」寫了刪完要用 curl 確認公開網址。
- 店家 logo / 封面沒有審核流程(上傳就公開);runbook 寫的是先停用店家再刪檔。
- 派工時給的 token 檔(「執行前必讀」B 節的 scratchpad `.sbp`)在 2026-10-11 00:00 左右不見了;Task 29 要用 token 的乾跑都在那之前跑完。
  Task 31 開工前要先向派工者確認新的 token 檔。

### 2026-10-11:Supabase Storage 2026-10-10 更新後的測試修正(commit `c261a85`,分支 `market`)

Supabase 在 2026-10-10 23:48(台北)自動更新 Storage schema(storage migration 72 `drop-bucketid-objname-index`),拿掉 `storage.objects` 的 `(bucket_id, name)` unique index、只剩帶條件的 `idx_objects_current_version (bucket_id, name COLLATE "C") WHERE archived_at IS NULL`,`market_images_storage.test.sql` 原本的 `ON CONFLICT (bucket_id, name)` 因此回 42P10:upsert 覆寫那項改成 Storage 現在的寫法 `ON CONFLICT (bucket_id, name COLLATE "C") WHERE archived_at IS NULL`(仍是 42501),並新增一項不綁 ON CONFLICT 的檢查「同一路徑直接再 INSERT 被擋(23505 或 42501 都算)」,乾跑 19 → **20** 項(前面要改成 19 的 Expected 一律改成 20);migration 120100 只有 `storage.buckets` 的 `ON CONFLICT (id)`,不受影響。🔴 不要在 Dashboard 打開 `market-images` 的版本功能:打開後關不回 DISABLED,「照片只能寫一次」就不成立。

### 2026-10-11:Task 32–34 migration 130000(commit `dc73b8a`、`3fe11c7`、`ca584e0`,分支 `market`)

`supabase/migrations/20261009130000_market_orders.sql` 跟計畫的三段程式碼區塊(第 8557–8818、8911–9045、9177–9229 行)逐字相同(diff 過);測試照抄,只改了下面第 1、3 點兩處。乾跑項數跟計畫一樣:Task 32 之後 **17**、Task 33 之後 **28**(確認失敗那次 9 項失敗,第一項「第一筆紀錄的身分是消費者」got `supplier`)、Task 34 之後 **45**(確認失敗那次 12 項失敗,第一項「狀態與接單時間套上去」got `pending|false|…`),每次乾跑之後殘留五個 0。

1. **乾跑不再帶 120000 / 120100**:第 1 階段已上線(合併 commit `6bf196e`,ledger 有這兩個版本),第 2 階段開頭(第 8402 行)「乾跑都要帶 `--with-migration …120000…`,帶著也沒關係」不再適用 —— 依派工指示不帶(派工者說重帶會報「已存在」;另外 120000 的 DROP / CREATE POLICY、DROP TRIGGER、ENABLE ROW LEVEL SECURITY 會在線上的 `market_stores` / `market_products` 拿 ACCESS EXCLUSIVE 鎖到 ROLLBACK,乾跑期間擋住市集的公開讀取)。
   - Task 32 Step 2:`dry supabase/tests/database/market_orders.test.sql`(不帶任何 migration;Expected 一樣是 42P01 `relation "public.market_orders" does not exist`)。
   - Task 32 Step 4、Task 33 / 34 的 Step 2 / 4:`dry supabase/tests/database/market_orders.test.sql --with-migration supabase/migrations/20261009130000_market_orders.sql`。
   - 測試檔開頭的執行說明改成只帶 130000。
   - 之後的 Task 也一樣,看到 `--with-migration …20261009120000…` / `…20261009120100…` 就拿掉:Task 35(第 9262、9330 行)、Task 36(第 9437、9525 行)、Task 39(第 10527 行)、Task 57 Step 2(第 16549–16556 行的 `$C`)。
2. **fixture 不用改**:共用工具 `_market_helpers.sql` 只建暫存表與 pg_temp 函式,沒有假設 120000 在交易裡建。測試的 fixture 直接打在線上第 1 階段的表上,也符合現行規則 —— 店家用資料庫擁有者身分 INSERT(`auth.role()` 是 NULL,不受擁有權檢查;A 店先建轉帳資訊再建店,轉帳檢查過得去)、已核准商品的 `photos` 是空陣列(核准時沒有照片要查,不受「只收 .jpg、核准前主圖與縮圖都要上傳」影響)、沒有自己帶 `created_at`、品名看得到字、沒有超過 10000 字、沒有刪店。Task 32 Step 2 失敗在建 `pg_temp.mk_order`(42P01),表示前面的 fixture 都已經在線上跑過。
3. **兩項權限檢查多驗 TRUNCATE / REFERENCES / TRIGGER / MAINTAIN**(第 1 節「anon 對訂單三張表沒有任何權限」「登入者:訂單、明細只能讀;紀錄只能讀和新增」,項數不變):計畫原本只驗 SELECT / INSERT / UPDATE / DELETE,跟第 1 階段審查找到的 MAINTAIN 漏洞同一類;TRUNCATE 不觸發逐列 trigger,漏收就能整張清掉「只能新增」的紀錄。突變驗證:把 migration 的 `REVOKE ALL` 改成只收 SELECT / INSERT / UPDATE / DELETE,計畫原本的測試仍是 17 項全過,改過的測試正好這兩項紅(anon got `true`、authenticated got `true|true|true|true|true`)。migration 不用改(本來就是 REVOKE ALL)。
4. **第 1 階段沒有受影響**:`market_catalog` **112**、`market_images_storage` **20**,不帶 migration(= 線上現況)與帶 130000(= 130000 套上之後)各跑一次,都是失敗 0;每次之後殘留五個 0。vitest **99 檔 / 1544 項**全過(目前還沒有 vitest 讀 130000,Task 43 起才有)。
5. **自查發現、沒有處理(記錄)**(另外用不提交的乾跑實測):
   - Task 34 開頭(第 9066 行)說轉帳自動待匯款那筆是「actor = system」,實際上**跟接單的人同一個身分**(guard 依登入身分決定;程式碼註解「同一個交易、同一個身分」才對):供應商接單 → `supplier`、管理員 → `admin`、service_role / 資料庫直連 → `system`。Task 42 的 notify 測試 fixture(第 11203 行)把這筆寫成 `actor_role: "system"`;`resolveEventMails` 對 `awaiting_payment` 不看身分(Task 41,第 10765 行),寄信結果不受影響,但之後若有畫面依 `actor_role` 顯示「系統」,會跟資料庫不一致。
   - 補庫存的 `UPDATE … FROM market_order_items`:同一張單同一個商品有兩列時只加回其中一列(實測 1 + 2 只加回 2)。下單 RPC(Task 37,第 10147–10151 行)先 `GROUP BY product_id` 合併,正式流程不會發生,只有繞過下單 RPC 直接寫明細才會。
   - 拒單 / 取消原因用 `btrim`(只去半形空白),只填全形空白或零寬字元也算有填原因(第 1 階段只有商品欄位用 `market_trim` / `market_visible`);前端送出前可以用 `hasVisibleText` 擋。
   - 45 項沒有測到 system 身分(service_role / 資料庫直連)與沒有 sub 的 authenticated JWT(第 1 階段第 2 輪複審的同類問題);實測行為正確(service_role 接轉帳單 OK、兩筆都記 `system`;沒有 sub → `ERR 42501:not_order_party`),但測試沒有釘住。
   - 乾跑 130000 會在線上的 `market_stores` / `market_products` 拿 SHARE ROW EXCLUSIVE 鎖(建外鍵),擋寫不擋讀,到 ROLLBACK 為止(每次幾秒)。
   - `market_*` 測試的 fixture 共用同一組 UUID / Email:兩支乾跑同時送會在唯一鍵上互等,超過 3 秒(`lock_timeout`)就失敗 —— 依序跑,不要並行。

### 2026-10-11:Task 40–42 `market-notify` 寄信閘門、通知信、主程式(commit `3d36ed6`、`83408a0`、`6407d44`、`4c2d56c`,分支 `market`)

gate / render / handler / index 與 `config.toml` 先照計畫的程式碼區塊抽出(依行號 sed,不重打);`render.ts` 與 `config.toml` 新增的那段跟計畫逐字相同。以下是不一樣的地方,每一項都先寫測試、看到失敗才改。**以 repo 為準。** 這三個 Task 沒有乾跑、沒有部署、沒有設定任何 secret。

1. **閘門的接線改成測得到**(派工要求把閘門用測試釘死):
   - `gate.ts` 多 `MARKET_LIVE_ENV`(= `"MARKET_NOTIFY_LIVE"`)與 `marketLiveFromEnv(get)`;`index.ts` 那一行從 `isLive(Deno.env.get("MARKET_NOTIFY_LIVE"))` 改成 `isLive: () => marketLiveFromEnv((k) => Deno.env.get(k))`(每次請求重讀)。index.ts 是 Deno 入口、vitest 跑不到,`handler.test.ts` 逐字比對這一行,而且 `isLive:` 只能出現一次。
   - 計畫原本只驗 notify 的 `isLive` 五個值,主旨也是拿常數比。`gate.test.ts` +3、`handler.test.ts` +4:沒設、空字串、`TRUE`、`True`、`1`、`" true"`、`"true "`、`"\ttrue"`、`"true\n"`、`yes`、`false`(gate 另驗 `on`、`0`)走完整條路徑 —— 下單確認、新訂單、接單、平台取消共 5 封,全部 `to` = `["ifoodmaptw@gmail.com"]`、主旨用字面值比對以「[測試轉寄] 」開頭、回信是平台信箱、純文字開頭列原收件人、`notifications.recipient` 全是內部信箱;餐廳訂單的 `NOTIFY_LIVE=true` 打不開零售;剛好 `"true"` 才寄本人(對照組);每次請求重讀、不快取。
   - 突變驗證:改成寬鬆比對(trim + 不分大小寫)、讀錯成 `NOTIFY_LIVE`、沒開時主旨不加前綴,各自 2 項紅;寬鬆比對只有新增的測試抓得到。
2. **token 進 log 之前先遮掉**:`handler.ts` 新增 `redactLog` —— `placed` 帶了格式正確的 token 時,這次請求的每一筆 log(含寄信失敗的 `r.error`、500 的 `e.message`)先把 token 換成 `***`。照抄版會把 Resend 的回應內文(`createResendSender` 取前 300 字)原樣寫進 log,內文夾帶信件連結時 token 就進了 log(照抄版實測這項紅,log 裡是完整 token)。`handler.test.ts` 再 +4:閘門關 / 開時 token 只在信裡的連結(html 與純文字);token 對不上(403)、讀資料庫失敗(500)、寄信失敗、買家 Email 不能寄時,回應內文、每一筆 log、每一次資料庫讀寫(條件與內容)、資料表內容都沒有 token。
3. **待匯款那筆的身分**:Task 32–34 一節「自查發現」第一點(跟接單的人同一個身分)已被 commit `f04df17` 改掉 —— migration 130000 現在一律記成 `system`、不記 actor_id。計畫 fixture 的 EV(4) `actor_role: "system"` 跟 migration 一致,沒有改。`render.test.ts` +1:`awaiting_payment` 不論 supplier / admin / system 都寄匯款資訊(之後 migration 再改也不影響寄信)。
4. **函式的 tsc strict 型別檢查**(DEPLOY.md 與先前的勘誤都沒寫做法;沿用 2026-10-07 ai / notify-lead 在 scratchpad 的做法):
   - compilerOptions:`target` ES2022、`module` ESNext、`moduleResolution` Bundler、`lib` [ES2022, DOM, DOM.Iterable]、`strict`、`noUnusedLocals`、`noFallthroughCasesInSwitch`、`allowImportingTsExtensions`、`skipLibCheck`、`noEmit`、`baseUrl` = repo 根目錄、`paths` `{"npm:@supabase/supabase-js@2": ["node_modules/@supabase/supabase-js"]}`、`types` []。
   - files:Deno shim(`declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };`)+ `supabase/functions/market-notify/index.ts`(連帶檢查 handler / gate / render、`_shared/db.ts`、`_shared/supplier-mail.ts`、`notify/gate.ts`、`ai/crypto.ts`、`src/lib/order-number.ts`);三支測試另一份設定(同上,`types` 改 ["node"]、`typeRoots` 指 repo 的 `node_modules/@types`、不用 shim 與 paths)。
   - 結果:兩份都 0 error;另放一支故意寫錯的檔確認 strictNullChecks(TS2322)、noImplicitAny(TS7006)、noUnusedLocals(TS6133)都會報。ai / notify-lead 原本那兩份設定重跑也還是 0 error。`npx eslint supabase/functions/market-notify/` 沒有輸出。
5. **數字**:Task 42 Step 4 的 Expected `Tests  30 passed (30)` → **`Tests  42 passed (42)`**(gate 8 + render 9 + handler 25);Task 40 Step 4 `5` → **8**、Task 41 Step 4 `8` → **9**。`4c2d56c` 的乾淨副本(`git archive`)全套 **105 檔 / 1619 項**全過(含其他實作者同時 commit 的檔);同一時間的工作目錄(含別人還沒 commit 的檔)106 檔 / 1634 項全過。「F. 共用指令與基準數字」第 2、3 階段的總數,在其他各節的調整之外再**多 12 項**(檔數不變)。
6. **自查發現、沒有處理(記錄)**:
   - `notifications` 寫入失敗不會被發現(insert 的 error 沒檢查,跟 notify 一樣):信照常寄,只是後台少一筆紀錄。
   - 主旨直接放店名(純文字、不跳脫是對的),但店名裡的換行、Tab 沒有壓成空白(供應商申請通知信有壓);Resend 走 JSON API 不會變成標頭注入,只是主旨可能斷行。
   - `NOTIFY_SECRET` 跟 notify 共用:拿到密鑰的人可以重送同一個 `event_id`,讓消費者重複收到同一封信(`placed` 要 token 雜湊對得上,偽造不了查詢連結);密鑰比對不是常數時間(同 notify)。
   - 部署(Task 57)時 `--use-api` 要把 `../ai/crypto.ts`、`../notify/gate.ts`、`../../../src/lib/order-number.ts` 一起上傳(notify 已經用同樣的方式 import order-number);部署後的驗收要看到確認信真的寄到內部信箱、連結打得開。

### 2026-10-11:migration 130000 自查修正、Task 35–39(commit `f04df17`、`a5174c1`、`a763553`、`5401c95`、`cb3cc27`、`c20e773`、`27650e0`、`4bf2141`、`4b54124`、`39a0651`,分支 `market`)

接上面「Task 32–34 migration 130000」一節。130100、130200 三段與三支還原檔先照計畫的程式碼區塊抽出(依行號 sed,diff 過逐字相同),再做下面的修正;每一項都先寫測試、看到失敗才改(只補測試的項目用突變驗證)。乾跑一律不帶 120000 / 120100(同上一節第 1 點)。**以 repo 為準。**

**A. 130000 自查修正**(上一節「自查發現」前四點的處理)

1. **轉帳訂單接單後自動補的「待匯款」一律記成 `system`、actor_id 清空**(`f04df17`):guard 只在 `pg_trigger_depth() > 1`(由 apply trigger 送出)、目標是 `awaiting_payment`、訂單目前是 `confirmed` 時改記 system;API 角色只能直接 INSERT(深度 1),也沒有在這幾張表建 trigger 的權限(REVOKE ALL,第 1 節權限測試釘住),冒充不了。轉移表 30 條沒動(前端 `orders.ts` 逐字對照)。供應商、管理員接單各一項,修之前都紅。跟 Task 42 fixture 的 EV(4) 一致(上面 Task 40–42 一節第 3 點)。
2. **拒單 / 取消補庫存先依商品加總明細數量**(`a5174c1`):同一個商品兩列(1 + 2)原本只加回 2,改成 `GROUP BY product_id` 後再 `UPDATE … FROM`。下單 RPC 本來就先合併同一個商品,這是防繞過下單 RPC 直接寫明細。
3. **拒單 / 取消原因改用 `market_visible` 判斷有沒有填、`market_trim` 去頭尾**(`a763553`):只填全形空白 / 零寬字元 → `reason_required`;頭尾的全形空白、零寬字元去掉後才存進紀錄與訂單的 `status_note`。沒有另外粗擋長度:100 萬字的刻意輸入實測 `market_trim` 13–52ms、`market_visible` 33ms,`btrim` 37ms,同一個量級。
4. **補 system 身分與沒有 sub 的 JWT**(`5401c95`,只補測試,行為本來就對):沒有 sub 的 authenticated JWT → `ERR 42501:not_order_party`;service_role 接單 → `system`、沒有 actor_id;資料庫擁有者直接寫(沒有 JWT)→ `system`。突變驗證:system 判斷改成只看 `v_uid IS NULL` →「沒有 sub」那項紅(RLS 仍會擋,但 guard 誤認成 system);只認 `auth.role() = 'service_role'` →「資料庫擁有者」那項紅。
5. 測試字串用 `chr(12288)`(U+3000)、`chr(8203)`(U+200B)組,不寫跳脫序列(避免第 1 階段勘誤提到的工具把跳脫換成看不見的字元本身);改完掃過 Zs / Zl / Zp / Cf / Cc,檔案裡沒有看不見的字元。

**B. Task 35–39 跟計畫不一樣的地方**

6. 四支測試檔開頭的執行說明拿掉 120000(Task 39 的 runner 註解同樣),命令見上一節第 1 點。fixture 不用改(店家用資料庫擁有者身分建、商品都沒有照片)。
7. **Task 36**:「計數表 anon / 登入者都碰不到」多驗 TRUNCATE / REFERENCES / TRIGGER / MAINTAIN(項數不變;anon 能 TRUNCATE 計數表就能把限流歸零)。突變驗證:REVOKE ALL 改成只收 S/I/U/D 時這項紅。
8. **下單 RPC 收件資料擋看不見的字元,並釘住安全要求**(`4b54124`,接在 Task 38 之後;派工要求「每個文字欄位都有長度上限,並擋看不見的字元」):
   - 姓名、地址、條款版本改成 `CASE WHEN market_visible(x) THEN market_trim(x) ELSE '' END`(只有看不見的字 → 長度檢查擋成 `INVALID_INPUT`,欄位 `buyer.name` / `buyer.address` / `terms_version`),備註看不到字當成沒填(NULL)。電話、Email、縣市照計畫(各自有只收數字 / ASCII / 22 縣市的檢查,看不見的字元本來就過不了)。照抄版這兩項紅:三個欄位都放行(`(沒有 field)`),訂單的姓名存成「U+3000 + 王小明 + U+200B」、備註存成只有看不見的字元。
   - 另外釘住(行為本來就對):第 1 節那一項加驗開關預設 `'false'`(計畫的測試在測「關閉」之前自己設成 `'false'`,migration 預設寫錯也不會紅;業主核准對外開放之後再跑這支,這一項會是 `2|true`,屬預期);地址 201 字、條款版本 21 字、Email 超過 254 字都擋;店家被管理員停用、供應商帳號停用時商品都 `PRODUCT_UNAVAILABLE`。突變驗證:開關預設值改成別的字(刻意不用 `'true'`)、拿掉地址 200 字上限、拿掉 `market_store_is_open`,各自正好一項紅。
   - 給 Task 43–47:伺服器現在會把只有看不見字元的姓名 / 地址回成 `INVALID_INPUT` + 欄位;結帳頁送出前可以用 `productForm.ts` 的 `hasVisibleText` 先擋(不擋也只是改由伺服器回欄位錯誤)。
9. 開關:`market_checkout.test.sql` 照計畫在交易裡把 `market_checkout_open` 切成 `'true'` 測開放後的行為,跟著 ROLLBACK 消失;正式庫目前沒有這一列(130200 沒套用)。每次乾跑之後另外用唯讀端點查:ledger 沒有 `2026100913*`、第 2 階段的表 / 函式 0、清理排程 0、三個 app_config 設定 0。

**C. 數字**

| 乾跑 | 計畫 | 現在 |
|---|---|---|
| `market_orders` | 45(Task 32 之後 17、Task 33 之後 28) | **53**(17 / 28 / 45 跟計畫一樣,A 節依序 47 → 48 → 50 → 53) |
| `market_notify` | 9 | 9 |
| `market_checkout` | 56(Task 36 之後 17、Task 37 之後 48) | **60**(17 / 48 / 56 跟計畫一樣,第 8 點 +4) |
| `market_phase2_rollback` | 4 | 4(確認失敗那次 3 項失敗:表 4 張、函式 19 支、排程與設定 `1|3`,跟計畫一樣) |

- 要跟著改的 Expected:「F. 共用指令與基準數字」第 116 行;Task 57 Step 2(第 16560 行)與 Step 5(第 16611 行)的 `共 45 項` → **53**、`共 56 項` → **60**(Step 2 的 `$C` 照上一節拿掉)。
- 第 1 階段沒有受影響:`market_catalog` **112**、`market_images_storage` **20**,不帶 migration、帶 130000、帶三支各跑一次都失敗 0;三支 migration + 三支還原檔之後 `market_catalog` 仍是 112。`market_orders` / `market_notify` 帶三支(= 部署後)也是 53 / 9。每次乾跑之後殘留五個 0。
- vitest:這幾個 Task 沒有新增 vitest。`39a0651` 的乾淨副本(`git archive`)全套 **106 檔 / 1634 項**全過(含其他實作者同時 commit 的檔);工作目錄裡讀第 2 階段 migration 的 4 支測試(`constants`、`orders`、`checkout`、`market-notify/handler`,含別人還沒 commit 的改動)61 項全過。

**D. 自查發現、沒有處理(記錄)**

- 查單 RPC(Task 38)回給持 token 的買家的店家資料含 `suppliers.contact_email`(新訂單通知信箱);第 1 階段已從市集公開欄位拿掉它(上面「前端修正」一節第 2 點)。買家要聯絡店家用得到,維持計畫寫法,請審查決定要不要換成另外的客服信箱或拿掉。
- 下單 RPC 的 Email 仍用 `btrim`:結尾夾全形空白的 Email 會回 `INVALID_INPUT` `buyer.email`,不會幫忙去掉(前端 JS 的 `trim()` 本來就會去掉 U+3000,正常流程不受影響)。
- 帶 130100 跑 `market_orders.test.sql` 時,每筆狀態紀錄會在交易裡把通知排到真的 market-notify 網址(跟著 ROLLBACK 消失、不會送出;殘留檢查只看 `127.0.0.1:9`)—— Task 57 Step 5 套用後不帶 migration 重跑也是同一回事。
- 「待匯款記成 system」靠 `pg_trigger_depth() > 1` 認 apply trigger;之後若有別的 trigger 也寫 `confirmed → awaiting_payment`,一樣會記成 system。

### 2026-10-11:Task 43–47 訂單狀態、購物車、加入購物車、結帳邏輯(commit `e1bde03`、`54aa8e9`、`209d6ab`、`274be41`、`a5f6c94`;自查修正 `b926ac5`、`39c2013`、`4bbf42b`、`98af078`,分支 `market`)

五個 Task 先照計畫做(每個都先看到失敗才實作),程式碼跟計畫的區塊相同,只有勘誤指定的地方不一樣;之後的自查修正各自一個 commit,每一項都先寫測試、看到失敗才改。**以 repo 為準。** 沒有乾跑、沒有查正式庫。

**A. 照勘誤調整的地方**

1. **Task 43**:`constants.test.ts` 加 migration 130000 的對照 `ORDER_LIMIT_PREFIXES`(`buyer_name` BETWEEN、`ship_address` BETWEEN 的兩個數字、`buyer_note` <=、`market_order_events.note` <=、`v_carrier` >、`v_tracking` >),跟 120000 那份合成 `LIMIT_SOURCES`;第一項合併兩份後跟 `{ ...LIMITS }` 比,「數字真的是從 migration 讀出來的」也跑新的對照,項數不變(10)。測試先寫:實作前 constants 這兩項紅(LIMITS 少 7 個 key;`buyerName: expected 51 to be NaN`)、orders `Failed to resolve import "./orders"`。Step 4 的 Expected `Tests  15 passed (15)` → **`Tests  20 passed (20)`**(orders 10 + constants 10)。突變驗證:`trackingNo` 100 → 99 兩項都紅。130000 之後的修正(`f04df17`、`a5174c1`、`a763553`)沒有動狀態、轉移表、狀態中文與這幾個上限,對照照樣過。
2. **Task 44**:`catalog.test.ts` 的 import 加在 `fetchMarketStore,` 後面、新測試放在「公開查詢」最後(勘誤第 17232–17233 行)。Step 2 是 1 failed / 16 passed,Step 4 **`Tests  32 passed (32)`**,跟勘誤一樣。
3. **Task 45**:照計畫,`Tests  4 passed (4)`(自查修正後是 6,見 B-1)。
4. **Task 46**:`MarketLayout.tsx` 的 `ShoppingCart` / `useCart` import 加在 react-router-dom 那行後面,`const { count } = useCart();` 放在函式第一行(勘誤第 17234–17235 行)。Step 2 是 3 failed / 24 passed,Step 4 **`Tests  27 passed (27)`**,跟勘誤一樣(自查修正後商品頁是 13 項,見 B-4)。
5. **Task 47**:照計畫,`Tests  15 passed (15)`(自查修正後是 16,見 B-3)。電話 / Email 的正規式標記在 130000 第 0 節,之後的修正沒有動。已 commit 的 130200(`27650e0`、`4b54124`)跟前端的介面一致:`market_place_order(p_checkout jsonb)`、`market_checkout_status()` 回 `{open, can_order}`,13 種錯誤代碼 `checkoutErrorMessage` 都有中文(`INVALID_INPUT` 的 `buyer` / `checkout` / `payments` / `expected_totals` / `terms_version` 用通用句)。

**B. 自查修正**

1. **購物車跨分頁同步:沒有人訂閱的期間漏掉別的分頁的修改**(`b926ac5`):`useCart` 只在有元件訂閱時聽 `storage` 事件。SPA 裡離開 `/market`(例如供應商從後台點「看消費者看到的店家頁」再按上一頁)期間別的分頁改了購物車,回到市集會顯示舊的,下一次加入還會拿舊的那份覆寫 localStorage(別的分頁加的商品不見)。改成第一個訂閱者進來時重讀一次 localStorage(內容一樣就沿用原本的陣列);這個分頁最後一次寫入沒存進 localStorage(無痕、額度滿)時不重讀,記憶體裡的才是對的。`useCart.test.tsx` 4 → **6**:「離開再回來讀到新的、加入不蓋掉」修之前紅;「寫不進去時回來記憶體裡的還在」修之前就過,是防「一律重讀」的回歸(拿掉 `!persisted` 會紅)。測試另外補 `afterEach(cleanup)`:vitest 沒開 `globals`,Testing Library 不會自動卸載,上一個測試的 hook 一直訂閱,「沒有人訂閱」的情境原本測不到(原本 4 項不受影響)。
2. **拒單 / 取消原因只有全形空白、零寬字元也算沒填**(`39c2013`):guard 改用 `market_visible`(`a763553`)之後,前端 `trim()` 去不掉 U+200B,會送出去再被 `reason_required` 擋。`validateOrderAction` 改用 `productForm.ts` 的 `hasVisibleText`。`orders.test.ts` 10 → **11**。
3. **結帳姓名、地址同上**(`4bbf42b`,即上一節第 8 點「給 Task 43–47」):`validateBuyer` 的姓名、地址改用 `hasVisibleText`,只有看不見字元時顯示「請填寫收件人姓名」「請填寫完整的收件地址(5–200 字)」,不用等伺服器回 `INVALID_INPUT`。`checkout.test.ts` 15 → **16**。備註沒改(伺服器當成沒填,不會擋)。
4. **手機的加入購物車列蓋住頁尾的條款連結**(`98af078`):計畫的 `fixed inset-x-0 bottom-0` 一直蓋在畫面最下面,`pb-32` 只保護商品頁自己的內容,保護不到 MarketLayout 的頁尾 —— 捲到最底時 Task 46 新加的「服務條款」「隱私權政策」被蓋住(點不到,Tab 到也看不到;WCAG 2.4.11)。改成 `sticky bottom-0 -mx-4`(在商品資訊那一欄裡黏在畫面底部,捲過就回到原位;`-mx-4` 抵掉頁面左右留白,手機滿版;`min-[881px]:mx-0` 還原),拿掉不再需要的 `pb-32`。實測方式:本機 vite 開一個不進 git 的驗證頁(真的 `MarketLayout` + `MarketProductPage`,react-query 先放好商品資料、`staleTime: Infinity`,環境變數用 ci-placeholder,不連任何資料庫),headless Chrome(DevTools Protocol)量位置 —— 改之前 390×844 捲到最底,兩個連結中心點的 `elementFromPoint` 是數量按鈕;改之後 390×844、360×640 都 visible,最上面時列黏在畫面底部(390 寬:763–844、滿版)、沒有橫向捲動(`scrollWidth` = 視窗寬),1280×800 跟原本一樣 static。`MarketProductPage.test.tsx` 12 → **13**(釘住 `sticky bottom-0 min-[881px]:static`、不准 `fixed`)。

**C. 數字**

- 乾淨副本(`git archive` `98af078`)全套 vitest 連跑 2 次都是 **106 檔 / 1639 項**全過(含其他實作者同時 commit 的 market-notify 3 檔 / 42 項)。這五個 Task 照計畫是 4 檔 / 48 項(orders 10、cart 15、useCart 4、checkout 15,catalog +1、market-components +1、MarketProductPage +2),自查修正再 +5 項(檔數不變):「F. 共用指令與基準數字」第 2、3 階段的總數,在其他各節的調整之外再**多 5 項**。
- tsc 錯誤 **72**、eslint 錯誤 **10**(新檔與改到的檔都沒有 error,warning 只有原本就有的 `react-refresh/only-export-components`),兩種 build 都 exit 0(前台站 bundle 有「加入購物車」,管理員站沒有)。
- Task 48 之後的「找到 → 換成」只動 `App.tsx`、`App.market-routes.test.tsx`、`AdminLayout(.test).tsx`、`AdminRoutes.test.tsx`、`SupplierLayout(.test).tsx` 與形象站,不受這幾個 Task 影響;`cart.ts` / `useCart.ts` / `checkout.ts` / `orders.ts` export 的名稱與簽名都跟計畫一樣。

**D. 自查核對過、一致(不用改)**

- 運費、免運、最低金額跟 130200 一樣:小計 ≥ 免運門檻(門檻不是 null)→ 運費 0,否則店家的固定運費;最低金額比的是小計(不含運費),`subtotal < min_order_amount` 才擋;`expected_totals` 送每店的小計 + 運費(伺服器用字串比對 `->>`,JSON 整數沒有小數點);「已下架」的條件(已核准、上架中、店家啟用、供應商啟用)= 伺服器的 `PRODUCT_UNAVAILABLE`;每項 1–99、最多 50 種跟伺服器一樣。測試釘住 999 / 1000 的免運邊界、剛好等於最低金額、沒有門檻的店、運費 0 的店。

**E. 自查發現、沒有處理(記錄)**

- 長度用 JS 的 `.length`(UTF-16)、資料庫用 `char_length`(碼位):罕用字(擴充區 B 以後)一個字算 2,上限比資料庫嚴、地址下限 5 字比資料庫鬆(伺服器回 `buyer.address`);跟第 1 階段表單同一個慣例。
- 兩個分頁在 storage 事件送達之前(毫秒級)同時加入購物車,後寫的會蓋掉先寫的(localStorage 沒有原子的讀改寫)。
- 超過庫存的那一列照樣算進小計、運費、免運與最低金額;這家店已經因為「超過庫存」不能結帳,改了數量就重算,只影響顯示。
- `buildCart` 沒有檢查一次最多 10 家店(`CART_LIMITS.maxStores`):Task 50 結帳頁送出前檢查,伺服器也會回 `TOO_MANY_STORES`。

### 2026-10-11:Task 40–42 補充(fresh-context 審查後)(commit `2074cfc`、`4f0e541`,分支 `market`)

接上面「Task 40–42 `market-notify`」一節。fresh-context 審查(只給驗收條件與 diff 範圍)八項驗收全過,另外找到 1 個低嚴重度缺口,已修;也照審查的說明把閘門測試補齊。**以 repo 為準。**

1. **被截斷的 token 片段也要遮**(`2074cfc`):`createResendSender` 只留 Resend 錯誤內文的前 300 字,截點落在 token 中間時,上一節的 `redactLog` 只比對完整 token,前半段會留在 log(截點不同可留 1–42 字;留到 40 字以上只剩幾字可猜,而 `market_get_orders` 開放 anon)。改成逐一處理 log 裡的字串(不在序列化後的 JSON 上改,跳脫字元不會被弄壞),token 與任何 **8 字以上的 token 片段**都換成 `***`(少於 8 字最多透露 42 bits)。`handler.test.ts` +1:截在 token 中間、從 token 中間開始(沒有網址前綴)兩種,log 裡找不到任何 8 字片段;先紅(log 留下 token 前 20 字)後綠。
2. **閘門測試走過每一種信**(`4f0e541`,項數不變):上一節「每一種值」那項原本只走下單確認、新訂單、接單、平台取消 5 封;測試裡另外補拒單、供應商自己取消兩筆紀錄(不改計畫的 fixture),現在每個值都走下單確認 + 7 種狀態信共 9 封,並檢查 7 種信都出現過。突變驗證:讓出貨信繞過閘門,只有這項紅(計畫原本的出貨測試是在閘門開放時跑的)。
3. **Node 端到端(scratchpad,不進 repo)**:照 ai 的做法(Node 25 直接載入真正的 `market-notify/index.ts`,Deno 換成替身、`npm:@supabase/supabase-js@2` 用 loader 換成記憶體假 DB、Resend 用 mock fetch,沒有任何網路請求)16 / 16 過:11 種不開的值、對照組、每次請求重讀、Resend 422 夾帶連結、截點落在 token 中間(走真正的 300 字截斷)、403 / 401 / 503。同一套換成計畫的照抄版 → 422 那項紅(console 裡是完整 token);index.ts 寫死 `isLive: () => true` → 13 項紅;換成 `4c2d56c`(只遮完整 token)→ 截斷那項紅。
4. **數字(取代上一節第 5 點的總數)**:Task 42 Step 4 的 Expected → **`Tests  43 passed (43)`**(gate 8 + render 9 + handler 26);「F. 共用指令與基準數字」第 2、3 階段的總數比計畫**多 13 項**(上一節寫的 12 改成 13)。`4f0e541` 的乾淨副本(`git archive`)全套 **106 檔 / 1642 項**全過(含其他實作者同時 commit 的檔);tsc strict(上一節第 4 點的兩份設定)0 error,eslint 沒有輸出。
5. 審查的其他說明:OPTIONS 回 200(CORS 預檢)是「非 POST 一律 405」唯一的例外,沒有實際影響。上一節第 6 點「自查發現、沒有處理」的四項不變。

### 2026-10-11:Task 43–47 補充(數量框、fresh-context 驗收後)(commit `fdd97a7`、`164667a`、`42945c8`、`4a66963`、`00977ae`,分支 `market`)

接上面「Task 43–47 訂單狀態、購物車…」一節(B 節之後又修了下面幾點,每一項都先寫測試、看到失敗才改)。**以 repo 為準。** 另外 `2e843dd`(其他實作者)在 migration 130000 的轉移表加了 `paid → cancelled`,同步改了 `orders.ts` 的 `MARKET_TRANSITIONS` 與 `orders.test.ts` 的按鈕預期(項數不變)。

1. **數量框打字**(`fdd97a7`、`164667a`、`42945c8`,Task 46 的 `QtyStepper`;購物車頁 Task 48 每一列也用它):計畫的 `onChange(clamp(Number(e.target.value)))` 在清空時立刻送出 1,React 把框裡的字改回「1」,接著打「5」就變成「15」(購物車頁會直接把那一列改成 15);清空就離開也會把數量改成 1。改成打字先放在 `draft`:清空不送出,打出數字才夾在範圍內送出,離開欄位時框裡顯示實際的數量(清空就離開 = 不改)。iOS 點按鈕不會讓數字框失去焦點(沒有 blur),所以 + / − 也清掉 draft,而且 draft 記著它對應的數量 —— 數量被外面改掉(按「加入購物車」後歸 1、別的分頁改了)就改顯示實際的數量(原本打 5 加入後框裡還是 5,再按一次只加 1)。測試用 `fireEvent.click`(不移動焦點)模擬 iOS。
2. **AddToCart 換商品整個重來**(`42945c8`):外層用商品 id 當 key 包一層 `AddToCartPanel`。路由 `:productId` 換了時 React 沿用同一個元件,原本數量與「已加入購物車」會留到下一個商品(現在的畫面沒有商品直接連到商品,先防著)。
3. **跨分頁同步再補一處**(`4a66963`,接 B-1):寫入失敗過一次(`persisted = false`)之後,就算 storage 事件已經讓記憶體跟 localStorage 一致,離開市集再回來也不會重讀,下一次加入會蓋掉別的分頁加的商品。storage 事件重讀成功後 `persisted` 設回 true。
4. **結帳錯誤訊息**(`00977ae`,Task 47):每天的限流 `retry_after` 可能好幾萬秒,原本顯示「請 510 分鐘後再試」→ 2 小時以上改用小時(一律無條件進位)。原本 13 種代碼只測 6 種(`ceil` 改 `floor`、換掉 `PRODUCT_UNAVAILABLE` 的句子都不會紅):補其餘代碼的句子,並解析 migration 130200 從 `market_rate_take` 到 `market_place_order` 結束的每一種 `'code', '…'`,確認都有自己的一句話、不會掉到「下單失敗,請稍後再試。」(`market_get_orders` 的 `NOT_FOUND` 由 Task 51 查單頁處理,不算)。
5. **最終數字**(取代上一節 C 的總數):`8db6138` 的乾淨副本(`git archive`)全套 vitest 連跑 2 次都是 **106 檔 / 1656 項**全過(含其他實作者的 market-notify 3 檔 / 49 項)。這五個 Task 照計畫是 4 檔 / 48 項,自查與驗收後的修正共 **+15 項**(檔數不變):orders 10 → **11**、useCart 4 → **7**、checkout 15 → **19**、market-components 15 → **20**、MarketProductPage 12 → **14**(cart 15、catalog 17、constants 10 跟計畫一樣)。「F. 共用指令與基準數字」第 2、3 階段的總數在其他各節的調整之外再多 **15** 項(上一節寫的 5 項作廢)。tsc 錯誤 **72**、eslint 錯誤 **10**,兩種 build 都 exit 0。
6. **fresh-context 驗收**(Code Reviewer,只給驗收條件與 diff 範圍):在一次性的本機 Postgres(Unix socket,用完刪掉;只 stub auth / roles / cron / pgcrypto)載入 120000 / 130000 / 130200 原文,把真的 `buildCart` / `buildCheckoutPayload` 丟進真的 `market_place_order`:260 個情境、1026 次 RPC,運費 / 免運 / 最低金額 / 可否結帳 / `expected_totals` **0 不一致**(邊界:剛好等於免運門檻 94 次、等於最低金額 110 次、沒有門檻 96 次、運費 0 共 165 次);`orders.ts` 對真的 guard 312 次,畫面給的按鈕 100% 被接受;收件資料 98 組、原因 / 物流 44 組,前端只有地址比伺服器鬆(見下)。它找到的 F1(第 1 點「加入後框裡還是 5」)、F2(第 3 點)、F3(第 2 點)、F4(第 4 點)都已修;第 1 點前半(清空變 15、+ / − 清 draft)是驗收前自查修的。驗收沒有連任何正式庫。
7. **給後續 Task 與 130200 的注意事項(沒有處理)**:
   - 轉帳單接單時「已接單」和自動補的「待匯款」在同一個交易,`created_at` 一樣:`market_get_orders` 的 `ORDER BY created_at, id` 由隨機 uuid 決定先後(驗收的模擬 60 單有 26 單「待匯款」排在「已接單」前面);Task 55 管理員頁(第 16311–16312 行)用 `created_at` 排序、`fetchAdminOrders` 內嵌的 `market_order_events` 也沒排序,一樣分不出先後。建議同時間再用 `ORDER_STATUSES` 的順序當第二排序(資料庫端可用 `array_position`)。Task 51 查單頁、Task 55 畫時間軸時要處理。
   - 地址前後夾零寬字元時,JS 的長度可能 ≥ 5、伺服器 `market_trim` 之後 < 5(回 `buyer.address`,畫面顯示「收件地址格式不對」,不會壞);跟上一節 E 的罕用字同一類。

### 2026-10-11:Task 40–42 審查修正(commit `f310110`、`1bf0193`、`ea30739`、`754ab43`、`1986105`、`e31a088`、`7354efc`、`f74f7ab`、`bbf6e22`,分支 `market`)

接上面兩節「Task 40–42」。審查結果規格通過、沒有 Critical,要求修 9 項,全部做完;每項都先寫測試、看到紅才改(只是補洞的測試用突變驗證)。只動 `supabase/functions/market-notify/` 與本勘誤。**以 repo 為準。**

1. **跳脫測試**(Important,`f310110`):每個店家 / 買家能控制、會進信件的欄位(店名、店家電話、品名、規格、匯款資訊、物流、單號、原因、買家姓名、縣市、備註)各放一個記號加 `<a href="https://evil.example">點我</a>`、`"><img src=x onerror=alert(1)>`、`&`;下單確認與 7 種狀態信都斷言 html 沒有原始的 `<a href="https://evil` 或 `<img`、每個欄位都是跳脫後的樣子;text 不做 HTML 跳脫。新訂單信本來就只放收件縣市、不放地址(計畫原樣),測試另外斷言地址哪一封都不出現。
2. **金額測試**(Important,`f310110`):小計 1234、運費 150、總額 1384、兩列小計 615 / 619(單價 205 / 619)全都不同;html 比對「標籤格的下一格」、text 比對整行,render 與 handler 兩層都測(handler 層從資料庫欄位讀,欄位對錯一定紅)。明細表與純文字**新增「小計」一列**(原本只有運費、總額,小計沒有標籤可以對)。
3. **密鑰常數時間比對**(Minor 1,`1986105`):`secretMatches` 兩邊先 sha256(都是 64 個 hex 字)再逐字 XOR 累加。測試:只對開頭、多一個字、重複兩次、少一個字、大小寫不同、沒有 Bearer、空的都擋、都不寄。🔴 審查寫「都要回 403」,但計畫規定密鑰不對回 **401**(token 對不上才是 403;既有測試與審查員的 e2e 也是 401)→ 維持 401。
4. **主旨單行**(Minor 2,`1bf0193`):`render.ts` 的 `oneLine`(`\p{Cc}` 控制字元與 U+2028 / U+2029 換成空白、連續空白壓成一個;supplier-mail 的 oneLine 沒有 export,另寫一份),placedMail / renderEventMail 回傳前套用。測試店名 `"A 店\r\nBcc: x@y…"`,每一種信的主旨與實際交給寄信的主旨(閘門開 / 關)都只有一行。
5. **notifications 寫入要檢查**(Minor 3,`e31a088`):`recordNotification` 檢查 insert 的 error,失敗只記 log(下單確認走遮 token 的 redactLog),寄信結果不變。
6. **防重送**(Minor 4,`7354efc`):新增 `send.ts` 的 `createMarketResendSender`:沿用 `_shared` 的 `createResendSender`,經 `fetchImpl` 補 Resend 的 `Idempotency-Key` 標頭(`_shared` 不能改、`SendMail` 不收標頭);`index.ts` 改接它(測試逐字比對那一行)。key:狀態信 `market-notify:<event_id>:<consumer|supplier>`、下單確認 `market-notify:placed:<checkout_id>`(不用 token)。同一個 key 24 小時內內容不同 Resend 回 409(例如閘門關著時寄過、24 小時內開閘門後重送同一個事件)→ 記成 failed。
7. **收件 Email 不合格**(Minor 5,`f74f7ab`):買家 Email、店家聯絡信箱不能寄時跳過、記 log(帳號只留第一個字、網域照留)並在 notifications 留一筆 `status = failed`、message 結尾「(沒寄:原因)」的紀錄(status 只收 sent / failed / pending,沒有改 schema)。補測試缺口:系統取消也通知店家、店家信箱不是空的但格式不對要跳過、(另加)請求帶 `live: true` 打不開閘門、同一次結帳的雜湊不一致一律 403。
8. **已收款的單也能取消**(`754ab43`、`bbf6e22`):讀訂單多讀 `paid_at`(測試對照 130000 的 CREATE TABLE);已收款(paid_at 有值,或紀錄的 from_status = paid)時消費者的取消信寫「這張訂單店家已確認收款,退款由店家處理,請直接聯絡店家(店家電話:…)。iFoodmap 平台不經手款項。」;管理員 / 系統取消照舊也通知店家。資料庫的 paid → cancelled 轉換由資料庫修正者加,這邊只看 from_status / paid_at,轉移表怎麼改都不影響。
9. **給消費者的信不出現店家的 contact_email**(`ea30739`):計畫原本讓消費者的信 reply_to = 店家 contact_email → 改成一律平台信箱;下單確認(每家店那段)與給消費者的狀態信改附「店家電話」(suppliers.phone,店家頁本來就公開;沒填不寫)。**計畫的測試「貨到付款接單 → 消費者;回信給店家」改成回信到平台信箱**;fixture 的 suppliers 加 `phone`。新測試檢查 html、text、reply_to 三處(閘門開 / 關)。
- 上面「Task 40–42」一節第 6 點「自查發現、沒有處理」的前三項(notifications 寫入不檢查、主旨不壓單行、共享密鑰重送與非常數時間比對)這次都已處理。

**數字**

- market-notify vitest:**4 檔 / 72 項**(gate 8、send 3、render 22、handler 39;上一節是 3 檔 / 43 項)→ Task 42 Step 4 的 Expected 改成 **`Tests  72 passed (72)`**;「F. 共用指令與基準數字」第 2、3 階段的總數比計畫多 **42 項、1 檔**(取代上一節的 13 項)。tsc strict 兩份設定(做法見上面「Task 40–42」一節第 4 點,測試那份多 `send.test.ts`)0 error,eslint 沒有輸出。
- 全套:`6e0e208` 的乾淨副本(`git archive`)**109 檔 / 1694 項**全過(含其他實作者同時 commit 的檔)。
- 審查員的突變腳本(`scratchpad/review-notify/mutate.mjs`,51 處):修改前 36 殺 / 15 存活;修改後同一份清單 **46 殺 / 0 存活**、5 處的 find 字串已不存在(這次改寫的 G13、A1、A2、E4、E5)。v2 腳本(`scratchpad/review-notify-v2/mutate2.mjs`:那 5 處照新程式改寫、另加 14 處這次的新功能)65 處 **64 殺、1 存活**(N3:下單確認的主旨沒有任何變數,拿掉 oneLine 輸出不變,等價)。原本存活的 15 處全部變紅,含可以扣掉的 G15(等價後門)、T3(等價)、S3(文案)。
- 審查員的 e2e(`scratchpad/review-notify/e2e/e2e.test.ts` 原檔,程式換成新版):19 / 20,唯一紅的是記錄舊行為的「店名的 CRLF 原樣進主旨」(第 4 點修掉了);把那項反過來、另加一項「每個 Resend 請求都帶 Idempotency-Key」的改版(`review-notify-v2/e2e/e2e-adapted.test.ts`)21 / 21。
- 🔴 在 scratchpad 跑突變 / e2e 要固定 vitest 版本:repo 的 `node_modules/.bin` 在 16:07 左右短暫消失過(有人在重裝),那段時間 scratchpad 裡的 `npx vitest` 會改用 npx 快取的 **vitest 4.1.11**,同一組測試固定多 3 項失敗,讓每個突變都看起來被殺了。改用 `node /Users/aimand/.gemini/File/ifoodmap/node_modules/vitest/vitest.mjs`(2.1.9)跑,上面的數字都是這樣得到的。

### 2026-10-11:第 2 階段三支 migration 審查修正(commit `2e843dd`、`5a6ce74`、`8db6138`、`9c820d1`、`4efbf5b`、`f1487ac`、`51d6087`、`b792648`、`4b73061`、`d55b19c`、`6e0e208`,分支 `market`)

審查沒有 Critical;下面每一項都先寫測試、看到失敗才改(只補測試的用突變驗證)。130000、130200 都還沒套正式庫,直接改原檔。**以 repo 為準。** 乾跑一律不帶 120000 / 120100。

1. **已收款的轉帳單也能取消**(`2e843dd`):設計文件與計畫的狀態機只寫到「待匯款 → 取消」,店家收了錢卻出不了貨時這張單會卡死。130000 轉移表三種身分各加 `('paid', 'cancelled', 'transfer')`(30 → 33 條),原因必填、庫存照補,跟其他取消一樣;前端鏡像 `src/lib/market/orders.ts` 的 `MARKET_TRANSITIONS` 與 `orders.test.ts` 同一個 commit 一起改(已收款:供應商「出貨 / 取消」、管理員「取消」)。消費者的取消信補「已匯款,退款由店家處理」由 market-notify 修正者處理。
   - **給 Task 53**(供應商零售訂單):已收款狀態多一顆「取消訂單」(要填原因;`supplierActions` 已經回 `["shipped", "cancelled"]`)。Task 55 管理員的「平台取消」在已收款也會出現(`adminActions`)。
2. **限流重排**(`d55b19c`,Important 1):`market_place_order` 改成 欄位檢查 → 開關 → A 段 → 購物車 / 商品 / 店家檢查與算錢 → B 段 → 建單。「C. 關鍵技術決定」第 1 點的「限流放在下單開關之前,開放前的嘗試一樣會被計數」作廢。
   - 開關關著:回 `MARKET_CLOSED`,不寫任何計數。
   - A 段(同一個網路的嘗試次數,失敗的嘗試也算,回 `RATE_LIMITED`):IP(IPv4 完整位址、IPv6 取 /64)每小時 5 / 每天 20;IPv6 另加 /48 彙總(bucket 種類 `ip48`)每小時 20 / 每天 80;拿不到 IP 跳過整段。
   - B 段(所有檢查都過、準備建單時才扣,一次結帳不論幾家店都算 1):Email 每小時 3 / 每天 10、電話每天 10、全站每天 500(`DAILY_CAP`)。B 段被擋 → 不建單、不動庫存,A 段已扣的照算。`PRICE_CHANGED`、`OUT_OF_STOCK`、`EMPTY_CART`、`ORDER_TOO_LARGE`、配送不到、未達最低金額等都不吃 B 段。管理員照樣不限流。
   - 鎖的順序:A 段計數列 → 依 id 鎖商品(FOR UPDATE)→ B 段計數列;兩段的 bucket 不重疊,所有結帳同一個順序。
   - 測試證明四件事(修之前 6 項紅):失敗的嘗試(缺貨、價格變了、未達最低金額)不吃 Email / 電話 / 全站(同一個 Email 先失敗 3 次、第 4 次照樣成功;計數 Email 1、電話 1、全站 +1、IP 4);開關關著不寫任何計數;B 段超額 → `RATE_LIMITED`、不建單、庫存不變、A 段照算 1;同一個 /48 的 21 個 /64 → 第 21 次 `RATE_LIMITED`、另一個 /48 照常。突變驗證:B 段被擋也照樣建單 →「B 段超額」紅。
3. **`stock_deducted`**(`51d6087`、`b792648`,Minor a / e):`market_order_items` 加 `stock_deducted integer NOT NULL DEFAULT 0`、CHECK `stock_deducted BETWEEN 0 AND qty`;下單時商品有設庫存記 qty、不限量記 0;拒單 / 取消依商品加總 `stock_deducted` 補回,商品現在是不限量就不動(審查員的情境:下單時不限量 → 店家改成 10 → 取消,原本變 12,現在維持 10)。補庫存前先 `ORDER BY p.id FOR UPDATE` 鎖住商品再 UPDATE(跟下單同一個鎖順序;死結在單一連線的乾跑重現不了,跟計畫「下單 RPC 有鎖商品列」一樣用函式定義釘住)。訂單測試裡代表「扣過庫存」的明細 fixture 補上 `stock_deducted`。
4. **`ORDER_TOO_LARGE`**(`4b73061`、`6e0e208`,Minor b):小計改用 bigint(`sum(price * qty)` 不再 `::integer`),任一家店「小計 + 運費」超過 1,000,000 → `{ok:false, code:'ORDER_TOO_LARGE', stores:[{supplier_id, total}]}`,在任何 `::integer` 轉型之前檢查,不丟例外、不建單、庫存不變(22 件百萬元商品各 99 個實測);剛好 1,000,000 照樣能下單。`market_orders_money` 另加 `total <= 1000000` 當第二道。前端 `checkout.ts` 加「A 店 這張訂單超過 NT$1,000,000,請減少數量或分開下單。」—— `00977ae` 的「每一種代碼都有自己的一句話」在 `4b73061` 到 `6e0e208` 之間是紅的(約 30 分鐘)。
5. **查單不給 `contact_email`**(`9c820d1`,Minor c):`market_get_orders` 的 `store` 只留 `supplier_id`、`name`、`phone`、`ship_days`、`return_policy`;測試釘住回應裡沒有 `contact_email`。
   - **給 Task 51**(查單頁):lookup 的型別與畫面都不要有 `contact_email`(店家聯絡方式只顯示店名、電話)。
6. **事件時間**(`4efbf5b`,協調者追加):guard 原本用 `now()`(交易開始的時間)覆寫 `created_at`,轉帳單的「已接單」和自動補的「待匯款」完全相同,`market_get_orders` 的 `ORDER BY created_at, id` 由隨機 uuid 決定先後(上面「Task 43–47 補充」第 7 點記的就是這個)。改成 `GREATEST(clock_timestamp(), 這張單上一筆 + 1 微秒)`,同一張單嚴格遞增(同一微秒、主機時鐘被往回調也一樣),一律由伺服器決定 —— system 原本可以自己帶時間,現在也不行(不然自動補的待匯款會停在交易開始的時間、排到已接單前面;突變驗證 4 項紅);第一筆紀錄是 `clock_timestamp()`。前端照 `created_at` 排序就是寫入順序,不用再拿狀態順序當第二排序;`fetchAdminOrders` 內嵌的 `market_order_events` 仍要自己依 `created_at` 排序(PostgREST 內嵌不保證順序)。
7. **權限與出貨欄位**(`f1487ac`,Minor f):`market_phone_ok` / `market_email_ok` 收回 PUBLIC / anon / authenticated(只給 `market_orders` 的 CHECK 與 SECURITY DEFINER 的下單 RPC 用,以擁有者身分執行;乾跑全綠,anon 經 RPC 下單照常)。出貨的物流、單號改用 `market_visible` 判斷有沒有填、`market_trim` 去頭尾(只填全形空白 → `carrier_required`),`char_length(v_carrier) > 50` / `char_length(v_tracking) > 100` 的寫法沒動(`constants.test.ts` 逐字讀)。
8. **測試盲點**(`5a6ce74`、`8db6138`,Minor d):`market_checkout.test.sql`「任何一條超過就整批退回:另一條也不加」拆成一句做、一句讀(同一句的子查詢看句子開始時的快照,永遠讀到 0);突變驗證:130200 改成超額不回滾,拆開前照樣綠、拆開後紅。另外「計數表裡沒有明文」原本用 `'09[0-9]{8}'` 找電話,十六進位的雜湊偶爾也會出現「09 + 8 位數字」(鹽每次隨機,實測紅過一次),改成每個 bucket 都要是「種類:16 位雜湊|窗格」或 `global|day`(突變:不雜湊時紅)。
9. 這次不做(協調者決定,寫進 DEPLOY.md 的開放前待辦):待接單逾時自動取消、Turnstile。

**數字**

| 乾跑 | 上一節(Task 35–39) | 現在 |
|---|---|---|
| `market_orders` | 53 | **65**(`2e843dd` +3、`4efbf5b` +3、`f1487ac` +3、`51d6087` +1、`b792648` +1、`4b73061` +1) |
| `market_notify` | 9 | 9 |
| `market_checkout` | 60 | **74**(`5a6ce74` +1、`9c820d1` +1、`4efbf5b` +1、`51d6087` +2、`4b73061` +2、`d55b19c` +7;`8db6138` 改寫不加項) |
| `market_phase2_rollback` | 4 | 4(沒有新函式;`stock_deducted` 跟著表一起拆) |

- **Task 57** Step 2(第 16560 行)的 Expected 改成依序 `共 65 項` / `共 9 項` / `共 74 項` / `共 4 項`,Step 5(第 16611 行)改成 `共 65 項` / `共 9 項` / `共 74 項`(上一節的 53 / 60 作廢;命令裡的 `$C` 照前兩節拿掉)。「F. 共用指令與基準數字」第 116 行同樣改成 65 / 9 / 74 / 4。
- 第 1 階段:`market_catalog` **112**、`market_images_storage` **20**,不帶 migration 與帶三支各跑一次都失敗 0;每次乾跑之後殘留五個 0;唯讀查正式庫沒有任何第 2 階段的物件。
- 審查員的攻擊測試(scratchpad `market-review/p2-db/`):`atk_checkout` 33 項,修之前 6 項紅(A3、B4、C1、D5、F4、H1);修之後原版剩 4 項紅,都是審查員的期待跟這次的設計不同 —— B3(原本期待 500 次空購物車吃光全站額度;有 /48 彙總後是 20 次空購物車、485 次 `RATE_LIMITED`)、C1(代碼 `TOO_EXPENSIVE` → `ORDER_TOO_LARGE`、Email 計數 1 → 0)、C2(原本期待 22003 例外 + 整筆回滾 → 建單前就回 `ORDER_TOO_LARGE`,一樣沒有半套、庫存 10)、F2(已收款不能取消 → 可以)。只改這 4 項期待值的副本(scratchpad `atk-adapted/`)33 / 33 全過;`atk_rollback_fp` 2 / 2(還原後第 1 階段與共用物件的指紋跟線上一樣)。
- vitest:`6e0e208` 的乾淨副本(`git archive`)全套連跑 2 次都是 **109 檔 / 1694 項**全過(含其他實作者同時 commit 的檔);tsc 錯誤 **72**、eslint 錯誤 **10**,兩種 build 都 exit 0。

**沒有處理(記錄,請審查決定)**

- 拿不到 IP 時 A 段整段跳過,B 段又只算真的建單:沒有 IP 的失敗嘗試(每次都會鎖商品列、跑完整檢查)完全不限流。Task 57 若驗出 PostgREST 拿不到可信的 IP,建議加一個寬鬆的全站「無 IP 嘗試」bucket。
- 商品單價上限 1,000,000 跟單店總額上限 1,000,000 一樣:沒有免運門檻(或門檻 > 1,000,000)的店,一件 1,000,000 元的商品加上運費就超過上限,永遠下不了單。要嘛總額上限只看小計,要嘛把單價上限調低。
- /48 每小時 20 次:同一個 /48 背後可能是公司或校園的網段,正式開放後依實際量調整。

### 2026-10-11:審查修正補充 —— 金額上限只看商品小計、拿不到 IP 的保底額度(commit `c88296c`、`689a849`,分支 `market`)

接上面「第 2 階段三支 migration 審查修正」一節,照協調者決定追加兩項(上一節「沒有處理」的前兩點)。每一項都先寫測試、看到失敗才改。**以 repo 為準。**

1. **金額上限只看商品小計**(`c88296c`;130000、130200、`checkout.ts`、`checkout.test.ts` 與兩支乾跑測試同一個 commit,中間沒有讓別人的測試紅):
   - 規則:任一家店的商品小計(不含運費)> 1,000,000 → `ORDER_TOO_LARGE`,`stores: [{supplier_id, subtotal}]`(上一節是看「小計 + 運費」、帶 `total`)。一件 1,000,000 元的商品加運費買得到,最低訂購金額的上限 1,000,000 也一定達得到。
   - `market_orders_money` 改成 `subtotal BETWEEN 1 AND 1000000 AND shipping_fee BETWEEN 0 AND 10000 AND total = subtotal + shipping_fee`(拿掉 `total <= 1000000`;運費上限跟店家設定的 10,000 一樣)。`shipping_fee BETWEEN` 在 130000 是新出現的寫法,`constants.test.ts` 的 `shippingFee` 只讀 120000,不受影響。
   - 前端訊息:「A 店 這張訂單的商品金額(不含運費)超過 NT$1,000,000,請減少數量或分開下單。」
   - 測試:一件 1,000,000 元(B 店運費 60)→ 成功、總額 1,000,060;商品小計 1,000,001(百萬元品 + 一元加購品)→ `ORDER_TOO_LARGE`、帶小計、不建單;22 件 1,000,000 元 × 99 → `ORDER_TOO_LARGE`、不建單、22 件庫存都不變;CHECK 三種(小計 1,000,001 擋、1,000,000 + 運費 120 存得進去、運費 10,001 擋)。修之前這 3 項紅(百萬元品加運費被擋、回應沒有 subtotal、CHECK 擋錯邊)。上一節的「剛好 1,000,000(滿額免運)」改成 B 店加運費那一項;另外修正我自己的測試:新加的兩個商品 id 也符合 `…000000d00%`,22 件庫存的檢查改成 `…000000d000%` 並驗 22 筆。
2. **拿不到 IP 的保底額度**(`689a849`):A 段拿不到 IP 時改用全站共用的一格 `noip`(每小時 60、每天 300,回 `RATE_LIMITED`);拿得到 IP 時照舊,不加這條。130200 檔頭寫明:正常情況一定拿得到 IP(Task 57 Step 8-2 會驗),這條只是 IP 取不到時的保險,被觸發代表 IP 取得壞了,要去查。測試:沒有 IP 標頭、同一個 Email 連送 61 次(缺貨),前 60 次照常檢查、第 61 次 `RATE_LIMITED`;noip 計數 60、Email / 電話沒有計數、全站沒加(不吃 B 段額度)。第 2 節「計數表裡沒有明文」的格式檢查允許 `noip|窗格`;「拿不到 IP 的請求不算 IP 額度」的說明改成「改算全站共用的 noip」。

**數字**

| 乾跑 | 上一節 | 現在 |
|---|---|---|
| `market_orders` | 65 | **65**(CHECK 那一項改寫,項數不變) |
| `market_notify` | 9 | 9 |
| `market_checkout` | 74 | **77**(小計 1,000,001 +1、noip +2) |
| `market_phase2_rollback` | 4 | 4 |

- **Task 57** Step 2(第 16560 行)的 Expected 改成依序 `共 65 項` / `共 9 項` / `共 77 項` / `共 4 項`,Step 5(第 16611 行)改成 `共 65 項` / `共 9 項` / `共 77 項`(上一節的 74 作廢);「F. 共用指令與基準數字」第 116 行同樣改成 65 / 9 / 77 / 4。

### 2026-10-11:Task 48–52 購物車、條款、結帳、查單頁與路由(commit `cc002b0`、`6062b36`、`d60cca6`、`76c6092`、`35b947a`;版面修正 `caa853e`、`1ba31b7`,分支 `market`)

每個 Task 先寫測試、看到失敗(`Failed to resolve import`)才實作;計畫之外加的測試,先對「照抄計畫的實作」跑一次確認是紅的,再改成現在的寫法。**以 repo 為準,不要再照抄 Task 48–51 的程式碼區塊**(Task 52 的兩組「找到 → 換成」照計畫,都剛好命中一次)。沒有乾跑、沒有查正式庫;畫面實測只連本機的假 Supabase。

**A. 照派工指示與勘誤調整的地方**

1. **查單不給 `contact_email`**(上面「第 2 階段三支 migration 審查修正」第 5 點):`LookupOrder.store` 只有 `supplier_id`、`name`、`phone`、`ship_days`、`return_policy`;測試資料與畫面都沒有 contact_email,聯絡店家只有電話(`tel:`)。測試釘住頁面上的 `a[href]` 只有 `tel:`(沒有 mailto、沒有外部 http)。
2. **進度時間軸**:`lookup.ts` 新增 `sortEvents` —— `created_at` 由舊到新、比到微秒(`Date` 只到毫秒;同一交易的兩筆資料庫保證至少差 1 微秒);時間完全一樣才看 `ORDER_STATUSES` 的順序;不靠 RPC 的 `ORDER BY created_at, id`(uuid)。跟 `4efbf5b`(guard 讓同一張單的時間嚴格遞增)不衝突:資料正常時第二排序用不到。
3. **已收款後被取消**(`2e843dd`):照常顯示「已取消」與原因、時間軸走到已取消,有測試。
4. **錯誤訊息一律經 `checkout.ts` 的 `checkoutErrorMessage`**:伺服器回的失敗、還沒開放的整頁說明(`MARKET_CLOSED`)、送出前擋的超過 10 家店(`TOO_MANY_STORES`)、非預期的例外(預設句當 `friendlyDbError` 的中文備援)。`ORDER_TOO_LARGE`(`6e0e208`、`c88296c`)結帳頁不用改;測試用真的 `checkoutErrorMessage` 算預期字串,checkout.ts 改字也不會紅。「沒有可以結帳的店家」是畫面狀態、不是伺服器錯誤,照計畫留在頁面。
5. **「前端修正」一節注意事項第 3 點**:查單頁找不到時 `MarketNotFound title="找不到訂單"`、分頁標題跟畫面一致;載入失敗改用 `MarketLoadError`(h1「訂單載入失敗」+「重新載入」)—— 計畫測試裡的「再試一次」改成「重新載入」。
6. **「前端修正第 2 輪」的離線 / 背景重抓規則**套到三個新頁面(見 B-1)。

**B. 自查修正(都先寫測試、看到失敗才改)**

1. **購物車頁、結帳頁還沒拿到商品資料時**:React Query v5 離線時第一次載入被暫停,`isLoading` 是 false —— 照抄計畫會用空陣列算購物車:購物車頁把每一件都列成「已下架」還給「從購物車移除」(一按就清光),結帳頁顯示「0 家店、NT$ 0」的表單。改成離線提示(購物車頁 `MarketOfflineNotice`、結帳頁整頁 `MarketOffline`)、載入失敗給重新載入(結帳頁整頁 `MarketLoadError`「商品資料載入失敗」)、背景重抓失敗保留舊資料加 `MarketStaleNotice`。
2. **購物車頁**:移除商品時查詢 key 跟著變,照抄計畫整頁閃成骨架 → `placeholderData: keepPreviousData`;這時上一份資料裡沒有的商品(別的分頁剛加的)不列成已下架。下單開關查詢失敗時計畫會寫「線上訂購還沒對外開放。」→ 改成「沒辦法確認線上訂購是否開放…」+「重新確認」;查詢中寫「正在確認…」。
3. **結帳頁**:已下架 / 查不到的商品不在任何一家店裡,照抄計畫會默默不結 → 列在「這次不能結帳」(「N 項商品已下架或暫停販售,這次不會結帳」)並給「回購物車修改」;選過的付款方式店家不收了(`PAYMENT_NOT_ACCEPTED` 後重抓)照抄計畫會照樣送出 → 退回店家接受的預設,畫面與送出內容一致;送出中再按不會重送。
4. **查單頁**:`navigator.clipboard?.writeText(...).then` 在沒有 clipboard(http、舊瀏覽器)時丟 TypeError、按了沒反應 → try/catch,顯示「沒辦法自動複製,請長按上面的網址手動複製」;店名與「訂單 #…」之間補空白(行內元素之間螢幕閱讀器不會補空白)。
5. **條款草稿**(`legal.ts`):第一條明講「交易媒合(仲介)平台」、「店家」就是在本市集刊登商品的供應商;第五條補「(俗稱七天鑑賞期)」;隱私權:限流雜湊實際留 2 至 3 天(排程每天刪 2 天前的窗格)、購物車會用商品編號向伺服器查價格(原文「不會傳到我們的伺服器」不精確)、管理人員為了營運與客訴都看得到(原文只寫處理客訴時);`updated` 改成 2026-10-11。新增一項測試釘住三個重點的用詞,並驗兩頁都有「草稿」提示(照抄計畫的 `legal.ts` 這項紅)。
6. **觸控目標**:條款頁「看隱私權政策 / 看服務條款」、結帳頁的條款連結與「回購物車修改」、查單頁的店家電話改 `min-h-11`。
7. **版面**(headless Chrome 實測才發現,`caa853e`、`1ba31b7`,各補一項測試):購物車每一列的小計與「移除」包成一組 `ml-auto`(390px 原本只有「移除」掉到下一行的左邊,360px 卻是兩個一起靠右);`OrderItems` 的金額欄一律 `whitespace-nowrap`(360px 長英文品名時,粗體的「NT$ 1,540」被拆成兩行),品名欄 `overflow-wrap:anywhere`。`OrderItems` 的 props 沒變(Task 53 / 55 共用)。
8. **測試寫法**:計畫的 `beforeEach(() => vi.mocked(x).mockReset())` 會回傳 mock 本身,vitest 把它當清理函式在測試結束後多呼叫一次(mock 設成 reject 時整個測試紅)→ 一律大括號;購物車與結帳測試的 `beforeEach` 另外 `mockReset()`,上一個測試沒用完的 `mockResolvedValueOnce` 不會留到下一個。

**C. 數字**

| 測試檔 | 計畫 | 現在 |
|---|---|---|
| `src/pages/market/MarketCartPage.test.tsx` | 7 | **12** |
| `src/pages/market/MarketLegalPage.test.tsx` | 2 | **3** |
| `src/pages/market/MarketCheckoutPage.test.tsx` | 8 | **13** |
| `src/lib/market/lookup.test.ts` | 3 | **6** |
| `src/pages/market/MarketOrderLookupPage.test.tsx` | 7 | **14** |
| `src/App.market-routes.test.tsx` | 3 | **4**(多驗結帳、訂單查詢也掛在市集版面裡) |

- 這五個 Task 共 50 項(計畫 28 項,**+22**),新增 5 個測試檔(跟計畫一樣)。「F. 共用指令與基準數字」第 2、3 階段的總數,在其他各節的調整之外再多 **22** 項。
- Step 2 的錯誤訊息:Task 49 實際是 `Failed to resolve import "./MarketLegalPage"`(計畫寫 `"@/lib/market/legal"`,先解析到哪個就報哪個,意思相同);其餘跟計畫一樣。
- `1ba31b7` 的乾淨副本(`git archive`)全套 vitest 連跑 2 次都是 **114 檔 / 1752 項**全過(含其他實作者同時 commit 的 Task 53–55 與 migration 修正);tsc 錯誤 **72**、eslint 錯誤 **10**(都不在這幾個檔,這幾個檔也沒有 warning);兩種 build 都 exit 0(前台站 bundle 有「食材市集服務條款」「這次不能結帳的店家」「訂單查詢網址」,管理員站沒有)。
- **畫面實測**(scratchpad 的 `p2-pages/verify/run.mjs`,不進 repo):乾淨副本起 vite dev(預先打包的快取放 scratchpad、拿掉 `/api` 轉發正式後端的 proxy),`VITE_SUPABASE_URL` 指向本機假的 Supabase(PostgREST / RPC 回測試資料,下單只記在記憶體);headless Chrome 用自己的 `--user-data-dir` / `--disk-cache-dir`(跑完刪掉)。8 個情境(購物車正常 / 有問題、結帳錯誤 / 部分店家不能結帳 / 送出後到查單頁、查單、條款、隱私權)× 390 / 360 / 1280 共 24 組全過:沒有橫向捲動(`scrollWidth` = 視窗寬)、沒有元素超出畫面、每個連結 / 按鈕 / 欄位捲到中間後 `elementFromPoint` 打到自己(沒被蓋住)、沒有文字溢出、送出失敗時焦點移到的欄位在黏住的頁首下面、時間軸照時間排(假資料刻意亂序)、查單頁沒有外部連結、送出後導到 `?new=1` 而且購物車清空;所有請求只到本機(dev server 與假 Supabase),console 沒有錯誤。截圖 70 張(每張一個視窗高)。

**D. 發現、沒有處理(記錄)**

- 頁尾的「服務條款 / 隱私權政策」(Task 46 的 `MarketLayout`)與購物車裡的店名 / 品名連結高 18–21px:相鄰目標的距離夠,WCAG 2.5.8 的間距例外成立,沒改。
- 購物車超過 10 家店時只有結帳頁送出前擋(「一次最多結帳 10 家店,請分次結帳。」),結帳頁不能選要結哪幾家,要回購物車移除(Task 43–47 一節 E 已記,照計畫沒在購物車頁擋)。
- 結帳頁沒有在送出前擋單店超過上限(由伺服器回 `ORDER_TOO_LARGE`,字走 checkout.ts);伺服器回的 `INVALID_INPUT` 欄位沒有標到欄位上,只在送出鈕上方的 alert 顯示(照計畫)。
- 查單頁「店家接單後會寄信通知你」在寄信閘門(`MARKET_NOTIFY_LIVE`)沒開時不成立(計畫風險第 2 點,照計畫寫)。
- 工作環境:2026-10-11 約 16:05 repo 的 `node_modules` 整個不見了(當時另一位審查者的乾淨副本用 symlink 指向它),用 `npm ci` 照 `package-lock.json` 補回(vitest 2.1.9、vite 5.4.19、react-query 5.83.0 跟之前一樣)。之後用「乾淨副本 + symlink 指向 repo 的 node_modules」時,清理一律先 `unlink` 那個 symlink、確認 repo 的 node_modules 還在,再刪資料夾。

### 2026-10-11:審查修正補充(二)—— IPv6 /48 只防灌爆、成單額度移到 B 段(commit `3ff02c2`,分支 `market`)

接上一節。複審結果:9 項修正都到位、沒有 Critical,新的 Important 是 A 段的 IPv6 /48 額度(每小時 20、每天 80)會誤擋正常買家。**以 repo 為準。**

1. 原因:手機、家用寬頻拿到的 /64、/56 都是從業者共用的 /48 位址池切出來的,一個 /48 背後可能是成千上萬個互不相干的用戶。複審實測:同一個 /48 裡有人用 4 個 /64 各送 5 次空購物車,鄰居第一次下單就 `RATE_LIMITED`;送滿 80 次會鎖到台北午夜;切飛航模式就能換一個 /64,幾乎沒有成本。
2. 修法(130200,`3ff02c2`):
   - A 段的 /48(`ip48`)只留每小時 200 次,只用來防灌爆,拿掉每天那條。
   - B 段新增 `ip48o`(只有 IPv6 才加):同一個 /48 每天 20 單,回 `RATE_LIMITED`;名稱跟 A 段的 `ip48` 不同,維持「A 計數 → 商品 → B 計數」不重疊。放寬 A 段之後一定要有這條,不然用假訂單吃光全站 500 單會變便宜。
   - 註解:檔頭的 /48 改成「很多用戶共用,所以嚴格的額度只算成單」;`market_checkout_status` 的「真正的關卡仍是 market_place_order 第 4 步」改成第 3 步(開關現在是第 3 步)。
3. 測試(修之前 4 項紅):複審 R6b(同一個 /48 裡 4 個 /64 各送 5 次空購物車之後,另一個 /64 的正常買家照樣能下單);同一個 /48 當天第 21 單 `RATE_LIMITED`、不建單、庫存不變、`ip48o` 計數 20(修之前第 21 次也會被舊的 A 段擋下,多驗 `ip48o` 的計數才分得出是哪一段擋的);同一個 /48 一小時內第 201 次嘗試 `RATE_LIMITED`;兩種 /48 bucket 都只存加鹽雜湊。這三項取代上一節 `d55b19c` 的「21 個 /64、第 21 次 RATE_LIMITED」;第 2 節「計數表裡沒有明文」的格式檢查加上 `ip48o`。
4. 審查員的攻擊測試:`atk_r2`(scratchpad `market-review/p2-db-r2/`)24 項,修之前(`689a849` 的 130200)只有 R6b 紅;修之後 R6b 綠,原版只剩 R13 紅 —— 它的格式正規式只認 `ip|ip48|email|phone|noip`,B 段新的 `ip48o` 不在裡面(設計改名,不是明文);只在 R13 的正規式加 `ip48o` 的副本(scratchpad `atk-adapted/atk_r2.test.sql`)24 / 24 全過。`atk_checkout` 副本的 B3 再依設計改成「200 次空購物車、305 次 `RATE_LIMITED`」,33 / 33 全過;`atk_rollback_fp` 2 / 2。

**數字**

| 乾跑 | 上一節 | 現在 |
|---|---|---|
| `market_orders` | 65 | 65 |
| `market_notify` | 9 | 9 |
| `market_checkout` | 77 | **79**(/48 那一項換成三項) |
| `market_phase2_rollback` | 4 | 4 |

- **Task 57** Step 2(第 16560 行)的 Expected 改成依序 `共 65 項` / `共 9 項` / `共 79 項` / `共 4 項`,Step 5(第 16611 行)改成 `共 65 項` / `共 9 項` / `共 79 項`(上一節的 77 作廢);「F. 共用指令與基準數字」第 116 行同樣改成 65 / 9 / 79 / 4。
- 每支乾跑之後殘留五個 0;唯讀查正式庫沒有任何第 2 階段的物件。vitest:`3ff02c2` 的乾淨副本全套 **114 檔 / 1752 項**全過(這次只改 SQL)。

### 2026-10-11:Task 53–55 供應商零售訂單、管理員零售訂單總覽(commit `75b506f`、`da55c0c`、`487ee1b`、`3ad315d`、`53b47ab`;審查修正 `3fab124`、`e7710db`,分支 `market`)

三個 Task 都先寫測試、看到失敗才實作,各自一個 commit;`orders.ts` 的修改都各自先 commit(派工規則:動 Task 43–47 的檔先確認沒有別人沒 commit 的修改、改完立刻測立刻 commit)。Task 54、55 對 `SupplierLayout(.test).tsx`、`AdminLayout(.test).tsx`、`AdminRoutes.test.tsx`、`App.tsx` 的 15 組「找到 → 換成」用程式從計畫逐字抽出,套到當時的 repo 都剛好命中一次(Task 52 的 `/market` 路由已先 commit,不影響)。**以 repo 為準。** 沒有乾跑、沒有查正式庫、沒有登入任何網站。

**A. 跟計畫不一樣的地方**

1. **Task 55 改成唯讀總覽(派工指示)**:計畫的「平台取消」整個拿掉 —— 這一頁沒有任何寫入動作,接單、出貨、取消都由店家在供應商後台處理。計畫第 15960 行「唯一的動作是平台取消」與 Task 55 的第 3 個測試「平台取消:要填原因;送出後重新載入清單」作廢,換成三項唯讀測試(B 節);上面「第 2 階段三支 migration 審查修正」第 1 點「Task 55 管理員的『平台取消』在已收款也會出現(`adminActions`)」不適用。`orders.ts` 的 `adminActions` 留著(沒有畫面用);資料庫轉移表仍允許管理員取消、`market-notify` 的「平台取消」信也還在 —— 之後要做平台取消請另開 Task。
2. **`OrderActionDialog` 只給供應商用**(計畫寫供應商與管理員共用)。取消已收款(`paid`)的單時加提醒「這筆訂單你已確認收款,取消後要由你自行退款給消費者(取消通知信會請消費者直接聯絡你)」,待匯款的單提醒「如果消費者已經匯款,請退款給他」(跟 `754ab43` 的消費者取消信一致);接單的說明依付款方式分開寫;拒單 / 取消說明庫存會加回去。
3. **已收款的轉帳單可以取消**(`2e843dd`):按鈕一律由 `supplierActions` 推出來(畫面沒有寫死),已收款的轉帳單同時有「出貨」與「取消訂單」。計畫 Task 53 的測試沒有已收款的單,另外新增測試(B 節)。
4. **物流的前端檢查跟 guard 一致**(`75b506f`,`validateOrderAction`):guard 的物流 / 單號已改用 `market_visible` + `market_trim`(上面「第 2 階段三支 migration 審查修正」第 7 點),前端原本 `trim()` 之後判斷空字串,去不掉 U+200B,只填零寬字元的物流會送出去再被 `carrier_required` 擋 → 改用 `hasVisibleText`。單號選填,只有看不見的字元時 guard 當成沒填,前端也不擋。
5. **管理員的查詢多帶店家電話與 `contact_email`**(`da55c0c`,派工說明 `contact_email` 可以在管理後台顯示):`ADMIN_ORDER_COLUMNS` 改成 `market_stores(suppliers(name, phone, contact_email))`,`MarketOrderRow.market_stores.suppliers` 多 `phone?`、`contact_email?`,「查看」加「店家聯絡」(處理客訴要聯絡店家)。供應商的查詢仍是 `ORDER_COLUMNS`,測試釘住不含 `contact_email` / `market_stores` / `suppliers`;消費者頁沒有動。
6. **時間軸依 `created_at` 排序、比到微秒**:`4efbf5b` 之後同一張單的紀錄嚴格遞增、可能只差 1 微秒,`Date` 只到毫秒,分不出接單與自動補的待匯款;改成把秒以下的位數另外比,不看 id、不看 PostgREST 內嵌回來的順序(計畫第 16312 行的 `localeCompare` 不用)。測試用相差 1 微秒、反著給的三筆紀錄釘住。
7. **供應商清單分兩次查**(`3fab124`,審查修正第 1 項):計畫的 `fetchSupplierOrders(supplierId)` 是所有狀態共用一次 `limit(200)`、前端再分頁籤 —— 已結束的單一多,舊的「已收款、還沒出貨」會從「待處理」消失、件數也偏少(收了款卻出不了貨)。改成 `fetchSupplierOrders(supplierId, group)`,在伺服器依狀態篩:`active`(新 export `ACTIVE_STATUSES` = `OPEN_STATUSES` + `shipped`)用 `fetchAllPages` 分頁讀完(`created_at`、`id` 新到舊,換頁不重複、不漏);`closed`(`CLOSED_STATUSES`)只抓最新 `ORDER_LIST_LIMIT`(200)張,到上限時分頁寫「已結束(200+)」、清單下面提示「只顯示最新的 200 張已結束的訂單。」。頁面兩個 query,key 是 `["market", "supplier-orders", supplierId, group]`(換供應商登入不看到上一家的快取),動作後兩組都重抓。
8. **頁面的強化**(每一項都有測試,或在截圖裡確認):
   - 供應商頁:讀不到供應商帳號、訂單讀取失敗 → 標題 + 原因 + 「重新載入」(計畫只有一行紅字 / 一句「請重新整理」);背景重抓失敗保留清單並提示;還沒讀到不顯示件數(不會寫成 0);外層加 `mx-auto max-w-4xl p-4 md:p-6`(`SupplierLayout` 的主內容區沒有 padding,計畫寫法在 390 寬整頁貼齊左邊;同 `SupplierOrdersPage`);動作鈕與分類鈕 44px(`min-h-11`);頁首照 `resolveEventMails` 寫會寄信的步驟:「你接單、拒單、出貨、取消時,消費者會收到 Email 通知(轉帳單接單後寄的是匯款資訊);確認已收款、標記完成不寄信。」(計畫寫「每一步都寄信」不正確,審查修正第 3 項)。
   - 視窗:檢查沒過時出錯的欄位 `aria-invalid` + `aria-describedby` + 紅框,焦點移到那一欄;送出中不能關(關掉再打開另一張單,這次回來的「關窗」會把另一張關掉);不是畫面過期的錯誤用 `friendlyDbError` 的中文備援、視窗留著可以再按;確定鈕是「確定」+ 動作,但「確認已收款」寫成「確定已收款」(不會變「確定確認已收款」);轉帳單接單成功提示「訂單 #… 已接單,等消費者匯款(狀態:待匯款)」(資料庫同一個交易就轉成待匯款,不寫「已改成已接單」)(審查修正第 4 項)。
   - 管理員頁:載入失敗 → 原因 + 「重新載入」(計畫只有 toast,畫面寫「沒有符合的訂單」);換篩選時慢回來的舊查詢(成功或失敗)丟掉;「查看」加物流與單號、店家聯絡;清單到 200 張上限時提示更早的單搜尋不到。
9. Task 53 Step 2 的失敗訊息:vitest 2.1.9 實際印 `Failed to resolve import "./SupplierMarketOrdersPage"`(計畫寫 `@/lib/market/orderFixtures`;都是實作還不存在)。
10. 新增測試檔 `src/pages/supplier/SupplierMarketRoutes.test.tsx`(`e7710db`,審查修正第 2(a) 項):用 `App.tsx` 本身渲染(`SupplierRoute`、`SupplierLayout`、分頁列是真的,頁面換 `testRouteStub` 空殼、Supabase 用 `testFakeSupabase`),路徑直接從 `market-notify/handler.ts` 的 `supplierOrdersUrl` 讀出來 —— 新訂單通知信「到後台查看」的連結打得開零售訂單頁、落在「零售市集 › 零售訂單」;店家設定頁也還在。

**B. 測試數字**

- Task 53 Step 4:`Tests  6 passed (6)` → 實作時 **12**,審查修正後 **`Tests  22 passed (22)`**:計畫 6 項;16 種「狀態 × 付款方式」的按鈕對照轉移表(另附一張看得懂的規格表,規格表本身也對照轉移表);已收款的出貨 / 取消與退款提醒;原因 / 物流的 5 種看不見輸入 × 拒單 / 取消 / 出貨;不是畫面過期的錯誤(網路、`one_event_per_order`);訂單讀取失敗;讀不到供應商帳號;呼叫帶 supplierId 與組別;超過上限時舊的已收款單仍在待處理、「200+」與提示;沒到上限不提示;換供應商登入重查;視窗每次從空白開始(用看得見的字測);送出中不能關;確定鈕文字;轉帳接單提示;頁首寄信步驟對照 `market-notify/render.ts` 的 `resolveEventMails`(讀原始碼,Deno 程式不直接 import)。
- Task 54 跟計畫一樣:Step 2 是 2 failed(`/supplier/market/orders`、`/supplier/market/store`,`Unable to find an accessible element with the role "tab"`),Step 4 `Tests  25 passed (25)`。
- Task 55 Step 2 跟計畫一樣(頁面 `Failed to resolve import "./AdminMarketOrdersPage"`、`AdminRoutes` 4 failed);Step 4 `Tests  66 passed (66)`(3 + 35 + 28)→ **`Tests  70 passed (70)`**(7 + 35 + 28),審查修正後頁面 **8** 項。頁面測試:計畫的前 2 項(第 2 項另驗物流、店家聯絡、明細)、唯讀三項(16 種組合打開「查看」都只有關閉鈕且從頭到尾沒有寫入 —— 假 client 的 `from` / `rpc` 一被呼叫就丟錯;原始碼不用 `addOrderEvent` / `OrderActionDialog` / `adminActions`、從 `orders.ts` 只 import 讀取用的東西)、時間軸比到微秒、載入失敗、慢回來的舊查詢、到上限的提示。
- `orders.test.ts` 11 → **14**(A-4、A-5、A-7;出貨 payload 改成完整比對 —— 原本 `toMatchObject` 多送 `tracking_no: ""` 也會綠,審查修正第 2(h) 項)。A-7 那項用照條件篩(`eq` / `in`、排序、`range`、`limit`、一次最多 1000 列)的假資料表:1101 張還沒結束的單(最舊的是已收款轉帳單)+ 300 張比它們都新的已結束單 + 別家的單 → `active` 全部讀到、`closed` 只有最新 200 張、每次查詢都限定自家。
- `SupplierMarketRoutes.test.tsx` **3** 項(A-10)。
- 突變驗證(乾淨副本裡改壞再跑):實作時 13 處、審查修正 15 處,共 **28 處全紅**,審查修正後重跑原本 13 處也全紅。審查修正的 15 處:`active` 只抓 200 張、`active` 不在伺服器篩狀態、`App.tsx` 拿掉路由、視窗不清空、送出中可以關、返回鈕沒停用、任何資料庫錯誤都關窗重抓、查詢沒帶 supplierId、queryKey 沒帶 supplierId、供應商 / 管理員到上限不提示、沒填單號也送 `tracking_no`、頁首改回「每一步都寄信」、確定鈕「確定確認已收款」、轉帳接單照寫「已接單」。
- 全套:`e7710db` 的乾淨副本(`git archive`)vitest 連跑 2 次都是 **115 檔 / 1767 項**全過(含其他實作者同時 commit 的檔;`53b47ab` 時是 114 檔 / 1750 項);tsc 錯誤 **72**、eslint 錯誤 **10**(改到的檔都是 0 error、0 warning),兩種 build 都 exit 0 —— 前台站 bundle 只有供應商零售訂單頁,管理員站只有零售訂單總覽。
- 畫面:不進 repo 的預覽頁(真的 `SupplierLayout` / `AdminLayout` + 這兩頁,Supabase 換成 repo 的 `createFakeSupabase` 假資料、照查詢的狀態與 limit 回資料,擋掉所有外部網路,不連任何資料庫)用 headless Chrome(自己的 user-data-dir,用完刪掉)在 390×844、1280×800 截圖:兩頁都沒有橫向捲動(`scrollWidth` = 視窗寬)、外部請求 0、寫入 0,console 只有 React Router 既有的 future flag 警告;另外放 250 張比較新的已結束單,待處理照樣是全部 4 張、分頁寫「已結束(200+)」、清單最下面有提示。

**C. 給後續 Task 的注意事項**

- Task 56 Step 1 的 Expected(111 檔 / 1428 項)以實測為準:`e7710db` 時是 115 檔 / 1767 項(含各節勘誤與其他實作者的檔)。
- Task 56 寫 `docs/DEPLOY.md` 時:管理後台的零售訂單是唯讀的;要取消某張單只能請店家在供應商後台做(或另開 Task 做平台取消)。
- 通知信「到後台查看」的連結(`market-notify` 的 `/supplier/market/orders`)現在有頁面了,而且有 `SupplierMarketRoutes.test.tsx` 釘住;改信裡的路徑或拿掉路由都會紅。
- 改 `market-notify` 的 `resolveEventMails`(哪些狀態寄信給消費者)時,`SupplierMarketOrdersPage.test.tsx` 的「頁首寫的寄信步驟」會紅,要回來改供應商頁的說明。

**D. 自查發現、沒有處理(記錄)**

- 已結束的單(供應商)與管理員清單一次最多 200 張、沒有分頁(計畫「風險」第 7 點);管理員搜尋只在已載入的那 200 張裡找(到上限時有提示);管理員「進行中」也是 200 張上限(放量後要改成伺服器分頁)。供應商的還沒結束的單一次全讀(很多時每張單帶明細,清單會變大)。
- 供應商頁沒有新訂單的即時提醒:靠新訂單信、或切回分頁時 React Query 自動重抓;分類與篩選沒有記在網址(重新整理回到預設分頁)。
- 唯讀只是畫面不提供:管理員帳號直接打 API 新增 `market_order_events` 仍然可以取消(轉移表與 RLS 允許);要完全禁止得改 migration。
- 「已結束(200+)」在剛好 200 張時也會帶「+」(只抓 200 張,分不出有沒有更多)。

### 2026-10-11:Task 48–52 補充(fresh-context 驗收後)(commit `15efc50`、`65a2865`、`16fde44`,分支 `market`)

接上面「Task 48–52 購物車、條款、結帳、查單頁與路由」一節。fresh-context 驗收(Code Reviewer,只給驗收條件與 diff 範圍)沒有 Critical / Important;8 條驗收 7 條過,結帳頁差一處字面缺口;它跑的 24 個突變殺掉 22 個,存活的 2 個是測試缺口(程式本身對)。下面每一項都先寫測試、看到失敗才改(只補測試的兩項用突變驗證)。**以 repo 為準。**

1. **結帳頁**(`15efc50`):
   - 備註欄 `autoComplete="off"`(驗收條件「每欄都有 autocomplete」;備註沒有對應的自動填入)。
   - 下單開關查詢失敗時表單照樣給填,但上方先講「沒辦法確認線上訂購是否開放,請檢查網路;送出訂單時會再確認一次。」+「重新確認」(跟購物車頁一致,不讓人填完才知道還沒開放)。
   - 送出回 `MARKET_CLOSED` 時重新確認開關,畫面換成還沒開放的說明(原本留著一張送不出去的表單)。
   - 補測試:成功後是 `replace` 進查詢頁(按上一頁回到結帳之前那頁);突變驗證:拿掉 `{ replace: true }` 正好這項紅(原本 13 項照樣全綠)。
2. **查單頁**(`65a2865`):「已送出」提示記在 state(只認剛下單的那個 token),接著用 replace 把網址的 `?new=1` 拿掉、不重抓 —— 消費者照提示加入書籤時常連 `?new=1` 一起存,原本之後每次打開都說「訂單已送出」;複製失敗的說明改成「沒辦法自動複製,請選取上面的網址手動複製(手機可以長按網址)。」(電腦沒有長按),並把焦點移到網址框、全選。
3. **路由測試**(`16fde44`):購物車、條款也驗市集版面(跳到主要內容),原本只驗隱私權政策(審查的突變:把購物車搬到版面外面照樣全綠)。項數不變。

**數字(取代上一節 C 的總數)**

- `MarketCheckoutPage.test.tsx` 13 → **17**、`MarketOrderLookupPage.test.tsx` 14 → **15**,其他不變(購物車 12、條款 3、lookup 6、路由 4):這五個 Task 共 **55** 項(計畫 28 項,**+27**;上一節寫的 +22 作廢)。
- `16fde44` 的乾淨副本(`git archive`)全套 vitest 連跑 2 次都是 **115 檔 / 1772 項**全過(含其他實作者同時 commit 的檔);tsc 錯誤 **72**(市集檔案 0)、eslint 錯誤 **10**(這幾個檔沒有 error 也沒有 warning);兩種 build 都 exit 0。
- 畫面實測多一個情境「開關查不到的結帳頁」(假 Supabase 對 `market_checkout_status` 回 500),並驗查單頁的 `?new=1` 會被拿掉:9 個情境 × 390 / 360 / 1280 共 **27** 組全過,檢查項目同上一節;所有請求只到本機、console 沒有錯誤。截圖 79 張。

**沒有處理(審查發現,範圍外)**

- 🔴 **送出時斷線可能建出重複訂單**:`market_place_order` 沒有冪等鍵(`checkout_id` 由伺服器 `gen_random_uuid()` 產生)。RPC 已經 commit、只是回應在路上掉了時,頁面顯示「連線失敗,請檢查網路後再試一次」,照做再按一次就是第二組訂單、庫存再扣一次、確認信寄兩封(寄信閘門沒開時消費者也收不到第一封確認信,無從判斷)。根治要改 RPC:前端帶一個 uuid(例如 `checkout_id`)、資料庫加 UNIQUE,重送時回第一次的結果。文案怎麼寫(「可能已送出,請勿重複送出」或「請重新送出」)兩邊都有風險,留給業主與資料庫修正者決定。
- IPv4 的 A 段限流「同一 IP 每小時 5 次」:台灣行動網路的 IPv4 多半是很多人共用一個 IP(CGNAT),流量大了正常買家可能第一次送出就被擋(`3ff02c2` 只放寬 IPv6 /48)。
- 時間軸「比到微秒」現在有兩份寫法:查單頁用 `lookup.ts` 的 `sortEvents`,Task 55 的管理員頁(`src/pages/admin/AdminMarketOrdersPage.tsx`)另寫一份;之後要改排序規則時兩處要一起改,可以考慮收成一支。

### 2026-10-11:審查修正補充(三)—— IPv4 共用位址(CGNAT)、下單冪等(token 改由瀏覽器產生)(commit `1f9a2e9`、`b0eb303`,分支 `market`)

接上一節。前端實作者回報、協調者同意的兩項,130200 套用前修。每一項都先寫測試、看到失敗才改。**以 repo 為準。**

1. **IPv4 共用位址(CGNAT)**(`1f9a2e9`,只改 130200):手機業者的 IPv4 常是一大群人共用一個,原本 A 段同一個 IP 每小時 5 / 每天 20 會誤擋同一個出口後面的正常買家。
   - A 段(只防灌爆,失敗的嘗試也算,回 `RATE_LIMITED`):`ip`(IPv4 完整位址、IPv6 /64)每小時 30,拿掉每天;`ip48` 每小時 200、`noip` 每小時 60 / 每天 300 照舊。
   - B 段(只算成單):`email` 每小時 3 / 每天 10、`phone` 每天 10、新增 `ipo`(只有 IPv4)同一個 IPv4 每天 20 單、`ip48o`(只有 IPv6)每天 20 單、`global` 每天 500。A 段(`ip` / `ip48` / `noip`)與 B 段(`email` / `phone` / `ipo` / `ip48o` / `global`)名稱不重疊。
   - 130200 檔頭寫明每一條的用意,以及量變大時另開一支 migration、用 `CREATE OR REPLACE FUNCTION public.market_place_order` 改數字。
   - 測試(修之前 3 項紅):第 2 節原本的「同一個 IP 一小時第 6 次 RATE_LIMITED」改成「同一個 IPv4 一小時內 6 個買家各下一單都照常」;同一個 IPv4 失敗嘗試 29 次後第 30 次照樣下單、第 31 次 `RATE_LIMITED`;同一個 IPv4 當天第 21 單 `RATE_LIMITED`、不建單、不動庫存、`ipo` 計數 20。
2. **下單冪等**(`b0eb303`;130000、130200、`checkout.ts`、`checkout.test.ts` 與三支乾跑測試同一個 commit):原本每次呼叫都新建 checkout 與 token,訂單已經存進去、回應卻在路上斷掉時,買家重按會多一張單、再扣一次庫存。
   - `p_checkout.token` 必填,`^[A-Za-z0-9_-]{43}$`(32 bytes 的 base64url,由瀏覽器產生,一次結帳一個,重送時沿用);缺少、格式不對、不是字串 → `{ok:false, code:'INVALID_INPUT', field:'token'}`。伺服器不再自己產生 token,照樣只存 sha256、放進下單確認通知、在回應裡回傳。
   - 欄位檢查之後、開關與限流之前:`pg_advisory_xact_lock(hashtextextended('ifoodmap:market_place_order:' || token 雜湊, 0))` 讓同一個 token 的並發請求排隊(交易結束才放),再查這個雜湊有沒有既有訂單:
     - 指紋相同 → 回第一次的 `{ok:true, token, checkout_id, orders}`,再加 `duplicate:true`;不扣任何限流額度、不動庫存、不再排通知;開關後來關了也照樣回。
     - 指紋不同 → `{ok:false, code:'TOKEN_REUSED'}`,什麼都不寫。
   - 請求指紋 = 正規化後內容的 sha256 hex:合併後的商品(依 product_id 排序、數量)、`payments` 物件、收件資料(去頭尾後的姓名、去掉空白 / 括號 / - 的電話、小寫 Email、縣市、地址、備註);不含 `expected_totals` 與 `terms_version`。存在 `market_orders.request_fingerprint`(`text NOT NULL`,hex 64 CHECK),同一次結帳的每張單都一樣。另加 `UNIQUE (lookup_token_hash, supplier_id)` 當儲存層的第二道(原本的 `market_orders_token_idx` 拿掉,改用這個 UNIQUE 的索引查 token)。
   - 因為指紋要用合併後的商品,購物車的格式檢查(最多 50 行 → `TOO_MANY_ITEMS`、每行 uuid 與 1–99 的整數 → `INVALID_INPUT` `items`)與合併移到冪等之前(開關與 A 段之前,不算進 A 段);空購物車(`EMPTY_CART`)照樣在 A 段之後。步驟變成:欄位 → 冪等 → 開關(第 4 步,`market_checkout_status` 的註解跟著改)→ A 段 → 購物車 → 店家 → B 段 → 建單;鎖的順序:token 的 advisory lock → A 段計數列 → 依 id 鎖商品 → B 段計數列。
   - 並發在乾跑(單一連線)測不到,程式與註解寫明靠 advisory lock 排隊。
   - `checkout.ts` 加 `TOKEN_REUSED`:「這筆結帳剛才已經送出過了,請查看訂單。」(`checkout.test.ts` 會從 130200 抓每一種錯誤碼對照。)`field: 'token'` 沒有專屬訊息(落到「有欄位格式不對」),token 是程式產生的,正常不會出現。
   - 測試(修之前 7 項紅):同 token、同內容重送(Email 大小寫不同、電話有 -、同一商品拆兩行、換 IP、`expected_totals` 與條款版本不同)→ `duplicate:true`,token、checkout_id、orders 跟第一次一樣,訂單數 / 庫存 / 限流計數總和 / 通知佇列都不變;同 token、地址不同 → `TOKEN_REUSED`、什麼都沒寫;token 缺少、42 字、有 `=`、是數字 → `INVALID_INPUT` `token`;開關關掉後同 token 重送照樣回既有結果。另在 130000 測:指紋不是 hex 64 存不進去、同一個 token 同一家店第二張單被 UNIQUE 擋(23505)。訂單測試的 `mk_order` 改成每張單各自的 token 雜湊、直接寫訂單的 fixture 都補上 `request_fingerprint`(130100 的測試同樣)。
   - 🔴 **給前端(結帳頁、`checkout.ts` 的 `buildCheckoutPayload`)**:在送出前產生 token(`crypto.getRandomValues` 32 bytes → base64url 去掉 `=`),同一次結帳的重送(逾時、斷線)沿用同一個 token,購物車或收件資料改了就換新 token;收到 `duplicate:true` 照成功處理。前端補上之前,所有結帳都會回 `INVALID_INPUT` `token`(130200 還沒套用,開關也還關著)。
3. **審查員的攻擊測試**:兩份副本的 `pg_temp.co()` 都加上隨機 token(必填);`atk_r2` 副本的 R3b 把「IP 每天」改成驗 B 段的 `ipo`(= 1)、R13 的格式正規式加上 `ipo`;`atk_checkout` 副本 33 / 33、`atk_r2` 副本 24 / 24、`atk_rollback_fp` 2 / 2。原版因為沒有 token,下單一律 `INVALID_INPUT`,`atk_r2` 原版跑到 R9c 會因為沒有訂單、直接寫紀錄時 order_id 是 NULL 而整支中止(預期中)。

**數字**

| 乾跑 | 上一節 | 現在 |
|---|---|---|
| `market_orders` | 65 | **67**(指紋 CHECK、同 token 同店 UNIQUE) |
| `market_notify` | 9 | 9 |
| `market_checkout` | 79 | **88**(CGNAT +2、冪等 +7;第 2 節「第 6 次 RATE_LIMITED」改寫) |
| `market_phase2_rollback` | 4 | 4 |

- **Task 57** Step 2(第 16560 行)的 Expected 改成依序 `共 67 項` / `共 9 項` / `共 88 項` / `共 4 項`,Step 5(第 16611 行)改成 `共 67 項` / `共 9 項` / `共 88 項`(上一節的 65 / 79 作廢);「F. 共用指令與基準數字」第 116 行同樣改成 67 / 9 / 88 / 4。
- 每支乾跑之後殘留五個 0;第 1 階段 `market_catalog` 112、`market_images_storage` 20;唯讀查正式庫沒有任何第 2 階段的物件。vitest:`b0eb303` 的乾淨副本全套連跑 2 次都是 **115 檔 / 1772 項**全過;tsc 錯誤 72、eslint 錯誤 10,兩種 build 都 exit 0。
- `b0eb303` 的過程中,我的腳本在 130200 寫進 `TOKEN_REUSED` 之後、`checkout.ts` 還沒改之前中止(fixture 的自我檢查擋下),「每一種代碼都有自己的一句話」在工作目錄紅了約一分鐘,已補上。

### 2026-10-11:結帳頁接上下單冪等的查詢 token(commit `384e4a5`、`264c769`,分支 `market`)

接上一節「審查修正補充(三)」第 2 點(`b0eb303`)。照協調者給的規格做,每一項都先寫測試、看到失敗才改。**以 repo 為準。**

1. **`checkout.ts`**(`384e4a5`):
   - `newCheckoutToken()`:`crypto.getRandomValues` 拿 32 bytes → base64url、不帶「=」→ 43 字。`CHECKOUT_TOKEN_PATTERN` 由測試解析 migration 130200 的 `(p_checkout->>'token') !~ '…'` 一字不差比對;另外驗 bytes 原樣轉碼(對照 Node 的 `Buffer.toString("base64url")`)、300 個都不重複。
   - `checkoutTokenStore`(`peek` / `getOrCreate` / `clear`):第一次送出才產生;存在 sessionStorage(key `ifoodmap-market-checkout-token-v1`;同一個分頁重新整理還在、不同分頁各自一個),讀寫都包 try/catch,不能用時退回記憶體(重新整理就沒了);sessionStorage 裡格式不對的值不用。
   - `buildCheckoutPayload` 多收必填的 `token`;`PlaceOrderResult` 的成功型別多 `duplicate`。
   - `checkoutExceptionMessage(e)`:只有資料庫帶錯誤代碼的回絕(交易已經回滾、確定沒建單)照 `friendlyDbError`;其他(supabase-js 斷線時是沒有代碼的 `MarketDbError`、閘道回 HTML、回應壞掉)一律顯示 `CHECKOUT_NO_RESPONSE_MESSAGE`:「連線中斷,訂單可能已經送出。請再按一次「送出訂單」,同一筆結帳不會重複下單。」
   - `TOKEN_REUSED` 的字從「這筆結帳剛才已經送出過了,請查看訂單。」改成「你剛才送出的訂單已經成立,請先查看訂單。如果還要另外下一張,再按一次「送出訂單」。」—— 協調者指定「你剛才送出的訂單已經成立」;換掉 token 之後再按就是另一張新訂單,所以講清楚。
2. **結帳頁**(`264c769`):前端檢查都過、真的送出才拿 token;斷線、逾時、缺貨、價格變了…之後的重送都沿用;成功與 `duplicate:true` 一樣清掉 token、拿掉結帳的商品、replace 進查詢頁;`TOKEN_REUSED` 顯示上面那句加舊 token 的「查看訂單」連結,換掉 token、購物車不動、不自動重送;送出時丟例外走 `checkoutExceptionMessage`,token 留著。token 與送出內容在 `setSubmitting(true)` 之前組好(萬一丟錯,按鈕不會卡在「送出中」)。
3. **跟上一節第 2 點最後一段不同**:那裡寫「購物車或收件資料改了就換新 token」,這次照協調者的規格不換 —— 只有成功(含 duplicate)與 `TOKEN_REUSED` 才換。理由:回應在路上斷掉、其實已經成單時,買家改了內容再送,沿用 token 會拿到 `TOKEN_REUSED`(畫面給「查看訂單」),換新 token 反而會建出第二張單;沒有成單過的 token,內容改了伺服器照常建單。
4. **數字**:
   - `checkout.test.ts` 19 → **27**(token 6 項、例外訊息 2 項;先紅 10 項,含 payload 與 `TOKEN_REUSED` 字串兩項改寫)。
   - `MarketCheckoutPage.test.tsx` 17 → **24**(token 7 項:斷線後重送同一個且前端沒過不產生、商業錯誤後重送同一個、成功清掉且下一次換新、duplicate 當成功、`TOKEN_REUSED` 的連結與換新、sessionStorage 不能用、重新整理後同一個;先紅 8 項,含「成功」那項的 payload 多 token)。突變:斷線時清掉 token → 3 項紅;`TOKEN_REUSED` 不清 → 1 項紅。
   - 「F. 共用指令與基準數字」第 2、3 階段的總數,在其他各節的調整之外再多 **15** 項。`264c769` 的乾淨副本全套 vitest 連跑 2 次都是 **115 檔 / 1787 項**全過;tsc **72**(市集檔案 0)、eslint **10**(這兩個檔沒有 error 也沒有 warning);兩種 build 都 exit 0(前台站 bundle 有 token 的 sessionStorage key 與斷線訊息,管理員站沒有)。
   - 畫面實測(同 Task 48–52 一節的腳本;假 Supabase 的下單改成原樣回傳瀏覽器送的 token,另有「回 TOKEN_REUSED」與「切斷連線」兩種模式):多 3 個情境 —— `TOKEN_REUSED`(連結的 href = 送出的 token、sessionStorage 已清、沒有自動重送)、連線中斷(token 留在 sessionStorage)、斷線 → 重新整理 → 再送(每一次 `market_place_order` 的 token 都一樣,成功後進 `/market/orders/<同一個 token>`)。12 個情境 × 390 / 360 / 1280 共 36 組全過;所有請求只到本機、console 沒有錯誤。
   - 實測發現:Chrome 在重複使用的連線被切斷、還沒收到任何回應時,會自己再送一次 POST(這個情境共 4 次呼叫、token 全部一樣)—— 瀏覽器自己的重送也是靠 token 才不會重複下單。
5. **沒有處理**:sessionStorage 不能用時 token 只在記憶體,重新整理之後會換新的(斷線、又重新整理再送,而第一次其實成功了的話,會建出第二張);`INVALID_INPUT` `field: 'token'` 沒有專屬訊息,也不會自動換 token(token 由同一個正規式產生與檢查,正常不會發生)。

### 2026-10-11:審查修正補充(四)—— 刻意的取捨寫進檔頭、依規則記錄擋下次數(commit `165a449`、`e4d7b39`、`7234d55`,分支 `market`)

接「審查修正補充(三)」。協調者對上一輪四點的決定:第 1、2 點接受現狀,在檔頭寫明是刻意的取捨;第 4 點 `UNIQUE (lookup_token_hash, supplier_id)` 留著;第 3 點照做。這次只動 SQL 與資料庫測試,沒有動 `src/`。每一項都先寫測試、看到失敗才改。**以 repo 為準。**

1. **刻意的取捨**(`165a449`,只改 130200 檔頭註解):同一個 token 的重送(`duplicate`、`TOKEN_REUSED`)在開關與限流之前就回傳、不吃任何額度(重送不能被擋,成本是一次 advisory lock 加一次索引查詢);格式錯的請求(`INVALID_INPUT`,含 `TOO_MANY_ITEMS` 與購物車每行的格式)也在限流之前回傳、不算進 A 段(不鎖任何商品或計數列),`EMPTY_CART` 照樣算進 A 段。
2. **依規則記錄擋下次數**(`e4d7b39`;130200、130200 還原檔、`market_checkout.test.sql`、`market_phase2_rollback.test.sql`):
   - 新表 `market_rate_blocks_daily`:`day date`(台北日)、`rule text`(1–100 字)、`hits integer`(≥ 0),`PRIMARY KEY (day, rule)`;RLS 開著、沒有 policy,`PUBLIC` / `anon` / `authenticated` 全收回(只有 service role 與 Dashboard 查得到)。只記次數、不記是誰。
   - `market_rate_take` 被擋時,在子交易(IFM02)之外,把這次擋下的規則種類(bucket 冒號前的前綴:`ip`、`ip48`、`noip`、`email`、`phone`、`ipo`、`ip48o`、`global`)各加 1:同一次被同一種的兩條擋下(例如 Email 每小時與每天)只算 1;依種類排序寫,鎖的順序固定。計數照樣整批退回(被擋的請求不吃額度);沒被擋時什麼都不寫。這一列的鎖是被擋的交易最後才拿的(寫完就回傳),不會跟商品、計數的鎖造成死結。
   - bucket 冒號前的種類不能是空的:`":x"` 改回 `22023`(原本要等到被擋時才因 CHECK 報 `23514`)。
   - 清理:沿用 `ifoodmap-market-rate-cleanup`(每天 19:50 UTC),同一個指令加一句 `DELETE FROM public.market_rate_blocks_daily WHERE day < (now() AT TIME ZONE 'Asia/Taipei')::date - 90`(留今天與前 90 天)。
   - 檔頭附查詢範例(唯讀端點或 Dashboard 的 SQL Editor):`SELECT day, rule, hits FROM public.market_rate_blocks_daily WHERE day >= (now() AT TIME ZONE 'Asia/Taipei')::date - 7 ORDER BY day DESC, hits DESC;`。`ipo` / `ip48o` 擋得多 = 共用網路的成單上限該調高;`noip` 有任何一筆 = 拿 IP 壞了。
   - 還原檔加 `DROP TABLE IF EXISTS public.market_rate_blocks_daily`。清理排程是 130200 自己建的,還原檔原本就整個 `cron.unschedule`,沒有更早的指令要改回 ——「cron 指令改回原本的」= 排程整個拿掉(`market_phase2_rollback`「排程與設定拆掉」那項驗)。
   - 測試(`market_checkout` +5 項):沒被擋時不寫擋下紀錄(額度照常扣);被擋時那種加 1(同一次同一種兩條算 1、擋兩次 = 2)、沒擋的那種不記、計數照樣整批不扣;前面各節真的下單流程被擋的都依種類記到(`email=2,ip=1,ip48=1,ip48o=1,ipo=1,noip=1,test=4`);anon、登入者讀不到也沒有任何權限、RLS 開著;清理排程的指令在交易裡實際跑一次(3 天前的計數、91 天前的紀錄刪掉,1 天前的計數、剛好 90 天前的紀錄留著)。「規則格式不對直接報錯」那項多驗 `":x"`(改之前 `23514` 紅)。`market_phase2_rollback`「表都不在」的清單加上新表(用拿掉 DROP 那一行的還原檔副本跑過,該項紅)。
3. **套用、開放之後再跑也不受線上資料影響**(`7234d55`,只改 `market_checkout.test.sql`,項數不變):130200 的測試檔頭寫明開放之後還會再跑這支。塞入每一種 bucket 的假線上資料(今天已有擋下紀錄、超過 2 天還沒清的計數、95 天前的紀錄)跑 `e4d7b39` 的版本紅 3 項:我這次的兩項(比今天的絕對值、數整張表)與原本的「開關關閉被擋的嘗試不寫任何計數」(數整張表裡 `test:` 以外的列)。改成:擋下紀錄比本檔造成的增量(檔頭先記今天既有的紀錄);清理排程只數「該留著」的範圍;開關那項只看這兩次嘗試會用到的 bucket(`198.51.100.1` 的 `ip` / `ipo`、兩個 `.invalid` Email 的 `email`;開關若跑到限流之後,A 段一定先寫這個 IP 的 `ip` 列)。同一份假資料 93 / 93;正向對照(先塞一筆這個 IP 的 `ip` 列)只紅該項。

**數字**

| 乾跑 | 上一節(三) | 現在 |
|---|---|---|
| `market_orders` | 67 | 67 |
| `market_notify` | 9 | 9 |
| `market_checkout` | 88 | **93**(擋下紀錄 +5) |
| `market_phase2_rollback` | 4 | 4(清單多一張表) |

- **Task 57** Step 2(第 16560 行)的 Expected 改成依序 `共 67 項` / `共 9 項` / `共 93 項` / `共 4 項`,Step 5(第 16611 行)改成 `共 67 項` / `共 9 項` / `共 93 項`(上一節的 88 作廢);「F. 共用指令與基準數字」第 116 行同樣改成 67 / 9 / 93 / 4。
- `7234d55` 照順序乾跑 orders → notify → checkout → rollback,每支之後殘留五個 0;攻擊測試副本 `atk_checkout` 33 / 33、`atk_r2` 24 / 24、`atk_rollback_fp` 2 / 2(線上指紋另用唯讀查過,跟期待值逐欄相同),第 1 階段 `market_catalog` 112、`market_images_storage` 20(這幾支在 `264c769` 跑,migration 與現在相同);唯讀查正式庫沒有任何第 2 階段的物件(含新表)。vitest:`264c769`(已含 `e4d7b39`)的乾淨副本跑一次 **115 檔 / 1787 項**全過。

**沒有處理**

- 被擋的請求都會更新同一列(今天, 種類),要等前一個交易 commit 才寫得進去:同一種規則大量擋下(灌爆)時,這一列會變成排隊點,每個被擋的請求多佔一次 commit(含 WAL flush)的時間。目前的量不是問題;要調的話,被擋時加 `set_config('synchronous_commit', 'off', true)` 就能把排隊時間縮到微秒(被擋的交易不建單,當機時掉幾筆計數無妨),交給協調者決定。
- 乾跑是一整個交易:開放之後跑的那幾秒內若剛好有真的請求被擋或下單,比增量的那幾項(含原本的「限流計數總和不變」)仍可能差 1,重跑即可。其他測試檔(`market_orders` 等)沒有用假線上資料檢查過。
- DEPLOY.md 由協調者另外派人寫;查詢範例在 130200 檔頭。

### 2026-10-11:Task 40–42 第 3 輪審查補測試(commit `877b268`、`4f4ad96`、`60052de`、`a5cf3a8`、`d215327`、`95548b3`,分支 `market`)

接上面「Task 40–42 審查修正」一節。第 3 輪審查結論是程式行為正確、可以部署,但有 3 個 Important 的測試缺口加 2 個小地方,另列幾個小缺口;全部做完。改程式的(第 4 點)先寫測試看到紅才改;補測試的(第 1–3、5 點)用它要抓的突變證明會紅。只動 `supabase/functions/market-notify/` 與本勘誤。**以 repo 為準。**

1. **已收款取消信的跳脫**(`877b268`):跳脫測試原本都是「還沒收款」、已收款的測試電話又沒有特殊字元,把 `p(esc(refund))` 改成 `p(refund)` 72 項照樣全綠。補:已收款取消、店名與店家電話都帶 HTML,斷言退款那一句(含電話)是跳脫後的樣子。
2. **退款句的 handler 層測試**(`4f4ad96`):fixture 的訂單加 `paid_at: null`(正式庫回來的是 null,不是沒有這個欄位);補貨到付款(店家 / 平台)取消、轉帳單在 pending / confirmed / awaiting_payment 取消(都不能有退款句)、paid → cancelled(要有)。突變:`order.paid_at !== undefined`、`"paid_at" in order`、轉帳一律算已收款、待匯款算已收款,現在都紅。
3. **假資料庫照 select 回傳欄位**(`60052de`):
   - `handler.test.ts` 包一層 `SelectingQuery`:跟 PostgREST 一樣只回傳選到的欄位,資料列沒有的是 null;別名、巢狀查詢直接丟錯(提醒先改包裝)。**沒有改共用的 `supabase/tests/fake-supabase.ts`**(notify-lead、approve-supplier 的測試也在用)。
   - `handler.ts` 把 suppliers / market_stores / market_store_transfer 讀的欄位抽成 `SUPPLIER_COLUMNS`、`STORE_COLUMNS`、`TRANSFER_COLUMNS`。「讀取的欄位都存在於 migration」補這三張表(`20260528233000_core_supply_schema.sql`、`20261009120000_market_catalog.sql`;之後的 migration 沒有改名或刪欄位),另外檢查寫進 notifications 的欄位(`20260704140000`)。
   - 突變:少讀 total、line_total、paid_at、phone、contact_email、transfer_info、buyer_email、ship_days,與欄位名打錯(total、phone、ship_days、transfer_info),現在全部紅;接單信的出貨天數(N 天 / 當天 / 沒設定)補測試 —— 少讀 ship_days 原本也全綠。
4. **小地方**:
   - 主旨拿掉 Unicode 格式字元(`a5cf3a8`):`oneLine` 先把 `\p{Cf}`(RLO U+202E、零寬空白、BOM、軟連字號…)拿掉,再把控制字元與 U+2028 / U+2029 換成空白;店名帶 RLO 時主旨不再顯示成反過來的字。
   - Email 遮罩(`d215327`):`maskEmail`(改成 export,有單元測試)原本保留 @ 之後最多 100 字;店家的 contact_email 沒有格式限制,填成地址、電話會整段留在 log 與 notifications。改成帳號只留第一個字、網域只留前 3 個字加「…」(`王***@exa…`)。
5. **其他小缺口**(`95548b3`),全部補上:N-L4(notifications 寫入失敗的 log 沒有 Email)、V10(閘門關時 Email 不合格也不轉寄測試信箱、照樣留「沒寄」紀錄)、V12(跳過的回應不帶出買家 Email)、C4(B 店也有 contact_email,待匯款信一併檢查)、G11 / G12(閘門關的測試走過已收款取消、沒填匯款資訊的待匯款)、T13(checkout_id 格式錯的 400 回應與 log 沒有 token)。沒有處理的:無。
- 另外確認:結帳改成瀏覽器產生查詢 token 之後,130200 仍用 `^[A-Za-z0-9_-]{43}$` 驗、用同一個 sha256 hex 存,通知內容仍是 `{kind:'placed', checkout_id, token}`,market-notify 不用改。

**數字**

- market-notify vitest:**4 檔 / 85 項**(gate 8、send 3、render 25、handler 49;上一節 72 項)→ Task 42 Step 4 的 Expected 改成 **`Tests  85 passed (85)`**;「F. 共用指令與基準數字」第 2、3 階段的總數比計畫多 **55 項、1 檔**(取代上一節的 42 項)。
- 全套:`95548b3` 的乾淨副本(`git archive`)連跑兩次 **115 檔 / 1800 項**全過(含其他實作者同時 commit 的檔);tsc strict 兩份設定 0 error,eslint 沒有輸出。
- 突變:審查員的 `scratchpad/review-notify-r3/mutate3.mjs` 複製到 `review-notify-r3-rerun/`(pristine 換成 `95548b3`,審查員原本的資料夾沒動)。這一輪改寫的 5 處 find 字串(V7、F4、F5、F6、X12)照新寫法改寫,另加 3 處(O10 不拿掉 `\p{Cf}`、V14 網域留 100 字、F8 少讀 ship_days),共 199 處:**182 殺、17 存活**,存活的 17 處全是審查員標成等價或良性的(E-ESC-apos、E-HREF、M-H6、A5、A8、A9、A10、O2、O5、O7、K17、R9、T9、T11、T12、T15、X15)。原本存活、該被殺的 18 處(E-P3、N-L4、V10、V12、R5、R6、R10、R10b、C4、G11、G12、T13、F1、F2、F4、F5、F6、F7)**18 處全殺**;等價清單裡的 K10、F3 也被殺(測試釘住 key 的格式、只靠 paid_at 也算已收款)。

### 2026-10-11:更正「審查修正補充(三)」第 2 點的 token 換新時機(實作以 commit `384e4a5`、`264c769` 為準)

「審查修正補充(三)」(commit `b0eb303`,第 17766 行那一節)第 2 點最後一段「🔴 給前端」寫「購物車或收件資料改了就換新 token」—— 跟最後的實作不同,這一句**作廢**
(舊條目不改,以這裡為準):

- 同一次結帳一直沿用同一個 token:斷線、逾時、缺貨、價格變了,或買家改了購物車、收件資料之後再送,都用同一個(`src/lib/market/checkout.ts` 的 `checkoutTokenStore`,存在 sessionStorage)。
- 這個 token 已經成單、內容又改過再送 → 伺服器回 `TOKEN_REUSED`(什麼都不寫),結帳頁說「你剛才送出的訂單已經成立…」並給舊 token 的「查看訂單」連結;
  還沒成單過的 token,內容改了伺服器照常建單。
- 只有成功(含 `duplicate:true`)或 `TOKEN_REUSED` 之後才換新 token。
- 理由:回應在路上斷掉、其實已經成單時,換新 token 再送會建出第二張單;沿用 token 會拿到 `TOKEN_REUSED`,買家看得到「查看訂單」。
  上面「結帳頁接上下單冪等的查詢 token」一節(第 17801 行)第 3 點已經記了這個差異;`docs/DEPLOY.md`「第 2 階段」照這裡寫。

### 2026-10-11:Task 56 第 2 階段全套檢查與 `docs/DEPLOY.md` 第 2 階段(分支 `market`)

**Step 1–2 實測**(HEAD `abe2f2c`;工作目錄只有這個 Task 的文件修改。Task 56 沒有改任何程式、沒有乾跑、沒有碰正式庫):

| | Task 56 原文 | 實測 |
|---|---|---|
| vitest | 111 檔 / 1428 項 | **115 檔 / 1800 項**全過(`7ef6944` 時先跑一次是 115 / 1787,差的 13 項是之後 commit 的 market-notify 測試) |
| tsc 錯誤 | 72 | **72** |
| eslint 錯誤 | 10 | **10** |
| 兩種 build | exit 0 | 都 **exit 0** |

- 指令照「F. 共用指令」,只把 log 與 build 輸出放到 scratchpad(避免跟其他實作者的 `/tmp/market-*` 互蓋)。前台站 bundle 有「同一筆結帳不會重複下單」、
  管理員站有「更早的訂單不會出現在清單與搜尋結果裡」,反過來都沒有(DEPLOY.md 的 bundle 探針用這兩句;部署前實測兩站都還是舊版)。
- 資料庫測試項數照上面「審查修正補充(四)」:`market_orders` 67、`market_notify` 9、`market_checkout` 93、`market_phase2_rollback` 4(四支檔案裡 `pg_temp.expect(` 的數目也是 67 / 9 / 93 / 4)。

**Step 3–4**:DEPLOY.md 不照抄第 16459–16519 行的區塊,改寫成現在的行為 —— `docs/DEPLOY.md` 第 1079 行起「第 2 階段」(說明、檢查順序表、限流表、通知信表)、
第 1215 行「部署(第 2 階段)」、第 1386 行「怎麼查(第 2 階段)」、第 1413 行「還原(第 2 階段)」、第 1494 行「對外開放前待辦(第 3 階段,需要業主核准)」11 條;
第 1 階段那一節 `market_images_storage` 的 19 改成 20(四處)。Step 4 的 grep 四行都在、行號遞增。

**Task 57 以 DEPLOY.md「部署(第 2 階段)」「還原(第 2 階段)」為準**,跟 Task 57 原文不一樣的地方:

1. Step 2 / 5:不帶 `$C`;Expected 67 / 9 / 93 / 4。Step 5 多一支「線上 schema + 三支還原檔」的 `market_phase2_rollback` 乾跑(推前端之前確認還原檔在線上跑得動)。
2. Step 4 的查詢多三項:`api_can_touch_rate_tables`(兩張限流表 anon / authenticated 沒有任何權限)、`notify_key_set`(`app_config.notify_service_key` 有值 ——
   沒值的話 `market_enqueue_notify` 安靜跳過,一封信都不會寄)、`cron_cleans_blocks`(清理排程也刪擋下紀錄);另跑 `check-migrations`(repo 46 個、線上 46 個)。
3. Step 7 改成第 1 階段的合併流程(`merge --no-ff market`、記下合併 commit、`market` 快轉到 main)。
4. Step 8:bundle 探針;anon 多驗 `market_place_order` 回 `MARKET_CLOSED`(合法 token + 空購物車,不建單、不寫計數)與 `market_rate_blocks_daily` 401;頁面多 `/market/orders/abc`。
5. 🔴 **Step 8-2 的 IP 標頭檢查照原文做不了**:`d55b19c` 把開關移到限流之前(現在開關是第 4 步、A 段是第 5 步),開關關著時不寫任何計數;
   原文的請求也沒有 token(`b0eb303` 之後必填),會先回 `INVALID_INPUT` `token`。DEPLOY.md 把它移到「對外開放前待辦」第 6 條:業主核准、開關打開之後馬上用
   **合法 token + 空購物車**送(回 `EMPTY_CART`;空購物車在 A 段之後才擋,只寫 A 段的 `ip` 計數、不建單、不吃 B 段),而且送請求與查自己的 IP 都用 `curl -4`
   (原文只有查 IP 那一行有 `-4`,打 Supabase 的那一個若走 IPv6,`real` 會是 false,誤判成拿不到 IP);查詢多看 `noip|1h`。Step 9 的 IP 那一項跟著改。
6. DEPLOY.md 裡新的 SQL(Step 4 的查詢、怎麼查三段、匯出、還原後確認、IP 檢查)與 anon 的三個 RPC 回應,在本機一次性的 Postgres 實跑過:Homebrew Postgres 18、
   只開 Unix socket、資料放 scratchpad,用完停掉刪除;只 stub auth / roles / cron / pg_net / storage / app_config / suppliers 等,載入 120000 / 130000 / 130100 / 130200
   原文與三支還原檔。Expected 照實際輸出寫(擋下紀錄「同一次兩條同種只算 1、沒擋不寫」、開關關著回 `MARKET_CLOSED` 且計數與擋下紀錄都沒變、原文 8-2 的請求回
   `INVALID_INPUT` `token`、打開後空購物車回 `EMPTY_CART` 且計數只記在被採用的那個 IP、還原後 0 / 0 / 0 / 0 / 0 / 3)。DEPLOY.md 第 2 階段的 14 段 bash 都過
   `bash -n` 與 `zsh -n`,用 printf 寫 SQL 的四段在 bash、zsh 各實跑一次。這不是正式庫,部署時以線上結果為準。

**發現、沒有處理(記錄;都沒有改程式)**:

- migration 130000 檔頭的狀態說明(第 10 行「pending / confirmed / awaiting_payment → cancelled」)沒有 `paid → cancelled`;轉移表(第 201、213、225 行)有。
  只是註解,DEPLOY.md 照轉移表寫。
- 「C. 關鍵技術決定」第 1 點(第 45 行)與「待業主決定」第 7 點(第 17075 行)的限流額度還是舊數字(每 IP 每小時 5 / 每天 20 等);現行數字以 130200 與 DEPLOY.md 的限流表為準。
- 閘門關著時,結帳頁(`MarketCheckoutPage.tsx` 第 324 行的轉帳說明)、查單頁(`MarketOrderLookupPage.tsx` 第 86 行)、供應商零售訂單頁(`SupplierMarketOrdersPage.tsx`
  第 85 行)與接單視窗(`OrderActionDialog.tsx` 第 35–36 行)都說消費者會收到信。開關關著時只有業主的測試單,影響不大;DEPLOY.md 待辦第 3 條要求兩個閘門一起開。

### 2026-10-12:market-notify 的 72 小時自動取消文案(commit `c7fab76`、`5a6f0d3`,分支 `market`)

業主決定做「72 小時自動取消」,第 3 階段做完直接對外開放、打開寄信閘門,所以信件文案在開放前改好。資料庫端是 migration `20261012100000_market_hardening.sql`(commit `fc25de1`:`market_expire_orders` 每 10 分鐘跑,待接單看下單時間、待匯款看最後一筆進入待匯款的紀錄;取消紀錄 actor = system、payload `{"auto_expire": "pending" | "awaiting_payment"}`)。只動 `supabase/functions/market-notify/`。**以 repo 為準。**

1. **時數只有一個常數**:`render.ts` 的 `MARKET_AUTO_CANCEL_HOURS = 72`,信裡提到時限一律用它。`render.test.ts` 掃全部 migration 的 `-- @market-auto-cancel-hours`:要剛好一處、在 `20261012100000_market_hardening.sql`、數字相同(標記 commit 前用 skipIf 跳過,`fc25de1` 之後改成一直開;把 migration 改成 48 這項會紅)。
2. **新增的句子**(html 與 text 都有):
   - 店家的新訂單信:「請在 72 小時內接單,超過時間系統會自動取消這張訂單。」
   - 消費者的下單確認信:「店家會在 72 小時內確認訂單;超過時間沒有接單,訂單會自動取消。」
   - 消費者的待匯款信:「請在 2026/10/15 11:00(台北時間)前完成匯款,逾期訂單會自動取消。」—— 期限 = 這筆待匯款紀錄的 `created_at` + 72 小時(handler 多讀 `market_order_events.created_at`);讀不到時間改寫「請在 72 小時內完成匯款,逾期訂單會自動取消。」
   - 期限寫法照 `_shared/supplier-mail.ts` 的 `taipeiTime`(`YYYY/MM/DD HH:mm(台北時間)`),但用 `formatToParts` 逐欄組、固定 `hourCycle: "h23"`、日期與時間之間一律一般空白:不靠執行環境時區(Edge Function 跑在 UTC)、午夜寫 00:00。新版 ICU(Node 25)的 `taipeiTime` 在日期與時間之間放 U+2009 細空白,Deno 的 ICU 可能不同,所以不直接用它。測試涵蓋跨日(UTC 15 日 = 台北 16 日)、跨月、跨年加午夜、`+08:00` 寫法、PostgREST 的微秒格式、TZ = UTC / America/Los_Angeles。
3. **自動取消的信**(紀錄 `to_status = cancelled` 而且 `payload.auto_expire` 是 pending / awaiting_payment 才算;沒有標記或值不認得照一般取消):
   - 消費者:主旨「訂單已自動取消(店家逾時未接單)— 零售訂單 #…」/「訂單已自動取消(逾時未完成匯款)— 零售訂單 #…」;內文「您的訂單 零售訂單 #…(「店名」):店家超過 72 小時沒有接單,訂單已自動取消。」加「這張訂單不會成立,您不需要付款。」/「…:因為超過 72 小時沒有完成匯款,訂單已自動取消。」加「這張訂單不會成立,不需要再匯款;如果您已經匯款,請直接聯絡店家。」,再附店家電話。不寫成店家取消,也沒有任何「退款」的字(就算資料說已收款,結構上也不放)。
   - 店家:主旨「零售訂單 #… 已逾時自動取消 — 請不要出貨」;內文「訂單 零售訂單 #…(消費者 …):這張訂單超過 72 小時沒有接單(或:消費者超過 72 小時沒有完成匯款),系統因逾時自動取消。請不要出貨。」加「訂單裡的商品庫存已經自動補回(只限有設定庫存的商品)。」
   - 資料庫寫進 note 的原因(半形逗號)信裡不另外顯示,信裡的句子已經說明原因。
   - 待匯款被取消的單:`paid_at` 是 null、from_status 是 awaiting_payment,現有的已收款判斷不會成立(handler 層測試確認),自動取消的信本身也不放退款句。
4. **閘門照舊**:「每一種值」的閘門測試多走兩種自動取消(消費者與店家各兩封,共 14 封),`MARKET_NOTIFY_LIVE` 不是 `"true"` 時一樣只寄 ifoodmaptw@gmail.com、主旨加「[測試轉寄]」。
5. **突變驗證**(全部紅):handler 不看 auto_expire、任何值都當自動取消、自動取消信繞過閘門、消費者寫成「店家取消」、自動取消信放退款句、店家信沒寫庫存補回、時數改 48、期限用 UTC 顯示、期限用 h24、待匯款信沒有期限句、新訂單信 text 沒有 72 小時句、不讀 `created_at`。

**數字**

- market-notify vitest:**4 檔 / 107 項**(gate 8、send 3、render 46、handler 50;上一節是 85 項)→ Task 42 Step 4 的 Expected 改成 **`Tests  107 passed (107)`**;「F. 共用指令與基準數字」第 2、3 階段的總數比計畫多 **77 項、1 檔**(取代上一節的 55 項)。
- 全套:`c4f8da7` 的乾淨副本(`git archive`)連跑兩次 **116 檔 / 1843 項**全過;tsc strict 兩份設定 0 error,eslint 沒有輸出。
- 🔴 部署:這兩個 commit 要重新部署 market-notify 才生效。函式可以比 `20261012100000` 先部署(還沒有 auto_expire 時照一般文案,待匯款信本來就讀得到 `created_at`);migration 先套的話,函式重新部署之前的自動取消會寄成一般的「平台已取消」信。

### 2026-10-12:前端的 72 小時自動取消(commit `cf8645c`、`3e26e88`、`dcff0d6`、`c6e76ef`、`4e1f79b`、`c4f8da7`,分支 `market`)

接 migration `20261012100000_market_hardening.sql`(`fc25de1`)與 market-notify(`c7fab76`、`5a6f0d3`)。照協調者的規格做,每一項都先寫測試、看到失敗才改。**以 repo 為準。** `legal.ts` 沒動(等法規查證的報告出來,再一起定稿 `LEGAL_DRAFT` / `TERMS_VERSION`)。

1. **`src/lib/market/autoCancel.ts`**(`cf8645c`、`3e26e88`):
   - `MARKET_AUTO_CANCEL_HOURS = 72`。測試解析 migration 的 `-- @market-auto-cancel-hours 72`(全檔剛好一處)與它下一行的 `c_hours CONSTANT integer := 72;` 比對。migration 進來之前用 `skipIf`;`fc25de1` 之後改成一定要跑,檔案改名或刪掉會紅。突變驗證:改成 48 → 對照那項紅。
   - `autoCancelDeadline(order, events)`:待接單 = 訂單的 `created_at` + 72h;待匯款 = 最後一筆 `to_status = 'awaiting_payment'` 紀錄 + 72h(跟 `market_expire_orders` 的 `max(e.created_at)` 一樣;用 `lookup.ts` 的 `sortEvents` 比到微秒,回傳的期限也保留微秒);其他狀態、待匯款卻查不到紀錄、時間看不懂 → null。
   - `formatAutoCancelDeadline`:台北時間「M/D HH:mm」(月、日不補零);`hoursUntilAutoCancel`:剩幾個完整小時(無條件捨去,不到 1 小時 → 0)。
2. **查單頁**(`dcff0d6`):待接單「店家 72 小時內沒有接單,訂單會自動取消(期限 M/D HH:mm)」;待匯款在匯款資訊框裡「請在 M/D HH:mm 前完成匯款,逾期訂單會自動取消」(沒有匯款資訊時單獨寫在單上);其他狀態不寫,系統取消的原因照樣在「原因:」顯示。
3. **供應商零售訂單頁**(`c6e76ef`、`4e1f79b`):
   - 查詢:還沒結束的單多帶 `market_order_events(to_status, created_at)`(`SUPPLIER_ACTIVE_ORDER_COLUMNS`;不帶 actor_role、note;已結束的照 `ORDER_COLUMNS`)。`orders.test.ts`「供應商的查詢就是 ORDER_COLUMNS」那項跟著改寫。
   - 待接單的卡片「N 小時內沒接單會自動取消」(無條件捨去:店家在 N 小時內接單一定來得及),不到 1 小時(含已經過了、排程還沒跑到)「即將自動取消」;待匯款「消費者需在 M/D HH:mm 前匯款,逾期自動取消」。
   - 頁首加「待接單超過 72 小時沒有接單、轉帳單進入待匯款超過 72 小時沒有收到款項,系統會自動取消訂單。」;頁面開著時每分鐘更新一次倒數。
4. **結帳頁**(`c4f8da7`):送出鈕正上方「送出後,店家會在 72 小時內確認訂單;超過時間沒有接單,訂單會自動取消。」
5. **用字**:協調者給的句子用全形逗號與括號,照 repo 慣例改成半形(跟資料庫寫的取消原因一樣)。
6. **數字**:
   - 新增 `autoCancel.test.ts` 10 項;`MarketOrderLookupPage.test.tsx` 15 → 19、`orders.test.ts` 14 → 15、`SupplierMarketOrdersPage.test.tsx` 22 → 27、`MarketCheckoutPage.test.tsx` 24 → 25:共 +1 檔 / +21 項(先紅:autoCancel 的 import 失敗;查單 3 項、orders 2 項、供應商 5 項、結帳 1 項)。
   - `c4f8da7` 的乾淨副本全套 vitest 連跑 2 次都是 **116 檔 / 1843 項**全過(含其他實作者同時 commit 的檔);tsc **72**(市集檔案 0)、eslint **10**(這幾個檔沒有 error 也沒有 warning);兩種 build 都 exit 0(前台站 bundle 有倒數與匯款期限的字,管理員站沒有)。
   - 畫面實測(同前幾節的腳本):多 3 個情境 —— 查單頁待接單、查單頁待匯款(期限在匯款資訊框裡)、供應商零售訂單(假的登入 session 放在 supabase-js 的 localStorage key,假 Supabase 回 `supplier_accounts` 與訂單,時間都相對於「現在」:還剩 23.5 小時、0.4 小時、待匯款)。15 個情境 × 390 / 360 / 1280 共 45 組全過;所有請求只到本機、console 沒有錯誤。
7. **沒有處理(記錄)**:
   - 供應商後台(`SupplierLayout`)的手機抽屜關著時移到畫面左邊外面,但裡面的連結還在 Tab 順序裡、螢幕閱讀器也讀得到(沒有 `inert` / `aria-hidden`),鍵盤使用者會 Tab 到看不見的連結;畫面實測時把它排除在檢查外。不是這次的範圍。
   - 倒數用瀏覽器的時鐘:使用者電腦的時間不準時,畫面上的時數會跟著偏(真正取消以資料庫為準,排程每 10 分鐘一次)。
   - 管理員的零售訂單總覽沒有加期限(這次沒有要求)。

### 2026-10-12:Task 58 開放前檢查查詢與 `docs/DEPLOY.md` 第 3 階段(分支 `market`)

**業主的決定(2026-10-12,派工者轉達)**:核准對外開放 —— 第 3 階段做完就打開下單、打開寄信閘門、合併形象站入口,條款用查證後的版本直接定稿;
開放的操作由派工者另外指定的人執行。業主接受三項風險:條款沒有經過律師審閱、業主還沒完整實測過、Supabase 仍是免費方案(升級 Pro 改成業主要盡快自己處理的事)。
同一天決定做 72 小時自動取消,跟 IP 退路、被擋的請求非同步 commit 一起放進 `20261012100000_market_hardening.sql`(另一位實作者在寫;migration 是 `fc25de1`,
測試與還原檔是 `9aa90d2`:乾跑只帶加固 31 / 67 / 9 / 93、還原 4 —— DEPLOY.md「部署(第 3 階段)」的項數照它)。

**跟計畫 Task 58 不一樣的地方**

1. **在 `market` 分支做**(計畫寫在 main):照派工指示,commit 停在 `market`、不 push,由派工者跟資料庫加固一起推。
2. **Step 1 的查詢照原文在正式庫跑不起來**:唯讀端點的角色沒有 `market_store_is_open()` 的執行權(120000 只開給 anon / authenticated / service_role),
   2026-10-12 實測回 `42501: permission denied for function market_store_is_open`。改成直接寫它的條件(`market_stores.is_enabled AND suppliers.is_active`,跟函式內容一樣)。
3. **Step 2 的 Expected 有兩個跟現況不一樣**:`image_policies` 是 **2**(第 1 階段勘誤:只剩 select / insert,不是 4);`stores_transfer_without_info`「一定是 0」不成立 ——
   `ef1df39` 之後 guard 只在供應商建店或改付款方式時檢查,供應商可以事後刪掉轉帳資訊,所以改當營運數字(那幾家的轉帳結帳會回 `PAYMENT_NOT_ACCEPTED`)。
4. **`stores_open_without_contact_email` 改成 `stores_open_bad_contact_email`**:空的**或格式不對**都算,規則跟 `market-notify` 寄信前的 `isDeliverableEmail` 一樣
   (`_shared/supplier-mail.ts` 的 `EMAIL_PATTERN`、≤ 254 字、不去頭尾空白)—— 只看空字串的話,填錯格式的店家一樣收不到新訂單信卻查不出來。
5. **多的項目**:`cron_cleans_blocks`、`rate_cleanup_last_run_ok`、`image_bucket_versioning`、`anon_can_read_transfer`、`api_can_touch_rate_tables`、
   `tmp_ip_probe_absent`(第 2 階段部署時暫時建的 `market_tmp_ip_probe` 要刪掉)、`orders_by_status`、`orders_pending_over_72h`、`orders_awaiting_payment_over_72h`
   (從最後一筆「待匯款」紀錄起算,跟 `market_expire_orders` 同一條規則)、`orders_paid_unshipped_over_3_days`、`rate_blocks_7_days`(今天與前 6 個台北日依規則加總)、
   `noip_blocked_24h`(擋下紀錄以台北日記,看 24 小時前那一天到今天)、`noip_attempts_24h`(`noip|1h` 計數);加固之後才會有的 `expire_orders_cron`、
   `expire_orders_last_run_ok`、`client_ip_ignores_xff`(函式定義裡不再有 `->>'x-forwarded-for'`;註解裡提到不算)、`blocked_async_commit`
   (`market_rate_take` 或 `market_place_order` 的定義裡有 `synchronous_commit`)。`migrations` 的清單先放進 `20261012100000`(套用前是五個版本)。
   `orders_pending_over_1_day`、`products_pending_over_2_days`、`notify_failed_7_days` 照計畫。
6. 「只回數字與 true / false」:另外回不涉密的設定值(版本清單、排程字串、bucket 設定),跟計畫原本的查詢一樣;密鑰、鹽只檢查有沒有、格式對不對,不印值。

**Step 2 實測**(2026-10-12 00:26:46 台北,唯讀端點;加固還沒套用):

| 項目 | 值 |
|---|---|
| `migrations` | `20261009120000`、`120100`、`130000`、`130100`、`130200`(五個) |
| `checkout_open` | `false` |
| `notify_url_ok`、`notify_key_set`、`rate_salt_set` | `true`、`true`、`true` |
| `rate_cleanup_cron`、`cron_cleans_blocks`、`rate_cleanup_last_run_ok` | `"50 19 * * *"`、`true`、`null`(130200 套用後還沒到第一次 19:50 UTC) |
| `image_bucket`、`image_bucket_versioning`、`image_policies` | `{"public": true, "file_size_limit": 2097152, "mime_types": ["image/jpeg", "image/png", "image/webp"]}`、`"DISABLED"`、`2` |
| `anon_can_read_orders`、`anon_can_read_transfer`、`anon_can_place_order`、`api_can_touch_rate_tables` | `false`、`false`、`true`、`false` |
| `tmp_ip_probe_absent` | `true` |
| `expire_orders_cron`、`expire_orders_last_run_ok`、`client_ip_ignores_xff`、`blocked_async_commit` | `null`、`null`、`false`、`false`(套用 20261012100000 之後才會是 `"*/10 * * * *"`、`true`、`true`、`true`) |
| 營運數字(店家、商品、訂單、寄信失敗、擋下紀錄、noip) | 全部 `0`、`orders_by_status` 與 `rate_blocks_7_days` 是 `{}`、`noip_blocked_24h` 是 `false` |

- 「加固之後」那一欄是 2026-10-12 在本機一次性的 Postgres(Homebrew 18、只開 Unix socket、資料放 scratchpad,用完刪掉;stub auth / roles / cron / pg_net / storage / app_config 等)
  載入 120000–130200 原文與 `fc25de1` 的 20261012100000 草稿實測的(套用前同一份查詢是 `null` / `false`)。同一個環境也實測了:兩張超過 72 小時的單(待接單、待匯款)
  被 `market_expire_orders()` 取消、原因與 `{"auto_expire": …}` 照 migration、庫存補回、兩筆通知排進 pg_net、再跑一次取消 0 張;供應商帶 `auto_expire` 取消被擋(22023 `auto_expire_invalid`)。
  營運數字的每一項另外塞假資料驗過會數到(例如聯絡信箱前面多一個空白算格式不對、7 天前的擋下紀錄不算、30 小時前的 noip 計數不算)。
- 業主實測的佐證查詢(Task 60 Step 4)也改寫成不用 heredoc 的版本,在正式庫唯讀跑過一次:四項都是空的。

**Step 3:DEPLOY.md 不照抄第 16752–16769 行的區塊**,寫成現況:「第 3 階段」說明(業主核准與接受的三項風險、形象站入口、加固三件事、第 2 階段待辦 11 條的狀態對照表)、
「部署(第 3 階段)」(加固的部署,照第 2 階段的格式;順序 `market-notify` → migration → 前端,照上一節的理由)、「還原(第 3 階段)」、「開放前檢查(第 3 階段)」
(每一項的意義、現在的值、加固之後 / 開放時的值、遇到時怎麼辦)、「業主實測(第 3 階段)」(業主照著勾的清單)、「開放當天的順序(第 3 階段)」(8 步,每步有指令或位置)、
「緊急關閉(第 3 階段)」。第 2 階段那幾節同時改:狀態流程加 72 小時自動取消、IP 來源加加固之後的順序、「怎麼查」加自動取消與排程的兩段查詢、待辦第 1–3 條寫上
2026-10-12 的決定、第 5、11 條與第 6 條的 XFF 退路標成已處理(IPv6 /64 仍待辦)。Step 4 的 grep 只有一行(`### 第 3 階段:對外開放(…)`)。

**給 Task 60 的修改**:

- Step 2(push main)不做:Task 58 的檔由派工者跟加固一起推。Step 3 的判斷改用 DEPLOY.md「開放前檢查」的表。Step 4 改用 DEPLOY.md「業主實測」的清單與佐證查詢(業主已接受沒做完的風險,仍建議開放前做)。
- Step 5 的五項業主已經核准,開放的指令寫在 DEPLOY.md「開放當天的順序」。🔴 Step 6 的驗收項「DEPLOY.md 沒有任何打開 `MARKET_NOTIFY_LIVE` 或 `market_checkout_open` 的指令」作廢:
  現在只有「開放當天的順序」第 4、5 步與「緊急關閉」有這些指令,而且寫明由派工者指定的人執行;驗收改成「只有這兩節有,其他地方沒有」。

**發現、沒有處理(記錄;都沒有改程式)**:

- `market_checkout.test.sql` 的 XFF 那一項原本驗「再沒有才用 x-forwarded-for 第一段」(期待 `1.1.1.1`),加固之後會紅;`9aa90d2` 已改成期待 NULL(第 86–88 行),
  所以這支在加固套用前要帶 `--with-migration` 20261012100000 跑,不帶的話那一項紅屬預期(DEPLOY.md 寫了)。
- 第 2 階段待辦第 6 條原本的空購物車請求同時帶了偽造的 `CF-Connecting-IP`:第 2 階段部署時實測,用戶端自己帶這個標頭會被 Cloudflare 整個請求回 403 `error code: 1000`,
  照原樣做會看不到結果。DEPLOY.md 改成只帶 `X-Forwarded-For`、`X-Real-IP`,候選清單拿掉 `cf-connecting-ip`。
- 加固之後 `noip` 的意義變了:原本拿不到 cf / x-real-ip 時會退回 XFF,現在直接算 `noip`(全站共用每小時 60、每天 300)。正式請求都經過 Cloudflare,正常不會發生;
  開放後「開放前檢查」的 `noip_attempts_24h` 不是 0 就要查。

### 2026-10-12:第 3 階段資料庫加固 20261012100000_market_hardening(commit `fc25de1`、`9aa90d2`,分支 `market`)

130000 / 130100 / 130200 已經套用,不改原檔;新的一支用 CREATE OR REPLACE 換掉三支函式、新增逾時自動取消。每一項都先寫測試、看到失敗才算數。未套用、未 push。**以 repo 為準。**

1. **IP 退路不再信任 X-Forwarded-For**(`market_client_ip`,簽章不變):cf-connecting-ip → x-real-ip → NULL(NULL 照舊算進全站共用的 `noip`)。不帶新 migration 跑測試時,只帶 XFF 的下單被算在偽造的那個 IP 的 `ip` 與 `ipo` 兩格(`true|0|0|2`)—— 這就是補起來的洞。`market_checkout.test.sql` 第 86–88 行「再沒有才用 x-forwarded-for 第一段」改成期待 NULL(項數不變),檔頭改成只帶 hardening(沒帶時那一項會紅,屬預期)。
2. **被擋的請求改成非同步 commit**(`market_rate_take` 第 144 行):擋下的那條路先 `set_config('synchronous_commit', 'off', true)` 再寫擋下紀錄;沒被擋的路(建單)不動。測試:成功下單後維持原值、被擋(直接呼叫、經下單 RPC 層層 SECURITY DEFINER)之後是 off(SET LOCAL 會跨出有 SET 子句的函式,一路留到交易結束)。檔頭寫明取捨與「以後別的呼叫端被擋後還要寫重要資料,要自己改回 on」。
3. **72 小時自動取消**(`market_expire_orders`,第 283 行起;pg_cron `ifoodmap-market-expire-orders` `*/10 * * * *`):
   - 標記在第 290 行、唯一的常數在第 291 行(全檔只有一處;`autoCancel.test.ts` 已經讀得到、通過);取消原因用 `format()` 從同一個常數組。原因的逗號照 repo 既有字串用半形「,」(規格打的是全形)。
   - 候選:pending 看 `created_at`、awaiting_payment 看最後一筆 `to_status = 'awaiting_payment'` 紀錄的時間,早於 `now() - 72h`;依 `created_at, id`、每次 200 張。每張單在自己的子交易裡 `FOR UPDATE SKIP LOCKED` → 上鎖後重讀狀態與時間 → 寫取消紀錄;失敗 `RAISE WARNING` 跳過。身分交給 guard(pg_cron 沒有 JWT → system),補庫存與通知照既有的 trigger。
   - **guard**:payload 的 CHECK 只管「物件、1000 bytes」不會擋,但 `market_guard_event` 原本把出貨以外的 payload 一律清成 `{}`,auto_expire 會被默默拿掉,所以 guard 一起換(第 250 行起):auto_expire 只能用在 **system** 的 `cancelled`、值只能是 pending / awaiting_payment **而且要等於取消前的狀態**,否則 22023 `auto_expire_invalid`;帶了也只留這個鍵。「只有 system」與「等於取消前的狀態」是我加的(規格只要求 cancelled 與兩個值):供應商、管理員帶不得,冒充不了「系統自動取消」的通知信。
   - 沒有加部分索引:既有的 `market_orders_status_idx (status, created_at DESC)` 已經涵蓋。
4. **測試** `market_hardening.test.sql` 31 項:IP 7 項(含只帶 XFF 的下單算 noip)、非同步 commit 3 項、自動取消 21 項(權限、排程、73 / 71 小時、下單 100 小時前但 1 小時前才進待匯款、進待匯款 73 小時、已接單 / 已收款 / 已出貨不論多舊、庫存補回、通知佇列多一筆、一張失敗不影響整批、冪等、一次 200 張且先取最舊的、auto_expire 的 guard 規則 4 項)。
   - 「73 小時前進入待匯款」寫不出來:guard 一律把紀錄時間改成伺服器時間,這個帳號也不能設 `session_replication_role`(實測 42501)。所以只在乾跑交易裡把 guard 換成照送來的值寫的版本、建完 fixture 再用換掉前的 `pg_get_functiondef` 換回來,並比對逐字相同。換函式不鎖表(不用 `ALTER TABLE … DISABLE TRIGGER`)。
   - 線上本來就該取消的單會先在交易裡清掉,張數才剛好。下單開關、通知網址只在交易裡改(跟既有測試一樣),殘留五個 0。
   - 突變 6 處殺 5:批次上限、每張單的子交易、只有 system、值等於取消前的狀態、只在被擋的路改非同步。沒殺的是「上鎖後重讀」改錯:單一連線做不出候選查詢與上鎖之間的競態,只能靠讀程式;guard 的 stale 檢查是第二道。
5. **還原檔**:先停排程、再刪 `market_expire_orders`;三支函式照抄 130000 / 130200(生成時逐字比對原檔)。`market_hardening_rollback.test.sql` 4 項:三支函式的 md5(pg_get_functiondef)、權限、其他排程的指紋都跟線上套用前相同,而且 XFF 照舊會退回。不帶還原檔時紅 3 項。

**數字**(乾跑只帶 20261012100000,已套用的 120000–130200 都不帶;每支之後殘留五個 0):`market_hardening` **31**、`market_orders` 67、`market_notify` 9、`market_checkout` 93、`market_hardening_rollback` **4**(帶 migration 加還原檔)。vitest:`6f24f18` 的乾淨副本 **116 檔 / 1843 項**全過(含 `autoCancel.test.ts` 的標記比對)。

**沒有處理 / 給 DEPLOY.md 的人**:

- 取消失敗只有 `RAISE WARNING`,`cron.job_run_details` 不記 WARNING(只記成功的指令或錯誤),實際上看不到。真正的監控是「過期但還沒被取消」的單:`SELECT count(*) FROM public.market_orders WHERE status = 'pending' AND created_at < now() - interval '72 hours 20 minutes'`(待匯款同理),正常應該是 0。
- 整批是同一個交易:最多 200 張單和它們商品的鎖會留到整批跑完(通常 0–5 張,很快)。理論上會跟同時在拒單 / 取消、而且共用商品的供應商死結,由資料庫偵測;排程這邊被選中時只有那一張進 WARNING,下一輪再試。
- 如果有 200 張以上「永遠取消不了」的壞資料,排在後面的單會一直輪不到(目前只有沒有任何紀錄的訂單會這樣,正常建單不會發生)。

### 2026-10-12:hardening 補上 Cloudflare Pseudo IPv4 的回退(commit `e9121e3`,分支 `market`)

接上一節。20261012100000 還沒套用,直接改原檔;先寫測試、看到失敗才改。**以 repo 為準。**

1. **`market_client_ip`**:cf-connecting-ip 落在 240.0.0.0/4(Class E,真的用戶端不可能是這個位址,只有 Cloudflare 的 Pseudo IPv4 會產生),而且 cf-connecting-ipv6 是合法的 IPv6 位址(family 6、不是網段)時,改用 cf-connecting-ipv6,照 /64 正規化(下單 RPC 的 /48 規則 ip48 / ip48o 才接得上)。兩個條件同時成立,代表兩個標頭都是 Cloudflare 設的:用戶端自帶 CF-Connecting-IP 會被擋(部署時實測 403 / 1000)。其他情況照舊 cf-connecting-ip → x-real-ip → NULL;一般位址帶了 cf-connecting-ipv6 一律不理;只有 cf-connecting-ipv6 也不理;任一個解析不了就當作不成立。註解與檔頭寫明:不一定會發生(要看 Supabase 的 Cloudflare 有沒有開 Pseudo IPv4),IPv6 實測仍是開放前待辦。
2. **測試** +5 項(31 → 36):
   - 240.1.2.3 與 255.255.255.254 + 2001:db8:1:2::5 → `2001:db8:1:2::`。
   - 240.x 沒有 ipv6,或 ipv6 是亂填、IPv4、網段 → 240.1.2.3。
   - 203.0.113.5 與 239.255.255.255(240/4 外面緊鄰)+ 偽造的 ipv6 → 用 cf-connecting-ip。
   - 只有 ipv6 標頭 → 照 x-real-ip。
   - Pseudo IPv4 的下單算在真正 IPv6 的 ip / ip48 / ip48o,240.x 沒有任何列。
   - 先紅 2 項(回 240.1.2.3;下單算在 240.x 的 ip / ipo)。突變 4 處全殺:拿掉 240/4 條件、拿掉 IPv6 合法檢查、範圍寫成 240/8、寫成 224/3。
3. 還原檔不用改:它換回的是 130200 的 `market_client_ip`(還原測試的 md5 照樣跟線上相同)。標記 `@market-auto-cancel-hours` 沒動,行號從 290 移到 310(常數在 311),全檔仍只有一處。

**數字**(`e9121e3`;乾跑只帶 20261012100000,每支之後殘留五個 0):`market_hardening` **36**、`market_orders` 67、`market_notify` 9、`market_checkout` 93、`market_hardening_rollback` 4。vitest:`e9121e3` 的乾淨副本 116 檔 / 1843 項全過(這次只改 SQL)。🔴 DEPLOY.md 第 3 階段的乾跑項數(`207235a` 寫的 31)要改成 36,由寫文件的人改。

### 2026-10-12:market-notify 寄信遇到限速、伺服器錯誤會重試(commit `7c21f0b`,分支 `market`)

開放前必修:Resend 預設每秒只收 2 個請求,一次結帳 3 家店會同時觸發 1 封下單確認加 3 封新訂單信,其中幾封會被回 429;原本遇到 429 不重送、直接記 failed,閘門打開之後就是真實的消費者和店家收不到信。只動 `supabase/functions/market-notify/`。**以 repo 為準。**

1. **send.ts 的寄信包裝加重試**(做在傳給 `_shared` 的 `createResendSender` 的 fetch 裡,所以信件內容、錯誤字串都照舊):
   - 429、5xx、連線失敗(fetch 丟出例外)最多重試 3 次(共 4 次請求);其他 4xx(422、409…)不重試。
   - 回應有 `retry-after`(秒數可以有小數,或 HTTP 日期)就照它等,最多 10 秒;沒有就依序等 1、2、4 秒,再加 0–249 毫秒的隨機抖動,讓同時被擋的幾封信錯開。
   - 一封信全部等待加起來不超過 20 秒:額度用完就不再重試,最後一次只等剩下的額度。
   - 每次重試都用同一個 `Idempotency-Key`,Resend 自己去重,不會寄出兩封。
   - 每次重試前回報給 handler,handler 記一筆 `info` log:`{ fn, step: "send-retry", audience, status, attempt }`(只有狀態碼與第幾次;連線失敗的狀態碼是 null;下單確認走 redactLog)。最後還是失敗就照原本的方式:notifications 記 `failed`、log 記 `step: "send"` 與錯誤。
   - 等待可以注入:`createMarketResendSender(apiKey, fetch, { sleep, random, now })`;`index.ts` 不用改(預設 setTimeout、Math.random、Date.now)。
2. **測試**(假的 fetch,等待用注入的 sleep 或假的 timer,不真的等):429 兩次後成功(只寄一封、三次同一個 key、等 1 秒與 2 秒)、一直 429(4 次後失敗、總等待 ≤ 20 秒)、422 / 409 等 4xx 不重試、5xx 重試、連線失敗重試、retry-after 照秒數等且超過 10 秒只等 10 秒、額度用完不再重試、retry-after 的 HTTP 日期寫法、沒注入時用 setTimeout;handler 用真的寄信包裝走完整條(重試 log、最後記 failed)。突變:不重試、422 也重試、不重試 5xx、例外不重試、重試 5 次、retry-after 不設上限、沒有總等待上限、不看 retry-after、每次重試換新 key、沒有抖動、不回報重試,全部紅。
3. **「風險與待業主決定」第 8 點**(第 17063 行)改成:**寄信遇到限速或伺服器錯誤會重試 3 次**:Resend 回 429 / 5xx 或連線失敗時,用同一個 Idempotency-Key 最多重試 3 次(retry-after 最多 10 秒,沒有就 1 / 2 / 4 秒加抖動,一封信總等待不超過 20 秒),其他 4xx 不重試;重試後還是失敗才在 `notifications` 記 `failed`,要看後台「通知紀錄」手動處理。資料庫到函式那一段(pg_net)失敗仍然不會重送。
4. 🔴 **還沒驗證**:pg_net 呼叫 market-notify 的逾時是 8 秒(`20261009130100` 的 `timeout_milliseconds := 8000`),重試加起來可能超過 8 秒。這時 pg_net 那邊會記逾時(`net._http_response`),函式本身應該會繼續跑完重試、寫進 notifications(用戶端斷線不會中斷 Edge Function 正在跑的處理)—— 本機驗不了,部署後要實測一次(例如一次結帳 3 家店,看 notifications 有沒有 4 筆 sent)。實測若會被中斷,要另開 migration 把 pg_net 的逾時拉長(例如 30 秒),或把總等待上限壓在 8 秒內。

**數字**

- market-notify vitest:**4 檔 / 117 項**(gate 8、send 11、render 46、handler 52;上一節 107 項)→ Task 42 Step 4 的 Expected 改成 **`Tests  117 passed (117)`**;「F. 共用指令與基準數字」第 2、3 階段的總數比計畫多 **87 項、1 檔**。
- 全套:`7c21f0b` 的乾淨副本(`git archive`)連跑兩次 **116 檔 / 1853 項**全過;tsc strict 兩份設定 0 error,eslint 沒有輸出。

### 2026-10-12:hardening 第四輪審查 Minor(commit `802e1a8`,分支 `market`)

第四輪審查沒有 Critical、Important,可以套用並開放;下面幾項 Minor 趁 20261012100000 還沒套用直接改原檔。先寫測試、看到失敗才改。**以 repo 為準。**

1. **防飢餓(審查 E4)**:候選加上「至少有一筆狀態紀錄」(沒有紀錄的單 guard 一定擋,排在前面只會一直失敗);每次最多看 50 張候選(`c_scan`)、逐張嘗試,成功取消 5 張(`c_per_run`)就停。兩個常數放在 72 旁邊並註明理由。
2. **`SET lock_timeout = '5s'`**(函式的 SET 子句,proconfig = `search_path="",lock_timeout=5s`):補庫存遇到被長時間鎖住的商品列時,那一張照 EXCEPTION 跳過、下一輪再處理。
3. **每次只取消 5 張**:Resend 預設每秒 2 個請求,一次取消 200 張會同時排出約 400 封信。每 10 分鐘 5 張 = 一小時 30 張。
4. **清 pg_cron 執行紀錄**:用 `cron.alter_job` 換 `ifoodmap-market-rate-cleanup` 的指令(時間 `50 19 * * *` 不變),130200 的兩句照舊,多刪 jobname 開頭 `ifoodmap-market-` 的工作、`COALESCE(end_time, start_time)` 超過 14 天的 `cron.job_run_details`,別的工作不碰。排程不存在時 migration 直接報錯。還原檔把指令換回 130200 的原樣(逐字),還原測試的排程指紋跟線上相同。正式庫的 postgres 對 `cron.job_run_details` 有 INSERT / DELETE、`cron.alter_job` 可以執行(唯讀查過,pg_cron 1.6.4)。
5. **檔頭「營運注意」**:
   - `market_hardening.test.sql` 會在乾跑交易裡對線上資料執行取消、暫時換掉 guard,開放後只能在離峰時段跑。
   - 轉帳單「快到期限才匯款、店家過了期限才按已收款」的競態刻意接受,只能人工退款,會告知業主。
   - 這段沒有寫 72 這個數字:72 全檔仍只在標記(第 324 行)與常數(第 325 行)。
6. **測試** 36 → **41**:
   - 「一次 200 張」的兩項換成「每次 5 張」(7 張 → 5、2、0,先取最舊的)。
   - 新增:飢餓(60 張沒有紀錄的舊單在前面,後面那張照樣取消);每次看 50 張(49 張取消不了的單在前面,第 50 張取消、第 51 張下一輪,同時證明一張失敗不讓整批失敗);清理排程的指令;清理指令實跑(假的執行紀錄 runid 用負數,我們的工作 15 天的刪掉、13 天的留著,`ifoodmap-ai-guard-cleanup` 的不碰)。
   - 函式屬性那項釘住 lock_timeout。「沒有紀錄的壞資料」那項改成「不當候選」。
   - 「取消不了」的單用 fixture guard 寫一筆時間是 timestamptz 最大值的紀錄:真的 guard 算「上一筆 + 1 微秒」會溢位,每次都失敗(沒有紀錄的單已經不當候選,要另一種失敗才測得到 EXCEPTION 那條路)。
   - 先紅 7 項;突變 5 處全殺:拿掉有紀錄的條件、每次 6 張、看 51 張、拿掉 lock_timeout、清理範圍寫成 `ifoodmap-%`。
7. **審查員的 atk_hardening**:複製到 `scratchpad/atk-adapted/atk_hardening.test.sql`,只改 E5 的 proconfig 期待值(加上 `lock_timeout=5s`),**13 / 13**;原檔沒動。

**數字**(`802e1a8`;乾跑只帶 20261012100000,每支之後殘留五個 0):`market_hardening` **41**、`market_orders` 67、`market_notify` 9、`market_checkout` 93、`market_hardening_rollback` 4,審查員副本 13。vitest:`802e1a8` 的乾淨副本 116 檔 / 1853 項全過(這次只改 SQL)。🔴 DEPLOY.md 第 3 階段的乾跑項數要改成 41,另外照協調者的決定寫上「量變大時改成每張單各自 commit 的 procedure」(由寫文件的人改)。

### 2026-10-12:寄信重試的總等待改成 5 秒,壓在 pg_net 的 8 秒逾時以內(commit `432f9aa`,分支 `market`)

接上面「market-notify 寄信遇到限速、伺服器錯誤會重試」一節。派工選了第二個做法:資料庫不改,把等待壓在 pg_net 呼叫這支函式的 8 秒逾時(`20261009130100` 的 `timeout_milliseconds := 8000`)以內。**以 repo 為準;那一節第 1 點的等待數字、第 3 點風險第 8 點的文字、第 4 點的待確認問題,都改以這一節為準。**

1. **新的數字**:一封信所有重試的等待加起來不超過 **5 秒**(預算用完就停,最後一次只等剩下的額度);`retry-after` 最多照 **3 秒**等;沒有 `retry-after` 時依序等 **0.7、1.5、2.5 秒**,再加最多 0.25 秒的抖動。重試次數(3 次)、哪些情況重試(429、5xx、連線失敗)、同一個 Idempotency-Key、重試的 log 都不變。Resend 的限速以秒計算,等 1–2 秒就夠讓同一次結帳的 4 封信都寄出。
2. **風險第 8 點**(第 17063 行)改成:**寄信遇到限速或伺服器錯誤會重試 3 次**:Resend 回 429 / 5xx 或連線失敗時,用同一個 Idempotency-Key 最多重試 3 次(retry-after 最多 3 秒,沒有就 0.7 / 1.5 / 2.5 秒加抖動,一封信總等待不超過 5 秒,在 pg_net 的 8 秒逾時以內做完),其他 4xx 不重試;重試後還是失敗才在 `notifications` 記 `failed`,要看後台「通知紀錄」手動處理。資料庫到函式那一段(pg_net)失敗仍然不會重送。
3. **待確認問題改寫**:等待總和壓在 5 秒,加上請求本身與寫 notifications,一般會在 pg_net 的 8 秒逾時以內做完,不必再靠「pg_net 斷線之後函式繼續跑」。但 Resend 每個請求本身要多久、Edge Function 冷啟動要多久,本機量不到 —— 🔴 **部署後還是要實測一次:一次結帳 3 家店,通知紀錄(`/admin/notifications`)要有 4 筆 sent**(1 封下單確認加 3 封新訂單信;閘門沒開時 4 筆都是寄到 ifoodmaptw@gmail.com 的「[測試轉寄]」)。少了或記成 failed 時,先看 Edge Function 的 log 有沒有 `send-retry` 與 `send` 的錯誤,再看 `net._http_response` 有沒有逾時。
4. **測試**:上限數字跟著改(429 兩次後成功等 0.7 / 1.5 秒;一直 429、抖動最大時等 0.949 / 1.749 / 2.302 秒,總和剛好 5 秒;retry-after 30 秒只等 3 秒、第二次只剩 2 秒額度、之後不再重試;沒注入 sleep 時假的 timer 推 0.95 秒)。新增「同一刻 4 封信、假的 Resend 每秒只收 2 封」(假的 timer,不真的等):寄信包裝那一層三種抖動(0、0.5、0.999)各一項,handler 那一層用一次結帳 3 家店(下單確認加 3 封新訂單信同時送),都是 4 封都寄出 / 記成 sent、每個 key 只寄一次、每封總等待不超過 5 秒。突變:不重試、總等待只有 0.5 秒、退避都在同一秒內,這幾項都紅;連跑 5 次都穩定。

**數字**

- market-notify vitest:**4 檔 / 121 項**(gate 8、send 14、render 46、handler 53;上一節 117 項)→ Task 42 Step 4 的 Expected 改成 **`Tests  121 passed (121)`**;「F. 共用指令與基準數字」第 2、3 階段的總數比計畫多 **91 項、1 檔**。
- 全套:`432f9aa` 的乾淨副本(`git archive`)連跑兩次 **116 檔 / 1857 項**全過;tsc strict 兩份設定 0 error,eslint 沒有輸出。

### 2026-10-12:自動取消每輪最多 3 張(commit `f459e04`,分支 `market`)

第 3 階段審查模擬寄信限速:一輪取消 5 張 = 10 封信,Resend 預設每秒只收 2 個請求,最後有 1–2 封失敗;降到每輪 3 張就 0 封失敗。20261012100000 還沒套用,直接改原檔。先改測試、看到失敗才改。**以 repo 為準。**

- `market_expire_orders` 的 `c_per_run` 從 5 改成 **3**,`c_scan` 維持 50。常數旁的註解改成「每 10 分鐘最多 3 張,每小時最多 18 張 —— 配合寄信的限速」,並寫明審查模擬的結果;檔頭、函式說明裡的「成功取消 5 張就停」一起改成 3。
- 標記 `@market-auto-cancel-hours`(第 324 行)與常數(第 325 行)沒動。
- 測試:「7 張逾時」改成四輪 **3、3、1、0**。第一輪剩下最晚下單的 4 張;第三輪剩 1 張,之後那 49 張取消不了的照樣失敗、不算。項數不變(41);先紅 2 項。其他場景(第一次跑 2 張、飢餓 1 張、第 50 / 51 張)每輪都不到 3 張,不受影響。

**數字**(`f459e04`;乾跑只帶 20261012100000,每支之後殘留五個 0):`market_hardening` 41、`market_orders` 67、`market_notify` 9、`market_checkout` 93、`market_hardening_rollback` 4,審查員副本 `atk_hardening` 13。vitest:`f459e04` 的乾淨副本 116 檔 / 1857 項全過。🔴 DEPLOY.md 第 3 階段寫「成功取消 5 張就停」「每次最多 5 張」的地方(自動取消的批次、單一交易那段、開放前檢查表)要改成 3 張(每小時最多 18 張),由寫文件的人改。
