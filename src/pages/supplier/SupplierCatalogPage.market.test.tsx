// 商品目錄頁多了「零售商品」分頁與每列的「開放零售」(設計:擴充 SupplierCatalogPage)。
// 驗證:①兩個分頁 ②批發商品列:沒有對應零售商品的出現「開放零售」,有的顯示零售狀態 ③開放零售打開視窗並帶入品名
// ④零售分頁列出自家零售商品 ⑤還沒建零售店家時「開放零售」停用。supabase 換成記憶體假資料。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    supplies: [] as Record<string, unknown>[],
    marketProducts: [] as Record<string, unknown>[],
    hasStore: true,
    // 審查後補的:零售商品讀取失敗、讀取卡住(放行前不回應)、存檔時資料庫回傳的那一筆
    marketFails: false,
    marketHold: null as Promise<void> | null,
    saved: null as Record<string, unknown> | null,
    // 店家零售有沒有被管理員停用;最後一次 update 帶的條件(看樂觀鎖有沒有比對 updated_at)
    storeEnabled: true,
    updateFilters: [] as Array<[string, unknown]>,
    // 零售資料(market_products、market_stores)一律比批發商品晚回來:測試不能假設兩邊同時到
    // (審查實測:晚 30ms 回來,「找到批發商品後同步查零售狀態」就穩定失敗)
    marketDelayMs: 25,
    // 新商品 insert:送出的內容;回應遺失(連線中斷);回應遺失前資料庫其實已經寫入
    inserts: [] as Array<Record<string, unknown>>,
    insertLost: false,
    insertCommits: false,
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }) },
    from: (table: string) => {
      const result = () => {
        if (table === "supplier_accounts") return { data: { supplier_id: "a9200000-0000-4000-8000-00000000000a" }, error: null };
        if (table === "supplies") return { data: db.supplies, error: null };
        if (table === "market_products" && db.marketFails) return { data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "" } };
        if (table === "market_products") return { data: db.marketProducts, error: null };
        if (table === "market_stores") {
          const store = { supplier_id: "a9200000-0000-4000-8000-00000000000a", is_enabled: db.storeEnabled, suppliers: { is_active: true } };
          return { data: db.hasStore ? store : null, error: null };
        }
        return { data: [], error: null };
      };
      const late = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), db.marketDelayMs));
      const respond = () =>
        table === "market_products" ? (db.marketHold ?? Promise.resolve()).then(() => late(result())) : Promise.resolve(result());
      // insert / update 之後的 single / maybeSingle 回 db.saved(null = 沒有更新到任何一列)
      let writing = false;
      let inserted: Record<string, unknown> | null = null;
      const filters: Array<[string, unknown]> = [];
      const b = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return b;
        },
        order: () => b,
        insert: (values: Record<string, unknown>) => {
          writing = true;
          inserted = values;
          db.inserts.push(values);
          return b;
        },
        update: () => {
          writing = true;
          db.updateFilters = filters;
          return b;
        },
        single: () => {
          if (inserted && db.insertLost) {
            if (db.insertCommits) {
              db.marketProducts = [...db.marketProducts, { ...inserted, created_at: "2026-10-10T07:00:00Z", updated_at: "2026-10-10T07:00:00.000001+00:00" }];
            }
            return Promise.resolve({ data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "" } });
          }
          return Promise.resolve({ data: db.saved, error: null });
        },
        maybeSingle: () =>
          writing ? Promise.resolve({ data: db.saved, error: null }) : table === "market_stores" ? late(result()) : Promise.resolve(result()),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => respond().then(ok, bad),
      };
      return b;
    },
  },
}));

import { CABBAGE } from "@/lib/market/testFixtures";
import SupplierCatalogPage from "./SupplierCatalogPage";

const SUPPLY = (id: string, name: string) => ({
  id,
  name,
  category: "蔬菜",
  sku: null,
  unit: "kg",
  pack_size: "10kg/箱",
  price: 300,
  currency: "TWD",
  description: null,
  is_available: true,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SupplierCatalogPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  db.supplies = [SUPPLY("s-cabbage", "高麗菜"), SUPPLY("s-onion", "洋蔥")];
  db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "pending" }];
  db.hasStore = true;
  db.marketFails = false;
  db.marketHold = null;
  db.saved = null;
  db.storeEnabled = true;
  db.updateFilters = [];
  db.marketDelayMs = 25;
  db.inserts = [];
  db.insertLost = false;
  db.insertCommits = false;
});
afterEach(cleanup);

describe("SupplierCatalogPage — 零售市集", () => {
  it("兩個分頁;批發商品每列有零售狀態或「開放零售」", async () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "批發商品(給餐廳)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "零售商品(給消費者)" })).toBeInTheDocument();
    const cabbageRow = (await screen.findByText("高麗菜")).closest("tr") as HTMLElement;
    // 零售狀態跟批發商品是分開讀的,晚一點才到:一定要等(findBy),不能找到批發商品就同步查
    expect(await within(cabbageRow).findByRole("button", { name: "待審" })).toBeInTheDocument();
    const onionRow = screen.getByText("洋蔥").closest("tr") as HTMLElement;
    expect(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" })).toBeEnabled();
  });

  it("「開放零售」打開零售商品視窗,品名與規格從批發商品帶入", async () => {
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    await userEvent.click(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "新增零售商品" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("品名 *")).toHaveValue("洋蔥");
    expect(within(dialog).getByLabelText("零售規格 *")).toHaveValue("10kg/箱");
    expect(within(dialog).getByLabelText("分類 *")).toHaveValue("vegetable");
  });

  it("零售分頁列出自家零售商品", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    expect(await screen.findByRole("button", { name: "編輯 有機高麗菜" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增零售商品" })).toBeEnabled();
  });

  it("還沒建零售店家:「開放零售」停用", async () => {
    db.hasStore = false;
    db.marketProducts = [];
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    const button = await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" });
    expect(button).toBeDisabled();
  });
});

const STAMP = "2026-10-10T07:00:00.123456+00:00";

// 讀取失敗 / 讀取中 / 存檔之後:「零售」欄不能拿舊的或空的資料讓人重複開放零售、或用舊內容蓋掉剛存的修改。
describe("SupplierCatalogPage — 零售資料讀取失敗、讀取中、存檔後", () => {
  it("讀取失敗:批發分頁不給「開放零售」與零售狀態,顯示原因與「重新載入」;重新載入成功才恢復", async () => {
    db.marketFails = true;
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    const cabbageRow = screen.getByText("高麗菜").closest("tr") as HTMLElement;
    expect(await screen.findByText(/零售商品資料讀取失敗:連線失敗,請檢查網路後再試一次/)).toBeInTheDocument();
    expect(within(onionRow).queryByRole("button", { name: "洋蔥 開放消費者購買" })).toBeNull();
    expect(within(cabbageRow).queryByRole("button", { name: "待審" })).toBeNull();

    db.marketFails = false;
    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" })).toBeEnabled();
    expect(within(cabbageRow).getByRole("button", { name: "待審" })).toBeInTheDocument();
    expect(screen.queryByText(/零售商品資料讀取失敗/)).toBeNull();
  });

  it("讀取失敗的「—」:螢幕報讀文字(sr-only 是 absolute)包在 relative 裡,不會跑出表格的橫向捲動、把手機整頁撐寬", async () => {
    db.marketFails = true;
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    const hint = await within(onionRow).findByText("零售資料讀取失敗");
    expect(hint).toHaveClass("sr-only");
    expect(hint.parentElement).toHaveClass("relative");
  });

  it("還在讀:先不顯示「開放零售」(還不知道有沒有店家、有沒有對應的零售商品),讀完才出現", async () => {
    let release: () => void = () => {};
    db.marketHold = new Promise<void>((r) => {
      release = r;
    });
    renderPage();
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    expect(within(onionRow).queryByRole("button", { name: "洋蔥 開放消費者購買" })).toBeNull();
    release();
    expect(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" })).toBeEnabled();
  });

  it("還沒建零售店家:批發分頁直接說明要先完成店家設定(手機看不到停用按鈕的提示文字)", async () => {
    db.hasStore = false;
    db.marketProducts = [];
    renderPage();
    expect(await screen.findByRole("link", { name: "零售市集 › 店家設定" })).toHaveAttribute("href", "/supplier/market/store");
  });

  it("存檔後清單立刻換成資料庫回傳的那一筆:重抓還沒回來,也不會留著舊價格讓人再編輯", async () => {
    db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "approved", price: 100, updated_at: STAMP }];
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    await userEvent.click(await screen.findByRole("button", { name: "編輯 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    const price = within(dialog).getByLabelText("零售價(元)*");
    await userEvent.clear(price);
    await userEvent.type(price, "120");

    let release: () => void = () => {};
    db.marketHold = new Promise<void>((r) => {
      release = r;
    });
    db.saved = { ...CABBAGE, supply_id: "s-cabbage", review_status: "approved", price: 120, updated_at: "2026-10-10T07:05:00.000001+00:00" };
    await userEvent.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/NT\$ 120/)).toBeInTheDocument();
    expect(screen.queryByText(/NT\$ 100/)).toBeNull();

    db.marketProducts = [db.saved];
    release();
    expect(await screen.findByText(/NT\$ 120/)).toBeInTheDocument();
  });

  it("零售狀態按鈕的可點範圍跟同一列的按鈕一樣高(至少 32px)", async () => {
    renderPage();
    const cabbageRow = (await screen.findByText("高麗菜")).closest("tr") as HTMLElement;
    expect(await within(cabbageRow).findByRole("button", { name: "待審" })).toHaveClass("min-h-8");
  });
});

// 樂觀鎖:別人(管理員、另一個分頁)先改過就不覆寫;狀態文字照消費者實際看到的寫。
describe("SupplierCatalogPage — 樂觀鎖與狀態文字", () => {
  it("別人先改過:儲存帶讀到的 updated_at,沒更新到就顯示原因;按「重新載入」關視窗、重新讀取後才看到新內容", async () => {
    db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "approved", price: 100, updated_at: STAMP }];
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    await userEvent.click(await screen.findByRole("button", { name: "編輯 有機高麗菜" }));
    const dialog = await screen.findByRole("dialog");
    db.saved = null;
    await userEvent.click(within(dialog).getByRole("button", { name: "儲存" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("這個商品已被其他人更新,請重新載入後再改");
    expect(db.updateFilters).toContainEqual(["updated_at", STAMP]);

    db.marketProducts = [
      { ...CABBAGE, supply_id: "s-cabbage", review_status: "approved", price: 150, updated_at: "2026-10-10T08:00:00.000001+00:00" },
    ];
    await userEvent.click(within(dialog).getByRole("button", { name: "重新載入" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/NT\$ 150/)).toBeInTheDocument();
  });

  it("店家零售被停用:批發分頁的零售狀態寫「已核准・店家停用中(消費者看不到)」,不寫「已上架」", async () => {
    db.marketProducts = [{ ...CABBAGE, supply_id: "s-cabbage", review_status: "approved" }];
    db.storeEnabled = false;
    renderPage();
    const cabbageRow = (await screen.findByText("高麗菜")).closest("tr") as HTMLElement;
    expect(await within(cabbageRow).findByRole("button", { name: "已核准・店家停用中(消費者看不到)" })).toBeInTheDocument();
    expect(within(cabbageRow).queryByRole("button", { name: "已上架" })).toBeNull();
  });
});

// 新商品存檔的回應遺失(資料庫可能其實存了)後按「取消」、再打開:不能換一個新 id 建出第二筆(沒有刪除鈕)。
describe("SupplierCatalogPage — 新商品存檔回應遺失後再打開", () => {
  const submitWithPrice = async (dialog: HTMLElement, price: string) => {
    const input = within(dialog).getByLabelText("零售價(元)*");
    await userEvent.clear(input);
    await userEvent.type(input, price);
    await userEvent.click(within(dialog).getByRole("button", { name: "送出審核" }));
  };
  const openOnion = async () => {
    const onionRow = (await screen.findByText("洋蔥")).closest("tr") as HTMLElement;
    await userEvent.click(await within(onionRow).findByRole("button", { name: "洋蔥 開放消費者購買" }));
    return { onionRow, dialog: await screen.findByRole("dialog") };
  };
  const cancel = async (dialog: HTMLElement) => {
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  };

  it("資料庫其實存好了:按「取消」關窗就重新讀取,那一列換成它的狀態,不會再「開放零售」一次", async () => {
    db.insertLost = true;
    db.insertCommits = true;
    renderPage();
    const { onionRow, dialog } = await openOnion();
    await submitWithPrice(dialog, "120");
    await waitFor(() => expect(db.inserts).toHaveLength(1));
    await cancel(dialog);
    expect(await within(onionRow).findByRole("button", { name: "待審" })).toBeInTheDocument();
    expect(within(onionRow).queryByRole("button", { name: "洋蔥 開放消費者購買" })).toBeNull();
  });

  it("資料庫沒有存到:同一個批發商品再「開放零售」沿用同一個商品 id(萬一上一次其實存了,會撞主鍵、補存那一筆)", async () => {
    db.insertLost = true;
    renderPage();
    const first = await openOnion();
    await submitWithPrice(first.dialog, "120");
    await waitFor(() => expect(db.inserts).toHaveLength(1));
    await cancel(first.dialog);

    db.insertLost = false;
    db.saved = { ...CABBAGE, id: db.inserts[0].id, supply_id: "s-onion", name: "洋蔥", review_status: "pending", updated_at: STAMP };
    const second = await openOnion();
    await submitWithPrice(second.dialog, "150");
    await waitFor(() => expect(db.inserts).toHaveLength(2));
    expect(db.inserts[1].id).toBe(db.inserts[0].id);
    expect(db.inserts[1]).toMatchObject({ price: 150, supply_id: "s-onion" });
  });

  it("「新增零售商品」也一樣:沒確認存好就關掉,下一次新增沿用同一個 id;確認存好之後下一個才換新的 id", async () => {
    const openNew = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "新增零售商品" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText("品名 *"), "手工辣椒醬");
      await userEvent.selectOptions(within(dialog).getByLabelText("分類 *"), "condiment");
      await userEvent.type(within(dialog).getByLabelText("零售規格 *"), "240g/罐");
      return dialog;
    };
    db.insertLost = true;
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "零售商品(給消費者)" }));
    const first = await openNew();
    await submitWithPrice(first, "220");
    await waitFor(() => expect(db.inserts).toHaveLength(1));
    await cancel(first);

    db.insertLost = false;
    db.saved = { ...CABBAGE, id: db.inserts[0].id, name: "手工辣椒醬", category: "condiment", review_status: "pending", updated_at: STAMP };
    const second = await openNew();
    await submitWithPrice(second, "220");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.inserts[1].id).toBe(db.inserts[0].id);

    const third = await openNew();
    await submitWithPrice(third, "220");
    await waitFor(() => expect(db.inserts).toHaveLength(3));
    expect(db.inserts[2].id).not.toBe(db.inserts[0].id);
  });
});
