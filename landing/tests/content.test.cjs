const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { dict } = require('../i18n.js');
const { renderMarkup } = require('./helpers/render.cjs');

// 站上文案已經全面改走字典(markup 綁 {{ L.x.y }},值在 i18n.js)。
// 把 zh 字典的值代回 markup,就還原成「中文版使用者真的看到的那份 HTML」——
// 底下每一條既有的中文文案斷言都原封不動跑在它上面,強度不變。
// 元件 script 不含綁定,渲染前後逐字相同,所以程式碼層的斷言一樣用 source。
const source = renderMarkup('zh');
// 首頁那些資料陣列(stats / flow / audiences / …)已經從 renderVals() 搬進字典
const homeData = dict('zh').home.data;
const homeStart = source.indexOf('<!-- ============ PAGE: HOME ============ -->');
const homeEnd = source.indexOf('<!-- ============ PAGE: RESTAURANTS ============ -->');
const home = source.slice(homeStart, homeEnd);
const restaurantsStart = source.indexOf('<!-- ============ PAGE: RESTAURANTS ============ -->');
const restaurantsEnd = source.indexOf('<!-- ============ PAGE: SUPPLIERS ============ -->');
const restaurants = source.slice(restaurantsStart, restaurantsEnd);
const suppliersStart = source.indexOf('<!-- ============ PAGE: SUPPLIERS ============ -->');
const suppliersEnd = source.indexOf('<!-- ============ PAGE: CASES ============ -->');
const suppliers = source.slice(suppliersStart, suppliersEnd);
const casesStart = source.indexOf('<!-- ============ PAGE: CASES ============ -->');
const casesEnd = source.indexOf('<!-- ============ PAGE: ABOUT ============ -->');
const cases = source.slice(casesStart, casesEnd);
const aboutStart = source.indexOf('<!-- ============ PAGE: ABOUT ============ -->');
const aboutEnd = source.indexOf('<!-- ============ PAGE: CONTACT ============ -->');
const about = source.slice(aboutStart, aboutEnd);
const contactStart = source.indexOf('<!-- ============ PAGE: CONTACT ============ -->');
// CONTACT 後面現在還有 NEWS 與 ARTICLE 兩個區段,切片要止於 NEWS 而不是 FOOTER,
// 否則 contact 這一段會把新聞頁整個吃進來(H1 就從 1 個變成 4 個)。
const contactEnd = source.indexOf('<!-- ============ PAGE: NEWS');
const contact = source.slice(contactStart, contactEnd);
const newsStart = source.indexOf('<!-- ============ PAGE: NEWS');
const articleStart = source.indexOf('<!-- ============ PAGE: ARTICLE');
const news = source.slice(newsStart, articleStart);
const qaStart = source.indexOf('<!-- ============ PAGE: QA');
const article = source.slice(articleStart, qaStart);
// QA 後面現在還有 LEGAL 區段,切片要止於 LEGAL 而不是 FOOTER,
// 否則 qa 會把法律文件頁整個吃進來(H1 就從 1 個變成 2 個)。
const legalStart = source.indexOf('<!-- ============ PAGE: LEGAL');
const qa = source.slice(qaStart, legalStart);
const legal = source.slice(legalStart, source.indexOf('<!-- ============ FOOTER ============ -->'));
const footerStart = source.indexOf('<!-- ============ FOOTER ============ -->');
const footerEnd = source.indexOf('</footer>', footerStart) + '</footer>'.length;
const footer = source.slice(footerStart, footerEnd);
const headerStart = source.indexOf('<!-- ============ HEADER ============ -->');
const headerEnd = source.indexOf('<!-- ============ PAGE: HOME ============ -->');
const header = source.slice(headerStart, headerEnd);
const drawerStart = source.indexOf('// ---- 漢堡選單');
const drawerEnd = source.indexOf('// ④ 滾動進度條', drawerStart);
const drawer = source.slice(drawerStart, drawerEnd);

const approvedCases = [
  ['單店餐廳，告別到處問價的日子', '透過一次需求媒合，快速對接三家蔬果供應商，穩定取得當季食材。', '3 天', '−15%'],
  ['大量供餐，採購來源更穩定', '同時對接多家供應商，降低單一來源斷貨風險，供餐更有保障。', '5+', '0'],
  ['產地直送，建立消費者信任', '對接具產銷履歷的產地供應商，商品故事與品質都更有說服力。', '+28%', '4.9★'],
];

function assertHomeMetricsAndWorkflow(fragment, data) {
  // 數字目標仍在元件原始碼(不是文案);標籤與六步流程的文字已搬進字典
  // 業主 2026-09-28 提供的實際數據(不再標「示意」)
  for (const metric of ["target: 800, suffix: '+'", "target: 20000, suffix: '+'", "target: 6500, suffix: '+'", "target: 50000, suffix: '+'"]) {
    assert.ok(fragment.includes(metric), `missing metric ${metric}`);
  }
  assert.deepEqual(data.stats, ['合作供應商', '累積媒合需求', '服務餐飲及食品業者', '食材與食品品項']);
  assert.deepEqual(data.statsUnits, ['家', '筆', '家', '項']);
  assert.equal(data.statsNationwide, undefined, 'statsNationwide 已經沒有人用,不要留孤兒 key');
  assert.ok(!data.stats.some((l) => /示意/.test(l)), '數字已是實際數據,標籤不該再標示意');
  assert.deepEqual(
    data.flow.map((step) => step.title),
    ['填需求', '系統媒合', '收到報價', '比較洽談', '下單進貨', '雙邊評價'],
  );
}

function assertApprovedCases(fragment) {
  for (const approvedCase of approvedCases) {
    for (const text of approvedCase) assert.match(fragment, new RegExp(text.replace('+', '\\+')));
  }
}

function restaurantCapabilitySection(fragment) {
  const start = fragment.indexOf('<section id="restaurant-capabilities"');
  const end = fragment.indexOf('restaurant-cases-title', start);
  assert.ok(start !== -1 && end > start, '找不到餐廳能力區');
  return fragment.slice(start, end);
}

function assertRestaurantCapabilityArt(fragment) {
  const arts = [...fragment.matchAll(/src="(\/assets\/rest-cap-[a-z-]+\.svg)"/g)].map((m) => m[1]);
  assert.equal(arts.length, 4, `能力卡應該有 4 張插圖,目前 ${arts.length} 張`);
  assert.equal(new Set(arts).size, 4, `四張插圖不可以重複:${arts.join(', ')}`);
}

function assertRestaurantCapabilities(fragment) {
  for (const capability of ['AI 菜單分析', '成本與採購', '訂單與收貨', '團隊管理']) {
    assert.match(fragment, new RegExp(`<h2[^>]*>${capability}<\\/h2>`));
  }
}

function assertRestaurantCapabilityOrder(fragment) {
  const capabilityStart = fragment.indexOf('<section id="restaurant-capabilities"');
  const capabilityEnd = fragment.indexOf('<section aria-labelledby="restaurant-cases-title"', capabilityStart);
  const capabilityFragment = fragment.slice(capabilityStart, capabilityEnd);
  const headings = [...capabilityFragment.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)]
    .map((match) => match[1]);
  assert.deepEqual(headings, ['AI 菜單分析', '成本與採購', '訂單與收貨', '團隊管理']);
}

function assertRestaurantRegistrationCta(fragment) {
  assert.match(
    fragment,
    /<a[^>]+href="\{\{\s*restaurantRegistrationUrl\s*\}\}"[^>]*>建立餐廳帳號<\/a>/,
  );
}

function assertReducedMotionSkipLink(fragment) {
  assert.match(fragment, /\.skip-link\s*\{[^}]*transition:\s*none[^}]*\}/s);
}

function assertReducedMotionRevealVisibility(fragment) {
  assert.match(
    fragment,
    /\[data-reveal\]\s*\{[^}]*opacity:\s*1\s*!important[^}]*\}/s,
  );
}

function assertRestaurantOverflowRegions(fragment) {
  const labels = [
    '菜單分析示意表，可左右捲動',
    '成本比較示意表，可左右捲動',
    '團隊權限示意表，可左右捲動',
  ];
  assert.equal((fragment.match(/class="restaurant-mock-scroll"/g) || []).length, labels.length);
  assert.equal((fragment.match(/class="restaurant-mock-scroll"[^>]*tabindex="0"/g) || []).length, labels.length);
  assert.equal((fragment.match(/class="restaurant-mock-scroll"[^>]*role="region"/g) || []).length, labels.length);
  for (const label of labels) {
    assert.match(
      fragment,
      new RegExp(`<div class="restaurant-mock-scroll"[^>]*aria-label="${label}"[^>]*>`),
    );
  }
}

// 只取能力區那一段 —— 流程區也用同一組 .ifm-eyebrow__no / bt-* class,
// 整頁一起數會把兩區加在一起(我第一次就是這樣錯的:算出 8 個編號籤)。
function supplierCapabilitySection(fragment) {
  const start = fragment.indexOf('<section id="supplier-capabilities"');
  const end = fragment.indexOf('supplier-outcomes-title', start);
  assert.ok(start !== -1 && end > start, '找不到供應商能力區');
  return fragment.slice(start, end);
}

function assertSupplierCapabilities(fragment) {
  for (const capability of ['商機雷達', '報價與接單', '定價與預測', '客戶經營']) {
    assert.match(fragment, new RegExp(`<h2[^>]*>${capability}<\\/h2>`));
  }
}

function assertSupplierCapabilityOrder(fragment) {
  const capabilityStart = fragment.indexOf('<section id="supplier-capabilities"');
  const capabilityEnd = fragment.indexOf('<section aria-labelledby="supplier-outcomes-title"', capabilityStart);
  const capabilityFragment = fragment.slice(capabilityStart, capabilityEnd);
  const headings = [...capabilityFragment.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)]
    .map((match) => match[1]);
  assert.deepEqual(headings, ['商機雷達', '報價與接單', '定價與預測', '客戶經營']);
}

// bento 改版後:每張能力卡都要有自己的插圖,而且四張不能重複用同一張。
// 這是「整頁一張圖都沒有」那個問題的擋線。
function assertSupplierCapabilityArt(fragment) {
  const arts = [...fragment.matchAll(/src="(\/assets\/sup-cap-\d\.svg)"/g)].map((m) => m[1]);
  assert.equal(arts.length, 4, `能力卡應該有 4 張插圖,目前 ${arts.length} 張`);
  assert.equal(new Set(arts).size, 4, `四張插圖不可以重複:${arts.join(', ')}`);
  // 裝飾性插圖一律空 alt(標題已經說明了內容,重複唸一次只是噪音)
  for (const art of arts) {
    assert.match(fragment, new RegExp(`alt=""[^>]*src="${art.replace(/\//g, '\\/')}"|src="${art.replace(/\//g, '\\/')}"[^>]*alt=""`));
  }
}

function assertSupplierApplicationCtas(fragment) {
  const ctas = fragment.match(
    /<a[^>]+href="\{\{\s*supplierApplicationUrl\s*\}\}"[^>]*>申請供應商上架<\/a>/g,
  ) || [];
  assert.equal(ctas.length, 2);
}

function assertSupplierOverflowRegions(fragment) {
  const labels = [
    '商機與品項缺口示意表，可左右捲動',
    '報價與訂單狀態示意表，可左右捲動',
    '定價與需求預測示意表，可左右捲動',
    '客戶與評價示意表，可左右捲動',
  ];
  assert.equal((fragment.match(/class="supplier-mock-scroll"/g) || []).length, labels.length);
  assert.equal((fragment.match(/class="supplier-mock-scroll"[^>]*tabindex="0"/g) || []).length, labels.length);
  assert.equal((fragment.match(/class="supplier-mock-scroll"[^>]*role="region"/g) || []).length, labels.length);
  for (const label of labels) {
    assert.match(
      fragment,
      new RegExp(`<div class="supplier-mock-scroll"[^>]*aria-label="${label}"[^>]*>`),
    );
  }
}

function assertMobileLogin(fragment) {
  // 登入平台不再放 header,改在 footer;手機選單則帶主要 CTA
  assert.match(fragment, /href="\{\{\s*loginUrl\s*\}\}"[^>]*>登入平台<\/a>/);
}

function assertAiDialogLifecycle(fragment) {
  assert.match(fragment, /panel\.id = 'ai-assistant-dialog'/);
  assert.equal((fragment.match(/panel\.setAttribute\('aria-hidden', 'true'\)/g) || []).length, 2);
  assert.equal((fragment.match(/panel\.inert = true/g) || []).length, 2);
  assert.match(fragment, /panel\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(fragment, /panel\.inert = true/);
  assert.match(fragment, /fab\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(fragment, /function openPanel\(\)[\s\S]*?panel\.removeAttribute\('aria-hidden'\)[\s\S]*?panel\.inert = false[\s\S]*?fab\.setAttribute\('aria-expanded', 'true'\)/);
  assert.match(fragment, /function closePanel\(\)[\s\S]*?panel\.setAttribute\('aria-hidden', 'true'\)[\s\S]*?panel\.inert = true[\s\S]*?fab\.setAttribute\('aria-expanded', 'false'\)[\s\S]*?fab\.focus\(\)/);
  assert.match(fragment, /if \(e\.key === 'Escape'\)[\s\S]*?closePanel\(\)/);
  assert.match(fragment, /if \(e\.key !== 'Tab'\) return;/);
  assert.match(fragment, /last\.focus\(\)/);
  assert.match(fragment, /first\.focus\(\)/);
  assert.match(fragment, /var appRoot = document\.getElementById\('dc-root'\)/);
  assert.match(fragment, /appRoot\.inert = true/);
  assert.match(fragment, /appRoot\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(fragment, /backdrop\.classList\.add\('ai-show'\)/);
  assert.match(fragment, /appRoot\.inert = appRootWasInert/);
  assert.match(fragment, /appRoot\.removeAttribute\('aria-hidden'\)/);
  assert.match(fragment, /backdrop\.classList\.remove\('ai-show'\)/);
}

function assertAiAnnouncements(fragment) {
  // AI 助手的文案已經改由 txt() 依語系填,所以這裡只釘結構與宣告順序,不釘字串內容
  assert.match(fragment, /<label for="ai-assistant-input" class="ai-sr-only">/);
  assert.match(fragment, /<input id="ai-assistant-input"[^>]+class="ai-text"/);
  assert.match(fragment, /body\.setAttribute\('role', 'log'\)/);
  assert.match(fragment, /body\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(fragment, /body\.setAttribute\('aria-relevant', 'additions'\)/);
  assert.match(fragment, /body\.setAttribute\('aria-atomic', 'false'\)/);
  // 開場白要在 live region 宣告之前就進 DOM,否則一開頁就被念一次
  const greeting = fragment.indexOf("addMsg('bot'");
  const liveRegion = fragment.indexOf("body.setAttribute('aria-live', 'polite')");
  assert.ok(greeting >= 0 && liveRegion > greeting);
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const componentStart = source.indexOf('<script type="text/x-dc" data-dc-script>');
const componentEnd = source.indexOf('</script>', componentStart);
const component = source.slice(componentStart, componentEnd);

// 圖片路徑、編號、日期這些「不是文字」的東西留在元件裡,靠陣列 index 跟字典對齊。
// 兩邊長度一旦不同,首頁就會少一格或多一格空白卡片 —— tests/i18n.test.cjs 會逐一擋。
function constArray(name) {
  const match = component.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `missing const ${name} in component script`);
  return Array.from(match[1].matchAll(/'([^']*)'/g), (m) => m[1]);
}
const categoryImgs = () => constArray('CATEGORY_IMGS');
const mobileMenuStart = header.indexOf('<sc-if value="{{ menuOpen }}">');
const mobileMenu = header.slice(mobileMenuStart, header.indexOf('</sc-if>', mobileMenuStart));

test('homepage presents the design-approved hero: rotating headline, subtitle, search and promises', () => {
  assert.ok(homeStart >= 0 && homeEnd > homeStart);
  assert.match(home, /B2B MATCHING ENGINE/);
  // 輪播的是整句,不是共用前綴 + 一個詞 —— 三句裡有一句不是「免費找到…」開頭
  assert.match(home, /\{\{ rotating\.pre \}\}<span[^>]*>\{\{ rotating\.hl \}\}<\/span>\{\{ rotating\.post \}\}/);
  assert.deepEqual(
    homeData.rotating.map((r) => r.pre + r.hl + r.post),
    ['免費找到所有食材', '免費找到合適的供應商', '多家供應商主動聯繫報價'],
  );
  // 綠色強調的那一段不可以是空的,否則整句都是深色、失去設計上的重點
  for (const r of homeData.rotating) assert.ok(r.hl, `rotating 缺少強調段:${JSON.stringify(r)}`);
  assert.match(home, /餐廳、團膳、學校、團購主都適用。<br>填一次需求，供應商主動來找你。/);
  assert.match(home, /placeholder="搜尋食材，例如：有機葉菜、火鍋肉片"/);
  assert.deepEqual(homeData.heroPromises, ['完全免費', '成交不抽成', '平均 4 小時有回覆']);
  assert.deepEqual(homeData.hotTags, ['蔬菜', '水果', '豬肉', '牛肉', '火鍋料', '雜貨']);
  assert.match(component, /hotTags: list\('hotTags'\)\.map\(/);
  // 搜尋列與分類籤都要接進 AI 助手,不能是死的裝飾
  assert.match(home, /<form onSubmit="\{\{\s*askAI\s*\}\}" role="search"/);
  assert.match(home, /<button type="button" onClick="\{\{\s*t\.ask\s*\}\}"/);
  assert.match(source, /window\.IfmAI = \{/);
  assert.match(component, /handToAI\(keyword\) \{/);
  assert.match(header, /<a[^>]+href="\{\{\s*hrefContact\s*\}\}"[^>]*>填寫食材需求<\/a>/);
});

test('homepage hero draws the world map with d3 centred on Taiwan', () => {
  assert.match(source, /<script src="https:\/\/unpkg\.com\/d3@7\.9\.0\/dist\/d3\.min\.js"[^>]*integrity="sha384-[^"]+"/);
  assert.match(source, /<script src="https:\/\/unpkg\.com\/topojson-client@3\.1\.0\/dist\/topojson-client\.min\.js"[^>]*integrity="sha384-[^"]+"/);
  assert.match(home, /<div ref="\{\{\s*mapRef\s*\}\}" aria-hidden="true"/);
  assert.match(component, /world-atlas@2\.0\.2\/countries-110m\.json/);
  assert.match(component, /geoNaturalEarth1\(\)\.rotate\(\[-121, 0\]\)/);
  assert.match(component, /catch \(e\) \{/); // 地圖載不到不能讓頁面掛掉
});

test('public copy removes free registration and listing claims but keeps free matching', () => {
  assert.doesNotMatch(
    source,
    /餐廳免費註冊|免費建立餐廳帳號|供應商免費上架|免費申請供應商上架|免費上架申請|不收上架費|零成本/,
  );
  assert.match(source, /免費媒合|免費找到/);
});

test('product links derive from one canonical product base URL', () => {
  // 產品站正式網域(2026-09-29 起);舊的 dish-to-supply.vercel.app 由產品站的 vercel.json 308 過去,這裡不該再出現。
  assert.equal((source.match(/https:\/\/app\.ifoodmap\.ai/g) || []).length, 1);
  assert.match(source, /IFM_PRODUCT_BASE_URL\s*=\s*'https:\/\/app\.ifoodmap\.ai'/);
  assert.doesNotMatch(source, /dish-to-supply\.vercel\.app/);
  assert.match(source, /const productBaseUrl = window\.IFM_PRODUCT_BASE_URL;/);
  assert.match(source, /restaurantRegistrationUrl:\s*productBaseUrl \+ '\/register\/restaurant'/);
  assert.match(source, /supplierApplicationUrl:\s*productBaseUrl \+ '\/join'/);
  assert.match(source, /loginUrl:\s*productBaseUrl \+ '\/'/);
  assert.match(home, /<a[^>]+href="\{\{\s*restaurantRegistrationUrl\s*\}\}"[^>]*>免費註冊會員<\/a>/);
  assertMobileLogin(footer);
});

test('homepage retains design metrics and explains the six-step workflow', () => {
  assertHomeMetricsAndWorkflow(component, homeData);
  assert.match(home, /<sc-for list="\{\{\s*flowA\s*\}\}"/);
  assert.match(home, /<sc-for list="\{\{\s*flowB\s*\}\}"/);
  assert.match(home, /從需求到進貨，<span[^>]*>一條龍<\/span>/);
});

test('homepage names four audiences, twelve categories and three trust features from the design', () => {
  assert.deepEqual(
    homeData.audiences.map((audience) => audience.title),
    ['餐廳・餐酒館', '團膳・學校', '團購主・電商', '加工廠・通路'],
  );
  assert.deepEqual(
    homeData.categories,
    ['蔬菜', '水果', '海鮮', '肉品', '蛋品', '五穀雜糧', '南北雜貨', '加工食品', '火鍋料', '調味品', '酒與飲品', '包材耗材'],
  );
  // 分類文字住字典、圖片住元件,靠 index 對齊 —— 兩邊都要在,而且圖是 root-absolute
  assert.equal(categoryImgs().length, homeData.categories.length);
  for (const img of categoryImgs()) assert.match(img, /^\/assets\/cat-[a-z]+\.svg$/);
  assert.deepEqual(
    homeData.trust.map((feature) => feature.title),
    ['雙邊評價機制', '標章與檢驗連動', 'LINE 即時通知'],
  );
  assert.match(home, /任何有食材需求的人，<br>都適用/);
});

test('homepage illustrations are real files and no design placeholder text leaks through', () => {
  // 文章區的圖改吃真的文章封面了(news.js),不再是寫死的 ARTICLE_IMGS
  const referenced = new Set([
    ...constArray('FLOW_IMGS'),
    ...constArray('CATEGORY_IMGS'),
  ]);
  assert.ok(referenced.size >= 18, `expected 18 illustrations, found ${referenced.size}`);
  for (const absolute of referenced) {
    // root-absolute 才行:/en/xxx 底下 base 會變成 /en/,相對路徑會 404
    assert.match(absolute, /^\/assets\//, `illustration must be root-absolute: ${absolute}`);
    const rel = absolute.slice(1);
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', rel)), `missing illustration ${rel}`);
  }
  for (const placeholder of ['插圖：', '文章封面', '[ 餐廳採購情境照 ]', '[ 供應商出貨情境照 ]', '截圖']) {
    assert.ok(!home.includes(placeholder), `placeholder leaked: ${placeholder}`);
  }
  // 圖片都是裝飾,交給旁邊的文字說明
  assert.equal((home.match(/<img /g) || []).length, (home.match(/<img [^>]*alt=""/g) || []).length);
});

test('homepage shows three testimonials and three articles, then the closing CTA', () => {
  assert.deepEqual(homeData.testimonials.map((t) => t.who), ['林老闆', '陳主任', '王小姐']);
  // 首頁文章區改吃 news.js 的最新三篇,不再是字典裡三筆寫死的假文章
  const newsModule = require('../news.js');
  const latest = newsModule.latest('zh', 3);
  assert.equal(latest.length, 3, '首頁要顯示三篇文章');
  assert.deepEqual(latest.map((a) => a.title), newsModule.all('zh').slice(0, 3).map((a) => a.title));
  assert.match(home, /<sc-for list="\{\{ articlesTop \}\}" as="a"/);
  // 卡片整張可點進文章頁
  assert.match(home, /href="\{\{ a\.href \}\}"[^>]*onClick="\{\{ a\.go \}\}"/);
  const news = home.indexOf('id="news"');
  const closing = home.indexOf('免費找到所有食材，<br>從填一張需求單開始');
  assert.ok(news >= 0 && closing > news);
  assert.match(home, /<section[^>]+id="how-it-works"[^>]*scroll-margin-top/);
  assert.match(home, /<section[^>]+id="news"[^>]*scroll-margin-top/);
});

test('mobile menu mirrors desktop destinations and the legacy drawer is no longer mounted', () => {
  // 內部連結的 href 現在一律是 {{ href* }} 綁定(才會帶語系前綴),所以比對「綁定名 + 文字」
  const linkPattern = /<a href="\{\{ (\w+) \}\}"[^>]*>(?:\s*<img[^>]*>)?\s*([^<\s][^<]*?)\s*<\/a>/g;
  const desktopLinks = Array.from(header.slice(0, mobileMenuStart).matchAll(linkPattern))
    .filter((m) => m[2] !== '食材地圖');
  const mobileLinks = Array.from(mobileMenu.matchAll(linkPattern));
  // 「平台功能」2026-09-23 從 menu 拿掉(頁尾那條保留),所以 nav 從 7 條變 6 條
  assert.equal(desktopLinks.length, 8); // 6 nav + 語言切換 + CTA
  assert.equal(mobileLinks.length, 8);
  assert.deepEqual(desktopLinks.map((m) => m[1] + m[2]), mobileLinks.map((m) => m[1] + m[2]));
  assert.match(header, /aria-expanded="\{\{\s*menuOpen\s*\}\}"/);
  assert.match(header, /aria-controls="ifm-mobile-menu"/);
  // 舊的注入式漢堡選單保留程式碼但不再掛到 body
  assert.doesNotMatch(drawer, /document\.body\.appendChild\(btn\);/);
  assert.doesNotMatch(drawer, /document\.body\.appendChild\(menu\);/);
});

test('content guards fail when home metrics or home workflow are removed', () => {
  assert.throws(() => assertHomeMetricsAndWorkflow(component.replace("target: 20000, suffix: '+'", ''), homeData));
  // 標籤被改回「示意」、或單位被拿掉,守門也要叫
  assert.throws(() => assertHomeMetricsAndWorkflow(component, { ...homeData, stats: homeData.stats.map((l, i) => (i ? l : l + '（示意）')) }));
  assert.throws(() => assertHomeMetricsAndWorkflow(component, { ...homeData, statsUnits: undefined }));
  const renamedStep = {
    ...homeData,
    flow: homeData.flow.map((step) => (step.title === '系統媒合' ? { ...step, title: '媒合' } : step)),
  };
  assert.throws(() => assertHomeMetricsAndWorkflow(component, renamedStep));
  assert.throws(() => assertMobileLogin(footer.replace(/href="\{\{\s*loginUrl\s*\}\}"/, 'href="/"')));
});

test('small homepage labels meet WCAG AA contrast on the design palette', () => {
  // 設計稿用到的小字配色,全部量一次
  for (const [fg, bg] of [
    ['#5E6E65', '#FFFFFF'], // hero 標籤、卡片小字
    ['#4B5A52', '#FFFFFF'], // 內文
    ['#4B5A52', '#F7F9F8'], // 內文 on 灰底
    ['#0B6B40', '#F7F9F8'], // kicker
    ['#4E7460', '#EFF6F2'], // 流程卡文字
    ['#8A6118', '#FBF3E5'], // 流程卡文字(琥珀)
  ]) {
    assert.ok(contrastRatio(fg, bg) >= 4.5, `${fg} on ${bg} = ${contrastRatio(fg, bg).toFixed(2)}`);
  }
  // 品牌綠 #128A54 在白底只有 ~4.3,不能當 13px 以下的文字色;只允許用在 aria-hidden 的裝飾符號(例如箭頭)
  const smallBrandGreen = Array.from(home.matchAll(/<[a-z]+[^>]*style="(?=[^"]*font-size:1[0-3](?:\.5)?px)(?=[^"]*color:#128A54)[^"]*"[^>]*>/g)).map((m) => m[0]);
  for (const tag of smallBrandGreen) assert.match(tag, /aria-hidden="true"/, `small brand-green text must be decorative: ${tag}`);
});

test('homepage CTAs expose stable focus, touch, responsive and reduced-motion rules', () => {
  assert.match(source, /\.platform-action:focus-visible/);
  assert.match(source, /min-height:\s*44px/);
  assert.match(source, /@media\s*\(max-width:\s*768px\)/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(header, /min-height:48px/); // 手機選單項目的觸控高度
});

test('restaurant solution page follows the approved story and section order', () => {
  assert.ok(restaurantsStart >= 0 && restaurantsEnd > restaurantsStart);
  assert.match(restaurants, />iFoodmap for Restaurants</);
  assert.match(restaurants, /<h1[^>]*>[^<]*從菜單分析到完成收貨[^<]*<\/h1>/);
  assertRestaurantRegistrationCta(restaurants);

  const hero = restaurants.indexOf('從菜單分析到完成收貨');
  const pains = restaurants.indexOf('餐廳採購，不該靠人脈與零散訊息');
  const workflow = restaurants.indexOf('從菜單與需求，一路走到收貨');
  const capabilities = restaurants.indexOf('id="restaurant-capabilities"');
  const cases = restaurants.indexOf('餐廳採購的實際成果');
  const finalCta = restaurants.lastIndexOf('建立餐廳帳號');
  assert.ok(hero >= 0 && pains > hero);
  assert.ok(workflow > pains && capabilities > workflow);
  assert.ok(cases > capabilities && finalCta > cases);
});

test('restaurant page names four accurate pains and a menu-to-receiving workflow', () => {
  for (const pain of [
    '仰賴人工與同行詢問',
    '規格與價格資訊不完整',
    '比價耗費大量時間',
    '訂單與收貨難追蹤',
  ]) {
    assert.match(restaurants, new RegExp(pain));
  }
  for (const step of ['整理菜單與需求', '確認食材與規格', '比較供應商與價格', '建立訂單並確認收貨']) {
    assert.match(restaurants, new RegExp(step));
  }
});

test('restaurant capabilities are four illustrated bento cards, not walls of fake table data', () => {
  assertRestaurantCapabilities(restaurants);
  assertRestaurantCapabilityOrder(restaurants);
  const caps = restaurantCapabilitySection(restaurants);
  assertRestaurantCapabilityArt(caps);

  // 假表格(示例資料)2026-09-23 移除 —— 全頁文字量最大的一塊,而且資料是假的
  assert.doesNotMatch(restaurants, /產品功能示意畫面/);
  assert.doesNotMatch(restaurants, /restaurant-mock-table|restaurant-mock-scroll/);

  assert.equal((caps.match(/class="ifm-eyebrow__no"/g) || []).length, 4);
  assert.equal((caps.match(/<ul class="ifm-chips">\s*(?:<li>[^<]*<\/li>\s*){3}<\/ul>/g) || []).length, 4);

  for (const id of [
    'restaurant-analyze-title',
    'restaurant-cost-title',
    'restaurant-orders-title',
    'restaurant-team-title',
  ]) {
    assert.match(restaurants, new RegExp(`<article[^>]+aria-labelledby="${id}"`));
  }
});

test('restaurant capability cards are laid out irregularly, not as a four-up equal grid', () => {
  const caps = restaurantCapabilitySection(restaurants);
  assert.match(caps, /<div class="ifm-bento"/);
  const spans = new Set((caps.match(/\bbt-(\d+)\b/g) || []));
  assert.ok(spans.size >= 2, `能力卡只有一種寬度(${[...spans].join(', ')}),沒有不規則感`);
  assert.ok(/bt-rise|bt-drop/.test(caps), '能力卡沒有任何垂直位移');
});


test('restaurant capability guards fail when cards are swapped or lose their art', () => {
  const capStart = restaurants.indexOf('<section id="restaurant-capabilities"');
  const marker = '<article class="ifm-card bt-';
  const first = restaurants.indexOf(marker, capStart);
  const second = restaurants.indexOf(marker, first + 1);
  const third = restaurants.indexOf(marker, second + 1);
  const a = restaurants.slice(first, second);
  const b = restaurants.slice(second, third);
  assert.throws(() => assertRestaurantCapabilityOrder(restaurants.slice(0, first) + b + a + restaurants.slice(third)));
  const duplicated = restaurantCapabilitySection(restaurants).replace(/rest-cap-(cost|orders|team)\.svg/g, 'rest-cap-menu-ai.svg');
  assert.throws(() => assertRestaurantCapabilityArt(duplicated));
});


test('restaurant page retains the approved restaurant outcomes and qualifier', () => {
  for (const approvedCase of approvedCases.slice(0, 2)) {
    for (const text of approvedCase) assert.match(restaurants, new RegExp(text.replace('+', '\\+')));
  }
  assert.doesNotMatch(restaurants, new RegExp(approvedCases[2][0]));
  assert.match(restaurants, /成果依業態、採購規模與執行期間而異。/);
});

test('restaurant fragment excludes legacy placeholders and unsupported marketing', () => {
  assert.doesNotMatch(restaurants, /\{\{\s*servicesFull\s*\}\}/);
  assert.doesNotMatch(restaurants, /repeating-linear-gradient/);
  assert.doesNotMatch(restaurants, /\[[^\]]*(?:介面|示意|實拍)[^\]]*\]/);
  assert.doesNotMatch(restaurants, /Our services|ERP|LINE@|LINE 即時|自動補貨|量身打造/);
});

test('restaurant content guards fail if capabilities or registration CTA are removed', () => {
  const withoutCapabilities = restaurants.replace(
    /<section[^>]+id="restaurant-capabilities"[\s\S]*?<\/section>/,
    '',
  );
  const withoutRegistrationCta = restaurants.replace(
    /<a[^>]+href="\{\{\s*restaurantRegistrationUrl\s*\}\}"[^>]*>建立餐廳帳號<\/a>/g,
    '',
  );
  assert.throws(() => assertRestaurantCapabilities(withoutCapabilities));
  assert.throws(() => assertRestaurantRegistrationCta(withoutRegistrationCta));
});

test('restaurant in-page capability target clears the sticky header', () => {
  assert.match(restaurants, /href="#restaurant-capabilities"/);
  assert.match(source, /#restaurant-capabilities\s*\{[^}]*scroll-margin-top:\s*96px/s);
});

test('every route shares one keyboard skip target and one main landmark', () => {
  assert.equal((source.match(/<main\b/g) || []).length, 1);
  assert.equal((source.match(/<\/main>/g) || []).length, 1);
  assert.match(
    source,
    /<a class="skip-link" href="#main-content">跳到主要內容<\/a>[\s\S]*?<!-- ============ HEADER ============ -->/,
  );
  assert.match(source, /<main id="main-content" tabindex="-1">/);
  assert.match(source, /#main-content\s*\{[^}]*scroll-margin-top:\s*96px/s);
  assert.match(source, /\.skip-link:focus-visible\s*\{/);

  const mainStart = source.indexOf('<main id="main-content" tabindex="-1">');
  const mainEnd = source.indexOf('</main>', mainStart);
  for (const marker of [
    'PAGE: HOME',
    'PAGE: RESTAURANTS',
    'PAGE: SUPPLIERS',
    'PAGE: CASES',
    'PAGE: ABOUT',
    'PAGE: CONTACT',
  ]) {
    const markerPosition = source.indexOf(marker);
    assert.ok(markerPosition > mainStart && markerPosition < mainEnd);
  }
});

test('skip link disables its transition for reduced-motion users', () => {
  const reducedMotionStart = source.indexOf('@media (prefers-reduced-motion:reduce)');
  const reducedMotionEnd = source.indexOf('</style>', reducedMotionStart);
  const reducedMotion = source.slice(reducedMotionStart, reducedMotionEnd);
  assertReducedMotionSkipLink(reducedMotion);

  const withoutSkipRule = reducedMotion.replace(
    /\.skip-link\s*\{[^}]*transition:\s*none[^}]*\}/s,
    '',
  );
  assert.throws(() => assertReducedMotionSkipLink(withoutSkipRule));
});

test('reduced-motion users keep reveal content visible without animation', () => {
  const reducedMotionStart = source.indexOf('@media (prefers-reduced-motion:reduce)');
  const reducedMotionEnd = source.indexOf('</style>', reducedMotionStart);
  const reducedMotion = source.slice(reducedMotionStart, reducedMotionEnd);
  assertReducedMotionRevealVisibility(reducedMotion);

  const withoutVisibleReveal = reducedMotion.replace(
    /opacity:\s*1\s*!important/,
    '',
  );
  assert.throws(() => assertReducedMotionRevealVisibility(withoutVisibleReveal));
});

test('restaurant in-page capability anchor still clears the sticky header', () => {
  assert.match(source, /#restaurant-capabilities\s*\{[^}]*scroll-margin-top:\s*96px/s);
  assert.match(restaurants, /id="restaurant-capabilities"/);
  assert.match(restaurants, /href="#restaurant-capabilities"/);
  // 假表格拿掉之後沒有需要鍵盤捲動的溢出區了,tabindex/role=region 也該一起消失
  assert.doesNotMatch(restaurants, /restaurant-mock-scroll/);
});


test('supplier solution page follows the approved story and uses two canonical join actions', () => {
  assert.ok(suppliersStart >= 0 && suppliersEnd > suppliersStart);
  assert.equal((suppliers.match(/<h1\b/g) || []).length, 1);
  assert.match(suppliers, />iFoodmap for Suppliers</);
  assert.match(suppliers, /<h1[^>]*>從商品上架到商機、報價與出貨<\/h1>/);
  assertSupplierApplicationCtas(suppliers);
  assert.match(suppliers, /href="#supplier-capabilities"/);

  const hero = suppliers.indexOf('從商品上架到商機、報價與出貨');
  const pains = suppliers.indexOf('好商品，不該埋沒在零散詢價裡');
  const workflow = suppliers.indexOf('從被看見，到報價、接單與持續經營');
  const capabilities = suppliers.indexOf('id="supplier-capabilities"');
  const outcomes = suppliers.indexOf('供應商經營的成果參考');
  const finalCta = suppliers.lastIndexOf('申請供應商上架');
  assert.ok(hero >= 0 && pains > hero);
  assert.ok(workflow > pains && capabilities > workflow);
  assert.ok(outcomes > capabilities && finalCta > outcomes);
});

test('supplier page names four pains and an accurate lead-to-relationship workflow', () => {
  for (const pain of [
    '需求分散，難以及時發現',
    '報價與交期反覆確認',
    '定價缺少市場依據',
    '客戶回購狀況難掌握',
  ]) {
    assert.match(suppliers, new RegExp(pain));
  }
  for (const step of ['建立商品目錄', '接收匹配商機', '回覆報價並確認訂單', '出貨並累積客戶關係']) {
    assert.match(suppliers, new RegExp(step));
  }
});

test('supplier capabilities are four illustrated bento cards, not walls of fake table data', () => {
  assertSupplierCapabilities(suppliers);
  assertSupplierCapabilityOrder(suppliers);
  assertSupplierCapabilityArt(supplierCapabilitySection(suppliers));

  // 假表格(示例資料)2026-09-23 移除 —— 那是整頁文字量最大的一塊,
  // 而且資料是假的,讀者看了也不會更懂功能。
  assert.doesNotMatch(suppliers, /產品功能示意畫面/);
  assert.doesNotMatch(suppliers, /supplier-mock-table|supplier-mock-scroll/);

  // 每張卡:插圖 + 編號 eyebrow + 標題 + 一句說明 + 三個短標籤
  const caps = supplierCapabilitySection(suppliers);
  assert.equal((caps.match(/class="ifm-eyebrow__no"/g) || []).length, 4);
  assert.equal((caps.match(/<ul class="ifm-chips">/g) || []).length, 4);
  assert.equal((caps.match(/<ul class="ifm-chips">\s*(?:<li>[^<]*<\/li>\s*){3}<\/ul>/g) || []).length, 4);

  for (const id of [
    'supplier-leads-title',
    'supplier-quotes-title',
    'supplier-pricing-title',
    'supplier-customers-title',
  ]) {
    assert.match(suppliers, new RegExp(`<article[^>]+aria-labelledby="${id}"`));
  }
});

test('supplier capability cards are laid out irregularly, not as a four-up equal grid', () => {
  const capStart = suppliers.indexOf('<section id="supplier-capabilities"');
  const capEnd = suppliers.indexOf('supplier-outcomes-title', capStart);
  const caps = suppliers.slice(capStart, capEnd);
  assert.match(caps, /<div class="ifm-bento"/);
  // 至少兩種不同寬度,而且至少一張有垂直位移 —— 不然就退化成規律四欄了
  const spans = new Set((caps.match(/\bbt-(\d+)\b/g) || []));
  assert.ok(spans.size >= 2, `能力卡只有一種寬度(${[...spans].join(', ')}),沒有不規則感`);
  assert.ok(/bt-rise|bt-drop/.test(caps), '能力卡沒有任何垂直位移');
});


test('supplier capability guards fail when cards are swapped or lose their art', () => {
  const capStart = suppliers.indexOf('<section id="supplier-capabilities"');
  const marker = '<article class="ifm-card bt-';
  const first = suppliers.indexOf(marker, capStart);
  const second = suppliers.indexOf(marker, first + 1);
  const third = suppliers.indexOf(marker, second + 1);
  const a = suppliers.slice(first, second);
  const b = suppliers.slice(second, third);
  const swapped = suppliers.slice(0, first) + b + a + suppliers.slice(third);
  assert.throws(() => assertSupplierCapabilityOrder(swapped));

  // 四張卡共用同一張圖也要被抓到
  const duplicated = supplierCapabilitySection(suppliers).replace(/sup-cap-[234]\.svg/g, 'sup-cap-1.svg');
  assert.throws(() => assertSupplierCapabilityArt(duplicated));
});


test('supplier outcomes distinguish public metrics from examples and include a qualifier', () => {
  for (const metric of ['2,500+', '28 類', '24hr']) {
    assert.match(suppliers, new RegExp(metric.replace('+', '\\+')));
  }
  assert.match(suppliers, /平台現有公開數據/);
  assert.match(suppliers, /示例資料，非特定客戶實績/);
  assert.match(suppliers, /成果依品項、服務區域、供應能力與執行期間而異。/);
});

test('supplier fragment excludes placeholders and unsupported automation claims', () => {
  assert.doesNotMatch(suppliers, /頁面準備中|repeating-linear-gradient/);
  assert.doesNotMatch(suppliers, /\[[^\]]*(?:介面|示意|實拍)[^\]]*\]/);
  assert.doesNotMatch(suppliers, /ERP|LINE@|自動接單|自動報價|自動出貨|保證成交|即時預測/);
});

test('supplier content guards fail if capabilities or either join action are removed', () => {
  const withoutCapabilities = suppliers.replace(
    /<section[^>]+id="supplier-capabilities"[\s\S]*?<\/section>/,
    '',
  );
  const withoutFirstCta = suppliers.replace(
    /<a[^>]+href="\{\{\s*supplierApplicationUrl\s*\}\}"[^>]*>申請供應商上架<\/a>/,
    '',
  );
  assert.throws(() => assertSupplierCapabilities(withoutCapabilities));
  assert.throws(() => assertSupplierApplicationCtas(withoutFirstCta));
});

test('supplier in-page capability anchor still clears the sticky header', () => {
  assert.match(source, /#supplier-capabilities\s*\{[^}]*scroll-margin-top:\s*96px/s);
  assert.match(suppliers, /id="supplier-capabilities"/);
  assert.match(suppliers, /href="#supplier-capabilities"/);
  // 假表格拿掉之後就沒有需要鍵盤捲動的溢出區了,對應的 tabindex/role=region 也該一起消失
  assert.doesNotMatch(suppliers, /supplier-mock-scroll/);
});


test('site shell exposes one header, labelled desktop and mobile navigation, and one footer', () => {
  assert.equal((source.match(/<header\b/g) || []).length, 1);
  assert.equal((source.match(/<\/header>/g) || []).length, 1);
  assert.equal((source.match(/<footer\b/g) || []).length, 1);
  assert.equal((source.match(/<\/footer>/g) || []).length, 1);
  assert.match(source, /<nav aria-label="主要導覽"[^>]*>/);
  assert.match(source, /document\.createElement\('nav'\)/);
  assert.match(source, /menu\.setAttribute\('aria-label', '行動版主選單'\)/);

  const headerEnd = source.indexOf('</header>');
  const mainStart = source.indexOf('<main id="main-content"');
  const mainEnd = source.indexOf('</main>', mainStart);
  const footerStart = source.indexOf('<footer');
  assert.ok(headerEnd >= 0 && mainStart > headerEnd);
  assert.ok(mainEnd > mainStart && footerStart > mainEnd);
});

test('supporting pages use one H1 each and contain no placeholder content', () => {
  for (const [name, fragment] of [['cases', cases], ['about', about], ['contact', contact]]) {
    assert.ok(fragment.length > 0, `${name} fragment exists`);
    assert.equal((fragment.match(/<h1\b/g) || []).length, 1, `${name} has one H1`);
    assert.doesNotMatch(fragment, /頁面準備中|合作夥伴 \d|媒體 \d|\[[^\]]*(?:實拍|介面|示意)[^\]]*\]/);
  }
});

test('cases page preserves approved evidence and distinguishes restaurant and supplier outcomes', () => {
  assert.match(cases, /<h1[^>]*>餐廳與供應商，如何一起改善採購成果<\/h1>/);
  assertApprovedCases(cases);
  assert.match(cases, /餐廳端成果/);
  assert.match(cases, /供應商合作成果/);
  assert.match(cases, /改善層級/);
  assert.equal((cases.match(/成果依業態、採購規模與執行期間而異。/g) || []).length, 1);
  assert.doesNotMatch(cases, /保證(?:降低|提升|成交|達成)|一定(?:降低|提升|成交)/);
});

test('about page explains the two-sided platform and retains exactly three approved values', () => {
  assert.match(about, /<h1[^>]*>讓餐廳需求與供應能力，更有效率地相遇<\/h1>/);
  assert.match(about, /雙邊 B2B 食材採購平台/);
  assert.match(about, /餐廳/);
  assert.match(about, /供應商/);
  for (const value of ['高效媒合', '公平透明', '在地永續']) {
    assert.match(about, new RegExp(`<h3[^>]*>${value}<\\/h3>`));
  }
  assert.equal((about.match(/class="about-value-card"/g) || []).length, 3);
  assert.doesNotMatch(about, /成立於|團隊成員|合作夥伴|媒體報導/);
});

test('contact page is now the partnership enquiry page, and the demand form stays dead', () => {
  // 🔴 這一組擋的是「那張被移除的食材需求單復活」,不是「這一頁不准有任何表單」。
  //    2026-09-23 之後 /contact 改成異業合作頁,它自己有一張 partnership_leads 的表單,
  //    所以原本 `assert.doesNotMatch(contact, /<form/)` 那條過寬了 —— 換成盯住需求單自己的特徵:
  //      ① 需求單專屬欄位 items_text / detail
  //      ② 需求單那張卡的 id="demand-form-title"
  //      ③ 靠 document 全域 submit 委派 + fields[0..4] 位置索引取值的那支 script
  //    異業合作表單三樣都沒有:欄位一律靠 name 取,送出綁的是框架自己的 onSubmit。
  assert.doesNotMatch(contact, /name="(?:items_text|detail)"/);
  assert.doesNotMatch(source, /id="demand-form-title"/);
  assert.doesNotMatch(source, /function findDemandCard/);
  assert.doesNotMatch(source, /document\.addEventListener\('submit'/);

  // 異業合作表單:走框架的 onSubmit 綁定
  assert.match(contact, /<form data-reveal onSubmit="\{\{ submitPartnership \}\}"/);
  assert.match(component, /submitPartnership\(event\) \{/);
  assert.match(component, /submitPartnership: \(event\) => this\.submitPartnership\(event\)/);
  // 🔴 required / novalidate 一定要寫成有值的屬性。React 對 BOOLEAN 型 prop 的規則是
  //    `return !value`,無值屬性解析出來是空字串 → falsy → 整個屬性被丟掉。
  //    只有 required 生效而 novalidate 沒生效的話,瀏覽器會在 submit 派送「之前」跑原生驗證,
  //    onSubmit 根本不會被呼叫,自訂錯誤訊息與 focus 行為全部失效。
  assert.match(contact, /novalidate="novalidate"/);
  assert.doesNotMatch(contact, /<(?:form|input|textarea|select)[^>]*\s(?:required|novalidate)[\s>]/);
  for (const name of ['company_name', 'contact_name', 'contact_email', 'partner_type', 'message']) {
    assert.match(contact, new RegExp(`name="${name}"[^>]*required="required"`), `${name} 應該是必填`);
  }
  // 合作類型的 option value 必須是英文常數 —— 隨語系變的話後台會同時收到兩種寫法
  for (const value of ['channel', 'integration', 'logistics', 'branding', 'other']) {
    assert.match(contact, new RegExp(`<option value="${value}">`));
  }
  const contactEn = (() => {
    const en = renderMarkup('en');
    return en.slice(en.indexOf('PAGE: CONTACT'), en.indexOf('PAGE: NEWS'));
  })();
  for (const value of ['channel', 'integration', 'logistics', 'branding', 'other']) {
    assert.match(contactEn, new RegExp(`<option value="${value}">`), `英文版的 ${value} value 也不能被翻譯`);
  }

  // 🔴 按鈕還原時要「重查字典」,不能還原送出前存下來的 original。
  //    那段字是在 React 外面直接改 textContent 的,切語系時框架不會重繪它,
  //    還原舊字串的話英文頁上會永遠卡著中文的「送出合作洽詢」。
  assert.match(component, /const restore = \(\) => \{ btn\.textContent = this\.partnerText\('submit'\) \|\| original; \};/);
  assert.match(component, /partnerText\(key\) \{/);
  assert.match(component, /api\.dict\(api\.current\(window\)\)/);

  // 出口卡:走錯路的人仍然被 AI 採購助手接住
  const aiCta = dict('zh').contact.aiCta;
  assert.match(contact, new RegExp(`onClick="\\{\\{ openAI \\}\\}"[^>]*>${aiCta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(contactEn, new RegExp(`onClick="\\{\\{ openAI \\}\\}"[^>]*>${dict('en').contact.aiCta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(contact, /<sc-for list="\{\{ hotTags \}\}" as="t"/);
  assert.match(contact, /onClick="\{\{ t\.ask \}\}"/);
});

test('contact details are real links, and every new-tab link is opener-safe', () => {
  // 四列聯絡資訊原本都是死的純文字。整列包成 <a>(圖示也包進去),整列才有 >=44px 的點擊區。
  assert.match(contact, /<a class="contact-line" href="tel:\+886277045539"/);
  assert.match(contact, /<a class="contact-line" href="mailto:ifoodmaptw@gmail\.com"/);
  // LINE 的 ?oat_content=url 是官方帶的來源參數,不可以清掉
  assert.match(contact, /href="https:\/\/line\.me\/R\/ti\/p\/@750yvxki\?oat_content=url"/);
  // 服務時間沒有可以連過去的地方,維持純文字
  assert.doesNotMatch(contact, /<a class="contact-line"[^>]*>\s*<span[^>]*>時</);
  // 三個 <a> 都要有可及名稱(圖示欄位是「電」/「@」/「LINE」這種字元,不覆寫會被一起唸出來)
  for (const key of ['phoneAria', 'emailAria', 'lineAria']) {
    assert.ok(dict('zh').contact[key] && dict('en').contact[key], `缺少 contact.${key}`);
  }
  assert.equal((contact.match(/<a class="contact-line"/g) || []).length, 3);
  // hover / focus 必須是真的 CSS —— style-hover 是設計稿留下來的裝飾屬性,support.js 沒有實作
  assert.match(source, /a\.contact-line:hover \{/);
  assert.match(source, /a\.contact-line:focus-visible \{/);

  // 🔴 全站規則:target="_blank" 一律要帶 rel 含 noopener(否則新分頁拿得到 window.opener)
  const blanks = source.match(/<a\b[^>]*target="_blank"[^>]*>/g) || [];
  assert.ok(blanks.length >= 2, `找不到 target="_blank" 的連結,這條檢查可能已經失效`);
  for (const tag of blanks) {
    assert.match(tag, /rel="[^"]*noopener[^"]*"/, `target="_blank" 少了 rel noopener:${tag.slice(0, 120)}`);
  }
});

test('lead capture reaches Supabase from both forms, and both write-only tables use return=minimal', () => {
  // 兩張表都只開 anon INSERT、沒有 SELECT policy;PostgREST 預設 RETURNING *,
  // 不帶 return=minimal 整筆會被 RLS 擋成 42501。
  assert.equal((source.match(/\/rest\/v1\/landing_leads/g) || []).length, 1);
  assert.equal((source.match(/\/rest\/v1\/partnership_leads/g) || []).length, 1);
  assert.equal((source.match(/'Prefer': 'return=minimal'/g) || []).length, 2);
  // 每一筆都要帶 lang,否則後台分不出這筆 lead 是哪個語系的訪客留的
  assert.match(component, /lang: i18n && typeof i18n\.current === 'function' \? i18n\.current\(window\) : 'zh'/);

  // 🔴 整類「靠畫面文字找元素」的寫法一律擋掉 —— 中英雙語之下那種 hook 會靜默失效
  const textMatchers = source.match(/textContent\.indexOf\('[^']*[一-鿿][^']*'\)/g) || [];
  assert.deepEqual(textMatchers, [], `不可用中文字面值定位元素:${textMatchers.join(', ')}`);
});

test('FAQ page ships only the two answers the owner approved and uses a native accordion', () => {
  // 業主裁決:舊站的第三題在推「月費方案」,但定價頁只賣季/半年/年/點數四種,
  // 照搬會叫供應商去買買不到的東西 —— 所以只上 Q1、Q2。原文留在素材的 raw.txt。
  for (const lang of ['zh', 'en']) {
    assert.equal(dict(lang).qa.items.length, 2, `${lang} 的常見問題應該只有 2 題`);
  }
  assert.doesNotMatch(JSON.stringify(dict('zh').qa), /月費/);
  assert.doesNotMatch(JSON.stringify(dict('en').qa), /monthly plan/i);

  // 手風琴走原生 <details>/<summary>:鍵盤、螢幕閱讀器的展開狀態、Ctrl+F 全部天生就有
  assert.match(qa, /<details class="ifm-qa__item">/);
  assert.match(qa, /<summary class="ifm-qa__q">/);
  assert.equal((qa.match(/<h1\b/g) || []).length, 1, 'QA 頁只能有一個 H1');
  // 🔴 L.qa.items 是陣列,不可以直接綁 —— 要經 renderVals() 變成 {{ qaItems }}
  const markupOnly = source.slice(source.indexOf('<x-dc>'), source.indexOf('</x-dc>'));
  assert.doesNotMatch(markupOnly, /\{\{ L\.qa\.items \}\}/);
  assert.match(qa, /<sc-for list="\{\{ qaItems \}\}" as="q"/);
  assert.match(component, /const qaItems = \(\(L\.qa && L\.qa\.items\) \|\| \[\]\)\.map/);
  // 題數是 qaItems.length 算出來的,不是寫死的數字
  assert.match(component, /qaCount: qaItems\.length,/);
  // 底部卡片把沒找到答案的人交給 AI 助手
  assert.match(qa, /onClick="\{\{ openAI \}\}"/);
});

test('the FAQ nav entries all point at /qa, and 平台功能 is gone from the menus', () => {
  // 🔴 href 與 onClick 都要改。只改 onClick 的話,右鍵開新分頁、cmd+click 與爬蟲
  //    仍然走 href 跑到聯絡頁,英文使用者還會被踢回中文站。
  const faqZh = dict('zh').nav.faq;
  const faqLinks = source.match(new RegExp(`<a href="\\{\\{ hrefQa \\}\\}"[^>]*>`, 'g')) || [];
  assert.equal(faqLinks.length, 3, '桌機導覽 + 手機抽屜 + 頁尾 SUPPORT 共三處');
  assert.match(header, new RegExp(`<a href="\\{\\{ hrefQa \\}\\}" onClick="\\{\\{ goQa \\}\\}"[^>]*>${faqZh}</a>`));
  assert.match(header, new RegExp(`<a href="\\{\\{ hrefQa \\}\\}" onClick="\\{\\{ goQaMobile \\}\\}"[^>]*>${faqZh}</a>`));
  assert.match(footer, /<a href="\{\{ hrefQa \}\}" onClick="\{\{ goQa \}\}"/);
  // hrefQa 是真的頁面路徑,不是首頁錨點
  assert.match(component, /hrefQa: href\('qa'\),/);

  // 「平台功能」從 menu 拿掉(桌機 + 手機抽屜);字典 key 與只有那顆手機選項在用的
  // goHowMobile 一起刪掉,不留死碼。
  assert.doesNotMatch(source, /\{\{ L\.nav\.features \}\}/);
  assert.doesNotMatch(source, /goHowMobile/);
  assert.equal(dict('zh').nav.features, undefined);
  assert.equal(dict('en').nav.features, undefined);
  // 🔴 hrefHow / goHow 要留著 —— 頁尾那條還在用
  assert.match(component, /hrefHow: anchorHref\('how-it-works'\),/);
  assert.match(component, /goHow: this\.goAnchor\('how-it-works'\),/);
  assert.match(footer, /<a href="\{\{ hrefHow \}\}" onClick="\{\{ goHow \}\}"/);
});

test('the language switch shows the flag of the language it switches to, as an image', () => {
  // 🔴 絕對不可以用 emoji 國旗:Windows 的 Chrome / Edge 不畫 regional indicator,
  //    🇹🇼 會顯示成「TW」兩個字母。
  assert.doesNotMatch(source, /[\u{1F1E6}-\u{1F1FF}]/u);   // 連註解都不要放,免得有人複製貼上
  // 旗子純裝飾:旁邊有文字,外層 <a> 又有 aria-label,所以 alt 留空
  assert.equal((source.match(/<img src="\{\{ langFlag \}\}" alt="" width="20" height="14"/g) || []).length, 2);
  // loading="lazy":瀏覽器的 preload scanner 在框架換掉 src 之前會照字面去抓 "{{ langFlag }}",
  // 每次開頁都多兩發 404。標成 lazy 之後改由版面階段載入,那時 src 已經是真的檔名了。
  assert.equal((source.match(/<img src="\{\{ langFlag \}\}"[^>]*loading="lazy"/g) || []).length, 2);
  assert.match(component, /langFlag: otherLang === 'en' \? '\/assets\/flag-gb\.svg' : '\/assets\/flag-tw\.svg',/);
  for (const file of ['flag-gb.svg', 'flag-tw.svg']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', file)), `缺少 assets/${file}`);
  }
});

test('the AI bubble carries a label so people can tell what it is', () => {
  // 這個 widget 整個活在 React 外面,字一律靠 applyStaticStrings() 填(boot + 每次切語系)
  assert.match(source, /fabTip\.textContent = txt\('fabTitle'\);/);
  assert.ok(dict('zh').ai.fabTitle && dict('en').ai.fabTitle);
  assert.doesNotMatch(dict('en').ai.fabTitle, /[一-鿿]/);
  // 點小標題跟點泡泡一樣會開面板;面板開著時收起來,不壓在面板上
  assert.match(source, /fabTip\.addEventListener\('click', function \(\) \{ if \(!panel\.classList\.contains\('ai-open'\)\) openPanel\(\); \}\);/);
  assert.match(source, /fabTip\.classList\.add\('ai-tip-hide'\);/);
  assert.match(source, /fabTip\.classList\.remove\('ai-tip-hide'\);/);
  // 跟泡泡是同一個動作,所以不進 Tab 序列、也不重複報給螢幕閱讀器
  assert.match(source, /fabTip\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(source, /fabTip\.setAttribute\('tabindex', '-1'\);/);
  // 點擊目標 >= 44px
  assert.match(source, /\.ai-fab-tip \{[^}]*min-height: 44px;/);
  // 它是 position:fixed,不收的話在手機上會一路壓在內文右下角 —— 捲過第一屏就收起來。
  // 泡泡本身不收,辨識度的目的在落地那一刻就達成了。
  assert.match(source, /window\.addEventListener\('scroll', syncTipOnScroll, \{ passive: true \}\);/);
  assert.match(source, /window\.innerHeight \* 0\.6/);
});

test('the three decorative English kickers are hidden on mobile only', () => {
  // 它們沒帶任何下方標題沒說的資訊,為了字級體檢被放大到 16px 之後階層反而被壓平。
  // .mc-eyebrow 全站只有首頁那三處在用。
  assert.equal((source.match(/class="mc-eyebrow/g) || []).length, 3);
  const compactStart = source.indexOf('<style id="m-compact">');
  const compact = source.slice(compactStart, source.indexOf('</style>', compactStart));
  assert.match(compact, /@media \(max-width: 768px\)/);
  assert.match(compact, /\.mc-eyebrow \{ display: none !important; \}/);
  // 桌機完全不動:主要 <style> 裡不准出現隱藏 kicker 的規則
  const mainStyle = source.slice(source.indexOf('<x-dc>'), source.indexOf('</x-dc>'));
  assert.doesNotMatch(mainStyle, /\.mc-eyebrow[^{]*\{[^}]*display:\s*none/);
  // 帶資訊的 eyebrow 一律留著:編號球與「01 · MENU ANALYSIS」那種編號+分類
  assert.ok((source.match(/class="ifm-eyebrow__no"/g) || []).length >= 8);
  assert.match(restaurants, /01 · MENU ANALYSIS/);
});

test('AI assistant calls all three proxy endpoints and always tells them the language', () => {
  for (const endpoint of ['/api/ai-chat', '/api/ai-menu', '/api/ai-extract']) {
    assert.match(source, new RegExp(endpoint.replace(/\//g, '\\/')), `缺少 ${endpoint}`);
  }
  // 每一個 request payload 都要帶 lang,否則英文訪客會拿到中文回覆 / 中文品名
  const payloads = source.match(/postJSON\('\/api\/ai-[a-z]+',\s*\{[^}]*\}/g) || [];
  assert.ok(payloads.length >= 2, '找不到 postJSON 的 AI 請求');
  for (const payload of payloads) {
    assert.match(payload, /lang:\s*curLang\(\)/, `這個請求沒帶 lang:${payload.slice(0, 80)}`);
  }
  // 直接用 fetch / sendBeacon 送的 ai-extract 也要帶。
  // 原本這裡釘的是「fetch 與 sendBeacon 各自組的 { messages: conv, lang: curLang() } 共兩處」——
  // 原意是:存檔請求不管走哪條路都帶 lang。2026-10 存檔改成 reason = register / lead / close 三種,
  // 改由同一個 extractPayload() 組 body,所以改釘:① 它帶 lang: curLang() ② 每一個打 ai-extract 的地方
  // (fetch 與 sendBeacon)body 都出自 extractPayload,沒有另外手組、可能漏掉 lang 的 payload。
  assert.match(source, /function extractPayload\(reason\) \{\s*var p = \{ messages: saveMessages\(history\), lang: curLang\(\), reason: reason \};/);
  const extractCalls = source.match(/(?:fetch|sendBeacon)\('\/api\/ai-extract'[^\n]*/g) || [];
  assert.ok(extractCalls.length >= 3, `找不到 ai-extract 的 fetch / sendBeacon:${extractCalls.length}`);
  assert.ok(extractCalls.some((call) => /^sendBeacon/.test(call)), '離開頁面時要用 sendBeacon 補存');
  for (const call of extractCalls) {
    // 同一行裡要嘛是 init(在 send() 裡由 extractPayload 組好),要嘛是 data / Blob(saveOnLeave 由 extractPayload 組好)
    assert.match(call, /'\/api\/ai-extract', (?:init\)|new Blob\(\[data\]|\{ method: 'POST'[^\n]*body: data)/, `這個 ai-extract 請求的 body 不是 extractPayload 組的:${call.slice(0, 120)}`);
  }
  assert.match(source, /var init = \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(extractPayload\(reason\)\) \};/);
  assert.match(source, /var data = JSON\.stringify\(extractPayload\('close'\)\);/);
  // lang 必須是「呼叫當下才取」的函式,不能是開機時抓一次存起來的變數
  assert.match(source, /function curLang\(\)[\s\S]{0,200}IfmI18n[\s\S]{0,80}current\(window\)/);
});

test('every bento span class used in markup has a matching CSS rule', () => {
  // 我自己踩過:markup 寫了 bt-3 但 CSS 只定義到 bt-4,那四張卡靜默縮成一欄寬,
  // 文字被擠成直書。grid 不會報錯,只會長得很醜,所以要有測試釘住。
  const used = new Set((source.match(/\bbt-(\d+)\b/g) || []).map((c) => c.trim()));
  const defined = new Set((source.match(/\.bt-(\d+)\s*\{/g) || []).map((c) => c.replace(/^\./, '').replace(/\s*\{$/, '')));
  const missing = [...used].filter((c) => !defined.has(c));
  assert.deepEqual(missing, [], `markup 用了這些 class 但 CSS 沒定義:${missing.join(', ')}`);

  // 同理,位移 class 也要有規則
  for (const shift of ['bt-rise', 'bt-drop']) {
    if (source.includes(`${shift}"`) || source.includes(`${shift} `)) {
      assert.match(source, new RegExp(`\\.${shift}\\s*\\{`), `${shift} 沒有 CSS 規則`);
    }
  }
});

test('news list renders every article as an irregular card with a language-aware link', () => {
  assert.match(news, /<sc-for list="\{\{ articles \}\}" as="a"/);
  // 卡片寬度是從資料算出來的(a.span),不是寫死 —— 長列表才維持得住不規則節奏
  assert.match(news, /class="ifm-card \{\{ a\.span \}\}"/);
  assert.match(news, /href="\{\{ a\.href \}\}"/);
  assert.match(news, /onClick="\{\{ a\.go \}\}"/);
  // 每張卡要有封面、分類、日期、標題、摘要
  for (const field of ['a.cover', 'a.category', 'a.date', 'a.title', 'a.excerpt']) {
    assert.match(news, new RegExp(field.replace('.', '\\.')), `新聞卡缺少 ${field}`);
  }
});

test('article page renders every block type and degrades gracefully on a bad slug', () => {
  // 模板只有 sc-if 沒有 switch,所以每個 block 型別各有一個布林旗標
  for (const flag of ['b.isH2', 'b.isP', 'b.isUl', 'b.isImg', 'b.hasLinks']) {
    assert.match(article, new RegExp(`value="\\{\\{ ${flag.replace('.', '\\.')} \\}\\}"`), `缺少 ${flag} 分支`);
  }
  // ul 內層還要再跑一層迴圈
  assert.match(article, /<sc-for list="\{\{ b\.items \}\}" as="it"/);
  assert.match(article, /<sc-for list="\{\{ b\.links \}\}" as="lk"/);
  // 外部參考連結一定要帶 rel=noopener(target=_blank 沒有它會把 opener 交出去)
  assert.match(article, /target="_blank" rel="noopener noreferrer"/);

  // slug 查不到時要顯示「找不到」而不是整頁空白
  // 注意:article 是 renderMarkup('zh') 的結果,L.* 已經被代成中文了
  const { dict } = require('../i18n.js');
  assert.match(article, /value="\{\{ articleMissing \}\}"/);
  assert.ok(article.includes(dict('zh').news.notFoundTitle), '找不到文章時沒有標題');
  assert.ok(article.includes(dict('zh').news.backToList), '找不到文章時沒有回列表的連結');
});

test('news data module is well formed and shared between languages by slug', () => {
  const news = require('../news.js');
  assert.ok(news.count > 0, '沒有任何文章');
  const zh = news.all('zh');
  const en = news.all('en');
  assert.equal(zh.length, en.length);

  const slugs = zh.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length, `slug 有重複:${slugs.join(', ')}`);
  for (const slug of slugs) {
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, `slug 只能是小寫英數與連字號:${slug}`);
  }
  // 兩個語系共用同一個 slug,/news/x 與 /en/news/x 才會是同一篇,hreflang 才指得對
  assert.deepEqual(en.map((a) => a.slug), slugs);

  // 日期新到舊
  const dates = zh.map((a) => a.date);
  assert.deepEqual([...dates].sort().reverse(), dates, '文章沒有依日期新到舊排序');

  for (const a of zh) {
    assert.match(a.date, /^\d{4}-\d{2}-\d{2}$/, `日期格式不對:${a.date}`);
    assert.ok(a.title, `id=${a.id} 沒有標題`);
    if (a.cover) assert.match(a.cover, /^\/assets\/news\/[\w-]+\.jpg$/, `封面路徑不對:${a.cover}`);
    for (const b of a.blocks) {
      assert.ok(['p', 'h2', 'ul', 'img', 'quote'].includes(b.type), `未知的 block 型別:${b.type}`);
      if (b.type === 'ul') assert.ok(Array.isArray(b.items));
      if (b.type === 'img') assert.match(b.src, /^\/assets\/news\//);
    }
  }
  // 沒有內文的文章不該出現在列表 —— 點進去只有標題,對讀者沒有價值
  for (const a of zh) {
    assert.ok(a.blocks.length > 0, `文章 ${a.slug} 沒有內文,不該出現在列表`);
  }
  assert.equal(news.bySlug('definitely-not-a-real-slug', 'zh'), null);
  assert.ok(news.bySlug(slugs[0], 'en'));
});

test('every news image referenced by the data module exists on disk', () => {
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const news = require('../news.js');
  const root = pathMod.resolve(__dirname, '..');
  const missing = [];
  for (const a of news.all('zh')) {
    const refs = [a.cover, ...a.blocks.filter((b) => b.type === 'img').map((b) => b.src)].filter(Boolean);
    for (const ref of refs) {
      if (ref.endsWith('.svg')) continue; // 備用封面是插圖,另外檢查
      if (!fsMod.existsSync(pathMod.join(root, ref.replace(/^\//, '')))) missing.push(`${a.slug} → ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `資料指到不存在的圖片:${missing.join(', ')}`);
});

test('legal page renders one document at a time and never falls into a dead end', () => {
  // 三種狀態共用一個 H1(文件標題 / 索引 / 找不到),所以不會出現一頁多個 H1
  assert.equal((legal.match(/<h1\b/g) || []).length, 1, '法律文件頁只能有一個 H1');
  assert.match(legal, /value="\{\{ isLegal \}\}"/);
  for (const flag of ['hasLegalDoc', 'legalEmpty']) {
    assert.match(legal, new RegExp(`value="\\{\\{ ${flag} \\}\\}"`), `缺少 ${flag} 分支`);
  }
  // 模板只有 sc-if 沒有 switch,所以每個 block 型別各有一個布林旗標
  for (const flag of ['b.isH2', 'b.isH3', 'b.isP', 'b.isOl', 'b.isUl']) {
    assert.match(legal, new RegExp(`value="\\{\\{ ${flag.replace('.', '\\.')} \\}\\}"`), `缺少 ${flag} 分支`);
  }
  // ol / ul 內層還要再跑一層迴圈
  assert.match(legal, /<sc-for list="\{\{ b\.items \}\}" as="it"/);
  // 目錄的錨點:h2 上的 id 與目錄項的 href 必須是同一組(序號),點了才會跳
  assert.match(legal, /<h2 id="\{\{ b\.anchor \}\}">/);
  assert.match(legal, /<sc-for list="\{\{ legalToc \}\}" as="t"/);
  assert.match(component, /const legalAnchor = \(i\) => 'legal-s' \+ i;/);
  assert.match(component, /href: '#' \+ legalAnchor\(i\)/);
  assert.match(component, /anchor: legalAnchor\(i\)/);
  // 錨點跳過去時標題不可以被固定頁首蓋住
  assert.match(source, /\.ifm-legal__body h2 \{[^}]*scroll-margin-top:\s*96px/s);

  // 三種狀態都要有出路:頂部切換列常駐,底部再列一次其他文件
  assert.match(legal, /<sc-for list="\{\{ legalDocs \}\}" as="d"/);
  assert.match(legal, /<sc-for list="\{\{ legalOthers \}\}" as="d"/);
  // 效力聲明(英文版是譯本,以中文版為準)中英都要看得到
  const { dict } = require('../i18n.js');
  assert.ok(legal.includes(dict('zh').legal.prevail), '缺少中文版效力聲明');
  assert.ok(dict('en').legal.prevail.includes('Chinese version shall prevail'));

  // 🔴 條號留在原文裡(第九條會引用第十八條),ol 一旦跑出瀏覽器的自動編號就等於改了條號
  const legalCss = source.slice(source.indexOf('.ifm-legal__body ol'), source.indexOf('/* 底部其他文件 */'));
  assert.match(legalCss, /list-style:none/, '法律文件的 ol 必須關掉自動編號');
  // 而且不可以共用文章頁的 body 樣式(那邊的 ul 是圓點,不是條號)
  assert.doesNotMatch(legal, /ifm-article__body/);
  assert.match(source, /\.ifm-article__body ul li::before/, '文章頁的圓點樣式不該被動到');
});

test('legal data module is well formed and shared between languages by slug', () => {
  const legalApi = require('../legal.js');
  assert.equal(legalApi.count, 2, '目前應該是使用條款 + 隱私權政策兩份');
  const zh = legalApi.all('zh');
  const en = legalApi.all('en');
  const slugs = zh.map((d) => d.slug);
  assert.deepEqual(slugs, ['terms', 'privacy']);
  // 兩個語系共用同一個 slug,/legal/x 與 /en/legal/x 才會是同一份,hreflang 才指得對
  assert.deepEqual(en.map((d) => d.slug), slugs);

  const CJK_RE = /[一-鿿]/;
  for (let i = 0; i < zh.length; i++) {
    const z = zh[i];
    const e = en[i];
    assert.ok(z.title && z.summary && e.title && e.summary, `${z.slug} 少了標題或摘要`);
    assert.doesNotMatch(e.title, CJK_RE, `${z.slug} 英文標題還是中文`);
    // 中英 block 一一對應 —— 對不上就代表譯本漏了或多了一段
    assert.equal(z.blocks.length, e.blocks.length, `${z.slug} 中英段落數不一致`);
    assert.deepEqual(e.blocks.map((b) => b.type), z.blocks.map((b) => b.type), `${z.slug} 中英段落型別不一致`);
    for (let j = 0; j < z.blocks.length; j++) {
      const zb = z.blocks[j];
      const eb = e.blocks[j];
      assert.ok(['h2', 'h3', 'p', 'ol', 'ul'].includes(zb.type), `未知的 block 型別:${zb.type}`);
      if (zb.type === 'ol' || zb.type === 'ul') {
        assert.equal(zb.items.length, eb.items.length, `${z.slug} block#${j} 條列項數不一致`);
      }
      const enText = (eb.text || '') + (eb.items || []).join('');
      assert.doesNotMatch(enText, CJK_RE, `${z.slug} block#${j} 英文版殘留中文`);
    }
  }

  // 條號留在文字裡:第九條的定義段會引用「第十八條」,自動編號對不上就等於改了法律文件
  const terms = legalApi.bySlug('terms', 'zh');
  assert.ok(terms.blocks.some((b) => b.type === 'h2' && b.text.includes('第九條')), '使用條款少了第九條');
  assert.ok(terms.blocks.some((b) => b.type === 'h2' && b.text.includes('第十八條')), '使用條款少了第十八條');
  assert.ok(
    terms.blocks.some((b) => (b.items || []).some((it) => it.includes('第十八條'))),
    '定義段落應該要交叉引用第十八條 —— 條號被改過的話這條會紅',
  );

  assert.equal(legalApi.bySlug('definitely-not-a-real-slug', 'zh'), null);
  assert.ok(legalApi.bySlug('privacy', 'en'));
});

test('the footer terms and privacy links finally point at the legal pages', () => {
  // 🔴 href 與 onClick 都要改。只改 onClick 的話,右鍵開新分頁與爬蟲仍然會跑到關於我們
  for (const [binding, go] of [['hrefLegalTerms', 'goLegalTerms'], ['hrefLegalPrivacy', 'goLegalPrivacy']]) {
    assert.match(footer, new RegExp(`<a href="\\{\\{ ${binding} \\}\\}" onClick="\\{\\{ ${go} \\}\\}"`));
  }
  // 兩條都帶語系前綴(href2 走 pageToPath,英文頁上才不會連回中文站)
  assert.match(component, /hrefLegalTerms: href2\('legal', 'terms'\),/);
  assert.match(component, /hrefLegalPrivacy: href2\('legal', 'privacy'\),/);
  assert.match(component, /const href2 = \(target, slug, targetLang\) =>/);
  assert.match(component, /window\.IfmRouting\.pageToPath\(target, targetLang \|\| lang, slug\)/);
  // SUPPORT 區只剩常見問題還指向別的頁面,使用條款/隱私權不可以再綁 hrefAbout
  const support = footer.slice(footer.indexOf('>SUPPORT<'));
  assert.doesNotMatch(support, /hrefAbout/, '頁尾的條款連結還綁在關於我們');
});

test('every page section lives inside the main landmark', () => {
  // 我自己踩過:新聞頁的 markup 被插在 </main> 後面,結果跳過導覽的 skip link
  // 與螢幕閱讀器的 main 地標都摸不到那兩頁,但畫面看起來完全正常。
  const mainOpen = source.indexOf('<main id="main-content"');
  const mainClose = source.indexOf('</main>');
  assert.ok(mainOpen !== -1 && mainClose > mainOpen, '找不到 main');
  for (const marker of ['HOME', 'RESTAURANTS', 'SUPPLIERS', 'CASES', 'ABOUT', 'CONTACT', 'NEWS', 'ARTICLE', 'QA', 'LEGAL']) {
    const at = source.indexOf(`<!-- ============ PAGE: ${marker}`);
    assert.ok(at !== -1, `找不到 ${marker} 區段`);
    assert.ok(at > mainOpen && at < mainClose, `${marker} 區段跑到 <main> 外面了`);
  }
  // header 與 footer 反過來,必須在 main 外面
  assert.ok(source.indexOf('<!-- ============ HEADER') < mainOpen);
  assert.ok(source.indexOf('<!-- ============ FOOTER') > mainClose);
  assert.equal((source.match(/<\/main>/g) || []).length, 1);
});

test('metadata consistently describes the approved two-sided platform', () => {
  const title = 'iFoodmap 食材地圖｜餐廳與供應商的 B2B 食材採購平台';
  const description = 'iFoodmap 以 AI 串接餐廳需求與全台食材供應商，整合智慧媒合、報價比較、訂單、出貨與採購管理。';
  assert.match(source, new RegExp(`<title>${title}<\\/title>`));
  assert.match(source, new RegExp(`<meta name="description" content="${description}">`));
  assert.match(source, new RegExp(`<meta property="og:title" content="${title}">`));
  assert.match(source, new RegExp(`<meta property="og:description" content="${description}">`));
  assert.match(source, new RegExp(`<meta name="twitter:title" content="${title}">`));
  assert.match(source, new RegExp(`<meta name="twitter:description" content="${description}">`));
  // 網域由 tests/public-domain.test.cjs 釘住;這裡只要求 canonical 跟 routing.js 的 publicBaseUrl 同一個來源
  const { publicBaseUrl } = require('../routing.js');
  assert.ok(source.includes(`<link rel="canonical" href="${publicBaseUrl}/">`));
});

test('small contact and footer copy meets deterministic WCAG AA contrast', () => {
  assert.ok(contrastRatio('#5b6b62', '#ffffff') >= 4.5);
  assert.doesNotMatch(contact, /font-size:13px;color:#8a9a8f/);
  assert.match(contact, /font-size:13px;color:#5b6b62/);
  // footer:連結 13.5px 與版權/標籤 10.5–12px 兩種小字都要過 AA
  assert.ok(contrastRatio('#9FB0A6', '#0E1A14') >= 4.5);
  assert.ok(contrastRatio('#71867A', '#0E1A14') >= 4.5);
  assert.doesNotMatch(footer, /color:#6D8276/); // 設計稿原色 4.34,差一點不到 AA
  assert.match(footer, /font-size:13\.5px;text-decoration:none;font-weight:300/);
  assert.match(footer, /font-size:12px;color:#71867A/);
});

test('footer has three design columns with real internal and product destinations', () => {
  for (const group of ['SERVICE', 'COMPANY', 'SUPPORT']) {
    assert.match(footer, new RegExp(`<div[^>]*>${group}<\\/div>`));
  }
  // 內部連結走 {{ href* }} 綁定才會帶語系前綴;寫死 /restaurants 的話英文頁會跳回中文站
  for (const binding of ['hrefRestaurants', 'hrefSuppliers', 'hrefCases', 'hrefAbout', 'hrefContact']) {
    assert.match(footer, new RegExp(`<a href="\\{\\{ ${binding} \\}\\}"`));
  }
  assert.match(footer, /href="\{\{\s*loginUrl\s*\}\}"[^>]*>登入平台<\/a>/);
  assert.doesNotMatch(footer, /<span[^>]*>(?:常見問題|使用條款)<\/span>/); // 不留假連結
  assert.match(footer, /href="tel:0277045539"/);
  assert.match(footer, /href="mailto:ifoodmaptw@gmail\.com"/);
});

test('footer carries exactly the two approved social accounts', () => {
  // 客服 LINE@ 與 Facebook。舊站那兩個導流用的 LINE 帳號與那支 YouTube 宣傳影片刻意不搬。
  assert.match(footer, /href="https:\/\/line\.me\/R\/ti\/p\/@750yvxki\?oat_content=url"/);
  assert.match(footer, /href="https:\/\/www\.facebook\.com\/iFoodmap"/);
  assert.doesNotMatch(source, /@694xprvx|@988wsmli/);
  assert.doesNotMatch(footer, /youtube|youtu\.be/i);
  // 兩條都是外部連結
  assert.equal((footer.match(/target="_blank"/g) || []).length, 2);
  // 品牌色塊是商標,aria-hidden;可及名稱一律走 <a> 自己的 aria-label(綁字典,zh/en 都有)
  assert.equal((footer.match(/<span aria-hidden="true"[^>]*background:#(?:06C755|1877F2)/g) || []).length, 2);
  for (const key of ['socialLineLabel', 'socialLineAria', 'socialFollowLabel', 'socialFacebookAria']) {
    assert.ok(dict('zh').footer[key] && dict('en').footer[key], `缺少 footer.${key}`);
    assert.doesNotMatch(dict('en').footer[key], /[\u4e00-\u9fff]/, `footer.${key} 英文版還是中文`);
  }
  // 點擊目標 >= 44px,而且深色底上的焦點框要看得見(#166534 對 #0E1A14 只有 2.5:1)
  assert.match(footer, /min-height:44px/);
  assert.match(source, /footer a:focus-visible \{ outline-color:#C3D543; \}/);
  assert.ok(contrastRatio('#C3D543', '#0E1A14') >= 3);
});

test('AI dialog closed and open states are keyboard-safe with mutation-sensitive guards', () => {
  assertAiDialogLifecycle(source);
  assert.throws(() => assertAiDialogLifecycle(source.replace("panel.inert = true;", '')));
  assert.throws(() => assertAiDialogLifecycle(source.replace("panel.removeAttribute('aria-hidden');", '')));
  assert.throws(() => assertAiDialogLifecycle(source.replace("if (e.key === 'Escape')", "if (e.key === 'Never')")));
  assert.throws(() => assertAiDialogLifecycle(source.replace("if (e.key !== 'Tab') return;", '')));
  assert.throws(() => assertAiDialogLifecycle(source.replace("appRoot.inert = true;", '')));
  assert.throws(() => assertAiDialogLifecycle(source.replace("backdrop.classList.add('ai-show');", '')));
});

test('AI input has a persistent label and new messages use a non-repeating live log', () => {
  assertAiAnnouncements(source);
  assert.throws(() => assertAiAnnouncements(source.replace('for="ai-assistant-input"', '')));
  assert.throws(() => assertAiAnnouncements(source.replace("body.setAttribute('role', 'log');", '')));
  assert.throws(() => assertAiAnnouncements(source.replace("body.setAttribute('aria-relevant', 'additions');", '')));
});

test('reduced-motion mode removes drawer, scrim, hamburger and AI FAB transitions', () => {
  assert.match(
    source,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.m-menu,[\s\S]*?\.m-scrim,[\s\S]*?\.m-hamburger span[\s\S]*?transition:\s*none\s*!important/s,
  );
  assert.match(
    source,
    // 泡泡是靜態轉 45° 的大頭針造型;reduced-motion 只需拿掉 hover/open 的縮放動效,
    // 保留 rotate(45deg) 這個沒有動作的基礎變形,否則會變回正方形
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.ai-fab\s*\{[^}]*transition:\s*none\s*!important[^}]*\}[\s\S]*?\.ai-fab:hover,[\s\S]*?\.ai-fab\.ai-open\s*\{[^}]*transform:\s*(?:none|rotate\(45deg\))\s*!important/s,
  );
});

test('interactive states are real CSS, not the design export\'s dead style-hover attribute', () => {
  // 設計稿匯出時在 34 個元素上留了 style-hover="…",但 support.js 從來沒有實作這個屬性
  // —— 導覽列、頁尾、首頁 CTA 的 hover 從上線到現在一次都沒作用過。已全部改成真 CSS。
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  const leftovers = raw.match(/style-hover="[^"]*"/g) || [];
  assert.deepEqual(leftovers, [], `style-hover 是沒人實作的死屬性,不可以再出現:${leftovers.join(', ')}`);

  // hover 會改到的宣告必須放在 CSS,不能留在 inline style ——
  // inline 的優先權壓過 stylesheet,留在 inline 的話 :hover 會「match 到但畫面沒反應」。
  for (const [cls, decl] of [
    ['mc-navlink', 'color:#4B5A52'], ['mc-navcta', 'background:#0E1A14'],
    ['mc-searchbtn', 'background:#0B6B40'], ['mc-ctaprimary', 'background:#0B6B40'],
    ['mc-footlink', 'color:#9FB0A6'],
  ]) {
    assert.match(raw, new RegExp(`\\.${cls}\\s*\\{[^}]*${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `.${cls} 的 ${decl} 應該在 CSS 裡`);
    const tag = raw.match(new RegExp(`class="${cls}"[^>]*`))[0];
    assert.doesNotMatch(tag, new RegExp(decl.split(':')[0] + ':'),
      `.${cls} 的 ${decl.split(':')[0]} 又跑回 inline style 了,hover 會失效`);
  }

  // 兩個曾經把焦點框清光的地方:搜尋框的 inline outline:none、快捷籤的 all:unset
  assert.doesNotMatch(raw, /class="mc-searchinput"[^>]*outline:none/);
  assert.match(raw, /\.mc-searchinput:focus-visible \{[^}]*outline:3px/);
  assert.match(raw, /\.ifm-chip-btn:focus-visible \{[^}]*outline:3px/);
  assert.doesNotMatch(raw, /<button[^>]*style="all:unset/);
});

test('every templated <img> defers to the framework so the preload scanner never fetches "{{ … }}"', () => {
  // 瀏覽器的 preload scanner 在框架解綁定之前就會照字面去抓 src,
  // 少一個 loading="lazy" 就是每頁白跑一次 404(/{{ article.cover }})。
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  const bound = raw.match(/<img[^>]*src="\{\{[^"]*\}\}"[^>]*>/g) || [];
  assert.ok(bound.length >= 10, `綁定式 <img> 只找到 ${bound.length} 個,這條檢查可能失效了`);
  for (const tag of bound) {
    assert.match(tag, /loading="lazy"/, `綁定 src 的 <img> 少了 loading="lazy":${tag.slice(0, 110)}`);
  }

  // 文章圖的長寬要從資料來(每張圖比例都不一樣,寫死一個值等於自己製造位移)
  assert.match(raw, /<img src="\{\{ article\.cover \}\}"[^>]*width="\{\{ article\.coverW \}\}" height="\{\{ article\.coverH \}\}"/);
  assert.match(raw, /<img src="\{\{ b\.src \}\}"[^>]*width="\{\{ b\.w \}\}" height="\{\{ b\.h \}\}"/);

  const news = require('../news.js');
  for (const a of news._raw) {
    if (a.cover) assert.ok(a.coverW > 0 && a.coverH > 0, `${a.slug} 的封面沒有尺寸`);
    for (const lang of ['zh', 'en']) {
      for (const b of a[lang].blocks) {
        if (b.type === 'img') assert.ok(b.w > 0 && b.h > 0, `${a.slug}/${lang} 的內文圖 ${b.src} 沒有尺寸`);
      }
    }
  }
});

test('the language hint is a dismissible region above the header, outside <main>, labelled in the language it suggests', () => {
  // 用原始碼(綁定沒代換)來驗:提示條的字全部是 {{ langHint.* }},不是 L.*
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  const hintAt = raw.indexOf('<!-- ============ LANGUAGE HINT ============ -->');
  const skipAt = raw.indexOf('<a class="skip-link"');
  const headerAt = raw.indexOf('<!-- ============ HEADER ============ -->');
  const mainAt = raw.indexOf('<main id="main-content"');
  assert.ok(hintAt !== -1, '找不到 LANGUAGE HINT 區段');
  // skip link 仍是第一個 Tab 停點;提示條在頁面最頂端、header 之前,也就在 <main> 外面(它不是頁面內容)
  assert.ok(skipAt < hintAt && hintAt < headerAt && headerAt < mainAt, '順序必須是 skip link → 提示條 → header → main');
  const hint = raw.slice(hintAt, headerAt);

  // 不需要時整塊不渲染(連隱藏的節點都沒有),預渲染也就不可能把它烤進靜態檔
  assert.match(hint, /<sc-if value="\{\{ showLangHint \}\}">/);
  const region = (hint.match(/<div class="ifm-langhint"[^>]*>/) || [''])[0];
  assert.match(region, /role="region"/);
  assert.match(region, /aria-label="\{\{ langHint\.regionLabel \}\}"/);
  // 內容的語言跟頁面不同:lang 標成建議的那個語系,螢幕閱讀器才會用對的發音
  assert.match(region, /lang="\{\{ langHintTag \}\}"/);
  // 這句話不該變成 Google 搜尋結果的摘要(Googlebot 以 en-US 渲染,看得到中文首頁上的英文提示條)
  assert.match(region, /data-nosnippet/);
  // 切換 = 真的 <a href>(新分頁開啟、右鍵複製連結都正常);關閉 = <button type="button">
  assert.match(hint, /<a href="\{\{ hrefLangHint \}\}" onClick="\{\{ acceptLangHint \}\}"/);
  assert.match(hint, /<button type="button" onClick="\{\{ dismissLangHint \}\}" aria-label="\{\{ langHint\.dismissLabel \}\}"/);
  // 箭頭與 × 是裝飾,不念出來
  assert.match(hint, /<span aria-hidden="true">→<\/span>/);
  assert.match(hint, /<span aria-hidden="true">×<\/span>/);
  // 🔴 字不可以綁 L.*:L 是「這一頁」的語系,正好是讀提示條的人看不懂的那個
  assert.doesNotMatch(hint, /\{\{ L\./);
  assert.match(component, /langHint: hintLang \? \(i18n\.dict\(hintLang\)\.langHint \|\| \{\}\) : \{\}/);

  // CSS:字 16px、兩個點擊區 44px(手機也一樣 —— m-compact 的 16px 下限只管 main,管不到這裡)、
  // 鍵盤焦點看得見、配色只用站上既有的色票
  const rule = (selector) => {
    const m = raw.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, `找不到 ${selector} 的 CSS`);
    return m[1];
  };
  assert.match(rule('.ifm-langhint__msg'), /font-size:16px/);
  assert.match(rule('.ifm-langhint__switch'), /min-height:44px/);
  assert.match(rule('.ifm-langhint__switch'), /font-size:16px/);
  assert.match(rule('.ifm-langhint__close'), /width:44px/);
  assert.match(rule('.ifm-langhint__close'), /height:44px/);
  assert.match(raw, /\.ifm-langhint__switch:focus-visible,\s*\.ifm-langhint__close:focus-visible\s*\{[^}]*outline:3px solid #0B6B40/);
  assert.doesNotMatch(rule('.ifm-langhint'), /position:\s*(fixed|absolute)/, '提示條跟著文件流,不可以蓋住內容');
  for (const [fg, bg] of [
    ['#0E1A14', '#F3FAF6'], // 內文
    ['#0B6B40', '#F3FAF6'], // 切換連結
    ['#074E2E', '#F3FAF6'], // 切換連結 hover
    ['#4B5A52', '#F3FAF6'], // ×
    ['#0E1A14', '#E6EAE7'], // × hover
  ]) {
    assert.ok(contrastRatio(fg, bg) >= 4.5, `${fg} on ${bg} = ${contrastRatio(fg, bg).toFixed(2)}`);
  }
  // 焦點框對底色至少 3:1(WCAG 1.4.11)
  assert.ok(contrastRatio('#0B6B40', '#F3FAF6') >= 3);
});
