// 「叫貨與訂單 → 供應商」分頁(/restaurant/suppliers):「查看」不再帶人去公開供應商頁
// (那頁是給訪客看的,原本的詢價是死路,業主拍板 Q7-A),改成在卡片裡就地展開績效。
// supabase 換成記憶體假資料,並擋掉所有網路請求。

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RestaurantSuppliersPage from "./RestaurantSuppliersPage";

type Role = "owner" | "manager" | "purchaser";
const { state, toast } = vi.hoisted(() => ({
  state: {
    role: "owner" as Role,
    bound: [] as string[],
    writes: [] as { op: "insert" | "delete"; table: string; values?: unknown; filters: [string, unknown][] }[],
    writeError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const ORDERS = [
  { id: "aaaaaaaa-0000-4000-8000-0000000000a1", supplier_id: "sup-1", total_amount: 1000, status: "received", created_at: "2026-09-20T01:00:00Z" },
  { id: "aaaaaaaa-0000-4000-8000-0000000000a2", supplier_id: "sup-1", total_amount: 500, status: "delivered", created_at: "2026-09-26T01:00:00Z" },
  { id: "aaaaaaaa-0000-4000-8000-0000000000b1", supplier_id: "sup-2", total_amount: 800, status: "quoted", created_at: "2026-09-25T01:00:00Z" },
];

const TABLES: Record<string, Record<string, unknown>[]> = {
  supplier_orders: ORDERS,
  suppliers: [
    { id: "sup-1", name: "鮮綠農產", description: "當日採收的葉菜與根莖類", service_areas: ["台北市", "新北市"], is_active: true },
    { id: "sup-2", name: "海味水產", description: null, service_areas: [], is_active: true },
    { id: "sup-3", name: "山頂肉鋪", description: "黑豬肉專賣", service_areas: ["桃園市"], is_active: true },
    { id: "sup-4", name: "已歇業行", description: null, service_areas: [], is_active: false },
  ],
  supplier_metrics: [
    { supplier_id: "sup-1", orders_total: 42, ontime_rate: 0.95, shortage_rate: 0.02, avg_reply_minutes: 18, avg_rating: 4.6, computed_at: "2026-09-27T00:00:00Z" },
  ],
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const inFilters: [string, unknown[]][] = [];
      let write: { op: "insert" | "delete"; values?: unknown } | null = null;
      const rows = () => {
        const all = table === "restaurant_suppliers" ? state.bound.map((id) => ({ supplier_id: id })) : (TABLES[table] ?? []);
        return all.filter(
          (r) =>
            filters.every(([c, v]) => c === "restaurant_id" || r[c] === v) && inFilters.every(([c, vs]) => vs.includes(r[c])),
        );
      };
      const result = () => {
        if (write) {
          state.writes.push({ ...write, table, filters: [...filters] });
          return { data: null, error: state.writeError ? { message: state.writeError } : null };
        }
        return { data: rows(), error: null };
      };
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return builder; },
        in: (c: string, vs: unknown[]) => { inFilters.push([c, vs]); return builder; },
        order: () => builder,
        limit: () => builder,
        insert: (values: unknown) => { write = { op: "insert", values }; return builder; },
        delete: () => { write = { op: "delete" }; return builder; },
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(onFulfilled, onRejected),
      };
      return builder;
    },
  },
}));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/components/RestaurantRoute", () => ({
  useRestaurant: () => ({
    id: "account-1",
    restaurant_id: "restaurant-1",
    branch_id: null,
    role: state.role,
    restaurant_name: "好味小館",
  }),
  canSeeCost: (role: Role) => role === "owner" || role === "manager",
  needsApproval: (role: Role) => role === "purchaser",
}));

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/restaurant/suppliers"]}>
      <RestaurantSuppliersPage />
    </MemoryRouter>,
  );

let fetchGuard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.role = "owner";
  state.bound = ["sup-1", "sup-2"];
  state.writes = [];
  state.writeError = null;
  toast.success.mockReset();
  toast.error.mockReset();
  fetchGuard = vi.fn(() => Promise.reject(new Error("測試不准打網路")));
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchGuard).not.toHaveBeenCalled();
});

const cardOf = async (name: string) => {
  const heading = await screen.findByRole("heading", { name });
  return heading.closest("[class*='rounded']") as HTMLElement;
};

describe("RestaurantSuppliersPage —「查看」改成就地展開績效", () => {
  it("整頁沒有任何連到公開供應商頁(/supplier/:id)的連結", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "鮮綠農產" });

    const links = screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links.filter((href) => href?.startsWith("/supplier/"))).toEqual([]);
  });

  it("按「查看績效」在卡片裡展開近期合作與平台統計,再按一次收起", async () => {
    const user = userEvent.setup();
    renderPage();

    const card = await cardOf("鮮綠農產");
    const toggle = within(card).getByRole("button", { name: "查看績效" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    const region = screen.getByRole("region", { name: "鮮綠農產 的績效明細" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", region.id);
    expect(toggle).toHaveTextContent("收起");
    // 近期合作:新到舊,編號是尾 8 碼大寫、狀態用中文
    const items = within(region).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("#000000A2");
    expect(items[0]).toContain("待收貨");
    expect(items[1]).toContain("#000000A1");
    expect(items[1]).toContain("待評價");
    expect(region).toHaveTextContent("平台累計訂單42");
    expect(region).toHaveTextContent("平均回覆18 分鐘");
    expect(within(region).getByRole("link", { name: "到訂單分頁看完整履歷" })).toHaveAttribute("href", "/restaurant/orders");

    await user.click(toggle);
    expect(screen.queryByRole("region", { name: "鮮綠農產 的績效明細" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("一次只展開一家;沒有統計資料的供應商顯示「—」", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(within(await cardOf("鮮綠農產")).getByRole("button", { name: "查看績效" }));
    await user.click(within(await cardOf("海味水產")).getByRole("button", { name: "查看績效" }));

    expect(screen.queryByRole("region", { name: "鮮綠農產 的績效明細" })).toBeNull();
    const region = screen.getByRole("region", { name: "海味水產 的績效明細" });
    expect(region).toHaveTextContent("平台累計訂單—");
  });

  it("採購員也能展開(不含金額欄位)", async () => {
    state.role = "purchaser";
    const user = userEvent.setup();
    renderPage();

    const card = await cardOf("鮮綠農產");
    // 標籤已改名為「累計採購金額」(全站共用定義);兩個都查,改名後這條才不會變成永遠通過
    expect(within(card).queryByText("累計採購金額")).toBeNull();
    expect(within(card).queryByText("累計金額")).toBeNull();
    expect(within(card).queryByText(/^\$/)).toBeNull(); // 卡片上不出現任何金額
    // 頁首彙總卡也不能出現金額
    expect(screen.queryByText("累計採購金額")).toBeNull();
    expect(screen.queryByText(/^\$/)).toBeNull();
    await user.click(within(card).getByRole("button", { name: "查看績效" }));
    expect(screen.getByRole("region", { name: "鮮綠農產 的績效明細" })).toBeInTheDocument();
  });
});

describe("RestaurantSuppliersPage — 合作供應商綁定", () => {
  it("只列這家店綁定的供應商(沒綁定的不出現,就算有過訂單)", async () => {
    state.bound = ["sup-1"];
    renderPage();
    expect(await screen.findByRole("heading", { name: "鮮綠農產" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "海味水產" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "山頂肉鋪" })).toBeNull();
  });

  it("綁定了但還沒有任何訂單的供應商也列出來(合作單數 0)", async () => {
    state.bound = ["sup-3"];
    renderPage();
    const card = await cardOf("山頂肉鋪");
    expect(within(card).getByText("合作單數").nextElementSibling).toHaveTextContent("0");
  });

  it("每家都有「向他叫貨」,帶著供應商 id 到叫貨頁", async () => {
    renderPage();
    const card = await cardOf("鮮綠農產");
    expect(within(card).getByRole("link", { name: /向他叫貨/ })).toHaveAttribute("href", "/restaurant/purchase?supplier=sup-1");
  });

  it("還沒綁定任何供應商:顯示引導,老闆有「新增合作供應商」", async () => {
    state.bound = [];
    renderPage();
    expect(await screen.findByText("還沒有綁定合作供應商")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /新增合作供應商/ }).length).toBeGreaterThan(0);
  });

  it("新增合作供應商:列出還在營業、還沒綁定的供應商,可以搜尋;按「綁定」寫入這家店的綁定", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "鮮綠農產" });

    await user.click(screen.getAllByRole("button", { name: /新增合作供應商/ })[0]);
    const list = await screen.findByTestId("bind-candidates");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("山頂肉鋪")]);
    expect(screen.queryByText("已歇業行")).toBeNull();

    await user.type(screen.getByLabelText("搜尋供應商"), "不存在");
    expect(await screen.findByText("找不到符合的供應商")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("搜尋供應商"));
    await user.type(screen.getByLabelText("搜尋供應商"), "肉鋪");

    await user.click(await screen.findByRole("button", { name: "綁定 山頂肉鋪" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: "insert", table: "restaurant_suppliers", values: { restaurant_id: "restaurant-1", supplier_id: "sup-3" } });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("山頂肉鋪"));
  });

  it("綁定失敗顯示原因", async () => {
    state.writeError = "row-level security";
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "鮮綠農產" });
    await user.click(screen.getAllByRole("button", { name: /新增合作供應商/ })[0]);
    await user.click(await screen.findByRole("button", { name: "綁定 山頂肉鋪" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("綁定失敗", { description: "row-level security" }));
  });

  it("解除綁定:要先確認;確認後刪除這家店與這家供應商的綁定", async () => {
    const user = userEvent.setup();
    renderPage();
    const card = await cardOf("海味水產");
    await user.click(within(card).getByRole("button", { name: /解除綁定/ }));
    expect(state.writes).toHaveLength(0);

    await user.click(await screen.findByRole("button", { name: "確定解除" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: "delete", table: "restaurant_suppliers" });
    expect(state.writes[0].filters).toEqual(expect.arrayContaining([["restaurant_id", "restaurant-1"], ["supplier_id", "sup-2"]]));
  });

  it("採購員:看得到合作供應商也能點「向他叫貨」,但沒有新增與解除綁定", async () => {
    state.role = "purchaser";
    renderPage();
    const card = await cardOf("鮮綠農產");
    expect(within(card).getByRole("link", { name: /向他叫貨/ })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /解除綁定/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /新增合作供應商/ })).toBeNull();
  });

  it("採購員且還沒綁定任何供應商:提示請老闆或店長綁定", async () => {
    state.role = "purchaser";
    state.bound = [];
    renderPage();
    expect(await screen.findByText(/請老闆或店長先綁定合作供應商/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增合作供應商/ })).toBeNull();
  });
});
