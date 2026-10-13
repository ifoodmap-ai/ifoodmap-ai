# iFoodMap 市集示範資料 DEMO-LOG

建立時間：2026-10-13（prod cwvpehqcvbfuynabpqop）。寫入與核准在同一個交易（apply.sql），先以 dry.sql（BEGIN…ROLLBACK）乾跑通過。
照片：尚未上傳（photos = {}），前端顯示分類圖示。店家 logo/cover 未做。

## iFoodMap 示範｜田野蔬果
- supplier_id（= market_stores.supplier_id）：`305febf2-6926-4424-af8a-f8857d6e26d0`
- contact_email：ifoodmaptw+demo1@gmail.com，phone 02-7704-5539
- 店頁：https://app.ifoodmap.ai/market/s/305febf2-6926-4424-af8a-f8857d6e26d0
- 商品：
  - 【示範】有機高麗菜 NT$120 — `253df9dd-b9eb-47e1-a889-97621d0bd96e`（https://app.ifoodmap.ai/market/p/253df9dd-b9eb-47e1-a889-97621d0bd96e）
  - 【示範】宜蘭三星蔥 NT$120 — `846ffee5-a5c1-4e7a-9697-68868d743958`（https://app.ifoodmap.ai/market/p/846ffee5-a5c1-4e7a-9697-68868d743958）
  - 【示範】愛文芒果 NT$650 — `a2c4cf1f-0e5a-41d3-8dc0-ef93e262db50`（https://app.ifoodmap.ai/market/p/a2c4cf1f-0e5a-41d3-8dc0-ef93e262db50）
  - 【示範】關廟金鑽鳳梨 NT$150 — `509d8f52-2f0a-4c49-af2f-d9079d4cfb5a`（https://app.ifoodmap.ai/market/p/509d8f52-2f0a-4c49-af2f-d9079d4cfb5a）
  - 【示範】溫室小番茄 NT$180 — `2ffa7d5d-7a34-45cd-81e6-08ba58ce90da`（https://app.ifoodmap.ai/market/p/2ffa7d5d-7a34-45cd-81e6-08ba58ce90da）

## iFoodMap 示範｜港邊海鮮肉舖
- supplier_id（= market_stores.supplier_id）：`4c0baecf-197e-4aaf-beee-47bac586dedb`
- contact_email：ifoodmaptw+demo2@gmail.com，phone 02-7704-5539
- 店頁：https://app.ifoodmap.ai/market/s/4c0baecf-197e-4aaf-beee-47bac586dedb
- 商品：
  - 【示範】屏東養殖白蝦 NT$380 — `fd996f08-33eb-403b-8c14-689ff24efaeb`（https://app.ifoodmap.ai/market/p/fd996f08-33eb-403b-8c14-689ff24efaeb）
  - 【示範】台灣鯖魚片 NT$199 — `196d74a3-59da-4dd0-9e70-98ceb67f514c`（https://app.ifoodmap.ai/market/p/196d74a3-59da-4dd0-9e70-98ceb67f514c）
  - 【示範】溫體豬梅花肉片 NT$260 — `3521c7e6-64f5-4941-883b-de6babfaad4d`（https://app.ifoodmap.ai/market/p/3521c7e6-64f5-4941-883b-de6babfaad4d）
  - 【示範】放牧雞蛋 10 入 NT$120 — `fef7fae4-701d-47c7-9168-03d658de5221`（https://app.ifoodmap.ai/market/p/fef7fae4-701d-47c7-9168-03d658de5221）
  - 【示範】去骨雞腿排 NT$190 — `143b6096-f7ec-4416-ade4-d26ca86cd050`（https://app.ifoodmap.ai/market/p/143b6096-f7ec-4416-ade4-d26ca86cd050）

## iFoodMap 示範｜好食乾貨鋪
- supplier_id（= market_stores.supplier_id）：`52bac96b-fcaf-4c05-aa7e-9d4d92ade763`
- contact_email：ifoodmaptw+demo3@gmail.com，phone 02-7704-5539
- 店頁：https://app.ifoodmap.ai/market/s/52bac96b-fcaf-4c05-aa7e-9d4d92ade763
- 商品：
  - 【示範】台梗九號白米 NT$360 — `42a4792b-ba74-4230-b8d4-1b9adf208e21`（https://app.ifoodmap.ai/market/p/42a4792b-ba74-4230-b8d4-1b9adf208e21）
  - 【示範】花蓮富里糙米 NT$280 — `2ff4c2ec-c187-4f42-9362-6b7fc37842ac`（https://app.ifoodmap.ai/market/p/2ff4c2ec-c187-4f42-9362-6b7fc37842ac）
  - 【示範】純釀黑豆醬油 NT$280 — `7a648da2-1d2c-4ab2-9834-5423989fa3d2`（https://app.ifoodmap.ai/market/p/7a648da2-1d2c-4ab2-9834-5423989fa3d2）
  - 【示範】黑麻油 NT$260 — `0b28768d-f8df-4c94-b7df-ca20c7e2608f`（https://app.ifoodmap.ai/market/p/0b28768d-f8df-4c94-b7df-ca20c7e2608f）
  - 【示範】麻辣鍋底 NT$190 — `5b4953ed-9fc0-4949-bde8-88f1edc1ca39`（https://app.ifoodmap.ai/market/p/5b4953ed-9fc0-4949-bde8-88f1edc1ca39）

## 全部 supplier_id
```
'305febf2-6926-4424-af8a-f8857d6e26d0', '4c0baecf-197e-4aaf-beee-47bac586dedb', '52bac96b-fcaf-4c05-aa7e-9d4d92ade763'
```

## Demo 結束後藏起來
方法 A（後台）：用管理員帳號登入 → /admin/market/stores → 三家「iFoodMap 示範｜…」逐一按停用，原因填「示範結束」（setStoreEnabled 要求原因）。停用後 market_store_is_open 為 false，店與商品對公開頁面全部消失、不能下單。

方法 B（SQL，Management API 以管理員 claims 執行；guard 規定停用必填原因）：
```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"6263930b-2581-4675-a15a-8c0447aa7dde","app_metadata":{"role":"admin"}}', true);
UPDATE public.market_stores SET is_enabled = false, disabled_reason = '示範結束'
 WHERE supplier_id IN ('305febf2-6926-4424-af8a-f8857d6e26d0', '4c0baecf-197e-4aaf-beee-47bac586dedb', '52bac96b-fcaf-4c05-aa7e-9d4d92ade763');
COMMIT;
```
更徹底（後台供應商列表也藏）：再加 `UPDATE public.suppliers SET is_active = false WHERE id IN (...)`。
🔴 不建議 DELETE：若期間有人下了示範單，訂單會關聯這些店；且 market-images 的檔案刪不掉。

## 之後補照片
1. 本機生成照片：每張主圖長邊 1600px、縮圖 480px，小寫 .jpg，每檔 < 2MB，先 sips -Z 1024 出 preview 檢查。
2. 路徑：`<supplier_id>/<product_id>/<新uuid>.jpg` 與 `<同uuid>_t.jpg`；用 service role 上傳到 bucket market-images（只能寫一次，上傳前先確認）。
3. UPDATE photos：
   - 以**管理員 claims** UPDATE（同上方 set_config）：guard 走管理員分支，商品維持 approved，但會檢查每張主圖與 _t 都已在 Storage，缺檔就整句報錯 → 所以一定先上傳再 UPDATE。
   - 若改由供應商身分（或非管理員）UPDATE photos：已核准商品改照片會自動退回 pending，需再用管理員 claims `UPDATE ... SET review_status='approved'` 核准（同樣會檢查照片已上傳）。
   範例：
```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"6263930b-2581-4675-a15a-8c0447aa7dde","app_metadata":{"role":"admin"}}', true);
UPDATE public.market_products SET photos = ARRAY['<supplier_id>/<product_id>/<uuid>.jpg'] WHERE id = '<product_id>';
UPDATE public.market_products SET review_status = 'approved' WHERE id = '<product_id>' AND review_status = 'pending';
COMMIT;
```

## 驗收紀錄
- anon PostgREST：market_stores 3 筆、market_products 15 筆（全部 approved）。
- 截圖：shots/market.png、shots/store.png、shots/product.png（1280 寬），preview 於 /tmp/preview_demo_*.png。
