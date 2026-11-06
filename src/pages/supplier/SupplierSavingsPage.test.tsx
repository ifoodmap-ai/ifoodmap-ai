// 供應商「省多少錢」:輸入單量、打單時間、薪資、出錯率…,結果即時更新;可以帶入最近 30 天的實際單量。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierSavingsPage from "./SupplierSavingsPage";

const { state } = vi.hoisted(() => ({ state: { orders: [] as { id: string }[], fail: false, calls: [] as { table: string; filters: [string, unknown][] }[] } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const rows = () => {
        if (state.fail) throw new Error("連線失敗");
        if (table === "supplier_accounts") return { supplier_id: "sup-1" };
        if (table === "supplier_orders") return state.orders;
        return [];
      };
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        gte: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        limit: () => b,
        maybeSingle: () => Promise.resolve({ data: rows(), error: null }),
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          state.calls.push({ table, filters });
          try { return Promise.resolve({ data: rows(), error: null }).then(a, r); } catch (e) { return Promise.reject(e).then(a, r); }
        },
      };
      return b;
    },
  },
}));

beforeEach(() => { state.orders = []; state.fail = false; state.calls = []; });
afterEach(() => cleanup());

const set = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label, { selector: "input[type=number]" }), { target: { value: v } });

describe("SupplierSavingsPage", () => {
  it("預設(LINE 接單、400 張、出錯率 8%、月薪 4 萬):算出每月成本、年成本、時間與相當於幾位全職;沒有平台費用所以沒有扣款那一行", () => {
    render(<SupplierSavingsPage />);
    // 400 張 × 8 分鐘 = 53.3 小時 × (40,000/176) = 12,121;出錯 400 × 8% × 600 = 19,200
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 31,321");
    expect(screen.getByTestId("cost-yearly")).toHaveTextContent("一年累積約 NT$ 375,855");
    expect(screen.getByTestId("cost-hours")).toHaveTextContent("每個月光是接單就花掉約 53 小時,等於 0.3 位全職內勤的工作量");
    expect(screen.getByTestId("cost-card")).not.toHaveTextContent("對帳與追單"); // 預設沒有對帳時數,不顯示那一行
    expect(screen.getByTestId("saved-total")).toHaveTextContent("NT$ 15,661"); // 各項減少一半
    expect(screen.getByTestId("net")).toHaveTextContent("NT$ 15,661");
    expect(screen.queryByText("平台費用")).toBeNull();
  });

  it("接單方式:LINE 8 分鐘、電話 12 分鐘、其他 10 分鐘,選了結果立刻更新;自己改處理時間就沒有選項被選中", async () => {
    render(<SupplierSavingsPage />);
    const user = userEvent.setup();
    expect(screen.getByRole("radio", { name: /收到 LINE 文字後人工打單/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /接電話後人工打單/ }));
    // 400 × 12 分鐘 = 80 小時 × 227.27 = 18,182 + 19,200
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 37,382");
    await user.click(screen.getByRole("radio", { name: /其他/ }));
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 34,352"); // 400 × 10 分鐘 = 66.7 小時 → 15,152 + 19,200

    await user.click(screen.getByText("進階:估算假設(可以自己調整)"));
    set("處理一張單的時間", "5");
    expect(screen.queryAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 26,776"); // 33.3 小時 → 7,576 + 19,200
  });

  it("改任何一個輸入,結果立刻更新(數字欄與滑桿都行)", () => {
    render(<SupplierSavingsPage />);
    set("每月訂單數", "1000");
    set("訂單出錯率", "10");
    // 1000 × 8 分鐘 = 133.3 小時 × 227.27 = 30,303;出錯 1000 × 10% × 600 = 60,000
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 90,303");

    fireEvent.change(screen.getByLabelText("每月訂單數(滑桿)"), { target: { value: "2000" } });
    expect((screen.getByLabelText("每月訂單數", { selector: "input[type=number]" }) as HTMLInputElement).value).toBe("2000");
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 180,606");
  });

  it("進階假設可以調:減少比例、對帳時數、平台費用;費用大於省下的錢時淨效益是負的、標紅", async () => {
    render(<SupplierSavingsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByText("進階:估算假設(可以自己調整)"));
    set("出錯與重工可減少", "80");
    expect(screen.getByTestId("saved-total")).toHaveTextContent("NT$ 21,421"); // 6,061 + 15,360
    set("每月對帳與追單時數", "16");
    expect(screen.getByTestId("cost-card")).toHaveTextContent("對帳與追單"); // 16 × 227.27 = 3,636
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 34,958");
    set("平台每月費用(沒有就填 0)", "5880");
    expect(screen.getByText("平台費用")).toBeInTheDocument();
    expect(screen.getByTestId("net")).toHaveTextContent("NT$ 17,359"); // 6,061 + 15,360 + 1,818 − 5,880

    set("每月訂單數", "20");
    expect(screen.getByTestId("net").textContent).toMatch(/^− NT\$/);
    expect(screen.getByTestId("net")).toHaveClass("text-red-600");
    expect(screen.getByTestId("net-yearly").textContent).toContain("− NT$");
  });

  it("亂填也不會爆:空白當 0、超過上限被夾住、滑桿不會超出範圍", () => {
    render(<SupplierSavingsPage />);
    set("每月訂單數", "");
    expect(screen.getByTestId("cost-total")).toHaveTextContent("NT$ 0"); // 預設沒有對帳時數,沒單就沒有成本
    set("每月訂單數", "999999");
    expect((screen.getByLabelText("每月訂單數", { selector: "input[type=number]" }) as HTMLInputElement).value).toBe("20000");
    expect(screen.getByTestId("cost-total").textContent).not.toContain("NaN");
  });

  it("有最近 30 天的實際單量:顯示並可以一鍵帶入;沒有訂單就不顯示", async () => {
    state.orders = Array.from({ length: 120 }, (_, i) => ({ id: `o${i}` }));
    const user = userEvent.setup();
    render(<SupplierSavingsPage />);
    expect(await screen.findByTestId("actual-orders")).toHaveTextContent("最近 30 天你實際收到 120 張單");
    await user.click(screen.getByRole("button", { name: "用這個數字" }));
    expect((screen.getByLabelText("每月訂單數", { selector: "input[type=number]" }) as HTMLInputElement).value).toBe("120");
    const q = state.calls.find((c) => c.table === "supplier_orders");
    expect(q?.filters.map(([c]) => c)).toEqual(["supplier_id", "created_at"]);
  });

  it("讀不到實際單量(沒訂單、連線失敗):不顯示那一行,照樣能自己填", async () => {
    render(<SupplierSavingsPage />);
    await waitFor(() => expect(state.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("actual-orders")).toBeNull();
    cleanup();
    state.fail = true;
    render(<SupplierSavingsPage />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("actual-orders")).toBeNull();
    expect(screen.getByTestId("cost-total")).toBeInTheDocument();
  });
});
