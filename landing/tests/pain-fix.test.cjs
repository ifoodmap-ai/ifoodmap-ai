const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dict } = require('../i18n.js');

// 首頁「找食材，你也遇過這些問題嗎？」→「現在，找食材可以更有效率！」(業主 2026-09-28)
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const home = html.slice(html.indexOf('<!-- ============ PAGE: HOME ============ -->'), html.indexOf('<!-- ============ PAGE: RESTAURANTS ============ -->'));

test('文案照業主給的,一字不改', () => {
  const zh = dict('zh').home;
  assert.equal(zh.pfTitlePre + zh.pfTitleHl, '找食材，你也遇過這些問題嗎？');
  assert.deepEqual(zh.data.pfProblems, [
    '找供應商多半靠同行介紹，上網搜尋總是那幾家',
    '商品資訊不完整，還得打電話逐一詢價、確認配送範圍',
    '留下聯絡資料後，等了好幾天仍收不到回覆',
  ]);
  assert.equal(zh.pfSolPre + zh.pfSolHl, '現在，找食材可以更有效率！');
  assert.equal(zh.pfLeadA + zh.pfLeadB, '告訴食材地圖你的採購需求，快速媒合合適的產地、加工廠與各級供應商。');
  assert.deepEqual(zh.data.pfTypes, ['產地供應商', '加工廠', '大盤商', '中盤商', '小盤商']);
  const en = dict('en').home;
  assert.equal(en.data.pfProblems.length, 3);
  assert.equal(en.data.pfTypes.length, 5);
});

test('位置在統計數字之後、「WHO IT\'S FOR」之前', () => {
  const stats = home.indexOf('class="mc-stats"');
  const pf = home.indexOf('class="ifm-v2 pf"');
  const who = home.indexOf("WHO IT'S FOR");
  assert.ok(stats > -1 && pf > stats && who > pf, `順序不對:stats=${stats} pf=${pf} who=${who}`);
});

test('標題階層:一個 h2 + 一個 h3,沒有多塞 h1', () => {
  const sec = home.slice(home.indexOf('class="ifm-v2 pf"'), home.indexOf('</section>', home.indexOf('class="ifm-v2 pf"')));
  assert.equal((sec.match(/<h1\b/g) || []).length, 0);
  assert.equal((sec.match(/<h2\b/g) || []).length, 1);
  assert.equal((sec.match(/<h3\b/g) || []).length, 1);
  assert.match(sec, /aria-labelledby="pf-title"/);
  // 藥丸標籤列拿掉之後(業主 2026-09-29),五種供應商只剩插圖那組 →
  // 它不能再 aria-hidden,要是一個有名字的 group,螢幕閱讀器才讀得到五個 figcaption
  assert.match(sec, /class="pf-network" role="group" aria-label="\{\{ L\.home\.pfTypesAria \}\}"/);
  assert.doesNotMatch(sec, /class="pf-network"[^>]*aria-hidden/);
});

test('藥丸標籤列已拿掉(業主 2026-09-29),連 CSS 一起清乾淨', () => {
  const sec = home.slice(home.indexOf('class="ifm-v2 pf"'), home.indexOf('</section>', home.indexOf('class="ifm-v2 pf"')));
  assert.doesNotMatch(sec, /pf-typelist/);
  const at = html.indexOf('<style id="pf">\n');
  const css = html.slice(at, html.indexOf('</style>', at));
  assert.doesNotMatch(css, /pf-typelist/);
});

test('說明文字的間距壓得過 .ifm-v2 p{margin:0}(不然黑底標題、說明文字會黏在一起)', () => {
  // .ifm-v2 p 的權重是 (0,1,1),只寫 .pf-lead(0,1,0)的 margin 會被整個歸零 ——
  // 畫面上看不出 CSS 有寫錯,只會覺得「擠在一起」,業主 2026-09-29 截圖才發現
  const at = html.indexOf('<style id="pf">\n');
  // 先去掉註解:註解裡本身就寫了 .ifm-v2 p{margin:0},不去掉會被當成一條規則
  const css = html.slice(at, html.indexOf('</style>', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  const leadRules = css.match(/[^{}]*\.pf-lead[^{}]*\{[^}]*\}/g) || [];
  assert.ok(leadRules.length > 0, '找不到 .pf-lead 的樣式');
  for (const rule of leadRules) {
    if (!/margin/.test(rule)) continue;
    const selector = rule.slice(0, rule.indexOf('{')).trim();
    assert.match(selector, /^\.pf \.pf-lead$/, `設 margin 的選擇器要寫成 .pf .pf-lead,現在是「${selector}」`);
  }
  const desktop = leadRules.find((r) => /\.pf \.pf-lead\s*\{[^}]*margin:\s*\d+px 0 0/.test(r));
  assert.ok(desktop, '桌機版要有上方間距、下方 0(它是左欄最後一個元素)');
});

test('大標下方的間距壓得過 .ifm-v2 h2{margin:0}(不然大標直接貼著第 01 列)', () => {
  // 同上一條的雷:.ifm-v2 h2 的權重 (0,1,1) 比 .pf-title(0,1,0)高,
  // 只寫 .pf-title 的 margin 會被整個歸零 —— 2026-10-07 實測大標與第 01 列之間 0px
  const at = html.indexOf('<style id="pf">\n');
  const css = html.slice(at, html.indexOf('</style>', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  const titleRules = css.match(/[^{}]*\.pf-title[^{}]*\{[^}]*\}/g) || [];
  assert.ok(titleRules.length > 0, '找不到 .pf-title 的樣式');
  for (const rule of titleRules) {
    if (!/margin/.test(rule)) continue;
    const selector = rule.slice(0, rule.indexOf('{')).trim();
    assert.match(selector, /^\.pf \.pf-title$/, `設 margin 的選擇器要寫成 .pf .pf-title,現在是「${selector}」`);
  }
  // 數值照舊:上 0、下 clamp(32px,4vw,52px)
  const desktop = titleRules.find((r) => /\.pf \.pf-title\s*\{[^}]*margin:\s*0 0 clamp\(32px,\s*4vw,\s*52px\)/.test(r));
  assert.ok(desktop, '大標下方要有 clamp(32px,4vw,52px) 的間距');
});

test('版面不寫行內 grid(support.js 會把行內多欄 grid 在手機上強制改單欄)', () => {
  const sec = home.slice(home.indexOf('class="ifm-v2 pf"'), home.indexOf('</section>', home.indexOf('class="ifm-v2 pf"')));
  assert.doesNotMatch(sec, /style="[^"]*grid-template-columns/);
});

test('用到的圖都存在,而且不含文字', () => {
  const imgs = ['rest-pain-1', 'rest-pain-2', 'pf-problem-3', 'pf-thinking', 'pf-match',
    'pf-type-origin', 'pf-type-processor', 'pf-type-large', 'pf-type-mid', 'pf-type-small'];
  for (const n of imgs) {
    const f = path.join(ROOT, 'assets', n + '.svg');
    assert.ok(fs.existsSync(f), `缺 assets/${n}.svg`);
    const svg = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(svg, /<text\b/, `${n}.svg 裡有 <text>(雙語網站,圖裡不能寫死文字)`);
    assert.doesNotMatch(svg, /\s(id|class|style)=/, `${n}.svg 不可以有 id/class/style`);
  }
});

test('手機版五個圓排成上 3 下 2,標籤可以換行', () => {
  // 第 826 行的註解也提到 <style id="pf">,所以要找後面緊接換行的那個真正的標籤
  const at = html.indexOf('<style id="pf">\n');
  assert.ok(at > 0, '找不到 <style id="pf">');
  const css = html.slice(at, html.indexOf('</style>', at));
  const mobile = css.slice(css.indexOf('@media (max-width: 880px)'));
  // 只寫 grid-area:auto !important 會連 span 2 一起蓋掉,五個圓擠成一排疊在一起(插圖 agent 在模擬頁抓到的)
  assert.match(mobile, /\.pf-node\s*\{[^}]*grid-area:\s*auto\s*\/\s*span 2\s*!important/);
  assert.match(mobile, /\.pf-node--mid\s*\{[^}]*grid-column:\s*2\s*\/\s*span 2\s*!important/);
  assert.match(mobile, /\.pf-node--small\s*\{[^}]*grid-column:\s*4\s*\/\s*span 2\s*!important/);
  // 英文的 "Mid-size wholesalers" 不換行會超出欄寬
  const caption = css.match(/\.pf-node figcaption\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(caption, /nowrap/);
  assert.match(caption, /max-width:\s*100%/);
});
