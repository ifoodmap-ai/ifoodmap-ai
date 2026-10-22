// @vitest-environment node
//
// 掃原始碼:顯示成交 / GMV / 採購金額 / 訂單數的頁面,一律從 src/lib/metrics.ts 取定義(業主拍板 Q5-A)。
// 頁面測試只能證明「數字跟共用定義一致」;如果有人在頁面上抄一份語意相同的狀態清單,數字照樣對,
// 但下次改定義時那一頁就會漏改 —— 這支測試專門擋「抄一份清單」,
// 以及「算成交卻沒讀收貨事件」(已結案的單要收過貨才算成交,判斷靠 order_events)。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEAL_STATUSES,
  EXCLUDED_ORDER_STATUSES,
  IN_PROGRESS_STATUSES,
  RECEIPT_REQUIRED_STATUSES,
} from './metrics';

/** 會變成 GMV 的狀態(一定算的 + 收過貨才算的) */
const GMV_CANDIDATES: readonly string[] = [...DEAL_STATUSES, ...RECEIPT_REQUIRED_STATUSES];

/** 算成交的共用函式:用到任何一個,就一定要有收貨帳本 */
const DEAL_FUNCTIONS = ['isDeal', 'dealOrders', 'countDeals', 'sumGmv', 'pricedDeals', 'averageDealAmount'];

const ROOT = resolve(__dirname, '../..');

/** 用到這些數字的頁面(新增頁面時請加進來) */
const PAGES = [
  'src/pages/admin/AdminDashboard.tsx',
  'src/pages/admin/AdminGrowthPage.tsx',
  'src/pages/admin/AdminRevenuePage.tsx',
  'src/pages/admin/AdminMatchQualityPage.tsx',
  'src/pages/admin/AdminSuppliersPage.tsx',
  'src/pages/admin/AdminRestaurantsPage.tsx',
  'src/pages/supplier/SupplierDashboard.tsx',
  'src/pages/supplier/SupplierCustomersPage.tsx',
  'src/pages/restaurant/RestaurantDashboard.tsx',
  'src/pages/restaurant/RestaurantReportsPage.tsx',
  'src/pages/supplier/SupplierInvoiceCreatePage.tsx',
  'src/pages/restaurant/RestaurantSuppliersPage.tsx',
];

/** 刻意保留的狀態清單:不是成交 / 採購的定義(變數名 → 用途) */
const ALLOWED_LISTS: Record<string, string> = {
  RESPONDED_STATUSES: '供應商回覆率:接單、報價、拒單以及之後的所有階段(跟成交定義無關,改成交定義時不該跟著變)',
  LOST_STATUSES: '派發後供應商沒接單:待接單、已派發、拒單、逾時',
};

/** 以前各頁自己定義的清單名稱 —— 不准再出現 */
const FORBIDDEN_NAMES = [
  'DEAL_STATUSES',
  'WON_STATUSES',
  'RECEIVED_STATUSES',
  'VOID_STATUS',
  'VOID_STATUSES',
  'EXCLUDED_STATUSES',
  'NOT_PLACED',
];

const source = (file: string) =>
  readFileSync(resolve(ROOT, file), 'utf8')
    // 拿掉註解,只看程式碼(`//` 前面是冒號的是網址,留著)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 所有「只由引號字串組成的陣列」:['a', 'b'] / ["a","b"](可跨行) */
const stringArrays = (src: string) =>
  [...src.matchAll(/\[\s*((?:'[^'\n]*'|"[^"\n]*")(?:\s*,\s*(?:'[^'\n]*'|"[^"\n]*"))*)\s*,?\s*\]/g)].map((m) => ({
    items: [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]),
    // 陣列前面那一小段,用來判斷它是不是被指派給允許的變數
    before: src.slice(Math.max(0, (m.index ?? 0) - 80), m.index),
    text: m[0].replace(/\s+/g, ' '),
  }));

const isAllowed = (before: string) => Object.keys(ALLOWED_LISTS).some((name) => before.includes(name));

const countIn = (items: string[], set: readonly string[]) => items.filter((s) => set.includes(s)).length;

/** 看起來像在重寫共用定義的清單:≥2 個成交狀態、≥2 個不算訂單的狀態,或 ≥4 個在途狀態 */
const looksLikeDefinition = (items: string[]) =>
  countIn(items, GMV_CANDIDATES) >= 2 ||
  countIn(items, EXCLUDED_ORDER_STATUSES) >= 2 ||
  countIn(items, IN_PROGRESS_STATUSES) >= 4;

describe('共用定義守門:頁面不准自己抄狀態清單', () => {
  it.each(PAGES)('%s 從 @/lib/metrics 取定義', (file) => {
    expect(source(file)).toMatch(/from ['"]@\/lib\/metrics['"]/);
  });

  it.each(PAGES)('%s 沒有自己寫成交 / 不算訂單的狀態清單', (file) => {
    const offenders = stringArrays(source(file))
      .filter(({ items }) => looksLikeDefinition(items))
      .filter(({ before }) => !isAllowed(before))
      .map(({ text }) => text);
    expect(offenders).toEqual([]);
  });

  it.each(PAGES)('%s 算成交時有讀收貨事件、做成帳本(已結案要收過貨才算)', (file) => {
    const src = source(file);
    const usesDeals = DEAL_FUNCTIONS.some((fn) => new RegExp(`\\b${fn}\\(`).test(src));
    if (!usesDeals) return;
    expect(src).toContain('dealLedger(');
    expect(src).toContain("'order_events'");
  });

  it.each(PAGES)('%s 沒有自己判斷「已結案算不算成交」', (file) => {
    expect(source(file)).not.toMatch(/status\s*[!=]==?\s*['"]closed['"]/);
  });

  it.each(PAGES)('%s 沒有再定義舊的狀態清單名稱', (file) => {
    const src = source(file);
    const found = FORBIDDEN_NAMES.filter((name) => new RegExp(`\\b${name}\\s*[:=]`).test(src));
    expect(found).toEqual([]);
  });

  it('守門規則本身有效:抄一份成交清單、或排除草稿與取消的清單,都會被抓到', () => {
    const hits = (code: string) => stringArrays(code).filter(({ items }) => looksLikeDefinition(items)).length;
    expect(hits("orders.filter((o) => ['received', 'reviewed', 'closed', 'completed'].includes(o.status))")).toBe(1);
    expect(hits('const X = new Set(["draft",\n  "cancelled"]);')).toBe(1);
    expect(hits("['submitted', 'dispatched', 'accepted', 'quoted', 'confirmed']")).toBe(1);
    expect(hits("earliestOf(o.id, ['dispatched', 'sent'])")).toBe(0);
    expect(hits("earliestOf(o.id, ['accepted', 'quoted', 'rejected'])")).toBe(0);
    expect(hits("['received', 'closed']")).toBe(1); // 自己把 closed 當成交
  });

  it('允許清單都還真的存在(不然就該從白名單拿掉)', () => {
    const all = PAGES.map(source).join('\n');
    Object.keys(ALLOWED_LISTS).forEach((name) => expect(all).toContain(name));
  });
});
