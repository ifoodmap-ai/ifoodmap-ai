// cart.ts:按店家分組、運費、免運、最低訂購金額、配送縣市、庫存、下架商品、localStorage 資料清洗。
// 金額跟資料庫測試同一組(market_checkout.test.sql):A 店 200+450+運費 120 = 770;B 店 200+運費 60 = 260。
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { addLine, buildCart, CART_LIMITS, cartCount, isCartFull, parseCart, removeLines, setLineQty, shippingFeeFor } from "./cart";
import { BEEF, CABBAGE, SALMON, STORE_A, STORE_B } from "./testFixtures";

const ALL = [CABBAGE, BEEF, SALMON];
const line = (productId: string, qty: number) => ({ productId, qty });
const uuid = (n: number) => `a9300000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("分組", () => {
  it("按店家分組,店家照第一次加入的順序;同店的商品放一起", () => {
    const { groups, unavailable } = buildCart([line(CABBAGE.id, 2), line(SALMON.id, 1), line(BEEF.id, 1)], ALL);
    expect(groups.map((g) => g.storeName)).toEqual(["市集測試 A 店", "市集測試 B 店"]);
    expect(groups[0].lines.map((l) => l.product.name)).toEqual(["有機高麗菜", "牛肉片"]);
    expect(groups[1].lines.map((l) => [l.product.name, l.lineTotal])).toEqual([["挪威鮭魚", 200]]);
    expect(unavailable).toEqual([]);
  });

  it("小計、運費、總額(跟資料庫算的一樣:770 / 260)", () => {
    const { groups } = buildCart([line(CABBAGE.id, 2), line(BEEF.id, 1), line(SALMON.id, 1)], ALL);
    expect(groups.map((g) => [g.subtotal, g.shippingFee, g.total])).toEqual([
      [650, 120, 770],
      [200, 60, 260],
    ]);
  });
});

describe("運費與免運", () => {
  it("剛好達到免運門檻就免運(≥),差多少顯示出來", () => {
    expect(shippingFeeFor(STORE_A, 999)).toBe(120);
    expect(shippingFeeFor(STORE_A, 1000)).toBe(0);
    const [a] = buildCart([line(CABBAGE.id, 10)], ALL).groups;
    expect([a.subtotal, a.shippingFee, a.total, a.freeShippingRemaining]).toEqual([1000, 0, 1000, null]);
    const [a2] = buildCart([line(CABBAGE.id, 7)], ALL).groups;
    expect(a2.freeShippingRemaining).toBe(300);
  });

  it("沒有免運門檻的店:永遠收運費,不顯示「再買多少免運」", () => {
    expect(shippingFeeFor(STORE_B, 100000)).toBe(60);
    expect(buildCart([line(SALMON.id, 3)], ALL).groups[0].freeShippingRemaining).toBeNull();
  });

  it("運費 0 的店:免運", () => {
    expect(shippingFeeFor({ shipping_fee: 0, free_shipping_threshold: null }, 50)).toBe(0);
  });
});

describe("最低訂購金額", () => {
  it("沒到最低金額:差多少、不能結帳", () => {
    const [a] = buildCart([line(CABBAGE.id, 2)], ALL).groups;
    expect(a.minimumShort).toBe(100);
    expect(a.canCheckout).toBe(false);
    expect(a.problems).toEqual(["還差 NT$ 100 才到這家店的最低訂購金額 NT$ 300"]);
  });

  it("剛好等於最低金額可以結帳;沒有最低金額的店不檢查", () => {
    expect(buildCart([line(CABBAGE.id, 3)], ALL).groups[0]).toMatchObject({ minimumShort: 0, canCheckout: true });
    expect(buildCart([line(SALMON.id, 1)], ALL).groups[0]).toMatchObject({ minimumShort: 0, canCheckout: true });
  });
});

describe("配送縣市", () => {
  it("沒選縣市不檢查;選了就標出不配送的店", () => {
    const lines = [line(CABBAGE.id, 3), line(SALMON.id, 1)];
    expect(buildCart(lines, ALL).groups.map((g) => g.deliverable)).toEqual([null, null]);
    const newTaipei = buildCart(lines, ALL, "新北市").groups;
    expect(newTaipei.map((g) => [g.deliverable, g.canCheckout])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(newTaipei[1].problems).toEqual(["這家店不配送到新北市"]);
  });
});

describe("庫存與下架", () => {
  it("超過庫存:標出來、這家店不能結帳;上限 = 庫存", () => {
    const [b] = buildCart([line(SALMON.id, 5)], ALL).groups;
    expect(b.lines[0]).toMatchObject({ overStock: true, maxQty: 3 });
    expect(b.canCheckout).toBe(false);
    expect(b.problems).toEqual(["有商品超過庫存,請減少數量或移除"]);
  });

  it("售完(庫存 0)也算超過庫存", () => {
    const [b] = buildCart([line(SALMON.id, 1)], [{ ...SALMON, stock: 0 }]).groups;
    expect(b.lines[0]).toMatchObject({ overStock: true, maxQty: 0 });
  });

  it("找不到、沒核准、下架、店家停用的商品放到 unavailable,不算進任何一家店", () => {
    const view = buildCart(
      [line(uuid(999), 1), line(CABBAGE.id, 3), line(BEEF.id, 1), line(SALMON.id, 1)],
      [CABBAGE, { ...BEEF, review_status: "pending" }, { ...SALMON, market_stores: { ...STORE_B, is_enabled: false } }],
    );
    expect(view.unavailable.map((l) => l.productId)).toEqual([uuid(999), BEEF.id, SALMON.id]);
    expect(view.groups.map((g) => g.subtotal)).toEqual([300]);
  });
});

describe("購物車內容(存在 localStorage 的那份)", () => {
  it("壞掉的資料讀回來是空的;不合格的項目丟掉、重複的只留第一筆、數量夾在 1–99", () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart("{not json")).toEqual([]);
    expect(parseCart('{"a":1}')).toEqual([]);
    expect(
      parseCart(
        JSON.stringify([
          { productId: CABBAGE.id, qty: 2 },
          { productId: "not-a-uuid", qty: 1 },
          { productId: CABBAGE.id, qty: 5 },
          { productId: BEEF.id, qty: 500 },
          { productId: SALMON.id, qty: -3 },
          { productId: uuid(77), qty: "2" },
          null,
        ]),
      ),
    ).toEqual([line(CABBAGE.id, 2), line(BEEF.id, 99), line(SALMON.id, 1)]);
  });

  it("最多 50 種商品", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ productId: uuid(i + 1), qty: 1 }));
    expect(parseCart(JSON.stringify(many))).toHaveLength(CART_LIMITS.maxLines);
  });

  it("加入:同商品合併、不超過庫存;滿 50 種就加不進新商品", () => {
    let lines = addLine([], CABBAGE.id, 2, 10);
    lines = addLine(lines, CABBAGE.id, 9, 10);
    expect(lines).toEqual([line(CABBAGE.id, 10)]);
    const full = Array.from({ length: 50 }, (_, i) => line(uuid(i + 1), 1));
    expect(isCartFull(full, BEEF.id)).toBe(true);
    expect(isCartFull(full, uuid(1))).toBe(false);
    expect(addLine(full, BEEF.id, 1)).toBe(full);
  });

  it("改數量夾在 1 到上限;移除;數量加總", () => {
    const lines = [line(CABBAGE.id, 2), line(BEEF.id, 1)];
    expect(setLineQty(lines, CABBAGE.id, 0)).toEqual([line(CABBAGE.id, 1), line(BEEF.id, 1)]);
    expect(setLineQty(lines, CABBAGE.id, 50, 10)).toEqual([line(CABBAGE.id, 10), line(BEEF.id, 1)]);
    expect(removeLines(lines, [CABBAGE.id])).toEqual([line(BEEF.id, 1)]);
    expect(cartCount(lines)).toBe(3);
  });
});
