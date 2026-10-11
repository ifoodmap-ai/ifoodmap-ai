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

## 消費者食材市集 B2C(2026-10,migration 20261009120000 / 120100)

設計:`docs/plans/2026-10-09-consumer-market-design.md`;實作計畫:`docs/plans/2026-10-09-consumer-market-plan.md`(計畫原文跟檔尾「勘誤」不一樣時,以勘誤與 repo 為準)。
一般消費者在產品站 `https://app.ifoodmap.ai/market` 免登入逛供應商的零售商品;供應商在後台開放零售、管理員審核後才上架。第 1 階段還不能下單(購物車、結帳、訂單在第 2 階段)。
跟餐廳的詢價訂單(`supplier_orders` / `order_events`)完全分開,資料表、函式、bucket 一律 `market` 開頭。

| 誰 | 在哪裡 |
|---|---|
| 消費者(免登入) | 產品站 `/market`、`/market/p/<商品 id>`、`/market/s/<供應商 id>` |
| 供應商 | 產品站「零售市集 › 店家設定」`/supplier/market/store`;「商品與價格 › 商品目錄」`/supplier/catalog` 的「零售商品(給消費者)」分頁,與批發商品那一列的「開放零售」 |
| 管理員 | 管理員站「零售市集 › 商品審核」`/admin/market/products`、「零售店家」`/admin/market/stores`(只在管理員站的 build 裡) |

- **120000 market_catalog**
  - `market_stores`(PK = supplier_id):零售啟用(`is_enabled`,只有管理員能改、停用要填原因)、logo / 封面 / 介紹 / 退換貨說明、
    配送縣市(22 縣市,一律用「臺」,清單在 `market_tw_cities()`)、固定運費、免運門檻、最低訂購金額、出貨天數、付款方式(`cod` / `transfer`)。
  - `market_store_transfer`:轉帳資訊,獨立一張表 —— anon 讀不到(第 2 階段只在「待匯款」時經查單 RPC 給那位消費者)。
  - `market_products`:零售商品。`review_status` = draft / pending / approved / rejected;已核准的商品改了品名、分類、規格、溫層、產地、
    保存方式、保存期限、說明、照片 → guard 自動改回 pending;改價格、庫存、上架開關不用重審。退回 / 下架要填原因(`reject_reason`)。
  - 權限:anon 只讀「已核准 + 上架中 + 店家零售啟用 + 供應商啟用中」(`market_store_is_open()`);管理員(`is_admin()`)全部。
    供應商用 `current_supplier_ids()` 管自家:店家只能讀 / 建 / 改、**不能刪**(刪掉再重建就能洗掉管理員的停用),轉帳資訊與商品可以刪。
    資料表權限先 `REVOKE ALL`(含 PG17 的 `MAINTAIN`)再給需要的:anon 只有店家、商品的 `SELECT`;authenticated 三張表 `SELECT / INSERT / UPDATE / DELETE`(細分靠 RLS)。
  - guard trigger 在伺服器端決定,前端只是顯示:
    - 供應商只能設 draft / pending(設 approved / rejected → 42501 `review_status_forbidden`);`reviewed_by` / `reviewed_at` / `submitted_at` / `created_at`
      由伺服器填,自己帶的值會被蓋掉;非管理員改 `is_enabled` / `disabled_reason` 會被還原成原值。
    - 替別家新增店家或商品 → 42501(guard 比 RLS 先跑,先擋才不會洩漏別家有沒有轉帳資訊);亂塞的超長輸入(任一文字欄位超過 10000 字、照片超過 50 張)→ 23514。
    - 品名、規格去掉頭尾空白(連全形空白、零寬字元一起去,`market_trim`)之後看不到任何字(`market_visible`)→ 23514。
    - 🔴 **商品照片只收小寫 `.jpg`**:`photos` 每一張都要是 `<supplier_id>/<商品 id>/<uuid>.jpg`,`.png` / `.webp` / `.jpeg` / `.JPG` 一律 22023 `invalid_photo_path`
      (前端本來就全部壓成 JPEG;限定之後,資料庫推出的縮圖 `<uuid>_t.jpg` 才會跟前端顯示的是同一張)。
      店家 logo / 封面(`<supplier_id>/store/`)不在 `photos` 裡,仍收 jpg / jpeg / png / webp。
    - 🔴 **核准前照片必須都上傳**:管理員核准(含直接建成已核准)、或已核准的商品改了照片時,每張照片的主圖 `<uuid>.jpg` **和**縮圖 `<uuid>_t.jpg`
      都要已經在 `market-images`,缺一張就 22023 `photos_not_uploaded`(訊息帶第一個缺的檔名)。只在這兩種情況檢查 —— 改價格、庫存不檢查,
      所以管理員事後從 Storage 刪掉違規圖,不會讓這些操作失敗。用 Dashboard 手動放照片測試時,主圖和縮圖兩張都要放。
    - **管理員停用店家不受轉帳檢查影響**:「接受轉帳要先有轉帳資訊」(22023 `transfer_info_required`)只在供應商建店、或供應商的更新改了付款方式
      (去重排序後有變)而且含轉帳時才檢查;管理員的更新(停用、啟用、改停用原因)一律不檢查。供應商可以自己刪掉轉帳資訊,每次都檢查的話,管理員就停用不了那家店;
      付款方式含轉帳、轉帳資訊卻沒了的店,第 2 階段結帳本來就不能選轉帳。
- **120100 market_images_storage**:bucket `market-images`(公開讀取、單檔 ≤ 2 MB、只收 jpeg / png / webp、版本功能 `versioning_status` = `DISABLED`)。
  路徑 `<supplier_id>/<商品 id 或 store>/<uuid>.<副檔名>`(縮圖 `<uuid>_t.<副檔名>`);`storage.objects` 只有 2 條 policy
  (`market images supplier select / insert`,authenticated):只准該供應商的成員(第一層資料夾 ∈ `current_supplier_ids()`)上傳到自己資料夾、列自己的檔。
  🔴 **物件只能寫一次**:沒有 UPDATE / DELETE policy —— 不能覆寫(x-upsert 被拒)、不能刪,管理員也一樣(管理員沒有任何 storage policy)。
  不這樣的話,已核准的照片可以換掉內容,商品卻不會回到待審。「只能寫一次」的前提是 bucket 不開版本,所以 migration 明寫 `DISABLED`,之後也不要替這個 bucket 打開。
  前端(`src/lib/market/images.ts`)上傳前在瀏覽器壓成長邊 1600px 的 JPEG(縮圖 480px),一律 `upsert: false`、`cacheControl` 一年;
  換照片不刪舊檔,舊檔留在 bucket 成為孤兒檔(量大了再用 Storage API 清,本次不做)。
  🔴 storage 的檔案**不能用 SQL 刪**(`storage.protect_objects_delete`),要刪檔、刪 bucket 用 Storage API 或 Dashboard(見最後的「違規圖片怎麼刪」)。
- **測試**:`supabase/tests/database/market_*.test.sql`,用 `scripts/supabase-sql.mjs dry` 在正式庫 BEGIN…ROLLBACK 乾跑
  (用法見檔案開頭;共用工具 `_market_helpers.sql`;漏網的 COMMIT 另有伺服器端保險擋),**每次**乾跑之後都跑 `market_residue.sql`(唯讀)確認沒有殘留,五個數字都要是 0。
  項數:`market_harness` 5、`market_catalog` 112、`market_catalog_rollback` 3、`market_images_storage` 20、`market_images_storage_rollback` 3
  (`market_images_storage` 上線時是 19 項;2026-10-10 Supabase 自動更新 Storage schema 之後測試改寫、多一項,commit `c261a85`)。
  2026-10-10 上線前實測(`market` 分支 `440ac4b`):五支乾跑全過、每次殘留都是 0;vitest 連跑 3 次都是 99 檔 / 1544 項全過;
  tsc 錯誤 72、eslint 錯誤 10(跟開工前的基準一樣);兩種 build 都過;形象站 `npm test` 211 項全過(這個階段沒改 `landing/`)。

### 部署(第 1 階段)

🔴 會改正式庫、會部署兩個網站。照順序做,任何一步的 Expected 對不上就停下來回報(附上指令與完整輸出),不要自己想辦法繞過。
**migration 先上線,前端才 push**:供應商後台的商品目錄頁會讀 `market_products`、上傳照片要 bucket 與 policy;舊前端完全不碰 `market_*`,先套 migration 不影響線上。
下面每一段都在 repo 根目錄跑、各自 export token(`<token 檔>` 見實作計畫「執行前必讀」B 節)。🔴 token 不要印出來;`supabase-sql.mjs` 送出前會驗格式,錯誤訊息裡的 token 一律遮成 `***`。
查詢用 `printf '%s\n' "…" > "$Q"` 寫進暫存檔再交給 `ro`(不用 heredoc:這裡的指令在清單裡有縮排,照原樣複製時 heredoc 的結尾那一行會對不上)。

1. **確認本機乾淨、跟 origin 同步**:
   ```bash
   git -C /Users/aimand/.gemini/File/ifoodmap switch market
   git -C /Users/aimand/.gemini/File/ifoodmap status --short
   git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
   git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count market..origin/main
   git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count origin/main..main
   ```
   Expected:`status` 沒有輸出;兩個 `rev-list` 都印 `0`。第一個不是 0 = origin/main 上有 `market` 沒有的新 commit(別人推的);
   第二個不是 0 = 本機 main 有還沒推的 commit。**兩種都停下來回報,不要自己 rebase / merge。**
2. **上線前最後一次乾跑**(第 1 階段全部;每支乾跑之後都跑一次殘留檢查):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   C=supabase/migrations/20261009120000_market_catalog.sql
   S=supabase/migrations/20261009120100_market_images_storage.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_harness.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql --with-migration $C
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-migration $C --with-rollback supabase/rollbacks/20261009120000_market_catalog.down.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql --with-migration $C --with-migration $S
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage_rollback.test.sql --with-migration $C --with-migration $S --with-rollback supabase/rollbacks/20261009120100_market_images_storage.down.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:依序 `共 5 項` / `共 112 項` / `共 3 項` / `共 20 項` / `共 3 項`,全部 `失敗 0 項`;每次殘留的 `fixture_users`、`fixture_suppliers`、`fixture_objects`、
   `test_queue_rows`、`test_config_rows` 都是 `0`。(`market_catalog` 有兩項是寬鬆的「1 秒內被擋」,正式庫很忙時萬一超過,先重跑一次再判斷。)
3. **套 migration**(先 120000 再 120100;一行一支,前一支成功才跑下一支):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   node scripts/supabase-sql.mjs apply supabase/migrations/20261009120000_market_catalog.sql
   node scripts/supabase-sql.mjs apply supabase/migrations/20261009120100_market_images_storage.sql
   ```
   `apply` 依序做三件事:①用唯讀端點查 ledger(`supabase_migrations.schema_migrations`),版本已經在了就拒送(migration 一個字都不送);
   ②`SET LOCAL lock_timeout` / `statement_timeout` + migration + ledger 的 `INSERT`(不帶 `ON CONFLICT`)放在同一個請求送出 ——
   Management API 一個請求就是一個交易,任何一句失敗就整支回滾、ledger 也不會寫;③讀回 ledger 比對 version / name。**不用另外補 ledger。**
   Expected(各一行):
   ```
   已套用 20261009120000_market_catalog.sql;ledger:[{"version":"20261009120000","name":"market_catalog"}]
   已套用 20261009120100_market_images_storage.sql;ledger:[{"version":"20261009120100","name":"market_images_storage"}]
   ```
   出錯時看訊息:
   - `Management API 4xx/5xx …`(exit 2,例如等鎖逾時 `55P03`):整支已回滾、ledger 沒寫。等幾秒重跑**同一行**
     (工具會先查 ledger:萬一其實已經套上去,第二次會被拒送,所以重跑是安全的)。
   - `拒送:ledger 已經有版本 …`(exit 2):這支已經套過(例如上一次的回應在網路上掉了)。不要想辦法硬套,直接做第 4 步確認。
   - `套用後讀回的 ledger 不符`(exit 1):migration 已經套上去了,**停下來回報,不要重跑**。
   - 120000 成功、120100 失敗:120000 不用還原(前端還沒推,沒人用得到新表),查明原因再套 120100;兩支都成功之前不要推前端。
4. **確認線上 schema**:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
   SELECT json_build_object(
     'ledger', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
                 WHERE m.version IN ('20261009120000', '20261009120100')),
     'tables_with_rls', (SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c
                          WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity
                            AND c.relname IN ('market_stores', 'market_store_transfer', 'market_products')),
     'anon_can_read_products', has_table_privilege('anon', 'public.market_products', 'SELECT'),
     'anon_can_read_stores', has_table_privilege('anon', 'public.market_stores', 'SELECT'),
     'anon_can_read_transfer', has_table_privilege('anon', 'public.market_store_transfer', 'SELECT'),
     'anon_can_write_products', has_table_privilege('anon', 'public.market_products', 'INSERT,UPDATE,DELETE'),
     'anon_can_write_stores', has_table_privilege('anon', 'public.market_stores', 'INSERT,UPDATE,DELETE'),
     'image_bucket', (SELECT json_build_object('public', b.public, 'file_size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types)
                        FROM storage.buckets b WHERE b.id = 'market-images'),
     'image_bucket_versioning', (SELECT b.versioning_status FROM storage.buckets b WHERE b.id = 'market-images'),
     'image_policies', (SELECT count(*) FROM pg_policies p
                         WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname LIKE 'market images %'),
     'image_policy_names', (SELECT json_agg(p.policyname || ' ' || p.cmd ORDER BY p.policyname) FROM pg_policies p
                             WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname LIKE 'market images %')
   ) AS phase1;" > "$Q"
   node scripts/supabase-sql.mjs ro "$Q"
   SUPABASE_PROJECT_REF=cwvpehqcvbfuynabpqop node scripts/check-migrations.mjs
   ```
   Expected(JSON 裡的值):
   - `ledger` = `["20261009120000","20261009120100"]`
   - `tables_with_rls` = `["market_products","market_store_transfer","market_stores"]`
   - `anon_can_read_products`、`anon_can_read_stores` = `true`(列由 RLS 再篩);`anon_can_read_transfer`、`anon_can_write_products`、`anon_can_write_stores` = `false`
   - `image_bucket` = `{"public": true, "file_size_limit": 2097152, "mime_types": ["image/jpeg","image/png","image/webp"]}`
   - 🔴 `image_bucket_versioning` = `"DISABLED"`;`image_policies` = `2`;`image_policy_names` = `["market images supplier insert INSERT","market images supplier select SELECT"]`
   - `check-migrations` 最後一行是 `✅ 沒有落差 —— repo 的 migration 都已套用到線上`(repo 43 個、線上 43 個)。

   除了 `ledger`,這些值 2026-10-10 都在乾跑裡(套上兩支 migration)實測過。新表要等 PostgREST 重新載入 schema 才查得到(120000 最後有 `NOTIFY pgrst`);
   第 8 步若拿到 404 `PGRST205`,照上面「寫了新 migration 之後」的方式送一次 `notify pgrst, 'reload schema';`。
5. **用線上 schema 再跑一次測試**(不帶 `--with-migration`,一樣包在 BEGIN…ROLLBACK),並確認還原檔在線上 schema 跑得動:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   RC=supabase/rollbacks/20261009120000_market_catalog.down.sql
   RS=supabase/rollbacks/20261009120100_market_images_storage.down.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage_rollback.test.sql --with-rollback $RS
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-rollback $RS --with-rollback $RC
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:依序 `共 112 項` / `共 20 項` / `共 3 項` / `共 3 項`,全部 `失敗 0 項`;每次殘留五個 `0`。
   (還原的乾跑會拿三張表的 ACCESS EXCLUSIVE 鎖直到 ROLLBACK,一兩秒;這一步在推前端之前做,還沒有人在用。)
6. **合併 `market` 到 `main`、push**(前端一定在 migration 之後):
   ```bash
   git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
   git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count market..origin/main     # 再確認一次:0(不是 0 就停)
   git -C /Users/aimand/.gemini/File/ifoodmap switch main
   git -C /Users/aimand/.gemini/File/ifoodmap merge --ff-only origin/main            # 本機 main 對齊 origin/main(應該是 Already up to date)
   git -C /Users/aimand/.gemini/File/ifoodmap merge --no-ff market -m "Merge branch 'market':消費者食材市集第 1 階段(上架＋逛店)"
   git -C /Users/aimand/.gemini/File/ifoodmap diff --stat market main                # 沒有輸出 = 要推的就是測過的那份
   git -C /Users/aimand/.gemini/File/ifoodmap push origin main
   git -C /Users/aimand/.gemini/File/ifoodmap rev-parse HEAD                         # 記下合併 commit(等 CI、還原都要用)
   git -C /Users/aimand/.gemini/File/ifoodmap switch market
   git -C /Users/aimand/.gemini/File/ifoodmap merge --ff-only main                   # market 也帶上合併 commit
   ```
   - 用 `--no-ff` 留一個合併 commit:還原時一個 `git revert -m 1 <合併 commit>` 就退掉整個階段(第 3 階段合併 `market-launch` 也是 `--no-ff`)。
     最後把 `market` 快轉到 main:第 2 階段繼續在 `market` 上做,部署時「`rev-list --count HEAD..origin/main` 要是 0」才會過(不快轉的話會是 1)。
   - push 被拒(non-fast-forward)= 這中間有人推了:停下來回報,不要 `--force`、不要 rebase。
   - push 被 403 擋(`denied to aimand2025`):`gh auth switch --user armand-forge` →
     `git -C /Users/aimand/.gemini/File/ifoodmap -c credential.helper='!gh auth git-credential' push origin main` → push 完 `gh auth switch --user aimand2025` 切回。
7. **等 CI**:
   ```bash
   gh run list --repo ifoodmap-ai/ifoodmap-ai --commit <合併 commit>
   gh run watch <run id> --repo ifoodmap-ai/ifoodmap-ai --exit-status
   ```
   Expected:兩條 workflow 都是 `completed success` —— `Deploy Frontend to Vercel`(「資料庫 migration 落差檢查」、dish-to-supply、ifoodmap-admin 三個 job)
   與 `Product CI`(vitest、build (main)、build (admin);「tsc / eslint(只報告)」不擋)。落差檢查不會擋部署(兩邊平行跑),但這次一定要綠:
   第 4 步本機已經是 ✅,紅了就停下來查。這次沒有改 `landing/`,`landing-deploy.yml` 不會跑。
   GitHub 的部署狀態可能慢 5 分鐘才出現,以 Actions 結果與第 8 步的 bundle 探針為準。
8. **線上驗證**:
   1. 新版真的上線了(bundle 探針:只有新版才有這兩句):
      ```bash
      for pair in "https://app.ifoodmap.ai/market|市集還沒有上架的商品" "https://ifoodmap-admin.vercel.app/admin/market/products|讀不到縮圖"; do
        url=${pair%%|*}; marker=${pair##*|}; origin=$(echo "$url" | grep -o '^https://[^/]*')
        js=$(curl -s "$url" | grep -o '/assets/index-[^"]*\.js' | head -1)
        if curl -s "$origin$js" | grep -q "$marker"; then echo "$url 新版"; else echo "$url 還是舊版"; fi
      done
      ```
      Expected:兩行都是「新版」(2026-10-10 部署前實測兩行都是「還是舊版」)。
   2. anon 的讀寫權限(publishable key 是公開的,但不要印出來;只帶 `apikey` 標頭,REST 與 Storage 都認):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
      PK=$(curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/api-keys -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.type==="publishable");process.stdout.write(k?k.api_key:"")})')
      SB=https://cwvpehqcvbfuynabpqop.supabase.co
      curl -s -w ' products %{http_code}\n' "$SB/rest/v1/market_products?select=id&limit=1" -H "apikey: $PK"
      curl -s -w ' stores %{http_code}\n' "$SB/rest/v1/market_stores?select=supplier_id&limit=1" -H "apikey: $PK"
      curl -s -w ' transfer %{http_code}\n' "$SB/rest/v1/market_store_transfer?select=supplier_id&limit=1" -H "apikey: $PK"
      curl -s -w ' insert %{http_code}\n' -X POST "$SB/rest/v1/market_products" -H "apikey: $PK" -H "Content-Type: application/json" -d '{}'
      curl -s -w ' upload %{http_code}\n' -X POST "$SB/storage/v1/object/market-images/a9200000-0000-4000-8000-000000000001/store/a9200000-0000-4000-8000-0000000000aa.jpg" \
        -H "apikey: $PK" -H "Content-Type: image/jpeg" --data-binary 'not-an-image'
      node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
      ```
      Expected:`[] products 200`、`[] stores 200`(還沒有核准上架的商品、也還沒有開放的店家);`transfer 401`(內容含 `42501` / permission denied);
      `insert 401`(`42501`);`upload` 是 400 或 403、內容含 `row-level security`(Storage 的 HTTP 狀態碼常是 400,真正的碼在內容的 `statusCode`;
      內容是別的錯誤就記下完整回應回報 —— 一樣是被拒,但沒有驗到 policy)。🔴 `upload` 不能是 2xx:萬一上傳成功,殘留檢查的 `fixture_objects` 會變 `1`
      (路徑刻意用 fixture 的前綴),那個檔只能從 Dashboard 刪,立刻回報。殘留五個 `0`。(2026-10-10 部署前實測:`products` 是 404 `PGRST205`,表還不在。)
   3. 頁面(手機 375 與桌機 1280,不能有橫向捲動):
      ```bash
      mkdir -p /tmp/market-p1-shots/home /tmp/market-p1-shots/nope
      node ~/.claude/tools/cdp-shot.mjs https://app.ifoodmap.ai/market 375 812 market-main /tmp/market-p1-shots/home
      node ~/.claude/tools/cdp-shot.mjs https://app.ifoodmap.ai/market 1280 800 market-main /tmp/market-p1-shots/home
      node ~/.claude/tools/cdp-shot.mjs https://app.ifoodmap.ai/market/nope 375 812 market-main /tmp/market-p1-shots/nope
      sips -Z 1024 /tmp/market-p1-shots/home/market-main-375x812.png --out /tmp/market-p1-preview-375.png
      sips -Z 1024 /tmp/market-p1-shots/home/market-main-1280x800.png --out /tmp/market-p1-preview-1280.png
      sips -Z 1024 /tmp/market-p1-shots/nope/market-main-375x812.png --out /tmp/market-p1-preview-nope.png
      ```
      Expected:三行輸出的 `docW` 依序是 `375`、`1280`、`375`;只 Read 三張 preview(原圖不要直接 Read):首頁看得到「iFoodmap 食材市集」標題、搜尋列、
      分類圖示、「市集還沒有上架的商品,敬請期待。」;`/market/nope` 是「找不到這個頁面。」與「回市集首頁」。
   4. 管理員站:`curl -s -o /dev/null -w '%{http_code}\n' https://ifoodmap-admin.vercel.app/admin/market/products` → `200`(內容要登入,留給業主在第 3 階段實測)。
   5. 派一個沒參與實作的 agent 獨立驗收(fresh context;只准讀、乾跑、唯讀查詢,不准改檔、不准 apply、不准輸入任何密碼),清單見實作計畫 Task 31 Step 8,
      數字以本節為準(`market_catalog` 112、`market_images_storage` 20、`image_policies` 2、`image_bucket_versioning` DISABLED)。
      有任何一項不過:照下面「還原(第 1 階段)」判斷要不要退版,回報派工者,不要直接進第 2 階段。

### 還原(第 1 階段)

**前端一定先退,資料庫才能退**(新前端會讀 `market_*`;舊前端完全不碰這些表,所以只有前端有問題時,資料庫留著無妨)。
第 2 階段已經上線的話,先照第 2 階段那一節還原(120000 的還原檔開頭也寫了這個順序)。

1. **前端**:Vercel → `dish-to-supply`、`ifoodmap-admin` 兩個專案 → Deployments → 選合併之前的那一版 → Instant Rollback。
   只有前端有問題就到這裡為止:在 `market` 修好,照上面第 1、6–8 步重新上線(migration 不用重套)。
   ⚠️ 用過 Instant Rollback 之後,Vercel 不會再自動把新的 production 部署接到正式網域:之後要上線的那一版,要到專案的 Deployments 按 Promote(或 Undo Rollback)才會生效。
2. **資料庫**(第 1 步做完才做):
   1. 先匯出 —— 120000 的還原會 DROP 三張表,零售店家、轉帳資訊(含銀行帳號)、零售商品全部消失。匯出檔放在 repo 外面,不要貼進對話:
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && mkdir -p ~/supabase-backups && Q=$(mktemp) && printf '%s\n' "
      SELECT json_build_object(
        'exported_at', now(),
        'market_stores', (SELECT COALESCE(json_agg(s ORDER BY s.supplier_id), '[]'::json) FROM public.market_stores s),
        'market_store_transfer', (SELECT COALESCE(json_agg(t ORDER BY t.supplier_id), '[]'::json) FROM public.market_store_transfer t),
        'market_products', (SELECT COALESCE(json_agg(p ORDER BY p.supplier_id, p.id), '[]'::json) FROM public.market_products p)
      ) AS market_export;" > "$Q"
      node scripts/supabase-sql.mjs ro "$Q" > ~/supabase-backups/market-phase1-$(date +%Y%m%d-%H%M).json && ls -l ~/supabase-backups/market-phase1-*.json
      ```
      Expected:檔案不是空的,內容是 `[{"market_export": {"exported_at": …, "market_stores": […], "market_store_transfer": […], "market_products": […]}}]`
      (唯讀端點的角色 `supabase_read_only_user` 有 BYPASSRLS,三張表的每一列都讀得到)。
   2. 先乾跑還原(線上已經有兩支 migration,所以不帶 `--with-migration`):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      RC=supabase/rollbacks/20261009120000_market_catalog.down.sql
      RS=supabase/rollbacks/20261009120100_market_images_storage.down.sql
      node scripts/supabase-sql.mjs dry supabase/tests/database/market_images_storage_rollback.test.sql --with-rollback $RS
      node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
      node scripts/supabase-sql.mjs dry supabase/tests/database/market_catalog_rollback.test.sql --with-rollback $RS --with-rollback $RC
      node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
      ```
      Expected:兩支都 `共 3 項,失敗 0 項`;殘留五個 `0`。
   3. 正式還原,**先 120100 再 120000**。還原檔自己會刪 ledger 那一列,不能用 `apply`(它只收 migration、還會補 ledger);
      照「寫了新 migration 之後」的方式把整份檔案當成一個請求送出(= 一個交易),第一支回 `[]` 才送第二支:
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      send_sql() {  # 整份檔案 = 一個請求 = 一個交易;成功印 [],失敗印 {"message":"Failed to run sql query: …"}(已整支回滾)
        J=$(mktemp)
        node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ query: fs.readFileSync(process.argv[1], "utf8") }))' "$1" "$J"
        curl -s -X POST "https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/database/query" \
          -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
          -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36" \
          --data-binary @"$J"
        echo
      }
      R1=$(send_sql supabase/rollbacks/20261009120100_market_images_storage.down.sql); echo "120100: $R1"
      [ "$R1" = "[]" ] && R2=$(send_sql supabase/rollbacks/20261009120000_market_catalog.down.sql) && echo "120000: $R2"
      ```
      Expected:`120100: []`、`120000: []`。第一支不是 `[]` 時第二支不會送,停下來回報。
   4. 還原後確認(唯讀):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
      SELECT json_build_object(
        'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20261009120000', '20261009120100')),
        'market_tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                            AND relname IN ('market_stores', 'market_store_transfer', 'market_products')),
        'market_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^market_'),
        'image_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'market images%'),
        'bucket_left', (SELECT count(*) FROM storage.buckets WHERE id = 'market-images')
      ) AS phase1_rollback;" > "$Q"
      node scripts/supabase-sql.mjs ro "$Q"
      ```
      Expected:`ledger`、`market_tables`、`market_functions`、`image_policies` 都是 `0`;`bucket_left` 是 `1`(SQL 刪不掉 bucket)。
   5. bucket 與裡面的檔案還在,而且還是**公開**的(知道網址就看得到)。要收掉:業主在 Dashboard → Storage → `market-images` 先清空、再刪 bucket
      (或用 service role key 的 Storage API:清空後 `DELETE /storage/v1/bucket/market-images`)。因為違規內容而還原時,至少先把 bucket 改成不公開。
3. **repo**:兩支 migration 要跟前端一起退,`check-migrations` 才不會一直紅,之後的 push 也不會把新前端再部署上去:
   ```bash
   git -C /Users/aimand/.gemini/File/ifoodmap switch main
   git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
   git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count main..origin/main         # 0 才繼續
   git -C /Users/aimand/.gemini/File/ifoodmap revert -m 1 --no-edit <部署第 6 步記下的合併 commit>
   git -C /Users/aimand/.gemini/File/ifoodmap push origin main
   ```
   照第 7 步等 CI;第 1 步用過 Instant Rollback 的話,這次的部署要到 Vercel 按 Promote。
   之後要重新上線:先 `git revert <這個 revert commit>` 把內容加回來,再合併修正 —— 只再合併一次 `market` 不會把被 revert 掉的內容帶回來。

### 違規圖片怎麼刪

管理員沒有任何 storage policy,**後台刪不了檔**。照這個順序:

1. 先在管理員站「零售市集 › 商品審核」把商品退回或下架(填原因)。🔴 一定先做這步:刪檔之後同一個路徑又空出來,供應商可以用同一個檔名重傳;
   商品若還是已核准,新內容不經審核就公開(重傳沒有改到 `photos`,guard 不會重新檢查)。
   店家 logo / 封面沒有審核流程:先在「零售市集 › 零售店家」停用那家店(填原因),消費者就看不到店家頁與它的商品。
2. 再刪檔,主圖**和**它的縮圖都要刪(`<uuid>.jpg` 與 `<uuid>_t.jpg`;logo / 封面在 `<supplier_id>/store/`):
   - Supabase Dashboard → Storage → `market-images` → `<supplier_id>/<商品 id>/`,選兩個檔刪除;或
   - 用 service role key 呼叫 Storage API,例如 supabase-js `createClient(<專案網址>, <service role key>).storage.from('market-images').remove([主圖路徑, 縮圖路徑])`
     (service role key 只在業主手上,不要放進前端、repo 或對話)。

   🔴 不能用 SQL 刪(`storage.protect_objects_delete` 會擋)。
3. bucket 是公開的:只下架商品、不刪檔,知道網址的人還是看得到。刪完確認公開網址不再回 200:
   `curl -s -o /dev/null -w '%{http_code}\n' https://cwvpehqcvbfuynabpqop.supabase.co/storage/v1/object/public/market-images/<路徑>`。
   ⚠️ 上傳時帶一年的 `cacheControl`:刪檔之後,CDN 與看過的瀏覽器可能還會顯示快取一段時間(多久沒有實測過)。
4. 商品的 `photos` 還指著刪掉的檔:供應商換掉那張(或補傳)之前,這個商品核准不了(`photos_not_uploaded`),審核畫面那一格也會顯示「讀不到」。

### 第 2 階段:購物車、免註冊下單、訂單通知(migration 20261009130000 / 130100 / 130200、Edge Function `market-notify`)

消費者把商品放進購物車(只存在瀏覽器的 localStorage,價格、庫存每次重新跟資料庫拿)、免登入結帳,一次可以結好幾家店:每家店一張單,
付款方式是貨到付款或銀行轉帳,**錢由店家自己收,平台不經手**。下單後拿到查詢連結 `/market/orders/<查詢 token>`;店家在後台接單、出貨;
通知信由 Edge Function `market-notify` 寄(哪一步寄給誰見下面的表)。
🔴 第 2 階段上線之後,**一般消費者仍然下不了單、真實的消費者與店家也收不到信**:下單開關 `market_checkout_open` 關著(只有平台管理員能下單,給業主實測),
寄信閘門 `MARKET_NOTIFY_LIVE` 也沒開(所有信只寄內部信箱)。兩個都待業主核准,見最後的「對外開放前待辦」。

| 誰 | 在哪裡 |
|---|---|
| 消費者(免登入) | 產品站 `/market/cart`(購物車)、`/market/checkout`(結帳)、`/market/orders/<token>`(查單)、`/market/terms`、`/market/privacy`(服務條款、隱私權政策,目前是草稿) |
| 供應商 | 產品站「零售市集 › 零售訂單」`/supplier/market/orders`:接單、拒單、出貨、確認已收款、標記完成、取消訂單(新訂單通知信的「到後台處理」連到這裡) |
| 管理員 | 管理員站「零售市集 › 零售訂單」`/admin/market/orders`:**唯讀總覽**,沒有任何改訂單的按鈕(要取消請店家在供應商後台做);只在管理員站的 build 裡 |

- **130000 market_orders**
  - `market_orders`(每家店一張;同一次結帳的單共用 `checkout_id` 與同一組查詢 token):收件資料、小計 / 運費 / 總額、付款方式(`cod` / `transfer`)、
    查詢 token 的 sha256 hex(`lookup_token_hash`)、同意的條款版本;`payment_status` / `payment_ref` 預留給之後的線上付款(目前不用)。
    - 請求指紋 `request_fingerprint`(64 位 hex):正規化後的商品、付款方式、收件資料的 sha256,同一次結帳的每張單都一樣 —— 用來判斷同一個 token 的重送是不是同一份內容。
    - `UNIQUE (lookup_token_hash, supplier_id)`:同一個 token(= 同一次結帳)每家店最多一張,是下單 RPC 之外的第二道防重複;它的索引也拿來用 token 查單。
    - 金額 CHECK(`market_orders_money`):商品小計 `subtotal` 1–1,000,000(不含運費)、運費 `shipping_fee` 0–10,000(跟店家設定的上限一樣)、
      `total = subtotal + shipping_fee`(總額可以超過 1,000,000:一件百萬元的商品加運費也買得到)。
  - `market_order_items`:下單當下的品名、規格、溫層、單價快照(之後改價不影響舊單)。
    `stock_deducted` = 下單時真的從庫存扣掉的數量(商品有設庫存 = 數量,不限量 = 0);拒單 / 取消**只補這個數**,而且商品現在是不限量就不動 ——
    下單時不限量、之後店家改成有庫存,取消也不會憑空多出庫存。
  - `market_order_events`:狀態紀錄,只能新增(UPDATE / DELETE 一律擋,所以訂單也刪不掉);同一個 INSERT 同一張單只能一筆。狀態只經這張表改變:
    ```
    貨到付款:pending → confirmed → shipped → completed
    銀行轉帳:pending → confirmed →(自動)awaiting_payment → paid → shipped → completed
    pending → rejected(拒單,要原因)
    pending / confirmed / awaiting_payment / paid → cancelled(取消,要原因;店家或平台都能取消)
    pending 超過 72 小時、awaiting_payment 超過 72 小時 → cancelled(系統自動取消;加固 20261012100000 套用之後,見「第 3 階段」)
    ```
    - guard(BEFORE):鎖訂單列;身分由伺服器決定(這家店的啟用中帳號 = supplier、`is_admin()` = admin、service_role / 資料庫直連 = system,前端送的 `actor_role` 不算);
      前端以為的狀態跟資料庫不一樣 → P0001 `stale_order_status`(畫面過期);(身分, 目前狀態, 目標狀態, 付款方式) 要在轉移表 `market_transition_rules()` 裡
      (前端 `src/lib/market/orders.ts` 的 `MARKET_TRANSITIONS` 由 vitest 逐條比對);拒單 / 取消原因、出貨的物流去掉頭尾空白(連全形空白、零寬字元)後
      看不到字就當沒填 → `reason_required` / `carrier_required`。
    - 🔴 **已收款(paid)的轉帳單也能取消**:店家收了錢卻出不了貨時,單才不會卡死。**退款由店家自行處理**,平台不經手款項 ——
      消費者的取消信會這樣寫並附店家電話;供應商後台取消已收款的單時也會提醒「取消後要由你自行退款」。
    - apply(AFTER):改訂單狀態與各階段時間;拒單 / 取消補庫存(只補 `stock_deducted`;先依商品 id 鎖商品,跟下單同一個鎖順序);
      轉帳單接單後在同一個交易自動補一筆「待匯款」(身分一律記 system)。
    - **紀錄時間由伺服器決定**:`created_at` 一律改寫成 `clock_timestamp()`,而且同一張單**嚴格遞增**(至少比上一筆多 1 微秒)——
      `now()` 是交易開始的時間,轉帳單的「已接單」與自動補的「待匯款」在同一個交易,會一模一樣、排不出先後。前端、API、system 送的時間都不算。
  - 權限:anon 對三張表完全沒有權限(消費者只能經 `market_get_orders(token)` 看自己那次結帳);供應商讀自家、管理員全部;
    只有 `market_order_events` 開放登入者 INSERT(guard 再擋)。資料表權限先 `REVOKE ALL`(含 TRUNCATE、MAINTAIN)再給。
- **130100 market_notify**:每筆狀態紀錄 → pg_net → `market-notify`(`{kind:'event', event_id}`);下單成功時 `market_place_order` 另外排一封下單確認
  (`{kind:'placed', checkout_id, token}`;token 只在這個請求裡,pg_net 送出後佇列列就刪掉)。非同步:寄信失敗不會讓訂單 rollback;網址或密鑰沒設定就安靜跳過。
  網址在 `app_config.market_notify_function_url`;🔴 **共用既有的 `app_config.notify_service_key`(= secret `NOTIFY_SECRET`,餐廳訂單 notify 同一把),不新增 secret**
  (不用 `supabase secrets set`,其他 function 不會因此全部重新部署)。
- **130200 market_checkout**
  - `market_place_order(p_checkout)`(SECURITY DEFINER,anon / 登入者都能叫):伺服器重查一切,不相信瀏覽器送來的任何金額 —— 商品是否已核准上架、
    店家與供應商是否啟用、價格、庫存、配送縣市、最低訂購金額(比小計)、付款方式(轉帳要店家已填轉帳資訊);算運費(小計 ≥ 免運門檻就 0)、
    扣庫存、每家店建一張單 + 明細 + 第一筆紀錄。商業上的錯誤一律回 `{ok:false, code, …}`、不 raise。檢查順序見下面的表。
    - **查詢 token 由瀏覽器產生**:`crypto.getRandomValues` 32 bytes → base64url、不帶「=」→ 43 字(`^[A-Za-z0-9_-]{43}$`,不合格 → `INVALID_INPUT` `token`);
      一次結帳一個,資料庫只存 sha256 hex。token 只出現在下單的請求與回應、下單確認信的連結。
    - **冪等**:同一個 token 的請求用 advisory lock 排隊,再查這個 token 有沒有建過單 ——
      同 token、同內容重送(比請求指紋,不含 `expected_totals` 與條款版本;Email 大小寫、電話的 -、同一商品拆兩行都算同內容)→ 回第一次的結果再加 `duplicate:true`:
      **不建單、不扣限流額度、不動庫存、不再寄確認信**,開關後來關了也照樣回;同 token、不同內容 → `TOKEN_REUSED`,什麼都不寫。
    - 前端(`src/lib/market/checkout.ts` 的 `checkoutTokenStore`):同一次結帳一直沿用同一個 token(斷線、逾時、缺貨、價格變了之後的重送都一樣),
      存在 sessionStorage(同一個分頁重新整理還在);這個 token 已經成單、內容又改過再送 → `TOKEN_REUSED`,結帳頁說「你剛才送出的訂單已經成立」
      並給「查看訂單」連結(還沒成單過的 token,內容改了伺服器照常建單)。成功(含 `duplicate`)或 `TOKEN_REUSED` 之後才換新 token。
      斷線時請買家再按一次「送出訂單」(同一個 token,不會重複下單)。
    - **`ORDER_TOO_LARGE`**:任一家店的商品小計(不含運費)> 1,000,000 → 不建單、庫存不變,回 `stores: [{supplier_id, subtotal}]`(用 bigint 算,不會丟例外)。
  - `market_get_orders(p_token)`(anon 可叫):用 token 查那次結帳的訂單;token 格式不對、找不到都回 `NOT_FOUND`(不區分);電話、Email 遮罩;
    店家只給店名、電話、出貨天數、退換貨說明 —— 🔴 **不給店家的 `contact_email`**(那是收新訂單通知的信箱);轉帳資訊只在「待匯款」時給。
  - `market_checkout_status()`:`{open, can_order}`,前端用來決定要不要讓人進結帳;真正的關卡是 `market_place_order` 第 4 步。
  - **下單開關** `app_config.market_checkout_open`(migration 預設 `'false'`):關著的時候只有平台管理員能下單(業主實測用),其他人拿到 `MARKET_CLOSED`,
    而且不寫任何限流計數。🔴 改成 `'true'` = 對外開放,**待業主核准**。

**下單的檢查順序**(`market_place_order`;步驟編號照 130200 裡的註解,有一步不過就回傳,後面都不做):

| 步驟 | 檢查 | 不過時回 |
|---|---|---|
| 第 1–2 步 | 形狀、收件資料(姓名、電話、Email、縣市、地址、備註、條款版本)、token、購物車格式(最多 50 行;每行 uuid、1–99 的整數),同一商品合併 | `INVALID_INPUT`(帶 `field`)、`TOO_MANY_ITEMS` |
| 第 3 步 | 冪等(同一個 token 建過單沒有) | `duplicate:true`(當成功)/ `TOKEN_REUSED` |
| 第 4 步 | 下單開關(平台管理員不受限) | `MARKET_CLOSED` |
| 第 5 步 | 限流 A 段 | `RATE_LIMITED` |
| 第 6 步 | 空購物車;依 id 鎖商品;下架或店家、供應商停用;庫存 | `EMPTY_CART`、`PRODUCT_UNAVAILABLE`、`OUT_OF_STOCK` |
| 第 7 步 | 每家店:超過 10 家、商品小計 > 1,000,000、配送縣市、最低訂購金額、付款方式、`expected_totals` 跟伺服器算的不一樣 | `TOO_MANY_STORES`、`ORDER_TOO_LARGE`、`NOT_DELIVERABLE`、`BELOW_MINIMUM`、`PAYMENT_NOT_ACCEPTED`、`PRICE_CHANGED` |
| 第 8 步 | 限流 B 段 | `RATE_LIMITED`、`DAILY_CAP` |
| 第 9 步 | 建單、明細、第一筆紀錄、扣庫存、排下單確認信 | (成功)`{ok:true, token, checkout_id, orders}` |

第 1–3 步就回傳的請求(格式錯、重送)不算進限流;第 4 步擋下的不寫任何計數。鎖的順序固定:token 的 advisory lock → A 段計數列 → 商品 → B 段計數列。

**防灌單**(`market_rate_take`,新寫的,不沿用 AI 的 `ai_rate_take`):固定窗格(整點、台北日);同一段裡任何一條超過就整段退回(被擋的那次不吃那一段的額度)。
IP / Email / 電話只以「加鹽 sha256 前 16 hex」落地(鹽在 `app_config.market_rate_salt`,migration 隨機產生、不印出來)。**開關關著時不寫任何計數;平台管理員不限流。**

| 段 | 什麼時候算 | 規則(bucket 種類) | 額度 |
|---|---|---|---|
| A 段:只防灌爆 | 開關之後、查商品之前;每一次嘗試都算(**失敗的也算**) | `ip`:IPv4 完整位址、IPv6 取 /64 | 每小時 30(不設每天:手機業者的 IPv4 常是一大群人共用一個) |
| | | `ip48`:IPv6 的 /48 | 每小時 200 |
| | | `noip`:拿不到 IP 時全站共用一格 | 每小時 60、每天 300 |
| B 段:只算真的成單 | 所有檢查都過、準備建單時才扣;一次結帳不論幾家店都算 1 | `email`(去 +tag、gmail 去點) | 每小時 3、每天 10 |
| | | `phone` | 每天 10 |
| | | `ipo`:同一個 IPv4 | 每天 20 |
| | | `ip48o`:同一個 IPv6 /48 | 每天 20 |
| | | `global`:全站 | 每天 500(回 `DAILY_CAP`) |

- `noip` 只是保險:正常情況一定拿得到 IP;被觸發代表 IP 取得壞了(所有拿不到 IP 的請求共用這一格,正常買家也會被擋),要去查。
- B 段被擋 → 不建單、不動庫存,A 段已扣的照算;缺貨、價格變了、超過金額上限、配送不到、未達最低金額都不吃 B 段。
- IP 取自 `market_client_ip()`:`cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` 第一段。2026-10-11 部署時用暫時的探測函式驗過(IPv4,見「部署」第 9-5 步):
  實際用到的是 `cf-connecting-ip`(Cloudflare 覆寫;用戶端自己帶 `CF-Connecting-IP` 會被 Cloudflare 直接回 403 `error code: 1000`),
  `x-real-ip` 會被中間的 proxy 改寫成真實 IP,`x-forwarded-for` 第一段偽造得了但只是第三順位。IPv6 /64 還沒驗(見「對外開放前待辦」第 6 條)。
  加固 20261012100000 套用之後順序改成 `cf-connecting-ip` → `x-real-ip` → NULL:不再信 `x-forwarded-for`,兩個都沒有就算進 `noip`(見「第 3 階段」)。
- 計數表 `market_rate_counters`;**擋下次數** `market_rate_blocks_daily`(`day` 台北日、`rule` 規則種類 = bucket 冒號前的前綴、`hits`,主鍵 `(day, rule)`):
  被擋時把擋下的那種規則 +1,同一次請求被同一種的兩條擋下(例如 Email 每小時與每天)只算 1;沒被擋時不寫;只記次數、不記是誰。兩張表 anon / 登入者都碰不到。
- 清理:pg_cron `ifoodmap-market-rate-cleanup` 每天 19:50 UTC(台北 03:50)刪 2 天前的計數、**90 天前**的擋下紀錄。
- 量變大時怎麼調:另開一支 migration,用 `CREATE OR REPLACE FUNCTION public.market_place_order` 改 A / B 段的數字(計數表與 `market_rate_take` 不用動);
  要加新的規則,種類取新名字、不要跟另一段重疊。

**Edge Function `market-notify`**(`supabase/functions/market-notify/`;邏輯在 `handler.ts`、`render.ts`,vitest 測):

| 時機 | 寄給誰 |
|---|---|
| 下單成功 | 消費者:下單確認(含查詢連結 —— **只有這一封有 token**;一次結帳一封,列出每家店) |
| 新訂單(待接單) | 店家(`suppliers.contact_email`):「到後台處理」連到 `/supplier/market/orders` |
| 接單(貨到付款)、待匯款(轉帳,含匯款資訊)、拒單、出貨、取消 | 消費者 |
| 平台或系統取消 | 消費者 + 店家(「請不要出貨」) |
| 轉帳單的「已接單」(緊接著寄待匯款)、確認已收款、標記完成 | 不寄 |

- 每封信的 reply_to 都是**平台信箱**(`SUPPLIER_MAIL_REPLY_TO`,沒設用 `LEAD_NOTIFY_TO` 的第一個);給消費者的信附**店家電話**(`suppliers.phone`,沒填就不寫)。
  🔴 **信裡、reply_to 都不出現店家的 `contact_email`**。
- 已收款的單被取消:消費者的取消信寫「這張訂單店家已確認收款,退款由店家處理,請直接聯絡店家(店家電話:…)。iFoodmap 平台不經手款項。」
- 寄信帶 Resend 的 `Idempotency-Key`(狀態信 `market-notify:<event_id>:<consumer|supplier>`、下單確認 `market-notify:placed:<checkout_id>`):
  pg_net 重送、或有人重放同一個 event,24 小時內只寄一次;同一個 key 內容不同時 Resend 回 409,記成 failed。
- 共享密鑰用常數時間比對(兩邊先 sha256 再逐字比):不對回 401、`NOTIFY_SECRET` 沒設回 503。下單確認先比對 sha256(token) 跟訂單上的雜湊,對不上回 403、不寄
  (拿到密鑰的人也偽造不了查詢連結)。
- 主旨一律壓成單行(控制字元、換行換成空白,看不見的格式字元例如反向字元直接拿掉;店名裡有換行也不會斷行);內文裡使用者填的字一律 HTML 跳脫。
- 收件 Email 格式不合格(買家 Email、或店家沒填 / 填錯聯絡信箱):不寄,`notifications` 記一筆 `status = failed`,`message` 結尾寫「(沒寄:原因)」。
- 每封都記一筆 `notifications`(管理後台「通知紀錄」看得到;零售的 `message` 都以「零售」開頭)。token 不會出現在回應、log、`notifications`(log 連 8 字以上的 token 片段都遮)。
- 🔴 **寄信閘門 `MARKET_NOTIFY_LIVE`**(跟餐廳訂單的 `NOTIFY_LIVE` 分開,那支開了零售照樣關著):不是剛好字串 `true` 時,**所有信只寄 `ifoodmaptw@gmail.com`**、
  主旨加「[測試轉寄]」、內文最前面列出原收件人(每次請求重讀)。寄給真實消費者與店家**待業主核准** —— 不要自己設定這個 secret。
- 讀的 secret 全部是既有的:`NOTIFY_SECRET`、`RESEND_API_KEY`、`NOTIFY_FROM`、`SITE_URL`、`SUPPLIER_MAIL_REPLY_TO` / `LEAD_NOTIFY_TO`
  (`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 平台自動提供)。🔴 部署一定要帶 `--no-verify-jwt --use-api`(見下面「部署」第 6 步)。

**測試**:`supabase/tests/database/` 的 `market_orders`、`market_notify`、`market_checkout`、`market_phase2_rollback`(`.test.sql`),在正式庫 BEGIN…ROLLBACK 乾跑;
🔴 不再帶 120000 / 120100(第 1 階段已上線),依序跑、不要並行,每次之後跑 `market_residue.sql`。項數 67 / 9 / 93 / 4
(2026-10-11 在 `7234d55` 實測全過,見計畫勘誤「審查修正補充(四)」;之後有變以勘誤最新一節為準)。
2026-10-11 上線前實測(`market` 分支 `abe2f2c`):vitest 115 檔 / 1800 項全過;tsc 錯誤 72、eslint 錯誤 10(跟開工前的基準一樣);兩種 build 都過。

### 部署(第 2 階段)

🔴 會改正式庫、部署 Edge Function、部署兩個網站。照順序做,任何一步的 Expected 對不上就停下來回報(附上指令與完整輸出),不要自己想辦法繞過。
🔴 **不准**設定 `MARKET_NOTIFY_LIVE`、不准改 `market_checkout_open`(兩個都待業主核准)。
**順序:migration → `market-notify` → 前端**:新前端會呼叫下單 / 查單 RPC;舊前端完全不碰訂單,先套 migration 不影響線上(開關關著,只有平台管理員叫得動下單)。
在 repo 根目錄跑、各自 export token、查詢寫進暫存檔再交給 `ro`,都跟第 1 階段一樣。

1. **確認本機乾淨、跟 origin 同步**:同第 1 階段第 1 步(`status` 沒有輸出、兩個 `rev-list` 都是 `0`;不是就停下來回報)。
2. **上線前最後一次乾跑**(第 2 階段全部;每支之後都跑殘留檢查)。🔴 不要再帶 120000 / 120100:第 1 階段已上線,重帶會在線上的 `market_stores` / `market_products`
   拿 ACCESS EXCLUSIVE 鎖到 ROLLBACK,乾跑期間市集讀不到。依序跑、不要並行(fixture 共用同一組 id,同時送會互等到逾時):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   O=supabase/migrations/20261009130000_market_orders.sql
   N=supabase/migrations/20261009130100_market_notify.sql
   K=supabase/migrations/20261009130200_market_checkout.sql
   RK=supabase/rollbacks/20261009130200_market_checkout.down.sql
   RN=supabase/rollbacks/20261009130100_market_notify.down.sql
   RO=supabase/rollbacks/20261009130000_market_orders.down.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql --with-migration $O
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql --with-migration $O --with-migration $N
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql --with-migration $O --with-migration $N --with-migration $K
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_phase2_rollback.test.sql --with-migration $O --with-migration $N --with-migration $K --with-rollback $RK --with-rollback $RN --with-rollback $RO
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:依序 `共 67 項` / `共 9 項` / `共 93 項` / `共 4 項`(項數以計畫檔尾勘誤最新一節為準),全部 `失敗 0 項`;每次殘留的五個數字都是 `0`。
   (測試在交易裡把通知網址換成 `http://127.0.0.1:9/…`、把開關切成 `'true'` 測開放後的行為,都跟著 ROLLBACK 消失。)
3. **套 migration**(130000 → 130100 → 130200;一行一支,前一支成功才跑下一支):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   node scripts/supabase-sql.mjs apply supabase/migrations/20261009130000_market_orders.sql
   node scripts/supabase-sql.mjs apply supabase/migrations/20261009130100_market_notify.sql
   node scripts/supabase-sql.mjs apply supabase/migrations/20261009130200_market_checkout.sql
   ```
   Expected(各一行):
   ```
   已套用 20261009130000_market_orders.sql;ledger:[{"version":"20261009130000","name":"market_orders"}]
   已套用 20261009130100_market_notify.sql;ledger:[{"version":"20261009130100","name":"market_notify"}]
   已套用 20261009130200_market_checkout.sql;ledger:[{"version":"20261009130200","name":"market_checkout"}]
   ```
   出錯時的判斷同第 1 階段第 3 步(等鎖逾時就重跑同一行;`拒送:ledger 已經有版本 …` 直接做第 4 步確認;`套用後讀回的 ledger 不符` 停下來回報、不要重跑)。
   前面的成功、後面的失敗:已套的不用還原(前端還沒推、開關關著,沒有人用得到),查明原因再套;三支都成功之前不要部署 `market-notify`、不要推前端。
4. **確認線上 schema**:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
   SELECT json_build_object(
     'ledger', (SELECT json_agg(m.version ORDER BY m.version) FROM supabase_migrations.schema_migrations m
                 WHERE m.version IN ('20261009130000', '20261009130100', '20261009130200')),
     'event_triggers', (SELECT json_agg(t.tgname ORDER BY t.tgname) FROM pg_trigger t
                         WHERE t.tgrelid = 'public.market_order_events'::regclass AND NOT t.tgisinternal),
     'anon_can_read_orders', has_table_privilege('anon', 'public.market_orders', 'SELECT'),
     'anon_can_insert_events', has_table_privilege('anon', 'public.market_order_events', 'INSERT'),
     'api_can_touch_rate_tables', (SELECT bool_or(has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
                                    FROM unnest(ARRAY['anon', 'authenticated']) r,
                                         unnest(ARRAY['public.market_rate_counters', 'public.market_rate_blocks_daily']) t),
     'anon_rpc', json_build_object(
       'place_order', has_function_privilege('anon', 'public.market_place_order(jsonb)', 'EXECUTE'),
       'get_orders', has_function_privilege('anon', 'public.market_get_orders(text)', 'EXECUTE'),
       'checkout_status', has_function_privilege('anon', 'public.market_checkout_status()', 'EXECUTE'),
       'rate_take', has_function_privilege('anon', 'public.market_rate_take(jsonb)', 'EXECUTE')),
     'checkout_open', (SELECT c.value FROM public.app_config c WHERE c.key = 'market_checkout_open'),
     'notify_url_ok', (SELECT c.value = 'https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify'
                         FROM public.app_config c WHERE c.key = 'market_notify_function_url'),
     'notify_key_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'notify_service_key' AND c.value <> ''),
     'rate_salt_set', (SELECT count(*) = 1 FROM public.app_config c WHERE c.key = 'market_rate_salt' AND c.value ~ '^[0-9a-f]{32}$'),
     'rate_cleanup_cron', (SELECT j.schedule FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup'),
     'cron_cleans_blocks', (SELECT j.command LIKE '%market_rate_blocks_daily%' FROM cron.job j WHERE j.jobname = 'ifoodmap-market-rate-cleanup')
   ) AS phase2;" > "$Q"
   node scripts/supabase-sql.mjs ro "$Q"
   SUPABASE_PROJECT_REF=cwvpehqcvbfuynabpqop node scripts/check-migrations.mjs
   ```
   Expected(JSON 裡的值;只印布林值,密鑰與鹽的值不會出現):
   - `ledger` = `["20261009130000","20261009130100","20261009130200"]`
   - `event_triggers` = `["trg_market_apply_event","trg_market_events_immutable","trg_market_events_one_per_order","trg_market_guard_event","trg_market_notify_event"]`
   - `anon_can_read_orders`、`anon_can_insert_events`、`api_can_touch_rate_tables` = `false`
   - `anon_rpc` = `{"place_order": true, "get_orders": true, "checkout_status": true, "rate_take": false}`
   - 🔴 `checkout_open` = `"false"`
   - `notify_url_ok`、`notify_key_set`、`rate_salt_set`、`cron_cleans_blocks` = `true`;`rate_cleanup_cron` = `"50 19 * * *"`
     (`notify_key_set` 是 `false` = 資料庫不會呼叫 `market-notify`,一封信都不會寄:停下來查餐廳訂單 notify 的設定)
   - `check-migrations` 最後一行是 `✅ 沒有落差 —— repo 的 migration 都已套用到線上`(repo 46 個、線上 46 個)。

   除了 `ledger`(第 3 步寫的)與 `notify_key_set`(線上原本就有的設定),這些值 2026-10-11 在本機一次性的 Postgres 載入 120000 / 130000 / 130100 / 130200 原文實測過(不是正式庫)。
   新函式要等 PostgREST 重新載入 schema 才叫得到(三支最後都有 `NOTIFY pgrst`);第 9 步拿到 404 `PGRST202` / `PGRST205` 時,照「寫了新 migration 之後」的方式送一次
   `notify pgrst, 'reload schema';`。
5. **用線上 schema 再跑一次測試**(不帶 `--with-migration`),並確認還原檔在線上 schema 跑得動:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   RK=supabase/rollbacks/20261009130200_market_checkout.down.sql
   RN=supabase/rollbacks/20261009130100_market_notify.down.sql
   RO=supabase/rollbacks/20261009130000_market_orders.down.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_phase2_rollback.test.sql --with-rollback $RK --with-rollback $RN --with-rollback $RO
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:依序 `共 67 項` / `共 9 項` / `共 93 項` / `共 4 項`,全部 `失敗 0 項`;每次殘留五個 `0`。
   (`market_orders` 在線上跑時,每筆狀態紀錄會在交易裡把通知排到真的 `market-notify` 網址,跟著 ROLLBACK 消失、不會送出。還原的乾跑會拿鎖到 ROLLBACK,一兩秒;這一步在推前端之前做。)
6. **部署 `market-notify`**:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" supabase functions deploy market-notify --project-ref cwvpehqcvbfuynabpqop --no-verify-jwt --use-api
   ```
   - 🔴 **一定要 `--no-verify-jwt`**:呼叫者是資料庫(pg_net),沒有使用者 JWT;少了它 JWT 驗證會打開,資料庫送的通知全部 401,
     而且 trigger 吞掉錯誤、不會有任何地方報錯(同 notify-lead 那一節的坑)。安全性靠共享密鑰 `NOTIFY_SECRET`;`supabase/config.toml` 也寫了 `verify_jwt = false`。
   - `--use-api`:本機沒有 Docker;`../_shared/`、`../ai/crypto.ts`、`../notify/gate.ts`、`src/lib/order-number.ts` 會一起上傳。
   - 不用設定任何 secret(全部是既有的);🔴 不要設 `MARKET_NOTIFY_LIVE`。

   Expected:`Deployed Functions on project cwvpehqcvbfuynabpqop: market-notify`。接著確認 JWT 驗證是關的、沒密鑰會被擋:
   ```bash
   export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
   curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/functions/market-notify -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s);console.log(f.slug,f.status,"verify_jwt="+f.verify_jwt)})'
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cwvpehqcvbfuynabpqop.supabase.co/functions/v1/market-notify -H "Content-Type: application/json" -d '{"kind":"event","event_id":"00000000-0000-4000-8000-000000000000"}'
   ```
   Expected:`market-notify ACTIVE verify_jwt=false`;沒帶密鑰的 POST 回 `401`。`verify_jwt=true` 的話資料庫的通知會全部 401:重新用上面那一行帶 `--no-verify-jwt` 部署。
7. **合併 `market` 到 `main`、push**:同第 1 階段第 6 步,合併訊息改成 `"Merge branch 'market':消費者食材市集第 2 階段(購物車＋下單)"`;
   記下合併 commit(等 CI、還原都要用),最後一樣把 `market` 快轉到 main。
8. **等 CI**:同第 1 階段第 7 步(兩條 workflow 都 `completed success`;`check-migrations` 這次一定要綠,第 4 步本機已經是 ✅)。
9. **線上驗證**:
   1. 新版真的上線了(bundle 探針:只有新版才有這兩句):
      ```bash
      for pair in "https://app.ifoodmap.ai/market/cart|同一筆結帳不會重複下單" "https://ifoodmap-admin.vercel.app/admin/market/orders|更早的訂單不會出現在清單與搜尋結果裡"; do
        url=${pair%%|*}; marker=${pair##*|}; origin=$(echo "$url" | grep -o '^https://[^/]*')
        js=$(curl -s "$url" | grep -o '/assets/index-[^"]*\.js' | head -1)
        if curl -s "$origin$js" | grep -q "$marker"; then echo "$url 新版"; else echo "$url 還是舊版"; fi
      done
      ```
      Expected:兩行都是「新版」(2026-10-11 部署前實測兩行都是「還是舊版」;這兩句在 `abe2f2c` 的兩種 build 裡各自只出現在該站的 bundle)。
   2. anon 的權限與下單開關(publishable key 是公開的,但不要印出來):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"
      PK=$(curl -s https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/api-keys -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "User-Agent: $UA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.type==="publishable");process.stdout.write(k?k.api_key:"")})')
      API=https://cwvpehqcvbfuynabpqop.supabase.co/rest/v1
      TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
      curl -s -X POST "$API/rpc/market_checkout_status" -H "apikey: $PK" -H "Content-Type: application/json" -d '{}'; echo
      curl -s -X POST "$API/rpc/market_get_orders" -H "apikey: $PK" -H "Content-Type: application/json" -d "{\"p_token\":\"$TOKEN\"}"; echo
      curl -s -X POST "$API/rpc/market_place_order" -H "apikey: $PK" -H "Content-Type: application/json" \
        -d "{\"p_checkout\":{\"token\":\"$TOKEN\",\"buyer\":{\"name\":\"部署檢查\",\"phone\":\"0900000000\",\"email\":\"deploy-check@example.com\",\"city\":\"臺北市\",\"address\":\"只是檢查不會建單\"},\"items\":[],\"terms_version\":\"deploy-check\"}}"; echo
      curl -s -o /dev/null -w 'orders %{http_code}\n' "$API/market_orders?select=id&limit=1" -H "apikey: $PK"
      curl -s -o /dev/null -w 'blocks %{http_code}\n' "$API/market_rate_blocks_daily?select=day&limit=1" -H "apikey: $PK"
      ```
      Expected:`{"open": false, "can_order": false}`、`{"ok": false, "code": "NOT_FOUND"}`(隨機的 token 查不到)、
      `{"ok": false, "code": "MARKET_CLOSED"}`(開關關著:不建單、不寫任何限流計數)、`orders 401`、`blocks 401`。
      (前三個回應 2026-10-11 在本機一次性的 Postgres 用 anon 身分對 130200 原文實測過。)
   3. 頁面(手機 375 與桌機 1280,不能有橫向捲動):
      ```bash
      for p in cart terms privacy orders/abc; do
        d=/tmp/market-p2-shots/$(echo "$p" | tr / -); mkdir -p "$d"
        node ~/.claude/tools/cdp-shot.mjs "https://app.ifoodmap.ai/market/$p" 375 812 market-main "$d"
        node ~/.claude/tools/cdp-shot.mjs "https://app.ifoodmap.ai/market/$p" 1280 800 market-main "$d"
        sips -Z 1024 "$d/market-main-375x812.png" --out "/tmp/market-p2-preview-$(basename "$d")-375.png" > /dev/null
        sips -Z 1024 "$d/market-main-1280x800.png" --out "/tmp/market-p2-preview-$(basename "$d")-1280.png" > /dev/null
      done
      ```
      Expected:八行輸出的 `docW` 依序是 `375`、`1280` 交錯;只 Read `/tmp/market-p2-preview-*.png`(原圖不要直接 Read):購物車頁「購物車是空的。」;
      條款、隱私權頁的標題是「食材市集服務條款」「食材市集隱私權政策」,最上面有「草稿:本文件待業主與法律專業確認後定稿。」;
      `/market/orders/abc` 是「找不到這筆訂單。請確認網址完整(從確認信裡的連結打開最保險)。」。
   4. 管理員站:`curl -s -o /dev/null -w '%{http_code}\n' https://ifoodmap-admin.vercel.app/admin/market/orders` → `200`(內容要登入,留給業主實測)。
   5. **IP 標頭檢查**(取代實作計畫 Task 57 Step 8-2:開關關著時 `market_place_order` 在限流之前就回 `MARKET_CLOSED`、不寫計數,原本的做法驗不到):
      用 Management API 暫時建一個探測函式,測完立刻刪掉 ——
      `CREATE FUNCTION public.market_tmp_ip_probe() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''`,
      內容回 `public.market_client_ip()` 與 `request.headers` 裡的 `cf-connecting-ip`、`x-real-ip`、`x-forwarded-for`;只 `GRANT EXECUTE … TO anon`,再 `NOTIFY pgrst, 'reload schema'`。
      用 anon key、`curl -4` 打 `/rest/v1/rpc/market_tmp_ip_probe`:先不帶偽造標頭,再**分開**帶偽造的 `X-Forwarded-For` + `X-Real-IP`、`CF-Connecting-IP`
      (三個一起帶時 Cloudflare 會整個請求回 403,看不到結果)。測完 `DROP FUNCTION public.market_tmp_ip_probe(); NOTIFY pgrst, 'reload schema';`,
      確認 `pg_proc` 查不到、REST 回 404。
      2026-10-11 結果(紀錄在 session scratchpad 的 `market-deploy/PHASE2-LOG.md`):`used` 每次都是真實 IP、取自 `cf-connecting-ip`;
      偽造的 `X-Real-IP` 被改寫成真實 IP;偽造的 `CF-Connecting-IP` 被 Cloudflare 擋(403 / 1000)。本機沒有 IPv6,/64 沒驗到。
   6. 派一個沒參與實作的 agent 獨立驗收(fresh context;只准讀、乾跑、唯讀查詢,不准改檔、不准 apply、不准輸入密碼、不准設定任何 secret 或 `app_config`),
      清單見實作計畫 Task 57 Step 9,數字以本節為準(67 / 9 / 93 / 4);IP 標頭那一項看第 5 點的探測結果。
      另外確認 `MARKET_NOTIFY_LIVE` 不在 `supabase secrets list --project-ref cwvpehqcvbfuynabpqop` 的清單裡(只看名稱、不印值)、`market_checkout_open` 還是 `false`。
      有任何一項不過:照下面「還原(第 2 階段)」判斷要不要退版,回報派工者。

### 怎麼查(第 2 階段)

唯讀端點(`node scripts/supabase-sql.mjs ro`)或 Dashboard 的 SQL Editor:

```sql
-- 限流擋下了幾次(最近 7 天;day = 台北日期、rule = 規則種類,見上面的限流表;只記次數、不記是誰)
-- ipo / ip48o 擋得多 = 共用網路的成單上限該調高;noip 有任何一筆 = IP 取得壞了,要去查
select day, rule, hits from public.market_rate_blocks_daily
where day >= (now() at time zone 'Asia/Taipei')::date - 7 order by day desc, hits desc;

-- 沒寄出去的零售通知(閘門沒開時 recipient 都是 ifoodmaptw@gmail.com;
-- Email 格式不對而沒寄的,message 結尾寫「(沒寄:原因)」,recipient 遮成帳號第一個字加網域前 3 個字,例如「王***@exa…」)
select created_at, recipient, title, message from public.notifications
where message like '零售%' and status = 'failed' order by created_at desc limit 20;

-- pg_net 呼叫的結果(所有走 pg_net 的通知都在這張表、只留最近幾小時;剛做完一個動作就看最新幾筆)
select id, status_code, timed_out, error_msg, left(content, 200) as content, created
from net._http_response order by id desc limit 10;
```

72 小時自動取消(加固 20261012100000 套用之後才有;規則見「第 3 階段」):

```sql
-- 最近 7 天被系統自動取消的單(取消紀錄的身分是 system、payload 帶 auto_expire = 取消前的狀態 pending / awaiting_payment)
select e.created_at, e.order_id, e.from_status, e.payload->>'auto_expire' as auto_expire, e.note
from public.market_order_events e
where e.to_status = 'cancelled' and e.actor_role = 'system' and e.payload ? 'auto_expire'
  and e.created_at > now() - interval '7 days'
order by e.created_at desc limit 20;

-- 自動取消排程的執行紀錄(每 10 分鐘一次;status 不是 succeeded 就看 return_message)
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'ifoodmap-market-expire-orders') order by runid desc limit 5;
```

- `notifications` 是 `failed`:Resend 回錯誤(原因在 Dashboard → Edge Functions → `market-notify` → Logs,token 已遮掉)、同一個 Idempotency-Key 內容不同(409),
  或收件 Email 不合格(message 寫了原因)。寄信失敗不會自動重送。
- `net._http_response`:`status_code` 200 = `market-notify` 收到並處理了(內容 `"live":false` = 閘門沒開;有 `"kinds"` 的是狀態信、有 `"orders"` 的是下單確認);
  401 = 密鑰對不上(`NOTIFY_SECRET` 跟 `app_config.notify_service_key` 不一致)或 function 的 JWT 驗證被打開了(見「部署」第 6 步);
  404 = function 沒部署、或那筆紀錄找不到;`status_code` 是空的而 `timed_out` / `error_msg` 有值 = 連不上或超過 8 秒。
- 三段 SQL 2026-10-11 在本機一次性的 Postgres(載入四支 migration 原文、放了假的紀錄)跑過,欄位與輸出都對;`net._http_response` 用的是 pg_net 的欄位。

### 還原(第 2 階段)

**先退前端,再退資料庫**(新前端會呼叫 `market_place_order` / `market_get_orders` / `market_checkout_status`;第 1 階段的前端完全不碰訂單)。
資料庫的順序一定是 **130200 → 130100 → 130000**(每支還原檔開頭都寫了前一支要先還原)。要連第 1 階段一起退,先做完這一節,再照「還原(第 1 階段)」。

0. 對外開放之後,如果只是要先停止接新訂單、或停止寄信給真實的人:不用退版 ——
   把開關改回關(`update public.app_config set value = 'false', updated_at = now() where key = 'market_checkout_open';`,照「寫了新 migration 之後」的方式送;
   之後只剩平台管理員能下單)、`supabase secrets unset MARKET_NOTIFY_LIVE --project-ref cwvpehqcvbfuynabpqop`(信改回只寄內部信箱;改 secret 會讓所有 function
   重新部署一次)。已成立的訂單照常由店家處理。
1. **前端**:Vercel → `dish-to-supply`、`ifoodmap-admin` 兩個專案 → Deployments → 選第 2 階段合併之前的那一版 → Instant Rollback
   (之後要上線的那一版要按 Promote,同第 1 階段還原第 1 步的 ⚠️)。只有前端有問題就到這裡為止:在 `market` 修好,照上面第 1、7–9 步重新上線(migration 不用重套)。
2. **資料庫**(第 1 步做完才做):
   1. 先匯出 —— 🔴 **130000 的還原會 DROP 三張訂單表,所有零售訂單、明細、狀態紀錄都會消失**;130200 的還原會刪掉擋下紀錄。
      匯出檔含消費者的姓名、電話、Email、地址,放在 repo 外面,不要貼進對話:
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && mkdir -p ~/supabase-backups && Q=$(mktemp) && printf '%s\n' "
      SELECT json_build_object(
        'exported_at', now(),
        'market_orders', (SELECT COALESCE(json_agg(o ORDER BY o.created_at, o.id), '[]'::json) FROM public.market_orders o),
        'market_order_items', (SELECT COALESCE(json_agg(i ORDER BY i.order_id, i.id), '[]'::json) FROM public.market_order_items i),
        'market_order_events', (SELECT COALESCE(json_agg(e ORDER BY e.order_id, e.created_at), '[]'::json) FROM public.market_order_events e),
        'market_rate_blocks_daily', (SELECT COALESCE(json_agg(b ORDER BY b.day, b.rule), '[]'::json) FROM public.market_rate_blocks_daily b)
      ) AS market_phase2_export;" > "$Q"
      node scripts/supabase-sql.mjs ro "$Q" > ~/supabase-backups/market-phase2-$(date +%Y%m%d-%H%M).json && ls -l ~/supabase-backups/market-phase2-*.json
      ```
      Expected:檔案不是空的,內容是 `[{"market_phase2_export": {"exported_at": …, "market_orders": […], "market_order_items": […], "market_order_events": […], "market_rate_blocks_daily": […]}}]`
      (唯讀端點的角色有 BYPASSRLS,每一列都讀得到)。計數表 `market_rate_counters` 只留兩天、沒有保存價值,不匯出。
   2. 先乾跑還原(線上已經有三支 migration,所以不帶 `--with-migration`):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      RK=supabase/rollbacks/20261009130200_market_checkout.down.sql
      RN=supabase/rollbacks/20261009130100_market_notify.down.sql
      RO=supabase/rollbacks/20261009130000_market_orders.down.sql
      node scripts/supabase-sql.mjs dry supabase/tests/database/market_phase2_rollback.test.sql --with-rollback $RK --with-rollback $RN --with-rollback $RO
      node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
      ```
      Expected:`共 4 項,失敗 0 項`;殘留五個 `0`。
   3. 正式還原,**130200 → 130100 → 130000**,整份檔案當成一個請求送出(= 一個交易;`send_sql` 跟第 1 階段還原第 2-3 步同一支),前一支回 `[]` 才送下一支:
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
      send_sql() {  # 整份檔案 = 一個請求 = 一個交易;成功印 [],失敗印 {"message":"Failed to run sql query: …"}(已整支回滾)
        J=$(mktemp)
        node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[2], JSON.stringify({ query: fs.readFileSync(process.argv[1], "utf8") }))' "$1" "$J"
        curl -s -X POST "https://api.supabase.com/v1/projects/cwvpehqcvbfuynabpqop/database/query" \
          -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
          -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36" \
          --data-binary @"$J"
        echo
      }
      OUT2=$(send_sql supabase/rollbacks/20261009130200_market_checkout.down.sql); echo "130200: $OUT2"
      [ "$OUT2" = "[]" ] && OUT1=$(send_sql supabase/rollbacks/20261009130100_market_notify.down.sql) && echo "130100: $OUT1"
      [ "$OUT1" = "[]" ] && OUT0=$(send_sql supabase/rollbacks/20261009130000_market_orders.down.sql) && echo "130000: $OUT0"
      ```
      Expected:`130200: []`、`130100: []`、`130000: []`。任何一支不是 `[]`,後面的不會送,停下來回報。
   4. 還原後確認(唯讀):
      ```bash
      cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
      SELECT json_build_object(
        'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations
                    WHERE version IN ('20261009130000', '20261009130100', '20261009130200')),
        'phase2_tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                           AND relname IN ('market_orders', 'market_order_items', 'market_order_events', 'market_rate_counters', 'market_rate_blocks_daily')),
        'phase2_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (
                              'market_place_order', 'market_checkout_status', 'market_get_orders', 'market_rate_take', 'market_rate_key',
                              'market_client_ip', 'market_normalize_ip', 'market_mask_phone', 'market_mask_email', 'market_enqueue_notify',
                              'market_notify_event', 'market_guard_event', 'market_apply_event', 'market_events_immutable',
                              'market_events_one_per_order', 'market_transition_rules', 'market_order_status_label', 'market_phone_ok', 'market_email_ok')),
        'cleanup_cron', (SELECT count(*) FROM cron.job WHERE jobname = 'ifoodmap-market-rate-cleanup'),
        'phase2_config', (SELECT count(*) FROM public.app_config
                           WHERE key IN ('market_checkout_open', 'market_rate_salt', 'market_notify_function_url')),
        'phase1_tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                           AND relname IN ('market_stores', 'market_store_transfer', 'market_products'))
      ) AS phase2_rollback;" > "$Q"
      node scripts/supabase-sql.mjs ro "$Q"
      ```
      Expected:`ledger`、`phase2_tables`、`phase2_functions`、`cleanup_cron`、`phase2_config` 都是 `0`;`phase1_tables` 是 `3`(第 1 階段不受影響)。
      (匯出、三支還原檔、這個確認 2026-10-11 在本機一次性的 Postgres 依序跑過;結果跟上面的 Expected 一樣。)
   5. `market-notify` 不用刪(沒人呼叫就不會寄信);要停用可在 Dashboard → Edge Functions 刪掉那支。`notifications` 裡的零售紀錄留著(那張表不屬於這三支 migration)。
3. **repo**:2026-10-11 的部署是 fast-forward(origin/main `6bf196e` → `79a13aa`),**沒有合併 commit**,`git revert -m 1` 用不上。改成把整段退成一個 commit:
   `git revert --no-commit 6bf196e..79a13aa && git commit -m "revert: 消費者食材市集第 2 階段"` 再 push
   (三支 migration 跟前端一起退,`check-migrations` 才不會一直紅);之後要重新上線,revert 這個 revert commit。
   前端也可以先用 Vercel Instant Rollback 退到 `6bf196e` 那一版。

### 對外開放前待辦(第 3 階段,需要業主核准)

第 2 階段上線之後,下面每一條都要業主決定或核准。**2026-10-12 業主已核准對外開放**,每一條現在的狀態見「第 3 階段」的對照表;
🔴 打開下單(`market_checkout_open` 改成 `'true'`)與寄信(`MARKET_NOTIFY_LIVE`)只照「開放當天的順序(第 3 階段)」做,由派工者指定的人執行,其他任務不要自己設定。

1. **Supabase 升級 Pro**:免費方案閒置會暫停,暫停期間市集打不開、下單失敗,等於關店。
   (2026-10-12:業主接受用免費方案開放的風險;升級 Pro 是業主要盡快自己處理的事。)
2. **服務條款與隱私權政策定稿**:`/market/terms`、`/market/privacy` 現在是工程擬的草稿(頁面上標「草稿」),七天解除權的例外、個資保存年限、平台責任範圍
   都要請法律專業確認後定稿(定稿時改 `src/lib/market/legal.ts`:文字 → `LEGAL_DRAFT = false` → 換新的 `TERMS_VERSION`)。
   (2026-10-12:業主核准用查證後的版本直接定稿,沒有經過律師審閱,業主接受這個風險;做法見「開放當天的順序」第 2 步。)
3. **`MARKET_NOTIFY_LIVE` 和 `market_checkout_open` 要一起打開**:查單頁寫著「店家接單後會寄信通知你」,只開下單、不開寄信,這句話就不實
   (消費者、店家都收不到任何信,消費者也拿不到下單確認信裡的查詢連結;結帳頁的轉帳說明、供應商後台的接單說明也都寫消費者會收到信)。
   (2026-10-12:業主核准,開放當天一起打開,見「開放當天的順序」第 4、5 步。)
4. **目前沒有人機驗證**:全站每天 500 單的上限,可以被「真的建單」的假訂單吃光 —— 每個 IPv4、每個 IPv6 /48 每天各 20 單,大約 25 個 IPv4 或 25 個 /48,
   加上一批假 Email 和電話(每個每天 10 單)就夠;吃光之後當天真的消費者全部下不了單。考慮加 Cloudflare Turnstile。
5. **待接單沒有逾時自動取消**:假的貨到付款單會一直佔著庫存,直到店家拒單。
   **已處理**(加固 20261012100000):待接單、或轉帳單待匯款超過 72 小時,pg_cron 每 10 分鐘自動取消、補庫存、通知消費者與店家(見「第 3 階段」)。
6. **IP 標頭檢查**:限流靠的 IP 必須是偽造不了的那一個,偽造得了的話 IP 那幾條額度形同虛設(Email、電話、全站上限仍然有效)。
   IPv4 已在 2026-10-11 部署時用探測函式驗過、通過(見「部署」第 9-5 步);**還缺 IPv6**:找一個有 IPv6 的網路,照第 9-5 步用 `curl -6` 再做一次,
   確認 `used` 是 /64 的網段位址(若 Cloudflare 對這個網域開了 Pseudo IPv4,/64、/48 規則會失效)。
   另外,`market_client_ip()` 的最後退路原本是 `x-forwarded-for` **第一段**,用戶端偽造得了(獨立驗收 2026-10-11 的建議)——
   **已處理**(加固 20261012100000):順序改成 `cf-connecting-ip` → `x-real-ip` → NULL,不再信 XFF,NULL 算進 `noip`。**IPv6 /64 的實測仍是待辦。**
   開關打開之後**馬上**再用真的下單 RPC 做一次確認(「開放當天的順序」第 7 步)——
   用「部署」第 9-2 步的 `$API`、`$PK` 送一個**空購物車**的請求(帶 token 與偽造的 `X-Forwarded-For`、`X-Real-IP`;送請求和查自己的 IP 都用 IPv4,`-4`)。
   🔴 **不要帶 `CF-Connecting-IP`**:用戶端自己帶它,Cloudflare 會整個請求回 403 `error code: 1000`(「部署」第 9-5 步實測),看不到結果。
   空購物車在 A 段之後才擋,只會寫 A 段的 `ip` 計數、不建單、不吃 B 段:
   ```bash
   MYIP=$(curl -s -4 https://api.ipify.org)
   TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
   curl -s -4 -X POST "$API/rpc/market_place_order" -H "apikey: $PK" -H "Content-Type: application/json" \
     -H "X-Forwarded-For: 203.0.113.9" -H "X-Real-IP: 203.0.113.10" \
     -d "{\"p_checkout\":{\"token\":\"$TOKEN\",\"buyer\":{\"name\":\"IP 檢查\",\"phone\":\"0900000000\",\"email\":\"ip-check@example.com\",\"city\":\"臺北市\",\"address\":\"只是檢查不會建單\"},\"items\":[],\"terms_version\":\"ip-check\"}}"; echo
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
   WITH s AS (SELECT c.value AS salt FROM public.app_config c WHERE c.key = 'market_rate_salt'),
        cand(source, ip) AS (VALUES ('real', '$MYIP'), ('x-forwarded-for', '203.0.113.9'), ('x-real-ip', '203.0.113.10'))
   SELECT json_agg(json_build_object('source', cand.source, 'counted', EXISTS (
            SELECT 1 FROM public.market_rate_counters r
             WHERE r.bucket = 'ip:' || left(encode(sha256(convert_to(cand.ip || '|' || s.salt, 'UTF8')), 'hex'), 16) || '|1h'
               AND r.window_start > now() - interval '2 hours')) ORDER BY cand.source) AS ip_check,
          EXISTS (SELECT 1 FROM public.market_rate_counters r WHERE r.bucket = 'noip|1h' AND r.window_start > now() - interval '2 hours') AS noip_counted
     FROM cand, s;" > "$Q"
   node scripts/supabase-sql.mjs ro "$Q"
   ```
   Expected:第一個請求回 `{"ok": false, "code": "EMPTY_CART"}`;查詢只有 `"source": "real"` 是 `"counted": true`、`noip_counted` 是 `false`。
   偽造的有一個是 `true`(那個標頭偽造得了),或三個都是 `false`、`noip_counted` 是 `true`(PostgREST 拿不到 IP)→ 立刻把開關改回 `'false'`(「緊急關閉」第 1 步),
   另開 migration 讓 `market_client_ip()` 只認 Supabase 實際使用、偽造不了的那個標頭。(這個請求與查詢 2026-10-11 在本機一次性的 Postgres 實測過:
   開關關著回 `MARKET_CLOSED`、打開後回 `EMPTY_CART`,計數只記在被採用的那個 IP;正式環境只能在開放時驗。)
7. **量變大時看 `market_rate_blocks_daily`**(查詢見「怎麼查(第 2 階段)」):`ipo`、`ip48o` 每天 20 單最先會擋到真人(公司、學校、同一個手機業者的出口);
   要調整就另開 migration,用 `CREATE OR REPLACE FUNCTION public.market_place_order` 改數字。
8. **管理員總覽的「進行中」和「全部」各最多 200 張、沒有分頁**(其他篩選也一樣):更早的單在清單與搜尋裡都找不到(畫面會提示),放量後要改成伺服器分頁。
9. **管理員畫面是唯讀,但管理員帳號直接打 API 仍然可以取消訂單**(轉移表與 RLS 允許):刻意保留給處理客訴;要完全禁止得另開 migration。
10. **sessionStorage 被封鎖時重新整理會遺失查詢 token**:極少數瀏覽器(封鎖網站資料等)不能用 sessionStorage,token 只放在記憶體;這時斷線、又重新整理再送,
    而第一次其實已經成立,就會重複下單。
11. **被大量灌請求時,擋下紀錄會排隊**:每個被擋的請求都要更新 `market_rate_blocks_daily` 的同一列(今天、同一種規則),要等前一個交易 commit 才寫得進去,
    灌爆時被擋的請求會互相排隊。打開下單前,可以在被擋的那條路上加 `set_config('synchronous_commit', 'off', true)`(被擋的交易不建單,當機時少記幾筆無妨),
    等待時間會大幅縮短。目前下單開關是關的,沒有這個風險。
    **已處理**(加固 20261012100000):被擋的請求改用非同步 commit(`synchronous_commit` off,只影響被擋、不建單的交易)。

### 第 3 階段:對外開放(形象站入口;2026-10-12 業主核准)

第 2 階段 2026-10-11 上線(origin/main fast-forward 到 `79a13aa`,之後只有文件,到 `df4fc84`),獨立驗收通過。

🔴 **2026-10-12 業主核准對外開放**:第 3 階段的部署做完,就照下面「開放當天的順序」打開寄信閘門與下單、合併形象站入口;服務條款與隱私權政策用查證後的版本直接定稿。
業主同時**接受三項風險**:

1. 條款沒有經過律師審閱。
2. 業主還沒完整實測過(下面「業主實測」仍建議在打開之前做一輪)。
3. Supabase 仍是免費方案:閒置會暫停,暫停期間市集打不開、下單失敗(= 關店)。**升級 Pro 是業主要盡快自己處理的事**(Supabase Dashboard → 這個專案的 Organization → Billing)。

開放的操作由派工者另外指定的人照「開放當天的順序」執行;這份文件寫了指令,不代表其他任務可以執行。

- **形象站入口**:首頁「食材分類」標題旁的「個人也能買：逛食材市集 →」(英文「Buying for home? Visit the Food Market →」),網址 `marketUrl` = 產品站 `/market`
  (跟其他產品站網址一樣從 `IFM_PRODUCT_BASE_URL` 推出來;`landing/index.html`、`landing/i18n.js`)。程式在分支 `market-launch`(另一位實作者正在做),
  **開放當天第 6 步才合併到 main**(push main 會自動部署形象站)。
- **加固 migration `20261012100000_market_hardening`**(第 3 階段唯一的資料庫變更;130000 / 130200 不改原檔,用 `CREATE OR REPLACE` 換掉三支函式、新增一支):
  - **72 小時自動取消**(`market_expire_orders()`,pg_cron `ifoodmap-market-expire-orders` 每 10 分鐘 `*/10 * * * *`):待接單從下單時間起、轉帳單從進入待匯款
    (最後一筆「待匯款」紀錄)起,超過 72 小時由系統寫一筆取消紀錄 —— 身分 system、payload `{"auto_expire": "pending" | "awaiting_payment"}`(取消前的狀態),
    原因「店家超過 72 小時沒有接單,系統自動取消」/「超過 72 小時沒有完成匯款,系統自動取消」。補庫存(只補 `stock_deducted`)與通知走既有的 trigger:
    消費者收到「訂單已自動取消(…)」、店家收到「零售訂單 #… 已逾時自動取消 — 請不要出貨」。每輪最多 200 張;有人正在操作的單(`FOR UPDATE SKIP LOCKED`)跳過,
    下一輪再來;已接單(貨到付款)、已收款、已出貨都不動。`auto_expire` 只有系統的取消能帶,供應商、管理員帶了會被 guard 擋(22023 `auto_expire_invalid`)。
    時數 72 只定義在 `market_expire_orders` 的常數,旁邊的 `-- @market-auto-cancel-hours 72` 由前端 `src/lib/market/autoCancel.ts` 與 `market-notify` 的測試對照。
    對應第 2 階段待辦第 5 條。
  - **`market_client_ip()` 不再信 `x-forwarded-for`**:順序 `cf-connecting-ip` → `x-real-ip` → NULL(NULL 算進 `noip`)。對應待辦第 6 條的 XFF 退路;IPv6 /64 實測仍是待辦。
  - **被擋的請求用非同步 commit**:`market_rate_take` 擋下時先 `set_config('synchronous_commit', 'off', true)` 再寫擋下紀錄;建單的路不動。對應待辦第 11 條。
- **跟 migration 一起上線的前端與通知信**:查單頁、供應商零售訂單頁、結帳頁寫出 72 小時的期限;`market-notify` 的新訂單、下單確認、待匯款信寫明期限,
  自動取消信分得出是逾時取消。`market-notify` 改了,這次要重新部署(「部署(第 3 階段)」第 3 步)。

**第 2 階段「對外開放前待辦」11 條的現況**(內容見那一節,這裡只寫狀態):

| 條 | 2026-10-12 的狀態 |
|---|---|
| 1 | 業主接受用免費方案開放的風險;升級 Pro 由業主盡快自己處理 |
| 2 | 業主核准用查證後的版本直接定稿(沒有律師審閱,業主接受);「開放當天的順序」第 2 步 |
| 3 | 業主核准;「開放當天的順序」第 4、5 步一起打開 |
| 4 | 沒做,仍是風險 |
| 5 | 已處理(20261012100000 的 72 小時自動取消) |
| 6 | XFF 退路已處理(20261012100000);IPv6 /64 實測仍待辦;「開放當天的順序」第 7 步用空購物車再驗一次 |
| 7 | 營運時看(「開放前檢查」的 `rate_blocks_7_days`) |
| 8 | 沒做,放量後改伺服器分頁 |
| 9 | 刻意保留 |
| 10 | 沒做(極少數) |
| 11 | 已處理(20261012100000 被擋的請求非同步 commit) |

### 部署(第 3 階段)

🔴 會改正式庫、重新部署 `market-notify`、部署兩個網站。照順序做,任何一步的 Expected 對不上就停下來回報。**這一節不打開任何開關**:
`market_checkout_open` 維持 `'false'`、不設 `MARKET_NOTIFY_LIVE`(那是「開放當天的順序」)。順序 **`market-notify` → migration → 前端**:
新的 `market-notify` 沒看到 `auto_expire` 時照一般文案,可以先上;migration 先套的話,函式重新部署之前的自動取消會寄成一般的「平台已取消」信
(計畫勘誤「market-notify 的 72 小時自動取消文案」);新前端會寫「72 小時沒接單會自動取消」,資料庫要先真的會取消。
在 repo 根目錄跑、各自 export token、查詢寫檔的方式,都跟第 1 階段一樣。

1. **確認本機乾淨、跟 origin 同步**:同第 1 階段第 1 步。
2. **上線前最後一次乾跑**(🔴 已上線的 120000–130200 都不帶;依序跑、不要並行;每支之後都跑殘留檢查):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   H=supabase/migrations/20261012100000_market_hardening.sql
   RH=supabase/rollbacks/20261012100000_market_hardening.down.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_hardening.test.sql --with-migration $H
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql --with-migration $H
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql --with-migration $H
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql --with-migration $H
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_hardening_rollback.test.sql --with-migration $H --with-rollback $RH
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:全部 `失敗 0 項`、每次殘留五個 `0`;項數以計畫檔尾勘誤「20261012100000」那一節為準。
   🔴 2026-10-12 寫這一步時,`market_hardening.test.sql`、`market_hardening_rollback.test.sql` 與還原檔還在寫、沒有 commit(檔名照 migration 檔頭);
   `market_checkout.test.sql` 第 86–87 行的「再沒有才用 x-forwarded-for 第一段」也正在改成「只有 XFF 回 NULL」—— 改好之後這支要帶加固跑(不帶的話那一項會紅,屬預期),
   沒改到的話帶加固跑那一項會紅,不能跳過。
3. **重新部署 `market-notify`**(先於 migration,理由見本節開頭):同第 2 階段「部署」第 6 步的兩段指令
   (🔴 一定要 `--no-verify-jwt --use-api`;部署後 `verify_jwt=false`、沒帶密鑰的 POST 回 `401`)。不用設定任何 secret,🔴 不要設 `MARKET_NOTIFY_LIVE`。
4. **套 migration**:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   node scripts/supabase-sql.mjs apply supabase/migrations/20261012100000_market_hardening.sql
   ```
   Expected:`已套用 20261012100000_market_hardening.sql;ledger:[{"version":"20261012100000","name":"market_hardening"}]`。出錯時的判斷同第 1 階段第 3 步。
5. **確認線上**:跑「開放前檢查(第 3 階段)」那一節的指令,固定值要是表裡「加固之後」那一欄 —— `migrations` 六個版本、`expire_orders_cron` = `"*/10 * * * *"`、
   `client_ip_ignores_xff`、`blocked_async_commit` = `true`,其餘固定值不變、`checkout_open` 還是 `false`;另跑
   `SUPABASE_PROJECT_REF=cwvpehqcvbfuynabpqop node scripts/check-migrations.mjs`(✅,repo 47 個、線上 47 個)。
   (這幾個「加固之後」的值,2026-10-12 在本機一次性的 Postgres 載入 120000–130200 與 20261012100000 草稿實測過;同時實測了兩張逾時的單被取消、
   原因與 `auto_expire` 照上面寫的、庫存補回、通知排進 pg_net、再跑一次取消 0 張、供應商冒充 `auto_expire` 被擋。)
6. **用線上 schema 再跑一次測試**(不帶 `--with-migration`)與還原檔的乾跑:
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   RH=supabase/rollbacks/20261012100000_market_hardening.down.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_hardening.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_orders.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_notify.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_checkout.test.sql
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   node scripts/supabase-sql.mjs dry supabase/tests/database/market_hardening_rollback.test.sql --with-rollback $RH
   node scripts/supabase-sql.mjs ro supabase/tests/database/market_residue.sql
   ```
   Expected:同第 2 步。
7. **push 前端**(2026-10-11 第 2 階段也是 fast-forward,沒有合併 commit):
   ```bash
   git -C /Users/aimand/.gemini/File/ifoodmap switch market
   git -C /Users/aimand/.gemini/File/ifoodmap status --short                           # 沒有輸出才繼續
   git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
   git -C /Users/aimand/.gemini/File/ifoodmap rev-list --count market..origin/main     # 0 才繼續
   git -C /Users/aimand/.gemini/File/ifoodmap rev-parse origin/main                    # 記下推之前的版本(還原要用)
   git -C /Users/aimand/.gemini/File/ifoodmap push origin market:main                  # 被拒就停,不要 --force、不要 rebase
   git -C /Users/aimand/.gemini/File/ifoodmap rev-parse market                         # 記下這次上線的版本
   ```
   push 被 403 擋:同第 1 階段第 6 步的 `gh auth switch` 做法。
8. **等 CI**:同第 1 階段第 7 步。
9. **線上驗證**:
   1. 新版真的上線了(只有新版的 bundle 才有這句;2026-10-12 部署前實測是舊版):
      ```bash
      js=$(curl -s https://app.ifoodmap.ai/market/cart | grep -o '/assets/index-[^"]*\.js' | head -1)
      curl -s "https://app.ifoodmap.ai$js" | grep -c "小時內沒有接單,訂單會自動取消"
      ```
      Expected:`1`(舊版是 `0`)。
   2. 再跑一次「開放前檢查」:固定值同第 5 步;套用超過 10 分鐘之後,`expire_orders_last_run_ok` = `true`。
   3. 開關還是關的:同第 2 階段「部署」第 9-2 步的第一行,`market_checkout_status` = `{"open": false, "can_order": false}`。
   4. 派一個沒參與實作的 agent 獨立驗收(只准讀、乾跑、唯讀查詢):上面每一步的 Expected、`MARKET_NOTIFY_LIVE` 不在 `supabase secrets list` 的名稱裡。

### 還原(第 3 階段)

只有前端有問題就只做第 1 步;加固本身出問題才往下做。順序 **前端 → `market-notify` → 資料庫 → repo**。

1. **前端**:Vercel → `dish-to-supply`、`ifoodmap-admin` → Instant Rollback 到「部署」第 7 步記下的「推之前的版本」(新前端寫了 72 小時的期限)。
2. **`market-notify`**:新版的新訂單、下單確認、待匯款信寫了「72 小時沒接單 / 沒匯款會自動取消」,資料庫退了就不成立,要一起退 ——
   從「推之前的版本」的 checkout(例如 `git -C /Users/aimand/.gemini/File/ifoodmap worktree add <暫存資料夾> <推之前的版本>`)用第 2 階段「部署」第 6 步同一行指令部署
   (`--no-verify-jwt --use-api`),確認 `verify_jwt=false` 後 `git worktree remove` 那個資料夾。
3. **資料庫**:用第 2 階段還原第 2-3 步的 `send_sql` 送 `supabase/rollbacks/20261012100000_market_hardening.down.sql`,回 `[]` 才算成功。
   還原之後 `market_client_ip()`、`market_rate_take`、`market_guard_event` 回到 130000 / 130200 的樣子,自動取消的函式與排程拆掉
   (開放前檢查的 `expire_orders_cron` 變回 `null`、`client_ip_ignores_xff` 與 `blocked_async_commit` 變回 `false`)。
   已經被自動取消的單照樣是已取消(紀錄只能新增)。🔴 還原檔進 repo 之後先讀它的檔頭,以檔頭寫的為準。
4. **repo**:`git revert --no-commit <推之前的版本>..<這次上線的版本> && git commit -m "revert: 消費者食材市集第 3 階段"` 再 push
   (同第 2 階段還原第 3 步的寫法;migration 跟前端一起退,`check-migrations` 才不會一直紅)。

### 開放前檢查(第 3 階段)

唯讀查詢 `supabase/tests/database/market_launch_readiness.sql`:只回數字、true / false 與不涉密的設定(版本、排程、bucket),不印任何密鑰、鹽、個資。
開放前、開放當天、之後營運時(建議每天)都可以跑:

```bash
cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" node scripts/supabase-sql.mjs ro supabase/tests/database/market_launch_readiness.sql
```

**固定值**(每次都應該一樣;「現在」是 2026-10-12 00:26 在正式庫實測,當時加固還沒套用):

| 項目 | 意義 | 現在 | 加固之後 / 開放時 | 不對時怎麼辦 |
|---|---|---|---|---|
| `migrations` | 市集的 migration 有哪些已經套用 | 120000、120100、130000、130100、130200 | 再多 `20261012100000` | 少了 = 那一階段的部署沒做完,停下來查 |
| `checkout_open` | 下單開關 | `false` | 開放當天第 5 步之後 `true` | 還沒到第 5 步就是 `true` = 有人提早打開:照「緊急關閉」第 1 步關回去並回報 |
| `notify_url_ok`、`notify_key_set` | 資料庫叫得到 `market-notify`(密鑰只檢查有沒有,不印值) | `true`、`true` | 同 | `false` = 一封信都不會寄,先查 `app_config` 的設定 |
| `rate_salt_set` | 限流雜湊用的鹽 | `true` | 同 | `false` = 停下來回報 |
| `rate_cleanup_cron`、`cron_cleans_blocks` | 限流計數與擋下紀錄的清理排程 | `"50 19 * * *"`、`true` | 同 | 不對 = 計數表會一直長大 |
| `rate_cleanup_last_run_ok` | 清理排程最近一次成功 | `null`(還沒跑過) | `true` | `false` = 看 `cron.job_run_details` 的 `return_message` |
| `image_bucket`、`image_bucket_versioning`、`image_policies` | 商品照片的 bucket:公開、2 MB、jpeg / png / webp、不開版本、2 條 policy(select、insert) | `{"public": true, "file_size_limit": 2097152, …}`、`"DISABLED"`、`2` | 同 | 不對 = 照片可能被覆寫或傳不上去,回報 |
| `anon_can_read_orders`、`anon_can_read_transfer` | 未登入讀不到訂單、轉帳資訊 | `false`、`false` | 同 | `true` = 個資外洩:立刻「緊急關閉」並回報 |
| `anon_can_place_order` | 未登入叫得到下單 RPC | `true` | 同 | `false` = 消費者下不了單 |
| `api_can_touch_rate_tables` | 未登入 / 登入者碰得到限流的兩張表 | `false` | 同 | `true` = 可以把限流歸零,回報 |
| `tmp_ip_probe_absent` | 第 2 階段部署時暫時建的 IP 探測函式已刪掉 | `true` | 同 | `false` = 回報派工者刪掉它(`DROP FUNCTION public.market_tmp_ip_probe();`,要寫入權限) |
| `expire_orders_cron` | 72 小時自動取消的排程 | `null` | `"*/10 * * * *"` | 加固之後還是 `null` = 自動取消沒在跑 |
| `expire_orders_last_run_ok` | 自動取消排程最近一次成功 | `null` | 套用 10 分鐘後 `true` | `false` = 看「怎麼查(第 2 階段)」的排程執行紀錄 |
| `client_ip_ignores_xff` | `market_client_ip()` 已不讀 `x-forwarded-for` | `false` | `true` | 加固之後還是 `false` = 加固沒套到 |
| `blocked_async_commit` | 被擋的請求非同步 commit | `false` | `true` | 同上 |

**營運數字**(照實記;2026-10-12 00:26 全部是 0 / 空的:還沒有任何店家、商品、訂單):

| 項目 | 意義 | 開放時 | 遇到時怎麼辦 |
|---|---|---|---|
| `stores_open` | 營業中的店家(零售啟用 + 供應商帳號啟用) | 至少 1 家 | 0 = 開了也沒東西賣,先請供應商開店 |
| `stores_open_bad_contact_email` | 營業中、但聯絡信箱是空的或格式不對(跟 `market-notify` 寄信前的檢查同一條規則) | 0 | > 0 = 這幾家收不到新訂單信:請店家在供應商資料補正 Email |
| `stores_transfer_without_info` | 收轉帳、轉帳資訊卻被店家刪掉 | 0 | > 0 = 那幾家的轉帳結帳會失敗(`PAYMENT_NOT_ACCEPTED`):請店家補轉帳資訊,或取消勾轉帳 |
| `products_listed` | 消費者看得到的商品 | 至少 1 個 | 0 = 先審核、上架 |
| `products_pending_review`、`products_pending_over_2_days` | 待審的商品、等超過 2 天的 | 照實 | 超過 2 天的 > 0 = 提醒管理員到「零售市集 › 商品審核」 |
| `orders_total`、`orders_by_status` | 訂單總數、各狀態幾張 | 照實 | — |
| `orders_pending_over_1_day` | 超過 1 天還沒接單 | 0 為佳 | > 0 = 提醒店家接單(滿 72 小時會被自動取消) |
| `orders_pending_over_72h`、`orders_awaiting_payment_over_72h` | 該被自動取消、還沒取消的單 | 0(排程每 10 分鐘,最多晚 10 分鐘) | 持續 > 0 = 自動取消沒在跑:看排程執行紀錄(「怎麼查(第 2 階段)」) |
| `orders_paid_unshipped_over_3_days` | 已收款超過 3 天還沒出貨 | 0 | > 0 = 收了錢沒出貨,客訴風險最高:聯絡店家 |
| `notify_failed_7_days` | 7 天內零售通知寄失敗(含 Email 格式不對沒寄的) | 0 | > 0 = 管理後台「通知紀錄」或「怎麼查(第 2 階段)」看原因 |
| `rate_blocks_7_days` | 今天與前 6 天,依規則加總的擋下次數 | `{}` 為佳 | `ipo` / `ip48o` 多 = 共用網路擋到真人,考慮調高(待辦第 7 條);`global` 有 = 那天 500 單滿了;`noip` 有 = 見下一列 |
| `noip_blocked_24h`、`noip_attempts_24h` | 拿不到 IP 的請求:24 小時內被擋過、沒被擋的嘗試次數 | `false`、`0` | `true` / > 0 = IP 取得壞了(正式請求都該帶 `cf-connecting-ip`):查 Cloudflare / Supabase 的標頭,必要時「緊急關閉」 |

- 欄位與函式都對照過 migration 120000 / 120100 / 130000 / 130100 / 130200 與 20261012100000(草稿)。店家「營業中」的條件直接寫(零售啟用 + 供應商帳號啟用),
  沒有呼叫 `market_store_is_open()`:那支只開給 anon / authenticated / service_role,唯讀端點的角色叫它會 42501(2026-10-12 實測)。

### 業主實測(第 3 階段)

建議在「開放當天的順序」第 4 步之前做完:那時寄信閘門還關著(所有信只寄 `ifoodmaptw@gmail.com`、主旨開頭「[測試轉寄]」),
下單開關也關著(只有平台管理員能下單)。業主自己在瀏覽器操作,每一步打勾,有問題就截圖。🔴 代理人不准替業主輸入任何密碼。

1. **測試供應商開店、上架**(用測試用的供應商帳號登入 https://app.ifoodmap.ai,不要用真實店家)
   - [ ] 「零售市集 › 店家設定」:勾配送縣市(例如臺北市)、填運費與免運門檻、勾「貨到付款」和「銀行轉帳」並填轉帳資訊、上傳 logo → 儲存。
   - [ ] 「商品與價格 › 商品目錄」→「零售商品(給消費者)」分頁 →「新增零售商品」:填品名、規格、價格、各傳 1–2 張照片 →「送出審核」。新增 2 個,其中一個庫存填 3。
2. **管理員核准**(平台管理員帳號登入管理員站 https://ifoodmap-admin.vercel.app)
   - [ ] 「零售市集 › 商品審核」:每個商品按「查看」,等每張照片的主圖和縮圖都出現後按「核准上架」。
3. **管理員在 /market 下單**
   - [ ] 用無痕視窗開 https://app.ifoodmap.ai/market:看得到店家與兩個商品;加入購物車後,購物車寫「線上訂購還沒對外開放…」(開關關著,這是對的)。
   - [ ] 用平台管理員帳號登入 https://app.ifoodmap.ai,再到 https://app.ifoodmap.ai/market/cart:寫「市集還沒對外開放;你是平台管理員,可以下測試單。」
         →「前往結帳」→ 收件 Email 填你自己的 → 這家店選「銀行轉帳」→ 送出 → 看到「訂單已送出…」與查詢網址,按「複製連結」存起來。
   - [ ] 再下一張「貨到付款」的單(等一下用來測拒單)。
4. **供應商接單、出貨**(測試供應商帳號,「零售市集 › 零售訂單」)
   - [ ] 轉帳那張:「接單」→ 狀態變「待匯款」(打開剛才的查詢網址,看得到匯款資訊與匯款期限)→「確認已收款」→「出貨」(填物流、單號)→「標記完成」。
   - [ ] 貨到付款那張:「拒單」(填原因)→ 查詢頁顯示原因;限量那個商品的庫存加回來。
5. **到 ifoodmaptw@gmail.com 確認測試轉寄信**(主旨都是「[測試轉寄]」開頭、內文最上面寫原本的收件人)
   - [ ] 「訂單已送出」兩封(各附查詢連結,點得開)、「新的零售訂單」兩封(寄給店家的)、「請匯款」、「已出貨」、「店家無法接單」各一封;
         確認已收款、標記完成不寄信。
6. **收尾**
   - [ ] 管理員站「零售市集 › 零售訂單」看得到這兩張單與時間軸。
   - [ ] 管理員站「零售市集 › 零售店家」把測試店家「停用零售」(原因寫「測試店家」),消費者就看不到它的商品。測試訂單刪不掉(紀錄只能新增),留著無妨。

業主做完後,代理人用唯讀查詢佐證(只看各狀態的數量,不印個資):

```bash
cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" && Q=$(mktemp) && printf '%s\n' "
SELECT json_build_object(
  'orders_by_status', (SELECT COALESCE(json_object_agg(s.status, s.n ORDER BY s.status), '{}'::json)
                         FROM (SELECT status, count(*) AS n FROM public.market_orders GROUP BY status) s),
  'market_mails_24h', (SELECT COALESCE(json_object_agg(m.status, m.n ORDER BY m.status), '{}'::json)
                         FROM (SELECT status, count(*) AS n FROM public.notifications
                                WHERE message LIKE '零售%' AND created_at > now() - interval '1 day' GROUP BY status) m),
  'forwarded_only', (SELECT bool_and(recipient = 'ifoodmaptw@gmail.com') FROM public.notifications
                      WHERE message LIKE '零售%' AND status = 'sent' AND created_at > now() - interval '1 day'),
  'net_status_codes_24h', (SELECT COALESCE(json_object_agg(COALESCE(r.status_code::text, 'none'), r.n), '{}'::json)
                             FROM (SELECT status_code, count(*) AS n FROM net._http_response
                                    WHERE created > now() - interval '1 day' GROUP BY status_code) r)
) AS owner_test;" > "$Q"
node scripts/supabase-sql.mjs ro "$Q"
```

Expected:`orders_by_status` 有 `completed` 1、`rejected` 1;`market_mails_24h` 只有 `sent`(沒有 `failed`);`forwarded_only` = `true`(閘門還關著,全部轉寄內部信箱);
`net_status_codes_24h` 以 `200` 為主(`net._http_response` 只留最近幾小時,查不到不算失敗)。(2026-10-12 00:2x 在正式庫唯讀跑過一次:四項都是空的。)

### 開放當天的順序(第 3 階段)

🔴 **業主 2026-10-12 已核准,由派工者指定的人照順序做**;前提是上面「部署(第 3 階段)」已經做完、獨立驗收通過。每一步的 Expected 對不上就停,
需要退的話照「緊急關閉」。先開寄信(第 4 步)再開下單(第 5 步),第一張真的訂單的確認信才會寄到消費者本人;兩步之間只有平台管理員能下單,不要隔太久。

1. **再跑一次開放前檢查**(「開放前檢查」那一節的指令):固定值全部是「加固之後」那一欄;`stores_open`、`products_listed` 至少 1(不然開了沒東西賣);
   `stores_open_bad_contact_email`、`stores_transfer_without_info`、`notify_failed_7_days` 是 0。另外確認寄信閘門還沒設(只看名稱):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)" supabase secrets list --project-ref cwvpehqcvbfuynabpqop | grep -c MARKET_NOTIFY_LIVE
   ```
   Expected:`0`。
2. **條款定稿**(在 `market` 分支):
   - `src/lib/market/legal.ts`:兩份文件(`/market/terms`、`/market/privacy`)的文字換成查證後的版本、`updated` 改成定稿日;`LEGAL_DRAFT = false`(頁面上的「草稿」提示就不會出現);
     `TERMS_VERSION` 換新版本(20 字以內,例如 `2026-10-12`;訂單會記下消費者同意的版本,舊的測試單照樣是 `2026-10-draft`)。
   - 測試跟著改:`src/pages/market/MarketLegalPage.test.tsx` 現在斷言 `LEGAL_DRAFT` 是 `true`、頁面上有「草稿:本文件待業主與法律專業確認後定稿。」(第 21–22、41–48 行),
     改成斷言沒有草稿提示;`src/lib/market/checkout.test.ts` 裡的 `"2026-10-draft"` 只是測試資料,不用改。
   - vitest 全套、tsc、eslint、兩種 build 照實作計畫「執行前必讀」F 節的指令跑,都過了才 commit(只帶改到的檔)。
3. **推前端**:同「部署(第 3 階段)」第 7–8 步(fast-forward push `market:main`、記下版本、等 CI)。確認新版上線:
   ```bash
   js=$(curl -s https://app.ifoodmap.ai/market/terms | grep -o '/assets/index-[^"]*\.js' | head -1)
   curl -s "https://app.ifoodmap.ai$js" | grep -c "2026-10-draft"
   ```
   Expected:`0`(2026-10-12 部署前實測是 `1`)。再用瀏覽器開 https://app.ifoodmap.ai/market/terms 與 `/market/privacy`:最上面沒有「草稿」提示、內容是定稿版。
4. **打開寄信閘門 `MARKET_NOTIFY_LIVE`**(值一定要剛好是小寫的 `true`,`gate.ts` 只認這個字串;改 secret 會讓專案所有 Edge Function 重新部署一次):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   supabase secrets set MARKET_NOTIFY_LIVE=true --project-ref cwvpehqcvbfuynabpqop
   supabase secrets list --project-ref cwvpehqcvbfuynabpqop | grep -c MARKET_NOTIFY_LIVE
   ```
   Expected:`1`(只看名稱,第二欄是值的雜湊、不是值)。接著照第 2 階段「部署」第 6 步的確認指令,確認 `market-notify` 還是 `ACTIVE verify_jwt=false`。
5. **打開下單 `market_checkout_open`**(用第 2 階段還原第 2-3 步的 `send_sql`,同一個 shell 先貼那個函式):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   Q=$(mktemp) && printf '%s\n' "update public.app_config set value = 'true', updated_at = now() where key = 'market_checkout_open';" > "$Q" && send_sql "$Q"
   ```
   Expected:`[]`。接著照第 2 階段「部署」第 9-2 步取得 `$API`、`$PK`,`market_checkout_status` 應該是 `{"open": true, "can_order": true}`。
6. **合併 `market-launch`(形象站入口)**:
   ```bash
   git -C /Users/aimand/.gemini/File/ifoodmap status --short                                   # 沒有輸出才繼續
   git -C /Users/aimand/.gemini/File/ifoodmap fetch origin
   git -C /Users/aimand/.gemini/File/ifoodmap diff --stat origin/main...market-launch          # 只動 landing/
   git -C /Users/aimand/.gemini/File/ifoodmap switch main
   git -C /Users/aimand/.gemini/File/ifoodmap merge --ff-only origin/main
   git -C /Users/aimand/.gemini/File/ifoodmap merge --no-ff market-launch -m "Merge branch 'market-launch':形象站食材市集入口"
   cd /Users/aimand/.gemini/File/ifoodmap/landing && npm test                                 # 全部 pass、0 fail
   git -C /Users/aimand/.gemini/File/ifoodmap push origin main
   git -C /Users/aimand/.gemini/File/ifoodmap rev-parse HEAD                                   # 記下合併 commit(緊急關閉要用)
   git -C /Users/aimand/.gemini/File/ifoodmap switch market
   git -C /Users/aimand/.gemini/File/ifoodmap merge --ff-only main
   ```
   等 `Landing – Deploy to Vercel (Production)` 綠燈(`gh run list --repo ifoodmap-ai/ifoodmap-ai --commit <合併 commit>`),再用瀏覽器開 https://ifoodmap.ai/ 與
   https://ifoodmap.ai/en:「食材分類」標題旁有入口,點下去是 https://app.ifoodmap.ai/market。
7. **開放當下的 IP 驗證**:照第 2 階段「對外開放前待辦」第 6 條的空購物車做法(🔴 不帶 `CF-Connecting-IP`)。Expected:`EMPTY_CART`;只有 `real` 被計數、
   `noip_counted` = `false`。不對就立刻做「緊急關閉」第 1 步,另開 migration 處理。
8. **開放後一小時內**再跑一次「開放前檢查」:`notify_failed_7_days`、`noip_attempts_24h` 是 0。有真的訂單之後再跑一次「業主實測」的佐證查詢:
   `market_mails_24h` 只有 `sent`,`forwarded_only` 變成 `false`(閘門已開,信寄給消費者與店家本人)。

### 緊急關閉(第 3 階段)

照順序做;做完回報派工者與業主。已成立的訂單照常由店家處理,72 小時自動取消也照常跑。

1. **下單開關改回關**(馬上生效,之後只有平台管理員能下單):
   ```bash
   cd /Users/aimand/.gemini/File/ifoodmap && export SUPABASE_ACCESS_TOKEN="$(cat <token 檔>)"
   Q=$(mktemp) && printf '%s\n' "update public.app_config set value = 'false', updated_at = now() where key = 'market_checkout_open';" > "$Q" && send_sql "$Q"
   ```
   (`send_sql` 是第 2 階段還原第 2-3 步那個函式,同一個 shell 先貼上。)Expected:`[]`;`market_checkout_status` 變回 `{"open": false, "can_order": false}`。
2. **寄信改回只寄內部信箱**:`supabase secrets unset MARKET_NOTIFY_LIVE --project-ref cwvpehqcvbfuynabpqop`(會讓所有 function 重新部署一次;
   之後 `supabase secrets list` 的名稱裡沒有它)。🔴 unset 之後,已成立訂單的後續通知(接單、出貨、取消、自動取消)也改寄內部信箱,真的消費者收不到 ——
   只是要停止接單的話做第 1 步就好,信件本身出問題才做這一步。
3. (需要時)**形象站入口退掉**:`git -C /Users/aimand/.gemini/File/ifoodmap revert -m 1 --no-edit <開放當天第 6 步記下的合併 commit>` 再 push main
   (會觸發形象站部署);或 Vercel → `ifoodmap-landing` 專案 → Instant Rollback 到合併之前那一版。
