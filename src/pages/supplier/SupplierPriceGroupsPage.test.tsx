// 供應商「群組報價」:建立群組、把客戶放進群組、設定群組價格。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierPriceGroupsPage from "./SupplierPriceGroupsPage";

const SUP = "10000000-0000-0000-0000-00000000000a";

type Write = { table: string; op: string; values?: unknown; opts?: unknown; filters: [string, unknown][] };
const { state, toast } = vi.hoisted(() => ({
  state: {
    groups: [] as { id: string; name: string }[],
    members: [] as { restaurant_id: string; group_id: string }[],
    groupPrices: [] as { group_id: string; supply_id: string; price: string }[],
    writes: [] as Write[],
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
      const rows = (): unknown => {
        if (table === "supplier_accounts") return { supplier_id: SUP };
        if (table === "restaurant_suppliers") return [{ restaurant_id: "r1" }, { restaurant_id: "r2" }, { restaurant_id: "r3" }];
        if (table === "restaurants") return [{ id: "r1", name: "好味小館" }, { id: "r2", name: "阿財麵店" }, { id: "r3", name: "老王小吃" }];
        if (table === "supplies")
          return [
            { id: "p1", name: "高麗菜", sku: "VEG-001", unit: "kg", price: 45 },
            { id: "p2", name: "雞蛋", sku: null, unit: "箱", price: 620 },
          ];
        if (table === "supplier_customer_groups") return state.groups;
        if (table === "supplier_customer_group_members") return state.members;
        if (table === "supplier_group_prices") return state.groupPrices.filter((p) => filters.every(([c, v]) => c !== "group_id" || p.group_id === v));
        return [];
      };
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        in: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        order: () => b,
        insert: (values: unknown) => { write = { op: "insert", values }; return b; },
        update: (values: unknown) => { write = { op: "update", values }; return b; },
        upsert: (values: unknown, opts?: unknown) => { write = { op: "upsert", values, opts }; return b; },
        delete: () => { write = { op: "delete" }; return b; },
        maybeSingle: () => Promise.resolve({ data: rows(), error: null }),
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          if (write) {
            state.writes.push({ table, ...write, filters: [...filters] });
            if (state.writeError) return Promise.resolve({ data: null, error: { message: state.writeError } }).then(a, r);
            if (table === "supplier_customer_groups" && write.op === "insert") {
              const row = { id: "g-new", name: (write.values as { name: string }).name };
              state.groups = [...state.groups, row];
              return Promise.resolve({ data: [row], error: null }).then(a, r);
            }
            return Promise.resolve({ data: null, error: null }).then(a, r);
          }
          return Promise.resolve({ data: rows(), error: null }).then(a, r);
        },
      };
      return b;
    },
  },
}));

beforeEach(() => {
  state.groups = [{ id: "g1", name: "連鎖店" }, { id: "g2", name: "小吃攤" }];
  state.members = [{ restaurant_id: "r1", group_id: "g1" }, { restaurant_id: "r3", group_id: "g2" }];
  state.groupPrices = [{ group_id: "g1", supply_id: "p1", price: "38.00" }];
  state.writes = [];
  state.writeError = null;
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(() => cleanup());

const open = async (name: string) => {
  const user = userEvent.setup();
  render(<SupplierPriceGroupsPage />);
  await user.click(await screen.findByRole("button", { name: new RegExp(name) }));
  await screen.findAllByTestId("group-price-row");
  return user;
};

describe("SupplierPriceGroupsPage", () => {
  it("列出群組與成員數,沒群組的客戶有提示;還沒選群組時請使用者選", async () => {
    render(<SupplierPriceGroupsPage />);
    const items = await screen.findAllByTestId("group-item");
    expect(items.map((i) => i.textContent)).toEqual(["連鎖店1 家", "小吃攤1 家"]);
    expect(screen.getByTestId("ungrouped-note")).toHaveTextContent("1 家客戶還沒有群組");
    expect(screen.getByText("選一個群組,設定成員與價格")).toBeInTheDocument();
  });

  it("選群組:帶出現有群組價,沒設的是空白(照定價);成員打勾", async () => {
    await open("連鎖店");
    expect((screen.getByLabelText("高麗菜 群組價") as HTMLInputElement).value).toBe("38");
    expect((screen.getByLabelText("雞蛋 群組價") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("雞蛋 群組價") as HTMLInputElement).placeholder).toBe("照定價 620");
    expect(screen.getByRole("checkbox", { name: "好味小館 加入連鎖店" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "阿財麵店 加入連鎖店" })).not.toBeChecked();
    expect(screen.getByText("目前在「小吃攤」,勾選會搬過來")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
  });

  it("勾選客戶 = upsert 成員(一家客戶一個群組,所以是搬過來);取消勾選 = 刪除", async () => {
    const user = await open("連鎖店");
    await user.click(screen.getByRole("checkbox", { name: "老王小吃 加入連鎖店" }));
    await waitFor(() => expect(state.writes.find((w) => w.op === "upsert")).toBeTruthy());
    expect(state.writes.find((w) => w.op === "upsert")).toMatchObject({
      table: "supplier_customer_group_members",
      opts: { onConflict: "supplier_id,restaurant_id" },
      values: { supplier_id: SUP, restaurant_id: "r3", group_id: "g1" },
    });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "老王小吃 加入連鎖店" })).toBeChecked());

    await user.click(screen.getByRole("checkbox", { name: "好味小館 加入連鎖店" }));
    await waitFor(() => expect(state.writes.find((w) => w.op === "delete")).toBeTruthy());
    expect(state.writes.find((w) => w.op === "delete")?.filters).toEqual(expect.arrayContaining([["supplier_id", SUP], ["restaurant_id", "r1"]]));
  });

  it("改群組價後儲存:有值的 upsert、清空的刪除,只送有改的", async () => {
    const user = await open("連鎖店");
    await user.clear(screen.getByLabelText("高麗菜 群組價"));
    await user.type(screen.getByLabelText("雞蛋 群組價"), "600");
    await user.click(screen.getByRole("button", { name: /儲存/ }));

    await waitFor(() => expect(state.writes.length).toBe(2));
    expect(state.writes.find((w) => w.op === "upsert")).toMatchObject({
      table: "supplier_group_prices",
      opts: { onConflict: "group_id,supply_id" },
      values: [expect.objectContaining({ group_id: "g1", supply_id: "p2", supplier_id: SUP, price: 600 })],
    });
    expect(state.writes.find((w) => w.op === "delete")?.filters).toEqual(expect.arrayContaining([["group_id", "g1"], ["supply_id", ["p1"]]]));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("已儲存「連鎖店」的價格(1 家客戶適用)"));
  });

  it("價格不是大於 0 的數字:標紅、不能儲存", async () => {
    const user = await open("連鎖店");
    await user.type(screen.getByLabelText("雞蛋 群組價"), "0");
    expect(screen.getByLabelText("雞蛋 群組價")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /儲存/ })).toBeDisabled();
  });

  it("新增群組:名稱不能空白或重複;成功後直接選中新群組", async () => {
    const user = userEvent.setup();
    render(<SupplierPriceGroupsPage />);
    await screen.findAllByTestId("group-item");
    const add = screen.getByRole("button", { name: /新增/ });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("新群組名稱"), "連鎖店");
    expect(screen.getByRole("alert")).toHaveTextContent("已經有同名的群組");
    expect(add).toBeDisabled();
    await user.clear(screen.getByLabelText("新群組名稱"));
    await user.type(screen.getByLabelText("新群組名稱"), "大型餐廳");
    await user.click(add);

    await waitFor(() => expect(state.writes[0]).toMatchObject({ table: "supplier_customer_groups", op: "insert", values: { supplier_id: SUP, name: "大型餐廳" } }));
    expect(await screen.findByLabelText("群組名稱")).toHaveValue("大型餐廳");
  });

  it("刪除群組要二次確認,說明成員會改回定價", async () => {
    const user = await open("連鎖店");
    await user.click(screen.getByRole("button", { name: /刪除群組/ }));
    expect(screen.getByText("刪除後 1 家客戶會改回定價")).toBeInTheDocument();
    expect(state.writes).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "確定刪除" }));
    await waitFor(() => expect(state.writes[0]).toMatchObject({ table: "supplier_customer_groups", op: "delete" }));
    expect(state.writes[0].filters).toEqual([["id", "g1"]]);
  });

  it("資料庫拒絕時顯示錯誤、不假裝成功", async () => {
    const user = await open("連鎖店");
    state.writeError = "這家餐廳還沒有綁定你,不能加進群組";
    await user.click(screen.getByRole("checkbox", { name: "阿財麵店 加入連鎖店" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("更新「阿財麵店」失敗", { description: "這家餐廳還沒有綁定你,不能加進群組" }));
    expect(screen.getByRole("checkbox", { name: "阿財麵店 加入連鎖店" })).not.toBeChecked();
  });
});
