const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../i18n.js');
const { bindingKeys, rawSource, renderMarkup } = require('./helpers/render.cjs');

const {
  DEFAULT_LANG, LANGS, STORAGE_KEY, HINT_DISMISSED_KEY,
  detect, dict, dismissHint, hintDismissed, storeLang, storedLang, suggestLang,
} = i18n;

const CJK = /[\u4e00-\u9fff]/;

// index.html 的三段:markup(<x-dc>)、元件 script、其餘 script。
// 綁定只出現在 markup;文案以外的東西(圖片路徑、編號、日期)留在元件 script。
const markupStart = rawSource.indexOf('<x-dc>');
const markupEnd = rawSource.indexOf('</x-dc>');
const markup = rawSource.slice(markupStart, markupEnd);
const componentStart = rawSource.indexOf('<script type="text/x-dc" data-dc-script>');
const component = rawSource.slice(componentStart, rawSource.indexOf('</script>', componentStart));

function lookup(values, keyPath) {
  return keyPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), values);
}

// 把字典攤平成「每個節點的形狀」:物件記 key 清單、陣列記長度、葉子記型別。
// 少一個 key、多一個 key、陣列長度不同、字串變成物件 —— 四種都會讓兩邊的 shape 不一樣。
function shape(node, prefix, out) {
  if (Array.isArray(node)) {
    out.set(prefix, `array(${node.length})`);
    node.forEach((item, index) => shape(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    out.set(prefix, `object(${Object.keys(node).sort().join('|')})`);
    for (const key of Object.keys(node)) shape(node[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  out.set(prefix, typeof node);
  return out;
}

function constArray(name) {
  const match = component.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `missing const ${name} in component script`);
  return Array.from(match[1].matchAll(/'([^']*)'/g), (m) => m[1]);
}

function fakeWindow(options = {}) {
  const store = new Map();
  if (options.stored !== undefined) store.set(STORAGE_KEY, options.stored);
  const localStorage = options.storageThrows
    ? {
      getItem() { throw new Error('SecurityError: localStorage is not available'); },
      setItem() { throw new Error('SecurityError: localStorage is not available'); },
    }
    : {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    };
  return {
    localStorage,
    navigator: { languages: options.languages, language: options.language },
    _store: store,
  };
}

test('zh and en dictionaries have exactly the same key structure', () => {
  // 少一個 key 的症狀:畫面上那行字直接消失(support.js 只 console.warn),非常難發現
  const zh = shape(dict('zh'), '', new Map());
  const en = shape(dict('en'), '', new Map());

  const onlyZh = [...zh.keys()].filter((key) => !en.has(key));
  const onlyEn = [...en.keys()].filter((key) => !zh.has(key));
  assert.deepEqual(onlyZh, [], `en 少了這些 key: ${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `zh 少了這些 key: ${onlyEn.join(', ')}`);

  const mismatched = [...zh.keys()].filter((key) => zh.get(key) !== en.get(key));
  assert.deepEqual(
    mismatched.map((key) => `${key}: zh=${zh.get(key)} en=${en.get(key)}`),
    [],
  );
});

test('the key-structure guard actually fails when a key is dropped or an array shrinks', () => {
  const base = { nav: { cta: 'x' }, home: { data: { flow: [{ title: 'a' }, { title: 'b' }] } } };
  const missingKey = { nav: {}, home: { data: { flow: [{ title: 'a' }, { title: 'b' }] } } };
  const shortArray = { nav: { cta: 'x' }, home: { data: { flow: [{ title: 'a' }] } } };

  const shapeOf = (node) => shape(node, '', new Map());
  const diff = (a, b) => {
    const left = shapeOf(a);
    const right = shapeOf(b);
    return [...new Set([...left.keys(), ...right.keys()])]
      .filter((key) => left.get(key) !== right.get(key));
  };

  assert.deepEqual(diff(base, base), []);
  assert.notDeepEqual(diff(base, missingKey), []);
  assert.notDeepEqual(diff(base, shortArray), []);
});

test('every {{ L.* }} binding in index.html resolves to a string in both languages', () => {
  const keys = bindingKeys();
  // 這條只是「掃描器沒壞」的地板,不是文案數量的規格 —— 版面改版會讓 key 數上下跑
  // (例如 2026-09-23 拿掉八張假表格就少了 120 個)。真正有意義的是下面兩件事:
  // 每個 key 在兩個語系都查得到字串,而且每個區段都有被掃到。
  assert.ok(keys.length > 150, `binding 掃描器可能壞了,只找到 ${keys.length} 個 key`);
  const sections = new Set(keys.map((k) => k.split('.')[0]));
  for (const section of ['nav', 'home', 'rest', 'sup', 'cases', 'about', 'contact', 'footer']) {
    assert.ok(sections.has(section), `markup 裡完全沒有 L.${section}.* 的綁定,某個區段可能整塊掉了`);
  }

  for (const lang of LANGS) {
    const values = dict(lang);
    const broken = keys.filter((key) => typeof lookup(values, key) !== 'string');
    assert.deepEqual(broken, [], `dict('${lang}') 查不到字串: ${broken.join(', ')}`);
  }

  // markup 綁定不准是空字串 —— 空的就是畫面上那行字消失了。
  // (標題輪播那三句的 pre/post 允許空,但它們住在 home.data.*,由 JS 取用不是 markup 綁定,
  //  不在 keys 裡。那一組的檢查在「home data arrays」那條。)
  const emptyInZh = keys.filter((key) => lookup(dict('zh'), key) === '');
  assert.deepEqual(emptyInZh, [], `這些綁定在中文版是空字串,畫面上會直接不見:${emptyInZh.join(', ')}`);
});

test('rendering index.html in English leaves no Chinese in the markup', () => {
  const start = renderMarkup('en').indexOf('<x-dc>');
  const end = renderMarkup('en').indexOf('</x-dc>');
  let rendered = renderMarkup('en').slice(start, end);

  // 這些不是使用者看得到的文案,逐一排除(每一條都說明為什麼):
  // 1. HTML 註解 —— 給維護者看的,故意留中文
  rendered = rendered.replace(/<!--[\s\S]*?-->/g, '');
  // 2. CSS 註解 —— 同上(CSS 的 content: 值沒有被排除,真有中文仍然會被抓到)
  rendered = rendered.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (block) => block.replace(/\/\*[\s\S]*?\*\//g, ''));
  // 3. data-screen-label —— 設計稿工具用的頁面代號,不會渲染成文字
  rendered = rendered.replace(/ data-screen-label="[^"]*"/g, '');
  // 4. bundler 縮圖樣板裡的「食」是品牌字標,不翻
  rendered = rendered.replace(/<template id="__bundler_thumbnail">[\s\S]*?<\/template>/g, '');
  // 5. <helmet> 裡的 meta 是靜態中文預設值,開頁時由 syncSeo() 依語系換掉。
  //    只放行「確定會被換掉」的那幾個 —— 新增一個沒被 syncSeo 接手的中文 meta 仍然會紅。
  const syncSeoStart = component.indexOf('syncSeo() {');
  const syncSeo = component.slice(syncSeoStart, component.indexOf('\n  }', syncSeoStart));
  assert.ok(syncSeoStart > 0, 'component must define syncSeo()');
  rendered = rendered.replace(/<meta (name|property)="([^"]+)" content="[^"]*">/g, (whole, kind, key) => (
    syncSeo.includes(`meta[${kind}="${key}"]`) ? '' : whole
  ));

  const leftovers = rendered.split('\n').map((line) => line.trim()).filter((line) => CJK.test(line));
  assert.deepEqual(leftovers, [], `英文版殘留中文:\n${leftovers.join('\n')}`);
});

test('English SEO metadata is translated for every page, not just the markup', () => {
  // <title> 與 description 不在 markup 綁定裡(靜態 head + helmet 的中文預設值),
  // 全靠 syncSeo() 換。字典裡沒有英文版的話,英文頁的分頁標題會一路是中文。
  const en = dict('en').meta;
  assert.ok(en && en.pages, 'en dict must carry meta.pages');
  for (const page of ['home', 'restaurants', 'suppliers', 'cases', 'about', 'contact', 'news', 'qa', 'legal']) {
    assert.ok(en.pages[page], `missing en meta for ${page}`);
    assert.doesNotMatch(en.pages[page].title, CJK, `${page} title still Chinese`);
    assert.doesNotMatch(en.pages[page].description, CJK, `${page} description still Chinese`);
  }
  assert.doesNotMatch(en.keywords, CJK);
  assert.doesNotMatch(en.siteName, CJK);
  assert.match(component, /document\.title = page\.title/);
});

test('home data arrays match the counts the component renders', () => {
  // 長度對不上的症狀:首頁少一格或多一格空白卡片
  const expected = {
    rotating: 3,   // 三句完整標題,每句是 { pre, hl, post }
    hotTags: 6,
    heroPromises: 3,
    stats: 4,
    audiences: 4,
    flow: 6,
    categories: 12,
    testimonials: 3,
    trust: 3,
    // articlesTop 已經移除 —— 首頁文章區改吃 news.js 的真實文章
  };
  for (const lang of LANGS) {
    const data = dict(lang).home.data;
    for (const [key, count] of Object.entries(expected)) {
      assert.ok(Array.isArray(data[key]), `dict('${lang}').home.data.${key} must be an array`);
      assert.equal(data[key].length, count, `dict('${lang}').home.data.${key}`);
    }
  }

  // 輪播標題是物件不是字串:三段都要在、hl(綠色強調)不可為空,
  // 而且兩個語系的每一句都要能拼回完整的一行字
  for (const lang of LANGS) {
    for (const r of dict(lang).home.data.rotating) {
      for (const part of ['pre', 'hl', 'post']) {
        assert.equal(typeof r[part], 'string', `${lang} rotating 缺少 ${part}:${JSON.stringify(r)}`);
      }
      assert.ok(r.hl.trim(), `${lang} rotating 的強調段是空的:${JSON.stringify(r)}`);
      assert.ok((r.pre + r.hl + r.post).trim().length > 4, `${lang} rotating 太短:${JSON.stringify(r)}`);
    }
  }

  // 元件用 index 去對齊字典,所以常數陣列必須等長
  const data = dict('zh').home.data;
  assert.equal(constArray('FLOW_IMGS').length, data.flow.length);
  assert.equal(constArray('CATEGORY_IMGS').length, data.categories.length);
  // NO_LABELS 是編號 01–04,audiences 與 trust 共用(trust 只取前三個)
  assert.equal(constArray('NO_LABELS').length, data.audiences.length);
  assert.ok(constArray('NO_LABELS').length >= data.trust.length);

  // stats 的數字目標仍在元件裡,一樣靠 index 對上 data.stats 的標籤
  const statsBlock = component.slice(component.indexOf('stats: ['), component.indexOf('].map((s, i)'));
  assert.equal((statsBlock.match(/\{ (?:target|text):/g) || []).length, data.stats.length);
});

test('detect() prefers the stored choice, then the browser, then Chinese', () => {
  assert.equal(detect(fakeWindow({ language: 'zh-TW' })), 'zh');
  assert.equal(detect(fakeWindow({ language: 'zh-Hant-TW' })), 'zh');
  assert.equal(detect(fakeWindow({ language: 'en-US' })), 'en');
  assert.equal(detect(fakeWindow({ languages: ['en-GB', 'en'], language: 'en-GB' })), 'en');
  // 只有日文 —— 認不得就落回預設語系,不能回 null 讓畫面空掉
  assert.equal(detect(fakeWindow({ languages: ['ja'], language: 'ja' })), DEFAULT_LANG);
  assert.equal(DEFAULT_LANG, 'zh');
  // 按過語言鈕就聽他的,壓過瀏覽器語系(兩個方向都測)
  assert.equal(detect(fakeWindow({ stored: 'en', language: 'zh-TW' })), 'en');
  assert.equal(detect(fakeWindow({ stored: 'zh', languages: ['en-US'], language: 'en-US' })), 'zh');
  // localStorage 裡是垃圾值就當作沒存過
  assert.equal(detect(fakeWindow({ stored: 'ja', language: 'en-US' })), 'en');
  // 完全沒有 navigator 也不能爆
  assert.equal(detect({}), DEFAULT_LANG);
});

test('detect() survives a localStorage that throws (private browsing)', () => {
  const win = fakeWindow({ storageThrows: true, language: 'en-US' });
  assert.equal(detect(win), 'en');
  assert.equal(detect(fakeWindow({ storageThrows: true, language: 'ja' })), DEFAULT_LANG);
  // 寫入失敗要回 false,不是丟例外 —— 切語系的流程不能因此中斷
  assert.equal(storeLang(win, 'en'), false);

  const writable = fakeWindow();
  assert.equal(storeLang(writable, 'en'), true);
  assert.equal(writable._store.get(STORAGE_KEY), 'en');
  assert.equal(storeLang(writable, 'ja'), false);
});

test('suggestLang() nudges only on the two home pages, only people who have not chosen, never toward the page language', () => {
  const en = { languages: ['en-US', 'en'], language: 'en-US' };
  const zh = { languages: ['zh-TW', 'zh'], language: 'zh-TW' };

  // 英文瀏覽器開中文首頁 → 建議英文;中文瀏覽器開英文首頁 → 建議中文
  assert.equal(suggestLang(fakeWindow(en), 'home', 'zh'), 'en');
  assert.equal(suggestLang(fakeWindow(zh), 'home', 'en'), 'zh');
  // 瀏覽器語系跟頁面相同 → 什麼都不做
  assert.equal(suggestLang(fakeWindow(en), 'home', 'en'), null);
  assert.equal(suggestLang(fakeWindow(zh), 'home', 'zh'), null);
  // 認不得的瀏覽器語系(只有日文)→ 沒有日文版可以給,不建議
  assert.equal(suggestLang(fakeWindow({ languages: ['ja'], language: 'ja' }), 'home', 'zh'), null);
  // 深層頁不出現:那多半是從搜尋結果或分享連結進來的,人已經在看他要的東西
  for (const page of ['restaurants', 'suppliers', 'cases', 'about', 'contact', 'news', 'article', 'qa', 'legal']) {
    assert.equal(suggestLang(fakeWindow(en), page, 'zh'), null, page);
    assert.equal(suggestLang(fakeWindow(zh), page, 'en'), null, page);
  }
  // 按過語言鈕(不管選了哪個)→ 他已經知道語言鈕在哪,不再建議
  assert.equal(suggestLang(fakeWindow({ ...en, stored: 'zh' }), 'home', 'zh'), null);
  assert.equal(suggestLang(fakeWindow({ ...en, stored: 'en' }), 'home', 'zh'), null);
  // 關過提示條 → 不再建議
  const dismissed = fakeWindow(en);
  dismissed._store.set(HINT_DISMISSED_KEY, '1');
  assert.equal(suggestLang(dismissed, 'home', 'zh'), null);
  // localStorage 會 throw(無痕)→ 當作沒存過、沒關過;關閉只能記在記憶體裡(元件的 langHintOff)
  assert.equal(suggestLang(fakeWindow({ ...en, storageThrows: true }), 'home', 'zh'), 'en');
  // 頁面語系認不得、沒有 navigator 都不能爆
  assert.equal(suggestLang(fakeWindow(en), 'home', 'ja'), null);
  assert.equal(suggestLang({}, 'home', 'zh'), null);
});

test('dismissing the hint is remembered under its own key and never counts as picking a language', () => {
  const win = fakeWindow({ languages: ['en-US'], language: 'en-US' });
  assert.equal(hintDismissed(win), false);
  assert.equal(dismissHint(win), true);
  assert.equal(hintDismissed(win), true);
  // 另開一個 key:關掉提示條 ≠ 選了中文,也 ≠ 選了英文。混用的話,英文訪客按 × 會被記成
  // 「選了某個語系」,之後裸網址 / 的落地就錯了。
  assert.notEqual(HINT_DISMISSED_KEY, STORAGE_KEY);
  assert.equal(win._store.has(STORAGE_KEY), false);
  assert.equal(storedLang(win), null);
  assert.equal(detect(win), 'en');
  // 讀寫失敗(無痕)要回 false,不是丟例外 —— 按 × 的流程不能因此中斷
  assert.equal(dismissHint(fakeWindow({ storageThrows: true })), false);
  assert.equal(hintDismissed(fakeWindow({ storageThrows: true })), false);
});

test('the language hint is written in the language it suggests', () => {
  // 提示條是給「看不懂這一頁」的人看的:中文頁上的提示條用英文寫、英文頁上的用中文寫。
  // 元件取的是 dict(建議的語系).langHint,所以 en 字典這組必須是英文、zh 字典這組必須是中文 ——
  // 放反了,英文訪客會在中文頁上看到一句中文的「要不要切英文?」,等於沒放。
  const enHint = dict('en').langHint;
  const zhHint = dict('zh').langHint;
  const keys = ['regionLabel', 'message', 'switchLabel', 'dismissLabel'];
  assert.deepEqual(Object.keys(enHint).sort(), [...keys].sort());
  for (const key of keys) {
    assert.equal(typeof enHint[key], 'string', `en.langHint.${key}`);
    assert.ok(enHint[key].trim(), `en.langHint.${key} is empty`);
    assert.doesNotMatch(enHint[key], CJK, `en.langHint.${key} must be English`);
    assert.match(zhHint[key], CJK, `zh.langHint.${key} must be Chinese`);
  }
});

test('assets and support.js are root-absolute so /en/ pages load the same files', () => {
  // 相對路徑在 /en/suppliers 之下 base 會變成 /en/,./support.js 會去要 /en/support.js
  // 然後 404 —— 整個框架不載入、頁面全白。2026-09-22 線上實際踩過。
  for (const script of ['i18n.js', 'routing.js', 'news.js', 'legal.js', 'support.js']) {
    assert.match(rawSource, new RegExp(`<script src="/${script.replace('.', '\\.')}"></script>`));
  }
  // ./x、../x、裸檔名 x.js 一律不行
  assert.doesNotMatch(rawSource, /(?:src|href)="\.{1,2}\//);
  assert.doesNotMatch(rawSource, /(?:src|href)="[A-Za-z0-9_-]+\.(?:js|css|png|svg|ico)"/);

  const assetRefs = Array.from(rawSource.matchAll(/['"(]([^'"()\s]*assets\/[^'"()\s]+)['")]/g), (m) => m[1]);
  assert.ok(assetRefs.length >= 21, `expected the asset paths to be found, got ${assetRefs.length}`);
  for (const ref of assetRefs) assert.match(ref, /^\/assets\//, `asset path must be root-absolute: ${ref}`);

  // 其他本機檔案(logo、icon、favicon)同理
  const localRefs = Array.from(rawSource.matchAll(/(?:src|href)="([^"]+\.(?:png|ico|svg|js|css))"/g), (m) => m[1])
    .filter((ref) => !/^https?:/.test(ref));
  for (const ref of localRefs) assert.match(ref, /^\//, `local asset must be root-absolute: ${ref}`);
});

test('internal links are language-aware bindings, never hard-coded paths', () => {
  // 寫死 href="/restaurants" 的話,英文頁上右鍵開新分頁會跳回中文站
  const internal = Array.from(markup.matchAll(/<a[^>]+href="([^"]*)"/g), (m) => m[1])
    .filter((href) => !/^https?:|^mailto:|^tel:|^#/.test(href));
  assert.ok(internal.length > 20, `expected internal links in the markup, found ${internal.length}`);
  for (const href of internal) {
    assert.match(
      href,
      // a.href 是文章列表在 sc-for 裡逐篇算出來的網址(已經帶語系前綴),
      // 跟 hrefXxx 一樣是綁定,不是寫死的路徑。
      // q.linkHref 是常見問題答案裡的連結(字典裡是完整的 https:// 網址,或 renderVals() 會換掉的
      // {supplierApplicationUrl} 這類產品站網址佔位符,見 tests/faq.test.cjs);
      // 它會落進這條檢查只是因為 markup 上寫的是綁定而不是字面網址,不是寫死的內部路徑。
      // d.href 是法律文件在 sc-for 裡逐份算出來的網址(pageToPath 產的,已帶語系前綴);
      // t.href 是同一頁目錄的 #錨點,不跨頁也不跨語系。
      // marketUrl 跟 loginUrl 一樣是產品站的網址(產品站沒有語系前綴,中英兩版都連到同一個 /market)。
      /^\{\{ (href[A-Za-z]*|langHref|loginUrl|restaurantRegistrationUrl|supplierApplicationUrl|marketUrl|a\.href|lk\.href|q\.linkHref|d\.href|t\.href) \}\}$/,
      `internal link must be a binding, got ${href}`,
    );
  }
});
