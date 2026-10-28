// 「叫貨」分頁:過往叫過的品項進頁就全部列出(不用一個個手動加入),
// 數量可用 ± 或直接輸入調整,不要的可以刪,每一列都能填參考價。
// supabase 換成記憶體假資料,記錄每次寫入,並擋掉所有網路請求。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { addDays, earliestDeliveryDate, taipeiNow } from "@/lib/delivery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantPurchasePage from "./RestaurantPurchasePage";

type Filter = [op: string, col: string, val: unknown];
interface Call { table: string; op: string; values?: unknown; filters: Filter[] }

const { state, recordOrderEvent, toast } = vi.hoisted(() => ({
  state: {
    calls: [] as Call[],
    history: [] as Record<string, unknown>[],
    supplies: [] as Record<string, unknown>[],
    suppliesFail: false,
    /** 這家店已綁定的合作供應商 */
    bound: ["sup-1"] as string[],
    /** 供應商的接單規則(supplier_order_settings) */
    rules: [] as Record<string, unknown>[],
    /** 這家店的專屬價格、數量上限 */
    prices: [] as Record<string, unknown>[],
    /** 這家店所屬群組的群組價 */
    groupPrices: [] as Record<string, unknown>[],
    limits: [] as Record<string, unknown>[],
    role: "owner" as "owner" | "manager" | "purchaser",
  },
  recordOrderEvent: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fakeFrom = (table: string) => {
  const call: Call = { table, op: "select", filters: [] };
  const result = () => {
    state.calls.push(call);
    if (table === "supplier_order_settings") return { data: state.rules, error: null };
    if (table === "supplier_customer_prices") return { data: state.prices, error: null };
    if (table === "supplier_group_prices") return { data: state.groupPrices, error: null };
    if (table === "supplier_customer_limits") return { data: state.limits, error: null };
    if (table === "restaurant_suppliers") return { data: state.bound.map((id) => ({ supplier_id: id })), error: null };
    if (table === "suppliers") {
      const all = [{ id: "sup-1", name: "阿明蔬果", is_active: true }, { id: "sup-2", name: "大海水產", is_active: true }, { id: "sup-3", name: "已歇業行", is_active: false }];
      return { data: all.filter((x) => state.bound.includes(x.id)), error: null };
    }
    if (table === "supplies") {
      if (state.suppliesFail) throw new Error("supplies 讀取失敗");
      return { data: state.supplies, error: null };
    }
    if (table !== "supplier_orders") return { data: [], error: null };
    if (call.op === "insert") return { data: { id: "new-order-1" }, error: null };
    const onlyDrafts = call.filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "draft");
    return { data: onlyDrafts ? [] : state.history, error: null };
  };
  const builder = {
    select: () => builder,
    insert: (values: unknown) => { call.op = "insert"; call.values = values; return builder; },
    update: (values: unknown) => { call.op = "update"; call.values = values; return builder; },
    eq: (col: string, val: unknown) => { call.filters.push(["eq", col, val]); return builder; },
    in: (col: string, val: unknown) => { call.filters.push(["in", col, val]); return builder; },
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(result()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled, onRejected),
  };
  return builder;
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (t: string) => fakeFrom(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-owner" } } }) },
  },
}));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: "branch-1",
    role: state.role,
    restaurant_name: "好味小館",
  }),
  canSeeCost: () => true,
  needsApproval: () => false,
}));

vi.mock("./RestaurantAnalyzePage", () => ({ ANALYSIS_HANDOFF_KEY: "ifm_analysis_handoff" }));
vi.mock("@/lib/orders", () => ({ recordOrderEvent }));
vi.mock("sonner", () => ({ toast }));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const order = (id: string, createdAt: string, ingredient_list: unknown[], status = "completed") => ({
  id, created_at: createdAt, status, ingredient_list, created_by: "user-owner", approved_by: null, notes: null, supplier_id: "sup-1",
});

// 高麗菜叫過兩次(週期 7 天、上次 10 天前 → 該補貨);雞蛋只叫過一次
const HISTORY = [
  order("o-3", daysAgo(10), [
    { name: "高麗菜", quantity: "5", unit: "kg", reference_price: 35 },
    { name: "雞蛋", quantity: "2", unit: "箱" },
  ]),
  order("o-2", daysAgo(17), [{ name: "高麗菜", quantity: "4", unit: "kg" }]),
];

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/purchase"]}>
      <RestaurantPurchasePage />
    </MemoryRouter>,
  );

const rowOf = async (name: string) => {
  const rows = await screen.findAllByTestId("history-item");
  const row = rows.find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`找不到 ${name} 這一列`);
  return row;
};

const insertedList = () => {
  const insert = state.calls.find((c) => c.op === "insert");
  return (insert?.values as { ingredient_list: Record<string, unknown>[] }).ingredient_list;
};

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.calls = [];
  state.history = HISTORY.map((o) => ({ ...o }));
  state.supplies = [];
  state.suppliesFail = false;
  state.bound = ["sup-1"];
  state.rules = [];
  state.prices = [];
  state.groupPrices = [];
  state.limits = [];
  state.role = "owner";
  recordOrderEvent.mockReset();
  recordOrderEvent.mockResolvedValue({});
  toast.error.mockReset();
  sessionStorage.clear();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

describe("RestaurantPurchasePage — 過往叫貨品項自動列出", () => {
  it("叫過的品項全部列出(包含只叫過一次的),不用手動加入;該補貨的排最前面並標示", async () => {
    renderPage();

    const rows = await screen.findAllByTestId("history-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("高麗菜");
    expect(within(rows[0]).getByText("該補貨了")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("雞蛋");
    expect(within(rows[1]).queryByText("該補貨了")).toBeNull();
    // 數量、單位、參考價帶入「最近一次」叫貨時的值
    expect(within(rows[0]).getByLabelText("高麗菜 數量")).toHaveValue("5");
    expect(within(rows[0]).getByLabelText("高麗菜 參考價")).toHaveValue("35");
    expect(screen.getByTestId("order-summary")).toHaveTextContent("目前共 2 項");
  });

  it("按 + / − 調整數量,最少停在 1", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("高麗菜");

    await user.click(within(row).getByRole("button", { name: "高麗菜 數量加 1" }));
    expect(within(row).getByLabelText("高麗菜 數量")).toHaveValue("6");

    for (let i = 0; i < 8; i++) await user.click(within(row).getByRole("button", { name: "高麗菜 數量減 1" }));
    expect(within(row).getByLabelText("高麗菜 數量")).toHaveValue("1");
  });

  it("也可以直接輸入數字,送出時用輸入的數量;只收數字", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    const qty = within(row).getByLabelText("雞蛋 數量");
    await user.clear(qty);
    await user.type(qty, "a1b2.5");
    expect(qty).toHaveValue("12.5");

    await user.click(screen.getByRole("button", { name: "送出訂單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());
    expect(insertedList().find((i) => i.name === "雞蛋")).toEqual(
      expect.objectContaining({ quantity: "12.5", unit: "箱" }),
    );
  });

  it("可以刪掉不要的品項,送出的單就不含它;刪掉的可以點一下加回", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "移除 雞蛋" }));
    expect(screen.getAllByTestId("history-item")).toHaveLength(1);
    expect(screen.getByTestId("order-summary")).toHaveTextContent("目前共 1 項");

    await user.click(screen.getByRole("button", { name: "+ 雞蛋" }));
    expect(screen.getAllByTestId("history-item")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "移除 雞蛋" }));
    await user.click(screen.getByRole("button", { name: "送出訂單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());
    expect(insertedList().map((i) => i.name)).toEqual(["高麗菜"]);
  });

  it("每一列都能填參考價,送出時寫進品項;沒填的不帶這個欄位", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    await user.type(within(row).getByLabelText("雞蛋 參考價"), "620");
    await user.click(screen.getByRole("button", { name: "送出訂單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());

    const list = insertedList();
    expect(list.find((i) => i.name === "雞蛋")).toEqual(expect.objectContaining({ reference_price: 620 }));
    expect(list.find((i) => i.name === "高麗菜")).toEqual(expect.objectContaining({ reference_price: 35 }));

    // 沒填參考價的品項不該帶 reference_price
    expect(list.every((i) => i.reference_price === undefined || typeof i.reference_price === "number")).toBe(true);
  });

  it("手動加入的品項也能填參考價", async () => {
    const user = userEvent.setup();
    state.history = [];
    renderPage();

    await user.type(await screen.findByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
    await user.type(screen.getByLabelText("參考價"), "480");
    await user.click(screen.getByRole("button", { name: "加入" }));
    await user.click(screen.getByRole("button", { name: "送出訂單" }));
    await waitFor(() => expect(recordOrderEvent).toHaveBeenCalled());

    expect(insertedList()).toEqual([
      expect.objectContaining({ name: "牛肉", quantity: "1", reference_price: 480, source: "manual" }),
    ]);
  });

  it("數量空白或 0 時擋下,不建單", async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await rowOf("雞蛋");

    await user.clear(within(row).getByLabelText("雞蛋 數量"));
    await user.click(screen.getByRole("button", { name: "送出訂單" }));

    expect(toast.error).toHaveBeenCalledWith("請確認每一項的數量", expect.anything());
    expect(state.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("還沒有叫貨紀錄時顯示說明,不是空白", async () => {
    state.history = [];
    renderPage();
    expect(await screen.findByText("還沒有叫過貨的品項")).toBeInTheDocument();
  });

  describe("商品縮圖", () => {
    const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    it("品名配得到往來供應商上架的商品圖片就顯示縮圖,配不到的顯示品名第一個字的佔位", async () => {
      state.supplies = [
        { supplier_id: "sup-1", name: "高麗菜", image_path: `sup-1/p-1/${FILE}.jpg` },
        { supplier_id: "sup-1", name: "雞蛋心", image_path: `sup-1/p-2/${FILE}.jpg` },
      ];
      renderPage();

      const cabbage = await rowOf("高麗菜");
      await waitFor(() => expect(within(cabbage).getByRole("img", { name: "高麗菜" })).toBeInTheDocument());
      expect(within(cabbage).getByRole("img", { name: "高麗菜" }).getAttribute("src")).toContain(`/sup-1/p-1/${FILE}_t.jpg`);

      const egg = await rowOf("雞蛋");
      expect(within(egg).queryByRole("img")).toBeNull();
      expect(egg).toHaveTextContent("雞");
    });

    it("只查往來過的供應商", async () => {
      renderPage();
      await screen.findAllByTestId("history-item");
      const q = state.calls.find((c) => c.table === "supplies");
      expect(q?.filters).toContainEqual(["in", "supplier_id", ["sup-1"]]);
    });

    it("手動加入的品項,品名跟往來供應商的商品一樣也會帶出縮圖", async () => {
      state.supplies = [{ supplier_id: "sup-1", name: "牛肉", image_path: `sup-1/p-5/${FILE}.jpg` }];
      const user = userEvent.setup();
      renderPage();
      await screen.findAllByTestId("history-item");

      await user.type(screen.getByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
      await user.click(screen.getByRole("button", { name: "加入" }));
      const img = await screen.findByRole("img", { name: "牛肉" });
      expect(img.getAttribute("src")).toContain(`/sup-1/p-5/${FILE}_t.jpg`);
    });

    it("讀商品圖片失敗不影響叫貨:清單照常列出", async () => {
      state.suppliesFail = true;
      renderPage();
      expect(await screen.findAllByTestId("history-item")).toHaveLength(2);
      expect(screen.queryByRole("img")).toBeNull();
    });
  });

  describe("選合作供應商,直接叫貨", () => {
    const orderTo = (id: string, supplier: string, at: string, items: unknown[]) => ({ ...order(id, at, items), supplier_id: supplier });

    it("預設選最近叫過貨的供應商;每家各自列自己叫過的品項,切換供應商清單跟著換", async () => {
      state.bound = ["sup-1", "sup-2"];
      state.history = [
        orderTo("o-9", "sup-2", daysAgo(3), [{ name: "吳郭魚", quantity: "4", unit: "kg" }]),
        orderTo("o-3", "sup-1", daysAgo(10), [{ name: "高麗菜", quantity: "5", unit: "kg" }]),
      ];
      const user = userEvent.setup();
      renderPage();

      expect(await screen.findByRole("radio", { name: "大海水產" })).toHaveAttribute("aria-checked", "true");
      expect((await screen.findAllByTestId("history-item")).map((r) => r.textContent)).toEqual([expect.stringContaining("吳郭魚")]);

      await user.click(screen.getByRole("radio", { name: "阿明蔬果" }));
      const rows = screen.getAllByTestId("history-item");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("高麗菜");
      expect(screen.getByTestId("order-summary")).toHaveTextContent("向 阿明蔬果 叫貨,目前共 1 項");
    });

    it("網址帶 ?supplier=… 就預選那一家(從「我的供應商」按「向他叫貨」過來)", async () => {
      state.bound = ["sup-1", "sup-2"];
      state.history = [orderTo("o-9", "sup-2", daysAgo(3), [{ name: "吳郭魚", quantity: "4", unit: "kg" }])];
      render(
        <MemoryRouter initialEntries={["/restaurant/purchase?supplier=sup-1"]}>
          <RestaurantPurchasePage />
        </MemoryRouter>,
      );
      expect(await screen.findByRole("radio", { name: "阿明蔬果" })).toHaveAttribute("aria-checked", "true");
    });

    it("送出:訂單直接進供應商的待接單(draft → dispatched),帶著選的供應商,不經管理員派發", async () => {
      state.bound = ["sup-1", "sup-2"];
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("radio", { name: "大海水產" }));
      await user.type(screen.getByPlaceholderText("食材名稱,例:高麗菜"), "吳郭魚");
      await user.click(screen.getByRole("button", { name: "加入" }));
      await user.click(screen.getByRole("button", { name: "送出訂單" }));

      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      expect(recordOrderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ fromStatus: "draft", toStatus: "dispatched", payload: expect.objectContaining({ supplier_id: "sup-2" }) }),
      );
      expect(insertedList().map((i) => i.name)).toEqual(["吳郭魚"]);
    });

    it("沒有綁定任何供應商:不能叫貨,引導到「我的供應商」綁定(老闆 / 店長有按鈕文字不同)", async () => {
      state.bound = [];
      renderPage();
      const empty = await screen.findByTestId("no-partners");
      expect(empty).toHaveTextContent("還沒有綁定合作供應商");
      expect(within(empty).getByRole("link", { name: /去綁定合作供應商/ })).toHaveAttribute("href", "/restaurant/suppliers");
      expect(screen.queryByRole("button", { name: "送出訂單" })).toBeNull();
    });

    it("已歇業的供應商不能選(綁定了也一樣)", async () => {
      state.bound = ["sup-1", "sup-3"];
      renderPage();
      await screen.findByRole("radio", { name: "阿明蔬果" });
      expect(screen.queryByRole("radio", { name: "已歇業行" })).toBeNull();
    });

    it("叫貨被資料庫擋下(例如剛好被解除綁定):顯示原因,並把剛建的草稿取消,不留在待簽核區", async () => {
      recordOrderEvent.mockRejectedValueOnce(new Error("只能向已綁定的合作供應商叫貨,請先到「我的供應商」綁定"));
      const user = userEvent.setup();
      renderPage();
      await rowOf("高麗菜");
      await user.click(screen.getByRole("button", { name: "送出訂單" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("送出失敗", { description: expect.stringContaining("只能向已綁定的合作供應商叫貨") }));
      expect(recordOrderEvent).toHaveBeenCalledTimes(2);
      expect(recordOrderEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ orderId: "new-order-1", fromStatus: "draft", toStatus: "cancelled" }),
      );
    });

    it("沒有供應商的舊單(還在媒合)不列進叫貨品項", async () => {
      state.history = [
        { ...order("o-1", daysAgo(5), [{ name: "媒合中的品項", quantity: "1", unit: "kg" }], "submitted"), supplier_id: null },
        ...HISTORY.map((o) => ({ ...o })),
      ];
      renderPage();
      await screen.findAllByTestId("history-item");
      expect(screen.queryByText("媒合中的品項")).toBeNull();
    });
  });

  describe("配送日與截單時間", () => {
    const RULES = { supplier_id: "sup-1", cutoff_time: "22:00:00", lead_days: 1, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] };
    const dateInput = () => screen.getByLabelText(/配送日/) as HTMLInputElement;
    const change = (value: string) => fireEvent.change(dateInput(), { target: { value } });

    it("供應商有設接單規則:顯示規則說明,配送日預設最早能選的那天", async () => {
      state.rules = [RULES];
      renderPage();
      await screen.findAllByTestId("history-item");

      expect(screen.getByTestId("delivery-rules")).toHaveTextContent("阿明蔬果:配送日前 1 天 22:00 截單 · 每天配送");
      await waitFor(() =>
        expect(dateInput().value).toBe(earliestDeliveryDate({ cutoff_time: "22:00", lead_days: 1, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] })),
      );
      expect(screen.getByRole("button", { name: "送出訂單" })).toBeEnabled();
    });

    it("送出時把配送日寫進訂單", async () => {
      state.rules = [RULES];
      const user = userEvent.setup();
      renderPage();
      await screen.findAllByTestId("history-item");
      const target = addDays(taipeiNow().date, 5);
      change(target);
      await user.click(screen.getByRole("button", { name: "送出訂單" }));

      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      expect(state.calls.find((c) => c.op === "insert")?.values).toEqual(expect.objectContaining({ status: "draft", delivery_date: target }));
    });

    it("選到過去的日子:顯示原因、不能送出", async () => {
      state.rules = [RULES];
      renderPage();
      await screen.findAllByTestId("history-item");
      change("2020-01-01");

      expect(await screen.findByTestId("delivery-problem")).toHaveTextContent("配送日不能早於今天");
      expect(screen.getByRole("button", { name: "送出訂單" })).toBeDisabled();
    });

    it("當天截單且已過截單時間:說明這個配送日要在什麼時候前下單", async () => {
      state.rules = [{ ...RULES, lead_days: 0, cutoff_time: "00:00:00" }];
      renderPage();
      await screen.findAllByTestId("history-item");
      change(taipeiNow().date);

      expect(await screen.findByTestId("delivery-problem")).toHaveTextContent("已經超過這個配送日的截單時間");
      expect(screen.getByTestId("delivery-problem")).toHaveTextContent("要在");
      expect(screen.getByRole("button", { name: "送出訂單" })).toBeDisabled();
    });

    it("那天不配送:擋下", async () => {
      const target = addDays(taipeiNow().date, 6);
      const weekday = new Date(`${target}T00:00:00Z`).getUTCDay();
      state.rules = [{ ...RULES, lead_days: 0, cutoff_time: "00:00:00", delivery_weekdays: [0, 1, 2, 3, 4, 5, 6].filter((n) => n !== weekday) }];
      renderPage();
      await screen.findAllByTestId("history-item");
      change(target);
      expect(await screen.findByTestId("delivery-problem")).toHaveTextContent("這一天不配送");
    });

    it("有接單規則時清掉配送日就不能送出(一定要選)", async () => {
      state.rules = [RULES];
      renderPage();
      await screen.findAllByTestId("history-item");
      change("");
      expect(screen.getByRole("button", { name: "送出訂單" })).toBeDisabled();
    });

    it("供應商沒設規則:配送日選填,不選也能送出,訂單的配送日是 null", async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findAllByTestId("history-item");
      expect(screen.queryByTestId("delivery-rules")).toBeNull();
      expect(dateInput().value).toBe("");

      await user.click(screen.getByRole("button", { name: "送出訂單" }));
      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      expect(state.calls.find((c) => c.op === "insert")?.values).toEqual(expect.objectContaining({ delivery_date: null }));
    });

    it("讀不到接單規則不影響叫貨(當作沒有規則,資料庫叫貨時還是會檢查)", async () => {
      state.rules = [];
      renderPage();
      expect(await screen.findAllByTestId("history-item")).toHaveLength(2);
    });
  });

  describe("套用上一張單", () => {
    it("品項、數量、單位照這家供應商上一張單;上一張沒有的品項先移到「已移除」", async () => {
      state.history = [
        { ...order("o-new", daysAgo(2), [{ name: "高麗菜", quantity: "7", unit: "箱" }]), supplier_id: "sup-1" },
        ...HISTORY.map((o) => ({ ...o })),
      ];
      const user = userEvent.setup();
      renderPage();
      await screen.findAllByTestId("history-item");
      expect(screen.getAllByTestId("history-item")).toHaveLength(2);

      await user.click(screen.getByRole("button", { name: /套用上一張單/ }));

      const rows = screen.getAllByTestId("history-item");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByLabelText("高麗菜 數量")).toHaveValue("7");
      expect(within(rows[0]).getByLabelText("高麗菜 單位")).toHaveValue("箱");
      expect(screen.getByRole("button", { name: "+ 雞蛋" })).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("共 1 項"));
    });

    it("已經移除的品項,上一張單有的會加回來", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole("button", { name: "移除 雞蛋" }));
      expect(screen.getAllByTestId("history-item")).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: /套用上一張單/ }));
      expect(screen.getAllByTestId("history-item")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "+ 雞蛋" })).toBeNull();
    });

    it("這家供應商還沒有任何訂單:沒有這個按鈕", async () => {
      state.history = [];
      renderPage();
      await screen.findByText("還沒有叫過貨的品項");
      expect(screen.queryByRole("button", { name: /套用上一張單/ })).toBeNull();
    });
  });

  describe("單價、預估金額與數量上限", () => {
    const CATALOG = [
      { id: "p1", supplier_id: "sup-1", name: "高麗菜", sku: null, unit: "kg", price: 45, image_path: null },
      { id: "p2", supplier_id: "sup-1", name: "雞蛋", sku: null, unit: "箱", price: 620, image_path: null },
    ];

    it("老闆:品項底下顯示單價(有專屬價標示專屬價,沒有就是定價),頁尾顯示預估金額", async () => {
      state.supplies = CATALOG;
      state.prices = [{ supply_id: "p1", price: "40.00" }];
      renderPage();
      const cabbage = await rowOf("高麗菜");
      await waitFor(() => expect(within(cabbage).getByTestId("hints-高麗菜")).toHaveTextContent("單價 $40 / kg(專屬價)"));
      expect(within(await rowOf("雞蛋")).getByTestId("hints-雞蛋")).toHaveTextContent("單價 $620 / 箱");
      // 高麗菜 5kg × 40 + 雞蛋 2 箱 × 620 = 1,440
      expect(screen.getByTestId("order-estimate")).toHaveTextContent("預估金額 NT$ 1,440");
      expect(screen.getByTestId("order-estimate")).toHaveTextContent("實際金額以供應商報價為準");
    });

    it("店在供應商的群組裡:用群組價;自己的專屬價蓋過群組價", async () => {
      state.supplies = CATALOG;
      state.groupPrices = [{ supply_id: "p1", price: "38.00" }, { supply_id: "p2", price: "600.00" }];
      state.prices = [{ supply_id: "p2", price: "590.00" }];
      renderPage();
      const cabbage = await rowOf("高麗菜");
      await waitFor(() => expect(within(cabbage).getByTestId("hints-高麗菜")).toHaveTextContent("單價 $38 / kg"));
      expect(within(await rowOf("雞蛋")).getByTestId("hints-雞蛋")).toHaveTextContent("單價 $590 / 箱");
    });

    it("送出時訂單的品項帶著單價(供應商報價時可以參考);算不出來的品項不帶", async () => {
      state.supplies = CATALOG;
      state.prices = [{ supply_id: "p1", price: 40 }];
      const user = userEvent.setup();
      renderPage();
      await rowOf("高麗菜");
      await waitFor(() => expect(screen.getByTestId("order-estimate")).toBeInTheDocument());
      await user.type(screen.getByPlaceholderText("食材名稱,例:高麗菜"), "牛肉");
      await user.click(screen.getByRole("button", { name: "加入" }));
      await user.click(screen.getByRole("button", { name: "送出訂單" }));

      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      const list = insertedList();
      expect(list.find((i) => i.name === "高麗菜")).toEqual(expect.objectContaining({ unit_price: 40 }));
      expect(list.find((i) => i.name === "雞蛋")).toEqual(expect.objectContaining({ unit_price: 620 }));
      expect(list.find((i) => i.name === "牛肉")?.unit_price).toBeUndefined();
    });

    it("品項對不上商品目錄時沒有單價,預估金額說明不含幾項", async () => {
      state.supplies = [CATALOG[0]];
      renderPage();
      await rowOf("高麗菜");
      await waitFor(() => expect(screen.getByTestId("order-estimate")).toHaveTextContent("另有 1 項算不出來"));
      expect(within(await rowOf("雞蛋")).queryByTestId("hints-雞蛋")).toBeNull();
    });

    it("採購員看不到成本:沒有單價、沒有預估金額,訂單也不帶單價", async () => {
      state.role = "purchaser";
      state.supplies = CATALOG;
      state.prices = [{ supply_id: "p1", price: 40 }];
      const user = userEvent.setup();
      renderPage();
      await rowOf("高麗菜");
      expect(screen.queryByTestId("hints-高麗菜")).toBeNull();
      expect(screen.queryByTestId("order-estimate")).toBeNull();
      await user.click(screen.getByRole("button", { name: "送出訂單" }));
      await waitFor(() => expect(recordOrderEvent).toHaveBeenCalledTimes(1));
      expect(insertedList().every((i) => i.unit_price === undefined)).toBe(true);
    });

    it("數量上限:所有角色都看得到;這張單的數量超過上限時標紅", async () => {
      state.role = "purchaser";
      state.supplies = CATALOG;
      state.limits = [{ supply_id: "p1", period: "week", max_qty: "4" }, { supply_id: "p2", period: "day", max_qty: "10" }];
      renderPage();
      const cabbage = await rowOf("高麗菜"); // 5kg > 週上限 4
      await waitFor(() => expect(within(cabbage).getByTestId("hints-高麗菜")).toHaveTextContent("每週上限 4kg,這張單已經超過"));
      const egg = await rowOf("雞蛋"); // 2 箱 < 日上限 10
      expect(within(egg).getByTestId("hints-雞蛋")).toHaveTextContent("每日上限 10箱");
      expect(within(egg).getByTestId("hints-雞蛋")).not.toHaveTextContent("已經超過");
    });

    it("調數量後超過上限,提示跟著變", async () => {
      state.supplies = CATALOG;
      state.limits = [{ supply_id: "p1", period: "day", max_qty: "5" }];
      const user = userEvent.setup();
      renderPage();
      const cabbage = await rowOf("高麗菜");
      await waitFor(() => expect(within(cabbage).getByTestId("hints-高麗菜")).toHaveTextContent("每日上限 5kg"));
      expect(within(cabbage).getByTestId("hints-高麗菜")).not.toHaveTextContent("已經超過");
      await user.click(within(cabbage).getByRole("button", { name: "高麗菜 數量加 1" }));
      expect(within(cabbage).getByTestId("hints-高麗菜")).toHaveTextContent("這張單已經超過");
    });

    it("沒有商品目錄資料時不影響叫貨", async () => {
      state.supplies = [];
      renderPage();
      expect(await screen.findAllByTestId("history-item")).toHaveLength(2);
      expect(screen.queryByTestId("order-estimate")).toBeNull();
    });
  });
});
