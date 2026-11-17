const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { dict, format } = require('../i18n.js');
const { rawSource, renderMarkup } = require('./helpers/render.cjs');

// 右下角 AI 採購助手(index.html 最後那支 inline script)的防濫用與註冊導流。
// 契約:「形象站 AI 防濫用＋註冊導流」SPEC §2(錯誤碼)、§4(stage)、§5(analysisId / claimToken)、§7(交接網址),
// 以及修訂 2 的 R1(照片併進同一筆)、R4(Email 規則統一)、R10(widget 補強)—— 檔尾那幾條。
//
// 兩種測法:
//   ① 「AI-PURE」那一段純函式原封不動抽出來,丟進 node:vm 實際呼叫 —— 判斷邏輯是真的跑過,不是只比字串。
//   ② 接 DOM 的那一半用靜態斷言釘住結構(這支 widget 活在 React 外面、沒有 DOM 測試環境)。
//      真實瀏覽器裡的整段流程另外跑過一次(對話 / 429 / done / 註冊網址 / 留 Email / 第 21 則 / 第 4 張照片)。

const CJK = /[一-鿿]/;
const widgetStart = rawSource.indexOf('<!-- ============ 右下角 AI 採購助手 Widget');
const widget = rawSource.slice(widgetStart, rawSource.lastIndexOf('</script>'));
const homeZh = (() => {
  const zh = renderMarkup('zh');
  return zh.slice(zh.indexOf('<!-- ============ PAGE: HOME ============ -->'), zh.indexOf('<!-- ============ PAGE: RESTAURANTS ============ -->'));
})();

const PURE_BEGIN = '/* ==== AI-PURE:BEGIN ====';
const PURE_END = '/* ==== AI-PURE:END ==== */';
const pureSource = widget.slice(widget.indexOf(PURE_BEGIN), widget.indexOf(PURE_END));
const PURE_NAMES = [
  'AI_LIMITS', 'QUOTA_CODES', 'classifyFailure', 'parseChatData', 'handoffUrl', 'validEmail', 'isLeadRateLimited',
  'parseLeadContact', 'chatMessages', 'userTextCount', 'saveMessages', 'shouldSaveOnLeave', 'dataUrlBytes', 'analysisNote', 'leadRow', 'nextPair',
  'cooldownSeconds', 'pairFields', 'mergeIngredients', 'menuOutcome', 'exitNeedsSave',
];
// vm 裡沒有 window / document:純函式一旦偷碰 DOM,這裡就會直接 ReferenceError
const ai = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(`${pureSource}\n;globalThis.__ai = { ${PURE_NAMES.join(', ')} };`, ctx);
  return ctx.__ai;
})();
// vm 裡建的物件原型屬於另一個 realm,deepStrictEqual 會因此不相等 —— 比較前先轉成普通 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));

// 只看某個函式本體(從宣告到下一個同層的 function)。切不到就讓測試直接失敗,不要默默變空字串。
function fnBody(name) {
  const start = widget.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `widget 裡找不到 function ${name}`);
  const next = widget.indexOf('\n  function ', start + 10);
  return widget.slice(start, next > 0 ? next : undefined);
}

test('AI-PURE 區段存在而且真的只有純函式(vm 裡沒有 DOM 也跑得起來)', () => {
  assert.ok(widget.indexOf(PURE_BEGIN) > 0 && widget.indexOf(PURE_END) > widget.indexOf(PURE_BEGIN));
  for (const name of PURE_NAMES) assert.ok(ai[name] !== undefined, `AI-PURE 裡少了 ${name}`);
  assert.doesNotMatch(pureSource, /\b(?:document|window|navigator|localStorage|fetch)\b[.(]/);
});

// ── 1. maxlength ─────────────────────────────────────────────────────────────
test('1. 聊天輸入框 maxlength 300、首頁搜尋列 maxLength 280(加上前綴後仍在 300 以內)', () => {
  assert.equal(ai.AI_LIMITS.maxInputChars, 300);
  assert.match(widget, /<input id="ai-assistant-input" type="text" class="ai-text" maxlength="300"/);
  // 首頁搜尋列在 <x-dc> 模板裡:support.js 只把 camelCase 屬性轉成 React 的 maxLength
  assert.match(homeZh, /<input name="q" class="mc-searchinput"[^>]* maxLength="280"/);
  for (const lang of ['zh', 'en']) {
    const prefix = dict(lang).home.data.askPrefix;
    assert.ok(prefix.length + 280 <= ai.AI_LIMITS.maxInputChars, `${lang} 前綴「${prefix}」+ 280 字超過 300`);
  }
  // maxlength 擋不住程式塞進來的字(IfmAI.ask)—— sendText 自己再守一次,而且不會打 API
  const send = fnBody('sendText');
  assert.match(send, /if \(v\.length > AI_LIMITS\.maxInputChars\) \{ addMsg\('bot', txtf\('tooLong'/);
  assert.ok(send.indexOf('v.length > AI_LIMITS.maxInputChars') < send.indexOf("postJSON('/api/ai-chat'"));
});

// ── 2. 忙碌鎖 ────────────────────────────────────────────────────────────────
test('2. 忙碌鎖:同時只有一個 AI 請求;忙碌時送出鈕 aria-disabled、Enter 不送', () => {
  assert.match(widget, /var aiBusy = false;/);
  const send = fnBody('sendText');
  assert.match(send, /^function sendText\(\) \{\s*if \(aiBusy \|\| registering\) return;/);
  assert.ok(send.indexOf('setBusy(true);') >= 0 && send.indexOf('setBusy(true);') < send.indexOf("postJSON('/api/ai-chat'"));
  // 回應(成功或失敗)之後才解鎖,而且解鎖時才輪到排隊的照片
  assert.match(send, /\.then\(releaseAfterText, releaseAfterText\);/);
  assert.match(fnBody('releaseAfterText'), /setBusy\(false\); pumpImages\(\);/);
  // 菜單也走同一把鎖
  const pump = fnBody('pumpImages');
  assert.match(pump, /if \(aiBusy \|\| registering \|\| locked \|\| !imageQueue\.length\) return;/);
  assert.ok(pump.indexOf('setBusy(true);') < pump.indexOf("postJSON('/api/ai-menu'"));
  // 送出鈕:aria-disabled(不是 disabled,焦點才不會被踢出去)
  const sync = fnBody('syncComposer');
  assert.match(sync, /toggleOff\(sendBtn, aiBusy \|\| registering \|\| aiClosed\);/);
  assert.match(fnBody('toggleOff'), /el\.setAttribute\('aria-disabled', 'true'\)/);
  assert.match(fnBody('setBusy'), /aiBusy = on; syncComposer\(\);/);
  // Enter:忙碌時不送;中文輸入法選字的 Enter 也不是送出
  assert.match(widget, /textInput\.addEventListener\('keydown', function \(e\) \{\s*if \(e\.key !== 'Enter'\) return;\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return;[^\n]*\n\s*e\.preventDefault\(\);\s*if \(aiBusy\) return;[^\n]*\n\s*sendText\(\);/);
  // 舊寫法(每按一次 Enter 就無條件 sendText)不可以回來
  assert.doesNotMatch(widget, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); sendText\(\); \}/);
  // 送聯絡表單期間也上鎖,連按兩下不會寫出兩筆 lead
  assert.match(fnBody('saveLead'), /setBusy\(true\);/);
});

// ── 3. 照片 ──────────────────────────────────────────────────────────────────
test('3. 照片一張一張處理、每段對話最多 3 張(超過請他註冊)、非圖片直接拒絕', () => {
  assert.equal(ai.AI_LIMITS.maxImages, 3);
  const accept = fnBody('acceptImages');
  // 非圖片:型別不是 image/ 開頭(含空字串)就不收
  assert.match(accept, /if \(f && typeof f\.type === 'string' && f\.type\.indexOf\('image\/'\) === 0\) images\.push\(f\);/);
  assert.match(accept, /if \(!images\.length\) \{ if \(files\.length\) addMsg\('bot', txt\(notImageKey\)\); return; \}/);
  // 上限:已用 + 排隊中;超過的那幾張給「註冊後可以上傳更多」+ CTA
  assert.match(accept, /var room = AI_LIMITS\.maxImages - imagesUsed - imageQueue\.length;/);
  assert.match(accept, /if \(images\.length > room\) \{\s*addMsg\('bot', txtf\('uploadLimit', \{ max: AI_LIMITS\.maxImages \}\)\);\s*showCTA\(\);/);
  assert.match(dict('zh').ai.uploadLimit, /註冊後可以上傳更多/);
  // 依序:只從佇列拿一張,處理完(成功或失敗)才 pump 下一張;不再有「多張並行送出」的迴圈
  const pump = fnBody('pumpImages');
  assert.match(pump, /var f = imageQueue\.shift\(\);/);
  assert.match(pump, /\.then\(release, release\);/);
  assert.match(pump, /function release\(\) \{\s*if \(!analysed\) imagesUsed--;[^\n]*\n\s*setBusy\(false\);\s*pumpImages\(\);/);
  assert.equal((widget.match(/postJSON\('\/api\/ai-menu'/g) || []).length, 1);
  assert.doesNotMatch(widget, /for \([^)]*\) \{\s*if \(files\[i\]\.type\.indexOf\('image\/'\) === 0\) \{ handleImageFile/);
  // 選檔與拖曳都走同一個入口
  assert.match(widget, /if \(f\) acceptImages\(\[f\], 'uploadImageOnly'\);/);
  assert.match(widget, /acceptImages\(list, 'dropImageOnly'\);/);
  // 送出的 body 只有白名單內的欄位(SPEC §8 analyze-menu:image / mimeType / lang;修訂 2 R1 再加 analysisId / claimToken)
  assert.match(widget, /var pair = pairFields\(conv\);\s*return postJSON\('\/api\/ai-menu', \{ image: dataUrl, mimeType: 'image\/jpeg', lang: curLang\(\), analysisId: pair\.analysisId, claimToken: pair\.claimToken \}\)/);
});

test('3b. 照片壓到後端上限以內:解碼後位元組數算對、太大就一階一階縮', () => {
  assert.equal(ai.dataUrlBytes('data:image/jpeg;base64,' + Buffer.from('hello world').toString('base64')), 11);
  assert.equal(ai.dataUrlBytes('data:image/png;base64,' + Buffer.alloc(1000).toString('base64')), 1000);
  assert.equal(ai.dataUrlBytes(Buffer.alloc(2).toString('base64')), 2);
  assert.equal(ai.dataUrlBytes(''), 0);
  assert.ok(ai.AI_LIMITS.imageMaxBytes < 1.5 * 1000 * 1000, '要比後端的 1.5 MB 小');
  const down = fnBody('downscale');
  assert.match(down, /var steps = \[\[1600, 0\.82\], \[1280, 0\.75\], \[1024, 0\.7\]\];/);
  assert.match(down, /if \(dataUrlBytes\(out\) <= AI_LIMITS\.imageMaxBytes\) break;/);
  // 透明 PNG 轉 JPEG 會變全黑 —— 先鋪白底
  assert.match(fnBody('encodeJpeg'), /ctx\.fillStyle = '#fff'; ctx\.fillRect\(0, 0, w, h\);\s*ctx\.drawImage/);
});

// ── 4. 每段對話 20 則 ────────────────────────────────────────────────────────
test('4. 送滿 20 則使用者訊息後不再呼叫 AI:顯示額度用完 + CTA,並鎖住輸入', () => {
  assert.equal(ai.AI_LIMITS.maxUserMessages, 20);
  const send = fnBody('sendText');
  // 第 21 則:在打 API 之前就擋下
  const guard = send.indexOf('if (userTextCount(history) >= AI_LIMITS.maxUserMessages) { lockFor(\'quota\'); return; }');
  assert.ok(guard > 0 && guard < send.indexOf("postJSON('/api/ai-chat'"), '20 則的檢查要在 postJSON 之前');
  // 第 20 則的回覆一回來就鎖,不用等他打第 21 則才發現
  assert.match(fnBody('afterReply'), /if \(userTextCount\(history\) >= AI_LIMITS\.maxUserMessages\) lockFor\('quota'\);/);
  // 鎖住 = 額度用完的文案 + CTA + 輸入框唯讀
  const lock = fnBody('lockFor');
  assert.match(lock, /if \(reason === 'quota'\) addMsg\('bot', txt\('quotaUsed'\)\);/);
  assert.match(lock, /remindLocked\(\);/);
  assert.match(fnBody('remindLocked'), /showCTA\(/);
  assert.match(fnBody('syncComposer'), /textInput\.readOnly = registering \|\| aiClosed;/);
  assert.match(send, /if \(locked\) return;/);

  // 計數只算使用者打的字:照片、AI 回覆、菜單分析的 note 都不算
  const history = [
    { role: 'user', text: 'a' }, { role: 'bot', text: 'b' }, { role: 'bot', text: 'menu', note: true },
    { role: 'user', text: '' }, { role: 'user', text: 'c' },
  ];
  assert.equal(ai.userTextCount(history), 2);
  const twenty = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `m${i}` }));
  assert.equal(ai.userTextCount(twenty) >= ai.AI_LIMITS.maxUserMessages, true);
});

// ── 5. 依回應處理 ────────────────────────────────────────────────────────────
test('5a. 錯誤碼分類:三種 429 都當「免費額度用完」,413 / 415 各有文案,其他走通用錯誤', () => {
  assert.deepEqual(plain(ai.QUOTA_CODES), { RATE_LIMITED: 1, CONVERSATION_LIMIT: 1, DAILY_CAP: 1 });
  // 2026-10 修訂 2 R10:只有「10 分鐘級的 RATE_LIMITED」改成時間到自動解鎖(見 R10 那條);
  // 這裡釘的原意不變:三種 429 都認得、都不會掉進通用錯誤 —— 天級 / 沒給秒數的一律當免費額度用完
  for (const code of ['RATE_LIMITED', 'CONVERSATION_LIMIT', 'DAILY_CAP']) {
    assert.equal(ai.classifyFailure(429, { code, message: 'x', retryAfterSeconds: 43200 }, 'text'), 'quota', code);
    assert.equal(ai.classifyFailure(429, { code }, 'image'), 'quota', `${code}(照片)`);
  }
  for (const code of ['CONVERSATION_LIMIT', 'DAILY_CAP']) {
    assert.equal(ai.classifyFailure(429, { code, retryAfterSeconds: 60 }, 'text'), 'quota', `${code} 就算秒數很短也維持鎖住`);
  }
  assert.equal(ai.classifyFailure(429, null, 'text'), 'quota', '沒有 body 的 429 也算');
  assert.equal(ai.classifyFailure(413, { code: 'TOO_LONG' }, 'text'), 'tooLong');
  assert.equal(ai.classifyFailure(413, { code: 'IMAGE_TOO_LARGE' }, 'image'), 'imageTooLarge');
  assert.equal(ai.classifyFailure(413, { code: 'BODY_TOO_LARGE' }, 'image'), 'imageTooLarge');
  assert.equal(ai.classifyFailure(413, { code: 'BODY_TOO_LARGE' }, 'text'), 'tooLong');
  assert.equal(ai.classifyFailure(413, null, 'image'), 'imageTooLarge', 'Vercel 自己的 413 沒有 code');
  assert.equal(ai.classifyFailure(415, { code: 'UNSUPPORTED_IMAGE' }, 'image'), 'imageUnsupported');
  for (const [status, json] of [[502, { code: 'AI_UPSTREAM' }], [500, null], [0, null], [403, { code: 'ACTION_NOT_ALLOWED' }], [401, { code: 'UNAUTHORIZED' }], [400, { message: 'messages is required' }]]) {
    assert.equal(ai.classifyFailure(status, json, 'text'), 'generic', `${status}`);
  }
  // 每一種分類都有對應的處理
  const fail = fnBody('handleFailure');
  assert.match(fail, /if \(why === 'quota'\) \{ lockFor\('quota'\); return; \}/);
  assert.match(fail, /addMsg\('bot', txtf\('tooLong', \{ max: AI_LIMITS\.maxInputChars \}\)\);/);
  assert.match(fail, /if \(why === 'imageTooLarge'\) \{ addMsg\('bot', txt\('imageTooLarge'\)\); return; \}/);
  assert.match(fail, /if \(why === 'imageUnsupported'\) \{ addMsg\('bot', txt\('imageUnsupported'\)\); return; \}/);
  assert.match(fail, /addMsg\('bot', errMsg\(\)\);\s*showCTA\(\);/, '其他錯誤:沿用通用錯誤文案 + CTA');
  assert.equal(dict('zh').ai.quotaUsed, '免費試用的次數用完了，註冊後可以繼續聊');
});

test('5b. stage:done → 「需求整理好了」CTA;ended → 鎖住 + CTA;舊版 ai 沒有 stage 照常運作', () => {
  assert.deepEqual(plain(ai.parseChatData({ reply: '總結如下', stage: 'done' })), { reply: '總結如下', stage: 'done' });
  assert.deepEqual(plain(ai.parseChatData({ reply: '本助手只協助食材採購', stage: 'ended' })), { reply: '本助手只協助食材採購', stage: 'ended' });
  // 舊版 ai:只有 reply
  assert.deepEqual(plain(ai.parseChatData({ reply: '你好' })), { reply: '你好', stage: null });
  assert.deepEqual(plain(ai.parseChatData({ reply: '你好', stage: 'weird' })), { reply: '你好', stage: null });
  // 後端萬一沒把記號拿掉:訪客看不到記號,stage 照樣認得
  assert.deepEqual(plain(ai.parseChatData({ reply: '需求整理好了 [[DONE]]' })), { reply: '需求整理好了', stage: 'done' });
  assert.deepEqual(plain(ai.parseChatData({ reply: '先到這裡[[END]]' })), { reply: '先到這裡', stage: 'ended' });
  assert.deepEqual(plain(ai.parseChatData(null)), { reply: '', stage: null });

  const after = fnBody('afterReply');
  assert.match(after, /if \(stage === 'ended'\) \{ lockFor\('ended'\); return; \}/);
  assert.match(after, /if \(stage === 'done'\) \{\s*showCTA\(txt\('ctaPrefixDone'\)\);/);
  assert.match(fnBody('remindLocked'), /showCTA\(locked === 'ended' \? txt\('ctaPrefixEnded'\) : ''\);/);
  assert.ok(dict('zh').ai.ctaPrefixDone.startsWith('需求整理好了'));
  // 成功判斷:有 reply 或有 stage 都算(ended 時後端可能只回一句收尾)
  assert.match(fnBody('sendText'), /if \(data && \(parsed\.reply \|\| parsed\.stage\)\) \{/);
});

// ── 6. CTA ───────────────────────────────────────────────────────────────────
test('6. CTA:沒有「每頁一次」的旗標;畫面上同時只有一組;主按鈕免費註冊、同等份量的「留聯絡方式請供應商報價」', () => {
  // 舊的 once-per-page 旗標與函式整個拿掉
  assert.doesNotMatch(widget, /\bctaShown\b|\bleadShown\b|showLeadCTA/);
  const cta = fnBody('showCTA');
  // 一進來先清掉舊的那組,不提早 return
  assert.match(cta, /^function showCTA\(prefix\) \{\s*ctaSeq\+\+;\s*removeCTA\(\);/);
  assert.doesNotMatch(cta.slice(0, cta.indexOf('removeCTA();')), /return/);
  assert.match(fnBody('removeCTA'), /body\.querySelectorAll\('\.ai-cta-row'\)/);
  assert.match(cta, /b\.parentNode\.classList\.add\('ai-cta-row'\);/);
  assert.match(cta, /reg\.setAttribute\('data-cta', 'register'\);/);
  assert.match(cta, /reg\.textContent = registerLabel\(\);/);
  assert.match(fnBody('registerLabel'), /if \(registering\) return txt\('ctaRegisterBusy'\);\s*return txt\(collect\.active \? 'ctaSwitchRegister' : 'ctaRegister'\);/);
  assert.match(cta, /alt\.setAttribute\('data-cta', 'lead'\);/);
  assert.match(cta, /alt\.textContent = txt\('ctaLead'\);/);
  assert.match(cta, /alt\.className = 'ai-cta ai-cta--ghost'/, '兩顆按鈕同樣是 .ai-cta 大按鈕,不是藏在角落的小字連結');
  assert.equal(dict('zh').ai.ctaLead, '留下聯絡方式，讓供應商報價給我');
  assert.match(dict('zh').ai.ctaRegister, /^免費註冊/);
  // 出現時機:第一則回覆後、done、ended / 429(lockFor)、菜單分析完、通用錯誤、照片超過上限
  assert.match(fnBody('afterReply'), /showCTA\(txt\('ctaPrefixChat'\)\)/);
  assert.match(fnBody('afterReply'), /showCTA\(txt\('ctaPrefixDone'\)\)/);
  assert.match(fnBody('lockFor'), /remindLocked\(\);/);
  assert.match(fnBody('remindLocked'), /showCTA\(/);
  assert.match(fnBody('coolDown'), /showCTA\(\);/);
  assert.match(fnBody('renderAnalysis'), /showCTA\(txt\('ctaPrefixAnalysis'\)\);/);
  // 第一則回覆後延遲 500ms 出現:中間如果已經出了別組(例如 done),它就不再出來蓋掉
  assert.match(fnBody('afterReply'), /var seq = ctaSeq;\s*setTimeout\(function \(\) \{ if \(seq === ctaSeq && !locked\) showCTA/);
  // 切語系時兩顆按鈕跟著換字
  assert.match(fnBody('applyStaticStrings'), /\.ai-cta-row \[data-cta="register"\]/);
  assert.match(fnBody('applyStaticStrings'), /\.ai-cta-row \[data-cta="lead"\]/);
  // 44px 點擊區
  assert.match(widget, /\.ai-cta \{[^}]*min-height: 44px;/);
  assert.match(widget, /\.ai-cta-alt \{[^}]*min-height: 44px;/);
});

// ── 7. 免費註冊 → 交接 ───────────────────────────────────────────────────────
test('7a. 交接網址放 #handoff= 片段(不用 ?),值是 encodeURIComponent(analysisId.claimToken)', () => {
  const base = 'https://app.ifoodmap.ai';
  const id = '0b5f8f2e-6a4c-4c51-9a7e-2f7d7b1d9e10';
  const token = 'q1W-_e2R3t4Y5u6I7o8P9a0S1d2F3g4H5j6K7l8Z9x0';
  assert.equal(ai.handoffUrl(base, id, token), `${base}/register/restaurant#handoff=${encodeURIComponent(`${id}.${token}`)}`);
  // 萬一 token 帶到需要編碼的字元,也要編碼(不能讓 # 片段被切斷或混進 query)
  assert.equal(ai.handoffUrl(base, 'a/b', 'c+d=&?#'), `${base}/register/restaurant#handoff=a%2Fb.c%2Bd%3D%26%3F%23`);
  // 沒有完整的一組(沒訊息、失敗、逾時、舊版 ai 不回 claimToken)→ 單純去註冊
  assert.equal(ai.handoffUrl(base, id, null), `${base}/register/restaurant`);
  assert.equal(ai.handoffUrl(base, null, token), `${base}/register/restaurant`);
  assert.equal(ai.handoffUrl(base + '/', id, ''), `${base}/register/restaurant`);
  for (const url of [ai.handoffUrl(base, id, token), ai.handoffUrl(base, null, null)]) {
    assert.equal(new URL(url).search, '', `交接資料不可以放 query string:${url}`);
  }
  assert.doesNotMatch(widget, /register\/restaurant\?/);
});

test('7b. 按「免費註冊」:忙碌文字 → 有訊息才存檔(reason register,10 秒逾時)→ 標成已存檔 → location.assign', () => {
  const go = fnBody('goRegister');
  assert.match(go, /if \(registering \|\| collect\.sending\) return;\s*registering = true;\s*track\('landing_ai_register_click'\);\s*btn\.textContent = txt\('ctaRegisterBusy'\);/);
  assert.match(go, /saveForExit\('register'\)\.then\(function \(\) \{[\s\S]*?markSaved\(\);\s*window\.location\.assign\(handoffUrl\(window\.IFM_PRODUCT_BASE_URL, conv\.analysisId, conv\.claimToken\)\);/);
  // 產品站網址只住在 index.html 頂端那一行,widget 不另外寫死
  assert.doesNotMatch(widget, /https:\/\/app\.ifoodmap\.ai/);
  const exit = fnBody('saveForExit');
  // 原本釘「沒打過字就不打 ai-extract」;修訂 2 R1 之後多一個例外(紀錄被舊版 ai 拆成好幾筆),規則在 exitNeedsSave
  assert.match(exit, /if \(!exitNeedsSave\(userTextCount\(history\), recordsSplit\)\) return Promise\.resolve\(false\);/);
  assert.match(exit, /withTimeout\(postExtract\(reason, \{ timeoutMs: AI_LIMITS\.extractTimeoutMs \}\), AI_LIMITS\.extractTimeoutMs\)/);
  assert.equal(ai.AI_LIMITS.extractTimeoutMs, 10000);
  // 失敗 / 逾時不擋路
  assert.match(exit, /function \(\) \{ return false; \}\);/);
  // 逾時真的會中斷那個 fetch
  const post = fnBody('postExtract');
  assert.match(post, /new AbortController\(\)/);
  assert.match(post, /setTimeout\(function \(\) \{ ctrl\.abort\(\); \}, opts\.timeoutMs\)/);
  // body:{messages, lang, reason, analysisId?, claimToken?}
  assert.match(fnBody('extractPayload'), /var p = \{ messages: saveMessages\(history\), lang: curLang\(\), reason: reason \};/);
  assert.match(fnBody('extractPayload'), /if \(conv\.analysisId && conv\.claimToken\) p\.claimToken = conv\.claimToken;/);
  // 從註冊頁按「上一頁」回來(bfcache 原封不動還原)時要解除交接中的狀態,不然面板會卡死(細節見 R10 那條)
  assert.match(widget, /window\.addEventListener\('pageshow', function \(e\) \{ if \(e\.persisted\) resetRegistering\(\); \}\);/);
});

// ── 8. 留聯絡方式(一步一題、用點的)──────────────────────────────────────────
test('8a. 留聯絡方式:地區 → 頻率 → 店名或稱呼 → 手機 / LINE / Email 擇一,不再一次丟出整張表單', () => {
  // 最後一步只收一個欄位,自動判斷是哪一種
  assert.deepEqual(plain(ai.parseLeadContact('0912-345-678')), { phone: '0912-345-678' });
  assert.deepEqual(plain(ai.parseLeadContact(' +886 2 2345 6789 ')), { phone: '+886 2 2345 6789' });
  assert.deepEqual(plain(ai.parseLeadContact('ahui_noodle')), { line: 'ahui_noodle' });
  assert.deepEqual(plain(ai.parseLeadContact('@ahui.noodle')), { line: 'ahui.noodle' });
  assert.deepEqual(plain(ai.parseLeadContact('chef@restaurant.tw')), { email: 'chef@restaurant.tw' });
  for (const bad of ['', '   ', null, '123', '12345', '0912 abc 345', '阿輝', 'a b', 'ab', 'abc', 'x'.repeat(41), '1'.repeat(16)]) {
    assert.equal(ai.parseLeadContact(bad), null, String(bad));
  }

  // 流程:不再有表單,也沒有舊的「問稱呼 → 問 Email」
  assert.doesNotMatch(widget, /validLeadForm|buildLeadForm|ai-lead-form|askName|askEmail|emailInvalid/);
  for (const lang of ['zh', 'en']) {
    for (const key of ['askName', 'askEmail', 'emailInvalid', 'ctaEmail', 'placeholderName', 'placeholderEmail', 'leadIntro', 'leadSubmit', 'leadConsent', 'placeholderLeadForm']) {
      assert.equal(dict(lang).ai[key], undefined, `${lang}.ai.${key} 應該已經拿掉`);
    }
  }
  const start = fnBody('startCollect');
  assert.match(start, /collect\.active = true; collect\.step = 'area';/);
  assert.match(start, /addChips\(addMsg\('bot', txt\('leadAskArea'\)\), LEAD_AREAS\);\s*showCTA\(\);/);
  const answer = fnBody('collectAnswer');
  // 四步:每一步都是「記下答案 → 下一題 → 重出 CTA 出口」
  assert.match(answer, /if \(collect\.step === 'area'\) \{\s*collect\.area = value\.slice\(0, 100\); collect\.step = 'freq';/);
  assert.match(answer, /addChips\(addMsg\('bot', txt\('leadAskFreq'\)\), LEAD_FREQS\);\s*showCTA\(\);/);
  assert.match(answer, /collect\.frequency = value\.slice\(0, 60\); collect\.step = 'who';/);
  assert.match(answer, /collect\.who = value\.slice\(0, 100\); collect\.step = 'contact';/);
  assert.match(answer, /var c = parseLeadContact\(value\);\s*if \(!c\) \{ addMsg\('bot', txt\('leadContactInvalid'\)\); showCTA\(\); return; \}/);
  // 打字也能答(handleCollect 就是 collectAnswer),按鈕與打字走同一條路
  assert.match(fnBody('handleCollect'), /collectAnswer\(v, v\);/);
  assert.match(fnBody('addChips'), /collectAnswer\(c\.v, txt\(c\.k\)\);/);
  // 地區 / 頻率的值固定存中文(供應商的服務區域是中文縣市名),按鈕上的字才跟著語系
  assert.equal(dict('zh').ai.leadChipTaipei, '台北市');
  assert.equal(dict('en').ai.leadChipTaipei, 'Taipei');
  assert.match(widget, /\{ k: 'leadChipTaipei', v: '台北市' \}/);
  // 答案不進對話紀錄(不會被送去 AI、也不會出現在 analysis_records.messages)
  for (const name of ['collectAnswer', 'handleCollect', 'saveLead']) assert.doesNotMatch(fnBody(name), /history\.push/);
  // 同意說明就在要聯絡方式的那一句裡(不是預設打勾的勾選框)
  assert.match(dict('zh').ai.leadAskContact, /同意把你的需求與聯絡方式提供給符合的供應商/);
  assert.match(widget, /consent: true/);
  // Email 規則(DB、notify-lead、異業合作表單共用)還在
  assert.equal(ai.validEmail('chef@restaurant.tw'), true);
  assert.equal(ai.validEmail('chef@restaurant'), false);
});

test('8b. 留聯絡方式:先用 reason lead 存檔拿 analysisId,再寫 landing_leads(帶同意旗標與 analysis_id)', () => {
  const save = fnBody('saveLead');
  assert.ok(save.indexOf("saveForExit('lead')") >= 0 && save.indexOf("saveForExit('lead')") < save.indexOf('/rest/v1/landing_leads'));
  assert.match(save, /\}, lastAnalysis, history, conv\.analysisId, navigator\.userAgent\);/);

  const row = plain(ai.leadRow(
    { name: '阿輝鍋燒麵 阿輝', phone: ' 0912-345-678 ', area: '台北市', frequency: '每週 2～3 次', consent: true },
    { summary: '火鍋店每週採購', ingredients: [{ name: '高麗菜', quantity: 10, unit: 'kg' }, { name: '' }, { name: '豬五花', unit: '斤' }] },
    [{ role: 'user', text: '我要高麗菜' }],
    'analysis-1',
    'Mozilla/5.0 '.repeat(60),
  ));
  assert.deepEqual(Object.keys(row).sort(), [
    'analysis_id', 'company_name', 'consent_share', 'contact_line', 'contact_name', 'contact_phone', 'contact_time',
    'delivery_area', 'detail', 'extra_notes', 'frequency', 'items_text', 'source', 'user_agent',
  ]);
  assert.equal(row.company_name, '阿輝鍋燒麵 阿輝');
  assert.equal(row.contact_name, null, '店名與稱呼只收一格時,不重複寫進聯絡人');
  assert.equal(row.contact_phone, '0912-345-678');
  assert.equal(row.contact_line, null);
  assert.equal(row.delivery_area, '台北市');
  assert.equal(row.frequency, '每週 2～3 次');
  assert.equal(row.consent_share, true);
  assert.equal(row.analysis_id, 'analysis-1');
  assert.equal(row.source, 'ai_widget');
  assert.equal(row.items_text, '高麗菜10kg、豬五花斤');
  assert.match(row.detail, /^【AI 採購助手】客戶姓名：阿輝鍋燒麵 阿輝\n火鍋店每週採購\n採購清單：高麗菜10kg、豬五花斤\n配送地點：台北市\n配送頻率：每週 2～3 次$/);
  assert.equal(row.user_agent.length, 300);
  // 店名與稱呼分開給時,聯絡人才會另外寫
  assert.equal(ai.leadRow({ name: '阿輝', company: '阿輝鍋燒麵', phone: '0912345678' }, null, [], null, '').contact_name, '阿輝');
  // 沒勾同意就是 false(後端不會轉給供應商)
  assert.equal(ai.leadRow({ name: 'x', phone: '0912345678' }, null, [], null, '').consent_share, false);
  // 有給 Email 才送 contact_email
  assert.equal(ai.leadRow({ name: 'x', email: ' a@b.co ' }, null, [], null, '').contact_email, 'a@b.co');

  // AI 沒整理出清單:detail 帶對話(只有文字,AI 的 note 不帶),而且長度先截短 —— 後端有長度 check,超過整筆會被擋
  const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'bot' : 'user', text: '字'.repeat(300) }));
  const talk = plain(ai.leadRow({ name: 'x'.repeat(200), phone: '0912345678' }, null, long, null, ''));
  assert.equal(talk.items_text, null);
  assert.equal(talk.analysis_id, null);
  assert.equal(talk.company_name.length, 100);
  assert.ok(talk.detail.length <= 2000);
  assert.match(talk.detail, /\n對話：客：/);
});

test('8d. 留好之後:加 LINE 排在註冊前面(帶需求編號的預填訊息),漏斗事件只送匿名代號、不帶個資', () => {
  const cta = fnBody('showCTA');
  assert.match(cta, /if \(collect\.step === 'done'\) \{[\s\S]*?line\.setAttribute\('data-cta', 'line'\);[\s\S]*?b\.insertBefore\(line, reg\);/);
  assert.match(cta, /line\.rel = 'noopener noreferrer'/);
  assert.match(fnBody('lineHref'), /'https:\/\/line\.me\/R\/oaMessage\/' \+ LINE_OA \+ '\/\?' \+ encodeURIComponent\(txtf\('lineMsg'/);
  assert.match(widget, /var LINE_OA\s+= '@694xprvx';/);
  assert.match(fnBody('saveLead'), /showCTA\(txt\('ctaPrefixLeadDone'\)\)/);
  assert.match(dict('zh').ai.ctaPrefixLeadDone, /加我們的 LINE/);
  // 事件:名稱固定、屬性只有步驟名稱 / 成功與否,沒有姓名、電話、LINE ID
  const events = [...widget.matchAll(/track\('(landing_ai_[a-z_]+)'(?:, (\{[^}]*\}))?\)/g)];
  assert.ok(events.length >= 6, `漏斗事件太少:${events.length}`);
  for (const [, , props] of events) {
    for (const key of (props || '').match(/\b\w+(?=:)/g) || []) assert.ok(['step', 'ok', 'why'].includes(key), `事件屬性只能是 step / ok / why:${key}`);
  }
  assert.match(fnBody('track'), /session_key: trackKey/);
  assert.match(fnBody('track'), /\} catch \(e\) \{\}/, '事件送不出去不能影響對話');
});

test('8c. 收到 400 + LEAD_RATE_LIMITED → 友善文案(不是「送出失敗」)', () => {
  assert.equal(ai.isLeadRateLimited(400, { code: 'P0001', message: 'LEAD_RATE_LIMITED', details: null, hint: null }), true);
  assert.equal(ai.isLeadRateLimited(400, { message: 'new row violates check constraint' }), false);
  assert.equal(ai.isLeadRateLimited(409, { message: 'LEAD_RATE_LIMITED' }), false);
  assert.equal(ai.isLeadRateLimited(400, null), false);
  const save = fnBody('saveLead');
  assert.match(save, /\} else if \(isLeadRateLimited\(res\.status, res\.json\)\) \{[\s\S]*?bub\.textContent = txt\('leadRateLimited'\);/);
  // 失敗時要讀 body 才知道是不是被防灌水擋下
  assert.match(save, /return r\.json\(\)\.then\(function \(j\) \{ return \{ ok: false, status: r\.status, json: j \}; \}/);
  // 被擋下之後:「留聯絡方式」那顆不再出現,但註冊出口還在;留成功了則接著請他註冊追蹤報價
  assert.match(save, /if \(collect\.step === 'done'\) showCTA\(txt\('ctaPrefixLeadDone'\)\);[^\n]*\n\s*else showCTA\(\);/);
  assert.match(fnBody('showCTA'), /collect\.step !== 'limited'/);
  // 寫入點仍然只有一個(content.test.cjs 也有擋),而且 return=minimal
  assert.equal((rawSource.match(/\/rest\/v1\/landing_leads/g) || []).length, 1);
  assert.match(save, /'Prefer': 'return=minimal'/);
});

// ── 9. 關面板 / 離開頁面 ─────────────────────────────────────────────────────
test('9. 關面板或離開頁面:使用者訊息 ≥ 2 則且還沒存過才存(reason close,keepalive / beacon),不帶圖片', () => {
  assert.equal(ai.shouldSaveOnLeave(0, 0), false);
  assert.equal(ai.shouldSaveOnLeave(1, 0), false, '只有 1 則不存');
  assert.equal(ai.shouldSaveOnLeave(2, 0), true);
  assert.equal(ai.shouldSaveOnLeave(3, 3), false, '已經存過、沒有新內容就不再存');
  assert.equal(ai.shouldSaveOnLeave(4, 3), true, '存過之後又聊了,才再存一次');

  const leave = fnBody('saveOnLeave');
  assert.match(leave, /if \(registering \|\| !shouldSaveOnLeave\(n, savedUserCount\)\) return;\s*savedUserCount = n;/);
  assert.match(leave, /postExtract\('close', \{ keepalive: true \}\)/);
  assert.match(leave, /navigator\.sendBeacon\('\/api\/ai-extract', new Blob\(\[data\], \{ type: 'application\/json' \}\)\)/);
  assert.match(fnBody('closePanel'), /saveOnLeave\(false\);/);
  assert.match(widget, /window\.addEventListener\('pagehide', function \(\) \{ saveOnLeave\(true\); \}\);/);
  // 註冊交接時存過了:標成已存,pagehide 不會再存一次
  assert.match(fnBody('markSaved'), /savedUserCount = userTextCount\(history\);/);

  // 存檔帶的訊息:只有 role + text(不會有 image),bot → model,菜單 note 也帶
  const saved = plain(ai.saveMessages([
    { role: 'user', text: '找高麗菜' },
    { role: 'bot', text: '好的' },
    { role: 'bot', text: '菜單摘要', note: true },
    { role: 'user', text: '', image: 'data:image/jpeg;base64,AAAA' },
  ]));
  assert.deepEqual(saved, [{ role: 'user', text: '找高麗菜' }, { role: 'model', text: '好的' }, { role: 'model', text: '菜單摘要' }]);
  // 照片的 base64 不進對話紀錄
  assert.doesNotMatch(widget, /history\.push\(\{[^}]*image/);

  // 最壞情況(20 則 300 字的中文 + 20 則 1,000 字的回覆 + 3 張菜單 note)也要在 keepalive / beacon 的 64 KB 以內
  const worst = [];
  for (let i = 0; i < 20; i++) {
    worst.push({ role: 'user', text: '食'.repeat(300) }, { role: 'bot', text: '材'.repeat(1500) });
  }
  for (let i = 0; i < 3; i++) worst.push({ role: 'bot', text: '單'.repeat(600), note: true });
  const capped = plain(ai.saveMessages(worst));
  const bytes = Buffer.byteLength(JSON.stringify({ messages: capped, lang: 'zh', reason: 'close', analysisId: 'x'.repeat(36), claimToken: 'y'.repeat(43) }));
  assert.ok(bytes < 60 * 1024, `存檔 body ${bytes} bytes,超過 keepalive / sendBeacon 的上限`);
  assert.ok(capped.length >= 10, '至少要留住最近的十幾則');
  assert.equal(capped[capped.length - 1].text, '單'.repeat(600), '丟的是最舊的,最新的要留著');
});

// ── 10. analysisId / claimToken ──────────────────────────────────────────────
test('10. 從 analyze-menu 與 analyze-chat 的回應記下 analysisId + claimToken,存檔與交接都帶上', () => {
  const empty = { analysisId: null, claimToken: null };
  // analyze-chat(replace = true):有給就換
  assert.deepEqual(plain(ai.nextPair(empty, 'a1', 't1', true)), { analysisId: 'a1', claimToken: 't1' });
  assert.deepEqual(plain(ai.nextPair({ analysisId: 'a1', claimToken: 't1' }, 'a2', 't2', true)), { analysisId: 'a2', claimToken: 't2' });
  // skipped(too_short / no_ingredients)回 analysisId: null:手上那組不動
  assert.deepEqual(plain(ai.nextPair({ analysisId: 'a1', claimToken: 't1' }, null, null, true)), { analysisId: 'a1', claimToken: 't1' });
  // analyze-menu(replace = false):手上已經有完整一組就不換
  assert.deepEqual(plain(ai.nextPair({ analysisId: 'a1', claimToken: 't1' }, 'm2', 'tm2', false)), { analysisId: 'a1', claimToken: 't1' });
  assert.deepEqual(plain(ai.nextPair(empty, 'm1', 'tm1', false)), { analysisId: 'm1', claimToken: 'tm1' });
  // 舊版 ai 不回 claimToken:只記 id,交接網址就不帶 handoff
  assert.deepEqual(plain(ai.nextPair(empty, 'old', undefined, true)), { analysisId: 'old', claimToken: null });
  assert.deepEqual(plain(ai.nextPair({ analysisId: 'old', claimToken: null }, 'm1', 'tm1', false)), { analysisId: 'm1', claimToken: 'tm1' });

  // 同一筆、後端這次沒帶 token:沿用手上那個
  assert.deepEqual(plain(ai.nextPair({ analysisId: 'a1', claimToken: 't1' }, 'a1', null, true)), { analysisId: 'a1', claimToken: 't1' });
  // menu 的回應改由 menuOutcome 決定(R1,見下一條測試)
  assert.match(fnBody('renderAnalysis'), /var outcome = menuOutcome\(conv, lastAnalysis, data\);/);
  assert.match(fnBody('postExtract'), /adoptPair\(j\.data\.analysisId, j\.data\.claimToken, true\);/);
  assert.match(fnBody('adoptPair'), /var next = nextPair\(conv, analysisId, claimToken, replace\);/);
  // 存檔一個接一個送:前一筆拿到的那組,下一筆才帶得上
  assert.match(fnBody('postExtract'), /var p = Promise\.resolve\(saveChain\)\.then\(send, send\);/);
  // 菜單分析的結果以 note 記進對話紀錄,存檔 / 交接時這張菜單的食材才不會漏
  assert.match(fnBody('renderAnalysis'), /history\.push\(\{ role: 'bot', text: note, note: true \}\);/);
  assert.equal(ai.analysisNote({ summary: '火鍋店', ingredients: [{ name: '高麗菜', quantity: 2, unit: 'kg' }, { name: '蛤蜊' }] }, '食材：', '、'), '火鍋店\n食材：高麗菜 2 kg、蛤蜊');
  assert.equal(ai.analysisNote({ summary: '', ingredients: [] }, 'x'), '');
  assert.equal(ai.analysisNote({ summary: 's'.repeat(900) }, '').length, 600);
});

test('10b. 送給 chat 的對話:bot → model、只帶文字、不帶菜單 note、AI 回覆截到 1,000 字', () => {
  const sent = plain(ai.chatMessages([
    { role: 'bot', text: '菜單摘要', note: true },
    { role: 'user', text: '你好' },
    { role: 'bot', text: '回'.repeat(1200) },
    { role: 'user', text: '' },
    null,
    { role: 'user', text: '下一題' },
  ]));
  assert.deepEqual(sent.map((m) => m.role), ['user', 'model', 'user']);
  assert.equal(sent[1].text.length, 1000);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['role', 'text']);
  assert.match(widget, /postJSON\('\/api\/ai-chat', \{ messages: chatMessages\(history\), lang: curLang\(\) \}\)/);
});

// ── 11. 文案一律走字典 ───────────────────────────────────────────────────────
test('11. widget 用到的每個 txt() / txtf() key 在中英字典都有,英文沒有殘留中文', () => {
  const keys = [...new Set(Array.from(widget.matchAll(/\btxtf?\('([A-Za-z]+)'/g), (m) => m[1]))];
  // 三元運算裡的 key 也要算進來
  for (const m of widget.matchAll(/txt\((?:[^()]*?) \? '([A-Za-z]+)' : '([A-Za-z]+)'\)/g)) keys.push(m[1], m[2]);
  keys.push('uploadImageOnly', 'dropImageOnly');   // acceptImages 的 notImageKey 參數
  assert.ok(keys.length > 30, `key 掃描器可能壞了:${keys.length}`);
  for (const key of new Set(keys)) {
    for (const lang of ['zh', 'en']) {
      assert.equal(typeof dict(lang).ai[key], 'string', `dict('${lang}').ai.${key} 不存在`);
      assert.ok(dict(lang).ai[key].length > 0, `dict('${lang}').ai.${key} 是空字串`);
    }
    assert.doesNotMatch(dict('en').ai[key], CJK, `en.ai.${key} 還是中文`);
  }
  // 新文案的佔位符兩邊一致({max} / {name} / {email})
  for (const key of ['tooLong', 'uploadLimit', 'lineMsg', 'leadSuccess']) {
    const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    assert.equal(holes(dict('zh').ai[key]), holes(dict('en').ai[key]), key);
  }
  assert.equal(format(dict('en').ai.uploadLimit, { max: 3 }), 'You can upload up to 3 photos per chat. Sign up free to upload more 📷');
  // widget 裡給訪客看的字不可以寫死中文(只允許註解與寫給業主看的 detail)
  const code = widget
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => CJK.test(line));
  // 放行的只有三種:寫進 landing_leads.detail 給業主看的標籤(leadRow)、地區 / 頻率按鈕存進後台的固定中文值(LEAD_AREAS / LEAD_FREQS),以及品牌字標「食」
  const leftovers = code.filter((line) => !/\{ k: 'leadChip[A-Za-z0-9]+', v: '[^']+' \}|'【AI 採購助手】客戶姓名：'|'\\n採購清單：'|'\\n對話：'|'\\n店家：'|'\\n訪客自己寫的需求：'|'\\n配送地點：'|'\\n配送頻率：'|'\\n特殊需求：'|'\\n方便聯繫：'|<div class="ai-ava">食<\/div>/.test(line));
  assert.deepEqual(leftovers, [], `widget 裡有寫死的中文:\n${leftovers.join('\n')}`);
});

// ── 12. 異業合作表單 ─────────────────────────────────────────────────────────
test('12. 異業合作表單收到 400 + LEAD_RATE_LIMITED 時顯示友善文案', () => {
  const start = rawSource.indexOf('submitPartnership(event) {');
  const form = rawSource.slice(start, rawSource.indexOf('\n  handToAI(', start));
  assert.ok(start > 0 && form.length > 1000);
  assert.match(form, /return r\.json\(\)\.then\(\(j\) => \(\{ ok: false, status: r\.status, json: j \}\), \(\) => \(\{ ok: false, status: r\.status, json: null \}\)\);/);
  assert.match(form, /const rateLimited = r\.status === 400 && !!r\.json && typeof r\.json\.message === 'string'\s*&& r\.json\.message\.indexOf\('LEAD_RATE_LIMITED'\) !== -1;/);
  assert.match(form, /btn\.textContent = this\.partnerText\(rateLimited \? 'formRateLimited' : 'formFailure'\);/);
  // 原本的保護都還在:送出鎖、成功後永久鎖、還原時重查字典
  assert.match(form, /if \(btn\.getAttribute\('data-busy'\) === '1' \|\| btn\.getAttribute\('data-done'\) === '1'\) return;/);
  assert.match(form, /btn\.setAttribute\('data-done', '1'\);/);
  assert.match(form, /const restore = \(\) => \{ btn\.textContent = this\.partnerText\('submit'\) \|\| original; \};/);
  for (const lang of ['zh', 'en']) assert.ok(dict(lang).contact.formRateLimited, `${lang}.contact.formRateLimited`);
  assert.doesNotMatch(dict('en').contact.formRateLimited, CJK);
  assert.notEqual(dict('zh').contact.formRateLimited, dict('zh').contact.formFailure);
});

test('對話鎖住之後仍然可以留 Email(收聯絡資料時輸入框要能用)', () => {
  const sync = fnBody('syncComposer');
  assert.match(sync, /var aiClosed = !!locked && !collect\.active;/);
  const send = fnBody('sendText');
  // collect 的分支要排在「對話已鎖」之前
  assert.ok(send.indexOf('if (collect.active)') < send.indexOf('if (locked) return;'));
  // 首頁搜尋列 / 分類籤:對話鎖住或正在交接時只開面板,不送字
  assert.match(widget, /if \(!v \|\| collect\.active \|\| locked \|\| registering\) return;\s*textInput\.value = v;\s*if \(!aiBusy\) sendText\(\);/);
});

// ── 修訂 2 R1:同一段對話的照片併進同一筆 ─────────────────────────────────────
test('R1. 後續照片帶上手上那組;新版 ai 回同一組 → 食材併進同一筆;舊版每張回新的一組 → 換成最新那組並記成「被拆開」', () => {
  assert.deepEqual(plain(ai.pairFields({ analysisId: 'a1', claimToken: 't1' })), { analysisId: 'a1', claimToken: 't1' });
  assert.deepEqual(plain(ai.pairFields({ analysisId: 'a1', claimToken: null })), {}, '缺 token 就都不帶');
  assert.deepEqual(plain(ai.pairFields(null)), {});

  // 去重規則跟後端 supabase/functions/ai/guard.ts 的 mergeIngredients 一樣:名稱 trim + 小寫,後來的蓋掉先前的,位置照第一次出現
  assert.deepEqual(
    plain(ai.mergeIngredients([{ name: '高麗菜', quantity: '1' }, { name: 'Pork' }], [{ name: ' 高麗菜 ', quantity: '3' }, { name: 'pork', unit: 'kg' }, { name: '蛤蜊' }, { name: '' }, null])),
    [{ name: ' 高麗菜 ', quantity: '3' }, { name: 'pork', unit: 'kg' }, { name: '蛤蜊' }],
  );

  const empty = { analysisId: null, claimToken: null };
  const first = plain(ai.menuOutcome(empty, null, { analysisId: 'A', claimToken: 'TA', summary: '菜單1', ingredients: [{ name: '高麗菜' }] }));
  assert.deepEqual(first, { conv: { analysisId: 'A', claimToken: 'TA' }, view: { summary: '菜單1', ingredients: [{ name: '高麗菜' }] }, split: false });
  // 新版 ai(R1):回同一組 → 那筆的食材累加,沒有被拆開
  const second = plain(ai.menuOutcome(first.conv, first.view, { analysisId: 'A', claimToken: 'TA', summary: '菜單2', ingredients: [{ name: '豬五花' }] }));
  assert.deepEqual(second.conv, { analysisId: 'A', claimToken: 'TA' });
  assert.equal(second.split, false);
  assert.deepEqual(second.view.ingredients.map((i) => i.name), ['高麗菜', '豬五花']);
  // 後端回的已經是合併後的清單也沒關係(合併兩次結果一樣);沒回摘要就沿用上一個
  const third = plain(ai.menuOutcome(second.conv, second.view, { analysisId: 'A', claimToken: 'TA', ingredients: [{ name: '高麗菜' }, { name: '豬五花' }, { name: '蛤蜊' }] }));
  assert.deepEqual(third.view.ingredients.map((i) => i.name), ['高麗菜', '豬五花', '蛤蜊']);
  assert.equal(third.view.summary, '菜單2');
  // 留聯絡方式時:analysis_id 指的那筆,跟 items_text 一定對得上
  const row = plain(ai.leadRow({ name: 'x', email: 'a@b.co' }, third.view, [], third.conv.analysisId, ''));
  assert.equal(row.analysis_id, 'A');
  assert.equal(row.items_text, '高麗菜、豬五花、蛤蜊');

  // 舊版 ai:每張都回新的一組 → 換成最新那組(最新的一定還有效),食材只算那一筆的,記成「被拆開」
  const old = plain(ai.menuOutcome(first.conv, first.view, { analysisId: 'B', claimToken: 'TB', summary: '菜單2', ingredients: [{ name: '豬五花' }] }));
  assert.deepEqual(old, { conv: { analysisId: 'B', claimToken: 'TB' }, view: { summary: '菜單2', ingredients: [{ name: '豬五花' }] }, split: true });
  // 更舊的 ai(沒有 claimToken)
  const legacy = plain(ai.menuOutcome({ analysisId: 'L1', claimToken: null }, { summary: 's', ingredients: [{ name: 'x' }] }, { analysisId: 'L2', ingredients: [{ name: 'y' }] }));
  assert.deepEqual(legacy.conv, { analysisId: 'L2', claimToken: null });
  assert.equal(legacy.split, true);
  // 存檔失敗(analysisId: null):手上那組不動、食材照樣累加
  const failed = plain(ai.menuOutcome(first.conv, first.view, { analysisId: null, persistError: 'x', ingredients: [{ name: '雞蛋' }] }));
  assert.deepEqual(failed.conv, first.conv);
  assert.equal(failed.split, false);
  assert.deepEqual(failed.view.ingredients.map((i) => i.name), ['高麗菜', '雞蛋']);

  // 只傳照片、沒打字:沒被拆開就直接交接手上那組;被舊版 ai 拆開了才再存一次(靠每張菜單的 note 併進同一筆)
  assert.equal(ai.exitNeedsSave(0, false), false);
  assert.equal(ai.exitNeedsSave(0, true), true);
  assert.equal(ai.exitNeedsSave(1, false), true);
  assert.match(fnBody('saveForExit'), /if \(!exitNeedsSave\(userTextCount\(history\), recordsSplit\)\) return Promise\.resolve\(false\);/);
  assert.match(fnBody('renderAnalysis'), /conv\.analysisId = outcome\.conv\.analysisId;\s*conv\.claimToken = outcome\.conv\.claimToken;\s*lastAnalysis = outcome\.view;\s*if \(outcome\.split\) recordsSplit = true;/);
  // 存檔的回應是那筆紀錄的權威版本(後端合併後的清單)
  assert.match(fnBody('postExtract'), /if \(j\.data\.ingredients && j\.data\.ingredients\.length\) lastAnalysis = \{ summary: j\.data\.summary \|\| '', ingredients: j\.data\.ingredients \};/);
  assert.match(fnBody('saveLead'), /leadRow\(\{[\s\S]*?\}, lastAnalysis, history, conv\.analysisId, navigator\.userAgent\)/);
});

// ── 修訂 2 R4:Email 規則全站統一 ─────────────────────────────────────────────
test('R4. widget 與異業合作表單用同一條 Email regex(一字不差)+ 長度 ≤ 254', () => {
  const R4 = '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)+[A-Za-z]{2,}$';
  const widgetRule = fnBody('validEmail').match(/return s\.length <= 254 && \/(\^[^\n]+\$)\/\.test\(s\);/);
  assert.ok(widgetRule, 'validEmail 要是「長度 ≤ 254 && regex」');
  assert.equal(widgetRule[1], R4);
  const start = rawSource.indexOf('submitPartnership(event) {');
  const form = rawSource.slice(start, rawSource.indexOf('\n  handToAI(', start));
  const formRule = form.match(/const emailOk = data\.contact_email\.length <= 254 && \/(\^[^\n]+\$)\/\.test\(data\.contact_email\);/);
  assert.ok(formRule, '異業合作表單的 emailOk 要是「長度 ≤ 254 && regex」');
  assert.equal(formRule[1], R4);
  assert.doesNotMatch(widget + form, /\[\^\\s@\]\+@/, '舊的寬鬆規則不能留著');
  // DB 那邊(最後一個定義 Email constraint 的 migration)也要是同一條,四處一字不差
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  for (const name of ['landing_leads_contact_email_format', 'partnership_leads_contact_email_format']) {
    const hit = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .filter((f) => new RegExp(`ADD CONSTRAINT ${name} CHECK`, 'i').test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.ok(hit.length, `migrations 裡找不到 ${name}`);
    const sql = fs.readFileSync(path.join(dir, hit[hit.length - 1]), 'utf8');
    const from = sql.search(new RegExp(`ADD CONSTRAINT ${name} CHECK`, 'i'));
    const block = sql.slice(from, sql.indexOf(';', from));
    assert.ok(block.includes(`char_length(contact_email) <= 254 AND contact_email ~ '${R4}'`), `${name} 的規則跟前端不一致`);
  }

  for (const good of ['chef@restaurant.tw', 'a.b+tag@sub.example.co', 'x_y-z%1@a-b.c-d.com.tw', 'UPPER@EXAMPLE.ORG']) {
    assert.equal(ai.validEmail(good), true, good);
  }
  for (const bad of ['a@b..c', 'a@b.c', 'a@.tw', 'chef@restaurant.tw,', 'chef@restaurant.tw;', 'a@b.tw, c@d.tw', 'a@b.tw c@d.tw', 'a b@c.tw', '王小明@例子.台灣', 'a@b.c1', 'a@b_c.tw']) {
    assert.equal(ai.validEmail(bad), false, bad);
  }
  const local = 'a'.repeat(64);
  const exact = `${local}@${'b'.repeat(254 - local.length - 1 - 3)}.tw`;
  assert.equal(ai.validEmail(exact), true);
  assert.equal(ai.validEmail('c' + exact), false);
});

// ── 修訂 2 R10:widget 補強 ───────────────────────────────────────────────────
test('R10a. 留聯絡方式問到一半可以「改成免費註冊」或「取消」,對話與交接資料都留著', () => {
  const cta = fnBody('showCTA');
  assert.match(cta, /if \(collect\.active\) \{\s*var cancel = document\.createElement\('button'\);\s*cancel\.type = 'button'; cancel\.className = 'ai-cta-alt'; cancel\.setAttribute\('data-cta', 'cancel'\);\s*cancel\.textContent = txt\('ctaCancelLead'\);\s*cancel\.addEventListener\('click', cancelCollect\);/);
  // 註冊那顆一直都在(收集中改叫「改成免費註冊」),按下去走同一個 goRegister(帶交接)
  assert.ok(cta.indexOf("reg.setAttribute('data-cta', 'register')") < cta.indexOf('if (collect.active)'));
  assert.match(cta, /reg\.addEventListener\('click', function \(\) \{ goRegister\(reg\); \}\);/);
  assert.equal(dict('zh').ai.ctaSwitchRegister, '改成免費註冊 →');
  // 以前按「留 Email」會把整組 CTA 拿掉、收集中什麼出口都沒有;現在每一步之後都重出一組
  assert.match(fnBody('startCollect'), /LEAD_AREAS\);\s*showCTA\(\);/);
  assert.match(fnBody('collectAnswer'), /LEAD_FREQS\);\s*showCTA\(\);[^\n]*\n\s*syncComposer\(\);/);
  // 取消:只重設收集狀態,對話紀錄、analysisId / claimToken、存檔佇列一概不動
  const cancel = fnBody('cancelCollect');
  assert.match(cancel, /if \(!collect\.active \|\| collect\.sending \|\| registering\) return;\s*collect\.active = false; collect\.step = ''; collect\.area = ''; collect\.frequency = ''; collect\.who = '';\s*clearChips\(\);\s*addMsg\('bot', txt\('leadCancelled'\)\);\s*showCTA\(\);/);
  assert.doesNotMatch(cancel, /history|conv\.|saveChain|lastAnalysis|recordsSplit|savedUserCount/);
  // 送出的那幾秒兩個出口都暫停(不會一邊寫 lead 一邊跳頁)
  assert.match(fnBody('saveLead'), /collect\.sending = true;\s*setCTADisabled\(true\);/);
  assert.match(fnBody('saveLead'), /collect\.sending = false;/);
  assert.match(fnBody('goRegister'), /if \(registering \|\| collect\.sending\) return;/);
  assert.match(fnBody('applyStaticStrings'), /\.ai-cta-row \[data-cta="cancel"\]'\);\s*if \(cancel\) cancel\.textContent = txt\('ctaCancelLead'\);/);
});

test('R10b. 10 分鐘級 RATE_LIMITED:「請 N 分鐘後再試,或先免費註冊」,時間到自動解鎖;CONVERSATION_LIMIT / DAILY_CAP / 天級維持鎖住', () => {
  assert.equal(ai.AI_LIMITS.cooldownMaxSeconds, 600);
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED', retryAfterSeconds: 120 }), 120);
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED', retryAfterSeconds: 600 }), 600);
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED', retryAfterSeconds: 601 }), 0, '超過 10 分鐘 = 天級');
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED', retryAfterSeconds: 0.4 }), 1);
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED' }, '90'), 90, 'body 沒給秒數就看 Retry-After header');
  assert.equal(ai.cooldownSeconds(429, { code: 'RATE_LIMITED' }, null), 0, '都沒給 → 維持鎖住');
  assert.equal(ai.cooldownSeconds(429, { code: 'CONVERSATION_LIMIT', retryAfterSeconds: 60 }), 0);
  assert.equal(ai.cooldownSeconds(429, { code: 'DAILY_CAP', retryAfterSeconds: 60 }), 0);
  assert.equal(ai.cooldownSeconds(200, { code: 'RATE_LIMITED', retryAfterSeconds: 60 }), 0);
  for (const kind of ['text', 'image']) {
    assert.equal(ai.classifyFailure(429, { code: 'RATE_LIMITED', retryAfterSeconds: 300 }, kind), 'cooldown', kind);
  }
  assert.equal(ai.classifyFailure(429, { code: 'RATE_LIMITED' }, 'text', '120'), 'cooldown');

  assert.match(fnBody('postJSON'), /retryAfter: r\.headers\.get\('Retry-After'\)/);
  assert.match(fnBody('handleFailure'), /if \(why === 'cooldown'\) \{ coolDown\(cooldownSeconds\(r\.status, r\.json, r\.retryAfter\)\); return; \}/);
  const cool = fnBody('coolDown');
  assert.match(cool, /locked = 'cooldown';\s*addMsg\('bot', txtf\('rateLimitedWait', \{ minutes: Math\.max\(1, Math\.ceil\(seconds \/ 60\)\) \}\)\);/);
  assert.match(cool, /cooldownTimer = setTimeout\(function \(\) \{\s*if \(locked !== 'cooldown'\) return;\s*locked = '';\s*syncComposer\(\);\s*addMsg\('bot', txt\('quotaResumed'\)\);\s*pumpImages\(\);\s*\}, seconds \* 1000\);/);
  // 冷卻中撞到永久鎖(例如 20 則滿了):升級成永久鎖,計時器取消
  assert.match(fnBody('lockFor'), /if \(!locked \|\| locked === 'cooldown'\) \{\s*clearTimeout\(cooldownTimer\);/);
  assert.match(fnBody('currentPlaceholder'), /if \(locked === 'cooldown'\) return txt\('placeholderCooldown'\);/);
  assert.equal(dict('zh').ai.rateLimitedWait, '請 {minutes} 分鐘後再試，或先免費註冊');
  assert.equal(format(dict('zh').ai.rateLimitedWait, { minutes: 3 }), '請 3 分鐘後再試，或先免費註冊');
});

test('R10c. 按了註冊卻沒導走:location.assign 之後 8 秒還在原頁、或 bfcache 還原,註冊按鈕都恢復', () => {
  assert.equal(ai.AI_LIMITS.navigateGraceMs, 8000);
  const go = fnBody('goRegister');
  assert.ok(go.indexOf('setTimeout(resetRegistering, AI_LIMITS.navigateGraceMs);') > go.indexOf('window.location.assign('), '計時器要在 assign 之後才開始算');
  const reset = fnBody('resetRegistering');
  assert.match(reset, /if \(!registering\) return;\s*registering = false;\s*setCTADisabled\(false\);/);
  assert.match(reset, /if \(reg\) reg\.textContent = registerLabel\(\);\s*syncComposer\(\);/);
  assert.match(widget, /window\.addEventListener\('pageshow', function \(e\) \{ if \(e\.persisted\) resetRegistering\(\); \}\);/);
});

test('R10d. 異業合作表單每個欄位的 maxLength 對齊 DB 的長度上限(讀最後一個定義那條 constraint 的 migration)', () => {
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pick = (name) => {
    const hit = files.filter((f) => new RegExp(`ADD CONSTRAINT ${name} CHECK`, 'i').test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.ok(hit.length, `migrations 裡找不到 ${name}`);
    const sql = fs.readFileSync(path.join(dir, hit[hit.length - 1]), 'utf8');
    const from = sql.search(new RegExp(`ADD CONSTRAINT ${name} CHECK`, 'i'));
    return sql.slice(from, sql.indexOf(';', from));
  };
  const limits = {};
  for (const m of pick('partnership_leads_field_lengths').matchAll(/char_length\((\w+)\)\s*<=\s*(\d+)/g)) limits[m[1]] = Number(m[2]);
  const email = pick('partnership_leads_contact_email_format').match(/char_length\(contact_email\)\s*<=\s*(\d+)/);
  assert.ok(email, 'Email constraint 裡找不到長度上限');
  limits.contact_email = Number(email[1]);

  const zh = renderMarkup('zh');
  const contact = zh.slice(zh.indexOf('PAGE: CONTACT'), zh.indexOf('PAGE: NEWS'));
  for (const name of ['company_name', 'contact_name', 'job_title', 'contact_email', 'contact_phone', 'website', 'message']) {
    const tag = contact.match(new RegExp(`<(?:input|textarea)\\b[^>]*\\bname="${name}"[^>]*>`));
    assert.ok(tag, `找不到 ${name} 欄位`);
    const max = tag[0].match(/\bmaxLength="(\d+)"/);
    assert.ok(limits[name], `DB 沒有 ${name} 的長度上限`);
    // 一定要 camelCase:support.js 只把 camelCase 轉成 React 的 maxLength
    assert.ok(max, `${name} 沒有 maxLength`);
    assert.equal(Number(max[1]), limits[name], `${name} 的 maxLength 要等於 DB 上限 ${limits[name]}`);
  }
  // 合作類型是固定選項:每個 value 都在 DB 上限內
  for (const m of contact.matchAll(/<option value="([a-z]+)">/g)) {
    assert.ok(m[1].length <= limits.partner_type, `partner_type 的 ${m[1]} 超過 ${limits.partner_type}`);
  }
});
