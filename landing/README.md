# iFoodMap 食材地圖 — 形象網站（部署原始碼）

> **2026-09-28 起，形象站原始碼住在 `ifoodmap-ai/ifoodmap-ai` 的 `landing/`**（連同完整歷史從 `ifoodmap-ai/ifoodmap-landing` 併進來）。
> 舊 repo 已凍結、準備封存，**不要再 push 到舊 repo** —— 它的部署 workflow 停用前，推上去會用舊內容蓋掉正式站。
> 現在怎麼部署，見 repo 根目錄 `docs/DEPLOY.md` 的「形象站（landing/）」一節。下文的 `ifoodmap_deploy/` 就是現在的 `landing/`。

> 給 **Claude Code** 的交接包。這份包裡的 **就是網站本身的原始碼**，直接部署即可 **100% 還原**設計師交付的成品——不是用其他框架重寫的版本，所以不會有任何視覺誤差。

---

## 0. 為什麼這樣能 100% 還原

`index.html` 是網站的**實際渲染原始檔**，搭配同層的 `support.js`（執行階段）即可在任何瀏覽器／靜態主機呈現出與設計稿**像素級完全一致**的畫面與互動。

- 你不需要把它「重做成 React」。重做才會有誤差；**直接部署這份原始碼**就是 100% 還原。
- 另附 `standalone.html`：把字體、執行階段全部內嵌的**單一離線檔**，雙擊就能開、零依賴，作為 100% 視覺驗收基準與離線備援。

---

## 1. 檔案說明

```
ifoodmap_deploy/
├─ index.html          ← 網站主檔（可編輯原始碼；載入 /support.js）★ 部署這個
├─ support.js          ← 執行階段，必須放在站台根目錄
├─ routing.js          ← 網址 ↔ {頁面, 語系}、canonical / hreflang / <html lang>
├─ savings.js          ← /suppliers「作業成本試算」的算法(純函式,tests/savings.test.cjs 釘住)
├─ i18n.js             ← 中英字典 + 語系偵測（改文案改這裡，見 docs/I18N.md）
├─ api/                ← Vercel Serverless：AI 助手轉給 Supabase Edge Function
├─ assets/             ← 站上的 SVG 插圖
├─ tests/              ← node --test（npm test）
├─ scripts/            ← 瀏覽器實跑的語系煙霧測試（見 scripts/README.md）
├─ standalone.html     ← 100% 離線單一檔（舊版視覺基準，已不隨新版更新）
├─ vercel.json         ← Vercel 靜態部署設定 + 12 條語系 rewrite
├─ package.json        ← 本機預覽與測試
├─ .env.example        ← 接後端時的環境變數範本
├─ supabase_schema.sql ← 之後接資料庫用的建表 SQL
├─ README.md           ← 本檔
├─ DEPLOY.md           ← 逐步部署（GitHub→Vercel→Supabase→Railway）
├─ news.js             ← 文章資料（由 scripts/build-news.mjs 產生）
├─ docs/I18N.md        ← 中英雙語怎麼運作（含三個踩過的坑）
└─ docs/NEWS.md        ← 最新消息／文章區怎麼運作
```

---

## 2. 本機預覽（30 秒驗證 100% 還原）

```bash
cd ifoodmap_deploy
npm run dev
# 開 http://localhost:3000
```
> 注意：`npx serve` 不會套用 `vercel.json` 的 rewrite，所以 `/suppliers`、`/en` 這類深層網址在本機會 404，
> 只有 `/` 打得開。要完整驗證語系路由請部署到 Vercel preview，或自己寫一個會讀 `vercel.json` 的小伺服器。
> 直接用 `file://` 開 `index.html` 可能因瀏覽器限制讀不到 `support.js`；請用上面的本機伺服器，或部署後驗證。`standalone.html` 則可直接雙擊開。

---

## 3. 這個網站怎麼運作（給接手者）

- 單頁應用：**首頁 / 餐廳方案 / 供應商方案 / 成功案例 / 關於我們 / 聯絡我們** 都在 `index.html` 內。
  有真實網址（`/suppliers` 這類，靠 `vercel.json` 的 rewrite 全部回到 `/`，再由 `routing.js` 決定渲染哪一頁），
  所以**靜態託管單一檔即可**，但連結分享得出去、Google 也索引得到。
- **中英雙語**：中文是 `/xxx`、英文是 `/en/xxx`；裸網址 `/` 只有「按過語言鈕」的人會被自動轉到他選的版本，
  只是瀏覽器語系不同的人改在首頁頂端看到一條語系提示條（2026-09-24 起，不再依瀏覽器語系自動轉）。
  詳見 `docs/I18N.md`。
- 視覺系統、動畫、頁面內容的完整規格，見隨附的 `design_handoff_ifoodmap`（若一併取得）或本檔第 5 節摘要。
- 插圖是 `assets/` 底下自製的品牌 SVG（不是斜紋佔位圖，那批已在首頁改版時換掉）。
- 聯絡頁表單**已接上 Supabase**（寫入 `landing_leads`，匿名只寫不讀）；右下角還有 AI 採購助手會引導訪談並留下 lead。

---

## 4. 部署目標與分工

| 服務 | 角色 |
|---|---|
| **GitHub** | 原始碼版控，作為 Vercel 部署來源（push 自動上線）|
| **Vercel** | 靜態托管 `index.html`（網站本體）＋ 之後的 `/api` serverless（表單收件）|
| **Supabase** | 資料庫（需求單/供應商/媒合）、Auth、檔案儲存 |
| **Railway** | 背景工作：AI 媒合運算、LINE/Email 通知佇列（長時間/排程）|

**最小可上線**：只要 GitHub + Vercel，就能把 100% 還原的形象站部署上去。Supabase / Railway 是讓「需求表單 → 媒合 → 通知」真正運作的後續加值，文件已備妥。

詳細步驟見 **DEPLOY.md**。

---

## 5. 設計系統摘要（迭代時對齊）

- **主色**：`#3DAE2B`；漸層 `linear-gradient(135deg,#46c138,#1f9e4e)`；亮綠 `#7cf06b`；深色底 `#0a1510`（hero/服務）、`#081109`（footer）；淺底 `#F6F8F5`；卡片邊 `#e8efe6`；文字 `#0e1a12` / `#5b6b62` / `#8a9a8f`。
- **字體**：`Noto Sans TC`（中文/內文）＋ `Space Grotesk`（數字/英文標籤/標題拉丁字），均由 Google Fonts 載入。
- **圓角**：卡片 22–24、磚 18、輸入框 12、**按鈕膠囊 100**、CTA 區 30。
- **動畫**：捲動進場（CSS `animation-timeline: view()`，預設可見的安全 fallback）、統計數字 count-up、Hero 玻璃卡漂浮、綠點脈動、卡片 hover 浮起。
- 五頁區塊清單詳見 `index.html` 內的標記與 `design_handoff_ifoodmap/README.md`。

> 要改內容/版面：直接編輯 `index.html`（`<x-dc>` 內的 markup 與 `<script data-dc-script>` 內的 `class Component` 邏輯）。改完重新部署即可；`support.js` 不要動。
