// 供應商「接單設定」:截單時間、提前幾天截單、哪幾天配送;沒啟用 = 沒有限制(刪掉那一列)。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SupplierOrderSettingsDialog from "./SupplierOrderSettingsDialog";

const SUP = "10000000-0000-0000-0000-00000000000a";

const { state, toast } = vi.hoisted(() => ({
  state: {
    row: null as null | Record<string, unknown>,
    writes: [] as { op: string; values?: unknown; opts?: unknown; filters: [string, unknown][] }[],
    writeError: null as string | null,
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const filters: [string, unknown][] = [];
      let write: { op: string; values?: unknown; opts?: unknown } | null = null;
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        upsert: (values: unknown, opts?: unknown) => { write = { op: "upsert", values, opts }; return b; },
        delete: () => { write = { op: "delete" }; return b; },
        then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => {
          if (write) {
            state.writes.push({ ...write, filters: [...filters] });
            return Promise.resolve({ data: null, error: state.writeError ? { message: state.writeError } : null }).then(a, r);
          }
          return Promise.resolve({ data: state.row ? [state.row] : [], error: null }).then(a, r);
        },
      };
      return b;
    },
  },
}));

beforeEach(() => {
  state.row = null;
  state.writes = [];
  state.writeError = null;
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const open = async () => {
  const onOpenChange = vi.fn();
  render(<SupplierOrderSettingsDialog open onOpenChange={onOpenChange} supplierId={SUP} />);
  await screen.findByLabelText("啟用截單與配送日限制");
  return onOpenChange;
};

describe("SupplierOrderSettingsDialog", () => {
  it("還沒設定過:預設沒啟用,說明沒有限制", async () => {
    await open();
    expect(screen.getByLabelText("啟用截單與配送日限制")).not.toBeChecked();
    expect(screen.getByText(/沒有截單限制/)).toBeInTheDocument();
    expect(screen.queryByLabelText("截單時間")).toBeNull();
  });

  it("已經設定過:帶出現有的規則與預覽", async () => {
    state.row = { cutoff_time: "20:30:00", lead_days: 2, delivery_weekdays: [1, 3, 5] };
    await open();
    expect(screen.getByLabelText("啟用截單與配送日限制")).toBeChecked();
    expect(screen.getByLabelText("截單時間")).toHaveValue("20:30");
    expect(screen.getByLabelText("在哪一天截單")).toHaveValue("2");
    expect(screen.getByTestId("rules-preview")).toHaveTextContent("配送日前 2 天 20:30 截單 · 週一、週三、週五配送");
  });

  it("啟用後調整並儲存:upsert 這家供應商的規則", async () => {
    const user = userEvent.setup();
    const onOpenChange = await open();
    await user.click(screen.getByLabelText("啟用截單與配送日限制"));
    fireEvent.change(screen.getByLabelText("截單時間"), { target: { value: "21:00" } });
    await user.selectOptions(screen.getByLabelText("在哪一天截單"), "0");
    await user.click(screen.getByLabelText("週日配送")); // 預設每天,取消週日
    await user.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({
      op: "upsert",
      opts: { onConflict: "supplier_id" },
      values: { supplier_id: SUP, cutoff_time: "21:00", lead_days: 0, delivery_weekdays: [1, 2, 3, 4, 5, 6] },
    });
    expect(toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("取消啟用再儲存 = 刪掉這家供應商的規則(回到沒有限制)", async () => {
    state.row = { cutoff_time: "22:00:00", lead_days: 1, delivery_weekdays: [0, 1, 2, 3, 4, 5, 6] };
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByLabelText("啟用截單與配送日限制"));
    await user.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: "delete", filters: [["supplier_id", SUP]] });
  });

  it("一天都沒選配送:不能儲存", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByLabelText("啟用截單與配送日限制"));
    for (const label of ["日", "一", "二", "三", "四", "五", "六"]) await user.click(screen.getByLabelText(`週${label}配送`));

    expect(screen.getByRole("alert")).toHaveTextContent("至少選一天配送");
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
  });

  it("儲存失敗顯示原因,視窗不關", async () => {
    state.writeError = "row-level security";
    const user = userEvent.setup();
    const onOpenChange = await open();
    await user.click(screen.getByLabelText("啟用截單與配送日限制"));
    await user.click(screen.getByRole("button", { name: "儲存" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("儲存失敗", { description: "row-level security" }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
