// 供應商「客戶價格與上限」:替每家綁定的客戶設專屬價格與每日 / 每週叫貨上限,CSV 匯出入。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierCustomerPricesPage from "./SupplierCustomerPricesPage";

const SUP = "10000000-0000-0000-0000-00000000000a";

const { state, toast } = vi.hoisted(() => ({
  state: {
    prices: [] as Record<string, unknown>[],
    limits: [] as Record<string, unknown>[],
    /** 這家客戶所屬群組與群組價(沒群組 = 空陣列) */
    member: [] as Record<string, unknown>[],
    groupPrices: [] as Record<string, unknown>[],
    writes: [] as { table: string; op: string; values?: unknown; opts?: unknown; filters: [string, unknown][] }[],
    writeError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      let write: { op: string; values?: unknown; opts?: unknown } | null = null;
      const rows = () => {
        if (table === "supplier_accounts") return { supplier_id: SUP };
        if (table === "restaurant_suppliers") return [{ restaurant_id: "r1" }, { restaurant_id: "r2" }];
        if (table === "restaurants") return [{ id: "r1", name: "好味小館" }, { id: "r2", name: "阿財麵店" }];
        if (table === "supplies")
          return [
            { id: "p1", name: "高麗菜", sku: "VEG-001", unit: "kg", price: 45 },
            { id: "p2", name: "雞蛋", sku: null, unit: "箱", price: 620 },
          ];
        if (table === "supplier_customer_prices") return state.prices;
        if (table === "supplier_customer_limits") return state.limits;
        if (table === "supplier_customer_group_members") return state.member;
        if (table === "supplier_group_prices") return state.groupPrices;
        if (table === "supplier_customer_groups") return [{ name: "連鎖店" }];
        return [];
      };
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        in: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        order: () => b,
        upsert: (values: unknown, opts?: unknown) => { write = { op: "upsert", values, opts }; return b; },
        delete: () => { write = { op: "delete" }; return b; },
        maybeSingle: () => Promise.resolve({ data: rows(), error: null }),
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          if (write) {
            state.writes.push({ table, ...write, filters: [...filters] });
            return Promise.resolve({ data: null, error: state.writeError ? { message: state.writeError } : null }).then(a, r);
          }
          return Promise.resolve({ data: rows(), error: null }).then(a, r);
        },
      };
      return b;
    },
  },
}));

let blobs: Blob[];
beforeEach(() => {
  state.prices = [];
  state.limits = [];
  state.member = [];
  state.groupPrices = [];
  state.writes = [];
  state.writeError = null;
  toast.success.mockReset();
  toast.error.mockReset();
  blobs = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return "blob:t"; }, revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pickCustomer = async (name = "好味小館") => {
  await screen.findByLabelText("客戶");
  await waitFor(() => expect(screen.getByRole("option", { name })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("客戶"), { target: { value: name === "好味小館" ? "r1" : "r2" } });
  await screen.findAllByTestId("price-row");
};
const priceInput = (name: string) => screen.getByLabelText(`${name} 客戶價`) as HTMLInputElement;
const maxInput = (name: string) => screen.getByLabelText(`${name} 數量上限`) as HTMLInputElement;
const readText = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b, "utf-8"); });

describe("SupplierCustomerPricesPage", () => {
  it("只列綁定這家供應商的客戶;沒選客戶前提示先選", async () => {
    render(<SupplierCustomerPricesPage />);
    expect(await screen.findByText("先選擇客戶")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "好味小館" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "阿財麵店" })).toBeInTheDocument();
  });

  it("選了客戶:帶出他現有的專屬價格與上限,沒設的是空白(照定價 / 不限)", async () => {
    state.prices = [{ supply_id: "p1", price: "40.00" }];
    state.limits = [{ supply_id: "p1", period: "week", max_qty: "50.00" }];
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();

    expect(priceInput("高麗菜").value).toBe("40");
    expect(maxInput("高麗菜").value).toBe("50");
    expect((screen.getByLabelText("高麗菜 上限期別") as HTMLSelectElement).value).toBe("week");
    expect(priceInput("雞蛋").value).toBe("");
    expect(priceInput("雞蛋").placeholder).toBe("照定價 620");
    expect(screen.getByTestId("dirty-summary")).toHaveTextContent("目前沒有未儲存的修改");
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
  });

  it("客戶在群組裡:說明沒填客戶價會用群組價,輸入框提示群組價;不在群組就說照定價", async () => {
    state.member = [{ group_id: "g1" }];
    state.groupPrices = [{ supply_id: "p1", price: "38.00" }];
    state.prices = [{ supply_id: "p2", price: "600" }];
    const { unmount } = render(<SupplierCustomerPricesPage />);
    await pickCustomer();
    expect(screen.getByTestId("group-note")).toHaveTextContent("好味小館 屬於群組「連鎖店」,沒有填客戶價的商品會用群組價");
    expect(priceInput("高麗菜").value).toBe("");
    expect(priceInput("高麗菜").placeholder).toBe("群組價 38");
    expect(priceInput("雞蛋").value).toBe("600"); // 專屬價蓋過群組價
    unmount();

    state.member = [];
    state.groupPrices = [];
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();
    expect(screen.getByTestId("group-note")).toHaveTextContent("沒有加入任何群組");
    expect(priceInput("高麗菜").placeholder).toBe("照定價 45");
  });

  it("修改後儲存:有值的 upsert、清空的刪除,只送有改的商品", async () => {
    state.prices = [{ supply_id: "p1", price: "40" }];
    const user = userEvent.setup();
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();

    await user.clear(priceInput("高麗菜")); // 清空 → 刪除專屬價
    await user.type(priceInput("雞蛋"), "600"); // 新增
    await user.type(maxInput("雞蛋"), "5");
    await user.selectOptions(screen.getByLabelText("雞蛋 上限期別"), "week");
    expect(screen.getByTestId("dirty-summary")).toHaveTextContent("有 2 個商品的修改還沒儲存");
    await user.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.writes.length).toBeGreaterThanOrEqual(3));
    const byKey = (table: string, op: string) => state.writes.find((w) => w.table === table && w.op === op);
    expect(byKey("supplier_customer_prices", "upsert")).toMatchObject({
      opts: { onConflict: "restaurant_id,supply_id" },
      values: [expect.objectContaining({ restaurant_id: "r1", supply_id: "p2", supplier_id: SUP, price: 600 })],
    });
    expect(byKey("supplier_customer_prices", "delete")?.filters).toEqual(expect.arrayContaining([["restaurant_id", "r1"], ["supply_id", ["p1"]]]));
    expect(byKey("supplier_customer_limits", "upsert")).toMatchObject({
      values: [expect.objectContaining({ supply_id: "p2", period: "week", max_qty: 5 })],
    });
    expect(state.writes.find((w) => w.table === "supplier_customer_limits" && w.op === "delete")).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("已儲存(2 個商品)");
  });

  it("價格或上限不是大於 0 的數字:標紅、不能儲存", async () => {
    const user = userEvent.setup();
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();
    await user.type(priceInput("高麗菜"), "0");
    expect(screen.getByTestId("dirty-summary")).toHaveTextContent("不是大於 0 的數字");
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
    await user.clear(priceInput("高麗菜"));
    await user.type(priceInput("高麗菜"), "40");
    expect(screen.getByRole("button", { name: "儲存" })).toBeEnabled();
  });

  it("儲存失敗顯示原因", async () => {
    state.writeError = "row-level security";
    const user = userEvent.setup();
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();
    await user.type(priceInput("高麗菜"), "40");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("儲存失敗", { description: "row-level security" }));
  });

  it("匯出 CSV:帶出目前表格的內容(包含還沒儲存的修改)", async () => {
    const user = userEvent.setup();
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();
    await user.type(priceInput("高麗菜"), "40");
    await user.click(screen.getByRole("button", { name: /匯出 CSV/ }));

    const lines = (await readText(blobs[0])).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("商品,貨號,單位,定價,客戶價,數量上限,上限期別");
    expect(lines[1]).toBe("高麗菜,VEG-001,kg,45,40,,");
    expect(lines[2]).toBe("雞蛋,,箱,620,,,");
  });

  it("匯入 CSV:套用到表格(還沒儲存);看不懂的列列出原因", async () => {
    const user = userEvent.setup();
    render(<SupplierCustomerPricesPage />);
    await pickCustomer();

    const csv = "商品,客戶價,數量上限,上限期別\n高麗菜,41,20,每週\n牛肉,100,,\n";
    const file = new File([csv], "price.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    await user.upload(screen.getByLabelText("選擇價格表檔案"), file);

    await waitFor(() => expect(priceInput("高麗菜").value).toBe("41"));
    expect(maxInput("高麗菜").value).toBe("20");
    expect((screen.getByLabelText("高麗菜 上限期別") as HTMLSelectElement).value).toBe("week");
    expect(screen.getByTestId("import-errors")).toHaveTextContent("第 3 列:「牛肉」不在你的商品目錄裡");
    expect(screen.getByTestId("dirty-summary")).toHaveTextContent("有 1 個商品的修改還沒儲存");
    expect(state.writes).toHaveLength(0);
  });
});
