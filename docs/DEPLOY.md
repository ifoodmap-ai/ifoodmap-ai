# iFoodmap 部署

同一份 codebase 部署成兩個 Vercel 站,用建置變數 `VITE_PORTAL` 分流。

| 站台 | 網址 | 內容 | 部署方式 |
|---|---|---|---|
| **前台 + 餐廳 + 供應商** | https://app.ifoodmap.ai(2026-09-29 起;舊的 `dish-to-supply.vercel.app` 整站 308 過來,見「產品站正式網域」) | 登入首頁、餐廳後台、供應商後台、公開頁 | GitHub push main **自動部署** |
| **平台營運後台** | https://ifoodmap-admin.vercel.app | 只有 `/admin/*` | GitHub push main **自動部署** |

管理員後台**刻意不出現在客戶看得到的網域上** —— 主站的 `/admin` 會顯示 404。

形象站 https://ifoodmap.ai 的原始碼也在這個 repo(`landing/`),但它是另一個 Vercel 專案、另一條 workflow,
見下面的「形象站(landing/)」。

## 環境變數

| 變數 | 前台站 | 管理員站 |
|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | ✅ |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅ | ✅ |
| `VITE_PORTAL` | (不設) | `admin` |
| `VITE_ADMIN_SITE_URL` | 選填,預設 `https://ifoodmap-admin.vercel.app` | — |
| `VITE_MAIN_SITE_URL` | — | 選填,預設 `https://app.ifoodmap.ai`(`src/lib/portal.ts`)。🔴 管理員站專案上有設,會蓋過預設值:值必須是 `https://app.ifoodmap.ai` |
| `VITE_LANDING_URL` | 選填,預設 `https://ifoodmap.ai`(`src/lib/site.ts`) | 同左 |

Vite 在建置時把 `import.meta.env.VITE_*` 內聯進 bundle,**改了值一定要重新建置**,不是改 Vercel 環境變數就會生效。

## 兩站都是自動部署

```bash
git push origin main
```

`.github/workflows/deploy-vercel.yml` 有兩個平行的 job,一次推同時更新兩站。
兩個專案都在 **ifoodmap team** 底下。

用到的 GitHub secrets:

| Secret | 用途 |
|---|---|
| `VERCEL_TOKEN` | 部署權杖 |
| `VERCEL_ORG_ID` | team scope |
| `VERCEL_PROJECT_ID_DISH` | 前台站 |
| `VERCEL_PROJECT_ID_ADMIN` | 管理員站 |

`VITE_PORTAL=admin` **設在 Vercel 專案的環境變數上**,不是在 workflow 裡 ——
Vercel 建置時自動帶入,所以兩個 job 的指令完全一樣,只差 PROJECT_ID。

### 手動部署(需要時)

```bash
cd ~/.gemini/File/ifoodmap
VERCEL_ORG_ID=team_VJzPZOwBqciuXnPC0XltX4MW \
VERCEL_PROJECT_ID=prj_cf9IKsaZJd5AwOr9Jg3TRGmRZUrU \
  npx vercel deploy --prod --yes --token <ifoodmap-team-token>
```

## 產品站正式網域 app.ifoodmap.ai(2026-09-29)

前台 + 餐廳 + 供應商(Vercel 專案 `dish-to-supply`)的正式網址從 `https://dish-to-supply.vercel.app` 換成 **https://app.ifoodmap.ai**
(業主 2026-09-29 決定)。管理員站 `https://ifoodmap-admin.vercel.app` **不搬**。
舊網址由根目錄 `vercel.json` 依 host 整站 308 到新網址(路徑與 query 保留)。

換網域要一起動的地方,漏一處就會有人被帶回舊網址,或信裡的連結落錯頁:

| 哪裡 | 設定 |
|---|---|
| DNS(GoDaddy,跟形象站同一個 ifoodmap.ai zone) | `CNAME app → 6831af22301ab513.vercel-dns-017.com` |
| Vercel `dish-to-supply` 專案 → Domains | 掛 `app.ifoodmap.ai` |
| Supabase Auth → URL Configuration | `site_url` = `https://app.ifoodmap.ai`;`uri_allow_list` 要有新網域(例如 `https://app.ifoodmap.ai/**`),**舊網址至少再留 1–2 週** —— 已寄出的確認信、重設密碼信、邀請信裡的 `redirect_to` 還是舊網址,不在清單上的話 Supabase 會改導到 `site_url` 首頁,而不是原本的 `/reset-password` 等頁 |
| Edge Function secret `SITE_URL` | `https://app.ifoodmap.ai`,🔴 **結尾不能有斜線**(`notify`、`invite-restaurant-member` 直接字串相接,會變成 `//reset-password`)。讀它的有 `notify`、`invite-restaurant-member`、`approve-supplier`、`notify-lead` 四支 |
| 管理員站 Vercel 專案的環境變數 `VITE_MAIN_SITE_URL` | `https://app.ifoodmap.ai` —— 它會蓋過程式預設值;建置時內聯,改完要重新部署管理員站 |
| repo 裡的預設值 | `src/lib/portal.ts` 的 `MAIN_SITE_URL`(`portal.test.ts` 釘住)、根目錄 `index.html` 的 og / twitter 網址、形象站 `landing/index.html` 的 `IFM_PRODUCT_BASE_URL`(`landing/tests/content.test.cjs` 釘住) |

- `supabase/functions/**` 裡的預設值(`SITE_URL` 沒設時用的舊網址)**刻意沒改**:改了要手動重新部署上面四支函式,這次只靠 secret。
  所以 secret 萬一被刪掉,信裡的連結會退回舊網址。
- 🔴 **所有人都要重新登入一次**:Supabase session 存在各網域自己的 localStorage(見「跨站 session」),
  舊網址上的登入狀態不會跟著 308 過去。
- 轉址規則在根目錄 `vercel.json` 的 `redirects`。🔴 **這份檔案 dish-to-supply 與 ifoodmap-admin 兩個專案共用**:
  host 條件只比對 `dish-to-supply.vercel.app` 本身,正式網域、管理員站、preview 部署都不會被轉走。
  站根 `/` 要另外一條(Vercel 的 `/:path*` 不比對站根,形象站上線當天踩過)。`src/test/product-domain-redirect.test.ts` 釘住規則。

## 形象站(landing/)

https://ifoodmap.ai 的原始碼在 `landing/`:純靜態頁 + `landing/api/` 三支 Vercel Function(代理 Edge Function `ai`),
沒有任何相依套件。2026-09-28 從 `ifoodmap-ai/ifoodmap-landing` 連同完整歷史併進來,`git log -- landing/index.html` 看得到全部歷史。
**舊 repo 已凍結,不要再 push 過去** —— 它的部署 workflow 在業主停用前仍然開著,推上去會用舊內容蓋掉正式站。

本機測試:`cd landing && npm test`(node:test,不需要 npm install)。

### 形象站怎麼部署

`.github/workflows/landing-deploy.yml`,push main 自動跑:`npm test` → `vercel pull` → `node scripts/prerender.mjs --in-place`
→ `vercel build --prod` → `vercel deploy --prebuilt --prod`,全部在 `landing/` 裡執行。PR 只跑測試、不部署。

- **路徑過濾**:只有 `landing/**` 或 `landing-deploy.yml` 本身有變動才會觸發。反過來,`deploy-vercel.yml` 與 `product-ci.yml`
  用 `paths-ignore` 排除這兩者;Vercel Git 整合那一路由根目錄 `vercel.json` 的 `ignoreCommand` 擋
  (上次成功部署到這次之間,只動到 `landing/` 或 `.github/` 就跳過建置)。
  所以**只改 `landing/` 的 push,兩個產品站都不會重建**;同一個 push 兩邊都有改,就兩邊各自部署。
  注意:只改 `.github/` 底下其他檔案(例如 `product-ci.yml`)時,Git 整合會跳過,但 `deploy-vercel.yml` 仍會照常用 CLI 部署兩站。
- **專案 ID**:`VERCEL_PROJECT_ID` 直接寫在 workflow 裡(形象站專案 `ifoodmap-landing`,不是機密);
  token 與 team 沿用本 repo 的 `VERCEL_TOKEN`、`VERCEL_ORG_ID`(三個專案同一個 team)。
  🔴 **不要改成 `secrets.VERCEL_PROJECT_ID`** —— 本 repo 那個 secret 是已經不用的舊 "ifoodmap" 專案,改了會把形象站部署到錯的專案。
  `landing/tests/deploy-workflow.test.cjs` 有擋。
- **12/31 排程**:cron `5 16 31 12 *`(UTC)= 台北每年 1/1 00:05 自動重建一次,只重跑預渲染、不 commit ——
  頁尾年份是程式算的,但不跑 JavaScript 的爬蟲讀的是預渲染時烤進 HTML 的年份。排程只在 main 上跑,`paths` 對排程無效。
  手動重建:`gh workflow run landing-deploy.yml -R ifoodmap-ai/ifoodmap-ai`。
- 🔴 **Vercel 上 `ifoodmap-landing` 專案的 Root Directory 必須保持空白**:workflow 已經在 `landing/` 裡跑 `vercel build`,
  改成 `landing` 的話 CLI 會去找 `landing/landing`,建置直接失敗。
- 預渲染用到全域 `WebSocket`,Node 必須 ≥ 22;workflow 固定 24(= Vercel 專案的 function runtime)。
- 回退:Vercel → `ifoodmap-landing` → Deployments → 選上一個 → Instant Rollback;或 `git revert` 之後 push。

### 正式網域 ifoodmap.ai(2026-09-29 起)

- **DNS 在 GoDaddy**(業主帳號,改記錄每次都要簡訊驗證碼)。形象站用到的記錄:
  `A @ → 216.198.79.1`、`A @ → 64.29.17.1`、`CNAME www → f5e783407fbb1135.vercel-dns-017.com`。
  🔴 同一個 zone 還有 GoDaddy 信箱的 `MX @`×2、`CNAME email`、`secureserver1/2._domainkey`、SPF 與 `_dmarc` ——
  那是業主現在在用的信箱,**不要動**;寄信(Resend)的記錄見「寄件網域」。
- `www.ifoodmap.ai` → `ifoodmap.ai` 的 308 是 **Vercel 網域設定**做的(ifoodmap-landing 專案 → Domains),不寫在 `landing/vercel.json`。
- 舊網址 `ifoodmap-landing.vercel.app` 由 `landing/vercel.json` 的 host 條件整站 308 轉到 ifoodmap.ai(路徑與 query 保留);
  **preview 部署的網址不受影響**。三邊(routing.js / index.html / vercel.json)用 `landing/tests/public-domain.test.cjs` 釘在同一個網址。
  ⚠️ 站根 `/` 是另外一條規則:只寫 `/:path*` 時,Vercel 上舊網址的 `/` 照樣回 200(上線當天實測),深層頁才有轉。
- SSL 憑證:Vercel 當初沒有自動簽,是用 API `POST /v3/certs {"cns":["ifoodmap.ai","www.ifoodmap.ai"]}` 手動簽的(Let's Encrypt,autoRenew)。
  之後若憑證出問題:先看 `GET /v6/domains/ifoodmap.ai/config` 的 `misconfigured`,再重跑同一支 API。
  本機 vercel CLI 看不到 ifoodmap team,要用本 repo 的 `VERCEL_TOKEN` secret(例如暫時分支上的一次性 workflow,跑完刪分支)。

## 跨站 session

兩站是不同 origin,Supabase session 存在各自的 localStorage,**不共用**。
所以身分切換器(`src/components/PortalSwitcher.tsx`)切到管理員站時會標示
「另開新站,需重新登入」—— 這是預期行為,也是權限隔離的好處。

## 路由分流的實作

`src/lib/portal.ts` 匯出 `IS_ADMIN_BUILD`,`src/App.tsx` 依它渲染 `<AdminRoutes />`
或 `<MainRoutes />`。要新增頁面時記得掛在正確的那一組。

## 資料庫 migration 落差檢查

`.github/workflows/deploy-vercel.yml` 有一個 `check-migrations` job,
每次 push main 都會比對 `supabase/migrations/*.sql` 與線上
`supabase_migrations.schema_migrations` 的紀錄,有落差就讓 workflow 變紅。

**為什麼需要**:2026-07-27 發現 `20260726150000_restaurant_self_signup.sql`
躺在 repo 好幾天沒套到線上,前端一直呼叫一個不存在的 RPC ——
餐廳註冊從頭到尾不可能成功,而且沒有任何機制會告訴我們。

本機也能跑:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=cwvpehqcvbfuynabpqop \
  node scripts/check-migrations.mjs
```

### 寫了新 migration 之後

這個專案的 DB 是 dashboard 管理的,`supabase db push` 需要該專案的存取權
(本機 CLI 登入的帳號沒有)。實務上是用 Management API 直接套:

```bash
python3 -c "
import json,pathlib,sys
pathlib.Path('/tmp/q.json').write_text(json.dumps({'query': pathlib.Path(sys.argv[1]).read_text()}))
" supabase/migrations/<檔名>.sql

curl -s -X POST "https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36" \
  --data-binary @/tmp/q.json
```

⚠️ Management API 不會自動寫 ledger,**套完要補一筆**,否則 CI 會一直紅:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20260726150000', 'restaurant_self_signup')
on conflict (version) do nothing;
```

（Cloudflare 會擋掉沒有瀏覽器 User-Agent 的請求,回 1010 —— 上面的 `-H "User-Agent: ..."` 不能省。）

## Edge Function `ai` 的部署

```bash
SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy ai --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt
```

形象站有中英兩版(`/` 與 `/en`)。前端呼叫 `ai` 時會多帶一個 `lang` 欄位,
`en` 會讓回覆、菜單分析的品名與摘要全部改用英文(見 `withLang()` / `EN_DIRECTIVE`)。
沒帶或帶別的值就是原本的繁體中文行為,所以這個改動對舊 client 是相容的。

**一定要帶 `--no-verify-jwt`。** 主站前端(`src/lib/api.ts`)與形象站的代理(`landing/api/ai-chat.js`)
呼叫這支時都只送 `apikey`、沒有 `Authorization` header;少了這個旗標會把 JWT 驗證打開,
兩邊立刻全部 401(`UNAUTHORIZED_NO_AUTH_HEADER`)。2026-09-22 踩過一次,形象站 AI 助手斷了幾分鐘。

## 表單 lead 通知(notify-lead)

官網表單送出後自動寄信到 **`ifoodmaptw@gmail.com`**。

```
瀏覽器 --(PostgREST INSERT)--> partnership_leads / landing_leads
          --(AFTER INSERT trigger, pg_net 非同步)--> notify-lead Edge Function
          --(Resend)--> ifoodmaptw@gmail.com
```

**為什麼需要這個機制**:`landing_leads` 與 `partnership_leads` 對 anon 只開
INSERT、**沒有任何 SELECT policy**,而 27 個 admin 頁面裡沒有一頁列出它們
(只有 `AnalysisDetailPage.tsx` / `AdminOrderDetailPage.tsx` 會用 `analysis_id`
反查 `landing_leads`)。換句話說**表單送進來在後台完全看不到** ——
在做出後台列表頁之前,寄信是唯一會讓業主知道「有人來敲門」的機制。

**為什麼要解耦成 trigger → Edge Function**:形象站是純靜態站,瀏覽器端只管
INSERT。寄信失敗不會讓使用者看到錯誤,lead 也不會掉。

| 元件 | 位置 |
|---|---|
| Edge Function | `supabase/functions/notify-lead/index.ts` |
| Trigger + 設定表 | `supabase/migrations/20260923120000_lead_notifications.sql` |
| 收件人 / 寄件人 | Supabase secrets `LEAD_NOTIFY_TO` / `LEAD_NOTIFY_FROM`(未設時用程式內預設) |
| 共享密鑰 | Supabase secret `LEAD_HOOK_SECRET` **與** `public.app_config.lead_hook_secret`(兩邊必須一致) |
| Function URL | `public.app_config.lead_notify_function_url` |

### 怎麼改收件人

不用改程式、不用重新部署 —— 設一個 secret 就好(多個收件人用逗號分隔):

```bash
SUPABASE_ACCESS_TOKEN=sbp_... supabase secrets set \
  LEAD_NOTIFY_TO=ifoodmaptw@gmail.com,someone@else.com \
  --project-ref cwvpehqcvbfuynabpqop
```

⚠️ **改 secret 會讓專案上所有 Edge Function 重新部署一次**(版號都會 +1)。
這是 Supabase 的正常行為,原始碼與 `verify_jwt` 設定都不會變 —— 但改完
順手確認一下 `ai` 沒被影響(它斷掉會讓形象站的 AI 助手掛掉)。

### 寄件網域

**2026-09-29 起全部改用業主的 `ifoodmap.ai` 寄信**(之前借用 gathertaiwan.com):

| 寄件人 | 用在哪 | 設在哪 |
|---|---|---|
| `iFoodmap 食材地圖 <noreply@ifoodmap.ai>` | 訂單通知(`notify`)、寄給供應商申請者的信 | Supabase secret `NOTIFY_FROM` |
| `iFoodmap 表單通知 <noreply@ifoodmap.ai>` | 寄給業主的內部通知(官網表單、供應商申請) | Supabase secret `LEAD_NOTIFY_FROM` |
| `iFoodmap 食材地圖 <noreply@ifoodmap.ai>` | Supabase Auth 的註冊確認/邀請/重設密碼 | Auth 設定 `smtp_admin_email` + `smtp_sender_name` |

- ifoodmap.ai 驗證在 **gathertaiwan 的 Resend 帳號**(東京 ap-northeast-1)。`RESEND_API_KEY` 與 Auth SMTP 的密碼都是這個帳號的 key,
  所以換網域只要改上面三個值,不用換 key。
- 程式裡的預設值(`supabase/functions/*` 的 `?? "…@gathertaiwan.com"`)只在 secret 沒設時才用得到;
  gathertaiwan.com 在同一個 Resend 帳號仍是已驗證狀態,所以就算 secret 被刪掉也寄得出去,只是寄件網域會變回舊的。
- DNS(GoDaddy)上 Resend 用的三筆:`TXT resend._domainkey`(DKIM)、`CNAME send → send.forge.rmta.net`、
  `CNAME rsend → rsend-apne1.forge.rmta.net`。🔴 **不要加 Resend 頁面上的收信 MX(`@ → inbound-smtp…`)**:
  根網域的 MX 是業主現在在用的 GoDaddy 信箱,加了會把信搶走。
- 驗證紀錄:切換當天用一筆測試用供應商申請同時觸發兩條路徑(申請者確認信走 `NOTIFY_FROM`、業主通知走 `LEAD_NOTIFY_FROM`),
  Resend 上兩封都是 `noreply@ifoodmap.ai`、Delivered;測試資料已刪。Auth 那條沒有實寄(那要在正式站開帳號),
  下一封真實的邀請/註冊信寄出後,到 Resend → Emails 確認寄件人即可。

信件的 `reply_to` 會設成 lead 填的 `contact_email`(只有 `partnership_leads` 有這欄),
所以業主在 Gmail 直接按回覆就是回給對方。

### 🔴 部署一定要帶 `--no-verify-jwt`

```bash
SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy notify-lead \
  --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt
```

DB trigger 是 `pg_net` 直接打 HTTP,**沒有使用者 JWT 可帶**。少了這個旗標會把
JWT 驗證打開,webhook 每次都被擋成 401,信一封都不會寄 ——
而且因為 trigger 吞掉錯誤,**不會有任何地方報錯**,會靜默失效。
(同一個坑 2026-09-22 在 `ai` 那支踩過,害兩個網站全部 401。)

安全性不是靠 JWT,是靠**共享密鑰**:Edge Function 檢查
`Authorization: Bearer <LEAD_HOOK_SECRET>`(或自訂 header `x-lead-hook-secret`),
不符就回 401。沒有這道檢查,它等於是一個「任何人都能叫它寄信到業主信箱」的公開端點。

### 換密鑰

兩邊要一起改,否則 trigger 打過去會被自己的函式擋成 401:

```bash
NEW=$(openssl rand -hex 32)
SUPABASE_ACCESS_TOKEN=sbp_... supabase secrets set LEAD_HOOK_SECRET=$NEW \
  --project-ref cwvpehqcvbfuynabpqop
# 再把同一個值寫進 app_config(走 Management API,記得帶 User-Agent)
# update public.app_config set value='<NEW>', updated_at=now() where key='lead_hook_secret';
```

### 怎麼確認它還活著

`pg_net` 會把每次呼叫的回應存下來,這是最直接的證據:

```sql
select id, status_code, left(content, 200), created
from net._http_response order by id desc limit 5;
```

`status_code = 200` 且 content 裡有 `"sent":true` 就是有寄出去。
真正送達與否去 Resend 後台(或 `GET https://api.resend.com/emails/<resend_id>`)
看 `last_event` 是不是 `delivered`。

### 新增欄位不用改 Edge Function

`notify-lead` 會把 record 裡**所有非空欄位**列進信裡 —— 沒在 `SPECS` 定義
中文標籤的欄位也會顯示(用原始欄位名)。所以之後表單加欄位不會漏資料,
只是標籤會是英文;要中文標籤再回去 `SPECS` 補。

⚠️ 只有 `partnership_leads` 與 `landing_leads` 會照 record 內容寄信;`supplier_applications`
只寄資料庫裡排好隊的信(見下一節),其他 table 一律跳過不寄 —— 不要讓這支變成通用寄信機。

## 供應商入駐申請的寄信(2026-09-28,migration 20260928180000 / 180100 / 180200)

| 時機 | 誰收到 | 誰寄 | 內容 |
|---|---|---|---|
| 送出申請(`/join`) | 業主(`LEAD_NOTIFY_TO`) | `notify-lead`(Resend) | 申請全部欄位 + 「前往審核」連結 + 確認信有沒有寄出 |
| 送出申請 | 申請者 | `notify-lead`(Resend) | 已收到、約 3 個工作天審核、結果會寄信通知(**不回顯申請者填的任何文字**) |
| 核准,新帳號 | 申請者 | Supabase Auth 邀請信(SMTP) | 連結 → `/reset-password?type=invite` →「設定密碼以啟用供應商帳號」 |
| 核准,Email 原本就有帳號 | 申請者 | `approve-supplier`(Resend) | 「申請已通過,請用原本的帳號登入」;**不改該帳號的 role / app_metadata** |
| 退件 | 申請者 | `approve-supplier`(Resend,`action: "reject"`) | 只有「給申請者的說明」(`applicant_message`);`admin_notes` 是內部備註,不會寄出 |

```
瀏覽器 --(anon INSERT)--> supplier_applications
  --(AFTER INSERT trigger:advisory lock 內做頻率判斷、記 queued)--> supplier_application_mails
  --(pg_net,只帶申請 id)--> notify-lead --(把 queued 搶成 sending 才寄)--> Resend
```

**防濫用**(申請表是匿名的,自動回信等於任何人都能叫我們寄信給任意信箱):

| 規則 | 在哪裡 |
|---|---|
| 同一個 email 只能有一筆待審申請 | 部分唯一索引 `supplier_applications_one_pending_per_email`,前端收到 23505 會說「已經有一筆申請在審核中」 |
| 同一個 email 24 小時內最多一封確認信(先去 +tag、gmail 去點) | trigger `supplier_application_queue_mails()` |
| 全站每小時確認信上限(預設 20) | 同上;`app_config.supplier_application_confirm_hourly_cap` 可改,不用部署 |
| 全站每小時業主通知上限(預設 30) | 同上;`app_config.supplier_application_owner_hourly_cap` |
| 匿名只能送 pending、不能帶管理員欄位、欄位有長度上限 | `anon submit application` policy |
| email 只收一般格式(英數與 `._%+'-` 的帳號、正常網域、英文或 punycode `xn--` 頂級網域);`文字<信箱>`、`x@gmail.com.` 一律擋 | 同一條 policy(20260928180100 嚴格化、180200 放行撇號與 punycode);前端 `JoinSupplierPage`、寄信端 `isDeliverableEmail()` 再各擋一次(三處規則要一起改) |
| honeypot 欄位 `website` | `JoinSupplierPage.tsx`(填了就假裝成功、不寫資料庫) |

頻率判斷一定要在資料庫裡做(同一把 advisory lock、同一個交易):放在 Edge Function 裡「先數再寄」,
併發請求每個數到的都是同一個數字。被略過的信也會記一筆 `status='skipped'` + `skip_reason`
(`email_24h` / `hourly_cap` / `owner_hourly_cap` / `invalid_email`)。
email 格式要嚴格是因為「同一個 email」是拿字串比的:寬鬆格式下 `a<victim@…>`、`b<victim@…>` 都算不同 email,
兩條頻率限制都擋不住;寄信服務還可能把 `文字<信箱>` 當成「顯示名稱 + 地址」,等於讓人在收件人名稱塞廣告。

**核准只接受待審(pending)的申請**:已退件的申請者已經收到退件信,不能再收到一封邀請信;
兩位管理員同時處理同一筆時,後到的那個會 409 並收回自己建的資料(復原失敗會據實回報還留著什麼)。

**寄件人**:寄給申請者的信用 `NOTIFY_FROM`(與 `notify` 共用,現值 `iFoodmap 食材地圖 <noreply@ifoodmap.ai>`),
業主通知用 `LEAD_NOTIFY_FROM`(現值 `iFoodmap 表單通知 <noreply@ifoodmap.ai>`);
申請者按「回覆」會寄到 `SUPPLIER_MAIL_REPLY_TO`(沒設就是 `LEAD_NOTIFY_TO` 的第一個)。2026-09-29 起的寄件網域見「寄件網域」。

**確認有沒有寄出**:每封信都記在 `supplier_application_mails`(`status` / `resend_id` / `error`;寄給申請者的信另存 `body_text`)。

```sql
select application_id, kind, status, skip_reason, resend_id, error, created_at
from public.supplier_application_mails order by id desc limit 10;
```

**部署**(兩支都指定單一名稱;`verify_jwt` 見 `supabase/config.toml`):

```bash
SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy notify-lead --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy approve-supplier --project-ref cwvpehqcvbfuynabpqop --use-api
```

共用程式在 `supabase/functions/_shared/`(`supplier-mail.ts` 信件內容與 Resend、`db.ts` 介面),
`--use-api` 會一起上傳。邏輯都有 vitest:`approve-supplier/handler.test.ts`、`notify-lead/supplier-application.test.ts`、
`_shared/supplier-mail.test.ts`;資料庫規則用本機 Postgres 實跑(`supabase/tests/supplier_application_mail.test.ts`,
含「交易互相重疊的併發」與「拿掉 advisory lock 就會超量」的對照組;沒有 Postgres 的環境自動 skip 並印出原因)。

**還原**:依序跑 `supabase/rollbacks/` 的 `20260928180200_*` → `20260928180100_*` → `20260928180000_*.down.sql`
(還原 180000 前要先把 `approve-supplier` 換回舊版並重新部署,檔頭有寫)。

**Auth 邀請信模板**(餐廳成員邀請與供應商開通共用):主旨「設定密碼以啟用你的 iFoodmap 帳號」,
內文寫明「連結 1 小時內有效、只能用一次、失效可在連結頁重寄或用忘記密碼」。2026-09-28 用 Management API
`PATCH config/auth` 改(只動 `mailer_subjects_invite` / `mailer_templates_invite_content`)。
全站連結效期 `mailer_otp_exp` 維持 3600 秒不動;連結過期時 `/reset-password` 會顯示「連結已失效」並提供
「重新寄送設定密碼連結」(`resetPasswordForEmail`,邀請流程帶回 `?type=invite`)。

## 餐廳新增成員(invite-restaurant-member)

餐廳後台「分店與成員」頁(`src/pages/restaurant/RestaurantTeamPage.tsx`)的「新增成員」按鈕
(只有老闆看得到)會呼叫這支 Edge Function:建帳號 → 寫一筆**待接受**的 `restaurant_accounts`
(`accepted_at = null`)→ 寄邀請信。**對方登入後按「接受」才會成為成員**(見下方「邀請要對方接受才生效」)。
寄信沿用 `approve-supplier` 的做法(`inviteUserByEmail`,同一個 Auth 邀請信模板),
但帳號改成**先用 `createUser` 建**(帶好 `app_metadata`):email 唯一索引保證同一個 email
同時被邀兩次時只有一個請求建得起來,失敗時的 rollback 只會刪到自己建的帳號。
(`approve-supplier` 是「先 invite 再 `updateUserById`」:email 已有帳號時會沿用那個帳號並覆寫它的
`app_metadata.role` —— 這裡刻意不照抄這一段。)

| 元件 | 位置 |
|---|---|
| Edge Function | `supabase/functions/invite-restaurant-member/index.ts`(只接 Deno);邏輯在 `handler.ts`、輸入驗證在 `validate.ts`,兩支都有 vitest(`handler.test.ts` 用假 client 測每條分支) |
| SQL(唯讀函式) | `supabase/migrations/20260928150000_restaurant_member_invites.sql` |
| SQL(頻率限制) | `supabase/migrations/20260928160000_restaurant_invite_guards.sql`(`restaurant_invite_attempts` 表 + `claim_restaurant_invite_slot()`) |
| SQL(接受制 + 權限收緊) | `supabase/migrations/20260928170000_restaurant_member_acceptance.sql`(rollback:`supabase/rollbacks/20260928170000_restaurant_member_acceptance.down.sql`) |
| SQL(profiles 不再公開) | `supabase/migrations/20260928170100_profiles_read_scope.sql`(rollback:`supabase/rollbacks/20260928170100_profiles_read_scope.down.sql`) |
| 前端(老闆) | `RestaurantTeamPage.tsx`(測試 `RestaurantTeamPage.test.tsx`) |
| 前端(受邀者) | `src/lib/restaurant-invites.ts` + `src/components/RestaurantInvitePanel.tsx`,掛在登入首頁 `LoginPortal.tsx` |

上表四個 migration 2026-09-28 都已用 Management API 套上線並補 ledger。
`supabase/rollbacks/*.down.sql` 不是 migration(不要搬進 `migrations/`),要還原時整段執行;
兩支都要還原的話先跑 profiles 那支。🔴 **還原順序**:① 先單獨跑 rollback 檔的「第 0 步」(停用所有待接受的邀請,
新程式下無害)→ ② 把前端與 `invite-restaurant-member`(v3 起)、`notify`(v5 起)退回舊版 → ③ 再整段跑 rollback。
程式都會查 `accepted_at`,沒先退版就拿掉欄位,PostgREST 會回 400:所有餐廳使用者會被當成沒有身分、邀請全失敗、訂單信不寄給餐廳;
第 0 步放最前面,則是為了退版期間舊版 notify 不會把訂單信寄給還沒接受的人。
資料庫層的測試:`supabase/tests/database/restaurant_member_acceptance.test.sql`(pgTAP,58 項;不用 dblink,可以整支包在 BEGIN … ROLLBACK 裡跑)。「兩個人同時各降一位老闆」要兩條連線,pgTAP 單一交易測不到 ——2026-09-28 在正式庫用兩個並行交易實測過:後到的那個會等鎖、拿到 23514,最後剩一位老闆。

### 🔴 部署用預設的 JWT 驗證(不要加 `--no-verify-jwt`)

```bash
SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy invite-restaurant-member \
  --project-ref cwvpehqcvbfuynabpqop --use-api
```

(2026-09-28 部署 v3「邀請寫成待接受」後,`GET /v1/projects/cwvpehqcvbfuynabpqop/functions` 確認 `verify_jwt: true`。)

跟 `ai` / `notify-lead` **相反**:這支一定是已登入的老闆從瀏覽器呼叫(帶 `Authorization: Bearer <使用者 JWT>`
+ `apikey`),所以讓 gateway 先擋掉沒登入的請求。`--use-api` 是因為本機沒有 Docker。
確認活著:不帶 token 打會回 gateway 的 401 `UNAUTHORIZED_NO_AUTH_HEADER`;
帶 anon key 當 Bearer 會回**函式自己的** 401 `{"code":"UNAUTHENTICATED",...}`(代表已部署、且 JWT 驗證是開的)。

### 授權邏輯(全部在伺服器端,不信前端)

1. `auth.getUser(JWT)` 失敗 → **401**
2. 呼叫者在 `restaurant_accounts` 沒有任何 `role='owner' AND is_active AND accepted_at IS NOT NULL` 的列 → **403**
   (還沒接受的「老闆邀請」不能拿來邀請別人)
3. 輸入驗證(email 格式、姓名 1–50 字、角色只能是 `owner` / `manager` / `purchaser`、分店/餐廳要是 UUID)→ **400**
4. 前端帶的 `restaurant_id` 只用來「指定哪一家」,必須在呼叫者當老闆的店裡,否則 **403**
   (沒帶且只當一家店的老闆 → 就是那家;是多家店的老闆又沒帶 → 400)
5. 餐廳已停用 → 403;分店不屬於這家店 / 已停用 → 400
6. 頻率限制:同一家店一小時內超過 20 次嘗試 → **429**。在資料庫裡原子化(advisory lock + 計數 + 記一筆
   在同一個交易),同時灌一堆請求也不會超量(2026-09-28 實測 8 個併發、上限 3 → 剛好 3 個過)。
   **排在查 email 之前**,所以回 409 的嘗試也算 —— 不然有人可以不限次數地探測誰有註冊
7. 這個 email 已經有帳號 → **409**,**一律不綁、不改**(`restaurant_invite_email_status()` 查,只開給 service_role):
   - 已邀請、對方還沒按「接受」(`member_pending`)→ `INVITE_PENDING`(訊息會教對方用「忘記密碼」設定密碼後登入按接受)
   - 已是本店啟用中成員 → `ALREADY_MEMBER`
   - 曾是本店成員、目前停用 → `MEMBER_INACTIVE`(請在列表按「啟用」,不用重新邀請)
   - 其他任何帳號(供應商、別家餐廳、平台管理員、註冊到一半的)→ `EMAIL_TAKEN`,訊息刻意不透露是哪種身分
8. `createUser`(`email_confirm: false`、`app_metadata = { role: "restaurant", invited_by, invited_restaurant_id }`,
   不會寄信)→ 寫 `restaurant_accounts`(**`accepted_at: null`**)→ `inviteUserByEmail` 寄信。
   後兩步失敗就刪掉剛建的 auth user(成員資料 cascade 刪掉);刪除失敗重試一次,
   還是失敗回 `ROLLBACK_FAILED`(請聯絡客服,不要重試)。log 只記 id 與錯誤 code,不記 email

`app_metadata.role = "restaurant"` 只是身分標記(沒有程式靠它判斷權限);**店內角色以 `restaurant_accounts.role` 為準** ——
老闆之後可以在成員頁改角色,寫進 JWT 會過期。**絕不能**對既有帳號呼叫 `updateUserById(app_metadata)`:
`app_metadata` 的 `role` 只有一格,覆蓋掉 `admin` 等於拔掉平台管理員權限(第 7 步先擋掉,就是為了這個)。
`invited_restaurant_id` 也留給之後用:見下方「已知風險」。

### 「邀請中」怎麼判斷

`restaurant_accounts.accepted_at IS NULL` —— 還沒按「接受」(不論有沒有點過邀請信)。成員頁直接看成員列的
`accepted_at`;`restaurant_member_directory(p_restaurant)` 的 `invite_pending` 也改成同一個判斷,它現在只用來拿 email
(只有該店已生效的成員查得到;email 只回給老闆與平台管理員,店長/採購員拿到 null)。

### 邀請要對方接受才生效(2026-09-28,migration 20260928170000)

- **是成員 = `is_active AND accepted_at IS NOT NULL`**。`current_restaurant_ids()`、`restaurant_role()`、
  `create_restaurant_onboarding()`、`restaurant_member_directory()` 都改成這個判斷,所以所有掛在這兩支輔助函式上的 RLS
  (訂單、菜單、分店、餐廳…)都不把待接受算進去;前端 `src/lib/portal.ts`、`RestaurantRoute`、`RegisterCompletePage`
  也只認已接受的列,`notify` 寄訂單信也只寄給已接受的老闆/店長。`accepted_at` 預設 NULL:任何寫入路徑忘了設都是「不生效」。
  (`notify` 2026-09-28 重新部署為 v5。它由 DB trigger 用共享密鑰呼叫,**部署要帶 `--no-verify-jwt`**:
  `supabase functions deploy notify --project-ref cwvpehqcvbfuynabpqop --use-api --no-verify-jwt`,部署後確認 `verify_jwt: false`。)
- **受邀者的畫面**:登入首頁(`LoginPortal`)登入後先查 `my_pending_restaurant_invites()`,有邀請就顯示
  「『X 餐廳』邀請你以『採購員』加入」+ 接受/拒絕(`RestaurantInvitePanel`),不會直接導進任何後台。
  從邀請信設定完密碼(`/reset-password` 會導回 `/`)、或 email 被搶先邀請後自己去註冊(`/register/complete`
  沒有註冊暫存資料時會導回 `/`)都走這裡。拒絕後沒有其他身分 → 同一個畫面直接輸入餐廳名稱建立自己的店
  (呼叫 `create_restaurant_onboarding()`,不依賴 user_metadata —— GoTrue 對「已存在未確認」的帳號 signUp 不會更新 metadata)。
- **RPC**(SECURITY DEFINER、`search_path = ''`、只處理 `auth.uid()` 自己那一筆待接受的列;anon 不能呼叫):
  `my_pending_restaurant_invites()`、`accept_restaurant_invite(id)`(回餐廳 id)、`decline_restaurant_invite(id)`(刪掉那筆邀請)。
  找不到(被取消/已處理/不是你的)一律 `P0001` + hint `invite_not_found`(HTTP 400)。
- **拒絕 = 刪掉那一筆邀請**。受邀者的帳號留著:前台登入首頁對「已登入、但沒有任何身分」的人一律顯示「建立自己的餐廳」
  (不再直接登出),所以拒絕後就算沒當場建店、之後回來也還走得下去;老闆把邀請停用的人也一樣。
  但同一個 email 之後再邀請會是 409 `EMAIL_TAKEN`(既有帳號一律不綁)—— 要讓既有帳號也能收邀請,得另外設計。
- **`restaurant_accounts` 的寫入權限**:anon 什麼都沒有;authenticated 只有 SELECT + `UPDATE (role, is_active, branch_id)`
  (欄位層級 GRANT —— 改不了 `user_id`/`restaurant_id`/`accepted_at`),UPDATE 的 policy 只給該店已生效的老闆與平台管理員。
  **沒有 INSERT/DELETE**:新增只能走 `create_restaurant_onboarding()` 或 Edge Function(service role);移除成員請「停用」。
  待接受的受邀者連自己那一列都讀不到。
- **trigger**:
  - `restaurant_accounts_keep_an_owner`:任何 UPDATE/DELETE 做完後,只要某家(還存在的)店沒有「已接受、啟用中的老闆」
    就整筆拒絕(`23514`「每家餐廳至少要保留一位啟用中的老闆」)。⚠️ 連 service role / Dashboard 也擋:
    **要刪某家店唯一老闆的 auth 帳號,得先刪掉那家餐廳**(cascade 不擋),否則 GoTrue 會回 Database error。
  - `restaurant_accounts_branch_matches`:成員綁的分店必須是同一家店的(`23503`)。

### profiles 不再公開(2026-09-28,migration 20260928170100)

anon 對 `profiles` 沒有任何權限;登入者只讀得到自己、自己已生效的店裡所有成員(含邀請中的人)、平台管理員讀全部
(`restaurant_teammate_user_ids()`)。app 裡讀 profiles 的只有 `RestaurantTeamPage`(用成員 user_id 查 display_name);
新帳號的 profile 由 `handle_new_user()`(SECURITY DEFINER trigger)建立,不受影響。

### 邀請信連結會落在哪

`redirectTo = ${SITE_URL}/reset-password?type=recovery`(secret `SITE_URL` 2026-09-29 起是 `https://app.ifoodmap.ai`;
沒設時程式預設值仍是舊的 `https://dish-to-supply.vercel.app`,刻意沒改,見「產品站正式網域」)。
`/reset-password` 只在收到 `PASSWORD_RECOVERY` 事件時才顯示「設定新密碼」,而 supabase-js 解析網址時
**query 參數優先於 hash**,所以多帶 `?type=recovery` 就會進「設定新密碼」(2026-09-28 用無頭瀏覽器實測)。
連結過期(`mailer_otp_exp` = 3600 秒,**1 小時**)時沒有 session,會落到「忘記密碼」表單 ——
請對方用同一個 Email 重設密碼即可,這也是正確的退路。

⚠️ `approve-supplier` 的邀請連結目前**沒有**帶 `?type=recovery`:受邀的供應商點信後其實已登入,
但畫面停在「忘記密碼」。治本是讓 `ResetPasswordPage` 也認 `type=invite`。

### Email 預先佔用(2026-09-28 已處理)

原本:任何人都能自助註冊成老闆,再邀請一個「還沒註冊」的 email;對方之後自己去註冊、點完確認信回到
`/register/complete`,那一頁看到已有 `restaurant_accounts` 就直接導進 `/restaurant` —— 落進邀請者的店。
現在邀請是「待接受」,`/register/complete` 只認已接受的列,受邀者一定會先看到接受/拒絕畫面(見上一節)。

### 寄信用哪個 SMTP、頻率限制

邀請信是 **Supabase Auth 自己寄的**(模板在 Dashboard → Authentication → Email Templates → Invite user,
主旨「iFoodmap 邀請你加入」),不是 `notify-lead` 那條 Resend API:

| 設定 | 值(2026-09-28 從 Management API `config/auth` 讀到) |
|---|---|
| SMTP | `smtp.resend.com:465`,user `resend`(密碼是一把 Resend API key) |
| 寄件人 | `iFoodmap 食材地圖 <noreply@ifoodmap.ai>`(2026-09-29 從 gathertaiwan.com 換過來,見「寄件網域」) |
| `rate_limit_email_sent` | **每小時 100 封,全專案共用**(邀請、忘記密碼、註冊確認信都算在一起) |
| `smtp_max_frequency` | 同一個收件人 20 秒內只寄一封 |
| 邀請連結效期 | `mailer_otp_exp` = 3600 秒 |

因為是自訂 SMTP,Supabase 預設 SMTP 那個「每小時 2 封」的限制不適用。Resend 帳號本身的方案額度
(若是免費方案也有每日上限)沒有辦法從這邊確認,要去 Resend 後台看。
寄信是同步的:函式回 200 代表 Resend 已經收下這封信(實測約 6 秒)。

## 採購單簽核與 order_pipeline 權限(2026-09-29,migration 20260928190000 / 190100 / 190200 / 190300)

- **190000 `restaurant_draft_approval`**:`order_events` 的 BEFORE INSERT trigger `guard_order_submission`。「送出類」事件(目標是 submitted,或把 draft/cancelled 推往其他狀態)只放行平台管理員、系統(service_role 或沒有 JWT)、該店**已接受且啟用中**的老闆/店長;其他人回 42501。`supplier_orders` 的 INSERT policy:直接建 submitted 只限老闆/店長,其他人只能建 draft。
- **190100 `restaurant_order_update_guard`**:`supplier_orders` 的 BEFORE UPDATE trigger:任何人都不能改 `restaurant_id`(擋「A 店採購員兼 B 店老闆」把單搬來搬去);採購員只能改草稿,也不能自己填 `approved_by` / `approved_at`。
- **190200 / 190300 `order_pipeline`**:這個 view 原本會繞過 RLS 而且可寫(7 月起未登入者可讀進行中訂單的金額、可經由它寫入)。改成 `security_invoker`,anon 無任何權限,authenticated 只能 SELECT。
- 兩支 trigger 都只做唯讀查詢、不取列鎖,沒有改變既有的鎖順序。
- **rollback 一定要照順序**:`190300 → 190200 → 190100 → 190000`(`supabase/rollbacks/*.down.sql`)。順序反了,190000 那支會直接報錯擋下。
- 驗證:`supabase/tests/database/restaurant_draft_approval.test.sql`(72 項,在正式庫一律包在 BEGIN…ROLLBACK 裡跑)。

## 訂單狀態機與通知信閘門(2026-09-29,migration 20260929100000 / 100100 / 100200 / 100300、notify v8)

- **100000 `order_transition_rules`**:`order_transition_rules()` 列出 85 條允許的 (from, to, 角色) 轉移;`trg_guard_order_transition`(字母序排在 `trg_guard_order_submission` 之後)檢查每筆 order_events:身分必須名副其實(老闆/店長/採購員看 `restaurant_role()`、供應商看該單供應商的啟用帳號、管理員看 `is_admin()`、系統 = 沒有登入者且是 service_role 或沒有 JWT);`actor_id` 一律改寫成 `auth.uid()`;前端的 from_status 與目前狀態不同就擋(畫面過期,P0001),轉移不在表內就擋(42501)。同一個 INSERT 同一張單只能寫一筆事件。前端 `src/lib/orders.ts` 的 `TRANSITIONS` 與 SQL 逐條一致,vitest 會解析 migration 比對。
- **100100 `order_event_side_effects`**:派單寫 supplier_id、報價寫 total_amount 並留報價紀錄、出貨新增出貨紀錄,都和狀態在同一個交易。
- **100200 `order_integrity_hardening`**:送出後只有管理員/系統能直接改供應商與金額;建單不能帶供應商;供應商不能直接寫出貨紀錄、報價只能新增。派單與出貨先鎖供應商再鎖訂單(與刪供應商同順序)。
- **100300 `shipment_receipt_columns`**:餐廳對出貨紀錄只能回填收貨三欄。
- **rollback 順序**:`100300 → 100200 → 100100 → 100000`(`supabase/rollbacks/*.down.sql`,有順序保護)。驗證:`supabase/tests/database/order_transition_rules.test.sql`(172 項)、`order_integrity_hardening.test.sql`(37)、`shipment_receipt_columns.test.sql`(14),在正式庫一律包在 BEGIN…ROLLBACK。
- **通知信閘門**:notify 在 secret `NOTIFY_LIVE` 不等於字串 `"true"` 時,把同一種收件對象合併成一封寄到 ifoodmaptw@gmail.com,主旨加「[測試轉寄]」,內文列出原收件人。**目前刻意沒設 NOTIFY_LIVE**(正式庫有真實的供應商信箱)。要對真實餐廳/供應商開放時,由業主同意後 `supabase secrets set NOTIFY_LIVE=true --project-ref cwvpehqcvbfuynabpqop`(改 secret 會讓所有 function 重新部署一次)。
- 訂單編號一律用 `src/lib/order-number.ts` 的 `formatOrderNo`(「#」+ 末 8 碼大寫),notify 也直接引用它。

## 取消、逾時排程、報價後鎖品項、收貨/爭議 RPC(2026-09-29,migration 20260929110000 / 110100 / 110200、notify v9)

- **110000 `order_cancel_requote_rules`**:管理員取消一定要填原因(空白會被擋,22023),原因寫進事件 note;老闆不能取消待出貨以後的單。
  「退回重新報價」採購員不能做、一定要原因,退回後金額清空、舊報價標成 rejected,供應商可以重新報價。
  **報價後鎖品項**:待確認起老闆改品項會被擋(`order_items_locked`),管理員可以改。轉移規則共 102 條,前端 `TRANSITIONS` 由 vitest 逐條比對。
- **110100 `expire_stuck_orders`**:pg_cron 每天 19:00 UTC(台北 03:00)把卡住的單標成 expired(事件身分 = 系統、來源 cron)。
  時限跟 `ORDER_STATUS.slaHours` 一樣(vitest 比對):待接單 / sent / 待報價 24 小時,待確認 / 待出貨 48 小時。
  **不會自動逾時**:已出貨以後(含運送中、待收貨,只由管理員處理)、待派發(平台自己的待辦)、收貨有差異、爭議中。
  每張單 `FOR NO KEY UPDATE SKIP LOCKED`,有人正在處理就跳過,鎖到後會重新確認時限。
  查執行紀錄:`select * from cron.job_run_details order by runid desc;`(runid 1 是上線當天的驗證執行,刻意保留)。
  ⚠️ 單張失敗只記在函式回傳值,cron 紀錄照樣顯示 succeeded。
- **110200 `order_receipt_dispute_rpc`**:確認收貨 / 回報異常 / 申請爭議改成 RPC(SECURITY INVOKER),先寫事件再寫子表,畫面過期整筆回滾;
  兩人同時操作時後到的人會拿到「畫面過期」。`admin_delete_order` 改成先鎖訂單再刪子表(舊版會跟收貨互鎖)。
- **部署順序**:notify v9 → 110000 → 110100 → 110200 → 前端。**還原順序**:110200 → 110100 → 110000(`supabase/rollbacks/*.down.sql`);
  還原 110200 之前要先把前端退回舊版(新前端會呼叫這支 RPC)。
- 驗證(正式庫一律包在 BEGIN…ROLLBACK):`order_transition_rules.test.sql`(189)、`order_cancel_requote.test.sql`(51)、
  `order_expiry.test.sql`(27)、`order_receipt_dispute_rpc.test.sql`(39)。
- 🔴 **開 `NOTIFY_LIVE` 之前要先決定**:訂單逾時、以及從逾時取消,要不要寄信給原供應商?目前兩種都不寄,靠管理員打電話
  (取消對話框會提醒管理員另外聯絡供應商)。

## AI 防濫用與註冊導流(2026-10-07,migration 20261007100000 / 100100 / 100200、Edge Function `ai`)

形象站 ifoodmap.ai 的 AI 對話免註冊就能用、聊完導去註冊;註冊後剛剛聊的需求自動變成採購單草稿。
原本 `ai` 沒有身分驗證、限流、字數或輸出上限(任何人都能繞過網站直接打),這次一起補上。

**呼叫者分三級**(`supabase/functions/ai/guard.ts`,純邏輯,vitest:`guard.test.ts`、`crypto.test.ts`):

| tier | 判定 | 可用 action |
|---|---|---|
| landing | header `x-ifm-proxy-secret` = secret `IFM_AI_PROXY_SECRET`(常數時間比較;secret 沒設永不成立) | chat、analyze-menu、analyze-chat |
| user | `Authorization: Bearer <使用者 access token>`,`auth.getUser` 驗得過(anon key、匿名使用者不算) | 全部 |
| legacy | 以上皆非,且 `AI_ENFORCE_AUTH` ≠ `"1"`(過渡期相容舊前端) | 全部 |
| 拒絕 | 以上皆非,且 `AI_ENFORCE_AUTH` = `"1"` | 401 `UNAUTHORIZED` |

- 額度(每天 = 台北日):landing / legacy 以 IP 計(IP 只以 `HMAC-SHA256(IFM_AI_PROXY_SECRET, ip)` 前 16 hex 落地;
  **IPv6 一律取 /64、IPv4 用完整位址**)—— chat 20 次/10 分、60 次/天;analyze-menu 5/10 分、10/天;analyze-chat 10/天;
  legacy 的其他 action 5/10 分、20/天(契約沒寫,自訂)。兩級的個人額度數字一樣,但 bucket 分開。
  **全站每天的上限兩級分開計、各自封頂**:landing chat 500、analyze-menu 100、analyze-chat 200;legacy chat 100、analyze-menu 20、analyze-chat 40、其他 100
  (legacy 的 IP 取自 `x-forwarded-for` 第一段、可以偽造;分開之後燒光 legacy 的額度也鎖不到形象站的真訪客)。
  user tier 全部 action 合計 60/10 分、200/天,不佔全站額度。
- 字數:landing / legacy 最新一則 300 字、送給 Gemini 的歷史最後 20 則且 ≤ 4,000 字;user tier 2,000 字、歷史 ≤ 12,000 字。
  圖片與 body:landing jpeg/png/webp ≤ 1.5 MB、body ≤ 2.5 MB;**legacy 跟 user tier 一樣**(任何 image/* ≤ 10 MB、body ≤ 15 MB,
  過渡期還開著的舊產品站分頁才不會被擋)。
- 存進 `analysis_records` 的 `messages` / `transcript` 是**完整對話**(不含圖片、每則照上面的字數截斷、最多 40 則);只有送給 Gemini 的才照上面截斷。
- 形象站同一段對話只有一筆:analyze-chat 與 analyze-menu 帶 `analysisId` + `claimToken`(驗證通過)就併進那一筆 ——
  食材以名稱去重合併、菜單照片附加到 `images`(同一筆最多 3 張);更新帶 `updated_at` 樂觀鎖,同時兩個請求改同一筆時後到的會重查再併。
- 輸出上限(思考 token 也算在裡面):chat 400 token(不思考)、analyze-chat 1024(不思考)、analyze-menu 4096(思考預算 512)、其他 4096(思考 1024)。
  analyze-menu 原本定 2560:2026-07-28 實測大菜單輸出到 1,703 token,扣掉思考只剩約 20% 餘裕,超過會截斷成壞掉的 JSON,所以調成 4096。
- 最壞成本(每一次都打滿字數與輸出上限,以 Gemini 2.5 Flash 公告價估:輸入 US$0.30/1M、輸出含思考 US$2.50/1M,
  同 `src/pages/admin/aiCost.ts`;中文以 1 字 ≈ 1 token 從寬估,菜單照片輸入以 2,000 token 計,實測約 451):
  形象站(landing)全站每天 chat 500 次 ≤ US$1.40、analyze-chat 200 次 ≤ 0.80、analyze-menu 100 次 ≤ 1.11(上限還是 2560 時 0.72)
  → **合計 ≤ 約 US$3.3/天(約 US$100/月)**。
  相容模式期間 legacy 另外封頂:chat 100 次 ≤ 0.25、analyze-chat 40 次 ≤ 0.16、analyze-menu 20 次 ≤ 0.22、其他 100 次 ≤ 1.34 → ≤ 約 US$2.0/天
  (兩級分開計,所以相容模式期間合計上限是 ≤ 約 US$5.3/天;開了強制模式 legacy 就沒了)。
  登入使用者每個帳號每天最多 200 次:chat ≤ US$0.95、analyze-menu ≤ 2.19,最壞(每次都是 6 萬字的 dish-ideas / quote-draft)≤ 5.68。
- 菜單照片存進 `analysis_records.images` 每天有總量(三級分開:landing 20 MB、legacy 20 MB、登入使用者 40 MB);超過時紀錄照存、只是不存圖
  (`ai_guard_daily` 記 `IMAGE_NOT_STORED`)。
- 錯誤一律 `{ code, message, retryAfterSeconds? }`,429 另帶 `Retry-After`;形象站與舊前端拿不到 Gemini 原始錯誤。
- 形象站(landing tier)的 chat 用 `landing-prompt.ts`(四題訪談 → 導「免費註冊」、Email 為輔、`[[DONE]]` / `[[END]]` 由伺服器轉成 `stage`;
  英文版另外接上 `LANDING_EN_BUTTONS`,按鈕名稱照英文網站寫「Sign up free」。按鈕文字以 `landing/i18n.js` 的 `ctaRegister` / `ctaEmail` 為準,改了要一起改);
  **產品站登入後(與 legacy)的 `CHAT_SYSTEM` 一字未改**。
- 資料庫:
  - **100000 `ai_rate_limits`**:`ai_usage` 加 `tier`、`thoughts_tokens`;計數表 `ai_rate_counters` + 原子化 RPC `ai_rate_take`(只給 service_role;
    `INSERT … ON CONFLICT` 鎖列計數,任何一條超過就整批退回、不吃額度);被擋統計 `ai_guard_daily` + `ai_note_rejection(p_tier, p_action, p_code, p_hits)`;
    pg_cron `ifoodmap-ai-guard-cleanup`(19:40 UTC = 台北 03:40)清 2 天前的計數、90 天前的統計。
  - **100100 `landing_analysis_claim`**:`analysis_records` 加 `claim_token_hash`(DB 只存 sha256 hex)、`claimed_at`、`claimed_restaurant_id`、`claimed_order_id`;
    認領 RPC `claim_landing_analysis(p_handoff text, p_restaurant_id uuid default null)`(只有這一個兩參數版本,只給 authenticated):
    有帶 `p_restaurant_id`(產品站一律帶畫面上那家店)→ 呼叫者必須是那家店已接受、啟用中的成員,branch 取自那筆成員資格,否則 `no_restaurant`;
    沒帶 → 最近接受的那家。驗證通過就建一張 `status='draft'` 的 `supplier_orders`(不送出、不寫事件)。
  - **100200 `lead_guards`**:`landing_leads` 加 `contact_email`;兩張 lead 表的長度檢查與 Email 格式;landing_leads 至少要有電話、Email、LINE 其中一種
    (產品站 ContactGate 允許只留 LINE);同 Email / 電話 / LINE 24 小時 ≥ 3 筆、或全表 24 小時 ≥ 100 筆(異業合作:同 Email ≥ 3、全表 ≥ 50)
    → `LEAD_RATE_LIMITED`(PostgREST 400)。長文字(品項、補充說明、合作訊息、瀏覽器)超過上限是截斷、不是擋。
    **Email 規則全站一字不差**(DB constraint、notify-lead 的 reply-to、形象站 widget、異業合作表單):
    長度 ≤ 254 且符合 `^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$`(擋掉 `a@b..c`、結尾逗號 / 分號、空白、一次多個地址)。
    2026-10-07 查:partnership_leads 0 筆、landing_leads 9 筆(還沒有 Email 欄位),沒有不符合的既有資料,constraint 都 VALIDATE 得過。
- **notify-lead(業主的 lead 通知信)一起改**:`contact_email` 在信裡標成「Email」(排在店名後面);沒留名字時主旨用 Email
  (順序 店名 → Email → 電話 → LINE);Email 格式有效時設成 reply-to(業主直接回信就是回給訪客;異業合作表單的 reply-to 也改成格式有效才設,
  格式不對就不設、照樣寄)。規則在 `notify-lead/lead-email.ts`(vitest 會檢查跟 migration 的 regex 一字不差);
  Resend 回 4xx 而且信上有 reply_to 時,拿掉 reply_to 重寄一次。收件人、`LEAD_NOTIFY_TO`、寄件網域、供應商入駐申請的寄信與閘門都沒動。
- 驗證:2026-10-07 在正式庫 BEGIN…ROLLBACK 乾跑三支 migration + 97 項檢查全過(認領的各種結果含指定 / 不指定店家、別人的店、pending 成員;
  草稿過得了 guard / 狀態機;合併用的 UPDATE 與樂觀鎖;anon / authenticated 執行不了限流 RPC;lead 限流、長度、ContactGate 只留 LINE 的 payload、
  16 種壞 Email;既有資料全部符合新 constraint),事後查證沒有殘留。

### 兩個新 secret

- `IFM_AI_PROXY_SECRET`:形象站代理與 `ai` 共用的密鑰。**Supabase secret 與 Vercel `ifoodmap-landing` 專案的 env 要設同一個值**
  (Production;要讓 preview 部署在強制模式下也能用 AI,Preview 也要設)。沒設 = landing tier 永不成立(形象站會落到 legacy)。
- `AI_ENFORCE_AUTH`:`"1"` = 強制模式(沒有合法身分一律 401);沒設 = 相容模式。**只有字串 `1` 才算**。

### 部署順序(一定照這個順序)

先讓新前端帶上身分、再換 ai:新前端遇到舊版 ai(不回 `stage` / `claimToken`、錯誤沒有 `code`)會退化成舊行為;
ai 換上去的那一刻兩站已經在帶身分,不會有「舊形象站代理不轉發訪客 IP、所有訪客共用一個出口 IP 額度」的空窗。

1. **migration**(依序 100000 → 100100 → 100200,用上面「寫了新 migration 之後」的方式逐支套,再補 ledger):
   ```sql
   insert into supabase_migrations.schema_migrations (version, name) values
     ('20261007100000', 'ai_rate_limits'),
     ('20261007100100', 'landing_analysis_claim'),
     ('20261007100200', 'lead_guards')
   on conflict (version) do nothing;
   ```
   套完確認:`select jobname, schedule from cron.job;` 有 `ifoodmap-ai-guard-cleanup`;
   `select conname, convalidated from pg_constraint where conname like '%leads_%' and contype = 'c';` 應全部 `true`
   (若有 `false` 代表當下有舊資料不符合,新寫入仍會檢查,不影響部署)。
   新函式要等 PostgREST 重新載入 schema 才叫得到;之後若 `ai_rate_take` / `claim_landing_analysis` 回 404(`PGRST202`),跑一次 `notify pgrst, 'reload schema';`。
   **notify-lead** 在 migration 之後就可以部署(跟 ai 的順序無關;沒有 contact_email 的舊資料照常寄):
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy notify-lead --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
   ```
   (2026-10-07 以 `GET /v1/projects/cwvpehqcvbfuynabpqop/functions/notify-lead` 查:v6、`verify_jwt: false`,跟 `supabase/config.toml` 一致;
   它靠 `LEAD_HOOK_SECRET` 驗證 DB trigger 的呼叫,**一定要帶 `--no-verify-jwt`**,部署後再 GET 一次確認還是 false。)
2. **Supabase secret**(值不要印出來,下一步 Vercel 要用同一個;這時線上還是舊版 ai,不會讀它 —— 改 secret 只會讓各 function 用現有程式重啟一次):
   ```bash
   IFM_AI_PROXY_SECRET=$(openssl rand -hex 32)
   SUPABASE_ACCESS_TOKEN=sbp_... supabase secrets set IFM_AI_PROXY_SECRET="$IFM_AI_PROXY_SECRET" --project-ref cwvpehqcvbfuynabpqop
   ```
3. **Vercel**:`ifoodmap-landing` 專案設 env `IFM_AI_PROXY_SECRET`(同第 2 步的值;Production,要讓 preview 也能用就 Preview 也設)。
   env 在部署時才帶進 function,**一定要在第 4 步建置之前設好**。
4. **push 前端**(形象站 + 產品站同一個 push),等 `landing-deploy.yml` 與 `deploy-vercel.yml` 兩邊都部署完。
   這時新前端對的是舊版 ai:形象站沒有 `stage` / `claimToken`(註冊不帶 handoff)、產品站多帶的 Bearer 會被舊版 ai 忽略 —— 都是預期中的退化。
5. **部署 ai**(`AI_ENFORCE_AUTH` 先不要設 = 相容模式;本機沒有 Docker,所以 `--use-api`,`guard.ts` / `crypto.ts` / `landing-prompt.ts` 會一起上傳):
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_... supabase functions deploy ai --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
   ```
   部署後 `GET https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/functions/ai` 確認 `verify_jwt: false`(打開會讓形象站全部 401)。
6. **確認兩站都帶了身分**(兩站各實際用一次 AI 之後):
   ```sql
   select tier, action, count(*), max(created_at)
   from public.ai_usage where created_at > now() - interval '1 hour'
   group by 1, 2 order by 1, 2;
   ```
   要看到 `landing`(形象站)與 `user`(產品站)。ai 換上去之後還出現的 `legacy` = 還開著舊分頁的訪客,會自己消失;
   一直有、或兩站有一邊沒出現,就先停在這步查(function log 裡 `[ai] ai_rate_take failed` / `auth.getUser failed` 是限流或驗證出問題)。
7. **開強制模式**:`supabase secrets set AI_ENFORCE_AUTH=1 --project-ref cwvpehqcvbfuynabpqop`
8. **確認直打被擋、兩站正常**:
   ```bash
   # 沒有身分 → 401(在讀 body 之前就擋掉,不會呼叫 Gemini、不花錢)
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/ai \
     -H "apikey: <anon key>" -H "Content-Type: application/json" -d '{"action":"chat","messages":[{"role":"user","text":"hi"}]}'
   ```
   再到兩站各用一次 AI;`ai_guard_daily` 會出現 `tier = 'none'`、`code = 'UNAUTHORIZED'` 的計數。

### 怎麼查擋了多少

```sql
-- 每天被擋的請求(day = 台北日期;tier none = 強制模式下沒有身分)
-- RATE_LIMITED / DAILY_CAP / IMAGE_NOT_STORED 是 DB 端逐筆記的精確值;
-- UNAUTHORIZED、TOO_LONG、BODY_TOO_LARGE、ACTION_NOT_ALLOWED、UNSUPPORTED_IMAGE、IMAGE_TOO_LARGE、CONVERSATION_LIMIT 是 Edge Function
-- 在記憶體累計、每個 isolate 最多每 60 秒寫一次的「近似值」(isolate 被回收前沒寫到的會少算,只會少、不會多)
select day, tier, action, code, hits from public.ai_guard_daily order by day desc, hits desc;

-- 今天誰用得最兇(IP 只有 HMAC,看不出原始 IP;user: 後面是 user id)
select bucket, window_start, hits from public.ai_rate_counters
where window_start >= now() - interval '1 day' order by hits desc limit 20;

-- 用量與思考 token(thoughts_tokens 跟輸出 token 同價;/admin/ai-ops 的成本估算還沒算進去)
select tier, action, count(*), sum(prompt_tokens), sum(completion_tokens), sum(thoughts_tokens)
from public.ai_usage where created_at > now() - interval '7 days' group by 1, 2 order by 1, 2;

-- 清理排程的執行紀錄
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'ifoodmap-ai-guard-cleanup') order by runid desc limit 5;
```

### 還原順序

1. **先退回相容模式**(最輕、立即生效):`supabase secrets unset AI_ENFORCE_AUTH --project-ref cwvpehqcvbfuynabpqop`
2. **退回舊版 ai**:舊版程式在 `62d342e`(`git -C /Users/aimand/.gemini/File/ifoodmap show 62d342e:supabase/functions/ai/index.ts`),
   從那個 commit 的 checkout 用同一行指令部署(`--no-verify-jwt --use-api`)。舊版 ai 跟新的資料庫相容(新欄位都可為 NULL,不碰新表);
   新前端拿不到 `claimToken` / `stage` 時會退化成舊行為。notify-lead 要退也一樣從 `62d342e` 部署(`--no-verify-jwt --use-api`;
   舊版只是把 `contact_email` 顯示成欄位名、不設 reply-to)。
3. **前端**:需要時 Vercel Instant Rollback(兩個專案)。🔴 產品站會呼叫 `claim_landing_analysis`,**要先退掉產品站的新版**才能做第 4 步。
4. **資料庫**(只有在第 2、3 步都完成之後;順序 100200 → 100100 → 100000;各支包在 BEGIN … COMMIT 裡跑)。
   原則:**只拆行為(trigger、constraint、函式、排程),不丟資料** —— 留下的欄位舊版程式都不會碰,之後重新套用 migration 也是冪等的:
   ```sql
   -- 100200 lead_guards:只拆 trigger 與 constraint;landing_leads.contact_email 欄位與已經收到的 Email 保留
   drop trigger if exists trg_landing_leads_guard on public.landing_leads;
   drop trigger if exists trg_partnership_leads_guard on public.partnership_leads;
   drop function if exists public.landing_leads_guard();
   drop function if exists public.partnership_leads_guard();
   alter table public.landing_leads drop constraint if exists landing_leads_contact_email_format,
     drop constraint if exists landing_leads_has_contact, drop constraint if exists landing_leads_field_lengths;
   alter table public.partnership_leads drop constraint if exists partnership_leads_contact_email_format,
     drop constraint if exists partnership_leads_field_lengths;
   -- (landing_leads_created_at_idx / partnership_leads_created_at_idx 兩個 index 留著無妨)

   -- 100100 landing_analysis_claim:拿掉認領 RPC(只有這個兩參數的簽名)與格式檢查;
   -- 認領紀錄的 4 個欄位留著(已建出的採購單草稿不受影響,後台還查得到是從哪段對話來的)
   drop function if exists public.claim_landing_analysis(text, uuid);
   alter table public.analysis_records drop constraint if exists analysis_records_claim_token_hash_format;

   -- 100000 ai_rate_limits:排程用 jobid 取消(排程不存在時不會報錯);計數表與被擋統計是營運資料,直接拿掉
   select cron.unschedule(jobid) from cron.job where jobname = 'ifoodmap-ai-guard-cleanup';
   drop function if exists public.ai_rate_take(text, text, jsonb);
   drop function if exists public.ai_note_rejection(text, text, text, integer);
   drop function if exists public.ai_guard_cleanup();
   drop table if exists public.ai_rate_counters;
   drop table if exists public.ai_guard_daily;
   -- ai_usage.tier / thoughts_tokens 留著(舊版 ai 不寫這兩欄,之後的列會是 NULL)

   delete from supabase_migrations.schema_migrations where version in ('20261007100000', '20261007100100', '20261007100200');

   -- 只有在確定要連資料一起丟掉時才另外跑(先匯出):
   -- alter table public.analysis_records drop column if exists claimed_order_id, drop column if exists claimed_restaurant_id,
   --   drop column if exists claimed_at, drop column if exists claim_token_hash;
   -- alter table public.ai_usage drop column if exists thoughts_tokens, drop column if exists tier;
   -- alter table public.landing_leads drop column if exists contact_email;
   ```
   還原資料庫之後,repo 裡的三支 migration 也要一起 revert,否則 `check-migrations` 會一直紅。
