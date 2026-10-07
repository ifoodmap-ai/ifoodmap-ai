const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dict } = require('../i18n.js');

// 首頁「每天叫貨，你也遇過這些問題嗎？」→「現在，例行採購可以更簡單！」(業主 2026-10-07)
// 緊接在「找食材」那一區(pf,見 pain-fix.test.cjs)之下。版型照業主給的參考圖,視覺比照 pf。
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const home = html.slice(html.indexOf('<!-- ============ PAGE: HOME ============ -->'), html.indexOf('<!-- ============ PAGE: RESTAURANTS ============ -->'));
const rpStart = home.indexOf('class="ifm-v2 rp"');
const sec = home.slice(rpStart, home.indexOf('</section>', rpStart));
const componentStart = html.indexOf('<script type="text/x-dc" data-dc-script>');
const component = html.slice(componentStart, html.indexOf('</script>', componentStart));

// 註解裡也提到 <style id="rp">,所以要找後面緊接換行的那個真正的標籤(同 pain-fix 的作法)
function rpCss({ stripComments = true } = {}) {
  const at = html.indexOf('<style id="rp">\n');
  assert.ok(at > 0, '找不到 <style id="rp">');
  const css = html.slice(at, html.indexOf('</style>', at));
  return stripComments ? css.replace(/\/\*[\s\S]*?\*\//g, '') : css;
}

// 插圖規格照兩方契約(檔名 → viewBox);版面上 <img> 的 width/height 也是照這個比例寫的
const RP_IMAGES = {
  'rp-chef': '0 0 200 240',
  'rp-problem-1': '0 0 120 120',
  'rp-problem-2': '0 0 120 120',
  'rp-problem-3': '0 0 120 120',
  'rp-problem-4': '0 0 120 120',
  'rp-solution': '0 0 560 360',
  'rp-feat-order': '0 0 32 32',
  'rp-feat-summary': '0 0 32 32',
  'rp-feat-tracking': '0 0 32 32',
  'rp-feat-history': '0 0 32 32',
  'rp-feat-reconcile': '0 0 32 32',
};

test('文案照業主給的,一字不改', () => {
  const zh = dict('zh').home;
  assert.equal(zh.rpTitlePre, '每天叫貨，你也');
  assert.equal(zh.rpTitleHl, '遇過這些問題嗎？');
  assert.deepEqual(zh.data.rpProblems, [
    '訂單散落在 LINE、電話與紙本，訊息太多容易漏單',
    '每天反覆確認品項、數量、價格與到貨時間，耗時又容易出錯',
    '訂單與對帳資料分散，月底整理費時又增加人力成本',
    '不清楚確切食材成本與採購數量，難以掌握餐廳實際賺賠',
  ]);
  assert.equal(zh.rpSolPre, '現在，例行採購');
  assert.equal(zh.rpSolHl, '可以更簡單！');
  assert.equal(zh.rpLeadA, '透過食材地圖集中管理每日叫貨，');
  assert.equal(zh.rpLeadB, '從下單、進度追蹤、訂單彙整到月底對帳一次掌握。');
  assert.deepEqual(zh.data.rpFeatures, ['集中下單', '訂單彙整', '進度追蹤', '歷史查詢', '快速對帳']);
  assert.equal(zh.rpFeaturesAria, '例行採購的功能');
  // 業主貼的標題後面那句「(例行性採購問題）」是給我們的說明,不上畫面
  assert.doesNotMatch(JSON.stringify(zh), /例行性採購問題/);
});

test('英文版的項數跟中文一樣,每一句都有翻、沒有殘留中文', () => {
  const zh = dict('zh').home;
  const en = dict('en').home;
  assert.equal(en.data.rpProblems.length, zh.data.rpProblems.length);
  assert.equal(en.data.rpFeatures.length, zh.data.rpFeatures.length);
  const strings = [en.rpTitlePre, en.rpTitleHl, en.rpSolPre, en.rpSolHl, en.rpLeadA, en.rpLeadB, en.rpFeaturesAria,
    ...en.data.rpProblems, ...en.data.rpFeatures];
  for (const s of strings) {
    assert.equal(typeof s, 'string');
    assert.ok(s.trim(), '英文有空字串');
    assert.doesNotMatch(s, /[\u4e00-\u9fff]/, `英文殘留中文:${s}`);
  }
  // 功能名稱是 UI 標籤:要短,兩個字以內 + 不超過 20 個字元(版面上五項要能排在同一條)
  for (const label of en.data.rpFeatures) {
    assert.ok(label.length <= 20 && label.split(' ').length <= 2, `功能名稱太長:${label}`);
  }
  // 英文問題與說明:最後兩個字用不換行空白黏住,手機上最後一行才不會只剩一個字
  // (Chrome 的 text-wrap:pretty 只管四行以內的段落,320px 的英文問題列有九行)。
  // 黏住的那一段不能有一般連字號 —— error-prone 這種,連字號後面照樣會斷,最後一行又只剩 prone。
  const NBSP = String.fromCharCode(0xa0);
  for (const s of [...en.data.rpProblems, en.rpLeadA, en.rpLeadB]) {
    const tail = s.slice(s.lastIndexOf(' ') + 1);
    assert.ok(tail.includes(NBSP), `最後兩個字要用不換行空白黏住:${s}`);
    assert.doesNotMatch(tail, /-/, `黏住的結尾不要有一般連字號:${s}`);
  }
});

test('位置在「找食材」(pf)之後、「WHO IT\'S FOR」之前', () => {
  const pf = home.indexOf('class="ifm-v2 pf"');
  const pfEnd = home.indexOf('</section>', pf);
  const who = home.indexOf("WHO IT'S FOR");
  assert.ok(pf > -1 && rpStart > pfEnd && who > rpStart, `順序不對:pf=${pf} pf結束=${pfEnd} rp=${rpStart} who=${who}`);
  // pf 結束之後下一個 section 就是 rp,中間沒有夾別的區塊
  const between = home.slice(pfEnd + '</section>'.length, rpStart);
  assert.equal((between.match(/<section\b/g) || []).length, 1, 'pf 與 rp 之間夾了別的 section');
  assert.equal((home.match(/class="ifm-v2 rp"/g) || []).length, 1, '每天叫貨區只能有一個');
});

test('標題階層:一個 h2 + 一個 h3,沒有多塞 h1', () => {
  assert.equal((sec.match(/<h1\b/g) || []).length, 0);
  assert.equal((sec.match(/<h2\b/g) || []).length, 1);
  assert.equal((sec.match(/<h3\b/g) || []).length, 1);
  assert.match(sec, /^class="ifm-v2 rp" aria-labelledby="rp-title">/);
  assert.match(sec, /<h2 id="rp-title" class="rp-title">\{\{ L\.home\.rpTitlePre \}\}<span class="rp-hl">\{\{ L\.home\.rpTitleHl \}\}<\/span><\/h2>/);
  assert.match(sec, /<h3 class="rp-sol">\{\{ L\.home\.rpSolPre \}\}<mark>\{\{ L\.home\.rpSolHl \}\}<\/mark><\/h3>/);
  // h2 要在 h3 前面,而且是區塊裡第一個標題
  assert.ok(sec.indexOf('<h2') < sec.indexOf('<h3'));
  // 全站規則:首頁只能有一個 h1(就是 hero 那個)
  assert.equal((home.match(/<h1\b/g) || []).length, 1);
});

test('五個功能是一個有名字的 group,圖示都是裝飾', () => {
  assert.match(sec, /<div class="rp-feats" role="group" aria-label="\{\{ L\.home\.rpFeaturesAria \}\}">/);
  assert.doesNotMatch(sec, /class="rp-feats"[^>]*aria-hidden/);
  assert.match(sec, /<sc-for list="\{\{ rpFeatures \}\}"/);
  assert.match(sec, /<sc-for list="\{\{ rpProblems \}\}"/);
  // 每張圖都是 alt=""(文字都在旁邊),而且延遲載入(綁定 src 的圖少了 lazy 會先去抓 "{{ … }}")
  const imgs = sec.match(/<img\b[^>]*>/g) || [];
  assert.equal(imgs.length, 4, '應該是 廚師、問題圖示、功能圖示、筆電 四個 <img>');
  for (const tag of imgs) {
    assert.match(tag, /\salt=""/, `圖片要 alt="":${tag}`);
    assert.match(tag, /\sloading="lazy"/, `圖片要 loading="lazy":${tag}`);
  }
  // 編號圓只是裝飾,序號由 <ol> 給
  assert.match(sec, /<ol class="rp-problems">/);
  assert.match(sec, /<span class="rp-no" aria-hidden="true">/);
});

test('版面不寫行內樣式(support.js 會把行內多欄 grid 在手機上強制改單欄)', () => {
  assert.doesNotMatch(sec, /style="[^"]*grid/);
  // 整區連一個 style 屬性都沒有:版面、字級全部在 <style id="rp">,
  // 手機上 m-compact 那套「比對行內字級抬到 16px」的規則也就不會意外介入
  assert.doesNotMatch(sec, /\sstyle="/);
});

test('<style id="rp"> 緊接在 <style id="pf"> 之後,手機斷點跟 pf 一樣是 880px', () => {
  const pfAt = html.indexOf('<style id="pf">\n');
  const pfEnd = html.indexOf('</style>', pfAt) + '</style>'.length;
  assert.equal(html.slice(pfEnd, pfEnd + '\n<style id="rp">\n'.length), '\n<style id="rp">\n');
  const css = rpCss();
  const mobile = css.slice(css.indexOf('@media (max-width: 880px)'));
  assert.ok(css.includes('@media (max-width: 880px)'), '少了手機斷點');
  // 手機塌成單欄:上半只剩 標題 + 問題列(廚師收起來,同 pf 的 .pf-thinking)
  assert.match(mobile, /\.rp-top\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(mobile, /\.rp-chef\s*\{[^}]*display:\s*none/);
  // 下半:說明 → 功能格線 → 筆電插圖(2026-10-07 起手機也顯示,不然整區一張圖都沒有)
  assert.match(mobile, /\.rp-bottom\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*grid-template-areas:\s*"copy"\s*"feats"\s*"art"/);
  assert.doesNotMatch(mobile, /\.rp-solution\s*\{[^}]*display:\s*none/);
  assert.match(mobile, /\.rp-solution\s*\{[^}]*justify-self:\s*center[^}]*max-width:\s*340px/);
  // 寬度跟著卡片走(width:100%),比 340px 窄的手機上不會撐出橫向捲軸
  assert.match(css.slice(0, css.indexOf('@media')), /\.rp-solution\s*\{[^}]*grid-area:\s*art[^}]*width:\s*100%/);
});

test('五個功能在窄螢幕會折行或改排列,不會橫向溢出', () => {
  const css = rpCss();
  const desktop = css.slice(0, css.indexOf('@media'));
  const mobile = css.slice(css.indexOf('@media (max-width: 880px)'));
  // 桌機:一排並排,放不下就整項換行;每行行首的分隔線藏在 overflow:hidden 外面
  assert.match(desktop, /\.rp \.rp-featlist\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*hidden/);
  assert.match(desktop, /\.rp \.rp-feat\s*\{[^}]*margin-left:\s*-1px/);
  assert.match(desktop, /\.rp-feats\s*\{[^}]*max-width:\s*100%/);
  // 任何寬度都不准在單字中間斷開(2026-10-07 驗收抓到 /en 320–360px 斷成 orderin／g、summar／ies):
  // 功能名稱不用 overflow-wrap / 自動連字號;放不下的寬度改排法(下面英文單欄那條)
  const featname = css.match(/\.rp-featname\s*\{[^}]*\}/)[0];
  assert.match(featname, /min-width:\s*0/);
  assert.doesNotMatch(featname, /overflow-wrap|word-break|hyphens/);
  assert.doesNotMatch(css, /overflow-wrap:\s*anywhere|hyphens:\s*auto/);
  // 手機:兩欄格線,第五項獨佔一整列
  assert.match(mobile, /\.rp \.rp-featlist\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobile, /\.rp-feat:last-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  // 手機上功能名稱 >= 16px(全站手機內文字級下限,見 m-compact ①)
  assert.match(mobile, /\.rp-feat\s*\{[^}]*font-size:\s*16px/);
  // 英文 480px 以下改單欄:兩欄要 459px 以上每項才排得進一行(實測),再窄會折行、甚至拆字。中文四個字,維持兩欄
  assert.ok(css.includes('@media (max-width: 480px)'), '少了英文單欄的斷點');
  const en480 = css.slice(css.indexOf('@media (max-width: 480px)'));
  assert.match(en480, /\.rp \.rp-featlist:lang\(en\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(css, /\.rp-featlist:lang\(zh\)/);
});

test('320px 級窄手機:卡片內距收窄,中文說明第一行的逗號不會自己掉到下一行', () => {
  // 「透過食材地圖集中管理每日叫貨，」15 個字 × 16px = 240px,keep-all 之下中間不能斷;
  // 320px 時 wrap 左右 26px、卡片框 1px×2、內距 14px×2 → 只剩 238px,逗號被擠下去(2026-10-07 驗收抓到)
  const css = rpCss();
  assert.ok(css.includes('@media (max-width: 340px)'), '少了窄手機的斷點');
  const narrow = css.slice(css.indexOf('@media (max-width: 340px)'));
  assert.match(narrow, /\.rp-bottom\s*\{[^}]*padding-left:\s*10px;\s*padding-right:\s*10px/);
  const leadA = dict('zh').home.rpLeadA;
  assert.ok([...leadA].length * 16 <= 320 - 26 * 2 - 1 * 2 - 10 * 2, '說明第一行在 320px 仍放不下');
  assert.match(css, /\.rp-lead:lang\(zh\)\s*\{[^}]*word-break:\s*keep-all/);
});

test('問題列不會只剩一個字掉到最後一行(text-wrap:pretty,兩區一致)', () => {
  // 驗收抓到 390px 第 03 列剩「本」、414px 剩「錯」、900px 剩「單」「本」
  assert.match(rpCss(), /\.rp-text\s*\{[^}]*text-wrap:\s*pretty/);
  const at = html.indexOf('<style id="pf">\n');
  const pf = html.slice(at, html.indexOf('</style>', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(pf, /\.pf-text\s*\{[^}]*text-wrap:\s*pretty/);
});

test('段落與清單的 margin 壓得過 .ifm-v2 p/ul/ol{margin:0}(選擇器要兩層 class)', () => {
  // .ifm-v2 p 的權重是 (0,1,1)。只寫 .rp-lead(0,1,0)的 margin 會被整個歸零 ——
  // 畫面上看不出 CSS 有寫錯,只會覺得「擠在一起」(pf 2026-09-29 就是這樣被業主截圖抓到的)。
  // 作法:找出區塊裡每個 class 掛在哪種元素上,凡是會被 reset 歸零的元素(p/ul/ol/h1–h4),
  // 只要規則設了「不是 0」的 margin,選擇器的 class 層級(含 :pseudo)就必須至少兩個。
  const tagOf = {};
  for (const m of sec.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bclass="([^"{}]+)"/g)) {
    for (const c of m[2].split(/\s+/)) tagOf[c] = m[1];
  }
  const RESET = new Set(['p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4']);
  const isZero = (v) => /^0(px)?(\s+0(px)?)*$/.test(v.trim());
  const checked = [];
  const offenders = [];
  for (const [, selectors, body] of rpCss().matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const margins = [...body.matchAll(/(?:^|[;\s])margin(?:-[a-z-]+)?\s*:\s*([^;]+)/g)].map((m) => m[1]);
    if (!margins.length || margins.every(isZero)) continue;   // 全是 0 → 跟 reset 一樣,無所謂
    for (const sel of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
      const target = sel.split(/\s+/).pop();
      const cls = (target.match(/\.([\w-]+)/) || [])[1];
      if (!cls || !RESET.has(tagOf[cls])) continue;
      checked.push(sel);
      const classLevel = (sel.match(/\.[\w-]+|:(?!:)[\w-]+|\[[^\]]+\]/g) || []).length;
      if (classLevel < 2) offenders.push(`${sel}(掛在 <${tagOf[cls]}>)`);
    }
  }
  assert.deepEqual(offenders, [], `這些 margin 會被 .ifm-v2 的 reset 歸零,選擇器要寫成 .rp .rp-xxx:\n${offenders.join('\n')}`);
  assert.ok(checked.length >= 2, `檢查到的規則太少(${checked.join(', ')}),這條測試可能失效了`);
  // 而且真的有設到:黑底標題條與說明文字之間要有距離(說明是左欄最後一個元素,下方 0)
  assert.match(rpCss(), /\.rp \.rp-lead\s*\{[^}]*margin:\s*\d+px 0 0/);
  // 大標與問題列之間的距離交給 grid 的 gap(h2 的 margin 一樣會被 .ifm-v2 h2 歸零)
  assert.match(rpCss(), /\.rp-top\s*\{[^}]*row-gap:/);
});

test('螢光底線與標題條比照 pf', () => {
  const css = rpCss();
  assert.match(css, /\.rp-hl\s*\{[^}]*background:\s*linear-gradient\(transparent 62%,\s*rgba\(195,213,67,\.55\) 62%\)/);
  assert.match(css, /\.rp-sol\s*\{[^}]*background:\s*#0E1A14/);
  assert.match(css, /\.rp-sol mark\s*\{[^}]*color:\s*#C3D543/);
  assert.match(css, /\.rp-no\s*\{[^}]*background:\s*#0B6B40/);
  // 跟 pf 分得出是兩件事:這區有自己的底色(pf 是淡綠漸層到白)
  assert.match(css, /\.rp\s*\{[^}]*background:\s*#EAF6F0/);
});

test('用到的 11 張圖都存在,規格照契約(不含文字、沒有 id/class/style)', () => {
  for (const [name, viewBox] of Object.entries(RP_IMAGES)) {
    const f = path.join(ROOT, 'assets', name + '.svg');
    assert.ok(fs.existsSync(f), `缺 assets/${name}.svg`);
    const svg = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(svg, /<text\b/, `${name}.svg 裡有 <text>(雙語網站,圖裡不能寫死文字)`);
    assert.doesNotMatch(svg, /\s(id|class|style)=/, `${name}.svg 不可以有 id/class/style`);
    assert.match(svg, new RegExp(`viewBox="${viewBox}"`), `${name}.svg 的 viewBox 應該是 ${viewBox}`);
  }
  // 版面上寫死的兩張大圖,width/height 要跟 viewBox 同比例(不然載入前後會跳版)
  assert.match(sec, /<img class="rp-chef" src="\/assets\/rp-chef\.svg" alt="" width="200" height="240"/);
  assert.match(sec, /<img class="rp-solution" src="\/assets\/rp-solution\.svg" alt="" width="560" height="360"/);
});

test('元件把文字跟圖靠 index 對齊:四個問題、五個功能各有自己的圖', () => {
  // 問題圖示 rp-problem-1..4、編號 01–04
  assert.match(component, /rpProblems: list\('rpProblems'\)\.map\(\(text, i\) => \(\{\s*no: NO_LABELS\[i\],\s*icon: `\/assets\/rp-problem-\$\{i \+ 1\}\.svg`,/);
  assert.ok(dict('zh').home.data.rpProblems.length <= 4, 'NO_LABELS 只有 01–04');
  // 功能圖示:常數陣列的順序 = 字典 rpFeatures 的順序
  const m = component.match(/const RP_FEATURE_ICONS = \[([^\]]*)\];/);
  assert.ok(m, '少了 const RP_FEATURE_ICONS');
  const keys = Array.from(m[1].matchAll(/'([^']*)'/g), (x) => x[1]);
  assert.deepEqual(keys, ['order', 'summary', 'tracking', 'history', 'reconcile']);
  assert.equal(keys.length, dict('zh').home.data.rpFeatures.length);
  for (const k of keys) assert.ok(`rp-feat-${k}` in RP_IMAGES);
  assert.match(component, /rpFeatures: list\('rpFeatures'\)\.map\(\(label, i\) => \(\{\s*label,\s*icon: '\/assets\/rp-feat-' \+ RP_FEATURE_ICONS\[i\] \+ '\.svg',/);
});
