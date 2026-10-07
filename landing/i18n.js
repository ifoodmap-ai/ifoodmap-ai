(function (root, factory) {
  var i18n = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = i18n;
  }

  if (root) {
    root.IfmI18n = i18n;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  var LANGS = ['zh', 'en'];
  var DEFAULT_LANG = 'zh';
  // 使用者「按過語言鈕」的紀錄。只有它能讓裸網址 / 自動轉(見 routing.js 的 applyPreferredLang)。
  var STORAGE_KEY = 'ifm.lang';
  // 使用者按過語系提示條的 ×。刻意跟 STORAGE_KEY 分開 —— 關掉提示條不代表選了哪個語系。
  var HINT_DISMISSED_KEY = 'ifm.langHintDismissed';

  /* ==== DICT:BEGIN ====
     中英文案字典。markup 用 {{ L.xxx.yyy }} 綁定,程式碼用 IfmI18n.dict(lang)。
     zh 與 en 的 key 結構必須完全一致 —— tests/i18n.test.cjs 會擋。
     改文案就直接改這裡。
     ⚠️ langHint 是唯一的例外:它顯示在「另一個語系」的頁面上(中文頁給英文訪客看英文那組、
        英文頁給中文訪客看中文那組),所以 zh.langHint 是中文、en.langHint 是英文,
        元件取的是 dict(建議的語系).langHint,不是 L。 */
  var DICT = {
    "zh": {
      "nav": {
        "logoAlt": "iFoodmap 食材地圖",
        "mainNavLabel": "主要導覽",
        "menuLabel": "選單",
        "findIngredients": "找食材",
        "becomeSupplier": "成為供應商",
        "faq": "常見問題",
        "about": "關於我們",
        "news": "最新消息",
        "contact": "聯絡我們",
        "cta": "填寫食材需求",
        "skipToContent": "跳到主要內容"
      },
      "langHint": {
        "regionLabel": "語言建議",
        "message": "習慣看中文嗎？",
        "switchLabel": "切換到中文版",
        "dismissLabel": "關閉，不再顯示"
      },
      "home": {
        "heroSubA": "餐廳、團膳、學校、團購主都適用。",
        "heroSubB": "填一次需求，供應商主動來找你。",
        "searchAriaLabel": "搜尋食材",
        "searchPlaceholder": "搜尋食材，例如：有機葉菜、火鍋肉片",
        "searchButton": "找食材",
        "audienceTitleA": "任何有食材需求的人，",
        "audienceTitleB": "都適用",
        "audienceSub": "不只是餐廳。只要需要進貨，我們就幫你找到對的供應商。",
        "flowTitlePre": "從需求到進貨，",
        "flowTitleHighlight": "一條龍",
        "flowCta": "立即填寫食材需求",
        "categoriesTitle": "食材分類",
        "pfTitlePre": "找食材，你也",
        "pfTitleHl": "遇過這些問題嗎？",
        "pfSolPre": "現在，找食材",
        "pfSolHl": "可以更有效率！",
        "pfLeadA": "告訴食材地圖你的採購需求，",
        "pfLeadB": "快速媒合合適的產地、加工廠與各級供應商。",
        "pfTypesAria": "可以媒合的供應商類型",
        "rpTitlePre": "每天叫貨，你也",
        "rpTitleHl": "遇過這些問題嗎？",
        "rpSolPre": "現在，例行採購",
        "rpSolHl": "可以更簡單！",
        "rpLeadA": "透過食材地圖集中管理每日叫貨，",
        "rpLeadB": "從下單、進度追蹤、訂單彙整到月底對帳一次掌握。",
        "rpFeaturesAria": "例行採購的功能",
        "categoriesSub": "從產地、工廠、大盤到小盤商",
        "testimonialsTitle": "使用者怎麼說",
        "quoteOpen": "「",
        "quoteClose": "」",
        "bylineSep": "　",
        "newsTitle": "餐飲相關資訊",
        "newsAll": "全部文章 →",
        "ctaTitleA": "免費找到所有食材，",
        "ctaTitleB": "從填一張需求單開始",
        "ctaPrimary": "填寫食材需求",
        "ctaSecondary": "免費註冊會員",
        "data": {
          "rotating": [
            {
              "pre": "免費找到",
              "hl": "所有食材",
              "post": ""
            },
            {
              "pre": "免費找到",
              "hl": "合適的供應商",
              "post": ""
            },
            {
              "pre": "",
              "hl": "多家供應商",
              "post": "主動聯繫報價"
            }
          ],
          "hotTags": [
            "蔬菜",
            "水果",
            "豬肉",
            "牛肉",
            "火鍋料",
            "雜貨"
          ],
          "heroPromises": [
            "完全免費",
            "成交不抽成",
            "平均 4 小時有回覆"
          ],
          "stats": [
            "合作供應商",
            "累積媒合需求",
            "服務餐飲及食品業者",
            "食材與食品品項"
          ],
          "statsUnits": [
            "家",
            "筆",
            "家",
            "項"
          ],
          "pfProblems": [
            "找供應商多半靠同行介紹，上網搜尋總是那幾家",
            "商品資訊不完整，還得打電話逐一詢價、確認配送範圍",
            "留下聯絡資料後，等了好幾天仍收不到回覆"
          ],
          "pfTypes": [
            "產地供應商",
            "加工廠",
            "大盤商",
            "中盤商",
            "小盤商"
          ],
          "rpProblems": [
            "訂單散落在 LINE、電話與紙本，訊息太多容易漏單",
            "每天反覆確認品項、數量、價格與到貨時間，耗時又容易出錯",
            "訂單與對帳資料分散，月底整理費時又增加人力成本",
            "不清楚確切食材成本與採購數量，難以掌握餐廳實際賺賠"
          ],
          "rpFeatures": [
            "集中下單",
            "訂單彙整",
            "進度追蹤",
            "歷史查詢",
            "快速對帳"
          ],
          "audiences": [
            {
              "title": "餐廳・餐酒館",
              "desc": "小量也能問，換供應商不必重新累積人脈。"
            },
            {
              "title": "團膳・學校",
              "desc": "大量、穩定、需要文件？一次找齊符合資格的供應商。"
            },
            {
              "title": "團購主・電商",
              "desc": "找源頭貨、找代工，談量談價都從這裡開始。"
            },
            {
              "title": "加工廠・通路",
              "desc": "原料穩定供應，備援廠商一次備齊。"
            }
          ],
          "flow": [
            {
              "title": "填需求",
              "desc": "品項、數量、配送區域，2 分鐘。"
            },
            {
              "title": "系統媒合",
              "desc": "只發給供得起、送得到的廠商。"
            },
            {
              "title": "收到報價",
              "desc": "平均 4 小時開始收到回覆。"
            },
            {
              "title": "比較洽談",
              "desc": "價格、配送、標章一次比。"
            },
            {
              "title": "下單進貨",
              "desc": "直接和供應商成交，不抽成。"
            },
            {
              "title": "雙邊評價",
              "desc": "好廠商被更多人看見。"
            }
          ],
          "categories": [
            "蔬菜",
            "水果",
            "海鮮",
            "肉品",
            "蛋品",
            "五穀雜糧",
            "南北雜貨",
            "加工食品",
            "火鍋料",
            "調味品",
            "酒與飲品",
            "包材耗材"
          ],
          "testimonials": [
            {
              "who": "林老闆",
              "role": "日式餐廳・台北",
              "quote": "以前換一家蔬菜商要問三個月，這裡填完需求隔天就有三家報價。"
            },
            {
              "who": "陳主任",
              "role": "國小午餐團膳",
              "quote": "需要產銷履歷的供應商很難找，這邊可以直接篩選有標章的廠商。"
            },
            {
              "who": "王小姐",
              "role": "生鮮團購主",
              "quote": "終於直接談到產地，不必再透過中間商加價。"
            }
          ],
          "trust": [
            {
              "title": "雙邊評價機制",
              "desc": "媒合完成後互相評價，讓優質供應商被更多人看見。"
            },
            {
              "title": "標章與檢驗連動",
              "desc": "產銷履歷、SGS 檢驗報告附上文件連結，可連至認證機構查核。"
            },
            {
              "title": "LINE 即時通知",
              "desc": "新供應商、食材優惠與媒合結果，第一時間通知你。"
            }
          ],
          "askPrefix": "我想找食材："
        }
      },
      "rest": {
        "caps": {
          "cost": {
            "li1": "查看菜色食材成本與成本占比",
            "li2": "進行供應商價格比較，掌握報價差異",
            "li3": "需要調整時，查看替代食材與當季參考",
            "sub": "把菜色食材成本與供應商報價放在相同脈絡中，讓採購決策有清楚依據。",
            "title": "成本與採購"
          },
          "menuAi": {
            "li1": "辨識菜色與食材，建立可編輯的菜單結構",
            "li2": "確認或編輯分析結果，補上用量與單位",
            "li3": "從菜色回到實際採購需求",
            "sub": "上傳菜單後整理菜色與食材，先由系統協助辨識，再由使用者確認內容。",
            "title": "AI 菜單分析"
          },
          "orders": {
            "li1": "集中查看採購與訂單狀態",
            "li2": "到貨後由團隊確認收貨",
            "li3": "保留不可覆寫的事件履歷，釐清每次狀態異動",
            "sub": "從採購到到貨保留一致狀態，讓負責下單與現場收貨的人都看得到最新進度。",
            "title": "訂單與收貨"
          },
          "sectionAria": "餐廳產品功能",
          "team": {
            "li1": "管理分店與團隊成員",
            "li2": "設定 owner、manager、purchaser 角色",
            "li3": "維護各分店收貨地點與時段",
            "sub": "依分店與職責安排帳號角色，讓採購、管理與收貨的人取得適合的操作範圍。",
            "title": "團隊管理"
          }
        },
        "cases": {
          "c1": {
            "body": "透過一次需求媒合，快速對接三家蔬果供應商，穩定取得當季食材。",
            "stat1Label": "完成供應商比較",
            "stat1Value": "3 天",
            "stat2Label": "食材採購成本",
            "tag": "餐廳業者",
            "title": "單店餐廳，告別到處問價的日子"
          },
          "c2": {
            "body": "同時對接多家供應商，降低單一來源斷貨風險，供餐更有保障。",
            "stat1Label": "穩定合作供應商",
            "stat2Label": "斷貨次數",
            "tag": "團膳業者",
            "title": "大量供餐，採購來源更穩定"
          },
          "eyebrow": "成果案例",
          "sub": "成果依業態、採購規模與執行期間而異。",
          "title": "餐廳採購的實際成果"
        },
        "cta": {
          "sub": "建立餐廳帳號，開始整理菜單、供應商與採購訂單。",
          "title": "讓下一次採購，從清楚的流程開始"
        },
        "ctaCreateAccount": "建立餐廳帳號",
        "flow": {
          "eyebrow": "日常工作流程",
          "s1": {
            "body": "上傳菜單，或直接整理要採購的食材。",
            "title": "整理菜單與需求"
          },
          "s2": {
            "body": "檢查品項、用量與單位，再交由團隊使用。",
            "title": "確認食材與規格"
          },
          "s3": {
            "body": "集中查看合作供應商與品項報價。",
            "title": "比較供應商與價格"
          },
          "s4": {
            "body": "追蹤進度，到貨後由團隊完成確認。",
            "title": "建立訂單並確認收貨"
          },
          "sub": "每一步都由團隊確認，保留清楚的採購依據與進度。",
          "title": "從菜單與需求，一路走到收貨"
        },
        "hero": {
          "ctaSecondary": "查看餐廳功能",
          "sub": "把菜單、食材成本、供應商比較、採購訂單與團隊權限放在清楚的工作流程中，讓每天的採購更容易掌握。",
          "title": "從菜單分析到完成收貨，都在同一個平台"
        },
        "pain": {
          "compare": {
            "body": "詢價結果散落各處，整理與確認往往占去採購時間。",
            "title": "比價耗費大量時間"
          },
          "eyebrow": "採購現場",
          "manual": {
            "body": "找新食材或供應商時，常得逐一打電話、問同行。",
            "title": "仰賴人工與同行詢問"
          },
          "specs": {
            "body": "品項、單位與報價格式不同，難以直接判斷差異。",
            "title": "規格與價格資訊不完整"
          },
          "sub": "當資訊分散在電話、訊息與試算表裡，團隊很難快速做出一致的採購決定。",
          "title": "餐廳採購，不該靠人脈與零散訊息",
          "track": {
            "body": "下單、到貨與異動缺少共同紀錄，交接容易遺漏。",
            "title": "訂單與收貨難追蹤"
          }
        }
      },
      "sup": {
        "heroTitle": "從商品上架到商機、報價與出貨",
        "heroSub": "把商品目錄、餐廳需求、報價、訂單與客戶經營放進同一套工作流程。你保留每一次判斷，平台協助整理資訊與追蹤進度。",
        "applyCta": "申請供應商上架",
        "heroCtaSecondary": "查看供應商功能",
        "painEyebrow": "供應商常見挑戰",
        "painTitle": "好商品，不該埋沒在零散詢價裡",
        "painSub": "當需求、報價與合作紀錄散落在不同對話裡，回覆速度和後續經營都更難掌握。",
        "painScatteredTitle": "需求分散，難以及時發現",
        "painScatteredDesc": "商機可能來自多個管道，品項與服務區域也得逐一確認。",
        "painQuotesTitle": "報價與交期反覆確認",
        "painQuotesDesc": "價格、付款條件和替代品項容易在訊息往返中遺漏。",
        "painPricingTitle": "定價缺少市場依據",
        "painPricingDesc": "不容易看見同區同品項行情與近期需求變化。",
        "painRetentionTitle": "客戶回購狀況難掌握",
        "painRetentionDesc": "完成交易後，還需要持續整理下單頻率與合作狀況。",
        "flowEyebrow": "一條清楚的接單流程",
        "flowTitle": "從被看見，到報價、接單與持續經營",
        "flowSub": "先建立可媒合的商品資料，再逐步處理商機、訂單與客戶關係。",
        "flowCatalogTitle": "建立商品目錄",
        "flowCatalogDesc": "整理供應品項、價格與服務範圍。",
        "flowLeadsTitle": "接收匹配商機",
        "flowLeadsDesc": "查看與商品目錄相符的餐廳需求。",
        "flowQuoteTitle": "回覆報價並確認訂單",
        "flowQuoteDesc": "填寫報價條件，追蹤已接受與待確認項目。",
        "flowShipTitle": "出貨並累積客戶關係",
        "flowShipDesc": "確認出貨，回看訂單、客戶與評價紀錄。",
        "cap1Eyebrow": "01 · 找到合適需求",
        "cap1Title": "商機雷達",
        "cap1Sub": "平台依餐廳需求、商品目錄與服務區域整理潛在商機，你可以查看狀態並自行決定下一步。",
        "cap1Li1": "依商品目錄進行需求單自動媒合",
        "cap1Li2": "查看新商機與不同處理狀態",
        "cap1Li3": "用近 90 天需求做品項缺口分析",
        "cap2Eyebrow": "02 · 報價到出貨",
        "cap2Title": "報價與接單",
        "cap2Sub": "集中檢視需求、回覆報價並追蹤採購訂單；每個確認動作仍由供應商操作。",
        "cap2Li1": "回覆報價金額、交期、付款條件與替代品項",
        "cap2Li2": "查看待報價、已報價與已接受狀態",
        "cap2Li3": "追蹤待確認訂單，完成後確認出貨",
        "cap3Eyebrow": "03 · 看懂行情與需求",
        "cap3Title": "定價與預測",
        "cap3Sub": "用平台既有報價與需求資料作為參考，檢視價格競爭力和近期備貨方向。",
        "cap3Li1": "比對同區同品項行情與價格名次",
        "cap3Li2": "查看近 13 週需求量趨勢",
        "cap3Li3": "依近 90 天資料取得下週備貨建議與產季提示",
        "cap4Eyebrow": "04 · 延續合作關係",
        "cap4Title": "客戶經營",
        "cap4Sub": "完成訂單後，系統依合作紀錄整理客戶輪廓，並集中呈現評價與服務指標。",
        "cap4Li1": "查看餐廳下單頻率、累計金額與回購狀況",
        "cap4Li2": "辨識可能流失客戶，作為主動聯繫參考",
        "cap4Li3": "整理交易評價、商店評價與星等分布",
        "outcomesEyebrow": "平台規模與使用情境",
        "outcomesTitle": "供應商經營的成果參考",
        "outcomesSub": "以下分開呈現平台現有公開數據與產品示例，避免把操作畫面誤認為特定客戶實績。",
        "statLabel": "平台現有公開數據",
        "stat1Desc": "在地供應商",
        "stat2Value": "28 類",
        "stat2Desc": "食材品項分類",
        "stat3Desc": "平均媒合回應",
        "outcomesNoteLabel": "示例資料，非特定客戶實績",
        "outcomesNoteBody": "一個完整工作日可依序查看新商機、回覆待報價需求、確認訂單與出貨，再用客戶與評價紀錄安排後續聯繫。",
        "outcomesDisclaimer": "成果依品項、服務區域、供應能力與執行期間而異。",
        "ctaTitle": "讓下一個合適商機，更容易看見你",
        "ctaSub": "申請供應商上架，開始建立商品目錄與服務範圍。"
      },
      "cases": {
        "heroTitle": "餐廳與供應商，如何一起改善採購成果",
        "heroSub": "從需求媒合、供應來源到食材履歷，以下案例呈現不同業態在各自採購情境中的改善層級。",
        "resultsEyebrow": "已核准案例成果",
        "resultsTitle": "依角色與改善層級比較",
        "resultsNote": "數據為個別案例結果，用來說明採購情境，不代表所有使用者都會得到相同成果。",
        "case1": {
          "eyebrow": "餐廳端成果 · 採購效率與成本",
          "title": "單店餐廳，告別到處問價的日子",
          "body": "透過一次需求媒合，快速對接三家蔬果供應商，穩定取得當季食材。",
          "stat1Value": "3 天",
          "stat1Label": "完成供應商比較",
          "stat2Label": "食材採購成本"
        },
        "case2": {
          "eyebrow": "餐廳端成果 · 供應穩定度",
          "title": "大量供餐，採購來源更穩定",
          "body": "同時對接多家供應商，降低單一來源斷貨風險，供餐更有保障。",
          "stat1Label": "穩定合作供應商",
          "stat2Label": "斷貨次數"
        },
        "case3": {
          "eyebrow": "供應商合作成果 · 履歷與信任",
          "title": "產地直送，建立消費者信任",
          "body": "對接具產銷履歷的產地供應商，商品故事與品質都更有說服力。",
          "stat1Label": "回購率提升",
          "stat2Label": "顧客評價"
        },
        "disclaimer": "成果依業態、採購規模與執行期間而異。",
        "ctaRestaurant": "餐廳註冊",
        "ctaSupplier": "供應商上架"
      },
      "about": {
        "heroTitle": "讓餐廳需求與供應能力，更有效率地相遇",
        "heroBody": "iFoodmap 是連結餐廳與食材供應商的雙邊 B2B 食材採購平台。餐廳可以整理需求、比較報價並管理採購；供應商可以呈現商品、回覆商機並持續經營客戶關係。",
        "valueEyebrow": "雙邊共同價值",
        "valueTitle": "讓資訊沿著採購流程流動",
        "valueBody": "同一個平台承接雙方需要的資訊層級，減少需求、報價、訂單與出貨散落在不同管道。",
        "forRestaurantsLabel": "給餐廳",
        "forRestaurantsTitle": "更清楚地提出需求與做決策",
        "forRestaurantsBody": "從菜單、品項與規格開始，逐步比較供應來源、價格與訂單狀態。",
        "forSuppliersLabel": "給供應商",
        "forSuppliersTitle": "更有效率地找到商機與服務客戶",
        "forSuppliersBody": "依商品與服務範圍接收需求，集中處理報價、訂單、出貨與客戶紀錄。",
        "valuesEyebrow": "我們重視的事",
        "valuesTitle": "三個核心價值",
        "value1Title": "高效媒合",
        "value1Body": "用資料與 AI 協助雙方整理條件，讓每一次採購更快找到合適的合作對象。",
        "value2Title": "公平透明",
        "value2Body": "讓需求、規格、報價與服務紀錄有清楚脈絡，幫助雙方在資訊對等下做決策。",
        "value3Title": "在地永續",
        "value3Body": "串接台灣在地供應鏈，縮短產地、供應端與餐桌之間的資訊距離。"
      },
      "contact": {
        "heroEyebrow": "異業合作",
        "heroTitle": "一起把台灣的食材供應鏈，做得更好",
        "heroBody": "通路、系統商、物流業者與品牌方，都可以在這裡談合作。留下你想談的方向，我們會安排對的人回覆你。",
        "typesEyebrow": "合作方向",
        "typesTitle": "我們在找什麼樣的合作",
        "typesBody": "不限於下面四種，但這四種我們已經有明確的做法與對接經驗，推進起來最快。",
        "typeChannelTitle": "通路與門市合作",
        "typeChannelDesc": "連鎖餐飲、團膳、食材行與量販通路，把 iFoodmap 的供應商網絡接進你既有的採購流程，不用換掉現在的做法。",
        "typeIntegrationTitle": "系統串接（API / ERP / POS）",
        "typeIntegrationDesc": "POS、ERP、進銷存與訂貨系統的雙向串接，讓需求、報價與訂單在兩邊流動，不用再重打一次。",
        "typeLogisticsTitle": "物流倉儲與冷鏈",
        "typeLogisticsDesc": "常溫、冷藏與冷凍配送、集貨倉與最後一哩。一起把出貨時效與品溫穩定下來，讓餐廳敢把量交出來。",
        "typeBrandingTitle": "品牌聯名與行銷合作",
        "typeBrandingDesc": "產地故事、聯名商品、活動與內容合作，把值得被看見的供應端，介紹給更多餐飲業者。",
        "flowEyebrow": "合作怎麼開始",
        "flowTitle": "三步，從送出表單到坐下來談",
        "step1Title": "填寫合作洽詢",
        "step1Desc": "留下公司、聯絡方式與想談的方向。寫得愈具體，我們愈能在回覆前先做完功課。",
        "step2Title": "我們在三個工作天內回覆",
        "step2Desc": "由負責該類型合作的窗口用 Email 回你，附上初步評估，以及還需要你補充的資訊。",
        "step3Title": "安排線上或實地洽談",
        "step3Desc": "談合作範圍、分工與時程。方向確認之後就進入試行，或直接進到正式合約。",
        "formEyebrow": "合作洽詢",
        "formTitle": "異業合作洽詢表單",
        "formHelp": "標示 * 的欄位為必填。送出後我們會用 Email 與你聯繫，填寫的資料僅供合作評估使用。",
        "labelCompany": "公司名稱",
        "placeholderCompany": "例：好食材股份有限公司",
        "labelName": "聯絡人姓名",
        "placeholderName": "例：王小明",
        "labelJobTitle": "職稱",
        "placeholderJobTitle": "例：業務發展經理",
        "labelEmail": "Email",
        "placeholderEmail": "name@company.com",
        "labelPhone": "聯絡電話",
        "placeholderPhone": "02-0000-0000 或 0900-000-000",
        "labelWebsite": "公司網站 / 相關連結",
        "placeholderWebsite": "https://",
        "labelPartnerType": "合作類型",
        "partnerTypePlaceholder": "請選擇合作類型",
        "partnerTypeChannel": "通路與門市合作",
        "partnerTypeIntegration": "系統串接（API / ERP / POS）",
        "partnerTypeLogistics": "物流倉儲與冷鏈",
        "partnerTypeBranding": "品牌聯名與行銷合作",
        "partnerTypeOther": "其他合作提案",
        "labelMessage": "合作內容說明",
        "placeholderMessage": "想談的合作方向、目前的規模與時程，以及希望 iFoodmap 這邊提供什麼。",
        "submit": "送出合作洽詢",
        "formRequire": "請填寫必填欄位，並確認 Email 格式",
        "formSubmitting": "送出中…",
        "formSuccess": "✓ 已收到，我們會盡快與您聯繫",
        "formFailure": "送出失敗，請稍後再試或改寄 Email",
        "formRateLimited": "今天的送出次數已達上限，請明天再試或改寄 Email",
        "infoEyebrow": "其他聯絡方式",
        "infoTitle": "不想填表，直接找我們也可以",
        "phoneIcon": "電",
        "phoneLabel": "服務專線",
        "phoneAria": "撥打服務專線 02-7704-5539",
        "emailLabel": "電子信箱",
        "emailAria": "寄信到 ifoodmaptw@gmail.com",
        "hoursIcon": "時",
        "hoursLabel": "服務時間",
        "hoursValue": "週一至週五 9:00 – 18:00",
        "lineLabel": "官方 LINE",
        "lineValue": "加入好友即時諮詢",
        "lineAria": "加入 iFoodmap 官方 LINE 好友（另開新視窗）",
        "exitEyebrow": "不是要談合作？",
        "exitTitle": "你是要找食材嗎？",
        "exitBody": "這一頁的表單是給異業合作洽詢用的。如果你要找的是供應商與報價，不用填表，右下角的 AI 採購助手會直接幫你問清楚。",
        "aiTitle": "直接跟 AI 採購助手說",
        "aiHelp": "不用填表。說一句你要找什麼，助手會問清楚品項、數量、配送區域與時程，再把需求送給合適的供應商。",
        "aiCta": "開始對話，免費媒合 →",
        "aiHint": "也可以直接上傳菜單照片，讓它幫你整理採購清單。",
        "aiQuickLabel": "常見需求，點一下開始",
        "roleGridLabel": "平台角色入口",
        "roleRestaurantTitle": "我是餐廳",
        "roleRestaurantAction": "建立餐廳帳號 →",
        "roleSupplierTitle": "我是供應商",
        "roleSupplierAction": "申請供應商上架 →"
      },
      "footer": {
        "brandTagline": "食材地圖",
        "phoneLabel": "服務專線",
        "hoursLabel": "服務時間",
        "hoursValue": "週一至週五 9:00–18:00",
        "serviceFindIngredients": "找食材",
        "serviceBecomeSupplier": "成為供應商",
        "servicePlatformFeatures": "平台功能",
        "serviceLogin": "登入平台",
        "companyAbout": "關於我們",
        "companyCases": "成功案例",
        "companyNews": "最新消息",
        "companyContact": "聯絡我們",
        "supportFaq": "常見問題",
        "supportTerms": "使用條款",
        "supportPrivacy": "隱私權政策",
        "socialLineLabel": "客服 LINE@",
        "socialLineAria": "加入 iFoodmap 客服 LINE@（另開新視窗）",
        "socialFollowLabel": "追蹤我們",
        "socialFacebookAria": "在 Facebook 追蹤 iFoodmap（另開新視窗）",
        "sep": "｜",
        "copyright": "©{year} by ifoodmap 食材地圖 All rights are reserved."
      },
      "meta": {
        "siteName": "iFoodmap 食材地圖",
        "keywords": "食材採購,餐飲供應鏈,供應商媒合,B2B 食材,餐廳進貨,食材地圖,ifoodmap,AI 採購,產地直送",
        "author": "iFoodmap 食材地圖",
        "langSwitchLabel": "切換語言",
        "langSwitchToEn": "English",
        "langSwitchToZh": "中文",
        "pages": {
          "home": {
            "title": "iFoodmap 食材地圖｜餐廳與供應商的 B2B 食材採購平台",
            "description": "iFoodmap 以 AI 串接餐廳需求與全台食材供應商，整合智慧媒合、報價比較、訂單、出貨與採購管理。"
          },
          "restaurants": {
            "title": "餐廳方案｜從菜單分析到完成收貨，都在同一個平台 - iFoodmap 食材地圖",
            "description": "整理食材需求、比較供應商報價、追蹤訂單與收貨，還有 AI 菜單分析與成本試算。餐廳採購的每一步都在同一個工作流程裡。"
          },
          "suppliers": {
            "title": "供應商方案｜從商品上架到商機、報價與出貨 - iFoodmap 食材地圖",
            "description": "上架商品目錄、接收餐廳需求、回覆報價並經營客戶關係。iFoodmap 幫供應商把資訊整理好，每一次判斷仍然由你決定。"
          },
          "cases": {
            "title": "成功案例｜餐廳與供應商如何一起改善採購成果 - iFoodmap 食材地圖",
            "description": "單店餐廳、團膳供餐、生鮮團購在各自採購情境中的改善成果，從需求媒合、供應來源到食材履歷。"
          },
          "about": {
            "title": "關於我們｜讓餐廳需求與供應能力更有效率地相遇 - iFoodmap 食材地圖",
            "description": "iFoodmap 是連結餐廳與食材供應商的雙邊 B2B 食材採購平台，讓資訊沿著採購流程流動。"
          },
          "contact": {
            "title": "異業合作｜通路、系統串接、物流冷鏈與品牌聯名洽詢 - iFoodmap 食材地圖",
            "description": "iFoodmap 開放異業合作洽詢：通路與門市、系統串接（API / ERP / POS）、物流倉儲與冷鏈、品牌聯名與行銷。填一張表，我們會在三個工作天內由對應窗口回覆。"
          },
          "news": {
            "title": "最新消息｜餐飲採購與食安的第一手整理 - iFoodmap 食材地圖",
            "description": "從食材採購、產銷履歷到市場趨勢，整理餐飲與團膳業者實際會用到的資訊。"
          },
          "article": {
            "title": "最新消息｜餐飲採購與食安的第一手整理 - iFoodmap 食材地圖",
            "description": "從食材採購、產銷履歷到市場趨勢，整理餐飲與團膳業者實際會用到的資訊。"
          },
          "legal": {
            "title": "法律文件｜使用條款與隱私權政策 - iFoodmap 食材地圖",
            "description": "iFoodmap 食材地圖的使用條款與隱私權政策。條款內容自舊站原文搬遷，中文版為準。"
          },
          "qa": {
            "title": "常見問題｜加入、審核與收費怎麼運作 - iFoodmap 食材地圖",
            "description": "供應商加入食材地圖的流程、平台審核與收費方案，最常被問到的問題都整理在這裡。找不到答案可以直接問 AI 採購助手。"
          }
        }
      },
      "news": {
        "heroEyebrow": "最新消息",
        "heroTitle": "餐飲採購與食安的第一手整理",
        "heroSub": "從食材採購、產銷履歷到市場趨勢，整理餐飲與團膳業者實際會用到的資訊。",
        "countLabel": "篇文章",
        "readMore": "閱讀全文 →",
        "backToList": "← 回到最新消息",
        "publishedOn": "發佈於",
        "sourceLinks": "文中參考連結",
        "notFoundTitle": "找不到這篇文章",
        "notFoundBody": "這個網址可能已經變更或被移除。你可以回到最新消息列表看看其他內容。",
        "coverAlt": "文章封面"
      },
      "legal": {
        "eyebrow": "法律文件",
        "updatedLabel": "最後更新",
        "noUpdatedLabel": "舊站未標示版本日期",
        "prevail": "本網站之英文版本僅為便利讀者所提供之翻譯。如中英文版本有任何歧異或疑義，概以中文版本為準。",
        "prevailLabel": "版本效力",
        "tocTitle": "本頁內容",
        "docNavLabel": "法律文件",
        "otherDocsTitle": "其他條款",
        "indexTitle": "法律文件",
        "indexBody": "以下是 iFoodmap 食材地圖目前適用的條款與政策。",
        "notFoundTitle": "找不到這份文件",
        "notFoundBody": "這個網址可能已經變更或被移除。以下是目前可以閱讀的法律文件。",
        "readDoc": "閱讀全文 →"
      },
      "qa": {
        "heroEyebrow": "常見問題",
        "heroTitle": "加入、審核與收費，最常被問到的問題",
        "heroSub": "這裡整理供應商在加入食材地圖前後最常問的問題。沒有找到答案，右下角的 AI 採購助手可以直接回答你。",
        "countLabel": "個問題",
        "ctaTitle": "還是沒找到答案？",
        "ctaBody": "把問題直接告訴 AI 採購助手。它會依照你的品項、配送區域與時程回答，也能幫你把需求送到合適的供應商手上。",
        "ctaButton": "開始對話，免費媒合 →",
        "ctaHint": "需求方完全免費，不需要註冊就能開始對話。",
        "items": [
          {
            "question": "我是食材供應商，該如何加入食材地圖，成為合作供應商？",
            "paras": [
              "先填寫「申請供應商上架」表單，不需要先註冊帳號。平台審核通過後，會寄一封邀請信到你填寫的 Email，點信中的連結設定密碼，即可登入供應商後台，開始接收食材需求轉單。"
            ],
            "linkHref": "{supplierApplicationUrl}",
            "linkText": "前往「申請供應商上架」表單"
          },
          {
            "question": "請問成為合作供應商需要費用嗎？",
            "paras": [
              "註冊供應商資訊並審核開通後，即可收到符合供應商販售食材和配送區域的食材需求單，但如果想要進一步與買家聯繫報價洽談後續，則需成為付費合作供應商。"
            ],
            "linkHref": "https://www.ifoodmap.com.tw/how/pointRule",
            "linkText": "查看收費方案"
          }
        ]
      },
      "ai": {
        "fabLabel": "開啟 AI 採購助手",
        "fabTitle": "找食材嗎？",
        "title": "iFoodMap AI 採購助手",
        "subtitle": "上傳菜單或描述需求，立即整理採購清單",
        "closeLabel": "關閉",
        "inputSrLabel": "輸入食材需求",
        "uploadLabel": "上傳菜單照片",
        "inputPlaceholder": "輸入你的食材需求…",
        "placeholderLocked": "免費註冊後可以繼續聊",
        "placeholderCooldown": "請稍後再試，或先免費註冊",
        "sendLabel": "送出",
        "dropHint": "放開以上傳菜單 📷",
        "greeting": "嗨！我是 iFoodMap AI 採購助手 👋\n你可以：\n📷 上傳一張菜單照片，我幫你整理出採購食材清單\n💬 或直接打字描述你需要的食材",
        "errService": "AI 服務暫時忙線，請稍後再試 🙏 你也可以直接留下聯絡方式，由專人為你免費媒合。",
        "quotaUsed": "免費試用的次數用完了，註冊後可以繼續聊",
        "rateLimitedWait": "請 {minutes} 分鐘後再試，或先免費註冊",
        "quotaResumed": "可以繼續聊了，請繼續描述你的需求 🙌",
        "tooLong": "訊息有點長，請精簡到 {max} 字以內再送出 🙏",
        "imageTooLarge": "這張照片太大了，請換一張小一點的照片再試一次 📷",
        "imageUnsupported": "這個圖片格式不支援，請改用 JPG、PNG 或 WebP 📷",
        "uploadLimit": "每段對話最多上傳 {max} 張照片，免費註冊後可以上傳更多 📷",
        "ctaRegister": "免費註冊 →",
        "ctaRegisterBusy": "正在前往註冊…",
        "ctaEmail": "不想註冊？留下 Email，專人跟你聯絡",
        "ctaSwitchRegister": "改成免費註冊 →",
        "ctaCancelLead": "取消，回到對話",
        "leadCancelled": "好的，先不留 Email 也沒關係。需要的時候，隨時可以免費註冊或留 Email 👇",
        "ctaPrefixChat": "想把這次的需求存起來嗎？免費註冊後，會自動幫你建好一張採購單草稿 👇",
        "ctaPrefixAnalysis": "採購清單整理好了！免費註冊就能直接存成採購單草稿 👇",
        "ctaPrefixDone": "需求整理好了！免費註冊，剛剛聊的內容會自動變成你的採購單草稿 👇",
        "ctaPrefixEnded": "需要找食材的時候，歡迎免費註冊，或留下 Email 讓專人跟你聯絡 👇",
        "uploadImageOnly": "請上傳圖片檔（JPG / PNG）。",
        "dropImageOnly": "請拖曳圖片檔（JPG / PNG）。",
        "menuImageAlt": "菜單",
        "analysisFallback": "AI 已分析出你的採購需求：",
        "askName": "好的！為了請專人跟你聯絡，請問怎麼稱呼您？😊",
        "placeholderName": "請輸入您的稱呼…",
        "askEmail": "謝謝 {name}！請留下您的 Email，我們會請專人盡快與您聯繫 ✉️",
        "placeholderEmail": "請輸入您的 Email…",
        "emailInvalid": "Email 看起來不太對，可以再給我一次嗎？例如 name@company.com",
        "sending": "送出中…",
        "leadSuccess": "✓ 收到了，{name}！我們會盡快寫信到 {email} 與您聯繫，為您免費媒合最合適的供應商 🙌",
        "leadFailure": "送出失敗，請稍後再試一次 🙏",
        "leadRateLimited": "今天收到的留言次數已經達到上限了，請明天再試，或直接寫信到 ifoodmaptw@gmail.com，我們會盡快回覆 🙏"
      }
    },
    "en": {
      "nav": {
        "logoAlt": "iFoodmap",
        "mainNavLabel": "Main navigation",
        "menuLabel": "Menu",
        "findIngredients": "Find Ingredients",
        "becomeSupplier": "Become a Supplier",
        "faq": "FAQ",
        "about": "About",
        "news": "News",
        "contact": "Contact",
        "cta": "Post a Request",
        "skipToContent": "Skip to main content"
      },
      "langHint": {
        "regionLabel": "Language suggestion",
        "message": "Prefer English?",
        "switchLabel": "Switch to English",
        "dismissLabel": "Dismiss, don't show again"
      },
      "home": {
        "heroSubA": "For restaurants, catering operations, schools, and group-buying hosts.",
        "heroSubB": "Submit one request and suppliers come to you.",
        "searchAriaLabel": "Search ingredients",
        "searchPlaceholder": "Search ingredients, e.g. organic greens, hot pot meat",
        "searchButton": "Search",
        "audienceTitleA": "Built for anyone who",
        "audienceTitleB": "sources ingredients",
        "audienceSub": "Not just restaurants. If you buy ingredients, we'll connect you with the right suppliers.",
        "flowTitlePre": "Request to restock, ",
        "flowTitleHighlight": "end to end",
        "flowCta": "Post Your Request",
        "categoriesTitle": "Ingredient Categories",
        "pfTitlePre": "Sourcing ingredients — ",
        "pfTitleHl": "sound familiar?",
        "pfSolPre": "Now, sourcing ingredients ",
        "pfSolHl": "can be far more efficient!",
        "pfLeadA": "Tell iFoodmap what you need to buy,",
        "pfLeadB": "and we'll quickly match you with the right farms, processors and suppliers at every tier.",
        "pfTypesAria": "Types of suppliers we match you with",
        "rpTitlePre": "Daily ordering — ",
        "rpTitleHl": "sound familiar?",
        "rpSolPre": "Now, routine purchasing ",
        "rpSolHl": "can be much simpler!",
        "rpLeadA": "Manage all your daily orders in one place with\u00a0iFoodmap,",
        "rpLeadB": "and stay on top of everything from ordering and delivery tracking to order summaries and month\u2011end\u00a0reconciliation.",
        "rpFeaturesAria": "Routine purchasing features",
        "categoriesSub": "From farms and factories to wholesalers and local distributors",
        "testimonialsTitle": "What Users Say",
        "quoteOpen": "“",
        "quoteClose": "”",
        "bylineSep": " · ",
        "newsTitle": "Food Service Insights",
        "newsAll": "All articles →",
        "ctaTitleA": "Find every ingredient at no cost.",
        "ctaTitleB": "It starts with one request.",
        "ctaPrimary": "Post a Request",
        "ctaSecondary": "Create an Account",
        "data": {
          "rotating": [
            {
              "pre": "Find ",
              "hl": "every ingredient",
              "post": " at no cost"
            },
            {
              "pre": "Find ",
              "hl": "the right supplier",
              "post": " at no cost"
            },
            {
              "pre": "",
              "hl": "Multiple suppliers",
              "post": " come to you with quotes"
            }
          ],
          "hotTags": [
            "Vegetables",
            "Fruit",
            "Pork",
            "Beef",
            "Hot Pot",
            "Dry Goods"
          ],
          "heroPromises": [
            "No cost to buyers",
            "Zero commission",
            "Avg. 4-hour reply"
          ],
          "stats": [
            "Partner suppliers",
            "Requests matched",
            "F&B and food businesses served",
            "Ingredients and food products"
          ],
          "statsUnits": [
            "",
            "",
            "",
            ""
          ],
          "pfProblems": [
            "Finding suppliers mostly depends on word of mouth, and online searches keep turning up the same few names",
            "Product details are incomplete, so you still have to call around for prices and delivery coverage",
            "You leave your contact details, then wait days without hearing back"
          ],
          "pfTypes": [
            "Farms & growers",
            "Processors",
            "Large wholesalers",
            "Mid‑size wholesalers",
            "Small wholesalers"
          ],
          // 首頁「每天叫貨」:英文每句(含下面的 rpLeadA / rpLeadB)最後兩個字用不換行空白 \u00a0 黏住,
          // 手機上最後一行才不會只剩一個字(Chrome 的 text-wrap:pretty 只管四行以內的段落,320px 的英文問題列有九行)。
          // 改英文時請保留;結尾不要用帶連字號的字(error-prone 這種),連字號後面還是會斷。
          "rpProblems": [
            "Orders are scattered across LINE, phone calls and paper, and with so many messages, some get\u00a0missed",
            "Every day you re-check items, quantities, prices and delivery times, which takes time and is easy to get\u00a0wrong",
            "Order and reconciliation records are spread out, so month-end bookkeeping eats up hours and adds labor\u00a0costs",
            "Without exact ingredient costs and purchase volumes, it's hard to tell if the restaurant is really making\u00a0money"
          ],
          "rpFeatures": [
            "Central ordering",
            "Order summaries",
            "Delivery tracking",
            "Order history",
            "Quick reconciliation"
          ],
          "audiences": [
            {
              "title": "Restaurants & Bistros",
              "desc": "Small orders welcome. Switch suppliers without rebuilding your network."
            },
            {
              "title": "Catering & Schools",
              "desc": "High volume, steady supply, full documentation — qualified suppliers in one pass."
            },
            {
              "title": "Group Buying & E-Commerce",
              "desc": "Source direct or find contract manufacturers. Volume and pricing talks start here."
            },
            {
              "title": "Processors & Distributors",
              "desc": "Lock in steady raw-material supply and line up backup vendors."
            }
          ],
          "flow": [
            {
              "title": "Submit a request",
              "desc": "Items, volume, delivery area — 2 minutes."
            },
            {
              "title": "We match",
              "desc": "Sent only to suppliers who can stock it and deliver it."
            },
            {
              "title": "Get quotes",
              "desc": "Replies start arriving in about 4 hours."
            },
            {
              "title": "Compare & negotiate",
              "desc": "Weigh price, delivery, and certifications side by side."
            },
            {
              "title": "Order & restock",
              "desc": "Deal directly with the supplier. We take no commission."
            },
            {
              "title": "Two-way reviews",
              "desc": "Good suppliers get seen by more buyers."
            }
          ],
          "categories": [
            "Vegetables",
            "Fruit",
            "Seafood",
            "Meat",
            "Eggs",
            "Grains & Cereals",
            "Dry Goods & Pantry Staples",
            "Processed Foods",
            "Hot Pot Ingredients",
            "Seasonings",
            "Beverages & Alcohol",
            "Packaging & Supplies"
          ],
          "testimonials": [
            {
              "who": "Mr. Lin",
              "role": "Japanese restaurant, Taipei",
              "quote": "Switching produce suppliers used to take three months of asking around. Here I filed a request and had three quotes the next day."
            },
            {
              "who": "Director Chen",
              "role": "Elementary school lunch program",
              "quote": "Suppliers with traceability certification are hard to find. Here I can filter for certified vendors directly."
            },
            {
              "who": "Ms. Wang",
              "role": "Fresh-food group-buying host",
              "quote": "I finally deal with growers directly, without a middleman's markup."
            }
          ],
          "trust": [
            {
              "title": "Two-way reviews",
              "desc": "Buyers and suppliers rate each other after every match, so strong suppliers get more visibility."
            },
            {
              "title": "Certifications and lab reports linked",
              "desc": "Traceability certification (TAP) and SGS lab reports come with document links you can verify with the issuing body."
            },
            {
              "title": "LINE instant alerts",
              "desc": "Be the first to know about new suppliers, ingredient deals, and match results."
            }
          ],
          "askPrefix": "I'm looking for: "
        }
      },
      "rest": {
        "caps": {
          "cost": {
            "li1": "See ingredient cost and cost ratio for every dish",
            "li2": "Compare supplier pricing and see exactly where quotes differ",
            "li3": "Check substitute ingredients and seasonal references when you need to adjust",
            "sub": "Put dish-level ingredient costs next to supplier quotes, so purchasing decisions rest on real numbers.",
            "title": "Costing & Purchasing"
          },
          "menuAi": {
            "li1": "Detect dishes and ingredients, and build an editable menu structure",
            "li2": "Confirm or edit the results, and fill in quantities and units",
            "li3": "Turn dishes back into actual purchasing requirements",
            "sub": "Upload a menu and the system drafts the dishes and ingredients for your team to review and confirm.",
            "title": "AI Menu Analysis"
          },
          "orders": {
            "li1": "Track purchasing and order status in one place",
            "li2": "Let the team confirm receipt when goods arrive",
            "li3": "Keep an append-only event history that explains every status change",
            "sub": "One consistent status from order to delivery, so whoever places the order and whoever receives it see the same progress.",
            "title": "Orders & Receiving"
          },
          "sectionAria": "Restaurant product capabilities",
          "team": {
            "li1": "Manage locations and team members",
            "li2": "Set owner, manager and purchaser roles",
            "li3": "Maintain receiving addresses and time windows for each location",
            "sub": "Assign account roles by location and responsibility, so buyers, managers and receiving staff each get the right access.",
            "title": "Team Management"
          }
        },
        "cases": {
          "c1": {
            "body": "A single round of matching connected them with three produce suppliers and a steady flow of seasonal ingredients.",
            "stat1Label": "to compare suppliers",
            "stat1Value": "3 days",
            "stat2Label": "ingredient purchasing cost",
            "tag": "Restaurant operator",
            "title": "A single-location restaurant stops chasing quotes"
          },
          "c2": {
            "body": "Sourcing from several suppliers at once cut single-source stockout risk and kept service reliable.",
            "stat1Label": "steady supplier partners",
            "stat2Label": "stockouts",
            "tag": "Institutional caterer",
            "title": "High-volume catering on a steadier supply base"
          },
          "eyebrow": "Results",
          "sub": "Results vary by business type, purchasing volume and time frame.",
          "title": "Real results from restaurant buyers"
        },
        "cta": {
          "sub": "Create a restaurant account and start organizing menus, suppliers and purchase orders.",
          "title": "Start your next order with a clear process"
        },
        "ctaCreateAccount": "Create restaurant account",
        "flow": {
          "eyebrow": "Daily workflow",
          "s1": {
            "body": "Upload a menu, or just list the ingredients you need to buy.",
            "title": "Capture menus and needs"
          },
          "s2": {
            "body": "Check items, quantities and units before the team works from them.",
            "title": "Confirm ingredients and specs"
          },
          "s3": {
            "body": "See your suppliers and their item quotes in one place.",
            "title": "Compare suppliers and prices"
          },
          "s4": {
            "body": "Track progress, then have the team confirm goods on arrival.",
            "title": "Place orders and confirm receipt"
          },
          "sub": "Your team confirms every step, leaving a clear record of what was ordered and why.",
          "title": "From menu and demand through to receiving"
        },
        "hero": {
          "ctaSecondary": "See features",
          "sub": "Menus, ingredient costs, supplier comparisons, purchase orders and team permissions in one clear workflow, so daily purchasing stays under control.",
          "title": "From menu analysis to receiving, all in one platform"
        },
        "pain": {
          "compare": {
            "body": "Quotes end up scattered, and pulling them together eats most of the buyer's day.",
            "title": "Comparing quotes eats the day"
          },
          "eyebrow": "On the ground",
          "manual": {
            "body": "Finding a new ingredient or supplier means calling around and asking other operators.",
            "title": "Manual research and word of mouth"
          },
          "specs": {
            "body": "Items, units and quote formats all differ, so there's no clean way to compare them side by side.",
            "title": "Incomplete specs and pricing"
          },
          "sub": "When information is spread across phone calls, chat threads and spreadsheets, teams can't make consistent purchasing decisions quickly.",
          "title": "Purchasing shouldn't run on contacts and scattered messages",
          "track": {
            "body": "Orders, deliveries and changes have no shared record, so details slip during handoffs.",
            "title": "Orders and deliveries are hard to track"
          }
        }
      },
      "sup": {
        "heroTitle": "From catalog to leads, quotes, and delivery",
        "heroSub": "Bring your catalog, restaurant demand, quotes, orders, and customer relationships into one workflow. Every call is still yours to make; the platform organizes the information and tracks the progress.",
        "applyCta": "Apply as a Supplier",
        "heroCtaSecondary": "See supplier features",
        "painEyebrow": "Common supplier challenges",
        "painTitle": "Good products shouldn't get lost in scattered inquiries",
        "painSub": "When requests, quotes, and account history sit in separate conversations, both response time and follow-up get harder to control.",
        "painScatteredTitle": "Demand is scattered and easy to miss",
        "painScatteredDesc": "Leads arrive through several channels, and every item and service area has to be checked one at a time.",
        "painQuotesTitle": "Quotes and lead times take endless back-and-forth",
        "painQuotesDesc": "Pricing, payment terms, and substitute items get lost in long message threads.",
        "painPricingTitle": "Pricing without market reference",
        "painPricingDesc": "It's hard to see what comparable items go for nearby, or how demand has shifted recently.",
        "painRetentionTitle": "Repeat business is hard to track",
        "painRetentionDesc": "After a deal closes, order frequency and account status still have to be tracked by hand.",
        "flowEyebrow": "One clear path to orders",
        "flowTitle": "From getting found to quoting, closing, and keeping the account",
        "flowSub": "Start with product data that can be matched, then work through leads, orders, and customer relationships.",
        "flowCatalogTitle": "Build your catalog",
        "flowCatalogDesc": "Organize the items you supply, your pricing, and your service area.",
        "flowLeadsTitle": "Receive matched leads",
        "flowLeadsDesc": "See restaurant requests that match your catalog.",
        "flowQuoteTitle": "Quote and confirm orders",
        "flowQuoteDesc": "Submit your terms, then track what's accepted and what's still pending.",
        "flowShipTitle": "Ship and build the relationship",
        "flowShipDesc": "Confirm shipment, then review order, customer, and rating history.",
        "cap1Eyebrow": "01 · Find the right demand",
        "cap1Title": "Lead radar",
        "cap1Sub": "The platform matches restaurant requests against your catalog and service area and lays out the leads. You review the status and decide what to do next.",
        "cap1Li1": "Automatic matching between requests and your catalog",
        "cap1Li2": "Track new leads and where each one stands",
        "cap1Li3": "Spot catalog gaps from the last 90 days of demand",
        "cap2Eyebrow": "02 · Quote to delivery",
        "cap2Title": "Quotes and orders",
        "cap2Sub": "Review requests, send quotes, and track purchase orders in one place. Every confirmation is still made by the supplier.",
        "cap2Li1": "Quote price, lead time, payment terms, and substitute items",
        "cap2Li2": "See what's pending, quoted, and accepted",
        "cap2Li3": "Track orders awaiting confirmation, then confirm shipment",
        "cap3Eyebrow": "03 · Read the market",
        "cap3Title": "Pricing and forecasting",
        "cap3Sub": "Use existing quote and demand data on the platform as a reference for how competitive your pricing is and what to stock next.",
        "cap3Li1": "Compare your price against the local range and see where you rank",
        "cap3Li2": "Review demand volume over the last 13 weeks",
        "cap3Li3": "Get next-week stocking suggestions and seasonality notes from the last 90 days",
        "cap4Eyebrow": "04 · Keep the account growing",
        "cap4Title": "Customer management",
        "cap4Sub": "After an order closes, the platform builds a customer profile from your history together and brings ratings and service metrics into one view.",
        "cap4Li1": "See each restaurant's order frequency, lifetime value, and repeat rate",
        "cap4Li2": "Flag customers at risk of churn so you can reach out first",
        "cap4Li3": "Collect transaction ratings, store reviews, and star distribution",
        "outcomesEyebrow": "Platform scale and use cases",
        "outcomesTitle": "What supplier results look like",
        "outcomesSub": "Public platform figures and product mockups are shown separately, so a UI example is never mistaken for one customer's actual results.",
        "statLabel": "Public platform figures",
        "stat1Desc": "Local suppliers",
        "stat2Value": "28",
        "stat2Desc": "Ingredient categories",
        "stat3Desc": "Average match response",
        "outcomesNoteLabel": "Sample data, not a specific customer's results",
        "outcomesNoteBody": "A full working day can run straight through: review new leads, answer open quote requests, confirm orders and shipments, then use customer and rating records to plan follow-up.",
        "outcomesDisclaimer": "Results vary by product category, service area, supply capacity, and how long you have been active.",
        "ctaTitle": "Make it easier for the next good lead to find you",
        "ctaSub": "Apply as a supplier and start building your catalog and service area."
      },
      "cases": {
        "heroTitle": "How restaurants and suppliers improve sourcing together",
        "heroSub": "From demand matching and supply sources to ingredient traceability, these cases show what different types of operations improved within their own sourcing context.",
        "resultsEyebrow": "Approved case results",
        "resultsTitle": "Compared by role and level of improvement",
        "resultsNote": "Figures are individual case results, shown to illustrate sourcing scenarios. They are not a guarantee that every user will see the same outcome.",
        "case1": {
          "eyebrow": "Restaurant outcome · Sourcing speed and cost",
          "title": "A single-site restaurant stops chasing quotes",
          "body": "One matching request connected them with three produce suppliers and a steady supply of seasonal ingredients.",
          "stat1Value": "3 days",
          "stat1Label": "To compare suppliers",
          "stat2Label": "Ingredient sourcing cost"
        },
        "case2": {
          "eyebrow": "Restaurant outcome · Supply reliability",
          "title": "Institutional catering with steadier sourcing",
          "body": "Working with several suppliers at once cut the risk of a single source running out, so every service stayed covered.",
          "stat1Label": "Steady supplier partners",
          "stat2Label": "Stockouts"
        },
        "case3": {
          "eyebrow": "Supplier outcome · Traceability and trust",
          "title": "Farm-direct supply that earns customer trust",
          "body": "Sourcing from farms with traceability certification (TAP) made both the product story and the quality claim more convincing.",
          "stat1Label": "Repeat purchase rate",
          "stat2Label": "Customer rating"
        },
        "disclaimer": "Results vary by business type, sourcing volume, and time in use.",
        "ctaRestaurant": "Restaurant sign-up",
        "ctaSupplier": "List as supplier"
      },
      "about": {
        "heroTitle": "Where restaurant demand meets supply capability",
        "heroBody": "iFoodmap is a two-sided B2B sourcing platform that connects restaurants with ingredient suppliers. Restaurants organize requirements, compare quotes, and manage purchasing; suppliers present their products, respond to opportunities, and keep building customer relationships.",
        "valueEyebrow": "Value for both sides",
        "valueTitle": "Keep information moving through the sourcing process",
        "valueBody": "One platform carries the level of detail both sides need, so requests, quotes, orders, and shipments stop scattering across separate channels.",
        "forRestaurantsLabel": "For restaurants",
        "forRestaurantsTitle": "State requirements clearly and decide with confidence",
        "forRestaurantsBody": "Start from your menu, items, and specs, then compare supply sources, pricing, and order status step by step.",
        "forSuppliersLabel": "For suppliers",
        "forSuppliersTitle": "Find opportunities and serve customers efficiently",
        "forSuppliersBody": "Receive requests matched to your catalog and service area, and handle quotes, orders, shipments, and customer records in one place.",
        "valuesEyebrow": "What we stand for",
        "valuesTitle": "Three core values",
        "value1Title": "Efficient matching",
        "value1Body": "Data and AI help both sides organize their requirements, so every purchase finds the right partner faster.",
        "value2Title": "Fair and transparent",
        "value2Body": "Requests, specs, quotes, and service history all stay on the record, so both sides decide with the same information.",
        "value3Title": "Locally sustainable",
        "value3Body": "We connect local supply chains nationwide (Taiwan) to shorten the distance between farm, supplier, and table."
      },
      "contact": {
        "heroEyebrow": "Partnerships",
        "heroTitle": "Let's build a better ingredient supply chain, together",
        "heroBody": "Channel operators, software vendors, logistics providers and brands — this is where partnership conversations start. Tell us what you have in mind and the right person will come back to you.",
        "typesEyebrow": "Where we partner",
        "typesTitle": "The partnerships we're looking for",
        "typesBody": "We're open to more than these four, but these are the ones we already have a playbook for — they move fastest.",
        "typeChannelTitle": "Channel & retail partnerships",
        "typeChannelDesc": "Restaurant groups, institutional caterers, food distributors and retail chains: bring the iFoodmap supplier network into the purchasing process you already run, without replacing it.",
        "typeIntegrationTitle": "System integration (API, ERP, POS)",
        "typeIntegrationDesc": "Two-way integration with POS, ERP, inventory and ordering systems, so requests, quotes and orders move between both sides instead of being keyed in twice.",
        "typeLogisticsTitle": "Logistics, warehousing & cold chain",
        "typeLogisticsDesc": "Ambient, chilled and frozen delivery, consolidation warehousing and last-mile. Make delivery windows and temperature control dependable enough that kitchens commit real volume.",
        "typeBrandingTitle": "Brand collaborations & marketing",
        "typeBrandingDesc": "Producer stories, co-branded products, events and content — put supply worth noticing in front of far more operators.",
        "flowEyebrow": "How it works",
        "flowTitle": "Three steps from enquiry to a real conversation",
        "step1Title": "Send the enquiry",
        "step1Desc": "Your company, how to reach you, and the direction you'd like to explore. The more specific it is, the more homework we can do before replying.",
        "step2Title": "We reply within three business days",
        "step2Desc": "The lead for that type of partnership emails you back with an initial assessment and anything else we need from your side.",
        "step3Title": "Meet online or on site",
        "step3Desc": "Scope, ownership and timeline. Once the direction is agreed we move to a pilot, or straight to an agreement.",
        "formEyebrow": "Partnership enquiry",
        "formTitle": "Partnership enquiry form",
        "formHelp": "Fields marked * are required. We'll reply by email, and what you enter here is used only to assess the partnership.",
        "labelCompany": "Company name",
        "placeholderCompany": "e.g. Good Harvest Foods Co., Ltd.",
        "labelName": "Contact name",
        "placeholderName": "e.g. Jamie Chen",
        "labelJobTitle": "Job title",
        "placeholderJobTitle": "e.g. Business Development Manager",
        "labelEmail": "Email",
        "placeholderEmail": "name@company.com",
        "labelPhone": "Phone",
        "placeholderPhone": "+886 2 0000 0000",
        "labelWebsite": "Company website / relevant link",
        "placeholderWebsite": "https://",
        "labelPartnerType": "Partnership type",
        "partnerTypePlaceholder": "Select a partnership type",
        "partnerTypeChannel": "Channel & retail partnerships",
        "partnerTypeIntegration": "System integration (API, ERP, POS)",
        "partnerTypeLogistics": "Logistics, warehousing & cold chain",
        "partnerTypeBranding": "Brand collaborations & marketing",
        "partnerTypeOther": "Something else",
        "labelMessage": "Tell us about the partnership",
        "placeholderMessage": "What you have in mind, the scale and timing you're working with, and what you'd need from iFoodmap.",
        "submit": "Send enquiry",
        "formRequire": "Please complete the required fields and check your email address",
        "formSubmitting": "Sending…",
        "formSuccess": "✓ Got it — we'll be in touch shortly",
        "formFailure": "Couldn't send — please try again or email us",
        "formRateLimited": "Daily limit reached — please try tomorrow or email us",
        "infoEyebrow": "Other ways to reach us",
        "infoTitle": "Skip the form and contact us directly",
        "phoneIcon": "T",
        "phoneLabel": "Service line",
        "phoneAria": "Call our service line on 02-7704-5539",
        "emailLabel": "Email",
        "emailAria": "Email ifoodmaptw@gmail.com",
        "hoursIcon": "H",
        "hoursLabel": "Business hours",
        "hoursValue": "Mon–Fri 9:00 – 18:00",
        "lineLabel": "Official LINE",
        "lineValue": "Add us for instant support",
        "lineAria": "Add the iFoodmap official LINE account (opens in a new window)",
        "exitEyebrow": "Not here about a partnership?",
        "exitTitle": "Looking for ingredients instead?",
        "exitBody": "This form is for partnership enquiries. If what you actually need is suppliers and quotes, skip the form — the AI sourcing assistant in the bottom-right corner will take it from there.",
        "aiTitle": "Just tell our AI assistant",
        "aiHelp": "No forms. Say what you need and the assistant will work through the items, volume, delivery area and timing, then send your request to suppliers that fit.",
        "aiCta": "Start chatting — free →",
        "aiHint": "You can also upload a photo of your menu and let it build the sourcing list for you.",
        "aiQuickLabel": "Common requests — tap to start",
        "roleGridLabel": "Platform entry points by role",
        "roleRestaurantTitle": "I'm a restaurant",
        "roleRestaurantAction": "Create a restaurant account →",
        "roleSupplierTitle": "I'm a supplier",
        "roleSupplierAction": "Apply to list as a supplier →"
      },
      "footer": {
        "brandTagline": "Food Sourcing Map",
        "phoneLabel": "Service line",
        "hoursLabel": "Hours",
        "hoursValue": "Mon–Fri 9:00–18:00",
        "serviceFindIngredients": "Find ingredients",
        "serviceBecomeSupplier": "Become a supplier",
        "servicePlatformFeatures": "Platform features",
        "serviceLogin": "Log in",
        "companyAbout": "About us",
        "companyCases": "Case studies",
        "companyNews": "News",
        "companyContact": "Contact",
        "supportFaq": "FAQ",
        "supportTerms": "Terms of Service",
        "supportPrivacy": "Privacy Policy",
        "socialLineLabel": "Customer LINE@",
        "socialLineAria": "Add the iFoodmap customer-service LINE@ account (opens in a new window)",
        "socialFollowLabel": "Follow us",
        "socialFacebookAria": "Follow iFoodmap on Facebook (opens in a new window)",
        "sep": ": ",
        "copyright": "©{year} by ifoodmap All rights are reserved."
      },
      "meta": {
        "siteName": "iFoodmap",
        "keywords": "food ingredient sourcing,restaurant supply chain,supplier matching,B2B ingredients,Taiwan food suppliers,ifoodmap,AI procurement,farm direct",
        "author": "iFoodmap",
        "langSwitchLabel": "Switch language",
        "langSwitchToEn": "English",
        "langSwitchToZh": "中文",
        "pages": {
          "home": {
            "title": "iFoodmap | B2B Ingredient Sourcing for Restaurants and Suppliers",
            "description": "iFoodmap uses AI to connect restaurant demand with ingredient suppliers across Taiwan, bringing matching, quote comparison, orders, delivery and purchasing into one platform."
          },
          "restaurants": {
            "title": "For Restaurants | From Menu Analysis to Receiving - iFoodmap",
            "description": "Organize ingredient requirements, compare supplier quotes, track orders and deliveries, with AI menu analysis and cost breakdowns. Every step of restaurant purchasing in one workflow."
          },
          "suppliers": {
            "title": "For Suppliers | From Catalog to Leads, Quotes and Delivery - iFoodmap",
            "description": "List your catalog, receive restaurant demand, respond with quotes and build customer relationships. iFoodmap organizes the information; every call is still yours to make."
          },
          "cases": {
            "title": "Case Studies | How Restaurants and Suppliers Improve Sourcing - iFoodmap",
            "description": "What single-location restaurants, institutional catering operations and fresh-produce group buyers improved within their own sourcing context."
          },
          "about": {
            "title": "About | Where Restaurant Demand Meets Supply Capability - iFoodmap",
            "description": "iFoodmap is a two-sided B2B sourcing platform connecting restaurants with ingredient suppliers, keeping information moving through the sourcing process."
          },
          "contact": {
            "title": "Partnerships | Channel, Integration, Logistics and Brand Collaborations - iFoodmap",
            "description": "iFoodmap partners with channel operators, system integrators, logistics providers and brands. Send a partnership enquiry and the right team replies within three business days."
          },
          "news": {
            "title": "News | Sourcing and Food Safety, Sorted Out - iFoodmap",
            "description": "From ingredient procurement and traceability to market trends — what restaurants and catering operations actually need to know."
          },
          "article": {
            "title": "News | Sourcing and Food Safety, Sorted Out - iFoodmap",
            "description": "From ingredient procurement and traceability to market trends — what restaurants and catering operations actually need to know."
          },
          "legal": {
            "title": "Legal | Terms of Use and Privacy Policy - iFoodmap",
            "description": "iFoodmap's Terms of Use and Privacy Policy. These documents are translations of the Chinese originals; the Chinese version prevails."
          },
          "qa": {
            "title": "FAQ | How joining, review and pricing work - iFoodmap",
            "description": "How suppliers join iFoodmap, how the review works and what the paid plans cover — the questions we are asked most. Can't find your answer? Ask our AI sourcing assistant."
          }
        }
      },
      "news": {
        "heroEyebrow": "News",
        "heroTitle": "Sourcing and food safety, sorted out",
        "heroSub": "From ingredient procurement and traceability to market trends — the things restaurants and catering operations actually need to know.",
        "countLabel": "articles",
        "readMore": "Read more →",
        "backToList": "← Back to all news",
        "publishedOn": "Published",
        "sourceLinks": "Links referenced in this article",
        "notFoundTitle": "We couldn't find that article",
        "notFoundBody": "This link may have changed or been removed. Head back to the news list to see what else is there.",
        "coverAlt": "Article cover"
      },
      "legal": {
        "eyebrow": "Legal",
        "updatedLabel": "Last updated",
        "noUpdatedLabel": "No version date was stated on the previous site",
        "prevail": "This English version is a translation provided for convenience only. In the event of any discrepancy or ambiguity between the English and Chinese versions, the Chinese version shall prevail.",
        "prevailLabel": "Governing version",
        "tocTitle": "On this page",
        "docNavLabel": "Legal documents",
        "otherDocsTitle": "Other documents",
        "indexTitle": "Legal documents",
        "indexBody": "These are the terms and policies that currently apply to iFoodmap.",
        "notFoundTitle": "We couldn't find that document",
        "notFoundBody": "This link may have changed or been removed. Here are the legal documents currently available.",
        "readDoc": "Read in full →"
      },
      "qa": {
        "heroEyebrow": "FAQ",
        "heroTitle": "Joining, review and pricing — the questions we get most",
        "heroSub": "The questions suppliers ask most often, before and after joining iFoodmap. If your answer isn't here, the AI sourcing assistant in the corner can answer it directly.",
        "countLabel": "questions",
        "ctaTitle": "Still not finding your answer?",
        "ctaBody": "Tell the AI sourcing assistant what you need. It answers around your products, delivery areas and timing, and can send your request to the suppliers that fit.",
        "ctaButton": "Start chatting — free →",
        "ctaHint": "Free for buyers, and no account needed to start a conversation.",
        "items": [
          {
            "question": "I'm an ingredient supplier. How do I join iFoodmap and become a listed supplier?",
            "paras": [
              "Start with the supplier application form — you don't need to create an account first. Once the platform approves your application, we'll email an invitation to the address you entered. Click the link in that email to set your password, then sign in to the supplier dashboard and start receiving forwarded ingredient requests."
            ],
            "linkHref": "{supplierApplicationUrl}",
            "linkText": "Go to the supplier application form"
          },
          {
            "question": "Is there a fee to become a listed supplier?",
            "paras": [
              "Once your supplier details are registered and approved, you start receiving ingredient requests that match what you sell and the areas you deliver to. To go further — contacting the buyer, quoting and working out the details — you need to move onto a paid supplier plan."
            ],
            "linkHref": "https://www.ifoodmap.com.tw/how/pointRule",
            "linkText": "See the pricing plans"
          }
        ]
      },
      "ai": {
        "fabLabel": "Open the AI sourcing assistant",
        "fabTitle": "Looking for ingredients?",
        "title": "iFoodMap AI Sourcing Assistant",
        "subtitle": "Upload a menu or describe your needs",
        "closeLabel": "Close",
        "inputSrLabel": "Describe your ingredient needs",
        "uploadLabel": "Upload a menu photo",
        "inputPlaceholder": "What ingredients do you need?",
        "placeholderLocked": "Sign up free to keep chatting",
        "placeholderCooldown": "Try again shortly, or sign up free",
        "sendLabel": "Send",
        "dropHint": "Drop to upload your menu 📷",
        "greeting": "Hi, I'm the iFoodMap AI sourcing assistant 👋\nTwo ways to start:\n📷 Upload a photo of your menu and I'll turn it into a sourcing list\n💬 Or just type the ingredients you need",
        "errService": "The AI service is busy right now — please try again shortly 🙏 You can also leave your contact details and our team will match you with suppliers at no cost.",
        "quotaUsed": "You've used up the free trial. Sign up to keep chatting.",
        "rateLimitedWait": "Please try again in {minutes} min, or sign up free now",
        "quotaResumed": "You can keep chatting now — go ahead and describe what you need 🙌",
        "tooLong": "That message is a bit long — please keep it under {max} characters 🙏",
        "imageTooLarge": "That photo is too large — please try a smaller one 📷",
        "imageUnsupported": "That image format isn't supported — please use JPG, PNG or WebP 📷",
        "uploadLimit": "You can upload up to {max} photos per chat. Sign up free to upload more 📷",
        "ctaRegister": "Sign up free →",
        "ctaRegisterBusy": "Taking you to sign-up…",
        "ctaEmail": "Rather not sign up? Leave your email and we'll reach out",
        "ctaSwitchRegister": "Sign up free instead →",
        "ctaCancelLead": "Cancel — back to the chat",
        "leadCancelled": "No problem — no email needed. You can sign up free or leave your email whenever you like 👇",
        "ctaPrefixChat": "Want to keep this request? Sign up free and we'll turn it into a draft purchase order for you 👇",
        "ctaPrefixAnalysis": "Your sourcing list is ready. Sign up free to save it as a draft purchase order 👇",
        "ctaPrefixDone": "Your request is ready. Sign up free and what we just discussed becomes your draft purchase order 👇",
        "ctaPrefixEnded": "Whenever you need ingredients, sign up free or leave your email and our team will reach out 👇",
        "uploadImageOnly": "Please upload an image file (JPG or PNG).",
        "dropImageOnly": "Please drop an image file (JPG or PNG).",
        "menuImageAlt": "Menu",
        "analysisFallback": "Here's what the AI found in your menu:",
        "askName": "Great. So our team can follow up, what's your name? 😊",
        "placeholderName": "Enter your name…",
        "askEmail": "Thanks, {name}. What's the best email to reach you? Our team will follow up shortly ✉️",
        "placeholderEmail": "Enter your email…",
        "emailInvalid": "That email doesn't look quite right — could you send it again? Example: name@company.com",
        "sending": "Sending…",
        "leadSuccess": "✓ Got it, {name}. We'll email you at {email} shortly and match you with the right suppliers at no cost 🙌",
        "leadFailure": "Couldn't send that — please try again in a moment 🙏",
        "leadRateLimited": "We've reached today's limit for messages. Please try again tomorrow, or email us at ifoodmaptw@gmail.com and we'll get back to you 🙏"
      }
    }
  };
  /* ==== DICT:END ==== */

  // 'zh-TW' / 'zh-Hant-TW' / 'ZH' → 'zh';'en-US' → 'en';其他 → null
  function normalizeLang(tag) {
    var value = String(tag == null ? '' : tag).trim().toLowerCase();
    if (!value) return null;
    for (var i = 0; i < LANGS.length; i++) {
      if (value === LANGS[i] || value.indexOf(LANGS[i] + '-') === 0) return LANGS[i];
    }
    return null;
  }

  // 瀏覽器語系:navigator.languages 是使用者在系統/瀏覽器排好的偏好順序,優先於 navigator.language。
  // 兩邊都沒有認得的語系(例如只設了日文)就回 null,交給呼叫端 fallback 到預設語系。
  function fromNavigator(win) {
    var nav = win && win.navigator;
    if (!nav) return null;
    var tags = [];
    var list = nav.languages;
    if (list && typeof list.length === 'number') {
      for (var i = 0; i < list.length; i++) tags.push(list[i]);
    }
    if (nav.language) tags.push(nav.language);
    for (var j = 0; j < tags.length; j++) {
      var match = normalizeLang(tags[j]);
      if (match) return match;
    }
    return null;
  }

  // localStorage 在無痕視窗/擋第三方儲存時會直接 throw,不是回 null —— 一定要包 try。
  function storedLang(win) {
    try {
      return normalizeLang(win.localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return null;
    }
  }

  function storeLang(win, lang) {
    var value = normalizeLang(lang);
    if (!value) return false;
    try {
      win.localStorage.setItem(STORAGE_KEY, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 使用者按過語言鈕就聽他的;沒按過才看瀏覽器設定;都沒有就中文。
  // 🔴 不要拿它的結果去轉址:它會看瀏覽器語系,Googlebot(en-US)會因此被轉走。
  //    裸網址 / 的自動落地只吃 storedLang(),瀏覽器語系只給 suggestLang() 當「建議」。
  function detect(win) {
    return storedLang(win) || fromNavigator(win) || DEFAULT_LANG;
  }

  // 按過提示條的 × 沒有。localStorage 會 throw 的瀏覽器(無痕)當作沒按過 ——
  // 那種瀏覽器只能記在記憶體裡(元件的 langHintOff),重新整理之後會再出現一次,沒辦法。
  function hintDismissed(win) {
    try {
      return win.localStorage.getItem(HINT_DISMISSED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function dismissHint(win) {
    try {
      win.localStorage.setItem(HINT_DISMISSED_KEY, '1');
      return true;
    } catch (e) {
      return false;
    }
  }

  // 首頁頂端的語系提示條要建議哪個語系;不該出現就回 null。全部成立才建議:
  //   1. 在首頁(/ 或 /en)。深層頁多半是從搜尋結果或分享連結進來的,人已經在看他要的東西,
  //      而且 Googlebot 以 en-US 渲染每一頁 —— 只放首頁,它在中文頁上看到的英文句子就只有這一處。
  //   2. 沒按過語言鈕(ifm.lang 沒有值)。按過的人在 / 會被自動轉,也知道語言鈕在哪。
  //   3. 沒按過提示條的 ×(關過就不再煩人家)。
  //   4. 瀏覽器語系認得出來,而且跟這一頁不同。
  // 🔴 這裡只「建議」,絕不轉址。為什麼不能依瀏覽器語系轉,見 routing.js 的 applyPreferredLang。
  function suggestLang(win, page, pageLang) {
    var current = normalizeLang(pageLang);
    if (page !== 'home' || !current) return null;
    if (storedLang(win) || hintDismissed(win)) return null;
    var browser = fromNavigator(win);
    return browser && browser !== current ? browser : null;
  }

  function dict(lang) {
    return DICT[normalizeLang(lang) || DEFAULT_LANG] || DICT[DEFAULT_LANG];
  }

  // 反查:給一個寫死在程式裡的中文字面值,回傳它在其他語系的所有對應字串。
  // 為什麼需要 —— 有些 script 是靠「比對畫面上的文字」來做事的(例如缺圖佔位框換圖的對照表
  // IMG_MAP,key 就是佔位框裡那行中文)。畫面文字一旦跟著語系換掉,那些比對就會全部落空。
  // 同一個中文可能在字典裡出現多次、譯法不同,所以回傳陣列,呼叫端把每一種都註冊進去。
  var literalIndex = null;

  function indexLiterals(zhNode, enNode, out) {
    if (typeof zhNode === 'string') {
      if (typeof enNode !== 'string' || !zhNode) return;
      var bucket = out[zhNode] || (out[zhNode] = []);
      if (bucket.indexOf(enNode) === -1) bucket.push(enNode);
      return;
    }
    if (Array.isArray(zhNode)) {
      if (!Array.isArray(enNode)) return;
      for (var i = 0; i < zhNode.length; i++) indexLiterals(zhNode[i], enNode[i], out);
      return;
    }
    if (zhNode && typeof zhNode === 'object' && enNode && typeof enNode === 'object') {
      for (var key in zhNode) {
        if (Object.prototype.hasOwnProperty.call(zhNode, key)) indexLiterals(zhNode[key], enNode[key], out);
      }
    }
  }

  function translateAll(zhText) {
    if (!literalIndex) {
      literalIndex = {};
      indexLiterals(DICT.zh, DICT.en, literalIndex);
    }
    return Object.prototype.hasOwnProperty.call(literalIndex, zhText) ? literalIndex[zhText].slice() : [];
  }

  function other(lang) {
    return normalizeLang(lang) === 'en' ? 'zh' : 'en';
  }

  // 「現在是哪個語系」的唯一真相是網址(routing.js 的前綴),不是 localStorage ——
  // localStorage 只記「使用者按過什麼」,用來決定裸網址 / 要落在哪一版。
  function current(win) {
    var routing = win && win.IfmRouting;
    if (routing && typeof routing.pathToLang === 'function' && win.location) {
      return routing.pathToLang(win.location.pathname);
    }
    return detect(win);
  }

  // React 外面的東西(右下角 AI 助手、表單狀態訊息)沒有 state 可以重繪,
  // 靠這個事件自己去換字。
  var CHANGE_EVENT = 'ifm:langchange';

  function emitChange(win, lang) {
    var value = normalizeLang(lang);
    if (!win || !value || typeof win.dispatchEvent !== 'function') return false;
    try {
      win.dispatchEvent(new win.CustomEvent(CHANGE_EVENT, { detail: { lang: value } }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function onChange(win, handler) {
    if (!win || typeof win.addEventListener !== 'function') return function () {};
    var wrapped = function (event) { handler((event && event.detail && event.detail.lang) || current(win)); };
    win.addEventListener(CHANGE_EVENT, wrapped);
    return function () { win.removeEventListener(CHANGE_EVENT, wrapped); };
  }

  // 帶參數的句子:'謝謝 {name}！' → format(s, { name: '王小姐' })
  function format(template, params) {
    if (typeof template !== 'string' || !params) return template;
    return template.replace(/\{(\w+)\}/g, function (whole, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole;
    });
  }

  return {
    DEFAULT_LANG: DEFAULT_LANG,
    LANGS: LANGS,
    STORAGE_KEY: STORAGE_KEY,
    HINT_DISMISSED_KEY: HINT_DISMISSED_KEY,
    CHANGE_EVENT: CHANGE_EVENT,
    current: current,
    detect: detect,
    dismissHint: dismissHint,
    emitChange: emitChange,
    format: format,
    hintDismissed: hintDismissed,
    onChange: onChange,
    dict: dict,
    fromNavigator: fromNavigator,
    normalizeLang: normalizeLang,
    other: other,
    storeLang: storeLang,
    storedLang: storedLang,
    suggestLang: suggestLang,
    translateAll: translateAll,
    _dict: DICT,
  };
});
