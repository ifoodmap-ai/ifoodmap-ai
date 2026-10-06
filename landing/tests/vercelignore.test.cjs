const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// landing/.vercelignore:部署產物裡不要出現的東西(文件、測試、建置腳本、舊版離線檔)。
// 2026-10-07 之前沒有這個檔,正式站 /tests/*.test.cjs、/scripts/*.mjs、/supabase_schema.sql 都是公開的 200。
// 這支測試把排除清單釘住,並確認網站要用的檔一個都沒被排除。
//
// 為什麼 .vercelignore 在 CI 上有效(已對照 Vercel CLI 54.4.1 原始碼,並離線照 CI 步驟跑過 vercel build):
//   landing-deploy.yml 在 landing/ 裡跑 `vercel build` 再 `vercel deploy --prebuilt`。
//   vercel build 用 staticFiles(workPath) → getVercelIgnore(workPath)(內建清單 + .vercelignore)收集來源檔,
//   合併 static 輸出時再用同一個 filter 清一次;deploy --prebuilt 只上傳 .vercel/output。

const ROOT = path.join(__dirname, '..');
const RULES_FILE = path.join(ROOT, '.vercelignore');
const rules = fs.readFileSync(RULES_FILE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

// 要排除的清單(業主 / 指揮官 2026-10-07 核定)。改這份清單 = 改部署產物,請連同理由一起改。
const EXCLUDED = [
  'tests', 'scripts', 'docs',
  'DEPLOY.md', 'README.md', 'supabase_schema.sql', '.env.example', '.claude',
  'standalone.html',   // 只有 README / DEPLOY.md 提到它(舊版離線視覺基準),站上沒有任何地方連到它
  '.vercelignore',     // 它自己也是 dotfile,不排除的話會被當成 /.vercelignore 公開
];

// 網站要用的頂層檔案 / 目錄:一個都不准被排除
const SITE = [
  'index.html', 'i18n.js', 'support.js', 'routing.js', 'legal.js', 'news.js',
  'api', 'assets', 'vercel.json', 'package.json',
  'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'icon.png', 'logo.png',
  'og-image.png', 'og-image-en.png',
];
// 預渲染(CI 在 vercel build 之前跑 prerender.mjs --in-place)產生在根目錄的東西:測試時還不存在,但同樣不准被排除
const PRERENDERED = [
  'dc-template.js', 'robots.txt', 'sitemap.xml', 'llms.txt',
  'restaurants.html', 'suppliers.html', 'cases.html', 'about.html', 'contact.html', 'news.html', 'qa.html', 'legal.html',
  'en.html', 'en', 'news', 'legal',
];
// 只存在本機、不會進 git(也就不會出現在 CI 的 checkout)的東西
const LOCAL_ONLY = new Set(['.git', 'node_modules', '.vercel', 'dist', 'build', '.worktrees', '.DS_Store', '.gitignore']);

// 規則一律是「錨定在根目錄的字面路徑」,所以比對就是:等於它,或在它底下
const excluded = new Set(rules.map((rule) => rule.slice(1)));
const isExcluded = (rel) => [...excluded].some((name) => rel === name || rel.startsWith(`${name}/`));

test('.vercelignore 的規則全是「/ 開頭、沒有萬用字元、沒有 !」的單一路徑(這支測試的比對才準)', () => {
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.match(rule, /^\/[A-Za-z0-9._-]+$/, `規則要寫成錨定的字面路徑:${rule}`);
  }
  assert.equal(new Set(rules).size, rules.length, '有重複的規則');
});

test('排除清單一字不差:文件、測試、建置腳本、舊版離線檔都不進部署產物', () => {
  assert.deepEqual([...excluded].sort(), [...EXCLUDED].sort());
  for (const rel of ['tests/content.test.cjs', 'tests/helpers/render.cjs', 'scripts/prerender.mjs', 'scripts/serve-like-vercel.py',
    'docs/I18N.md', 'DEPLOY.md', 'README.md', 'supabase_schema.sql', '.env.example', '.claude/launch.json', 'standalone.html']) {
    assert.ok(isExcluded(rel), `${rel} 應該被排除`);
  }
});

test('網站要用的檔(含預渲染產出、api、assets)一個都沒被排除', () => {
  for (const name of [...SITE, ...PRERENDERED]) {
    assert.equal(isExcluded(name), false, `${name} 是網站要用的,不可以排除`);
  }
  for (const rel of ['api/ai-chat.js', 'api/ai-extract.js', 'api/ai-menu.js', 'api/_ai-proxy.js', 'en/restaurants.html', 'news/some-slug.html', 'legal/terms.html']) {
    assert.equal(isExcluded(rel), false, rel);
  }
  // 實際存在的檔:assets/ 與 api/ 底下每一個都還在部署範圍內
  for (const dir of ['assets', 'api']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      assert.equal(isExcluded(`${dir}/${file}`), false, `${dir}/${file}`);
    }
  }
});

test('landing/ 根目錄每一個東西都已分類(要嘛公開、要嘛排除):新加的檔不會默默變成公開', () => {
  const known = new Set([...SITE, ...PRERENDERED, ...EXCLUDED]);
  const unclassified = fs.readdirSync(ROOT).filter((name) => (
    !known.has(name) && !LOCAL_ONLY.has(name) && !(name.startsWith('.env') && name !== '.env.example')
  ));
  assert.deepEqual(unclassified, [],
    `這些檔會原樣公開在正式站上,請決定:要公開就加進本測試的 SITE,不要就加進 .vercelignore 與 EXCLUDED:${unclassified.join(', ')}`);
});

test('standalone.html 可以排除的前提:網站本身(頁面、執行期 js、vercel.json、sitemap / robots / llms 的產生器)沒有連到它', () => {
  const served = ['index.html', 'i18n.js', 'support.js', 'routing.js', 'legal.js', 'news.js', 'vercel.json', 'scripts/seo-files.mjs', 'scripts/seo-head.mjs'];
  for (const rel of served) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /standalone\.html/, `${rel} 連到了 standalone.html —— 要嘛移掉連結,要嘛把它從 .vercelignore 拿掉`);
  }
});

test('排除生效的前提:部署走 landing/ 裡的 vercel build + vercel deploy --prebuilt', () => {
  const wf = fs.readFileSync(path.join(ROOT, '..', '.github/workflows/landing-deploy.yml'), 'utf8');
  assert.match(wf, /defaults:\s*\n\s*run:\s*\n\s*working-directory: landing\s*\n/, '要在 landing/ 裡跑,讀到的才是 landing/.vercelignore');
  assert.match(wf, /run: vercel build --prod /);
  assert.match(wf, /run: vercel deploy --prebuilt --prod /);
  // 預渲染在 vercel build 之前(它要用 scripts/,而 scripts/ 被排除在部署產物外)
  assert.ok(wf.indexOf('node scripts/prerender.mjs --in-place') < wf.indexOf('vercel build --prod'));
});
